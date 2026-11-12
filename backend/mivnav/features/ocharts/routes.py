# SPDX-License-Identifier: GPL-2.0-only
"""/ocharts — o-charts account, fingerprint, and chart-set management, plus
``/ocharts/fnc/*`` (freenauticalchart.net CC0 charts), and the ``FEATURE``
registration. See docs/architecture/ocharts-routes.md."""

from __future__ import annotations

import logging
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from mivnav.api.deps import Runtime, get_runtime
from mivnav.feature import Feature
from mivnav.features.ocharts import fnc
from mivnav.features.ocharts.devices import (
    COOKIE,
    COOKIE_MAX_AGE_S,
    DeviceGate,
    DevicesFull,
    UnknownDevice,
)
from mivnav.features.ocharts.install import InstallError, Installer
from mivnav.features.ocharts.provider import ocharts_data_provider
from mivnav.features.ocharts.runtime import OchartsRuntime, build_ocharts_runtime, ocharts_guard
from mivnav.features.ocharts.service import OchartsService
from mivnav.features.ocharts.shop import Credentials, ShopClient, ShopError
from mivnav.features.ocharts.updates import UpdateError, Updater, credentials_from

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ocharts")

__all__ = [
    "FEATURE",
    "device_token",
    "get_device_gate",
    "get_installer",
    "get_service",
    "get_updater",
    "router",
]


# xfpr registration is irreversible; never retry blindly (research-11.md)
_register_lock = threading.Lock()
_register_attempted = False


def get_service(runtime: Runtime = Depends(get_runtime)) -> OchartsService:
    return cast(OchartsRuntime, runtime.feature("ocharts")).service()


def get_installer(runtime: Runtime = Depends(get_runtime)) -> Installer:
    return cast(OchartsRuntime, runtime.feature("ocharts")).installer()


def get_updater(runtime: Runtime = Depends(get_runtime)) -> Updater:
    return cast(OchartsRuntime, runtime.feature("ocharts")).updater


def get_device_gate(runtime: Runtime = Depends(get_runtime)) -> DeviceGate:
    return cast(OchartsRuntime, runtime.feature("ocharts")).devices


def device_token(request: Request) -> str | None:
    """This browser's device cookie, if it has one (see .devices)."""
    return request.cookies.get(COOKIE) or None


def _configured_credentials(runtime: Runtime) -> Credentials | None:
    """The o-charts login from the config, or None if not set up. Read per
    request rather than captured, since credentials can change any moment
    via PATCH /config and are an input to nothing long-lived."""
    return credentials_from(runtime.config.get())


def _credentials(runtime: Runtime) -> Credentials:
    creds = _configured_credentials(runtime)
    if creds is None:
        raise HTTPException(
            status_code=503,
            detail="no o-charts credentials configured "
            "(set credentials.ocharts.user/password via PATCH /config)",
        )
    return creds


def _fingerprint(service: OchartsService) -> tuple[str, str]:
    try:
        return service.fingerprint()
    except Exception as e:  # chartcore.DaemonError etc.
        raise HTTPException(status_code=503, detail=f"fingerprint unavailable: {e}") from e


def _shop_call(fn):
    try:
        return fn()
    except ShopError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


def _chart_dict(c) -> dict:
    return {
        "chart_id": c.chart_id,
        "name": c.name,
        "edition": c.edition,
        "expired": c.expired,
        "order": c.order,
        "quantity_id": c.quantity_id,
        "slots": [
            {"slot_uuid": s.slot_uuid, "assigned_system": s.assigned_system} for s in c.slots
        ],
    }


@router.get("/status")
def status(
    service: OchartsService = Depends(get_service),
    installer: Installer = Depends(get_installer),
    updater: Updater = Depends(get_updater),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    return {
        **service.status(),
        "credentials_present": _configured_credentials(runtime) is not None,
        "install": installer.status(),
        "updates": updater.status(),
    }


@router.delete("/sets/{set_id}")
def delete_set(set_id: str, service: OchartsService = Depends(get_service)) -> dict:
    """Remove an installed chart set (its directory of encrypted cells
    and license material). The license slot at o-charts.org is untouched
    — the set can be reinstalled from the shop at any time."""
    cs = service.get(set_id)
    if cs is None:
        raise HTTPException(status_code=404, detail=f"unknown chart set {set_id!r}")
    try:
        shutil.rmtree(cs.directory)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"delete failed: {e}") from e
    service.invalidate()
    log.info("deleted chart set %s (%s)", set_id, cs.directory)
    return {"deleted": set_id}


