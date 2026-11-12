# SPDX-License-Identifier: GPL-2.0-only
"""/catalog and /tiles — serve pre-baked PMTiles chart sets.

See docs/architecture/chart-tiles-serving.md for the caching model,
404-vs-missing semantics, and the /tiles/all union route.
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Callable
from functools import lru_cache
from gzip import decompress as gzip_decompress
from pathlib import Path
from typing import Protocol, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import chartcore

from mivnav.api.deps import get_store
from mivnav.features.ocharts.devices import DeviceGate
from mivnav.features.ocharts.routes import device_token, get_device_gate
from mivnav.features.ocharts.routes import get_service as get_ocharts
from mivnav.charts.pmtiles import (
    COMPRESSION_GZIP,
    COMPRESSION_NONE,
    TILE_TYPE_MVT,
    Archive,
    PMTilesError,
    decompress,
)
from mivnav.charts.store import ChartSet, ChartStore
from mivnav.features.ocharts.service import (
    TILE_SCHEMA_VERSION,
    DaemonUnavailable,
    OchartsService,
)

log = logging.getLogger(__name__)

router = APIRouter()

CACHE_CONTROL = "public, no-cache"
# A cached negative (empty tile, unknown set) becomes a tile-shaped hole that
# outlives a transient condition; `no-store` forbids caching it at all.
NO_STORE = "no-store"
MVT_CONTENT_TYPE = "application/vnd.mapbox-vector-tile"
TEXT_SUFFIX = ".TXT"
TEXT_CONTENT_TYPE = "text/plain; charset=utf-8"

# Re-exported from mivnav.api.deps (composition root) — callers and
# dependency_overrides expect it importable from this module.
__all__ = ["build_pmtiles_router", "get_store", "router"]


#: The 403 body's ``code`` when a browser is not a registered o-charts
#: device — the frontend switches to ``/tiles/free`` on it (see
#: mivnav.features.ocharts.devices).
DEVICE_NOT_REGISTERED = "device_not_registered"


def _require_device(gate: DeviceGate, service: OchartsService, request: Request) -> None:
    """403 unless this browser may be served o-charts tiles."""
    if not gate.allowed(service, device_token(request)):
        raise HTTPException(
            status_code=403,
            detail={
                "code": DEVICE_NOT_REGISTERED,
                "message": "this device is not registered for o-charts",
            },
            headers={"Cache-Control": NO_STORE},
        )


def _set_etag(cs: ChartSet) -> str:
    return f'"{cs.id}-{cs.sequence}"'


def _if_none_match(request: Request, etag: str) -> bool:
    """RFC 9110 If-None-Match: `*` matches any representation, values are
    comma-separated tag lists (possibly across multiple header fields)."""
    fields = request.headers.getlist("if-none-match")
    if not fields:
        return False
    tags = [t.strip() for field in fields for t in field.split(",")]
    return "*" in tags or etag in tags or f"W/{etag}" in tags


def accepts_gzip_header(accept_encoding: str) -> bool:
    """``gzip;q=0`` is an explicit refusal, not acceptance — the stdlib
    GZipMiddleware's substring check misses this, so mivnav.api.app's gzip
    middleware reuses this function too."""
    for item in accept_encoding.split(","):
        coding, *params = item.split(";")
        if coding.strip().lower() != "gzip":
            continue
        for p in params:
            name, _, value = p.partition("=")
            if name.strip().lower() == "q":
                try:
                    return float(value) > 0
                except ValueError:
                    return False
        return True
    return False


def _accepts_gzip(request: Request) -> bool:
    return accepts_gzip_header(request.headers.get("accept-encoding", ""))


# poi/satellite serve-side surface factored out of duplicated code; lives
# here (not kernel-level mivnav.feature) since .importlinter forbids kernel
# importing mivnav.api. See docs/architecture/chart-tiles-serving.md.

_T = TypeVar("_T")


class PMTilesEntry(Protocol):
    """Per-set shape (``PoiSet``, ``SatelliteSet``) needed to open the
    archive and key the tile lookup; other fields stay feature-side."""

    id: str
    archive: Archive
    sequence: int


class PMTilesStore(Protocol[_T]):
    """Per-feature store operations (``PoiStore``, ``SatelliteStore``)
    this factory's three routes call."""

    def sets(self) -> dict[str, _T]: ...
    def get(self, set_id: str) -> _T | None: ...
    def delete(self, set_id: str) -> bool: ...


