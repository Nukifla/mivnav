# SPDX-License-Identifier: GPL-2.0-only
"""POI-set registry: pre-baked PMTiles archives in ``data_root/poi``, via
:class:`mivnav.rescan.RescanRegistry` (see docs/architecture/rescan-registry.md).
One POI set is a ``<id>.pmtiles`` file whose vector layer id is ``pois`` —
a Protomaps-style OSM extract with ``{name, kind, min_zoom, kind_detail}``
keys, unlike a chart set's S-57-derived layers."""

from __future__ import annotations

import logging
import shutil
from collections.abc import Callable, Collection
from dataclasses import dataclass
from pathlib import Path

from mivnav.charts.pmtiles import Archive, PMTilesError
from mivnav.features.poi import overpass_resume
from mivnav.features.poi.sources import poi_sources
from mivnav.features.poi.sidecar import resolve_metadata, sidecar_path
from mivnav.rescan import RescanRegistry, pmtiles_candidates

log = logging.getLogger(__name__)


@dataclass
class PoiSet:
    id: str
    archive: Archive
    sequence: int  # st_mtime_ns of the archive file
    name: str  # human-readable, from the sidecar (or id/ISO fallback)
    updated_at: str  # ISO-8601 UTC; sidecar timestamp, else file mtime
    region: dict | None  # {"country": iso} | {"bbox": [...]} | None
    metadata: dict  # parsed PMTiles JSON metadata (vector_layers, …)


class PoiStore(RescanRegistry[PoiSet]):
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
        """Delete a baked POI set's ``.pmtiles`` file (plus its sidecar and
        any files a plugin source keeps beside it) from disk, then rescan.
        Returns ``True`` if removed, ``False`` if ``set_id`` is unknown. The
        path is resolved from the store's OWN scan, never string-built from
        ``set_id``, so a path-traversal id can never escape ``root``."""
        ps = self.get(set_id)
        if ps is None:
            return False
        path = ps.archive.path.resolve()
        root = self.root.resolve()
        if root not in path.parents:
            # Should be impossible (store only lists files under root), but
            # never unlink outside the managed directory.
            log.error("refusing to delete %s: outside POI dir %s", path, root)
            return False
        ps.archive.close()
        path.unlink(missing_ok=True)
        # Remove the sidecar too, so a delete never leaves an orphan <id>.json
        # behind. `dataset_dir` is `path.parent` — the flat root for a legacy
        # set, or the set's own nested `<id>/` folder (M-DATA-3 layout).
        dataset_dir = path.parent
        sidecar = sidecar_path(dataset_dir, ps.id).resolve()
        if root in sidecar.parents:
            sidecar.unlink(missing_ok=True)
        # Whatever a plugin source keeps beside the archive (details, photos…).
        self.remove_source_files(dataset_dir, ps.id)
        # A failed Overpass bake's kept tiles (poi-overpass-fetch.md, "Resume").
        resume = overpass_resume.resume_path(dataset_dir, ps.id).resolve()
        if root in resume.parents:
            resume.unlink(missing_ok=True)
        dataset_json = (dataset_dir / "dataset.json").resolve()
        if root in dataset_json.parents:
            dataset_json.unlink(missing_ok=True)
        if dataset_dir.resolve() != root:
            # A nested per-dataset folder — remove now that it's empty.
            try:
                dataset_dir.rmdir()
            except OSError:
                pass
        self.invalidate()
        log.info("deleted POI set %s (%s)", set_id, path)
        return True

    def remove_source_files(
        self, dataset_dir: Path, set_id: str, *, keep: str | None = None
    ) -> tuple[list[str], int]:
        """Remove the extra files every POI source but ``keep`` declares for
        set ``set_id`` in ``dataset_dir`` (the folder its archive lives in;
        :attr:`PoiSource.extra_files`). Keyed by ``set_id``, so another set's
        files are never touched, and only paths resolving under ``root`` are
        removed. Used by :meth:`delete` and by a bake publishing over a set
        from another source. Returns the removed names and the bytes they
        took."""
        root = self.root.resolve()
        removed: list[str] = []
        freed = 0
        for source_id, source in poi_sources().items():
            if source_id == keep:
                continue
            for path in source.extra_files(dataset_dir, set_id):
                if root not in path.resolve().parents:
                    continue
                if path.is_dir() and not path.is_symlink():
                    for sub in path.rglob("*"):
                        try:
                            if sub.is_file():
                                freed += sub.lstat().st_size
                        except OSError:
                            pass
                    shutil.rmtree(path, ignore_errors=True)
                    removed.append(f"{path.name}/")
                elif path.exists() or path.is_symlink():
                    try:
                        freed += path.lstat().st_size
                    except OSError:
                        pass
                    path.unlink(missing_ok=True)
                    removed.append(path.name)
        return removed, freed

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

    def _build(self, path: Path, set_id: str, sequence: int) -> PoiSet | None:
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
        # `path.parent` is `root` for a flat (legacy) set, or the set's own
        # nested `<id>/` folder (M-DATA-3) — where the sidecar lives either way.
        name, updated_at, region = resolve_metadata(path.parent, set_id, sequence)
        return PoiSet(
            id=set_id,
            archive=archive,
            sequence=sequence,
            name=name,
            updated_at=updated_at,
            region=region,
            metadata=metadata,
        )

    def set_dir(self, set_id: str) -> Path | None:
        """The folder set ``set_id``'s archive lives in (flat or nested
        layout alike), or ``None`` for an unknown set — resolved from the
        store's OWN scan, never string-built from a request's id, so a
        plugin route can look up its files beside a set safely."""
        ps = self.get(set_id)
        if ps is None:
            return None
        return ps.archive.path.parent
