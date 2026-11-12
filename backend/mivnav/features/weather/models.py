# SPDX-License-Identifier: GPL-2.0-only
"""Weather model DISCOVERY — the backend's answer to "what weather models can
this app offer", replacing the frontend's client-side Open-Meteo catalog join
(#qtwquuww), and the server-side gate the old client-side filter (qwltrxvo)
never actually enforced. See docs/architecture/weather-model-discovery.md for
what's offered (GRIB datasets + on-demand allow-list + anything found baked
on disk) and why labels come from a generated catalog, not a live import.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from mivnav.config.model import Config
from mivnav.features.weather.mirror import WeatherMirror

_CATALOG_PATH = Path(__file__).parent / "data" / "weather_model_catalog.json"


@lru_cache(maxsize=1)
def _catalog() -> dict[str, dict[str, Any]]:
    return json.loads(_CATALOG_PATH.read_text())


@dataclass(frozen=True)
class WeatherModelInfo:
    """One row of ``GET /datasets/weather/models`` — a domain this boat can
    currently show. Deliberately carries NO baked-span info; that stays
    ``GET /weather/baked``'s own, separately-read answer.
    """

    id: str
    label: str
    group: str
    group_label: str
    time_interval: str


def _params_domains(params: dict[str, Any]) -> set[str]:
    """Domain ids out of one weather dataset's opaque ``params``. Accepts
    ``domains`` AND a legacy singular ``domain``, permanently (#xkpmrvxw
    broke discovery once by reading only one) — see
    docs/architecture/weather-model-discovery.md.
    """
    raw = params.get("domains")
    if isinstance(raw, str):  # tolerate a hand-edited scalar under the new key
        raw = [raw]
    elif not isinstance(raw, list):
        raw = []
    legacy = params.get("domain")
    if isinstance(legacy, str):
        raw = [*raw, legacy]
    return {d for d in raw if isinstance(d, str) and d}


def declared_domains(config: Config) -> set[str]:
    """Every domain named by a declared ``weather`` dataset's ``params``,
    regardless of whether it has finished baking — a dataset is a sailor's
    stated INTENTION and belongs in the picker the moment it exists (compare
    :meth:`~mivnav.features.weather.mirror.WeatherMirror.baked`, the
    stricter "is it on disk right now" question). See
    docs/architecture/weather-model-discovery.md for the ``domain``/
    ``domains`` incident this function must keep reading both spellings for.
    """
    out: set[str] = set()
    for ds in config.datasets:
        if ds.provider != "weather":
            continue
        out |= _params_domains(ds.params if isinstance(ds.params, dict) else {})
    return out


def allowed_domains(config: Config) -> set[str]:
    """The domains the LIVE proxy may fetch on demand — the server-side gate
    :func:`is_domain_allowed` enforces, so the list :func:`model_catalog`
    offers is never a promise the proxy then breaks. Every declared weather
    dataset's own domain is implicitly allowed (its bake may still be
    running or incomplete for the requested hour) plus the sailor's
    explicit ``WeatherConfig.on_demand_domains``.
    """
    return declared_domains(config) | set(config.weather.on_demand_domains)


def is_domain_allowed(config: Config, domain: str) -> bool:
    """Whether the live proxy may fetch ``domain`` on demand — applied before
    EVERY route that falls through to :class:`WeatherProxy`. Never applied to
    a :class:`WeatherMirror` HIT — a baked file on disk is served with no
    network activity regardless of the live allow-list.
    """
    return domain in allowed_domains(config)


#: Group id/label the GRIB-backed entries cluster under — a GRIB bake and its
#: live Open-Meteo domain share the SAME catalog label, so they need their
#: own optgroup to not look like the same option twice (see
#: docs/architecture/weather-model-discovery.md).
GRIB_GROUP = "offline-grib"
GRIB_GROUP_LABEL = "Offline (GRIB)"


def grib_models(config: Config) -> list[WeatherModelInfo]:
    """One row per (enabled GRIB dataset × domain it declares), addressed by
    the compound ``grib:<dataset id>/<product id>`` id that
    ``GRIB_PATH_PREFIX`` dispatches on. Without these the GRIB read path was
    UNREACHABLE from the UI (a real past incident — see
    docs/architecture/weather-model-discovery.md).
    """
    catalog = _catalog()
    out: list[WeatherModelInfo] = []
    for ds in config.datasets:
        if ds.provider != "weather" or not ds.enabled:
            continue
        params = ds.params if isinstance(ds.params, dict) else {}
        if params.get("source") != "grib":
            continue
        for domain in sorted(_params_domains(params)):
            meta = catalog.get(domain)
            out.append(
                WeatherModelInfo(
                    id=f"grib:{ds.id}/{domain}",
                    label=(meta or {}).get("label", domain),
                    group=GRIB_GROUP,
                    group_label=GRIB_GROUP_LABEL,
                    time_interval=(meta or {}).get("timeInterval", ""),
                )
            )
    return out


def model_catalog(config: Config, mirror: WeatherMirror) -> list[WeatherModelInfo]:
    """``GET /datasets/weather/models``' answer: every domain this boat can
    currently show, in the generated catalog's own declaration order (the
    same order the frontend's old ``WEATHER_MODELS`` picker always used),
    with any allow-listed-but-uncatalogued id appended afterwards, sorted."""
    catalog = _catalog()
    ids = allowed_domains(config) | {d.domain for d in mirror.baked()}
    known_order = [domain_id for domain_id in catalog if domain_id in ids]
    unknown = sorted(ids - set(catalog))
    out: list[WeatherModelInfo] = []
    for domain_id in [*known_order, *unknown]:
        meta = catalog.get(domain_id)
        if meta is None:
            out.append(WeatherModelInfo(domain_id, domain_id, domain_id, domain_id, ""))
        else:
            out.append(
                WeatherModelInfo(
                    domain_id, meta["label"], meta["group"], meta["groupLabel"], meta["timeInterval"]
                )
            )
    # GRIB-backed rows last, in their own group: they are addressed by a
    # compound id rather than a domain, so they have no place in the
    # catalog's domain ordering above.
    return [*out, *grib_models(config)]
