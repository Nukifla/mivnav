# SPDX-License-Identifier: GPL-2.0-only
"""The day cache: what is asked of SignalK, and when it is NOT asked.

- a finished day is fetched once and then read from disk, by any window;
- the day still being written is re-asked only for what is new;
- days with no fixes cost one shared probe, not a query each;
- "forever" finds where history starts once, then remembers;
- a window too big for one request fills in newest-first over several,
  saying so (``complete``) rather than timing out;
- a line crossing midnight is one line, and the window's edge clips it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from mivnav.features.track.client import TrackClient, wire_time
from mivnav.features.track.geometry import Fix
from mivnav.features.track.store import HISTORY_EPOCH, SETTLE_S, TrackStore, split_recent
from tests.fake_history import TOKEN, FakeHistory

NOW = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def sail(start: datetime, minutes: int, *, lat0=55.0, lon0=12.0) -> list[tuple[str, float, float]]:
    """A zig-zag at ~4 kn, a fix a minute — every corner survives
    simplification, so point counts are predictable."""
    out = []
    for i in range(minutes + 1):
        t = datetime.fromtimestamp(start.timestamp() + 60 * i, UTC)
        out.append((iso(t), lat0 + 0.001 * i, lon0 + (0.0015 if i % 2 else 0.0)))
    return out


@pytest.fixture
def history():
    fake = FakeHistory().start()
    yield fake
    fake.stop()


@pytest.fixture
def store():
    clock = {"now": NOW.timestamp()}
    s = TrackStore(clock=lambda: clock["now"])
    s.clock = clock  # type: ignore[attr-defined]
    return s


def client(history: FakeHistory) -> TrackClient:
    return TrackClient(history.base_url, TOKEN)


def froms(history: FakeHistory) -> list[str]:
    return [q["from"] for q in history.queries]


def test_a_finished_day_is_fetched_once_then_read_from_disk(history, store, tmp_path: Path):
    history.set_positions(sail(datetime(2026, 7, 28, 10, tzinfo=UTC), 30))
    first = store.track(client(history), tmp_path, 72)
    assert sum(len(line) for line in first.lines) == 31
    day = "2026-07-28T00:00:00Z"
    assert froms(history).count(day) == 1

    history.queries.clear()
    again = TrackStore(clock=lambda: NOW.timestamp()).track(client(history), tmp_path, 72)
    assert again.lines == first.lines
    assert day not in froms(history)


def test_today_is_reasked_only_for_what_is_new(history, store, tmp_path: Path):
    today = datetime(2026, 7, 30, tzinfo=UTC)
    history.set_positions(sail(datetime(2026, 7, 30, 11, tzinfo=UTC), 30))
    store.track(client(history), tmp_path, 6)
    assert history.queries[-1]["from"] == wire_time(today)

    store.clock["now"] += 60
    store.track(client(history), tmp_path, 6)
    # From the last fix held (11:30), less the late-write overlap.
    assert history.queries[-1]["from"] == "2026-07-30T11:28:00Z"


def test_empty_days_cost_one_probe_and_are_remembered(history, store, tmp_path: Path):
    history.set_positions(sail(datetime(2026, 7, 20, 10, tzinfo=UTC), 30))
    store.track(client(history), tmp_path, 10 * 24)
    fine = [q for q in history.queries if q["resolution"] == "5"]
    probes = [q for q in history.queries if q["resolution"] == "86400"]
    assert len(probes) == 1
    # The data day and its in-window neighbour (bucket-label slack), and
    # today (still live) — not all eleven.
    assert len(fine) == 3

    history.queries.clear()
    store.track(client(history), tmp_path, 10 * 24)
    # Only today (still live) and the precise last 12 h — no cached day.
    assert sorted(q["resolution"] for q in history.queries) == ["1", "5"]
    assert all(q["from"] >= "2026-07-30T00:00:00Z" for q in history.queries)


def test_forever_finds_where_history_starts_once(history, store, tmp_path: Path):
    history.set_positions(sail(datetime(2026, 7, 1, 10, tzinfo=UTC), 30))
    result = store.track(client(history), tmp_path, None)
    assert froms(history)[0] == wire_time(HISTORY_EPOCH)
    assert sum(len(line) for line in result.lines) == 31
    assert result.complete

    history.queries.clear()
    store.track(client(history), tmp_path, None)
    assert wire_time(HISTORY_EPOCH) not in froms(history)


def test_forever_with_no_history_is_empty_and_not_remembered(history, store, tmp_path: Path):
    result = store.track(client(history), tmp_path, None)
    assert result.lines == [] and result.complete
    history.set_positions(sail(datetime(2026, 7, 29, 10, tzinfo=UTC), 30))
    assert store.track(client(history), tmp_path, None).lines


def test_a_big_window_fills_in_newest_first_over_several_requests(history, store, tmp_path: Path):
    days = [datetime(2026, 7, d, 10, tzinfo=UTC) for d in (10, 14, 18)]
    history.set_positions([fix for d in days for fix in sail(d, 30)])
    seen_at: dict[float, int] = {}
    for call in range(20):
        result = store.track(client(history), tmp_path, 25 * 24, budget_s=0)
        for line in result.lines:
            seen_at.setdefault(line[0].t, call)
        if result.complete:
            break
    assert call > 0, "a zero budget still did everything in one request"
    assert [line[0].t for line in result.lines] == [d.timestamp() for d in days]
    order = [seen_at[d.timestamp()] for d in days]
    assert order == sorted(order, reverse=True) and order[0] > order[-1]


def test_a_line_across_midnight_is_one_line(history, store, tmp_path: Path):
    history.set_positions(sail(datetime(2026, 7, 28, 23, 40, tzinfo=UTC), 40))
    result = store.track(client(history), tmp_path, 72)
    assert len(result.lines) == 1
    assert len(result.lines[0]) == 41


def test_the_window_edge_clips_the_line(history, store, tmp_path: Path):
    history.set_positions(sail(datetime(2026, 7, 30, 10, tzinfo=UTC), 120))
    result = store.track(client(history), tmp_path, 1)
    assert all(f.t >= NOW.timestamp() - 3600 for line in result.lines for f in line)
    assert sum(len(line) for line in result.lines) == 61


def test_a_day_is_not_cached_until_the_plugin_has_settled(history, store, tmp_path: Path):
    """Just after midnight yesterday is still re-asked: a plugin may not
    have flushed its last writes yet."""
    history.set_positions(sail(datetime(2026, 7, 29, 23, 30, tzinfo=UTC), 20))
    store.clock["now"] = datetime(2026, 7, 30, tzinfo=UTC).timestamp() + SETTLE_S / 2
    store.track(client(history), tmp_path, 24)
    assert not list(tmp_path.rglob("2026-07-29.json"))
    store.clock["now"] += SETTLE_S
    store.track(client(history), tmp_path, 24)
    assert list(tmp_path.rglob("2026-07-29.json"))


def test_each_server_has_its_own_cache(history, store, tmp_path: Path):
    history.set_positions(sail(datetime(2026, 7, 28, 10, tzinfo=UTC), 30))
    store.track(client(history), tmp_path, 72)
    other = TrackClient(history.base_url.replace("127.0.0.1", "localhost"), TOKEN)
    history.queries.clear()
    store.track(other, tmp_path, 72)
    assert "2026-07-28T00:00:00Z" in froms(history)


OLD = "vessels.urn:mrn:signalk:uuid:d6f412c2-470c-470b-b861-d0219a156281"


def test_past_identities_of_the_boat_are_part_of_its_track(history, store, tmp_path: Path):
    """Measured on the boat: everything before the MMSI was entered is
    stored under the uuid SignalK generated at setup, and `vessels.self`
    resolves only to the MMSI. Without the old context, half the history
    is invisible."""
    history.set_positions(sail(datetime(2026, 7, 29, 10, tzinfo=UTC), 20))
    history.rows_by_context[OLD] = [
        [t, {"latitude": lat, "longitude": lon}]
        for t, lat, lon in sail(datetime(2026, 7, 1, 10, tzinfo=UTC), 20, lat0=54.0)
    ]
    without = store.track(client(history), tmp_path, None)
    with_old = store.track(client(history), tmp_path, None, past_contexts=(OLD,))
    assert len(without.lines) == 1
    assert len(with_old.lines) == 2
    assert with_old.lines[0][0].lat == 54.0


def test_open_days_ask_only_the_current_identity(history, store, tmp_path: Path):
    """Nothing writes to an identity the boat no longer has."""
    history.set_positions(sail(datetime(2026, 7, 30, 10, tzinfo=UTC), 20))
    store.track(client(history), tmp_path, 1, past_contexts=(OLD,))
    assert {q["context"] for q in history.queries} == {"vessels.self"}


def test_changing_the_identity_list_does_not_reuse_days_cached_without_it(
    history, store, tmp_path: Path
):
    history.rows_by_context[OLD] = [
        [t, {"latitude": lat, "longitude": lon}]
        for t, lat, lon in sail(datetime(2026, 7, 28, 10, tzinfo=UTC), 20)
    ]
    assert store.track(client(history), tmp_path, 72).lines == []
    assert store.track(client(history), tmp_path, 72, past_contexts=(OLD,)).lines


def test_the_last_12_hours_are_every_fix_as_recorded(history, store, tmp_path: Path):
    """No stay collapse, no simplification: a boat circling in one spot is
    drawn as every fix it recorded — the user asked for exactly that."""
    start = datetime(2026, 7, 30, 10, tzinfo=UTC)
    rows = [
        (iso(datetime.fromtimestamp(start.timestamp() + 10 * i, UTC)), 55.0 + 1e-5 * (i % 3), 12.0)
        for i in range(400)
    ]
    history.set_positions(rows)
    result = store.track(client(history), tmp_path, 6)
    assert sum(len(line) for line in result.lines) == 400


def test_older_than_12_hours_is_still_collapsed(history, store, tmp_path: Path):
    start = datetime(2026, 7, 29, 10, tzinfo=UTC)
    rows = [
        (iso(datetime.fromtimestamp(start.timestamp() + 10 * i, UTC)), 55.0 + 1e-5 * (i % 3), 12.0)
        for i in range(400)
    ]
    history.set_positions(rows)
    result = store.track(client(history), tmp_path, 48)
    assert sum(len(line) for line in result.lines) <= 2


def test_the_precise_stretch_joins_the_older_track(history, store, tmp_path: Path):
    """A passage across the 12 h cutoff is one line, not two."""
    history.set_positions(sail(datetime(2026, 7, 29, 23, 30, tzinfo=UTC), 60))
    result = store.track(client(history), tmp_path, 24)
    assert len(result.lines) == 1


def test_split_recent_meets_at_one_shared_fix():
    """The segment across the cutoff is drawn once, as recent, and the two
    styles join without a gap."""
    line = [Fix(t, 55.0, 12.0 + t / 1000) for t in (0, 10, 20, 30)]
    older, recent = split_recent([line], 15)
    assert [[f.t for f in x] for x in older] == [[0, 10]]
    assert [[f.t for f in x] for x in recent] == [[10, 20, 30]]
    assert split_recent([line], -1) == ([], [line])
    assert split_recent([line], 99) == ([line], [])


def test_a_provider_with_no_history_at_all_caches_no_empty_days(history, store, tmp_path: Path):
    """An empty provider (KIP as SignalK's default, measured on the boat) is
    a fault, not a week without sailing: caching its days empty would hide
    them for good once the right provider answers."""
    assert store.track(client(history), tmp_path, 72).lines == []
    assert not list(tmp_path.rglob("2026-07-2*.json"))

    history.set_positions(sail(datetime(2026, 7, 28, 10, tzinfo=UTC), 30))
    assert store.track(client(history), tmp_path, 72).lines


def test_each_provider_has_its_own_cache(history, store, tmp_path: Path):
    history.set_positions(sail(datetime(2026, 7, 28, 10, tzinfo=UTC), 30))
    history.providers["other"] = False
    store.track(client(history), tmp_path, 72)
    other = TrackClient(history.base_url, TOKEN, provider="other")
    # "other" holds nothing: a reused cache would draw the default's day.
    assert store.track(other, tmp_path, 72).lines == []
    assert history.queries[-1]["provider"] == "other"


def test_an_empty_provider_is_probed_once_per_request(history, store, tmp_path: Path):
    store.track(client(history), tmp_path, 10 * 24)
    assert froms(history).count(wire_time(HISTORY_EPOCH)) == 1
