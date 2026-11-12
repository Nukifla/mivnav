# SPDX-License-Identifier: GPL-2.0-only
"""Pure-Python point-in-country geometry — the clip half of the bbox-fallback
POI fetch.

See docs/architecture/poi-country-clip.md for why this is network/dep-free
(no shapely/geos) and why distances are deliberately approximate.
"""

from __future__ import annotations

import math

from mivnav.geo.countries import CountryGeometry, Ring

# Keep a POI within this many km outside the polygon too (offshore harbours,
# border towns). Not config — user asked for one sensible loose value, not a
# per-deploy knob.
COUNTRY_CLIP_BUFFER_KM = 15.0

# Equirectangular scale factors (km/degree, mean-Earth); longitude is scaled
# by cos(lat) at the sample point.
_KM_PER_DEG_LAT = 110.57
_KM_PER_DEG_LON = 111.32


def _point_in_ring(lon: float, lat: float, ring: Ring) -> bool:
    """Even-odd ray-cast: is ``(lon, lat)`` inside this single ring?

    Casts a ray in +lon and counts edge crossings. A point exactly on an edge
    is not specially handled — for a loose clip the near-boundary buffer covers
    the boundary itself, so edge ties do not matter.
    """
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x_cross = xj + (lat - yj) * (xi - xj) / (yi - yj)
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def point_in_country(lon: float, lat: float, geom: CountryGeometry) -> bool:
    """Is ``(lon, lat)`` inside the country?

    Inside iff it falls inside *some* polygon's exterior ring (ring 0) and not
    inside any of that same polygon's holes (rings 1+). Handles both a Polygon
    country (one polygon) and a MultiPolygon (several — e.g. an island group):
    each polygon is tested independently, so a point on any island counts.
    """
    for polygon in geom:
        if not polygon:
            continue
        exterior = polygon[0]
        if _point_in_ring(lon, lat, exterior):
            in_hole = any(_point_in_ring(lon, lat, hole) for hole in polygon[1:])
            if not in_hole:
                return True
    return False


def _dist_point_to_segment_km(
    lon: float, lat: float, ax: float, ay: float, bx: float, by: float
) -> float:
    """Approx km from point ``(lon, lat)`` to segment ``a-b``, equirectangular
    around the point's latitude. Δlon is scaled by cos(lat) so the metric is
    roughly isotropic near the point."""
    coslat = math.cos(math.radians(lat))
    px = 0.0
    py = 0.0
    ax_km = (ax - lon) * _KM_PER_DEG_LON * coslat
    ay_km = (ay - lat) * _KM_PER_DEG_LAT
    bx_km = (bx - lon) * _KM_PER_DEG_LON * coslat
    by_km = (by - lat) * _KM_PER_DEG_LAT
    dx = bx_km - ax_km
    dy = by_km - ay_km
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq == 0.0:
        # Degenerate segment: distance to the point a.
        return math.hypot(px - ax_km, py - ay_km)
    t = ((px - ax_km) * dx + (py - ay_km) * dy) / seg_len_sq
    t = max(0.0, min(1.0, t))
    cx = ax_km + t * dx
    cy = ay_km + t * dy
    return math.hypot(px - cx, py - cy)


def near_country(lon: float, lat: float, geom: CountryGeometry, km: float) -> bool:
    """Is ``(lon, lat)`` within ``km`` of the country boundary?

    "Boundary" is every ring of every polygon — exteriors *and* holes — so a
    point just off the coast, just outside a land border, or just inside the rim
    of an enclosed lake all count. Distance is the minimum point-to-segment
    distance over all ring edges (approximate; see the module docstring)."""
    for polygon in geom:
        for ring in polygon:
            n = len(ring)
            for i in range(n):
                ax, ay = ring[i]
                bx, by = ring[(i + 1) % n]
                if _dist_point_to_segment_km(lon, lat, ax, ay, bx, by) <= km:
                    return True
    return False


def clip_features(
    features: list[tuple[float, float, dict]],
    geom: CountryGeometry,
    buffer_km: float = COUNTRY_CLIP_BUFFER_KM,
) -> list[tuple[float, float, dict]]:
    """Keep the ``(lon, lat, props)`` features that belong to the country.

    A feature is kept iff it is inside the country polygon **or** within
    ``buffer_km`` of its boundary — the loose clip that turns a fetched bounding
    rectangle (full of neighbours and open water) back into the country, plus a
    coastal fringe so offshore/harbour POIs are not dropped. Order is preserved.
    """
    return [
        (lon, lat, props)
        for (lon, lat, props) in features
        if point_in_country(lon, lat, geom)
        or near_country(lon, lat, geom, buffer_km)
    ]
