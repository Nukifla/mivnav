# SPDX-License-Identifier: GPL-2.0-only
"""The composition root: config in, live objects out. Everything expensive
that is NOT one feature's own lifecycle is built here from the config.
See docs/architecture/backend-composition-root.md for the full rationale."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import Depends
from pydantic import ValidationError

from mivnav.charts.store import ChartStore
from mivnav.collision.assess import assess
from mivnav.config import Config, ConfigStore, Derived, LayoutStore, ProfileStore
from mivnav.config.profiles import NamedBlobStore
from mivnav.config.base import provider_root
from mivnav.config.model import DatasetConfig, SignalKConfig, UpdatesConfig
from mivnav.data.provider import (
    DatasetProviderNotBakeable,
    UnknownDatasetProvider,
    build_dataset_runner,
    build_registry,
    disabled_dataset_ids,
    trigger_dataset_ingest,
)
from mivnav.feature import Feature, FeatureCtx, FeatureRuntime
from mivnav.features.ocharts.shop import load_credentials
from mivnav.features.route.runtime import build_route_resources
from mivnav.features.route.store import RouteStore
from mivnav.search import SearchIndex
from mivnav.shallow.watch import ShallowWatch
from mivnav.signalk import SignalKService
from mivnav.system import UpdateChecker

if TYPE_CHECKING:
    from mivnav.collision.config import CollisionConfig
    from mivnav.gnss.config import GnssConfig
    from mivnav.shallow.config import ShallowConfig
    from mivnav.data.provider import DataProvider
    from mivnav.ingest.runner import IngestRunner

log = logging.getLogger(__name__)


def build_signalk_service(
    cfg: SignalKConfig,
    collision: Callable[[], CollisionConfig] | None = None,
    gnss: Callable[[], GnssConfig] | None = None,
    shallow: Callable[[], ShallowConfig] | None = None,
    mob: Callable[[], dict | None] | None = None,
) -> SignalKService:
    """The boat's SignalK connection, or none. ``enabled: false`` becomes a
    live service with no socket, not an absent one, so every caller has an
    object to ask and "off" is an answer rather than a special case.

    ``collision`` reads the alarm thresholds LIVE on every snapshot rather
    than joining the slice this service is keyed on: a threshold edit must
    not re-dial the boat (and drop the anchor swing track with the tracker).
    ``shallow`` likewise, for the shallow-water watch (:mod:`mivnav.shallow`),
    whose debounce state lives with this service.

    ``mob`` reads the active man-overboard mark (``mivnav.features.mob``)
    the same way, so every screen sees a MOB raised on any other."""
    extend = None
    if collision is not None or gnss is not None or shallow is not None or mob is not None:
        read = collision
        read_shallow = shallow
        watch = ShallowWatch()
        read_mob = mob

        def extend(snapshot: dict) -> dict:
            out: dict = {}
            if read is not None:
                cfg = read()
                # The settings ride along so every screen colours and sounds by
                # the boat's numbers, and sees an edit made on another screen.
                out["collisionSettings"] = cfg.model_dump(mode="json")
                result = assess(snapshot, cfg)
                if result is not None:
                    out["collision"] = result
            if gnss is not None:
                # The GNSS/connection alarms' settings, likewise boat-wide.
                out["gnssSettings"] = gnss().model_dump(mode="json")
            if read_shallow is not None:
                shallow_cfg = read_shallow()
                out["shallowSettings"] = shallow_cfg.model_dump(mode="json")
                depth = watch(snapshot, shallow_cfg, time.monotonic())
                if depth is not None:
                    out["shallow"] = depth
            if read_mob is not None:
                active = read_mob()
                if active is not None:
                    out["mob"] = active
            return out

    return SignalKService(
        cfg.ws_url if cfg.enabled else None,
        extra_paths=cfg.extra_paths,
        extend=extend,
        fix_lost_after=(lambda: gnss().delay_s) if gnss is not None else None,
    )


class ConfigInUse(Exception):
    """A config change was refused because applying it now would disrupt
    work in progress."""


@dataclass
class _DatasetRunner:
    """One dataset's cached bake runner, plus the exact ``(data_root,
    DatasetConfig)`` it was built from — compared on every rebuild since a
    ``data_root`` move changes every target directory."""

    data_root: Path
    dataset: DatasetConfig
    runner: "IngestRunner"


class DatasetRunnerManager:
    """A per-dataset :class:`~mivnav.ingest.runner.IngestRunner` cache,
    diffing entry-by-entry so an edit to one dataset doesn't drop every
    OTHER dataset's live runner. See docs/architecture/backend-composition-root.md."""

    def __init__(self, providers: Callable[[], "Sequence[DataProvider]"]) -> None:
        self._providers = providers
        self._previous: dict[str, _DatasetRunner] = {}
        self._derived: Derived[
            tuple[Path, tuple[DatasetConfig, ...]], dict[str, _DatasetRunner]
        ] = Derived("dataset runners", select=self._select, build=self._build)

    @staticmethod
    def _select(config: Config) -> tuple[Path, tuple[DatasetConfig, ...]]:
        return config.data_root, config.datasets

    def _build(
        self, slice_: tuple[Path, tuple[DatasetConfig, ...]]
    ) -> dict[str, _DatasetRunner]:
        data_root, datasets = slice_
        providers = self._providers()
        result: dict[str, _DatasetRunner] = {}
        for dataset in datasets:
            prev = self._previous.get(dataset.id)
            if prev is not None and prev.data_root == data_root and prev.dataset == dataset:
                result[dataset.id] = prev  # unchanged: reuse the live runner
                continue
            try:
                runner = build_dataset_runner(providers, data_root, dataset)
            except (UnknownDatasetProvider, DatasetProviderNotBakeable, ValidationError):
                continue  # not runner-bakeable
            result[dataset.id] = _DatasetRunner(data_root=data_root, dataset=dataset, runner=runner)
        for old_id, old in self._previous.items():
            if result.get(old_id) is not old and old.runner.busy():
                log.warning(
                    "dataset %r's ingest runner was replaced/dropped by a config "
                    "change while a bake was still running; the background "
                    "thread keeps running to completion, but its status can no "
                    "longer be polled through this dataset id",
                    old_id,
                )
        self._previous = result
        return result

    def get(self, config: Config, dataset_id: str) -> "IngestRunner | None":
        """The cached runner for ``dataset_id``, or ``None`` if it names no
        declared dataset, or one whose provider has no bake path."""
        entry = self._derived.get(config).get(dataset_id)
        return entry.runner if entry is not None else None


