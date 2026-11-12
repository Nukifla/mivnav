# SPDX-License-Identifier: GPL-2.0-only
"""The ``themes`` feature's ``/providers`` descriptor (``kind="static-asset"``
— see docs/architecture/feature-abstraction-backend.md's ``Kind`` section).
``refresh`` IS honest: :class:`.ThemeStore` rescans every request."""

from __future__ import annotations

from mivnav.config.model import Config
from mivnav.feature import DataProvider, Refresh
from mivnav.features.themes.runtime import ThemesRuntime
from mivnav.features.themes.store import user_theme_dir


def themes_data_provider(config: Config, runtime: ThemesRuntime) -> DataProvider:
    del config  # no config slice — themes owns no config fields

    def stats() -> dict:
        snapshot = runtime.store().snapshot()
        return {
            "themes": len(snapshot.themes),
            "ids": list(snapshot.ids),
            # Reported because "my edit did nothing" is the one support
            # question this feature will generate, and this is the answer.
            "user_dir": str(user_theme_dir()),
        }

    return DataProvider(
        id="themes",
        label="Themes",
        kind="static-asset",
        cache=None,
        refresh=Refresh("sequence-rescan"),
        prefetch=None,
        config_slice=None,
        stats=stats,
    )
