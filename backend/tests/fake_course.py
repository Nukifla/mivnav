# SPDX-License-Identifier: GPL-2.0-only
"""A SignalK v2 Course/Resources API, faked, on a real loopback port.

The same approach as :mod:`tests.fake_autopilot`, and for the same reason:
the thing that can actually be wrong is the *request* — the URL, the bearer
header, the body shape — so a mock at the client seam would only assert our
own beliefs back at us. This serves the routes the app writes to over real
TCP and records exactly what arrived.

Faithful to the published SignalK v2 Course/Resources APIs, verified by
reading ``SignalK/signalk-server``'s ``src/api/course/index.ts`` (GPLv2,
#yprzuqtt — see :mod:`mivnav.features.route.client`'s module docstring for
the same source read applied to the client):

- ``GET``/``PUT``/``DELETE …/resources/routes[/<id>]``  the route STORE
  (#vozswkrl). ``PUT`` is idempotent by id; ``GET`` on the collection
  answers ``{id: resource}`` (the shape signalk-server's resource API
  returns) and on one id answers the resource or 404; ``DELETE`` 404s what
  it does not have. A route resource is a GeoJSON ``Feature``/
  ``LineString``.

  Deliberately permissive about the COORDINATE COUNT: an empty or
  one-point LineString is accepted here, because mivnav can hold a route
  that is still being drawn and whether the real server's schema imposes
  ``minItems`` is exactly the sort of thing this fake cannot know (see
  :mod:`mivnav.features.route.wire`'s verification note). A fake that
  guessed strict would fail tests the box might pass, and vice versa; what
  it must not do is quietly change the answer.
- ``PUT …/vessels/self/navigation/course/activeRoute``
  ``{"href", "pointIndex", "reverse"}`` — activate a registered route at a
  point. Fails if ``href`` does not resolve to a registered resource (the
  real server 400s the same way).
- ``PUT …/vessels/self/navigation/course/activeRoute/nextPoint``  ``{}`` —
  step the active route on by (default) one point, clamped to the last
  index (never past it — the real server's ``parsePointIndex``).
- ``DELETE …/vessels/self/navigation/course``  clears everything —
  destination-shaped state, ``activeRoute``, the derived next/previous
  point — matching the real server's ``clearDestination()``, which resets
  its whole ``courseInfo``.
- ``bearerAuth``: a write with a wrong/missing token is 401, matching the
  boat's ``readOnlyAccess: true`` posture.

**``previousPoint`` at a non-zero index comes from the registered route's
OWN coordinates, never a vessel position (#yprzuqtt's whole point).** This
fake has no notion of the vessel's position at all — there is nothing here
it COULD derive a live-position previousPoint from — so
:attr:`FakeCourse.previous_point` being the exact stored waypoint coordinate
after an ``activeRoute``/``nextPoint`` call is not a coincidence of the
fake being lenient; it is the one thing this fake is faithful about
checking. ``pointIndex == 0`` is the one case the real server anchors
``previousPoint`` at the vessel instead (the old ``"target"`` leg's
semantics, now the server's own default) — this fake represents that case
as ``previous_point is None`` (nothing to derive it from), which is exactly
the assertion surface a test needs: "did NOT come from route data."

No more bare ``…/destination`` — the verb this app used before #yprzuqtt
(and the resource/``activeRoute`` verbs this fake faked before that, until
#vpxkyynv reverted to the bare verb) is not modelled here; nothing in this
app writes it any more.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

TOKEN = "fake-signalk-device-token"

_VESSEL_BASE = "/signalk/v2/api/vessels/self"
_COURSE_BASE = f"{_VESSEL_BASE}/navigation/course"
_RESOURCES_BASE = "/signalk/v2/api/resources"


class FakeCourse:
    """Speaks the subset of the v2 Course/Resources APIs this app writes."""

    def __init__(self, token: str | None = TOKEN) -> None:
        #: None = security off entirely (writes need no token).
        self.token = token
        #: route_id -> the exact resource body last PUT. The assertion
        #: surface for "the whole route reached SignalK".
        self.resources: dict[str, Any] = {}
        #: waypoint_id -> the exact resource body last PUT to
        #: ``resources/waypoints`` (standalone marks).
        self.waypoints: dict[str, Any] = {}
        #: {"href", "pointIndex", "reverse", "pointTotal"}, or None once
        #: cleared / before any activation.
        self.active_route: dict[str, Any] | None = None
        #: {"latitude", "longitude"} derived from the active route's own
        #: coordinates at `pointIndex`, or None.
        self.next_point: dict[str, float] | None = None
        #: {"latitude", "longitude"} derived from the active route's own
        #: coordinates at `pointIndex - 1`, or None at pointIndex 0 (the real
        #: server would anchor this at the vessel instead — see the module
        #: docstring) or before any activation.
        self.previous_point: dict[str, float] | None = None
        #: Every request that arrived: (method, path, body).
        self.requests: list[tuple[str, str, Any]] = []
        #: The `Authorization` header of every request that arrived, in the
        #: same order as :attr:`requests` — how the wire-contract test pins
        #: the bearer scheme itself, not just that SOME token passed the
        #: fake's own check (#zsswlmpz).
        self.authorizations: list[str | None] = []
        #: Set to (status, body) to make the next write fail.
        self.fail_with: tuple[int, dict[str, Any]] | None = None
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> FakeCourse:
        self._server = HTTPServer(("127.0.0.1", 0), _handler(self))
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="fake-course", daemon=True
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
        """The Course API base — what ``CourseClient(course_url=...)`` takes."""
        return f"http://127.0.0.1:{self.port}{_COURSE_BASE}"

    @property
    def resources_url(self) -> str:
        """The Resources API base — what ``CourseClient(resources_url=...)`` takes."""
        return f"http://127.0.0.1:{self.port}{_RESOURCES_BASE}"


def _completed() -> tuple[int, dict[str, Any]]:
    return 200, {"state": "COMPLETED", "statusCode": 200}


def _failed(message: str) -> tuple[int, dict[str, Any]]:
    return 400, {"state": "FAILED", "statusCode": 400, "message": message}


def _clamp_point_index(index: int, total: int) -> int:
    if total <= 0:
        return 0
    return max(0, min(index, total - 1))


def _handler(course: FakeCourse) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # keep test output clean
            pass

        def do_GET(self) -> None:  # noqa: N802
            self._dispatch("GET")

        def do_PUT(self) -> None:  # noqa: N802
            self._dispatch("PUT")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

        def _dispatch(self, method: str) -> None:
            body = self._body()
            course.requests.append((method, self.path, body))
            course.authorizations.append(self.headers.get("Authorization"))
            path = self.path.split("?")[0]
            if not self._authorised():
                self._send(401, {"message": "Unauthorized"})
                return
            if course.fail_with is not None:
                self._send(*course.fail_with)
                return

            if method == "GET" and path == f"{_RESOURCES_BASE}/routes":
                self._send(200, course.resources)
                return
            if method == "GET" and path.startswith(f"{_RESOURCES_BASE}/routes/"):
                resource = course.resources.get(_route_id_in(path))
                if resource is None:
                    self._send(404, {"message": "no such resource"})
                    return
                self._send(200, resource)
                return
            if method == "PUT" and path.startswith(f"{_RESOURCES_BASE}/routes/"):
                self._put_route(path, body)
                return
            if method == "DELETE" and path.startswith(f"{_RESOURCES_BASE}/routes/"):
                if course.resources.pop(_route_id_in(path), None) is None:
                    self._send(404, {"message": "no such resource"})
                    return
                self._send(*_completed())
                return
            if path == f"{_RESOURCES_BASE}/waypoints" and method == "GET":
                self._send(200, course.waypoints)
                return
            if path.startswith(f"{_RESOURCES_BASE}/waypoints/"):
                self._waypoint(method, path[len(f"{_RESOURCES_BASE}/waypoints/") :], body)
                return
            if method == "PUT" and path == f"{_COURSE_BASE}/activeRoute":
                self._activate_route(body)
                return
            if method == "PUT" and path == f"{_COURSE_BASE}/activeRoute/nextPoint":
                self._next_point(body)
                return
            if method == "DELETE" and path == _COURSE_BASE:
                course.active_route = None
                course.next_point = None
                course.previous_point = None
                self._send(*_completed())
                return
            self._send(404, {"message": "not found"})

        def _put_route(self, path: str, body: Any) -> None:
            # The geometry has to BE a LineString; how many points it has is
            # not this fake's to judge — see the module docstring.
            if not isinstance(body, dict) or _coordinates(body) is None:
                self._send(*_failed("invalid route resource"))
                return
            course.resources[_route_id_in(path)] = body
            self._send(*_completed())

        def _waypoint(self, method: str, waypoint_id: str, body: Any) -> None:
            # signalk-server validates a waypoint as a Feature with a Point.
            if method == "PUT":
                feature = body.get("feature") if isinstance(body, dict) else None
                geometry = feature.get("geometry") if isinstance(feature, dict) else None
                if not isinstance(geometry, dict) or geometry.get("type") != "Point":
                    self._send(*_failed("invalid waypoint resource"))
                    return
                course.waypoints[waypoint_id] = body
                self._send(*_completed())
                return
            resource = course.waypoints.get(waypoint_id)
            if resource is None:
                self._send(404, {"message": "no such resource"})
                return
            if method == "DELETE":
                del course.waypoints[waypoint_id]
                self._send(*_completed())
                return
            self._send(200, resource)

        def _activate_route(self, body: Any) -> None:
            if not isinstance(body, dict) or not isinstance(body.get("href"), str):
                self._send(*_failed("no href supplied"))
                return
            href: str = body["href"]
            route_id = _route_id_of(href)
            resource = course.resources.get(route_id) if route_id else None
            if resource is None:
                self._send(*_failed(f"could not retrieve route information for {href}"))
                return
            coords = _coordinates(resource) or []
            point_index = _clamp_point_index(int(body.get("pointIndex") or 0), len(coords))
            course.active_route = {
                "href": href,
                "pointIndex": point_index,
                "reverse": bool(body.get("reverse", False)),
                "pointTotal": len(coords),
            }
            course.next_point = _point_at(coords, point_index)
            # The real server anchors previousPoint at the VESSEL for a fresh
            # activation at index 0 — this fake has no vessel position to
            # derive that from, so it is None (see the module docstring).
            course.previous_point = _point_at(coords, point_index - 1) if point_index > 0 else None
            self._send(*_completed())

        def _next_point(self, body: Any) -> None:
            if course.active_route is None:
                self._send(*_failed("no active route"))
                return
            resource = course.resources.get(_route_id_of(course.active_route["href"]))
            if resource is None:
                self._send(*_failed("active route resource is gone"))
                return
            coords = _coordinates(resource) or []
            step = body.get("value") if isinstance(body, dict) else None
            step = int(step) if isinstance(step, (int, float)) else 1
            new_index = _clamp_point_index(course.active_route["pointIndex"] + step, len(coords))
            course.active_route["pointIndex"] = new_index
            course.next_point = _point_at(coords, new_index)
            # ALWAYS from the route's own coordinates here — never the
            # vessel — which is exactly what #yprzuqtt's arrival advance
            # depends on (see the module docstring).
            course.previous_point = _point_at(coords, new_index - 1) if new_index > 0 else None
            self._send(*_completed())

        def _authorised(self) -> bool:
            if course.token is None:
                return True
            return self.headers.get("Authorization") == f"Bearer {course.token}"

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


def _route_id_in(path: str) -> str:
    return path[len(f"{_RESOURCES_BASE}/routes/") :]


def _coordinates(resource: dict[str, Any]) -> list[list[float]] | None:
    """The resource's LineString coordinates, or ``None`` if it has no
    LineString at all — which is the only thing that makes it not a route.
    An EMPTY list is a real answer, not a rejection."""
    feature = resource.get("feature") if isinstance(resource, dict) else None
    geometry = feature.get("geometry") if isinstance(feature, dict) else None
    if not isinstance(geometry, dict) or geometry.get("type") != "LineString":
        return None
    coords = geometry.get("coordinates")
    return coords if isinstance(coords, list) else None


def _point_at(coords: list[list[float]], index: int) -> dict[str, float] | None:
    if index < 0 or index >= len(coords):
        return None
    lon, lat = coords[index][0], coords[index][1]
    return {"latitude": lat, "longitude": lon}


#: The SHORT resource reference `activeRoute.href` carries — NOT the full v2
#: API URL (`_RESOURCES_BASE` is that; this is the wire value the real
#: server's own `parseHref` expects, and what `CourseClient.activate_route`
#: actually sends).
_HREF_ROUTES_PREFIX = "/resources/routes/"


def _route_id_of(href: str) -> str | None:
    return href[len(_HREF_ROUTES_PREFIX) :] if href.startswith(_HREF_ROUTES_PREFIX) else None
