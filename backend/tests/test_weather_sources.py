# SPDX-License-Identifier: GPL-2.0-only
"""The weather SOURCE model (zsukvvxq; ``docs/weather-sources-design.md``) —
discovery, and the containment rule the whole design rests on.

The containment test is the important one: it is what stops GRIB and Open-Meteo
specifics leaking back out across the codebase the way they had, one reasonable
local decision at a time, until the frontend's own core settings module knew
what a ``grib:`` prefix was.
"""

from __future__ import annotations

import ast
import json
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import get_runtime
from mivnav.features.weather.mirror import WeatherMirror
from mivnav.features.weather.sources import find_source, list_sources
from tests.conftest import isolated_runtime_at

_WEATHER = Path(__file__).resolve().parents[1] / "mivnav" / "features" / "weather"


@pytest.fixture
def runtime(tmp_path: Path):
    rt = isolated_runtime_at(tmp_path)
    yield rt
    rt.close()


@pytest.fixture
def dc(runtime):
    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: runtime
    with TestClient(app) as c:
        yield c
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous


def _sources(runtime):
    cfg = runtime.config.get()
    return [s.describe() for s in list_sources(cfg, WeatherMirror([]))]


# ---------------------------------------------------------------------------
# containment — the architectural guard
# ---------------------------------------------------------------------------


def _imported_modules(path: Path) -> set[str]:
    """Every module name `path` actually imports, by AST — not by substring.

    Prose is not a dependency: `base.py` explains the containment rule and so
    NAMES the implementations, which a grep-based check would call a violation.
    What matters is whether the module is wired to them.
    """
    tree = ast.parse(path.read_text())
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            # level>0 is a relative import; record the bare module either way.
            out.add(node.module or "")
            out.update(f"{node.module or ''}.{a.name}" for a in node.names)
    return out


def test_only_the_registry_imports_an_implementation():
    """`grib.py`/`openmeteo.py` are imported from exactly one place.

    If this fails, someone has reached past the contract — which is how the old
    model decayed: `models.py`, `renderer.py`, `routes.py` and `runtime.py` all
    grew their own GRIB branch, and `mivnav/feature.py` ended up with an
    ``"om-or-grib"`` artifact literal in CORE vocabulary (retired by jt
    rsmpwtmw, which is what this test exists to keep from coming back).
    """
    offenders: list[str] = []
    for path in _WEATHER.rglob("*.py"):
        # The registry is the one legitimate importer.
        if path == _WEATHER / "sources" / "__init__.py":
            continue
        for mod in _imported_modules(path):
            if mod.endswith("grib") or mod.endswith("openmeteo") or ".grib." in mod:
                # `gribstore`/`gribingest`/`grib_render` are the LOW-level
                # decoders `sources/grib.py` itself wraps; only the source
                # module is restricted.
                if mod.split(".")[-1] in {"grib", "openmeteo"}:
                    offenders.append(f"{path.relative_to(_WEATHER)} -> {mod}")
    assert offenders == [], offenders


def test_the_contract_module_imports_no_implementation():
    """`base.py` defines the type contract and must stay wired to no backing.
    It may (and does) NAME them in prose — that is documentation of the rule,
    not a dependency on it."""
    imported = _imported_modules(_WEATHER / "sources" / "base.py")
    assert not any(m.split(".")[-1] in {"grib", "openmeteo"} for m in imported), imported


# ---------------------------------------------------------------------------
# discovery
# ---------------------------------------------------------------------------


def _set(runtime, datasets, on_demand=()):
    runtime.patch_config({"datasets": datasets, "weather": {"on_demand_domains": list(on_demand)}})


def test_a_grib_dataset_becomes_an_offline_wind_source(runtime):
    _set(
        runtime,
        [
            {
                "id": "wx",
                "provider": "weather",
                "name": "GRIB",
                "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
            }
        ],
    )
    (info,) = _sources(runtime)
    assert info.label == "DWD ICON EU"
    # A GRIB bake answers with the link down — the field an offline/metered
    # toggle filters on, and the reason it is machine-readable while `badge`
    # (for humans) deliberately is not.
    assert info.requires_network is False
    assert info.variables == ("wind",)
    # Nothing baked in this tmp dir, so it honestly reports no coverage rather
    # than claiming a span it cannot serve.
    assert info.coverage.local == ()
    assert info.coverage.remote == ()


