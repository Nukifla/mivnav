# SPDX-License-Identifier: GPL-2.0-only
"""The autopilot: unknown-is-not-off, and a command that fails loudly.

This thing steers a boat, so the claims worth proving are mostly negative
— what the code must *never* do:

- never let "we have no idea" be read as "it is disengaged";
- never queue, retry, or silently swallow a steering command;
- never report success the device did not report;
- never blur "the boat said no" into "we could not ask".

The state half is driven through the real fake SignalK server, so the
subscription and the fan-out are exercised rather than assumed; the
command half through a real fake v2 Autopilot API over loopback (see
tests/fake_autopilot.py for how faithful it is, and to what).
"""

from __future__ import annotations

import json
import math
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mivnav.autopilot import AutopilotState
from mivnav.features.autopilot.client import (
    AutopilotClient,
    AutopilotRefused,
    AutopilotUnauthorized,
    AutopilotUnavailable,
    AutopilotUnreachable,
)
from mivnav.signalk import SignalKService, VesselTracker
from tests.conftest import isolated_runtime_at
from tests.fake_autopilot import TOKEN, FakeAutopilot
from tests.fake_signalk import SELF_ID, FakeSignalK
from tests.test_signalk import wait_until


@pytest.fixture
def pilot():
    fake = FakeAutopilot().start()
    yield fake
    fake.stop()


def client_for(pilot: FakeAutopilot, token: str | None = TOKEN) -> AutopilotClient:
    return AutopilotClient(pilot.base_url, token)


@pytest.fixture
def api(tmp_path: Path):
    """``api(pilot, token) -> TestClient``, wired through the *real* config.

    The whole graph resolves from a throwaway config store, so a test
    exercises the credential lookup and the URL derivation rather than
    stubbing past them — which is the half most likely to be wrong.
    """
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    # Restore whatever override was there before (the session `client`
    # fixture's own, set by conftest.py's autouse `isolated_runtime`) rather
    # than popping unconditionally — an unconditional pop strands every
    # later test with no get_runtime override at all (same bug class as
    # vyvqpxmn; see test_datasets_api.py's `dc` fixture).
    previous = app.dependency_overrides.get(get_runtime)
    runtimes = []

    def build(pilot: FakeAutopilot | None = None, token: str | None = None) -> TestClient:
        runtime = isolated_runtime_at(tmp_path)
        runtimes.append(runtime)
        patch: dict[str, Any] = {}
        if pilot is not None:
            # isolated_runtime_at leaves signalk disabled; a test that wants
            # a pilot turns it on and points it at its own fake.
            patch["signalk"] = {"enabled": True, "host": "127.0.0.1", "port": pilot.port}
        if token is not None:
            patch["credentials"] = {"signalk": {"token": token}}
        if patch:
            runtime.config.patch(patch)
        app.dependency_overrides[get_runtime] = lambda: runtime
        return TestClient(app)

    build.runtime = lambda: runtimes[-1]  # type: ignore[attr-defined]
    yield build
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous
    for runtime in runtimes:
        runtime.close()


@pytest.fixture
def engage_client():
    """``engage_client(pilot, signalk) -> TestClient``, wiring
    ``/autopilot/engage``'s two dependencies directly rather than through a
    config-derived Runtime — the seam the bearing-mode-seeds-the-target
    behaviour actually lives at (mivnav.features.autopilot.routes.engage)."""
    from mivnav.api.app import app
    from mivnav.api.deps import get_signalk
    from mivnav.features.autopilot.routes import get_autopilot

    services: list[SignalKService] = []

    def build(pilot: FakeAutopilot, signalk: SignalKService) -> TestClient:
        services.append(signalk)
        app.dependency_overrides[get_autopilot] = lambda: client_for(pilot)
        app.dependency_overrides[get_signalk] = lambda: signalk
        return TestClient(app)

    yield build
    app.dependency_overrides.pop(get_autopilot, None)
    app.dependency_overrides.pop(get_signalk, None)
    for signalk in services:
        signalk.close()


