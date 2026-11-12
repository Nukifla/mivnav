# SPDX-License-Identifier: GPL-2.0-only
"""Raise and clear the collision alarm on SignalK, from the server.

Reads the ``collision`` key every snapshot already carries
(:mod:`.assess`) and writes ``notifications.navigation.closestApproach.<urn>``
over an authenticated stream socket (:class:`~mivnav.signalk.writer.DeltaWriter`).
Same shape as :class:`~mivnav.features.route.watcher.NavWatcher`: the
listener only stores the latest snapshot and wakes a worker; every decision
and every blocking write happens on the worker, at most once per
:data:`TICK_S`, however fast AIS traffic makes the snapshot change.
See docs/architecture/cpa-backend.md.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from mivnav.collision.notices import STATES, STEP_DOWN, path_for, stepped_down, value_for
from mivnav.signalk.writer import DeltaWriter

if TYPE_CHECKING:
    from mivnav.api.deps import Runtime

log = logging.getLogger(__name__)

#: How often the worker looks at the latest snapshot.
TICK_S = 1.0
#: A target that drops out of a tier is held in it this long before the
#: notification steps down. Without it a target hovering on the 0.3 nm line
#: re-raises every few seconds — and SignalK re-arms the SOUND on every
#: re-raise (an escalation clears ``acknowledged``), on every display.
HOLD_S = 20.0
#: An active notification is re-sent this often: its message carries the
#: live CPA/TCPA, and a SignalK restart forgets every notification.
#: Re-sending the same state keeps an ACK (only an escalation clears one).
REFRESH_S = 30.0
#: A silenced notification is re-armed this long after we first saw it
#: silenced — whoever silenced it (a screen's MUTE, KIP, the MFD). SignalK's
#: own silence has no timer: it lasts until an escalation, so without this a
#: "mute" would be an ACK that still shows. Re-armed by stepping the state
#: down for one tick (:func:`~mivnav.collision.notices.stepped_down`), which
#: makes the next publish an escalation.
MUTE_S = 120.0
#: After a failed write, wait this long before trying again.
RETRY_S = 10.0
#: A ghost (ours on SignalK, not wanted — left by a mivnav restart) is
#: cleared at most this often while its echo catches up.
GHOST_EVERY_S = 10.0
#: Comfortably past the writer's open timeout.
_STOP_TIMEOUT = 10.0

_RANK = {"yellow": 1, "red": 2}


@dataclass
class _Held:
    alarm: dict[str, Any]
    at: float


class CollisionPublisher:
    """One subscription, one worker thread. Everything is read live off the
    runtime each tick — config, token, service — nothing cached to rebuild."""

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
        # (snapshot, service-superseded) — written by the listener thread.
        self._latest: dict[str, Any] | None = None
        self._superseded = False
        self._worker: threading.Thread | None = None
        self._unsubscribe: Callable[[], None] | None = None

        # -- worker-thread only --
        #: Per target, per tier: the last time it was in that tier.
        self._held: dict[str, dict[str, _Held]] = {}
        #: What we last sent and when: target → (state, at).
        self._published: dict[str, tuple[str, float]] = {}
        self._ghost_cleared: dict[str, float] = {}
        #: Per target: when we first saw its notification silenced. In memory
        #: only — after a restart a standing silence counts from then, so it
        #: can run long by one mute, never forever.
        self._muted: dict[str, float] = {}
        self._retry_at = 0.0
        self._failing = False

    def start(self) -> None:
        if self._worker is not None:
            return
        self._worker = threading.Thread(target=self._run, name="collision-publisher", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        worker = self._worker
        if worker is None:
            return
        self._stop.set()
        self._wake.set()
        worker.join(timeout=_STOP_TIMEOUT)
        if worker.is_alive():
            log.warning("the collision publisher did not stop within %ss", _STOP_TIMEOUT)
        self._worker = None

    # -- the SignalK thread: store and wake, never block --------------------

    def _on_message(self, message: dict[str, Any] | None) -> None:
        with self._lock:
            if message is None:
                self._superseded = True
            else:
                self._latest = message
        self._wake.set()

    # -- the worker -----------------------------------------------------------

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
                        log.exception("the collision publisher failed a tick")
                # Rate limit: never act more than once per tick, however
                # often the snapshot wakes us.
                self._stop.wait(self._tick_s)
        finally:
            self._do_unsubscribe()
            self._writer.close()

    def _subscribe(self) -> None:
        try:
            self._unsubscribe = self._runtime.signalk().subscribe(self._on_message)
        except Exception:  # noqa: BLE001
            log.exception("the collision publisher could not subscribe to SignalK")
            self._unsubscribe = None

    def _resubscribe(self) -> None:
        self._do_unsubscribe()
        with self._lock:
            self._latest = None
        # A new connection: nothing we sent is known to be on it any more.
        self._published.clear()
        self._writer.close()
        self._subscribe()

    def _do_unsubscribe(self) -> None:
        unsubscribe, self._unsubscribe = self._unsubscribe, None
        if unsubscribe is not None:
            try:
                unsubscribe()
            except Exception:  # noqa: BLE001
                log.exception("collision publisher unsubscribe failed")

    # -- the decision (public for tests: drive it with snapshots directly) ---

    def tick(self, snapshot: dict[str, Any]) -> None:
        now = self._clock()
        config = self._runtime.config.get()
        if not config.signalk.enabled:
            # Nowhere to write; whatever we raised went with the connection.
            self._published.clear()
            self._held.clear()
            self._muted.clear()
            return
        if snapshot.get("status") != "connected":
            return  # writes would fail; keep state until the link is back

        mode = config.collision.mode
        # `off` is the whole boat's alarm off: clear what is up, raise nothing.
        wanted = self._wanted(snapshot, now) if config.collision.publish and mode != "off" else {}
        # `show`: raised so every display shows it, but nothing sounds.
        quiet = mode == "show"
        notices = snapshot.get("collisionNotices") or {}
        values: list[dict[str, Any]] = []
        sent: dict[str, str] = {}
        rearmed: set[str] = set()

        for target in self._muted.keys() - wanted.keys():
            del self._muted[target]
        for target, alarm in wanted.items():
            # What we compare against what we last sent: the state AND whether
            # it sounds, so flipping show ↔ tell re-sends a standing alarm.
            state = STATES[alarm["risk"]][0] + ("/quiet" if quiet else "")
            last = self._published.get(target)
            # Only once SignalK holds the state we want: an escalation already
            # on its way re-arms by itself. A quiet alarm has nothing to re-arm.
            if (
                not quiet
                and self._mute_over(target, notices.get(target), now)
                and last is not None
                and last[0] == state
            ):
                values.append({"path": path_for(target), "value": stepped_down(alarm)})
                sent[target] = STEP_DOWN[state]
                rearmed.add(target)
            elif last is None or last[0] != state or now - last[1] >= REFRESH_S:
                values.append({"path": path_for(target), "value": value_for(alarm, quiet=quiet)})
                sent[target] = state
        for target in self._published.keys() - wanted.keys():
            values.append({"path": path_for(target), "value": value_for(None)})
            sent[target] = ""
        # Ghosts: ours on SignalK but not wanted and not just cleared above.
        for target in (snapshot.get("collisionNotices") or {}).keys() - wanted.keys() - sent.keys():
            if now - self._ghost_cleared.get(target, -GHOST_EVERY_S) >= GHOST_EVERY_S:
                values.append({"path": path_for(target), "value": value_for(None)})
                self._ghost_cleared[target] = now

        if not values or now < self._retry_at:
            return
        if not self._write(config, values, now):
            return
        for target, state in sent.items():
            if state:
                self._published[target] = (state, now)
            else:
                self._published.pop(target, None)
        # Restart the count, not drop it: the echo of the step-down still
        # says silenced until the escalation behind it lands.
        for target in rearmed:
            self._muted[target] = now

    def _mute_over(self, target: str, notice: dict[str, Any] | None, now: float) -> bool:
        """Has this target's notification been silenced (and not ACKed — an
        ACK is the user's to keep) for :data:`MUTE_S`?"""
        if not notice or not notice.get("silenced") or notice.get("acknowledged"):
            self._muted.pop(target, None)
            return False
        return now - self._muted.setdefault(target, now) >= MUTE_S

    def _wanted(self, snapshot: dict[str, Any], now: float) -> dict[str, dict[str, Any]]:
        """Each alarming target at its tier — the live one, or a higher one it
        left less than :data:`HOLD_S` ago."""
        live = {a["id"]: a for a in (snapshot.get("collision") or {}).get("alarms") or ()}
        for target, alarm in live.items():
            self._held.setdefault(target, {})[alarm["risk"]] = _Held(alarm, now)
        wanted: dict[str, dict[str, Any]] = {}
        for target in list(self._held):
            tiers = {r: h for r, h in self._held[target].items() if now - h.at < HOLD_S}
            if not tiers:
                del self._held[target]
                continue
            self._held[target] = tiers
            risk = max(tiers, key=_RANK.__getitem__)
            # The live numbers when there are any; the held tier's otherwise.
            wanted[target] = {**live.get(target, tiers[risk].alarm), "risk": risk}
        return wanted

    def _write(self, config: Any, values: list[dict[str, Any]], now: float) -> bool:
        token = config.credentials.signalk.token.get_secret_value() or None
        delta = {"context": "vessels.self", "updates": [{"values": values}]}
        try:
            self._writer.send(config.signalk.ws_url, token, delta)
        except Exception as e:  # noqa: BLE001 — every failure is a retry
            self._retry_at = now + RETRY_S
            # Once per outage, like the reader: an absent box is a normal boat.
            if not self._failing:
                log.warning("could not publish the collision alarm to SignalK: %s", e)
                self._failing = True
            else:
                log.debug("collision publish failed again: %s", e)
            return False
        if self._failing:
            log.info("publishing the collision alarm to SignalK again")
            self._failing = False
        return True
