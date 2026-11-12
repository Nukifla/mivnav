# SPDX-License-Identifier: GPL-2.0-only
"""The SignalK shape of the MOB alarm — the value :mod:`.publisher` writes to
``notifications.mob``. The read half (SignalK's echo, ours or anyone's) is
:mod:`mivnav.signalk.mob`, folded by the tracker.

``notifications.mob`` is the spec's man-overboard path, the one Freeboard,
KIP and the N2K emitter already know; ``emergency`` is the top ALARM_STATE.
Ours is told apart by ``data.publisher``, like the collision alarm's.
"""

from __future__ import annotations

from typing import Any

from mivnav.features.mob.store import Mob

PATH = "notifications.mob"
PUBLISHER = "mivnav"


def value_for(mob: Mob | None) -> dict[str, Any]:
    """The raise for an active MOB, or the clear (``normal``, no method)."""
    if mob is None:
        return {"state": "normal", "method": [], "message": "", "data": {"publisher": PUBLISHER}}
    value: dict[str, Any] = {
        "state": "emergency",
        "method": ["visual", "sound"],
        "message": "Man overboard!",
        "createdAt": mob.at,
        "data": {"publisher": PUBLISHER, "mobId": mob.id, "source": mob.source},
    }
    if mob.has_position:
        value["position"] = {"latitude": mob.lat, "longitude": mob.lng}
    return value
