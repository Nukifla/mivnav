# SPDX-License-Identifier: GPL-2.0-only
"""The SignalK Weather API backing — any provider plugin installed on the
boat's SignalK server, behind one implementation. The ONLY file that knows
the SignalK Weather API exists. See docs/architecture/signalk-weather-source.md."""

from __future__ import annotations

import asyncio
import math
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx
import numpy as np

from mivnav.features.weather.grid import GridFactory, tile2lat, tile2lon
from mivnav.features.weather.render import DecodedField

from .base import GUSTS, PRESSURE, TEMPERATURE, WIND, Coverage, DecodeRequest, SourceInfo

#: 32x32 = 1024 point queries per sweep, chosen against the DATA not the
#: display — see docs/architecture/signalk-weather-source.md#constants.
DEFAULT_LATTICE = 32

#: Concurrent in-flight point queries against the boat's own SignalK process.
DEFAULT_CONCURRENCY = 16

#: The slippy-tile level ONE sweep covers, so a viewport of tiles shares one
#: cube instead of each paying its own ~8s sweep. See
#: docs/architecture/signalk-weather-source.md#constants for why z5.
CUBE_ZOOM = 5

#: Cached sweeps: one entry (a whole forecast cube) is ~0.8MB; six covers a
#: viewport and its neighbours for ~5MB.
_CUBE_LRU_ENTRIES = 6

#: How long a coverage probe is reused. A staleness knob, not a cost one —
#: see docs/architecture/signalk-weather-source.md#constants.
PROBE_TTL_SECONDS = 300.0

#: Cached probes, one per (server, provider); bounds a repeatedly-edited
#: SignalK host from accumulating dead keys.
_PROBE_LRU_ENTRIES = 16

#: What the SignalK `WeatherData` shape calls the values we canonicalise.
#: Mapping upstream names to our own is exactly the job this module exists to
#: do — no consumer above ever sees a SignalK field name.
_PATHS: dict[str, tuple[str, ...]] = {
    WIND: ("wind.speedTrue", "wind.speedOverGround"),
    GUSTS: ("wind.gust",),
    PRESSURE: ("outside.pressure",),
    TEMPERATURE: ("outside.temperature",),
}
_DIRECTION_PATHS: tuple[str, ...] = ("wind.directionTrue",)

# `water.waves` IS in the SignalK `WeatherData` interface, but its nested
# shape is unverified against a real payload — guessing a path would silently
# produce an all-NaN field. Left unmapped until the spike sees one.

# UNITS ARE THE ONE THING TO VERIFY FIRST — see
# docs/architecture/signalk-weather-source.md#units-the-one-thing-to-verify-first.
_ASSUME_RADIANS = True


#: SignalK is strict SI; colour scales are calibrated in Open-Meteo's units.
#: Getting this wrong CLAMPs to the ramp edge and paints a plausible-looking
#: wash rather than an obvious error — see docs/architecture/signalk-weather-source.md#units.
_UNIT_CONVERSION = {
    TEMPERATURE: lambda v: v - 273.15,  # K -> degC
    PRESSURE: lambda v: v / 100.0,  # Pa -> hPa
}


def _to_app_units(variable: str, raw: float) -> float:
    conv = _UNIT_CONVERSION.get(variable)
    return conv(raw) if conv else raw


def _first(entry: dict, paths: tuple[str, ...]) -> float | None:
    """First numeric value among ``paths``, or ``None``."""
    for path in paths:
        v = _dig(entry, path)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
    return None


