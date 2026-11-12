# SPDX-License-Identifier: GPL-2.0-only
"""Acknowledging or silencing a SignalK notification on the SERVER — so every
display (and the MFD, through the N2K emitter) goes quiet at once, not just
the screen whose button was tapped. ``POST
/signalk/v2/api/notifications/{id}/acknowledge`` and ``…/{id}/silence``
(signalk-server 2.33 ``api/notifications``): ACK empties the notification's
``method``, silence drops only ``sound`` from it, and either way the server
re-emits it. Only an *escalation* re-arms either — silence has no timer of
its own (:mod:`mivnav.collision.publisher` adds one). Same one-attempt
posture as the anchor and autopilot clients: a human is holding the button.
"""

from __future__ import annotations

from typing import Any

import httpx

REQUEST_TIMEOUT = 4.0


class AckError(Exception):
    """Base: the acknowledgement did not take effect."""


class AckUnavailable(AckError):
    """No SignalK configured, or it refused our credentials — config, not a retry."""


class AckUnreachable(AckError):
    """The SignalK server did not answer."""


class AckRefused(AckError):
    """SignalK answered and said no, in its own words."""


def acknowledge(
    notifications_url: str, token: str | None, notification_id: str, *, timeout: float = REQUEST_TIMEOUT
) -> None:
    _post(notifications_url, token, notification_id, "acknowledge", timeout)


def silence(
    notifications_url: str, token: str | None, notification_id: str, *, timeout: float = REQUEST_TIMEOUT
) -> None:
    _post(notifications_url, token, notification_id, "silence", timeout)


def _post(notifications_url: str, token: str | None, notification_id: str, action: str, timeout: float) -> None:
    url = f"{notifications_url.rstrip('/')}/{notification_id}/{action}"
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        with httpx.Client(timeout=timeout) as http:
            response = http.post(url, json={}, headers=headers)
    except httpx.HTTPError as e:
        raise AckUnreachable(f"the SignalK server at {url} did not answer: {e}") from e
    if response.status_code in (401, 403):
        raise AckUnavailable(
            "SignalK refused mivnav's write access — request it under Settings → SignalK"
        )
    if response.status_code >= 400:
        raise AckRefused(_message(response))


def _message(response: httpx.Response) -> str:
    try:
        payload: Any = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict) and payload.get("message"):
        return str(payload["message"])
    return response.text.strip()[:200] or f"HTTP {response.status_code}"
