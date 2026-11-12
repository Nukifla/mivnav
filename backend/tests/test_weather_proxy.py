# SPDX-License-Identifier: GPL-2.0-only
"""The weather range-cache proxy: correctness, caching, chunk sharing."""

from __future__ import annotations

import asyncio
import re

import httpx

from mivnav.features.weather import proxy as wp
from mivnav.features.weather.proxy import WeatherProxy

# A deterministic "file": each byte equals its offset mod 251, so any slice is
# verifiable by index alone.
FILE = bytes(i % 251 for i in range(50_000))


def _install_upstream(monkeypatch, counter: list[int] | None = None) -> None:
    """Point the proxy's HTTP client at an in-memory Range server."""

    def handler(request: httpx.Request) -> httpx.Response:
        if counter is not None:
            counter.append(1)
        rng = request.headers.get("range")
        if not rng:
            return httpx.Response(200, content=FILE)
        m = re.match(r"bytes=(\d+)-(\d*)", rng)
        assert m
        s = int(m.group(1))
        e = int(m.group(2)) if m.group(2) else len(FILE) - 1
        e = min(e, len(FILE) - 1)
        body = FILE[s : e + 1]
        return httpx.Response(
            206, content=body, headers={"content-range": f"bytes {s}-{e}/{len(FILE)}"}
        )

    monkeypatch.setattr(
        wp, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )


def _proxy(
    tmp_path, chunk=4096, budget=10**9, latest_ttl=0, prewarm=0
) -> WeatherProxy:
    return WeatherProxy(
        cache_dir=tmp_path,
        cache_budget=budget,
        tiles_url="http://upstream",
        forecast_url="http://upstream/forecast",
        chunk_bytes=chunk,
        latest_ttl=latest_ttl,
        prewarm_neighbours=prewarm,
    )


async def _drain_prewarm() -> None:
    """Await every outstanding fire-and-forget prewarm task (a snapshot — tasks
    self-remove as they finish; prewarm does not spawn further prewarm)."""
    await asyncio.gather(*list(wp._prewarm_tasks), return_exceptions=True)


class _GatedTransport(httpx.AsyncBaseTransport):
    """A Range upstream whose every fetch blocks on ``gate`` until released, and
    which tallies how many times each chunk-start was fetched. Lets a test hold
    a fetch 'in flight' and prove what does — and doesn't — wait behind it."""

    def __init__(self, gate: asyncio.Event, counter: dict[int, int]) -> None:
        self.gate = gate
        self.counter = counter

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        await self.gate.wait()
        m = re.match(r"bytes=(\d+)-(\d*)", request.headers["range"])
        assert m
        s = int(m.group(1))
        e = min(int(m.group(2)) if m.group(2) else len(FILE) - 1, len(FILE) - 1)
        self.counter[s] = self.counter.get(s, 0) + 1
        return httpx.Response(
            206,
            content=FILE[s : e + 1],
            headers={"content-range": f"bytes {s}-{e}/{len(FILE)}"},
            request=request,
        )


def test_range_is_served_correctly(tmp_path, monkeypatch):
    _install_upstream(monkeypatch)
    p = _proxy(tmp_path)
    status, headers, body = asyncio.run(
        p.om_range("data_spatial/m/r/t.om", "variable=x", "bytes=100-200")
    )
    assert status == 206
    assert body == FILE[100:201]
    assert headers["Content-Range"] == f"bytes 100-200/{len(FILE)}"


def test_second_read_is_served_from_cache(tmp_path, monkeypatch):
    calls: list[int] = []
    _install_upstream(monkeypatch, calls)
    p = _proxy(tmp_path)
    asyncio.run(p.om_range("data_spatial/m/r/t.om", "", "bytes=100-200"))
    n = len(calls)
    # A sub-range inside the same chunk needs no new upstream fetch.
    _, _, body = asyncio.run(p.om_range("data_spatial/m/r/t.om", "", "bytes=120-180"))
    assert body == FILE[120:181]
    assert len(calls) == n  # no additional upstream request


