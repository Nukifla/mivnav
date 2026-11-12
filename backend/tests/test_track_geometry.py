# SPDX-License-Identifier: GPL-2.0-only
"""Fixes → drawn lines. The claims, in the user's terms:

- the track never draws through water the boat was not seen in — a long
  gap that also moved the boat breaks the line, and so does a bad fix;
- a plugin that records sparsely is not mistaken for all gaps;
- hours at anchor or in a berth are one point, not a scribble;
- simplifying never moves the line more than its tolerance off the fixes,
  and never cuts a real turn.
"""

from __future__ import annotations

import itertools
import math
import random

from mivnav.features.track.geometry import (
    SIMPLIFY_M,
    SMOOTH_S,
    STAY_MIN_S,
    STAY_RADIUS_M,
    Fix,
    build_lines,
    collapse_stays,
    distance_m,
    is_break,
    simplify,
    split_gaps,
)

LAT0, LON0 = 55.0, 12.0
M_LAT = 1 / 111_195  # degrees per metre north
M_LON = M_LAT / math.cos(math.radians(LAT0))


def at(t: float, north_m: float = 0.0, east_m: float = 0.0) -> Fix:
    return Fix(t, LAT0 + north_m * M_LAT, LON0 + east_m * M_LON)


def leg(t0: float, seconds: float, *, speed=3.0, step=5.0, north0=0.0, east0=0.0, heading="E"):
    """A straight leg at ``speed`` m/s, a fix every ``step`` s."""
    out = []
    for i in range(int(seconds / step) + 1):
        d = i * step * speed
        n, e = (north0, east0 + d) if heading == "E" else (north0 + d, east0)
        out.append(at(t0 + i * step, n, e))
    return out


# -- gaps --------------------------------------------------------------------


def test_a_long_gap_that_moved_the_boat_breaks_the_line():
    """The user's case: a fix, then the next one much later and far away.
    Drawing the straight line would claim water nobody saw the boat in."""
    before = leg(0, 600)
    after = leg(600 + 1800, 600, east0=5000)
    lines = split_gaps(before + after)
    assert len(lines) == 2
    assert lines[0][-1] == before[-1] and lines[1][0] == after[0]


def test_a_gap_that_did_not_move_the_boat_is_not_a_break():
    """GPS off overnight in the berth: no water was skipped."""
    assert not is_break(at(0), at(8 * 3600, 10, 10))


def test_a_bad_fix_is_cut_out_not_drawn_to():
    fixes = leg(0, 300)
    glitch = at(fixes[30].t + 1, 3000, 0)
    lines = split_gaps([*fixes[:31], glitch, *fixes[31:]])
    assert all(glitch not in line for line in lines)


def test_metre_jitter_a_second_apart_is_not_a_glitch():
    assert not is_break(at(0), at(1, 20, 0))


def test_a_sparsely_recording_plugin_is_not_all_gaps():
    """A store that keeps a fix every two minutes: 360 m apart at 3 m/s,
    every one past the fixed 60 s / 100 m rule — but the spacing is the
    plugin's normal, so the threshold follows it."""
    fixes = leg(0, 3600, step=120)
    assert len(split_gaps(fixes)) == 1


# -- stays -------------------------------------------------------------------


def parked(t0: float, hours: float, *, spread=5.0, north0=0.0, east0=0.0, seed=1):
    rng = random.Random(seed)
    return [
        at(t0 + 5 * i, north0 + rng.gauss(0, spread), east0 + rng.gauss(0, spread))
        for i in range(int(hours * 720))
    ]


def points_near(out, north, east, radius=STAY_RADIUS_M):
    return [f for f in out if distance_m(f, at(0, north, east)) < radius]


def test_hours_at_anchor_collapse_to_one_place():
    """Swinging on a long scope — fixes anywhere in a 60 m box for two
    hours. One point (at its start and end time); approach and departure
    are the real fixes."""
    rng = random.Random(1)
    arrive = leg(0, 300)
    t = arrive[-1].t
    east = 930.0
    swing = [
        at(t + 5 * i, rng.uniform(-30, 30), east + rng.uniform(-30, 30)) for i in range(1, 1440)
    ]
    depart = leg(swing[-1].t + 5, 300, east0=east + 40)
    out = collapse_stays(arrive + swing + depart)
    # The hours are one point. Within a smoothing window of arriving or
    # leaving, the smoothed position still leans toward the leg — more
    # than the 20 m radius here — so those few fixes stay as they were:
    # a minute of the real approach, not hours of swing.
    fringe = SMOOTH_S
    assert any(
        a.t <= t + fringe and b.t >= swing[-1].t - fringe and (a.lat, a.lon) == (b.lat, b.lon)
        for a, b in itertools.pairwise(out)
    )
    assert len(points_near(out, 0, east, 45)) < 20
    assert out[0] == arrive[0] and out[-1] == depart[-1]


def test_a_parked_gps_with_bad_outliers_is_still_one_stay():
    """The boat on the hard with poor sky view (2026-02-12, measured):
    p90 39 m, p99 113 m, single fixes 287 m off. Median smoothing sees
    through them; a raw extent test did not, and drew a blob."""
    fixes = parked(0, 6, spread=20)
    rng = random.Random(5)
    for i in rng.sample(range(len(fixes)), 60):
        fixes[i] = at(fixes[i].t, rng.uniform(-290, 290), rng.uniform(-290, 290))
    out = collapse_stays(fixes)
    assert len({(f.lat, f.lon) for f in out}) == 1


