# SPDX-License-Identifier: GPL-2.0-only
"""Decode + rasterize: turns a decoded ``.om`` grid into wash/wind tile PNGs.
``render_wash_tile`` is row 0 = NORTH; ``render_wind_tile`` is row 0 = SOUTH
(``windGpu.ts``'s convention). See docs/architecture/weather-render.md.
"""

from __future__ import annotations

import asyncio
import io
import re
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np
from omfiles import OmFileReader
from PIL import Image

from . import domains
from . import grid as G
from .colorscale import ColorScale, color_for
from .omsource import LoopbackOmSource

if TYPE_CHECKING:
    from .proxy import WeatherProxy

#: R/G full-scale for the wind RGBA8 texture — MUST match
#: `frontend/src/features/weather/windGpu.ts`'s `WIND_ENCODE_MAX` (40 m/s):
#: a lossless transport range, not a visual speed cap (that lives entirely
#: client-side, in the shader's `u_speed_cap`).
WIND_ENCODE_MAX = 40.0

#: Bounds memory (a decoded variable is a whole grid, ~16 MB), not request
#: count. Keyed by (om_path, RAW variable) — see docs/architecture/weather-render.md.
DEFAULT_LRU_ENTRIES = 8

# Ported from the bundle's DEFAULT_DERIVATION_RULES (~L5399-5449).
_UV_PATTERN = re.compile(r"_[uv]_(?P<postfix>component|current)")
_WAVE_PATTERN = re.compile(r"wave_(?:height|direction)")


@dataclass
class DecodedField:
    """A decoded variable ready to sample — mirrors `sampler.ts`'s
    `DecodedField`. `values` is the field's magnitude; `directions` is the
    FROM-bearing array when the variable carries one, else `None`."""

    grid: object
    values: np.ndarray
    directions: np.ndarray | None = None

    def interpolate(self, lat, lon):
        """Bilinear-interpolated VALUE at `lat`/`lon` (scalar or ndarray,
        broadcast together)."""
        return self.grid.get_linear_interpolated_value(self.values, lat, lon)  # type: ignore[attr-defined]

    def interpolate_direction(self, lat, lon):
        """Bilinear-interpolated FROM bearing, degrees in [0, 360), or `None`.
        Wrong across the 0/360 seam, kept anyway to match the wash/arrow
        (`sampler.ts`'s `directionFrom`)."""
        if self.directions is None:
            return None
        deg = self.grid.get_linear_interpolated_value(self.directions, lat, lon)  # type: ignore[attr-defined]
        if not np.isfinite(deg):
            return None
        return float((deg % 360 + 360) % 360)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return self.grid.get_bounds()  # type: ignore[attr-defined]


