# SPDX-License-Identifier: GPL-2.0-only
"""Autopilot commands, over SignalK's v2 Autopilot API.

Only the write half lives here (:mod:`mivnav.features.autopilot.client`);
the read half stays embedded in :class:`mivnav.signalk.model.VesselTracker`
— moving it would make kernel ``mivnav.signalk.model`` import a feature, the
edge ``backend/.importlinter``'s ``feature-independence`` contract forbids.
See docs/architecture/feature-package-boundaries.md.
"""

from mivnav.features.autopilot.client import (
    DEFAULT_PILOT,
    AutopilotClient,
    AutopilotError,
    AutopilotRefused,
    AutopilotUnauthorized,
    AutopilotUnavailable,
    AutopilotUnreachable,
)

__all__ = [
    "DEFAULT_PILOT",
    "AutopilotClient",
    "AutopilotError",
    "AutopilotRefused",
    "AutopilotUnauthorized",
    "AutopilotUnavailable",
    "AutopilotUnreachable",
]
