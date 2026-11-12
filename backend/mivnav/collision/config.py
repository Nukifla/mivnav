# SPDX-License-Identifier: GPL-2.0-only
"""The collision alarm's thresholds — boat-wide, because the alarm now lives
on the server and is published to SignalK for every display at once."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from mivnav.config.base import Frozen


#: How loud the alarm is, for the whole boat: ``off`` draws no CPA line and
#: raises nothing; ``show`` draws the line and raises a silent notification;
#: ``tell`` raises the sounding alarm.
CpaMode = Literal["off", "show", "tell"]


class CollisionConfig(Frozen):
    """Read live on every snapshot — nothing is built from it, so there is no
    ``Derived`` to rebuild and an edit takes effect on the next publish tick.
    Also sent to every browser in the snapshot (``collisionSettings``), so
    every screen colours targets and sounds with the same settings.

    Defaults are exactly what the browser-side alarm used before it moved
    here (``chrome/core.ts``'s ``CPA_THRESHOLDS`` and the per-device
    ``cpaAlarm*`` settings' defaults), so the move changes no alarm. Both
    tiers are CPA *and* TCPA, OpenCPN's conjunction. The chart's target
    colouring uses the same numbers: red on the chart is "the alarm fires".
    """

    #: ``off`` / ``show`` / ``tell`` — see :data:`CpaMode`.
    mode: CpaMode = "tell"
    #: mivnav screens sound and vibrate for an unacknowledged alarm (``tell``
    #: only), whether or not it reached SignalK. Off = the screens only show
    #: it; a SignalK notification still sounds on the MFD, KIP etc.
    sound: bool = True
    #: Raise SignalK notifications at all. Off = the assessment still runs
    #: and every screen still shows and sounds it; nothing is written to SignalK.
    publish: bool = True
    #: Red (``alarm``, sounds): a target passing closer than this ...
    danger_nm: float = Field(default=0.3, gt=0)
    #: ... within this many minutes.
    horizon_min: float = Field(default=15.0, gt=0)
    #: Yellow (``warn``, visual only): closer than this ...
    warning_nm: float = Field(default=1.0, gt=0)
    #: ... within this many minutes.
    warning_horizon_min: float = Field(default=30.0, gt=0)
    #: At or below this SOG a vessel is at rest: its COG is GPS jitter.
    #: OpenCPN's ``g_SOGminCOG_kts``.
    at_rest_kn: float = Field(default=0.2, ge=0, le=5)