def _signalk_with_cog(cog_deg: float | None, *, has_fix: bool = True) -> SignalKService:
    """A live ``SignalKService`` whose own ship has (or lacks) a position
    fix and a COG, applied straight to the tracker like
    tests/test_search_api.py does — no socket needed to prove what the
    route does with a snapshot."""
    signalk = SignalKService(None)
    now = time.time()
    signalk._tracker.apply(json.dumps({"self": f"vessels.{SELF_ID}"}), now)
    values: list[dict[str, Any]] = []
    if has_fix:
        values.append({"path": "navigation.position", "value": {"latitude": 50.0, "longitude": -1.0}})
    if cog_deg is not None:
        values.append({"path": "navigation.courseOverGroundTrue", "value": math.radians(cog_deg)})
    if values:
        signalk._tracker.apply(json.dumps({"updates": [{"values": values}]}), now)
    return signalk


# -- the state rules (pure) ------------------------------------------------


def test_nothing_heard_is_none_not_a_disengaged_pilot() -> None:
    # The whole module in one assertion. An empty object with engaged=False
    # would be a lie a UI would render as a green "OFF" badge.
    assert AutopilotState().snapshot() is None


def test_a_field_never_reported_is_absent_not_false() -> None:
    state = AutopilotState()
    state.apply("steering.autopilot.mode", "compass")
    snapshot = state.snapshot()
    assert snapshot == {"mode": "compass"}
    # Not `is False`: the key must not be there at all, so a client cannot
    # read a default we invented.
    assert "engaged" not in snapshot


def test_engaged_false_is_reported_because_the_pilot_said_so() -> None:
    state = AutopilotState()
    state.apply("steering.autopilot.engaged", False)
    assert state.snapshot() == {"engaged": False}


def test_angles_arrive_in_radians_and_leave_in_degrees() -> None:
    state = AutopilotState()
    state.apply("steering.autopilot.target", math.pi / 2)
    state.apply("steering.rudderAngle", -math.pi / 18)
    snapshot = state.snapshot()
    assert snapshot["targetDeg"] == pytest.approx(90.0)
    assert snapshot["rudderAngleDeg"] == pytest.approx(-10.0)


def test_the_whole_pilot_folds() -> None:
    state = AutopilotState()
    for path, value in (
        ("steering.autopilot.state", "enabled"),
        ("steering.autopilot.mode", "gps"),
        ("steering.autopilot.engaged", True),
        ("steering.autopilot.target", 0.8901179185171081),
        ("steering.autopilot.defaultPilot", "pypilot-sk"),
        ("steering.autopilot.availableActions", ["tack"]),
        ("steering.rudderAngle", 0.024085543677521744),
    ):
        state.apply(path, value)
    snapshot = state.snapshot()
    assert snapshot["state"] == "enabled"
    assert snapshot["mode"] == "gps"
    assert snapshot["engaged"] is True
    assert snapshot["defaultPilot"] == "pypilot-sk"
    assert snapshot["availableActions"] == ["tack"]
    assert snapshot["targetDeg"] == pytest.approx(51.0, abs=0.1)
    assert snapshot["rudderAngleDeg"] == pytest.approx(1.38, abs=0.01)


def test_a_nested_object_folds_the_same_as_a_leaf_delta() -> None:
    # The `{"path": ""}` subscription delivers a subtree as one object; a
    # filter on "steering." prefixes would miss it entirely.
    state = AutopilotState()
    state.apply("", {"steering": {"autopilot": {"state": "enabled"}, "rudderAngle": 0.0}})
    assert state.snapshot() == {"state": "enabled", "rudderAngleDeg": 0.0}


def test_a_known_path_is_never_walked_as_a_subtree() -> None:
    # The boat carries `steering.autopilot.target.headingTrue` from a
    # different, staler source than the scalar `target`. Reading it would
    # mean preferring the wrong source — and in wind modes, a wind angle
    # would silently become a "heading".
    state = AutopilotState()
    state.apply("steering.autopilot.target", math.pi / 2)
    state.apply("steering.autopilot.target.headingTrue", 1.4852751934471744)
    assert state.snapshot()["targetDeg"] == pytest.approx(90.0)


