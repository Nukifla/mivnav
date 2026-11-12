# SPDX-License-Identifier: GPL-2.0-only
"""The SignalK REST writes the MOB needs: its waypoint resource and the
course destination (v2 Resources and Course APIs). Its own small client
rather than the route feature's — features don't reach into each other —
with the same one-attempt posture and the same "the body's verdict
outranks the status" reading. Kept to MOB on purpose: not a marks client.
"""

from __future__ import annotations

from typing import Any

import httpx

from mivnav.features.mob.store import Mob

#: A human is holding the button, as for every other SignalK command.
REQUEST_TIMEOUT = 4.0


class MobSignalKError(Exception):
    """The write did not reach SignalK, or SignalK refused it."""


def waypoint_for(mob: Mob) -> dict[str, Any]:
    """The v2 Resources ``waypoints`` body: a GeoJSON point feature."""
    when = mob.at.replace("+00:00", "Z")
    return {
        "name": f"MOB {when[11:16]}Z",
        "description": f"Man overboard, {when}",
        "type": "MOB",
        "feature": {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [mob.lng, mob.lat]},
            "properties": {"mivnav": "mob"},
        },
    }


class MobClient:
    """Pure of config: URLs and token in (``None`` URL = SignalK disabled)."""

    def __init__(
        self,
        course_url: str | None,
        resources_url: str | None,
        token: str | None,
        *,
        timeout: float = REQUEST_TIMEOUT,
    ) -> None:
        self._course_url = course_url.rstrip("/") if course_url else None
        self._resources_url = resources_url.rstrip("/") if resources_url else None
        self._token = token or None
        self._timeout = timeout

    def put_waypoint(self, mob: Mob) -> None:
        self._send("PUT", self._resources(f"/waypoints/{mob.id}"), waypoint_for(mob))

    def delete_waypoint(self, mob_id: str) -> None:
        """Gone already counts as done."""
        self._send("DELETE", self._resources(f"/waypoints/{mob_id}"), None, missing_ok=True)

    def set_destination(self, lat: float, lng: float) -> None:
        """Steer to a bare position — the v2 Course API's ``destination``,
        which replaces any active route on SignalK."""
        self._send(
            "PUT", self._course("/destination"), {"position": {"latitude": lat, "longitude": lng}}
        )

    def clear_course(self) -> None:
        """``DELETE`` on the course root: the whole course state goes."""
        self._send("DELETE", self._course(""), None)

    def _course(self, path: str) -> str:
        if not self._course_url:
            raise MobSignalKError("SignalK is disabled in this server's configuration")
        return f"{self._course_url}{path}"

    def _resources(self, path: str) -> str:
        if not self._resources_url:
            raise MobSignalKError("SignalK is disabled in this server's configuration")
        return f"{self._resources_url}{path}"

    def _send(self, method: str, url: str, body: dict[str, Any] | None, *, missing_ok: bool = False) -> None:
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            with httpx.Client(timeout=self._timeout) as http:
                response = http.request(method, url, json=body, headers=headers)
        except httpx.HTTPError as e:
            raise MobSignalKError(f"the SignalK server at {url} did not answer {method}: {e}") from e
        if missing_ok and response.status_code == 404:
            return
        try:
            payload = response.json()
        except ValueError:
            payload = None
        message = payload.get("message") if isinstance(payload, dict) else None
        if isinstance(payload, dict) and payload.get("state") == "FAILED":
            raise MobSignalKError(f"SignalK refused {method} {url}: {message or 'no message given'}")
        if response.status_code >= 400:
            raise MobSignalKError(
                f"SignalK refused {method} {url} (HTTP {response.status_code}): "
                f"{message or response.text.strip()[:200] or 'no message given'}"
            )
