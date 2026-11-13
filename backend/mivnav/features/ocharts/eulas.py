# SPDX-License-Identifier: GPL-2.0-only
"""Install-level EULA acceptances: which licence agreements someone accepted
*before* a set carrying them was installed (o-charts policy: "accept the
licensing conditions as presented by the EULA ... before the install and use
of the licensed chart material").

An EULA is identified by the hash of the ``EN_rrc_eula_…html`` its set ships
(:func:`.devices.set_eula`), so a changed text is a new id and must be
accepted again; an update carrying an unchanged text installs unattended.
This is separate from, and in addition to, the per-device acceptance in
:mod:`.devices` (that one covers *use*, per screen).

State, not settings: ``$XDG_STATE_HOME/mivnav/eula-acceptances.json``, next
to ``devices.json``.

Upgrade from before this file existed: on first load, every EULA a
registered device has accepted is taken as accepted at install level too
(``via: "device"``) — those sets are installed and in use already, and
blocking their next same-text update would be no protection, only friction.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .devices import DeviceStore

log = logging.getLogger(__name__)


def default_acceptances_path() -> Path:
    state_home = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return state_home / "mivnav" / "eula-acceptances.json"


class EulaAcceptances:
    """EULA id -> ``{"accepted_at", "sets", "via"}``; one JSON file,
    thread-safe."""

    def __init__(
        self,
        path: Path | None = None,
        devices: DeviceStore | None = None,
        clock=time.time,
    ) -> None:
        self._path = path
        self._devices = devices
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, dict[str, Any]] | None = None

    # Resolved late, like DeviceStore: tests point XDG at a tmp dir.
    @property
    def path(self) -> Path:
        return self._path or default_acceptances_path()

    def _loaded(self) -> dict[str, dict[str, Any]]:
        if self._entries is None:
            entries = self._read()
            migrate = entries is None
            self._entries = self._migrated() if entries is None else entries
            if migrate:
                try:
                    self._write()
                except OSError:
                    log.exception("could not write %s", self.path)
        return self._entries

    def _read(self) -> dict[str, dict[str, Any]] | None:
        """The file's entries, or None if there is no file yet."""
        path = self.path
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            entries = raw["accepted"]
            if not isinstance(entries, dict):
                raise TypeError("'accepted' is not an object")
            return {str(k): dict(v) for k, v in entries.items()}
        except FileNotFoundError:
            return None
        except (OSError, ValueError, KeyError, TypeError) as e:
            # Losing it costs one more "accept" click per EULA, at the next
            # install; nothing installed stops working. Keep the bad file.
            aside = path.with_name(f"{path.name}.corrupt-{int(self._clock())}")
            log.error("EULA acceptances %s unreadable (%s); moved to %s", path, e, aside)
            try:
                path.replace(aside)
            except OSError:
                log.exception("could not move %s aside", path)
            return {}

    def _migrated(self) -> dict[str, dict[str, Any]]:
        """First start with this file: what the registered devices accepted."""
        entries: dict[str, dict[str, Any]] = {}
        if self._devices is None:
            return entries
        for device in self._devices.list():
            for eula_id, at in device.accepted.items():
                entry = entries.get(eula_id)
                if entry is None or at < entry["accepted_at"]:
                    entries[eula_id] = {"accepted_at": at, "sets": [], "via": "device"}
        if entries:
            log.info(
                "EULA acceptances: %d taken over from registered devices", len(entries)
            )
        return entries

    def _write(self) -> None:
        entries = self._entries or {}
        path = self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump({"accepted": entries}, out, indent=2)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    # -- reads ---------------------------------------------------------------

    def accepted(self, eula_id: str) -> bool:
        with self._lock:
            return eula_id in self._loaded()

    def get(self, eula_id: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._loaded().get(eula_id)
            return dict(entry) if entry is not None else None

    # -- writes --------------------------------------------------------------

    def accept(self, eula_id: str, set_name: str) -> dict[str, Any]:
        """Record that ``eula_id`` was accepted to install ``set_name``. The
        first acceptance's time is kept; later sets are added to it."""
        with self._lock:
            entries = self._loaded()
            entry = entries.setdefault(
                eula_id, {"accepted_at": self._clock(), "sets": [], "via": "install"}
            )
            if set_name and set_name not in entry["sets"]:
                entry["sets"].append(set_name)
            self._write()
            log.info("EULA %s accepted for install of %s", eula_id, set_name)
            return dict(entry)
