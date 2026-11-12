# SPDX-License-Identifier: GPL-2.0-only
"""The POI ingest-bake job: fetch -> map -> ``<id>.pmtiles`` -> rescan.
One background bake at a time, poll-able for status. See
docs/architecture/poi-ingest.md for the pipeline and the fetch strategy.

Implementations (:mod:`mivnav.features.poi.sources`) share everything
after "a list of point features": the built-in ``overpass`` (Overpass fetch
-> tag map -> country clip -> coastal filter), and any plugin source, which
gets a :class:`PoiBakeJob` and calls back into the shared tail. See
:meth:`PoiIngestRunner._bake`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import chartcore
import httpx
from pydantic import BaseModel

from mivnav.config.model import DEFAULT_REGION_ID, Region
from mivnav.features.poi.config import PoiConfig
from mivnav.geo import countries
from mivnav.features.poi import overpass, overpass_resume
from mivnav.features.poi.clip import (
    COUNTRY_CLIP_BUFFER_KM,
    clip_features,
    near_country,
    point_in_country,
)
from mivnav.features.poi.coastline import COAST_BUFFER_KM, CoastIndex
from mivnav.features.poi.overpass import BBox, OverpassError
from mivnav.features.poi.sources import (
    OVERPASS,
    poi_source,
    poi_sources,
    resolve_implementation,
)
from mivnav.ingest.runner import ST_BAKE, ST_FETCH, BaseJobStatus, IngestRunner
from mivnav.features.poi.tags import map_elements
from mivnav.features.poi.sidecar import (
    CUSTOM_SET_ID,
    CUSTOM_SET_NAME,
    read_sidecar,
    slugify,
    write_sidecar,
)
from mivnav.features.poi.store import PoiStore
from mivnav.search import SearchIndex, SearchRecord

log = logging.getLogger(__name__)

# Internal vector-layer id, stays "pois" regardless of region; the region
# lives in the file stem instead (see region_set_id).
POI_LAYER = "pois"

# Module constant so a test can shrink it rather than wait real seconds.
FETCH_HEARTBEAT_S = 10.0

Feature = tuple[float, float, dict]


def region_set_id(region: Region) -> str:
    """The on-disk set id (``<id>.pmtiles``/``<id>.json`` stem): a country
    region's ISO lower-cased (``DK`` -> ``dk``); a bbox region's
    filesystem-safe name slug (``Solent`` -> ``solent``, empty -> ``custom``)."""
    iso = region.iso
    if iso is not None:
        return iso.lower()
    return slugify(region.name)


def region_name(region: Region) -> str:
    """The display name a region bakes under: the country's name for a country
    region (``country_name(iso)``), else the region's own name."""
    iso = region.iso
    return countries.country_name(iso) if iso is not None else region.name


class PoiIngestError(Exception):
    pass


def _keep_coastal_land(
    features: list[tuple[float, float, dict]],
    km: float = COAST_BUFFER_KM,
) -> list[tuple[float, float, dict]]:
    """Drop everything not within ``km`` of the coast — every kind alike
    (see docs/architecture/poi-ingest.md for why no exemptions remain)."""
    if not features:
        return features
    lons = [lon for lon, _, _ in features]
    lats = [lat for _, lat, _ in features]
    bbox = (min(lons), min(lats), max(lons), max(lats))
    index = CoastIndex(bbox, km)
    return [(lon, lat, props) for (lon, lat, props) in features if index.near(lon, lat)]


def _expand_bbox(bbox: BBox, km: float) -> BBox:
    """``bbox`` grown by ``km`` on every side (equirectangular, the longitude
    margin taken at the box's highest-|lat| edge so it is never too small) —
    a cheap superset prefilter ahead of :func:`clip_features`' exact buffer."""
    min_lon, min_lat, max_lon, max_lat = bbox
    dlat = km / 110.57
    coslat = max(math.cos(math.radians(max(abs(min_lat), abs(max_lat)) + dlat)), 1e-6)
    dlon = km / (111.32 * coslat)
    return (
        max(min_lon - dlon, -180.0),
        max(min_lat - dlat, -90.0),
        min(max_lon + dlon, 180.0),
        min(max_lat + dlat, 90.0),
    )


