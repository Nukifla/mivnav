# SPDX-License-Identifier: GPL-2.0-only
"""`WeatherRenderer` — the on-disk tile cache + the colour-scale tables +
the rasterisers, config-derived like `WeatherProxy` but a separate `Derived`.

See docs/architecture/weather-renderer.md for why `decode` is a callable
(cache must be checked before decode) and the `identity` cache-key contract.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path

import numpy as np

from . import render as R
from .colorscale import get_color_scale
from .render import DecodedField
from .tilecache import PngTileCache, cache_key

#: A deferred decode: called only on a cache MISS.
Decode = Callable[[], Awaitable[DecodedField]]
DecodeUv = Callable[[], Awaitable[tuple[DecodedField, DecodedField]]]


class WeatherRenderer:
    def __init__(
        self,
        *,
        render_cache_dir: Path,
        render_cache_budget_bytes: int,
        render_max_zoom: int,
        wind_tex_max_zoom: int,
        wash_tile_size: int = 256,
        wind_tile_resolution: int = 64,
    ) -> None:
        self.render_max_zoom = render_max_zoom
        self.wind_tex_max_zoom = wind_tex_max_zoom
        self.wash_tile_size = wash_tile_size
        self.wind_tile_resolution = wind_tile_resolution
        self._cache = PngTileCache(Path(render_cache_dir), render_cache_budget_bytes)

    # -- wash ----------------------------------------------------------

    async def wash_tile(
        self,
        identity: str,
        variable: str,
        dark: bool,
        z: int,
        x: int,
        y: int,
        decode: Decode,
    ) -> bytes | None:
        """A wash tile PNG, cached. `None` when `z` exceeds
        `render_max_zoom` (the route answers 404 — model grids are far
        coarser than chart tile zooms, so there is nothing new to show
        past this)."""
        if z > self.render_max_zoom:
            return None
        key = cache_key("wash", identity, variable, dark, z, x, y)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        scale = get_color_scale(variable, dark)
        field = await decode()
        png = R.render_wash_tile(field, scale, z, x, y, self.wash_tile_size)
        self._cache.put(key, png)
        return png

    # -- field (the RGBA vector texture the particle sim samples) ----------

    async def field_tile(
        self,
        identity: str,
        variable: str,
        z: int,
        x: int,
        y: int,
        decode_uv: DecodeUv,
    ) -> bytes | None:
        """A vector-field tile PNG, cached. `None` when `z` exceeds
        `wind_tex_max_zoom` — a shallow pyramid is enough (see
        `WeatherConfig.wind_tex_max_zoom`'s docstring).

        Named for what it encodes rather than for wind: waves carry a
        direction too, so a wave particle layer needs no new route."""
        if z > self.wind_tex_max_zoom:
            return None
        # dark doesn't affect the encoding — omit from the key so a palette
        # flip doesn't churn this cache.
        key = cache_key("wind", identity, variable, False, z, x, y)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        grid_u, grid_v = await decode_uv()
        png = R.render_wind_tile(grid_u, grid_v, z, x, y, self.wind_tile_resolution)
        self._cache.put(key, png)
        return png

    # -- point ---------------------------------------------------------

    async def point(self, decode: Decode, lat: float, lon: float) -> dict[str, float | None]:
        """`{"value": ..., "direction": ...}` at a point. Nothing is cached
        here — the decode itself is, one layer down (every backing keeps an
        LRU keyed on its own identity), so this is near-free once the view's
        wash tile has already decoded the same field."""
        from .grid import normalize_lon

        field = await decode()
        value = field.interpolate(lat, normalize_lon(lon))
        direction = field.interpolate_direction(lat, normalize_lon(lon))
        return {
            "value": None if not np.isfinite(value) else float(value),
            "direction": direction,
        }
