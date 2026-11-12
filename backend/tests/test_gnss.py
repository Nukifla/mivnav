# SPDX-License-Identifier: GPL-2.0-only
"""The server-side GNSS-lost watch: the snapshot's debounced ``fixLost``,
the publisher's raise / refresh / clear decisions, the stream's ping/pong
liveness probe — then once end to end, over real sockets, against the fake
SignalK."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

# Via the model (see test_collision): a slice imported first is a cycle.
from mivnav.config.model import Config, GnssConfig
from mivnav.gnss.publisher import PATH, REFRESH_S, RETRY_S, GnssPublisher, value_for
from mivnav.signalk.service import SignalKService
from tests.conftest import isolated_runtime_at
from tests.fake_signalk import FakeSignalK
from tests.test_collision import Clock, SpyWriter, wait_until
from tests.test_signalk import app_client  # noqa: F401 — a fixture, used by name

# -- the debounce, in the snapshot --------------------------------------------


def _service(after: float | None) -> SignalKService:
    # No URL: no socket. Status and tracker are driven by hand below.
    return SignalKService(None, fix_lost_after=lambda: after)


def _report(service: SignalKService, at: float) -> None:
    service._tracker.apply(json.dumps({"self": "vessels.urn:self"}), at)
    service._tracker.apply(
        json.dumps(
            {
                "context": "vessels.urn:self",
                "updates": [
                    {"values": [{"path": "navigation.position", "value": {"latitude": 1, "longitude": 2}}]}
                ],
            }
        ),
        at,
    )


def test_fix_lost_only_after_the_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    service = _service(5.0)
    service._status = "connected"
    now = [1000.0]
    monkeypatch.setattr("mivnav.signalk.service.time.time", lambda: now[0])
    _report(service, 1000.0)
    now[0] = 1004.9  # a brief dropout: no alarm
    assert "fixLost" not in service.snapshot()
    now[0] = 1005.0
    assert service.snapshot()["fixLost"] is True
    _report(service, 1005.5)  # the fix returns: cleared at once
    now[0] = 1005.6
    assert "fixLost" not in service.snapshot()


def test_never_a_fix_is_never_lost(monkeypatch: pytest.MonkeyPatch) -> None:
    service = _service(5.0)
    service._status = "connected"
    monkeypatch.setattr("mivnav.signalk.service.time.time", lambda: 10_000.0)
    assert "fixLost" not in service.snapshot()


def test_no_gnss_alarm_while_signalk_is_down(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dead link silences the GPS too — that is the link's alarm (the
    screens'), not a GNSS loss."""
    service = _service(5.0)
    monkeypatch.setattr("mivnav.signalk.service.time.time", lambda: 2000.0)
    _report(service, 1000.0)
    service._status = "connecting"
    assert "fixLost" not in service.snapshot()


def test_silence_counts_from_the_reconnect(monkeypatch: pytest.MonkeyPatch) -> None:
    service = _service(5.0)
    now = [1000.0]
    monkeypatch.setattr("mivnav.signalk.service.time.time", lambda: now[0])
    _report(service, 900.0)  # last report before an outage
    service._status = "connecting"
    service._set_status("connected")  # reconnected at 1000
    now[0] = 1003.0
    assert "fixLost" not in service.snapshot()
    now[0] = 1005.0
    assert service.snapshot()["fixLost"] is True


def test_delay_is_config_and_defaults_to_five_seconds() -> None:
    assert GnssConfig().delay_s == 5.0
    assert Config().gnss.mode == "tell"
    with pytest.raises(ValueError):
        GnssConfig(delay_s=0)


# -- the publisher's decisions -------------------------------------------------


@pytest.fixture
def pub(tmp_path: Path) -> tuple[GnssPublisher, SpyWriter, Clock, Any]:
    runtime = isolated_runtime_at(tmp_path)
    runtime.config.patch({"signalk": {"enabled": True}, "credentials": {"signalk": {"token": "tok"}}})
    writer, clock = SpyWriter(), Clock()
    return GnssPublisher(runtime, writer=writer, clock=clock), writer, clock, runtime


def snap(lost: bool = False, status: str = "connected") -> dict[str, Any]:
    out: dict[str, Any] = {"status": status, "self": None, "targets": []}
    if lost:
        out["fixLost"] = True
    return out


