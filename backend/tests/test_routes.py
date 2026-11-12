# SPDX-License-Identifier: GPL-2.0-only
"""The route store: the data model the backend does enforce, the active
leg that nothing may infer, and — since #vozswkrl — the fact that SignalK
is the only place any of it is kept.

The load-bearing tests here are still the invariant-#8 ones —
`test_editing_a_route_never_moves_the_active_leg` and
`test_deleting_the_active_waypoint_clears_the_leg_rather_than_guessing`.
Nothing auto-advances a route: `GO` picks the active waypoint outright.
A store that quietly slid the leg to a neighbour when a waypoint moved
would break that invariant from underneath a frontend that honours it.
That survived the move to SignalK on purpose: only persistence went to
SignalK, not mivnav's editing semantics, so the leg still points at a
waypoint *id* and not at SignalK's own `pointIndex`.

Three new claims this file carries after the move:

- **Refusing, not queueing.** A write while the box is unreachable raises
  and changes NOTHING locally (`test_a_write_while_signalk_is_down_...`).
  The alternative — accept it, keep it here, reconcile later — is how work
  goes missing quietly, and was rejected outright.
- **Import.** A route drawn in another app is an ordinary mivnav route
  (`test_a_foreign_route_...`), because it arrives in the same resource
  list.
- **Nothing is written to disk.** There is no `routes.json` to write.

Store semantics run against `MemoryRouteResources` (a dict box — see
conftest); the actual HTTP wire is pinned in test_course.py against a real
loopback server.
"""

from __future__ import annotations

import pytest

from mivnav.features.route.store import (
    DEFAULT_PLAN_SPEED_KN,
    MAX_PLAN_SPEED_KN,
    MAX_ROUTES,
    MAX_WAYPOINTS,
    ActiveLeg,
    RouteConflict,
    RouteError,
    RouteStorageUnavailable,
    RouteStore,
)
from mivnav.features.route.wire import MIVNAV_PROPERTY

from conftest import MemoryRouteResources, memory_route_store

# Oakland inner harbour — the fixture cell's water
HOME = {
    "name": "Home",
    "waypoints": [
        {"id": "w1", "name": "Fairway", "lat": 37.795, "lon": -122.28},
        {"id": "w2", "name": "Turn", "lat": 37.80, "lon": -122.30},
        {"id": "w3", "name": "Berth", "lat": 37.81, "lon": -122.32},
    ],
}


@pytest.fixture
def box() -> MemoryRouteResources:
    return MemoryRouteResources()


@pytest.fixture
def store(box: MemoryRouteResources) -> RouteStore:
    return memory_route_store(box)[0]


def reopened(box: MemoryRouteResources) -> RouteStore:
    """A fresh store against the same box — i.e. the boat's server rebooted.

    It has to `refresh()` to see anything: routes are on SignalK, and this
    process has not looked yet. That IS the restart path (the nav watcher
    does exactly this on subscribe).
    """
    store = memory_route_store(box)[0]
    store.refresh()
    return store


def test_save_get_list_delete(store: RouteStore) -> None:
    assert store.list() == []
    assert store.get("r1") is None

    saved = store.save("r1", HOME)
    assert saved.id == "r1"
    assert saved.name == "Home"
    assert [w.name for w in saved.waypoints] == ["Fairway", "Turn", "Berth"]
    assert saved.rev == 1
    assert saved.updated > 0

    assert store.get("r1").name == "Home"
    assert [r.id for r in store.list()] == ["r1"]

    assert store.delete("r1") is True
    assert store.delete("r1") is False  # idempotent, reports the truth
    assert store.list() == []


def test_routes_round_trip_through_signalk(store: RouteStore, box) -> None:
    store.save("r1", HOME)
    store.save("r2", {"name": "Skagerrak", "waypoints": []})

    after_restart = reopened(box)
    assert {r.id for r in after_restart.list()} == {"r1", "r2"}
    assert [w.id for w in after_restart.get("r1").waypoints] == ["w1", "w2", "w3"]
    assert [w.name for w in after_restart.get("r1").waypoints] == ["Fairway", "Turn", "Berth"]
    assert after_restart.get("r1").rev == 1


