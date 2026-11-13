# SPDX-License-Identifier: GPL-2.0-only
"""o-charts serving path: synthetic plain .senc sets through catalog +
tiles, credential-free (the .senc path never touches the daemon)."""

import logging
import math
import os
from pathlib import Path

import chartcore
import pytest
from fastapi.testclient import TestClient

from mivnav.features.ocharts.service import MAX_CELLS_PER_TILE, TILE_SCHEMA_VERSION
from mivnav.features.ocharts.sets import OchartsSet
from senc_fixture import point_cell


def tile_of(lat: float, lon: float, z: int) -> tuple[int, int]:
    n = 1 << z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


@pytest.fixture()
def ocharts_env(tmp_path: Path):
    """A fresh app client whose ocharts dir has one two-cell set."""
    sets_dir = tmp_path / "ocharts"
    set_dir = sets_dir / "oeuSENC-TEST1"
    set_dir.mkdir(parents=True)
    point_cell(set_dir / "OC-TEST-1.senc", name="OC-TEST-1", bounds=(11.0, 54.0, 11.2, 54.2))
    point_cell(set_dir / "OC-TEST-2.senc", name="OC-TEST-2", bounds=(11.2, 54.0, 11.4, 54.2))
    (set_dir / "keys.xml").write_text(
        "<keyList><Chart><FileName>OC-TEST-1</FileName>"
        "<RInstallKey>fabricated</RInstallKey></Chart>"
        "<ChartInfo>Test Set</ChartInfo><Edition>2026/01-1</Edition></keyList>"
    )

    from mivnav.api.app import app
    from mivnav.api.charts import get_store
    from mivnav.features.ocharts.routes import get_service
    from mivnav.charts.store import ChartStore
    from mivnav.features.ocharts.service import OchartsService

    service = OchartsService(
        sets_dir=sets_dir,
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        # detect directory changes on every access, so the serving tests
        # below see an out-of-band edit immediately; the rate limiting the
        # default carries has its own tests (sets_scan_is_rate_limited).
        rescan_interval=0,
        # Pin "no S-52 lookup data" explicitly (#P0-S52-AMBIENT) rather than
        # relying on `_load_s52`'s fallback to `chartcore.s52_default_cache_dir()`
        # happening to be empty on whoever's machine runs this. That fallback is a
        # real, git-ignored, machine-local cache (`chartcore ingest --fetch-s52`
        # populates it once, forever, per the docs) — so this test file silently
        # depended on nobody ever having run that command on this checkout.
        # Several tests below (test_etag_versions_on_chart_detail_so_a_declutter_
        # change_isnt_stale's docstring, _cell_with_landmark's) already assert in
        # prose that "no S-52 data" holds; this makes it true instead of assumed.
        # A nonexistent directory makes `_load_s52` fail closed to `self._s52 =
        # None` without ever touching the ambient cache.
        s52_path=tmp_path / "no-s52-data",
    )
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_store] = lambda: ChartStore(tmp_path / "empty-pmtiles")
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service, set_dir
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)


def _catalog_set(client) -> dict:
    body = client.get("/catalog").json()
    assert len(body["sets"]) == 1
    return body["sets"][0]


def test_catalog_entry_shape(ocharts_env) -> None:
    client, service, _ = ocharts_env
    entry = _catalog_set(client)
    assert entry["id"] == "oeuSENC-TEST1"
    assert entry["name"] == "Test Set"
    w, s, e, n = entry["bounds"]
    assert (round(w, 3), round(s, 3), round(e, 3), round(n, 3)) == (11.0, 54.0, 11.4, 54.2)
    assert entry["tiles"] == "/tiles/oeuSENC-TEST1/{z}/{x}/{y}"
    assert (entry["min_zoom"], entry["max_zoom"]) == (10, 16)
    assert {v["id"] for v in entry["vector_layers"]} >= {"DEPARE", "_nodata"}
    # #snyzntrn: the frontend style generator's own/union source split keys
    # on this, unlike a PMTiles entry (test_tiles.py's kind == "pmtiles").
    assert entry["kind"] == "ocharts"