def test_variables_share_cached_chunks(tmp_path, monkeypatch):
    calls: list[int] = []
    _install_upstream(monkeypatch, calls)
    p = _proxy(tmp_path)
    # Same file path, different `variable` query — the file is query-independent,
    # so the second variable reuses the first's cached chunk.
    asyncio.run(p.om_range("data_spatial/m/r/t.om", "variable=wind", "bytes=0-100"))
    n = len(calls)
    _, _, body = asyncio.run(
        p.om_range("data_spatial/m/r/t.om", "variable=pressure", "bytes=50-150")
    )
    assert body == FILE[50:151]
    assert len(calls) == n  # chunk 0 already cached


def test_range_spanning_chunks(tmp_path, monkeypatch):
    _install_upstream(monkeypatch)
    p = _proxy(tmp_path, chunk=4096)
    # 4000..9000 spans chunks 0,1,2.
    _, headers, body = asyncio.run(
        p.om_range("data_spatial/m/r/t.om", "", "bytes=4000-9000")
    )
    assert body == FILE[4000:9001]
    assert headers["Content-Range"] == f"bytes 4000-9000/{len(FILE)}"


def test_open_ended_range_clamps_to_size(tmp_path, monkeypatch):
    _install_upstream(monkeypatch)
    p = _proxy(tmp_path)
    _, headers, body = asyncio.run(
        p.om_range("data_spatial/m/r/t.om", "", f"bytes={len(FILE) - 10}-")
    )
    assert body == FILE[-10:]
    assert (
        headers["Content-Range"]
        == f"bytes {len(FILE) - 10}-{len(FILE) - 1}/{len(FILE)}"
    )


def test_out_of_range_is_416(tmp_path, monkeypatch):
    _install_upstream(monkeypatch)
    p = _proxy(tmp_path)
    status, _, _ = asyncio.run(
        p.om_range("data_spatial/m/r/t.om", "", f"bytes={len(FILE) + 5}-")
    )
    assert status == 416


def test_missing_range_header_is_416(tmp_path, monkeypatch):
    _install_upstream(monkeypatch)
    p = _proxy(tmp_path)
    status, _, _ = asyncio.run(p.om_range("data_spatial/m/r/t.om", "", ""))
    assert status == 416


def test_budget_evicts_oldest_file(tmp_path, monkeypatch):
    _install_upstream(monkeypatch)
    # Read-ahead off: this is about eviction order, and needs each file to
    # hold exactly the one chunk its read touched.
    monkeypatch.setattr(wp, "_READAHEAD_BYTES", 0)
    # Budget below two files' worth of one chunk each → the older is evicted.
    p = _proxy(tmp_path, chunk=4096, budget=5000)
    asyncio.run(p.om_range("data_spatial/m/r/a.om", "", "bytes=0-10"))
    asyncio.run(p.om_range("data_spatial/m/r/b.om", "", "bytes=0-10"))
    dirs = [d for d in tmp_path.iterdir() if d.is_dir()]
    assert len(dirs) == 1  # only the most-recent file survives


def test_evict_skips_directory_stat_walk_when_under_budget(tmp_path, monkeypatch):
    """Regression for the CPU-pegging bug: _evict used to re-stat every chunk
    file of every cached directory on EVERY om_range call, just to check
    whether eviction was needed. With a running byte total (self._cache_bytes)
    that per-directory walk (_dir_bytes) must run at most once — the lazy
    scan that seeds the counter — no matter how many more requests follow,
    as long as the cache stays under budget."""
    _install_upstream(monkeypatch)
    walked: list[object] = []
    real_dir_bytes = wp._dir_bytes

    def counting(fdir):
        walked.append(fdir)
        return real_dir_bytes(fdir)

    monkeypatch.setattr(wp, "_dir_bytes", counting)
    p = _proxy(tmp_path, chunk=4096, budget=10**9)
    asyncio.run(p.om_range("data_spatial/m/r/a.om", "", "bytes=0-10"))
    assert len(walked) == 1  # the one-time lazy scan on first _evict
    # More requests — a cache hit and a new cold file — must not re-walk.
    asyncio.run(p.om_range("data_spatial/m/r/a.om", "", "bytes=100-200"))
    asyncio.run(p.om_range("data_spatial/m/r/b.om", "", "bytes=0-10"))
    assert len(walked) == 1


