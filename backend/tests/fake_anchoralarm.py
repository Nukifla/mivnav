# SPDX-License-Identifier: GPL-2.0-only
"""SignalK's anchoralarm plugin (v2.0.1), faked on a real loopback port —
only the surface mivnav may use with a read/write device token.

Same approach as :mod:`tests.fake_course`: what can be wrong is the request
— URL, bearer header, body — so this serves it over real TCP and records
what arrived. Behaviour read from sbender9/signalk-anchoralarm-plugin
``src/index.ts`` @ 96ebb11 (the version on the boat):

- ``PUT /signalk/v1/api/vessels/self/navigation/anchor/maxRadius {value}``
  and ``…/position {value}`` — the plugin's PUT handlers; ``null`` position
  raises. A position PUT starts watching with the REMEMBERED radius
  (``putPosition``) — the 49.79 m leftover this fake starts with, as on the
  boat — and not at all while that radius is ``null`` (``if (state.radius)``).
- ``POST /signalk/v2/api/notifications/<id>/acknowledge`` — the server's.
- ``POST /signalk/v2/api/notifications/<id>/silence`` — likewise.
- The plugin's own REST (``/plugins/anchoralarm/*``) answers 401: on
  signalk-server it is admin-only, and a device token is not an admin.
- Every route needs the bearer token (the boat runs with security on).
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

TOKEN = "fake-signalk-device-token"
NOTIFICATION_ID = "9d6e9d73-e919-40c3-8802-58351d896e8b"

_PLUGIN = "/plugins/anchoralarm"
_SELF = "/signalk/v1/api/vessels/self"
_NOTIFICATIONS = "/signalk/v2/api/notifications"


class FakeAnchorAlarm:
    def __init__(self, token: str | None = TOKEN, *, plugin: bool = True) -> None:
        self.token = token
        #: False = the plugin is not installed: its REST and PUT paths 404.
        self.plugin = plugin
        self.position: dict[str, float] | None = None
        #: As measured on the boat: a radius persisted from an earlier session.
        self.radius_m: float | None = 49.79
        self.acknowledged: list[str] = []
        self.silenced: list[str] = []
        self.watched_with: float | None = None
        self.requests: list[tuple[str, str, Any]] = []
        self.authorizations: list[str | None] = []
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> FakeAnchorAlarm:
        self._server = HTTPServer(("127.0.0.1", 0), _handler(self))
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="fake-anchoralarm", daemon=True
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.server_address[1]

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def watching(self) -> bool:
        return self.position is not None and self.radius_m is not None

    def handle(self, method: str, path: str, body: Any, auth: str | None) -> tuple[int, dict[str, Any]]:
        self.requests.append((method, path, body))
        self.authorizations.append(auth)
        if self.token is not None and auth != f"Bearer {self.token}":
            return 401, {"message": "Unauthorized"}
        if path.startswith(_PLUGIN):
            return 401, {"message": "Unauthorized"}  # admin-only; we are not
        value = body.get("value") if isinstance(body, dict) else None

        if method == "POST" and path.startswith(_NOTIFICATIONS + "/") and path.endswith("/acknowledge"):
            nid = path[len(_NOTIFICATIONS) + 1 : -len("/acknowledge")]
            if nid != NOTIFICATION_ID:
                return 400, {"state": "FAILED", "statusCode": 400, "message": "Notification not found!"}
            self.acknowledged.append(nid)
            return 200, {"state": "COMPLETED", "statusCode": 200}

        if method == "POST" and path.startswith(_NOTIFICATIONS + "/") and path.endswith("/silence"):
            nid = path[len(_NOTIFICATIONS) + 1 : -len("/silence")]
            if nid != NOTIFICATION_ID:
                return 400, {"state": "FAILED", "statusCode": 400, "message": "Alarm not found!"}
            self.silenced.append(nid)
            return 200, {"state": "COMPLETED", "statusCode": 200}

        if not self.plugin:
            return 404, {"message": "Not found"}

        if method == "PUT" and path == f"{_SELF}/navigation/anchor/maxRadius":
            self.radius_m = value
            return 200, {"state": "COMPLETED", "statusCode": 200}
        if method == "PUT" and path == f"{_SELF}/navigation/anchor/position":
            if value is None:
                self.position = None
            else:
                self.position = dict(value)
                #: As `putPosition`: watching starts with the radius it HAS.
                self.watched_with = self.radius_m
            return 200, {"state": "COMPLETED", "statusCode": 200}
        return 404, {"message": "Not found"}


def _handler(fake: FakeAnchorAlarm) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _serve(self, method: str) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw) if raw else None
            except ValueError:
                body = None
            status, payload = fake.handle(method, self.path, body, self.headers.get("Authorization"))
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:  # noqa: N802
            self._serve("POST")

        def do_PUT(self) -> None:  # noqa: N802
            self._serve("PUT")

        def log_message(self, *args: Any) -> None:
            pass

    return Handler