class GridDecoder:
    """Decodes `.om` variables via `omfiles`, pointed at this server's own
    loopback route (see `omsource.LoopbackOmSource`). A small process-wide
    LRU avoids re-decoding the same file+variable per tile in a viewport."""

    def __init__(self, max_entries: int = DEFAULT_LRU_ENTRIES) -> None:
        self._lru: OrderedDict[tuple[str, str], np.ndarray] = OrderedDict()
        self._max = max_entries
        self._lock = asyncio.Lock()
        # Single-flight: without this, a viewport's concurrent tiles each miss
        # the LRU and redecode (see weather-render.md). `asyncio.shield` keeps
        # one cancelled caller from cancelling the decode for the others.
        self._inflight: dict[tuple[str, str], asyncio.Task[np.ndarray]] = {}

    async def _read_raw(
        self,
        proxy: WeatherProxy,
        loop: asyncio.AbstractEventLoop,
        om_path: str,
        raw_variable: str,
    ) -> np.ndarray:
        key = (om_path, raw_variable)
        async with self._lock:
            cached = self._lru.get(key)
            if cached is not None:
                self._lru.move_to_end(key)
                return cached
            task = self._inflight.get(key)
            if task is None:
                task = asyncio.ensure_future(
                    self._decode_and_cache(proxy, loop, om_path, raw_variable)
                )
                self._inflight[key] = task
        return await asyncio.shield(task)

    async def _decode_and_cache(
        self,
        proxy: WeatherProxy,
        loop: asyncio.AbstractEventLoop,
        om_path: str,
        raw_variable: str,
    ) -> np.ndarray:
        key = (om_path, raw_variable)
        # Decode off the event loop — CPU (decompress) + I/O (the loopback
        # reads, each bridged back onto the loop from this worker thread;
        # see omsource.py's module docstring for why).
        try:
            arr = await asyncio.to_thread(
                self._read_raw_sync, proxy, loop, om_path, raw_variable
            )
        except BaseException:
            async with self._lock:
                self._inflight.pop(key, None)
            raise
        async with self._lock:
            # Pop + LRU-write under the SAME lock acquisition, closing the
            # race where a new caller lands between two separate acquisitions.
            self._inflight.pop(key, None)
            self._lru[key] = arr
            self._lru.move_to_end(key)
            while len(self._lru) > self._max:
                self._lru.popitem(last=False)
        return arr

    def _read_raw_sync(
        self,
        proxy: WeatherProxy,
        loop: asyncio.AbstractEventLoop,
        om_path: str,
        raw_variable: str,
    ) -> np.ndarray:
        source = LoopbackOmSource(proxy, loop, om_path)
        reader = OmFileReader.from_fsspec(source, om_path)
        try:
            child = reader.get_child_by_name(raw_variable)
            if child is None:
                raise KeyError(f"variable {raw_variable!r} not found in {om_path!r}")
            data = child.read_array((...,))
            return np.asarray(data, dtype=np.float64).ravel()
        finally:
            reader.close()

    def _grid_for(self, om_path: str):
        grid_def = domains.grid_for_domain(domains.domain_id_from_om_path(om_path))
        return G.GridFactory.create(grid_def, None)

    async def decode_field(
        self,
        proxy: WeatherProxy,
        loop: asyncio.AbstractEventLoop,
        om_path: str,
        variable: str,
    ) -> DecodedField:
        """The GENERAL decode path — wash rendering and the point endpoint
        both use this. Naming JUST ONE member of a wind/wave pair yields
        the derived MAGNITUDE plus a direction array (see weather-render.md)."""
        grid_obj = self._grid_for(om_path)
        uv_match = _UV_PATTERN.search(variable)
        if uv_match:
            u, v = await self._read_uv_pair(proxy, loop, om_path, variable, uv_match)
            values = np.sqrt(u * u + v * v)
            directions = (np.degrees(np.arctan2(u, v)) + 180) % 360
            return DecodedField(grid_obj, values, directions)
        if "_speed_" in variable or "_direction_" in variable:
            speed, direction = await self._read_speed_direction_pair(proxy, loop, om_path, variable)
            return DecodedField(grid_obj, speed, direction)
        if _WAVE_PATTERN.search(variable):
            height_var = variable.replace("wave_direction", "wave_height")
            dir_var = variable.replace("wave_height", "wave_direction")
            height = await self._read_raw(proxy, loop, om_path, height_var)
            direction = await self._read_raw(proxy, loop, om_path, dir_var)
            return DecodedField(grid_obj, height, direction)
        values = await self._read_raw(proxy, loop, om_path, variable)
        return DecodedField(grid_obj, values, None)

    async def _read_uv_pair(
        self,
        proxy: WeatherProxy,
        loop: asyncio.AbstractEventLoop,
        om_path: str,
        variable: str,
        uv_match: re.Match[str],
    ) -> tuple[np.ndarray, np.ndarray]:
        postfix = uv_match.group("postfix")
        u_var = variable.replace(f"_v_{postfix}", f"_u_{postfix}")
        v_var = variable.replace(f"_u_{postfix}", f"_v_{postfix}")
        u = await self._read_raw(proxy, loop, om_path, u_var)
        v = await self._read_raw(proxy, loop, om_path, v_var)
        return u, v

    async def _read_speed_direction_pair(
        self,
        proxy: WeatherProxy,
        loop: asyncio.AbstractEventLoop,
        om_path: str,
        variable: str,
    ) -> tuple[np.ndarray, np.ndarray]:
        speed_var = variable if "_speed_" in variable else variable.replace("_direction_", "_speed_")
        dir_var = variable if "_direction_" in variable else variable.replace("_speed_", "_direction_")
        speed = await self._read_raw(proxy, loop, om_path, speed_var)
        direction = await self._read_raw(proxy, loop, om_path, dir_var)
        return speed, direction

    async def decode_uv(
        self,
        proxy: WeatherProxy,
        loop: asyncio.AbstractEventLoop,
        om_path: str,
        variable: str,
    ) -> tuple[DecodedField, DecodedField]:
        """(u, v) decoded fields for a wind variable — `render_wind_tile`
        needs raw components, not the magnitude `decode_field` returns.
        See docs/architecture/weather-render.md for the derivation formula."""
        grid_obj = self._grid_for(om_path)
        uv_match = _UV_PATTERN.search(variable)
        if uv_match:
            u, v = await self._read_uv_pair(proxy, loop, om_path, variable, uv_match)
            return DecodedField(grid_obj, u), DecodedField(grid_obj, v)
        if "_speed_" in variable or "_direction_" in variable:
            speed, direction = await self._read_speed_direction_pair(proxy, loop, om_path, variable)
            phi = np.radians(direction - 180.0)
            u = speed * np.sin(phi)
            v = speed * np.cos(phi)
            return DecodedField(grid_obj, u), DecodedField(grid_obj, v)
        raise ValueError(
            f"variable {variable!r} is not a recognised wind convention "
            "(expected a *_u_component_*/*_v_component_* or "
            "*_speed_*/*_direction_* pair)"
        )


