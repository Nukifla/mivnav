# SPDX-License-Identifier: GPL-2.0-only
"""mivport's HTTP surface and its ``FEATURE`` registration.

- ``/poi/mivport/...`` — reading: a baked set's offline place details and
  photos, with the boat's own changes merged in, and the local overlay
  (``/poi/mivport/local``);
- ``/mivport/...`` — editing (docs/architecture/mivport-editing.md): the
  boat-wide account, the kinds/attrs registry, the writes (queued in the
  outbox and answered at once), the outbox itself and history.
"""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import date, datetime
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from mivnav.api.deps import Runtime, get_runtime
from mivnav.config.derived import Derived
from mivnav.feature import Feature
from mivnav.features.poi.routes import get_poi_store
from mivnav.features.poi.store import PoiStore

from . import client as mp_client
from . import local
from . import store as mp_store
from .account import Account, AccountError, RegistryCache
from .client import MivportError, MivportUnreachable
from .outbox import Outbox, OutboxError
from .sync import Syncer

FEATURE_ID = "mivport"

router = APIRouter(prefix="/poi/mivport")
edit_router = APIRouter(prefix="/mivport")

#: A stored photo's name is its mivport photo id, and mivport photos are
#: never edited in place (a new photo gets a new id).
PHOTO_CACHE_CONTROL = "public, max-age=31536000, immutable"

#: ``/poi/mivport/details/local/{ref}``: a place only the boat knows yet.
LOCAL_SET = "local"

#: mivport's own photo limits (README, "Photos").
MAX_VIEW_BYTES = 2 * 1024 * 1024
MAX_THUMB_BYTES = 200 * 1024


class MivportRuntime:
    """The feature's runtime: the account, the outbox (rebuilt when
    ``data_root`` moves) and the sync thread, started here and stopped in
    :meth:`close`. ``http``/``clock``/``start`` are for tests."""

    def __init__(
        self,
        ctx: Any,
        *,
        http: httpx.Client | None = None,
        clock=time.time,
        start: bool = True,
    ) -> None:
        self._config = ctx.config
        self._own_http = http is None
        #: Replaceable (tests point it at a ``MockTransport``).
        self.http_client = http if http is not None else httpx.Client()
        self.clock = clock
        self._outboxes: Derived[Any, Outbox] = Derived(
            "mivport outbox",
            select=lambda c: c.data_root,
            build=lambda root: Outbox(root / "mivport", clock),
            close=lambda o: o.close(),
        )
        self.account = Account(ctx.config, self.http, clock)
        self.syncer = Syncer(self.account, self.outbox, self.registry, self.http, clock)
        if start:
            self.syncer.start()

    def http(self) -> httpx.Client:
        return self.http_client

    def outbox(self) -> Outbox:
        return self._outboxes.get(self._config.get())

    def registry(self) -> RegistryCache:
        return RegistryCache(self._config.get().data_root)

    def web_url(self) -> str:
        return self._config.get().mivport.web_url

    def account_summary(self) -> dict:
        out = self.account.summary()
        out["online"] = bool(self.syncer.online)
        out["outbox"] = self.outbox().counts()
        out["last_sync"] = self.syncer.last_sync
        out["last_error"] = self.syncer.last_error
        return out

    def close(self) -> None:
        self.syncer.stop()
        self._outboxes.dispose()
        if self._own_http:
            self.http_client.close()


def _runtime(runtime: Runtime = Depends(get_runtime)) -> MivportRuntime:
    return runtime.feature(FEATURE_ID)  # type: ignore[return-value]


# -- the baked sets, as the editing side needs them -------------------------


def _details_files(store: PoiStore) -> list[tuple[str, Any]]:
    """``(set_id, details path)`` of every baked mivport set."""
    out = []
    for set_id in sorted(store.sets()):
        directory = store.set_dir(set_id)
        if directory is None:
            continue
        path = mp_store.details_path(directory, set_id)
        if path.is_file():
            out.append((set_id, path))
    return out


