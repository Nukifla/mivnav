# SPDX-License-Identifier: GPL-2.0-only
"""The ``ocharts`` feature's ``/providers`` descriptor."""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import CachePolicy, DataProvider, IngestSpec, Refresh
from mivnav.features.ocharts.runtime import OchartsRuntime


def ocharts_data_provider(config: Config, runtime: OchartsRuntime) -> DataProvider:
    """o-charts on-demand tiling — modelled as ONE provider: its four RAM
    byte-LRUs (decoded cells, encoded tiles, routing `HazardIndex`es and
    `LandHazardBake`s) share one policy shape and one combined budget, with
    ``stats()`` reporting their breakdown separately."""
    o = config.ocharts
    service = runtime.service()

    def stats() -> dict:
        return {
            "cell_cache": service.cells.stats(),
            "tile_cache": service.tiles.stats(),
            "hazard_cache": service.hazards.stats(),
            "land_bake_cache": service.land_bakes.stats(),
            "render_gate": service.render_gate.stats(),
            "sets": len(service.sets()),
        }

    return DataProvider(
        id="ocharts",
        label="o-charts",
        kind="tiled",
        cache=CachePolicy(
            budget_bytes=o.cell_budget_bytes
            + o.tile_budget_bytes
            + o.hazard_budget_bytes
            + o.land_bake_budget_bytes,
            tier="ram",
            negative="error-memo",
            single_flight=True,
        ),
        refresh=Refresh("sequence-rescan", interval=o.rescan_interval_s),
        prefetch="overview" if o.prefetch else None,
        config_slice="ocharts",
        stats=stats,
        # No params_model/runner_factory (unlike POI/satellite): see
        # docs/architecture/ocharts-runtime-lifecycle.md for why the shop
        # Installer stays standalone.
        ingest=IngestSpec(
            id="ocharts",
            source="ocharts-shop",
            out_dir_slice="ocharts",
            region="chart-set",
            artifact="ocharts-set",
        ),
    )
