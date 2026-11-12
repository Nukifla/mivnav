# SPDX-License-Identifier: GPL-2.0-only
"""``mivnav.features.weather.grib_render`` — ``GribDecoder``, exercised
against the real committed fixture files (``backend/data/grib/``).

The exact-corner-point check below is the important one: it catches a
row/column indexing-order bug (e.g. treating the flat array as
column-major, or flipping north/south) that a "the numbers looked
plausible" spot check would miss — it compares the decoder's OWN bilinear
interpolation, evaluated exactly AT a grid corner (zero fractional offset,
so bilinear degenerates to an exact lookup), against indexing the raw
`gribberish`-decoded array directly by hand."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path

import gribberish
import numpy as np
import pytest

from mivnav.features.weather.grib_render import GribDecoder
from mivnav.features.weather.gribstore import GribStore

_FIXTURE_DIR = Path(__file__).parent.parent / "data" / "grib"
_U_FIXTURE = _FIXTURE_DIR / "icon-eu_europe_regular-lat-lon_single-level_2026072600_000_U_10M.grib2"
_V_FIXTURE = _FIXTURE_DIR / "icon-eu_europe_regular-lat-lon_single-level_2026072600_000_V_10M.grib2"
_VALID_TIME = datetime(2026, 7, 26, 0, 0, tzinfo=timezone.utc)


def _store(tmp_path: Path) -> GribStore:
    import shutil

    product_dir = tmp_path / "grib" / "dwd_icon_eu"
    (product_dir / "u_10m").mkdir(parents=True)
    (product_dir / "v_10m").mkdir(parents=True)
    shutil.copy(_U_FIXTURE, product_dir / "u_10m" / _U_FIXTURE.name)
    shutil.copy(_V_FIXTURE, product_dir / "v_10m" / _V_FIXTURE.name)
    return GribStore(tmp_path, "dwd_icon_eu")


def test_decode_uv_matches_the_raw_array_at_an_exact_grid_corner(tmp_path):
    store = _store(tmp_path)
    decoder = GribDecoder()

    u_field, v_field = asyncio.run(decoder.decode_uv(store, _VALID_TIME))

    grid = store.grid_definition()
    lat0, lon0 = grid["latMin"], grid["lonMin"]

    # Bilinear interpolation exactly AT the (0, 0) grid point degenerates to
    # a plain lookup of index 0 — no fractional blending to obscure an
    # indexing bug.
    raw_u = np.asarray(gribberish.parse_grib_message(_U_FIXTURE.read_bytes(), 0).data()).ravel()
    raw_v = np.asarray(gribberish.parse_grib_message(_V_FIXTURE.read_bytes(), 0).data()).ravel()

    assert u_field.interpolate(lat0, lon0) == pytest.approx(raw_u[0], abs=1e-6)
    assert v_field.interpolate(lat0, lon0) == pytest.approx(raw_v[0], abs=1e-6)


def test_decode_uv_matches_the_raw_array_at_a_non_origin_corner(tmp_path):
    """Same check, but at a cell deep inside the grid (not the (0,0)
    origin) — confirms `nx`/row-major stride is right, not just the first
    element."""
    store = _store(tmp_path)
    decoder = GribDecoder()
    grid_def = store.grid_definition()
    nx, ny = grid_def["nx"], grid_def["ny"]
    row, col = 300, 700  # arbitrary interior point
    lat = grid_def["latMin"] + row * grid_def["dy"]
    lon = grid_def["lonMin"] + col * grid_def["dx"]

    u_field, v_field = asyncio.run(decoder.decode_uv(store, _VALID_TIME))
    raw_u = np.asarray(gribberish.parse_grib_message(_U_FIXTURE.read_bytes(), 0).data()).ravel()

    expected = raw_u[row * nx + col]
    assert u_field.interpolate(lat, lon) == pytest.approx(expected, abs=1e-6)


def test_decode_speed_is_the_pythagorean_magnitude_of_uv(tmp_path):
    store = _store(tmp_path)
    decoder = GribDecoder()

    u_field, v_field = asyncio.run(decoder.decode_uv(store, _VALID_TIME))
    speed_field = asyncio.run(decoder.decode_speed(store, _VALID_TIME))

    grid_def = store.grid_definition()
    lat = grid_def["latMin"] + 10 * grid_def["dy"]
    lon = grid_def["lonMin"] + 10 * grid_def["dx"]

    u = u_field.interpolate(lat, lon)
    v = v_field.interpolate(lat, lon)
    speed = speed_field.interpolate(lat, lon)

    assert speed == pytest.approx((u**2 + v**2) ** 0.5, abs=1e-6)