def _find_stored(store: PoiStore, ref: str) -> dict | None:
    """The place as the newest bake holding it stored it."""
    best: tuple[float, dict] | None = None
    for _, path in _details_files(store):
        found = mp_store.read_detail(path, ref)
        if found is None:
            continue
        detail, meta = found
        when = _float(meta.get("fetched_at"))
        if best is None or when > best[0]:
            best = (when, detail)
    return best[1] if best else None


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _baked_sets(store: PoiStore) -> list[local.BakedSet]:
    return [
        local.BakedSet(
            started_at=_float(mp_store.read_meta(path).get("started_at")),
            contains=lambda ref, p=path: mp_store.has_ref(p, ref),
        )
        for _, path in _details_files(store)
    ]


def _outbox_photo_url(item_id: str, part: str) -> str:
    return f"/mivport/outbox/{item_id}/{part}.jpg"


# -- reading: details, photos, the overlay ------------------------------------




def _set_holding(store: PoiStore, ref: str) -> tuple[str, Any, Any]:
    """``(set id, its dir, (detail, meta))`` of a baked set storing ``ref``."""
    for sid in sorted(store.sets()):
        directory = store.set_dir(sid)
        if directory is None:
            continue
        found = mp_store.read_detail(mp_store.details_path(directory, sid), ref)
        if found is not None:
            return sid, directory, found
    return LOCAL_SET, None, None


@router.get("/details/{set_id}/{ref}")
def place_detail(
    set_id: str,
    ref: str,
    store: PoiStore = Depends(get_poi_store),
    rt: MivportRuntime = Depends(_runtime),
) -> dict:
    """One mivport place as the bake stored it — attributes, OSM attributes,
    reviews, photos (pointing at the boat's copies where downloaded) and the
    data attribution — with the boat's own changes merged over it: ``local``
    (``pending``/``synced``/``failed``) when the place was changed here, and
    reviews/photos still in the outbox. ``set_id`` ``local`` reads a place
    only the boat knows yet. 404 when neither knows the place. ``set_id``
    resolves through the store's scan and ``ref`` is only a bound SQL
    parameter, so neither reaches outside the store."""
    directory = store.set_dir(set_id)
    found = (
        mp_store.read_detail(mp_store.details_path(directory, set_id), ref)
        if directory is not None
        else None
    )
    if found is None and set_id == LOCAL_SET:
        # Tapped on the local layer, which doesn't say which bake the place
        # came from: its stored reviews and photos are in whichever set has it.
        set_id, directory, found = _set_holding(store, ref)
    outbox = rt.outbox()
    key = outbox.alias(ref)
    entry = outbox.place(key)
    if found is None and entry is None:
        raise HTTPException(status_code=404, detail=f"no stored detail for {set_id}/{ref}")
    stored, meta = (found if found is not None else (None, {}))
    if stored is not None:
        stored = mp_store.with_local_photos(stored, mp_store.photos_dir(directory, set_id), set_id)  # type: ignore[arg-type]
    place = local.view(entry, outbox.items(kind="edit", place_ids=[key])) if entry is not None else None
    refs = outbox.aliases(ref)
    items = [
        i for i in outbox.items(kind=None)
        if i["state"] in ("pending", "sending", "failed", "done")
        and (
            (i["kind"] in ("review", "photo") and i["place_id"] in refs)
            or i["kind"] in ("review_delete", "photo_delete")
        )
    ]
    detail = local.merge_detail(stored, place, items, username=rt.account.username(),
                                photo_url=_outbox_photo_url)
    if stored is None and place is None:
        raise HTTPException(status_code=404, detail=f"no stored detail for {set_id}/{ref}")
    if entry is not None and entry.get("created_on_boat") and "created_by" not in detail:
        # mivport's own creator isn't in the exports; a place made on this
        # boat is the boat's user's, so they may delete it.
        detail["created_by"] = rt.account.username()
    out = {**detail, "attribution": meta.get("attribution", "")}
    out["fetched_at"] = _float(meta.get("fetched_at", "0"))
    web = rt.web_url()
    if web:
        out["web_url"] = f"{web}/#place={out.get('ref', ref)}"
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


class MivportLocalOverlay(BaseModel):
    #: GeoJSON point features, tile-shaped props plus ``local``/``deleted``.
    features: list[dict[str, Any]]
    #: Every ref the baked layers must not draw.
    hide: list[str]


