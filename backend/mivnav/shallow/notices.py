# SPDX-License-Identifier: GPL-2.0-only
"""The SignalK shape of the shallow-water alarm — the delta value
:class:`.publisher.ShallowPublisher` writes, and the fold of SignalK's echo
of it. Same conventions as :mod:`mivnav.collision.notices` (ours are told
apart by ``data.publisher``; the echo is reduced by the same function).

Path is ``notifications.environment.depth.shallowWater``: under the depth
branch every notification consumer files depth alarms under, but NOT on
``…depth.belowKeel``/``belowTransducer``/``belowSurface``, which
signalk-server's own zones write — two publishers on one path would
overwrite each other's state.
"""

from __future__ import annotations

from typing import Any

from mivnav.collision.notices import NORMAL, PUBLISHER, STEP_DOWN, reduce_echo

PATH = "notifications.environment.depth.shallowWater"
#: The alarm sounds; ``show`` drops the sound (same as a red collision).
STATE = "alarm"
METHOD = ["visual", "sound"]

_SOURCE_WORDS = {"surface": "below surface", "transducer": "below transducer", "keel": "below surface (keel + draft)"}


def value_for(shallow: dict[str, Any] | None, *, quiet: bool = False) -> dict[str, Any]:
    """The notification for a ``shallow`` assessment, or the clear for ``None``."""
    if shallow is None:
        return {"state": NORMAL, "method": [], "message": "", "data": {"publisher": PUBLISHER}}
    method = [m for m in METHOD if not (quiet and m == "sound")]
    where = _SOURCE_WORDS.get(shallow.get("source", ""), "")
    message = (
        f"Shallow water: {shallow['depthM']:.1f} m {where} — alarm under {shallow['thresholdM']:.1f} m"
    ).replace("  ", " ")
    data = {
        "publisher": PUBLISHER,
        "depthM": shallow["depthM"],
        "thresholdM": shallow["thresholdM"],
        "source": shallow.get("source"),
    }
    return {"state": STATE, "method": method, "message": message, "data": data}


def stepped_down(shallow: dict[str, Any]) -> dict[str, Any]:
    """:func:`value_for` one state lower, visual only — the mute re-arm, see
    :func:`mivnav.collision.notices.stepped_down`."""
    value = value_for(shallow, quiet=True)
    return {**value, "state": STEP_DOWN[STATE], "method": ["visual"]}


class ShallowNoticeState:
    """Our shallow notification as SignalK currently holds it — what an ACK
    names and what clears a ghost. Same threading contract as
    :class:`~mivnav.collision.notices.NoticeState`."""

    def __init__(self) -> None:
        self._notice: dict[str, Any] | None = None

    def apply(self, path: str, value: Any) -> None:
        if path != PATH:
            return
        if isinstance(value, dict):
            data = value.get("data")
            if not (isinstance(data, dict) and data.get("publisher") == PUBLISHER):
                return  # someone else's on our path tells us nothing about ours
        self._notice = reduce_echo(value)

    def snapshot(self) -> dict[str, Any] | None:
        return dict(self._notice) if self._notice is not None else None