def test_an_on_demand_domain_becomes_a_network_source(runtime):
    _set(runtime, [], on_demand=["ncep_gfs025"])
    (info,) = _sources(runtime)
    assert info.requires_network is True
    assert "wind" in info.variables and "gusts" in info.variables


def test_a_wave_domain_offers_waves_and_not_wind(runtime):
    # The capability table moved out of the frontend; a wave model genuinely
    # carries no 10m wind, and saying so is what lets the picker stop guessing.
    _set(runtime, [], on_demand=["dwd_ewam"])
    (info,) = _sources(runtime)
    assert info.variables == ("waves",)


def test_a_domain_this_app_cannot_draw_reports_no_variables(runtime):
    # EMPTY is a real answer: an air-quality product is valid upstream and
    # unusable here, and a sailor deserves to know BEFORE spending disk.
    _set(runtime, [], on_demand=["cams_global"])
    (info,) = _sources(runtime)
    assert info.variables == ()


def test_a_disabled_dataset_contributes_nothing(runtime):
    _set(
        runtime,
        [
            {
                "id": "wx",
                "provider": "weather",
                "name": "GRIB",
                "enabled": False,
                "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
            }
        ],
    )
    # Offering it would produce a row whose every tile 404s.
    assert _sources(runtime) == []


def test_a_legacy_singular_domain_key_still_resolves(runtime):
    # `params` is opaque and never rewritten on disk, so the pre-rename spelling
    # is a permanent read path — reading only one spelling broke discovery once.
    _set(runtime, [], on_demand=[])
    _set(
        runtime,
        [{"id": "wx", "provider": "weather", "name": "GRIB",
          "params": {"source": "grib", "domain": "dwd_icon_eu"}}],
    )
    (info,) = _sources(runtime)
    assert info.label == "DWD ICON EU"


def test_the_implementation_field_selects_the_grib_backing(runtime):
    """jt rsmpwtmw: the choice moved out of `params.source` onto the core
    `DatasetConfig.implementation` field. A dataset declared the new way — no
    `source` in params at all — must resolve to the same GRIB source."""
    _set(
        runtime,
        [{"id": "wx", "provider": "weather", "name": "GRIB",
          "implementation": "grib", "params": {"domains": ["dwd_icon_eu"]}}],
    )
    (info,) = _sources(runtime)
    assert info.label == "DWD ICON EU"
    assert info.variables == ("wind",)


def test_the_retired_params_source_spelling_still_selects_grib(runtime):
    """The other half, permanently: `params` is never rewritten on disk, so
    every dataset declared between jt mzyvvmux and jt rsmpwtmw says `source`
    and always will. Reading only the new spelling would turn every one of
    them into an Open-Meteo source overnight — a boat's baked GRIB files
    silently unreachable."""
    _set(
        runtime,
        [{"id": "wx", "provider": "weather", "name": "GRIB",
          "params": {"source": "grib", "domains": ["dwd_icon_eu"]}}],
    )
    (info,) = _sources(runtime)
    assert info.variables == ("wind",)


def test_an_unknown_id_resolves_to_nothing_rather_than_a_default(runtime):
    """No fallback, ever: which dataset answered must be the one asked for."""
    _set(runtime, [], on_demand=["ncep_gfs025"])
    assert find_source(runtime.config.get(), WeatherMirror([]), "om:not_a_domain") is None
    assert find_source(runtime.config.get(), WeatherMirror([]), "") is None


# ---------------------------------------------------------------------------
# the route
# ---------------------------------------------------------------------------


def test_sources_route_shape(runtime, dc):
    _set(runtime, [], on_demand=["ncep_gfs025"])
    res = dc.get("/weather/sources")
    assert res.status_code == 200, res.text
    # Never cached: coverage changes the moment a bake lands or prunes.
    assert res.headers["cache-control"] == "no-store"
    (row,) = res.json()["sources"]
    assert set(row) == {
        "id", "label", "badge", "requires_network", "variables", "coverage", "region"
    }
    assert set(row["coverage"]) == {"local", "remote", "reference_time"}