@router.get("/local")
def local_overlay(
    store: PoiStore = Depends(get_poi_store), rt: MivportRuntime = Depends(_runtime)
) -> MivportLocalOverlay:
    """The places changed on the boat, for their own map layer, and what the
    baked layers must hide. A place's entry goes once a bake that started
    after its upload holds it (``local.droppable``)."""
    outbox = rt.outbox()
    places = outbox.places()
    if not places:
        return MivportLocalOverlay(features=[], hide=[])
    sets = _baked_sets(store)
    edits: dict[str, list[dict]] = defaultdict(list)
    for item in outbox.items(kind="edit"):
        edits[item["place_id"]].append(item)
    features, hide = [], []
    for ref, entry in sorted(places.items()):
        mine = edits.get(ref, [])
        if local.droppable(ref, entry, (e["state"] for e in mine), sets):
            outbox.drop_place(ref)
            continue
        detail = local.view(entry, mine)
        if detail is None:
            continue
        feat = local.feature(detail)
        if feat is not None:
            features.append(feat)
        hide.extend(local.hide_refs(ref, entry, detail))
    return MivportLocalOverlay(features=features, hide=sorted(set(hide)))


# -- account ------------------------------------------------------------------


class MivportDeviceState(BaseModel):
    user_code: str
    verification_url: str
    expires_at: float


class MivportOutboxCounts(BaseModel):
    pending: int
    failed: int


class MivportAccount(BaseModel):
    server: str
    logged_in: bool
    username: str | None = None
    role: str | None = None
    online: bool
    device: MivportDeviceState | None = None
    outbox: MivportOutboxCounts
    last_sync: float | None = None
    last_error: str | None = None


class MivportLoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class MivportRegisterIn(MivportLoginIn):
    email: str | None = Field(default=None, max_length=320)


class MivportDeviceStart(BaseModel):
    user_code: str
    verification_url: str
    expires_in: int


def _account_call(fn) -> None:
    try:
        fn()
    except AccountError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from e
    except MivportUnreachable as e:
        raise HTTPException(status_code=503, detail=f"mivport is unreachable: {e}") from e


def _after_login(rt: MivportRuntime) -> None:
    rt.syncer.online = True
    try:
        rt.registry().refresh(rt.http(), rt.account.base_url())
    except MivportError:
        pass
    rt.syncer.kick()


@edit_router.get("/account")
def get_account(rt: MivportRuntime = Depends(_runtime)) -> MivportAccount:
    """The boat's mivport login and the outbox state. Answers from what the
    boat knows (``online`` is how the last contact went), never waits."""
    return MivportAccount.model_validate(rt.account_summary())


@edit_router.post("/account/login")
def login(body: MivportLoginIn, rt: MivportRuntime = Depends(_runtime)) -> MivportAccount:
    _account_call(lambda: rt.account.login(body.username, body.password))
    _after_login(rt)
    return MivportAccount.model_validate(rt.account_summary())


@edit_router.post("/account/register")
def register(body: MivportRegisterIn, rt: MivportRuntime = Depends(_runtime)) -> MivportAccount:
    _account_call(lambda: rt.account.register(body.username, body.password, body.email))
    _after_login(rt)
    return MivportAccount.model_validate(rt.account_summary())


@edit_router.post("/account/device")
def device_login(rt: MivportRuntime = Depends(_runtime)) -> MivportDeviceStart:
    """Start a device login: show ``user_code`` and ``verification_url``;
    the backend polls mivport until it is approved (``GET /mivport/account``
    shows ``logged_in`` then)."""
    started: list = []
    _account_call(lambda: started.append(rt.account.start_device()))
    rt.syncer.online = True
    rt.syncer.kick()
    device = started[0]
    return MivportDeviceStart(
        user_code=device.user_code,
        verification_url=device.verification_url,
        expires_in=max(0, int(device.expires_at - rt.clock())),
    )


@edit_router.post("/account/logout")
def logout(rt: MivportRuntime = Depends(_runtime)) -> MivportAccount:
    rt.account.logout()
    return MivportAccount.model_validate(rt.account_summary())


# -- registry -------------------------------------------------------------------


class MivportRegistry(BaseModel):
    kinds: list[dict[str, Any]]
    attrs: list[dict[str, Any]]
    fetched_at: float


