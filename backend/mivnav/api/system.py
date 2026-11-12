# SPDX-License-Identifier: GPL-2.0-only
"""/system — the server's own software version, and its release updates.

::

    GET  /system/version           running version + install kind
    GET  /system/update            newest release on GitHub + the updater's status
    POST /system/update            start the updater for "latest" or a tag
    POST /system/update/rollback   start the updater's rollback

The update itself is ``deploy/update.sh``, run by systemd as
``mivnav-update@<target>.service`` — a unit of its own, so it can restart
*this* process and survive it. This router only queues that unit and reads
the status file it writes (:mod:`mivnav.system`). A source checkout is
never updated from here: ``can_update`` is false and both POSTs answer 400.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator

from mivnav.api.deps import Runtime, get_runtime
from mivnav.system import (
    LatestRelease,
    SystemPaths,
    UpdateChecker,
    UpdateStatus,
    compare_versions,
    install_info,
    read_status,
    start_unit,
    valid_target,
)
from mivnav.system.updates import Runner, UnitStartFailed, systemctl_runner

router = APIRouter(prefix="/system")

__all__ = ["get_system_paths", "get_systemctl", "get_update_checker", "router"]


# Each seam is its own dependency so a test overrides exactly one: the
# filesystem layout, the systemctl call, or the GitHub lookup.


def get_system_paths() -> SystemPaths:
    return SystemPaths()


def get_systemctl() -> Runner:
    return systemctl_runner


def get_update_checker(runtime: Runtime = Depends(get_runtime)) -> UpdateChecker:
    return runtime.update_checker()


class SystemVersion(BaseModel):
    #: The ``VERSION`` of the running release (``"0.2.0"``), or ``"dev"``.
    version: str
    install: Literal["release", "source"]
    #: A release install with the updater unit installed — the only kind
    #: the POST endpoints act on.
    can_update: bool
    #: Short git commit of a source checkout, when readable; else ``null``.
    commit: str | None = None


class UpdateInfo(BaseModel):
    current: str
    #: Newest release GitHub offers (pre-releases only when
    #: ``updates.include_prereleases``); ``null`` = never looked, or none.
    latest: LatestRelease | None
    #: ``latest`` is newer than ``current`` (never for a ``dev`` checkout).
    available: bool
    status: UpdateStatus
    #: When GitHub was last asked (ISO-8601), ``null`` = not yet.
    checked_at: str | None
    #: Why the last lookup failed (offline is normal on a boat), else ``null``.
    error: str | None


class UpdateRequest(BaseModel):
    #: ``"latest"`` or a release tag like ``"v0.2.0"`` / ``"v0.2.0-rc.1"``.
    version: str = "latest"

    @field_validator("version")
    @classmethod
    def _target(cls, value: str) -> str:
        if not valid_target(value):
            raise ValueError("version must be 'latest' or a tag like 'v0.2.0'")
        return value


class UpdateStarted(BaseModel):
    #: The systemd unit now queued, e.g. ``mivnav-update@latest.service``.
    unit: str


@router.get("/version")
def get_version(paths: SystemPaths = Depends(get_system_paths)) -> SystemVersion:
    info = install_info(paths)
    return SystemVersion(
        version=info.version, install=info.install, can_update=info.can_update, commit=info.commit
    )


@router.get("/update")
async def get_update(
    refresh: bool = Query(default=False, description="Ask GitHub now, bypassing the 6 h cache."),
    paths: SystemPaths = Depends(get_system_paths),
    checker: UpdateChecker = Depends(get_update_checker),
) -> UpdateInfo:
    """The newest release and the updater's status — what the Software
    panel polls (every 2 s while an update runs; the lookup is cached, so
    polling never re-asks GitHub). Offline is an ``error`` string, never a
    failed request."""
    current = install_info(paths).version
    check = await checker.check(refresh=refresh)
    latest = check.latest
    return UpdateInfo(
        current=current,
        latest=latest,
        available=latest is not None and compare_versions(latest.version, current) == 1,
        status=read_status(paths.status_file),
        checked_at=check.checked_at,
        error=check.error,
    )


def _start(target: str, paths: SystemPaths, runner: Runner) -> UpdateStarted:
    info = install_info(paths)
    if not info.can_update:
        raise HTTPException(
            status_code=400,
            detail=(
                "This server is not a release install with the updater set up; "
                "update a source checkout with git and deploy/install-from-source.sh."
                if info.install == "source"
                else "The updater is not installed; run install.sh once by hand."
            ),
        )
    status = read_status(paths.status_file)
    if status.in_progress:
        raise HTTPException(
            status_code=409, detail=f"An update is already running ({status.state})."
        )
    try:
        unit = start_unit(target, runner)
    except UnitStartFailed as e:
        raise HTTPException(status_code=503, detail=f"Could not start the updater: {e}") from e
    return UpdateStarted(unit=unit)


@router.post("/update", status_code=202)
def post_update(
    body: UpdateRequest,
    paths: SystemPaths = Depends(get_system_paths),
    runner: Runner = Depends(get_systemctl),
) -> UpdateStarted:
    """Queue ``mivnav-update@<version>.service``. 400 = not updatable here,
    409 = an update is already running, 503 = systemd refused (usually the
    polkit rule is missing). Progress is ``GET /system/update``'s ``status``."""
    return _start(body.version, paths, runner)


@router.post("/update/rollback", status_code=202)
def post_rollback(
    paths: SystemPaths = Depends(get_system_paths),
    runner: Runner = Depends(get_systemctl),
) -> UpdateStarted:
    """Queue ``mivnav-update@rollback.service`` — back to the previous
    release. Same errors as ``POST /system/update``."""
    return _start("rollback", paths, runner)