def test_the_active_leg_is_memory_only_and_signalk_restores_it(store: RouteStore, box) -> None:
    """The one thing that does NOT round-trip through the resource store.

    The leg is published as SignalK's own `activeRoute` instead (see
    publish.py), and read back by the watcher's course adoption — so a fresh
    store legitimately starts with nothing followed rather than inventing
    one, which is invariant #8 again: nothing may INFER the active leg.
    """
    store.save("r1", HOME)
    store.set_active(ActiveLeg(route_id="r1", waypoint_id="w2"))
    assert store.active() == ActiveLeg(route_id="r1", waypoint_id="w2")

    assert reopened(box).active() is None
    # ...and nothing about the leg leaked into the stored resource, which
    # would be a second, disagreeing copy of who is following what.
    stored = box.resources["r1"]["feature"]["properties"][MIVNAV_PROPERTY]
    assert set(stored) == {"version", "waypoints", "plan_speed_kn", "rev", "updated"}


def test_waypoint_order_is_preserved_exactly(store: RouteStore, box) -> None:
    """A route is an *ordered* list; the store must not sort or dedupe it.
    Two waypoints may sit on the same position (a mark rounded twice)."""
    route = store.save(
        "r1",
        {
            "name": "Triangle",
            "waypoints": [
                {"id": "c", "lat": 1.0, "lon": 1.0},
                {"id": "a", "lat": 2.0, "lon": 2.0},
                {"id": "b", "lat": 1.0, "lon": 1.0},
            ],
        },
    )
    assert [w.id for w in route.waypoints] == ["c", "a", "b"]
    assert [w.id for w in reopened(box).get("r1").waypoints] == ["c", "a", "b"]


def test_saving_an_existing_id_replaces_it_and_bumps_the_rev(store: RouteStore) -> None:
    assert store.save("r1", HOME).rev == 1
    second = store.save("r1", {"name": "Home (revised)", "waypoints": []})
    assert second.rev == 2
    assert second.name == "Home (revised)"
    assert len(store.list()) == 1


# -- the model is not opaque (the contrast with profiles) ------------------


def test_positions_are_validated(store: RouteStore) -> None:
    """Unlike a profile's blob, a waypoint is stable data the server can
    meaningfully check — and the cost of not checking is a course drawn to
    a position that does not exist."""
    for bad in (
        {"id": "w1", "lat": 91.0, "lon": 0.0},
        {"id": "w1", "lat": -90.1, "lon": 0.0},
        {"id": "w1", "lat": 0.0, "lon": 180.5},
        {"id": "w1", "lat": 0.0, "lon": -181.0},
        {"id": "w1", "lat": "north", "lon": 0.0},
        {"id": "w1", "lon": 0.0},  # no latitude at all
    ):
        with pytest.raises(RouteError):
            store.save("r1", {"name": "X", "waypoints": [bad]})
    # the poles and the antimeridian are real places
    store.save("r1", {"waypoints": [{"id": "w1", "lat": 90.0, "lon": 180.0}]})
    store.save("r2", {"waypoints": [{"id": "w1", "lat": -90.0, "lon": -180.0}]})


def test_unknown_fields_are_refused(store: RouteStore) -> None:
    """Deliberately unlike ProfileStore: this model is the contract with
    the editor, so a typo'd key is a bug to report, not a blob to keep."""
    with pytest.raises(RouteError):
        store.save("r1", {"name": "X", "waypoints": [], "colour": "red"})
    with pytest.raises(RouteError):
        store.save("r1", {"waypoints": [{"id": "w1", "lat": 0.0, "lon": 0.0, "eta": 5}]})


def test_a_route_must_be_an_object(store: RouteStore) -> None:
    for bad in ("a string", 42, ["a", "list"], None):
        with pytest.raises(RouteError):
            store.save("r1", bad)