def test_running_cache_bytes_matches_disk(tmp_path, monkeypatch):
    """self._cache_bytes (the running total _evict compares to the budget)
    must track real on-disk usage exactly across chunk writes, size-sidecar
    writes and an eviction — not just be "close enough"."""
    _install_upstream(monkeypatch)
    p = _proxy(tmp_path, chunk=4096, budget=6000)
    asyncio.run(p.om_range("data_spatial/m/r/a.om", "", "bytes=0-10"))
    asyncio.run(p.om_range("data_spatial/m/r/b.om", "", "bytes=0-10"))
    asyncio.run(p.om_range("data_spatial/m/r/c.om", "", "bytes=0-10"))  # triggers eviction
    on_disk = sum(
        wp._dir_bytes(d) for d in tmp_path.iterdir() if d.is_dir()
    )
    assert p._cache_bytes == on_disk


def test_head_reports_size_and_accept_ranges(tmp_path, monkeypatch):
    # The om reader HEADs the file before ranging it; a GET-only proxy 405s.
    _install_upstream(monkeypatch)
    p = _proxy(tmp_path)
    status, headers = asyncio.run(p.head_om("data_spatial/m/r/t.om", ""))
    assert status == 200
    assert headers["Content-Length"] == str(len(FILE))
    assert headers["Accept-Ranges"] == "bytes"


def test_forecast_passthrough(tmp_path, monkeypatch):
    _install_upstream(monkeypatch)
    p = _proxy(tmp_path)
    status, body, _ = asyncio.run(p.forecast("latitude=55&longitude=12"))
    assert status == 200
    assert body == FILE  # the mock serves FILE for a no-range GET


def test_concurrent_same_chunk_fetched_once(tmp_path, monkeypatch):
    """Two requests that both need the SAME not-yet-cached chunk must dedupe
    onto a single upstream fetch (the in-flight-future map), not double-fetch."""

    async def scenario() -> None:
        gate = asyncio.Event()
        counter: dict[int, int] = {}
        monkeypatch.setattr(
            wp, "_client", httpx.AsyncClient(transport=_GatedTransport(gate, counter))
        )
        p = _proxy(tmp_path, chunk=4096)
        # Both ranges live in chunk 0, which is cold; fire them concurrently.
        t1 = asyncio.create_task(p.om_range("data_spatial/m/r/t.om", "", "bytes=0-100"))
        t2 = asyncio.create_task(
            p.om_range("data_spatial/m/r/t.om", "", "bytes=50-150")
        )
        await asyncio.sleep(0.01)  # let both reach the gated fetch
        gate.set()
        r1, r2 = await asyncio.gather(t1, t2)
        assert r1[2] == FILE[0:101]
        assert r2[2] == FILE[50:151]
        assert counter[0] == 1  # one upstream fetch of chunk 0, not two

    asyncio.run(scenario())


def test_cache_hit_does_not_serialize_behind_inflight_fetch(tmp_path, monkeypatch):
    """A read that only touches an already-cached chunk must complete while an
    unrelated chunk's fetch is still in flight — the per-file lock is gone, so
    cache hits no longer queue behind a slow upstream fetch."""

    async def scenario() -> None:
        gate = asyncio.Event()
        counter: dict[int, int] = {}
        monkeypatch.setattr(
            wp, "_client", httpx.AsyncClient(transport=_GatedTransport(gate, counter))
        )
        p = _proxy(tmp_path, chunk=4096)
        # Prime chunk 1 into the cache (gate open), then close the gate.
        gate.set()
        await p.om_range("data_spatial/m/r/t.om", "", "bytes=4096-4200")
        gate.clear()
        # An in-flight fetch of the cold chunk 0, blocked on the gate.
        slow = asyncio.create_task(
            p.om_range("data_spatial/m/r/t.om", "", "bytes=0-100")
        )
        await asyncio.sleep(0.01)
        assert not slow.done()  # genuinely stuck at the upstream fetch
        # A read of the cached chunk 1 must finish without waiting on the gate.
        fast = asyncio.create_task(
            p.om_range("data_spatial/m/r/t.om", "", "bytes=4100-4200")
        )
        _, _, body = await asyncio.wait_for(fast, timeout=1.0)
        assert body == FILE[4100:4201]
        assert not slow.done()  # we did not block on the in-flight fetch
        gate.set()
        await slow

    asyncio.run(scenario())


def test_om_range_response_opts_out_of_gzip(tmp_path, monkeypatch):
    # The .om payload is already compressed; the 206 must declare identity so
    # the gzip middleware never transforms a Content-Range body.
    _install_upstream(monkeypatch)
    p = _proxy(tmp_path)
    _, headers, _ = asyncio.run(
        p.om_range("data_spatial/m/r/t.om", "", "bytes=0-100")
    )
    assert headers["Content-Encoding"] == "identity"


