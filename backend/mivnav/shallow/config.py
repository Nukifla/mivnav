# SPDX-License-Identifier: GPL-2.0-only
"""The shallow-water alarm's settings — boat-wide, like the collision alarm:
it runs on the server and is published to SignalK for every display at once."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from mivnav.config.base import Frozen

#: Same vocabulary as the collision alarm (``mivnav.collision.config.CpaMode``):
#: ``off`` raises nothing; ``show`` raises a silent notification; ``tell``
#: raises the sounding alarm.
ShallowMode = Literal["off", "show", "tell"]


class ShallowConfig(Frozen):
    """Read live on every snapshot — nothing is built from it, so an edit
    takes effect on the next tick with nothing to rebuild. Also sent to every
    browser in the snapshot (``shallowSettings``).

    The threshold is a plain depth BELOW THE SURFACE, ``depth_m`` — set in
    the settings, not derived from the boat's draft (user, 2026-11-06: one
    number you can see beats a draft + margin you can't). See :mod:`.watch`
    for which sounder reading it is compared with.
    """

    #: ``off`` / ``show`` / ``tell`` — see :data:`ShallowMode`.
    mode: ShallowMode = "tell"
    #: mivnav screens sound and vibrate for an unacknowledged alarm (``tell``
    #: only). Off = the screens only show it; SignalK's notification still
    #: sounds on the MFD, KIP etc.
    sound: bool = True
    #: Raise a SignalK notification at all.
    publish: bool = True
    #: Alarm when the water is shallower than this (metres below the surface).
    depth_m: float = Field(default=3.0, gt=0, le=100)
    #: The alarm clears only once the (filtered) depth is this much deeper
    #: than the threshold — a sounder hunting around the line must not flap.
    hysteresis_m: float = Field(default=0.5, ge=0, le=10)
