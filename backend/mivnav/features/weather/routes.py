# SPDX-License-Identifier: GPL-2.0-only
"""``/weather`` — the Open-Meteo proxy AND the server-side wash/wind tile
renderer, and the ``FEATURE`` registration. See
docs/architecture/weather-tiles-serving.md for the route map."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

from mivnav.api.deps import Runtime, get_runtime
from mivnav.feature import Feature
from mivnav.features.weather.domains import domain_id_from_om_path
from mivnav.features.weather.mirror import WeatherMirror
from mivnav.features.weather.models import is_domain_allowed, model_catalog
from mivnav.features.weather.provider import weather_data_provider
from mivnav.features.weather.proxy import WeatherProxy
from mivnav.features.weather.render import uv_components
from mivnav.features.weather.renderer import WeatherRenderer
from mivnav.features.weather.sources import (
    DecodeRequest,
    decode_grib_uv,
    decode_grib_wind,
    decode_om,
    decode_om_uv,
    list_all_sources,
    resolve_source,
)
from mivnav.features.weather.runtime import WeatherRuntime, build_weather_runtime
from mivnav.features.weather.tilecache import cache_key

#: `"grib:<dataset id>/<product id>/<valid time ISO>"` — distinct in SHAPE
#: from a bare `.om` path, so the same `path` string can double as the
#: tile's cache-key identity. See docs/architecture/weather-tiles-serving.md.
GRIB_PATH_PREFIX = "grib:"


def _parse_grib_path(path: str) -> tuple[str, str, datetime] | None:
    """``(dataset_id, product_id, valid_time)`` if `path` is GRIB-shaped,
    else ``None`` (an ordinary ``.om`` path)."""
    if not path.startswith(GRIB_PATH_PREFIX):
        return None
    rest = path[len(GRIB_PATH_PREFIX) :]
    dataset_id, product_id, valid_time_str = rest.split("/", 2)
    valid_time = datetime.fromisoformat(valid_time_str.replace("Z", "+00:00"))
    return dataset_id, product_id, valid_time

router = APIRouter()

__all__ = ["FEATURE", "get_weather_proxy", "get_weather_renderer", "router"]

# The capture index and the point forecast are live state; a client (or a
# browser HTTP cache) must never hold them, or a new model run goes unseen.
NO_STORE = "no-store"

# The rendered-tile identity (om_path, variable, dark, z, x, y) is genuinely
# immutable — a concrete `.om` never changes once written — so tiles get
# a much stronger Cache-Control than the `.om` proxy's own passthrough
# routes: no reason to ever revalidate.
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"

# Bump if a change to HOW a tile is rendered (a colour-scale fix, a grid-math
# fix) would alter the bytes served for the SAME (path, variable, dark, z, x,
# y) identity without any of those changing — mirrors
# mivnav.features.ocharts.service.TILE_SCHEMA_VERSION / mivnav.features.satellite
# .routes.SATELLITE_TILE_SCHEMA_VERSION. Carried in the ETag so a fix invalidates
# every client's cache at once.
WEATHER_RENDER_SCHEMA_VERSION = 1


def get_weather_proxy(runtime: Runtime = Depends(get_runtime)) -> WeatherProxy:
    return cast(WeatherRuntime, runtime.feature("weather")).proxy()


def get_weather_renderer(runtime: Runtime = Depends(get_runtime)) -> WeatherRenderer:
    return cast(WeatherRuntime, runtime.feature("weather")).renderer()


def get_weather_mirror(runtime: Runtime = Depends(get_runtime)) -> WeatherMirror:
    """The baked-dataset lookup consulted BEFORE the proxy (#rktyytqx item 3:
    "live proxy path stays available for anything NOT downloaded")."""
    return cast(WeatherRuntime, runtime.feature("weather")).mirror()


def get_weather_runtime(runtime: Runtime = Depends(get_runtime)) -> WeatherRuntime:
    """Only the GRIB-sourced tile/point handlers need this directly, to build
    a `GribStore` for the dataset/product a parsed `grib:...` path names."""
    return cast(WeatherRuntime, runtime.feature("weather"))


def _valid_tile(z: int, x: int, y: int) -> bool:
    return 0 <= z < 32 and 0 <= x < (1 << z) and 0 <= y < (1 << z)


def _require_allowed_domain(runtime: Runtime, om_path: str) -> None:
    """404 if ``om_path``'s domain isn't in this boat's allow-list. Call ONLY
    on a path about to reach ``WeatherProxy`` (a mirror hit is served first).
    ``grib:...`` paths are exempt — see docs/architecture/weather-tiles-serving.md."""
    if om_path.startswith(GRIB_PATH_PREFIX):
        return
    config = runtime.config.get()
    domain = domain_id_from_om_path(om_path)
    if not is_domain_allowed(config, domain):
        raise HTTPException(
            status_code=404,
            detail=(
                f"domain {domain!r} is not offered by this boat — declare a "
                "weather dataset for it or add it to weather.on_demand_domains "
                "(see GET /datasets/weather/models)"
            ),
        )


@router.head("/weather/data_spatial/{path:path}")
async def data_spatial_head(
    path: str,
    request: Request,
    runtime: Runtime = Depends(get_runtime),
    proxy: WeatherProxy = Depends(get_weather_proxy),
    mirror: WeatherMirror = Depends(get_weather_mirror),
) -> Response:
    """The reader HEADs a ``.om`` before ranging it — without this a GET-only
    proxy 405s it. A baked file answers first with no network attempt; a MISS
    falls through to the live proxy only if allow-listed."""
    full = f"data_spatial/{path}"
    if path.endswith(".om"):
        hit = mirror.head(full)
        if hit is not None:
            status, headers = hit
            return Response(status_code=status, headers=headers)
        _require_allowed_domain(runtime, path)
        status, headers = await proxy.head_om(full, request.url.query)
        return Response(status_code=status, headers=headers)
    # A HEAD of the mutable index: report reachable, uncached.
    _require_allowed_domain(runtime, path)
    status, _body, ctype = await proxy.passthrough_tiles(full, request.url.query)
    return Response(
        status_code=status, media_type=ctype, headers={"Cache-Control": NO_STORE}
    )


@router.get("/weather/data_spatial/{path:path}")
async def data_spatial(
    path: str,
    request: Request,
    runtime: Runtime = Depends(get_runtime),
    proxy: WeatherProxy = Depends(get_weather_proxy),
    mirror: WeatherMirror = Depends(get_weather_mirror),
) -> Response:
    full = f"data_spatial/{path}"
    query = request.url.query
    range_header = request.headers.get("range")
    if path.endswith(".om") and range_header:
        hit = mirror.get_range(full, range_header)
        if hit is not None:
            status, headers, body = hit
            return Response(content=body, status_code=status, headers=headers)
        _require_allowed_domain(runtime, path)
        status, headers, body = await proxy.om_range(full, query, range_header)
        return Response(content=body, status_code=status, headers=headers)
    # latest.json / in-progress.json, or a .om probed without a Range.
    _require_allowed_domain(runtime, path)
    status, body, ctype = await proxy.passthrough_tiles(full, query)
    # Mirror the proxy's own latest.json TTL into Cache-Control so re-opens
    # collapse client-side too; everything else stays strictly uncached.
    if path.endswith("latest.json") and proxy.latest_ttl > 0:
        cache_control = f"public, max-age={proxy.latest_ttl}"
    else:
        cache_control = NO_STORE
    return Response(
        content=body,
        status_code=status,
        media_type=ctype,
        headers={"Cache-Control": cache_control},
    )


def _grib_baked_entries(weather_runtime: WeatherRuntime) -> list[dict]:
    """GRIB-sourced siblings of ``WeatherMirror.baked()``'s `.om` entries, in
    the same ``{domain, first, last, files}`` shape — ``domain`` is the
    compound ``grib:<dataset id>/<product id>`` id."""
    out: list[dict] = []
    for dataset_id, product_id in weather_runtime.grib_datasets():
        try:
            store = weather_runtime.grib_store(dataset_id, product_id)
            times = store.valid_times()
        except (KeyError, ValueError, FileNotFoundError):
            continue
        if not times:
            continue
        out.append(
            {
                "domain": f"{GRIB_PATH_PREFIX}{dataset_id}/{product_id}",
                # every GRIB valid time is UTC and exactly on the minute, so
                # this format never truncates a fractional second
                "first": times[0].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "last": times[-1].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "files": len(times),
            }
        )
    return out


@router.get("/weather/sources")
async def weather_sources(
    runtime: Runtime = Depends(get_runtime),
    mirror: WeatherMirror = Depends(get_weather_mirror),
) -> Response:
    """``{"sources": [...]}`` — every weather source this boat can select.
    ids are OPAQUE, never parsed by any consumer (a `grib:` id leaked into
    the frontend once already) — see docs/architecture/weather-tiles-serving.md."""
    # unknown position -> empty SignalK coverage rather than a guessed
    # lat/lon (a regional model asked about the wrong place answers nothing)
    position: tuple[float, float] | None = None
    try:
        me = runtime.signalk().snapshot().get("self")
        if isinstance(me, dict):
            lat, lng = me.get("lat"), me.get("lng")
            if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
                position = (float(lat), float(lng))
    except Exception:  # a SignalK hiccup must not fail discovery
        position = None
    sources = await list_all_sources(runtime.config.get(), mirror, position)
    return JSONResponse(
        {"sources": [s.describe().as_json() for s in sources]},
        headers={"Cache-Control": NO_STORE},
    )


@router.get("/weather/baked")
async def baked(
    mirror: WeatherMirror = Depends(get_weather_mirror),
    weather_runtime: WeatherRuntime = Depends(get_weather_runtime),
) -> Response:
    """Which domains this boat has ON DISK, and each one's forecast span —
    the one route distinguishing "answers offline" from "falls through to
    the live proxy". Derived from the filesystem, not ``Config.datasets``."""
    domains = [vars(d) for d in mirror.baked()]
    domains.extend(_grib_baked_entries(weather_runtime))
    return JSONResponse(
        {"domains": domains},
        headers={"Cache-Control": NO_STORE},
    )


