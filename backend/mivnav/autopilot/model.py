# SPDX-License-Identifier: GPL-2.0-only
"""The autopilot's live state, folded from the SignalK delta stream.

Pure: no sockets, no clock, no config. Read-only — commands go through
:mod:`mivnav.features.autopilot.client`, not here. See
docs/architecture/autopilot-state-model.md for why "unknown" must never be
read as "disengaged", why there is no staleness TTL, and why ``target`` is
not a heading.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

# SignalK angles are radians; a chart plotter thinks in degrees. Same
# constant, same reason, as mivnav.signalk.model — the unit rides in every
# name at both ends, because a units bug here is a silent wrong answer.
_DEG = 180.0 / math.pi


@dataclass
class Autopilot:
    """What the pilot has told us, in plotter units.

    Every field is ``None`` until heard. See the module docstring: that is
    the difference between "off" and "we do not know", and it is load
    bearing.
    """

    #: ``steering.autopilot.state`` — the pilot's own vocabulary
    #: ("enabled"/"disabled" on pypilot; "auto"/"standby"/"wind" elsewhere).
    #: Never remapped to a vocabulary of ours: the set of legal values is
    #: whatever the device reports in its ``options`` (see the client), and
    #: a state we failed to recognise is still the truth.
    state: str | None = None
    #: ``steering.autopilot.mode`` — likewise the device's own.
    mode: str | None = None
    #: ``steering.autopilot.engaged`` — is it actually steering.
    engaged: bool | None = None
    #: ``steering.autopilot.target``, radians on the wire. See the module
    #: docstring for why this is a target and not a heading.
    target_deg: float | None = None
    #: ``steering.rudderAngle`` — where the rudder actually is, which is
    #: the one field that says the pilot is doing something rather than
    #: claiming to.
    rudder_angle_deg: float | None = None
    #: ``steering.autopilot.defaultPilot`` — which provider the server
    #: routes ``_default`` to. The commands in
    #: mivnav.features.autopilot.client address ``_default``, so this is how
    #: a UI names what it is steering.
    default_pilot: str | None = None
    #: ``steering.autopilot.availableActions`` — actions live *right now*,
    #: as opposed to the static capability list in the client's options.
    available_actions: list[str] | None = None

    #: True once any path above has arrived. The difference between "no
    #: autopilot" (wire ``None``) and "an autopilot that has said nothing
    #: we understood yet".
    seen: bool = field(default=False, repr=False)

    def wire(self) -> dict[str, Any] | None:
        """The JSON the browser consumes, or ``None`` if nothing is known.

        camelCase and omit-when-absent, matching
        :meth:`mivnav.signalk.model.Vessel.wire` exactly — a client already
        reads "key missing = the boat did not tell us" everywhere else in
        this snapshot, and the autopilot must not be the one place where
        that convention differs.
        """
        if not self.seen:
            return None
        out: dict[str, Any] = {}
        for key, value in (
            ("state", self.state),
            ("mode", self.mode),
            # Explicitly not `if value` — False is an answer, and the whole
            # point of this module is that it is a different one from
            # absence.
            ("engaged", self.engaged),
            ("targetDeg", self.target_deg),
            ("rudderAngleDeg", self.rudder_angle_deg),
            ("defaultPilot", self.default_pilot),
            ("availableActions", self.available_actions),
        ):
            if value is not None:
                out[key] = value
        return out


class AutopilotState:
    """Folds ``steering.*`` deltas for the own vessel into one picture.

    Not thread-safe by itself: it is held by
    :class:`~mivnav.signalk.model.VesselTracker`, which is held under
    :class:`~mivnav.signalk.service.SignalKService`'s lock. One owner, one
    lock, one parse of the wire.
    """

    def __init__(self) -> None:
        self._pilot = Autopilot()

    def apply(self, path: str, value: Any) -> None:
        """Fold one path/value in, recursing into unrecognised objects.

        Fed **every** path of the own vessel's deltas, not a pre-filtered
        ``steering.*`` subset — see docs/architecture/autopilot-state-model.md
        for why a prefilter would silently miss some delta shapes.
        """
        self._apply(path, value, 0)

    def _apply(self, path: str, value: Any, depth: int) -> None:
        handler = _HANDLERS.get(path)
        if handler is not None:
            handler(self._pilot, value)
            return
        # A handled path is never walked — `steering.autopilot.target` is a
        # number, not a subtree, even though the stream also carries
        # `steering.autopilot.target.headingTrue` (a different, staler source).
        if isinstance(value, dict) and depth < _MAX_DEPTH:
            for key, child in value.items():
                if isinstance(key, str):
                    self._apply(f"{path}.{key}" if path else key, child, depth + 1)

    def snapshot(self) -> dict[str, Any] | None:
        """The picture right now. Pure — never mutates, never expires."""
        return self._pilot.wire()


_Setter = Callable[[Autopilot, Any], None]


def _number(attr: str, scale: float = 1.0) -> _Setter:
    def apply(pilot: Autopilot, value: Any) -> None:
        if _is_number(value):
            setattr(pilot, attr, float(value) * scale)
            pilot.seen = True

    return apply


def _text(attr: str) -> _Setter:
    def apply(pilot: Autopilot, value: Any) -> None:
        if isinstance(value, str) and value.strip():
            setattr(pilot, attr, value.strip())
            pilot.seen = True

    return apply


def _boolean(attr: str) -> _Setter:
    def apply(pilot: Autopilot, value: Any) -> None:
        # Strictly a bool. `engaged: 1` is not a boat's answer to "are you
        # steering", and coercing it would be guessing on the one field
        # that most directly means "the wheel is not yours".
        if isinstance(value, bool):
            setattr(pilot, attr, value)
            pilot.seen = True

    return apply


def _strings(attr: str) -> _Setter:
    def apply(pilot: Autopilot, value: Any) -> None:
        if isinstance(value, list) and all(isinstance(item, str) for item in value):
            setattr(pilot, attr, list(value))
            pilot.seen = True

    return apply


#: One entry per SignalK path we understand. `steering.autopilot.target.
#: headingTrue` is deliberately absent — a different, disagreeing source;
#: see docs/architecture/autopilot-state-model.md.
_HANDLERS: dict[str, _Setter] = {
    "steering.autopilot.state": _text("state"),
    "steering.autopilot.mode": _text("mode"),
    "steering.autopilot.engaged": _boolean("engaged"),
    "steering.autopilot.target": _number("target_deg", _DEG),
    "steering.autopilot.defaultPilot": _text("default_pilot"),
    "steering.autopilot.availableActions": _strings("available_actions"),
    "steering.rudderAngle": _number("rudder_angle_deg", _DEG),
}

#: Bounds the walk in _apply against a pathological delta; the deepest real
#: path here is three. Same value and same reason as mivnav.signalk.model.
_MAX_DEPTH = 6


def _is_number(value: Any) -> bool:
    # bool is an int in Python, and `"target": true` is not a target.
    return isinstance(value, (int, float)) and not isinstance(value, bool)
