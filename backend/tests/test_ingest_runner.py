# SPDX-License-Identifier: GPL-2.0-only
"""``mivnav.ingest.runner.IngestRunner`` — the shared background-job spine
every concrete bake runner (POI, satellite, osm, osm_world, weather) builds
on. Covers cancellation (jt lvpkxtsr) directly against a synthetic runner
rather than any one provider's real bake, since the mechanism itself
(`cancel()`/`cancel_requested()`/`_interrupt()`) is provider-independent —
see that module's docstring for the design.
"""

from __future__ import annotations

import threading
import time

from mivnav.ingest.runner import ST_DONE, ST_ERROR, ST_IDLE, BaseJobStatus, IngestRunner


class _BusyError(Exception):
    pass


class _CooperativeRunner(IngestRunner[BaseJobStatus]):
    """A job that checks `cancel_requested()` between "items" — the
    checkpoint pattern a real bake's per-tile/per-zoom loop would use."""

    status_cls = BaseJobStatus
    busy_error = _BusyError
    job_name = "test job"

    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.items_done = 0

    def ingest(self) -> None:
        self._start("test", self._job)

    def _job(self) -> None:
        self.started.set()
        for _ in range(1000):
            if self.cancel_requested():
                raise RuntimeError("job noticed cancellation and stopped")
            self.items_done += 1
            time.sleep(0.005)


class _InterruptibleRunner(IngestRunner[BaseJobStatus]):
    """A job with NO checkpoint of its own — it only stops because
    `_interrupt()` (the forceful path, e.g. `subprocess.terminate()` for
    osm_world's real one) wakes it up."""

    status_cls = BaseJobStatus
    busy_error = _BusyError
    job_name = "test job"

    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self._wake = threading.Event()
        self.interrupted = threading.Event()

    def ingest(self) -> None:
        self._start("test", self._job)

    def _job(self) -> None:
        self.started.set()
        if not self._wake.wait(5.0):
            raise AssertionError("_interrupt() never woke the job")
        raise RuntimeError("interrupted")

    def _interrupt(self) -> None:
        self.interrupted.set()
        self._wake.set()


def _wait_settled(runner: IngestRunner, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    status = runner.status()
    while time.time() < deadline and status["state"] not in (ST_DONE, ST_ERROR):
        time.sleep(0.01)
        status = runner.status()
    return status


def test_status_starts_idle() -> None:
    assert _CooperativeRunner().status()["state"] == ST_IDLE


def test_cancel_on_an_idle_runner_returns_false() -> None:
    runner = _CooperativeRunner()
    assert runner.cancel() is False


def test_cancel_returns_true_while_a_bake_is_running() -> None:
    runner = _CooperativeRunner()
    runner.ingest()
    assert runner.started.wait(2.0)
    assert runner.cancel() is True


def test_cancel_stops_a_cooperative_job_status_ends_up_error_not_stuck_baking() -> None:
    """The core claim this task makes: cancel() must not leave a bake
    reporting "baking" forever — it settles to "error" with a clear
    "cancelled" reason, distinguishable from a real failure."""
    runner = _CooperativeRunner()
    runner.ingest()
    assert runner.started.wait(2.0)

    assert runner.cancel() is True
    status = _wait_settled(runner)
    assert status["state"] == ST_ERROR, status
    assert status["error"] == "cancelled"
    # The job noticed and stopped well short of doing all 1000 "items".
    assert runner.items_done < 1000


def test_cancel_when_the_job_has_no_checkpoint_relies_on_interrupt() -> None:
    """A runner whose job body never calls `cancel_requested()` (e.g. it is
    blocked in one single call, not a loop) still gets stopped — via
    `_interrupt()`, the forceful hook (osm_world's real override calls
    `Popen.terminate()`; this fake just wakes a blocked wait())."""
    runner = _InterruptibleRunner()
    runner.ingest()
    assert runner.started.wait(2.0)

    assert runner.cancel() is True
    assert runner.interrupted.is_set()
    status = _wait_settled(runner)
    assert status["state"] == ST_ERROR, status
    assert status["error"] == "cancelled"


def test_a_second_bake_after_a_cancelled_one_is_not_itself_pre_cancelled() -> None:
    """`_cancel_event` is reset per bake (`_begin`) — a stale cancel flag
    from a PREVIOUS run must never immediately kill the next one."""
    runner = _CooperativeRunner()
    runner.ingest()
    assert runner.started.wait(2.0)
    runner.cancel()
    _wait_settled(runner)

    runner.started.clear()
    runner.items_done = 0
    runner.ingest()
    assert runner.started.wait(2.0)
    time.sleep(0.05)
    assert not runner.cancel_requested()
    runner.cancel()  # let the second bake's own thread wind down cleanly
    _wait_settled(runner)


def test_a_bake_that_finishes_before_cancel_is_noticed_still_reports_done() -> None:
    """`cancel()` on an already-finished bake is simply "nothing to cancel"
    (`False`) — it must not retroactively flip a real success to "error"."""
    runner = _CooperativeRunner()

    def _fast_job() -> None:
        runner.started.set()

    runner._start("test", _fast_job)  # noqa: SLF001 -- exercising the base class directly
    status = _wait_settled(runner)
    assert status["state"] == ST_DONE
    assert runner.cancel() is False
    assert runner.status()["state"] == ST_DONE  # unchanged


def test_a_finished_bake_ends_its_log_with_a_finished_line() -> None:
    """The log's last line says the job is over — per-stage "done" lines
    (e.g. a POI set's) are followed by later stages, so they can't."""
    runner = _CooperativeRunner()

    def _job() -> None:
        runner._log("stage one done")  # noqa: SLF001

    runner._start("test", _job)  # noqa: SLF001
    status = _wait_settled(runner)
    assert status["state"] == ST_DONE
    assert status["log"][-1].startswith("finished in ")


def test_duration_formatting() -> None:
    from mivnav.ingest.runner import _duration

    assert _duration(0.4) == "0 s"
    assert _duration(42) == "42 s"
    assert _duration(185) == "3 min 05 s"
    assert _duration(3720) == "1 h 02 min"
