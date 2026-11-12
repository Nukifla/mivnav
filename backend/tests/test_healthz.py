# SPDX-License-Identifier: GPL-2.0-only
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.system import current_version

client = TestClient(app)


def test_healthz():
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "version": current_version()}


def test_cors_allows_frontend_dev_origin():
    resp = client.get("/healthz", headers={"Origin": "http://localhost:5173"})
    assert resp.headers["access-control-allow-origin"] == "http://localhost:5173"