def _tile_lat_lon_grid(z: int, x: int, y: int, size: int) -> tuple[np.ndarray, np.ndarray]:
    """Per-pixel (lat, lon) arrays for a `size`×`size` slippy tile, row 0 =
    north — vectorized version of the embedded worker's `getImage` pixel loop."""
    i = np.arange(size, dtype=np.float64)
    j = np.arange(size, dtype=np.float64)
    lats = G.tile2lat(y + i / size, z)
    lons = G.tile2lon(x + j / size, z)
    lon2d, lat2d = np.meshgrid(lons, lats)  # shape (size, size); row i = lats[i]
    return lat2d, lon2d


def _encode_png(rgba: np.ndarray) -> bytes:
    img = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def uv_components(field: DecodedField) -> tuple[DecodedField, DecodedField]:
    """``(u, v)`` for a field that carries a direction. Runs on the GRID
    ARRAYS, before interpolation, so u/v interpolate independently and never
    an angle across the 0/360° seam."""
    if field.directions is None:
        raise ValueError("field carries no direction — nothing to draw as a vector")
    phi = np.radians(field.directions - 180.0)
    return (
        DecodedField(field.grid, field.values * np.sin(phi)),
        DecodedField(field.grid, field.values * np.cos(phi)),
    )


def render_wash_tile(
    field: DecodedField, scale: ColorScale, z: int, x: int, y: int, tile_size: int
) -> bytes:
    """A wash tile PNG — bilinear-interpolate `field` at every pixel of tile
    `z/x/y`, colour it via `scale`'s step function. Row 0 = north. A NaN
    sample (off-grid or a data hole) is fully transparent."""
    lat2d, lon2d = _tile_lat_lon_grid(z, x, y, tile_size)
    px = field.interpolate(lat2d, lon2d)
    rgba = color_for(scale, np.asarray(px, dtype=np.float64))
    return _encode_png(rgba)


def render_wind_tile(
    grid_u: DecodedField,
    grid_v: DecodedField,
    z: int,
    x: int,
    y: int,
    resolution: int,
    encode_max: float = WIND_ENCODE_MAX,
) -> bytes:
    """A wind-field tile PNG in `windGpu.ts`'s `WindTexture` RGBA8 encoding
    — see module docstring. Row 0 = SOUTH (opposite of `render_wash_tile`;
    matches the frontend's texture convention, not the PNG-viewer one)."""
    lat2d, lon2d = _tile_lat_lon_grid(z, x, y, resolution)
    u = np.asarray(grid_u.interpolate(lat2d, lon2d), dtype=np.float64)
    v = np.asarray(grid_v.interpolate(lat2d, lon2d), dtype=np.float64)
    has_data = np.isfinite(u) & np.isfinite(v)
    u_safe = np.where(has_data, u, 0.0)
    v_safe = np.where(has_data, v, 0.0)

    def _encode_unit(value: np.ndarray) -> np.ndarray:
        t = value / (2 * encode_max) + 0.5
        return np.clip(np.round(t * 255), 0, 255)

    r = _encode_unit(u_safe).astype(np.uint8)
    g = _encode_unit(v_safe).astype(np.uint8)
    b = np.zeros_like(r)
    a = np.where(has_data, 255, 0).astype(np.uint8)
    rgba = np.stack([r, g, b, a], axis=-1)
    rgba = np.flipud(rgba)  # north-row-0 → south-row-0
    return _encode_png(rgba)
