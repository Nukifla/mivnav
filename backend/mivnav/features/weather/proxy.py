# SPDX-License-Identifier: GPL-2.0-only
"""Lazy, range-caching proxy for Open-Meteo weather data.

The boat is metered/offline-prone, so the client never talks to Open-Meteo
directly — it talks to this server, which fetches only the byte-ranges a view
touches, caches them on disk, and serves every other device from there.
See docs/architecture/weather-range-cache.md for the full design.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

#: Fallback chunk size when a proxy is built without one; kept in sync with
#: WeatherConfig.chunk_bytes / DEFAULT_WEATHER_CHUNK_BYTES.
CHUNK_BYTES = 128 * 1024

# Small on purpose: prewarm is best-effort background work behind a
# foreground request and must not crowd the connection pool a real slider
# step needs.
_PREWARM_CONCURRENCY = 2

# Chunks fetched ahead of a cache miss. The decoder reads a variable as a
# strictly ascending run of small ranges, one blocking call at a time, so
# without this every chunk costs a full serial round trip — and one stream
# to the upstream bucket is latency-bound (measured: 7.6 MB in 40 s on one
# stream, 8.4 s as 15 parallel ranges). 2 MiB covers a typical
# regional variable pair in one parallel round.
_READAHEAD_BYTES = 2 * 1024 * 1024

_RANGE_RE = re.compile(r"^bytes=(\d+)-(\d*)$")

# Valid-time filename of a concrete .om; only this component moves between
# forecast-time steps (the run directory is constant). See _neighbour_path.
_OM_NAME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})\.om$")

# Process-wide connection pool (a process resource, independent of the
# per-config proxy instance); closed via close_http_client in the app lifespan.
_client: httpx.AsyncClient | None = None

# Fire-and-forget prewarm tasks; close_http_client cancels any still
# outstanding so a shutdown never leaves a fetch running after the pool closes.
_prewarm_tasks: set[asyncio.Task[None]] = set()


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
            headers={"User-Agent": "mivnav-weather-proxy"},
        )
    return _client


async def close_http_client() -> None:
    global _client
    tasks = list(_prewarm_tasks)
    _prewarm_tasks.clear()
    for t in tasks:
        t.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    if _client is not None:
        await _client.aclose()
        _client = None


class WeatherProxy:
    """A range-caching mirror for one weather config (see WeatherConfig)."""

    def __init__(
        self,
        *,
        cache_dir: Path,
        cache_budget: int,
        tiles_url: str,
        forecast_url: str,
        chunk_bytes: int = CHUNK_BYTES,
        latest_ttl: int = 0,
        prewarm_neighbours: int = 0,
    ) -> None:
        self._dir = Path(cache_dir)
        self._budget = cache_budget
        self._tiles_url = tiles_url.rstrip("/")
        self._forecast_url = forecast_url
        self._chunk = chunk_bytes
        self._latest_ttl = latest_ttl
        # 0 = prewarm off; a proxy built without the arg (every existing
        # test) keeps prewarm off so call counts/cache assertions are stable.
        self._prewarm = prewarm_neighbours
        # Bound lazily to the running loop (and rebound if it changes, e.g.
        # asyncio.run per test) so a reused proxy never trips "bound to a
        # different event loop".
        self._prewarm_sem: asyncio.Semaphore | None = None
        self._prewarm_sem_loop: asyncio.AbstractEventLoop | None = None
        # See docs/architecture/weather-range-cache.md (_ensure_chunk): the
        # only serialisation point, safe without a lock since asyncio never
        # awaits between reading and populating a key here.
        self._inflight: dict[tuple[str, int], asyncio.Future[int | None]] = {}
        self._latest_cache: dict[str, tuple[float, tuple[int, bytes, str]]] = {}
        # Running total of on-disk cache bytes, kept in sync by _track_write/
        # _evict rather than recomputed from disk each call; None until the
        # lazy first-use scan in _evict seeds it.
        self._cache_bytes: int | None = None

    def _cache_key(self, path: str) -> str:
        """The on-disk directory for ``path``'s chunks. Chunk files are named
        by index, so the chunk SIZE is part of the key: `chunk_bytes` is live-
        editable, and a changed size must never read another size's chunk
        ``3`` as its own. Old-size directories just age out under the budget."""
        return hashlib.sha256(f"{path}#{self._chunk}".encode()).hexdigest()

    def _tiles(self, path: str, query: str) -> str:
        url = f"{self._tiles_url}/{path.lstrip('/')}"
        return f"{url}?{query}" if query else url

    async def om_range(
        self, path: str, query: str, range_header: str
    ) -> tuple[int, dict[str, str], bytes]:
        """Serve a byte range of an immutable ``.om`` file from the chunk cache.
        ``path`` alone keys the cache — the file is query-independent, so
        every variable of a run shares one cached file."""
        start, end = _parse_range(range_header)
        if start is None:
            return 416, {"Content-Range": "bytes */*"}, b""

        key = self._cache_key(path)
        fdir = self._dir / key
        # Written beside the first chunk fetched; a cold file bootstraps it
        # once, every later call reads it off disk without blocking.
        total = self._read_size(fdir)
        cold = total is None
        if cold:
            total = await self._ensure_chunk(fdir, key, path, query, start // self._chunk)
            if total is None:
                return 502, {}, b""
        if start >= total:
            return 416, {"Content-Range": f"bytes */{total}"}, b""
        if end is None or end >= total:
            end = total - 1
        first, last = start // self._chunk, end // self._chunk
        # `cold`: the bootstrap above already fetched this range's first chunk.
        if cold or any(not (fdir / str(c)).exists() for c in range(first, last + 1)):
            self._schedule_readahead(fdir, key, path, query, first, last, total)
        # Every chunk the range needs, concurrently — a multi-chunk range
        # pays one round trip's latency, not N.
        results = await asyncio.gather(
            *(
                self._ensure_chunk(fdir, key, path, query, c)
                for c in range(first, last + 1)
            )
        )
        if any(t is None for t in results):
            return 502, {}, b""
        body = self._assemble(fdir, start, end)
        _touch(fdir)
        self._evict()
        # Only schedules background tasks (no await) — never delays this response.
        self._schedule_prewarm(path, query, first, last)
        headers = {
            "Content-Range": f"bytes {start}-{end}/{total}",
            "Accept-Ranges": "bytes",
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
            # Not just avoiding re-compression: gzip middleware must never
            # transform a 206 body with Content-Range (mivnav.api.app).
            "Content-Encoding": "identity",
        }
        return 206, headers, body

    async def _ensure_chunk(
        self, fdir: Path, key: str, path: str, query: str, index: int
    ) -> int | None:
        """Make sure aligned chunk ``index`` is on disk; return the file's
        total size, or ``None`` on upstream error."""
        if (fdir / str(index)).exists():
            return self._read_size(fdir)
        ikey = (key, index)
        fut = self._inflight.get(ikey)
        if fut is not None:
            return await fut
        # No await between the .get above and this assignment, so no second
        # request can slip in and start a duplicate fetch of the same chunk.
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        self._inflight[ikey] = fut
        try:
            total = await self._fetch_chunk(fdir, path, query, index)
        except BaseException as e:  # propagate to any waiters, don't wedge them
            self._inflight.pop(ikey, None)
            if not fut.done():
                fut.set_exception(e)
            raise
        self._inflight.pop(ikey, None)
        fut.set_result(total)
        return total

    async def _fetch_chunk(
        self, fdir: Path, path: str, query: str, index: int
    ) -> int | None:
        """Fetch one aligned chunk from upstream, store it, return the file's
        total size, or ``None`` on error."""
        cstart = index * self._chunk
        cend = cstart + self._chunk - 1
        try:
            r = await _http().get(
                self._tiles(path, query), headers={"Range": f"bytes={cstart}-{cend}"}
            )
        except httpx.HTTPError as e:
            log.warning("weather upstream fetch failed: %s", e)
            return None
        if r.status_code == 416:
            # Past EOF — only prewarm asks this (a neighbour file is smaller
            # than the one being read). Keep the size its `bytes */N` states,
            # so the next prewarm stops short instead of asking again.
            total = _content_range_total(r.headers.get("content-range"))
            if total is not None:
                fdir.mkdir(parents=True, exist_ok=True)
                self._write_size(fdir, total)
            return None
        if r.status_code not in (200, 206):
            log.warning("weather upstream %s for %s", r.status_code, path)
            return None
        total = _content_range_total(r.headers.get("content-range")) or len(r.content)
        fdir.mkdir(parents=True, exist_ok=True)
        self._track_write(fdir / str(index), r.content)
        self._write_size(fdir, total)
        return total

    def _assemble(self, fdir: Path, start: int, end: int) -> bytes:
        out = bytearray()
        for c in range(start // self._chunk, end // self._chunk + 1):
            data = (fdir / str(c)).read_bytes()
            base = c * self._chunk
            s = max(start, base) - base
            e = min(end, base + len(data) - 1) - base
            out += data[s : e + 1]
        return bytes(out)

    def _schedule_readahead(
        self, fdir: Path, key: str, path: str, query: str, first: int, last: int, total: int
    ) -> None:
        """Fire-and-forget: start the chunks the SAME file's next reads will
        want, so they arrive in parallel instead of one round trip each. The
        reader's later calls land on these fetches via `_inflight` (or on disk).
        Forward `_READAHEAD_BYTES`; plus, on the file's LAST chunk (the
        trailer, always read first), the one before it — the variable
        metadata the reader asks for next."""
        final = (total - 1) // self._chunk
        ahead = _READAHEAD_BYTES // self._chunk  # 0 turns forward read-ahead off
        wanted = set(range(last + 1, min(last + ahead, final) + 1))
        if last == final and first > 0:
            wanted.add(first - 1)
        for c in sorted(wanted):
            if (fdir / str(c)).exists() or (key, c) in self._inflight:
                continue
            task = asyncio.ensure_future(self._readahead_chunk(fdir, key, path, query, c))
            _prewarm_tasks.add(task)
            task.add_done_callback(_prewarm_tasks.discard)

    async def _readahead_chunk(
        self, fdir: Path, key: str, path: str, query: str, index: int
    ) -> None:
        try:
            await self._ensure_chunk(fdir, key, path, query, index)
        except asyncio.CancelledError:
            raise
        except BaseException as e:  # best-effort, like prewarm — never surfaces
            log.debug("weather readahead %s#%d failed: %s", path, index, e)

    def _schedule_prewarm(self, path: str, query: str, first: int, last: int) -> None:
        """Fire-and-forget: warm chunks ``first..last`` of the adjacent
        valid-time files. Biased forward (``t+1..t+N``) plus one ``t-1``."""
        if self._prewarm <= 0:
            return
        sem = self._prewarm_semaphore()
        deltas = [*range(1, self._prewarm + 1), -1]
        for d in deltas:
            npath = _neighbour_path(path, d)
            if npath is None:  # not a recognisable valid-time filename
                continue
            task = asyncio.ensure_future(
                self._prewarm_file(sem, npath, query, first, last)
            )
            _prewarm_tasks.add(task)
            task.add_done_callback(_prewarm_tasks.discard)

    def _prewarm_semaphore(self) -> asyncio.Semaphore:
        loop = asyncio.get_event_loop()
        if self._prewarm_sem is None or self._prewarm_sem_loop is not loop:
            self._prewarm_sem = asyncio.Semaphore(_PREWARM_CONCURRENCY)
            self._prewarm_sem_loop = loop
        return self._prewarm_sem

    async def _prewarm_file(
        self, sem: asyncio.Semaphore, path: str, query: str, first: int, last: int
    ) -> None:
        """Warm one neighbour file's chunks under the concurrency gate.
        Best-effort: a missing neighbour stops early, and errors are logged
        at debug and swallowed — prewarm never surfaces."""
        key = self._cache_key(path)
        fdir = self._dir / key
        try:
            async with sem:
                for c in range(first, last + 1):
                    total = self._read_size(fdir)
                    if total is not None and c * self._chunk >= total:
                        break  # past this (smaller) neighbour's end
                    if await self._ensure_chunk(fdir, key, path, query, c) is None:
                        break  # file absent / upstream error — skip the rest
        except asyncio.CancelledError:
            raise  # shutdown cancel — do not swallow
        except BaseException as e:
            log.debug("weather prewarm %s failed: %s", path, e)

    async def head_om(self, path: str, query: str) -> tuple[int, dict[str, str]]:
        """HEAD probe for a ``.om``: cached size if known, else a one-byte
        range GET (every 206 carries the total in ``Content-Range``)."""
        key = self._cache_key(path)
        fdir = self._dir / key
        total = self._read_size(fdir)
        if total is None:
            try:
                r = await _http().get(
                    self._tiles(path, query), headers={"Range": "bytes=0-0"}
                )
            except httpx.HTTPError as e:
                log.warning("weather HEAD probe failed: %s", e)
                return 502, {}
            if r.status_code not in (200, 206):
                return 502, {}
            total = _content_range_total(r.headers.get("content-range"))
            if total is None:
                total = int(r.headers.get("content-length", 0)) or None
            if total is not None:
                fdir.mkdir(parents=True, exist_ok=True)
                self._write_size(fdir, total)
        if total is None:
            return 502, {}
        return 200, {
            "Content-Length": str(total),
            "Accept-Ranges": "bytes",
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
        }

    @property
    def latest_ttl(self) -> int:
        """Seconds a resolved ``latest.json`` stays fresh — mirrored into the
        response's ``max-age`` so the browser collapses bursts too."""
        return self._latest_ttl

    async def passthrough_tiles(self, path: str, query: str) -> tuple[int, bytes, str]:
        """Proxy a small tiles path (``latest.json`` / ``in-progress.json``).
        ``latest.json`` is reused for ``latest_ttl`` seconds per upstream URL;
        everything else stays strictly fresh."""
        url = self._tiles(path, query)
        if self._latest_ttl <= 0 or not path.endswith("latest.json"):
            return await self._passthrough(url)
        now = time.monotonic()
        hit = self._latest_cache.get(url)
        if hit is not None and now - hit[0] < self._latest_ttl:
            return hit[1]
        # A rare race just does two fetches and keeps the later (still fresh)
        # result, so this stays correct without a lock.
        result = await self._passthrough(url)
        if result[0] == 200:
            self._latest_cache[url] = (now, result)
        return result

    async def forecast(self, query: str) -> tuple[int, bytes, str]:
        """Proxy the point-forecast API (the at-a-point wind readout)."""
        url = f"{self._forecast_url}?{query}" if query else self._forecast_url
        return await self._passthrough(url)

    async def _passthrough(self, url: str) -> tuple[int, bytes, str]:
        try:
            r = await _http().get(url)
        except httpx.HTTPError as e:
            log.warning("weather passthrough failed: %s", e)
            return 502, b"", "application/json"
        ctype = r.headers.get("content-type", "application/octet-stream")
        return r.status_code, r.content, ctype

    @staticmethod
    def _read_size(fdir: Path) -> int | None:
        try:
            return int((fdir / "size").read_text())
        except (OSError, ValueError):
            return None

    def _write_size(self, fdir: Path, total: int) -> None:
        self._track_write(fdir / "size", str(total).encode())

    def _track_write(self, path: Path, data: bytes) -> None:
        """Atomically write ``data`` and keep ``_cache_bytes`` in sync with
        the byte delta on disk; a no-op on the counter while it is still
        ``None`` (the lazy scan in ``_evict`` picks up disk state later)."""
        if self._cache_bytes is not None:
            try:
                old = path.stat().st_size
            except OSError:
                old = 0
            self._cache_bytes += len(data) - old
        _atomic_write(path, data)

    def stats(self) -> dict:
        """Read-only snapshot for /providers: a pure filesystem scan,
        independent of ``_evict``'s running total."""
        runs = 0
        chunks = 0
        total = 0
        try:
            for e in os.scandir(self._dir):
                if not e.is_dir():
                    continue
                runs += 1
                for f in os.scandir(e.path):
                    if not f.is_file():
                        continue
                    total += f.stat().st_size
                    if f.name != "size":
                        chunks += 1
        except OSError:
            pass
        return {
            "runs": runs,
            "chunks": chunks,
            "bytes": total,
            "budget": self._budget,
            "chunk_bytes": self._chunk,
        }

    def _evict(self) -> None:
        """Drop whole cached files, oldest-touched first, until under budget.
        Runs on every ``om_range`` call, so the common case must be an O(1)
        int compare, not a stat-walk of the whole tree (this used to walk
        unconditionally and pegged the Pi's CPU)."""
        if self._cache_bytes is None:
            self._cache_bytes = self._scan_bytes()
        if self._cache_bytes <= self._budget:
            return
        try:
            entries = [e for e in os.scandir(self._dir) if e.is_dir()]
        except OSError:
            return
        sized = [
            (e.stat().st_mtime, _dir_bytes(Path(e.path)), Path(e.path))
            for e in entries
        ]
        # Already walking every directory to pick victims — re-seed the
        # running total from that walk (free, and the one place drift would
        # matter) rather than trust the incrementally-tracked value.
        self._cache_bytes = sum(size for _mtime, size, _fdir in sized)
        for _mtime, size, fdir in sorted(sized):
            if self._cache_bytes <= self._budget:
                break
            _rmtree(fdir)
            self._cache_bytes -= size

    def _scan_bytes(self) -> int:
        """Sum on-disk cache bytes by walking the whole tree once — used only
        to seed ``_cache_bytes`` the first time ``_evict`` runs; after that,
        writes/evictions keep it in sync incrementally."""
        total = 0
        try:
            for e in os.scandir(self._dir):
                if e.is_dir():
                    total += _dir_bytes(Path(e.path))
        except OSError:
            pass
        return total


