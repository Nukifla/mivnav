# SPDX-License-Identifier: GPL-2.0-only
"""One id-keyed registry of on-disk resources, rescanned on demand.

See docs/architecture/rescan-registry.md for the change-token/rate-limit
design and the two on-disk layouts ``pmtiles_candidates`` tolerates.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Collection, Iterable
from pathlib import Path
from typing import Generic, TypeVar

T = TypeVar("T")

# How stale the registry may be before the next lookup re-stats the directory.
DEFAULT_RESCAN_INTERVAL = 5.0


class RescanRegistry(Generic[T]):
    """Thread-safe: request handlers share one registry, scans serialized by
    a lock. Objects dropped from the registry are NOT torn down here — another
    thread may still hold one it fetched pre-rescan; cleanup is its own
    finalizer's job. See docs/architecture/rescan-registry.md for the
    ``excluded`` scan-time-filter design."""

    def __init__(
        self,
        rescan_interval: float | None = None,
        *,
        excluded: Callable[[], Collection[str]] | None = None,
    ) -> None:
        self._lock = threading.Lock()
        # id -> (change_token, object)
        self._known: dict[str, tuple[object, T]] = {}
        self.rescan_interval = (
            DEFAULT_RESCAN_INTERVAL if rescan_interval is None else rescan_interval
        )
        self._scanned_at: float | None = None
        self._excluded = excluded

    def sets(self) -> dict[str, T]:
        with self._lock:
            now = time.monotonic()
            if (
                self._scanned_at is not None
                and now - self._scanned_at < self.rescan_interval
            ):
                return {sid: obj for sid, (_, obj) in self._known.items()}
            self._scanned_at = now
            return self._scan()

    def get(self, set_id: str) -> T | None:
        return self.sets().get(set_id)

    def invalidate(self) -> None:
        """Force a full rescan on next access (after install/delete)."""
        with self._lock:
            self._known.clear()
            self._scanned_at = None

    def _scan(self) -> dict[str, T]:
        excluded = self._excluded() if self._excluded is not None else ()
        found: dict[str, tuple[object, T]] = {}
        for set_id, token, build in self._list():
            if set_id in excluded:
                continue
            cached = self._known.get(set_id)
            if cached is not None and cached[0] == token:
                self._on_reuse(cached[1])
                found[set_id] = cached
                continue
            obj = build()
            if obj is not None:
                found[set_id] = (token, obj)
        self._known = found  # drop-if-gone: an id not relisted is simply absent
        return {sid: obj for sid, (_, obj) in found.items()}

    def _list(self) -> Iterable[tuple[str, object, Callable[[], T | None]]]:
        """Yield ``(id, change_token, build)`` for every resource present now.

        ``change_token`` decides reuse (unchanged token → the built object is
        kept as-is); ``build`` mints a fresh object, returning ``None`` to skip
        this id (e.g. a corrupt file)."""
        raise NotImplementedError

    def _on_reuse(self, obj: T) -> None:
        """Hook run when an unchanged object is reused (default: nothing)."""


def pmtiles_candidates(root: Path) -> list[Path]:
    """Every ``<id>.pmtiles`` under ``root``, in either shape a ``*Store``'s
    ``_list()`` tolerates (M-DATA-3) — flat (``root/<id>.pmtiles``) or
    nested one-folder-per-dataset (``root/<id>/<id>.pmtiles``). See
    docs/architecture/rescan-registry.md for why both shapes exist and which
    wins if an id appears in both."""
    if not root.is_dir():
        return []
    flat = {p.stem: p for p in root.glob("*.pmtiles")}
    nested = {
        d.name: (d / f"{d.name}.pmtiles")
        for d in root.iterdir()
        if d.is_dir() and (d / f"{d.name}.pmtiles").is_file()
    }
    return sorted({**flat, **nested}.values())
