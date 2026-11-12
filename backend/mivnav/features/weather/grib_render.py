# SPDX-License-Identifier: GPL-2.0-only
"""``GribDecoder`` — the GRIB-sourced sibling of ``render.py``'s
``GridDecoder``, producing the same ``DecodedField`` shape. See
docs/architecture/grib-decoder-shape.md for why it's a separate class
and why ``decode_speed`` duplicates rather than shares its formula.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

import gribberish
import numpy as np

from . import grid as G
from .gribstore import GribStore
from .render import DecodedField

#: Small in-process LRU of decoded arrays — mirrors ``render.py``'s
#: ``GridDecoder`` (``DEFAULT_LRU_ENTRIES``): bounds memory (one entry is a
#: whole grid), not request count.
DEFAULT_LRU_ENTRIES = 8


class GribDecoder:
    def __init__(self, max_entries: int = DEFAULT_LRU_ENTRIES) -> None:
        self._lru: OrderedDict[str, np.ndarray] = OrderedDict()
        self._grid_cache: dict[str, dict] = {}
        self._max = max_entries
        self._lock = asyncio.Lock()
        # Single-flight (mirrors `render.GridDecoder._inflight`): a viewport's
        # worth of wind tiles on first paint all read the same u/v path
        # concurrently and would otherwise each re-parse the GRIB message.
        self._inflight: dict[str, asyncio.Task[np.ndarray]] = {}

    async def _read(self, path: Path) -> np.ndarray:
        key = str(path)
        async with self._lock:
            cached = self._lru.get(key)
            if cached is not None:
                self._lru.move_to_end(key)
                return cached
            task = self._inflight.get(key)
            if task is None:
                task = asyncio.ensure_future(self._decode_and_cache(path))
                self._inflight[key] = task
        return await asyncio.shield(task)

    async def _decode_and_cache(self, path: Path) -> np.ndarray:
        key = str(path)
        try:
            arr = await asyncio.to_thread(self._read_sync, path)
        except BaseException:
            async with self._lock:
                self._inflight.pop(key, None)
            raise
        async with self._lock:
            self._inflight.pop(key, None)
            self._lru[key] = arr
            self._lru.move_to_end(key)
            while len(self._lru) > self._max:
                self._lru.popitem(last=False)
        return arr

    def _read_sync(self, path: Path) -> np.ndarray:
        data = path.read_bytes()
        msg = gribberish.parse_grib_message(data, 0)
        return np.asarray(msg.data(), dtype=np.float64).ravel()

    async def _grid_for(self, store: GribStore):
        product_id = store.product_id
        cached = self._grid_cache.get(product_id)
        if cached is None:
            cached = await asyncio.to_thread(store.grid_definition)
            self._grid_cache[product_id] = cached
        return G.GridFactory.create(cached, None)

    async def decode_uv(
        self, store: GribStore, valid_time: datetime
    ) -> tuple[DecodedField, DecodedField]:
        """``(u, v)`` decoded fields at ``valid_time`` (UTC) — the wind-tile
        route's input, same shape as ``render.py``'s ``GridDecoder
        .decode_uv``."""
        paths = store.resolve_uv(valid_time)
        if paths is None:
            raise KeyError(f"no baked wind data for {valid_time.isoformat()}")
        u_path, v_path = paths
        grid_obj = await self._grid_for(store)
        u, v = await asyncio.gather(self._read(u_path), self._read(v_path))
        return DecodedField(grid_obj, u), DecodedField(grid_obj, v)

    async def decode_speed(self, store: GribStore, valid_time: datetime) -> DecodedField:
        """Wind SPEED + FROM-bearing direction at ``valid_time``; same
        derivation as ``render.py``'s ``decode_field``, duplicated per
        module docstring."""
        u_field, v_field = await self.decode_uv(store, valid_time)
        u, v = u_field.values, v_field.values
        values = np.sqrt(u * u + v * v)
        directions = (np.degrees(np.arctan2(u, v)) + 180) % 360
        return DecodedField(u_field.grid, values, directions)
