# SPDX-License-Identifier: GPL-2.0-only
"""The ``poi`` feature's runtime: its store lifecycle and ingest-runner
accessor. See docs/architecture/poi-data-provider.md's ``PoiRuntime``
section for the store-keying and deadlock-avoidance reasoning.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

from mivnav.config import Derived
from mivnav.config.base import disabled_dataset_ids, provider_root
from mivnav.feature import FeatureCtx
from mivnav.search import SearchIndex
from mivnav.features.poi.config import PoiConfig
from mivnav.features.poi.ingest import PoiIngestRunner
from mivnav.features.poi.merge import MergeTable, Point, archive_points, build_table
from mivnav.features.poi.store import PoiStore

log = logging.getLogger(__name__)

class PoiRuntime:
    """The POI feature's store + ingest-runner lifecycle, one per process
    :class:`~mivnav.api.deps.Runtime`. ``stores`` is keyed on ``data_root``
    ALONE, not the whole ``poi`` slice — see module docstring."""

    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config
        self._search_index = ctx.search_index
        self.stores: Derived[Path, PoiStore] = Derived(
            "POI store",
            select=lambda c: c.data_root,
            build=lambda data_root: PoiStore(
                provider_root(data_root, "poi"),
                excluded=lambda: disabled_dataset_ids(self._config.get().datasets, "poi"),
            ),
        )
        self._ingest: PoiIngestRunner | None = None
        self._ingest_lock = threading.Lock()
        self._merge_lock = threading.Lock()
        self._merge_key: tuple | None = None
        self._merge_table = MergeTable()
        #: The build in flight (or last started): (key, done event).
        self._merge_job: tuple[tuple, threading.Event] | None = None

    def store(self) -> PoiStore:
        return self.stores.get(self._config.get())

    def poi_config(self) -> PoiConfig:
        """The CURRENT ``poi`` slice, read live — handed to a runner as a
        callable so each bake snapshots whatever config is current at its
        start (a ``PATCH /config`` needs no restart)."""
        return self._config.get().poi

    def app_config(self):
        """The whole current ``Config`` (a plugin source reads its own block)."""
        return self._config.get()

    def search_index(self) -> SearchIndex:
        return self._search_index()

    def ingest_runner(self) -> PoiIngestRunner:
        """The ingest-bake runner, keyed on the current store's identity —
        see module docstring for the deadlock-avoidance ordering and the
        live-config-read rationale."""
        store = self.store()
        with self._ingest_lock:
            if self._ingest is None or self._ingest.store is not store:
                self._ingest = PoiIngestRunner(
                    store,
                    poi_config=lambda: self._config.get().poi,
                    regions=lambda: self._config.get().regions,
                    search_index=self._search_index,
                    config=self._config.get,
                )
            return self._ingest

    def merge_table(
        self, store: PoiStore | None = None, *, wait: float | None = 0.0
    ) -> MergeTable | None:
        """The plugin-source ↔ OSM merge over every enabled baked set
        (docs/architecture/poi-merge.md), or ``None`` while it is being
        built. Rebuilt only when ``store``'s ``(set id, sequence)`` list
        changes — a bake, a delete, a dataset toggled.

        Read from the sets' OWN archives (:func:`archive_points`), not the
        search index: a set whose search rows are missing (an old bake, a
        failed search rebake) must still merge — measured on the boat, an
        OSM set with zero search rows showed every marina twice. That read
        is ~0.5 s on the dev box for the Danish sets and several times that
        on the Pi, so it runs on a background thread and a tile request
        never waits for it (``wait=0``, the default): the caller serves the
        tile unmerged meanwhile. ``wait=None`` blocks until the build for the
        current key is done (tests, tools); a positive ``wait`` blocks at
        most that long."""
        store = store if store is not None else self.store()
        sets = store.sets()
        key = (id(store), tuple(sorted((ps.id, ps.sequence) for ps in sets.values())))
        with self._merge_lock:
            if key == self._merge_key:
                return self._merge_table
            job = self._merge_job
            if job is None or job[0] != key:
                done = threading.Event()
                job = (key, done)
                self._merge_job = job
                threading.Thread(
                    target=self._build_merge,
                    args=(key, list(sets.values()), done),
                    name="poi-merge",
                    daemon=True,
                ).start()
        if wait is not None and wait <= 0:
            return None
        job[1].wait(wait)
        with self._merge_lock:
            return self._merge_table if self._merge_key == key else None

    def _build_merge(self, key: tuple, sets: list, done: threading.Event) -> None:
        t0 = time.perf_counter()
        points: list[Point] = []
        zooms: dict[str, tuple[int, int]] = {}
        try:
            for ps in sets:
                header = ps.archive.header
                zooms[ps.id] = (header.min_zoom, header.max_zoom)
                points += archive_points(ps.id, ps.archive)
            t1 = time.perf_counter()
            table = build_table(points, zooms)
            log.info(
                "POI merge: %d source/OSM pairs over %d points from %d sets "
                "(read %.0f ms, match %.0f ms)",
                len(table.pairs), len(points), len(sets),
                (t1 - t0) * 1000, (time.perf_counter() - t1) * 1000,
            )
        except Exception:  # noqa: BLE001 — a merge must never break tiles
            log.warning("POI merge table failed; serving unmerged", exc_info=True)
            table = MergeTable()
        with self._merge_lock:
            # A newer set list may have started its own build meanwhile:
            # this result is for a stale key then, and is dropped.
            if self._merge_job is not None and self._merge_job[0] == key:
                self._merge_key = key
                self._merge_table = table
        done.set()

    def close(self) -> None:
        with self._ingest_lock:
            self._ingest = None
        self.stores.dispose()


def build_poi_runtime(ctx: FeatureCtx) -> PoiRuntime:
    return PoiRuntime(ctx)
