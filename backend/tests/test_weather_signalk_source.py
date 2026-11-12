# SPDX-License-Identifier: GPL-2.0-only
"""The SignalK Weather API source — lattice sampling into a ``DecodedField``.

The interesting claim under test is that a POSITION-ONLY upstream can still feed
every renderer we have. SignalK's Weather API has no area, bbox or grid
operation; this samples a lattice it chooses and produces the same
``DecodedField`` the GRIB and ``.om`` decoders produce, so the wash rasteriser,
the particle texture and the point readout all work unmodified.

Driven entirely through ``httpx.MockTransport`` — no server, no network, and no
measurement of anyone's upstream API (the trap when spiking against a proxying
provider: you end up timing Open-Meteo, not SignalK).
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

import httpx
import numpy as np
import pytest

from mivnav.features.weather.sources.signalk import (
    SignalKSource,
    discover,
    probe_times,
)

BASE = "http://sk.test"
T0 = datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc)
T1 = datetime(2026, 7, 29, 15, 0, tzinfo=timezone.utc)


def _entry(when: datetime, speed_ms: float, dir_rad: float) -> dict:
    return {
        "date": when.isoformat().replace("+00:00", "Z"),
        "wind": {"speedTrue": speed_ms, "directionTrue": dir_rad, "gust": speed_ms * 1.4},
        "outside": {"temperature": 288.15, "pressure": 101325},
    }


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=BASE)


def _source(handler, **kw) -> SignalKSource:
    return SignalKSource(
        provider_id="signalk-grib-weather-provider:gfs-0p25",
        provider_label="GFS 0.25",
        base_url=BASE,
        _client=_client(handler),
        **kw,
    )


@pytest.mark.anyio
async def test_one_sweep_yields_every_variable_at_every_time():
    """The finding that makes this viable at all.

    A point query returns the WHOLE series with every variable in each entry,
    so one lattice sweep is a cube — not one field. Sampling per
    (variable, time) instead would cost ~150x for identical data.
    """
    calls: list[tuple[float, float]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        lat = float(request.url.params["lat"])
        calls.append((lat, float(request.url.params["lon"])))
        return httpx.Response(
            200,
            json=[
                _entry(T0, 5.0 + lat, math.radians(90.0)),
                _entry(T1, 9.0 + lat, math.radians(180.0)),
            ],
        )

    src = _source(handler)
    cube = await src.sample_cube(bbox=(10.0, 54.0, 12.0, 56.0), lattice=8, concurrency=4)

    # ONE call per node, not per (node, variable, time).
    assert len(calls) == 64
    assert cube.times == (T0, T1)
    # 2 times x 4 variables = 8 fields from 64 calls.
    assert set(cube.values) == {"wind", "gusts", "pressure", "temperature"}

    wind = cube.field("wind", T0)
    assert wind is not None and wind.values.shape == (64,)
    assert not np.isnan(wind.values).any()
    assert wind.values[0] != wind.values[56]  # varies with latitude
    assert wind.directions is not None and np.allclose(wind.directions, 90.0)

    # The other time slice is a different field, from the same sweep.
    later = cube.field("wind", T1)
    assert later is not None
    assert float(later.values[0]) > float(wind.values[0])
    assert np.allclose(later.directions, 180.0)


@pytest.mark.anyio
async def test_si_is_converted_to_the_units_the_colour_scales_expect():
    """SignalK is strict SI; `colorscales.json` declares degC and hPa.

    Unconverted, 295 K on a -80..50 scale and 101606 Pa on a 940..1060 scale
    both CLAMP to the top of the ramp — a uniform, entirely plausible-looking
    wash rather than an obvious failure. That is why this is pinned.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[_entry(T0, 5.0, 0.0)])

    src = _source(handler)
    cube = await src.sample_cube(bbox=(10.0, 54.0, 11.0, 55.0), lattice=2)
    temp = cube.field("temperature", T0)
    pres = cube.field("pressure", T0)
    assert temp is not None and pres is not None
    assert float(temp.values[0]) == pytest.approx(15.0, abs=0.01)  # 288.15 K
    assert float(pres.values[0]) == pytest.approx(1013.25, abs=0.01)  # 101325 Pa
    # Wind is m/s on both sides — converting it would be the mirror-image bug.
    wind = cube.field("wind", T0)
    assert wind is not None and float(wind.values[0]) == pytest.approx(5.0)


