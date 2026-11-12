# SPDX-License-Identifier: GPL-2.0-only
"""CPA / TCPA for one target against own ship — a line-for-line port of
``frontend/src/core/cpa.ts`` (itself after OpenCPN's
``AisDecoder::UpdateOneCPA``, ais_decoder.cpp, GPLv2), so the server's alarm
and the browser's chart colouring can never disagree about the geometry.
Derivation and unit rationale: docs/architecture/cpa-math.md. Change one,
change both — ``tests/test_collision_cpa.py`` pins the same cases as
``cpa.test.ts``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

#: Nautical miles per arcmin of latitude — 1, by the definition of the nm.
_NM_PER_ARCMIN = 1.0
_ARCMIN_PER_DEG = 60.0
_MIN_PER_HOUR = 60.0

#: Divide-by-zero guard on *relative* velocity — float dust, not "stopped".
_SPEED_EPS_KN = 1e-6
#: Below this CPA the direction to the target is float dust.
_CPA_EPS_NM = 1e-9
#: AIS "speed not available" is 102.3 kn; never believe it. OpenCPN's guard.
_MAX_PLAUSIBLE_SOG_KN = 102.2
#: Half-width of the "abeam" sector, degrees of relative bearing at CPA.
_ABEAM_BAND_DEG = 15.0
#: Default at-rest SOG, OpenCPN's ``g_SOGminCOG_kts``.
MOORED_SPEED_KN = 0.2

KNOTS_PER_MS = 3600.0 / 1852.0

Risk = Literal["green", "yellow", "red", "unknown"]
Aspect = Literal["ahead", "astern", "abeam", "unknown"]
Side = Literal["port", "starboard", "unknown"]
UnknownReason = Literal[
    "position-unknown", "own-velocity-unknown", "target-velocity-unknown", "no-relative-motion"
]


@dataclass(frozen=True)
class Thresholds:
    """Red needs ``red_cpa_nm`` *and* ``red_tcpa_min``: distance alone isn't
    danger, a 0.1 nm CPA four hours out isn't an emergency yet."""

    red_cpa_nm: float
    red_tcpa_min: float
    yellow_cpa_nm: float
    yellow_tcpa_min: float


@dataclass(frozen=True)
class Motion:
    """A vessel as CPA needs it. ``cog_deg``/``sog_kn`` are optional because
    real AIS targets genuinely lack them; absence is an input, not an error."""

    lat: float | None
    lng: float | None
    cog_deg: float | None = None
    sog_kn: float | None = None


@dataclass(frozen=True)
class Unknown:
    """No CPA. Deliberately has no ``cpa_nm``: OpenCPN's ``CPA=0`` plus a
    validity flag reads a collision when the flag is forgotten."""

    reason: UnknownReason
    range_nm: float | None
    risk: Risk = "unknown"


@dataclass(frozen=True)
class Computed:
    cpa_nm: float
    #: Minutes to CPA. **Negative: it already happened** — receding, green.
    tcpa_min: float
    range_nm: float
    aspect: Aspect
    side: Side
    risk: Risk


Result = Unknown | Computed


def classify_risk(cpa_nm: float, tcpa_min: float, t: Thresholds) -> Risk:
    """NaN is unknown (it would sail through every comparison to green); a
    receding target is green unconditionally. TCPA = 0 may be red — unlike
    OpenCPN's strict ``TCPA > 0``."""
    if not math.isfinite(cpa_nm) or not math.isfinite(tcpa_min):
        return "unknown"
    if tcpa_min < 0:
        return "green"
    if cpa_nm < t.red_cpa_nm and tcpa_min <= t.red_tcpa_min:
        return "red"
    if cpa_nm < t.yellow_cpa_nm and tcpa_min <= t.yellow_tcpa_min:
        return "yellow"
    return "green"


def _has_position(v: Motion) -> bool:
    return (
        v.lat is not None
        and v.lng is not None
        and math.isfinite(v.lat)
        and math.isfinite(v.lng)
        and abs(v.lat) <= 90
        and abs(v.lng) <= 180
    )


def _wrap_lon_delta(delta_deg: float) -> float:
    return ((delta_deg + 180.0) % 360.0 + 360.0) % 360.0 - 180.0


def _plane(own: Motion, target: Motion) -> tuple[float, float]:
    """Own ship → target, nautical miles (east, north), mid-latitude plane."""
    assert own.lat is not None and own.lng is not None
    assert target.lat is not None and target.lng is not None
    mid_lat = math.radians((own.lat + target.lat) / 2)
    d_lon = _wrap_lon_delta(target.lng - own.lng)
    return (
        d_lon * _ARCMIN_PER_DEG * math.cos(mid_lat) * _NM_PER_ARCMIN,
        (target.lat - own.lat) * _ARCMIN_PER_DEG * _NM_PER_ARCMIN,
    )


