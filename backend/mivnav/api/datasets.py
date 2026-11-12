# SPDX-License-Identifier: GPL-2.0-only
"""``/datasets`` — the generic, provider-agnostic surface over every declared
``Config.datasets`` entry: list/live-status, declare/edit, bake, delete.
See docs/architecture/dataset-api.md for why it replaced ad hoc routes."""

from __future__ import annotations

import logging
import shutil
from typing import cast, get_args

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError, model_validator

from mivnav.api.deps import Runtime, get_runtime
from mivnav.config import ConfigError
from mivnav.config.base import dataset_dir
from mivnav.config.dataset_layout import dataset_disk_stats, search_index_share
from mivnav.config.model import (
    Config,
    DatasetConfig,
    DatasetProvider,
    fold_legacy_dataset_schedule,
)
from mivnav.data.provider import (
    DatasetProviderNotBakeable,
    UnknownDatasetProvider,
    UnknownDatasetRegion,
    resolve_dataset_provider,
    trigger_dataset_ingest,
)
from mivnav.feature import DatasetMode, IngestSchedule, params_context
from mivnav.features.ocharts.runtime import OchartsRuntime
from mivnav.features.osm_world.runtime import OsmWorldRuntime
from mivnav.features.poi.runtime import PoiRuntime
from mivnav.features.satellite.runtime import SatelliteRuntime
from mivnav.features.weather.runtime import WeatherRuntime

log = logging.getLogger(__name__)

router = APIRouter(prefix="/datasets")

__all__ = ["router"]


def _find(config: Config, dataset_id: str) -> DatasetConfig:
    for ds in config.datasets:
        if ds.id == dataset_id:
            return ds
    raise HTTPException(status_code=404, detail=f"unknown dataset {dataset_id!r}")


def _status(dataset: DatasetConfig, size: int, runtime: Runtime) -> str:
    """One of ``"unbaked"``, ``"baking"``, ``"error"``, or ``"baked"`` —
    ``"error"``/``"baking"`` only knowable in-process. See
    docs/architecture/dataset-api.md#_status for the o-charts imprecision."""
    if dataset.provider == "ocharts":
        installer = cast(OchartsRuntime, runtime.feature("ocharts")).installer()
        if installer.busy():
            return "baking"
        return "baked" if size > 0 else "unbaked"
    runner = runtime.dataset_runner(dataset.id)
    if runner is not None:
        if runner.busy():
            return "baking"
        if runner.status().get("state") == "error":
            return "error"
    return "baked" if size > 0 else "unbaked"


def _progress(dataset: DatasetConfig, runtime: Runtime) -> dict | None:
    """The live progress blob for ``dataset``, or ``None`` — appended to this
    SAME polled ``GET /datasets`` blob rather than a new streaming endpoint,
    kept populated after a bake FINISHES too. See docs/architecture/dataset-api.md#_progress."""
    if dataset.provider == "ocharts":
        return None
    runner = runtime.dataset_runner(dataset.id)
    if runner is None:
        return None
    job = runner.status()
    if job.get("state", "idle") == "idle":
        return None
    return {
        "state": job.get("state", "idle"),
        "task": job.get("task", ""),
        "current": job.get("current", 0),
        "total": job.get("total", 0),
        "log": job.get("log", []),
        # "cancelled" (jt lvpkxtsr's `IngestRunner.cancel`) vs. a real failure
        # message — both report `state == "error"`; a sailor (or a test)
        # needs this to tell "I asked it to stop" from "it broke".
        "error": job.get("error", ""),
    }


