# SPDX-License-Identifier: GPL-2.0-only
"""How a mivnav :class:`~mivnav.features.route.store.Route` is spelled as a
SignalK ``resources/routes`` resource, and back.

SignalK is the ONLY place routes are stored (#vozswkrl) — there is no
``routes.json`` any more — so this module is the whole of the persistence
format, and also the interop surface with Freeboard/AvNav/OpenCPN. See
docs/architecture/route-signalk-wire-format.md for the ``feature.properties.
mivnav`` extension contract, import identity rules, and the one unverified
edge case inherited from #zsswlmpz.
"""

from __future__ import annotations

import logging
from typing import Any

from mivnav.features.route.store import (
    DEFAULT_PLAN_SPEED_KN,
    MAX_NAME_LENGTH,
    MAX_PLAN_SPEED_KN,
    MAX_WAYPOINTS,
    Route,
    Waypoint,
    parse_depart_at,
    validate_id,
)

log = logging.getLogger(__name__)

#: The one ``feature.properties`` key mivnav writes. Everything mivnav needs
#: and SignalK's own schema has no slot for lives under it, and nothing lives
#: outside it — see the module docstring.
MIVNAV_PROPERTY = "mivnav"

#: Bumped only if the meaning of an existing key under
#: :data:`MIVNAV_PROPERTY` changes. A reader that does not recognise it falls
#: back to the geometry, which is always sufficient.
WIRE_VERSION = 1

def to_resource(route: Route) -> dict[str, Any]:
    """``route`` as the body of a ``PUT /resources/routes/<id>``.

    The id is the path, not part of the body — SignalK addresses resources
    the same way this app's own API used to address routes.
    """
    props: dict[str, Any] = {
        "version": WIRE_VERSION,
        "waypoints": [_waypoint_entry(w) for w in route.waypoints],
        "plan_speed_kn": route.plan_speed_kn,
        "rev": route.rev,
        "updated": route.updated,
    }
    # Written only when set: absent reads back as None ("leave now").
    if route.depart_at is not None:
        props["depart_at"] = route.depart_at
    return {
        "name": route.name,
        "feature": {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                # GeoJSON axis order: [lon, lat], not this app's (lat, lon).
                "coordinates": [[w.lon, w.lat] for w in route.waypoints],
            },
            "properties": {MIVNAV_PROPERTY: props},
        },
    }


def _waypoint_entry(w: Waypoint) -> dict[str, Any]:
    entry: dict[str, Any] = {"id": w.id, "name": w.name, "stop": w.stop}
    # Written only when set: absent reads back as False, same as ``stop``.
    if w.approximate:
        entry["approximate"] = True
    return entry


def from_resource(route_id: str, resource: Any) -> Route | None:
    """A :class:`Route` from one SignalK route resource, or ``None`` if the
    resource is not a route this app can represent at all.

    Deliberately forgiving, because half of what it parses was written by
    another program: anything mivnav-specific that is missing, malformed or
    inconsistent with the geometry is replaced by a derived default rather
    than failing the whole route. The one thing that *is* fatal is having no
    usable ``LineString`` — there is no route without positions.
    """
    try:
        route_id = validate_id(route_id)
    except Exception:  # noqa: BLE001 — a foreign id we cannot address is not ours
        log.info("ignoring a SignalK route resource with an unusable id: %r", route_id)
        return None
    coords = _coordinates(resource)
    if coords is None:
        log.info("ignoring SignalK route %s: no LineString geometry", route_id)
        return None
    if len(coords) > MAX_WAYPOINTS:
        log.warning(
            "SignalK route %s has %d points; keeping the first %d",
            route_id,
            len(coords),
            MAX_WAYPOINTS,
        )
        coords = coords[:MAX_WAYPOINTS]

    props = _mivnav_properties(resource)
    names, ids, stops, approx = _waypoint_identity(props, len(coords))
    waypoints = []
    for idx, (lon, lat) in enumerate(coords):
        waypoints.append(
            Waypoint(
                id=ids[idx],
                name=names[idx],
                lat=lat,
                lon=lon,
                stop=stops[idx],
                approximate=approx[idx],
            )
        )

    return Route(
        id=route_id,
        name=_text(resource.get("name") if isinstance(resource, dict) else None),
        waypoints=waypoints,
        plan_speed_kn=_speed(props.get("plan_speed_kn")),
        # Absent (an older route, another program's) or unreadable → None.
        depart_at=parse_depart_at(props.get("depart_at")),
        rev=_non_negative_int(props.get("rev")),
        updated=_non_negative_float(props.get("updated")),
    )


# -- decoding helpers ---------------------------------------------------------


def _coordinates(resource: Any) -> list[tuple[float, float]] | None:
    if not isinstance(resource, dict):
        return None
    feature = resource.get("feature")
    geometry = feature.get("geometry") if isinstance(feature, dict) else None
    if not isinstance(geometry, dict) or geometry.get("type") != "LineString":
        return None
    raw = geometry.get("coordinates")
    if not isinstance(raw, list):
        return None
    out: list[tuple[float, float]] = []
    for pair in raw:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            return None
        lon, lat = pair[0], pair[1]
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            return None
        if not (-180 <= lon <= 180) or not (-90 <= lat <= 90):
            return None
        out.append((float(lon), float(lat)))
    return out


def _mivnav_properties(resource: Any) -> dict[str, Any]:
    feature = resource.get("feature") if isinstance(resource, dict) else None
    properties = feature.get("properties") if isinstance(feature, dict) else None
    props = properties.get(MIVNAV_PROPERTY) if isinstance(properties, dict) else None
    return props if isinstance(props, dict) else {}


def _waypoint_identity(
    props: dict[str, Any], count: int
) -> tuple[list[str], list[str], list[bool], list[bool]]:
    """``(names, ids, stops, approximate)`` for ``count`` waypoints. All come from
    ``properties.mivnav.waypoints`` when that list describes exactly this
    geometry; otherwise all-or-nothing fallback to synthesised positional
    ids, empty names and no stop/approximate flags — see
    docs/architecture/route-signalk-wire-format.md. A missing ``stop`` or
    ``approximate`` (a route written before the key existed, or by another
    program) is False.
    """
    synthetic = [f"p{i}" for i in range(count)]
    fallback = ([""] * count, synthetic, [False] * count, [False] * count)
    stored = props.get("waypoints")
    if not isinstance(stored, list) or len(stored) != count:
        return fallback
    ids: list[str] = []
    names: list[str] = []
    stops: list[bool] = []
    approx: list[bool] = []
    for entry in stored:
        entry = entry if isinstance(entry, dict) else {}
        try:
            ids.append(validate_id(str(entry.get("id", ""))))
        except Exception:  # noqa: BLE001
            return fallback
        names.append(_text(entry.get("name")))
        stops.append(entry.get("stop") is True)
        approx.append(entry.get("approximate") is True)
    if len(set(ids)) != len(ids):
        return fallback
    return names, ids, stops, approx


def _text(value: Any) -> str:
    return str(value)[:MAX_NAME_LENGTH] if isinstance(value, str) else ""


def _speed(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 0 < value <= MAX_PLAN_SPEED_KN:
            return float(value)
    return DEFAULT_PLAN_SPEED_KN


def _non_negative_int(value: Any) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return 0


def _non_negative_float(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
        return float(value)
    return 0.0


__all__ = ["MIVNAV_PROPERTY", "WIRE_VERSION", "from_resource", "to_resource"]