def test_latest_json_reused_within_ttl_then_refetched(tmp_path, monkeypatch):
    calls: list[int] = []
    _install_upstream(monkeypatch, calls)
    clock = [1000.0]
    monkeypatch.setattr(wp.time, "monotonic", lambda: clock[0])
    p = _proxy(tmp_path, latest_ttl=90)
    path = "data_spatial/m/r/latest.json"

    status, _, _ = asyncio.run(p.passthrough_tiles(path, ""))
    assert status == 200
    n = len(calls)
    # A burst of re-reads inside the TTL collapses to zero extra upstream calls.
    clock[0] += 30
    asyncio.run(p.passthrough_tiles(path, ""))
    assert len(calls) == n
    # Past the TTL a new run can have landed, so it is fetched fresh again.
    clock[0] += 100
    asyncio.run(p.passthrough_tiles(path, ""))
    assert len(calls) == n + 1


def test_in_progress_json_is_never_cached(tmp_path, monkeypatch):
    # Only latest.json gets the TTL; the in-progress index stays strictly fresh.
    calls: list[int] = []
    _install_upstream(monkeypatch, calls)
    p = _proxy(tmp_path, latest_ttl=90)
    path = "data_spatial/m/r/in-progress.json"
    asyncio.run(p.passthrough_tiles(path, ""))
    n = len(calls)
    asyncio.run(p.passthrough_tiles(path, ""))
    assert len(calls) == n + 1  # fetched again, not served from a cache


# ── neighbour-time prewarm ────────────────────────────────────────────────────

# A concrete valid-time .om path: only the T{HH}00 filename component moves
# between forecast-time slider steps (the run dir /1200Z/ is constant).
RUN = "data_spatial/dwd_icon/2026/07/18/1200Z"
VALID = f"{RUN}/2026-07-18T1500.om"


