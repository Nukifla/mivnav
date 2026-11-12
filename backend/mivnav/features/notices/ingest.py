# SPDX-License-Identifier: GPL-2.0-only
"""One notices dataset's update job — the generic :class:`IngestRunner`
spine (one run at a time, poll-able status/progress/log, cooperative
cancel) around :meth:`NoticesRuntime.pull`, so a notices dataset updates
exactly like a POI or satellite dataset: from the dataset scheduler, the
Datasets tab's Bake button, or ``POST /notices/refresh``.

A failed or cancelled run leaves the dataset's previous snapshot exactly
as it was (``pull`` writes it last, atomically) — the runner only reports
the error.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mivnav.features.notices.catalog import NoticeSource
from mivnav.features.notices.runtime import NoticesRuntime
from mivnav.ingest.runner import BaseJobStatus, IngestRunner


class NoticesIngestError(Exception):
    """An update is already running for this dataset."""


@dataclass
class NoticesJobStatus(BaseJobStatus):
    pass


class NoticesIngestRunner(IngestRunner[NoticesJobStatus]):
    status_cls = NoticesJobStatus
    busy_error = NoticesIngestError
    job_name = "notices update"

    def __init__(self, dataset_dir: Path, runtime: NoticesRuntime) -> None:
        super().__init__()
        self.dataset_dir = dataset_dir
        self._runtime = runtime

    def ingest(self, source: NoticeSource) -> None:
        """Start a background update of this dataset from ``source``. The
        dataset's regions are not needed here: the whole source is pulled
        and the region filter applies when serving (so editing the regions
        takes effect without a refetch)."""

        def job() -> None:
            self._runtime.pull(
                self.dataset_dir,
                source,
                cancelled=self.cancel_requested,
                progress=self._progress,
                note=self._log,
            )

        self._start(source.label, job)
