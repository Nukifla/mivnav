# SPDX-License-Identifier: GPL-2.0-only
"""mivport editing (docs/architecture/mivport-editing.md) against a fake
mivport (``httpx.MockTransport``): the account, the outbox and its
coalescing, the sync pass, and the local overlay over a real bake. No
sleeps, no network: the sync thread is stopped and passes are run by hand."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import httpx
import pytest

import mivnav.config  # noqa: F401 — import order, as in the host tests
from mivnav.features.poi.mivport import local
from mivnav.features.poi.mivport import store as mp_store
from mivnav.features.poi.mivport import sync as mp_sync
from mivnav.features.poi.mivport.outbox import DONE_KEEP_S, Outbox
from tests.test_poi_mivport import BASE, P1, FakeMivport, _bake

JPEG = b"\xff\xd8\xff\xe0" + b"x" * 100
THUMB = b"\xff\xd8\xff\xe0" + b"t" * 20


class FakeWrites(FakeMivport):
    """The read fake plus mivport's write API, with switches for trouble."""

    def __init__(self) -> None:
        super().__init__()
        self.users = {"anna": "good-password"}
        self.tokens: dict[str, str] = {}
        self.role = "contributor"
        self.log: list[tuple[str, str]] = []
        self.batches: list[list[dict]] = []
        self.offline = False
        self.unauthorized = False
        self.edits_status: int | None = None
        self.reject: dict[str, str] = {}
        self.conflicts: dict[str, list[dict]] = {}
        self.photo_status = 201
        self.device_approved = False
        self.revoked: list[str] = []
        self.revs: dict[str, int] = {P1: 3}

    def _authed(self, request: httpx.Request) -> str | None:
        auth = request.headers.get("authorization", "")
        token = auth.removeprefix("Bearer ")
        return None if self.unauthorized else self.tokens.get(token)

    def handler(self, request: httpx.Request) -> httpx.Response:  # noqa: C901 — one fake server
        if self.offline:
            raise httpx.ConnectError("offline", request=request)
        method, path = request.method, request.url.path
        body = json.loads(request.content) if request.headers.get("content-type", "").startswith("application/json") else None
        if path == "/v1/kinds":
            return httpx.Response(200, json={"kinds": [{"name": "marina", "group": "harbour", "label": "Marina"}]})
        if path == "/v1/attrs":
            return httpx.Response(200, json={"attrs": [{"key": "vhf", "type": "string", "max_len": 10}]})
        if path == "/v1/auth/token" and method == "POST":
            if self.users.get(body["username"]) != body["password"]:
                return httpx.Response(401, json={"error": "wrong username or password"})
            token = f"tok-{uuid.uuid4()}"
            self.tokens[token] = body["username"]
            return httpx.Response(200, json={"token": token})
        if path == "/v1/auth/token" and method == "DELETE":
            self.revoked.append(request.headers["authorization"])
            return httpx.Response(204)
        if path == "/v1/auth/register":
            if body["username"] in self.users:
                return httpx.Response(409, json={"error": "username or email already taken"})
            self.users[body["username"]] = body["password"]
            return httpx.Response(201, json={"username": body["username"], "role": "contributor"})
        if path == "/v1/auth/device":
            return httpx.Response(200, json={"device_code": "secret-dc", "user_code": "KQ7T-M2XD",
                                             "verification_uri": "/device", "expires_in": 600, "interval": 5})
        if path == "/v1/auth/device/token":
            if not self.device_approved:
                return httpx.Response(428, json={"error": "authorization_pending"})
            self.tokens["tok-device"] = "anna"
            return httpx.Response(200, json={"token": "tok-device"})
        if path == "/v1/me":
            user = self._authed(request)
            if user is None:
                return httpx.Response(401, json={"error": "missing bearer token"})
            return httpx.Response(200, json={"username": user, "role": self.role})

        writes = ("/v1/edits", "/review", "/photos", "/v1/reviews/", "/v1/photos/", "/v1/removal-requests")
        if method != "GET" and any(w in path for w in writes):
            if self._authed(request) is None:
                return httpx.Response(401, json={"error": "invalid token"})
            self.log.append((method, path))
        if path == "/v1/edits":
            if self.edits_status is not None:
                return httpx.Response(self.edits_status, json={"error": "slow down"})
            self.batches.append(body["edits"])
            return httpx.Response(200, json={"changeset_id": len(self.batches),
                                             "results": [self._edit(e) for e in body["edits"]]})
        if path.endswith("/review") and method == "PUT":
            return httpx.Response(200, json={"id": str(uuid.uuid4()), **body})
        if path.startswith("/v1/reviews/") or path.startswith("/v1/photos/"):
            return httpx.Response(204)
        if path.endswith("/photos") and method == "POST":
            if self.photo_status != 201:
                return httpx.Response(self.photo_status, json={"error": "same photo already on this place"})
            pid = str(uuid.uuid4())
            return httpx.Response(201, json={"id": pid, "attribution": "© anna, CC BY-SA 4.0",
                                             "urls": {"view": f"/media/photos/{pid}/view.jpg"}})
        if path == "/v1/removal-requests":
            return httpx.Response(201, json={"id": 1, "status": "open"})
        if path.startswith("/v1/places/") and method == "GET" and not path.endswith("/photos"):
            pid = path.removeprefix("/v1/places/")
            if pid in self.created:
                return httpx.Response(200, json={"feature": self.created[pid]})
        return super().handler(request)

    created: dict[str, dict]

    def _edit(self, e: dict) -> dict:
        pid = e.get("place_id")
        if pid in self.reject:
            return {"edit_id": e["edit_id"], "status": "rejected", "place_id": pid, "error": self.reject[pid]}
        if e["op"] == "create":
            self.revs[pid] = 1
            s = e["set"]
            props = {"id": pid, "kind": s["kind"], "source": "core", "rev": 1, "attrs": s.get("attrs") or {}}
            if s.get("name"):
                props["name"] = s["name"]
            if s.get("osm"):
                props["osm"] = s["osm"]
            geom = s.get("geom") or {"lat": 56.2, "lon": 10.6}
            self.created[pid] = {"type": "Feature", "properties": props,
                                 "geometry": {"type": "Point", "coordinates": [geom["lon"], geom["lat"]]}}
            return {"edit_id": e["edit_id"], "status": "applied", "place_id": pid, "rev": 1}
        self.revs[pid] = self.revs.get(pid, 1) + 1
        return {"edit_id": e["edit_id"], "status": "applied", "place_id": pid, "rev": self.revs[pid],
                "conflicts": self.conflicts.get(pid, [])}


