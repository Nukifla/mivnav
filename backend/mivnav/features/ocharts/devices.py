# SPDX-License-Identifier: GPL-2.0-only
"""Registered screens: at most five devices may show o-charts.

- A device is a browser holding the ``mivnav_device`` cookie (an
  HttpOnly, server-set token; a server-set cookie is the one browser
  storage Safari does not cap at seven days). Two browsers on one tablet
  are two devices; clearing site data makes a new one. There is no
  hardware identity a web page can read, so nothing closer is possible.
- Registering takes a name (the client suggests one, editable) and
  acceptance of every EULA the installed licensed sets ship. A set's EULA
  is the HTML file inside its directory (``EN_rrc_eula_…html``); its
  version is its hash, so a changed text must be accepted again — the
  device keeps its slot meanwhile but gets no o-charts until it does.
- A sixth device sees the five and removes one. **Anyone may remove any
  device**: this caps how many screens use the charts at once; it is not
  access control, and must never be treated as such. Every removal is
  logged.
- Nothing is enforced while no licensed (encrypted) set is installed:
  freenauticalchart.net sets are CC0 and ship no EULA.
- Unregistered devices lose o-charts tiles only — everything else,
  including free charts, keeps working (``/tiles/free``).

The list is state, not settings: ``$XDG_STATE_HOME/mivnav/devices.json``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .network import boat_network_refusal

if TYPE_CHECKING:
    from .service import OchartsService

log = logging.getLogger(__name__)

#: Devices that may show o-charts at once.
MAX_DEVICES = 5

#: The cookie a registered browser carries.
COOKIE = "mivnav_device"
#: Ten years: the cookie is the device's identity, it should not lapse.
COOKIE_MAX_AGE_S = 10 * 365 * 24 * 3600

MAX_NAME_LEN = 60

#: ``last_seen`` is kept in memory on every request but written to disk at
#: most this often — a tile request must not rewrite a file.
LAST_SEEN_FLUSH_S = 15 * 60


def default_devices_path() -> Path:
    state_home = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return state_home / "mivnav" / "devices.json"


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class DevicesFull(Exception):
    """Registering would make a sixth device."""


class UnknownDevice(KeyError):
    pass


def clean_name(name: str) -> str:
    """A device name as stored: trimmed, non-empty, at most ``MAX_NAME_LEN``."""
    cleaned = " ".join(name.split())
    if not cleaned:
        raise ValueError("a device name must not be empty")
    return cleaned[:MAX_NAME_LEN]


@dataclass
class Device:
    id: str
    name: str
    token_hash: str
    created: float
    last_seen: float
    #: EULA id -> when this device accepted it
    accepted: dict[str, float] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "created": self.created,
            "last_seen": self.last_seen,
        }


class DeviceStore:
    """The registered devices, one JSON file, thread-safe."""

    def __init__(self, path: Path | None = None, clock=time.time) -> None:
        self._path = path
        self._clock = clock
        self._lock = threading.Lock()
        self._devices: list[Device] | None = None
        self._flushed_seen: dict[str, float] = {}

    # Resolved late, like the buddies store: tests point XDG at a tmp dir.
    @property
    def path(self) -> Path:
        return self._path or default_devices_path()

    def _loaded(self) -> list[Device]:
        if self._devices is None:
            self._devices = self._read()
            self._flushed_seen = {d.id: d.last_seen for d in self._devices}
        return self._devices

    def _read(self) -> list[Device]:
        path = self.path
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            devices = [Device(**d) for d in raw["devices"]]
        except FileNotFoundError:
            return []
        except (OSError, ValueError, KeyError, TypeError) as e:
            # Losing the list costs each screen one re-registration; refusing
            # to start would cost o-charts on every screen. Keep the bad file
            # for inspection rather than overwrite it.
            aside = path.with_name(f"{path.name}.corrupt-{int(self._clock())}")
            log.error("device list %s unreadable (%s); moved to %s, starting empty", path, e, aside)
            try:
                path.replace(aside)
            except OSError:
                log.exception("could not move %s aside", path)
            return []
        return devices

    def _write(self) -> None:
        devices = self._loaded()
        path = self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump({"devices": [asdict(d) for d in devices]}, out, indent=2)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        self._flushed_seen = {d.id: d.last_seen for d in devices}

    def _find(self, device_id: str) -> Device:
        for d in self._loaded():
            if d.id == device_id:
                return d
        raise UnknownDevice(device_id)

    # -- reads ---------------------------------------------------------------

    def list(self) -> list[Device]:
        with self._lock:
            return [Device(**asdict(d)) for d in self._loaded()]

    def by_token(self, token: str | None, touch: bool = True) -> Device | None:
        """The device this cookie belongs to, or None. ``touch`` records it
        as seen now (written to disk at most every ``LAST_SEEN_FLUSH_S``)."""
        if not token:
            return None
        wanted = _token_hash(token)
        with self._lock:
            for d in self._loaded():
                if secrets.compare_digest(d.token_hash, wanted):
                    if touch:
                        now = self._clock()
                        d.last_seen = now
                        if now - self._flushed_seen.get(d.id, 0.0) >= LAST_SEEN_FLUSH_S:
                            try:
                                self._write()
                            except OSError:
                                log.exception("could not record device last-seen")
                    return Device(**asdict(d))
        return None

    # -- writes --------------------------------------------------------------

    def register(self, name: str, accepted: Iterable[str]) -> tuple[Device, str]:
        """A new device and its token (the cookie value — not stored, only
        its hash is). Raises :class:`DevicesFull` at ``MAX_DEVICES``."""
        name = clean_name(name)
        with self._lock:
            devices = self._loaded()
            if len(devices) >= MAX_DEVICES:
                raise DevicesFull()
            now = self._clock()
            token = secrets.token_urlsafe(32)
            device = Device(
                id=uuid.uuid4().hex[:12],
                name=name,
                token_hash=_token_hash(token),
                created=now,
                last_seen=now,
                accepted={eula: now for eula in accepted},
            )
            devices.append(device)
            self._write()
        log.info("o-charts device registered: %s (%s), %d of %d", name, device.id, len(devices), MAX_DEVICES)
        return Device(**asdict(device)), token

    def remove(self, device_id: str, by: Device | None = None) -> Device:
        with self._lock:
            devices = self._loaded()
            device = self._find(device_id)
            devices.remove(device)
            self._write()
        log.warning(
            "o-charts device removed: %s (%s), by %s",
            device.name,
            device.id,
            f"{by.name} ({by.id})" if by is not None else "an unregistered device",
        )
        return device

    def rename(self, device_id: str, name: str) -> Device:
        name = clean_name(name)
        with self._lock:
            device = self._find(device_id)
            device.name = name
            self._write()
            return Device(**asdict(device))

    def accept(self, device_id: str, eulas: Iterable[str]) -> Device:
        with self._lock:
            device = self._find(device_id)
            now = self._clock()
            for eula in eulas:
                device.accepted.setdefault(eula, now)
            self._write()
            return Device(**asdict(device))


# -- EULAs ---------------------------------------------------------------------


@dataclass(frozen=True)
class Eula:
    """One distinct EULA text among the installed licensed sets."""

    id: str  # hash of the file: its version
    path: Path
    #: names of the sets that ship it
    sets: tuple[str, ...]


def eula_files(directory: Path) -> list[Path]:
    """The EULA documents a set directory ships (``*eula*.htm[l]``)."""
    try:
        entries = list(directory.iterdir())
    except OSError:
        return []
    return sorted(
        p
        for p in entries
        if p.is_file() and "eula" in p.name.lower() and p.suffix.lower() in (".htm", ".html")
    )


def pick_eula(files: list[Path]) -> Path | None:
    """The one to show: English (``EN_…``) when a set ships several
    languages, else the first."""
    if not files:
        return None
    for p in files:
        if p.name.upper().startswith("EN_"):
            return p
    return files[0]


def _file_id(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def set_eula(directory: Path) -> tuple[str, Path] | None:
    """The EULA a set directory ships, as ``(id, path)`` — the id is the
    file's hash, its version — or None if it ships none (freenauticalchart.net
    sets). One rule for every reader: the device gate here and the installer's
    accept-before-install stage (.install, .eulas) must agree on the id.
    Raises OSError if the file cannot be read."""
    path = pick_eula(eula_files(directory))
    if path is None:
        return None
    return _file_id(path), path


class DeviceGate:
    """Who may see o-charts tiles, from the device list and the installed sets."""

    def __init__(
        self,
        store: DeviceStore,
        network_check: Callable[[str | None, str | None], str | None] = boat_network_refusal,
    ) -> None:
        self.store = store
        #: ``(peer host, X-Forwarded-For) -> None | why refused``: licensed
        #: content for the boat network only (.network). Injectable so tests,
        #: whose TestClient peer is the non-address ``"testclient"``, can
        #: say which network they stand for.
        self.network_check = network_check
        self._lock = threading.Lock()
        # (set id, sequence) per licensed set -> the EULAs they ship
        self._eula_memo: tuple[tuple[tuple[str, int], ...], tuple[Eula, ...]] | None = None

    @staticmethod
    def licensed_sets(service: OchartsService) -> list:
        return [cs for cs in service.sets().values() if cs.cells and service.licensed(cs)]

    def active(self, service: OchartsService) -> bool:
        """Is anything to enforce — is a licensed set installed?"""
        return bool(self.licensed_sets(service))

    def eulas(self, service: OchartsService) -> tuple[Eula, ...]:
        sets = sorted(self.licensed_sets(service), key=lambda cs: cs.id)
        key = tuple((cs.id, cs.sequence) for cs in sets)
        with self._lock:
            if self._eula_memo is not None and self._eula_memo[0] == key:
                return self._eula_memo[1]
        by_id: dict[str, tuple[Path, list[str]]] = {}
        for cs in sets:
            try:
                found = set_eula(cs.directory)
            except OSError:
                log.exception("unreadable EULA in %s", cs.directory)
                continue
            if found is None:
                continue
            eula_id, path = found
            by_id.setdefault(eula_id, (path, []))[1].append(cs.name)
        eulas = tuple(Eula(id=i, path=p, sets=tuple(names)) for i, (p, names) in sorted(by_id.items()))
        with self._lock:
            self._eula_memo = (key, eulas)
        return eulas

    def allowed(self, service: OchartsService, token: str | None) -> bool:
        """May this cookie's browser be served o-charts tiles?"""
        if not self.active(service):
            return True
        device = self.store.by_token(token)
        if device is None:
            return False
        return all(e.id in device.accepted for e in self.eulas(service))

    def status(self, service: OchartsService, token: str | None) -> dict[str, Any]:
        active = self.active(service)
        device = self.store.by_token(token)
        eulas = self.eulas(service) if active else ()
        accepted = device.accepted if device is not None else {}
        pending = [e for e in eulas if e.id not in accepted]
        return {
            "gate": active,
            "max": MAX_DEVICES,
            "count": len(self.store.list()),
            "registered": device is not None,
            # A cookie the list no longer knows: this browser was removed.
            "removed": bool(token) and device is None,
            "allowed": not active or (device is not None and not pending),
            "device": (
                {**device.public(), "seen_ago_s": 0.0, "current": True}
                if device is not None
                else None
            ),
            "eulas": [
                {"id": e.id, "sets": list(e.sets), "accepted": e.id in accepted} for e in eulas
            ],
        }
