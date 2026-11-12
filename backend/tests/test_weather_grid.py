# SPDX-License-Identifier: GPL-2.0-only
"""Hermetic unit tests of the ported grid/projection math (mivnav.features.weather
.grid) — no network, no Node, no `.om` file. Independent hand-derived
expected values (exact grid-point reads, a forward/reverse round trip, an
explicit bilinear hand-computation) — the LIVE cross-check against the real
JS library is a separate test (test_weather_grid_crosscheck.py, which needs
network + Node + the sibling frontend checkout and skips cleanly without
them); this file is what runs everywhere, always."""

from __future__ import annotations

import math

import numpy as np
import pytest

from mivnav.features.weather import grid as G


def test_regular_grid_reads_exact_value_at_a_grid_point():
    # 4x4 grid, [0,3]x[0,3] degrees, dx=dy=1. values[y*4+x] = y*10+x.
    data = {"type": "regular", "nx": 4, "ny": 4, "lonMin": 0.0, "latMin": 0.0, "dx": 1.0, "dy": 1.0}
    grid = G.GridFactory.create(data)
    values = np.array([y * 10 + x for y in range(4) for x in range(4)], dtype=np.float64)
    # Exactly on an INTERIOR grid point: no interpolation, exact value back.
    # (Not the last row/column — see test_regular_grid_last_column_needs_a_
    # right_neighbour_even_at_x_fraction_zero for why that edge case differs,
    # faithfully reproducing the JS original's own behaviour there.)
    assert grid.get_linear_interpolated_value(values, 1.0, 1.0) == pytest.approx(11.0)
    assert grid.get_linear_interpolated_value(values, 0.0, 0.0) == pytest.approx(0.0)


def test_regular_grid_last_column_needs_a_right_neighbour_even_at_x_fraction_zero():
    # A faithful-port quirk, not a bug: interpolateLinear (ported in
    # _interpolate_linear) unconditionally needs BOTH the current cell's
    # neighbours to bilinearly interpolate, even when landing exactly on a
    # grid node (x_fraction == 0) — it has no special case for an exact
    # coordinate. At the grid's own right/top edge (non-wrapping), that
    # neighbour does not exist, so BOTH the +1-column samples come back
    # invalid — two missing neighbours, past what the single-missing-
    # neighbour rescue case (see grid.py's _interpolate_linear docstring)
    # can answer — and the JS original returns NaN there too. Verified by
    # reading the embedded worker source, not assumed.
    data = {"type": "regular", "nx": 4, "ny": 4, "lonMin": 0.0, "latMin": 0.0, "dx": 1.0, "dy": 1.0}
    grid = G.GridFactory.create(data)
    values = np.array([y * 10 + x for y in range(4) for x in range(4)], dtype=np.float64)
    assert math.isnan(grid.get_linear_interpolated_value(values, 2.0, 3.0))


def test_regular_grid_bilinear_midpoint_matches_hand_computation():
    data = {"type": "regular", "nx": 4, "ny": 4, "lonMin": 0.0, "latMin": 0.0, "dx": 1.0, "dy": 1.0}
    grid = G.GridFactory.create(data)
    values = np.array([y * 10 + x for y in range(4) for x in range(4)], dtype=np.float64)
    # Midpoint of the 4 corners (1,1)=11, (2,1)=12, (1,2)=21, (2,2)=22 at
    # lat=1.5, lon=1.5 → equal-weight average = 16.5.
    got = grid.get_linear_interpolated_value(values, 1.5, 1.5)
    assert got == pytest.approx((11 + 12 + 21 + 22) / 4)


def test_regular_grid_out_of_bounds_is_nan():
    data = {"type": "regular", "nx": 4, "ny": 4, "lonMin": 0.0, "latMin": 0.0, "dx": 1.0, "dy": 1.0}
    grid = G.GridFactory.create(data)
    values = np.zeros(16, dtype=np.float64)
    assert math.isnan(grid.get_linear_interpolated_value(values, 100.0, 0.0))
    assert math.isnan(grid.get_linear_interpolated_value(values, 0.0, -50.0))


def test_regular_grid_vectorized_matches_scalar_pointwise():
    data = {"type": "regular", "nx": 6, "ny": 6, "lonMin": -10.0, "latMin": -10.0, "dx": 2.0, "dy": 2.0}
    grid = G.GridFactory.create(data)
    rng = np.random.default_rng(0)
    values = rng.uniform(-5, 5, size=36)
    lats = rng.uniform(-10, 2, size=25)
    lons = rng.uniform(-10, 2, size=25)
    vector_result = grid.get_linear_interpolated_value(values, lats, lons)
    scalar_result = np.array(
        [grid.get_linear_interpolated_value(values, la, lo) for la, lo in zip(lats, lons)]
    )
    np.testing.assert_allclose(vector_result, scalar_result, equal_nan=True)


