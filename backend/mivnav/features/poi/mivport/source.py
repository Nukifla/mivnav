# SPDX-License-Identifier: GPL-2.0-only
"""The ``mivport`` POI source: what the POI feature calls to bake a mivport
dataset (:class:`mivnav.features.poi.sources.PoiSource`).

A bake, all of it while online, none of it needed at sea:

1. the export manifest, then the smallest ``<region>.geojsonl.gz`` that
   covers the target (``all`` unless the manifest gives region boxes), culled
   to the region in chunks so the world file never sits in RAM whole;
2. ``/v1/changes`` since the export's ``core_seq``: every place changed
   since is fetched fresh, so a bake shows edits made minutes ago;
3. reviews and photo records from the dumps, attached to their places;
4. the points published (tiles + search), then the details file;
5. the photos (view + thumb) downloaded for offline use.

mivport already merges OpenStreetMap into its places, so a mivport set is
used INSTEAD of an OpenStreetMap one, never beside it: no merge ``family``.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict

from mivnav.features.poi.ingest import (
    PoiBakeJob,
    PoiIngestError,
    cull_to_bboxes,
    cull_to_country,
)
from mivnav.features.poi.sources import PoiSource
from mivnav.geo import countries

from .config import MivportConfig

from . import client as mp_client
from . import store as mp_store
from .client import MivportError
from .mapping import SRC, normalize, point_feature

#: The ``implementation`` of a mivport dataset and the ``src`` of its points.
MIVPORT = SRC

#: Folded into the content hash: bump when what a feature list turns INTO
#: changes (tile props, ranks).
BAKE_VERSION = 1

#: Cull the export in chunks of this many places (bounds RAM on the Pi).
CULL_CHUNK = 20_000

#: More changed places than this since the export: skip the catch-up (one
#: request per place) and wait for the next export instead.
MAX_CATCHUP_PLACES = 2_000

#: Seconds between two per-place requests (catch-up, photo records, photo
#: files) — one at a time, polite to a small server. Tests set it to 0.
REQUEST_INTERVAL_S = 0.05

#: This many failures in a row end a per-item pass (offline, server down).
MAX_CONSECUTIVE_FAILURES = 20

#: A view is at most 2 MB, a thumb 200 KB (mivport's own limits).
MAX_PHOTO_BYTES = 3 * 1024 * 1024

DEFAULT_ATTRIBUTION = "© OpenStreetMap contributors (ODbL); © mivport contributors (ODbL)"

Place = tuple[float, float, dict]


class MivportDatasetParams(BaseModel):
    """A mivport dataset's ``params``; absent keys take their defaults."""

    model_config = ConfigDict(extra="forbid")

    #: Download every place photo (view + thumb) for offline use; off
    #: removes them.
    download_photos: bool = True


# -- choosing the export --------------------------------------------------


def _bbox_of(value: Any) -> tuple[float, float, float, float] | None:
    if isinstance(value, (list, tuple)) and len(value) == 4:
        try:
            a, b, c, d = (float(v) for v in value)
        except (TypeError, ValueError):
            return None
        return a, b, c, d
    return None


def _covers(outer: tuple[float, float, float, float], inner: tuple[float, float, float, float]) -> bool:
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


def pick_export(manifest: dict, target: tuple[float, float, float, float] | None) -> dict:
    """The manifest entry to download: the smallest ``*.geojsonl.gz`` whose
    ``bbox`` (when the manifest gives one) covers ``target``, else ``all``."""
    best: dict | None = None
    if target is not None:
        for entry in manifest.get("files") or ():
            if not isinstance(entry, dict):
                continue
            path, box = entry.get("path"), _bbox_of(entry.get("bbox"))
            if not isinstance(path, str) or not path.endswith(".geojsonl.gz") or box is None:
                continue
            if _covers(box, target) and (best is None or entry.get("bytes", 0) < best.get("bytes", 0)):
                best = entry
    if best is not None:
        return best
    entry = mp_client.manifest_file(manifest, "all.geojsonl.gz")
    if entry is None:
        raise PoiIngestError("mivport exports have no all.geojsonl.gz")
    return entry


def _target_bbox(job: PoiBakeJob) -> tuple[float, float, float, float] | None:
    if job.country is not None:
        try:
            return tuple(countries.country_bbox(job.country))  # type: ignore[return-value]
        except Exception:  # noqa: BLE001 — unknown border data: take the world file
            return None
    boxes = job.bboxes or ((job.bbox,) if job.bbox else ())
    if not boxes:
        return None
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


# -- region culling -------------------------------------------------------


