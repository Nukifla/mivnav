# SPDX-License-Identifier: GPL-2.0-only
"""The per-domain grid/projection catalog, script-generated from
``@openmeteo/weather-map-layer``'s ``domainOptions``. See
docs/architecture/weather-domain-grid-catalog.md to regenerate it."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).parent / "data" / "domain_grids.json"


@lru_cache(maxsize=1)
def _load() -> dict[str, dict[str, Any]]:
    return json.loads(_DATA_PATH.read_text())


def grid_for_domain(domain_id: str) -> dict[str, Any]:
    """The JSON grid definition for an Open-Meteo domain id, feed straight to
    ``GridFactory.create``. Raises ``KeyError`` for an unknown domain — see
    this module's docstring to regenerate the catalog."""
    grids = _load()
    grid = grids.get(domain_id)
    if grid is None:
        raise KeyError(
            f"no grid definition for domain {domain_id!r} — regenerate "
            "mivnav/weather/data/domain_grids.json via "
            "mivnav/weather/gen/dump_domains.mjs (see its header)"
        )
    return grid


def domain_id_from_om_path(om_path: str) -> str:
    """The domain id is the FIRST path component of a concrete ``.om`` path —
    the same string ``weather.proxy``'s ``data_spatial/<path>`` route
    forwards unexamined; this is the one place that parses it."""
    return om_path.split("/", 1)[0]