@pytest.fixture
def fake(monkeypatch):
    from mivnav.features.poi.mivport import source as mp_source

    monkeypatch.setattr(mp_source, "REQUEST_INTERVAL_S", 0.0)
    f = FakeWrites()
    f.created = {}
    f.export[0] = {**f.export[0], "properties": {**f.export[0]["properties"], "rev": 3}}
    return f


@pytest.fixture
def runtime(tmp_path: Path, fake):
    from tests.conftest import isolated_runtime_at

    rt = isolated_runtime_at(tmp_path)
    rt.patch_config({"mivport": {"base_url": BASE}})
    mp = rt.feature("mivport")
    mp.syncer.stop()  # passes run by hand
    mp.http_client = httpx.Client(transport=httpx.MockTransport(lambda r: fake.handler(r)))
    yield rt
    rt.close()


@pytest.fixture
def mp(runtime):
    return runtime.feature("mivport")


@pytest.fixture
def dc(runtime):
    from fastapi.testclient import TestClient

    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: runtime
    with TestClient(app) as c:
        yield c
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous


def _login(dc) -> dict:
    r = dc.post("/mivport/account/login", json={"username": "anna", "password": "good-password"})
    assert r.status_code == 200, r.text
    return r.json()


def _sync(mp) -> None:
    mp.syncer.sync_once()


def _items(dc) -> list[dict]:
    return dc.get("/mivport/outbox").json()["items"]


