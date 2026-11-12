# SPDX-License-Identifier: GPL-2.0-only
"""The satellite feature module: raster PMTiles writer, serving, and the
region-bake ingest — all against isolated tmp dirs, never the live data dir and
never the network.

Mirrors ``tests/test_poi.py`` (serve: catalog, tile content-type + ETag,
404-empty, delete) and ``tests/test_ingest_poi.py`` (bake: a tiny fixture bake
with the tile fetch stubbed). The imagery-specific assertions are the two things
that differ from POI: a served tile carries an IMAGE content-type, and the tile
ETag versions on the schema token.
"""

import pytest
from fastapi.testclient import TestClient

from mivnav.charts.pmtiles import Archive, TILE_TYPE_JPEG, TILE_TYPE_PNG
from mivnav.features.satellite.pmtiles_writer import write_raster_pmtiles
from mivnav.features.satellite.routes import SATELLITE_TILE_SCHEMA_VERSION

# A one-pixel PNG and a two-byte JPEG-ish blob. The bytes need not be valid
# images — the serving path returns them untouched and never decodes them; only
# the Content-Type (branched off the PMTiles tile_type) is under test.
PNG_1PX = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)
JPEG_MAGIC = b"\xff\xd8\xff\xe0stub-jpeg"


def _bake_fixture(root, set_id="denmark", *, tile_type=TILE_TYPE_JPEG, tile_format="jpg"):
    """Bake a tiny 2-zoom raster set into ``root`` with a matching sidecar, the
    way the runner would, and return the archive path."""
    from mivnav.features.satellite.sidecar import write_sidecar

    blob = JPEG_MAGIC if tile_type == TILE_TYPE_JPEG else PNG_1PX
    tiles = [(0, 0, 0, blob), (1, 0, 0, blob), (1, 1, 1, blob)]
    out = root / f"{set_id}.pmtiles"
    write_raster_pmtiles(
        out,
        iter(tiles),
        name="Denmark",
        bounds=(8.0, 54.5, 13.0, 57.8),
        min_zoom=0,
        max_zoom=1,
        tile_type=tile_type,
        tile_format=tile_format,
    )
    write_sidecar(
        root,
        set_id,
        name="Denmark",
        source="eox-sentinel2-cloudless",
        tile_format=tile_format,
        bbox=(8.0, 54.5, 13.0, 57.8),
    )
    return out


@pytest.fixture
def sat_dir(tmp_path):
    d = tmp_path / "satellite"
    d.mkdir()
    _bake_fixture(d)
    return d


@pytest.fixture
def sat_client(isolated_runtime, sat_dir):
    from mivnav.api.app import app
    from mivnav.features.satellite.routes import get_satellite_store
    from mivnav.features.satellite.store import SatelliteStore

    store = SatelliteStore(sat_dir)
    app.dependency_overrides[get_satellite_store] = lambda: store
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_satellite_store, None)


def fixture_set(client) -> dict:
    sets = client.get("/satellite/catalog").json()["sets"]
    assert len(sets) == 1
    return sets[0]


# --- The raster PMTiles writer -------------------------------------------


def test_writer_round_trips_and_dedups(tmp_path):
    """A written raster archive reads back through the generic reader, with the
    raster tile_type, uncompressed tiles, and byte-identical tiles deduped."""
    tiles = [(0, 0, 0, b"AAA"), (1, 0, 0, b"BBB"), (1, 1, 1, b"AAA")]
    out = tmp_path / "r.pmtiles"
    n = write_raster_pmtiles(
        out, iter(tiles), name="R", bounds=(-10, -20, 10, 20),
        min_zoom=0, max_zoom=1, tile_type=TILE_TYPE_PNG, tile_format="png",
    )
    assert n == 3
    a = Archive(out)
    assert a.header.tile_type == TILE_TYPE_PNG
    assert a.header.tile_compression == 1  # COMPRESSION_NONE — raster stays raw
    assert a.header.addressed_tiles == 3
    assert a.header.tile_contents == 2  # (1,1,1) deduped onto (0,0,0)
    assert a.tile_data(0, 0, 0) == b"AAA"
    assert a.tile_data(1, 0, 0) == b"BBB"
    assert a.tile_data(1, 1, 1) == b"AAA"
    assert a.tile_data(1, 0, 1) is None  # a real miss
    assert a.metadata()["format"] == "png"


