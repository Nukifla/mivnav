# SPDX-License-Identifier: GPL-2.0-only
"""End-to-end POI ingest job, with the Overpass fetch stubbed.

Drives ``PoiIngestRunner.ingest()`` directly (poll ``runner.status()``) with
the network fetch monkeypatched to a canned Overpass ``elements`` blob, and
asserts a real ``pois.pmtiles`` is baked into the POI dir, the job reaches
``done``, and the new set becomes visible through the POI catalog (the store
was invalidated, still exercised over HTTP via the surviving ``/poi/catalog``/
``/poi/sets/{id}`` routes). Never hits the real Overpass API.

Drove the now-retired ``POST|GET /ingest/poi`` HTTP routes until those were
replaced by the generic ``PUT /datasets/{id}`` + ``POST
/datasets/{id}/ingest`` (mivnav.api.datasets) — this file still needs to
cover ``PoiIngestRunner``'s own behaviour (config-driven URL/zooms, search
index feed, country/bbox naming+slugging, coastal filtering), which the
generic route does not re-test in that depth, so the ad hoc HTTP layer was
dropped from these tests and the runner is now driven directly instead.
"""

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

STUB_ELEMENTS = [
    {
        "type": "node",
        "id": 1,
        "lat": 50.75,
        "lon": -1.30,
        "tags": {"leisure": "marina", "name": "Stub Marina"},
    },
    {
        "type": "node",
        "id": 2,
        "lat": 50.70,
        "lon": -1.20,
        "tags": {"waterway": "fuel", "name": "Stub Fuel"},
    },
    {
        "type": "way",
        "id": 3,
        "center": {"lat": 50.72, "lon": -1.25},
        "tags": {"seamark:type": "anchorage"},
    },
]


@pytest.fixture
def ingest_client(tmp_path: Path, monkeypatch, isolated_runtime):
    """A TestClient wired to a real PoiStore (so the surviving ``/poi/catalog``
    route can see what a directly-driven ``PoiIngestRunner`` bakes into it) —
    ``get_poi_ingest_runner`` is gone along with the routes it fed, so the
    runner itself is just a plain local object these tests call directly."""
    from mivnav.api.app import app
    from mivnav.features.poi.routes import get_poi_store
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    poi_dir = tmp_path / "poi"
    poi_dir.mkdir()
    store = PoiStore(poi_dir, rescan_interval=0)  # rescan every access
    runner = PoiIngestRunner(store)

    # Stub the network half; the mapping + bake + invalidate run for real.
    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        return STUB_ELEMENTS

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)

    app.dependency_overrides[get_poi_store] = lambda: store
    with TestClient(app) as c:
        yield c, poi_dir, runner
    app.dependency_overrides.pop(get_poi_store, None)


def _wait_done(runner, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = runner.status()
        if status["state"] in ("done", "error"):
            return status
        time.sleep(0.02)
    raise AssertionError("POI ingest did not finish in time")


def test_status_idle_before_any_run(ingest_client):
    _, _, runner = ingest_client
    assert runner.status()["state"] == "idle"


def test_post_bakes_pmtiles_and_reaches_done(ingest_client):
    _, poi_dir, runner = ingest_client
    runner.ingest(bbox=(-1.65, 50.68, -1.05, 50.82))

    status = _wait_done(runner)
    assert status["state"] == "done", status
    assert status["feature_count"] == 3
    assert status["tile_count"] > 0
    # An explicit bbox with no named region bakes to the fallback "custom" set
    # (per-region output), not the old anonymous pois.pmtiles.
    assert (poi_dir / "custom.pmtiles").is_file()
    assert (poi_dir / "custom.json").is_file()
    # Progress reporting (BaseJobStatus.task/current/total/log): the finished
    # job's last stage reached 100% and the log recorded real activity, not
    # just the coarse fetch/bake phase boundaries.
    assert status["current"] == status["total"] > 0
    assert len(status["log"]) > 0
    assert any("wrote" in line for line in status["log"])


def test_fetch_stage_ticks_elapsed_time_while_the_overpass_call_blocks(
    tmp_path: Path, monkeypatch
):
    """qtvoomtq: the fetch stage otherwise sits on a bare, unchanging
    "fetching" label for the whole (possibly long) Overpass wait — no sign
    of whether it's stuck or just slow. A heartbeat thread should tick
    `task` with elapsed seconds while the blocking network call is in
    flight, then get out of the way once the next stage starts."""
    import re

    from mivnav.features.poi import ingest as ingest_mod
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    # Real seconds would make this test slow; shrink the tick interval so a
    # handful land during a short, deliberately-blocking stub fetch.
    monkeypatch.setattr(ingest_mod, "FETCH_HEARTBEAT_S", 0.01)

    poi_dir = tmp_path / "poi"
    poi_dir.mkdir()
    store = PoiStore(poi_dir, rescan_interval=0)
    runner = PoiIngestRunner(store)

    seen_tasks: list[str] = []

    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        for _ in range(30):
            time.sleep(0.02)
            seen_tasks.append(runner.status()["task"])
        return STUB_ELEMENTS

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)

    runner.ingest(bbox=(-1.65, 50.68, -1.05, 50.82))
    status = _wait_done(runner)
    assert status["state"] == "done", status

    # At least one tick during the fetch shows a distinct "fetching… Ns"
    # label — not just the static initial "fetching".
    assert any(re.match(r"^fetching… \d+s$", t) for t in seen_tasks), seen_tasks
    # `current`/`total` stay indeterminate during the fetch — elapsed
    # seconds are not a stage size.
    assert status["current"] == status["total"] > 0  # true once the bake finishes
    # The finished job's task moved past "fetching" — a late heartbeat tick
    # landing after the fetch returns must not stomp the next stage's label.
    assert not status["task"].startswith("fetching")


