# SPDX-License-Identifier: GPL-2.0-only
"""``OsmWorldIngestRunner``/``resolve_build_url`` — the osm_world extract job,
with both the network HEAD checks and the ``pmtiles`` CLI subprocess
stubbed. Never touches the real Protomaps build or shells out to a real
``pmtiles`` binary — see mivnav.features.osm_world.ingest's module docstring
for what this is standing in for.

Drives the runner directly, asserting
a real ``<id>.pmtiles`` lands in the dir, the job reaches "done", and the
new set is visible through ``/osm_world/catalog``/``/osm_world/tiles``.
Every ``mivnav`` import is deferred into a fixture/test body rather than
this module's top level
(``mivnav.config.model`` importing every feature's ``config.py`` means a
bare, this-module-is-first ``import mivnav.features.osm_world.<anything>``
can race that cycle before ``mivnav.api.app`` has had a chance to load it
front-to-back once).
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from datetime import date
from pathlib import Path

import pytest


class _FakeHttpClient:
    """Stands in for ``httpx.Client`` for ``resolve_build_url``'s HEAD
    checks — a plain dict of ``{url: status_code}``, everything else 404."""

    def __init__(self, ok_urls: dict[str, int]) -> None:
        self._ok = ok_urls

    def head(self, url: str):
        class _Resp:
            def __init__(self, code: int) -> None:
                self.status_code = code

        return _Resp(self._ok.get(url, 404))


def test_resolve_build_url_finds_todays_build():
    from mivnav.features.osm_world.ingest import resolve_build_url

    today = date(2026, 7, 26)
    http = _FakeHttpClient({"https://build.example/20260726.pmtiles": 200})
    url, datestr = resolve_build_url(http, "https://build.example", today=today, lookback_days=7)
    assert url == "https://build.example/20260726.pmtiles"
    assert datestr == "20260726"


def test_resolve_build_url_walks_back_when_today_missing():
    from mivnav.features.osm_world.ingest import resolve_build_url

    today = date(2026, 7, 26)
    http = _FakeHttpClient({"https://build.example/20260724.pmtiles": 200})
    url, datestr = resolve_build_url(http, "https://build.example", today=today, lookback_days=7)
    assert datestr == "20260724"
    assert url == "https://build.example/20260724.pmtiles"


def test_resolve_build_url_gives_up_after_lookback_window():
    from mivnav.features.osm_world.ingest import BuildNotFoundError, resolve_build_url

    today = date(2026, 7, 26)
    http = _FakeHttpClient({})
    with pytest.raises(BuildNotFoundError):
        resolve_build_url(http, "https://build.example", today=today, lookback_days=3)


def _fake_extract_writing_real_pmtiles(
    binary, source_url, out: Path, *, min_zoom, max_zoom, boxes=(), on_start=None
):
    """Stands in for a real ``pmtiles extract`` invocation: writes an
    actually-valid (tiny) PMTiles archive to ``out`` — via the SAME Rust
    writer the osm feature's own bake uses — so the store's rescan can open
    it for real, and returns a ``CompletedProcess`` shaped like go-pmtiles'
    own (a multi-line stderr progress/summary log, exit 0)."""
    import chartcore

    chartcore.build_vector_pmtiles(
        point_layers=[("places", [(-1.3, 50.7, {"kind": "country", "name": "Testland"})])],
        line_layers=[("roads", [([(-1.3, 50.7), (-1.2, 50.8)], {"kind": "highway"})])],
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        out=out,
    )
    stderr = (
        "fetching 1 dirs, 1 chunks, 1 requests\n"
        "Region tiles 1, result tile entries 1\n"
        "Completed in 0.1s with 4 download threads.\n"
        "Extract required 5 total requests.\n"
        "Extract transferred 1 MB (overfetch 0.05) for an archive size of 1 MB\n"
    )
    return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=stderr)


@pytest.fixture
def ingest_client(tmp_path: Path, monkeypatch, isolated_runtime):
    from fastapi.testclient import TestClient

    from mivnav.api.app import app
    from mivnav.features.osm_world import ingest as osm_world_ingest
    from mivnav.features.osm_world.routes import get_osm_world_store
    from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
    from mivnav.features.osm_world.store import OsmWorldStore

    world_dir = tmp_path / "osm_world"
    world_dir.mkdir()
    store = OsmWorldStore(world_dir, rescan_interval=0)
    runner = OsmWorldIngestRunner(store, run_extract=_fake_extract_writing_real_pmtiles)

    def fake_resolve(http, build_host, *, today, lookback_days):
        return f"{build_host}/20260726.pmtiles", "20260726"

    monkeypatch.setattr(osm_world_ingest, "resolve_build_url", fake_resolve)

    app.dependency_overrides[get_osm_world_store] = lambda: store
    with TestClient(app) as c:
        yield c, world_dir, runner
    app.dependency_overrides.pop(get_osm_world_store, None)


def _wait_done(runner, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = runner.status()
        if status["state"] in ("done", "error"):
            return status
        time.sleep(0.02)
    raise AssertionError("osm_world ingest did not finish in time")


def test_status_idle_before_any_run(ingest_client):
    _, _, runner = ingest_client
    assert runner.status()["state"] == "idle"


def test_extract_writes_pmtiles_and_reaches_done(ingest_client):
    _, world_dir, runner = ingest_client
    runner.ingest()

    status = _wait_done(runner)
    assert status["state"] == "done", status
    assert (world_dir / "osm-world-basemap.pmtiles").is_file()
    assert (world_dir / "osm-world-basemap.json").is_file()
    assert any("20260726" in line for line in status["log"])
    assert any("transferred" in line for line in status["log"])


def test_sidecar_records_resolved_source_url_and_max_zoom(ingest_client):
    _, world_dir, runner = ingest_client
    runner.ingest(name="World")
    _wait_done(runner)
    meta = json.loads((world_dir / "world.json").read_text())
    assert meta["name"] == "World"
    assert meta["bbox"] is None
    assert meta["source_url"] == "https://build.protomaps.com/20260726.pmtiles"
    assert meta["max_zoom"] == 8  # DEFAULT_OSM_WORLD_MAX_ZOOM


def test_baked_set_is_served_through_the_catalog(ingest_client):
    client, _, runner = ingest_client
    runner.ingest(name="World")
    _wait_done(runner)
    sets = client.get("/osm_world/catalog").json()["sets"]
    ids = {s["id"] for s in sets}
    assert "world" in ids
    baked = next(s for s in sets if s["id"] == "world")
    assert baked["tiles"] == "/osm_world/tiles/world/{z}/{x}/{y}"
    assert baked["region"] is None


def test_tiles_all_union_serves_the_extracted_set(ingest_client):
    client, _, runner = ingest_client
    runner.ingest(name="World")
    _wait_done(runner)
    r = client.get("/osm_world/tiles/all/0/0/0")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/vnd.mapbox-vector-tile"


def test_tiles_all_404s_with_no_extracted_sets(ingest_client):
    client, _, _runner = ingest_client
    r = client.get("/osm_world/tiles/all/0/0/0")
    assert r.status_code == 404


def test_delete_removes_pmtiles_and_sidecar(ingest_client):
    client, world_dir, runner = ingest_client
    runner.ingest(name="World")
    _wait_done(runner)
    r = client.delete("/osm_world/sets/world")
    assert r.status_code == 200
    assert not (world_dir / "world.pmtiles").exists()
    assert not (world_dir / "world.json").exists()


def test_extract_failure_reports_error_state(tmp_path: Path, monkeypatch):
    from mivnav.features.osm_world import ingest as osm_world_ingest
    from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
    from mivnav.features.osm_world.store import OsmWorldStore

    world_dir = tmp_path / "osm_world"
    world_dir.mkdir()
    store = OsmWorldStore(world_dir, rescan_interval=0)

    def failing_extract(binary, source_url, out, *, min_zoom, max_zoom, boxes=(), on_start=None):
        return subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="boom: no such host")

    def fake_resolve(http, build_host, *, today, lookback_days):
        return f"{build_host}/20260726.pmtiles", "20260726"

    runner = OsmWorldIngestRunner(store, run_extract=failing_extract)
    monkeypatch.setattr(osm_world_ingest, "resolve_build_url", fake_resolve)
    runner.ingest()
    status = _wait_done(runner)
    assert status["state"] == "error"
    assert "boom" in status["error"]


# -- cancellation (jt lvpkxtsr): the real incident this fixes ----------------
#
# osm_world is the one ingest runner that shells out to a subprocess
# (`pmtiles extract`) — the module docstring's cited incident (a held-open
# subprocess blocking graceful shutdown for 10+ minutes) needs an actual
# `Popen.terminate()`, not just a cooperative flag a blocked process would
# never get to check. This fakes `run_pmtiles_extract`'s own `Popen`
# interface (`.terminate()`/`.poll()`) rather than spawning a real OS
# process, so the test stays fast and has no real binary dependency, while
# still exercising the SAME `on_start`/`_interrupt`/`_proc` wiring the real
# implementation uses.


class _FakeProc:
    def __init__(self) -> None:
        self._terminated = threading.Event()

    def terminate(self) -> None:
        self._terminated.set()

    def poll(self) -> int | None:
        return -15 if self._terminated.is_set() else None


def test_cancel_terminates_the_live_pmtiles_extract_subprocess(tmp_path: Path, monkeypatch):
    from mivnav.features.osm_world import ingest as osm_world_ingest
    from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
    from mivnav.features.osm_world.store import OsmWorldStore

    world_dir = tmp_path / "osm_world"
    world_dir.mkdir()
    store = OsmWorldStore(world_dir, rescan_interval=0)
    extract_started = threading.Event()

    def blocking_extract(binary, source_url, out, *, min_zoom, max_zoom, boxes=(), on_start=None):
        proc = _FakeProc()
        if on_start is not None:
            on_start(proc)
        extract_started.set()
        # Blocks until `_interrupt()` (cancel()'s forceful hook) terminates
        # it — a real `pmtiles extract` blocked in its own network I/O would
        # never notice a plain flag either; only the killed process wakes it.
        if not proc._terminated.wait(5.0):
            raise AssertionError("cancel() never terminated the fake subprocess")
        return subprocess.CompletedProcess(args=[], returncode=-15, stdout="", stderr="terminated")

    def fake_resolve(http, build_host, *, today, lookback_days):
        return f"{build_host}/20260726.pmtiles", "20260726"

    runner = OsmWorldIngestRunner(store, run_extract=blocking_extract)
    monkeypatch.setattr(osm_world_ingest, "resolve_build_url", fake_resolve)

    runner.ingest()
    assert extract_started.wait(5.0), "bake never reached the fake extract"

    assert runner.cancel() is True
    status = _wait_done(runner)
    assert status["state"] == "error", status
    assert status["error"] == "cancelled"


# -- per-dataset zoom override (jt xqoyqxou) ---------------------------------
#
# `OsmWorldDatasetParams.min_zoom`/`max_zoom` — the new lever `_osm_world_
# trigger` forwards into `OsmWorldIngestRunner.ingest`, which merges it onto
# the LIVE `OsmWorldConfig` at bake time (never touching the config itself).


def test_run_pmtiles_extract_passes_minzoom_maxzoom_as_cli_flags(monkeypatch, tmp_path: Path):
    """`run_pmtiles_extract` itself (not the `run_extract` seam other tests
    stub) — proves the actual `pmtiles extract` argv carries whatever
    min_zoom/max_zoom it was called with. Fakes `subprocess.Popen` (a live
    attribute lookup inside `run_pmtiles_extract`'s body, unlike the
    `run_extract` default-argument seam `OsmWorldIngestRunner.__init__`
    binds once at import time — monkeypatching THAT module attribute would
    not reach an already-constructed runner's default)."""
    from mivnav.features.osm_world import ingest as osm_world_ingest

    captured: dict = {}

    class _FakePopen:
        def __init__(self, args, **kwargs):
            captured["args"] = args
            self.args = args

        def communicate(self):
            return "", "ok\n"

        returncode = 0

    monkeypatch.setattr(osm_world_ingest.subprocess, "Popen", _FakePopen)

    osm_world_ingest.run_pmtiles_extract(
        "pmtiles", "https://build.example/x.pmtiles", tmp_path / "out.pmtiles", min_zoom=3, max_zoom=9
    )
    assert "--minzoom=3" in captured["args"]
    assert "--maxzoom=9" in captured["args"]


def test_ingest_dataset_zoom_override_reaches_run_extract(tmp_path: Path, monkeypatch):
    from mivnav.features.osm_world import ingest as osm_world_ingest
    from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
    from mivnav.features.osm_world.store import OsmWorldStore

    calls: list[dict] = []

    def recording_extract(binary, source_url, out, *, min_zoom, max_zoom, boxes=(), on_start=None):
        calls.append({"min_zoom": min_zoom, "max_zoom": max_zoom})
        return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="done\n")

    def fake_resolve(http, build_host, *, today, lookback_days):
        return f"{build_host}/20260726.pmtiles", "20260726"

    monkeypatch.setattr(osm_world_ingest, "resolve_build_url", fake_resolve)
    store = OsmWorldStore(tmp_path / "osm_world", rescan_interval=0)
    runner = OsmWorldIngestRunner(store, run_extract=recording_extract)
    runner.ingest(min_zoom=3, max_zoom=9)
    _wait_done(runner)

    assert calls == [{"min_zoom": 3, "max_zoom": 9}]  # not DEFAULT_OSM_WORLD_MIN/MAX_ZOOM (0/8)


