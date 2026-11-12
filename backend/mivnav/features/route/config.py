# SPDX-License-Identifier: GPL-2.0-only
"""The ``route`` feature's config slice: whether mivnav's active leg tracks
SignalK's own reported course. mivnav no longer computes arrival itself
(#yprzuqtt) — see docs/architecture/route-nav-config.md."""

from __future__ import annotations

from pydantic import Field

from mivnav.config.base import Frozen


class NavConfig(Frozen):
    """Whether mivnav's active leg tracks SignalK's own course, and how
    closely. Read live by the watcher on every message — no ``Derived`` to
    rebuild or invalidate."""

    #: Two-way sync with SignalK's course (#svotsyyy, #yprzuqtt): a matching
    #: SignalK course is adopted as a store write only, never republished.
    #: ``False`` = fully manual. See docs/architecture/route-nav-config.md.
    course_sync: bool = True
    #: Distance (m) for matching a SignalK-reported course point to one of
    #: mivnav's own waypoints (#svotsyyy) — the v2 Course API reports only a
    #: coordinate, never a waypoint id, so this is nearest-within-tolerance.
    course_match_tolerance_m: float = Field(default=10.0, gt=0)
