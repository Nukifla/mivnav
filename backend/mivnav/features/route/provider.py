# SPDX-License-Identifier: GPL-2.0-only
"""The ``route`` feature's ``/providers`` descriptor. See
docs/architecture/route-storage-signalk.md for the ``kind``/``cache=None``
reasoning and the ``route_storage`` stats field."""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import DataProvider, Refresh
from mivnav.features.route.runtime import RouteRuntime


def route_data_provider(config: Config, runtime: RouteRuntime) -> DataProvider:
    """See the module docstring. ``runtime`` is unused today, but still
    threaded through for the shared ``Feature.data_provider`` signature."""
    del runtime

    def stats() -> dict:
        nav = config.nav
        return {
            "course_sync": nav.course_sync,
            "course_match_tolerance_m": nav.course_match_tolerance_m,
            "signalk_enabled": config.signalk.enabled,
            "route_storage": "signalk" if config.signalk.enabled else "none",
        }

    return DataProvider(
        id="route",
        label="Route",
        kind="live-stream",
        cache=None,
        refresh=Refresh("live"),
        prefetch=None,
        config_slice="nav",
        stats=stats,
    )