def _bake_set(runtime, fake, set_id: str = "mpset") -> Path:
    """A real bake (tiles + details) into the runtime's own data_root."""
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    root = runtime.config.get().data_root / "poi" / set_id
    root.mkdir(parents=True, exist_ok=True)
    runner = PoiIngestRunner(
        PoiStore(root, rescan_interval=0), dataset_id=set_id, config=runtime.config.get,
        http=httpx.Client(transport=httpx.MockTransport(lambda r: fake.handler(r))),
    )
    assert _bake(runner)["state"] == "done"
    runtime.feature("poi").store().invalidate()
    return root


# -- account --------------------------------------------------------------------


def test_login_keeps_the_token_in_credentials_only(runtime, dc, fake, tmp_path):
    assert dc.get("/mivport/account").json()["logged_in"] is False
    assert dc.post("/mivport/account/login", json={"username": "anna", "password": "nope"}).status_code == 401
    body = _login(dc)
    assert body["logged_in"] is True
    assert body["username"] == "anna" and body["role"] == "contributor"
    assert body["server"] == BASE and body["online"] is True
    assert body["outbox"] == {"pending": 0, "failed": 0}

    creds = json.loads((tmp_path / "credentials.json").read_text())["credentials"]["mivport"]
    assert creds["token"].startswith("tok-") and creds["server"] == BASE
    assert "tok-" not in (tmp_path / "config.json").read_text()
    assert dc.get("/config").json()["config"]["credentials"]["mivport"]["token"] is None
    # Registry fetched on login, cached for offline.
    assert dc.get("/mivport/registry").json()["kinds"][0]["name"] == "marina"


def test_register_then_logged_in_and_taken_name_is_409(dc, fake):
    r = dc.post("/mivport/account/register", json={"username": "bo", "password": "long-enough-1"})
    assert r.status_code == 200 and r.json()["username"] == "bo"
    r = dc.post("/mivport/account/register", json={"username": "anna", "password": "long-enough-1"})
    assert r.status_code == 409


def test_device_login_is_polled_by_the_backend(dc, mp, fake):
    r = dc.post("/mivport/account/device")
    assert r.status_code == 200, r.text
    assert r.json()["user_code"] == "KQ7T-M2XD"
    assert r.json()["verification_url"] == f"{BASE}/device"
    assert "device_code" not in r.text
    assert dc.get("/mivport/account").json()["device"]["user_code"] == "KQ7T-M2XD"
    assert mp.syncer.next_wait() == 5
    _sync(mp)
    assert dc.get("/mivport/account").json()["logged_in"] is False
    fake.device_approved = True
    _sync(mp)
    acct = dc.get("/mivport/account").json()
    assert acct["logged_in"] is True and acct["username"] == "anna" and acct["device"] is None


def test_logout_revokes_when_online_and_forgets_either_way(dc, fake):
    _login(dc)
    assert dc.post("/mivport/account/logout").json()["logged_in"] is False
    assert len(fake.revoked) == 1
    _login(dc)
    fake.offline = True
    acct = dc.post("/mivport/account/logout").json()
    assert acct["logged_in"] is False and acct["username"] == "anna"


def test_account_calls_are_503_offline(dc, fake):
    fake.offline = True
    assert dc.post("/mivport/account/login", json={"username": "anna", "password": "x"}).status_code == 503
    assert dc.post("/mivport/account/device").status_code == 503
    assert dc.get(f"/mivport/places/{P1}/history").status_code == 503


def test_token_is_never_sent_to_another_server(runtime, dc, fake):
    _login(dc)
    runtime.patch_config({"mivport": {"base_url": "http://elsewhere.test"}})
    assert dc.get("/mivport/account").json()["logged_in"] is False
    runtime.patch_config({"mivport": {"base_url": BASE}})
    assert dc.get("/mivport/account").json()["logged_in"] is True


def test_registry_works_offline_once_fetched(runtime, dc, fake):
    fake.offline = True
    assert dc.get("/mivport/registry").status_code == 503
    fake.offline = False
    assert dc.get("/mivport/registry").status_code == 200
    fake.offline = True
    body = dc.get("/mivport/registry").json()
    assert body["attrs"][0]["key"] == "vhf" and body["fetched_at"] > 0


