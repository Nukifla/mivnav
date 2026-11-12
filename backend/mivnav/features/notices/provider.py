# SPDX-License-Identifier: GPL-2.0-only
"""The ``notices`` feature's ``/providers`` descriptor and its
``IngestSpec`` — notices are a dataset provider like POI or weather: each
``Config.datasets`` entry with provider ``"notices"`` names a source
(``implementation``, see :mod:`.catalog`), its regions
(``params.regions``) and its own schedule. ``stats()`` reads in-memory
state only — never a pull, never the network."""

from __future__ import annotations

from pathlib import Path
from typing import cast

from pydantic import BaseModel, ConfigDict, ValidationInfo, model_validator

from mivnav.config.model import Config, Region
from mivnav.feature import (
    DataProvider,
    IngestSpec,
    Refresh,
    implementation_from_context,
)
from mivnav.features.notices.catalog import (
    DEFAULT_SOURCE,
    IMPLEMENTATION_LABELS,
    resolve_source,
)
from mivnav.features.notices.config import DEFAULT_TTL_S
from mivnav.features.notices.ingest import NoticesIngestRunner
from mivnav.features.notices.runtime import NoticesRuntime
from mivnav.ingest.runner import IngestRunner


class NoticesDatasetParams(BaseModel):
    """A notices dataset's ``params``. The source is the dataset's
    ``implementation`` (validation CONTEXT, as for weather's ``domains``),
    so the regions validate against THAT source's catalog."""

    model_config = ConfigDict(extra="forbid")

    #: Region ids of the source (``GET /notices/sources``); absent = all of
    #: them. Never empty: a dataset showing no region would be a silent no-op.
    regions: list[str] | None = None

    @model_validator(mode="after")
    def _known_regions(self, info: ValidationInfo) -> "NoticesDatasetParams":
        # Raises for an unknown source (→ 422) even with regions absent.
        source = resolve_source(implementation_from_context(info.context))
        if self.regions is None:
            return self
        if not self.regions:
            raise ValueError("pick at least one region")
        unknown = [v for v in self.regions if v not in source.region_ids]
        if unknown:
            raise ValueError(
                f"unknown region(s) {', '.join(map(repr, unknown))} for source "
                f"{source.id!r} (known: {', '.join(source.region_ids)})"
            )
        self.regions = list(dict.fromkeys(self.regions))
        return self


def _make_runner_factory(runtime: NoticesRuntime):
    def _notices_runner_factory(dataset_dir: Path) -> NoticesIngestRunner:
        """Bound to ``data_root/notices/<dataset id>``; registered with the
        runtime so ``/notices/status`` reports this run's state."""
        runner = NoticesIngestRunner(dataset_dir, runtime)
        runtime.register_runner(dataset_dir.name, runner)
        return runner

    return _notices_runner_factory


def _notices_trigger(
    runner: IngestRunner,
    region: Region | None,
    params: BaseModel | None,
    implementation: str | None = None,
) -> None:
    """The generic ``POST /datasets/{id}/ingest`` trigger. ``region`` is
    unused: notices regions are the source's own (``params.regions``), and
    they filter at serve time, not at fetch time."""
    del region, params
    cast(NoticesIngestRunner, runner).ingest(resolve_source(implementation))


def notices_data_provider(config: Config, runtime: NoticesRuntime) -> DataProvider:
    return DataProvider(
        id="notices",
        label="Notices to mariners",
        implementation_labels=IMPLEMENTATION_LABELS,
        default_implementation=DEFAULT_SOURCE,
        # A polled upstream snapshot per dataset, served whole (merged).
        kind="static-asset",
        # The snapshot on disk is the data, not a cache with a budget.
        cache=None,
        refresh=Refresh("ttl"),
        prefetch=None,
        config_slice="notices",
        stats=runtime.stats,
        ingest=IngestSpec(
            id="notices",
            source="http",
            out_dir_slice="notices",
            # Not Config.regions: a source's own regions, in params.
            region="none",
            artifact="file-mirror",
            # What a NEW notices dataset defaults to: safety data,
            # navigational warnings change during the day.
            schedule="ttl",
            ttl_s=DEFAULT_TTL_S,
            params_model=NoticesDatasetParams,
            runner_factory=_make_runner_factory(runtime),
            trigger=_notices_trigger,
        ),
    )
