# SPDX-License-Identifier: GPL-2.0-only
"""The ``routing`` feature's runtime — the ``.mivnav`` artifact build
runner, and nothing else.

Every route this feature SERVES is still computed statelessly from its
request body (see ``routes.py``): no store, no service, no config slice
to key a :class:`~mivnav.config.derived.Derived` on. What this runtime
now owns is the one long-lived thing the feature has: the background
build runner for the precomputed ``.mivnav`` artifact
(:mod:`mivnav.features.routing.artifact_build`).

**Why the runner is NOT a ``Derived``**, unlike POI's store: a
:class:`~mivnav.config.derived.Derived` is rebuilt whenever the config
slice it was keyed on changes, and this object owns a running background
thread — dropping it mid-build would orphan a job whose status nobody
could poll any more. It is a plain per-process singleton instead, and it
reads ``data_root``/``routing`` LIVE at the start of each build (the two
callables passed to its constructor), which is what makes a ``PATCH
/config`` take effect on the next build with no restart and no
re-minting. That is deliberately the opposite trade from
:class:`mivnav.features.poi.runtime.PoiRuntime`'s ingest runner, which
must be re-minted when its store identity moves; this runner holds no
store to go stale.
"""

from __future__ import annotations

import threading

from mivnav.config.model import Config
from mivnav.feature import FeatureCtx
from mivnav.features.routing.artifact_build import MivnavBuildRunner


class RoutingRuntime:
    def __init__(self, ctx: FeatureCtx) -> None:
        self._config = ctx.config
        self._build: MivnavBuildRunner | None = None
        self._build_lock = threading.Lock()

    def artifact_build_runner(self) -> MivnavBuildRunner:
        """The ``.mivnav`` build runner — one per process, created on
        first use. See the module docstring for why this is not keyed on
        a config slice."""
        with self._build_lock:
            if self._build is None:
                self._build = MivnavBuildRunner(
                    data_root=lambda: self._config.get().data_root,
                    catzoc_allowance_mode=(
                        lambda: self._config.get().routing.artifact_catzoc_allowance_mode
                    ),
                )
            return self._build

    def build_busy(self) -> bool:
        """Is a ``.mivnav`` build running right now? Read by
        :func:`routing_guard` — deliberately does NOT create a runner
        that does not exist yet (a boat that has never built anything is
        not busy, and a config guard must not have side effects)."""
        with self._build_lock:
            return self._build is not None and self._build.busy()

    def close(self) -> None:
        """Ask a running build to stop, then drop the reference.

        The cancel is NOT decoration: a build holds an
        ``OchartsService`` it was handed at trigger time and decodes
        through it for minutes, and this runtime is closed exactly when
        that service is about to be torn down (shutdown, or a
        config reload rebuilding the whole ``Runtime``). Letting the
        thread run on against a closed service would fail every
        remaining cell — which, since a skipped cell now FAILS the build
        (see :mod:`mivnav.features.routing.artifact_build`), is at least
        loud rather than a silently partial artifact, but asking it to
        stop first is better than relying on that. Not joined: this must
        return promptly, same posture as every other runner here
        (:meth:`mivnav.features.poi.runtime.PoiRuntime.close`).
        Publishing is atomic and a process-wide lock keeps a successor
        runtime's fresh runner from racing this one's tail, so a build
        finishing after this cannot corrupt what a later reader sees."""
        with self._build_lock:
            build, self._build = self._build, None
        if build is not None:
            build.cancel()


def routing_guard(runtime: RoutingRuntime, current: Config, candidate: Config) -> str | None:
    """Veto a config PATCH that would disrupt a running ``.mivnav``
    build — the same hook, and the same shape, as
    :func:`mivnav.features.ocharts.runtime.ocharts_guard`.

    A build holds the ``OchartsService`` it was handed at trigger time
    and decodes every cell of a chart set through it, for minutes. That
    service is a ``Derived`` keyed on the ocharts config slice and
    ``data_root``, so a patch touching either builds a replacement and
    CLOSES the one the build is still using (stopping ``oexserverd``,
    dropping its caches). Found by code review; the same patch would also
    move ``data_root``, i.e. where the build is about to publish.

    Only vetoes patches that would actually rebuild the service — a
    routing-weights edit mid-build is harmless and stays allowed."""
    if candidate.ocharts == current.ocharts and candidate.data_root == current.data_root:
        return None
    if runtime.build_busy():
        return (
            "a mivnav routing-artifact build is running; chart configuration "
            "cannot change until it finishes (POST /routing/mivnav/build/cancel "
            "to stop it)"
        )
    return None


def build_routing_runtime(ctx: FeatureCtx) -> RoutingRuntime:
    return RoutingRuntime(ctx)
