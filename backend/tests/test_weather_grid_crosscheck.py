# SPDX-License-Identifier: GPL-2.0-only
"""THE required numeric cross-check: decode one REAL
`.om` file both through this port (mivnav.features.weather.grid/render) and through
the real `@openmeteo/weather-map-layer` JS library (via a Node subprocess),
and compare interpolated values at several points, within float tolerance.

Deliberately network- and Node-dependent, so it self-SKIPS rather than
fails when either is unavailable (a restricted CI box, a workspace with no
sibling frontend checkout) — see test_weather_grid.py for the hermetic
(always-runs) unit tests that cover the same code paths against hand-derived
expected values instead. This file is the belt to that suspenders: it is
the one test that proves the port agrees with the ORIGINAL, not just with
itself.

Covers a RegularGrid domain (dwd_icon, global lat/lon) for a plain scalar
variable AND the wind u/v→speed/direction derivation, and a ProjectionGrid
(dmi_harmonie_arome_europe, Lambert conformal-conic) domain for the
speed/direction convention — the two grid TYPES and both wind CONVENTIONS
this app actually serves.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import httpx
import numpy as np
import pytest

from mivnav.features.weather import grid as G
from mivnav.features.weather.domains import grid_for_domain

# Excluded from the default `uv run pytest` / `just check` run (see addopts in
# pyproject.toml) — this file is live-network + Node-subprocess and its
# duration depends on Open-Meteo, not this repo. Run explicitly with
# `just check-crosscheck`.
pytestmark = pytest.mark.crosscheck

UPSTREAM = "https://openmeteo.s3.amazonaws.com"

# Points to sample: a mix of in-grid and (for the regional Lambert domain)
# out-of-grid, so the NaN-off-grid path is cross-checked too.
POINTS = [(55.0, 10.0), (56.5, 12.5), (40.0, -3.0), (10.0, 100.0), (-30.0, 150.0)]

# The real library lives in the FRONTEND's node_modules (run `bun install` there).
_REPO = Path(__file__).resolve().parents[2]
_CANDIDATE_LIBS = [
    _REPO / "frontend" / "node_modules" / "@openmeteo" / "weather-map-layer" / "dist" / "index.mjs",
]


def _find_js_lib() -> Path | None:
    for p in _CANDIDATE_LIBS:
        if p.is_file():
            return p
    return None


def _skip_unless_ready() -> Path:
    if shutil.which("node") is None:
        pytest.skip("node not available")
    lib = _find_js_lib()
    if lib is None:
        pytest.skip("no @openmeteo/weather-map-layer checkout reachable")
    try:
        r = httpx.get(f"{UPSTREAM}/data_spatial/dwd_icon/latest.json", timeout=10.0)
        r.raise_for_status()
    except httpx.HTTPError as e:
        pytest.skip(f"Open-Meteo unreachable: {e}")
    return lib


def _resolve_om_url(domain: str, hour_index: int = 0) -> str:
    r = httpx.get(f"{UPSTREAM}/data_spatial/{domain}/latest.json", timeout=15.0)
    r.raise_for_status()
    meta = r.json()
    ref = meta["reference_time"]
    valid = meta["valid_times"][hour_index]
    y, mo, d, run_h = ref[0:4], ref[5:7], ref[8:10], ref[11:13]
    vy, vmo, vd, vh, vmi = valid[0:4], valid[5:7], valid[8:10], valid[11:13], valid[14:16]
    return f"{UPSTREAM}/data_spatial/{domain}/{y}/{mo}/{d}/{run_h}00Z/{vy}-{vmo}-{vd}T{vh}{vmi}.om"


def _js_decode(lib: Path, url: str, variable: str, grid_json: str) -> list[dict]:
    """Run the real JS library in a Node subprocess: decode `variable` from
    `url` and interpolate at every POINT, returning [{lat,lon,value,direction}]."""
    script = f"""
