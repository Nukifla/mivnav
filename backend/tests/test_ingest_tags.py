# SPDX-License-Identifier: GPL-2.0-only
"""Pure unit tests for the OSM element → point-feature mapping.

No network: a fixture Overpass ``elements`` blob is mapped and asserted. This
is the half of the POI ingest job that decides what a POI *is* and what tags it
carries into the tile, so it is tested in isolation from the fetch and the bake.
"""

from mivnav.features.poi.overpass import BBox, build_query
from mivnav.features.poi.tags import (
    classify,
    element_to_feature,
    is_land_kind,
    map_elements,
    overpass_selectors,
)

# A representative Overpass response: a node marina, a way marina (centroid via
# `center`), a fuel node, an unnamed anchorage, a road petrol station we do NOT
# classify, and an element with no coordinate.
FIXTURE_ELEMENTS = [
    {
        "type": "node",
        "id": 1,
        "lat": 50.75,
        "lon": -1.30,
        "tags": {"leisure": "marina", "name": "Test Marina"},
    },
    {
        "type": "way",
        "id": 2,
        "center": {"lat": 50.76, "lon": -1.31},
        "tags": {"leisure": "marina", "harbour": "yes", "name": "Area Marina"},
    },
    {
        "type": "node",
        "id": 3,
        "lat": 50.70,
        "lon": -1.20,
        "tags": {"waterway": "fuel", "name": "Fuel Berth"},
    },
    {
        "type": "node",
        "id": 4,
        "lat": 50.71,
        "lon": -1.22,
        "tags": {"seamark:type": "anchorage"},  # no name
    },
    {
        "type": "node",
        "id": 5,
        "lat": 50.60,
        "lon": -1.10,
        "tags": {"amenity": "fuel", "name": "Roadside Petrol"},  # not classified
    },
    {
        "type": "way",
        "id": 6,
        "tags": {"leisure": "marina"},  # no coordinate → dropped
    },
]


def test_classify_orders_specific_first():
    # leisure=marina wins even when harbour=yes is also present (marina first).
    assert classify({"leisure": "marina", "harbour": "yes"}) == ("marina", "marina")
    assert classify({"waterway": "fuel"}) == ("fuel", "fuel")
    assert classify({"seamark:type": "anchorage"}) == ("anchorage", "anchorage")
    # kind_detail carries the concrete OSM value that matched.
    assert classify({"seamark:type": "harbour"}) == ("harbour", "harbour")


def test_classify_returns_none_for_land_fuel():
    # amenity=fuel is deliberately NOT in the curated set (petrol stations are
    # dense and not useful), even though the shore shops now are.
    assert classify({"amenity": "fuel"}) is None
    # A tag we simply do not curate.
    assert classify({"shop": "clothes"}) is None


def test_removed_kinds_no_longer_classify():
    # mooring and drinking_water were dropped from the curated set.
    assert classify({"mooring": "yes"}) is None
    assert classify({"seamark:type": "mooring"}) is None
    assert classify({"amenity": "drinking_water"}) is None


def test_land_pois_classify_to_their_kind():
    assert classify({"shop": "supermarket"}) == ("supermarket", "supermarket")
    assert classify({"amenity": "pharmacy"}) == ("pharmacy", "pharmacy")
    assert classify({"shop": "chandlery"}) == ("chandlery", "chandlery")
    assert classify({"shop": "doityourself"}) == ("hardware", "doityourself")
    assert classify({"amenity": "bar"}) == ("pub", "bar")


def test_land_vs_marine_kind_flags():
    # Land shore kinds report as land…
    assert is_land_kind("supermarket")
    assert is_land_kind("pharmacy")
    assert is_land_kind("chandlery")
    # …marine kinds do not.
    assert not is_land_kind("marina")
    assert not is_land_kind("harbour")
    assert not is_land_kind("fuel")


