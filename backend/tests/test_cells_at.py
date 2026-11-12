# SPDX-License-Identifier: GPL-2.0-only
"""`GET /cells/at`: the cells charting a spot, finest first — the source
of the map's overscale / "zoom in for detail" badge."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from senc_fixture import point_cell


@pytest.fixture()
def env(tmp_path: Path):
    sets_dir = tmp_path / "ocharts"
    set_dir = sets_dir / "oeuSENC-TEST1"
    set_dir.mkdir(parents=True)
    # A coastal cell over the whole box, a harbour cell whose COVERAGE is
    # only its north-east corner (its extent rect is wider), and a cell
    # elsewhere.
    point_cell(set_dir / "COAST.senc", name="COAST", scale=90000, bounds=(11.0, 54.0, 11.4, 54.4))
    point_cell(
        set_dir / "HARB.senc",
        name="HARB",
        scale=12000,
        bounds=(11.0, 54.0, 11.2, 54.2),
        covr=(11.1, 54.1, 11.2, 54.2),
    )
    point_cell(set_dir / "AWAY.senc", name="AWAY", scale=8000, bounds=(12.0, 55.0, 12.1, 55.1))

    from mivnav.api.app import app
    from mivnav.api.charts import get_store
    from mivnav.charts.store import ChartStore
    from mivnav.features.ocharts.routes import get_service
    from mivnav.features.ocharts.service import OchartsService

    service = OchartsService(
        sets_dir=sets_dir,
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        rescan_interval=0,
        warm_overview=False,
        s52_path=tmp_path / "no-s52-data",
    )
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_store] = lambda: ChartStore(tmp_path / "empty-pmtiles")
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)


def _names(client, lon, lat, **params):
    r = client.get("/cells/at", params={"lon": lon, "lat": lat, **params})
    assert r.status_code == 200, r.text
    return [(c["name"], c["scale"]) for c in r.json()["cells"]]


def test_finest_first_inside_harbour_coverage(env):
    assert _names(env, 11.15, 54.15) == [("HARB", 12000), ("COAST", 90000)]


def test_coverage_not_extent_decides(env):
    # Inside HARB's extent rect but well outside its coverage ring.
    assert _names(env, 11.02, 54.02) == [("COAST", 90000)]


def test_uncharted_spot_is_empty(env):
    assert _names(env, 5.0, 50.0) == []


def test_cell_fields(env):
    cell = env.get("/cells/at", params={"lon": 11.15, "lat": 54.15}).json()["cells"][0]
    assert cell == {"set": "oeuSENC-TEST1", "name": "HARB", "scale": 12000, "max_zoom": 16}


def test_rejects_out_of_range(env):
    assert env.get("/cells/at", params={"lon": 200, "lat": 0}).status_code == 422
