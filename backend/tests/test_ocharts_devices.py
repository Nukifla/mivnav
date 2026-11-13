# SPDX-License-Identifier: GPL-2.0-only
"""The o-charts device cap (mivnav.features.ocharts.devices): at most five
registered screens are served licensed sets; everyone else gets the free
ones through ``/tiles/free``."""

from __future__ import annotations

import json
from pathlib import Path

import chartcore
import pytest

from mivnav.features.ocharts.devices import (
    COOKIE,
    LAST_SEEN_FLUSH_S,
    MAX_DEVICES,
    DeviceGate,
    DevicesFull,
    DeviceStore,
    UnknownDevice,
    clean_name,
    eula_files,
    pick_eula,
)
from mivnav.features.ocharts.network import boat_network_refusal
from senc_fixture import point_cell
from test_ocharts_serving import _two_set_env, tile_of

# -- the store -------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


def test_five_register_and_the_sixth_is_refused(tmp_path: Path) -> None:
    store = DeviceStore(tmp_path / "devices.json")
    tokens = [store.register(f"screen {i}", [])[1] for i in range(MAX_DEVICES)]
    assert len(set(tokens)) == MAX_DEVICES
    with pytest.raises(DevicesFull):
        store.register("screen 6", [])
    # Removing any one frees a slot.
    store.remove(store.list()[2].id)
    store.register("screen 6", [])
    assert [d.name for d in store.list()] == [
        "screen 0", "screen 1", "screen 3", "screen 4", "screen 6",
    ]


def test_token_is_stored_hashed_and_survives_a_reload(tmp_path: Path) -> None:
    path = tmp_path / "devices.json"
    device, token = DeviceStore(path).register("Chart table", ["e1"])
    assert token not in path.read_text()
    again = DeviceStore(path).by_token(token)
    assert again is not None and again.id == device.id
    assert again.accepted.keys() == {"e1"}
    assert DeviceStore(path).by_token("not-a-token") is None
    assert DeviceStore(path).by_token(None) is None


def test_last_seen_is_written_at_most_every_flush_interval(tmp_path: Path) -> None:
    path = tmp_path / "devices.json"
    clock = Clock()
    store = DeviceStore(path, clock=clock)
    _, token = store.register("Cockpit", [])
    on_disk = lambda: json.loads(path.read_text())["devices"][0]["last_seen"]  # noqa: E731
    clock.now += 60
    store.by_token(token)
    assert store.list()[0].last_seen == clock.now  # in memory: every request
    assert on_disk() == clock.now - 60  # on disk: not yet
    clock.now += LAST_SEEN_FLUSH_S
    store.by_token(token)
    assert on_disk() == clock.now


def test_a_corrupt_list_is_kept_aside_not_overwritten(tmp_path: Path) -> None:
    path = tmp_path / "devices.json"
    path.write_text("{not json")
    store = DeviceStore(path)
    assert store.list() == []
    store.register("Phone", [])
    aside = [p for p in tmp_path.iterdir() if p.name.startswith("devices.json.corrupt-")]
    assert len(aside) == 1 and aside[0].read_text() == "{not json"


def test_rename_and_unknown_ids(tmp_path: Path) -> None:
    store = DeviceStore(tmp_path / "devices.json")
    device, _ = store.register("  iPad   Safari ", [])
    assert device.name == "iPad Safari"
    assert store.rename(device.id, "Saloon iPad").name == "Saloon iPad"
    with pytest.raises(UnknownDevice):
        store.rename("nope", "x")
    with pytest.raises(UnknownDevice):
        store.remove("nope")
    with pytest.raises(ValueError):
        store.register("   ", [])
    assert len(clean_name("x" * 200)) == 60


def test_eula_discovery_prefers_english(tmp_path: Path) -> None:
    (tmp_path / "DE_rrc_eula_ChartSetsForOpenCPN.html").write_text("de")
    (tmp_path / "EN_rrc_eula_ChartSetsForOpenCPN.html").write_text("en")
    (tmp_path / "ChartList.XML").write_text("<chartList/>")
    (tmp_path / "eula-notes.txt").write_text("not html")
    files = eula_files(tmp_path)
    assert [p.name for p in files] == [
        "DE_rrc_eula_ChartSetsForOpenCPN.html",
        "EN_rrc_eula_ChartSetsForOpenCPN.html",
    ]
    assert pick_eula(files).name.startswith("EN_")
    assert pick_eula([]) is None


# -- over HTTP -------------------------------------------------------------------

Z = 13
X, Y = tile_of(54.2, 11.2, Z)
EULA = "EN_rrc_eula_ChartSetsForOpenCPN.html"