def test_baked_set_is_served_through_the_catalog(ingest_client):
    client, _, runner = ingest_client
    runner.ingest(bbox=(-1.65, 50.68, -1.05, 50.82))
    _wait_done(runner)
    # The store was invalidated, so the fresh archive is now discoverable.
    sets = client.get("/poi/catalog").json()["sets"]
    ids = {s["id"] for s in sets}
    assert "custom" in ids
    baked = next(s for s in sets if s["id"] == "custom")
    # The INTERNAL vector-layer id stays "pois" regardless of the set id.
    layers = {v["id"] for v in baked["vector_layers"]}
    assert layers == {"pois"}


def test_default_bbox_when_body_omitted(ingest_client):
    _, poi_dir, runner = ingest_client
    runner.ingest()
    status = _wait_done(runner)
    assert status["state"] == "done"
    # The first configured region is the default bbox region named "Solent";
    # an omitted bbox/country bakes it to its own per-region set (slug of the
    # name).
    assert (poi_dir / "solent.pmtiles").is_file()
    assert (poi_dir / "solent.json").is_file()


def test_bake_uses_config_provided_url_and_zooms(tmp_path: Path, monkeypatch):
    """The runner reads overpass_url / min_zoom / max_zoom from the PoiConfig
    it is bound to, at bake start — the configured URL is what fetch_pois is
    called with, and the configured zooms are what build_pmtiles receives."""
    import chartcore

    from mivnav.config.model import Region
    from mivnav.features.poi.config import PoiConfig
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    cfg = PoiConfig(
        overpass_url="https://overpass.example/api",
        min_zoom=7,
        max_zoom=9,
    )
    regions = (Region(id="test", name="Test", min_lon=1.0, min_lat=2.0, max_lon=3.0, max_lat=4.0),)
    (tmp_path / "poi").mkdir()
    store = PoiStore(tmp_path / "poi", rescan_interval=0)
    runner = PoiIngestRunner(store, poi_config=lambda: cfg, regions=lambda: regions)

    seen: dict = {}

    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        seen["url"] = url
        seen["bbox"] = bbox
        return STUB_ELEMENTS

    def fake_build(features, layer, min_zoom, max_zoom, out):
        seen["zooms"] = (min_zoom, max_zoom)
        seen["layer"] = layer
        return 1

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    monkeypatch.setattr(chartcore, "build_pmtiles", fake_build)

    # Omitted bbox → the first configured region.
    assert runner.default_bbox == (1.0, 2.0, 3.0, 4.0)
    runner.ingest()
    for _ in range(500):
        if runner.status()["state"] in ("done", "error"):
            break
        time.sleep(0.01)
    assert runner.status()["state"] == "done", runner.status()
    assert seen["url"] == "https://overpass.example/api"
    assert seen["bbox"] == (1.0, 2.0, 3.0, 4.0)
    assert seen["zooms"] == (7, 9)
    assert seen["layer"] == "pois"


def test_runtime_wires_the_real_search_index_into_the_poi_ingest_runner(
    tmp_path: Path, monkeypatch
):
    """The production wiring (mivnav.api.deps.Runtime), not a hand-built
    PoiIngestRunner: Runtime.ingest_runner("poi") must bind the SAME
    SearchIndex instance Runtime.search_index() returns, so a bake through
    the real composition root is actually searchable afterwards. Every other
    test here either hand-builds the runner or overrides get_search_index —
    none of them would catch `search_index` going missing from
    PoiRuntime.ingest_runner (mivnav/features/poi/runtime.py)."""
    from mivnav.api.deps import Runtime
    from mivnav.config import ConfigStore, LayoutStore, ProfileStore
    from mivnav.features.poi import overpass
    from mivnav.features.route.store import RouteStore

    config = ConfigStore(tmp_path / "config.json")
    config.patch(
        {
            # M-DATA-3: no more `poi.dir` — the POI store's directory is
            # `data_root/poi`.
            "data_root": str(tmp_path / "data"),
            "search": {"db_path": str(tmp_path / "search" / "index.sqlite3")},
            "signalk": {"enabled": False},
        }
    )
    runtime = Runtime(
        config,
        ProfileStore(tmp_path / "profiles.json"),
        RouteStore(),  # no route storage: nothing here touches routes
        LayoutStore(tmp_path / "layouts.json"),
    )

    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        return STUB_ELEMENTS

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)

    runner = runtime.feature("poi").ingest_runner()
    runner.ingest(bbox=(-1.65, 50.68, -1.05, 50.82))
    for _ in range(500):
        if runner.status()["state"] in ("done", "error"):
            break
        time.sleep(0.01)
    assert runner.status()["state"] == "done", runner.status()

    # The SAME Derived-built SearchIndex the runner just baked into is what
    # the composition root hands out — a search through it sees the bake.
    results = runtime.search_index().search(source="poi")
    titles = sorted(r["title"] for r in results if r["title"] is not None)
    assert titles == ["Stub Fuel", "Stub Marina"]
    runtime.close()


