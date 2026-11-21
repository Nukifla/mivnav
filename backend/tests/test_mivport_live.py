# SPDX-License-Identifier: GPL-2.0-only
"""mivport live (``mivnav.features.poi.mivport.live``): the worldwide layer
cut per tile from ``/v1/places?bbox=`` against a fake mivport, its offline
backoff, the baked/local exclusions and the live place detail."""

from __future__ import annotations

import httpx
import pytest

import mivnav.config  # noqa: F401 — import order, as in the host tests
from mivnav.features.poi.mivport import live as mp_live
from mivnav.features.poi.mvt import decode_point_layer
from tests.test_mivport_editing import FakeWrites, _bake_set, _login
from tests.test_poi_mivport import BASE

LIVE = "55555555-5555-5555-5555-555555555555"
#: A z10 tile holding Aarhus (10.2 E, 56.15 N) and the fake's places.
Z, X, Y = 10, 541, 318


def _feat(pid: str, kind: str, lon: float, lat: float, **props) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"id": pid, "kind": kind, "source": "core", "rev": 2, **props},
    }


class FakeLive(FakeWrites):
    def __init__(self) -> None:
        super().__init__()
        self.world = [
            _feat(LIVE, "marina", 10.21, 56.16, name="Live Marina"),
            _feat("osm:n77", "toilets", 10.22, 56.161),  # min_zoom 14: not at z10
        ]
        self.bbox_calls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.offline:
            raise httpx.ConnectError("offline", request=request)
        path = request.url.path
        if path == "/v1/places":
            self.bbox_calls += 1
            w, s, e, n = map(float, request.url.params["bbox"].split(","))
            feats = [
                f for f in self.world + self.export
                if f.get("geometry")
                and w <= f["geometry"]["coordinates"][0] <= e
                and s <= f["geometry"]["coordinates"][1] <= n
            ]
            return httpx.Response(200, json={"type": "FeatureCollection", "features": feats,
                                             "attribution": "© mivport"})
        if path == f"/v1/places/{LIVE}":
            return httpx.Response(200, json={"feature": self.world[0], "attribution": "© mivport"})
        if path == f"/v1/places/{LIVE}/reviews":
            return httpx.Response(200, json={"reviews": [
                {"id": "rv", "place_id": LIVE, "user": "bo", "stars": 5, "body": "Great"}]})
        if path == f"/v1/places/{LIVE}/photos":
            return httpx.Response(200, json={"photos": []})
        return super().handler(request)


@pytest.fixture
def fake(monkeypatch):
    from mivnav.features.poi.mivport import source as mp_source

    monkeypatch.setattr(mp_source, "REQUEST_INTERVAL_S", 0.0)
    f = FakeLive()
    f.created = {}
    return f


@pytest.fixture
def runtime(tmp_path, fake):
    from tests.conftest import isolated_runtime_at

    rt = isolated_runtime_at(tmp_path)
    rt.patch_config({"mivport": {"base_url": BASE, "live": True}})
    mp = rt.feature("mivport")
    mp.syncer.stop()
    mp.http_client = httpx.Client(transport=httpx.MockTransport(lambda r: fake.handler(r)))
    yield rt
    rt.close()


@pytest.fixture
def dc(runtime):
    from fastapi.testclient import TestClient

    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: runtime
    with TestClient(app) as c:
        yield c
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous


def _tile(dc, z=Z, x=X, y=Y) -> list[dict]:
    r = dc.get(f"/poi/live/mivport/tiles/{z}/{x}/{y}")
    if r.status_code == 204:
        return []
    assert r.status_code == 200, r.text
    return [props for _, _, props in decode_point_layer(r.content, "pois") or ()]


def test_tile_bbox_round_trips():
    w, s, e, n = mp_live.tile_bbox(Z, X, Y)
    assert w <= 10.21 <= e and s <= 56.16 <= n


def test_status_follows_the_config(runtime, dc):
    st = dc.get("/poi/live/mivport").json()
    assert st["enabled"] is True and st["state"] == "ready"
    assert st["tiles"] == "/poi/live/mivport/tiles/{z}/{x}/{y}"
    runtime.patch_config({"mivport": {"live": False}})
    assert dc.get("/poi/live/mivport").json()["state"] == "off"


def test_tile_has_ranked_in_places_tagged_live(dc, fake):
    props = {p["ref"]: p for p in _tile(dc)}
    assert props[LIVE]["set"] == "live" and props[LIVE]["src"] == "mivport"
    assert props[LIVE]["name"] == "Live Marina" and props[LIVE]["kind"] == "marina"
    assert "osm:n77" not in props  # a toilet ranks in at z14
    # Cached: a second ask doesn't go to mivport.
    calls = fake.bbox_calls
    _tile(dc)
    assert fake.bbox_calls == calls


def test_off_and_below_min_zoom_ask_nothing(runtime, dc, fake):
    assert _tile(dc, 6, 33, 19) == []
    runtime.patch_config({"mivport": {"live": False}})
    assert _tile(dc) == []
    assert fake.bbox_calls == 0


def test_offline_backs_off(runtime, dc, fake):
    fake.offline = True
    assert _tile(dc) == []
    assert dc.get("/poi/live/mivport").json()["state"] == "offline"
    fake.offline = False
    # Still in the backoff: answered empty without asking.
    assert _tile(dc, Z, X + 1, Y) == []
    assert fake.bbox_calls == 0


def test_baked_places_are_left_to_the_bake(runtime, dc, fake):
    from tests.test_poi_mivport import P1

    assert P1 in {p["ref"] for p in _tile(dc)}
    _bake_set(runtime, fake)
    runtime.feature("mivport").live._tiles.clear()
    refs = {p["ref"] for p in _tile(dc)}
    assert P1 not in refs and LIVE in refs


def test_places_changed_on_the_boat_are_left_to_the_local_layer(runtime, dc, fake):
    _login(dc)
    r = dc.post("/mivport/edits", json={"op": "modify", "place_id": LIVE, "set": {"name": "Mine"}})
    assert r.status_code == 200, r.text
    assert LIVE not in {p["ref"] for p in _tile(dc)}


def test_live_detail(dc):
    d = dc.get(f"/poi/mivport/details/live/{LIVE}")
    assert d.status_code == 200, d.text
    body = d.json()
    assert body["name"] == "Live Marina" and body["attribution"] == "© mivport"
    assert body["lon"] == 10.21 and [r["id"] for r in body["reviews"]] == ["rv"]


def test_live_detail_offline_is_503(dc, fake):
    fake.offline = True
    assert dc.get(f"/poi/mivport/details/live/{LIVE}").status_code == 503
