# SPDX-License-Identifier: GPL-2.0-only
"""Man overboard: the persisted mark, SignalK's echo of ``notifications.mob``,
the publisher's raise / refresh / clear / leave-others-alone decisions, the
HTTP surface, and the snapshot extension every screen reads it from.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mivnav.features.mob.client import MobSignalKError, waypoint_for
from mivnav.features.mob.notice import value_for
from mivnav.features.mob.publisher import ECHO_GRACE_S, REFRESH_S, RETRY_S, MobPublisher
from mivnav.features.mob.runtime import MobRuntime
from mivnav.features.mob.store import Mob, MobStore
from mivnav.signalk.mob import reduce
from mivnav.signalk.model import VesselTracker
from mivnav.signalk.writer import DeltaWriter
from tests.conftest import isolated_runtime_at

BOAT = {"id": "urn:self", "lat": 55.9, "lng": 12.6}
WHEN = datetime(2026, 11, 6, 14, 32, 5, tzinfo=UTC)


# -- the store ----------------------------------------------------------------


def test_store_persists_and_survives_a_restart(tmp_path: Path) -> None:
    path = tmp_path / "mob.json"
    mob, created = MobStore(path).activate(55.9, 12.6, now=WHEN)
    assert created
    assert mob.at == "2026-11-06T14:32:05+00:00"
    again = MobStore(path).active()
    assert again == mob


def test_a_second_press_keeps_the_first_mark(tmp_path: Path) -> None:
    store = MobStore(tmp_path / "mob.json")
    first, _ = store.activate(55.9, 12.6)
    second, created = store.activate(56.0, 13.0)
    assert not created
    assert second == first


def test_clear_is_persisted(tmp_path: Path) -> None:
    path = tmp_path / "mob.json"
    store = MobStore(path)
    mob, _ = store.activate(55.9, 12.6)
    assert store.clear() == mob
    assert store.clear() is None
    assert MobStore(path).active() is None


def test_a_mob_without_a_fix_still_goes_up(tmp_path: Path) -> None:
    mob, created = MobStore(tmp_path / "mob.json").activate(None, None)
    assert created and not mob.has_position
    assert "lat" not in mob.wire()
    assert "position" not in value_for(mob)


def test_a_corrupt_file_reads_as_no_mob(tmp_path: Path) -> None:
    path = tmp_path / "mob.json"
    path.write_text("{not json")
    assert MobStore(path).active() is None


# -- the notification, both directions ----------------------------------------


def test_raise_is_an_emergency_that_sounds() -> None:
    mob = Mob(id="m1", at="2026-11-06T14:32:05+00:00", lat=55.9, lng=12.6)
    value = value_for(mob)
    assert value["state"] == "emergency"
    assert value["method"] == ["visual", "sound"]
    assert value["position"] == {"latitude": 55.9, "longitude": 12.6}
    assert value["data"]["publisher"] == "mivnav"
    assert value_for(None)["state"] == "normal"


def test_waypoint_is_a_geojson_point() -> None:
    mob = Mob(id="m1", at="2026-11-06T14:32:05+00:00", lat=55.9, lng=12.6)
    body = waypoint_for(mob)
    assert body["feature"]["geometry"] == {"type": "Point", "coordinates": [12.6, 55.9]}
    assert body["name"] == "MOB 14:32Z"


def test_echo_reduces_ours_and_theirs() -> None:
    mob = Mob(id="m1", at="t", lat=1.0, lng=2.0)
    ours = {**value_for(mob), "id": "abc", "status": {"acknowledged": False, "canAcknowledge": True}}
    out = reduce(ours)
    assert out is not None
    assert out["ours"] and out["id"] == "abc" and out["sound"] and out["lat"] == 1.0
    theirs = reduce({"state": "emergency", "method": ["visual", "sound"], "message": "MOB"})
    assert theirs is not None and not theirs["ours"]
    assert reduce(value_for(None)) is None
    assert reduce(None) is None


def test_tracker_carries_the_echo_in_the_snapshot() -> None:
    tracker = VesselTracker()
    tracker.apply(json.dumps({"self": "vessels.urn:self"}), 0)
    value = {**value_for(Mob(id="m1", at="t", lat=1.0, lng=2.0)), "id": "abc"}
    delta = {"context": "vessels.urn:self", "updates": [{"values": [{"path": "notifications.mob", "value": value}]}]}
    tracker.apply(json.dumps(delta), 0)
    assert tracker.snapshot(0, 600)["mobNotice"]["id"] == "abc"
    clear = {"context": "vessels.urn:self", "updates": [{"values": [{"path": "notifications.mob", "value": value_for(None)}]}]}
    tracker.apply(json.dumps(clear), 0)
    assert "mobNotice" not in tracker.snapshot(0, 600)


# -- the publisher ------------------------------------------------------------


class SpyWriter(DeltaWriter):
    def __init__(self) -> None:
        super().__init__(connect=lambda url, headers: None)
        self.sent: list[dict[str, Any]] = []
        self.fail = False

    def send(self, url: str, token: str | None, delta: dict[str, Any]) -> None:
        if self.fail:
            raise OSError("boat box asleep")
        self.sent.append(delta)

    def states(self) -> list[str]:
        return [v["value"]["state"] for d in self.sent for u in d["updates"] for v in u["values"]]


class SpyClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.fail = False

    def _do(self, name: str, arg: Any) -> None:
        if self.fail:
            raise MobSignalKError("nope")
        self.calls.append((name, arg))

    def put_waypoint(self, mob: Mob) -> None:
        self._do("put", mob.id)

    def delete_waypoint(self, mob_id: str) -> None:
        self._do("delete", mob_id)

    def set_destination(self, lat: float, lng: float) -> None:
        self._do("destination", (lat, lng))

    def clear_course(self) -> None:
        self._do("clear_course", None)


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def pub(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    runtime = isolated_runtime_at(tmp_path)
    runtime.config.patch({"signalk": {"enabled": True}, "credentials": {"signalk": {"token": "tok"}}})
    client = SpyClient()
    monkeypatch.setattr(MobRuntime, "client", lambda self: client)
    writer, clock = SpyWriter(), Clock()
    yield MobPublisher(runtime, writer=writer, clock=clock), writer, clock, runtime, client
    runtime.close()


def snap(**extra: Any) -> dict[str, Any]:
    return {"status": "connected", "self": BOAT, "targets": [], **extra}


def echo_of(mob: Mob, **status: Any) -> dict[str, Any]:
    out = reduce({**value_for(mob), "id": "n1", "status": status})
    assert out is not None
    return out


def test_publisher_raises_puts_the_mark_and_refreshes(pub) -> None:
    publisher, writer, clock, runtime, client = pub
    store = runtime.feature("mob").store
    mob, _ = store.activate(55.9, 12.6)
    publisher.tick(snap())
    assert writer.states() == ["emergency"]
    assert client.calls == [("put", mob.id)]
    # Echoed: nothing more until the refresh.
    clock.t += REFRESH_S - 1
    publisher.tick(snap(mobNotice=echo_of(mob)))
    assert writer.states() == ["emergency"]
    clock.t += 1
    publisher.tick(snap(mobNotice=echo_of(mob)))
    assert writer.states() == ["emergency", "emergency"]
    assert client.calls == [("put", mob.id)]


def test_publisher_re_raises_soon_when_the_echo_is_missing(pub) -> None:
    publisher, writer, clock, runtime, _ = pub
    runtime.feature("mob").store.activate(55.9, 12.6)
    publisher.tick(snap())
    clock.t += ECHO_GRACE_S
    publisher.tick(snap())  # SignalK restarted and forgot it
    assert writer.states() == ["emergency", "emergency"]


def test_publisher_clears_and_deletes_the_mark(pub) -> None:
    publisher, writer, clock, runtime, client = pub
    store = runtime.feature("mob").store
    mob, _ = store.activate(55.9, 12.6)
    publisher.tick(snap())
    store.clear()
    clock.t += 1
    publisher.tick(snap(mobNotice=echo_of(mob)))
    assert writer.states() == ["emergency", "normal"]
    assert client.calls == [("put", mob.id), ("delete", mob.id)]
    clock.t += 1
    publisher.tick(snap())
    assert writer.states() == ["emergency", "normal"]


def test_publisher_clears_a_leftover_of_ours_but_never_someone_elses(pub) -> None:
    publisher, writer, clock, _, _ = pub
    theirs = reduce({"state": "emergency", "method": ["sound"], "message": "MOB from the MFD"})
    publisher.tick(snap(mobNotice=theirs))
    assert writer.states() == []
    ghost = echo_of(Mob(id="old", at="t", lat=1.0, lng=2.0))
    clock.t += 100
    publisher.tick(snap(mobNotice=ghost))
    assert writer.states() == ["normal"]
    clock.t += 1
    publisher.tick(snap(mobNotice=ghost))  # echo not caught up yet: rate-limited
    assert writer.states() == ["normal"]


def test_publisher_retries_a_failed_raise(pub) -> None:
    publisher, writer, clock, runtime, _ = pub
    runtime.feature("mob").store.activate(55.9, 12.6)
    writer.fail = True
    publisher.tick(snap())
    writer.fail = False
    clock.t += 1
    publisher.tick(snap())
    assert writer.states() == []
    clock.t += RETRY_S
    publisher.tick(snap())
    assert writer.states() == ["emergency"]


def test_publisher_waits_for_the_link(pub) -> None:
    publisher, writer, _, runtime, _ = pub
    runtime.feature("mob").store.activate(55.9, 12.6)
    publisher.tick({"status": "connecting"})
    assert writer.states() == []


# -- the HTTP surface ---------------------------------------------------------


class StubSignalK:
    def __init__(self, snapshot: dict[str, Any]) -> None:
        self._snapshot = snapshot

    def snapshot(self) -> dict[str, Any]:
        return self._snapshot


@pytest.fixture
def api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime, get_signalk

    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    saved = dict(app.dependency_overrides)
    runtime = isolated_runtime_at(tmp_path)
    client = SpyClient()
    monkeypatch.setattr(MobRuntime, "client", lambda self: client)
    state: dict[str, Any] = {"snapshot": snap()}
    app.dependency_overrides[get_runtime] = lambda: runtime
    app.dependency_overrides[get_signalk] = lambda: StubSignalK(state["snapshot"])
    yield TestClient(app), runtime, client, state
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)
    runtime.close()


def test_raise_at_the_server_fix_get_and_clear(api) -> None:
    http, _, _, _ = api
    assert http.get("/mob").json() == {"active": None}
    r = http.post("/mob")
    assert r.status_code == 200
    body = r.json()
    assert body["created"] and body["active"]["lat"] == 55.9 and body["active"]["lng"] == 12.6
    assert http.get("/mob").json()["active"] == body["active"]
    # A second press (another screen) keeps the mark.
    again = http.post("/mob", json={"lat": 1.0, "lng": 1.0}).json()
    assert not again["created"] and again["active"] == body["active"]
    cleared = http.delete("/mob").json()
    assert cleared["cleared"]["id"] == body["active"]["id"]
    assert http.get("/mob").json() == {"active": None}


def test_raise_takes_the_screens_position(api) -> None:
    http, _, _, state = api
    state["snapshot"] = {"status": "off", "self": None, "targets": []}
    body = http.post("/mob", json={"lat": 54.0, "lng": 11.0}).json()
    assert (body["active"]["lat"], body["active"]["lng"]) == (54.0, 11.0)


def test_raise_with_no_fix_anywhere_still_raises(api) -> None:
    http, _, _, state = api
    state["snapshot"] = {"status": "off", "self": None, "targets": []}
    body = http.post("/mob").json()
    assert body["created"] and "lat" not in body["active"]


def test_navigate_needs_a_mob_and_write_access(api) -> None:
    http, runtime, client, _ = api
    assert http.post("/mob/navigate").status_code == 409
    http.post("/mob")
    assert http.post("/mob/navigate").status_code == 503  # SignalK off in tests
    runtime.config.patch({"signalk": {"enabled": True}})
    assert http.post("/mob/navigate").status_code == 503  # no token
    runtime.config.patch({"credentials": {"signalk": {"token": "tok"}}})
    assert http.post("/mob/navigate").json() == {"ok": True}
    assert client.calls == [("destination", (55.9, 12.6))]
    client.fail = True
    assert http.post("/mob/navigate").status_code == 502


def test_clear_ends_a_course_to_the_mob_only(api) -> None:
    http, runtime, client, state = api
    runtime.config.patch({"signalk": {"enabled": True}, "credentials": {"signalk": {"token": "tok"}}})
    http.post("/mob")
    state["snapshot"] = snap(course={"nextLat": 50.0, "nextLng": 10.0})
    assert http.delete("/mob").json()["course"] == "untouched"
    http.post("/mob")
    state["snapshot"] = snap(course={"nextLat": 55.9, "nextLng": 12.6})
    assert http.delete("/mob").json()["course"] == "cleared"
    assert client.calls == [("clear_course", None)]


def test_ack_only_names_the_live_notification(api) -> None:
    http, runtime, _, state = api
    runtime.config.patch({"signalk": {"enabled": True}})
    state["snapshot"] = snap(mobNotice={"state": "emergency", "id": "n1", "acknowledged": True, "ours": True})
    assert http.post("/mob/ack", json={"id": "n1"}).json() == {"ok": True, "acknowledged": 0}
    assert http.post("/mob/ack", json={"id": "zz"}).json() == {"ok": True, "acknowledged": 0}


def test_the_snapshot_carries_the_active_mob(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    runtime = isolated_runtime_at(tmp_path)
    try:
        assert "mob" not in runtime.signalk().snapshot()
        mob, _ = runtime.feature("mob").store.activate(55.9, 12.6)
        assert runtime.signalk().snapshot()["mob"] == mob.wire()
    finally:
        runtime.close()


# -- the client's wire --------------------------------------------------------


def test_client_wire(tmp_path: Path) -> None:
    """The URLs, verbs, bodies and bearer the box sees, over real TCP."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from mivnav.features.mob.client import MobClient

    seen: list[tuple[str, str, Any, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def _do(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length)) if length else None
            seen.append((self.command, self.path, body, self.headers.get("Authorization")))
            status = 404 if self.command == "DELETE" and "waypoints" in self.path else 200
            payload = json.dumps({"state": "COMPLETED", "statusCode": status}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_PUT = do_DELETE = _do  # noqa: N815

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/signalk/v2/api"
    try:
        client = MobClient(f"{base}/vessels/self/navigation/course", f"{base}/resources", "tok")
        mob = Mob(id="m1", at="2026-11-06T14:32:05+00:00", lat=55.9, lng=12.6)
        client.put_waypoint(mob)
        client.set_destination(55.9, 12.6)
        client.delete_waypoint("m1")  # 404: already gone is fine
        client.clear_course()
    finally:
        server.shutdown()
    assert [(m, p) for m, p, _, _ in seen] == [
        ("PUT", "/signalk/v2/api/resources/waypoints/m1"),
        ("PUT", "/signalk/v2/api/vessels/self/navigation/course/destination"),
        ("DELETE", "/signalk/v2/api/resources/waypoints/m1"),
        ("DELETE", "/signalk/v2/api/vessels/self/navigation/course"),
    ]
    assert seen[1][2] == {"position": {"latitude": 55.9, "longitude": 12.6}}
    assert all(auth == "Bearer tok" for _, _, _, auth in seen)
    with pytest.raises(MobSignalKError):
        MobClient(None, None, "tok").set_destination(1.0, 2.0)
