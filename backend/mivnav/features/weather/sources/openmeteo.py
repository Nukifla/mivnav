# SPDX-License-Identifier: GPL-2.0-only
"""The Open-Meteo backing — the ``.om`` mirror plus the live proxy behind it.
The ONLY file above ``proxy``/``mirror``/``omsource`` that knows Open-Meteo
exists. See docs/architecture/openmeteo-source.md for the design rationale.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from mivnav.features.weather.ingest import om_path_for
from mivnav.features.weather.render import DecodedField, GridDecoder

from .base import GUSTS, PRESSURE, TEMPERATURE, WAVES, WIND, Coverage, DecodeRequest, SourceInfo

if TYPE_CHECKING:
    from mivnav.features.weather.proxy import WeatherProxy

#: Process-wide decode LRU, same reason as ``grib.py``'s: outlives the
#: config-``Derived`` renderer instead of being dropped on every settings edit.
_DECODER = GridDecoder()

#: What kind of product a domain carries — only the NON-atmospheric exceptions
#: are listed; anything absent is a surface atmospheric forecast. Ported
#: verbatim from the frontend's `MODEL_KIND` (sources.ts).
_KIND: dict[str, str] = {
    # Wave models.
    "dwd_gwam": "wave",
    "dwd_ewam": "wave",
    "ncep_gfswave025": "wave",
    "ncep_gfswave016": "wave",
    "ecmwf_wam025": "wave",
    "ecmwf_wam": "wave",
    "meteofrance_wave": "wave",
    # Ocean state.
    "meteofrance_currents": "ocean",
    "meteofrance_sea_surface_temperature": "ocean",
    # Atmospheric composition.
    "cams_global": "composition",
    "cams_global_greenhouse_gases": "composition",
    # Pressure levels only.
    "jma_msm_upper_level": "upper-air",
    # Long-range aggregates — a monthly mean is not a forecast hour.
    "ecmwf_seas5_monthly": "long-range",
    "ecmwf_ec46_ensemble_mean": "long-range",
    "ecmwf_ec46_weekly": "long-range",
    # AI emulators: the core surface fields, but no gust product.
    "ecmwf_aifs025_single": "atmospheric-basic",
    "ecmwf_aifs025_ensemble": "atmospheric-basic",
    "ncep_gfs_graphcast025": "atmospheric-basic",
    "ncep_aigfs025": "atmospheric-basic",
    "cma_grapes_global": "atmospheric-basic",
}

_VARIABLES_BY_KIND: dict[str, tuple[str, ...]] = {
    "atmospheric": (WIND, GUSTS, PRESSURE, TEMPERATURE),
    "atmospheric-basic": (WIND, PRESSURE, TEMPERATURE),
    "wave": (WAVES,),
    "ocean": (),
    "composition": (),
    "upper-air": (),
    "long-range": (),
}


def variables_for(domain: str) -> tuple[str, ...]:
    """Which canonical variables ``domain`` can draw. EMPTY is a real
    answer, not a failure. An unrecognised id is assumed atmospheric — a
    CAPABILITY guess, never a data fallback, erring toward a field that may
    render blank rather than hiding one that works."""
    return _VARIABLES_BY_KIND[_KIND.get(domain, "atmospheric")]


# canonical variable -> the upstream one to ask a `.om` file for; ported from
# the frontend's `WEATHER_FIELDS`/`SPEED_DIR_MODELS` (sources.ts).
_UPSTREAM: dict[str, str] = {
    GUSTS: "wind_gusts_10m",
    PRESSURE: "pressure_msl",
    TEMPERATURE: "temperature_2m",
    WAVES: "wave_height",
}

#: Domains that store 10m wind as ``wind_speed_10m``/``wind_direction_10m``,
#: not u/v — verified against every domain's live ``latest.json`` (2026-09-27).
#: Only the FALLBACK: a remembered manifest's own ``variables`` wins (see
#: :func:`upstream_variable`), since a stale entry here decodes nothing and the
#: tile renders blank — which is how metno/ukmo went dark while missing.
_SPEED_DIR_DOMAINS: frozenset[str] = frozenset(
    {
        "cmc_gem_hrdps",
        "cmc_gem_hrdps_west",
        "dmi_harmonie_arome_europe",
        "geosphere_arome_austria",
        "italia_meteo_arpae_icon_2i",
        "knmi_harmonie_arome_europe",
        "knmi_harmonie_arome_netherlands",
        "metno_nordic_pp",
        "ncep_nbm_conus",
        "ukmo_global_deterministic_10km",
        "ukmo_uk_deterministic_2km",
    }
)

_WIND_UV = "wind_u_component_10m"
_WIND_SPEED = "wind_speed_10m"


def upstream_variable(
    domain: str, variable: str, published: frozenset[str] | None = None
) -> str:
    """The ``.om`` variable name ``domain`` carries ``variable`` as.

    ``published`` is the domain's manifest ``variables``, when known: it
    decides the wind convention outright, the static table only when absent.

    Raises ``KeyError`` when this domain does not serve it at all — the same
    answer :func:`variables_for` gives discovery, enforced here so a hand-built
    request cannot reach past what the picker offered.
    """
    if variable not in variables_for(domain):
        raise KeyError(
            f"{domain!r} does not serve {variable!r} "
            f"(it serves {list(variables_for(domain))})"
        )
    if variable == WIND:
        if published:
            if _WIND_UV in published:
                return _WIND_UV
            if _WIND_SPEED in published:
                return _WIND_SPEED
        return _WIND_SPEED if domain in _SPEED_DIR_DOMAINS else _WIND_UV
    return _UPSTREAM[variable]


def upstream_names_for(domain: str) -> frozenset[str]:
    """Every ``.om`` variable name the overlay may ask ``domain``'s files for
    — what a bake keeps. Both wind conventions and every pair partner the
    decoder reads (direction beside speed/height); a file carries a subset,
    and the bake intersects with what is actually there."""
    names: set[str] = set()
    for variable in variables_for(domain):
        if variable == WIND:
            names |= {_WIND_UV, "wind_v_component_10m", _WIND_SPEED, "wind_direction_10m"}
        elif variable == WAVES:
            names |= {_UPSTREAM[WAVES], "wave_direction"}
        else:
            names.add(_UPSTREAM[variable])
    return frozenset(names)


def _iso_minute(t: datetime) -> str:
    """``t`` in the fixed-width UTC shape ``WeatherMirror.baked_paths`` keys on
    (read off the baked filenames, which record whole minutes only)."""
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:00Z")


# A live domain's forecast horizon is stated only by its own `latest.json`,
# so `decode()`'s fetch REMEMBERS it; `describe()` only reads it (network-free).
# See docs/architecture/openmeteo-source.md.


@dataclass(frozen=True)
class _Manifest:
    """One domain's last-seen ``latest.json``, parsed."""

    #: The run id exactly as upstream wrote it — the cheap "has this changed"
    #: test, so a viewport's worth of tiles re-parses nothing.
    reference_raw: str
    reference_time: datetime | None
    valid_times: tuple[datetime, ...]
    fetched_at: float
    #: The upstream variable names this run publishes; empty when unstated.
    variables: frozenset[str] = frozenset()


