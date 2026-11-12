# SPDX-License-Identifier: GPL-2.0-only
"""``GET /search`` — the HTTP surface over the shared search index."""

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.search.index import SearchRecord


@pytest.fixture
def search_client(tmp_path: Path, isolated_runtime):
    from mivnav.api.app import app
    from mivnav.api.deps import get_search_index
    from mivnav.search import SearchIndex

    index = SearchIndex(tmp_path / "search.sqlite3")
    index.rebake(
        "poi", "solent",
        [
            SearchRecord(
                id="1", category="marina", title="Cowes Marina", text="Cowes Marina",
                lat=50.76, lon=-1.30, data={"kind": "marina"},
            ),
            SearchRecord(
                id="2", category="fuel", title="Fuel Berth", text="Fuel Berth",
                lat=50.70, lon=-1.20, data={"kind": "fuel"},
            ),
        ],
        updated_at=1.0,
    )
    app.dependency_overrides[get_search_index] = lambda: index
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_search_index, None)
    index.close()


def test_search_with_no_query_returns_everything(search_client):
    resp = search_client.get("/search")
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 2


def test_search_by_text(search_client):
    resp = search_client.get("/search", params={"q": "Cowes"})
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert [r["title"] for r in results] == ["Cowes Marina"]


def test_search_by_category(search_client):
    resp = search_client.get("/search", params={"category": "fuel"})
    results = resp.json()["results"]
    assert [r["title"] for r in results] == ["Fuel Berth"]


def test_search_by_bbox(search_client):
    resp = search_client.get(
        "/search", params={"bbox": "-1.35,50.74,-1.25,50.78"}
    )
    results = resp.json()["results"]
    assert [r["title"] for r in results] == ["Cowes Marina"]


def test_search_rejects_malformed_bbox(search_client):
    resp = search_client.get("/search", params={"bbox": "not,a,bbox"})
    assert resp.status_code == 422

    resp = search_client.get("/search", params={"bbox": "1,2,3"})
    assert resp.status_code == 422


# -- proximity sort (lat/lon) ------------------------------------------------


def test_search_sorts_nearest_first_when_position_given(search_client):
    resp = search_client.get("/search", params={"lat": 50.70, "lon": -1.20})
    assert [r["title"] for r in resp.json()["results"]] == ["Fuel Berth", "Cowes Marina"]

    resp = search_client.get("/search", params={"lat": 50.76, "lon": -1.30})
    assert [r["title"] for r in resp.json()["results"]] == ["Cowes Marina", "Fuel Berth"]


def test_search_without_position_does_not_sort_by_distance(search_client):
    """No `lat`/`lon` — the index's own order (rowid-recency), unchanged by
    this feature: neither result happens to be first by distance from
    anywhere in particular, so this only pins "no crash, no requirement"."""
    resp = search_client.get("/search", params={"q": ""})
    assert resp.status_code == 200


def test_search_proximity_sort_puts_a_pointless_result_last(tmp_path: Path, isolated_runtime):
    from mivnav.api.app import app
    from mivnav.api.deps import get_search_index
    from mivnav.search import SearchIndex

    index = SearchIndex(tmp_path / "search.sqlite3")
    index.rebake(
        "navwarning", "solent",
        [
            SearchRecord(
                id="1", category=None, title="Nearby Warning", text="Nearby Warning",
                lat=50.70, lon=-1.20, data={},
            ),
            SearchRecord(
                id="2", category=None, title="Area-only Warning", text="Area-only Warning",
                lat=None, lon=None, data={},
            ),
        ],
        updated_at=1.0,
    )
    app.dependency_overrides[get_search_index] = lambda: index
    with TestClient(app) as c:
        resp = c.get("/search", params={"lat": 50.70, "lon": -1.20})
    app.dependency_overrides.pop(get_search_index, None)
    index.close()
    assert [r["title"] for r in resp.json()["results"]] == ["Nearby Warning", "Area-only Warning"]


# -- live AIS targets merged into the response ------------------------------


@pytest.fixture
def search_client_with_ais(tmp_path: Path, isolated_runtime):
    """Like ``search_client``, plus a live AIS target the index has never
    heard of — proving the merge in mivnav.api.search, not a fake that
    reimplements it."""
    from mivnav.api.app import app
    from mivnav.api.deps import get_search_index, get_signalk
    from mivnav.search import SearchIndex
    from mivnav.signalk import SignalKService

    index = SearchIndex(tmp_path / "search.sqlite3")
    index.rebake(
        "poi", "solent",
        [
            SearchRecord(
                id="1", category="marina", title="Cowes Marina", text="Cowes Marina",
                lat=50.76, lon=-1.30, data={"kind": "marina"},
            ),
        ],
        updated_at=1.0,
    )
    signalk = SignalKService(None)
    # Real clock: search_targets staleness-filters against time.time(), so a
    # delta stamped with a fixed fake "now" would read as ancient and vanish.
    signalk._tracker.apply(
        '{"context": "vessels.nordic", "updates": [{"values": ['
        '{"path": "navigation.position", "value": {"latitude": 55.9, "longitude": 12.6}},'
        '{"path": "", "value": {"name": "Nordic Star", "mmsi": "265123456"}}]}]}',
        now=time.time(),
    )
    app.dependency_overrides[get_search_index] = lambda: index
    app.dependency_overrides[get_signalk] = lambda: signalk
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_search_index, None)
    app.dependency_overrides.pop(get_signalk, None)
    index.close()
    signalk.close()


def test_search_merges_a_matching_ais_target(search_client_with_ais):
    resp = search_client_with_ais.get("/search", params={"q": "Nordic"})
    results = resp.json()["results"]
    assert [(r["source"], r["title"], r["category"]) for r in results] == [
        ("ais", "Nordic Star", "vessel")
    ]
    assert (results[0]["lat"], results[0]["lon"]) == (55.9, 12.6)


def test_search_proximity_sort_ranks_poi_and_ais_together(search_client_with_ais):
    """Nordic Star (55.9, 12.6, Denmark) and Cowes Marina (50.76, -1.30, the
    Solent) — one query surface, so a position near either must rank it
    first regardless of which un-indexed/baked source it came from."""
    resp = search_client_with_ais.get("/search", params={"lat": 55.9, "lon": 12.6})
    assert [r["title"] for r in resp.json()["results"]] == ["Nordic Star", "Cowes Marina"]

    resp = search_client_with_ais.get("/search", params={"lat": 50.76, "lon": -1.30})
    assert [r["title"] for r in resp.json()["results"]] == ["Cowes Marina", "Nordic Star"]


def test_search_by_source_poi_excludes_ais(search_client_with_ais):
    resp = search_client_with_ais.get("/search", params={"q": "Nordic", "source": "poi"})
    assert resp.json()["results"] == []


def test_search_by_category_vessel_returns_only_ais(search_client_with_ais):
    resp = search_client_with_ais.get("/search", params={"category": "vessel"})
    assert [r["title"] for r in resp.json()["results"]] == ["Nordic Star"]
