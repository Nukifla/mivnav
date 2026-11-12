# SPDX-License-Identifier: GPL-2.0-only
"""``mivnav.features.weather.gribfetch`` — the DWD/ICON product catalog and
its pure listing-parse/run-discovery/window-selection helpers. No network:
:func:`parse_listing` is exercised against a captured snippet of DWD's real
Apache autoindex HTML (the exact shape observed live against
opendata.dwd.de, 2026-07-26), not a live fetch."""

from __future__ import annotations

from datetime import datetime, timezone

from mivnav.features.weather.gribfetch import (
    PRODUCTS,
    candidate_runs,
    parse_listing,
    product_for,
    run_reference_time,
    steps_for_bake,
)

# A trimmed real listing page (icon-eu, u_10m, run 00Z) — same shape fetched
# live during this feature's investigation.
_ICON_EU_LISTING = """
<html>
<head><title>Index of /weather/nwp/icon-eu/grib/00/u_10m/</title></head>
<body>
<h1>Index of /weather/nwp/icon-eu/grib/00/u_10m/</h1><hr><pre><a href="../">../</a>
<a href="icon-eu_europe_regular-lat-lon_single-level_2026072600_000_U_10M.grib2.bz2">...</a> 26-Jul-2026 02:45:52             1214579
<a href="icon-eu_europe_regular-lat-lon_single-level_2026072600_001_U_10M.grib2.bz2">...</a> 26-Jul-2026 02:45:52             1221710
<a href="icon-eu_europe_regular-lat-lon_single-level_2026072600_078_U_10M.grib2.bz2">...</a> 26-Jul-2026 02:47:41             1200000
<a href="icon-eu_europe_regular-lat-lon_single-level_2026072600_081_U_10M.grib2.bz2">...</a> 26-Jul-2026 02:47:41             1200000
<a href="icon-eu_europe_regular-lat-lon_single-level_2026072600_120_U_10M.grib2.bz2">...</a> 26-Jul-2026 02:50:32             1200000
</pre></body></html>
"""

# A trimmed real listing page (icon-d2, u_10m, run 00Z) — the "both variants
# side by side" case parse_listing must not be fooled by: the icosahedral
# native-grid files must NOT match, only the regular-lat-lon ones.
_ICON_D2_LISTING = """
<html><body><pre>
<a href="icon-d2_germany_icosahedral_single-level_2026072600_000_2d_u_10m.grib2.bz2">...</a> 759301
<a href="icon-d2_germany_regular-lat-lon_single-level_2026072600_000_2d_u_10m.grib2.bz2">...</a> 800000
<a href="icon-d2_germany_regular-lat-lon_single-level_2026072600_048_2d_u_10m.grib2.bz2">...</a> 800000
</pre></body></html>
"""


def test_products_catalog_has_both_v1_entries():
    assert set(PRODUCTS) == {"dwd_icon_eu", "dwd_icon_d2"}


def test_product_for_unknown_id_raises_keyerror():
    import pytest

    with pytest.raises(KeyError):
        product_for("not_a_product")


# -- parse_listing --------------------------------------------------------


def test_parse_listing_extracts_run_and_step_for_icon_eu():
    product = product_for("dwd_icon_eu")
    files = parse_listing(_ICON_EU_LISTING, product.filename_re)
    assert [(f.run, f.step) for f in files] == [
        ("2026072600", 0),
        ("2026072600", 1),
        ("2026072600", 78),
        ("2026072600", 81),
        ("2026072600", 120),
    ]


def test_parse_listing_only_matches_regular_lat_lon_for_icon_d2():
    # The icosahedral-native file sitting right next to the regular-lat-lon
    # one in the SAME directory must never match (see gribfetch.py's module
    # docstring — this is the whole reason the filename regex is specific).
    product = product_for("dwd_icon_d2")
    files = parse_listing(_ICON_D2_LISTING, product.filename_re)
    assert [f.step for f in files] == [0, 48]
    assert all("icosahedral" not in f.filename for f in files)


def test_parse_listing_empty_page_is_empty_not_an_error():
    product = product_for("dwd_icon_eu")
    assert parse_listing("<html><body>Not Found</body></html>", product.filename_re) == []


# -- run_reference_time ----------------------------------------------------


def test_run_reference_time_parses_dwd_filename_convention():
    assert run_reference_time("2026072600") == datetime(2026, 7, 26, 0, 0, tzinfo=timezone.utc)
    assert run_reference_time("2026072615") == datetime(2026, 7, 26, 15, 0, tzinfo=timezone.utc)


# -- candidate_runs ---------------------------------------------------------


def test_candidate_runs_starts_at_or_before_now_most_recent_first():
    product = product_for("dwd_icon_eu")
    now = datetime(2026, 7, 26, 21, 4, tzinfo=timezone.utc)  # just past the 21Z run itself
    runs = candidate_runs(product, now, max_back=4)
    assert runs == [
        datetime(2026, 7, 26, 21, 0, tzinfo=timezone.utc),
        datetime(2026, 7, 26, 18, 0, tzinfo=timezone.utc),
        datetime(2026, 7, 26, 15, 0, tzinfo=timezone.utc),
        datetime(2026, 7, 26, 12, 0, tzinfo=timezone.utc),
    ]


def test_candidate_runs_crosses_a_day_boundary():
    product = product_for("dwd_icon_eu")
    now = datetime(2026, 7, 26, 1, 0, tzinfo=timezone.utc)  # just after midnight, before 00Z lands
    runs = candidate_runs(product, now, max_back=3)
    assert runs == [
        datetime(2026, 7, 26, 0, 0, tzinfo=timezone.utc),
        datetime(2026, 7, 25, 21, 0, tzinfo=timezone.utc),
        datetime(2026, 7, 25, 18, 0, tzinfo=timezone.utc),
    ]


def test_candidate_runs_respects_max_back():
    product = product_for("dwd_icon_eu")
    now = datetime(2026, 7, 26, 21, 4, tzinfo=timezone.utc)
    assert len(candidate_runs(product, now, max_back=2)) == 2


# -- steps_for_bake ----------------------------------------------------------


def test_steps_for_bake_none_keeps_everything_published():
    # Unlike .om's max_forecast_hours=None ("today only"), a GRIB run has no
    # calendar-date concept to cap against — None means "all of it".
    assert steps_for_bake([0, 1, 78, 81, 120], max_forecast_hours=None) == [0, 1, 78, 81, 120]


def test_steps_for_bake_caps_lead_time():
    assert steps_for_bake([0, 1, 78, 81, 120], max_forecast_hours=48) == [0, 1]


def test_steps_for_bake_empty_input_is_empty():
    assert steps_for_bake([], max_forecast_hours=24) == []
