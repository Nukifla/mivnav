# SPDX-License-Identifier: GPL-2.0-only
"""The boat's one SignalK connection: exactly one upstream socket per boat,
independent of clients coming and going, and independent of the chart
service's own event loop (a hung SignalK box is a thread parked in a retry
sleep, nothing else). Absence (`url=None`) and unreachability are both live
states, not errors. See docs/architecture/signalk-service-backend.md.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import threading
import time
from collections.abc import Callable
from typing import Any, Literal

from .model import VesselTracker

log = logging.getLogger(__name__)

Status = Literal["off", "connecting", "connected"]
#: ``{"status": Status, "self": vessel|None, "targets": [vessel, …],
#: "autopilot": …|None, "course": …|None, "paths"?: {path: {value, units?,
#: age?}}}`` — the last is the raw user-chosen dashboard paths, present only
#: when one has reported. See :meth:`mivnav.signalk.model.VesselTracker.snapshot`.
Snapshot = dict[str, Any]
#: Extra snapshot keys computed FROM the snapshot — the collision assessment
#: (:func:`mivnav.collision.assess.assess`). Runs under the service lock on
#: every snapshot, so it must be pure and cheap.
Extend = Callable[[Snapshot], dict[str, Any]]
#: Called with a snapshot, or with ``None`` when the service closes. Runs
#: on the service thread and must not block — see the router, which only
#: hands the message to its own event loop.
Listener = Callable[[Snapshot | None], None]

#: AIS targets silent for longer than this are gone.
STALE_TTL = 10 * 60.0
#: Coalescing window. A plotter needs the boat to move smoothly, not to
#: track every delta: 5 Hz is well past what an eye or a screen resolves,
#: and it bounds what a burst of AIS traffic can cost N devices.
BROADCAST_INTERVAL = 0.2
RETRY_MIN = 2.0
RETRY_MAX = 30.0
#: How long close() waits for the reader thread. Generous: it only has a
#: socket to drop.
CLOSE_TIMEOUT = 5.0

#: Curated, not `{"path": "*"}` (costs Pi CPU parsing/discarding unused
#: paths) — see docs/architecture/signalk-service-backend.md for the
#: wildcarding and dialect-disagreement rationale.
SUBSCRIPTION = {
    "context": "vessels.*",
    "subscribe": [
        {"path": "navigation.position"},
        {"path": "navigation.headingTrue"},
        {"path": "navigation.courseOverGroundTrue"},
        {"path": "navigation.speedOverGround"},
        {"path": "navigation.speedThroughWater"},
        {"path": "navigation.rateOfTurn"},
        {"path": "navigation.datetime"},
        # Own-ship in practice; asked for under `vessels.*` since the
        # subscription doesn't need to know which vessel is us.
        {"path": "environment.depth.belowTransducer"},
        {"path": "environment.depth.belowSurface"},
        {"path": "environment.depth.belowKeel"},
        {"path": "environment.wind.speedApparent"},
        {"path": "environment.wind.angleApparent"},
        {"path": "environment.wind.speedTrue"},
        {"path": "environment.wind.angleTrueWater"},
        {"path": "navigation.state"},
        {"path": "navigation.destination"},
        {"path": "navigation.destination.*"},
        # Off-spec, but what both parsers actually emit; the spec's own
        # `navigation.maneuver` is taken too in case a transport is right.
        {"path": "navigation.specialManeuver"},
        {"path": "navigation.maneuver"},
        # Read side of route.client's v2 Course API writes; both v2 and
        # legacy `courseGreatCircle.*` paths (see signalk-service-backend.md).
        {"path": "navigation.course.nextPoint.position"},
        {"path": "navigation.course.previousPoint.position"},
        {"path": "navigation.courseGreatCircle.nextPoint.position"},
        {"path": "navigation.courseGreatCircle.previousPoint.position"},
        # The course-provider plugin's own arrival notifications
        # (#yprzuqtt); route.watcher reacts to either becoming active.
        {"path": "notifications.navigation.course.arrivalCircleEntered"},
        {"path": "notifications.navigation.course.perpendicularPassed"},
        # The anchoralarm plugin is the anchor watcher (anchor.md); we
        # show its state and alarm. Source-filtered in `signalk.anchor`.
        # Named leaves, not `navigation.anchor.*`: while watching the plugin
        # also streams apparentBearing/distanceFromBow/meta at 1 Hz, unread.
        {"path": "navigation.anchor.position"},
        {"path": "navigation.anchor.maxRadius"},
        {"path": "navigation.anchor.currentRadius"},
        {"path": "navigation.anchor.bearingTrue"},
        {"path": "navigation.anchor.rodeLength"},
        {"path": "navigation.anchor.fudgeFactor"},
        # Where the antenna sits — what puts a dropped anchor at the bow.
        {"path": "sensors.gps.fromBow"},
        {"path": "notifications.navigation.anchor"},
        # Our own collision alarms, echoed back with the id an ACK names and
        # read to clear ghosts (mivnav.collision.notices). A wildcard leaf
        # because the last segment is the target's urn.
        {"path": "notifications.navigation.closestApproach.*"},
        # Our own shallow-water alarm's echo, likewise (mivnav.shallow.notices).
        {"path": "notifications.environment.depth.shallowWater"},
        # Man overboard — ours (re-raised/cleared by mivnav.features.mob)
        # and anyone else's (an MFD's MOB key), shown on every screen.
        {"path": "notifications.mob"},
        # Verified against signalk-server 2.30.0 + pypilot-sk; named exactly
        # since the Autopilot API specifies these leaves.
        {"path": "steering.autopilot.state"},
        {"path": "steering.autopilot.mode"},
        {"path": "steering.autopilot.engaged"},
        {"path": "steering.autopilot.target"},
        {"path": "steering.autopilot.defaultPilot"},
        {"path": "steering.autopilot.availableActions"},
        {"path": "steering.rudderAngle"},
        {"path": "design.*"},
        {"path": "sensors.ais.*"},
        {"path": "registrations.*"},
        {"path": "communication.*"},
        {"path": ""},  # AIS static data as one root object, where supported
    ],
}


def build_subscription(extra_paths: list[str] | None = None) -> dict[str, Any]:
    """The curated :data:`SUBSCRIPTION`, plus any user-chosen ``extra_paths``
    (:attr:`~mivnav.config.model.SignalKConfig.extra_paths`), appended raw.
    Never ``*``: the config validator rejects wildcards before they reach here."""
    subscribe = list(SUBSCRIPTION["subscribe"])
    subscribe.extend({"path": path} for path in (extra_paths or ()))
    return {"context": SUBSCRIPTION["context"], "subscribe": subscribe}


def _default_connect(url: str):  # pragma: no cover - a one-line import shim
    from websockets.asyncio.client import connect

    return connect(url, open_timeout=10, ping_interval=20)


class SignalKService:
    """One upstream SignalK connection, or none. Pure of config: it takes a
    URL; :mod:`mivnav.api.deps` turns a
    :class:`~mivnav.config.model.SignalKConfig` into one."""

    def __init__(
        self,
        url: str | None,
        *,
        extra_paths: list[str] | None = None,
        extend: Extend | None = None,
        fix_lost_after: Callable[[], float | None] | None = None,
        stale_ttl: float = STALE_TTL,
        broadcast_interval: float = BROADCAST_INTERVAL,
        retry_min: float = RETRY_MIN,
        retry_max: float = RETRY_MAX,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._url = url
        # Frozen at construction: part of the config slice this service is
        # keyed on, so changing them rebuilds the whole service (fresh
        # socket + subscription) rather than reconciling a live one.
        self._extra_paths = list(extra_paths or ())
        # Not frozen like the above: reads its own (non-signalk) config live,
        # so editing it re-dials nothing. See `Extend`.
        self._extend = extend
        # Live like `extend`: seconds of own-position silence that make the
        # snapshot's `fixLost` (the GNSS-lost alarm, `mivnav.gnss`). None = off.
        self._fix_lost_after = fix_lost_after
        self._stale_ttl = stale_ttl
        self._interval = broadcast_interval
        self._retry_min = retry_min
        self._retry_max = retry_max
        self._connect = connect or _default_connect

        # Guards the tracker, the status, the listener set and the closed
        # flag: everything the reader thread and a request thread share.
        self._lock = threading.Lock()
        self._tracker = VesselTracker(self._extra_paths)
        self._status: Status = "connecting" if url else "off"
        self._listeners: set[Listener] = set()
        self._published: Snapshot | None = None
        self._closed = False
        #: Wall-clock seconds the current upstream connection came up: a fix
        #: silence is never counted from before it (a reconnect is not a
        #: dead GPS just because the last report predates the outage).
        self._connected_at = 0.0

        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        # Loop-agnostic until first awaited; set() from another thread goes
        # through call_soon_threadsafe. See close().
        self._stopping = asyncio.Event()

        if url:
            self._start()

    # -- the outside ------------------------------------------------------

    @property
    def url(self) -> str | None:
        return self._url

    def snapshot(self) -> Snapshot:
        """The picture right now. Never blocks, never fails, never mutates."""
        with self._lock:
            return self._snapshot_locked()

    def search_targets(self, query: str = "") -> list[dict[str, Any]]:
        """AIS targets matching ``query`` (name/MMSI substring), or all when
        empty. Deliberately NOT baked into the shared search index: a
        target's position changes every publish interval, so indexing it
        would mean rewriting SQLite rows at AIS traffic rate."""
        q = query.strip().lower()
        with self._lock:
            targets = self._tracker.snapshot(time.time(), self._stale_ttl)["targets"]
        if not q:
            return targets
        return [
            t
            for t in targets
            if q in (t.get("name") or "").lower() or q in (t.get("mmsi") or "").lower()
        ]

    def position_reports(self, mmsis: frozenset[str]) -> list[dict[str, Any]]:
        """See :meth:`mivnav.signalk.model.VesselTracker.position_reports`."""
        with self._lock:
            return self._tracker.position_reports(mmsis)

    def anchor_track(self) -> list[list[float]]:
        """The swing track since the anchor went down (``[[lng, lat,
        time_ms], …]``), recorded here on the always-on server."""
        with self._lock:
            return self._tracker.anchor_track()

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        """Register ``listener``, hand it the current snapshot at once (so a
        newly-opened device is correct immediately, not after the next
        delta), and return an unsubscribe. Delivers ``None`` if already closed."""
        with self._lock:
            if self._closed:
                snapshot = None
            else:
                self._listeners.add(listener)
                snapshot = self._snapshot_locked()
        _deliver(listener, snapshot)
        if snapshot is None:
            return lambda: None
        return lambda: self._unsubscribe(listener)

    def close(self) -> None:
        """Stop the connection and tell every subscriber. Idempotent; called
        by :class:`~mivnav.config.derived.Derived` on config change and at
        shutdown."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            listeners, self._listeners = list(self._listeners), set()
            self._status = "off"
        if self._loop is not None:
            # Suppressed rather than checked: the loop closing is exactly
            # what we are asking for, and losing the race to it is a
            # success, not a failure.
            with contextlib.suppress(RuntimeError):
                self._loop.call_soon_threadsafe(self._stopping.set)
        for listener in listeners:
            _deliver(listener, None)
        thread = self._thread
        # Joining is what makes teardown deterministic (a test, and the
        # rebuild-on-config-change path, both want the old socket actually
        # gone). Guarded because a listener callback runs on this thread
        # and must not be able to join it.
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=CLOSE_TIMEOUT)
            if thread.is_alive():
                log.warning("the SignalK reader did not stop within %ss", CLOSE_TIMEOUT)

    # -- internals --------------------------------------------------------

    def _snapshot_locked(self) -> Snapshot:
        now = time.time()
        snapshot: Snapshot = {
            "status": self._status,
            **self._tracker.snapshot(now, self._stale_ttl),
        }
        if self._fix_lost(now):
            snapshot["fixLost"] = True
        if self._extend is not None:
            try:
                snapshot.update(self._extend(snapshot))
            except Exception:  # noqa: BLE001 — a derivation must never cost the picture
                log.exception("extending the SignalK snapshot failed")
        return snapshot

    def _fix_lost(self, now: float) -> bool:
        """Has the own ship sent no position for ``fix_lost_after`` seconds
        while SignalK was connected? Recomputed on every publish tick (5 Hz),
        so it flips within a tick of the delay — the snapshot itself is the
        debounce. A boat that never reported a position (no GNSS on the bus)
        never alarms: there is no fix to lose."""
        if self._fix_lost_after is None or self._status != "connected":
            return False
        seen = self._tracker.own_position_seen_at()
        if seen is None:
            return False
        try:
            after = self._fix_lost_after()
        except Exception:  # noqa: BLE001 — a config read must never cost the picture
            log.exception("reading the GNSS-lost delay failed")
            return False
        return after is not None and now - max(seen, self._connected_at) >= after

    def _unsubscribe(self, listener: Listener) -> None:
        with self._lock:
            self._listeners.discard(listener)

    def _start(self) -> None:
        ready = threading.Event()

        def run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            ready.set()
            try:
                loop.run_until_complete(self._main())
            finally:
                with contextlib.suppress(Exception):
                    loop.run_until_complete(loop.shutdown_asyncgens())
                loop.close()

        # Daemon: a SignalK box that never answers must not be able to hold
        # the process open at exit.
        self._thread = threading.Thread(target=run, name="signalk", daemon=True)
        self._thread.start()
        # Only for the loop to exist, so close() can reach it. No network.
        ready.wait()

    async def _main(self) -> None:
        tasks = [
            asyncio.create_task(self._read_loop()),
            asyncio.create_task(self._publish_loop()),
        ]
        await self._stopping.wait()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _read_loop(self) -> None:
        assert self._url is not None
        delay = self._retry_min
        complained = False
        while True:
            try:
                async with self._connect(self._url) as socket:
                    self._set_status("connected")
                    delay = self._retry_min
                    complained = False
                    await socket.send(json.dumps(build_subscription(self._extra_paths)))
                    async for raw in socket:
                        with self._lock:
                            self._tracker.apply(raw, time.time())
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — every failure is a retry
                # Once per outage, not once per attempt: an absent SignalK
                # box is a normal boat, and it must not fill the log.
                if complained:
                    log.debug("SignalK %s: %s", self._url, e)
                else:
                    log.warning(
                        "SignalK at %s is unreachable (%s); retrying in the background",
                        self._url,
                        e,
                    )
                    complained = True
            self._set_status("connecting")
            await asyncio.sleep(delay)
            delay = min(self._retry_max, delay * 2)

    async def _publish_loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            self._publish()

    def _publish(self) -> None:
        """The single publisher: expire, snapshot, send if it changed. Status
        rides along as part of the snapshot rather than its own path — one
        way for anything to reach a client."""
        with self._lock:
            if self._closed:
                return
            self._tracker.expire(time.time(), self._stale_ttl)
            snapshot = self._snapshot_locked()
            if snapshot == self._published:
                return
            self._published = snapshot
            listeners = list(self._listeners)
        for listener in listeners:
            _deliver(listener, snapshot)

    def _set_status(self, status: Status) -> None:
        with self._lock:
            if not self._closed:
                if status == "connected" and self._status != "connected":
                    self._connected_at = time.time()
                self._status = status


def _deliver(listener: Listener, message: Snapshot | None) -> None:
    """A broken subscriber is its own problem, never the connection's."""
    try:
        listener(message)
    except Exception:  # noqa: BLE001
        log.exception("a SignalK subscriber raised; dropping the message")
