# SPDX-License-Identifier: GPL-2.0-only
"""``/osm_world/tiles/all/{z}/{x}/{y}``'s live-cache fallback and
``/osm_world/catalog``'s synthetic live entry (jt rtmtmntz) — the GATE
itself (a declared+enabled ``on-demand`` ``osm_world`` dataset), exercised
through the real FastAPI app rather than the bare ``OsmWorldLiveCache``
(see ``test_osm_world_live.py`` for that). The runtime's own
``OsmWorldLiveCache`` is swapped for a stub via ``live_cache`` — an instance
attribute override, not a network stub — since the gate/routing logic under
test does not care how a tile got fetched, only WHETHER the fallback fires
at all.

Same isolated-Runtime/TestClient shape as ``test_datasets_api.py`` (own
``Config.datasets`` mutations must not leak into the shared session
``client`` fixture).
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import get_runtime
from tests.conftest import isolated_runtime_at


@pytest.fixture
def runtime(tmp_path: Path):
    rt = isolated_runtime_at(tmp_path)
    yield rt
    rt.close()


@pytest.fixture
def dc(runtime):
    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: runtime
    with TestClient(app) as c:
        yield c
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous


def _set_datasets(runtime, datasets: list[dict]) -> None:
    runtime.patch_config({"datasets": datasets})


def _osm_world_runtime(runtime):
    from mivnav.features.osm_world.runtime import OsmWorldRuntime

    return cast(OsmWorldRuntime, runtime.feature("osm_world"))


def _stub_live_cache(runtime, tile):
    """Replace ``OsmWorldRuntime.live_cache`` on the live instance with one
    returning ``tile`` (or ``None``) for ANY (z, x, y) — an instance
    attribute override shadows the bound method (Python does not pass
    ``self`` to a plain callable stored directly in an instance's
    ``__dict__``), so ``osm_world_runtime.live_cache()`` calls this."""
    from mivnav.features.osm_world.live import OsmWorldLiveCache

    class _Stub:
        def __init__(self) -> None:
            self.calls: list[tuple[int, int, int]] = []

        async def tile(self, z: int, x: int, y: int):
            self.calls.append((z, x, y))
            return tile

        def stats(self) -> dict:
            return {"tiles": 0, "bytes": 0, "budget": 0}

    stub = _Stub()
    osm_world_runtime = _osm_world_runtime(runtime)
    osm_world_runtime.live_cache = lambda: cast(OsmWorldLiveCache, stub)
    return stub


def _live_tile():
    from mivnav.charts.pmtiles import COMPRESSION_NONE, TILE_TYPE_MVT
    from mivnav.features.osm_world.live import LiveTile

    return LiveTile(data=b"fake-mvt-bytes", tile_compression=COMPRESSION_NONE, tile_type=TILE_TYPE_MVT)


def _on_demand_dataset(max_zoom: int | None = 10, *, enabled: bool = True) -> dict:
    params: dict = {}
    if max_zoom is not None:
        params["max_zoom"] = max_zoom
    return {
        "id": "world-live",
        "provider": "osm_world",
        "name": "World live",
        "mode": "live-cache",
        "params": params,
        "enabled": enabled,
    }


# -- tile_all: gate off (no declared dataset, or a disabled one) -----------


def test_tile_all_stays_404_with_no_on_demand_dataset_declared(dc, runtime):
    stub = _stub_live_cache(runtime, _live_tile())
    r = dc.get("/osm_world/tiles/all/9/100/100")
    assert r.status_code == 404
    assert stub.calls == [], "the live cache must never be reached with the fallback off"


def test_tile_all_stays_off_for_a_disabled_on_demand_dataset(dc, runtime):
    _set_datasets(runtime, [_on_demand_dataset(enabled=False)])
    stub = _stub_live_cache(runtime, _live_tile())
    r = dc.get("/osm_world/tiles/all/9/100/100")
    assert r.status_code == 404
    assert stub.calls == []


# -- tile_all: gate on ------------------------------------------------------


def test_tile_all_falls_through_to_the_live_cache_past_the_baked_cap(dc, runtime):
    """No baked osm_world set at all (`_baked_max_zoom` == -1), so the
    live range starts at z0 — every zoom is "past the baked cap"."""
    _set_datasets(runtime, [_on_demand_dataset(max_zoom=10)])
    tile = _live_tile()
    stub = _stub_live_cache(runtime, tile)
    r = dc.get("/osm_world/tiles/all/9/100/100")
    assert r.status_code == 200
    assert r.content == tile.data
    assert r.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    assert stub.calls == [(9, 100, 100)]


def test_tile_all_never_serves_past_the_datasets_own_max_zoom_override(dc, runtime):
    _set_datasets(runtime, [_on_demand_dataset(max_zoom=10)])
    stub = _stub_live_cache(runtime, _live_tile())
    r = dc.get("/osm_world/tiles/all/11/1000/1000")
    assert r.status_code == 404
    assert stub.calls == [], "z11 is past this dataset's own max_zoom=10 override"


def test_tile_all_404s_without_caching_when_the_live_cache_itself_has_nothing(dc, runtime):
    _set_datasets(runtime, [_on_demand_dataset(max_zoom=10)])
    stub = _stub_live_cache(runtime, None)
    r = dc.get("/osm_world/tiles/all/9/100/100")
    assert r.status_code == 404
    assert stub.calls == [(9, 100, 100)]


def test_tile_all_no_etag_on_a_live_served_tile(dc, runtime):
    """A live tile's content can rotate day to day while the baked union's
    own etag stays constant (no baked set changed) — see
    `_live_tile_response`'s docstring for why reusing that etag would make
    a client's cached If-None-Match incorrectly 304 stale content."""
    _set_datasets(runtime, [_on_demand_dataset(max_zoom=10)])
    _stub_live_cache(runtime, _live_tile())
    r = dc.get("/osm_world/tiles/all/9/100/100")
    assert r.status_code == 200
    assert "etag" not in {k.lower() for k in r.headers}


