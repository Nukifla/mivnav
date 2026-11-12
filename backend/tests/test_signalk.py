# SPDX-License-Identifier: GPL-2.0-only
"""The server-side SignalK connection: the rules, the socket, the fan-out.

The claims worth proving are all about *lifetime*, so most of these drive
a real client against a real (fake) SignalK server over loopback and count
upstream sessions:

- one upstream connection serves N devices, and outlives all of them;
- ``enabled: false`` is a state, not an error;
- an unreachable SignalK box cannot touch the chart path;
- editing the host takes effect with no restart, and reaches a client that
  was already connected — the Derived invalidation, which is the thing
  that fails silently if it fails at all.
"""

from __future__ import annotations

import json
import math
import queue
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mivnav.autopilot import model as autopilot_model  # the second delta consumer
from mivnav.signalk import STALE_AFTER, SignalKService, VesselTracker
from mivnav.signalk import anchor as anchor_model  # the fifth delta consumer
from mivnav.shallow import notices as shallow_notices  # our shallow alarm's echo
from mivnav.signalk import mob as mob_model  # notifications.mob's echo
from mivnav.signalk import model  # for the bucket ladder, which is an internal
from tests.conftest import isolated_runtime_at
from tests.fake_signalk import SELF_ID, FakeSignalK
from tests.test_tiles import center_tile

# -- helpers ---------------------------------------------------------------


def receive_json(ws: Any, timeout: float = 10.0) -> Any:
    """``ws.receive_json()``, but a message that never comes fails the test
    rather than hanging the suite forever (Starlette's is unbounded)."""
    out: queue.Queue = queue.Queue(maxsize=1)

    def pump() -> None:
        try:
            out.put(("ok", ws.receive_json()))
        except BaseException as e:  # noqa: BLE001
            out.put(("err", e))

    threading.Thread(target=pump, daemon=True).start()
    try:
        kind, value = out.get(timeout=timeout)
    except queue.Empty:
        raise AssertionError(f"no snapshot within {timeout}s") from None
    if kind == "err":
        raise value
    return value


def wait_for(ws: Any, predicate: Any, timeout: float = 10.0) -> Any:
    """The first snapshot satisfying ``predicate``."""
    deadline = time.monotonic() + timeout
    last = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(f"condition never held; last snapshot: {last}")
        last = receive_json(ws, timeout=remaining)
        if predicate(last):
            return last


def wait_until(predicate: Any, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition never held")


@pytest.fixture
def upstream() -> Any:
    server = FakeSignalK().start()
    yield server
    server.stop()


@pytest.fixture
def app_client(tmp_path: Path, isolated_runtime, charts_dir: Path) -> Any:
    """``(client, runtime)`` on a Runtime this test alone owns.

    Its own, because these tests edit the config and rebuild the
    connection; the session-wide runtime is shared. Charts come from the
    real ingested fixture set so that "the chart path stays up" is a claim
    about charts and not about an empty directory.

    The session `client` fixture's get_store/get_service overrides are
    lifted for the duration: they would shadow this runtime, and the point
    is to exercise it.
    """
    import shutil

    from mivnav.api.app import app
    from mivnav.api.charts import get_store
    from mivnav.api.deps import get_runtime
    from mivnav.features.ocharts.routes import get_service

    runtime = isolated_runtime_at(tmp_path)
    # M-DATA-3: no more `charts.dir` — the chart-set directory is
    # `data_root/charts`. `charts_dir` (the session fixture) is a flat dir of
    # `<id>.pmtiles` files, not itself named `charts`, so copy its one
    # archive into a fresh `data_root/charts/` instead of pointing at it
    # directly.
    data_root = tmp_path / "signalk-data"
    charts_subdir = data_root / "charts"
    charts_subdir.mkdir(parents=True)
    for f in charts_dir.glob("*.pmtiles"):
        shutil.copy(f, charts_subdir / f.name)
    runtime.patch_config({"data_root": str(data_root)})

    saved = dict(app.dependency_overrides)
    app.dependency_overrides.pop(get_store, None)
    app.dependency_overrides.pop(get_service, None)
    app.dependency_overrides[get_runtime] = lambda: runtime
    try:
        with TestClient(app) as client:
            yield client, runtime
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)
        runtime.close()


def enable(runtime: Any, upstream: FakeSignalK) -> None:
    runtime.patch_config({"signalk": {"enabled": True, "host": "127.0.0.1", "port": upstream.port}})


# -- the rules, with no socket in sight ------------------------------------


def test_hello_then_delta_gives_the_own_ship() -> None:
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    tracker.apply(
        '{"context": "vessels.%s", "updates": [{"values": ['
        '{"path": "navigation.position", "value": {"latitude": 55.9, "longitude": 12.6}},'
        '{"path": "navigation.headingTrue", "value": 3.141592653589793}]}]}' % SELF_ID,
        now=100.0,
    )
    snapshot = tracker.snapshot(now=100.0, ttl=600.0)
    assert snapshot["self"] == {
        "id": SELF_ID,
        "lng": 12.6,
        "lat": 55.9,
        "headingDeg": pytest.approx(180.0),
    }
    assert snapshot["targets"] == []


def test_other_vessels_are_targets_and_unpositioned_ones_are_not_drawn() -> None:
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    tracker.apply(
        '{"context": "vessels.other", "updates": [{"values": ['
        '{"path": "navigation.position", "value": {"latitude": 1.0, "longitude": 2.0}},'
        '{"path": "", "value": {"name": "Kraka", "mmsi": "219"}}]}]}',
        now=100.0,
    )
    # heard of, but never located: nothing to draw
    tracker.apply(
        '{"context": "vessels.nameonly", "updates": [{"values": [{"path": "name", "value": "Mist"}]}]}',
        now=100.0,
    )
    snapshot = tracker.snapshot(now=100.0, ttl=600.0)
    assert snapshot["self"] is None  # own ship has no fix yet
    assert snapshot["targets"] == [{"id": "other", "lng": 2.0, "lat": 1.0, "name": "Kraka", "mmsi": "219"}]


def test_snapshot_hides_stale_targets_without_mutating() -> None:
    """The bug this port fixes: the browser's `targets()` deleted stale
    entries *from inside a read*. Reads are pure here, and expiry is the
    publisher's separate, explicit business."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=0.0)
    tracker.apply(
        '{"context": "vessels.ghost", "updates": [{"values": ['
        '{"path": "navigation.position", "value": {"latitude": 1.0, "longitude": 2.0}}]}]}',
        now=0.0,
    )
    assert tracker.snapshot(now=0.0, ttl=600.0)["targets"] != []

    # Past the ttl: hidden, repeatably, and still held.
    assert tracker.snapshot(now=1000.0, ttl=600.0)["targets"] == []
    assert tracker.snapshot(now=1000.0, ttl=600.0)["targets"] == []
    assert tracker.snapshot(now=0.0, ttl=600.0)["targets"] != []

    tracker.expire(now=1000.0, ttl=600.0)
    assert tracker.snapshot(now=0.0, ttl=600.0)["targets"] == []


def test_the_own_ship_never_expires() -> None:
    """A GPS gone quiet has not sailed away; blanking the boat off its own
    chart is the worst available answer."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=0.0)
    tracker.apply(
        '{"context": "vessels.%s", "updates": [{"values": ['
        '{"path": "navigation.position", "value": {"latitude": 1.0, "longitude": 2.0}}]}]}' % SELF_ID,
        now=0.0,
    )
    tracker.expire(now=1e6, ttl=600.0)
    assert tracker.snapshot(now=1e6, ttl=600.0)["self"] == {"id": SELF_ID, "lng": 2.0, "lat": 1.0}


