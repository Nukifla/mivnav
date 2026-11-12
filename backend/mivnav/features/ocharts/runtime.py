# SPDX-License-Identifier: GPL-2.0-only
"""The ``ocharts`` feature's runtime: the service lifecycle, the installer
(keyed on the service's identity), and the config-patch veto hook.

See docs/architecture/ocharts-runtime-lifecycle.md for the veto-hook design
and the installer/config-store lock-ordering constraint.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

from mivnav.config import Derived
from mivnav.config.base import provider_root
from mivnav.config.model import Config
from mivnav.feature import FeatureCtx
from mivnav.features.ocharts.config import OchartsConfig
from mivnav.features.ocharts.devices import DeviceGate, DeviceStore
from mivnav.features.ocharts.install import Installer
from mivnav.features.ocharts.service import OchartsService
from mivnav.features.ocharts.updates import Updater

log = logging.getLogger(__name__)

#: What ``OchartsRuntime.services`` keys on: ``data_root`` (``sets_dir``
#: derives from it) alongside the rest of ``OchartsConfig``.
OchartsSlice = tuple[Path, OchartsConfig]


def service_slice(config: Config) -> OchartsSlice:
    """The part of the config the service is built from. ``auto_update`` is
    the one ``OchartsConfig`` field that is not an input to it — it is read
    live by the update loop — so it is pinned here: switching it must not
    restart oexserverd and drop every cache."""
    return (config.data_root, config.ocharts.model_copy(update={"auto_update": False}))


def build_ocharts_service(slice_: OchartsSlice) -> OchartsService:
    data_root, cfg = slice_
    return OchartsService(
        sets_dir=provider_root(data_root, "ocharts"),
        daemon_dir=cfg.daemon_dir,
        work_dir=cfg.work_dir,
        cell_budget=cfg.cell_budget_bytes,
        tile_budget=cfg.tile_budget_bytes,
        hazard_budget=cfg.hazard_budget_bytes,
        land_bake_budget=cfg.land_bake_budget_bytes,
        s52_path=cfg.s52_path,
        rescan_interval=cfg.rescan_interval_s,
        warm_overview=cfg.prefetch,
        over_zoom=cfg.over_zoom,
        under_zoom=cfg.under_zoom,
        detail_gap=cfg.detail_gap,
        overview_detail_cutoff=cfg.overview_detail_cutoff,
        max_cells_per_tile=cfg.max_cells_per_tile,
        chart_detail=cfg.chart_detail,
        chart_detail_spread=cfg.chart_detail_spread,
        chart_detail_anchor=cfg.chart_detail_anchor,
        parallelism=cfg.parallelism,
        render_budget=cfg.render_budget_bytes,
        tile_disk_dir=cfg.tile_disk_dir,
        tile_disk_budget=cfg.tile_disk_budget_bytes,
        pretile_max_zoom=cfg.pretile_max_zoom,
    )


class OchartsRuntime:
    """The o-charts feature's service + installer lifecycle. Rebuilding the
    service stops its daemon and drops its caches, which would strand a
    running install — see :func:`ocharts_guard`."""

    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config
        self.services: Derived[OchartsSlice, OchartsService] = Derived(
            "o-charts service",
            select=service_slice,
            build=build_ocharts_service,
            close=lambda s: s.close(),  # stops oexserverd; see OchartsService.close
        )
        self._installer: Installer | None = None
        self._installer_lock = threading.Lock()
        #: Outlives service rebuilds: it holds only what the last shop check
        #: found, and is handed the current service/installer per call.
        self.updater = Updater()
        #: Which screens may show o-charts (see .devices). Outlives service
        #: rebuilds too: the list is the crew's, not derived from config.
        self.devices = DeviceGate(DeviceStore())

    def service(self) -> OchartsService:
        return self.services.get(self._config.get())

    def installer(self) -> Installer:
        """The installer for the *current* service, keyed on the service's
        identity (not config) to avoid a lock-ordering deadlock with the
        config store's guard — see docs/architecture/ocharts-runtime-lifecycle.md."""
        service = self.service()
        with self._installer_lock:
            if self._installer is None or self._installer.service is not service:
                self._installer = Installer(service)
            return self._installer

    def installer_busy(self) -> bool:
        """Whether an install is running — a cheap leaf-lock read that
        :func:`ocharts_guard` needs without minting a new installer."""
        with self._installer_lock:
            installer = self._installer
        return installer is not None and installer.busy()

    def close(self) -> None:
        with self._installer_lock:
            self._installer = None
        self.services.dispose()  # stops oexserverd


def build_ocharts_runtime(ctx: FeatureCtx) -> OchartsRuntime:
    return OchartsRuntime(ctx)


def start_ocharts_at_boot(runtime) -> threading.Thread:
    """Build the o-charts service now instead of on the first chart request,
    so its licence check (see .licence) runs on every start of mivnav — the
    user's rule (2026-11-05) — even if nobody opens a chart. In a thread:
    the build loads the S-52 tables and must not hold up startup."""

    def build() -> None:
        try:
            runtime.feature("ocharts").service()
        except Exception:  # noqa: BLE001 — the first chart request retries the build
            log.exception("building the o-charts service at startup failed")

    thread = threading.Thread(target=build, name="ocharts-boot", daemon=True)
    thread.start()
    return thread


def ocharts_guard(runtime: OchartsRuntime, current: Config, candidate: Config) -> str | None:
    """Veto a candidate config that would disrupt a running o-charts install.

    Called by :meth:`mivnav.api.deps.Runtime._guard` for every registered
    feature; returns a human-readable reason to reject the patch, or
    ``None`` to allow it. Only takes the leaf ``installer`` lock — see
    :meth:`OchartsRuntime.installer`'s docstring for why that ordering
    matters."""
    if service_slice(candidate) == service_slice(current):
        return None  # nothing that would rebuild the service or installer
    if runtime.installer_busy():
        return (
            "a chart install is running; chart configuration cannot "
            "change until it finishes"
        )
    return None
