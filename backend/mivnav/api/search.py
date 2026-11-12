# SPDX-License-Identifier: GPL-2.0-only
"""``GET /search`` — query the shared search index (:mod:`mivnav.search`),
merged with live AIS targets.

See docs/architecture/search-route.md for the AIS "ais:<id>" wire-format
convention and the nearest-first sort contract.
"""

from __future__ import annotations

import math
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from mivnav.api.deps import get_search_index, get_signalk
from mivnav.features.route.geo import Point, haversine_m
from mivnav.search import SearchIndex
from mivnav.signalk import SignalKService

router = APIRouter(prefix="/search")

__all__ = ["get_search_index", "router"]

#: Proximity-sort candidate pool multiplier: the index's SQL cursor is
#: rowid-recency order, not distance, so a plain ``LIMIT`` before sorting
#: could silently exclude the actual nearest result.
_NEAR_CANDIDATE_FACTOR = 5
_NEAR_CANDIDATE_MAX = 200


def _ais_results(targets: list[dict[str, Any]], bbox: tuple[float, ...] | None) -> list[dict]:
    """AIS wire targets (`SignalKService.search_targets`), reshaped into the
    same envelope :class:`SearchIndex` rows use, so the frontend's one
    `SearchResult` type covers both without knowing AIS is not indexed."""
    now = time.time()
    results = []
    for t in targets:
        lat, lon = t.get("lat"), t.get("lng")
        if bbox is not None:
            min_lon, min_lat, max_lon, max_lat = bbox
            if lat is None or lon is None or not (
                min_lon <= lon <= max_lon and min_lat <= lat <= max_lat
            ):
                continue
        name, mmsi = t.get("name"), t.get("mmsi")
        results.append(
            {
                # "ais:<id>" prefix: the wire-format convention other code
                # strips against to tell an AIS result from an indexed one.
                "id": f"ais:{t['id']}",
                "source": "ais",
                "region": "",
                "category": "vessel",
                "title": name or mmsi or t["id"],
                "text": " ".join(filter(None, [name, mmsi])),
                "lat": lat,
                "lon": lon,
                "data": t,
                "updated_at": now,
            }
        )
    return results


def _distance_or_infinite(near: Point, result: dict) -> float:
    lat, lon = result.get("lat"), result.get("lon")
    if lat is None or lon is None:
        return math.inf
    return haversine_m(near, Point(lat=lat, lon=lon))


@router.get("")
def search(
    q: str | None = None,
    source: str | None = None,
    category: str | None = None,
    bbox: str | None = None,
    lat: float | None = None,
    lon: float | None = None,
    limit: int = 50,
    index: SearchIndex = Depends(get_search_index),
    signalk: SignalKService = Depends(get_signalk),
) -> dict:
    """``bbox``, if given, is ``"min_lon,min_lat,max_lon,max_lat"``. ``lat``/
    ``lon``, given together, sort nearest-first from that point (see the
    module docstring)."""
    parsed_bbox = None
    if bbox is not None:
        parts = bbox.split(",")
        if len(parts) != 4:
            raise HTTPException(
                status_code=422,
                detail="bbox must be 'min_lon,min_lat,max_lon,max_lat'",
            )
        try:
            parsed_bbox = tuple(float(p) for p in parts)
        except ValueError as e:
            raise HTTPException(status_code=422, detail="bbox must be numeric") from e
    near = Point(lat=lat, lon=lon) if lat is not None and lon is not None else None
    fetch_limit = (
        limit if near is None else min(limit * _NEAR_CANDIDATE_FACTOR, _NEAR_CANDIDATE_MAX)
    )
    results = index.search(
        q, source=source, category=category, bbox=parsed_bbox, limit=fetch_limit
    )
    if source in (None, "ais") and category in (None, "vessel"):
        results = results + _ais_results(signalk.search_targets(q or ""), parsed_bbox)
    if near is not None:
        results.sort(key=lambda r: _distance_or_infinite(near, r))
    return {"results": results[:limit]}
