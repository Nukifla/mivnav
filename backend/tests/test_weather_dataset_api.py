# SPDX-License-Identifier: GPL-2.0-only
"""Weather as a real bakeable ``/datasets`` provider (#rktyytqx) — the
declaration/validation surface (``PUT /datasets/{id}``,
``WeatherDatasetParams``), an end-to-end bake through the generic
``POST /datasets/{id}/ingest`` trigger (upstream stubbed), and the live
``/weather/data_spatial/...`` routes actually preferring a baked file over
the (here, deliberately unreachable) upstream proxy — the "live proxy stays
available for anything NOT downloaded" contract, proven from the OTHER
direction: something that WAS downloaded never touches the network at all.

Same fixture shape as ``tests.test_datasets_api``: each test builds its OWN
isolated ``Runtime``/``TestClient`` via ``isolated_runtime_at`` rather than
the shared session ``client`` fixture, since these tests mutate
``Config.datasets``/``Config.weather``.
"""

from __future__ import annotations

import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import get_runtime
from mivnav.features.weather.ingest import om_paths_for_bake
from tests.conftest import isolated_runtime_at

# A host nothing listens on — connection-refused, fast and deterministic —
# used to PROVE a request never touched the network (see the mirror-first
# tests at the bottom).
UNREACHABLE_UPSTREAM = "http://127.0.0.1:1"


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


def _set_datasets(runtime, datasets: list[dict]) -> None:
    runtime.patch_config({"datasets": datasets})


# -- PUT /datasets/{id}: WeatherDatasetParams validation -----------------------


def test_put_weather_dataset_requires_domain_param(dc):
    r = dc.put("/datasets/wx", json={"provider": "weather", "name": "Weather"})
    assert r.status_code == 422


def test_put_weather_dataset_rejects_an_unknown_domain(dc):
    r = dc.put(
        "/datasets/wx",
        json={"provider": "weather", "name": "Weather", "params": {"domain": "not_a_real_model"}},
    )
    assert r.status_code == 422


def test_put_weather_dataset_rejects_a_stray_param(dc):
    r = dc.put(
        "/datasets/wx",
        json={
            "provider": "weather",
            "name": "Weather",
            "params": {"domain": "dwd_icon", "variables": ["temperature_2m"]},
        },
    )
    assert r.status_code == 422  # extra="forbid" — no variables field exists


def test_put_weather_dataset_with_a_known_domain_succeeds(runtime, dc):
    r = dc.put(
        "/datasets/wx",
        json={"provider": "weather", "name": "Weather", "params": {"domain": "dwd_icon"}},
    )
    assert r.status_code == 200
    e = r.json()
    assert e["provider"] == "weather"
    assert e["status"] == "unbaked"
    assert {d.id for d in runtime.config.get().datasets} == {"wx"}


def test_put_weather_dataset_needs_no_region_id(dc):
    """Unlike POI/satellite, a weather bake has no bbox to clip to — see
    `mivnav.features.weather.provider._weather_trigger`'s docstring — so
    `region_id` is optional even at PUT time."""
    r = dc.put(
        "/datasets/wx",
        json={"provider": "weather", "name": "Weather", "params": {"domain": "dwd_icon"}},
    )
    assert r.status_code == 200
    assert r.json()["region_id"] is None


def test_put_weather_dataset_with_a_ttl_schedule_persists_ttl_s(runtime, dc):
    """The `ttl_s` gap fixed alongside #rktyytqx (see `DatasetPutBody`'s
    docstring): a weather dataset's recurring bake needs this to round-trip."""
    r = dc.put(
        "/datasets/wx",
        json={
            "provider": "weather",
            "name": "Weather",
            "schedule": "ttl",
            "ttl_s": 3600,
            "params": {"domain": "dwd_icon"},
        },
    )
    assert r.status_code == 200
    assert r.json()["ttl_s"] == 3600
    ds = next(d for d in runtime.config.get().datasets if d.id == "wx")
    assert ds.ttl_s == 3600
    assert ds.schedule == "ttl"


