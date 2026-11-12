# SPDX-License-Identifier: GPL-2.0-only
"""Notices as DATASETS, against a fake Niord (tests/fake_niord.py): an
update through the generic dataset path persists the raw bundle; a failed
update KEEPS the last good copy; a reboot with no network serves disk;
regions filter at serve time; several datasets merge; the dataset
scheduler drives the ttl schedule; side-feed fallbacks, attachments,
search slices, unknown-id details."""

from __future__ import annotations

import json
import os

import pytest

from mivnav.data.scheduler import DatasetScheduler
from mivnav.features.notices.catalog import SOURCES
from mivnav.features.notices.runtime import (
    NO_DATASET,
    SNAPSHOT_FILE,
    NoticesCancelled,
    NoticesNotFound,
    NoticesUnavailable,
)
from tests.fake_niord import (
    ATTACHMENT_URL,
    DATASET_ID,
    FE_ID,
    Clock,
    FakeNiord,
    notices_api_runtime,
    notices_dataset,
    notices_of,
    update,
    wait,
)


@pytest.fixture
def fake():
    return FakeNiord()


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def rt(tmp_path, fake, clock):
    runtime = notices_api_runtime(tmp_path, fake, clock)
    yield runtime
    runtime.close()


def snapshot(rt, dataset_id: str = DATASET_ID):
    return notices_of(rt).dataset_dir(dataset_id) / SNAPSHOT_FILE


def test_an_update_pulls_and_persists(rt, fake):
    nr = notices_of(rt)
    assert nr.served() is None
    assert nr.status()["state"] == "idle"
    job = update(rt)
    assert job["state"] == "done"
    assert any("notices feed: 9 messages" in line for line in job["log"])
    served = nr.served()
    assert served is not None and len(served.norm.items) == 13
    st = nr.status()
    assert st["state"] == "ready" and st["count"] == 13 and st["error"] is None
    assert st["version"] == served.version
    assert st["fetched_at"].startswith("2026-10-03T08:00:00")
    assert st["by_family"]["fa"] == 2
    on_disk = json.loads(snapshot(rt).read_text())
    assert on_disk["schema"] == 1 and len(on_disk["main"]["data"]) == 9
    # the 450 KB coastline in the firing schedule is not stored
    assert "parent" not in on_disk["periods"]["data"][0]["area"]
    assert fake.calls["messages:None"] == 1 and fake.calls["periods"] == 1


def test_the_datasets_api_lists_it_like_any_other(rt):
    from mivnav.api.datasets import list_datasets

    update(rt)
    body = list_datasets(rt)
    (entry,) = [d for d in body["datasets"] if d["provider"] == "notices"]
    assert entry["status"] == "baked" and entry["size"] > 0 and entry["last_bake_at"]
    assert entry["schedule"] == "ttl" and entry["ttl_s"] == 1800
    assert entry["params"] == {"regions": ["dk", "gl"]}
    (cat,) = [p for p in body["providers"] if p["id"] == "notices"]
    assert cat["creatable"] and cat["region_kind"] == "none"
    assert (cat["schedule"], cat["ttl_s"]) == ("ttl", 1800)
    assert cat["default_implementation"] == "dk-niord"


def test_a_failed_update_keeps_the_last_good_copy(rt, fake):
    nr = notices_of(rt)
    update(rt)
    good = nr.served()
    before = snapshot(rt).read_bytes()
    fake.down = True
    job = update(rt)
    assert job["state"] == "error" and "no route to host" in job["error"]
    assert snapshot(rt).read_bytes() == before  # never touched
    after = nr.served()
    assert after is not None and after.version == good.version
    st = nr.status()
    assert st["state"] == "offline" and "no route to host" in st["error"]
    assert st["count"] == 13 and st["fetched_at"] is not None
    fake.down = False
    assert update(rt)["state"] == "done"
    assert nr.status()["state"] == "ready"


def test_main_feed_failure_on_the_first_update_writes_nothing(rt, fake):
    fake.broken.add("messages:None")
    assert update(rt)["state"] == "error"
    assert not snapshot(rt).exists()
    st = notices_of(rt).status()
    assert st["state"] == "offline" and "HTTP 500" in st["error"] and st["count"] == 0


def test_a_cancelled_update_writes_nothing(rt, tmp_path):
    nr = notices_of(rt)
    directory = nr.dataset_dir(DATASET_ID)
    with pytest.raises(NoticesCancelled):
        nr.pull(directory, SOURCES["dk-niord"], cancelled=lambda: True)
    assert not (directory / SNAPSHOT_FILE).exists()


def test_a_reboot_with_no_network_serves_the_disk_copy(rt, tmp_path):
    update(rt)
    version = notices_of(rt).served().version
    offline = FakeNiord()
    offline.down = True
    again = notices_api_runtime(tmp_path, offline)
    try:
        nr = notices_of(again)
        served = nr.served()
        assert served is not None and served.version == version
        assert nr.status()["state"] == "ready"
        assert nr.first_runs_due() == []  # it has a copy: nothing to kick
        assert nr.detail("NM-842-26")["sid"] == "NM-842-26"
    finally:
        again.close()


