# SPDX-License-Identifier: GPL-2.0-only
"""The SignalK v1 device access-request flow — obtaining the write token the
autopilot handshake needs. Fails fast (no retry: a human is waiting) and
never logs the returned token. See
docs/architecture/signalk-access-request-flow.md for the full protocol.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

log = logging.getLogger(__name__)

#: One attempt, then an error. Looser than the autopilot's 4s (an admin
#: handshake, not a steering command) but still too short to strand a human.
REQUEST_TIMEOUT = 10.0

#: Shown beside the request in the SignalK admin's Access Requests list.
DESCRIPTION = "mivnav"

#: The levels a device may ask for. Sending one makes SignalK's approval a
#: plain approve/deny: the admin UI shows the requested level and does not
#: offer a picker (signalk-server tokensecurity: ``requestedPermissions``).
READWRITE = "readwrite"
ADMIN = "admin"

_ACCESS_PATH = "/signalk/v1/access/requests"
_REQUESTS_PATH = "/signalk/v1/requests"


class AccessRequestError(Exception):
    """Base: the access-request handshake could not be completed."""


class SignalKUnavailable(AccessRequestError):
    """No SignalK server is addressable — it is disabled, or has no URL.

    A misconfiguration, not a fault, and not something a retry fixes.
    """


class SignalKUnreachable(AccessRequestError):
    """The SignalK server did not answer in time, or answered nonsense."""


def ws_to_http_base(ws_url: str) -> str:
    """The HTTP origin (``scheme://host:port``) for a ``ws(s)://`` URL, so
    the access-request base can't drift from the connection URL a UI
    configured. Path and query are dropped; v1 access paths are absolute."""
    parts = urlsplit(ws_url)
    scheme = {"ws": "http", "wss": "https"}.get(parts.scheme, parts.scheme)
    return urlunsplit((scheme, parts.netloc, "", "", ""))


class AccessRequestClient:
    """The v1 access-request handshake, client side. Pure of config and
    environment — takes an HTTP base URL; the composition root
    (:mod:`mivnav.api.signalk`) derives it via :func:`ws_to_http_base`."""

    def __init__(
        self, base_url: str | None, *, timeout: float = REQUEST_TIMEOUT
    ) -> None:
        self._base_url = base_url.rstrip("/") if base_url else None
        self._timeout = timeout

    def request_access(
        self, client_id: str, description: str = DESCRIPTION, *, permissions: str
    ) -> dict[str, Any]:
        """Initiate a request for ``permissions`` (:data:`READWRITE` or
        :data:`ADMIN`). Returns ``{"state", "requestId"}``.

        ``permissions`` is required, not defaulted: every caller states the
        level it actually needs, and SignalK grants exactly that — the human
        approving it no longer has to know which level to pick.

        ``requestId`` is the last segment of the ``href`` SignalK returns —
        the only thing a later :meth:`poll` needs, so the caller can hand it
        to a UI that polls without any server-side state.
        """
        body = self._post(
            _ACCESS_PATH,
            {
                "clientId": client_id,
                "description": description,
                "permissions": permissions,
            },
        )
        href = body.get("href")
        request_id = str(href).rstrip("/").rsplit("/", 1)[-1] if href else None
        if not request_id:
            raise SignalKUnreachable(
                "the SignalK server accepted the access request but did not "
                "return a request reference to poll"
            )
        return {"state": body.get("state", "PENDING"), "requestId": request_id}

    def poll(self, request_id: str) -> dict[str, Any]:
        """Poll one request by id. Returns ``{"state": "PENDING"}``,
        ``{"state": "COMPLETED", "approved": True, "token": <jwt>}``, or
        ``approved: False`` (also covers approved-with-no-token, an unusable
        state reported as denial rather than a spurious success)."""
        body = self._get(f"{_REQUESTS_PATH}/{request_id}")
        state = body.get("state")
        if state != "COMPLETED":
            # PENDING, or anything not-yet-terminal, is "keep waiting".
            return {"state": "PENDING"}
        access = body.get("accessRequest")
        access = access if isinstance(access, dict) else {}
        permission = access.get("permission")
        token = access.get("token")
        if permission == "APPROVED" and isinstance(token, str) and token:
            return {"state": "COMPLETED", "approved": True, "token": token}
        return {"state": "COMPLETED", "approved": False}

    # -- internals --------------------------------------------------------

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        response = self._send("POST", path, body)
        # 202 is the documented success; 200 is accepted too, defensively.
        if response.status_code not in (200, 202):
            raise SignalKUnreachable(
                f"the SignalK server answered the access request with HTTP "
                f"{response.status_code}"
            )
        return _json(response)

    def _get(self, path: str) -> dict[str, Any]:
        response = self._send("GET", path, None)
        if response.status_code == 404:
            raise SignalKUnreachable(
                "the SignalK server no longer knows this access request; it "
                "may have expired — start a new one"
            )
        if response.status_code != 200:
            raise SignalKUnreachable(
                f"the SignalK server answered the poll with HTTP {response.status_code}"
            )
        return _json(response)

    def _send(
        self, method: str, path: str, body: dict[str, Any] | None
    ) -> httpx.Response:
        if not self._base_url:
            raise SignalKUnavailable(
                "SignalK is disabled in this server's configuration, so there "
                "is no server to request access from"
            )
        url = f"{self._base_url}{path}"
        try:
            with httpx.Client(timeout=self._timeout) as http:
                return http.request(method, url, json=body)
        except httpx.HTTPError as e:
            # No retry, on purpose — a human is waiting. See the module docstring.
            raise SignalKUnreachable(
                f"the SignalK server at {url} did not answer: {e}"
            ) from e


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as e:
        raise SignalKUnreachable("the SignalK server's reply was not JSON") from e
    if not isinstance(payload, dict):
        raise SignalKUnreachable("the SignalK server's reply was not a JSON object")
    return payload