# -- queueing and coalescing --------------------------------------------------------


def _create(dc, **set_) -> dict:
    s = {"kind": "marina", "name": "New Marina", "geom": {"lat": 56.1, "lon": 10.2}, **set_}
    r = dc.post("/mivport/edits", json={"op": "create", "set": s})
    assert r.status_code == 200, r.text
    return r.json()


def test_writes_are_queued_offline_and_answer_at_once(dc, fake):
    fake.offline = True
    out = _create(dc)
    assert local.UUID_RE.match(out["place_id"])
    items = _items(dc)
    assert [(i["kind"], i["state"]) for i in items] == [("edit", "pending")]
    assert items[0]["summary"] == "New marina: New Marina"


def test_create_absorbs_later_modifies(dc, mp):
    pid = _create(dc, attrs={"vhf": "12"})["place_id"]
    r = dc.post("/mivport/edits", json={"op": "modify", "place_id": pid, "set": {
        "name": "Renamed", "attrs": {"vhf": None, "water": True}}})
    assert r.json() == {"place_id": pid, "item_id": _items(dc)[0]["id"]}
    (item,) = mp.outbox().items()
    assert item["payload"]["op"] == "create"
    assert item["payload"]["set"]["name"] == "Renamed"
    assert item["payload"]["set"]["attrs"] == {"water": True}  # a create sends no nulls


def test_modify_plus_modify_merges_attrs_key_by_key(dc, mp, fake):
    first = dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "base_rev": 3,
                                            "set": {"attrs": {"vhf": "16", "wifi": True}}}).json()
    made_at = mp.outbox().items()[0]["payload"]["made_at"]
    second = dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "base_rev": 3,
                                             "set": {"attrs": {"wifi": None, "water": True}}}).json()
    assert first == second
    (item,) = mp.outbox().items()
    assert item["payload"]["set"] == {"attrs": {"vhf": "16", "wifi": None, "water": True}}
    assert item["payload"]["base_rev"] == 3
    assert item["payload"]["made_at"] >= made_at


def test_editing_an_osm_place_creates_a_linked_place_and_hides_the_osm_ref(runtime, dc, mp, fake):
    _bake_set(runtime, fake)
    r = dc.post("/mivport/edits", json={"op": "modify", "place_id": "osm:n1", "set": {"attrs": {"fee": False}}})
    new = r.json()["place_id"]
    assert new != "osm:n1" and local.UUID_RE.match(new)
    (item,) = mp.outbox().items()
    assert item["payload"]["op"] == "create" and item["place_id"] == new
    assert item["payload"]["set"] == {"attrs": {"fee": False}, "kind": "toilets",
                                      "osm": {"type": "node", "id": 1}}
    overlay = dc.get("/poi/mivport/local").json()
    assert "osm:n1" in overlay["hide"] and new in overlay["hide"]
    (feat,) = overlay["features"]
    assert feat["properties"]["ref"] == new and feat["properties"]["local"] == "pending"
    # A second edit of the OSM ref lands in the same create.
    r = dc.post("/mivport/edits", json={"op": "modify", "place_id": "osm:n1", "set": {"name": "Loo"}})
    assert r.json()["place_id"] == new
    assert len(mp.outbox().items()) == 1
    # The detail asked by the OSM ref shows the local place.
    d = dc.get("/poi/mivport/details/mpset/osm:n1").json()
    assert d["ref"] == new and d["name"] == "Loo" and d["local"] == "pending"
    assert d["attrs"] == {"fee": False} and d["osm_tags"] == {"amenity": "toilets"}


