# SPDX-License-Identifier: GPL-2.0-only
"""OSM element -> point-feature mapping — the pure, network-free half of the
POI ingest job. Classifies raw Overpass ``elements`` into the curated set of
maritime POI kinds and emits ``(lon, lat, props)`` for
:func:`chartcore.build_pmtiles`.

See docs/architecture/poi-categories.md for the category taxonomy and why
it's shaped the way it is.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Category:
    """One POI kind and the OSM tag selectors that identify it. A selector
    ``(key, value)`` matches when the element carries ``key`` and either
    ``value is None`` or the tag equals ``value``. See
    docs/architecture/poi-categories.md for the ``group`` taxonomy."""

    kind: str
    selectors: tuple[tuple[str, str | None], ...]
    min_zoom: int = 12
    group: str = "marine"


# Ordered — first matching category wins (see docs/architecture/poi-categories.md).
POI_CATEGORIES: tuple[Category, ...] = (
    Category("marina", (("leisure", "marina"),), min_zoom=7),
    Category(
        "harbour",
        (("harbour", "yes"), ("seamark:type", "harbour")),
        min_zoom=8,
    ),
    Category("anchorage", (("seamark:type", "anchorage"),), min_zoom=9),
    # Harbour-zoom only (the archives' max zoom, DEFAULT_POI_MAX_ZOOM): a
    # harbour office only matters once zoomed right in. Was 10; the frontend's HARBOUR_ONLY marker
    # filter (poi/overlay.ts) hides it below 14 in archives baked before.
    Category(
        "harbourmaster",
        (("office", "harbour_master"), ("amenity", "harbourmaster")),
        min_zoom=14,
    ),
    Category(
        "fuel",
        (("waterway", "fuel"), ("seamark:type", "fuel_station")),
        min_zoom=11,
    ),
    Category("slipway", (("leisure", "slipway"),), min_zoom=12),
    Category("chandlery", (("shop", "chandlery"),), min_zoom=13, group="land"),
    Category("boat_dealer", (("shop", "boat"),), min_zoom=13, group="land"),
    Category("supermarket", (("shop", "supermarket"),), min_zoom=13, group="land"),
    Category("convenience", (("shop", "convenience"),), min_zoom=14, group="land"),
    Category("bakery", (("shop", "bakery"),), min_zoom=14, group="land"),
    Category(
        "hardware",
        (("shop", "hardware"), ("shop", "doityourself")),
        min_zoom=14,
        group="land",
    ),
    Category("laundry", (("shop", "laundry"),), min_zoom=14, group="land"),
    Category("pharmacy", (("amenity", "pharmacy"),), min_zoom=13, group="land"),
    Category(
        "hospital",
        (("amenity", "hospital"), ("amenity", "clinic")),
        min_zoom=12,
        group="land",
    ),
    Category("post_office", (("amenity", "post_office"),), min_zoom=13, group="land"),
    Category("bank", (("amenity", "bank"),), min_zoom=14, group="land"),
    Category("atm", (("amenity", "atm"),), min_zoom=14, group="land"),
    Category("restaurant", (("amenity", "restaurant"),), min_zoom=14, group="land"),
    Category("cafe", (("amenity", "cafe"),), min_zoom=14, group="land"),
    Category("pub", (("amenity", "pub"), ("amenity", "bar")), min_zoom=14, group="land"),
    Category("toilets", (("amenity", "toilets"),), min_zoom=14, group="land"),
)

# Derived from POI_CATEGORIES so it can never drift out of sync.
LAND_KINDS: frozenset[str] = frozenset(
    cat.kind for cat in POI_CATEGORIES if cat.group == "land"
)


def is_land_kind(kind: str) -> bool:
    """Whether ``kind`` is a shore POI (shop/service)."""
    return kind in LAND_KINDS


def overpass_selectors() -> list[tuple[str, str | None]]:
    """Every distinct ``(key, value)`` selector, for building the query.

    De-duplicated across categories, order preserved, so the Overpass union is
    exactly the tags :func:`classify` can resolve.
    """
    seen: list[tuple[str, str | None]] = []
    for cat in POI_CATEGORIES:
        for sel in cat.selectors:
            if sel not in seen:
                seen.append(sel)
    return seen


def _matches(tags: dict, key: str, value: str | None) -> bool:
    if key not in tags:
        return False
    return value is None or tags[key] == value


def classify(tags: dict) -> tuple[str, str] | None:
    """``(kind, kind_detail)`` for these OSM tags, or ``None`` if no category
    matches (an element the query returned for a tag we do not classify)."""
    for cat in POI_CATEGORIES:
        for key, value in cat.selectors:
            if _matches(tags, key, value):
                return cat.kind, str(tags[key])
    return None


def _min_zoom_for(kind: str) -> int:
    for cat in POI_CATEGORIES:
        if cat.kind == kind:
            return cat.min_zoom
    return 12


def _coords(element: dict) -> tuple[float, float] | None:
    """(lon, lat) for a node (direct) or a way/relation (Overpass ``center``)."""
    if "lon" in element and "lat" in element:
        return float(element["lon"]), float(element["lat"])
    center = element.get("center")
    if isinstance(center, dict) and "lon" in center and "lat" in center:
        return float(center["lon"]), float(center["lat"])
    return None


def element_to_feature(element: dict) -> tuple[float, float, dict] | None:
    """One OSM element → ``(lon, lat, props)``, or ``None`` to drop it.

    Dropped when it has no usable coordinate or no tags we classify.
    """
    tags = element.get("tags")
    if not isinstance(tags, dict) or not tags:
        return None
    coords = _coords(element)
    if coords is None:
        return None
    classified = classify(tags)
    if classified is None:
        return None
    kind, kind_detail = classified
    lon, lat = coords
    props: dict = {
        "kind": kind,
        "kind_detail": kind_detail,
        "min_zoom": _min_zoom_for(kind),
    }
    name = tags.get("name")
    if isinstance(name, str) and name.strip():
        props["name"] = name.strip()
    return lon, lat, props


def map_elements(elements: list[dict]) -> list[tuple[float, float, dict]]:
    """Map a list of Overpass elements to point features, dropping unusable ones."""
    features: list[tuple[float, float, dict]] = []
    for element in elements:
        feature = element_to_feature(element)
        if feature is not None:
            features.append(feature)
    return features
