# SPDX-License-Identifier: GPL-2.0-only
"""``/track`` — where the boat has been, and the ``FEATURE`` registration.

See docs/architecture/track-route.md for the wire-format contract
(GeoJSON lon/lat axis order), the per-status-code retry semantics, and why
this is the one module in the package allowed to import ``mivnav.api.deps``.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query

from mivnav.api.deps import Runtime, get_runtime
from mivnav.feature import Feature
from mivnav.features.track.client import (
    DEFAULT_HOURS,
    MAX_HOURS,
    TrackRefused,
    TrackUnavailable,
    TrackUnreachable,
    TrackUnsupported,
    wire_time,
)
from mivnav.features.track.provider import track_data_provider
from mivnav.features.track.runtime import TrackRuntime, build_track_runtime
from mivnav.features.track.store import split_recent

log = logging.getLogger(__name__)

router = APIRouter(prefix="/track")

#: The stretch of track drawn prominently; everything older is subdued.
#: A passage-length "where have I just come from", per the user's ask.
RECENT_HOURS = 24.0

__all__ = ["FEATURE", "get_track", "router"]


def get_track(runtime: Runtime = Depends(get_runtime)) -> TrackRuntime:
    return cast(TrackRuntime, runtime.feature("track"))


@router.get("")
def track(
    hours: float = Query(
        default=DEFAULT_HOURS,
        gt=0,
        le=MAX_HOURS,
        description="How far back to look, in hours.",
    ),
    all_history: bool = Query(
        default=False,
        alias="all",
        description="Everything the history plugin holds; overrides `hours`.",
    ),
    track_runtime: TrackRuntime = Depends(get_track),
) -> dict:
    """The vessel's track over the last ``hours`` (or, with ``all=true``,
    all of it) as separate lines, oldest first — a line ends wherever the
    record has a hole. ``complete: false`` means past days are still being
    fetched: ask again. See docs/architecture/track-route.md."""
    try:
        result = track_runtime.track(None if all_history else hours)
    except TrackUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except TrackUnsupported as e:
        raise HTTPException(status_code=501, detail=str(e)) from e
    except TrackUnreachable as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except TrackRefused as e:
        # Our query, their rejection — logged here because the message
        # names a parameter this backend built, so it is a bug report
        # about ourselves that the user should not have to relay.
        log.warning("SignalK refused the history query: %s", e)
        raise HTTPException(status_code=502, detail=str(e)) from e

    older, recent = split_recent(result.lines, result.end.timestamp() - RECENT_HOURS * 3600)

    def wire(lines: list) -> list:
        return [[[f.lon, f.lat] for f in line] for line in lines]

    last = max((line[-1].t for line in result.lines), default=None)

    return {
        # Older than RECENT_HOURS, and the last RECENT_HOURS: the chart
        # draws the recent part prominently and the rest subdued.
        "lines": wire(older),
        "recent": wire(recent),
        "from": wire_time(result.start) if result.start else None,
        "to": wire_time(result.end),
        # When the newest drawn fix was taken. With `to`, how far the
        # history plugin lags behind now — the client extends the line from
        # the live position past exactly that point, with no shared clock.
        "last": wire_time(datetime.fromtimestamp(last, UTC)) if last is not None else None,
        "count": sum(len(line) for line in result.lines),
        "complete": result.complete,
    }


@router.get("/providers")
def providers(track_runtime: TrackRuntime = Depends(get_track)) -> dict:
    """The history providers the SignalK box has registered, for the
    settings dropdown, and which one ``track.history_provider`` names
    (``null`` = SignalK's default). Same status codes as ``GET /track``."""
    try:
        found = track_runtime.providers()
    except TrackUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except TrackUnsupported as e:
        raise HTTPException(status_code=501, detail=str(e)) from e
    except (TrackUnreachable, TrackRefused) as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "providers": [{"id": p.id, "default": p.default} for p in found],
        "selected": track_runtime.selected_provider(),
    }


FEATURE: Feature[TrackRuntime] = Feature(
    id="track",
    routers=(router,),
    build_runtime=build_track_runtime,
    data_provider=track_data_provider,
)
