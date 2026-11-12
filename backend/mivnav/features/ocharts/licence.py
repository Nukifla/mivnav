# SPDX-License-Identifier: GPL-2.0-only
"""Startup o-charts licence check, and the disk tile cache's machine key.

Chart data on the server's disk is encrypted and
bound to the machine (see :mod:`.disk_tiles`, "Encrypted at rest"), and on
every start mivnav checks that the o-charts licence is still good. If it is,
nothing happens. If it is not, the stored o-charts data is deleted.

**What "licence valid" means here** — deliberately not the expiry date: *can this machine still decrypt the set?* For each
installed set with encrypted cells, decode its smallest few cells through
oexserverd. That works offline (the boat has no internet, so a shop check
is not an option). ``valid_to`` is never consulted: an o-charts expiry ends
the update period, not the right to use the edition already installed.

Outcomes per set:

- ``ok`` — a cell decoded.
- ``refused`` — oexserverd refused (``DecryptError``: wrong key or
  unregistered fingerprint; ``ExpiredError``: the daemon itself would not
  decrypt) and nothing decoded. The set is taken out of the union tiles
  (:meth:`OchartsService.set_refused`), which changes the disk version; the
  switch below then deletes every stored tile that set reaches — the same
  carry-over machinery as uninstalling it. It is not repeated on the next
  start: a still-refused set leaves the version unchanged, so a boot does
  not re-render hours of tiles each time. A refused set that later decodes
  (re-registered, new keys) comes back as an added set and is re-rendered.
- ``unknown`` — oexserverd did not answer. Nothing is decided: the store
  stays locked (RAM-only serving, nothing read from or written to disk)
  and the check retries.
- ``unchecked`` — every probed cell failed for some *other* reason (a
  corrupt file). Not evidence about the licence; treated as not refused.

A different machine needs no check at all: its fingerprint (the stable
part, :func:`machine_identity`) derives a different key, and :meth:`DiskTileStore.unlock` wipes what it cannot open.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING

import chartcore
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .sets import cell_files

if TYPE_CHECKING:
    from .service import OchartsService
    from .sets import OchartsSet

log = logging.getLogger(__name__)

#: Cells tried per set, smallest first: one is enough when it decodes; a
#: few more keep one corrupt file from deciding anything.
PROBE_CELLS = 3

#: Between attempts while the fingerprint or oexserverd is unavailable.
RETRY_S = 60.0


_FPR_STAMP = re.compile(r"_(\d+)\.fpr$")
_FPR_MAC = re.compile(r'<NET\b[^>]*\bMAC="([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})"')
_FPR_UUID = re.compile(r'<UUID\b[^>]*\bI1="([^"]+)"')


def machine_identity(fpr_name: str, fpr_hex: str) -> str:
    """The stable part of an ``oexserverd -g`` fingerprint, as the disk key's
    input.

    The raw fingerprint is useless as a key: it is a small XML document
    XOR-ed with the generation time's decimal Unix stamp (the one in the
    file name, ``oc03L_<stamp>.fpr``), and it carries that time again in a
    ``<DATE>`` element, so its bytes change every second — every restart
    derived a new key and wiped the cache (measured on the boat's Pi,
    2026-11-06). Its ``<NET>`` list is not stable either: it names every
    interface, docker bridges and veths included, whose names and MACs
    come and go with containers.

    So the identity is the ``<UUID>`` (a filesystem UUID) plus the
    globally unique MACs — the locally-administered bit clear, i.e. burned
    into hardware (the Pi's eth0 and wlan0), not made up by software (docker,
    veth, an AP interface). ValueError when it does not decode as expected:
    the caller keeps the store locked rather than wiping it under a bad key.
    """
    stamp = _FPR_STAMP.search(fpr_name)
    if stamp is None:
        raise ValueError(f"no time stamp in fingerprint name {fpr_name!r}")
    pad = stamp.group(1).encode()
    raw = bytes.fromhex(fpr_hex)
    try:
        text = bytes(b ^ pad[i % len(pad)] for i, b in enumerate(raw)).decode("ascii")
    except UnicodeDecodeError:
        raise ValueError("fingerprint does not decode to text") from None
    uuid = _FPR_UUID.search(text)
    if uuid is None:
        raise ValueError("fingerprint has no UUID")
    macs = sorted(
        {
            m.lower()
            for m in _FPR_MAC.findall(text)
            if not int(m[:2], 16) & 0x02 and m.strip("0:")  # universal, not 00:…
        }
    )
    return "uuid=" + uuid.group(1).lower() + ";mac=" + ",".join(macs)


def disk_key(fpr_name: str, fpr_hex: str) -> bytes:
    """The disk cache key for this machine — see :func:`machine_identity`."""
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"mivnav disk tile cache",
        info=b"chacha20-poly1305 v1",
    ).derive(machine_identity(fpr_name, fpr_hex).encode())


def probe_set(service: OchartsService, cs: OchartsSet) -> tuple[str, str]:
    """(outcome, detail) for one set — see the module docs. ``none`` for a
    set without encrypted cells (freenauticalchart.net: nothing to license)."""
    try:
        paths = [p for p in cell_files(cs.directory) if service._needs_daemon(p)]
    except OSError as e:
        return "unknown", f"cannot list the set: {e}"
    if not paths:
        return "none", ""
    paths.sort(key=lambda p: (_size(p), p.name))
    refused = ""
    other = ""
    for path in paths[:PROBE_CELLS]:
        try:
            service.open_cell(path, cs.info.key_for(path))
        except (chartcore.DecryptError, chartcore.ExpiredError) as e:
            refused = refused or f"{path.name}: {e}"
            continue
        except chartcore.DaemonError as e:
            return "unknown", f"oexserverd: {e}"
        except RuntimeError as e:  # DaemonUnavailable, and kin
            return "unknown", str(e)
        except Exception as e:  # noqa: BLE001 — a corrupt cell says nothing about the licence
            other = other or f"{path.name}: {e}"
            continue
        return "ok", path.name
    if refused:
        return "refused", refused
    return "unchecked", other


def _size(path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 1 << 62


class LicenceCheck:
    """Runs once per service: get the key, unlock the disk store, probe
    every set, drop what is refused, open the store. Retries only while
    the outcome is undecidable."""

    def __init__(
        self,
        service: OchartsService,
        key_source: Callable[[], bytes],
        retry_s: float = RETRY_S,
    ) -> None:
        self._service = service
        self._key_source = key_source
        self._retry_s = retry_s
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._status: dict = {"state": "pending", "sets": {}, "error": "", "checked_at": None}

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="ocharts-licence", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=10)

    def wait(self, timeout: float | None = None) -> bool:
        """Block until the check is decided (tests)."""
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
        return self.status()["state"] in ("ok", "refused")

    def status(self) -> dict:
        with self._lock:
            return {**self._status, "sets": dict(self._status["sets"])}

    def _set(self, **fields) -> None:
        with self._lock:
            self._status.update(fields)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if self.run_once():
                    return
            except Exception as e:  # noqa: BLE001 — the check must not die silently
                log.exception("o-charts licence check failed")
                self._set(state="retrying", error=str(e))
            if self._stop.wait(self._retry_s):
                return

    def run_once(self) -> bool:
        """One attempt. True once decided (whatever the verdict)."""
        svc = self._service
        disk = svc.disk_tiles
        self._set(state="checking")
        try:
            key = self._key_source()
        except Exception as e:  # noqa: BLE001 — DaemonError, a missing binary offline, …
            reason = f"machine fingerprint unavailable: {e}"
            disk.locked_reason = reason
            self._set(state="retrying", error=reason)
            log.warning("disk tile cache stays locked: %s", reason)
            return False
        disk.unlock(key)  # wipes a foreign or pre-encryption cache first

        results: dict[str, dict] = {}
        for cs in sorted(svc.sets().values(), key=lambda c: c.id):
            if self._stop.is_set():
                return True
            outcome, detail = probe_set(svc, cs)
            results[cs.id] = {"outcome": outcome, "detail": detail, "sequence": cs.sequence}
        self._set(sets=results)
        unknown = [sid for sid, r in results.items() if r["outcome"] == "unknown"]
        if unknown:
            reason = "could not check the licence of " + ", ".join(
                f"{sid} ({results[sid]['detail']})" for sid in unknown
            )
            disk.locked_reason = reason
            self._set(state="retrying", error=reason)
            log.warning("disk tile cache stays locked: %s", reason)
            return False

        refused = {(sid, r["sequence"]) for sid, r in results.items() if r["outcome"] == "refused"}
        for sid, _seq in sorted(refused):
            log.warning(
                "o-charts licence: this machine cannot decrypt set %s (%s); "
                "deleting its stored tiles and leaving it out of the charts",
                sid, results[sid]["detail"],
            )
        svc.set_refused(frozenset(refused))
        # Move to the version without the refused sets and delete the rest
        # — without waiting for the pre-render (it may be switched off).
        version, manifest = svc.disk_manifest()
        if disk.read_manifest(version) is None:
            disk.carry_over(version, manifest, self._stop.is_set)
            if self._stop.is_set():
                return True
            disk.write_manifest(version, manifest)
        disk.prune(version)
        disk.mark_ready()
        self._set(
            state="refused" if refused else "ok",
            error="",
            checked_at=time.time(),
        )
        log.info(
            "o-charts licence check: %d set(s) ok, %d refused; disk tile cache open",
            sum(1 for r in results.values() if r["outcome"] == "ok"),
            len(refused),
        )
        return True
