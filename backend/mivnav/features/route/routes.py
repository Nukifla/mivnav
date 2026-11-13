# SPDX-License-Identifier: GPL-2.0-only
"""/routes — the boat's sailing routes and the leg it is following, and the
``FEATURE`` registration. See docs/architecture/routes-api-design.md for
the naming, SignalK-storage, PUT-vs-PATCH and concurrency rationale.

::

    GET    /routes            every route, plus the active leg
    GET    /routes/{id}       one route          (ETag: its rev)
    PUT    /routes/{id}       save (create or replace), If-Match: rev
    DELETE /routes/{id}       delete, If-Match: rev
    PUT    /routes/active     press or clear GO
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Response

from mivnav.api.deps import Runtime, get_runtime
from mivnav.feature import Feature
from mivnav.features.route.provider import route_data_provider
from mivnav.features.route.publish import publish_active_leg
from mivnav.features.route.runtime import RouteRuntime, build_route_runtime
from mivnav.features.route.store import (
    ActiveLeg,
    Route,
    RouteConflict,
    RouteError,
    RouteStorageUnavailable,
)

log = logging.getLogger(__name__)

__all__ = ["FEATURE", "router"]

router = APIRouter(prefix="/routes")


def _parse_if_match(if_match: str | None) -> int | None:
    """``If-Match: "3"`` → ``3``. Absent → None (last-write-wins), ``*`` too
    (HTTP's "any current representation"). A malformed value is refused so a
    typoed guard is never told it succeeded.
    """
    if if_match is None or if_match.strip() == "*":
        return None
    token = if_match.strip().strip("W/").strip('"')
    try:
        return int(token)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"If-Match must be a route rev, e.g. If-Match: \"3\" (got {if_match!r})",
        ) from None


def _etag(route: Route) -> str:
    return f'"{route.rev}"'


@router.get("")
def list_routes(runtime: Runtime = Depends(get_runtime)) -> dict:
    """Every route and the active leg, from one consistent snapshot — a
    client must never be handed an active leg pointing into a route list it
    was not shown alongside. Unlike a save, a read does not refuse when
    SignalK is unreachable: it serves the in-memory mirror, stale: true.
    """
    stale = False
    before = runtime.routes.active()
    try:
        runtime.routes.refresh()
    except RouteStorageUnavailable as e:
        stale = True
        log.warning("serving routes from memory: %s", e)
    else:
        # Another Signal K client deleted the followed route (or its target
        # point): the refresh dropped the leg, so drop the course too.
        _clear_if_dropped(runtime, before, "a refresh from Signal K")
    routes, active = runtime.routes.snapshot()
    return {
        "routes": [r.model_dump(mode="json") for r in routes],
        "active": active.model_dump(mode="json") if active else None,
        "stale": stale,
    }


@router.put("/active")
def put_active(
    active: ActiveLeg | None = Body(default=None),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """Press GO on a waypoint, or send ``null`` to stop following.

    Nothing here advances the leg, and nothing else may on its own say-so
    (invariant #8). See docs/architecture/routes-api-design.md for the
    single-publish-to-SignalK rationale (autopilot hands-off steering).
    """
    try:
        settled = runtime.routes.set_active(active)
    except RouteError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    published = publish_active_leg(runtime, settled)
    # `publish` is additive: the store write above stands either way, but a
    # client must be able to tell the helm that SignalK (so the autopilot)
    # was NOT told — outcome "failed".
    return {
        "active": settled.model_dump(mode="json") if settled else None,
        "publish": {"outcome": published.outcome, "detail": published.detail},
    }


def _clear_if_dropped(runtime: Runtime, before: ActiveLeg | None, what: str) -> None:
    """A save/delete that made the store drop the followed leg
    (``_settle_active``) must clear SignalK's course too, or the autopilot
    keeps steering a route mivnav says is not followed."""
    if before is None or runtime.routes.active() is not None:
        return
    try:
        cleared = publish_active_leg(runtime, None)
    except Exception:  # noqa: BLE001 — a save/delete must never fail on its side effect
        log.exception("clearing the SignalK course after %s failed", what)
        return
    if cleared.failed:
        log.warning(
            "%s stopped following %s/%s, but SignalK's course could not be cleared: %s",
            what,
            before.route_id,
            before.waypoint_id,
            cleared.detail,
        )


@router.get("/{route_id}")
def get_route(
    route_id: str, response: Response, runtime: Runtime = Depends(get_runtime)
) -> dict:
    route = runtime.routes.get(route_id)
    if route is None:
        raise HTTPException(status_code=404, detail=f"unknown route {route_id!r}")
    response.headers["ETag"] = _etag(route)
    return route.model_dump(mode="json")


@router.put("/{route_id}")
def put_route(
    route_id: str,
    response: Response,
    body: dict[str, Any] = Body(...),
    if_match: str | None = Header(default=None, alias="If-Match"),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """Save a route under ``route_id``, creating or replacing it.

    The id is the client's to mint (a uuid); PUT is idempotent so a retry on
    the boat's flaky wifi cannot leave two copies behind. ``rev``/``updated``
    in the body are ignored. If the boat is following this route, the edit
    is re-published to SignalK — see docs/architecture/routes-api-design.md.
    """
    before = runtime.routes.active()
    try:
        route = runtime.routes.save(route_id, body, if_match=_parse_if_match(if_match))
    except RouteConflict as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except RouteError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except RouteStorageUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    active = runtime.routes.active()
    if active is not None and active.route_id == route.id:
        # Belt-and-braces over publish_active_leg's own swallowing (now total
        # as of #zsswlmpz) — kept as the guard that caught the
        # non-CourseError escape #zsswlmpz found.
        try:
            publish_active_leg(runtime, active)
        except Exception:  # noqa: BLE001 — a save must never fail on its side effect
            log.exception("re-publishing the edited active route %s to SignalK failed", route.id)
    else:
        _clear_if_dropped(runtime, before, f"saving route {route.id!r}")
    response.headers["ETag"] = _etag(route)
    return route.model_dump(mode="json")


@router.delete("/{route_id}")
def delete_route(
    route_id: str,
    if_match: str | None = Header(default=None, alias="If-Match"),
    runtime: Runtime = Depends(get_runtime),
) -> Response:
    """Delete a route. If the boat was following it, it stops following
    it — see RouteStore._settle_active — and SignalK's course is cleared."""
    before = runtime.routes.active()
    try:
        deleted = runtime.routes.delete(route_id, if_match=_parse_if_match(if_match))
    except RouteConflict as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except RouteStorageUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    _clear_if_dropped(runtime, before, f"deleting route {route_id!r}")
    if not deleted:
        raise HTTPException(status_code=404, detail=f"unknown route {route_id!r}")
    return Response(status_code=204)


FEATURE: Feature[RouteRuntime] = Feature(
    id="route",
    routers=(router,),
    build_runtime=build_route_runtime,
    data_provider=route_data_provider,
)
