# SPDX-License-Identifier: GPL-2.0-only
"""Commands to the autopilot, over SignalK's v2 Autopilot API.

Deliberately not ported from pypilot (incompatible GPL-3.0-or-later); every
detail here comes from the boat's own SignalK OpenAPI document instead. See
docs/architecture/autopilot-signalk-v2.md.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

#: The server routes this to whichever provider is default
#: (`steering.autopilot.defaultPilot`); no pilot picker offered.
DEFAULT_PILOT = "_default"

#: Deliberately tight, no retry — see docs/architecture/autopilot-signalk-v2.md.
COMMAND_TIMEOUT = 4.0

#: The valid target range the API documents (-180..360 degrees).
TARGET_MIN_DEG = -180.0
TARGET_MAX_DEG = 360.0

_DEG_TO_RAD = 3.141592653589793 / 180.0


class AutopilotError(Exception):
    """Base: a command did not reach the pilot, or the pilot refused it."""


class AutopilotUnavailable(AutopilotError):
    """No pilot is addressable (SignalK disabled, or no token) — a
    misconfiguration, not something a retry fixes."""


class AutopilotUnauthorized(AutopilotError):
    """The SignalK server rejected our token (401/403)."""


class AutopilotUnreachable(AutopilotError):
    """The SignalK server did not answer in time, or at all."""


class AutopilotRefused(AutopilotError):
    """The pilot itself said no. Carries *its* status code and message."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class AutopilotClient:
    """The v2 Autopilot API, as far as this app commands it.

    Not cached as a `Derived` (see `mivnav.config.model`) — credentials are
    excluded from config slices, so caching by token would tear down state
    on every token edit.
    """

    def __init__(
        self,
        base_url: str | None,
        token: str | None,
        *,
        pilot: str = DEFAULT_PILOT,
        timeout: float = COMMAND_TIMEOUT,
    ) -> None:
        self._base_url = base_url.rstrip("/") if base_url else None
        self._token = token or None
        self._pilot = pilot
        self._timeout = timeout

    def info(self) -> dict[str, Any]:
        """The pilot's own state and options (device vocabulary, passed
        through as-is). `target` (radians on the wire) becomes `targetDeg`.
        Live state itself rides the delta stream, not this call."""
        body = self._request("GET", "")
        out: dict[str, Any] = {"pilot": self._pilot}
        for key in ("state", "mode", "engaged", "options"):
            if key in body:
                out[key] = body[key]
        target = body.get("target")
        if isinstance(target, (int, float)) and not isinstance(target, bool):
            out["targetDeg"] = float(target) / _DEG_TO_RAD
        return out

    def engage(self) -> dict[str, Any]:
        return self._request("POST", "/engage")

    def disengage(self) -> dict[str, Any]:
        return self._request("POST", "/disengage")

    def set_state(self, value: str) -> dict[str, Any]:
        return self._request("PUT", "/state", {"value": value})

    def set_mode(self, value: str) -> dict[str, Any]:
        return self._request("PUT", "/mode", {"value": value})

    def set_target(self, degrees: float) -> dict[str, Any]:
        return self._request("PUT", "/target", _angle(degrees))

    def adjust_target(self, degrees: float) -> dict[str, Any]:
        """Not sugar over `set_target`: the device applies the delta itself,
        so a "+10°" tap can't race a target update we haven't heard about."""
        return self._request("PUT", "/target/adjust", _angle(degrees))

    def tack(self, direction: str) -> dict[str, Any]:
        """POST to the API's own split path (`.../tack/port` etc.) — direction
        is validated at the edge (`features/autopilot/routes.py`), not as a
        device option."""
        return self._request("POST", f"/tack/{direction}")

    def gybe(self, direction: str) -> dict[str, Any]:
        """As `tack`: split fixed paths, direction validated at the edge."""
        return self._request("POST", f"/gybe/{direction}")

    def start_dodge(self) -> dict[str, Any]:
        return self._request("POST", "/dodge")

    def stop_dodge(self) -> dict[str, Any]:
        return self._request("DELETE", "/dodge")

    def dodge(self, degrees: float) -> dict[str, Any]:
        return self._request("PUT", "/dodge", _angle(degrees))

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self._base_url:
            raise AutopilotUnavailable(
                "SignalK is disabled in this server's configuration, so there "
                "is no autopilot to command"
            )
        url = f"{self._base_url}/{self._pilot}{path}"
        # Absence of a token is not a local veto: whether a request needs
        # it is the server's policy (its readOnlyAccess setting), not ours.
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            with httpx.Client(timeout=self._timeout) as http:
                response = http.request(method, url, json=body, headers=headers)
        except httpx.HTTPError as e:
            raise AutopilotUnreachable(f"the SignalK server at {url} did not answer: {e}") from e

        if response.status_code in (401, 403):
            if not self._token:
                raise AutopilotUnavailable(
                    "the SignalK server requires authentication and no token is "
                    "configured. Create a device token in the SignalK admin UI "
                    "(Security → Devices) and PATCH it to credentials.signalk.token"
                )
            raise AutopilotUnauthorized(
                "the SignalK server rejected this server's token "
                f"(HTTP {response.status_code}); check credentials.signalk.token "
                "and that the device has write permission"
            )

        payload = _json(response)
        # The device's own statusCode/message outranks the HTTP status.
        if isinstance(payload, dict) and payload.get("state") == "FAILED":
            raise AutopilotRefused(
                _int(payload.get("statusCode"), response.status_code),
                str(payload.get("message") or "the autopilot refused the command"),
            )
        if response.status_code >= 400:
            raise AutopilotRefused(
                response.status_code,
                str((payload or {}).get("message") or response.text.strip() or "the autopilot refused the command"),
            )
        return payload if isinstance(payload, dict) else {}


def _angle(degrees: float) -> dict[str, Any]:
    """An AngleInput body: radians, per the API's documented field."""
    return {"value": degrees * _DEG_TO_RAD}


def _json(response: httpx.Response) -> dict[str, Any] | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _int(value: Any, fallback: int) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else fallback
