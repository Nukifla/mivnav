# SPDX-License-Identifier: GPL-2.0-only
"""Publishing the followed ROUTE to SignalK's v2 Course/Resources APIs
(#yprzuqtt).

This thing tells an autopilot where to steer, so the claims worth proving
are the wire (the right URLs, bodies and header reach the box — TWO base
URLs now, course and resources, not one), the never-break-GO rule (a
publish that fails — no token, SignalK down, disabled — must never unwind a
GO the store already committed), and the one thing #yprzuqtt turns on:
after an arrival-advance, the new leg's ``previousPoint`` is the waypoint
just arrived at (from the registered route's OWN data), never the vessel's
live position.

The client half runs against a real fake Course/Resources API over loopback
(see tests/fake_course.py); the publish and API halves run through the
*real* config store and route store, so the credential lookup, the URL
derivation and the waypoint resolution are exercised rather than stubbed
past.

**#zsswlmpz added two things.** First, the wire contract this client
*assumes* is now written down as one explicit table
(:func:`test_the_whole_wire_contract_in_one_table`) plus the URL derivation
that feeds it, so comparing it against the boat's real SignalK is a diff
against a stated expectation rather than against nobody's. NOTHING here
proves the live box agrees — the fake is faithful to the published API and
to a source read, and that is all it can be; see
:mod:`mivnav.features.route.client`'s Verification note for what is still
open. Second, "swallowed" no longer means "silent": every publish returns a
:class:`~mivnav.features.route.publish.PublishResult` and logs a traceback
on failure, both pinned below.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mivnav.config.model import SignalKConfig
from mivnav.features.route.client import CourseClient, CourseError
from mivnav.features.route.publish import advance_active_route, publish_active_leg
from mivnav.features.route.store import ActiveLeg, RouteError, validate_id
from tests.conftest import isolated_runtime_at
from tests.fake_course import TOKEN, FakeCourse

ROUTE = {
    "name": "Home",
    "waypoints": [
        {"id": "w1", "name": "Fairway", "lat": 37.795, "lon": -122.28},
        {"id": "w2", "name": "Turn", "lat": 37.80, "lon": -122.30},
        {"id": "w3", "name": "Berth", "lat": 37.81, "lon": -122.32},
    ],
}


@pytest.fixture
def course() -> Iterator[FakeCourse]:
    fake = FakeCourse().start()
    yield fake
    fake.stop()


def client_for(course: FakeCourse, token: str | None = TOKEN) -> CourseClient:
    return CourseClient(course.base_url, course.resources_url, token)


# -- the client: the wire ---------------------------------------------------


RESOURCE = {
    "name": "Home",
    "feature": {
        "type": "Feature",
        "geometry": {
            "type": "LineString",
            # GeoJSON axis order: [lon, lat], not this app's (lat, lon).
            "coordinates": [[-122.28, 37.795], [-122.30, 37.80], [-122.32, 37.81]],
        },
        "properties": {},
    },
}


def test_the_resource_store_round_trips_one_route(course: FakeCourse) -> None:
    # Since #vozswkrl these four verbs ARE route persistence — not a
    # write-only "register what we are following" side channel.
    client = client_for(course)
    assert client.list_route_resources() == {}
    assert client.get_route_resource("r1") is None

    client.put_route_resource("r1", RESOURCE)
    method, path, body = course.requests[-1]
    assert (method, path, body) == ("PUT", "/signalk/v2/api/resources/routes/r1", RESOURCE)
    assert client.get_route_resource("r1") == RESOURCE
    assert client.list_route_resources() == {"r1": RESOURCE}

    assert client.delete_route_resource("r1") is True
    assert course.requests[-1][:2] == ("DELETE", "/signalk/v2/api/resources/routes/r1")
    assert client.delete_route_resource("r1") is False  # reports the truth
    assert client.list_route_resources() == {}


def test_activate_route_points_at_the_registered_resource(course: FakeCourse) -> None:
    client = client_for(course)
    client.put_route_resource("r1", RESOURCE)
    client.activate_route("r1", 1)
    method, path, body = course.requests[-1]
    assert method == "PUT"
    assert path == "/signalk/v2/api/vessels/self/navigation/course/activeRoute"
    assert body == {"href": "/resources/routes/r1", "pointIndex": 1, "reverse": False}
    assert course.active_route is not None
    assert course.active_route["pointIndex"] == 1


def test_activate_route_without_registering_first_raises(course: FakeCourse) -> None:
    # The real server 400s: activeRoute.href must resolve to a registered
    # resource. A wrong base URL (resources vs. course) would show up here
    # as exactly this failure — see fake_course.py's module docstring.
    with pytest.raises(CourseError):
        client_for(course).activate_route("ghost", 0)


def test_advance_next_point_carries_no_position(course: FakeCourse) -> None:
    client = client_for(course)
    client.put_route_resource("r1", RESOURCE)
    client.activate_route("r1", 0)
    client.advance_next_point()
    method, path, body = course.requests[-1]
    assert method == "PUT"
    assert path == "/signalk/v2/api/vessels/self/navigation/course/activeRoute/nextPoint"
    assert body == {}


def test_advancing_derives_the_new_leg_from_the_route_not_the_vessel(course: FakeCourse) -> None:
    # THE load-bearing claim (#yprzuqtt): after stepping w1 -> w2, the new
    # leg's previousPoint is w1's EXACT stored coordinate, not wherever the
    # boat happened to be at the moment of arrival. This fake has no notion
    # of a vessel position at all (see its module docstring) — there is
    # nothing it COULD derive previousPoint from except the route's own
    # data, so this is the assertion that the wire the client sends is
    # actually the activeRoute/nextPoint verb and not some bare-destination
    # substitute that would silently need a vessel fix instead.
    client = client_for(course)
    client.put_route_resource("r1", RESOURCE)
    client.activate_route("r1", 0)
    assert course.previous_point is None  # index 0: the real server would use the vessel

    client.advance_next_point()
    assert course.next_point == {"latitude": 37.80, "longitude": -122.30}  # w2
    assert course.previous_point == {"latitude": 37.795, "longitude": -122.28}  # w1, exactly

    client.advance_next_point()
    assert course.next_point == {"latitude": 37.81, "longitude": -122.32}  # w3
    assert course.previous_point == {"latitude": 37.80, "longitude": -122.30}  # w2, exactly


def test_clear_deletes_the_course_root(course: FakeCourse) -> None:
    client = client_for(course)
    client.put_route_resource("r1", RESOURCE)
    client.activate_route("r1", 0)
    client.clear_destination()
    method, path, body = course.requests[-1]
    assert method == "DELETE"
    assert path == "/signalk/v2/api/vessels/self/navigation/course"
    assert body is None
    assert course.active_route is None


# -- the client: fail loud (the boundary swallows, not this) ----------------


def test_a_rejected_token_raises(course: FakeCourse) -> None:
    with pytest.raises(CourseError):
        client_for(course, token="wrong").put_route_resource("r1", RESOURCE)
    assert course.resources == {}


def test_signalk_disabled_raises_rather_than_silently_no_ops(course: FakeCourse) -> None:
    with pytest.raises(CourseError):
        CourseClient(None, None, TOKEN).activate_route("r1", 0)


def test_a_dead_server_fails_fast_and_does_not_queue(course: FakeCourse) -> None:
    course_url, resources_url = course.base_url, course.resources_url
    course.stop()
    client = CourseClient(course_url, resources_url, TOKEN, timeout=1.0)
    with pytest.raises(CourseError):
        client.put_route_resource("r1", RESOURCE)


def test_a_failed_body_under_200_is_not_read_as_success(course: FakeCourse) -> None:
    course.fail_with = (200, {"state": "FAILED", "statusCode": 400, "message": "no fix"})
    with pytest.raises(CourseError) as e:
        client_for(course).put_route_resource("r1", RESOURCE)
    assert "no fix" in str(e.value)


# -- publish: registers + activates, clears on stop, swallows failure -------


@pytest.fixture
def runtime_with_course(tmp_path: Path, course: FakeCourse):
    """An isolated runtime pointed at the fake course, with a route saved.

    Exercises the whole seam the API uses: config-driven URL derivation, a
    live token, and waypoint resolution out of the real route store.
    """

    def build(token: str | None = TOKEN, enabled: bool = True):
        runtime = isolated_runtime_at(tmp_path)
        # Saving the route is what puts it ON the box now (#vozswkrl), so the
        # seeding has to happen against a working connection whatever this
        # particular test then breaks. The variation (no token, SignalK off)
        # is applied afterwards, and the recorded traffic is reset, so a test
        # can still say "nothing was published" and mean it.
        runtime.config.patch(
            {
                "signalk": {"enabled": True, "host": "127.0.0.1", "port": course.port},
                "credentials": {"signalk": {"token": TOKEN}},
            }
        )
        runtime.routes.save("r1", ROUTE)
        course.requests.clear()
        course.authorizations.clear()
        runtime.config.patch(
            {"signalk": {"enabled": enabled}, "credentials": {"signalk": {"token": token or ""}}}
        )
        return runtime

    runtimes = []

    def make(**kw):
        rt = build(**kw)
        runtimes.append(rt)
        return rt

    yield make
    for rt in runtimes:
        rt.close()


def test_go_registers_and_activates_at_the_chosen_waypoints_index(
    runtime_with_course, course
) -> None:
    runtime = runtime_with_course()
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w2"))
    assert course.resources["r1"]["feature"]["geometry"]["coordinates"] == [
        [-122.28, 37.795],
        [-122.30, 37.80],
        [-122.32, 37.81],
    ]
    assert course.active_route is not None
    assert course.active_route["pointIndex"] == 1  # w2 is index 1


def test_go_on_the_first_waypoint_activates_at_index_zero(runtime_with_course, course) -> None:
    runtime = runtime_with_course()
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))
    assert course.active_route is not None
    assert course.active_route["pointIndex"] == 0


def test_stop_clears_the_course(runtime_with_course, course) -> None:
    runtime = runtime_with_course()
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))
    assert course.active_route is not None
    publish_active_leg(runtime, None)
    assert course.active_route is None


def test_advance_active_route_issues_only_the_lightweight_step(
    runtime_with_course, course
) -> None:
    # The arrival reaction (mivnav.features.route.watcher): no re-publish, no
    # waypoint resolution — one PUT, carrying nothing.
    runtime = runtime_with_course()
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))
    before = len(course.requests)
    advance_active_route(runtime)
    assert len(course.requests) == before + 1
    method, path, body = course.requests[-1]
    assert (method, path, body) == (
        "PUT",
        "/signalk/v2/api/vessels/self/navigation/course/activeRoute/nextPoint",
        {},
    )
    assert course.active_route["pointIndex"] == 1


def test_no_token_publishes_nothing_and_does_not_error(runtime_with_course, course) -> None:
    # The gate: no token → cannot write → skip quietly. Not even a 401's
    # worth of traffic reaches the box.
    runtime = runtime_with_course(token=None)
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))
    assert course.requests == []
    advance_active_route(runtime)
    assert course.requests == []


def test_signalk_disabled_publishes_nothing_and_does_not_error(runtime_with_course, course) -> None:
    runtime = runtime_with_course(enabled=False)
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))
    assert course.requests == []


def test_a_dead_box_does_not_raise_out_of_publish(runtime_with_course, course) -> None:
    # The whole point: the store write already happened; a failed publish is
    # logged and swallowed, never re-raised.
    runtime = runtime_with_course()
    course.stop()
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))  # must not raise
    advance_active_route(runtime)  # must not raise either


def test_a_reversed_route_still_resolves_the_right_index(runtime_with_course, course) -> None:
    # mivnav reverses a route by reordering its stored waypoints (same ids),
    # never via SignalK's own `reverse` flag (always sent False) — so the
    # activated pointIndex must track the NEW order.
    runtime = runtime_with_course()
    reversed_route = {
        "name": "Home",
        "waypoints": [
            {"id": "w3", "name": "Berth", "lat": 37.81, "lon": -122.32},
            {"id": "w2", "name": "Turn", "lat": 37.80, "lon": -122.30},
            {"id": "w1", "name": "Fairway", "lat": 37.795, "lon": -122.28},
        ],
    }
    runtime.routes.save("r1", reversed_route)
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))
    assert course.active_route["pointIndex"] == 2  # w1 is now the LAST index
    assert course.active_route["reverse"] is False


# -- through the API: GO publishes, and a dead box still lets GO succeed ----


@pytest.fixture
def api(tmp_path: Path, course: FakeCourse) -> Iterator[Callable]:
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    # Restore whatever override was there before (the session `client`
    # fixture's own, set by conftest.py's autouse `isolated_runtime`) rather
    # than popping unconditionally — an unconditional pop strands every
    # later test with no get_runtime override at all (same bug class as
    # vyvqpxmn; see test_datasets_api.py's `dc` fixture).
    previous = app.dependency_overrides.get(get_runtime)
    runtimes = []

    def wired(token: str | None = TOKEN) -> TestClient:
        runtime = isolated_runtime_at(tmp_path)
        runtimes.append(runtime)
        patch: dict[str, Any] = {
            "signalk": {"enabled": True, "host": "127.0.0.1", "port": course.port},
            "credentials": {"signalk": {"token": token or ""}},
        }
        runtime.config.patch(patch)
        app.dependency_overrides[get_runtime] = lambda: runtime
        client = TestClient(app)
        # This PUT is itself a write to SignalK now — the route has to reach
        # the box before anything can be activated against it.
        assert client.put("/routes/r1", json=ROUTE).status_code == 200
        return client

    yield wired
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous
    for runtime in runtimes:
        runtime.close()


def test_pressing_go_over_http_registers_and_activates(api: Callable, course: FakeCourse) -> None:
    client = api()
    resp = client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w2"})
    assert resp.status_code == 200
    assert resp.json()["active"] == {"route_id": "r1", "waypoint_id": "w2"}
    assert course.active_route["pointIndex"] == 1


def test_clearing_go_over_http_clears_the_course(api: Callable, course: FakeCourse) -> None:
    client = api()
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w1"})
    assert course.active_route is not None
    resp = client.put("/routes/active", json=None)
    assert resp.status_code == 200
    assert course.active_route is None


def test_a_dead_signalk_box_does_not_break_go(api: Callable, course: FakeCourse) -> None:
    client = api()
    course.stop()
    resp = client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w1"})
    assert resp.status_code == 200
    assert resp.json()["active"] == {"route_id": "r1", "waypoint_id": "w1"}


# -- editing the followed route re-publishes it (the mid-follow sync fix) ----


def test_editing_the_followed_route_republishes_the_new_geometry(
    api: Callable, course: FakeCourse
) -> None:
    # SAFETY: moving the target waypoint while following must re-register
    # the route (new coordinates) and re-activate at the SAME index, so the
    # autopilot steers to where the mark is now.
    client = api()
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w2"})
    assert course.next_point == {"latitude": 37.80, "longitude": -122.30}
    # Move w2 to a new position and save.
    moved = {
        "name": "Home",
        "waypoints": [
            {"id": "w1", "name": "Fairway", "lat": 37.795, "lon": -122.28},
            {"id": "w2", "name": "Turn", "lat": 37.90, "lon": -122.40},
            {"id": "w3", "name": "Berth", "lat": 37.81, "lon": -122.32},
        ],
    }
    resp = client.put("/routes/r1", json=moved)
    assert resp.status_code == 200
    assert course.next_point == {"latitude": 37.90, "longitude": -122.40}
    assert course.active_route["pointIndex"] == 1  # still w2's index


def _course_requests(course: FakeCourse) -> list[tuple[str, str, Any]]:
    """Only the COURSE traffic. Saving a route is itself a request to the box
    now (to the *resources* root), so "did this publish?" can no longer be
    answered by counting requests — it has to name the root."""
    return [r for r in course.requests if "/navigation/course" in r[1]]


def test_editing_a_non_followed_route_does_not_publish(
    api: Callable, course: FakeCourse
) -> None:
    # Following r1; saving an edit to r2 must publish nothing.
    client = api()
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w2"})
    before = len(_course_requests(course))
    other = {
        "name": "Other",
        "waypoints": [
            {"id": "x1", "name": "A", "lat": 10.0, "lon": 20.0},
            {"id": "x2", "name": "B", "lat": 11.0, "lon": 21.0},
        ],
    }
    resp = client.put("/routes/r2", json=other)
    assert resp.status_code == 200
    # No COURSE traffic for a non-followed route (the route itself was of
    # course stored — that is what saving it means).
    assert len(_course_requests(course)) == before
    assert "r2" in course.resources


def test_editing_with_nothing_followed_does_not_publish(
    api: Callable, course: FakeCourse
) -> None:
    # No active leg at all: an edit is just a save, no course traffic.
    client = api()
    before = len(_course_requests(course))
    resp = client.put("/routes/r1", json=ROUTE)
    assert resp.status_code == 200
    assert len(_course_requests(course)) == before


def test_a_dead_box_refuses_the_save_rather_than_pretending(
    api: Callable, course: FakeCourse
) -> None:
    """This one INVERTED at #vozswkrl, and the inversion is the decision.

    It used to assert that a save survived a dead box, because the save
    landed in a local routes.json and only the publish needed SignalK. Now
    the box IS the store, so a save it did not take did not happen — and the
    chosen policy is to say so (503), not to accept the edit and reconcile
    later. The boat is not stranded by that: the route it is FOLLOWING is
    still in memory and still on the screen, which the next assertion is.
    """
    client = api()
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w2"})
    course.stop()
    moved = {
        "name": "Home",
        "waypoints": [
            {"id": "w1", "name": "Fairway", "lat": 37.795, "lon": -122.28},
            {"id": "w2", "name": "Turn", "lat": 37.90, "lon": -122.40},
            {"id": "w3", "name": "Berth", "lat": 37.81, "lon": -122.32},
        ],
    }
    resp = client.put("/routes/r1", json=moved)
    assert resp.status_code == 503
    assert "NOT saved" in resp.json()["detail"]

    listed = client.get("/routes").json()
    assert listed["stale"] is True  # said out loud, not implied by silence
    assert listed["routes"][0]["waypoints"][1]["lat"] == 37.80  # the pre-edit mark
    assert listed["active"] == {"route_id": "r1", "waypoint_id": "w2"}


# -- the wire contract, written down (#zsswlmpz) ----------------------------
#
# The task these came from: `client.py`'s contract was written from a source
# read, never checked against the boat's real SignalK, and `publish.py`
# swallowed every failure — so if the contract is wrong, publishing has been
# dead since #yprzuqtt and nothing said so. The half that can be done without
# the boat is this: state the contract explicitly, so checking it against the
# live box is a diff against something, and make a failure impossible to miss.


#: Every request mivnav makes to a SignalK box for a followed route, in the
#: order it makes them, as ONE table. This is the artefact to compare
#: against a live box: run the same three calls against the boat's server
#: (see the commit message for #zsswlmpz) and diff its access log against
#: this. A change here is a change to what mivnav asks of SignalK.
COURSE_BASE = "/signalk/v2/api/vessels/self/navigation/course"
RESOURCES_BASE = "/signalk/v2/api/resources"


def test_the_whole_wire_contract_in_one_table(runtime_with_course, course, monkeypatch) -> None:
    runtime = runtime_with_course()
    course.requests.clear()
    course.authorizations.clear()
    # A fixed clock so the one server-owned timestamp in the body is an
    # assertable constant rather than "whenever this ran".
    monkeypatch.setattr("mivnav.features.route.store.time.time", lambda: 1_700_000_000.0)

    runtime.routes.save("r1", ROUTE)  # drawing/saving a route
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))  # GO
    advance_active_route(runtime)  # an arrival
    publish_active_leg(runtime, None)  # Stop

    assert course.requests == [
        # 1. STORE the route. This is a save, not a publish (#vozswkrl):
        #    SignalK's resource store IS mivnav's route store, so this
        #    request happens when a human draws or edits a route, and it
        #    carries the WHOLE route — GeoJSON axis order ([lon, lat]),
        #    every waypoint, wrapped in {"name", "feature"}.
        #
        #    `feature.properties.mivnav` is the accepted cost of the single
        #    store: SignalK's route resource has nowhere for per-waypoint
        #    ids/names, a planning speed, the If-Match `rev` or `updated`.
        #    A reader that ignores `properties` entirely still sees a
        #    complete route, which is how other apps degrade gracefully —
        #    see mivnav.features.route.wire.
        (
            "PUT",
            f"{RESOURCES_BASE}/routes/r1",
            {
                "name": "Home",
                "feature": {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [-122.28, 37.795],
                            [-122.30, 37.80],
                            [-122.32, 37.81],
                        ],
                    },
                    "properties": {
                        "mivnav": {
                            "version": 1,
                            "waypoints": [
                                {"id": "w1", "name": "Fairway", "stop": False},
                                {"id": "w2", "name": "Turn", "stop": False},
                                {"id": "w3", "name": "Berth", "stop": False},
                            ],
                            "plan_speed_kn": 5.0,
                            "rev": 2,
                            "updated": 1_700_000_000.0,
                        }
                    },
                },
            },
        ),
        # 2. Activate it at an index — and NOTHING else. There is no
        #    re-registration on GO any more: the route is already on the box,
        #    because that is what saving it means. `href` is the SHORT
        #    resource reference the server's own parseHref expects, NOT the
        #    full v2 API URL, and `reverse` is always False (mivnav reorders
        #    its own stored waypoints instead).
        (
            "PUT",
            f"{COURSE_BASE}/activeRoute",
            {"href": "/resources/routes/r1", "pointIndex": 0, "reverse": False},
        ),
        # 3. An arrival: step on by one, carrying NOTHING — no position, not
        #    even a `value` (the server defaults it to +1).
        ("PUT", f"{COURSE_BASE}/activeRoute/nextPoint", {}),
        # 4. Stop: DELETE the course ROOT, not `/destination`.
        ("DELETE", COURSE_BASE, None),
    ]
    # Bearer on every one of them, including the resources root — which is a
    # DIFFERENT REST root, and so a separate chance for the boat's security
    # config to refuse us. That root matters more than it used to: a box that
    # refuses it does not merely fail to publish, it cannot store a route.
    assert course.authorizations == [f"Bearer {TOKEN}"] * 4


def test_the_other_two_store_verbs_are_on_the_same_root(runtime_with_course, course) -> None:
    """The table above is one passage's worth of traffic; reading the routes
    back and deleting one are the two requests it does not contain."""
    runtime = runtime_with_course()
    course.requests.clear()
    runtime.routes.refresh()
    runtime.routes.delete("r1")
    assert [(m, p) for m, p, _ in course.requests] == [
        ("GET", f"{RESOURCES_BASE}/routes"),
        ("DELETE", f"{RESOURCES_BASE}/routes/r1"),
    ]


def test_the_two_base_urls_come_from_one_host() -> None:
    # The other half of the wire contract: what the paths above hang off.
    # `resources` is NOT vessel-scoped and `course` is — getting that
    # backwards is exactly the failure mode this task suspects, and it would
    # show up on the box as a 404 on the resource PUT followed by an
    # unresolvable-href 400 on every activation.
    signalk = SignalKConfig(enabled=True, host="10.10.0.5", port=3000)
    assert signalk.resources_url == "http://10.10.0.5:3000/signalk/v2/api/resources"
    assert signalk.course_url == (
        "http://10.10.0.5:3000/signalk/v2/api/vessels/self/navigation/course"
    )
    # One host, one scheme decision, for both.
    tls = SignalKConfig(enabled=True, host="10.10.0.5", port=3000, tls=True)
    assert tls.resources_url.startswith("https://10.10.0.5:3000/")
    assert tls.course_url.startswith("https://10.10.0.5:3000/")


def test_a_route_id_is_url_safe_so_the_resource_path_needs_no_quoting() -> None:
    # `client.set_route` interpolates the id straight into
    # f"/routes/{route_id}" with no quoting. That is only safe because the
    # store refuses anything that is not a bare URL path segment — pinned
    # here, because the day that regex loosens, this client starts sending
    # malformed paths to the box and (before #zsswlmpz) would have said
    # nothing about it.
    for bad in ("a/b", "a b", "a#b", "a?b", "..", "", "a%2Fb"):
        with pytest.raises(RouteError):
            validate_id(bad)
    assert validate_id("f1e2d3c4-5a6b_7") == "f1e2d3c4-5a6b_7"


def test_a_refusal_names_the_verb_and_the_url_that_failed(course: FakeCourse) -> None:
    # Two REST roots, four paths: "SignalK refused the course update" was not
    # enough to tell a log reader WHICH request the box rejected, which is
    # the first question when the contract itself is what is in doubt.
    course.fail_with = (400, {"state": "FAILED", "statusCode": 400, "message": "no such resource"})
    with pytest.raises(CourseError) as e:
        client_for(course).put_route_resource("r1", RESOURCE)
    message = str(e.value)
    assert "PUT" in message
    assert f"{RESOURCES_BASE}/routes/r1" in message
    assert "no such resource" in message


def test_an_unreachable_box_names_the_verb_too() -> None:
    client = CourseClient(
        "http://127.0.0.1:9/signalk/v2/api/vessels/self/navigation/course",
        "http://127.0.0.1:9/signalk/v2/api/resources",
        TOKEN,
        timeout=1.0,
    )
    with pytest.raises(CourseError) as e:
        client.advance_next_point()
    assert "PUT" in str(e.value)


# -- swallowed is not silent (#zsswlmpz) ------------------------------------


def test_a_publish_reports_what_it_did(runtime_with_course, course) -> None:
    runtime = runtime_with_course()
    result = publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w2"))
    assert result.outcome == "published"
    assert not result.failed
    assert "point 1 of 3" in result.detail

    assert advance_active_route(runtime).outcome == "advanced"
    assert publish_active_leg(runtime, None).outcome == "cleared"


def test_a_skip_is_reported_as_a_skip_not_a_success(runtime_with_course, course) -> None:
    # The two gates that never touch the network. Distinguishing these from
    # a failure is the point: "nothing to publish to" is a configuration
    # state a sailor chose, not a broken box.
    no_token = publish_active_leg(runtime_with_course(token=None), ActiveLeg(route_id="r1", waypoint_id="w1"))
    assert no_token.outcome == "skipped"
    assert "token" in no_token.detail

    disabled = publish_active_leg(runtime_with_course(enabled=False), ActiveLeg(route_id="r1", waypoint_id="w1"))
    assert disabled.outcome == "skipped"
    assert "disabled" in disabled.detail
    assert course.requests == []


def test_a_dead_box_reports_a_failure_and_logs_a_traceback(
    runtime_with_course, course, caplog
) -> None:
    # THE regression this task is about: the publish still must not raise
    # (the GO is committed), but it must leave a trace a human can act on.
    runtime = runtime_with_course()
    course.stop()
    with caplog.at_level(logging.DEBUG):
        result = publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))
    assert result.failed
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert errors, "a publish that never reached SignalK left nothing in the log"
    assert any(r.exc_info for r in errors), "logged without the traceback that names the cause"


def test_a_failed_arrival_advance_logs_a_traceback_too(
    runtime_with_course, course, caplog
) -> None:
    # The watcher thread has no HTTP caller to report to, so for THIS call
    # site the log is the only surface there is.
    runtime = runtime_with_course()
    publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))
    course.stop()
    with caplog.at_level(logging.DEBUG):
        result = advance_active_route(runtime)
    assert result.failed
    assert any(r.exc_info for r in caplog.records if r.levelno >= logging.ERROR)


def test_a_vanished_waypoint_is_a_failure_not_a_quiet_return(runtime_with_course, course) -> None:
    # The leg settled under the store lock but the waypoint is gone by the
    # time we resolve it. Nothing is published (correctly — a phantom leg
    # would be worse), but the caller is told, and so is the log.
    runtime = runtime_with_course()
    result = publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="ghost"))
    assert result.failed
    assert "ghost" in result.detail
    assert course.requests == []


def test_an_unexpected_error_is_swallowed_as_well_as_a_course_error(
    runtime_with_course, course, monkeypatch
) -> None:
    # Before #zsswlmpz only CourseError was caught, so anything else — a bug
    # here, an httpx exception outside HTTPError — escaped into a
    # PUT /routes/active whose store write had already committed. Now the
    # never-break-a-GO rule holds for every exception, not one class of it.
    def boom(*args: Any, **kwargs: Any) -> None:
        raise ValueError("something nobody predicted")

    monkeypatch.setattr(CourseClient, "activate_route", boom)
    runtime = runtime_with_course()
    result = publish_active_leg(runtime, ActiveLeg(route_id="r1", waypoint_id="w1"))
    assert result.failed
    assert "something nobody predicted" in result.detail
