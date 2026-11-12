# SPDX-License-Identifier: GPL-2.0-only
"""Publish the followed route over SignalK's v2 Course/Resources APIs.

Sibling of `mivnav.features.autopilot.client`, same reasoning. See
docs/architecture/signalk-course-client.md for the wire-contract
provenance, the three-verb registration/activation split, and current
verification status against a live box.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

#: Same tight one-attempt budget and reasoning as the autopilot client.
PUBLISH_TIMEOUT = 4.0


class CourseError(Exception):
    """The course update did not reach SignalK, or SignalK refused it.

    One class, not the autopilot client's four: every caller logs and
    swallows every failure the same way, so splitting them would be
    ceremony.
    """


class CourseClient:
    """The v2 Course/Resources APIs, as far as this app writes to them.

    Pure of config, like `AutopilotClient` (see there for why not a `Derived`).
    Two base URLs: `course_url` and `resources_url` are different REST roots.
    """

    def __init__(
        self,
        course_url: str | None,
        resources_url: str | None,
        token: str | None,
        *,
        timeout: float = PUBLISH_TIMEOUT,
    ) -> None:
        self._course_url = course_url.rstrip("/") if course_url else None
        self._resources_url = resources_url.rstrip("/") if resources_url else None
        self._token = token or None
        self._timeout = timeout

    # -- the resource store (jt vozswkrl) — route persistence lives in
    # SignalK now; this client knows the verbs and URLs, nothing about
    # what a route means (see mivnav.features.route.wire for the shape).

    def list_route_resources(self) -> dict[str, Any]:
        """Every route resource on the box, `{id: resource}`. Includes
        routes drawn in OTHER apps — that's the point (jt vozswkrl)."""
        payload = self._resources_json("GET", "/routes")
        return payload if isinstance(payload, dict) else {}

    def get_route_resource(self, route_id: str) -> dict[str, Any] | None:
        """One route resource, or `None` if the box does not have it."""
        return self._resources_json("GET", f"/routes/{route_id}", missing_ok=True)

    def put_route_resource(self, route_id: str, resource: dict[str, Any]) -> None:
        """Create or replace one route resource. Idempotent by id, so
        mivnav's client-minted uuid can be the SignalK resource id
        unchanged, with no id mapping to keep."""
        self._resources_request("PUT", f"/routes/{route_id}", resource)

    def delete_route_resource(self, route_id: str) -> bool:
        """Delete one route resource; `False` if the box did not have it."""
        response = self._send_resources("DELETE", f"/routes/{route_id}", None, missing_ok=True)
        return response is not None

    # -- standalone waypoints: the `marks` feature's store, same verbs.

    def list_waypoint_resources(self) -> dict[str, Any]:
        """Every waypoint resource on the box, `{id: resource}` — including
        ones other apps placed."""
        payload = self._resources_json("GET", "/waypoints")
        return payload if isinstance(payload, dict) else {}

    def put_waypoint_resource(self, waypoint_id: str, resource: dict[str, Any]) -> None:
        """Create or replace one waypoint resource, idempotent by id."""
        self._resources_request("PUT", f"/waypoints/{waypoint_id}", resource)

    def delete_waypoint_resource(self, waypoint_id: str) -> bool:
        """Delete one waypoint resource; `False` if the box did not have it."""
        response = self._send_resources("DELETE", f"/waypoints/{waypoint_id}", None, missing_ok=True)
        return response is not None

    def activate_route(self, route_id: str, point_index: int) -> None:
        """Start (or re-point) following at `point_index`. `reverse` is always
        `False` — mivnav reverses routes by reordering its own waypoints,
        never via this flag, which would desync `point_index`."""
        self._request(
            "PUT",
            "/activeRoute",
            {"href": f"/resources/routes/{route_id}", "pointIndex": point_index, "reverse": False},
        )

    def advance_next_point(self) -> None:
        """Step the active route on by one point; no position of any kind
        (see docs/architecture/signalk-course-client.md for why). Raises
        if nothing is active — callers check first (route.watcher)."""
        self._request("PUT", "/activeRoute/nextPoint", {})

    def clear_destination(self) -> None:
        """Stop following: `DELETE` on the course root (not
        `/destination`), which resets the whole course state including
        `activeRoute`."""
        self._request("DELETE", "")

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> None:
        if not self._course_url:
            raise CourseError(
                "SignalK is disabled in this server's configuration, so there "
                "is no course to publish"
            )
        self._send(method, f"{self._course_url}{path}", body)

    def _resources_request(self, method: str, path: str, body: dict[str, Any] | None = None) -> None:
        self._send_resources(method, path, body)

    def _resources_json(
        self, method: str, path: str, *, missing_ok: bool = False
    ) -> dict[str, Any] | None:
        """A resources request whose answer is the point. `missing_ok`
        turns a 404 into `None` — "the box doesn't have this route"."""
        response = self._send_resources(method, path, None, missing_ok=missing_ok)
        return _json(response) if response is not None else None

    def _send_resources(
        self, method: str, path: str, body: dict[str, Any] | None, *, missing_ok: bool = False
    ) -> httpx.Response | None:
        if not self._resources_url:
            raise CourseError(
                "SignalK is disabled in this server's configuration, so there "
                "is no resource store to read or write"
            )
        return self._send(method, f"{self._resources_url}{path}", body, missing_ok=missing_ok)

    def _send(
        self,
        method: str,
        url: str,
        body: dict[str, Any] | None = None,
        *,
        missing_ok: bool = False,
    ) -> httpx.Response | None:
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            with httpx.Client(timeout=self._timeout) as http:
                response = http.request(method, url, json=body, headers=headers)
        except httpx.HTTPError as e:
            raise CourseError(f"the SignalK server at {url} did not answer {method}: {e}") from e

        if missing_ok and response.status_code == 404:
            return None

        # Body's verdict outranks HTTP status (v2 REST answers a refusal
        # with its own statusCode even under a 200). Every message names
        # the verb and URL — see docs/architecture/signalk-course-client.md.
        payload = _json(response)
        if isinstance(payload, dict) and payload.get("state") == "FAILED":
            raise CourseError(
                f"SignalK refused {method} {url}: "
                f"{payload.get('message') or 'no message given'}"
            )
        if response.status_code >= 400:
            detail = (payload or {}).get("message") if isinstance(payload, dict) else None
            raise CourseError(
                f"SignalK refused {method} {url} (HTTP {response.status_code}): "
                f"{detail or response.text.strip()[:200] or 'no message given'}"
            )
        return response


def _json(response: httpx.Response) -> dict[str, Any] | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None
