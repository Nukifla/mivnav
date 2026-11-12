# SPDX-License-Identifier: GPL-2.0-only
"""``/providers`` — the unified status surface over every data source.

The chart store and SignalK resolve through the usual shared deps
(``get_store``/``get_signalk``). Registered features resolve via
``runtime.feature(id)`` instead — the same object every other route for
that provider already resolves through — so a test's ``dependency_overrides``
still reaches every consumer without a provider-specific ``Depends`` here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from mivnav.api.deps import Runtime, get_runtime, get_signalk, get_store
from mivnav.api.features import FEATURES
from mivnav.charts.store import ChartStore
from mivnav.data import build_registry
from mivnav.signalk import SignalKService

router = APIRouter()


@router.get("/providers")
def providers(
    runtime: Runtime = Depends(get_runtime),
    store: ChartStore = Depends(get_store),
    signalk: SignalKService = Depends(get_signalk),
) -> dict:
    """Each known provider's static descriptor plus its live stats."""
    registry = build_registry(
        runtime.config.get(),
        store=store,
        signalk=signalk,
        features=FEATURES,
        feature_runtime=runtime.feature,
    )
    return {
        "providers": [{**p.summary(), "stats": p.stats()} for p in registry]
    }
