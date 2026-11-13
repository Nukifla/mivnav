# SPDX-License-Identifier: GPL-2.0-only
"""Chart-set installer: shop download, plain zip URL, or uploaded zip →
installed set. Port of ochartsng's ChartInstaller pipeline. See
docs/architecture/ocharts-install-pipeline.md for the stage list and the
FNC prepare/on_installed hooks.

A set that ships a licence agreement (EULA) is not installed until someone
has accepted that text: the job stops in ``awaiting_eula`` with the unpacked
(still o-charts-encrypted) set kept in its staging dir, and :meth:`Installer.accept`
resumes it, :meth:`Installer.decline` deletes it. A text accepted before
(:mod:`.eulas`) does not stop it. Sets without one (freenauticalchart.net)
never stop.

Nor is a set installed after its licence period (``valid_to``) has ended;
see :mod:`.clock` for which date counts as today. Already installed sets
that expire later keep working (see :mod:`.licence`).

Staging dirs are named ``mivnav-ocharts-staging-<pid>-…`` in the temp dir;
:func:`sweep_stale_staging` removes the ones a crashed server left behind.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import stat
import tempfile
import threading
import time
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import httpx

from .clock import InstallClock, UntrustedClock
from .devices import set_eula
from .editions import retire_superseded
from .eulas import EulaAcceptances
from .keys import LEGACY_CHARTINFO, parse_set_info
from .sets import cell_files
from .service import OchartsService

log = logging.getLogger(__name__)

# marker files identifying "the" chart directory inside the zip
CHART_MARKERS = (LEGACY_CHARTINFO, "ChartList.XML", "chartlist.xml", "ChartList.xml")

ST_IDLE = "idle"
ST_DOWNLOAD = "download"
ST_UNPACK = "unpack"
ST_TEST = "test"
ST_PARSE = "parse"
ST_DONE = "done"
ST_ERROR = "error"
#: Unpacked and checked, waiting for a person to accept the set's EULA.
ST_EULA = "awaiting_eula"
#: The EULA was declined; the staged set was deleted, nothing installed.
ST_CANCELLED = "cancelled"

#: ``prepare(unpacked_chart_dir) -> installed set id``; runs before the
#: test-open and before the target name is chosen.
PrepareHook = Callable[[Path], str]
#: ``on_installed(installed_set_dir)``, after the header scan has passed.
InstalledHook = Callable[[Path], None]

# The installed directory name doubles as a chart set id (`sets._ID_OK`).
_SET_ID_OK = re.compile(r"^[A-Za-z0-9._-]+$")

#: Staging dir names: this prefix, the owning process's pid, mkdtemp's suffix.
STAGING_PREFIX = "mivnav-ocharts-staging-"
_STAGING_NAME = re.compile(rf"^{re.escape(STAGING_PREFIX)}(\d+)-[A-Za-z0-9_]+$")


class InstallError(Exception):
    pass


@dataclass
class JobStatus:
    state: str = ST_IDLE
    progress: int = 0  # percent within the current state (download only)
    detail: str = ""  # e.g. chart name
    error: str = ""
    set_id: str = ""  # installed directory name once known
    started: float = 0.0
    finished: float = 0.0
    #: While ``awaiting_eula``: ``{"id": eula id, "set": set name}``.
    eula: dict[str, str] | None = None

    def as_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class _Parked:
    """An install stopped for its EULA: what accepting it resumes."""

    staging: Path
    eula_id: str
    eula_path: Path
    set_name: str
    resume: Callable[[], None]


class _AwaitingEula(Exception):
    def __init__(self, eula_id: str, eula_path: Path, set_name: str, resume: Callable[[], None]):
        super().__init__(f"awaiting acceptance of EULA {eula_id}")
        self.eula_id = eula_id
        self.eula_path = eula_path
        self.set_name = set_name
        self.resume = resume


class Installer:
    """One background install at a time; status is poll-able. An install
    parked for its EULA holds that one place until accepted or declined."""

    def __init__(
        self,
        service: OchartsService,
        http: httpx.Client | None = None,
        acceptances: EulaAcceptances | None = None,
        clock: InstallClock | None = None,
    ) -> None:
        self.service = service
        self.clock = clock if clock is not None else InstallClock()
        self._http = http or httpx.Client(
            timeout=httpx.Timeout(120.0, connect=30.0), follow_redirects=True
        )
        self.acceptances = acceptances if acceptances is not None else EulaAcceptances()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._status = JobStatus()
        self._parked: _Parked | None = None

    def status(self) -> dict:
        with self._lock:
            return self._status.as_dict()

    def busy(self) -> bool:
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def parked(self) -> bool:
        """Is an install waiting for its EULA to be accepted or declined?"""
        with self._lock:
            return self._parked is not None

    def parked_eula(self) -> tuple[str, Path] | None:
        """``(eula id, path)`` of the staged set's EULA while parked — the
        text to show *before* anything is installed."""
        with self._lock:
            p = self._parked
            return (p.eula_id, p.eula_path) if p is not None else None

    def _begin(self, detail: str) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                raise InstallError("an install is already running")
            if self._parked is not None:
                raise InstallError(
                    "an install is waiting for its licence agreement; accept or decline it first"
                )
            self._status = JobStatus(state=ST_DOWNLOAD, detail=detail, started=time.time())

    # -- the EULA stage --------------------------------------------------------

    def accept(self, eula_id: str) -> None:
        """Accept the parked install's EULA and finish installing it."""
        with self._lock:
            parked = self._parked
            if parked is None:
                raise InstallError("no install is waiting for a licence agreement")
            if parked.eula_id != eula_id:
                raise InstallError("that is not the licence agreement this install waits for")
            # Recorded before anything is activated: the acceptance is what
            # makes installing allowed at all.
            self.acceptances.accept(eula_id, parked.set_name)
            self._parked = None
            self._status.state = ST_TEST
            self._status.eula = None
            self._thread = threading.Thread(
                target=self._guarded, args=(parked.staging, parked.resume), daemon=True
            )
            self._thread.start()

    def decline(self) -> None:
        """Decline the parked install's EULA: delete the staged set."""
        with self._lock:
            parked = self._parked
            if parked is None:
                raise InstallError("no install is waiting for a licence agreement")
            self._parked = None
            self._status.state = ST_CANCELLED
            self._status.eula = None
            self._status.finished = time.time()
        _remove_staging(parked.staging)
        log.info("chart install of %s cancelled: licence agreement declined", parked.set_name)

    def discard(self) -> None:
        """Drop a parked install without a decision (this installer is being
        replaced, or the server is stopping): its staging dir must not leak."""
        with self._lock:
            parked, self._parked = self._parked, None
        if parked is not None:
            _remove_staging(parked.staging)
            log.info("discarded the install of %s that waited for its licence agreement",
                     parked.set_name)

    def _update(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self._status, k, v)

    # -- entry points --------------------------------------------------------

    def install_from_shop(
        self,
        chart_url: str,
        key_url: str,
        detail: str = "",
        prepare: PrepareHook | None = None,
    ) -> None:
        """Start a background install from shop download URLs."""
        self._begin(detail)
        self._thread = threading.Thread(
            target=self._run_guarded,
            args=(self._shop_job, chart_url, key_url, prepare),
            daemon=True,
        )
        self._thread.start()

    def install_from_url(
        self,
        chart_url: str,
        detail: str = "",
        prepare: PrepareHook | None = None,
        on_installed: InstalledHook | None = None,
    ) -> None:
        """Start a background install from one plain (keyless) zip URL.

        The shop's two-URL, key-bearing flow is not the only way a set can
        arrive: a freely published archive is just a zip, and carries its own
        naming and provenance rules in the hooks. See
        :mod:`~mivnav.features.ocharts.fnc`.
        """
        self._begin(detail)
        self._thread = threading.Thread(
            target=self._run_guarded,
            args=(self._url_job, chart_url, prepare, on_installed),
            daemon=True,
        )
        self._thread.start()

    def install_zip_bytes(self, zip_bytes: bytes, detail: str = "upload") -> None:
        """Start a background install from an uploaded chart zip."""
        self._begin(detail)
        self._thread = threading.Thread(
            target=self._run_guarded, args=(self._upload_job, zip_bytes), daemon=True
        )
        self._thread.start()

    def install_zip_file(self, zip_path: Path, detail: str = "upload") -> None:
        """Start a background install from a zip already on disk (an
        upload spool file); the file is consumed (deleted) by the job."""
        self._begin(detail)
        self._thread = threading.Thread(
            target=self._run_guarded, args=(self._upload_file_job, zip_path), daemon=True
        )
        self._thread.start()

    # -- job bodies ----------------------------------------------------------

    def _run_guarded(self, job, *args) -> None:
        # The staging dir outlives the job when it parks for its EULA, so it
        # is not a TemporaryDirectory: _guarded (or decline/discard) removes it.
        staging = Path(tempfile.mkdtemp(prefix=f"{STAGING_PREFIX}{os.getpid()}-"))
        self._guarded(staging, lambda: job(staging, *args))

    def _guarded(self, staging: Path, body: Callable[[], None]) -> None:
        keep = False
        try:
            body()
            self._update(state=ST_DONE, finished=time.time())
        except _AwaitingEula as p:
            keep = True
            with self._lock:
                self._parked = _Parked(staging, p.eula_id, p.eula_path, p.set_name, p.resume)
                self._status.state = ST_EULA
                self._status.progress = 0
                self._status.eula = {"id": p.eula_id, "set": p.set_name}
            log.info("chart install of %s waits for its licence agreement (%s)",
                     p.set_name, p.eula_id)
        except Exception as e:  # noqa: BLE001 — reported via status
            log.warning("chart install failed: %s", e)
            self._update(state=ST_ERROR, error=str(e), finished=time.time())
        finally:
            if not keep:
                _remove_staging(staging)

    def _shop_job(
        self, staging: Path, chart_url: str, key_url: str, prepare: PrepareHook | None = None
    ) -> None:
        zip_path = staging / "charts.zip"
        key_path = staging / "keys.xml"
        self._download(chart_url, zip_path)
        self._download(key_url, key_path)
        self._install_pipeline(zip_path, key_path, prepare=prepare)

    def _url_job(
        self,
        staging: Path,
        chart_url: str,
        prepare: PrepareHook | None,
        on_installed: InstalledHook | None,
    ) -> None:
        zip_path = staging / "charts.zip"
        self._download(chart_url, zip_path)
        self._install_pipeline(zip_path, None, prepare=prepare, on_installed=on_installed)

    def _upload_job(self, staging: Path, zip_bytes: bytes) -> None:
        zip_path = staging / "charts.zip"
        zip_path.write_bytes(zip_bytes)
        self._install_pipeline(zip_path, None)

    def _upload_file_job(self, staging: Path, spooled: Path) -> None:
        try:
            self._install_pipeline(spooled, None, unpack_root=staging)
        finally:
            spooled.unlink(missing_ok=True)

    # -- pipeline ------------------------------------------------------------

    def _download(self, url: str, dest: Path) -> None:
        self._update(state=ST_DOWNLOAD, progress=0)
        with self._http.stream("GET", url) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length") or 0)
            done = 0
            with dest.open("wb") as out:
                for chunk in resp.iter_bytes(1 << 16):
                    out.write(chunk)
                    done += len(chunk)
                    if total:
                        self._update(progress=min(99, int(done * 100 / total)))
        self._update(progress=100)

    def _unpack(self, zip_path: Path, dest: Path) -> date | None:
        """Extract; return the date of the newest member (when the set was
        built — no correct clock reads earlier)."""
        with zipfile.ZipFile(zip_path) as zf:
            members = zf.infolist()
            for member in members:
                # refuse traversal — resolved target must stay inside dest
                target = (dest / member.filename).resolve()
                if not target.is_relative_to(dest.resolve()):
                    raise InstallError(f"zip member escapes archive root: {member.filename}")
            zf.extractall(dest)
        built = [date(*m.date_time[:3]) for m in members if m.date_time[0] > 1980]
        return max(built, default=None)

    def _check_period(self, chart_dir: Path, built: date | None) -> None:
        """o-charts policy: install only during the licence period."""
        valid_to = parse_set_info(chart_dir).valid_to
        if not valid_to:
            return  # no expiry (freenauticalchart.net)
        try:
            last_day = date.fromisoformat(valid_to)
        except ValueError:
            raise InstallError(
                f"{chart_dir.name} has an unreadable licence end date {valid_to!r}"
            ) from None
        try:
            today, source = self.clock.today(not_before=built)
        except UntrustedClock as e:
            raise InstallError(str(e)) from None
        if today > last_day:
            raise InstallError(
                f"the licence period of {chart_dir.name} ended on {valid_to} "
                f"(today is {today.isoformat()} by the {source}); "
                "an expired set cannot be installed"
            )

    def _find_chart_dir(self, unpacked: Path) -> Path:
        matches = [
            d
            for d in sorted(unpacked.iterdir())
            if d.is_dir() and any((d / marker).is_file() for marker in CHART_MARKERS)
        ]
        if not matches:
            raise InstallError("no chart directory (Chartinfo.txt/ChartList.XML) found in zip")
        if len(matches) > 1:
            names = ", ".join(d.name for d in matches)
            raise InstallError(f"multiple chart directories in zip: {names}")
        return matches[0]

    def _test_open(self, chart_dir: Path) -> None:
        """One real full open with the delivered key, before installing."""
        cells = cell_files(chart_dir)
        if not cells:
            raise InstallError(f"no chart cells found in {chart_dir.name}")
        info = parse_set_info(chart_dir)
        cell = cells[0]
        try:
            opened = self.service.open_cell(cell, info.key_for(cell))
        except Exception as e:
            raise InstallError(
                f"unable to read {cell.name} — possibly wrong key or "
                f"unregistered system ({e})"
            ) from e
        del opened

    def _install_pipeline(
        self,
        zip_path: Path,
        key_path: Path | None,
        unpack_root: Path | None = None,
        prepare: PrepareHook | None = None,
        on_installed: InstalledHook | None = None,
    ) -> None:
        self._update(state=ST_UNPACK, progress=0)
        unpacked = (unpack_root or zip_path.parent) / "unpacked"
        unpacked.mkdir()
        built = self._unpack(zip_path, unpacked)
        # Not needed past here, and a parked install may sit for days.
        zip_path.unlink(missing_ok=True)
        chart_dir = self._find_chart_dir(unpacked)
        if key_path is not None and key_path.is_file():
            shutil.move(str(key_path), chart_dir / "keys.xml")
        # keys.xml carries a shop set's ExpirationDate, so after the move.
        self._check_period(chart_dir, built)

        # Before the overwrite check *and* before the test-open: the hook may
        # rename cells (which decides whether _test_open finds any at all) and
        # it names the installed directory.
        set_id = chart_dir.name
        if prepare is not None:
            set_id = prepare(chart_dir)
            if not _SET_ID_OK.match(set_id):
                raise InstallError(f"refusing unusable chart set name {set_id!r}")
        self._check_target(set_id)

        # Accept before install (o-charts policy): a set whose EULA has not
        # been accepted stops here, before its cells are ever opened.
        try:
            eula = set_eula(chart_dir)
        except OSError as e:
            raise InstallError(f"unreadable licence agreement in {chart_dir.name}: {e}") from e
        if eula is not None and not self.acceptances.accepted(eula[0]):
            raise _AwaitingEula(
                eula[0],
                eula[1],
                _set_name(chart_dir, set_id),
                lambda: self._activate(chart_dir, set_id, on_installed, built),
            )
        self._activate(chart_dir, set_id, on_installed, built)

    def _check_target(self, set_id: str) -> Path:
        target = self.service.sets_dir / set_id
        if target.exists():
            raise InstallError(
                f"chart directory {set_id} is already installed "
                "(updates ship under a new name; delete the old set first)"
            )
        return target

    def _activate(
        self,
        chart_dir: Path,
        set_id: str,
        on_installed: InstalledHook | None,
        built: date | None = None,
    ) -> None:
        """Test-open, move into the sets dir, header-scan, retire the old."""
        # Again: a parked install can resume long after the first checks.
        target = self._check_target(set_id)
        self._check_period(chart_dir, built)
        self._update(state=ST_TEST)
        self._test_open(chart_dir)

        self.service.sets_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(chart_dir), target)
        self._update(state=ST_PARSE, set_id=target.name)
        self.service.invalidate()
        cs = self.service.get(target.name)
        if cs is None or not cs.cells:
            errors = "; ".join((cs.cell_errors if cs else {}).values()) or "no cells parsed"
            raise InstallError(f"installed set failed its header scan: {errors}")
        # Either way a superseded set may be removed here, which the store has
        # just scanned and cached — so re-invalidate rather than leave it
        # serving a directory that no longer exists. A source with its own
        # hook knows its own editions (see fnc.retire_previous); anything else
        # is a shop set, whose older editions its directory name gives away
        # however the zip arrived (see editions.retire_superseded).
        if on_installed is not None:
            on_installed(target)
        else:
            retire_superseded(self.service.sets_dir, target)
        self.service.invalidate()