@router.get("/datasets/weather/models")
async def weather_models(
    runtime: Runtime = Depends(get_runtime),
    mirror: WeatherMirror = Depends(get_weather_mirror),
) -> Response:
    """Which Open-Meteo models this boat can currently show. Deliberately
    separate from ``GET /weather/baked``: "what can I pick" vs "how far
    offline does it reach" are different questions."""
    return JSONResponse(
        {
            "models": [
                {
                    "id": m.id,
                    "label": m.label,
                    "group": m.group,
                    "groupLabel": m.group_label,
                    "timeInterval": m.time_interval,
                }
                for m in model_catalog(runtime.config.get(), mirror)
            ]
        },
        headers={"Cache-Control": NO_STORE},
    )


@router.get("/weather/forecast")
async def forecast(
    request: Request,
    proxy: WeatherProxy = Depends(get_weather_proxy),
) -> Response:
    status, body, ctype = await proxy.forecast(request.url.query)
    return Response(
        content=body,
        status_code=status,
        media_type=ctype,
        headers={"Cache-Control": NO_STORE},
    )


# path/variable/dark are QUERY params (not path segments) below so
# `/tiles/` stays literal in the URL for the frontend's `isTileRequest`
# predicate.


def _tile_etag(kind: str, path: str, variable: str, dark: bool, z: int, x: int, y: int) -> str:
    key = cache_key(kind, path, variable, dark, z, x, y)
    return f'"{key}-v{WEATHER_RENDER_SCHEMA_VERSION}"'


