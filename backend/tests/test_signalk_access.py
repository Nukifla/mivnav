# SPDX-License-Identifier: GPL-2.0-only
"""Obtaining the autopilot write token via SignalK's access-request flow.

The claims worth proving:

- the base URL is derived from the ws:// connection URL correctly, because a
  wrong scheme/host/port means asking the wrong box (or nothing) for access;
- an APPROVED request lands its token in ``credentials.json`` (0600), through
  the config store — never in the primary ``config.json`` and never in a log;
- a DENIED request stores nothing;
- the ``clientId`` is stable across requests, so SignalK's re-approval works;
- the granted token is picked up by the autopilot client with no restart.

The handshake half runs against the real fake HTTP server
(tests/fake_access.py); the token-storage half through the real config store,
so the split (config vs credentials) is exercised, not stubbed past.
"""

from __future__ import annotations

import json
import stat
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mivnav.signalk import (
    AccessRequestClient,
    SignalKUnavailable,
    SignalKUnreachable,
    ws_to_http_base,
)
from tests.conftest import isolated_runtime_at
from tests.fake_access import FakeAccess

TOKEN = "eyJhbGciOiJIUzI1NiJ9.granted-write-token.sig"


@pytest.fixture
def fake() -> Iterator[FakeAccess]:
    server = FakeAccess().start()
    yield server
    server.stop()


# -- the ws -> http base derivation ----------------------------------------


def test_ws_to_http_base_maps_scheme_and_keeps_host_and_port() -> None:
    assert (
        ws_to_http_base("ws://localhost:3000/signalk/v1/stream?subscribe=none")
        == "http://localhost:3000"
    )


def test_ws_to_http_base_maps_wss_to_https() -> None:
    assert (
        ws_to_http_base("wss://signalk.local:3443/signalk/v1/stream")
        == "https://signalk.local:3443"
    )


# -- the handshake client (pure) -------------------------------------------


def test_pending_then_approved_yields_the_token(fake: FakeAccess) -> None:
    client = AccessRequestClient(f"http://127.0.0.1:{fake.port}")
    started = client.request_access("device-uuid-1", permissions="readwrite")
    assert started["state"] == "PENDING"
    request_id = started["requestId"]
    # Nobody has acted yet.
    assert client.poll(request_id) == {"state": "PENDING"}
    # The human approves in the admin.
    fake.approve(request_id, TOKEN)
    result = client.poll(request_id)
    assert result == {"state": "COMPLETED", "approved": True, "token": TOKEN}
    # And we sent the clientId under the documented key.
    assert fake.requests[-1]["clientId"] == "device-uuid-1"
    assert fake.requests[-1]["description"] == "mivnav"
    assert fake.requests[-1]["permissions"] == "readwrite"


def test_pending_then_denied_yields_no_token(fake: FakeAccess) -> None:
    client = AccessRequestClient(f"http://127.0.0.1:{fake.port}")
    request_id = client.request_access("device-uuid-1", permissions="readwrite")["requestId"]
    fake.deny(request_id)
    result = client.poll(request_id)
    assert result == {"state": "COMPLETED", "approved": False}
    assert "token" not in result


def test_an_approval_with_no_token_is_reported_as_not_approved(
    fake: FakeAccess,
) -> None:
    # A COMPLETED+APPROVED with an empty token is not usable, so it must not
    # present as success and cause an empty token to be stored.
    client = AccessRequestClient(f"http://127.0.0.1:{fake.port}")
    request_id = client.request_access("d", permissions="readwrite")["requestId"]
    fake.approve(request_id, "")
    assert client.poll(request_id) == {"state": "COMPLETED", "approved": False}


def test_a_disabled_signalk_is_unavailable_not_unreachable() -> None:
    with pytest.raises(SignalKUnavailable):
        AccessRequestClient(None).request_access("d", permissions="readwrite")


def test_a_dead_server_fails_fast(fake: FakeAccess) -> None:
    base = f"http://127.0.0.1:{fake.port}"
    fake.stop()
    client = AccessRequestClient(base, timeout=1.0)
    with pytest.raises(SignalKUnreachable):
        client.request_access("d", permissions="readwrite")


# -- the API surface, through the real config store ------------------------


@pytest.fixture
def api(tmp_path: Path) -> Iterator[Any]:
    """``api(fake) -> TestClient`` wired through a throwaway config store."""
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    # Restore whatever override was there before (the session `client`
    # fixture's own, set by conftest.py's autouse `isolated_runtime`) rather
    # than popping unconditionally — an unconditional pop strands every
    # later test with no get_runtime override at all (same bug class as
    # vyvqpxmn; see test_datasets_api.py's `dc` fixture).
    previous = app.dependency_overrides.get(get_runtime)
    runtimes = []

    def build(fake: FakeAccess | None = None) -> TestClient:
        runtime = isolated_runtime_at(tmp_path)
        runtimes.append(runtime)
        if fake is not None:
            runtime.config.patch(
                {"signalk": {"enabled": True, "host": "127.0.0.1", "port": fake.port}}
            )
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


