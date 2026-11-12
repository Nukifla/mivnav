# SPDX-License-Identifier: GPL-2.0-only
"""``mivnav.features.weather.ingest`` — the weather bake job (#rktyytqx):
the pure manifest→path resolution, the fetch-idempotency/prune mechanics of
:class:`WeatherIngestRunner`, and its integration with :class:`IngestRunner`'s
poll-able status."""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from mivnav.features.weather import ingest as ingest_mod
from mivnav.features.weather.ingest import (
    DATA_SPATIAL,
    WeatherIngestError,
    WeatherIngestRunner,
    om_path_for,
    _prune_stale,
    om_paths_for_bake,
)

# -- _om_path / om_paths_for_bake (pure) ------------------------------------


def test_om_path_matches_the_ported_js_algorithm():
    # Ported from @openmeteo/weather-map-layer's normalizeUrl (dist/index.js):
    # run dir from reference_time (Y/M/D/HH00Z), filename from valid_time
    # alone (Y-M-DTHHMM.om) — see the module docstring for the source.
    path = om_path_for("dwd_icon", "2026-07-24T12:00:00Z", "2026-07-24T15:00Z")
    assert path == "dwd_icon/2026/07/24/1200Z/2026-07-24T1500.om"


def test_om_path_run_and_valid_time_can_cross_a_day_boundary():
    # A run at 18Z can still serve an early-next-day valid time; the run dir
    # and filename are independent, not forced to agree.
    path = om_path_for("dwd_icon", "2026-07-24T18:00:00Z", "2026-07-25T02:00Z")
    assert path == "dwd_icon/2026/07/24/1800Z/2026-07-25T0200.om"


def test_om_paths_for_bake_without_a_horizon_keeps_only_todays_valid_times():
    # No `max_forecast_hours` == the behaviour the bake had before the option
    # existed, and what every dataset declared back then still gets.
    now = datetime(2026, 7, 24, 15, 30, tzinfo=timezone.utc)
    manifest = {
        "reference_time": "2026-07-24T12:00:00Z",
        "valid_times": [
            "2026-07-23T23:00Z",  # yesterday — excluded
            "2026-07-24T00:00Z",  # today — included
            "2026-07-24T15:00Z",  # today — included
            "2026-07-24T23:00Z",  # today — included
            "2026-07-25T00:00Z",  # tomorrow — excluded
        ],
    }
    paths = om_paths_for_bake("dwd_icon", manifest, now=now)
    assert paths == [
        "dwd_icon/2026/07/24/1200Z/2026-07-24T0000.om",
        "dwd_icon/2026/07/24/1200Z/2026-07-24T1500.om",
        "dwd_icon/2026/07/24/1200Z/2026-07-24T2300.om",
    ]


def test_om_paths_for_bake_empty_manifest_is_empty_not_an_error():
    now = datetime(2026, 7, 24, tzinfo=timezone.utc)
    assert om_paths_for_bake("dwd_icon", {}, now=now) == []
    assert om_paths_for_bake("dwd_icon", {"reference_time": "x"}, now=now) == []
    assert om_paths_for_bake("dwd_icon", {"valid_times": []}, now=now) == []


def test_om_paths_for_bake_skips_unparseable_valid_times():
    now = datetime(2026, 7, 24, tzinfo=timezone.utc)
    manifest = {
        "reference_time": "2026-07-24T12:00:00Z",
        "valid_times": ["not-a-date", "2026-07-24T05:00Z"],
    }
    assert om_paths_for_bake("dwd_icon", manifest, now=now) == [
        "dwd_icon/2026/07/24/1200Z/2026-07-24T0500.om",
    ]


# -- om_paths_for_bake: the max_forecast_hours horizon (#yuknulso) -------------

_LONG_RUN = {
    "reference_time": "2026-07-24T12:00:00Z",
    "valid_times": [
        "2026-07-23T23:00Z",  # yesterday — always excluded
        "2026-07-24T12:00Z",  # +0 h
        "2026-07-24T18:00Z",  # +6 h
        "2026-07-25T12:00Z",  # +24 h
        "2026-07-27T12:00Z",  # +72 h
        "2026-08-09T12:00Z",  # +384 h (a GFS-length tail)
    ],
}