def test_tile_served_gzipped_and_valid_mvt(ocharts_env) -> None:
    client, service, set_dir = ocharts_env
    x, y = tile_of(54.1, 11.1, 12)
    before = sorted(os.listdir(set_dir))
    r = client.get(f"/tiles/oeuSENC-TEST1/12/{x}/{y}", headers={"accept-encoding": "identity"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.mapbox-vector-tile")
    layers = chartcore.tile_layers(r.content)
    assert "LIGHTS" in layers
    # memory-only: serving wrote nothing into the set directory
    assert sorted(os.listdir(set_dir)) == before

    # gzip negotiation
    rz = client.get(f"/tiles/oeuSENC-TEST1/12/{x}/{y}", headers={"accept-encoding": "gzip"})
    assert rz.headers.get("content-encoding") == "gzip"
    # TestClient auto-decodes gzip bodies; both variants must decode alike
    assert chartcore.tile_layers(rz.content) == layers


def test_aid_group_tag_reaches_the_served_tile(tmp_path: Path) -> None:
    """A lit buoy with a topmark is three co-located S-57 objects; the chartcore
    derive stamps a shared `aid_group` id on each (co-location fallback here —
    the OSENC path carries no LNAM_REFS). It must survive tiling into the served
    tile so the info panel can fold them into one aid."""
    from senc_fixture import aid_group_cell

    def build(set_dir: Path) -> None:
        aid_group_cell(set_dir / "AIDGRP.senc", "AIDGRP")

    gen = _serving_env(tmp_path, build)
    client, _ = next(gen)
    try:
        # z14: harbour scale, where even a SCAMIN-defaulted point symbol serves.
        x, y = tile_of(54.1, 11.1, 14)
        r = client.get(f"/tiles/oeuSENC-ZOOM/14/{x}/{y}")
        assert r.status_code == 200
        groups = {}
        for layer in ("ATON", "TOPMAR", "LIGHTS"):
            tags = chartcore.tile_feature_tags(r.content, layer)
            assert tags, f"{layer} missing from tile"
            ids = {t.get("aid_group") for t in tags}
            assert None not in ids, f"{layer} feature lacks aid_group"
            groups[layer] = ids
        # all three components share ONE id — they are one physical aid
        all_ids = set().union(*groups.values())
        assert len(all_ids) == 1, f"components disagree on aid_group: {groups}"
    finally:
        gen.close()


def test_multi_cell_tile_merges_both_cells(ocharts_env) -> None:
    client, service, _ = ocharts_env
    # z10 tile spans both cells' extents (tile width 0.35 degrees)
    x, y = tile_of(54.1, 11.2, 10)
    r = client.get(f"/tiles/oeuSENC-TEST1/10/{x}/{y}")
    assert r.status_code == 200
    assert "LIGHTS" in chartcore.tile_layers(r.content)
    # both cells were decoded to build this tile
    assert service.cells.stats()["loads"] == 2


def test_empty_tile_404_no_body(ocharts_env) -> None:
    client, _, _ = ocharts_env
    x, y = tile_of(0.0, 0.0, 12)  # far from the set
    r = client.get(f"/tiles/oeuSENC-TEST1/12/{x}/{y}")
    assert r.status_code == 404
    assert r.content == b""
    # negative result: no-store, so a transient empty never becomes a durable
    # per-device hole (the successful tiles keep their no-cache + ETag).
    assert r.headers["cache-control"] == "no-store"


def test_unknown_set_is_json_404(ocharts_env) -> None:
    client, _, _ = ocharts_env
    r = client.get("/tiles/nonexistent/10/1/1")
    assert r.status_code == 404
    assert "unknown chart set" in r.json()["detail"]


def test_etag_304_and_sequence_bump(ocharts_env) -> None:
    client, service, set_dir = ocharts_env
    x, y = tile_of(54.1, 11.1, 12)
    url = f"/tiles/oeuSENC-TEST1/12/{x}/{y}"
    r = client.get(url)
    etag = r.headers["etag"]
    assert client.get(url, headers={"if-none-match": etag}).status_code == 304
    # touching a cell bumps the sequence: new ETag, old one stops matching
    cell = set_dir / "OC-TEST-1.senc"
    os.utime(cell, ns=(cell.stat().st_atime_ns, cell.stat().st_mtime_ns + 10_000_000))
    r2 = client.get(url, headers={"if-none-match": etag})
    assert r2.status_code == 200
    assert r2.headers["etag"] != etag


def test_etag_versions_on_chart_detail_so_a_declutter_change_isnt_stale(
    ocharts_env, tmp_path: Path
) -> None:
    """Regression: the tile ETag must fold in the chart_detail SCAMIN bias, or a
    change to what a tile shows is served stale off the browser cache.

    The overview tile below carries a VALNMR-gated light that survives at high
    detail (B=8.0) but is decluttered away at neutral detail (B=1.0). Before this
    fix the ETag was ``id-sequence`` only — unchanged across bias values — so a
    client that cached the light-bearing tile revalidated on the same ETag and
    the server handed back a content-blind 304, keeping the light on screen
    forever (the "one slider nudge fixes it, next load it's back" bug). The ETag
    must now differ per bias, and a conditional request carrying the *other*
    bias's ETag must re-serve rather than 304."""
    client, service, _ = ocharts_env

    # `derive::lights` computes the VALNMR-derived SCAMIN gate independent of
    # S-52, but chartcore's final `derive::scamin` pass only *publishes* a
    # feature's gate onto the tile once S-52 lookup data resolves it as
    # non-exempt — with no lookup data nothing is gated at all (see
    # `scamin_needs_lookup_data` in chartcore's derive tests), which is also why
    # `ocharts_env`'s "no S-52 lookup data" warning is normally harmless (only
    # ATON symbols go unresolved). This test specifically exercises the SCAMIN
    # bias, so it needs that gate to actually reach the wire: load a minimal
    # LIGHTS lookup (mirrors test_ocharts_s52.py's synthetic LUPS_XML) and drop
    # the cell cache so the already-decoded (S-52-less) fixture cells are
    # re-derived against it.
    s52_file = tmp_path / "chartsymbols.xml"
    s52_file.write_text(
        '<lookups><lookup id="1" RCID="1" name="LIGHTS"><type>Point</type>'
        "<disp-prio>Point Symbol</disp-prio><table-name>Simplified</table-name>"
        "<instruction>SY(LIGHTS81)</instruction>"
        "<display-cat>Standard</display-cat></lookup></lookups>"
    )
    service._s52 = chartcore.S52.load(str(s52_file))
    service.cells.clear()

    # The light's gate is `SCAMIN_PER_NM(60000) * VALNMR(20)` = 1:1,200,000, and
    # the drop compares it against the scale the tile is DISPLAYED at
    # (`RENDER_SCALE_DENOM_Z0/2^z`, #kyxkoonq): z7 shows 1:2,184,000 — coarser,
    # so the light is decluttered at B=1 — while z8 shows 1:1,092,000, finer, so
    # the light survives there and the bias would make no difference. z7 is the
    # overview zoom where the gate actually bites now (it was z8 before the
    # render-denominator fix, when the gate believed z8 was 1:2,184,000).
    x, y = tile_of(54.1, 11.1, 7)
    url = f"/tiles/oeuSENC-TEST1/7/{x}/{y}"

    service.chart_detail = 8.0
    hi = client.get(url, headers={"accept-encoding": "identity"})
    assert hi.status_code == 200
    assert "LIGHTS" in chartcore.tile_layers(hi.content)
    etag_hi = hi.headers["etag"]

    # Drop to neutral detail and revalidate carrying the high-detail ETag, as a
    # browser holding the cached light-bearing tile would. It must NOT 304 — the
    # tile now declutters to empty, and the client has to see that.
    service.chart_detail = 1.0
    reserved = client.get(
        url, headers={"if-none-match": etag_hi, "accept-encoding": "identity"}
    )
    assert reserved.status_code != 304
    etag_lo = reserved.headers["etag"]
    assert etag_lo != etag_hi  # ETag versions on the bias
    assert reserved.content != hi.content  # and the bytes genuinely changed

    # Revalidation still works when nothing changed: the *matching* current ETag
    # short-circuits to 304.
    assert client.get(url, headers={"if-none-match": etag_lo}).status_code == 304


def test_etag_versions_on_tile_schema_so_a_derive_change_isnt_stale(
    ocharts_env,
) -> None:
    """Regression: the tile ETag must fold in TILE_SCHEMA_VERSION, bumped by hand
    when chartcore's tile bytes change for the same SENC input (a derive/tiling
    change). `sequence` bumps only on chart-set reinstall, so without the schema
    token such a change would be served stale to every existing client. A
    conditional request carrying an ETag from a different schema version must
    re-serve, not 304."""
    client, _, _ = ocharts_env
    x, y = tile_of(54.1, 11.1, 12)
    url = f"/tiles/oeuSENC-TEST1/12/{x}/{y}"
    etag = client.get(url).headers["etag"]
    assert f"-v{TILE_SCHEMA_VERSION}-" in etag  # schema token is in the entity-tag

    older = etag.replace(f"-v{TILE_SCHEMA_VERSION}-", f"-v{TILE_SCHEMA_VERSION - 1}-")
    assert client.get(url, headers={"if-none-match": older}).status_code == 200
    assert client.get(url, headers={"if-none-match": etag}).status_code == 304


def test_tile_cache_hit_skips_recut(ocharts_env) -> None:
    client, service, _ = ocharts_env
    x, y = tile_of(54.1, 11.1, 12)
    url = f"/tiles/oeuSENC-TEST1/12/{x}/{y}"
    client.get(url)
    loads = service.tiles.stats()["loads"]
    client.get(url)
    assert service.tiles.stats()["loads"] == loads
    assert service.tiles.stats()["hits"] >= 1


def test_delete_set_removes_dir_and_catalog_entry(ocharts_env) -> None:
    client, _, set_dir = ocharts_env
    assert len(client.get("/catalog").json()["sets"]) == 1
    r = client.delete("/ocharts/sets/oeuSENC-TEST1")
    assert r.status_code == 200
    assert r.json() == {"deleted": "oeuSENC-TEST1"}
    assert not set_dir.exists()
    assert client.get("/catalog").json()["sets"] == []
    # tiles for the deleted set are gone too
    x, y = tile_of(54.1, 11.1, 12)
    assert client.get(f"/tiles/oeuSENC-TEST1/12/{x}/{y}").status_code == 404


def test_delete_unknown_set_404(ocharts_env) -> None:
    client, _, _ = ocharts_env
    r = client.delete("/ocharts/sets/nope")
    assert r.status_code == 404
    assert "unknown chart set" in r.json()["detail"]


# ---- scan rate limiting: the tile path must not re-stat the set per request --
#
# `get()` is on the tile path and MapLibre fires a viewport of tile requests at
# once. Change detection is a stat per cell file under a global lock (~9 ms for
# a 664-file national set, pure Python so it neither parallelizes nor overlaps),
# which put that cost serialized in front of every tile — cache hits and 304s
# included. These pin the rate limiting that fixed it, and the freshness it is
# still required to preserve.


def _counting_store(sets_dir: Path, **kw):
    """An OchartsStore over `sets_dir` counting its header reads."""
    from mivnav.features.ocharts.sets import OchartsStore

    calls: list[Path] = []

    def reader(path: Path, key: str) -> dict:
        calls.append(path)
        return chartcore.read_header(str(path), key, None)

    return OchartsStore(sets_dir, reader, **kw), calls


def _touch(path: Path, delta_ns: int = 10_000_000) -> None:
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + delta_ns))


def test_sets_scan_is_rate_limited(ocharts_env, monkeypatch) -> None:
    """Within the interval, repeat access touches no filesystem at all."""
    _, _, set_dir = ocharts_env
    store, _ = _counting_store(set_dir.parent, rescan_interval=60.0)
    assert set(store.sets()) == {"oeuSENC-TEST1"}

    scans = []
    monkeypatch.setattr(store, "_scan", lambda: scans.append(1) or store._known)
    for _ in range(50):
        assert store.get("oeuSENC-TEST1") is not None
    assert scans == []  # 50 tile-path lookups, zero rescans


def test_sets_scan_resumes_after_interval(ocharts_env) -> None:
    """An out-of-band change is picked up once the interval elapses."""
    _, _, set_dir = ocharts_env
    store, _ = _counting_store(set_dir.parent, rescan_interval=60.0)
    seq = store.get("oeuSENC-TEST1").sequence

    _touch(set_dir / "OC-TEST-1.senc")
    assert store.get("oeuSENC-TEST1").sequence == seq  # still inside the interval

    store.rescan_interval = 0  # as if the interval had elapsed
    assert store.get("oeuSENC-TEST1").sequence != seq