def test_writer_spills_to_leaf_directories(tmp_path):
    """More than MAX_DIR_ENTRIES distinct tiles force a leaf-directory level;
    lookups still resolve (streaming writer, not an in-RAM dict)."""
    tiles = ((7, x, y, f"t{x},{y}".encode()) for x in range(128) for y in range(128))
    out = tmp_path / "big.pmtiles"
    write_raster_pmtiles(
        out, tiles, name="big", bounds=(-180, -85, 180, 85),
        min_zoom=7, max_zoom=7, tile_type=TILE_TYPE_JPEG, tile_format="jpg",
    )
    a = Archive(out)
    assert a.header.leaf_length > 0
    assert a.tile_data(7, 0, 0) == b"t0,0"
    assert a.tile_data(7, 64, 64) == b"t64,64"


# --- Serving --------------------------------------------------------------


def test_catalog_lists_the_set(sat_client):
    resp = sat_client.get("/satellite/catalog")
    assert resp.status_code == 200
    assert "ETag" in resp.headers
    assert resp.headers["cache-control"] == "public, no-cache"
    (s,) = resp.json()["sets"]
    assert s["id"] == "denmark"
    assert s["name"] == "Denmark"
    assert s["tiles"] == "/satellite/tiles/denmark/{z}/{x}/{y}"
    assert s["tile_format"] == "jpg"
    assert s["region"] == {"bbox": [8.0, 54.5, 13.0, 57.8], "source": "eox-sentinel2-cloudless"}
    w, so, e, n = s["bounds"]
    assert -180 <= w < e <= 180 and -90 <= so < n <= 90

    resp304 = sat_client.get(
        "/satellite/catalog", headers={"If-None-Match": resp.headers["etag"]}
    )
    assert resp304.status_code == 304


def test_served_tile_has_image_content_type(sat_client):
    """The imagery-specific assertion: a raster tile is served as an image, not
    as MVT/octet-stream."""
    s = fixture_set(sat_client)
    resp = sat_client.get(f"/satellite/tiles/{s['id']}/0/0/0")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"  # tile_type JPEG
    assert resp.content[:2] == b"\xff\xd8"  # the stub's JPEG magic, untouched


def test_png_set_serves_image_png(tmp_path, isolated_runtime):
    from mivnav.api.app import app
    from mivnav.features.satellite.routes import get_satellite_store
    from mivnav.features.satellite.store import SatelliteStore

    root = tmp_path / "satellite"
    root.mkdir()
    _bake_fixture(root, "aerial", tile_type=TILE_TYPE_PNG, tile_format="png")
    store = SatelliteStore(root)
    app.dependency_overrides[get_satellite_store] = lambda: store
    try:
        with TestClient(app) as c:
            resp = c.get("/satellite/tiles/aerial/0/0/0")
            assert resp.status_code == 200
            assert resp.headers["content-type"] == "image/png"
            assert resp.content[:8] == PNG_1PX[:8]
    finally:
        app.dependency_overrides.pop(get_satellite_store, None)


def test_tile_etag_versions_on_schema_token(sat_client):
    """The tile ETag carries the schema version, so a bump invalidates client
    caches even when the archive's sequence is unchanged (mirrors o-charts)."""
    s = fixture_set(sat_client)
    url = f"/satellite/tiles/{s['id']}/0/0/0"
    first = sat_client.get(url)
    etag = first.headers["etag"]
    assert etag == f'"{s["id"]}-{s["sequence"]}-v{SATELLITE_TILE_SCHEMA_VERSION}"'
    # revalidation 304
    resp = sat_client.get(url, headers={"If-None-Match": etag})
    assert resp.status_code == 304
    assert resp.content == b""
    # a stale schema token does NOT revalidate — the client is handed fresh bytes
    stale = f'"{s["id"]}-{s["sequence"]}-v{SATELLITE_TILE_SCHEMA_VERSION + 1}"'
    resp2 = sat_client.get(url, headers={"If-None-Match": stale})
    assert resp2.status_code == 200


def test_missing_tile_404_no_body(sat_client):
    s = fixture_set(sat_client)
    # in z range, valid coords, no tile there (the fixture has only 3 tiles)
    resp = sat_client.get(f"/satellite/tiles/{s['id']}/1/0/1")
    assert resp.status_code == 404
    assert resp.content == b""
    assert resp.headers["cache-control"] == "no-store"


