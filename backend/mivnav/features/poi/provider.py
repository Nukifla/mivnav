# SPDX-License-Identifier: GPL-2.0-only
"""The ``poi`` feature's ``/providers`` descriptor.

See docs/architecture/poi-data-provider.md for the Feature-inversion
history and the dataset-id/filename invariant ``_poi_runner_factory`` keeps.
"""

from __future__ import annotations

from pathlib import Path
from collections.abc import Callable
from typing import cast

from pydantic import BaseModel, ConfigDict, ValidationInfo, model_validator

from mivnav.config.model import Config, Region
from mivnav.feature import DataProvider, IngestSpec, Refresh, implementation_from_context, params_context
from mivnav.ingest.runner import IngestRunner
from mivnav.features.poi.ingest import PoiIngestRunner, region_name
from mivnav.features.poi.runtime import PoiRuntime
from mivnav.features.poi.sources import (
    DEFAULT_IMPLEMENTATION,
    implementation_labels,
    poi_source,
    resolve_implementation,
)
from mivnav.features.poi.store import PoiStore

class PoiDatasetParams(BaseModel):
    """A POI dataset's ``params``: whatever its implementation's plugin
    source declares (:attr:`PoiSource.params_model`). An OpenStreetMap
    (overpass) dataset takes none — region comes from ``region_id`` and the
    Overpass knobs are provider-level config — so it must carry none; a
    stray/typo'd key errors instead of being silently ignored.

    The implementation lives on the owning ``DatasetConfig``, not in params,
    so it arrives as validation CONTEXT (:func:`~mivnav.feature.params_context`),
    as for weather's ``domains``. The validated source model is kept on
    :attr:`source_params`."""

    model_config = ConfigDict(extra="allow")

    @model_validator(mode="before")
    @classmethod
    def _keys_match_implementation(cls, data: object, info: ValidationInfo) -> object:
        # Raises for an unknown implementation (→ 422), never falls back.
        source = poi_source(implementation_from_context(info.context))
        if source is None or source.params_model is None:
            if isinstance(data, dict) and data:
                raise ValueError(
                    f"{', '.join(sorted(data))}: unexpected param(s) on a POI dataset "
                    "whose source takes none"
                )
            return data
        source.params_model.model_validate(data, context=info.context)
        return data

    def source_params(self, implementation: str | None) -> BaseModel | None:
        """These params as the implementation's own model (``None`` for one
        that declares none)."""
        source = poi_source(implementation)
        if source is None or source.params_model is None:
            return None
        return source.params_model.model_validate(
            self.model_extra or {}, context=params_context(implementation)
        )


def _make_runner_factory(runtime: PoiRuntime) -> Callable[[Path], PoiIngestRunner]:
    def _poi_runner_factory(dataset_dir: Path) -> PoiIngestRunner:
        """Bakes directly into ``dataset_dir`` (``data_root/poi/<dataset
        id>``), passing ``dataset_dir.name`` through as ``dataset_id`` so the
        runner writes ``<dataset_id>.pmtiles`` — without this the id and
        filename could drift and the dataset would bake but never appear in
        ``GET /poi/catalog`` (bug wptyyquu). See
        docs/architecture/poi-data-provider.md.

        The live ``poi`` config slice (Overpass URL, zooms)
        and the shared search index come from ``runtime`` — without them a
        generic-path bake would silently use ``PoiConfig()`` defaults and
        never feed place-name search. ``on_published`` invalidates the store
        ``/poi/catalog`` serves from (the provider root, not this dataset's
        own directory), so a finished bake is visible at once."""
        return PoiIngestRunner(
            PoiStore(dataset_dir),
            poi_config=runtime.poi_config,
            search_index=runtime.search_index,
            dataset_id=dataset_dir.name,
            on_published=lambda: runtime.store().invalidate(),
            config=runtime.app_config,
        )

    return _poi_runner_factory


def _poi_trigger(
    runner: IngestRunner,
    region: Region | None,
    params: BaseModel | None,
    implementation: str | None = None,
) -> None:
    """Generic ``POST /datasets/{id}/ingest`` trigger: translates the
    dataset's resolved :class:`Region` into ``ingest``'s ``bbox`` XOR
    ``country`` call, plus which implementation bakes it. A bbox region also
    passes its individual ``bboxes`` — a source that culls a bigger download
    can test each box and drop the gaps between them, where Overpass fetches
    (and keeps) the one enclosing box.

    The region's display name goes along too (``name``): the explicit
    ``bbox`` alone carries none, so without it a bbox region baked from the
    Datasets tab showed up as "Custom" in the catalog and progress."""
    if region is None:
        raise ValueError("a POI dataset needs a region_id naming a Config.regions entry")
    impl = resolve_implementation(implementation)
    if params is None:
        params = PoiDatasetParams.model_validate({}, context=params_context(impl))
    if not isinstance(params, PoiDatasetParams):
        raise ValueError("a POI dataset's params did not validate as PoiDatasetParams")
    poi_runner = cast(PoiIngestRunner, runner)
    poi_runner.ingest(
        country=region.iso,
        bbox=None if region.iso is not None else region.bbox,
        bboxes=None if region.iso is not None else tuple(b.as_tuple() for b in region.bboxes),
        implementation=impl,
        params=params.source_params(impl),
        name=region_name(region),
    )


def poi_data_provider(config: Config, runtime: PoiRuntime) -> DataProvider:
    """The OSM-POI overlay module (``data_root/poi``): a pre-baked PMTiles
    source using the chart store's policy — no backend byte-cache,
    ``cache=None``, a rate-limited ``sequence-rescan``. See
    docs/architecture/poi-data-provider.md."""
    store = runtime.store()

    def stats() -> dict:
        sets = store.sets()
        return {
            "sets": len(sets),
            "sequences": {sid: ps.sequence for sid, ps in sets.items()},
        }

    return DataProvider(
        id="poi",
        label="POI (points of interest)",
        # What the dataset list shows per backing source, so a plugin's set
        # and an OpenStreetMap set of the same region are told apart at a glance.
        implementation_labels=implementation_labels(),
        default_implementation=DEFAULT_IMPLEMENTATION,
        kind="tiled",
        cache=None,
        refresh=Refresh("sequence-rescan", interval=store.rescan_interval),
        prefetch=None,
        config_slice="poi",
        stats=stats,
        ingest=IngestSpec(
            id="poi",
            source="overpass",  # the default; see features/poi/sources.py
            out_dir_slice="poi",
            region="bbox",
            artifact="pmtiles",
            params_model=PoiDatasetParams,
            runner_factory=_make_runner_factory(runtime),
            trigger=_poi_trigger,
        ),
    )
