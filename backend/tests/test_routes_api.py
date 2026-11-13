# SPDX-License-Identifier: GPL-2.0-only
"""/routes over HTTP.

The load-bearing test here is `test_a_route_drawn_on_one_device_is_on_the_other`:
routes are boat data, and the whole reason this store exists rather than
localStorage is that a route drawn on the phone in the cockpit must be on
the screen at the nav station. Everything else is detail.

Since #vozswkrl "the server" is not the last stop: routes are persisted on
SignalK and nowhere else, so every test here runs against a real fake
SignalK box over loopback (tests/fake_course.py) rather than a temp file.
That is not ceremony — with SignalK unreachable these endpoints legitimately
answer 503, which is its own test at the bottom.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import Runtime, get_runtime

from conftest import isolated_runtime_at
from fake_course import TOKEN, FakeCourse

HOME = {
    "name": "Home",
    "waypoints": [
        {"id": "w1", "name": "Fairway", "lat": 37.795, "lon": -122.28},
        {"id": "w2", "name": "Turn", "lat": 37.80, "lon": -122.30},
        {"id": "w3", "name": "Berth", "lat": 37.81, "lon": -122.32},
    ],
}


@pytest.fixture()
def box() -> Iterator[FakeCourse]:
    fake = FakeCourse().start()
    yield fake
    fake.stop()


def runtime_against(root: Path, box: FakeCourse) -> Runtime:
    runtime = isolated_runtime_at(root)
    runtime.config.patch(
        {
            "signalk": {"enabled": True, "host": "127.0.0.1", "port": box.port},
            "credentials": {"signalk": {"token": TOKEN}},
        }
    )
    return runtime


@pytest.fixture()
def runtime(tmp_path: Path, box: FakeCourse) -> Runtime:
    return runtime_against(tmp_path, box)


@pytest.fixture()
def client(runtime: Runtime) -> Iterator[TestClient]:
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_runtime] = lambda: runtime
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)
    runtime.close()


def test_a_route_drawn_on_one_device_is_on_the_other(client: TestClient) -> None:
    """The point of the whole chunk. Two clients, one boat, one server —
    no shared browser storage anywhere in the picture."""
    phone = client.put("/routes/r1", json=HOME)
    assert phone.status_code == 200

    nav_station = client.get("/routes").json()
    assert [r["name"] for r in nav_station["routes"]] == ["Home"]
    assert [w["name"] for w in nav_station["routes"][0]["waypoints"]] == [
        "Fairway",
        "Turn",
        "Berth",
    ]
    assert nav_station["active"] is None


def test_the_route_survives_a_restart(client: TestClient, tmp_path: Path, box) -> None:
    """It survives because SignalK has it, not because this process wrote a
    file — which is also why a brand-new process on a DIFFERENT config
    directory still finds it."""
    client.put("/routes/r1", json=HOME)
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w2"})

    reborn = runtime_against(tmp_path / "a-fresh-config-dir", box)
    assert [r.name for r in reborn.routes.refresh()] == ["Home"]
    # The LEG is not in the resource store; SignalK holds it as the course,
    # and the nav watcher adopts it back on its first delta. A cold store
    # inventing one would be the inference invariant #8 forbids.
    assert reborn.routes.active() is None
    reborn.close()


def test_get_put_delete_one_route(client: TestClient) -> None:
    assert client.get("/routes/r1").status_code == 404

    put = client.put("/routes/r1", json=HOME)
    assert put.json()["id"] == "r1"
    assert put.json()["rev"] == 1
    assert put.headers["ETag"] == '"1"'

    got = client.get("/routes/r1")
    assert got.json()["name"] == "Home"
    assert got.headers["ETag"] == '"1"'

    assert client.delete("/routes/r1").status_code == 204
    assert client.delete("/routes/r1").status_code == 404
    assert client.get("/routes").json()["routes"] == []


def test_a_waypoints_stop_flag_round_trips(client: TestClient) -> None:
    """`Waypoint.stop` (frontend's From/Stop/To vs router-bend tag) is just
    another persisted field — put one route with a mix of stop/non-stop
    waypoints and confirm GET echoes the flags back, and that an omitted
    flag defaults `False` rather than erroring (an older client's PUT)."""
    route = {
        "name": "Mixed",
        "waypoints": [
            {"id": "w1", "name": "Home", "lat": 37.795, "lon": -122.28, "stop": True},
            {"id": "w2", "name": "Waypoint", "lat": 37.80, "lon": -122.30},
            {"id": "w3", "name": "Marina", "lat": 37.81, "lon": -122.32, "stop": True},
        ],
    }
    client.put("/routes/r1", json=route)

    got = client.get("/routes/r1").json()
    assert [w["stop"] for w in got["waypoints"]] == [True, False, True]


def test_a_retried_put_does_not_create_a_second_route(client: TestClient) -> None:
    """Why the client mints the id and this is a PUT: the boat's wifi is
    flaky, and a POST that minted server-side would leave two copies of
    the route behind on a retry."""
    for _ in range(3):
        client.put("/routes/r1", json=HOME)
    assert len(client.get("/routes").json()["routes"]) == 1


def test_a_fetched_route_can_be_edited_and_sent_straight_back(client: TestClient) -> None:
    client.put("/routes/r1", json=HOME)
    route = client.get("/routes/r1").json()  # carries id, rev, updated
    route["name"] = "Home again"
    put = client.put("/routes/r1", json=route)
    assert put.status_code == 200
    assert put.json()["name"] == "Home again"
    assert put.json()["rev"] == 2  # server-owned; the body's rev was ignored


def test_an_invalid_route_is_422(client: TestClient) -> None:
    bad = {"name": "X", "waypoints": [{"id": "w1", "lat": 91.0, "lon": 0.0}]}
    r = client.put("/routes/r1", json=bad)
    assert r.status_code == 422
    assert "lat" in r.json()["detail"]

    assert client.put("/routes/a b", json=HOME).status_code == 422
    assert client.put("/routes/r1", json={"id": "other", **HOME}).status_code == 422


# -- the active leg -------------------------------------------------------


def test_go_picks_a_waypoint_outright_and_nothing_advances_it(client: TestClient) -> None:
    """Invariant #8 over HTTP. There is no endpoint that advances a leg,
    and there must never be one: `GO` names the waypoint, and it stays
    named until a human names another."""
    client.put("/routes/r1", json=HOME)

    go = client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w3"})
    assert go.status_code == 200
    assert go.json()["active"] == {"route_id": "r1", "waypoint_id": "w3"}
    assert client.get("/routes").json()["active"]["waypoint_id"] == "w3"

    stop = client.put("/routes/active", json=None)
    assert stop.json()["active"] is None


def test_an_active_leg_that_does_not_exist_is_404(client: TestClient) -> None:
    client.put("/routes/r1", json=HOME)
    assert client.put("/routes/active", json={"route_id": "r9", "waypoint_id": "w1"}).status_code == 404
    assert client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w9"}).status_code == 404


def test_deleting_the_followed_route_stops_the_boat_following_it(client: TestClient) -> None:
    client.put("/routes/r1", json=HOME)
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w1"})
    client.delete("/routes/r1")
    assert client.get("/routes").json()["active"] is None


def test_deleting_the_followed_route_clears_the_signalk_course(
    client: TestClient, box: FakeCourse
) -> None:
    # Otherwise the autopilot keeps steering a route mivnav says it is not
    # following.
    client.put("/routes/r1", json=HOME)
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w2"})
    assert box.active_route is not None
    assert client.delete("/routes/r1").status_code == 204
    assert box.active_route is None


def test_deleting_another_route_leaves_the_signalk_course_alone(
    client: TestClient, box: FakeCourse
) -> None:
    client.put("/routes/r1", json=HOME)
    client.put("/routes/r2", json=HOME)
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w2"})
    client.delete("/routes/r2")
    assert box.active_route is not None
    assert client.get("/routes").json()["active"] == {"route_id": "r1", "waypoint_id": "w2"}


def test_saving_away_the_target_waypoint_clears_the_signalk_course(
    client: TestClient, box: FakeCourse
) -> None:
    client.put("/routes/r1", json=HOME)
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w3"})
    edited = {**HOME, "waypoints": HOME["waypoints"][:2]}  # w3 removed
    assert client.put("/routes/r1", json=edited).status_code == 200
    assert client.get("/routes").json()["active"] is None
    assert box.active_route is None


def test_a_route_deleted_by_another_signalk_client_clears_the_course(
    client: TestClient, box: FakeCourse
) -> None:
    client.put("/routes/r1", json=HOME)
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w2"})
    assert box.active_route is not None
    box.resources.pop("r1")  # deleted straight on Signal K, not through mivnav
    assert client.get("/routes").json()["active"] is None
    assert box.active_route is None


def test_go_reports_the_signalk_publish_outcome(client: TestClient, box: FakeCourse) -> None:
    client.put("/routes/r1", json=HOME)
    go = client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w2"})
    assert go.json()["publish"]["outcome"] == "published"

    box.fail_with = (500, {"message": "boom"})
    stop = client.put("/routes/active", json=None)
    assert stop.status_code == 200  # mivnav stopped following either way
    assert stop.json()["active"] is None
    assert stop.json()["publish"]["outcome"] == "failed"
    assert stop.json()["publish"]["detail"]


def test_the_active_url_is_not_shadowed_by_a_route_named_active(client: TestClient) -> None:
    # /routes/active is the leg, so the id is reserved — see RouteStore
    assert client.put("/routes/active", json=HOME).status_code == 422


# -- concurrency ----------------------------------------------------------


def test_if_match_makes_a_lost_edit_a_409_instead_of_silence(client: TestClient) -> None:
    client.put("/routes/r1", json=HOME)  # rev 1; both devices fetch it
    stale = client.get("/routes/r1")
    assert stale.headers["ETag"] == '"1"'

    fresh = client.put(
        "/routes/r1", json={"name": "nav station"}, headers={"If-Match": '"1"'}
    )
    assert fresh.status_code == 200
    assert fresh.headers["ETag"] == '"2"'

    lost = client.put(
        "/routes/r1", json={"name": "the phone"}, headers={"If-Match": stale.headers["ETag"]}
    )
    assert lost.status_code == 409
    assert client.get("/routes/r1").json()["name"] == "nav station"

    # re-read, re-apply
    ok = client.put(
        "/routes/r1", json={"name": "the phone"}, headers={"If-Match": '"2"'}
    )
    assert ok.status_code == 200


def test_if_match_guards_a_delete_too(client: TestClient) -> None:
    client.put("/routes/r1", json=HOME)
    assert client.delete("/routes/r1", headers={"If-Match": '"9"'}).status_code == 409
    assert client.delete("/routes/r1", headers={"If-Match": '"1"'}).status_code == 204


def test_without_if_match_it_is_last_write_wins(client: TestClient) -> None:
    client.put("/routes/r1", json=HOME)
    assert client.put("/routes/r1", json={"name": "later"}).status_code == 200
    assert client.get("/routes/r1").json()["name"] == "later"
    # and `*` means the same as saying nothing: "any current representation"
    assert client.put("/routes/r1", json={"name": "l8r"}, headers={"If-Match": "*"}).status_code == 200


def test_a_malformed_if_match_is_refused_rather_than_ignored(client: TestClient) -> None:
    """A client that meant to guard and typoed the header must not be told
    it succeeded — that is the silent overwrite the header exists to
    prevent."""
    client.put("/routes/r1", json=HOME)
    r = client.put("/routes/r1", json={"name": "x"}, headers={"If-Match": '"abc"'})
    assert r.status_code == 400
    assert client.get("/routes/r1").json()["name"] == "Home"


# -- it is its own store --------------------------------------------------


def test_routes_are_not_stored_on_this_server_at_all(
    client: TestClient, runtime: Runtime, box: FakeCourse
) -> None:
    """Routes are boat data, not a tunable — and since #vozswkrl not this
    server's data either. Nothing under the config directory records them:
    no routes.json, not a key in config.json, not a profile blob. The one
    copy is on SignalK."""
    client.put("/routes/r1", json=HOME)
    assert "r1" in box.resources
    config_dir = runtime.config.path.parent
    # config.json and credentials.json are the config's own two files; what
    # matters is that a route save added nothing beside them.
    assert sorted(p.name for p in config_dir.iterdir()) == ["config.json", "credentials.json"]
    assert client.get("/config").json()["config"].get("routes") is None
    assert client.get("/config/profiles").json()["profiles"] == []


def test_signalk_being_down_is_a_503_on_a_write_and_stale_on_a_read(
    client: TestClient, box: FakeCourse
) -> None:
    """The offline policy at the HTTP boundary. A write refuses loudly; a
    read keeps working off the mirror and admits it is not fresh, because
    taking the followed route off the screen the moment the box hiccups is
    the one thing a plotter must not do."""
    client.put("/routes/r1", json=HOME)
    client.put("/routes/active", json={"route_id": "r1", "waypoint_id": "w1"})
    box.stop()

    assert client.put("/routes/r2", json=HOME).status_code == 503
    assert client.delete("/routes/r1").status_code == 503

    listed = client.get("/routes").json()
    assert listed["stale"] is True
    assert [r["id"] for r in listed["routes"]] == ["r1"]
    assert listed["active"] == {"route_id": "r1", "waypoint_id": "w1"}


def test_a_route_drawn_in_another_app_shows_up_here(client: TestClient, box: FakeCourse) -> None:
    """Import, over HTTP: Freeboard writes a plain SignalK route resource,
    with none of mivnav's own properties, and GET /routes finds it because
    it re-reads the box."""
    box.resources["from-freeboard"] = {
        "name": "Drawn elsewhere",
        "feature": {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[-122.28, 37.795], [-122.3, 37.8]]},
            "properties": {},
        },
    }
    listed = client.get("/routes").json()
    assert [r["name"] for r in listed["routes"]] == ["Drawn elsewhere"]
    assert [w["id"] for w in listed["routes"][0]["waypoints"]] == ["p0", "p1"]
    # ...and it is a first-class route: followable, like any other.
    go = client.put("/routes/active", json={"route_id": "from-freeboard", "waypoint_id": "p1"})
    assert go.status_code == 200