def _entry(config: Config, dataset: DatasetConfig, runtime: Runtime) -> dict:
    """One ``GET /datasets`` list entry — also reused by ``PUT
    /datasets/{id}`` so a create/edit response has exactly the same shape
    a subsequent list read would show, rather than a hand-trimmed subset."""
    directory = dataset_dir(config.data_root, dataset.provider, dataset.id)
    size, last_bake_at = dataset_disk_stats(directory)
    if dataset.mode == "live-cache":
        # A live-cache dataset's directory lives OUTSIDE data_root, so the
        # disk walk above reports 0; read real occupancy from the provider's
        # own stats() instead. See docs/architecture/dataset-api.md#_entry-live-cache-size-attribution.
        try:
            if dataset.provider == "weather":
                proxy = cast(WeatherRuntime, runtime.feature("weather")).proxy()
                size = proxy.stats()["bytes"]
            elif dataset.provider == "osm_world":
                live_cache = cast(OsmWorldRuntime, runtime.feature("osm_world")).live_cache()
                size = live_cache.stats()["bytes"]
        except Exception:  # noqa: BLE001 — see comment above
            log.warning("could not size the %s live cache for %r", dataset.provider, dataset.id, exc_info=True)
    # attribute this dataset's row share of the SHARED search-index db back
    # onto its own reported size, or a bake that only grows the shared db
    # looks near-empty here — see docs/architecture/dataset-api.md
    try:
        size += search_index_share(
            runtime.search_index(), source=dataset.provider, region=dataset.id
        )
    except Exception:  # noqa: BLE001 — a size undercount is a nicety, not fatal
        log.warning("could not size the search-index share of dataset %r", dataset.id, exc_info=True)
    return {
        "id": dataset.id,
        "provider": dataset.provider,
        "name": dataset.name,
        "region_id": dataset.region_id,
        "mode": dataset.mode,
        "implementation": dataset.implementation,
        "schedule": dataset.schedule,
        "ttl_s": dataset.ttl_s,
        "params": dataset.params,
        "enabled": dataset.enabled,
        "size": size,
        "last_bake_at": last_bake_at,
        "status": _status(dataset, size, runtime),
        "progress": _progress(dataset, runtime),
        "declared": True,
    }


def _orphan_entries(config: Config, runtime: Runtime) -> list[dict]:
    """Baked poi/satellite sets on disk with NO ``DatasetConfig`` entry
    (``"declared": False``); the existing Edit form doubles as "adopt into a
    declared dataset". Matched by ``(provider, id)``, not id alone — see
    docs/architecture/dataset-api.md#_orphan_entries."""
    declared = {(ds.provider, ds.id) for ds in config.datasets}
    entries: list[dict] = []
    stores = (
        ("poi", cast(PoiRuntime, runtime.feature("poi")).store()),
        ("satellite", cast(SatelliteRuntime, runtime.feature("satellite")).store()),
    )
    for provider_id, store in stores:
        for set_id, obj in store.sets().items():
            if (provider_id, set_id) in declared:
                continue
            directory = dataset_dir(config.data_root, provider_id, set_id)
            size, last_bake_at = dataset_disk_stats(directory)
            if provider_id == "poi":
                try:
                    size += search_index_share(runtime.search_index(), source="poi", region=set_id)
                except Exception:  # noqa: BLE001 — a size undercount is a nicety, not fatal
                    log.warning(
                        "could not size search-index share of orphan poi set %r",
                        set_id, exc_info=True,
                    )
            entries.append(
                {
                    "id": set_id,
                    "provider": provider_id,
                    "name": obj.name,
                    "region_id": None,
                    "mode": "bake",
                    "implementation": None,
                    "schedule": "manual",
                    "ttl_s": None,
                    "params": {},
                    "size": size,
                    "last_bake_at": last_bake_at or obj.updated_at,
                    "status": "baked",
                    "progress": None,
                    "declared": False,
                }
            )
    return entries


def _provider_catalog(runtime: Runtime) -> list[dict]:
    """Every ``DatasetProvider``, with label/bake-path, read off the live
    registry rather than the frontend hand-copying it (#pxxukylq, went
    stale before). See docs/architecture/dataset-api.md#_provider_catalog."""
    by_id = {p.id: p for p in runtime.provider_registry()}
    catalog = []
    for provider_id in get_args(DatasetProvider):
        p = by_id.get(provider_id)
        catalog.append(
            {
                "id": provider_id,
                "label": p.label if p is not None else provider_id,
                # Per-implementation labels ("POI (OSM)" vs a plugin's): the
                # frontend resolves a row's label from these plus the row's
                # own `implementation`, so an unsaved draft whose source is
                # being picked labels itself the same way. {} for most providers.
                "implementation_labels": dict(p.implementation_labels) if p is not None else {},
                "default_implementation": p.default_implementation if p is not None else None,
                "creatable": p.creatable if p is not None else False,
                # "bbox" | "country" | "chart-set" | "none" — read off the
                # live IngestSpec so DatasetEditForm can hide its Region
                # <select> for a provider (osm_world) with no region concept.
                "region_kind": (p.ingest.region if p is not None and p.ingest is not None else "none"),
                # The schedule a NEW dataset of this provider starts with,
                # off the IngestSpec ("manual"/None for most; notices: "ttl"
                # every 30 min) — the edit form pre-fills it for a fresh draft.
                "schedule": (p.ingest.schedule if p is not None and p.ingest is not None else "manual"),
                "ttl_s": (p.ingest.ttl_s if p is not None and p.ingest is not None else None),
            }
        )
    return catalog


