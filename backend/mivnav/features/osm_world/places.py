# SPDX-License-Identifier: GPL-2.0-only
"""Place names, harvested out of the baked basemap archives into the shared
search index — the ONE source of settlement names in mivnav (task nvpxzxxq
replaced POI's Overpass-fetched place carve-out with this). Indexed via an
idempotent, mtime-keyed :func:`sync_places` rather than at bake time, since
bake-time indexing would miss already-extracted archives and the generic
ingest path. Scan zoom is capped by a tile budget, not a fixed zoom, so a
world set lands shallow and a region set gets its full z12. See
docs/architecture/osm-world-place-index.md for the full rationale and the
measured cost table.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass

from mivnav.charts.mvt import MVTError, point_features
from mivnav.charts.pmtiles import Archive, Header, PMTilesError, decompress
from mivnav.features.osm_world.store import OsmWorldStore
from mivnav.search import SearchIndex, SearchRecord

log = logging.getLogger(__name__)

#: The MVT layer Protomaps' basemap schema puts place labels in.
PLACES_LAYER = "places"

#: The ``source`` every place row is baked under, attributing bytes back to
#: the osm_world dataset (see docs/architecture/osm-world-place-index.md).
PLACE_SOURCE = "osm_world"

#: Web-Mercator's latitude limit — the bound a PMTiles header reports for a
#: whole-world archive, and the clamp the tile-range math needs to stay
#: inside the pyramid.
MAX_LATITUDE = 85.0511287


def _tile_x(lon: float, z: int) -> int:
    n = 1 << z
    return min(n - 1, max(0, int((lon + 180.0) / 360.0 * n)))


def _tile_y(lat: float, z: int) -> int:
    n = 1 << z
    lat = min(MAX_LATITUDE, max(-MAX_LATITUDE, lat))
    rad = math.radians(lat)
    frac = (1 - math.log(math.tan(rad) + 1 / math.cos(rad)) / math.pi) / 2
    return min(n - 1, max(0, int(frac * n)))


def tile_range(bounds: tuple[float, float, float, float], z: int) -> tuple[int, int, int, int]:
    """``(x0, x1, y0, y1)`` INCLUSIVE tile range covering ``bounds``
    (``min_lon, min_lat, max_lon, max_lat``, the order a PMTiles header
    reports) at zoom ``z``."""
    min_lon, min_lat, max_lon, max_lat = bounds
    return (
        _tile_x(min_lon, z),
        _tile_x(max_lon, z),
        _tile_y(max_lat, z),  # north edge is the SMALLER y
        _tile_y(min_lat, z),
    )


def tile_count(bounds: tuple[float, float, float, float], z: int) -> int:
    x0, x1, y0, y1 = tile_range(bounds, z)
    return (x1 - x0 + 1) * (y1 - y0 + 1)


def scan_zoom(header: Header, budget: int) -> int | None:
    """The deepest zoom this archive can be scanned at within ``budget``
    tiles, or ``None`` when even its shallowest zoom does not fit (budget
    ``0`` — place indexing off). See the module docstring for why
    deepest-that-fits, not a fixed zoom.
    """
    if budget <= 0:
        return None
    for z in range(header.max_zoom, header.min_zoom - 1, -1):
        if tile_count(header.bounds, z) <= budget:
            return z
    return None


def _record(lon: float, lat: float, props: dict) -> SearchRecord | None:
    """One ``places`` feature → an index row, or ``None`` for a feature with
    no name (an unlabelled place is nothing to search for). ``data`` keeps
    only renderable properties, not the full Protomaps name:<lang>/wikidata
    set; the English exonym goes only into FTS ``text`` so "Copenhagen"
    finds "København". See docs/architecture/osm-world-place-index.md.
    """
    name = props.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    name = name.strip()
    kind = props.get("kind")
    kind_detail = props.get("kind_detail")
    category = kind_detail if isinstance(kind_detail, str) else kind if isinstance(kind, str) else None
    terms = [name]
    english = props.get("name:en")
    if isinstance(english, str) and english.strip() and english.strip() != name:
        terms.append(english.strip())
    data: dict = {"name": name}
    if isinstance(kind, str):
        data["kind"] = kind
    if isinstance(category, str):
        data["kind_detail"] = category
    population = props.get("population")
    if isinstance(population, (int, float)):
        data["population"] = int(population)
    return SearchRecord(
        # Coordinate in the id dedupes the same place repeated across
        # neighbouring tiles' label buffers; `rebake` only needs per-batch
        # uniqueness (it qualifies ids with source/region).
        id=f"{name}-{lon:.5f}-{lat:.5f}",
        category=category,
        title=name,
        text=" ".join(terms),
        lat=lat,
        lon=lon,
        data=data,
    )


def scan_archive(archive: Archive, zoom: int) -> list[SearchRecord]:
    """Every named place in ``archive``, read out of its ``places`` layer at
    ``zoom``. Deduplicated by row id (name + rounded coordinate) since a
    place repeats across neighbouring tiles' label buffers; a tile that
    fails to decode is skipped, not fatal. See
    docs/architecture/osm-world-place-index.md.
    """
    header = archive.header
    x0, x1, y0, y1 = tile_range(header.bounds, zoom)
    records: dict[str, SearchRecord] = {}
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            try:
                raw = archive.tile_data(zoom, x, y)
            except PMTilesError as e:
                log.warning("place scan: tile %d/%d/%d unreadable: %s", zoom, x, y, e)
                continue
            if raw is None:
                continue
            try:
                tile = decompress(header.tile_compression, raw)
                features = point_features(tile, PLACES_LAYER, zoom, x, y)
            except (PMTilesError, MVTError, OSError, ValueError) as e:
                log.warning("place scan: tile %d/%d/%d undecodable: %s", zoom, x, y, e)
                continue
            for lon, lat, props in features:
                record = _record(lon, lat, props)
                if record is not None:
                    records[record.id] = record
    return list(records.values())


@dataclass(frozen=True)
class SyncResult:
    """What one :func:`sync_places` pass did — set id → rows indexed, plus
    the sets it left alone because their slice was already current."""

    indexed: dict[str, int]
    skipped: tuple[str, ...]


def sync_places(store: OsmWorldStore, index: SearchIndex, budget: int) -> SyncResult:
    """Bring the search index's place rows in line with the basemap sets on
    disk. Idempotent, and cheap when there is nothing to do: a set is
    rescanned only when the index's slice is missing or older than the
    archive's mtime. Deleted sets' rows are not swept here (same orphan POI
    has — see docs/architecture/osm-world-place-index.md).
    """
    indexed: dict[str, int] = {}
    skipped: list[str] = []
    for set_id, os_set in store.sets().items():
        archive_at = os_set.sequence / 1e9
        current = index.slice_updated_at(PLACE_SOURCE, set_id)
        if current is not None and current >= archive_at:
            skipped.append(set_id)
            continue
        zoom = scan_zoom(os_set.archive.header, budget)
        if zoom is None:
            skipped.append(set_id)
            continue
        started = time.monotonic()
        records = scan_archive(os_set.archive, zoom)
        index.rebake(PLACE_SOURCE, set_id, records, updated_at=archive_at)
        indexed[set_id] = len(records)
        log.info(
            "indexed %d places from osm_world set %s (z%d, %.1fs)",
            len(records),
            set_id,
            zoom,
            time.monotonic() - started,
        )
    return SyncResult(indexed=indexed, skipped=tuple(skipped))