def test_ingest_partial_zoom_override_keeps_the_unoverridden_side_from_config(
    tmp_path: Path, monkeypatch
):
    """Only `max_zoom` given — `min_zoom` must still come from the live
    `OsmWorldConfig` default (0), not from some 0-filled gap."""
    from mivnav.features.osm_world import ingest as osm_world_ingest
    from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
    from mivnav.features.osm_world.store import OsmWorldStore

    calls: list[dict] = []

    def recording_extract(binary, source_url, out, *, min_zoom, max_zoom, boxes=(), on_start=None):
        calls.append({"min_zoom": min_zoom, "max_zoom": max_zoom})
        return subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="done\n")

    def fake_resolve(http, build_host, *, today, lookback_days):
        return f"{build_host}/20260726.pmtiles", "20260726"

    monkeypatch.setattr(osm_world_ingest, "resolve_build_url", fake_resolve)
    store = OsmWorldStore(tmp_path / "osm_world", rescan_interval=0)
    runner = OsmWorldIngestRunner(store, run_extract=recording_extract)
    runner.ingest(max_zoom=5)
    _wait_done(runner)

    assert calls == [{"min_zoom": 0, "max_zoom": 5}]


def test_ingest_rejects_an_override_that_inverts_the_combined_zoom_range(tmp_path: Path):
    """The config's own default max_zoom is 8; overriding min_zoom to 10
    alone inverts the combined range — only catchable here (`ingest`), since
    `OsmWorldDatasetParams`'s own validator never sees the sibling config."""
    from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
    from mivnav.features.osm_world.store import OsmWorldStore

    store = OsmWorldStore(tmp_path / "osm_world", rescan_interval=0)
    runner = OsmWorldIngestRunner(store)
    with pytest.raises(ValueError, match="min_zoom <= max_zoom"):
        runner.ingest(min_zoom=10)
    assert runner.status()["state"] == "idle"  # rejected before a bake ever started


