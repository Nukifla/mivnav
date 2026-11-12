# SPDX-License-Identifier: GPL-2.0-only
"""The weather TYPE contract: what a selectable weather source is, and the
protocol an implementation satisfies. Source ids are opaque (no consumer may
parse one — that's what produced the client's old ``grib:`` prefix bug); no
fallback (an unanswerable request is an error, never a substitution). See
docs/weather-sources-design.md for the full design.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable

from mivnav.features.weather.render import DecodedField

#: A web-mercator tile, ``(z, x, y)``.
TileId = tuple[int, int, int]


@dataclass(frozen=True)
class BBox:
    """Geographic extent, degrees. ``None`` on a source means global."""

    west: float
    south: float
    east: float
    north: float

    def as_json(self) -> dict[str, float]:
        return {"west": self.west, "south": self.south, "east": self.east, "north": self.north}


@dataclass(frozen=True)
class Coverage:
    """Which valid times a source can answer for, split by cost: ``local``
    needs no network (a GRIB bake, a mirrored ``.om``), ``remote`` does — a
    source can genuinely be both, e.g. a partly-baked Open-Meteo domain.
    Times are enumerated, not range+step, since a bake can have holes."""

    local: tuple[datetime, ...] = ()
    remote: tuple[datetime, ...] = ()
    reference_time: datetime | None = None

    def as_json(self) -> dict:
        return {
            "local": [t.isoformat().replace("+00:00", "Z") for t in self.local],
            "remote": [t.isoformat().replace("+00:00", "Z") for t in self.remote],
            "reference_time": (
                self.reference_time.isoformat().replace("+00:00", "Z")
                if self.reference_time is not None
                else None
            ),
        }


@dataclass(frozen=True)
class SourceInfo:
    """One row of ``GET /weather/sources`` — everything the picker, the ruler
    and the offline gate need, in one answer (replaces three client-joined
    endpoints; see docs/weather-sources-design.md). ``badge`` is for humans
    only — deliberately not machine-parseable, unlike ``requires_network``."""

    id: str
    label: str
    badge: str
    requires_network: bool
    variables: tuple[str, ...]
    coverage: Coverage
    region: BBox | None = None

    def as_json(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "badge": self.badge,
            "requires_network": self.requires_network,
            "variables": list(self.variables),
            "coverage": self.coverage.as_json(),
            "region": self.region.as_json() if self.region is not None else None,
        }


@dataclass(frozen=True)
class DecodeRequest:
    """What a caller wants decoded, in terms no backing appears in.
    ``variable`` is CANONICAL (:data:`VARIABLES`); ``time`` is an explicit
    UTC instant, never "hours from now". Exactly one of ``tile``/``at`` is
    set — most backings ignore both, but a position-only upstream (SignalK's
    Weather API) needs a tile to quantise to an ancestor and share one sweep
    across neighbouring tiles."""

    variable: str
    time: datetime
    tile: TileId | None = None
    at: tuple[float, float] | None = None


@runtime_checkable
class WeatherSource(Protocol):
    """What an implementation provides. Implementations return DATA, never
    pixels — colour scales, sampling, tiling and encoding stay shared above
    this line, which is why one ``decode`` serves the wash, particle field,
    and point readout alike. Raises ``KeyError``/``ValueError`` (-> 404) when
    the source cannot answer; never substitutes another source's numbers."""

    def describe(self) -> SourceInfo: ...

    async def decode(self, req: DecodeRequest) -> DecodedField: ...


# ── canonical variables ──────────────────────────────────────────────────────
# App-level names; each implementation maps its own upstream naming to these.
# `wind`/`waves` carry a direction, so they're drawable as particles too.
WIND = "wind"
GUSTS = "gusts"
PRESSURE = "pressure"
TEMPERATURE = "temperature"
WAVES = "waves"

#: Every canonical variable, in the order a picker should offer them.
VARIABLES: tuple[str, ...] = (WIND, GUSTS, PRESSURE, TEMPERATURE, WAVES)

#: The ones that carry a direction, and so can drive the particle field.
DIRECTIONAL: frozenset[str] = frozenset({WIND, WAVES})