def test_rubbish_on_the_wire_is_dropped_not_believed() -> None:
    state = AutopilotState()
    for path, value in (
        ("steering.autopilot.engaged", 1),  # an int is not a boolean answer
        ("steering.autopilot.target", True),  # a bool is not a target
        ("steering.autopilot.state", "   "),  # blank is absent, not a state
        ("steering.autopilot.availableActions", [1, 2]),
    ):
        state.apply(path, value)
    assert state.snapshot() is None


# -- the state rules, through the tracker ----------------------------------


def test_the_autopilot_is_only_read_from_the_own_ship() -> None:
    tracker = VesselTracker()
    tracker.apply(_hello(), 0.0)
    tracker.apply(_delta("urn:mrn:imo:mmsi:265123456", "steering.autopilot.engaged", True), 0.0)
    assert tracker.snapshot(0.0, 600.0)["autopilot"] is None
    tracker.apply(_delta(SELF_ID, "steering.autopilot.engaged", True), 0.0)
    assert tracker.snapshot(0.0, 600.0)["autopilot"] == {"engaged": True}


def test_the_autopilot_survives_the_gps_losing_its_fix() -> None:
    # `self` is None until there is a position. An autopilot that vanished
    # from every screen because the sky went away would be the worst
    # possible moment to lose it.
    tracker = VesselTracker()
    tracker.apply(_hello(), 0.0)
    tracker.apply(_delta(SELF_ID, "steering.autopilot.engaged", True), 0.0)
    snapshot = tracker.snapshot(0.0, 600.0)
    assert snapshot["self"] is None
    assert snapshot["autopilot"] == {"engaged": True}


# -- the state rules, through the socket -----------------------------------


def test_the_pilot_reaches_a_subscriber_over_the_real_stream() -> None:
    fake = FakeSignalK().start()
    try:
        service = SignalKService(fake.url, broadcast_interval=0.01)
        try:
            wait_until(lambda: service.snapshot()["status"] == "connected")
            fake.broadcast(
                fake.delta(
                    [
                        ("steering.autopilot.state", "enabled"),
                        ("steering.autopilot.engaged", True),
                        ("steering.autopilot.target", math.pi / 2),
                    ]
                )
            )
            wait_until(lambda: service.snapshot()["autopilot"] is not None)
            pilot = service.snapshot()["autopilot"]
            assert pilot["engaged"] is True
            assert pilot["targetDeg"] == pytest.approx(90.0)
            # And we actually asked for it upstream — a path we fold but
            # never subscribe to would work in this test and never arrive
            # on the boat.
            paths = {entry["path"] for entry in fake.subscriptions[0]["subscribe"]}
            assert "steering.autopilot.engaged" in paths
            assert "steering.rudderAngle" in paths
        finally:
            service.close()
    finally:
        fake.stop()


def test_a_disconnected_service_reports_no_pilot() -> None:
    # `enabled: false` is a live state: status off, and — the point — an
    # autopilot of None rather than a disengaged one.
    service = SignalKService(None)
    try:
        snapshot = service.snapshot()
        assert snapshot["status"] == "off"
        assert snapshot["autopilot"] is None
    finally:
        service.close()


# -- commands: the happy path ----------------------------------------------


def test_engage_and_disengage_reach_the_pilot(pilot: FakeAutopilot) -> None:
    client = client_for(pilot)
    assert client.engage() == {"state": "COMPLETED", "statusCode": 200}
    assert pilot.engaged is True
    assert client.disengage()["state"] == "COMPLETED"
    assert pilot.engaged is False


def test_a_target_is_sent_in_radians(pilot: FakeAutopilot) -> None:
    # The units bug this would be: 90 sent as 90 would ask a boat to turn
    # 5157 degrees. The wire is radians; our API is degrees.
    client_for(pilot).set_target(90.0)
    assert pilot.target == pytest.approx(math.pi / 2)
    _, _, body = pilot.requests[-1]
    assert body == {"value": pytest.approx(math.pi / 2)}