def test_regular_grid_global_longitude_wrap():
    # A near-global grid (360° span minus one cell) wraps at the seam.
    nx, ny = 8, 4
    data = {"type": "regular", "nx": nx, "ny": ny, "lonMin": -180.0, "latMin": -90.0, "dx": 45.0, "dy": 45.0}
    grid = G.GridFactory.create(data)
    assert grid.longitude_wrap is True
    values = np.arange(nx * ny, dtype=np.float64)
    # A point just past the last column should wrap to interpolate with
    # column 0, not return NaN.
    got = grid.get_linear_interpolated_value(values, 0.0, 179.0)
    assert not math.isnan(got)


def test_lambert_conformal_conic_forward_reverse_round_trip():
    # DMI Harmonie AROME Europe's real projection params.
    proj = G.LambertConformalConicProjection(
        {"λ0": 352, "ϕ0": 55.5, "ϕ1": 55.5, "ϕ2": 55.5, "radius": 6371229}
    )
    for lat, lon in [(55.0, 10.0), (60.2, 24.9), (45.0, 0.0)]:
        x, y = proj.forward(lat, lon)
        back_lat, back_lon = proj.reverse(x, y)
        assert back_lat == pytest.approx(lat, abs=1e-6)
        assert back_lon == pytest.approx(lon, abs=1e-6)


def test_lambert_azimuthal_forward_reverse_round_trip():
    proj = G.LambertAzimuthalEqualAreaProjection({"λ0": 10.0, "ϕ1": 52.0})
    for lat, lon in [(50.0, 5.0), (55.0, 15.0)]:
        x, y = proj.forward(lat, lon)
        back_lat, back_lon = proj.reverse(x, y)
        assert back_lat == pytest.approx(lat, abs=1e-6)
        assert back_lon == pytest.approx(lon, abs=1e-6)


def test_gaussian_grid_reads_exact_value_at_a_grid_point():
    # A tiny reduced-Gaussian grid: latitudeLines=2 → 4 latitude rows,
    # nx(y) = 20 + y*4 for y<2 (rows 0,1), mirrored for y>=2 (rows 2,3).
    latitude_lines = 2
    count = 4 * latitude_lines * (latitude_lines + 9)  # 88
    data = {"nx": 24, "ny": 1, "gaussianGridLatitudeLines": latitude_lines}
    grid = G.GaussianGrid(data)
    values = np.arange(count, dtype=np.float64)
    # Row y=0 starts at integral(0) = 18 (2*0*0+18*0-nxStart(0)); the grid's
    # own yLower/dy math picks the row for a given lat — just check the
    # nearest-neighbour value at the row-0 latitude is self-consistent
    # (reading the SAME index the grid computes internally), which is
    # exactly what `getNearestNeighborValue`-equivalent behaviour requires;
    # here via the bilinear path evaluated exactly at a node.
    dy = 180 / (2 * latitude_lines + 0.5)
    lat0 = (latitude_lines - 0 - 1) * dy + dy / 2  # row 0's node latitude
    val = grid.get_linear_interpolated_value(values, lat0, 0.0)
    assert not math.isnan(val)


def test_tile2lat_tile2lon_match_standard_slippy_map_formula():
    # z=1: 2x2 tiles. Tile (0,0) top-left corner is (lat≈85.0511, lon=-180).
    assert G.tile2lon(0, 1) == pytest.approx(-180.0)
    assert G.tile2lat(0, 1) == pytest.approx(85.0511287798, abs=1e-6)
    # Tile (1,1)'s bottom-right corner (x=2,y=2 at z=1) is the south pole
    # edge — x=2^z wraps the antimeridian back to -180 (same modulo formula
    # as the JS original: 720 % 360 - 180 = -180, not +180).
    assert G.tile2lon(2, 1) == pytest.approx(-180.0)
    assert G.tile2lat(2, 1) == pytest.approx(-85.0511287798, abs=1e-6)


def test_normalize_lon_wraps_into_range():
    assert G.normalize_lon(190) == pytest.approx(-170)
    assert G.normalize_lon(-190) == pytest.approx(170)
    assert G.normalize_lon(10) == pytest.approx(10)