def _culler(job: PoiBakeJob):
    if job.country is not None:
        iso = job.country
        return lambda places: cull_to_country(places, iso)
    boxes = job.bboxes or ((job.bbox,) if job.bbox else ())
    if not boxes:
        raise PoiIngestError("a POI bake needs a country or at least one bbox")
    return lambda places: cull_to_bboxes(places, tuple(boxes))


def _cull_stream(records: Iterator[dict], cull, job: PoiBakeJob) -> tuple[dict[str, Place], int]:
    """``ref -> (lon, lat, detail)`` for every record in the region, culled
    a chunk at a time. Also returns how many records were read."""
    kept: dict[str, Place] = {}
    chunk: list[Place] = []
    seen = 0

    def flush() -> None:
        for lon, lat, detail in cull(chunk):
            kept[detail["ref"]] = (lon, lat, detail)
        chunk.clear()
        job.check_cancel()

    for record in records:
        seen += 1
        place = normalize(record)
        if place is not None:
            chunk.append(place)
        if len(chunk) >= CULL_CHUNK:
            flush()
    flush()
    return kept, seen


# -- catching up with /v1/changes ----------------------------------------


def _osm_ref(osm: Any) -> str | None:
    if isinstance(osm, dict) and osm.get("type") in ("node", "way", "relation") and isinstance(osm.get("id"), int):
        return f"osm:{osm['type'][0]}{osm['id']}"
    return None


def _catch_up(job: PoiBakeJob, base_url: str, since: int, places: dict[str, Place], cull) -> int:
    """Apply what changed after the export to ``places``; returns the next
    ``since``. A failure here keeps the export's state (logged): the points
    are still a whole, consistent export, just older."""
    try:
        revisions, nxt = mp_client.fetch_changes(job.http, base_url, since)
    except MivportError as e:
        job.log(f"warning: changes since the export not fetched ({e}); using the export as is")
        return since
    refetch: dict[str, None] = {}
    hidden: set[str] = set()
    for rev in revisions:
        if isinstance(rev.get("place_id"), str):
            refetch[rev["place_id"]] = None
        search = rev.get("search") if isinstance(rev.get("search"), dict) else {}
        if isinstance(search.get("osm_id"), str):
            hidden.add(search["osm_id"])
        released = rev.get("released") if isinstance(rev.get("released"), dict) else {}
        if isinstance(released.get("id"), str):
            refetch[released["id"]] = None
    if not refetch:
        job.log("no changes since the export")
        return nxt
    if len(refetch) > MAX_CATCHUP_PLACES:
        job.log(
            f"warning: {len(refetch)} places changed since the export — more than "
            f"{MAX_CATCHUP_PLACES}; using the export as is (the next one has them)"
        )
        return since
    for ref in hidden:
        places.pop(ref, None)
    n = len(refetch)
    job.fetching("catching up with changes")
    job.log(f"{len(revisions)} revisions since the export: fetching {n} places")
    failed = streak = 0
    for i, ref in enumerate(refetch):
        if i and REQUEST_INTERVAL_S > 0:
            job.wait(REQUEST_INTERVAL_S)
        job.check_cancel()
        try:
            feature, deleted = mp_client.fetch_place(job.http, base_url, ref)
        except MivportError as e:
            failed += 1
            streak += 1
            job.log(f"place {ref}: {e}")
            if streak >= MAX_CONSECUTIVE_FAILURES:
                job.log("warning: catch-up aborted after repeated failures; some places are as exported")
                break
            continue
        streak = 0
        place = normalize(feature) if feature is not None and not deleted else None
        places.pop(ref, None)
        if place is None:
            continue
        if place[2]["ref"] != ref:  # an OSM id answered by the place that links it
            places.pop(place[2]["ref"], None)
        hides = _osm_ref(place[2].get("osm"))
        if hides is not None and place[2]["source"] == "core":
            places.pop(hides, None)
        for lon, lat, detail in cull([place]):
            places[detail["ref"]] = (lon, lat, detail)
        job.progress(i + 1, n, task="catching up with changes")
    job.log(f"caught up: {n - failed} places refreshed, {failed} failed")
    return nxt


# -- reviews and photo records -------------------------------------------


def _dump(job: PoiBakeJob, base_url: str, manifest: dict, name: str) -> Iterator[dict]:
    entry = mp_client.manifest_file(manifest, f"dump/{name}.jsonl.gz")
    if entry is None:
        job.log(f"warning: exports have no dump/{name}.jsonl.gz")
        return iter(())
    return mp_client.fetch_export_lines(job.http, base_url, entry)


