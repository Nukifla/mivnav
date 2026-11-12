# SPDX-License-Identifier: GPL-2.0-only
"""The M-DATA-1 data-provider descriptor + registry + /providers endpoint."""

from __future__ import annotations

from pathlib import Path

from mivnav.data import CachePolicy, DataProvider, IngestSpec, Refresh
from mivnav.features.weather import WeatherProxy

EXPECTED_IDS = {
    "chart-store",
    "poi",
    "osm_world",
    "satellite",
    "ocharts",
    "weather",
    "signalk",
    "autopilot",
    # Commanding the anchoralarm plugin — the autopilot's shape exactly.
    "anchor",
    "route",
    # `routing_data_provider` — registered alongside the `/routing/*`
    # feature (the mivnav `.mivnav` artifact store's stats live here).
    "routing",
    # The one `kind="static-asset"` entry: files served whole (package data
    # plus a ~/.config shadow), not tiles/ranges/a stream — see
    # mivnav.features.themes.provider on why the vocabulary gained a fifth
    # value rather than this one picking the least-wrong of the four.
    "themes",
    # The one `kind="history-query"` entry: addressed by a TIME RANGE and
    # answered per request by the boat's SignalK history plugin, cached
    # nowhere here — see mivnav.features.track.provider for why the
    # vocabulary gained a sixth value rather than this being filed as an
    # "area-query" whose axis is not an area.
    "track",
    # Danish notices to mariners (Niord): a polled whole-document snapshot
    # kept on disk — see mivnav.features.notices.provider.
    "notices",
    "buddies",
    # Standalone marks: SignalK waypoint resources, mirrored in memory.
    "marks",
    # Man overboard: the persisted mark and its SignalK alarm.
    "mob",
}


# -- the endpoint ----------------------------------------------------------


def test_providers_lists_every_source(client):
    r = client.get("/providers")
    assert r.status_code == 200
    providers = r.json()["providers"]
    assert {p["id"] for p in providers} == EXPECTED_IDS
    # every provider carries a live stats dict
    for p in providers:
        assert isinstance(p["stats"], dict)


def test_providers_declare_their_policies(client):
    by_id = {p["id"]: p for p in client.get("/providers").json()["providers"]}

    # SignalK: live stream, cache absence is load-bearing
    assert by_id["signalk"]["kind"] == "live-stream"
    assert by_id["signalk"]["cache"] is None
    assert by_id["signalk"]["refresh"]["mode"] == "live"

    # weather: immutable disk range-mirror
    w = by_id["weather"]
    assert w["kind"] == "range-mirror"
    assert w["cache"]["tier"] == "disk"
    assert w["cache"]["negative"] == "none"
    assert w["refresh"]["mode"] == "immutable"

    # o-charts: RAM byte-LRU, single-flight, error-memo, rescan-refresh
    o = by_id["ocharts"]
    assert o["kind"] == "tiled"
    assert o["cache"]["tier"] == "ram"
    assert o["cache"]["single_flight"] is True
    assert o["cache"]["negative"] == "error-memo"
    assert o["refresh"]["mode"] == "sequence-rescan"
    assert o["refresh"]["interval"] is not None

    # chart-store: no backend byte-cache; a sequence-rescan registry
    cs = by_id["chart-store"]
    assert cs["kind"] == "tiled"
    assert cs["cache"] is None
    assert cs["refresh"]["mode"] == "sequence-rescan"

    # autopilot: a command API, not a cache — same "live, no cache" shape
    # as signalk, whose stream its own read half already rides.
    ap = by_id["autopilot"]
    assert ap["kind"] == "live-stream"
    assert ap["cache"] is None
    assert ap["refresh"]["mode"] == "live"
    assert ap["ingest"] is None


def test_providers_reference_existing_config_slices(client):
    by_id = {p["id"]: p for p in client.get("/providers").json()["providers"]}
    assert by_id["ocharts"]["config_slice"] == "ocharts"
    # M-DATA-3: the pre-baked chart store's Derived now keys on the shared
    # `data_root` (no more dedicated `charts` config section/field).
    assert by_id["chart-store"]["config_slice"] == "data_root"
    assert by_id["weather"]["config_slice"] == "weather"
    assert by_id["signalk"]["config_slice"] == "signalk"
    # autopilot has no config slice of its own — see
    # mivnav.features.autopilot's module docstring — so it points at the
    # same slice signalk does, the actual source of its two inputs.
    assert by_id["autopilot"]["config_slice"] == "signalk"


