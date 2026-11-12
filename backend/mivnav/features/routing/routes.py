# SPDX-License-Identifier: GPL-2.0-only
"""``/routing`` — computing a passage between two points, and the
``FEATURE`` registration.

::

    POST /routing/plan               a hazard-avoiding path from one point
                                     to another
    POST /routing/mivnav/build       build one chart set's precomputed
                                     `.mivnav` routing artifact (background
                                     job; MANUAL TRIGGER ONLY)
    GET  /routing/mivnav/build       poll that job
    POST /routing/mivnav/build/cancel
    GET  /routing/mivnav/artifacts   which chart sets have a usable
                                     artifact, and why the others do not

**Status: a real hazard-avoiding route, no rules stage yet.**
``plan_route`` runs the raster-grid + A* search
(``chartcore::routing::raster::shortest_path``, exposed as
``chartcore.shortest_path``) over the real, live o-charts hazard data for
every chart cell near the line, at the boat's own draft — the returned
waypoints genuinely bend around whatever charted danger sits between
``from`` and ``to``, verified exactly (segment geometry, not sampling),
not just flagged. On top of that, four OPTIONAL soft preferences (off by
default): water further from a hazard, avoiding TSS-family zones,
preferring the "preferred route" family (a marked fairway, recommended
track, navigation line, or deep-water route part —
``chartcore::routing::preference``), and passing a lateral buoy/beacon
(``BOYLAT``/``BCNLAT``) on its charted-correct side for the direction
being sailed (``chartcore::routing::buoyage`` — deliberately not
preferred-channel marks or cardinal/isolated-danger/safe-water marks; see
that module's own docs). What is still missing is a full rules pass:
traffic-separation crossing angle, and cardinal-mark/preferred-channel
buoyage side. See ``ROUTING_TODO.md`` at the repo root for where that
stands.

When ``from``/``to`` itself sits inside a hazard at this draft/margin, or
(rare) no real path connects them at all — get as close as you can with
the good auto-route, then draw a straight line the rest (asked for
directly, tested from inside a harbour whose own basin the hazard union
swallows whole): the search routes right up to the boundary of whatever
it can't actually reach and stitches on a straight line for the
remainder, rather than giving up and drawing a bare straight line for the
WHOLE request the way it used to. ``PlanResponse.approximate_legs`` says
WHICH leg(s) — not only the first/last: a single grid resolution shared
across one long corridor can miss a real, narrow hazard anywhere along
the route, not only near the two ends (found live, tested from the same
harbour: a real ~63nm request threaded a leg straight through a real
headland near its start at 220m grid resolution, passing the grid's own
walkability check the whole way) — so a client can draw any flagged
stretch differently (a warning dash, not the ordinary route line) — see
``chartcore::routing::raster::shortest_path_weighted``'s own docs for the
mechanism (``RoutePath.approximate_legs``). A client always gets *some*
line to draw, never an error, but never a silent "this wasn't checked"
either (see ``mivnav.features.autopilot.routes`` for the same instinct
applied to a command instead of a computation). ``None`` only in the
genuinely pathological case where chartcore finds no water at all to
route through anywhere near the request — the bare straight line is still
the fallback there, unchanged from before this existed. A route that
*was* found (fully or partly) still carries one standing warning naming
the one real gap left: no rules stage yet.

When even THAT is still badly unreachable — not a resolution miss the
per-leg search's own refinement already fixes, but a real detour entirely
outside its corridor (a whole landmass in the way, e.g.) — a coarse,
land-only MACRO pass (``RoutingConfig.macro_route_enabled``, default ON)
finds the real topological corridor over a much larger area and the real,
depth-aware search is re-run leg by leg along it (``_stitch_macro_route``,
``mivnav.features.routing.hazards``' macro-route functions,
``chartcore::routing::raster::macro_route``). Found live: a request that
could only be completed by a real detour around a peninsula. A macro
detour, when used, carries its own standing warning: it was only checked
against charted LAND, never a bridge, lock, or cable.

Everything above describes the DEFAULT engine
(``RoutingConfig.algorithm == "raster"``). Four others answer the same
request through the same ``PlanResponse``: ``"routeiq"``
(``_plan_via_routeiq``, a remote SignalK plugin), ``"graph"``
(``_plan_via_graph``, a local adaptive-resolution graph), ``"artifact"``
(``_plan_via_artifact``, ``chartcore::routing::artifact`` — a
from-scratch fourth algorithm implementing
``mivnav_routing_architecture_v3.md``'s own model: a much wider hard-
constraint feature set, ``CATZOC`` as a real horizontal buffer and depth
allowance, §9.3 endpoint grace so that strictness does not make a
coverage-edge marina unreachable, a source-driven resolution ladder, and
deterministic integer costs), and ``"mivnav"`` (``_plan_via_mivnav`` —
the SAME ``"artifact"`` search, plus ``chartcore::mivnav``'s own
precomputed-topology pipeline run alongside it for diagnostics; see
``_plan_via_mivnav``'s own docstring for exactly what it does and does
not change about the route yet). None of the four has the macro-detour
or partial-route machinery above; each falls back to the honest straight
line with its own reason instead.

**Watching a request work**: every call logs a step-by-step timing
breakdown at INFO (``hazards.Timings`` — candidate-cell selection, EACH
cell's own ``hazard_index`` build, the graph search, the total), visible
in ``just dev``'s own console with no extra setup — built after a real
request against real data took 97 seconds and finding out where the time
went needed an offline profiler, which shouldn't be the only way to see
it (``ROUTING_TODO.md``). Pass ``{"debug": true}`` in the request body to
get that same breakdown back on the wire too, e.g. ``curl .../plan -d
'{"from": ..., "to": ..., "debug": true}' | jq .timings``.

This feature owns no store, but now owns a config slice
(``mivnav.features.routing.config.RoutingConfig``, read live per request —
same "no daemon/mmap to memoize" reasoning as
``mivnav.features.route.config.NavConfig``) for the safety depth/margin
and the optional soft shallow-water preference — see that module's own
docstring for what each field does and
``chartcore::routing::raster::shortest_path_weighted`` for the mechanism
the last two fields drive. It DOES also reach live boat/chart state:
SignalK (``mivnav.signalk`` is kernel-adjacent, every feature may import it
directly) for the boat's own draft, and o-charts via ``mivnav.api.charts``
— the one composition-layer module (besides ``mivnav.api.deps``) a
feature's own ``routes.py`` may import, same edge POI/satellite already use
for their own shared tile-serving helpers. See ``hazards.py`` for why that
module, unlike this one, stays duck-typed on ``ocharts`` instead of
importing ``mivnav.features.ocharts`` for a type it isn't allowed to name.
"""

from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any, cast

import chartcore
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from mivnav.api.charts import OchartsService, get_ocharts
from mivnav.api.deps import Runtime, get_runtime, get_signalk
from mivnav.feature import Feature
from mivnav.features.routing.artifact_build import MivnavBuildError, MivnavBuildRunner
from mivnav.features.routing.config import RoutingConfig
from mivnav.features.routing.geo import Point, haversine_m
from mivnav.features.routing.hazards import (
    StitchedRoute,
    Timings,
    artifact_diagnostics,
    buoyage_indexes_for_line,
    candidate_chart_sets_for_line,
    cells_for_line,
    check_manually_indexes_for_bbox,
    find_artifact_route,
    find_artifact_route_debug,
    find_graph_route,
    find_macro_detour,
    find_mivnav_coarse_route,
    find_mivnav_route,
    find_route,
    flagged_run_index_spans,
    flagged_run_spans_nm,
    hazard_indexes_for_bbox,
    hazard_indexes_for_line,
    land_indexes_for_macro_route,
    leg_debug_info,
    mivnav_diagnostics,
    needs_macro_route,
    point_in_any_hazard,
    preference_indexes_for_line,
)
from mivnav.features.routing.mivnav_artifact import (
    TOPOLOGY_SOURCE_ARTIFACT,
    UnusableChartSetId,
)
from mivnav.features.routing.mivnav_artifact import (
    artifact_status as mivnav_artifact_status,
)
from mivnav.features.routing.mivnav_artifact import (
    artifact_path as mivnav_artifact_path,
)
from mivnav.features.routing.provider import routing_data_provider
from mivnav.features.routing.routeiq import (
    RouteIQClient,
    RouteIQError,
    RouteIQNotFound,
    RouteIQRoute,
    RouteIQUnavailable,
    RouteIQUnreachable,
)
from mivnav.features.routing.runtime import (
    RoutingRuntime,
    build_routing_runtime,
    routing_guard,
)
from mivnav.signalk import (
    AccessRequestClient,
    SignalKService,
    SignalKUnavailable,
    SignalKUnreachable,
    ws_to_http_base,
)
from mivnav.signalk.access import ADMIN

router = APIRouter(prefix="/routing")

__all__ = ["FEATURE", "router"]

#: Metres per nautical mile — the unit ``distance_nm`` reports in, matching
#: every other distance already shown to a helmsman on this plotter.
_METRES_PER_NM = 1852.0

#: Standing caveat on every FOUND route — the real gaps left after the
#: raster search: no traffic-lane crossing-angle check, and buoyage side
#: is at most a soft, OFF-by-default preference for lateral marks —
#: cardinal-mark/preferred-channel buoyage is not checked at all. Always
#: present on a successful route, same "never a silent 200" instinct the
#: old placeholder warning served (see the module docstring).
_NO_RULES_WARNING = (
    "hazard-avoiding route only: traffic-lane crossing angle is not checked; "
    "buoyage side is at most a soft preference for lateral marks when enabled "
    "— cardinal-mark/preferred-channel side is never checked — verify "
    "manually before following"
)

#: Appended only when a macro-scale detour (``_stitch_macro_route``) was
#: actually used for this response — the macro pass's own COARSE land-only
#: scan (``land_indexes_for_macro_route``, built at ``safety_depth_m=
#: margin_m=0.0``, air draft left off) never knows about a bridge, lock,
#: cable, or seasonal closure. Every FINE leg along the detour is still
#: the real, depth-AND-air-draft-aware search (``_plan_leg``, which DOES
#: now check ``BRIDGE``/``CBLOHD`` clearance whenever ``cfg.air_draft_m``
#: is configured), so this warning's claim is deliberately unconditional
#: on that config value — a lock's operating hours/closure state is not
#: something this router can ever know regardless, so "verify manually"
#: stays the honest, permanent caveat for a long automatic detour either
#: way, not something air-draft configuration alone resolves.
_MACRO_ROUTE_WARNING = (
    "this route includes a long automatic detour around a landmass — lock "
    "closures and any bridge/cable NOT covered by this boat's own air-draft "
    "setting have NOT been checked; verify manually before following"
)

#: Standing caveat on every route the REMOTE RouteIQ algorithm produces —
#: the routing engine mivnav's own rules/warnings above have nothing to
#: say about, since it isn't chartcore. Deliberately does not repeat
#: `_NO_RULES_WARNING`'s specific claims (traffic-lane angle, buoyage
#: side) — those are about the RASTER search's own gaps, not RouteIQ's,
#: whose own real coverage/rule gaps are unknown from here. See
#: `mivnav.features.routing.routeiq`'s own module docstring.
_ROUTEIQ_WARNING = (
    "computed by RouteIQ (a remote SignalK plugin, not this app's own "
    "hazard-avoiding search) — verify independently before following, "
    "especially outside RouteIQ's own currently-published coverage"
)

#: Standing caveat on every route the LOCAL adaptive-graph algorithm
#: produces — names the specific, deliberate simplifications from a
#: literal RouteIQ port (`chartcore::routing::raster::graph`'s own module
#: docs have the full reasoning): the fairway/buoyage/TSS cost terms are
#: flat zone-membership multipliers rather than RouteIQ's own per-edge
#: local-bearing test. Air-draft/bridge-clearance checking is NOT one of
#: these gaps any more — `_plan_via_graph` feeds it the same
#: `cfg.air_draft_m`-gated hazard union `_plan_leg` uses, so a
#: `BRIDGE`/`CBLOHD` this boat cannot clear blocks here exactly as it does
#: for the primary raster search.
_GRAPH_WARNING = (
    "computed by the adaptive-graph algorithm — a second, experimental "
    "search, not the primary hazard-avoiding one: its fairway/buoyage/TSS "
    "preferences are simplified from RouteIQ's own design; verify "
    "manually before following"
)

#: Standing caveat on every route the LOCAL "artifact" algorithm produces
#: (`RoutingConfig.algorithm == "artifact"`, `chartcore::routing::
#: artifact`) — deliberately NOT `_NO_RULES_WARNING`'s text: that one
#: names the RASTER search's own gaps, and this algorithm's are different
#: in both directions. It checks MORE than the raster search does (the
#: construction family, `SOUNDG`, absent coverage, `RESARE` `RESTRN=8`,
#: `CATZOC` as a real buffer), and it is a deliberate MVP of the v3
#: architecture rather than the whole of it: no depth-band ladder, no
#: portal topology, and — the part a helmsman actually has to know — no
#: directional semantics at all, so traffic-lane direction, one-way
#: channels, lock and opening-bridge scheduling and buoyage side are not
#: modelled here either. Newer and far less battle-tested than the
#: primary raster search, which is why that one stays the default engine.
_ARTIFACT_WARNING = (
    "computed by the v3 artifact algorithm — a newer, stricter, less "
    "battle-tested search than the primary hazard-avoiding one: it checks "
    "a wider set of charted obstructions and survey quality, but models no "
    "traffic-lane direction, lock/bridge opening schedule, or buoyage side; "
    "verify manually before following"
)

