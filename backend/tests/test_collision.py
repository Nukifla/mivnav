# SPDX-License-Identifier: GPL-2.0-only
"""The server-side collision watch: the per-snapshot assessment, the SignalK
notification it raises, the echo it reads back, and the publisher's
raise / refresh / hold / clear / ghost decisions — then once end to end,
over real sockets, against the fake SignalK.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from mivnav.collision.assess import assess
from mivnav.collision.notices import NoticeState, path_for, reduce_echo, value_for
from mivnav.collision.publisher import HOLD_S, MUTE_S, REFRESH_S, RETRY_S, CollisionPublisher
# Via the model, not `mivnav.collision.config`: a config slice imported
# before `mivnav.config` is a cycle (true of every slice, `route.config` too).
from mivnav.config.model import CollisionConfig, Config
from mivnav.signalk.model import VesselTracker
from mivnav.signalk.writer import DeltaWriter
from tests.conftest import isolated_runtime_at
from tests.fake_signalk import FakeSignalK

KN = 1852 / 3600  # m/s per knot
A = "urn:mrn:imo:mmsi:265000001"
B = "urn:mrn:imo:mmsi:265000002"
ATON = "urn:mrn:imo:mmsi:992351234"


def vessel(vid: str, north_nm: float, cog: float, sog_kn: float, **extra: Any) -> dict[str, Any]:
    return {"id": vid, "lat": north_nm / 60, "lng": 0.0, "cogDeg": cog, "sogMs": sog_kn * KN, **extra}


#: Own ship at the origin, 10 kn north.
OWN = vessel("urn:self", 0, 0, 10)


def snapshot(*targets: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"status": "connected", "self": OWN, "targets": list(targets), **extra}


#: Dead ahead, closing: red (CPA 0, TCPA 6 min).
RED = vessel(A, 2, 180, 10, name="TANKER", mmsi="265000001")
#: Dead ahead further out: yellow (TCPA 24 min).
YELLOW = vessel(B, 8, 180, 10, mmsi="265000002")


# -- the assessment ----------------------------------------------------------


def test_assess_picks_the_worst_threat_and_lists_alarms() -> None:
    out = assess(snapshot(YELLOW, RED), CollisionConfig())
    assert out is not None
    assert out["threat"]["id"] == A
    assert out["threat"]["risk"] == "red"
    assert out["threat"]["name"] == "TANKER"
    assert out["threat"]["tcpaMin"] == pytest.approx(6, rel=1e-3)
    assert [(a["id"], a["risk"]) for a in out["alarms"]] == [(A, "red"), (B, "yellow")]


def test_assess_reads_thresholds_from_config() -> None:
    out = assess(snapshot(RED), CollisionConfig(horizon_min=5, warning_horizon_min=5))
    assert out is not None and out["threat"]["risk"] == "green"
    assert "alarms" not in out


def test_assess_never_alarms_on_a_non_vessel_station() -> None:
    aton = vessel(ATON, 1, 180, 10, mmsi="992351234")
    assert assess(snapshot(aton), CollisionConfig()) is None


def test_assess_never_alarms_on_a_sar_aircraft() -> None:
    heli = vessel(A, 1, 180, 10, mmsi="111219500")
    assert assess(snapshot(heli), CollisionConfig()) is None
    out = assess(snapshot(heli, vessel(B, 1, 180, 10)), CollisionConfig())
    assert out is not None and out["threat"]["id"] == B
    assert [a["id"] for a in out["alarms"]] == [B]


def test_assess_needs_an_own_fix() -> None:
    assert assess({"status": "connected", "self": None, "targets": [RED]}, CollisionConfig()) is None


def test_receding_target_never_outranks_a_closing_one() -> None:
    """The trap the ranking exists for (moved here with ``pickThreat``): a
    ship that passed 0.05 nm away has TCPA < 0 and is green; "soonest TCPA
    first" or "smallest CPA first" alone would pick it over one still coming."""
    gone = {"id": A, "lat": 0.01 / 60, "lng": 0.0, "cogDeg": 0.0, "sogMs": 20 * KN}
    coming = {"id": B, "lat": 6 / 60, "lng": 3 / 60, "cogDeg": 200.0, "sogMs": 4 * KN}
    out = assess(snapshot(gone, coming), CollisionConfig())
    assert out is not None
    assert out["threat"]["id"] == B
    assert out["threat"]["risk"] == "green" and out["threat"]["tcpaMin"] > 0


