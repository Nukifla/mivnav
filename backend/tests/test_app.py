# SPDX-License-Identifier: GPL-2.0-only
"""_SPAFiles: the SPA/static-asset serving class app.py mounts at "/" in
production (served_app). Exercised directly against a temp directory rather
than the real build (frontend/dist doesn't exist in a plain backend checkout,
which is exactly why `_DIST.is_dir()` gates the real mount)."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from mivnav.api.app import _SPAFiles


def _client(tmp_path: Path) -> TestClient:
    (tmp_path / "index.html").write_text("<html>shell</html>")
    (tmp_path / "app.js").write_text("// asset")
    (tmp_path / "sw.js").write_text("// service worker")
    app = FastAPI()
    app.mount("/", _SPAFiles(directory=str(tmp_path), html=True), name="spa")
    return TestClient(app)


def test_permissions_policy_on_a_real_asset(tmp_path: Path) -> None:
    r = _client(tmp_path).get("/app.js")
    assert r.status_code == 200
    assert r.headers["permissions-policy"] == "local-network=(self), loopback-network=(self)"


def test_permissions_policy_on_the_spa_fallback(tmp_path: Path) -> None:
    # An unknown path 404s to index.html (client-side routing) — the header
    # must carry through that fallback too, since it's the actual document
    # response Local Network Access cares about.
    r = _client(tmp_path).get("/some/client/route")
    assert r.status_code == 200
    assert b"shell" in r.content
    assert r.headers["permissions-policy"] == "local-network=(self), loopback-network=(self)"


def test_no_cache_on_index_html(tmp_path: Path) -> None:
    r = _client(tmp_path).get("/")
    assert r.headers["cache-control"] == "no-cache"


def test_no_cache_on_spa_fallback(tmp_path: Path) -> None:
    r = _client(tmp_path).get("/some/client/route")
    assert r.headers["cache-control"] == "no-cache"


def test_no_cache_on_service_worker(tmp_path: Path) -> None:
    r = _client(tmp_path).get("/sw.js")
    assert r.headers["cache-control"] == "no-cache"


def test_hashed_asset_keeps_default_caching(tmp_path: Path) -> None:
    r = _client(tmp_path).get("/app.js")
    assert r.headers.get("cache-control") != "no-cache"