# -- the active course, read back from what SignalK reports ----------------
#
# The read side of `mivnav.features.route.client`'s v2 Course API writes: the
# yellow steering cue must trust this, not mivnav's own local active-leg
# state, so these pin the fold that makes the wire mirror trustworthy.


def test_course_is_none_until_any_course_path_arrives() -> None:
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=0.0)
    assert tracker.snapshot(now=0.0, ttl=600.0)["course"] is None


def test_the_v2_course_paths_fold_into_next_and_previous() -> None:
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=0.0)
    tracker.apply(
        '{"context": "vessels.%s", "updates": [{"values": ['
        '{"path": "navigation.course.nextPoint.position", '
        '"value": {"latitude": 56.0, "longitude": 12.7}},'
        '{"path": "navigation.course.previousPoint.position", '
        '"value": {"latitude": 55.9, "longitude": 12.6}}]}]}' % SELF_ID,
        now=0.0,
    )
    assert tracker.snapshot(now=0.0, ttl=600.0)["course"] == {
        "nextLat": 56.0,
        "nextLng": 12.7,
        "prevLat": 55.9,
        "prevLng": 12.6,
    }


def test_the_legacy_great_circle_paths_map_onto_the_same_fields() -> None:
    """Some servers mirror the course to the older `courseGreatCircle`
    subtree instead of (or as well as) the v2 API's own paths — asked for
    defensively (unverified on the real boat; see the service module's
    subscription comment)."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=0.0)
    tracker.apply(
        '{"context": "vessels.%s", "updates": [{"values": ['
        '{"path": "navigation.courseGreatCircle.nextPoint.position", '
        '"value": {"latitude": 1.0, "longitude": 2.0}}]}]}' % SELF_ID,
        now=0.0,
    )
    assert tracker.snapshot(now=0.0, ttl=600.0)["course"] == {"nextLat": 1.0, "nextLng": 2.0}


def test_a_bare_next_point_goes_out_without_waiting_for_the_previous_one() -> None:
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=0.0)
    tracker.apply(
        '{"context": "vessels.%s", "updates": [{"values": ['
        '{"path": "navigation.course.nextPoint.position", '
        '"value": {"latitude": 56.0, "longitude": 12.7}}]}]}' % SELF_ID,
        now=0.0,
    )
    assert tracker.snapshot(now=0.0, ttl=600.0)["course"] == {"nextLat": 56.0, "nextLng": 12.7}


def test_half_a_course_point_is_not_a_point() -> None:
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=0.0)
    tracker.apply(
        '{"context": "vessels.%s", "updates": [{"values": ['
        '{"path": "navigation.course.nextPoint.position", "value": {"latitude": 56.0}}]}]}' % SELF_ID,
        now=0.0,
    )
    assert tracker.snapshot(now=0.0, ttl=600.0)["course"] is None


def test_another_vessels_course_is_not_ours() -> None:
    """Own-ship only, like the autopilot: a course belongs to the vessel
    steering it, and a neighbour's AIS report never carries one anyway — but
    if a box somehow emitted it under another context, it must not be
    mistaken for ours."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=0.0)
    tracker.apply(
        '{"context": "vessels.other", "updates": [{"values": ['
        '{"path": "navigation.course.nextPoint.position", '
        '"value": {"latitude": 1.0, "longitude": 2.0}}]}]}',
        now=0.0,
    )
    assert tracker.snapshot(now=0.0, ttl=600.0)["course"] is None


def test_a_course_nested_under_its_root_path_is_walked_like_the_autopilot_is() -> None:
    """`{"path": ""}` (or a `navigation.course` leaf) can deliver the whole
    course subtree as one object rather than two leaf deltas — the same
    dialect split `_apply_value`/`AutopilotState` already handle."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=0.0)
    tracker.apply(
        '{"context": "vessels.%s", "updates": [{"values": ['
        '{"path": "navigation.course", "value": '
        '{"nextPoint": {"position": {"latitude": 3.0, "longitude": 4.0}}}}]}]}' % SELF_ID,
        now=0.0,
    )
    assert tracker.snapshot(now=0.0, ttl=600.0)["course"] == {"nextLat": 3.0, "nextLng": 4.0}


# -- what we know about a vessel -------------------------------------------
#
# The contract is `frontend/src/info/vessel.ts`: every field optional,
# units in the names, absence meaningful. These are the backend half of it.

#: A Class A ship as n2k-signalk renders one: static data as a root
#: object, `design.*` as nested objects, draft under `maximum`.
CARGO = "urn:mrn:imo:mmsi:265123456"
CARGO_DELTA = [
    ("navigation.position", {"latitude": 55.9, "longitude": 12.6}),
    ("navigation.headingTrue", math.pi / 2),  # 90°
    ("navigation.courseOverGroundTrue", math.pi / 4),  # 45°
    ("navigation.speedOverGround", 6.17),
    ("navigation.speedThroughWater", 6.0),
    ("navigation.rateOfTurn", 10.0 * math.pi / 180.0 / 60.0),  # 10°/min to starboard
    ("navigation.datetime", "2026-07-17T11:22:33Z"),
    ("navigation.state", "motoring"),
    ("navigation.destination", {"commonName": "COPENHAGEN", "eta": "2026-07-18T06:00:00Z"}),
    ("navigation.specialManeuver", "not engaged"),
    ("design.aisShipType", {"id": 70, "name": "Cargo"}),
    ("design.length", {"overall": 199.0}),
    ("design.beam", 32.0),
    ("design.airHeight", 45.0),
    ("design.draft", {"maximum": 11.4}),
    ("sensors.ais.class", "A"),
    ("registrations.imo", "IMO 9074729"),
    ("communication.callsignVhf", "OZAB2"),
    ("", {"name": "NORDIC STAR", "mmsi": "265123456", "flag": "SE", "port": "Stockholm"}),
]

CARGO_WIRE = {
    "id": CARGO,
    "lng": 12.6,
    "lat": 55.9,
    "headingDeg": pytest.approx(90.0),
    "cogDeg": pytest.approx(45.0),
    "sogMs": 6.17,
    "stwMs": 6.0,
    "rotDegPerMin": pytest.approx(10.0),
    "positionAtIso": "2026-07-17T11:22:33Z",
    "name": "NORDIC STAR",
    "mmsi": "265123456",
    "callsign": "OZAB2",
    "imo": "IMO 9074729",
    "flag": "SE",
    "port": "Stockholm",
    "aisClass": "A",
    "shipType": "Cargo",
    "shipTypeId": 70,
    "lengthM": 199.0,
    "beamM": 32.0,
    "airHeightM": 45.0,
    "draftM": 11.4,
    "navStatus": "motoring",
    "destination": "COPENHAGEN",
    "etaIso": "2026-07-18T06:00:00Z",
    "specialManeuver": "not engaged",
}


def apply_delta(tracker: VesselTracker, vessel: str, values: list, now: float = 100.0) -> None:
    tracker.apply(
        json.dumps(
            {
                "context": f"vessels.{vessel}",
                "updates": [{"values": [{"path": p, "value": v} for p, v in values]}],
            }
        ),
        now=now,
    )


def test_every_vessel_carries_its_signalk_key_and_keeps_it_when_it_moves() -> None:
    """Identity, which the snapshot used to throw away.

    The tracker has always keyed vessels by SignalK's own vessel key and
    then dropped it while building the wire shape, leaving the client to
    fall back on a *positional* id — unique within one snapshot, and stale
    the instant the target moves. So a target list, a search or a collision
    alarm could not durably re-resolve a vessel it was holding. The key is
    the fix, and this is the claim: same vessel, moved, same id.
    """
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    apply_delta(tracker, CARGO, [("navigation.position", {"latitude": 1.0, "longitude": 2.0})])

    (before,) = tracker.snapshot(now=100.0, ttl=600.0)["targets"]
    assert before["id"] == CARGO

    apply_delta(
        tracker, CARGO, [("navigation.position", {"latitude": 1.1, "longitude": 2.1})], now=160.0
    )
    (after,) = tracker.snapshot(now=160.0, ttl=600.0)["targets"]
    assert (after["lat"], after["lng"]) != (before["lat"], before["lng"])
    assert after["id"] == before["id"]  # the point: it survived the move

    # The own ship gets its key too. The frontend keys itself on the `self`
    # slot rather than on this (a boat whose own MMSI was never configured
    # is exactly the boat whose skipper wants to check what it transmits),
    # but a vessel without identity is not a vessel.
    apply_delta(tracker, SELF_ID, [("navigation.position", {"latitude": 3.0, "longitude": 4.0})])
    assert tracker.snapshot(now=160.0, ttl=600.0)["self"]["id"] == SELF_ID


def test_a_class_a_target_arrives_whole() -> None:
    """Every field the panel can show, end to end, in one delta.

    Whole-dict equality on purpose: this is the wire contract, so a field
    that quietly stops being normalized has to fail here, and so does one
    that appears with a name or a unit the frontend does not expect.
    """
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    apply_delta(tracker, CARGO, CARGO_DELTA)
    assert tracker.snapshot(now=100.0, ttl=600.0)["targets"] == [CARGO_WIRE]


def test_the_own_ship_is_told_the_same_way() -> None:
    """"What am I transmitting?" is the same question as "what is that
    ship transmitting?", so it must get the same answer — no separate
    own-ship shape, and nothing withheld."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    apply_delta(tracker, SELF_ID, CARGO_DELTA)
    assert tracker.snapshot(now=100.0, ttl=600.0)["self"] == {**CARGO_WIRE, "id": SELF_ID}


