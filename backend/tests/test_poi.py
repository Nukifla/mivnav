# SPDX-License-Identifier: GPL-2.0-only
"""The POI feature module's HTTP surface: catalog, tiles, ETag/304, 404-empty.

The committed fixture (``backend/data/poi/pois.pmtiles``, a 4-feature OSM POI
extract whose vector layer is ``pois``) is served through a `PoiStore` pointed
at that directory, exercising the SAME serving pattern the chart tiles use.
"""

import math
import os
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import chartcore

POI_DIR = Path(__file__).resolve().parents[1] / "data" / "poi"
# The ONE committed fixture file. `backend/data/poi/` doubles as the live POI
# ingest output dir (a user's `just ingest` bakes e.g. `dk.pmtiles`+`dk.json`
# there), so tests MUST NOT read that dir directly — they'd discover the real
# sets too. Every test runs against an isolated tmp dir holding only this
# fixture (the `poi_dir` fixture below), and `backend/data/poi/*` except this
# file is git-ignored so runtime bakes never pollute the tree.
FIXTURE = POI_DIR / "pois.pmtiles"


@pytest.fixture
def poi_dir(tmp_path):
    """An isolated POI store dir holding only the committed fixture."""
    d = tmp_path / "poi"
    d.mkdir()
    shutil.copy(FIXTURE, d / "pois.pmtiles")
    return d


def center_tile(bounds: list[float], z: int) -> tuple[int, int]:
    lon = (bounds[0] + bounds[2]) / 2
    lat = (bounds[1] + bounds[3]) / 2
    n = 1 << z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


@pytest.fixture
def poi_client(isolated_runtime, poi_dir):
    from mivnav.api.app import app
    from mivnav.features.poi.routes import get_poi_store
    from mivnav.features.poi.store import PoiStore

    store = PoiStore(poi_dir)
    app.dependency_overrides[get_poi_store] = lambda: store
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_poi_store, None)


def fixture_set(client) -> dict:
    sets = client.get("/poi/catalog").json()["sets"]
    assert len(sets) == 1
    return sets[0]


def test_store_discovers_the_fixture_set(poi_dir):
    from mivnav.features.poi.store import PoiStore

    store = PoiStore(poi_dir)
    sets = store.sets()
    assert set(sets) == {"pois"}
    ps = sets["pois"]
    assert ps.sequence > 0
    layers = {v["id"] for v in ps.metadata.get("vector_layers", [])}
    assert layers == {"pois"}
    fields = ps.metadata["vector_layers"][0]["fields"]
    assert {"name", "kind", "min_zoom", "kind_detail"} <= set(fields)


def test_sidecarless_fixture_falls_back_to_id_and_mtime(poi_dir):
    """A bare ``<id>.pmtiles`` with no sidecar (the committed legacy fixture)
    still lists: name from the id (title-cased, since "pois" is not an ISO),
    region null, updated_at from the file mtime."""
    from datetime import datetime

    from mivnav.features.poi.store import PoiStore

    ps = PoiStore(poi_dir).sets()["pois"]
    assert ps.name == "Pois"  # id title-cased; not a valid ISO
    assert ps.region is None
    datetime.fromisoformat(ps.updated_at)  # ISO-8601 from the file mtime


def test_sidecarless_iso_named_file_falls_back_to_country(tmp_path):
    """A sidecar-less file whose id IS a valid ISO code falls back to the
    country name and a ``{"country": iso}`` region."""
    from mivnav.geo import countries
    from mivnav.features.poi.store import PoiStore

    root = tmp_path / "poi"
    root.mkdir()
    shutil.copy(FIXTURE, root / "dk.pmtiles")  # no sidecar
    ps = PoiStore(root).sets()["dk"]
    assert ps.name == countries.country_name("DK")
    assert ps.region == {"country": "DK"}


def test_catalog_lists_the_poi_set(poi_client):
    resp = poi_client.get("/poi/catalog")
    assert resp.status_code == 200
    assert "ETag" in resp.headers
    assert resp.headers["cache-control"] == "public, no-cache"
    (s,) = resp.json()["sets"]
    assert s["id"] == "pois"
    assert s["tiles"] == "/poi/tiles/pois/{z}/{x}/{y}"
    assert isinstance(s["sequence"], int) and s["sequence"] > 0
    w, so, e, n = s["bounds"]
    assert -180 <= w < e <= 180 and -90 <= so < n <= 90
    # the POI vector layer, NOT S-57 object classes
    assert {v["id"] for v in s["vector_layers"]} == {"pois"}

    # catalog revalidation
    resp304 = poi_client.get("/poi/catalog", headers={"If-None-Match": resp.headers["etag"]})
    assert resp304.status_code == 304


