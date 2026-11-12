# SPDX-License-Identifier: GPL-2.0-only
"""The ``osm_world`` feature's config slice — ingest-bake tunables for a
pre-baked PMTiles directory, ``data_root/osm_world``. See
docs/architecture/osm-world-config-tuning.md for the measured size numbers
behind every default here.
"""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field, model_validator

from mivnav.config.base import Frozen

# Public, unauthenticated — copy-safe (CLAUDE.md ## Config). Builds publish
# as <host>/<YYYYMMDD>.pmtiles; osm_world.ingest.resolve_build_url resolves
# TODAY's build at run time rather than hardcoding a date that would 404.
DEFAULT_BUILD_HOST = "https://build.protomaps.com"

# Resolved via $PATH. Ingest-time only — the Pi never runs this itself.
DEFAULT_PMTILES_BINARY = "pmtiles"

# Matches Protomaps' documented retention (past week of daily builds).
DEFAULT_BUILD_LOOKBACK_DAYS = 7

# See docs/architecture/osm-world-config-tuning.md for the measured
# maxzoom -> disk size table this default is chosen from.
DEFAULT_OSM_WORLD_MIN_ZOOM = 0
DEFAULT_OSM_WORLD_MAX_ZOOM = 8

# Deliberately separate from DEFAULT_OSM_WORLD_MAX_ZOOM — a region-scoped
# bake can afford a deeper cap than the whole planet can. See
# docs/architecture/osm-world-config-tuning.md.
DEFAULT_OSM_WORLD_REGION_MAX_ZOOM = 12


def default_osm_world_live_cache_dir() -> Path:
    """XDG cache dir for the live tile fallback — deliberately OUTSIDE
    ``data_root`` (a fetch-through cache, not a dataset a bake writes into).
    See docs/architecture/osm-world-config-tuning.md."""
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return cache_home / "mivnav" / "osm_world-live"


# Vector tiles are small (KB, not weather's ~100 MB .om runs) — a tuning
# knob (CLAUDE.md), much smaller than DEFAULT_WEATHER_CACHE_BUDGET.
DEFAULT_OSM_WORLD_LIVE_CACHE_BUDGET = 512 * 1024 * 1024

# Ceiling: the daily Protomaps build itself tops out at z15. A per-dataset
# override may only LOWER this, never exceed the source archive's pyramid.
DEFAULT_OSM_WORLD_LIVE_MAX_ZOOM = 15

# See docs/architecture/osm-world-config-tuning.md for the measured
# tiles/time/places table this default (z7 scan depth) is chosen from.
DEFAULT_OSM_WORLD_PLACE_INDEX_TILE_BUDGET = 16384

# Daily build rotates once a day, so anything shorter buys nothing. A failed
# re-check still serves stale cached bytes rather than a hole (OsmWorldLiveCache.tile).
DEFAULT_OSM_WORLD_LIVE_REFRESH_S = 24 * 60 * 60


class OsmWorldConfig(Frozen):
    """The ``osm_world`` feature module's config slice: boat-wide zoom
    defaults for the ingest bake, PLUS the live-cache tile-fetch fallback.
    Per-dataset ``OsmWorldDatasetParams`` overrides these without touching
    this slice. See docs/architecture/osm-world-config-tuning.md — in
    particular for why there is deliberately NO ``region_min_zoom``."""

    build_host: str = Field(default=DEFAULT_BUILD_HOST, min_length=1)
    build_lookback_days: int = Field(default=DEFAULT_BUILD_LOOKBACK_DAYS, ge=1, le=31)
    pmtiles_binary: str = Field(default=DEFAULT_PMTILES_BINARY, min_length=1)
    min_zoom: int = Field(default=DEFAULT_OSM_WORLD_MIN_ZOOM, ge=0, le=15)
    max_zoom: int = Field(default=DEFAULT_OSM_WORLD_MAX_ZOOM, ge=0, le=15)
    region_max_zoom: int = Field(default=DEFAULT_OSM_WORLD_REGION_MAX_ZOOM, ge=0, le=15)
    live_cache_dir: Path = Field(default_factory=default_osm_world_live_cache_dir)
    live_cache_budget_bytes: int = Field(default=DEFAULT_OSM_WORLD_LIVE_CACHE_BUDGET, ge=0)
    live_max_zoom: int = Field(default=DEFAULT_OSM_WORLD_LIVE_MAX_ZOOM, ge=0, le=15)
    live_refresh_s: int = Field(default=DEFAULT_OSM_WORLD_LIVE_REFRESH_S, ge=1)
    place_index_tile_budget: int = Field(
        default=DEFAULT_OSM_WORLD_PLACE_INDEX_TILE_BUDGET, ge=0
    )

    @model_validator(mode="after")
    def _zoom_ordered(self) -> "OsmWorldConfig":
        if self.min_zoom > self.max_zoom:
            raise ValueError("need min_zoom <= max_zoom")
        return self
