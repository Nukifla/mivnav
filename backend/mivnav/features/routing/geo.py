# SPDX-License-Identifier: GPL-2.0-only
"""A point in decimal degrees, and the one distance between two of them.

Deliberately its own copy of ``mivnav.features.route.geo``'s ``Point``/
``haversine_m`` rather than an import — ``route`` is a sibling feature, and
``backend/.importlinter``'s feature-independence contract forbids reaching
into another feature's internals directly. Both are small enough that
duplicating them costs less than promoting either into the kernel would;
revisit that call if a third feature wants the same pair.
"""

from __future__ import annotations

import math
from typing import NamedTuple

#: Mean Earth radius (WGS84 authalic sphere), metres — see
#: ``mivnav.features.route.geo`` for the same constant and the same
#: sphere-not-ellipsoid reasoning.
EARTH_RADIUS_M = 6_371_000.0


class Point(NamedTuple):
    lat: float
    lon: float


def haversine_m(a: Point, b: Point) -> float:
    """Great-circle distance between two points, in metres."""
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat = lat2 - lat1
    dlon = math.radians(b.lon - a.lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))
