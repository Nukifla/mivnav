# SPDX-License-Identifier: GPL-2.0-only
"""The ``routing`` feature's ``/providers`` descriptor.

Same shape as ``mivnav.features.autopilot.provider`` for the same reason:
this is a compute API with nothing of its own to cache or bake (today —
see ``ROUTING_TODO.md``), so ``cache=None``, ``ingest=None``, and ``stats``
reports capability rather than dataset size.
"""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import DataProvider, Refresh
from mivnav.features.routing.runtime import RoutingRuntime


def routing_data_provider(config: Config, runtime: RoutingRuntime) -> DataProvider:
    del config, runtime  # nothing to read yet — see runtime.py's docstring

    def stats() -> dict:
        return {"algorithm": "straight-line placeholder — no hazard avoidance yet"}

    return DataProvider(
        id="routing",
        kind="live-stream",
        cache=None,
        refresh=Refresh("live"),
        prefetch=None,
        config_slice=None,
        label="Routing",
        stats=stats,
    )