def test_providers_declare_whether_they_are_bakeable(client):
    """Phase A: the optional ``ingest`` field DECLARES a source is bakeable.
    A serve-time-only source (signalk/chart-store) carries ``None``; a
    Mode-B source (POI, and — since #rktyytqx — weather) carries an
    ``IngestSpec`` folded into the summary as a plain dict."""
    by_id = {p["id"]: p for p in client.get("/providers").json()["providers"]}

    # every provider now surfaces the key (additive to the contract)
    assert all("ingest" in p for p in by_id.values())

    assert by_id["signalk"]["ingest"] is None
    assert by_id["chart-store"]["ingest"] is None

    # weather is ALSO proxied (the byte-range mirror, unchanged) but is now
    # bakeable too: a mirrored tree of full `.om` files OR a tree of fetched
    # GRIB files, chosen per-dataset (jt mzyvvmux) — `region="none"`,
    # `artifact="file-mirror"` (see mivnav.features.weather.provider's module
    # docstring).
    assert by_id["weather"]["ingest"] == {
        "id": "weather",
        "source": "http",
        "out_dir_slice": "weather",
        "region": "none",
        "artifact": "file-mirror",
        "schedule": "manual",
        "ttl_s": None,
        "params": {},
    }

    # POI is a Mode-B Overpass→pmtiles bake into its scanned dir. M-DATA-3:
    # `out_dir_slice` is now just the `data_root` subdirectory name (no more
    # `poi.dir` field for a full attr path to point at).
    assert by_id["poi"]["ingest"] == {
        "id": "poi",
        "source": "overpass",
        "out_dir_slice": "poi",
        "region": "bbox",
        "artifact": "pmtiles",
        "schedule": "manual",
        "ttl_s": None,
        "params": {},
    }

    # o-charts is a Mode-B shop install into the sets dir
    o = by_id["ocharts"]["ingest"]
    assert o["source"] == "ocharts-shop"
    assert o["out_dir_slice"] == "ocharts"
    assert o["region"] == "chart-set"
    assert o["artifact"] == "ocharts-set"

    # satellite is a Mode-B XYZ→raster-pmtiles bake into its scanned dir
    assert by_id["satellite"]["ingest"] == {
        "id": "satellite",
        "source": "http",
        "out_dir_slice": "satellite",
        "region": "bbox",
        "artifact": "pmtiles",
        "schedule": "manual",
        "ttl_s": None,
        "params": {},
    }


def test_ingest_spec_defaults_and_serialises():
    """The spec is a frozen value type with manual/None schedule defaults and an
    empty ``params`` dict; a serve-time provider defaults ``ingest=None``."""
    spec = IngestSpec(
        id="poi",
        source="overpass",
        out_dir_slice="poi.dir",
        region="bbox",
        artifact="pmtiles",
    )
    assert spec.schedule == "manual"
    assert spec.ttl_s is None
    assert spec.params == {}

    baked = DataProvider(
        id="poi",
        label="POI",
        kind="tiled",
        cache=None,
        refresh=Refresh("sequence-rescan", interval=5.0),
        prefetch=None,
        config_slice="poi",
        stats=lambda: {},
        ingest=spec,
    )
    assert baked.summary()["ingest"]["source"] == "overpass"

    plain = DataProvider(
        id="x",
        label="X",
        kind="tiled",
        cache=None,
        refresh=Refresh("immutable"),
        prefetch=None,
        config_slice="x",
        stats=lambda: {},
    )
    assert plain.ingest is None
    assert plain.summary()["ingest"] is None


def test_ocharts_stats_wire_to_the_real_lru(client):
    o = {p["id"]: p for p in client.get("/providers").json()["providers"]}["ocharts"]
    # wired straight to SingleFlightLRU.stats() for all four caches (cells,
    # tiles, the routing HazardIndex cache — ROUTING_TODO.md's "HazardIndex
    # cache" item — and the LandHazardBake cache alongside it, not on any
    # live serve path yet but a real cache with a real byte budget).
    for cache in ("cell_cache", "tile_cache", "hazard_cache", "land_bake_cache"):
        assert cache in o["stats"]
        assert {"entries", "bytes", "budget", "hits", "loads"} <= set(o["stats"][cache])


def test_weather_stats_surface_appears(client):
    w = {p["id"]: p for p in client.get("/providers").json()["providers"]}["weather"]
    assert {"runs", "chunks", "bytes", "budget", "chunk_bytes"} <= set(w["stats"])


def test_signalk_stats_report_liveness(client):
    sk = {p["id"]: p for p in client.get("/providers").json()["providers"]}["signalk"]
    # liveness, not occupancy (cache is None). Status is one of the live-stream
    # states; `connected` is derived from it. (The session runtime is shared, so
    # the exact status is not asserted — only that liveness is reported.)
    st = sk["stats"]
    assert st["status"] in {"off", "connecting", "connected"}
    assert st["connected"] == (st["status"] == "connected")
    assert isinstance(st["targets"], int)