def test_the_nav_status_goes_out_under_the_one_name_the_frontend_reads() -> None:
    """`navigation.state` reaches two consumers — the details panel and the
    symbol renderer — which briefly disagreed about its name. Settled on
    `navStatus`, the AIS term of art; `navStatus` is gone. This test is the
    guard against a second name creeping back."""
    tracker = VesselTracker()
    apply_delta(
        tracker,
        "anchored",
        [
            ("navigation.position", {"latitude": 1.0, "longitude": 2.0}),
            ("navigation.state", "anchored"),
        ],
    )
    (target,) = tracker.snapshot(now=100.0, ttl=600.0)["targets"]
    assert target["navStatus"] == "anchored"
    assert "navState" not in target  # the name that lost; nothing may resurrect it


def test_the_symbol_renderer_gets_the_two_fields_it_draws_from() -> None:
    """The renderer (frontend/src/layers/aisSymbols.ts) picks a day-shape
    from nav status, falling back to ship type — Class B carries no status
    at all, so type is the only thing that will ever say "sailing" for a
    yacht. Without both, every target is a bare triangle: correct and
    uninformative. `shipTypeId` is the numeric ITU-R M.1371 code out of
    `design.aisShipType` = `{id, name}`, not the label."""
    tracker = VesselTracker()
    apply_delta(
        tracker,
        "yacht",  # Class B: type, no status
        [
            ("navigation.position", {"latitude": 1.0, "longitude": 2.0}),
            ("design.aisShipType", {"id": 36, "name": "Sailing"}),
        ],
    )
    apply_delta(
        tracker,
        "trawler",  # Class A: both, and status wins where they disagree
        [
            ("navigation.position", {"latitude": 3.0, "longitude": 4.0}),
            ("design.aisShipType", {"id": 30, "name": "Fishing"}),
            ("navigation.state", "anchored"),
        ],
    )
    seen = {t["id"]: t for t in tracker.snapshot(now=100.0, ttl=600.0)["targets"]}
    assert seen["yacht"]["shipTypeId"] == 36
    assert "navStatus" not in seen["yacht"]  # no status is not "under way"
    assert (seen["trawler"]["shipTypeId"], seen["trawler"]["navStatus"]) == (30, "anchored")


def test_a_class_b_target_reports_position_and_nothing_is_invented() -> None:
    """Class B carries no nav status, no ROT, no draft, no destination, no
    IMO — and never will. Partial data is the normal case, so what it does
    not say must be *absent*, not defaulted, not nulled: the panel renders
    absence deliberately, and a fabricated 0 draft is a wrong answer."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    apply_delta(
        tracker,
        "urn:mrn:imo:mmsi:219000001",
        [
            ("navigation.position", {"latitude": 1.0, "longitude": 2.0}),
            ("navigation.speedOverGround", 3.5),
            ("sensors.ais.class", "B"),
            ("", {"name": "Kraka", "mmsi": "219000001"}),
        ],
    )
    (target,) = tracker.snapshot(now=100.0, ttl=600.0)["targets"]
    assert target == {
        "id": "urn:mrn:imo:mmsi:219000001",
        "lng": 2.0,
        "lat": 1.0,
        "sogMs": 3.5,
        "aisClass": "B",
        "name": "Kraka",
        "mmsi": "219000001",
    }
    # Said explicitly, because the failure this guards against is a key
    # arriving with a plausible-looking default rather than not arriving.
    # `navStatus`/`navStatus` most of all: the symbol renderer promotes ship
    # type into a *missing* status, so a defaulted status would make a
    # yacht under sail claim to be motoring.
    for absent in (
        "navStatus",
        "navStatus",
        "draftM",
        "rotDegPerMin",
        "imo",
        "destination",
        "lengthM",
        "shipTypeId",
    ):
        assert absent not in target


def test_both_dialects_report_a_draft() -> None:
    """The trap: n2k-signalk writes AIS message 5's draft to
    `design.draft.maximum`, nmea0183-signalk writes the same field to
    `design.draft.current`. Reading one dialect silently loses the draft of
    every ship arriving by the other."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    pos = ("navigation.position", {"latitude": 1.0, "longitude": 2.0})

    apply_delta(tracker, "n2k", [pos, ("design.draft", {"maximum": 11.4})])
    apply_delta(tracker, "nmea0183", [pos, ("design.draft", {"current": 4.2})])
    # …and the leaf-path shape of either, which is what a subscription to
    # `design.*` also matches.
    apply_delta(tracker, "leaf", [pos, ("design.draft.maximum", 7.7)])

    drafts = {t["id"]: t["draftM"] for t in tracker.snapshot(now=100.0, ttl=600.0)["targets"]}
    assert drafts == {"n2k": 11.4, "nmea0183": 4.2, "leaf": 7.7}


def test_a_current_draft_wins_over_the_maximum() -> None:
    """When a ship reports both, `current` is the draft it is at now and
    `maximum` is the hull's limit. The panel shows one number, so the
    live one is the one worth showing."""
    tracker = VesselTracker()
    apply_delta(
        tracker,
        "both",
        [
            ("navigation.position", {"latitude": 1.0, "longitude": 2.0}),
            ("design.draft", {"current": 4.2, "maximum": 5.5}),
        ],
    )
    assert tracker.snapshot(now=100.0, ttl=600.0)["targets"][0]["draftM"] == 4.2


def test_the_off_spec_special_maneuver_path_is_read() -> None:
    """`navigation.specialManeuver` is not in the SignalK schema (which
    says `navigation.maneuver`) and is nonetheless what both parsers emit.
    Reality wins; the spec path is accepted too, in case one is ever
    fixed."""
    tracker = VesselTracker()
    pos = ("navigation.position", {"latitude": 1.0, "longitude": 2.0})
    apply_delta(tracker, "real", [pos, ("navigation.specialManeuver", "engaged")])
    apply_delta(tracker, "spec", [pos, ("navigation.maneuver", "not engaged")])
    seen = {t["id"]: t["specialManeuver"] for t in tracker.snapshot(now=100.0, ttl=600.0)["targets"]}
    assert seen == {"real": "engaged", "spec": "not engaged"}


