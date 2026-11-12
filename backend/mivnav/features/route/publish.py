# SPDX-License-Identifier: GPL-2.0-only
"""Tell SignalK about the boat's followed route — register it, once, or step
it on by one point.

Two entry points, deliberately NOT one: :func:`publish_active_leg` is the
FULL publish (activate the route at a waypoint's index, or clear it), called
on every human decision (GO, Stop, a mid-follow edit) and when auto-advance
completes a route; :func:`advance_active_route` is the LIGHTWEIGHT step an
arrival uses — one PUT that moves an already-active SignalK route on by a
point, no registration, no waypoint resolution, no position of any kind,
because SignalK derives the new leg from the route resource the full
publish already registered. See docs/architecture/signalk-course-publish.md
for the fuller history (why not one entry point, #vozswkrl/#yprzuqtt) and
for the swallowed-failure design (#zsswlmpz): every failure here is caught
and never raised at the caller (the store write already succeeded), but
every failure is now logged with a traceback and reported back as a
:class:`PublishResult`, never silently dropped.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, cast

from mivnav.features.route.client import CourseClient
from mivnav.features.route.store import ActiveLeg, Route

if TYPE_CHECKING:
    from mivnav.api.deps import Runtime
    from mivnav.features.route.runtime import RouteRuntime

log = logging.getLogger(__name__)

#: What a publish attempt did: published/cleared/advanced (worked),
#: skipped (SignalK disabled/no token — not a failure), or failed (an
#: attempt was made and did not reach the box; always logged with a traceback).
Outcome = Literal["published", "cleared", "advanced", "skipped", "failed"]


@dataclass(frozen=True)
class PublishResult:
    """The outcome of one publish attempt. ``detail`` is a human sentence,
    not a code — the same text the log carries, so a test asserting on it
    asserts on what a sailor would be shown if this were ever surfaced."""

    outcome: Outcome
    detail: str = ""

    @property
    def failed(self) -> bool:
        return self.outcome == "failed"


def _client_or_skip(runtime: Runtime) -> CourseClient | PublishResult:
    """The Course client to publish through, or a ``skipped``
    :class:`PublishResult` if publishing is pointless right now — shared
    gate for both entry points below. Reads the SignalK config/token live,
    so a token added without a restart takes effect on the next GO."""
    config = runtime.config.get()
    if not config.signalk.enabled:
        return PublishResult("skipped", "SignalK is disabled in this server's configuration")
    if not config.credentials.signalk.token.get_secret_value():
        # No token → skip rather than earn a 401 on every GO; the read path
        # (the delta stream) needs no token.
        return PublishResult("skipped", "no SignalK token is configured, so nothing can be written")
    return cast("RouteRuntime", runtime.feature("route")).course()


def publish_active_leg(runtime: Runtime, active_leg: ActiveLeg | None) -> PublishResult:
    """Register ``active_leg``'s whole route with SignalK and activate it at
    that waypoint, or clear the course. Call it *after* the store's active
    leg has settled and *outside* any store lock — it does blocking HTTP
    round trips. Never raises; the returned :class:`PublishResult` is the
    only report.
    """
    client = _client_or_skip(runtime)
    if isinstance(client, PublishResult):
        return client
    try:
        if active_leg is None:
            client.clear_destination()
            log.info("cleared the SignalK course (GO stopped)")
            return PublishResult("cleared", "cleared the SignalK course")
        resolved = _resolve_leg(runtime, active_leg)
        if resolved is None:
            # Settled to a real waypoint under the store lock, but gone by
            # the time we resolve it here (a concurrent edit) — do not
            # publish a phantom.
            detail = (
                f"{active_leg.route_id}/{active_leg.waypoint_id} no longer "
                "resolves to a waypoint"
            )
            log.warning("not publishing course: %s", detail)
            return PublishResult("failed", detail)
        route, idx = resolved
        # No resource registration here any more (#vozswkrl): the route IS
        # already a SignalK resource (saving it put it on the box), so a
        # publish only has to say which one, and where on it.
        client.activate_route(route.id, idx)
        detail = (
            f"published the SignalK course for {active_leg.route_id}/"
            f"{active_leg.waypoint_id} (point {idx} of {len(route.waypoints)})"
        )
        log.info("%s", detail)
        return PublishResult("published", detail)
    except Exception as e:  # noqa: BLE001 — a GO must never fail on its side effect
        # A GO already succeeded; a failed publish must not unwind it, but
        # must not vanish either (#zsswlmpz) — `exception` logs the traceback.
        log.exception("could not publish the SignalK course")
        return PublishResult("failed", str(e) or e.__class__.__name__)


def advance_active_route(runtime: Runtime) -> PublishResult:
    """Step the already-active SignalK route on by one point. The lightweight
    arrival reaction (:mod:`mivnav.features.route.watcher`) — no store read,
    no waypoint resolution, no position: SignalK derives the new leg
    entirely from the route resource :func:`publish_active_leg` already
    registered. Callers are responsible for having confirmed SignalK's
    reported course still matches mivnav's leg and that this is not the
    route's last point; this function only issues the PUT.
    """
    client = _client_or_skip(runtime)
    if isinstance(client, PublishResult):
        return client
    try:
        client.advance_next_point()
        log.info("advanced the SignalK course to its next point (arrival)")
        return PublishResult("advanced", "advanced the SignalK course to its next point")
    except Exception as e:  # noqa: BLE001 — an arrival must never fail on its side effect
        # The watcher thread has no HTTP caller to report to — the log IS
        # the surface here.
        log.exception("could not advance the SignalK course on arrival")
        return PublishResult("failed", str(e) or e.__class__.__name__)


def _resolve_leg(runtime: Runtime, active_leg: ActiveLeg) -> tuple[Route, int] | None:
    """The active waypoint's route and its index on it, or None if gone."""
    route = runtime.routes.get(active_leg.route_id)
    if route is None:
        return None
    for idx, waypoint in enumerate(route.waypoints):
        if waypoint.id == active_leg.waypoint_id:
            return route, idx
    return None
