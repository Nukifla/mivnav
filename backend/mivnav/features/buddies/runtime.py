# SPDX-License-Identifier: GPL-2.0-only
"""The buddy list, its polling thread, and what each buddy resolves to."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from mivnav.feature import FeatureCtx
from mivnav.features.buddies import aiscast
from mivnav.features.buddies.model import Fix, Report, format_instant, newest, parse_instant
from mivnav.features.buddies.store import (
    Buddy,
    default_list_path,
    default_positions_path,
    read_buddies,
    read_positions,
    write_buddies,
    write_positions,
)
from mivnav.signalk import SignalKService

log = logging.getLogger(__name__)

#: How often aiscast is asked. The anonymous endpoint's limit is unknown and
#: a cruising boat's position does not need to be fresher than this.
POLL_INTERVAL_S = 180.0
#: SignalK is folded in on the same tick and on every read.
#: Disk writes are capped separately: the Pi's SD card has finite writes.
SAVE_INTERVAL_S = 600.0

Poll = Callable[[Sequence[str]], list[Report]]


class DuplicateBuddy(Exception):
    pass


class BuddiesRuntime:
    def __init__(
        self,
        signalk: Callable[[], SignalKService] | None = None,
        *,
        list_path: Path | None = None,
        positions_path: Path | None = None,
        poll: Poll = aiscast.poll,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._signalk = signalk
        self._list_path = list_path
        self._positions_path = positions_path
        self._poll = poll
        self._clock = clock
        self._lock = threading.RLock()
        self._poll_lock = threading.Lock()  # one network round at a time
        self._buddies: list[Buddy] | None = None
        #: mmsi -> {"static": {...}, "fixes": {source: Fix json}}. Keyed by
        #: identifier, not buddy id, so removing and re-adding keeps history.
        self._positions: dict[str, Any] = {}
        self._dirty = False
        self._saved_at = 0.0
        self._last_poll: dict[str, Any] = {}
        self._stop = threading.Event()
        self._wake = threading.Event()  # poll now, not at the next interval
        self._thread: threading.Thread | None = None

    # Resolved late: tests point XDG at a tmp dir after import.
    def _lists(self) -> Path:
        return self._list_path or default_list_path()

    def _positions_file(self) -> Path:
        return self._positions_path or default_positions_path()

    def _loaded(self) -> list[Buddy]:
        if self._buddies is None:
            self._buddies = read_buddies(self._lists())
            self._positions = read_positions(self._positions_file())
        return self._buddies

    def _start(self) -> None:
        """Lazily, on first use: building a Runtime must not reach the
        internet. A server nobody has opened has nothing to show anyway, and
        aiscast still has the position when someone does."""
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="buddies", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while True:
            self._wake.wait(POLL_INTERVAL_S)
            self._wake.clear()
            if self._stop.is_set():
                return
            self.refresh()

    # -- the list ----------------------------------------------------------

    def add(self, mmsi: str, nickname: str | None) -> dict[str, Any]:
        with self._lock:
            buddies = self._loaded()
            if any(b.mmsi == mmsi for b in buddies):
                raise DuplicateBuddy(mmsi)
            buddy = Buddy(id=uuid.uuid4().hex, nickname=nickname, mmsi=mmsi)
            write_buddies(self._lists(), [*buddies, buddy])
            buddies.append(buddy)
            self._start()
            # Never waited for: a slow or absent internet must not hold up the
            # button that asked. The position follows on the next read.
            self._wake.set()
            return self._wire(buddy, self._clock())

    def edit(
        self, buddy_id: str, nickname: str | None, note: str | None
    ) -> dict[str, Any] | None:
        with self._lock:
            buddies = self._loaded()
            buddy = next((b for b in buddies if b.id == buddy_id), None)
            if buddy is None:
                return None
            buddy.nickname = nickname
            buddy.note = note
            write_buddies(self._lists(), buddies)
            return self._wire(buddy, self._clock())

    def remove(self, buddy_id: str) -> bool:
        with self._lock:
            buddies = self._loaded()
            kept = [b for b in buddies if b.id != buddy_id]
            if len(kept) == len(buddies):
                return False
            write_buddies(self._lists(), kept)
            self._buddies = kept
            return True

    # -- positions ---------------------------------------------------------

    def refresh(self) -> None:
        """One round: aiscast, then SignalK's latest. A failed poll is
        recorded and nothing else changes: the boat is often offline, and
        then the saved positions simply get older."""
        with self._lock:
            mmsis = [b.mmsi for b in self._loaded() if b.mmsi]
        if not mmsis:
            return
        with self._poll_lock:
            try:
                reports = self._poll(mmsis)
                error = None
            except Exception as exc:  # noqa: BLE001 — offline is a normal state here
                log.info("buddy poll failed: %s", exc)
                reports, error = [], str(exc)
        now = self._clock()
        with self._lock:
            self._last_poll = {"atIso": format_instant(now), "ok": error is None}
            for report in reports:
                self._fold(report)
            self._fold_signalk(now)
            self._save(now)

    def _fold(self, report: Report) -> None:
        entry = self._positions.setdefault(report.mmsi, {"static": {}, "fixes": {}})
        previous = entry["fixes"].get(report.fix.source)
        if previous is None or report.fix.fix_at >= float(previous.get("fix_at", 0)):
            if previous != report.fix.to_json():
                entry["fixes"][report.fix.source] = report.fix.to_json()
                self._dirty = True
        for key, value in (
            ("name", report.name),
            ("callsign", report.callsign),
            ("shipTypeId", report.ship_type_id),
            ("lengthM", report.length_m),
        ):
            if value is not None and entry["static"].get(key) != value:
                entry["static"][key] = value
                self._dirty = True

    def _fold_signalk(self, now: float) -> None:
        if self._signalk is None:
            return
        mmsis = frozenset(b.mmsi for b in self._loaded() if b.mmsi)
        for raw in self._signalk().position_reports(mmsis):
            fix_at = parse_instant(raw.get("reportIso")) or raw.get("seenAt") or now
            self._fold(
                Report(
                    mmsi=raw["mmsi"],
                    fix=Fix(
                        source="signalk",
                        lat=raw["lat"],
                        lng=raw["lng"],
                        fix_at=float(fix_at),
                        via="online" if raw.get("online") else "local",
                        cog_deg=raw.get("cogDeg"),
                        sog_ms=raw.get("sogMs"),
                        heading_deg=raw.get("headingDeg"),
                    ),
                    name=raw.get("name"),
                    callsign=raw.get("callsign"),
                    ship_type_id=raw.get("shipTypeId"),
                    length_m=raw.get("lengthM"),
                )
            )

    def _save(self, now: float, *, force: bool = False) -> None:
        if not self._dirty or (not force and now - self._saved_at < SAVE_INTERVAL_S):
            return
        try:
            write_positions(self._positions_file(), self._positions)
        except OSError:
            log.exception("saving buddy positions failed")
            return
        self._dirty = False
        self._saved_at = now

    # -- reading -----------------------------------------------------------

    def _wire(self, buddy: Buddy, now: float) -> dict[str, Any]:
        entry = self._positions.get(buddy.mmsi or "", {})
        static = entry.get("static", {})
        fixes = []
        for raw in entry.get("fixes", {}).values():
            try:
                fixes.append(Fix.from_json(raw))
            except (KeyError, TypeError, ValueError):
                continue
        out: dict[str, Any] = {"id": buddy.id, **{k: v for k, v in static.items() if v is not None}}
        if "name" in out:
            out["aisName"] = out.pop("name")
        if buddy.nickname:
            out["nickname"] = buddy.nickname
        if buddy.note:
            out["note"] = buddy.note
        if buddy.mmsi:
            out["mmsi"] = buddy.mmsi
        best = newest(fixes, now)
        if best is not None:
            position: dict[str, Any] = {
                "lat": best.lat,
                "lng": best.lng,
                "source": best.source,
                "fixAtIso": format_instant(best.fix_at),
                # Worked out HERE, against one clock, and sent as an age: the
                # browser's clock is not comparable (no NTP at sea).
                "ageS": max(0.0, now - best.fix_at),
            }
            for key, value in (
                ("via", best.via),
                ("cogDeg", best.cog_deg),
                ("sogMs", best.sog_ms),
                ("headingDeg", best.heading_deg),
            ):
                if value is not None:
                    position[key] = value
            out["position"] = position
        return out

    def list(self) -> dict[str, Any]:
        with self._lock:
            buddies = self._loaded()
            self._start()
            first = not self._last_poll and any(b.mmsi for b in buddies)
            now = self._clock()
            self._fold_signalk(now)
        if first:
            # Outside the lock: a slow network must not stall writers.
            self.refresh()
        with self._lock:
            now = self._clock()
            return {
                "buddies": [self._wire(b, now) for b in self._loaded()],
                **({"lastPoll": self._last_poll} if self._last_poll else {}),
            }

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {"count": len(self._buddies or []), "last_poll": self._last_poll or None}

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        with self._lock:
            if self._buddies is not None:
                self._save(self._clock(), force=True)


def build_buddies_runtime(ctx: FeatureCtx) -> BuddiesRuntime:
    return BuddiesRuntime(ctx.signalk)
