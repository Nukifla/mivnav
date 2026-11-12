# SPDX-License-Identifier: GPL-2.0-only
"""The satellite region-bake job: XYZ fetch → raster ``<id>.pmtiles`` → rescan.
Same job spine as :mod:`mivnav.features.poi.ingest`. See
docs/architecture/satellite-ingest.md for the pipeline shape."""

from __future__ import annotations

import itertools
import logging
import math
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import httpx

from mivnav.features.satellite.config import SatelliteConfig, SatelliteSource
from mivnav.ingest.runner import ST_BAKE, BaseJobStatus, BBox, IngestRunner
from mivnav.features.satellite.pmtiles_writer import write_raster_pmtiles
from mivnav.features.satellite.sidecar import slugify, write_sidecar
from mivnav.features.satellite.store import SatelliteStore

log = logging.getLogger(__name__)

# Same retry shape as the Overpass fetch (mivnav.features.poi.overpass):
# public tile servers shed load transiently, so a 429/5xx/transport hiccup
# retries with exponential backoff before the tile is given up on.
SAT_RETRIES = 3  # total attempts per tile
SAT_RETRY_BACKOFF_S = 1.0  # base delay; grows 1s, 2s, 4s…
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})

# Public imagery front-ends (ESRI, EOX) apply the OSM-style tile usage policy
# and may reject a generic/library UA — same reason Overpass sets one.
USER_AGENT = "mivnav/0.1 (chart plotter; satellite imagery bake; +https://github.com/mivnav)"

# Bounded concurrency within a zoom level: fetch order doesn't matter (the
# writer sorts/dedups by tile-id), and unbounded concurrency would trip a
# public tile server's (ESRI/EOX) load shedding.
SAT_FETCH_WORKERS = 8


class SatelliteIngestError(Exception):
    pass


# A z0-14 bake attempts tens of thousands of tiles; logging every one would
# blow past LOG_CAP and be noise, so `_tiles` only logs every Nth attempt.
PROGRESS_LOG_EVERY = 500


def total_tile_count(bbox: BBox, min_zoom: int, max_zoom: int) -> int:
    """The number of tiles a bake will ATTEMPT to fetch, not how many land —
    the progress bar's denominator, so it reaches 100% even over a bbox with
    partial coverage."""
    total = 0
    for z in range(min_zoom, max_zoom + 1):
        x_min, y_min, x_max, y_max = tile_range(bbox, z)
        total += (x_max - x_min + 1) * (y_max - y_min + 1)
    return total


def tile_range(bbox: BBox, z: int) -> tuple[int, int, int, int]:
    """The inclusive ``(x_min, y_min, x_max, y_max)`` Slippy-map tile range
    covering ``bbox`` = ``(w, s, e, n)`` at zoom ``z``. North latitude maps
    to the *smaller* y; both axes clamp to ``[0, 2^z - 1]`` for the antimeridian/poles."""
    w, s, e, n = bbox
    n_tiles = 1 << z

    def _x(lon: float) -> int:
        return int((lon + 180.0) / 360.0 * n_tiles)

    def _y(lat: float) -> int:
        lat = max(min(lat, 85.05112878), -85.05112878)  # Mercator limit
        rad = math.radians(lat)
        return int((1.0 - math.asinh(math.tan(rad)) / math.pi) / 2.0 * n_tiles)

    def _clamp(v: int) -> int:
        return max(0, min(v, n_tiles - 1))

    x_min, x_max = sorted((_clamp(_x(w)), _clamp(_x(e))))
    y_min, y_max = sorted((_clamp(_y(n)), _clamp(_y(s))))
    return x_min, y_min, x_max, y_max


def fetch_tile(
    http: httpx.Client,
    source: SatelliteSource,
    z: int,
    x: int,
    y: int,
    *,
    retries: int = SAT_RETRIES,
    backoff_s: float = SAT_RETRY_BACKOFF_S,
    sleep: Callable[[float], None] = time.sleep,
) -> bytes | None:
    """Fetch one XYZ tile's bytes, or ``None`` on a 404 (normal at a bake's
    edges) or after retries are exhausted (logged, doesn't abort the bake).
    ``sleep`` is injected so tests need not wait real seconds."""
    url = source.url_template.format(z=z, x=x, y=y)
    for attempt in range(retries):
        try:
            resp = http.get(url, headers={"User-Agent": USER_AGENT})
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.content
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            if code in RETRYABLE_STATUS and attempt < retries - 1:
                sleep(backoff_s * (2**attempt))
                continue
            log.warning("satellite tile %s z%d/%d/%d: HTTP %d — skipped", source.id, z, x, y, code)
            return None
        except httpx.HTTPError as e:
            if attempt < retries - 1:
                sleep(backoff_s * (2**attempt))
                continue
            log.warning("satellite tile %s z%d/%d/%d: %s — skipped", source.id, z, x, y, e)
            return None
    return None


@dataclass
class JobStatus(BaseJobStatus):
    tile_count: int = 0  # raster tiles fetched+written so far


@dataclass(frozen=True)
class _BakeTarget:
    """One bake's identity + parameters, resolved once in :meth:`ingest`."""

    set_id: str
    name: str
    source: SatelliteSource
    bbox: BBox
    min_zoom: int
    max_zoom: int


