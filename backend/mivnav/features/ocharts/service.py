# SPDX-License-Identifier: GPL-2.0-only
"""o-charts serving facade: daemon lifecycle, cell decode, tile cuts.

Selection/cut/coverage-mask/merge live in Rust (chartcore); this module
keeps daemon lifecycle, RAM caches, and cell enumeration. No filesystem
writes — decoded cells/tiles live only in process RAM. See
docs/architecture/ocharts-serving-knobs.md.
"""

from __future__ import annotations

import gzip
import hashlib
import logging
import math
import threading
from collections.abc import Callable
from pathlib import Path

import chartcore

from .admission import (
    DEFAULT_ADMIT_TIMEOUT,
    DEFAULT_RENDER_BUDGET,
    PEAK_PER_FILE_BYTE,
    TRIM_AFTER_BYTES,
    Admission,
    RenderGate,
    trim_heap,
)
from .cache import SingleFlightLRU
from .disk_tiles import DEFAULT_TILE_DISK_BUDGET, MISSING, DiskTileStore, tile_bounds_deg
from .licence import LicenceCheck, disk_key
from .sets import CellInfo, OchartsSet, OchartsStore
from .warm import CellWarmer

log = logging.getLogger(__name__)

# Last-resort bound on cold decodes per tile; see
# docs/architecture/ocharts-serving-knobs.md for the tuning history (why 48,
# not 8 or 16).
DEFAULT_MAX_CELLS_PER_TILE = 48
MAX_CELLS_PER_TILE = DEFAULT_MAX_CELLS_PER_TILE

# `ocharts.*` config defaults (over_zoom/under_zoom/detail_gap); tuned live,
# no restart. Selection is anchored to the tile's zoom vs each cell's
# max_zoom. See docs/architecture/ocharts-serving-knobs.md.
DEFAULT_OVER_ZOOM = 4
DEFAULT_UNDER_ZOOM = 4
DEFAULT_DETAIL_GAP = 1

# Upper bound on zooms finer than the reference the detail fill may reach;
# must be > over_zoom (#Z5-FRAG, else overview tiles decode far more than
# SCAMIN shows). See docs/architecture/ocharts-serving-knobs.md.
DEFAULT_OVERVIEW_DETAIL_CUTOFF = 6

# Global chart-detail bias `B`: shows iff display_scale_denom(z) <= scamin*B.
# BOAT-WIDE not per-device — server hard-drops SCAMIN-hidden features off
# the shared tile. See docs/architecture/ocharts-serving-knobs.md.
DEFAULT_CHART_DETAIL = 1.0
CHART_DETAIL_MIN = 0.1
CHART_DETAIL_MAX = 10.0

# SCAMIN turn-on spread `k` about anchor `A` (#qqlzrkkn): `B` shifts every
# feature's turn-on zoom uniformly, `k` reshapes spacing around `A` instead.
# See docs/architecture/ocharts-serving-knobs.md.
DEFAULT_CHART_DETAIL_SPREAD = 1.0
CHART_DETAIL_SPREAD_MIN = 0.1
CHART_DETAIL_SPREAD_MAX = 2.0
DEFAULT_CHART_DETAIL_ANCHOR = 350_000.0
CHART_DETAIL_ANCHOR_MIN = 1_000.0
CHART_DETAIL_ANCHOR_MAX = 10_000_000.0

# Bump when chartcore's tile bytes change for the same SENC input; folds
# into BOTH the RAM cache key and the HTTP ETag (`_ocharts_tile`) — they
# must move together, and only ever upward. See docs/architecture/tile-schema-version.md.
TILE_SCHEMA_VERSION = 40

# Per-tile cut parallelism (#PERF-CHARTCORE): `1` is the exact serial path;
# `>1` reassembles in the same cell order, so output is byte-identical
# regardless. See docs/architecture/ocharts-serving-knobs.md.
DEFAULT_PARALLELISM = 3
PARALLELISM_MAX = 16

DEFAULT_CELL_BUDGET = 512 * 1024 * 1024
DEFAULT_TILE_BUDGET = 64 * 1024 * 1024
# A HazardIndex is just the buffered unsafe-water rings for one cell at one
# (safety_depth_m, margin_m, air_draft_m) — far lighter than a decoded cell's full
# feature/attribute model (`chartcore::python::hazard_bytes` vs. `cell_bytes`),
# so this budget is a fraction of `DEFAULT_CELL_BUDGET`. See `OchartsService.
# hazards`/`hazard_index` below, and the repo root's `ROUTING_TODO.md`
# ("HazardIndex cache"): `/routing/plan` rebuilt every candidate cell's
# hazard union on every request, measured as the largest remaining
# per-request cost (~0.44s/request even with the cell itself warm) before
# the raster rewrite.
DEFAULT_HAZARD_BUDGET = 32 * 1024 * 1024
# `chartcore.LandHazardBake`s, keyed on (cell, margin_m) — deliberately NOT
# depth (see `OchartsService.land_bakes`/`land_bake` below): a per-cell,
# depth-independent land-hazard distance field, one whole-cell bake per
# margin a caller has actually asked for. Not on any live serve path today
# (`chartcore::routing::raster::bake`'s own module docs — a smaller fix
# elsewhere closed the resolution-miss gap this was built to investigate),
# but it is a real cache with a real byte cost once anything DOES build one,
# so it gets its own budget rather than sharing `hazard_budget` silently.
DEFAULT_LAND_BAKE_BUDGET = 16 * 1024 * 1024