# ---------------------------------------------------------------------------
# SignalK sources in the registry
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_signalk_sources_are_skipped_when_signalk_is_disabled(runtime):
    from mivnav.features.weather.sources import list_signalk_sources

    runtime.patch_config({"signalk": {"enabled": False}})
    # No round trip at all — a disabled SignalK must not make discovery wait on
    # a connect timeout.
    assert await list_signalk_sources(runtime.config.get(), (55.0, 11.0)) == []


@pytest.mark.anyio
async def test_a_dead_signalk_contributes_nothing_rather_than_failing_the_list(runtime):
    from mivnav.features.weather.mirror import WeatherMirror
    from mivnav.features.weather.sources import list_all_sources

    # Nothing listens on port 1; `discover` swallows it and returns [].
    runtime.patch_config({"signalk": {"enabled": True, "host": "127.0.0.1", "port": 1}})
    srcs = await list_all_sources(runtime.config.get(), WeatherMirror([]), (55.0, 11.0))
    assert all(not s.id.startswith("signalk:") for s in srcs)


@pytest.mark.anyio
async def test_coverage_fills_in_once_a_position_is_known(runtime, monkeypatch):
    """Discovery runs before SignalK has connected, so the first listing has no
    position to probe coverage from and honestly reports none. Nothing may be
    cached from that, or the source would keep reporting none for a whole TTL
    after the fix lands — this is the boot symptom the probe cache exists for."""
    import mivnav.features.weather.sources as registry
    from mivnav.features.weather.sources import list_signalk_sources
    from mivnav.features.weather.sources import signalk as sk

    runtime.patch_config({"signalk": {"enabled": True, "host": "sk.test", "port": 3000}})
    monkeypatch.setattr(sk, "_PROBES", sk._ProbeCache())

    async def fake_discover(base_url):
        return [("gfs", "GFS")]

    probes: list[tuple[str, float, float]] = []
    when = datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc)

    async def fake_probe(base_url, provider_id, lat, lon):
        probes.append((provider_id, lat, lon))
        return (when,)

    monkeypatch.setattr(registry, "discover", fake_discover)
    monkeypatch.setattr(sk, "probe_times", fake_probe)

    # Boot: no position. Empty coverage, and no probe attempted at all.
    (src,) = await list_signalk_sources(runtime.config.get(), None)
    assert src.describe().coverage.remote == ()
    assert probes == []

    # A fix arrives — the very next listing probes, and reports real times.
    (src,) = await list_signalk_sources(runtime.config.get(), (55.0, 11.0))
    assert src.describe().coverage.remote == (when,)
    assert probes == [("gfs", 55.0, 11.0)]

    # And is not re-probed per request thereafter, nor when the boat moves: a
    # provider's coverage is a fact about the provider, not about where we asked.
    (src,) = await list_signalk_sources(runtime.config.get(), (55.1, 11.1))
    assert src.describe().coverage.remote == (when,)
    assert len(probes) == 1


# ---------------------------------------------------------------------------
# decode: variables and path resolution
# ---------------------------------------------------------------------------


def test_a_canonical_variable_maps_to_the_domain_s_own_upstream_name():
    """The client used to curate this (`windVariable`/`SPEED_DIR_MODELS`); it
    is a fact about an Open-Meteo product, so it lives with the backing."""
    from mivnav.features.weather.sources.openmeteo import upstream_variable

    assert upstream_variable("dwd_icon", "wind") == "wind_u_component_10m"
    # Domains that store speed/direction and carry no u/v at all.
    assert upstream_variable("knmi_harmonie_arome_europe", "wind") == "wind_speed_10m"
    assert upstream_variable("metno_nordic_pp", "wind") == "wind_speed_10m"
    assert upstream_variable("ukmo_global_deterministic_10km", "wind") == "wind_speed_10m"
    assert upstream_variable("dwd_icon", "temperature") == "temperature_2m"
    assert upstream_variable("dwd_ewam", "waves") == "wave_height"


