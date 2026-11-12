# SPDX-License-Identifier: GPL-2.0-only
"""Coast-proximity test — the "is this POI near the sea?" filter for land POIs.

See docs/architecture/poi-coastline-filter.md for why marine POIs are
exempt, the data source, and the CoastIndex prefilter's perf rationale.
"""

from __future__ import annotations

import gzip
import json
import math
from pathlib import Path

from mivnav.features.poi.clip import (
    _KM_PER_DEG_LAT,
    _KM_PER_DEG_LON,
    _dist_point_to_segment_km,
)

_DATA_PATH = Path(__file__).parent / "data" / "ne_50m_coastline.json.gz"

# Not config, same reasoning as COUNTRY_CLIP_BUFFER_KM in clip.py.
COAST_BUFFER_KM = 10.0

Segment = tuple[float, float, float, float]  # (ax, ay, bx, by) endpoints
BBox = tuple[float, float, float, float]  # (min_lon, min_lat, max_lon, max_lat)

_cache: list[Segment] | None = None


def _load() -> list[Segment]:
    """Every coastline segment as a flat ``(ax, ay, bx, by)`` list, cached."""
    global _cache
    if _cache is None:
        with gzip.open(_DATA_PATH, "rt", encoding="utf-8") as fh:
            data = json.load(fh)
        segments: list[Segment] = []
        for line in data["lines"]:
            for i in range(len(line) - 1):
                ax, ay = line[i]
                bx, by = line[i + 1]
                segments.append((float(ax), float(ay), float(bx), float(by)))
        _cache = segments
    return _cache


def _lon_buffer_deg(km: float, lat: float) -> float:
    """km → degrees of longitude at ``lat`` (the widest span, so over-includes;
    cos is floored to keep it finite near the poles)."""
    coslat = max(math.cos(math.radians(lat)), 0.01)
    return km / (_KM_PER_DEG_LON * coslat)


class CoastIndex:
    """Coastline segments prefiltered to one bake's area, reused per point:
    a per-point :meth:`near` check scans a few hundred local segments instead
    of all ~60k global ones. ``bbox=None`` keeps the whole coastline."""

    def __init__(self, bbox: BBox | None = None, km: float = COAST_BUFFER_KM) -> None:
        self.km = km
        if bbox is None:
            self._segments = list(_load())
            return
        min_lon, min_lat, max_lon, max_lat = bbox
        dlat = km / _KM_PER_DEG_LAT
        # Widest lon buffer over the bbox occurs at its highest |lat| (smallest
        # cos) — use it so the prefilter never clips a segment that could be in
        # range.
        dlon = _lon_buffer_deg(km, max(abs(min_lat), abs(max_lat)))
        lo_lon, hi_lon = min_lon - dlon, max_lon + dlon
        lo_lat, hi_lat = min_lat - dlat, max_lat + dlat
        segments: list[Segment] = []
        for seg in _load():
            ax, ay, bx, by = seg
            if max(ax, bx) < lo_lon or min(ax, bx) > hi_lon:
                continue
            if max(ay, by) < lo_lat or min(ay, by) > hi_lat:
                continue
            segments.append(seg)
        self._segments = segments

    def near(self, lon: float, lat: float, km: float | None = None) -> bool:
        """Is ``(lon, lat)`` within ``km`` (default the index buffer) of any
        retained coastline segment?

        A cheap degree-window reject skips the trig distance for segments that
        are clearly too far; only survivors pay for
        :func:`~mivnav.features.poi.clip._dist_point_to_segment_km`.
        """
        km = self.km if km is None else km
        dlat = km / _KM_PER_DEG_LAT
        dlon = _lon_buffer_deg(km, lat)
        for ax, ay, bx, by in self._segments:
            if lon < min(ax, bx) - dlon or lon > max(ax, bx) + dlon:
                continue
            if lat < min(ay, by) - dlat or lat > max(ay, by) + dlat:
                continue
            if _dist_point_to_segment_km(lon, lat, ax, ay, bx, by) <= km:
                return True
        return False


def near_coast(
    lon: float, lat: float, km: float = COAST_BUFFER_KM, *, bbox: BBox | None = None
) -> bool:
    """True if ``(lon, lat)`` is within ``km`` of the coastline.

    A convenience for one-off checks: it builds a throwaway :class:`CoastIndex`
    (optionally prefiltered to ``bbox``). For a whole batch build a
    :class:`CoastIndex` once and call :meth:`CoastIndex.near` per point instead —
    that is what the POI bake does.
    """
    return CoastIndex(bbox=bbox, km=km).near(lon, lat)