def test_catalog_reports_the_datasets_overridden_zoom_range(ingest_client):
    """End to end through `/osm_world/catalog`: an override changes what the
    ARCHIVE itself is capped to, and the catalog entry reads that straight
    off the archive header (`_catalog_entry`), not off config — so this also
    proves the override actually reached the extract, not just the runner's
    own bookkeeping."""
    client, _, runner = ingest_client
    runner.ingest(name="World", min_zoom=2, max_zoom=5)
    _wait_done(runner)
    sets = client.get("/osm_world/catalog").json()["sets"]
    baked = next(s for s in sets if s["id"] == "world")
    assert baked["min_zoom"] == 2
    assert baked["max_zoom"] == 5


# -- OsmWorldDatasetParams / _osm_world_trigger wiring ------------------------


def test_osm_world_dataset_params_defaults_to_no_override():
    from mivnav.features.osm_world.provider import OsmWorldDatasetParams

    p = OsmWorldDatasetParams()
    assert p.min_zoom is None
    assert p.max_zoom is None


def test_osm_world_dataset_params_rejects_a_stray_param():
    from pydantic import ValidationError

    from mivnav.features.osm_world.provider import OsmWorldDatasetParams

    with pytest.raises(ValidationError):
        OsmWorldDatasetParams(bbox="nope")