@dataclass(frozen=True)
class LatticeCube:
    """One lattice sweep's whole answer: every variable at every forecast
    time. Cached as a unit, keyed by ``(provider, bbox, lattice)`` — NOT per
    field — because one point query already returns the full series."""

    times: tuple[datetime, ...]
    grid: object
    values: dict[str, list[np.ndarray]]
    directions: dict[str, list[np.ndarray]]

    def field(self, variable: str, time: datetime) -> DecodedField | None:
        """The ``DecodedField`` for one slice, or ``None`` if this cube does not
        carry it — never a nearest-variable or nearest-hour substitution, which
        would be exactly the silent fallback the design forbids."""
        series = self.values.get(variable)
        if not series or not self.times:
            return None
        # Nearest time IS chosen deliberately (every decoder does the same);
        # choosing another VARIABLE never happens.
        idx = min(
            range(len(self.times)),
            key=lambda i: abs((self.times[i] - time).total_seconds()),
        )
        if idx >= len(series):
            return None
        dirs = self.directions.get(variable)
        return DecodedField(
            grid=self.grid,
            values=series[idx],
            directions=dirs[idx] if dirs and idx < len(dirs) else None,
        )


_CubeKey = tuple[str, str, int, int, int, int]


class _CubeCache:
    """Process-wide sweep cache with single-flight: without it, MapLibre's
    whole-viewport tile burst starts one ~8s sweep PER TILE. Deliberately no
    TTL — see docs/architecture/signalk-weather-source.md for why."""

    def __init__(self, max_entries: int = _CUBE_LRU_ENTRIES) -> None:
        self._lru: OrderedDict[_CubeKey, LatticeCube] = OrderedDict()
        self._inflight: dict[_CubeKey, asyncio.Task[LatticeCube]] = {}
        self._max = max_entries
        self._lock = asyncio.Lock()

    async def get(
        self, key: _CubeKey, sweep: Callable[[], Awaitable[LatticeCube]]
    ) -> LatticeCube:
        async with self._lock:
            cached = self._lru.get(key)
            if cached is not None:
                self._lru.move_to_end(key)
                return cached
            task = self._inflight.get(key)
            if task is None:
                task = asyncio.ensure_future(self._run(key, sweep))
                self._inflight[key] = task
        return await asyncio.shield(task)

    async def _run(
        self, key: _CubeKey, sweep: Callable[[], Awaitable[LatticeCube]]
    ) -> LatticeCube:
        try:
            cube = await sweep()
        except BaseException:
            async with self._lock:
                self._inflight.pop(key, None)
            raise
        async with self._lock:
            self._inflight.pop(key, None)
            self._lru[key] = cube
            self._lru.move_to_end(key)
            while len(self._lru) > self._max:
                self._lru.popitem(last=False)
        return cube


_CUBES = _CubeCache()


def _cube_tile(req: DecodeRequest) -> tuple[int, int, int]:
    """The box one sweep covers for ``req``, as a slippy tile. Quantises UP
    to the ``CUBE_ZOOM`` ancestor, so a point request takes the same z5 tile
    a click in-view already swept — a readout is normally free."""
    if req.tile is not None:
        z, x, y = req.tile
        if z <= CUBE_ZOOM:
            return z, x, y
        shift = z - CUBE_ZOOM
        return CUBE_ZOOM, x >> shift, y >> shift
    if req.at is not None:
        lat, lon = req.at
        n = 1 << CUBE_ZOOM
        x = int((lon + 180.0) / 360.0 * n)
        lat_rad = math.radians(max(-85.05112878, min(85.05112878, lat)))
        y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
        return CUBE_ZOOM, min(max(x, 0), n - 1), min(max(y, 0), n - 1)
    raise ValueError("a SignalK decode needs a tile or a position to sample around")


