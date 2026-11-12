# SPDX-License-Identifier: GPL-2.0-only
"""/marks — standalone user marks, stored as SignalK waypoint resources, and
the ``FEATURE`` registration.

::

    GET    /marks          every mark (``stale: true`` = SignalK unreachable,
                           served from memory)
    PUT    /marks/{id}     create or replace (client-minted uuid)
    DELETE /marks/{id}

"Navigate to" is not here: the frontend's Go here (a planned route from the
boat, published through ``/routes/active``) is the one course publish.
Sync routes: each one may wait on SignalK, so FastAPI runs them in its
threadpool.
"""

from __future__ import annotations

import logging
from typing import Any, cast

from fastapi import APIRouter, Body, Depends, HTTPException, Response

from mivnav.api.deps import Runtime, get_runtime
from mivnav.config.model import Config
from mivnav.feature import DataProvider, Feature, FeatureCtx, Refresh
from mivnav.features.marks.store import (
    ICONS,
    MarkError,
    MarkStorageUnavailable,
    MarkStore,
)
from mivnav.features.route.runtime import build_route_resources

log = logging.getLogger(__name__)

__all__ = ["FEATURE", "router"]

router = APIRouter(prefix="/marks", tags=["marks"])


class MarksRuntime:
    """Holds the store — state that must outlive a config change, so not a
    ``Derived``. The resources client is resolved per call (host/token may
    change without a restart), as the route store does."""

    def __init__(self, ctx: FeatureCtx) -> None:
        self.store = MarkStore(lambda: build_route_resources(ctx.config.get()))

    def close(self) -> None:
        """Nothing to release."""


def get_marks(runtime: Runtime = Depends(get_runtime)) -> MarkStore:
    return cast(MarksRuntime, runtime.feature("marks")).store


@router.get("")
def list_marks(store: MarkStore = Depends(get_marks)) -> dict[str, Any]:
    stale = False
    try:
        store.refresh()
    except MarkStorageUnavailable as e:
        stale = True
        log.warning("serving marks from memory: %s", e)
    return {
        "marks": [m.model_dump(mode="json") for m in store.list()],
        "icons": list(ICONS),
        "stale": stale,
    }


@router.put("/{mark_id}")
def put_mark(
    mark_id: str, body: dict[str, Any] = Body(...), store: MarkStore = Depends(get_marks)
) -> dict[str, Any]:
    try:
        return store.save(mark_id, body).model_dump(mode="json")
    except MarkError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except MarkStorageUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@router.delete("/{mark_id}")
def delete_mark(mark_id: str, store: MarkStore = Depends(get_marks)) -> Response:
    try:
        deleted = store.delete(mark_id)
    except MarkError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except MarkStorageUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    if not deleted:
        raise HTTPException(status_code=404, detail=f"unknown mark {mark_id!r}")
    return Response(status_code=204)


def marks_data_provider(config: Config, runtime: MarksRuntime) -> DataProvider:
    def stats() -> dict:
        return {
            "count": len(runtime.store.list()),
            "storage": "signalk" if config.signalk.enabled else "none",
        }

    return DataProvider(
        id="marks",
        label="Marks",
        kind="live-stream",
        cache=None,
        refresh=Refresh("live"),
        prefetch=None,
        config_slice="signalk",
        stats=stats,
    )


FEATURE: Feature[MarksRuntime] = Feature(
    id="marks",
    routers=(router,),
    build_runtime=MarksRuntime,
    data_provider=marks_data_provider,
)