def test_static_data_is_read_however_deeply_it_is_nested() -> None:
    """Some transports send AIS static data as one root-path object
    holding a whole vessel subtree rather than as leaf deltas. Same
    fields, same result — that is why unknown objects are walked."""
    tracker = VesselTracker()
    apply_delta(
        tracker,
        "nested",
        [
            (
                "",
                {
                    "name": "Kraka",
                    "navigation": {"position": {"latitude": 1.0, "longitude": 2.0}},
                    "design": {"draft": {"maximum": 3.3}, "aisShipType": {"id": 36, "name": "Sailing"}},
                    "sensors": {"ais": {"class": "B"}},
                    "communication": {"callsignVhf": "OZAB2"},
                },
            )
        ],
    )
    assert tracker.snapshot(now=100.0, ttl=600.0)["targets"] == [
        {
            "id": "nested",
            "lng": 2.0,
            "lat": 1.0,
            "name": "Kraka",
            "draftM": 3.3,
            "shipType": "Sailing",
            "shipTypeId": 36,
            "aisClass": "B",
            "callsign": "OZAB2",
        }
    ]


def test_blank_and_wrong_typed_values_read_as_absent() -> None:
    """AIS pads its string fields, and an unset destination arrives as
    spaces. A blank is not a value: it must not become an empty row that
    claims the target told us something."""
    tracker = VesselTracker()
    apply_delta(
        tracker,
        "junk",
        [
            ("navigation.position", {"latitude": 1.0, "longitude": 2.0}),
            ("navigation.destination", {"commonName": "   "}),
            ("navigation.state", ""),
            ("design.beam", True),  # bool is an int in Python; not a beam
            ("design.draft", {"maximum": "deep"}),
            ("communication.callsignVhf", 12345),
            ("navigation.headingTrue", None),
        ],
    )
    assert tracker.snapshot(now=100.0, ttl=600.0)["targets"] == [
        {"id": "junk", "lng": 2.0, "lat": 1.0}
    ]


def test_half_a_position_is_not_a_position() -> None:
    """Keeping the last fix beats plotting the boat on the equator."""
    tracker = VesselTracker()
    apply_delta(tracker, "drifter", [("navigation.position", {"latitude": 1.0, "longitude": 2.0})])
    apply_delta(tracker, "drifter", [("navigation.position", {"latitude": 9.0})])
    assert tracker.snapshot(now=100.0, ttl=600.0)["targets"][0]["lat"] == 1.0


def test_garbage_on_the_stream_is_dropped_not_raised() -> None:
    """One unparseable NMEA-derived frame must not take the boat's
    connection down with it."""
    tracker = VesselTracker()
    for junk in ["", "not json", "[]", '"hello"', '{"updates": "nope"}', '{"updates": [null]}']:
        tracker.apply(junk, now=0.0)
    assert tracker.snapshot(now=0.0, ttl=600.0) == {"self": None, "targets": [], "autopilot": None, "course": None}


# -- the boat's own sensors, and how old they are --------------------------
#
# The depth instrument is a GUARD, and invariant #6 says a stale instrument
# cannot alarm. That makes a WRONG staleness signal worse than none: it
# silently disarms the guard. So these are the tests that matter most in
# this file, and they are about the three states the wire can express —
# absent (no sensor), present-and-not-listed (fresh), present-and-listed
# (that old) — and about the property that pays for the design: an idle
# healthy boat says nothing at all.

#: One SignalK box reporting a sounder and a masthead unit, in SI.
SENSOR_DELTA = [
    ("navigation.position", {"latitude": 55.9, "longitude": 12.6}),
    ("environment.depth.belowTransducer", 4.2),
    ("environment.depth.belowSurface", 4.9),
    ("environment.wind.speedApparent", 8.0),
    ("environment.wind.angleApparent", -math.pi / 4),  # 45° off the port bow
    ("environment.wind.speedTrue", 6.5),
    ("environment.wind.angleTrueWater", math.pi / 2),  # abeam to starboard
]


def sensors(tracker: VesselTracker, now: float = 100.0, values: list | None = None) -> dict:
    """The own ship's wire dict after one sensor delta."""
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=now)
    apply_delta(tracker, SELF_ID, values if values is not None else SENSOR_DELTA, now=now)
    return tracker.snapshot(now=now, ttl=600.0)["self"]


def test_the_sounder_and_the_wind_arrive_in_plotter_units() -> None:
    """The wire contract for the four instruments that had no data at all.

    Whole-dict equality, like the Class A test: a unit that quietly changes,
    or a field that appears under a name the frontend does not read, is a
    silently wrong number on a chart plotter and has to fail here.

    Both depths go out. They are different questions — `belowTransducer` is
    the raw echo, `belowSurface` is the same echo with the boat's configured
    offset added and is the one comparable to a charted sounding — and the
    offset between them is known only to the boat's own SignalK config, so
    neither is ever synthesized from the other.
    """
    assert sensors(VesselTracker()) == {
        "id": SELF_ID,
        "lng": 12.6,
        "lat": 55.9,
        "depthBelowTransducerM": 4.2,
        "depthBelowSurfaceM": 4.9,
        "awsMs": 8.0,
        "awaDeg": pytest.approx(-45.0),  # negative is to port, as SignalK has it
        "twsMs": 6.5,
        "twaDeg": pytest.approx(90.0),
    }


def test_a_boat_with_no_sensors_says_nothing_about_them() -> None:
    """Absence, not zero and not "stale". A boat with no sounder has no
    depth field and no `stale` entry for one — for ever, however long we
    wait. If a never-fitted sensor reported an age, every guard on every
    boat without one would be permanently "disarmed", which is a statement
    about a thing that does not exist."""
    tracker = VesselTracker()
    own = sensors(tracker, values=[("navigation.position", {"latitude": 1.0, "longitude": 2.0})])
    assert own == {"id": SELF_ID, "lng": 2.0, "lat": 1.0}

    far_later = tracker.snapshot(now=100.0 + 86_400.0, ttl=600.0)["self"]
    assert "stale" not in far_later
    assert "depthBelowTransducerM" not in far_later


def test_a_fresh_reading_is_not_listed_and_a_stale_one_is() -> None:
    """Fresh is expressed by ABSENCE from the map, which is what lets an
    idle boat stay silent — and the value never disappears when it goes
    stale, because "4.2 m, five minutes ago" is worth more to a mariner than
    nothing at all. It just must not be allowed to shout."""
    tracker = VesselTracker()
    sensors(tracker)

    # Freshly heard: the readings are there, and the map is not.
    assert "stale" not in tracker.snapshot(now=100.0, ttl=600.0)["self"]
    assert "stale" not in tracker.snapshot(now=100.0 + STALE_AFTER - 0.1, ttl=600.0)["self"]

    # Past the threshold: every sensor at once, since one box fell silent.
    old = tracker.snapshot(now=100.0 + 300.0, ttl=600.0)["self"]
    assert old["depthBelowTransducerM"] == 4.2  # still shown...
    assert old["stale"] == {  # ...and now struck through
        "awaDeg": 300,
        "awsMs": 300,
        "depthBelowSurfaceM": 300,
        "depthBelowTransducerM": 300,
        "twaDeg": 300,
        "twsMs": 300,
    }


