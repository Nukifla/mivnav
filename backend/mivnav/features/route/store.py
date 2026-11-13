# SPDX-License-Identifier: GPL-2.0-only
"""Sailing routes and the active leg: boat data, stored **on SignalK**, not
``routes.json`` (#vozswkrl). Offline, a write raises 503 rather than
queuing; the ACTIVE route stays in memory. See docs/architecture/route-storage-signalk.md."""

from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

log = logging.getLogger(__name__)

MAX_NAME_LENGTH = 64
MAX_ID_LENGTH = 64
MAX_ROUTES = 200
MAX_WAYPOINTS = 500

# Boat-wide, persisted with the route (a fact about the passage, not the
# device that drew it). Bounded because a value above the max is a typo.
DEFAULT_PLAN_SPEED_KN = 5.0
MAX_PLAN_SPEED_KN = 100.0

# URL-safe, bounded path segment (this API's and SignalK's). ``:`` is
# allowed so mivnav can READ SignalK ids like ``urn:mrn:signalk:uuid:<uuid>``
# (#vozswkrl); ``.`` stays refused so ``..`` can never reach a URL.
_ID_RE = re.compile(r"^[A-Za-z0-9_:-]{1,%d}$" % MAX_ID_LENGTH)

# ``PUT /routes/active`` would collide with a route literally named
# "active" — refused so the API has no word it cannot round-trip.
_RESERVED_IDS = frozenset({"active"})


class RouteError(Exception):
    """An invalid route id or body."""


class RouteConflict(Exception):
    """A conditional write lost a race — the route has been changed by
    someone else since the caller read it."""


class RouteStorageUnavailable(Exception):
    """SignalK — the only place routes live — could not be reached, or
    refused the read/write. Distinct from :class:`RouteError`: the same
    request would succeed with the box up. The API answers it **503**."""


class RouteResources(Protocol):
    """The slice of SignalK's Resources API a route store needs. A Protocol
    so tests can drive it without a socket and this module needs no import
    of the HTTP client."""

    def list_route_resources(self) -> dict[str, Any]: ...

    def put_route_resource(self, route_id: str, resource: dict[str, Any]) -> None: ...

    def delete_route_resource(self, route_id: str) -> bool: ...


class Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Waypoint(Frozen):
    """One point on a route. ``id`` is stable for the life of the waypoint:
    it is what the active leg points at, so it must survive a rename or a
    reorder."""

    id: str
    name: str = Field(default="", max_length=MAX_NAME_LENGTH)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    #: Was the LEG ARRIVING at this waypoint (the previous waypoint to
    #: this one) a straight-line stand-in `POST /routing/plan` could not
    #: actually verify — `PlanResponse.approximate_legs[i-1]` for this
    #: waypoint's own index `i` (the autorouting plugin's `routes.py`)?
    #: Always `False` for a route's first waypoint (no incoming leg) and
    #: for any waypoint a person placed by hand (the route editor never
    #: sets this — only `features/route/index.ts`'s `routeFromPlan`
    #: does). #owqqcdqe, 2026-08-10: this used to be a frontend-only,
    #: in-memory signal — real, but gone the moment the page reloaded or
    #: the route was reopened later, so a genuinely-flagged "this is a
    #: guess, verify manually" stretch silently started rendering as an
    #: ordinary, fully-trusted route leg with nothing left to tell a
    #: sailor it was ever a guess. Persisting it here is what keeps the
    #: warning honest for the life of the route, not just the one
    #: session that planned it.
    approximate: bool = False
    #: Was this point a stop the mariner actually chose — From/a stop/To,
    #: set via search, "use boat position", or "choose on map" — as
    #: opposed to a bend the router inserted while routing between two
    #: stops? Persisted so a reopened route can rebuild its From/Stop.../To
    #: list (`frontend/src/features/route/index.ts`'s `draftStops`)
    #: without guessing which points were ever deliberately chosen.
    #: Defaults `False` so a route saved before this field existed (or one
    #: whose every waypoint really was a router bend) reads as having no
    #: stops rather than raising or silently mis-tagging one.
    stop: bool = False


