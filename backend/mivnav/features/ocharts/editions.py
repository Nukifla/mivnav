# SPDX-License-Identifier: GPL-2.0-only
"""Which installed set is which shop chart, and which edition is newer.

Ported from ochartsng: the chart code out of the directory name is
``ChartSetInfo::ParseChartInfo`` (provider/src/ChartSetInfo.cpp), the
edition ordering is ``NameAndVersion::IsBetter`` (provider/src/ChartManager.cpp).
See docs/architecture/ocharts-updates.md.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from .keys import parse_set_info

log = logging.getLogger(__name__)

#: Directory prefixes the shop ships sets under (`oeuSENC-DK-2026-1-31-base`).
SET_PREFIXES = ("oeuSENC", "oeuRNC")

#: (year, edition, update)
Edition = tuple[int, int, int]


def chart_code(set_id: str) -> str | None:
    """The shop's ``chartId`` for an installed set directory (``DK`` for
    ``oeuSENC-DK-2026-1-31-base``), or None for a set the shop did not name
    — an FNC set, a hand-made directory."""
    parts = set_id.split("-")
    if len(parts) < 2 or not parts[1]:
        return None
    if not any(set_id.startswith(prefix) for prefix in SET_PREFIXES):
        return None
    return parts[1]


def set_family(set_id: str) -> tuple[str, str] | None:
    """What successive editions of one chart share: ``(prefix, code)``. The
    prefix is part of it, unlike in the reference, so a raster ``oeuRNC-DK``
    is never taken for an older edition of the vector ``oeuSENC-DK``."""
    code = chart_code(set_id)
    if code is None:
        return None
    return (set_id.split("-")[0], code)


def parse_edition(text: str) -> Edition | None:
    """``2026/1-31`` (or the legacy ``2021/01-21``) as a sortable tuple."""
    parts = text.strip().replace("/", "-").split("-")
    if len(parts) != 3:
        return None
    try:
        year, edition, update = (int(p) for p in parts)
    except ValueError:
        return None
    return (year, edition, update)


def is_newer(candidate: str, installed: str) -> bool:
    """Whether ``candidate`` supersedes ``installed``. An unreadable candidate
    never does; a readable one beats an unreadable installed edition — the
    reference's "valid beats invalid"."""
    new = parse_edition(candidate)
    if new is None:
        return False
    old = parse_edition(installed)
    return old is None or new > old


def retire_superseded(sets_dir: Path, target: Path) -> list[str]:
    """Delete the older editions of the chart just installed at ``target``.

    Shop updates arrive under a new directory name, so without this every
    update leaves the previous edition installed beside it — every cell
    doubled over the same water, both editions bidding for the per-tile cell
    budget. Called only after the new set has passed its header scan, so a
    failed update never costs the boat its working charts; and it only ever
    removes a set the new one is at least as new as, so installing an *older*
    zip by hand removes nothing.
    """
    family = set_family(target.name)
    edition = parse_edition(parse_set_info(target).edition)
    if family is None or edition is None or not sets_dir.is_dir():
        return []
    removed = []
    for other in sorted(sets_dir.iterdir()):
        if other == target or not other.is_dir() or set_family(other.name) != family:
            continue
        old = parse_edition(parse_set_info(other).edition)
        if old is not None and old > edition:
            continue
        try:
            shutil.rmtree(other)
        except OSError as e:
            # Not fatal — the new set is installed and serving — but the
            # duplicate coverage will not fix itself.
            log.error(
                "could not retire superseded chart set %s: %s; "
                "delete it via DELETE /ocharts/sets/{id}",
                other.name,
                e,
            )
            continue
        removed.append(other.name)
    if removed:
        log.info("%s supersedes %s — removed", target.name, ", ".join(removed))
    return removed
