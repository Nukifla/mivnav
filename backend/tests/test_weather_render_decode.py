# SPDX-License-Identifier: GPL-2.0-only
"""``GridDecoder``/``GribDecoder``'s single-flight decode (qoltstzv) —
hermetic, no network, no real ``.om``/GRIB bytes: ``_read_raw_sync``/
``_read_sync`` are monkeypatched to a counting stand-in so these run
everywhere, unlike ``test_weather_render_routes.py``'s live-network route
tests.

Why this exists: a viewport's worth of wash/wind tiles decode the SAME
(om_path, variable) concurrently on the FIRST paint of a new forecast —
weather-on, a model switch, a slider step onto an hour never rendered
before. MapLibre fires all of those tile requests near-simultaneously, and
before this fix every one of them missed the (still-empty) LRU and ran its
own full decode — measured at 20 concurrent `decode_field` calls driving 20
calls to the sync decode instead of 1, exactly the CPU-pegging shape the
`WeatherProxy._evict()` fix (zltoqomm) addressed at the network layer this
session. This fixes it at the decode layer.

No `pytest-asyncio` in this tree (see `test_weather_proxy.py`) — each test is
a plain `def` that drives its own coroutine through `asyncio.run`."""

from __future__ import annotations

import asyncio
import time

import numpy as np
import pytest

from mivnav.features.weather.grib_render import GribDecoder
from mivnav.features.weather.render import GridDecoder


def test_concurrent_decode_field_calls_share_one_sync_decode(monkeypatch):
    decoder = GridDecoder()
    calls = 0

    def fake_sync(proxy, loop, om_path, raw_variable):
        nonlocal calls
        calls += 1
        time.sleep(0.02)
        return np.zeros(4)

    monkeypatch.setattr(decoder, "_read_raw_sync", fake_sync)

    async def go():
        return await asyncio.gather(
            *[
                decoder.decode_field(None, None, "dwd_icon/x.om", "temperature_2m")
                for _ in range(10)
            ]
        )

    results = asyncio.run(go())
    assert calls == 1
    for r in results:
        assert np.array_equal(r.values, np.zeros(4))


def test_a_cancelled_caller_does_not_cancel_the_shared_decode(monkeypatch):
    decoder = GridDecoder()
    calls = 0

    def fake_sync(proxy, loop, om_path, raw_variable):
        nonlocal calls
        calls += 1
        time.sleep(0.05)
        return np.ones(3)

    monkeypatch.setattr(decoder, "_read_raw_sync", fake_sync)

    async def go():
        t1 = asyncio.ensure_future(
            decoder.decode_field(None, None, "dwd_icon/x.om", "temperature_2m")
        )
        t2 = asyncio.ensure_future(
            decoder.decode_field(None, None, "dwd_icon/x.om", "temperature_2m")
        )
        await asyncio.sleep(0.01)  # both land inside the same in-flight decode
        t1.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t1
        return await t2

    result = asyncio.run(go())
    assert np.array_equal(result.values, np.ones(3))
    assert calls == 1


def test_a_failed_decode_is_reported_to_every_concurrent_waiter(monkeypatch):
    decoder = GridDecoder()

    def fake_sync(proxy, loop, om_path, raw_variable):
        raise KeyError("variable not found")

    monkeypatch.setattr(decoder, "_read_raw_sync", fake_sync)

    async def go():
        return await asyncio.gather(
            *[
                decoder.decode_field(None, None, "dwd_icon/x.om", "temperature_2m")
                for _ in range(3)
            ],
            return_exceptions=True,
        )

    results = asyncio.run(go())
    assert all(isinstance(r, KeyError) for r in results)
    # The failure must not be stuck in `_inflight` forever — a later call
    # gets a fresh attempt, not a permanently-wedged decode.
    assert decoder._inflight == {}


def test_grib_decoder_read_also_shares_one_sync_decode(monkeypatch, tmp_path):
    decoder = GribDecoder()
    calls = 0

    def fake_sync(path):
        nonlocal calls
        calls += 1
        time.sleep(0.02)
        return np.zeros(4)

    monkeypatch.setattr(decoder, "_read_sync", fake_sync)

    path = tmp_path / "u.grib2"

    async def go():
        return await asyncio.gather(*[decoder._read(path) for _ in range(10)])

    results = asyncio.run(go())
    assert calls == 1
    for r in results:
        assert np.array_equal(r, np.zeros(4))