def test_osm_world_dataset_params_rejects_an_out_of_range_zoom():
    from pydantic import ValidationError

    from mivnav.features.osm_world.provider import OsmWorldDatasetParams

    with pytest.raises(ValidationError):
        OsmWorldDatasetParams(max_zoom=16)


def test_osm_world_dataset_params_rejects_an_inverted_explicit_range():
    from pydantic import ValidationError

    from mivnav.features.osm_world.provider import OsmWorldDatasetParams

    with pytest.raises(ValidationError):
        OsmWorldDatasetParams(min_zoom=9, max_zoom=6)


def test_osm_world_trigger_forwards_the_dataset_zoom_override_to_the_runner():
    from mivnav.features.osm_world.provider import OsmWorldDatasetParams, _osm_world_trigger

    calls: list[dict] = []

    class _FakeRunner:
        def ingest(self, name=None, min_zoom=None, max_zoom=None, region=None):
            calls.append({"min_zoom": min_zoom, "max_zoom": max_zoom})

    _osm_world_trigger(_FakeRunner(), None, OsmWorldDatasetParams(min_zoom=2, max_zoom=6))
    assert calls == [{"min_zoom": 2, "max_zoom": 6}]


def test_osm_world_trigger_forwards_no_override_when_params_are_default():
    from mivnav.features.osm_world.provider import OsmWorldDatasetParams, _osm_world_trigger

    calls: list[dict] = []

    class _FakeRunner:
        def ingest(self, name=None, min_zoom=None, max_zoom=None, region=None):
            calls.append({"min_zoom": min_zoom, "max_zoom": max_zoom})

    _osm_world_trigger(_FakeRunner(), None, OsmWorldDatasetParams())
    assert calls == [{"min_zoom": None, "max_zoom": None}]


