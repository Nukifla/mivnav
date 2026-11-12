# SPDX-License-Identifier: GPL-2.0-only
"""The ``autopilot`` feature's ``/providers`` descriptor.

Live autopilot state already rides the ``signalk`` descriptor
(:mod:`mivnav.data.provider`'s ``_signalk_provider``); duplicating it here
would be two ``/providers`` entries answering the same question. This one
instead reports whether *commanding* the pilot is wired up right now.
"""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import DataProvider, Refresh
from mivnav.features.autopilot.runtime import AutopilotRuntime


def autopilot_data_provider(config: Config, runtime: AutopilotRuntime) -> DataProvider:
    """``runtime`` is unused (no live object to read stats off) but is
    threaded through for the shared ``Feature.data_provider`` signature."""
    del runtime

    def stats() -> dict:
        enabled = config.signalk.enabled
        return {
            "enabled": enabled,
            # Never the token itself — this is a status surface, not
            # `/config`, and `stats()` is not covered by
            # `mivnav.config.model.SECRET_FIELDS`/`redacted()`.
            "token_configured": bool(config.credentials.signalk.token.get_secret_value()),
            "url": config.signalk.autopilot_url if enabled else None,
        }

    return DataProvider(
        id="autopilot",
        label="Autopilot",
        kind="live-stream",
        cache=None,
        refresh=Refresh("live"),
        prefetch=None,
        config_slice="signalk",
        stats=stats,
    )