class Runtime:
    """One process's config store and everything derived from it. A plain
    object, not a global — construct one per process, or per test."""

    def __init__(
        self,
        config: ConfigStore,
        profiles: ProfileStore,
        routes: RouteStore,
        layouts: NamedBlobStore,
        features: Sequence[Feature] | None = None,
    ) -> None:
        self.config = config
        # Minted fresh every process start, never persisted — exposed in
        # /api/config's meta block so a client can tell "restarted" apart
        # from "config changed" purely by this value differing.
        self.boot_id = str(uuid.uuid4())
        self.profiles = profiles
        # Held directly, not as a `Derived`: `routes` holds the in-memory
        # route mirror and active leg, which a Derived would throw away
        # mid-passage on every config edit.
        self.routes = routes
        # `layouts` is REQUIRED (no default) so a test that forgets an
        # isolated store fails loudly rather than touching the real
        # `~/.config/mivnav/layouts.json`.
        self.layouts = layouts
        self.stores: Derived[Path, ChartStore] = Derived(
            "PMTiles store",
            select=lambda c: c.data_root,
            build=lambda data_root: ChartStore(
                provider_root(data_root, "charts"),
                excluded=lambda: disabled_dataset_ids(self.config.get().datasets, "charts"),
            ),
        )
        # Keyed on `search.db_path` alone, independent of any one feature's
        # own slice: the index is shared across ingest sources, so it stays
        # HERE rather than moving into any one feature's own runtime.
        self.search_indexes: Derived[Path, SearchIndex] = Derived(
            "search index",
            select=lambda c: c.search.db_path,
            build=lambda db_path: SearchIndex(db_path),
            close=lambda idx: idx.close(),
        )
        self.signalks: Derived[SignalKConfig, SignalKService] = Derived(
            "SignalK connection",
            select=lambda c: c.signalk,
            build=lambda cfg: build_signalk_service(
                cfg,
                lambda: self.config.get().collision,
                lambda: self.config.get().gnss,
                lambda: self.config.get().shallow,
                self._mob_wire,
            ),
            close=lambda s: s.close(),  # drops the socket, tells subscribers
        )
        # The GitHub release lookup and its 6 h cache. Keyed on the
        # `updates` slice so flipping `include_prereleases` discards an
        # answer computed under the other setting.
        self.update_checkers: Derived[UpdatesConfig, UpdateChecker] = Derived(
            "update checker",
            select=lambda c: c.updates,
            build=lambda cfg: UpdateChecker(cfg),
        )
        if features is None:
            # Deferred: mivnav.api.features imports every feature's routes.py,
            # which imports Runtime from THIS module — circular at module level.
            from mivnav.api.features import FEATURES as features  # noqa: PLC0415
        self._feature_specs: tuple[Feature, ...] = tuple(features)
        ctx = FeatureCtx(
            config=self.config, search_index=self.search_index, signalk=self.signalk
        )
        self._features: dict[str, FeatureRuntime] = {
            f.id: f.build_runtime(ctx) for f in self._feature_specs
        }
        # Built last: its builder calls `self.provider_registry()` lazily,
        # which needs `self.store`/`self.signalk`/`self._features` already
        # in place — true by construction.
        self.dataset_runners = DatasetRunnerManager(self.provider_registry)

    def feature_spec(self, feature_id: str) -> Feature | None:
        """The registration of ``feature_id`` (``None``: not registered)."""
        return next((f for f in self._feature_specs if f.id == feature_id), None)

    def feature_specs(self) -> tuple[Feature, ...]:
        return self._feature_specs

    def feature(self, feature_id: str) -> FeatureRuntime:
        """This provider's own runtime object. Callers cast to the concrete
        type they registered — stays untyped here since this class must not
        know every feature's concrete runtime shape."""
        return self._features[feature_id]

    def _mob_wire(self) -> dict | None:
        """The active MOB for the snapshot, or ``None`` (also when no ``mob``
        feature is registered — a test runtime with its own feature list)."""
        mob = getattr(self, "_features", {}).get("mob")
        active = mob.store.active() if mob is not None else None
        return active.wire() if active is not None else None

    def provider_registry(self) -> list[DataProvider]:
        """The live ``/providers`` registry, exposed here so
        ``DatasetRunnerManager`` can resolve a ``DatasetConfig.provider``.
        Rebuilt on every call (cheap), same as ``GET /providers``."""
        config = self.config.get()
        return build_registry(
            config,
            store=self.store(),
            signalk=self.signalk(),
            features=self._feature_specs,
            feature_runtime=self.feature,
        )

    def dataset_runner(self, dataset_id: str) -> IngestRunner | None:
        """The live, cached :class:`~mivnav.ingest.runner.IngestRunner` for a
        declared dataset — ``None`` if its provider has no bake path
        (o-charts today) or names no registered provider."""
        return self.dataset_runners.get(self.config.get(), dataset_id)

    def trigger_dataset(self, dataset_id: str) -> bool:
        """Start a bake of a declared, enabled ``"bake"`` dataset through the
        same path as ``POST /datasets/{id}/ingest`` and the scheduler —
        for a feature route that updates its own datasets on demand
        (``POST /notices/refresh``). ``False`` when there is nothing to
        start (unknown/disabled/live-cache, no bake path, already running);
        a bad declaration raises like the generic route's trigger does."""
        config = self.config.get()
        dataset = next((d for d in config.datasets if d.id == dataset_id), None)
        if dataset is None or not dataset.enabled or dataset.mode != "bake":
            return False
        runner = self.dataset_runner(dataset_id)
        if runner is None or runner.busy():
            return False
        try:
            trigger_dataset_ingest(self.provider_registry(), config.regions, dataset, runner)
        except runner.busy_error:
            return False  # lost a race with another trigger: it is running
        return True

    def store(self) -> ChartStore:
        return self.stores.get(self.config.get())

    def search_index(self) -> SearchIndex:
        return self.search_indexes.get(self.config.get())

    def signalk(self) -> SignalKService:
        return self.signalks.get(self.config.get())

    def update_checker(self) -> UpdateChecker:
        return self.update_checkers.get(self.config.get())

    def ensure_signalk_client_id(self) -> str:
        """This device's stable SignalK ``clientId``, minted lazily and
        persisted so it survives restarts — SignalK ties a granted device
        token to the ``clientId`` that asked for it, so it must be reused."""
        config = self.config.get()
        if config.signalk_client_id:
            return config.signalk_client_id
        client_id = str(uuid.uuid4())
        return self.patch_config({"signalk_client_id": client_id}).signalk_client_id

    def ensure_routeiq_client_id(self) -> str:
        """`ensure_signalk_client_id`'s twin for the RouteIQ access-request
        grant (`Config.routeiq_client_id`, `RouteIQCredentials`) — a
        SEPARATE device identity, minted independently, so the two grants
        stay independently revocable in the SignalK admin even though both
        typically point at the same box."""
        config = self.config.get()
        if config.routeiq_client_id:
            return config.routeiq_client_id
        client_id = str(uuid.uuid4())
        return self.patch_config({"routeiq_client_id": client_id}).routeiq_client_id

    def _guard(self, current: Config, candidate: Config) -> None:
        """Veto a candidate config that would disrupt work in progress.
        Called under ConfigStore.patch's lock, so a ``Feature.guard`` hook
        must only ever take leaf locks (see ``ocharts_guard`` for the ordering)."""
        for f in self._feature_specs:
            if f.guard is None:
                continue
            reason = f.guard(self._features[f.id], current, candidate)
            if reason is not None:
                raise ConfigInUse(reason)

    def patch_config(self, patch: dict) -> Config:
        """Apply a config patch. Derived objects pick the change up lazily,
        on their next use — except the one nothing ever pulls."""
        config = self.config.patch(patch, guard=self._guard)
        self._resettle()
        return config

    def reload_config(self) -> Config:
        """Re-read a hand-edited config file. Same settling as a patch."""
        config = self.config.reload()
        self._resettle()
        return config

    def _resettle(self) -> None:
        """Re-resolve the derived objects a config change would strand.
        SignalK is the one exception to lazy invalidation: see
        docs/architecture/backend-composition-root.md for why."""
        self.signalk()

    def close(self) -> None:
        for rt in self._features.values():
            rt.close()
        self.stores.dispose()
        self.search_indexes.dispose()
        self.signalks.dispose()  # drops the upstream socket
        self.update_checkers.dispose()


