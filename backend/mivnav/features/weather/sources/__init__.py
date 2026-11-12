# SPDX-License-Identifier: GPL-2.0-only
"""The weather source REGISTRY — the one place that knows which
implementations exist. See
docs/architecture/weather-source-implementation-registry.md.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from mivnav.config.model import Config
# `mivnav.config.base`, not `mivnav.data.provider` — see
# backend/.importlinter's features-below-composition contract.
from mivnav.config.base import dataset_dir
from mivnav.features.weather.mirror import WeatherMirror

from .base import VARIABLES, BBox, Coverage, DecodeRequest, SourceInfo, TileId, WeatherSource
from .grib import GribSource, decode_grib_uv, decode_grib_wind
from .openmeteo import (
    OpenMeteoSource,
    decode_om,
    decode_om_uv,
    upstream_names_for,
    variables_for,
)
from .signalk import SignalKSource, coverage_times, discover

if TYPE_CHECKING:
    from mivnav.features.weather.proxy import WeatherProxy

__all__ = [
    "VARIABLES",
    "BBox",
    "Coverage",
    "DecodeRequest",
    "SourceInfo",
    "TileId",
    "WeatherSource",
    "list_sources",
    "find_source",
    "resolve_source",
    "variables_for",
    "upstream_names_for",
    "dataset_implementation",
    "IMPLEMENTATIONS",
    "DEFAULT_IMPLEMENTATION",
    # Legacy `?path=` escape hatches only (routes.py); go with qmnwrupv.
    "decode_grib_uv",
    "decode_grib_wind",
    "decode_om",
    "decode_om_uv",
]

_CATALOG_PATH = Path(__file__).parent.parent / "data" / "weather_model_catalog.json"

#: The legal values of a weather `DatasetConfig.implementation`. See
#: docs/architecture/weather-source-implementation-registry.md.
IMPLEMENTATIONS: tuple[str, ...] = ("om", "grib")

#: What a dataset naming no implementation means — see
#: docs/architecture/weather-source-implementation-registry.md.
DEFAULT_IMPLEMENTATION = "om"


def dataset_implementation(implementation: str | None, params: object) -> str:
    """Which backing a weather dataset names, reading the legacy
    `params.source` spelling permanently. See
    docs/architecture/weather-source-implementation-registry.md."""
    if implementation:
        return implementation
    legacy = params.get("source") if isinstance(params, dict) else getattr(params, "source", None)
    return legacy if isinstance(legacy, str) and legacy else DEFAULT_IMPLEMENTATION


def _label_for(domain: str) -> str:
    """A domain's display label from the generated Open-Meteo catalog.
    Lives here (not openmeteo.py) because GRIB products are named by
    Open-Meteo domain too — shared metadata, not one backing's business."""
    try:
        catalog = json.loads(_CATALOG_PATH.read_text())
    except OSError:
        return domain
    meta = catalog.get(domain)
    return meta.get("label", domain) if isinstance(meta, dict) else domain


def _params_domains(params: object) -> list[str]:
    """Domain ids out of a dataset's opaque `params`: `domains` (a list)
    plus the legacy singular `domain`, read permanently — see
    docs/architecture/weather-source-implementation-registry.md."""
    if not isinstance(params, dict):
        return []
    raw = params.get("domains")
    if isinstance(raw, str):
        raw = [raw]
    elif not isinstance(raw, list):
        raw = []
    legacy = params.get("domain")
    if isinstance(legacy, str):
        raw = [*raw, legacy]
    return [d for d in raw if isinstance(d, str) and d]


def _parse_iso(t: str) -> datetime:
    return datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(timezone.utc)


