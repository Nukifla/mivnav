# SPDX-License-Identifier: GPL-2.0-only
"""The ``mivport`` POI source end to end against a fake mivport server
(``httpx.MockTransport``): export → region cull → ``/v1/changes`` catch-up
→ reviews/photos → tiles, details file, photo files, and the routes."""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import time
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

import mivnav.config  # noqa: F401 — import order, as in the host tests
from mivnav.feature import params_context
from mivnav.features.poi.provider import PoiDatasetParams
from mivnav.features.poi.sources import implementations
from mivnav.features.poi.mivport import source as mp_source
from mivnav.features.poi.mivport import store as mp_store
from mivnav.features.poi.mivport.mapping import host_kind, normalize, point_feature
from mivnav.features.poi.mivport.source import MivportDatasetParams, pick_exports

BASE = "http://mivport.test"
P1 = "11111111-1111-1111-1111-111111111111"  # core marina, Aarhus, links osm:w5
P2 = "22222222-2222-2222-2222-222222222222"  # core anchorage, deleted after the export
P3 = "33333333-3333-3333-3333-333333333333"  # created after the export, links osm:n2
PH = "44444444-4444-4444-4444-444444444444"  # P1's photo


def _feature(pid, kind, lon, lat, **props):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"id": pid, "kind": kind, **props},
    }


EXPORT = [
    _feature(P1, "marina", 10.22, 56.15, name="Aarhus Marina", source="core",
             attrs={"vhf": "12", "electricity": True}, osm_type="way", osm_id=5,
             osm_tags={"leisure": "marina"}, osm_attrs={"website": "https://example.org"}),
    _feature(P2, "anchorage", 10.5, 56.0, name="Old Cove", source="core", attrs={}),
    _feature("osm:n1", "toilets", 10.23, 56.151, source="osm", osm_type="node", osm_id=1,
             osm_tags={"amenity": "toilets"}),
    _feature("osm:n2", "anchorage", 10.6, 56.2, name="OSM Cove", source="osm",
             osm_type="node", osm_id=2),
    _feature("osm:n3", "harbour_office", 10.221, 56.149, source="osm"),
    _feature("osm:n9", "marina", 11.97, 57.70, name="Gothenburg", source="osm"),  # SE
    {"type": "Feature", "geometry": None, "properties": {"id": "bad", "kind": "marina"}},
]


def _gz_lines(rows) -> bytes:
    return gzip.compress("".join(json.dumps(r) + "\n" for r in rows).encode())