_MANIFEST_CACHE: dict[str, _Manifest] = {}

#: Upstream re-runs every 1-6h; older entries are dropped back to "unknown"
#: rather than shading the ruler from a horizon that has moved.
_MANIFEST_MAX_AGE_S = 6 * 3600


def _parse_manifest_time(value: object) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return (t if t.tzinfo is not None else t.replace(tzinfo=timezone.utc)).astimezone(
        timezone.utc
    )


def _remember_manifest(
    domain: str, reference_time: str, valid_times: list, variables: object = ()
) -> None:
    """Record what the current run publishes for ``domain``. Called on the
    DECODE path only — see this section's header."""
    published = (
        frozenset(v for v in variables if isinstance(v, str))
        if isinstance(variables, list)
        else frozenset()
    )
    hit = _MANIFEST_CACHE.get(domain)
    if hit is not None and hit.reference_raw == reference_time:
        _MANIFEST_CACHE[domain] = replace(
            hit, fetched_at=time.monotonic(), variables=published or hit.variables
        )
        return
    parsed = tuple(
        sorted(t for t in map(_parse_manifest_time, valid_times) if t is not None)
    )
    _MANIFEST_CACHE[domain] = _Manifest(
        reference_raw=reference_time,
        reference_time=_parse_manifest_time(reference_time),
        valid_times=parsed,
        fetched_at=time.monotonic(),
        variables=published,
    )


def remembered_manifest(domain: str) -> _Manifest | None:
    """``domain``'s last-seen manifest, or ``None`` when none has been seen or
    the one we have has outlived its run. Never fetches."""
    hit = _MANIFEST_CACHE.get(domain)
    if hit is None:
        return None
    if time.monotonic() - hit.fetched_at > _MANIFEST_MAX_AGE_S:
        return None
    return hit


