# SPDX-License-Identifier: GPL-2.0-only
"""The periodic dataset scheduler: an in-process loop, started alongside the
app, that dispatches due datasets through the same path
``POST /datasets/{id}/ingest`` uses. See docs/architecture/dataset-scheduler.md
for why it also tracks its own dispatch attempts (disk mtime alone isn't
enough due-ness signal) and why it's deliberately not a config knob.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from pydantic import ValidationError

from mivnav.config.base import dataset_dir
from mivnav.config.dataset_layout import dataset_disk_stats
from mivnav.data.provider import (
    DatasetProviderNotBakeable,
    UnknownDatasetProvider,
    UnknownDatasetRegion,
    dataset_due,
    trigger_dataset_ingest,
)

if TYPE_CHECKING:
    from mivnav.api.deps import Runtime
    from mivnav.config.model import Config, DatasetConfig

log = logging.getLogger(__name__)

#: Hardcoded, not a config field — infrastructure plumbing, not a perf/quality
#: tradeoff a boat owner would tune. See docs/architecture/dataset-scheduler.md.
POLL_INTERVAL_S = 300.0

#: Generous headroom, not a measured worst case — a tick only starts a
#: runner's background thread, it doesn't block for the bake.
_STOP_TIMEOUT = 10.0


class DatasetScheduler:
    """Owns one background thread that wakes every ``POLL_INTERVAL_S`` and
    checks every declared dataset for due-ness, dispatching each one that is.

    Construct with the process :class:`~mivnav.api.deps.Runtime`; call
    :meth:`start` at application startup and :meth:`stop` at shutdown (see
    the FastAPI lifespan in :mod:`mivnav.api.app`) — the same contract
    :class:`~mivnav.features.route.watcher.NavWatcher` already has.
    """

    def __init__(
        self, runtime: "Runtime", *, interval_s: float = POLL_INTERVAL_S
    ) -> None:
        self._runtime = runtime
        self._interval_s = interval_s
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        #: dataset id -> monotonic time of last dispatch ATTEMPT. Never
        #: cleared on removal — see docs/architecture/dataset-scheduler.md.
        self._last_attempt: dict[str, float] = {}

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        """Start the background thread. Idempotent; safe to call once."""
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run, name="dataset-scheduler", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        """Stop the background thread. Idempotent."""
        thread = self._thread
        if thread is None:
            return
        self._stop_event.set()
        thread.join(timeout=_STOP_TIMEOUT)
        if thread.is_alive():
            log.warning("the dataset scheduler did not stop within %ss", _STOP_TIMEOUT)
        self._thread = None

    def _run(self) -> None:
        # Wait FIRST, then tick — see docs/architecture/dataset-scheduler.md.
        while not self._stop_event.wait(self._interval_s):
            self.tick()

    # -- the sweep -------------------------------------------------------

    def tick(self) -> None:
        """Check every declared dataset once and dispatch each one that is
        due. Public (not just an internal ``_tick``) so a test can drive a
        sweep directly rather than waiting out a real ``POLL_INTERVAL_S``."""
        config = self._runtime.config.get()
        for dataset in config.datasets:
            try:
                self._maybe_dispatch(config, dataset)
            except Exception:  # noqa: BLE001 — one dataset's fault must not kill the sweep
                log.exception(
                    "dataset scheduler failed checking dataset %r", dataset.id
                )

    def _maybe_dispatch(self, config: "Config", dataset: "DatasetConfig") -> None:
        directory = dataset_dir(config.data_root, dataset.provider, dataset.id)
        _, last_bake_at = dataset_disk_stats(directory)
        if not dataset_due(dataset, last_bake_at, now=datetime.now(timezone.utc)):
            return

        # Floor of one attempt per ttl_s — see docs/architecture/dataset-scheduler.md.
        last_attempt = self._last_attempt.get(dataset.id)
        now_monotonic = time.monotonic()
        if last_attempt is not None and (now_monotonic - last_attempt) < (
            dataset.ttl_s or 0
        ):
            return

        runner = self._runtime.dataset_runner(dataset.id)
        if runner is None:
            return  # no generic bake path (o-charts) or an unregistered provider

        if runner.busy():
            return  # already running; don't pile another trigger on top

        self._last_attempt[dataset.id] = now_monotonic
        try:
            registry = self._runtime.provider_registry()
            trigger_dataset_ingest(registry, config.regions, dataset, runner)
        except (
            UnknownDatasetProvider,
            DatasetProviderNotBakeable,
            UnknownDatasetRegion,
            ValidationError,
            ValueError,
            runner.busy_error,
        ):
            log.warning(
                "scheduled bake for dataset %r could not start", dataset.id, exc_info=True
            )
            return
        log.info(
            "dataset scheduler started a bake for %r (schedule=%r, ttl_s=%r, "
            "last_bake_at=%r)",
            dataset.id, dataset.schedule, dataset.ttl_s, last_bake_at,
        )