def _resolve(v: Motion, at_rest_kn: float) -> tuple[float, float, bool] | None:
    """``(east, north, moving)`` knots, or ``None`` when unknowable. At rest a
    reported COG is jitter and is dropped; "no data" never reads as "at rest"."""
    sog = v.sog_kn
    if sog is None or not math.isfinite(sog) or sog < 0 or sog > _MAX_PLAUSIBLE_SOG_KN:
        return None
    if sog <= at_rest_kn:
        return 0.0, 0.0, False
    if v.cog_deg is None or not math.isfinite(v.cog_deg):
        return None
    rad = math.radians(v.cog_deg)
    return sog * math.sin(rad), sog * math.cos(rad), True


def _aspect(
    d_cpa: tuple[float, float], own_v: tuple[float, float], cpa_nm: float, at_rest_kn: float
) -> Aspect:
    """Do WE pass ahead of or astern of the target. NOT a typo: target forward
    of our beam at CPA → we pass ASTERN. See docs/architecture/cpa-math.md."""
    own_speed = math.hypot(*own_v)
    if own_speed <= at_rest_kn or cpa_nm <= _CPA_EPS_NM:
        return "unknown"
    along = (d_cpa[0] * own_v[0] + d_cpa[1] * own_v[1]) / own_speed
    cos_theta = along / cpa_nm
    if abs(cos_theta) <= math.sin(math.radians(_ABEAM_BAND_DEG)):
        return "abeam"
    return "astern" if along > 0 else "ahead"


def _side(
    d_cpa: tuple[float, float], own_v: tuple[float, float], cpa_nm: float, at_rest_kn: float
) -> Side:
    own_speed = math.hypot(*own_v)
    if own_speed <= at_rest_kn or cpa_nm <= _CPA_EPS_NM:
        return "unknown"
    cross = own_v[0] * d_cpa[1] - own_v[1] * d_cpa[0]
    return "port" if cross > 0 else "starboard"


def compute_cpa(
    own: Motion, target: Motion, thresholds: Thresholds, *, at_rest_kn: float = MOORED_SPEED_KN
) -> Result:
    """Assess one target. Pure: no clock, no globals."""
    if not _has_position(own) or not _has_position(target):
        return Unknown("position-unknown", None)
    r = _plane(own, target)
    rng = math.hypot(*r)

    own_v = _resolve(own, at_rest_kn)
    if own_v is None:
        return Unknown("own-velocity-unknown", rng)
    tgt_v = _resolve(target, at_rest_kn)
    if tgt_v is None:
        return Unknown("target-velocity-unknown", rng)

    v = (tgt_v[0] - own_v[0], tgt_v[1] - own_v[1])
    v_sq = v[0] * v[0] + v[1] * v[1]
    if v_sq <= _SPEED_EPS_KN * _SPEED_EPS_KN:
        if not own_v[2]:
            # Both at rest: no closing motion, never a threat (#CPA-MOORED-REST).
            return Computed(rng, 0.0, rng, "unknown", "unknown", "green")
        # Under way, matching the target: "closest" has no moment (#AIS-GRAY).
        return Unknown("no-relative-motion", rng)

    tcpa_h = -(r[0] * v[0] + r[1] * v[1]) / v_sq
    d_cpa = (r[0] + v[0] * tcpa_h, r[1] + v[1] * tcpa_h)
    cpa_nm = math.hypot(*d_cpa)
    tcpa_min = tcpa_h * _MIN_PER_HOUR
    own_xy = (own_v[0], own_v[1])
    return Computed(
        cpa_nm,
        tcpa_min,
        rng,
        _aspect(d_cpa, own_xy, cpa_nm, at_rest_kn),
        _side(d_cpa, own_xy, cpa_nm, at_rest_kn),
        classify_risk(cpa_nm, tcpa_min, thresholds),
    )


# -- MMSI: which "targets" are not vessels ----------------------------------
# Port of `frontend/src/core/mmsi.ts`'s `isNonVesselStation`: an AtoN, coast
# station or distress beacon reports a position (and some a course) but a CPA
# against it is meaningless — it must never raise a collision alarm.

#: SART, MOB, EPIRB, coast station, AtoN. None of these prefixes is a
#: prefix of a vessel kind's (``979`` AMRD-B, ``111`` SAR aircraft, ``98``
#: craft, ``0``/``8`` group/handheld), so no longest-first ordering is needed.
_NON_VESSEL_PREFIXES = ("970", "972", "974", "00", "99")


def is_non_vessel_station(mmsi: str | None) -> bool:
    """``False`` for an absent/malformed MMSI and every ship/aircraft kind."""
    if mmsi is None or len(mmsi) != 9 or not mmsi.isascii() or not mmsi.isdigit():
        return False
    return mmsi.startswith(_NON_VESSEL_PREFIXES)


def is_sar_aircraft(mmsi: str | None) -> bool:
    """The ``111MIDXXX`` production (AIS message 9). It moves, so it is not a
    station — but it flies: a CPA against it says nothing about collision, and
    a helicopter working the area must not set off the collision alarm."""
    if mmsi is None or len(mmsi) != 9 or not mmsi.isascii() or not mmsi.isdigit():
        return False
    return mmsi.startswith("111")