def test_om_paths_for_bake_horizon_extends_past_today_and_caps_lead_time():
    # The whole point of the option: a horizon > today's remainder reaches
    # into following days, and still stops at the lead time asked for.
    now = datetime(2026, 7, 24, 15, 30, tzinfo=timezone.utc)
    assert om_paths_for_bake("dwd_icon", _LONG_RUN, now=now, max_forecast_hours=24) == [
        "dwd_icon/2026/07/24/1200Z/2026-07-24T1200.om",
        "dwd_icon/2026/07/24/1200Z/2026-07-24T1800.om",
        "dwd_icon/2026/07/24/1200Z/2026-07-25T1200.om",
    ]


def test_om_paths_for_bake_horizon_is_lead_time_from_the_run_not_from_now():
    # +6 h is measured from reference_time (12Z), not from `now` (15:30Z) —
    # so the selected set does not drift while the job runs.
    now = datetime(2026, 7, 24, 15, 30, tzinfo=timezone.utc)
    assert om_paths_for_bake("dwd_icon", _LONG_RUN, now=now, max_forecast_hours=6) == [
        "dwd_icon/2026/07/24/1200Z/2026-07-24T1200.om",
        "dwd_icon/2026/07/24/1200Z/2026-07-24T1800.om",
    ]


def test_om_paths_for_bake_horizon_never_reaches_back_into_yesterday():
    now = datetime(2026, 7, 24, 15, 30, tzinfo=timezone.utc)
    paths = om_paths_for_bake("dwd_icon", _LONG_RUN, now=now, max_forecast_hours=400)
    assert "dwd_icon/2026/07/24/1200Z/2026-07-23T2300.om" not in paths
    assert len(paths) == 5  # every valid time except yesterday's


def test_om_paths_for_bake_horizon_with_an_unparseable_reference_time_is_empty():
    now = datetime(2026, 7, 24, tzinfo=timezone.utc)
    manifest = {"reference_time": "not-a-date", "valid_times": ["2026-07-24T05:00Z"]}
    assert om_paths_for_bake("dwd_icon", manifest, now=now, max_forecast_hours=48) == []


# -- _prune_stale --------------------------------------------------------------


def test_prune_stale_deletes_files_not_in_keep_and_leaves_the_rest(tmp_path):
    domain_dir = tmp_path / DATA_SPATIAL / "dwd_icon"
    stale = domain_dir / "2026/07/23/1200Z/2026-07-23T1500.om"
    fresh = domain_dir / "2026/07/24/1200Z/2026-07-24T1500.om"
    for f in (stale, fresh):
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"data")

    removed = _prune_stale(domain_dir, keep={"dwd_icon/2026/07/24/1200Z/2026-07-24T1500.om"})

    assert removed == 1
    assert not stale.exists()
    assert fresh.exists()


def test_prune_stale_cleans_up_now_empty_run_directories(tmp_path):
    domain_dir = tmp_path / DATA_SPATIAL / "dwd_icon"
    stale = domain_dir / "2026/07/23/1200Z/2026-07-23T1500.om"
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_bytes(b"data")

    _prune_stale(domain_dir, keep=set())

    assert not (domain_dir / "2026/07/23/1200Z").exists()
    assert not (domain_dir / "2026/07/23").exists()
    assert not (domain_dir / "2026/07").exists()
    # domain_dir/2026 removed too, but domain_dir itself (data_spatial/dwd_icon)
    # is never touched by pruning — only its descendants.
    assert not (domain_dir / "2026").exists()


def test_prune_stale_missing_domain_dir_is_a_noop(tmp_path):
    assert _prune_stale(tmp_path / "never-baked", keep=set()) == 0


# -- WeatherIngestRunner --------------------------------------------------------


def _manifest_response(request: httpx.Request, manifest: dict) -> httpx.Response:
    return httpx.Response(200, json=manifest, request=request)


def _make_transport(manifest: dict, om_bodies: dict[str, bytes], calls: list[str]):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        path = str(request.url)
        if path.endswith("latest.json"):
            return _manifest_response(request, manifest)
        for om_path, body in om_bodies.items():
            if path.endswith(om_path):
                return httpx.Response(200, content=body, request=request)
        return httpx.Response(404, request=request)

    return httpx.MockTransport(handler)


def _today_manifest() -> tuple[dict, list[str]]:
    now = datetime.now(timezone.utc)
    ref = now.replace(minute=0, second=0, microsecond=0)
    valid = ref.isoformat().replace("+00:00", "Z")
    reference_time = ref.isoformat().replace("+00:00", "Z")
    manifest = {"reference_time": reference_time, "valid_times": [valid]}
    paths = om_paths_for_bake("dwd_icon", manifest, now=now)
    return manifest, paths


