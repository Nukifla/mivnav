# SPDX-License-Identifier: GPL-2.0-only
"""The ``satellite`` feature's runtime: its store lifecycle and ingest-runner
accessor — the imagery twin of :mod:`mivnav.features.poi.runtime`, wired
identically (see that module's docstring for the shared reasoning).
"""

from __future__ import annotations

import threading
from pathlib import Path

from mivnav.config import Derived
from mivnav.config.base import disabled_dataset_ids, provider_root
from mivnav.feature import FeatureCtx
from mivnav.features.satellite.ingest import SatelliteIngestRunner
from mivnav.features.satellite.store import SatelliteStore


class SatelliteRuntime:
    """The satellite feature's store + ingest-runner lifecycle. ``stores`` is
    keyed on ``data_root`` alone (M-DATA-3: no more ``satellite.dir``), so
    editing a source or zoom never churns the store's mmaps and rescan."""

    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config
        self.stores: Derived[Path, SatelliteStore] = Derived(
            "satellite store",
            select=lambda c: c.data_root,
            build=lambda data_root: SatelliteStore(
                provider_root(data_root, "satellite"),
                excluded=lambda: disabled_dataset_ids(self._config.get().datasets, "satellite"),
            ),
        )
        self._ingest: SatelliteIngestRunner | None = None
        self._ingest_lock = threading.Lock()

    def store(self) -> SatelliteStore:
        return self.stores.get(self._config.get())

    def ingest_runner(self) -> SatelliteIngestRunner:
        """Keyed on the current store's identity, for the same reason
        :meth:`mivnav.features.poi.runtime.PoiRuntime.ingest_runner` is:
        a runner must never bake into a store the config has moved on from."""
        store = self.store()
        with self._ingest_lock:
            if self._ingest is None or self._ingest.store is not store:
                self._ingest = SatelliteIngestRunner(
                    store, satellite_config=lambda: self._config.get().satellite
                )
            return self._ingest

    def close(self) -> None:
        with self._ingest_lock:
            self._ingest = None
        self.stores.dispose()


def build_satellite_runtime(ctx: FeatureCtx) -> SatelliteRuntime:
    return SatelliteRuntime(ctx)
