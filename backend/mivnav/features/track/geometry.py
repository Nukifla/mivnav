# SPDX-License-Identifier: GPL-2.0-only
"""Raw fixes → the lines a chart draws. Pure: no I/O, no clock.

Three passes, in this order, over one day's fixes (oldest first):

1. :func:`collapse_stays` — hours at anchor, in a berth or on the hard
   become one point. That is noise for "where have I been", and it is most
   of a cruising boat's fixes. Run FIRST, on the whole day: a parked GPS
   with poor sky view drops out and scatters, and cutting at those
   dropouts before this pass would leave pieces too short to recognise.
2. :func:`split_gaps` — a line never bridges a stretch with no fixes that
   also moved the boat somewhere else. A track is a record of water the
   boat has actually been in; a straight line across a data gap would
   claim water nobody sailed.
3. :func:`simplify` — Douglas–Peucker at a metre: points on a
   straight leg go, every turn stays, and no part of the line moves more
   than the tolerance off the fixes.

See docs/architecture/track-route.md for why each threshold is what it is.
"""

from __future__ import annotations

import itertools
import math
from statistics import median
from typing import NamedTuple

#: A gap longer than this (or 3× the median fix spacing, if the history
#: plugin records sparsely) may break the line — see :func:`split_gaps`.
GAP_S = 60.0

#: …but only if the boat also moved at least this far across it: a GPS
#: that was off overnight at the berth is not a hole in the record.
GAP_M = 100.0

#: Faster than any sailing boat, so a hop this fast is a bad fix, not
#: sailing. Applied only beyond :data:`GLITCH_MIN_M` so metre-scale jitter
#: between fixes a second apart is not mistaken for a 40-knot hop.
MAX_SPEED_MS = 30 * 1852 / 3600
GLITCH_MIN_M = 50.0

#: Stationarity is judged on positions smoothed by a running median over
#: ±this many seconds. Measured on the boat parked on the hard with poor
#: sky view (2026-02-12): raw fixes p90 39 m, p99 113 m, max 287 m off —
#: single bad fixes that a raw extent test cannot see past.
SMOOTH_S = 60.0

#: A stay: smoothed positions within this radius of the stay's first one
#: for at least :data:`STAY_MIN_S`. Measured from ONE anchor point, never
#: chained window to window — a chained test swallowed a 220 m travel-lift
#: move between two stays (2025-11-12, 2026-03-13) and drew it as hours-
#: long straight lines over land. 20 m, not the first 60 m: 60 m folded
#: slow harbour manoeuvring into the berth, 30-77 m off where the boat
#: really went (2026-07-17, 09-25, 09-27). At 20 m those days are within
#: 7-18 m worst case (p99 ~1 m), while hall, berth and anchorage days
#: (2026-02-12, 04-08, 08-26) still collapse to their 2 points — the
#: excursion rule below, not the radius, is what holds a scattering GPS.
STAY_RADIUS_M = 20.0

#: Long enough that 0.1 kn of real movement leaves the radius first.
STAY_MIN_S = 600.0

#: A stay survives an excursion outside its radius if the boat is back
#: inside within this long and never went further than
#: :data:`EXCURSION_M`. A GPS under a roof wanders out for many minutes at a
#: time even after smoothing — measured in a boat hall, 2026-01-20 to
#: 02-16: hourly medians steady, excursions of 150-300 m for up to ~10
#: min. A real departure goes further, or does not come back this soon.
EXCURSION_S = 900.0
EXCURSION_M = 300.0

#: Two stays at the same place (centres within :data:`STAY_RADIUS_M`) with
#: everything between them inside :data:`EXCURSION_M` are one stay if the
#: second starts within this long of the first ending. Needed because the
#: same hall's GPS also drops out for 30-70 min at a time, so an excursion
#: straddling a dropout cannot "come back within EXCURSION_S" by the clock.
REJOIN_S = 7200.0

#: Douglas–Peucker tolerance: no drawn line is further than this from the
#: fixes it replaces. 1 m, not 5: the track is read for "exactly where did
#: I go", and a sailing day is still only ~500 points.
SIMPLIFY_M = 1.0