def test_an_item_sent_once_is_frozen(dc, mp, fake):
    _login(dc)
    pid = _create(dc)["place_id"]
    fake.edits_status = 503  # answered, but not usefully: stays pending, was sent
    _sync(mp)
    assert mp.outbox().items()[0]["attempts"] == 1
    dc.post("/mivport/edits", json={"op": "modify", "place_id": pid, "set": {"name": "Later"}})
    items = mp.outbox().items()
    assert [i["payload"]["op"] for i in items] == ["create", "modify"]
    assert "base_rev" not in items[1]["payload"]
    fake.edits_status = None
    _sync(mp)  # one edit per place per batch: the create
    assert [len(b) for b in fake.batches] == [1]
    _sync(mp)  # then the modify, against the create's revision
    assert fake.batches[1][0]["base_rev"] == 1
    assert {i["state"] for i in mp.outbox().items()} == {"done"}


def test_unsent_create_then_delete_cancel_out(dc, mp):
    pid = _create(dc)["place_id"]
    dc.put(f"/mivport/places/{pid}/review", json={"stars": 4})
    r = dc.post("/mivport/edits", json={"op": "delete", "place_id": pid})
    assert r.json() == {"place_id": pid, "item_id": None}
    assert mp.outbox().items() == [] and mp.outbox().places() == {}


def test_unsent_delete_then_restore_cancel_out(dc, mp):
    dc.post("/mivport/edits", json={"op": "delete", "place_id": P1, "base_rev": 3})
    # Not in any bake here: the boat has no copy of the place to hide.
    assert dc.get("/poi/mivport/local").json()["hide"] == []
    r = dc.post("/mivport/edits", json={"op": "restore", "place_id": P1, "base_rev": 3})
    assert r.json()["item_id"] is None
    assert mp.outbox().items() == [] and mp.outbox().places() == {}


def test_nothing_is_hidden_that_the_overlay_cannot_draw(dc, mp):
    """An OSM place edited with no stored detail on the boat (no position):
    its baked point stays until mivport's answer gives one."""
    dc.post("/mivport/edits", json={"op": "modify", "place_id": "osm:n7", "set": {"kind": "fuel"}})
    assert dc.get("/poi/mivport/local").json() == {"features": [], "hide": []}


def test_shape_checks(dc):
    assert dc.post("/mivport/edits", json={"op": "create", "set": {"kind": "marina"}}).status_code == 400
    assert dc.post("/mivport/edits", json={"op": "modify", "place_id": "nope", "set": {"name": "x"}}).status_code == 400
    assert dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "set": {}}).status_code == 400
    assert dc.post("/mivport/edits", json={"op": "delete", "place_id": P1, "set": {"name": "x"}}).status_code == 400
    assert dc.post("/mivport/edits", json={"op": "delete", "place_id": "osm:n1"}).status_code == 400
    assert dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "set": {"bogus": 1}}).status_code == 422
    assert dc.put(f"/mivport/places/{P1}/review", json={"stars": 6}).status_code == 422
    files = {"view": ("v.jpg", b"PNG", "image/jpeg"), "thumb": ("t.jpg", THUMB, "image/jpeg")}
    assert dc.post(f"/mivport/places/{P1}/photos", files=files).status_code == 400
    files = {"view": ("v.jpg", JPEG, "image/jpeg"), "thumb": ("t.jpg", b"\xff\xd8\xff" + b"x" * 300_000, "image/jpeg")}
    assert dc.post(f"/mivport/places/{P1}/photos", files=files).status_code == 400
    files = {"view": ("v.jpg", JPEG, "image/jpeg"), "thumb": ("t.jpg", THUMB, "image/jpeg")}
    assert dc.post(f"/mivport/places/{P1}/photos", files=files, data={"lat": "56"}).status_code == 400
    assert dc.post("/mivport/removal-requests", json={"target_type": "user", "target_id": P1, "reason": "x"}).status_code == 422


def test_registry_max_len_is_checked_when_cached(dc, fake):
    _login(dc)  # caches the registry: vhf max_len 10
    r = dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "set": {"attrs": {"vhf": "x" * 11}}})
    assert r.status_code == 400


# -- sync -----------------------------------------------------------------------


def _photo(dc, pid, **data):
    files = {"view": ("v.jpg", JPEG, "image/jpeg"), "thumb": ("t.jpg", THUMB, "image/jpeg")}
    r = dc.post(f"/mivport/places/{pid}/photos", files=files, data=data)
    assert r.status_code == 200, r.text
    return r.json()