def test_equal_risk_smaller_cpa_wins_whatever_the_order() -> None:
    near = vessel(A, 1, 180, 10)
    off = {**vessel(B, 1, 180, 10), "lng": 0.2 / 60}
    for order in ((near, off), (off, near)):
        out = assess(snapshot(*order), CollisionConfig())
        assert out is not None and out["threat"]["id"] == A


def test_a_dead_gps_assesses_nothing() -> None:
    """Invariant #6 at its sharpest, carried over from the browser's
    ``staleAge: fixAge``: a CPA from a position the boat no longer has is a
    confident wrong alarm — and now it would go out to every display."""
    assert assess({"self": OWN, "targets": [RED], "fixAge": 10}, CollisionConfig()) is None


def test_tracker_reports_the_own_fix_age_only_when_stale() -> None:
    tracker = VesselTracker()
    tracker.apply(json.dumps({"self": "vessels.urn:self"}), 0)

    def report(vid: str, now: float) -> None:
        tracker.apply(json.dumps({
            "context": f"vessels.{vid}",
            "updates": [{"values": [{"path": "navigation.position", "value": {"latitude": 1, "longitude": 2}}]}],
        }), now)

    report("urn:self", 0)
    report(A, 0)
    assert "fixAge" not in tracker.snapshot(5, 600)
    assert tracker.snapshot(11, 600)["fixAge"] == 10
    report(A, 11)  # a target reporting says nothing about our GPS
    assert tracker.snapshot(12, 600)["fixAge"] == 10
    report("urn:self", 12)  # the same position again: at anchor, not dead
    assert "fixAge" not in tracker.snapshot(13, 600)


def test_green_threat_still_rides_for_the_tile() -> None:
    far = vessel(A, 30, 0, 5)  # same course, slower, ahead: we pass it, miles off
    out = assess(snapshot(far), CollisionConfig())
    assert out is not None and out["threat"]["risk"] == "green" and "alarms" not in out


# -- the notification, both ways ---------------------------------------------


def test_value_for_red_sounds_yellow_does_not() -> None:
    alarm = assess(snapshot(RED, YELLOW), CollisionConfig())["alarms"]  # type: ignore[index]
    red, yellow = value_for(alarm[0]), value_for(alarm[1])
    assert (red["state"], red["method"]) == ("alarm", ["visual", "sound"])
    assert (yellow["state"], yellow["method"]) == ("warn", ["visual"])
    assert "TANKER" in red["message"] and "MMSI 265000002" in yellow["message"]
    assert red["data"]["publisher"] == "mivnav"
    assert value_for(None)["state"] == "normal"


def echo(state: str, *, ours: bool = True, acknowledged: bool = False, silenced: bool = False) -> dict[str, Any]:
    """The value as signalk-server's notification manager re-emits it."""
    value: dict[str, Any] = {
        "state": state,
        "method": [] if acknowledged else ["visual"] if silenced else ["visual", "sound"],
        "message": "x",
        "id": "9d6a-uuid",
        "status": {
            "acknowledged": acknowledged,
            "canAcknowledge": True,
            "silenced": silenced,
            "canSilence": True,
        },
    }
    if ours:
        value["data"] = {"publisher": "mivnav"}
    return value


def test_reduce_echo() -> None:
    assert reduce_echo(echo("alarm")) == {
        "state": "alarm",
        "id": "9d6a-uuid",
        "sound": True,
        "acknowledged": False,
        "canAcknowledge": True,
        "silenced": False,
        "canSilence": True,
    }
    assert reduce_echo(echo("alarm", acknowledged=True))["sound"] is False  # type: ignore[index]
    muted = reduce_echo(echo("alarm", silenced=True))
    assert muted is not None and muted["silenced"] is True and muted["sound"] is False
    assert reduce_echo(echo("normal")) is None
    assert reduce_echo(echo("alarm", ours=False)) is None


