# SPDX-License-Identifier: GPL-2.0-only
"""The osm_world on-demand live-cache fallback (jt rtmtmntz).

Past the baked zoom cap (`OsmWorldConfig.max_zoom`), MapLibre used to just
overzoom the last baked tile with no fetch and no indicator. This module
fetches and caches individual tiles from Protomaps' daily PMTiles build on
demand, the same shared fetch-through shape as weather's `WeatherProxy`, but
gated behind an explicit `mode="live-cache"` dataset (never on by default —
see docs/architecture/osm-world-live-cache.md for why) and keyed by (z, x, y)
rather than by build date, since a basemap tile is not superseded the way a
forecast run is. See that doc for the RemoteArchive port, the gating design,
and the caching/eviction rationale.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from bisect import bisect_right
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import httpx

from mivnav.charts.pmtiles import HEADER_LEN, Header, PMTilesError, decompress, parse_directory, parse_header
from mivnav.charts.pmtiles import tile_id as _tile_id

log = logging.getLogger(__name__)

# App-identifying User-Agent — a generic library UA risks being treated as
# anonymous-scraper traffic against a public bucket (mivnav.features.poi.overpass).
USER_AGENT = "mivnav/0.1 (chart plotter; OSM world live tile fallback; +https://github.com/mivnav)"

# Shorter backoff than Overpass's (5s/10s/20s): this retry sits behind an
# interactive map pan, not a background bake, so the worst case should stay
# in low single-digit seconds.
LIVE_TILE_RETRIES = 3  # total attempts
LIVE_TILE_RETRY_BACKOFF_S = 1.0  # base delay; grows 1s, 2s…
RETRYABLE_STATUS = frozenset({429, 502, 503, 504})

# After an upstream failure, how long every further request is answered from
# the disk cache alone before the network is tried again. The boat is offline
# for hours at a time, and without this each uncached-or-expired tile of each
# viewport pays the failure again — up to a 10 s connect timeout per build
# date probed when the uplink blackholes instead of refusing.
UPSTREAM_DOWN_RETRY_S = 60.0

Directory = tuple[list[int], list[tuple[int, int, int]]]
RangeFetcher = Callable[[int, int], Awaitable[bytes]]


class OsmWorldLiveError(Exception):
    """A live-cache tile lookup failed (transport, HTTP status, or a
    structurally invalid remote archive)."""


class BuildNotFoundError(OsmWorldLiveError):
    """No Protomaps daily build responded within the configured lookback
    window — the async twin of ``ingest.resolve_build_url``'s own error,
    duplicated rather than imported since that one runs sync on the bake
    thread. See docs/architecture/osm-world-live-cache.md."""


class RemoteArchive:
    """Async, HTTP-range-backed PMTiles v3 reader, ported from
    :class:`mivnav.charts.pmtiles.Archive`'s mmap reader. ``fetch`` is
    injected (no transport of its own), so this is unit-testable against a
    real small archive's raw bytes with a synchronous in-memory ``fetch``.
    See docs/architecture/osm-world-live-cache.md."""

    def __init__(self, fetch: RangeFetcher) -> None:
        self._fetch = fetch
        self._header: Header | None = None
        self._root: Directory | None = None
        # Keyed by byte offset (stable per archive/build) so a long-lived
        # instance pays a leaf fetch per LEAF, not per TILE — see the doc.
        self._leaves: dict[int, Directory] = {}

    async def header(self) -> Header:
        if self._header is None:
            buf = await self._fetch(0, HEADER_LEN)
            self._header = parse_header(buf)
        return self._header

    async def _root_directory(self) -> Directory:
        if self._root is None:
            h = await self.header()
            raw = await self._fetch(h.root_offset, h.root_length)
            self._root = parse_directory(decompress(h.internal_compression, raw))
        return self._root

    async def _leaf_directory(self, h: Header, offset: int, length: int) -> Directory:
        cached = self._leaves.get(offset)
        if cached is not None:
            return cached
        raw = await self._fetch(h.leaf_offset + offset, length)
        directory = parse_directory(decompress(h.internal_compression, raw))
        self._leaves[offset] = directory
        return directory

    async def tile_data(self, z: int, x: int, y: int) -> bytes | None:
        """Verbatim port of ``Archive.tile_data``'s directory-walk (same
        bisect logic, same "at most one level of leaf directories" spec
        bound), with awaited range GETs instead of an mmap slice. Returns
        the *stored* (possibly compressed) tile bytes, or ``None``."""
        h = await self.header()
        target = _tile_id(z, x, y)
        ids, entries = await self._root_directory()
        for _ in range(2):  # at most one level of leaf directories, per spec
            i = bisect_right(ids, target) - 1
            if i < 0:
                return None
            eid = ids[i]
            offset, length, run_length = entries[i]
            if run_length == 0:  # leaf-directory pointer
                ids, entries = await self._leaf_directory(h, offset, length)
                continue
            if target < eid + run_length:
                return await self._fetch(h.data_offset + offset, length)
            return None
        raise PMTilesError("leaf directory nesting too deep")


# Process-wide connection pool (a live cache is rebuilt on config change but
# the pool is a process resource — same shape as weather's proxy). Closed
# from the app lifespan alongside weather's close_http_client.
_client: httpx.AsyncClient | None = None


def _module_http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=10.0), follow_redirects=True)
    return _client


async def close_live_http_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


@dataclass(frozen=True)
class LiveTile:
    data: bytes
    tile_compression: int
    tile_type: int


class OsmWorldLiveCache:
    """The live tile fallback for one ``osm_world`` config slice — resolves
    today's Protomaps daily build, reads individual tiles from it via
    :class:`RemoteArchive`, and caches them to disk under a byte budget."""

    def __init__(
        self,
        *,
        cache_dir: Path,
        cache_budget: int,
        build_host: str,
        lookback_days: int,
        refresh_s: int,
        http: httpx.AsyncClient | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._dir = Path(cache_dir)
        self._budget = cache_budget
        self._build_host = build_host
        self._lookback_days = lookback_days
        self._refresh_s = refresh_s
        self._http_override = http
        self._sleep = sleep
        # (resolved_at, url, datestr) — reused within refresh_s, same TTL
        # idiom as WeatherProxy._latest_cache.
        self._resolved: tuple[float, str, str] | None = None
        self._archive: RemoteArchive | None = None
        self._archive_url: str | None = None
        # Dedupes concurrent requests for the SAME missing tile onto one
        # upstream lookup — mirrors WeatherProxy._inflight.
        self._inflight: dict[tuple[int, int, int], "asyncio.Future[LiveTile | None]"] = {}
        self._cache_bytes: int | None = None
        # time.monotonic() before which upstream is not tried (UPSTREAM_DOWN_RETRY_S).
        self._down_until = 0.0

    def _http(self) -> httpx.AsyncClient:
        return self._http_override if self._http_override is not None else _module_http()

    async def _resolve(self) -> tuple[str, str]:
        """Today's (or the most recent available) build URL — reused for
        ``refresh_s``. No retry/backoff per date probed, same as the sync
        bake-time twin: a HEAD that fails just means try yesterday."""
        now = time.time()
        if self._resolved is not None and now - self._resolved[0] < self._refresh_s:
            return self._resolved[1], self._resolved[2]
        for i in range(self._lookback_days):
            d = date.today() - timedelta(days=i)
            datestr = d.strftime("%Y%m%d")
            url = f"{self._build_host.rstrip('/')}/{datestr}.pmtiles"
            try:
                resp = await self._http().head(url, headers={"User-Agent": USER_AGENT})
            except httpx.TransportError as e:
                # Not reaching the host says nothing about this date — the
                # other dates live on the same host, so probing them would
                # only multiply the timeout.
                raise OsmWorldLiveError(f"osm_world live build host {self._build_host} unreachable: {e}") from e
            except httpx.HTTPError:
                continue
            if resp.status_code == 200:
                self._resolved = (now, url, datestr)
                return url, datestr
        raise BuildNotFoundError(
            f"no Protomaps daily build found under {self._build_host} in the last "
            f"{self._lookback_days} days"
        )

    def _archive_for(self, url: str) -> RemoteArchive:
        if self._archive is None or self._archive_url != url:
            self._archive = RemoteArchive(fetch=lambda offset, length: self._range_get(url, offset, length))
            self._archive_url = url
        return self._archive

    async def _range_get(self, url: str, offset: int, length: int) -> bytes:
        """One range GET with bounded retry/backoff on a transient status or
        transport error — the tile-fetch counterpart of
        ``mivnav.features.poi.overpass``'s retry loop."""
        last: OsmWorldLiveError | None = None
        for attempt in range(LIVE_TILE_RETRIES):
            try:
                resp = await self._http().get(
                    url,
                    headers={
                        "Range": f"bytes={offset}-{offset + length - 1}",
                        "User-Agent": USER_AGENT,
                    },
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                code = e.response.status_code
                last = OsmWorldLiveError(f"osm_world live fetch of {url} returned {code}")
                if code in RETRYABLE_STATUS and attempt < LIVE_TILE_RETRIES - 1:
                    delay = LIVE_TILE_RETRY_BACKOFF_S * (2**attempt)
                    log.warning("osm_world live fetch %s: %s — retry in %.0fs", url, code, delay)
                    await self._sleep(delay)
                    continue
                raise last from e
            except httpx.HTTPError as e:
                last = OsmWorldLiveError(f"osm_world live fetch of {url} failed: {e}")
                if attempt < LIVE_TILE_RETRIES - 1:
                    delay = LIVE_TILE_RETRY_BACKOFF_S * (2**attempt)
                    log.warning("osm_world live fetch %s: transport error — retry in %.0fs", url, delay)
                    await self._sleep(delay)
                    continue
                raise last from e
            if resp.status_code not in (200, 206):
                raise OsmWorldLiveError(f"osm_world live fetch of {url} returned {resp.status_code}")
            return resp.content
        raise last or OsmWorldLiveError(f"osm_world live fetch of {url} failed")

    async def tile(self, z: int, x: int, y: int) -> LiveTile | None:
        """The tile at (z, x, y), from cache if fresh, else fetched (and
        cached) from the resolved daily build — falling back to a stale
        cached copy on fetch failure, else ``None``."""
        key = (z, x, y)
        cached = self._read_cached(z, x, y)
        if cached is not None and time.time() - cached[1] < self._refresh_s:
            return cached[0]
        fut = self._inflight.get(key)
        if fut is not None:
            return await fut
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        self._inflight[key] = fut
        try:
            result = await self._fetch_or_fallback(z, x, y, cached[0] if cached else None)
        except BaseException as e:
            self._inflight.pop(key, None)
            if not fut.done():
                fut.set_exception(e)
            raise
        self._inflight.pop(key, None)
        fut.set_result(result)
        return result

    async def _fetch_or_fallback(self, z: int, x: int, y: int, stale: LiveTile | None) -> LiveTile | None:
        if time.monotonic() < self._down_until:
            return stale  # upstream just failed: cache only, no network wait
        try:
            url, _datestr = await self._resolve()
            archive = self._archive_for(url)
            header = await archive.header()
            data = await archive.tile_data(z, x, y)
        except PMTilesError as e:
            # this tile's bytes, not the link — says nothing about upstream
            log.warning("osm_world live fetch z%d/%d/%d failed, falling back to cache: %s", z, x, y, e)
            return stale
        except (OsmWorldLiveError, httpx.HTTPError) as e:
            if time.monotonic() >= self._down_until:  # once per outage, not per tile
                log.warning(
                    "osm_world live fetch z%d/%d/%d failed, serving from cache only for %.0fs: %s",
                    z, x, y, UPSTREAM_DOWN_RETRY_S, e,
                )
            self._down_until = time.monotonic() + UPSTREAM_DOWN_RETRY_S
            return stale
        self._down_until = 0.0
        if data is None:
            # Authoritative negative from upstream (not a failure to ask):
            # an earlier cached tile is now known wrong, so drop it.
            if stale is not None:
                self._remove_cached(z, x, y)
            return None
        tile = LiveTile(data=data, tile_compression=header.tile_compression, tile_type=header.tile_type)
        self._write_cache(z, x, y, tile)
        self._evict()
        return tile

    # on-disk cache layout: <cache_dir>/<z>/<x>/<y> (+ ".meta")

    def _paths(self, z: int, x: int, y: int) -> tuple[Path, Path]:
        base = self._dir / str(z) / str(x)
        return base / str(y), base / f"{y}.meta"

    def _read_cached(self, z: int, x: int, y: int) -> tuple[LiveTile, float] | None:
        data_path, meta_path = self._paths(z, x, y)
        try:
            compression_s, tile_type_s = meta_path.read_text().split()
            mtime = data_path.stat().st_mtime
            data = data_path.read_bytes()
        except (OSError, ValueError):
            return None
        return LiveTile(data=data, tile_compression=int(compression_s), tile_type=int(tile_type_s)), mtime

    def _write_cache(self, z: int, x: int, y: int, tile: LiveTile) -> None:
        data_path, meta_path = self._paths(z, x, y)
        data_path.parent.mkdir(parents=True, exist_ok=True)
        self._track_write(data_path, tile.data)
        self._track_write(meta_path, f"{tile.tile_compression} {tile.tile_type}".encode())

    def _remove_cached(self, z: int, x: int, y: int) -> None:
        data_path, meta_path = self._paths(z, x, y)
        removed = 0
        for p in (data_path, meta_path):
            try:
                removed += p.stat().st_size
            except OSError:
                continue
            p.unlink(missing_ok=True)
        if self._cache_bytes is not None:
            self._cache_bytes -= removed

    def _track_write(self, path: Path, data: bytes) -> None:
        if self._cache_bytes is not None:
            try:
                old = path.stat().st_size
            except OSError:
                old = 0
            self._cache_bytes += len(data) - old
        _atomic_write(path, data)

    def stats(self) -> dict:
        """Read-only snapshot for ``/providers``/``GET /datasets`` sizing —
        pure filesystem scan, same posture as ``WeatherProxy.stats``."""
        tiles = 0
        total = 0
        try:
            for zdir in os.scandir(self._dir):
                if not zdir.is_dir():
                    continue
                for xdir in os.scandir(zdir.path):
                    if not xdir.is_dir():
                        continue
                    for f in os.scandir(xdir.path):
                        if not f.is_file():
                            continue
                        total += f.stat().st_size
                        if _is_tile_filename(f.name):
                            tiles += 1
        except OSError:
            pass
        return {"tiles": tiles, "bytes": total, "budget": self._budget}

    def _evict(self) -> None:
        """Drop cached tiles, oldest-touched first, until under budget — same
        lazy-until-needed O(1)-common-case shape as ``WeatherProxy._evict``.
        A stray non-tile file (an orphaned ``.<pid>.tmp``) is removed on
        sight rather than ``int()``-parsed — see
        docs/architecture/osm-world-live-cache.md for why."""
        if self._cache_bytes is None:
            self._cache_bytes = self._scan_bytes()
        if self._cache_bytes <= self._budget:
            return
        entries: list[tuple[float, int, int, int, int]] = []  # (mtime, size, z, x, y)
        try:
            for zdir in os.scandir(self._dir):
                if not zdir.is_dir():
                    continue
                for xdir in os.scandir(zdir.path):
                    if not xdir.is_dir():
                        continue
                    for f in os.scandir(xdir.path):
                        if not f.is_file() or f.name.endswith(".meta"):
                            continue
                        if not _is_tile_filename(f.name):
                            self._discard_stray(f.path)
                            continue
                        try:
                            st = f.stat()
                        except OSError:
                            continue
                        meta_size = 0
                        try:
                            meta_size = (Path(xdir.path) / f"{f.name}.meta").stat().st_size
                        except OSError:
                            pass
                        entries.append(
                            (st.st_mtime, st.st_size + meta_size, int(zdir.name), int(xdir.name), int(f.name))
                        )
        except OSError:
            return
        # Already walking every entry to pick victims — re-seed the running
        # total from that same walk, same reasoning as WeatherProxy._evict.
        self._cache_bytes = sum(size for _mtime, size, *_ in entries)
        for _mtime, size, z, x, y in sorted(entries):
            if self._cache_bytes <= self._budget:
                break
            data_path, meta_path = self._paths(z, x, y)
            data_path.unlink(missing_ok=True)
            meta_path.unlink(missing_ok=True)
            self._cache_bytes -= size

    def _discard_stray(self, path: str) -> None:
        try:
            size = os.stat(path).st_size
            os.unlink(path)
        except OSError:
            return
        if self._cache_bytes is not None:
            self._cache_bytes -= size

    def _scan_bytes(self) -> int:
        total = 0
        try:
            for zdir in os.scandir(self._dir):
                if not zdir.is_dir():
                    continue
                for xdir in os.scandir(zdir.path):
                    if xdir.is_dir():
                        for f in os.scandir(xdir.path):
                            if f.is_file():
                                total += f.stat().st_size
        except OSError:
            pass
        return total


def _is_tile_filename(name: str) -> bool:
    """A tile data file is named exactly ``str(y)`` (see ``_paths``). Used to
    tell a real tile apart from its ``.meta`` sidecar or a stray
    ``.<pid>.tmp``, without ``int()``-parsing a name that might not be one."""
    return name.isdigit()


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
