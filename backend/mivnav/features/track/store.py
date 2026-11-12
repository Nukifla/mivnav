# SPDX-License-Identifier: GPL-2.0-only
"""The track, assembled from UTC days: fine fixes from SignalK, turned into
lines once per finished day and kept on disk.

Why days: a past day never changes, so its lines are computed once and
every later request — any window, any device — is a file read. Only the
days still being written (today, and yesterday for :data:`SETTLE_S` after
midnight, for plugins that flush late) are asked of SignalK again, and
those incrementally: only fixes newer than the last ones held.

This is a **cache of SignalK's answers, not a recording** — every file is
rebuildable from the history plugin (delete the directory and it is), and
nothing is written for a time SignalK has no fixes for. It does outlive the
plugin's own retention, which for a "where have I been" chart is a feature.
See docs/architecture/track-route.md.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from mivnav.features.track.client import SELF_CONTEXT, TrackClient, TrackUnavailable
from mivnav.features.track.geometry import Fix, build_lines, is_break, split_gaps

log = logging.getLogger(__name__)

#: Bucket width asked of SignalK for real track data. ~15 m apart at 6 kn:
#: finer than any hazard a chart shows, and 1/5 of a 1 Hz store's rows.
FINE_RESOLUTION_S = 5

#: The last this-many hours are every fix the plugin holds, as recorded:
#: no stay collapse, no simplification — only lines broken at holes. User
#: (2026-10-03): "perfect precision the last 12 hours, i do not care about
#: lots of lines in the same spot". Older track is the day cache's lines.
PRECISE_HOURS = 12.0

#: Narrower than any plugin's recording rate, so every stored row comes
#: back. Measured on the boat: 12 h of a sailing day is ~3800 rows, 0.2 s.
RAW_RESOLUTION_S = 1

#: How long after midnight a day is still re-fetched instead of cached —
#: a history plugin may buffer writes before they are queryable.
SETTLE_S = 3600.0

#: Re-asked on each incremental fetch of a live day, so a fix that landed
#: in the plugin late is not missed.
OVERLAP_S = 120.0

#: Wall time one request may spend fetching uncached past days before it
#: answers with what it has (``complete: false``) — the UI asks again at
#: once, so "forever" on a new box fills in newest-first over a few polls
#: instead of one request timing out.
FETCH_BUDGET_S = 8.0

#: Where a first-fix probe starts: before any SignalK install existed.
HISTORY_EPOCH = datetime(2010, 1, 1, tzinfo=UTC)

#: Probe bucket widths: weekly to find where history starts, daily to find
#: which days of a window have any fixes at all (the rest cost nothing).
FIRST_FIX_PROBE_S = 7 * 86400
DAY_PROBE_S = 86400

#: Bump when anything in :mod:`mivnav.features.track.geometry` changes the
#: lines a day yields — old files are then simply not read. 4: drops the
#: days v3 cached empty while KIP's empty provider was SignalK's default
#: (see :mod:`mivnav.features.track.config`).
CACHE_VERSION = 4

_DAY = timedelta(days=1)


@dataclass(frozen=True)
class TrackResult:
    """The lines, oldest first, each a list of fixes."""

    lines: list[list[Fix]]
    start: datetime | None
    end: datetime
    #: False when the fetch budget ran out with past days still unfetched.
    complete: bool


class _Sources:
    """The client, asked once per context of this boat and merged by time.
    Past contexts are skipped for still-open days: nothing writes to an
    identity the boat no longer has."""

    def __init__(self, client: TrackClient, past_contexts: tuple[str, ...]) -> None:
        self.client = client
        self.past_contexts = past_contexts

    def values(
        self,
        start: datetime,
        end: datetime,
        resolution_s: int,
        *,
        past: bool = True,
        quality: bool = True,
    ) -> list[Fix]:
        contexts = (SELF_CONTEXT, *self.past_contexts) if past else (SELF_CONTEXT,)
        merged: dict[float, Fix] = {}
        for context in contexts:
            for f in self.client.values(start, end, resolution_s, context=context, quality=quality):
                merged.setdefault(f.t, f)
        return [merged[t] for t in sorted(merged)]


def _day_start(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=UTC)


class TrackStore:
    """One per process. Serialises requests (several screens may poll at
    once; two concurrent builds of the same day would only double the
    load on the box)."""

    def __init__(self, *, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        #: Raw fixes of days not yet settled, by (server dir, day).
        self._live: dict[tuple[Path, date], list[Fix]] = {}
        #: Raw fixes of the last :data:`PRECISE_HOURS`, by server dir.
        self._recent: dict[Path, list[Fix]] = {}
        #: Server dirs whose provider has been seen to hold any fix at all.
        self._has_history: set[Path] = set()

    def track(
        self,
        client: TrackClient,
        root: Path,
        hours: float | None,
        *,
        past_contexts: tuple[str, ...] = (),
        budget_s: float = FETCH_BUDGET_S,
    ) -> TrackResult:
        """The last ``hours`` of track, or all of it with ``hours=None``,
        merged across this boat's current and ``past_contexts`` identities.
        Raises the client's :class:`~mivnav.features.track.client.TrackError`s."""
        with self._lock:
            return self._track(_Sources(client, past_contexts), root, hours, budget_s)

    def _track(
        self, src: _Sources, root: Path, hours: float | None, budget_s: float
    ) -> TrackResult:
        client = src.client
        if client.base_url is None:
            raise TrackUnavailable(
                "SignalK is disabled in this server's configuration, so there "
                "is no history to read the vessel's track from"
            )
        now = datetime.fromtimestamp(self._clock(), UTC)
        # Per server, provider and set of identities: a different box or
        # provider is a different store, and a changed context list must not
        # be answered from days cached without it. No provider keys as before.
        provider = () if client.provider is None else (f"provider={client.provider}",)
        key = "\n".join((client.base_url, *provider, *sorted(src.past_contexts)))
        digest = hashlib.sha1(key.encode()).hexdigest()[:12]
        server_dir = root / digest / f"v{CACHE_VERSION}"

        if hours is None:
            first = self._first_day(src, server_dir, now)
            if first is None:
                return TrackResult([], None, now, True)
            start = _day_start(first)
        else:
            start = now - timedelta(hours=hours)

        cutoff = now.timestamp() - PRECISE_HOURS * 3600
        precise = split_gaps(self._recent_fixes(src, server_dir, now))

        days = []
        d = start.date()
        # The day cache only for what is older than the precise stretch.
        while d <= now.date() and start.timestamp() < cutoff:
            days.append(d)
            d += _DAY
        settled = {d for d in days if now >= _day_start(d) + _DAY + timedelta(seconds=SETTLE_S)}
        for key in [k for k in self._live if k[0] == server_dir and k[1] in settled]:
            del self._live[key]

        by_day: dict[date, list[list[Fix]]] = {}
        uncached: list[date] = []
        for d in days:
            if d in settled:
                cached = _load(server_dir / f"{d.isoformat()}.json")
                if cached is None:
                    uncached.append(d)
                else:
                    by_day[d] = cached
            else:
                by_day[d] = build_lines(self._live_fixes(src, server_dir, d, now))

        complete = True
        if uncached:
            deadline = time.monotonic() + budget_s
            if len(uncached) > 1:
                maybe = self._days_with_fixes(src, uncached)
                if maybe:
                    self._has_history.add(server_dir)
            else:
                maybe = set(uncached)
            if precise:
                self._has_history.add(server_dir)
            holds: list[bool] = []  # asked at most once per request

            def save(d: date, lines: list[list[Fix]]) -> None:
                # An empty day only once the provider is known to hold *some*
                # history. One with none (an empty provider that became
                # SignalK's default, a wiped store) is a fault, not days
                # without sailing — cached, it would hide them for good.
                if not lines:
                    if not holds:
                        holds.append(self._holds_history(src, server_dir, now))
                    if not holds[0]:
                        return
                _save(server_dir / f"{d.isoformat()}.json", lines)

            fetched_one = False
            for d in reversed(uncached):  # newest first: the part most likely wanted
                if d not in maybe:
                    by_day[d] = []
                    save(d, [])
                    continue
                if fetched_one and time.monotonic() > deadline:
                    complete = False
                    continue
                fixes = src.values(_day_start(d), _day_start(d) + _DAY, FINE_RESOLUTION_S)
                fetched_one = True
                by_day[d] = build_lines(fixes)
                save(d, by_day[d])

        older = [[f for f in line if f.t < cutoff] for line in _join(by_day.get(d, []) for d in days)]
        lines = _join([[line for line in older if line], precise])
        return TrackResult(_clip(lines, start.timestamp()), start, now, complete)

    def _holds_history(self, src: _Sources, server_dir: Path, now: datetime) -> bool:
        """Whether this provider has any fix, ever — one coarse probe,
        remembered once true (history is not un-recorded)."""
        if server_dir not in self._has_history and src.values(
            HISTORY_EPOCH, now + _DAY, FIRST_FIX_PROBE_S, quality=False
        ):
            self._has_history.add(server_dir)
        return server_dir in self._has_history

    def _recent_fixes(self, src: _Sources, server_dir: Path, now: datetime) -> list[Fix]:
        """Every fix of the last :data:`PRECISE_HOURS`, fetching only what is
        newer than the ones held (with :data:`OVERLAP_S` of slack). Current
        identity only, like an open day: nothing writes to an old one."""
        cutoff = now.timestamp() - PRECISE_HOURS * 3600
        held = [f for f in self._recent.get(server_dir, []) if f.t >= cutoff]
        since = max(cutoff, held[-1].t - OVERLAP_S) if held else cutoff
        fresh = src.values(
            datetime.fromtimestamp(since, UTC),
            now + timedelta(minutes=1),
            RAW_RESOLUTION_S,
            past=False,
        )
        merged = [f for f in held if f.t < since] + fresh
        self._recent[server_dir] = merged
        return merged

    def _live_fixes(self, src: _Sources, server_dir: Path, d: date, now: datetime) -> list[Fix]:
        """A still-open day's fixes, fetching only what is newer than the
        ones held (with :data:`OVERLAP_S` of slack for late writes)."""
        key = (server_dir, d)
        held = self._live.get(key, [])
        since = _day_start(d)
        if held:
            since = max(since, datetime.fromtimestamp(held[-1].t - OVERLAP_S, UTC))
        fresh = src.values(
            since,
            min(_day_start(d) + _DAY, now + timedelta(minutes=1)),
            FINE_RESOLUTION_S,
            past=False,
        )
        cut = since.timestamp()
        merged = [f for f in held if f.t < cut] + fresh
        self._live[key] = merged
        return merged

    def _days_with_fixes(self, src: _Sources, days: list[date]) -> set[date]:
        """Days that may hold fixes, from one daily-bucket query. Each hit
        also marks its neighbours: a provider may label a bucket by its
        start, its end or its first fix, and a wrongly skipped day would be
        cached empty for good, while a wrongly fetched one costs a query."""
        found = src.values(
            _day_start(days[0]) - _DAY,
            _day_start(days[-1]) + 2 * _DAY,
            DAY_PROBE_S,
            quality=False,
        )
        maybe: set[date] = set()
        for f in found:
            d = datetime.fromtimestamp(f.t, UTC).date()
            maybe.update((d - _DAY, d, d + _DAY))
        return maybe

    def _first_day(self, src: _Sources, server_dir: Path, now: datetime) -> date | None:
        """The first day with any fix, remembered once found. Not cached
        when there is none yet: logging may start tomorrow."""
        meta = server_dir / "meta.json"
        try:
            first = date.fromisoformat(json.loads(meta.read_text())["first_day"])
        except (OSError, ValueError, KeyError, TypeError):
            pass
        else:
            self._has_history.add(server_dir)
            return first
        found = src.values(HISTORY_EPOCH, now + _DAY, FIRST_FIX_PROBE_S, quality=False)
        if not found:
            return None
        self._has_history.add(server_dir)
        # One probe bucket back, whichever edge of it the provider labelled.
        first = datetime.fromtimestamp(found[0].t, UTC).date() - timedelta(
            seconds=FIRST_FIX_PROBE_S
        )
        _write_json(meta, {"first_day": first.isoformat()})
        return first


