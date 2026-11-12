# SPDX-License-Identifier: GPL-2.0-only
"""End-to-end smoke test for the new tile/point ROUTES — the piece none
of the other weather tests exercise: a real HTTP request through
``TestClient`` → the route handler → ``WeatherRenderer`` →
``LoopbackOmSource`` → directly into the same ``WeatherProxy`` instance's
``om_range``/``head_om``/``passthrough_tiles`` → ``WeatherProxy``'s chunk
cache → (on a cache miss) a live fetch from Open-Meteo → ``omfiles`` decode →
the ported grid/colour-scale math → a PNG.

This is the highest-risk NEW code in the port (the sync-callback → worker
thread → ``run_coroutine_threadsafe`` bridge — see
``mivnav.features.weather.omsource``'s module docstring) — everything else here is
covered by narrower unit tests, but that bridge only proves itself under a
real running event loop, which is exactly what ``TestClient`` gives it.
Requires live network (Open-Meteo); skips cleanly if unreachable, same
posture as the JS cross-check.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

UPSTREAM = "https://openmeteo.s3.amazonaws.com"


def _skip_if_unreachable() -> None:
    try:
        r = httpx.get(f"{UPSTREAM}/data_spatial/dwd_icon/latest.json", timeout=10.0)
        r.raise_for_status()
    except httpx.HTTPError as e:
        pytest.skip(f"Open-Meteo unreachable: {e}")


@pytest.fixture(scope="module")
def om_path() -> str:
    """A real, currently-valid concrete `.om` path for `dwd_icon` (a plain
    RegularGrid domain — the simplest case) — resolved from the live
    `latest.json`, mirroring exactly what the frontend's capture-URL
    resolution does."""
    _skip_if_unreachable()
    r = httpx.get(f"{UPSTREAM}/data_spatial/dwd_icon/latest.json", timeout=15.0)
    r.raise_for_status()
    meta = r.json()
    ref = meta["reference_time"]  # "2026-07-24T12:00:00Z"
    valid = meta["valid_times"][0]  # "2026-07-24T12:00Z"
    y, mo, d = ref[0:4], ref[5:7], ref[8:10]
    run_h = ref[11:13]
    vy, vmo, vd, vh, vmi = valid[0:4], valid[5:7], valid[8:10], valid[11:13], valid[14:16]
    return f"dwd_icon/{y}/{mo}/{d}/{run_h}00Z/{vy}-{vmo}-{vd}T{vh}{vmi}.om"


@pytest.fixture()
def weather_client(tmp_path):
    """An isolated Runtime + TestClient — deliberately NOT the shared
    session `client`/`isolated_runtime` fixtures (conftest.py), which do not
    redirect `weather.cache_dir`/`render_cache_dir` off the developer's real
    XDG cache (no existing test needed to before this one, since
    test_weather_proxy.py builds a bare `WeatherProxy` directly rather than
    going through the app). Points `weather.*cache_dir` at `tmp_path` so this
    test can never read/write the real machine's weather cache."""
    from mivnav.api.app import app
    from mivnav.api.deps import Runtime, get_runtime
    from mivnav.config import ConfigStore, LayoutStore, ProfileStore
    from mivnav.features.route.store import RouteStore

    config = ConfigStore(tmp_path / "config.json")
    config.patch(
        {
            # M-DATA-3: one shared data_root replaces charts.dir/ocharts.sets_dir.
            "data_root": str(tmp_path / "data"),
            "ocharts": {
                "daemon_dir": str(tmp_path / "ocharts" / "daemon"),
                "work_dir": str(tmp_path / "ocharts" / "work"),
                # The app's startup builds the o-charts service; its disk
                # cache defaults to the developer's real ~/.cache.
                "tile_disk_dir": str(tmp_path / "ocharts" / "tiles"),
                "tile_disk_budget_bytes": 0,
            },
            "signalk": {"enabled": False},
            "weather": {
                "cache_dir": str(tmp_path / "weather"),
                "render_cache_dir": str(tmp_path / "weather-render"),
                # #qtwquuww: every route below now 404s a domain the boat has
                # not allow-listed for live fetch. dwd_icon is the one this
                # whole suite exercises against the real upstream.
                "on_demand_domains": ["dwd_icon"],
            },
        }
    )
    runtime = Runtime(
        config,
        ProfileStore(tmp_path / "profiles.json"),
        RouteStore(),  # no route storage: nothing here touches routes
        LayoutStore(tmp_path / "layouts.json"),
    )
    # Restore whatever override was there before (the session `client`
    # fixture's own, set by conftest.py's autouse `isolated_runtime`) rather
    # than popping unconditionally — an unconditional pop strands every
    # later test with no get_runtime override at all (same bug class as
    # vyvqpxmn; see test_datasets_api.py's `dc` fixture).
    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: runtime
    try:
        with TestClient(app) as c:
            yield c
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_runtime, None)
        else:
            app.dependency_overrides[get_runtime] = previous
        runtime.close()


def test_wash_tile_renders_a_real_png_and_304s_on_revalidation(weather_client, om_path):
    url = f"/weather/tiles/wash/1/1/0.png?path={om_path}&variable=temperature_2m&dark=false"
    r = weather_client.get(url)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert "immutable" in r.headers["cache-control"]
    etag = r.headers["etag"]

    # Same identity, carrying the ETag → 304 before any render/decode work.
    r2 = weather_client.get(url, headers={"if-none-match": etag})
    assert r2.status_code == 304
    assert r2.content == b""

    # Cache hit on the second real GET (no if-none-match) — same bytes,
    # served from mivnav.features.weather.tilecache instead of re-rendered.
    r3 = weather_client.get(url)
    assert r3.status_code == 200
    assert r3.content == r.content


def test_wash_tile_404s_for_an_out_of_range_tile_index(weather_client, om_path):
    r = weather_client.get(
        f"/weather/tiles/wash/1/9/9.png?path={om_path}&variable=temperature_2m"
    )
    assert r.status_code == 404


def test_wind_tile_renders_a_real_wind_texture_png(weather_client, om_path):
    r = weather_client.get(
        f"/weather/tiles/wind/1/1/0.png?path={om_path}&variable=wind_u_component_10m"
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_point_returns_a_real_value(weather_client, om_path):
    # NOTE: no pinned golden value here — `om_path` resolves to whatever
    # forecast hour is currently live, which moves with real time, so a
    # hardcoded expected temperature would be flaky by design. EXACT
    # numeric correctness against the real JS library is what
    # test_weather_grid_crosscheck.py is for (it captures both sides at the
    # SAME moment, so it never drifts); this route test only proves the
    # value survives the whole route/cache/JSON round trip as a plausible
    # float.
    r = weather_client.get(
        f"/weather/point?path={om_path}&variable=temperature_2m&lat=55.0&lon=10.0"
    )
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert isinstance(body["value"], float)
    assert -60 < body["value"] < 60  # a plausible 2m temperature, °C
    assert body["direction"] is None  # temperature carries no direction


def test_point_wind_returns_value_and_direction(weather_client, om_path):
    r = weather_client.get(
        f"/weather/point?path={om_path}&variable=wind_u_component_10m&lat=55.0&lon=10.0"
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body["value"], float)
    assert 0 <= body["value"] < 100  # a plausible 10m wind speed, m/s
    assert 0 <= body["direction"] < 360


def test_unknown_variable_is_a_404_not_a_500(weather_client, om_path):
    r = weather_client.get(
        f"/weather/tiles/wash/1/1/0.png?path={om_path}&variable=not_a_real_variable"
    )
    assert r.status_code == 404
