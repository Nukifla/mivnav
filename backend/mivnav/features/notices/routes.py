# SPDX-License-Identifier: GPL-2.0-only
"""``/notices`` — notices to mariners and navigational warnings, merged
from every enabled notices dataset, and the ``FEATURE`` registration.
Wire contract: efs.md §6 (frozen with the frontend).

The one module in the package allowed to import ``mivnav.api.deps``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse

from mivnav.api.deps import Runtime, get_runtime
from mivnav.feature import Feature
from mivnav.features.notices.catalog import DEFAULT_SOURCE, SOURCES
from mivnav.features.notices.provider import notices_data_provider
from mivnav.features.notices.runtime import (
    NoticesNotFound,
    NoticesRuntime,
    NoticesUnavailable,
    build_notices_runtime,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/notices", tags=["notices"])

__all__ = ["FEATURE", "get_dataset_trigger", "get_notices", "router"]

#: Revalidate every time — the body changes with each pull, and a
#: conditional request costs a 304 on the LAN.
CACHE_CONTROL = "no-cache"

_EMPTY_MAP = b'{"type":"FeatureCollection","features":[]}'


def get_notices(runtime: Runtime = Depends(get_runtime)) -> NoticesRuntime:
    return cast(NoticesRuntime, runtime.feature("notices"))


def get_dataset_trigger(runtime: Runtime = Depends(get_runtime)) -> Callable[[str], bool]:
    """Start one dataset's update through the generic dataset path (the
    one the scheduler and ``POST /datasets/{id}/ingest`` use)."""
    return runtime.trigger_dataset


def _if_none_match(request: Request, etag: str) -> bool:
    tags = [t.strip() for f in request.headers.getlist("if-none-match") for t in f.split(",")]
    return "*" in tags or etag in tags or f"W/{etag}" in tags


def _trigger(trigger: Callable[[str], bool], dataset_id: str) -> None:
    try:
        trigger(dataset_id)
    except Exception:  # noqa: BLE001 — a refused start shows in the status
        log.warning("notices: could not start an update of %r", dataset_id, exc_info=True)


@router.get("/status")
def status(
    notices: NoticesRuntime = Depends(get_notices),
    trigger: Callable[[str], bool] = Depends(get_dataset_trigger),
) -> dict[str, Any]:
    """``{state, version, fetched_at, count, by_family, error}`` over every
    enabled notices dataset. Also starts the FIRST pull of a new dataset on
    an automatic schedule, rather than waiting for the scheduler's poll."""
    for dataset_id in notices.first_runs_due():
        _trigger(trigger, dataset_id)
    return notices.status()


@router.post("/refresh")
def refresh(
    notices: NoticesRuntime = Depends(get_notices),
    trigger: Callable[[str], bool] = Depends(get_dataset_trigger),
) -> dict[str, Any]:
    """Update every enabled notices dataset now, whatever its schedule (a
    dataset already updating is left alone); returns the status right after
    kicking them — poll ``/notices/status`` for the result."""
    for ds in notices.datasets():
        _trigger(trigger, ds.id)
    return notices.status()


@router.get("/sources")
def sources() -> dict[str, Any]:
    """The notices source catalog — what a notices dataset can name as its
    ``implementation`` and the regions each offers (``params.regions``).
    Read by the Datasets tab's region picker."""
    return {"default": DEFAULT_SOURCE, "sources": [s.summary() for s in SOURCES.values()]}


@router.get(
    "/map.geojson",
    response_class=Response,
    responses={200: {"content": {"application/geo+json": {}}}, 304: {"description": "Not modified"}},
)
def map_geojson(request: Request, notices: NoticesRuntime = Depends(get_notices)) -> Response:
    """Every notice's geometry as one FeatureCollection (efs.md §6).
    ``ETag`` = the snapshot version."""
    served = notices.served()
    if served is None:
        return Response(_EMPTY_MAP, media_type="application/geo+json", headers={"Cache-Control": CACHE_CONTROL})
    etag = f'"{served.version}"'
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    return Response(served.map_bytes, media_type="application/geo+json", headers=headers)


@router.get(
    "/list",
    response_class=Response,
    responses={200: {"content": {"application/json": {}}}, 304: {"description": "Not modified"}},
)
def notice_list(request: Request, notices: NoticesRuntime = Depends(get_notices)) -> Response:
    """Compact rows of every notice, including EfS A/B and notices with no
    geometry (``lon``/``lat`` null). ``ETag`` = the snapshot version."""
    served = notices.served()
    if served is None:
        return Response(
            b'{"version":null,"fetched_at":null,"items":[]}',
            media_type="application/json",
            headers={"Cache-Control": CACHE_CONTROL},
        )
    etag = f'"{served.version}"'
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if _if_none_match(request, etag):
        return Response(status_code=304, headers=headers)
    return Response(served.list_bytes, media_type="application/json", headers=headers)


@router.get("/attachments/{key}", response_class=FileResponse)
def attachment(key: str, notices: NoticesRuntime = Depends(get_notices)) -> FileResponse:
    """One message attachment, from the boat's disk cache (fetched through
    once when not held yet)."""
    try:
        path, info = notices.attachment(key)
    except NoticesNotFound as e:
        raise HTTPException(status_code=404, detail=f"no attachment {key!r}") from e
    except NoticesUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return FileResponse(
        path,
        media_type=info.get("mime") or "application/octet-stream",
        filename=info.get("file_name") or key,
        content_disposition_type="inline",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# Last: the catch-all would shadow every route registered after it.
@router.get("/{ident:path}")
def notice(ident: str, notices: NoticesRuntime = Depends(get_notices)) -> dict[str, Any]:
    """One notice in full, both languages, by uuid or shortId (shortIds of
    firing areas contain ``/`` and spaces, hence ``:path``). Not in the
    current feed (e.g. a cancelled reference) → fetched from Niord once and
    kept; 404 when Niord has none, 503 when it can't be asked."""
    try:
        return notices.detail(ident)
    except NoticesNotFound as e:
        raise HTTPException(status_code=404, detail=f"no notice {ident!r}") from e
    except NoticesUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


FEATURE: Feature[NoticesRuntime] = Feature(
    id="notices",
    routers=(router,),
    build_runtime=build_notices_runtime,
    data_provider=notices_data_provider,
)
