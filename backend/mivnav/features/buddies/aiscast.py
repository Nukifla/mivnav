# SPDX-License-Identifier: GPL-2.0-only
"""The aiscast provider: last-known positions by MMSI from Open Waters AIS.

``GET /v1/vessels?mmsi=a,b`` needs no token and returns positions days old
(measured 2026-10-31: a 6-day-old fix, ``seen`` in UTC). Measured limits: 10
MMSIs per request (12 gives ``400 too many mmsi for this key``; 11 untested),
a comma list only (a repeated ``mmsi=`` silently answers for the first), and
``sog`` in KNOTS (ten moving ships against SignalK's m/s).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from typing import Any

import httpx

from mivnav.features.buddies.model import Fix, Report, is_mmsi, parse_instant

log = logging.getLogger(__name__)

VESSELS_URL = "https://ais.openwaters.io/v1/vessels"
BATCH = 10
TIMEOUT_S = 10.0
_MS_PER_KNOT = 1852.0 / 3600.0

Fetch = Callable[[str], Any]


def _fetch(url: str) -> Any:
    response = httpx.get(url, timeout=TIMEOUT_S)
    response.raise_for_status()
    return response.json()


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def parse(body: Any) -> list[Report]:
    """A ``/v1/vessels`` body to reports. Total: a malformed feature is one
    missing boat, not a failed poll."""
    features = body.get("features") if isinstance(body, dict) else None
    out: list[Report] = []
    for feature in features if isinstance(features, list) else ():
        try:
            lng, lat = feature["geometry"]["coordinates"][:2]
            props = feature["properties"]
            mmsi = str(props["mmsi"]).zfill(9)
            seen = parse_instant(props.get("seen"))
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        lat, lng = _number(lat), _number(lng)
        if seen is None or lat is None or lng is None or not is_mmsi(mmsi):
            continue
        sog_kn = _number(props.get("sog"))
        out.append(
            Report(
                mmsi=mmsi,
                fix=Fix(
                    source="aiscast",
                    lat=lat,
                    lng=lng,
                    fix_at=seen,
                    via=props.get("source") if isinstance(props.get("source"), str) else None,
                    cog_deg=_number(props.get("cog")),
                    sog_ms=None if sog_kn is None else sog_kn * _MS_PER_KNOT,
                    heading_deg=_number(props.get("heading")),
                ),
                name=props.get("name") if isinstance(props.get("name"), str) else None,
                callsign=props.get("callsign") if isinstance(props.get("callsign"), str) else None,
                ship_type_id=int(t) if isinstance(t := props.get("type"), int) else None,
                length_m=_number(props.get("length")),
            )
        )
    return out


def poll(mmsis: Sequence[str], fetch: Fetch = _fetch) -> list[Report]:
    """Every MMSI, in batches. A failing batch raises: the caller records
    the failure and keeps the positions it has."""
    out: list[Report] = []
    for start in range(0, len(mmsis), BATCH):
        batch = ",".join(mmsis[start : start + BATCH])
        out.extend(parse(fetch(f"{VESSELS_URL}?mmsi={batch}")))
    return out
