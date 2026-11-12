# SPDX-License-Identifier: GPL-2.0-only
"""Shared background-job spine for ingest-bake runners — KERNEL-classified.

`PoiIngestRunner` and `SatelliteIngestRunner` implement the same job
spine almost verbatim (one background bake at a time, poll-able status,
a lock, a daemon thread); this module extracts it. See
docs/architecture/ingest-runner-spine.md for why typed status subclasses
over a generic bag, the progress/log-polling design, the cancellation
protocol (jt lvpkxtsr), and the kernel reclassification.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Generic, TypeVar

log = logging.getLogger(__name__)

#: ``(min_lon, min_lat, max_lon, max_lat)`` — the one bbox shape every
#: ingest-bake job (POI, satellite) addresses a fetch by.
BBox = tuple[float, float, float, float]

ST_IDLE = "idle"
ST_FETCH = "fetch"
ST_BAKE = "bake"
ST_DONE = "done"
ST_ERROR = "error"

#: Max lines kept in :attr:`BaseJobStatus.log` — a capped ring buffer, oldest
#: dropped first, appended to the same polled status blob (the settled
#: design: no separate streaming/paginated log endpoint).
LOG_CAP = 200


@dataclass
class BaseJobStatus:
    state: str = ST_IDLE
    detail: str = ""  # human-readable stage note (e.g. the set name)
    error: str = ""
    started: float = 0.0
    finished: float = 0.0
    # Optional/best-effort: a job that never calls _progress/_log leaves
    # these at their empty defaults (additive to existing callers/tests).
    task: str = ""  # the current sub-stage, e.g. "fetching", "z12 tiles"
    current: int = 0  # progress numerator within `task`
    total: int = 0  # progress denominator within `task`; 0 = indeterminate
    log: list[str] = field(default_factory=list)  # capped ring buffer, oldest first

    def as_dict(self) -> dict:
        d = self.__dict__.copy()
        # `log` may still be appended to by the worker thread after this
        # snapshot; the lock only guards the swap, so copy it too.
        d["log"] = list(self.log)
        return d


S = TypeVar("S", bound=BaseJobStatus)


class IngestRunner(Generic[S]):
    """One background bake at a time; status is poll-able.

    Subclasses set three class attributes and call ``super().__init__()``:
    ``status_cls`` (the `BaseJobStatus` subclass), ``busy_error`` (raised
    when a bake is already running), and ``job_name`` (short label used
    verbatim in log/error text).
    """

    status_cls: type[S]
    busy_error: type[Exception]
    job_name: str

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._status: S = self.status_cls()
        # Reset in `_begin` per bake, so a stale cancel from a previous
        # run can't be mistaken for a live one on a fresh `ingest()` call.
        self._cancel_event = threading.Event()

    def status(self) -> dict:
        with self._lock:
            return self._status.as_dict()

    def busy(self) -> bool:
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def _begin(self, detail: str) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                raise self.busy_error(f"a {self.job_name} is already running")
            self._status = self.status_cls(state=ST_FETCH, detail=detail, started=time.time())
            self._cancel_event = threading.Event()

    def _update(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self._status, k, v)

    def _progress(self, current: int, total: int, task: str = "") -> None:
        """Update numerator/denominator of the current sub-stage; ``task``
        left unchanged when omitted."""
        with self._lock:
            self._status.current = current
            self._status.total = total
            if task:
                self._status.task = task

    def _log(self, msg: str) -> None:
        """Append one line to the job's capped ring-buffer log (oldest
        dropped first, see `LOG_CAP`)."""
        with self._lock:
            buf = self._status.log
            buf.append(msg)
            overflow = len(buf) - LOG_CAP
            if overflow > 0:
                del buf[:overflow]

    def _start(self, detail: str, job: Callable[[], None]) -> None:
        """Begin a bake under ``detail`` and run ``job`` (a zero-argument
        closure) in a background daemon thread. Captures the cancel event
        into a local rather than re-reading it off the instance — see
        docs/architecture/ingest-runner-spine.md."""
        self._begin(detail)
        event = self._cancel_event
        self._thread = threading.Thread(
            target=self._run_guarded, args=(job, event), daemon=True
        )
        self._thread.start()

    def _run_guarded(self, job: Callable[[], None], cancel_event: threading.Event) -> None:
        try:
            job()
            if cancel_event.is_set():
                # Job returned normally but cancel was requested mid-run —
                # still report cancelled, not "done".
                self._log("cancelled")
                self._update(state=ST_ERROR, error="cancelled", finished=time.time())
            else:
                now = time.time()
                # An explicit last line, so the log itself says the job is
                # over (every provider's own "done" lines are per-stage —
                # later stages such as a plugin's detail pass log after them).
                self._log(f"finished in {_duration(now - self._status.started)}")
                self._update(state=ST_DONE, finished=now)
        except Exception as e:  # noqa: BLE001 — reported via status
            if cancel_event.is_set():
                log.info("%s cancelled", self.job_name)
                self._log("cancelled")
                self._update(state=ST_ERROR, error="cancelled", finished=time.time())
            else:
                log.warning("%s failed: %s", self.job_name, e)
                self._log(f"error: {e}")
                self._update(state=ST_ERROR, error=str(e), finished=time.time())

    # -- cancellation ---------------------------------------------------------

    def cancel_requested(self) -> bool:
        """Whether the current bake was asked to stop — the cooperative
        half of cancellation; see docs/architecture/ingest-runner-spine.md."""
        return self._cancel_event.is_set()

    def cancel(self) -> bool:
        """Ask the running bake to stop; ``True`` if one was actually
        running. Does not join the thread — the state transition to
        error/cancelled happens asynchronously; poll ``status()``."""
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                return False
            self._cancel_event.set()
        try:
            self._interrupt()
        except Exception:  # noqa: BLE001 — best-effort, cancel() still succeeded
            log.warning("%s: _interrupt() failed", self.job_name, exc_info=True)
        return True

    def _interrupt(self) -> None:
        """Hook: actively abort whatever blocking call the job body is in
        right now, for a prompt cancel. No-op by default; see
        docs/architecture/ingest-runner-spine.md."""


def _duration(seconds: float) -> str:
    """``42 s`` / ``3 min 05 s`` / ``1 h 02 min`` — a bake's wall time."""
    s = max(0, round(seconds))
    if s < 60:
        return f"{s} s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m} min {s:02d} s"
    h, m = divmod(m, 60)
    return f"{h} h {m:02d} min"
