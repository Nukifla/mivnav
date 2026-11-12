# SPDX-License-Identifier: GPL-2.0-only
"""The POI plugin-source seam (mivnav.plugins + mivnav.features.poi.sources),
exercised with a fake plugin: registry, params routing, a bake through
``PoiBakeJob``, the OSM merge keyed on the source's family, and removal of
the source's extra files when the set is re-baked from OpenStreetMap."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError

import mivnav.config  # noqa: F401 — import order (poi.config ↔ config.model)
from mivnav import plugins
from mivnav.feature import params_context
from mivnav.features.poi.ingest import PoiBakeJob, PoiIngestRunner
from mivnav.features.poi.merge import Point, build_table
from mivnav.features.poi.provider import PoiDatasetParams
from mivnav.features.poi.sources import (
    PoiSource,
    implementation_labels,
    resolve_implementation,
)
from mivnav.features.poi.store import PoiStore


class FakeParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    extra_point: bool = False


def _bake(job: PoiBakeJob) -> None:
    job.fetching()
    feats = [(10.2, 56.15, {"name": "Fake Marina", "kind": "marina", "kind_detail": "berth",
                            "min_zoom": 7, "src": "fake", "ref": "1"})]
    if isinstance(job.params, FakeParams) and job.params.extra_point:
        feats.append((10.3, 56.2, {"name": "Far", "kind": "fuel", "min_zoom": 7,
                                   "src": "fake", "ref": "2"}))
    feats.append((20.0, 60.0, {"name": "Outside", "kind": "fuel", "min_zoom": 7,
                               "src": "fake", "ref": "3"}))
    feats = job.cull_to_region(feats)
    job.write_set(feats, content_hash=job.content_hash(feats, 1))
    (job.root / f"{job.set_id}.fake-extra").write_text("x" * 100)
    job.stats(extras=1)


SOURCE = PoiSource(
    id="fake",
    label="POI (Fake)",
    bake=_bake,
    params_model=FakeParams,
    family=lambda props: "harbour" if props.get("kind_detail") == "berth" else None,
    extra_files=lambda d, s: [d / f"{s}.fake-extra"],
)


@pytest.fixture(autouse=True)
def fake_plugin(monkeypatch):
    monkeypatch.setattr(
        plugins, "_loaded", (plugins.Plugin(id="fake", poi_sources=lambda: (SOURCE,)),)
    )


def _validate(params: dict, impl):
    return PoiDatasetParams.model_validate(params, context=params_context(impl))


def test_registry_lists_the_plugin_source():
    assert implementation_labels() == {"overpass": "POI (OSM)", "fake": "POI (Fake)"}
    assert resolve_implementation("fake") == "fake"
    with pytest.raises(ValueError, match="unknown POI implementation"):
        resolve_implementation("nope")


def test_params_are_validated_by_the_source_model():
    assert _validate({"extra_point": True}, "fake").source_params("fake") == FakeParams(
        extra_point=True
    )
    with pytest.raises(ValidationError):
        _validate({"typo": True}, "fake")
    with pytest.raises(ValidationError, match="extra_point"):
        _validate({"extra_point": True}, None)  # OpenStreetMap takes none
    assert _validate({}, None).source_params(None) is None


def _wait(runner) -> dict:
    deadline = time.time() + 10
    while time.time() < deadline:
        st = runner.status()
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.01)
    raise AssertionError("bake did not finish")


def test_bake_runs_through_the_job_and_extra_files_go_with_a_source_switch(
    tmp_path: Path, monkeypatch
):
    import chartcore

    from mivnav.features.poi import overpass

    builds: list[list] = []

    def fake_build(features, layer, min_zoom, max_zoom, out):
        builds.append(list(features))
        Path(out).write_bytes(b"pmtiles")
        return 1

    monkeypatch.setattr(chartcore, "build_pmtiles", fake_build)
    root = tmp_path / "poi"
    root.mkdir()
    runner = PoiIngestRunner(PoiStore(root, rescan_interval=0), dataset_id="set")
    runner.ingest(country="DK", implementation="fake", params=FakeParams(extra_point=True))
    st = _wait(runner)
    assert st["state"] == "done", st
    assert {p["ref"] for _, _, p in builds[0]} == {"1", "2"}  # culled to DK
    assert st["stats"] == {"extras": 1}
    assert (root / "set.fake-extra").is_file()

    # Re-baked from OpenStreetMap: the fake source's extra file goes.
    monkeypatch.setattr(
        "mivnav.features.poi.ingest._keep_coastal_land", lambda f: f
    )
    monkeypatch.setattr(overpass, "fetch_pois", lambda http, bbox, **kw: [])
    runner.ingest(bbox=(10.0, 56.0, 10.5, 56.5))
    st = _wait(runner)
    assert st["state"] == "done", st
    assert not (root / "set.fake-extra").exists()
    assert any(line.startswith("removed the previous source") for line in st["log"])


def test_merge_pairs_a_source_point_with_its_osm_twin():
    src = Point("a", 10.2, 56.15, {"kind": "marina", "kind_detail": "berth", "src": "fake",
                                   "ref": "1", "min_zoom": 7})
    osm = Point("b", 10.2001, 56.15, {"kind": "marina", "name": "X", "min_zoom": 7})
    other = Point("c", 10.2001, 56.15, {"kind": "marina", "src": "unknown", "ref": "9"})
    table = build_table([src, osm, other], {"a": (5, 14), "b": (5, 14), "c": (5, 14)})
    assert [(n.set_id, o.set_id) for n, o, _ in table.pairs] == [("a", "b")]
    assert "fake:1" in table.osm_for
