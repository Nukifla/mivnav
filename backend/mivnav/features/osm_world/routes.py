# SPDX-License-Identifier: GPL-2.0-only
"""``/osm_world/catalog``, ``/osm_world/tiles`` and ``/osm_world/tiles/all``
— the osm_world feature's whole HTTP surface, and its ``FEATURE``
registration. See docs/architecture/osm-world-routes.md."""

from __future__ import annotations

import gzip
import hashlib
import logging
from dataclasses import dataclass
from typing import cast

import chartcore
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from mivnav.api.charts import (
    CACHE_CONTROL,
    MVT_CONTENT_TYPE,
    NO_STORE,
    _accepts_gzip,
    _if_none_match,
    build_pmtiles_router,
)
from mivnav.api.deps import Runtime, get_runtime
from mivnav.charts.pmtiles import COMPRESSION_GZIP, COMPRESSION_NONE, TILE_TYPE_MVT, PMTilesError, decompress
from mivnav.feature import Feature
from mivnav.features.osm_world.live import LiveTile
from mivnav.features.osm_world.provider import osm_world_data_provider
from mivnav.features.osm_world.runtime import OsmWorldRuntime, build_osm_world_runtime
from mivnav.features.osm_world.store import OsmWorldSet, OsmWorldStore

log = logging.getLogger(__name__)

router = APIRouter(prefix="/osm_world")

__all__ = ["FEATURE", "get_osm_world_runtime", "get_osm_world_store", "router"]


def get_osm_world_store(runtime: Runtime = Depends(get_runtime)) -> OsmWorldStore:
    return cast(OsmWorldRuntime, runtime.feature("osm_world")).store()


def get_osm_world_runtime(runtime: Runtime = Depends(get_runtime)) -> OsmWorldRuntime:
    return cast(OsmWorldRuntime, runtime.feature("osm_world"))


def _set_etag(os_: OsmWorldSet) -> str:
    return f'"{os_.id}-{os_.sequence}"'


def _media_type(os_: OsmWorldSet) -> str:
    del os_
    return MVT_CONTENT_TYPE


def _catalog_entry(os_: OsmWorldSet) -> dict:
    return {
        "id": os_.id,
        "name": os_.name,
        "updated_at": os_.updated_at,
        "region": os_.region,
        "bounds": list(os_.archive.header.bounds),  # w, s, e, n
        "min_zoom": os_.archive.header.min_zoom,
        "max_zoom": os_.archive.header.max_zoom,
        "sequence": os_.sequence,
        "tiles": f"/osm_world/tiles/{os_.id}/{{z}}/{{x}}/{{y}}",
        "vector_layers": os_.metadata.get("vector_layers", []),
    }


def _union_version(sets: dict[str, OsmWorldSet]) -> tuple[tuple[str, int], ...]:
    return tuple(sorted((os_.id, os_.sequence) for os_ in sets.values()))


def _union_etag(sets: dict[str, OsmWorldSet]) -> str:
    digest = hashlib.sha1(
        ";".join(f"{sid}-{seq}" for sid, seq in _union_version(sets)).encode()
    ).hexdigest()[:16]
    return f'"all-{digest}"'


def _baked_max_zoom(sets: dict[str, OsmWorldSet]) -> int:
    """The highest zoom any baked set actually covers, or ``-1`` with none
    baked — the boundary past which ``tile_all``/the catalog may consider
    the live fallback at all."""
    return max((os_.archive.header.max_zoom for os_ in sets.values()), default=-1)


def _live_zoom_range(runtime: OsmWorldRuntime, baked_max_zoom: int) -> tuple[int, int] | None:
    """The ``(min_zoom, max_zoom)`` the live fallback ADVERTISES in the
    catalog, or ``None`` if OFF/no range. Deliberately NOT the per-request
    gate — see :func:`_live_serves` / docs/architecture/osm-world-routes.md."""
    if runtime.live_dataset() is None:
        return None
    live_max = runtime.live_max_zoom()
    live_min = baked_max_zoom + 1
    if live_min > live_max:
        return None
    return live_min, live_max