# The LEGACY `?path=` routes' decode callables: the renderer checks its tile
# cache before calling any of these, so a hit costs no decode. Address data
# by a client-built path instead of a source id; go with `qmnwrupv`.


def _partial_om(proxy: WeatherProxy, om_path: str, variable: str):
    return lambda: decode_om(proxy, om_path, variable)


def _partial_om_uv(proxy: WeatherProxy, om_path: str, variable: str):
    return lambda: decode_om_uv(proxy, om_path, variable)


def _partial_grib(store, valid_time: datetime):
    return lambda: decode_grib_wind(store, valid_time)


def _partial_grib_uv(store, valid_time: datetime):
    return lambda: decode_grib_uv(store, valid_time)


@router.get("/weather/tiles/wash/{z}/{x}/{y}.png")
async def wash_tile(
    z: int,
    x: int,
    y: int,
    request: Request,
    path: str = Query(..., description="concrete .om path, e.g. dwd_icon/2026/.../T1500.om"),
    variable: str = Query(...),
    dark: bool = Query(False),
    runtime: Runtime = Depends(get_runtime),
    renderer: WeatherRenderer = Depends(get_weather_renderer),
    proxy: WeatherProxy = Depends(get_weather_proxy),
    weather_runtime: WeatherRuntime = Depends(get_weather_runtime),
) -> Response:
    _require_allowed_domain(runtime, path)
    etag = _tile_etag("wash", path, variable, dark, z, x, y)
    headers = {"ETag": etag, "Cache-Control": IMMUTABLE_CACHE_CONTROL}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if not _valid_tile(z, x, y):
        return Response(status_code=404, headers=headers)
    try:
        grib = _parse_grib_path(path)
        if grib is not None:
            dataset_id, product_id, valid_time = grib
            store = weather_runtime.grib_store(dataset_id, product_id)
            decode = _partial_grib(store, valid_time)
        else:
            decode = _partial_om(proxy, path, variable)
        png = await renderer.wash_tile(path, variable, dark, z, x, y, decode)
    except (KeyError, ValueError) as e:
        # Unknown domain/variable, an unparseable grib: path, or the .om
        # doesn't carry it (e.g. a model switch mid-flight) — a
        # client-addressable 404, not a 500.
        raise HTTPException(status_code=404, detail=str(e), headers=headers) from e
    if png is None:  # z beyond render_max_zoom
        return Response(status_code=404, headers=headers)
    return Response(content=png, media_type="image/png", headers=headers)