def test_invalidate_forces_rescan_despite_interval(ocharts_env) -> None:
    """In-process mutations stay instant: install/delete call invalidate()."""
    _, _, set_dir = ocharts_env
    store, _ = _counting_store(set_dir.parent, rescan_interval=3600.0)
    seq = store.get("oeuSENC-TEST1").sequence

    _touch(set_dir / "OC-TEST-1.senc")
    store.invalidate()
    assert store.get("oeuSENC-TEST1").sequence != seq


def test_unchanged_set_is_not_re_headered_on_rescan(ocharts_env) -> None:
    """A rescan that finds the sequence unchanged reuses the RAM headers —
    it must never re-read cell headers (that would hit the daemon)."""
    _, _, set_dir = ocharts_env
    store, calls = _counting_store(set_dir.parent, rescan_interval=0)
    store.sets()
    assert len(calls) == 2  # both cells identified once
    for _ in range(5):
        store.sets()  # rescans (interval 0), but the sequence is unchanged
    assert len(calls) == 2


# ---- a header read that failed is not a cached fact ------------------------
#
# The other half of "the plotter is chartless forever", and the half no client
# retry can reach: a header read that fails (the daemon still starting, busy,
# or bounced) yields a set with fewer cells — or none at all — and the result
# used to be cached against the directory's sequence. That sequence is the
# directory's mtime, which does not move when the daemon comes back, so the
# set stayed crippled or invisible until the next install, delete or restart,
# and /catalog served the survivors as a normal 200 with no hint that anything
# was missing. A cell that read is a fact; a cell that failed to read is not.


def _flaky_store(sets_dir: Path, down: list[bool], **kw):
    """A store whose header reads fail while `down[0]`, as they do when
    oexserverd is not up (see OchartsService._read_header → .daemon)."""
    from mivnav.features.ocharts.sets import OchartsStore

    calls: list[Path] = []

    def reader(path: Path, key: str) -> dict:
        calls.append(path)
        if down[0]:
            raise RuntimeError("oexserverd did not reach running")
        return chartcore.read_header(str(path), key, None)

    return OchartsStore(sets_dir, reader, **kw), calls


def test_set_hidden_by_a_transient_header_failure_comes_back(ocharts_env) -> None:
    """The daemon is down when the first scan lands: every cell fails, the set
    has nothing to chart with, and /catalog skips it entirely. When the daemon
    returns the set must come back on its own — the directory has not changed,
    so nothing else will ever bring it back, and a client retry gets the same
    confident 200 saying the boat has no charts."""
    _, _, set_dir = ocharts_env
    down = [True]
    store, _ = _flaky_store(set_dir.parent, down, rescan_interval=0)

    hidden = store.sets()["oeuSENC-TEST1"]
    assert hidden.cells == []
    assert len(hidden.cell_errors) == 2

    down[0] = False
    recovered = store.sets()["oeuSENC-TEST1"]
    assert len(recovered.cells) == 2
    assert recovered.cell_errors == {}


def test_partial_header_failure_recovers_the_missing_cell(ocharts_env) -> None:
    """Half a set is worse than none of it: the chart draws, so nothing looks
    wrong, and the cells that failed are simply not on it."""
    _, _, set_dir = ocharts_env
    store, _ = _flaky_store(set_dir.parent, [False], rescan_interval=0)

    def half(path: Path, key: str) -> dict:
        if path.name == "OC-TEST-2.senc":
            raise RuntimeError("oexserverd busy")
        return chartcore.read_header(str(path), key, None)

    store._header_reader = half
    partial = store.sets()["oeuSENC-TEST1"]
    assert [c.name for c in partial.cells] == ["OC-TEST-1"]
    assert set(partial.cell_errors) == {"OC-TEST-2.senc"}

    store._header_reader = lambda p, k: chartcore.read_header(str(p), k, None)
    whole = store.sets()["oeuSENC-TEST1"]
    assert {c.name for c in whole.cells} == {"OC-TEST-1", "OC-TEST-2"}
    assert whole.cell_errors == {}


def test_retry_costs_only_the_cells_that_failed(ocharts_env) -> None:
    """The retry must not re-read the whole set: on the 391-cell national set
    that would be exactly the rescan cost this store's rate limiting exists to
    avoid, paid every interval for one permanently broken cell."""
    _, _, set_dir = ocharts_env
    store, calls = _flaky_store(set_dir.parent, [False], rescan_interval=0)

    def half(path: Path, key: str) -> dict:
        calls.append(path)
        if path.name == "OC-TEST-2.senc":
            raise RuntimeError("still broken")
        return chartcore.read_header(str(path), key, None)

    store._header_reader = half
    store.sets()
    calls.clear()
    for _ in range(5):
        store.sets()
    # Five rescans, five reads: the one cell still failing. The cell that read
    # once is never asked again while the sequence holds.
    assert [p.name for p in calls] == ["OC-TEST-2.senc"] * 5


# ---- per-zoom cell selection (_cut_tile) -----------------------------------
#
# A cell's zoom band (chartcore.zoom_range_for_scale) answers "which zooms is
# this compilation scale good for" — the question the *pre-baking* path asks,
# where the archive declares one maxzoom and MapLibre overzooms past it
# client-side. The on-demand path must not reuse the band's upper end as
# "which cells may serve this tile": a set advertises a single max_zoom (the
# max over its cells), so the client asks for zooms finer than most cells'
# bands, and gating on the band makes those cells contribute *nothing* there
# instead of being overzoomed. Measured on the Danish national set (391
# cells): inland Jutland is charted only by the 1:1,500,000 general cell
# (band z3-z9), so every tile over it at z10+ came back with no features;
# open water charted only at 1:90000/1:180000 went blank at z14+.


def _cell_with_landmark(path: Path, name: str, scale: int, bounds, lat, lon, label: str):
    """A cell of `scale` spanning `bounds` with one named LNDMRK (landmark) point.

    These are *cell-selection* tests: the probe only has to answer "did this
    cell's content reach the tile", so it must survive on selection alone and
    never be second-guessed by SCAMIN. These fixtures configure no S-52 lookup
    data, so `derive::scamin` is inert (it early-returns without S-52, which is
    the *publish* step — the light forms' VALNMR-derived gate is still computed
    independent of S-52 in `derive::lights`, but with no S-52 data it is never
    turned into a `scamin` tile tag, so a light would NOT actually be dropped
    here). The probe is still a *named* class that is NOT a light, on general
    principle — it is not stripped of its info tags at the tile level either:
    LNDMRK carries OBJNAM through the cut (unlike LNDARE, which is render-only
    now: #IAP-STRIP-LNDARE-BACKEND drops its OBJNAM). A landmark point then
    stays present at every overview zoom these tests query — including the
    coarsest (z3/z4/z9) — without depending on SCAMIN behaviour at all.
    """
    from senc_fixture import ATT_OBJNAM, OBJ_LNDMRK, SencWriter

    w, s, e, n = bounds
    sw = SencWriter().version().cell_name(name).cell_edition(1).native_scale(scale)
    sw.extent(w, s, e, n)
    sw.feature(OBJ_LNDMRK, 1)
    sw.attr_str(ATT_OBJNAM, label)
    sw.point(lat, lon)
    return sw.write(path)


