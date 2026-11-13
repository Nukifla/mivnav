# SPDX-License-Identifier: GPL-2.0-only
"""``GET /datasets``, ``PUT /datasets/{id}``, ``POST /datasets/{id}/ingest``,
``DELETE /datasets/{id}`` — the generic, provider-agnostic declared-dataset
API. ``PUT`` (create-or-replace, never touches disk) is what lets the
frontend's DatasetListSection/DatasetEditForm declare a dataset before
ingesting it, superseding the old ad hoc ``/ingest/poi``/``/ingest/satellite``
trigger routes (retired alongside this).

Every test below builds its OWN isolated ``Runtime``/``TestClient`` (via
``isolated_runtime_at``, the same helper the session ``isolated_runtime``
fixture uses) rather than the shared session ``client`` fixture: these tests
mutate ``Config.datasets``, and ``client``'s Runtime is shared across the
whole test session — leaking a declared dataset into it would affect every
other test module. See conftest.py's ``isolated_runtime_at``.

Also covers the hard part this task exists for:
``DatasetRunnerManager``'s per-dataset-id diffing on top of ``Derived`` (an
edit to one dataset must not drop another, unrelated dataset's live runner).
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mivnav.api.app import app
from mivnav.api.deps import get_runtime
from tests.conftest import isolated_runtime_at


@pytest.fixture
def runtime(tmp_path: Path):
    rt = isolated_runtime_at(tmp_path)
    yield rt
    rt.close()


@pytest.fixture
def dc(runtime):
    """A TestClient wired to this test's OWN isolated Runtime.

    Restores whatever override was there before (the session ``client``
    fixture's own ``get_runtime`` override, set by conftest.py's autouse
    ``isolated_runtime``) rather than popping it unconditionally — this
    fixture is function-scoped, so an unconditional pop wipes the session
    override the moment the FIRST test using ``dc`` finishes, stranding
    every later test in the session with no ``get_runtime`` override at
    all (vyvqpxmn).
    """
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


def _poi_dataset(id_: str, **kw) -> dict:
    return {"id": id_, "provider": "poi", "name": id_, "region_id": "solent", **kw}


def _write_poi_set(runtime, set_id: str) -> Path:
    """Write a REAL, loadable PMTiles archive straight at the path
    ``PoiStore``'s nested-per-id scan requires: ``data_root/poi/<id>/
    <id>.pmtiles`` (see ``mivnav.rescan.pmtiles_candidates``) — a store only
    recognizes a nested file whose STEM matches its own parent directory
    name, so this writes it directly rather than going through
    ``PoiIngestRunner``/the generic ``POST /datasets/{id}/ingest`` trigger:
    that trigger names the archive off the RESOLVED REGION's own slug/ISO
    (``region_set_id``, ``mivnav.features.poi.ingest``), not the dataset's
    id, so it only happens to produce this shape when a region's slug is
    coincidentally the same string as the dataset id — not the general
    case, and not what an ORPHAN fixture (a set whose id IS its own
    filename, the actual legacy shape) needs to depend on."""
    import chartcore

    config = runtime.config.get()
    directory = config.data_root / "poi" / set_id
    directory.mkdir(parents=True)
    features = [(-1.30, 50.75, {"leisure": "marina", "name": "Stub Marina"})]
    chartcore.build_pmtiles(features, "pois", 0, 14, directory / f"{set_id}.pmtiles")
    return directory


# -- GET /datasets ------------------------------------------------------------


def test_list_datasets_empty_by_default(dc):
    assert dc.get("/datasets").json()["datasets"] == []


# -- GET /datasets's `providers` catalog (#pxxukylq) --------------------------
#
# The create/edit form's own data source for which providers it can offer
# and what to call them — replaces DatasetList.tsx's own hardcoded
# CREATABLE_PROVIDERS/PROVIDER_LABEL literals.


def test_providers_catalog_lists_the_built_in_dataset_providers(dc):
    # Plugins are off in the core suite; a plugin's providers join this list.
    ids = {p["id"] for p in dc.get("/datasets").json()["providers"]}
    assert ids == {"charts", "poi", "osm_world", "satellite", "ocharts", "notices"}


def test_providers_catalog_says_which_providers_have_a_live_cache(dc):
    by_id = {p["id"]: p for p in dc.get("/datasets").json()["providers"]}
    assert {i for i, p in by_id.items() if p["live_cache"]} == {"osm_world"}


def test_providers_catalog_marks_only_the_generic_bake_path_providers_creatable(dc):
    by_id = {p["id"]: p for p in dc.get("/datasets").json()["providers"]}
    assert by_id["poi"]["creatable"] is True
    assert by_id["osm_world"]["creatable"] is True
    assert by_id["satellite"]["creatable"] is True
    assert by_id["notices"]["creatable"] is True
    # o-charts declares an IngestSpec (bakeable, via its own standalone
    # Installer) but no runner_factory — not creatable through this generic
    # form (same 409 `put_dataset` gives).
    assert by_id["ocharts"]["creatable"] is False
    # the pre-baked chart store has no IngestSpec/bake path at all, and its
    # live registry id ("chart-store") never matches "charts" anyway.
    assert by_id["charts"]["creatable"] is False


def test_providers_catalog_reports_region_kind_off_the_live_ingest_spec(dc):
    # The map-bake providers are region-shaped — osm_world included
    # (task unqqplrl: a "bbox" IngestSpec whose region is OPTIONAL, None
    # meaning the whole world; see mivnav.features.osm_world.provider's
    # module docstring). Notices declare "none": their regions are the
    # source's own (params.regions), not Config.regions — DatasetEditForm
    # reads this to decide whether to show its Region <select> at all.
    by_id = {p["id"]: p for p in dc.get("/datasets").json()["providers"]}
    assert by_id["poi"]["region_kind"] == "bbox"
    assert by_id["osm_world"]["region_kind"] == "bbox"
    assert by_id["satellite"]["region_kind"] == "bbox"
    assert by_id["notices"]["region_kind"] == "none"


def test_providers_catalog_carries_the_live_registrys_own_labels(dc):
    by_id = {p["id"]: p for p in dc.get("/datasets").json()["providers"]}
    assert by_id["poi"]["label"] == "POI (points of interest)"
    assert by_id["satellite"]["label"] == "Satellite imagery"
    assert by_id["ocharts"]["label"] == "o-charts"


def test_providers_catalog_carries_per_implementation_labels(dc):
    # The dataset list shows "POI (OSM)" (or a plugin source's label) per row,
    # resolved from these + the row's `implementation` (null = the default,
    # OpenStreetMap). No plugins in the core suite: OSM alone.
    by_id = {p["id"]: p for p in dc.get("/datasets").json()["providers"]}
    poi = by_id["poi"]
    assert poi["implementation_labels"] == {"overpass": "POI (OSM)"}
    assert poi["default_implementation"] == "overpass"
    # every legal POI implementation has a label — a new source can't
    # silently fall back to the generic one
    from mivnav.features.poi.sources import implementations

    assert set(poi["implementation_labels"]) == set(implementations())
    # a single-source provider declares none and keeps its one label
    assert by_id["satellite"]["implementation_labels"] == {}
    assert by_id["satellite"]["default_implementation"] is None


def test_list_datasets_reports_config_fields_and_unbaked_status(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a")])
    entries = dc.get("/datasets").json()["datasets"]
    assert len(entries) == 1
    e = entries[0]
    assert e["id"] == "a"
    assert e["provider"] == "poi"
    assert e["name"] == "a"
    assert e["region_id"] == "solent"
    assert e["schedule"] == "manual"
    assert e["size"] == 0
    assert e["last_bake_at"] is None
    assert e["status"] == "unbaked"
    assert e["declared"] is True


# -- orphan poi/satellite sets: baked data with no DatasetConfig entry --------
#
# What PoiData.tsx's/SatelliteData.tsx's own GET /poi/catalog + GET
# /satellite/catalog used to list (retired alongside those sections) — see
# mivnav.api.datasets._orphan_entries's docstring for the full mechanism.


def test_orphan_poi_set_is_listed_as_undeclared(runtime, dc):
    _write_poi_set(runtime, "legacy")  # no config entry at all — a real legacy set

    entries = dc.get("/datasets").json()["datasets"]
    assert len(entries) == 1
    e = entries[0]
    assert e["id"] == "legacy"
    assert e["provider"] == "poi"
    assert e["declared"] is False
    assert e["status"] == "baked"  # a set only appears here once real+parsed
    assert e["size"] > 0
    assert e["region_id"] is None
    assert e["schedule"] == "manual"
    assert e["params"] == {}
    assert e["progress"] is None


def test_a_declared_datasets_own_baked_set_is_not_ALSO_listed_as_an_orphan(runtime, dc):
    """The (provider, id) match in `_orphan_entries` — not id alone — is what
    keeps a normally-declared, baked dataset from showing up TWICE."""
    _set_datasets(runtime, [_poi_dataset("a")])
    _write_poi_set(runtime, "a")
    entries = dc.get("/datasets").json()["datasets"]
    assert len(entries) == 1
    assert entries[0]["declared"] is True


def test_list_datasets_reports_baked_status_and_size_from_real_files_on_disk(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a")])
    config = runtime.config.get()
    directory = config.data_root / "poi" / "a"
    directory.mkdir(parents=True)
    (directory / "a.pmtiles").write_bytes(b"0123456789")

    e = dc.get("/datasets").json()["datasets"][0]
    assert e["size"] == 10
    assert e["last_bake_at"] is not None
    assert e["status"] == "baked"


def test_list_datasets_size_includes_this_datasets_share_of_the_shared_search_db(
    runtime, dc
):
    """qtvoomtq: POI ingest also writes into the SHARED search sqlite
    (mivnav.search, config.search.db_path) — outside the dataset's own
    directory, so `dataset_disk_stats` alone undercounts a real bake. `GET
    /datasets` must add this dataset's row-proportional share of that db's
    bytes (mivnav.config.dataset_layout.search_index_share) on top of the
    directory walk, not just report what happens to live in poi/a/."""
    from mivnav.search import SearchRecord

    _set_datasets(runtime, [_poi_dataset("a")])
    config = runtime.config.get()
    directory = config.data_root / "poi" / "a"
    directory.mkdir(parents=True)
    (directory / "a.pmtiles").write_bytes(b"0123456789")  # 10 bytes on disk

    index = runtime.search_index()
    records = [
        SearchRecord(id=str(i), category="marina", title=f"P{i}", text="", lat=0.0, lon=0.0)
        for i in range(5)
    ]
    index.rebake("poi", "a", records, updated_at=1.0)
    # WAL mode (SearchIndex.__init__) defers most writes into `-wal`, not
    # the main db file — the real on-disk footprint is main + wal + shm,
    # same as `search_index_share` itself sums.
    db_bytes = index.path.stat().st_size
    for suffix in ("-wal", "-shm"):
        p = index.path.with_name(index.path.name + suffix)
        if p.exists():
            db_bytes += p.stat().st_size
    assert db_bytes > 0  # the rebake actually wrote something to attribute

    e = dc.get("/datasets").json()["datasets"][0]
    assert e["size"] == 10 + db_bytes  # this dataset is the ONLY one in the index


def test_list_datasets_works_for_all_four_dataset_bearing_providers(runtime, dc):
    """``charts`` (the pre-baked chart store — no ``Feature``/``IngestSpec`` at
    all) and ``ocharts`` (a ``Feature`` with no ``runner_factory``) must show
    up in the generic listing exactly like poi/satellite, per this task's
    goal."""
    _set_datasets(
        runtime,
        [
            _poi_dataset("a"),
            {
                "id": "dk", "provider": "satellite", "name": "Denmark",
                "region_id": "solent", "params": {"source_id": "eox-sentinel2-cloudless"},
            },
            {"id": "US5OAKIQ", "provider": "charts", "name": "Oakland"},
            {"id": "some-set", "provider": "ocharts", "name": "Some Set"},
        ],
    )
    by_id = {e["id"]: e for e in dc.get("/datasets").json()["datasets"]}
    assert set(by_id) == {"a", "dk", "US5OAKIQ", "some-set"}
    for e in by_id.values():
        assert e["status"] == "unbaked"  # nothing on disk for any of them yet
        assert e["size"] == 0


# -- PUT /datasets/{id} --------------------------------------------------------


def test_put_creates_a_new_dataset(runtime, dc):
    body = {"provider": "poi", "name": "Solent POI", "region_id": "solent"}
    r = dc.put("/datasets/a", json=body)
    assert r.status_code == 200
    e = r.json()
    assert e["id"] == "a"
    assert e["provider"] == "poi"
    assert e["name"] == "Solent POI"
    assert e["region_id"] == "solent"
    assert e["schedule"] == "manual"
    assert e["status"] == "unbaked"
    assert {d.id for d in runtime.config.get().datasets} == {"a"}


def test_put_replaces_an_existing_dataset_without_dropping_others(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a"), _poi_dataset("b")])
    r = dc.put("/datasets/a", json={"provider": "poi", "name": "Renamed A", "region_id": "solent"})
    assert r.status_code == 200
    assert r.json()["name"] == "Renamed A"
    by_id = {d.id: d for d in runtime.config.get().datasets}
    assert by_id["a"].name == "Renamed A"
    assert by_id["b"].name == "b"  # untouched


def test_put_preserves_an_untouched_datasets_params(runtime, dc):
    """The whole-list PATCH round-trips every OTHER dataset's `params`
    verbatim — the data-loss hazard a client-side rebuild from the trimmed
    GET /datasets listing (no `params` in it) would risk."""
    _set_datasets(
        runtime,
        [
            {
                "id": "dk", "provider": "satellite", "name": "Denmark",
                "region_id": "solent", "params": {"source_id": "eox-sentinel2-cloudless"},
            },
        ],
    )
    dc.put("/datasets/a", json={"provider": "poi", "name": "A", "region_id": "solent"})
    by_id = {d.id: d for d in runtime.config.get().datasets}
    assert by_id["dk"].params == {"source_id": "eox-sentinel2-cloudless"}


def test_put_unknown_provider_is_422(dc):
    r = dc.put("/datasets/a", json={"provider": "nope", "name": "A"})
    assert r.status_code == 422


def test_put_ocharts_dataset_is_409_no_generic_bake_path(dc):
    r = dc.put("/datasets/x", json={"provider": "ocharts", "name": "X"})
    assert r.status_code == 409
    assert "ocharts" in r.json()["detail"]


def test_put_satellite_dataset_requires_source_id_param(dc):
    """`SatelliteDatasetParams.source_id` is required — an empty `params` 422s
    immediately, rather than only surfacing on the first POST .../ingest."""
    r = dc.put("/datasets/dk", json={"provider": "satellite", "name": "Denmark"})
    assert r.status_code == 422


def test_put_satellite_dataset_with_source_id_succeeds(dc):
    r = dc.put(
        "/datasets/dk",
        json={"provider": "satellite", "name": "Denmark", "params": {"source_id": "eox"}},
    )
    assert r.status_code == 200


def test_put_unknown_region_id_is_422_and_not_persisted(runtime, dc):
    r = dc.put("/datasets/a", json={"provider": "poi", "name": "A", "region_id": "Nonexistent"})
    assert r.status_code == 422
    assert runtime.config.get().datasets == ()


def test_put_never_touches_disk(runtime, dc):
    """Unlike DELETE, a PUT (create or replace) must not discard baked
    bytes — a rename/reschedule of an already-baked dataset leaves its
    directory untouched."""
    _set_datasets(runtime, [_poi_dataset("a")])
    config = runtime.config.get()
    directory = config.data_root / "poi" / "a"
    directory.mkdir(parents=True)
    (directory / "a.pmtiles").write_bytes(b"0123456789")

    r = dc.put("/datasets/a", json={"provider": "poi", "name": "Renamed", "region_id": "solent"})
    assert r.status_code == 200
    assert r.json()["size"] == 10  # the file survived
    assert (directory / "a.pmtiles").exists()


# -- POST /datasets/{id}/ingest ------------------------------------------------


def test_ingest_unknown_dataset_is_404(dc):
    assert dc.post("/datasets/nope/ingest").status_code == 404


def test_ingest_ocharts_dataset_is_409_no_generic_trigger(runtime, dc):
    """o-charts' Installer stays standalone; the generic trigger must refuse
    it with a clear pointer at the real surface, not silently no-op."""
    _set_datasets(runtime, [{"id": "x", "provider": "ocharts", "name": "X"}])
    r = dc.post("/datasets/x/ingest")
    assert r.status_code == 409
    assert "ocharts" in r.json()["detail"]


def test_a_dataset_with_an_unknown_region_id_cannot_even_be_declared(runtime):
    """``Config`` itself cross-checks ``region_id`` against ``Config.regions``
    at write time (see ``DatasetConfig``'s own docstring) — so
    ``resolve_dataset_region``'s ``UnknownDatasetRegion`` (exercised directly
    in test_providers.py) can never actually surface through ``POST
    /datasets/{id}/ingest``: a dataset naming an unknown region is rejected
    before it is ever persisted, not at ingest time."""
    from mivnav.config.store import ConfigError

    with pytest.raises(ConfigError, match="unknown region"):
        _set_datasets(runtime, [_poi_dataset("a", region_id="Nonexistent")])


def test_ingest_poi_dataset_bakes_for_real_with_overpass_stubbed(runtime, dc, monkeypatch):
    """End to end through the generic route: a declared POI dataset's own
    region_id drives the bake (no request body), the same way ``/ingest/poi``
    already does for an ad hoc region — Overpass fetch stubbed, mapping/bake/
    invalidate run for real."""
    import time

    from mivnav.features.poi import overpass

    stub_elements = [
        {
            "type": "node", "id": 1, "lat": 50.75, "lon": -1.30,
            "tags": {"leisure": "marina", "name": "Stub Marina"},
        },
    ]

    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        return stub_elements

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    _set_datasets(runtime, [_poi_dataset("a")])

    resp = dc.post("/datasets/a/ingest")
    assert resp.status_code == 200
    assert resp.json()["state"] in ("fetch", "bake", "done")

    deadline = time.time() + 10.0
    entry = None
    while time.time() < deadline:
        entry = dc.get("/datasets").json()["datasets"][0]
        if entry["status"] in ("baked", "error"):
            break
        time.sleep(0.02)
    assert entry["status"] == "baked", entry

    config = runtime.config.get()
    # baked into THIS dataset's own directory, not the provider root
    assert any((config.data_root / "poi" / "a").glob("*.pmtiles"))

    # The archive is named after the dataset's OWN id, not the region it
    # resolved to (region_id="solent" bakes a bbox region with no name set,
    # which mivnav.features.poi.ingest.region_set_id would otherwise slug to
    # "custom") — wptyyquu: a mismatch here makes the freshly-baked archive
    # invisible to PoiStore's nested-layout rescan even though the bake
    # itself succeeded.
    assert (config.data_root / "poi" / "a" / "a.pmtiles").is_file()

    # And therefore it actually SHOWS UP on the catalog the map overlay and
    # /poi/tiles read — not just in the directory-agnostic /datasets listing.
    catalog = dc.get("/poi/catalog").json()
    assert [s["id"] for s in catalog["sets"]] == ["a"]

    # GET /datasets carries the progress blob too — the settled log-delivery
    # design (append to this SAME polled entry, no separate endpoint): a
    # finished bake's log/counts are still readable on the next list read.
    progress = entry["progress"]
    assert progress is not None
    assert progress["state"] == "done"
    assert progress["current"] == progress["total"] > 0
    assert len(progress["log"]) > 0


def test_ingest_poi_dataset_with_stacked_duplicate_osm_nodes_bakes(runtime, dc, monkeypatch):
    """The user-facing "OSM poi bake is broken": through the generic route
    (whose runner feeds the shared search index), two same-kind OSM nodes on
    one coordinate — present in every real region — failed the bake with
    "UNIQUE constraint failed: records.id". Both must bake AND be searchable."""
    import time

    from mivnav.features.poi import overpass

    stacked = [
        {"type": "node", "id": n, "lat": 50.75, "lon": -1.30,
         "tags": {"amenity": "restaurant", "name": "Twin Pizza"}}
        for n in (1, 2)
    ]
    monkeypatch.setattr(overpass, "fetch_pois", lambda *a, **k: stacked)
    monkeypatch.setattr("mivnav.features.poi.ingest._keep_coastal_land", lambda f: f)
    _set_datasets(runtime, [_poi_dataset("a")])

    assert dc.post("/datasets/a/ingest").status_code == 200
    deadline = time.time() + 10.0
    entry = None
    while time.time() < deadline:
        entry = dc.get("/datasets").json()["datasets"][0]
        if entry["status"] in ("baked", "error"):
            break
        time.sleep(0.02)
    assert entry["status"] == "baked", entry
    assert "indexed 2 features for search" in entry["progress"]["log"]
    assert entry["progress"]["log"][-1].startswith("finished in ")
    hits = runtime.search_index().search(source="poi", limit=10)
    assert [h["title"] for h in hits] == ["Twin Pizza", "Twin Pizza"]


def test_progress_is_none_for_ocharts_charts_and_a_never_baked_dataset(runtime, dc):
    """`progress` is `None` for: o-charts (no per-dataset `IngestRunner` — its
    `Installer` is a different shape, keyed on nothing dataset-specific — see
    `_progress`'s docstring), `charts` (no `IngestSpec`/runner at all), and a
    declared-but-never-baked poi/satellite dataset (`state == "idle"`, nothing
    to show yet)."""
    _set_datasets(
        runtime,
        [
            _poi_dataset("a"),
            {"id": "US5OAKIQ", "provider": "charts", "name": "Oakland"},
            {"id": "some-set", "provider": "ocharts", "name": "Some Set"},
        ],
    )
    by_id = {e["id"]: e for e in dc.get("/datasets").json()["datasets"]}
    for e in by_id.values():
        assert e["progress"] is None, e


# -- POST /datasets/{id}/ingest/cancel (jt lvpkxtsr) ---------------------------


def test_cancel_unknown_dataset_is_404(dc):
    assert dc.post("/datasets/nope/ingest/cancel").status_code == 404


def test_cancel_ocharts_dataset_is_409_no_generic_runner(runtime, dc):
    _set_datasets(runtime, [{"id": "x", "provider": "ocharts", "name": "X"}])
    r = dc.post("/datasets/x/ingest/cancel")
    assert r.status_code == 409


def test_cancel_with_nothing_running_is_409(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a")])
    r = dc.post("/datasets/a/ingest/cancel")
    assert r.status_code == 409
    assert "no bake is currently running" in r.json()["detail"]


def test_cancel_stops_a_running_bake_status_ends_up_error_not_stuck_baking(
    runtime, dc, monkeypatch
):
    """The end-to-end case this task exists for: a real bake thread is
    running (Overpass fetch stubbed to block until released, simulating a
    slow fetch), `POST .../ingest/cancel` asks it to stop, and — even though
    POI's own fetch has no cooperative checkpoint mid-call — the runner's
    `_run_guarded` notices the cancel flag once the (now-released) fetch
    call returns and reports `"error"`/`"cancelled"`, never a `"baking"`
    that never settles."""
    import threading
    import time

    from mivnav.features.poi import overpass

    proceed = threading.Event()
    fetch_started = threading.Event()

    def blocking_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        fetch_started.set()
        proceed.wait(5.0)
        return []

    monkeypatch.setattr(overpass, "fetch_pois", blocking_fetch)
    _set_datasets(runtime, [_poi_dataset("a")])

    resp = dc.post("/datasets/a/ingest")
    assert resp.status_code == 200
    assert fetch_started.wait(5.0), "bake never reached the stubbed fetch"

    r = dc.post("/datasets/a/ingest/cancel")
    assert r.status_code == 200
    proceed.set()  # let the (now-cancelled) fetch return so the thread can finish

    deadline = time.time() + 10.0
    entry = None
    while time.time() < deadline:
        entry = dc.get("/datasets").json()["datasets"][0]
        if entry["status"] in ("baked", "error"):
            break
        time.sleep(0.02)
    assert entry["status"] == "error", entry
    assert entry["progress"]["error"] == "cancelled"


# -- POST /datasets/{id}/enable, /disable (jt lvpkxtsr) ------------------------


def test_disable_unknown_dataset_is_404(dc):
    assert dc.post("/datasets/nope/disable").status_code == 404


def test_enable_unknown_dataset_is_404(dc):
    assert dc.post("/datasets/nope/enable").status_code == 404


def test_dataset_defaults_to_enabled(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a")])
    assert dc.get("/datasets").json()["datasets"][0]["enabled"] is True


def test_disable_then_enable_round_trips_and_is_idempotent(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a")])
    r = dc.post("/datasets/a/disable")
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    assert dc.get("/datasets").json()["datasets"][0]["enabled"] is False

    r = dc.post("/datasets/a/disable")  # idempotent no-op
    assert r.status_code == 200
    assert r.json()["enabled"] is False

    r = dc.post("/datasets/a/enable")
    assert r.status_code == 200
    assert r.json()["enabled"] is True
    assert dc.get("/datasets").json()["datasets"][0]["enabled"] is True


def test_disable_refuses_while_ingest_is_running(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a")])
    runner = runtime.dataset_runner("a")
    runner.busy = lambda: True  # simulate a live bake without spawning a thread

    r = dc.post("/datasets/a/disable")
    assert r.status_code == 409
    assert dc.get("/datasets").json()["datasets"][0]["enabled"] is True  # unchanged


def test_ingest_a_disabled_dataset_is_409(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a")])
    dc.post("/datasets/a/disable")
    r = dc.post("/datasets/a/ingest")
    assert r.status_code == 409
    assert "disabled" in r.json()["detail"]


def test_put_preserves_disabled_state_across_an_edit(runtime, dc):
    """jt lvpkxtsr: `PUT` has no `enabled` field of its own (toggling is a
    separate endpoint) — a rename/reschedule must not silently re-enable a
    disabled dataset by omission."""
    _set_datasets(runtime, [_poi_dataset("a")])
    dc.post("/datasets/a/disable")
    r = dc.put("/datasets/a", json={"provider": "poi", "name": "Renamed", "region_id": "solent"})
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    assert dc.get("/datasets").json()["datasets"][0]["enabled"] is False


def test_disabling_a_baked_dataset_hides_it_from_serving_but_keeps_the_files(
    runtime, dc, monkeypatch
):
    """The other half of this task's goal: disabling must exclude a dataset
    from serving (the provider's own store scan — here osm_world's
    `/osm_world/catalog`) while its baked bytes stay on disk, and re-enabling
    must make it visible again WITHOUT a re-bake (no second extract).

    Uses the ``osm_world`` provider, not ``poi``: its runner factory pins the
    baked filename to the dataset's own id (``_osm_world_runner_factory``'s
    ``dataset_id=dataset_dir.name``), so the archive actually lands where the
    serving store's nested-layout matcher (``mivnav.rescan.pmtiles_candidates``)
    can find it. POI/satellite still have that filename-mismatch bug (tracked
    separately as wptyyquu, out of this task's scope) — a POI dataset named
    after a region bakes under the REGION's slug, not its own id, so it would
    never show up in ``/poi/catalog`` keyed by id regardless of anything this
    task changes. (This test used the retired ``osm`` provider for the same
    reason until task unqqplrl removed it.)

    The bake is faked at the ``subprocess.Popen`` seam rather than the
    ``run_extract`` one: this goes through the GENERIC dataset route, whose
    runner is built by ``_osm_world_runner_factory`` with ``run_extract``'s
    import-time-bound default — see
    ``test_run_pmtiles_extract_passes_minzoom_maxzoom_as_cli_flags`` for the
    same reasoning.
    """
    import time

    import chartcore

    from mivnav.features.osm_world import ingest as osm_world_ingest

    extract_calls = []

    class _FakePopen:
        """Writes an actually-valid (tiny) PMTiles archive where the real
        ``pmtiles extract`` argv says its output goes, so the serving store's
        rescan can open it for real."""

        def __init__(self, args, **kwargs):
            extract_calls.append(args)
            self.args = args
            out = Path(args[3])
            zoom = {a.split("=")[0]: int(a.split("=")[1]) for a in args[4:]}
            chartcore.build_vector_pmtiles(
                point_layers=[("places", [(-1.3, 50.7, {"kind": "locality", "name": "Testland"})])],
                line_layers=[],
                min_zoom=zoom["--minzoom"],
                max_zoom=zoom["--maxzoom"],
                out=out,
            )

        def communicate(self):
            return "", "Extract required 5 total requests.\n"

        returncode = 0

    def fake_resolve(http, build_host, *, today, lookback_days):
        return f"{build_host}/20260726.pmtiles", "20260726"

    monkeypatch.setattr(osm_world_ingest.subprocess, "Popen", _FakePopen)
    monkeypatch.setattr(osm_world_ingest, "resolve_build_url", fake_resolve)
    _set_datasets(runtime, [{"id": "a", "provider": "osm_world", "name": "a"}])
    dc.post("/datasets/a/ingest")

    deadline = time.time() + 10.0
    entry = dc.get("/datasets").json()["datasets"][0]
    while time.time() < deadline and entry["status"] not in ("baked", "error"):
        time.sleep(0.02)
        entry = dc.get("/datasets").json()["datasets"][0]
    assert entry["status"] == "baked", entry
    assert len(extract_calls) == 1

    catalog_ids = {s["id"] for s in dc.get("/osm_world/catalog").json()["sets"]}
    assert "a" in catalog_ids

    # Force the osm_world store's rescan interval past so a stale scan can't
    # hide a real bug: OsmWorldRuntime's own store is built with the default
    # (5s) interval through the normal Runtime path (unlike the
    # direct-construction tests elsewhere that pass rescan_interval=0), so
    # `/disable` itself must be the thing that makes this take effect
    # immediately (`_invalidate`).
    r = dc.post("/datasets/a/disable")
    assert r.status_code == 200

    catalog_ids = {s["id"] for s in dc.get("/osm_world/catalog").json()["sets"]}
    assert "a" not in catalog_ids, "a disabled dataset must not still be served"

    config = runtime.config.get()
    directory = config.data_root / "osm_world" / "a"
    assert any(directory.glob("*.pmtiles")), "disabling must not touch the baked files"

    r = dc.post("/datasets/a/enable")
    assert r.status_code == 200
    catalog_ids = {s["id"] for s in dc.get("/osm_world/catalog").json()["sets"]}
    assert "a" in catalog_ids, "re-enabling must make it visible again"
    assert len(extract_calls) == 1, "re-enabling must not trigger a re-bake"


# -- DELETE /datasets/{id} -----------------------------------------------------


def test_delete_unknown_dataset_is_404(dc):
    assert dc.delete("/datasets/nope").status_code == 404


def test_delete_removes_config_entry_and_folder(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a"), _poi_dataset("b")])
    config = runtime.config.get()
    directory = config.data_root / "poi" / "a"
    directory.mkdir(parents=True)
    (directory / "a.pmtiles").write_bytes(b"x")

    r = dc.delete("/datasets/a")
    assert r.status_code == 200
    assert r.json() == {"deleted": "a"}
    assert not directory.exists()

    remaining = {e["id"] for e in dc.get("/datasets").json()["datasets"]}
    assert remaining == {"b"}


def test_delete_dataset_that_never_baked_still_removes_config_entry(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a")])
    r = dc.delete("/datasets/a")
    assert r.status_code == 200
    assert dc.get("/datasets").json()["datasets"] == []


def test_delete_falls_back_to_an_orphan_poi_set(runtime, dc):
    """DELETE /datasets/{id} covers an UNDECLARED poi set too — the
    DELETE /poi/sets/{id} capability PoiData.tsx used to be the only caller
    of, now reachable through the generic list as well."""
    directory = _write_poi_set(runtime, "legacy")
    assert directory.exists()

    r = dc.delete("/datasets/legacy?provider=poi")
    assert r.status_code == 200
    assert r.json() == {"deleted": "legacy"}
    assert not directory.exists()
    assert dc.get("/datasets").json()["datasets"] == []


def test_delete_orphan_set_works_without_the_provider_hint_too(runtime, dc):
    _write_poi_set(runtime, "legacy")

    r = dc.delete("/datasets/legacy")
    assert r.status_code == 200
    assert dc.get("/datasets").json()["datasets"] == []


def test_delete_with_provider_disambiguates_an_id_collision(runtime, dc):
    """An orphan poi set can share an id with a DECLARED dataset under a
    DIFFERENT provider (the id predates this project's cross-provider
    uniqueness rule) — `provider` picks the right one instead of whichever
    the lookup happens to hit first."""
    _write_poi_set(runtime, "x")
    _set_datasets(
        runtime,
        [{"id": "x", "provider": "satellite", "name": "X", "params": {"source_id": "eox"}}],
    )
    entries = {e["provider"]: e for e in dc.get("/datasets").json()["datasets"]}
    assert entries["satellite"]["declared"] is True
    assert entries["poi"]["declared"] is False

    r = dc.delete("/datasets/x?provider=poi")
    assert r.status_code == 200

    remaining = dc.get("/datasets").json()["datasets"]
    assert len(remaining) == 1
    assert remaining[0]["provider"] == "satellite"  # the declared one survived
    assert {d.id for d in runtime.config.get().datasets} == {"x"}


def test_delete_refuses_while_ingest_is_running(runtime, dc):
    _set_datasets(runtime, [_poi_dataset("a")])
    runner = runtime.dataset_runner("a")
    assert runner is not None
    runner.busy = lambda: True  # simulate a live bake without spawning a thread

    r = dc.delete("/datasets/a")
    assert r.status_code == 409
    # config entry survives a refused delete
    assert {e["id"] for e in dc.get("/datasets").json()["datasets"]} == {"a"}


# -- DatasetRunnerManager: the per-id diff on top of Derived (the hard part) --


def test_editing_one_dataset_does_not_replace_an_unrelated_datasets_runner(runtime):
    _set_datasets(runtime, [_poi_dataset("a"), _poi_dataset("b")])
    runner_a1 = runtime.dataset_runner("a")
    runner_b1 = runtime.dataset_runner("b")
    assert runner_a1 is not None and runner_b1 is not None

    # Edit only "a" (rename); "b" is untouched.
    _set_datasets(runtime, [_poi_dataset("a", name="Renamed A"), _poi_dataset("b")])

    runner_a2 = runtime.dataset_runner("a")
    runner_b2 = runtime.dataset_runner("b")
    assert runner_a2 is not runner_a1  # "a" changed -> rebuilt
    assert runner_b2 is runner_b1  # "b" unchanged -> SAME object, not rebuilt


def test_data_root_move_rebuilds_every_datasets_runner(runtime, tmp_path):
    _set_datasets(runtime, [_poi_dataset("a"), _poi_dataset("b")])
    runner_a1 = runtime.dataset_runner("a")
    runner_b1 = runtime.dataset_runner("b")

    new_root = tmp_path / "new-data-root"
    runtime.patch_config({"data_root": str(new_root)})

    assert runtime.dataset_runner("a") is not runner_a1
    assert runtime.dataset_runner("b") is not runner_b1


def test_dataset_runner_is_none_for_ocharts_and_removed_datasets(runtime):
    _set_datasets(runtime, [{"id": "x", "provider": "ocharts", "name": "X"}])
    assert runtime.dataset_runner("x") is None
    assert runtime.dataset_runner("does-not-exist") is None


def test_dropping_a_busy_runner_on_edit_logs_a_warning(runtime, caplog):
    _set_datasets(runtime, [_poi_dataset("a")])
    runner = runtime.dataset_runner("a")
    runner.busy = lambda: True  # simulate a live bake

    with caplog.at_level(logging.WARNING):
        _set_datasets(runtime, [_poi_dataset("a", name="Renamed")])
        assert runtime.dataset_runner("a") is not runner

    assert any("still running" in r.message for r in caplog.records)
