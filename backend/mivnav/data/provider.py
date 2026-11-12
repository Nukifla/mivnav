# SPDX-License-Identifier: GPL-2.0-only
"""``build_registry()`` — the ``/providers`` status surface, DERIVED from the
static ``FEATURES`` list: a descriptor that DECLARES, not a generic
fetch/cache runtime — the per-provider engines still IMPLEMENT. See
docs/architecture/data-provider-registry.md.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from mivnav.config.base import dataset_dir, disabled_dataset_ids  # noqa: F401 -- re-exported
from mivnav.feature import (
    DataProvider,
    Feature,
    FeatureRuntime,
    Refresh,
    params_context,
)

if TYPE_CHECKING:  # engines are duck-typed at runtime; import only for hints
    from mivnav.charts.store import ChartStore
    from mivnav.config.model import Config, DatasetConfig, Region
    from mivnav.ingest.runner import IngestRunner
    from mivnav.signalk import SignalKService


def _chart_store_provider(config: Config, store: ChartStore) -> DataProvider:
    """Pre-baked PMTiles archives (``data_root/charts`` — M-DATA-3). No
    backend byte-cache: mmapped archives keyed by ``(mtime, size)``, dropped
    on change — a rescan registry, not an LRU (the frontend owns tile bytes)."""

    def stats() -> dict:
        sets = store.sets()
        return {
            "sets": len(sets),
            "sequences": {sid: cs.sequence for sid, cs in sets.items()},
        }

    return DataProvider(
        id="chart-store",
        label="Charts",
        kind="tiled",
        cache=None,
        refresh=Refresh("sequence-rescan", interval=store.rescan_interval),
        prefetch=None,
        # M-DATA-3: keys on `data_root`, not a dedicated `charts` slice
        # (there is no more `ChartsConfig`).
        config_slice="data_root",
        stats=stats,
    )


def _signalk_provider(config: Config, signalk: SignalKService) -> DataProvider:
    """The boat's live SignalK stream. ``cache=None`` is LOAD-BEARING: live
    snapshots have no TTL/cache, and modelling that absence (rather than
    inventing a cache) is the point. ``stats()`` is connection liveness."""

    def stats() -> dict:
        snap = signalk.snapshot()
        return {
            "status": snap.get("status"),
            "connected": snap.get("status") == "connected",
            "url": signalk.url,
            "self": snap.get("self") is not None,
            "targets": len(snap.get("targets") or []),
        }

    return DataProvider(
        id="signalk",
        label="SignalK",
        kind="live-stream",
        cache=None,
        refresh=Refresh("live"),
        prefetch=None,
        config_slice="signalk",
        stats=stats,
    )


def build_registry(
    config: Config,
    *,
    store: ChartStore,
    signalk: SignalKService,
    features: Sequence[Feature],
    feature_runtime: Callable[[str], FeatureRuntime],
) -> list[DataProvider]:
    """Describe every data source as a :class:`~mivnav.feature.DataProvider`.
    ``features`` is passed in rather than imported, so a test's
    ``dependency_overrides`` reaches this the same way as the hardcoded providers below."""
    return [
        _chart_store_provider(config, store),
        *[
            f.data_provider(config, feature_runtime(f.id))
            for f in features
            if f.data_provider is not None
        ],
        _signalk_provider(config, signalk),
    ]


# Dataset resolution (M-DATA-3): given a live provider registry and a
# declared DatasetConfig, resolves exactly where/how it bakes.
# DatasetRunnerManager and DatasetScheduler are the two callers.


class UnknownDatasetProvider(Exception):
    """``DatasetConfig.provider`` names no currently-registered provider."""


class DatasetProviderNotBakeable(Exception):
    """The named provider exists but declares no declarative bake path
    (no ``IngestSpec``, or one with no ``runner_factory`` — o-charts' own
    ``Installer`` is the standing example, kept standalone on purpose)."""


def resolve_dataset_provider(
    providers: Sequence[DataProvider], provider: str
) -> DataProvider:
    """The registered ``DataProvider`` a ``DatasetConfig.provider`` string
    names, by ``id`` — the live-registry half of a check ``config.model``
    can't do itself. Raises :class:`UnknownDatasetProvider` if none matches."""
    for p in providers:
        if p.id == provider:
            return p
    raise UnknownDatasetProvider(f"no registered data provider named {provider!r}")