def _serving_env(tmp_path: Path, build, **service_kwargs):
    """A client+service over a set whose cells `build(set_dir)` writes.

    Exercises the base gate / cap / region-based authority selection through
    the real serving path. Pass ``serving_headroom=`` / ``max_cells_per_tile=``
    to tune a fixture.
    """
    sets_dir = tmp_path / "ocharts"
    set_dir = sets_dir / "oeuSENC-ZOOM"
    set_dir.mkdir(parents=True)
    build(set_dir)
    (set_dir / "keys.xml").write_text(
        "<keyList><ChartInfo>Zoom Set</ChartInfo><Edition>2026/01-1</Edition></keyList>"
    )

    from mivnav.api.app import app
    from mivnav.api.charts import get_store
    from mivnav.features.ocharts.routes import get_service
    from mivnav.charts.store import ChartStore
    from mivnav.features.ocharts.service import OchartsService

    # Pin "no S-52 lookup data" explicitly (#P0-S52-AMBIENT) — see the matching
    # comment on `ocharts_env`. `_cell_with_landmark`'s docstring already claims
    # "these fixtures configure no S-52 lookup data"; this is what makes that
    # true rather than an ambient-cache accident. A caller may still override via
    # `service_kwargs` (none currently do).
    kwargs = {"s52_path": tmp_path / "no-s52-data", **service_kwargs}
    service = OchartsService(
        sets_dir=sets_dir,
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        rescan_interval=0,
        # these tests count decodes; a background decoder would make the
        # counts non-deterministic. The warmer has its own tests.
        warm_overview=False,
        **kwargs,
    )
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_store] = lambda: ChartStore(tmp_path / "empty-pmtiles")
    app.dependency_overrides[get_service] = lambda: service
    # try/finally, not bare code after the yield: callers that manually
    # `next(gen)` then `gen.close()` (rather than exhausting the generator)
    # send GeneratorExit AT the yield, which unwinds straight past
    # unprotected cleanup code — leaking this override into every later
    # test in the session (they share the same `app` singleton). Found via
    # a full-suite run: test_tiles.py/test_robustness.py's session-scoped
    # `client` fixture started seeing a stale two-set override from
    # `_two_set_env` (below, same bug) once a test using it ran first in
    # file order — undiagnosed until now (tpkonpry).
    try:
        with TestClient(app) as client:
            yield client, service
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


# A general cell blanketing a region (the only chart over "inland"), plus one
# harbour-scale cell in a corner of it — the Danish set's shape in miniature.
GENERAL = (1_500_000, (8.0, 54.0, 13.0, 58.0))  # band z3-z9
HARBOUR = (4_000, (10.60, 57.70, 10.66, 57.76))  # band z10-z16
INLAND = (56.3, 9.6)  # only the general cell charts this
PORT = (57.73, 10.63)  # both cells reach this


@pytest.fixture()
def zoom_env(tmp_path: Path):
    def build(set_dir: Path) -> None:
        _cell_with_landmark(set_dir / "GEN.senc", "GEN", GENERAL[0], GENERAL[1],
                         *INLAND, "general-inland")
        _cell_with_landmark(set_dir / "GENPORT.senc", "GENPORT", GENERAL[0], GENERAL[1],
                         *PORT, "general-port")
        _cell_with_landmark(set_dir / "HARB.senc", "HARB", HARBOUR[0], HARBOUR[1],
                         *PORT, "harbour-port")

    # The gate's mechanism at a headroom of 4, pinned rather than read from
    # DEFAULT_OVER_ZOOM (the boat runs 8), so these tests keep their edges.
    yield from _serving_env(tmp_path, build, over_zoom=4, under_zoom=4)


def _landmark_names(content: bytes) -> list[str]:
    return [t.get("OBJNAM") for t in chartcore.tile_feature_tags(content, "LNDMRK")]


@pytest.mark.parametrize("z", [9, 10, 12, 14, 16])
def test_general_cell_serves_zooms_past_its_own_band(zoom_env, z: int) -> None:
    """The reported hole: at z10+ the only cell charting inland Jutland is
    the 1:1.5M general one, whose band stops at z9. Gating on the band's
    upper end left a rectangular region of empty tiles under the OSM
    basemap; overzooming the cell is what a plotter must do instead."""
    client, _ = zoom_env
    x, y = tile_of(*INLAND, z)
    r = client.get(f"/tiles/oeuSENC-ZOOM/{z}/{x}/{y}")
    assert r.status_code == 200, f"z{z}: general cell dropped past its band -> no tile"
    assert _landmark_names(r.content) == ["general-inland"]


def test_harbour_cell_not_regressed_at_its_own_zoom(zoom_env) -> None:
    """The opposite failure: a harbour at z16 must still get its harbour
    plan, and the general cell must merge *under* it (coarse-to-detailed)."""
    client, _ = zoom_env
    x, y = tile_of(*PORT, 16)
    r = client.get(f"/tiles/oeuSENC-ZOOM/16/{x}/{y}")
    assert r.status_code == 200
    # both reach the tile; coarse first so the harbour plan draws on top
    assert _landmark_names(r.content) == ["general-port", "harbour-port"]


@pytest.fixture()
def crowded_env(tmp_path: Path):
    """One general cell plus more same-band cells than MAX_CELLS_PER_TILE,
    all inside a single overview tile.

    They are 1:90000 (native z13, so within the serving headroom of z10)
    rather than harbour plans, because harbour plans no longer reach an
    overview tile at all — that is what DEFAULT_OVER_ZOOM does, and
    it is tested separately below. This fixture is about the cap, which now
    only bites within a band the zoom is genuinely asking for.

    The count tracks MAX_CELLS_PER_TILE: the point is a tile that crowds the
    cap, and the cap moved to 16 when it turned out 8 was dropping real
    chart at z9 on the Danish set.
    """

    def build(set_dir: Path) -> None:
        _cell_with_landmark(set_dir / "GEN.senc", "GEN", GENERAL[0], GENERAL[1],
                         *INLAND, "general-inland")
        for i in range(MAX_CELLS_PER_TILE + 4):
            lon = 9.55 + i * 0.002  # all inside the one z10 tile, however many
            _cell_with_landmark(set_dir / f"H{i:02d}.senc", f"H{i:02d}", 90_000,
                             (lon - 0.0008, 56.29, lon + 0.0008, 56.31), 56.3, lon,
                             f"coastal-{i:02d}")

    yield from _serving_env(tmp_path, build)


def test_cap_drops_detail_not_coverage(crowded_env, caplog) -> None:
    """MAX_CELLS_PER_TILE must never drop the cell that covers the tile.
    Taking the *most detailed* cells first meant an overview tile spent its
    whole budget on postage-stamp harbour plans and discarded the general
    cell blanketing it — an empty-looking tile, and a cold decode of eight
    cells to produce it (backlog #35)."""
    from mivnav.features.ocharts.service import MAX_CELLS_PER_TILE

    client, service = crowded_env
    x, y = tile_of(*INLAND, 10)
    with caplog.at_level(logging.WARNING, logger="mivnav.features.ocharts.service"):
        r = client.get(f"/tiles/oeuSENC-ZOOM/10/{x}/{y}")
    assert r.status_code == 200
    assert "general-inland" in _landmark_names(r.content)
    assert service.cells.stats()["loads"] <= MAX_CELLS_PER_TILE
    # a cap that bites must say so rather than silently thin the chart
    assert any("max_cells_per_tile" in m for m in caplog.messages), caplog.messages


def test_broken_only_cell_503s_instead_of_a_false_no_data_claim(tmp_path: Path) -> None:
    """The empty-after-filtering edge of #lsyvyxww: when the ONLY cell that
    would chart a tile is broken, excluding it (see
    `OchartsService._drop_broken_cells`) must not leave `chartcore.serve_tile`
    an empty spec list with `claim_allowed` still true -- `select()` would
    then honestly (from its now-empty point of view) conclude "no ENC data
    here" and paint the `_nodata` grey. That is FALSE: the set does chart
    here, the decode just failed. The tile must come back as a retryable
    failure (503) -- the same shape of answer as before this containment
    existed -- never a confident lie."""

    def build(set_dir: Path) -> None:
        _cell_with_landmark(
            set_dir / "ONLY.senc", "ONLY", *GENERAL, *INLAND, "general-inland"
        )

    gen = _serving_env(tmp_path, build)
    client, service = next(gen)
    try:
        def always_broken(path, key):
            raise chartcore.ChartError(
                "I/O error: timeout waiting for oexserverd response data"
            )

        service.open_cell = always_broken  # type: ignore[method-assign]

        x, y = tile_of(*INLAND, 9)
        r = client.get(f"/tiles/oeuSENC-ZOOM/9/{x}/{y}")
        assert r.status_code == 503, (
            "the only charting cell is broken -- this must be a retryable "
            f"failure, not a (false) no-data 200/404, got {r.status_code}"
        )
        assert service.cells.stats()["errors"] == 1
    finally:
        gen.close()


