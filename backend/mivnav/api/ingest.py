# SPDX-License-Identifier: GPL-2.0-only
"""``/ingest/countries`` — the one ingest-related endpoint no single feature
owns.

The bundled country list for the region dropdown, shared by both POI's and
satellite's region pickers (:class:`mivnav.config.model.Region`) — a
cross-feature lookup over Natural Earth data, not a provider.
"""

from __future__ import annotations

from fastapi import APIRouter

from mivnav.geo import countries

router = APIRouter(prefix="/ingest")

__all__ = ["router"]


@router.get("/countries")
def list_ingest_countries() -> dict:
    """The bundled country list for the region dropdown: ``{"countries":
    [{"iso", "name"}, ...]}``, sorted by name."""
    return {
        "countries": [
            {"iso": iso, "name": name} for iso, name in countries.list_countries()
        ]
    }
