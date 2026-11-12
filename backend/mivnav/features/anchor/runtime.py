# SPDX-License-Identifier: GPL-2.0-only
"""The ``anchor`` feature's runtime: a fresh :class:`AnchorClient` per call,
for the same reason as the autopilot's (docs/architecture/
autopilot-client-lifecycle.md) — a config edit or a newly granted token
takes effect on the next button press, with nothing cached to rebuild."""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import FeatureCtx
from mivnav.features.anchor.client import AnchorClient


def build_anchor_client(config: Config) -> AnchorClient:
    sk = config.signalk
    return AnchorClient(
        sk.v1_self_url if sk.enabled else None,
        sk.notifications_url if sk.enabled else None,
        config.credentials.signalk.token.get_secret_value(),
    )


class AnchorRuntime:
    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config

    def client(self) -> AnchorClient:
        return build_anchor_client(self._config.get())

    def close(self) -> None:
        """No-op: nothing held. Required by :class:`~mivnav.feature.FeatureRuntime`."""


def build_anchor_runtime(ctx: FeatureCtx) -> AnchorRuntime:
    return AnchorRuntime(ctx)
