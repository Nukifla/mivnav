# SPDX-License-Identifier: GPL-2.0-only
"""Chart-set registry: pre-baked PMTiles archives in a directory
(``data_root/charts`` — M-DATA-3). See docs/architecture/rescan-registry.md
for the shared scan machinery, `sequence`/ETag semantics, and why only
failed archives are closed eagerly.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Collection
from dataclasses import dataclass
from pathlib import Path

from mivnav.rescan import RescanRegistry, pmtiles_candidates

from .pmtiles import Archive, PMTilesError

log = logging.getLogger(__name__)


@dataclass
class ChartSet:
    id: str
    archive: Archive
    sequence: int  # st_mtime_ns of the archive file
    name: str  # human-readable, from PMTiles metadata
    metadata: dict  # parsed PMTiles JSON metadata (vector_layers, …)


class ChartStore(RescanRegistry[ChartSet]):
    def __init__(
        self,
        root: Path,
        rescan_interval: float | None = None,
        *,
        excluded: Callable[[], Collection[str]] | None = None,
    ) -> None:
        super().__init__(rescan_interval, excluded=excluded)
        self.root = root

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

    def _build(self, path: Path, set_id: str, sequence: int) -> ChartSet | None:
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
        return ChartSet(
            id=set_id,
            archive=archive,
            sequence=sequence,
            name=str(metadata.get("name") or set_id),
            metadata=metadata,
        )