def test_ids_are_url_safe_bounded_tokens(store: RouteStore) -> None:
    store.save("0b7f1e2c-ok_id", HOME)
    # A SignalK resource may be addressed by a URN, and mivnav has to be able
    # to read (and therefore re-save) one — `:` is an ordinary path character.
    store.save("urn:mrn:signalk:uuid:0b7f1e2c", HOME)
    for bad in ("", "   ", "x" * 65, "a/b", "../../etc/passwd", "back\\slash", "a b", "wp!"):
        with pytest.raises(RouteError):
            store.save(bad, HOME)


def test_a_route_id_never_needs_quoting_in_a_url(store: RouteStore, box) -> None:
    """The id goes into a path segment on THIS API and on SignalK's, both
    times unquoted. `.` stays refused specifically so `..` can never be one
    of those segments."""
    from urllib.parse import quote

    for bad in ("a.b", "..", "."):
        with pytest.raises(RouteError):
            store.save(bad, HOME)
    store.save("urn:mrn:signalk:uuid:x", HOME)
    for route_id in box.resources:
        assert quote(route_id, safe=":-_") == route_id


def test_the_id_active_is_reserved_because_the_api_owns_that_url(store: RouteStore) -> None:
    # PUT /routes/active sets the active leg, so a route with that id
    # would be shadowed by it — refuse the id rather than ship an API with
    # a word it cannot round-trip
    with pytest.raises(RouteError):
        store.save("active", HOME)


def test_the_body_id_may_round_trip_but_may_not_contradict_the_path(store: RouteStore) -> None:
    store.save("r1", {**HOME, "id": "r1"})  # a fetched route, sent straight back
    with pytest.raises(RouteError):
        store.save("r1", {**HOME, "id": "r2"})


def test_server_owned_fields_in_the_body_are_ignored(store: RouteStore) -> None:
    """A client that GETs a route and PUTs it back sends rev/updated too.
    They are the server's; taking them from a body would let a client
    forge its way past the concurrency check."""
    store.save("r1", HOME)
    saved = store.save("r1", {**HOME, "rev": 99, "updated": 1.0})
    assert saved.rev == 2  # not 99
    assert saved.updated > 1.0


def test_waypoint_ids_must_be_unique_within_a_route(store: RouteStore) -> None:
    # the active leg addresses a waypoint by id; duplicates would make
    # "which waypoint" unanswerable
    with pytest.raises(RouteError):
        store.save(
            "r1",
            {
                "waypoints": [
                    {"id": "w1", "lat": 1.0, "lon": 1.0},
                    {"id": "w1", "lat": 2.0, "lon": 2.0},
                ]
            },
        )


def test_counts_are_capped(store: RouteStore) -> None:
    for i in range(MAX_ROUTES):
        store.save(f"r{i}", {"name": f"r{i}", "waypoints": []})
    with pytest.raises(RouteError):
        store.save("one-too-many", HOME)
    store.save("r0", {"name": "replacing an existing one is still fine"})

    with pytest.raises(RouteError):
        store.save(
            "r0",
            {
                "waypoints": [
                    {"id": f"w{i}", "lat": 1.0, "lon": 1.0} for i in range(MAX_WAYPOINTS + 1)
                ]
            },
        )


# -- the per-route planning speed -----------------------------------------


def test_plan_speed_defaults_and_round_trips(store: RouteStore, box) -> None:
    # A route drawn without a planning speed gets the default...
    assert store.save("r1", HOME).plan_speed_kn == DEFAULT_PLAN_SPEED_KN
    # ...and one drawn WITH a speed keeps it, across a restart. SignalK's own
    # route schema has no slot for it — it survives in feature.properties.
    saved = store.save("r2", {**HOME, "plan_speed_kn": 6.5})
    assert saved.plan_speed_kn == 6.5
    assert reopened(box).get("r2").plan_speed_kn == 6.5


def test_plan_speed_must_be_positive_and_bounded(store: RouteStore) -> None:
    for bad in (0.0, -1.0, MAX_PLAN_SPEED_KN + 1, "fast"):
        with pytest.raises(RouteError):
            store.save("r1", {**HOME, "plan_speed_kn": bad})
    # the bound itself is a real, if brisk, planning speed
    assert store.save("r1", {**HOME, "plan_speed_kn": MAX_PLAN_SPEED_KN}).plan_speed_kn == (
        MAX_PLAN_SPEED_KN
    )


