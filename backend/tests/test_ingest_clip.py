# SPDX-License-Identifier: GPL-2.0-only
"""Pure-geometry unit tests for the bbox-fallback clip.

Uses hand-built synthetic ``CountryGeometry`` shapes (a square with a hole, and
two disjoint squares for the multipolygon case) so every assertion is exact and
independent of the real Natural Earth dataset. No network, no config.
"""

from mivnav.features.poi.clip import (
    clip_features,
    near_country,
    point_in_country,
)

# A 2-degree square from (0,0) to (2,2) with a 0.4-degree square hole around
# its centre (0.8..1.2 in both lon and lat). Rings are (lon, lat).
_EXTERIOR = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0), (0.0, 0.0)]
_HOLE = [(0.8, 0.8), (1.2, 0.8), (1.2, 1.2), (0.8, 1.2), (0.8, 0.8)]
SQUARE_WITH_HOLE = [[_EXTERIOR, _HOLE]]

# Two disjoint 1-degree squares (a mainland + an island), as a MultiPolygon.
_ISLAND_A = [[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)]]
_ISLAND_B = [[(10.0, 10.0), (11.0, 10.0), (11.0, 11.0), (10.0, 11.0), (10.0, 10.0)]]
TWO_ISLANDS = [_ISLAND_A, _ISLAND_B]


def test_point_clearly_inside_is_inside():
    assert point_in_country(0.3, 0.3, SQUARE_WITH_HOLE)


def test_point_inside_hole_is_not_inside():
    assert not point_in_country(1.0, 1.0, SQUARE_WITH_HOLE)


def test_point_outside_exterior_is_not_inside():
    assert not point_in_country(5.0, 5.0, SQUARE_WITH_HOLE)


def test_multipolygon_second_island_point_is_inside():
    assert point_in_country(10.5, 10.5, TWO_ISLANDS)
    # ...and a point between the two islands is in neither.
    assert not point_in_country(5.0, 5.0, TWO_ISLANDS)


def test_near_country_true_just_outside_boundary():
    # ~0.05 deg east of the exterior edge at lat 1.0 ≈ 5.5 km — within 15 km.
    assert near_country(2.05, 1.0, SQUARE_WITH_HOLE, 15.0)


def test_near_country_false_far_outside():
    # ~3 deg east ≈ 330 km — nowhere near 15 km.
    assert not near_country(5.0, 1.0, SQUARE_WITH_HOLE, 15.0)


def test_near_country_detects_hole_rim():
    # A point just inside the hole rim is >0 from the interior but within 15 km
    # of the hole boundary.
    assert near_country(1.0, 0.85, SQUARE_WITH_HOLE, 15.0)


def _feat(lon, lat, name):
    return (lon, lat, {"name": name})


def test_clip_features_keeps_inside_and_near_drops_far_and_hole():
    features = [
        _feat(0.3, 0.3, "inside"),          # clearly inside -> keep
        _feat(2.05, 1.0, "harbour"),        # ~5.5 km offshore -> keep (buffer)
        _feat(5.0, 5.0, "neighbour"),       # far outside -> drop
        _feat(1.0, 1.0, "in_hole"),         # inside hole (lake) -> drop
    ]
    kept = clip_features(features, SQUARE_WITH_HOLE, buffer_km=15.0)
    names = [props["name"] for _, _, props in kept]
    assert names == ["inside", "harbour"]


def test_clip_features_multipolygon_keeps_both_islands():
    features = [
        _feat(0.5, 0.5, "mainland"),
        _feat(10.5, 10.5, "island"),
        _feat(5.0, 5.0, "sea"),
    ]
    kept = clip_features(features, TWO_ISLANDS, buffer_km=15.0)
    names = [props["name"] for _, _, props in kept]
    assert names == ["mainland", "island"]


def test_clip_features_default_buffer_is_the_module_constant():
    from mivnav.features.poi.clip import COUNTRY_CLIP_BUFFER_KM

    assert COUNTRY_CLIP_BUFFER_KM == 15.0
    # Same result whether the constant is passed explicitly or defaulted.
    features = [_feat(0.3, 0.3, "inside"), _feat(5.0, 5.0, "far")]
    assert clip_features(features, SQUARE_WITH_HOLE) == [features[0]]