def test_regions_filter_at_serve_time_without_a_refetch(rt, fake):
    nr = notices_of(rt)
    update(rt)
    assert nr.status()["count"] == 13
    rt.patch_config({"datasets": [notices_dataset(regions=["dk"])]})
    st = nr.status()
    assert st["count"] == 12  # no Greenland NM
    assert all(not r["gl"] for r in nr.served().norm.items)
    rt.patch_config({"datasets": [notices_dataset(regions=["gl"])]})
    assert {r["sid"] for r in nr.served().norm.items} == {"NM-887-26", "A/24 2026"}
    assert fake.calls["messages:None"] == 1  # only the one pull


def test_two_datasets_merge_without_duplicates(tmp_path, fake):
    rt = notices_api_runtime(
        tmp_path,
        fake,
        datasets=[notices_dataset("dk", regions=["dk"]), notices_dataset("gl", regions=["gl"])],
    )
    try:
        nr = notices_of(rt)
        update(rt, "dk")
        assert nr.status()["count"] == 12
        update(rt, "gl")
        served = nr.served()
        assert len(served.norm.items) == 13
        assert len({r["id"] for r in served.norm.items}) == 13
        index = rt.search_index()
        # one slice per dataset; the shared EfS A notice counted once
        assert index.record_count(source="notices", region="dk") == 12
        assert index.record_count(source="notices", region="gl") == 1
        hits = index.search("NM-887", source="notices")
        assert [h["data"]["sid"] for h in hits] == ["NM-887-26"]
        # disabling one drops it from serving and from search
        rt.patch_config(
            {"datasets": [notices_dataset("dk", regions=["dk"]), notices_dataset("gl", regions=["gl"], enabled=False)]}
        )
        assert nr.status()["count"] == 12
        assert index.record_count(source="notices", region="gl") == 0
    finally:
        rt.close()


def test_no_enabled_dataset_serves_nothing_and_never_calls_niord(rt, fake):
    update(rt)
    rt.patch_config({"datasets": [notices_dataset(enabled=False)]})
    fake.calls.clear()
    nr = notices_of(rt)
    assert nr.served() is None
    assert nr.first_runs_due() == []
    st = nr.status()
    assert st["state"] == "offline" and st["error"] == NO_DATASET and st["count"] == 0
    with pytest.raises(NoticesUnavailable):
        nr.detail("NM-111-11")
    assert not fake.calls


def test_corrupt_snapshot_is_ignored(rt):
    path = snapshot(rt)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json")
    assert notices_of(rt).served() is None


def test_side_feeds_fall_back_to_the_previous_copy(rt, fake):
    update(rt)
    fake.broken |= {"messages:niord-fa", "periods"}
    job = update(rt)
    assert job["state"] == "done"
    assert any("firing areas: failed" in line for line in job["log"])
    served = notices_of(rt).served()
    fa = [r for r in served.norm.items if r["fam"] == "fa"]
    assert len(fa) == 2
    # the schedule is the same day's, kept from the previous pull
    assert next(r for r in fa if r["sid"] == "FA/EK-R-18 2026")["win"]
    # EfS A/B are pulled at most daily
    assert fake.calls["messages:niord-almanac"] == 1


def test_no_schedule_ever_falls_back_to_exercise_dates(tmp_path, fake):
    fake.broken.add("periods")
    rt = notices_api_runtime(tmp_path, fake, Clock(Clock().t + 2 * 86400))  # 5 Oct
    try:
        update(rt)
        served = notices_of(rt).served()
        ek396 = next(r for r in served.norm.items if r["sid"] == "FA/EK-D-396 2026")
        assert ek396["win"] == [[1791180000000, 1791230400000]]
    finally:
        rt.close()


def test_the_day_rolling_over_renormalises_without_a_pull(rt, fake, clock):
    nr = notices_of(rt)
    update(rt)
    first = nr.served()
    fake.down = True
    clock.t += 86400  # tomorrow, offline
    second = nr.served()
    assert second.version != first.version
    ek18 = next(r for r in second.norm.items if r["sid"] == "FA/EK-R-18 2026")
    assert ek18["win"] == []  # yesterday's schedule does not apply today


def test_search_index_gets_the_notices(rt):
    update(rt)
    index = rt.search_index()
    hits = index.search("NM-842", source="notices")
    assert [h["data"]["sid"] for h in hits] == ["NM-842-26"]
    hits = index.search("Kalvebodbroerne", source="notices")
    assert hits and hits[0]["data"]["cls"] == "light"
    assert index.record_count(source="notices", region=DATASET_ID) == 13