def test_serving_fixtures_ignore_the_ambient_s52_cache(monkeypatch, tmp_path: Path) -> None:
    """Pins the P0 flake (mqsyvnrv): 9 of this file's tests failed
    deterministically, but only on a machine where *some* earlier session had
    run ``chartcore ingest --fetch-s52`` at least once — populating the
    git-ignored, machine/build-local ``chartcore.s52_default_cache_dir()``
    once, forever (that command's whole point per its docstring). ``jj diff``
    on chartcore/service.py showed nothing because nothing there had changed;
    the difference was this ambient cache, which ``_serving_env``/
    ``ocharts_env`` never pinned despite ``_cell_with_landmark``'s docstring
    *claiming* "these fixtures configure no S-52 lookup data".

    Once S-52 data resolves an object class as a non-``displaybase`` point
    symbol, ``derive::scamin`` (chartcore/src/derive/mod.rs) starts publishing
    the synthetic ``DEFAULT_POINT_SCAMIN`` (45000) gate on it — with no S-52
    data the whole pass is a no-op (see its docstring). LNDMRK then vanishes
    at every zoom coarser than that gate, which is exactly the reported
    symptom: general/harbour-cell assertions collapsing to ``[]``, and
    z3/z4 dropping to a bare 404 once nothing survives to chart the tile.

    Reproduces the poisoned *process* state directly (no network, no touching
    the real machine-global cache): point
    ``chartcore.s52_default_cache_dir()`` at a lookup table shaped like the
    real government one (a Simplified/Standard/"Point Symbol" LUP for LNDMRK,
    non-exempt) and prove the fixture's own service construction never
    resolves it.
    """
    ambient = tmp_path / "ambient-s52-cache"
    ambient.mkdir()
    (ambient / "chartsymbols.xml").write_text(
        '<lookups><lookup id="1" RCID="1" name="LNDMRK"><type>Point</type>'
        "<disp-prio>Point Symbol</disp-prio><table-name>Simplified</table-name>"
        "<instruction>SY(LNDMRK01)</instruction>"
        "<display-cat>Standard</display-cat></lookup></lookups>"
    )
    monkeypatch.setattr(chartcore, "s52_default_cache_dir", lambda: str(ambient))

    def build(set_dir: Path) -> None:
        _cell_with_landmark(set_dir / "GEN.senc", "GEN", *GENERAL, *INLAND, "general-inland")

    gen = _serving_env(tmp_path, build)
    client, service = next(gen)
    try:
        assert service._s52 is None, "resolved the ambient cache it must ignore"
        # z9: past the general cell's own band (z3-z9's edge) — the exact
        # zoom the original report saw come back empty.
        x, y = tile_of(*INLAND, 9)
        r = client.get(f"/tiles/oeuSENC-ZOOM/9/{x}/{y}")
        assert r.status_code == 200
        assert _landmark_names(r.content) == ["general-inland"]
    finally:
        gen.close()


def test_a_tile_request_brackets_the_warmer_off(tmp_path: Path) -> None:
    """The service's end of the warming contract (mivnav.features.ocharts.warm): a
    tile request holds background warming off for the whole time it runs,
    not merely for the instant it arrived.

    Marking only the arrival is a real hole, not a nicety: a cold first
    tile takes ~1.6 s (it starts oexserverd), which is longer than the idle
    grace, so the warmer would take the daemon *while that very request was
    still waiting for it*. The pairing is what makes the warmer's in-flight
    count true, so it is asserted at this end too — the counter cannot
    balance if the service leaks a start.
    """
    from mivnav.features.ocharts.service import OchartsService

    service = OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
    )
    try:
        warmer = service._warmer
        marks: list[str] = []
        warmer.note_request = lambda: marks.append("start")
        warmer.note_done = lambda: marks.append("done")
        cs = OchartsSet(id="s", directory=tmp_path, sequence=1, info=None)
        service.tile(cs, 10, 0, 0)
        assert marks == ["start", "done"]

        # and the pair balances even when the tile fails, or a request that
        # raised would hold warming off for the life of the process
        def boom(*a):
            raise RuntimeError("cut failed")

        service._tile = boom  # type: ignore[method-assign]
        with pytest.raises(RuntimeError):
            service.tile(cs, 10, 0, 0)
        assert marks == ["start", "done", "start", "done"]
    finally:
        service.close()


# ---- serving detail headroom (DEFAULT_OVER_ZOOM) ---------------------
#
# The base gate runs at a tight default of 4 (``ocharts.serving_headroom``).
# The cold fan-out of backlog #35 is why: a cell whose band starts `native - 6`
# lets every 1:4000 harbour plan be decoded to draw a z10 overview tile.
# Measured on the real 391-cell Danish set, distinct cold decodes per 8x5-tile
# z10 viewport fell 53 -> 10 (Aarhus), 61 -> 8 (inland), 64 -> 12 (Copenhagen)
# at headroom 4, and z12+ is unaffected. Those cells serialize through
# oexserverd's one FIFO at ~400 ms each, which is what made a cold overview
# viewport take ~25 s and trip the cache's 30 s waiter timeout into a 503. The
# detail a tight gate would otherwise defer is recovered by the finest-per-
# region fill (its own tests further below), not by widening this gate.
#
# (These tests build the service with fill OFF, so they exercise the base gate
# at the default headroom of 4 in isolation.)


def test_harbour_cell_does_not_serve_overview_zooms(zoom_env) -> None:
    """A 1:4000 harbour plan (native z16) is 6 zooms out of its depth at
    z10. With the headroom at 4 it stops being decoded there — the whole
    point — while the general cell the zoom is asking for still serves."""
    client, service = zoom_env
    x, y = tile_of(*PORT, 10)
    r = client.get(f"/tiles/oeuSENC-ZOOM/10/{x}/{y}")
    assert r.status_code == 200
    assert _landmark_names(r.content) == ["general-port"]  # not harbour-port
    # and it was not merely filtered out of the tile — it was never decoded,
    # which is the cost this is here to remove (only the two general cells,
    # GEN and GENPORT, both reach this tile)
    assert service.cells.stats()["loads"] == 2


@pytest.mark.parametrize(("z", "expected"), [(11, ["general-port"]),
                                             (12, ["general-port", "harbour-port"])])
def test_harbour_cell_returns_at_its_own_band(zoom_env, z: int, expected) -> None:
    """The headroom's edge: native 16 - headroom 4 = z12. z11 is the last
    zoom the harbour plan sits out, z12 the first it draws again."""
    client, _ = zoom_env
    x, y = tile_of(*PORT, z)
    r = client.get(f"/tiles/oeuSENC-ZOOM/{z}/{x}/{y}")
    assert r.status_code == 200
    assert _landmark_names(r.content) == expected


@pytest.mark.parametrize("z", [3, 4])
def test_coarsest_cells_serve_below_the_headroom(zoom_env, z: int) -> None:
    """The headroom may cost detail, never coverage.

    The general cell is native z9, so a bare headroom of 4 refuses it at z3
    and z4 — and refuses *every* cell there, because it is the coarsest one
    the set has. The set still advertises min_zoom 3 (it is baked from the
    cells' own bands), so the client asks, and a bare gate would answer 404:
    Denmark would vanish at world zoom. Measured on the real Danish set: 2
    cells serve a z3 viewport today, 0 with a bare headroom gate.
    """
    client, _ = zoom_env
    x, y = tile_of(*INLAND, z)
    r = client.get(f"/tiles/oeuSENC-ZOOM/{z}/{x}/{y}")
    assert r.status_code == 200, f"z{z}: nothing coarse enough -> the chart disappears"
    assert "general-inland" in _landmark_names(r.content)


# -- the coverage partition -----------------------------------------------
#
# Both bugs below were measured on the real 391-cell Danish set and are
# reproduced here against synthetic cells with the same shape. A cell's
# *coverage* (chartcore.Coverage, from the header's CELL_COVR/NOCOVR) is
# what decides these, not its extent rectangle.