@router.post("/shop/connect")
def shop_connect(
    service: OchartsService = Depends(get_service),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """Log in, identify this system, and list the account's charts."""
    creds = _credentials(runtime)
    fpr_name, fpr_value = _fingerprint(service)
    client = ShopClient(creds)
    try:
        system_name = _shop_call(lambda: client.identify_system(fpr_name, fpr_value))
        systems, charts = _shop_call(client.chart_list)
    finally:
        client.close()
    return {
        "system_name": system_name,
        "registered": system_name is not None,
        "known_systems": systems,
        "charts": [_chart_dict(c) for c in charts],
    }


class RegisterBody(BaseModel):
    system_name: str


@router.post("/shop/register")
def shop_register(
    body: RegisterBody,
    service: OchartsService = Depends(get_service),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """Register this machine's fingerprint (irreversible; one attempt)."""
    global _register_attempted
    name = body.system_name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="system name must not be empty")
    creds = _credentials(runtime)
    fpr_name, fpr_value = _fingerprint(service)
    client = ShopClient(creds)
    try:
        existing = _shop_call(lambda: client.identify_system(fpr_name, fpr_value))
        if existing is not None:
            return {"system_name": existing, "registered": True, "already": True}
        with _register_lock:
            if _register_attempted:
                raise HTTPException(
                    status_code=409,
                    detail="a registration was already attempted this run; "
                    "check the shop account state before retrying",
                )
            _register_attempted = True
        _shop_call(lambda: client.register_system(fpr_name, fpr_value, name))
        confirmed = _shop_call(lambda: client.identify_system(fpr_name, fpr_value))
        return {"system_name": confirmed or name, "registered": confirmed is not None}
    finally:
        client.close()


class InstallBody(BaseModel):
    edition: str
    system_name: str
    detail: str = ""
    # a slot already assigned to system_name, …
    slot_uuid: str = ""
    # … or the chart to assign one from (consumes a slot binding)
    chart_id: str = ""
    order: str = ""
    quantity_id: str = ""


@router.post("/shop/install")
def shop_install(
    body: InstallBody,
    installer: Installer = Depends(get_installer),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    creds = _credentials(runtime)
    client = ShopClient(creds)
    try:
        slot_uuid = body.slot_uuid
        if not slot_uuid:
            if not (body.chart_id and body.order and body.quantity_id):
                raise HTTPException(
                    status_code=422,
                    detail="need slot_uuid, or chart_id+order+quantity_id to assign one",
                )
            slot_uuid = _shop_call(
                lambda: client.assign_chart(
                    body.order, body.chart_id, body.quantity_id, body.system_name
                )
            )
        urls = _shop_call(
            lambda: client.download_urls(body.system_name, slot_uuid, body.edition)
        )
    finally:
        client.close()
    try:
        installer.install_from_shop(urls.chart_url, urls.key_url, detail=body.detail)
    except InstallError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return installer.status()


class FncInstallBody(BaseModel):
    region: str
    # Reinstall even when the installed edition matches what is published.
    force: bool = False


@router.get("/fnc/catalog")
def fnc_catalog(service: OchartsService = Depends(get_service)) -> dict:
    """The freenauticalchart.net regions, each with what the publisher serves
    now and what is installed here. One HEAD per region — cheap, on demand,
    and never polled: the unattended updater (`updates.py`) asks only about
    the regions that are installed."""
    return {"regions": fnc.FncClient().catalog(service.sets_dir)}


@router.post("/fnc/install")
def fnc_install(
    body: FncInstallBody,
    installer: Installer = Depends(get_installer),
    service: OchartsService = Depends(get_service),
) -> dict:
    """Download and install one freenauticalchart.net region. No
    credentials/fingerprint/keys needed — the charts are CC0, the way to
    exercise o-charts serving with no subscription."""
    try:
        r = fnc.region(body.region)
        version = fnc.FncClient().version(r.id)
    except fnc.FncError as e:
        code = 502 if "cannot reach" in str(e) else 404
        raise HTTPException(status_code=code, detail=str(e)) from e
    installed = fnc.installed_marker(service.sets_dir, r.id)
    if not body.force and not fnc.update_available(version.as_dict(), installed):
        # Same shape as an install status, so a client can feed this straight
        # into whatever renders one — `current` simply is not an *active*
        # state. Nothing was started, so there is no job to poll.
        return {
            "state": "current",
            "progress": 0,
            "detail": r.label,
            "error": "",
            "set_id": (installed or {}).get("set_id", ""),
        }
    try:
        installer.install_from_url(
            r.url,
            detail=f"{r.label} ({version.published or 'latest'})",
            prepare=fnc.prepare(version),
            on_installed=fnc.on_installed(service.sets_dir, r.id),
        )
    except InstallError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return installer.status()


@router.get("/updates")
def updates_status(updater: Updater = Depends(get_updater)) -> dict:
    """What the last shop check found, and what the updater is doing now.
    No network: the check itself is ``POST /updates/check``."""
    return updater.status()


@router.post("/updates/check")
def updates_check(
    service: OchartsService = Depends(get_service),
    updater: Updater = Depends(get_updater),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """Ask the shop which installed sets have a newer edition. Installs
    nothing."""
    creds = _credentials(runtime)
    try:
        updater.check(service, creds)
    except UpdateError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ShopError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:  # chartcore.DaemonError etc. (the fingerprint)
        raise HTTPException(status_code=503, detail=f"update check failed: {e}") from e
    return updater.status()


@router.post("/updates/install")
def updates_install(
    service: OchartsService = Depends(get_service),
    installer: Installer = Depends(get_installer),
    updater: Updater = Depends(get_updater),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """Check, then install every newer edition in the background, each
    replacing the set it supersedes — the shop's sets if a login is
    configured, and the installed freenauticalchart.net regions either way.
    Poll ``GET /ocharts/updates`` for the run and ``GET /ocharts/install``
    for the download in progress."""
    creds = _configured_credentials(runtime)
    if installer.busy():
        raise HTTPException(status_code=409, detail="an install is already running")
    try:
        updater.start(service, installer, creds)
    except UpdateError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return updater.status()


@router.get("/install")
def install_status(installer: Installer = Depends(get_installer)) -> dict:
    return installer.status()


@router.post("/upload")
async def upload(file: UploadFile, installer: Installer = Depends(get_installer)) -> dict:
    """Manual install: upload a chart zip (offline shop download)."""
    if installer.busy():
        raise HTTPException(status_code=409, detail="an install is already running")
    # spool to disk (the zip is encrypted-at-rest shop material, not
    # decrypted chart data); the installer job deletes it
    spool = tempfile.NamedTemporaryFile(prefix="mivnav-upload-", suffix=".zip", delete=False)
    try:
        while chunk := await file.read(1 << 20):
            spool.write(chunk)
    finally:
        spool.close()
    try:
        installer.install_zip_file(Path(spool.name), detail=file.filename or "upload")
    except InstallError as e:
        Path(spool.name).unlink(missing_ok=True)
        raise HTTPException(status_code=409, detail=str(e)) from e
    return installer.status()


# -- registered devices (see .devices) ----------------------------------------
# Anyone on the boat network may list, register and remove: the cap counts
# screens, it does not authenticate them.


class DeviceOut(BaseModel):
    id: str
    name: str
    created: float
    last_seen: float
    #: Seconds since ``last_seen`` by the server's clock — a client's own
    #: clock is not comparable (no NTP at sea).
    seen_ago_s: float
    #: Is this the device asking?
    current: bool = False


def _device_out(device, me=None) -> DeviceOut:
    return DeviceOut(
        **device.public(),
        seen_ago_s=max(0.0, time.time() - device.last_seen),
        current=me is not None and me.id == device.id,
    )


class EulaOut(BaseModel):
    id: str
    #: names of the chart sets that ship this text
    sets: list[str]
    accepted: bool


class DeviceStatus(BaseModel):
    #: Is anything enforced — is a licensed (encrypted) set installed?
    gate: bool
    max: int
    count: int
    registered: bool
    #: This browser carries a device cookie the list no longer knows.
    removed: bool
    #: May this browser be served o-charts tiles now?
    allowed: bool
    device: DeviceOut | None
    eulas: list[EulaOut]


class RegisterDeviceBody(BaseModel):
    name: str
    #: ids of the EULAs accepted — must be every current one
    accept: list[str] = []


class AcceptBody(BaseModel):
    accept: list[str]


class RenameDeviceBody(BaseModel):
    name: str


def _status(gate: DeviceGate, service: OchartsService, token: str | None) -> DeviceStatus:
    return DeviceStatus.model_validate(gate.status(service, token))


def _set_device_cookie(response: Response, token: str) -> None:
    # Not `secure`: the boat serves plain HTTP over its LAN.
    response.set_cookie(
        COOKIE,
        token,
        max_age=COOKIE_MAX_AGE_S,
        httponly=True,
        samesite="lax",
        path="/",
    )


def _missing_eulas(gate: DeviceGate, service: OchartsService, accepted: list[str]) -> list[str]:
    given = set(accepted)
    return [e.id for e in gate.eulas(service) if e.id not in given]


@router.get("/devices/me")
def device_me(
    request: Request,
    response: Response,
    gate: DeviceGate = Depends(get_device_gate),
    service: OchartsService = Depends(get_service),
) -> DeviceStatus:
    """Whether this browser may show o-charts, and what it would take.
    ``removed`` is said once: the stale cookie is dropped with the answer,
    so the client clears its cached o-charts tiles once, not every launch."""
    status = _status(gate, service, device_token(request))
    if status.removed:
        response.delete_cookie(COOKIE, path="/")
    return status


@router.get("/devices")
def device_list(request: Request, gate: DeviceGate = Depends(get_device_gate)) -> list[DeviceOut]:
    me = gate.store.by_token(device_token(request), touch=False)
    return [_device_out(d, me) for d in gate.store.list()]


@router.post("/devices")
def device_register(
    body: RegisterDeviceBody,
    request: Request,
    response: Response,
    gate: DeviceGate = Depends(get_device_gate),
    service: OchartsService = Depends(get_service),
) -> DeviceStatus:
    """Register this browser. Every current EULA must be in ``accept``;
    at the cap, 409 — remove a device (``DELETE /devices/{id}``) first."""
    if gate.store.by_token(device_token(request), touch=False) is not None:
        raise HTTPException(status_code=409, detail="this device is already registered")
    missing = _missing_eulas(gate, service, body.accept)
    if missing:
        raise HTTPException(status_code=422, detail="the licence agreement must be accepted")
    try:
        _, token = gate.store.register(body.name, body.accept)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except DevicesFull as e:
        raise HTTPException(
            status_code=409,
            detail="all device slots are taken; remove one first",
        ) from e
    _set_device_cookie(response, token)
    return _status(gate, service, token)


@router.post("/devices/me/accept")
def device_accept(
    body: AcceptBody,
    request: Request,
    gate: DeviceGate = Depends(get_device_gate),
    service: OchartsService = Depends(get_service),
) -> DeviceStatus:
    """Accept EULAs that changed or arrived since this device registered."""
    token = device_token(request)
    device = gate.store.by_token(token, touch=False)
    if device is None:
        raise HTTPException(status_code=404, detail="this device is not registered")
    current = {e.id for e in gate.eulas(service)}
    gate.store.accept(device.id, [i for i in body.accept if i in current])
    return _status(gate, service, token)


@router.patch("/devices/{device_id}")
def device_rename(
    device_id: str,
    body: RenameDeviceBody,
    request: Request,
    gate: DeviceGate = Depends(get_device_gate),
) -> DeviceOut:
    try:
        device = gate.store.rename(device_id, body.name)
    except UnknownDevice as e:
        raise HTTPException(status_code=404, detail=f"unknown device {device_id!r}") from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    me = gate.store.by_token(device_token(request), touch=False)
    return _device_out(device, me)


@router.delete("/devices/{device_id}")
def device_remove(
    device_id: str,
    request: Request,
    response: Response,
    gate: DeviceGate = Depends(get_device_gate),
) -> dict:
    """Free a slot. Any device may remove any other (see .devices)."""
    me = gate.store.by_token(device_token(request), touch=False)
    try:
        gate.store.remove(device_id, by=me)
    except UnknownDevice as e:
        raise HTTPException(status_code=404, detail=f"unknown device {device_id!r}") from e
    if me is not None and me.id == device_id:
        response.delete_cookie(COOKIE, path="/")
    return {"removed": device_id}


@router.get("/eula/{eula_id}", response_class=FileResponse)
def eula(
    eula_id: str,
    gate: DeviceGate = Depends(get_device_gate),
    service: OchartsService = Depends(get_service),
) -> Response:
    """One EULA document as the chart set ships it. Vendor HTML, so it is
    served sandboxed: no script, no same-origin access."""
    for e in gate.eulas(service):
        if e.id == eula_id:
            return FileResponse(
                e.path,
                media_type="text/html; charset=utf-8",
                headers={
                    "Content-Security-Policy": "sandbox",
                    "Cache-Control": "no-cache",
                },
            )
    return JSONResponse({"detail": f"unknown licence agreement {eula_id!r}"}, status_code=404)


FEATURE: Feature[OchartsRuntime] = Feature(
    id="ocharts",
    routers=(router,),
    build_runtime=build_ocharts_runtime,
    data_provider=ocharts_data_provider,
    guard=ocharts_guard,
)