def test_the_manifest_s_own_variables_decide_the_wind_convention():
    """The static table is only a fallback: what the run's `latest.json` says
    it publishes wins, so a domain the table has wrong still draws."""
    from mivnav.features.weather.sources.openmeteo import upstream_variable

    speed_dir = frozenset({"wind_speed_10m", "wind_direction_10m", "pressure_msl"})
    uv = frozenset({"wind_u_component_10m", "wind_v_component_10m"})
    assert upstream_variable("dwd_icon", "wind", speed_dir) == "wind_speed_10m"
    assert upstream_variable("metno_nordic_pp", "wind", uv) == "wind_u_component_10m"
    # A manifest naming neither (or none known) falls back to the table.
    assert upstream_variable("metno_nordic_pp", "wind", frozenset()) == "wind_speed_10m"
    assert upstream_variable("dwd_icon", "wind", None) == "wind_u_component_10m"


def test_a_variable_the_domain_cannot_draw_is_refused_not_guessed():
    from mivnav.features.weather.sources.openmeteo import upstream_variable

    with pytest.raises(KeyError):
        upstream_variable("dwd_ewam", "wind")  # a wave model has no 10m wind
    with pytest.raises(KeyError):
        upstream_variable("cams_global", "temperature")  # composition, no wash


def _bake(root, domain, run, valid):
    """One baked `.om`, under the run directory the ingest actually writes."""
    p = root / "data_spatial" / domain / run / f"{valid}.om"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"om")
    return p


@pytest.mark.anyio
async def test_a_baked_hour_resolves_to_the_path_on_disk_not_a_recomputed_one(
    runtime, tmp_path
):
    """The regression this scan exists to prevent: a baked file sits under the
    run directory that was current WHEN IT WAS BAKED. Rebuilding the path from
    today's `latest.json` reference time names a file the mirror does not have,
    and the lookup silently falls through to the network — offline stops
    working with nothing in the logs."""
    from mivnav.features.weather.sources.openmeteo import OpenMeteoSource

    root = tmp_path / "bake"
    _bake(root, "dwd_icon", "2026/07/24/0600Z", "2026-07-24T1500")
    _set(runtime, [], on_demand=["dwd_icon"])
    (src,) = [
        s
        for s in list_sources(runtime.config.get(), WeatherMirror([root]))
        if s.id == "om:dwd_icon"
    ]
    assert isinstance(src, OpenMeteoSource)
    path = await src._resolve_path(datetime(2026, 7, 24, 15, 0, tzinfo=timezone.utc))
    assert path == "dwd_icon/2026/07/24/0600Z/2026-07-24T1500.om"


@pytest.mark.anyio
async def test_an_unbaked_hour_on_a_domain_that_may_not_be_fetched_is_refused(
    runtime, tmp_path
):
    """The id-addressed surface's half of #qtwquuww: a domain that is neither a
    declared bake target nor on-demand-allowed must not reach Open-Meteo, the
    same promise `_require_allowed_domain` keeps on the `?path=` routes. The
    domain only appears at all because its files are on disk, so the bake is
    all it will ever answer for."""
    root = tmp_path / "bake"
    _bake(root, "dwd_icon", "2026/07/24/0600Z", "2026-07-24T1500")
    _set(runtime, [])
    (src,) = [
        s
        for s in list_sources(runtime.config.get(), WeatherMirror([root]))
        if s.id == "om:dwd_icon"
    ]
    with pytest.raises(KeyError, match="may not be fetched live"):
        await src._resolve_path(datetime(2026, 7, 25, 9, 0, tzinfo=timezone.utc))


# ---------------------------------------------------------------------------
# remote coverage — remembered from the manifest the decode already fetched
# ---------------------------------------------------------------------------


class _FakeProxy:
    """Answers `latest.json` and counts how often it was asked."""

    def __init__(self, manifest: dict):
        self.manifest = manifest
        self.calls = 0

    async def passthrough_tiles(self, path, query):  # noqa: ARG002
        self.calls += 1
        return 200, json.dumps(self.manifest).encode(), "application/json"


_MANIFEST = {
    "reference_time": "2026-07-29T06:00:00Z",
    "valid_times": ["2026-07-29T12:00:00Z", "2026-07-29T15:00:00Z"],
}