@router.get("")
def list_datasets(runtime: Runtime = Depends(get_runtime)) -> dict:
    """Every declared dataset: static config fields plus live disk/job facts
    (walked off disk, so works uniformly for all four dataset-bearing
    providers). Also returns ``providers`` (see ``_provider_catalog``) and
    every ORPHAN poi/satellite set (see ``_orphan_entries``), bundled onto
    this one response since both current consumers fetch nothing else."""
    config = runtime.config.get()
    return {
        "datasets": [_entry(config, ds, runtime) for ds in config.datasets]
        + _orphan_entries(config, runtime),
        "providers": _provider_catalog(runtime),
    }


class DatasetPutBody(BaseModel):
    """The declared side of a dataset. ``dataset_id`` comes from the path,
    not the body. ``params`` is validated below against that provider's
    ``IngestSpec.params_model``."""

    provider: DatasetProvider
    name: str = Field(min_length=1)
    region_id: str | None = None
    mode: DatasetMode = "bake"
    implementation: str | None = None
    schedule: IngestSchedule = "manual"
    ttl_s: float | None = Field(default=None, gt=0)
    params: dict = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _legacy_on_demand_schedule(cls, data: object) -> object:
        # The SAME permanent fold `DatasetConfig` applies — a service-worker-
        # cached frontend several versions behind the server makes this a
        # reachable request, not a hypothetical one.
        return fold_legacy_dataset_schedule(data)


@router.put("/{dataset_id}")
def put_dataset(
    dataset_id: str, body: DatasetPutBody, runtime: Runtime = Depends(get_runtime)
) -> dict:
    """Declare a new dataset, or replace an existing one's declaration, by id.
    **Never touches disk** (unlike ``DELETE``), so renaming/rescheduling never
    discards what's baked; replacing ``provider`` orphans the old directory."""
    config = runtime.config.get()
    registry = runtime.provider_registry()
    try:
        provider = resolve_dataset_provider(registry, body.provider)
    except UnknownDatasetProvider as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if not provider.creatable:
        raise HTTPException(
            status_code=409,
            detail=(
                f"provider {body.provider!r} has no generic bake path "
                "(o-charts: use /ocharts/shop/install or /ocharts/upload; "
                "the pre-baked chart store has no in-process bake path at all)"
            ),
        )
    # mode/implementation carry forward from the PRIOR declaration when the
    # body OMITS them (jt rsmpwtmw) — see
    # docs/architecture/dataset-api.md#put_dataset-modeimplementation-forward-carry.
    existing = next((ds for ds in config.datasets if ds.id == dataset_id), None)
    mode = body.mode if "mode" in body.model_fields_set or existing is None else existing.mode
    implementation = (
        body.implementation
        if "implementation" in body.model_fields_set or existing is None
        else existing.implementation
    )
    if provider.ingest.params_model is not None:
        try:
            provider.ingest.params_model.model_validate(
                body.params, context=params_context(implementation)
            )
        except ValidationError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e

    # Whole-list replace: every OTHER dataset is round-tripped verbatim via
    # model_dump() so editing one entry can't lose another's params/schedule
    # (GET /datasets is trimmed and doesn't carry `params`).
    datasets = [ds.model_dump() for ds in config.datasets if ds.id != dataset_id]
    datasets.append(
        {
            "id": dataset_id,
            "provider": body.provider,
            "name": body.name,
            "region_id": body.region_id,
            "mode": mode,
            "implementation": implementation,
            "schedule": body.schedule,
            "ttl_s": body.ttl_s,
            "params": body.params,
            # Carry the PRIOR enabled state forward (DatasetPutBody has no
            # `enabled` field — toggling is enable_dataset/disable_dataset
            # below), or every rename/reschedule would silently re-enable.
            "enabled": existing.enabled if existing is not None else True,
        }
    )
    try:
        config = runtime.patch_config({"datasets": datasets})
    except ConfigError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return _entry(config, _find(config, dataset_id), runtime)