def test_a_live_vane_and_a_dead_derivation_are_told_apart() -> None:
    """The reason there is a stamp per FIELD and not one per sensor group.

    Apparent wind is measured at the masthead; true wind is computed from it
    by a SignalK plugin. The plugin can die while the vane keeps reporting —
    and then AWS is live while TWS is minutes old. Grouping them would force
    one lie or the other: either strike a working instrument through, or
    show a dead one as current.

    Depth is the same claim in the case that matters: a sounder that has
    lost the bottom must not be kept "fresh" by a chatty wind vane.
    """
    tracker = VesselTracker()
    sensors(tracker)
    # Only the vane speaks again, 200s on.
    apply_delta(
        tracker,
        SELF_ID,
        [("environment.wind.speedApparent", 9.0), ("environment.wind.angleApparent", -0.5)],
        now=300.0,
    )
    own = tracker.snapshot(now=300.0, ttl=600.0)["self"]
    assert own["awsMs"] == 9.0
    assert "awsMs" not in own["stale"] and "awaDeg" not in own["stale"]
    # The derived pair, and the sounder, are old and say so. 200s reports as
    # 120: the ladder rounds DOWN, so the age is a floor and never a boast.
    assert own["stale"] == {
        "depthBelowSurfaceM": 120,
        "depthBelowTransducerM": 120,
        "twaDeg": 120,
        "twsMs": 120,
    }


def test_an_idle_boat_publishes_nothing() -> None:
    """THE property the whole design is paid for with.

    The publisher sends only when the snapshot CHANGES (see
    `SignalKService._publish`), so anything that ticks on the wire ticks at
    5 Hz to every device on the boat, for ever. A raw per-path age would do
    exactly that. This asserts the two idle cases:

      - a boat at anchor with LIVE sensors reporting a constant depth: the
        snapshot must be equal to itself as the clock runs;
      - a boat whose sensors are DEAD: the snapshot must go quiet again once
        the bucket ladder tops out, rather than counting seconds for ever.
    """
    tracker = VesselTracker()
    sensors(tracker, now=100.0)

    # At anchor: the same reading every second, for a minute. The clock is
    # moving the whole time and the snapshot never changes.
    seen = set()
    for tick in range(60):
        at = 100.0 + tick
        apply_delta(tracker, SELF_ID, SENSOR_DELTA, now=at)
        seen.add(json.dumps(tracker.snapshot(now=at, ttl=600.0), sort_keys=True))
    assert len(seen) == 1, "an idle boat with live sensors changed the snapshot"

    # Dead sensors: count how many DISTINCT snapshots a full day of silence
    # produces. It is the bucket ladder, once, and then silence.
    silent = {
        json.dumps(tracker.snapshot(now=160.0 + t, ttl=600.0), sort_keys=True)
        for t in range(0, 86_400, 1)
    }
    # One per rung, plus the fresh state it starts the day in. Twelve
    # snapshots for 24 hours of a dead sounder; a raw age would be 432,000.
    assert len(silent) == len(model._AGE_BUCKETS) + 1, (
        "a dead sensor must cost one publish per rung and then nothing"
    )

    # And the top rung really is the end of it: an hour dead and a week dead
    # are the same message.
    assert tracker.snapshot(now=160.0 + 3600.0, ttl=600.0)["self"]["stale"] == tracker.snapshot(
        now=160.0 + 7 * 86_400.0, ttl=600.0
    )["self"]["stale"]


def test_the_reported_age_never_overstates_freshness() -> None:
    """Bucketing rounds DOWN, so the age on the wire is a lower bound and a
    consumer is never told a reading is newer than it is. The direction is
    the point: rounding up would be harmless, rounding down is what makes
    "this is at least N seconds old" true."""
    assert model.stale_age(0.0) is None
    assert model.stale_age(9.999) is None  # fresh right up to the threshold
    assert model.stale_age(STALE_AFTER) == 10
    for age in (10.0, 19.9, 20.0, 44.0, 61.5, 119.0, 3599.0, 1e9):
        reported = model.stale_age(age)
        assert reported is not None
        assert reported <= age
    assert model.stale_age(1e9) == max(model._AGE_BUCKETS)  # capped, not counting


def test_the_server_uses_its_own_clock_and_not_the_sensors() -> None:
    """A delta's `timestamp` is the sensor's clock, and on a boat every
    clock is a different clock. An NMEA gateway with a dead RTC dates a live
    sounding to 1970; believing it would mark the depth permanently stale,
    and since a stale instrument cannot alarm, that would permanently disarm
    the depth guard. The arrival time cannot do that."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=1_000_000.0)
    tracker.apply(
        json.dumps(
            {
                "context": f"vessels.{SELF_ID}",
                "updates": [
                    {
                        "timestamp": "1970-01-01T00:00:00Z",  # the dead RTC
                        "source": {"label": "n2k"},
                        "values": [
                            {
                                "path": "navigation.position",
                                "value": {"latitude": 1.0, "longitude": 2.0},
                            },
                            {"path": "environment.depth.belowTransducer", "value": 4.2},
                        ],
                    }
                ],
            }
        ),
        now=1_000_000.0,
    )
    own = tracker.snapshot(now=1_000_000.0, ttl=600.0)["self"]
    assert own["depthBelowTransducerM"] == 4.2
    assert "stale" not in own  # it arrived just now, whatever the gateway thinks


def test_a_rejected_value_does_not_refresh_the_sensor() -> None:
    """Only an ACCEPTED reading stamps. A box emitting `null` depth — which
    is what a sounder that has lost the bottom emits — is a sensor that has
    stopped telling us the depth, and must read as one. If the rejected
    frame refreshed the stamp, a sounder in deep water would show its last
    shallow reading as current for ever, with the guard armed on it. That is
    the worst bug this file can have."""
    tracker = VesselTracker()
    sensors(tracker, now=100.0)
    for junk in (None, "4.2", True, {"value": 4.2}):
        apply_delta(tracker, SELF_ID, [("environment.depth.belowTransducer", junk)], now=400.0)
    own = tracker.snapshot(now=400.0, ttl=600.0)["self"]
    assert own["depthBelowTransducerM"] == 4.2  # the last real echo, unchanged
    assert own["stale"]["depthBelowTransducerM"] == 300  # and correctly called old


def test_the_sensors_are_read_however_the_box_nests_them() -> None:
    """The same walk that resolves the two draft dialects. A box that sends
    `environment.wind` as one object must be understood exactly like one
    that sends the leaves — including the stamp, or a nesting box's depth
    would read fresh for ever."""
    tracker = VesselTracker()
    own = sensors(
        tracker,
        values=[
            ("navigation.position", {"latitude": 1.0, "longitude": 2.0}),
            ("environment", {"depth": {"belowTransducer": 3.3}, "wind": {"speedApparent": 7.0}}),
        ],
    )
    assert own["depthBelowTransducerM"] == 3.3
    assert own["awsMs"] == 7.0
    assert tracker.snapshot(now=500.0, ttl=600.0)["self"]["stale"] == {
        "awsMs": 300,
        "depthBelowTransducerM": 300,
    }


# -- user-chosen extra paths (dashboard widgets) ---------------------------
#
# A path with no typed handler, subscribed because a device added a widget
# for it. The typed model discards it; the `paths` map passes it through raw.


def test_a_configured_extra_path_is_passed_through_raw_with_units() -> None:
    """The point of an extra path: a value the backend has no opinion about
    reaches a widget, with SignalK's own units for it and untouched."""
    tracker = VesselTracker(extra_paths=["electrical.batteries.house.voltage"])
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    tracker.apply(
        json.dumps(
            {
                "context": f"vessels.{SELF_ID}",
                "updates": [
                    {
                        "meta": [
                            {
                                "path": "electrical.batteries.house.voltage",
                                "value": {"units": "V"},
                            }
                        ],
                        "values": [
                            {"path": "electrical.batteries.house.voltage", "value": 12.6}
                        ],
                    }
                ],
            }
        ),
        now=100.0,
    )
    snapshot = tracker.snapshot(now=100.0, ttl=600.0)
    assert snapshot["paths"] == {
        "electrical.batteries.house.voltage": {"value": 12.6, "units": "V"}
    }
    # It did not leak into the typed own-ship shape.
    assert snapshot["self"] is None  # no position fix, and no invented fields


