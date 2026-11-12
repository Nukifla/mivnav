# SPDX-License-Identifier: GPL-2.0-only
"""The ``ocharts`` feature's config slice. See
docs/architecture/ocharts-serving-knobs.md for the tuning history behind
every cell-selection/detail default below.
"""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field

from mivnav.config.base import Frozen
from mivnav.features.ocharts.admission import DEFAULT_RENDER_BUDGET
from mivnav.features.ocharts.disk_tiles import DEFAULT_TILE_DISK_BUDGET
from mivnav.features.ocharts.service import (
    CHART_DETAIL_ANCHOR_MAX,
    CHART_DETAIL_ANCHOR_MIN,
    CHART_DETAIL_MAX,
    CHART_DETAIL_MIN,
    CHART_DETAIL_SPREAD_MAX,
    CHART_DETAIL_SPREAD_MIN,
    DEFAULT_CELL_BUDGET,
    DEFAULT_CHART_DETAIL,
    DEFAULT_CHART_DETAIL_ANCHOR,
    DEFAULT_CHART_DETAIL_SPREAD,
    DEFAULT_DETAIL_GAP,
    DEFAULT_HAZARD_BUDGET,
    DEFAULT_LAND_BAKE_BUDGET,
    DEFAULT_MAX_CELLS_PER_TILE,
    DEFAULT_OVER_ZOOM,
    DEFAULT_OVERVIEW_DETAIL_CUTOFF,
    DEFAULT_PARALLELISM,
    DEFAULT_PRETILE_MAX_ZOOM,
    DEFAULT_TILE_BUDGET,
    DEFAULT_UNDER_ZOOM,
    DEFAULT_WARM_OVERVIEW,
    PARALLELISM_MAX,
)
from mivnav.rescan import DEFAULT_RESCAN_INTERVAL


def default_daemon_dir() -> Path:
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return cache_home / "mivnav" / "oexserverd"


def default_tile_disk_dir() -> Path:
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return cache_home / "mivnav" / "tiles"


def default_work_dir() -> Path:
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    base = Path(runtime) if runtime else Path(f"/tmp/mivnav-{os.getuid()}")
    return base / "mivnav-oex"


class OchartsConfig(Frozen):
    """Tunables of the on-demand o-charts service — almost all of it feeds
    ``OchartsService`` construction directly. No ``sets_dir`` (M-DATA-3):
    the chart-sets directory is now ``data_root/ocharts``, so
    ``ocharts.runtime.build_ocharts_service`` keys on
    ``(data_root, OchartsConfig)`` together rather than this slice alone."""

    daemon_dir: Path = Field(default_factory=default_daemon_dir)
    work_dir: Path = Field(default_factory=default_work_dir)
    # None = auto-detect chartcore's `ingest --fetch-s52` cache; a real,
    # distinct setting here, not "unset".
    s52_path: Path | None = None
    # o-charts holds FOUR RAM byte-LRUs (decoded cells, encoded tiles,
    # `/routing/plan`'s HazardIndexes, LandHazardBakes); the descriptor sums
    # them for its combined RAM budget.
    cell_budget_bytes: int = Field(default=DEFAULT_CELL_BUDGET, ge=0)
    tile_budget_bytes: int = Field(default=DEFAULT_TILE_BUDGET, ge=0)
    hazard_budget_bytes: int = Field(default=DEFAULT_HAZARD_BUDGET, ge=0)
    land_bake_budget_bytes: int = Field(default=DEFAULT_LAND_BAKE_BUDGET, ge=0)
    # NOT a cache: the admission budget for cold tile renders running at
    # once, in estimated peak RAM (3x the on-disk bytes of the cells each
    # render loads — see mivnav.features.ocharts.admission, which also has
    # the OOM incident behind it). A render heavier than this still runs,
    # alone. Lower it to trade low-zoom latency under concurrency for a
    # smaller worst-case RSS; it is the knob that bounds the transient on
    # top of cell_budget_bytes + tile_budget_bytes.
    render_budget_bytes: int = Field(default=DEFAULT_RENDER_BUDGET, ge=1)
    # Persistent disk cache of rendered /tiles/all tiles, so restarts don't
    # re-render (see mivnav.features.ocharts.disk_tiles — it stores rendered
    # tiles of decrypted o-charts cells).
    # A byte budget like the RAM ones, not a RAM cost; 0 disables it.
    tile_disk_dir: Path = Field(default_factory=default_tile_disk_dir)
    tile_disk_budget_bytes: int = Field(default=DEFAULT_TILE_DISK_BUDGET, ge=0)
    # Pre-render every charted /tiles/all tile down to this zoom into the disk
    # cache, in idle time (mivnav.features.ocharts.warm). null disables it; it
    # also needs `prefetch` on and a non-zero disk budget.
    pretile_max_zoom: int | None = Field(default=DEFAULT_PRETILE_MAX_ZOOM, ge=4, le=16)
    # About once a day, install newer editions of the sets already installed
    # here, replacing the old ones (see mivnav.features.ocharts.updates): the
    # o-charts shop's (needs the login; never spends a licence slot) and
    # freenauticalchart.net's. Never installs a chart that is not installed.
    auto_update: bool = True
    # 0 rescans the chart dirs on every access. See OchartsStore.
    rescan_interval_s: float = Field(default=DEFAULT_RESCAN_INTERVAL, ge=0)
    # Decode overview cells in the background while idle, so a cold overview
    # viewport isn't N serialized 400ms decodes deep. See ocharts.warm.
    prefetch: bool = DEFAULT_WARM_OVERVIEW
    # Chart-detail cell-selection knobs, anchored to the requested zoom. See
    # docs/architecture/ocharts-serving-knobs.md for what each does and the
    # measured incidents that set its default.
    over_zoom: int = Field(default=DEFAULT_OVER_ZOOM, ge=0)
    under_zoom: int = Field(default=DEFAULT_UNDER_ZOOM, ge=0)
    detail_gap: int = Field(default=DEFAULT_DETAIL_GAP, ge=0)
    overview_detail_cutoff: int = Field(default=DEFAULT_OVERVIEW_DETAIL_CUTOFF, ge=0)
    max_cells_per_tile: int = Field(default=DEFAULT_MAX_CELLS_PER_TILE, ge=1)
    # SCAMIN gate multiplier B, boat-wide (the server hard-drops SCAMIN-hidden
    # features off the shared tile, so a per-device value can't be honoured).
    # See docs/architecture/ocharts-serving-knobs.md.
    chart_detail: float = Field(
        default=DEFAULT_CHART_DETAIL, ge=CHART_DETAIL_MIN, le=CHART_DETAIL_MAX
    )
    # SCAMIN turn-on SPREAD `k` and anchor scale `A`, composing with
    # chart_detail rather than replacing it (k=1 is byte-identical to today).
    # See docs/architecture/ocharts-serving-knobs.md.
    chart_detail_spread: float = Field(
        default=DEFAULT_CHART_DETAIL_SPREAD,
        ge=CHART_DETAIL_SPREAD_MIN,
        le=CHART_DETAIL_SPREAD_MAX,
    )
    chart_detail_anchor: float = Field(
        default=DEFAULT_CHART_DETAIL_ANCHOR,
        ge=CHART_DETAIL_ANCHOR_MIN,
        le=CHART_DETAIL_ANCHOR_MAX,
    )
    # Threads of chartcore's shared cut pool a single tile request may use;
    # output is byte-identical for any value. See
    # docs/architecture/ocharts-serving-knobs.md.
    parallelism: int = Field(default=DEFAULT_PARALLELISM, ge=1, le=PARALLELISM_MAX)
