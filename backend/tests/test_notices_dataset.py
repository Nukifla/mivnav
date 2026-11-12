# SPDX-License-Identifier: GPL-2.0-only
"""Notices as a dataset provider, config side: the first-start seed, the
migration of the retired ``notices`` slice keys (``enabled``,
``refresh_s``, ``include_greenland``) into a dataset, and the generic
``PUT /datasets/{id}`` validating a notices dataset's regions/source."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import get_runtime
from mivnav.config import ConfigStore
from mivnav.config.migrate import migrate_notices_datasets
from tests.fake_niord import FakeNiord, notices_api_runtime, wait


def _write(path: Path, doc: dict) -> None:
    path.write_text(json.dumps({"version": 1, **doc}))


def _notices(store: ConfigStore):
    return [d for d in store.get().datasets if d.provider == "notices"]


def test_a_first_start_seeds_one_notices_dataset(tmp_path):
    store = ConfigStore(tmp_path / "config.json")
    (ds,) = _notices(store)
    assert ds.id == "notices-dk" and ds.name == "Denmark + Greenland"
    assert (ds.schedule, ds.ttl_s, ds.mode, ds.enabled) == ("ttl", 1800, "bake", True)
    assert ds.implementation == "dk-niord" and ds.params == {"regions": ["dk", "gl"]}
    # and it is on disk, so a restart does not re-decide
    on_disk = json.loads((tmp_path / "config.json").read_text())
    assert [d["id"] for d in on_disk["datasets"]] == ["notices-dk"]


def test_the_old_notices_slice_becomes_a_dataset(tmp_path):
    path = tmp_path / "config.json"
    _write(
        path,
        {
            "notices": {
                "enabled": True,
                "refresh_s": 3600,
                "include_greenland": False,
                "include_firing_areas": False,
            },
            "datasets": [{"id": "pois", "provider": "poi", "name": "POIs"}],
        },
    )
    store = ConfigStore(path)
    (ds,) = _notices(store)
    assert ds.params == {"regions": ["dk"]} and ds.name == "Denmark"
    assert (ds.schedule, ds.ttl_s, ds.enabled) == ("ttl", 3600, True)
    assert store.get().notices.include_firing_areas is False  # kept
    assert [d.id for d in store.get().datasets] == ["pois", "notices-dk"]


def test_a_disabled_old_slice_becomes_a_disabled_dataset(tmp_path):
    path = tmp_path / "config.json"
    _write(path, {"notices": {"enabled": False, "refresh_s": 1800, "include_greenland": True}})
    (ds,) = _notices(ConfigStore(path))
    assert ds.enabled is False and ds.params == {"regions": ["dk", "gl"]}


def test_a_config_from_before_notices_gets_the_default(tmp_path):
    path = tmp_path / "config.json"
    _write(path, {"datasets": []})
    (ds,) = _notices(ConfigStore(path))
    assert ds.id == "notices-dk" and ds.enabled


def test_a_deleted_notices_dataset_stays_deleted(tmp_path):
    path = tmp_path / "config.json"
    _write(path, {"notices": {"enabled": True, "refresh_s": 1800, "include_greenland": True}})
    store = ConfigStore(path)
    assert _notices(store)
    store.patch({"datasets": []})  # the sailor deletes it (a write)
    on_disk = json.loads(path.read_text())
    assert set(on_disk["notices"]) == {"base_url", "include_firing_areas", "cache_attachments"}
    assert _notices(ConfigStore(path)) == []
    assert _notices(store) == [] and store.reload().datasets == ()


def test_an_existing_notices_dataset_is_not_doubled():
    raw = {
        "notices": {"enabled": True, "refresh_s": 1800, "include_greenland": True},
        "datasets": [{"id": "mine", "provider": "notices", "name": "Mine"}],
    }
    out = migrate_notices_datasets(raw)
    assert [d["id"] for d in out["datasets"]] == ["mine"]
    assert out["notices"] == {}
    assert migrate_notices_datasets(out) == out  # idempotent


def test_the_default_id_dedupes_against_a_taken_one():
    raw = {
        "notices": {"enabled": True},
        "datasets": [{"id": "notices-dk", "provider": "poi", "name": "odd"}],
    }
    out = migrate_notices_datasets(raw)
    assert [d["id"] for d in out["datasets"]] == ["notices-dk", "notices-dk-2"]


@pytest.fixture
def runtime(tmp_path):
    rt = notices_api_runtime(tmp_path, FakeNiord())
    yield rt
    rt.close()


@pytest.fixture
def c(runtime):
    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: runtime
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides[get_runtime] = previous


def test_put_validates_regions_against_the_source(c):
    body = {"provider": "notices", "name": "Greenland", "schedule": "ttl", "ttl_s": 900}
    ok = c.put("/datasets/gl", json={**body, "params": {"regions": ["gl"]}})
    assert ok.status_code == 200, ok.text
    assert ok.json()["params"] == {"regions": ["gl"]}
    assert c.put("/datasets/fo", json={**body, "params": {"regions": ["fo"]}}).status_code == 422
    assert c.put("/datasets/none", json={**body, "params": {"regions": []}}).status_code == 422
    assert (
        c.put("/datasets/se", json={**body, "implementation": "se-sjofartsverket", "params": {}}).status_code
        == 422
    )


def test_bake_and_delete_through_the_generic_routes(c, runtime):
    assert c.post("/datasets/notices-dk/ingest").status_code == 200
    wait(runtime.dataset_runner("notices-dk"))
    assert c.get("/notices/status").json()["count"] == 13
    assert c.delete("/datasets/notices-dk").status_code == 200
    st = c.get("/notices/status").json()
    assert st["count"] == 0 and "No notices dataset" in st["error"]
    assert runtime.search_index().record_count(source="notices") == 0
