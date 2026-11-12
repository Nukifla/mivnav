# SPDX-License-Identifier: GPL-2.0-only
import hashlib
import math


def center_tile(bounds: list[float], z: int) -> tuple[int, int]:
    """Web-mercator tile containing the bounds' center."""
    lon = (bounds[0] + bounds[2]) / 2
    lat = (bounds[1] + bounds[3]) / 2
    n = 1 << z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def fixture_set(client) -> dict:
    sets = client.get("/catalog").json()["sets"]
    assert len(sets) == 1
    return sets[0]


def test_catalog_lists_fixture_set(client):
    resp = client.get("/catalog")
    assert resp.status_code == 200
    assert "ETag" in resp.headers
    assert resp.headers["cache-control"] == "public, no-cache"
    (s,) = resp.json()["sets"]
    assert s["id"] == "US5OAKIQ"
    assert s["name"] == "US5OAKIQ.000"
    assert s["min_zoom"] == 10
    assert s["max_zoom"] == 16
    assert s["tiles"] == "/tiles/US5OAKIQ/{z}/{x}/{y}"
    assert isinstance(s["sequence"], int) and s["sequence"] > 0
    # #snyzntrn: a pre-baked PMTiles set, as distinct from an on-demand
    # o-charts one (see test_ocharts_serving.py's catalog entry test) — the
    # frontend style generator sorts on this to decide "own MapLibre source"
    # vs. "fold into chart-all".
    assert s["kind"] == "pmtiles"
    w, so, e, n = s["bounds"]
    assert -180 <= w < e <= 180 and -90 <= so < n <= 90

    # vector_layers from the PMTiles metadata: the style generator's input
    layers = {v["id"] for v in s["vector_layers"]}
    assert {"DEPARE", "DRGARE", "DEPCNT", "LNDARE"} <= layers
    # no `_nodata`: the cell's M_COVR declares coverage (CATCOV=1) and never
    # declares an area uncovered (CATCOV=2), so it makes no no-data claim.
    # It used to advertise the layer because the tiler inferred "no data"
    # wherever the tile grid overhung the coverage rectangle — an inference
    # from absent information, and the grey that swamped the chart.
    assert "_nodata" not in layers
    for v in s["vector_layers"]:
        assert v["minzoom"] == s["min_zoom"]
        assert v["maxzoom"] == s["max_zoom"]

    # catalog revalidation
    resp304 = client.get("/catalog", headers={"If-None-Match": resp.headers["etag"]})
    assert resp304.status_code == 304


def test_catalog_etag_is_not_the_pre_kind_digest(client):
    """The catalog ETag must version on the `kind` field (#snyzntrn), not
    just id+sequence -- otherwise a client whose stored ETag came from
    before `kind` existed keeps matching the (unversioned) digest forever,
    304s indefinitely, and never receives a body carrying `kind` at all. See
    the digest's own comment in mivnav.api.charts.catalog for the full
    argument (mirrors TILE_SCHEMA_VERSION's for the tile ETag).

    Simulated here by recomputing the OLD (pre-#snyzntrn) digest formula
    over today's entries and asserting it neither matches today's real ETag
    nor still 304s."""
    resp = client.get("/catalog")
    entries = resp.json()["sets"]
    old_digest = hashlib.sha1(
        ";".join(f"{e['id']}:{e['sequence']}" for e in entries).encode()
    ).hexdigest()[:16]
    old_etag = f'"{old_digest}"'
    assert resp.headers["etag"] != old_etag
    stale = client.get("/catalog", headers={"If-None-Match": old_etag})
    assert stale.status_code == 200


def test_known_tile_is_mvt(client):
    s = fixture_set(client)
    x, y = center_tile(s["bounds"], s["min_zoom"])
    resp = client.get(f"/tiles/{s['id']}/{s['min_zoom']}/{x}/{y}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    # stored gzip is passed through, not re-compressed
    assert resp.headers["content-encoding"] == "gzip"
    # httpx transparently gunzips; MVT is protobuf whose first field is
    # `layers = 3` (tag 0x1a)
    assert resp.content[0] == 0x1A
    assert len(resp.content) > 100


def test_tile_etag_revalidation(client):
    s = fixture_set(client)
    x, y = center_tile(s["bounds"], s["min_zoom"])
    url = f"/tiles/{s['id']}/{s['min_zoom']}/{x}/{y}"
    first = client.get(url)
    etag = first.headers["etag"]
    assert etag == f'"{s["id"]}-{s["sequence"]}"'
    resp = client.get(url, headers={"If-None-Match": etag})
    assert resp.status_code == 304
    assert resp.content == b""


def test_tile_gzip_not_accepted_is_decompressed(client):
    s = fixture_set(client)
    x, y = center_tile(s["bounds"], s["min_zoom"])
    resp = client.get(
        f"/tiles/{s['id']}/{s['min_zoom']}/{x}/{y}",
        headers={"Accept-Encoding": "identity"},
    )
    assert resp.status_code == 200
    assert "content-encoding" not in resp.headers
    assert resp.content[0] == 0x1A


def test_missing_tile_404_no_body(client):
    s = fixture_set(client)
    # in z range, valid coordinates, far outside the cell's coverage
    resp = client.get(f"/tiles/{s['id']}/{s['max_zoom']}/0/0")
    assert resp.status_code == 404
    assert resp.content == b""
    # a negative result must not be durably retained: an empty tile can be
    # transient (re-ingested later), so it is no-store, not the no-cache the
    # successful tiles carry — otherwise a momentary gap is a permanent hole.
    assert resp.headers["cache-control"] == "no-store"


def test_out_of_range_coords_404(client):
    s = fixture_set(client)
    resp = client.get(f"/tiles/{s['id']}/10/{1 << 10}/0")
    assert resp.status_code == 404


def test_unknown_set_404(client):
    resp = client.get("/tiles/NOPE/10/0/0")
    assert resp.status_code == 404
    assert "unknown chart set" in resp.json()["detail"]
    assert resp.headers["cache-control"] == "no-store"