def test_sync_order_and_results(dc, mp, fake):
    _login(dc)
    other = str(uuid.uuid4())
    dc.post("/mivport/removal-requests", json={"target_type": "review", "target_id": other, "reason": "spam"})
    dc.delete(f"/mivport/photos/{other}")
    _photo(dc, P1, caption="Pier", taken_at="2026-07-01T12:00:00Z", lat="56.1", lon="10.2")
    dc.delete(f"/mivport/reviews/{other}")
    dc.put(f"/mivport/places/{P1}/review", json={"stars": 5, "body": "Lovely", "visited_on": "2026-06-30"})
    dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "base_rev": 3, "set": {"name": "X"}})
    _sync(mp)
    assert [m for m, _ in fake.log] == ["POST", "PUT", "DELETE", "POST", "DELETE", "POST"]
    assert [p for _, p in fake.log] == [
        "/v1/edits", f"/v1/places/{P1}/review", f"/v1/reviews/{other}",
        f"/v1/places/{P1}/photos", f"/v1/photos/{other}", "/v1/removal-requests",
    ]
    assert fake.batches[0][0]["base_rev"] == 3
    assert {i["state"] for i in _items(dc)} == {"done"}
    acct = dc.get("/mivport/account").json()
    assert acct["outbox"] == {"pending": 0, "failed": 0} and acct["last_sync"] and acct["online"]


def test_rejected_and_conflicts_are_reported(dc, mp, fake):
    _login(dc)
    bad = str(uuid.uuid4())
    fake.reject[bad] = "place not found"
    fake.conflicts[P1] = [{"field": "attrs.vhf", "won": False}]
    dc.post("/mivport/edits", json={"op": "modify", "place_id": bad, "base_rev": 1, "set": {"name": "x"}})
    dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "base_rev": 3, "set": {"attrs": {"vhf": "9"}}})
    _sync(mp)
    by_place = {i["place_id"]: i for i in _items(dc)}
    assert by_place[bad]["state"] == "failed" and by_place[bad]["error"] == "place not found"
    assert by_place[P1]["state"] == "done"
    assert by_place[P1]["conflicts"] == [{"field": "attrs.vhf", "won": False}]
    assert dc.get("/mivport/account").json()["outbox"] == {"pending": 0, "failed": 1}


def test_401_logs_out_and_keeps_items_pending(dc, mp, fake):
    _login(dc)
    dc.put(f"/mivport/places/{P1}/review", json={"stars": 3})
    fake.unauthorized = True
    mp.syncer.sync_once()
    acct = dc.get("/mivport/account").json()
    assert acct["logged_in"] is False and "log in" in acct["last_error"]
    assert [i["state"] for i in _items(dc)] == ["pending"]


def test_offline_keeps_items_pending_and_backs_off(dc, mp, fake):
    _login(dc)
    dc.put(f"/mivport/places/{P1}/review", json={"stars": 3})
    assert mp.syncer.next_wait() == mp_sync.INTERVAL_S
    fake.offline = True
    waits = []
    for _ in range(6):
        _sync(mp)
        waits.append(mp.syncer.next_wait())
    assert waits == [30, 60, 120, 240, 300, 300]
    acct = dc.get("/mivport/account").json()
    assert acct["online"] is False and "unreachable" in acct["last_error"]
    assert [i["state"] for i in _items(dc)] == ["pending"]
    fake.offline = False
    _sync(mp)
    assert [i["state"] for i in _items(dc)] == ["done"]
    assert mp.syncer.next_wait() is None  # nothing pending: sleep until kicked


def test_photo_409_is_done(dc, mp, fake):
    _login(dc)
    _photo(dc, P1)
    fake.photo_status = 409
    _sync(mp)
    assert [i["state"] for i in _items(dc)] == ["done"]


