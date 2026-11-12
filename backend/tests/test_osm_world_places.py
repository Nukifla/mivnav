# SPDX-License-Identifier: GPL-2.0-only
"""Place names harvested out of the baked basemap archives into the shared
search index (task nvpxzxxq) — ``mivnav.features.osm_world.places``, plus the
stdlib MVT reader it stands on (``mivnav.charts.mvt``).

Every fixture archive is written by the SAME Rust writer a real bake's
``pmtiles extract`` output was produced by (``chartcore.build_vector_pmtiles``,
the writer used across the osm_world tests), so the decoder here is tested
against real encoded tiles, not hand-rolled bytes.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import get_runtime
from mivnav.charts.mvt import point_features
from mivnav.charts.pmtiles import Archive, decompress
from mivnav.features.osm_world.places import (
    PLACE_SOURCE,
    scan_archive,
    scan_zoom,
    sync_places,
    tile_count,
)
from mivnav.features.osm_world.store import OsmWorldStore
from mivnav.search import SearchIndex
from tests.conftest import isolated_runtime_at

_COWES = (-1.30, 50.75, {"kind": "locality", "kind_detail": "town", "name": "Cowes", "population": 9500})
_COPENHAGEN = (
    12.57,
    55.68,
    {"kind": "locality", "kind_detail": "city", "name": "København", "name:en": "Copenhagen"},
)
_UNNAMED = (0.5, 0.5, {"kind": "locality"})


def _archive(path: Path, places=(_COWES, _COPENHAGEN), max_zoom: int = 6) -> Path:
    """A tiny but genuine basemap-shaped archive: a ``places`` point layer
    plus a ``roads`` line layer, so "only the named layer is decoded" is
    exercised against a tile that really does carry another one."""
    import chartcore

    chartcore.build_vector_pmtiles(
        point_layers=[("places", list(places))],
        line_layers=[("roads", [([(-1.3, 50.7), (-1.2, 50.8)], {"kind": "highway"})])],
        min_zoom=0,
        max_zoom=max_zoom,
        out=path,
    )
    return path


def _find_tile_with_places(archive: Archive, zoom: int):
    """The first (z, x, y) whose ``places`` layer decodes non-empty."""
    n = 1 << zoom
    for x in range(n):
        for y in range(n):
            raw = archive.tile_data(zoom, x, y)
            if raw is None:
                continue
            tile = decompress(archive.header.tile_compression, raw)
            features = point_features(tile, "places", zoom, x, y)
            if features:
                return (zoom, x, y), tile, features
    raise AssertionError("no tile carried a places layer")


def test_point_features_reads_tags_and_coordinates(tmp_path: Path):
    archive = Archive(_archive(tmp_path / "a.pmtiles"))
    (z, x, y), tile, features = _find_tile_with_places(archive, 6)
    by_name = {props["name"]: (lon, lat, props) for lon, lat, props in features}
    assert "Cowes" in by_name or "København" in by_name
    name, (lon, lat, props) = next(iter(by_name.items()))
    expected = {"Cowes": (-1.30, 50.75), "København": (12.57, 55.68)}[name]
    # Geometry is quantized to the tile grid, so this is "the right place",
    # not "the exact double that went in" — tens of metres at this zoom.
    assert lon == pytest.approx(expected[0], abs=0.01)
    assert lat == pytest.approx(expected[1], abs=0.01)
    assert props["kind"] == "locality"
    # A layer this tile does not carry decodes to nothing rather than raising.
    assert point_features(tile, "buildings", z, x, y) == []


def test_scan_zoom_takes_the_deepest_zoom_inside_the_budget(tmp_path: Path):
    archive = Archive(_archive(tmp_path / "a.pmtiles", max_zoom=6))
    header = archive.header
    assert scan_zoom(header, 100_000) == header.max_zoom
    # The contract, at every budget: the chosen zoom fits, and the next one
    # down (deeper) would not — "deepest that fits", asserted as the property
    # rather than as a literal zoom, which depends on this fixture's bounds.
    for budget in (1, 2, 8, 64):
        z = scan_zoom(header, budget)
        assert z is not None
        assert tile_count(header.bounds, z) <= budget
        if z < header.max_zoom:
            assert tile_count(header.bounds, z + 1) > budget
    # A zero budget is the off switch.
    assert scan_zoom(header, 0) is None


def test_scan_archive_indexes_named_places_only(tmp_path: Path):
    archive = Archive(_archive(tmp_path / "a.pmtiles", places=(_COWES, _COPENHAGEN, _UNNAMED)))
    records = scan_archive(archive, 6)
    titles = sorted(r.title for r in records)
    assert titles == ["Cowes", "København"]  # the unnamed place is not searchable
    cowes = next(r for r in records if r.title == "Cowes")
    assert cowes.category == "town"  # kind_detail, the useful vocabulary
    assert cowes.data == {"name": "Cowes", "kind": "locality", "kind_detail": "town", "population": 9500}
    # The English exonym rides in the FTS text only, never in `data`.
    copenhagen = next(r for r in records if r.title == "København")
    assert "Copenhagen" in (copenhagen.text or "")
    assert "name:en" not in copenhagen.data
    # A place repeated across neighbouring tiles' label buffers collapses to
    # one row: ids are name + coordinate.
    assert len({r.id for r in records}) == len(records)


def test_sync_places_is_idempotent_and_follows_the_archive_mtime(tmp_path: Path):
    root = tmp_path / "osm_world"
    root.mkdir()
    _archive(root / "world.pmtiles")
    store = OsmWorldStore(root, rescan_interval=0)
    index = SearchIndex(tmp_path / "search.sqlite3")

    first = sync_places(store, index, budget=100_000)
    assert first.indexed == {"world": 2}
    assert index.record_count(PLACE_SOURCE, "world") == 2

    # Nothing changed on disk → the second pass does no work at all.
    assert sync_places(store, index, budget=100_000) == type(first)(indexed={}, skipped=("world",))

    # A re-bake (a newer archive) is picked up by mtime alone.
    time.sleep(0.01)
    _archive(root / "world.pmtiles", places=(_COWES,))
    store.invalidate()
    third = sync_places(store, index, budget=100_000)
    assert third.indexed == {"world": 1}
    assert index.record_count(PLACE_SOURCE, "world") == 1
    index.close()


def test_zero_budget_indexes_nothing(tmp_path: Path):
    root = tmp_path / "osm_world"
    root.mkdir()
    _archive(root / "world.pmtiles")
    store = OsmWorldStore(root, rescan_interval=0)
    index = SearchIndex(tmp_path / "search.sqlite3")
    result = sync_places(store, index, budget=0)
    assert result.indexed == {}
    assert index.record_count(PLACE_SOURCE, "world") == 0
    index.close()


def test_catalog_request_makes_basemap_places_searchable(tmp_path: Path):
    """The end-to-end contract: an archive already on disk (never re-baked)
    becomes searchable by name, triggered by the frontend's own catalog poll
    — no ingest, no network."""
    runtime = isolated_runtime_at(tmp_path)
    try:
        root = runtime.config.get().data_root / "osm_world"
        root.mkdir(parents=True)
        _archive(root / "world.pmtiles")
        previous = app.dependency_overrides.get(get_runtime)
        app.dependency_overrides[get_runtime] = lambda: runtime
        try:
            with TestClient(app) as client:
                assert client.get("/osm_world/catalog").status_code == 200
                # The scan runs in the background; it is milliseconds on a
                # fixture this size, but polling keeps the test honest about
                # that being a promise of eventual, not immediate, results.
                for _ in range(200):
                    results = client.get("/search", params={"q": "Cowes"}).json()["results"]
                    if results:
                        break
                    time.sleep(0.01)
                assert [r["title"] for r in results] == ["Cowes"]
                assert results[0]["source"] == PLACE_SOURCE
                assert results[0]["category"] == "town"
                assert results[0]["lat"] == pytest.approx(50.75, abs=0.01)
        finally:
            if previous is None:
                app.dependency_overrides.pop(get_runtime, None)
            else:
                app.dependency_overrides[get_runtime] = previous
    finally:
        runtime.close()