# Same role as TILE_SCHEMA_VERSION above, for `land_bake`'s own RAM cache
# (`land_bake_key`): a hand-bumped counter for "the BUILD, not the input,
# changed" — any chartcore-side change to `Cell::build_land_hazard_bake`
# (its distance-field algorithm, its self-limiting MAX_CELL_M/HARD_MAX_DIM
# rule, depth-independence handling, ...) that alters a `LandHazardBake`
# for the SAME decoded cell + margin_m must bump this, or a long-lived
# process that already built and cached a bake under the old code keeps
# handing it out unchanged after the fix lands — same "cache key doesn't
# know the code changed" shape as `TILE_SCHEMA_VERSION`'s own docstring
# warns about (a re-`load_cell` after `cs.sequence` bumps is the ONLY
# other thing that would evict an entry, and a code-only fix bumps
# neither). Not wired into any live serve path yet (see the budget
# comment above), so nothing external can observe a stale bake through an
# HTTP ETag the way a stale tile can today — but the RAM cache itself
# already has the identical staleness shape as soon as ANYTHING calls
# `land_bake` more than once across a code change, so this is threaded
# through now rather than left for whoever wires in the first live
# consumer to discover missing, the same way TILE_SCHEMA_VERSION's own
# history (v29-v35 above) shows is easy to forget under real time
# pressure.
LAND_BAKE_SCHEMA_VERSION = 1

# Warm overview cells in background (see .warm); on by default since the
# boat's server is always-on, mostly idle, and charts are local — only
# costs idle CPU.
DEFAULT_WARM_OVERVIEW = True

# The finest zoom the warmer pre-renders `/tiles/all` for, into the disk
# tile cache (see .disk_tiles and .warm's pre-render phase). Zoomed-out
# union tiles are the slow ones cold (z7 4.2 s, z5-6 ~9 s measured on the
# Pi) while z12+ are ~0.1 s, so pre-rendering stops at 11: the whole chart
# area down to z11 is a few thousand tiles, done once in idle time and kept
# across restarts. None disables pre-rendering (the disk cache still fills
# from real requests).
DEFAULT_PRETILE_MAX_ZOOM: int | None = 11