def test_a_travel_lift_move_between_two_stays_is_not_swallowed():
    """Regression, measured on the boat (2025-11-12, 2026-03-13): parked,
    carried ~220 m at 1-1.7 kn in eight minutes, parked again. A stationary
    test chained window to window swallowed the move and drew the day as
    hours-long straight lines over land. The two places must stay two, and
    the move between them must be the carried path."""
    before = parked(0, 3)
    move = leg(before[-1].t + 5, 480, speed=0.46, step=10, east0=0)
    after = parked(move[-1].t + 5, 3, east0=220)
    out = collapse_stays(before + move + after)
    home, lift = points_near(out, 0, 0, 30), points_near(out, 0, 220, 30)
    assert home and lift
    # Nothing drawn between the stays except the carried path's own fixes.
    between = [f for f in out if home[-1].t < f.t < lift[0].t]
    assert all(f in move for f in between)
    # And no segment spans the hours of either stay while moving far.
    for a, b in zip(out, out[1:], strict=False):
        assert not (b.t - a.t > 1800 and distance_m(a, b) > 30)


def test_a_stay_survives_a_wander_across_a_dropout():
    """The hall (2026-02-15, measured): GPS stops for up to an hour and
    comes back biased 100-170 m for a quarter of an hour, then settles. Same
    place all day — one stay, not a scribble of excursions."""
    a = parked(0, 5, spread=8)
    bias = parked(a[-1].t + 1800, 0.25, spread=8, east0=165)
    b = parked(bias[-1].t + 1200, 8, spread=8)
    out = collapse_stays(a + bias + b)
    assert len({(f.lat, f.lon) for f in out}) == 1


def test_a_real_trip_away_is_not_rejoined():
    """Leaving the berth and coming back to it hours later is a trip, not
    an excursion — beyond EXCURSION_M, so it stays on the chart."""
    a = parked(0, 2)
    out_leg = leg(a[-1].t + 5, 1200, speed=3.0)
    back = [at(out_leg[-1].t + 5 * (i + 1), 0, 3600 - 15 * (i + 1)) for i in range(240)]
    b = parked(back[-1].t + 5, 2)
    out = collapse_stays(a + out_leg + back + b)
    assert max(distance_m(at(0), f) for f in out) > 3000


def test_slow_motoring_is_not_a_stay():
    """1 kn across a harbour leaves the stay radius long before the stay
    time: it must stay a track, since that is where the detail matters."""
    fixes = leg(0, 1800, speed=0.5)
    assert collapse_stays(fixes) == fixes


def test_a_data_gap_is_not_mistaken_for_a_stay():
    """Two fixes ten minutes apart in the same place say nothing about the
    time between; only fixes that span the time can prove a stay."""
    fixes = [at(0), at(5, 0, 10), at(700, 0, 120), at(705, 0, 130)]
    assert collapse_stays(fixes) == fixes


def test_the_stay_thresholds_are_what_the_docs_say():
    assert STAY_RADIUS_M == 20 and STAY_MIN_S == 600


# -- simplification ----------------------------------------------------------


def test_a_straight_leg_is_two_points():
    fixes = leg(0, 3600)
    assert simplify(fixes) == [fixes[0], fixes[-1]]


def test_a_turn_is_kept():
    out_leg = leg(0, 600)
    up_leg = leg(605, 600, east0=1800, heading="N")
    simplified = simplify(out_leg + up_leg)
    assert out_leg[-1] in simplified and len(simplified) == 3


def test_an_out_and_back_leg_is_not_folded_onto_its_chord():
    """Distance to the segment, not the line: a leg out and straight back
    has start and end in the same place, and its far end must survive."""
    out = leg(0, 600)
    back = [at(out[-1].t + (i + 1) * 5, 0, 1800 - (i + 1) * 15) for i in range(120)]
    simplified = simplify(out + back)
    assert out[-1] in simplified


def _to_segment_m(p: Fix, a: Fix, b: Fix) -> float:
    k = math.cos(math.radians(LAT0))

    def xy(f: Fix) -> tuple[float, float]:
        return (f.lon * k / M_LAT, f.lat / M_LAT)

    (px, py), (ax, ay), (bx, by) = xy(p), xy(a), xy(b)
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def test_no_fix_ends_up_further_than_the_tolerance_from_the_line():
    """The guarantee that makes the drawn line trustworthy for "I have been
    here": every real fix is within SIMPLIFY_M of what is drawn."""
    rng = random.Random(7)
    fixes, n, e, h = [], 0.0, 0.0, 0.0
    for i in range(3000):
        h += rng.gauss(0, 0.08)
        n, e = n + 15 * math.cos(h), e + 15 * math.sin(h)
        fixes.append(at(i * 5, n, e))
    simplified = simplify(fixes)
    assert len(simplified) < len(fixes) / 3
    index = {f: i for i, f in enumerate(fixes)}
    for a, b in itertools.pairwise(simplified):
        for p in fixes[index[a] : index[b] + 1]:
            assert _to_segment_m(p, a, b) <= SIMPLIFY_M + 0.05


def test_build_lines_runs_all_three():
    before = leg(0, 600)
    after = leg(3000, 600, east0=5000)
    lines = build_lines(before + after)
    assert [len(line) for line in lines] == [2, 2]
    assert distance_m(lines[0][-1], lines[1][0]) > 1000