_EARTH_M = 6_371_008.8


class Fix(NamedTuple):
    """``t`` is Unix seconds (UTC)."""

    t: float
    lat: float
    lon: float


def distance_m(a: Fix, b: Fix) -> float:
    """Equirectangular — exact enough at the few-km spacings this sees."""
    x = math.radians(b.lon - a.lon) * math.cos(math.radians((a.lat + b.lat) / 2))
    y = math.radians(b.lat - a.lat)
    return math.hypot(x, y) * _EARTH_M


def is_break(a: Fix, b: Fix, gap_s: float = GAP_S) -> bool:
    """Whether the line must NOT be drawn from ``a`` to ``b``."""
    dt = b.t - a.t
    d = distance_m(a, b)
    if dt > gap_s and d > GAP_M:
        return True
    return d > GLITCH_MIN_M and d > MAX_SPEED_MS * max(dt, 1.0)


def gap_threshold(fixes: list[Fix]) -> float:
    """:data:`GAP_S`, or 3× the plugin's median fix spacing if that is
    longer, so a store that records every two minutes is not all gaps."""
    if len(fixes) < 2:
        return GAP_S
    return max(GAP_S, 3 * median(b.t - a.t for a, b in itertools.pairwise(fixes)))


def split_gaps(fixes: list[Fix], gap_s: float | None = None) -> list[list[Fix]]:
    """``fixes`` cut wherever :func:`is_break` says (threshold from
    :func:`gap_threshold` unless given). A one-fix piece — a lone glitch,
    typically — is dropped: it draws nothing."""
    if len(fixes) < 2:
        return []
    if gap_s is None:
        gap_s = gap_threshold(fixes)
    lines: list[list[Fix]] = [[fixes[0]]]
    for a, b in itertools.pairwise(fixes):
        if is_break(a, b, gap_s):
            lines.append([b])
        else:
            lines[-1].append(b)
    return [line for line in lines if len(line) >= 2]


def smooth(fixes: list[Fix], half_window_s: float = SMOOTH_S) -> list[Fix]:
    """Running median of lat and lon over ±``half_window_s`` — strips
    isolated bad fixes, keeps anything the boat actually did for longer
    than a minute."""
    out = []
    lo = hi = 0
    n = len(fixes)
    for f in fixes:
        while fixes[lo].t < f.t - half_window_s:
            lo += 1
        while hi < n and fixes[hi].t <= f.t + half_window_s:
            hi += 1
        window = fixes[lo:hi]
        out.append(Fix(f.t, median(w.lat for w in window), median(w.lon for w in window)))
    return out


def collapse_stays(fixes: list[Fix]) -> list[Fix]:
    """Each stay replaced by one point — the median of its fixes, robust to
    the bad ones — repeated at the stay's first and last time, so gap rules
    downstream measure from when the boat actually left.

    Greedy from each candidate's first (smoothed) position: the stay grows
    while smoothed positions stay within :data:`STAY_RADIUS_M` of it, and
    once it is a stay, through excursions that come back within
    :data:`EXCURSION_S` without going beyond :data:`EXCURSION_M`. Then
    stays at the same place are rejoined across whatever came between them
    (see :data:`REJOIN_S`). A swing circle wider than the radius becomes a
    few nearby stays, not a scribble."""
    n = len(fixes)
    if n < 3:
        return list(fixes)
    sm = smooth(fixes)
    # Items: a stay is a list of fixes, a loose fix is a Fix.
    items: list[list[Fix] | Fix] = []
    i = 0
    while i < n:
        j = i + 1
        # Measured from the first smoothed position until the stay is one,
        # then from its median: the first position still leans toward the
        # approach (the smoothing window straddles it).
        anchor = sm[i]
        settled = False
        while j < n:
            if not settled and fixes[j - 1].t - fixes[i].t >= STAY_MIN_S:
                anchor, settled = _centre(fixes[i:j]), True
            if distance_m(anchor, sm[j]) <= STAY_RADIUS_M:
                j += 1
                continue
            # Outside: absorb the excursion if the boat is back soon without
            # going far — but only for a stay already long enough to be
            # one, so an approach is never extended through its berth.
            if fixes[j - 1].t - fixes[i].t < STAY_MIN_S:
                break
            k = j
            back = False
            while k < n and fixes[k].t - fixes[j].t <= EXCURSION_S:
                d = distance_m(anchor, sm[k])
                if d > EXCURSION_M:
                    break
                if d <= STAY_RADIUS_M:
                    back = True
                    break
                k += 1
            if not back:
                break
            j = k + 1
        if fixes[j - 1].t - fixes[i].t >= STAY_MIN_S:
            items.append(fixes[i:j])
            i = j
        else:
            items.append(fixes[i])
            i += 1
    return [f for item in _rejoin(items) for f in _emit(item)]


