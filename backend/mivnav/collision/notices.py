# SPDX-License-Identifier: GPL-2.0-only
"""The SignalK shape of a collision alarm — both directions: the delta value
:class:`.publisher.CollisionPublisher` writes, and the fold of SignalK's echo
of it that :class:`~mivnav.signalk.model.VesselTracker` keeps.

Path is ``notifications.navigation.closestApproach.<vessel urn>``, the one
signalk-derived-data's ``cpa_tcpa`` uses, so KIP/Freeboard/the N2K emitter
already know it. Our own values are told apart by ``data.publisher`` — not
by ``$source``, whose label (``ws.<device id>``) is the SignalK server's
choice, and not by path, which derived-data may share.
"""

from __future__ import annotations

from typing import Any

PREFIX = "notifications.navigation.closestApproach"
PUBLISHER = "mivnav"

#: Risk → (SignalK ALARM_STATE, ALARM_METHOD). Red sounds; yellow is visual
#: only, exactly as the browser alarm treated them (alarm vs notice).
STATES: dict[str, tuple[str, list[str]]] = {
    "red": ("alarm", ["visual", "sound"]),
    "yellow": ("warn", ["visual"]),
}
NORMAL = "normal"


def path_for(target_id: str) -> str:
    return f"{PREFIX}.{target_id}"


def target_of(path: str) -> str | None:
    """``…closestApproach.urn:mrn:imo:mmsi:123`` → ``urn:mrn:imo:mmsi:123``."""
    head = PREFIX + "."
    return path[len(head) :] if path.startswith(head) and len(path) > len(head) else None


def _fmt_tcpa(tcpa_min: float) -> str:
    seconds = max(0, round(tcpa_min * 60))
    return f"{seconds // 60}:{seconds % 60:02d}"


def value_for(alarm: dict[str, Any] | None, *, quiet: bool = False) -> dict[str, Any]:
    """The notification value for one entry of ``collision.alarms`` — or the
    clear (``normal``, no method) for ``None``. ``data`` carries the numbers
    for any consumer that wants more than the sentence. ``quiet`` (the
    boat's ``show`` mode) drops ``sound``: same state, nothing sounds."""
    if alarm is None:
        return {"state": NORMAL, "method": [], "message": "", "data": {"publisher": PUBLISHER}}
    state, method = STATES[alarm["risk"]]
    if quiet:
        method = [m for m in method if m != "sound"]
    who = alarm.get("name") or (f"MMSI {alarm['mmsi']}" if alarm.get("mmsi") else "unnamed target")
    message = f"Collision risk: {who} — CPA {alarm['cpaNm']:.2f} nm in {_fmt_tcpa(alarm['tcpaMin'])}"
    data: dict[str, Any] = {
        "publisher": PUBLISHER,
        "cpaNm": round(alarm["cpaNm"], 3),
        "tcpaMin": round(alarm["tcpaMin"], 2),
    }
    if alarm.get("mmsi"):
        data["mmsi"] = alarm["mmsi"]
    return {"state": state, "method": method, "message": message, "data": data}


#: One step down from each state we raise — what a mute re-arm sends for one
#: tick so the next, normal publish is an *escalation*: the only thing that
#: makes signalk-server clear ``silenced`` (``Alarm.syncFromNotificationUpdate``).
STEP_DOWN = {"alarm": "warn", "warn": "alert"}


def stepped_down(alarm: dict[str, Any]) -> dict[str, Any]:
    """:func:`value_for` one state lower, visual only (it is up ~1 s)."""
    value = value_for(alarm, quiet=True)
    return {**value, "state": STEP_DOWN[value["state"]], "method": ["visual"]}


def _ours(value: dict[str, Any]) -> bool:
    data = value.get("data")
    return isinstance(data, dict) and data.get("publisher") == PUBLISHER


def reduce_echo(value: Any) -> dict[str, Any] | None:
    """Our notification as SignalK echoes it back (with the Notifications-API
    ``id`` and ``status`` the server added), reduced like the anchor alarm —
    or ``None`` if it isn't ours or isn't active. Same fields, same meaning
    as :func:`mivnav.signalk.anchor._set_alarm`."""
    if not isinstance(value, dict) or not _ours(value):
        return None
    state = value.get("state")
    if not isinstance(state, str) or state == NORMAL:
        return None
    out: dict[str, Any] = {"state": state}
    if isinstance(value.get("id"), str):
        out["id"] = value["id"]
    method = value.get("method")
    out["sound"] = "sound" in method if isinstance(method, list) else True
    status = value.get("status")
    if isinstance(status, dict):
        out["acknowledged"] = status.get("acknowledged") is True
        out["canAcknowledge"] = status.get("canAcknowledge") is True
        # Silence (anyone's: a screen's MUTE, KIP, the MFD) — what the
        # publisher's mute timer re-arms (publisher.MUTE_S).
        out["silenced"] = status.get("silenced") is True
        out["canSilence"] = status.get("canSilence") is True
    return out


class NoticeState:
    """Our own closestApproach notifications as SignalK currently holds them,
    by target id — how the publisher clears one it no longer wants (a ghost
    left by a mivnav restart) and how a screen could ACK it on the server.
    Same threading contract as :class:`~mivnav.signalk.model.CourseState`."""

    def __init__(self) -> None:
        self._notices: dict[str, dict[str, Any]] = {}

    def apply(self, path: str, value: Any) -> None:
        target = target_of(path)
        if target is None:
            # The whole branch delivered as one object (`…closestApproach`
            # → {urn: notification}) — walk one level.
            if path == PREFIX and isinstance(value, dict):
                for key, child in value.items():
                    if isinstance(key, str):
                        self.apply(path_for(key), child)
            return
        if isinstance(value, dict) and not _ours(value):
            # Someone else's (derived-data's) notification on the same path
            # tells us nothing about ours — keep what we had.
            return
        reduced = reduce_echo(value)
        if reduced is None:
            self._notices.pop(target, None)
        else:
            self._notices[target] = reduced

    def snapshot(self) -> dict[str, dict[str, Any]] | None:
        return {k: dict(v) for k, v in sorted(self._notices.items())} or None