def test_put_validates_domains_against_the_catalog_the_implementation_names(runtime, dc):
    """jt rsmpwtmw: `domains` is checked against the Open-Meteo domain catalog
    or the DWD product catalog depending on WHICH backing the dataset names —
    a fact that used to sit inside `params` (as `source`) and now sits on the
    dataset. `params_model.model_validate` sees only `params`, so it reaches
    the validator as pydantic context (`mivnav.feature.params_context`); if
    that thread is ever cut, this PUT silently validates a GRIB product id
    against the wrong catalog."""
    r = dc.put(
        "/datasets/wx",
        json={
            "provider": "weather",
            "name": "Weather",
            "implementation": "grib",
            "params": {"domains": ["dwd_icon_eu"]},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["implementation"] == "grib"
    assert next(d for d in runtime.config.get().datasets if d.id == "wx").implementation == "grib"

    # A real Open-Meteo domain that is NOT a DWD opendata product: legal under
    # "om", rejected under "grib". Which catalog answered is the whole point.
    r = dc.put(
        "/datasets/wx2",
        json={
            "provider": "weather",
            "name": "Weather",
            "implementation": "grib",
            "params": {"domains": ["ncep_gfs025"]},
        },
    )
    assert r.status_code == 422, r.text
    r = dc.put(
        "/datasets/wx2",
        json={"provider": "weather", "name": "Weather", "params": {"domains": ["ncep_gfs025"]}},
    )
    assert r.status_code == 200, r.text


def test_a_legacy_on_demand_put_body_is_still_accepted(runtime, dc):
    """A service-worker-cached frontend several versions behind still sends
    the retired `schedule: "on-demand"` — it must land as a live-cache
    dataset, not a 422 a sailor cannot act on."""
    r = dc.put(
        "/datasets/wx",
        json={
            "provider": "weather",
            "name": "Weather",
            "schedule": "on-demand",
            "params": {"domains": ["dwd_icon"]},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["mode"] == "live-cache"
    assert r.json()["schedule"] == "manual"
    # And it has no bake step — the guard moved to `mode` with it.
    assert dc.post("/datasets/wx/ingest").status_code == 409


# -- POST /datasets/{id}/ingest: a real bake, upstream stubbed -----------------


def _today_manifest_and_paths(domain: str) -> tuple[dict, list[str]]:
    now = datetime.now(timezone.utc)
    ref = now.replace(minute=0, second=0, microsecond=0)
    stamp = ref.isoformat().replace("+00:00", "Z")
    manifest = {"reference_time": stamp, "valid_times": [stamp]}
    return manifest, om_paths_for_bake(domain, manifest, now=now)


def _install_fake_om_upstream(monkeypatch, manifest: dict, om_body: bytes = b"OMBYTES"):
    """Monkeypatch `httpx.Client.get` at the CLASS level (there is no other
    seam: the generic `POST /datasets/{id}/ingest` path builds
    `WeatherIngestRunner` through `_weather_runner_factory`, which takes only
    a bare directory — see that function's docstring), but ONLY intercept
    requests that look like OUR fake Open-Meteo upstream
    (`WeatherConfig.upstream_tiles_url`'s default host). Every other request
    — CRUCIALLY including `dc`/`TestClient`'s OWN `.get()` calls, which are
    ALSO `httpx.Client.get` under the hood — falls through to the real
    method. Learned the hard way: an unconditional patch here makes
    `dc.get("/datasets")` itself return the fake om bytes instead of the
    real ASGI response."""
    real_get = httpx.Client.get

    def fake_get(self, url, *args, **kwargs):
        if "/data_spatial/" not in str(url):
            return real_get(self, url, *args, **kwargs)
        if str(url).endswith("latest.json"):
            return httpx.Response(200, json=manifest, request=httpx.Request("GET", url))
        return httpx.Response(200, content=om_body, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.Client, "get", fake_get)


def test_ingest_weather_dataset_bakes_todays_om_files(runtime, dc, monkeypatch):
    manifest, paths = _today_manifest_and_paths("dwd_icon")
    assert paths

    _install_fake_om_upstream(monkeypatch, manifest)
    _set_datasets(
        runtime, [{"id": "wx", "provider": "weather", "name": "Weather", "params": {"domain": "dwd_icon"}}]
    )

    resp = dc.post("/datasets/wx/ingest")
    assert resp.status_code == 200

    deadline = time.time() + 10.0
    entry = None
    while time.time() < deadline:
        entry = dc.get("/datasets").json()["datasets"][0]
        if entry["status"] in ("baked", "error"):
            break
        time.sleep(0.02)
    assert entry["status"] == "baked", entry

    config = runtime.config.get()
    dataset_dir = config.data_root / "weather" / "wx"
    for p in paths:
        assert (dataset_dir / "data_spatial" / p).read_bytes() == b"OMBYTES"


def test_ingest_weather_dataset_prunes_a_stale_run(runtime, dc, monkeypatch):
    manifest, paths = _today_manifest_and_paths("dwd_icon")
    assert paths

    _install_fake_om_upstream(monkeypatch, manifest)
    _set_datasets(
        runtime, [{"id": "wx", "provider": "weather", "name": "Weather", "params": {"domain": "dwd_icon"}}]
    )
    config = runtime.config.get()
    stale = config.data_root / "weather/wx/data_spatial/dwd_icon/2020/01/01/0000Z/2020-01-01T0000.om"
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"old")

    dc.post("/datasets/wx/ingest")
    deadline = time.time() + 10.0
    while time.time() < deadline and not stale_gone(stale):
        time.sleep(0.02)
    assert not stale.exists()


def stale_gone(path: Path) -> bool:
    return not path.exists()


def test_put_ocharts_style_provider_rejection_still_applies_to_weather_typos(dc):
    r = dc.put("/datasets/wx", json={"provider": "wether", "name": "Weather"})
    assert r.status_code == 422


# -- live routes: a baked file is served with NO network attempt --------------


def _weather_isolated_client(tmp_path: Path):
    """Same shape as `runtime`/`dc` above, but also points `weather.
    upstream_tiles_url` at an address nothing listens on — so any request
    that DID fall through to the proxy would fail fast and visibly (502),
    making "served with no fallback" and "genuinely offline-degraded
    fallback" easy to tell apart in these tests."""
    rt = isolated_runtime_at(tmp_path)
    rt.patch_config(
        {
            "weather": {
                "cache_dir": str(tmp_path / "weather-cache"),
                "render_cache_dir": str(tmp_path / "weather-render"),
                "upstream_tiles_url": UNREACHABLE_UPSTREAM,
            }
        }
    )
    return rt


@pytest.fixture
def offline_runtime(tmp_path: Path):
    rt = _weather_isolated_client(tmp_path)
    yield rt
    rt.close()


@pytest.fixture
def offline_dc(offline_runtime):
    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: offline_runtime
    with TestClient(app) as c:
        yield c
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous


def _bake_directly(runtime, dataset_id: str, om_path: str, body: bytes) -> None:
    """Write a `.om` straight into a declared weather dataset's own baked
    directory — bypassing `WeatherIngestRunner` (already covered by
    test_weather_ingest.py) so THIS test is purely about routes.py/mirror.py
    preferring it, not about how it got there."""
    config = runtime.config.get()
    target = config.data_root / "weather" / dataset_id / "data_spatial" / om_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)


OM_PATH = "dwd_icon/2026/07/24/1200Z/2026-07-24T1500.om"


def test_a_baked_om_file_is_served_with_upstream_unreachable(offline_runtime, offline_dc):
    _set_datasets(
        offline_runtime,
        [{"id": "wx", "provider": "weather", "name": "Weather", "params": {"domain": "dwd_icon"}}],
    )
    body = b"0123456789" * 20
    _bake_directly(offline_runtime, "wx", OM_PATH, body)

    head = offline_dc.head(f"/weather/data_spatial/{OM_PATH}")
    assert head.status_code == 200
    assert head.headers["content-length"] == str(len(body))

    r = offline_dc.get(f"/weather/data_spatial/{OM_PATH}", headers={"range": "bytes=10-19"})
    assert r.status_code == 206
    assert r.content == body[10:20]
    assert r.headers["content-range"] == f"bytes 10-19/{len(body)}"


def test_a_non_baked_om_file_falls_through_and_502s_when_upstream_is_unreachable(
    offline_runtime, offline_dc
):
    """The other half of the fallback contract: nothing baked -> the proxy
    is still consulted (this task changes nothing about that path) -> a
    genuinely unreachable upstream degrades to 502, not a crash."""
    _set_datasets(
        offline_runtime,
        [{"id": "wx", "provider": "weather", "name": "Weather", "params": {"domain": "dwd_icon"}}],
    )
    r = offline_dc.get(f"/weather/data_spatial/{OM_PATH}", headers={"range": "bytes=0-9"})
    assert r.status_code == 502


def test_disabling_a_weather_dataset_hides_its_baked_om_file_from_the_live_route(
    offline_runtime, offline_dc
):
    """jt lvpkxtsr: a disabled dataset's baked ``.om`` files must stop being
    served — ``WeatherRuntime.mirror()`` excludes it from its roots — while
    the files themselves are left untouched on disk (only the config flag
    changes here, nothing under ``data_spatial``)."""
    _set_datasets(
        offline_runtime,
        [
            {
                "id": "wx", "provider": "weather", "name": "Weather",
                "params": {"domain": "dwd_icon"}, "enabled": False,
            },
        ],
    )
    body = b"0123456789" * 20
    _bake_directly(offline_runtime, "wx", OM_PATH, body)

    target = offline_runtime.config.get().data_root / "weather" / "wx" / "data_spatial" / OM_PATH
    assert target.is_file(), "disabling must never touch what is already baked"

    # The live route no longer finds it through the mirror and falls through
    # to the (deliberately unreachable) proxy -> 502, the same "nothing
    # baked" outcome the sibling test above gets for a truly empty dataset.
    r = offline_dc.get(f"/weather/data_spatial/{OM_PATH}", headers={"range": "bytes=0-9"})
    assert r.status_code == 502


def test_disabled_weather_dataset_grib_store_is_refused(runtime):
    """The GRIB-sourced tile/point routes (`routes.py`'s `wash_tile`/
    `wind_tile`/`point`) resolve a store via `WeatherRuntime.grib_store`,
    not `mirror()` — a separate path that needs its own gate. It raises
    `KeyError`, which every one of those three handlers already catches and
    turns into a 404 (unknown domain/variable uses the same exception
    today), so a disabled dataset 404s the same well-trodden way."""
    from typing import cast

    from mivnav.features.weather.runtime import WeatherRuntime

    _set_datasets(
        runtime,
        [
            {
                "id": "wx", "provider": "weather", "name": "Weather",
                "params": {"domain": "dwd_icon"}, "enabled": False,
            },
        ],
    )
    weather_runtime = cast(WeatherRuntime, runtime.feature("weather"))
    # A REAL product id — isolates this assertion to the disabled-dataset
    # gate, not an unrelated "unknown product" KeyError from gribfetch.
    with pytest.raises(KeyError, match="disabled"):
        weather_runtime.grib_store("wx", "dwd_icon_d2")


def test_enabled_weather_dataset_grib_store_builds_normally(runtime):
    from typing import cast

    from mivnav.features.weather.runtime import WeatherRuntime

    _set_datasets(
        runtime,
        [{"id": "wx", "provider": "weather", "name": "Weather", "params": {"domain": "dwd_icon"}}],
    )
    weather_runtime = cast(WeatherRuntime, runtime.feature("weather"))
    assert weather_runtime.grib_store("wx", "dwd_icon_d2") is not None


# -- GET /weather/baked: what this boat has offline (#tttsxnuo) -----------------


def test_baked_reports_nothing_when_no_dataset_has_been_baked(offline_runtime, offline_dc):
    _set_datasets(
        offline_runtime,
        [{"id": "wx", "provider": "weather", "name": "Weather", "params": {"domain": "dwd_icon"}}],
    )
    # A DECLARED dataset is an intention, not an offline guarantee — nothing on
    # disk means nothing to advertise (see WeatherMirror.baked's docstring).
    r = offline_dc.get("/weather/baked")
    assert r.status_code == 200
    assert r.json() == {"domains": []}


def test_baked_reports_the_span_of_what_is_actually_on_disk(offline_runtime, offline_dc):
    _set_datasets(
        offline_runtime,
        [{"id": "wx", "provider": "weather", "name": "Weather", "params": {"domain": "dwd_icon"}}],
    )
    _bake_directly(offline_runtime, "wx", OM_PATH, b"x")
    _bake_directly(
        offline_runtime, "wx", "dwd_icon/2026/07/24/1200Z/2026-07-25T0300.om", b"x"
    )

    r = offline_dc.get("/weather/baked")
    assert r.status_code == 200
    assert r.json()["domains"] == [
        {
            "domain": "dwd_icon",
            "first": "2026-07-24T15:00:00Z",
            "last": "2026-07-25T03:00:00Z",
            "files": 2,
        }
    ]
    # Never cacheable: a bake landing or pruning changes this answer, and a
    # stale "you have this offline" is the exact lie the route prevents.
    assert r.headers["cache-control"] == "no-store"


def test_baked_merges_the_same_domain_across_two_datasets(offline_runtime, offline_dc):
    _set_datasets(
        offline_runtime,
        [
            {"id": "a", "provider": "weather", "name": "A", "params": {"domain": "dwd_icon"}},
            {"id": "b", "provider": "weather", "name": "B", "params": {"domain": "dwd_icon"}},
        ],
    )
    _bake_directly(offline_runtime, "a", OM_PATH, b"x")
    _bake_directly(offline_runtime, "b", "dwd_icon/2026/07/24/1200Z/2026-07-26T0900.om", b"x")

    domains = offline_dc.get("/weather/baked").json()["domains"]
    assert len(domains) == 1
    assert domains[0]["files"] == 2
    assert domains[0]["last"] == "2026-07-26T09:00:00Z"


# -- GET /weather/baked: the GRIB half (wiring the live viewer to a bake) ------

_GRIB_FIXTURE_DIR = Path(__file__).parent.parent / "data" / "grib"
_GRIB_U_FIXTURE = _GRIB_FIXTURE_DIR / "icon-eu_europe_regular-lat-lon_single-level_2026072600_000_U_10M.grib2"
_GRIB_V_FIXTURE = _GRIB_FIXTURE_DIR / "icon-eu_europe_regular-lat-lon_single-level_2026072600_000_V_10M.grib2"


def _bake_grib_directly(runtime, dataset_id: str, product_id: str) -> None:
    """Copy the real fixture GRIB pair straight into a declared dataset's own
    ``grib/<product>/`` directory — the GRIB sibling of `_bake_directly`,
    bypassing `WeatherGribIngestRunner` (already covered by
    test_gribstore.py/test_gribingest.py) so this stays about the route/
    runtime enumeration, not the fetch itself."""
    config = runtime.config.get()
    product_dir = config.data_root / "weather" / dataset_id / "grib" / product_id
    (product_dir / "u_10m").mkdir(parents=True, exist_ok=True)
    (product_dir / "v_10m").mkdir(parents=True, exist_ok=True)
    shutil.copy(_GRIB_U_FIXTURE, product_dir / "u_10m" / _GRIB_U_FIXTURE.name)
    shutil.copy(_GRIB_V_FIXTURE, product_dir / "v_10m" / _GRIB_V_FIXTURE.name)


def test_baked_reports_a_grib_datasets_span_as_a_compound_domain_id(offline_runtime, offline_dc):
    _set_datasets(
        offline_runtime,
        [
            {
                "id": "wx-grib",
                "provider": "weather",
                "name": "GRIB wind",
                "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
            },
        ],
    )
    _bake_grib_directly(offline_runtime, "wx-grib", "dwd_icon_eu")

    domains = offline_dc.get("/weather/baked").json()["domains"]
    assert domains == [
        {
            "domain": "grib:wx-grib/dwd_icon_eu",
            "first": "2026-07-26T00:00:00Z",
            "last": "2026-07-26T00:00:00Z",
            "files": 1,
        }
    ]


def test_baked_omits_a_grib_dataset_with_nothing_baked_yet(offline_runtime, offline_dc):
    _set_datasets(
        offline_runtime,
        [
            {
                "id": "wx-grib",
                "provider": "weather",
                "name": "GRIB wind",
                "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
            },
        ],
    )
    # A declared-but-not-yet-baked GRIB dataset must read the same as an
    # unbaked `.om` one: nothing to advertise.
    assert offline_dc.get("/weather/baked").json() == {"domains": []}


def test_baked_omits_a_disabled_grib_dataset_even_with_files_on_disk(offline_runtime, offline_dc):
    _set_datasets(
        offline_runtime,
        [
            {
                "id": "wx-grib",
                "provider": "weather",
                "name": "GRIB wind",
                "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
                "enabled": False,
            },
        ],
    )
    _bake_grib_directly(offline_runtime, "wx-grib", "dwd_icon_eu")

    assert offline_dc.get("/weather/baked").json() == {"domains": []}


# ---------------------------------------------------------------------------
# GET /datasets/weather/models — the picker's own source of truth
# ---------------------------------------------------------------------------
#
# This route had NO test, which is how #xkpmrvxw's `domain` -> `domains` rename
# reached the boat half-applied: the params model and the bake trigger moved to
# the list, `models.declared_domains` was left reading the scalar, and every
# declared dataset went unseen. The picker then reported "No weather models
# configured. Add one in Settings > Datasets." with a bake sitting on disk, and
# because `allowed_domains` is built from the same function, the live proxy's
# gate closed on those domains too. Both spellings are pinned below because
# `DatasetConfig.params` is an opaque dict that is never rewritten on disk, so
# the legacy scalar is a permanent read path, not a migration.


def _model_ids(dc) -> list[str]:
    res = dc.get("/datasets/weather/models")
    assert res.status_code == 200, res.text
    return [m["id"] for m in res.json()["models"]]


def test_models_lists_a_declared_datasets_domain(runtime, dc):
    _set_datasets(
        runtime,
        [
            {
                "id": "wx-grib",
                "provider": "weather",
                "name": "GRIB wind",
                "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
            },
        ],
    )
    # Declared is enough — nothing is baked here, and the picker must still
    # offer it (that is `declared_domains`' whole contract).
    assert "dwd_icon_eu" in _model_ids(dc)


def test_models_still_honours_a_legacy_singular_domain(runtime, dc):
    _set_datasets(
        runtime,
        [
            {
                "id": "wx-grib",
                "provider": "weather",
                "name": "GRIB wind",
                "params": {"source": "grib", "domain": "dwd_icon_eu"},
            },
        ],
    )
    assert "dwd_icon_eu" in _model_ids(dc)


def test_a_declared_domain_opens_the_live_proxy_gate(runtime):
    from mivnav.features.weather.models import is_domain_allowed

    _set_datasets(
        runtime,
        [
            {
                "id": "wx-grib",
                "provider": "weather",
                "name": "GRIB wind",
                "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
            },
        ],
    )
    cfg = runtime.config.get()
    # Same failure, second consumer: a domain the sailor declared must not be
    # refused by the gate every wash/wind/point tile route applies.
    assert is_domain_allowed(cfg, "dwd_icon_eu")
    assert not is_domain_allowed(cfg, "never_declared_model")


def test_models_offers_a_grib_dataset_by_its_compound_id(runtime, dc):
    _set_datasets(
        runtime,
        [
            {
                "id": "wx-grib",
                "provider": "weather",
                "name": "GRIB wind",
                "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
            },
        ],
    )
    res = dc.get("/datasets/weather/models")
    assert res.status_code == 200, res.text
    models = {m["id"]: m for m in res.json()["models"]}

    # Without this row the GRIB read path is unreachable from the UI: the
    # frontend builds an `.om` upstream path for anything not `grib:`-shaped,
    # so a sailor who baked GRIB got an upstream 404 with the files on disk.
    entry = models.get("grib:wx-grib/dwd_icon_eu")
    assert entry is not None, sorted(models)
    # Its own group — the live domain carries the SAME catalog label, and two
    # identical-looking rows with very different behaviour is the confusion.
    assert entry["groupLabel"] == "Offline (GRIB)"
    assert entry["label"] == "DWD ICON EU"
    assert models["dwd_icon_eu"]["groupLabel"] != entry["groupLabel"]


def test_models_skips_a_disabled_grib_dataset(runtime, dc):
    _set_datasets(
        runtime,
        [
            {
                "id": "wx-grib",
                "provider": "weather",
                "name": "GRIB wind",
                "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
                "enabled": False,
            },
        ],
    )
    ids = _model_ids(dc)
    # grib_store() refuses a disabled dataset, so offering it would be a row
    # that 404s on every tile.
    assert not any(i.startswith("grib:") for i in ids), ids


def test_models_does_not_offer_grib_ids_for_an_om_dataset(runtime, dc):
    _set_datasets(
        runtime,
        [
            {
                "id": "wx-om",
                "provider": "weather",
                "name": "OM mirror",
                "params": {"domains": ["dwd_icon_eu"]},
            },
        ],
    )
    ids = _model_ids(dc)
    assert "dwd_icon_eu" in ids
    assert not any(i.startswith("grib:") for i in ids), ids


def test_the_live_proxy_gate_never_judges_a_grib_path(runtime):
    from fastapi import HTTPException

    from mivnav.features.weather.routes import _require_allowed_domain

    # Nothing declared, nothing allow-listed: the strictest possible gate.
    _set_datasets(runtime, [])
    runtime.patch_config({"weather": {"on_demand_domains": []}})

    # The gate runs BEFORE the callers parse the grib: prefix, so it used to
    # hand the compound id to domain_id_from_om_path, read the first segment
    # as the domain ("grib:my-dataset") and refuse it — every GRIB tile and
    # point 404'd before a single .grib2 file was opened. A GRIB path reads
    # this boat's own disk and never touches the network, so it has nothing
    # to prove to the live-proxy allow-list.
    _require_allowed_domain(runtime, "grib:my-dataset/dwd_icon_eu/2026-07-29T09:00Z")

    # An ordinary .om path is still gated exactly as before.
    with pytest.raises(HTTPException) as caught:
        _require_allowed_domain(runtime, "dwd_icon_eu/2026/07/29/0900Z/2026-07-29T0900.om")
    assert caught.value.status_code == 404


def test_an_old_client_editing_a_live_cache_dataset_does_not_turn_it_into_a_bake(runtime, dc):
    """jt rsmpwtmw's stale-client hazard. A frontend cached before `mode`/
    `implementation` existed renames a dataset and PUTs a body carrying
    neither; pydantic's defaults would then silently convert the boat's live
    weather cache into a bake, and a GRIB dataset back to Open-Meteo."""
    assert (
        dc.put(
            "/datasets/wx",
            json={
                "provider": "weather",
                "name": "Live weather",
                "mode": "live-cache",
                "params": {"domains": ["dwd_icon"]},
            },
        ).status_code
        == 200
    )
    assert (
        dc.put(
            "/datasets/wxg",
            json={
                "provider": "weather",
                "name": "GRIB",
                "implementation": "grib",
                "params": {"domains": ["dwd_icon_eu"]},
            },
        ).status_code
        == 200
    )

    # The old body: name only, no mode, no implementation.
    r = dc.put(
        "/datasets/wx",
        json={"provider": "weather", "name": "Renamed", "params": {"domains": ["dwd_icon"]}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["mode"] == "live-cache"

    # And for the GRIB one, `params` is validated against the catalog the
    # CARRIED-FORWARD implementation names — a product id legal only under
    # "grib" must not 422 just because the body omitted the field.
    r = dc.put(
        "/datasets/wxg",
        json={"provider": "weather", "name": "Renamed", "params": {"domains": ["dwd_icon_eu"]}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["implementation"] == "grib"

    # A NEW client still gets to change either, explicitly.
    r = dc.put(
        "/datasets/wx",
        json={
            "provider": "weather",
            "name": "Renamed",
            "mode": "bake",
            "params": {"domains": ["dwd_icon"]},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["mode"] == "bake"


def test_the_new_form_saving_an_UNTOUCHED_legacy_grib_dataset_keeps_it_grib(runtime, dc):
    """The most common real edit on a boat, and the one where three of jt
    rsmpwtmw's mechanisms have to line up at once.

    `DatasetEditForm` seeds its `implementation` signal from the dataset and
    ALWAYS sends it, so a dataset declared before the field existed produces a
    body with an EXPLICIT `"implementation": null` beside a `params` that still
    says `source: "grib"`. Explicit null means `model_fields_set` contains the
    key, so the carry-forward above deliberately does NOT fire — correctness
    rests entirely on the legacy `params.source` read
    (`sources.dataset_implementation`), in both the params validator and
    source resolution."""
    from mivnav.features.weather.mirror import WeatherMirror
    from mivnav.features.weather.sources import list_sources

    # A legacy declaration: the choice lives in params, nowhere else.
    runtime.patch_config(
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
    ds = next(d for d in runtime.config.get().datasets if d.id == "wx")
    assert ds.implementation is None

    # What the CURRENT form sends when only the name changed.
    r = dc.put(
        "/datasets/wx",
        json={
            "provider": "weather",
            "name": "Renamed",
            "implementation": None,
            "params": {"source": "grib", "domains": ["dwd_icon_eu"]},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["implementation"] is None

    # Still the GRIB backing, not an Open-Meteo mirror of the same-named
    # domain. `dwd_icon_eu` is a real id in BOTH catalogs (see
    # `sources.test.ts`'s "shares an id string" test), so the id prefix — not
    # the domain — is what tells the two apart.
    config = runtime.config.get()
    (src,) = list_sources(config, WeatherMirror([]))
    assert src.id.startswith("grib:"), src.id


def test_the_bake_trigger_honours_the_legacy_params_source_too():
    """The other door onto the same fact: `_weather_trigger` picks a
    sub-runner from `implementation`, and must fall back to `params.source`
    for a dataset that predates the field."""
    from mivnav.features.weather.provider import (
        WeatherAnyIngestRunner,
        WeatherDatasetParams,
        _weather_trigger,
    )

    class _Recorder(WeatherAnyIngestRunner):
        def __init__(self) -> None:  # no dataset dir needed — nothing runs
            self.om = object()
            self.grib = object()
            self.active = self.om

    runner = _Recorder()
    params = WeatherDatasetParams.model_validate({"source": "grib", "domains": ["dwd_icon_eu"]})
    try:
        _weather_trigger(runner, None, params, None)
    except AttributeError:
        pass  # the stub sub-runner has no ingest(); WHICH one was picked is the point
    assert runner.active is runner.grib
