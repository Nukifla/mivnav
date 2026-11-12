# SPDX-License-Identifier: GPL-2.0-only
"""The ``osm_world`` feature's ``/providers`` descriptor. ``region="bbox"``
is OPTIONAL for this provider unlike POI/satellite — see
docs/architecture/osm-world-provider.md for why a region-less dataset is
still meaningful (the whole-planet extract) and why the enum stays "bbox".
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

from pydantic import BaseModel, ConfigDict, Field, model_validator

from mivnav.config.model import Config, Region
from mivnav.feature import DataProvider, IngestSpec, Refresh
from mivnav.ingest.runner import IngestRunner
from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
from mivnav.features.osm_world.runtime import OsmWorldRuntime
from mivnav.features.osm_world.store import OsmWorldStore


class OsmWorldDatasetParams(BaseModel):
    """An osm_world dataset's ``params``: a PER-DATASET zoom-cap override
    over the provider-level ``OsmWorldConfig`` default. ``None`` (not an
    explicit copy of the current default) is load-bearing — see
    docs/architecture/osm-world-provider.md for why. ``extra="forbid"`` so
    a stray param is a validation error, not silently ignored."""

    model_config = ConfigDict(extra="forbid")

    min_zoom: int | None = Field(default=None, ge=0, le=15)
    max_zoom: int | None = Field(default=None, ge=0, le=15)

    @model_validator(mode="after")
    def _zoom_ordered(self) -> "OsmWorldDatasetParams":
        # Only enforceable when BOTH sides are given — a lone override could
        # still invert once merged against the live OsmWorldConfig at bake
        # time; that combination is re-checked there (OsmWorldIngestRunner.ingest).
        if self.min_zoom is not None and self.max_zoom is not None and self.min_zoom > self.max_zoom:
            raise ValueError("need min_zoom <= max_zoom")
        return self


def _osm_world_runner_factory(dataset_dir: Path) -> OsmWorldIngestRunner:
    """The declarative counterpart of ``OsmWorldRuntime.ingest_runner``'s
    live runner: bakes into ONE dataset directory, so a throwaway store
    scoped to ``dataset_dir`` is enough. See docs/architecture/osm-world-provider.md
    for why ``dataset_id=dataset_dir.name`` matters."""
    return OsmWorldIngestRunner(OsmWorldStore(dataset_dir), dataset_id=dataset_dir.name)


def _osm_world_trigger(
    runner: IngestRunner,
    region: Region | None,
    params: BaseModel | None,
    implementation: str | None = None,
) -> None:
    """The generic ``POST /datasets/{id}/ingest`` trigger for an osm_world
    dataset. ``region`` may be ``None`` (whole-planet bake) — deliberately
    NOT rejected the way POI/satellite reject a missing region.
    ``implementation`` is unused: osm_world has exactly one backing."""
    del implementation
    if not isinstance(params, OsmWorldDatasetParams):
        # Unreachable through normal validation; guarded so a bake never
        # AttributeErrors into a 500 if reached some other way.
        raise ValueError("an osm_world dataset needs OsmWorldDatasetParams")
    world_runner = cast(OsmWorldIngestRunner, runner)
    world_runner.ingest(min_zoom=params.min_zoom, max_zoom=params.max_zoom, region=region)


def osm_world_data_provider(config: Config, runtime: OsmWorldRuntime) -> DataProvider:
    """The OSM basemap (``data_root/osm_world``) — a pre-baked PMTiles source
    EXTRACTED (not built) from Protomaps' public daily planet build. Same
    serve-side policy as every other pre-baked PMTiles provider: no backend
    byte-cache, a rate-limited ``sequence-rescan``. See
    docs/architecture/osm-world-provider.md for why ``stats()`` also folds
    in the live-cache fallback's occupancy."""
    store = runtime.store()

    def stats() -> dict:
        sets = store.sets()
        return {
            "sets": len(sets),
            "sequences": {sid: os_.sequence for sid, os_ in sets.items()},
            "live": runtime.live_cache().stats(),
        }

    return DataProvider(
        id="osm_world",
        label="OSM world basemap",
        kind="tiled",
        cache=None,
        refresh=Refresh("sequence-rescan", interval=store.rescan_interval),
        prefetch=None,
        config_slice="osm_world",
        stats=stats,
        ingest=IngestSpec(
            id="osm_world",
            source="pmtiles-extract",
            out_dir_slice="osm_world",
            region="bbox",
            artifact="pmtiles",
            params_model=OsmWorldDatasetParams,
            runner_factory=_osm_world_runner_factory,
            trigger=_osm_world_trigger,
        ),
    )