def _install_path_recording_upstream(
    monkeypatch, seen: list[str], missing: set[str] | None = None
):
    """Range upstream that records each fetched request path and 404s any path in
    ``missing`` (a nonexistent neighbour), else serves the range from FILE."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        seen.append(path)
        name = path.rsplit("/", 1)[-1]
        if missing is not None and name in missing:
            return httpx.Response(404, content=b"")
        m = re.match(r"bytes=(\d+)-(\d*)", request.headers["range"])
        assert m
        s = int(m.group(1))
        e = min(int(m.group(2)) if m.group(2) else len(FILE) - 1, len(FILE) - 1)
        return httpx.Response(
            206,
            content=FILE[s : e + 1],
            headers={"content-range": f"bytes {s}-{e}/{len(FILE)}"},
        )

    monkeypatch.setattr(
        wp, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )


def _valid_names(seen: list[str]) -> set[str]:
    return {p.rsplit("/", 1)[-1] for p in seen if p.endswith(".om")}


def test_prewarm_fetches_configured_neighbours(tmp_path, monkeypatch):
    """Serving a request schedules background prewarm of the SAME range for the
    forward N neighbours (t+1..t+N) plus one backward (t-1)."""

    async def scenario() -> None:
        seen: list[str] = []
        _install_path_recording_upstream(monkeypatch, seen)
        p = _proxy(tmp_path, chunk=4096, prewarm=2)
        await p.om_range(VALID, "variable=x", "bytes=0-100")
        await _drain_prewarm()
        names = _valid_names(seen)
        # Foreground t=15:00, forward t+1=16:00, t+2=17:00, backward t-1=14:00.
        assert "2026-07-18T1500.om" in names
        assert "2026-07-18T1600.om" in names
        assert "2026-07-18T1700.om" in names
        assert "2026-07-18T1400.om" in names
        assert "2026-07-18T1800.om" not in names  # only N=2 forward

    asyncio.run(scenario())


def test_prewarm_disabled_when_zero(tmp_path, monkeypatch):
    async def scenario() -> None:
        seen: list[str] = []
        _install_path_recording_upstream(monkeypatch, seen)
        p = _proxy(tmp_path, chunk=4096, prewarm=0)
        await p.om_range(VALID, "variable=x", "bytes=0-100")
        await _drain_prewarm()
        assert not wp._prewarm_tasks  # nothing was scheduled
        assert _valid_names(seen) == {"2026-07-18T1500.om"}  # only the foreground

    asyncio.run(scenario())


def test_real_request_for_prewarmed_chunk_does_not_refetch(tmp_path, monkeypatch):
    """A prewarm and a later REAL request for the same neighbour chunk dedupe onto
    one upstream fetch — the real request finds it already on disk."""

    async def scenario() -> None:
        seen: list[str] = []
        _install_path_recording_upstream(monkeypatch, seen)
        p = _proxy(tmp_path, chunk=4096, prewarm=2)
        await p.om_range(VALID, "variable=x", "bytes=0-100")
        await _drain_prewarm()
        before = sum(1 for s in seen if s.endswith("2026-07-18T1600.om"))
        assert before == 1  # prewarm fetched t+1's chunk once
        # Now the user actually steps to 16:00 for the same range.
        _, _, body = await p.om_range(f"{RUN}/2026-07-18T1600.om", "variable=x", "bytes=0-100")
        await _drain_prewarm()
        assert body == FILE[0:101]
        after = sum(1 for s in seen if s.endswith("2026-07-18T1600.om"))
        assert after == 1  # served from the prewarmed chunk, no second fetch

    asyncio.run(scenario())


def test_prewarm_failure_does_not_affect_foreground(tmp_path, monkeypatch):
    """A neighbour that 404s upstream is skipped; the foreground response is still
    a correct 206 and no prewarm error surfaces."""

    async def scenario() -> None:
        seen: list[str] = []
        # Every neighbour file is absent upstream; only the foreground exists.
        missing = {
            "2026-07-18T1600.om",
            "2026-07-18T1700.om",
            "2026-07-18T1400.om",
        }
        _install_path_recording_upstream(monkeypatch, seen, missing=missing)
        p = _proxy(tmp_path, chunk=4096, prewarm=2)
        status, _, body = await p.om_range(VALID, "variable=x", "bytes=0-100")
        assert status == 206
        assert body == FILE[0:101]
        # Draining must not raise despite every neighbour 404ing.
        await _drain_prewarm()

    asyncio.run(scenario())


def test_prewarm_does_not_delay_foreground(tmp_path, monkeypatch):
    """The foreground response returns while neighbour fetches are still blocked —
    prewarm is scheduled, not awaited."""

    async def scenario() -> None:
        gate = asyncio.Event()

        async def handle(request: httpx.Request) -> httpx.Response:
            name = request.url.path.rsplit("/", 1)[-1]
            if name != "2026-07-18T1500.om":  # a neighbour — hold it in flight
                await gate.wait()
            m = re.match(r"bytes=(\d+)-(\d*)", request.headers["range"])
            assert m
            s = int(m.group(1))
            e = min(int(m.group(2)) if m.group(2) else len(FILE) - 1, len(FILE) - 1)
            return httpx.Response(
                206,
                content=FILE[s : e + 1],
                headers={"content-range": f"bytes {s}-{e}/{len(FILE)}"},
            )

        monkeypatch.setattr(
            wp, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handle))
        )
        p = _proxy(tmp_path, chunk=4096, prewarm=2)
        # Foreground completes fast even though neighbour fetches are gated shut.
        status, _, body = await asyncio.wait_for(
            p.om_range(VALID, "variable=x", "bytes=0-100"), timeout=1.0
        )
        assert status == 206
        assert body == FILE[0:101]
        assert wp._prewarm_tasks and not all(t.done() for t in wp._prewarm_tasks)
        gate.set()
        await _drain_prewarm()

    asyncio.run(scenario())


def test_neighbour_path_steps_across_day_boundary():
    # 23:00 + 1h rolls to the next day; the run dir is untouched.
    p = f"{RUN}/2026-07-18T2300.om"
    assert wp._neighbour_path(p, 1) == f"{RUN}/2026-07-19T0000.om"
    assert wp._neighbour_path(p, -1) == f"{RUN}/2026-07-18T2200.om"
    # A non-valid-time filename is not a neighbour candidate.
    assert wp._neighbour_path("data_spatial/m/r/t.om", 1) is None


def test_prewarm_past_a_smaller_neighbour_s_end_asks_upstream_once(tmp_path, monkeypatch):
    """Neighbour `.om` files differ in size, so a chunk that exists in the file
    being read can start past a neighbour's end — upstream says 416. The size
    that 416 states is kept, so every later prewarm stops short instead of
    asking (and logging) again on each tile request."""
    SMALL = 5_000

    async def scenario() -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            seen.append(path)
            size = SMALL if path.endswith("T1600.om") else len(FILE)
            m = re.match(r"bytes=(\d+)-(\d*)", request.headers["range"])
            assert m
            s = int(m.group(1))
            if s >= size:
                return httpx.Response(416, headers={"content-range": f"bytes */{size}"})
            e = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
            return httpx.Response(
                206, content=FILE[s : e + 1], headers={"content-range": f"bytes {s}-{e}/{size}"}
            )

        monkeypatch.setattr(
            wp, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )
        p = _proxy(tmp_path, chunk=4096, prewarm=1)
        for _ in range(3):
            status, _, body = await p.om_range(VALID, "variable=x", "bytes=20480-20580")
            await _drain_prewarm()
            assert status == 206 and body == FILE[20480:20581]
        assert sum(1 for s in seen if s.endswith("T1600.om")) == 1
        # And a real read of the small neighbour still serves its own bytes.
        status, _, body = await p.om_range(
            f"{RUN}/2026-07-18T1600.om", "variable=x", "bytes=4000-4999"
        )
        assert status == 206 and body == FILE[4000:5000]

    asyncio.run(scenario())


def test_a_miss_reads_ahead_so_the_next_sequential_reads_overlap(tmp_path, monkeypatch):
    """The decoder reads a variable as ascending small ranges, one blocking
    call at a time. A miss must start the following chunks too, so they are
    in flight TOGETHER rather than one serial round trip each."""

    async def scenario() -> None:
        in_flight = 0
        peak = 0
        fetched: list[int] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.05)
            in_flight -= 1
            m = re.match(r"bytes=(\d+)-(\d*)", request.headers["range"])
            assert m
            s = int(m.group(1))
            e = min(int(m.group(2)), len(FILE) - 1)
            fetched.append(s // 4096)
            return httpx.Response(
                206, content=FILE[s : e + 1], headers={"content-range": f"bytes {s}-{e}/{len(FILE)}"}
            )

        monkeypatch.setattr(
            wp, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )
        monkeypatch.setattr(wp, "_READAHEAD_BYTES", 4 * 4096)
        p = _proxy(tmp_path, chunk=4096)
        # Four sequential 4 KiB reads, like the decoder walking a variable.
        for i in range(2, 6):
            _, _, body = await p.om_range(VALID, "", f"bytes={i * 4096}-{i * 4096 + 4095}")
            assert body == FILE[i * 4096 : i * 4096 + 4096]
        await _drain_prewarm()
        assert peak > 1  # overlapped, not strictly serial
        assert sorted(fetched).count(3) == 1  # each chunk fetched once
        assert {2, 3, 4, 5, 6} <= set(fetched)

    asyncio.run(scenario())


def test_the_last_chunk_also_fetches_the_metadata_chunk_before_it(tmp_path, monkeypatch):
    """An `.om` reader opens a file at its trailer (the last chunk), then reads
    the variable metadata just before it — start that one immediately."""

    async def scenario() -> None:
        seen: list[str] = []
        _install_path_recording_upstream(monkeypatch, seen)
        p = _proxy(tmp_path, chunk=4096)
        end = len(FILE) - 1
        await p.om_range(VALID, "", f"bytes={end - 10}-{end}")
        await _drain_prewarm()
        final = end // 4096
        assert (tmp_path / p._cache_key(VALID) / str(final - 1)).exists()

    asyncio.run(scenario())


def test_changing_chunk_size_never_serves_another_size_s_chunks(tmp_path, monkeypatch):
    """`chunk_bytes` is live-editable and chunk files are named by index, so
    a proxy with a different chunk size must not read the old size's `3`."""

    async def scenario() -> None:
        _install_upstream(monkeypatch)
        big = _proxy(tmp_path, chunk=8192)
        await big.om_range(VALID, "", "bytes=0-49999")  # fills chunks 0..6 at 8 KiB
        small = _proxy(tmp_path, chunk=4096)
        _, _, body = await small.om_range(VALID, "", "bytes=12288-12387")  # 4 KiB chunk 3
        assert body == FILE[12288:12388]

    asyncio.run(scenario())