@router.get("/weather/tiles/wind/{z}/{x}/{y}.png")
async def wind_tile(
    z: int,
    x: int,
    y: int,
    request: Request,
    path: str = Query(...),
    variable: str = Query(...),
    runtime: Runtime = Depends(get_runtime),
    renderer: WeatherRenderer = Depends(get_weather_renderer),
    proxy: WeatherProxy = Depends(get_weather_proxy),
    weather_runtime: WeatherRuntime = Depends(get_weather_runtime),
) -> Response:
    _require_allowed_domain(runtime, path)
    # dark doesn't affect the wind encoding (see renderer.wind_tile) — not
    # part of the identity/ETag.
    etag = _tile_etag("wind", path, variable, False, z, x, y)
    headers = {"ETag": etag, "Cache-Control": IMMUTABLE_CACHE_CONTROL}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if not _valid_tile(z, x, y):
        return Response(status_code=404, headers=headers)
    try:
        grib = _parse_grib_path(path)
        if grib is not None:
            dataset_id, product_id, valid_time = grib
            store = weather_runtime.grib_store(dataset_id, product_id)
            decode_uv = _partial_grib_uv(store, valid_time)
        else:
            decode_uv = _partial_om_uv(proxy, path, variable)
        png = await renderer.field_tile(path, variable, z, x, y, decode_uv)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=404, detail=str(e), headers=headers) from e
    if png is None:  # z beyond wind_tex_max_zoom
        return Response(status_code=404, headers=headers)
    return Response(content=png, media_type="image/png", headers=headers)


@router.get("/weather/point")
async def point(
    request: Request,
    path: str = Query(...),
    variable: str = Query(...),
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(...),
    runtime: Runtime = Depends(get_runtime),
    renderer: WeatherRenderer = Depends(get_weather_renderer),
    proxy: WeatherProxy = Depends(get_weather_proxy),
    weather_runtime: WeatherRuntime = Depends(get_weather_runtime),
) -> Response:
    """`{"value": ..., "direction": ...}` at a point — replaces the deleted
    client-side `sampleWeatherPoint`; used today only for `waves`, which the
    plain point-forecast API can't answer. Reuses `GridDecoder`'s LRU, so
    near-free once the view's wash tile already decoded the same variable."""
    _require_allowed_domain(runtime, path)
    try:
        grib = _parse_grib_path(path)
        if grib is not None:
            dataset_id, product_id, valid_time = grib
            store = weather_runtime.grib_store(dataset_id, product_id)
            decode = _partial_grib(store, valid_time)
        else:
            decode = _partial_om(proxy, path, variable)
        result = await renderer.point(decode, lat, lon)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=404, detail=str(e), headers={"Cache-Control": NO_STORE}) from e
    return JSONResponse(result, headers={"Cache-Control": NO_STORE})


# id-addressed rendering (the source registry): `{id}` OPAQUE, `{variable}`
# CANONICAL, `time` an explicit instant. NO FALLBACK — see
# docs/architecture/weather-tiles-serving.md#id-addressed-rendering-the-source-registry.


def _parse_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise HTTPException(
            status_code=400, detail=f"time {value!r} is not an ISO-8601 instant"
        ) from e
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


async def _resolve(
    runtime: Runtime, mirror: WeatherMirror, proxy: WeatherProxy, source_id: str
):
    """Resolve the opaque id, or 404 naming the discovery route. **Called
    from INSIDE each route's decode callable, never ahead of it**, so it only
    runs on a tile-cache MISS — resolving scans the filesystem/SignalK."""
    source = await resolve_source(runtime.config.get(), mirror, source_id, proxy)
    if source is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"no weather source {source_id!r} — see GET /weather/sources for "
                "what this boat currently offers"
            ),
        )
    return source


