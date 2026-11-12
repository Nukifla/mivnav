# SPDX-License-Identifier: GPL-2.0-only
"""The autopilot's live state, folded from the SignalK delta stream.

The command client moved to :mod:`mivnav.features.autopilot.client`; this
half deliberately did not — it is embedded in
:class:`mivnav.signalk.model.VesselTracker`, and moving it would make kernel
``mivnav.signalk`` import a feature, forbidden by
``backend/.importlinter``'s ``feature-independence`` contract.
"""

from .model import Autopilot, AutopilotState

__all__ = [
    "Autopilot",
    "AutopilotState",
]
