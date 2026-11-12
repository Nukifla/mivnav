# SPDX-License-Identifier: GPL-2.0-only
"""The single-flight cold build of :class:`mivnav.config.derived.Derived`.

``get`` runs the build under a lock precisely so that a viewport-worth of
concurrent tile requests against a cold Derived collapses to ONE build — N
threads must not each start an ``oexserverd``. This pins that: many cold
callers released together see exactly one build and all receive the same
object.
"""

from __future__ import annotations

import threading
import time

from mivnav.config.derived import Derived
from mivnav.config.model import Config


def test_concurrent_cold_get_builds_once() -> None:
    build_count = 0
    count_lock = threading.Lock()

    def build(_slice: Config) -> object:
        nonlocal build_count
        with count_lock:
            build_count += 1
        # Widen the window a real build occupies, so a second caller that
        # failed to serialise would slip in and build too.
        time.sleep(0.05)
        return object()

    derived: Derived[Config, object] = Derived("test", lambda c: c, build)

    config = Config()
    n = 8
    barrier = threading.Barrier(n)
    results: list[object] = []
    results_lock = threading.Lock()

    def worker() -> None:
        barrier.wait()  # release all threads at once
        value = derived.get(config)
        with results_lock:
            results.append(value)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert build_count == 1
    assert len(results) == n
    # Every caller got the one built object — same identity.
    first = results[0]
    assert all(r is first for r in results)