def test_clears_a_possible_ghost_once_then_raises_and_clears(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(snap())
    clock.t += 1
    publisher.tick(snap())
    assert writer.values() == [(PATH, "normal")]  # once, for a restart's ghost
    publisher.tick(snap(lost=True))
    clock.t += 1
    publisher.tick(snap(lost=True))
    publisher.tick(snap())
    assert writer.values() == [(PATH, "normal"), (PATH, "alarm"), (PATH, "normal")]
    raised = writer.sent[1][2]["updates"][0]["values"][0]["value"]
    assert raised["method"] == ["visual", "sound"]
    assert "GNSS position lost" in raised["message"]


def test_refreshes_an_active_alarm(pub) -> None:
    publisher, writer, clock, _ = pub
    publisher.tick(snap(lost=True))
    clock.t += REFRESH_S - 1
    publisher.tick(snap(lost=True))
    assert len(writer.values()) == 1
    clock.t += 1
    publisher.tick(snap(lost=True))
    assert writer.values() == [(PATH, "alarm"), (PATH, "alarm")]
    # The age grows: the default 5 s delay, then 30 s more.
    assert writer.sent[1][2]["updates"][0]["values"][0]["value"]["data"]["lostS"] == 35


def test_show_raises_without_sound(pub) -> None:
    publisher, writer, _, runtime = pub
    runtime.config.patch({"gnss": {"mode": "show"}})
    publisher.tick(snap(lost=True))
    assert writer.sent[0][2]["updates"][0]["values"][0]["value"]["method"] == ["visual"]


@pytest.mark.parametrize("patch", [{"mode": "off"}, {"publish": False}])
def test_off_or_unpublished_raises_nothing(pub, patch) -> None:
    publisher, writer, _, runtime = pub
    runtime.config.patch({"gnss": patch})
    publisher.tick(snap(lost=True))
    assert writer.values() == [(PATH, "normal")]


def test_does_nothing_while_disconnected(pub) -> None:
    publisher, writer, _, _ = pub
    publisher.tick(snap(lost=True, status="connecting"))
    assert writer.values() == []


def test_a_failed_raise_is_retried_after_the_backoff(pub) -> None:
    publisher, writer, clock, _ = pub
    writer.fail = True
    publisher.tick(snap(lost=True))
    writer.fail = False
    clock.t += RETRY_S - 1
    publisher.tick(snap(lost=True))
    assert writer.values() == []
    clock.t += 1
    publisher.tick(snap(lost=True))
    assert writer.values() == [(PATH, "alarm")]


def test_a_failed_courtesy_clear_is_not_retried(pub) -> None:
    """No write access is a normal boat: no warning, no retry loop."""
    publisher, writer, clock, _ = pub
    writer.fail = True
    publisher.tick(snap())
    writer.fail = False
    clock.t += 1
    publisher.tick(snap())
    assert writer.values() == []


def test_value_for_clear() -> None:
    assert value_for(None)["state"] == "normal"


# -- the stream's liveness probe ---------------------------------------------


def test_stream_answers_ping_with_pong(app_client: Any) -> None:  # noqa: F811
    client, _ = app_client
    with client.websocket_connect("/signalk/stream") as ws:
        first = json.loads(ws.receive_text())
        assert first["gnssSettings"] == GnssConfig().model_dump(mode="json")
        ws.send_text("ping")
        assert ws.receive_text() == "pong"


# -- end to end ----------------------------------------------------------------


def test_end_to_end_over_real_sockets(tmp_path: Path) -> None:
    """Fake SignalK → the real service → the real publisher → a delta on the
    fake, once the own ship has been silent for the (shortened) delay."""
    fake = FakeSignalK().start()
    runtime = isolated_runtime_at(tmp_path)
    publisher = GnssPublisher(runtime, tick_s=0.05)
    try:
        runtime.config.patch(
            {
                "signalk": {"enabled": True, "host": "127.0.0.1", "port": fake.port},
                "credentials": {"signalk": {"token": "tok"}},
                "gnss": {"delay_s": 1},
            }
        )
        publisher.start()
        fake.wait_sessions(1)
        fake.broadcast(
            fake.delta([("navigation.position", {"latitude": 0.0, "longitude": 0.0})], vessel=fake.self_id)
        )

        def gnss_writes() -> list[dict[str, Any]]:
            return [
                v["value"]
                for m in fake.subscriptions
                if isinstance(m, dict) and "updates" in m
                for u in m["updates"]
                for v in u["values"]
                if v["path"] == PATH
            ]

        started = time.monotonic()
        wait_until(lambda: any(v["state"] == "alarm" for v in gnss_writes()))
        assert time.monotonic() - started >= 0.9  # not before the delay
        assert runtime.signalk().snapshot()["fixLost"] is True
        fake.broadcast(
            fake.delta([("navigation.position", {"latitude": 0.0, "longitude": 0.0})], vessel=fake.self_id)
        )
        wait_until(lambda: gnss_writes()[-1]["state"] == "normal")
    finally:
        publisher.stop()
        runtime.close()
        fake.stop()
