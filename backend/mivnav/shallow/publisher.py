# SPDX-License-Identifier: GPL-2.0-only
"""Raise and clear the shallow-water alarm on SignalK, from the server.

Reads the ``shallow`` key every snapshot carries (:mod:`.watch`, already
debounced) and writes :data:`~.notices.PATH`. The thread, subscription and
writer plumbing are the collision publisher's — this is the same machine
with one notification instead of one per target, so it reuses that class
and replaces only the decision (:meth:`ShallowPublisher.tick`).
Refresh, mute re-arm, retry and ghost timings are the collision alarm's.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from mivnav.collision.publisher import GHOST_EVERY_S, MUTE_S, REFRESH_S, RETRY_S, CollisionPublisher
from mivnav.collision.notices import STEP_DOWN
from mivnav.shallow.notices import PATH, STATE, stepped_down, value_for

log = logging.getLogger(__name__)

#: The one key in the inherited per-target maps.
_KEY = "shallow"


class ShallowPublisher(CollisionPublisher):
    def start(self) -> None:
        if self._worker is not None:
            return
        self._worker = threading.Thread(target=self._run, name="shallow-publisher", daemon=True)
        self._worker.start()

    def tick(self, snapshot: dict[str, Any]) -> None:
        now = self._clock()
        config = self._runtime.config.get()
        if not config.signalk.enabled:
            self._published.clear()
            self._muted.clear()
            return
        if snapshot.get("status") != "connected":
            return
        cfg = config.shallow
        shallow = snapshot.get("shallow")
        wanted = (
            shallow
            if cfg.publish and cfg.mode != "off" and shallow is not None and shallow.get("active")
            else None
        )
        quiet = cfg.mode == "show"
        notice = snapshot.get("shallowNotice")
        last = self._published.get(_KEY)
        value: dict[str, Any] | None = None
        sent: str | None = None
        rearmed = False

        if wanted is not None:
            state = STATE + ("/quiet" if quiet else "")
            if not quiet and self._mute_over(_KEY, notice, now) and last is not None and last[0] == state:
                value, sent, rearmed = stepped_down(wanted), STEP_DOWN[STATE], True
            elif last is None or last[0] != state or now - last[1] >= REFRESH_S:
                value, sent = value_for(wanted, quiet=quiet), state
        else:
            self._muted.pop(_KEY, None)
            if last is not None:
                value, sent = value_for(None), ""
            elif notice and now - self._ghost_cleared.get(_KEY, -GHOST_EVERY_S) >= GHOST_EVERY_S:
                # Ours on SignalK, not wanted: left by a mivnav restart.
                value = value_for(None)
                self._ghost_cleared[_KEY] = now

        if value is None or now < self._retry_at:
            return
        if not self._write(config, [{"path": PATH, "value": value}], now):
            return
        if sent:
            self._published[_KEY] = (sent, now)
        elif sent == "":
            self._published.pop(_KEY, None)
        if rearmed:
            self._muted[_KEY] = now

    def _write(self, config: Any, values: list[dict[str, Any]], now: float) -> bool:
        token = config.credentials.signalk.token.get_secret_value() or None
        delta = {"context": "vessels.self", "updates": [{"values": values}]}
        try:
            self._writer.send(config.signalk.ws_url, token, delta)
        except Exception as e:  # noqa: BLE001 — every failure is a retry
            self._retry_at = now + RETRY_S
            if not self._failing:
                log.warning("could not publish the shallow-water alarm to SignalK: %s", e)
                self._failing = True
            else:
                log.debug("shallow publish failed again: %s", e)
            return False
        if self._failing:
            log.info("publishing the shallow-water alarm to SignalK again")
            self._failing = False
        return True


__all__ = ["MUTE_S", "REFRESH_S", "ShallowPublisher"]
