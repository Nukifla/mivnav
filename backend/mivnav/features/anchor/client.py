# SPDX-License-Identifier: GPL-2.0-only
"""Commanding SignalK's anchoralarm plugin. The plugin is the anchor watcher
(anchor.md Q1); this is only the write half — the read half rides the delta
stream (:mod:`mivnav.signalk.anchor`).

Everything goes through the SignalK anchor PATHS — the plugin's PUT handlers
on ``navigation.anchor.position`` / ``maxRadius``, which take a read/write
device token. NOT the plugin's own REST (``dropAnchor``, ``setRadius``,
``getTrack``): signalk-server makes every plugin route admin-only unless the
plugin opts it down (``router.access(...)``), anchoralarm 2.0.1 does not,
and mivnav's device token is (rightly) not an admin. Measured on the boat:
``getTrack`` with our token is refused. So the two things that REST did for
us are done here instead, with the plugin's own arithmetic
(``computeBowLocation``, ``setRadius``): :func:`bow_point` and
:func:`radius_from_here`. Sibling of :mod:`mivnav.features.route.client`,
same one-attempt posture.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import httpx

log = logging.getLogger(__name__)

#: Same tight one-attempt budget as the autopilot and course clients: a
#: human is holding the button.
REQUEST_TIMEOUT = 4.0

#: Swing room "radius from here" adds on top of the measured distance (and
#: the plugin's fudge factor, 0 on the boat): set right after backing down,
#: the distance alone would alarm on the first gust.
FROM_HERE_MARGIN_M = 10.0

_EARTH_R = 6_371_000.0


class AnchorError(Exception):
    """Base: the command did not take effect."""


class AnchorUnavailable(AnchorError):
    """No SignalK server is configured, nothing on it serves the anchor
    paths, or it refused our credentials — a config fault, not something a
    retry fixes."""


class AnchorUnreachable(AnchorError):
    """The SignalK server did not answer."""


class AnchorRefused(AnchorError):
    """SignalK or the plugin answered, and said no — with its own words."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine, metres — what the plugin's ``calcDistance`` (geolib) does."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_R * math.asin(math.sqrt(h))


def bow_point(
    lat: float, lng: float, heading_deg: float | None, from_bow_m: float | None
) -> tuple[float, float]:
    """Where the bow is: the antenna moved ``from_bow_m`` along the heading —
    the plugin's ``computeBowLocation``. Without both, the antenna itself
    (exactly the plugin's own fallback)."""
    if heading_deg is None or not from_bow_m:
        return lat, lng
    d = from_bow_m / _EARTH_R
    b = math.radians(heading_deg)
    p1, l1 = math.radians(lat), math.radians(lng)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(
        math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2)
    )
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


def radius_from_here(
    boat: tuple[float, float], anchor: tuple[float, float], fudge_m: float | None
) -> float:
    """The plugin's ``setRadius()`` with no radius: antenna→anchor now, plus
    its fudge factor ("drop, back down, then set"), plus our own
    :data:`FROM_HERE_MARGIN_M`. ``(lat, lng)`` pairs."""
    radius = distance_m(boat[0], boat[1], anchor[0], anchor[1]) + FROM_HERE_MARGIN_M
    if fudge_m and fudge_m > 0:
        radius += fudge_m
    return radius


class AnchorClient:
    """Pure of config: two base URLs and a token. ``None`` URLs mean
    SignalK is disabled (every call raises :class:`AnchorUnavailable`)."""

    def __init__(
        self,
        self_url: str | None,
        notifications_url: str | None,
        token: str | None,
        *,
        timeout: float = REQUEST_TIMEOUT,
    ) -> None:
        self._self_url = self_url.rstrip("/") if self_url else None
        self._notifications_url = notifications_url.rstrip("/") if notifications_url else None
        self._token = token or None
        self._timeout = timeout

    def set_radius(self, radius_m: float) -> None:
        self._put("navigation/anchor/maxRadius", radius_m)

    def place(
        self, lat: float, lng: float, radius_m: float | None, depth_m: float | None = None
    ) -> None:
        """Put the anchor down (or move it) at ``lat``/``lng``, watching at
        ``radius_m``. Radius FIRST: a position PUT starts watching with
        whatever radius the plugin last persisted (``putPosition``) —
        measured on the boat as a 49.79 m leftover from an earlier session.
        ``None`` marks the anchor WITHOUT watching (Freeboard's "let out
        rode"): the plugin's ``putRadius`` takes ``null``, and
        ``putPosition`` only starts watching ``if (state.radius)``; a later
        :meth:`set_radius` arms it.
        ``depth_m`` rides as a negative ``altitude``, as the plugin's own
        drop records it."""
        self._put("navigation/anchor/maxRadius", radius_m)
        position: dict[str, float] = {"latitude": lat, "longitude": lng}
        if depth_m is not None:
            position["altitude"] = -abs(depth_m)
        self._put("navigation/anchor/position", position)

    def raise_anchor(self) -> None:
        """``position: null`` is the plugin's raise: it stops watching and
        clears the alarm."""
        self._put("navigation/anchor/position", None)

    def acknowledge(self, notification_id: str) -> None:
        """Acknowledge on the SERVER, for every display at once (anchor.md
        Q5): SignalK drops ``sound`` from the alarm's method, so each client
        that follows it goes quiet; a later state change re-arms it."""
        if not self._notifications_url:
            raise AnchorUnavailable(_DISABLED)
        self._send("POST", f"{self._notifications_url}/{notification_id}/acknowledge", {})

    # -- internals --------------------------------------------------------

    def _put(self, path: str, value: Any) -> None:
        if not self._self_url:
            raise AnchorUnavailable(_DISABLED)
        self._send("PUT", f"{self._self_url}/{path}", {"value": value})

    def _send(self, method: str, url: str, body: dict[str, Any]) -> None:
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            with httpx.Client(timeout=self._timeout) as http:
                response = http.request(method, url, json=body, headers=headers)
        except httpx.HTTPError as e:
            raise AnchorUnreachable(f"the SignalK server at {url} did not answer: {e}") from e

        # The body's verdict first: a SignalK PUT answers a handler's
        # refusal with `state: FAILED`, sometimes under a 200 or a 403.
        # Passed on as 409 so no client reads it as "your token is wrong".
        payload = _json(response)
        message = payload.get("message") if payload else None
        if payload and payload.get("state") == "FAILED":
            code = payload.get("statusCode")
            raise AnchorRefused(
                502 if isinstance(code, int) and code >= 500 else 409,
                str(message or "the anchor alarm refused the request"),
            )
        if response.status_code in (401, 403):
            raise AnchorUnavailable(
                "SignalK refused mivnav's write access — request it under "
                "Settings → SignalK (the same token the autopilot uses)"
            )
        if response.status_code in (404, 405) and "/navigation/anchor/" in url:
            # No PUT handler on the path: nothing on the box serves it.
            raise AnchorUnavailable(
                "nothing on the SignalK server accepts anchor commands — install "
                "and enable the anchoralarm plugin"
            )
        if response.status_code >= 400:
            raise AnchorRefused(
                response.status_code,
                str(message or response.text.strip()[:200] or f"HTTP {response.status_code}"),
            )


_DISABLED = "SignalK is disabled in this server's configuration, so there is no anchor alarm"


def _json(response: httpx.Response) -> dict[str, Any] | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None