def test_land_kinds_have_higher_min_zoom_than_marine():
    _, _, marina = element_to_feature(FIXTURE_ELEMENTS[0])
    supermarket = element_to_feature(
        {"type": "node", "id": 9, "lat": 1.0, "lon": 1.0,
         "tags": {"shop": "supermarket"}}
    )
    assert supermarket is not None
    assert supermarket[2]["min_zoom"] > marina["min_zoom"]


def test_harbourmaster_ranks_at_harbour_zoom():
    # OSM's harbourmaster (either tagging) appears only once zoomed all the
    # way in to the harbour, the archives' max zoom — not at z10 on top of
    # its own marina.
    from mivnav.features.poi.config import DEFAULT_POI_MAX_ZOOM

    for tags in ({"office": "harbour_master"}, {"amenity": "harbourmaster"}):
        feat = element_to_feature({"type": "node", "id": 1, "lat": 55.0, "lon": 10.0, "tags": tags})
        assert feat is not None
        assert feat[2]["kind"] == "harbourmaster"
        assert feat[2]["min_zoom"] == DEFAULT_POI_MAX_ZOOM == 14, tags


def test_settlement_nodes_are_not_classified_at_all():
    # Task nvpxzxxq: POI ingest no longer fetches place names — the OSM world
    # basemap already carries them (rendered from its own `places` layer, and
    # indexed for search by mivnav.features.osm_world.places), so a settlement
    # node is simply not a POI category any more.
    for value in ("city", "town", "village", "hamlet", "suburb"):
        assert classify({"place": value}) is None
        assert element_to_feature(
            {"type": "node", "id": 1, "lat": 1.0, "lon": 1.0,
             "tags": {"place": value, "name": "X"}}
        ) is None


def test_land_and_marine_are_the_only_groups():
    # Every kind is coast-filtered identically now, so `group` only separates
    # shore kinds from on-the-water ones.
    assert is_land_kind("supermarket")
    assert not is_land_kind("marina")


def test_overpass_selectors_carry_no_place_tags():
    # The query is built from the category table, so dropping the categories
    # is what stops the fetch — nothing asks Overpass for settlements.
    assert not [sel for sel in overpass_selectors() if sel[0] == "place"]


def test_element_to_feature_node():
    feat = element_to_feature(FIXTURE_ELEMENTS[0])
    assert feat is not None
    lon, lat, props = feat
    assert (lon, lat) == (-1.30, 50.75)
    assert props["kind"] == "marina"
    assert props["kind_detail"] == "marina"
    assert props["name"] == "Test Marina"
    assert isinstance(props["min_zoom"], int)


def test_element_to_feature_way_uses_center():
    lon, lat, props = element_to_feature(FIXTURE_ELEMENTS[1])
    assert (lon, lat) == (-1.31, 50.76)
    assert props["kind"] == "marina"


def test_element_to_feature_omits_missing_name():
    lon, lat, props = element_to_feature(FIXTURE_ELEMENTS[3])
    assert props["kind"] == "anchorage"
    assert "name" not in props


def test_map_elements_drops_unclassified_and_coordless():
    features = map_elements(FIXTURE_ELEMENTS)
    # 4 kept: two marinas, one fuel, one anchorage. Dropped: roadside petrol
    # (unclassified) and the coordinate-less way.
    assert len(features) == 4
    kinds = sorted(props["kind"] for _, _, props in features)
    assert kinds == ["anchorage", "fuel", "marina", "marina"]


def test_build_query_covers_every_selector_and_bbox_order():
    bbox: BBox = (-1.65, 50.68, -1.05, 50.82)
    query = build_query(bbox)
    # Overpass bbox order is (south, west, north, east).
    assert "(50.68,-1.65,50.82,-1.05)" in query
    assert query.startswith("[out:json]")
    assert "out center tags;" in query
    # every curated selector appears as a clause
    for key, value in overpass_selectors():
        needle = f'["{key}"]' if value is None else f'["{key}"="{value}"]'
        assert needle in query
    # the new land selectors are among them
    assert '["shop"="supermarket"]' in query
    assert '["amenity"="pharmacy"]' in query
    assert '["shop"="chandlery"]' in query