def _build_west(d: Path) -> None:
    point_cell(
        d / "WEST.senc", name="WEST", scale=180_000,
        bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.0, 54.0, 11.19, 54.4),
    )
    (d / EULA).write_text("<html><body>Licence v1</body></html>")


def _build_east(d: Path) -> None:
    point_cell(
        d / "EAST.senc", name="EAST", scale=180_000,
        bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.19, 54.0, 11.4, 54.4),
    )


class Network:
    """The gate's ``network_check`` for these tests: the TestClient's peer is
    the non-address ``"testclient"``, which the real check refuses (fails
    closed). Here it stands for ``peer`` — a boat-LAN screen unless a test
    moves it — and everything else is the real classification."""

    def __init__(self) -> None:
        self.peer = "192.168.1.20"

    def __call__(self, peer: str | None, forwarded_for: str | None) -> str | None:
        return boat_network_refusal(self.peer if peer == "testclient" else peer, forwarded_for)


@pytest.fixture()
def env(tmp_path: Path):
    """set-A stands in for an encrypted o-charts set (it ships the EULA),
    set-B for a free one. Plain .senc cells either way: what is licensed is
    pinned here, so no daemon is involved."""
    from mivnav.api.app import app
    from mivnav.features.ocharts.routes import get_device_gate

    gen = _two_set_env(tmp_path, _build_west, _build_east)
    client, service = next(gen)
    licensed_ids = {"set-A"}
    service.licensed = lambda cs: cs.id in licensed_ids
    gate = DeviceGate(DeviceStore(tmp_path / "state" / "devices.json"), network_check=Network())
    app.dependency_overrides[get_device_gate] = lambda: gate
    try:
        yield client, service, gate, licensed_ids
    finally:
        gen.close()


def _register(client, name: str = "Chart table") -> str:
    me = client.get("/ocharts/devices/me").json()
    r = client.post(
        "/ocharts/devices", json={"name": name, "accept": [e["id"] for e in me["eulas"]]}
    )
    assert r.status_code == 200, r.text
    return r.cookies[COOKIE]


def _sets_in(content: bytes) -> set[str]:
    return {t.get("set") for t in chartcore.tile_feature_tags(content, "LIGHTS")}


def test_nothing_is_enforced_without_a_licensed_set(env) -> None:
    client, _, _, licensed_ids = env
    licensed_ids.clear()
    me = client.get("/ocharts/devices/me").json()
    assert me["gate"] is False and me["allowed"] is True and me["eulas"] == []
    r = client.get(f"/tiles/all/{Z}/{X}/{Y}")
    assert r.status_code == 200
    assert _sets_in(r.content) == {"set-A", "set-B"}


def test_an_unregistered_device_gets_the_free_sets_only(env) -> None:
    client, *_ = env
    me = client.get("/ocharts/devices/me").json()
    assert me["gate"] is True and me["registered"] is False and me["allowed"] is False
    assert me["removed"] is False
    assert [e["sets"] for e in me["eulas"]] == [["Set A"]]

    r = client.get(f"/tiles/all/{Z}/{X}/{Y}")
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "device_not_registered"
    assert r.headers["cache-control"] == "no-store"
    assert client.get(f"/tiles/set-A/{Z}/{X}/{Y}").status_code == 403
    assert client.get(f"/tiles/set-B/{Z}/{X}/{Y}").status_code == 200

    free = client.get(f"/tiles/free/{Z}/{X}/{Y}")
    assert free.status_code == 200
    assert _sets_in(free.content) == {"set-B"}
    # Its own validator: a cached /tiles/all answer must never 304 here.
    assert free.headers["etag"].startswith('"free-')


def test_catalog_marks_the_licensed_sets(env) -> None:
    client, *_ = env
    sets = {s["id"]: s["licensed"] for s in client.get("/catalog").json()["sets"]}
    assert sets == {"set-A": True, "set-B": False}


def test_registering_needs_the_eula_and_then_serves_everything(env) -> None:
    client, *_ = env
    r = client.post("/ocharts/devices", json={"name": "Chart table", "accept": []})
    assert r.status_code == 422
    _register(client)
    me = client.get("/ocharts/devices/me").json()
    assert me["registered"] and me["allowed"] and me["count"] == 1
    assert me["device"]["name"] == "Chart table"
    r = client.get(f"/tiles/all/{Z}/{X}/{Y}")
    assert r.status_code == 200 and _sets_in(r.content) == {"set-A", "set-B"}
    # Registering twice from one browser is refused, not a second slot.
    again = client.post("/ocharts/devices", json={"name": "again", "accept": []})
    assert again.status_code == 409


