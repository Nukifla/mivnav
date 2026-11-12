# SPDX-License-Identifier: GPL-2.0-only
"""Process singletons that are *derived from* config, and rebuild when it
changes. See docs/architecture/config-derived-singletons.md for why this
exists (the ``@lru_cache``-built-once bug it replaces) and the locking
rationale.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Generic, TypeVar

from .model import Config

log = logging.getLogger(__name__)

S = TypeVar("S")  # the config slice this object is built from
T = TypeVar("T")  # the built object

_MISSING = object()


class Derived(Generic[S, T]):
    """One config-derived singleton.

    Not a cache of many values: exactly one live object, replaced when its
    slice changes.
    """

    def __init__(
        self,
        name: str,
        select: Callable[[Config], S],
        build: Callable[[S], T],
        close: Callable[[T], None] | None = None,
    ) -> None:
        self.name = name
        self._select = select
        self._build = build
        self._close = close
        self._lock = threading.Lock()
        self._slice: object = _MISSING
        self._value: T | None = None

    def get(self, config: Config) -> T:
        """The object for this config, building or rebuilding as needed.

        The build runs under the lock so concurrent callers of a cold
        Derived block rather than racing (see module docstring)."""
        wanted = self._select(config)
        with self._lock:
            if self._slice is not _MISSING and self._slice == wanted and self._value is not None:
                return self._value
            stale = self._value
            rebuilt = self._slice is not _MISSING
            value = self._build(wanted)
            self._slice = wanted
            self._value = value
        if rebuilt:
            log.info("%s rebuilt: its configuration changed", self.name)
        # Dispose outside the lock: closing can block (stopping a
        # subprocess), and a slow teardown must not stall readers of the
        # already-published new object.
        if stale is not None and self._close is not None:
            try:
                self._close(stale)
            except Exception:  # noqa: BLE001 — disposal must never fail a request
                log.exception("disposing the superseded %s failed", self.name)
        return value

    def dispose(self) -> None:
        """Drop and close the live object (process shutdown)."""
        with self._lock:
            stale, self._value, self._slice = self._value, None, _MISSING
        if stale is not None and self._close is not None:
            try:
                self._close(stale)
            except Exception:  # noqa: BLE001
                log.exception("disposing %s failed", self.name)
