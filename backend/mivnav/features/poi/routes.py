# SPDX-License-Identifier: GPL-2.0-only
"""``/poi/catalog`` and ``/poi/tiles`` — the POI feature's HTTP surface,
and its ``FEATURE`` registration. (A plugin POI source may add routes of its
own, e.g. for details it keeps beside a set; see :mod:`mivnav.plugins`.)

``router`` mirrors :mod:`mivnav.api.charts` (ETag/304/gzip machinery is
imported, not re-implemented) but makes no S-57 assumptions. See
docs/architecture/poi-routes.md for the retired-route migration history
(the old dedicated POI delete view, the old `/ingest/poi` trigger), the
`/tiles/all` union-tile design (#wuvqsnxy), and why this file specifically
is allow-listed to import `mivnav.api.deps`.
"""

from __future__ import annotations

import gzip
import hashlib
import logging
from typing import cast

import chartcore
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from mivnav.api.charts import (
    CACHE_CONTROL,
    MVT_CONTENT_TYPE,
    NO_STORE,
    _accepts_gzip,
    _if_none_match,
    build_pmtiles_router,
)
from mivnav.api.deps import Runtime, get_runtime
from mivnav.charts.pmtiles import (
    COMPRESSION_GZIP,
    COMPRESSION_NONE,
    TILE_TYPE_MVT,
    PMTilesError,
    decompress,
)
from mivnav.feature import Feature
from mivnav.features.poi.merge import MERGE_VERSION
from mivnav.features.poi.provider import poi_data_provider
from mivnav.features.poi.runtime import PoiRuntime, build_poi_runtime
from mivnav.features.poi.store import PoiSet, PoiStore

log = logging.getLogger(__name__)

router = APIRouter(prefix="/poi")

__all__ = ["FEATURE", "get_poi_runtime", "get_poi_store", "router"]


def get_poi_store(runtime: Runtime = Depends(get_runtime)) -> PoiStore:
    return cast(PoiRuntime, runtime.feature("poi")).store()


def get_poi_runtime(runtime: Runtime = Depends(get_runtime)) -> PoiRuntime:
    return cast(PoiRuntime, runtime.feature("poi"))


def _set_etag(ps: PoiSet) -> str:
    return f'"{ps.id}-{ps.sequence}"'


def _media_type(ps: PoiSet) -> str:
    return (
        MVT_CONTENT_TYPE
        if ps.archive.header.tile_type == TILE_TYPE_MVT
        else "application/octet-stream"
    )


def _catalog_entry(ps: PoiSet) -> dict:
    return {
        "id": ps.id,
        "name": ps.name,
        "updated_at": ps.updated_at,
        "region": ps.region,
        "bounds": list(ps.archive.header.bounds),  # w, s, e, n
        "min_zoom": ps.archive.header.min_zoom,
        "max_zoom": ps.archive.header.max_zoom,
        "sequence": ps.sequence,
        "tiles": f"/poi/tiles/{ps.id}/{{z}}/{{x}}/{{y}}",
        "vector_layers": ps.metadata.get("vector_layers", []),
    }


def _union_version(sets: dict[str, PoiSet]) -> tuple[tuple[str, int], ...]:
    """``(set id, sequence)`` for every known POI set, sorted by id — the
    single definition of "what changed" for the union tile (mirrors
    ``OchartsService.union_version``, #qwxtvtwo). Sorted explicitly so
    merge/draw order is deterministic. See docs/architecture/poi-routes.md.
    """
    return tuple(sorted((ps.id, ps.sequence) for ps in sets.values()))


def _union_etag(sets: dict[str, PoiSet]) -> str:
    digest = hashlib.sha1(
        ";".join(f"{sid}-{seq}" for sid, seq in _union_version(sets)).encode()
    ).hexdigest()[:16]
    # MERGE_VERSION: the source/OSM merge (poi-merge.md) is part of the tile's
    # bytes, so a rule change must revalidate cached union tiles.
    return f'"all-{digest}-m{MERGE_VERSION}"'