def test_depart_at_defaults_to_none_and_round_trips_as_utc(store: RouteStore, box) -> None:
    assert store.save("r1", HOME).depart_at is None
    # Not written at all when unset — an older reader sees nothing new.
    assert "depart_at" not in box.resources["r1"]["feature"]["properties"][MIVNAV_PROPERTY]

    # Any offset is accepted and stored as the same instant in UTC.
    saved = store.save("r2", {**HOME, "depart_at": "2026-11-06T10:30:00+01:00"})
    assert saved.depart_at == "2026-11-06T09:30:00Z"
    assert box.resources["r2"]["feature"]["properties"][MIVNAV_PROPERTY]["depart_at"] == (
        "2026-11-06T09:30:00Z"
    )
    assert reopened(box).get("r2").depart_at == "2026-11-06T09:30:00Z"

    # Clearing it (null) clears it.
    assert store.save("r2", {**HOME, "depart_at": None}).depart_at is None
    assert reopened(box).get("r2").depart_at is None


def test_depart_at_must_be_an_instant(store: RouteStore) -> None:
    for bad in ("tomorrow", "2026-11-06T09:30:00", 1762421400, ""):
        with pytest.raises(RouteError):
            store.save("r1", {**HOME, "depart_at": bad})


def test_an_unreadable_stored_depart_at_reads_as_none(store: RouteStore, box) -> None:
    store.save("r1", {**HOME, "depart_at": "2026-11-06T09:30:00Z"})
    box.resources["r1"]["feature"]["properties"][MIVNAV_PROPERTY]["depart_at"] = "soon"
    fresh = reopened(box).get("r1")
    assert fresh is not None
    assert fresh.depart_at is None
    assert [w.id for w in fresh.waypoints] == ["w1", "w2", "w3"]


# -- the active leg: invariant #8 -----------------------------------------


def test_go_selects_a_waypoint_outright(store: RouteStore) -> None:
    store.save("r1", HOME)
    assert store.active() is None  # nothing is followed until a human says so

    # the *last* waypoint, with the boat nowhere near it: "nearest" and
    # "next un-passed" would both pick something else. The store must not
    # have an opinion at all.
    assert store.set_active(ActiveLeg(route_id="r1", waypoint_id="w3")) == ActiveLeg(
        route_id="r1", waypoint_id="w3"
    )
    assert store.active().waypoint_id == "w3"

    assert store.set_active(None) is None  # and GO can be let go of


def test_an_active_leg_must_address_something_real(store: RouteStore) -> None:
    store.save("r1", HOME)
    with pytest.raises(RouteError):
        store.set_active(ActiveLeg(route_id="nope", waypoint_id="w1"))
    with pytest.raises(RouteError):
        store.set_active(ActiveLeg(route_id="r1", waypoint_id="nope"))
    assert store.active() is None


def test_editing_a_route_never_moves_the_active_leg(store: RouteStore) -> None:
    """Invariant #8, at the point it is most tempting to break.

    The leg points at a waypoint *id*, not an index, so reordering the
    route leaves the boat pointed at the same physical waypoint. Had this
    been an index, inserting a waypoint at the head would silently
    redirect the boat at whatever now occupied slot two — a plotter
    guessing the leg is exactly what makes people distrust it.

    This is also why mivnav did NOT adopt SignalK's own `{href, pointIndex}`
    model when its routes moved there (#vozswkrl): an index is what SignalK
    activates, and an id is what mivnav edits against.
    """
    store.save("r1", HOME)
    store.set_active(ActiveLeg(route_id="r1", waypoint_id="w2"))

    reordered = list(reversed(HOME["waypoints"]))
    store.save("r1", {"name": "Home", "waypoints": reordered})
    assert store.active() == ActiveLeg(route_id="r1", waypoint_id="w2")

    # and an insertion at the head, which an index would also have broken
    store.save(
        "r1",
        {"name": "Home", "waypoints": [{"id": "w0", "lat": 37.7, "lon": -122.2}, *reordered]},
    )
    assert store.active() == ActiveLeg(route_id="r1", waypoint_id="w2")

    # renaming and moving the waypoint itself: still the same waypoint
    moved = [
        {**w, "name": "Renamed", "lat": 1.0} if w["id"] == "w2" else w
        for w in HOME["waypoints"]
    ]
    store.save("r1", {"name": "Home", "waypoints": moved})
    assert store.active() == ActiveLeg(route_id="r1", waypoint_id="w2")