def _raise_if_params_invalid(runtime: Runtime, dataset: DatasetConfig) -> None:
    """422 if ``dataset.params`` fails its provider's ``params_model`` (with
    the implementation as context); otherwise return."""
    try:
        spec = resolve_dataset_provider(runtime.provider_registry(), dataset.provider).ingest
    except UnknownDatasetProvider:
        return
    if spec is None or spec.params_model is None:
        return
    try:
        spec.params_model.model_validate(
            dataset.params, context=params_context(dataset.implementation)
        )
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.post("/{dataset_id}/ingest")
def ingest_dataset(dataset_id: str, runtime: Runtime = Depends(get_runtime)) -> dict:
    """Bake ``dataset_id`` using its OWN declared ``region_id``/``params`` —
    no request body. 404 unknown id; 409 no bake path / live-cache mode /
    disabled / already busy; 422 bad params."""
    config = runtime.config.get()
    dataset = _find(config, dataset_id)
    if not dataset.enabled:
        raise HTTPException(
            status_code=409,
            detail=f"dataset {dataset_id!r} is disabled; re-enable it before baking",
        )
    if dataset.mode == "live-cache":
        # Guard is per-DATASET, not folded into `runner is None`: weather IS
        # bakeable per-provider, so dataset_runner would hand back a real
        # runner for this live-cache dataset id too.
        raise HTTPException(
            status_code=409,
            detail=(
                "a live-cache dataset has no bake step — it names a live, "
                "fetch-through cache; edit it to change which domains it may "
                "live-cache"
            ),
        )
    runner = runtime.dataset_runner(dataset_id)
    if runner is None:
        # The runner manager silently skips a dataset whose params don't
        # validate (e.g. a hand-edited config naming an unknown POI
        # implementation) — surface THAT as the 422 it is, not as "no
        # generic ingest trigger".
        _raise_if_params_invalid(runtime, dataset)
        raise HTTPException(
            status_code=409,
            detail=(
                f"provider {dataset.provider!r} has no generic ingest trigger "
                "(o-charts: use /ocharts/shop/install or /ocharts/upload; "
                "the pre-baked chart store has no in-process bake path at all)"
            ),
        )
    registry = runtime.provider_registry()
    try:
        trigger_dataset_ingest(registry, config.regions, dataset, runner)
    except (UnknownDatasetProvider, DatasetProviderNotBakeable) as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except (UnknownDatasetRegion, ValidationError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except runner.busy_error as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return runner.status()


@router.post("/{dataset_id}/ingest/cancel")
def cancel_ingest(dataset_id: str, runtime: Runtime = Depends(get_runtime)) -> dict:
    """Ask a running bake for ``dataset_id`` to stop: the runner settles to
    ``"error"``/``"cancelled"`` rather than the only prior option, killing
    the whole service (which could wedge on a held-open subprocess)."""
    config = runtime.config.get()
    dataset = _find(config, dataset_id)
    runner = runtime.dataset_runner(dataset_id)
    if runner is None:
        raise HTTPException(
            status_code=409,
            detail=f"provider {dataset.provider!r} has no generic ingest runner to cancel",
        )
    if not runner.cancel():
        raise HTTPException(
            status_code=409, detail=f"no bake is currently running for dataset {dataset_id!r}"
        )
    return runner.status()


@router.post("/{dataset_id}/enable")
def enable_dataset(dataset_id: str, runtime: Runtime = Depends(get_runtime)) -> dict:
    """Re-enable a previously-disabled dataset (jt lvpkxtsr) — flips
    ``enabled`` back to ``True`` only, never bakes anything itself. 404
    unknown id; idempotent (already-enabled is a no-op 200)."""
    return _set_enabled(dataset_id, True, runtime)


@router.post("/{dataset_id}/disable")
def disable_dataset(dataset_id: str, runtime: Runtime = Depends(get_runtime)) -> dict:
    """Disable a dataset WITHOUT deleting it: config entry and baked
    directory both survive. 404 unknown id; 409 while actively baking;
    idempotent. o-charts is a documented exception — see docs/architecture/dataset-api.md."""
    config = runtime.config.get()
    dataset = _find(config, dataset_id)
    if dataset.provider == "ocharts":
        installer = cast(OchartsRuntime, runtime.feature("ocharts")).installer()
        if installer.busy():
            raise HTTPException(
                status_code=409,
                detail="an o-charts install is running; wait for it to finish before disabling",
            )
    else:
        runner = runtime.dataset_runner(dataset_id)
        if runner is not None and runner.busy():
            raise HTTPException(
                status_code=409,
                detail=(
                    f"an ingest is running for dataset {dataset_id!r}; cancel it "
                    "(POST .../ingest/cancel) or wait for it to finish before disabling"
                ),
            )
    return _set_enabled(dataset_id, False, runtime)


def _set_enabled(dataset_id: str, enabled: bool, runtime: Runtime) -> dict:
    config = runtime.config.get()
    dataset = _find(config, dataset_id)
    if dataset.enabled == enabled:
        return _entry(config, dataset, runtime)  # already there — idempotent no-op
    datasets = [
        (ds.model_copy(update={"enabled": enabled}) if ds.id == dataset_id else ds).model_dump()
        for ds in config.datasets
    ]
    config = runtime.patch_config({"datasets": datasets})
    _invalidate(runtime, dataset.provider)
    return _entry(config, _find(config, dataset_id), runtime)


@router.delete("/{dataset_id}")
def delete_dataset(
    dataset_id: str, provider: str | None = None, runtime: Runtime = Depends(get_runtime)
) -> dict:
    """Remove ``dataset_id`` from ``Config.datasets`` AND delete its folder;
    falls back to deleting an ORPHAN poi/satellite set when no declared
    dataset matches. ``provider`` disambiguates an orphan id-collision."""
    config = runtime.config.get()
    dataset = next(
        (
            ds
            for ds in config.datasets
            if ds.id == dataset_id and (provider is None or ds.provider == provider)
        ),
        None,
    )
    if dataset is None:
        if provider in (None, "poi"):
            poi_store = cast(PoiRuntime, runtime.feature("poi")).store()
            if poi_store.get(dataset_id) is not None:
                poi_store.delete(dataset_id)
                return {"deleted": dataset_id}
        if provider in (None, "satellite"):
            satellite_store = cast(SatelliteRuntime, runtime.feature("satellite")).store()
            if satellite_store.get(dataset_id) is not None:
                satellite_store.delete(dataset_id)
                return {"deleted": dataset_id}
        raise HTTPException(status_code=404, detail=f"unknown dataset {dataset_id!r}")
    if dataset.provider == "ocharts":
        installer = cast(OchartsRuntime, runtime.feature("ocharts")).installer()
        if installer.busy():
            raise HTTPException(
                status_code=409,
                detail="an o-charts install is running; wait for it to finish before deleting",
            )
    else:
        runner = runtime.dataset_runner(dataset_id)
        if runner is not None and runner.busy():
            raise HTTPException(
                status_code=409,
                detail=(
                    f"an ingest is running for dataset {dataset_id!r}; wait for "
                    "it to finish before deleting"
                ),
            )
    directory = dataset_dir(config.data_root, dataset.provider, dataset.id)
    try:
        shutil.rmtree(directory)
    except FileNotFoundError:
        pass  # nothing was ever baked — still a valid delete of the config entry
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to delete {directory}: {e}") from e
    runtime.patch_config({"datasets": tuple(d for d in config.datasets if d.id != dataset_id)})
    _invalidate(runtime, dataset.provider)
    return {"deleted": dataset_id}


def _invalidate(runtime: Runtime, provider: str) -> None:
    """Best-effort: make the live serving registry notice the delete right
    away instead of waiting for its own rescan window. Every store here
    already rescans on demand, so a failure costs latency, never correctness."""
    try:
        if provider == "poi":
            cast(PoiRuntime, runtime.feature("poi")).store().invalidate()
        elif provider == "satellite":
            cast(SatelliteRuntime, runtime.feature("satellite")).store().invalidate()
        elif provider == "osm_world":
            cast(OsmWorldRuntime, runtime.feature("osm_world")).store().invalidate()
        elif provider == "ocharts":
            cast(OchartsRuntime, runtime.feature("ocharts")).service().invalidate()
        elif provider == "charts":
            runtime.store().invalidate()
    except Exception:  # noqa: BLE001 — a missed invalidate is a latency nicety, not fatal
        log.warning("post-delete invalidate failed for provider %s", provider, exc_info=True)