class SatelliteIngestRunner(IngestRunner[JobStatus]):
    """One background satellite bake at a time; status is poll-able. Mirrors
    :class:`mivnav.features.poi.ingest.PoiIngestRunner`'s job spine — see
    docs/architecture/satellite-ingest.md."""

    status_cls = JobStatus
    busy_error = SatelliteIngestError
    job_name = "satellite bake"

    def __init__(
        self,
        store: SatelliteStore,
        http: httpx.Client | None = None,
        satellite_config: Callable[[], SatelliteConfig] | None = None,
        dataset_id: str | None = None,
    ) -> None:
        super().__init__()
        self.store = store
        self._http = http or httpx.Client(
            timeout=httpx.Timeout(60.0, connect=15.0), follow_redirects=True
        )
        self._satellite_config = satellite_config or SatelliteConfig
        # Set ONLY by the generic-dataset factory (satellite.provider.
        # _satellite_runner_factory); see PoiIngestRunner's own dataset_id
        # for the shared reasoning (wptyyquu).
        self._dataset_id = dataset_id

    def ingest(
        self, source_id: str, bbox: BBox, name: str | None = None
    ) -> None:
        """Start a background bake of ``bbox`` from ``source_id``. Returns
        immediately. Config is snapshotted here so a concurrent
        ``PATCH /config`` can't change the source/zooms mid-run."""
        cfg = self._satellite_config()
        source = cfg.source(source_id)
        if source is None:
            raise SatelliteIngestError(f"unknown satellite source {source_id!r}")
        if not source.bakeable:
            raise SatelliteIngestError(
                f"satellite source {source_id!r} is online-only (not bakeable)"
            )
        display = name or source.name
        # Region-name slug (re-baking the same name overwrites in place),
        # unless the generic /datasets/{id}/ingest path supplied its own id —
        # must key on the dataset's real id, not a name that can drift.
        set_id = self._dataset_id if self._dataset_id is not None else slugify(display)
        max_zoom = min(cfg.max_zoom, source.max_zoom)  # fetching past this is a wall of 404s
        min_zoom = min(cfg.min_zoom, max_zoom)
        target = _BakeTarget(
            set_id=set_id,
            name=display,
            source=source,
            bbox=bbox,
            min_zoom=min_zoom,
            max_zoom=max_zoom,
        )
        self._start(display, lambda: self._bake(target))

    def _tiles(
        self, target: _BakeTarget, total: int
    ) -> Iterator[tuple[int, int, int, bytes]]:
        """Yield ``(z, x, y, bytes)`` for every present tile, missing ones
        skipped but still counted in ``attempted``. Fetches concurrently per
        zoom; only ``fetch_tile`` runs off-thread, so bookkeeping needs no lock."""
        written = 0
        attempted = 0
        with ThreadPoolExecutor(max_workers=SAT_FETCH_WORKERS) as pool:
            for z in range(target.min_zoom, target.max_zoom + 1):
                x_min, y_min, x_max, y_max = tile_range(target.bbox, z)
                self._progress(attempted, total, task=f"fetching z{z} tiles")
                self._log(
                    f"z{z}: {(x_max - x_min + 1) * (y_max - y_min + 1)} tiles addressable"
                )
                coords = itertools.product(range(x_min, x_max + 1), range(y_min, y_max + 1))

                def _fetch(xy: tuple[int, int], z: int = z) -> tuple[int, int, bytes | None]:
                    x, y = xy
                    return x, y, fetch_tile(self._http, target.source, z, x, y)

                for x, y, data in pool.map(_fetch, coords):
                    attempted += 1
                    if data is not None:
                        written += 1
                        yield z, x, y, data
                    if attempted % 50 == 0:
                        self._update(tile_count=written)
                    if attempted % PROGRESS_LOG_EVERY == 0:
                        self._progress(attempted, total)
                        self._log(
                            f"z{z}: {attempted}/{total} tiles attempted, "
                            f"{written} written so far"
                        )
        self._update(tile_count=written)
        self._progress(attempted, total)

    def _bake(self, target: _BakeTarget) -> None:
        self._update(state=ST_BAKE)
        total = total_tile_count(target.bbox, target.min_zoom, target.max_zoom)
        self._progress(0, total, task="fetching tiles")
        self._log(
            f"baking {target.name!r} from {target.source.id!r}, "
            f"z{target.min_zoom}-{target.max_zoom} ({total} tiles addressable)"
        )
        root = self.store.root
        root.mkdir(parents=True, exist_ok=True)
        out = root / f"{target.set_id}.pmtiles"
        written = write_raster_pmtiles(
            out,
            self._tiles(target, total),
            name=target.name,
            bounds=target.bbox,
            min_zoom=target.min_zoom,
            max_zoom=target.max_zoom,
            tile_type=target.source.tile_type,
            tile_format=target.source.tile_format,
        )
        if written == 0:
            # Every tile 404'd (a bbox with no coverage, a dead source). The
            # writer still produced a valid empty archive; remove it and fail
            # loudly rather than publish an imagery set with no imagery.
            out.unlink(missing_ok=True)
            self._log(f"no tiles fetched for {target.name!r} — aborting")
            raise SatelliteIngestError(
                f"no tiles fetched for {target.name!r} from {target.source.id!r} "
                "(bbox has no coverage, or the source is unreachable)"
            )
        self._update(tile_count=written)
        self._log(f"wrote {written} tiles to {out.name}")

        # Sidecar beside the archive: name/source/format/bbox/updated_at, so the
        # store can label this set and the UI can re-run it. Written after the
        # archive (a bake that fails before this leaves no half-labelled set).
        write_sidecar(
            root,
            target.set_id,
            name=target.name,
            source=target.source.id,
            tile_format=target.source.tile_format,
            bbox=target.bbox,
        )
        self.store.invalidate()
        self._log(f"{target.name!r} done")