def _parse_range(header: str) -> tuple[int | None, int | None]:
    """``bytes=A-B`` / ``bytes=A-`` → ``(A, B|None)``; unparseable → ``(None, None)``."""
    m = _RANGE_RE.match(header.strip()) if header else None
    if not m:
        return None, None
    return int(m.group(1)), (int(m.group(2)) if m.group(2) else None)


def _neighbour_path(path: str, hours: int) -> str | None:
    """The concrete ``.om`` path ``hours`` away in valid time, or ``None`` if
    the last path component is not a ``YYYY-MM-DDThhmm.om`` valid-time
    filename. Only the filename moves (the run dir is shared); stepping
    crosses day/month/year boundaries via plain :class:`datetime` math."""
    head, sep, name = path.rpartition("/")
    m = _OM_NAME_RE.match(name)
    if not m:
        return None
    y, mo, d, h, mi = (int(g) for g in m.groups())
    t = datetime(y, mo, d, h, mi, tzinfo=timezone.utc) + timedelta(hours=hours)
    nname = f"{t.year:04d}-{t.month:02d}-{t.day:02d}T{t.hour:02d}{t.minute:02d}.om"
    return f"{head}{sep}{nname}"


def _content_range_total(value: str | None) -> int | None:
    """``bytes cs-ce/TOTAL`` → ``TOTAL``."""
    if not value or "/" not in value:
        return None
    try:
        return int(value.rsplit("/", 1)[1])
    except ValueError:
        return None


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def _touch(fdir: Path) -> None:
    try:
        now = time.time()
        os.utime(fdir, (now, now))
    except OSError:
        pass


def _dir_bytes(fdir: Path) -> int:
    total = 0
    try:
        for e in os.scandir(fdir):
            if e.is_file():
                total += e.stat().st_size
    except OSError:
        pass
    return total


def _rmtree(fdir: Path) -> None:
    try:
        for e in os.scandir(fdir):
            try:
                os.unlink(e.path)
            except OSError:
                pass
        os.rmdir(fdir)
    except OSError:
        pass