def _in_bbox(lon: float, lat: float, bbox: BBox) -> bool:
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def _ring_bbox(ring) -> BBox:
    lons = [pt[0] for pt in ring]
    lats = [pt[1] for pt in ring]
    return (min(lons), min(lats), max(lons), max(lats))


def cull_to_country(features: list[Feature], iso: str) -> list[Feature]:
    """The world-index features belonging to country ``iso``: the same loose
    border clip the Overpass bbox-fallback uses (:func:`clip_features`: inside,
    or within ``COUNTRY_CLIP_BUFFER_KM`` of any ring), with the SAME result
    but prefiltered by the buffer-grown country bbox, then per polygon/ring
    by bounding box. The country bbox alone is useless for a country spanning
    the antimeridian (US, RU, FJ: -180..180), and the per-edge distance test
    is the cost — a world index is ~120k points, so each point only meets the
    rings it could be near. Measured on a 110,839-row index (dev box): DK
    ~0.3 s, GR ~0.9 s, US ~16 s (US was >160 s with the country bbox alone)."""
    geom = countries.country_polygon(iso)
    km = COUNTRY_CLIP_BUFFER_KM
    polygons = [(_ring_bbox(poly[0]), poly) for poly in geom if poly and poly[0]]
    rings = [(_expand_bbox(_ring_bbox(ring), km), ring) for poly in geom for ring in poly if ring]
    # Cheap whole-country superset first (selective for most countries).
    outer = _expand_bbox(countries.country_bbox(iso), km)
    out: list[Feature] = []
    for feature in features:
        lon, lat = feature[0], feature[1]
        if not _in_bbox(lon, lat, outer):
            continue
        if any(
            _in_bbox(lon, lat, box) and point_in_country(lon, lat, [poly])
            for box, poly in polygons
        ) or any(
            _in_bbox(lon, lat, box) and near_country(lon, lat, [[ring]], km)
            for box, ring in rings
        ):
            out.append(feature)
    return out


def cull_to_bboxes(features: list[Feature], bboxes: tuple[BBox, ...]) -> list[Feature]:
    """Keep a feature iff it lies in ANY of ``bboxes`` — the gaps between a
    multi-box region's boxes are culled, unlike its enclosing bbox."""
    return [f for f in features if any(_in_bbox(f[0], f[1], b) for b in bboxes)]


