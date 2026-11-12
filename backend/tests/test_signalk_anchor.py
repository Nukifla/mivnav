# SPDX-License-Identifier: GPL-2.0-only
"""The anchoralarm plugin's state, as the tracker folds it (anchor.md)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from mivnav.signalk import VesselTracker
from tests.fake_signalk import SELF_ID

#: The plugin's live notification, as measured on the boat 2026-10-21.
NORMAL = {
    "state": "normal",
    "method": ["visual", "sound"],
    "message": "Anchor Alarm - Normal",
    "id": "9d6e9d73-e919-40c3-8802-58351d896e8b",
    "status": {"silenced": False, "acknowledged": False, "canSilence": True,
               "canAcknowledge": True, "canClear": False},
}


def _tracker() -> VesselTracker:
    t = VesselTracker()
    t.apply(json.dumps({"self": f"vessels.{SELF_ID}"}), now=0.0)
    return t


def _send(t: VesselTracker, source: str, values: list[dict[str, Any]], context: str = SELF_ID) -> None:
    t.apply(json.dumps({"context": f"vessels.{context}",
                        "updates": [{"$source": source, "values": values}]}), now=0.0)


def _anchor(t: VesselTracker) -> dict[str, Any] | None:
    return t.snapshot(now=0.0, ttl=600.0).get("anchor")


def test_no_anchor_key_until_the_plugin_speaks() -> None:
    assert "anchor" not in _tracker().snapshot(now=0.0, ttl=600.0)


def test_a_raised_anchor_is_present_without_a_position() -> None:
    t = _tracker()
    _send(t, "anchoralarm", [
        {"path": "navigation.anchor.position", "value": None},
        {"path": "navigation.anchor.maxRadius", "value": None},
        {"path": "navigation.anchor.fudgeFactor", "value": 0},
        {"path": "notifications.navigation.anchor", "value": NORMAL},
    ])
    assert _anchor(t) == {
        "fudgeM": 0.0,
        "alarm": {"state": "normal", "message": "Anchor Alarm - Normal",
                  "id": NORMAL["id"], "sound": True, "acknowledged": False,
                  "canAcknowledge": True},
    }


def test_a_dropped_anchor_carries_its_watch() -> None:
    t = _tracker()
    _send(t, "anchoralarm", [
        {"path": "navigation.anchor.position",
         "value": {"latitude": 55.9, "longitude": 12.6, "altitude": -4.5}},
        {"path": "navigation.anchor.maxRadius", "value": 40},
        {"path": "navigation.anchor.currentRadius", "value": 12.5},
        {"path": "navigation.anchor.bearingTrue", "value": 3.141592653589793},
        {"path": "navigation.anchor.rodeLength", "value": 30},
    ])
    a = _anchor(t)
    assert a is not None
    assert (a["lat"], a["lng"], a["maxRadiusM"], a["currentRadiusM"], a["rodeLengthM"]) == (
        55.9, 12.6, 40.0, 12.5, 30.0)
    assert a["bearingTrueDeg"] == pytest.approx(180.0)


def test_raising_drops_everything_measured_against_the_anchor() -> None:
    t = _tracker()
    _send(t, "anchoralarm", [
        {"path": "navigation.anchor.position", "value": {"latitude": 55.9, "longitude": 12.6}},
        {"path": "navigation.anchor.currentRadius", "value": 12.5},
    ])
    _send(t, "anchoralarm", [{"path": "navigation.anchor.position", "value": None}])
    a = _anchor(t)
    assert a is not None and "lat" not in a and "currentRadiusM" not in a


def test_the_n2k_echo_of_the_alarm_is_ignored() -> None:
    """Measured on the boat: the N2K emitter's stale `emergency` sits beside
    the plugin's live `normal` on the same path. Only the plugin counts."""
    t = _tracker()
    _send(t, "anchoralarm", [{"path": "notifications.navigation.anchor", "value": NORMAL}])
    _send(t, "signalk-nmea2000-emitter-cannon", [
        {"path": "notifications.navigation.anchor",
         "value": {**NORMAL, "state": "emergency", "message": "Anchor Alarm - Emergency"}},
    ])
    a = _anchor(t)
    assert a is not None and a["alarm"]["state"] == "normal"