def _centre(run: list[Fix]) -> Fix:
    return Fix(run[0].t, median(f.lat for f in run), median(f.lon for f in run))


def _rejoin(items: list[list[Fix] | Fix]) -> list[list[Fix] | Fix]:
    """Merge each stay with the furthest later stay at the same place that
    :data:`REJOIN_S` allows, provided nothing between strayed beyond
    :data:`EXCURSION_M`."""
    out: list[list[Fix] | Fix] = []
    a = 0
    while a < len(items):
        item = items[a]
        if not isinstance(item, list):
            out.append(item)
            a += 1
            continue
        centre = _centre(item)
        merged, best = list(item), a
        between: list[Fix] = []
        for b in range(a + 1, len(items)):
            nxt = items[b]
            first = nxt[0] if isinstance(nxt, list) else nxt
            if first.t - merged[-1].t > REJOIN_S:
                break
            if isinstance(nxt, list) and distance_m(centre, _centre(nxt)) <= STAY_RADIUS_M:
                merged += between + nxt
                between, best = [], b
                continue
            probe = _centre(nxt) if isinstance(nxt, list) else nxt
            if distance_m(centre, probe) > EXCURSION_M:
                break
            between += nxt if isinstance(nxt, list) else [nxt]
        out.append(merged)
        a = best + 1
    return out


def _emit(item: list[Fix] | Fix) -> list[Fix]:
    if not isinstance(item, list):
        return [item]
    c = _centre(item)
    return [c, Fix(item[-1].t, c.lat, c.lon)]


def simplify(fixes: list[Fix], tolerance_m: float = SIMPLIFY_M) -> list[Fix]:
    """Douglas–Peucker, iterative (a day of fixes would blow the recursion
    limit), in a local metric projection around the line's mean latitude."""
    n = len(fixes)
    if n < 3:
        return list(fixes)
    k = math.cos(math.radians(sum(f.lat for f in fixes) / n))
    xy = [(math.radians(f.lon) * k * _EARTH_M, math.radians(f.lat) * _EARTH_M) for f in fixes]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        first, last = stack.pop()
        (ax, ay), (bx, by) = xy[first], xy[last]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        worst, worst_d = -1, tolerance_m
        for i in range(first + 1, last):
            px, py = xy[i]
            if length == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                # Distance to the segment, not the infinite line: an
                # out-and-back leg must not fold onto its own chord.
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (length * length)))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > worst_d:
                worst, worst_d = i, d
        if worst >= 0:
            keep[worst] = True
            stack.append((first, worst))
            stack.append((worst, last))
    return [f for f, kept in zip(fixes, keep, strict=True) if kept]


def build_lines(fixes: list[Fix]) -> list[list[Fix]]:
    """All three passes. ``fixes`` oldest first. The gap threshold is taken
    from the raw fixes: after collapsing, spacing no longer reflects how
    often the plugin records."""
    gap_s = gap_threshold(fixes)
    lines = []
    for piece in split_gaps(collapse_stays(fixes), gap_s):
        line = simplify(piece)
        if len(line) >= 2:
            lines.append(line)
    return lines