def content_hash(features: list[Feature], cfg: PoiConfig, version: object = 0) -> str:
    """sha256 of exactly what the tile/search/sidecar tail would consume: the
    features plus the zooms and the caller's own bake ``version`` (bump it
    when what a given feature list turns INTO changes). A source whose fetch
    is bigger than one region (a world index, culled locally) hashes the
    CULLED features, so the hash only changes when this region's points do —
    see :meth:`PoiBakeJob.unchanged`."""
    payload = json.dumps(
        [version, POI_LAYER, cfg.min_zoom, cfg.max_zoom, features],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def _search_records(features: list[tuple[float, float, dict]]) -> list[SearchRecord]:
    """The baked features, reshaped for the shared search index. ``id`` is a
    per-batch key only (kind + rounded coordinate, no OSM id; a plugin
    source's own ``ref`` where it has one)
    — enough since :meth:`SearchIndex.rebake` replaces the whole region each
    time — made unique within the batch by a ``#2``, ``#3``… suffix."""
    seen: dict[str, int] = {}
    records: list[SearchRecord] = []
    for lon, lat, props in features:
        # A plugin source's feature may have a stable id (``ref``); Overpass ones don't.
        base = props.get("ref") or f"{props['kind']}-{lon:.6f}-{lat:.6f}"
        # The id is the search table's PRIMARY KEY, and kind+coordinate is
        # NOT unique in real OSM data: stacked duplicate nodes, a node on a
        # way's centre (the "Denmark 2026" box has 7 such pairs, e.g. two
        # "Flua Pizza" restaurant nodes on one spot). One collision used to
        # fail the whole bake with "UNIQUE constraint failed: records.id".
        n = seen.get(base, 0) + 1
        seen[base] = n
        records.append(
            SearchRecord(
                id=base if n == 1 else f"{base}#{n}",
                category=props["kind"],
                title=props.get("name"),
                text=props.get("name", ""),
                lat=lat,
                lon=lon,
                data=props,
            )
        )
    return records


@dataclass(frozen=True)
class _BakeTarget:
    """One bake's identity + fetch parameters, resolved once in :meth:`ingest`
    and threaded through the background run. ``country`` XOR ``bbox`` drives
    the fetch strategy and doubles as the sidecar's own ``country``/``bbox``."""

    set_id: str
    name: str
    country: str | None
    bbox: BBox | None
    implementation: str = OVERPASS
    #: The region's individual boxes (bbox regions); a source that culls a
    #: bigger fetch locally tests each (:meth:`PoiBakeJob.cull_to_region`).
    #: ``None`` → ``(bbox,)``. Overpass ignores it (fetches ``bbox``).
    bboxes: tuple[BBox, ...] | None = None
    #: The dataset's params, validated against the source's ``params_model``.
    params: BaseModel | None = None


@dataclass
class JobStatus(BaseJobStatus):
    feature_count: int = 0
    tile_count: int = 0
    #: Source-specific counters a plugin bake reports (:meth:`PoiBakeJob.stats`).
    stats: dict[str, int] = field(default_factory=dict)


class _Beat:
    """A fetch heartbeat's current label: what the UI shows while one request
    (with its retries) blocks. :meth:`note` switches it at once (a retry
    notice), :meth:`tick` repeats it with the seconds since it was set."""

    def __init__(self, runner: PoiIngestRunner, label: str, current: int, total: int) -> None:
        self._runner = runner
        self._lock = threading.Lock()
        self.base = label
        self.label = label
        self.current = current
        self.total = total
        self.since = time.time()

    def note(self, text: str) -> None:
        with self._lock:
            self.label = f"{self.base}: {text}" if text else self.base
            self.since = time.time()
            label = self.label
        self._runner._progress(self.current, self.total, task=label)

    def tick(self) -> None:
        with self._lock:
            label, since = self.label, self.since
        self._runner._progress(
            self.current, self.total, task=f"{label}… {int(time.time() - since)}s"
        )


class PoiIngestRunner(IngestRunner[JobStatus]):
    """One background POI bake at a time; status is poll-able. Config is
    read fresh at each bake start, so a ``PATCH /config`` edit needs no
    restart — see docs/architecture/poi-ingest.md."""

    status_cls = JobStatus
    busy_error = PoiIngestError
    job_name = "POI ingest"

    def __init__(
        self,
        store: PoiStore,
        http: httpx.Client | None = None,
        poi_config: Callable[[], PoiConfig] | None = None,
        regions: Callable[[], tuple[Region, ...]] | None = None,
        search_index: Callable[[], SearchIndex] | None = None,
        dataset_id: str | None = None,
        on_published: Callable[[], None] | None = None,
        config: Callable[[], Any] | None = None,
    ) -> None:
        super().__init__()
        self.store = store
        self._http = http or httpx.Client(
            timeout=httpx.Timeout(200.0, connect=30.0), follow_redirects=True
        )
        self._poi_config = poi_config or PoiConfig
        self._regions = regions or (lambda: (Region(id=DEFAULT_REGION_ID),))
        # None-able so the runner stays constructible from a store alone
        # (search indexing then simply skipped).
        self._search_index = search_index
        # Set ONLY by the generic-dataset factory; overrides the region-derived
        # file id — see docs/architecture/poi-ingest.md (`_dataset_id`).
        self._dataset_id = dataset_id
        # Called after every successful bake: the generic-dataset runner bakes
        # into its OWN per-dataset PoiStore, so the store /poi/catalog serves
        # from (the provider root) must be told separately, or a fresh set
        # stays invisible until that store's rate-limited rescan.
        self._on_published = on_published
        # The whole current Config, snapshotted per bake for a plugin source
        # (its own settings live in ``Config.plugins``). None-able like
        # ``search_index``.
        self._config = config

    @property
    def default_bbox(self) -> BBox:
        """The bbox a bake uses when none is given — the FIRST configured
        region, read fresh from the current boat-wide regions list."""
        return self._regions()[0].bbox

    def ingest(
        self,
        bbox: BBox | None = None,
        country: str | None = None,
        *,
        bboxes: tuple[BBox, ...] | None = None,
        implementation: str | None = None,
        params: BaseModel | None = None,
        name: str | None = None,
    ) -> None:
        """Start a background bake. Returns immediately. Fetch is EITHER a
        country OR an explicit ``bbox``, never both; with neither,
        ``regions[0]`` is used. Config is snapshotted here, at job start.

        ``name`` is the set's display name (sidecar, catalog, progress) when
        the caller knows it — the generic dataset trigger passes its region's
        name, since it hands over an explicit ``bbox`` that would otherwise
        bake as the nameless ``"Custom"`` fallback. It never changes the set
        id (the dataset id, or the region/country-derived one).

        ``implementation`` picks the source (``None`` = Overpass; an unknown
        value raises :class:`ValueError`). ``bboxes`` (a bbox region's
        individual boxes) and ``params`` (the dataset's params, already
        validated) only matter to a plugin source."""
        if bbox is not None and country is not None:
            raise PoiIngestError("give either a bbox or a country, not both")
        impl = resolve_implementation(implementation)
        cfg = self._poi_config()
        if bbox is None and country is None:
            # The default region (may be a country or a bbox region); its own
            # name/id drive the set.
            region = self._regions()[0]
            country = region.iso
            if country is None:
                bbox = region.bbox
                bboxes = tuple(b.as_tuple() for b in region.bboxes)
            set_id, name = region_set_id(region), name or region_name(region)
        elif country is not None:
            # An explicit country → its ISO/name.
            set_id, name = country.lower(), name or countries.country_name(country)
        else:
            # An explicit bbox with no named region — a stable fallback set.
            set_id, name = CUSTOM_SET_ID, name or CUSTOM_SET_NAME
        if self._dataset_id is not None:
            # The generic /datasets/{id}/ingest path: the archive must be
            # addressed by the dataset's OWN id, not the region's — `name`
            # (the region's display name) still drives the UI label.
            set_id = self._dataset_id
        target = _BakeTarget(
            set_id=set_id,
            name=name,
            country=country,
            bbox=bbox,
            implementation=impl,
            bboxes=(bboxes or None) if country is None else None,
            params=params,
        )
        # detail carries the set NAME so the UI can show "updating Denmark".
        app_config = self._config() if self._config is not None else None
        self._start(name, lambda: self._bake(target, cfg, app_config))

    def _bake(self, target: _BakeTarget, cfg: PoiConfig, app_config: Any = None) -> None:
        """Dispatch on the implementation to a point-feature list, then the
        shared tail (:meth:`_write_set`)."""
        source = poi_source(target.implementation)
        if source is not None:
            source.bake(PoiBakeJob(self, target, cfg, app_config))
        else:
            self._write_set(target, cfg, self._collect_overpass(target, cfg))
            # Published: whatever a failed attempt kept for resuming is spent.
            overpass_resume.remove(overpass_resume.resume_path(self.store.root, target.set_id))

    @contextmanager
    def _heartbeat(self, label: str = "fetching", current: int = 0, total: int = 0) -> Iterator[_Beat]:
        """Tick the fetch stage's ``task`` with elapsed seconds while the body
        blocks on one big response (Overpass sends nothing until the whole
        reply is ready; a plugin's world index may be one big body), so the UI shows
        life instead of a counter stuck at 0. ``label``/``current``/``total``
        let a tiled Overpass fetch keep its "tile i/n" while ticking. The
        yielded :class:`_Beat` re-labels it mid-wait (an Overpass retry:
        "tile 8/8: Overpass busy (504) at …, retry 2/4 in 60s")."""
        beat = _Beat(self, label, current, total)
        stop = threading.Event()
        thread = threading.Thread(target=self._fetch_heartbeat, args=(stop, beat), daemon=True)
        thread.start()
        try:
            yield beat
        finally:
            # JOIN before the next stage's `_progress` call — a late heartbeat
            # tick would stomp "mapping to POI features" back to a stale
            # "fetching… Ns".
            stop.set()
            thread.join()

    def _collect_overpass(self, target: _BakeTarget, cfg: PoiConfig) -> list[Feature]:
        bbox, country = target.bbox, target.country
        self._update(state=ST_FETCH)
        self._progress(0, 0, task="fetching")
        urls = cfg.overpass_urls()
        fallbacks = f" (fallbacks: {', '.join(urls[1:])})" if len(urls) > 1 else ""
        self._log(f"fetching {target.name!r} from {urls[0]}{fallbacks}")
        # Three-way fetch strategy — see docs/architecture/poi-ingest.md.
        clip_iso: str | None = None
        try:
            # Module-qualified so tests can monkeypatch overpass.fetch_pois*.
            if country is not None and cfg.overpass_use_area:
                with self._heartbeat() as beat:
                    elements = overpass.fetch_pois_area(
                        self._http,
                        country,
                        url=urls[0],
                        fallback_urls=urls[1:],
                        on_retry=self._retry_reporter(beat),
                    )
            elif country is not None:
                clip_iso = country
                elements = self._fetch_bbox_tiled(countries.country_bbox(country), urls, target)
            else:
                assert bbox is not None
                elements = self._fetch_bbox_tiled(bbox, urls, target)
        except OverpassError as e:
            self._log(f"fetch failed: {e}")
            raise PoiIngestError(str(e)) from e

        self._log(f"fetched {len(elements)} raw elements from Overpass")
        self._progress(0, len(elements), task="mapping to POI features")
        features = map_elements(elements)
        self._progress(len(elements), len(elements))
        self._log(f"mapped {len(features)} POI features")

        if clip_iso is not None:
            # Fetched a rectangle full of neighbours + ocean; clip to the border.
            self._progress(0, len(features), task=f"clipping to {clip_iso} border")
            features = clip_features(
                features,
                countries.country_polygon(clip_iso),
                COUNTRY_CLIP_BUFFER_KM,
            )
            self._progress(len(features), len(features))
            self._log(f"clipped to {clip_iso} border: {len(features)} features remain")

        self._progress(0, len(features), task="filtering to coastal features")
        features = _keep_coastal_land(features)
        self._progress(len(features), len(features))
        self._log(f"coastal filter: {len(features)} features remain")
        return features

    def _retry_reporter(self, beat: _Beat) -> Callable[[str], None]:
        """An ``on_retry`` hook: the notice goes to the job log AND, at once,
        to the fetch's progress text (so a 60 s busy wait reads as one)."""

        def report(msg: str) -> None:
            self._log(msg)
            beat.note(msg)

        return report

    def _fetch_bbox_tiled(
        self, bbox: BBox, urls: tuple[str, ...], target: _BakeTarget
    ) -> list[dict]:
        """One Overpass bbox fetch per :func:`overpass.split_bbox` tile, in
        turn, merged and deduped by OSM ``(type, id)`` (tiles share edges,
        and a way straddling one comes back from both). A small box is one
        tile, i.e. exactly the single request it always was. Cancel-aware
        between tiles; any tile failing (after every server's retries —
        :func:`overpass.fetch_from`) fails the bake — a set with a hole in it
        is worse than the last good one, which stays in place.

        Servers: each tile starts on the server that answered the previous
        one, so a busy primary is not re-tried first for every tile.

        Resume (docs/architecture/poi-overpass-fetch.md): the tiles fetched
        so far are kept, and on failure (or cancel) written to the set's
        resume file; the next bake of this set re-uses the ones still fresh
        and fetches only the rest. Measured on the boat: a "Denmark" bake
        lost 7 fetched tiles to one tile's 504s."""
        tiles = overpass.split_bbox(bbox)
        n = len(tiles)
        if n > 1:
            self._log(f"large area: fetching it as {n} tiles, one after another")
        path = overpass_resume.resume_path(self.store.root, target.set_id)
        key = overpass_resume.grid_key([overpass.build_query(t) for t in tiles])
        done = overpass_resume.load(path, key, n, time.time())
        if done:
            age = (time.time() - min(at for at, _ in done.values())) / 60
            self._log(
                f"resuming: {len(done)}/{n} tiles from the previous attempt "
                f"(fetched up to {age:.0f} min ago)"
            )
        order = list(urls)
        try:
            for i, tile in enumerate(tiles):
                if i in done:
                    continue
                self._check_cancel()
                label = "fetching" if n == 1 else f"fetching tile {i + 1}/{n}"
                self._progress(i, n if n > 1 else 0, task=label)
                answered: list[str] = []
                with self._heartbeat(label, i, n if n > 1 else 0) as beat:
                    got = overpass.fetch_pois(
                        self._http,
                        tile,
                        url=order[0],
                        fallback_urls=order[1:],
                        on_retry=self._retry_reporter(beat),
                        on_server=answered.append,
                    )
                done[i] = (time.time(), got)
                if n > 1:
                    self._log(f"tile {i + 1}/{n}: {len(got)} elements")
                if answered and answered[0] != order[0]:
                    self._log(f"tile {i + 1}/{n} answered by {answered[0]}; next tiles start there")
                    order = [answered[0], *(u for u in order if u != answered[0])]
        except Exception:
            if done and n > 1:
                try:
                    overpass_resume.save(path, key, done)
                except OSError as e:
                    log.warning("could not write the Overpass resume file %s: %s", path, e)
                else:
                    self._log(
                        f"kept {len(done)}/{n} fetched tiles; the next bake of this "
                        "dataset resumes from them"
                    )
            raise
        seen: set[tuple[str, int]] = set()
        elements: list[dict] = []
        total = 0
        for i in range(n):
            for element in done[i][1]:
                total += 1
                osm_id = element.get("id")
                if osm_id is not None:
                    ek = (str(element.get("type")), osm_id)
                    if ek in seen:
                        continue
                    seen.add(ek)
                elements.append(element)
        if n > 1:
            self._log(
                f"{n} tiles: {total} elements, {total - len(elements)} tile-edge duplicates dropped"
            )
        return elements

    def _published(self, target: _BakeTarget) -> None:
        self.store.invalidate()
        if self._on_published is not None:
            self._on_published()
        self._log(f"{target.name!r} done")

    def _check_cancel(self) -> None:
        if self.cancel_requested():
            raise PoiIngestError("cancelled")

    def _write_sidecar(self, target: _BakeTarget, content_hash: str | None) -> None:
        write_sidecar(
            self.store.root,
            target.set_id,
            name=target.name,
            country=target.country,
            bbox=target.bbox,
            implementation=target.implementation,
            content_hash=content_hash,
        )

    def _write_set(
        self,
        target: _BakeTarget,
        cfg: PoiConfig,
        features: list[Feature],
        *,
        content_hash: str | None = None,
    ) -> None:
        """The shared tail: features -> ``<set_id>.pmtiles`` -> sidecar ->
        search rebake -> drop other sources' leftovers -> store invalidate."""
        self._update(state=ST_BAKE, feature_count=len(features))

        root = self.store.root
        root.mkdir(parents=True, exist_ok=True)
        out = root / f"{target.set_id}.pmtiles"
        self._progress(0, len(features), task="writing tiles")
        tile_count = chartcore.build_pmtiles(
            features, POI_LAYER, cfg.min_zoom, cfg.max_zoom, out
        )
        self._progress(len(features), len(features))
        self._update(tile_count=tile_count)
        self._log(f"wrote {tile_count} tiles to {out.name}")

        # Written after the archive: a bake that fails before this leaves no
        # half-labelled set.
        self._write_sidecar(target, content_hash)

        # Optional: a runner built without a search_index callable (e.g. a
        # bare unit test) simply skips this.
        if self._search_index is not None:
            self._progress(0, len(features), task="indexing for search")
            try:
                self._search_index().rebake(
                    "poi", target.set_id, _search_records(features), updated_at=time.time()
                )
            except Exception as e:  # noqa: BLE001 — search is secondary to the map
                # The tiles and sidecar are already written: failing the bake
                # here would report an error for a set that is on disk and
                # (after the next rescan) on the map anyway, and never publish
                # it now. Search is a side index; say so and carry on.
                log.exception("POI search indexing failed for %s", target.set_id)
                self._log(
                    f"warning: search indexing failed ({e}); the POIs are on the map "
                    "but not searchable until the next successful bake"
                )
            else:
                self._progress(len(features), len(features))
                self._log(f"indexed {len(features)} features for search")

        # A set re-baked from another source: that source's extra files
        # (details, photos…) would only be stale disk use. Only now — until
        # this publish the old archive was still served and its files still
        # used, and a bake that failed before this point must leave them.
        self._remove_leftovers(target)

        # The new archive is in the scanned dir; force the store to pick it up.
        self._published(target)

    def _remove_leftovers(self, target: _BakeTarget) -> None:
        """Delete files other sources keep beside this set (user decision:
        switched source -> deleted, not kept). Best effort: the new set is
        already on disk, so a failure is a warning, not a failed bake."""
        try:
            removed, freed = self.store.remove_source_files(
                self.store.root, target.set_id, keep=target.implementation
            )
        except OSError as e:
            log.exception("removing leftovers of %s failed", target.set_id)
            self._log(f"warning: could not remove the previous source's files ({e})")
            return
        if removed:
            self._log(
                f"removed the previous source's files: {', '.join(removed)} "
                f"({freed / 1e6:.1f} MB freed)"
            )

    def _fetch_heartbeat(self, stop: threading.Event, beat: _Beat) -> None:
        """Tick the fetch stage's ``task`` with the beat's label and the
        seconds since it was last set, until ``stop`` is set. Elapsed seconds
        are not a stage size, so they belong in the label; the tile counter
        rides ``current``/``total`` (``0``/``0`` for a single request)."""
        while not stop.wait(FETCH_HEARTBEAT_S):
            beat.tick()


class PoiBakeJob:
    """What a plugin :class:`~mivnav.features.poi.sources.PoiSource`'s
    ``bake`` gets: the target, the current ``poi`` config, the shared HTTP
    client, progress/log/cancel plumbing, and the shared publish tail.

    A typical bake: :meth:`fetching`, fetch (inside :meth:`heartbeat` while
    one long request blocks), map to ``(lon, lat, props)`` features whose
    props carry ``src = <source id>``, :meth:`cull_to_region`, then
    :meth:`write_set` (or :meth:`keep_existing` when :meth:`unchanged`), and
    finally any post-publish passes of its own, with :meth:`check_cancel` /
    :meth:`wait` between requests. Raise :class:`PoiIngestError` to fail."""

    def __init__(
        self, runner: PoiIngestRunner, target: _BakeTarget, cfg: PoiConfig, app_config: Any = None
    ) -> None:
        self._runner = runner
        self._target = target
        #: The ``poi`` slice (zooms, …) as of the bake's start.
        self.config = cfg
        #: The whole ``Config`` as of the bake's start (``None`` for a runner
        #: built without one, e.g. in a unit test) — a plugin reads its own
        #: ``Config.plugins`` block from it.
        self.app_config = app_config

    # -- the target ------------------------------------------------------
    @property
    def set_id(self) -> str:
        return self._target.set_id

    @property
    def name(self) -> str:
        return self._target.name

    @property
    def country(self) -> str | None:
        return self._target.country

    @property
    def bbox(self) -> BBox | None:
        return self._target.bbox

    @property
    def bboxes(self) -> tuple[BBox, ...]:
        t = self._target
        return t.bboxes or ((t.bbox,) if t.bbox is not None else ())

    @property
    def params(self) -> BaseModel | None:
        return self._target.params

    @property
    def http(self) -> httpx.Client:
        return self._runner._http

    @property
    def root(self) -> Path:
        """The directory the set's archive (and any extra files) live in."""
        return self._runner.store.root

    # -- progress ----------------------------------------------------------
    def fetching(self, task: str = "fetching") -> None:
        self._runner._update(state=ST_FETCH)
        self._runner._progress(0, 0, task=task)

    def progress(self, current: int, total: int, task: str | None = None) -> None:
        if task is None:
            self._runner._progress(current, total)
        else:
            self._runner._progress(current, total, task=task)

    def log(self, message: str) -> None:
        self._runner._log(message)

    def stats(self, **counters: int) -> None:
        """Merge source-specific counters into the job status's ``stats``."""
        with self._runner._lock:
            merged = {**self._runner._status.stats, **counters}
        self._runner._update(stats=merged)

    def heartbeat(self, label: str = "fetching", current: int = 0, total: int = 0):
        return self._runner._heartbeat(label, current, total)

    # -- cancel ------------------------------------------------------------
    def cancelled(self) -> bool:
        return self._runner.cancel_requested()

    def check_cancel(self) -> None:
        self._runner._check_cancel()

    def wait(self, seconds: float) -> bool:
        """Sleep ``seconds``, waking at once on cancel; ``True`` if cancelled."""
        return self._runner._cancel_event.wait(seconds)

    # -- shared steps --------------------------------------------------------
    def cull_to_region(self, features: list[Feature]) -> list[Feature]:
        """Keep the features in the target region: the country's border (with
        the usual loose buffer) or any of the region's boxes."""
        if self.country is not None:
            self.progress(0, len(features), task=f"clipping to {self.country} border")
            out = cull_to_country(features, self.country)
            self.log(f"clipped to {self.country} border: {len(out)} features remain")
        else:
            boxes = self.bboxes
            if not boxes:
                raise PoiIngestError("a POI bake needs a country or at least one bbox")
            self.progress(0, len(features), task="clipping to region")
            out = cull_to_bboxes(features, boxes)
            self.log(f"clipped to {len(boxes)} region box(es): {len(out)} features remain")
        self.progress(len(out), len(out))
        return out

    def content_hash(self, features: list[Feature], version: object = 0) -> str:
        return content_hash(features, self.config, version)

    def unchanged(self, digest: str) -> bool:
        """The last bake of this set recorded ``digest`` and its archive is
        still there — :meth:`keep_existing` instead of re-tiling."""
        previous = read_sidecar(self.root, self.set_id)
        return (
            previous is not None
            and previous.get("content_hash") == digest
            and (self.root / f"{self.set_id}.pmtiles").is_file()
        )

    def keep_existing(self, digest: str | None, feature_count: int) -> None:
        """Skip the tile/search rewrite; the sidecar is still rewritten so the
        dataset's last-bake time records the check."""
        self._runner._update(state=ST_BAKE, feature_count=feature_count)
        self.log("unchanged since the last bake — keeping the existing tiles")
        self._runner._write_sidecar(self._target, digest)
        self._runner._published(self._target)

    def write_set(self, features: list[Feature], *, content_hash: str | None = None) -> None:
        """The shared tail: tiles, sidecar, search index, publish."""
        self._runner._write_set(self._target, self.config, features, content_hash=content_hash)