def _intersects(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


#: Zoom of the tile `OchartsService.cells_at` classifies a point by (~600 m
#: at the equator, less north of it). Fine enough for an advisory badge.
CELLS_AT_ZOOM = 16


def _lonlat_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    """The web-mercator tile (x, y) at zoom `z` holding (lon, lat)."""
    n = 1 << z
    lat = max(-85.05112878, min(85.05112878, lat))
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def _charting_cells(
    cells: list[CellInfo], z: int, x: int, y: int
) -> list[tuple[CellInfo, str]]:
    """Cells with anything to say about tile z/x/y: "full", "partial", or
    (no coverage records) the extent's non-authoritative guess. Coverage
    decides, not the extent rect — cheap Rust ring-winding test, no decode.
    """
    bounds = tile_bounds_deg(z, x, y)
    charting: list[tuple[CellInfo, str]] = []
    for c in cells:
        if c.coverage is None:
            if _intersects(c.extent, bounds):
                charting.append((c, "partial"))
            continue
        state = c.coverage.tile_state(z, x, y)
        if state != "none":
            charting.append((c, state))
    return charting


class DaemonUnavailable(RuntimeError):
    """oexserverd could not be acquired or started."""


def _load_s52(explicit: Path | None) -> tuple[object | None, str | None, str | None]:
    """Resolve S-52 lookup tables for ATON symbol resolution.

    Missing tables degrade rather than fail, but also silently disable
    chartcore's SCAMIN declutter for every class; no implicit downloads
    (offline boot stays deterministic).
    """
    path = str(explicit) if explicit else None
    if not path:
        cache = Path(chartcore.s52_default_cache_dir())
        if (cache / "chartsymbols.xml").is_file():
            path = str(cache)
    if not path:
        log.warning(
            "no S-52 lookup data (set the config's ocharts.s52_path, or run "
            "`chartcore ingest --fetch-s52` once); ATON symbols (sym_s) "
            "will not be resolved on o-charts sets"
        )
        return None, None, None
    try:
        return chartcore.S52.load(path), path, None
    except Exception as e:  # degrade, never fail serving over presentation data
        log.warning("S-52 lookup data at %s unusable (%s); ATON symbols will not be resolved", path, e)
        return None, path, str(e)


class OchartsService:
    """The o-charts serving facade.

    Built from `config.ocharts` by `mivnav.api.deps`; that one-to-one
    correspondence is what makes rebuilding on a config change sufficient
    (see `mivnav.config.derived`).
    """

    def __init__(
        self,
        sets_dir: Path,
        daemon_dir: Path,
        work_dir: Path,
        cell_budget: int = DEFAULT_CELL_BUDGET,
        tile_budget: int = DEFAULT_TILE_BUDGET,
        hazard_budget: int = DEFAULT_HAZARD_BUDGET,
        land_bake_budget: int = DEFAULT_LAND_BAKE_BUDGET,
        s52_path: Path | None = None,
        rescan_interval: float | None = None,
        warm_overview: bool = DEFAULT_WARM_OVERVIEW,
        over_zoom: int = DEFAULT_OVER_ZOOM,
        under_zoom: int = DEFAULT_UNDER_ZOOM,
        detail_gap: int = DEFAULT_DETAIL_GAP,
        overview_detail_cutoff: int = DEFAULT_OVERVIEW_DETAIL_CUTOFF,
        max_cells_per_tile: int = DEFAULT_MAX_CELLS_PER_TILE,
        chart_detail: float = DEFAULT_CHART_DETAIL,
        chart_detail_spread: float = DEFAULT_CHART_DETAIL_SPREAD,
        chart_detail_anchor: float = DEFAULT_CHART_DETAIL_ANCHOR,
        parallelism: int = DEFAULT_PARALLELISM,
        render_budget: int = DEFAULT_RENDER_BUDGET,
        admit_timeout: float = DEFAULT_ADMIT_TIMEOUT,
        tile_disk_dir: Path | None = None,
        tile_disk_budget: int = DEFAULT_TILE_DISK_BUDGET,
        pretile_max_zoom: int | None = DEFAULT_PRETILE_MAX_ZOOM,
        disk_key_source: Callable[[], bytes] | None = None,
    ) -> None:
        self.sets_dir = sets_dir
        self.daemon_dir = daemon_dir
        self.work_dir = work_dir
        # Per-instance (not module-global) so a config change, which rebuilds
        # this service, picks up new values. See DEFAULT_* above.
        self.over_zoom = over_zoom
        self.under_zoom = under_zoom
        self.detail_gap = detail_gap
        self.overview_detail_cutoff = overview_detail_cutoff
        self.max_cells_per_tile = max_cells_per_tile
        self.chart_detail = chart_detail
        self.chart_detail_spread = chart_detail_spread
        self.chart_detail_anchor = chart_detail_anchor
        self.parallelism = parallelism
        # Memory admission for cold renders — see .admission for the
        # incident and the measurements behind it.
        self.render_gate = RenderGate(render_budget, admit_timeout)
        # On-disk size per cell path: the render weight's input, stat'ed once.
        self._cell_file_bytes: dict[Path, int] = {}
        # The S-52 tables are immutable and shared by every cell this
        # process decodes (the service is a process singleton).
        self._s52, self._s52_source, self._s52_error = _load_s52(s52_path)
        self.cells: SingleFlightLRU = SingleFlightLRU(cell_budget)
        self.tiles: SingleFlightLRU = SingleFlightLRU(tile_budget)
        # Rendered /tiles/all tiles, persisted across restarts (see
        # .disk_tiles — including the user's licensing decision). None dir
        # or a 0 budget disables it; RAM caching is unaffected either way.
        # It starts locked: the licence check below supplies the
        # machine-bound key and opens it (see .licence).
        self.disk_tiles = DiskTileStore(tile_disk_dir, tile_disk_budget if tile_disk_dir else 0)
        # (set id, sequence) of sets this machine cannot decrypt — kept out
        # of the union tiles, see .licence.
        self._refused: frozenset[tuple[str, int]] = frozenset()
        # set id -> (sequence, has encrypted cells) — see `licensed`.
        self._licensed: dict[str, tuple[int, bool]] = {}
        self.pretile_max_zoom = pretile_max_zoom
        # `chartcore.HazardIndex`es, keyed on (set id, sequence, cell,
        # safety_depth_m, margin_m, air_draft_m) — see `hazard_key`/
        # `hazard_index` below.
        # A third RAM byte-LRU sibling to `cells`/`tiles`, same shape.
        self.hazards: SingleFlightLRU = SingleFlightLRU(hazard_budget)
        # `chartcore.LandHazardBake`s, keyed on (set id, sequence, cell,
        # margin_m) — NO depth in the key, deliberately (see
        # `DEFAULT_LAND_BAKE_BUDGET`'s own docs and `land_bake_key`/
        # `land_bake` below). A fourth RAM byte-LRU sibling to
        # `cells`/`tiles`/`hazards`, same shape.
        self.land_bakes: SingleFlightLRU = SingleFlightLRU(land_bake_budget)
        self.store = OchartsStore(self.sets_dir, self._read_header, rescan_interval)
        self._daemon = None
        self._daemon_lock = threading.Lock()
        self._daemon_error: str | None = None
        # Composited tiles' cell-coverage seams can disagree in
        # generalization; tracked (not fixed) since the real fix costs
        # per-tile boolean ops on a Pi. See status()["seam_tiles"].
        self._seam_tiles: set[tuple[str, int, int, int]] = set()
        # Tied to this object's lifetime, not the process's: the service
        # itself is built lazily on first chart request, so warming inherits
        # "nothing happens until something asks for a chart" for free.
        self._warmer = CellWarmer(self) if warm_overview else None
        if self._warmer is not None:
            self._warmer.start()
        # Only with a disk store: RAM needs no licence check (user,
        # 2026-11-05). `disk_key_source` is for tests; the real key comes
        # from the o-charts fingerprint.
        self._licence: LicenceCheck | None = None
        if self.disk_tiles.configured:
            self._licence = LicenceCheck(self, disk_key_source or self._fingerprint_key)
            self._licence.start()

    def close(self) -> None:
        """Stop the warmer and daemon, and drop the caches.

        Mandatory on supersession/shutdown — an unstopped `oexserverd`
        subprocess gets orphaned. Idempotent.
        """
        if self._licence is not None:
            self._licence.stop()
        if self._warmer is not None:
            self._warmer.stop()
        with self._daemon_lock:
            daemon, self._daemon = self._daemon, None
        if daemon is not None:
            try:
                daemon.stop()
            except Exception:  # noqa: BLE001 — teardown must not raise
                log.exception("stopping oexserverd failed")
        self.cells.clear()
        self.tiles.clear()
        self.hazards.clear()
        self.land_bakes.clear()
        self._seam_tiles.clear()

    # -- daemon ------------------------------------------------------------

    def _needs_daemon(self, path: Path) -> bool:
        return chartcore.chart_kind(str(path)) in ("oesu", "oesenc")

    def daemon(self):
        """The running daemon, starting it on first use."""
        with self._daemon_lock:
            if self._daemon is not None and self._daemon.state() == "running":
                return self._daemon
            try:
                exe = chartcore.ensure_daemon(str(self.daemon_dir))
                if self._daemon is None:
                    self._daemon = chartcore.Daemon(exe, str(self.work_dir))
                    self._daemon.start()
                else:
                    self._daemon.restart()
                if not self._daemon.wait_for_state("running", 15.0):
                    raise DaemonUnavailable(
                        f"oexserverd did not reach running: {self._daemon.last_error()}"
                    )
                self._daemon_error = None
                # A restarted daemon may now succeed where a dead one failed;
                # clear all four caches (cells, tiles, hazards, land bakes) so
                # a memoized decode failure doesn't stay a permanent hole even
                # after recovery.
                self.cells.clear_errors()
                self.tiles.clear_errors()
                self.hazards.clear_errors()
                self.land_bakes.clear_errors()
                return self._daemon
            except Exception as e:
                self._daemon_error = str(e)
                raise

    def daemon_status(self) -> dict:
        with self._daemon_lock:
            if self._daemon is None:
                return {"state": "not started", "error": self._daemon_error}
            return {"state": self._daemon.state(), "error": self._daemon.last_error() or self._daemon_error}

    def daemon_exe(self) -> str:
        """Path to the vendor binary, downloading it if missing."""
        return chartcore.ensure_daemon(str(self.daemon_dir))

    def fingerprint(self) -> tuple[str, str]:
        """(xfprName, xfpr hex) for shop registration."""
        return chartcore.get_fingerprint(self.daemon_exe(), str(self.work_dir / "fpr"))

    def _fingerprint_key(self) -> bytes:
        """The disk tile cache key: this machine's o-charts fingerprint."""
        return disk_key(*self.fingerprint())

    # -- licence -----------------------------------------------------------

    def set_refused(self, refused: frozenset[tuple[str, int]]) -> None:
        """Leave these (set id, sequence) out of the union tiles — the
        licence check found this machine cannot decrypt them. Keyed on the
        sequence: a reinstalled set is back in until the next check."""
        self._refused = refused

    def wait_licence(self, timeout: float | None = None) -> bool:
        """Block until the startup licence check is decided (tests)."""
        return self._licence.wait(timeout) if self._licence is not None else True

    def licensed(self, cs: OchartsSet) -> bool:
        """Does this set hold encrypted (o-charts licensed) cells? What the
        device cap (.devices) protects; freenauticalchart.net sets are CC0.
        Memoized per sequence: it is asked on every tile request."""
        memo = self._licensed.get(cs.id)
        if memo is not None and memo[0] == cs.sequence:
            return memo[1]
        paths = [c.path for c in cs.cells] + [cs.directory / n for n in cs.cell_errors]
        value = any(self._needs_daemon(p) for p in paths)
        self._licensed[cs.id] = (cs.sequence, value)
        return value

    def _union_sets(self, free_only: bool = False) -> list[OchartsSet]:
        """The sets the union tiles are built from, sorted by id: every set
        with cells that the licence check did not refuse — and, for
        ``free_only`` (``/tiles/free``), that is not licensed."""
        refused = self._refused
        return sorted(
            (
                cs
                for cs in self.sets().values()
                if cs.cells
                and (cs.id, cs.sequence) not in refused
                and not (free_only and self.licensed(cs))
            ),
            key=lambda cs: cs.id,
        )

    # -- cells -------------------------------------------------------------

    def _read_header(self, path: Path, key: str) -> dict:
        daemon = self.daemon() if self._needs_daemon(path) else None
        return chartcore.read_header(str(path), key, daemon)

    def open_cell(self, path: Path, key: str):
        daemon = self.daemon() if self._needs_daemon(path) else None
        try:
            return chartcore.Cell.open(str(path), key, daemon, self._s52)
        except Exception as e:
            # Name the offending cell: a single corrupt/truncated .oesu blanks
            # every tile that charts it, and the bare chartcore error carries
            # only the OSENC record, never which file produced it.
            e.add_note(f"cell: {path.name} ({path})")
            raise

    def cell_key(self, cs: OchartsSet, cell: CellInfo) -> tuple:
        """Cell-cache key. Carries the set's ``sequence``, so a reinstalled
        set's decoded cells are simply never hit again and age out."""
        return ("cell", cs.id, cs.sequence, cell.path.name)

    def load_cell(self, cs: OchartsSet, cell: CellInfo):
        """The decoded cell: cached, or decoded through the daemon now.

        The one decode path — tile serving and the warmer share the
        single-flight/LRU instead of racing to decode the same cell.
        """

        def load():
            decoded = self.open_cell(cell.path, cell.key)
            return decoded, decoded.approx_bytes

        return self.cells.get(self.cell_key(cs, cell), load)

    def hazard_key(
        self,
        cs: OchartsSet,
        cell: CellInfo,
        safety_depth_m: float,
        margin_m: float,
        air_draft_m: float = 0.0,
    ) -> tuple:
        """Hazard-cache key: `cell_key` plus the three floats a
        `HazardIndex` is actually built for — a different draft, margin, or
        air draft is a genuinely different unsafe-water polygon, not a
        cache hit on the wrong one. `air_draft_m` defaults to `0.0` (off)
        so every pre-existing caller that never mentions it keeps hitting
        the exact same cache entries it always did."""
        return (*self.cell_key(cs, cell), safety_depth_m, margin_m, air_draft_m)

    def hazard_index(
        self,
        cs: OchartsSet,
        cell: CellInfo,
        safety_depth_m: float,
        margin_m: float,
        air_draft_m: float = 0.0,
    ):
        """The cell's `chartcore.HazardIndex` at `safety_depth_m`/`margin_m`/
        `air_draft_m` — cached, or built now via `load_cell` (itself cached).

        `mivnav.features.routing.hazards.hazard_indexes_for_line` calls this
        once per candidate cell per request; before this cache existed that
        rebuilt the same union from the same decoded cell on EVERY request,
        measured as the largest remaining per-request cost even with the
        cell itself warm (~0.44s/request — see `ROUTING_TODO.md`'s
        "HazardIndex cache" item at the repo root). `None` is a legitimate
        cached value (a cell with nothing unsafe at this depth/margin/air
        draft), same "`event.is_set()` marks loaded, not `value is not
        None`" contract `cache.SingleFlightLRU` already relies on for an
        empty tile. `air_draft_m=0.0` (the default) means no
        `BRIDGE`/`CBLOHD` vertical-clearance checking at all — see
        `chartcore::routing::hazards::build_hazard_index`'s own "Air draft"
        docs.
        """

        def load():
            decoded = self.load_cell(cs, cell)
            idx = decoded.hazard_index(safety_depth_m, margin_m, air_draft_m)
            return idx, idx.approx_bytes if idx is not None else 1

        return self.hazards.get(self.hazard_key(cs, cell, safety_depth_m, margin_m, air_draft_m), load)

    def land_hazard_key(self, cs: OchartsSet, cell: CellInfo, margin_m: float) -> tuple:
        """Land-only-hazard cache key: a `"land_hazard"` tag plus `cell_key`
        plus `margin_m` — no `safety_depth_m`/`air_draft_m`, unlike
        `hazard_key`: `chartcore.Cell.land_hazard_index` takes neither (see
        that method's own docs — `LNDARE`/`UNSARE`/`SLCONS` are gated by
        neither). Shares the SAME `self.hazards` pool `hazard_index` uses
        (same value type, same budget, no reason for a separate one) —
        the `"land_hazard"` tag keeps this from ever colliding with a real
        `hazard_key` tuple, which always starts with `cell_key`'s own
        `"cell"` tag instead."""
        return ("land_hazard", *self.cell_key(cs, cell), margin_m)

    def land_hazard_index(self, cs: OchartsSet, cell: CellInfo, margin_m: float):
        """The cell's `chartcore.HazardIndex` from `LNDARE`/`UNSARE`/
        `SLCONS` ALONE — cached, or built now via `load_cell` (itself
        cached). For `mivnav.features.routing.hazards.hazard_indexes_for_bbox`
        to union in WITHOUT ever authority-clipping it — see
        `chartcore::routing::hazards`' own "Authority-clipping exemption
        for land" docs for the real bug this exists to close: a coarser
        chart's correct coastline silently erased along a thin strip
        wherever a finer chart's coverage overlapped ground that finer
        chart never itself re-digitized as land. Same "`None` is a
        legitimate cached value" contract `hazard_index` already has.
        """

        def load():
            decoded = self.load_cell(cs, cell)
            idx = decoded.land_hazard_index(margin_m)
            return idx, idx.approx_bytes if idx is not None else 1

        return self.hazards.get(self.land_hazard_key(cs, cell, margin_m), load)

    def land_bake_key(self, cs: OchartsSet, cell: CellInfo, margin_m: float) -> tuple:
        """Land-bake cache key: `LAND_BAKE_SCHEMA_VERSION` plus `cell_key`
        plus `margin_m` ONLY — no `safety_depth_m`, unlike `hazard_key`. A
        `chartcore.LandHazardBake` is depth-independent by construction
        (`chartcore::routing::raster::bake`'s own docs), so the same bake
        genuinely serves every depth a caller might separately ask for;
        folding depth into this key would just fragment one real cache
        entry into several identical ones. See `LAND_BAKE_SCHEMA_VERSION`'s
        own docs for why the version rides along even though nothing
        external depends on it yet."""
        return ("land_bake", LAND_BAKE_SCHEMA_VERSION, *self.cell_key(cs, cell), margin_m)

    def land_bake(self, cs: OchartsSet, cell: CellInfo, margin_m: float):
        """The cell's `chartcore.LandHazardBake` at `margin_m` — cached, or
        built now via `load_cell` (itself cached). Same "`None` is a
        legitimate cached value" contract `hazard_index` already has: a
        cell with no depth-independent hazard, or too large to bake usefully
        (`CellHazardBake::build`'s own self-limiting rule), caches `None`
        rather than re-attempting the build on every call.

        Not called anywhere on a live serve path yet — see this module's
        own `DEFAULT_LAND_BAKE_BUDGET` docs for why the cache exists
        regardless.
        """

        def load():
            decoded = self.load_cell(cs, cell)
            bake = decoded.build_land_hazard_bake(margin_m)
            return bake, bake.approx_bytes if bake is not None else 1

        return self.land_bakes.get(self.land_bake_key(cs, cell, margin_m), load)

    # -- catalog / tiles ---------------------------------------------------

    def sets(self) -> dict[str, OchartsSet]:
        return self.store.sets()

    def get(self, set_id: str) -> OchartsSet | None:
        return self.store.get(set_id)

    def invalidate(self) -> None:
        self.store.invalidate()

    def catalog_entries(self) -> list[dict]:
        """Catalog descriptors, shaped exactly like the PMTiles sets'."""
        entries = []
        for cs in self.sets().values():
            if not cs.cells:
                continue
            entries.append(
                {
                    "id": cs.id,
                    "name": cs.name,
                    "bounds": list(cs.bounds),
                    "min_zoom": cs.min_zoom,
                    "max_zoom": cs.max_zoom,
                    "sequence": cs.sequence,
                    "tiles": f"/tiles/{cs.id}/{{z}}/{{x}}/{{y}}",
                    # On-demand sets can't enumerate layers without decoding
                    # every cell, so they advertise the client-styled layers.
                    "vector_layers": STATIC_VECTOR_LAYERS,
                    # An "ocharts" set never becomes its own MapLibre source;
                    # it folds into the shared `/tiles/all` union instead
                    # (see catalog() docstring in mivnav.api.charts).
                    "kind": "ocharts",
                    # Encrypted o-charts cells: only registered devices are
                    # served them (see .devices); the client leaves such sets
                    # out and draws `/tiles/free` while it is not one.
                    "licensed": self.licensed(cs),
                }
            )
        return entries

    def cells_at(self, lon: float, lat: float, free_only: bool = False) -> list[dict]:
        """Every union cell that charts the spot (lon, lat), finest first —
        the frontend's overscale / "zoom in for detail" badge. Coverage is
        asked at the `CELLS_AT_ZOOM` tile holding the point (an advisory
        badge, not a hazard test); a cell without coverage records falls
        back to its extent rect, as tiling does."""
        z = CELLS_AT_ZOOM
        x, y = _lonlat_tile(lon, lat, z)
        here = (lon, lat, lon, lat)
        found = []
        for cs in self._union_sets(free_only):
            near = [c for c in cs.cells if _intersects(c.extent, here)]
            for c, _ in _charting_cells(near, z, x, y):
                found.append(
                    {"set": cs.id, "name": c.name, "scale": c.scale, "max_zoom": c.max_zoom}
                )
        found.sort(key=lambda d: (d["scale"], d["set"], d["name"]))
        return found

    def tile(self, cs: OchartsSet, z: int, x: int, y: int) -> bytes | None:
        """Gzipped MVT tile, or None where the set has nothing."""
        if self._warmer is None:
            return self._tile(cs, z, x, y)
        # Bracket the whole request: the warmer must sit out while one is
        # *running*, not just after it lands (see CellWarmer._idle_for —
        # both calls update a counter under a lock the warmer never holds).
        self._warmer.note_request()
        try:
            return self._tile(cs, z, x, y)
        finally:
            self._warmer.note_done()

    @property
    def scamin_bias_key(self) -> tuple[float, float, float]:
        """The three SCAMIN-bias numbers, as one cache/ETag component.

        All three must version the tile bytes (same hazard as
        TILE_SCHEMA_VERSION) — anchor rides along even when inert at
        spread==1, since conditional keying could serve stale tiles.
        """
        return (self.chart_detail, self.chart_detail_spread, self.chart_detail_anchor)

    def _tile(self, cs: OchartsSet, z: int, x: int, y: int) -> bytes | None:
        # Must version on everything that changes the tile bytes for this
        # z/x/y, and stay in lockstep with the ETag in `_ocharts_tile` — same
        # inputs, or the RAM cache and the HTTP validator disagree.
        cache_key = (
            "tile",
            TILE_SCHEMA_VERSION,
            cs.id,
            cs.sequence,
            self.scamin_bias_key,
            z,
            x,
            y,
        )

        def load():
            data = self._cut_tile(cs, z, x, y)
            # Level 1, not 6: the Pi's CPU is the scarce resource here, not
            # LAN bandwidth (see CLAUDE.md's deployment invariant).
            packed = gzip.compress(data, 1) if data is not None else None
            return packed, len(packed) if packed else 1

        return self.tiles.get(cache_key, load)

    def _drop_broken_cells(
        self, items: list[tuple[OchartsSet, CellInfo]]
    ) -> list[tuple[OchartsSet, CellInfo]]:
        """Exclude cells whose decode is already memoized as failed (#lsyvyxww).

        Without this, PyO3's `?` means one broken cell aborts the whole tile,
        including unrelated healthy sets. See
        docs/architecture/ocharts-broken-cell-handling.md.
        """
        kept = []
        for cs, c in items:
            err = self.cells.peek_error(self.cell_key(cs, c))
            if err is not None:
                log.warning(
                    "cell %s (set %s) has a memoized decode failure (%s); "
                    "excluding it from this tile rather than failing the "
                    "whole composite",
                    c.name, cs.id, err,
                )
                continue
            kept.append((cs, c))
        return kept

    def _broken_cell_error(
        self,
        default_cs: OchartsSet | None,
        items: list[CellInfo] | list[tuple[OchartsSet, CellInfo]],
    ) -> BaseException:
        """The memoized error of whichever candidate cell has one (the
        "every cell is broken" branch). See
        docs/architecture/ocharts-broken-cell-handling.md.
        """
        for item in items:
            cs, c = item if isinstance(item, tuple) else (default_cs, item)
            err = self.cells.peek_error(self.cell_key(cs, c))
            if err is not None:
                return err
        return RuntimeError("every candidate cell failed to decode")

    def _cell_weight(self, cell: CellInfo) -> int:
        size = self._cell_file_bytes.get(cell.path)
        if size is None:
            try:
                size = cell.path.stat().st_size
            except OSError:
                size = 0
            self._cell_file_bytes[cell.path] = size
        return size

    def _admission(self, cells: list[CellInfo]) -> Admission:
        """An ``admit`` hook for one serve call over `cells` (indexed as the
        serve call's specs are): weighs exactly the cells chartcore says it
        will load, each once (a donor is usually also a kept cell — one
        decode), at the measured peak-per-disk-byte, which already includes
        the donors' extra unmasked cuts."""
        return Admission(
            self.render_gate,
            lambda idx: PEAK_PER_FILE_BYTE * sum(self._cell_weight(cells[i]) for i in set(idx)),
        )

    @staticmethod
    def _finish_render(admission: Admission) -> None:
        if admission.release() >= TRIM_AFTER_BYTES:
            trim_heap()

    def _cut_tile(self, cs: OchartsSet, z: int, x: int, y: int) -> bytes | None:
        # Selection + cut + mask + merge live in Rust; Python keeps only cell
        # enumeration, the cell LRU/daemon behind load_cell, and the
        # no-data precondition.
        raw_charting = [c for c, _ in _charting_cells(cs.cells, z, x, y)]
        charting = [c for _, c in self._drop_broken_cells([(cs, c) for c in raw_charting])]
        claim_allowed = bool(cs.cells) and _intersects(cs.bounds, tile_bounds_deg(z, x, y))
        while True:
            if raw_charting and not charting:
                # Every cell that would chart this tile is broken; don't let
                # an empty spec list + claim_allowed=True lie "nothing here".
                # See docs/architecture/ocharts-broken-cell-handling.md.
                raise self._broken_cell_error(cs, raw_charting)
            specs = [(i, c.scale, c.max_zoom, c.name, c.coverage) for i, c in enumerate(charting)]
            admission = self._admission(charting)
            try:
                data, overflow = chartcore.serve_tile(
                    specs,
                    z,
                    x,
                    y,
                    self.over_zoom,
                    self.under_zoom,
                    self.detail_gap,
                    self.overview_detail_cutoff,
                    self.max_cells_per_tile,
                    self.chart_detail,
                    self.chart_detail_spread,
                    self.chart_detail_anchor,
                    self.parallelism,
                    claim_allowed,
                    lambda i: self.load_cell(cs, charting[i]),
                    # The set's real display max_zoom (frontend source
                    # `maxzoom`) makes the SCAMIN drop exact for coarse-only
                    # tiles; None for a cell-less set (max_zoom would raise).
                    cs.max_zoom if cs.cells else None,
                    admission,
                )
            except Exception:
                # Retry once excluding newly-broken cells rather than memoize
                # this attempt's transient failure as a permanently dead tile.
                # See docs/architecture/ocharts-broken-cell-handling.md.
                retried = [c for _, c in self._drop_broken_cells([(cs, c) for c in charting])]
                if len(retried) == len(charting):
                    raise
                charting = retried
                continue
            finally:
                # Release this attempt's admission (and trim the heap after a
                # heavy one) on EVERY exit — success, retry, or raise.
                self._finish_render(admission)
            if overflow is not None:
                self._log_cap_overflow(z, x, y, *overflow)
            return data

    def _log_cap_overflow(
        self,
        z: int,
        x: int,
        y: int,
        rescued: bool,
        kept: int,
        cap: int,
        dropped: list[tuple[str, int]],
    ) -> None:
        """The tile cap trimmed cells. A rescued overflow is benign (kept
        overzoomed specks to avoid a hole); non-rescued is loud — it evicts
        an authoritative cell, reopening a seam/hole; raise max_cells_per_tile.
        """
        names = ", ".join(f"{name} 1:{scale}" for name, scale in dropped)
        if rescued:
            log.debug(
                "tile z%d/%d/%d: %d rescued cells, keeping the %d nearest this "
                "zoom's scale (dropping %s)",
                z, x, y, kept, cap, names,
            )
        else:
            log.error(
                "tile z%d %s: %d cells are authoritative over this tile (each "
                "charts ground no finer kept cell does), over the "
                "max_cells_per_tile=%d safety guard — dropping the %d furthest "
                "from this zoom's scale (%s). This is not routine trimming: it "
                "drops chart and reopens a seam/hole. Raise "
                "ocharts.max_cells_per_tile; this indicates a bug or a "
                "pathologically fragmented set",
                z, tile_bounds_deg(z, x, y), kept, cap, len(dropped), names,
            )

    # -- union serving (/tiles/all, #qwxtvtwo) ------------------------------
    # Composites every subscribed set into ONE tile (one source/~64 layers,
    # not N sets x ~64). On-demand sets only. See
    # docs/architecture/ocharts-union-tile.md.

    def union_version(self, free_only: bool = False) -> tuple[tuple[str, int], ...]:
        """(set id, sequence) per o-charts set with cells, sorted by id —
        feeds both the RAM cache key and the ETag so they can't drift apart.
        Sorted since mvt::select's tie-break falls back to cell name.
        """
        return tuple((cs.id, cs.sequence) for cs in self._union_sets(free_only))

    def tile_all(self, z: int, x: int, y: int) -> bytes | None:
        """Gzipped MVT tile unioning every subscribed o-charts set, or None
        where none of them has anything here."""
        if self._warmer is None:
            return self._tile_all(z, x, y)
        self._warmer.note_request()
        try:
            return self._tile_all(z, x, y)
        finally:
            self._warmer.note_done()

    def _tile_all(self, z: int, x: int, y: int) -> bytes | None:
        # Like `_tile`'s cache_key, but keyed on `union_version()` (every
        # set's identity + sequence) in place of one set's.
        cache_key = (
            "tile_all", TILE_SCHEMA_VERSION, self.union_version(), self.scamin_bias_key, z, x, y,
        )

        def load():
            version = self.disk_version()
            packed = self.disk_tiles.get(version, z, x, y)
            if packed is MISSING:
                data = self._cut_tile_all(z, x, y)
                packed = gzip.compress(data, 1) if data is not None else None
                self.disk_tiles.put(version, z, x, y, packed)
            return packed, len(packed) if packed else 1

        return self.tiles.get(cache_key, load)

    def tile_free(self, z: int, x: int, y: int) -> bytes | None:
        """Like :meth:`tile_all`, but over the sets that are not licensed —
        what a device without an o-charts registration is served (see
        .devices). RAM-cached only: the disk cache holds one union version,
        and this is the fallback for an unregistered screen, not the hot path."""
        if self._warmer is None:
            return self._tile_free(z, x, y)
        self._warmer.note_request()
        try:
            return self._tile_free(z, x, y)
        finally:
            self._warmer.note_done()

    def _tile_free(self, z: int, x: int, y: int) -> bytes | None:
        sets = self._union_sets(free_only=True)
        cache_key = (
            "tile_free",
            TILE_SCHEMA_VERSION,
            tuple((cs.id, cs.sequence) for cs in sets),
            self.scamin_bias_key,
            z,
            x,
            y,
        )

        def load():
            data = self._cut_tile_all(z, x, y, sets)
            packed = gzip.compress(data, 1) if data is not None else None
            return packed, len(packed) if packed else 1

        return self.tiles.get(cache_key, load)

    def disk_version(self) -> str:
        """Directory name in the disk tile cache for the current union
        tile bytes — see .disk_tiles's "Invalidation". The RAM key's inputs
        plus what a rebuilt service would change (the selection knobs, the
        S-52 library), because the disk outlives the service."""
        return self._disk_digest(self.union_version())

    def _disk_digest(self, sets_part: object) -> str:
        # The tuple's shape is the on-disk directory name: changing it
        # orphans every tile on every boat, so leave it alone.
        inputs = (
            TILE_SCHEMA_VERSION,
            sets_part,
            self.scamin_bias_key,
            self.over_zoom,
            self.under_zoom,
            self.detail_gap,
            self.overview_detail_cutoff,
            self.max_cells_per_tile,
            self._s52_source,
            self._s52.lookup_count if self._s52 else None,
        )
        return hashlib.sha1(repr(inputs).encode()).hexdigest()[:16]

    def disk_manifest(self) -> tuple[str, dict]:
        """The disk version and its manifest, from one snapshot of the sets
        — see .disk_tiles's "Carry-over". ``base`` is the version with the
        sets taken out, plus the one thing every union tile reads from all
        of them (``set_max_zoom`` in ``_cut_tile_all``)."""
        sets = self._union_sets()
        version = self._disk_digest(tuple((cs.id, cs.sequence) for cs in sets))
        set_max_zoom = max((cs.max_zoom for cs in sets), default=None)
        manifest = {
            "base": self._disk_digest(("all sets", set_max_zoom)),
            "sets": {
                cs.id: {
                    "sequence": cs.sequence,
                    "bounds": list(cs.bounds),
                    "cells": [list(c.extent) for c in cs.cells],
                }
                for cs in sets
            },
        }
        return version, manifest

    def _cut_tile_all(
        self, z: int, x: int, y: int, sets: list[OchartsSet] | None = None
    ) -> bytes | None:
        # Sorted by id so identically-named cells from overlapping
        # subscriptions flatten in a deterministic order (see union_version).
        if sets is None:
            sets = self._union_sets()
        bounds = tile_bounds_deg(z, x, y)
        raw_pool: list[tuple[OchartsSet, CellInfo]] = [
            (cs, c) for cs in sets for c, _ in _charting_cells(cs.cells, z, x, y)
        ]
        pool = self._drop_broken_cells(raw_pool)
        # No-data only where NO subscribed set's bounds reach the tile.
        claim_allowed = any(_intersects(cs.bounds, bounds) for cs in sets)
        # The real max_zoom over every set reaching this tile, not
        # serve_tile_union's fallback (max native zoom of charting cells).
        set_max_zoom = max((cs.max_zoom for cs in sets), default=None)
        while True:
            if raw_pool and not pool:
                # See docs/architecture/ocharts-broken-cell-handling.md.
                raise self._broken_cell_error(None, raw_pool)
            specs = [
                (i, c.scale, c.max_zoom, c.name, c.coverage, cs.id)
                for i, (cs, c) in enumerate(pool)
            ]
            admission = self._admission([c for _, c in pool])
            try:
                data, overflow = chartcore.serve_tile_union(
                    specs,
                    z,
                    x,
                    y,
                    self.over_zoom,
                    self.under_zoom,
                    self.detail_gap,
                    self.overview_detail_cutoff,
                    self.max_cells_per_tile,
                    self.chart_detail,
                    self.chart_detail_spread,
                    self.chart_detail_anchor,
                    self.parallelism,
                    claim_allowed,
                    lambda i: self.load_cell(pool[i][0], pool[i][1]),
                    set_max_zoom,
                    admission,
                )
            except Exception:
                # Like `_cut_tile`: retry once excluding newly-broken cells
                # rather than mark the whole union permanently dead over one
                # set's transient failure. See
                # docs/architecture/ocharts-broken-cell-handling.md.
                retried = self._drop_broken_cells(pool)
                if len(retried) == len(pool):
                    raise
                pool = retried
                continue
            finally:
                # Release this attempt's admission (and trim the heap after a
                # heavy one) on EVERY exit — success, retry, or raise.
                self._finish_render(admission)
            if overflow is not None:
                self._log_cap_overflow_union(z, x, y, *overflow)
            return data

    def _log_cap_overflow_union(
        self,
        z: int,
        x: int,
        y: int,
        rescued: bool,
        kept: int,
        cap: int,
        dropped: list[tuple[str, int]],
    ) -> None:
        """Like :meth:`_log_cap_overflow`, but for the union tile, where a
        non-rescued overflow is expected (overlapping subscriptions sharing
        one budget) rather than evidence of a bug — logged plainer.
        """
        names = ", ".join(f"{name} 1:{scale}" for name, scale in dropped)
        if rescued:
            log.debug(
                "tiles/all z%d/%d/%d: %d rescued cells, keeping the %d nearest "
                "this zoom's scale (dropping %s)",
                z, x, y, kept, cap, names,
            )
        else:
            log.warning(
                "tiles/all z%d %s: %d cells are authoritative over this tile "
                "(each charts ground no finer kept cell does), over the "
                "max_cells_per_tile=%d safety guard now shared across every "
                "subscribed set — dropping the %d furthest from this zoom's "
                "scale (%s). Expected as more sets accumulate over the same "
                "ground; raise ocharts.max_cells_per_tile if detail is missing",
                z, tile_bounds_deg(z, x, y), kept, cap, len(dropped), names,
            )

    def status(self) -> dict:
        sets = self.sets()
        return {
            "sets_dir": str(self.sets_dir),
            "daemon": self.daemon_status(),
            "s52": {
                "available": self._s52 is not None,
                "source": self._s52_source,
                "lookups": self._s52.lookup_count if self._s52 else None,
                "error": self._s52_error,
            },
            "sets": [
                {
                    "id": cs.id,
                    "name": cs.name,
                    "edition": cs.info.edition,
                    "valid_to": cs.info.valid_to,
                    "cells": len(cs.cells),
                    "cell_errors": cs.cell_errors,
                    "sequence": cs.sequence,
                }
                for cs in sets.values()
            ],
            # Kept out of the log (mivnav.api.app) but not out of reach.
            # ~1 routine topology failure per composited tile is normal.
            "gdal": chartcore.gdal_log(),
            "cell_cache": self.cells.stats(),
            "tile_cache": self.tiles.stats(),
            "disk_tile_cache": self.disk_tiles.stats(),
            "licence": self._licence.status() if self._licence is not None else {"state": "off"},
            "render_gate": self.render_gate.stats(),
            "seam_tiles": len(self._seam_tiles),
            "warm": self._warmer.status() if self._warmer else {"state": "disabled"},
        }


# Advertised MVT layers for on-demand sets (see catalog_entries). Must equal
# the frontend's styled source-layers plus `_nodata`/LNDRGN (advertised but
# unpainted) — frontend/src/style/chartStyle.vectorLayers.test.ts enforces it.
STATIC_VECTOR_LAYERS = [
    {"id": name, "minzoom": 0, "maxzoom": 16, "fields": {}}
    for name in [
        "_nodata",
        "UNSARE",
        "DEPARE",
        "DRGARE",
        "LNDARE",
        "LNDRGN",
        "DEPCNT",
        "SOUNDG",
        "COALNE",
        "SLCONS",
        "ATON",
        "TOPMAR",
        "DAYMAR",
        "LITVES",
        "LITFLT",
        "MORFAC",
        "M_NSYS",
        "LIGHTS",
        "WRECKS",
        "OBSTRN",
        "UWTROC",
        "BRIDGE",
        "RESARE",
        "ACHARE",
        "CTNARE",
        "MIPARE",
        "DMPGRD",
        "CBLARE",
        "PIPARE",
        "CBLSUB",
        "CBLOHD",
        "PIPSOL",
        "PIPOHD",
        "TSSLPT",
        "TSSCRS",
        "TSSRON",
        "TSSBND",
        "TSEZNE",
        "ISTZNE",
        "PRCARE",
        "FAIRWY",
        "MARCUL",
        "CTSARE",
        "FERYRT",
        "SILTNK",
        "PRDARE",
        "LNDMRK",
        "SBDARE",
        "SEAARE",
        "PILBOP",
        "RSCSTA",
        "SISTAT",
        "SISTAW",
        "RDOCAL",
        "RDOSTA",
    ]
]