def _review(row: dict) -> dict | None:
    stars = row.get("stars")
    if not isinstance(stars, int) or not isinstance(row.get("id"), str):
        return None
    out: dict[str, Any] = {"id": row["id"], "stars": stars, "user": str(row.get("user") or "")}
    for key in ("body", "visited_on", "created_at"):
        if isinstance(row.get(key), str) and row[key].strip():
            out[key] = row[key]
    return out


def _attach_reviews(job: PoiBakeJob, base_url: str, manifest: dict, places: dict[str, Place]) -> int:
    count = 0
    try:
        rows = list(_dump(job, base_url, manifest, "reviews"))
    except MivportError as e:
        job.log(f"warning: reviews not fetched: {e}")
        return 0
    for row in rows:
        place = places.get(row.get("place_id")) if isinstance(row.get("place_id"), str) else None
        review = _review(row) if place is not None else None
        if review is not None:
            place[2].setdefault("reviews", []).append(review)
            count += 1
    for _, _, detail in places.values():
        if "reviews" in detail:
            detail["reviews"].sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return count


def _photo(row: dict, base_url: str) -> dict | None:
    urls = row.get("urls") if isinstance(row.get("urls"), dict) else {}
    pid = row.get("id")
    if not isinstance(pid, str) or not mp_store.PHOTO_NAME_RE.match(mp_store.photo_name(pid, "view")):
        return None
    view, thumb = urls.get("view"), urls.get("thumb")
    if not isinstance(view, str) or not isinstance(thumb, str):
        return None
    absolute = lambda u: u if u.startswith(("http://", "https://")) else base_url.rstrip("/") + u  # noqa: E731
    out: dict[str, Any] = {
        "id": pid,
        "url": absolute(view),
        "thumb_url": absolute(thumb),
        "attribution": str(row.get("attribution") or f"© {row.get('user', '?')}"),
    }
    for key in ("user", "caption", "license_url", "taken_at", "created_at"):
        if isinstance(row.get(key), str) and row[key].strip():
            out[key] = row[key]
    return out


def _attach_photos(job: PoiBakeJob, base_url: str, manifest: dict, places: dict[str, Place]) -> int:
    """Photo records for the region's places. The photo dump says WHICH
    places have photos but not their URLs, so those places are asked for
    their photos one by one (few: photos are ours only)."""
    try:
        with_photos = {
            row["place_id"]
            for row in _dump(job, base_url, manifest, "photos")
            if isinstance(row.get("place_id"), str) and row["place_id"] in places
        }
    except MivportError as e:
        job.log(f"warning: photo list not fetched: {e}")
        return 0
    count = failed = streak = 0
    for i, ref in enumerate(sorted(with_photos)):
        if i and REQUEST_INTERVAL_S > 0:
            job.wait(REQUEST_INTERVAL_S)
        job.check_cancel()
        try:
            rows = mp_client.fetch_place_photos(job.http, base_url, ref)
        except MivportError as e:
            failed += 1
            streak += 1
            job.log(f"photos of {ref}: {e}")
            if streak >= MAX_CONSECUTIVE_FAILURES:
                job.log("warning: photo records aborted after repeated failures")
                break
            continue
        streak = 0
        photos = [p for p in (_photo(r, base_url) for r in rows) if p is not None]
        if photos:
            places[ref][2]["photos"] = photos
            count += len(photos)
    return count


# -- photo files ---------------------------------------------------------