def test_adjust_is_applied_by_the_device_to_its_own_target(pilot: FakeAutopilot) -> None:
    pilot.target = 0.0
    client_for(pilot).adjust_target(10.0)
    assert pilot.target == pytest.approx(math.radians(10.0))
    assert pilot.requests[-1][1].endswith("/target/adjust")


def test_set_mode_and_state_use_the_devices_own_vocabulary(pilot: FakeAutopilot) -> None:
    client = client_for(pilot)
    assert client.set_mode("wind")["state"] == "COMPLETED"
    assert pilot.mode == "wind"
    assert client.set_state("enabled")["state"] == "COMPLETED"
    assert pilot.state == "enabled"


def test_tack_posts_to_the_split_path_with_no_body(pilot: FakeAutopilot) -> None:
    # The v2 shape is a POST per direction (…/tack/port), not a PUT {value}
    # — the direction is the route. A body would be a different, wrong
    # request, so its absence is asserted.
    client = client_for(pilot)
    assert client.tack("port")["state"] == "COMPLETED"
    assert pilot.tacked == "port"
    method, path, body = pilot.requests[-1]
    assert method == "POST"
    assert path.endswith("/tack/port")
    assert body is None
    assert client.tack("starboard")["state"] == "COMPLETED"
    assert pilot.tacked == "starboard"


def test_gybe_posts_to_the_split_path(pilot: FakeAutopilot) -> None:
    assert client_for(pilot).gybe("starboard")["state"] == "COMPLETED"
    assert pilot.gybed == "starboard"
    assert pilot.requests[-1][1].endswith("/gybe/starboard")


def test_dodge_enters_steers_in_radians_and_leaves(pilot: FakeAutopilot) -> None:
    # Enter (POST), steer a relative angle (PUT, radians), leave (DELETE) —
    # the three verbs the API documents, in the units the wire uses.
    client = client_for(pilot)
    assert client.start_dodge()["state"] == "COMPLETED"
    assert pilot.dodging is True
    assert pilot.requests[-1][0] == "POST"
    client.dodge(10.0)
    assert pilot.dodge == pytest.approx(math.radians(10.0))
    assert pilot.requests[-1][0] == "PUT"
    assert client.stop_dodge()["state"] == "COMPLETED"
    assert pilot.dodging is False
    assert pilot.requests[-1][0] == "DELETE"


def test_info_carries_the_devices_options_and_normalised_units(pilot: FakeAutopilot) -> None:
    info = client_for(pilot).info()
    # The capability payload the stream cannot carry, passed through as the
    # device stated it — this is what keeps us a conduit.
    assert info["options"]["modes"] == ["compass", "gps", "nav", "wind", "true wind"]
    assert {s["name"] for s in info["options"]["states"]} == {"enabled", "disabled"}
    # Radians in, degrees out. One unit system leaves this app.
    assert info["targetDeg"] == pytest.approx(51.0, abs=0.1)
    assert "target" not in info


def test_reading_needs_no_token_because_the_boat_allows_anonymous_reads(
    pilot: FakeAutopilot,
) -> None:
    # Not a hypothetical: the boat's server reports readOnlyAccess: true
    # with authenticationRequired: true, which is exactly why the delta
    # stream has no credential and did not need one adding — and why a
    # capability GET must not be gated behind one either.
    info = client_for(pilot, token=None).info()
    assert info["options"]["modes"] == ["compass", "gps", "nav", "wind", "true wind"]


# -- commands: every way they can fail -------------------------------------


def test_a_command_without_a_token_says_which_problem_it_is(pilot: FakeAutopilot) -> None:
    # Deliberately not vetoed locally: whether a request needs a token is
    # the server's policy, so we ask and let it answer. What matters is
    # that its 401 becomes the *actionable* error — "configure a token" —
    # and not "your token is wrong", which would send a user hunting for a
    # token they never had.
    with pytest.raises(AutopilotUnavailable) as e:
        client_for(pilot, token=None).engage()
    assert "credentials.signalk.token" in str(e.value)
    assert pilot.engaged is False


