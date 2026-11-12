# SPDX-License-Identifier: GPL-2.0-only
"""``/notices/*`` through the real FastAPI app (efs.md §6 contract), over
an isolated runtime whose notices dataset talks to the fake Niord."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import get_runtime
from tests.fake_niord import FE_ID, FakeNiord, notices_api_runtime, update, wait


@pytest.fixture
def fake():
    return FakeNiord()


@pytest.fixture
def rt(tmp_path, fake):
    runtime = notices_api_runtime(tmp_path, fake)
    update(runtime)
    yield runtime
    runtime.close()


def _client(runtime):
    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: runtime
    return previous


@pytest.fixture
def c(rt):
    previous = _client(rt)
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides[get_runtime] = previous


def test_status(c):
    st = c.get("/notices/status").json()
    assert set(st) == {"state", "version", "fetched_at", "count", "by_family", "error"}
    assert st["state"] == "ready" and st["count"] == 13
    assert set(st["by_family"]) == {"nw", "fe", "nm-t", "nm-p", "nm-perm", "nm-misc", "fa", "efs-a", "efs-b"}


def test_map_and_etag(c):
    r = c.get("/notices/map.geojson")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/geo+json")
    version = c.get("/notices/status").json()["version"]
    assert r.headers["etag"] == f'"{version}"'
    fc = r.json()
    assert fc["type"] == "FeatureCollection" and fc["features"]
    assert c.get("/notices/map.geojson", headers={"If-None-Match": r.headers["etag"]}).status_code == 304
    assert c.get("/notices/map.geojson", headers={"If-None-Match": '"other"'}).status_code == 200


def test_list(c):
    r = c.get("/notices/list")
    body = r.json()
    assert body["version"] == c.get("/notices/status").json()["version"]
    assert body["fetched_at"].endswith("Z")
    assert len(body["items"]) == 13
    assert {i["fam"] for i in body["items"]} >= {"efs-a", "efs-b", "nm-misc"}
    assert c.get("/notices/list", headers={"If-None-Match": r.headers["etag"]}).status_code == 304


def test_detail_by_uuid_short_id_and_slashed_short_id(c):
    assert c.get(f"/notices/{FE_ID}").json()["fam"] == "fe"
    d = c.get("/notices/NM-842-26").json()
    assert d["sid"] == "NM-842-26" and d["title"]["da"] and d["title"]["en"]
    assert c.get("/notices/FA/EK-R-18 2026").json()["fam"] == "fa"
    # what the frontend sends: encodeURIComponent("FA/EK-R-18 2026")
    assert c.get("/notices/FA%2FEK-R-18%202026").json()["sid"] == "FA/EK-R-18 2026"


def test_unknown_id_fallback(c, fake):
    assert c.get("/notices/NM-567-25").json()["status"] == "CANCELLED"
    assert c.get("/notices/NM-000-00").status_code == 404
    fake.down = True
    assert c.get("/notices/NM-111-11").status_code == 503


def test_attachments(c):
    d = c.get("/notices/NM-053-26").json()
    url = d["attachments"][0]["url"]
    r = c.get(url)
    assert r.status_code == 200 and r.content == b"%PDF-1.4 fake"
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("inline")
    assert c.get("/notices/attachments/nope").status_code == 404


def test_refresh_updates_every_enabled_dataset(c, rt, fake):
    st = c.post("/notices/refresh").json()
    assert st["state"] in ("ready", "loading")
    wait(rt.dataset_runner("notices-dk"))
    assert fake.calls["messages:None"] == 2
    assert c.get("/notices/status").json()["state"] == "ready"


def test_sources_catalog(c):
    body = c.get("/notices/sources").json()
    assert body["default"] == "dk-niord"
    (src,) = body["sources"]
    assert src["id"] == "dk-niord"
    assert [r["id"] for r in src["regions"]] == ["dk", "gl"]


def test_first_status_kicks_the_first_update(tmp_path):
    """A fresh boat: the seeded ttl dataset is pulled on the first status
    request, not after the scheduler's first 5-min poll."""
    fake = FakeNiord()
    runtime = notices_api_runtime(tmp_path, fake)
    previous = _client(runtime)
    try:
        with TestClient(app) as client:
            st = client.get("/notices/status").json()
            assert st["state"] in ("loading", "ready")
            wait(runtime.dataset_runner("notices-dk"))
            st = client.get("/notices/status").json()
            assert st["state"] == "ready" and st["count"] == 13
            assert fake.calls["messages:None"] == 1
    finally:
        app.dependency_overrides[get_runtime] = previous
        runtime.close()


def test_offline_empty_answers(tmp_path):
    """Before any successful pull: empty but well-formed bodies."""
    fake = FakeNiord()
    fake.down = True
    runtime = notices_api_runtime(tmp_path, fake)
    previous = _client(runtime)
    try:
        with TestClient(app) as client:
            assert client.get("/notices/map.geojson").json() == {"type": "FeatureCollection", "features": []}
            assert client.get("/notices/list").json() == {"version": None, "fetched_at": None, "items": []}
            client.get("/notices/status")  # kicks the (failing) first update
            wait(runtime.dataset_runner("notices-dk"))
            st = client.get("/notices/status").json()
            assert st["state"] == "offline" and st["version"] is None and st["count"] == 0
            assert "no route to host" in st["error"]
    finally:
        app.dependency_overrides[get_runtime] = previous
        runtime.close()


def test_the_test_runtime_declares_no_notices_dataset(client):
    """conftest drops the seeded dataset, so no test reaches niord.dma.dk."""
    st = client.get("/notices/status").json()
    assert st["state"] == "offline" and "No notices dataset" in st["error"]