def test_an_unconfigured_path_is_still_discarded() -> None:
    """The Pi-CPU discipline: only chosen paths are captured. A path nobody
    asked for is dropped exactly as before, never landing in `paths`."""
    tracker = VesselTracker(extra_paths=["electrical.batteries.house.voltage"])
    apply_delta(
        tracker,
        SELF_ID,
        [
            ("navigation.position", {"latitude": 1.0, "longitude": 2.0}),
            ("electrical.batteries.house.voltage", 12.6),  # configured
            ("propulsion.port.revolutions", 42.0),  # NOT configured
        ],
    )
    # self_id is unknown (no hello), so nothing is own-ship: even the
    # configured path is not captured, and the unconfigured one certainly not.
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    apply_delta(
        tracker,
        SELF_ID,
        [
            ("navigation.position", {"latitude": 1.0, "longitude": 2.0}),
            ("electrical.batteries.house.voltage", 12.6),
            ("propulsion.port.revolutions", 42.0),
        ],
    )
    snapshot = tracker.snapshot(now=100.0, ttl=600.0)
    assert set(snapshot["paths"]) == {"electrical.batteries.house.voltage"}
    assert "propulsion.port.revolutions" not in snapshot["paths"]


def test_a_boat_with_no_extra_paths_has_no_paths_key() -> None:
    """Omitted-when-empty, so a boat with no dashboard paths is byte-for-byte
    the old snapshot and the publish-on-change guard is untouched."""
    tracker = VesselTracker()
    apply_delta(tracker, SELF_ID, [("electrical.batteries.house.voltage", 12.6)])
    assert "paths" not in tracker.snapshot(now=100.0, ttl=600.0)


def test_an_extra_path_ages_but_keeps_its_last_value() -> None:
    """Same rule as the typed sensors: `age` appears only when stale and is
    bucketed, so a dead widget path ticks per rung and then goes quiet — it
    does not blank, and it does not broadcast forever."""
    tracker = VesselTracker(extra_paths=["tanks.fuel.0.currentLevel"])
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    apply_delta(tracker, SELF_ID, [("tanks.fuel.0.currentLevel", 0.8)], now=100.0)

    fresh = tracker.snapshot(now=100.0, ttl=600.0)["paths"]["tanks.fuel.0.currentLevel"]
    assert fresh == {"value": 0.8}  # fresh: no age key

    old = tracker.snapshot(now=100.0 + 300.0, ttl=600.0)["paths"]["tanks.fuel.0.currentLevel"]
    assert old == {"value": 0.8, "age": 300}  # last value kept, now aged


def test_a_null_extra_value_does_not_overwrite_the_last_real_one() -> None:
    """A box that stops reporting a path is silent, not reporting `None`;
    keeping the last real value (which then ages) beats blanking the widget."""
    tracker = VesselTracker(extra_paths=["propulsion.port.revolutions"])
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    apply_delta(tracker, SELF_ID, [("propulsion.port.revolutions", 42.0)], now=100.0)
    apply_delta(tracker, SELF_ID, [("propulsion.port.revolutions", None)], now=100.0)
    paths = tracker.snapshot(now=100.0, ttl=600.0)["paths"]
    assert paths["propulsion.port.revolutions"]["value"] == 42.0


def test_an_ais_target_is_never_given_a_staleness_map() -> None:
    """Targets are settled the other way — by dropping them — and AIS
    carries neither a sounder nor a wind vane, so a target has nothing to be
    stale about. The map must not leak onto them."""
    tracker = VesselTracker()
    tracker.apply('{"self": "vessels.%s"}' % SELF_ID, now=100.0)
    apply_delta(tracker, CARGO, CARGO_DELTA, now=100.0)
    (target,) = tracker.snapshot(now=100.0 + 500.0, ttl=600.0)["targets"]
    assert "stale" not in target


def test_search_targets_matches_name_or_mmsi_case_insensitively() -> None:
    """The backend half of AIS-in-search (mivnav.api.search): live, not
    indexed, so this drives the tracker directly rather than through a
    socket — the same shortcut the model-level tests above take.

    Applied with the real clock (unlike the model-level tests, which fix
    "now"): `search_targets` reads through `snapshot()`, which staleness-
    filters against `time.time()`, so a delta stamped at a fixed fake `now`
    would read as ancient and be dropped."""
    service = SignalKService(None)
    try:
        service._tracker.apply(
            '{"context": "vessels.a", "updates": [{"values": ['
            '{"path": "navigation.position", "value": {"latitude": 55.9, "longitude": 12.6}},'
            '{"path": "", "value": {"name": "Nordic Star", "mmsi": "265123456"}}]}]}',
            now=time.time(),
        )
        service._tracker.apply(
            '{"context": "vessels.b", "updates": [{"values": ['
            '{"path": "navigation.position", "value": {"latitude": 3.0, "longitude": 4.0}},'
            '{"path": "", "value": {"name": "Kraka", "mmsi": "219000001"}}]}]}',
            now=time.time(),
        )
        assert [t["id"] for t in service.search_targets("nordic")] == ["a"]
        assert [t["id"] for t in service.search_targets("2651")] == ["a"]  # MMSI substring
        assert {t["id"] for t in service.search_targets("")} == {"a", "b"}  # empty = everything
        assert service.search_targets("nonexistent") == []
    finally:
        service.close()


# -- the service -----------------------------------------------------------


def test_the_service_subscribes_to_every_vessel_and_tracks_them(upstream: FakeSignalK) -> None:
    service = SignalKService(upstream.url)
    try:
        upstream.wait_sessions(1)
        wait_until(lambda: service.snapshot()["status"] == "connected")
        # `subscribe=none` on the URL plus an explicit vessels.* request is
        # the only combination that yields AIS targets (see SignalKConfig).
        wait_until(lambda: upstream.subscriptions != [])
        assert upstream.subscriptions[0]["context"] == "vessels.*"

        upstream.broadcast(upstream.position(55.9, 12.6))
        upstream.broadcast(upstream.position(56.0, 12.7, vessel="other"))
        wait_until(lambda: service.snapshot()["self"] is not None)
        wait_until(lambda: service.snapshot()["targets"] != [])
        assert service.snapshot()["self"] == {"id": SELF_ID, "lng": 12.6, "lat": 55.9}
        assert service.snapshot()["targets"] == [{"id": "other", "lng": 12.7, "lat": 56.0}]
    finally:
        service.close()


def test_the_subscription_asks_for_everything_a_vessel_can_say(upstream: FakeSignalK) -> None:
    """The paths are half the contract: a field the box is never asked for
    is a field the panel never shows, and nothing else in the stack can
    tell the difference between that and a target that stayed quiet.

    Asserted as a subset, not an exact list, so that adding a path is not
    a two-place edit — the exact wire shape is pinned by the model tests.
    """
    service = SignalKService(upstream.url)
    try:
        upstream.wait_sessions(1)
        wait_until(lambda: upstream.subscriptions != [])
        asked = {s["path"] for s in upstream.subscriptions[0]["subscribe"]}
        assert {
            "navigation.position",
            "navigation.state",
            "navigation.rateOfTurn",
            "navigation.destination",
            "navigation.specialManeuver",
            "design.*",
            "sensors.ais.*",
            "registrations.*",
            "communication.*",
            "",
            # The sounder and the wind vane, which the chrome's depth guard
            # and wind instruments read.
            "environment.depth.belowTransducer",
            "environment.depth.belowSurface",
            "environment.wind.speedApparent",
            "environment.wind.angleApparent",
            "environment.wind.speedTrue",
            "environment.wind.angleTrueWater",
        } <= asked
    finally:
        service.close()