def test_a_command_with_signalk_disabled_fails_with_a_reason() -> None:
    with pytest.raises(AutopilotUnavailable) as e:
        AutopilotClient(None, TOKEN).engage()
    assert "disabled" in str(e.value)


def test_a_rejected_token_is_our_fault_and_says_so(pilot: FakeAutopilot) -> None:
    with pytest.raises(AutopilotUnauthorized):
        client_for(pilot, token="wrong").engage()
    assert pilot.engaged is False


def test_a_dead_server_fails_fast_and_does_not_queue(pilot: FakeAutopilot) -> None:
    # The rule this proves: a steering command that lands thirty seconds
    # late is worse than one that fails. There is nowhere for it to wait.
    url = pilot.base_url
    pilot.stop()
    client = AutopilotClient(url, TOKEN, timeout=1.0)
    with pytest.raises(AutopilotUnreachable):
        client.engage()
    # And no second attempt was made, then or ever.
    with pytest.raises(AutopilotUnreachable):
        client.engage()


def test_the_pilots_own_refusal_is_surfaced_verbatim(pilot: FakeAutopilot) -> None:
    with pytest.raises(AutopilotRefused) as e:
        client_for(pilot).set_mode("teleport")
    assert e.value.status_code == 400
    assert "Invalid mode: teleport" in e.value.message
    assert pilot.mode == "gps"  # unchanged


def test_a_pilot_that_cannot_tack_is_refused_verbatim(pilot: FakeAutopilot) -> None:
    # A steering action gets the same treatment as a bad mode: the pilot's
    # own "no" (here, not in a wind mode) is surfaced, never softened.
    pilot.fail_with = (400, {"state": "FAILED", "statusCode": 400, "message": "not in a wind mode"})
    with pytest.raises(AutopilotRefused) as e:
        client_for(pilot).tack("port")
    assert e.value.status_code == 400
    assert "not in a wind mode" in e.value.message


def test_a_failed_body_is_never_read_as_success(pilot: FakeAutopilot) -> None:
    # The API can answer FAILED with its code in the *body*. Trusting the
    # HTTP status alone would turn a refused steering command into a green
    # tick.
    pilot.fail_with = (200, {"state": "FAILED", "statusCode": 400, "message": "pilot is off"})
    with pytest.raises(AutopilotRefused) as e:
        client_for(pilot).engage()
    assert e.value.status_code == 400
    assert e.value.message == "pilot is off"


# -- the API surface -------------------------------------------------------


def test_the_routes_command_a_real_pilot(api: Callable, pilot: FakeAutopilot) -> None:
    client = api(pilot, TOKEN)
    assert client.post("/autopilot/engage").json()["state"] == "COMPLETED"
    assert pilot.engaged is True
    assert client.put("/autopilot/target", json={"degrees": 90.0}).status_code == 200
    assert pilot.target == pytest.approx(math.pi / 2)
    assert client.put("/autopilot/mode", json={"value": "wind"}).status_code == 200
    assert pilot.mode == "wind"
    assert client.post("/autopilot/disengage").json()["state"] == "COMPLETED"
    assert pilot.engaged is False
    assert client.get("/autopilot").json()["options"]["modes"][0] == "compass"


def test_the_action_routes_command_a_real_pilot(api: Callable, pilot: FakeAutopilot) -> None:
    client = api(pilot, TOKEN)
    assert client.post("/autopilot/tack/port").json()["state"] == "COMPLETED"
    assert pilot.tacked == "port"
    assert client.post("/autopilot/gybe/starboard").status_code == 200
    assert pilot.gybed == "starboard"
    assert client.post("/autopilot/dodge").status_code == 200
    assert pilot.dodging is True
    assert client.put("/autopilot/dodge", json={"degrees": 5.0}).status_code == 200
    assert pilot.dodge == pytest.approx(math.radians(5.0))
    assert client.delete("/autopilot/dodge").status_code == 200
    assert pilot.dodging is False


