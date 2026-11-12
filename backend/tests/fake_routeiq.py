# SPDX-License-Identifier: GPL-2.0-only
"""A `signalk-routeiq` plugin's `POST /route`, faked on a real loopback
port — same "real HTTP, not a mock at the client's seam" posture as
:mod:`tests.fake_access` (see its own docstring for why), covering the
one route `mivnav.features.routing.routeiq.RouteIQClient` calls.

A test configures the canned response via :meth:`respond_ok`/
:meth:`respond_not_found`/:meth:`respond_status` before making the
request; :attr:`requests` records every body/header that arrived, for
asserting the client sent the right shape (draft/beam/airDraft, the
bearer token).
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

_ROUTE_PATH = "/plugins/signalk-routeiq/router/route"


class FakeRouteIQ:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.headers: list[dict[str, str]] = []
        self._status = 200
        self._body: dict[str, Any] = {"type": "FeatureCollection", "features": []}
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> "FakeRouteIQ":
        self._server = HTTPServer(("127.0.0.1", 0), _handler(self))
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="fake-routeiq", daemon=True
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

    # -- canned responses ----------------------------------------------------

    def respond_ok(
        self,
        waypoints: list[tuple[float, float]],
        *,
        total_distance_m: float = 1000.0,
        warnings: list[dict[str, str]] | None = None,
    ) -> None:
        """`waypoints` as `(lon, lat)` pairs, matching GeoJSON order."""
        self._status = 200
        self._body = {
            "type": "FeatureCollection",
            "totalDistance": total_distance_m,
            "warnings": warnings or [],
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": [list(w) for w in waypoints]},
                    "properties": {},
                }
            ],
        }

    def respond_not_found(self) -> None:
        self._status = 422
        self._body = {"code": "ROUTE_NOT_FOUND", "message": "no route found"}

    def respond_status(self, status: int, body: dict[str, Any] | None = None) -> None:
        self._status = status
        self._body = body or {}

    # -- the server's own behaviour ------------------------------------------

    def _handle_post(self, path: str, body: Any, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
        if path != _ROUTE_PATH:
            return 404, {"message": "not found"}
        self.requests.append(body or {})
        self.headers.append(headers)
        return self._status, self._body


def _handler(fake: FakeRouteIQ) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # keep test output clean
            pass

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]
            status, payload = fake._handle_post(path, self._body(), dict(self.headers.items()))
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