def test_bake_feeds_the_shared_search_index(tmp_path: Path, monkeypatch):
    """A bake also rebakes the shared search index (mivnav.search), for the
    (source="poi", region=<set id>) slice — searchable by name and category
    independently of tile rendering."""
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore
    from mivnav.search import SearchIndex

    poi_dir = tmp_path / "poi"
    poi_dir.mkdir()
    store = PoiStore(poi_dir, rescan_interval=0)
    index = SearchIndex(tmp_path / "search.sqlite3")
    runner = PoiIngestRunner(store, search_index=lambda: index)

    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        return STUB_ELEMENTS

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)

    runner.ingest(bbox=(-1.65, 50.68, -1.05, 50.82))
    for _ in range(500):
        if runner.status()["state"] in ("done", "error"):
            break
        time.sleep(0.01)
    assert runner.status()["state"] == "done", runner.status()

    results = index.search(source="poi")
    assert len(results) == 3  # marina, fuel, anchorage
    titles = sorted(r["title"] for r in results if r["title"] is not None)
    assert titles == ["Stub Fuel", "Stub Marina"]
    marina = next(r for r in results if r["title"] == "Stub Marina")
    assert marina["category"] == "marina"
    assert marina["region"] == "custom"  # explicit bbox, no named region
    assert marina["data"]["kind"] == "marina"

    # A category-only element (no name) is still indexed, with a null title.
    anchorage = next(r for r in results if r["category"] == "anchorage")
    assert anchorage["title"] is None
    index.close()


def test_rebake_replaces_the_same_regions_search_rows(tmp_path: Path, monkeypatch):
    """Re-running the same bbox bake replaces its search rows in place rather
    than accumulating duplicates."""
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore
    from mivnav.search import SearchIndex

    poi_dir = tmp_path / "poi"
    poi_dir.mkdir()
    store = PoiStore(poi_dir, rescan_interval=0)
    index = SearchIndex(tmp_path / "search.sqlite3")
    runner = PoiIngestRunner(store, search_index=lambda: index)

    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        return STUB_ELEMENTS

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)

    for _ in range(2):
        runner.ingest(bbox=(-1.65, 50.68, -1.05, 50.82))
        for _ in range(500):
            if runner.status()["state"] in ("done", "error"):
                break
            time.sleep(0.01)
        assert runner.status()["state"] == "done", runner.status()

    assert len(index.search(source="poi", limit=100)) == 3
    index.close()


def _node(id_, lon, lat, tags):
    return {"type": "node", "id": id_, "lat": lat, "lon": lon, "tags": tags}


# A country bake, area disabled: one POI well inside Denmark (Aarhus) and one in
# a neighbour far outside the buffer (central Germany). Both are marinas so
# map_elements keeps them; the clip must drop the German one.
_DK_IN = _node(1, 10.20, 56.15, {"leisure": "marina", "name": "Aarhus Marina"})
# Outside DK but still COASTAL (Gothenburg, SE): the country boundary clip drops
# it (>15 km from DK), yet the coast filter would keep it — so it distinguishes
# "area path skips the country clip" from "coast filter", now that marine POIs
# are coast-filtered too.
_DE_OUT = _node(2, 11.97, 57.70, {"leisure": "marina", "name": "Swedish Marina"})


