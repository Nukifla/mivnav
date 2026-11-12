# SPDX-License-Identifier: GPL-2.0-only
"""``mivnav.data.scheduler.DatasetScheduler`` — the periodic in-process loop
that checks every declared dataset's ``schedule``/``ttl_s`` and dispatches
through the same path ``POST /datasets/{id}/ingest`` uses
(:func:`mivnav.data.provider.trigger_dataset_ingest`).

Builds its own isolated ``Runtime`` per test, same reasoning as
``tests.test_datasets_api``: these tests mutate ``Config.datasets`` and drive
real bakes, and the session ``client`` fixture's Runtime is shared across the
whole test session.

:func:`~mivnav.data.provider.dataset_due` (the pure due-ness function) is
covered directly, without any Runtime at all.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from mivnav.data import scheduler as scheduler_module
from mivnav.data.provider import dataset_due
from mivnav.data.scheduler import DatasetScheduler
from mivnav.config.model import DatasetConfig
from tests.conftest import isolated_runtime_at


@pytest.fixture
def runtime(tmp_path: Path):
    rt = isolated_runtime_at(tmp_path)
    yield rt
    rt.close()


def _set_datasets(runtime, datasets: list[dict]) -> None:
    runtime.patch_config({"datasets": datasets})


def _poi_dataset(id_: str, **kw) -> dict:
    # "solent" — the default region's `id`, not its `name` ("Solent"); see
    # Region's docstring for why `region_id` means the former since uxzqvqpv.
    return {"id": id_, "provider": "poi", "name": id_, "region_id": "solent", **kw}


# -- dataset_due: pure function, no Runtime needed ---------------------------


def _dataset(**kw) -> DatasetConfig:
    return DatasetConfig(id="a", provider="poi", name="a", **kw)


NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_manual_schedule_is_never_due():
    assert not dataset_due(_dataset(schedule="manual"), None, now=NOW)
    assert not dataset_due(_dataset(schedule="manual"), NOW.isoformat(), now=NOW)


def test_ttl_schedule_with_no_ttl_s_is_never_due():
    """"ttl" alone names no cadence — same as "manual" until ttl_s is set."""
    assert not dataset_due(_dataset(schedule="ttl", ttl_s=None), None, now=NOW)


def test_ttl_schedule_never_baked_is_due_immediately():
    assert dataset_due(_dataset(schedule="ttl", ttl_s=3600), None, now=NOW)


def test_ttl_schedule_baked_recently_is_not_due():
    last_bake_at = (NOW - timedelta(seconds=60)).isoformat()
    assert not dataset_due(_dataset(schedule="ttl", ttl_s=3600), last_bake_at, now=NOW)


def test_ttl_schedule_past_its_ttl_is_due():
    last_bake_at = (NOW - timedelta(seconds=7200)).isoformat()
    assert dataset_due(_dataset(schedule="ttl", ttl_s=3600), last_bake_at, now=NOW)


def test_disabled_dataset_is_never_due_even_past_its_ttl():
    """jt lvpkxtsr: a disabled dataset is paused, not deleted — the
    scheduler must never auto-bake it, TTL past due or not."""
    last_bake_at = (NOW - timedelta(seconds=7200)).isoformat()
    ds = _dataset(schedule="ttl", ttl_s=3600, enabled=False)
    assert not dataset_due(ds, last_bake_at, now=NOW)
    assert not dataset_due(ds, None, now=NOW)  # never baked at all, still not due


# -- DatasetScheduler.tick(): the skip cases ---------------------------------


def test_tick_skips_manual_dataset(runtime, monkeypatch):
    _set_datasets(runtime, [_poi_dataset("a", schedule="manual")])
    calls = []
    monkeypatch.setattr(
        scheduler_module, "trigger_dataset_ingest", lambda *a: calls.append(1)
    )
    DatasetScheduler(runtime).tick()
    assert calls == []


def test_tick_skips_ttl_dataset_not_yet_due(runtime, monkeypatch):
    _set_datasets(runtime, [_poi_dataset("a", schedule="ttl", ttl_s=3600)])
    config = runtime.config.get()
    directory = config.data_root / "poi" / "a"
    directory.mkdir(parents=True)
    (directory / "a.pmtiles").write_bytes(b"x")  # just baked -> not due yet

    calls = []
    monkeypatch.setattr(
        scheduler_module, "trigger_dataset_ingest", lambda *a: calls.append(1)
    )
    DatasetScheduler(runtime).tick()
    assert calls == []


def test_tick_skips_dataset_with_no_generic_bake_path(runtime, monkeypatch):
    """o-charts declares no runner_factory/trigger — dataset_runner() is
    None for it, and the scheduler must skip rather than error."""
    _set_datasets(
        runtime, [{"id": "x", "provider": "ocharts", "name": "X", "schedule": "ttl", "ttl_s": 1}]
    )
    calls = []
    monkeypatch.setattr(
        scheduler_module, "trigger_dataset_ingest", lambda *a: calls.append(1)
    )
    DatasetScheduler(runtime).tick()
    assert calls == []


def test_tick_skips_a_disabled_ttl_dataset(runtime, monkeypatch):
    """jt lvpkxtsr: disabling a dataset must stop the scheduler from
    re-baking it, same as any other skip case — gated through `dataset_due`
    itself (covered directly above), exercised here through the real
    `tick()` path."""
    _set_datasets(runtime, [_poi_dataset("a", schedule="ttl", ttl_s=1, enabled=False)])
    calls = []
    monkeypatch.setattr(
        scheduler_module, "trigger_dataset_ingest", lambda *a: calls.append(1)
    )
    DatasetScheduler(runtime).tick()
    assert calls == []


def test_tick_skips_a_busy_dataset(runtime, monkeypatch):
    _set_datasets(runtime, [_poi_dataset("a", schedule="ttl", ttl_s=1)])
    runner = runtime.dataset_runner("a")
    assert runner is not None
    runner.busy = lambda: True  # simulate a live bake without spawning a thread

    calls = []
    monkeypatch.setattr(
        scheduler_module, "trigger_dataset_ingest", lambda *a: calls.append(1)
    )
    DatasetScheduler(runtime).tick()
    assert calls == []


# -- DatasetScheduler.tick(): the real dispatch -------------------------------


def test_tick_dispatches_a_due_ttl_dataset_and_it_bakes_for_real(runtime, monkeypatch):
    """End to end, same as test_datasets_api's own POI bake test: a
    never-baked "ttl" dataset is due immediately, tick() dispatches it
    through trigger_dataset_ingest exactly like the manual route would, and
    the real bake (Overpass fetch stubbed) completes."""
    import time

    from mivnav.features.poi import overpass

    stub_elements = [
        {
            "type": "node", "id": 1, "lat": 50.75, "lon": -1.30,
            "tags": {"leisure": "marina", "name": "Stub Marina"},
        },
    ]

    def fake_fetch(http, bbox, url=overpass.DEFAULT_OVERPASS_URL, query_timeout=180, **kwargs):
        return stub_elements

    monkeypatch.setattr(overpass, "fetch_pois", fake_fetch)
    _set_datasets(runtime, [_poi_dataset("a", schedule="ttl", ttl_s=1)])

    DatasetScheduler(runtime).tick()

    runner = runtime.dataset_runner("a")
    deadline = time.time() + 10.0
    status = runner.status()
    while time.time() < deadline and status.get("state") not in ("done", "error"):
        time.sleep(0.02)
        status = runner.status()
    assert status.get("state") == "done", status

    config = runtime.config.get()
    assert any((config.data_root / "poi" / "a").glob("*.pmtiles"))


def test_a_failed_dispatch_is_not_retried_before_ttl_s_elapses(runtime, monkeypatch):
    """The floor this class adds on top of disk-derived due-ness: a bake
    that fails before writing anything must not be re-dispatched on the very
    next tick, or a scheduler running every POLL_INTERVAL_S would hammer
    whatever just failed."""
    _set_datasets(runtime, [_poi_dataset("a", schedule="ttl", ttl_s=3600)])

    calls = []

    def failing_trigger(registry, regions, dataset, runner):
        calls.append(1)
        raise ValueError("simulated failure before any file was written")

    monkeypatch.setattr(scheduler_module, "trigger_dataset_ingest", failing_trigger)

    sched = DatasetScheduler(runtime)
    sched.tick()
    sched.tick()  # still due on disk (nothing was ever written) -- must NOT re-attempt
    assert len(calls) == 1


# -- lifecycle: start/stop leaves no thread running --------------------------


def test_start_stop_leaves_no_thread_running(runtime):
    sched = DatasetScheduler(runtime, interval_s=999)
    sched.start()
    assert sched._thread is not None
    assert sched._thread.is_alive()
    sched.stop()
    assert sched._thread is None


def test_start_and_stop_are_idempotent(runtime):
    sched = DatasetScheduler(runtime, interval_s=999)
    sched.start()
    sched.start()  # no-op, no second thread
    sched.stop()
    sched.stop()  # no-op, does not raise