def test_a_future_ais_provider_fits_as_one_descriptor():
    """AIS is a domain, not a SignalK field: today it rides the SignalK
    live-stream provider, but a dedicated AIS source registers as its own
    descriptor with no change to the model. Both future shapes are expressible
    in the existing vocabulary."""
    # a direct AIS receiver: another live push, no cache — fits with today's
    # vocabulary unchanged
    receiver = DataProvider(
        id="ais-receiver",
        label="AIS",
        kind="live-stream",
        cache=None,
        refresh=Refresh("live"),
        prefetch=None,
        config_slice="ais",
        stats=lambda: {"status": "connected"},
    )
    # a web AIS API: polled by bbox, cached with a TTL — uses the extension
    # members area-query + refresh "ttl" + a real CachePolicy
    web = DataProvider(
        id="ais-web",
        label="AIS (web)",
        kind="area-query",
        cache=CachePolicy(
            budget_bytes=8 * 1024 * 1024, tier="disk", negative="ttl", single_flight=True
        ),
        refresh=Refresh("ttl", interval=60.0),
        prefetch=None,
        config_slice="ais",
        stats=lambda: {"areas": 0},
    )
    assert receiver.summary()["kind"] == "live-stream"
    assert web.summary()["kind"] == "area-query"
    assert web.summary()["refresh"] == {"mode": "ttl", "interval": 60.0}
    assert web.summary()["cache"]["negative"] == "ttl"


# -- the new weather-proxy stats surface (unit) ----------------------------


def test_weather_proxy_stats_empty(tmp_path: Path):
    proxy = WeatherProxy(
        cache_dir=tmp_path / "absent",  # not created yet
        cache_budget=1000,
        tiles_url="http://x",
        forecast_url="http://y",
    )
    assert proxy.stats() == {
        "runs": 0,
        "chunks": 0,
        "bytes": 0,
        "budget": 1000,
        "chunk_bytes": proxy._chunk,
    }


def test_weather_proxy_stats_counts_runs_and_chunks(tmp_path: Path):
    proxy = WeatherProxy(
        cache_dir=tmp_path,
        cache_budget=1000,
        tiles_url="http://x",
        forecast_url="http://y",
    )
    run = tmp_path / "deadbeef"
    run.mkdir()
    (run / "0").write_bytes(b"aaaa")
    (run / "1").write_bytes(b"bbbbbb")
    (run / "size").write_text("10")  # the sidecar is bytes, not a chunk
    s = proxy.stats()
    assert s["runs"] == 1
    assert s["chunks"] == 2  # size sidecar excluded
    assert s["bytes"] == 4 + 6 + 2  # both chunks + the "10" sidecar bytes


# -- the descriptor as a value type ----------------------------------------


def test_descriptor_summary_is_json_safe_and_omits_the_callable():
    p = DataProvider(
        id="demo",
        label="Demo",
        kind="tiled",
        cache=CachePolicy(budget_bytes=1, tier="ram", negative="none", single_flight=False),
        refresh=Refresh("sequence-rescan", interval=5.0),
        prefetch=None,
        config_slice="demo",
        stats=lambda: {"ok": True},
    )
    summary = p.summary()
    assert "stats" not in summary
    assert summary["cache"] == {
        "budget_bytes": 1,
        "tier": "ram",
        "negative": "none",
        "single_flight": False,
    }
    assert summary["refresh"] == {"mode": "sequence-rescan", "interval": 5.0}
    # a new source is one descriptor: nothing central was needed to make this
    assert p.stats() == {"ok": True}


# -- M-DATA-3: dataset resolution (out_dir_slice/config_slice made load-bearing) --


def _bare_provider(id_: str, *, ingest: IngestSpec | None) -> DataProvider:
    return DataProvider(
        id=id_,
        label=id_,
        kind="tiled",
        cache=None,
        refresh=Refresh("sequence-rescan", interval=5.0),
        prefetch=None,
        config_slice=id_,
        stats=lambda: {},
        ingest=ingest,
    )


def test_resolve_dataset_provider_matches_by_id():
    from mivnav.data.provider import UnknownDatasetProvider, resolve_dataset_provider

    poi = _bare_provider("poi", ingest=None)
    sat = _bare_provider("satellite", ingest=None)
    assert resolve_dataset_provider([poi, sat], "poi") is poi
    assert resolve_dataset_provider([poi, sat], "satellite") is sat
    try:
        resolve_dataset_provider([poi, sat], "weather")
        raise AssertionError("expected UnknownDatasetProvider")
    except UnknownDatasetProvider:
        pass