def split_recent(
    lines: list[list[Fix]], cutoff_t: float
) -> tuple[list[list[Fix]], list[list[Fix]]]:
    """``(older, recent)``: each line cut at ``cutoff_t``. A line crossing
    the cutoff yields a piece on each side sharing the fix at the cut, so
    the two draw as one continuous line in two styles."""
    older: list[list[Fix]] = []
    recent: list[list[Fix]] = []
    for line in lines:
        k = next((i for i, f in enumerate(line) if f.t >= cutoff_t), len(line))
        older.append(line[:k])
        # From the last older fix, so the segment across the cutoff is
        # drawn once — as recent — and the two pieces meet.
        recent.append(line[max(k - 1, 0) :] if k < len(line) else [])
    return (
        [line for line in older if len(line) >= 2],
        [line for line in recent if len(line) >= 2],
    )


def _join(days: Iterable[list[list[Fix]]]) -> list[list[Fix]]:
    """Concatenate days' lines, re-joining a line that crossed midnight."""
    out: list[list[Fix]] = []
    for lines in days:
        for line in lines:
            if out and not is_break(out[-1][-1], line[0]):
                out[-1] = out[-1] + line
            else:
                out.append(line)
    return out


def _clip(lines: list[list[Fix]], start_t: float) -> list[list[Fix]]:
    clipped = [[f for f in line if f.t >= start_t] for line in lines]
    return [line for line in clipped if len(line) >= 2]


def _load(path: Path) -> list[list[Fix]] | None:
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        log.warning("unreadable track cache %s, refetching: %s", path, e)
        return None
    try:
        return [
            [Fix(float(t), float(lat), float(lon)) for t, lat, lon in line] for line in raw["lines"]
        ]
    except (KeyError, TypeError, ValueError) as e:
        log.warning("malformed track cache %s, refetching: %s", path, e)
        return None


def _save(path: Path, lines: list[list[Fix]]) -> None:
    _write_json(
        path,
        {"lines": [[[int(f.t), round(f.lat, 7), round(f.lon, 7)] for f in line] for line in lines]},
    )


def _write_json(path: Path, payload: object) -> None:
    """Atomic: a reader never sees half a day."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")))
    tmp.replace(path)
