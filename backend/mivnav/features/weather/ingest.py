# SPDX-License-Identifier: GPL-2.0-only
"""The weather bake job: fetch a bounded window of ``.om`` runs for one
Open-Meteo domain into a dataset's directory. A ``.om`` file covers a
domain's WHOLE grid, so the only knobs are WHICH domain and HOW FAR AHEAD.
See docs/architecture/weather-ingest.md."""

from __future__ import annotations

import logging
import os
import struct
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from omfiles import OmFileReader

from mivnav.features.weather.config import WeatherConfig
from mivnav.ingest.runner import ST_BAKE, ST_FETCH, BaseJobStatus, IngestRunner

log = logging.getLogger(__name__)

#: The subdirectory both this runner and ``WeatherMirror`` agree a baked
#: domain's files live under, mirroring the live route's own request shape.
DATA_SPATIAL = "data_spatial"

#: A baked `.om` is fetched as this many byte ranges in flight at once. One
#: stream to the upstream bucket is latency-bound (~190-270 KB/s measured, so
#: a 95 MB ukmo_uk_deterministic_2km hour took ~6 min and a 49-hour bake ~5 h);
#: 32 × 4 MiB ranges measured 2.8 MB/s on the same link.
_PART_BYTES = 4 * 1024 * 1024
_PARALLEL_PARTS = 32


#: A bake keeps only the variables the overlay draws, as a SPARSE `.om` of
#: the original size: those variables' bytes and the metadata tail at their
#: own offsets, holes elsewhere — so the decoder opens it unchanged, and a
#: variable that was not kept fails cleanly ("Corrupted data"), never as
#: garbage. Measured: ukmo_uk_deterministic_2km keeps 2.6 of 96.7 MB/hour.
#:
#: Where a variable's bytes live is read off the file itself: an array
#: record is [u8 type][u8 compression][u16 name len][u32 children]
#: [u64 lut_size][u64 lut_offset]… (open-meteo om-file-format, v3). The
#: records sit in one tail region; each variable's data is one contiguous
#: block ending at the next structure (another variable's data, a lookup
#: table, or the records). Upstream consolidates every lookup table at the
#: tail too; the omfiles writer puts each right after its data — both work.
_OM_ARRAY_TYPES = range(12, 22)  # int8_array .. double_array
#: One read that usually covers a whole file's records + lookup tables.
_TAIL_GUESS = 256 * 1024
#: A "tail" bigger than this means metadata is NOT consolidated at the end
#: (an inline-placement file): fetch whole, in parallel, rather than pull
#: most of the file as tail over one serial stream.
_TAIL_MAX = 8 * 1024 * 1024


class _Cancelled(Exception):
    """Raised inside a download when the bake was cancelled mid-file."""


class _TailReader:
    """An ``OmFileReader.from_fsspec`` source over a remote file's END,
    fetched by range and extended downward on demand. With ``probe_below``
    set, reads below it return zeros and record where the first began: the
    reader then fails on that fake chunk, and the recorded start is the
    variable's first data byte — found without downloading any data."""

    def __init__(self, get: Callable[[int, int], bytes], size: int) -> None:
        self._get = get
        self._size = size
        self._start = max(0, size - _TAIL_GUESS)
        self._buf = get(self._start, size)
        self.probe_below: int | None = None
        self.first_probe: int | None = None
        #: Real bytes below the tail (lookup tables stored between data).
        self.segments: dict[int, bytes] = {}

    def size(self, path: str) -> int:  # noqa: ARG002 — the fsspec shape
        return self._size

    def hold_from(self, start: int) -> None:
        if start < self._start:
            self._buf = self._get(start, self._start) + self._buf
            self._start = start

    def cat_file(self, path: str, start: int | None = None, end: int | None = None) -> bytes:  # noqa: ARG002
        s = start or 0
        e = self._size if end is None else end
        if self.probe_below is not None and s < self.probe_below:
            for off, seg in self.segments.items():
                if off <= s and e <= off + len(seg):
                    return seg[s - off : e - off]
            if self.first_probe is None:
                self.first_probe = s
            return bytes(e - s)
        self.hold_from(s)
        return self._buf[s - self._start : e - self._start]


class WeatherIngestError(Exception):
    """A weather bake could not start, or failed mid-run."""


@dataclass
class JobStatus(BaseJobStatus):
    domain: str = ""
    om_files: int = 0  # files newly fetched this run (skips excluded)
    pruned: int = 0  # files outside the selected window deleted this run