def list_sources(
    config: Config, mirror: WeatherMirror, proxy: WeatherProxy | None = None
) -> list[WeatherSource]:
    """Every LOCAL weather source (no network — see
    docs/architecture/weather-source-implementation-registry.md for why
    `proxy` is optional and how a disabled/orphaned dataset is handled)."""
    baked_paths = mirror.baked_paths()
    baked = {domain: sorted(times) for domain, times in baked_paths.items()}
    out: list[WeatherSource] = []

    # GRIB datasets: one source per (dataset x product it bakes).
    for ds in config.datasets:
        if ds.provider != "weather" or not ds.enabled:
            continue
        params = ds.params if isinstance(ds.params, dict) else {}
        if dataset_implementation(ds.implementation, params) != "grib":
            continue
        for domain in sorted(_params_domains(params)):
            out.append(
                GribSource(
                    dataset_id=ds.id,
                    product_id=domain,
                    dataset_dir=dataset_dir(config.data_root, "weather", ds.id),
                    product_label=_label_for(domain),
                )
            )

    # Open-Meteo: one source per domain, whether mirrored, live, or both.
    declared_om: set[str] = set()
    for ds in config.datasets:
        if ds.provider != "weather" or not ds.enabled:
            continue
        params = ds.params if isinstance(ds.params, dict) else {}
        if dataset_implementation(ds.implementation, params) == "grib":
            continue
        declared_om.update(_params_domains(params))
    on_demand = set(config.weather.on_demand_domains)

    for domain in sorted(declared_om | on_demand | set(baked)):
        out.append(
            OpenMeteoSource(
                domain=domain,
                label=_label_for(domain),
                baked_times=tuple(_parse_iso(t) for t in baked.get(domain, ())),
                live_allowed=domain in declared_om or domain in on_demand,
                baked_paths=tuple(sorted(baked_paths.get(domain, {}).items())),
                proxy=proxy,
            )
        )
    return out


def find_source(
    config: Config, mirror: WeatherMirror, source_id: str, proxy: WeatherProxy | None = None
) -> WeatherSource | None:
    """Resolve an opaque id back to a LOCAL source, or `None` — callers
    404 rather than falling back to a different source."""
    for src in list_sources(config, mirror, proxy):
        if src.id == source_id:
            return src
    return None


async def resolve_source(
    config: Config, mirror: WeatherMirror, source_id: str, proxy: WeatherProxy | None = None
) -> WeatherSource | None:
    """`find_source`, plus the SignalK providers. See
    docs/architecture/weather-source-implementation-registry.md for why
    local sources are searched first and this doesn't probe coverage."""
    local = find_source(config, mirror, source_id, proxy)
    if local is not None:
        return local
    if not config.signalk.enabled:
        return None
    base = signalk_base_url(config)
    offline = set(config.weather.signalk_offline_providers)
    for pid, label in await discover(base):
        src = SignalKSource(
            provider_id=pid,
            provider_label=label,
            base_url=base,
            network=pid not in offline,
        )
        if src.id == source_id:
            return src
    return None


def signalk_base_url(config: Config) -> str:
    sk = config.signalk
    scheme = "https" if getattr(sk, "tls", False) else "http"
    return f"{scheme}://{sk.host}:{sk.port}"


async def list_signalk_sources(
    config: Config, position: tuple[float, float] | None
) -> list[WeatherSource]:
    """Every weather provider registered on the boat's own SignalK
    server, coverage probed at `position` (cached, concurrent). See
    docs/architecture/weather-source-implementation-registry.md."""
    if not config.signalk.enabled:
        return []
    base = signalk_base_url(config)
    offline = set(config.weather.signalk_offline_providers)
    found = await discover(base)
    covered = await asyncio.gather(
        *(coverage_times(base, pid, position) for pid, _label in found)
    )
    return [
        SignalKSource(
            provider_id=pid,
            provider_label=label,
            base_url=base,
            times=times,
            network=pid not in offline,
        )
        for (pid, label), times in zip(found, covered)
    ]


async def list_all_sources(
    config: Config, mirror: WeatherMirror, position: tuple[float, float] | None = None
) -> list[WeatherSource]:
    """Local sources plus the SignalK ones — what `GET /weather/sources`
    answers with. A SignalK server that is down or has no weather plugin
    contributes nothing, rather than failing the whole list."""
    return [*list_sources(config, mirror), *await list_signalk_sources(config, position)]