def _wait_for_idle(runner: WeatherIngestRunner, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    status = runner.status()
    while time.time() < deadline and status["state"] not in ("done", "error"):
        time.sleep(0.01)
        status = runner.status()
    return status


def test_ingest_fetches_todays_om_files_and_reports_progress(tmp_path):
    manifest, paths = _today_manifest()
    assert paths, "test setup needs at least one path for 'today'"
    om_bodies = {p: f"bytes-for-{p}".encode() for p in paths}
    calls: list[str] = []
    http = httpx.Client(transport=_make_transport(manifest, om_bodies, calls))
    runner = WeatherIngestRunner(tmp_path, http=http)

    runner.ingest("dwd_icon")
    status = _wait_for_idle(runner)

    assert status["state"] == "done", status
    assert status["om_files"] == len(paths)
    for p in paths:
        assert (tmp_path / DATA_SPATIAL / p).read_bytes() == om_bodies[p]


def test_ingest_is_idempotent_and_does_not_refetch_already_baked_files(tmp_path):
    manifest, paths = _today_manifest()
    assert paths
    om_bodies = {p: b"body" for p in paths}
    calls: list[str] = []
    http = httpx.Client(transport=_make_transport(manifest, om_bodies, calls))
    runner = WeatherIngestRunner(tmp_path, http=http)

    runner.ingest("dwd_icon")
    _wait_for_idle(runner)
    first_call_count = len(calls)

    # A second bake sees every om file already on disk (immutable) — no new
    # upstream GETs beyond the manifest re-fetch.
    runner.ingest("dwd_icon")
    status = _wait_for_idle(runner)
    assert status["om_files"] == 0  # nothing NEW fetched
    assert len(calls) == first_call_count + 1  # +1 manifest fetch only


def test_ingest_prunes_a_stale_run_left_over_from_a_previous_day(tmp_path):
    manifest, paths = _today_manifest()
    assert paths
    stale = tmp_path / DATA_SPATIAL / "dwd_icon/2020/01/01/0000Z/2020-01-01T0000.om"
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"old")

    om_bodies = {p: b"body" for p in paths}
    calls: list[str] = []
    http = httpx.Client(transport=_make_transport(manifest, om_bodies, calls))
    runner = WeatherIngestRunner(tmp_path, http=http)

    runner.ingest("dwd_icon")
    status = _wait_for_idle(runner)

    assert status["state"] == "done", status
    assert status["pruned"] == 1
    assert not stale.exists()


def test_ingest_lowering_max_forecast_hours_prunes_the_now_out_of_range_files(tmp_path):
    """Retention is not a separate rule: the prune step keeps exactly what
    the CURRENT `max_forecast_hours` selects, so turning the horizon down
    frees the disk on the very next bake (#yuknulso)."""
    now = datetime.now(timezone.utc)
    ref = now.replace(minute=0, second=0, microsecond=0)
    stamp = ref.isoformat().replace("+00:00", "Z")
    valid = [(ref + timedelta(hours=h)).isoformat().replace("+00:00", "Z") for h in (0, 24, 48)]
    manifest = {"reference_time": stamp, "valid_times": valid}

    wide = om_paths_for_bake("dwd_icon", manifest, now=now, max_forecast_hours=48)
    narrow = om_paths_for_bake("dwd_icon", manifest, now=now, max_forecast_hours=24)
    assert len(wide) == 3 and len(narrow) == 2

    om_bodies = {p: b"body" for p in wide}
    calls: list[str] = []
    http = httpx.Client(transport=_make_transport(manifest, om_bodies, calls))
    runner = WeatherIngestRunner(tmp_path, http=http)

    runner.ingest("dwd_icon", max_forecast_hours=48)
    assert _wait_for_idle(runner)["om_files"] == 3

    runner.ingest("dwd_icon", max_forecast_hours=24)
    status = _wait_for_idle(runner)
    assert status["state"] == "done", status
    assert status["pruned"] == 1
    assert not (tmp_path / DATA_SPATIAL / wide[2]).exists()
    for p in narrow:
        assert (tmp_path / DATA_SPATIAL / p).exists()


