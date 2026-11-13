# SPDX-License-Identifier: GPL-2.0-only
"""Background overview-cell warming (mivnav.features.ocharts.warm).

The one thing warming must never do is take the daemon's single FIFO away
from a user who is looking at the chart: a background decode that lands
mid-pan is worse than no prefetch at all. So most of what is pinned here is
about *not* warming.

A fake service stands in for the real one: the decode is the thing under
test's only side effect, so making it a countable, blockable function is
what turns "does it starve a request" into an assertion instead of a
stopwatch. The real service's own end is one method (`load_cell`) and one
call site (`tile` -> `note_request`), tested in test_ocharts_serving.py.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from mivnav.features.ocharts.cache import SingleFlightLRU
from mivnav.features.ocharts.sets import CellInfo, OchartsSet
from mivnav.features.ocharts.warm import CellWarmer

FAST = dict(idle_grace=0.05, sweep_interval=0.02, startup_grace=0.0)


def _cell(name: str, scale: int, max_zoom: int, size: int = 10) -> CellInfo:
    return CellInfo(
        path=Path(f"/nonexistent/{name}.oesu"),
        key="",
        name=name,
        scale=scale,
        extent=(0.0, 0.0, 1.0, 1.0),
        min_zoom=max(0, max_zoom - 6),
        max_zoom=max_zoom,
    )


@dataclass
class FakeService:
    """The slice of OchartsService the warmer uses, with a decode we can
    count, block and fail."""

    cells: SingleFlightLRU = field(default_factory=lambda: SingleFlightLRU(1 << 30))
    chart_cells: list[CellInfo] = field(default_factory=list)
    sizes: dict[str, int] = field(default_factory=dict)
    fail: set[str] = field(default_factory=set)
    gate: threading.Event | None = None
    loaded: list[str] = field(default_factory=list)
    in_load = None

    def __post_init__(self) -> None:
        self.in_load = threading.Event()
        self._lock = threading.Lock()

    def sets(self) -> dict[str, OchartsSet]:
        cs = OchartsSet(id="S", directory=Path("/nonexistent"), sequence=1, info=None)
        cs.cells = list(self.chart_cells)
        return {"S": cs}

    def cell_key(self, cs: OchartsSet, cell: CellInfo) -> tuple:
        return ("cell", cs.id, cs.sequence, cell.path.name)

    def load_cell(self, cs: OchartsSet, cell: CellInfo):
        def load():
            self.in_load.set()
            if self.gate is not None:
                self.gate.wait(5.0)
            with self._lock:
                self.loaded.append(cell.name)
            if cell.name in self.fail:
                raise RuntimeError(f"{cell.name} is broken")
            return cell.name, self.sizes.get(cell.name, 10)

        return self.cells.get(self.cell_key(cs, cell), load)


def _until(pred, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.005)
    return False


@pytest.fixture()
def svc() -> FakeService:
    return FakeService(
        chart_cells=[
            _cell("GEN", 1_500_000, 9),
            _cell("COAST", 180_000, 12),
            _cell("APPR", 90_000, 13),
            _cell("HARB", 4_000, 16),  # native 16: not an overview cell
            # (WARM_DETAIL_HEADROOM=4, so 16-4=12 > OVERVIEW_ZOOM=10)
        ]
    )


@pytest.fixture()
def warmer(svc):
    w = CellWarmer(svc, **FAST)
    yield w
    w.stop()


# ---- what gets warmed -----------------------------------------------------


def test_warms_only_the_overview_cells_coarsest_first(svc, warmer) -> None:
    """The plan is the cells that serve an overview tile after
    WARM_DETAIL_HEADROOM — few, big and shared by every overview viewport.
    The 355 harbour plans of a national set are none of those things: they
    are asked for one at a time, and warming them would evict what everything
    needs. The warm criterion is deliberately tighter than serving's (which
    is now 6): a native-16 harbour plan may legally draw a z10 tile
    overzoomed-out, but 16-4=12 > OVERVIEW_ZOOM=10, so it is not warmed."""
    warmer.start()
    assert _until(lambda: warmer.state == "warm"), warmer.state
    # coarsest first: an interrupted sweep has still bought the widest reach
    assert svc.loaded == ["GEN", "COAST", "APPR"]


def test_warmed_cells_are_not_re_decoded(svc, warmer) -> None:
    """Sweeps are cheap: a cell the cache already holds costs a dict lookup,
    not a decode. Without this the sweep is a treadmill."""
    warmer.start()
    assert _until(lambda: warmer.sweeps >= 4)
    assert svc.loaded == ["GEN", "COAST", "APPR"]  # once each, over 4+ sweeps


def test_sweep_keeps_overview_cells_at_the_mru_end(svc, warmer) -> None:
    """Recency in the cell LRU is otherwise driven entirely by what the user
    last looked at, so an afternoon of harbour panning would evict exactly
    the cells that took longest to build. Re-touching them is free."""
    warmer.start()
    assert _until(lambda: warmer.state == "warm")
    svc.cells.get(("other",), lambda: ("x", 10))  # a user request, now MRU
    assert svc.cells.touch(("cell", "S", 1, "GEN.oesu"))
    keys = list(svc.cells._entries)
    assert _until(lambda: list(svc.cells._entries)[-1] == ("cell", "S", 1, "GEN.oesu")), keys


def test_a_failing_cell_is_counted_and_not_retried(svc, warmer) -> None:
    """Per-cell isolation, like the header scan: one broken cell must not
    stop the sweep, and the LRU's error memoization must not be defeated by
    a warmer that retries it every 60 s."""
    svc.fail = {"COAST"}
    warmer.start()
    assert _until(lambda: warmer.sweeps >= 4)
    assert warmer.failed == 1
    assert svc.loaded.count("COAST") == 1
    assert "APPR" in svc.loaded  # the sweep carried on past it


def test_nothing_to_warm_is_a_state_not_a_crash(warmer) -> None:
    warmer._service.chart_cells = []
    warmer.start()
    assert _until(lambda: warmer.state == "nothing to warm"), warmer.state


# ---- not starving a real request ------------------------------------------


def test_a_stream_of_requests_stops_the_warmer_dead(svc) -> None:
    """The central guarantee. While the user is panning, MapLibre fires
    tiles continuously; no warm decode may start in that window."""
    w = CellWarmer(svc, idle_grace=0.2, sweep_interval=0.01, startup_grace=0.0)
    try:
        w.start()
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            w.note_request()  # as OchartsService.tile does, per request
            w.note_done()
            time.sleep(0.02)
        assert svc.loaded == [], f"warmed during a pan: {svc.loaded}"
        assert w.state == "waiting for idle"
        # ...and resumes once the user stops
        assert _until(lambda: w.state == "warm"), w.state
        assert svc.loaded == ["GEN", "COAST", "APPR"]
    finally:
        w.stop()


def test_one_request_stops_the_rest_of_the_sweep(svc) -> None:
    """The idle check is re-made before *each* decode, not once per sweep.
    Otherwise a request arriving during a 36-cell warm would queue behind
    all 36 — ~15 s on a Pi — instead of behind the one already running."""
    svc.gate = threading.Event()
    w = CellWarmer(svc, idle_grace=0.05, sweep_interval=0.01, startup_grace=0.0)
    try:
        w.start()
        assert _until(lambda: svc.in_load.is_set())  # GEN's decode is in flight
        w.idle_grace = 10.0  # a pan is a stream of requests, not one
        w.note_request()  # the user pans, mid-decode
        w.note_done()
        svc.gate.set()  # GEN's decode finishes
        assert _until(lambda: w.state == "waiting for idle"), w.state
        time.sleep(0.2)
        assert svc.loaded == ["GEN"], "warmed past the request that arrived"
    finally:
        svc.gate.set()
        w.stop()


def test_note_request_takes_no_lock_the_warmer_holds(svc) -> None:
    """`note_request` is on the tile path of every request, hit or miss. It
    must be incapable of blocking one — including behind a decode this
    warmer is in the middle of."""
    svc.gate = threading.Event()
    w = CellWarmer(svc, **FAST)
    try:
        w.start()
        assert _until(lambda: svc.in_load.is_set())  # a decode is in flight
        started = time.monotonic()
        for _ in range(1000):
            w.note_request()
            w.note_done()
        assert time.monotonic() - started < 0.1
    finally:
        svc.gate.set()
        w.stop()


def test_a_request_for_a_warming_cell_joins_it(svc) -> None:
    """The warmer is not privileged and takes no separate path: it goes
    through the same SingleFlightLRU as a request. So a request that wants
    the cell being warmed waits on that decode rather than queueing a second
    one behind it — the collision case is a win, not a cost."""
    svc.gate = threading.Event()
    w = CellWarmer(svc, **FAST)
    try:
        w.start()
        assert _until(lambda: svc.in_load.is_set())
        got: list[str] = []
        cs = svc.sets()["S"]
        gen = svc.chart_cells[0]
        t = threading.Thread(target=lambda: got.append(svc.load_cell(cs, gen)))
        t.start()
        svc.gate.set()
        t.join(5.0)
        assert got == ["GEN"]
        assert svc.loaded.count("GEN") == 1  # one decode, not two
    finally:
        svc.gate.set()
        w.stop()


# ---- sizing itself out ----------------------------------------------------


def test_a_plan_that_does_not_fit_stops_rather_than_churns(svc) -> None:
    """If the overview cells cannot be resident at once, warming them is a
    decode treadmill: warm A, warm B evicting A, find A cold, forever. On a
    Pi that is pure CPU burn, and the thrashing hurts real requests too. The
    warmer notices that it evicted itself and stops."""
    svc.cells = SingleFlightLRU(100)
    svc.sizes = {"GEN": 80, "COAST": 80, "APPR": 80}
    w = CellWarmer(svc, **FAST)
    try:
        w.start()
        assert _until(lambda: w.state == "oversized"), w.state
        warmed = len(svc.loaded)
        time.sleep(0.2)
        assert len(svc.loaded) == warmed, "kept churning after giving up"
    finally:
        w.stop()


def test_a_full_cache_from_real_use_is_not_mistaken_for_oversized(svc) -> None:
    """The verdict is only for a plan that evicts *itself* during one sweep.
    A user session big enough to push an overview cell out is the LRU doing
    its job, and the next sweep simply warms it back."""
    w = CellWarmer(svc, **FAST)
    try:
        w.start()
        assert _until(lambda: w.state == "warm")
        svc.cells.clear()  # as if evicted by a long harbour-zoom session
        assert _until(lambda: svc.loaded.count("GEN") == 2)
        assert _until(lambda: w.state == "warm"), w.state
    finally:
        w.stop()


# ---- lifecycle ------------------------------------------------------------


def test_stop_is_idempotent_and_joins(svc) -> None:
    w = CellWarmer(svc, **FAST)
    w.start()
    assert _until(lambda: w.state == "warm")
    thread = w._thread
    w.stop()
    w.stop()
    assert w.state == "stopped"
    assert w._thread is None and not thread.is_alive()


def test_disabled_service_has_no_warmer(tmp_path: Path) -> None:
    from mivnav.features.ocharts.service import OchartsService

    service = OchartsService(
        sets_dir=tmp_path / "sets",
        daemon_dir=tmp_path / "daemon",
        work_dir=tmp_path / "work",
        warm_overview=False,
    )
    try:
        assert service.status()["warm"] == {"state": "disabled"}
        assert service._warmer is None
    finally:
        service.close()


def test_a_single_slow_request_is_not_overtaken_mid_flight(svc) -> None:
    """The hole a bare timestamp leaves, and the reason for the in-flight
    counter. The first cold tile takes ~1.6 s — it starts oexserverd — which
    is longer than the idle grace, so a grace measured from its *arrival*
    expires while the request is still running and the warmer takes the
    daemon out from under the one request that most needs it. Measured live
    against a real backend before the counter existed: exactly one cell was
    warmed during a 5.6 s cold pan; zero after.
    """
    w = CellWarmer(svc, idle_grace=0.05, sweep_interval=0.01, startup_grace=0.0)
    try:
        w.start()
        w.note_request()  # one long request, no others behind it
        time.sleep(0.5)  # ...ten idle graces long
        assert svc.loaded == [], f"warmed while a request was in flight: {svc.loaded}"
        w.note_done()
        assert _until(lambda: w.state == "warm"), w.state
        assert svc.loaded == ["GEN", "COAST", "APPR"]
    finally:
        w.stop()


def test_the_startup_grace_covers_the_first_requests_head_start(svc) -> None:
    """A cold start does ~1.3 s of daemon work (the 391-cell header scan)
    before the first request reaches `tile()` and starts marking itself in
    flight, so the in-flight counter cannot see it. The startup grace is
    what stops the warmer stepping into that hole — measured live: exactly
    one cell warmed during a cold pan without it, zero with it."""
    w = CellWarmer(svc, idle_grace=0.01, sweep_interval=0.01, startup_grace=0.4)
    try:
        w.start()
        time.sleep(0.2)  # the header scan: idle by every signal the warmer has
        assert svc.loaded == [], f"warmed during the cold-start burst: {svc.loaded}"
        assert _until(lambda: w.state == "warm"), w.state  # ...then it proceeds
    finally:
        w.stop()


def test_planning_rests_so_it_cannot_hold_the_gil_for_minutes(monkeypatch) -> None:
    from types import SimpleNamespace

    from mivnav.features.ocharts import warm

    cell = SimpleNamespace(extent=(9.0, 54.0, 12.0, 58.0), coverage=None)
    svc = SimpleNamespace(
        sets=lambda: {"s": SimpleNamespace(cells=[cell])}, pretile_max_zoom=8
    )
    w = warm.CellWarmer(svc, **FAST)
    rests: list[float] = []

    class Stop:
        def wait(self, timeout: float) -> bool:
            rests.append(timeout)
            return False

    w._stop = Stop()
    monkeypatch.setattr(warm, "PLAN_SLICE_S", 0.0)
    # The Python planner; real cells plan in chartcore without the GIL.
    tiles = w._pretile_tiles_py([cell], 8)
    assert tiles and len(rests) >= len(tiles)
    assert set(rests) == {warm.PLAN_REST_S}


def test_planning_stops_at_shutdown(monkeypatch) -> None:
    from types import SimpleNamespace

    from mivnav.features.ocharts import warm

    cell = SimpleNamespace(extent=(9.0, 54.0, 12.0, 58.0), coverage=None)
    svc = SimpleNamespace(
        sets=lambda: {"s": SimpleNamespace(cells=[cell])}, pretile_max_zoom=11
    )
    w = warm.CellWarmer(svc, **FAST)
    rests: list[float] = []

    class Stopped:
        def wait(self, timeout: float) -> bool:
            rests.append(timeout)
            return True

        def is_set(self) -> bool:
            return True

    w._stop = Stopped()
    monkeypatch.setattr(warm, "PLAN_SLICE_S", 0.0)
    w._pretile_tiles_py([cell], 11)
    assert rests == [warm.PLAN_REST_S], "planning must end at its first rest"
