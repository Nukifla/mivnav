# SPDX-License-Identifier: GPL-2.0-only
"""/marks over HTTP, against a fake SignalK box on loopback — marks live
on SignalK as ``resources/waypoints`` and nowhere else."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import Runtime, get_runtime
from mivnav.features.marks.store import Mark
from mivnav.features.marks.wire import from_resource, to_resource

from conftest import isolated_runtime_at
from fake_course import TOKEN, FakeCourse

ROCK = {"name": "Rock", "note": "Dries at LW", "icon": "danger", "lat": 55.5, "lon": 12.25}


@pytest.fixture()
def box() -> Iterator[FakeCourse]:
    fake = FakeCourse().start()
    yield fake
    fake.stop()


@pytest.fixture()
def runtime(tmp_path: Path, box: FakeCourse) -> Runtime:
    runtime = isolated_runtime_at(tmp_path)
    runtime.config.patch(
        {
            "signalk": {"enabled": True, "host": "127.0.0.1", "port": box.port},
            "credentials": {"signalk": {"token": TOKEN}},
        }
    )
    return runtime


@pytest.fixture()
def client(runtime: Runtime) -> Iterator[TestClient]:
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_runtime] = lambda: runtime
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)
    runtime.close()


def test_a_mark_is_a_signalk_waypoint(client: TestClient, box: FakeCourse) -> None:
    r = client.put("/marks/m1", json=ROCK)
    assert r.status_code == 200
    saved = r.json()
    assert saved["name"] == "Rock" and saved["icon"] == "danger" and saved["updated"] > 0

    resource = box.waypoints["m1"]
    assert resource["name"] == "Rock"
    assert resource["description"] == "Dries at LW"
    assert resource["feature"]["geometry"] == {"type": "Point", "coordinates": [12.25, 55.5]}
    assert resource["feature"]["properties"]["mivnav"]["icon"] == "danger"
    # The bearer token went with it (the box is read-only without one).
    assert box.authorizations[-1] == f"Bearer {TOKEN}"

    listed = client.get("/marks").json()
    assert listed["stale"] is False
    assert [m["id"] for m in listed["marks"]] == ["m1"]
    assert "pin" in listed["icons"]


def test_move_edit_and_delete(client: TestClient, box: FakeCourse) -> None:
    client.put("/marks/m1", json=ROCK)
    moved = client.put("/marks/m1", json={**ROCK, "lat": 55.6, "name": " Rock 2 "}).json()
    assert moved["lat"] == 55.6 and moved["name"] == "Rock 2"
    assert box.waypoints["m1"]["feature"]["geometry"]["coordinates"] == [12.25, 55.6]

    assert client.delete("/marks/m1").status_code == 204
    assert "m1" not in box.waypoints
    assert client.get("/marks").json()["marks"] == []
    assert client.delete("/marks/m1").status_code == 404


def test_waypoints_from_other_apps_are_listed_and_keep_their_fields(
    client: TestClient, box: FakeCourse
) -> None:
    box.waypoints["urn:mrn:signalk:uuid:abc"] = {
        "name": "Fuel dock",
        "description": "Opens 8",
        "type": "PoI",
        "feature": {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [10.0, 56.0]},
            "properties": {"freeboard": {"x": 1}},
        },
    }
    # The v1 shape still seen from older apps.
    box.waypoints["old"] = {"name": "Old", "position": {"latitude": 54.0, "longitude": 11.0}}
    # No position at all: skipped, not fatal.
    box.waypoints["broken"] = {"name": "Broken"}

    marks = {m["id"]: m for m in client.get("/marks").json()["marks"]}
    assert set(marks) == {"urn:mrn:signalk:uuid:abc", "old"}
    fuel = marks["urn:mrn:signalk:uuid:abc"]
    assert (fuel["note"], fuel["icon"], fuel["lat"], fuel["lon"]) == ("Opens 8", "pin", 56.0, 10.0)
    assert (marks["old"]["lat"], marks["old"]["lon"]) == (54.0, 11.0)

    client.put("/marks/urn:mrn:signalk:uuid:abc", json={**fuel, "icon": "star"})
    written = box.waypoints["urn:mrn:signalk:uuid:abc"]
    assert written["type"] == "PoI"
    assert written["feature"]["properties"]["freeboard"] == {"x": 1}
    assert written["feature"]["properties"]["mivnav"]["icon"] == "star"

    client.put("/marks/old", json={**marks["old"], "lat": 54.5})
    assert "position" not in box.waypoints["old"]


@pytest.mark.parametrize(
    "path,body",
    [
        ("/marks/m1", {**ROCK, "icon": "unicorn"}),
        ("/marks/m1", {**ROCK, "lat": 91}),
        ("/marks/m1", {**ROCK, "name": "x" * 65}),
        ("/marks/m1", {**ROCK, "id": "other"}),
        ("/marks/m1", {**ROCK, "colour": "red"}),
        ("/marks/a.b", ROCK),
    ],
)
def test_invalid_marks_are_refused(client: TestClient, box: FakeCourse, path, body) -> None:
    assert client.put(path, json=body).status_code == 422
    assert box.waypoints == {}


def test_signalk_down_refuses_writes_and_serves_reads_stale(
    client: TestClient, box: FakeCourse
) -> None:
    client.put("/marks/m1", json=ROCK)
    box.fail_with = (500, {"message": "boom"})
    assert client.put("/marks/m2", json=ROCK).status_code == 503
    assert client.delete("/marks/m1").status_code == 503
    listed = client.get("/marks").json()
    assert listed["stale"] is True
    assert [m["id"] for m in listed["marks"]] == ["m1"]


def test_signalk_disabled_refuses_writes(tmp_path: Path) -> None:
    runtime = isolated_runtime_at(tmp_path)
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_runtime] = lambda: runtime
    try:
        with TestClient(app) as c:
            assert c.put("/marks/m1", json=ROCK).status_code == 503
            assert c.get("/marks").json() == {"marks": [], "icons": c.get("/marks").json()["icons"], "stale": True}
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)
        runtime.close()


def test_wire_round_trip() -> None:
    mark = Mark(id="m1", name="A", note="n", icon="fish", lat=1.5, lon=-2.5, updated=3.0)
    assert from_resource("m1", to_resource(mark)) == mark
