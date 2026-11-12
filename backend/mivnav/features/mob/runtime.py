# SPDX-License-Identifier: GPL-2.0-only
"""The ``mob`` feature's runtime: the store (held, like the route store —
a ``Derived`` would drop it on a config edit), and a fresh client per call
like every other SignalK writer here."""

from __future__ import annotations

from pathlib import Path

from mivnav.config.model import Config
from mivnav.feature import FeatureCtx
from mivnav.features.mob.client import MobClient
from mivnav.features.mob.store import MobStore


def build_mob_client(config: Config) -> MobClient:
    sk = config.signalk
    return MobClient(
        sk.course_url if sk.enabled else None,
        sk.resources_url if sk.enabled else None,
        config.credentials.signalk.token.get_secret_value(),
    )


class MobRuntime:
    def __init__(self, ctx: FeatureCtx, path: Path | None = None) -> None:
        self._config = ctx.config
        self.store = MobStore(path)

    def client(self) -> MobClient:
        return build_mob_client(self._config.get())

    def close(self) -> None:
        """No-op: the store writes through on every change."""


def build_mob_runtime(ctx: FeatureCtx) -> MobRuntime:
    return MobRuntime(ctx)
