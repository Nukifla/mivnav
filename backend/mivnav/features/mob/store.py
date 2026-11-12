# SPDX-License-Identifier: GPL-2.0-only
"""The one active MOB, persisted on the always-on server.

``$XDG_STATE_HOME/mivnav/mob.json`` — state, not config: it is written by
a button, never hand-edited, and must survive a mivnav restart (or a
power blip on the Pi) mid-recovery. This file, not SignalK, is the source
of truth: a MOB has to keep alarming on every screen with the SignalK box
down, and SignalK forgets notifications on restart.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def default_mob_path() -> Path:
    state_home = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return state_home / "mivnav" / "mob.json"


@dataclass(frozen=True)
class Mob:
    #: A uuid — also the SignalK waypoint resource id, so no mapping to keep.
    id: str
    #: When the button was pressed, ISO 8601 UTC.
    at: str
    #: Where. ``None`` when there was no fix at all: the alarm still goes
    #: up (the crew need it more, not less), only the mark is missing.
    lat: float | None
    lng: float | None
    #: Who raised it: ``"button"`` (a mivnav screen) — room for an AIS MOB
    #: device later.
    source: str = "button"

    def wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "at": self.at, "source": self.source}
        if self.lat is not None and self.lng is not None:
            out["lat"] = self.lat
            out["lng"] = self.lng
        return out

    @property
    def has_position(self) -> bool:
        return self.lat is not None and self.lng is not None


class MobStore:
    """Thread-safe; every mutation is written through before it returns.
    The path is resolved on each use, so a test pointing ``XDG_STATE_HOME``
    at a tmp dir after import still isolates it."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._loaded = False
        self._mob: Mob | None = None

    @property
    def path(self) -> Path:
        return self._path or default_mob_path()

    def active(self) -> Mob | None:
        with self._lock:
            self._load()
            return self._mob

    def activate(
        self, lat: float | None, lng: float | None, *, source: str = "button", now: datetime | None = None
    ) -> tuple[Mob, bool]:
        """Drop the mark — or, if one is already up, keep it: a second tap
        (another screen, a panicked double press) must never move the mark
        away from where the person went in. Returns ``(mob, created)``."""
        with self._lock:
            self._load()
            if self._mob is not None:
                return self._mob, False
            at = (now or datetime.now(UTC)).astimezone(UTC).isoformat(timespec="seconds")
            mob = Mob(id=str(uuid.uuid4()), at=at, lat=lat, lng=lng, source=source)
            self._write(mob)
            self._mob = mob
            log.warning("MOB raised at %s (%s, %s)", at, lat, lng)
            return mob, True

    def clear(self) -> Mob | None:
        """End the MOB — an explicit human act. Returns what was cleared."""
        with self._lock:
            self._load()
            old, self._mob = self._mob, None
            if old is not None:
                self._write(None)
                log.warning("MOB %s cleared", old.id)
            return old

    # -- disk -------------------------------------------------------------

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        path = self.path
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            active = raw.get("active")
            if isinstance(active, dict):
                self._mob = Mob(
                    id=str(active["id"]),
                    at=str(active["at"]),
                    lat=_num(active.get("lat")),
                    lng=_num(active.get("lng")),
                    source=str(active.get("source") or "button"),
                )
        except (OSError, ValueError, KeyError, TypeError) as e:
            # Unreadable: say so loudly, keep running. A lost MOB is bad,
            # but a server that will not start is worse.
            log.error("could not read the MOB state at %s: %s", path, e)

    def _write(self, mob: Mob | None) -> None:
        path = self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump({"active": asdict(mob) if mob else None}, out, indent=2)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None
