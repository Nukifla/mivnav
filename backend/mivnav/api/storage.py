# SPDX-License-Identifier: GPL-2.0-only
"""``GET /storage`` — everything mivnav keeps on disk, grouped, plus how
full the disk under ``data_root`` is.

``GET /datasets`` only sizes DECLARED (and orphan poi/satellite) datasets,
so a Storage view built on it alone missed most of the disk: o-charts/FNC
chart sets nobody declared, the routing graphs (several GB each), the
track history, and every XDG cache. This walks each location mivnav writes
to exactly once:

- datasets — straight from ``list_datasets`` (so sizes match the dataset
  list, including live-cache occupancy and the search-index row share),
  grouped by the dataset's per-implementation label ("POI (OSM)" and a
  plugin source's label are separate rows, not one "POI");
- anything else under a dataset provider's directory that no dataset entry
  covers (an undeclared chart set, a stray archive) — into that provider's
  group, so nothing under ``data_root`` goes uncounted;
- the non-dataset directories under ``data_root`` (routing, track, other);
- caches and logs outside ``data_root`` — skipping a live cache a declared
  live-cache dataset already counts, and only the search index's
  UNATTRIBUTED remainder (the attributed share is in the datasets' sizes).
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import get_args

from fastapi import APIRouter, Depends

from mivnav.api.datasets import list_datasets
from mivnav.api.deps import Runtime, get_runtime
from mivnav.config.base import dataset_dir
from mivnav.config.dataset_layout import dataset_disk_stats, search_index_share
from mivnav.config.model import DatasetProvider, default_log_dir

log = logging.getLogger(__name__)

router = APIRouter(prefix="/storage")

__all__ = ["router"]

#: Non-dataset directories under ``data_root`` with a name worth showing.
_DATA_DIR_LABELS = {
    "routing": "Routing graphs",
    "track": "Track history",
}


def path_bytes(path: Path) -> int:
    """Allocated bytes of a file or a whole tree; 0 when it does not exist."""
    if path.is_dir():
        return dataset_disk_stats(path)[0]
    try:
        stat = path.stat()
    except OSError:
        return 0
    return min(stat.st_size, getattr(stat, "st_blocks", stat.st_size) * 512)


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


class _Groups:
    def __init__(self) -> None:
        self._groups: dict[str, dict] = {}

    def add(self, group_id: str, label: str, kind: str, name: str, size: int) -> None:
        group = self._groups.setdefault(
            group_id, {"id": group_id, "label": label, "kind": kind, "bytes": 0, "items": []}
        )
        group["bytes"] += size
        group["items"].append({"name": name, "bytes": size})

    def result(self) -> list[dict]:
        groups = list(self._groups.values())
        for group in groups:
            group["items"].sort(key=lambda item: -item["bytes"])
        return sorted(groups, key=lambda group: -group["bytes"])


def _dataset_label(catalog: dict[str, dict], provider: str, implementation: str | None) -> str:
    """Python twin of the frontend's ``datasetLabel`` (DatasetList.tsx)."""
    entry = catalog.get(provider)
    if entry is None:
        return provider
    key = implementation or entry["default_implementation"]
    return (key and entry["implementation_labels"].get(key)) or entry["label"]


def _item_name(path: Path) -> str:
    """A dot-``.tmp`` file is a build still writing, or one killed mid-write
    that never published — say so, since it can be GBs."""
    if path.name.startswith(".") and ".tmp" in path.name:
        return f"{path.name} (unfinished build)"
    return path.name


def _children(directory: Path) -> list[Path]:
    try:
        return sorted(directory.iterdir())
    except OSError:
        return []


def _data_root_groups(runtime: Runtime, groups: _Groups, listing: dict) -> None:
    config = runtime.config.get()
    data_root = config.data_root
    catalog = {p["id"]: p for p in listing["providers"]}
    covered: set[Path] = set()
    for ds in listing["datasets"]:
        label = _dataset_label(catalog, ds["provider"], ds["implementation"])
        groups.add(f"dataset:{label}", label, "dataset", ds["name"], ds["size"])
        covered.add(dataset_dir(data_root, ds["provider"], ds["id"]))

    dataset_providers = set(get_args(DatasetProvider))
    for child in _children(data_root):
        if child.name in dataset_providers:
            # Whatever no dataset entry already counted — an undeclared
            # o-charts/FNC set, a stray flat archive — under the provider's
            # plain label, so the whole provider directory is accounted for.
            label = catalog.get(child.name, {}).get("label", child.name)
            for item in _children(child):
                if item in covered:
                    continue
                groups.add(f"dataset:{label}", label, "dataset", item.name, path_bytes(item))
        elif child.name in _DATA_DIR_LABELS:
            label = _DATA_DIR_LABELS[child.name]
            items = _children(child)
            # routing keeps its graphs one level down (routing/mivnav/…).
            if len(items) == 1 and items[0].is_dir():
                items = _children(items[0])
            for item in items:
                groups.add(child.name, label, "data", _item_name(item), path_bytes(item))
        else:
            groups.add("other", "Other files", "data", child.name, path_bytes(child))


def _cache_groups(runtime: Runtime, groups: _Groups, listing: dict) -> None:
    config = runtime.config.get()
    live_counted = {
        ds["provider"] for ds in listing["datasets"] if ds["mode"] == "live-cache"
    }
    caches: list[tuple[str, Path]] = [
        ("Chart tile cache", config.ocharts.tile_disk_dir),
        ("o-charts decoder", config.ocharts.daemon_dir),
        ("Weather tile renders", config.weather.render_cache_dir),
        ("Logs", default_log_dir()),
    ]
    if "weather" not in live_counted:
        caches.append(("Weather download cache", config.weather.cache_dir))
    if "osm_world" not in live_counted:
        caches.append(("OSM world live cache", config.osm_world.live_cache_dir))
    for name, path in caches:
        if _is_within(path, config.data_root):
            continue  # already walked as part of data_root
        groups.add("cache", "Caches & logs", "cache", name, path_bytes(path))

    db_path = config.search.db_path
    if not _is_within(db_path, config.data_root):
        total = sum(
            path_bytes(p) for p in _children(db_path.parent) if p.name.startswith(db_path.name)
        )
        attributed = 0
        try:
            index = runtime.search_index()
            for ds in listing["datasets"]:
                attributed += search_index_share(index, source=ds["provider"], region=ds["id"])
        except Exception:  # noqa: BLE001 — an overcount here is a nicety, not fatal
            log.warning("could not attribute the search index", exc_info=True)
        groups.add("cache", "Caches & logs", "cache", "Search index", max(0, total - attributed))


@router.get("")
def get_storage(runtime: Runtime = Depends(get_runtime)) -> dict:
    """``{disk: {path, total, used, free}, groups: [...], total}`` — groups
    largest first, each ``{id, label, kind, bytes, items: [{name, bytes}]}``
    with ``kind`` one of ``"dataset"``, ``"data"``, ``"cache"``. ``disk`` is
    the filesystem holding ``data_root`` (``None`` if it can't be read)."""
    config = runtime.config.get()
    listing = list_datasets(runtime)
    groups = _Groups()
    _data_root_groups(runtime, groups, listing)
    _cache_groups(runtime, groups, listing)
    result = groups.result()

    disk = None
    probe = config.data_root
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(probe)
        disk = {"path": str(config.data_root), "total": usage.total, "used": usage.used, "free": usage.free}
    except OSError:
        log.warning("could not read disk usage for %s", probe, exc_info=True)
    return {"disk": disk, "groups": result, "total": sum(g["bytes"] for g in result)}