def test_the_routes_drive_the_flow_and_store_the_token(
    api: Any, fake: FakeAccess
) -> None:
    client = api(fake)
    started = client.post("/signalk/access-request").json()
    assert started["state"] == "PENDING"
    request_id = started["requestId"]
    # Still pending: nothing stored.
    assert client.get(f"/signalk/access-request/{request_id}").json() == {
        "state": "PENDING"
    }
    assert api.runtime().config.get().credentials.signalk.token.get_secret_value() == ""
    # The human approves, and the next poll writes the token.
    fake.approve(request_id, TOKEN)
    body = client.get(f"/signalk/access-request/{request_id}").json()
    assert body == {"state": "COMPLETED", "approved": True}
    # The token is not in the response, ever.
    assert TOKEN not in json.dumps(body)
    assert (
        api.runtime().config.get().credentials.signalk.token.get_secret_value() == TOKEN
    )


def test_the_granted_token_lands_in_credentials_0600_not_the_config(
    api: Any, fake: FakeAccess
) -> None:
    client = api(fake)
    request_id = client.post("/signalk/access-request").json()["requestId"]
    fake.approve(request_id, TOKEN)
    client.get(f"/signalk/access-request/{request_id}")

    runtime = api.runtime()
    # In credentials.json, 0600 — the same posture as the o-charts password.
    assert TOKEN in runtime.config.credentials_path.read_text()
    assert stat.S_IMODE(runtime.config.credentials_path.stat().st_mode) == 0o600
    # Never in the primary config.
    assert TOKEN not in runtime.config.path.read_text()


def test_a_denied_request_stores_nothing(api: Any, fake: FakeAccess) -> None:
    client = api(fake)
    request_id = client.post("/signalk/access-request").json()["requestId"]
    fake.deny(request_id)
    body = client.get(f"/signalk/access-request/{request_id}").json()
    assert body == {"state": "COMPLETED", "approved": False}
    assert api.runtime().config.get().credentials.signalk.token.get_secret_value() == ""


def test_the_client_id_is_stable_across_requests(api: Any, fake: FakeAccess) -> None:
    # SignalK ties the token to the clientId, so a re-request must reuse it.
    client = api(fake)
    client.post("/signalk/access-request")
    client.post("/signalk/access-request")
    assert fake.requests[0]["clientId"] == fake.requests[1]["clientId"]
    # And it is a real, persisted, non-empty id living in the config (not
    # credentials — it is not a secret).
    persisted = api.runtime().config.get().signalk_client_id
    assert persisted and fake.requests[0]["clientId"] == persisted
    # Admin: plugin config and plugin routes are admin-gated in
    # signalk-server; write alone can't read the anchor alarm's settings.
    assert all(r["permissions"] == "admin" for r in fake.requests)


def test_the_client_id_is_never_in_credentials(api: Any, fake: FakeAccess) -> None:
    client = api(fake)
    client.post("/signalk/access-request")
    runtime = api.runtime()
    client_id = runtime.config.get().signalk_client_id
    # It is in config.json, and categorically not in credentials.json.
    assert client_id in runtime.config.path.read_text()
    if runtime.config.credentials_path.exists():
        assert client_id not in runtime.config.credentials_path.read_text()


def test_the_granted_token_is_picked_up_live_by_the_autopilot_client(
    api: Any, fake: FakeAccess
) -> None:
    # The AP client is built per request reading the token per call, so a
    # freshly-granted token is usable with no restart.
    client = api(fake)
    runtime = api.runtime()
    assert runtime.feature("autopilot").client()._token is None
    request_id = client.post("/signalk/access-request").json()["requestId"]
    fake.approve(request_id, TOKEN)
    client.get(f"/signalk/access-request/{request_id}")
    assert runtime.feature("autopilot").client()._token == TOKEN


def test_signalk_disabled_is_409_at_both_routes(api: Any) -> None:
    # No fake: the runtime keeps signalk disabled.
    client = api(None)
    assert client.post("/signalk/access-request").status_code == 409
    assert client.get("/signalk/access-request/whatever").status_code == 409


def test_a_dead_box_is_502_not_a_hang(api: Any, fake: FakeAccess) -> None:
    client = api(fake)
    request_id = client.post("/signalk/access-request").json()["requestId"]
    fake.stop()
    assert client.get(f"/signalk/access-request/{request_id}").status_code == 502
    assert client.post("/signalk/access-request").status_code == 502
