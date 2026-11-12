# SPDX-License-Identifier: GPL-2.0-only
"""React to SignalK: adopt an externally-set course, and advance the
followed route when SignalK says the boat has arrived (#svotsyyy,
#yprzuqtt) — gated by ``nav.course_sync``. See docs/architecture/signalk-course-sync.md.
"""

from __future__ import annotations

import logging
import queue
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from mivnav.features.route.geo import Point, haversine_m
from mivnav.features.route.publish import advance_active_route, publish_active_leg
from mivnav.features.route.store import ActiveLeg, Route

if TYPE_CHECKING:
    from mivnav.api.deps import Runtime
    from mivnav.features.route.config import NavConfig

log = logging.getLogger(__name__)

_SUBSCRIBE = "subscribe"
_RESUBSCRIBE = "resubscribe"
_ADOPT = "adopt"
_ARRIVED = "arrived"
_STOP = "stop"

#: Sentinel for "no course/arrival observed yet" — distinct from the real
#: legitimate values (``(None, None)``, ``False``), so the first observation
#: after start/resubscribe always reads as a change.
_NOT_OBSERVED: Any = object()

#: Comfortably past the Course client's ~4s publish timeout, so stop() always
#: outlasts a publish in flight (the worker is a daemon thread regardless).
_STOP_TIMEOUT = 10.0