class _FakeCoverage:
    """Stands in for chartcore.Coverage without real geometry.

    Two questions selection asks of a coverage, answered from an abstract
    region model:

    * ``tile_state(z,x,y)`` — ``"full"`` when the tile is in ``full``,
      ``"partial"`` when it has any region here, else ``"none"``.
    * ``has_residual_in_tile(finer, z,x,y)`` — the authority test: does this
      cell chart a region here that none of ``finer`` charts?

    Coverage is modelled as a set of opaque region tokens per tile. A ``full``
    tile covers the sentinel :data:`_ALL` (everything, so anything under it is
    fully masked). A ``partial`` tile — the common case in these tests —
    covers one PRIVATE token unique to the cell, i.e. its own patch of ground
    that no other cell charts (adjacent cells, the real overview shape). Cells
    meant to overlap share explicit ``regions``: ``{(z,x,y): {"R", ...}}``.
    """

    _ALL = object()  # sentinel region: covers the whole tile

    def __init__(self, full=(), partial=(), regions=None):
        self._full = set(full)
        self._partial = set(partial)
        self._regions: dict[tuple[int, int, int], set] = {
            k: set(v) for k, v in (regions or {}).items()
        }

    def tile_state(self, z: int, x: int, y: int) -> str:
        key = (z, x, y)
        if key in self._full:
            return "full"
        if key in self._partial or self._regions.get(key):
            return "partial"
        return "none"

    def _covered(self, z: int, x: int, y: int) -> set:
        """The region tokens this cell charts in the tile ({_ALL} if full)."""
        key = (z, x, y)
        if key in self._full:
            return {self._ALL}
        toks = set(self._regions.get(key, ()))
        if key in self._partial:
            toks.add(("private", id(self)))  # its own ground, nobody else's
        return toks

    def has_residual_in_tile(self, finer, z: int, x: int, y: int) -> bool:
        mine = self._covered(z, x, y)
        covered: set = set()
        for f in finer:
            fset = f._covered(z, x, y)
            if self._ALL in fset:
                return False  # a finer cell blankets the tile: nothing residual
            covered |= fset
        if self._ALL in mine:
            return True  # I'm full and no finer cell blankets me
        return bool(mine - covered)


def _cell(name, scale, coverage=None, extent=(-180.0, -85.0, 180.0, 85.0)):
    """A CellInfo whose extent reaches everywhere, so only coverage and
    zoom can decide anything."""
    import chartcore
    from mivnav.features.ocharts.sets import CellInfo

    min_zoom, max_zoom = chartcore.zoom_range_for_scale(scale)
    return CellInfo(
        path=Path(f"/nonexistent/{name}"),
        key="",
        name=name,
        scale=scale,
        extent=extent,
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        coverage=coverage,
    )


# -- the set-level no-data claim ------------------------------------------
#
# "This chart set has no data here" has to render one way, whatever the
# cell layout happens to be. It used to render two: a cell's *declared*
# no-coverage got AC(NODTA) grey, while ground no cell reached at all got a
# 404 and the bare basemap — a hard-edged square of OpenStreetMap inside the
# chart whose edges were the tile grid, which is the tell that the boundary
# was an artifact of our tiling rather than of any real coverage edge.


def _set_of(cells) -> OchartsSet:
    from mivnav.features.ocharts.keys import SetInfo

    return OchartsSet(
        id="DK-like",
        directory=Path("/nonexistent"),
        sequence=1,
        info=SetInfo(directory=Path("/nonexistent"), title="DK-like"),
        cells=list(cells),
    )


def _bare_service(tmp_path: Path):
    from mivnav.features.ocharts.service import OchartsService

    return OchartsService(
        sets_dir=tmp_path / "no-sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
    )


def test_no_claim_is_made_outside_the_set_bounds(tmp_path: Path) -> None:
    """The claim is scoped to the region the set is about. It is true of the
    whole planet, but a set is not a statement about the whole planet, and
    painting one grey everywhere it is not would make every set fight every
    other one.
    """
    z, x, y = 10, 548, 317  # inside the extents below; the Pacific is not
    cells = [_cell("dk", 180_000, coverage=_FakeCoverage(), extent=(3.2, 54.3, 16.5, 58.2))]
    service = _bare_service(tmp_path)
    try:
        assert service._cut_tile(_set_of(cells), z, x, y) is not None
        assert service._cut_tile(_set_of(cells), 10, 100, 500) is None
    finally:
        service.close()


def test_the_per_tile_seam_is_gone_by_construction(tmp_path: Path) -> None:
    """status()["seam_tiles"] stays 0 now: the per-*tile* detail seam it once
    counted — two cells composited, neither blanketing, their generalizations
    disagreeing along the coverage boundary — is exactly what region-based
    authority selection removes. The boundary is cut from the cells' global
    coverage rings, so both sides of any tile edge draw the same authoritative
    cell. Two cells splitting a tile still composite; they just no longer
    disagree, so no seam is recorded.
    """
    from mivnav.features.ocharts.service import OchartsService

    sets_dir = tmp_path / "ocharts"

    z = 13
    x, y = tile_of(54.2, 11.2, z)  # spans lon 11.162..11.206

    # Two cells split the tile at lon 11.19: WEST covers up to it, EAST from it.
    # Each partially covers the tile and neither blankets it — the shape that
    # used to record a seam.
    d = sets_dir / "set-A"
    d.mkdir(parents=True)
    point_cell(
        d / "WEST.senc", name="WEST", scale=180_000,
        bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.0, 54.0, 11.19, 54.4),
    )
    point_cell(
        d / "EAST.senc", name="EAST", scale=180_000,
        bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.19, 54.0, 11.4, 54.4),
    )
    (d / "keys.xml").write_text("<keyList><ChartInfo>Seam</ChartInfo></keyList>")

    service = OchartsService(
        sets_dir=sets_dir, daemon_dir=tmp_path / "d", work_dir=tmp_path / "w",
        rescan_interval=0, warm_overview=False,
    )
    try:
        assert service.status()["seam_tiles"] == 0, "nothing cut yet"
        # the tile composites both cells, region-authoritative...
        assert service._cut_tile(service.get("set-A"), z, x, y) is not None
        # ...and records no seam: authority is resolved per region, not per tile
        assert service.status()["seam_tiles"] == 0, (
            "region-based authority is seam-free by construction"
        )
    finally:
        service.close()


# ---- reference-scale detail equalization (the staircase killer) ------------


# ---- cross-tile authority consistency (the whole point) --------------------
#
# Region-based authority selection resolves the SAME ground to the SAME
# authoritative cell in every tile it falls in: the residual predicate and the
# finest->coarsest order depend only on the global coverage rings and (z, x, y),
# never on per-tile overlap counts. So a cell authoritative over some ground is
# kept in every tile covering it, and a cell fully covered by finer cells is
# dropped in every one -- which is what makes the composite seam-free, replacing
# the per-tile finest-fill + cap-count truncations that made detail differ
# across a tile boundary.


# ---- /tiles/all: union serving across chart sets (#qwxtvtwo) ---------------
#
# chartcore::mvt::select is set-agnostic (coverage rings + scalars only, no
# notion of "set"), so cross-set authority is the exact same algorithm as the
# single-set path's cross-cell authority, run once over cells pooled from
# every subscribed set instead of one. These tests exercise the two things
# that ARE new: the flattened index still lines up with the right owning set
# (mislabelling is silent -- wrong provenance, not a crash), and the route
# itself is reachable (it is same-shape as /tiles/{set_id}/... and would be
# shadowed by a naive route registration order).


def _two_set_env(tmp_path: Path, build_a, build_b, **service_kwargs):
    """A client+service over TWO o-charts sets ("set-A", "set-B"), each built
    by its own ``build(set_dir)`` callback. Mirrors ``_serving_env``, doubled,
    for the union-serving tests below."""
    sets_dir = tmp_path / "ocharts"
    a_dir = sets_dir / "set-A"
    b_dir = sets_dir / "set-B"
    a_dir.mkdir(parents=True)
    b_dir.mkdir(parents=True)
    build_a(a_dir)
    build_b(b_dir)
    (a_dir / "keys.xml").write_text("<keyList><ChartInfo>Set A</ChartInfo></keyList>")
    (b_dir / "keys.xml").write_text("<keyList><ChartInfo>Set B</ChartInfo></keyList>")

    from mivnav.api.app import app
    from mivnav.api.charts import get_store
    from mivnav.features.ocharts.routes import get_service
    from mivnav.charts.store import ChartStore
    from mivnav.features.ocharts.service import OchartsService

    service = OchartsService(
        sets_dir=sets_dir,
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        rescan_interval=0,
        warm_overview=False,
        **service_kwargs,
    )
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_store] = lambda: ChartStore(tmp_path / "empty-pmtiles")
    app.dependency_overrides[get_service] = lambda: service
    # try/finally — see the identical comment in `_serving_env` above; this
    # generator has the same manual-`gen.close()` callers and the same leak.
    try:
        with TestClient(app) as client:
            yield client, service
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