def _tile_bbox(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """``(west, south, east, north)`` degrees for a slippy tile. ``tile2lon``
    wraps, so the last column's EAST edge would come back as -180 and invert
    the box; pinned to +180 instead."""
    n = 1 << z
    east = 180.0 if x + 1 >= n else float(tile2lon(x + 1, z))
    return (
        float(tile2lon(x, z)),
        float(tile2lat(y + 1, z)),
        east,
        float(tile2lat(y, z)),
    )


def _dig(obj: object, dotted: str):
    """Value at a dotted path, or ``None`` — SignalK nests its `WeatherData`."""
    cur = obj
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


@dataclass(frozen=True)
class SignalKSource:
    """One provider registered on the SignalK server."""

    provider_id: str
    provider_label: str
    base_url: str
    variables: tuple[str, ...] = (WIND, GUSTS, PRESSURE, TEMPERATURE)
    #: Valid times, discovered by probing one position (see `probe_times`).
    times: tuple[datetime, ...] = ()
    #: Whether answering may need the internet — the server can't tell us,
    #: so declared per provider in config rather than guessed.
    network: bool = True
    _client: httpx.AsyncClient | None = field(default=None, compare=False, repr=False)

    @property
    def id(self) -> str:
        return f"signalk:{self.provider_id}"

    def describe(self) -> SourceInfo:
        badge = "SignalK" if self.network else "Offline · SignalK"
        return SourceInfo(
            id=self.id,
            label=self.provider_label,
            badge=badge,
            requires_network=self.network,
            variables=self.variables,
            # One list of forecast times; whether the bytes behind them are
            # local is the provider's business, so the local/remote split
            # lands wholly on one side rather than being invented here.
            coverage=Coverage(
                local=() if self.network else self.times,
                remote=self.times if self.network else (),
                reference_time=self.times[0] if self.times else None,
            ),
            region=None,
        )

    # ── decode ──────────────────────────────────────────────────────────────

    async def decode(self, req: DecodeRequest) -> DecodedField:
        """One slice of a lattice sweep. Unlike other backings this genuinely
        needs ``req.tile``/``req.at``: the Weather API is position-only, so a
        box must be CHOSEN (``_cube_tile``) and sampled as a whole cube."""
        if req.variable not in self.variables:
            raise KeyError(
                f"{self.id} serves {list(self.variables)}, not {req.variable!r}"
            )
        z, x, y = _cube_tile(req)
        key = (self.base_url, self.provider_id, z, x, y, DEFAULT_LATTICE)
        cube = await _CUBES.get(key, lambda: self.sample_cube(_tile_bbox(z, x, y)))
        field_ = cube.field(req.variable, req.time)
        if field_ is None:
            raise KeyError(
                f"{self.id} returned no {req.variable!r} for {req.time.isoformat()} "
                "over this area"
            )
        return field_

    # ── sampling ────────────────────────────────────────────────────────────

    def _point_url(self) -> str:
        return f"{self.base_url}/signalk/v2/api/weather/forecasts/point"

    async def _sample(
        self, client: httpx.AsyncClient, lat: float, lon: float, time: datetime
    ) -> dict | None:
        """One point forecast, or ``None``. Never raises: a hole in the lattice
        degrades that node to NaN, which the grid already handles, rather than
        failing a whole tile because one of 1024 calls timed out."""
        try:
            res = await client.get(
                self._point_url(),
                params={"lat": lat, "lon": lon, "provider": self.provider_id},
            )
            if res.status_code != 200:
                return None
            entries = res.json()
        except (httpx.HTTPError, ValueError):
            return None
        if not isinstance(entries, list):
            return None
        # Nearest entry to the requested valid time. The API returns a series
        # per position; picking here keeps time selection out of the caller.
        best, best_dt = None, None
        for e in entries:
            raw = e.get("date") if isinstance(e, dict) else None
            if not isinstance(raw, str):
                continue
            try:
                when = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                continue
            delta = abs((when - time).total_seconds())
            if best_dt is None or delta < best_dt:
                best, best_dt = e, delta
        return best

    async def sample_cube(
        self,
        bbox: tuple[float, float, float, float],
        lattice: int = DEFAULT_LATTICE,
        concurrency: int = DEFAULT_CONCURRENCY,
    ) -> LatticeCube:
        """One lattice sweep over ``bbox`` (w, s, e, n) -> every variable at
        every forecast time. THE call: each node's response already carries
        the whole series, so slicing afterwards is free."""
        west, south, east, north = bbox
        lats = np.linspace(south, north, lattice)
        lons = np.linspace(west, east, lattice)
        n = lattice * lattice

        # node index -> its parsed entries, keyed by valid time
        per_node: list[dict[datetime, dict]] = [dict() for _ in range(n)]
        sem = asyncio.Semaphore(concurrency)
        client = self._client or httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0))
        owns_client = self._client is None

        async def one(idx: int, lat: float, lon: float) -> None:
            async with sem:
                entries = await self._series(client, lat, lon)
            per_node[idx] = entries

        try:
            await asyncio.gather(
                *(
                    one(iy * lattice + ix, float(lats[iy]), float(lons[ix]))
                    for iy in range(lattice)
                    for ix in range(lattice)
                )
            )
        finally:
            if owns_client:
                await client.aclose()

        # The union of times any node reported, so one node's gap does not
        # truncate the cube for everywhere else.
        times = tuple(sorted({t for node in per_node for t in node}))
        grid = GridFactory.create(
            {
                "type": "regular",
                "nx": lattice,
                "ny": lattice,
                "dx": float((east - west) / (lattice - 1)) if lattice > 1 else 0.0,
                "dy": float((north - south) / (lattice - 1)) if lattice > 1 else 0.0,
                "lonMin": float(west),
                "latMin": float(south),
            }
        )

        values: dict[str, list[np.ndarray]] = {}
        directions: dict[str, list[np.ndarray]] = {}
        for variable in self.variables:
            per_time_v: list[np.ndarray] = []
            per_time_d: list[np.ndarray] = []
            for when in times:
                v = np.full(n, np.nan, dtype=np.float32)
                d = np.full(n, np.nan, dtype=np.float32) if variable == WIND else None
                for idx, node in enumerate(per_node):
                    entry = node.get(when)
                    if entry is None:
                        continue
                    raw = _first(entry, _PATHS.get(variable, ()))
                    if raw is not None:
                        v[idx] = _to_app_units(variable, raw)
                    if d is not None:
                        ang = _first(entry, _DIRECTION_PATHS)
                        if ang is not None:
                            d[idx] = (
                                math.degrees(ang) % 360.0
                                if _ASSUME_RADIANS
                                else ang % 360.0
                            )
                per_time_v.append(v)
                if d is not None:
                    per_time_d.append(d)
            values[variable] = per_time_v
            if per_time_d:
                directions[variable] = per_time_d
        return LatticeCube(times=times, grid=grid, values=values, directions=directions)

    async def _series(
        self, client: httpx.AsyncClient, lat: float, lon: float
    ) -> dict[datetime, dict]:
        """One node's whole forecast series, keyed by valid time. Empty on any
        failure: a hole degrades that node to NaN, which the grid handles,
        rather than losing the sweep because 1 of 1024 calls timed out."""
        try:
            res = await client.get(
                self._point_url(),
                params={"lat": lat, "lon": lon, "provider": self.provider_id},
            )
            if res.status_code != 200:
                return {}
            entries = res.json()
        except (httpx.HTTPError, ValueError):
            return {}
        if not isinstance(entries, list):
            return {}
        out: dict[datetime, dict] = {}
        for e in entries:
            raw = e.get("date") if isinstance(e, dict) else None
            if not isinstance(raw, str):
                continue
            try:
                out[
                    datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
                ] = e
            except ValueError:
                continue
        return out


