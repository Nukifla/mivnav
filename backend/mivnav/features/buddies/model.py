# SPDX-License-Identifier: GPL-2.0-only
"""What a buddy is, and which of its positions to believe. Pure."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

#: A fix further ahead of the server's clock than this is a bad clock, not
#: news, and must not outrank a good fix for as long as the bad one is "newest".
MAX_FUTURE_S = 300.0
#: Within this of each other, two sources saw the same moment: prefer the
#: receiver on the boat over the same report relayed through the internet.
TIE_S = 30.0
#: Sources in preference order for a tie. Unlisted sources rank last.
SOURCE_RANK = ("signalk", "aiscast")


@dataclass(frozen=True)
class Fix:
    """One position from one source. ``fix_at`` is when it was TAKEN, in
    seconds since the epoch; ``source`` is the provider that delivered it and
    ``via`` what it says about its own route (``"local"``, ``"aishub"``, …)."""

    source: str
    lat: float
    lng: float
    fix_at: float
    via: str | None = None
    cog_deg: float | None = None
    sog_ms: float | None = None
    heading_deg: float | None = None

    def to_json(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}

    @classmethod
    def from_json(cls, raw: dict[str, Any]) -> Fix:
        return cls(
            source=str(raw["source"]),
            lat=float(raw["lat"]),
            lng=float(raw["lng"]),
            fix_at=float(raw["fix_at"]),
            via=raw.get("via"),
            cog_deg=raw.get("cog_deg"),
            sog_ms=raw.get("sog_ms"),
            heading_deg=raw.get("heading_deg"),
        )


@dataclass(frozen=True)
class Report:
    """What a provider returns for one identifier: the fix, plus whatever the
    source says about the boat (kept apart from the skipper's nickname)."""

    mmsi: str
    fix: Fix
    name: str | None = None
    callsign: str | None = None
    ship_type_id: int | None = None
    length_m: float | None = None


def _rank(fix: Fix) -> int:
    return SOURCE_RANK.index(fix.source) if fix.source in SOURCE_RANK else len(SOURCE_RANK)


def newest(fixes: list[Fix], now: float) -> Fix | None:
    """The position to show: newest by when it was TAKEN, not when it arrived,
    or a slow poll of an old fix would outrank a fresher one heard earlier."""
    usable = [f for f in fixes if f.fix_at <= now + MAX_FUTURE_S]
    if not usable:
        return None
    latest = max(f.fix_at for f in usable)
    return min(
        (f for f in usable if latest - f.fix_at <= TIE_S),
        key=lambda f: (_rank(f), -f.fix_at),
    )


def parse_instant(value: Any) -> float | None:
    """An RFC 3339 instant in epoch seconds, or ``None``."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).timestamp()


def format_instant(at: float) -> str:
    return datetime.fromtimestamp(at, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_mmsi(value: str) -> bool:
    return len(value) == 9 and value.isascii() and value.isdigit()