def test_ingest_a_failed_om_fetch_is_skipped_not_fatal(tmp_path):
    """A 404 for one hour (upstream hasn't published it yet) must not fail
    the whole bake — same per-item tolerance POI/satellite's own fetches
    have (see the module docstring)."""
    manifest, paths = _today_manifest()
    assert paths

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("latest.json"):
            return _manifest_response(request, manifest)
        return httpx.Response(404, request=request)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    runner = WeatherIngestRunner(tmp_path, http=http)

    runner.ingest("dwd_icon")
    status = _wait_for_idle(runner)

    assert status["state"] == "done"  # not "error"
    assert status["om_files"] == 0
    for p in paths:
        assert not (tmp_path / DATA_SPATIAL / p).exists()


def test_ingest_a_failed_manifest_fetch_fails_the_bake(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, request=request)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    runner = WeatherIngestRunner(tmp_path, http=http)

    runner.ingest("dwd_icon")
    status = _wait_for_idle(runner)

    assert status["state"] == "error"
    assert "manifest" in status["error"]


def test_ingest_rejects_an_empty_domain_synchronously(tmp_path):
    runner = WeatherIngestRunner(tmp_path, http=httpx.Client())
    with pytest.raises(WeatherIngestError):
        runner.ingest("")


def _ranged_transport(
    manifest: dict,
    om_bodies: dict[str, bytes],
    fail_start: int | None = None,
    ranges: list[str] | None = None,
):
    """A Range-honouring upstream (like the real bucket); ``fail_start`` makes
    the part starting at that offset 500."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("latest.json"):
            return _manifest_response(request, manifest)
        body = next((b for p, b in om_bodies.items() if url.endswith(p)), None)
        if body is None:
            return httpx.Response(404, request=request)
        m = re.match(r"bytes=(\d+)-(\d+)", request.headers.get("range", ""))
        if ranges is not None:
            ranges.append(request.headers.get("range", ""))
        if not m:
            return httpx.Response(200, content=body, request=request)
        s, e = int(m.group(1)), min(int(m.group(2)), len(body) - 1)
        if s == fail_start:
            return httpx.Response(500, request=request)
        return httpx.Response(
            206,
            content=body[s : e + 1],
            headers={"content-range": f"bytes {s}-{e}/{len(body)}"},
            request=request,
        )

    return httpx.MockTransport(handler)


def test_a_ranged_upstream_is_fetched_as_parallel_parts_and_reassembled(tmp_path, monkeypatch):
    """The real bucket honours Range: a file is split into parts, fetched
    concurrently and written in place — byte-identical to the original."""
    monkeypatch.setattr(ingest_mod, "_PART_BYTES", 1000)
    manifest, paths = _today_manifest()
    om_bodies = {p: bytes(i % 251 for i in range(10_500)) for p in paths}
    ranges: list[str] = []
    runner = WeatherIngestRunner(
        tmp_path,
        http=httpx.Client(transport=_ranged_transport(manifest, om_bodies, ranges=ranges)),
    )

    runner.ingest("dwd_icon")
    status = _wait_for_idle(runner)

    assert status["state"] == "done", status
    for p in paths:
        assert (tmp_path / DATA_SPATIAL / p).read_bytes() == om_bodies[p]
    # The size probe, then 11 parts of <=1000 B per file — never one plain GET.
    assert "" not in ranges
    assert len(ranges) == len(paths) * 12


def test_one_failed_part_leaves_no_file_behind(tmp_path, monkeypatch):
    """A half-written `.om` would be served as baked data forever (baked files
    are immutable and never refetched) — so a failed part keeps nothing."""
    monkeypatch.setattr(ingest_mod, "_PART_BYTES", 1000)
    manifest, paths = _today_manifest()
    om_bodies = {p: bytes(10_500) for p in paths}
    runner = WeatherIngestRunner(
        tmp_path,
        http=httpx.Client(transport=_ranged_transport(manifest, om_bodies, fail_start=5000)),
    )

    runner.ingest("dwd_icon")
    status = _wait_for_idle(runner)

    assert status["state"] == "done", status  # one bad hour doesn't fail the bake
    assert status["om_files"] == 0
    leftovers = [f for f in (tmp_path / DATA_SPATIAL).rglob("*") if f.is_file()]
    assert leftovers == []


# -- variable-only (sparse) bake ------------------------------------------------


def _write_om(path, names, placement="tail"):
    """A real `.om` with one 2-D float field per name, laid out like
    upstream's (a root group; metadata consolidated at the tail)."""
    import numpy as np
    import omfiles

    rng = np.random.default_rng(7)
    w = omfiles.OmFileWriter.at_path(str(path), metadata_placement=placement)
    children = [
        w.write_array(
            rng.normal(10, 5, (120, 160)).astype(np.float32),
            chunks=[32, 32],
            scale_factor=100.0,
            name=n,
        )
        for n in names
    ]
    w.close(w.write_group("", children=children))
    return path.read_bytes()


