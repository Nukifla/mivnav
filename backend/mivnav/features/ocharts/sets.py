# SPDX-License-Identifier: GPL-2.0-only
"""o-charts chart-set discovery and header scans.

See docs/architecture/ocharts-set-scanning.md for layout, sequence
semantics, and why failed header reads are never cached as facts.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import chartcore

from mivnav.rescan import DEFAULT_RESCAN_INTERVAL, RescanRegistry

from .keys import SetInfo, parse_set_info

# Re-exported: config `ocharts.rescan_interval_s` defaults to it, and the shared
# registry (mivnav.rescan) owns the rate-limit policy this store now rides.
__all__ = ["DEFAULT_RESCAN_INTERVAL"]

log = logging.getLogger(__name__)

CELL_EXTENSIONS = {".oesu", ".oesenc", ".senc", ".osenc"}

_ID_OK = re.compile(r"^[A-Za-z0-9._-]+$")

# (name, scale, (w, s, e, n)) as returned by chartcore.read_header
HeaderReader = Callable[[Path, str], dict]


@dataclass
class CellInfo:
    """One identified cell of a set."""

    path: Path
    key: str  # license key ("" for plain cells)
    name: str
    scale: int
    extent: tuple[float, float, float, float]  # w, s, e, n degrees
    min_zoom: int
    max_zoom: int
    # Coverage rings, or None if the cell declares none (see
    # docs/architecture/ocharts-set-scanning.md, "CellInfo.coverage").
    coverage: object | None = None


@dataclass
class OchartsSet:
    id: str
    directory: Path
    sequence: int
    info: SetInfo
    cells: list[CellInfo] = field(default_factory=list)
    # cells that failed their header read: path name -> error text
    cell_errors: dict[str, str] = field(default_factory=dict)

    @property
    def name(self) -> str:
        return self.info.title or self.id

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        w = min(c.extent[0] for c in self.cells)
        s = min(c.extent[1] for c in self.cells)
        e = max(c.extent[2] for c in self.cells)
        n = max(c.extent[3] for c in self.cells)
        return (w, s, e, n)

    @property
    def min_zoom(self) -> int:
        return min(c.min_zoom for c in self.cells)

    @property
    def max_zoom(self) -> int:
        return max(c.max_zoom for c in self.cells)


def _cell_info(path: Path, key: str, header: dict) -> CellInfo:
    """One identified cell, from its header read. Shared by the first scan
    and by the retry of a read that failed — the two must agree."""
    min_zoom, max_zoom = chartcore.zoom_range_for_scale(header["scale"])
    return CellInfo(
        path=path,
        key=key,
        # real daemon streams carry an empty cell name record
        name=header["name"] or path.stem,
        scale=header["scale"],
        extent=tuple(header["extent"]),
        min_zoom=min_zoom,
        max_zoom=max_zoom,
        coverage=header.get("coverage"),
    )


def dir_sequence(directory: Path) -> int:
    """Max st_mtime_ns over the directory and its direct entries."""
    seq = directory.stat().st_mtime_ns
    for entry in directory.iterdir():
        try:
            seq = max(seq, entry.stat().st_mtime_ns)
        except OSError:
            continue
    return seq


def cell_files(directory: Path) -> list[Path]:
    return sorted(
        p for p in directory.iterdir() if p.suffix.lower() in CELL_EXTENSIONS and p.is_file()
    )


class OchartsStore(RescanRegistry[OchartsSet]):
    """Registry of installed o-charts sets — the o-charts adaptation of
    :class:`mivnav.rescan.RescanRegistry`. See
    docs/architecture/ocharts-set-scanning.md for the rate-limit rationale.
    """

    def __init__(
        self,
        root: Path,
        header_reader: HeaderReader,
        rescan_interval: float | None = None,
    ) -> None:
        super().__init__(rescan_interval)
        self.root = root
        self._header_reader = header_reader

    def _list(self):
        dirs = (
            sorted(p for p in self.root.iterdir() if p.is_dir())
            if self.root.is_dir()
            else []
        )
        for directory in dirs:
            set_id = directory.name
            if not _ID_OK.match(set_id):
                log.warning("skipping chart set dir with unusable name: %s", directory)
                continue
            try:
                seq = dir_sequence(directory)
            except OSError:
                continue
            yield (
                set_id,
                seq,
                lambda d=directory, i=set_id, s=seq: self._load_set(i, d, s),
            )

    def _on_reuse(self, cs: OchartsSet) -> None:
        # Failed reads are not facts about the set — must not be cached as
        # if they were. See _retry_failed_cells.
        if cs.cell_errors:
            self._retry_failed_cells(cs)

    def _retry_failed_cells(self, cs: OchartsSet) -> None:
        """Re-read the headers this set's last scan could not.

        Failures are systemic (all encrypted cells go through oexserverd)
        and were previously cached against a sequence the daemon's recovery
        never moves — see docs/architecture/ocharts-set-scanning.md.
        Whole-field replacement of ``cs.cells``, not in-place mutation:
        lock-free readers see either the old list or the new one atomically.
        """
        cells = list(cs.cells)
        errors: dict[str, str] = {}
        recovered: list[str] = []
        for name, previous in cs.cell_errors.items():
            path = cs.directory / name
            key = cs.info.key_for(path)
            try:
                header = self._header_reader(path, key)
            except Exception as e:  # noqa: BLE001 — per-cell isolation
                errors[name] = str(e)
                if str(e) != previous:
                    log.warning("header read still failing for %s: %s", name, e)
                continue
            cells.append(_cell_info(path, key, header))
            recovered.append(name)
        if not recovered:
            cs.cell_errors = errors
            return
        cs.cells = sorted(cells, key=lambda c: c.path)  # cell_files' order
        cs.cell_errors = errors
        log.info(
            "chart set %s: %d cell(s) recovered on rescan (%s); %d still failing",
            cs.id,
            len(recovered),
            ", ".join(recovered),
            len(errors),
        )

    def _load_set(self, set_id: str, directory: Path, seq: int) -> OchartsSet:
        info = parse_set_info(directory)
        cs = OchartsSet(id=set_id, directory=directory, sequence=seq, info=info)
        for path in cell_files(directory):
            key = info.key_for(path)
            try:
                header = self._header_reader(path, key)
            except Exception as e:  # noqa: BLE001 — per-cell isolation
                log.warning("header read failed for %s: %s", path.name, e)
                cs.cell_errors[path.name] = str(e)
                continue
            cs.cells.append(_cell_info(path, key, header))
        log.info(
            "chart set %s: %d cells identified, %d failed",
            set_id,
            len(cs.cells),
            len(cs.cell_errors),
        )
        return cs