def _live_serves(runtime: OsmWorldRuntime, z: int) -> bool:
    """Whether the live fallback may serve THIS tile: just "is it on, is
    ``z`` within its cap" — NOT past-deepest-baked-zoom like
    :func:`_live_zoom_range` advertises; see docs/architecture/osm-world-routes.md."""
    if runtime.live_dataset() is None:
        return False
    return 0 <= z <= runtime.live_max_zoom()


def _live_catalog_entry(runtime: OsmWorldRuntime, baked_max_zoom: int) -> dict | None:
    """The synthetic ``/osm_world/catalog`` entry for the live fallback, or
    ``None`` when off. ``sequence`` is the live cap itself, so the catalog's
    ETag digest still invalidates when a sailor raises/lowers it."""
    zoom_range = _live_zoom_range(runtime, baked_max_zoom)
    if zoom_range is None:
        return None
    dataset = runtime.live_dataset()
    assert dataset is not None  # _live_zoom_range already checked this
    min_zoom, max_zoom = zoom_range
    return {
        "id": dataset.id,
        "name": dataset.name,
        "updated_at": None,
        "region": None,
        "bounds": [-180.0, -85.0, 180.0, 85.0],
        "min_zoom": min_zoom,
        "max_zoom": max_zoom,
        "sequence": max_zoom,
        "tiles": "/osm_world/tiles/all/{z}/{x}/{y}",
        "vector_layers": [],
        "live": True,
    }


def _live_tile_response(tile: LiveTile, request: Request) -> Response:
    """A live-fetched tile's HTTP response. Deliberately carries NO ETag: the
    shared baked-union etag tracks BAKED sets only and would make a client
    cache incorrectly 304 against stale live content."""
    data = tile.data
    headers = {"Cache-Control": "public, max-age=3600", "Vary": "Accept-Encoding"}
    if tile.tile_compression == COMPRESSION_GZIP:
        if _accepts_gzip(request):
            headers["Content-Encoding"] = "gzip"
        else:
            data = decompress(COMPRESSION_GZIP, data)
    return Response(content=data, media_type=MVT_CONTENT_TYPE, headers=headers)


@dataclass(frozen=True)
class _BakedMiss:
    """``_baked_tile_all`` found nothing baked for this tile — carries what
    ``tile_all`` needs to decide whether to try the live fallback, and to
    build the eventual 404 if that also comes up empty."""

    baked_max_zoom: int
    headers: dict[str, str]


