# SPDX-License-Identifier: GPL-2.0-only
"""Commanding the anchoralarm plugin through the SignalK anchor paths
(anchor.md), against :mod:`tests.fake_anchoralarm` over real TCP."""

from __future__ import annotations

import math
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mivnav.features.anchor.client import (
    AnchorClient,
    AnchorRefused,
    AnchorUnavailable,
    AnchorUnreachable,
    bow_point,
    distance_m,
    radius_from_here,
)
from tests.conftest import isolated_runtime_at
from tests.fake_anchoralarm import NOTIFICATION_ID, TOKEN, FakeAnchorAlarm


@pytest.fixture
def plugin() -> Iterator[FakeAnchorAlarm]:
    fake = FakeAnchorAlarm().start()
    yield fake
    fake.stop()


def client_for(fake: FakeAnchorAlarm, token: str | None = TOKEN) -> AnchorClient:
    o = fake.origin
    return AnchorClient(f"{o}/signalk/v1/api/vessels/self", f"{o}/signalk/v2/api/notifications", token)


# -- the plugin's arithmetic, done here ---------------------------------------


def test_the_bow_is_from_bow_metres_along_the_heading() -> None:
    lat, lng = bow_point(55.9, 12.6, 90.0, 5.5)  # heading east
    assert lat == pytest.approx(55.9, abs=1e-7)
    assert distance_m(55.9, 12.6, lat, lng) == pytest.approx(5.5, abs=0.01)
    assert lng > 12.6


def test_without_heading_or_offset_the_antenna_is_the_drop_point() -> None:
    assert bow_point(55.9, 12.6, None, 5.5) == (55.9, 12.6)
    assert bow_point(55.9, 12.6, 90.0, None) == (55.9, 12.6)


def test_radius_from_here_is_the_distance_plus_the_fudge_plus_10m() -> None:
    north_30m = 55.9 + math.degrees(30 / 6_371_000)
    assert radius_from_here((north_30m, 12.6), (55.9, 12.6), 8.0) == pytest.approx(48.0, abs=0.01)
    assert radius_from_here((north_30m, 12.6), (55.9, 12.6), None) == pytest.approx(40.0, abs=0.01)


# -- the wire -----------------------------------------------------------------


def test_place_sends_the_radius_before_the_position(plugin: FakeAnchorAlarm) -> None:
    """The plugin starts watching with its REMEMBERED radius on a position
    PUT; the fake, like the boat, remembers 49.79 m."""
    client_for(plugin).place(55.91, 12.61, 40.0, depth_m=4.5)
    assert [(r[0], r[1].rsplit("/", 1)[-1]) for r in plugin.requests] == [
        ("PUT", "maxRadius"),
        ("PUT", "position"),
    ]
    assert plugin.position == {"latitude": 55.91, "longitude": 12.61, "altitude": -4.5}
    assert plugin.watched_with == 40.0
    assert set(plugin.authorizations) == {f"Bearer {TOKEN}"}


def test_an_explicit_radius_goes_through_the_signalk_path(plugin: FakeAnchorAlarm) -> None:
    client_for(plugin).set_radius(55.0)
    assert plugin.requests[-1] == (
        "PUT", "/signalk/v1/api/vessels/self/navigation/anchor/maxRadius", {"value": 55.0})


def test_raise_puts_a_null_position(plugin: FakeAnchorAlarm) -> None:
    client = client_for(plugin)
    client.place(55.9, 12.6, 40.0)
    client.raise_anchor()
    assert plugin.requests[-1][2] == {"value": None}
    assert plugin.position is None


def test_acknowledge_goes_to_the_server_notifications_api(plugin: FakeAnchorAlarm) -> None:
    client_for(plugin).acknowledge(NOTIFICATION_ID)
    assert plugin.acknowledged == [NOTIFICATION_ID]
    assert plugin.requests[-1][1] == f"/signalk/v2/api/notifications/{NOTIFICATION_ID}/acknowledge"


def test_a_failed_handler_is_a_refusal_in_its_own_words(plugin: FakeAnchorAlarm) -> None:
    with pytest.raises(AnchorRefused) as e:
        client_for(plugin).acknowledge("not-this-one")
    assert e.value.status_code == 409
    assert e.value.message == "Notification not found!"


def test_no_token_is_our_config_fault_not_the_boxes(plugin: FakeAnchorAlarm) -> None:
    with pytest.raises(AnchorUnavailable, match="write access"):
        client_for(plugin, token=None).set_radius(40.0)


def test_no_put_handler_means_no_plugin(plugin: FakeAnchorAlarm) -> None:
    plugin.plugin = False
    with pytest.raises(AnchorUnavailable, match="anchoralarm plugin"):
        client_for(plugin).set_radius(40.0)


def test_an_unanswering_box_is_unreachable() -> None:
    client = AnchorClient("http://127.0.0.1:9/x", "http://127.0.0.1:9/y", TOKEN, timeout=0.5)
    with pytest.raises(AnchorUnreachable):
        client.raise_anchor()


def test_signalk_disabled_is_unavailable() -> None:
    with pytest.raises(AnchorUnavailable):
        AnchorClient(None, None, TOKEN).raise_anchor()


# -- the HTTP surface, through the real config ------------------------------


class StubSignalK:
    """Just the two reads the routes make: the snapshot and the track."""

    def __init__(self, snapshot: dict[str, Any], track: list[list[float]] | None = None) -> None:
        self._snapshot = snapshot
        self._track = track or []

    def snapshot(self) -> dict[str, Any]:
        return self._snapshot

    def anchor_track(self) -> list[list[float]]:
        return self._track


