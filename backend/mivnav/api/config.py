# SPDX-License-Identifier: GPL-2.0-only
"""/config — read and edit the server's configuration, and the visual
settings profiles.

::

    GET    /config                  the config (secrets redacted) + meta
    PATCH  /config                  deep-merge a partial config, persist it
    POST   /config/reload           re-read a hand-edited config file
    GET    /config/profiles         every named visual profile + the default
    GET    /config/profiles/{name}
    PUT    /config/profiles/{name}  save (create or replace)
    DELETE /config/profiles/{name}
    PUT    /config/profiles/{name}/default   anoint as the boat-wide default
    DELETE /config/profiles/{name}/default   clear it (if it is the default)
    GET    /config/layouts          every named dashboard/band widget layout
    GET    /config/layouts/{name}
    PUT    /config/layouts/{name}   save (create or replace)
    DELETE /config/layouts/{name}

See docs/architecture/config-api-design.md for why PATCH not PUT, secret
handling, why config changes apply without a restart, and why layouts have
no `/default` sub-resource the way profiles do.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Response

from mivnav.api.deps import ConfigInUse, Runtime, get_runtime
from mivnav.config import ConfigError, ProfileError, redacted
from mivnav.config.model import Config

log = logging.getLogger(__name__)

router = APIRouter(prefix="/config")


def _payload(runtime: Runtime, config: Config) -> dict[str, Any]:
    """The GET/PATCH response: the redacted config plus the read-only
    facts a UI needs but must not send back — kept in `meta` precisely so
    that `config` stays a clean round-trippable document."""
    return {
        "config": redacted(config),
        "meta": {
            "path": str(runtime.config.path),
            "credentials_path": str(runtime.config.credentials_path),
            "profiles_path": str(runtime.profiles.path),
            "layouts_path": str(runtime.layouts.path),
            # Whether a password/token exists, never which — the UI shows
            # "configured" vs "not" from this.
            "ocharts_password_set": bool(
                config.credentials.ocharts.password.get_secret_value()
            ),
            "signalk_token_set": bool(
                config.credentials.signalk.token.get_secret_value()
            ),
            # Whether the RouteIQ access token is configured — the routing
            # settings UI shows "connected" vs "not connected" from this,
            # the same role signalk_token_set plays for autopilot write
            # access (the autorouting plugin's routes.py).
            "routeiq_token_set": bool(
                config.credentials.routeiq.token.get_secret_value()
            ),
            "signalk_url": config.signalk.ws_url,
            # Random per-process, never persisted: the only signal a client
            # has that the backend RESTARTED, not just had its config
            # edited (serverConfig.ts busts the tile cache on change).
            "boot_id": runtime.boot_id,
        },
    }


@router.get("")
def get_config(runtime: Runtime = Depends(get_runtime)) -> dict:
    return _payload(runtime, runtime.config.get())


@router.patch("")
def patch_config(
    patch: dict[str, Any] = Body(...), runtime: Runtime = Depends(get_runtime)
) -> dict:
    """Merge a partial config in and persist it."""
    try:
        config = runtime.patch_config(patch)
    except ConfigInUse as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ConfigError as e:
        # Shape/range complaints only; never echo the patch itself, on principle.
        raise HTTPException(status_code=422, detail=str(e)) from e
    return _payload(runtime, config)


@router.post("/reload")
def reload_config(runtime: Runtime = Depends(get_runtime)) -> dict:
    """Re-read the config file — for an operator who hand-edited it."""
    try:
        config = runtime.reload_config()
    except ConfigError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return _payload(runtime, config)


# -- visual settings profiles ---------------------------------------------


@router.get("/profiles")
def list_profiles(runtime: Runtime = Depends(get_runtime)) -> dict:
    # `default`: the name a new client adopts on first boot, `null` if unset.
    return {
        "profiles": runtime.profiles.list(),
        "default": runtime.profiles.default(),
    }


@router.get("/profiles/{name}")
def get_profile(name: str, runtime: Runtime = Depends(get_runtime)) -> dict:
    profile = runtime.profiles.get(name)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"unknown profile {name!r}")
    return profile


@router.put("/profiles/{name}")
def put_profile(
    name: str,
    settings: dict[str, Any] = Body(...),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """Save a profile under ``name``, creating or replacing it.

    The body *is* the settings object and is stored verbatim — the backend
    does not model the frontend's display fields and has no opinion about
    them (see mivnav.config.profiles).
    """
    try:
        return runtime.profiles.save(name, settings)
    except ProfileError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.delete("/profiles/{name}")
def delete_profile(name: str, runtime: Runtime = Depends(get_runtime)) -> Response:
    if not runtime.profiles.delete(name):
        raise HTTPException(status_code=404, detail=f"unknown profile {name!r}")
    return Response(status_code=204)


# `/{name}/default`, not a sibling `/config/profiles/default`: a profile may
# be *named* "default", which would collide with a sibling route. See
# docs/architecture/config-api-design.md.


@router.put("/profiles/{name}/default")
def set_default_profile(name: str, runtime: Runtime = Depends(get_runtime)) -> dict:
    """Anoint ``name`` as the boat-wide default, replacing any previous
    one. 404 if the profile does not exist — a default cannot dangle."""
    if not runtime.profiles.set_default(name):
        raise HTTPException(status_code=404, detail=f"unknown profile {name!r}")
    return {"default": name}


@router.delete("/profiles/{name}/default")
def clear_default_profile(name: str, runtime: Runtime = Depends(get_runtime)) -> Response:
    """Clear the default if ``name`` is the one currently anointed.
    Idempotent — 204 whether or not it was."""
    runtime.profiles.clear_default(name)
    return Response(status_code=204)


# -- dashboard/band widget layouts -----------------------------------------
# Profiles' twin: same NamedBlobStore, same verbs, no /default (see
# docs/architecture/config-api-design.md).


@router.get("/layouts")
def list_layouts(runtime: Runtime = Depends(get_runtime)) -> dict:
    return {"layouts": runtime.layouts.list()}


@router.get("/layouts/{name}")
def get_layout(name: str, runtime: Runtime = Depends(get_runtime)) -> dict:
    layout = runtime.layouts.get(name)
    if layout is None:
        raise HTTPException(status_code=404, detail=f"unknown layout {name!r}")
    return layout


@router.put("/layouts/{name}")
def put_layout(
    name: str,
    arrangement: dict[str, Any] = Body(...),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """Save a layout under ``name``, creating or replacing it.

    The body *is* the arrangement object (the device's `enabled`/`bands`/
    `dashboard` slice) and is stored verbatim — the backend does not model
    the frontend's widget/band shape and has no opinion about it (see
    mivnav.config.profiles).
    """
    try:
        return runtime.layouts.save(name, arrangement)
    except ProfileError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.delete("/layouts/{name}")
def delete_layout(name: str, runtime: Runtime = Depends(get_runtime)) -> Response:
    if not runtime.layouts.delete(name):
        raise HTTPException(status_code=404, detail=f"unknown layout {name!r}")
    return Response(status_code=204)
