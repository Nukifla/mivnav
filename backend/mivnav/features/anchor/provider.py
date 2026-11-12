# SPDX-License-Identifier: GPL-2.0-only
"""The ``anchor`` feature's ``/providers`` descriptor — same shape and
reasoning as the autopilot's: live state rides the ``signalk`` descriptor,
this reports whether commanding the plugin is wired up."""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import DataProvider, Refresh
from mivnav.features.anchor.runtime import AnchorRuntime


def anchor_data_provider(config: Config, runtime: AnchorRuntime) -> DataProvider:
    """Whether commanding the anchor alarm is wired up. The live state
    rides the ``signalk`` descriptor, like the autopilot's."""
    del runtime

    def stats() -> dict:
        enabled = config.signalk.enabled
        return {
            "enabled": enabled,
            "token_configured": bool(config.credentials.signalk.token.get_secret_value()),
            "url": config.signalk.v1_self_url if enabled else None,
        }

    return DataProvider(
        id="anchor",
        label="Anchor watch",
        kind="live-stream",
        cache=None,
        refresh=Refresh("live"),
        prefetch=None,
        config_slice="signalk",
        stats=stats,
    )