def test_licensed_content_is_never_cacheable_free_content_is(env) -> None:
    """o-charts licence (plan W2): licensed tiles and notes are `private,
    no-store` with no ETag and no 304, so no client keeps them on disk; free
    sets keep the revalidated `public, no-cache` + ETag caching."""
    client, service, *_ = env
    for set_dir in ("set-A", "set-B"):
        (service.get(set_dir).directory / "NOTE.TXT").write_text("a note")
    _register(client)

    def licensed(r) -> None:
        assert r.status_code == 200
        assert r.headers["cache-control"] == "private, no-store"
        assert "etag" not in r.headers

    for url in (f"/tiles/all/{Z}/{X}/{Y}", f"/tiles/set-A/{Z}/{X}/{Y}", "/text/set-A/NOTE.TXT"):
        licensed(client.get(url))
        licensed(client.get(url, headers={"if-none-match": "*"}))  # never 304

    for url in (f"/tiles/free/{Z}/{X}/{Y}", f"/tiles/set-B/{Z}/{X}/{Y}", "/text/set-B/NOTE.TXT"):
        r = client.get(url)
        assert r.status_code == 200
        assert r.headers["cache-control"] == "public, no-cache"
        etag = r.headers["etag"]
        assert client.get(url, headers={"if-none-match": etag}).status_code == 304


def test_the_sixth_device_removes_one_and_the_removed_one_loses_o_charts(env) -> None:
    client, *_ = env
    tokens = []
    for i in range(MAX_DEVICES):
        client.cookies.clear()
        tokens.append(_register(client, f"screen {i}"))

    client.cookies.clear()
    me = client.get("/ocharts/devices/me").json()
    full = client.post(
        "/ocharts/devices", json={"name": "screen 6", "accept": [e["id"] for e in me["eulas"]]}
    )
    assert full.status_code == 409
    listed = client.get("/ocharts/devices").json()
    assert [d["name"] for d in listed] == [f"screen {i}" for i in range(MAX_DEVICES)]
    assert not any(d["current"] for d in listed)

    # Anyone may remove: this browser is not registered at all.
    assert client.delete(f"/ocharts/devices/{listed[0]['id']}").status_code == 200
    _register(client, "screen 6")
    assert client.get(f"/tiles/all/{Z}/{X}/{Y}").status_code == 200

    client.cookies.clear()
    client.cookies.set(COOKIE, tokens[0])
    r = client.get("/ocharts/devices/me")
    me = r.json()
    assert me["removed"] is True and me["registered"] is False and me["allowed"] is False
    # Said once: the stale cookie goes with that answer.
    assert r.headers["set-cookie"].startswith(f'{COOKIE}="";')
    assert client.get(f"/tiles/all/{Z}/{X}/{Y}").status_code == 403


def test_removing_yourself_drops_the_cookie(env) -> None:
    client, *_ = env
    _register(client)
    me = client.get("/ocharts/devices/me").json()
    r = client.delete(f"/ocharts/devices/{me['device']['id']}")
    assert r.status_code == 200
    assert 'mivnav_device=""' in r.headers["set-cookie"] or "Max-Age=0" in r.headers["set-cookie"]


def test_a_changed_eula_must_be_accepted_again(env) -> None:
    client, service, *_ = env
    _register(client)
    eula = service.get("set-A").directory / EULA
    eula.write_text("<html><body>Licence v2</body></html>")
    service.invalidate()
    me = client.get("/ocharts/devices/me").json()
    assert me["registered"] is True and me["allowed"] is False
    assert [e["accepted"] for e in me["eulas"]] == [False]
    assert client.get(f"/tiles/all/{Z}/{X}/{Y}").status_code == 403

    r = client.post("/ocharts/devices/me/accept", json={"accept": [me["eulas"][0]["id"]]})
    assert r.status_code == 200 and r.json()["allowed"] is True
    assert client.get(f"/tiles/all/{Z}/{X}/{Y}").status_code == 200


def test_eula_is_served_sandboxed(env) -> None:
    client, *_ = env
    eula_id = client.get("/ocharts/devices/me").json()["eulas"][0]["id"]
    r = client.get(f"/ocharts/eula/{eula_id}")
    assert r.status_code == 200
    assert "Licence v1" in r.text
    assert r.headers["content-security-policy"] == "sandbox"
    assert client.get("/ocharts/eula/0123456789abcdef").status_code == 404


