# SPDX-License-Identifier: GPL-2.0-only
"""On-disk dataset layout: the small generic ``dataset.json`` every dataset
folder carries, and the mover that relocates a pre-existing flat provider
directory into the M-DATA-3 shape (``data_root/<provider>/<dataset_id>/``).
Idempotent, not one-time: it re-runs on every load that still finds an old
per-provider dir key, safe because a target that already exists is always
left alone. See docs/architecture/dataset-layout-migration.md.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from mivnav.config.base import dataset_dir, provider_root

if TYPE_CHECKING:
    from mivnav.search import SearchIndex

log = logging.getLogger(__name__)

DATASET_JSON = "dataset.json"


def write_dataset_json(directory: Path, *, dataset_id: str, provider: str, name: str) -> None:
    """Write ``directory/dataset.json`` atomically (temp file + ``os.replace``
    in the same dir). Small and generic on purpose — ``{id, provider, name,
    updated_at}`` — additional to, never replacing, whatever richer
    provider-specific sidecar (POI/satellite's own ``<id>.json``, see
    :mod:`mivnav.features.poi.sidecar`) already lives beside it."""
    meta = {
        "id": dataset_id,
        "provider": provider,
        "name": name,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    path = directory / DATASET_JSON
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(meta), encoding="utf-8")
    os.replace(tmp, path)


def dataset_disk_stats(directory: Path) -> tuple[int, str | None]:
    """``(total bytes, last-bake timestamp)`` for one dataset's own directory,
    walked LIVE off disk — the generic, provider-agnostic status facts
    ``GET /datasets`` reports (``size``/``last_bake_at``). Deliberately NOT
    sourced from :func:`read_dataset_json` — see
    docs/architecture/dataset-layout-migration.md. Returns ``(0, None)`` for
    a dataset that has never baked.
    """
    if not directory.is_dir():
        return 0, None
    total = 0
    newest: float | None = None
    for path in directory.rglob("*"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        # Allocated, not apparent, size: a weather bake writes SPARSE `.om`
        # files (only the drawable variables, holes elsewhere).
        total += min(stat.st_size, getattr(stat, "st_blocks", stat.st_size) * 512)
        if newest is None or stat.st_mtime > newest:
            newest = stat.st_mtime
    if newest is None:
        return total, None
    return total, datetime.fromtimestamp(newest, tz=timezone.utc).isoformat()


def search_index_share(index: SearchIndex, source: str, region: str) -> int:
    """This dataset's proportional share of the SHARED search index's
    on-disk bytes: ROW SHARE (``db_bytes * own_rows / total_rows``), not
    "whole db to every dataset that touched it" — see
    docs/architecture/dataset-layout-migration.md.
    """
    total_rows = index.record_count()
    if total_rows == 0:
        return 0
    own_rows = index.record_count(source=source, region=region)
    if own_rows == 0:
        return 0
    db_bytes = _file_size_if_present(index.path)
    # WAL mode: recent writes may still live in -wal, not yet checkpointed
    # into the main db file; -shm is sqlite's index over it. Both count.
    db_bytes += _file_size_if_present(index.path.with_name(index.path.name + "-wal"))
    db_bytes += _file_size_if_present(index.path.with_name(index.path.name + "-shm"))
    return round(db_bytes * own_rows / total_rows)


def _file_size_if_present(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def read_dataset_json(directory: Path) -> dict | None:
    """Parse ``directory/dataset.json``, or ``None`` when absent/malformed
    (never raises)."""
    path = directory / DATASET_JSON
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        log.warning("ignoring malformed %s", path)
        return None
    return data if isinstance(data, dict) else None


def migrate_legacy_dataset_dirs(legacy_dirs: dict[str, Path], data_root: Path) -> None:
    """Relocate each ``legacy_dirs`` entry (provider -> its OLD, pre-M-DATA-3
    directory) into ``data_root/<provider>``, in place, doing nothing for a
    provider whose old dir already IS the new one. See
    docs/architecture/dataset-layout-migration.md for the per-provider shape
    and the common-case no-op.
    """
    for provider, old_root in legacy_dirs.items():
        new_root = provider_root(data_root, provider)
        try:
            if old_root.resolve() == new_root.resolve():
                continue  # already at the canonical location
        except OSError:
            pass  # one side doesn't exist yet — fall through, nothing to skip
        if provider == "ocharts":
            _migrate_ocharts_sets_dir(old_root, new_root)
        else:
            _migrate_flat_provider_dir(old_root, data_root, provider)


def _migrate_flat_provider_dir(old_root: Path, data_root: Path, provider: str) -> None:
    """Move every flat ``<id>.pmtiles`` (and its ``<id>.json`` sidecar, if
    any) directly under ``old_root`` into its own
    ``data_root/<provider>/<id>/`` folder. A ``<id>.pmtiles`` already nested
    one level deep (a previous partial run's output, or a fresh bake already
    written there) is untouched — only FLAT files at ``old_root``'s own top
    level are legacy-shaped by construction.
    """
    if not old_root.is_dir():
        return
    for pmtiles in sorted(old_root.glob("*.pmtiles")):
        dataset_id = pmtiles.stem
        target_dir = dataset_dir(data_root, provider, dataset_id)
        target_pmtiles = target_dir / f"{dataset_id}.pmtiles"
        if target_pmtiles.exists():
            log.warning(
                "not migrating %s dataset %r: %s already exists — leaving "
                "the old flat file at %s in place",
                provider, dataset_id, target_pmtiles, pmtiles,
            )
            continue
        target_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(pmtiles), str(target_pmtiles))
        sidecar = old_root / f"{dataset_id}.json"
        if sidecar.is_file():
            shutil.move(str(sidecar), str(target_dir / f"{dataset_id}.json"))
        write_dataset_json(target_dir, dataset_id=dataset_id, provider=provider, name=dataset_id)
        log.info("migrated %s dataset %r: %s -> %s", provider, dataset_id, pmtiles, target_dir)


def _migrate_ocharts_sets_dir(old_root: Path, new_root: Path) -> None:
    """Relocate the whole o-charts sets directory — already one folder per
    installed chart set — to ``data_root/ocharts``. Moved wholesale when the
    new root does not exist yet (the common case); merged set-by-set,
    skipping any name collision, when it already does (e.g. a previous
    partial run, or the service itself created an empty directory first)."""
    if not old_root.is_dir():
        return
    if not new_root.exists():
        new_root.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(old_root), str(new_root))
        log.info("migrated o-charts sets dir %s -> %s", old_root, new_root)
        return
    for chart_set in sorted(p for p in old_root.iterdir() if p.is_dir()):
        target = new_root / chart_set.name
        if target.exists():
            log.warning(
                "not migrating o-charts set %s: %s already exists", chart_set, target
            )
            continue
        shutil.move(str(chart_set), str(target))
        log.info("migrated o-charts set %s -> %s", chart_set.name, target)