def test_photo_on_a_place_created_offline_waits_for_the_create(dc, mp, fake):
    _login(dc)
    pid = _create(dc)["place_id"]
    _photo(dc, pid)
    fake.edits_status = 429
    _sync(mp)
    assert fake.log == [("POST", "/v1/edits")]  # the photo was not sent
    fake.edits_status = None
    _sync(mp)
    assert [p for _, p in fake.log][1:] == ["/v1/edits", f"/v1/places/{pid}/photos"]
    assert {i["state"] for i in _items(dc)} == {"done"}


def test_photo_on_a_rejected_create_keeps_waiting(dc, mp, fake):
    _login(dc)
    pid = _create(dc)["place_id"]
    _photo(dc, pid)
    fake.reject[pid] = "kind unknown"
    _sync(mp)
    states = {i["kind"]: i["state"] for i in _items(dc)}
    assert states == {"edit": "failed", "photo": "pending"}
    # Discarding the create takes what was queued on that place with it.
    edit = next(i for i in _items(dc) if i["kind"] == "edit")
    assert len(dc.delete(f"/mivport/outbox/{edit['id']}").json()["discarded"]) == 2
    assert _items(dc) == []


def test_restart_resets_items_in_flight(mp, dc):
    _create(dc)
    out = mp.outbox()
    out.mark_sending([i["id"] for i in out.items()])
    out.reset_sending()
    assert [i["state"] for i in out.items()] == ["pending"]


def test_done_items_are_purged_after_a_week(tmp_path):
    now = [1000.0]
    out = Outbox(tmp_path / "mivport", clock=lambda: now[0])
    item = out.queue_photo(P1, {}, JPEG, THUMB)
    out.update(item, state="done", done_at=now[0])
    now[0] += DONE_KEEP_S - 1
    assert out.purge_done() == 0
    now[0] += 2
    assert out.purge_done() == 1
    assert not out.photo_path(item, "view").exists()


# -- the local overlay ------------------------------------------------------------


def test_overlay_hide_list_and_detail_merge(runtime, dc, mp, fake):
    _bake_set(runtime, fake)
    stored = dc.get(f"/poi/mivport/details/mpset/{P1}").json()
    assert stored["rev"] == 3  # an edit's base_rev
    assert stored["lon"] == 10.22 and "local" not in stored

    dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "base_rev": 3,
                                    "set": {"name": "Aarhus Lystbådehavn", "attrs": {"vhf": None}}})
    dc.put(f"/mivport/places/{P1}/review", json={"stars": 2, "body": "Windy"})
    photo = _photo(dc, P1, caption="Pontoon")
    overlay = dc.get("/poi/mivport/local").json()
    assert overlay["hide"] == [P1]
    (feat,) = overlay["features"]
    assert feat["geometry"]["coordinates"] == [10.22, 56.15]
    assert feat["properties"] == {"kind": "marina", "kind_detail": "marina", "min_zoom": 7, "src": "mivport",
                                  "ref": P1, "name": "Aarhus Lystbådehavn", "local": "pending", "deleted": False}

    d = dc.get(f"/poi/mivport/details/mpset/{P1}").json()
    assert d["name"] == "Aarhus Lystbådehavn" and d["local"] == "pending"
    assert d["attrs"] == {"electricity": True}
    assert d["osm_attrs"] == {"website": "https://example.org"}
    assert d["attribution"] == "© OSM; © mivport"
    mine = d["reviews"][0]
    assert mine["stars"] == 2 and mine["body"] == "Windy" and mine["local"] == "pending"
    assert d["reviews"][1]["user"] == "anna"  # nobody logged in: not ours
    ph = d["photos"][-1]
    assert ph["id"] == photo["photo_id"] and ph["local"] == "pending" and ph["caption"] == "Pontoon"
    assert dc.get(ph["url"]).content == JPEG and dc.get(ph["thumb_url"]).content == THUMB

    # A place only the boat knows.
    pid = _create(dc, name="Fresh")["place_id"]
    assert dc.get(f"/poi/mivport/details/local/{pid}").json()["name"] == "Fresh"
    assert dc.get(f"/poi/mivport/details/local/{uuid.uuid4()}").status_code == 404


