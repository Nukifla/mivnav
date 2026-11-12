# SPDX-License-Identifier: GPL-2.0-only
"""/signalk — the boat's live data, fanned out to every device.

::

    GET  /signalk/state          the picture right now (one shot; curl-able)
    WS   /signalk/stream         the picture, and every change to it
    POST /signalk/collision/ack      acknowledge the collision alarm on SignalK
    POST /signalk/collision/silence  mute it on SignalK (re-armed after 2 min)

One upstream SignalK connection, shared by every device, rather than each
browser opening its own. See docs/architecture/signalk-stream-endpoint.md
for why WebSocket (not SSE/polling), why read-only, and why full
snapshots rather than proxied deltas.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from mivnav.api.deps import Runtime, get_runtime, get_signalk
from mivnav.signalk import (
    AccessRequestClient,
    SignalKService,
    SignalKUnavailable,
    SignalKUnreachable,
    Snapshot,
    fetch_self_paths,
    ws_to_http_base,
)
from mivnav.signalk.access import ADMIN
from mivnav.signalk.notifications import AckRefused, AckUnavailable, AckUnreachable, acknowledge, silence

log = logging.getLogger(__name__)

router = APIRouter(prefix="/signalk")

#: Queue sentinel: the browser went away.
_CLIENT_GONE = object()
#: A screen's "ping" was read: answer it with "pong" (see `watch_client`).
_PONG = object()


@router.get("/state")
def get_state(signalk: SignalKService = Depends(get_signalk)) -> Snapshot:
    """One-shot snapshot. Not what the app uses — it is what makes the
    connection inspectable with curl from the boat's shell."""
    return signalk.snapshot()


@router.get("/paths")
def list_paths(runtime: Runtime = Depends(get_runtime)) -> dict[str, list[dict[str, Any]]]:
    """Enumerate the boat's SignalK paths for the dashboard widget picker
    (the live delta stream only carries already-subscribed paths, so it
    can't supply this catalogue). SignalK disabled/unreachable is an
    EMPTY list, not an error — the picker still accepts freeform paths."""
    signalk = runtime.config.get().signalk
    if not signalk.enabled or not signalk.host:
        return {"paths": []}
    try:
        paths = fetch_self_paths(ws_to_http_base(signalk.ws_url))
    except (httpx.HTTPError, ValueError) as e:
        log.debug("could not enumerate SignalK paths: %s", e)
        return {"paths": []}
    return {"paths": paths}


# -- acknowledging / muting the collision alarm ----------------------------


class CollisionAckBody(BaseModel):
    #: The notification ids the user SAW (the snapshot's `collisionNotices`)
    #: — not "whatever is up now", so a target that escalated underneath the
    #: tap is not swallowed by it.
    ids: list[Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9-]+$")]] = Field(
        min_length=1, max_length=64
    )


@router.post("/collision/ack")
def acknowledge_collision(
    body: CollisionAckBody,
    runtime: Runtime = Depends(get_runtime),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, Any]:
    """Acknowledge our closestApproach notifications on the SignalK server,
    so every display and the MFD go quiet (docs/architecture/cpa-backend.md).
    Only ids that are OURS and still unacknowledged in the live snapshot are
    sent: this is not a general "ack anything on the bus" door, and SignalK
    answers a repeat ACK with an error. 503 = config (no SignalK / no write
    access), 502 = the box did not answer, 409 = SignalK said no."""
    sent = _collision_action(
        body, runtime, signalk, acknowledge, lambda n: n.get("canAcknowledge", True)
    )
    return {"ok": True, "acknowledged": sent}


@router.post("/collision/silence")
def silence_collision(
    body: CollisionAckBody,
    runtime: Runtime = Depends(get_runtime),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, Any]:
    """Silence our closestApproach notifications on the SignalK server: the
    sound stops on every display, the alarm stays up. SignalK's silence has
    no timer; the collision publisher re-arms it after ``MUTE_S`` (2 min).
    Same filtering and errors as the ACK — an already-silenced or ACKed id
    is skipped, because SignalK refuses a repeat."""
    sent = _collision_action(
        body,
        runtime,
        signalk,
        silence,
        lambda n: not n.get("silenced") and n.get("canSilence", True),
    )
    return {"ok": True, "silenced": sent}