def test_deleting_the_active_waypoint_clears_the_leg_rather_than_guessing(
    store: RouteStore,
) -> None:
    """Invariant #8 again: with the chosen waypoint gone, the server has
    no basis to choose another, and sliding to a neighbour is precisely
    the guess the invariant forbids. So: nothing is being followed, and
    the UI must say so."""
    store.save("r1", HOME)
    store.set_active(ActiveLeg(route_id="r1", waypoint_id="w2"))

    store.save("r1", {"name": "Home", "waypoints": [HOME["waypoints"][0]]})
    assert store.active() is None


def test_deleting_the_active_route_clears_the_leg(store: RouteStore) -> None:
    # following a route that does not exist is not a state the boat can be in
    store.save("r1", HOME)
    store.save("r2", HOME)
    store.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))

    store.delete("r2")
    assert store.active() is not None  # an unrelated route is unrelated
    store.delete("r1")
    assert store.active() is None


def test_a_refresh_that_loses_the_active_waypoint_clears_the_leg(
    store: RouteStore, box
) -> None:
    """The same rule, now reachable from a direction it was not before:
    another app can edit the route mivnav is following. When the refresh
    brings back a route without the chosen waypoint, the leg goes — it is
    not slid to a neighbour."""
    store.save("r1", HOME)
    store.set_active(ActiveLeg(route_id="r1", waypoint_id="w2"))

    # Freeboard shortens the route to its first mark.
    shortened = dict(box.resources["r1"])
    shortened["feature"] = dict(shortened["feature"])
    shortened["feature"]["geometry"] = {"type": "LineString", "coordinates": [[-122.28, 37.795]]}
    box.resources["r1"] = shortened

    store.refresh()
    assert store.active() is None


def test_snapshot_is_consistent(store: RouteStore) -> None:
    store.save("r1", HOME)
    store.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    routes, active = store.snapshot()
    assert [r.id for r in routes] == ["r1"]
    assert active.route_id == "r1"


# -- concurrency ----------------------------------------------------------


def test_if_match_refuses_to_clobber_a_concurrent_edit(store: RouteStore) -> None:
    """Two devices, one route, both editing. The phone's five minutes of
    work must not vanish without an error because the nav station saved
    last."""
    phone_saw = store.save("r1", HOME)  # rev 1, both devices fetched this

    store.save("r1", {"name": "nav station's edit"}, if_match=phone_saw.rev)  # rev 2

    with pytest.raises(RouteConflict):
        store.save("r1", {"name": "the phone's stale edit"}, if_match=phone_saw.rev)
    assert store.get("r1").name == "nav station's edit"

    # re-read and re-apply, and it goes through
    store.save("r1", {"name": "the phone, reconciled"}, if_match=store.get("r1").rev)
    assert store.get("r1").name == "the phone, reconciled"


def test_the_rev_survives_the_trip_to_signalk(store: RouteStore, box) -> None:
    """`rev` is the whole optimistic-lock, and SignalK's route schema has
    nowhere to put it — so if the properties round trip were broken, every
    restart would silently reset the lock to 0 and the FIRST guarded save
    after it would be refused with a 409 nobody could explain."""
    store.save("r1", HOME)
    store.save("r1", {"name": "again"})
    fresh = reopened(box)
    assert fresh.get("r1").rev == 2
    fresh.save("r1", {"name": "third"}, if_match=2)