def test_osm_world_trigger_rejects_a_non_osm_world_params_object():
    from mivnav.features.osm_world.provider import _osm_world_trigger

    class _FakeRunner:
        def ingest(self, **kw):
            raise AssertionError("must not be called")

    with pytest.raises(ValueError, match="OsmWorldDatasetParams"):
        _osm_world_trigger(_FakeRunner(), None, None)


def test_missing_binary_reports_a_clear_error(tmp_path: Path, monkeypatch):
    from mivnav.features.osm_world import ingest as osm_world_ingest
    from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
    from mivnav.features.osm_world.store import OsmWorldStore

    world_dir = tmp_path / "osm_world"
    world_dir.mkdir()
    store = OsmWorldStore(world_dir, rescan_interval=0)

    def not_found(binary, source_url, out, *, min_zoom, max_zoom, boxes=(), on_start=None):
        raise FileNotFoundError(binary)

    runner = OsmWorldIngestRunner(store, run_extract=not_found)

    def fake_resolve(http, build_host, *, today, lookback_days):
        return f"{build_host}/20260726.pmtiles", "20260726"

    monkeypatch.setattr(osm_world_ingest, "resolve_build_url", fake_resolve)
    runner.ingest()
    status = _wait_done(runner)
    assert status["state"] == "error"
    assert "not found" in status["error"]


# ── Region-scoped extracts (task unqqplrl) ──────────────────────────────────


def _region(**kw):
    from mivnav.config.model import BBox, Region

    boxes = kw.pop("boxes", None)
    if boxes is not None:
        kw["bboxes"] = tuple(
            BBox(min_lon=b[0], min_lat=b[1], max_lon=b[2], max_lat=b[3]) for b in boxes
        )
    kw.setdefault("id", "r")
    return Region(**kw)


def test_region_boxes_is_empty_for_no_region():
    from mivnav.features.osm_world.ingest import region_boxes

    assert region_boxes(None) == ()