def build_pmtiles_router(
    *,
    prefix: str,
    label: str,
    store_dep: Callable[..., PMTilesStore[_T]],
    catalog_entry: Callable[[_T], dict],
    media_type: Callable[[_T], str],
    tile_etag: Callable[[_T], str],
    catalog_salt: Callable[[], str] = lambda: "",
    include_catalog: bool = True,
) -> APIRouter:
    """Build ``GET <prefix>/catalog``, ``/tiles/{id}/{z}/{x}/{y}`` and
    ``DELETE <prefix>/sets/{id}``. ``store_dep`` MUST be passed unwrapped —
    tests key ``app.dependency_overrides`` off that exact object. See
    docs/architecture/chart-tiles-serving.md."""
    router = APIRouter(prefix=prefix)

    if include_catalog:

        @router.get("/catalog")
        def catalog(request: Request, store: PMTilesStore[_T] = Depends(store_dep)) -> Response:
            sets = store.sets()
            entries = [catalog_entry(s) for s in sets.values()]
            digest = hashlib.sha1(
                (
                    catalog_salt()
                    + ";".join(f"{e['id']}:{e['sequence']}" for e in entries)
                ).encode()
            ).hexdigest()[:16]
            etag = f'"{digest}"'
            headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
            if _if_none_match(request, etag):
                return Response(status_code=304, headers=headers)
            return JSONResponse({"sets": entries}, headers=headers)

    def delete_set(set_id: str, store: PMTilesStore[_T] = Depends(store_dep)) -> dict:
        if not store.delete(set_id):
            raise HTTPException(status_code=404, detail=f"unknown {label} set {set_id!r}")
        return {"deleted": set_id}

    # Assigned before registration: OpenAPI reads __doc__ at router.delete()
    # time, so mutating it after would no longer be reflected.
    delete_set.__doc__ = (
        f"Delete a baked {label} set (its ``<id>.pmtiles`` file, and any sidecar) "
        "from disk, freeing the space and dropping it from the map on the next "
        "catalog read. The file is resolved from the store's own scan (never "
        "string-built from ``set_id``), so a traversal-y id cannot escape the "
        "feature's data directory — it is simply not a known set. 404 if unknown."
    )
    router.delete("/sets/{set_id}")(delete_set)

    @router.get("/tiles/{set_id}/{z}/{x}/{y}")
    def tile(
        set_id: str,
        z: int,
        x: int,
        y: int,
        request: Request,
        store: PMTilesStore[_T] = Depends(store_dep),
    ) -> Response:
        s = store.get(set_id)
        if s is None:
            raise HTTPException(
                status_code=404,
                detail=f"unknown {label} set {set_id!r}",
                headers={"Cache-Control": NO_STORE},
            )
        etag = tile_etag(s)
        headers = {
            "ETag": etag,
            "Cache-Control": CACHE_CONTROL,
            "Vary": "Accept-Encoding",
        }
        if _if_none_match(request, etag):
            return Response(status_code=304, headers=headers)
        if not (0 <= z < 32 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
            return Response(status_code=404, headers=headers)

        header = s.archive.header
        if header.tile_compression not in (COMPRESSION_GZIP, COMPRESSION_NONE):
            raise HTTPException(status_code=500, detail="unsupported tile compression")
        try:
            data = s.archive.tile_data(z, x, y)
            if data is None:
                return Response(status_code=404, headers={**headers, "Cache-Control": NO_STORE})
            if header.tile_compression == COMPRESSION_GZIP:
                if _accepts_gzip(request):
                    headers["Content-Encoding"] = "gzip"
                else:
                    data = decompress(COMPRESSION_GZIP, data)
        except PMTilesError as e:
            raise HTTPException(
                status_code=503, detail=f"{label} set {set_id!r} unreadable: {e}"
            ) from e
        return Response(content=data, media_type=media_type(s), headers=headers)

    return router


@router.get("/catalog")
def catalog(
    request: Request,
    store: ChartStore = Depends(get_store),
    ocharts: OchartsService = Depends(get_ocharts),
) -> Response:
    sets = store.sets()
    entries = [
        {
            "id": cs.id,
            "name": cs.name,
            "bounds": list(cs.archive.header.bounds),  # w, s, e, n
            "min_zoom": cs.archive.header.min_zoom,
            "max_zoom": cs.archive.header.max_zoom,
            "sequence": cs.sequence,
            "tiles": f"/tiles/{cs.id}/{{z}}/{{x}}/{{y}}",
            "vector_layers": cs.metadata.get("vector_layers", []),
            # Tells the frontend a pmtiles vs on-demand o-charts set apart —
            # own MapLibre source vs shared /tiles/all union. See
            # docs/architecture/chart-tiles-serving.md#catalog-kind-field
            "kind": "pmtiles",
        }
        for cs in sets.values()
    ]
    # o-charts sets appear like any other; PMTiles ids win a collision, and
    # an o-charts scan failure must never break the whole catalog.
    try:
        taken = set(sets)
        entries.extend(e for e in ocharts.catalog_entries() if e["id"] not in taken)
    except Exception:  # noqa: BLE001
        log.exception("o-charts catalog scan failed")
    # `kind` must be folded into the digest, not just the body, or a client
    # cached from before `kind` existed 304s forever onto a pre-`kind`
    # response — see docs/architecture/chart-tiles-serving.md#catalog-kind-field
    # `licensed` likewise (it arrived later than `kind`, same hazard).
    digest = hashlib.sha1(
        ";".join(
            f"{e['id']}:{e['sequence']}:{e['kind']}:{e.get('licensed', False)}" for e in entries
        ).encode()
    ).hexdigest()[:16]
    etag = f'"{digest}"'
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    return JSONResponse({"sets": entries}, headers=headers)


def _cell_scale_label(scale: int) -> str:
    """A compact 1:NNk scale, or the raw number below 1000."""
    return f"1:{scale // 1000}k" if scale >= 1000 else f"1:{scale}"


class CellAt(BaseModel):
    """One o-charts cell charting a spot (`GET /cells/at`)."""

    set: str
    name: str
    #: Compilation scale denominator (CSCL).
    scale: int
    max_zoom: int


class CellsAt(BaseModel):
    #: Finest (smallest scale denominator) first.
    cells: list[CellAt]


@router.get("/cells/at", response_model=CellsAt)
def cells_at(
    lon: float = Query(ge=-180, le=180),
    lat: float = Query(ge=-90, le=90),
    free: bool = False,
    ocharts: OchartsService = Depends(get_ocharts),
) -> CellsAt:
    """The union cells charting (lon, lat), finest first — what the map's
    overscale / "zoom in for detail" badge reads its compilation scale from.
    `free` mirrors `/tiles/free`: licensed sets left out. Header data only,
    no decode; not cached (the answer follows the installed sets)."""
    return CellsAt(cells=[CellAt(**c) for c in ocharts.cells_at(lon, lat, free_only=free)])


@router.get("/debug/cells")
def debug_cells(
    ocharts: OchartsService = Depends(get_ocharts),
) -> Response:
    """DEBUG: every o-charts cell's coverage as GeoJSON for the client's
    "Cell coverage" overlay toggle. One Feature per cell; not cached, not
    on the serve path."""
    features: list[dict] = []
    for cs in ocharts.sets().values():
        for cell in cs.cells:
            cov = cell.coverage
            lines: list[list[list[float]]] = []
            if cov is not None:
                for ring in cov.rings_lonlat():
                    if len(ring) >= 2:
                        pts = [[lon, lat] for (lon, lat) in ring]
                        if pts[0] != pts[-1]:
                            pts.append(pts[0])
                        lines.append(pts)
            if not lines:
                w, s, e, n = cell.extent
                lines.append([[w, s], [e, s], [e, n], [w, n], [w, s]])
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "set": cs.id,
                        "name": cell.name,
                        "scale": cell.scale,
                        "min_zoom": cell.min_zoom,
                        "max_zoom": cell.max_zoom,
                        "has_coverage": cov is not None,
                        "label": f"{cell.name}  z{cell.min_zoom}-{cell.max_zoom}  {_cell_scale_label(cell.scale)}",
                    },
                    "geometry": {"type": "MultiLineString", "coordinates": lines},
                }
            )
    return JSONResponse(
        {"type": "FeatureCollection", "features": features},
        headers={"Cache-Control": NO_STORE},
    )


