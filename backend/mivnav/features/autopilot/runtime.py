# SPDX-License-Identifier: GPL-2.0-only
"""The ``autopilot`` feature's runtime: a fresh :class:`AutopilotClient` per
call, deliberately NOT a :class:`~mivnav.config.derived.Derived` — see
docs/architecture/autopilot-client-lifecycle.md for why."""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import FeatureCtx
from mivnav.features.autopilot.client import AutopilotClient


def build_autopilot_client(config: Config) -> AutopilotClient:
    """Takes the whole ``Config`` rather than a slice: the SignalK host and
    token live in different subtrees. ``enabled: false`` yields a client
    with no URL rather than no client."""
    return AutopilotClient(
        config.signalk.autopilot_url if config.signalk.enabled else None,
        config.credentials.signalk.token.get_secret_value(),
    )


class AutopilotRuntime:
    """This feature's one piece of "runtime": a config handle to build a
    fresh :class:`AutopilotClient` from. No store, no service, nothing to
    close — see docs/architecture/autopilot-client-lifecycle.md."""

    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config

    def client(self) -> AutopilotClient:
        return build_autopilot_client(self._config.get())

    def close(self) -> None:
        """No-op: this runtime holds no resource. Required by
        :class:`~mivnav.feature.FeatureRuntime`."""


def build_autopilot_runtime(ctx: FeatureCtx) -> AutopilotRuntime:
    return AutopilotRuntime(ctx)
