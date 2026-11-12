# SPDX-License-Identifier: GPL-2.0-only
"""Raise and clear the GNSS-lost alarm on SignalK, from the server.

Reads the ``fixLost`` key the snapshot carries (set by
:class:`~mivnav.signalk.service.SignalKService` after
:attr:`~mivnav.gnss.config.GnssConfig.delay_s` of own-position silence) and
writes ``notifications.navigation.gnss.fixLost`` over the authenticated
write socket. Same shape as
:class:`~mivnav.collision.publisher.CollisionPublisher`: the listener only
stores the latest snapshot and wakes a worker that decides and writes at
most once per :data:`TICK_S`.

The debounce lives in the snapshot, not here: ``fixLost`` only appears once
the silence has lasted ``delay_s``, so every screen and SignalK agree on
when the loss became an alarm.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from mivnav.signalk.writer import DeltaWriter

if TYPE_CHECKING:
    from mivnav.api.deps import Runtime

log = logging.getLogger(__name__)

PATH = "notifications.navigation.gnss.fixLost"
PUBLISHER = "mivnav"
TICK_S = 1.0
#: An active notification is re-sent this often: its message carries the
#: loss's age, and a SignalK restart forgets every notification.
REFRESH_S = 30.0
RETRY_S = 10.0
_STOP_TIMEOUT = 10.0


def value_for(lost_s: float | None, *, quiet: bool = False) -> dict[str, Any]:
    """The notification for a loss ``lost_s`` seconds old, or the clear
    (``normal``) for ``None``. ``quiet`` (the boat's ``show``) drops sound."""
    if lost_s is None:
        return {"state": "normal", "method": [], "message": "", "data": {"publisher": PUBLISHER}}
    method = ["visual"] if quiet else ["visual", "sound"]
    return {
        "state": "alarm",
        "method": method,
        "message": f"GNSS position lost — no position for {round(lost_s)} s",
        "data": {"publisher": PUBLISHER, "lostS": round(lost_s)},
    }


class GnssPublisher:
    """One subscription, one worker thread; config and token read live."""

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
        #: What SignalK holds as far as we know: "alarm", "alarm/quiet", ""
        #: (cleared), or None (unknown — a fresh connection; may hold a
        #: ghost from before a mivnav restart).
        self._published: str | None = None
        self._published_at = 0.0
        #: When the snapshot first said ``fixLost``, for the message's age.
        self._lost_since: float | None = None
        self._retry_at = 0.0
        self._failing = False

    def start(self) -> None:
        if self._worker is not None:
            return
        self._worker = threading.Thread(target=self._run, name="gnss-publisher", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        worker = self._worker
        if worker is None:
            return
        self._stop.set()
        self._wake.set()
        worker.join(timeout=_STOP_TIMEOUT)
        if worker.is_alive():
            log.warning("the GNSS publisher did not stop within %ss", _STOP_TIMEOUT)
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
                    except Exception:  # noqa: BLE001 — one bad frame must not kill the watch
                        log.exception("the GNSS publisher failed a tick")
                self._stop.wait(self._tick_s)
        finally:
            self._do_unsubscribe()
            self._writer.close()

    def _subscribe(self) -> None:
        try:
            self._unsubscribe = self._runtime.signalk().subscribe(self._on_message)
        except Exception:  # noqa: BLE001
            log.exception("the GNSS publisher could not subscribe to SignalK")
            self._unsubscribe = None

    def _resubscribe(self) -> None:
        self._do_unsubscribe()
        with self._lock:
            self._latest = None
        self._published = None
        self._writer.close()
        self._subscribe()

    def _do_unsubscribe(self) -> None:
        unsubscribe, self._unsubscribe = self._unsubscribe, None
        if unsubscribe is not None:
            try:
                unsubscribe()
            except Exception:  # noqa: BLE001
                log.exception("GNSS publisher unsubscribe failed")

    # -- the decision (public for tests) -------------------------------------

    def tick(self, snapshot: dict[str, Any]) -> None:
        now = self._clock()
        config = self._runtime.config.get()
        if not config.signalk.enabled or snapshot.get("status") != "connected":
            # Nowhere to write. Whatever we raised may still be on SignalK
            # when the link returns, so its state is unknown from here on.
            self._published = None
            return

        lost = bool(snapshot.get("fixLost"))
        if lost:
            if self._lost_since is None:
                self._lost_since = now
        else:
            self._lost_since = None
        gnss = config.gnss
        wanted = lost and gnss.publish and gnss.mode != "off"
        quiet = gnss.mode == "show"
        state = ("alarm/quiet" if quiet else "alarm") if wanted else ""

        last = self._published
        if wanted:
            if last == state and now - self._published_at < REFRESH_S:
                return
            assert self._lost_since is not None
            value = value_for(gnss.delay_s + now - self._lost_since, quiet=quiet)
        elif last == "":
            return
        else:
            value = value_for(None)
        if now < self._retry_at:
            return
        # The clear we send to an unknown SignalK (after a restart or a
        # reconnect) is a courtesy: a ghost may be there, most likely not.
        # Its failure is not worth a retry loop and a warning on every boat
        # without write access.
        courtesy = not wanted and last is None
        if self._write(config, value, now, quiet_failure=courtesy) or courtesy:
            self._published = state
            self._published_at = now

    def _write(self, config: Any, value: dict[str, Any], now: float, *, quiet_failure: bool) -> bool:
        token = config.credentials.signalk.token.get_secret_value() or None
        delta = {"context": "vessels.self", "updates": [{"values": [{"path": PATH, "value": value}]}]}
        try:
            self._writer.send(config.signalk.ws_url, token, delta)
        except Exception as e:  # noqa: BLE001 — every failure is a retry
            if quiet_failure:
                log.debug("could not clear a stale GNSS alarm on SignalK: %s", e)
                return False
            self._retry_at = now + RETRY_S
            if not self._failing:
                log.warning("could not publish the GNSS alarm to SignalK: %s", e)
                self._failing = True
            else:
                log.debug("GNSS alarm publish failed again: %s", e)
            return False
        if self._failing:
            log.info("publishing the GNSS alarm to SignalK again")
            self._failing = False
        return True
