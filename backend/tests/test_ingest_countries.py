# SPDX-License-Identifier: GPL-2.0-only
"""POI region by country: the bundled Natural Earth loader, the Region
country variant, the Overpass boundary-``area`` query builder, and the
country-aware endpoints — all without touching the network.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from mivnav.geo import countries


# -- the bundled loader ----------------------------------------------------


def test_list_countries_non_empty_and_sorted_by_name() -> None:
    listed = countries.list_countries()
    assert len(listed) > 100
    names = [name for _, name in listed]
    assert names == sorted(names)
    # each entry is (iso, name) with a 2-letter code
    for iso, name in listed:
        assert len(iso) == 2 and iso.isupper()
        assert name


def test_country_bbox_denmark_in_sane_range() -> None:
    min_lon, min_lat, max_lon, max_lat = countries.country_bbox("DK")
    # Mainland + islands: roughly 8-15E, 54-58N.
    assert 7 < min_lon < 9
    assert 14 < max_lon < 16
    assert 54 < min_lat < 55
    assert 57 < max_lat < 58


def test_iso_is_normalised_to_uppercase() -> None:
    assert countries.is_country("dk")
    assert countries.country_bbox("dk") == countries.country_bbox("DK")


def test_france_and_norway_resolve() -> None:
    # The ISO_A2_EH cases — plain ISO_A2 leaves these blank in Natural Earth.
    assert countries.is_country("FR")
    assert countries.country_name("FR") == "France"
    assert countries.is_country("NO")
    assert countries.country_name("NO") == "Norway"


def test_unknown_iso_raises() -> None:
    assert not countries.is_country("ZZ")
    with pytest.raises(KeyError):
        countries.country_bbox("ZZ")
    with pytest.raises(KeyError):
        countries.country_name("ZZ")


def test_country_polygon_shape_is_rings_of_lonlat() -> None:
    poly = countries.country_polygon("DK")
    assert isinstance(poly, list) and poly
    exterior = poly[0][0]  # first polygon, its exterior ring
    lon, lat = exterior[0]
    assert isinstance(lon, float) and isinstance(lat, float)


def test_duplicate_iso_features_are_merged() -> None:
    # AU spans several NE features (mainland + territories); the bbox must
    # cover the whole continent, not one territory.
    min_lon, min_lat, max_lon, max_lat = countries.country_bbox("AU")
    assert min_lon < 115 and max_lon > 150  # spans the mainland width


# -- the Region country variant -----------------------------------------


def test_region_country_variant_bbox_comes_from_data() -> None:
    from mivnav.config.model import Region

    region = Region(id="dk", country="dk")  # lower-case accepted, normalised
    assert region.iso == "DK"
    assert region.bbox == countries.country_bbox("DK")


def test_region_bbox_variant_unchanged() -> None:
    from mivnav.config.model import Region

    region = Region(id="solent")  # Solent default, no country
    assert region.iso is None
    assert region.bbox == (-1.65, 50.68, -1.05, 50.82)


def test_region_country_plus_explicit_bbox_takes_country() -> None:
    """Was a rejected XOR; now a value-based precedence (kolmnrsk) — see
    `Region._country_xor_bbox`'s docstring for why the reject wasn't
    round-trip safe. `country` wins; the bbox fields are ignored, not an
    error, same as any other leftover-on-the-wire field for this variant."""
    from mivnav.config.model import Region

    region = Region(id="dk", country="DK", min_lon=1.0, min_lat=2.0, max_lon=3.0, max_lat=4.0)
    assert region.iso == "DK"
    assert region.bbox == countries.country_bbox("DK")


def test_region_bad_country_is_rejected() -> None:
    from pydantic import ValidationError

    from mivnav.config.model import Region

    with pytest.raises(ValidationError):
        Region(id="zz", country="ZZ")


def test_region_still_forbids_extra_fields() -> None:
    from pydantic import ValidationError

    from mivnav.config.model import Region

    with pytest.raises(ValidationError):
        Region(id="dk", country="DK", typo=1)


# -- the Overpass area query builder ---------------------------------------


def test_area_query_emits_iso_area_filter_and_no_bbox() -> None:
    from mivnav.features.poi import overpass

    q = overpass.build_area_query("dk")
    assert 'area["ISO3166-1"="DK"]["admin_level"="2"]->.a;' in q
    assert "(area.a)" in q
    assert "out center tags;" in q
    # No bbox tuple leaked in — a bbox clause looks like "(54.63,8.12,...)".
    assert "8.12" not in q
    assert "50.68" not in q


def test_bbox_query_still_has_no_area_filter() -> None:
    from mivnav.features.poi import overpass

    q = overpass.build_query((-1.65, 50.68, -1.05, 50.82))
    assert "ISO3166-1" not in q
    assert "(50.68,-1.65,50.82,-1.05)" in q


# -- the endpoint ------------------------------------------------------------
#
# The ad hoc `/ingest/poi` bake-trigger tests that used to live here (country
# bakes via the area fetch, unknown-country/country+bbox rejection) are gone
# along with that route (mivnav.features.poi.routes, retired in favour of the
# generic `PUT /datasets/{id}` + `POST /datasets/{id}/ingest`) — the same
# area-fetch/per-region-naming behaviour they exercised is still covered,
# directly against PoiIngestRunner, by test_ingest_poi.py's
# `test_country_bake_uses_area_path_by_default` and
# `test_country_bake_writes_named_per_region_set`; the request-time
# validation they checked (unknown country, country+bbox both set) had no
# life beyond that route and is not re-created elsewhere.


def test_get_countries_endpoint_lists_them(client: TestClient) -> None:
    body = client.get("/ingest/countries").json()
    listed = body["countries"]
    assert len(listed) > 100
    isos = {c["iso"] for c in listed}
    assert "DK" in isos and "FR" in isos
    names = [c["name"] for c in listed]
    assert names == sorted(names)
