# SPDX-License-Identifier: GPL-2.0-only
"""The id-addressed tile/point routes — the DISPATCH contract, tested offline.

``test_weather_render_routes.py`` covers the same rasterisers end-to-end
against live Open-Meteo and skips when the link is down, so it proves nothing
about this on a dry box. What this task actually added is the dispatch: an
opaque source id resolved through the registry, a canonical variable, an
explicit valid time, and a 404 with a reason for every way a source can decline
to answer. All of that is exercisable with a fake source and no network, which
is the only way it stays covered on the boat.

The fake stands in for ``resolve_source``'s answer, not for the registry —
``test_weather_sources.py`` owns the config→implementation wiring. The one case
that deliberately goes through the REAL registry is the unknown id, since
"nothing was substituted" is only meaningful if nothing was consulted.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from mivnav.features.weather import routes as weather_routes
from mivnav.features.weather.grid import GridFactory
from mivnav.features.weather.render import DecodedField
from mivnav.features.weather.sources.base import WIND, Coverage, DecodeRequest, SourceInfo

TIME = "2026-07-29T12:00:00Z"
COVERED = datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc)


@dataclass
class FakeSource:
    """A source with one variable, one covered hour, and a grid of its own —
    everything above it is real."""

    id: str = "fake:one"
    calls: int = 0

    def describe(self) -> SourceInfo:
        return SourceInfo(
            id=self.id,
            label="Fake",
            badge="Fake",
            requires_network=False,
            variables=(WIND,),
            coverage=Coverage(local=(COVERED,)),
        )

    async def decode(self, req: DecodeRequest) -> DecodedField:
        if req.variable != WIND:
            raise KeyError(f"{self.id} serves ['wind'], not {req.variable!r}")
        if req.time != COVERED:
            raise KeyError(f"{self.id} does not cover {req.time.isoformat()}")
        self.calls += 1
        grid = GridFactory.create(
            {"type": "regular", "nx": 8, "ny": 8, "dx": 2.0, "dy": 2.0,
             "lonMin": 0.0, "latMin": 50.0}
        )
        n = 64
        return DecodedField(
            grid,
            np.full(n, 10.0, dtype=np.float64),
            np.full(n, 270.0, dtype=np.float64),
        )


@dataclass
class ScalarSource(FakeSource):
    """Same, but the field carries no direction — nothing to draw as vectors."""

    id: str = "fake:scalar"

    async def decode(self, req: DecodeRequest) -> DecodedField:
        field = await FakeSource.decode(self, req)
        return DecodedField(field.grid, field.values, None)


@pytest.fixture()
def client(tmp_path):
    """An isolated Runtime + TestClient with every cache pointed at tmp_path,
    same posture as `test_weather_render_routes.py`'s fixture (the shared
    session fixtures do NOT redirect the weather caches off the developer's
    real XDG dirs)."""
    from mivnav.api.app import app
    from mivnav.api.deps import Runtime, get_runtime
    from mivnav.config import ConfigStore, LayoutStore, ProfileStore
    from mivnav.features.route.store import RouteStore

    config = ConfigStore(tmp_path / "config.json")
    config.patch(
        {
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
            },
        }
    )
    runtime = Runtime(
        config,
        ProfileStore(tmp_path / "profiles.json"),
        RouteStore(),  # no route storage: nothing here touches routes
        LayoutStore(tmp_path / "layouts.json"),
    )
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


@pytest.fixture()
def served(monkeypatch):
    """Make one fake source the registry's answer for its own id, and nothing
    else's — so a wrong id still resolves to nothing."""

    def _serve(source):
        async def fake_resolve(config, mirror, source_id, proxy=None):
            return source if source_id == source.id else None

        monkeypatch.setattr(weather_routes, "resolve_source", fake_resolve)
        return source

    return _serve


def test_an_unknown_source_id_is_a_404_naming_the_discovery_route(client):
    """Through the REAL registry: a fresh boat has no sources, so this is the
    no-fallback case — nothing is substituted because nothing exists."""
    r = client.get(f"/weather/sources/om:nope/wash/wind/1/1/0.png?time={TIME}")
    assert r.status_code == 404
    assert "/weather/sources" in r.json()["detail"]


def test_wash_renders_a_png_for_a_covered_variable_and_time(client, served):
    src = served(FakeSource())
    r = client.get(f"/weather/sources/{src.id}/wash/wind/1/1/0.png?time={TIME}")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert src.calls == 1


def test_a_second_request_is_served_from_the_tile_cache_without_decoding(client, served):
    """The cache is consulted BEFORE the decode callable runs — which is the
    whole reason the renderer takes a callable rather than a field. A SignalK
    lattice sweep is ~8 s; paying it and then finding a cache hit would be the
    entire cost for nothing."""
    src = served(FakeSource())
    url = f"/weather/sources/{src.id}/wash/wind/1/1/0.png?time={TIME}"
    assert client.get(url).status_code == 200
    assert client.get(url).status_code == 200
    assert src.calls == 1