class Route(Frozen):
    """An ordered list of waypoints, plus server-owned fields: a client may
    echo ``rev``/``updated`` back but the server sets them and never reads
    them from a body. ``rev`` is the concurrency token, see :meth:`RouteStore.save`."""

    id: str
    name: str = Field(default="", max_length=MAX_NAME_LENGTH)
    waypoints: list[Waypoint] = Field(default_factory=list, max_length=MAX_WAYPOINTS)
    plan_speed_kn: float = Field(default=DEFAULT_PLAN_SPEED_KN, gt=0, le=MAX_PLAN_SPEED_KN)
    #: Planned departure, ISO 8601 UTC (``2026-11-06T09:30:00Z``), or None for
    #: "leave now" — the leg table counts its ETAs from it.
    depart_at: str | None = None
    rev: int = 0
    updated: float = 0.0

    @field_validator("depart_at")
    @classmethod
    def _utc_instant(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = parse_depart_at(value)
        if parsed is None:
            raise ValueError(
                "depart_at must be an ISO 8601 time with a timezone, e.g. 2026-11-06T09:30:00Z"
            )
        return parsed


class ActiveLeg(Frozen):
    """What the boat is following: a route, and the waypoint ``GO`` selected.
    No ``mode`` field (#yprzuqtt) — SignalK derives the target/line
    distinction from the waypoint's index alone; see docs/architecture/route-storage-signalk.md."""

    route_id: str
    waypoint_id: str


def parse_depart_at(value: object) -> str | None:
    """``value`` as a canonical UTC ``YYYY-MM-DDTHH:MM:SSZ``, or None if it is
    not an ISO 8601 instant with a timezone (a naive time has no instant)."""
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_id(route_id: str) -> str:
    route_id = route_id.strip()
    if not _ID_RE.match(route_id):
        raise RouteError(
            "route id must be 1-%d characters of [A-Za-z0-9_:-] (it is a URL "
            "path segment); mint a uuid" % MAX_ID_LENGTH
        )
    if route_id in _RESERVED_IDS:
        raise RouteError(f"route id {route_id!r} is reserved by the API")
    return route_id


def parse_route(route_id: str, body: Any) -> Route:
    """A validated :class:`Route` from an untrusted body. The id comes from
    the path, not the body — a body with a *contradicting* id is a client
    bug worth surfacing rather than silently resolving."""
    route_id = validate_id(route_id)
    if not isinstance(body, dict):
        raise RouteError("a route must be a JSON object")
    body = dict(body)
    given = body.pop("id", None)
    if given is not None and str(given).strip() != route_id:
        raise RouteError(f"route id in the body ({given!r}) does not match the path ({route_id!r})")
    # Server-owned: accepted for round-tripping but never read.
    body.pop("rev", None)
    body.pop("updated", None)
    try:
        route = Route(id=route_id, **body)
    except ValidationError as e:
        raise RouteError(_first_error(e)) from e
    except TypeError as e:  # non-string keys, etc.
        raise RouteError(f"invalid route: {e}") from e
    ids = [w.id for w in route.waypoints]
    for wid in ids:
        if not _ID_RE.match(wid.strip()):
            raise RouteError(f"waypoint id {wid!r} must be 1-{MAX_ID_LENGTH} characters of [A-Za-z0-9_:-]")
    if len(set(ids)) != len(ids):
        # Duplicates would make "which waypoint" unanswerable for the active leg.
        raise RouteError("waypoint ids must be unique within a route")
    return route


def _first_error(e: ValidationError) -> str:
    err = e.errors()[0]
    where = ".".join(str(p) for p in err["loc"]) or "route"
    return f"{where}: {err['msg']}"


class RouteStore:
    """Routes on SignalK, mirrored in memory, plus the active leg. Deliberately
    **not** a :class:`~mivnav.config.derived.Derived`: it holds state that
    must survive a config change, which a Derived would throw away."""

    def __init__(self, resources: Callable[[], RouteResources | None] | None = None) -> None:
        self._resources = resources or (lambda: None)
        # In-memory only — NEVER held across an HTTP round trip: `list()`
        # runs on the SignalK delta-listener thread and a publish timeout
        # must not be able to stall it.
        self._lock = threading.Lock()
        # Serialises writers against each other (read-modify-write of `rev`);
        # readers never touch it.
        self._write_lock = threading.RLock()
        self._routes: dict[str, Route] = {}
        self._active: ActiveLeg | None = None

    def list(self) -> list[Route]:
        """Every route in the mirror, newest-saved first. No I/O — call
        :meth:`refresh` when freshness matters."""
        with self._lock:
            return self._sorted()

    def get(self, route_id: str) -> Route | None:
        with self._lock:
            return self._routes.get(route_id.strip())

    def active(self) -> ActiveLeg | None:
        with self._lock:
            return self._active

    def snapshot(self) -> tuple[list[Route], ActiveLeg | None]:
        """Routes and the active leg as of one instant — one lock
        acquisition, so a client is never handed an active leg that points
        into a route list it was not shown alongside."""
        with self._lock:
            return self._sorted(), self._active

    def _sorted(self) -> list[Route]:
        """Caller holds the lock."""
        return sorted(self._routes.values(), key=lambda r: (-r.updated, r.name.lower(), r.id))

    def refresh(self) -> list[Route]:
        """Re-read every route from SignalK into the mirror; a resource that
        cannot be read as a route is skipped, not fatal. Blocking HTTP —
        never call from the SignalK listener thread."""
        from mivnav.features.route.wire import from_resource

        resources = self._require()
        try:
            listing = resources.list_route_resources()
        except Exception as e:  # noqa: BLE001 — one class out, whatever came in
            raise RouteStorageUnavailable(
                f"could not read the routes from SignalK: {e}"
            ) from e
        fetched: dict[str, Route] = {}
        for route_id, resource in listing.items():
            route = from_resource(str(route_id), resource)
            if route is not None:
                fetched[route.id] = route
        with self._lock:
            self._routes = fetched
            self._settle_active()
            return self._sorted()

    def save(self, route_id: str, body: Any, if_match: int | None = None) -> Route:
        """Create or replace a route on SignalK; the mirror updates only
        after the box has taken it. ``if_match`` opts into optimistic
        locking against the MIRROR's rev — see docs/architecture/route-storage-signalk.md."""
        from mivnav.features.route.wire import to_resource

        route = parse_route(route_id, body)
        resources = self._require()
        with self._write_lock:
            with self._lock:
                existing = self._routes.get(route.id)
                if if_match is not None:
                    seen = existing.rev if existing else None
                    if seen != if_match:
                        raise RouteConflict(
                            f"route {route.id!r} has moved on (rev {seen}, you have {if_match}); "
                            "re-read it and re-apply your change"
                        )
                if existing is None and len(self._routes) >= MAX_ROUTES:
                    raise RouteError(f"at most {MAX_ROUTES} routes")
            route = route.model_copy(
                update={
                    "rev": (existing.rev + 1) if existing else 1,
                    "updated": time.time(),
                }
            )
            try:
                resources.put_route_resource(route.id, to_resource(route))
            except Exception as e:  # noqa: BLE001
                raise RouteStorageUnavailable(
                    f"SignalK did not store route {route.id!r}, so it is NOT saved: {e}"
                ) from e
            with self._lock:
                self._routes[route.id] = route
                self._settle_active()
            return route

    def delete(self, route_id: str, if_match: int | None = None) -> bool:
        route_id = route_id.strip()
        resources = self._require()
        with self._write_lock:
            with self._lock:
                existing = self._routes.get(route_id)
                if if_match is not None and (existing.rev if existing else None) != if_match:
                    raise RouteConflict(
                        f"route {route_id!r} has moved on; re-read it before deleting"
                    )
            try:
                deleted = resources.delete_route_resource(route_id)
            except Exception as e:  # noqa: BLE001
                raise RouteStorageUnavailable(
                    f"SignalK did not delete route {route_id!r}, so it is NOT deleted: {e}"
                ) from e
            with self._lock:
                had_it = self._routes.pop(route_id, None) is not None
                self._settle_active()
            return deleted or had_it

    def set_active(self, active: ActiveLeg | None) -> ActiveLeg | None:
        """Press (or clear) ``GO``. In memory only, no I/O; the caller's next
        SignalK publish (:mod:`mivnav.features.route.publish`) persists it.
        Last-write-wins, unlike :meth:`save`: one deliberate helm act."""
        with self._lock:
            if active is not None:
                route = self._routes.get(active.route_id)
                if route is None:
                    raise RouteError(f"unknown route {active.route_id!r}")
                if not any(w.id == active.waypoint_id for w in route.waypoints):
                    raise RouteError(
                        f"route {active.route_id!r} has no waypoint {active.waypoint_id!r}"
                    )
            self._active = active
            return self._active

    def _settle_active(self) -> None:
        """Drop an active leg that no longer addresses a real waypoint
        (caller holds the lock) — invariant #8: never silently pick a
        replacement waypoint for a gone one."""
        if self._active is None:
            return
        route = self._routes.get(self._active.route_id)
        if route is None or not any(w.id == self._active.waypoint_id for w in route.waypoints):
            log.info(
                "clearing the active leg: %s/%s no longer exists",
                self._active.route_id,
                self._active.waypoint_id,
            )
            self._active = None

    def _require(self) -> RouteResources:
        resources = self._resources()
        if resources is None:
            raise RouteStorageUnavailable(
                "SignalK is disabled in this server's configuration, and it is "
                "the only place routes are stored"
            )
        return resources
