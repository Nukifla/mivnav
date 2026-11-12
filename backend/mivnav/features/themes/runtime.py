# SPDX-License-Identifier: GPL-2.0-only
"""The ``themes`` feature's runtime: one :class:`~mivnav.features.themes.
store.ThemeStore` for the process.

Not a :class:`~mivnav.config.derived.Derived`: there is no themes config
slice to key a rebuild on, and holding one store across requests is what
makes the per-request file-stamp check cheap. See
docs/architecture/themes-runtime-updatable.md.
"""

from __future__ import annotations

from mivnav.feature import FeatureCtx
from mivnav.features.themes.store import ThemeStore


class ThemesRuntime:
    def __init__(self, ctx: FeatureCtx) -> None:
        del ctx  # no config slice, no search index — see the module docstring
        self._store = ThemeStore()

    def store(self) -> ThemeStore:
        return self._store

    def close(self) -> None:
        """No-op: this runtime holds no resource. Required by
        :class:`~mivnav.feature.FeatureRuntime`."""


def build_themes_runtime(ctx: FeatureCtx) -> ThemesRuntime:
    return ThemesRuntime(ctx)