BOAT = {"lat": 55.9, "lng": 12.6, "headingDeg": 0.0, "depthBelowSurfaceM": 4.2}


@pytest.fixture
def api(tmp_path: Path):
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime, get_signalk

    saved = dict(app.dependency_overrides)
    runtimes = []

    def build(
        fake: FakeAnchorAlarm | None, snapshot: dict[str, Any] | None = None,
        track: list[list[float]] | None = None,
    ) -> TestClient:
        runtime = isolated_runtime_at(tmp_path)
        runtimes.append(runtime)
        patch: dict[str, Any] = {"credentials": {"signalk": {"token": TOKEN}}}
        if fake is not None:
            patch["signalk"] = {"enabled": True, "host": "127.0.0.1", "port": fake.port}
        runtime.config.patch(patch)
        stub = StubSignalK(snapshot or {"status": "connected", "self": BOAT, "anchor": {}}, track)
        app.dependency_overrides[get_runtime] = lambda: runtime
        app.dependency_overrides[get_signalk] = lambda: stub
        return TestClient(app)

    yield build
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)
    for runtime in runtimes:
        runtime.close()


def test_drop_marks_the_anchor_at_the_bow_without_watching(api, plugin: FakeAnchorAlarm) -> None:
    """Freeboard's flow: the alarm is off while the rode goes out. The
    remembered 49.79 m must NOT arm it — the radius is PUT as null first."""
    snap = {"status": "connected", "self": BOAT, "anchor": {"gpsFromBowM": 5.5}}
    r = api(plugin, snap).post("/anchor/drop", json={})
    assert r.status_code == 200, r.text
    assert plugin.requests[0][2] == {"value": None}
    assert plugin.watched_with is None and not plugin.watching
    pos = plugin.position
    assert pos is not None and pos["altitude"] == -4.2
    # Heading north: the bow is 5.5 m north of the antenna.
    assert distance_m(55.9, 12.6, pos["latitude"], pos["longitude"]) == pytest.approx(5.5, abs=0.01)
    assert pos["latitude"] > 55.9


def test_drop_with_a_radius_watches_at_once(api, plugin: FakeAnchorAlarm) -> None:
    snap = {"status": "connected", "self": BOAT, "anchor": {}}
    assert api(plugin, snap).post("/anchor/drop", json={"radiusM": 40}).status_code == 200
    assert plugin.watched_with == 40.0


def test_arming_after_the_drop_starts_the_watch(api, plugin: FakeAnchorAlarm) -> None:
    snap = {"status": "connected", "self": BOAT, "anchor": {}}
    client = api(plugin, snap)
    assert client.post("/anchor/drop", json={}).status_code == 200
    assert not plugin.watching
    assert client.post("/anchor/radius", json={"radiusM": 35}).status_code == 200
    assert plugin.watching and plugin.radius_m == 35.0


def test_drop_without_a_fix_is_refused_before_it_reaches_the_boat(api, plugin) -> None:
    r = api(plugin, {"status": "connected", "self": None}).post("/anchor/drop", json={})
    assert r.status_code == 409
    assert plugin.requests == []


def test_radius_from_here_measures_against_the_anchor(api, plugin: FakeAnchorAlarm) -> None:
    north_30m = 55.9 + math.degrees(30 / 6_371_000)
    snap = {"status": "connected", "self": {**BOAT, "lat": north_30m},
            "anchor": {"lat": 55.9, "lng": 12.6, "fudgeM": 8.0}}
    assert api(plugin, snap).post("/anchor/radius", json={}).status_code == 200
    assert plugin.radius_m == pytest.approx(48.0, abs=0.01)


def test_radius_from_here_with_the_anchor_up_is_refused(api, plugin) -> None:
    r = api(plugin).post("/anchor/radius", json={})
    assert r.status_code == 409
    assert r.json()["detail"] == "the anchor has not been dropped"


def test_the_routes_round_trip_a_whole_anchoring(api, plugin: FakeAnchorAlarm) -> None:
    http = api(plugin)
    assert http.post("/anchor/drop", json={"radiusM": 35}).status_code == 200
    assert http.post("/anchor/radius", json={"radiusM": 45}).status_code == 200
    assert plugin.radius_m == 45.0
    r = http.put("/anchor/position", json={"lat": 55.901, "lng": 12.601, "radiusM": 45})
    assert r.status_code == 200
    assert http.post("/anchor/ack", json={"id": NOTIFICATION_ID}).status_code == 200
    assert http.post("/anchor/raise").status_code == 200
    assert plugin.position is None


def test_a_silly_radius_is_rejected_before_it_reaches_the_boat(api, plugin: FakeAnchorAlarm) -> None:
    http = api(plugin)
    assert http.post("/anchor/drop", json={"radiusM": 0}).status_code == 422
    assert http.post("/anchor/radius", json={"radiusM": 5000}).status_code == 422
    assert plugin.requests == []


def test_signalk_off_is_a_503(api) -> None:
    assert api(None).post("/anchor/raise").status_code == 503


def test_the_swing_track_is_the_servers_own(api) -> None:
    fixes = [[12.6, 55.9, 1000.0], [12.6001, 55.9002, 11000.0]]
    assert api(None, track=fixes).get("/anchor/track").json() == {"fixes": fixes}