def _run_country_bake(tmp_path, monkeypatch, *, use_area: bool):
    """Drive one country ('DK') bake, returning (seen, status). Both Overpass
    fetch functions are stubbed so nothing hits the network; `seen` records
    which path was taken and with what args."""
    import chartcore

    from mivnav.config.model import Region
    from mivnav.features.poi.config import PoiConfig
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    cfg = PoiConfig(
        overpass_use_area=use_area,
    )
    regions = (Region(id="denmark", name="Denmark", country="DK"),)
    (tmp_path / "poi").mkdir()
    store = PoiStore(tmp_path / "poi", rescan_interval=0)
    runner = PoiIngestRunner(store, poi_config=lambda: cfg, regions=lambda: regions)

    seen: dict = {}

    def fake_bbox_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        seen["bbox_called"] = True
        seen.setdefault("bboxes", []).append(bbox)
        return [_DK_IN, _DE_OUT]

    def fake_area_fetch(http, iso, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        seen["area_called"] = True
        seen["iso"] = iso
        return [_DK_IN, _DE_OUT]

    def fake_build(features, layer, min_zoom, max_zoom, out):
        seen["baked"] = list(features)
        return 1

    monkeypatch.setattr(overpass, "fetch_pois", fake_bbox_fetch)
    monkeypatch.setattr(overpass, "fetch_pois_area", fake_area_fetch)
    monkeypatch.setattr(chartcore, "build_pmtiles", fake_build)

    runner.ingest()
    for _ in range(500):
        if runner.status()["state"] in ("done", "error"):
            break
        time.sleep(0.01)
    return seen, runner.status()


def test_country_bake_bbox_fallback_fetches_bbox_and_clips(tmp_path, monkeypatch):
    """overpass_use_area=False: a country region fetches via the bbox path
    (the country's enclosing box) and clips the results to the boundary — the
    out-of-country neighbour is dropped, the in-country POI survives."""
    from mivnav.features.poi import overpass
    from mivnav.geo import countries

    seen, status = _run_country_bake(tmp_path, monkeypatch, use_area=False)
    assert status["state"] == "done", status
    # Took the bbox path with the country's enclosing box, NOT the area path.
    assert seen.get("bbox_called") is True
    assert seen.get("area_called") is None
    # ... fetched as the tiles of that box (DK's is 7 x 3.1 deg: 2 x 2), each
    # tile returning the same two stub nodes, deduped back to one of each.
    assert seen["bboxes"] == overpass.split_bbox(countries.country_bbox("DK"))
    assert len(seen["bboxes"]) == 4
    # Country clip dropped the Swedish marina (outside DK); only the Danish one
    # is baked.
    baked_names = [props.get("name") for _, _, props in seen["baked"]]
    assert baked_names == ["Aarhus Marina"]
    assert status["feature_count"] == 1


def test_country_bake_uses_area_path_by_default(tmp_path, monkeypatch):
    """overpass_use_area=True (default): a country region still uses the
    boundary-area fetch and does NOT clip — existing behaviour, no regression."""
    seen, status = _run_country_bake(tmp_path, monkeypatch, use_area=True)
    assert status["state"] == "done", status
    assert seen.get("area_called") is True
    assert seen.get("bbox_called") is None
    assert seen["iso"] == "DK"
    # No country clip on the area path: the Swedish marina (outside DK) survives,
    # which it would NOT under the bbox-fallback's boundary clip. Both are coastal
    # so the coast filter keeps them; this isolates "area path skips country clip".
    baked_names = sorted(props.get("name") for _, _, props in seen["baked"])
    assert baked_names == ["Aarhus Marina", "Swedish Marina"]
    assert status["feature_count"] == 2


# A coastal-filter bake. Rule: everything is kept only near the coast, with no
# exception (task nvpxzxxq retired the settlement-name carve-out along with the
# categories it applied to). Real coords against the bundled coastline: coastal
# at Aarhus (10.20,56.15), inland in central Germany (9.0,50.0).
_COASTAL_MARINA = _node(1, 10.20, 56.15, {"leisure": "marina", "name": "Harbour Marina"})
_INLAND_MARINA = _node(2, 9.0, 50.0, {"leisure": "marina", "name": "Lake Marina"})
_COASTAL_SHOP = _node(3, 10.20, 56.15, {"shop": "supermarket", "name": "Harbour Foods"})
_INLAND_SHOP = _node(4, 9.0, 50.0, {"shop": "supermarket", "name": "Inland Foods"})
# Settlement nodes: no longer a POI category at all, so neither survives the
# mapping stage, let alone the coastal filter.
_COASTAL_TOWN = _node(5, 10.20, 56.15, {"place": "town", "name": "Harbour Town"})
_INLAND_CITY = _node(6, 9.0, 50.0, {"place": "city", "name": "Inland City"})


def test_bake_coast_filters_every_kind_and_drops_settlements(tmp_path, monkeypatch):
    """The coastal filter keeps a POI only when it is near the coast — a marina
    or shop deep inland is dropped, their coastal counterparts survive — and it
    applies to every kind alike. Settlement nodes never reach it: they are not a
    POI category any more (their names come from the basemap now)."""
    import chartcore

    from mivnav.config.model import Region
    from mivnav.features.poi.config import PoiConfig
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    cfg = PoiConfig()
    regions = (Region(id="test", name="Test", min_lon=8.0, min_lat=48.0, max_lon=12.0, max_lat=58.0),)
    (tmp_path / "poi").mkdir()
    store = PoiStore(tmp_path / "poi", rescan_interval=0)
    runner = PoiIngestRunner(store, poi_config=lambda: cfg, regions=lambda: regions)

    seen: dict = {}

    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        return [
            _COASTAL_MARINA,
            _INLAND_MARINA,
            _COASTAL_SHOP,
            _INLAND_SHOP,
            _COASTAL_TOWN,
            _INLAND_CITY,
        ]

    def fake_build(features, layer, min_zoom, max_zoom, out):
        seen["baked"] = list(features)
        return 1

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    monkeypatch.setattr(chartcore, "build_pmtiles", fake_build)

    runner.ingest()
    for _ in range(500):
        if runner.status()["state"] in ("done", "error"):
            break
        time.sleep(0.01)
    status = runner.status()
    assert status["state"] == "done", status
    baked_names = sorted(props.get("name") for _, _, props in seen["baked"])
    # Coastal marina + coastal shop kept; inland marina + inland shop DROPPED;
    # both settlement nodes gone regardless of where they sit.
    assert baked_names == ["Harbour Foods", "Harbour Marina"]
    assert status["feature_count"] == 2


# --- Named per-region sets: id from country ISO / bbox-name slug, sidecar
# metadata (name/region/updated_at), independent sets, delete, fallbacks. ---

# Coastal marinas (map_elements keeps a marina; the coast filter keeps it): one
# inside Denmark, one in the Solent. Real coords against the bundled coastline.
_DK_COASTAL = _node(10, 10.20, 56.15, {"leisure": "marina", "name": "Aarhus Marina"})
_GB_COASTAL = _node(11, -1.30, 50.75, {"leisure": "marina", "name": "Solent Marina"})


@pytest.fixture
def region_client(tmp_path: Path, monkeypatch, isolated_runtime):
    """A TestClient wired to a real PoiStore, plus a plain ``PoiIngestRunner``
    driven directly (no HTTP trigger route survives it). Both Overpass fetches
    are stubbed to return a settable canned element list; the config slice the
    runner reads is settable too. build_pmtiles runs for real, so a real
    per-region archive lands on disk and flows through the surviving
    catalog/delete HTTP routes."""
    from mivnav.api.app import app
    from mivnav.features.poi.routes import get_poi_store
    from mivnav.config.model import Region
    from mivnav.features.poi.config import PoiConfig
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    poi_dir = tmp_path / "poi"
    poi_dir.mkdir()
    store = PoiStore(poi_dir, rescan_interval=0)
    state = {"cfg": PoiConfig(), "regions": (Region(id="solent"),), "elements": [_DK_COASTAL]}
    runner = PoiIngestRunner(
        store, poi_config=lambda: state["cfg"], regions=lambda: state["regions"]
    )

    def fake_area(http, iso, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        return state["elements"]

    def fake_bbox(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        return state["elements"]

    monkeypatch.setattr(overpass, "fetch_pois_area", fake_area)
    monkeypatch.setattr(overpass, "fetch_pois", fake_bbox)

    app.dependency_overrides[get_poi_store] = lambda: store
    with TestClient(app) as c:
        yield c, poi_dir, state, runner
    app.dependency_overrides.pop(get_poi_store, None)


def _catalog_set(client, set_id):
    sets = client.get("/poi/catalog").json()["sets"]
    return next(s for s in sets if s["id"] == set_id)


def test_country_bake_writes_named_per_region_set(region_client):
    from mivnav.geo import countries

    _, poi_dir, state, runner = region_client
    state["elements"] = [_DK_COASTAL]
    runner.ingest(country="DK")
    status = _wait_done(runner)
    assert status["state"] == "done", status
    assert (poi_dir / "dk.pmtiles").is_file()
    meta = json.loads((poi_dir / "dk.json").read_text())
    assert meta["name"] == countries.country_name("DK")
    assert meta["country"] == "DK"
    assert meta["bbox"] is None
    assert meta["updated_at"]  # ISO-8601 timestamp


def test_second_country_adds_independent_set(region_client):
    client, poi_dir, state, runner = region_client
    state["elements"] = [_DK_COASTAL]
    runner.ingest(country="DK")
    _wait_done(runner)
    state["elements"] = [_GB_COASTAL]
    runner.ingest(country="GB")
    _wait_done(runner)
    # Both sets present and independent — the second did not overwrite the first.
    ids = {s["id"] for s in client.get("/poi/catalog").json()["sets"]}
    assert {"dk", "gb"} <= ids
    assert (poi_dir / "dk.pmtiles").is_file() and (poi_dir / "dk.json").is_file()
    assert (poi_dir / "gb.pmtiles").is_file() and (poi_dir / "gb.json").is_file()


def test_rebake_overwrites_in_place_and_bumps_updated_at(region_client):
    _, poi_dir, state, runner = region_client
    state["elements"] = [_DK_COASTAL]
    runner.ingest(country="DK")
    _wait_done(runner)
    first = json.loads((poi_dir / "dk.json").read_text())["updated_at"]
    time.sleep(0.01)
    runner.ingest(country="DK")
    _wait_done(runner)
    second = json.loads((poi_dir / "dk.json").read_text())["updated_at"]
    assert second != first and second >= first  # bumped (ISO-8601 sorts lexically)
    assert len(list(poi_dir.glob("dk.pmtiles"))) == 1  # overwrote in place


def test_catalog_exposes_name_updated_at_region(region_client):
    from mivnav.geo import countries

    client, _, state, runner = region_client
    state["elements"] = [_DK_COASTAL]
    runner.ingest(country="DK")
    _wait_done(runner)
    s = _catalog_set(client, "dk")
    assert s["name"] == countries.country_name("DK")
    assert s["region"] == {"country": "DK"}
    assert s["updated_at"]
    # Existing fields still present, so the overlay keeps working.
    assert s["tiles"] == "/poi/tiles/dk/{z}/{x}/{y}"
    assert isinstance(s["sequence"], int) and s["sequence"] > 0


def test_delete_removes_pmtiles_and_sidecar_leaving_other(region_client):
    client, poi_dir, state, runner = region_client
    state["elements"] = [_DK_COASTAL]
    runner.ingest(country="DK")
    _wait_done(runner)
    state["elements"] = [_GB_COASTAL]
    runner.ingest(country="GB")
    _wait_done(runner)

    r = client.delete("/poi/sets/dk")
    assert r.status_code == 200
    assert not (poi_dir / "dk.pmtiles").exists()
    assert not (poi_dir / "dk.json").exists()  # sidecar removed, no orphan
    # The other set survives untouched.
    assert (poi_dir / "gb.pmtiles").exists() and (poi_dir / "gb.json").exists()
    assert {s["id"] for s in client.get("/poi/catalog").json()["sets"]} == {"gb"}


def test_bbox_region_bakes_to_slug_set_with_region_name(region_client):
    from mivnav.config.model import Region

    client, poi_dir, state, runner = region_client
    state["regions"] = (
        Region(
            id="solent-area",
            name="Solent Area",
            min_lon=-1.65,
            min_lat=50.68,
            max_lon=-1.05,
            max_lat=50.82,
        ),
    )
    state["elements"] = [_GB_COASTAL]
    runner.ingest()  # neither bbox nor country → first configured region
    _wait_done(runner)
    assert (poi_dir / "solent-area.pmtiles").is_file()
    meta = json.loads((poi_dir / "solent-area.json").read_text())
    assert meta["name"] == "Solent Area"
    assert meta["country"] is None
    assert meta["bbox"] == [-1.65, 50.68, -1.05, 50.82]
    s = _catalog_set(client, "solent-area")
    assert s["name"] == "Solent Area"
    assert s["region"] == {"bbox": [-1.65, 50.68, -1.05, 50.82]}


# --- the "OSM poi bake is broken" regressions ----------------------------------

# Two same-kind OSM nodes stacked on ONE coordinate — real data: the
# "Denmark 2026" box has 7 such pairs (e.g. two "Flua Pizza" restaurant nodes,
# 14031162201 and 14031166601, at 7.993790,58.147353).
_STACKED = [
    {"type": "node", "id": 14031162201, "lat": 58.147353, "lon": 7.99379,
     "tags": {"amenity": "restaurant", "name": "Flua Pizza"}},
    {"type": "node", "id": 14031166601, "lat": 58.147353, "lon": 7.99379,
     "tags": {"amenity": "restaurant", "name": "Flua Pizza"}},
    *STUB_ELEMENTS,
]


def _bake_bbox(runner, bbox=(-1.65, 50.68, -1.05, 50.82)) -> dict:
    runner.ingest(bbox=bbox)
    return _wait_done(runner)


def test_stacked_duplicate_nodes_do_not_fail_the_search_rebake(tmp_path: Path, monkeypatch):
    """Two features with the same kind + coordinate used to make the search
    rebake die with "UNIQUE constraint failed: records.id" (its id was kind +
    coordinate), failing the whole bake after the tiles were written. Every
    big-enough OSM area has such pairs, so every real region bake failed once
    the generic-dataset runner started feeding search."""
    import chartcore

    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore
    from mivnav.search import SearchIndex

    monkeypatch.setattr(overpass, "fetch_pois", lambda *a, **k: _STACKED)
    monkeypatch.setattr(chartcore, "build_pmtiles", lambda *a, **k: 1)
    (tmp_path / "poi").mkdir()
    index = SearchIndex(tmp_path / "search.sqlite3")
    runner = PoiIngestRunner(
        PoiStore(tmp_path / "poi", rescan_interval=0), search_index=lambda: index
    )

    status = _bake_bbox(runner)
    assert status["state"] == "done", status
    rows = index.search(source="poi", limit=100)
    assert len(rows) == len(_STACKED)  # both stacked nodes indexed, nothing lost
    assert sorted(r["title"] for r in rows if r["title"] == "Flua Pizza") == ["Flua Pizza"] * 2
    assert len({r["id"] for r in rows}) == len(rows)
    index.close()


def test_a_search_index_failure_is_a_warning_and_the_set_is_still_published(
    tmp_path: Path, monkeypatch
):
    """Search is a side index: by the time it runs the tiles and sidecar are
    on disk. A failure there must not report the bake failed (and leave the
    set unpublished until some later rescan) — it is a logged warning."""
    import chartcore

    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    class BrokenIndex:
        def rebake(self, *a, **k):
            raise RuntimeError("disk full")

    published: list[bool] = []
    monkeypatch.setattr(overpass, "fetch_pois", lambda *a, **k: STUB_ELEMENTS)
    monkeypatch.setattr(chartcore, "build_pmtiles", lambda *a, **k: 1)
    (tmp_path / "poi").mkdir()
    runner = PoiIngestRunner(
        PoiStore(tmp_path / "poi", rescan_interval=0),
        search_index=lambda: BrokenIndex(),
        on_published=lambda: published.append(True),
    )

    status = _bake_bbox(runner)
    assert status["state"] == "done", status
    assert published == [True]
    warning = [line for line in status["log"] if line.startswith("warning:")]
    assert len(warning) == 1 and "search indexing failed (disk full)" in warning[0]


def test_a_large_bbox_is_fetched_tile_by_tile_and_deduped(tmp_path: Path, monkeypatch):
    """A bbox bigger than one Overpass tile is fetched as its
    ``overpass.split_bbox`` tiles, in order, merged and deduped by OSM
    (type, id) — a way on a shared edge comes back from both tiles."""
    import chartcore

    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    box = (3.2485062, 54.3641714, 16.5106873, 58.260919)  # "Denmark 2026"
    calls: list = []

    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, **kwargs):
        calls.append(bbox)
        # Each tile: the shared way, plus one node of its own.
        own = {"type": "node", "id": 100 + len(calls), "lat": 55.0, "lon": 10.0,
               "tags": {"leisure": "marina", "name": f"Marina {len(calls)}"}}
        shared = {"type": "way", "id": 7, "center": {"lat": 55.5, "lon": 11.0},
                  "tags": {"leisure": "marina", "name": "Edge Marina"}}
        return [shared, own]

    baked: dict = {}

    def fake_build(features, layer, min_zoom, max_zoom, out):
        baked["features"] = list(features)
        return 1

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    monkeypatch.setattr(chartcore, "build_pmtiles", fake_build)
    monkeypatch.setattr("mivnav.features.poi.ingest._keep_coastal_land", lambda f: f)
    (tmp_path / "poi").mkdir()
    runner = PoiIngestRunner(PoiStore(tmp_path / "poi", rescan_interval=0))

    status = _bake_bbox(runner, box)
    assert status["state"] == "done", status
    assert calls == overpass.split_bbox(box)
    n = len(calls)
    assert n == 8
    names = sorted(p["name"] for _, _, p in baked["features"])
    assert names.count("Edge Marina") == 1  # deduped across tiles
    assert len(names) == n + 1
    assert f"tile {n}/{n}: 2 elements" in status["log"]
    assert f"{n} tiles: {2 * n} elements, {n - 1} tile-edge duplicates dropped" in status["log"]
    assert "fetched 9 raw elements from Overpass" in status["log"]


def test_one_failing_tile_fails_the_bake_with_the_overpass_reason(tmp_path: Path, monkeypatch):
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    calls: list = []

    def fake_fetch(http, bbox, **kwargs):
        calls.append(bbox)
        if len(calls) == 3:
            raise overpass.OverpassError("Overpass returned 504 for https://x")
        return STUB_ELEMENTS

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    (tmp_path / "poi").mkdir()
    runner = PoiIngestRunner(PoiStore(tmp_path / "poi", rescan_interval=0))

    status = _bake_bbox(runner, (3.2485062, 54.3641714, 16.5106873, 58.260919))
    assert status["state"] == "error"
    assert "504" in status["error"]
    assert len(calls) == 3  # stops at the failing tile
    assert not any((tmp_path / "poi").glob("*.pmtiles"))
    # …but keeps the two tiles it did fetch for the next attempt.
    assert "kept 2/8 fetched tiles; the next bake of this dataset resumes from them" in status["log"]


# --- resume: a failed tiled bake's fetched tiles are not thrown away ------------

DK_BOX = (3.2485062, 54.3641714, 16.5106873, 58.260919)  # "Denmark 2026", 8 tiles


def _tile_element(bbox) -> dict:
    """One distinct marina per tile, at the tile's centre (so it is coastal
    enough for nothing — the tests stub the coastal filter)."""
    lon, lat = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    return {"type": "node", "id": int(lon * 1000) * 100000 + int(lat * 1000), "lat": lat,
            "lon": lon, "tags": {"leisure": "marina", "name": f"M {lon:.2f} {lat:.2f}"}}


@pytest.fixture
def resume_env(tmp_path: Path, monkeypatch):
    import chartcore

    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    state = {"calls": [], "fail_at": None}

    def fake_fetch(http, bbox, **kwargs):
        state["calls"].append(bbox)
        if state["fail_at"] is not None and bbox == overpass.split_bbox(DK_BOX)[state["fail_at"]]:
            raise overpass.OverpassError("Overpass returned 504 from overpass-api.de")
        return [_tile_element(bbox)]

    baked: dict = {}

    def fake_build(features, layer, min_zoom, max_zoom, out):
        baked["features"] = list(features)
        Path(out).write_bytes(b"x")
        return 1

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    monkeypatch.setattr(chartcore, "build_pmtiles", fake_build)
    monkeypatch.setattr("mivnav.features.poi.ingest._keep_coastal_land", lambda f: f)
    root = tmp_path / "poi"
    root.mkdir()
    runner = PoiIngestRunner(PoiStore(root, rescan_interval=0), dataset_id="poi-dk")
    return runner, root, state, baked


def test_a_failed_tile_keeps_the_rest_and_the_next_bake_fetches_only_the_missing(resume_env):
    from mivnav.features.poi import overpass

    runner, root, state, baked = resume_env
    tiles = overpass.split_bbox(DK_BOX)
    state["fail_at"] = 7  # the boat's case: tiles 1-7 fetched, tile 8 504s
    status = _bake_bbox(runner, DK_BOX)
    assert status["state"] == "error" and "504" in status["error"]
    resume = root / "poi-dk.overpass-resume.json"
    assert resume.is_file()
    assert sorted(json.loads(resume.read_text())["tiles"]) == [str(i) for i in range(7)]

    state["fail_at"] = None
    state["calls"].clear()
    status = _bake_bbox(runner, DK_BOX)
    assert status["state"] == "done", status
    assert state["calls"] == [tiles[7]]  # only the missing tile
    assert any(line.startswith("resuming: 7/8 tiles from the previous attempt")
               for line in status["log"]), status["log"]
    assert len(baked["features"]) == 8  # all eight tiles' points baked
    assert not resume.exists()  # spent: removed after the publish


def test_a_stale_or_foreign_resume_file_is_ignored(resume_env, monkeypatch):
    from mivnav.features.poi import overpass, overpass_resume

    runner, root, state, baked = resume_env
    state["fail_at"] = 7
    _bake_bbox(runner, DK_BOX)
    resume = root / "poi-dk.overpass-resume.json"
    doc = json.loads(resume.read_text())
    # Stale: every kept tile older than the resume window.
    for tile in doc["tiles"].values():
        tile["fetched_at"] -= overpass_resume.RESUME_MAX_AGE_S + 60
    resume.write_text(json.dumps(doc))
    state["fail_at"] = None
    state["calls"].clear()
    status = _bake_bbox(runner, DK_BOX)
    assert status["state"] == "done", status
    assert state["calls"] == overpass.split_bbox(DK_BOX)  # everything fetched again
    assert not any(line.startswith("resuming") for line in status["log"])

    # Corrupt, and another grid's file: both read as "nothing to resume".
    for content in ("{not json", json.dumps({**doc, "key": "another grid"})):
        resume.write_text(content)
        state["calls"].clear()
        assert _bake_bbox(runner, DK_BOX)["state"] == "done"
        assert len(state["calls"]) == 8
        assert not resume.exists()


def test_deleting_the_set_deletes_its_resume_file(tmp_path: Path, monkeypatch):
    """Else a nested dataset folder could never be removed (rmdir on a
    non-empty dir) and ~MBs of stale Overpass JSON would stay behind."""
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    fail = {"on": False}

    def fake_fetch(http, bbox, **kwargs):
        if fail["on"] and bbox == overpass.split_bbox(DK_BOX)[-1]:
            raise overpass.OverpassError("Overpass returned 504 from overpass-api.de")
        return [_tile_element(bbox)]

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    monkeypatch.setattr("mivnav.features.poi.ingest._keep_coastal_land", lambda f: f)
    root = tmp_path / "poi" / "poi-dk"
    root.mkdir(parents=True)
    store = PoiStore(root, rescan_interval=0)
    runner = PoiIngestRunner(store, dataset_id="poi-dk")
    assert _bake_bbox(runner, DK_BOX)["state"] == "done"
    fail["on"] = True
    assert _bake_bbox(runner, DK_BOX)["state"] == "error"
    assert (root / "poi-dk.overpass-resume.json").is_file()
    assert store.delete("poi-dk")
    assert not (root / "poi-dk.overpass-resume.json").exists()


def test_resume_file_round_trip_and_atomic_write(tmp_path: Path):
    from mivnav.features.poi import overpass_resume as r

    path = r.resume_path(tmp_path, "s")
    now = 1_000_000.0
    r.save(path, "k", {0: (now - 10, [{"id": 1}]), 2: (now - r.RESUME_MAX_AGE_S - 1, [{"id": 2}])})
    assert r.load(path, "k", 3, now) == {0: (now - 10, [{"id": 1}])}  # tile 2 is stale
    assert r.load(path, "other", 3, now) == {}
    assert r.load(path, "k", 1, now) == {0: (now - 10, [{"id": 1}])}  # out-of-grid index dropped
    assert [p.name for p in tmp_path.iterdir()] == ["s.overpass-resume.json"]  # no temp left
    assert r.load(tmp_path / "missing.json", "k", 3, now) == {}


def test_a_retry_notice_shows_in_the_progress_text_at_once(tmp_path: Path, monkeypatch):
    """A long busy wait must read as one ("…: Overpass busy (504) …, retry
    2/4 in 60s"), not as a fetch stuck for minutes."""
    from mivnav.features.poi import overpass
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    (tmp_path / "poi").mkdir()
    runner = PoiIngestRunner(PoiStore(tmp_path / "poi", rescan_interval=0))
    seen: list[str] = []

    def fake_fetch(http, bbox, on_retry=None, **kwargs):
        on_retry("Overpass busy (504) at overpass-api.de, retry 2/4 in 60s")
        seen.append(runner.status()["task"])
        return STUB_ELEMENTS

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    monkeypatch.setattr("mivnav.features.poi.ingest._keep_coastal_land", lambda f: f)
    status = _bake_bbox(runner, DK_BOX)
    assert status["state"] == "done", status
    assert seen[-1] == "fetching tile 8/8: Overpass busy (504) at overpass-api.de, retry 2/4 in 60s"
    assert "Overpass busy (504) at overpass-api.de, retry 2/4 in 60s" in status["log"]


def test_the_next_tile_starts_on_the_server_that_answered(tmp_path: Path, monkeypatch):
    from mivnav.features.poi import overpass
    from mivnav.features.poi.config import PoiConfig
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    cfg = PoiConfig(overpass_url="https://a/api", overpass_fallback_urls=("https://b/api", "https://c/api"))
    orders: list[list[str]] = []

    def fake_fetch(http, bbox, url, fallback_urls=(), on_server=None, **kwargs):
        orders.append([url, *fallback_urls])
        on_server("https://b/api")  # the primary is down: b answers
        return STUB_ELEMENTS

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    monkeypatch.setattr("mivnav.features.poi.ingest._keep_coastal_land", lambda f: f)
    (tmp_path / "poi").mkdir()
    runner = PoiIngestRunner(PoiStore(tmp_path / "poi", rescan_interval=0), poi_config=lambda: cfg)
    assert _bake_bbox(runner, DK_BOX)["state"] == "done"
    assert orders[0] == ["https://a/api", "https://b/api", "https://c/api"]
    assert all(o == ["https://b/api", "https://a/api", "https://c/api"] for o in orders[1:])


# --- a bbox region baked from the Datasets tab keeps its region's name ---------


@pytest.mark.parametrize("implementation", [None, "overpass"])
def test_generic_trigger_passes_the_bbox_regions_name(implementation):
    """The generic ``/datasets/{id}/ingest`` trigger hands the runner an
    explicit ``bbox`` — which alone carries no name, so the set used to bake
    as "Custom". It must pass the region's own name, however the
    implementation is spelled (every source shares ``ingest``)."""
    from mivnav.config.model import BBox as RegionBox, Region
    from mivnav.features.poi.provider import _poi_trigger

    calls: list[dict] = []

    class _Recorder:
        def ingest(self, **kw):
            calls.append(kw)

    dk = Region(id="denmark-2026", name="Denmark 2026",
                bboxes=(RegionBox(min_lon=7.5, min_lat=54.4, max_lon=15.3, max_lat=58.0),))
    _poi_trigger(_Recorder(), dk, None, implementation)  # type: ignore[arg-type]
    assert calls[0]["name"] == "Denmark 2026"
    assert calls[0]["bbox"] == (7.5, 54.4, 15.3, 58.0)
    assert calls[0]["country"] is None

    # A country region's name is still the country's.
    _poi_trigger(_Recorder(), Region(id="dk", name="whatever", country="DK"), None, implementation)  # type: ignore[arg-type]
    assert calls[1]["country"] == "DK"
    assert calls[1]["name"] == "Denmark"


def test_explicit_bbox_bake_takes_the_given_name(region_client):
    client, poi_dir, state, runner = region_client
    state["elements"] = [_GB_COASTAL]
    runner.ingest(bbox=(-1.65, 50.68, -1.05, 50.82), name="Denmark 2026")
    st = _wait_done(runner)
    assert st["state"] == "done", st
    assert json.loads((poi_dir / "custom.json").read_text())["name"] == "Denmark 2026"
    assert _catalog_set(client, "custom")["name"] == "Denmark 2026"
    # Without a name an explicit bbox still falls back to "Custom".
    runner.ingest(bbox=(-1.65, 50.68, -1.05, 50.82))
    _wait_done(runner)
    assert json.loads((poi_dir / "custom.json").read_text())["name"] == "Custom"
