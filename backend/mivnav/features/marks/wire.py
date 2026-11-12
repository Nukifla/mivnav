# SPDX-License-Identifier: GPL-2.0-only
"""A :class:`~mivnav.features.marks.store.Mark` as a SignalK v2
``resources/waypoints`` resource, and back.

SignalK's own slots carry what other apps (Freeboard, OpenCPN via the
plugin, AvNav) can show: ``name``, ``description`` (the note) and a GeoJSON
``Point`` feature. Only the icon has no standard slot, so it rides under
``feature.properties.mivnav`` — the same one-key extension the route wire
uses (:mod:`mivnav.features.route.wire`).
"""

from __future__ import annotations

import copy
import logging
from typing import Any

from mivnav.features.marks.store import (
    DEFAULT_ICON,
    ICONS,
    MAX_NAME_LENGTH,
    MAX_NOTE_LENGTH,
    Mark,
    validate_id,
)

log = logging.getLogger(__name__)

MIVNAV_PROPERTY = "mivnav"
WIRE_VERSION = 1


def to_resource(mark: Mark, base: dict[str, Any] | None = None) -> dict[str, Any]:
    """The body of a ``PUT /resources/waypoints/<id>``. ``base`` is the
    resource as last read from the box: its other keys (another app's
    ``type``, its own properties) are kept, ours overwritten."""
    resource = copy.deepcopy(base) if isinstance(base, dict) else {}
    # A legacy v1 `position` would contradict the feature we write.
    resource.pop("position", None)
    resource["name"] = mark.name
    resource["description"] = mark.note
    feature = resource.get("feature")
    feature = feature if isinstance(feature, dict) else {}
    properties = feature.get("properties")
    properties = properties if isinstance(properties, dict) else {}
    properties[MIVNAV_PROPERTY] = {
        "version": WIRE_VERSION,
        "icon": mark.icon,
        "updated": mark.updated,
    }
    resource["feature"] = {
        **feature,
        "type": "Feature",
        # GeoJSON axis order: [lon, lat].
        "geometry": {"type": "Point", "coordinates": [mark.lon, mark.lat]},
        "properties": properties,
    }
    return resource


def from_resource(mark_id: str, resource: Any) -> Mark | None:
    """A :class:`Mark` from one SignalK waypoint resource, or ``None`` when
    it has no usable position or id. Forgiving about everything else: half
    of these were written by other programs."""
    try:
        mark_id = validate_id(mark_id)
    except Exception:  # noqa: BLE001
        log.info("ignoring a SignalK waypoint with an unusable id: %r", mark_id)
        return None
    if not isinstance(resource, dict):
        return None
    position = _position(resource)
    if position is None:
        log.info("ignoring SignalK waypoint %s: no Point position", mark_id)
        return None
    lon, lat = position
    props = _mivnav_properties(resource)
    icon = props.get("icon")
    updated = props.get("updated")
    return Mark(
        id=mark_id,
        name=_text(resource.get("name"), MAX_NAME_LENGTH),
        note=_text(resource.get("description"), MAX_NOTE_LENGTH),
        icon=icon if icon in ICONS else DEFAULT_ICON,
        lat=lat,
        lon=lon,
        updated=float(updated)
        if isinstance(updated, (int, float)) and not isinstance(updated, bool) and updated >= 0
        else 0.0,
    )


def _position(resource: dict[str, Any]) -> tuple[float, float] | None:
    feature = resource.get("feature")
    geometry = feature.get("geometry") if isinstance(feature, dict) else None
    if isinstance(geometry, dict) and geometry.get("type") == "Point":
        coords = geometry.get("coordinates")
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            return _valid(coords[0], coords[1])
        return None
    # The v1 shape some older apps still write.
    legacy = resource.get("position")
    if isinstance(legacy, dict):
        return _valid(legacy.get("longitude"), legacy.get("latitude"))
    return None


def _valid(lon: Any, lat: Any) -> tuple[float, float] | None:
    for v in (lon, lat):
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            return None
    if not (-180 <= lon <= 180) or not (-90 <= lat <= 90):
        return None
    return float(lon), float(lat)


def _mivnav_properties(resource: dict[str, Any]) -> dict[str, Any]:
    feature = resource.get("feature")
    properties = feature.get("properties") if isinstance(feature, dict) else None
    props = properties.get(MIVNAV_PROPERTY) if isinstance(properties, dict) else None
    return props if isinstance(props, dict) else {}


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


__all__ = ["MIVNAV_PROPERTY", "WIRE_VERSION", "from_resource", "to_resource"]
