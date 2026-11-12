# SPDX-License-Identifier: GPL-2.0-only
"""``/themes`` and ``/themes.css`` — the palettes, and the chrome CSS built
from them. See docs/architecture/theme-runtime-source.md for why ``/themes``
returns an array and why both routes are no-cache with a strong ETag."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from mivnav.api.charts import CACHE_CONTROL, _if_none_match
from mivnav.api.deps import Runtime, get_runtime
from mivnav.feature import Feature
from mivnav.features.themes.provider import themes_data_provider
from mivnav.features.themes.runtime import ThemesRuntime, build_themes_runtime
from mivnav.features.themes.store import ThemeSnapshot

router = APIRouter()

JSON_CONTENT_TYPE = "application/json"
CSS_CONTENT_TYPE = "text/css; charset=utf-8"


def _snapshot(runtime: Runtime) -> ThemeSnapshot:
    feature: ThemesRuntime = runtime.feature("themes")
    return feature.store().snapshot()


@router.get("/themes")
def themes(request: Request, runtime: Runtime = Depends(get_runtime)) -> Response:
    """Every theme, in display order. See the module docstring for why this
    is an array."""
    snapshot = _snapshot(runtime)
    headers = {"ETag": snapshot.json_etag, "Cache-Control": CACHE_CONTROL}
    if _if_none_match(request, snapshot.json_etag):
        return Response(status_code=304, headers=headers)
    return Response(content=snapshot.json_bytes, media_type=JSON_CONTENT_TYPE, headers=headers)


@router.get("/themes.css")
def themes_css(request: Request, runtime: Runtime = Depends(get_runtime)) -> Response:
    """The chrome half, as real CSS — see :mod:`mivnav.features.themes.css`
    for why that half cannot be JSON the client interprets."""
    snapshot = _snapshot(runtime)
    headers = {"ETag": snapshot.css_etag, "Cache-Control": CACHE_CONTROL}
    if _if_none_match(request, snapshot.css_etag):
        return Response(status_code=304, headers=headers)
    return Response(content=snapshot.css_text, media_type=CSS_CONTENT_TYPE, headers=headers)


FEATURE: Feature[ThemesRuntime] = Feature(
    id="themes",
    routers=(router,),
    build_runtime=build_themes_runtime,
    data_provider=themes_data_provider,
)
