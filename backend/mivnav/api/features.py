# SPDX-License-Identifier: GPL-2.0-only
"""The one explicit static list of every registered ``Feature`` — a plain
tuple, not runtime discovery. Its own module rather than living in
``api/deps.py``: see docs/architecture/composition-root-cycle.md."""

from __future__ import annotations

from mivnav.feature import Feature
from mivnav.plugins import plugin_features
from mivnav.features.anchor.routes import FEATURE as ANCHOR
from mivnav.features.autopilot.routes import FEATURE as AUTOPILOT
from mivnav.features.buddies.routes import FEATURE as BUDDIES
from mivnav.features.marks.routes import FEATURE as MARKS
from mivnav.features.mob.routes import FEATURE as MOB
from mivnav.features.notices.routes import FEATURE as NOTICES
from mivnav.features.ocharts.routes import FEATURE as OCHARTS
from mivnav.features.osm_world.routes import FEATURE as OSM_WORLD
from mivnav.features.poi.routes import FEATURE as POI
from mivnav.features.route.routes import FEATURE as ROUTE
from mivnav.features.routing.routes import FEATURE as ROUTING
from mivnav.features.satellite.routes import FEATURE as SATELLITE
from mivnav.features.themes.routes import FEATURE as THEMES
from mivnav.features.track.routes import FEATURE as TRACK
from mivnav.features.weather.routes import FEATURE as WEATHER

FEATURES: tuple[Feature, ...] = (
    POI,
    OSM_WORLD,
    SATELLITE,
    OCHARTS,
    WEATHER,
    AUTOPILOT,
    ANCHOR,
    ROUTE,
    ROUTING,
    THEMES,
    TRACK,
    NOTICES,
    BUDDIES,
    MARKS,
    MOB,
    # Out-of-tree plugins (mivnav.plugins), after every built-in feature so a
    # plugin's routes can never shadow a built-in one.
    *plugin_features(),
)

__all__ = ["FEATURES"]
