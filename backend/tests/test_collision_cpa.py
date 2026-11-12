# SPDX-License-Identifier: GPL-2.0-only
"""The server's CPA port (:mod:`mivnav.collision.cpa`) against the hand-
checkable answers ``frontend/src/core/cpa.test.ts`` pins — the alarm moved
here, so the safety cases have to hold here too. The port was also checked
differentially against ``cpa.ts`` (20 000 random cases, every branch, zero
mismatches) when it was written; these are the cases a reader can verify.
"""

from __future__ import annotations

import math

import pytest

from mivnav.collision.cpa import (
    Computed,
    Motion,
    Thresholds,
    Unknown,
    classify_risk,
    compute_cpa,
    is_non_vessel_station,
)

T = Thresholds(red_cpa_nm=0.5, red_tcpa_min=20, yellow_cpa_nm=1, yellow_tcpa_min=30)
LAT = 0.0  # on the equator 1 arcmin of longitude is 1 nm too


def own(cog: float | None = 0, sog: float | None = 10) -> Motion:
    return Motion(LAT, 0.0, cog, sog)


def at(east_nm: float, north_nm: float, cog: float | None, sog: float | None) -> Motion:
    """A target ``east_nm``/``north_nm`` from own ship."""
    return Motion(LAT + north_nm / 60, east_nm / 60, cog, sog)


def computed(result: object) -> Computed:
    assert isinstance(result, Computed), result
    return result


def test_head_on_known_answer() -> None:
    # 10 nm apart, closing 10 kn each: CPA 0, TCPA 30 min, aspect unknown.
    r = computed(compute_cpa(own(), at(0, 10, 180, 10), T))
    assert r.cpa_nm == pytest.approx(0, abs=1e-6)
    assert r.tcpa_min == pytest.approx(30, rel=1e-6)
    assert r.range_nm == pytest.approx(10, rel=1e-6)
    assert r.aspect == "unknown"
    # Outside the 20-min red window, on the edge of the (inclusive) 30-min
    # yellow one: the thresholds talking, not the engine.
    assert r.risk == "yellow"
    wide = Thresholds(2, 45, 3, 60)
    assert computed(compute_cpa(own(), at(0, 10, 180, 10), wide)).risk == "red"


@pytest.mark.parametrize(
    ("east", "north", "aspect"),
    [(10, 5, "ahead"), (5, 10, "astern")],  # the sign that is easy to get backwards
)
def test_crossing_aspect(east: float, north: float, aspect: str) -> None:
    r = computed(compute_cpa(own(), at(east, north, 270, 10), T))
    assert r.tcpa_min == pytest.approx(45, rel=1e-6)
    # 1e-5: `at` offsets north too, so the mid-latitude plane's cos is a hair off 1.
    assert r.cpa_nm == pytest.approx(math.sqrt(12.5), rel=1e-5)
    assert r.aspect == aspect


def test_overtaking_is_abeam_at_track_separation() -> None:
    r = computed(compute_cpa(own(0, 5), at(0.5, -2, 0, 10), T))
    assert r.tcpa_min == pytest.approx(24, rel=1e-6)
    assert r.cpa_nm == pytest.approx(0.5, rel=1e-6)
    assert r.aspect == "abeam"
    assert r.side == "starboard"


def test_receding_target_is_green_even_at_tiny_cpa() -> None:
    r = computed(compute_cpa(own(), at(0.01, -1, 0, 5), T))
    assert r.tcpa_min < 0
    assert r.risk == "green"


def test_both_at_rest_is_green_never_red() -> None:
    r = computed(compute_cpa(own(None, 0.03), at(0.05, 0, None, 0), T))
    assert r.risk == "green"
    assert r.cpa_nm == pytest.approx(r.range_nm)


def test_moving_toward_stopped_target_is_red() -> None:
    assert computed(compute_cpa(own(0, 6), at(0, 0.5, None, 0), T)).risk == "red"


@pytest.mark.parametrize(
    ("o", "t", "reason"),
    [
        (Motion(math.nan, 0), at(0, 1, 0, 5), "position-unknown"),
        (Motion(None, None), at(0, 1, 0, 5), "position-unknown"),
        (own(None, 6), at(0, 1, 0, 5), "own-velocity-unknown"),
        (own(0, None), at(0, 1, 0, 5), "own-velocity-unknown"),
        (own(), at(0, 1, None, None), "target-velocity-unknown"),
        (own(), at(0, 1, 0, 102.3), "target-velocity-unknown"),  # AIS "n/a"
        (own(0, 6), at(0.1, 0, 0, 6), "no-relative-motion"),
    ],
)
def test_unknown_is_never_green(o: Motion, t: Motion, reason: str) -> None:
    r = compute_cpa(o, t, T)
    assert isinstance(r, Unknown)
    assert r.reason == reason
    assert r.risk == "unknown"


def test_collision_across_the_antimeridian_is_red() -> None:
    o = Motion(0.0, 179.99, 90, 10)
    t = Motion(0.0, -179.99, 270, 10)
    assert computed(compute_cpa(o, t, T)).risk == "red"


def test_classify_risk_boundaries() -> None:
    assert classify_risk(0.4, 20, T) == "red"  # TCPA inclusive
    assert classify_risk(0.5, 10, T) == "yellow"  # CPA exclusive
    assert classify_risk(0.4, 0, T) == "red"  # closest approach is now
    assert classify_risk(math.nan, 5, T) == "unknown"
    assert classify_risk(0.1, -1, T) == "green"


@pytest.mark.parametrize(
    ("mmsi", "expected"),
    [
        ("992351234", True),  # AtoN
        ("002111234", True),  # coast station
        ("970123456", True),  # SART
        ("972123456", True),  # MOB
        ("974123456", True),  # EPIRB
        ("265123456", False),  # a ship
        ("979123456", False),  # AMRD-B moves
        ("111219500", False),  # SAR aircraft keeps its risk treatment
        ("982651234", False),  # craft associated with a parent ship
        ("026511111", False),  # group call
        ("99235123", False),  # eight digits: damaged, not an AtoN
        (None, False),
    ],
)
def test_non_vessel_stations(mmsi: str | None, expected: bool) -> None:
    assert is_non_vessel_station(mmsi) is expected