class FakeMivport:
    def __init__(self) -> None:
        self.export = list(EXPORT)
        self.reviews = [
            {"id": "r1", "place_id": P1, "user": "anna", "stars": 4, "body": "Nice",
             "created_at": "2026-11-01T10:00:00Z"},
            {"id": "r2", "place_id": "99999999-9999-9999-9999-999999999999", "user": "x", "stars": 1},
        ]
        self.photos = [{"id": PH, "place_id": P1, "user": "anna"}]
        self.changes = [
            {"seq": 11, "place_id": P2, "status": "deleted",
             "search": {"id": P2, "status": "deleted"}},
            {"seq": 12, "place_id": P3, "status": "active",
             "search": {"id": P3, "status": "active", "osm_id": "osm:n2"}},
        ]
        self.places = {
            P2: (410, _feature(P2, "anchorage", 10.5, 56.0, status="deleted", source="core")),
            P3: (200, _feature(P3, "anchorage", 10.6, 56.2, name="OSM Cove", source="core",
                               attrs={"protection": {"N": "good"}},
                               osm={"type": "node", "id": 2, "tags": {"seamark:type": "anchorage"}})),
        }
        self.requests: list[str] = []
        self.fail_media = False
        #: Also export ``all`` cut into GRID-degree cells, as mivport does.
        self.grid = False

    GRID = 2

    def _cells(self) -> dict[str, list[dict]]:
        cells: dict[str, list[dict]] = {}
        for f in self.export:
            if f.get("geometry"):
                lon, lat = f["geometry"]["coordinates"]
                x, y = math.floor(lon / self.GRID) * self.GRID, math.floor(lat / self.GRID) * self.GRID
                cells.setdefault(f"grid/{x}_{y}.geojsonl.gz", []).append(f)
        return cells

    def files(self) -> dict[str, bytes]:
        out = {
            "all.geojsonl.gz": _gz_lines(self.export),
            "dump/reviews.jsonl.gz": _gz_lines(self.reviews),
            "dump/photos.jsonl.gz": _gz_lines(self.photos),
        }
        if self.grid:
            out.update({path: _gz_lines(rows) for path, rows in self._cells().items()})
        return out

    def _entry(self, path: str, body: bytes) -> dict:
        entry = {"path": path, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        if path.startswith("grid/"):
            x, y = (int(v) for v in path.removeprefix("grid/").removesuffix(".geojsonl.gz").split("_"))
            entry["bbox"] = [x, y, x + self.GRID, y + self.GRID]
        return entry

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requests.append(path)
        files = self.files()
        if path == "/exports/manifest.json":
            return httpx.Response(200, json={
                "core_seq": 10,
                "attribution": "© OSM; © mivport",
                **({"grid_deg": self.GRID} if self.grid else {}),
                "files": [self._entry(p, b) for p, b in files.items()],
            })
        if path.startswith("/exports/"):
            body = files.get(path.removeprefix("/exports/"))
            return httpx.Response(200, content=body) if body else httpx.Response(404)
        if path == "/v1/changes":
            since = int(request.url.params.get("since", 0))
            revs = [r for r in self.changes if r["seq"] > since]
            return httpx.Response(200, json={
                "revisions": revs, "next_since": max([since, *(r["seq"] for r in revs)]), "more": False,
            })
        if path == f"/v1/places/{P1}/photos":
            return httpx.Response(200, json={"photos": [{
                "id": PH, "user": "anna", "caption": "Pier",
                "urls": {"view": f"/media/photos/{PH}/view.jpg", "thumb": f"/media/photos/{PH}/thumb.jpg"},
                "attribution": "© anna, CC BY-SA 4.0",
                "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
            }]})
        if path.startswith("/v1/places/") and path.endswith("/photos"):
            return httpx.Response(200, json={"photos": []})
        if path.startswith("/v1/places/"):
            pid = path.removeprefix("/v1/places/")
            if pid not in self.places:
                return httpx.Response(404)
            status, feature = self.places[pid]
            return httpx.Response(status, json={"feature": feature})
        if path.startswith("/media/photos/"):
            if self.fail_media:
                return httpx.Response(500)
            return httpx.Response(200, content=b"\xff\xd8jpeg" + path.encode(),
                                  headers={"content-type": "image/jpeg"})
        return httpx.Response(404)


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setattr(mp_source, "REQUEST_INTERVAL_S", 0.0)
    return FakeMivport()


@pytest.fixture
def builds(monkeypatch):
    import chartcore

    out: list[list] = []

    def fake_build(features, layer, min_zoom, max_zoom, path):
        out.append(list(features))
        Path(path).write_bytes(b"not really pmtiles")
        return 1

    monkeypatch.setattr(chartcore, "build_pmtiles", fake_build)
    return out


def _config():
    from mivnav.config.model import Config

    return Config.model_validate({"mivport": {"base_url": BASE}})


def _runner(tmp_path: Path, fake: FakeMivport):
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    root = tmp_path / "poi"
    root.mkdir(exist_ok=True)
    runner = PoiIngestRunner(
        PoiStore(root, rescan_interval=0),
        dataset_id="mp",
        config=_config,
        http=httpx.Client(transport=httpx.MockTransport(fake.handler)),
    )
    return runner, root


def _bake(runner, **kw) -> dict:
    runner.ingest(country="DK", implementation="mivport", **kw)
    deadline = time.time() + 10
    while time.time() < deadline:
        st = runner.status()
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.01)
    raise AssertionError("bake did not finish")


def _params(**kw):
    p = PoiDatasetParams.model_validate(kw, context=params_context("mivport"))
    return p.source_params("mivport")


# -- pure parts --------------------------------------------------------------


def test_registered_as_a_poi_implementation():
    assert "mivport" in implementations()