@router.get("/tiles/all/{z}/{x}/{y}")
def tile_all(
    z: int,
    x: int,
    y: int,
    request: Request,
    store: PoiStore = Depends(get_poi_store),
    poi: PoiRuntime = Depends(get_poi_runtime),
) -> Response:
    """Every known POI set, composited server-side into one tile (#wuvqsnxy).
    An OSM point that describes the same place as a plugin source's point is
    dropped and rides on that feature instead (``osm`` prop; poi-merge.md) — only
    a tile holding such a point is decoded and re-encoded.
    Registered BEFORE ``/tiles/{set_id}/{z}/{x}/{y}``: both match the same
    4-segment shape, and a POI set literally named ``all`` is not forbidden
    — see docs/architecture/poi-routes.md.
    """
    sets = store.sets()
    etag = _union_etag(sets)
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL, "Vary": "Accept-Encoding"}
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    if not (0 <= z < 32 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
        return Response(status_code=404, headers=headers)

    # The merge table builds in the background (poi-merge.md): until it is
    # ready the tile goes out UNMERGED, and must then neither share the
    # merged ETag nor be cached, or a client would keep the double markers
    # past the build (a 304 against the merged ETag above is still right —
    # the merged bytes are a pure function of the sets).
    merge = poi.merge_table(store)
    if merge is None:
        headers["ETag"] = etag[:-1] + '-pending"'
        headers["Cache-Control"] = NO_STORE
    tiles: list[bytes] = []
    set_ids: list[str] = []
    for ps in sorted(sets.values(), key=lambda ps: ps.id):
        header = ps.archive.header
        if header.tile_type != TILE_TYPE_MVT:
            continue  # e.g. a non-vector archive dropped into poi.dir by mistake
        if header.tile_compression not in (COMPRESSION_GZIP, COMPRESSION_NONE):
            log.warning(
                "POI set %s: unsupported tile compression, skipped from /tiles/all",
                ps.id,
            )
            continue
        try:
            data = ps.archive.tile_data(z, x, y)
        except PMTilesError as e:
            log.warning(
                "POI set %s unreadable while cutting tiles/all z%d/%d/%d: %s",
                ps.id, z, x, y, e,
            )
            continue
        if data is None:
            continue
        if header.tile_compression == COMPRESSION_GZIP:
            data = decompress(COMPRESSION_GZIP, data)
        if merge is not None and merge.touches(z, x, y, ps.id):
            try:
                data = merge.rewrite(z, x, y, ps.id, data)
            except Exception:  # noqa: BLE001 — serve the set unmerged, never fail the tile
                log.warning("POI merge failed for %s z%d/%d/%d", ps.id, z, x, y, exc_info=True)
        if not data:
            continue  # every point in it merged away
        tiles.append(data)
        set_ids.append(ps.id)

    if not tiles:
        return Response(status_code=404, headers={**headers, "Cache-Control": NO_STORE})

    try:
        merged = chartcore.merge_tiles_tagged(tiles, set_ids)
    except chartcore.ChartError as e:
        log.exception("POI tiles-all merge failed z%d/%d/%d", z, x, y)
        raise HTTPException(
            status_code=503, detail=f"POI union unavailable: {e}"
        ) from e

    if _accepts_gzip(request):
        merged = gzip.compress(merged, 1)
        headers["Content-Encoding"] = "gzip"
    return Response(content=merged, media_type=MVT_CONTENT_TYPE, headers=headers)


# /poi/catalog, /poi/tiles/{set_id}/{z}/{x}/{y}, DELETE /poi/sets/{set_id} —
# shared with satellite via build_pmtiles_router. Included AFTER tile_all so
# /tiles/all/... keeps winning the same-shape route race.
router.include_router(
    build_pmtiles_router(
        prefix="",
        label="POI",
        store_dep=get_poi_store,
        catalog_entry=_catalog_entry,
        media_type=_media_type,
        tile_etag=_set_etag,
    )
)


FEATURE: Feature[PoiRuntime] = Feature(
    id="poi",
    routers=(router,),
    build_runtime=build_poi_runtime,
    data_provider=poi_data_provider,
)