@pytest.mark.anyio
async def test_a_slice_interpolates_like_any_other_decoded_field():
    """The payoff: it plugs into the shared renderer with no special-casing."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[_entry(T0, 10.0, 0.0)])

    src = _source(handler)
    cube = await src.sample_cube(bbox=(10.0, 54.0, 12.0, 56.0), lattice=4)
    field = cube.field("wind", T0)
    assert field is not None
    # `interpolate` is what render_wash_tile and the point endpoint both call.
    assert float(field.interpolate(55.0, 11.0)) == pytest.approx(10.0)


@pytest.mark.anyio
async def test_one_failed_node_becomes_a_hole_not_a_failed_sweep():
    def handler(request: httpx.Request) -> httpx.Response:
        if float(request.url.params["lat"]) > 55.5:
            return httpx.Response(500)
        return httpx.Response(200, json=[_entry(T0, 7.0, 0.0)])

    src = _source(handler)
    cube = await src.sample_cube(bbox=(10.0, 54.0, 12.0, 56.0), lattice=8)
    field = cube.field("wind", T0)
    assert field is not None
    # Losing nodes must not lose the sweep; the grid already handles NaN.
    assert np.isnan(field.values).any()
    assert not np.isnan(field.values).all()


@pytest.mark.anyio
async def test_an_absent_variable_is_none_rather_than_a_substitution():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[_entry(T0, 3.0, 0.0)])

    src = _source(handler, variables=("wind",))
    cube = await src.sample_cube(bbox=(10.0, 54.0, 11.0, 55.0), lattice=2)
    # Never a nearest-variable fallback: which quantity you are looking at must
    # be the one you asked for.
    assert cube.field("waves", T0) is None
    assert cube.field("wind", T0) is not None


@pytest.mark.anyio
async def test_discover_lists_registered_providers():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/_providers")
        return httpx.Response(
            200,
            json={
                "signalk-grib-weather-provider:gfs-0p25": {"name": "GFS 0.25", "isDefault": True},
                "openweather": {"name": "OpenWeather"},
            },
        )

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    class Patched(original):  # type: ignore[misc,valid-type]
        def __init__(self, *a, **kw):
            kw["transport"] = transport
            super().__init__(*a, **kw)

    httpx.AsyncClient = Patched  # type: ignore[misc]
    try:
        found = await discover(BASE)
    finally:
        httpx.AsyncClient = original  # type: ignore[misc]
    assert found == [
        ("openweather", "OpenWeather"),
        ("signalk-grib-weather-provider:gfs-0p25", "GFS 0.25"),
    ]


@pytest.mark.anyio
async def test_an_unreachable_server_yields_nothing_rather_than_a_guess():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no server")

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    class Patched(original):  # type: ignore[misc,valid-type]
        def __init__(self, *a, **kw):
            kw["transport"] = transport
            super().__init__(*a, **kw)

    httpx.AsyncClient = Patched  # type: ignore[misc]
    try:
        # No SignalK, no plugin, no weather — never a fabricated source, since a
        # row that cannot answer must not appear in a picker.
        assert await discover(BASE) == []
        assert await probe_times(BASE, "x", 55.0, 11.0) == ()
    finally:
        httpx.AsyncClient = original  # type: ignore[misc]


# ---------------------------------------------------------------------------
# decode: quantisation and single-flight
# ---------------------------------------------------------------------------
#
# What makes the id-addressed routes affordable for this backing. A sweep is
# ~1024 upstream calls; MapLibre fires a whole viewport at once, and a click
# fires another. Both of the properties below are the difference between one
# sweep and dozens.


def test_a_viewport_of_tiles_and_a_click_inside_it_share_one_sweep_box():
    """Every deep tile quantises to its CUBE_ZOOM ancestor, and a point inside
    that box quantises to the same tile — so a readout normally costs nothing
    beyond what the wash already paid."""
    from mivnav.features.weather.sources.base import DecodeRequest
    from mivnav.features.weather.sources.signalk import CUBE_ZOOM, _cube_tile, _tile_bbox

    z = CUBE_ZOOM + 3
    ancestor = None
    for dx in range(4):
        for dy in range(4):
            box = _cube_tile(DecodeRequest("wind", T0, tile=(z, 100 + dx, 60 + dy)))
            ancestor = ancestor or box
            assert box == ancestor

    west, south, east, north = _tile_bbox(*ancestor)
    inside = ((south + north) / 2, (west + east) / 2)
    assert _cube_tile(DecodeRequest("wind", T0, at=inside)) == ancestor


def test_a_tile_coarser_than_the_cube_zoom_stays_its_own_box():
    """Quantising UP would sample a box smaller than the tile being drawn and
    leave most of it blank."""
    from mivnav.features.weather.sources.base import DecodeRequest
    from mivnav.features.weather.sources.signalk import CUBE_ZOOM, _cube_tile

    assert _cube_tile(DecodeRequest("wind", T0, tile=(2, 1, 1))) == (2, 1, 1)
    assert _cube_tile(DecodeRequest("wind", T0, tile=(CUBE_ZOOM, 3, 3))) == (CUBE_ZOOM, 3, 3)


def test_the_world_s_last_column_does_not_come_back_inverted():
    """`tile2lon` wraps, so the east edge of the last column is +180, not -180
    — an inverted box would sample a lattice running backwards."""
    from mivnav.features.weather.sources.signalk import _tile_bbox

    west, _s, east, _n = _tile_bbox(2, 3, 1)
    assert west < east == 180.0


@pytest.mark.anyio
async def test_concurrent_tiles_of_one_box_trigger_exactly_one_sweep(monkeypatch):
    """Single-flight, the same property (and the same measured failure mode)
    `GridDecoder`/`GribDecoder` carry: without it, N concurrent tiles of one
    viewport each start their own ~8 s, 1024-call sweep of identical data."""
    import asyncio

    from mivnav.features.weather.sources import signalk as sk
    from mivnav.features.weather.sources.base import DecodeRequest

    monkeypatch.setattr(sk, "_CUBES", sk._CubeCache())
    sweeps = 0

    async def one_sweep(self, bbox, lattice=sk.DEFAULT_LATTICE, concurrency=8):
        nonlocal sweeps
        sweeps += 1
        await asyncio.sleep(0.01)  # long enough for the others to pile up
        from mivnav.features.weather.grid import GridFactory

        grid = GridFactory.create(
            {"type": "regular", "nx": 2, "ny": 2, "dx": 1.0, "dy": 1.0,
             "lonMin": bbox[0], "latMin": bbox[1]}
        )
        return sk.LatticeCube(
            times=(T0,),
            grid=grid,
            values={"wind": [np.full(4, 5.0)]},
            directions={"wind": [np.full(4, 90.0)]},
        )

    monkeypatch.setattr(sk.SignalKSource, "sample_cube", one_sweep)
    src = SignalKSource(provider_id="p", provider_label="P", base_url=BASE)
    z = sk.CUBE_ZOOM + 2
    fields = await asyncio.gather(
        *(
            src.decode(DecodeRequest("wind", T0, tile=(z, 40 + dx, 24 + dy)))
            for dx in range(4)
            for dy in range(4)
        )
    )
    assert sweeps == 1
    assert all(f.values[0] == 5.0 for f in fields)

    # And a later request for the same box is served from the cache.
    await src.decode(DecodeRequest("wind", T0, tile=(z, 40, 24)))
    assert sweeps == 1


@pytest.mark.anyio
async def test_a_variable_the_provider_does_not_serve_is_refused_not_substituted():
    from mivnav.features.weather.sources.base import DecodeRequest

    src = SignalKSource(provider_id="p", provider_label="P", base_url=BASE)
    with pytest.raises(KeyError):
        await src.decode(DecodeRequest("waves", T0, tile=(6, 1, 1)))


# ---------------------------------------------------------------------------
# coverage probing: cached, and filled in once a position is known
# ---------------------------------------------------------------------------
#
# `GET /weather/sources` learns a provider's forecast times by asking it about
# the boat's own position — the Weather API has no coverage call, so that is the
# only honest way. Two consequences the cache exists to handle: the first
# request fires before SignalK has connected (no position, so nothing to ask
# from), and every request after that would otherwise re-ask for an answer that
# only changes when a model run lands.


def _probing(counter: list[int], times=(T0, T1)):
    """A patched `httpx.AsyncClient` answering the point route, counting calls."""

    def handler(request: httpx.Request) -> httpx.Response:
        counter[0] += 1
        return httpx.Response(200, json=[_entry(t, 5.0, 0.0) for t in times])

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    class Patched(original):  # type: ignore[misc,valid-type]
        def __init__(self, *a, **kw):
            kw["transport"] = transport
            super().__init__(*a, **kw)

    return original, Patched


@pytest.mark.anyio
async def test_an_unknown_position_caches_nothing_so_a_known_one_probes():
    """THE property this cache exists for. At boot there is no position, so
    coverage is honestly empty — but nothing may be written, or the source would
    stay empty for a whole TTL after the fix arrives."""
    from mivnav.features.weather.sources import signalk as sk

    calls = [0]
    original, Patched = _probing(calls)
    cache = sk._ProbeCache()

    httpx.AsyncClient = Patched  # type: ignore[misc]
    try:
        assert await cache.get(BASE, "p", None) == ()
        assert calls[0] == 0  # nowhere to ask from — and no round trip wasted
        assert await cache.get(BASE, "p", (55.0, 11.0)) == (T0, T1)
        assert calls[0] == 1
    finally:
        httpx.AsyncClient = original  # type: ignore[misc]


@pytest.mark.anyio
async def test_a_probe_is_reused_rather_than_repeated_per_request():
    from mivnav.features.weather.sources import signalk as sk

    calls = [0]
    original, Patched = _probing(calls)
    cache = sk._ProbeCache()

    httpx.AsyncClient = Patched  # type: ignore[misc]
    try:
        for _ in range(5):
            assert await cache.get(BASE, "p", (55.0, 11.0)) == (T0, T1)
        assert calls[0] == 1
    finally:
        httpx.AsyncClient = original  # type: ignore[misc]


@pytest.mark.anyio
async def test_concurrent_listings_probe_a_provider_once():
    import asyncio

    from mivnav.features.weather.sources import signalk as sk

    calls = [0]
    original, Patched = _probing(calls)
    cache = sk._ProbeCache()

    httpx.AsyncClient = Patched  # type: ignore[misc]
    try:
        got = await asyncio.gather(*(cache.get(BASE, "p", (55.0, 11.0)) for _ in range(8)))
        assert calls[0] == 1
        assert all(g == (T0, T1) for g in got)
    finally:
        httpx.AsyncClient = original  # type: ignore[misc]


@pytest.mark.anyio
async def test_a_failed_probe_is_not_pinned_as_a_dead_source():
    """A server that was down when we asked must be re-asked, not remembered as
    empty for a TTL — the cache deliberately cannot tell "unreachable" from
    "this provider offers nothing", and re-asks in both cases."""
    from mivnav.features.weather.sources import signalk as sk

    up = [False]

    def handler(request: httpx.Request) -> httpx.Response:
        if not up[0]:
            raise httpx.ConnectError("no server")
        return httpx.Response(200, json=[_entry(T0, 5.0, 0.0)])

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    class Patched(original):  # type: ignore[misc,valid-type]
        def __init__(self, *a, **kw):
            kw["transport"] = transport
            super().__init__(*a, **kw)

    cache = sk._ProbeCache()
    httpx.AsyncClient = Patched  # type: ignore[misc]
    try:
        assert await cache.get(BASE, "p", (55.0, 11.0)) == ()
        up[0] = True
        assert await cache.get(BASE, "p", (55.0, 11.0)) == (T0,)
    finally:
        httpx.AsyncClient = original  # type: ignore[misc]


@pytest.mark.anyio
async def test_an_expired_probe_survives_a_position_that_went_away():
    """A stale answer beats an empty one: a picker that empties itself because
    the GPS blinked is worse than one a model run behind."""
    from mivnav.features.weather.sources import signalk as sk

    calls = [0]
    original, Patched = _probing(calls)
    cache = sk._ProbeCache(ttl=0.0)  # everything is immediately stale

    httpx.AsyncClient = Patched  # type: ignore[misc]
    try:
        assert await cache.get(BASE, "p", (55.0, 11.0)) == (T0, T1)
        # Expired AND no position to re-probe from: the last known times stand.
        assert await cache.get(BASE, "p", None) == (T0, T1)
        assert calls[0] == 1
    finally:
        httpx.AsyncClient = original  # type: ignore[misc]


@pytest.mark.anyio
async def test_the_probe_cache_is_bounded():
    from mivnav.features.weather.sources import signalk as sk

    calls = [0]
    original, Patched = _probing(calls)
    cache = sk._ProbeCache(max_entries=2)

    httpx.AsyncClient = Patched  # type: ignore[misc]
    try:
        for pid in ("a", "b", "c"):
            await cache.get(BASE, pid, (55.0, 11.0))
        assert len(cache._lru) == 2
    finally:
        httpx.AsyncClient = original  # type: ignore[misc]