def test_rename(env) -> None:
    client, *_ = env
    _register(client)
    device_id = client.get("/ocharts/devices/me").json()["device"]["id"]
    r = client.patch(f"/ocharts/devices/{device_id}", json={"name": "Nav station"})
    assert r.status_code == 200 and r.json() == {**r.json(), "name": "Nav station", "current": True}
    assert client.patch("/ocharts/devices/nope", json={"name": "x"}).status_code == 404
    assert client.patch(f"/ocharts/devices/{device_id}", json={"name": " "}).status_code == 422


# -- cell outlines (plan W12) ------------------------------------------------------

# Inside WEST's coverage (set-A, licensed) only.
WEST_SPOT = {"lon": 11.18, "lat": 54.2}


def _cells_at(client, **params) -> set[str]:
    r = client.get("/cells/at", params={**WEST_SPOT, **params})
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    return {c["set"] for c in r.json()["cells"]}


def _outline_sets(client, **params) -> set[str]:
    r = client.get("/debug/cells", params=params)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    return {f["properties"]["set"] for f in r.json()["features"]}


def test_an_unregistered_screen_gets_no_licensed_cells(env) -> None:
    client, *_ = env
    # Answered as if free=true (no 403): the scale badge keeps working.
    assert _cells_at(client) == set()
    assert _cells_at(client, free="true") == set()
    assert _outline_sets(client) == {"set-B"}


def test_a_registered_screen_gets_every_cell(env) -> None:
    client, *_ = env
    _register(client)
    assert _cells_at(client) == {"set-A"}
    assert _cells_at(client, free="true") == set()
    assert _outline_sets(client) == {"set-A", "set-B"}
    # The free union (a screen that lost the server draws it) asks for free.
    assert _outline_sets(client, free="true") == {"set-B"}


def test_cells_without_a_licensed_set_are_unchanged(env) -> None:
    client, _, _, licensed_ids = env
    licensed_ids.clear()
    assert _cells_at(client) == {"set-A"}
    assert _outline_sets(client) == {"set-A", "set-B"}


# -- the boat network only (plan W11) ----------------------------------------------


def test_a_registered_screen_off_the_boat_network_gets_no_licensed_content(env) -> None:
    client, service, gate, _ = env
    (service.get("set-A").directory / "NOTE.TXT").write_text("a note")
    _register(client)
    gate.network_check.peer = "203.0.113.7"  # say, through a port forward

    for url in (f"/tiles/all/{Z}/{X}/{Y}", f"/tiles/set-A/{Z}/{X}/{Y}", "/text/set-A/NOTE.TXT"):
        r = client.get(url)
        assert r.status_code == 403, url
        assert r.json()["detail"]["code"] == "not_boat_network"
        assert "203.0.113.7" in r.json()["detail"]["message"]
        assert r.headers["cache-control"] == "no-store"
    assert _cells_at(client) == set()
    assert _outline_sets(client) == {"set-B"}
    # The screen is told to draw /tiles/free, which still works.
    me = client.get("/ocharts/devices/me").json()
    assert me["registered"] is True and me["allowed"] is False
    assert client.get(f"/tiles/free/{Z}/{X}/{Y}").status_code == 200
    assert client.get(f"/tiles/set-B/{Z}/{X}/{Y}").status_code == 200

    gate.network_check.peer = "100.101.102.103"  # the tailnet
    assert client.get(f"/tiles/all/{Z}/{X}/{Y}").status_code == 200


def test_the_forwarded_client_counts_only_behind_a_loopback_proxy(env) -> None:
    client, _, gate, _ = env
    _register(client)
    url = f"/tiles/all/{Z}/{X}/{Y}"

    def status(peer: str, forwarded: str | None = None) -> int:
        gate.network_check.peer = peer
        headers = {"x-forwarded-for": forwarded} if forwarded is not None else {}
        return client.get(url, headers=headers).status_code

    # The same-host proxy: its appended (rightmost) entry is the client.
    assert status("127.0.0.1", "192.168.1.30") == 200
    assert status("127.0.0.1", "203.0.113.7") == 403
    # A public client that sends its own LAN-looking header: the proxy
    # appends the real address, and only that one is believed.
    assert status("127.0.0.1", "192.168.1.30, 203.0.113.7") == 403
    assert status("127.0.0.1", "203.0.113.7, 192.168.1.30") == 200
    # Any other peer's header is ignored, both ways.
    assert status("203.0.113.7", "192.168.1.30") == 403
    assert status("192.168.1.30", "203.0.113.7") == 200


def test_the_boat_network_check_is_not_applied_without_a_licensed_set(env) -> None:
    client, _, gate, licensed_ids = env
    licensed_ids.clear()
    gate.network_check.peer = "203.0.113.7"
    assert client.get(f"/tiles/all/{Z}/{X}/{Y}").status_code == 200
    assert client.get("/ocharts/devices/me").json()["allowed"] is True