#: Standing caveat on every route the LOCAL "mivnav" algorithm produces
#: (`RoutingConfig.algorithm == "mivnav"`). This is `_ARTIFACT_WARNING`'s
#: own caveat, verbatim, PLUS one more sentence: `"mivnav"` runs the
#: `"artifact"` fine search underneath, and only departs from its route
#: when `mivnav_beam_m > 0` lets §12.4 local vector refinement re-route a
#: marginal-width crossing (see `_plan_via_mivnav`'s own docs) — still an
#: early build toward the full v3 architecture, not that architecture
#: finished.
_MIVNAV_WARNING = (
    "computed by the v3 artifact algorithm — a newer, stricter, less "
    "battle-tested search than the primary hazard-avoiding one: it checks "
    "a wider set of charted obstructions and survey quality, but models no "
    "traffic-lane direction, lock/bridge opening schedule, or buoyage side; "
    "verify manually before following. The 'mivnav' engine additionally "
    "runs a precomputed-topology cross-check alongside this search, and "
    "with a beam set will locally re-route a marginal-width crossing "
    "through it — an early build toward the full v3 architecture, not that "
    "architecture finished"
)

#: Standing caveat prepended to a route the mivnav engine assembled by
#: STITCHING per-leg fine searches along a coarse portal-graph corridor
#: (`_stitch_mivnav_coarse_route`) — reached only when the ordinary
#: single-corridor fine search found no path (a detour past
#: `routing::raster`'s ±50 km straight-line cap). Every leg between the
#: coarse corridor's points is still the real draft-aware fine search
#: with §16 verification, but the OVERALL shape came from the precomputed
#: topology, which models no lock/bridge schedule — same permanent
#: "verify manually" caveat a `_MACRO_ROUTE_WARNING` detour carries, for
#: the same reason.
_MIVNAV_COARSE_WARNING = (
    "the mivnav fine search found no direct route, so this route follows "
    "the precomputed portal-graph corridor with the draft-aware fine "
    "search re-run leg by leg along it — an automatic long detour: "
    "individual legs are verified against charted land and depth, but the "
    "overall path is NOT checked for lock/bridge/cable clearance. Verify "
    "manually before following"
)

#: Metres. Endpoint grace for the COARSE portal-graph search only —
#: larger than `RoutingConfig.artifact_endpoint_grace_radius_m` (150 m,
#: tuned for a fine search snapping an endpoint to its exact navigable
#: cell) because the coarse guide is TILE-granularity and topological:
#: its start/end only have to REACH the portal network, and the per-leg
#: `find_artifact_route` in `_stitch_mivnav_coarse_route` does the
#: precise endpoint work from the real `a`/`b`.
#:
#: Kept at a few km on purpose, NOT tens of km: measured on the current
#: national DK `.mivnav`, that artifact's per-band topology is sparse
#: (≈480 components, large navigable areas with no portal at all), so a
#: grace big enough to always connect also snaps an endpoint 15–30 km to
#: a portal tile, and the resulting first/last stitch leg is then too
#: long for the fine search to follow — an honest "coarse route found
#: but a leg could not be followed" rather than a real route. The fix
#: for those routes is a denser topology (re-bake / portal-detection
#: work — `MIVNAV_ARTIFACT_TODO.md`), not more grace here.
_MIVNAV_COARSE_GRACE_M = 5_000.0

#: Metres, how far from a lateral mark the graph algorithm's own buoyage
#: zone reaches — this algorithm has no configurable weight/radius of its
#: own (its cost multipliers are fixed constants, matching RouteIQ's own
#: fixed-formula design — see `chartcore::routing::raster::graph`'s
#: module docs), so this is a fixed starting point rather than a
#: `RoutingConfig` field, the same order of magnitude ROUTING_TODO.md's
#: own "a starting point once validated" note already suggests for the
#: raster search's OWN (still off-by-default) buoyage preference.
_GRAPH_BUOYAGE_RADIUS_M = 100.0

#: Metres, the small, FIXED hard buffer `_plan_leg` (the raster
#: algorithm's own path, `RoutingConfig.algorithm == "raster"`) actually
#: buffers the hazard union by — `RoutingConfig.lateral_margin_m` no
#: longer is (#owqqcdqe, 2026-08-10, see that field's own docstring):
#: a route may still never touch charted danger or cross land (this
#: floor is never zero), but the user's own PREFERRED margin is now a
#: soft pull (`find_route`'s `lateral_margin_radius_m`) layered on top,
#: not baked into the geometry a narrow-but-safe passage could get
#: walled off by. Small enough to almost never make a real, narrow
#: channel impassable; not zero, so a route can't graze the charted
#: line itself (chart datum/GPS positional error, same reasoning as any
#: hydrographic safety margin). Not itself a `RoutingConfig` field —
#: same "implementation-scale internal constant, not a safety setting a
#: caller tunes" posture as `_MACRO_TRIGGER_NM`
#: (`mivnav.features.routing.hazards`) — `lateral_margin_m` is the
#: user-facing knob for "how much clearance", this is just "how close
#: is structurally too close to ever allow".
_HARD_LATERAL_FLOOR_M = 3.0


def _routeiq_access_client(runtime: Runtime) -> AccessRequestClient:
    """Build the RouteIQ access-request handshake client for the current
    config, or refuse — same shape as
    `mivnav.api.signalk._access_client`, since RouteIQ's own device
    access-request grant rides the exact same SignalK v1 handshake, just
    a separate client id/token (see `RouteIQCredentials`'s own docstring
    for why that's a separate grant rather than reusing the autopilot's).

    409 (not 502) when SignalK is disabled or has no host: the box is not
    unreachable, there is simply nothing configured to ask."""
    signalk = runtime.config.get().signalk
    if not signalk.enabled or not signalk.host:
        raise HTTPException(
            status_code=409,
            detail=(
                "SignalK is not configured on this server, so there is no "
                "RouteIQ instance to request access from. Enable and point "
                "the SignalK connection at the boat's box first."
            ),
        )
    return AccessRequestClient(ws_to_http_base(signalk.ws_url))