class NavWatcher:
    """Owns one subscription to SignalK and one worker thread. Reads
    everything live off the runtime on each callback — a config edit or a
    GO takes effect on the next message, nothing cached."""

    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._worker: threading.Thread | None = None
        self._unsubscribe: Callable[[], None] | None = None
        # Guards the two edge-trigger sentinels below: last observed course
        # (adoption, #svotsyyy) and last observed arrival state (#yprzuqtt).
        # Both start `_NOT_OBSERVED` and reset on `_RESUBSCRIBE`.
        self._lock = threading.Lock()
        self._last_course: Any = _NOT_OBSERVED
        self._last_arrival: Any = _NOT_OBSERVED

    def start(self) -> None:
        """Start the worker and subscribe. Idempotent; safe to call once."""
        if self._worker is not None:
            return
        self._worker = threading.Thread(
            target=self._run, name="nav-watcher", daemon=True
        )
        self._worker.start()
        # Runs on the worker, not here: resolving the SignalK service can
        # build it (and join a reader thread on rebuild), which must never
        # happen on the caller's thread — at startup, the event loop.
        self._queue.put((_SUBSCRIBE, None))

    def stop(self) -> None:
        """Unsubscribe and stop the worker. Idempotent."""
        worker = self._worker
        if worker is None:
            return
        self._queue.put((_STOP, None))
        worker.join(timeout=_STOP_TIMEOUT)
        if worker.is_alive():
            log.warning("the nav watcher did not stop within %ss", _STOP_TIMEOUT)
        self._worker = None

    # runs on the SignalK thread

    def _on_message(self, message: dict[str, Any] | None) -> None:
        """Cheap comparisons, then enqueue — never blocks. Runs on the
        SignalK service thread (and, once, on the worker thread during the
        synchronous first delivery of subscribe)."""
        if message is None:
            # Service superseded (config change) — re-resolve on the worker,
            # which is allowed to block on the rebuild.
            self._queue.put((_RESUBSCRIBE, None))
            return

        config = self._runtime.config.get()
        nav = config.nav
        if not nav.course_sync:
            return  # both pieces below are course-sync's to gate; off = inert

        course = message.get("course")
        self._maybe_adopt_course(course, nav)

        arrival = message.get("arrival")
        self._maybe_react_to_arrival(arrival, course, nav)

    def _maybe_adopt_course(self, course: dict[str, Any] | None, nav: NavConfig) -> None:
        """Edge-triggered (#svotsyyy): adopt SignalK's course as the active
        leg when it CHANGES to one of mivnav's own waypoints. Never fires
        twice for the same value — avoids the vpxkyynv republish loop."""
        next_point = _course_point(course, "next")
        prev_point = _course_point(course, "previous")
        key = (next_point, prev_point)
        with self._lock:
            if key == self._last_course:
                return  # the same report as last frame — not a change
            self._last_course = key
        if next_point is None:
            return  # nothing (new) reported to adopt

        current = self._runtime.routes.active()
        match = _nearest_waypoint(self._runtime, next_point, nav.course_match_tolerance_m)
        if match is None:
            # No matching waypoint — deliberately NOT clearing the active
            # leg: an unmatched course is not mivnav's to act on.
            return
        route, idx = match
        wp = route.waypoints[idx]
        if current is not None and current.route_id == route.id and current.waypoint_id == wp.id:
            return  # already exactly this leg (our own echo, most likely)

        desired = ActiveLeg(route_id=route.id, waypoint_id=wp.id)
        self._queue.put((_ADOPT, (desired, current)))

    def _maybe_react_to_arrival(
        self, arrival: dict[str, Any] | None, course: dict[str, Any] | None, nav: NavConfig
    ) -> None:
        """Edge-triggered: react when SignalK's arrival notification becomes
        active — never on a repeat of "still arrived" (a 5 Hz stream would
        otherwise re-fire every frame). See the disagreement-gate check below."""
        entered = bool((arrival or {}).get("arrivalCircleEntered")) or bool(
            (arrival or {}).get("perpendicularPassed")
        )
        with self._lock:
            if entered == self._last_arrival:
                return  # not a change
            self._last_arrival = entered
        if not entered:
            return  # only the rising edge is actionable

        active = self._runtime.routes.active()
        if active is None:
            return  # nothing mivnav is following — not our notification

        route = self._runtime.routes.get(active.route_id)
        if route is None:
            return
        ids = [w.id for w in route.waypoints]
        try:
            idx = ids.index(active.waypoint_id)
        except ValueError:
            return  # active leg points at a waypoint no longer on the route

        # Disagreement gate: this notification is about whatever SignalK's
        # nextPoint currently is, which may belong to a course some OTHER
        # app set — only act if it still matches mivnav's own stored leg.
        target = route.waypoints[idx]
        next_point = _course_point(course, "next")
        if next_point is None or haversine_m(Point(target.lat, target.lon), next_point) > nav.course_match_tolerance_m:
            log.info(
                "ignoring an arrival notification: SignalK's course does not "
                "match the active leg %s/%s",
                active.route_id,
                active.waypoint_id,
            )
            return

        self._queue.put((_ARRIVED, active))

    # the worker: everything that can block

    def _run(self) -> None:
        while True:
            command, arg = self._queue.get()
            if command == _STOP:
                self._do_unsubscribe()
                return
            if command == _SUBSCRIBE:
                self._subscribe()
            elif command == _RESUBSCRIBE:
                self._do_unsubscribe()
                self._subscribe()
            elif command == _ADOPT:
                self._adopt(*arg)
            elif command == _ARRIVED:
                self._on_arrived(arg)

    def _subscribe(self) -> None:
        # A rebuilt connection owes nothing to what the old one last
        # reported — forget both edge-trigger sentinels so the fresh
        # subscription's first message reads as a change.
        with self._lock:
            self._last_course = _NOT_OBSERVED
            self._last_arrival = _NOT_OBSERVED
        # Fill the route mirror before the first message arrives (#vozswkrl):
        # `_nearest_waypoint` reads it from memory on the LISTENER thread,
        # where HTTP is forbidden, so this worker does the blocking read.
        try:
            self._runtime.routes.refresh()
        except Exception as e:  # noqa: BLE001 — a cold mirror is not fatal
            log.warning("could not load the routes from SignalK: %s", e)
        try:
            service = self._runtime.signalk()
            # subscribe() delivers the current snapshot synchronously, on
            # this worker thread; a resulting _on_message enqueue is fine —
            # the loop picks it up next.
            self._unsubscribe = service.subscribe(self._on_message)
        except Exception:  # noqa: BLE001 — a watcher fault must not crash the app
            log.exception("nav watcher could not subscribe to SignalK")
            self._unsubscribe = None

    def _do_unsubscribe(self) -> None:
        unsubscribe, self._unsubscribe = self._unsubscribe, None
        if unsubscribe is not None:
            try:
                unsubscribe()
            except Exception:  # noqa: BLE001
                log.exception("nav watcher unsubscribe failed")

    def _adopt(self, desired: ActiveLeg, expected_current: ActiveLeg | None) -> None:
        """Adopt ``desired`` as the active leg — a store write only, never a
        republish. Re-checks the store against what the listener saw, so a
        human GO landing in between is never clobbered."""
        try:
            current = self._runtime.routes.active()
            if current != expected_current:
                return  # the store moved on since the listener decided this
            settled = self._runtime.routes.set_active(desired)
            log.info(
                "adopted a SignalK course as the active leg: %s/%s",
                settled.route_id if settled else None,
                settled.waypoint_id if settled else None,
            )
        except Exception:  # noqa: BLE001 — never let a bad frame kill the worker
            log.exception("adopting a SignalK course failed for %s", desired)

    def _on_arrived(self, from_leg: ActiveLeg) -> None:
        """React to a confirmed arrival: step the followed route on by one
        point, or, at the last waypoint, stop following. Re-checks the store
        since the world may have moved since the listener enqueued this."""
        try:
            current = self._runtime.routes.active()
            if current != from_leg:
                # Someone changed GO, or this leg already moved on; stale.
                return
            route = self._runtime.routes.get(from_leg.route_id)
            if route is None:
                return
            ids = [w.id for w in route.waypoints]
            try:
                idx = ids.index(from_leg.waypoint_id)
            except ValueError:
                return
            if idx + 1 < len(route.waypoints):
                # Lightweight step: no store write, no position resolution.
                # The store's active leg catches up via `_maybe_adopt_course`
                # once SignalK echoes the new nextPoint.
                advanced = advance_active_route(self._runtime)
                if advanced.failed:
                    # #zsswlmpz: this is the ONLY report this call site has
                    # (an arrival has no HTTP caller) — must not say
                    # "advancing" about a PUT that never reached the box.
                    log.warning(
                        "a SignalK arrival at %s could NOT be advanced toward %s: %s",
                        from_leg.waypoint_id,
                        route.waypoints[idx + 1].id,
                        advanced.detail,
                    )
                else:
                    log.info(
                        "reacted to a SignalK arrival: advancing %s toward %s",
                        from_leg.waypoint_id,
                        route.waypoints[idx + 1].id,
                    )
            else:
                self._runtime.routes.set_active(None)
                cleared = publish_active_leg(self._runtime, None)
                log.info(
                    "route %s complete: arrived at the last waypoint %s; stopped following",
                    from_leg.route_id,
                    from_leg.waypoint_id,
                )
                if cleared.failed:
                    # mivnav stopped following either way, but SignalK was
                    # not told, so the box may still steer the old route.
                    log.warning(
                        "route %s is complete locally but SignalK's course could not be "
                        "cleared: %s",
                        from_leg.route_id,
                        cleared.detail,
                    )
        except Exception:  # noqa: BLE001 — never let a bad frame kill the worker
            log.exception("reacting to a SignalK arrival failed for %s", from_leg)


# pure helpers, testable without a NavWatcher/thread/queue in the way


def _course_point(course: dict[str, Any] | None, which: str) -> Point | None:
    """One point out of ``message["course"]`` (``nextLat``/``nextLng`` or
    ``prevLat``/``prevLng``), or ``None`` if absent. ``which`` is ``"next"``
    or ``"previous"``."""
    if not course:
        return None
    prefix = "next" if which == "next" else "prev"
    lat, lng = course.get(f"{prefix}Lat"), course.get(f"{prefix}Lng")
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        return Point(float(lat), float(lng))
    return None


def _nearest_waypoint(runtime: Runtime, point: Point, tolerance_m: float) -> tuple[Route, int] | None:
    """The closest waypoint (across ALL of mivnav's own routes, not just the
    active one) to ``point``, within ``tolerance_m``, or ``None``. Runs on
    the listener; ``routes.list()`` is in-memory-only, so no HTTP here."""
    best: tuple[Route, int, float] | None = None
    for route in runtime.routes.list():
        for idx, wp in enumerate(route.waypoints):
            d = haversine_m(point, Point(wp.lat, wp.lon))
            if d <= tolerance_m and (best is None or d < best[2]):
                best = (route, idx, d)
    return (best[0], best[1]) if best is not None else None
