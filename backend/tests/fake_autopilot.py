# SPDX-License-Identifier: GPL-2.0-only
"""A SignalK v2 Autopilot API, faked, on a real loopback port.

Real HTTP, for the same reason :mod:`tests.fake_signalk` uses real
sockets: the thing that can actually be wrong here is the request — the
URL, the bearer header, the units, the shape of the body — and a mock at
the client's seam would assert our own beliefs back at us. This serves the
routes over TCP and records exactly what arrived.

**How faithful, and how it was established.** Every route, body, response
shape and status code below was taken from the boat's own server
(signalk-server 2.30.0): its published OpenAPI document at
``/skServer/openapi/autopilot`` and its live ``GET`` responses, read while
writing this. Specifically it reproduces:

- the base path ``/signalk/v2/api/vessels/self/autopilots/{id}`` and the
  ``_default`` alias;
- ``bearerAuth``: **401 to an unauthenticated write**, and 200 to an
  unauthenticated read — which is the boat's real posture
  (``readOnlyAccess: true``), and the reason our read path needs no token;
- the two documented replies, verbatim: ``{"state": "COMPLETED",
  "statusCode": 200}`` and ``{"state": "FAILED", "statusCode": 400|404,
  "message": …}``;
- ``AngleInput`` in **radians**, per the spec's "value in radians";
- the real ``options`` payload of the boat's ``pypilot-sk`` provider,
  copied from the live response — including that its actions are all
  ``available: false``.

**Where it is not faithful, and why that is safe.** It does not steer
anything, so ``engage`` merely records; it validates values against
``options`` rather than by asking a pilot; and it does not implement the
routes we do not call (``_providers``). The action routes we *do* call —
tack, gybe and dodge — it records: their v2 shape is the split ``POST
…/tack/{port|starboard}`` (direction in the path, no body), and dodge is
``POST`` to enter / ``DELETE`` to leave / ``PUT`` an AngleInput to steer,
per the boat's OpenAPI document. It is a conversational double for our
client, not a model of an autopilot — the one thing it is authoritative
about is the wire, which is the only thing the client knows.

**No real autopilot was commanded to build this.** The live server was
probed with GETs only; the one write ever attempted against it went to a
non-steering scratch path purely to observe that PUT answers 401.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

TOKEN = "fake-signalk-device-token"

#: The live `pypilot-sk` provider's own options, copied verbatim from
#: GET /signalk/v2/api/vessels/self/autopilots/_default on the boat.
PYPILOT_OPTIONS: dict[str, Any] = {
    "states": [
        {"name": "enabled", "engaged": True},
        {"name": "disabled", "engaged": False},
    ],
    "modes": ["compass", "gps", "nav", "wind", "true wind"],
    "actions": [
        {"id": "tack", "name": "Tack", "available": False},
        {"id": "courseCurrentPoint", "name": "To Destination", "available": False},
        {"id": "courseNextPoint", "name": "Adv. Waypoint", "available": False},
    ],
}

_BASE = "/signalk/v2/api/vessels/self/autopilots"


class FakeAutopilot:
    """Speaks the subset of the v2 Autopilot API this app commands."""

    def __init__(self, token: str | None = TOKEN) -> None:
        #: None = the server has security off entirely (writes need no token).
        self.token = token
        self.state = "disabled"
        self.mode = "gps"
        self.engaged = False
        #: Radians, as on the wire. 0.8901… is what the boat reported.
        self.target = 0.8901179185171081
        #: The last action commanded, for assertions. The direction of the
        #: last tack/gybe ("port"/"starboard"), whether dodge mode is on, and
        #: the last relative dodge angle in radians.
        self.tacked: str | None = None
        self.gybed: str | None = None
        self.dodging = False
        self.dodge: float | None = None
        #: Every request that arrived: (method, path, body). The assertion
        #: surface for "we sent what we said we sent".
        self.requests: list[tuple[str, str, Any]] = []
        #: Set to a (status, body) to make the next command fail, so a
        #: refusal can be tested without an invalid request.
        self.fail_with: tuple[int, dict[str, Any]] | None = None
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> FakeAutopilot:
        self._server = HTTPServer(("127.0.0.1", 0), _handler(self))
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="fake-autopilot", daemon=True
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

    # -- the API's behaviour ----------------------------------------------

    def info(self) -> dict[str, Any]:
        return {
            "options": PYPILOT_OPTIONS,
            "state": self.state,
            "mode": self.mode,
            "target": self.target,
            "engaged": self.engaged,
        }

    def command(self, method: str, action: str, body: Any) -> tuple[int, dict[str, Any]]:
        if self.fail_with is not None:
            return self.fail_with
        if action in ("tack/port", "tack/starboard"):
            self.tacked = action.split("/", 1)[1]
            return _completed()
        if action in ("gybe/port", "gybe/starboard"):
            self.gybed = action.split("/", 1)[1]
            return _completed()
        if action == "dodge":
            if method == "POST":
                self.dodging = True
                return _completed()
            if method == "DELETE":
                self.dodging = False
                return _completed()
            value = _value(body)  # PUT: steer clear by a relative angle
            if not isinstance(value, (int, float)):
                return _failed(400, "dodge requires a numeric value")
            self.dodge = float(value)
            return _completed()
        if action == "engage":
            return self._enter("enabled")
        if action == "disengage":
            return self._enter("disabled")
        if action == "state":
            return self._enter(_value(body))
        if action == "mode":
            value = _value(body)
            if value not in PYPILOT_OPTIONS["modes"]:
                return _failed(400, f"Invalid mode: {value}")
            self.mode = value
            return _completed()
        if action == "target":
            value = _value(body)
            if not isinstance(value, (int, float)):
                return _failed(400, "target requires a numeric value")
            self.target = float(value)
            return _completed()
        if action == "target/adjust":
            value = _value(body)
            if not isinstance(value, (int, float)):
                return _failed(400, "adjust requires a numeric value")
            self.target += float(value)
            return _completed()
        return _failed(404, f"Unknown action: {action}")

    def _enter(self, state: Any) -> tuple[int, dict[str, Any]]:
        for definition in PYPILOT_OPTIONS["states"]:
            if definition["name"] == state:
                self.state = definition["name"]
                self.engaged = definition["engaged"]
                return _completed()
        return _failed(400, f"Invalid state: {state}")


def _completed() -> tuple[int, dict[str, Any]]:
    return 200, {"state": "COMPLETED", "statusCode": 200}


def _failed(code: int, message: str) -> tuple[int, dict[str, Any]]:
    return code, {"state": "FAILED", "statusCode": code, "message": message}


def _value(body: Any) -> Any:
    return body.get("value") if isinstance(body, dict) else None


def _handler(pilot: FakeAutopilot) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # keep the test output clean
            pass

        # -- routing -------------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's name
            self._dispatch("GET")

        def do_PUT(self) -> None:  # noqa: N802
            self._dispatch("PUT")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

        def _dispatch(self, method: str) -> None:
            body = self._body()
            pilot.requests.append((method, self.path, body))
            rest = self._route()
            if rest is None:
                self._send(404, {"message": "not found"})
                return
            # Reads are anonymous, writes are not — the boat's real posture
            # (readOnlyAccess: true, authenticationRequired: true).
            if method != "GET" and not self._authorised():
                self._send(401, {"message": "Unauthorized"})
                return
            if method == "GET":
                self._send(200, pilot.info() if not rest else {"value": None})
                return
            status, payload = pilot.command(method, rest, body)
            self._send(status, payload)

        def _route(self) -> str | None:
            """The action after ``…/autopilots/{id}``, or None if off-base."""
            path = self.path.split("?")[0]
            if not path.startswith(_BASE + "/"):
                return None
            tail = path[len(_BASE) + 1 :]
            pilot_id, _, action = tail.partition("/")
            if not pilot_id:
                return None
            return action

        def _authorised(self) -> bool:
            if pilot.token is None:
                return True
            return self.headers.get("Authorization") == f"Bearer {pilot.token}"

        # -- plumbing ------------------------------------------------------

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