@edit_router.get("/registry")
def get_registry(rt: MivportRuntime = Depends(_runtime)) -> MivportRegistry:
    """mivport's kinds and attributes, cached on the boat. 503 only when
    never fetched (log in, sync or bake once while online)."""
    body = rt.registry().load()
    if body is None:
        try:
            body = rt.registry().refresh(rt.http(), rt.account.base_url())
        except MivportError as e:
            raise HTTPException(status_code=503, detail=f"mivport registry not fetched yet: {e}") from e
    return MivportRegistry.model_validate(body)


# -- writes -----------------------------------------------------------------------


class MivportLatLon(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class MivportOsmLink(BaseModel):
    type: Literal["node", "way", "relation"]
    id: int = Field(ge=1)


class MivportPlaceSet(BaseModel):
    """mivport's ``set``: absent = unchanged, ``null`` = remove."""

    model_config = ConfigDict(extra="forbid")

    kind: str | None = Field(default=None, min_length=1, max_length=100)
    name: str | None = Field(default=None, max_length=200)
    geom: MivportLatLon | None = None
    parent_id: str | None = None
    osm: MivportOsmLink | None = None
    attrs: dict[str, Any] | None = None


class MivportEditIn(BaseModel):
    op: Literal["create", "modify", "delete", "restore"]
    place_id: str | None = None
    base_rev: int | None = Field(default=None, ge=1)
    set: MivportPlaceSet | None = None


class MivportEditOut(BaseModel):
    place_id: str
    #: ``null`` when the edit cancelled one still in the outbox (a delete of
    #: a place created on the boat, a restore after a delete).
    item_id: str | None


class MivportItemOut(BaseModel):
    #: ``null`` when the write discarded an item still in the outbox
    #: instead (deleting a review or photo not uploaded yet).
    item_id: str | None


class MivportPhotoOut(BaseModel):
    item_id: str
    #: The local id until uploaded (the item id).
    photo_id: str


class MivportReviewIn(BaseModel):
    stars: int = Field(ge=1, le=5)
    body: str | None = Field(default=None, max_length=5000)
    visited_on: date | None = None


class MivportRemovalIn(BaseModel):
    target_type: Literal["review", "photo", "place"]
    target_id: str = Field(min_length=1, max_length=100)
    reason: str = Field(min_length=1, max_length=1000)


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _place_id(value: str | None) -> str:
    if not value or not local.is_place_id(value):
        raise _bad("place_id must be a uuid or osm:n123 / osm:w123 / osm:r123")
    return value


def _queued(fn):
    try:
        return fn()
    except OutboxError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from e


def _name_for(rt: MivportRuntime, store: PoiStore, ref: str) -> tuple[str, dict | None]:
    stored = _find_stored(store, ref)
    outbox = rt.outbox()
    entry = outbox.place(outbox.alias(ref))
    if entry is not None:
        view = local.view(entry, outbox.items(kind="edit", place_ids=[outbox.alias(ref)])) or {}
        return str(view.get("name") or view.get("kind") or ""), stored
    return str((stored or {}).get("name") or (stored or {}).get("kind") or ""), stored


@edit_router.post("/edits")
def post_edit(
    body: MivportEditIn,
    store: PoiStore = Depends(get_poi_store),
    rt: MivportRuntime = Depends(_runtime),
) -> MivportEditOut:
    """Queue one place edit (answered at once). ``place_id`` may be an OSM
    ref for ``modify``: that becomes a ``create`` linked to it."""
    set_ = body.set.model_dump(exclude_unset=True) if body.set is not None else None
    if body.op == "create":
        if not set_ or not set_.get("kind") or not set_.get("geom"):
            raise _bad("create needs set.kind and set.geom")
        if body.place_id is not None and not local.UUID_RE.match(body.place_id):
            raise _bad("a create's place_id must be a lowercase uuid")
    elif body.op == "modify":
        _place_id(body.place_id)
        if not set_:
            raise _bad("modify needs a non-empty set")
    else:
        _place_id(body.place_id)
        if set_:
            raise _bad(f"{body.op} takes no set")
    if set_ and isinstance(set_.get("attrs"), dict):
        limits = rt.registry().max_len()
        for key, value in set_["attrs"].items():
            if isinstance(value, str) and key in limits and len(value) > limits[key]:
                raise _bad(f"attrs.{key}: at most {limits[key]} characters")
    name, stored = ("", None)
    if body.place_id is not None and body.op != "create":
        name, stored = _name_for(rt, store, body.place_id)
    place_id, item_id = _queued(lambda: rt.outbox().queue_edit(
        body.op, body.place_id, body.base_rev, set_, stored, name))
    rt.syncer.kick()
    return MivportEditOut(place_id=place_id, item_id=item_id)


@edit_router.put("/places/{place_id}/review")
def put_review(
    place_id: str,
    body: MivportReviewIn,
    store: PoiStore = Depends(get_poi_store),
    rt: MivportRuntime = Depends(_runtime),
) -> MivportItemOut:
    """Queue the boat user's review of a place (one per place: it replaces
    the earlier one)."""
    _place_id(place_id)
    review: dict[str, Any] = {"stars": body.stars}
    if body.body:
        review["body"] = body.body
    if body.visited_on is not None:
        review["visited_on"] = body.visited_on.isoformat()
    name, _ = _name_for(rt, store, place_id)
    item_id = _queued(lambda: rt.outbox().queue_review(place_id, review, name))
    rt.syncer.kick()
    return MivportItemOut(item_id=item_id)


@edit_router.delete("/reviews/{review_id}")
def delete_review(review_id: str, rt: MivportRuntime = Depends(_runtime)) -> MivportItemOut:
    if not local.UUID_RE.match(review_id):
        raise _bad("review id must be a uuid")
    item_id = _queued(lambda: rt.outbox().queue_review_delete(review_id))
    rt.syncer.kick()
    return MivportItemOut(item_id=item_id)


def _jpeg(upload: UploadFile, name: str, limit: int) -> bytes:
    body = upload.file.read(limit + 1)
    if len(body) > limit:
        raise _bad(f"{name}: larger than {limit // 1024} KB")
    if not body.startswith(b"\xff\xd8\xff"):
        raise _bad(f"{name}: not a JPEG")
    return body


@edit_router.post("/places/{place_id}/photos")
def post_photo(
    place_id: str,
    view: UploadFile = File(...),
    thumb: UploadFile = File(...),
    caption: str | None = Form(default=None, max_length=500),
    taken_at: str | None = Form(default=None),
    lat: float | None = Form(default=None, ge=-90, le=90),
    lon: float | None = Form(default=None, ge=-180, le=180),
    store: PoiStore = Depends(get_poi_store),
    rt: MivportRuntime = Depends(_runtime),
) -> MivportPhotoOut:
    """Queue a photo: the two JPEGs the client made (``view`` ≤ 1600 px,
    2 MB; ``thumb`` ≤ 320 px, 200 KB), published under CC BY-SA 4.0."""
    _place_id(place_id)
    view_body = _jpeg(view, "view", MAX_VIEW_BYTES)
    thumb_body = _jpeg(thumb, "thumb", MAX_THUMB_BYTES)
    if (lat is None) != (lon is None):
        raise _bad("lat and lon go together")
    fields: dict[str, Any] = {}
    if caption:
        fields["caption"] = caption
    if taken_at:
        try:
            datetime.fromisoformat(taken_at.replace("Z", "+00:00"))
        except ValueError as e:
            raise _bad("taken_at must be RFC 3339") from e
        fields["taken_at"] = taken_at
    if lat is not None and lon is not None:
        fields["lat"], fields["lon"] = lat, lon
    name, _ = _name_for(rt, store, place_id)
    item_id = _queued(lambda: rt.outbox().queue_photo(place_id, fields, view_body, thumb_body, name))
    rt.syncer.kick()
    return MivportPhotoOut(item_id=item_id, photo_id=item_id)


@edit_router.delete("/photos/{photo_id}")
def delete_photo(photo_id: str, rt: MivportRuntime = Depends(_runtime)) -> MivportItemOut:
    """Delete one of the boat user's photos (mivport's id, or the local id
    of one still in the outbox)."""
    if not local.UUID_RE.match(photo_id):
        raise _bad("photo id must be a uuid")
    item_id = _queued(lambda: rt.outbox().queue_photo_delete(photo_id))
    rt.syncer.kick()
    return MivportItemOut(item_id=item_id)


@edit_router.post("/removal-requests")
def post_removal(body: MivportRemovalIn, rt: MivportRuntime = Depends(_runtime)) -> MivportItemOut:
    """Ask mivport's moderators to remove a review, photo or place."""
    if body.target_type == "place":
        _place_id(body.target_id)
    elif not local.UUID_RE.match(body.target_id):
        raise _bad("target_id must be a uuid")
    item_id = _queued(lambda: rt.outbox().queue_removal(body.target_type, body.target_id, body.reason))
    rt.syncer.kick()
    return MivportItemOut(item_id=item_id)


# -- the outbox -----------------------------------------------------------------


class MivportEditConflict(BaseModel):
    field: str
    won: bool


class MivportOutboxItem(BaseModel):
    id: str
    kind: Literal["edit", "review", "review_delete", "photo", "photo_delete", "removal"]
    place_id: str | None = None
    summary: str
    state: Literal["pending", "sending", "failed", "done"]
    created_at: float
    error: str | None = None
    conflicts: list[MivportEditConflict] | None = None


class MivportOutboxList(BaseModel):
    items: list[MivportOutboxItem]


class MivportDiscarded(BaseModel):
    #: Every item removed: a create takes what was queued on its place along.
    discarded: list[str]


@edit_router.get("/outbox")
def get_outbox(rt: MivportRuntime = Depends(_runtime)) -> MivportOutboxList:
    """Everything written on the boat, newest first; uploaded (``done``)
    items stay 7 days."""
    outbox = rt.outbox()
    outbox.purge_done()
    items = [
        MivportOutboxItem(
            id=i["id"], kind=i["kind"], place_id=i["place_id"], summary=i["summary"],
            state=i["state"], created_at=i["created_at"], error=i["error"],
            conflicts=[MivportEditConflict(field=str(c.get("field", "")), won=bool(c.get("won")))
                       for c in i["conflicts"]] if i["conflicts"] else None,
        )
        for i in reversed(outbox.items())
    ]
    return MivportOutboxList(items=items)


@edit_router.delete("/outbox/{item_id}")
def discard_item(item_id: str, rt: MivportRuntime = Depends(_runtime)) -> MivportDiscarded:
    """Discard a pending or failed item and undo its effect on the boat
    (409 while it is being sent or once uploaded)."""
    return MivportDiscarded(discarded=_queued(lambda: rt.outbox().discard(item_id)))


@edit_router.get(
    "/outbox/{item_id}/{part}.jpg",
    response_class=FileResponse,
    responses={200: {"content": {"image/jpeg": {}}}},
)
def outbox_photo(item_id: str, part: str, rt: MivportRuntime = Depends(_runtime)) -> FileResponse:
    """A photo queued (or recently uploaded) from the boat."""
    if part not in ("view", "thumb") or not local.UUID_RE.match(item_id):
        raise HTTPException(status_code=404, detail="no such photo")
    path = rt.outbox().photo_path(item_id, part)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such photo")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": PHOTO_CACHE_CONTROL})