def test_the_subscription_asks_for_nothing_it_does_not_consume(upstream: FakeSignalK) -> None:
    """The discipline, as an assertion rather than a comment.

    `SUBSCRIPTION` rejects `{"path": "*"}` on purpose: the bus on a real
    boat carries engines, tanks, batteries and a cabin thermometer, and the
    cost of parsing them in order to throw them away lands on the Pi that
    also serves tiles. Adding depth and wind was the first time in this
    file's life that something on the excluded side gained a consumer, and
    the answer was six named paths — not `environment.*`, and not the
    wildcard the exclusion was written to prevent.

    So: every path asked for is either a leaf we have a handler for, or one
    of the narrow static subtrees the comment justifies. A future `*` fails
    here, loudly, next to the reasoning.
    """
    service = SignalKService(upstream.url)
    try:
        upstream.wait_sessions(1)
        wait_until(lambda: upstream.subscriptions != [])
        asked = {s["path"] for s in upstream.subscriptions[0]["subscribe"]}

        assert "*" not in asked
        assert "environment.*" not in asked
        # The exclusion's own examples. None of these has a consumer.
        for absent in ("propulsion.*", "tanks.*", "electrical.*", "environment.outside.*"):
            assert absent not in asked

        wildcards = {p for p in asked if p.endswith(".*")}
        assert wildcards == {
            "design.*",
            "sensors.ais.*",
            "registrations.*",
            "communication.*",
            "navigation.destination.*",
            # Not static, but small and ours: one leaf per alarming target,
            # keyed by its urn, which no named leaf could spell. Read by
            # `mivnav.collision.notices.NoticeState` (our own echo).
            "notifications.navigation.closestApproach.*",
        }, "a new wildcard: is it a small static subtree, or is it the mistake?"
        # Every non-wildcard path (bar the root object) is one we parse —
        # either a leaf with a handler, or a parent whose children have one
        # and which `_apply_value` walks (`navigation.destination` arrives as
        # an object from one dialect and as leaves from the other).
        #
        # There are FIVE consumers, not one: the vessel model, the autopilot
        # sink, the course sink, the arrival sink and the anchor sink, each handed every
        # own-ship path `VesselTracker.apply` sees. A `steering.*` path has
        # no entry in `model._HANDLERS` and never will — it is read by
        # `autopilot.model._HANDLERS` instead; a `navigation.course*` path
        # lives only in `model._COURSE_HANDLERS`; a
        # `notifications.navigation.course.*` path (#yprzuqtt) lives only in
        # `model._ARRIVAL_HANDLERS`; an anchor path lives only in
        # `signalk.anchor._HANDLERS`. Checking only a subset would call the
        # rudder (or the active course, or an arrival) unconsumed, which is
        # how this assertion would end up deleted for being wrong rather
        # than fixed for being narrow.
        readers = (
            set(model._HANDLERS)
            | set(autopilot_model._HANDLERS)
            | set(model._COURSE_HANDLERS)
            | set(model._ARRIVAL_HANDLERS)
            | set(anchor_model._HANDLERS)
            | {anchor_model.FROM_BOW_PATH}
            # Our own shallow-water alarm's echo (mivnav.shallow.notices).
            | {shallow_notices.PATH}
            | {mob_model.PATH}
        )
        for path in asked - wildcards - {""}:
            assert path in readers or any(
                h.startswith(path + ".") for h in readers
            ), f"subscribed to {path!r} with nothing to read it"
    finally:
        service.close()


def test_the_subscription_carries_configured_extra_paths(upstream: FakeSignalK) -> None:
    """A user-chosen dashboard path rides the one subscription alongside the
    curated set — the curated paths are still all asked for, and the extra
    one is added, not substituted."""
    service = SignalKService(
        upstream.url, extra_paths=["electrical.batteries.house.voltage"]
    )
    try:
        upstream.wait_sessions(1)
        wait_until(lambda: upstream.subscriptions != [])
        asked = {s["path"] for s in upstream.subscriptions[0]["subscribe"]}
        assert "electrical.batteries.house.voltage" in asked
        assert "navigation.position" in asked  # the curated set is intact
        assert "*" not in asked  # and still never the wildcard
    finally:
        service.close()


def test_depth_and_wind_survive_the_real_socket(upstream: FakeSignalK) -> None:
    """End to end over loopback: a box reports a sounding and a masthead
    unit, and it reaches a snapshot in plotter units. The unit tests above
    drive the tracker directly; this is the one that would catch the path
    being subscribed but never delivered."""
    service = SignalKService(upstream.url)
    try:
        upstream.wait_sessions(1)
        wait_until(lambda: service.snapshot()["status"] == "connected")
        wait_until(lambda: upstream.subscriptions != [])
        upstream.broadcast(upstream.position(55.9, 12.6))
        upstream.broadcast(
            upstream.delta(
                [
                    ("environment.depth.belowTransducer", 4.2),
                    ("environment.wind.speedApparent", 8.0),
                    ("environment.wind.angleApparent", -math.pi / 4),
                    ("environment.wind.speedTrue", 6.5),
                    ("environment.wind.angleTrueWater", math.pi / 2),
                ]
            )
        )
        wait_until(lambda: (service.snapshot()["self"] or {}).get("awsMs") is not None)
        own = service.snapshot()["self"]
        assert own["depthBelowTransducerM"] == 4.2
        assert own["awsMs"] == 8.0
        assert own["awaDeg"] == pytest.approx(-45.0)
        assert own["twsMs"] == 6.5
        assert own["twaDeg"] == pytest.approx(90.0)
        # Just arrived over a real socket: nothing may claim to be old.
        assert "stale" not in own
    finally:
        service.close()


def test_a_whole_class_a_ship_survives_the_real_socket(upstream: FakeSignalK) -> None:
    """The model tests drive the tracker directly. This one puts the same
    ship through an actual websocket, JSON and all, because that is what
    the boat does."""
    service = SignalKService(upstream.url)
    try:
        upstream.wait_sessions(1)
        wait_until(lambda: service.snapshot()["status"] == "connected")
        upstream.broadcast(upstream.delta(CARGO_DELTA, vessel=CARGO))
        wait_until(lambda: service.snapshot()["targets"] != [])
        assert service.snapshot()["targets"] == [CARGO_WIRE]
    finally:
        service.close()


def test_a_disabled_service_is_live_and_silent() -> None:
    """No SignalK box on this boat is a normal boat: an object that
    answers "off", not a missing one."""
    before = threading.active_count()
    service = SignalKService(None)
    try:
        assert service.snapshot() == {"status": "off", "self": None, "targets": [], "autopilot": None, "course": None}
        assert threading.active_count() == before  # no reader thread at all

        seen: list = []
        service.subscribe(seen.append)
        assert seen == [{"status": "off", "self": None, "targets": [], "autopilot": None, "course": None}]
    finally:
        service.close()


def test_an_unreachable_box_never_raises_and_keeps_retrying() -> None:
    dead = FakeSignalK().start()
    port = dead.port
    dead.stop()  # a port with nothing on it, reliably

    service = SignalKService(
        f"ws://127.0.0.1:{port}/signalk/v1/stream", retry_min=0.01, retry_max=0.02
    )
    try:
        # Construction does not block on the network, and the failure is a
        # status, not an exception.
        assert service.snapshot()["status"] == "connecting"
        time.sleep(0.2)  # several retries have failed by now
        assert service.snapshot() == {"status": "connecting", "self": None, "targets": [], "autopilot": None, "course": None}
    finally:
        service.close()


