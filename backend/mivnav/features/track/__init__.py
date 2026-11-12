# SPDX-License-Identifier: GPL-2.0-only
"""The ship's track — where this boat has been, from SignalK's History API.
No local recording (only a rebuildable per-day cache of SignalK's answers,
see :mod:`mivnav.features.track.store`), no ``config.py``: see
docs/architecture/track-history-source.md for why.
"""

from mivnav.features.track.client import (
    DEFAULT_HOURS,
    MAX_HOURS,
    TrackClient,
    TrackError,
    TrackRefused,
    TrackUnavailable,
    TrackUnreachable,
    TrackUnsupported,
)

__all__ = [
    "DEFAULT_HOURS",
    "MAX_HOURS",
    "TrackClient",
    "TrackError",
    "TrackRefused",
    "TrackUnavailable",
    "TrackUnreachable",
    "TrackUnsupported",
]
