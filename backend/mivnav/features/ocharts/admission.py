# SPDX-License-Identifier: GPL-2.0-only
"""Memory admission for tile renders (#MEM-GATE).

Why this exists — the 2026-09-27 boat incident: the backend sat at a flat
~0.67 GB RSS for two days, then two tablets and a phone opened the chart
and zoomed out over the DE/NL/DK union, and within minutes it was OOM-killed
at 5.9 GB. A cold low-zoom ``/tiles/all`` tile is not a small thing: its
selection can keep 128 cells, and over the Dutch set (large FNC cells, no
overview) those are ~700 MB on disk. Measured on the real sets (dev box,
one tile, nothing cached): z5/16/10 peaks at 2.1 GB RSS, z4/8/5 at 2.1 GB,
z6/33/20 at 0.69 GB — peak ≈ 3x the on-disk size of the cells the tile
loads, because the render holds every decoded cell, every per-cell cut and
the merge at once. Nothing bounded how many of those ran together: the sync
route runs on AnyIO's 40-thread pool, MapLibre fires a whole viewport of
tiles at once from each client, and an aborted (panned-away) request keeps
rendering. Four such tiles concurrently measured 4.0 GB, eight 4.5 GB.

So: every cold render asks this gate for its estimated peak before it loads
a single cell (``chartcore.serve_tile[_union]``'s ``admit`` hook, called
right after selection with exactly the cells it is about to load), and
waits until the in-flight total fits the budget. Weight is the tile's
cells' on-disk bytes x :data:`PEAK_PER_FILE_BYTE` — known without decoding
anything, and the measured best predictor of the peak (cell *count* is
not: 128 tiny Danish harbour cells cost 28 MB, 128 Dutch cells 700 MB).

- **One oversized render always runs**, alone: a weight above the budget is
  clamped to it, so a tile the budget can never fit still renders — just
  not alongside anything.
- **FIFO**: strict arrival order, so a heavy tile cannot be starved by a
  steady stream of light ones slipping past it. The cost is head-of-line
  blocking behind a heavy render, which is the point.
- **Bounded wait**: past ``timeout`` the waiter raises ``TimeoutError``,
  which the tile cache never memoizes (see ``cache.py``) and the route maps
  to a retryable 503 — rather than parking an AnyIO worker indefinitely.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import logging
import threading
import time
from collections import deque

log = logging.getLogger(__name__)

#: Measured peak RSS per byte of on-disk cell loaded by one render (DE/NL/DK
#: union; 2.1 GB for 709 MB and 705 MB of cells, 0.69 GB for 183 MB).
PEAK_PER_FILE_BYTE = 3

#: Default budget for concurrently rendering tiles, in estimated peak bytes.
#: Sized for the boat's 8 GB Pi: one worst-case low-zoom tile (~2.1 GB) runs
#: alone, while ordinary tiles (single-digit MB of cells) run by the hundred.
DEFAULT_RENDER_BUDGET = 1536 * 1024 * 1024

DEFAULT_ADMIT_TIMEOUT = 60.0

#: A render at least this heavy returns its heap to the OS afterwards (see
#: :func:`trim_heap`).
TRIM_AFTER_BYTES = 256 * 1024 * 1024


class RenderGate:
    """Weighted FIFO semaphore over estimated render peak bytes."""

    def __init__(self, capacity: int, timeout: float = DEFAULT_ADMIT_TIMEOUT) -> None:
        self.capacity = max(1, capacity)
        self.timeout = timeout
        self._cond = threading.Condition()
        self._in_use = 0
        self._queue: deque[object] = deque()
        # counters, for /ocharts/status and tests
        self.admitted = 0
        self.waited = 0
        self.timeouts = 0
        self.peak_in_use = 0

    def acquire(self, weight: int) -> int:
        """Block until `weight` fits, and charge it. Returns the charge
        actually taken (clamped to capacity) — pass THAT to :meth:`release`.
        Raises ``TimeoutError`` after ``self.timeout`` seconds of waiting."""
        w = min(max(0, weight), self.capacity)
        ticket = object()
        with self._cond:
            self._queue.append(ticket)
            deadline = None
            try:
                while not (self._queue[0] is ticket and self._in_use + w <= self.capacity):
                    if deadline is None:
                        deadline = time.monotonic() + self.timeout
                        self.waited += 1
                    left = deadline - time.monotonic()
                    if left <= 0:
                        self.timeouts += 1
                        raise TimeoutError(
                            f"render admission: waited {self.timeout:.0f}s for "
                            f"{w >> 20} MB of a {self.capacity >> 20} MB budget "
                            f"({self._in_use >> 20} MB in flight)"
                        )
                    self._cond.wait(left)
            finally:
                self._queue.remove(ticket)
                # The head may have changed (we were it, or we left the line):
                # whoever is next must re-check.
                self._cond.notify_all()
            self._in_use += w
            self.admitted += 1
            self.peak_in_use = max(self.peak_in_use, self._in_use)
            return w

    def release(self, charge: int) -> None:
        with self._cond:
            self._in_use -= charge
            self._cond.notify_all()

    def stats(self) -> dict:
        with self._cond:
            return {
                "capacity": self.capacity,
                "in_use": self._in_use,
                "queued": len(self._queue),
                "peak_in_use": self.peak_in_use,
                "admitted": self.admitted,
                "waited": self.waited,
                "timeouts": self.timeouts,
            }


class Admission:
    """One render attempt's handle on the gate: the ``admit`` callable handed
    to chartcore, plus the ``release`` its caller runs in ``finally``.

    chartcore calls ``admit`` at most once per serve call; the caller owns
    release so no exit path (a cell failing to load, a cut error, a
    timeout) can leak a charge.
    """

    __slots__ = ("_gate", "_weigh", "charge")

    def __init__(self, gate: RenderGate, weigh) -> None:
        self._gate = gate
        self._weigh = weigh
        self.charge = 0

    def __call__(self, indices: list[int]) -> None:
        self.charge = self._gate.acquire(self._weigh(indices))

    def release(self) -> int:
        charge, self.charge = self.charge, 0
        if charge:
            self._gate.release(charge)
        return charge


def _load_malloc_trim():
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        fn = libc.malloc_trim
    except (OSError, AttributeError):  # not glibc (musl, macOS): nothing to trim
        return None
    fn.argtypes = [ctypes.c_size_t]
    fn.restype = ctypes.c_int
    return fn


_malloc_trim = _load_malloc_trim()


def trim_heap() -> None:
    """Hand freed heap back to the OS (glibc ``malloc_trim(0)``).

    A heavy render's transient (cuts + merge, ~2 GB at worst) is freed when
    it ends, but glibc keeps it: freed chunks below an arena's top, and the
    per-thread arenas the AnyIO/rayon workers each allocate from, are never
    returned on their own. Measured: after the render, and after even
    dropping every cache, RSS stayed at 1.3 GB (one tile) / 2.4 GB (eight
    concurrent) until ``malloc_trim(0)`` took it to ~50-100 MB. So without
    this, RSS ratchets to the high-water mark of the worst concurrent burst
    and stays there — memory the next burst (or anything else on the Pi)
    cannot have. ``MALLOC_ARENA_MAX=2`` was measured as the alternative: it
    cut the peak but made the same renders 2.7x slower (arena lock
    contention), so trimming after heavy renders is the cheaper fix.
    """
    if _malloc_trim is not None:
        _malloc_trim(0)
