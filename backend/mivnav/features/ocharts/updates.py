# SPDX-License-Identifier: GPL-2.0-only
"""Chart updates: find the installed sets the o-charts shop has a newer
edition of, install those, do the same for the installed freenauticalchart.net
regions, and do it all unattended on a clock.

The comparison is ochartsng's (gui/src/ShopView.js ``findLocalChart`` +
``compareEdition``: a shop chart is the installed set with the same chart id,
and it is an update when its edition is newer); the unattended loop is ours.
See docs/architecture/ocharts-updates.md.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, cast

from . import fnc
from .editions import chart_code, is_newer
from .install import ST_ERROR, InstallError, Installer
from .service import OchartsService
from .shop import Credentials, ShopChart, ShopClient, ShopError

if TYPE_CHECKING:
    from mivnav.api.deps import Runtime
    from mivnav.config.model import Config

    from .runtime import OchartsRuntime

log = logging.getLogger(__name__)

ST_IDLE = "idle"
ST_CHECKING = "checking"
ST_INSTALLING = "installing"

#: Hardcoded, not config: plumbing, like the dataset scheduler's poll interval.
#: The shop publishes roughly weekly, so a day is prompt; the wake-up is short
#: so that switching auto-update on (or saving a login) acts within minutes
#: rather than at the next daily slot.
CHECK_INTERVAL_S = 24 * 3600.0
#: After a check that failed — at sea there is no internet at all, so this is
#: the normal case, and one login attempt an hour is what it costs.
RETRY_INTERVAL_S = 3600.0
POLL_INTERVAL_S = 300.0

_STOP_TIMEOUT = 10.0


class UpdateError(Exception):
    pass


@dataclass(frozen=True)
class ChartUpdate:
    """One installed set the shop has a newer edition of."""

    chart_id: str
    name: str
    set_id: str  # the installed set it would replace
    installed_edition: str
    available_edition: str
    slot_uuid: str


def credentials_from(config: "Config") -> Credentials | None:
    """The o-charts login from the config, or None if not set up."""
    creds = config.credentials.ocharts
    password = creds.password.get_secret_value()
    if not creds.user or not password:
        return None
    return Credentials(user=creds.user, password=password)


def find_updates(
    charts: list[ShopChart], system_name: str, installed: dict[str, tuple[str, str]]
) -> list[ChartUpdate]:
    """The shop charts that are a newer edition of something installed.

    ``installed`` maps chart id -> (set id, edition). Only a chart with a slot
    *already assigned to this system* counts: an update re-downloads through
    that slot, where a chart without one would have to be assigned first —
    which spends a licence slot, and is never done unattended. Neither is a
    chart that is not installed at all: that is a purchase decision, not an
    update. Expired entries are skipped as the reference does (an account
    lists last year's ``DK`` beside this year's, under the same id).
    """
    found: dict[str, ChartUpdate] = {}
    for chart in charts:
        if chart.expired or chart.chart_id not in installed:
            continue
        slot = next((s for s in chart.slots if s.assigned_system == system_name), None)
        if slot is None:
            continue
        set_id, edition = installed[chart.chart_id]
        if not is_newer(chart.edition, edition):
            continue
        best = found.get(chart.chart_id)
        if best is not None and not is_newer(chart.edition, best.available_edition):
            continue
        found[chart.chart_id] = ChartUpdate(
            chart_id=chart.chart_id,
            name=chart.name,
            set_id=set_id,
            installed_edition=edition,
            available_edition=chart.edition,
            slot_uuid=slot.slot_uuid,
        )
    return list(found.values())


def installed_editions(service: OchartsService) -> dict[str, tuple[str, str]]:
    """Chart id -> (set id, edition) of the newest installed set of each shop
    chart. Sets the shop did not name (FNC, hand-made) are not in it."""
    newest: dict[str, tuple[str, str]] = {}
    for cs in service.sets().values():
        code = chart_code(cs.id)
        if code is None:
            continue
        current = newest.get(code)
        if current is None or is_newer(cs.info.edition, current[1]):
            newest[code] = (cs.id, cs.info.edition)
    return newest


def _expect_chart(chart_id: str) -> Callable[[Path], str]:
    """The installer's ``prepare`` hook for an update: the zip must be the
    chart that was asked for (the reference's ``testChartSet`` id check), or
    a mix-up would install a stranger and retire nothing."""

    def _prepare(chart_dir: Path) -> str:
        if chart_code(chart_dir.name) != chart_id:
            raise UpdateError(
                f"the shop delivered {chart_dir.name}, which is not chart {chart_id}"
            )
        return chart_dir.name

    return _prepare


class Updater:
    """The last check's findings and the one update run that may be going.

    Holds no service, installer or credentials — each call is handed the
    current ones, since all three can be replaced by a config change.
    """

    def __init__(
        self,
        shop: Callable[[Credentials], ShopClient] = ShopClient,
        fnc_client: Callable[[], fnc.FncClient] = fnc.FncClient,
    ) -> None:
        self._shop = shop
        self._fnc = fnc_client
        # freenauticalchart.net, checked on every run beside the shop: when
        # the publisher was last asked, and what went wrong if anything did.
        self._fnc_checked_at: float | None = None
        self._fnc_error = ""
        self._lock = threading.Lock()  # guards the fields below
        self._running = threading.Lock()  # held for a whole check/run
        self._state = ST_IDLE
        self._checked_at: float | None = None
        self._error = ""
        self._system_name = ""
        self._updates: list[ChartUpdate] = []
        self._installed: list[dict] = []
        # (chart id, edition) -> error, for editions whose install failed.
        # Not retried unattended: a zip that fails its test-open today fails
        # it tomorrow, and each attempt is the whole download again. In
        # memory only, so a restart (or a manual run) tries once more.
        self._failed: dict[tuple[str, str], str] = {}

    def status(self) -> dict:
        with self._lock:
            return {
                "state": self._state,
                "checked_at": self._checked_at,
                "error": self._error,
                "system_name": self._system_name,
                "updates": [
                    {**asdict(u), "failed": self._failed.get((u.chart_id, u.available_edition), "")}
                    for u in self._updates
                ],
                "installed": list(self._installed),
                "fnc": {"checked_at": self._fnc_checked_at, "error": self._fnc_error},
            }

    def busy(self) -> bool:
        return self._running.locked()

    # -- check ---------------------------------------------------------------

    def check(self, service: OchartsService, creds: Credentials) -> list[ChartUpdate]:
        """Ask the shop; record and return what could be updated. Raises
        :class:`UpdateError` if a check or run is already going."""
        if not self._running.acquire(blocking=False):
            raise UpdateError("an update check is already running")
        try:
            return self._check(service, creds)
        finally:
            self._set(state=ST_IDLE)
            self._running.release()

    def _check(self, service: OchartsService, creds: Credentials) -> list[ChartUpdate]:
        self._set(state=ST_CHECKING)
        try:
            fpr_name, fpr_value = service.fingerprint()
            client = self._shop(creds)
            try:
                system_name = client.identify_system(fpr_name, fpr_value)
                if system_name is None:
                    raise UpdateError("this system is not registered at o-charts.org")
                _, charts = client.chart_list()
            finally:
                client.close()
        except Exception as e:  # noqa: BLE001 — reported via status
            self._set(checked_at=time.time(), error=str(e), updates=[])
            raise
        updates = find_updates(charts, system_name, installed_editions(service))
        self._set(checked_at=time.time(), error="", system_name=system_name, updates=updates)
        return updates

    # -- run -----------------------------------------------------------------

    def start(
        self, service: OchartsService, installer: Installer, creds: Credentials | None
    ) -> None:
        """Check and install every update in the background. A manual run, so
        editions that failed before are tried again."""
        if self.busy():
            raise UpdateError("an update is already running")
        self._set(state=ST_CHECKING)  # so the caller's status read is not a stale "idle"
        threading.Thread(
            target=self.run,
            args=(service, installer, creds),
            kwargs={"retry_failed": True},
            name="ocharts-update",
            daemon=True,
        ).start()

    def run(
        self,
        service: OchartsService,
        installer: Installer,
        creds: Credentials | None,
        stop: threading.Event | None = None,
        retry_failed: bool = False,
    ) -> None:
        """Update the shop's sets (given a login), then the
        freenauticalchart.net ones — one install at a time. Never raises: the
        outcome is in :meth:`status`."""
        if not self._running.acquire(blocking=False):
            return
        try:
            if creds is not None and not self._update_shop(
                service, installer, creds, stop, retry_failed
            ):
                return
            self._update_fnc(service, installer, stop, retry_failed)
        finally:
            self._set(state=ST_IDLE)
            self._running.release()

    def _update_shop(
        self,
        service: OchartsService,
        installer: Installer,
        creds: Credentials,
        stop: threading.Event | None,
        retry_failed: bool,
    ) -> bool:
        """False if ``stop`` fired; a shop that cannot be reached is True —
        the free charts come from somewhere else and are still worth asking."""
        try:
            updates = self._check(service, creds)
        except Exception as e:  # noqa: BLE001 — already recorded by _check
            log.info("o-charts update check failed: %s", e)
            return True
        self._set(state=ST_INSTALLING)
        for update in updates:
            key = (update.chart_id, update.available_edition)
            if key in self._failed and not retry_failed:
                continue
            if stop is not None and stop.is_set():
                return False
            error = self._install(installer, creds, update, stop)
            if error is None:
                return False  # stopped mid-install; nothing to record yet
            if error:
                log.warning("o-charts update of %s failed: %s", update.name, error)
                with self._lock:
                    self._failed[key] = error
                continue
            log.info(
                "o-charts %s updated: %s -> %s",
                update.name, update.installed_edition, update.available_edition,
            )
            with self._lock:
                self._failed.pop(key, None)
                self._updates = [u for u in self._updates if u != update]
            self._record_installed(update.chart_id, update.name, update.available_edition)
        return True

    def _update_fnc(
        self,
        service: OchartsService,
        installer: Installer,
        stop: threading.Event | None,
        retry_failed: bool,
    ) -> None:
        """Update each *installed* freenauticalchart.net region whose zip has
        changed at the publisher. One HEAD per installed region; a region that
        is not installed is not asked about, so a boat without free charts
        makes no request at all. The install itself is the same one the
        Charts panel's button starts (``POST /ocharts/fnc/install``)."""
        sets_dir = service.sets_dir
        regions = [r for r in fnc.REGIONS.values() if fnc.installed_marker(sets_dir, r.id)]
        if not regions:
            return
        self._set(state=ST_INSTALLING)
        client = self._fnc()
        errors: list[str] = []
        for region in regions:
            if stop is not None and stop.is_set():
                return
            try:
                version = client.version(region.id)
            except fnc.FncError as e:
                errors.append(str(e))
                continue
            installed = fnc.installed_marker(sets_dir, region.id)
            if not fnc.update_available(version.as_dict(), installed):
                continue
            # The publisher's own identity for the bytes, as update_available
            # compares it: a new zip is a new key, and is tried.
            key = (f"fnc-{region.id}", version.etag or version.last_modified)
            if key in self._failed and not retry_failed:
                errors.append(f"{region.label}: {self._failed[key]}")
                continue
            edition = version.published or "latest"
            try:
                installer.install_from_url(
                    region.url,
                    detail=f"{region.label} — update to {edition}",
                    prepare=fnc.prepare(version),
                    on_installed=fnc.on_installed(sets_dir, region.id),
                )
            except InstallError as e:
                errors.append(str(e))
                break
            error = self._wait(installer, stop)
            if error is None:
                return
            if error:
                log.warning("freenauticalchart %s update failed: %s", region.id, error)
                with self._lock:
                    self._failed[key] = error
                errors.append(f"{region.label}: {error}")
                continue
            log.info("freenauticalchart %s updated to %s", region.id, edition)
            self._record_installed(f"fnc-{region.id}", region.label, edition)
        self._set(fnc_checked_at=time.time(), fnc_error="; ".join(errors))

    def _record_installed(self, chart_id: str, name: str, edition: str) -> None:
        with self._lock:
            self._installed.append(
                {"chart_id": chart_id, "name": name, "edition": edition, "at": time.time()}
            )

    def _install(
        self,
        installer: Installer,
        creds: Credentials,
        update: ChartUpdate,
        stop: threading.Event | None,
    ) -> str | None:
        """Install one update and wait for it. ``""`` on success, the error
        text on failure, None if ``stop`` fired while it was still running."""
        try:
            # A session of its own: the previous chart's download may have
            # outlasted the last one.
            client = self._shop(creds)
            try:
                urls = client.download_urls(
                    self.status()["system_name"], update.slot_uuid, update.available_edition
                )
            finally:
                client.close()
            installer.install_from_shop(
                urls.chart_url,
                urls.key_url,
                detail=f"{update.name} — update to {update.available_edition}",
                prepare=_expect_chart(update.chart_id),
            )
        except (ShopError, InstallError) as e:
            return str(e)
        return self._wait(installer, stop)

    @staticmethod
    def _wait(installer: Installer, stop: threading.Event | None) -> str | None:
        """Wait out the running install. ``""`` on success, the error text on
        failure, None if ``stop`` fired first."""
        while installer.busy():
            if stop is not None:
                if stop.wait(0.5):
                    return None
            else:
                time.sleep(0.5)
        st = installer.status()
        return st["error"] or "install failed" if st["state"] == ST_ERROR else ""

    def _set(self, **fields) -> None:
        with self._lock:
            for name, value in fields.items():
                setattr(self, f"_{name}", value)


class UpdateLoop:
    """One background thread that keeps the boat's o-charts current while
    ``ocharts.auto_update`` is on. Same lifecycle shape as
    :class:`mivnav.data.scheduler.DatasetScheduler`: idempotent
    ``start``/``stop``, a daemon thread, wait first and then tick."""

    def __init__(self, runtime: "Runtime", *, poll_s: float = POLL_INTERVAL_S) -> None:
        self._runtime = runtime
        self._poll_s = poll_s
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._next_at = 0.0  # monotonic; 0 = due at the first tick

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="ocharts-updates", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        thread = self._thread
        if thread is None:
            return
        self._stop_event.set()
        thread.join(timeout=_STOP_TIMEOUT)
        if thread.is_alive():
            log.warning("the o-charts update loop did not stop within %ss", _STOP_TIMEOUT)
        self._thread = None

    def _run(self) -> None:
        while not self._stop_event.wait(self._poll_s):
            try:
                self.tick()
            except Exception:  # noqa: BLE001 — the loop must outlive one bad tick
                log.exception("o-charts update tick failed")

    def tick(self) -> None:
        """One wake-up: run the updater if it is switched on and due. Public
        so a test can drive it without the clock. No login only skips the
        shop — the free charts need none."""
        config = self._runtime.config.get()
        creds = credentials_from(config)
        if not config.ocharts.auto_update:
            return  # and stay due, so switching it on acts at the next tick
        if time.monotonic() < self._next_at:
            return
        ocharts = cast("OchartsRuntime", self._runtime.feature("ocharts"))
        updater = ocharts.updater
        if updater.busy():
            return
        updater.run(ocharts.service(), ocharts.installer(), creds, stop=self._stop_event)
        st = updater.status()
        failed = bool(st["error"] or st["fnc"]["error"])
        self._next_at = time.monotonic() + (RETRY_INTERVAL_S if failed else CHECK_INTERVAL_S)
