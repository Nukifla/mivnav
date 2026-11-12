# SPDX-License-Identifier: GPL-2.0-only
"""A remote call to a `signalk-routeiq` plugin instance's own HTTP API —
the ``"routeiq"`` `RoutingConfig.algorithm`, an ALTERNATIVE to chartcore's
raster-grid + A* search, for comparing the two live against the same real
request (asked for directly: "give me a setting where i can select
different routing algorithms").

**What this is, and is not.** RouteIQ (github.com/marcelrv/signalk-routeiq)
is a directed-A* search over a PERSISTENT, PRE-COMPILED graph (adaptive
quadtree nodes, hierarchical "supernodes" at junctions/locks/bridges) —
fundamentally different from chartcore's per-request raster grid. This
module does not reimplement that algorithm: it calls the real plugin over
HTTP, wherever the boat's own SignalK server is already running it. Found
live, by probing a real install directly (not assumed): RouteIQ needs its
OWN pre-compiled routing database per region — chart data is not enough —
and its own documentation states plainly that public routing data
currently covers only "a small set of test regions (parts of the
Netherlands and the US East Coast)". A request for anywhere else comes
back `ROUTE_NOT_FOUND` (422), which this module surfaces as
:class:`RouteIQNotFound`, a normal outcome, not a fault.

**Auth.** Every RouteIQ route — confirmed directly against a real install,
not assumed — answers `401 — Please Login` unauthenticated, even the ones
that only plan a route. It uses the SAME SignalK v1 device access-request
handshake the autopilot's write token already drives
(:mod:`mivnav.signalk.access`), against a SEPARATE grant/client id
(:class:`mivnav.config.model.RouteIQCredentials`,
``Config.routeiq_client_id``) — see the endpoints in
:mod:`mivnav.features.routing.routes` for the client side of that.

**Base URL.** Not a new connection setting: RouteIQ is a plugin ON the
boat's own already-configured SignalK server, so the base URL is the exact
same derivation :mod:`mivnav.api.signalk` already uses for the
access-request handshake (``ws_to_http_base(signalk.ws_url)``), passed in
by the caller rather than re-read here — this module stays pure of config,
like :mod:`mivnav.signalk.access`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger(__name__)

#: A real route computation, not a quick admin handshake — RouteIQ's own
#: A* over a large graph can take a few seconds; this is generous enough
#: not to cut it off mid-search while still bounded (a human is waiting on
#: an HTTP response either way).
REQUEST_TIMEOUT = 30.0

#: `POST` here plans a route; see the module docstring. Mounted by SignalK
#: under `/plugins/<pluginId>/`, confirmed directly against a real install.
_ROUTE_PATH = "/plugins/signalk-routeiq/router/route"


class RouteIQError(Exception):
    """Base: a RouteIQ plan could not be completed."""


class RouteIQUnavailable(RouteIQError):
    """Nothing to ask — SignalK is not configured, or no access token is
    stored yet. A configuration fact, not a fault; a retry will not fix
    it, requesting access (or enabling SignalK) will."""


class RouteIQUnreachable(RouteIQError):
    """RouteIQ did not answer, answered nonsense, refused the token, or
    reported an internal failure distinct from "no route found"."""


class RouteIQNotFound(RouteIQError):
    """RouteIQ answered normally but found no route for this request (its
    own `ROUTE_NOT_FOUND`) — the common, expected outcome for anywhere
    outside its own currently-published test regions. Not a fault."""


@dataclass
class RouteIQRoute:
    """A `chartcore.RoutePath`-shaped result from a remote RouteIQ plan —
    duck-types the same three attributes `mivnav.features.routing.routes`
    reads off either engine's result (`.waypoints` as `(lon, lat)` pairs,
    `.distance_m`, `.approximate_legs`), plus RouteIQ's own warning text
    passed through untouched. `approximate_legs` is always all-`False`:
    RouteIQ has no equivalent of chartcore's "routed as close as it
    honestly could, flagged" partial result — it either finds a route
    that satisfies its own hard constraints, or reports `ROUTE_NOT_FOUND`."""

    waypoints: list[tuple[float, float]] = field(default_factory=list)
    distance_m: float = 0.0
    approximate_legs: list[bool] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class RouteIQClient:
    """One call to a `signalk-routeiq` instance's `POST /route`. Pure of
    config, like :class:`mivnav.signalk.access.AccessRequestClient` —
    takes an HTTP base URL and a bearer token, built per request rather
    than derived, since there is nothing to keep alive between calls."""

    def __init__(
        self, base_url: str | None, token: str, *, timeout: float = REQUEST_TIMEOUT
    ) -> None:
        self._base_url = base_url.rstrip("/") if base_url else None
        self._token = token
        self._timeout = timeout

    def plan_route(
        self,
        from_lat: float,
        from_lon: float,
        to_lat: float,
        to_lon: float,
        *,
        draft_m: float,
        beam_m: float,
        air_draft_m: float,
        min_coast_distance_nm: float,
    ) -> RouteIQRoute:
        """`POST /route`. Raises :class:`RouteIQUnavailable`,
        :class:`RouteIQUnreachable`, or :class:`RouteIQNotFound` — never
        returns `None`, unlike chartcore's own `find_route`, so a caller
        must catch these rather than null-check."""
        if not self._base_url:
            raise RouteIQUnavailable(
                "SignalK is not configured on this server, so there is no "
                "RouteIQ instance to ask"
            )
        if not self._token:
            raise RouteIQUnavailable(
                "no RouteIQ access token configured — request access first "
                "(Settings → Routes → Engine options)"
            )
        body = {
            "start": {"latitude": from_lat, "longitude": from_lon},
            "end": {"latitude": to_lat, "longitude": to_lon},
            "draft": draft_m,
            "beam": beam_m,
            "airDraft": air_draft_m,
            "minCoastDistance": min_coast_distance_nm,
        }
        url = f"{self._base_url}{_ROUTE_PATH}"
        try:
            with httpx.Client(timeout=self._timeout) as http:
                response = http.post(
                    url, json=body, headers={"Authorization": f"Bearer {self._token}"}
                )
        except httpx.HTTPError as e:
            raise RouteIQUnreachable(f"RouteIQ at {url} did not answer: {e}") from e

        if response.status_code in (401, 403):
            raise RouteIQUnreachable(
                "RouteIQ refused this request — the access token may have "
                "been revoked; request access again (Settings → Routes → Engine options)"
            )
        if response.status_code == 503:
            raise RouteIQUnreachable("RouteIQ's routing engine is still initializing")
        if response.status_code == 422:
            code = _error_code(response)
            if code == "ROUTE_NOT_FOUND":
                raise RouteIQNotFound("RouteIQ found no route for this request")
            raise RouteIQUnreachable(
                f"RouteIQ rejected this request: {code or response.text[:200]}"
            )
        if response.status_code != 200:
            raise RouteIQUnreachable(f"RouteIQ answered with HTTP {response.status_code}")

        try:
            payload = response.json()
        except ValueError as e:
            raise RouteIQUnreachable("RouteIQ's reply was not JSON") from e
        if not isinstance(payload, dict):
            raise RouteIQUnreachable("RouteIQ's reply was not a JSON object")
        route = _to_route(payload)
        if not route.waypoints:
            # A 200 with no usable geometry is functionally the same as
            # ROUTE_NOT_FOUND to a caller — treat it that way rather than
            # handing back a route with nothing to draw.
            raise RouteIQNotFound("RouteIQ's reply carried no route geometry")
        return route


def _error_code(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    if isinstance(body, dict):
        code = body.get("code") or body.get("error")
        return str(code) if code else None
    return None


def _to_route(payload: dict[str, Any]) -> RouteIQRoute:
    """`RouteResult` (signalk-routeiq's own wire shape, `src/types.ts`) ->
    `RouteIQRoute`.

    Waypoints are built from `features[*].geometry` (every `LineString`
    feature, in order, concatenated) — the one field `RouteResult`
    guarantees present (`waypoints`/`itinerary` are optional, richer
    fields this module does not need). A shared point between two
    consecutive LineString features is de-duplicated, the same "the seam
    is exactly one point, not a gap or a double" rule
    `mivnav.features.routing.routes._stitch_macro_route` already applies
    to chartcore's own multi-leg stitching.

    `totalDistance` is read as METRES — the natural unit for a
    GeoJSON-shaped routing API and what every comparable engine
    (OSRM/GraphHopper/etc.) reports, but not directly confirmed against a
    real successful RouteIQ response (no request during development ever
    landed inside its own covered test regions — see the module
    docstring). Worth double-checking the first time a real route
    succeeds; a wrong unit here would misreport `distance_nm`, not
    silently misroute (the geometry itself is unaffected)."""
    waypoints: list[tuple[float, float]] = []
    features = payload.get("features")
    if isinstance(features, list):
        for feat in features:
            if not isinstance(feat, dict):
                continue
            geometry = feat.get("geometry")
            if not isinstance(geometry, dict) or geometry.get("type") != "LineString":
                continue
            coords = geometry.get("coordinates")
            if not isinstance(coords, list):
                continue
            pts = [
                (float(c[0]), float(c[1]))
                for c in coords
                if isinstance(c, list) and len(c) >= 2
            ]
            if not pts:
                continue
            if waypoints and waypoints[-1] == pts[0]:
                pts = pts[1:]
            waypoints.extend(pts)

    distance_m = payload.get("totalDistance")
    distance_m = float(distance_m) if isinstance(distance_m, (int, float)) else 0.0

    warnings: list[str] = []
    warnings_raw = payload.get("warnings")
    if isinstance(warnings_raw, list):
        for w in warnings_raw:
            if isinstance(w, dict) and isinstance(w.get("message"), str):
                warnings.append(w["message"])
            elif isinstance(w, str):
                warnings.append(w)

    n = max(len(waypoints) - 1, 0)
    return RouteIQRoute(
        waypoints=waypoints,
        distance_m=distance_m,
        approximate_legs=[False] * n,
        warnings=warnings,
    )
