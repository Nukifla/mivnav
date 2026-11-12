# SPDX-License-Identifier: GPL-2.0-only
"""Flat on-disk PNG cache for rendered weather tiles. See
docs/architecture/weather-range-cache.md's `PngTileCache` section for why
this doesn't share `WeatherProxy`'s `_evict` shape.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path


def cache_key(kind: str, om_path: str, variable: str, dark: bool, z: int, x: int, y: int) -> str:
    """The tile's cache identity — see module docstring. `kind` distinguishes
    the wash/wind pyramids (and any future one) sharing one cache dir."""
    raw = f"{kind}|{om_path}|{variable}|{dark}|{z}|{x}|{y}"
    return hashlib.sha256(raw.encode()).hexdigest()


class PngTileCache:
    """A flat on-disk PNG cache under `cache_dir`, bounded by `budget_bytes`."""

    def __init__(self, cache_dir: Path, budget_bytes: int) -> None:
        self._dir = Path(cache_dir)
        self._budget = budget_bytes

    def _path(self, key: str) -> Path:
        return self._dir / key[:2] / f"{key}.png"

    def get(self, key: str) -> bytes | None:
        path = self._path(key)
        try:
            data = path.read_bytes()
        except OSError:
            return None
        try:
            os.utime(path, None)  # touch for LRU
        except OSError:
            pass
        return data

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self._evict()

    def _evict(self) -> None:
        """Drop whole cached files, oldest-mtime-first, until under budget.
        A tiny sibling of `WeatherProxy._evict`, for a flat single-file
        cache instead of a per-key directory of chunks."""
        try:
            entries = []
            total = 0
            for sub in os.scandir(self._dir):
                if not sub.is_dir():
                    continue
                for f in os.scandir(sub.path):
                    if not f.is_file():
                        continue
                    st = f.stat()
                    total += st.st_size
                    entries.append((st.st_mtime, st.st_size, f.path))
        except OSError:
            return
        if total <= self._budget:
            return
        for _mtime, size, path in sorted(entries):  # oldest mtime first
            if total <= self._budget:
                break
            try:
                os.unlink(path)
            except OSError:
                continue
            total -= size
