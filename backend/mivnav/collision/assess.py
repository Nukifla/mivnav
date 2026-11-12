# SPDX-License-Identifier: GPL-2.0-only
"""Every target against own ship, once per snapshot: the ``collision`` key
the browser's ``ais.cpa`` instrument and :class:`.publisher.CollisionPublisher`
both read. One assessment, so a screen and the MFD can't disagree.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from mivnav.collision.cpa import (
    KNOTS_PER_MS,
    Computed,
    Motion,
    Thresholds,
    compute_cpa,
    is_non_vessel_station,
    is_sar_aircraft,
)

if TYPE_CHECKING:
    # Type-only: `mivnav.config.model` imports `collision.config`, so a
    # runtime import here would be circular for whoever imports us first.
    from mivnav.collision.config import CollisionConfig

_RISK_RANK = {"red": 3, "yellow": 2, "green": 1, "unknown": 0}


def thresholds(cfg: CollisionConfig) -> Thresholds:
    return Thresholds(cfg.danger_nm, cfg.horizon_min, cfg.warning_nm, cfg.warning_horizon_min)


def _motion(vessel: dict[str, Any]) -> Motion:
    sog_ms = vessel.get("sogMs")
    return Motion(
        lat=vessel.get("lat"),
        lng=vessel.get("lng"),
        cog_deg=vessel.get("cogDeg"),
        sog_kn=None if sog_ms is None else sog_ms * KNOTS_PER_MS,
    )


def _worse(a: Computed, b: Computed) -> bool:
    """Is ``a`` the bigger threat: risk, then still-coming, then smaller CPA.
    See docs/architecture/cpa-risk-ranking.md."""
    by_risk = _RISK_RANK[a.risk] - _RISK_RANK[b.risk]
    if by_risk:
        return by_risk > 0
    by_coming = int(a.tcpa_min >= 0) - int(b.tcpa_min >= 0)
    if by_coming:
        return by_coming > 0
    return a.cpa_nm < b.cpa_nm


def _wire(target: dict[str, Any], result: Computed) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": target["id"],
        "risk": result.risk,
        "cpaNm": result.cpa_nm,
        "tcpaMin": result.tcpa_min,
        "rangeNm": result.range_nm,
        "aspect": result.aspect,
        "side": result.side,
    }
    for key in ("name", "mmsi"):
        if target.get(key) is not None:
            out[key] = target[key]
    return out


def assess(snapshot: dict[str, Any], cfg: CollisionConfig) -> dict[str, Any] | None:
    """``{"threat": {...}, "alarms": [{...}, ...]}``, or ``None`` with no own
    fix, a stale one, or nothing computable.

    ``threat`` is the ONE target the CPA tile is about (the worst computable,
    green included — the tile shows the closest pass even when it is safe).
    ``alarms`` is every red/yellow target, sorted by id so an unchanged
    picture compares equal — what gets published to SignalK.
    """
    own = snapshot.get("self")
    if not own:
        return None
    if snapshot.get("fixAge") is not None:
        # A dead GPS: every CPA would keep computing from a position and
        # velocity the boat no longer has — plausible and quietly wrong. No
        # assessment at all, so nothing alarms on it (invariant #6; the
        # browser's `staleAge: fixAge` did the same while the alarm lived there).
        return None
    own_motion = _motion(own)
    t = thresholds(cfg)
    worst: tuple[dict[str, Any], Computed] | None = None
    alarms: list[dict[str, Any]] = []
    for target in snapshot.get("targets") or ():
        mmsi = target.get("mmsi")
        if is_non_vessel_station(mmsi) or is_sar_aircraft(mmsi):
            # Neither raises an alarm nor becomes the CPA tile's threat.
            continue
        result = compute_cpa(own_motion, _motion(target), t, at_rest_kn=cfg.at_rest_kn)
        if not isinstance(result, Computed):
            continue
        if result.risk in ("red", "yellow"):
            alarms.append(_wire(target, result))
        if worst is None or _worse(result, worst[1]):
            worst = (target, result)
    if worst is None:
        return None
    out: dict[str, Any] = {"threat": _wire(*worst)}
    if alarms:
        out["alarms"] = sorted(alarms, key=lambda a: a["id"])
    return out
