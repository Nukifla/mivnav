# SPDX-License-Identifier: GPL-2.0-only
"""The ``satellite`` feature's config slice. See
docs/architecture/satellite-config.md for the Feature-abstraction move and
the keyless-source security posture.
"""

from __future__ import annotations

from pydantic import Field, field_validator, model_validator

from mivnav.config.base import Frozen

# Every default source is KEYLESS — copy-safe. See
# docs/architecture/satellite-config.md for the future-keyed-source plan.
DEFAULT_SATELLITE_TILE_FORMAT = "jpg"
# Bake zoom range for a region set — see docs/architecture/satellite-config.md.
DEFAULT_SATELLITE_MIN_ZOOM = 0
DEFAULT_SATELLITE_MAX_ZOOM = 14

# Tile formats a source may declare, mapped to their PMTiles raster tile-type
# id (mivnav.charts.pmtiles). One place, so the writer, the serving Content-Type
# and the config validator cannot disagree about what "jpg" means.
SATELLITE_TILE_TYPE_BY_FORMAT: dict[str, int] = {"jpg": 3, "png": 2, "webp": 4}
SATELLITE_CONTENT_TYPE_BY_FORMAT: dict[str, str] = {
    "jpg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}


class SatelliteSource(Frozen):
    """One imagery source the overlay can serve or bake — an XYZ raster tile
    endpoint. See docs/architecture/satellite-config.md for the URL-template
    axis-order convention and the ``bakeable`` online/offline split."""

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    url_template: str = Field(min_length=1)
    # Shown to the user; imagery licences (ESRI, EOX CC-BY-NC-SA) REQUIRE it.
    attribution: str = ""
    max_zoom: int = Field(default=DEFAULT_SATELLITE_MAX_ZOOM, ge=0, le=24)
    tile_format: str = Field(default=DEFAULT_SATELLITE_TILE_FORMAT)
    bakeable: bool = True

    @field_validator("id")
    @classmethod
    def _slug_id(cls, value: str) -> str:
        # A source id may address a baked ``<id>.pmtiles`` file, so it must be a
        # safe single path component — same rule as a POI set id (no ``/``,
        # ``..``). Rejected rather than silently slugged so config stays honest.
        stripped = value.strip()
        if not stripped or "/" in stripped or "\\" in stripped or ".." in stripped:
            raise ValueError(f"invalid satellite source id {value!r}")
        return stripped

    @field_validator("tile_format")
    @classmethod
    def _known_format(cls, value: str) -> str:
        fmt = value.strip().lower()
        if fmt not in SATELLITE_TILE_TYPE_BY_FORMAT:
            raise ValueError(
                f"unknown tile_format {value!r}; expected one of "
                f"{sorted(SATELLITE_TILE_TYPE_BY_FORMAT)}"
            )
        return fmt

    @model_validator(mode="after")
    def _template_has_fields(self) -> "SatelliteSource":
        # A template missing a placeholder would fetch the same tile for every
        # address; catch it here, not at the first 404 mid-bake.
        for field in ("{z}", "{x}", "{y}"):
            if field not in self.url_template:
                raise ValueError(f"url_template must contain {field}")
        return self

    @property
    def tile_type(self) -> int:
        """The PMTiles raster tile-type id for this source's ``tile_format``."""
        return SATELLITE_TILE_TYPE_BY_FORMAT[self.tile_format]

    @property
    def content_type(self) -> str:
        """The HTTP ``Content-Type`` a served tile of this format carries."""
        return SATELLITE_CONTENT_TYPE_BY_FORMAT[self.tile_format]


# Both keyless/copy-safe. ESRI is online-only (terms), EOX is the offline
# bake source. A deployment edits/extends this list via config.
def _default_satellite_sources() -> tuple["SatelliteSource", ...]:
    return (
        SatelliteSource(
            id="esri-world-imagery",
            name="ESRI World Imagery",
            url_template=(
                "https://server.arcgisonline.com/ArcGIS/rest/services/"
                "World_Imagery/MapServer/tile/{z}/{y}/{x}"
            ),
            attribution=(
                "Esri, Maxar, Earthstar Geographics, and the GIS User Community"
            ),
            max_zoom=19,
            tile_format="jpg",
            bakeable=False,
        ),
        SatelliteSource(
            id="eox-sentinel2-cloudless",
            name="EOX Sentinel-2 cloudless",
            url_template=(
                "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/"
                "default/g/{z}/{y}/{x}.jpg"
            ),
            attribution=(
                "Sentinel-2 cloudless by EOX IT Services GmbH "
                "(Contains modified Copernicus Sentinel data) — CC-BY-NC-SA 4.0"
            ),
            max_zoom=14,
            tile_format="jpg",
            bakeable=True,
        ),
    )


class SatelliteConfig(Frozen):
    """The ``satellite`` feature module's config slice: the imagery sources
    that fill (bake) or feed (online overlay) the pre-baked raster PMTiles
    directory. ``sources``/zoom fields are read fresh at bake time, so a
    config edit takes effect on the next run with no restart."""

    # Zoom range written into a baked set (clamped per source's own max_zoom).
    min_zoom: int = Field(default=DEFAULT_SATELLITE_MIN_ZOOM, ge=0, le=24)
    max_zoom: int = Field(default=DEFAULT_SATELLITE_MAX_ZOOM, ge=0, le=24)
    # The known imagery sources. Non-empty so there is always something to pick.
    sources: tuple[SatelliteSource, ...] = Field(
        default_factory=_default_satellite_sources, min_length=1
    )

    @model_validator(mode="after")
    def _validate(self) -> "SatelliteConfig":
        if self.min_zoom > self.max_zoom:
            raise ValueError("need min_zoom <= max_zoom")
        ids = [s.id for s in self.sources]
        if len(ids) != len(set(ids)):
            raise ValueError("satellite source ids must be unique")
        return self

    def source(self, source_id: str) -> "SatelliteSource | None":
        """The configured source with this id, or ``None``."""
        return next((s for s in self.sources if s.id == source_id), None)