def test_an_etag_revalidates_to_304_before_any_work(client, served):
    src = served(FakeSource())
    url = f"/weather/sources/{src.id}/wash/wind/1/1/0.png?time={TIME}"
    etag = client.get(url).headers["etag"]
    r = client.get(url, headers={"If-None-Match": etag})
    assert r.status_code == 304


def test_a_variable_the_source_does_not_serve_is_a_404_with_the_reason(client, served):
    src = served(FakeSource())
    r = client.get(f"/weather/sources/{src.id}/wash/waves/1/1/0.png?time={TIME}")
    assert r.status_code == 404
    assert "waves" in r.json()["detail"]


def test_a_time_the_source_does_not_cover_is_a_404_with_the_reason(client, served):
    src = served(FakeSource())
    r = client.get(
        f"/weather/sources/{src.id}/wash/wind/1/1/0.png?time=2020-01-01T00:00:00Z"
    )
    assert r.status_code == 404
    assert "does not cover" in r.json()["detail"]


def test_an_unparseable_time_is_a_400_not_a_500(client, served):
    src = served(FakeSource())
    r = client.get(f"/weather/sources/{src.id}/wash/wind/1/1/0.png?time=soon")
    assert r.status_code == 400


def test_field_encodes_the_vector_texture_from_the_same_single_decode(client, served):
    """`decode() -> DecodedField` is sufficient for the particle texture too —
    u/v are derived from the one field (`render.uv_components`), not fetched
    through a second, backing-specific door."""
    src = served(FakeSource())
    r = client.get(f"/weather/sources/{src.id}/field/wind/1/1/0.png?time={TIME}")
    assert r.status_code == 200, r.text
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_field_404s_for_a_field_with_no_direction_rather_than_encoding_zeros(
    client, served
):
    src = served(ScalarSource())
    r = client.get(f"/weather/sources/{src.id}/field/wind/1/1/0.png?time={TIME}")
    assert r.status_code == 404
    assert "direction" in r.json()["detail"]


