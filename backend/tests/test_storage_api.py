# SPDX-License-Identifier: GPL-2.0-only
"""``GET /storage`` — every byte under ``data_root`` lands in exactly one
group (declared datasets split by implementation label, undeclared chart
sets under their provider, routing/track/other), caches outside it are
listed separately, and the disk's free space is reported."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import get_runtime
from tests.conftest import isolated_runtime_at


@pytest.fixture
def runtime(tmp_path: Path):
    rt = isolated_runtime_at(tmp_path)
    rt.patch_config(
        {
            "weather": {
                "cache_dir": str(tmp_path / "cache" / "weather"),
                "render_cache_dir": str(tmp_path / "cache" / "weather-render"),
            },
            "osm_world": {"live_cache_dir": str(tmp_path / "cache" / "osm")},
        }
    )
    yield rt
    rt.close()


@pytest.fixture
def sc(runtime):
    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: runtime
    with TestClient(app) as c:
        yield c
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous


def _write(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def _group(body: dict, label: str) -> dict:
    return next(g for g in body["groups"] if g["label"] == label)


def test_storage_covers_datasets_and_everything_else(sc, runtime, tmp_path: Path):
    data = tmp_path / "data"
    runtime.patch_config(
        {
            "datasets": [
                {"id": "dk-sat", "provider": "satellite", "name": "Denmark imagery",
                 "region_id": "solent"},
                {"id": "dk-osm", "provider": "poi", "name": "Denmark OSM",
                 "region_id": "solent"}  # default: OSM,
            ]
        }
    )
    _write(data / "satellite" / "dk-sat" / "dk-sat.pmtiles", 40_000)
    _write(data / "satellite" / "dk-sat" / "dk-sat.extra" / "a.bin", 30_000)
    _write(data / "poi" / "dk-osm" / "x.bin", 8_000)
    _write(data / "ocharts" / "fnc-de" / "cell.S57", 12_000)  # undeclared set
    _write(data / "routing" / "mivnav" / "fnc-de.mivnav", 50_000)
    _write(data / "routing" / "mivnav" / ".fnc-de.mivnav.tmp.1", 20_000)
    _write(data / "track" / "abc" / "t.bin", 4_000)
    _write(data / "grib" / "f.grib2", 4_000)
    _write(tmp_path / "ocharts" / "tiles" / "t.pbf", 16_000)

    r = sc.get("/storage")
    assert r.status_code == 200
    body = r.json()

    sat = _group(body, "Satellite imagery")
    assert sat["kind"] == "dataset"
    assert sat["items"] == [{"name": "Denmark imagery", "bytes": sat["bytes"]}]
    assert sat["bytes"] >= 70_000  # everything in the dataset's folder counted
    assert _group(body, "POI (OSM)")["bytes"] >= 8_000

    ocharts = _group(body, "o-charts")
    assert [i["name"] for i in ocharts["items"]] == ["fnc-de"]

    routing = _group(body, "Routing graphs")
    names = {i["name"] for i in routing["items"]}
    assert names == {"fnc-de.mivnav", ".fnc-de.mivnav.tmp.1 (unfinished build)"}

    assert _group(body, "Track history")["bytes"] >= 4_000
    assert [i["name"] for i in _group(body, "Other files")["items"]] == ["grib"]

    caches = {i["name"]: i["bytes"] for i in _group(body, "Caches & logs")["items"]}
    assert caches["Chart tile cache"] >= 16_000
    # No live-cache dataset declared, so the live caches are listed here.
    assert "Weather download cache" in caches
    assert "OSM world live cache" in caches

    assert body["total"] == sum(g["bytes"] for g in body["groups"])
    # groups come largest first
    sizes = [g["bytes"] for g in body["groups"]]
    assert sizes == sorted(sizes, reverse=True)

    disk = body["disk"]
    assert disk["path"] == str(data)
    assert disk["total"] > 0 and 0 <= disk["free"] <= disk["total"]


def test_live_cache_dataset_is_not_double_counted(sc, runtime):
    runtime.patch_config(
        {"datasets": [{"id": "osm-live", "provider": "osm_world", "name": "OSM live",
                       "mode": "live-cache"}]}
    )
    body = sc.get("/storage").json()
    caches = {i["name"] for i in _group(body, "Caches & logs")["items"]}
    assert "OSM world live cache" not in caches
    assert _group(body, "OSM world basemap")["items"][0]["name"] == "OSM live"
