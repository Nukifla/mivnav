# SPDX-License-Identifier: GPL-2.0-only
"""The ``osm_world`` feature's runtime: its store lifecycle, ingest-runner
accessor, and the on-demand live-cache fallback's lifecycle and gate. See
docs/architecture/osm-world-runtime.md for why the store and the live cache
are keyed on different scopes.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

from mivnav.config import Derived
from mivnav.config.base import disabled_dataset_ids, provider_root
from mivnav.config.model import DatasetConfig
from mivnav.feature import FeatureCtx
from mivnav.features.osm_world.config import OsmWorldConfig
from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
from mivnav.features.osm_world.live import OsmWorldLiveCache
from mivnav.features.osm_world.places import sync_places
from mivnav.features.osm_world.store import OsmWorldStore

log = logging.getLogger(__name__)


def build_osm_world_live_cache(cfg: OsmWorldConfig) -> OsmWorldLiveCache:
    return OsmWorldLiveCache(
        cache_dir=cfg.live_cache_dir,
        cache_budget=cfg.live_cache_budget_bytes,
        build_host=cfg.build_host,
        lookback_days=cfg.build_lookback_days,
        refresh_s=cfg.live_refresh_s,
    )


class OsmWorldRuntime:
    """The osm_world feature's store + ingest-runner lifecycle, plus the
    live-cache fallback and place-index sync. See
    docs/architecture/osm-world-runtime.md for why ``stores`` and
    ``live_caches`` are keyed on different config scopes."""

    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config
        self._search_index = ctx.search_index
        self.stores: Derived[Path, OsmWorldStore] = Derived(
            "osm world basemap store",
            select=lambda c: c.data_root,
            build=lambda data_root: OsmWorldStore(
                provider_root(data_root, "osm_world"),
                excluded=lambda: disabled_dataset_ids(self._config.get().datasets, "osm_world"),
            ),
        )
        self.live_caches: Derived[OsmWorldConfig, OsmWorldLiveCache] = Derived(
            "osm world live cache",
            select=lambda c: c.osm_world,
            build=build_osm_world_live_cache,
        )
        self._ingest: OsmWorldIngestRunner | None = None
        self._ingest_lock = threading.Lock()
        self._place_sync_lock = threading.Lock()
        self._place_sync: threading.Thread | None = None

    def store(self) -> OsmWorldStore:
        return self.stores.get(self._config.get())

    def live_cache(self) -> OsmWorldLiveCache:
        return self.live_caches.get(self._config.get())

    def live_dataset(self) -> DatasetConfig | None:
        """The enabled ``mode="live-cache"`` ``osm_world`` dataset, if a
        sailor has declared one — the gate ``routes.py`` consults before
        ever falling through to the live cache. ``None`` when no such
        dataset exists or is disabled; see docs/architecture/osm-world-runtime.md."""
        for ds in self._config.get().datasets:
            if ds.provider == "osm_world" and ds.mode == "live-cache" and ds.enabled:
                return ds
        return None

    def live_max_zoom(self) -> int:
        """How far the live fallback may serve, right now — boat-wide
        default LOWERED by the dataset's own ``max_zoom`` override, never
        raised past it (``min()``, not a straight override — see
        docs/architecture/osm-world-runtime.md). Meaningful only when
        :meth:`live_dataset` is not ``None``."""
        boat_wide = self._config.get().osm_world.live_max_zoom
        ds = self.live_dataset()
        if ds is not None:
            params = ds.params if isinstance(ds.params, dict) else {}
            max_zoom = params.get("max_zoom")
            if isinstance(max_zoom, int):
                return min(max_zoom, boat_wide)
        return boat_wide

    def ingest_runner(self) -> OsmWorldIngestRunner:
        """Keyed on the CURRENT store's identity: a config edit that moves
        ``data_root`` rebuilds the store, and a runner still holding the old
        one would keep baking into a directory nothing serves from."""
        store = self.store()
        with self._ingest_lock:
            if self._ingest is None or self._ingest.store is not store:
                self._ingest = OsmWorldIngestRunner(
                    store, osm_world_config=lambda: self._config.get().osm_world
                )
            return self._ingest

    def sync_place_index(self) -> bool:
        """Kick off a background pass of :func:`~mivnav.features.osm_world.
        places.sync_places`. Returns whether a pass was STARTED — at most
        one runs at a time. Never raises (logged and swallowed): a failure
        here costs place names, not the request that triggered it. See
        docs/architecture/osm-world-runtime.md."""
        with self._place_sync_lock:
            if self._place_sync is not None and self._place_sync.is_alive():
                return False
            thread = threading.Thread(
                target=self._run_place_sync, name="osm-world-place-index", daemon=True
            )
            self._place_sync = thread
        thread.start()
        return True

    def _run_place_sync(self) -> None:
        try:
            sync_places(
                self.store(),
                self._search_index(),
                self._config.get().osm_world.place_index_tile_budget,
            )
        except Exception:  # noqa: BLE001 — see sync_place_index's contract
            log.warning("osm_world place-index sync failed", exc_info=True)

    def close(self) -> None:
        with self._ingest_lock:
            self._ingest = None
        self.stores.dispose()
        self.live_caches.dispose()


def build_osm_world_runtime(ctx: FeatureCtx) -> OsmWorldRuntime:
    return OsmWorldRuntime(ctx)