def test_an_acknowledged_emergency_is_shown_but_quiet() -> None:
    t = _tracker()
    _send(t, "anchoralarm", [{"path": "notifications.navigation.anchor", "value": {
        **NORMAL, "state": "emergency", "method": ["visual"],
        "status": {**NORMAL["status"], "acknowledged": True, "canAcknowledge": True}}}])
    a = _anchor(t)
    assert a is not None
    assert a["alarm"]["state"] == "emergency" and a["alarm"]["sound"] is False
    assert a["alarm"]["acknowledged"] is True


def test_another_vessels_anchor_is_not_ours() -> None:
    t = _tracker()
    _send(t, "anchoralarm", [{"path": "navigation.anchor.maxRadius", "value": 40}],
          context="urn:mrn:imo:mmsi:211000001")
    assert _anchor(t) is None


def test_an_anchor_object_delivered_whole_is_walked() -> None:
    t = _tracker()
    _send(t, "anchoralarm", [{"path": "navigation.anchor", "value": {
        "position": {"latitude": 55.9, "longitude": 12.6}, "maxRadius": 40}}])
    a = _anchor(t)
    assert a is not None and a["lat"] == 55.9 and a["maxRadiusM"] == 40.0


def test_the_subscription_asks_for_the_anchor_paths() -> None:
    from mivnav.signalk.service import SUBSCRIPTION

    paths = {s["path"] for s in SUBSCRIPTION["subscribe"]}
    assert {"navigation.anchor.position", "navigation.anchor.maxRadius",
            "notifications.navigation.anchor"} <= paths


def _fix(t: VesselTracker, lat: float, lng: float, now: float) -> None:
    t.apply(json.dumps({"context": f"vessels.{SELF_ID}", "updates": [{"values": [
        {"path": "navigation.position", "value": {"latitude": lat, "longitude": lng}}]}]}), now=now)


def test_the_swing_track_is_recorded_only_while_anchored_every_ten_seconds() -> None:
    t = _tracker()
    _fix(t, 55.9, 12.6, now=0.0)
    assert t.anchor_track() == []  # anchor up: nothing kept
    _send(t, "anchoralarm", [{"path": "navigation.anchor.position",
                              "value": {"latitude": 55.9, "longitude": 12.6}}])
    # The drop message itself records where the boat is (any own-ship
    # message offers the current fix), so the track starts at the drop.
    _fix(t, 55.9002, 12.6, now=5.0)  # < 10 s after the last kept: skipped
    _fix(t, 55.9003, 12.6, now=11.5)
    assert t.anchor_track() == [[12.6, 55.9, 0.0], [12.6, 55.9003, 11500.0]]


def test_a_new_anchor_position_starts_a_new_track_and_raising_clears_it() -> None:
    t = _tracker()
    _send(t, "anchoralarm", [{"path": "navigation.anchor.position",
                              "value": {"latitude": 55.9, "longitude": 12.6}}])
    _fix(t, 55.9001, 12.6, now=1.0)
    assert len(t.anchor_track()) == 1
    _send(t, "anchoralarm", [{"path": "navigation.anchor.position",
                              "value": {"latitude": 55.95, "longitude": 12.6}}])
    _fix(t, 55.9501, 12.6, now=20.0)
    assert t.anchor_track() == [[12.6, 55.9001, 0.0], [12.6, 55.9501, 20000.0]]
    _send(t, "anchoralarm", [{"path": "navigation.anchor.position", "value": None}])
    assert t.anchor_track() == []


def test_the_bow_offset_comes_from_any_source() -> None:
    t = _tracker()
    _send(t, "anchoralarm", [{"path": "navigation.anchor.maxRadius", "value": 40}])
    _send(t, "defaults", [{"path": "sensors.gps.fromBow", "value": 5.5}])
    a = _anchor(t)
    assert a is not None and a["gpsFromBowM"] == 5.5
