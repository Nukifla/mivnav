# SPDX-License-Identifier: GPL-2.0-only
"""The ``route`` feature's runtime: a fresh :class:`CourseClient` per call,
deliberately NOT a :class:`~mivnav.config.derived.Derived`. See
docs/architecture/autopilot-client-lifecycle.md's ``route/runtime.py``
section for why, and why the route STORE does not live here.
"""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import FeatureCtx
from mivnav.features.route.client import CourseClient


def build_course_client(config: Config) -> CourseClient:
    """The Course API client for this config. ``enabled: false`` yields a
    client with no URL rather than no client, so callers always have an
    object; the publish path additionally gates on the token."""
    return CourseClient(
        config.signalk.course_url if config.signalk.enabled else None,
        config.signalk.resources_url if config.signalk.enabled else None,
        config.credentials.signalk.token.get_secret_value(),
    )


def build_route_resources(config: Config) -> CourseClient | None:
    """The Resources-API client the route STORE persists through, or ``None``
    when SignalK is disabled (``RouteStore`` then refuses writes, #vozswkrl) —
    distinct from :func:`build_course_client`'s "no URL" publishing case."""
    return build_course_client(config) if config.signalk.enabled else None


class RouteRuntime:
    """A config handle to build a fresh :class:`CourseClient` from. No
    store, no service, nothing to close — see module docstring for why
    this is deliberately NOT a ``Derived``."""

    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config

    def course(self) -> CourseClient:
        return build_course_client(self._config.get())

    def close(self) -> None:
        """No-op: this runtime holds no resource. Required by
        :class:`~mivnav.feature.FeatureRuntime`."""


def build_route_runtime(ctx: FeatureCtx) -> RouteRuntime:
    return RouteRuntime(ctx)
