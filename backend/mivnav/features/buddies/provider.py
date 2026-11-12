# SPDX-License-Identifier: GPL-2.0-only
"""The ``buddies`` feature's ``/providers`` descriptor."""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import DataProvider, Refresh
from mivnav.features.buddies.runtime import BuddiesRuntime


def buddies_data_provider(config: Config, runtime: BuddiesRuntime) -> DataProvider:
    del config
    return DataProvider(
        id="buddies",
        label="Buddies",
        kind="live-stream",
        cache=None,
        refresh=Refresh("live"),
        prefetch=None,
        config_slice="signalk",
        stats=runtime.stats,
    )
