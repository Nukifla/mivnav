# SPDX-License-Identifier: GPL-2.0-only
"""Raise and clear the MOB alarm on SignalK, from the server.

Same shape as :class:`~mivnav.collision.publisher.CollisionPublisher`: the
SignalK listener only stores the latest snapshot; a worker decides and
writes, at most once per :data:`TICK_S`. The store (:mod:`.store`) is the
truth — this keeps SignalK in step with it:

* an active MOB is raised as ``notifications.mob`` (emergency, sound), and
  re-sent every :data:`REFRESH_S` — sooner if SignalK's echo is missing
  (a SignalK restart forgets every notification). Re-sending the same state
  keeps an ACK; only an escalation clears one.
* a cleared MOB is cleared on SignalK, and so is any ``notifications.mob``
  of OURS still standing (left by a mivnav restart). Someone else's — an
  MFD's MOB key — is never touched: clearing that is theirs.
* the mark is put on SignalK as a waypoint resource once, and deleted on
  clear. Best effort, retried: the alarm never waits for it.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, cast

from mivnav.features.mob.notice import PATH, value_for
from mivnav.features.mob.store import Mob
from mivnav.signalk.writer import DeltaWriter

if TYPE_CHECKING:
    from mivnav.api.deps import Runtime
    from mivnav.features.mob.runtime import MobRuntime

log = logging.getLogger(__name__)

TICK_S = 1.0
#: An active MOB is re-sent this often regardless of the echo.
REFRESH_S = 30.0
#: ... and this soon after a send if SignalK still does not echo it.
ECHO_GRACE_S = 5.0
#: After a failed write, wait this long before trying again.
RETRY_S = 5.0
#: A leftover of ours is cleared at most this often while its echo catches up.
GHOST_EVERY_S = 10.0
_STOP_TIMEOUT = 10.0


class MobPublisher:
    def __init__(
        self,
        runtime: Runtime,
        *,
        writer: DeltaWriter | None = None,
        clock: Callable[[], float] = time.monotonic,
        tick_s: float = TICK_S,
    ) -> None:
        self._runtime = runtime
        self._writer = writer or DeltaWriter()
        self._clock = clock
        self._tick_s = tick_s
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._latest: dict[str, Any] | None = None
        self._superseded = False
        self._worker: threading.Thread | None = None
        self._unsubscribe: Callable[[], None] | None = None

        # -- worker-thread only --
        #: The MOB id we last raised, and when; ``None`` = nothing raised.
        self._raised: tuple[str, float] | None = None
        self._ghost_cleared_at = -GHOST_EVERY_S
        self._retry_at = 0.0
        self._failing = False
        #: The waypoint resource we put, by MOB id.
        self._waypoint: str | None = None
        self._waypoint_retry_at = 0.0
        #: Waypoints of cleared MOBs still to delete.
        self._to_delete: set[str] = set()

    # -- lifecycle (as CollisionPublisher) --------------------------------

    def start(self) -> None:
        if self._worker is not None:
            return
        self._worker = threading.Thread(target=self._run, name="mob-publisher", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        worker = self._worker
        if worker is None:
            return
        self._stop.set()
        self._wake.set()
        worker.join(timeout=_STOP_TIMEOUT)
        if worker.is_alive():
            log.warning("the MOB publisher did not stop within %ss", _STOP_TIMEOUT)
        self._worker = None

    def _on_message(self, message: dict[str, Any] | None) -> None:
        with self._lock:
            if message is None:
                self._superseded = True
            else:
                self._latest = message
        self._wake.set()

    def _run(self) -> None:
        self._subscribe()
        try:
            while not self._stop.is_set():
                self._wake.wait(self._tick_s)
                self._wake.clear()
                if self._stop.is_set():
                    break
                with self._lock:
                    superseded, self._superseded = self._superseded, False
                    snapshot = self._latest
                if superseded:
                    self._resubscribe()
                    continue
                if snapshot is not None:
                    try:
                        self.tick(snapshot)
                    except Exception:  # noqa: BLE001 — one bad tick must not end the watch
                        log.exception("the MOB publisher failed a tick")
                self._stop.wait(self._tick_s)
        finally:
            self._do_unsubscribe()
            self._writer.close()

    def _subscribe(self) -> None:
        try:
            self._unsubscribe = self._runtime.signalk().subscribe(self._on_message)
        except Exception:  # noqa: BLE001
            log.exception("the MOB publisher could not subscribe to SignalK")
            self._unsubscribe = None

    def _resubscribe(self) -> None:
        self._do_unsubscribe()
        with self._lock:
            self._latest = None
        self._raised = None
        self._writer.close()
        self._subscribe()

    def _do_unsubscribe(self) -> None:
        unsubscribe, self._unsubscribe = self._unsubscribe, None
        if unsubscribe is not None:
            try:
                unsubscribe()
            except Exception:  # noqa: BLE001
                log.exception("MOB publisher unsubscribe failed")

    # -- the decision (public for tests) ----------------------------------

    def tick(self, snapshot: dict[str, Any]) -> None:
        now = self._clock()
        config = self._runtime.config.get()
        if not config.signalk.enabled:
            self._raised = None
            return
        if snapshot.get("status") != "connected":
            return
        mob = self._feature().store.active()
        notice = snapshot.get("mobNotice")
        ours_up = isinstance(notice, dict) and notice.get("ours") is True

        if mob is not None:
            self._to_delete.discard(mob.id)
            self._raise(config, mob, ours_up, now)
        else:
            self._clear(config, ours_up, now)
            if self._waypoint is not None:
                self._to_delete.add(self._waypoint)
        if config.credentials.signalk.token.get_secret_value():
            # REST writes need the device token; the alarm itself does not
            # (a security-off box takes the delta anyway).
            if mob is not None:
                self._put_waypoint(mob, now)
            self._delete_waypoints(now)

    def _raise(self, config: Any, mob: Mob, ours_up: bool, now: float) -> None:
        raised = self._raised
        due = (
            raised is None
            or raised[0] != mob.id
            or now - raised[1] >= REFRESH_S
            or (not ours_up and now - raised[1] >= ECHO_GRACE_S)
        )
        if due and self._write(config, value_for(mob), now):
            self._raised = (mob.id, now)

    def _clear(self, config: Any, ours_up: bool, now: float) -> None:
        if self._raised is not None:
            if self._write(config, value_for(None), now):
                old = self._raised[0]
                self._raised = None
                self._ghost_cleared_at = now
                self._to_delete.add(old)
            return
        if ours_up and now - self._ghost_cleared_at >= GHOST_EVERY_S:
            if self._write(config, value_for(None), now):
                self._ghost_cleared_at = now

    def _feature(self) -> MobRuntime:
        return cast("MobRuntime", self._runtime.feature("mob"))

    def _put_waypoint(self, mob: Mob, now: float) -> None:
        if self._waypoint == mob.id or not mob.has_position or now < self._waypoint_retry_at:
            return
        if self._waypoint is not None:
            self._to_delete.add(self._waypoint)
        try:
            self._feature().client().put_waypoint(mob)
        except Exception as e:  # noqa: BLE001
            self._waypoint_retry_at = now + RETRY_S * 6
            log.warning("could not put the MOB mark on SignalK as a waypoint: %s", e)
            return
        self._waypoint = mob.id

    def _delete_waypoints(self, now: float) -> None:
        if self._waypoint in self._to_delete:
            self._waypoint = None
        if not self._to_delete or now < self._waypoint_retry_at:
            return
        client = self._feature().client()
        for mob_id in sorted(self._to_delete):
            try:
                client.delete_waypoint(mob_id)
            except Exception as e:  # noqa: BLE001
                self._waypoint_retry_at = now + RETRY_S * 6
                log.warning("could not delete the MOB waypoint %s from SignalK: %s", mob_id, e)
                return
            self._to_delete.discard(mob_id)

    def _write(self, config: Any, value: dict[str, Any], now: float) -> bool:
        if now < self._retry_at:
            return False
        token = config.credentials.signalk.token.get_secret_value() or None
        delta = {"context": "vessels.self", "updates": [{"values": [{"path": PATH, "value": value}]}]}
        try:
            self._writer.send(config.signalk.ws_url, token, delta)
        except Exception as e:  # noqa: BLE001 — every failure is a retry
            self._retry_at = now + RETRY_S
            if not self._failing:
                log.warning("could not publish the MOB alarm to SignalK: %s", e)
                self._failing = True
            return False
        if self._failing:
            log.info("publishing the MOB alarm to SignalK again")
            self._failing = False
        return True