def _baked_tile_all(store: OsmWorldStore, request: Request, z: int, x: int, y: int) -> Response | _BakedMiss:
    """The synchronous, CPU/IO-bound half of ``tile_all`` (directory rescan,
    mmap reads, Rust merge — none of it yields to the event loop). Run via
    ``run_in_threadpool`` from :func:`tile_all`."""
    sets = store.sets()
    etag = _union_etag(sets)
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL, "Vary": "Accept-Encoding"}
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    if not (0 <= z < 32 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
        return Response(status_code=404, headers=headers)

    tiles: list[tuple[bytes, int]] = []
    set_ids: list[str] = []
    for os_ in sorted(sets.values(), key=lambda os_: os_.id):
        header = os_.archive.header
        if header.tile_type != TILE_TYPE_MVT:
            continue
        if header.tile_compression not in (COMPRESSION_GZIP, COMPRESSION_NONE):
            log.warning(
                "osm_world set %s: unsupported tile compression, skipped from /tiles/all", os_.id
            )
            continue
        try:
            data = os_.archive.tile_data(z, x, y)
        except PMTilesError as e:
            log.warning(
                "osm_world set %s unreadable while cutting tiles/all z%d/%d/%d: %s",
                os_.id, z, x, y, e,
            )
            continue
        if data is None:
            continue
        tiles.append((data, header.tile_compression))
        set_ids.append(os_.id)

    if not tiles:
        return _BakedMiss(baked_max_zoom=_baked_max_zoom(sets), headers=headers)

    if len(tiles) == 1:
        # One set has this tile (every tile on a one-set boat, and anywhere
        # outside a regional extract): nothing to merge, so the archive's
        # stored bytes go out untouched, as `/tiles/{set_id}/...` serves
        # them. Merging a single tile is a decode + re-encode + gzip that
        # only adds a `set` tag nothing reads — measured ~17 ms per tile on
        # the Pi, ~0.5 s per viewport. See docs/architecture/osm-world-routes.md.
        data, compression = tiles[0]
        if compression == COMPRESSION_GZIP:
            if _accepts_gzip(request):
                headers["Content-Encoding"] = "gzip"
            else:
                data = decompress(COMPRESSION_GZIP, data)
        return Response(content=data, media_type=MVT_CONTENT_TYPE, headers=headers)

    raw = [decompress(c, d) if c == COMPRESSION_GZIP else d for d, c in tiles]
    try:
        merged = chartcore.merge_tiles_tagged(raw, set_ids)
    except chartcore.ChartError as e:
        log.exception("osm_world tiles-all merge failed z%d/%d/%d", z, x, y)
        raise HTTPException(status_code=503, detail=f"osm_world basemap union unavailable: {e}") from e

    if _accepts_gzip(request):
        merged = gzip.compress(merged, 1)
        headers["Content-Encoding"] = "gzip"
    return Response(content=merged, media_type=MVT_CONTENT_TYPE, headers=headers)


@router.get("/tiles/all/{z}/{x}/{y}")
async def tile_all(
    z: int,
    x: int,
    y: int,
    request: Request,
    store: OsmWorldStore = Depends(get_osm_world_store),
    runtime: OsmWorldRuntime = Depends(get_osm_world_runtime),
) -> Response:
    """Every known world-basemap set, composited server-side into one tile,
    falling through to the live cache past the baked union's max zoom.
    Registered BEFORE ``/tiles/{set_id}/...`` below for route-order reasons."""
    outcome = await run_in_threadpool(_baked_tile_all, store, request, z, x, y)
    if isinstance(outcome, Response):
        return outcome

    if _live_serves(runtime, z):
        live_tile = await runtime.live_cache().tile(z, x, y)
        if live_tile is not None:
            return _live_tile_response(live_tile, request)
    return Response(status_code=404, headers={**outcome.headers, "Cache-Control": NO_STORE})


@router.get("/catalog")
def catalog(
    request: Request,
    store: OsmWorldStore = Depends(get_osm_world_store),
    runtime: OsmWorldRuntime = Depends(get_osm_world_runtime),
) -> Response:
    """``GET /osm_world/catalog`` — every baked set, plus a synthetic entry
    for the live fallback, and the trigger for the place-name index.
    Overrides ``build_pmtiles_router``'s generic ``/catalog`` by registration order."""
    runtime.sync_place_index()
    sets = store.sets()
    entries = [_catalog_entry(s) for s in sets.values()]
    live_entry = _live_catalog_entry(runtime, _baked_max_zoom(sets))
    if live_entry is not None:
        entries.append(live_entry)
    digest = hashlib.sha1(";".join(f"{e['id']}:{e['sequence']}" for e in entries).encode()).hexdigest()[:16]
    etag = f'"{digest}"'
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    return JSONResponse({"sets": entries}, headers=headers)


# GET .../tiles/{set_id}/... and DELETE .../sets/{set_id}, shared via
# build_pmtiles_router. include_catalog=False: this feature registers its
# own /catalog above; leaving the factory's mounted too caused an OpenAPI operationId collision.
router.include_router(
    build_pmtiles_router(
        prefix="",
        label="osm_world",
        store_dep=get_osm_world_store,
        catalog_entry=_catalog_entry,
        media_type=_media_type,
        tile_etag=_set_etag,
        include_catalog=False,
    )
)


FEATURE: Feature[OsmWorldRuntime] = Feature(
    id="osm_world",
    routers=(router,),
    build_runtime=build_osm_world_runtime,
    data_provider=osm_world_data_provider,
)