def _photo_pass(job: PoiBakeJob, places: dict[str, Place], download: bool) -> None:
    directory = mp_store.photos_dir(job.root, job.set_id)
    if not download:
        if directory.exists():
            mp_store.remove_photos(job.root, job.set_id)
            job.log("photos: download off — removed the downloaded photos")
        job.stats(photo_count=0, photo_bytes=0)
        return
    wanted: dict[str, str] = {}
    for _, _, detail in places.values():
        for photo in detail.get("photos") or ():
            wanted[mp_store.photo_name(photo["id"], "view")] = photo["url"]
            wanted[mp_store.photo_name(photo["id"], "thumb")] = photo["thumb_url"]
    directory.mkdir(parents=True, exist_ok=True)
    removed = 0
    for path in directory.iterdir():
        if path.name not in wanted:
            path.unlink(missing_ok=True)
            removed += 1
    todo = [(name, url) for name, url in wanted.items() if not (directory / name).is_file()]
    n = len(todo)
    job.fetching("downloading photos")
    job.log(f"photos: {n} of {len(wanted)} files to download, {removed} stale removed")
    fetched = failed = streak = 0
    for i, (name, url) in enumerate(todo):
        if i and REQUEST_INTERVAL_S > 0:
            job.wait(REQUEST_INTERVAL_S)
        if job.cancelled():
            job.log(f"photos: cancelled after {fetched}/{n}; downloaded photos kept")
            raise PoiIngestError("cancelled")
        try:
            body, media = mp_client.fetch_bytes(job.http, url, MAX_PHOTO_BYTES)
            if media != "image/jpeg" and not body.startswith(b"\xff\xd8"):
                raise MivportError(f"{url}: not a JPEG ({media or 'no content-type'})")
            mp_store.store_photo(directory, name, body)
        except (MivportError, OSError) as e:
            failed += 1
            streak += 1
            job.log(f"photo {name}: {e}")
            if streak >= MAX_CONSECUTIVE_FAILURES:
                job.log("warning: photo download aborted after repeated failures; the next bake resumes")
                break
        else:
            fetched += 1
            streak = 0
        job.progress(i + 1, n, task="downloading photos")
    files = [p for p in directory.iterdir() if mp_store.PHOTO_NAME_RE.match(p.name)]
    size = sum(p.stat().st_size for p in files)
    job.stats(photo_count=len(files) // 2, photo_bytes=size)
    job.log(f"photos: downloaded {fetched}, failed {failed}, {size / 1e6:.1f} MB on the boat")


# -- the bake ------------------------------------------------------------


def bake(job: PoiBakeJob) -> None:
    #: When this bake started: a place edited on the boat and uploaded
    #: before it is in it, so the boat's local copy can go (``local.py``).
    started_at = time.time()
    params = job.params if isinstance(job.params, MivportDatasetParams) else MivportDatasetParams()
    base_url = (job.app_config.mivport if job.app_config is not None else MivportConfig()).base_url
    job.fetching()
    job.log(f"fetching {job.name!r} from mivport ({base_url})")
    cull = _culler(job)
    try:
        with job.heartbeat():
            manifest = mp_client.fetch_manifest(job.http, base_url)
        entry = pick_export(manifest, _target_bbox(job))
        job.log(f"export {entry['path']} ({entry.get('bytes', 0) / 1e6:.1f} MB), core_seq {manifest.get('core_seq')}")
        with job.heartbeat("downloading the export"):
            places, seen = _cull_stream(
                mp_client.fetch_export_lines(job.http, base_url, entry), cull, job
            )
    except MivportError as e:
        job.log(f"fetch failed: {e}")
        raise PoiIngestError(str(e)) from e
    job.log(f"read {seen} places, {len(places)} in the region")

    core_seq = manifest.get("core_seq")
    if isinstance(core_seq, int):
        _catch_up(job, base_url, core_seq, places, cull)

    reviews = _attach_reviews(job, base_url, manifest, places)
    photos = _attach_photos(job, base_url, manifest, places)
    job.log(f"{reviews} reviews and {photos} photos in the region")

    features = sorted(
        (point_feature(lon, lat, detail) for lon, lat, detail in places.values()),
        key=lambda f: f[2]["ref"],
    )
    digest = job.content_hash(features, BAKE_VERSION)
    if job.unchanged(digest):
        job.keep_existing(digest, len(features))
    else:
        job.write_set(features, content_hash=digest)

    attribution = manifest.get("attribution")
    meta = {
        "attribution": attribution if isinstance(attribution, str) and attribution else DEFAULT_ATTRIBUTION,
        "fetched_at": str(time.time()),
        "started_at": str(started_at),
        "export": str(entry["path"]),
    }
    stored = mp_store.write_details(
        mp_store.details_path(job.root, job.set_id),
        # The position too: an edit made on the boat redraws the place
        # from its stored detail (``local.py``).
        ({**detail, "lon": lon, "lat": lat} for lon, lat, detail in places.values()),
        meta,
    )
    job.stats(detail_count=stored, review_count=reviews)
    if job.app_config is not None:
        _refresh_registry(job, base_url, job.app_config.data_root)
    _photo_pass(job, places, params.download_photos)


def _refresh_registry(job: PoiBakeJob, base_url: str, data_root: Path) -> None:
    """The kinds/attrs registry the place editor needs, cached for offline."""
    from .account import RegistryCache  # noqa: PLC0415 — editing side, kept out of import time

    try:
        RegistryCache(data_root).refresh(job.http, base_url)
    except MivportError as e:
        job.log(f"warning: kinds/attrs registry not refreshed: {e}")


def extra_files(dataset_dir: Path, set_id: str) -> list[Path]:
    return mp_store.extra_files(dataset_dir, set_id)


SOURCE = PoiSource(
    id=MIVPORT,
    label="POI (mivport)",
    bake=bake,
    params_model=MivportDatasetParams,
    extra_files=extra_files,
)