async def probe_times(
    base_url: str, provider_id: str, lat: float, lon: float
) -> tuple[datetime, ...]:
    """The forecast valid times a provider offers, read from one point query
    — the Weather API exposes no coverage call. Empty on any failure, which
    reads as "nothing can be promised right now", not a claim we can't keep."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            res = await client.get(
                f"{base_url}/signalk/v2/api/weather/forecasts/point",
                params={"lat": lat, "lon": lon, "provider": provider_id},
            )
            if res.status_code != 200:
                return ()
            entries = res.json()
    except (httpx.HTTPError, ValueError):
        return ()
    if not isinstance(entries, list):
        return ()
    out: list[datetime] = []
    for e in entries:
        raw = e.get("date") if isinstance(e, dict) else None
        if isinstance(raw, str):
            try:
                out.append(
                    datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
                )
            except ValueError:
                continue
    return tuple(sorted(out))


@dataclass(frozen=True)
class _Probe:
    times: tuple[datetime, ...]
    at: float  # time.monotonic() when the probe answered


_ProbeKey = tuple[str, str]


class _ProbeCache:
    """Coverage probes, cached per provider (never by position), with
    single-flight; an empty answer is never cached, so a position arriving
    later triggers a real probe."""

    def __init__(
        self, ttl: float = PROBE_TTL_SECONDS, max_entries: int = _PROBE_LRU_ENTRIES
    ) -> None:
        self._lru: OrderedDict[_ProbeKey, _Probe] = OrderedDict()
        self._inflight: dict[_ProbeKey, asyncio.Task[tuple[datetime, ...]]] = {}
        self._ttl = ttl
        self._max = max_entries
        self._lock = asyncio.Lock()

    async def get(
        self, base_url: str, provider_id: str, position: tuple[float, float] | None
    ) -> tuple[datetime, ...]:
        key = (base_url, provider_id)
        async with self._lock:
            hit = self._lru.get(key)
            if hit is not None:
                self._lru.move_to_end(key)
                if time.monotonic() - hit.at < self._ttl:
                    return hit.times
            if position is None:
                # Nowhere honest to ask from — report what we last knew
                # WITHOUT writing a cache entry, so a position arriving
                # triggers a real probe.
                return hit.times if hit is not None else ()
            task = self._inflight.get(key)
            if task is None:
                task = asyncio.ensure_future(self._run(key, position))
                self._inflight[key] = task
        return await asyncio.shield(task)

    async def _run(
        self, key: _ProbeKey, position: tuple[float, float]
    ) -> tuple[datetime, ...]:
        base_url, provider_id = key
        try:
            times = await probe_times(base_url, provider_id, position[0], position[1])
        except BaseException:
            async with self._lock:
                self._inflight.pop(key, None)
            raise
        async with self._lock:
            self._inflight.pop(key, None)
            if times:
                self._lru[key] = _Probe(times=times, at=time.monotonic())
                self._lru.move_to_end(key)
                while len(self._lru) > self._max:
                    self._lru.popitem(last=False)
        return times


_PROBES = _ProbeCache()


async def coverage_times(
    base_url: str, provider_id: str, position: tuple[float, float] | None
) -> tuple[datetime, ...]:
    """A provider's forecast valid times, cached — what ``describe()``
    reports as coverage. ``probe_times`` is the raw call; this is the one
    every caller should use (see ``_ProbeCache``)."""
    return await _PROBES.get(base_url, provider_id, position)


async def discover(base_url: str) -> list[tuple[str, str]]:
    """``[(provider_id, label)]`` from ``GET /signalk/v2/api/weather/_providers``.
    Empty on any failure — no SignalK server, no plugin, no weather. Never a
    fabricated entry: a source that cannot answer must not appear in a picker."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0)) as client:
            res = await client.get(f"{base_url}/signalk/v2/api/weather/_providers")
            if res.status_code != 200:
                return []
            body = res.json()
    except (httpx.HTTPError, ValueError):
        return []
    if not isinstance(body, dict):
        return []
    out: list[tuple[str, str]] = []
    for pid, meta in body.items():
        name = meta.get("name") if isinstance(meta, dict) else None
        out.append((pid, name if isinstance(name, str) and name else pid))
    return sorted(out)