import {{
  WeatherMapLayerFileReader, defaultFileReaderConfig, GridFactory, normalizeLon,
}} from {json.dumps(str(lib))};
const points = {json.dumps(POINTS)};
const reader = new WeatherMapLayerFileReader(defaultFileReaderConfig);
await reader.setToOmFile({json.dumps(url)});
const data = await reader.readVariable({json.dumps(variable)}, null);
const grid = GridFactory.create({grid_json}, null);
const out = [];
for (const [lat, lon] of points) {{
  const v = grid.getLinearInterpolatedValue(data.values, lat, normalizeLon(lon));
  const d = data.directions
    ? grid.getLinearInterpolatedValue(data.directions, lat, normalizeLon(lon))
    : null;
  out.push({{ lat, lon, value: Number.isFinite(v) ? v : null, direction: Number.isFinite(d) ? d : null }});
}}
reader.dispose();
console.log(JSON.stringify(out));
"""
    proc = subprocess.run(
        ["node", "--input-type=module"], input=script, capture_output=True, text=True, timeout=60
    )
    if proc.returncode != 0:
        pytest.fail(f"JS cross-check subprocess failed:\n{proc.stderr}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _py_decode_regular_or_projection(url: str, variable: str, domain: str) -> list[dict]:
    """Decode via THIS port's grid.py + a direct omfiles read (bypassing the
    HTTP loopback machinery — that plumbing is exercised separately by
    test_weather_render_routes.py; this test isolates the GRID MATH)."""
    import httpx as _httpx
    from omfiles import OmFileReader

    class _RangeFs:
        def __init__(self, client: _httpx.Client, u: str):
            self.client, self.u = client, u

        def size(self, path):
            r = self.client.head(self.u)
            r.raise_for_status()
            return int(r.headers["content-length"])

        def cat_file(self, path, start=None, end=None):
            headers = {}
            if start is not None or end is not None:
                s = start or 0
                e = str(end - 1) if end is not None else ""
                headers["Range"] = f"bytes={s}-{e}"
            r = self.client.get(self.u, headers=headers)
            r.raise_for_status()
            return r.content

    client = _httpx.Client(timeout=_httpx.Timeout(60.0, connect=15.0), follow_redirects=True)
    grid_def = grid_for_domain(domain)
    grid = G.GridFactory.create(grid_def, None)

    import re

    uv_pattern = re.compile(r"_[uv]_(?P<postfix>component|current)")
    m = uv_pattern.search(variable)

    def _read(var: str) -> np.ndarray:
        fs = _RangeFs(client, url)
        reader = OmFileReader.from_fsspec(fs, "dummy")
        arr = reader.get_child_by_name(var).read_array((...,))
        reader.close()
        return np.asarray(arr, dtype=np.float64).ravel()

    if m:
        postfix = m.group("postfix")
        u = _read(variable.replace(f"_v_{postfix}", f"_u_{postfix}"))
        v = _read(variable.replace(f"_u_{postfix}", f"_v_{postfix}"))
        values = np.sqrt(u * u + v * v)
        directions = (np.degrees(np.arctan2(u, v)) + 180) % 360
    elif "_speed_" in variable or "_direction_" in variable:
        speed_var = variable if "_speed_" in variable else variable.replace("_direction_", "_speed_")
        dir_var = variable if "_direction_" in variable else variable.replace("_speed_", "_direction_")
        values = _read(speed_var)
        directions = _read(dir_var)
    else:
        values = _read(variable)
        directions = None

    out = []
    for lat, lon in POINTS:
        lon_n = G.normalize_lon(lon)
        v = grid.get_linear_interpolated_value(values, lat, lon_n)
        d = grid.get_linear_interpolated_value(directions, lat, lon_n) if directions is not None else None
        out.append(
            {
                "lat": lat,
                "lon": lon,
                "value": None if (v is None or not np.isfinite(v)) else float(v),
                "direction": None if (d is None or not np.isfinite(d)) else float(d),
            }
        )
    return out


def test_regular_grid_temperature_matches_js(tmp_path):
    lib = _skip_unless_ready()
    url = _resolve_om_url("dwd_icon")
    grid_json = json.dumps(grid_for_domain("dwd_icon"))
    js = _js_decode(lib, url, "temperature_2m", grid_json)
    py = _py_decode_regular_or_projection(url, "temperature_2m", "dwd_icon")
    for j, p in zip(js, py):
        if j["value"] is None:
            assert p["value"] is None
        else:
            assert p["value"] == pytest.approx(j["value"], abs=1e-3)


def test_regular_grid_wind_uv_derivation_matches_js():
    lib = _skip_unless_ready()
    url = _resolve_om_url("dwd_icon")
    grid_json = json.dumps(grid_for_domain("dwd_icon"))
    js = _js_decode(lib, url, "wind_u_component_10m", grid_json)
    py = _py_decode_regular_or_projection(url, "wind_u_component_10m", "dwd_icon")
    for j, p in zip(js, py):
        if j["value"] is None:
            assert p["value"] is None
            continue
        assert p["value"] == pytest.approx(j["value"], abs=1e-3)
        assert p["direction"] == pytest.approx(j["direction"], abs=1e-2)


def test_lambert_projection_wind_speed_matches_js():
    lib = _skip_unless_ready()
    url = _resolve_om_url("dmi_harmonie_arome_europe")
    grid_json = json.dumps(grid_for_domain("dmi_harmonie_arome_europe"))
    js = _js_decode(lib, url, "wind_speed_10m", grid_json)
    py = _py_decode_regular_or_projection(url, "wind_speed_10m", "dmi_harmonie_arome_europe")
    # This domain is regional — several POINTS fall off-grid; both sides
    # must agree on WHICH ones (null) as well as the in-grid values.
    for j, p in zip(js, py):
        if j["value"] is None:
            assert p["value"] is None
        else:
            assert p["value"] == pytest.approx(j["value"], abs=1e-3)