def test_notice_state_ignores_someone_elses_notification_on_the_same_path() -> None:
    state = NoticeState()
    state.apply(path_for(A), echo("alarm"))
    # signalk-derived-data publishes the same path: it must not clobber ours.
    state.apply(path_for(A), echo("normal", ours=False))
    assert state.snapshot() == {A: reduce_echo(echo("alarm"))}
    state.apply(path_for(A), None)
    assert state.snapshot() is None


def test_tracker_carries_our_echo_in_the_snapshot() -> None:
    tracker = VesselTracker()
    tracker.apply(json.dumps({"self": "vessels.urn:self"}), 0)
    delta = {
        "context": "vessels.urn:self",
        "updates": [{"$source": "ws.mivnav", "values": [{"path": path_for(A), "value": echo("alarm")}]}],
    }
    tracker.apply(json.dumps(delta), 0)
    assert tracker.snapshot(0, 600)["collisionNotices"] == {A: reduce_echo(echo("alarm"))}


# -- the publisher's decisions -----------------------------------------------


class SpyWriter(DeltaWriter):
    def __init__(self) -> None:
        super().__init__(connect=lambda url, headers: None)
        self.sent: list[tuple[str, str | None, dict[str, Any]]] = []
        self.fail = False

    def send(self, url: str, token: str | None, delta: dict[str, Any]) -> None:
        if self.fail:
            raise OSError("boat box asleep")
        self.sent.append((url, token, delta))

    def values(self) -> list[tuple[str, str]]:
        """``(path, state)`` of everything sent, in order."""
        return [
            (v["path"], v["value"]["state"])
            for _, _, d in self.sent
            for u in d["updates"]
            for v in u["values"]
        ]


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def pub(tmp_path: Path) -> tuple[CollisionPublisher, SpyWriter, Clock, Any]:
    runtime = isolated_runtime_at(tmp_path)
    runtime.config.patch(
        {"signalk": {"enabled": True}, "credentials": {"signalk": {"token": "tok"}}}
    )
    writer, clock = SpyWriter(), Clock()
    return CollisionPublisher(runtime, writer=writer, clock=clock), writer, clock, runtime


def assessed(*targets: dict[str, Any], **extra: Any) -> dict[str, Any]:
    snap = snapshot(*targets, **extra)
    result = assess(snap, CollisionConfig())
    if result is not None:
        snap["collision"] = result
    return snap


def test_raises_with_the_token_and_only_once(pub) -> None:
    publisher, writer, clock, runtime = pub
    publisher.tick(assessed(RED))
    clock.t += 1
    publisher.tick(assessed(RED))
    assert writer.values() == [(path_for(A), "alarm")]
    url, token, delta = writer.sent[0]
    assert token == "tok"
    assert url == runtime.config.get().signalk.ws_url
    assert delta["context"] == "vessels.self"


