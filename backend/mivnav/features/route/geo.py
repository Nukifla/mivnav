# SPDX-License-Identifier: GPL-2.0-only
"""A point in decimal degrees, and the one distance between two of them.
Formerly ``mivnav.features.route.arrival``, see docs/architecture/route-geo-rename.md.
Haversine, not flat-earth: costs nothing extra, no surprises near the poles."""

from __future__ import annotations

import math
from typing import NamedTuple

#: Mean Earth radius (WGS84 authalic sphere), metres — the same constant
#: OpenCPN and every plotter use.
EARTH_RADIUS_M = 6_371_000.0


class Point(NamedTuple):
    """A position in decimal degrees. Its own tiny type rather than a
    ``Vessel``/``Waypoint``: each caller adapts into one of these, which
    also resolves the ``lng`` vs ``lon`` spelling disagreement at this seam."""

    lat: float
    lon: float


def haversine_m(a: Point, b: Point) -> float:
    """Great-circle distance between two points, in metres."""
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat = lat2 - lat1
    dlon = math.radians(b.lon - a.lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))
