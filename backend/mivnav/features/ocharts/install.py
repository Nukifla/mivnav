# SPDX-License-Identifier: GPL-2.0-only
"""Chart-set installer: shop download, plain zip URL, or uploaded zip →
installed set. Port of ochartsng's ChartInstaller pipeline. See
docs/architecture/ocharts-install-pipeline.md for the stage list and the
FNC prepare/on_installed hooks.
"""

from __future__ import annotations

import logging
import re
import shutil
import tempfile
import threading
import time
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from .editions import retire_superseded
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

#: ``prepare(unpacked_chart_dir) -> installed set id``; runs before the
#: test-open and before the target name is chosen.
PrepareHook = Callable[[Path], str]
#: ``on_installed(installed_set_dir)``, after the header scan has passed.
InstalledHook = Callable[[Path], None]

# The installed directory name doubles as a chart set id (`sets._ID_OK`).
_SET_ID_OK = re.compile(r"^[A-Za-z0-9._-]+$")


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

    def as_dict(self) -> dict:
        return self.__dict__.copy()


class Installer:
    """One background install at a time; status is poll-able."""

    def __init__(self, service: OchartsService, http: httpx.Client | None = None) -> None:
        self.service = service
        self._http = http or httpx.Client(
            timeout=httpx.Timeout(120.0, connect=30.0), follow_redirects=True
        )
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._status = JobStatus()

    def status(self) -> dict:
        with self._lock:
            return self._status.as_dict()

    def busy(self) -> bool:
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def _begin(self, detail: str) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                raise InstallError("an install is already running")
            self._status = JobStatus(state=ST_DOWNLOAD, detail=detail, started=time.time())

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
        try:
            job(*args)
            self._update(state=ST_DONE, finished=time.time())
        except Exception as e:  # noqa: BLE001 — reported via status
            log.warning("chart install failed: %s", e)
            self._update(state=ST_ERROR, error=str(e), finished=time.time())

    def _shop_job(self, chart_url: str, key_url: str, prepare: PrepareHook | None = None) -> None:
        with tempfile.TemporaryDirectory(prefix="mivnav-install-") as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "charts.zip"
            key_path = tmp_path / "keys.xml"
            self._download(chart_url, zip_path)
            self._download(key_url, key_path)
            self._install_pipeline(zip_path, key_path, prepare=prepare)

    def _url_job(
        self,
        chart_url: str,
        prepare: PrepareHook | None,
        on_installed: InstalledHook | None,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="mivnav-install-") as tmp:
            zip_path = Path(tmp) / "charts.zip"
            self._download(chart_url, zip_path)
            self._install_pipeline(zip_path, None, prepare=prepare, on_installed=on_installed)

    def _upload_job(self, zip_bytes: bytes) -> None:
        with tempfile.TemporaryDirectory(prefix="mivnav-install-") as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "charts.zip"
            zip_path.write_bytes(zip_bytes)
            self._install_pipeline(zip_path, None)

    def _upload_file_job(self, spooled: Path) -> None:
        try:
            with tempfile.TemporaryDirectory(prefix="mivnav-install-") as tmp:
                self._install_pipeline(spooled, None, unpack_root=Path(tmp))
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

    def _unpack(self, zip_path: Path, dest: Path) -> None:
        with zipfile.ZipFile(zip_path) as zf:
            for member in zf.infolist():
                # refuse traversal — resolved target must stay inside dest
                target = (dest / member.filename).resolve()
                if not target.is_relative_to(dest.resolve()):
                    raise InstallError(f"zip member escapes archive root: {member.filename}")
            zf.extractall(dest)

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
        self._unpack(zip_path, unpacked)
        chart_dir = self._find_chart_dir(unpacked)
        if key_path is not None and key_path.is_file():
            shutil.move(str(key_path), chart_dir / "keys.xml")

        # Before the overwrite check *and* before the test-open: the hook may
        # rename cells (which decides whether _test_open finds any at all) and
        # it names the installed directory.
        set_id = chart_dir.name
        if prepare is not None:
            set_id = prepare(chart_dir)
            if not _SET_ID_OK.match(set_id):
                raise InstallError(f"refusing unusable chart set name {set_id!r}")
        target = self.service.sets_dir / set_id
        if target.exists():
            raise InstallError(
                f"chart directory {set_id} is already installed "
                "(updates ship under a new name; delete the old set first)"
            )

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