def test_tile_all_fills_a_hole_INSIDE_the_baked_zoom_range(dc, runtime, tmp_path: Path):
    """Task unqqplrl's regression guard. With a REGION-scoped set baked deep
    (z12 here) alongside a shallow global one, `_baked_max_zoom` is 12 — so
    the old `baked_max_zoom + 1` gate refused to fetch anything at z<=12
    ANYWHERE, including the whole rest of the world outside that region,
    which is exactly where the fallback is most wanted. The gate is now "the
    baked union missed this tile and z is within the live cap".

    Baking a real archive is not needed to prove it: any set whose header
    max_zoom is 12 puts `_baked_max_zoom` there, and every tile request below
    still misses because the set covers nothing.
    """
    import chartcore

    from mivnav.features.osm_world.routes import get_osm_world_store
    from mivnav.features.osm_world.store import OsmWorldStore

    world_dir = tmp_path / "osm_world_sets"
    world_dir.mkdir()
    # A tiny real archive over the Solent, capped at z12 — the "region-scoped
    # deep set" half of the mix.
    chartcore.build_vector_pmtiles(
        point_layers=[("places", [(-1.3, 50.7, {"kind": "locality", "name": "Solent"})])],
        line_layers=[],
        min_zoom=0,
        max_zoom=12,
        out=world_dir / "solent.pmtiles",
    )
    store = OsmWorldStore(world_dir, rescan_interval=0)
    previous = app.dependency_overrides.get(get_osm_world_store)
    app.dependency_overrides[get_osm_world_store] = lambda: store
    try:
        _set_datasets(runtime, [_on_demand_dataset(max_zoom=14)])
        tile = _live_tile()
        stub = _stub_live_cache(runtime, tile)
        # z9 on the far side of the planet: inside the baked union's declared
        # zoom range, but no set has anything there.
        r = dc.get("/osm_world/tiles/all/9/400/200")
        assert r.status_code == 200
        assert r.content == tile.data
        assert stub.calls == [(9, 400, 200)]
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_osm_world_store, None)
        else:
            app.dependency_overrides[get_osm_world_store] = previous


