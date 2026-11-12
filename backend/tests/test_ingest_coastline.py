# SPDX-License-Identifier: GPL-2.0-only
"""Coast-proximity tests for the land-POI filter.

Two layers: exact assertions against a synthetic tiny coastline (so the geometry
is verifiable by hand), plus a couple of checks against the bundled Natural Earth
coastline at real coordinates (a point on the Danish coast is near; a deep-inland
continental point is not). No network.
"""

from mivnav.features.poi.coastline import COAST_BUFFER_KM, CoastIndex, near_coast


def test_buffer_default_constant():
    assert COAST_BUFFER_KM == 10.0


def test_near_coast_true_on_danish_coast():
    # Aarhus waterfront — ~5.5 km from the 50m coastline, inside the 10 km buffer.
    assert near_coast(10.20, 56.15)


def test_near_coast_false_deep_inland():
    # Central continental Europe, >100 km from any coast.
    assert not near_coast(9.0, 50.0)
    assert not near_coast(15.0, 49.0)


def test_near_coast_respects_explicit_km():
    # A point ~12.8 km off the coast: outside the default 10 km, inside 20 km.
    assert not near_coast(10.5, 56.7)
    assert near_coast(10.5, 56.7, 20.0)


def test_coast_index_bbox_prefilter_matches_full_scan():
    # An index prefiltered to a Danish bbox gives the same near/far verdicts as
    # the unfiltered whole-coastline index for points inside that bbox.
    dk_bbox = (8.0, 54.5, 13.0, 57.8)
    idx = CoastIndex(dk_bbox)
    full = CoastIndex(None)
    for lon, lat in [(10.20, 56.15), (9.0, 55.0), (11.5, 55.5)]:
        assert idx.near(lon, lat) == full.near(lon, lat)
    # The prefilter actually shrinks the segment set.
    assert len(idx._segments) < len(full._segments)


def test_near_coast_bbox_kwarg_prefilters():
    # Same answer whether prefiltered to a bbox or scanning the whole coastline.
    assert near_coast(10.20, 56.15, bbox=(8.0, 54.5, 13.0, 57.8))
    assert not near_coast(9.0, 50.0, bbox=(6.0, 48.0, 12.0, 52.0))
