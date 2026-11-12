# SPDX-License-Identifier: GPL-2.0-only
"""The generic data layer: a declarative description of every data source.

``CachePolicy``/``DataProvider``/``IngestSpec``/``Refresh`` live in
:mod:`mivnav.feature`, not here — a feature's own ``provider.py`` needs to
construct/type-hint them, and a feature may not import ``mivnav.data``.
Re-exported here unchanged for existing importers of ``mivnav.data``.
"""

from mivnav.data.provider import (
    DatasetProviderNotBakeable,
    UnknownDatasetProvider,
    UnknownDatasetRegion,
    build_dataset_runner,
    build_registry,
    dataset_output_dir,
    resolve_dataset_provider,
    resolve_dataset_region,
    trigger_dataset_ingest,
)
from mivnav.feature import CachePolicy, DataProvider, IngestSpec, Refresh

__all__ = [
    "CachePolicy",
    "DataProvider",
    "DatasetProviderNotBakeable",
    "IngestSpec",
    "Refresh",
    "UnknownDatasetProvider",
    "UnknownDatasetRegion",
    "build_dataset_runner",
    "build_registry",
    "dataset_output_dir",
    "resolve_dataset_provider",
    "resolve_dataset_region",
    "trigger_dataset_ingest",
]