def test_dataset_output_dir_reads_out_dir_slice_off_the_live_provider(tmp_path: Path):
    from mivnav.data.provider import dataset_output_dir

    spec = IngestSpec(
        id="poi", source="overpass", out_dir_slice="poi", region="bbox", artifact="pmtiles"
    )
    provider = _bare_provider("poi", ingest=spec)
    assert dataset_output_dir(tmp_path, provider, "solent") == tmp_path / "poi" / "solent"


def test_dataset_output_dir_of_a_non_bakeable_provider_raises(tmp_path: Path):
    from mivnav.data.provider import DatasetProviderNotBakeable, dataset_output_dir

    chart_store = _bare_provider("chart-store", ingest=None)
    try:
        dataset_output_dir(tmp_path, chart_store, "x")
        raise AssertionError("expected DatasetProviderNotBakeable")
    except DatasetProviderNotBakeable:
        pass


def test_build_dataset_runner_validates_params_and_calls_the_factory(tmp_path: Path):
    from pydantic import BaseModel, ConfigDict

    from mivnav.config.model import DatasetConfig
    from mivnav.data.provider import build_dataset_runner

    class Params(BaseModel):
        model_config = ConfigDict(extra="forbid")

        source_id: str

    built: list[Path] = []

    def factory(dataset_dir: Path):
        built.append(dataset_dir)
        return "a-runner"

    spec = IngestSpec(
        id="satellite",
        source="http",
        out_dir_slice="satellite",
        region="bbox",
        artifact="pmtiles",
        params_model=Params,
        runner_factory=factory,
    )
    provider = _bare_provider("satellite", ingest=spec)
    dataset = DatasetConfig(
        id="dk", provider="satellite", name="Denmark", params={"source_id": "eox"}
    )
    runner = build_dataset_runner([provider], tmp_path, dataset)
    assert runner == "a-runner"
    assert built == [tmp_path / "satellite" / "dk"]


def test_build_dataset_runner_rejects_params_the_provider_does_not_expect(tmp_path: Path):
    from pydantic import ValidationError

    from mivnav.config.model import DatasetConfig
    from mivnav.data.provider import build_dataset_runner
    from mivnav.features.poi.provider import PoiDatasetParams

    spec = IngestSpec(
        id="poi",
        source="overpass",
        out_dir_slice="poi",
        region="bbox",
        artifact="pmtiles",
        params_model=PoiDatasetParams,
        runner_factory=lambda d: "unreachable",
    )
    provider = _bare_provider("poi", ingest=spec)
    dataset = DatasetConfig(id="x", provider="poi", name="X", params={"unexpected": 1})
    try:
        build_dataset_runner([provider], tmp_path, dataset)
        raise AssertionError("expected ValidationError")
    except ValidationError:
        pass


def test_build_dataset_runner_on_ocharts_is_not_bakeable(tmp_path: Path):
    """o-charts declares an IngestSpec (it IS bakeable, via its own
    Installer) but no runner_factory — reparenting it onto IngestRunner is
    explicitly out of scope (see mivnav.features.ocharts.provider)."""
    from mivnav.config.model import DatasetConfig
    from mivnav.data.provider import DatasetProviderNotBakeable, build_dataset_runner

    spec = IngestSpec(
        id="ocharts",
        source="ocharts-shop",
        out_dir_slice="ocharts",
        region="chart-set",
        artifact="ocharts-set",
    )
    provider = _bare_provider("ocharts", ingest=spec)
    dataset = DatasetConfig(id="x", provider="ocharts", name="X")
    try:
        build_dataset_runner([provider], tmp_path, dataset)
        raise AssertionError("expected DatasetProviderNotBakeable")
    except DatasetProviderNotBakeable:
        pass


def test_the_real_registry_wires_params_model_and_runner_factory_for_poi_and_satellite(
    isolated_runtime,
):
    """Through the live app's own Runtime (the session `isolated_runtime`
    fixture — see conftest.py): the real /providers registry (not a
    hand-built stub) actually carries the two fields for the two providers
    that declare them, and None for the one that deliberately does not."""
    from mivnav.api.features import FEATURES
    from mivnav.data.provider import build_registry

    runtime = isolated_runtime
    providers = build_registry(
        runtime.config.get(),
        store=runtime.store(),
        signalk=runtime.signalk(),
        features=FEATURES,
        feature_runtime=runtime.feature,
    )
    by_id = {p.id: p for p in providers}
    assert by_id["poi"].ingest.params_model is not None
    assert by_id["poi"].ingest.runner_factory is not None
    assert by_id["satellite"].ingest.params_model is not None
    assert by_id["satellite"].ingest.runner_factory is not None
    assert by_id["ocharts"].ingest.params_model is None
    assert by_id["ocharts"].ingest.runner_factory is None


