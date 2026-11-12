# SPDX-License-Identifier: GPL-2.0-only
"""The ``notices`` feature's config slice, plus the one notices DATASET a
boat starts with.

WHAT is pulled and WHEN is no longer here: each notices dataset
(``Config.datasets``, provider ``"notices"``) names a source, its regions
(``params.regions``) and its own schedule, exactly like every other
dataset — the old ``enabled``/``refresh_s``/``include_greenland`` keys of
this slice became that dataset (:func:`mivnav.config.migrate.
migrate_notices_datasets`). What stays is source-wide tuning.

A LEAF within its package (see ``backend/.importlinter``): imports nothing
else from ``mivnav.features.notices`` but the import-free :mod:`.ids`.
"""

from __future__ import annotations

from typing import Any

from mivnav.config.base import Frozen
from mivnav.features.notices.ids import REGION_DK, REGION_GL, SOURCE_DK_NIORD

#: Niord's public host. Data owner is Beredskabsstyrelsen (BRS) since 2025;
#: the host name stayed. Public, unauthenticated — copy-safe.
DEFAULT_BASE_URL = "https://niord.dma.dk"


#: Full pull of the feed (~1 MB, no gzip, no ETag upstream) every 30 min:
#: navigational warnings change during the day and this is safety data.
DEFAULT_TTL_S = 1800.0

#: The dataset a boat starts with (first start, or migrated from the old
#: slice). User decision 2026-10-03 (efs.md Q1): Greenland included.
DEFAULT_DATASET_ID = "notices-dk"
DEFAULT_DATASET_NAME = "Denmark + Greenland"
DEFAULT_REGIONS: tuple[str, ...] = (REGION_DK, REGION_GL)


def default_notices_dataset(
    *,
    dataset_id: str = DEFAULT_DATASET_ID,
    regions: tuple[str, ...] = DEFAULT_REGIONS,
    ttl_s: float = DEFAULT_TTL_S,
    enabled: bool = True,
) -> dict[str, Any]:
    """The default notices dataset, as a ``DatasetConfig`` document."""
    name = DEFAULT_DATASET_NAME if REGION_GL in regions else "Denmark"
    return {
        "id": dataset_id,
        "provider": "notices",
        "name": name,
        "region_id": None,
        "mode": "bake",
        "implementation": SOURCE_DK_NIORD,
        "schedule": "ttl",
        "ttl_s": ttl_s,
        "params": {"regions": list(regions)},
        "enabled": enabled,
    }


class NoticesConfig(Frozen):
    #: The Danish Niord source's host.
    base_url: str = DEFAULT_BASE_URL
    #: The permanent firing-area definitions (domain ``niord-fa``) and
    #: today's firing periods — drawn as a faint outline, red when firing.
    include_firing_areas: bool = True
    #: Download message attachments (PDF/images) once so they open offline.
    cache_attachments: bool = True