def test_subscribers_are_told_when_the_service_closes(upstream: FakeSignalK) -> None:
    """The signal a connected client uses to go and fetch the connection
    that replaced this one."""
    service = SignalKService(upstream.url)
    seen: list = []
    service.subscribe(seen.append)
    service.close()
    assert seen[0]["status"] in ("connecting", "connected")
    assert seen[-1] is None


# -- the fan-out, end to end -----------------------------------------------


def test_one_upstream_connection_serves_many_clients_and_outlives_them(
    app_client: Any, upstream: FakeSignalK
) -> None:
    client, runtime = app_client
    enable(runtime, upstream)

    with client.websocket_connect("/signalk/stream") as first:
        wait_for(first, lambda s: s["status"] == "connected")
        with client.websocket_connect("/signalk/stream") as second:
            wait_for(second, lambda s: s["status"] == "connected")
            upstream.broadcast(upstream.position(55.9, 12.6))
            # Both devices see the same boat, from one session upstream.
            for ws in (first, second):
                assert wait_for(ws, lambda s: s["self"] is not None)["self"]["lat"] == 55.9
        # `second` has left.
    # and so has `first`

    assert upstream.sessions == 1
    # The connection is the server's, not the clients': it is still up with
    # nobody watching, and still holding the picture.
    assert runtime.signalk().snapshot()["status"] == "connected"
    assert runtime.signalk().snapshot()["self"] == {"id": SELF_ID, "lng": 12.6, "lat": 55.9}

    # A device arriving later gets the whole picture immediately, rather
    # than an empty sea until every vessel next reports.
    with client.websocket_connect("/signalk/stream") as third:
        assert receive_json(third)["self"] == {"id": SELF_ID, "lng": 12.6, "lat": 55.9}
    assert upstream.sessions == 1


def test_disabled_signalk_streams_off(app_client: Any) -> None:
    client, _ = app_client  # conftest leaves signalk disabled
    from mivnav.collision.config import CollisionConfig
    from mivnav.gnss.config import GnssConfig
    from mivnav.shallow.config import ShallowConfig

    off = {
        "status": "off",
        "self": None,
        "targets": [],
        "autopilot": None,
        "course": None,
        # The boat's collision settings ride on every snapshot, off or not.
        "collisionSettings": CollisionConfig().model_dump(mode="json"),
        "gnssSettings": GnssConfig().model_dump(mode="json"),
        # ... and the shallow-water alarm's.
        "shallowSettings": ShallowConfig().model_dump(mode="json"),
    }
    with client.websocket_connect("/signalk/stream") as ws:
        assert receive_json(ws) == off
    assert client.get("/signalk/state").json() == off


def test_an_unreachable_box_leaves_the_chart_service_alone(app_client: Any) -> None:
    """The chart service stays independent of SignalK. A dead
    SignalK box must never take the chart plotter down."""
    client, runtime = app_client
    dead = FakeSignalK().start()
    port = dead.port
    dead.stop()
    runtime.patch_config({"signalk": {"enabled": True, "host": "127.0.0.1", "port": port}})

    # The connection is flapping…
    with client.websocket_connect("/signalk/stream") as ws:
        assert receive_json(ws)["status"] == "connecting"

        # …and the charts are entirely unaffected.
        assert client.get("/healthz").status_code == 200
        catalog = client.get("/catalog").json()["sets"]
        assert [s["id"] for s in catalog] == ["US5OAKIQ"]
        chart = catalog[0]
        x, y = center_tile(chart["bounds"], chart["min_zoom"])
        tile = client.get(f"/tiles/{chart['id']}/{chart['min_zoom']}/{x}/{y}")
        assert tile.status_code == 200
        assert tile.headers["content-type"] == "application/vnd.mapbox-vector-tile"


def test_editing_the_host_moves_the_connection_with_no_restart(app_client: Any) -> None:
    """The Derived invalidation, which is the one thing here that would
    fail *silently*: a config UI that reports success and changes nothing.

    Proven the hard way — through a client that was already connected, so
    it covers the rebuild, the settling that makes it happen without
    another request, and the client's re-subscription to the replacement.
    """
    client, runtime = app_client
    first = FakeSignalK(self_id="boat-a").start()
    second = FakeSignalK(self_id="boat-b").start()
    try:
        enable(runtime, first)
        with client.websocket_connect("/signalk/stream") as ws:
            wait_for(ws, lambda s: s["status"] == "connected")
            first.broadcast(first.position(1.0, 1.0))
            wait_for(ws, lambda s: s["self"] == {"id": "boat-a", "lng": 1.0, "lat": 1.0})

            # The user edits the host in the UI. Nothing restarts.
            response = client.patch("/config", json={"signalk": {"port": second.port}})
            assert response.status_code == 200
            assert response.json()["meta"]["signalk_url"].startswith(
                f"ws://127.0.0.1:{second.port}/"
            )

            # The new box is dialled straight away — not on some later
            # request that happens to touch the connection.
            second.wait_sessions(1)
            second.broadcast(second.position(2.0, 2.0))
            # …and the already-connected client follows it across.
            wait_for(ws, lambda s: s["self"] == {"id": "boat-b", "lng": 2.0, "lat": 2.0})

        assert first.sessions == 1  # the old box was never re-dialled
        assert runtime.signalk().url is not None
        assert f":{second.port}/" in runtime.signalk().url
    finally:
        first.stop()
        second.stop()


def test_adding_an_extra_path_resubscribes_and_reaches_a_connected_client(
    app_client: Any, upstream: FakeSignalK
) -> None:
    """The config-driven end of it, through a client that was already
    connected: PATCHing a new dashboard path rebuilds the connection (option
    b — a clean full re-subscribe, the same path a host edit takes), the new
    session asks for the path, and its raw value reaches the client that
    never re-requested anything."""
    client, runtime = app_client
    enable(runtime, upstream)
    with client.websocket_connect("/signalk/stream") as ws:
        wait_for(ws, lambda s: s["status"] == "connected")

        # A device adds a widget → PATCHes the boat-wide path list.
        response = client.patch(
            "/config",
            json={"signalk": {"extra_paths": ["electrical.batteries.house.voltage"]}},
        )
        assert response.status_code == 200

        # The connection rebuilt and the new session asks for the path.
        upstream.wait_sessions(2)
        wait_until(
            lambda: any(
                "electrical.batteries.house.voltage"
                in {s["path"] for s in sub["subscribe"]}
                for sub in upstream.subscriptions
            )
        )
        wait_for(ws, lambda s: s["status"] == "connected")  # reconnected

        # …and the raw value passes through to the already-connected client.
        upstream.broadcast(
            upstream.delta([("electrical.batteries.house.voltage", 12.6)])
        )
        got = wait_for(ws, lambda s: "paths" in s)
        assert got["paths"]["electrical.batteries.house.voltage"]["value"] == 12.6


def test_a_wildcard_extra_path_is_a_hard_config_error(app_client: Any) -> None:
    """The Pi-CPU rule, enforced at the config door: `*` cannot be smuggled
    in through extra_paths any more than through the curated list."""
    client, _ = app_client
    response = client.patch("/config", json={"signalk": {"extra_paths": ["*"]}})
    assert response.status_code == 422


def test_turning_signalk_off_at_runtime_reaches_a_connected_client(
    app_client: Any, upstream: FakeSignalK
) -> None:
    client, runtime = app_client
    enable(runtime, upstream)
    with client.websocket_connect("/signalk/stream") as ws:
        wait_for(ws, lambda s: s["status"] == "connected")
        assert client.patch("/config", json={"signalk": {"enabled": False}}).status_code == 200
        wait_for(ws, lambda s: s["status"] == "off")
