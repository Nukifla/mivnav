# SPDX-License-Identifier: GPL-2.0-only
"""The GRIB backing. See docs/architecture/weather-source-implementation-
registry.md's `sources/grib.py` section for the module-boundary invariant
(enforced by ``test_weather_sources.py``) and why GRIB v1 is 10m-wind-only.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from mivnav.features.weather.grib_render import GribDecoder
from mivnav.features.weather.gribstore import GribStore
from mivnav.features.weather.render import DecodedField

from .base import WIND, Coverage, DecodeRequest, SourceInfo

#: Process-wide decode LRU: a ``GribSource`` is a frozen dataclass rebuilt
#: from config on every request, so per-instance caching would never hit;
#: this is keyed by file path and depends on no config.
_DECODER = GribDecoder()


@dataclass(frozen=True)
class GribSource:
    """One declared GRIB dataset × one product (domain) it bakes."""

    dataset_id: str
    product_id: str
    dataset_dir: Path
    #: Display name for the product, resolved from the shared catalog by the
    #: registry — this module does not own Open-Meteo's label table.
    product_label: str

    @property
    def id(self) -> str:
        # Opaque to every consumer; composite only so a log line is readable.
        return f"grib:{self.dataset_id}:{self.product_id}"

    def describe(self) -> SourceInfo:
        # Filesystem only — no GRIB decode, no network. Discovery is polled by
        # the weather sheet, so it must stay cheap and must answer with the
        # aerial down.
        times = tuple(GribStore(self.dataset_dir, self.product_id).valid_times())
        return SourceInfo(
            id=self.id,
            label=self.product_label,
            badge="Offline · GRIB",
            # A GRIB bake is answerable with the link down, always. This is the
            # field an offline/metered toggle filters on.
            requires_network=False,
            variables=(WIND,),
            # Everything a GRIB source has is local by definition: there is no
            # upstream to reach for a time it did not bake. A missing hour is
            # simply absent, never fetched behind the sailor's back.
            coverage=Coverage(local=times, remote=(), reference_time=times[0] if times else None),
            # Region needs a decoded grid definition — too expensive for a
            # discovery poll. Omitted until cached alongside the bake; it
            # only annotates, never gates (design doc's D3).
            region=None,
        )

    async def decode(self, req: DecodeRequest) -> DecodedField:
        """Wind speed + FROM-bearing at ``req.time`` (whole grid; ``req.tile``/
        ``req.at`` ignored). Valid time must match a baked one EXACTLY
        (dict lookup, not nearest-search), so a missed hour reports itself."""
        if req.variable != WIND:
            raise KeyError(
                f"{self.id} serves {WIND!r} only (a GRIB bake is a u/v wind pair "
                f"per valid time), not {req.variable!r}"
            )
        store = GribStore(self.dataset_dir, self.product_id)
        return await decode_grib_wind(store, req.time)


async def decode_grib_wind(store: GribStore, valid_time: datetime) -> DecodedField:
    """One store's wind field at ``valid_time`` — shared by :meth:`GribSource
    .decode` and the legacy ``?path=grib:…`` routes, so both ride the one
    process-wide decode LRU rather than each holding their own."""
    return await _DECODER.decode_speed(store, valid_time)


async def decode_grib_uv(
    store: GribStore, valid_time: datetime
) -> tuple[DecodedField, DecodedField]:
    """Native ``(u, v)`` for the LEGACY ``?path=grib:…`` route only; the
    id-addressed route derives u/v from :meth:`GribSource.decode` instead.
    Goes away when the frontend moves off ``?path=`` (task qmnwrupv)."""
    return await _DECODER.decode_uv(store, valid_time)