def test_an_unknown_direction_is_400_at_our_edge(api: Callable, pilot: FakeAutopilot) -> None:
    # port|starboard is the whole vocabulary; anything else is our client's
    # bug, caught here before it can round-trip to a 404 on the box.
    client = api(pilot, TOKEN)
    assert client.post("/autopilot/tack/sideways").status_code == 400
    assert client.post("/autopilot/gybe/sideways").status_code == 400
    assert pilot.tacked is None and pilot.gybed is None  # never left the building


def test_the_action_routes_keep_the_error_contract(api: Callable, pilot: FakeAutopilot) -> None:
    # Same 503/502 map as engage: no token is our config fault, a dead box
    # means the command did not happen. Neither is ever softened to 200.
    assert api(pilot, token=None).post("/autopilot/tack/port").status_code == 503
    client = api(pilot, TOKEN)
    pilot.stop()
    assert client.post("/autopilot/tack/port").status_code == 502


def test_a_refusal_keeps_the_pilots_status_code_and_words(
    api: Callable, pilot: FakeAutopilot
) -> None:
    response = api(pilot, TOKEN).put("/autopilot/state", json={"value": "hyperdrive"})
    assert response.status_code == 400
    assert "Invalid state: hyperdrive" in response.json()["detail"]


def test_no_token_is_503_and_names_the_fix(api: Callable, pilot: FakeAutopilot) -> None:
    response = api(pilot, token=None).post("/autopilot/engage")
    assert response.status_code == 503
    assert "credentials.signalk.token" in response.json()["detail"]
    assert pilot.engaged is False


def test_signalk_disabled_is_503_not_a_crash(api: Callable) -> None:
    # No pilot patched in, so the runtime keeps `signalk.enabled: false`.
    assert api(None, TOKEN).post("/autopilot/engage").status_code == 503


def test_a_dead_signalk_box_is_502_not_a_hang(api: Callable, pilot: FakeAutopilot) -> None:
    client = api(pilot, TOKEN)
    pilot.stop()
    assert client.post("/autopilot/engage").status_code == 502


def test_a_nonsense_target_is_refused_at_our_edge(api: Callable, pilot: FakeAutopilot) -> None:
    client = api(pilot, TOKEN)
    assert client.put("/autopilot/target", json={"degrees": 900.0}).status_code == 422
    assert client.put("/autopilot/target", json={"degrees": -900.0}).status_code == 422
    assert pilot.requests == []  # never left the building


def test_engage_seeds_the_target_from_current_cog_in_bearing_modes(
    engage_client: Callable, pilot: FakeAutopilot
) -> None:
    # gps, per the task that found this; compass shares the same
    # docstring-declared bearing vocabulary and gets the same treatment.
    # nav does NOT (see test_engage_does_not_seed_the_target_in_nav_mode
    # below) — its target is the followed route's course, not COG.
    for mode in ("compass", "gps"):
        pilot.mode = mode
        pilot.requests.clear()
        client = engage_client(pilot, _signalk_with_cog(123.0))
        response = client.post("/autopilot/engage")
        assert response.status_code == 200
        body = response.json()
        assert body["state"] == "COMPLETED"
        assert body["targetDeg"] == pytest.approx(123.0)
        assert pilot.target == pytest.approx(math.radians(123.0))
        # engage lands before the target PUT, so a pilot that snaps its own
        # default target on enable cannot win the race against ours — see
        # the "why after engage" note on mivnav.features.autopilot.routes.engage.
        methods = [m for m, _, _ in pilot.requests]
        assert methods == ["GET", "POST", "PUT"], mode
        assert pilot.requests[1][1].endswith("/engage")
        assert pilot.requests[2][1].endswith("/target")