def test_deleted_place_is_hidden_not_drawn(runtime, dc, fake):
    _bake_set(runtime, fake)
    dc.post("/mivport/edits", json={"op": "delete", "place_id": P1, "base_rev": 3})
    overlay = dc.get("/poi/mivport/local").json()
    assert overlay == {"features": [], "hide": [P1]}
    assert dc.get(f"/poi/mivport/details/mpset/{P1}").json()["deleted"] is True


def test_discard_undoes_the_local_effect(runtime, dc, mp, fake):
    _bake_set(runtime, fake)
    r = dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "base_rev": 3, "set": {"name": "Oops"}})
    item = r.json()["item_id"]
    assert dc.get(f"/poi/mivport/details/mpset/{P1}").json()["name"] == "Oops"
    assert dc.delete(f"/mivport/outbox/{item}").json() == {"discarded": [item]}
    assert dc.get("/poi/mivport/local").json() == {"features": [], "hide": []}
    d = dc.get(f"/poi/mivport/details/mpset/{P1}").json()
    assert d["name"] == "Aarhus Marina" and "local" not in d
    assert dc.delete(f"/mivport/outbox/{item}").status_code == 404

    _login(dc)
    item = dc.put(f"/mivport/places/{P1}/review", json={"stars": 1}).json()["item_id"]
    _sync(mp)
    assert dc.delete(f"/mivport/outbox/{item}").status_code == 409  # uploaded


def test_deleting_a_queued_photo_or_review_discards_it(dc, mp):
    photo = _photo(dc, P1)["photo_id"]
    assert dc.delete(f"/mivport/photos/{photo}").json() == {"item_id": None}
    review = dc.put(f"/mivport/places/{P1}/review", json={"stars": 3}).json()["item_id"]
    assert dc.delete(f"/mivport/reviews/{review}").json() == {"item_id": None}
    assert mp.outbox().items() == []


def test_local_entry_dropped_after_a_later_bake(runtime, dc, mp, fake):
    root = _bake_set(runtime, fake)
    _login(dc)
    dc.post("/mivport/edits", json={"op": "modify", "place_id": P1, "base_rev": 3, "set": {"name": "Renamed"}})
    _sync(mp)
    overlay = dc.get("/poi/mivport/local").json()
    assert overlay["features"][0]["properties"]["local"] == "synced"
    assert overlay["features"][0]["properties"]["name"] == "Renamed"

    # A bake that started before the upload changes nothing.
    details = mp_store.details_path(root, "mpset")
    rows = mp_store.read_all(details)
    meta = mp_store.read_meta(details)
    mp_store.write_details(details, rows.values(), {**meta, "started_at": "1.0"})
    assert dc.get("/poi/mivport/local").json()["hide"] == [P1, "osm:w5"]

    # One that started after it has the place: the local copy goes.
    fake.export[0]["properties"]["name"] = "Renamed"
    _bake_set(runtime, fake)
    assert dc.get("/poi/mivport/local").json() == {"features": [], "hide": []}
    assert mp.outbox().places() == {}
    assert dc.get(f"/poi/mivport/details/mpset/{P1}").json()["name"] == "Renamed"


def test_bake_caches_the_registry_and_stores_positions(runtime, fake):
    root = _bake_set(runtime, fake)
    reg = json.loads((runtime.config.get().data_root / "mivport" / "registry.json").read_text())
    assert reg["kinds"][0]["name"] == "marina"
    meta = mp_store.read_meta(mp_store.details_path(root, "mpset"))
    assert float(meta["started_at"]) <= float(meta["fetched_at"])
    detail = mp_store.read_all(mp_store.details_path(root, "mpset"))[P1]
    assert (detail["lon"], detail["lat"]) == (10.22, 56.15)


def test_runtime_thread_starts_and_stops(tmp_path):
    from tests.conftest import isolated_runtime_at

    rt = isolated_runtime_at(tmp_path)
    mp = rt.feature("mivport")
    assert mp.syncer._thread is not None and mp.syncer._thread.is_alive()
    thread = mp.syncer._thread
    rt.close()
    assert not thread.is_alive()
    assert not (tmp_path / "data" / "mivport").exists()  # nothing written while idle
