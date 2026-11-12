# SPDX-License-Identifier: GPL-2.0-only
"""SingleFlightLRU: single-flight, byte LRU, error memoization."""

import threading

import pytest

from mivnav.features.ocharts.cache import SingleFlightLRU

_SHORT_WAIT = 0.05  # a real waiter timeout would be ~30s; shrink it so races are fast


def test_single_flight_one_load_for_concurrent_gets() -> None:
    cache: SingleFlightLRU = SingleFlightLRU(budget_bytes=1 << 20)
    loads = []
    gate = threading.Event()

    def loader():
        loads.append(1)
        gate.wait(5)
        return "value", 10

    results = []
    threads = [
        threading.Thread(target=lambda: results.append(cache.get("k", loader)))
        for _ in range(8)
    ]
    for t in threads:
        t.start()
    gate.set()
    for t in threads:
        t.join(10)
    assert results == ["value"] * 8
    assert len(loads) == 1


def test_none_is_a_valid_cached_value_served_on_re_hit() -> None:
    # An empty o-charts tile loads as None (no features → no bytes; see
    # OchartsService._tile). `event.is_set()` is what marks an entry loaded, so a
    # cached None is a real result — a re-request must return it from the cache,
    # not crash. Regression: the hit path asserted the value was non-None, so the
    # SECOND request for any empty tile raised AssertionError (HTTP 500).
    cache: SingleFlightLRU = SingleFlightLRU(budget_bytes=1 << 20)
    loads = []

    def loader():
        loads.append(1)
        return None, 1

    assert cache.get("empty", loader) is None
    assert cache.get("empty", loader) is None  # cache hit — used to AssertionError
    assert len(loads) == 1  # loaded once, the re-hit came from the cache


def test_lru_eviction_under_byte_budget() -> None:
    cache: SingleFlightLRU = SingleFlightLRU(budget_bytes=100)
    for i in range(5):
        cache.get(i, lambda i=i: (f"v{i}", 40))  # 5 * 40 > 100
    stats = cache.stats()
    assert stats["bytes"] <= 100
    assert stats["evictions"] >= 3
    # most recent entries survive
    hits_before = cache.stats()["hits"]
    assert cache.get(4, lambda: ("reloaded", 40)) == "v4"
    assert cache.stats()["hits"] == hits_before + 1


def _true_sum(cache: SingleFlightLRU) -> int:
    """The O(n) re-sum the running counter replaced: ground truth for `_bytes`."""
    with cache._lock:
        return sum(e.size for e in cache._entries.values())


def test_byte_counter_matches_true_sum_through_churn() -> None:
    """The O(1) running counter must never drift from the actual sum of entry
    sizes — checked after every insert-with-eviction, and against the O(n)
    re-sum it replaced. Fails if a mutation forgets to update `_bytes`."""
    cache: SingleFlightLRU = SingleFlightLRU(budget_bytes=200)
    sizes = [30, 50, 20, 70, 40, 60, 10, 90, 25, 15, 80, 5]
    for i, s in enumerate(sizes):
        cache.get(i, lambda i=i, s=s: (f"v{i}", s))
        assert cache._bytes == _true_sum(cache)
        assert cache.stats()["bytes"] == _true_sum(cache)
        assert cache._bytes <= cache.budget  # keep entry <= budget here


def test_byte_counter_handles_overwrite_of_size() -> None:
    """Overwriting an entry's size must subtract the old and add the new, or the
    counter drifts. (`get` never overwrites today, so this guards the helper.)"""
    cache: SingleFlightLRU = SingleFlightLRU(budget_bytes=10_000)
    cache.get("k", lambda: ("v", 100))
    assert cache._bytes == 100 == _true_sum(cache)
    entry = cache._entries["k"]
    with cache._lock:
        cache._set_size_locked(entry, 250)  # grow
    assert cache._bytes == 250 == _true_sum(cache)
    with cache._lock:
        cache._set_size_locked(entry, 30)  # shrink
    assert cache._bytes == 30 == _true_sum(cache)


