# SPDX-License-Identifier: GPL-2.0-only
"""The ``weather`` feature's runtime: the proxy and renderer lifecycles as
two SEPARATE ``Derived``s over the SAME config slice, plus ``mirror()``
(baked datasets, consulted before the proxy). See
docs/architecture/weather-runtime.md.
"""

from __future__ import annotations

from mivnav.config import Derived
from mivnav.config.base import dataset_dir
from mivnav.feature import FeatureCtx
from mivnav.features.weather.config import WeatherConfig
from mivnav.features.weather.gribstore import GribStore
from mivnav.features.weather.mirror import WeatherMirror
from mivnav.features.weather.proxy import WeatherProxy
from mivnav.features.weather.renderer import WeatherRenderer
from mivnav.features.weather.sources import dataset_implementation


def build_weather_proxy(cfg: WeatherConfig) -> WeatherProxy:
    """The weather range-cache proxy for this config slice. No `close`: the
    HTTP client is process-level, closed in the app lifespan."""
    return WeatherProxy(
        cache_dir=cfg.cache_dir,
        cache_budget=cfg.cache_budget_bytes,
        tiles_url=cfg.upstream_tiles_url,
        forecast_url=cfg.upstream_forecast_url,
        chunk_bytes=cfg.chunk_bytes,
        latest_ttl=cfg.latest_ttl_seconds,
        prewarm_neighbours=cfg.prewarm_neighbours,
    )


def build_weather_renderer(cfg: WeatherConfig) -> WeatherRenderer:
    """The server-side wash/wind tile renderer for this config slice. No
    `close`: its decode LRU and tile cache are plain dicts/a directory,
    fine to just drop."""
    return WeatherRenderer(
        render_cache_dir=cfg.render_cache_dir,
        render_cache_budget_bytes=cfg.render_cache_budget_bytes,
        render_max_zoom=cfg.render_max_zoom,
        wind_tex_max_zoom=cfg.wind_tex_max_zoom,
    )


class WeatherRuntime:
    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config
        self.proxies: Derived[WeatherConfig, WeatherProxy] = Derived(
            "weather proxy",
            select=lambda c: c.weather,
            build=build_weather_proxy,
        )
        self.renderers: Derived[WeatherConfig, WeatherRenderer] = Derived(
            "weather renderer",
            select=lambda c: c.weather,
            build=build_weather_renderer,
        )

    def proxy(self) -> WeatherProxy:
        return self.proxies.get(self._config.get())

    def renderer(self) -> WeatherRenderer:
        return self.renderers.get(self._config.get())

    def mirror(self) -> WeatherMirror:
        """A :class:`~mivnav.features.weather.mirror.WeatherMirror` over
        every declared ``weather`` dataset's own directory. Built fresh on
        every call, not cached — cheap until a path is actually resolved,
        so there's no invalidation to get wrong. See
        docs/architecture/weather-runtime.md for the root-path convention."""
        config = self._config.get()
        roots = [
            dataset_dir(config.data_root, "weather", ds.id)
            for ds in config.datasets
            # live-cache datasets and disabled ones are excluded — see
            # docs/architecture/weather-runtime.md
            if ds.provider == "weather" and ds.mode == "bake" and ds.enabled
        ]
        return WeatherMirror(roots)

    def grib_datasets(self) -> list[tuple[str, str]]:
        """``(dataset_id, product_id)`` for every currently ENABLED,
        GRIB-sourced ``weather`` dataset — ``GET /weather/baked``'s
        enumeration of GRIB holdings (the `.om`-only :meth:`mirror` says
        nothing about these). See docs/architecture/weather-runtime.md."""
        config = self._config.get()
        out: list[tuple[str, str]] = []
        for ds in config.datasets:
            if ds.provider != "weather" or not ds.enabled:
                continue
            params = ds.params if isinstance(ds.params, dict) else {}
            if dataset_implementation(ds.implementation, params) != "grib":
                continue
            domains = params.get("domains")
            if isinstance(domains, list) and domains and isinstance(domains[0], str):
                out.append((ds.id, domains[0]))
        return out

    def grib_store(self, dataset_id: str, product_id: str) -> GribStore:
        """A :class:`~mivnav.features.weather.gribstore.GribStore` over one
        dataset's ``grib/<product_id>/`` — the GRIB-sourced tile routes'
        equivalent of :meth:`mirror`. Raises :class:`KeyError` for a
        dataset_id naming a currently DISABLED weather dataset, so callers'
        existing ``except (KeyError, ValueError): 404`` handles it. See
        docs/architecture/weather-runtime.md."""
        config = self._config.get()
        disabled = any(
            ds.id == dataset_id and ds.provider == "weather" and not ds.enabled
            for ds in config.datasets
        )
        if disabled:
            raise KeyError(f"weather dataset {dataset_id!r} is disabled")
        return GribStore(dataset_dir(config.data_root, "weather", dataset_id), product_id)

    def close(self) -> None:
        self.proxies.dispose()
        self.renderers.dispose()


def build_weather_runtime(ctx: FeatureCtx) -> WeatherRuntime:
    return WeatherRuntime(ctx)