_runtime: Runtime | None = None
_runtime_lock = threading.Lock()


def get_runtime() -> Runtime:
    """The process's Runtime, built on first use from the default paths."""
    global _runtime
    with _runtime_lock:
        if _runtime is None:
            config = ConfigStore(legacy_credentials=load_credentials)
            _runtime = Runtime(
                config,
                ProfileStore(),
                # Routes live on SignalK and nowhere else (#vozswkrl); a
                # callable resolved live so the host/token can change
                # without a restart.
                RouteStore(lambda: build_route_resources(config.get())),
                LayoutStore(),
            )
            log.info("configuration loaded from %s", _runtime.config.path)
        return _runtime


# Only the SHARED dependencies live here; each feature defines its own
# get_<name>_store beside its router. Resolves Runtime via `Depends` rather
# than calling `get_runtime()` directly, so overriding it redirects tests.


def get_store(runtime: Runtime = Depends(get_runtime)) -> ChartStore:
    return runtime.store()


def get_search_index(runtime: Runtime = Depends(get_runtime)) -> SearchIndex:
    return runtime.search_index()


def get_signalk(runtime: Runtime = Depends(get_runtime)) -> SignalKService:
    """Deliberately a *sync* dependency (even on a WebSocket route): FastAPI
    resolves sync dependencies in a threadpool, so resolving this cannot run
    `Derived`'s rebuild on the event loop that is serving tiles."""
    return runtime.signalk()
