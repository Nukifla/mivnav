# SPDX-License-Identifier: GPL-2.0-only
"""Regression tests for the task #14 review findings on the serving path:
corrupt-archive robustness (finding 3), store lifetime semantics under
re-ingest (finding 4), graceful handling of unreadable archives (finding 5),
and HTTP conditional/content-negotiation edge cases (findings 10, 11).
"""

from __future__ import annotations

import os
import struct
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.charts.pmtiles import COMPRESSION_GZIP, PMTilesError, decompress
from mivnav.charts.store import ChartStore

from test_tiles import center_tile, fixture_set

SET_ID = "US5OAKIQ"


@contextmanager
def client_for(charts_dir: Path):
    """A TestClient bound to its own ChartStore (and an empty o-charts
    service — the developer machine may have real sets installed),
    restoring any prior dependency overrides (the session `client`
    fixture installs some)."""
    from mivnav.api.app import app
    from mivnav.api.charts import get_store
    from mivnav.features.ocharts.routes import get_service
    from mivnav.features.ocharts.service import OchartsService

    store = ChartStore(charts_dir)
    empty = charts_dir / "ocharts-empty"
    service = OchartsService(
        sets_dir=empty / "sets",
        daemon_dir=empty / "daemon",
        work_dir=empty / "work",
        warm_overview=False,
    )
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_service] = lambda: service
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


def fixture_bytes(charts_dir: Path) -> bytes:
    return (charts_dir / f"{SET_ID}.pmtiles").read_bytes()


def header_u64(buf: bytes, index: int) -> int:
    """One of the 11 u64 header fields (0 = root_offset, 6 = data_offset)."""
    return struct.unpack_from("<11Q", buf, 8)[index]


# ---- finding 3: zlib.error escaping decompress() ---------------------------


def test_decompress_zlib_error_is_pmtiles_error():
    # valid gzip header, corrupt deflate stream: gzip.decompress raises
    # zlib.error, which must surface as PMTilesError like other corruption
    corrupt = b"\x1f\x8b\x08\x00" + b"\x00" * 6 + b"\xff" * 8
    with pytest.raises(PMTilesError):
        decompress(COMPRESSION_GZIP, corrupt)


def test_corrupt_archive_is_skipped_not_fatal(charts_dir, tmp_path):
    good = fixture_bytes(charts_dir)
    (tmp_path / "GOOD.pmtiles").write_bytes(good)
    # corrupt the root directory's deflate stream (past the 10-byte gzip
    # header) so opening the archive hits zlib.error
    root_off = header_u64(good, 0)
    bad = bytearray(good)
    bad[root_off + 10 : root_off + 20] = b"\xff" * 10
    (tmp_path / "BAD.pmtiles").write_bytes(bytes(bad))

    store = ChartStore(tmp_path)
    sets = store.sets()  # must skip BAD, not raise
    assert set(sets) == {"GOOD"}


# ---- finding 4: a rescan must not close archives readers still hold --------


def test_reingest_keeps_inflight_archive_usable(charts_dir, tmp_path):
    src = tmp_path / f"{SET_ID}.pmtiles"
    src.write_bytes(fixture_bytes(charts_dir))
    # rescan on every access: a re-ingest is out-of-band, and the default
    # rate-limit would otherwise defer its pickup for a few seconds (A1).
    store = ChartStore(tmp_path, rescan_interval=0)
    cs = store.get(SET_ID)
    assert cs is not None

    # a re-ingest lands (new mtime -> new sequence) and a rescan picks it up
    st = src.stat()
    os.utime(src, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    fresh = store.get(SET_ID)
    assert fresh is not None and fresh.sequence != cs.sequence

    # the request that grabbed `cs` before the rescan is still in flight:
    # its archive must stay readable (the rescan used to close its mmap)
    assert cs.archive.metadata()["name"] == f"{SET_ID}.000"


# ---- finding 5: unreadable archive -> 503, not 500 --------------------------


def test_truncated_archive_tile_is_503_not_500(charts_dir, tmp_path):
    good = fixture_bytes(charts_dir)
    # header, directories and metadata intact; tile data missing — the
    # half-written-archive shape from the finding
    (tmp_path / f"{SET_ID}.pmtiles").write_bytes(good[: header_u64(good, 6)])
    with client_for(tmp_path) as client:
        cat = client.get("/catalog")
        assert cat.status_code == 200
        (s,) = cat.json()["sets"]
        x, y = center_tile(s["bounds"], s["min_zoom"])
        resp = client.get(f"/tiles/{SET_ID}/{s['min_zoom']}/{x}/{y}")
        assert resp.status_code == 503


# ---- finding 11: If-None-Match `*` and tag lists ----------------------------


def test_if_none_match_star_and_list(client):
    s = fixture_set(client)
    x, y = center_tile(s["bounds"], s["min_zoom"])
    url = f"/tiles/{s['id']}/{s['min_zoom']}/{x}/{y}"
    etag = f'"{s["id"]}-{s["sequence"]}"'

    # RFC 9110: `*` matches any current representation (MUST)
    assert client.get(url, headers={"If-None-Match": "*"}).status_code == 304
    assert client.get("/catalog", headers={"If-None-Match": "*"}).status_code == 304
    # a tag list containing ours revalidates
    resp = client.get(url, headers={"If-None-Match": f'W/"nope", {etag}'})
    assert resp.status_code == 304
    # a non-matching list must not
    assert client.get(url, headers={"If-None-Match": '"nope"'}).status_code == 200


# ---- finding 10: Accept-Encoding q-values -----------------------------------


def test_accept_encoding_gzip_q0_gets_identity(client):
    s = fixture_set(client)
    x, y = center_tile(s["bounds"], s["min_zoom"])
    url = f"/tiles/{s['id']}/{s['min_zoom']}/{x}/{y}"

    resp = client.get(url, headers={"Accept-Encoding": "gzip;q=0"})
    assert resp.status_code == 200
    assert "content-encoding" not in resp.headers
    assert resp.content[0] == 0x1A  # decompressed MVT

    # a nonzero q still gets the stored gzip passthrough
    resp = client.get(url, headers={"Accept-Encoding": "br, gzip;q=0.5"})
    assert resp.status_code == 200
    assert resp.headers.get("content-encoding") == "gzip"