def test_the_real_registry_wires_a_trigger_for_poi_and_satellite_but_not_ocharts(
    isolated_runtime,
):
    """The generic ``POST /datasets/{id}/ingest`` trigger (this task): wired
    for the two providers with a real ``runner_factory``, absent for o-charts
    (its ``Installer`` stays standalone — see mivnav.feature's ``IngestSpec.
    trigger`` docstring)."""
    from mivnav.api.features import FEATURES
    from mivnav.data.provider import build_registry

    runtime = isolated_runtime
    providers = build_registry(
        runtime.config.get(),
        store=runtime.store(),
        signalk=runtime.signalk(),
        features=FEATURES,
        feature_runtime=runtime.feature,
    )
    by_id = {p.id: p for p in providers}
    assert by_id["poi"].ingest.trigger is not None
    assert by_id["satellite"].ingest.trigger is not None
    assert by_id["ocharts"].ingest.trigger is None


# -- resolve_dataset_region / trigger_dataset_ingest (POST /datasets/{id}/ingest) --


def test_resolve_dataset_region_matches_by_id():
    from mivnav.config.model import Region
    from mivnav.data.provider import resolve_dataset_region

    solent = Region(id="solent", name="Solent")
    dk = Region(id="denmark", name="Denmark", country="DK")
    assert resolve_dataset_region([solent, dk], "denmark") is dk
    assert resolve_dataset_region([solent, dk], None) is None


def test_resolve_dataset_region_unknown_id_raises():
    from mivnav.config.model import Region
    from mivnav.data.provider import UnknownDatasetRegion, resolve_dataset_region

    try:
        resolve_dataset_region([Region(id="solent", name="Solent")], "nope")
        raise AssertionError("expected UnknownDatasetRegion")
    except UnknownDatasetRegion:
        pass


def test_trigger_dataset_ingest_validates_params_resolves_region_and_calls_trigger(
    tmp_path: Path,
):
    from pydantic import BaseModel, ConfigDict

    from mivnav.config.model import DatasetConfig, Region
    from mivnav.data.provider import trigger_dataset_ingest

    class Params(BaseModel):
        model_config = ConfigDict(extra="forbid")

        source_id: str

    calls = []

    def trigger(runner, region, params, implementation):
        calls.append((runner, region, params, implementation))

    spec = IngestSpec(
        id="satellite",
        source="http",
        out_dir_slice="satellite",
        region="bbox",
        artifact="pmtiles",
        params_model=Params,
        runner_factory=lambda d: "a-runner",
        trigger=trigger,
    )
    provider = _bare_provider("satellite", ingest=spec)
    dk = Region(id="denmark", name="Denmark", country="DK")
    dataset = DatasetConfig(
        id="dk", provider="satellite", name="Denmark", region_id="denmark",
        params={"source_id": "eox"},
    )
    trigger_dataset_ingest([provider], [dk], dataset, "the-runner")
    assert len(calls) == 1
    runner, region, params, implementation = calls[0]
    assert runner == "the-runner"
    assert region is dk
    assert isinstance(params, Params)
    assert params.source_id == "eox"
    # jt rsmpwtmw: the fourth argument — `DatasetConfig.implementation`,
    # `None` for a single-backing provider like this one.
    assert implementation is None


def test_trigger_dataset_ingest_on_ocharts_is_not_bakeable():
    """o-charts declares an IngestSpec but no ``trigger`` — the same
    "declared-bakeable-but-not-through-this-surface" shape ``build_dataset_
    runner`` already has for it (see ``test_build_dataset_runner_on_ocharts_
    is_not_bakeable`` above)."""
    from mivnav.config.model import DatasetConfig
    from mivnav.data.provider import DatasetProviderNotBakeable, trigger_dataset_ingest

    spec = IngestSpec(
        id="ocharts",
        source="ocharts-shop",
        out_dir_slice="ocharts",
        region="chart-set",
        artifact="ocharts-set",
    )
    provider = _bare_provider("ocharts", ingest=spec)
    dataset = DatasetConfig(id="x", provider="ocharts", name="X")
    try:
        trigger_dataset_ingest([provider], [], dataset, "unreachable")
        raise AssertionError("expected DatasetProviderNotBakeable")
    except DatasetProviderNotBakeable:
        pass