@pytest.fixture
def clean_manifests(monkeypatch):
    """The manifest memory is process-wide (a source is rebuilt per request), so
    a test that fills it would otherwise be seen by the next one."""
    from mivnav.features.weather.sources import openmeteo as om

    monkeypatch.setattr(om, "_MANIFEST_CACHE", {})
    return om


@pytest.mark.anyio
async def test_a_live_domain_reports_no_remote_until_something_has_decoded(
    runtime, clean_manifests
):
    """Discovery must not make a network call, so an untouched live domain
    honestly reports nothing beyond local — `Coverage`'s own "unknown and none
    read the same" rule. This is the state qmnwrupv shipped, and it is still
    correct; what changes is that it no longer LASTS."""
    _set(runtime, [], on_demand=["dwd_icon"])
    (src,) = [
        s for s in list_sources(runtime.config.get(), WeatherMirror([])) if s.id == "om:dwd_icon"
    ]
    assert src.describe().coverage.remote == ()


@pytest.mark.anyio
async def test_decoding_one_hour_teaches_discovery_the_whole_run(
    runtime, tmp_path, clean_manifests
):
    """The fix for the missing ruler hatch (#ztluuonl). Resolving ONE valid time
    fetches the capture manifest, which states the whole run — so `describe()`
    can report the run's extent with no request of its own, and no second fetch
    from the client. The manifest names the paths; remembering it is free."""
    root = tmp_path / "bake"
    _bake(root, "dwd_icon", "2026/07/29/0600Z", "2026-07-29T1200")
    _set(runtime, [], on_demand=["dwd_icon"])

    def source():
        (s,) = [
            s
            for s in list_sources(runtime.config.get(), WeatherMirror([root]))
            if s.id == "om:dwd_icon"
        ]
        return s

    assert source().describe().coverage.remote == ()

    proxy = _FakeProxy(_MANIFEST)
    src = replace(source(), proxy=proxy)
    await src._resolve_path(datetime(2026, 7, 29, 15, 0, tzinfo=timezone.utc))

    cov = source().describe().coverage
    # The baked hour stays LOCAL and is not repeated as remote: the split is by
    # what answering costs, and a baked hour costs nothing either way.
    assert cov.local == (datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc),)
    assert cov.remote == (datetime(2026, 7, 29, 15, 0, tzinfo=timezone.utc),)
    # The run's own reference time, not the first baked valid time.
    assert cov.reference_time == datetime(2026, 7, 29, 6, 0, tzinfo=timezone.utc)
    # Discovery itself never asked upstream anything.
    assert proxy.calls == 1


@pytest.mark.anyio
async def test_a_domain_that_may_not_be_fetched_reports_no_remote(
    runtime, tmp_path, clean_manifests
):
    """A baked-but-no-longer-declared domain is offline-only: every hour past
    the bake 404s by design, so a manifest remembered while it WAS live must not
    keep promising them."""
    clean_manifests._remember_manifest(
        "dwd_icon", _MANIFEST["reference_time"], _MANIFEST["valid_times"]
    )
    root = tmp_path / "bake"
    _bake(root, "dwd_icon", "2026/07/29/0600Z", "2026-07-29T1200")
    _set(runtime, [])
    (src,) = [
        s
        for s in list_sources(runtime.config.get(), WeatherMirror([root]))
        if s.id == "om:dwd_icon"
    ]
    assert src.describe().requires_network is False
    assert src.describe().coverage.remote == ()


def test_a_manifest_older_than_its_run_is_forgotten(clean_manifests, monkeypatch):
    """A remembered manifest describes ONE run. Past the longest interval
    upstream re-runs a domain at, it is stale enough that reporting its horizon
    would shade the ruler from a run that has since moved — back to unknown."""
    om = clean_manifests
    om._remember_manifest("dwd_icon", _MANIFEST["reference_time"], _MANIFEST["valid_times"])
    assert om.remembered_manifest("dwd_icon") is not None
    real = time.monotonic
    monkeypatch.setattr(time, "monotonic", lambda: real() + om._MANIFEST_MAX_AGE_S + 1)
    assert om.remembered_manifest("dwd_icon") is None
