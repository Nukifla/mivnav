# SPDX-License-Identifier: GPL-2.0-only
"""A SignalK History API, faked, on a real loopback port.

Real HTTP, for the same reason :mod:`tests.fake_autopilot` and
:mod:`tests.fake_signalk` use real sockets: what can actually be wrong here
is the *request* — the path, the query parameters, the bearer header — and
a mock at the client's seam would assert our own beliefs back at us. This
serves the route over TCP and records exactly what arrived.

**How faithful, and to what.** Transcribed from signalk-server's own
published sources rather than a live box (see
:mod:`mivnav.features.track.client` for why there was none, and for the
file references). Specifically it reproduces:

- the mount path ``/signalk/v2/api/history`` and the ``/values`` route;
- the ``ValuesResponse`` envelope ``{context, range: {from, to}, values:
  [{path, method}], data: [[timestamp, …]]}``, with ``null`` for a bucket
  with no data;
- **501** ``{"error": "No history api provider configured"}`` when no
  provider is registered — the plain-box case, and the one this fake
  exists to make testable;
- **400** ``{"error": "Validation errors: …"}`` for a bad query;
- ``GET …/_providers`` → ``{id: {isDefault}}``, and a ``provider`` query
  parameter answered from that provider — **400** ``Requested provider not
  found! (id)`` for an unregistered one (all measured on signalk-server
  2.34, 2026-10-28).

Where it is not faithful: it does not aggregate, so ``resolution`` is
recorded rather than applied, it ignores ``from``/``to`` (the client
filters to its window itself, so every row is in play), and it stores
whatever fixes a test hands it.
It is a conversational double for our client — the wire is the only thing
it is authoritative about, which is the only thing the client knows.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

TOKEN = "fake-signalk-device-token"

_BASE = "/signalk/v2/api/history"


class FakeHistory:
    """Speaks the ``/values`` subset of the History API this app reads."""

    def __init__(self, token: str | None = TOKEN) -> None:
        #: None = the server has security off entirely (reads need no token).
        self.token = token
        #: True = a history plugin is registered. False reproduces the plain
        #: box: every query answers 501.
        self.has_provider = True
        #: The rows this fake returns, verbatim, as `data`. Rows are
        #: ``[timestamp, value]`` and a test may put anything in `value` —
        #: including None, which is the documented "no data in this bucket".
        self.rows: list[list[Any]] = []
        #: Rows for any context other than ``vessels.self`` — an earlier
        #: identity of the same boat. Unlisted contexts have no data.
        self.rows_by_context: dict[str, list[list[Any]]] = {}
        #: Registered providers, ``{id: is_default}``. The default answers
        #: with :attr:`rows`; any other with its :attr:`rows_by_provider`.
        self.providers: dict[str, bool] = {"fake-history": True}
        self.rows_by_provider: dict[str, list[list[Any]]] = {}
        #: The `range` this fake echoes back.
        self.range_from = "2026-07-29T06:00:00.000Z"
        self.range_to = "2026-07-29T12:00:00.000Z"
        #: Every query that arrived, as a parsed query dict. The assertion
        #: surface for "we asked what we said we asked".
        self.queries: list[dict[str, str]] = []
        #: Whether the last request carried our bearer token.
        self.authorised: list[bool] = []
        #: Set to a (status, body) to make the next query fail.
        self.fail_with: tuple[int, dict[str, Any]] | None = None
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> FakeHistory:
        self._server = HTTPServer(("127.0.0.1", 0), _handler(self))
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="fake-history", daemon=True
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

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}{_BASE}"

    # -- convenience -------------------------------------------------------

    def set_positions(self, fixes: list[tuple[str, float, float]]) -> None:
        """Load ``(timestamp, lat, lon)`` fixes as SignalK position objects —
        the object shape the spec describes."""
        self.rows = [[t, {"latitude": lat, "longitude": lon}] for t, lat, lon in fixes]

    # -- the API's behaviour ----------------------------------------------

    def values(
        self, context: str = "vessels.self", provider: str | None = None
    ) -> tuple[int, dict[str, Any]]:
        if self.fail_with is not None:
            return self.fail_with
        if not self.has_provider:
            return 501, {"error": "No history api provider configured"}
        if provider is not None and provider not in self.providers:
            return 400, {"error": f"Requested provider not found! ({provider})"}
        if provider is not None and not self.providers[provider]:
            data = self.rows_by_provider.get(provider, []) if context == "vessels.self" else []
        elif context == "vessels.self":
            data = self.rows
        else:
            data = self.rows_by_context.get(context, [])
        return 200, {
            "context": "vessels.urn:mrn:signalk:uuid:fake",
            "range": {"from": self.range_from, "to": self.range_to},
            "values": [{"path": "navigation.position", "method": "first"}],
            "data": data,
        }


def _handler(history: FakeHistory) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # keep the test output clean
            pass

        def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's name
            parsed = urlparse(self.path)
            if parsed.path == f"{_BASE}/_providers":
                self._send(
                    200, {id: {"isDefault": d} for id, d in history.providers.items()}
                )
                return
            if parsed.path != f"{_BASE}/values":
                self._send(404, {"error": "not found"})
                return
            query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            history.queries.append(query)
            history.authorised.append(
                self.headers.get("Authorization") == f"Bearer {history.token}"
            )
            if "paths" not in query:
                self._send(
                    400,
                    {"error": "Validation errors: paths parameter is required"},
                )
                return
            status, payload = history.values(
                query.get("context", "vessels.self"), query.get("provider")
            )
            self._send(status, payload)

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler
