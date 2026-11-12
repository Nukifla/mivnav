# SPDX-License-Identifier: GPL-2.0-only
"""``/anchor`` — commanding SignalK's anchoralarm plugin through the SignalK
anchor paths, the swing track, and the ``FEATURE`` registration. Live state
is read from ``/signalk/stream`` (the snapshot's ``anchor`` key), never from
here. Failure codes follow the autopilot's: 503 = our config (no SignalK, no
plugin, no write access), 502 = the box did not answer, 409 = the plugin or
the boat's state said no (its words verbatim in ``detail``)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from mivnav.api.deps import Runtime, get_runtime, get_signalk
from mivnav.feature import Feature
from mivnav.features.anchor.client import (
    AnchorClient,
    AnchorRefused,
    AnchorUnavailable,
    AnchorUnreachable,
    bow_point,
    radius_from_here,
)
from mivnav.features.anchor.provider import anchor_data_provider
from mivnav.features.anchor.runtime import AnchorRuntime, build_anchor_runtime
from mivnav.signalk import SignalKService

router = APIRouter(prefix="/anchor")

__all__ = ["FEATURE", "router"]

#: A swing circle smaller than a boat length is a typo, and one past half a
#: nautical mile watches nothing.
RADIUS_MIN_M = 5.0
RADIUS_MAX_M = 1000.0


def get_anchor(runtime: Runtime = Depends(get_runtime)) -> AnchorClient:
    return cast(AnchorRuntime, runtime.feature("anchor")).client()


class DropBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: ``null`` (the default) = mark the anchor, alarm off until a radius is
    #: set — the rode is still going out (Freeboard's flow).
    radiusM: float | None = Field(default=None, ge=RADIUS_MIN_M, le=RADIUS_MAX_M)


class RadiusBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Absent = "from here": the distance to the anchor now + the plugin's fudge.
    radiusM: float | None = Field(default=None, ge=RADIUS_MIN_M, le=RADIUS_MAX_M)


class MoveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    #: ``null`` = keep it unarmed (moving it while the rode is going out).
    radiusM: float | None = Field(ge=RADIUS_MIN_M, le=RADIUS_MAX_M)


class AckBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: The notification the user SAW — acking by id, not "whatever is up
    #: now", so an alarm that changed underneath the tap is not swallowed.
    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9-]+$")


def _command(call: Callable[[], None]) -> dict[str, bool]:
    try:
        call()
    except AnchorUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except AnchorUnreachable as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except AnchorRefused as e:
        raise HTTPException(status_code=e.status_code, detail=e.message) from e
    return {"ok": True}


def _own(signalk: SignalKService) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(self, anchor)`` from the live snapshot; 409 without a fix — the
    plugin's own words for it ("no position available")."""
    snap = signalk.snapshot()
    own = snap.get("self")
    if snap.get("status") != "connected" or not own:
        raise HTTPException(status_code=409, detail="no position available")
    return own, snap.get("anchor") or {}


@router.post("/drop")
def drop(
    body: DropBody,
    anchor: AnchorClient = Depends(get_anchor),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, bool]:
    """Drop at the BOW — the antenna moved ``sensors.gps.fromBow`` along
    the heading, as the plugin's own drop does, with the depth recorded —
    watching at ``radiusM``, or not yet watching without one."""
    own, state = _own(signalk)
    lat, lng = bow_point(own["lat"], own["lng"], own.get("headingDeg"), state.get("gpsFromBowM"))
    depth = own.get("depthBelowSurfaceM")
    return _command(lambda: anchor.place(lat, lng, body.radiusM, depth))


@router.post("/radius")
def set_radius(
    body: RadiusBody,
    anchor: AnchorClient = Depends(get_anchor),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, bool]:
    radius = body.radiusM
    if radius is None:
        own, state = _own(signalk)
        if state.get("lat") is None or state.get("lng") is None:
            raise HTTPException(status_code=409, detail="the anchor has not been dropped")
        measured = radius_from_here(
            (own["lat"], own["lng"]), (state["lat"], state["lng"]), state.get("fudgeM")
        )
        radius = min(RADIUS_MAX_M, max(RADIUS_MIN_M, measured))
    final = radius
    return _command(lambda: anchor.set_radius(final))


@router.put("/position")
def move(body: MoveBody, anchor: AnchorClient = Depends(get_anchor)) -> dict[str, bool]:
    return _command(lambda: anchor.place(body.lat, body.lng, body.radiusM))


@router.post("/raise")
def raise_anchor(anchor: AnchorClient = Depends(get_anchor)) -> dict[str, bool]:
    return _command(anchor.raise_anchor)


@router.post("/ack")
def acknowledge(body: AckBody, anchor: AnchorClient = Depends(get_anchor)) -> dict[str, bool]:
    return _command(lambda: anchor.acknowledge(body.id))


@router.get("/track")
def track(signalk: SignalKService = Depends(get_signalk)) -> dict[str, list[list[float]]]:
    """The swing track since the drop: ``{"fixes": [[lng, lat, time_ms], …]}``,
    one fix per 10 s, recorded on this server while the anchor is down
    (:mod:`mivnav.signalk.anchor`). Empty while it is up."""
    return {"fixes": signalk.anchor_track()}


FEATURE: Feature[AnchorRuntime] = Feature(
    id="anchor",
    routers=(router,),
    build_runtime=build_anchor_runtime,
    data_provider=anchor_data_provider,
)