@router.get("/tiles/all/{z}/{x}/{y}")
def tile_all(
    z: int,
    x: int,
    y: int,
    request: Request,
    ocharts: OchartsService = Depends(get_ocharts),
    gate: DeviceGate = Depends(get_device_gate),
) -> Response:
    """Composite every subscribed o-charts set into one tile (#qwxtvtwo);
    PMTiles sets stay reachable only via their own `/tiles/{set_id}/...`.
    Registered BEFORE `/tiles/{set_id}/...` or a set named "all" would shadow it.
    403 for a browser that is not a registered device while a licensed set
    is installed — it uses `/tiles/free` instead."""
    _require_device(gate, ocharts, request)
    return _ocharts_tile_all(ocharts, z, x, y, request)


@router.get("/tiles/free/{z}/{x}/{y}")
def tile_free(
    z: int,
    x: int,
    y: int,
    request: Request,
    ocharts: OchartsService = Depends(get_ocharts),
) -> Response:
    """Like `/tiles/all`, over the sets that are not licensed (the CC0
    freenauticalchart.net ones) — what an unregistered device draws. A
    separate URL, not a per-cookie answer at `/tiles/all`: URL-keyed tile
    caches (the Service Worker's) would otherwise keep one device's answer
    for the other. Same shadowing rule as `/tiles/all`."""
    return _ocharts_tile_union(ocharts, z, x, y, request, free_only=True)


