# SPDX-License-Identifier: GPL-2.0-only
"""``/satellite/catalog``, ``/satellite/sources``, ``/satellite/tiles`` and
``/ingest/satellite/sources`` — the satellite feature's whole HTTP surface,
and its ``FEATURE`` registration. See docs/architecture/satellite-routes.md.
"""

from __future__ import annotations

import logging
from typing import cast

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from mivnav.api.charts import NO_STORE, build_pmtiles_router
from mivnav.api.deps import Runtime, get_runtime
from mivnav.charts.pmtiles import TILE_TYPE_JPEG, TILE_TYPE_PNG, TILE_TYPE_WEBP
from mivnav.feature import Feature
from mivnav.features.satellite.config import SatelliteSource as SatelliteSourceConfig
from mivnav.features.satellite.provider import satellite_data_provider
from mivnav.features.satellite.runtime import SatelliteRuntime, build_satellite_runtime
from mivnav.features.satellite.store import SatelliteSet, SatelliteStore

log = logging.getLogger(__name__)

# Down to one route (GET /sources); see docs/architecture/satellite-routes.md.
ingest_router = APIRouter(prefix="/ingest")

#: Bump on a serving-contract change that isn't caught by `sequence` (new
#: raster format, re-tiling). See docs/architecture/satellite-routes.md.
SATELLITE_TILE_SCHEMA_VERSION = 1

# PMTiles raster tile-type id -> HTTP Content-Type (authoritative).
_CONTENT_TYPE_BY_TILE_TYPE = {
    TILE_TYPE_PNG: "image/png",
    TILE_TYPE_JPEG: "image/jpeg",
    TILE_TYPE_WEBP: "image/webp",
}
# Sidecar tile_format -> Content-Type, fallback for an unrecognised tile_type.
_CONTENT_TYPE_BY_FORMAT = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}

__all__ = [
    "FEATURE",
    "get_satellite_store",
    "ingest_router",
    "router",
]


def get_satellite_store(runtime: Runtime = Depends(get_runtime)) -> SatelliteStore:
    return cast(SatelliteRuntime, runtime.feature("satellite")).store()


def _set_etag(ss: SatelliteSet) -> str:
    return f'"{ss.id}-{ss.sequence}-v{SATELLITE_TILE_SCHEMA_VERSION}"'


def _media_type(ss: SatelliteSet) -> str:
    """Content-Type for this set's tiles: header first, sidecar fallback,
    ``application/octet-stream`` if neither is known (never a guess)."""
    mt = _CONTENT_TYPE_BY_TILE_TYPE.get(ss.archive.header.tile_type)
    if mt is not None:
        return mt
    if ss.tile_format is not None:
        return _CONTENT_TYPE_BY_FORMAT.get(ss.tile_format, "application/octet-stream")
    return "application/octet-stream"


def _catalog_entry(ss: SatelliteSet) -> dict:
    return {
        "id": ss.id,
        "name": ss.name,
        "updated_at": ss.updated_at,
        "region": ss.region,
        "bounds": list(ss.archive.header.bounds),  # w, s, e, n
        "min_zoom": ss.archive.header.min_zoom,
        "max_zoom": ss.archive.header.max_zoom,
        "sequence": ss.sequence,
        "tile_format": ss.tile_format,
        "tiles": f"/satellite/tiles/{ss.id}/{{z}}/{{x}}/{{y}}",
    }


# Shared with POI's identical three routes via build_pmtiles_router; see
# docs/architecture/satellite-routes.md for the two variance points.
router = build_pmtiles_router(
    prefix="/satellite",
    label="satellite",
    store_dep=get_satellite_store,
    catalog_entry=_catalog_entry,
    media_type=_media_type,
    tile_etag=_set_etag,
    catalog_salt=lambda: f"v{SATELLITE_TILE_SCHEMA_VERSION};",
)


# -- GET /satellite/sources — the satellite TYPE's discovery contract --

#: Shown when a baked set's origin source is unknown or credits nothing.
#: Imagery licences (ESRI, EOX CC-BY-NC-SA) require SOME credit.
ATTRIBUTION_FALLBACK = "Satellite imagery"


def _source_entry_for_set(ss: SatelliteSet, origin: SatelliteSourceConfig | None) -> dict:
    """One unified-source row for a BAKED set. ``origin`` is the configured
    imagery source it was cut from (``region.source``), or ``None``."""
    header = ss.archive.header
    return {
        "id": ss.id,
        "label": ss.name or ss.id,
        "badge": f"Offline · {origin.name}" if origin is not None else "Offline",
        "requires_network": False,
        "tiles": f"/satellite/tiles/{ss.id}/{{z}}/{{x}}/{{y}}",
        "min_zoom": header.min_zoom,
        "max_zoom": header.max_zoom,
        "bounds": list(header.bounds),  # w, s, e, n
        "attribution": (origin.attribution if origin is not None else "") or ATTRIBUTION_FALLBACK,
        "sequence": ss.sequence,
    }


@router.get("/sources")
def list_sources(
    runtime: Runtime = Depends(get_runtime),
    store: SatelliteStore = Depends(get_satellite_store),
) -> JSONResponse:
    """``{"sources": [...]}`` — every imagery source this boat can draw,
    baked or online, in ONE answer, replacing a client-side join of two
    endpoints. Baked sets come first (offline-wins); see docs/architecture/satellite-routes.md.
    """
    online = {s.id: s for s in runtime.config.get().satellite.sources}
    entries = [
        _source_entry_for_set(ss, online.get((ss.region or {}).get("source") or ""))
        for ss in store.sets().values()
    ]
    entries.extend(
        {
            "id": s.id,
            "label": s.name,
            "badge": "Online",
            "requires_network": True,
            "tiles": s.url_template,
            "min_zoom": 0,
            "max_zoom": s.max_zoom,
            "bounds": None,
            "attribution": s.attribution or ATTRIBUTION_FALLBACK,
            "sequence": 0,
        }
        for s in online.values()
    )
    # no-store: a bake/delete changes this answer immediately; a stale
    # "you have this offline" is the exact lie this list exists to prevent.
    return JSONResponse({"sources": entries}, headers={"Cache-Control": NO_STORE})


# -- /ingest/satellite/sources — the one surviving route on ingest_router --


@ingest_router.get("/satellite/sources")
def list_satellite_sources(runtime: Runtime = Depends(get_runtime)) -> dict:
    """UI-picker source list, read live from config (keyless, safe to return)."""
    sources = runtime.config.get().satellite.sources
    return {
        "sources": [
            {
                "id": s.id,
                "name": s.name,
                "attribution": s.attribution,
                "max_zoom": s.max_zoom,
                "tile_format": s.tile_format,
                "bakeable": s.bakeable,
                "url_template": s.url_template,
            }
            for s in sources
        ]
    }


FEATURE: Feature[SatelliteRuntime] = Feature(
    id="satellite",
    routers=(router, ingest_router),
    build_runtime=build_satellite_runtime,
    data_provider=satellite_data_provider,
)
