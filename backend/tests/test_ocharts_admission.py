# SPDX-License-Identifier: GPL-2.0-only
"""Render admission (#MEM-GATE): the weighted FIFO gate itself, and its
wiring through ``chartcore.serve_tile[_union]``'s ``admit`` hook."""

import threading
import time
from pathlib import Path

import pytest

from mivnav.features.ocharts.admission import PEAK_PER_FILE_BYTE, RenderGate
from senc_fixture import point_cell


# ---- the gate ---------------------------------------------------------------


def test_weights_share_the_budget_and_release_frees_it() -> None:
    gate = RenderGate(100, timeout=1.0)
    a = gate.acquire(60)
    b = gate.acquire(40)
    assert (a, b) == (60, 40)
    assert gate.stats()["in_use"] == 100
    gate.release(a)
    gate.release(b)
    assert gate.stats()["in_use"] == 0


def test_an_oversized_render_is_clamped_and_runs_alone() -> None:
    """A tile the budget can never fit must still render — just not beside
    anything else."""
    gate = RenderGate(100, timeout=0.2)
    big = gate.acquire(10_000)
    assert big == 100
    with pytest.raises(TimeoutError):
        gate.acquire(1)  # nothing fits beside it
    gate.release(big)
    gate.release(gate.acquire(1))


def test_timeout_leaves_no_charge_and_no_queue_entry() -> None:
    gate = RenderGate(10, timeout=0.05)
    held = gate.acquire(10)
    with pytest.raises(TimeoutError):
        gate.acquire(5)
    s = gate.stats()
    assert (s["in_use"], s["queued"], s["timeouts"]) == (10, 0, 1)
    gate.release(held)
    # the line is not wedged by the timed-out ticket
    gate.release(gate.acquire(10))


def test_fifo_a_heavy_waiter_is_not_starved_by_later_light_ones() -> None:
    """Arrival order is admission order: a light render arriving after a
    queued heavy one waits behind it even though it would fit now."""
    gate = RenderGate(100, timeout=5.0)
    first = gate.acquire(50)
    order: list[str] = []

    def take(name: str, w: int) -> None:
        c = gate.acquire(w)
        order.append(name)
        time.sleep(0.05)
        gate.release(c)

    heavy = threading.Thread(target=take, args=("heavy", 100))
    heavy.start()
    while gate.stats()["queued"] < 1:
        time.sleep(0.001)
    light = threading.Thread(target=take, args=("light", 10))
    light.start()
    while gate.stats()["queued"] < 2:
        time.sleep(0.001)
    time.sleep(0.05)
    assert order == [], "light (10) fits beside first (50) but must queue behind heavy"
    gate.release(first)
    heavy.join(2)
    light.join(2)
    assert order == ["heavy", "light"]
    assert gate.stats()["in_use"] == 0


# ---- the wiring -------------------------------------------------------------


def _service(tmp_path: Path, **kw):
    from mivnav.features.ocharts.service import OchartsService

    sets_dir = tmp_path / "ocharts"
    d = sets_dir / "set-A"
    d.mkdir(parents=True)
    point_cell(
        d / "WEST.senc", name="WEST", scale=180_000,
        bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.0, 54.0, 11.19, 54.4),
    )
    point_cell(
        d / "EAST.senc", name="EAST", scale=180_000,
        bounds=(11.16, 54.19, 11.21, 54.21), covr=(11.19, 54.0, 11.4, 54.4),
    )
    (d / "keys.xml").write_text("<keyList><ChartInfo>Adm</ChartInfo></keyList>")
    svc = OchartsService(
        sets_dir=sets_dir, daemon_dir=tmp_path / "d", work_dir=tmp_path / "w",
        rescan_interval=0, warm_overview=False, **kw,
    )
    return svc, d


# A z13 tile split between the two cells at lon 11.19 — both are loaded.
_Z, _X, _Y = 13, 4350, 2622


def _record_acquires(gate: RenderGate) -> list[int]:
    seen: list[int] = []
    real = gate.acquire

    def acquire(weight: int) -> int:
        seen.append(weight)
        return real(weight)

    gate.acquire = acquire  # type: ignore[method-assign]
    return seen


@pytest.mark.parametrize("path", ["union", "single"])
def test_a_render_is_admitted_for_exactly_its_cells_and_released(
    tmp_path: Path, path: str
) -> None:
    svc, d = _service(tmp_path)
    try:
        seen = _record_acquires(svc.render_gate)
        if path == "union":
            data = svc._cut_tile_all(_Z, _X, _Y)
        else:
            data = svc._cut_tile(svc.get("set-A"), _Z, _X, _Y)
        assert data is not None
        disk = sum(p.stat().st_size for p in d.glob("*.senc"))
        assert seen == [PEAK_PER_FILE_BYTE * disk], "one admission, weighing both loaded cells"
        s = svc.render_gate.stats()
        assert (s["admitted"], s["in_use"]) == (1, 0), "released after the render"
    finally:
        svc.close()


def test_a_failing_render_still_releases(tmp_path: Path) -> None:
    svc, _ = _service(tmp_path)
    try:
        def boom(cs, cell):
            raise RuntimeError("decode exploded")

        svc.load_cell = boom  # type: ignore[method-assign]
        with pytest.raises(RuntimeError):
            svc._cut_tile_all(_Z, _X, _Y)
        assert svc.render_gate.stats()["in_use"] == 0
    finally:
        svc.close()


def test_refused_admission_is_a_retryable_timeout_not_a_memoized_failure(
    tmp_path: Path,
) -> None:
    """A render that cannot get admitted in time surfaces as TimeoutError
    (the route's 503) and is NOT remembered by the tile cache — the next
    request, once the budget frees, renders normally."""
    svc, _ = _service(tmp_path, admit_timeout=0.05)
    try:
        held = svc.render_gate.acquire(svc.render_gate.capacity)
        with pytest.raises(TimeoutError):
            svc.tile_all(_Z, _X, _Y)
        svc.render_gate.release(held)
        assert svc.tile_all(_Z, _X, _Y) is not None
    finally:
        svc.close()
