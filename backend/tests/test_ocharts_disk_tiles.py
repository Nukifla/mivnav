# SPDX-License-Identifier: GPL-2.0-only
"""Persistent disk tile cache (mivnav.features.ocharts.disk_tiles) and the
warmer's pre-render phase that fills it."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from mivnav.features.ocharts import warm
from mivnav.features.ocharts.cache import SingleFlightLRU
from mivnav.features.ocharts.disk_tiles import MISSING, DiskTileStore
from mivnav.features.ocharts.service import OchartsService
from mivnav.features.ocharts.sets import CellInfo, OchartsSet
from mivnav.features.ocharts.warm import PRETILE_MIN_ZOOM, CellWarmer

#: Stands in for the machine-bound key (see test_ocharts_licence.py).
KEY = bytes(range(32))
#: Every sealed file: 4-byte magic + 12-byte nonce + 16-byte tag.
SEAL_OVERHEAD = 32

# ---- the store --------------------------------------------------------------


def test_round_trip_and_empty_tile_is_distinct_from_missing(tmp_path: Path) -> None:
    store = DiskTileStore(tmp_path, 1 << 20, key=KEY)
    assert store.get("v1", 5, 1, 2) is MISSING
    store.put("v1", 5, 1, 2, b"\x1f\x8bdata")
    store.put("v1", 5, 1, 3, None)
    assert store.get("v1", 5, 1, 2) == b"\x1f\x8bdata"
    assert store.get("v1", 5, 1, 3) is None  # stored empty tile, not a miss
    assert store.get("v2", 5, 1, 2) is MISSING  # other version
    assert not list(tmp_path.rglob("*.tmp")), "atomic write leaves no temp files"


def test_zero_budget_disables_everything(tmp_path: Path) -> None:
    store = DiskTileStore(tmp_path / "t", 0, key=KEY)
    store.put("v", 1, 0, 0, b"x")
    assert store.get("v", 1, 0, 0) is MISSING
    assert not (tmp_path / "t").exists()


def test_prune_drops_superseded_versions_and_measures(tmp_path: Path) -> None:
    store = DiskTileStore(tmp_path, 1 << 20, key=KEY)
    store.put("old", 4, 0, 0, b"a" * 100)
    store.put("new", 4, 0, 0, b"b" * 50)
    assert store.prune("new") == 1
    assert not (tmp_path / "old").exists()
    assert store.get("new", 4, 0, 0) == b"b" * 50
    assert store.stats()["bytes"] == 50 + SEAL_OVERHEAD


def test_eviction_removes_least_recently_used_first(tmp_path: Path) -> None:
    store = DiskTileStore(tmp_path, 1000, key=KEY)
    store.prune("v")  # sizes the store, so writes can trigger eviction
    for i in range(4):
        store.put("v", 6, i, 0, bytes(200))
        p = tmp_path / "v" / "6" / str(i) / "0.mvt.gz"
        os.utime(p, (1000 + i, 1000 + i))
    store.get("v", 6, 0, 0)  # oldest, but now just used
    store.put("v", 6, 9, 0, bytes(300))  # 1100 > 1000: evict to <= 900
    assert store.get("v", 6, 0, 0) is not MISSING
    assert store.get("v", 6, 1, 0) is MISSING  # the true LRU went
    assert store.stats()["bytes"] <= 900
    assert store.stats()["evictions"] >= 1


def test_io_errors_are_misses_not_failures(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("not a dir")
    store = DiskTileStore(blocker, 1 << 20, key=KEY)  # root is a file: every op fails
    store.put("v", 3, 0, 0, b"x")
    assert store.get("v", 3, 0, 0) is MISSING
    assert store.stats()["errors"] >= 1


# ---- the service ------------------------------------------------------------


def _service(tmp_path: Path, **kw) -> OchartsService:
    svc = OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
        tile_disk_dir=tmp_path / "tiles",
        disk_key_source=lambda: KEY,
        **kw,
    )
    assert svc.wait_licence(10)
    return svc


def test_a_restarted_service_serves_from_disk_without_rendering(tmp_path: Path) -> None:
    renders: list[tuple] = []

    def fake_cut(z, x, y):
        renders.append((z, x, y))
        return b"mvt-bytes"

    first = _service(tmp_path)
    first._cut_tile_all = fake_cut
    packed = first.tile_all(7, 68, 40)
    first.close()

    second = _service(tmp_path)  # a restart: empty RAM, same disk
    second._cut_tile_all = fake_cut
    assert second.tile_all(7, 68, 40) == packed
    assert renders == [(7, 68, 40)], "the second service must not re-render"
    assert second.status()["disk_tile_cache"]["hits"] == 1
    second.close()


def test_selection_settings_change_the_disk_version(tmp_path: Path) -> None:
    """A settings change rebuilds the service (emptying RAM) but the disk
    outlives it, so every byte-affecting knob must be in the version."""
    base = _service(tmp_path).disk_version()
    for kw in (
        {"over_zoom": 7},
        {"under_zoom": 3},
        {"detail_gap": 2},
        {"overview_detail_cutoff": 9},
        {"max_cells_per_tile": 64},
        {"chart_detail": 1.5},
    ):
        assert _service(tmp_path, **kw).disk_version() != base, kw
    assert _service(tmp_path).disk_version() == base  # and it is stable


# ---- pre-rendering ---------------------------------------------------------


def _cell(name: str, extent: tuple[float, float, float, float]) -> CellInfo:
    return CellInfo(
        path=Path(f"/nonexistent/{name}.oesu"),
        key="",
        name=name,
        scale=50_000,
        extent=extent,
        min_zoom=8,
        max_zoom=14,
    )


@dataclass
class PretileService:
    """The slice of OchartsService the pre-render phase uses."""

    root: Path
    chart_cells: list[CellInfo]
    pretile_max_zoom: int | None = 6
    version: str = "v1"
    cells: SingleFlightLRU = field(default_factory=lambda: SingleFlightLRU(1 << 20))
    rendered: list[tuple[int, int, int]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.disk_tiles = DiskTileStore(self.root, 1 << 20, key=KEY)

    def sets(self) -> dict[str, OchartsSet]:
        cs = OchartsSet(id="S", directory=Path("/nonexistent"), sequence=1, info=None)
        cs.cells = list(self.chart_cells)
        return {"S": cs}

    def disk_version(self) -> str:
        return self.version

    def _tile_all(self, z: int, x: int, y: int):
        self.rendered.append((z, x, y))
        self.disk_tiles.put(self.version, z, x, y, b"t")
        return b"t"


def _run_sweep(svc, monkeypatch) -> CellWarmer:
    monkeypatch.setattr(warm, "PRETILE_IDLE_GRACE", 0.0)
    w = CellWarmer(svc, idle_grace=0.0, sweep_interval=60, startup_grace=0.0)
    w._last_request = time.monotonic() - 1
    w._pretile_sweep()
    return w


def test_pretile_renders_every_charted_tile_coarsest_first_once(tmp_path: Path, monkeypatch) -> None:
    # ~Aarhus bay: one z4..z6 tile per zoom
    svc = PretileService(tmp_path, [_cell("A", (10.2, 56.0, 10.4, 56.2))])
    w = _run_sweep(svc, monkeypatch)
    zooms = [z for z, _x, _y in svc.rendered]
    assert zooms == sorted(zooms) and zooms[0] == PRETILE_MIN_ZOOM and zooms[-1] == 6
    assert w.status()["pretile"]["state"] == "complete"
    first = list(svc.rendered)

    _run_sweep(svc, monkeypatch)  # everything on disk now: nothing rendered
    assert svc.rendered == first


def test_pretile_skips_tiles_no_cell_charts(tmp_path: Path, monkeypatch) -> None:
    # two cells far apart: the tiles between them must not be rendered
    svc = PretileService(
        tmp_path,
        [_cell("W", (3.0, 51.0, 3.1, 51.1)), _cell("E", (15.0, 57.0, 15.1, 57.1))],
    )
    _run_sweep(svc, monkeypatch)
    at6 = {(x, y) for z, x, y in svc.rendered if z == 6}
    assert len(at6) == 2


def test_pretile_disabled_without_a_max_zoom(tmp_path: Path, monkeypatch) -> None:
    svc = PretileService(tmp_path, [_cell("A", (10.2, 56.0, 10.4, 56.2))], pretile_max_zoom=None)
    w = _run_sweep(svc, monkeypatch)
    assert svc.rendered == []
    assert w.status()["pretile"]["state"] == "disabled"


def test_pretile_prunes_superseded_versions(tmp_path: Path, monkeypatch) -> None:
    svc = PretileService(tmp_path, [_cell("A", (10.2, 56.0, 10.4, 56.2))])
    svc.disk_tiles.put("stale", 4, 0, 0, b"old")
    _run_sweep(svc, monkeypatch)
    assert not (tmp_path / "stale").exists()


def test_pretile_waits_for_a_user_request_to_finish(tmp_path: Path, monkeypatch) -> None:
    svc = PretileService(tmp_path, [_cell("A", (10.2, 56.0, 10.4, 56.2))])
    monkeypatch.setattr(warm, "PRETILE_IDLE_GRACE", 0.0)
    w = CellWarmer(svc, idle_grace=0.0, sweep_interval=60, startup_grace=0.0)
    w.note_request()  # a user request in flight
    import threading

    t = threading.Thread(target=w._pretile_sweep)
    t.start()
    time.sleep(0.1)
    assert svc.rendered == [], "must not render while a request is in flight"
    w.note_done()
    t.join(5)
    assert svc.rendered
    w.stop()


@pytest.mark.parametrize("lon,lat", [(-180.0, 85.1), (179.999, -85.1), (10.3, 56.1)])
def test_lonlat_tile_is_clamped_to_the_grid(lon, lat) -> None:
    x, y = warm._lonlat_tile(lon, lat, 16)
    assert 0 <= x < 16 and 0 <= y < 16


# ---- carry-over to a new disk version -----------------------------------------

# Two sets far apart: "DK" around the Kattegat, "UK" in the Solent.
DK_CELL = [10.0, 55.0, 12.0, 57.0]
UK_CELL = [-1.6, 50.6, -1.0, 50.9]


def _entry(seq: int, *cells: list[float]) -> dict:
    w = min(c[0] for c in cells)
    s = min(c[1] for c in cells)
    e = max(c[2] for c in cells)
    n = max(c[3] for c in cells)
    return {"sequence": seq, "bounds": [w, s, e, n], "cells": [list(c) for c in cells]}


def _tile_at(z: int, lon: float, lat: float) -> tuple[int, int, int]:
    x, y = warm._lonlat_tile(lon, lat, 1 << z)
    return z, x, y


DK_TILE = _tile_at(9, 11.0, 56.0)
UK_TILE = _tile_at(9, -1.3, 50.75)
# a tile in the UK set's bounds but clear of its only cell
NEAR_UK = _tile_at(9, -1.3, 52.0)


def _stocked(tmp_path: Path, sets: dict, base: str = "b") -> DiskTileStore:
    store = DiskTileStore(tmp_path, 1 << 20, key=KEY)
    for t in (DK_TILE, UK_TILE, NEAR_UK):
        store.put("old", *t, b"old")
    store.write_manifest("old", {"base": base, "sets": sets})
    return store


def test_installing_a_set_keeps_every_tile_it_does_not_reach(tmp_path: Path) -> None:
    store = _stocked(tmp_path, {"DK": _entry(1, DK_CELL)})
    new = {"base": "b", "sets": {"DK": _entry(1, DK_CELL), "UK": _entry(1, UK_CELL)}}
    source, moved = store.carry_over("new", new)
    assert source == "old"
    assert store.get("new", *DK_TILE) == b"old"
    assert store.get("new", *UK_TILE) is MISSING  # the new set charts here
    assert store.get("new", *NEAR_UK) == b"old"  # outside the new set's bounds
    assert moved == 2


def test_a_new_sets_bounds_count_not_only_its_cells(tmp_path: Path) -> None:
    """`claim_allowed` reads set bounds, so adding a set can change a tile
    inside its bounds that none of its cells reach."""
    uk = _entry(1, UK_CELL, [-1.6, 52.5, -1.0, 52.9])  # bounds now span NEAR_UK
    store = _stocked(tmp_path, {"DK": _entry(1, DK_CELL)})
    store.carry_over("new", {"base": "b", "sets": {"DK": _entry(1, DK_CELL), "UK": uk}})
    assert store.get("new", *NEAR_UK) is MISSING
    assert store.get("new", *DK_TILE) == b"old"


def test_updating_a_set_drops_only_its_cells_tiles(tmp_path: Path) -> None:
    uk = _entry(1, UK_CELL, [-1.6, 52.5, -1.0, 52.9])
    store = _stocked(tmp_path, {"DK": _entry(1, DK_CELL), "UK": uk})
    uk2 = dict(uk, sequence=2)  # same bounds: only its cells' tiles change
    store.carry_over("new", {"base": "b", "sets": {"DK": _entry(1, DK_CELL), "UK": uk2}})
    assert store.get("new", *UK_TILE) is MISSING
    assert store.get("new", *NEAR_UK) == b"old"
    assert store.get("new", *DK_TILE) == b"old"


def test_a_different_base_carries_nothing(tmp_path: Path) -> None:
    store = _stocked(tmp_path, {"DK": _entry(1, DK_CELL)}, base="schema 40")
    assert store.carry_over("new", {"base": "schema 41", "sets": {"DK": _entry(1, DK_CELL)}}) == (None, 0)
    assert store.get("new", *DK_TILE) is MISSING


def test_a_tile_rendered_meanwhile_is_not_overwritten(tmp_path: Path) -> None:
    store = _stocked(tmp_path, {"DK": _entry(1, DK_CELL)})
    store.put("new", *DK_TILE, b"fresh")
    store.carry_over("new", {"base": "b", "sets": {"DK": _entry(1, DK_CELL), "UK": _entry(1, UK_CELL)}})
    assert store.get("new", *DK_TILE) == b"fresh"


def test_carry_over_can_be_abandoned_and_resumed(tmp_path: Path) -> None:
    store = _stocked(tmp_path, {"DK": _entry(1, DK_CELL)})
    new = {"base": "b", "sets": {"DK": _entry(1, DK_CELL), "UK": _entry(1, UK_CELL)}}
    assert store.carry_over("new", new, pause=lambda: True) == ("old", 0)
    _source, moved = store.carry_over("new", new)
    assert moved == 2 and store.get("new", *DK_TILE) == b"old"


def _set(sid: str, seq: int, *extents) -> OchartsSet:
    cs = OchartsSet(id=sid, directory=Path("/nonexistent"), sequence=seq, info=None)
    cs.cells = [_cell(f"{sid}{i}", tuple(e)) for i, e in enumerate(extents)]
    return cs


def test_the_manifest_matches_the_disk_version_and_its_base_ignores_sets(tmp_path: Path) -> None:
    svc = _service(tmp_path)
    svc.sets = lambda: {"DK": _set("DK", 1, DK_CELL)}
    version, manifest = svc.disk_manifest()
    assert version == svc.disk_version()
    assert manifest["sets"]["DK"]["cells"] == [DK_CELL]

    svc.sets = lambda: {"DK": _set("DK", 1, DK_CELL), "UK": _set("UK", 7, UK_CELL)}
    version2, manifest2 = svc.disk_manifest()
    assert version2 != version and version2 == svc.disk_version()
    assert manifest2["base"] == manifest["base"]

    other = _service(tmp_path, over_zoom=7)
    other.sets = svc.sets
    assert other.disk_manifest()[1]["base"] != manifest2["base"]
    for s in (svc, other):
        s.close()


def test_the_disk_version_formula_is_unchanged(tmp_path: Path) -> None:
    """The version is a directory name on every deployed boat; changing how
    it is computed throws away all of their tiles."""
    import hashlib

    from mivnav.features.ocharts.service import TILE_SCHEMA_VERSION

    svc = _service(tmp_path)
    svc.sets = lambda: {"DK": _set("DK", 3, DK_CELL)}
    inputs = (
        TILE_SCHEMA_VERSION, (("DK", 3),), svc.scamin_bias_key, svc.over_zoom, svc.under_zoom,
        svc.detail_gap, svc.overview_detail_cutoff, svc.max_cells_per_tile,
        svc._s52_source, svc._s52.lookup_count if svc._s52 else None,
    )
    assert svc.disk_version() == hashlib.sha1(repr(inputs).encode()).hexdigest()[:16]
    svc.close()


@dataclass
class CarryService(PretileService):
    sets_by_id: dict = field(default_factory=dict)

    def sets(self) -> dict[str, OchartsSet]:
        return self.sets_by_id

    def disk_version(self) -> str:
        return "v" + ",".join(f"{k}{cs.sequence}" for k, cs in sorted(self.sets_by_id.items()))

    def disk_manifest(self) -> tuple[str, dict]:
        return self.disk_version(), {
            "base": "b",
            "sets": {k: _entry(cs.sequence, *[list(c.extent) for c in cs.cells]) for k, cs in self.sets_by_id.items()},
        }

    def _tile_all(self, z: int, x: int, y: int):
        self.rendered.append((z, x, y))
        self.disk_tiles.put(self.disk_version(), z, x, y, b"t")
        return b"t"


def test_installing_a_set_pre_renders_only_the_new_area(tmp_path: Path, monkeypatch) -> None:
    svc = CarryService(tmp_path, [], pretile_max_zoom=9, sets_by_id={"DK": _set("DK", 1, DK_CELL)})
    _run_sweep(svc, monkeypatch)
    dk_tiles = set(svc.rendered)
    assert DK_TILE in dk_tiles

    svc.rendered.clear()
    svc.sets_by_id["UK"] = _set("UK", 1, UK_CELL)
    w = _run_sweep(svc, monkeypatch)
    assert svc.rendered and UK_TILE in svc.rendered
    # Only the coarse tiles wide enough to hold both sets render again.
    again = set(svc.rendered) & dk_tiles
    assert DK_TILE not in again and all(z <= 5 for z, _x, _y in again), again
    assert len(again) < len(dk_tiles) / 4
    assert w.status()["pretile"]["state"] == "complete"
    assert [p.name for p in tmp_path.iterdir() if p.is_dir()] == [svc.disk_version()]  # old dir pruned


def test_a_complete_version_is_not_walked_again(tmp_path: Path, monkeypatch) -> None:
    svc = PretileService(tmp_path, [_cell("A", (10.2, 56.0, 10.4, 56.2))])
    w = _run_sweep(svc, monkeypatch)
    hits = svc.disk_tiles.hits
    calls: list = []
    monkeypatch.setattr(svc.disk_tiles, "has", lambda *a: calls.append(a) or True)
    w._pretile_sweep()
    assert calls == [] and svc.disk_tiles.hits == hits


def test_pre_render_checks_tiles_without_reading_them(tmp_path: Path, monkeypatch) -> None:
    """A tile read bumps its mtime (LRU recency), and walking 238k tiles
    every sweep made every tile look just used."""
    svc = PretileService(tmp_path, [_cell("A", (10.2, 56.0, 10.4, 56.2))])
    w = _run_sweep(svc, monkeypatch)
    w._pretile_plan = None  # force a fresh walk of the same version
    w.pretile["state"] = "rendering"
    w._pretile_sweep()
    assert svc.disk_tiles.hits == 0


def test_planning_matches_asking_every_cell_about_every_tile() -> None:
    """Per-cell planning must find exactly the exhaustive answer."""
    from types import SimpleNamespace

    from mivnav.features.ocharts.service import _charting_cells

    class Cov:  # charts a fixed set of tiles per zoom
        def __init__(self, tiles):
            self.tiles = tiles

        def tile_state(self, z, x, y):
            return "partial" if (z, x, y) in self.tiles else "none"

    big = _cell("big", (8.0, 54.0, 13.0, 58.0))
    big.coverage = Cov({_tile_at(z, 11.0, 56.0) for z in range(4, 9)} | {_tile_at(8, 8.2, 54.1)})
    small = _cell("small", (10.9, 55.9, 11.1, 56.1))
    small.coverage = Cov({_tile_at(8, 11.0, 56.0)})
    bare = _cell("bare", (3.0, 51.0, 3.1, 51.1))  # no coverage: extent decides
    cells = [big, small, bare]
    svc = SimpleNamespace(sets=lambda: {"s": SimpleNamespace(cells=cells)}, pretile_max_zoom=8)
    got = CellWarmer(svc, idle_grace=0.0, sweep_interval=60, startup_grace=0.0)._pretile_tiles()

    want = []
    for z in range(PRETILE_MIN_ZOOM, 9):
        n = 1 << z
        cand = set()
        for c in cells:
            x0, y0 = warm._lonlat_tile(c.extent[0], c.extent[3], n)
            x1, y1 = warm._lonlat_tile(c.extent[2], c.extent[1], n)
            cand |= {(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)}
        want += [(z, x, y) for x, y in sorted(cand) if _charting_cells(cells, z, x, y)]
    assert got == want and len(got) > 5