@router.get("/tiles/{set_id}/{z}/{x}/{y}")
def tile(
    set_id: str,
    z: int,
    x: int,
    y: int,
    request: Request,
    store: ChartStore = Depends(get_store),
    ocharts: OchartsService = Depends(get_ocharts),
    gate: DeviceGate = Depends(get_device_gate),
) -> Response:
    cs = store.get(set_id)
    if cs is None:
        ocs = ocharts.get(set_id)
        if ocs is not None:
            if ocharts.licensed(ocs):
                _require_device(gate, ocharts, request)
            return _ocharts_tile(ocharts, ocs, z, x, y, request)
        raise HTTPException(
            status_code=404,
            detail=f"unknown chart set {set_id!r}",
            headers={"Cache-Control": NO_STORE},
        )
    etag = _set_etag(cs)
    headers = {
        "ETag": etag,
        "Cache-Control": CACHE_CONTROL,
        "Vary": "Accept-Encoding",
    }
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    if not (0 <= z < 32 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
        return Response(status_code=404, headers=headers)

    header = cs.archive.header
    media_type = (
        MVT_CONTENT_TYPE
        if header.tile_type == TILE_TYPE_MVT
        else "application/octet-stream"
    )
    if header.tile_compression not in (COMPRESSION_GZIP, COMPRESSION_NONE):
        raise HTTPException(status_code=500, detail="unsupported tile compression")
    # a structurally broken archive (half-written pre-atomic-write) degrades
    # to 503, not a crash
    try:
        data = cs.archive.tile_data(z, x, y)
        if data is None:
            return Response(status_code=404, headers={**headers, "Cache-Control": NO_STORE})
        if header.tile_compression == COMPRESSION_GZIP:
            if _accepts_gzip(request):
                headers["Content-Encoding"] = "gzip"
            else:
                data = decompress(COMPRESSION_GZIP, data)
    except PMTilesError as e:
        raise HTTPException(
            status_code=503, detail=f"chart set {set_id!r} unreadable: {e}"
        ) from e
    return Response(content=data, media_type=media_type, headers=headers)


def _set_directory(
    set_id: str, store: ChartStore, ocharts: OchartsService
) -> tuple[Path, int] | None:
    """The on-disk directory a chart set's supplementary files live in, plus a
    change-tracking sequence for the ETag. `None` if no such set exists.
    PMTiles wins an id collision, mirroring `/catalog` and `/tiles`."""
    cs = store.get(set_id)
    if cs is not None:
        return cs.archive.path.parent, cs.sequence
    ocs = ocharts.get(set_id)
    if ocs is not None:
        return ocs.directory, ocs.sequence
    return None


def _contained(base: Path, candidate: Path, depth: int) -> bool:
    """Does `candidate` sit exactly `depth` levels inside `base`? Checked on
    the *resolved* path so a symlink pointing anywhere else fails, whatever
    it is named."""
    try:
        resolved = candidate.resolve()
    except OSError:
        return False
    parent = resolved.parent
    for _ in range(depth - 1):
        parent = parent.parent
    return parent == base


def _resolve_text_file(directory: Path, name: str) -> Path | None:
    """Map an untrusted ``TXTDSC``/``NTXTDS`` filename onto a path inside
    `directory`, or `None` if not a plain ``*.TXT`` file within the set.
    See docs/architecture/chart-tiles-serving.md for the path-safety contract."""
    if name != Path(name).name:  # separators, parent refs, or an absolute path
        return None
    if Path(name).suffix.upper() != TEXT_SUFFIX:
        return None
    try:
        base = directory.resolve()
    except OSError:
        return None
    direct = directory / name
    if direct.exists():
        # symlink escaping the set: refuse, don't fall through to another cell's note
        return direct if _contained(base, direct, 1) else None
    try:
        subdirs = sorted(
            Path(e.path) for e in os.scandir(directory) if e.is_dir(follow_symlinks=False)
        )
    except OSError:
        subdirs = []
    for sub in subdirs:
        candidate = sub / name
        if candidate.exists() and _contained(base, candidate, 2):
            return candidate
    return direct


@router.get("/text/{set_id}/{name}")
def text(
    set_id: str,
    name: str,
    request: Request,
    store: ChartStore = Depends(get_store),
    ocharts: OchartsService = Depends(get_ocharts),
    gate: DeviceGate = Depends(get_device_gate),
) -> Response:
    """Serve one S-57 external text description (`TXTDSC`/`NTXTDS`) referenced
    by a feature. `name` is chart data, untrusted — see `_resolve_text_file`
    for the path-safety contract. A licensed set's notes are its chart data
    too: registered devices only, like its tiles."""
    if store.get(set_id) is None:
        ocs = ocharts.get(set_id)
        if ocs is not None and ocharts.licensed(ocs):
            _require_device(gate, ocharts, request)
    resolved = _set_directory(set_id, store, ocharts)
    if resolved is None:
        raise HTTPException(status_code=404, detail=f"unknown chart set {set_id!r}")
    directory, sequence = resolved
    path = _resolve_text_file(directory, name)
    if path is None:
        raise HTTPException(status_code=400, detail=f"invalid text file name {name!r}")
    etag = f'"{set_id}-{sequence}-{name}"'
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        raise HTTPException(
            status_code=404, detail=f"no text file {name!r} in set {set_id!r}"
        ) from None
    except OSError as e:
        raise HTTPException(
            status_code=503, detail=f"text file {name!r} unreadable"
        ) from e
    # ASCII in practice; decode leniently rather than 500 on a stray byte
    return Response(
        content=data.decode("utf-8", errors="replace"),
        media_type=TEXT_CONTENT_TYPE,
        headers=headers,
    )


# /icons: ATON symbols rendered on demand, replacing a pre-baked spritesheet
# — see chartcore's icons::pack doc and docs/architecture/chart-tiles-serving.md
# (incl. why the ETag hashes the SVG, not chartcore's crate version).
ICON_CONTENT_TYPE = "image/svg+xml"
# Revalidate via ETag every request, not a blind max-age: the browser's own
# HTTP cache is unreachable from JS, so a stale max-age can't be busted.
ICON_CACHE_CONTROL = "public, no-cache"
# Longest real key is ~24 chars; 128 is generous headroom against an
# unbounded string reaching the renderer.
ICON_KEY_MAX_LEN = 128


@lru_cache(maxsize=512)
def _render_icon(key: str, roles: bool = False) -> tuple[str, str] | None:
    """One rendered SVG per key, memoised (rendering costs ~3ms, cheap but
    not free on a Pi). `roles` is part of the cache key: the two modes render
    different bytes for the same key, so sharing an entry would leak a palette."""
    svg = chartcore.render_aton_icon(key, roles)
    if svg is None:
        return None
    etag = f'"{hashlib.sha256(svg.encode()).hexdigest()[:16]}"'
    return svg, etag


@router.get("/icons/{key:path}")
def icon(key: str, request: Request, roles: bool = False) -> Response:
    """Render one ATON symbol as a pivot-centred SVG (key e.g. `BOYSHP/4/1/3,1`).
    `?roles=1` swaps in `#fe00XX` role sentinels. A 404 is ORDINARY — the
    frontend also probes here for non-ATON names; not logged."""
    key = key.removesuffix(".svg")
    if not key or len(key) > ICON_KEY_MAX_LEN:
        raise HTTPException(status_code=404, detail="no such icon")
    rendered = _render_icon(key, roles)
    if rendered is None:
        raise HTTPException(status_code=404, detail=f"no ATON icon for {key!r}")
    svg, etag = rendered
    headers = {"ETag": etag, "Cache-Control": ICON_CACHE_CONTROL}
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    return Response(content=svg, media_type=ICON_CONTENT_TYPE, headers=headers)


def _ocharts_tile(service, ocs, z: int, x: int, y: int, request: Request) -> Response:
    """Serve an on-demand o-charts tile with PMTiles' caching semantics. ETag
    also versions on TILE_SCHEMA_VERSION and scamin_bias_key, kept in
    lockstep with the RAM tile-cache key in OchartsService._tile."""
    bias = "-".join(str(v) for v in service.scamin_bias_key)
    etag = f'"{ocs.id}-{ocs.sequence}-v{TILE_SCHEMA_VERSION}-d{bias}"'
    headers = {
        "ETag": etag,
        "Cache-Control": CACHE_CONTROL,
        "Vary": "Accept-Encoding",
    }
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    if not (0 <= z < 32 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
        return Response(status_code=404, headers=headers)
    try:
        data = service.tile(ocs, z, x, y)
    except (chartcore.ChartError, DaemonUnavailable, TimeoutError) as e:
        # transient daemon/timeout: one-line warning (recurs per tile, a
        # traceback each would drown the log); ChartError is a real
        # cut/decode fault and keeps its traceback
        if isinstance(e, chartcore.ChartError):
            log.exception("o-charts tile %s z%d/%d/%d cut failed", ocs.id, z, x, y)
        else:
            log.warning(
                "o-charts tile %s z%d/%d/%d unavailable: %s: %s",
                ocs.id, z, x, y, type(e).__name__, e,
            )
        raise HTTPException(
            status_code=503, detail=f"chart set {ocs.id!r} unavailable: {e}"
        ) from e
    if data is None:
        return Response(status_code=404, headers={**headers, "Cache-Control": NO_STORE})
    if _accepts_gzip(request):
        headers["Content-Encoding"] = "gzip"
    else:
        data = gzip_decompress(data)
    return Response(content=data, media_type=MVT_CONTENT_TYPE, headers=headers)


def _ocharts_tile_all(service: OchartsService, z: int, x: int, y: int, request: Request) -> Response:
    return _ocharts_tile_union(service, z, x, y, request, free_only=False)


def _ocharts_tile_union(
    service: OchartsService, z: int, x: int, y: int, request: Request, free_only: bool
) -> Response:
    """Serve the unified `/tiles/all` (or `/tiles/free`) tile. ETag versions
    on service.union_version() (every subscribed set's id+sequence), kept in
    lockstep with the RAM tile-cache key in OchartsService._tile_all/_tile_free."""
    digest = hashlib.sha1(
        ";".join(f"{set_id}-{seq}" for set_id, seq in service.union_version(free_only)).encode()
    ).hexdigest()[:16]
    bias = "-".join(str(v) for v in service.scamin_bias_key)
    prefix = "free" if free_only else "all"
    etag = f'"{prefix}-{digest}-v{TILE_SCHEMA_VERSION}-d{bias}"'
    headers = {
        "ETag": etag,
        "Cache-Control": CACHE_CONTROL,
        "Vary": "Accept-Encoding",
    }
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    if not (0 <= z < 32 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
        return Response(status_code=404, headers=headers)
    try:
        data = service.tile_free(z, x, y) if free_only else service.tile_all(z, x, y)
    except (chartcore.ChartError, DaemonUnavailable, TimeoutError) as e:
        if isinstance(e, chartcore.ChartError):
            log.exception("o-charts tile-%s z%d/%d/%d cut failed", prefix, z, x, y)
        else:
            log.warning(
                "o-charts tile-%s z%d/%d/%d unavailable: %s: %s",
                prefix, z, x, y, type(e).__name__, e,
            )
        raise HTTPException(
            status_code=503, detail=f"chart set union unavailable: {e}"
        ) from e
    if data is None:
        return Response(status_code=404, headers={**headers, "Cache-Control": NO_STORE})
    if _accepts_gzip(request):
        headers["Content-Encoding"] = "gzip"
    else:
        data = gzip_decompress(data)
    return Response(content=data, media_type=MVT_CONTENT_TYPE, headers=headers)
