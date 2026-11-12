# SPDX-License-Identifier: GPL-2.0-only
"""Generic ingest-bake job machinery — KERNEL-classified.

The job/status spine (pending/running/done/error, one-job-at-a-time guard,
background daemon thread) every bakeable feature's ingest runner subclasses.
:class:`mivnav.features.ocharts.install.Installer` keeps its own copy by
decision, not deferral — chart-set install is a different shape. See
docs/architecture/feature-package-boundaries.md.
"""

from mivnav.ingest.runner import (
    ST_DONE,
    ST_ERROR,
    ST_FETCH,
    ST_IDLE,
    BaseJobStatus,
    BBox,
    IngestRunner,
)

__all__ = [
    "ST_DONE",
    "ST_ERROR",
    "ST_FETCH",
    "ST_IDLE",
    "BBox",
    "BaseJobStatus",
    "IngestRunner",
]
