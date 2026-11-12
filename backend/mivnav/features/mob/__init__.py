# SPDX-License-Identifier: GPL-2.0-only
"""Man overboard. One mark, self-contained (not a general marks system):
dropped at the boat's position, persisted on this server, raised on SignalK
as ``notifications.mob`` (emergency) by :mod:`.publisher` until a human
clears it, mirrored as a SignalK waypoint resource so other apps see it, and
offered as a SignalK course destination ("navigate to MOB").

No re-exports, for the reason :mod:`mivnav.features.route` gives.
"""