def test_tile_all_serves_a_lone_sets_stored_bytes_and_merges_only_an_overlap(dc, tmp_path: Path):
    """A tile only ONE set has goes out as the archive's own stored bytes —
    no decode/re-encode/gzip (measured ~17 ms per tile on the Pi, ~0.5 s per
    viewport, for a `set` tag nothing reads). Two sets holding the same tile
    are still merged, each feature tagged with its set."""
    import gzip

    import chartcore

    from mivnav.features.osm_world.routes import get_osm_world_store
    from mivnav.features.osm_world.store import OsmWorldStore

    world_dir = tmp_path / "osm_world_sets"
    world_dir.mkdir()

    def bake(set_id: str, name: str) -> None:
        chartcore.build_vector_pmtiles(
            point_layers=[("places", [(-1.3, 50.7, {"kind": "locality", "name": name})])],
            line_layers=[],
            min_zoom=0,
            max_zoom=4,
            out=world_dir / f"{set_id}.pmtiles",
        )

    bake("solent", "Solent")
    store = OsmWorldStore(world_dir, rescan_interval=0)
    previous = app.dependency_overrides.get(get_osm_world_store)
    app.dependency_overrides[get_osm_world_store] = lambda: store
    try:
        archive = store.sets()["solent"].archive
        stored = archive.tile_data(0, 0, 0)
        raw = gzip.decompress(stored)

        with dc.stream("GET", "/osm_world/tiles/all/0/0/0", headers={"Accept-Encoding": "gzip"}) as r:
            assert r.status_code == 200
            assert r.headers["content-encoding"] == "gzip"
            assert b"".join(r.iter_raw()) == stored  # byte-for-byte, not re-compressed
        # a client refusing gzip gets the same tile decompressed, still unmerged
        r = dc.get("/osm_world/tiles/all/0/0/0", headers={"Accept-Encoding": "identity"})
        assert r.content == raw
        assert "set" not in chartcore.tile_feature_tags(r.content, "places")[0]

        bake("wight", "Wight")
        r = dc.get("/osm_world/tiles/all/0/0/0", headers={"Accept-Encoding": "identity"})
        assert r.status_code == 200
        tagged = {(t["name"], t["set"]) for t in chartcore.tile_feature_tags(r.content, "places")}
        assert tagged == {("Solent", "solent"), ("Wight", "wight")}
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_osm_world_store, None)
        else:
            app.dependency_overrides[get_osm_world_store] = previous


# -- catalog: synthetic live entry -------------------------------------------


def test_catalog_has_no_live_entry_with_the_fallback_off(dc, runtime):
    body = dc.get("/osm_world/catalog").json()
    assert body["sets"] == []


def test_catalog_gains_a_live_entry_once_a_dataset_is_declared_and_enabled(dc, runtime):
    _set_datasets(runtime, [_on_demand_dataset(max_zoom=12)])
    body = dc.get("/osm_world/catalog").json()
    assert len(body["sets"]) == 1
    entry = body["sets"][0]
    assert entry["id"] == "world-live"
    assert entry["min_zoom"] == 0  # no baked set at all -> starts at z0
    assert entry["max_zoom"] == 12
    assert entry["live"] is True


def test_catalog_drops_the_live_entry_again_once_disabled(dc, runtime):
    _set_datasets(runtime, [_on_demand_dataset(max_zoom=12, enabled=False)])
    body = dc.get("/osm_world/catalog").json()
    assert body["sets"] == []


def test_catalog_live_entry_falls_back_to_the_boat_wide_default_zoom(dc, runtime):
    """No `params.max_zoom` override declared -> OsmWorldConfig.live_max_zoom
    (15, the daily build's own ceiling) is what the entry reports."""
    _set_datasets(runtime, [_on_demand_dataset(max_zoom=None)])
    body = dc.get("/osm_world/catalog").json()
    assert body["sets"][0]["max_zoom"] == 15


def test_a_datasets_max_zoom_override_can_only_lower_the_boat_wide_cap_never_raise_it(dc, runtime):
    """`OsmWorldRuntime.live_max_zoom` takes `min(override, boat_wide)` —
    a dataset's own override only ever narrows the boat-wide default, same
    direction every other override in this codebase goes, never widens
    past it (see that method's own docstring)."""
    runtime.patch_config({"osm_world": {"live_max_zoom": 8}})
    _set_datasets(runtime, [_on_demand_dataset(max_zoom=12)])
    body = dc.get("/osm_world/catalog").json()
    assert body["sets"][0]["max_zoom"] == 8


def test_baked_tile_all_stays_synchronous(dc, runtime):
    """Regression guard: `tile_all` briefly became a plain `async def`
    running the whole baked directory-scan/mmap-read/Rust-merge path
    directly on the event loop — which would serialise a MapLibre
    viewport's burst of tile requests instead of running them concurrently
    in the threadpool the way a synchronous FastAPI route always has (see
    `tile_all`'s own docstring). A timing-based test for this is exactly
    the kind of flaky, load-sensitive test CLAUDE.md warns against (and one
    was tried here and discarded for that reason — Starlette's TestClient
    does not reliably demonstrate real multi-connection concurrency); this
    asserts the STRUCTURAL property that actually prevents the regression
    instead: `_baked_tile_all` — the part `tile_all` runs via
    `run_in_threadpool` — must never become a coroutine function again."""
    import inspect

    from mivnav.features.osm_world.routes import _baked_tile_all

    assert not inspect.iscoroutinefunction(_baked_tile_all)
