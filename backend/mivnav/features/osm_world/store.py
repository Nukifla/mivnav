# SPDX-License-Identifier: GPL-2.0-only
"""World-basemap-set registry: extracted PMTiles archives in a directory.

Every set under this root must share ONE schema (Protomaps' basemap layers)
since the cross-set merge in `/osm_world/tiles/all` assumes it — see
docs/architecture/osm-world-basemap.md (task unqqplrl).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Collection
from dataclasses import dataclass
from pathlib import Path

from mivnav.charts.pmtiles import Archive, PMTilesError
from mivnav.features.osm_world.sidecar import resolve_metadata, sidecar_path
from mivnav.rescan import RescanRegistry, pmtiles_candidates

log = logging.getLogger(__name__)


@dataclass
class OsmWorldSet:
    id: str
    archive: Archive
    sequence: int  # st_mtime_ns of the archive file
    name: str  # human-readable, from the sidecar (or id fallback)
    updated_at: str  # ISO-8601 UTC; sidecar timestamp, else file mtime
    region: dict | None  # {"bbox": [w, s, e, n]} if region-scoped, else None
    metadata: dict  # parsed PMTiles JSON metadata (vector_layers, …)


class OsmWorldStore(RescanRegistry[OsmWorldSet]):
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
        """Delete a set's archive, sidecar and (nested-layout) dataset dir.
        Refuses to unlink anything outside this store's root, since a set id
        is reachable from an HTTP route."""
        os_ = self.get(set_id)
        if os_ is None:
            return False
        path = os_.archive.path.resolve()
        root = self.root.resolve()
        if root not in path.parents:
            log.error("refusing to delete %s: outside osm_world dir %s", path, root)
            return False
        os_.archive.close()
        path.unlink(missing_ok=True)
        dataset_dir = path.parent
        sidecar = sidecar_path(dataset_dir, os_.id).resolve()
        if root in sidecar.parents:
            sidecar.unlink(missing_ok=True)
        dataset_json = (dataset_dir / "dataset.json").resolve()
        if root in dataset_json.parents:
            dataset_json.unlink(missing_ok=True)
        if dataset_dir.resolve() != root:
            try:
                dataset_dir.rmdir()
            except OSError:
                pass
        self.invalidate()
        log.info("deleted osm_world set %s (%s)", set_id, path)
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

    def _build(self, path: Path, set_id: str, sequence: int) -> OsmWorldSet | None:
        try:
            archive = Archive(path)
        except (PMTilesError, OSError) as e:
            log.warning("skipping %s: %s", path, e)
            return None
        try:
            metadata = archive.metadata()
        except (PMTilesError, ValueError) as e:
            archive.close()
            log.warning("skipping %s: %s", path, e)
            return None
        name, updated_at, region = resolve_metadata(path.parent, set_id, sequence)
        return OsmWorldSet(
            id=set_id,
            archive=archive,
            sequence=sequence,
            name=name,
            updated_at=updated_at,
            region=region,
            metadata=metadata,
        )