def _read(path, name):
    import numpy as np
    import omfiles

    r = omfiles.OmFileReader.from_path(str(path))
    try:
        return np.asarray(r.get_child_by_name(name).read_array((...,)))
    finally:
        r.close()


def _bake_one(tmp_path, body, keep, served):
    """Bake one hour of ``body`` from a Range upstream, keeping ``keep``;
    ``served`` collects the bytes the upstream sent."""
    manifest, paths = _today_manifest()

    def handler(request: httpx.Request) -> httpx.Response:
        m = re.match(r"bytes=(\d+)-(\d+)", request.headers.get("range", ""))
        assert m, "a sparse-capable bake only ever sends ranged requests"
        s, e = int(m.group(1)), min(int(m.group(2)), len(body) - 1)
        served.append(e - s + 1)
        return httpx.Response(
            206,
            content=body[s : e + 1],
            headers={"content-range": f"bytes {s}-{e}/{len(body)}"},
            request=request,
        )

    runner = WeatherIngestRunner(tmp_path / "ds", http=httpx.Client(transport=httpx.MockTransport(handler)))
    assert runner._fetch_om("http://up", paths[0], None, frozenset(keep))
    return tmp_path / "ds" / DATA_SPATIAL / paths[0]


VARS = ["temperature_2m", "cloud_cover", "wind_speed_10m", "wind_direction_10m", "precipitation"]


def test_a_bake_keeps_only_the_drawable_variables_bit_identical(tmp_path, monkeypatch):
    """Only the kept variables' bytes (plus header and metadata tail) are
    fetched, at their own offsets: they decode identical to the original, and
    a dropped one fails cleanly instead of decoding as garbage."""
    # A first tail read smaller than this small fixture, as it is on a real
    # file — else that one read already holds everything.
    monkeypatch.setattr(ingest_mod, "_TAIL_GUESS", 1024)
    src = tmp_path / "src.om"
    body = _write_om(src, VARS)
    keep = {"wind_speed_10m", "wind_direction_10m", "temperature_2m"}
    served: list[int] = []

    out = _bake_one(tmp_path, body, keep, served)

    assert out.stat().st_size == len(body)  # same offsets, so the decoder opens it unchanged
    for name in keep:
        assert (_read(out, name) == _read(src, name)).all()
    with pytest.raises(RuntimeError):
        _read(out, "cloud_cover")
    assert sum(served) < 0.8 * len(body)  # 3 of 5 fields, not the whole file


def test_a_file_holding_none_of_the_kept_variables_is_fetched_whole(tmp_path):
    src = tmp_path / "src.om"
    body = _write_om(src, VARS)
    out = _bake_one(tmp_path, body, {"wave_height"}, [])
    assert out.read_bytes() == body


def test_inline_metadata_still_bakes_correctly(tmp_path, monkeypatch):
    """Upstream consolidates metadata at the tail; a file that doesn't must
    still bake right (whole, if its layout can't be used)."""
    monkeypatch.setattr(ingest_mod, "_TAIL_MAX", 1)  # force the big-tail guard
    src = tmp_path / "src.om"
    body = _write_om(src, VARS, placement="inline")
    out = _bake_one(tmp_path, body, {"wind_speed_10m"}, [])
    assert (_read(out, "wind_speed_10m") == _read(src, "wind_speed_10m")).all()


def test_a_bake_keeps_the_domain_s_drawable_names_including_waves():
    from mivnav.features.weather.sources import upstream_names_for

    assert upstream_names_for("metno_nordic_pp") == {
        "wind_u_component_10m", "wind_v_component_10m", "wind_speed_10m",
        "wind_direction_10m", "wind_gusts_10m", "pressure_msl", "temperature_2m",
    }
    assert upstream_names_for("ecmwf_wam025") == {"wave_height", "wave_direction"}
    assert upstream_names_for("meteofrance_currents") == frozenset()