def test_the_stop_flags_survive_the_trip_to_signalk(store: RouteStore, box) -> None:
    """`Waypoint.stop` tags which points the mariner chose (From/stops/To)
    vs. the router's bends; the editor rebuilds its From/Stop/To list from it
    on reopen. SignalK's schema has nowhere for it, so it rides in the
    mivnav properties like `rev` — a broken round trip would turn every
    reopened route into one long From→To with no stops, silently."""
    route = {
        "name": "Mixed",
        "waypoints": [
            {**HOME["waypoints"][0], "stop": True},
            HOME["waypoints"][1],
            {**HOME["waypoints"][2], "stop": True},
        ],
    }
    store.save("r1", route)
    fresh = reopened(box)
    assert [w.stop for w in fresh.get("r1").waypoints] == [True, False, True]


def test_a_route_saved_before_the_stop_key_existed_reads_as_no_stops(
    store: RouteStore, box
) -> None:
    store.save("r1", HOME)
    for entry in box.resources["r1"]["feature"]["properties"][MIVNAV_PROPERTY]["waypoints"]:
        del entry["stop"]
    fresh = reopened(box)
    assert [w.stop for w in fresh.get("r1").waypoints] == [False, False, False]
    assert [w.id for w in fresh.get("r1").waypoints] == ["w1", "w2", "w3"]


def test_the_approximate_flags_survive_the_trip_to_signalk(store: RouteStore, box) -> None:
    """`Waypoint.approximate` marks a leg the planner could only guess at
    ("verify manually"). Dropping it on the way to SignalK made every
    reopened route render that guess as a trusted leg."""
    route = {
        "name": "Guessed",
        "waypoints": [
            HOME["waypoints"][0],
            {**HOME["waypoints"][1], "approximate": True},
            HOME["waypoints"][2],
        ],
    }
    store.save("r1", route)
    stored = box.resources["r1"]["feature"]["properties"][MIVNAV_PROPERTY]["waypoints"]
    assert [e.get("approximate") for e in stored] == [None, True, None]
    fresh = reopened(box)
    assert [w.approximate for w in fresh.get("r1").waypoints] == [False, True, False]


def test_a_route_saved_before_the_approximate_key_existed_reads_as_exact(
    store: RouteStore, box
) -> None:
    store.save("r1", HOME)
    for entry in box.resources["r1"]["feature"]["properties"][MIVNAV_PROPERTY]["waypoints"]:
        assert "approximate" not in entry
    fresh = reopened(box)
    assert [w.approximate for w in fresh.get("r1").waypoints] == [False, False, False]
    assert [w.id for w in fresh.get("r1").waypoints] == ["w1", "w2", "w3"]


def test_if_match_is_opt_in_and_last_write_wins_without_it(store: RouteStore) -> None:
    # a caller who means "overwrite whatever is there" says so by omission
    store.save("r1", HOME)
    store.save("r1", {"name": "later"})
    assert store.get("r1").name == "later"


def test_if_match_on_a_create_and_on_a_delete(store: RouteStore) -> None:
    # "I believe this route does not exist yet" — but it does
    store.save("r1", HOME)
    with pytest.raises(RouteConflict):
        store.save("r1", HOME, if_match=0)

    with pytest.raises(RouteConflict):
        store.delete("r1", if_match=99)
    assert store.delete("r1", if_match=store.get("r1").rev) is True


def test_pressing_go_is_last_write_wins_by_design(store: RouteStore) -> None:
    """No token, deliberately: GO is one deliberate act by whoever is at
    the helm, not an edit session that can be lost, and the person who
    pressed it most recently is the one who means it. A 409 here would be
    an obstacle at exactly the wrong moment."""
    store.save("r1", HOME)
    store.set_active(ActiveLeg(route_id="r1", waypoint_id="w1"))
    store.set_active(ActiveLeg(route_id="r1", waypoint_id="w3"))
    assert store.active().waypoint_id == "w3"


# -- SignalK is the only store (#vozswkrl) --------------------------------


