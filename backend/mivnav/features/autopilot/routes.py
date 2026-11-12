# SPDX-License-Identifier: GPL-2.0-only
"""``/autopilot`` — commanding the pilot, asking what it can do, and the
``FEATURE`` registration. See docs/architecture/autopilot-api.md for the
route map and — safety-critical — what each failure status code means."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from mivnav.api.deps import Runtime, get_runtime, get_signalk
from mivnav.feature import Feature
from mivnav.features.autopilot.client import (
    TARGET_MAX_DEG,
    TARGET_MIN_DEG,
    AutopilotClient,
    AutopilotError,
    AutopilotRefused,
    AutopilotUnauthorized,
    AutopilotUnavailable,
    AutopilotUnreachable,
)
from mivnav.features.autopilot.provider import autopilot_data_provider
from mivnav.features.autopilot.runtime import AutopilotRuntime, build_autopilot_runtime
from mivnav.signalk import SignalKService

log = logging.getLogger(__name__)

router = APIRouter(prefix="/autopilot")

__all__ = ["FEATURE", "get_autopilot", "router"]


def get_autopilot(runtime: Runtime = Depends(get_runtime)) -> AutopilotClient:
    return cast(AutopilotRuntime, runtime.feature("autopilot")).client()


#: Modes whose target is a compass bearing chosen by the *helmsman* — used to
#: decide whether ``engage`` seeds the target from COG. ``"nav"`` is
#: deliberately excluded: its target is the published route leg, not COG.
_BEARING_MODES = ("compass", "gps")


class StateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: One of the ``options.states[].name`` the device reported. Not an
    #: enum: the legal set is the *device's* (GET /autopilot). The device
    #: validates it; its refusal is surfaced verbatim.
    value: str = Field(min_length=1)


class ModeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: One of the ``options.modes`` the device reported. See StateBody.
    value: str = Field(min_length=1)


class TargetBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Degrees (unit in the name, as everywhere on this wire); SignalK is
    #: radians, converted once at the client boundary. Bounds checked here
    #: for a clean 422, and again by the device, which remains the authority.
    degrees: float = Field(ge=TARGET_MIN_DEG, le=TARGET_MAX_DEG)


class AdjustBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: A delta applied by the *device* to the target it holds — so a "+10°"
    #: button cannot race a target change we had not yet heard about.
    degrees: float = Field(ge=TARGET_MIN_DEG, le=TARGET_MAX_DEG)


#: Not a device option but the API's own fixed vocabulary: the box splits
#: each action into two paths (…/tack/port, …/tack/starboard).
_DIRECTIONS = ("port", "starboard")


class DodgeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Degrees to steer clear of the held course, negative to port — a
    #: *relative* override, checked again by the device, the authority.
    degrees: float = Field(ge=TARGET_MIN_DEG, le=TARGET_MAX_DEG)


def _require_direction(direction: str) -> None:
    """Reject an unknown tack/gybe direction at our edge, before it reaches
    the boat. A 400 (the client asked for something that is not a direction),
    not a 404: the route exists, the value does not — and "port|starboard
    only" is a more useful answer than the box's "no such action"."""
    if direction not in _DIRECTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"direction must be 'port' or 'starboard', not {direction!r}",
        )


