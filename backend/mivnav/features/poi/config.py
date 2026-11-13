# SPDX-License-Identifier: GPL-2.0-only
"""The ``poi`` feature's config slice. See
docs/architecture/poi-ingest-config.md for the M-DATA-3 ``dir`` removal,
the ``Derived`` keying, and the ``overpass_use_area`` fallback."""

from __future__ import annotations

from pydantic import Field, model_validator

from mivnav.config.base import Frozen

# Single source of truth for the ingest-bake defaults; mivnav.features.poi.overpass
# imports these so the module constants and config-field defaults cannot drift.
DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter"
#: Tried in order when ``overpass_url`` keeps failing a request — see
#: docs/architecture/poi-ingest-config.md for how each was verified.
DEFAULT_OVERPASS_FALLBACK_URLS: tuple[str, ...] = (
    "https://overpass.openstreetmap.fr/api/interpreter",
)
DEFAULT_POI_MIN_ZOOM = 6
DEFAULT_POI_MAX_ZOOM = 14


class PoiConfig(Frozen):
    """The ``poi`` feature module's config slice: the ingest-bake tunables
    that fill the pre-baked OSM-POI PMTiles directory (``data_root/poi``,
    not a field of this class any more — see docs/architecture/poi-ingest-config.md)."""

    overpass_url: str = Field(default=DEFAULT_OVERPASS_URL, min_length=1)
    #: Other Overpass instances, tried in order after ``overpass_url`` has
    #: used up its retries on one request (poi-overpass-fetch.md). ``[]``
    #: pins every fetch to ``overpass_url`` alone.
    overpass_fallback_urls: tuple[str, ...] = DEFAULT_OVERPASS_FALLBACK_URLS
    #: See docs/architecture/poi-ingest-config.md — some Overpass mirrors
    #: answer a country query with zero elements without this fallback.
    overpass_use_area: bool = True
    min_zoom: int = Field(default=DEFAULT_POI_MIN_ZOOM, ge=0, le=24)
    max_zoom: int = Field(default=DEFAULT_POI_MAX_ZOOM, ge=0, le=24)

    def overpass_urls(self) -> tuple[str, ...]:
        """``overpass_url`` then the fallbacks, blanks and repeats dropped."""
        urls = (self.overpass_url, *self.overpass_fallback_urls)
        return tuple(dict.fromkeys(u for u in urls if u))

    @model_validator(mode="after")
    def _zoom_ordered(self) -> "PoiConfig":
        if self.min_zoom > self.max_zoom:
            raise ValueError("need min_zoom <= max_zoom")
        return self