@router.get("/weather/sources/{source_id}/wash/{variable}/{z}/{x}/{y}.png")
async def source_wash_tile(
    source_id: str,
    variable: str,
    z: int,
    x: int,
    y: int,
    request: Request,
    time: str = Query(..., description="ISO-8601 valid time, e.g. 2026-07-29T15:00Z"),
    dark: bool = Query(False),
    runtime: Runtime = Depends(get_runtime),
    renderer: WeatherRenderer = Depends(get_weather_renderer),
    proxy: WeatherProxy = Depends(get_weather_proxy),
    mirror: WeatherMirror = Depends(get_weather_mirror),
) -> Response:
    """The colourized raster wash for one source's variable at one instant."""
    when = _parse_time(time)
    identity = f"{source_id}@{when.isoformat()}"
    etag = _tile_etag("wash", identity, variable, dark, z, x, y)
    headers = {"ETag": etag, "Cache-Control": IMMUTABLE_CACHE_CONTROL}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if not _valid_tile(z, x, y):
        return Response(status_code=404, headers=headers)
    async def decode():
        source = await _resolve(runtime, mirror, proxy, source_id)
        return await source.decode(DecodeRequest(variable, when, tile=(z, x, y)))

    try:
        png = await renderer.wash_tile(identity, variable, dark, z, x, y, decode)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=404, detail=str(e), headers=headers) from e
    if png is None:  # z beyond render_max_zoom
        return Response(status_code=404, headers=headers)
    return Response(content=png, media_type="image/png", headers=headers)


@router.get("/weather/sources/{source_id}/field/{variable}/{z}/{x}/{y}.png")
async def source_field_tile(
    source_id: str,
    variable: str,
    z: int,
    x: int,
    y: int,
    request: Request,
    time: str = Query(...),
    runtime: Runtime = Depends(get_runtime),
    renderer: WeatherRenderer = Depends(get_weather_renderer),
    proxy: WeatherProxy = Depends(get_weather_proxy),
    mirror: WeatherMirror = Depends(get_weather_mirror),
) -> Response:
    """The RGBA vector texture the particle sim samples. ``field``, not
    ``wind``: waves carry a direction too, so no second route is needed. A
    variable with no direction 404s rather than encoding zeros (a plausible-looking but wrong still texture)."""
    when = _parse_time(time)
    identity = f"{source_id}@{when.isoformat()}"
    # dark doesn't affect the encoding — not part of the identity/ETag.
    etag = _tile_etag("wind", identity, variable, False, z, x, y)
    headers = {"ETag": etag, "Cache-Control": IMMUTABLE_CACHE_CONTROL}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if not _valid_tile(z, x, y):
        return Response(status_code=404, headers=headers)
    async def decode_uv():
        source = await _resolve(runtime, mirror, proxy, source_id)
        return uv_components(
            await source.decode(DecodeRequest(variable, when, tile=(z, x, y)))
        )

    try:
        png = await renderer.field_tile(identity, variable, z, x, y, decode_uv)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=404, detail=str(e), headers=headers) from e
    if png is None:  # z beyond wind_tex_max_zoom
        return Response(status_code=404, headers=headers)
    return Response(content=png, media_type="image/png", headers=headers)


@router.get("/weather/sources/{source_id}/point")
async def source_point(
    source_id: str,
    variable: str = Query(...),
    time: str = Query(...),
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(...),
    runtime: Runtime = Depends(get_runtime),
    renderer: WeatherRenderer = Depends(get_weather_renderer),
    proxy: WeatherProxy = Depends(get_weather_proxy),
    mirror: WeatherMirror = Depends(get_weather_mirror),
) -> Response:
    """``{"value": ..., "direction": ...}`` at one position. ``no-store``,
    matching the legacy point route: the whole point is "matches what is on
    screen right now"."""
    when = _parse_time(time)

    async def decode():
        source = await _resolve(runtime, mirror, proxy, source_id)
        return await source.decode(DecodeRequest(variable, when, at=(lat, lon)))

    try:
        result = await renderer.point(decode, lat, lon)
    except (KeyError, ValueError) as e:
        raise HTTPException(
            status_code=404, detail=str(e), headers={"Cache-Control": NO_STORE}
        ) from e
    return JSONResponse(result, headers={"Cache-Control": NO_STORE})


FEATURE: Feature[WeatherRuntime] = Feature(
    id="weather",
    routers=(router,),
    build_runtime=build_weather_runtime,
    data_provider=weather_data_provider,
)
