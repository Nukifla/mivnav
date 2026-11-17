# SPDX-License-Identifier: GPL-2.0-only
"""mivport place → POI point feature + stored detail — the pure,
network-free half of the mivport POI source.

A place arrives in one of two shapes, both read by :func:`normalize`:

- an export line (``<region>.geojsonl.gz``): properties flat, OSM parts as
  ``osm_type``/``osm_id``/``osm_tags``/``osm_attrs``;
- an API feature (``/v1/places/{id}``): OSM parts nested under ``osm``.

Point props (MVT layer ``pois``): ``{name, kind, kind_detail, min_zoom,
src: "mivport", ref}``. ``kind`` is the host POI kind where one fits (so a
mivport marina draws like any marina), else the mivport kind; ``kind_detail``
is always the mivport kind; ``ref`` the mivport place id.
"""

from __future__ import annotations

from typing import Any

from mivnav.features.poi.tags import POI_CATEGORIES

__all__ = ["SRC", "host_kind", "min_zoom_for", "normalize", "point_feature"]

SRC = "mivport"

#: mivport kind → host POI kind, where the names differ.
_HOST_KIND: dict[str, str] = {
    "harbour_office": "harbourmaster",
    "boat_shop": "boat_dealer",
}
_HOST_KINDS = frozenset(cat.kind for cat in POI_CATEGORIES)

#: Ranks of the kinds the host doesn't have, on the host's ladder: harbour
#: and anchoring early, boat services mid, facilities with the shore kinds.
_OWN_MIN_ZOOM: dict[str, int] = {
    "mooring": 10,
    "customs": 10,
    "pump_out": 12,
    "boat_hoist": 12,
    "boatyard": 12,
    "club": 12,
    "water": 12,
    "waste_disposal": 13,
    "sailmaker": 13,
    "electricity": 13,
    "showers": 14,
    "other": 14,
}
_MIN_ZOOM: dict[str, int] = {
    **{cat.kind: cat.min_zoom for cat in POI_CATEGORIES},
    **_OWN_MIN_ZOOM,
}


def host_kind(kind: str) -> str:
    mapped = _HOST_KIND.get(kind, kind)
    return mapped if mapped in _HOST_KINDS or mapped in _OWN_MIN_ZOOM else "other"


def min_zoom_for(kind: str) -> int:
    return _MIN_ZOOM.get(host_kind(kind), _MIN_ZOOM["other"])


def _lonlat(geometry: Any) -> tuple[float, float] | None:
    if not isinstance(geometry, dict) or geometry.get("type") != "Point":
        return None
    coords = geometry.get("coordinates")
    if not isinstance(coords, (list, tuple)) or len(coords) < 2:
        return None
    try:
        lon, lat = float(coords[0]), float(coords[1])
    except (TypeError, ValueError):
        return None
    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        return None
    return lon, lat


def _dict(value: Any) -> dict | None:
    return value if isinstance(value, dict) and value else None


def normalize(feature: Any) -> tuple[float, float, dict] | None:
    """``(lon, lat, detail)`` for one place in either shape, or ``None`` for
    a malformed one (no id, no kind, no point). ``detail`` holds only what the
    info panel needs; empty fields are left out."""
    if not isinstance(feature, dict):
        return None
    props = feature.get("properties")
    coords = _lonlat(feature.get("geometry"))
    if not isinstance(props, dict) or coords is None:
        return None
    ref, kind = props.get("id"), props.get("kind")
    if not isinstance(ref, str) or not ref or not isinstance(kind, str) or not kind:
        return None
    nested = props.get("osm") if isinstance(props.get("osm"), dict) else {}
    osm_type = props.get("osm_type") or nested.get("type")
    osm_id = props.get("osm_id") if props.get("osm_id") is not None else nested.get("id")
    detail: dict[str, Any] = {
        "ref": ref,
        "kind": kind,
        "source": props.get("source") if props.get("source") in ("core", "osm") else "osm",
    }
    name = props.get("name")
    if isinstance(name, str) and name.strip():
        detail["name"] = name.strip()
    for key, value in (
        ("attrs", _dict(props.get("attrs"))),
        ("attrs_set_at", _dict(props.get("attrs_set_at"))),
        ("osm_attrs", _dict(props.get("osm_attrs")) or _dict(nested.get("attrs"))),
        ("osm_tags", _dict(props.get("osm_tags")) or _dict(nested.get("tags"))),
    ):
        if value is not None:
            detail[key] = value
    if osm_type in ("node", "way", "relation") and isinstance(osm_id, int):
        detail["osm"] = {"type": osm_type, "id": osm_id}
    if isinstance(props.get("updated_at"), str):
        detail["updated_at"] = props["updated_at"]
    # The stored revision: an edit's ``base_rev``. OSM-only places have none.
    if isinstance(props.get("rev"), int) and not isinstance(props.get("rev"), bool):
        detail["rev"] = props["rev"]
    if props.get("status") == "deleted":
        detail["deleted"] = True
    return coords[0], coords[1], detail


def point_feature(lon: float, lat: float, detail: dict) -> tuple[float, float, dict]:
    """The tile point for a normalized place."""
    kind = detail["kind"]
    props: dict[str, Any] = {
        "kind": host_kind(kind),
        "kind_detail": kind,
        "min_zoom": min_zoom_for(kind),
        "src": SRC,
        "ref": detail["ref"],
    }
    if "name" in detail:
        props["name"] = detail["name"]
    return lon, lat, props