def test_unknown_set_404(sat_client):
    resp = sat_client.get("/satellite/tiles/NOPE/0/0/0")
    assert resp.status_code == 404
    assert "unknown satellite set" in resp.json()["detail"]
    assert resp.headers["cache-control"] == "no-store"


def test_delete_removes_pmtiles_and_sidecar(tmp_path, isolated_runtime):
    from mivnav.api.app import app
    from mivnav.features.satellite.routes import get_satellite_store
    from mivnav.features.satellite.store import SatelliteStore

    root = tmp_path / "satellite"
    root.mkdir()
    _bake_fixture(root, "denmark")
    store = SatelliteStore(root)
    app.dependency_overrides[get_satellite_store] = lambda: store
    try:
        with TestClient(app) as c:
            assert len(c.get("/satellite/catalog").json()["sets"]) == 1
            r = c.delete("/satellite/sets/denmark")
            assert r.status_code == 200 and r.json() == {"deleted": "denmark"}
            assert not (root / "denmark.pmtiles").exists()
            assert not (root / "denmark.json").exists()  # sidecar gone, no orphan
            assert c.get("/satellite/catalog").json()["sets"] == []
    finally:
        app.dependency_overrides.pop(get_satellite_store, None)


# --- The region-bake ingest (network stubbed) ----------------------------


@pytest.fixture
def bake_client(tmp_path, monkeypatch, isolated_runtime):
    """A TestClient wired to a real SatelliteStore (for the surviving catalog/
    tile/sources routes), plus a plain ``SatelliteIngestRunner`` driven
    directly — the ``POST|GET /ingest/satellite`` trigger/poll pair it used to
    be reached through is retired (superseded by the generic ``PUT
    /datasets/{id}`` + ``POST /datasets/{id}/ingest``), so these tests call
    the runner instead of going through HTTP for the bake itself. The per-tile
    HTTP fetch is stubbed so a real raster PMTiles is baked without touching
    the network."""
    from mivnav.api.app import app
    from mivnav.features.satellite.routes import get_satellite_store
    from mivnav.features.satellite.config import SatelliteConfig
    from mivnav.features.satellite import ingest as sat_ingest
    from mivnav.features.satellite.ingest import SatelliteIngestRunner
    from mivnav.features.satellite.store import SatelliteStore

    root = tmp_path / "satellite"
    root.mkdir()
    store = SatelliteStore(root, rescan_interval=0)
    # A small config: one bakeable source, a shallow zoom range so a tiny bbox
    # is only a handful of tiles.
    cfg = SatelliteConfig(min_zoom=0, max_zoom=2)
    runner = SatelliteIngestRunner(store, satellite_config=lambda: cfg)

    calls = {"n": 0}

    def fake_fetch(http, source, z, x, y, **kw):
        calls["n"] += 1
        return JPEG_MAGIC  # every requested tile exists

    monkeypatch.setattr(sat_ingest, "fetch_tile", fake_fetch)

    app.dependency_overrides[get_satellite_store] = lambda: store
    with TestClient(app) as c:
        yield c, root, calls, runner
    app.dependency_overrides.pop(get_satellite_store, None)


def _wait_done(runner, timeout=10.0):
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        status = runner.status()
        if status["state"] in ("done", "error"):
            return status
        time.sleep(0.02)
    raise AssertionError("satellite bake did not finish in time")


def test_status_idle_before_any_run(bake_client):
    _, _, _, runner = bake_client
    assert runner.status()["state"] == "idle"


