# SPDX-License-Identifier: GPL-2.0-only
"""The ``track`` feature's runtime: a fresh :class:`TrackClient` per call,
and the one :class:`TrackStore` whose day cache and live-day fixes outlive
requests.

The client is deliberately not a :class:`~mivnav.config.derived.Derived`:
it would have to be keyed on credentials excluded from every config slice
on purpose. Reading the secret per call is what makes a token edit take
effect with no rebuild. The store holds no config at all — its disk root
(``data_root/track``) is passed per call for the same reason.
"""

from __future__ import annotations

from pathlib import Path

from mivnav.config.base import provider_root
from mivnav.config.model import Config
from mivnav.feature import FeatureCtx
from mivnav.features.track.client import HistoryProvider, TrackClient
from mivnav.features.track.store import TrackResult, TrackStore


def build_track_client(config: Config) -> TrackClient:
    """The history client for this config.

    ``enabled: false`` yields a client with no URL rather than no client, so
    "no history" is a 503 with a reason instead of a ``None`` to trip over.
    """
    return TrackClient(
        config.signalk.history_url if config.signalk.enabled else None,
        config.credentials.signalk.token.get_secret_value(),
        provider=config.track.history_provider,
    )


def track_cache_root(config: Config) -> Path:
    """Under ``data_root`` rather than XDG cache: it outlives the history
    plugin's retention, so it is closer to the boat's data than to a cache
    you would clear, and it moves with the rest of the boat's data."""
    return provider_root(config.data_root, "track")


class TrackRuntime:
    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config
        self._store = TrackStore()

    def client(self) -> TrackClient:
        return build_track_client(self._config.get())

    def providers(self) -> list[HistoryProvider]:
        return self.client().providers()

    def selected_provider(self) -> str | None:
        return self._config.get().track.history_provider

    def track(self, hours: float | None) -> TrackResult:
        config = self._config.get()
        return self._store.track(
            build_track_client(config),
            track_cache_root(config),
            hours,
            past_contexts=config.track.past_contexts,
        )

    def close(self) -> None:
        """No-op: the store holds files, not handles. Required by
        :class:`~mivnav.feature.FeatureRuntime`."""


def build_track_runtime(ctx: FeatureCtx) -> TrackRuntime:
    return TrackRuntime(ctx)
