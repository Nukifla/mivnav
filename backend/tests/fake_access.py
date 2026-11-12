# SPDX-License-Identifier: GPL-2.0-only
"""The SignalK v1 device access-request API, faked on a real loopback port.

Real HTTP, for the same reason :mod:`tests.fake_autopilot` uses real
sockets: what can actually be wrong is the request — the paths, the body
shape (``clientId``/``description``), the two-step PENDING→COMPLETED
protocol — and a mock at the client's seam would only assert our own
beliefs back at us. This serves the two routes over TCP and records what
arrived.

Faithful to the flow signalk-server implements:

- ``POST /signalk/v1/access/requests`` → ``202`` with
  ``{"state": "PENDING", "href": "/signalk/v1/requests/<id>"}``;
- ``GET /signalk/v1/requests/<id>`` → ``{"state": "PENDING"}`` until a test
  calls :meth:`approve` or :meth:`deny`, then the terminal
  ``{"state": "COMPLETED", "statusCode": 200, "accessRequest": {...}}``.

A human approving in the SignalK admin is modelled by the test calling
``approve``/``deny`` between two polls — which is exactly the PENDING→…
transition the frontend polls across.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

_ACCESS = "/signalk/v1/access/requests"
_REQUESTS = "/signalk/v1/requests"


class FakeAccess:
    """Speaks the subset of the v1 access-request API mivnav drives."""

    def __init__(self) -> None:
        self._n = 0
        #: request_id -> terminal accessRequest dict, or None while pending.
        self._outcome: dict[str, dict[str, Any] | None] = {}
        #: Every access-request body that arrived, in order — the assertion
        #: surface for "we sent a stable clientId".
        self.requests: list[dict[str, Any]] = []
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> FakeAccess:
        self._server = HTTPServer(("127.0.0.1", 0), _handler(self))
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="fake-access", daemon=True
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=10)

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.server_address[1]

    # -- the human's side --------------------------------------------------

    def approve(self, request_id: str, token: str) -> None:
        self._outcome[request_id] = {"permission": "APPROVED", "token": token}

    def deny(self, request_id: str) -> None:
        self._outcome[request_id] = {"permission": "DENIED"}

    # -- the API's behaviour ----------------------------------------------

    def create(self, body: dict[str, Any]) -> dict[str, Any]:
        self.requests.append(body)
        self._n += 1
        request_id = f"req-{self._n}"
        self._outcome[request_id] = None  # pending
        return {"state": "PENDING", "href": f"{_REQUESTS}/{request_id}"}

    def poll(self, request_id: str) -> tuple[int, dict[str, Any]]:
        if request_id not in self._outcome:
            return 404, {"state": "FAILED", "statusCode": 404, "message": "not found"}
        outcome = self._outcome[request_id]
        if outcome is None:
            return 200, {"state": "PENDING"}
        return 200, {"state": "COMPLETED", "statusCode": 200, "accessRequest": outcome}


def _handler(fake: FakeAccess) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # keep test output clean
            pass

        def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's name
            path = self.path.split("?")[0]
            if path != _ACCESS:
                self._send(404, {"message": "not found"})
                return
            self._send(202, fake.create(self._body() or {}))

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]
            if not path.startswith(_REQUESTS + "/"):
                self._send(404, {"message": "not found"})
                return
            request_id = path[len(_REQUESTS) + 1 :]
            status, payload = fake.poll(request_id)
            self._send(status, payload)

        def _body(self) -> Any:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return None
            try:
                return json.loads(self.rfile.read(length))
            except ValueError:
                return None

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler
