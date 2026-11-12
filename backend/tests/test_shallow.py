# SPDX-License-Identifier: GPL-2.0-only
"""The server-side shallow-water watch: which depth, which threshold, the
debounce that keeps a noisy sounder from flapping, the SignalK notification
and its echo, the publisher's decisions, and the ACK/silence endpoints."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from mivnav.api.deps import build_signalk_service
# Via the model: a config slice imported before `mivnav.config` is a cycle.
from mivnav.config.model import Config, ShallowConfig, SignalKConfig
from mivnav.collision.notices import reduce_echo
from mivnav.collision.publisher import MUTE_S, REFRESH_S
from mivnav.shallow.notices import PATH, ShallowNoticeState, value_for
from mivnav.shallow.publisher import ShallowPublisher
from mivnav.shallow.watch import CLEAR_S, RAISE_S, ShallowWatch, reading, threshold
from mivnav.signalk.model import VesselTracker
from tests.conftest import isolated_runtime_at
from tests.test_collision import Clock, SpyWriter


def own(**fields: Any) -> dict[str, Any]:
    return {"id": "urn:self", "lat": 55.0, "lng": 12.0, **fields}


def snap(**fields: Any) -> dict[str, Any]:
    return {"status": "connected", "self": own(**fields), "targets": []}


# -- which depth, which threshold ---------------------------------------------


def test_threshold_is_the_setting_default_3m() -> None:
    assert threshold(ShallowConfig(depth_m=4.0)) == 4.0
    assert threshold(ShallowConfig()) == 3.0


def test_reading_prefers_surface_then_transducer_then_keel_plus_draft() -> None:
    both = own(depthBelowSurfaceM=5.0, depthBelowTransducerM=4.5, depthBelowKeelM=3.0, draftM=2.0)
    assert reading(both) == (5.0, "surface")
    assert reading(own(depthBelowTransducerM=4.5)) == (4.5, "transducer")
    assert reading(own(depthBelowKeelM=3.0, draftM=2.0)) == (5.0, "keel")
    # Clearance without a draft is not a depth below the surface.
    assert reading(own(depthBelowKeelM=3.0)) is None


def test_a_stale_reading_is_no_reading() -> None:
    stale = own(depthBelowSurfaceM=5.0, depthBelowTransducerM=4.5, stale={"depthBelowSurfaceM": 10})
    assert reading(stale) == (4.5, "transducer")
    assert reading(own(depthBelowTransducerM=1.0, stale={"depthBelowTransducerM": 30})) is None


# -- the debounce ----------------------------------------------------------------


def run(watch: ShallowWatch, depth: float, start: float, seconds: float, cfg=ShallowConfig()) -> tuple[float, dict]:
    """Feed one depth at the snapshot rate (5 Hz) for ``seconds``."""
    t, out = start, {}
    while t < start + seconds:
        out = watch(snap(depthBelowSurfaceM=depth), cfg, t)
        t += 0.2
    return t, out


def test_raises_only_after_staying_shallow_and_clears_only_past_the_hysteresis() -> None:
    w = ShallowWatch()
    t, out = run(w, 10.0, 0, 10)
    assert out["active"] is False and out["thresholdM"] == 3.0
    t, out = run(w, 2.0, t, 3.0)  # the median turns after ~2.5 s, then RAISE_S
    assert out["active"] is False
    t, out = run(w, 2.0, t, RAISE_S + 1)
    assert out["active"] is True and out["depthM"] == 2.0
    # Back over the line but inside the hysteresis band: stays up.
    t, out = run(w, 3.0 + 0.3, t, 30)
    assert out["active"] is True
    # Clearly deep, but not yet for CLEAR_S.
    t, out = run(w, 10.0, t, 5)
    assert out["active"] is True
    t, out = run(w, 10.0, t, CLEAR_S)
    assert out["active"] is False


def test_single_spikes_never_raise() -> None:
    w = ShallowWatch()
    t = 0.0
    for _ in range(60):  # 10 m water with a 1-second 0.4 m spike every 3 s
        t, out = run(w, 10.0, t, 2)
        t, out = run(w, 0.4, t, 1)
        assert out["active"] is False


def test_a_sounder_that_drops_out_clears_the_alarm() -> None:
    w = ShallowWatch()
    t, _ = run(w, 1.0, 0, 10)
    assert w.active
    assert w(snap(depthBelowSurfaceM=1.0, stale={"depthBelowSurfaceM": 10}), ShallowConfig(), t) is None
    assert not w.active


def test_threshold_ignores_the_boats_draft() -> None:
    w = ShallowWatch()
    out = w(snap(depthBelowSurfaceM=4.0, draftM=2.1), ShallowConfig(depth_m=2.5), 0)
    assert out["thresholdM"] == 2.5


def test_the_snapshot_carries_the_assessment_and_the_settings() -> None:
    service = build_signalk_service(SignalKConfig(enabled=False), shallow=lambda: ShallowConfig(depth_m=2))
    try:
        extend = service._extend
        out = extend(snap(depthBelowTransducerM=6.0))
        assert out["shallowSettings"]["depth_m"] == 2
        assert out["shallow"]["source"] == "transducer"
        assert "collisionSettings" not in out
        assert "shallow" not in extend({"status": "connected", "self": None, "targets": []})
    finally:
        service.close()


# -- the notification and its echo ----------------------------------------------


ACTIVE = {"depthM": 2.1, "source": "surface", "thresholdM": 3.0, "active": True}


def test_value_for_sounds_unless_quiet() -> None:
    v = value_for(ACTIVE)
    assert v["state"] == "alarm" and "sound" in v["method"]
    assert v["message"] == "Shallow water: 2.1 m below surface — alarm under 3.0 m"
    assert v["data"]["publisher"] == "mivnav"
    assert "sound" not in value_for(ACTIVE, quiet=True)["method"]
    assert value_for(None)["state"] == "normal"


def echo(**status: Any) -> dict[str, Any]:
    return {**value_for(ACTIVE), "id": "abc-1", "status": {"canAcknowledge": True, "canSilence": True, **status}}


def test_tracker_carries_our_echo_and_ignores_someone_elses() -> None:
    tracker = VesselTracker()
    tracker.apply(json.dumps({"self": "vessels.urn:self"}), 0)

    def send(value: Any) -> None:
        delta = {"context": "vessels.urn:self", "updates": [{"values": [{"path": PATH, "value": value}]}]}
        tracker.apply(json.dumps(delta), 0)

    send(echo())
    assert tracker.snapshot(0, 600)["shallowNotice"] == reduce_echo(echo())
    send({"state": "alarm", "method": ["sound"], "message": "zones"})
    assert tracker.snapshot(0, 600)["shallowNotice"]["id"] == "abc-1"
    send(value_for(None))
    assert "shallowNotice" not in tracker.snapshot(0, 600)


def test_notice_state_only_reads_its_own_path() -> None:
    state = ShallowNoticeState()
    state.apply("notifications.environment.depth.belowKeel", echo())
    assert state.snapshot() is None


# -- the publisher ---------------------------------------------------------------


@pytest.fixture
def pub(tmp_path: Path):
    runtime = isolated_runtime_at(tmp_path)
    runtime.config.patch({"signalk": {"enabled": True}, "credentials": {"signalk": {"token": "tok"}}})
    writer, clock = SpyWriter(), Clock()
    yield ShallowPublisher(runtime, writer=writer, clock=clock), writer, clock, runtime
    runtime.close()


def assessed(active: bool = True, **extra: Any) -> dict[str, Any]:
    return {"status": "connected", "shallow": {**ACTIVE, "active": active}, **extra}


def test_raises_once_refreshes_and_clears(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(assessed())
    clock.t += 1
    publisher.tick(assessed())
    assert writer.values() == [(PATH, "alarm")]
    assert writer.sent[0][1] == "tok"
    clock.t += REFRESH_S
    publisher.tick(assessed())
    assert writer.values() == [(PATH, "alarm")] * 2
    clock.t += 1
    publisher.tick(assessed(active=False))
    publisher.tick(assessed(active=False))
    assert writer.values()[-1] == (PATH, "normal") and len(writer.values()) == 3


def test_mode_off_and_publish_off_raise_nothing(pub) -> None:
    publisher, writer, clock, runtime = pub
    runtime.config.patch({"shallow": {"mode": "off"}})
    publisher.tick(assessed())
    runtime.config.patch({"shallow": {"mode": "tell", "publish": False}})
    publisher.tick(assessed())
    assert writer.values() == []


def test_show_is_silent_and_a_flip_re_sends(pub) -> None:
    publisher, writer, clock, runtime = pub
    runtime.config.patch({"shallow": {"mode": "show"}})
    publisher.tick(assessed())
    runtime.config.patch({"shallow": {"mode": "tell"}})
    clock.t += 1
    publisher.tick(assessed())
    methods = [v["value"]["method"] for _, _, d in writer.sent for u in d["updates"] for v in u["values"]]
    assert methods == [["visual"], ["visual", "sound"]]


def test_clears_a_ghost_left_by_a_restart(pub) -> None:
    publisher, writer, _, _ = pub
    publisher.tick(assessed(active=False, shallowNotice=reduce_echo(echo())))
    assert writer.values() == [(PATH, "normal")]


def test_a_mute_is_re_armed_after_two_minutes(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(assessed())
    muted = reduce_echo(echo(silenced=True))
    clock.t += 1
    publisher.tick(assessed(shallowNotice=muted))
    clock.t += MUTE_S
    publisher.tick(assessed(shallowNotice=muted))
    assert writer.values()[-1] == (PATH, "warn")
    clock.t += 1
    publisher.tick(assessed(shallowNotice=muted))
    assert writer.values()[-1] == (PATH, "alarm")


def test_does_nothing_while_disconnected(pub) -> None:
    publisher, writer, _, _ = pub
    publisher.tick({**assessed(), "status": "connecting"})
    assert writer.values() == []


def test_config_model_has_the_shallow_slice() -> None:
    assert Config().shallow == ShallowConfig()


# -- ACK / silence on the SignalK server ------------------------------------------


@pytest.fixture
def ack_api(tmp_path: Path):
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
    holder: dict[str, Any] = {}

    class Stub:
        def snapshot(self) -> dict[str, Any]:
            return {"status": "connected", **holder}

    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_runtime] = lambda: runtime
    app.dependency_overrides[get_signalk] = lambda: Stub()
    try:
        yield TestClient(app), fake, holder, NOTIFICATION_ID
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)
        runtime.close()
        fake.stop()


def test_ack_and_silence_reach_the_server_for_our_notice_only(ack_api) -> None:
    client, fake, holder, nid = ack_api
    holder["shallowNotice"] = {"state": "alarm", "id": nid, "sound": True, "acknowledged": False,
                               "canAcknowledge": True, "silenced": False, "canSilence": True}
    # A collision id is not a shallow one.
    holder["collisionNotices"] = {"x": {"state": "alarm", "id": "other-1", "acknowledged": False}}
    assert client.post("/signalk/shallow/silence", json={"ids": [nid]}).json() == {"ok": True, "silenced": 1}
    assert client.post("/signalk/shallow/ack", json={"ids": ["other-1"]}).json() == {"ok": True, "acknowledged": 0}
    assert client.post("/signalk/shallow/ack", json={"ids": [nid]}).json() == {"ok": True, "acknowledged": 1}
    assert fake.silenced == [nid] and fake.acknowledged == [nid]
