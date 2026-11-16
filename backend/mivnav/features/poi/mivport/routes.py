# SPDX-License-Identifier: GPL-2.0-only
"""mivport's HTTP surface: a baked mivport set's offline place details
(``/poi/mivport/details``) and photos (``/poi/mivport/photos``), plus its
``FEATURE`` registration. Both only ever read the bake's files."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from mivnav.api.deps import Runtime, get_runtime
from mivnav.feature import Feature
from mivnav.features.poi.routes import get_poi_store
from mivnav.features.poi.store import PoiStore

from . import store as mp_store

FEATURE_ID = "mivport"

router = APIRouter(prefix="/poi/mivport")

#: A stored photo's name is its mivport photo id, and mivport photos are
#: never edited in place (a new photo gets a new id).
PHOTO_CACHE_CONTROL = "public, max-age=31536000, immutable"


class MivportRuntime:
    def __init__(self, ctx: Any) -> None:
        self._config = ctx.config

    def web_url(self) -> str:
        return self._config.get().mivport.web_url

    def close(self) -> None:
        pass


def _runtime(runtime: Runtime = Depends(get_runtime)) -> MivportRuntime:
    return runtime.feature(FEATURE_ID)  # type: ignore[return-value]


@router.get("/details/{set_id}/{ref}")
def place_detail(
    set_id: str,
    ref: str,
    store: PoiStore = Depends(get_poi_store),
    rt: MivportRuntime = Depends(_runtime),
) -> dict:
    """One mivport place as the bake stored it: attributes, OSM attributes,
    reviews, photos (pointing at the boat's copies where downloaded) and the
    data attribution. 404 when the set or the place is unknown. ``set_id``
    resolves through the store's scan and ``ref`` is only a bound SQL
    parameter, so neither reaches outside the store."""
    directory = store.set_dir(set_id)
    found = (
        mp_store.read_detail(mp_store.details_path(directory, set_id), ref)
        if directory is not None
        else None
    )
    if found is None:
        raise HTTPException(status_code=404, detail=f"no stored detail for {set_id}/{ref}")
    detail, meta = found
    detail = mp_store.with_local_photos(detail, mp_store.photos_dir(directory, set_id), set_id)  # type: ignore[arg-type]
    out = {**detail, "attribution": meta.get("attribution", "")}
    try:
        out["fetched_at"] = float(meta.get("fetched_at", "0"))
    except ValueError:
        out["fetched_at"] = 0.0
    web = rt.web_url()
    if web:
        out["web_url"] = f"{web}/#place={ref}"
    return out


@router.get(
    "/photos/{set_id}/{name}",
    response_class=FileResponse,
    responses={200: {"content": {"image/jpeg": {}}}},
)
def place_photo(set_id: str, name: str, store: PoiStore = Depends(get_poi_store)) -> FileResponse:
    """One downloaded photo (``<uuid>.view.jpg`` / ``<uuid>.thumb.jpg``)."""
    directory = store.set_dir(set_id)
    if directory is None or not mp_store.PHOTO_NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="no such photo")
    path = mp_store.photos_dir(directory, set_id) / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such photo")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": PHOTO_CACHE_CONTROL})


FEATURE: Feature[MivportRuntime] = Feature(
    id=FEATURE_ID,
    routers=(router,),
    build_runtime=MivportRuntime,
)
