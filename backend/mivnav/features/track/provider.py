# SPDX-License-Identifier: GPL-2.0-only
"""The ``track`` feature's ``/providers`` descriptor.

``stats()`` deliberately does not probe whether a history plugin is
installed — it backs a status page and must not fire an HTTP request at
the boat's SignalK box. That answer belongs to a real request, see
:mod:`mivnav.features.track.routes`.
"""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import DataProvider, Refresh
from mivnav.features.track.client import POLL_INTERVAL_S
from mivnav.features.track.runtime import TrackRuntime


def track_data_provider(config: Config, runtime: TrackRuntime) -> DataProvider:
    """``runtime`` is unused (no live object to read stats off) but is
    threaded through for the shared ``Feature.data_provider`` signature."""
    del runtime

    def stats() -> dict:
        enabled = config.signalk.enabled
        return {
            "enabled": enabled,
            # Never the token itself — a status surface, not `/config`.
            "token_configured": bool(config.credentials.signalk.token.get_secret_value()),
            "url": config.signalk.history_url if enabled else None,
        }

    return DataProvider(
        id="track",
        label="Ship track",
        kind="history-query",
        cache=None,
        refresh=Refresh("ttl", interval=POLL_INTERVAL_S),
        prefetch=None,
        config_slice="signalk",
        stats=stats,
    )