def dataset_output_dir(data_root: Path, provider: DataProvider, dataset_id: str) -> Path:
    """``data_root/<out_dir_slice>/<dataset_id>``, reading ``out_dir_slice``
    off the LIVE provider rather than assuming it equals ``provider.id``."""
    if provider.ingest is None:
        raise DatasetProviderNotBakeable(f"provider {provider.id!r} declares no ingest path")
    return dataset_dir(data_root, provider.ingest.out_dir_slice, dataset_id)


def build_dataset_runner(
    providers: Sequence[DataProvider], data_root: Path, dataset: DatasetConfig
) -> IngestRunner:
    """Resolve ``dataset``'s bake runner: find its provider, validate
    ``dataset.params`` against ``IngestSpec.params_model`` (if any), then
    construct via ``IngestSpec.runner_factory``."""
    provider = resolve_dataset_provider(providers, dataset.provider)
    spec = provider.ingest
    if spec is None or spec.runner_factory is None:
        raise DatasetProviderNotBakeable(
            f"provider {provider.id!r} has no declarative bake path"
        )
    if spec.params_model is not None:
        spec.params_model.model_validate(
            dataset.params, context=params_context(dataset.implementation)
        )
    target = dataset_output_dir(data_root, provider, dataset.id)
    return spec.runner_factory(target)


class UnknownDatasetRegion(Exception):
    """``DatasetConfig.region_id`` names no entry in ``Config.regions``."""


def resolve_dataset_region(regions: Sequence[Region], region_id: str | None) -> Region | None:
    """The :class:`~mivnav.config.model.Region` a ``DatasetConfig.region_id``
    names, by ``id``. ``None`` in, ``None`` out — a non-region-shaped dataset
    (an o-charts install) legitimately has none. Raises
    :class:`UnknownDatasetRegion` on a bad id."""
    if region_id is None:
        return None
    for r in regions:
        if r.id == region_id:
            return r
    raise UnknownDatasetRegion(f"no region with id {region_id!r}")


def trigger_dataset_ingest(
    providers: Sequence[DataProvider],
    regions: Sequence[Region],
    dataset: DatasetConfig,
    runner: IngestRunner,
) -> None:
    """Start ``runner`` baking ``dataset`` — the generic ``POST /datasets/
    {id}/ingest`` trigger. ``runner`` is passed in (not re-resolved) because
    the caller owns its IDENTITY across requests."""
    provider = resolve_dataset_provider(providers, dataset.provider)
    spec = provider.ingest
    if spec is None or spec.trigger is None:
        raise DatasetProviderNotBakeable(
            f"provider {provider.id!r} has no generic ingest trigger"
        )
    params = (
        spec.params_model.model_validate(
            dataset.params, context=params_context(dataset.implementation)
        )
        if spec.params_model
        else None
    )
    region = resolve_dataset_region(regions, dataset.region_id)
    spec.trigger(runner, region, params, dataset.implementation)


def dataset_due(dataset: DatasetConfig, last_bake_at: str | None, *, now: datetime) -> bool:
    """Whether ``dataset`` is due for an automatic bake. ``enabled is False``
    (jt lvpkxtsr) and ``mode != "bake"`` (jt rsmpwtmw) are checked HERE so
    this stays the one place "should this auto-bake" is decided."""
    if not dataset.enabled:
        return False
    if dataset.mode != "bake":
        return False
    if dataset.schedule != "ttl" or dataset.ttl_s is None:
        return False
    if last_bake_at is None:
        return True
    age = (now - datetime.fromisoformat(last_bake_at)).total_seconds()
    return age >= dataset.ttl_s
