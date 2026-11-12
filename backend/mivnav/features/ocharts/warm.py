# SPDX-License-Identifier: GPL-2.0-only
"""Background warming of the overview cells: precomputes the small set of
coarse, shared cells so a viewport's decodes are already done when it asks,
without competing with a live request for the daemon. After the cell sweep
the same thread pre-renders ``/tiles/all`` into the disk tile cache, once per
disk version, yielding one render at a time behind a longer idle grace. See
docs/architecture/ocharts-warm.md for the measured decode-cost rationale.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from typing import TYPE_CHECKING


if TYPE_CHECKING:  # only the types cycle
    from .service import OchartsService
    from .sets import CellInfo, OchartsSet

log = logging.getLogger(__name__)

# The coarsest zoom worth warming for — see docs/architecture/ocharts-warm.md.
OVERVIEW_ZOOM = 10

# How far out of its native band a cell must reach to be worth *warming*.
# Deliberately TIGHTER than and decoupled from the serving reach
# (:data:`~.service.DEFAULT_OVER_ZOOM`) — see docs/architecture/ocharts-warm.md.
WARM_DETAIL_HEADROOM = 4

# No warm decode starts within this long of a tile request. Past the gap
# between one viewport's tiles or two pan frames, so an interacting user
# holds the warmer off continuously, but it resumes as soon as they stop.
IDLE_GRACE = 1.0

# Between sweeps. A sweep is `len(plan)` dict lookups, so this only bounds
# how soon a newly installed set gets warmed.
SWEEP_INTERVAL = 60.0

# Extra quiet before the *first* decode: identifying a national set on cold
# start is a header read per cell through the daemon (391, ~1.3s) before
# anything marks itself "in flight" — see docs/architecture/ocharts-warm.md.
STARTUP_GRACE = 5.0

# Pre-rendering starts at this zoom (nobody browses charts coarser than
# the whole of Denmark; the journal shows z3 requested once in 3 days).
PRETILE_MIN_ZOOM = 4

# Planning (and carrying tiles over to a new disk version) runs in Python, and
# planning once held the GIL for 63-85% of samples while requests stalled for
# 8-15 s (py-spy, 2026-10-31). So both work in slices and rest between them.
# Planning asks each cell only about the tiles in its own extent, so it is no
# longer tiles x cells (2 h 07 min on the Pi with 1,279 cells, 2026-11-01).
PLAN_SLICE_S = 0.01
PLAN_REST_S = 0.01

# Between sweeps the thread looks this often for a changed disk version (a
# chart install or update), so carry-over starts within seconds rather than
# after a whole SWEEP_INTERVAL of rendering into an empty directory.
VERSION_POLL_S = 5.0

# Quiet required before each pre-render — see "Pre-rendering tiles".
PRETILE_IDLE_GRACE = 10.0


class CellWarmer:
    """The service's background cell-warming thread. See the module docs."""

    def __init__(
        self,
        service: OchartsService,
        overview_zoom: int = OVERVIEW_ZOOM,
        idle_grace: float = IDLE_GRACE,
        sweep_interval: float = SWEEP_INTERVAL,
        startup_grace: float = STARTUP_GRACE,
    ) -> None:
        self._service = service
        self.overview_zoom = overview_zoom
        self.idle_grace = idle_grace
        self.sweep_interval = sweep_interval
        self.startup_grace = startup_grace
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        # "now" not "never": the service is built lazily by the first tile
        # request, so construction *is* activity and the first grace is owed.
        self._last_request = time.monotonic()
        self._in_flight = 0
        # Guards only the pair above; never held across a decode, so a
        # request path can never wait on the warmer's work.
        self._busy_lock = threading.Lock()
        self.state = "not started"
        self.pretile: dict = {"state": "not started", "total": 0, "done": 0, "rendered": 0, "failed": 0}
        self._pretile_plan: tuple[str, list[tuple[int, int, int]]] | None = None
        self._pruned_version: str | None = None
        self.warmed = 0
        self.failed = 0
        self.sweeps = 0

    def start(self) -> None:
        if self._thread is not None:
            return
        self.state = "starting"
        self._thread = threading.Thread(target=self._run, name="ocharts-warm", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Ask the thread to finish and wait for it (idempotent). Joining
        first keeps teardown from racing a decode against
        ``OchartsService.close`` killing its own oexserverd."""
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=30.0)
        self.state = "stopped"

    def note_request(self) -> None:
        """A tile request has started. Pair with :meth:`note_done`."""
        with self._busy_lock:
            self._in_flight += 1

    def note_done(self) -> None:
        """A tile request has finished; the idle grace runs from here."""
        with self._busy_lock:
            self._in_flight -= 1
            self._last_request = time.monotonic()

    def _idle_for(self, grace: float | None = None) -> float:
        """Seconds until warming is allowed; > 0 means wait that long. Needs
        both the in-flight counter and the timestamp — a timestamp alone
        would let the warmer take the daemon mid-request on a slow tile."""
        grace = self.idle_grace if grace is None else grace
        with self._busy_lock:
            if self._in_flight > 0:
                # positive whatever the grace: in flight always means wait
                return max(grace, 0.05)
            return self._last_request + grace - time.monotonic()

    def status(self) -> dict:
        return {
            "state": self.state,
            "warmed": self.warmed,
            "failed": self.failed,
            "sweeps": self.sweeps,
            "overview_zoom": self.overview_zoom,
            "pretile": dict(self.pretile),
        }

    def _run(self) -> None:
        if self._stop.wait(self.startup_grace):
            return
        while not self._stop.is_set():
            try:
                self._sweep()
            except Exception:  # noqa: BLE001 — a warm failure must never kill the thread
                log.exception("o-charts cell warming sweep failed")
                self.state = "error"
            if self.state == "oversized":
                return
            try:
                self._pretile_sweep()
            except Exception:  # noqa: BLE001 — same isolation as the cell sweep
                log.exception("o-charts tile pre-render sweep failed")
                self.pretile["state"] = "error"
            self.sweeps += 1
            if self._rest_between_sweeps():
                return
        self.state = "stopped"

    def _rest_between_sweeps(self) -> bool:
        """Wait out the sweep interval, ending early if the disk version
        moves. True when asked to stop."""
        deadline = time.monotonic() + self.sweep_interval
        version = getattr(self._service, "disk_version", None)
        disk = getattr(self._service, "disk_tiles", None)
        locked = disk is not None and getattr(disk, "configured", False) and not disk.enabled
        while (remaining := deadline - time.monotonic()) > 0:
            if self._stop.wait(min(remaining, VERSION_POLL_S)):
                return True
            if locked and disk.enabled:
                return False  # the licence check just opened the store
            if version is not None and self._pruned_version is not None:
                try:
                    if version() != self._pruned_version:
                        return False
                except Exception:  # noqa: BLE001 — the next sweep reports it
                    return False
        return False

    def _rest(self, deadline: list[float]) -> bool:
        """Rest once the current slice has run out; True when stopping.
        ``deadline`` is a one-element box so callers share the slice."""
        if time.monotonic() < deadline[0]:
            return False
        # Blocks without the GIL, and a shutdown needn't wait for the work.
        if self._stop.wait(PLAN_REST_S):
            return True
        deadline[0] = time.monotonic() + PLAN_SLICE_S
        return False

    def _sweep(self) -> None:
        plan = self._plan()
        if not plan:
            self.state = "nothing to warm"
            return
        warmed_now = []
        for cs, cell in plan:
            key = self._service.cell_key(cs, cell)
            if self._service.cells.touch(key):
                continue  # already held; touching it is what keeps it held
            if not self._await_idle():
                return  # stopping
            if self._warm(cs, cell):
                warmed_now.append(key)
        # Did the plan evict itself while laying itself down? Then warming
        # it is a treadmill rather than a win — see the module docs.
        if any(not self._service.cells.touch(k) for k in warmed_now):
            self.state = "oversized"
            log.warning(
                "o-charts warming stopped: the %d overview cells of the installed sets "
                "evicted each other before the sweep finished, so they do not fit "
                "ocharts.cell_budget_bytes (%d bytes) and warming them would only churn. "
                "Raise the budget to warm them; serving is unaffected.",
                len(plan),
                self._service.cells.budget,
            )
            return
        self.state = "warm"

    def _plan(self) -> list[tuple[OchartsSet, CellInfo]]:
        """Every installed set's overview cells, coarsest first — the order
        a viewport is certain to want them in, and the order that makes a
        partial (interrupted) sweep still useful."""
        plan: list[tuple[OchartsSet, CellInfo]] = []
        for cs in self._service.sets().values():
            for cell in cs.cells:
                if cell.max_zoom - WARM_DETAIL_HEADROOM <= self.overview_zoom:
                    plan.append((cs, cell))
        plan.sort(key=lambda j: (j[1].max_zoom, j[1].name))
        return plan

    # -- tile pre-rendering ------------------------------------------------

    def _pretile_tiles(self) -> list[tuple[int, int, int]]:
        """Every z/x/y in the pre-render range that some installed cell
        charts (coverage, not just extent — see ``_charting_cells``),
        coarsest zoom first. Each cell is asked only about the tiles in its
        own extent, and a tile some cell already claimed is not asked again:
        the same tiles as testing every candidate against every cell, at a
        small fraction of the calls."""
        from .service import _intersects, tile_bounds_deg  # deferred: service imports this module

        cells = [c for cs in self._service.sets().values() for c in cs.cells]
        max_zoom = self._service.pretile_max_zoom
        out: list[tuple[int, int, int]] = []
        deadline = [time.monotonic() + PLAN_SLICE_S]
        for z in range(PRETILE_MIN_ZOOM, max_zoom + 1):
            n = 1 << z
            charted: set[tuple[int, int]] = set()
            for c in cells:
                w, s, e, nn = c.extent
                x0, y0 = _lonlat_tile(w, nn, n)
                x1, y1 = _lonlat_tile(e, s, n)
                for x in range(x0, x1 + 1):
                    for y in range(y0, y1 + 1):
                        if (x, y) in charted:
                            continue
                        if c.coverage is None:
                            if _intersects(c.extent, tile_bounds_deg(z, x, y)):
                                charted.add((x, y))
                        elif c.coverage.tile_state(z, x, y) != "none":
                            charted.add((x, y))
                        if self._rest(deadline):
                            return out
            out.extend((z, x, y) for x, y in sorted(charted))
        return out

    def _switch_version(self, version: str) -> None:
        """First sight of a disk version: carry still-valid tiles over from
        the previous one, record its manifest, drop the rest. See
        .disk_tiles's "Carry-over"."""
        svc = self._service
        disk = svc.disk_tiles
        manifest_of = getattr(svc, "disk_manifest", None)
        if manifest_of is not None and disk.read_manifest(version) is None:
            current, manifest = manifest_of()
            if current != version:
                return  # moved again under us; the next sweep starts over
            self.pretile["state"] = "carrying over"
            started = time.monotonic()
            deadline = [started + PLAN_SLICE_S]
            source, moved = disk.carry_over(version, manifest, lambda: self._rest(deadline))
            if self._stop.is_set():
                return  # the old directory is still there; next start resumes
            if source is not None:
                log.info(
                    "o-charts pre-render: kept %d tiles from %s in %.0f s",
                    moved, source, time.monotonic() - started,
                )
            disk.write_manifest(version, manifest)
        disk.prune(version)
        self._pruned_version = version

    def _pretile_sweep(self) -> None:
        svc = self._service
        disk = getattr(svc, "disk_tiles", None)
        if getattr(svc, "pretile_max_zoom", None) is None or disk is None or not disk.configured:
            self.pretile["state"] = "disabled"
            return
        if not disk.enabled:
            # Locked until the licence check opens it (see .licence); the
            # next sweep tries again.
            self.pretile["state"] = "waiting for the licence check"
            return
        version = svc.disk_version()
        if self._pruned_version != version:
            self._switch_version(version)
            if self._pruned_version != version:
                return
        if self._pretile_plan is None or self._pretile_plan[0] != version:
            self.pretile.update(state="planning", total=0, done=0, rendered=0, failed=0)
            self.pretile.pop("finished_at", None)
            started = time.monotonic()
            tiles = self._pretile_tiles()
            if self._stop.is_set():
                return
            self._pretile_plan = (version, tiles)
            planned_s = round(time.monotonic() - started, 1)
            self.pretile.update(total=len(tiles), planned_s=planned_s, started_at=time.time())
            log.info(
                "o-charts pre-render: %d tiles z%d-z%d to check for disk version %s (planned in %.0f s)",
                len(tiles), PRETILE_MIN_ZOOM, svc.pretile_max_zoom, version, planned_s,
            )
        if self.pretile["state"] == "complete":
            return  # this version is done; only a new one walks the plan again
        tiles = self._pretile_plan[1]
        done = 0
        for z, x, y in tiles:
            if self._stop.is_set():
                return
            if svc.disk_version() != version:
                return  # charts/settings changed under us; next sweep replans
            if not disk.has(version, z, x, y):
                if not self._await_idle(PRETILE_IDLE_GRACE):
                    return
                self.pretile["state"] = f"rendering z{z}/{x}/{y}"
                try:
                    # _tile_all, not tile_all: that one marks a *user*
                    # request in flight, which would hold this thread off
                    # itself. Goes through the RAM single-flight, so a user
                    # asking for the same tile joins this render.
                    svc._tile_all(z, x, y)
                    self.pretile["rendered"] += 1
                except Exception as e:  # noqa: BLE001 — one bad tile must not stop the sweep
                    self.pretile["failed"] += 1
                    log.warning("pre-render z%d/%d/%d failed: %s", z, x, y, e)
            done += 1
            self.pretile["done"] = done
        self.pretile.update(state="complete", finished_at=time.time())
        took = self.pretile["finished_at"] - self.pretile.get("started_at", self.pretile["finished_at"])
        log.info(
            "o-charts pre-render complete: %d tiles, %d rendered, %d failed, in %.1f h",
            len(tiles), self.pretile["rendered"], self.pretile["failed"], took / 3600,
        )

    def _await_idle(self, grace: float | None = None) -> bool:
        """Block until nothing is in flight and the grace has passed, or
        return False if asked to stop. Re-asks every pass, so a request
        arriving while waiting extends the wait rather than being overtaken."""
        while not self._stop.is_set():
            remaining = self._idle_for(grace)
            if remaining <= 0:
                return True
            if grace is None:
                self.state = "waiting for idle"
            if self._stop.wait(remaining):
                return False
        return False

    def _warm(self, cs: OchartsSet, cell: CellInfo) -> bool:
        self.state = f"warming {cell.name}"
        started = time.monotonic()
        try:
            self._service.load_cell(cs, cell)
        except Exception as e:  # noqa: BLE001 — per-cell isolation, like the header scan
            # The LRU memoizes the failure, so this cell is not retried
            # per sweep; a daemon restart un-memoizes it (clear_errors).
            self.failed += 1
            log.warning("warming %s failed: %s", cell.name, e)
            return False
        self.warmed += 1
        log.debug(
            "warmed %s (1:%d) in %.0f ms", cell.name, cell.scale, (time.monotonic() - started) * 1000
        )
        return True


def _lonlat_tile(lon: float, lat: float, n: int) -> tuple[int, int]:
    """Web-mercator tile containing lon/lat at ``n = 2**z`` tiles per axis,
    clamped to the grid."""
    lat = max(min(lat, 85.0511), -85.0511)
    x = int((lon + 180.0) / 360.0 * n)
    r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)