@dataclass(frozen=True)
class OpenMeteoSource:
    """One Open-Meteo domain, mirrored and/or live."""

    domain: str
    label: str
    #: Valid times already mirrored to disk, from `WeatherMirror.baked()`.
    baked_times: tuple[datetime, ...]
    #: True when the live proxy may fetch this domain (declared dataset or
    #: on-demand allow-list); False means the mirror is all there will ever be.
    live_allowed: bool
    #: ``{ISO valid time: om path}`` for what is on disk — the exact paths
    #: ``WeatherMirror.resolve`` will answer for. Excluded from equality (it is
    #: derived from the same scan ``baked_times`` is) so the dataclass stays
    #: hashable and comparable on identity-bearing fields alone.
    baked_paths: tuple[tuple[str, str], ...] = field(default=(), compare=False)
    #: The range-caching proxy, when this source was built for DECODING. `None`
    #: on the discovery path, which must never touch the network.
    proxy: WeatherProxy | None = field(default=None, compare=False, repr=False)

    @property
    def id(self) -> str:
        return f"om:{self.domain}"

    def describe(self) -> SourceInfo:
        badge = "Offline · Open-Meteo" if self.baked_times else "Online · Open-Meteo"
        if self.baked_times and self.live_allowed:
            badge = "Partly offline · Open-Meteo"
        return SourceInfo(
            id=self.id,
            label=self.label,
            badge=badge,
            requires_network=self.live_allowed,
            variables=variables_for(self.domain),
            coverage=self._coverage(),
            # Open-Meteo domains are regional or global; the grid catalog knows,
            # but it only annotates, so it can follow.
            region=None,
        )

    def _coverage(self) -> Coverage:
        """`local` from a filesystem scan, `remote` from the REMEMBERED
        manifest (no network call here). Non-fetchable domains report
        `remote=()` regardless of what's remembered."""
        local = self.baked_times
        manifest = remembered_manifest(self.domain) if self.live_allowed else None
        if manifest is None:
            return Coverage(
                local=local,
                remote=(),
                reference_time=local[0] if local else None,
            )
        have = set(local)
        return Coverage(
            local=local,
            remote=tuple(t for t in manifest.valid_times if t not in have),
            reference_time=manifest.reference_time or (local[0] if local else None),
        )

    # ── decode ──────────────────────────────────────────────────────────────

    async def decode(self, req: DecodeRequest) -> DecodedField:
        """The field for one canonical variable at one valid time.
        ``req.tile``/``req.at`` are ignored — a ``.om`` file decodes to its
        own whole domain grid. Mirror first, then live (only if `live_allowed`)."""
        upstream_variable(self.domain, req.variable)  # refuse before any fetch
        om_path = await self._resolve_path(req.time)
        if self.proxy is None:
            raise KeyError(f"{self.id} was built for discovery only — no decode proxy")
        # After the resolve: a live resolve has just (re)remembered the manifest.
        manifest = remembered_manifest(self.domain)
        raw = upstream_variable(
            self.domain, req.variable, manifest.variables if manifest else None
        )
        return await _DECODER.decode_field(
            self.proxy, asyncio.get_running_loop(), om_path, raw
        )

    async def _resolve_path(self, time: datetime) -> str:
        """The concrete ``.om`` path for ``time``, from disk or from the live
        capture manifest."""
        want = _iso_minute(time)
        for baked_time, path in self.baked_paths:
            if baked_time == want:
                return path
        if not self.live_allowed:
            raise KeyError(
                f"{self.id} has no baked data for {want} and may not be fetched "
                "live — declare a weather dataset for it or add it to "
                "weather.on_demand_domains"
            )
        return await self._live_path(want)

    async def _live_path(self, want: str) -> str:
        """The path the CURRENT run publishes ``want`` at, from ``latest.json``.
        Exact match only, never snapped. Also REMEMBERS ``valid_times`` for
        :meth:`describe` to report coverage with no request."""
        assert self.proxy is not None
        status, body, _ctype = await self.proxy.passthrough_tiles(
            f"data_spatial/{self.domain}/latest.json", ""
        )
        if status != 200:
            raise KeyError(
                f"{self.id}: upstream capture manifest is unavailable (HTTP {status})"
            )
        try:
            manifest = json.loads(body)
            reference_time = manifest["reference_time"]
            valid_times = manifest["valid_times"]
        except (ValueError, KeyError, TypeError) as e:
            raise KeyError(f"{self.id}: unreadable capture manifest ({e})") from e
        if isinstance(reference_time, str) and isinstance(valid_times, list):
            _remember_manifest(
                self.domain, reference_time, valid_times, manifest.get("variables", ())
            )
        for vt in valid_times:
            try:
                parsed = datetime.fromisoformat(str(vt).replace("Z", "+00:00"))
            except ValueError:
                continue
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            if _iso_minute(parsed) == want:
                return om_path_for(self.domain, reference_time, str(vt))
        raise KeyError(f"{self.id}: the current run does not cover {want}")


async def decode_om(
    proxy: WeatherProxy, om_path: str, raw_variable: str
) -> DecodedField:
    """A field straight from a concrete ``.om`` path — for the LEGACY
    ``?path=`` routes, which address a file the client resolved itself.
    Goes when the frontend moves to source ids (``qmnwrupv``)."""
    return await _DECODER.decode_field(proxy, asyncio.get_running_loop(), om_path, raw_variable)


async def decode_om_uv(
    proxy: WeatherProxy, om_path: str, raw_variable: str
) -> tuple[DecodedField, DecodedField]:
    """Native ``(u, v)`` for the legacy wind-texture route — see
    :func:`decode_om`. The id-addressed route derives u/v from one
    ``DecodedField`` instead (``render.uv_components``)."""
    return await _DECODER.decode_uv(proxy, asyncio.get_running_loop(), om_path, raw_variable)