def test_params_default_and_forbid_unknown_keys():
    assert _params().download_photos is True
    assert _params(download_photos=False).download_photos is False
    with pytest.raises(ValidationError):
        _params(include_community=True)


def test_kinds_map_to_host_kinds_where_one_exists():
    assert host_kind("marina") == "marina"
    assert host_kind("harbour_office") == "harbourmaster"
    assert host_kind("boat_shop") == "boat_dealer"
    assert host_kind("mooring") == "mooring"
    assert host_kind("something_new") == "other"


def test_normalize_reads_both_the_export_and_the_api_shape():
    lon, lat, exp = normalize(EXPORT[0])
    assert (lon, lat) == (10.22, 56.15)
    assert exp["osm"] == {"type": "way", "id": 5}
    assert exp["osm_attrs"] == {"website": "https://example.org"}
    _, _, api = normalize(FakeMivport().places[P3][1])
    assert api["osm"] == {"type": "node", "id": 2}
    assert api["osm_tags"] == {"seamark:type": "anchorage"}
    assert normalize(EXPORT[-1]) is None
    _, _, props = point_feature(*normalize(EXPORT[4]))
    assert props == {"kind": "harbourmaster", "kind_detail": "harbour_office",
                     "min_zoom": 14, "src": "mivport", "ref": "osm:n3"}


def _paths(entries):
    return [e["path"] for e in entries]


def test_pick_exports_prefers_the_smallest_covering_region_box():
    manifest = {"files": [
        {"path": "all.geojsonl.gz", "bytes": 100},
        {"path": "denmark.geojsonl.gz", "bytes": 10, "bbox": [7.5, 54.4, 15.3, 57.9]},
        {"path": "nordic.geojsonl.gz", "bytes": 50, "bbox": [4, 54, 32, 72]},
    ]}
    assert _paths(pick_exports(manifest, (8, 55, 12, 57))) == ["denmark.geojsonl.gz"]
    assert _paths(pick_exports(manifest, (5, 58, 30, 70))) == ["nordic.geojsonl.gz"]
    assert _paths(pick_exports(manifest, (-10, 40, 0, 50))) == ["all.geojsonl.gz"]
    assert _paths(pick_exports(manifest, None)) == ["all.geojsonl.gz"]


def test_pick_exports_takes_the_grid_cells_the_target_touches():
    manifest = {"grid_deg": 2, "files": [
        {"path": "all.geojsonl.gz", "bytes": 30},
        {"path": "grid/8_54.geojsonl.gz", "bytes": 10, "bbox": [8, 54, 10, 56]},
        {"path": "grid/10_56.geojsonl.gz", "bytes": 10, "bbox": [10, 56, 12, 58]},
        {"path": "grid/-2_-34.geojsonl.gz", "bytes": 10, "bbox": [-2, -34, 0, -32]},
        {"path": "grid/30_70.geojsonl.gz", "bytes": 10, "bbox": [30, 70, 32, 72]},
    ]}
    # Edges count: a point on a cell's west/south edge is in that cell.
    assert _paths(pick_exports(manifest, (8.1, 54.6, 10, 57.7))) == [
        "grid/10_56.geojsonl.gz", "grid/8_54.geojsonl.gz"]
    assert _paths(pick_exports(manifest, (-1, -33, -0.5, -32.5))) == ["grid/-2_-34.geojsonl.gz"]
    # No cell there: no places there, nothing to download.
    assert pick_exports(manifest, (100, 0, 101, 1)) == []
    # More grid bytes than "all": take "all".
    assert _paths(pick_exports(manifest, (-180, -90, 180, 90))) == ["all.geojsonl.gz"]
    # Grid cells without "grid_deg" are not known to be complete.
    del manifest["grid_deg"]
    assert _paths(pick_exports(manifest, (8.1, 54.6, 10, 57.7))) == ["all.geojsonl.gz"]


