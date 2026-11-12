# SPDX-License-Identifier: GPL-2.0-only
"""Enumerating the boat's SignalK paths for the dashboard widget picker.

The claims worth proving:

- flattening a SignalK ``vessels/self`` tree yields one entry per leaf that
  carries a value, with its ``meta.units``, and never a container or an
  identity string — the rule the combo box searches over;
- the ``GET /signalk/paths`` route returns that list against a real box, and
  degrades to an EMPTY list — never an error — when SignalK is disabled or the
  box does not answer, because "cannot enumerate" and "nothing to enumerate"
  are one answer to a picker.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mivnav.signalk import flatten_self_tree
from tests.conftest import isolated_runtime_at

# -- the flattening rule (pure) --------------------------------------------

# A realistic slice of a signalk-server vessels/self tree: nested containers,
# leaves with and without units, a value that is itself an object (position),
# NMEA provenance keys that are not paths, and plain identity strings.
_SELF_TREE: dict[str, Any] = {
    "name": "Calypso",
    "mmsi": "244770001",
    "navigation": {
        "speedOverGround": {
            "value": 3.4,
            "meta": {"units": "m/s"},
            "$source": "gps.1",
            "timestamp": "2026-07-18T00:00:00Z",
        },
        "position": {
            "value": {"latitude": 59.9, "longitude": 10.7},
            "timestamp": "2026-07-18T00:00:00Z",
        },
    },
    "electrical": {
        "batteries": {
            "house": {
                "voltage": {"value": 12.6, "meta": {"units": "V"}},
                "current": {"value": -4.2, "meta": {"units": "A"}, "pgn": 127508},
            }
        }
    },
}


def test_flatten_emits_a_path_per_leaf_with_units() -> None:
    flat = flatten_self_tree(_SELF_TREE)
    by_path = {e["path"]: e for e in flat}
    assert by_path["navigation.speedOverGround"] == {
        "path": "navigation.speedOverGround",
        "units": "m/s",
    }
    assert by_path["electrical.batteries.house.voltage"]["units"] == "V"
    assert by_path["electrical.batteries.house.current"]["units"] == "A"


def test_flatten_includes_a_leaf_with_no_units_and_no_units_key() -> None:
    by_path = {e["path"]: e for e in flatten_self_tree(_SELF_TREE)}
    # A leaf whose value is an object still enumerates; it simply has no units.
    assert by_path["navigation.position"] == {"path": "navigation.position"}


def test_flatten_skips_identity_strings_and_metadata_keys() -> None:
    paths = {e["path"] for e in flatten_self_tree(_SELF_TREE)}
    assert "name" not in paths and "mmsi" not in paths
    # No metadata/provenance key ever becomes a path segment.
    for p in paths:
        assert not any(
            seg in {"value", "meta", "timestamp", "$source", "pgn"} for seg in p.split(".")
        )


def test_flatten_is_total_on_junk() -> None:
    assert flatten_self_tree(None) == []
    assert flatten_self_tree("nope") == []
    assert flatten_self_tree({}) == []


# -- the route, graceful throughout ----------------------------------------


class _FakeRest:
    """A loopback HTTP server that answers vessels/self with a fixed tree."""

    def __init__(self, tree: dict[str, Any]) -> None:
        self._tree = tree
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> _FakeRest:
        tree = self._tree

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                if self.path.split("?")[0] != "/signalk/v1/api/vessels/self":
                    self.send_response(404)
                    self.end_headers()
                    return
                data = json.dumps(tree).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="fake-rest", daemon=True
        )
        self._thread.start()
        return self

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.server_address[1]

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=10)


@pytest.fixture
def api(tmp_path: Path) -> Iterator[Any]:
    """``api(patch) -> TestClient`` over a throwaway config store."""
    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    # Restore whatever override was there before (the session `client`
    # fixture's own, set by conftest.py's autouse `isolated_runtime`) rather
    # than popping unconditionally — an unconditional pop strands every
    # later test with no get_runtime override at all (same bug class as
    # vyvqpxmn; see test_datasets_api.py's `dc` fixture).
    previous = app.dependency_overrides.get(get_runtime)
    runtimes = []

    def build(signalk_patch: dict[str, Any] | None = None) -> TestClient:
        runtime = isolated_runtime_at(tmp_path)
        runtimes.append(runtime)
        if signalk_patch is not None:
            runtime.config.patch({"signalk": signalk_patch})
        app.dependency_overrides[get_runtime] = lambda: runtime
        return TestClient(app)

    yield build
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous
    for runtime in runtimes:
        runtime.close()


def test_paths_route_flattens_the_boats_tree(api: Any) -> None:
    rest = _FakeRest(_SELF_TREE).start()
    try:
        client = api({"enabled": True, "host": "127.0.0.1", "port": rest.port})
        body = client.get("/signalk/paths").json()
        by_path = {e["path"]: e for e in body["paths"]}
        assert by_path["navigation.speedOverGround"]["units"] == "m/s"
        assert "electrical.batteries.house.voltage" in by_path
        assert "name" not in by_path
    finally:
        rest.stop()


def test_paths_route_empty_when_signalk_disabled(api: Any) -> None:
    client = api({"enabled": False})
    assert client.get("/signalk/paths").json() == {"paths": []}


def test_paths_route_empty_when_box_unreachable(api: Any) -> None:
    # Enabled, pointed at a port nothing is listening on: an empty list, not a
    # 502 — the picker must still open.
    client = api({"enabled": True, "host": "127.0.0.1", "port": 1})
    assert client.get("/signalk/paths").json() == {"paths": []}