def test_region_boxes_reads_every_box_of_a_multi_box_region():
    """A multi-box region is the archipelago case — extracting the ENCLOSING
    box would bake the water between the boxes at full detail, which is the
    whole cost this scoping exists to avoid."""
    from mivnav.features.osm_world.ingest import region_boxes

    boxes = region_boxes(_region(boxes=[(-2.0, 50.0, -1.0, 51.0), (10.0, 54.0, 11.0, 55.0)]))
    assert boxes == ((-2.0, 50.0, -1.0, 51.0), (10.0, 54.0, 11.0, 55.0))


def test_region_boxes_collapses_a_country_region_to_its_enclosing_box():
    """A country region's `bboxes` is a meaningless Solent-default leftover
    (mivnav.config.model.Region's value-based precedence) — reading it here
    would silently bake the wrong place."""
    from mivnav.features.osm_world.ingest import region_boxes

    region = _region(country="DK")
    assert region_boxes(region) == (region.bbox,)
    assert region_boxes(region)[0] != (-1.65, 50.68, -1.05, 50.82)


def test_one_box_passes_pmtiles_bbox_and_no_temp_file(monkeypatch, tmp_path: Path):
    from mivnav.features.osm_world import ingest as osm_world_ingest

    captured: dict = {}

    class _FakePopen:
        def __init__(self, args, **kwargs):
            captured["args"] = args
            self.args = args

        def communicate(self):
            return "", "ok\n"

        returncode = 0

    monkeypatch.setattr(osm_world_ingest.subprocess, "Popen", _FakePopen)
    osm_world_ingest.run_pmtiles_extract(
        "pmtiles",
        "https://build.example/x.pmtiles",
        tmp_path / "out.pmtiles",
        min_zoom=0,
        max_zoom=12,
        boxes=[(-2.0, 50.0, -1.0, 51.0)],
    )
    assert "--bbox=-2.0,50.0,-1.0,51.0" in captured["args"]
    assert not any(a.startswith("--region=") for a in captured["args"])


def test_several_boxes_pass_a_geojson_multipolygon_alive_for_the_process(
    monkeypatch, tmp_path: Path
):
    """`--bbox` cannot express two boxes; `--region` can. The temp file must
    still EXIST while the process is reading it — a NamedTemporaryFile closed
    before `communicate()` would hand go-pmtiles a path that is already
    gone."""
    from mivnav.features.osm_world import ingest as osm_world_ingest

    captured: dict = {}

    class _FakePopen:
        def __init__(self, args, **kwargs):
            captured["args"] = args
            self.args = args

        def communicate(self):
            path = next(a.split("=", 1)[1] for a in captured["args"] if a.startswith("--region="))
            captured["geojson"] = json.loads(Path(path).read_text())
            return "", "ok\n"

        returncode = 0

    monkeypatch.setattr(osm_world_ingest.subprocess, "Popen", _FakePopen)
    osm_world_ingest.run_pmtiles_extract(
        "pmtiles",
        "https://build.example/x.pmtiles",
        tmp_path / "out.pmtiles",
        min_zoom=0,
        max_zoom=12,
        boxes=[(-2.0, 50.0, -1.0, 51.0), (10.0, 54.0, 11.0, 55.0)],
    )
    assert not any(a.startswith("--bbox=") for a in captured["args"])
    gj = captured["geojson"]
    assert gj["type"] == "MultiPolygon"
    assert len(gj["coordinates"]) == 2
    # closed ring, counter-clockwise (RFC 7946's right-hand rule)
    assert gj["coordinates"][0][0] == [
        [-2.0, 50.0], [-1.0, 50.0], [-1.0, 51.0], [-2.0, 51.0], [-2.0, 50.0]
    ]


def _recording_runner(tmp_path: Path, monkeypatch, calls: list):
    from mivnav.features.osm_world import ingest as osm_world_ingest
    from mivnav.features.osm_world.ingest import OsmWorldIngestRunner
    from mivnav.features.osm_world.store import OsmWorldStore

    world_dir = tmp_path / "osm_world"
    world_dir.mkdir()

    def recording_extract(binary, source_url, out, *, min_zoom, max_zoom, boxes=(), on_start=None):
        calls.append({"min_zoom": min_zoom, "max_zoom": max_zoom, "boxes": tuple(boxes)})
        return _fake_extract_writing_real_pmtiles(
            binary, source_url, out, min_zoom=min_zoom, max_zoom=max_zoom
        )

    def fake_resolve(http, build_host, *, today, lookback_days):
        return f"{build_host}/20260726.pmtiles", "20260726"

    monkeypatch.setattr(osm_world_ingest, "resolve_build_url", fake_resolve)
    store = OsmWorldStore(world_dir, rescan_interval=0)
    return OsmWorldIngestRunner(store, run_extract=recording_extract), world_dir


