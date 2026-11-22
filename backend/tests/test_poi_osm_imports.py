# SPDX-License-Identifier: GPL-2.0-only
"""``Config.poi.osm_imports``: OpenStreetMap POI bakes are off unless the
boat switched them on (Settings → Advanced); other sources are unaffected."""

from __future__ import annotations

import pytest

import mivnav.config  # noqa: F401 — import order, as in the host tests
from mivnav.features.poi.config import PoiConfig
from mivnav.features.poi.ingest import OSM_IMPORTS_OFF, PoiIngestError, PoiIngestRunner
from mivnav.features.poi.store import PoiStore


def test_off_by_default():
    assert PoiConfig().osm_imports is False


def test_an_osm_bake_is_refused_while_off(tmp_path):
    runner = PoiIngestRunner(PoiStore(tmp_path / "poi", rescan_interval=0), poi_config=PoiConfig)
    with pytest.raises(PoiIngestError, match="turned off"):
        runner.ingest(country="DK")
    assert runner.status()["state"] != "fetch"


def test_the_dataset_trigger_answers_409(tmp_path):
    from fastapi.testclient import TestClient

    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime
    from tests.conftest import isolated_runtime_at

    rt = isolated_runtime_at(tmp_path)
    rt.patch_config({
        "poi": {"osm_imports": False},
        "datasets": [{"id": "dk-poi", "provider": "poi", "name": "dk-poi", "region_id": "solent"}],
    })
    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: rt
    try:
        with TestClient(app) as c:
            r = c.post("/datasets/dk-poi/ingest")
            assert r.status_code == 409, r.text
            assert r.json()["detail"] == OSM_IMPORTS_OFF
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_runtime, None)
        else:
            app.dependency_overrides[get_runtime] = previous
        rt.close()
