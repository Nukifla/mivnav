# SPDX-License-Identifier: GPL-2.0-only
"""``RemoteArchive``/``OsmWorldLiveCache`` — the osm_world on-demand live
tile fallback (jt rtmtmntz). Builds a real (tiny) PMTiles archive via
chartcore's own writer — same fixture-building trick
``tests/test_ingest_osm_world.py`` already uses — and reads it back through
``RemoteArchive``'s HTTP-range-shaped ``fetch`` callable instead of a local
mmap, so this asserts the remote reader decodes the exact same wire format
``mivnav.charts.pmtiles.Archive`` does, not a hand-rolled expectation of it.

Deferring every ``mivnav`` import into each test body (not this module's
top level) mirrors ``test_ingest_osm_world.py``'s own reasoning: importing
``mivnav.config.model`` before ``mivnav.api.app`` has had a chance to load
every feature front-to-back once can race an import cycle.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest


def _build_fixture_archive(path: Path) -> None:
    import chartcore

    chartcore.build_vector_pmtiles(
        point_layers=[("places", [(-1.3, 50.7, {"kind": "country", "name": "Testland"})])],
        line_layers=[("roads", [([(-1.3, 50.7), (-1.2, 50.8)], {"kind": "highway"})])],
        min_zoom=0,
        max_zoom=6,
        out=path,
    )


# -- RemoteArchive: decodes the same wire format Archive does -------------


def test_remote_archive_matches_local_archive_tile_data(tmp_path: Path):
    from mivnav.charts.pmtiles import Archive
    from mivnav.features.osm_world.live import RemoteArchive

    path = tmp_path / "fixture.pmtiles"
    _build_fixture_archive(path)
    raw = path.read_bytes()

    async def fetch(offset: int, length: int) -> bytes:
        return raw[offset : offset + length]

    local = Archive(path)
    remote = RemoteArchive(fetch=fetch)

    import asyncio

    async def run():
        for z in range(0, 7):
            n = 1 << z
            for x in range(n):
                for y in range(n):
                    want = local.tile_data(z, x, y)
                    got = await remote.tile_data(z, x, y)
                    assert got == want, f"mismatch at z{z}/{x}/{y}"

    asyncio.run(run())
    local.close()


def test_remote_archive_memoises_header_root_and_leaves(tmp_path: Path):
    """Repeated tile lookups must not re-fetch the header/root/leaf
    directories — see the class docstring: a long-lived RemoteArchive pays
    that cost once per directory, not once per tile."""
    from mivnav.features.osm_world.live import RemoteArchive

    path = tmp_path / "fixture.pmtiles"
    _build_fixture_archive(path)
    raw = path.read_bytes()
    calls: list[tuple[int, int]] = []

    async def fetch(offset: int, length: int) -> bytes:
        calls.append((offset, length))
        return raw[offset : offset + length]

    remote = RemoteArchive(fetch=fetch)

    import asyncio

    async def run():
        await remote.tile_data(0, 0, 0)
        first_calls = len(calls)
        await remote.tile_data(0, 0, 0)
        # The DATA fetch itself is never cached by RemoteArchive (that is
        # OsmWorldLiveCache's disk-cache job, one layer up) — only ONE new
        # fetch (the tile's own data range) should happen on the repeat
        # lookup, not the header+root all over again.
        assert len(calls) == first_calls + 1, "a repeat lookup must reuse the memoised header/root"

    asyncio.run(run())


# -- OsmWorldLiveCache: resolve + fetch + disk cache + eviction -----------


def _transport_for(build_bytes: dict[str, bytes], *, fail_ranges: int = 0):
    """A ``httpx.MockTransport`` handler serving a dict of {url: full_bytes}
    over ``Range`` requests, like a real static-file host would. Optionally
    fails the first ``fail_ranges`` DATA (non-HEAD) requests with a 503, to
    exercise the retry/backoff path — a mutable call counter is exposed as
    ``handler.calls`` so tests can assert on request volume (e.g. that a
    memoised header/root/leaf is not re-fetched)."""
    state = {"failed": 0}
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        url = str(request.url)
        if request.method == "HEAD":
            if url in build_bytes:
                return httpx.Response(200)
            return httpx.Response(404)
        data = build_bytes.get(url)
        if data is None:
            return httpx.Response(404)
        if state["failed"] < fail_ranges:
            state["failed"] += 1
            return httpx.Response(503)
        rng = request.headers.get("range", "")
        if not rng.startswith("bytes="):
            return httpx.Response(200, content=data)
        start_s, _, end_s = rng[len("bytes=") :].partition("-")
        start = int(start_s)
        end = int(end_s) if end_s else len(data) - 1
        chunk = data[start : end + 1]
        return httpx.Response(
            206,
            content=chunk,
            headers={"Content-Range": f"bytes {start}-{end}/{len(data)}"},
        )

    transport = httpx.MockTransport(handler)
    return transport, calls


@pytest.fixture
def fixture_archive_bytes(tmp_path: Path) -> bytes:
    path = tmp_path / "fixture.pmtiles"
    _build_fixture_archive(path)
    return path.read_bytes()


def test_live_cache_serves_tile_then_caches_it_to_disk(tmp_path: Path, fixture_archive_bytes, monkeypatch):
    from datetime import date

    from mivnav.features.osm_world import live as live_mod
    from mivnav.features.osm_world.live import OsmWorldLiveCache

    fixed_today = date(2026, 7, 26)
    monkeypatch.setattr(live_mod, "date", _FixedDate(fixed_today))

    url = f"https://build.example/{fixed_today.strftime('%Y%m%d')}.pmtiles"
    transport, calls = _transport_for({url: fixture_archive_bytes})
    http = httpx.AsyncClient(transport=transport)

    async def noop_sleep(_delay: float) -> None:
        return None

    cache = OsmWorldLiveCache(
        cache_dir=tmp_path / "cache",
        cache_budget=10 * 1024 * 1024,
        build_host="https://build.example",
        lookback_days=7,
        refresh_s=3600,
        http=http,
        sleep=noop_sleep,
    )

    import asyncio

    async def run():
        result = await cache.tile(0, 0, 0)
        assert result is not None
        first_call_count = len(calls)
        # A second request within refresh_s must be served from disk, no
        # further HTTP at all.
        result2 = await cache.tile(0, 0, 0)
        assert result2 is not None
        assert result2.data == result.data
        assert len(calls) == first_call_count, "a fresh cache hit must not touch the network"

    asyncio.run(run())
    asyncio.run(http.aclose())


def test_live_cache_falls_back_to_stale_tile_on_upstream_failure(tmp_path: Path, fixture_archive_bytes, monkeypatch):
    from datetime import date

    from mivnav.features.osm_world import live as live_mod

    fixed_today = date(2026, 7, 26)
    monkeypatch.setattr(live_mod, "date", _FixedDate(fixed_today))

    url = f"https://build.example/{fixed_today.strftime('%Y%m%d')}.pmtiles"

    import asyncio

    async def noop_sleep(_delay: float) -> None:
        return None

    async def run():
        # First: a working transport populates the cache.
        transport_ok, _ = _transport_for({url: fixture_archive_bytes})
        http_ok = httpx.AsyncClient(transport=transport_ok)
        cache = live_mod.OsmWorldLiveCache(
            cache_dir=tmp_path / "cache",
            cache_budget=10 * 1024 * 1024,
            build_host="https://build.example",
            lookback_days=7,
            refresh_s=0,  # force every call to attempt upstream
            http=http_ok,
            sleep=noop_sleep,
        )
        first = await cache.tile(0, 0, 0)
        assert first is not None
        await http_ok.aclose()

        # Now swap in a transport that always 502s — must fall back to the
        # bytes just cached, not error out or return None.
        def always_fail(request: httpx.Request) -> httpx.Response:
            return httpx.Response(502)

        cache._http_override = httpx.AsyncClient(transport=httpx.MockTransport(always_fail))
        second = await cache.tile(0, 0, 0)
        assert second is not None
        assert second.data == first.data
        await cache._http_override.aclose()

    asyncio.run(run())


def test_live_cache_stops_asking_a_dead_upstream_and_answers_from_cache(tmp_path: Path, fixture_archive_bytes, monkeypatch):
    """Offline (the boat's normal state at sea): the FIRST failure costs one
    unreachable-host probe — not one per build date — and for
    UPSTREAM_DOWN_RETRY_S after it every tile, cached or not, is answered
    with no network attempt at all. Once that passes upstream is tried again."""
    import asyncio
    from datetime import date

    from mivnav.features.osm_world import live as live_mod

    fixed_today = date(2026, 7, 26)
    monkeypatch.setattr(live_mod, "date", _FixedDate(fixed_today))
    url = f"https://build.example/{fixed_today.strftime('%Y%m%d')}.pmtiles"
    clock = {"now": 1000.0}
    monkeypatch.setattr(live_mod.time, "monotonic", lambda: clock["now"])

    async def noop_sleep(_delay: float) -> None:
        return None

    async def run():
        transport_ok, _ = _transport_for({url: fixture_archive_bytes})
        cache = live_mod.OsmWorldLiveCache(
            cache_dir=tmp_path / "cache",
            cache_budget=10 * 1024 * 1024,
            build_host="https://build.example",
            lookback_days=7,
            refresh_s=0,  # every call wants upstream, and the build is re-resolved
            http=httpx.AsyncClient(transport=transport_ok),
            sleep=noop_sleep,
        )
        first = await cache.tile(0, 0, 0)
        assert first is not None
        await cache._http_override.aclose()

        attempts: list[httpx.Request] = []

        def unreachable(request: httpx.Request) -> httpx.Response:
            attempts.append(request)
            raise httpx.ConnectError("no route to host", request=request)

        cache._http_override = httpx.AsyncClient(transport=httpx.MockTransport(unreachable))
        assert (await cache.tile(0, 0, 0)).data == first.data  # stale, after ONE probe
        assert len(attempts) == 1
        assert (await cache.tile(0, 0, 0)).data == first.data
        assert await cache.tile(5, 1, 1) is None  # never cached: nothing, but instantly
        assert len(attempts) == 1

        clock["now"] += live_mod.UPSTREAM_DOWN_RETRY_S + 1
        await cache.tile(0, 0, 0)
        assert len(attempts) == 2
        await cache._http_override.aclose()

    asyncio.run(run())


def test_live_cache_retries_a_transient_503_before_succeeding(tmp_path: Path, fixture_archive_bytes, monkeypatch):
    from mivnav.features.osm_world import live as live_mod

    fixed_today_str = "20260726"
    url = f"https://build.example/{fixed_today_str}.pmtiles"
    monkeypatch.setattr(live_mod, "date", _FixedDate(_parse(fixed_today_str)))

    transport, calls = _transport_for({url: fixture_archive_bytes}, fail_ranges=1)
    http = httpx.AsyncClient(transport=transport)
    sleeps: list[float] = []

    async def recording_sleep(delay: float) -> None:
        sleeps.append(delay)

    import asyncio

    async def run():
        cache = live_mod.OsmWorldLiveCache(
            cache_dir=tmp_path / "cache",
            cache_budget=10 * 1024 * 1024,
            build_host="https://build.example",
            lookback_days=7,
            refresh_s=3600,
            http=http,
            sleep=recording_sleep,
        )
        result = await cache.tile(0, 0, 0)
        assert result is not None
        assert sleeps, "the first 503 must have triggered a backoff sleep before retrying"

    asyncio.run(run())
    asyncio.run(http.aclose())


def test_evict_discards_a_stray_atomic_write_tmp_file_instead_of_crashing(tmp_path: Path):
    """A crash/power-cut mid-``_atomic_write`` (a real boat-Pi failure mode,
    not hypothetical) can leave a ``<y>.<pid>.tmp`` file behind — neither a
    valid tile (``_is_tile_filename``) nor its ``.meta`` sidecar. ``_evict``
    must not ``int()``-parse that name (a ``ValueError`` there used to
    propagate out of ``tile()`` and 500 every live request once over
    budget) — it should discard the stray file and keep evicting
    normally."""
    from mivnav.features.osm_world.live import OsmWorldLiveCache

    cache_dir = tmp_path / "cache"
    (cache_dir / "5" / "10").mkdir(parents=True)
    stray = cache_dir / "5" / "10" / "20.12345.tmp"
    stray.write_bytes(b"leftover")

    async def noop_sleep(_delay: float) -> None:
        return None

    cache = OsmWorldLiveCache(
        cache_dir=cache_dir,
        cache_budget=0,  # force eviction on the very first check
        build_host="https://build.example",
        lookback_days=1,
        refresh_s=3600,
        sleep=noop_sleep,
    )
    cache._evict()  # must not raise
    assert not stray.exists(), "the stray .tmp file should have been discarded during eviction"


def test_live_cache_raises_when_no_build_resolves(tmp_path: Path):
    from mivnav.features.osm_world.live import BuildNotFoundError, OsmWorldLiveCache

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    async def noop_sleep(_delay: float) -> None:
        return None

    cache = OsmWorldLiveCache(
        cache_dir=tmp_path / "cache",
        cache_budget=10 * 1024 * 1024,
        build_host="https://build.example",
        lookback_days=3,
        refresh_s=3600,
        http=http,
        sleep=noop_sleep,
    )

    import asyncio

    async def run():
        with pytest.raises(BuildNotFoundError):
            await cache._resolve()

    asyncio.run(run())
    asyncio.run(http.aclose())


class _FixedDate:
    """A stand-in for the ``date`` class binding ``date.today()`` to a fixed
    value, for ``monkeypatch.setattr(live_mod, "date", _FixedDate(...))`` —
    ``OsmWorldLiveCache._resolve`` calls ``date.today()`` off the module's
    imported name, so patching that name is enough; everything else
    (``timedelta`` arithmetic) still runs through the real ``datetime``
    module untouched."""

    def __init__(self, fixed):
        self._fixed = fixed

    def today(self):
        return self._fixed


def _parse(datestr: str):
    from datetime import date

    return date(int(datestr[0:4]), int(datestr[4:6]), int(datestr[6:8]))