def test_engage_does_not_seed_the_target_in_nav_mode(
    engage_client: Callable, pilot: FakeAutopilot
) -> None:
    # #vpxkyynv: nav mode steers the followed route's leg, published
    # separately over the Course API (mivnav.features.route.publish) — not
    # the boat's own COG. Seeding COG here would engage the pilot pointing
    # wherever the boat happened to be heading, fighting the course the
    # moment nav mode is entered — the same class of bug as the removed
    # continuous target republish, just at engage time instead of steady
    # state.
    pilot.mode = "nav"
    client = engage_client(pilot, _signalk_with_cog(123.0))
    response = client.post("/autopilot/engage")
    assert response.status_code == 200
    assert "targetDeg" not in response.json()
    assert [m for m, _, _ in pilot.requests] == ["GET", "POST"]  # no target PUT


def test_engage_does_not_touch_the_target_in_wind_modes(
    engage_client: Callable, pilot: FakeAutopilot
) -> None:
    # The dangerous direction: a wind angle mistaken for a bearing would
    # send the boat off in a wrong and unexpected direction.
    for mode in ("wind", "true wind"):
        pilot.mode = mode
        pilot.requests.clear()
        original_target = pilot.target
        client = engage_client(pilot, _signalk_with_cog(123.0))
        response = client.post("/autopilot/engage")
        assert response.status_code == 200
        assert "targetDeg" not in response.json()
        assert pilot.target == pytest.approx(original_target)
        assert [m for m, _, _ in pilot.requests] == ["GET", "POST"], mode  # no target PUT


def test_engage_with_no_cog_leaves_the_target_alone(
    engage_client: Callable, pilot: FakeAutopilot
) -> None:
    pilot.mode = "gps"
    original_target = pilot.target
    # A fix, but the course-over-ground path has never reported.
    client = engage_client(pilot, _signalk_with_cog(None))
    response = client.post("/autopilot/engage")
    assert response.status_code == 200
    assert "targetDeg" not in response.json()
    assert pilot.target == pytest.approx(original_target)
    assert [m for m, _, _ in pilot.requests] == ["GET", "POST"]


def test_engage_with_no_gps_fix_leaves_the_target_alone(
    engage_client: Callable, pilot: FakeAutopilot
) -> None:
    # cogDeg is reported, but `self` only publishes once there is a
    # position — the trap a naive `own.get("cogDeg")` on an empty dict
    # already handles, worth pinning explicitly.
    pilot.mode = "gps"
    original_target = pilot.target
    client = engage_client(pilot, _signalk_with_cog(123.0, has_fix=False))
    response = client.post("/autopilot/engage")
    assert response.status_code == 200
    assert "targetDeg" not in response.json()
    assert pilot.target == pytest.approx(original_target)


def test_engage_still_succeeds_when_signalk_has_no_self_at_all(
    engage_client: Callable, pilot: FakeAutopilot
) -> None:
    # SignalK disabled/never connected: `self` is None outright, not just
    # missing a field. Engage must not become collateral damage of a
    # courtesy step that could not run.
    pilot.mode = "gps"
    client = engage_client(pilot, SignalKService(None))
    response = client.post("/autopilot/engage")
    assert response.status_code == 200
    assert response.json()["state"] == "COMPLETED"
    assert "targetDeg" not in response.json()


def test_a_token_edit_takes_effect_with_no_restart(api: Callable, pilot: FakeAutopilot) -> None:
    # The client is built per request precisely so this works. A Derived
    # keyed on the `signalk` slice would have missed a credentials-only
    # change and no-opped silently — the trap mivnav.config.derived exists
    # to prevent, from the other side.
    client = api(pilot, token="wrong")
    assert client.post("/autopilot/engage").status_code == 503
    api.runtime().patch_config({"credentials": {"signalk": {"token": TOKEN}}})
    assert client.post("/autopilot/engage").status_code == 200


# -- helpers ---------------------------------------------------------------


def _hello() -> str:
    return json.dumps({"self": f"vessels.{SELF_ID}", "version": "1.0.0"})


def _delta(vessel: str, path: str, value: Any) -> str:
    return json.dumps(
        {
            "context": f"vessels.{vessel}",
            "updates": [{"values": [{"path": path, "value": value}]}],
        }
    )