def test_point_reads_value_and_direction_at_a_position(client, served):
    src = served(FakeSource())
    r = client.get(
        f"/weather/sources/{src.id}/point?variable=wind&time={TIME}&lat=55&lon=5"
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["value"] == pytest.approx(10.0)
    assert body["direction"] == pytest.approx(270.0)
    assert r.headers["cache-control"] == "no-store"


def test_point_404s_for_an_uncovered_time(client, served):
    src = served(FakeSource())
    r = client.get(
        f"/weather/sources/{src.id}/point?variable=wind&time=2020-01-01T00:00:00Z"
        "&lat=55&lon=5"
    )
    assert r.status_code == 404


def test_an_out_of_range_tile_index_is_a_404(client, served):
    src = served(FakeSource())
    r = client.get(f"/weather/sources/{src.id}/wash/wind/1/9/9.png?time={TIME}")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# through the REAL registry, against a real baked GRIB product
# ---------------------------------------------------------------------------
#
# The fake above proves the dispatch contract; this proves the wiring behind
# it — config -> registry -> GribSource -> gribberish decode -> the shared
# rasteriser — with no network and no monkeypatching anywhere in the chain.

_GRIB_FIXTURES = Path(__file__).parent.parent / "data" / "grib"
_GRIB_U = _GRIB_FIXTURES / "icon-eu_europe_regular-lat-lon_single-level_2026072600_000_U_10M.grib2"
_GRIB_V = _GRIB_FIXTURES / "icon-eu_europe_regular-lat-lon_single-level_2026072600_000_V_10M.grib2"
_GRIB_TIME = "2026-07-26T00:00:00Z"


@pytest.fixture()
def grib_client(client, tmp_path):
    """`client`, plus one declared GRIB dataset with the ICON-EU fixture pair
    baked into the directory the registry will look in."""
    from mivnav.api.deps import get_runtime
    from mivnav.api.app import app

    runtime = app.dependency_overrides[get_runtime]()
    product = tmp_path / "data" / "weather" / "wx" / "grib" / "dwd_icon_eu"
    (product / "u_10m").mkdir(parents=True)
    (product / "v_10m").mkdir(parents=True)
    shutil.copy(_GRIB_U, product / "u_10m" / _GRIB_U.name)
    shutil.copy(_GRIB_V, product / "v_10m" / _GRIB_V.name)
    runtime.config.patch(
        {
            "datasets": [
                {
                    "id": "wx",
                    "provider": "weather",
                    "name": "GRIB",
                    "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
                }
            ]
        }
    )
    return client


def test_a_real_grib_bake_serves_a_wash_tile_by_source_id(grib_client):
    r = grib_client.get(
        f"/weather/sources/grib:wx:dwd_icon_eu/wash/wind/3/4/2.png?time={_GRIB_TIME}"
    )
    assert r.status_code == 200, r.text
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_a_real_grib_bake_serves_the_particle_field_by_source_id(grib_client):
    r = grib_client.get(
        f"/weather/sources/grib:wx:dwd_icon_eu/field/wind/3/4/2.png?time={_GRIB_TIME}"
    )
    assert r.status_code == 200, r.text
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_a_grib_source_declines_a_variable_it_cannot_carry(grib_client):
    """GRIB v1 is 10m wind by construction. Asking for temperature is a 404
    saying so, never the wind field relabelled."""
    r = grib_client.get(
        f"/weather/sources/grib:wx:dwd_icon_eu/wash/temperature/3/4/2.png?time={_GRIB_TIME}"
    )
    assert r.status_code == 404
    assert "temperature" in r.json()["detail"]


def test_a_grib_hour_that_was_never_baked_is_a_404_not_its_neighbour(grib_client):
    """`GribStore.resolve_uv` is an exact lookup, not a nearest search — the
    hour either was fetched or it was not."""
    r = grib_client.get(
        "/weather/sources/grib:wx:dwd_icon_eu/wash/wind/3/4/2.png"
        "?time=2026-07-26T03:00:00Z"
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# the LEGACY `?path=` routes still serve
# ---------------------------------------------------------------------------
#
# The promise this task makes to the currently-shipping frontend, and the one
# `test_weather_render_routes.py` cannot keep on a dry box (it skips without
# Open-Meteo). The GRIB half needs no network at all, and it exercises the
# whole rewiring: the `grib:` path parse, both decode partials, the shared
# rasteriser, and — via the ETag — that the cache identity is unchanged.

_LEGACY_PATH = "grib:wx/dwd_icon_eu/2026-07-26T00:00:00Z"


def test_the_legacy_path_addressed_wash_route_still_renders(grib_client):
    r = grib_client.get(
        f"/weather/tiles/wash/3/4/2.png?path={_LEGACY_PATH}&variable=wind_u_component_10m"
    )
    assert r.status_code == 200, r.text
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_the_legacy_wash_etag_is_still_keyed_on_the_path_not_a_source_id(grib_client):
    """A shipped client's cached tiles must survive this change: the identity
    fed to `cache_key` is the same `?path=` string it always was, so neither
    the on-disk render cache nor any browser's ETag is invalidated."""
    from mivnav.features.weather.routes import _tile_etag

    r = grib_client.get(
        f"/weather/tiles/wash/3/4/2.png?path={_LEGACY_PATH}&variable=wind_u_component_10m"
    )
    assert r.headers["etag"] == _tile_etag(
        "wash", _LEGACY_PATH, "wind_u_component_10m", False, 3, 4, 2
    )


def test_the_legacy_wind_texture_route_still_renders(grib_client):
    r = grib_client.get(
        f"/weather/tiles/wind/3/4/2.png?path={_LEGACY_PATH}&variable=wind_u_component_10m"
    )
    assert r.status_code == 200, r.text
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_the_legacy_point_route_still_reads(grib_client):
    r = grib_client.get(
        f"/weather/point?path={_LEGACY_PATH}&variable=wind_u_component_10m"
        "&lat=55&lon=10"
    )
    assert r.status_code == 200, r.text
    assert r.json()["value"] is not None


def test_an_unbaked_legacy_hour_is_still_a_404(grib_client):
    r = grib_client.get(
        "/weather/tiles/wash/3/4/2.png?path=grib:wx/dwd_icon_eu/2026-07-26T03:00:00Z"
        "&variable=wind_u_component_10m"
    )
    assert r.status_code == 404


def test_a_cache_hit_does_not_re_resolve_the_source_or_scan_the_disk(
    grib_client, monkeypatch
):
    """Resolving lives INSIDE the decode callable, so a cache hit skips it.

    Both halves of a miss cost real time on the boat: a SignalK lattice sweep
    is ~8 s, and resolving walks every dataset root for baked `.om` files — a
    scan whose own docstring says it is "not on the tile path". Ahead of the
    cache check that would be hundreds of stats per tile, per viewport, on the
    machine whose CPU is the documented constraint."""
    from mivnav.features.weather.mirror import WeatherMirror

    scans = 0
    real = WeatherMirror.baked_paths

    def counted(self):
        nonlocal scans
        scans += 1
        return real(self)

    monkeypatch.setattr(WeatherMirror, "baked_paths", counted)
    url = f"/weather/sources/grib:wx:dwd_icon_eu/wash/wind/3/4/2.png?time={_GRIB_TIME}"
    assert grib_client.get(url).status_code == 200
    assert scans == 1
    assert grib_client.get(url).status_code == 200
    assert scans == 1