def test_byte_counter_reset_on_clear_and_errors() -> None:
    cache: SingleFlightLRU = SingleFlightLRU(budget_bytes=10_000)
    for i in range(4):
        cache.get(i, lambda i=i: (f"v{i}", 100))
    assert cache._bytes == 400 == _true_sum(cache)
    cache.clear()
    assert cache._bytes == 0 == _true_sum(cache)
    # error entries are size 0, so clearing them leaves the counter untouched
    with pytest.raises(ValueError):
        cache.get("bad", lambda: (_ for _ in ()).throw(ValueError()))
    assert cache._bytes == 0 == _true_sum(cache)
    cache.clear_errors()
    assert cache._bytes == 0 == _true_sum(cache)


def test_error_memoized_and_clearable() -> None:
    cache: SingleFlightLRU = SingleFlightLRU(budget_bytes=100)
    calls = []

    def failing():
        calls.append(1)
        raise ValueError("broken cell")

    with pytest.raises(ValueError):
        cache.get("bad", failing)
    with pytest.raises(ValueError):
        cache.get("bad", failing)
    assert len(calls) == 1  # second raise was memoized
    cache.clear_errors()
    with pytest.raises(ValueError):
        cache.get("bad", failing)
    assert len(calls) == 2


def test_waiter_timeout_is_not_memoized() -> None:
    """A waiter that gives up on someone else's still-in-flight load must not
    poison the key: the load it raced may still succeed. Regression for the
    naive fix (memoize the TimeoutError like any other exception), which
    would make a key permanently unusable just because one caller happened
    to time out watching it."""
    cache: SingleFlightLRU = SingleFlightLRU(budget_bytes=100, wait_timeout=_SHORT_WAIT)
    stuck = threading.Event()
    started = threading.Event()

    def stuck_loader():
        started.set()
        stuck.wait(5)
        return "value", 10

    t = threading.Thread(target=lambda: cache.get("k", stuck_loader))
    t.start()
    assert started.wait(2)

    with pytest.raises(TimeoutError):
        cache.get("k", lambda: (_ for _ in ()).throw(AssertionError("should not load")))
    assert cache.stats()["timeouts"] == 1
    assert cache.stats()["errors"] == 0  # NOT memoized as a real error

    stuck.set()
    t.join(5)

    # now that the original load has actually resolved, a fresh get() must
    # see the real (successful) outcome, not a fossilized timeout
    assert cache.get("k", lambda: ("reloaded", 10)) == "value"


def test_timeout_from_a_nested_cache_does_not_poison_the_outer_key() -> None:
    """Reproduces the real-device incident (lsyvyxww): `OchartsService`
    nests a `cells` SingleFlightLRU load inside a `tiles` one
    (`_cut_tile_all` calls `load_cell`, which waits on the cell cache). A
    stuck cell decode made unrelated `/tiles/all` requests for OTHER
    zoom/tile keys and OTHER chart sets time out waiting for that one cell
    -- and, before this fix, the tile cache's generic
    `except BaseException` memoized that TimeoutError as if the TILE were
    broken, so every tile that raced the stuck cell stayed 503ing forever,
    even long after the cell finished loading.
    """
    cells: SingleFlightLRU = SingleFlightLRU(budget_bytes=1 << 20, wait_timeout=_SHORT_WAIT)
    tiles: SingleFlightLRU = SingleFlightLRU(budget_bytes=1 << 20, wait_timeout=5.0)
    stuck = threading.Event()
    started = threading.Event()

    def stuck_cell_loader():
        started.set()
        stuck.wait(5)
        return "cell-data", 10

    t = threading.Thread(target=lambda: cells.get("cell-A", stuck_cell_loader))
    t.start()
    assert started.wait(2)

    def tile_loader():
        # "tile T" composites cell-A among others -- exactly what
        # OchartsService._cut_tile_all's `load_cell` callback does.
        cells.get("cell-A", stuck_cell_loader)
        return "tile-data", 10

    with pytest.raises(TimeoutError):
        tiles.get("tile-T", tile_loader)

    stuck.set()
    t.join(5)
    assert cells.get("cell-A", stuck_cell_loader) == "cell-data"  # the cell is fine now

    # THE BUG: tile-T must not still be poisoned by a race that resolved
    # itself -- a fresh request for it should get a clean retry.
    assert tiles.get("tile-T", lambda: ("tile-data", 10)) == "tile-data"