def test_bake_downloads_only_the_grid_cells_of_the_region(tmp_path, fake, builds):
    fake.grid = True
    fake.export.append(_feature("osm:n8", "marina", 18.07, 59.33, source="osm"))  # Stockholm
    runner, _ = _runner(tmp_path, fake)
    assert _bake(runner)["state"] == "done"
    fetched = {p for p in fake.requests if p.endswith(".geojsonl.gz")}
    assert "/exports/all.geojsonl.gz" not in fetched
    assert "/exports/grid/18_58.geojsonl.gz" not in fetched
    assert "/exports/grid/10_56.geojsonl.gz" in fetched
    # Same places as the "all" bake: Gothenburg shares DK's cell and is culled.
    assert {props["ref"] for _, _, props in builds[0]} == {P1, P3, "osm:n1", "osm:n3"}


# -- the bake ------------------------------------------------------------------


def test_bake_culls_catches_up_and_stores_details_and_photos(tmp_path, fake, builds):
    runner, root = _runner(tmp_path, fake)
    st = _bake(runner)
    assert st["state"] == "done", st

    refs = {props["ref"]: props for _, _, props in builds[0]}
    # Sweden culled, P2 deleted since the export, osm:n2 now hidden behind P3.
    assert set(refs) == {P1, P3, "osm:n1", "osm:n3"}
    assert refs[P1] == {"name": "Aarhus Marina", "kind": "marina", "kind_detail": "marina",
                        "min_zoom": 7, "src": "mivport", "ref": P1}
    assert "name" not in refs["osm:n1"]

    details = mp_store.read_all(mp_store.details_path(root, "mp"))
    assert set(details) == set(refs)
    p1 = details[P1]
    assert p1["attrs"] == {"vhf": "12", "electricity": True}
    assert p1["reviews"] == [{"id": "r1", "stars": 4, "user": "anna", "body": "Nice",
                              "created_at": "2026-11-01T10:00:00Z"}]
    assert p1["photos"][0]["url"] == f"{BASE}/media/photos/{PH}/view.jpg"
    assert details[P3]["attrs"] == {"protection": {"N": "good"}}

    photos = mp_store.photos_dir(root, "mp")
    assert sorted(p.name for p in photos.iterdir()) == [f"{PH}.thumb.jpg", f"{PH}.view.jpg"]
    meta = json.loads((root / "mp.json").read_text())
    assert meta["implementation"] == "mivport"


def test_second_bake_keeps_tiles_and_skips_downloaded_photos(tmp_path, fake, builds):
    runner, _ = _runner(tmp_path, fake)
    assert _bake(runner)["state"] == "done"
    fake.requests.clear()
    assert _bake(runner)["state"] == "done"
    assert len(builds) == 1  # unchanged → no re-tile
    assert not any(p.startswith("/media/") for p in fake.requests)


def test_photos_off_removes_them(tmp_path, fake, builds):
    runner, root = _runner(tmp_path, fake)
    assert _bake(runner)["state"] == "done"
    assert mp_store.photos_dir(root, "mp").is_dir()
    assert _bake(runner, params=MivportDatasetParams(download_photos=False))["state"] == "done"
    assert not mp_store.photos_dir(root, "mp").exists()


def test_failing_photo_downloads_do_not_fail_the_bake(tmp_path, fake, builds):
    fake.fail_media = True
    runner, root = _runner(tmp_path, fake)
    assert _bake(runner)["state"] == "done"
    assert mp_store.read_all(mp_store.details_path(root, "mp"))[P1]["photos"]


def test_unreachable_server_fails_the_bake(tmp_path, fake, builds):
    def down(request):
        raise httpx.ConnectError("offline", request=request)

    fake.handler = down  # type: ignore[method-assign]
    runner, _ = _runner(tmp_path, fake)
    st = _bake(runner)
    assert st["state"] == "error"
    assert builds == []


# -- routes --------------------------------------------------------------------


@pytest.fixture
def runtime(tmp_path: Path):
    from tests.conftest import isolated_runtime_at

    rt = isolated_runtime_at(tmp_path)
    yield rt
    rt.close()


@pytest.fixture
def dc(runtime):
    from fastapi.testclient import TestClient

    from mivnav.api.app import app
    from mivnav.api.deps import get_runtime

    previous = app.dependency_overrides.get(get_runtime)
    app.dependency_overrides[get_runtime] = lambda: runtime
    with TestClient(app) as c:
        yield c
    if previous is None:
        app.dependency_overrides.pop(get_runtime, None)
    else:
        app.dependency_overrides[get_runtime] = previous


