# SPDX-License-Identifier: GPL-2.0-only
"""The one shared distance function, pinned. See :mod:`mivnav.features.route.geo`.

Formerly ``test_arrival.py``: this module used to also pin the
circle-OR-passing-line arrival rule (``arrived()``), which decided whether a
route advanced. #yprzuqtt moved that decision to SignalK's own
course-provider (see :mod:`mivnav.features.route.watcher`), so that rule and
its tests are gone along with it — what is left, ``haversine_m``, is genuine
shared geometry with two callers (the watcher's course-point matching,
``mivnav.api.search``'s proximity sort).
"""

from __future__ import annotations

import math

import pytest

from mivnav.features.route.geo import Point, haversine_m

# One degree of latitude (or of longitude at the equator) on the sphere this
# module uses. Handy for reading the coordinates below as distances.
_DEG_M = math.radians(1.0) * 6_371_000.0  # ~111_195 m


def test_haversine_is_metres_and_symmetric() -> None:
    a, b = Point(0.0, 0.0), Point(0.0, 0.001)
    assert haversine_m(a, b) == pytest.approx(_DEG_M * 0.001, abs=1.0)  # ~111 m
    assert haversine_m(a, b) == pytest.approx(haversine_m(b, a))
    assert haversine_m(a, a) == 0.0


def test_haversine_a_known_meridian_arc() -> None:
    # A whole degree of latitude is one arc-degree of the sphere.
    assert haversine_m(Point(10.0, 5.0), Point(11.0, 5.0)) == pytest.approx(_DEG_M, abs=1.0)