def test_a_region_bake_uses_the_region_max_zoom_default_not_the_world_one(
    tmp_path: Path, monkeypatch
):
    """A region dataset that inherited the WORLD default (z8) would bake a
    strict duplicate of the global set and nothing else — see
    OsmWorldConfig.region_max_zoom."""
    from mivnav.features.osm_world.config import (
        DEFAULT_OSM_WORLD_MAX_ZOOM,
        DEFAULT_OSM_WORLD_REGION_MAX_ZOOM,
    )

    calls: list = []
    runner, _ = _recording_runner(tmp_path, monkeypatch, calls)
    runner.ingest(region=_region(boxes=[(-2.0, 50.0, -1.0, 51.0)]))
    _wait_done(runner)
    assert calls[0]["max_zoom"] == DEFAULT_OSM_WORLD_REGION_MAX_ZOOM
    assert calls[0]["max_zoom"] != DEFAULT_OSM_WORLD_MAX_ZOOM
    assert calls[0]["boxes"] == ((-2.0, 50.0, -1.0, 51.0),)


def test_a_world_bake_still_uses_the_world_max_zoom_and_no_boxes(tmp_path: Path, monkeypatch):
    from mivnav.features.osm_world.config import DEFAULT_OSM_WORLD_MAX_ZOOM

    calls: list = []
    runner, _ = _recording_runner(tmp_path, monkeypatch, calls)
    runner.ingest()
    _wait_done(runner)
    assert calls[0]["max_zoom"] == DEFAULT_OSM_WORLD_MAX_ZOOM
    assert calls[0]["boxes"] == ()


def test_a_dataset_max_zoom_override_still_beats_the_region_default(tmp_path: Path, monkeypatch):
    calls: list = []
    runner, _ = _recording_runner(tmp_path, monkeypatch, calls)
    runner.ingest(max_zoom=10, region=_region(boxes=[(-2.0, 50.0, -1.0, 51.0)]))
    _wait_done(runner)
    assert calls[0]["max_zoom"] == 10


def test_a_region_bakes_sidecar_bbox_and_the_catalog_reports_it(tmp_path: Path, monkeypatch):
    calls: list = []
    runner, world_dir = _recording_runner(tmp_path, monkeypatch, calls)
    runner.ingest(
        name="Solent", region=_region(boxes=[(-2.0, 50.0, -1.0, 51.0), (10.0, 54.0, 11.0, 55.0)])
    )
    _wait_done(runner)
    sidecar = json.loads((world_dir / "solent.json").read_text())
    # the ENCLOSING box of both — a single rectangle is all the catalog's
    # `region`/`bounds` hint can express
    assert sidecar["bbox"] == [-2.0, 50.0, 11.0, 55.0]

    from mivnav.features.osm_world.sidecar import resolve_metadata

    _, _, region = resolve_metadata(world_dir, "solent", 0)
    assert region == {"bbox": [-2.0, 50.0, 11.0, 55.0]}


def test_a_world_bake_leaves_the_sidecar_bbox_null(tmp_path: Path, monkeypatch):
    calls: list = []
    runner, world_dir = _recording_runner(tmp_path, monkeypatch, calls)
    runner.ingest(name="World")
    _wait_done(runner)
    assert json.loads((world_dir / "world.json").read_text())["bbox"] is None


def test_the_trigger_forwards_the_resolved_region_to_the_runner():
    from mivnav.features.osm_world.provider import OsmWorldDatasetParams, _osm_world_trigger

    calls: list = []

    class _FakeRunner:
        def ingest(self, name=None, min_zoom=None, max_zoom=None, region=None):
            calls.append(region)

    region = _region(boxes=[(-2.0, 50.0, -1.0, 51.0)])
    _osm_world_trigger(_FakeRunner(), region, OsmWorldDatasetParams())
    assert calls == [region]