def test_detail_and_photo_routes_serve_the_offline_copies(runtime, dc, fake):
    # A real archive (no `builds` stub): the store only lists sets it can open.
    from mivnav.features.poi.ingest import PoiIngestRunner
    from mivnav.features.poi.store import PoiStore

    root = runtime.config.get().data_root / "poi" / "mpset"
    root.mkdir(parents=True)
    runner = PoiIngestRunner(
        PoiStore(root, rescan_interval=0), dataset_id="mpset", config=_config,
        http=httpx.Client(transport=httpx.MockTransport(fake.handler)),
    )
    assert _bake(runner)["state"] == "done"
    # A photo record whose files never arrived stays remote.
    details = mp_store.read_all(mp_store.details_path(root, "mpset"))
    details["osm:n1"]["photos"] = [{"id": P2, "url": "http://r/v.jpg", "thumb_url": "http://r/t.jpg",
                                    "attribution": "© b"}]
    mp_store.write_details(mp_store.details_path(root, "mpset"), details.values(),
                           {"attribution": "© OSM; © mivport", "fetched_at": "123.5"})
    runtime.feature("poi").store().invalidate()

    r = dc.get(f"/poi/mivport/details/mpset/{P1}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["attribution"] == "© OSM; © mivport"
    assert body["fetched_at"] == 123.5
    assert body["photos"][0]["url"] == f"/poi/mivport/photos/mpset/{PH}.view.jpg"
    assert body["photos"][0]["thumb_url"] == f"/poi/mivport/photos/mpset/{PH}.thumb.jpg"
    assert body["photos"][0]["attribution"] == "© anna, CC BY-SA 4.0"
    assert "remote" not in body["photos"][0]
    assert body["web_url"] == f"https://mivport.nukifla.com/#place={P1}"
    assert dc.get("/poi/mivport/details/mpset/osm:n1").json()["photos"][0]["remote"] is True

    photo = dc.get(f"/poi/mivport/photos/mpset/{PH}.view.jpg")
    assert photo.status_code == 200
    assert photo.content.startswith(b"\xff\xd8")
    for url in (
        "/poi/mivport/photos/mpset/..%2F..%2Fetc.jpg",
        f"/poi/mivport/photos/mpset/{PH}.big.jpg",
        f"/poi/mivport/details/mpset/{P2}",
        f"/poi/mivport/details/nope/{P1}",
    ):
        assert dc.get(url).status_code == 404, url

    runtime.patch_config({"mivport": {"base_url": BASE, "web_url": "https://web.test"}})
    assert dc.get(f"/poi/mivport/details/mpset/{P1}").json()["web_url"] == f"https://web.test/#place={P1}"


def test_extra_files_never_collide_with_another_sources(tmp_path):
    """The host deletes every OTHER source's extra files when a set is baked
    (``remove_source_files(keep=...)``), so a shared name would wipe them."""
    from mivnav.features.poi.sources import poi_sources

    ours = set(mp_store.extra_files(tmp_path, "s"))
    for sid, source in poi_sources().items():
        if sid != "mivport":
            assert not ours & set(source.extra_files(tmp_path, "s")), sid


def test_a_photo_uploaded_after_the_export_is_still_found(tmp_path, fake, builds):
    """The photo dump is as old as the export, and uploads are not in
    /v1/changes: every place of ours is asked for its photos."""
    fake.photos = []  # the dump doesn't know P1's photo yet
    runner, root = _runner(tmp_path, fake)
    assert _bake(runner)["state"] == "done"
    details = mp_store.read_all(mp_store.details_path(root, "mp"))
    assert [p["id"] for p in details[P1]["photos"]] == [PH]
    assert (mp_store.photos_dir(root, "mp") / f"{PH}.view.jpg").is_file()
    asked = {p for p in fake.requests if p.endswith("/photos")}
    assert asked == {f"/v1/places/{P1}/photos", f"/v1/places/{P3}/photos"}  # ours only, not OSM
