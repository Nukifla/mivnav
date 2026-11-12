# SPDX-License-Identifier: GPL-2.0-only
"""Writing deltas INTO SignalK — a second, authenticated stream socket.

Not the reader's socket (:mod:`mivnav.signalk.service`): that one is keyed
on the connection config alone and carries no token, so granting or
revoking write access would otherwise mean re-dialling the boat's one
read connection. signalk-server accepts a delta frame on its v1 stream from
any principal with ``readwrite`` (``shouldAllowWrite``, measured in 2.33's
``interfaces/ws.ts``), labels it ``ws.<device id>``, and drops a refused
one SILENTLY — so the only proof a write landed is its echo on the read
stream, which is how :mod:`mivnav.collision` uses it.

Synchronous on purpose: its one caller is a worker thread that may block.
"""

from __future__ import annotations

import contextlib
import json
import logging
from collections.abc import Callable
from typing import Any

log = logging.getLogger(__name__)

#: One attempt this long, then the caller's retry cadence takes over.
OPEN_TIMEOUT = 4.0


def _default_connect(url: str, headers: dict[str, str]) -> Any:  # pragma: no cover - import shim
    from websockets.sync.client import connect

    return connect(url, additional_headers=headers, open_timeout=OPEN_TIMEOUT, close_timeout=1)


class DeltaWriter:
    """Holds one write socket open between sends; re-dials when the URL or
    token it is asked to use changes, or after any failure. Not thread-safe:
    owned by a single worker."""

    def __init__(self, connect: Callable[[str, dict[str, str]], Any] | None = None) -> None:
        self._connect = connect or _default_connect
        self._socket: Any = None
        self._key: tuple[str, str | None] | None = None

    def send(self, url: str, token: str | None, delta: dict[str, Any]) -> None:
        """Send one delta. Raises on any failure (and drops the socket, so
        the next call re-dials); success means *sent*, not *accepted*."""
        key = (url, token or None)
        if self._socket is None or key != self._key:
            self.close()
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            self._socket = self._connect(url, headers)
            self._key = key
        try:
            self._drain()
            self._socket.send(json.dumps(delta))
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        socket, self._socket, self._key = self._socket, None, None
        if socket is not None:
            with contextlib.suppress(Exception):
                socket.close()

    def _drain(self) -> None:
        """Discard what the server sent (the hello, little else with
        ``subscribe=none``): an unread inbound queue eventually stalls the
        client's keepalive and the socket dies under us."""
        while True:
            try:
                self._socket.recv(timeout=0)
            except TimeoutError:
                return