class LatLon(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class PlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    #: ``from`` is a Python keyword, hence the alias — the wire shape stays
    #: the natural ``{"from": ..., "to": ...}``.
    from_: LatLon = Field(alias="from")
    to: LatLon
    #: Metres. Omit to fall back to SignalK's own reported draft, and
    #: failing that, ``RoutingConfig.default_draft_m`` — see that field's
    #: docstring for why the fallback is conservative, not accurate.
    draft_m: float | None = Field(default=None, gt=0)
    #: Include ``PlanResponse.timings`` on the wire. The breakdown is
    #: BUILT and LOGGED either way (see ``hazards.Timings`` — the point is
    #: to watch a request work in ``just dev``'s own console), so this
    #: only controls whether it also comes back in the response; false by
    #: default so a normal caller's payload stays exactly as small as it
    #: was before this existed.
    debug: bool = False


class PlanResponse(BaseModel):
    #: Always at least ``[from, to]`` — never empty, so a caller can draw a
    #: line without a length check first.
    waypoints: list[LatLon]
    distance_nm: float
    warnings: list[str]
    #: One entry per leg (``len(waypoints) - 1``): `True` where that leg
    #: is a straight-line stand-in the exact per-leg re-verification could
    #: not confirm clear — draw it as a warning, not an ordinary route
    #: leg. Not only ``[0]``/``[-1]`` (the true start/destination
    #: unreachable) — a leg anywhere in the middle can be flagged too, if
    #: the grid resolution this corridor was searched at was too coarse
    #: to see a real, narrow hazard it crosses. See
    #: ``RoutePath.approximate_legs`` (chartcore) and the module
    #: docstring.
    approximate_legs: list[bool] = Field(default_factory=list)
    #: One entry per leg, same shape/order as ``approximate_legs``: `True`
    #: where that leg needs a human's own judgement — crosses charted
    #: ``UNSARE`` (unsurveyed area) water, OR crosses a ``BRIDGE`` this
    #: boat can't clear closed but that can mechanically open (this
    #: router has no way to confirm an opening is actually available).
    #: Never a reason this route was shaped or refused — both are soft
    #: preferences/informational flags now, not hard hazards (see
    #: ``chartcore::routing::hazards``' own module-doc notes on each).
    #: Empty (the default) for the ``routeiq``/``graph`` algorithms and
    #: the final no-water-found fallback, which don't compute it — a v1
    #: gap, not a promise every algorithm supports this yet. The
    #: ``artifact`` algorithm DOES fill it, but computes it inside the
    #: search rather than by re-checking the finished route, and carries
    #: one extra meaning there: a leg that used §9.3 endpoint grace
    #: (crossed unsurveyed or uncharted water within the grace radius of a
    #: requested endpoint) — see ``_plan_via_artifact``.
    check_manually_legs: list[bool] = Field(default_factory=list)
    #: Present only when ``PlanRequest.debug`` was set — one entry per
    #: step (``{"step": ..., "ms": ..., "detail": ...}``), in the order
    #: they ran. See ``hazards.Timings``.
    timings: list[dict] | None = None
    #: Present only when ``PlanRequest.debug`` was set — one entry per
    #: REAL search actually run (one for a plain leg, one per macro-
    #: stitched sub-leg — see ``hazards.leg_debug_info``), each
    #: ``{"bbox": [w, s, e, n], "hazard_rings": [[[lon, lat], ...], ...]}``.
    #: The debug layer's own core payload (#owqqcdqe, 2026-08-10): the
    #: exact box each search looked in and the exact hazard geometry it
    #: avoided, so a route that looks wrong can be checked against the
    #: real data instead of guessed at. Raw float-pair arrays, not this
    #: response's usual ``LatLon`` objects — see ``leg_debug_info``'s own
    #: docs for why (a real coastline ring can run to tens of thousands
    #: of points).
    #:
    #: The ``artifact`` algorithm contributes ONE entry, of the same
    #: shape plus an extra ``"artifact"`` key holding
    #: ``hazards.artifact_diagnostics`` (grid dimensions, the resolution
    #: ladder figures, the CATZOC horizontal buffer actually applied,
    #: blocked/unknown cell counts, search cost, endpoint snap
    #: distances). Its ``hazard_rings`` is always empty, and that is not
    #: a gap to fill: that algorithm's constraint geometry is built
    #: inside chartcore per query and never crosses back as rings — the
    #: diagnostics are what it exposes instead. The ``mivnav`` algorithm
    #: is the same shape again, with a ``"mivnav"`` key instead
    #: (``hazards.mivnav_diagnostics``) — everything ``artifact``'s own
    #: key carries, PLUS the precomputed-topology layer's own independent
    #: read on the same request (band, component/portal/shortcut counts,
    #: whether it found a path too, and the coarse corridor box when it
    #: did) — see ``RoutingConfig.algorithm``'s own docstring for what
    #: that layer does and does not do yet.
    debug_legs: list[dict] | None = None
    #: Present only when ``PlanRequest.debug`` was set AND a macro-scale
    #: detour was actually used (see ``_MACRO_ROUTE_WARNING``) — the RAW
    #: coarse, land-only guide ``find_macro_detour`` returned, as
    #: ``[lon, lat]`` pairs, BEFORE the real per-leg search refined
    #: anything: the macro pass's own waypoints are legitimate places for
    #: an odd bend to originate from (it knows nothing about depth or
    #: buoyage — see the module docstring's own macro-route section), so
    #: drawing them distinctly is what makes "is this bend the macro
    #: guide's fault or the fine search's" a visual question instead of a
    #: guess.
    debug_macro_waypoints: list[list[float]] | None = None


class VerifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: At least 2 — one leg minimum. `LatLon` objects, same wire shape as
    #: every other request on this router (chartcore's own `(lon, lat)`
    #: tuple convention stays internal).
    waypoints: list[LatLon] = Field(min_length=2)
    #: Same fallback chain as `PlanRequest.draft_m` — omit to use
    #: SignalK's own reported draft, then `RoutingConfig.default_draft_m`.
    draft_m: float | None = Field(default=None, gt=0)


class VerifyResponse(BaseModel):
    #: One entry per leg (`len(waypoints) - 1`), in the SAME order as
    #: `VerifyRequest.waypoints` — nothing here is ever dropped, added, or
    #: reordered (contrast `PlanResponse.waypoints`, which can differ from
    #: what was asked for). `True` where that EXACT leg crosses charted
    #: danger at this draft/margin: an exact geometry check
    #: (`chartcore.verify_route`), never a raster-resolution approximation
    #: the way `PlanResponse.approximate_legs` sometimes is — nothing here
    #: was ever searched or simplified, so `True` is a confirmed hazard
    #: crossing, not a hedge. See `_verify_reason`'s own docs.
    flagged_legs: list[bool]
    #: One entry per leg, same shape/order as `flagged_legs`: `True` where
    #: that EXACT leg needs a human's own judgement — crosses charted
    #: `UNSARE` (unsurveyed area) water, OR crosses a `BRIDGE` this boat
    #: can't clear closed but that can mechanically open. Purely
    #: informational — both are soft preferences now, not hard hazards
    #: (see `chartcore::routing::hazards`' own module-doc notes), so this
    #: never affects `safe` below. "Check this stretch manually", not a
    #: failure.
    check_manually_legs: list[bool]
    #: `True` iff no leg was flagged — the whole answer in one field for a
    #: caller that only wants a pass/fail.
    safe: bool
    #: One human reason per contiguous RUN of `True` in `flagged_legs`
    #: (`flagged_run_index_spans`) — see `_verify_reason`'s own docs for
    #: why this wording is deliberately NOT `PlanResponse`'s own
    #: `_unreachable_reason`/`_midroute_reason` text.
    reasons: list[str]
    #: Same standing caveat `/plan` always appends (`_NO_RULES_WARNING`)
    #: — traffic-lane crossing angle and buoyage side are never checked
    #: here either (this endpoint builds no TSS/fairway/buoyage index at
    #: all, only the hard hazard union).
    warnings: list[str]


def _draft_from_signalk(signalk: SignalKService) -> float | None:
    """The boat's own draft, if SignalK has a fix and a reported value —
    ``design.draft.current``/``design.draft.maximum`` collapsed to one
    ``draftM`` on the wire (``mivnav.signalk.model``). ``None`` on no fix,
    SignalK disabled, or no draft ever reported — a caller falls back to
    ``RoutingConfig.default_draft_m``, never treats this as "shallow
    enough"."""
    own = signalk.snapshot().get("self") or {}
    draft = own.get("draftM")
    return float(draft) if isinstance(draft, (int, float)) else None


def _unreachable_reason(
    label: str, p: Point, indexes: list, draft_m: float, cfg: RoutingConfig
) -> str:
    """One human reason `label` ("start point"/"destination") is
    approximate — this says WHY: either `p` is itself inside charted
    danger (the common real case — a harbour basin the safety-depth
    polygon swallows whole), or the search reached everywhere it could
    and `p` simply wasn't among it (the rarer "no real gap at all" case).
    `point_in_any_hazard` reads the SAME `indexes` chartcore's own
    exact-geometry check used, so the two never disagree."""
    if point_in_any_hazard(indexes, p):
        return (
            f"{label} {p.lat:.4f}, {p.lon:.4f} is itself inside charted danger "
            f"(draft {draft_m:.1f}m + {cfg.under_keel_margin_m:.1f}m keel margin, "
            f"{_HARD_LATERAL_FLOOR_M:.0f}m minimum clearance) — routed as close as "
            "possible, then a straight line for the rest"
        )
    return (
        f"no charted route reaches the {label} at {p.lat:.4f}, {p.lon:.4f} at this "
        "draft/margin — routed as close as possible, then a straight line for the rest"
    )


def _midroute_reason(start: Point, end: Point) -> str:
    """One human reason a STRETCH in the middle of an otherwise-real
    route is approximate — not `start`/`end` themselves sitting inside a
    hazard (see `_unreachable_reason` for that), but a leg the final
    exact per-leg re-check (chartcore's `verify_legs`) could not confirm
    clear at this corridor's own grid resolution. Found live: a real
    ~63nm request threaded a leg straight through a real headland the
    grid's own coarse row-sampling never saw — see the module docstring."""
    return (
        f"the stretch between {start.lat:.4f}, {start.lon:.4f} and {end.lat:.4f}, {end.lon:.4f} "
        "could not be exactly verified at this route's grid resolution — drawn as a straight "
        "line, check manually"
    )


def _approximate_warnings(route, indexes: list, draft_m: float, cfg: RoutingConfig) -> list[str]:
    """One warning per contiguous RUN of `True` in `route.approximate_legs`
    (`flagged_run_index_spans`) — the leading run (the true start
    unreachable), the trailing run (the true destination unreachable, or
    no real path exists at all), or a run somewhere in the MIDDLE,
    wherever exact per-leg re-verification flags a leg the grid's own
    rasterization missed. A run touching BOTH ends (the whole route is one
    straight-line stand-in) gets both a start and a destination reason:
    two different facts a caller may want to show separately."""
    n = len(route.approximate_legs)
    reasons: list[str] = []
    for i, j in flagged_run_index_spans(route.approximate_legs):
        lon0, lat0 = route.waypoints[i]
        lon1, lat1 = route.waypoints[j]
        start_pt = Point(lat0, lon0)
        end_pt = Point(lat1, lon1)
        if i == 0:
            reasons.append(_unreachable_reason("start point", start_pt, indexes, draft_m, cfg))
        if j == n:
            reasons.append(_unreachable_reason("destination", end_pt, indexes, draft_m, cfg))
        if i != 0 and j != n:
            reasons.append(_midroute_reason(start_pt, end_pt))
    return reasons


def _verify_reason(
    i: int,
    j: int,
    waypoints: list[tuple[float, float]],
    indexes: list,
    draft_m: float,
    cfg: RoutingConfig,
) -> str:
    """One human reason the run of user-drawn legs `[i, j)` is flagged for
    `/verify` — deliberately NOT `_unreachable_reason`/`_midroute_reason`'s
    own wording (`/plan`'s reasons). Both of those say things true only of
    a SEARCHED route — "...routed as close as possible, then a straight
    line for the rest", "...could not be exactly verified at this route's
    grid resolution" — and both are actively FALSE for `/verify`: nothing
    here was ever auto-routed, rasterized, or simplified, so a flagged run
    is a confirmed exact-geometry hazard crossing, not a hedge about a
    search's own limits. This is the resolution the design snag surfaced
    live: `flagged_run_index_spans` is the one piece of logic actually
    worth sharing with `_approximate_warnings` (both just walk runs of
    `True`); the TEXT itself has to differ because what a flagged run
    MEANS differs between the two endpoints.

    Checks each of the run's own two boundary waypoints for sitting
    INSIDE charted danger first (`point_in_any_hazard`, the same signal
    `_unreachable_reason` uses) — worth calling out specifically since it
    names exactly which waypoint to move, not just which stretch to
    re-examine. Falls back to a plain "this leg/these legs cross charted
    danger" otherwise."""
    lon0, lat0 = waypoints[i]
    lon1, lat1 = waypoints[j]
    start_pt = Point(lat0, lon0)
    end_pt = Point(lat1, lon1)
    margin = (
        f"draft {draft_m:.1f}m + {cfg.under_keel_margin_m:.1f}m keel margin, "
        f"{_HARD_LATERAL_FLOOR_M:.0f}m minimum clearance"
    )
    if point_in_any_hazard(indexes, start_pt):
        return f"waypoint {i} at {start_pt.lat:.4f}, {start_pt.lon:.4f} is itself inside charted danger ({margin})"
    if point_in_any_hazard(indexes, end_pt):
        return f"waypoint {j} at {end_pt.lat:.4f}, {end_pt.lon:.4f} is itself inside charted danger ({margin})"
    if j == i + 1:
        return (
            f"the leg from waypoint {i} to waypoint {j} ({start_pt.lat:.4f}, {start_pt.lon:.4f} to "
            f"{end_pt.lat:.4f}, {end_pt.lon:.4f}) crosses charted danger ({margin})"
        )
    return (
        f"waypoints {i} through {j} ({start_pt.lat:.4f}, {start_pt.lon:.4f} to "
        f"{end_pt.lat:.4f}, {end_pt.lon:.4f}) cross charted danger ({margin})"
    )


def _verify_reasons(
    waypoints: list[tuple[float, float]],
    flagged_legs: list[bool],
    indexes: list,
    draft_m: float,
    cfg: RoutingConfig,
) -> list[str]:
    """One `_verify_reason` per contiguous run of `True` in `flagged_legs`
    — the SAME run-walk `_approximate_warnings` uses (`flagged_run_index_
    spans`), paired with `/verify`'s own reason text instead of `/plan`'s.
    """
    return [_verify_reason(i, j, waypoints, indexes, draft_m, cfg) for i, j in flagged_run_index_spans(flagged_legs)]


def _plan_leg(
    ocharts: OchartsService,
    a: Point,
    b: Point,
    safety_depth_m: float,
    cfg: RoutingConfig,
    timings: Timings,
    collect_debug: bool = False,
) -> tuple["chartcore.RoutePath | None", list, dict | None]:
    """One real, safe, draft-aware leg — the exact indexing/preference
    wiring the top-level ``a``→``b`` search below uses, factored out so
    that search and ``_stitch_macro_route``'s own several (much shorter)
    legs share it exactly rather than drift into two independently
    maintained copies. Returns ``(route, indexes, debug)`` — ``indexes``
    is the real hazard union this leg was checked against, which a
    caller needs for ``_unreachable_reason``'s own messaging
    (``point_in_any_hazard``); ``debug`` is ``leg_debug_info``'s own
    dict when ``collect_debug`` (only ever true for a
    ``PlanRequest.debug`` caller — see that function's own docs for why
    this is gated, not unconditional like ``Timings``), else ``None``.

    The hazard union itself is buffered by ``_HARD_LATERAL_FLOOR_M``, a
    small FIXED floor — not ``cfg.lateral_margin_m`` (#owqqcdqe,
    2026-08-10, see that field's own docstring for why): the user's real
    preferred margin is passed to ``find_route`` as
    ``lateral_margin_radius_m`` instead, a soft pull layered on top of the
    search rather than baked into the geometry a narrow-but-safe passage
    could get walled off by. ``cfg.air_draft_m`` (0.0 = off, the default)
    is passed straight through to the hazard union itself — a
    ``BRIDGE``/``CBLOHD`` the boat cannot clear is a HARD block, exactly
    like a too-shallow ``DEPARE``, not a soft preference of its own."""
    indexes = hazard_indexes_for_line(
        ocharts, a, b, safety_depth_m, _HARD_LATERAL_FLOOR_M, timings, air_draft_m=cfg.air_draft_m
    )
    tss_indexes, fairway_indexes, cable_indexes, caution_indexes, survey_indexes = preference_indexes_for_line(
        ocharts,
        a,
        b,
        want_tss=cfg.tss_avoidance_weight > 0,
        want_fairway=cfg.fairway_preference_weight > 0,
        want_cable=cfg.cable_avoidance_weight > 0,
        want_caution=cfg.caution_area_avoidance_weight > 0,
        want_survey=cfg.low_confidence_survey_avoidance_weight > 0,
        timings=timings,
    )
    buoyage_indexes = buoyage_indexes_for_line(
        ocharts,
        a,
        b,
        want_buoyage=cfg.buoyage_avoidance_weight > 0,
        iala_region_default=cfg.iala_region,
        radius_m=cfg.buoyage_avoidance_radius_m,
        timings=timings,
    )
    route = find_route(
        a,
        b,
        indexes,
        timings,
        shallow_avoidance_radius_m=cfg.shallow_avoidance_radius_m,
        shallow_avoidance_weight=cfg.shallow_avoidance_weight,
        lateral_margin_radius_m=cfg.lateral_margin_m,
        tss_indexes=tss_indexes,
        tss_avoidance_weight=cfg.tss_avoidance_weight,
        fairway_indexes=fairway_indexes,
        fairway_preference_weight=cfg.fairway_preference_weight,
        buoyage_indexes=buoyage_indexes,
        buoyage_avoidance_weight=cfg.buoyage_avoidance_weight,
        cable_indexes=cable_indexes,
        cable_avoidance_weight=cfg.cable_avoidance_weight,
        caution_indexes=caution_indexes,
        caution_area_avoidance_weight=cfg.caution_area_avoidance_weight,
        survey_indexes=survey_indexes,
        low_confidence_survey_avoidance_weight=cfg.low_confidence_survey_avoidance_weight,
        turn_cost_weight=cfg.turn_cost_weight,
    )
    debug = leg_debug_info(a, b, indexes) if collect_debug else None
    return route, indexes, debug


#: Degrees pad `_bbox_around_chain` adds around a stitched chain's own
#: tight bounding box — purely a candidate-cell-edge/rounding safety
#: margin, not a search radius: a straight-line shortcut between two
#: points already IN the chain can never leave their own bbox (a bbox is
#: convex), so nothing wider than "the chain's own extent" is ever
#: actually needed for `hazard_indexes_for_bbox`'s own candidate
#: selection to see every ring `chartcore.resimplify_route`'s exact
#: `visible()` check could possibly cross.
_RESIMPLIFY_BBOX_PAD_DEG = 0.01


def _bbox_around_chain(waypoints: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    """`(w, s, e, n)` degrees tightly bounding every point in `waypoints`
    (``(lon, lat)`` pairs), padded by `_RESIMPLIFY_BBOX_PAD_DEG` — the
    candidate-selection box `_stitch_macro_route`'s own post-stitch
    resimplify pass needs (see that function's own docs for why a single,
    whole-chain bbox, not a per-sub-leg one, is the load-bearing part)."""
    lons = [lon for lon, _ in waypoints]
    lats = [lat for _, lat in waypoints]
    pad = _RESIMPLIFY_BBOX_PAD_DEG
    return (min(lons) - pad, min(lats) - pad, max(lons) + pad, max(lats) + pad)


def _stitch_macro_route(
    ocharts: OchartsService,
    macro_waypoints: list[tuple[float, float]],
    safety_depth_m: float,
    cfg: RoutingConfig,
    timings: Timings,
    collect_debug: bool = False,
) -> StitchedRoute | None:
    """Re-run ``_plan_leg`` — the real, depth-aware search — along each
    consecutive pair of ``macro_waypoints`` (``(lon, lat)``, a coarse
    land-only guide from ``find_macro_detour``) and concatenate into one
    ``StitchedRoute``. ``None`` when the FIRST leg fails outright
    (``chartcore.shortest_path`` found no water at all near that
    stretch) — a genuinely broken macro guide, not just a leg the
    ordinary per-leg search still had to flag (that case still returns a
    result; the flag rides through in ``approximate_legs`` and
    ``plan_route``'s own "did this actually help" comparison decides
    whether to use it).

    ``collect_debug`` threads straight through to every ``_plan_leg``
    call, collecting each sub-leg's own ``leg_debug_info`` into
    ``StitchedRoute.leg_debugs`` in order — asked for directly
    (#owqqcdqe, 2026-08-10): a macro-stitched route is exactly where
    "why did it put a point there" is hardest to answer by eye (each
    sub-leg searches its OWN small corridor, at its OWN resolution), so
    this is the case the debug layer matters most for, not an
    afterthought bolted onto the ordinary single-leg path.

    The concatenated chain is then run through ``chartcore.refine_route``
    ONCE — the real live-found bug this exists for (#owqqcdqe, 2026-08-10):
    each sub-leg is searched in complete isolation from its neighbours, so
    a shared macro waypoint that the coarse land-only guide happened to
    place somewhere awkward (found live: right at the shallow tip of a
    real headland — genuinely unsafe at the boat's own draft) leaves TWO
    independently-honest stub legs meeting at it, one from each
    neighbouring sub-leg, even though every INDIVIDUAL leg was itself
    exactly verified given what it alone could see. `chartcore.
    resimplify_route` alone — a pure geometric SHORTCUT pass — was the
    first fix tried and is not enough on its own: it can only DROP an
    existing waypoint when two OTHERS already see each other directly,
    never propose a genuinely NEW bend point, and the direct chord
    skipping the bad shared point is often blocked by the very same
    hazard from a different angle (measured live). `refine_route` is
    `resimplify_route`'s more capable sibling — same final cleanup pass,
    but it RE-SEARCHES every still-flagged run for a real detour first
    (`chartcore::routing::raster::refine_flagged_legs`, the same
    mechanism `chartcore.shortest_path` already applies internally
    across its own spliced-in refinements, now run once more across the
    STITCHED chain).

    The hazard set that pass runs against is a FRESH ``hazard_indexes_
    for_bbox`` call over the WHOLE stitched chain's own bbox — NOT each
    sub-leg's own ``indexes`` concatenated (#owqqcdqe, 2026-08-10, found
    live, a real bug an earlier version of this fix reintroduced): chart-
    authority clipping is only globally consistent within the bbox it
    actually ran over, and each sub-leg's own ``indexes`` was clipped
    against only the finer charts ITS OWN narrow bbox happened to select
    — a real, charted-open-water shortcut between two points from
    DIFFERENT sub-legs was measured wrongly blocked by a stale, only-
    locally-clipped coarse ring surviving in the naive union. See
    ``hazard_indexes_for_bbox``'s own docs for the full mechanism.
    `tss_indexes`/`fairway_indexes`/`buoyage_indexes`/`cable_indexes`/
    `caution_indexes`/`survey_indexes` don't share this concern
    (`preference_indexes_for_line`/`buoyage_indexes_for_line` never
    authority-clip at all), so those stay a plain per-leg concatenation,
    gated the same way `_plan_leg` itself gates them."""
    points = [Point(lat, lon) for lon, lat in macro_waypoints]
    waypoints: list[tuple[float, float]] = [macro_waypoints[0]]
    approximate_legs: list[bool] = []
    leg_debugs: list[dict] = []
    tss_indexes: list = []
    fairway_indexes: list = []
    buoyage_indexes: list = []
    cable_indexes: list = []
    caution_indexes: list = []
    survey_indexes: list = []
    distance_m = 0.0
    for a, b in zip(points, points[1:]):
        leg, _, debug = _plan_leg(ocharts, a, b, safety_depth_m, cfg, timings, collect_debug)
        if leg is None:
            return None
        # `leg.waypoints[0]` duplicates the running `waypoints[-1]` (both
        # are the same macro waypoint) — append everything after it.
        waypoints.extend(leg.waypoints[1:])
        approximate_legs.extend(leg.approximate_legs)
        distance_m += leg.distance_m
        if debug is not None:
            leg_debugs.append(debug)
        leg_tss, leg_fairway, leg_cable, leg_caution, leg_survey = preference_indexes_for_line(
            ocharts,
            a,
            b,
            want_tss=cfg.tss_avoidance_weight > 0,
            want_fairway=cfg.fairway_preference_weight > 0,
            want_cable=cfg.cable_avoidance_weight > 0,
            want_caution=cfg.caution_area_avoidance_weight > 0,
            want_survey=cfg.low_confidence_survey_avoidance_weight > 0,
        )
        tss_indexes.extend(leg_tss)
        fairway_indexes.extend(leg_fairway)
        cable_indexes.extend(leg_cable)
        caution_indexes.extend(leg_caution)
        survey_indexes.extend(leg_survey)
        buoyage_indexes.extend(
            buoyage_indexes_for_line(
                ocharts,
                a,
                b,
                want_buoyage=cfg.buoyage_avoidance_weight > 0,
                iala_region_default=cfg.iala_region,
                radius_m=cfg.buoyage_avoidance_radius_m,
            )
        )

    t0 = time.monotonic()
    bbox = _bbox_around_chain(waypoints)
    resimplify_indexes = hazard_indexes_for_bbox(
        ocharts, bbox, safety_depth_m, _HARD_LATERAL_FLOOR_M, timings, air_draft_m=cfg.air_draft_m
    )
    resimplified = chartcore.refine_route(
        waypoints,
        approximate_legs,
        resimplify_indexes,
        shallow_avoidance_radius_m=cfg.shallow_avoidance_radius_m,
        shallow_avoidance_weight=cfg.shallow_avoidance_weight,
        lateral_margin_radius_m=cfg.lateral_margin_m,
        tss_indexes=tss_indexes,
        tss_avoidance_weight=cfg.tss_avoidance_weight,
        fairway_indexes=fairway_indexes,
        fairway_preference_weight=cfg.fairway_preference_weight,
        buoyage_indexes=buoyage_indexes,
        buoyage_avoidance_weight=cfg.buoyage_avoidance_weight,
        cable_indexes=cable_indexes,
        cable_avoidance_weight=cfg.cable_avoidance_weight,
        caution_indexes=caution_indexes,
        caution_area_avoidance_weight=cfg.caution_area_avoidance_weight,
        survey_indexes=survey_indexes,
        low_confidence_survey_avoidance_weight=cfg.low_confidence_survey_avoidance_weight,
        turn_cost_weight=cfg.turn_cost_weight,
    )
    if timings is not None:
        timings.record(
            "resimplify_macro_stitch", t0, f"{len(waypoints)} -> {len(resimplified.waypoints)} waypoints"
        )
    # Unlike `resimplify_route` (`None` only when handed fewer than 2
    # points), `refine_route` always returns a real `RoutePath` for any
    # input this function can actually build (`waypoints` has at least the
    # 2 points of its own first leg) — no raw-concatenation fallback
    # branch needed.
    return StitchedRoute(
        waypoints=resimplified.waypoints,
        distance_m=resimplified.distance_m,
        approximate_legs=resimplified.approximate_legs,
        leg_debugs=leg_debugs,
    )


def _macro_route_improves(stitched: StitchedRoute, original) -> bool:
    """Should ``_stitch_macro_route``'s result REPLACE the ordinary
    route? Only when it is a genuine improvement — its worst remaining
    flagged run (``flagged_run_spans_nm``) is smaller than the original's
    — so a macro guide that turned out wrong (or merely different, not
    better: e.g. the ordinary search's own per-leg refinement already got
    close) never silently replaces an honest, already-as-good-as-it-gets
    result."""
    stitched_worst = max(flagged_run_spans_nm(stitched), default=0.0)
    original_worst = max(flagged_run_spans_nm(original), default=0.0)
    return stitched_worst < original_worst


# -- obtaining the RouteIQ access token -------------------------------------
#
# Same handshake, same reasoning, as the autopilot's write token
# (mivnav.api.signalk) — see this module's own imports and
# mivnav.signalk.access's module docstring for the SignalK v1 flow itself.
# A separate client id/token from the autopilot's (RouteIQCredentials, not
# SignalKCredentials): see that class's own docstring for why.


@router.post("/routeiq/access-request")
def start_routeiq_access_request(runtime: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Ask the SignalK server for RouteIQ access. Returns
    ``{"state": "PENDING", "requestId": <id>}``; the frontend polls
    :func:`poll_routeiq_access_request` with that id while a human
    approves the request in the SignalK admin (Security → Access
    Requests, listed as "mivnav routing" — see
    ``mivnav.features.routing.routeiq``'s import of ``AccessRequestClient``
    default description, overridden below to tell it apart from the
    autopilot's own "mivnav" request)."""
    client = _routeiq_access_client(runtime)
    client_id = runtime.ensure_routeiq_client_id()
    try:
        # admin, not readwrite: signalk-routeiq registers its router without
        # SignalK's per-route `.access(level)`, and signalk-server gates any
        # such /plugins/<id>/* route at ADMIN (pluginAuthenticationMiddleware).
        result = client.request_access(
            client_id, description="mivnav routing", permissions=ADMIN
        )
    except SignalKUnavailable as e:  # pragma: no cover - _routeiq_access_client vetoes first
        raise HTTPException(status_code=409, detail=str(e)) from e
    except SignalKUnreachable as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"state": result["state"], "requestId": result["requestId"]}


@router.get("/routeiq/access-request/{request_id}")
def poll_routeiq_access_request(
    request_id: str, runtime: Runtime = Depends(get_runtime)
) -> dict[str, Any]:
    """Poll a pending RouteIQ access request; on approval, store the
    granted token in ``credentials.routeiq.token`` — same shape as
    ``mivnav.api.signalk.poll_access_request``, see its own docstring for
    the approved/denied/still-pending contract."""
    client = _routeiq_access_client(runtime)
    try:
        result = client.poll(request_id)
    except SignalKUnavailable as e:  # pragma: no cover - _routeiq_access_client vetoes first
        raise HTTPException(status_code=409, detail=str(e)) from e
    except SignalKUnreachable as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if result["state"] != "COMPLETED":
        return {"state": "PENDING"}
    if not result["approved"]:
        return {"state": "COMPLETED", "approved": False}
    runtime.patch_config({"credentials": {"routeiq": {"token": result["token"]}}})
    return {"state": "COMPLETED", "approved": True}


def _plan_via_routeiq(
    runtime: Runtime, a: Point, b: Point, draft_m: float, cfg: RoutingConfig
) -> "PlanResponse":
    """`RoutingConfig.algorithm == "routeiq"`'s whole path: call the
    remote plugin, map its result (or its absence) onto the exact same
    `PlanResponse` shape the raster algorithm returns, so neither the
    frontend nor `plan_route`'s own caller needs to know which engine
    answered.

    Every failure mode still returns 200 with a straight line and a clear
    reason — the same "never a bare error, never a silent gap" contract
    the raster path keeps (see the module docstring) — except
    `RouteIQUnavailable`/`RouteIQUnreachable`, which mean the request
    itself could not even be tried and are surfaced as real HTTP errors
    (409/502), matching the access-request endpoints' own convention
    above rather than pretending a straight line is a real fallback for
    "the connection is broken"."""
    signalk_cfg = runtime.config.get().signalk
    base_url = ws_to_http_base(signalk_cfg.ws_url) if signalk_cfg.enabled and signalk_cfg.host else None
    token = runtime.config.get().credentials.routeiq.token.get_secret_value()
    client = RouteIQClient(base_url, token)
    try:
        route: RouteIQRoute = client.plan_route(
            a.lat,
            a.lon,
            b.lat,
            b.lon,
            draft_m=draft_m,
            beam_m=cfg.routeiq_beam_m,
            air_draft_m=cfg.routeiq_air_draft_m,
            min_coast_distance_nm=cfg.routeiq_min_coast_distance_nm,
        )
    except RouteIQNotFound as e:
        return PlanResponse(
            waypoints=[LatLon(lat=a.lat, lon=a.lon), LatLon(lat=b.lat, lon=b.lon)],
            distance_nm=haversine_m(a, b) / _METRES_PER_NM,
            warnings=[str(e), _ROUTEIQ_WARNING],
            approximate_legs=[True],
        )
    except (RouteIQUnavailable, RouteIQUnreachable) as e:
        status = 409 if isinstance(e, RouteIQUnavailable) else 502
        raise HTTPException(status_code=status, detail=str(e)) from e
    warnings = [*route.warnings, _ROUTEIQ_WARNING]
    return PlanResponse(
        waypoints=[LatLon(lat=lat, lon=lon) for lon, lat in route.waypoints],
        distance_nm=route.distance_m / _METRES_PER_NM,
        warnings=warnings,
        approximate_legs=route.approximate_legs,
    )


def _plan_via_graph(
    ocharts: OchartsService, a: Point, b: Point, draft_m: float, cfg: RoutingConfig, timings: Timings
) -> "PlanResponse":
    """`RoutingConfig.algorithm == "graph"`'s whole path: the SAME
    candidate-cell-selected hazard/fairway/TSS/buoyage indexes
    `_plan_leg`'s raster search uses (apples-to-apples — only the search
    algorithm differs), fed into `find_graph_route`
    (`chartcore::routing::raster::graph`) instead. Maps its result (or
    its absence) onto the exact same `PlanResponse` shape every other
    algorithm returns.

    No macro-route fallback here (the graph search has no analogue of
    `needs_macro_route`'s "badly unreachable" signal — it either finds a
    path or it doesn't) and no partial/approximate result either: `None`
    from `find_graph_route` falls straight back to the honest straight
    line, same as the genuinely-pathological `chartcore.shortest_path
    is None` case at the very bottom of `plan_route`.

    Deliberately UNLIKE `_plan_leg`: `lateral_margin_m` stays a hard
    buffer here, baked straight into the hazard union's own `margin_m`
    (and separately into the beam-clearance check below) rather than the
    soft preference #owqqcdqe made it for the primary raster search — the
    graph algorithm has no soft-preference cost model of its own to layer
    it onto (`chartcore::routing::raster::graph`'s own module docs — a
    flat zone-membership cost, not a distance-graded one) and no partial-
    route fallback either, so there is nothing to preserve safety with if
    this floor were lowered. `RoutingConfig.algorithm` defaults to
    `"raster"` — this experimental second algorithm keeping the old,
    stricter behaviour is a real, documented gap, not an oversight."""
    safety_depth_m = draft_m + cfg.under_keel_margin_m
    indexes = hazard_indexes_for_line(
        ocharts, a, b, safety_depth_m, cfg.lateral_margin_m, timings, air_draft_m=cfg.air_draft_m
    )
    # `find_graph_route` (`chartcore.graph_route`) has no cable/caution/
    # low-confidence-survey concept of its own (unlike the raster search's
    # `CostModel`) — see `ROUTING_TODO.md`'s own scoping note for this
    # algorithm; the three extra returns are simply unused here.
    tss_indexes, fairway_indexes, _cable_indexes, _caution_indexes, _survey_indexes = preference_indexes_for_line(
        ocharts, a, b, want_tss=True, want_fairway=True, timings=timings
    )
    buoyage_indexes = buoyage_indexes_for_line(
        ocharts,
        a,
        b,
        want_buoyage=True,
        iala_region_default=cfg.iala_region,
        radius_m=_GRAPH_BUOYAGE_RADIUS_M,
        timings=timings,
    )
    min_clearance_m = cfg.routeiq_beam_m / 2.0 + cfg.lateral_margin_m
    route = find_graph_route(
        a,
        b,
        indexes,
        fairway_indexes=fairway_indexes,
        tss_indexes=tss_indexes,
        buoyage_indexes=buoyage_indexes,
        min_clearance_m=min_clearance_m,
        timings=timings,
    )
    if route is None:
        return PlanResponse(
            waypoints=[LatLon(lat=a.lat, lon=a.lon), LatLon(lat=b.lat, lon=b.lon)],
            distance_nm=haversine_m(a, b) / _METRES_PER_NM,
            warnings=[
                "the adaptive-graph algorithm found no path for this request "
                "(an unsafe endpoint, or nothing connects within its own "
                "search budget) — routed as a straight line instead",
                _GRAPH_WARNING,
            ],
            approximate_legs=[True],
        )
    n = max(len(route.waypoints) - 1, 0)
    return PlanResponse(
        waypoints=[LatLon(lat=lat, lon=lon) for lon, lat in route.waypoints],
        distance_nm=route.distance_m / _METRES_PER_NM,
        warnings=[_GRAPH_WARNING],
        approximate_legs=[False] * n,
    )


def _artifact_approximate_reason(start: Point, end: Point) -> str:
    """One human reason a run of `"artifact"` legs came back flagged in
    `approximate_legs` — deliberately NOT `_unreachable_reason`/
    `_midroute_reason`'s wording, for the same reason `_verify_reason`
    isn't either: both of those say "routed as close as possible, then a
    straight line for the rest", which is a claim about the RASTER
    search's own partial-route fallback. This algorithm has no such
    fallback at all (`chartcore.artifact_route` returns nothing rather
    than part of something), so a flagged leg here means only what
    `ArtifactRoute.approximate_legs` actually means: the exact verifier —
    the same `chartcore.verify_route` geometry check `/verify` uses —
    could not confirm that leg clear of the hard-constraint union at the
    resolution this corridor was searched at."""
    return (
        f"the stretch between {start.lat:.4f}, {start.lon:.4f} and {end.lat:.4f}, {end.lon:.4f} "
        "could not be exactly verified against the charted hazards — check it manually before "
        "following"
    )


def _artifact_snap_reason(label: str, requested: Point, used: Point, snap_m: float) -> str:
    """One human reason an `"artifact"` route does not actually start (or
    end) where it was asked to. Two different causes produce this, and
    the text covers both without guessing between them: v3 §13.1's
    canonical endpoint snapping (every endpoint moves to its grid cell's
    own centre, so two clicks a few cm apart give the same route), and
    §9.3's endpoint grace moving a start/destination that sits inside a
    blocking feature to the nearest navigable point within the grace
    radius. Only emitted when the move is bigger than the grid's own cell
    size — see `_plan_via_artifact` for why that threshold, and why a
    silent sub-cell move is not worth a warning."""
    return (
        f"the {label} was moved {snap_m:.0f}m, from {requested.lat:.4f}, {requested.lon:.4f} to "
        f"{used.lat:.4f}, {used.lon:.4f} — the requested point is not itself navigable at this "
        "draft/margin, or falls outside the searched grid"
    )


def _plan_via_artifact(
    ocharts: OchartsService,
    a: Point,
    b: Point,
    draft_m: float,
    cfg: RoutingConfig,
    timings: Timings,
    collect_debug: bool = False,
) -> "PlanResponse":
    """`RoutingConfig.algorithm == "artifact"`'s whole path: the same
    corridor and the same candidate cells every other local algorithm
    selects (`cells_for_line` — `chartcore.routing_corridor_bbox` and the
    same decode LRU), handed to `chartcore.artifact_route`
    (`chartcore::routing::artifact`) as DECODED CELLS rather than as a
    prebuilt hazard union, because this algorithm derives its own, wider
    hard-constraint set (see `find_artifact_route`'s docs). Maps the
    result — or its absence — onto the exact same `PlanResponse` shape
    every other algorithm returns.

    Config mapping, all from the SHARED `RoutingConfig` fields except the
    three `artifact_*` ones:

    * `required_depth_m` is `draft_m + cfg.under_keel_margin_m`, combined
      here exactly as `_plan_leg`'s own `safety_depth_m` is.
    * `cfg.air_draft_m` (`0.0` = off) is the overhead check, same opt-in
      gating as the raster search.
    * `cfg.lateral_margin_m` is a HARD buffer here, like `_plan_via_graph`
      and unlike `_plan_leg`'s soft pull (#owqqcdqe made it soft for the
      raster search alone) — this algorithm has no distance-graded cost
      model to layer a preference onto, and no partial-route fallback to
      preserve safety with if the floor were lowered.
    * The five shared soft weights it accepts ride through unchanged.
      `shallow_avoidance_*`, `buoyage_*`, `iala_region` and
      `routeiq_beam_m` are NOT passed — `chartcore.artifact_route` accepts
      none of them (they need directional/topology machinery this MVP
      left out). A caller's values for those are inapplicable here, not
      silently dropped further down.

    No macro-route fallback (same reasoning as `_plan_via_graph`: there is
    no "badly unreachable" partial result to detect one from) and no
    partial route either — `None` falls back to the honest straight line
    with a reason, exactly as the graph path does."""
    required_depth_m = draft_m + cfg.under_keel_margin_m
    cells = cells_for_line(ocharts, a, b, timings)
    route = find_artifact_route(
        a,
        b,
        cells,
        required_depth_m=required_depth_m,
        required_air_draft_m=cfg.air_draft_m,
        lateral_margin_m=cfg.lateral_margin_m,
        endpoint_grace_radius_m=cfg.artifact_endpoint_grace_radius_m,
        catzoc_allowance_mode=cfg.artifact_catzoc_allowance_mode,
        allow_restricted_entry=cfg.artifact_allow_restricted_entry,
        tss_avoidance_weight=cfg.tss_avoidance_weight,
        fairway_preference_weight=cfg.fairway_preference_weight,
        cable_avoidance_weight=cfg.cable_avoidance_weight,
        caution_area_avoidance_weight=cfg.caution_area_avoidance_weight,
        low_confidence_survey_avoidance_weight=cfg.low_confidence_survey_avoidance_weight,
        turn_cost_weight=cfg.turn_cost_weight,
        avoid_depth_below_m=cfg.avoid_depth_below_m,
        avoid_depth_weight=cfg.avoid_depth_weight,
        soft_prefer_depth_below_m=cfg.soft_prefer_depth_below_m,
        soft_prefer_depth_weight=cfg.soft_prefer_depth_weight,
        timings=timings,
    )
    if route is None:
        return PlanResponse(
            waypoints=[LatLon(lat=a.lat, lon=a.lon), LatLon(lat=b.lat, lon=b.lon)],
            distance_nm=haversine_m(a, b) / _METRES_PER_NM,
            warnings=[
                "the v3 artifact algorithm found no path for this request — an "
                "endpoint in unsurveyed or uncharted water beyond its grace "
                "radius, an endpoint inside charted danger, or nothing "
                f"navigable connecting them (CATZOC allowance "
                f"'{cfg.artifact_catzoc_allowance_mode}'; the 'full' default "
                "buffers every hazard by a kilometre on a chart carrying no "
                "M_QUAL survey-quality zones at all) — routed as a straight "
                "line instead",
                _ARTIFACT_WARNING,
            ],
            approximate_legs=[True],
        )

    waypoints = [LatLon(lat=lat, lon=lon) for lon, lat in route.waypoints]

    warnings: list[str] = []
    # Both ends ALWAYS move, by up to half a grid diagonal, because of v3
    # §13.1's canonical cell-centre snapping — warning about that would be
    # noise on every single route. A move larger than one whole cell
    # cannot be snapping alone (half a diagonal is 0.71 cells), so it is
    # real: the endpoint was blocked and §9.3 grace relocated it, which a
    # helmsman genuinely needs told.
    for label, requested, (lon, lat), snap_m in (
        ("start point", a, route.waypoints[0], route.start_snap_m),
        ("destination", b, route.waypoints[-1], route.end_snap_m),
    ):
        if snap_m > route.cell_size_m:
            warnings.append(_artifact_snap_reason(label, requested, Point(lat, lon), snap_m))
    for i, j in flagged_run_index_spans(route.approximate_legs):
        lon0, lat0 = route.waypoints[i]
        lon1, lat1 = route.waypoints[j]
        warnings.append(_artifact_approximate_reason(Point(lat0, lon0), Point(lat1, lon1)))
    warnings.append(_ARTIFACT_WARNING)

    # `check_manually_legs` comes STRAIGHT from the algorithm, unlike
    # every other path here (which re-derives it from a separate
    # `check_manually_indexes_for_bbox` scan over the finished route): the
    # §9.3 grace flag is knowledge only the search itself has — which legs
    # actually used the allowance — and cannot be recovered from the
    # waypoints afterwards. Same meaning on the wire either way (see
    # `PlanResponse.check_manually_legs`): UNSARE/uncharted water crossed,
    # or an openable bridge this boat cannot clear closed.
    return PlanResponse(
        waypoints=waypoints,
        distance_nm=route.distance_m / _METRES_PER_NM,
        warnings=warnings,
        approximate_legs=route.approximate_legs,
        check_manually_legs=route.check_manually_legs,
        debug_legs=(
            [{**leg_debug_info(a, b, []), "artifact": artifact_diagnostics(route)}]
            if collect_debug
            else None
        ),
    )


def _mivnav_artifact_for_request(
    ocharts: OchartsService,
    a: Point,
    b: Point,
    data_root: Path,
    cfg: RoutingConfig,
) -> tuple[Path | None, str | None, int, str | None]:
    """Which persisted `.mivnav` (if any) this request's topology layer
    may read: `(path, chart_set_id, sequence, reason_not_to)`.

    A `.mivnav` is built PER CHART SET, so it is usable for a request
    only when every candidate cell the fine search will see comes from
    ONE installed set — otherwise the artifact's region is missing charts
    the fine search can read, and the topology cross-check would be
    comparing two different worlds. That case returns `(None, None, 0,
    reason)` and the caller rebuilds, exactly as before persistence
    existed.

    Deliberately does NOT check the file's own staleness here — that is
    `chartcore.mivnav_route`'s job (`ArtifactReader::staleness`, §19, one
    open instead of two) and its answer is the one that reaches the wire.
    This only answers the question chartcore cannot: which chart set is
    this request even about."""
    sets = candidate_chart_sets_for_line(ocharts, a, b)
    if not sets:
        return None, None, 0, "no installed chart set covers this route's corridor"
    if len(sets) > 1:
        named = ", ".join(f"{set_id} ({n} cells)" for set_id, _, n in sets)
        return (
            None,
            None,
            0,
            f"this route's corridor spans {len(sets)} chart sets ({named}); a .mivnav "
            "artifact covers one chart set, so the topology layer rebuilt the region "
            "from this request's own cells instead",
        )
    set_id, sequence, _ = sets[0]
    try:
        path = mivnav_artifact_path(data_root, set_id, cfg.artifact_catzoc_allowance_mode)
    except UnusableChartSetId as e:
        # Cannot happen through the o-charts store (it skips such
        # directories outright) — reported rather than raised because
        # nothing about a route request should fail on it.
        return None, None, 0, str(e)
    return path, set_id, sequence, None


def _mivnav_stale_artifact_reason(path: Path, route) -> str | None:
    """The warning text for the one genuinely dangerous fallback: an
    artifact for this chart set EXISTS on disk and was not used.

    A missing artifact needs no warning — it is the documented default
    state of a boat that has never run a build, and `_MIVNAV_WARNING`
    already says the topology layer is a cross-check. An artifact that is
    THERE and silently ignored is the other thing entirely, and it is
    exactly CLAUDE.md's `#TSSLPT-OVERSCALE` shape: someone ran a build,
    the build reported success, and every subsequent route quietly
    ignored its output because the charts moved underneath it. The only
    way that becomes visible is if something says so, so this does — with
    §19's own named component (schema/derivation/authority/band-ladder/
    resolution-policy, or the sequence/chart-set mismatch), never a bare
    "stale"."""
    if route.topology_source == TOPOLOGY_SOURCE_ARTIFACT:
        return None
    try:
        if not path.exists():
            return None
    except OSError:
        return None
    return (
        f"a precomputed .mivnav artifact exists for this chart set but was not used: "
        f"{route.topology_fallback_reason or 'unknown reason'} — the route itself is "
        "unaffected (the fine search decides it either way), but rebuild the artifact "
        "(POST /routing/mivnav/build) to get the precomputed topology back"
    )


def _mivnav_straight_line(
    a: Point, b: Point, warnings: list[str], debug_legs: list[dict] | None = None
) -> "PlanResponse":
    """The one straight-line-with-a-warning shape every `_plan_via_mivnav`
    dead end returns — no path, no usable artifact, coarse guide the fine
    search could not follow. Always one approximate leg. `debug_legs`
    (only when the request asked for debug) carries per-failed-leg
    `find_artifact_route_debug` payloads for the route-test overlay."""
    return PlanResponse(
        waypoints=[LatLon(lat=a.lat, lon=a.lon), LatLon(lat=b.lat, lon=b.lon)],
        distance_nm=haversine_m(a, b) / _METRES_PER_NM,
        warnings=warnings,
        approximate_legs=[True],
        debug_legs=debug_legs or None,
    )


def _stitch_mivnav_coarse_route(
    ocharts: OchartsService,
    coarse_waypoints: list[tuple[float, float]],
    required_depth_m: float,
    cfg: RoutingConfig,
    timings: Timings,
    collect_debug: bool = False,
) -> tuple[StitchedRoute | None, list[dict]]:
    """Re-run `find_artifact_route` — the same draft-aware fine search
    `algorithm == "mivnav"` routes with — along each consecutive pair of
    `coarse_waypoints` (`(lon, lat)`, the portal-graph guide from
    `find_mivnav_coarse_route`) and concatenate into one `StitchedRoute`.
    Each leg gets its OWN small `cells_for_line` slice, so the
    region-global-scalar problem that closed one-big-corridor scoping
    (`chartcore::mivnav::query`'s docs) never bites — every leg genuinely
    is a short local route.

    Returns `(route, debug_legs)`. `route` is `None` when it cannot be
    assembled: the FIRST leg finds no water at all (a broken guide), or a
    leg still fails after the single recovery below. `debug_legs` is empty
    unless `collect_debug`; when set, each leg that FAILED the fine search
    contributes one `find_artifact_route_debug` entry (which of the
    search's failure points fired, the constraint rings, the search
    grid) — that is the payload the route-test debug overlay draws.

    Recovery: a portal crossing can land in water the fine search's
    stricter hard-constraint class calls blocked. The FIRST time an
    interior leg fails, that one coarse point is dropped and the leg
    re-aimed at the next point. A SECOND failure fails the stitch — no
    unbounded skipping, which would just collapse the detour back toward
    a near-straight `first -> last` attempt the fine search already
    rejected. The real destination is never skipped.

    Unlike `_stitch_macro_route` this does NOT then run
    `chartcore.refine_route` over the chain: that is a `routing::raster`
    cleanup pass, and every leg here is already `routing::artifact`
    exact-verified end to end; a raster shortcut across a portal seam
    could cut a corner the artifact fine search deliberately kept. A
    corridor-aware cleanup for this path is a documented follow-on
    (`MIVNAV_ARTIFACT_TODO.md`). The one seam it does not verify is where
    two consecutive legs' own endpoint snaps of the SAME coarse point
    differ (both are navigable portal-crossing water, a cell or two
    apart); the running polyline keeps the earlier leg's snapped point,
    and `_MIVNAV_COARSE_WARNING`'s "verify manually" covers it."""
    pts = [Point(lat, lon) for lon, lat in coarse_waypoints]
    debug_legs: list[dict] = []
    if len(pts) < 2:
        return None, debug_legs

    leg_kwargs = dict(
        required_depth_m=required_depth_m,
        required_air_draft_m=cfg.air_draft_m,
        lateral_margin_m=cfg.lateral_margin_m,
        endpoint_grace_radius_m=cfg.artifact_endpoint_grace_radius_m,
        catzoc_allowance_mode=cfg.artifact_catzoc_allowance_mode,
        allow_restricted_entry=cfg.artifact_allow_restricted_entry,
        tss_avoidance_weight=cfg.tss_avoidance_weight,
        fairway_preference_weight=cfg.fairway_preference_weight,
        cable_avoidance_weight=cfg.cable_avoidance_weight,
        caution_area_avoidance_weight=cfg.caution_area_avoidance_weight,
        low_confidence_survey_avoidance_weight=cfg.low_confidence_survey_avoidance_weight,
        turn_cost_weight=cfg.turn_cost_weight,
        avoid_depth_below_m=cfg.avoid_depth_below_m,
        avoid_depth_weight=cfg.avoid_depth_weight,
        soft_prefer_depth_below_m=cfg.soft_prefer_depth_below_m,
        soft_prefer_depth_weight=cfg.soft_prefer_depth_weight,
        timings=timings,
    )

    waypoints: list[tuple[float, float]] = []
    approximate_legs: list[bool] = []
    check_manually_legs: list[bool] = []
    distance_m = 0.0
    first_leg = None
    last_leg = None
    start = pts[0]
    i = 1
    skipped = False
    while i < len(pts):
        target = pts[i]
        leg_cells = cells_for_line(ocharts, start, target, timings)
        leg = find_artifact_route(start, target, leg_cells, **leg_kwargs)
        if leg is None:
            if collect_debug:
                # Profile the exact search that just failed — this leg is
                # the one the straight-line warning is about.
                debug_kwargs = {
                    k: v for k, v in leg_kwargs.items() if k != "timings"
                }
                debug_legs.append(
                    find_artifact_route_debug(
                        start, target, leg_cells, timings=timings, **debug_kwargs
                    )
                )
            # One recovery only: drop this interior coarse point and aim
            # at the next one. Never the real destination, never twice.
            if i < len(pts) - 1 and not skipped:
                skipped = True
                i += 1
                continue
            return None, debug_legs
        if not waypoints:
            # Seed from the SNAPPED start, not the raw requested point —
            # the segment the fine search actually verified.
            waypoints.extend(leg.waypoints)
            first_leg = leg
        else:
            # `leg.waypoints[0]` is this leg's own snapped copy of the
            # shared coarse point; the running tail already holds the
            # previous leg's snapped copy of it — append past it.
            waypoints.extend(leg.waypoints[1:])
        approximate_legs.extend(leg.approximate_legs)
        check_manually_legs.extend(leg.check_manually_legs)
        distance_m += leg.distance_m
        last_leg = leg
        start = target
        i += 1

    if first_leg is None or last_leg is None:
        return None, debug_legs

    endpoint_warnings: list[str] = []
    if first_leg.start_snap_m > first_leg.cell_size_m:
        lon0, lat0 = first_leg.waypoints[0]
        endpoint_warnings.append(
            _artifact_snap_reason("start point", pts[0], Point(lat0, lon0), first_leg.start_snap_m)
        )
    if last_leg.end_snap_m > last_leg.cell_size_m:
        lon1, lat1 = last_leg.waypoints[-1]
        endpoint_warnings.append(
            _artifact_snap_reason("destination", pts[-1], Point(lat1, lon1), last_leg.end_snap_m)
        )

    return (
        StitchedRoute(
            waypoints=waypoints,
            distance_m=distance_m,
            approximate_legs=approximate_legs,
            check_manually_legs=check_manually_legs,
            endpoint_warnings=endpoint_warnings,
            leg_debugs=[],
        ),
        debug_legs,
    )


def _dominant_built_mivnav_artifact(
    ocharts: OchartsService,
    a: Point,
    b: Point,
    data_root: Path,
    cfg: RoutingConfig,
) -> tuple[Path, str, int] | None:
    """`(path, set_id, sequence)` for the installed chart set that
    contributes the MOST candidate cells to this corridor AND has a
    `.mivnav` built on disk — or `None` if none does.

    For the COARSE fallback only. `_mivnav_artifact_for_request` refuses
    to pass an artifact whenever the corridor bbox touches more than one
    installed set, which is right for the primary path (the topology
    cross-check would be over a region missing charts the fine search
    sees). But a fat straight-line bbox for a route between two points
    ONE set fully covers routinely clips a neighbouring set's border
    cells (measured live: Copenhagen→Esbjerg picks up 23 `fnc-de` cells
    alongside 239 `oeuSENC-DK` ones). The coarse guide only needs the
    topology of the set the route actually runs through; the per-leg
    fine searches still see every set's cells via their own
    `cells_for_line`. So here we take the dominant set that has an
    artifact. A genuinely trans-boundary route — neither set covering
    both endpoints — still degrades honestly: `mivnav_coarse_route` can
    only snap an endpoint inside the artifact's own region, so an
    endpoint in the other set yields `None` (disconnected) and a
    straight line."""
    for set_id, sequence, _n in candidate_chart_sets_for_line(ocharts, a, b):
        try:
            path = mivnav_artifact_path(data_root, set_id, cfg.artifact_catzoc_allowance_mode)
        except UnusableChartSetId:
            continue
        try:
            if path.exists():
                return path, set_id, sequence
        except OSError:
            continue
    return None


def _plan_via_mivnav_coarse(
    ocharts: OchartsService,
    a: Point,
    b: Point,
    required_depth_m: float,
    cfg: RoutingConfig,
    data_root: Path,
    request_artifact: tuple[Path | None, str | None, int, str | None],
    timings: Timings,
    collect_debug: bool,
) -> "PlanResponse":
    """`_plan_via_mivnav`'s fallback when the ordinary fine search
    returned `None`: use the persisted portal graph to route AROUND
    whatever blocks the straight corridor, then fine-search leg by leg
    along it. Still no cross-*algorithm* fallback — this is the `"mivnav"`
    engine using its own `.mivnav`.

    `mivnav_require_artifact` needs no check here: a coarse-stitched
    response used the persisted `.mivnav` for its structure by
    construction (`find_mivnav_coarse_route` only succeeds with a usable
    file), and the per-leg `find_artifact_route` calls never rebuild a
    topology."""
    artifact_path, chart_set_id, chart_set_sequence, artifact_note = request_artifact

    if artifact_path is None or chart_set_id is None:
        # The primary path refused an artifact (usually: the corridor
        # bbox clips a second installed set). The coarse guide only needs
        # the dominant set's topology — try that one if it is built.
        dominant = _dominant_built_mivnav_artifact(ocharts, a, b, data_root, cfg)
        if dominant is None:
            return _mivnav_straight_line(
                a,
                b,
                [
                    "the mivnav fine search found no direct route, and no chart set with a "
                    f"built .mivnav covers this route ({artifact_note or 'no artifact'}) — "
                    "routed as a straight line instead. Build one for the chart set this "
                    "route runs through (POST /routing/mivnav/build).",
                    _MIVNAV_WARNING,
                ],
            )
        artifact_path, chart_set_id, chart_set_sequence = dominant
        timings.record(
            "mivnav_coarse_artifact",
            time.monotonic(),
            f"corridor spans >1 set; coarse guide uses dominant built set {chart_set_id}",
        )

    try:
        coarse = find_mivnav_coarse_route(
            a,
            b,
            artifact_path=artifact_path,
            chart_set_id=chart_set_id,
            chart_set_sequence=chart_set_sequence,
            required_depth_m=required_depth_m,
            endpoint_grace_radius_m=_MIVNAV_COARSE_GRACE_M,
            tss_avoidance_weight=cfg.tss_avoidance_weight,
            fairway_preference_weight=cfg.fairway_preference_weight,
            mivnav_directional_rules=cfg.mivnav_directional_rules,
            timings=timings,
        )
    except ValueError as exc:
        # A precomputed .mivnav for this chart set exists but is missing /
        # unreadable / §19-stale — distinct from "graph disconnected".
        return _mivnav_straight_line(
            a,
            b,
            [
                "the mivnav fine search found no direct route and the precomputed .mivnav "
                f"for this chart set could not be used ({exc}) — routed as a straight line "
                "instead. Rebuild it (POST /routing/mivnav/build).",
                _MIVNAV_WARNING,
            ],
        )
    if coarse is None or len(coarse.waypoints) <= 2:
        # `<= 2` means the portal graph connected the two points with no
        # interior hop — the same `[from, to]` the fine search already
        # rejected, so there is nothing new to stitch along.
        return _mivnav_straight_line(
            a,
            b,
            [
                "the mivnav portal graph has no connection between these points at this "
                f"draft ({required_depth_m:.1f} m = draft + under-keel margin) that the fine "
                "search does not already reject — they are not reachable by navigable water "
                "at this draft — routed as a straight line instead.",
                _MIVNAV_WARNING,
            ],
        )

    stitched, stitch_debug_legs = _stitch_mivnav_coarse_route(
        ocharts, coarse.waypoints, required_depth_m, cfg, timings, collect_debug
    )
    if stitched is None:
        return _mivnav_straight_line(
            a,
            b,
            [
                f"the mivnav portal graph found a coarse route ({coarse.hops} hops) but the "
                "fine search could not follow it (a leg crossed water the exact search "
                "rejects) — routed as a straight line instead.",
                _MIVNAV_WARNING,
            ],
            stitch_debug_legs,
        )

    return PlanResponse(
        waypoints=[LatLon(lat=lat, lon=lon) for lon, lat in stitched.waypoints],
        distance_nm=stitched.distance_m / _METRES_PER_NM,
        warnings=[_MIVNAV_COARSE_WARNING, *stitched.endpoint_warnings, _MIVNAV_WARNING],
        approximate_legs=stitched.approximate_legs,
        check_manually_legs=stitched.check_manually_legs,
        # A route that only assembled after dropping a coarse point still
        # carries that dropped leg's `find_artifact_route_debug` here.
        debug_legs=(stitch_debug_legs or None) if collect_debug else None,
        debug_macro_waypoints=(
            [[lon, lat] for lon, lat in coarse.waypoints] if collect_debug else None
        ),
    )


def _plan_via_mivnav(
    ocharts: OchartsService,
    a: Point,
    b: Point,
    draft_m: float,
    cfg: RoutingConfig,
    data_root: Path,
    timings: Timings,
    collect_debug: bool = False,
) -> "PlanResponse":
    """`RoutingConfig.algorithm == "mivnav"`'s whole path — a near-exact
    copy of `_plan_via_artifact` (same candidate-cell selection, same
    config mapping, same response shape) calling `find_mivnav_route`
    instead of `find_artifact_route`.

    Read this before assuming `"mivnav"` behaves differently from
    `"artifact"` in any way a route consumer could observe: it does not,
    UNLESS `RoutingConfig.mivnav_beam_m > 0` and this request's route
    crosses a marginal-width ("demoted") portal that §12.4 local vector
    refinement can re-route AND re-verify against the draft-aware hard
    constraints. In every other case — and always at the default
    `mivnav_beam_m == 0` — `chartcore.mivnav_route` runs the IDENTICAL
    fine search `chartcore.artifact_route` does, over the identical
    `cells`, with the identical params below, and the accept/reject
    decision, the waypoints, the distance, and every warning derived from
    the route itself are byte-for-byte what `_plan_via_artifact` would
    have produced. When a refinement splice IS kept,
    `debug_legs["mivnav"]["mivnav_refined_portals"]` names the crossings
    it moved.

    **When that fine search finds NO path** (the straight-line corridor
    is blocked by land past `routing::raster`'s ±50 km cap — an island, a
    peninsula, the whole top of a country), this no longer gives up with
    a straight line straight away: `_plan_via_mivnav_coarse` asks the
    persisted `.mivnav`'s portal graph — which has no corridor cap — for
    a COARSE route around the obstruction, then re-runs the SAME
    `find_artifact_route` fine search LEG BY LEG along it
    (`_stitch_mivnav_coarse_route`). Each leg is short, so its own cell
    slice is small and the region-global-scalar problem that closed
    one-big-corridor scoping never bites. A straight line is still the
    answer when there is no single-set artifact to route around with, the
    portal graph itself is disconnected at this draft, or a stitched leg
    fails the exact search — each case named in the warning. This is
    still the `"mivnav"` engine on its own `.mivnav`; there is no
    fallback to a different algorithm.

    `RoutingConfig.mivnav_directional_rules` (default off) adds §11's
    directional / buoyage semantics to the topology layer — an
    against-charted-flow TSS crossing becomes impossible and a wrong-side
    lateral-mark crossing is soft-penalised, which can change which
    corridor the topology search reports. This too leaves the fine-search
    route untouched: it is a topology-diagnostics-only signal, surfaced as
    `debug_legs["mivnav"]["topology_directional_penalized_portals"]`. What is otherwise different is `mivnav_diagnostics`
    (below, folded into `debug_legs["mivnav"]` when `collect_debug`):
    `chartcore::mivnav`'s own precomputed-topology pipeline (band ladder,
    connected components, portals, chain-contracted shortcuts, topology
    search) runs ALONGSIDE the fine search over the same cells and reports
    its own independent answer — whether IT found a portal path too, and
    if so how many hops/what coarse corridor — purely for comparison. This
    is intentional, incremental scope: the real point of building
    `"mivnav"` as its own algorithm (the fine search actually scoped to a
    topology-chosen corridor, and eventually reading a persisted
    `.mivnav` file instead of rebuilding the region every request) is
    real, tracked, future work — see `MIVNAV_ARTIFACT_TODO.md` at the repo
    root for exactly how much of that is built.

    Kept as its own function (duplicating most of `_plan_via_artifact`'s
    body) rather than a shared helper with a branch inside it, for the
    same reason `find_mivnav_route` is its own wrapper rather than a flag
    on `find_artifact_route`: a regression in one algorithm's wiring must
    read as a regression in THAT algorithm, not the other.

    **The persisted-artifact half, and the fallback decision behind it.**
    When this request's whole corridor belongs to ONE installed chart set
    (`_mivnav_artifact_for_request`), the topology layer is pointed at
    that set's `.mivnav` instead of rebuilding the region per request —
    the actual v3 architecture. When there is no artifact, or
    `chartcore`'s own §19 `staleness()` says the one on disk is stale, it
    REBUILDS from this request's candidate cells (today's behaviour) and
    names why, rather than refusing the request. That choice, explicitly:

    * The topology layer does not decide this route. The waypoints,
      distance and every warning come from the `"artifact"` fine search
      over the same decoded cells either way, so refusing would cost a
      real, correct route in order to protect a diagnostic — the wrong
      trade for a boat.
    * A STALE artifact is never read, only rebuilt over. §19 lets a stale
      file open so its staleness can be diagnosed; reading it anyway
      would risk answering a draft question against the wrong band
      threshold (`load_band`'s own docs), which is the one thing an
      acceleration structure over navigational data must never do.
    * The danger CLAUDE.md's `#TSSLPT-OVERSCALE` entry describes is a
      fallback that is INDISTINGUISHABLE from success, so this one is
      loud in three places: `debug_legs[...]["mivnav"]["topology_source"]`
      and `["topology_fallback_reason"]` carry §19's named component, the
      per-request timing line logs the same thing at INFO on every
      request (`find_mivnav_route`), and an artifact that exists but was
      skipped adds a real user-facing warning
      (`_mivnav_stale_artifact_reason`).

    `RoutingConfig.mivnav_require_artifact` (default off) turns the
    rebuild fallback into a REFUSAL — straight line plus a warning naming
    the reason — for a request whose `topology_source` came back anything
    other than `"artifact"`. It changes no route a boat gets; it lets a
    test assert it is on the persisted read path. There is still no
    fallback to a DIFFERENT algorithm anywhere: `algorithm == "mivnav"`
    always runs this function, artifact or rebuild or refusal."""
    required_depth_m = draft_m + cfg.under_keel_margin_m
    cells = cells_for_line(ocharts, a, b, timings)
    t_artifact = time.monotonic()
    artifact_path, chart_set_id, chart_set_sequence, artifact_note = (
        _mivnav_artifact_for_request(ocharts, a, b, data_root, cfg)
    )
    if artifact_note is not None:
        # The backend's OWN reason for not passing an artifact (no chart
        # set, or a corridor spanning several) goes in the live INFO
        # timing line too, not only the opt-in debug payload — chartcore's
        # reasons already do (`find_mivnav_route`), and a fallback that is
        # loud in one channel and silent in another is exactly the gap
        # this design is trying not to have. Found by code review, which
        # measured the docstring's "loud in three places" claim as true in
        # only two.
        timings.record("mivnav_artifact", t_artifact, artifact_note)
    route = find_mivnav_route(
        a,
        b,
        cells,
        required_depth_m=required_depth_m,
        required_air_draft_m=cfg.air_draft_m,
        lateral_margin_m=cfg.lateral_margin_m,
        endpoint_grace_radius_m=cfg.artifact_endpoint_grace_radius_m,
        catzoc_allowance_mode=cfg.artifact_catzoc_allowance_mode,
        allow_restricted_entry=cfg.artifact_allow_restricted_entry,
        tss_avoidance_weight=cfg.tss_avoidance_weight,
        fairway_preference_weight=cfg.fairway_preference_weight,
        cable_avoidance_weight=cfg.cable_avoidance_weight,
        caution_area_avoidance_weight=cfg.caution_area_avoidance_weight,
        low_confidence_survey_avoidance_weight=cfg.low_confidence_survey_avoidance_weight,
        turn_cost_weight=cfg.turn_cost_weight,
        avoid_depth_below_m=cfg.avoid_depth_below_m,
        avoid_depth_weight=cfg.avoid_depth_weight,
        soft_prefer_depth_below_m=cfg.soft_prefer_depth_below_m,
        soft_prefer_depth_weight=cfg.soft_prefer_depth_weight,
        mivnav_beam_m=cfg.mivnav_beam_m,
        mivnav_directional_rules=cfg.mivnav_directional_rules,
        artifact_path=artifact_path,
        chart_set_id=chart_set_id,
        chart_set_sequence=chart_set_sequence,
        timings=timings,
    )
    if route is None:
        # The straight-line corridor is blocked (land in the way past
        # `routing::raster`'s ±50 km cap). Before giving up, ask the
        # persisted portal graph to route AROUND it and fine-search leg
        # by leg along that coarse corridor. `_plan_via_mivnav_coarse`
        # returns a real multi-leg route, or a straight line naming which
        # of the three dead ends it hit (no artifact / graph disconnected
        # / a leg the fine search could not follow). Still the `"mivnav"`
        # engine on its own `.mivnav` — no cross-algorithm fallback, and
        # `mivnav_require_artifact` is unaffected: it refuses the rebuild
        # FALLBACK for a route that WAS found (the check below), and a
        # coarse-stitched route uses the persisted `.mivnav` by
        # construction anyway.
        return _plan_via_mivnav_coarse(
            ocharts,
            a,
            b,
            required_depth_m,
            cfg,
            data_root,
            (artifact_path, chart_set_id, chart_set_sequence, artifact_note),
            timings,
            collect_debug,
        )

    if cfg.mivnav_require_artifact and route.topology_source != TOPOLOGY_SOURCE_ARTIFACT:
        # The route is valid — the per-request rebuild produced it, and it
        # is the byte-identical fine-search route a normal request gets.
        # `mivnav_require_artifact` refuses it anyway, so a test can be
        # certain it exercised the persisted read path and not the
        # fallback. Straight line + a loud warning, same shape as the
        # "found no path" case above, never a silent downgrade.
        reason = (
            route.topology_fallback_reason
            or artifact_note
            or "the topology layer did not read a persisted .mivnav"
        )
        timings.record("mivnav_require_artifact", t_artifact, f"refused: {reason}")
        return PlanResponse(
            waypoints=[LatLon(lat=a.lat, lon=a.lon), LatLon(lat=b.lat, lon=b.lon)],
            distance_nm=haversine_m(a, b) / _METRES_PER_NM,
            warnings=[
                "mivnav_require_artifact is set and the topology layer did not read a "
                f"persisted .mivnav for this request ({reason}) — refusing the "
                "per-request rebuild and routing as a straight line instead. Build the "
                "artifact (POST /routing/mivnav/build) or clear mivnav_require_artifact.",
                _MIVNAV_WARNING,
            ],
            approximate_legs=[True],
            debug_legs=(
                [
                    {
                        **leg_debug_info(a, b, []),
                        "mivnav": mivnav_diagnostics(route, artifact_note=artifact_note),
                    }
                ]
                if collect_debug
                else None
            ),
        )

    waypoints = [LatLon(lat=lat, lon=lon) for lon, lat in route.waypoints]

    warnings: list[str] = []
    for label, requested, (lon, lat), snap_m in (
        ("start point", a, route.waypoints[0], route.start_snap_m),
        ("destination", b, route.waypoints[-1], route.end_snap_m),
    ):
        if snap_m > route.cell_size_m:
            warnings.append(_artifact_snap_reason(label, requested, Point(lat, lon), snap_m))
    for i, j in flagged_run_index_spans(route.approximate_legs):
        lon0, lat0 = route.waypoints[i]
        lon1, lat1 = route.waypoints[j]
        warnings.append(_artifact_approximate_reason(Point(lat0, lon0), Point(lat1, lon1)))
    if artifact_path is not None:
        stale = _mivnav_stale_artifact_reason(artifact_path, route)
        if stale is not None:
            warnings.append(stale)
    warnings.append(_MIVNAV_WARNING)

    return PlanResponse(
        waypoints=waypoints,
        distance_nm=route.distance_m / _METRES_PER_NM,
        warnings=warnings,
        approximate_legs=route.approximate_legs,
        check_manually_legs=route.check_manually_legs,
        debug_legs=(
            [
                {
                    **leg_debug_info(a, b, []),
                    "mivnav": mivnav_diagnostics(route, artifact_note=artifact_note),
                }
            ]
            if collect_debug
            else None
        ),
    )


@router.post("/plan")
def plan_route(
    body: PlanRequest,
    ocharts: OchartsService = Depends(get_ocharts),
    signalk: SignalKService = Depends(get_signalk),
    runtime: Runtime = Depends(get_runtime),
) -> PlanResponse:
    """A hazard-avoiding route from ``body.from_`` to ``body.to``.

    See the module docstring for the fallback-to-a-straight-line case and
    why it still always returns something to draw.
    """
    a = Point(body.from_.lat, body.from_.lon)
    b = Point(body.to.lat, body.to.lon)
    cfg = runtime.config.get().routing

    draft_m = body.draft_m
    if draft_m is None:
        draft_m = _draft_from_signalk(signalk)
    if draft_m is None:
        draft_m = cfg.default_draft_m

    # `RoutingConfig.algorithm` picks the ENGINE for this whole request —
    # chartcore's own raster search (below, unchanged), a remote call to a
    # signalk-routeiq instance (`_plan_via_routeiq`), the local
    # adaptive-graph second algorithm (`_plan_via_graph`), the local v3
    # artifact algorithm (`_plan_via_artifact`), or that same search run
    # alongside the precomputed-topology cross-check (`_plan_via_mivnav`
    # — see its own docstring for why it is not yet a materially
    # different route). The remote path branches before any of this —
    # none of it applies there. Built (and logged live — see `Timings`)
    # on EVERY request, not just a debug-flagged one: `body.debug` only
    # decides whether the same breakdown also rides back on the wire.
    if cfg.algorithm == "routeiq":
        return _plan_via_routeiq(runtime, a, b, draft_m, cfg)

    timings = Timings()
    t_total = time.monotonic()

    if cfg.algorithm == "graph":
        response = _plan_via_graph(ocharts, a, b, draft_m, cfg, timings)
        timings.record("total", t_total, f"draft {draft_m:.1f}m, algorithm=graph")
        if body.debug:
            response.timings = timings.as_wire()
        return response

    if cfg.algorithm == "artifact":
        response = _plan_via_artifact(ocharts, a, b, draft_m, cfg, timings, body.debug)
        timings.record("total", t_total, f"draft {draft_m:.1f}m, algorithm=artifact")
        if body.debug:
            response.timings = timings.as_wire()
        return response

    if cfg.algorithm == "mivnav":
        response = _plan_via_mivnav(
            ocharts, a, b, draft_m, cfg, runtime.config.get().data_root, timings, body.debug
        )
        timings.record("total", t_total, f"draft {draft_m:.1f}m, algorithm=mivnav")
        if body.debug:
            response.timings = timings.as_wire()
        return response

    safety_depth_m = draft_m + cfg.under_keel_margin_m
    route, indexes, main_debug = _plan_leg(ocharts, a, b, safety_depth_m, cfg, timings, body.debug)
    debug_legs: list[dict] = [main_debug] if main_debug is not None else []
    debug_macro_waypoints: list[list[float]] | None = None

    # A macro-scale detour (Limfjord-shaped: the real water connection is
    # entirely outside the ordinary search's own corridor) — only tried
    # when the ordinary search (even after its own recursive per-leg
    # refinement) is STILL badly unreachable, so a normal request pays
    # nothing extra. See `needs_macro_route`'s own docs for the dividing
    # line and `hazards.py`'s macro-route functions for the mechanism.
    used_macro_route = False
    if route is not None and cfg.macro_route_enabled and needs_macro_route(route):
        land_indexes = land_indexes_for_macro_route(ocharts, a, b, timings)
        macro_waypoints = find_macro_detour(a, b, land_indexes, timings)
        if macro_waypoints and len(macro_waypoints) >= 2:
            stitched = _stitch_macro_route(ocharts, macro_waypoints, safety_depth_m, cfg, timings, body.debug)
            if stitched is not None and _macro_route_improves(stitched, route):
                route = stitched
                used_macro_route = True
                # The MACRO-stitched sub-legs are what actually matter for
                # debugging a long detour (`_stitch_macro_route`'s own
                # docs) — replace, not append to, the single main-leg
                # debug info collected above, which described a search
                # this response no longer uses.
                debug_legs = stitched.leg_debugs
                if body.debug:
                    debug_macro_waypoints = [[lon, lat] for lon, lat in macro_waypoints]

    timings.record("total", t_total, f"draft {draft_m:.1f}m")
    wire_timings = timings.as_wire() if body.debug else None

    if route is not None:
        # `indexes` here is always the ORIGINAL a->b hazard union, even
        # when `route` ended up being the stitched macro detour — used
        # only for `_unreachable_reason`'s `point_in_any_hazard` check, so
        # a remaining gap deep inside a macro detour gets the generic "no
        # charted route reaches" wording rather than the more specific
        # "itself inside charted danger" one. A known, accepted v1
        # imprecision: the message is still honest (a straight-line stub
        # still gets drawn and flagged either way), just less specific in
        # that one rare case.
        warnings = _approximate_warnings(route, indexes, draft_m, cfg)
        if used_macro_route:
            warnings.append(_MACRO_ROUTE_WARNING)
        warnings.append(_NO_RULES_WARNING)

        # Purely informational — UNSARE and an openable bridge are both
        # soft preferences now, not hard hazards (see
        # chartcore::routing::hazards' own module-doc notes): the final
        # route's own bbox, checked against that ring set, never against
        # the route's own search.
        check_manually_indexes = check_manually_indexes_for_bbox(
            ocharts, _bbox_around_chain(route.waypoints), cfg.air_draft_m, timings
        )
        check_manually_legs = chartcore.verify_route(route.waypoints, check_manually_indexes)

        return PlanResponse(
            waypoints=[LatLon(lat=lat, lon=lon) for lon, lat in route.waypoints],
            distance_nm=route.distance_m / _METRES_PER_NM,
            warnings=warnings,
            approximate_legs=route.approximate_legs,
            check_manually_legs=check_manually_legs,
            timings=wire_timings,
            debug_legs=debug_legs if body.debug else None,
            debug_macro_waypoints=debug_macro_waypoints,
        )

    # `chartcore.shortest_path` itself found no water at all to route
    # through anywhere near this request — the genuinely pathological
    # case (see its own docstring), not "start/end unreachable" (that
    # still returns a real, if approximate, `route` above now). The bare
    # straight line is the last resort here, unchanged from before this
    # feature existed. One leg, and it's approximate.
    return PlanResponse(
        waypoints=[body.from_, body.to],
        distance_nm=haversine_m(a, b) / _METRES_PER_NM,
        warnings=["no charted water found anywhere near this request — verify manually before following"],
        approximate_legs=[True],
        timings=wire_timings,
    )


@router.post("/verify")
def verify_route(
    body: VerifyRequest,
    ocharts: OchartsService = Depends(get_ocharts),
    signalk: SignalKService = Depends(get_signalk),
    runtime: Runtime = Depends(get_runtime),
) -> VerifyResponse:
    """Exact per-leg hazard check for a route this app never searched —
    a user-drawn or otherwise already-fixed waypoint chain.

    Unlike `/plan`, nothing here is routed, simplified, or approximated:
    every leg of `body.waypoints`, EXACTLY as given, is checked against
    the same hard hazard union `/plan` itself builds (same depth/margin/
    air-draft rules — `hazard_indexes_for_bbox`, `_HARD_LATERAL_FLOOR_M`,
    `cfg.air_draft_m`), via chartcore's own exact `verify_route` (no
    `simplify_path` shortcutting, unlike `chartcore.resimplify_route` —
    see that function's own docs for why this endpoint needed its own
    entry point rather than reusing it: renumbering the caller's own legs
    would silently break `flagged_legs`' own "same order as the request"
    contract).

    Only the HARD hazard union is checked — no TSS/fairway/buoyage/
    caution/survey preference layer (those are soft cost terms for a
    SEARCH to weigh, meaningless for a plain "does this exact line cross
    charted danger" check) — `VerifyResponse.warnings` says so.
    """
    cfg = runtime.config.get().routing

    draft_m = body.draft_m
    if draft_m is None:
        draft_m = _draft_from_signalk(signalk)
    if draft_m is None:
        draft_m = cfg.default_draft_m
    safety_depth_m = draft_m + cfg.under_keel_margin_m

    waypoints = [(p.lon, p.lat) for p in body.waypoints]
    bbox = _bbox_around_chain(waypoints)
    indexes = hazard_indexes_for_bbox(
        ocharts, bbox, safety_depth_m, _HARD_LATERAL_FLOOR_M, air_draft_m=cfg.air_draft_m
    )

    flagged_legs = chartcore.verify_route(waypoints, indexes)
    reasons = _verify_reasons(waypoints, flagged_legs, indexes, draft_m, cfg)

    # UNSARE and an openable bridge are both soft preferences now, not
    # hard hazards (see chartcore::routing::hazards' own module-doc
    # notes) — checked separately from `indexes` above, purely to flag
    # "check manually", never folded into `flagged_legs`/`safe`.
    check_manually_indexes = check_manually_indexes_for_bbox(ocharts, bbox, cfg.air_draft_m)
    check_manually_legs = chartcore.verify_route(waypoints, check_manually_indexes)

    return VerifyResponse(
        flagged_legs=flagged_legs,
        check_manually_legs=check_manually_legs,
        safe=not any(flagged_legs),
        reasons=reasons,
        warnings=[_NO_RULES_WARNING],
    )


# -- the precomputed .mivnav artifact: build trigger and status ------------
#
# MANUAL TRIGGER ONLY. Nothing here is called from chart-set install,
# update or delete, and nothing should be — see
# `mivnav.features.routing.artifact_build`'s own module docstring for why
# (an `O(bands x region size)` build as a side effect of installing charts
# would wedge the boat's server exactly when a sailor is trying to get
# charts onto it). This was an explicit user decision, not an oversight.
#
# One job at a time, no job ids, POST starts / GET polls / POST cancel —
# the `IngestRunner` shape POI and satellite already ride
# (`mivnav.api.datasets`' own `POST /{id}/ingest`, `POST /{id}/ingest/
# cancel`, both returning `runner.status()`), reused rather than a second
# background-job pattern invented alongside it. There are no job ids
# because the runner is genuinely single-slot: a second build while one
# runs is refused with 409, so "the job" is unambiguous.


def get_mivnav_build_runner(runtime: Runtime = Depends(get_runtime)) -> MivnavBuildRunner:
    """The one background ``.mivnav`` build runner — cast to the concrete
    runtime type this feature registered, exactly as
    ``mivnav.features.poi.routes.get_poi_store`` does (``Runtime.feature``
    is deliberately untyped; see its own docstring)."""
    return cast(RoutingRuntime, runtime.feature("routing")).artifact_build_runner()


class MivnavBuildRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chart_set_id: str | None = Field(
        default=None,
        description=(
            "Which installed o-charts set to build the artifact for. May be "
            "omitted only when exactly one set is installed; with several, "
            "naming one is required — building the wrong one costs minutes of "
            "Pi CPU and leaves the one you wanted still unbuilt."
        ),
    )


@router.post("/mivnav/build")
def build_mivnav_artifact(
    body: MivnavBuildRequest | None = None,
    ocharts: OchartsService = Depends(get_ocharts),
    runner: MivnavBuildRunner = Depends(get_mivnav_build_runner),
) -> dict:
    """Start a background build of one chart set's precomputed ``.mivnav``
    routing artifact, and return the job status immediately.

    The build runs every rung of the band ladder over the WHOLE chart set
    (§6 forbids it knowing any vessel's draft, so it precomputes all bands
    or none) — minutes of CPU, which is exactly why it is a background job
    and never part of a route request. Poll ``GET /routing/mivnav/build``;
    the finished status carries §20's record per run (tile counts, tiles
    per resolution rung, blocked/no-coverage/charted-depth cells), which
    is the only evidence that the build saw the charts it should have.

    The CATZOC allowance mode is taken from
    ``RoutingConfig.artifact_catzoc_allowance_mode`` at the moment the job
    starts and is part of the artifact's file name — a route request
    running under a different mode will not find this artifact and will
    say so rather than silently use one built under a laxer policy (see
    :mod:`mivnav.features.routing.mivnav_artifact`).

    409 for an unknown/ambiguous chart set, a set with no readable cells,
    or a build already running; 422 for a chart-set id that cannot be
    turned into a path at all."""
    try:
        runner.build(ocharts, (body.chart_set_id if body else None))
    except UnusableChartSetId as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except MivnavBuildError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return runner.status()


@router.get("/mivnav/build")
def mivnav_build_status(
    runner: MivnavBuildRunner = Depends(get_mivnav_build_runner),
) -> dict:
    """The current (or most recent) ``.mivnav`` build's status — the same
    blob ``POST /routing/mivnav/build`` returns, polled.

    ``state`` is ``idle`` before the first build of this process,
    ``fetch``/``bake`` while running, ``done``, or ``error`` (with
    ``error`` text; ``"cancelled"`` for a cancelled one). Everything the
    build measured rides on the same blob — see
    :class:`mivnav.features.routing.artifact_build.JobStatus`."""
    return runner.status()


@router.post("/mivnav/build/cancel")
def cancel_mivnav_build(
    runner: MivnavBuildRunner = Depends(get_mivnav_build_runner),
) -> dict:
    """Ask a running build to stop. 409 when none is running.

    Cancellation is COARSE and says so: the per-cell decode stage checks
    between cells and stops promptly, but the build itself is one
    ``chartcore.mivnav_build_artifact`` call with no checkpoint inside it,
    so a cancel during that stage is recorded and takes effect when the
    call returns. Either way the job settles to
    ``state: "error"``/``error: "cancelled"`` rather than sticking in
    ``bake`` forever."""
    if not runner.cancel():
        raise HTTPException(status_code=409, detail="no mivnav artifact build is running")
    return runner.status()


@router.get("/mivnav/artifacts")
def list_mivnav_artifacts(
    ocharts: OchartsService = Depends(get_ocharts),
    runtime: Runtime = Depends(get_runtime),
) -> dict:
    """One entry per installed chart set: whether its ``.mivnav`` artifact
    exists, whether it may be USED right now, and if not, precisely why.

    This is the surface that makes the route path's fallback checkable
    rather than merely honest — `_plan_via_mivnav` names its reason on
    every request it serves, but only here can you ask the question
    without planning a route first. ``reason`` is
    ``chartcore::mivnav::Staleness``' own text, which NAMES the stale
    component (schema/derivation/authority/band-ladder/resolution-policy,
    or the chart-set/sequence mismatch); ``kind`` is the same fact
    machine-readable (``missing``/``unreadable``/``chart_set``/
    ``sequence``/``versions``, or ``null`` when usable).

    Reported against the CURRENT
    ``RoutingConfig.artifact_catzoc_allowance_mode``, because that is what
    a route request would look for — an artifact built under a different
    mode reads as ``missing`` here, which is the honest answer to "is
    there one this boat can use", not a claim that no file exists."""
    config = runtime.config.get()
    mode = config.routing.artifact_catzoc_allowance_mode
    out = []
    for set_id, cs in sorted(ocharts.sets().items()):
        try:
            status = mivnav_artifact_status(config.data_root, set_id, cs.sequence, mode)
        except UnusableChartSetId as e:
            # The o-charts store skips such directories outright, so this
            # is unreachable through it — reported rather than raised so
            # one odd set can never blank the whole listing.
            status = {
                "chart_set_id": set_id,
                "catzoc_allowance_mode": mode,
                "present": False,
                "usable": False,
                "kind": "unreadable",
                "reason": str(e),
            }
        status["cells"] = len(cs.cells)
        out.append(status)
    return {"catzoc_allowance_mode": mode, "artifacts": out}


FEATURE: Feature[RoutingRuntime] = Feature(
    id="routing",
    routers=(router,),
    build_runtime=build_routing_runtime,
    data_provider=routing_data_provider,
    # Refuse a chart-config/`data_root` PATCH while a `.mivnav` build is
    # running — that patch would close the `OchartsService` the build is
    # still decoding through, and move where it is about to publish. Same
    # hook and same shape as o-charts' own install guard; added after code
    # review found the window.
    guard=routing_guard,
)