def om_path_for(domain: str, reference_time: str, valid_time: str) -> str:
    """The upstream-relative ``.om`` path for one ``valid_time`` of a
    ``reference_time`` (run) — ported from ``@openmeteo/weather-map-layer``'s
    manifest-resolve (``normalizeUrl``, minified as ``vQ``)."""
    ref = _parse_utc(reference_time)
    val = _parse_utc(valid_time)
    run_dir = f"{ref.year:04d}/{ref.month:02d}/{ref.day:02d}/{ref.hour:02d}00Z"
    fname = f"{val.year:04d}-{val.month:02d}-{val.day:02d}T{val.hour:02d}00.om"
    return f"{domain}/{run_dir}/{fname}"


def _parse_utc(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    return dt.astimezone(timezone.utc) if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def om_paths_for_bake(
    domain: str,
    manifest: dict,
    *,
    now: datetime,
    max_forecast_hours: int | None = None,
) -> list[str]:
    """Every ``.om`` path ``manifest`` names that this bake should hold, and
    :func:`_prune_stale` keeps everything outside of. Pure; empty on a
    malformed manifest, not an error."""
    reference_time = manifest.get("reference_time")
    valid_times = manifest.get("valid_times") or []
    if not reference_time or not valid_times:
        return []
    today = now.astimezone(timezone.utc).date()
    horizon: datetime | None = None
    if max_forecast_hours is not None:
        try:
            horizon = _parse_utc(reference_time) + timedelta(hours=max_forecast_hours)
        except (TypeError, ValueError):
            return []
    paths = []
    for vt in valid_times:
        try:
            val = _parse_utc(vt)
        except (TypeError, ValueError):
            continue
        if val.date() < today:
            continue
        if horizon is None:
            if val.date() != today:
                continue
        elif val > horizon:
            continue
        paths.append(om_path_for(domain, reference_time, vt))
    return paths


class WeatherIngestRunner(IngestRunner[JobStatus]):
    """One background weather bake at a time; status is poll-able — same job
    spine as ``PoiIngestRunner``/``SatelliteIngestRunner``. ``weather_config``
    is read fresh at the START of every bake."""

    status_cls = JobStatus
    busy_error = WeatherIngestError
    job_name = "weather bake"

    def __init__(
        self,
        dataset_dir: Path,
        http: httpx.Client | None = None,
        weather_config: Callable[[], WeatherConfig] | None = None,
        keep_names: Callable[[str], frozenset[str]] | None = None,
    ) -> None:
        super().__init__()
        self._dir = dataset_dir
        self._http = http or httpx.Client(
            timeout=httpx.Timeout(60.0, connect=15.0),
            follow_redirects=True,
            # Keep every parallel part's connection alive between parts.
            limits=httpx.Limits(
                max_connections=_PARALLEL_PARTS, max_keepalive_connections=_PARALLEL_PARTS
            ),
        )
        self._weather_config = weather_config or WeatherConfig
        # domain -> the `.om` variable names a bake keeps; None keeps whole
        # files. Injected (the registry's `upstream_names_for`): only the
        # registry may import a source implementation.
        self._keep_names = keep_names

    def ingest(self, domain: str, max_forecast_hours: int | None = None) -> None:
        """Start a background bake of ``domain``'s ``.om`` runs from today
        out to ``max_forecast_hours`` of lead time (``None`` = today only).
        Returns immediately. Raises :class:`WeatherIngestError`
        synchronously for an empty ``domain``."""
        if not domain:
            raise WeatherIngestError("a weather bake needs a domain")
        cfg = self._weather_config()
        self._start(
            domain,
            lambda: self._bake(domain, cfg.upstream_tiles_url, max_forecast_hours),
        )

    def _bake(self, domain: str, tiles_url: str, max_forecast_hours: int | None = None) -> None:
        keep = self._keep_names(domain) if self._keep_names else frozenset()
        self._update(state=ST_FETCH, task="manifest", domain=domain)
        manifest = self._fetch_manifest(tiles_url, domain)
        paths = om_paths_for_bake(
            domain,
            manifest,
            now=datetime.now(timezone.utc),
            max_forecast_hours=max_forecast_hours,
        )
        self._update(state=ST_BAKE, task="fetching", total=len(paths), current=0)
        fetched = 0
        for i, path in enumerate(paths, start=1):
            if self.cancel_requested():
                return  # _run_guarded reports "cancelled"
            label = f"fetching {path.rsplit('/', 1)[-1].removesuffix('.om')}"
            self._update(task=label)

            def on_bytes(done: int, size: int, label: str = label) -> None:
                self._update(task=f"{label} · {done >> 20}/{size >> 20} MB")

            if self._fetch_om(tiles_url, path, on_bytes, keep):
                fetched += 1
                self._log(f"fetched {path}")
            self._progress(i, len(paths))
        pruned = _prune_stale(self._dir / DATA_SPATIAL / domain, keep=set(paths))
        if pruned:
            self._log(f"pruned {pruned} stale run(s) for {domain}")
        self._update(om_files=fetched, pruned=pruned)

    def _fetch_manifest(self, tiles_url: str, domain: str) -> dict:
        url = f"{tiles_url.rstrip('/')}/{DATA_SPATIAL}/{domain}/latest.json"
        try:
            r = self._http.get(url)
        except httpx.HTTPError as e:
            raise WeatherIngestError(f"fetching {domain} manifest failed: {e}") from e
        if r.status_code != 200:
            raise WeatherIngestError(f"fetching {domain} manifest: HTTP {r.status_code}")
        try:
            body = r.json()
        except ValueError as e:
            raise WeatherIngestError(f"{domain} manifest was not valid JSON: {e}") from e
        if not isinstance(body, dict):
            raise WeatherIngestError(f"{domain} manifest was not a JSON object")
        return body

    def _fetch_om(
        self,
        tiles_url: str,
        om_path: str,
        on_bytes: Callable[[int, int], None] | None = None,
        keep: frozenset[str] = frozenset(),
    ) -> bool:
        """Fetch one ``.om`` file, unless already there (immutable), as
        `_PARALLEL_PARTS` concurrent byte ranges written in place — only
        ``keep``'s variables when they can be located and verified, else
        the whole file. A failed fetch is logged and skipped — one missing
        hour must not fail the whole bake. A cancel mid-file drops it."""
        target = self._dir / DATA_SPATIAL / om_path
        if target.exists():
            return False
        url = f"{tiles_url.rstrip('/')}/{DATA_SPATIAL}/{om_path}"
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(f"{target.suffix}.{os.getpid()}.tmp")
        try:
            # A one-byte range states the size; an upstream that ignores
            # Range answers 200 with the whole file, which is kept as-is.
            r = self._http.get(url, headers={"Range": "bytes=0-0"})
            if r.status_code == 200:
                tmp.write_bytes(r.content)
            elif r.status_code == 206:
                size = _range_total(r.headers.get("content-range"))
                if size is None:
                    raise WeatherIngestError("206 without a Content-Range total")
                plan = self._plan_ranges(url, om_path, size, keep) if keep else None
                if plan is not None:
                    ranges, kept = plan
                    self._fetch_parts(url, tmp, size, on_bytes, ranges)
                    if not _decodes(tmp, kept):
                        log.warning("weather bake: %s did not verify sparse — fetching whole", om_path)
                        plan = None
                if plan is None:
                    self._fetch_parts(url, tmp, size, on_bytes)
            else:
                raise WeatherIngestError(f"HTTP {r.status_code}")
        except _Cancelled:
            tmp.unlink(missing_ok=True)
            return False
        except (httpx.HTTPError, WeatherIngestError, OSError) as e:
            log.warning("weather bake: fetching %s failed: %s", om_path, e)
            tmp.unlink(missing_ok=True)
            return False
        tmp.replace(target)
        return True

    def _plan_ranges(
        self, url: str, om_path: str, size: int, keep: frozenset[str]
    ) -> tuple[list[tuple[int, int]], set[str]] | None:
        """``(byte ranges, kept names)`` covering the header, ``keep``'s
        variables and the metadata tail; ``None`` (fetch whole) when the file
        cannot be laid out or holds none of ``keep``."""

        def get(start: int, end: int) -> bytes:
            r = self._http.get(url, headers={"Range": f"bytes={start}-{end - 1}"})
            if r.status_code != 206 or len(r.content) != end - start:
                raise WeatherIngestError(f"range {start}-{end - 1}: HTTP {r.status_code}")
            return r.content

        tail = _TailReader(get, size)
        try:
            meta = OmFileReader.from_fsspec(tail, om_path)._get_flat_variable_metadata()
        except RuntimeError as e:
            log.info("weather bake: %s has no readable layout (%s) — fetching whole", om_path, e)
            return None
        luts: dict[str, tuple[int, int]] = {}
        for name, var in meta.items():
            leaf = name.removeprefix("//")
            rec = tail.cat_file("", var.offset, var.offset + var.size)
            if "/" not in leaf and len(rec) >= 24 and rec[0] in _OM_ARRAY_TYPES:
                lut_size, lut_offset = struct.unpack_from("<QQ", rec, 8)
                luts[leaf] = (lut_offset, lut_offset + lut_size)
        kept = keep & luts.keys()
        if not kept:
            return None
        tail_start = min(v.offset for v in meta.values())
        if size - tail_start > _TAIL_MAX or any(e > size for _, e in luts.values()):
            return None
        tail.hold_from(tail_start)
        for lo, hi in luts.values():
            if lo < tail_start:
                tail.segments[lo] = get(lo, hi)
        tail.probe_below = tail_start
        data_start: dict[str, int] = {}
        for leaf in luts:
            tail.first_probe = None
            try:
                OmFileReader.from_fsspec(tail, om_path).get_child_by_name(leaf).read_array((...,))
            except Exception:  # noqa: BLE001 — failing on the fake chunk IS the probe
                pass
            if tail.first_probe is None:
                return None
            data_start[leaf] = tail.first_probe
        # A block ends at the next thing known to start after it.
        marks = sorted({*data_start.values(), *(lo for lo, _ in luts.values()), tail_start})

        def block_end(start: int) -> int:
            return next(m for m in marks if m > start)

        ranges = [(0, min(data_start.values())), (tail_start, size)]
        for leaf in kept:
            ranges.append((data_start[leaf], block_end(data_start[leaf])))
            ranges.append(luts[leaf])
        return _merge(ranges), kept

    def _fetch_parts(
        self,
        url: str,
        tmp: Path,
        size: int,
        on_bytes: Callable[[int, int], None] | None,
        ranges: list[tuple[int, int]] | None = None,
    ) -> None:
        """Fill ``tmp`` (``size`` bytes; ``ranges`` of it, default all) from
        `_PART_BYTES` pieces, up to `_PARALLEL_PARTS` in flight — anything
        outside ``ranges`` stays a hole. Raises on any short or failed part."""
        lock = threading.Lock()
        failed = threading.Event()  # one bad part stops the queued rest
        done = 0
        pieces = [
            (s, min(s + _PART_BYTES, end))
            for start, end in (ranges or [(0, size)])
            for s in range(start, end, _PART_BYTES)
        ]
        wanted = sum(e - s for s, e in pieces)

        with open(tmp, "wb") as f:
            f.truncate(size)
            fd = f.fileno()

            def part(start: int, stop: int) -> None:
                nonlocal done
                if failed.is_set() or self.cancel_requested():
                    raise _Cancelled
                end = stop - 1
                try:
                    r = self._http.get(url, headers={"Range": f"bytes={start}-{end}"})
                    if r.status_code != 206 or len(r.content) != end - start + 1:
                        raise WeatherIngestError(
                            f"range {start}-{end}: HTTP {r.status_code}, {len(r.content)} B"
                        )
                except Exception:
                    failed.set()
                    raise
                os.pwrite(fd, r.content, start)
                with lock:
                    done += len(r.content)
                    if on_bytes is not None:
                        on_bytes(done, wanted)

            with ThreadPoolExecutor(max_workers=_PARALLEL_PARTS) as pool:
                futs = [pool.submit(part, s, e) for s, e in pieces]
                errors = [e for e in (f.exception() for f in futs) if e is not None]
        # The real failure outranks the parts it stopped (or a cancel).
        real = [e for e in errors if not isinstance(e, _Cancelled)]
        if real:
            raise real[0]
        if errors:
            raise _Cancelled


def _merge(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Sorted, with touching/overlapping ``[start, end)`` ranges joined."""
    out: list[tuple[int, int]] = []
    for s, e in sorted(r for r in ranges if r[1] > r[0]):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def _decodes(path: Path, names: set[str]) -> bool:
    """Every kept variable of the sparse file decodes — the one guard
    against a mis-laid-out bake, which would otherwise be served (immutable,
    never refetched) as broken data forever."""
    try:
        reader = OmFileReader.from_path(str(path))
        try:
            for name in names:
                reader.get_child_by_name(name).read_array((...,))
        finally:
            reader.close()
    except Exception as e:  # noqa: BLE001 — any failure means "not verified"
        log.warning("weather bake: sparse verify of %s failed: %s", path.name, e)
        return False
    return True


def _range_total(value: str | None) -> int | None:
    """``bytes 0-0/TOTAL`` → ``TOTAL``."""
    if not value or "/" not in value:
        return None
    try:
        return int(value.rsplit("/", 1)[1])
    except ValueError:
        return None


def _prune_stale(domain_dir: Path, *, keep: set[str]) -> int:
    """Delete every ``.om`` file under ``domain_dir`` not in ``keep`` (this
    bake's selected set), and any run directory left empty by the deletes.
    A missing ``domain_dir`` prunes nothing, not an error."""
    if not domain_dir.is_dir():
        return 0
    domain = domain_dir.name
    removed = 0
    for om_file in domain_dir.rglob("*.om"):
        rel = f"{domain}/{om_file.relative_to(domain_dir).as_posix()}"
        if rel in keep:
            continue
        try:
            om_file.unlink()
            removed += 1
        except OSError:
            continue
    # Clean up now-empty run/date directories, deepest first.
    for d in sorted((p for p in domain_dir.rglob("*") if p.is_dir()), reverse=True):
        try:
            d.rmdir()  # only succeeds if empty
        except OSError:
            pass
    return removed
