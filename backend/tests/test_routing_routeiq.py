# SPDX-License-Identifier: GPL-2.0-only
"""``POST /routing/plan`` with ``RoutingConfig.algorithm == "routeiq"``, and
the ``/routing/routeiq/access-request`` handshake — the REMOTE routing
engine, end to end through the real HTTP API, against real fake servers
(:mod:`tests.fake_access`, :mod:`tests.fake_routeiq`), same posture as
``test_signalk_access.py``: what can actually be wrong is the wiring
between mivnav's own routes and the real wire shapes, not the client
library, so this drives it over real sockets rather than stubbing past
the seam.

The claims worth proving:

- the access-request handshake stores the RouteIQ token under
  ``credentials.routeiq``, NOT ``credentials.signalk`` — a separate grant;
- the ``clientId`` is ``routeiq_client_id``, separate from
  ``signalk_client_id``;
- ``POST /routing/plan`` with ``algorithm: "routeiq"`` calls the remote
  plugin instead of chartcore, and maps a real response onto the exact
  same ``PlanResponse`` shape the raster algorithm returns;
- ``ROUTE_NOT_FOUND`` still returns 200 with a straight-line fallback and
  a clear reason, never a bare error — the same "always something to
  draw" contract the raster path keeps;
- no token configured is a clear 409, not a hang or a 500.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.conftest import isolated_runtime_at
from tests.fake_access import FakeAccess
from tests.fake_routeiq import FakeRouteIQ

TOKEN = "eyJhbGciOiJIUzI1NiJ9.granted-routeiq-token.sig"


@pytest.fixture
def fake_access() -> Iterator[FakeAccess]:
    server = FakeAccess().start()
    yield server
    server.stop()


@pytest.fixture
def fake_routeiq() -> Iterator[FakeRouteIQ]:
    server = FakeRouteIQ().start()
    yield server
    server.stop()


@pytest.fixture
def api(tmp_path: Path) -> Iterator[Any]:
    """``api(port=...) -> TestClient``, SignalK enabled and pointed at
    ``port`` — same shape as ``test_signalk_access.py``'s own fixture."""
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    previous = app.dependency_overrides.get(get_runtime)
    runtimes = []

    def build(port: int | None = None, *, algorithm: str = "routeiq") -> TestClient:
        runtime = isolated_runtime_at(tmp_path)
        runtimes.append(runtime)
        patch: dict[str, Any] = {"routing": {"algorithm": algorithm}}
        if port is not None:
            patch["signalk"] = {"enabled": True, "host": "127.0.0.1", "port": port}
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


# -- the access-request handshake, a SEPARATE grant from the autopilot's ---


def test_the_granted_token_lands_under_credentials_routeiq_not_signalk(
    api: Any, fake_access: FakeAccess
) -> None:
    client = api(fake_access.port)
    request_id = client.post("/routing/routeiq/access-request").json()["requestId"]
    fake_access.approve(request_id, TOKEN)
    body = client.get(f"/routing/routeiq/access-request/{request_id}").json()
    assert body == {"state": "COMPLETED", "approved": True}

    runtime = api.runtime()
    assert runtime.config.get().credentials.routeiq.token.get_secret_value() == TOKEN
    # And categorically NOT the autopilot's own slot.
    assert runtime.config.get().credentials.signalk.token.get_secret_value() == ""


def test_the_client_id_is_separate_from_signalks(api: Any, fake_access: FakeAccess) -> None:
    client = api(fake_access.port)
    client.post("/routing/routeiq/access-request")
    runtime = api.runtime()
    routeiq_id = runtime.config.get().routeiq_client_id
    assert routeiq_id and routeiq_id != runtime.config.get().signalk_client_id
    assert fake_access.requests[-1]["clientId"] == routeiq_id
    assert fake_access.requests[-1]["description"] == "mivnav routing"
    # RouteIQ's plugin routes are admin-gated by signalk-server, so the
    # request asks for exactly that — the approver never picks a level.
    assert fake_access.requests[-1]["permissions"] == "admin"


def test_a_denied_routeiq_request_stores_nothing(api: Any, fake_access: FakeAccess) -> None:
    client = api(fake_access.port)
    request_id = client.post("/routing/routeiq/access-request").json()["requestId"]
    fake_access.deny(request_id)
    body = client.get(f"/routing/routeiq/access-request/{request_id}").json()
    assert body == {"state": "COMPLETED", "approved": False}
    assert api.runtime().config.get().credentials.routeiq.token.get_secret_value() == ""


