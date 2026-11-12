# SPDX-License-Identifier: GPL-2.0-only
"""RAM-only caches for the on-demand o-charts path.

Port of ochartsng's ChartCache/TileCache design (provider/src/ChartCache.cpp,
TileCache.cpp): one generic byte-budgeted LRU with single-flight loading and
error memoization serves both the decoded-cell cache and the encoded-tile
cache. Nothing here ever touches the filesystem. See
docs/architecture/ocharts-single-flight-cache.md — in particular why a
``TimeoutError`` from ``get()`` is NEVER memoized (#lsyvyxww): it caused a
real 503-storm incident when it was.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable
from typing import Generic, TypeVar

V = TypeVar("V")

_WAIT_TIMEOUT = 30.0  # like the reference's waiter timeout, scaled for slow decodes


class _Entry(Generic[V]):
    __slots__ = ("event", "value", "size", "error")

    def __init__(self) -> None:
        self.event = threading.Event()
        self.value: V | None = None
        self.size = 0
        self.error: BaseException | None = None


class SingleFlightLRU(Generic[V]):
    """Byte-budgeted LRU with single-flight loads and error memoization."""

    def __init__(self, budget_bytes: int, wait_timeout: float = _WAIT_TIMEOUT) -> None:
        self.budget = budget_bytes
        # Per-instance so tests can shrink it (avoid a real ~30s sleep) and
        # cell/tile caches can use different budgets.
        self._wait_timeout = wait_timeout
        self._lock = threading.Lock()
        self._entries: OrderedDict[Hashable, _Entry[V]] = OrderedDict()
        # Kept in step incrementally so eviction/stats are O(1); invariant
        # and mirrored frontend counter documented in
        # docs/architecture/ocharts-single-flight-cache.md.
        self._bytes = 0
        # counters, for /ocharts/status and tests
        self.hits = 0
        self.loads = 0
        self.errors = 0
        self.evictions = 0
        # Distinct from `errors`: a timeout is never memoized, so a rising
        # count means contention/slow decodes, not broken cells.
        self.timeouts = 0

    def get(self, key: Hashable, loader: Callable[[], tuple[V, int]]) -> V:
        """Value for `key`, loading it at most once concurrently.

        `loader` returns ``(value, size_bytes)``. Raises the loader's
        exception (possibly memoized from an earlier attempt).
        """
        while True:
            with self._lock:
                entry = self._entries.get(key)
                if entry is not None and entry.event.is_set():
                    self._entries.move_to_end(key)
                    if entry.error is not None:
                        raise entry.error
                    self.hits += 1
                    # `event.is_set()` is the loaded signal, NOT a non-None
                    # check: a loaded entry may legitimately hold None (an
                    # empty o-charts tile — OchartsService._tile).
                    return entry.value
                if entry is None:
                    entry = _Entry()
                    self._entries[key] = entry
                    mine = True
                else:
                    mine = False
            if not mine:
                # someone else is loading; wait and re-check
                if not entry.event.wait(self._wait_timeout):
                    with self._lock:
                        self.timeouts += 1
                    raise TimeoutError(f"timed out waiting for cache load of {key!r}")
                continue
            try:
                value, size = loader()
            except TimeoutError:
                # Not a fact about `key` — un-claim the entry for a clean
                # retry instead of memoizing (see module docstring, #lsyvyxww).
                with self._lock:
                    if self._entries.get(key) is entry:
                        del self._entries[key]
                    self.timeouts += 1
                    entry.event.set()  # release any co-waiters on `key` too
                raise
            except BaseException as e:
                with self._lock:
                    entry.error = e
                    self.errors += 1
                    entry.event.set()
                raise
            with self._lock:
                entry.value = value
                self._set_size_locked(entry, max(size, 1))
                entry.event.set()
                self.loads += 1
                self._evict_locked(keep=key)
            return value

    def _set_size_locked(self, entry: _Entry[V], size: int) -> None:
        """Assign ``entry.size`` and keep ``_bytes`` in step (caller holds
        lock). Charges the delta (old size may be nonzero on overwrite),
        keeping the invariant intact even though ``get`` today only ever
        resolves a fresh size-0 entry.
        """
        self._bytes += size - entry.size
        entry.size = size

    def _evict_locked(self, keep: Hashable) -> None:
        if self._bytes <= self.budget:
            return
        for k in list(self._entries):
            if self._bytes <= self.budget:
                break
            e = self._entries[k]
            if k == keep or not e.event.is_set():
                continue  # never evict the entry just inserted or in-flight loads
            self._bytes -= e.size
            del self._entries[k]
            self.evictions += 1

    def touch(self, key: Hashable) -> bool:
        """Is `key` already resolved? If so, make it most-recently-used.

        The "do I need to load this at all" question asked without loading
        it — `get` cannot answer that without loading. Used by the
        background warmer (:mod:`.warm`) to skip and bump already-cached
        cells for free. Not a hit — hits count requests served.
        """
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or not entry.event.is_set():
                return False
            self._entries.move_to_end(key)
            return True

    def peek_error(self, key: Hashable) -> BaseException | None:
        """The memoized error for `key`, or ``None`` if it isn't one (no
        entry, still in flight, or resolved successfully). No side effect
        (unlike `touch`) — lets a caller check "is this key known-broken"
        before it, e.g. so one bad cell doesn't abort a whole multi-cell
        tile. See docs/architecture/ocharts-single-flight-cache.md.
        """
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or not entry.event.is_set():
                return None
            return entry.error

    def clear_errors(self) -> None:
        """Forget memoized failures (e.g. after a daemon restart)."""
        with self._lock:
            for k in [k for k, e in self._entries.items() if e.error is not None]:
                self._bytes -= self._entries[k].size  # error entries are size 0
                del self._entries[k]

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0

    def stats(self) -> dict:
        with self._lock:
            done = [e for e in self._entries.values() if e.event.is_set()]
            return {
                "entries": len(done),
                "bytes": self._bytes,
                "budget": self.budget,
                "hits": self.hits,
                "loads": self.loads,
                "errors": self.errors,
                "evictions": self.evictions,
                "timeouts": self.timeouts,
            }
