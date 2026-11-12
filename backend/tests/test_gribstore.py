# SPDX-License-Identifier: GPL-2.0-only
"""``mivnav.features.weather.gribstore`` — the serve-time index over baked
(``grib/<product>/``) and hand-dropped (``grib/manual/``) GRIB files.

Uses the two real, committed fixture files under ``backend/data/grib/``
(see that directory's ``SOURCE.txt``) rather than a mock — the grid
definition and local-timezone correction are exactly the kind of thing a
hand-rolled fixture could get subtly wrong, so this exercises the real
``gribberish`` decode path end to end."""

from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest

from mivnav.features.weather.gribstore import GribStore, _local_utc_offset, _to_utc

_FIXTURE_DIR = Path(__file__).parent.parent / "data" / "grib"
_U_FIXTURE = _FIXTURE_DIR / "icon-eu_europe_regular-lat-lon_single-level_2026072600_000_U_10M.grib2"
_V_FIXTURE = _FIXTURE_DIR / "icon-eu_europe_regular-lat-lon_single-level_2026072600_000_V_10M.grib2"

# The fixture's own identity (run 2026-07-26 00Z, step +000h) — see SOURCE.txt.
_VALID_TIME = datetime(2026, 7, 26, 0, 0, tzinfo=timezone.utc)


def _populate_product_dir(dataset_dir: Path) -> None:
    product_dir = dataset_dir / "grib" / "dwd_icon_eu"
    (product_dir / "u_10m").mkdir(parents=True)
    (product_dir / "v_10m").mkdir(parents=True)
    shutil.copy(_U_FIXTURE, product_dir / "u_10m" / _U_FIXTURE.name)
    shutil.copy(_V_FIXTURE, product_dir / "v_10m" / _V_FIXTURE.name)


# -- fetched (grib/<product>/) entries: identity from the FILENAME ----------


def test_resolve_uv_finds_both_components_from_fetched_files(tmp_path):
    _populate_product_dir(tmp_path)
    store = GribStore(tmp_path, "dwd_icon_eu")

    found = store.resolve_uv(_VALID_TIME)

    assert found is not None
    u_path, v_path = found
    assert u_path.name == _U_FIXTURE.name
    assert v_path.name == _V_FIXTURE.name


def test_resolve_uv_returns_none_for_an_unbaked_valid_time(tmp_path):
    _populate_product_dir(tmp_path)
    store = GribStore(tmp_path, "dwd_icon_eu")

    other_time = datetime(2026, 7, 27, 0, 0, tzinfo=timezone.utc)

    assert store.resolve_uv(other_time) is None


def test_resolve_uv_returns_none_when_only_one_component_is_present(tmp_path):
    product_dir = tmp_path / "grib" / "dwd_icon_eu"
    (product_dir / "u_10m").mkdir(parents=True)
    shutil.copy(_U_FIXTURE, product_dir / "u_10m" / _U_FIXTURE.name)
    store = GribStore(tmp_path, "dwd_icon_eu")

    assert store.resolve_uv(_VALID_TIME) is None


def test_resolve_uv_with_no_files_at_all_is_none(tmp_path):
    store = GribStore(tmp_path, "dwd_icon_eu")
    assert store.resolve_uv(_VALID_TIME) is None


# -- grid_definition: built from the message's OWN GDS, not a catalog -------


def test_grid_definition_matches_icon_eus_known_regular_lat_lon_grid(tmp_path):
    # Public, well-known ICON-EU regular-lat-lon grid parameters — this
    # fixture's own header should reproduce them exactly, not a hardcoded
    # catalog entry (see gribfetch.py's module docstring for why there is
    # no such catalog here, unlike domains.py for .om).
    _populate_product_dir(tmp_path)
    store = GribStore(tmp_path, "dwd_icon_eu")

    grid = store.grid_definition()

    assert grid["type"] == "regular"
    assert grid["nx"] == 1377
    assert grid["ny"] == 657
    assert grid["dx"] == pytest.approx(0.0625)
    assert grid["dy"] == pytest.approx(0.0625)
    assert grid["lonMin"] == pytest.approx(-23.5)
    assert grid["latMin"] == pytest.approx(29.5)


# -- valid_times: the discrete set GET /weather/baked summarises as a span --


def test_valid_times_reports_the_one_fully_baked_hour(tmp_path):
    _populate_product_dir(tmp_path)
    store = GribStore(tmp_path, "dwd_icon_eu")

    assert store.valid_times() == [_VALID_TIME]


def test_valid_times_excludes_a_time_missing_one_component(tmp_path):
    product_dir = tmp_path / "grib" / "dwd_icon_eu"
    (product_dir / "u_10m").mkdir(parents=True)
    shutil.copy(_U_FIXTURE, product_dir / "u_10m" / _U_FIXTURE.name)
    store = GribStore(tmp_path, "dwd_icon_eu")

    assert store.valid_times() == []


def test_valid_times_empty_with_no_files_at_all(tmp_path):
    store = GribStore(tmp_path, "dwd_icon_eu")
    assert store.valid_times() == []


# -- manual/ entries: identity from the GRIB message HEADER, incl. the
# local-timezone correction --------------------------------------------------


def test_manual_file_is_discovered_by_header_regardless_of_filename(tmp_path):
    manual_dir = tmp_path / "grib" / "manual"
    manual_dir.mkdir(parents=True)
    # Deliberately NOT the upstream naming convention — the whole point of
    # `manual/` is that identity comes from the message header, not the name.
    shutil.copy(_U_FIXTURE, manual_dir / "some-random-name-a-sailor-picked.grib2")
    shutil.copy(_V_FIXTURE, manual_dir / "and-another-one.grib2")
    store = GribStore(tmp_path, "dwd_icon_eu")

    found = store.resolve_uv(_VALID_TIME)

    assert found is not None


def test_manual_file_with_an_unrecognised_field_is_skipped_not_fatal(tmp_path):
    manual_dir = tmp_path / "grib" / "manual"
    manual_dir.mkdir(parents=True)
    (manual_dir / "not-a-grib-file.grib2").write_bytes(b"not actually grib data")
    store = GribStore(tmp_path, "dwd_icon_eu")

    # Must not raise — an unreadable/foreign file is silently skipped (see
    # gribstore.py's module docstring).
    assert store.resolve_uv(_VALID_TIME) is None


# -- the local-timezone correction itself ------------------------------------


def test_to_utc_undoes_a_naive_local_offset():
    # Simulate gribberish's quirk directly: naive_local = utc + local_offset.
    offset = _local_utc_offset()
    utc_moment = datetime(2026, 7, 26, 0, 0)
    naive_local = utc_moment + offset
    assert _to_utc(naive_local) == utc_moment.replace(tzinfo=timezone.utc)
