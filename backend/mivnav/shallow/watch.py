# SPDX-License-Identifier: GPL-2.0-only
"""Is the boat in shallow water — once per snapshot, debounced.

The ``shallow`` key every snapshot carries, read by the browser's depth tile
and by :class:`.publisher.ShallowPublisher`. One assessment, so a screen and
the MFD cannot disagree.

WHICH DEPTH. The threshold is a depth below the surface, so the reading is
too, best first: ``belowSurface`` (the sounder plus the boat's transducer
offset, as SignalK has it); else ``belowTransducer`` — the raw echo, which
UNDERSTATES the depth by the transducer's own depth, so it alarms early,
never late; else ``belowKeel`` plus the draft. A stale reading (no update for
:data:`~mivnav.signalk.model.STALE_AFTER`) is no reading: the assessment
drops and the alarm clears, like the collision watch with a dead GPS — a
stale number must never hold an alarm up, nor stand in for a live one.

WHY IT DOES NOT FLAP. A sounder in weed, wake or a steep bottom throws
single wild readings and loses the bottom altogether. The raw depth goes
through a time-weighted median over :data:`WINDOW_S` (one spike is never
the median), the filtered depth must stay under the threshold for
:data:`RAISE_S` to raise, and over threshold + ``hysteresis_m`` for
:data:`CLEAR_S` to clear.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from statistics import median
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mivnav.shallow.config import ShallowConfig

#: The median filter's window.
WINDOW_S = 5.0
#: The filtered depth must stay shallow this long before the alarm raises.
RAISE_S = 2.0
#: ... and deep (past the hysteresis) this long before it clears.
CLEAR_S = 10.0

#: Wire field → the ``source`` the tile labels it with, in order of preference.
_SOURCES = (
    ("depthBelowSurfaceM", "surface"),
    ("depthBelowTransducerM", "transducer"),
    ("depthBelowKeelM", "keel"),
)


def threshold(cfg: ShallowConfig) -> float:
    """Metres below the surface — the setting, as is."""
    return cfg.depth_m


def reading(own: dict[str, Any]) -> tuple[float, str] | None:
    """The live depth below the surface and which sounder path gave it, or
    ``None`` with nothing fresh. See the module docstring for the order."""
    stale = own.get("stale") or {}
    draft = own.get("draftM")
    for key, source in _SOURCES:
        value = own.get(key)
        if not isinstance(value, (int, float)) or key in stale:
            continue
        if source == "keel":
            if not isinstance(draft, (int, float)) or draft <= 0:
                continue
            value = value + draft
        return float(value), source
    return None


@dataclass
class _Edge:
    """When the filtered depth started being on one side of a line."""

    since: float | None = None

    def hold(self, now: float, on: bool) -> float:
        """How long it has been ``on`` (0 when it isn't)."""
        if not on:
            self.since = None
            return 0.0
        if self.since is None:
            self.since = now
        return now - self.since


class ShallowWatch:
    """Stateful (the filter and the dwell timers), so ONE instance per
    SignalK service, called under its lock. ``now`` is a monotonic clock."""

    def __init__(self) -> None:
        self._samples: deque[tuple[float, float]] = deque()
        self._shallow = _Edge()
        self._deep = _Edge()
        self.active = False

    def reset(self) -> None:
        self._samples.clear()
        self._shallow = _Edge()
        self._deep = _Edge()
        self.active = False

    def _filtered(self, depth: float, now: float) -> float:
        self._samples.append((now, depth))
        while self._samples and now - self._samples[0][0] > WINDOW_S:
            self._samples.popleft()
        return median(d for _, d in self._samples)

    def __call__(self, snapshot: dict[str, Any], cfg: ShallowConfig, now: float) -> dict[str, Any] | None:
        """``{"depthM", "source", "thresholdM", "active"}``,
        or ``None`` with no own ship or no live sounder."""
        own = snapshot.get("self")
        found = reading(own) if own else None
        if found is None:
            self.reset()
            return None
        depth, source = found
        limit = threshold(cfg)
        filtered = self._filtered(depth, now)
        if self.active:
            if self._deep.hold(now, filtered >= limit + cfg.hysteresis_m) >= CLEAR_S:
                self.active = False
                self._shallow = _Edge()
        elif self._shallow.hold(now, filtered < limit) >= RAISE_S:
            self.active = True
            self._deep = _Edge()
        return {
            "depthM": round(filtered, 2),
            "source": source,
            "thresholdM": round(limit, 2),
            "active": self.active,
        }
