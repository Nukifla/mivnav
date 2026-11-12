# SPDX-License-Identifier: GPL-2.0-only
"""``/mob`` — man overboard: raise, clear, steer to it, ACK it.

Live state rides ``/signalk/stream`` (the snapshot's ``mob`` and
``mobNotice`` keys); ``GET /mob`` is for a screen with SignalK off, where
there is no stream to ride. Raising never depends on SignalK: the mark is
stored here first and :mod:`.publisher` raises it on SignalK as soon as it
can. Failure codes as the anchor's: 503 = our config (no SignalK / no write
access), 502 = the box did not answer or refused, 409 = the boat's state
says no (no MOB, no position).
"""

from __future__ import annotations

import logging
import math
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from mivnav.api.deps import Runtime, get_runtime, get_signalk
from mivnav.config.model import Config
from mivnav.feature import DataProvider, Feature, Refresh
from mivnav.features.mob.client import MobSignalKError
from mivnav.features.mob.runtime import MobRuntime, build_mob_runtime
from mivnav.signalk import SignalKService
from mivnav.signalk.notifications import AckError, AckRefused, AckUnavailable, AckUnreachable, acknowledge

log = logging.getLogger(__name__)

router = APIRouter(prefix="/mob")

__all__ = ["FEATURE", "router"]

#: SignalK's course counts as "steering to the MOB" within this of the mark —
#: what a clear also clears.
COURSE_MATCH_M = 50.0


def get_mob(runtime: Runtime = Depends(get_runtime)) -> MobRuntime:
    return cast(MobRuntime, runtime.feature("mob"))


class MobRaiseBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: The position the screen showed when the button went down. Absent =
    #: this server's own fix.
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class MobAckBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9-]+$")


@router.get("")
def get_active(mob: MobRuntime = Depends(get_mob)) -> dict[str, Any]:
    active = mob.store.active()
    return {"active": active.wire() if active else None}


@router.post("")
def raise_mob(
    body: MobRaiseBody | None = None,
    mob: MobRuntime = Depends(get_mob),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, Any]:
    """Drop the mark. Never refuses: with no fix anywhere the alarm still
    goes up, without a position. A MOB already up is kept, not moved."""
    lat = body.lat if body else None
    lng = body.lng if body else None
    if lat is None or lng is None:
        own = signalk.snapshot().get("self") or {}
        lat, lng = own.get("lat"), own.get("lng")
    active, created = mob.store.activate(lat, lng)
    return {"active": active.wire(), "created": created}


@router.delete("")
def clear_mob(
    runtime: Runtime = Depends(get_runtime),
    mob: MobRuntime = Depends(get_mob),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, Any]:
    """End the MOB. If SignalK is steering to the mark, that course ends too
    — left up, the autopilot would keep circling an empty patch of sea."""
    cleared = mob.store.clear()
    course = "untouched"
    if cleared is not None and cleared.has_position and _steering_to(signalk, cleared.lat, cleared.lng):
        config = runtime.config.get()
        if config.signalk.enabled and config.credentials.signalk.token.get_secret_value():
            try:
                mob.client().clear_course()
                course = "cleared"
            except MobSignalKError as e:
                log.warning("could not clear the course to the MOB: %s", e)
                course = "failed"
    return {"cleared": cleared.wire() if cleared else None, "course": course}


@router.post("/navigate")
def navigate(
    runtime: Runtime = Depends(get_runtime), mob: MobRuntime = Depends(get_mob)
) -> dict[str, Any]:
    """Steer to the mark: SignalK's course destination, which the autopilot
    (nav mode), the MFD and mivnav's own steering cue follow. A followed
    route stops first — it is not the boat's business any more."""
    active = mob.store.active()
    if active is None:
        raise HTTPException(status_code=409, detail="no man overboard is active")
    if not active.has_position:
        raise HTTPException(status_code=409, detail="the MOB was raised without a position")
    config = runtime.config.get()
    if not config.signalk.enabled:
        raise HTTPException(status_code=503, detail="SignalK is disabled in this server's configuration")
    if not config.credentials.signalk.token.get_secret_value():
        raise HTTPException(
            status_code=503,
            detail="mivnav has no SignalK write access — request it under Settings → SignalK",
        )
    if runtime.routes.active() is not None:
        runtime.routes.set_active(None)
    try:
        mob.client().set_destination(cast(float, active.lat), cast(float, active.lng))
    except MobSignalKError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"ok": True}


@router.post("/ack")
def acknowledge_mob(
    body: MobAckBody,
    runtime: Runtime = Depends(get_runtime),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, Any]:
    """Acknowledge ``notifications.mob`` on the SignalK server — quiet on
    every display and the MFD. The MOB itself stays up until cleared."""
    config = runtime.config.get()
    if not config.signalk.enabled:
        raise HTTPException(status_code=503, detail="SignalK is disabled in this server's configuration")
    notice = signalk.snapshot().get("mobNotice") or {}
    if notice.get("id") != body.id or notice.get("acknowledged"):
        return {"ok": True, "acknowledged": 0}
    token = config.credentials.signalk.token.get_secret_value() or None
    try:
        acknowledge(config.signalk.notifications_url, token, body.id)
    except AckUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except AckUnreachable as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except (AckRefused, AckError) as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"ok": True, "acknowledged": 1}


def _steering_to(signalk: SignalKService, lat: float | None, lng: float | None) -> bool:
    course = signalk.snapshot().get("course") or {}
    nlat, nlng = course.get("nextLat"), course.get("nextLng")
    if lat is None or lng is None or nlat is None or nlng is None:
        return False
    return _metres(lat, lng, nlat, nlng) <= COURSE_MATCH_M


def _metres(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6_371_000.0 * math.asin(math.sqrt(a))


def mob_data_provider(config: Config, runtime: MobRuntime) -> DataProvider:
    def stats() -> dict:
        active = runtime.store.active()
        return {
            "active": active is not None,
            "signalk": config.signalk.enabled,
            "token_configured": bool(config.credentials.signalk.token.get_secret_value()),
        }

    return DataProvider(
        id="mob",
        label="Man overboard",
        kind="live-stream",
        cache=None,
        refresh=Refresh("live"),
        prefetch=None,
        config_slice="signalk",
        stats=stats,
    )


FEATURE: Feature[MobRuntime] = Feature(
    id="mob",
    routers=(router,),
    build_runtime=build_mob_runtime,
    data_provider=mob_data_provider,
)