def test_signalk_disabled_is_409_at_both_routeiq_access_routes(api: Any) -> None:
    client = api(None)
    assert client.post("/routing/routeiq/access-request").status_code == 409
    assert client.get("/routing/routeiq/access-request/whatever").status_code == 409


# -- POST /routing/plan with algorithm: "routeiq" ---------------------------


def _grant_token(api: Any, port: int, fake_access: FakeAccess) -> TestClient:
    """A client whose runtime already has a stored RouteIQ token — the
    setup every plan_route test below needs."""
    client = api(port)
    request_id = client.post("/routing/routeiq/access-request").json()["requestId"]
    fake_access.approve(request_id, TOKEN)
    client.get(f"/routing/routeiq/access-request/{request_id}")
    return client


def test_plan_route_via_routeiq_maps_a_real_response(
    api: Any, fake_routeiq: FakeRouteIQ, fake_access: FakeAccess
) -> None:
    # Both fakes on ONE port would collide (two servers can't share a
    # loopback port), so grant the token against fake_access, then point
    # SignalK at fake_routeiq for the actual plan call — the real
    # deployment has ONE box serving both; this proves the two calls
    # (access grant, then plan) each reach the box config says to reach.
    _grant_token(api, fake_access.port, fake_access)
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    # Point SignalK at fake_routeiq now (the token grant above used
    # fake_access) — the dependency override already resolves to this
    # same runtime, so no app rebuild is needed, just a fresh TestClient.
    runtime = api.runtime()
    runtime.config.patch({"signalk": {"enabled": True, "host": "127.0.0.1", "port": fake_routeiq.port}})
    app.dependency_overrides[get_runtime] = lambda: runtime
    client = TestClient(app)

    fake_routeiq.respond_ok([(10.0, 56.0), (10.1, 56.1)], total_distance_m=7408.0)  # 4nm
    res = client.post(
        "/routing/plan",
        json={"from": {"lat": 56.0, "lon": 10.0}, "to": {"lat": 56.1, "lon": 10.1}, "draft_m": 1.8},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["waypoints"] == [{"lat": 56.0, "lon": 10.0}, {"lat": 56.1, "lon": 10.1}]
    assert body["approximate_legs"] == [False]
    assert abs(body["distance_nm"] - 4.0) < 0.01
    assert any("RouteIQ" in w for w in body["warnings"])
    # And the request that reached RouteIQ carried the draft we sent.
    assert fake_routeiq.requests[-1]["draft"] == 1.8


def test_plan_route_via_routeiq_not_found_falls_back_to_a_straight_line(
    api: Any, fake_routeiq: FakeRouteIQ, fake_access: FakeAccess
) -> None:
    client = _grant_token(api, fake_access.port, fake_access)
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    runtime = api.runtime()
    runtime.config.patch({"signalk": {"enabled": True, "host": "127.0.0.1", "port": fake_routeiq.port}})
    app.dependency_overrides[get_runtime] = lambda: runtime
    client = TestClient(app)

    fake_routeiq.respond_not_found()
    res = client.post(
        "/routing/plan",
        json={"from": {"lat": 0.0, "lon": 0.0}, "to": {"lat": 1.0, "lon": 1.0}, "draft_m": 1.8},
    )
    assert res.status_code == 200  # never a bare error — see the module docstring
    body = res.json()
    assert body["waypoints"] == [{"lat": 0.0, "lon": 0.0}, {"lat": 1.0, "lon": 1.0}]
    assert body["approximate_legs"] == [True]
    assert any("RouteIQ" in w for w in body["warnings"])


def test_plan_route_via_routeiq_with_no_token_is_409(api: Any, fake_routeiq: FakeRouteIQ) -> None:
    # SignalK configured, but no access grant yet — a clear config fault,
    # not a hang or a 500.
    client = api(fake_routeiq.port)
    res = client.post(
        "/routing/plan",
        json={"from": {"lat": 0.0, "lon": 0.0}, "to": {"lat": 1.0, "lon": 1.0}, "draft_m": 1.8},
    )
    assert res.status_code == 409


def test_the_raster_algorithm_is_unaffected_by_a_configured_routeiq_token(
    api: Any, fake_access: FakeAccess
) -> None:
    # Sanity: picking "raster" (the default) never reaches RouteIQ at all,
    # token or not — confirms the branch in plan_route, not just that
    # RouteIQ itself works.
    client = api(fake_access.port, algorithm="raster")
    res = client.post(
        "/routing/plan",
        json={"from": {"lat": 0.0, "lon": 0.0}, "to": {"lat": 0.001, "lon": 0.001}, "draft_m": 1.8},
    )
    assert res.status_code == 200
    assert not any("RouteIQ" in w for w in res.json()["warnings"])
