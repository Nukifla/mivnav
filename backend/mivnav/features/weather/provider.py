# SPDX-License-Identifier: GPL-2.0-only
"""The ``weather`` feature's ``/providers`` descriptor and its
``IngestSpec``: weather moved from a passive byte cache to a real bakeable
:class:`~mivnav.feature.DataProvider`. See docs/architecture/weather-provider-params.md.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal, cast

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from mivnav.config.model import Config, Region
from mivnav.feature import (
    CachePolicy,
    DataProvider,
    IngestSpec,
    Refresh,
    implementation_from_context,
)
from mivnav.features.weather import domains, gribfetch
from mivnav.features.weather.sources import dataset_implementation, upstream_names_for
from mivnav.features.weather.gribingest import (
    WeatherGribIngestError,
    WeatherGribIngestRunner,
)
from mivnav.features.weather.ingest import WeatherIngestError, WeatherIngestRunner
from mivnav.features.weather.runtime import WeatherRuntime
from mivnav.ingest.runner import IngestRunner


class WeatherDatasetParams(BaseModel):
    """A weather ``DatasetConfig``'s ``params``: ``domains`` (Open-Meteo
    model id(s) to mirror) plus ``max_forecast_hours``. See
    docs/architecture/weather-provider-params.md for the design history."""

    model_config = ConfigDict(extra="forbid")

    #: RETIRED in favour of ``DatasetConfig.implementation``; read only
    #: through :func:`~mivnav.features.weather.sources.dataset_implementation`.
    source: Literal["om", "grib"] = "om"
    domains: list[str] = Field(min_length=1)
    max_forecast_hours: int | None = Field(default=None, gt=0)

    @model_validator(mode="before")
    @classmethod
    def _legacy_domain_alias(cls, data: object) -> object:
        if isinstance(data, dict) and "domain" in data:
            data = dict(data)
            legacy = data.pop("domain")
            if not data.get("domains"):
                data["domains"] = [legacy]
        return data

    @field_validator("domains")
    @classmethod
    def _known_domains(cls, values: list[str], info) -> list[str]:
        # Which catalog applies depends on the implementation, which lives
        # on the owning DatasetConfig, not in params, so it arrives as
        # validation CONTEXT (pydantic validates fields in declaration order).
        if dataset_implementation(implementation_from_context(info.context), info.data) == "grib":
            if len(values) != 1:
                raise ValueError(
                    "a grib weather dataset needs exactly one product "
                    "in domains"
                )
            try:
                gribfetch.product_for(values[0])
            except KeyError as e:
                raise ValueError(str(e)) from e
            return values
        for value in values:
            try:
                domains.grid_for_domain(value)
            except KeyError as e:
                raise ValueError(str(e)) from e
        return values


class WeatherAnyIngestRunner:
    """Both bake mechanisms behind ONE object, bound to the same dataset
    directory. A runner factory only sees the directory, never ``params``,
    so the concrete class can't be picked until :func:`_weather_trigger` runs."""

    busy_error = (WeatherIngestError, WeatherGribIngestError)

    def __init__(self, dataset_dir: Path) -> None:
        self.om = WeatherIngestRunner(dataset_dir, keep_names=upstream_names_for)
        self.grib = WeatherGribIngestRunner(dataset_dir)
        self.active: WeatherIngestRunner | WeatherGribIngestRunner = self.om

    def status(self) -> dict:
        return self.active.status()

    def busy(self) -> bool:
        return self.om.busy() or self.grib.busy()


def _weather_runner_factory(dataset_dir: Path) -> WeatherAnyIngestRunner:
    """The declarative bake path's runner, bound to ``dataset_dir``. Same
    shape as ``_poi_runner_factory``/``_satellite_runner_factory``; see
    :class:`WeatherAnyIngestRunner` for why it wraps both bake mechanisms."""
    return WeatherAnyIngestRunner(dataset_dir)


def _weather_trigger(
    runner: IngestRunner,
    region: Region | None,
    params: BaseModel | None,
    implementation: str | None = None,
) -> None:
    """The generic ``POST /datasets/{id}/ingest`` trigger for a weather
    dataset. ``region`` is accepted but INTENTIONALLY unused — neither an
    Open-Meteo domain's grid nor a DWD GRIB product's grid can be bbox-clipped."""
    del region
    if not isinstance(params, WeatherDatasetParams):
        raise ValueError("a weather dataset needs params.domains")
    if not params.domains:
        # Unreachable through normal validation (`domains` has `min_length=1`)
        # — guarded anyway so a bake never IndexErrors into a 500 instead of
        # a clean 422/409 if this is ever reached some other way.
        raise ValueError("a weather bake needs at least one domain in params.domains")
    any_runner = cast(WeatherAnyIngestRunner, runner)
    if dataset_implementation(implementation, params) == "grib":
        any_runner.active = any_runner.grib
        any_runner.grib.ingest(
            product_id=params.domains[0], max_forecast_hours=params.max_forecast_hours
        )
    else:
        any_runner.active = any_runner.om
        # A scheduled bake only ever mirrors the FIRST domain (see
        # WeatherDatasetParams for the one-domain-per-entry convention).
        any_runner.om.ingest(
            domain=params.domains[0], max_forecast_hours=params.max_forecast_hours
        )


def weather_data_provider(config: Config, runtime: WeatherRuntime) -> DataProvider:
    """Open-Meteo range-cache proxy AND a bakeable mirror. Concrete ``.om``
    runs are immutable, so serving has no invalidation. ``artifact=
    "file-mirror"`` names the SHAPE, not the ``.om``/GRIB2 format filling it."""
    w = config.weather
    proxy = runtime.proxy()
    return DataProvider(
        id="weather",
        label="Weather (offline forecast)",
        kind="range-mirror",
        cache=CachePolicy(
            budget_bytes=w.cache_budget_bytes,
            tier="disk",
            negative="none",
            single_flight=True,
        ),
        refresh=Refresh("immutable"),
        prefetch=None,
        config_slice="weather",
        stats=proxy.stats,
        ingest=IngestSpec(
            id="weather",
            source="http",
            out_dir_slice="weather",
            region="none",
            artifact="file-mirror",
            params_model=WeatherDatasetParams,
            runner_factory=_weather_runner_factory,
            trigger=_weather_trigger,
        ),
    )
