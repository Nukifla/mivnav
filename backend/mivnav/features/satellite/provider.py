# SPDX-License-Identifier: GPL-2.0-only
"""The ``satellite`` feature's ``/providers`` descriptor.

See docs/architecture/satellite-provider-shape.md for cross-references
into the ``poi`` feature this mirrors.
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

from pydantic import BaseModel, ConfigDict, Field

from mivnav.config.model import Config, Region
from mivnav.feature import DataProvider, IngestSpec, Refresh
from mivnav.ingest.runner import IngestRunner
from mivnav.features.satellite.ingest import SatelliteIngestRunner
from mivnav.features.satellite.runtime import SatelliteRuntime
from mivnav.features.satellite.store import SatelliteStore


class SatelliteDatasetParams(BaseModel):
    """A satellite dataset's ``params``: just ``source_id``, picking which
    configured imagery source to fetch from. ``extra="forbid"`` so a stray
    param is a validation error, not silently ignored."""

    model_config = ConfigDict(extra="forbid")

    source_id: str = Field(min_length=1)


def _satellite_runner_factory(dataset_dir: Path) -> SatelliteIngestRunner:
    """Declarative counterpart of ``SatelliteRuntime.ingest_runner``. Passes
    ``dataset_dir.name`` as ``dataset_id`` so the archive is named after the
    dataset, not the region/source name ``ingest`` would slugify (wptyyquu)."""
    return SatelliteIngestRunner(SatelliteStore(dataset_dir), dataset_id=dataset_dir.name)


def _satellite_trigger(
    runner: IngestRunner,
    region: Region | None,
    params: BaseModel | None,
    implementation: str | None = None,
) -> None:
    """``POST /datasets/{id}/ingest`` trigger. Unlike POI, always consumes
    ``region.bbox`` (an XYZ tile source has no polygon clip) — ``region.iso``
    is never read. See docs/architecture/satellite-provider-shape.md."""
    del implementation
    if region is None:
        raise ValueError(
            "a satellite dataset needs a region_id naming a Config.regions entry"
        )
    if not isinstance(params, SatelliteDatasetParams):
        raise ValueError("a satellite dataset needs params.source_id")
    sat_runner = cast(SatelliteIngestRunner, runner)
    sat_runner.ingest(source_id=params.source_id, bbox=region.bbox)


def satellite_data_provider(config: Config, runtime: SatelliteRuntime) -> DataProvider:
    """The pre-baked satellite-imagery overlay module (``data_root/satellite``
    — M-DATA-3: no more dedicated ``satellite.dir`` field), same shape as
    ``poi_data_provider``. See docs/architecture/satellite-provider-shape.md."""
    store = runtime.store()

    def stats() -> dict:
        sets = store.sets()
        return {
            "sets": len(sets),
            "sequences": {sid: ss.sequence for sid, ss in sets.items()},
        }

    return DataProvider(
        id="satellite",
        label="Satellite imagery",
        kind="tiled",
        cache=None,
        refresh=Refresh("sequence-rescan", interval=store.rescan_interval),
        prefetch=None,
        config_slice="satellite",
        stats=stats,
        ingest=IngestSpec(
            id="satellite",
            source="http",
            out_dir_slice="satellite",
            region="bbox",
            artifact="pmtiles",
            params_model=SatelliteDatasetParams,
            runner_factory=_satellite_runner_factory,
            trigger=_satellite_trigger,
        ),
    )