def _collision_action(
    body: CollisionAckBody,
    runtime: Runtime,
    signalk: SignalKService,
    action: Callable[[str, str | None, str], None],
    eligible: Callable[[dict[str, Any]], bool],
    notices: Callable[[dict[str, Any]], list[dict[str, Any]]] | None = None,
) -> int:
    config = runtime.config.get()
    if not config.signalk.enabled:
        raise HTTPException(status_code=503, detail="SignalK is disabled in this server's configuration")
    snapshot = signalk.snapshot()
    ours = (
        notices(snapshot)
        if notices is not None
        else list((snapshot.get("collisionNotices") or {}).values())
    )
    live = {
        n["id"]
        for n in ours
        if isinstance(n.get("id"), str) and not n.get("acknowledged") and eligible(n)
    }
    wanted = [i for i in dict.fromkeys(body.ids) if i in live]
    token = config.credentials.signalk.token.get_secret_value() or None
    try:
        for notification_id in wanted:
            action(config.signalk.notifications_url, token, notification_id)
    except AckUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except AckUnreachable as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except AckRefused as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return len(wanted)


# -- acknowledging / muting the shallow-water alarm --------------------------


@router.post("/shallow/ack")
def acknowledge_shallow(
    body: CollisionAckBody,
    runtime: Runtime = Depends(get_runtime),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, Any]:
    """Acknowledge our shallow-water notification on the SignalK server
    (:mod:`mivnav.shallow`) — same contract and errors as the collision ACK."""
    sent = _collision_action(
        body,
        runtime,
        signalk,
        acknowledge,
        lambda n: n.get("canAcknowledge", True),
        notices=_shallow_notices,
    )
    return {"ok": True, "acknowledged": sent}


@router.post("/shallow/silence")
def silence_shallow(
    body: CollisionAckBody,
    runtime: Runtime = Depends(get_runtime),
    signalk: SignalKService = Depends(get_signalk),
) -> dict[str, Any]:
    """Silence our shallow-water notification on the SignalK server; re-armed
    by the publisher after ``MUTE_S``, like the collision alarm."""
    sent = _collision_action(
        body,
        runtime,
        signalk,
        silence,
        lambda n: not n.get("silenced") and n.get("canSilence", True),
        notices=_shallow_notices,
    )
    return {"ok": True, "silenced": sent}