def test_bake_writes_readable_pmtiles_and_serves_it(bake_client):
    client, root, calls, runner = bake_client
    runner.ingest(source_id="eox-sentinel2-cloudless", bbox=(8.0, 54.5, 13.0, 57.8))
    status = _wait_done(runner)
    assert status["state"] == "done", status
    assert status["tile_count"] > 0
    assert calls["n"] > 0  # tiles were fetched
    # Progress reporting (BaseJobStatus.task/current/total/log): the finished
    # bake attempted every addressable tile (current == total, the attempted
    # count, not just written), and the log recorded real per-zoom activity.
    assert status["current"] == status["total"] > 0
    assert len(status["log"]) > 0
    assert any("wrote" in line for line in status["log"])

    # A real, readable raster archive landed on disk (id = slug of the source's
    # display name, since no explicit name was given).
    set_id = "eox-sentinel-2-cloudless"
    baked = root / f"{set_id}.pmtiles"
    assert baked.is_file()
    a = Archive(baked)
    assert a.header.tile_type == TILE_TYPE_JPEG
    assert a.header.max_zoom == 2

    # And it flows through the catalog + tile serving (store was invalidated).
    sets = {s["id"]: s for s in client.get("/satellite/catalog").json()["sets"]}
    assert set_id in sets
    tile = client.get(f"/satellite/tiles/{set_id}/0/0/0")
    assert tile.status_code == 200
    assert tile.headers["content-type"] == "image/jpeg"


def test_bake_named_set_slugs_the_name(bake_client):
    _, root, _, runner = bake_client
    runner.ingest(
        source_id="eox-sentinel2-cloudless",
        bbox=(8.0, 54.5, 13.0, 57.8),
        name="Danish Waters",
    )
    _wait_done(runner)
    assert (root / "danish-waters.pmtiles").is_file()
    import json as _json

    meta = _json.loads((root / "danish-waters.json").read_text())
    assert meta["name"] == "Danish Waters"
    assert meta["source"] == "eox-sentinel2-cloudless"
    assert meta["tile_format"] == "jpg"
    assert meta["bbox"] == [8.0, 54.5, 13.0, 57.8]


def test_dataset_scoped_runner_names_the_archive_after_the_dataset_id(
    tmp_path, monkeypatch
):
    """The generic ``/datasets/{id}/ingest`` path
    (``_satellite_runner_factory``, mivnav.features.satellite.provider) binds
    a runner to ``data_root/satellite/<dataset id>`` and passes that id
    through as ``dataset_id`` — the bake must write ``<dataset_id>.pmtiles``,
    not a slug of the display name (which a dataset's own id can freely
    differ from), or the file is invisible to
    mivnav.rescan.pmtiles_candidates's nested-layout lookup even though the
    bake itself reports success (wptyyquu)."""
    from mivnav.features.satellite import ingest as sat_ingest
    from mivnav.features.satellite.config import SatelliteConfig
    from mivnav.features.satellite.ingest import SatelliteIngestRunner
    from mivnav.features.satellite.store import SatelliteStore

    root = tmp_path / "my-dataset"
    root.mkdir(parents=True)
    store = SatelliteStore(root, rescan_interval=0)
    cfg = SatelliteConfig(min_zoom=0, max_zoom=2)
    # dataset_id != the "Denmark" display name's slug ("denmark") — the
    # whole point being tested.
    runner = SatelliteIngestRunner(
        store, satellite_config=lambda: cfg, dataset_id="my-dataset"
    )
    monkeypatch.setattr(sat_ingest, "fetch_tile", lambda *a, **kw: JPEG_MAGIC)

    runner.ingest(source_id="eox-sentinel2-cloudless", bbox=(8.0, 54.5, 13.0, 57.8), name="Denmark")
    status = _wait_done(runner)
    assert status["state"] == "done", status

    assert (root / "my-dataset.pmtiles").is_file()
    assert not (root / "denmark.pmtiles").exists()
    assert "my-dataset" in store.sets()


def test_bake_rejects_online_only_source(bake_client):
    """ESRI is configured online-only (not bakeable); ``ingest()`` raises
    synchronously (the retired route turned this into a 409; the new generic
    ``POST /datasets/{id}/ingest`` does too, via the same runner)."""
    from mivnav.features.satellite.ingest import SatelliteIngestError

    _, root, _, runner = bake_client
    with pytest.raises(SatelliteIngestError, match="online-only"):
        runner.ingest(source_id="esri-world-imagery", bbox=(8.0, 54.5, 13.0, 57.8))
    assert not any(root.glob("*.pmtiles"))


def test_bake_rejects_unknown_source(bake_client):
    from mivnav.features.satellite.ingest import SatelliteIngestError

    _, _, _, runner = bake_client
    with pytest.raises(SatelliteIngestError, match="unknown satellite source"):
        runner.ingest(source_id="nope", bbox=(8.0, 54.5, 13.0, 57.8))