@edit_router.post("/sync")
def sync_now(rt: MivportRuntime = Depends(_runtime)) -> MivportAccount:
    """One sync attempt now (also refreshes the registry and the role)."""
    rt.syncer.sync_once(force_refresh=True)
    return MivportAccount.model_validate(rt.account_summary())


# -- online only ------------------------------------------------------------------


@edit_router.get("/places/{place_id}/history")
def place_history(place_id: str, rt: MivportRuntime = Depends(_runtime)) -> dict:
    """mivport's history of one of its places, as-is (503 offline)."""
    _place_id(place_id)
    ref = rt.outbox().alias(place_id)
    if not local.UUID_RE.match(ref):
        raise HTTPException(status_code=404, detail="an OSM-only place has no history")
    try:
        resp = mp_client.send(rt.http(), "GET", rt.account.base_url(),
                              mp_client.place_path(ref, "/history"), timeout=15.0)
    except MivportUnreachable as e:
        raise HTTPException(status_code=503, detail=f"mivport is unreachable: {e}") from e
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="mivport has no such place (yet)")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=mp_client.error_text(resp))
    try:
        body = resp.json()
    except ValueError as e:
        raise HTTPException(status_code=502, detail="mivport answered without JSON") from e
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="mivport answered oddly")
    return body


FEATURE: Feature[MivportRuntime] = Feature(
    id=FEATURE_ID,
    routers=(router, edit_router),
    build_runtime=MivportRuntime,
)
