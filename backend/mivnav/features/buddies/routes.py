# SPDX-License-Identifier: GPL-2.0-only
"""``/buddies`` — the list and each buddy's newest position, and the
``FEATURE`` registration. Sync routes: they may wait on the network, so
FastAPI runs them in its threadpool, off the event loop serving tiles."""

from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from mivnav.api.deps import Runtime, get_runtime
from mivnav.feature import Feature
from mivnav.features.buddies.provider import buddies_data_provider
from mivnav.features.buddies.runtime import (
    BuddiesRuntime,
    DuplicateBuddy,
    build_buddies_runtime,
)

router = APIRouter(prefix="/buddies", tags=["buddies"])

__all__ = ["FEATURE", "get_buddies", "router"]


def get_buddies(runtime: Runtime = Depends(get_runtime)) -> BuddiesRuntime:
    return cast(BuddiesRuntime, runtime.feature("buddies"))


class AddBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mmsi: str = Field(pattern=r"^[0-9]{9}$")
    nickname: str | None = Field(default=None, max_length=64)


class EditBody(BaseModel):
    """The whole editable record: an absent field clears it."""

    model_config = ConfigDict(extra="forbid")
    nickname: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=500)


def _clean(text: str | None) -> str | None:
    return (text or "").strip() or None


@router.get("")
def list_buddies(buddies: BuddiesRuntime = Depends(get_buddies)) -> dict[str, Any]:
    return buddies.list()


@router.post("", status_code=201)
def add_buddy(body: AddBody, buddies: BuddiesRuntime = Depends(get_buddies)) -> dict[str, Any]:
    try:
        return buddies.add(body.mmsi, _clean(body.nickname))
    except DuplicateBuddy as exc:
        raise HTTPException(409, f"{body.mmsi} is already a buddy") from exc


@router.patch("/{buddy_id}")
def edit_buddy(
    buddy_id: str, body: EditBody, buddies: BuddiesRuntime = Depends(get_buddies)
) -> dict[str, Any]:
    result = buddies.edit(buddy_id, _clean(body.nickname), _clean(body.note))
    if result is None:
        raise HTTPException(404, "no such buddy")
    return result


@router.delete("/{buddy_id}", status_code=204)
def remove_buddy(buddy_id: str, buddies: BuddiesRuntime = Depends(get_buddies)) -> None:
    if not buddies.remove(buddy_id):
        raise HTTPException(404, "no such buddy")


FEATURE: Feature[BuddiesRuntime] = Feature(
    id="buddies",
    routers=(router,),
    build_runtime=build_buddies_runtime,
    data_provider=buddies_data_provider,
)
