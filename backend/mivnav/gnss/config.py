# SPDX-License-Identifier: GPL-2.0-only
"""The GNSS-lost and connection alarms' settings — boat-wide, like the
collision alarm's: the GNSS watch runs on the server and is published to
SignalK, and every screen raises the connection alarms by the same numbers
(they ride every snapshot as ``gnssSettings``)."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from mivnav.config.base import Frozen

#: ``off`` raises nothing; ``show`` raises a silent notification (the rail
#: tile, a visual-only SignalK notification); ``tell`` raises the sounding
#: alarm. Same words as the collision alarm's ``CpaMode``.
AlarmMode = Literal["off", "show", "tell"]

#: Seconds of continuous silence before a loss is an alarm: a GPS reports at
#: 1 Hz, so a brief dropout (a missed sentence, a wifi hiccup) never alarms.
DEFAULT_DELAY_S = 5.0


class GnssConfig(Frozen):
    """Read live on every snapshot — nothing is built from it, so an edit
    takes effect on the next publish tick, nothing re-dials."""

    #: ``off`` / ``show`` / ``tell`` for the GNSS-lost alarm, and for the
    #: connection alarms when :attr:`connection` is on.
    mode: AlarmMode = "tell"
    #: mivnav screens sound and vibrate for an unacknowledged alarm (``tell``
    #: only). A SignalK notification sounds on the MFD/KIP regardless.
    sound: bool = True
    #: Raise the GNSS-lost alarm as a SignalK notification.
    publish: bool = True
    #: Also alarm on screens when a screen loses the mivnav server, or the
    #: server loses SignalK — neither can reach SignalK, so screens only.
    connection: bool = True
    #: Continuous loss, in seconds, before any of these alarms is raised.
    delay_s: float = Field(default=DEFAULT_DELAY_S, ge=1, le=120)
