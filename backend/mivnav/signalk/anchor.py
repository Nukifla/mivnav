# SPDX-License-Identifier: GPL-2.0-only
"""The anchor watch as SignalK's anchoralarm plugin reports it. Own-ship,
read-only: the plugin is the watcher (anchor.md Q1); mivnav only shows it.

Source-filtered on purpose. ``signalk-nmea2000-emitter-cannon`` writes its
own copy of the anchor alarm back onto ``notifications.navigation.anchor`` —
measured on the boat as a stale ``emergency`` beside the plugin's live
``normal``. Latest-delta-wins would show that echo as the current state, so
only updates whose ``$source`` is the plugin are folded in.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any

#: The plugin's id, which is also the ``$source`` it publishes under
#: (``app.handleMessage(plugin.id, …)``).
PLUGIN_SOURCE = "anchoralarm"

_DEG = 180.0 / math.pi

#: The GPS antenna's distance from the bow, metres — SignalK's own path for
#: it (vessel base data), the one the plugin itself reads. Own-ship, any
#: source: it is boat configuration, not the plugin's output.
FROM_BOW_PATH = "sensors.gps.fromBow"

#: The swing track: one own-ship fix per this many seconds while anchored,
#: for this long. Kept HERE, on the always-on server — the plugin's own
#: track is behind an admin-only route (signalk-server makes every plugin
#: route admin unless the plugin opts it down, and anchoralarm 2.0.1 does
#: not), and the History API's track collapses a stay at anchor to a point
#: by design (track.geometry.collapse_stays).
TRACK_EVERY_S = 10.0
TRACK_MAX = int(24 * 3600 / TRACK_EVERY_S)


def is_plugin_source(update: dict[str, Any]) -> bool:
    """Did this update come from the anchoralarm plugin? ``$source`` is the
    v1 stream's form; ``source.label`` is accepted too, for a server that
    sends the object form instead."""
    src = update.get("$source")
    if not isinstance(src, str):
        source = update.get("source")
        src = source.get("label") if isinstance(source, dict) else None
    return isinstance(src, str) and src.split(".", 1)[0] == PLUGIN_SOURCE


@dataclass
class Anchor:
    lat: float | None = None
    lng: float | None = None
    max_radius_m: float | None = None
    current_radius_m: float | None = None
    bearing_true_deg: float | None = None
    rode_length_m: float | None = None
    fudge_m: float | None = None
    #: `sensors.gps.fromBow` — not the plugin's, but what a drop needs to
    #: put the anchor at the bow rather than at the antenna.
    gps_from_bow_m: float | None = None
    #: The plugin's ``notifications.navigation.anchor`` value, reduced.
    alarm: dict[str, Any] | None = None
    #: True once the plugin has said anything — ``anchor`` is omitted from
    #: the snapshot until then, so the browser can tell "no plugin" (absent)
    #: from "anchor up" (present, no position).
    seen: bool = field(default=False, repr=False)

    def wire(self) -> dict[str, Any] | None:
        if not self.seen:
            return None
        out: dict[str, Any] = {}
        for key, value in (
            ("lat", self.lat),
            ("lng", self.lng),
            ("maxRadiusM", self.max_radius_m),
            ("currentRadiusM", self.current_radius_m),
            ("bearingTrueDeg", self.bearing_true_deg),
            ("rodeLengthM", self.rode_length_m),
            ("fudgeM", self.fudge_m),
            ("gpsFromBowM", self.gps_from_bow_m),
            ("alarm", self.alarm),
        ):
            if value is not None:
                out[key] = value
        return out


def _number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


def _set_position(anchor: Anchor, value: Any) -> None:
    # `null` is the plugin's "raised" — position and everything measured
    # against it go together, so a stale radius can't outlive its anchor.
    if not isinstance(value, dict):
        anchor.lat = anchor.lng = None
        anchor.current_radius_m = anchor.bearing_true_deg = None
        return
    lat, lng = _number(value.get("latitude")), _number(value.get("longitude"))
    if lat is not None and lng is not None:
        anchor.lat, anchor.lng = lat, lng


def _set_alarm(anchor: Anchor, value: Any) -> None:
    """Keep what the browser acts on: the state, the plugin's message, the
    notifications-API ``id`` (for a server-side ACK), whether it should make
    noise now (``method`` — the server drops ``sound`` once acknowledged),
    and whether it can still be acknowledged."""
    if not isinstance(value, dict) or not isinstance(value.get("state"), str):
        anchor.alarm = None
        return
    alarm: dict[str, Any] = {"state": value["state"]}
    if isinstance(value.get("message"), str):
        alarm["message"] = value["message"]
    if isinstance(value.get("id"), str):
        alarm["id"] = value["id"]
    method = value.get("method")
    # A missing method breaks the spec; read it as "visual + sound" so a
    # non-conforming server still alarms. `[]` is real: "acknowledged, quiet".
    alarm["sound"] = "sound" in method if isinstance(method, list) else True
    status = value.get("status")
    if isinstance(status, dict):
        alarm["acknowledged"] = status.get("acknowledged") is True
        alarm["canAcknowledge"] = status.get("canAcknowledge") is True
    anchor.alarm = alarm


def _setter(attr: str, scale: float = 1.0):
    def apply(anchor: Anchor, value: Any) -> None:
        n = _number(value)
        setattr(anchor, attr, None if n is None else n * scale)

    return apply


_HANDLERS = {
    "navigation.anchor.position": _set_position,
    "navigation.anchor.maxRadius": _setter("max_radius_m"),
    "navigation.anchor.currentRadius": _setter("current_radius_m"),
    "navigation.anchor.bearingTrue": _setter("bearing_true_deg", _DEG),
    "navigation.anchor.rodeLength": _setter("rode_length_m"),
    "navigation.anchor.fudgeFactor": _setter("fudge_m"),
    "notifications.navigation.anchor": _set_alarm,
}

_MAX_DEPTH = 4


class AnchorState:
    """Folds the plugin's own-ship deltas into one :class:`Anchor`. Same
    threading contract as :class:`~mivnav.signalk.model.CourseState`; the
    caller has already checked :func:`is_plugin_source`."""

    def __init__(self) -> None:
        self._anchor = Anchor()
        #: `(lng, lat, time_ms)`, oldest first — see :data:`TRACK_EVERY_S`.
        self._track: deque[tuple[float, float, float]] = deque(maxlen=TRACK_MAX)
        #: The anchor the track belongs to; a drop, move or raise starts afresh.
        self._track_for: tuple[float, float] | None = None

    def apply(self, path: str, value: Any) -> None:
        self._apply(path, value, 0)

    def set_from_bow(self, value: Any) -> None:
        """``sensors.gps.fromBow``, from whichever source reports it. Does not
        mark the plugin as heard — only the plugin's own updates do."""
        self._anchor.gps_from_bow_m = _number(value)

    def record(self, lng: float, lat: float, now: float) -> None:
        """Offer one own-ship fix to the swing track. Kept only while the
        anchor is down, at most one per :data:`TRACK_EVERY_S`."""
        a = self._anchor
        at = (a.lat, a.lng) if a.lat is not None and a.lng is not None else None
        if at != self._track_for:
            self._track.clear()
            self._track_for = at
        if at is None:
            return
        t_ms = now * 1000.0
        if self._track and t_ms - self._track[-1][2] < TRACK_EVERY_S * 1000.0:
            return
        self._track.append((lng, lat, t_ms))

    def track(self) -> list[list[float]]:
        """The swing track since the drop, ``[[lng, lat, time_ms], …]``, oldest
        first. Empty while the anchor is up."""
        a = self._anchor
        if a.lat is None or (a.lat, a.lng) != self._track_for:
            return []
        return [list(fix) for fix in self._track]

    def _apply(self, path: str, value: Any, depth: int) -> None:
        handler = _HANDLERS.get(path)
        if handler is not None:
            handler(self._anchor, value)
            self._anchor.seen = True
            return
        # `navigation.anchor` delivered whole, as an object. Not the
        # notification: its value IS an object and is matched above.
        if isinstance(value, dict) and depth < _MAX_DEPTH:
            for key, child in value.items():
                if isinstance(key, str):
                    self._apply(f"{path}.{key}" if path else key, child, depth + 1)

    def snapshot(self) -> dict[str, Any] | None:
        return self._anchor.wire()