def _shallow_notices(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    notice = snapshot.get("shallowNotice")
    return [notice] if isinstance(notice, dict) else []


# -- obtaining the autopilot write token -----------------------------------
# SignalK's device access-request handshake, driven here so a human never
# hand-mints a token. See docs/architecture/signalk-stream-endpoint.md.


def _access_client(runtime: Runtime) -> AccessRequestClient:
    """Build the handshake client, or refuse with 409 (not 502) when
    SignalK is disabled/unconfigured — a config fault, distinct from the
    box being unreachable."""
    signalk = runtime.config.get().signalk
    if not signalk.enabled or not signalk.host:
        raise HTTPException(
            status_code=409,
            detail=(
                "SignalK is not configured on this server, so there is no "
                "server to request write access from. Enable and point the "
                "SignalK connection at the boat's box first."
            ),
        )
    return AccessRequestClient(ws_to_http_base(signalk.ws_url))


@router.post("/access-request")
def start_access_request(runtime: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Ask the SignalK server for admin access: ``{"state": "PENDING",
    "requestId"}``. ``clientId`` is minted once and persisted so a
    re-request references the same device and SignalK's re-approval
    works."""
    client = _access_client(runtime)
    client_id = runtime.ensure_signalk_client_id()
    try:
        # admin, not readwrite: the plain SignalK API (autopilot, course,
        # resources, notifications, v1 PUTs, history) only needs write, but
        # plugin config (e.g. the anchor alarm's delay / noPositionAlarmTime)
        # and plugin routes are admin-gated in signalk-server. User decision
        # 2026-11-06: one admin token rather than a second request later.
        result = client.request_access(client_id, permissions=ADMIN)
    except SignalKUnavailable as e:  # pragma: no cover - _access_client vetoes first
        raise HTTPException(status_code=409, detail=str(e)) from e
    except SignalKUnreachable as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"state": result["state"], "requestId": result["requestId"]}


@router.get("/access-request/{request_id}")
def poll_access_request(
    request_id: str, runtime: Runtime = Depends(get_runtime)
) -> dict[str, Any]:
    """Poll a pending request; on approval, write the token to
    credentials.json (0600) and return ``{"state": "COMPLETED", "approved"}``
    — never the token itself. A 502 (box unreachable/expired) is never
    softened into a 200."""
    client = _access_client(runtime)
    try:
        result = client.poll(request_id)
    except SignalKUnavailable as e:  # pragma: no cover - _access_client vetoes first
        raise HTTPException(status_code=409, detail=str(e)) from e
    except SignalKUnreachable as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if result["state"] != "COMPLETED":
        return {"state": "PENDING"}
    if not result["approved"]:
        return {"state": "COMPLETED", "approved": False}
    # Config store splits this into credentials.json (0600); autopilot
    # client reads the token per call, so this takes effect live.
    runtime.patch_config({"credentials": {"signalk": {"token": result["token"]}}})
    return {"state": "COMPLETED", "approved": True}


@router.websocket("/stream")
async def stream(websocket: WebSocket, runtime: Runtime = Depends(get_runtime)) -> None:
    """Subscribe this client to the boat's connection until it leaves. The
    upstream connection outlives any one client — see
    docs/architecture/signalk-stream-endpoint.md."""
    await websocket.accept()
    loop = asyncio.get_running_loop()
    # Carries snapshots plus three sentinels: `None` (service superseded),
    # _CLIENT_GONE and _PONG. The service pushes from its own thread.
    queue: asyncio.Queue[Snapshot | None | object] = asyncio.Queue()

    async def watch_client() -> None:
        """Notice the browser leaving — an idle boat publishes nothing,
        so a closed socket needs an active read to detect."""
        try:
            while True:
                # A screen's liveness probe (`signalk.ts`): answered at once,
                # so a browser can call the server unreachable within seconds
                # even while the boat is idle and no snapshot is due.
                if await websocket.receive_text() == "ping":
                    queue.put_nowait(_PONG)
        except Exception:  # noqa: BLE001 — disconnect, in every shape
            pass
        finally:
            queue.put_nowait(_CLIENT_GONE)

    watcher = asyncio.create_task(watch_client())
    unsubscribe: Callable[[], None] | None = None
    try:
        while True:
            if unsubscribe is None:
                # Resolved off the loop: a rebuild closes the superseded
                # service and joins its reader thread. See get_signalk.
                service: SignalKService = await run_in_threadpool(runtime.signalk)
                # subscribe() delivers the current snapshot synchronously,
                # so this client is correct before its first await.
                unsubscribe = service.subscribe(
                    lambda message: loop.call_soon_threadsafe(queue.put_nowait, message)
                )
            message = await queue.get()
            if message is _CLIENT_GONE:
                return
            if message is _PONG:
                await websocket.send_text("pong")
                continue
            if message is None:
                # Config changed; re-resolve and carry on — the client sees a
                # data gap, nothing else. A late `None` from the superseded
                # service after we've moved on is harmless: one extra re-resolve.
                if unsubscribe is not None:
                    unsubscribe()
                unsubscribe = None
                continue
            await websocket.send_json(message)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.exception("the SignalK stream to a client failed")
    finally:
        if unsubscribe is not None:
            unsubscribe()
        watcher.cancel()
