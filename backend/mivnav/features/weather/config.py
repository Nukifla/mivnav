# SPDX-License-Identifier: GPL-2.0-only
"""The ``weather`` feature's config slice.

Moved out of :mod:`mivnav.config.model` as part of the Feature-abstraction
restructuring — see :mod:`mivnav.features.poi.config`'s docstring for the shape of the
move.
"""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field, field_validator

from mivnav.config.base import Frozen
from mivnav.features.weather import domains


def default_weather_cache_dir() -> Path:
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return cache_home / "mivnav" / "weather"


def default_weather_render_cache_dir() -> Path:
    # Own subdirectory beside the .om chunk cache, not inside it: different
    # things (raw upstream bytes vs. rendered PNGs), different eviction
    # economics — see WeatherConfig.render_cache_budget_bytes.
    cache_home = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return cache_home / "mivnav" / "weather-render"


# Tuning knobs (config, not hardcoded, per house style) — see
# docs/architecture/weather-config-knobs.md for the reasoning behind each.
DEFAULT_WEATHER_CACHE_BUDGET = 4 * 1024 * 1024 * 1024
DEFAULT_WEATHER_CHUNK_BYTES = 128 * 1024
DEFAULT_WEATHER_LATEST_TTL = 90
DEFAULT_WEATHER_PREWARM_NEIGHBOURS = 2
DEFAULT_WEATHER_RENDER_CACHE_BUDGET = 512 * 1024 * 1024
DEFAULT_WEATHER_RENDER_MAX_ZOOM = 10
DEFAULT_WIND_TEX_MAX_ZOOM = 6


class WeatherConfig(Frozen):
    """The Open-Meteo weather proxy — a lazy, range-caching mirror — AND the
    server-side wash/wind tile renderer built on top of it.

    Fetched THROUGH the boat's server so every device shares one cache and
    stays offline-after-view. Whole input to both, kept as TWO independently
    constructible `Derived`s that still rebuild together on ANY field
    change. See docs/architecture/weather-proxy-config.md.
    """

    cache_dir: Path = Field(default_factory=default_weather_cache_dir)
    cache_budget_bytes: int = Field(default=DEFAULT_WEATHER_CACHE_BUDGET, ge=0)
    # Over-fetch-vs-locality knob; must be > the client's block size to
    # serve neighbours from one round trip. See docs/architecture/weather-config-knobs.md.
    chunk_bytes: int = Field(default=DEFAULT_WEATHER_CHUNK_BYTES, gt=0)
    latest_ttl_seconds: int = Field(default=DEFAULT_WEATHER_LATEST_TTL, ge=0)
    # Latency-vs-upstream-bytes knob; 0 disables it.
    prewarm_neighbours: int = Field(
        default=DEFAULT_WEATHER_PREWARM_NEIGHBOURS, ge=0
    )
    # Point this at a self-hosted Open-Meteo and no client changes — they
    # only ever talk to this server, never the upstream.
    upstream_tiles_url: str = "https://openmeteo.s3.amazonaws.com"
    # Proxied too so a device with no internet of its own reads through the Pi.
    upstream_forecast_url: str = "https://api.open-meteo.com/v1/forecast"

    # -- WeatherRenderer (server-side wash/wind tile rendering) -------------
    # A SEPARATE cache/budget from cache_dir above — rendered PNG tiles vs.
    # raw .om byte chunks, different economics.
    render_cache_dir: Path = Field(default_factory=default_weather_render_cache_dir)
    render_cache_budget_bytes: int = Field(
        default=DEFAULT_WEATHER_RENDER_CACHE_BUDGET, ge=0
    )
    # Zoom ceilings past which a tile route 404s rather than rendering — a
    # starting-point tuning value, not a measured optimum.
    render_max_zoom: int = Field(default=DEFAULT_WEATHER_RENDER_MAX_ZOOM, ge=0, le=24)
    wind_tex_max_zoom: int = Field(default=DEFAULT_WIND_TEX_MAX_ZOOM, ge=0, le=24)

    # The sailor's explicit allow-list of Open-Meteo domains the LIVE proxy
    # may fetch on demand, for a model browsed live without a declared
    # dataset. Empty by default: no dataset + nothing allow-listed = none.
    on_demand_domains: tuple[str, ...] = Field(default_factory=tuple)

    #: SignalK weather providers known to answer WITHOUT the internet (e.g.
    #: local GRIB). Not inferrable from a provider id, so declared. Empty
    #: default is the conservative direction: every provider needs the link.
    signalk_offline_providers: tuple[str, ...] = Field(default_factory=tuple)

    @field_validator("on_demand_domains")
    @classmethod
    def _known_domains(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        for domain in value:
            try:
                domains.grid_for_domain(domain)
            except KeyError as e:
                raise ValueError(str(e)) from e
        return value