def test_attachments_are_cached_per_dataset_and_pruned(rt):
    nr = notices_of(rt)
    update(rt)
    served = nr.served()
    key = next(k for k, v in served.norm.attachments.items() if v["url"] == ATTACHMENT_URL)
    adir = nr.dataset_dir(DATASET_ID) / "attachments"
    path = adir / key
    assert path.read_bytes() == b"%PDF-1.4 fake"
    # the UK attachment 404s upstream: not cached, no crash
    assert len(list(adir.iterdir())) == 1
    stale = adir / "deadbeef"
    stale.write_bytes(b"x")
    update(rt)
    assert not stale.exists() and path.exists()
    got, info = nr.attachment(key)
    assert got == path and info["mime"] == "application/pdf"
    with pytest.raises(NoticesNotFound):
        nr.attachment("nope")


def test_unknown_id_is_fetched_once_and_kept(rt, fake, tmp_path):
    nr = notices_of(rt)
    update(rt)
    doc = nr.detail("NM-567-25")
    assert doc["status"] == "CANCELLED" and doc["sid"] == "NM-567-25"
    nr.detail("NM-567-25")
    assert fake.calls["message:NM-567-25"] == 1
    # kept on disk: a fresh runtime offline still has it
    fake.down = True
    again = notices_api_runtime(tmp_path, fake)
    try:
        assert notices_of(again).detail("NM-567-25")["status"] == "CANCELLED"
    finally:
        again.close()
    with pytest.raises(NoticesUnavailable):
        nr.detail("NM-999-99")
    fake.down = False
    with pytest.raises(NoticesNotFound):
        nr.detail("NM-999-99")


def test_detail_by_uuid_and_short_id(rt, fake):
    nr = notices_of(rt)
    update(rt)
    assert nr.detail(FE_ID)["fam"] == "fe"
    assert nr.detail("FA/EK-R-18 2026")["fam"] == "fa"
    assert fake.calls["message:FA/EK-R-18 2026"] == 0


def test_moving_data_root_reloads(rt, tmp_path):
    update(rt)
    rt.patch_config({"data_root": str(tmp_path / "moved")})
    assert notices_of(rt).served() is None  # nothing at the new root


def test_first_runs_due_only_for_never_pulled_ttl_datasets(tmp_path, fake, clock):
    rt = notices_api_runtime(
        tmp_path,
        fake,
        clock,
        datasets=[notices_dataset("auto"), notices_dataset("manual", schedule="manual", ttl_s=None)],
    )
    try:
        nr = notices_of(rt)
        assert nr.first_runs_due() == ["auto"]
        assert nr.first_runs_due() == []  # once per backoff
        clock.t += 301
        assert nr.first_runs_due() == ["auto"]
        update(rt, "auto")
        clock.t += 301
        assert nr.first_runs_due() == []  # it has a copy now
    finally:
        rt.close()


def test_the_scheduler_drives_the_ttl_schedule(rt, fake):
    scheduler = DatasetScheduler(rt, interval_s=3600)
    scheduler.tick()  # never pulled: due
    wait(rt.dataset_runner(DATASET_ID))
    assert fake.calls["messages:None"] == 1 and snapshot(rt).exists()
    scheduler.tick()  # fresh: not due
    assert fake.calls["messages:None"] == 1
    # age every file past ttl_s (1800) and forget the attempt floor
    old = snapshot(rt).stat().st_mtime - 3600
    for f in notices_of(rt).dataset_dir(DATASET_ID).rglob("*"):
        os.utime(f, (old, old))
    scheduler._last_attempt.clear()
    scheduler.tick()
    wait(rt.dataset_runner(DATASET_ID))
    assert fake.calls["messages:None"] == 2


def test_a_failing_scheduled_update_keeps_serving(rt, fake):
    update(rt)
    version = notices_of(rt).served().version
    fake.down = True
    old = snapshot(rt).stat().st_mtime - 3600
    for f in notices_of(rt).dataset_dir(DATASET_ID).rglob("*"):
        os.utime(f, (old, old))
    scheduler = DatasetScheduler(rt, interval_s=3600)
    scheduler.tick()
    wait(rt.dataset_runner(DATASET_ID))
    assert notices_of(rt).served().version == version
    assert notices_of(rt).status()["state"] == "offline"


def test_the_pre_dataset_snapshot_is_adopted(rt, fake, tmp_path):
    """A boat upgrading with no uplink keeps the notices it had."""
    update(rt)
    legacy_root = notices_of(rt).root()
    body = snapshot(rt).read_bytes()
    # put the snapshot where the pre-dataset runtime kept it
    for f in notices_of(rt).dataset_dir(DATASET_ID).rglob("*"):
        if f.is_file():
            f.unlink()
    (legacy_root / SNAPSHOT_FILE).write_bytes(body)
    fake.down = True
    again = notices_api_runtime(tmp_path, fake)
    try:
        served = notices_of(again).served()
        assert served is not None and len(served.norm.items) == 13
        assert snapshot(again).read_bytes() == body
        assert not (legacy_root / SNAPSHOT_FILE).exists()
    finally:
        again.close()
