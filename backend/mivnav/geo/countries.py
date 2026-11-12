# SPDX-License-Identifier: GPL-2.0-only
"""Country administrative boundaries — the bundled lookup a POI region uses to
turn an ISO country code into a real boundary polygon or a bounding box.

See docs/architecture/country-boundaries.md for the data source, the ISO
join key vs. Overpass, and why this module must stay import-cycle-free.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

_DATA_PATH = Path(__file__).parent / "data" / "ne_50m_admin_0_countries.geojson.gz"

# list of polygons of rings of (lon, lat); ring 0 of each polygon is the
# exterior, the rest are holes. Covers both GeoJSON Polygon and MultiPolygon.
Ring = list[tuple[float, float]]
Polygon = list[Ring]
CountryGeometry = list[Polygon]


class _Country:
    __slots__ = ("iso", "name", "geometry")

    def __init__(self, iso: str, name: str, geometry: CountryGeometry) -> None:
        self.iso = iso
        self.name = name
        self.geometry = geometry


_cache: dict[str, _Country] | None = None


def _normalise_geometry(geom: dict) -> CountryGeometry:
    """A GeoJSON Polygon/MultiPolygon geometry → the :data:`CountryGeometry`
    shape (list of polygons of rings of ``(lon, lat)``)."""
    gtype = geom["type"]
    coords = geom["coordinates"]
    if gtype == "Polygon":
        raw_polygons = [coords]
    elif gtype == "MultiPolygon":
        raw_polygons = coords
    else:
        raise ValueError(f"unsupported country geometry type {gtype!r}")
    polygons: CountryGeometry = []
    for raw_poly in raw_polygons:
        rings: Polygon = [
            [(float(pt[0]), float(pt[1])) for pt in ring] for ring in raw_poly
        ]
        polygons.append(rings)
    return polygons


def _load() -> dict[str, _Country]:
    global _cache
    if _cache is None:
        with gzip.open(_DATA_PATH, "rt", encoding="utf-8") as fh:
            fc = json.load(fh)
        by_iso: dict[str, _Country] = {}
        for feature in fc["features"]:
            props = feature["properties"]
            iso = str(props["iso"]).upper()
            polygons = _normalise_geometry(feature["geometry"])
            existing = by_iso.get(iso)
            if existing is None:
                by_iso[iso] = _Country(iso, str(props["name"]), polygons)
            else:
                # Some ISO codes span several features (e.g. AU = mainland +
                # territories); merge polygons so the bbox covers all of them.
                existing.geometry.extend(polygons)
        _cache = by_iso
    return _cache


def _get(iso: str) -> _Country:
    country = _load().get(iso.upper())
    if country is None:
        raise KeyError(f"unknown country ISO code {iso!r}")
    return country


def list_countries() -> list[tuple[str, str]]:
    """``(iso, name)`` for every bundled country, sorted by name. For the
    dropdown."""
    return sorted(
        ((c.iso, c.name) for c in _load().values()), key=lambda pair: pair[1]
    )


def is_country(iso: str) -> bool:
    """Whether ``iso`` (case-insensitive) resolves to a bundled country."""
    return iso.upper() in _load()


def country_name(iso: str) -> str:
    """The country's display name. Raises :class:`KeyError` for an unknown
    ISO code."""
    return _get(iso).name


def country_bbox(iso: str) -> tuple[float, float, float, float]:
    """``(min_lon, min_lat, max_lon, max_lat)`` enclosing the whole country,
    computed by walking every ring of its geometry. Raises :class:`KeyError`
    for an unknown ISO code."""
    country = _get(iso)
    min_lon = min_lat = float("inf")
    max_lon = max_lat = float("-inf")
    for polygon in country.geometry:
        for ring in polygon:
            for lon, lat in ring:
                min_lon = min(min_lon, lon)
                min_lat = min(min_lat, lat)
                max_lon = max(max_lon, lon)
                max_lat = max(max_lat, lat)
    if min_lon == float("inf"):
        raise ValueError(f"country {iso!r} has no coordinates")
    return (min_lon, min_lat, max_lon, max_lat)


def country_polygon(iso: str) -> CountryGeometry:
    """The country's boundary as :data:`CountryGeometry`. Raises
    :class:`KeyError` for an unknown ISO code."""
    return _get(iso).geometry