def test_refreshes_an_active_alarm(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(assessed(RED))
    clock.t += REFRESH_S
    publisher.tick(assessed(RED))
    assert writer.values() == [(path_for(A), "alarm")] * 2


def test_escalates_at_once_but_steps_down_only_after_the_hold(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(assessed(YELLOW))
    publisher.tick(assessed(vessel(B, 2, 180, 10)))  # B now red
    assert writer.values() == [(path_for(B), "warn"), (path_for(B), "alarm")]
    clock.t += HOLD_S - 1
    publisher.tick(assessed())  # gone from the picture, still held
    assert len(writer.sent) == 2
    clock.t += 2
    publisher.tick(assessed())
    assert writer.values()[-1] == (path_for(B), "normal")
    clock.t += 1
    publisher.tick(assessed())
    assert len(writer.sent) == 3  # cleared once, not every tick


def test_flapping_across_the_line_does_not_re_raise(pub) -> None:
    publisher, writer, clock, _ = pub
    for i in range(10):
        clock.t += 2
        publisher.tick(assessed(RED) if i % 2 == 0 else assessed(YELLOW, vessel(A, 9, 180, 10)))
    assert [s for p, s in writer.values() if p == path_for(A)] == ["alarm"]


def test_clears_a_ghost_left_by_a_restart(pub) -> None:
    publisher, writer, clock, _ = pub
    ghost = {A: reduce_echo(echo("alarm"))}
    publisher.tick(assessed(collisionNotices=ghost))
    assert writer.values() == [(path_for(A), "normal")]
    clock.t += 1
    publisher.tick(assessed(collisionNotices=ghost))  # echo not caught up yet
    assert len(writer.sent) == 1


def test_publish_off_clears_what_is_up_then_stays_quiet(pub) -> None:
    publisher, writer, clock, runtime = pub
    publisher.tick(assessed(RED))
    runtime.config.patch({"collision": {"publish": False}})
    clock.t += 1
    publisher.tick(assessed(RED))
    clock.t += 1
    publisher.tick(assessed(RED))
    assert writer.values() == [(path_for(A), "alarm"), (path_for(A), "normal")]


def test_mode_off_clears_what_is_up_then_stays_quiet(pub) -> None:
    publisher, writer, clock, runtime = pub
    publisher.tick(assessed(RED))
    runtime.config.patch({"collision": {"mode": "off"}})
    clock.t += 1
    publisher.tick(assessed(RED))
    clock.t += REFRESH_S
    publisher.tick(assessed(RED))
    assert writer.values() == [(path_for(A), "alarm"), (path_for(A), "normal")]


def _methods(writer: SpyWriter) -> list[list[str]]:
    return [v["value"]["method"] for _, _, d in writer.sent for u in d["updates"] for v in u["values"]]


def test_mode_show_raises_without_sound_and_a_flip_re_sends(pub) -> None:
    publisher, writer, clock, runtime = pub
    runtime.config.patch({"collision": {"mode": "show"}})
    publisher.tick(assessed(RED))
    # Same state every display already knows — only the sound is gone.
    assert writer.values() == [(path_for(A), "alarm")]
    assert _methods(writer) == [["visual"]]
    clock.t += 1
    publisher.tick(assessed(RED))
    assert len(writer.sent) == 1  # unchanged, not re-sent
    runtime.config.patch({"collision": {"mode": "tell"}})
    clock.t += 1
    publisher.tick(assessed(RED))
    # Flipped to tell: a standing alarm starts sounding at once, not at the refresh.
    assert _methods(writer)[-1] == ["visual", "sound"]


def test_snapshot_carries_the_boats_collision_settings() -> None:
    from mivnav.api.deps import build_signalk_service
    from mivnav.config.model import SignalKConfig

    cfg = CollisionConfig(mode="show", sound=False, danger_nm=0.4)
    service = build_signalk_service(SignalKConfig(enabled=False), lambda: cfg)
    try:
        snap = service.snapshot()
    finally:
        service.close()
    assert snap["collisionSettings"] == cfg.model_dump(mode="json")
    assert snap["collisionSettings"]["mode"] == "show"
    assert "collision" not in snap  # no own fix, nothing assessed


def test_mode_rejects_an_unknown_value() -> None:
    with pytest.raises(ValueError):
        CollisionConfig(mode="loud")  # type: ignore[arg-type]


def test_does_nothing_while_disconnected(pub) -> None:
    publisher, writer, _, _ = pub
    publisher.tick({**assessed(RED), "status": "connecting"})
    assert writer.sent == []


def test_a_failed_write_is_retried_after_the_backoff(pub) -> None:
    publisher, writer, clock, _ = pub
    writer.fail = True
    publisher.tick(assessed(RED))
    writer.fail = False
    clock.t += RETRY_S - 1
    publisher.tick(assessed(RED))
    assert writer.sent == []
    clock.t += 1
    publisher.tick(assessed(RED))
    assert writer.values() == [(path_for(A), "alarm")]


def silenced(**kw: Any) -> dict[str, Any]:
    return {A: reduce_echo(echo("alarm", silenced=True, **kw))}


def test_a_mute_is_re_armed_after_two_minutes_by_an_escalation(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(assessed(RED))
    clock.t += 1
    publisher.tick(assessed(RED, collisionNotices=silenced()))  # someone muted it
    clock.t += MUTE_S - 1
    publisher.tick(assessed(RED, collisionNotices=silenced()))
    # Only refreshes so far — the same state keeps the silence.
    assert {s for _, s in writer.values()} == {"alarm"}
    n = len(writer.sent)
    clock.t += 1
    publisher.tick(assessed(RED, collisionNotices=silenced()))
    assert writer.values()[n:] == [(path_for(A), "warn")]
    step = writer.sent[n][2]["updates"][0]["values"][0]["value"]
    assert step["method"] == ["visual"] and step["data"]["publisher"] == "mivnav"
    clock.t += 1
    # The echo still says silenced (warn is not an escalation): no second step.
    publisher.tick(assessed(RED, collisionNotices=silenced()))
    assert writer.values()[n:] == [(path_for(A), "warn"), (path_for(A), "alarm")]


def test_a_mute_is_counted_from_when_we_first_saw_it(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(assessed(RED))
    clock.t += 60
    publisher.tick(assessed(RED))  # not silenced yet
    clock.t += 60
    publisher.tick(assessed(RED, collisionNotices=silenced()))
    clock.t += MUTE_S - 1
    publisher.tick(assessed(RED, collisionNotices=silenced()))
    assert "warn" not in {s for _, s in writer.values()}


def test_an_acked_alarm_is_never_re_armed(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(assessed(RED))
    for _ in range(3):
        clock.t += MUTE_S
        publisher.tick(assessed(RED, collisionNotices=silenced(acknowledged=True)))
    assert {s for _, s in writer.values()} == {"alarm"}


def test_a_lifted_mute_stops_the_clock(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(assessed(RED))
    clock.t += 1
    publisher.tick(assessed(RED, collisionNotices=silenced()))
    clock.t += MUTE_S / 2
    publisher.tick(assessed(RED, collisionNotices={A: reduce_echo(echo("alarm"))}))  # escalated elsewhere
    clock.t += MUTE_S / 2 + 1
    publisher.tick(assessed(RED, collisionNotices=silenced()))  # muted again: a fresh 2 min
    assert "warn" not in {s for _, s in writer.values()}


# -- end to end ----------------------------------------------------------------


def wait_until(predicate, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("condition never held")


def test_end_to_end_over_real_sockets(tmp_path: Path) -> None:
    """Fake SignalK → the real service (with the assessment hooked in by the
    real composition root) → the real publisher → an authenticated write
    socket → a delta frame on the fake."""
    fake = FakeSignalK().start()
    runtime = isolated_runtime_at(tmp_path)
    publisher = CollisionPublisher(runtime, tick_s=0.05)
    try:
        runtime.config.patch(
            {
                "signalk": {"enabled": True, "host": "127.0.0.1", "port": fake.port},
                "credentials": {"signalk": {"token": "tok"}},
            }
        )
        publisher.start()
        fake.wait_sessions(1)
        own_id = fake.self_id
        fake.broadcast(fake.delta(
            [
                ("navigation.position", {"latitude": 0.0, "longitude": 0.0}),
                ("navigation.courseOverGroundTrue", 0.0),
                ("navigation.speedOverGround", 10 * KN),
            ],
            vessel=own_id,
        ))
        fake.broadcast(fake.delta(
            [
                ("navigation.position", {"latitude": 2 / 60, "longitude": 0.0}),
                ("navigation.courseOverGroundTrue", 3.14159265),
                ("navigation.speedOverGround", 10 * KN),
                ("mmsi", "265000001"),
            ],
            vessel=A,
        ))

        def writes() -> list[dict[str, Any]]:
            return [m for m in fake.subscriptions if isinstance(m, dict) and "updates" in m]

        wait_until(lambda: writes())
        value = writes()[0]["updates"][0]["values"][0]
        assert value["path"] == path_for(A)
        assert value["value"]["state"] == "alarm"
        # The second session is the write socket, and it carries the token;
        # the read socket (the first) does not.
        assert fake.headers[1].get("authorization") == "Bearer tok"
        assert "authorization" not in fake.headers[0]
        # And every screen sees the same threat on the snapshot.
        assert runtime.signalk().snapshot()["collision"]["threat"]["id"] == A
    finally:
        publisher.stop()
        runtime.close()
        fake.stop()


def test_config_model_has_the_collision_slice() -> None:
    assert Config().collision == CollisionConfig()


# -- acknowledging on the SignalK server -----------------------------------------


@pytest.fixture
def ack_api(tmp_path: Path):
    """The real app, its SignalK pointed at the HTTP fake that serves the v2
    notifications ACK, and a stubbed snapshot carrying ``collisionNotices``."""
    from fastapi.testclient import TestClient

    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime, get_signalk
    from tests.fake_anchoralarm import NOTIFICATION_ID, TOKEN, FakeAnchorAlarm

    fake = FakeAnchorAlarm().start()
    runtime = isolated_runtime_at(tmp_path)
    runtime.config.patch({
        "signalk": {"enabled": True, "host": "127.0.0.1", "port": fake.port},
        "credentials": {"signalk": {"token": TOKEN}},
    })
    notices: dict[str, Any] = {}

    class Stub:
        def snapshot(self) -> dict[str, Any]:
            return {"status": "connected", "collisionNotices": notices}

    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_runtime] = lambda: runtime
    app.dependency_overrides[get_signalk] = lambda: Stub()
    try:
        yield TestClient(app), fake, notices, NOTIFICATION_ID
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)
        runtime.close()
        fake.stop()


def test_ack_acknowledges_ours_on_the_server(ack_api) -> None:
    client, fake, notices, nid = ack_api
    notices[A] = {"state": "alarm", "id": nid, "sound": True, "acknowledged": False, "canAcknowledge": True}
    r = client.post("/signalk/collision/ack", json={"ids": [nid]})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "acknowledged": 1}
    assert fake.acknowledged == [nid]
    assert fake.authorizations[-1] == f"Bearer {fake.token}"


def test_ack_sends_nothing_for_ids_that_are_not_ours_or_already_acked(ack_api) -> None:
    client, fake, notices, nid = ack_api
    notices[A] = {"state": "alarm", "id": nid, "sound": False, "acknowledged": True, "canAcknowledge": True}
    other = "11111111-2222-3333-4444-555555555555"  # e.g. the anchor alarm's
    r = client.post("/signalk/collision/ack", json={"ids": [nid, other]})
    assert r.json() == {"ok": True, "acknowledged": 0}
    assert fake.requests == []


def test_ack_rejects_a_malformed_id(ack_api) -> None:
    client, fake, _, _ = ack_api
    assert client.post("/signalk/collision/ack", json={"ids": ["../../plugins"]}).status_code == 422
    assert fake.requests == []


def test_a_refused_ack_is_a_409_in_signalks_words(ack_api) -> None:
    client, _, notices, _ = ack_api
    stranger = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"  # the fake only knows NOTIFICATION_ID
    notices[A] = {"state": "alarm", "id": stranger, "sound": True, "acknowledged": False}
    r = client.post("/signalk/collision/ack", json={"ids": [stranger]})
    assert r.status_code == 409
    assert "Notification not found" in r.json()["detail"]


def test_silence_silences_ours_on_the_server(ack_api) -> None:
    client, fake, notices, nid = ack_api
    notices[A] = {"state": "alarm", "id": nid, "sound": True, "acknowledged": False,
                  "silenced": False, "canSilence": True}
    r = client.post("/signalk/collision/silence", json={"ids": [nid]})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "silenced": 1}
    assert fake.silenced == [nid]
    assert fake.acknowledged == []


def test_silence_skips_already_silenced_or_acked(ack_api) -> None:
    client, fake, notices, nid = ack_api
    notices[A] = {"state": "alarm", "id": nid, "sound": False, "acknowledged": False, "silenced": True}
    assert client.post("/signalk/collision/silence", json={"ids": [nid]}).json() == {"ok": True, "silenced": 0}
    notices[A] = {"state": "alarm", "id": nid, "sound": False, "acknowledged": True, "silenced": False}
    assert client.post("/signalk/collision/silence", json={"ids": [nid]}).json() == {"ok": True, "silenced": 0}
    assert fake.requests == []