def test_known_tile_is_mvt(poi_client):
    s = fixture_set(poi_client)
    x, y = center_tile(s["bounds"], s["min_zoom"])
    resp = poi_client.get(f"/poi/tiles/{s['id']}/{s['min_zoom']}/{x}/{y}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    assert resp.headers["content-encoding"] == "gzip"
    # httpx transparently gunzips; MVT is protobuf whose first field is tag 0x1a
    assert resp.content[0] == 0x1A


def test_tile_etag_revalidation(poi_client):
    s = fixture_set(poi_client)
    x, y = center_tile(s["bounds"], s["min_zoom"])
    url = f"/poi/tiles/{s['id']}/{s['min_zoom']}/{x}/{y}"
    first = poi_client.get(url)
    etag = first.headers["etag"]
    assert etag == f'"{s["id"]}-{s["sequence"]}"'
    resp = poi_client.get(url, headers={"If-None-Match": etag})
    assert resp.status_code == 304
    assert resp.content == b""


def test_tile_gzip_not_accepted_is_decompressed(poi_client):
    s = fixture_set(poi_client)
    x, y = center_tile(s["bounds"], s["min_zoom"])
    resp = poi_client.get(
        f"/poi/tiles/{s['id']}/{s['min_zoom']}/{x}/{y}",
        headers={"Accept-Encoding": "identity"},
    )
    assert resp.status_code == 200
    assert "content-encoding" not in resp.headers
    assert resp.content[0] == 0x1A  # decompressed MVT


def test_missing_tile_404_no_body(poi_client):
    s = fixture_set(poi_client)
    # in z range, valid coordinates, far outside the extract's coverage
    resp = poi_client.get(f"/poi/tiles/{s['id']}/{s['max_zoom']}/0/0")
    assert resp.status_code == 404
    assert resp.content == b""
    assert resp.headers["cache-control"] == "no-store"


def test_unknown_set_404(poi_client):
    resp = poi_client.get("/poi/tiles/NOPE/10/0/0")
    assert resp.status_code == 404
    assert "unknown POI set" in resp.json()["detail"]
    assert resp.headers["cache-control"] == "no-store"


@pytest.fixture
def writable_poi_client(isolated_runtime, tmp_path):
    """A POI store pointed at a WRITABLE copy of the fixture dir, so a delete
    test frees a real file without touching the committed fixture."""
    from mivnav.api.app import app
    from mivnav.features.poi.routes import get_poi_store
    from mivnav.features.poi.store import PoiStore

    root = tmp_path / "poi"
    root.mkdir()
    shutil.copy(FIXTURE, root / "pois.pmtiles")
    store = PoiStore(root)
    app.dependency_overrides[get_poi_store] = lambda: store
    with TestClient(app) as c:
        yield c, root
    app.dependency_overrides.pop(get_poi_store, None)


def test_delete_removes_file_and_catalog_entry(writable_poi_client):
    client, root = writable_poi_client
    archive = root / "pois.pmtiles"
    assert archive.exists()
    assert len(client.get("/poi/catalog").json()["sets"]) == 1

    r = client.delete("/poi/sets/pois")
    assert r.status_code == 200
    assert r.json() == {"deleted": "pois"}
    assert not archive.exists()  # disk freed
    assert client.get("/poi/catalog").json()["sets"] == []  # store reflects it


def test_delete_unknown_set_404(writable_poi_client):
    client, root = writable_poi_client
    r = client.delete("/poi/sets/nope")
    assert r.status_code == 404
    assert "unknown POI set" in r.json()["detail"]
    assert (root / "pois.pmtiles").exists()  # nothing removed


def test_delete_traversal_id_escapes_nothing(writable_poi_client, tmp_path):
    client, root = writable_poi_client
    # A file OUTSIDE the POI dir a traversal-y id might try to reach.
    outside = tmp_path / "secret.pmtiles"
    outside.write_bytes(b"keep me")

    for bad in ("../secret", "..%2Fsecret", "....//secret", "/etc/passwd"):
        r = client.delete(f"/poi/sets/{bad}")
        assert r.status_code == 404
    assert outside.exists()  # never escaped poi.dir
    assert (root / "pois.pmtiles").exists()  # the real set is untouched


def test_delete_at_the_store_guards_traversal(poi_dir):
    """The store itself refuses a synthetic set id whose resolved path would
    sit outside `root` — the belt-and-braces guard, independent of the fact
    that such an id is never a known set in the first place."""
    from mivnav.features.poi.store import PoiStore

    store = PoiStore(poi_dir)
    # Unknown ids (including traversal-shaped ones) delete nothing.
    assert store.delete("../secret") is False
    assert store.delete("nope") is False
    assert (poi_dir / "pois.pmtiles").exists()


def test_providers_reports_the_poi_source(poi_client):
    by_id = {p["id"]: p for p in poi_client.get("/providers").json()["providers"]}
    assert "poi" in by_id
    poi = by_id["poi"]
    assert poi["kind"] == "tiled"
    assert poi["cache"] is None
    assert poi["refresh"]["mode"] == "sequence-rescan"
    assert poi["config_slice"] == "poi"
    assert isinstance(poi["stats"]["sets"], int)


# ---- /tiles/all: union serving across POI sets (#wuvqsnxy) -----------------
#
# Unlike the o-charts union (#qwxtvtwo), a POI set has no internal cells to
# run cross-set AUTHORITY over -- every set is already a complete, independent
# pre-baked archive, so the union is a plain tagged merge of whichever sets
# have a tile at this address. These tests exercise that merge plus the two
# things #qwxtvtwo's tests proved matter for any /tiles/all-shaped route:
# provenance tagging and registration order (a set literally named "all"
# would otherwise shadow the union route or vice versa).
#
# Both "sets" below are copies of the SAME committed fixture under different
# ids -- there is only one committed POI fixture, but two ids pointing at
# identical content is enough to prove the union carries BOTH sets' features,
# each correctly tagged, which is exactly what the merge logic needs to get
# right (mislabelling is silent: wrong provenance, not a crash).


@pytest.fixture
def two_poi_client(isolated_runtime, tmp_path):
    from mivnav.api.app import app
    from mivnav.features.poi.routes import get_poi_store
    from mivnav.features.poi.store import PoiStore

    root = tmp_path / "poi"
    root.mkdir()
    shutil.copy(FIXTURE, root / "seta.pmtiles")
    shutil.copy(FIXTURE, root / "setb.pmtiles")
    # rescan_interval=0: the ETag-bump test below mutates setb's mtime
    # out-of-band (no store.invalidate() call available for that, unlike
    # delete()) and must see it on the very next request, not after the
    # default 5s rescan throttle (mivnav.rescan.DEFAULT_RESCAN_INTERVAL).
    store = PoiStore(root, rescan_interval=0)
    app.dependency_overrides[get_poi_store] = lambda: store
    with TestClient(app) as c:
        yield c, store
    app.dependency_overrides.pop(get_poi_store, None)


def _seta_tile_coords(client) -> tuple[int, int, int]:
    by_id = {s["id"]: s for s in client.get("/poi/catalog").json()["sets"]}
    seta = by_id["seta"]
    z = seta["min_zoom"]
    x, y = center_tile(seta["bounds"], z)
    return z, x, y


def test_tiles_all_composites_both_sets_and_tags_provenance(two_poi_client) -> None:
    client, _ = two_poi_client
    z, x, y = _seta_tile_coords(client)

    solo = client.get(f"/poi/tiles/seta/{z}/{x}/{y}")
    assert solo.status_code == 200
    solo_tags = chartcore.tile_feature_tags(solo.content, "pois")
    assert solo_tags, "fixture must have features at this tile"
    assert all("set" not in t for t in solo_tags), (
        "additive, not a replacement: /tiles/{set_id}/... must carry no "
        "'set' tag -- that machinery only ever engages on the union path"
    )

    r = client.get(f"/poi/tiles/all/{z}/{x}/{y}")
    assert r.status_code == 200
    tags = chartcore.tile_feature_tags(r.content, "pois")
    assert {t.get("set") for t in tags} == {"seta", "setb"}, (
        f"both sets must contribute, each tagged with its own id: {tags}"
    )
    assert len(tags) == 2 * len(solo_tags), (
        "identical fixtures under two ids must double the feature count "
        "(a plain union, no de-dup/authority contest between POI sets)"
    )


def test_tiles_all_route_not_shadowed_by_a_set_literally_named_all(
    isolated_runtime, tmp_path
) -> None:
    """A set id of literally 'all' is not forbidden (a bbox region named
    "All", or a hand-placed all.pmtiles) -- the union route must still win,
    same guard as charts.py's /tiles/all registration-order test."""
    from mivnav.api.app import app
    from mivnav.features.poi.routes import get_poi_store
    from mivnav.features.poi.store import PoiStore

    root = tmp_path / "poi"
    root.mkdir()
    shutil.copy(FIXTURE, root / "all.pmtiles")
    shutil.copy(FIXTURE, root / "b.pmtiles")
    store = PoiStore(root)
    app.dependency_overrides[get_poi_store] = lambda: store
    try:
        with TestClient(app) as client:
            by_id = {s["id"]: s for s in client.get("/poi/catalog").json()["sets"]}
            z = by_id["all"]["min_zoom"]
            x, y = center_tile(by_id["all"]["bounds"], z)
            r = client.get(f"/poi/tiles/all/{z}/{x}/{y}")
            assert r.status_code == 200
            tags = chartcore.tile_feature_tags(r.content, "pois")
            assert {t.get("set") for t in tags} == {"all", "b"}, (
                "the /tiles/all UNION route must win over a literal set id "
                f"'all' -- a shadowed request would 404 as an unknown set or "
                f"serve only the 'all' set untagged, got {tags}"
            )
    finally:
        app.dependency_overrides.pop(get_poi_store, None)


def test_tiles_all_etag_304_and_bump_on_either_set(two_poi_client) -> None:
    client, store = two_poi_client
    z, x, y = _seta_tile_coords(client)
    url = f"/poi/tiles/all/{z}/{x}/{y}"
    # The first request only starts the (background) merge-table build and is
    # served unmerged, uncached, under a "-pending" ETag (poi-merge.md).
    deadline = time.time() + 10
    while True:
        r = client.get(url)
        if not r.headers["etag"].endswith('-pending"'):
            break
        assert r.headers["cache-control"] == "no-store"
        assert time.time() < deadline, "merge table never became ready"
        time.sleep(0.01)
    etag = r.headers["etag"]
    assert client.get(url, headers={"if-none-match": etag}).status_code == 304

    # touching only setb's file still bumps the union ETag
    setb_path = store.root / "setb.pmtiles"
    os.utime(
        setb_path,
        ns=(setb_path.stat().st_atime_ns, setb_path.stat().st_mtime_ns + 10_000_000),
    )
    r2 = client.get(url, headers={"if-none-match": etag})
    assert r2.status_code == 200
    assert r2.headers["etag"] != etag


def test_tiles_all_gzip_not_accepted_is_decompressed(two_poi_client) -> None:
    client, _ = two_poi_client
    z, x, y = _seta_tile_coords(client)
    resp = client.get(
        f"/poi/tiles/all/{z}/{x}/{y}", headers={"Accept-Encoding": "identity"}
    )
    assert resp.status_code == 200
    assert "content-encoding" not in resp.headers
    assert resp.content[0] == 0x1A  # decompressed MVT


def test_tiles_all_gzip_accepted(two_poi_client) -> None:
    client, _ = two_poi_client
    z, x, y = _seta_tile_coords(client)
    resp = client.get(f"/poi/tiles/all/{z}/{x}/{y}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    assert resp.headers.get("content-encoding") == "gzip"
    assert resp.content[0] == 0x1A  # httpx transparently gunzips


def test_tiles_all_404_when_no_set_covers(two_poi_client) -> None:
    client, _ = two_poi_client
    by_id = {s["id"]: s for s in client.get("/poi/catalog").json()["sets"]}
    max_zoom = by_id["seta"]["max_zoom"]
    r = client.get(f"/poi/tiles/all/{max_zoom}/0/0")
    assert r.status_code == 404
    assert r.content == b""
    assert r.headers["cache-control"] == "no-store"