def test_sources_endpoint_lists_configured_sources(bake_client):
    client, _, _, _ = bake_client
    sources = {s["id"]: s for s in client.get("/ingest/satellite/sources").json()["sources"]}
    assert "esri-world-imagery" in sources and "eox-sentinel2-cloudless" in sources
    assert sources["esri-world-imagery"]["bakeable"] is False
    assert sources["eox-sentinel2-cloudless"]["bakeable"] is True
    assert "{z}" in sources["esri-world-imagery"]["url_template"]


def test_unified_sources_list_baked_first_with_requires_network(bake_client):
    """``GET /satellite/sources`` (jt zsukvvxq) answers "what imagery can I
    show" in ONE list — the join the frontend used to do across
    ``/satellite/catalog`` and ``/ingest/satellite/sources``.

    Pins the three properties a consumer depends on: every row carries
    ``requires_network`` (the machine-readable state an offline mode filters
    on, so the client never infers a tier from an id), a backend-supplied
    ``tiles`` template for BOTH tiers, and baked-first ordering so a
    first-match lookup keeps the offline-wins precedence of the retired
    client-side resolve. A baked set also inherits its origin source's
    attribution here rather than in the client."""
    client, _, _, runner = bake_client
    runner.ingest(
        source_id="eox-sentinel2-cloudless", bbox=(8.0, 54.5, 13.0, 57.8), name="Danish Waters"
    )
    assert _wait_done(runner)["state"] == "done"

    resp = client.get("/satellite/sources")
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    rows = resp.json()["sources"]

    # Baked first, then every configured online source.
    assert rows[0]["id"] == "danish-waters"
    assert [r["requires_network"] for r in rows] == [False] + [True] * (len(rows) - 1)

    baked = rows[0]
    assert baked["tiles"] == "/satellite/tiles/danish-waters/{z}/{x}/{y}"
    assert baked["bounds"] is not None and len(baked["bounds"]) == 4
    assert baked["sequence"] > 0
    # Credit borrowed from the source it was cut from — the client no longer
    # has to know a baked set has an origin.
    assert baked["attribution"] and baked["attribution"] != "Satellite imagery"
    assert baked["badge"].startswith("Offline")

    by_id = {r["id"]: r for r in rows}
    esri = by_id["esri-world-imagery"]
    assert esri["requires_network"] is True
    assert "{z}" in esri["tiles"]
    assert esri["bounds"] is None
    assert esri["sequence"] == 0


def test_empty_bake_fails_when_all_tiles_missing(tmp_path, monkeypatch, isolated_runtime):
    """A bbox a source has no imagery for (every tile 404s → fetch returns None)
    must fail loudly, not publish an empty imagery set."""
    from mivnav.features.satellite.config import SatelliteConfig
    from mivnav.features.satellite import ingest as sat_ingest
    from mivnav.features.satellite.ingest import SatelliteIngestRunner
    from mivnav.features.satellite.store import SatelliteStore

    root = tmp_path / "satellite"
    root.mkdir()
    store = SatelliteStore(root, rescan_interval=0)
    runner = SatelliteIngestRunner(
        store, satellite_config=lambda: SatelliteConfig(min_zoom=0, max_zoom=1)
    )
    monkeypatch.setattr(sat_ingest, "fetch_tile", lambda *a, **k: None)  # all miss

    import time

    runner.ingest(source_id="eox-sentinel2-cloudless", bbox=(8.0, 54.5, 13.0, 57.8))
    for _ in range(500):
        if runner.status()["state"] in ("done", "error"):
            break
        time.sleep(0.01)
    assert runner.status()["state"] == "error"
    assert "no tiles" in runner.status()["error"]
    assert not any(root.glob("*.pmtiles"))  # no empty set left behind


def test_tile_range_covers_bbox():
    """The Slippy-map tile range: north maps to the smaller y, and everything
    clamps to the grid."""
    from mivnav.features.satellite.ingest import tile_range

    x_min, y_min, x_max, y_max = tile_range((8.0, 54.5, 13.0, 57.8), 8)
    assert x_min <= x_max and y_min <= y_max
    n = 1 << 8
    assert 0 <= x_min and x_max < n and 0 <= y_min and y_max < n
    # z0 is one tile.
    assert tile_range((-180, -85, 180, 85), 0) == (0, 0, 0, 0)