def test_a_write_while_signalk_is_down_is_refused_and_changes_nothing(
    store: RouteStore, box
) -> None:
    """The offline policy, decided outright: refuse the edit and surface the
    error. No write-through cache, no queue, no reconcile-on-reconnect — the
    failure modes of those are silent, and this one is not."""
    store.save("r1", HOME)
    box.down = True

    with pytest.raises(RouteStorageUnavailable):
        store.save("r1", {"name": "an edit nobody will see"})
    with pytest.raises(RouteStorageUnavailable):
        store.save("r2", HOME)
    with pytest.raises(RouteStorageUnavailable):
        store.delete("r1")

    # Nothing local moved: the mirror still holds exactly what the box has.
    assert store.get("r1").name == "Home"
    assert store.get("r1").rev == 1
    assert store.get("r2") is None


def test_the_boat_keeps_navigating_from_memory_while_signalk_is_down(
    store: RouteStore, box
) -> None:
    """The other half of refusing: the route being FOLLOWED is in memory, so
    a box that goes away mid-passage costs you editing, never the plot."""
    store.save("r1", HOME)
    store.set_active(ActiveLeg(route_id="r1", waypoint_id="w2"))
    box.down = True

    with pytest.raises(RouteStorageUnavailable):
        store.refresh()
    assert store.active() == ActiveLeg(route_id="r1", waypoint_id="w2")
    assert [w.id for w in store.get("r1").waypoints] == ["w1", "w2", "w3"]


def test_no_signalk_configured_at_all_is_the_same_refusal() -> None:
    # `enabled: false` means there is nowhere to put a route, full stop.
    store = RouteStore()
    with pytest.raises(RouteStorageUnavailable):
        store.save("r1", HOME)
    with pytest.raises(RouteStorageUnavailable):
        store.refresh()
    assert store.list() == []


def test_a_foreign_route_is_an_ordinary_mivnav_route(store: RouteStore, box) -> None:
    """Import, which is the point of the move as much as export is: a route
    drawn in Freeboard or AvNav has no mivnav properties at all — just a
    name and a LineString — and must still show up, be followable, and be
    editable."""
    box.resources["freeboard-route"] = {
        "name": "Drawn in Freeboard",
        "feature": {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [[-122.28, 37.795], [-122.30, 37.80]],
            },
            "properties": {},
        },
    }
    store.refresh()

    imported = store.get("freeboard-route")
    assert imported.name == "Drawn in Freeboard"
    assert [(w.lat, w.lon) for w in imported.waypoints] == [(37.795, -122.28), (37.80, -122.30)]
    # Ids are synthesised positionally, so they are stable across refreshes —
    # which is what lets an active leg on an imported route survive a re-read.
    assert [w.id for w in imported.waypoints] == ["p0", "p1"]
    store.set_active(ActiveLeg(route_id="freeboard-route", waypoint_id="p1"))
    store.refresh()
    assert store.active() == ActiveLeg(route_id="freeboard-route", waypoint_id="p1")
    assert imported.plan_speed_kn == DEFAULT_PLAN_SPEED_KN


def test_one_unreadable_resource_costs_one_route(store: RouteStore, box) -> None:
    """The list is half other apps' work; a single entry this app cannot
    make sense of must not take the rest of the routes with it."""
    store.save("good", HOME)
    box.resources["a-waypoint-not-a-route"] = {
        "name": "not a route",
        "feature": {"type": "Feature", "geometry": {"type": "Point", "coordinates": [1.0, 2.0]}},
    }
    box.resources["nonsense"] = "not even an object"
    store.refresh()
    assert [r.id for r in store.list()] == ["good"]


def test_a_failed_refresh_leaves_the_previous_mirror_standing(store: RouteStore, box) -> None:
    store.save("r1", HOME)
    box.down = True
    with pytest.raises(RouteStorageUnavailable):
        store.refresh()
    assert [r.id for r in store.list()] == ["r1"]


def test_the_store_has_no_file_to_write(store: RouteStore) -> None:
    """There is no routes.json any more, and nothing replaced it — not even
    a path to one. Pinned because a "just cache it locally too" would start
    exactly here, and that is the write-through cache the offline policy
    ruled out."""
    assert not hasattr(store, "path")