def test_tiles_all_composites_both_sets_and_tags_provenance(tmp_path: Path) -> None:
    """The primary union-serving case: two sets whose cells split a tile side
    by side (neither blankets it -- the WEST/EAST shape from
    test_the_per_tile_seam_is_gone_by_construction, split across SET
    directories instead of cells of one set). /tiles/all must carry BOTH
    sets' features, each stamped with its own set id.

    This also pins the route-registration order: /tiles/all/{z}/{x}/{y} and
    /tiles/{set_id}/{z}/{x}/{y} are the same 5-segment shape, so if the
    per-set route were registered first (or matched first) it would swallow
    "all" as a literal set id and this request would 404 as an unknown set
    instead of compositing -- a call through the real HTTP client, not a
    direct service call, is the only thing that would catch that.
    """
    z = 13
    x, y = tile_of(54.2, 11.2, z)  # spans lon 11.162..11.206, as in the seam test

    def build_west(d: Path) -> None:
        point_cell(
            d / "WEST.senc", name="WEST", scale=180_000,
            bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.0, 54.0, 11.19, 54.4),
        )

    def build_east(d: Path) -> None:
        point_cell(
            d / "EAST.senc", name="EAST", scale=180_000,
            bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.19, 54.0, 11.4, 54.4),
        )

    gen = _two_set_env(tmp_path, build_west, build_east)
    client, _ = next(gen)
    try:
        r = client.get(f"/tiles/all/{z}/{x}/{y}")
        assert r.status_code == 200
        tags = chartcore.tile_feature_tags(r.content, "LIGHTS")
        sets = {t.get("set") for t in tags}
        assert sets == {"set-A", "set-B"}, (
            "both sets' cells reach this tile and must each contribute "
            f"features tagged with their own set id, got {sets}"
        )
    finally:
        gen.close()


def test_one_broken_cell_does_not_poison_the_union_tile_for_other_sets(tmp_path: Path) -> None:
    """Real-device incident (lsyvyxww): oexserverd stopped responding on one
    cell of one chart set (`ChartError: I/O error: timeout waiting for
    oexserverd response data`). `chartcore.serve_tile_union`'s `load_cell`
    callback re-raises ANY cell's exception via PyO3's `?`, aborting the
    WHOLE composite (chartcore/src/python.rs's `load_cell.call1(py, ...)?`
    sites) -- so, unfixed, that one cell's failure would fail the tile even
    though a completely different, healthy chart set has perfectly good
    data of its own for it, and -- worse -- the *tile cache* then memoizes
    that as a permanent failure, so EVERY future request for that tile
    503s forever (until the next daemon restart), never mind that the
    broken cell is now known and excludable. `_cut_tile_all` must retry
    once, excluding the cell that just failed, so a single stuck decode
    costs one failed attempt internally -- not a standing outage."""
    z = 13
    x, y = tile_of(54.2, 11.2, z)  # WEST/EAST split, as in the seam/union tests above

    def build_west(d: Path) -> None:
        point_cell(
            d / "WEST.senc", name="WEST", scale=180_000,
            bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.0, 54.0, 11.19, 54.4),
        )

    def build_east(d: Path) -> None:
        point_cell(
            d / "EAST.senc", name="EAST", scale=180_000,
            bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.19, 54.0, 11.4, 54.4),
        )

    gen = _two_set_env(tmp_path, build_west, build_east)
    client, service = next(gen)
    try:
        real_open_cell = service.open_cell

        def flaky_open_cell(path, key):
            if path.name == "WEST.senc":
                raise chartcore.ChartError(
                    "I/O error: timeout waiting for oexserverd response data"
                )
            return real_open_cell(path, key)

        service.open_cell = flaky_open_cell  # type: ignore[method-assign]

        url = f"/tiles/all/{z}/{x}/{y}"
        # WEST (set-A) fails to decode; the retry inside this SAME request
        # excludes it and serves set-B's EAST cell instead of 503ing.
        r1 = client.get(url)
        assert r1.status_code == 200, (
            "set-A's broken cell must not fail the whole union tile when "
            "set-B's cell for the same tile is healthy"
        )
        assert service.cells.stats()["errors"] == 1
        assert {t.get("set") for t in chartcore.tile_feature_tags(r1.content, "LIGHTS")} == {
            "set-B"
        }

        # WEST stays broken (no daemon restart happened) -- a second,
        # independent request must not re-hit the daemon for it (memoized,
        # instant exclusion) nor be dragged down by set-A's problem.
        r2 = client.get(url)
        assert r2.status_code == 200
        assert {t.get("set") for t in chartcore.tile_feature_tags(r2.content, "LIGHTS")} == {
            "set-B"
        }
    finally:
        gen.close()


def test_tiles_all_authority_picks_the_finer_set_and_tags_it(tmp_path: Path) -> None:
    """Overlap merge-authority: when two sets both fully chart the SAME
    ground, the finer-scale cell wins region authority (reusing
    chartcore::mvt::select unchanged -- see select.rs's
    a_finer_full_cell_silences_all_coarser for the same rule within one set)
    and the union tile's `set` tag must name the WINNING set, not the
    coarser, masked-out one."""
    z = 12
    bounds = (11.0, 54.0, 11.2, 54.2)
    x, y = tile_of(54.1, 11.1, z)

    def build_coarse(d: Path) -> None:
        point_cell(d / "COARSE.senc", name="COARSE", scale=90_000, bounds=bounds, covr=bounds)

    def build_fine(d: Path) -> None:
        point_cell(d / "FINE.senc", name="FINE", scale=12_000, bounds=bounds, covr=bounds)

    gen = _two_set_env(tmp_path, build_coarse, build_fine)
    client, _ = next(gen)
    try:
        r = client.get(f"/tiles/all/{z}/{x}/{y}")
        assert r.status_code == 200
        tags = chartcore.tile_feature_tags(r.content, "LIGHTS")
        assert tags, "expected LIGHTS features in the tile"
        assert {t.get("set") for t in tags} == {"set-B"}, (
            "set-B's finer cell fully covers the same ground as set-A's "
            "coarser one and must be the sole authority -- and the sole "
            f"set tag -- over this tile: {tags}"
        )
    finally:
        gen.close()


def test_tiles_set_route_carries_no_set_tag(ocharts_env) -> None:
    """Additive, not a replacement: /tiles/{set_id}/... must stay exactly
    what it was before /tiles/all existed -- no `set` property on its
    features. The tagging machinery (chartcore::mvt::merge::merge_tiles_tagged
    / merge_tiles_reconciled_tagged) only ever engages on the union path; the
    untouched merge_tiles/merge_tiles_reconciled wrappers it replaced add
    nothing, so this tile's bytes are exactly what they were before this
    feature existed."""
    client, _, _ = ocharts_env
    x, y = tile_of(54.1, 11.1, 12)
    r = client.get(f"/tiles/oeuSENC-TEST1/12/{x}/{y}")
    assert r.status_code == 200
    tags = chartcore.tile_feature_tags(r.content, "LIGHTS")
    assert tags
    assert all("set" not in t for t in tags)


def test_tiles_free_etag_304_and_bump_on_either_set(tmp_path: Path) -> None:
    """The union ETag derives from `union_version()` -- (id, sequence) of
    EVERY subscribed set -- so a 304 must stop matching when either set
    changes, not just whichever one the client happens to think of. Pinned
    on `/tiles/free` (both plain .senc sets are free here): `/tiles/all` has
    no validator at all, see test_tiles_all_is_private_no_store."""
    z = 13
    x, y = tile_of(54.2, 11.2, z)

    def build_west(d: Path) -> None:
        point_cell(
            d / "WEST.senc", name="WEST", scale=180_000,
            bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.0, 54.0, 11.19, 54.4),
        )

    def build_east(d: Path) -> None:
        point_cell(
            d / "EAST.senc", name="EAST", scale=180_000,
            bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.19, 54.0, 11.4, 54.4),
        )

    gen = _two_set_env(tmp_path, build_west, build_east)
    client, _ = next(gen)
    try:
        url = f"/tiles/free/{z}/{x}/{y}"
        r = client.get(url)
        etag = r.headers["etag"]
        assert client.get(url, headers={"if-none-match": etag}).status_code == 304
        # touching only set-B's cell still bumps the union ETag
        east_cell = tmp_path / "ocharts" / "set-B" / "EAST.senc"
        os.utime(
            east_cell, ns=(east_cell.stat().st_atime_ns, east_cell.stat().st_mtime_ns + 10_000_000)
        )
        r2 = client.get(url, headers={"if-none-match": etag})
        assert r2.status_code == 200
        assert r2.headers["etag"] != etag
    finally:
        gen.close()


