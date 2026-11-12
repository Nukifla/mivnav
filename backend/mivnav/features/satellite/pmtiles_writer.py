# SPDX-License-Identifier: GPL-2.0-only
"""Thin wrapper around ``chartcore.build_raster_pmtiles``, kept only so
``write_raster_pmtiles`` preserves its call signature for existing
callers/tests. See docs/architecture/satellite-raster-pmtiles-writer.md."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import chartcore


def write_raster_pmtiles(
    out: Path,
    tiles: Iterable[tuple[int, int, int, bytes]],
    *,
    name: str,
    bounds: tuple[float, float, float, float],  # w, s, e, n
    min_zoom: int,
    max_zoom: int,
    tile_type: int,
    tile_format: str,
) -> int:
    """Stream ``(z, x, y, tile_bytes)`` tuples into a raster PMTiles at ``out``,
    written atomically. ``tiles`` is consumed lazily — a generator is fine,
    the whole point for a multi-gigabyte bake."""
    return chartcore.build_raster_pmtiles(
        Path(out),
        tiles,
        name=name,
        bounds=bounds,
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        tile_type=tile_type,
        tile_format=tile_format,
    )