def _command(call: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """Run one command, mapping the failure onto the status code that says
    whose problem it is. See the module docstring."""
    try:
        return call()
    except AutopilotUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except AutopilotUnauthorized as e:
        # 503 and not 502: the request was fine and the box is alive — this
        # server's token is the problem, which is a config fault of ours.
        log.warning("the SignalK server rejected our autopilot token")
        raise HTTPException(status_code=503, detail=str(e)) from e
    except AutopilotUnreachable as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except AutopilotRefused as e:
        # The pilot's own code and words. Not translated, not summarised.
        raise HTTPException(status_code=e.status_code, detail=e.message) from e


@router.get("")
def get_info(autopilot: AutopilotClient = Depends(get_autopilot)) -> dict[str, Any]:
    """What this pilot is and what it supports: ``options`` is the device's
    own vocabulary. The state fields are a curl convenience; a UI should
    watch /signalk/stream for live state instead."""
    return _command(autopilot.info)


@router.post("/engage")
def engage(
    autopilot: AutopilotClient = Depends(get_autopilot),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, Any]:
    """Hand the helm to the pilot. In a bearing mode, we PUT the boat's
    current COG as the target AFTER engage confirms (real-pypilot testing:
    otherwise it steers a stale target). See docs/architecture/autopilot-api.md."""
    mode = _current_mode(autopilot)
    result = _command(autopilot.engage)
    if mode in _BEARING_MODES:
        _seed_bearing_target(autopilot, signalk, result)
    return result


def _current_mode(autopilot: AutopilotClient) -> str | None:
    """The pilot's mode, or ``None`` if it could not be read. See the "why
    ``info()``" note on :func:`engage`."""
    try:
        mode = autopilot.info().get("mode")
    except AutopilotError:
        return None
    return mode if isinstance(mode, str) else None


def _seed_bearing_target(
    autopilot: AutopilotClient, signalk: SignalKService, result: dict[str, Any]
) -> None:
    """PUT the boat's current COG as the target, noted on ``result``.
    Best-effort: logged not raised — ``engage`` already succeeded, and
    turning its COMPLETED into an error would say the wrong thing."""
    own = signalk.snapshot().get("self") or {}
    cog = own.get("cogDeg")
    if not isinstance(cog, (int, float)):
        log.info(
            "engage: no current COG to seed the target from "
            "(no GPS fix, or SignalK is disabled/disconnected); "
            "leaving the target as the pilot already holds it"
        )
        return
    try:
        autopilot.set_target(float(cog))
    except AutopilotError:
        log.warning("engage: could not seed the target from current COG", exc_info=True)
        return
    result["targetDeg"] = float(cog)


@router.post("/disengage")
def disengage(autopilot: AutopilotClient = Depends(get_autopilot)) -> dict[str, Any]:
    """Take the helm back."""
    return _command(autopilot.disengage)


@router.put("/state")
def set_state(
    body: StateBody, autopilot: AutopilotClient = Depends(get_autopilot)
) -> dict[str, Any]:
    return _command(lambda: autopilot.set_state(body.value))


@router.put("/mode")
def set_mode(
    body: ModeBody, autopilot: AutopilotClient = Depends(get_autopilot)
) -> dict[str, Any]:
    return _command(lambda: autopilot.set_mode(body.value))


@router.put("/target")
def set_target(
    body: TargetBody, autopilot: AutopilotClient = Depends(get_autopilot)
) -> dict[str, Any]:
    return _command(lambda: autopilot.set_target(body.degrees))


@router.put("/target/adjust")
def adjust_target(
    body: AdjustBody, autopilot: AutopilotClient = Depends(get_autopilot)
) -> dict[str, Any]:
    return _command(lambda: autopilot.adjust_target(body.degrees))


@router.post("/tack/{direction}")
def tack(
    direction: str, autopilot: AutopilotClient = Depends(get_autopilot)
) -> dict[str, Any]:
    """Tack the boat to port or starboard. The pilot decides how far/fast,
    and whether it can at all (a non-wind-mode refusal comes back as its own
    400). Direction validated here first, so a typo fails at our edge."""
    _require_direction(direction)
    return _command(lambda: autopilot.tack(direction))


@router.post("/gybe/{direction}")
def gybe(
    direction: str, autopilot: AutopilotClient = Depends(get_autopilot)
) -> dict[str, Any]:
    """Gybe the boat to port or starboard. See :func:`tack`."""
    _require_direction(direction)
    return _command(lambda: autopilot.gybe(direction))


@router.post("/dodge")
def start_dodge(autopilot: AutopilotClient = Depends(get_autopilot)) -> dict[str, Any]:
    """Enter dodge mode: hold the current course while the helm is steered
    clear with ``PUT /autopilot/dodge``, until ``DELETE /autopilot/dodge``
    resumes it."""
    return _command(autopilot.start_dodge)


@router.delete("/dodge")
def stop_dodge(autopilot: AutopilotClient = Depends(get_autopilot)) -> dict[str, Any]:
    """Leave dodge mode and resume the course held on entry."""
    return _command(autopilot.stop_dodge)


@router.put("/dodge")
def dodge(
    body: DodgeBody, autopilot: AutopilotClient = Depends(get_autopilot)
) -> dict[str, Any]:
    """Steer clear of the held course while dodging — negative is to port.
    A relative override; the pilot returns to its course on
    ``DELETE /autopilot/dodge``."""
    return _command(lambda: autopilot.dodge(body.degrees))


FEATURE: Feature[AutopilotRuntime] = Feature(
    id="autopilot",
    routers=(router,),
    build_runtime=build_autopilot_runtime,
    data_provider=autopilot_data_provider,
)