def test_tiles_all_is_private_no_store(tmp_path: Path) -> None:
    """o-charts licence (plan W2): the licensed union is never cached on the
    client's disk -- `private, no-store`, no ETag, and a conditional request
    is answered in full, never 304 (a 304 implies the client kept a copy).
    Holds even when no set is licensed: one rule for the route."""
    z = 13
    x, y = tile_of(54.2, 11.2, z)

    def build(d: Path) -> None:
        point_cell(
            d / "WEST.senc", name="WEST", scale=180_000,
            bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.0, 54.0, 11.4, 54.4),
        )

    gen = _two_set_env(tmp_path, build, build)
    client, _ = next(gen)
    try:
        url = f"/tiles/all/{z}/{x}/{y}"
        r = client.get(url)
        assert r.status_code == 200
        assert r.headers["cache-control"] == "private, no-store"
        assert "etag" not in r.headers
        # Diagnostics only: which tier served it, never the tile itself.
        assert r.headers["server-timing"].startswith("render;dur=")
        assert client.get(url).headers["server-timing"].startswith("ram;dur=")
        again = client.get(url, headers={"if-none-match": "*"})
        assert again.status_code == 200
        assert again.content == r.content
    finally:
        gen.close()


def test_tiles_all_parallel_cut_matches_serial(tmp_path: Path) -> None:
    """serve_tile_union's parallel cut-fan-out (#snyzntrn, wired in as the
    prerequisite for the frontend flipping to /tiles/all as its ONLY o-charts
    source) must be byte-identical to the serial path -- the same guarantee
    chartcore's cut_tiles_parallel_matches_serial pins for serve_tile's own
    parallel branch, exercised here through the union's extra bookkeeping
    (each cut zipped back with its owning set's id for the `set` tag, see
    serve_tile_union's doc comment in python.rs). Two side-by-side cells
    (WEST/EAST, as above) both survive selection, so this actually drives
    >1 kept cell through the parallel branch rather than the parallelism=1
    fallback the serial path would take anyway."""
    z = 13
    x, y = tile_of(54.2, 11.2, z)

    def build_west(d: Path) -> None:
        point_cell(
            d / "WEST.senc", name="WEST", scale=180_000,
            bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.0, 54.0, 11.19, 54.4),
        )

    def build_east(d: Path) -> None:
        point_cell(
            d / "EAST.senc", name="EAST", scale=180_000,
            bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.19, 54.0, 11.4, 54.4),
        )

    # Two separate tmp trees -- `_two_set_env` lays out `ocharts/set-A|B`
    # directly under whatever path it is given, so reusing `tmp_path` for
    # both env instances would collide creating the second one's directories.
    serial_gen = _two_set_env(tmp_path / "serial", build_west, build_east, parallelism=1)
    serial_client, _ = next(serial_gen)
    try:
        serial = serial_client.get(f"/tiles/all/{z}/{x}/{y}", headers={"accept-encoding": "identity"})
        assert serial.status_code == 200
    finally:
        serial_gen.close()

    parallel_gen = _two_set_env(tmp_path / "parallel", build_west, build_east, parallelism=3)
    parallel_client, _ = next(parallel_gen)
    try:
        parallel = parallel_client.get(
            f"/tiles/all/{z}/{x}/{y}", headers={"accept-encoding": "identity"}
        )
        assert parallel.status_code == 200
    finally:
        parallel_gen.close()

    assert parallel.content == serial.content, (
        "parallelism must not change the served bytes -- cut_tiles preserves "
        "task order regardless of the pool size, and the union's cut_set_ids "
        "zip must preserve that same order for the `set` tag to line up"
    )
    tags = chartcore.tile_feature_tags(parallel.content, "LIGHTS")
    assert {t.get("set") for t in tags} == {"set-A", "set-B"}, (
        "both sets' cells must still be correctly tagged through the "
        f"parallel branch, got {tags}"
    )


def test_daemon_recovery_clears_both_cell_and_tile_errors(tmp_path, monkeypatch) -> None:
    """A cold daemon fails a decode; that failure is memoized in BOTH caches (a
    tile error is downstream of a cell error). When the daemon recovers,
    `daemon()` must un-memoize both.

    The bug: it cleared cells only, so a transient cold-daemon failure left the
    tile cache re-raising its 503 for the life of the sequence even after the
    daemon was back — a permanent tile hole no client retry could reach.
    """
    from mivnav.features.ocharts.service import OchartsService

    service = OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,  # no background decoder touching the caches
    )
    try:

        def boom():
            raise RuntimeError("oexserverd not up")

        # poison both caches, as a cold daemon does: the cell decode fails and
        # the tile that needed it fails downstream.
        with pytest.raises(RuntimeError):
            service.cells.get("cell", boom)
        with pytest.raises(RuntimeError):
            service.tiles.get("tile", boom)
        assert (service.cells.errors, service.tiles.errors) == (1, 1)
        # both are memoized — neither re-runs its loader while broken
        with pytest.raises(RuntimeError):
            service.cells.get("cell", boom)
        with pytest.raises(RuntimeError):
            service.tiles.get("tile", boom)

        # a fake daemon that comes up "running" without a real vendor binary
        class _FakeDaemon:
            def state(self):
                return "running"

            def start(self):
                pass

            def restart(self):
                pass

            def wait_for_state(self, target, timeout):
                return True

            def last_error(self):
                return None

            def stop(self):
                pass

        monkeypatch.setattr(chartcore, "ensure_daemon", lambda d: "exe")
        monkeypatch.setattr(chartcore, "Daemon", lambda exe, wd: _FakeDaemon())

        service.daemon()  # the recovery path

        # both caches forgot the failure, so the next request is a real retry
        ran: list[str] = []

        def load_cell():
            ran.append("cell")
            return "v", 1

        def load_tile():
            ran.append("tile")
            return b"x", 1

        assert service.cells.get("cell", load_cell) == "v"
        assert service.tiles.get("tile", load_tile) == b"x"
        assert ran == ["cell", "tile"], (
            "recovery must clear tile errors too; old code cleared cells only "
            "and left the tile permanently poisoned"
        )
    finally:
        service.close()


def test_gdal_errors_are_captured_not_printed_and_not_lost() -> None:
    """The backend routes GDAL's output away from stderr — and somewhere a
    human can still find it.

    The user's log, panning the Øresund, was buried in lines like
    "ERROR 1: TopologyException: side location conflict at 247 4160",
    roughly one per composited tile. GEOS prints those when a boolean fails;
    the tile mask repairs the input and retries, so the tile is correct and
    the line is noise. But a log where a real error cannot be seen is a
    broken log, and this is the device the boat is debugged from.

    Silencing them into a black hole would be worse than the flood, so both
    halves are asserted here: quiet stderr, and the error still reachable.
    """
    import chartcore

    # Importing the app is what installs the handler — deliberately not done
    # here, or this would pass with the backend's wiring removed and prove
    # only that chartcore *can* capture, never that mivnav *does*.
    import mivnav.api.app  # noqa: F401

    before = chartcore.gdal_log()
    assert before is not None, (
        "the backend must route GDAL's output at startup; chartcore will "
        "not do it on import (the handler is process-global C state)"
    )

    r, w = os.pipe()
    saved = os.dup(2)
    os.dup2(w, 2)
    try:
        # a real GEOS failure, the same shape the mask hits: a self-
        # intersecting bowtie differenced against a square
        chartcore.provoke_gdal_error_for_test()
    finally:
        os.dup2(saved, 2)
        os.close(w)
        os.close(saved)
    printed = os.read(r, 65536).decode(errors="replace")
    os.close(r)

    assert "TopologyException" not in printed, (
        f"GDAL must not write to stderr once the app has routed it: {printed!r}"
    )
    after = chartcore.gdal_log()
    assert after["failures"] > before["failures"], (
        "...and the error must still be counted, not swallowed"
    )
    assert any("TopologyException" in m for m in after["recent"]), (
        f"...and still readable by a human: {after['recent']}"
    )
