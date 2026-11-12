# SPDX-License-Identifier: GPL-2.0-only
"""Satellite-set registry: pre-baked raster PMTiles archives in a directory.

A near-clone of :class:`mivnav.features.poi.store.PoiStore` pointed at
``data_root/satellite``. Tiles are RASTER (JPEG/PNG) not MVT — the only
difference from a POI set, handled entirely on the serving side; the store
itself is payload-agnostic."""

from __future__ import annotations

import logging
from collections.abc import Callable, Collection
from dataclasses import dataclass
from pathlib import Path

from mivnav.charts.pmtiles import Archive, PMTilesError
from mivnav.rescan import RescanRegistry, pmtiles_candidates
from mivnav.features.satellite.sidecar import resolve_metadata, sidecar_path

log = logging.getLogger(__name__)


@dataclass
class SatelliteSet:
    id: str
    archive: Archive
    sequence: int  # st_mtime_ns of the archive file
    name: str  # human-readable, from the sidecar (or id fallback)
    updated_at: str  # ISO-8601 UTC; sidecar timestamp, else file mtime
    region: dict | None  # {"bbox": [...], "source": id} | None
    tile_format: str | None  # "jpg"|"png"|"webp" from the sidecar, or None
    metadata: dict  # parsed PMTiles JSON metadata


class SatelliteStore(RescanRegistry[SatelliteSet]):
    def __init__(
        self,
        root: Path,
        rescan_interval: float | None = None,
        *,
        excluded: Callable[[], Collection[str]] | None = None,
    ) -> None:
        super().__init__(rescan_interval, excluded=excluded)
        self.root = root

    def delete(self, set_id: str) -> bool:
        """Delete a baked satellite set's ``.pmtiles`` (and sidecar), then
        rescan. Path comes from the store's own scan, never string-built from
        ``set_id``, so a traversal-y id can't escape ``satellite.dir``."""
        ss = self.get(set_id)
        if ss is None:
            return False
        path = ss.archive.path.resolve()
        root = self.root.resolve()
        if root not in path.parents:
            log.error("refusing to delete %s: outside satellite dir %s", path, root)
            return False
        ss.archive.close()
        path.unlink(missing_ok=True)
        # dataset_dir: flat root (legacy) or the set's own nested `<id>/` folder
        # (M-DATA-3) — see mivnav.rescan.pmtiles_candidates.
        dataset_dir = path.parent
        sidecar = sidecar_path(dataset_dir, ss.id).resolve()
        if root in sidecar.parents:
            sidecar.unlink(missing_ok=True)
        dataset_json = (dataset_dir / "dataset.json").resolve()
        if root in dataset_json.parents:
            dataset_json.unlink(missing_ok=True)
        if dataset_dir.resolve() != root:
            # nested per-dataset folder, now empty
            try:
                dataset_dir.rmdir()
            except OSError:
                pass
        self.invalidate()
        log.info("deleted satellite set %s (%s)", set_id, path)
        return True

    def _list(self):
        for path in pmtiles_candidates(self.root):
            try:
                stat = path.stat()
            except OSError:
                continue
            token = (stat.st_mtime_ns, stat.st_size)
            yield (
                path.stem,
                token,
                lambda p=path, sid=path.stem, seq=stat.st_mtime_ns: self._build(p, sid, seq),
            )

    def _build(self, path: Path, set_id: str, sequence: int) -> SatelliteSet | None:
        try:
            archive = Archive(path)
        except (PMTilesError, OSError) as e:
            log.warning("skipping %s: %s", path, e)
            return None
        try:
            metadata = archive.metadata()
        except (PMTilesError, ValueError) as e:  # includes bad JSON
            archive.close()  # unpublished: eager close is safe
            log.warning("skipping %s: %s", path, e)
            return None
        name, updated_at, region, tile_format = resolve_metadata(
            path.parent, set_id, sequence
        )
        return SatelliteSet(
            id=set_id,
            archive=archive,
            sequence=sequence,
            name=name,
            updated_at=updated_at,
            region=region,
            tile_format=tile_format,
            metadata=metadata,
        )
