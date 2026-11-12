# SPDX-License-Identifier: GPL-2.0-only
"""Shared primitives every config-schema module needs — kernel-classified,
import-cycle-safe (stdlib and pydantic only); see
docs/architecture/config-base-primitives.md for why that matters to the import graph.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict

if TYPE_CHECKING:  # forward-ref only — no runtime import, stays a leaf.
    from mivnav.config.model import DatasetConfig


class Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


#: `Config.data_root`'s default — the boat-wide root every dataset-owning
#: provider's directory sits under, via `provider_root`/`dataset_dir`.
REPO_DATA = Path(__file__).resolve().parents[2] / "data"


def provider_root(data_root: Path, provider: str) -> Path:
    """`data_root/<provider>` — the directory a provider's own store scans
    for every dataset it owns; see docs/architecture/config-base-primitives.md
    for the M-DATA-3 landmine this join fixes."""
    return data_root / provider


def dataset_dir(data_root: Path, provider: str, dataset_id: str) -> Path:
    """`data_root/<provider>/<dataset_id>` — one dataset's own directory
    (pmtiles/cell files, sidecar, `dataset.json`); the folder name alone
    disambiguates it from siblings."""
    return provider_root(data_root, provider) / dataset_id


def disabled_dataset_ids(datasets: Sequence[DatasetConfig], provider: str) -> frozenset[str]:
    """Every declared dataset id for `provider` with `enabled is False`
    (jt lvpkxtsr) — called fresh per scan, never cached; see
    docs/architecture/config-base-primitives.md."""
    return frozenset(ds.id for ds in datasets if ds.provider == provider and not ds.enabled)
