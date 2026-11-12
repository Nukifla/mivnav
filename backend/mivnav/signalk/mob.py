# SPDX-License-Identifier: GPL-2.0-only
"""``notifications.mob`` as SignalK holds it — the read half of the MOB
alarm (:mod:`mivnav.features.mob`), embedded in the tracker like the
anchor's. Kept whoever raised it: ours carries ``data.publisher ==
"mivnav"`` (what the publisher re-raises and clears), anyone else's (an
MFD's or Freeboard's MOB button) is shown, never cleared by us.
"""

from __future__ import annotations

from typing import Any

PATH = "notifications.mob"
PUBLISHER = "mivnav"


def reduce(value: Any) -> dict[str, Any] | None:
    """The active notification, reduced like the anchor/collision ones — or
    ``None`` while it is absent or ``normal``."""
    if not isinstance(value, dict):
        return None
    state = value.get("state")
    if not isinstance(state, str) or state == "normal":
        return None
    data = value.get("data")
    out: dict[str, Any] = {
        "state": state,
        "ours": isinstance(data, dict) and data.get("publisher") == PUBLISHER,
    }
    if isinstance(value.get("id"), str):
        out["id"] = value["id"]
    if isinstance(value.get("message"), str) and value["message"]:
        out["message"] = value["message"]
    method = value.get("method")
    out["sound"] = "sound" in method if isinstance(method, list) else True
    position = value.get("position")
    if isinstance(position, dict):
        lat, lng = position.get("latitude"), position.get("longitude")
        if _num(lat) and _num(lng):
            out["lat"], out["lng"] = float(lat), float(lng)
    if isinstance(data, dict) and isinstance(data.get("mobId"), str):
        out["mobId"] = data["mobId"]
    status = value.get("status")
    if isinstance(status, dict):
        out["acknowledged"] = status.get("acknowledged") is True
        out["canAcknowledge"] = status.get("canAcknowledge") is True
        out["silenced"] = status.get("silenced") is True
    return out


def _num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


class MobNoticeState:
    """Same threading contract as :class:`~mivnav.signalk.model.CourseState`."""

    def __init__(self) -> None:
        self._notice: dict[str, Any] | None = None

    def apply(self, path: str, value: Any) -> None:
        if path == PATH:
            self._notice = reduce(value)
        elif path == "notifications" and isinstance(value, dict) and "mob" in value:
            # The whole branch as one object, where a dialect sends it so.
            self._notice = reduce(value["mob"])

    def snapshot(self) -> dict[str, Any] | None:
        return dict(self._notice) if self._notice is not None else None
