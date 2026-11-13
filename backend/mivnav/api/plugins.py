# SPDX-License-Identifier: GPL-2.0-only
"""``/plugins`` — the installed out-of-tree plugins (``mivnav.plugins``) and
their on/off switch, for Settings → Plugins.

Switching a plugin off is boat-wide (``Config.plugins_disabled``), not per
screen: a plugin's backend half (routes, POI sources, dataset providers) is
shared by every screen. It takes effect at once on the server; each screen
picks up the frontend half on its next load.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.params import Depends as DependsParam

from mivnav.api.deps import ConfigInUse, Runtime, get_runtime
from mivnav.config import ConfigError
from mivnav.plugins import feature_owner, is_enabled, plugins

router = APIRouter(prefix="/plugins", tags=["plugins"])


def _listing() -> dict:
    return {
        "plugins": [
            {"id": p.id, "label": p.title, "enabled": is_enabled(p.id)} for p in plugins()
        ]
    }


@router.get("")
def list_plugins() -> dict:
    """Every installed plugin, whether it is switched on."""
    return _listing()


@router.put("/{plugin_id}")
def set_plugin_enabled(
    plugin_id: str,
    enabled: bool = Body(..., embed=True),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """Switch an installed plugin on or off."""
    if not any(p.id == plugin_id for p in plugins()):
        raise HTTPException(status_code=404, detail=f"no plugin {plugin_id!r} is installed")
    disabled = [d for d in runtime.config.get().plugins_disabled if d != plugin_id]
    if not enabled:
        disabled.append(plugin_id)
    try:
        runtime.patch_config({"plugins_disabled": sorted(disabled)})
    except ConfigInUse as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ConfigError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return _listing()


def plugin_gate(feature_id: str) -> DependsParam | None:
    """A route dependency that 404s while the plugin owning ``feature_id``
    is switched off — ``None`` for a built-in feature."""
    owner = feature_owner(feature_id)
    if owner is None:
        return None

    def _require_enabled() -> None:
        if not is_enabled(owner):
            raise HTTPException(status_code=404, detail=f"plugin {owner!r} is switched off")

    return Depends(_require_enabled)