def _set_name(chart_dir: Path, set_id: str) -> str:
    """The set's own title for the EULA prompt; its directory name if none."""
    try:
        return parse_set_info(chart_dir).title or set_id
    except Exception:  # noqa: BLE001 — only a label
        return set_id


def _remove_staging(staging: Path) -> None:
    """Delete a staging dir; never raises (it runs in finally blocks)."""
    try:
        shutil.rmtree(staging, ignore_errors=True)
    except Exception:  # noqa: BLE001
        log.exception("could not remove install staging dir %s", staging)


def sweep_stale_staging(root: Path | None = None) -> list[Path]:
    """Remove install staging dirs whose server process is gone — an install
    parked for its EULA keeps one until accept/decline, so a crash leaves it
    behind. Only our own names, owned by this user, whose pid is not running
    (a live server's parked install is never touched). Returns what it
    removed; never raises (it runs at startup)."""
    root = Path(root) if root is not None else Path(tempfile.gettempdir())
    removed: list[Path] = []
    try:
        entries = list(root.iterdir())
    except OSError:
        return removed
    for entry in entries:
        m = _STAGING_NAME.match(entry.name)
        if m is None:
            continue
        try:
            st = entry.lstat()
        except OSError:
            continue
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            continue
        if _pid_alive(int(m.group(1))):
            continue
        _remove_staging(entry)
        if not entry.exists():
            removed.append(entry)
            log.info("removed stale chart install staging dir %s", entry)
    return removed


def _pid_alive(pid: int) -> bool:
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # someone else's process: not ours to judge
    except OverflowError:
        return False
    return True
