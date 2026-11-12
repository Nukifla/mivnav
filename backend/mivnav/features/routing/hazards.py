# SPDX-License-Identifier: GPL-2.0-only
"""Querying live o-charts data for hazards along a candidate line, and
searching for a way around what it finds.

Pure logic, deliberately untyped on its `ocharts` parameter: this module
never imports `mivnav.features.ocharts` (a plain `OchartsService` and its
`.sets()`/`.load_cell(cs, cell)`/`.hazard_index(cs, cell, safety_depth_m,
margin_m, air_draft_m=0.0)` are used duck-typed) because
`backend/.importlinter`'s feature-independence contract forbids one
feature reaching into another's internals directly, even for a type hint.
`routes.py` — the one file in this package allowed to import
`mivnav.api.charts` — resolves the real `OchartsService` via
`Depends(get_ocharts)` and passes it in already-live; see that import's
own docstring in `mivnav.api.charts` for why the edge is there instead.
Same reasoning as `routing/geo.py`'s duplicated `Point`/`haversine_m`.
`chartcore` itself is imported directly here — not a `mivnav.features.*`
module, so `.importlinter`'s feature-independence contract has no opinion
on it; `mivnav.features.poi.routes`/`mivnav.features.osm_world.routes`
already do the same.

Everything here degrades rather than fails: a broken cell, a set with no
data for the area, or a chart with no hazards at this depth are all
ordinary outcomes, not errors — this only ever adds information to a
route response, never blocks one. See `chartcore::routing::hazards` (the
Rust side, `chartcore/src/routing/hazards.rs`) for what actually counts as
a hazard; this module only selects cells, searches a path through whatever
`HazardIndex` they hand back (`chartcore::routing::raster`), and can still
sample a straight line against them for a caller that wants that instead
(`first_hazard_on_line`, kept for that narrower use).
"""

from __future__ import annotations

import base64
import logging
import logging.handlers
import math
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import chartcore

from mivnav.config.model import default_log_dir
from mivnav.features.routing.geo import Point, haversine_m
from mivnav.geo.countries import country_polygon, list_countries

log = logging.getLogger(__name__)
# INFO, WITH OUR OWN HANDLERS — not the app's usual default. Two separate
# gaps, both confirmed directly (not assumed), either one alone would have
# silently swallowed every line `Timings.record` below emits:
#   1. This process's root logger stays at WARNING (nothing anywhere in
#      this codebase calls `logging.basicConfig`, and uvicorn's own
#      `configure_logging()` deliberately leaves the root logger alone —
#      its config only names `uvicorn`/`uvicorn.access`/`uvicorn.error`).
#   2. Even after raising THIS logger's own level to INFO, Python's
#      logging still drops every record: a logger with no handler
#      anywhere in its propagation chain falls back to
#      `logging.lastResort`, which is HARDCODED to WARNING regardless of
#      the logger's own level — so the level bump alone still produced
#      total silence.
# A handler on this logger directly is what actually fixes it — scoped to
# this one logger, not a global change. See `Timings` below for what it's
# for: watching a real `/routing/plan` request step by step was how the
# 97-second regression (`ROUTING_TODO.md`) got found and fixed at all, and
# it stays worth watching live, not just after the fact with a profiler.
#
# TWO handlers, not one: the `StreamHandler` is what `just dev`'s own
# console shows live; it alone was what this module shipped with first,
# and it turned out not to be enough — diagnosing the corridor-scaling
# regression this module's own raster rewrite exists to fix needed
# reproducing the slow request live against a running server, because
# nothing kept a history of what an EARLIER request had done. The
# `RotatingFileHandler` on `default_log_dir() / "routing.log"` is that
# history: `tail -f` it while creating a route in the app, no live
# `just dev` session required. Timestamped (the stream one stays terse for
# live reading, since its own terminal already carries a timestamp
# implicitly via when it printed).
log.setLevel(logging.INFO)
# Its own handlers below; not also the package one (mivnav.api.app), which
# would print every line twice.
log.propagate = False
if not log.handlers:
    _stream = logging.StreamHandler()
    _stream.setFormatter(logging.Formatter("%(message)s"))
    log.addHandler(_stream)
    try:
        _log_dir = default_log_dir()
        _log_dir.mkdir(parents=True, exist_ok=True)
        _file = logging.handlers.RotatingFileHandler(
            _log_dir / "routing.log", maxBytes=5_000_000, backupCount=3
        )
        _file.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        log.addHandler(_file)
    except OSError:
        # Everything in this module degrades rather than fails (see the
        # module docstring) — a log directory permission problem must
        # never be what breaks route planning.
        log.warning("routing: could not open persisted log file, stream-only", exc_info=True)

#: How many points to sample along the candidate line. A sampled check,
#: not exact segment-vs-hazard intersection — a stopgap for today's
#: straight-line placeholder; the real search tests segments exactly, not
#: point samples. Fixed rather than distance-based, so cost stays bounded
#: on a long passage.
_LINE_SAMPLES = 100


@dataclass
class Step:
    """One timed step of a `/routing/plan` request — see `Timings`."""

    label: str
    ms: float
    detail: str = ""


class Timings:
    """A live, per-request timing breakdown for `/routing/plan` — built
    because a real request against real data once took 97 seconds and the
    only way anyone could see WHERE the time went was to profile it by
    hand, offline, after the fact (`ROUTING_TODO.md`). One of these is
    built for EVERY request, not just a debug-flagged one: `record` always
    logs immediately (at INFO — see this module's own logger setup) so
    `just dev`'s console shows each step as it completes while a request
    is in flight, which is the actual "watch it work" ask this exists
    for. `as_wire()` — the same steps, structured — is what a
    debug-flagged request additionally returns on the wire, for a `curl`
    or the routeTest pill to read without needing the server's own
    console open.
    """

    def __init__(self) -> None:
        self.steps: list[Step] = []

    def record(self, label: str, start: float, detail: str = "") -> None:
        ms = (time.monotonic() - start) * 1000
        self.steps.append(Step(label, ms, detail))
        log.info("routing: %-28s %6.0fms%s", label, ms, f"  ({detail})" if detail else "")

    def as_wire(self) -> list[dict]:
        return [{"step": s.label, "ms": round(s.ms, 1), "detail": s.detail} for s in self.steps]


def _bbox_around(a: Point, b: Point) -> tuple[float, float, float, float]:
    """(w, s, e, n) degrees a candidate-cell selection needs to cover for
    `a`→`b` — delegates to `chartcore.routing_corridor_bbox`, the same
    corridor-sizing `chartcore.shortest_path` itself uses (at its widest
    widen-retry pad), rather than a separately-tuned pad around the line's
    own span. One source of truth for "how wide an area does this route
    need", not two pads that can drift apart: an earlier version of this
    function used a FIXED degree pad regardless of route length, so a long
    line's already-huge bbox (spanning most of the line itself) pulled in
    every cell along the way — cheap header-only, but still O(route
    length) candidates, each needing its own sequential `hazard_index`
    decode below. `chartcore`'s own corridor is bounded the search itself
    is bounded by (see `chartcore/src/routing/raster.rs`'s module docs),
    so selecting cells against that same box can't reintroduce that cost
    on the Python side even after the Rust-side search itself got fixed."""
    return chartcore.routing_corridor_bbox(a.lon, a.lat, b.lon, b.lat)


def _extents_intersect(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float]
) -> bool:
    """Do two (w, s, e, n) degree boxes overlap? Mirrors
    `mivnav.features.ocharts.service._intersects` exactly — duplicated,
    not imported, for the same reason as the module docstring."""
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def _candidate_cells(ocharts, bbox: tuple[float, float, float, float]) -> list[tuple]:
    """Every `(set, cell)` of every installed o-charts set whose header
    extent overlaps `bbox` — cheap (header data only, no decode). A
    superset is the safe direction: one extra cell is one extra hazard
    check, never a missed hazard, so this errs toward including."""
    out = []
    for cs in ocharts.sets().values():
        for cell in cs.cells:
            if _extents_intersect(cell.extent, bbox):
                out.append((cs, cell))
    return out


def hazard_indexes_for_line(
    ocharts,
    a: Point,
    b: Point,
    safety_depth_m: float,
    margin_m: float,
    timings: Timings | None = None,
    *,
    air_draft_m: float = 0.0,
) -> list:
    """The `chartcore.HazardIndex` of every candidate cell along `a`→`b`
    that has any hazard at `safety_depth_m`/`margin_m`/`air_draft_m` — see
    `hazard_indexes_for_bbox`'s own docs for the mechanism (candidate
    selection, LRU reuse, and the chart-authority clipping this delegates
    to); this is just that function fed `_bbox_around(a, b)`, the bounded
    per-request corridor every OTHER caller of this specific function
    wants. `air_draft_m=0.0` (the default) means no `BRIDGE`/`CBLOHD`
    vertical-clearance checking at all, matching every caller that predates
    this parameter."""
    return hazard_indexes_for_bbox(
        ocharts, _bbox_around(a, b), safety_depth_m, margin_m, timings, air_draft_m=air_draft_m
    )


def hazard_indexes_for_bbox(
    ocharts,
    bbox: tuple[float, float, float, float],
    safety_depth_m: float,
    margin_m: float,
    timings: Timings | None = None,
    *,
    air_draft_m: float = 0.0,
) -> list:
    """The `chartcore.HazardIndex` of every candidate cell overlapping
    `bbox` (`(w, s, e, n)` degrees) that has any hazard at
    `safety_depth_m`/`margin_m`/`air_draft_m` (`0.0`, the default, means no
    `BRIDGE`/`CBLOHD` vertical-clearance checking at all — see
    `chartcore::routing::hazards::build_hazard_index`'s own "Air draft"
    docs) — decoding (and thereby caching, via
    `ocharts.load_cell`'s own LRU) only cells whose header extent could
    plausibly matter, and reusing the union itself (`ocharts.hazard_
    index`'s own LRU, keyed on cell + depth + margin) when an earlier
    request already built it — see that method's docstring for why this
    stopped being the largest per-request cost it used to be.

    **The land floor**: every SUFFICIENTLY DETAILED candidate (scale below
    `_MACRO_OVERVIEW_SCALE_MIN` — see that constant's own docs for why the
    line sits there, and the real regression at a genuine overview scale
    that put it there) ALSO contributes its own `ocharts.land_hazard_index`
    (`LNDARE`/`SLCONS` alone — `UNSARE` is no longer unconditional at all,
    see `chartcore::routing::hazards`' own module-doc note) — unioned in
    unconditionally, never authority-clipped, regardless of what the
    clipped `hazard_index` half below does. See that module's own
    "Authority-clipping exemption for land" docs for why: land found by a chart detailed
    enough to trust on its own must never be silently erased just because
    a finer chart's coverage happens to overlap ground that finer chart
    never itself re-digitized as land — found live, a real thin strip of
    coastline vanishing exactly along a chart-authority seam before this
    floor existed. A genuine OVERVIEW chart's own land does NOT get this
    treatment — it still goes through ordinary authority clipping only,
    same as before this floor existed at all, because an overview chart's
    own simplified coastline is not a claim worth trusting unconditionally
    (that scale gate's own docs have the second real regression this
    closes).

    **Chart authority** (the OTHER half — `hazard_index`, depth/wreck/
    entry-restricted/air-draft hazards): candidates are processed FINEST
    (smallest compilation scale, most detail) first, and a coarser
    candidate's own hazard is CLIPPED (`HazardIndex.clipped_to_authority`)
    against every already-processed — therefore at-least-as-fine —
    candidate's own charted coverage before it joins the returned list.
    Asked for directly, from a real reported case, not a hypothetical: a
    bbox-only candidate selection unions every chart overlapping the
    corridor regardless of scale, so a very-coarse OVERVIEW cell's
    simplified coastline could (and, on a real installed set, did)
    silently override
    an accurate harbour-scale chart's "this is open water" for the exact
    same ground — the router would refuse a real, charted marina entrance
    because a 1:1,500,000 overview chart's crude land shape swallowed it,
    with no way to tell from the outside that a MORE detailed chart
    disagreed. This is the same "a finer chart is authoritative over the
    ground it actually covers" rule tile SERVING already applies
    (`chartcore::mvt::select`) — the hazard union never had an equivalent
    until now. `cell.coverage` is already `None` for a cell that declares
    no real coverage rings at all (a bare extent-box claim is not
    evidence of authority — same instinct `mvt::select`'s own
    `is_extent_box` guard applies), so such a cell never contributes to
    the "finer" set, erring toward keeping a hazard rather than
    (possibly wrongly) clipping one away.

    **Why `bbox`, not just two points** (#owqqcdqe, 2026-08-10, found
    live): clipping is only globally consistent within the SAME bbox it
    ran over — concatenating several DIFFERENT calls' own results (one
    `hazard_indexes_for_line` per macro-stitched sub-leg, each clipped
    against only the finer charts ITS OWN narrow bbox happened to select)
    is NOT equivalent to one clip over their combined area: a coarse
    overview polygon correctly clipped away in leg A's own context (a
    finer chart was also a candidate there) can survive UNCLIPPED in leg
    B's own separately-computed result (leg B's own narrower bbox never
    happened to pull in that finer chart), and naively unioning the two
    then reintroduces the exact silent-override bug the paragraph above
    describes — measured live: a real cross-leg shortcut chartcore's own
    exact `visible()` correctly allows over a FRESH, single-bbox-clipped
    index set was wrongly blocked by a stale, only-locally-clipped ring
    surviving in a naive concatenation. `mivnav.features.routing.routes.
    _stitch_macro_route`'s own post-stitch `chartcore.resimplify_route`
    call is the one caller that needs this — a single clip over the
    WHOLE route's own bbox, not per sub-leg.

    `timings`, when given, gets one entry for candidate selection and one
    PER CELL — deliberately per-cell, not one lump sum: the 97-second
    regression this exists to make visible again was exactly "most cells
    are fast, one or two are not", a fact a single total would have hidden
    just as effectively as having no timing at all. See `Timings`."""
    t0 = time.monotonic()
    candidates = _candidate_cells(ocharts, bbox)
    if timings is not None:
        timings.record("candidate_cells", t0, f"{len(candidates)} cells")

    ranked = sorted(candidates, key=lambda pair: pair[1].scale)

    indexes = []
    finer_coverages: list = []
    for cs, cell in ranked:
        t1 = time.monotonic()
        try:
            idx = ocharts.hazard_index(cs, cell, safety_depth_m, margin_m, air_draft_m)
            if idx is not None and finer_coverages:
                idx = idx.clipped_to_authority(finer_coverages)
        except Exception:
            # A broken/corrupt cell must not fail a route check — same
            # instinct as mivnav.features.ocharts.service's own
            # `_drop_broken_cells`, applied here instead of to tile serving.
            log.warning("routing: cell %s unusable for a hazard check", cell.path.name, exc_info=True)
            continue
        if timings is not None:
            timings.record(
                f"hazard_index[{cell.path.name}]",
                t1,
                f"{idx.ring_count} rings" if idx is not None else "no hazard here",
            )
        if idx is not None:
            indexes.append(idx)

        # The unconditional land floor (LNDARE/UNSARE/SLCONS) — unioned in
        # for every SUFFICIENTLY DETAILED candidate, deliberately NEVER
        # clipped by `finer_coverages` (see `chartcore::routing::hazards`'
        # own "Authority-clipping exemption for land" docs): real land
        # found by such a chart must never be silently erased just because
        # a different, finer-scale chart's coverage overlaps ground that
        # finer chart itself never re-digitized as land. Found live
        # against a real commercial chart set — a thin strip of real
        # coastline vanished from the union exactly along the seam where
        # one chart's coverage authority met another's, with nothing
        # underneath to catch it; this is that floor.
        #
        # `cell.scale >= _MACRO_OVERVIEW_SCALE_MIN` is EXCLUDED from this
        # floor — a genuine OVERVIEW chart (that constant's own docs have
        # the full reasoning). The first version of this floor had no such
        # gate and regressed the ORIGINAL clip_to_authority bug it was
        # meant to fix, just for land specifically: found live at a real
        # marina — a 1:1,500,000 Denmark-wide overview chart generalizes
        # away a harbour's own small notch of water by design (that is
        # what an overview chart is FOR), so its own simplified coastline
        # shows solid land there. Unconditionally trusting that land made
        # the notch permanently unreachable, since an overview chart
        # covering "everywhere" is always a candidate. Ordinary
        # `clip_to_authority` (the block above) is exactly right for a
        # chart this coarse — let a genuinely finer, locally-accurate
        # chart's coverage override it, same as before this floor existed
        # at all. The floor is for a chart detailed enough that ITS OWN
        # land claim should already be trustworthy on its own — an
        # overview chart's was never that; only a coastal/approach/
        # harbour-scale chart's is.
        #
        # A separate try/except from the block above: a broken land-only
        # build must not also discard an otherwise-good `idx` from the
        # SAME cell.
        if cell.scale < _MACRO_OVERVIEW_SCALE_MIN:
            try:
                land_idx = ocharts.land_hazard_index(cs, cell, margin_m)
            except Exception:
                log.warning("routing: cell %s unusable for a land-hazard check", cell.path.name, exc_info=True)
                land_idx = None
            if land_idx is not None:
                indexes.append(land_idx)

        if cell.coverage is not None:
            finer_coverages.append(cell.coverage)
    return indexes


def cells_for_line(ocharts, a: Point, b: Point, timings: Timings | None = None) -> list:
    """Every candidate cell along `a`→`b`, DECODED — a list of
    `chartcore.Cell`, not `chartcore.HazardIndex`.

    The `"artifact"` algorithm (`chartcore.artifact_route`) is the one
    caller: unlike `shortest_path`/`graph_route`, it takes decoded cells
    and re-derives chart truth itself, because the whole point of it is a
    wider class list and a per-feature `CATZOC` buffer that no
    `HazardIndex` carries (see `chartcore::routing::artifact`'s own docs).
    Same corridor (`_bbox_around`, i.e. `chartcore.routing_corridor_bbox`)
    and same cheap header-only candidate selection (`_candidate_cells`)
    every other selector here uses, and the same `ocharts.load_cell` LRU
    the hazard/preference/check-manually paths already decode through — so
    an `"artifact"` request pays for exactly the same decodes a `"raster"`
    one over the same corridor would, and warms the same cache.

    No PER-RING chart-authority clipping the way `hazard_indexes_for_bbox`
    does it: clipping there is an operation on a built ring union, and
    nothing is built on this side of the boundary — the algorithm sees
    whole cells and does its own coverage reasoning (v3 §3.3's "absent
    coverage blocks", which needs the raw `M_COVR` statement, not a
    pre-clipped union). `routing::artifact::build_query_constraints`
    (chartcore) DOES now drop a whole cell this bbox selected when a
    finer cell, also selected, already charts everything it reaches over
    their own combined extent (`mivnav::authority::region_authority` —
    the same §3.2 pass `mivnav::build_region`'s bake runs, reused rather
    than reimplemented) — found live: a DK-wide overview cell entering a
    long coarse-stitch leg's own bbox here was enough to flip a real
    point's reachability against an otherwise-identical short leg whose
    narrower bbox never selected it. What is still missing is the
    PARTIAL case `hazard_indexes_for_bbox` handles and this does not: a
    coarse cell that is authoritative for only PART of the corridor
    still contributes every ring it has, not just its own residual
    sliver — the reason `"raster"` stays the default engine.

    Sorted FINEST-scale first, then by name — a total, data-independent
    order, so the cell list handed to a deterministic algorithm is itself
    deterministic (v3 §13) rather than dict-iteration order over the
    installed sets. A cell that will not decode is logged and skipped,
    exactly as in `hazard_indexes_for_bbox`: a broken cell must not fail
    a whole route."""
    t0 = time.monotonic()
    candidates = _candidate_cells(ocharts, _bbox_around(a, b))
    if timings is not None:
        timings.record("artifact_candidate_cells", t0, f"{len(candidates)} cells")

    cells = []
    for cs, cell in sorted(candidates, key=lambda pair: (pair[1].scale, pair[1].path.name)):
        t1 = time.monotonic()
        try:
            decoded = ocharts.load_cell(cs, cell)
        except Exception:
            log.warning("routing: cell %s unusable for an artifact route", cell.path.name, exc_info=True)
            continue
        if timings is not None:
            timings.record(f"load_cell[{cell.path.name}]", t1, f"1:{cell.scale}")
        cells.append(decoded)
    return cells


def candidate_chart_sets_for_line(ocharts, a: Point, b: Point) -> list[tuple[str, int, int]]:
    """`(set_id, sequence, candidate cell count)` for every installed
    o-charts set contributing at least one candidate cell to `a`→`b`,
    most cells first — the SAME corridor and the SAME cheap header-only
    selection `cells_for_line` itself uses (`_bbox_around` +
    `_candidate_cells`), so this answers "which chart sets does this
    request actually read" without decoding anything.

    Exists for one caller, `_plan_via_mivnav`: a `.mivnav` artifact is
    built PER CHART SET (`chartcore::mivnav::ChartSetIdentity`), so a
    request whose corridor spans two installed sets has no single
    artifact that covers it — the topology layer would be answering over
    a region missing half the charts the fine search can see. That case
    falls back to a per-request rebuild WITH the reason named, rather
    than quietly using a partial artifact; see `_plan_via_mivnav`.

    `sequence` is the store's own `cs.sequence` (max mtime over the set's
    files) — deliberately the same number that already invalidates the
    tile cache, which is exactly what `ChartSetIdentity` reuses so the
    two caches can never disagree about what "current" means.

    **Counts CANDIDATES, not decoded cells** — a deliberate, one-sided
    approximation, flagged by code review rather than silently kept:
    `cells_for_line` additionally drops a cell that will not decode, so a
    set contributing only undecodable cells still shows up here. The
    error therefore only ever goes toward reporting MORE sets than the
    fine search really read, which disables the artifact for a request
    that could have used one — a lost optimisation, never a topology
    layer answering over the wrong region. Making it exact would mean
    decoding here (the expensive thing this cheap header-only pass exists
    to avoid) or threading set ids back out of `cells_for_line`, which
    `_plan_via_artifact` shares and does not want."""
    bbox = _bbox_around(a, b)
    counts: dict[str, tuple[int, int]] = {}
    for cs, cell in _candidate_cells(ocharts, bbox):
        sequence, n = counts.get(cs.id, (cs.sequence, 0))
        counts[cs.id] = (sequence, n + 1)
    return sorted(
        ((set_id, seq, n) for set_id, (seq, n) in counts.items()),
        key=lambda t: (-t[2], t[0]),
    )


def check_manually_indexes_for_bbox(
    ocharts,
    bbox: tuple[float, float, float, float],
    air_draft_m: float,
    timings: Timings | None = None,
) -> list:
    """The `chartcore.HazardIndex` rings for TWO unrelated "this router
    can't fully resolve it, ask a human" cases, combined into one list —
    NOT `.hazard_index(...)`, neither is a hard hazard any more:

    * `UNSARE` (unsurveyed area, `Cell.unsurveyed_union()`) — found live,
      a real UNSARE patch near Skagen with no genuinely better-surveyed
      water nearby made the router refuse an otherwise fine route
      outright. Now folded into `chartcore::routing::preference::
      build_low_confidence_survey_union`'s own soft-avoid weight instead
      (see `chartcore::routing::hazards`' own module-doc note).
    * A `BRIDGE` this boat cannot clear CLOSED but whose `CATBRG` says it
      can open (`Cell.openable_bridge_union(air_draft_m)`) — a real
      opening can be requested, but this router has no VHF/schedule
      concept to confirm one is actually available, so it is never
      counted as passable water either (see `chartcore::routing::hazards::
      build_openable_bridge_union`'s own docs).

    Both are the SEPARATE, purely informational half of their own class:
    the combined ring set a caller runs an ALREADY-DECIDED route's own
    exact legs against (`chartcore.verify_route` — the same generic
    per-leg geometry check `/verify`'s own hard-hazard flagging already
    uses; a leg crossing EITHER ring set reads as one flag, not two —
    `chartcore.verify_route` itself unions every index it's given before
    checking, so passing both lists' rings together here is what makes
    that a single combined answer rather than two separate calls a caller
    would have to OR together) to answer "does this leg need a human's own
    judgement at all", surfaced as `PlanResponse.check_manually_legs`/
    `VerifyResponse.check_manually_legs` — never a reason to alter or
    refuse the route itself.

    No depth/margin gate (neither `UNSARE` nor a bridge's own opening
    status carries a depth value to gate on) and no chart-authority
    clipping, unlike `hazard_indexes_for_bbox`: this is an informational
    overlay, not a hazard union another chart's finer coverage should be
    allowed to erase — same "skip clipping" precedent
    `preference_indexes_for_line`'s own soft-avoid unions below already
    set. `air_draft_m <= 0.0` (unconfigured) means `openable_bridge_union`
    always returns `None` — mirrors `hazard_indexes_for_bbox`'s own
    air-draft gate, not a separate on/off switch here."""
    t0 = time.monotonic()
    candidates = _candidate_cells(ocharts, bbox)
    if timings is not None:
        timings.record("check_manually_candidate_cells", t0, f"{len(candidates)} cells")

    indexes = []
    for cs, cell in candidates:
        t1 = time.monotonic()
        try:
            decoded = ocharts.load_cell(cs, cell)
            unsurveyed = decoded.unsurveyed_union()
            bridge = decoded.openable_bridge_union(air_draft_m)
        except Exception:
            log.warning("routing: cell %s unusable for a check-manually scan", cell.path.name, exc_info=True)
            continue
        if timings is not None:
            timings.record(
                f"check_manually[{cell.path.name}]",
                t1,
                f"unsurveyed {unsurveyed.ring_count if unsurveyed else 0} rings, "
                f"openable bridge {bridge.ring_count if bridge else 0} rings",
            )
        if unsurveyed is not None:
            indexes.append(unsurveyed)
        if bridge is not None:
            indexes.append(bridge)
    return indexes


def preference_indexes_for_line(
    ocharts,
    a: Point,
    b: Point,
    *,
    want_tss: bool,
    want_fairway: bool,
    want_cable: bool = False,
    want_caution: bool = False,
    want_survey: bool = False,
    timings: Timings | None = None,
) -> tuple[list, list, list, list, list]:
    """The `chartcore.HazardIndex`-shaped TSS-avoidance, preferred-route,
    cable/pipeline, caution-area, and low-confidence-survey preference ring
    unions
    (`Cell.tss_union()`/`Cell.fairway_union()`/`Cell.cable_union()`/
    `Cell.caution_union()`/`Cell.survey_union()` — NOT `.hazard_index(...)`,
    these are
    legal-to-cross preference zones, not hazards) for every candidate cell
    along `a`→`b`, using the SAME corridor/candidate-cell selection
    `hazard_indexes_for_line` uses. Despite its name, `Cell.fairway_union()`
    now returns the UNIONED `FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT`
    preferred-route family, not `FAIRWY` alone (`chartcore::routing::
    preference`'s own docs have the full reasoning) — this function needed
    no change for that broadening, since it only ever passes the union
    through by name.

    `want_tss`/`want_fairway`/`want_cable`/`want_caution`/`want_survey` gate
    decode PER
    LAYER — `routes.py`, the only caller, passes `False` exactly when the
    matching `RoutingConfig` weight is 0 (or, for `_plan_via_graph`, when
    that algorithm has no concept of the layer at all — see its own call
    site), so a disabled layer costs nothing here, matching every other
    "off costs nothing" precedent in this module. If all five are `False`,
    no candidate-cell scan runs at all. `want_cable`/`want_caution`/
    `want_survey` default
    to `False` (unlike `want_tss`/`want_fairway`, which every existing
    caller already passes explicitly) so this signature broadening needed
    no change at either of the two call sites that don't care about the
    new layers.

    `ocharts.load_cell`'s own LRU means calling it again here (after
    `hazard_indexes_for_line` already called it once for the same
    request) is a cache hit, not a re-decode."""
    if not want_tss and not want_fairway and not want_cable and not want_caution and not want_survey:
        return [], [], [], [], []
    t0 = time.monotonic()
    candidates = _candidate_cells(ocharts, _bbox_around(a, b))
    if timings is not None:
        timings.record("preference_candidate_cells", t0, f"{len(candidates)} cells")

    tss_indexes: list = []
    fairway_indexes: list = []
    cable_indexes: list = []
    caution_indexes: list = []
    survey_indexes: list = []
    for cs, cell in candidates:
        t1 = time.monotonic()
        try:
            decoded = ocharts.load_cell(cs, cell)
            tss = decoded.tss_union() if want_tss else None
            fairway = decoded.fairway_union() if want_fairway else None
            cable = decoded.cable_union() if want_cable else None
            caution = decoded.caution_union() if want_caution else None
            survey = decoded.survey_union() if want_survey else None
        except Exception:
            log.warning("routing: cell %s unusable for a preference check", cell.path.name, exc_info=True)
            continue
        if timings is not None:
            timings.record(
                f"preference[{cell.path.name}]",
                t1,
                f"tss {tss.ring_count if tss else 0} rings, fairway {fairway.ring_count if fairway else 0} rings, "
                f"cable {cable.ring_count if cable else 0} rings, caution {caution.ring_count if caution else 0} rings, "
                f"survey {survey.ring_count if survey else 0} rings",
            )
        if tss is not None:
            tss_indexes.append(tss)
        if fairway is not None:
            fairway_indexes.append(fairway)
        if cable is not None:
            cable_indexes.append(cable)
        if caution is not None:
            caution_indexes.append(caution)
        if survey is not None:
            survey_indexes.append(survey)
    return tss_indexes, fairway_indexes, cable_indexes, caution_indexes, survey_indexes


def buoyage_indexes_for_line(
    ocharts,
    a: Point,
    b: Point,
    *,
    want_buoyage: bool,
    iala_region_default: str,
    radius_m: float,
    timings: Timings | None = None,
) -> list:
    """The `chartcore.HazardIndex`-shaped "wrong side of a lateral mark"
    penalty union (`Cell.buoyage_penalty(...)`) for every candidate cell
    along `a`→`b`, using the SAME corridor/candidate-cell selection
    `hazard_indexes_for_line` uses. Unlike `preference_indexes_for_line`'s
    two layers, this one needs a resolved IALA region first — every
    candidate cell is scanned once for its own charted `M_NSYS`/`MARSYS`
    (`Cell.iala_region()`), the first one found wins, and
    `iala_region_default` (`RoutingConfig.iala_region`) is the fallback
    when none of them charts one at all (most cells don't — see
    `chartcore::routing::buoyage`'s own docs).

    `want_buoyage` gates the whole scan — `routes.py`, the only caller,
    passes `False` exactly when `RoutingConfig.buoyage_avoidance_weight`
    is 0, matching every other "off costs nothing" precedent in this
    module.

    `ocharts.load_cell`'s own LRU means calling it again here (after
    `hazard_indexes_for_line` already called it once for the same
    request) is a cache hit, not a re-decode."""
    if not want_buoyage:
        return []
    t0 = time.monotonic()
    candidates = _candidate_cells(ocharts, _bbox_around(a, b))
    if timings is not None:
        timings.record("buoyage_candidate_cells", t0, f"{len(candidates)} cells")

    region = iala_region_default
    for cs, cell in candidates:
        try:
            decoded = ocharts.load_cell(cs, cell)
        except Exception:
            continue
        found = decoded.iala_region()
        if found is not None:
            region = found
            break

    indexes = []
    for cs, cell in candidates:
        t1 = time.monotonic()
        try:
            decoded = ocharts.load_cell(cs, cell)
            idx = decoded.buoyage_penalty(a.lon, a.lat, b.lon, b.lat, region, radius_m)
        except Exception:
            log.warning("routing: cell %s unusable for a buoyage check", cell.path.name, exc_info=True)
            continue
        if timings is not None:
            timings.record(
                f"buoyage[{cell.path.name}]",
                t1,
                f"{idx.ring_count} rings (region {region})" if idx is not None else f"clear (region {region})",
            )
        if idx is not None:
            indexes.append(idx)
    return indexes


def first_hazard_on_line(a: Point, b: Point, indexes: list) -> Point | None:
    """The first sampled point along `a`→`b` that falls inside any of
    `indexes`, or `None` if every sample is clear. See `_LINE_SAMPLES`.

    Not used by `find_route` below — a found route is hazard-clear by
    construction (exact geometry, not sampling). Kept for a caller that
    wants to know whether the DIRECT line specifically is blocked, not
    just whether some route exists."""
    if not indexes:
        return None
    for i in range(_LINE_SAMPLES + 1):
        t = i / _LINE_SAMPLES
        lat = a.lat + (b.lat - a.lat) * t
        lon = a.lon + (b.lon - a.lon) * t
        if any(idx.contains(lon, lat) for idx in indexes):
            return Point(lat, lon)
    return None


def point_in_any_hazard(indexes: list, p: Point) -> bool:
    """Is `p` itself unsafe, per any of `indexes`? Used to explain a
    `find_route` miss: a search that can't reach a point INSIDE a hazard
    is working as intended (see `chartcore::routing::raster`'s module docs
    on why that's not explicitly special-cased there), but the caller
    still owes the user a reason rather than a bare "no route"."""
    return any(idx.contains(p.lon, p.lat) for idx in indexes)


def leg_debug_info(a: Point, b: Point, indexes: list) -> dict:
    """The DEBUG-ONLY geometry for one leg's own already-built `indexes`
    (`hazard_indexes_for_line`'s return) — everything a caller needs to
    draw "why did it avoid here, and where was it even looking": the
    same `(w, s, e, n)` candidate-cell bbox `hazard_indexes_for_line`
    itself searched (`_bbox_around` — recomputed, not re-plumbed through;
    a bare geometry function, no chart re-decode, so this is free), and
    every hazard ring actually unioned into `indexes`, as raw `[lon,
    lat]` pairs — asked for directly (#owqqcdqe, 2026-08-10): "add a
    debugging layer... to check why it puts points where they are, it
    makes no sense" — a route that LOOKS wrong is a lot less mysterious
    once you can see the exact polygon the search was avoiding and the
    exact box it searched, instead of guessing from the waypoints alone.

    Deliberately raw `[lon, lat]` float pairs, NOT this API's usual
    `{"lat":..., "lon":...}` object shape (`LatLon`, `routes.py`): a real
    coastline's own hazard ring can run to tens of thousands of points
    (measured live: an 11,057-point ring, not a hypothetical) — this is
    opt-in debug payload only (`PlanRequest.debug`), never sent to an
    ordinary caller, but still not a place to pay 5-10x the JSON size for
    named-key objects over bare arrays for no reader benefit."""
    w, s, e, n = _bbox_around(a, b)
    rings = [[[lon, lat] for lon, lat in ring] for idx in indexes for ring in idx.rings_lonlat()]
    return {"bbox": [w, s, e, n], "hazard_rings": rings}


def find_route(
    a: Point,
    b: Point,
    indexes: list,
    timings: Timings | None = None,
    *,
    shallow_avoidance_radius_m: float = 0.0,
    shallow_avoidance_weight: float = 0.0,
    lateral_margin_radius_m: float = 0.0,
    tss_indexes: Sequence = (),
    tss_avoidance_weight: float = 0.0,
    fairway_indexes: Sequence = (),
    fairway_preference_weight: float = 0.0,
    buoyage_indexes: Sequence = (),
    buoyage_avoidance_weight: float = 0.0,
    cable_indexes: Sequence = (),
    cable_avoidance_weight: float = 0.0,
    caution_indexes: Sequence = (),
    caution_area_avoidance_weight: float = 0.0,
    survey_indexes: Sequence = (),
    low_confidence_survey_avoidance_weight: float = 0.0,
    turn_cost_weight: float = 0.0,
) -> "chartcore.RoutePath | None":
    """The shortest hazard-avoiding path from `a` to `b`, given the
    `indexes` already selected for this line (`hazard_indexes_for_line`) —
    a thin wrapper around `chartcore.shortest_path`
    (`chartcore::routing::raster::shortest_path_weighted`). `None` when no
    path exists at all (see `point_in_any_hazard` for the two common
    reasons: `a` or `b` is itself inside a hazard).

    Correct with an EMPTY `indexes` too, not just a convenience for the
    non-empty case: `chartcore.shortest_path` with no hazard rings at all
    returns the plain two-point line between `a` and `b` directly (proven
    by `chartcore`'s own `open_water_is_a_direct_two_point_line` test), so
    a caller never needs to special-case "nothing nearby" before calling
    this.

    Every keyword here defaults to `0.0`/`()` — OFF, matching
    `mivnav.features.routing.config.RoutingConfig`'s own defaults and
    `chartcore.shortest_path`'s own pyo3 defaults; a caller passing none
    of them gets today's plain-distance search exactly. `tss_indexes`/
    `fairway_indexes`/`buoyage_indexes`/`cable_indexes`/`caution_indexes`/
    `survey_indexes`
    come from `preference_indexes_for_line`/`buoyage_indexes_for_line`, not
    `hazard_indexes_for_line` — a TSS/fairway/buoyage-side/cable/caution/
    low-confidence-survey
    zone is a soft preference, not a hazard.

    `lateral_margin_radius_m` — `RoutingConfig.lateral_margin_m` itself
    (#owqqcdqe, 2026-08-10) — is NOT the `margin_m` `indexes` was already
    built with: the caller (`routes._plan_leg`) buffers `indexes` by a
    small fixed hard floor only (`routes._HARD_LATERAL_FLOOR_M`) and
    passes the user's real preferred margin here instead, as a soft pull
    with its own always-on fixed weight — see `chartcore.shortest_path`'s
    own docs for why this one has no matching `_weight` parameter.

    `turn_cost_weight` — `RoutingConfig.turn_cost_weight` — has no matching
    ring-set parameter at all, unlike every other preference here: it
    charges a per-heading-change cost DURING the search itself
    (`chartcore::routing::raster::search_grid_with_turn_cost`), not a
    zone/distance term over charted geometry, so there is nothing for it
    to intersect against."""
    t0 = time.monotonic()
    route = chartcore.shortest_path(
        a.lon,
        a.lat,
        b.lon,
        b.lat,
        indexes,
        shallow_avoidance_radius_m=shallow_avoidance_radius_m,
        shallow_avoidance_weight=shallow_avoidance_weight,
        lateral_margin_radius_m=lateral_margin_radius_m,
        tss_indexes=list(tss_indexes),
        tss_avoidance_weight=tss_avoidance_weight,
        fairway_indexes=list(fairway_indexes),
        fairway_preference_weight=fairway_preference_weight,
        buoyage_indexes=list(buoyage_indexes),
        buoyage_avoidance_weight=buoyage_avoidance_weight,
        cable_indexes=list(cable_indexes),
        cable_avoidance_weight=cable_avoidance_weight,
        caution_indexes=list(caution_indexes),
        caution_area_avoidance_weight=caution_area_avoidance_weight,
        survey_indexes=list(survey_indexes),
        low_confidence_survey_avoidance_weight=low_confidence_survey_avoidance_weight,
        turn_cost_weight=turn_cost_weight,
    )
    if timings is not None:
        detail = _route_detail(route)
        timings.record("shortest_path", t0, f"{len(indexes)} hazard indexes, {detail}")
    return route


def find_graph_route(
    a: Point,
    b: Point,
    indexes: list,
    *,
    fairway_indexes: Sequence = (),
    tss_indexes: Sequence = (),
    buoyage_indexes: Sequence = (),
    min_clearance_m: float = 0.0,
    timings: Timings | None = None,
) -> "chartcore.GraphRoute | None":
    """The SECOND routing algorithm (`RoutingConfig.algorithm == "graph"`)
    — a thin wrapper around `chartcore.graph_route`
    (`chartcore::routing::raster::graph::graph_route`), reusing the EXACT
    SAME candidate-cell-selected `indexes`/`fairway_indexes`/
    `tss_indexes`/`buoyage_indexes` `find_route`'s own raster search
    takes — a genuine apples-to-apples comparison against the same real
    hazard/preference data, only the SEARCH ALGORITHM differs.

    `None` when either endpoint is itself unsafe, or no path connects
    them within the graph search's own node/edge budget — unlike
    `find_route`, this has no partial "get as close as you can" fallback
    of its own (see `chartcore::routing::raster::graph`'s own module
    docs); the caller's existing straight-line-with-a-warning fallback is
    still the honest answer in that case."""
    t0 = time.monotonic()
    route = chartcore.graph_route(
        a.lon,
        a.lat,
        b.lon,
        b.lat,
        indexes,
        fairway_indexes=list(fairway_indexes),
        tss_indexes=list(tss_indexes),
        buoyage_indexes=list(buoyage_indexes),
        min_clearance_m=min_clearance_m,
    )
    if timings is not None:
        detail = f"{len(route.waypoints)} waypoints, {route.distance_m:.0f}m" if route else "no path"
        timings.record("graph_route", t0, f"{len(indexes)} hazard indexes, {detail}")
    return route


def find_artifact_route(
    a: Point,
    b: Point,
    cells: list,
    *,
    required_depth_m: float,
    required_air_draft_m: float = 0.0,
    lateral_margin_m: float = 0.0,
    endpoint_grace_radius_m: float = 150.0,
    catzoc_allowance_mode: str = "full",
    allow_restricted_entry: bool = False,
    tss_avoidance_weight: float = 0.0,
    fairway_preference_weight: float = 0.0,
    cable_avoidance_weight: float = 0.0,
    caution_area_avoidance_weight: float = 0.0,
    low_confidence_survey_avoidance_weight: float = 0.0,
    turn_cost_weight: float = 0.0,
    avoid_depth_below_m: float = 0.0,
    avoid_depth_weight: float = 0.0,
    soft_prefer_depth_below_m: float = 0.0,
    soft_prefer_depth_weight: float = 0.0,
    timings: Timings | None = None,
) -> "chartcore.ArtifactRoute | None":
    """The FOURTH routing algorithm (`RoutingConfig.algorithm ==
    "artifact"`) — a thin wrapper around `chartcore.artifact_route`
    (`chartcore::routing::artifact`), the same shape `find_route`/
    `find_graph_route` are for their own engines.

    Takes DECODED CELLS (`cells_for_line`), not `chartcore.HazardIndex`es
    like the other two: this algorithm re-derives chart truth itself, with
    a wider hard-constraint class list and a per-feature `CATZOC` buffer
    no `HazardIndex` carries. That is the one real structural difference
    at this seam; everything else — corridor sizing, candidate-cell
    selection, the decode LRU — is shared.

    `required_depth_m` is `draft + under_keel_margin_m` ALREADY COMBINED,
    matching `chartcore.artifact_route`'s own convention (and
    `hazard_indexes_for_line`'s `safety_depth_m`). `lateral_margin_m` is a
    HARD buffer for this algorithm, like `find_graph_route`'s own
    `margin_m` and unlike the raster search's soft `lateral_margin_
    radius_m` pull — that algorithm has a distance-graded cost model to
    layer a preference onto and this one does not.

    There is no `shallow_avoidance_*`, `buoyage_*` or beam parameter,
    deliberately: `chartcore.artifact_route` accepts none (they need
    directional/topology machinery this MVP left out — see its own docs),
    so a caller's values for them are simply not applicable here rather
    than silently dropped somewhere deeper.

    `None` when no path exists in the corridor, or when an endpoint is
    blocked and nothing navigable lies within `endpoint_grace_radius_m` of
    it. No partial "get as close as you can" fallback, same scope call
    `find_graph_route` makes — the caller's straight-line-with-a-warning
    is the honest answer there."""
    t0 = time.monotonic()
    route = chartcore.artifact_route(
        a.lon,
        a.lat,
        b.lon,
        b.lat,
        cells,
        required_depth_m,
        required_air_draft_m=required_air_draft_m,
        lateral_margin_m=lateral_margin_m,
        endpoint_grace_radius_m=endpoint_grace_radius_m,
        catzoc_allowance_mode=catzoc_allowance_mode,
        allow_restricted_entry=allow_restricted_entry,
        tss_avoidance_weight=tss_avoidance_weight,
        fairway_preference_weight=fairway_preference_weight,
        cable_avoidance_weight=cable_avoidance_weight,
        caution_area_avoidance_weight=caution_area_avoidance_weight,
        low_confidence_survey_avoidance_weight=low_confidence_survey_avoidance_weight,
        turn_cost_weight=turn_cost_weight,
        avoid_depth_m=avoid_depth_below_m,
        soft_prefer_depth_m=soft_prefer_depth_below_m,
        avoid_depth_weight=avoid_depth_weight,
        prefer_depth_weight=soft_prefer_depth_weight,
    )
    if timings is not None:
        detail = (
            f"{len(route.waypoints)} waypoints, {route.distance_m:.0f}m, "
            f"{route.cell_size_m:.0f}m/cell, {route.nodes_expanded} nodes"
            if route
            else "no path"
        )
        timings.record("artifact_route", t0, f"{len(cells)} cells, {detail}")
    return route


def find_artifact_route_debug(
    a: Point,
    b: Point,
    cells: list,
    *,
    required_depth_m: float,
    required_air_draft_m: float = 0.0,
    lateral_margin_m: float = 0.0,
    endpoint_grace_radius_m: float = 150.0,
    catzoc_allowance_mode: str = "full",
    allow_restricted_entry: bool = False,
    tss_avoidance_weight: float = 0.0,
    fairway_preference_weight: float = 0.0,
    cable_avoidance_weight: float = 0.0,
    caution_area_avoidance_weight: float = 0.0,
    low_confidence_survey_avoidance_weight: float = 0.0,
    turn_cost_weight: float = 0.0,
    avoid_depth_below_m: float = 0.0,
    avoid_depth_weight: float = 0.0,
    soft_prefer_depth_below_m: float = 0.0,
    soft_prefer_depth_weight: float = 0.0,
    timings: Timings | None = None,
) -> dict:
    """The DEBUG-ONLY bundle for one `"artifact"`/`"mivnav"` fine-search
    leg — the same shape `leg_debug_info` returns for the other engines,
    but for a search that re-derives chart truth itself so there is no
    `HazardIndex` to read rings off. Wraps `chartcore.artifact_route_debug`
    with the IDENTICAL param mapping `find_artifact_route` uses, so it
    profiles the exact search that leg ran (or failed).

    Returns (all `[lon, lat]` pairs, never this API's `{lat, lon}` shape —
    same size reasoning as `leg_debug_info`):

    * `reason` — `"ok"` / `"no_field"` / `"start_blocked"` /
      `"goal_blocked"` / `"severed"` / `"grid_too_large"`: WHICH of the
      search's failure points fired.
    * `start_snap_m`, `goal_snap_m` — how far each endpoint snapped, or
      `None` when that endpoint had no walkable cell in range.
    * `constraint_rings` — every constraint class the build produced
      (`hard`, `charted_depth`, `coverage`, `depth_avoid`, `depth_soft`,
      `unsurveyed`, `caution`, `cable`, `tss`, `preferred`, `survey`,
      `atba`, `check_manually`), each a list of rings.
    * `field` — the search grid: `cols`, `rows`, `cell_size_m`, `corners`
      (NW, NE, SE, SW `[lon, lat]`), `start_cell`/`goal_cell` `[col,
      row]`, and `codes_b64` — base64 of one byte per cell, row-major from
      the NW corner: `0` open · `1` hard · `2` unknown-blocked · `3`
      unknown-graced · `4` soft-penalised. `None` when no field was even
      built; `codes_b64` empty on a pathologically large grid."""
    t0 = time.monotonic()
    d = chartcore.artifact_route_debug(
        a.lon,
        a.lat,
        b.lon,
        b.lat,
        cells,
        required_depth_m,
        required_air_draft_m=required_air_draft_m,
        lateral_margin_m=lateral_margin_m,
        endpoint_grace_radius_m=endpoint_grace_radius_m,
        catzoc_allowance_mode=catzoc_allowance_mode,
        allow_restricted_entry=allow_restricted_entry,
        tss_avoidance_weight=tss_avoidance_weight,
        fairway_preference_weight=fairway_preference_weight,
        cable_avoidance_weight=cable_avoidance_weight,
        caution_area_avoidance_weight=caution_area_avoidance_weight,
        low_confidence_survey_avoidance_weight=low_confidence_survey_avoidance_weight,
        turn_cost_weight=turn_cost_weight,
        avoid_depth_m=avoid_depth_below_m,
        soft_prefer_depth_m=soft_prefer_depth_below_m,
        avoid_depth_weight=avoid_depth_weight,
        prefer_depth_weight=soft_prefer_depth_weight,
    )
    field = d.get("field")
    if field is not None:
        # `bytes` is not JSON — hand the raster over base64. An empty
        # `codes` (grid over the serialisation cap) stays an empty string.
        field = {
            **field,
            "codes_b64": base64.b64encode(field.pop("codes")).decode("ascii"),
        }
    out = {**d, "field": field, "from": [a.lon, a.lat], "to": [b.lon, b.lat]}
    if timings is not None:
        timings.record(
            "artifact_route_debug",
            t0,
            f"{len(cells)} cells, reason={out['reason']}",
        )
    return out


def artifact_diagnostics(route) -> dict:
    """`chartcore.ArtifactRoute`'s diagnostic-only getters as one plain
    dict, for `PlanResponse.debug_legs` — the SAME opt-in debug channel
    `leg_debug_info` already feeds (`PlanRequest.debug`), not a second one.

    Everything here is an answer to "why did this route come out like
    that": the resolution the corridor was actually searched at and the
    §4.1/§4.2 ladder figures behind it (`cell_size_m`, `ladder_cell_m`,
    `finest_allowed_cell_m`, `compilation_scale`), how far hard hazards
    were grown by the CATZOC allowance (`catzoc_horizontal_m` — the first
    number to look at when inshore water is inexplicably closed, since
    the `"full"` default buffers by a kilometre on a chart with no
    `M_QUAL`), how much of the grid that closed (`blocked_cells`,
    `unknown_cells`), and what the search itself cost
    (`nodes_expanded`, `corridor_widen_attempts`, `route_cost_mm`).
    Never part of an ordinary (non-debug) response."""
    cols, rows = route.grid_dims
    return {
        "grid_cols": cols,
        "grid_rows": rows,
        "cell_size_m": route.cell_size_m,
        "ladder_cell_m": route.ladder_cell_m,
        "finest_allowed_cell_m": route.finest_allowed_cell_m,
        "catzoc_horizontal_m": route.catzoc_horizontal_m,
        "compilation_scale": route.compilation_scale,
        "blocked_cells": route.blocked_cells,
        "unknown_cells": route.unknown_cells,
        "nodes_expanded": route.nodes_expanded,
        "corridor_widen_attempts": route.corridor_widen_attempts,
        "route_cost_mm": route.route_cost_mm,
        "start_snap_m": route.start_snap_m,
        "end_snap_m": route.end_snap_m,
    }


def find_mivnav_route(
    a: Point,
    b: Point,
    cells: list,
    *,
    required_depth_m: float,
    required_air_draft_m: float = 0.0,
    lateral_margin_m: float = 0.0,
    endpoint_grace_radius_m: float = 150.0,
    catzoc_allowance_mode: str = "full",
    allow_restricted_entry: bool = False,
    tss_avoidance_weight: float = 0.0,
    fairway_preference_weight: float = 0.0,
    cable_avoidance_weight: float = 0.0,
    caution_area_avoidance_weight: float = 0.0,
    low_confidence_survey_avoidance_weight: float = 0.0,
    turn_cost_weight: float = 0.0,
    avoid_depth_below_m: float = 0.0,
    avoid_depth_weight: float = 0.0,
    soft_prefer_depth_below_m: float = 0.0,
    soft_prefer_depth_weight: float = 0.0,
    mivnav_beam_m: float = 0.0,
    mivnav_directional_rules: bool = False,
    artifact_path: Path | None = None,
    chart_set_id: str | None = None,
    chart_set_sequence: int = 0,
    timings: Timings | None = None,
) -> "chartcore.MivnavRoute | None":
    """The FIFTH routing algorithm (`RoutingConfig.algorithm == "mivnav"`)
    — a thin wrapper around `chartcore.mivnav_route`, the same shape
    `find_artifact_route` is for `chartcore.artifact_route`. Read
    `chartcore.MivnavRoute`'s own docs (`chartcore/src/python.rs`) before
    touching this: the returned route IS an `"artifact"` result — same
    engine, same cells, same params — with `chartcore::mivnav`'s own
    precomputed-topology pipeline run ALONGSIDE it for cross-check
    diagnostics only (`mivnav_diagnostics`, below). Every parameter here
    has the exact same meaning as `find_artifact_route`'s own; this
    function exists as its own thin wrapper (rather than a boolean flag
    on that one) purely so a regression in one algorithm's own wiring
    reads as a regression in that algorithm, not the other — the same
    reasoning `find_artifact_route`'s own docstring gives for being
    separate from `find_route`/`find_graph_route`.

    `artifact_path`/`chart_set_id`/`chart_set_sequence` (all three, or
    none) point the TOPOLOGY layer at a persisted `.mivnav` instead of
    rebuilding the region from `cells` every call — the actual v3
    architecture (`mivnav.features.routing.mivnav_artifact` owns the path
    convention; `chartcore.mivnav_route`'s own docs own the semantics).
    A missing, unreadable or §19-stale artifact falls back to the rebuild
    and NAMES why on `route.topology_fallback_reason`; `route.
    topology_source` always says which of the two actually ran. The route
    ITSELF is unaffected either way — it comes from the same fine search
    over the same `cells` regardless, which is what keeps
    `test_plan_via_mivnav_matches_plan_via_artifact_byte_for_byte`
    honest.

    `mivnav_beam_m` (metres, `0` disables) turns on §8.3/§12.4's
    demote-and-refine path: a marginal-width portal on the topology route
    is re-routed against the chart's hazard geometry and the splice kept
    only if it re-verifies against the DRAFT-AWARE hard constraints. When
    a splice is kept, `route.waypoints`/`distance_m`/`approximate_legs`
    describe the refined route and `route.mivnav_refined_portals` is
    non-empty — the one case where `"mivnav"` is NOT byte-identical to
    `"artifact"`. `chartcore.MivnavRoute`'s own docs own the semantics.

    `mivnav_directional_rules` (default `False`) turns on §11's directional
    / buoyage semantics: a topology crossing taken against a charted
    traffic flow (`TSSLPT`/one-way `DWRTPT`/`RECTRC` with `ORIENT`) is
    forbidden, and a crossing on the wrong side of a lateral mark for its
    direction of travel is soft-penalised. Like `mivnav_beam_m` this can
    change which corridor the topology layer picks, so it cannot be
    silently on; unlike it, it never moves the fine-search route itself —
    only the diagnostics and (via `topology_directional_penalized_portals`)
    which crossings paid a buoyage penalty. `chartcore.mivnav_route`'s own
    docs own the semantics.

    `None` under the exact same conditions `find_artifact_route` returns
    `None` — the accept/reject decision is entirely the fine search's."""
    t0 = time.monotonic()
    route = chartcore.mivnav_route(
        a.lon,
        a.lat,
        b.lon,
        b.lat,
        cells,
        required_depth_m,
        required_air_draft_m=required_air_draft_m,
        lateral_margin_m=lateral_margin_m,
        endpoint_grace_radius_m=endpoint_grace_radius_m,
        catzoc_allowance_mode=catzoc_allowance_mode,
        allow_restricted_entry=allow_restricted_entry,
        tss_avoidance_weight=tss_avoidance_weight,
        fairway_preference_weight=fairway_preference_weight,
        cable_avoidance_weight=cable_avoidance_weight,
        caution_area_avoidance_weight=caution_area_avoidance_weight,
        low_confidence_survey_avoidance_weight=low_confidence_survey_avoidance_weight,
        turn_cost_weight=turn_cost_weight,
        avoid_depth_m=avoid_depth_below_m,
        soft_prefer_depth_m=soft_prefer_depth_below_m,
        avoid_depth_weight=avoid_depth_weight,
        prefer_depth_weight=soft_prefer_depth_weight,
        mivnav_beam_m=mivnav_beam_m,
        mivnav_directional_rules=mivnav_directional_rules,
        artifact_path=artifact_path,
        chart_set_id=chart_set_id,
        chart_set_sequence=chart_set_sequence,
    )
    if timings is not None:
        if route is None:
            detail = "no path"
        else:
            # `topology_source`/`topology_fallback_reason` go in the LIVE
            # timing line, not only the opt-in debug payload: this logger
            # writes every request to the console and to `routing.log`
            # (see this module's own logger setup), so "the artifact was
            # not used, and here is §19's reason" is visible without
            # anyone having thought to ask for debug first. That is the
            # whole point of the fallback being loud — see
            # `_plan_via_mivnav`.
            why = route.topology_fallback_reason
            # A kept refinement splice actually MOVED the route (see
            # `chartcore.MivnavRoute`), so it belongs in the live line
            # next to the source/fallback reason, same "loud by default"
            # rule.
            refined = route.mivnav_refined_portals
            refined_note = (
                f", refined {len(refined)} demoted crossing(s)" if refined else ""
            )
            # §11: a nonzero wrong-side-buoyage count belongs in the live
            # line too, same "loud by default" rule as the fallback reason.
            penalised = route.topology_directional_penalized_portals
            directional_note = (
                f", {len(penalised)} buoyage-penalised crossing(s)" if penalised else ""
            )
            # §14: the provable optimality gap of the returned fine route
            # (route_cost vs the straight-line lower bound at this
            # request's multiplier floor). Loud by default — a large gap
            # is a signal the corridor/topology layer forced a detour it
            # could not cheaply prove necessary.
            gap_note = f", gap {route.optimality_gap:.3f}"
            detail = (
                f"{len(route.waypoints)} waypoints, {route.distance_m:.0f}m, "
                f"topology {'found' if route.topology_route_found else 'not found'} "
                f"({route.topology_components} components, {route.topology_portals} portals, "
                f"from {route.topology_source}{f'; {why}' if why else ''})"
                f"{gap_note}{refined_note}{directional_note}"
            )
        timings.record("mivnav_route", t0, f"{len(cells)} cells, {detail}")
    return route


def find_mivnav_coarse_route(
    a: Point,
    b: Point,
    *,
    artifact_path: Path,
    chart_set_id: str,
    chart_set_sequence: int,
    required_depth_m: float,
    endpoint_grace_radius_m: float = 150.0,
    tss_avoidance_weight: float = 0.0,
    fairway_preference_weight: float = 0.0,
    mivnav_directional_rules: bool = False,
    timings: Timings | None = None,
) -> "chartcore.MivnavCoarseRoute | None":
    """The COARSE portal-graph guide for `a`→`b` over a persisted
    `.mivnav`, for `_plan_via_mivnav` to run a leg-by-leg fine search
    along when `find_mivnav_route`'s own fine search returned `None`
    (a detour that leaves `routing::raster`'s ±50 km straight-line
    corridor cap — round an island, a peninsula, the whole top of a
    country). A thin wrapper around `chartcore.mivnav_coarse_route`; see
    `chartcore/src/mivnav/coarse.rs` for why the hierarchical shape is
    the only answer-preserving way to use the portal graph's global
    connectivity.

    Two distinct outcomes the caller must NOT stitch, kept distinct:

    * `ValueError` (propagated) — the artifact is missing / unreadable /
      §19-stale; the caller routes a straight line and says "no usable
      .mivnav", exactly as `find_mivnav_route`'s own rebuild-and-say-why
      path does;
    * `None` — the portal graph itself has no connection at this draft;
      genuinely not reachable by navigable water, the caller says so.

    The weight / directional args mean exactly what they do on
    `find_mivnav_route`, and are threaded through for the same reason:
    this route becomes the CORRIDOR the per-leg fine search is confined
    to, so a distance-only choice could push the stitched legs through a
    soft-avoided TSS or the wrong way down a one-way channel."""
    t0 = time.monotonic()
    try:
        route = chartcore.mivnav_coarse_route(
            a.lon,
            a.lat,
            b.lon,
            b.lat,
            artifact_path,
            chart_set_id,
            chart_set_sequence,
            required_depth_m,
            endpoint_grace_radius_m=endpoint_grace_radius_m,
            tss_avoidance_weight=tss_avoidance_weight,
            fairway_preference_weight=fairway_preference_weight,
            mivnav_directional_rules=mivnav_directional_rules,
        )
    except ValueError as exc:
        if timings is not None:
            timings.record("mivnav_coarse", t0, f"no usable artifact: {exc}")
        raise
    if timings is not None:
        if route is None:
            timings.record("mivnav_coarse", t0, "no portal path at this draft")
        else:
            timings.record(
                "mivnav_coarse",
                t0,
                f"{route.hops} hops, {len(route.waypoints)} coarse waypoints, "
                f"band {route.band_m:.1f}m, {route.components} components",
            )
    return route


def mivnav_diagnostics(route, artifact_note: str | None = None) -> dict:
    """`chartcore.MivnavRoute`'s diagnostic-only getters as one plain
    dict, for `PlanResponse.debug_legs` — EVERY field `artifact_
    diagnostics` carries (this route IS an `artifact_route_lonlat`
    result, off the identical fine-search run), plus the `topology_*`
    fields that function has no equivalent of: the PRECOMPUTED-topology
    layer's own independent read on the same request (band selected, how
    many components/portals/shortcuts the region produced, whether IT
    found a path too, and — when it did — the coarse corridor box that
    path implies). An earlier version of this function carried only 3 of
    `artifact_diagnostics`' 14 fields despite its own docstring claiming
    full parity — found by code review; fixed by adding the rest rather
    than weakening the claim, since every one of them is genuinely useful
    here too (e.g. `catzoc_horizontal_m`, "the first number to look at
    when inshore water is inexplicably closed", is exactly as relevant to
    a `"mivnav"` request as an `"artifact"` one). Mostly this does not
    change the route itself — the exception is `mivnav_refined_portals`
    (see `chartcore.MivnavRoute`'s own docs): when it is non-empty a
    §12.4 refinement splice was kept and the route the caller got is the
    refined one, not the fine search's.

    `topology_source`/`topology_fallback_reason` are the newest pair and
    the ones to read first: WHICH of "loaded a persisted `.mivnav`" and
    "rebuilt the region from this request's cells" actually ran, and — if
    the artifact was skipped — §19's own named reason. `artifact_note`
    fills that reason in for the one case chartcore cannot know about,
    where the backend declined to pass an artifact at all (no chart set
    resolved, or a corridor spanning several sets — see
    `_plan_via_mivnav`); it never overwrites a reason chartcore itself
    reported."""
    cols, rows = route.grid_dims
    return {
        "grid_cols": cols,
        "grid_rows": rows,
        "cell_size_m": route.cell_size_m,
        "ladder_cell_m": route.ladder_cell_m,
        "finest_allowed_cell_m": route.finest_allowed_cell_m,
        "catzoc_horizontal_m": route.catzoc_horizontal_m,
        "compilation_scale": route.compilation_scale,
        "blocked_cells": route.blocked_cells,
        "unknown_cells": route.unknown_cells,
        "nodes_expanded": route.nodes_expanded,
        "corridor_widen_attempts": route.corridor_widen_attempts,
        "route_cost_mm": route.route_cost_mm,
        "start_snap_m": route.start_snap_m,
        "end_snap_m": route.end_snap_m,
        "topology_band_m": route.topology_band_m,
        "topology_components": route.topology_components,
        "topology_portals": route.topology_portals,
        "topology_shortcuts": route.topology_shortcuts,
        "topology_route_found": route.topology_route_found,
        "topology_hops": route.topology_hops,
        "topology_cost_mm": route.topology_cost_mm,
        # §14: how close to optimal the returned FINE route provably is.
        # `best_known_lower_bound_mm` is the straight-line great-circle
        # distance at this request's effective multiplier floor;
        # `optimality_gap` = (route_cost - lb) / lb, an UPPER bound on the
        # true gap (the denominator is itself only a lower bound), so
        # "0.03" means the route is provably within ~3% of optimal — it
        # may be closer. `topology_lower_bound_mm` is the ALT landmark
        # bound on the TOPOLOGY cost (0 without a built artifact) and is
        # NOT comparable to `route_cost_mm`.
        "best_known_lower_bound_mm": route.best_known_lower_bound_mm,
        "optimality_gap": route.optimality_gap,
        "topology_lower_bound_mm": route.topology_lower_bound_mm,
        "verification_status": route.verification_status,
        "topology_corridor_bbox": route.topology_corridor_bbox,
        "topology_source": route.topology_source,
        "topology_fallback_reason": route.topology_fallback_reason or artifact_note,
        # §8.3/§12.4: which crossings were width-demoted, and which of
        # those the local vector refinement actually re-routed (a kept
        # splice — the route the caller got is the refined one). Both
        # empty unless `mivnav_beam_m > 0`.
        "topology_demoted_portals": route.topology_demoted_portals,
        "mivnav_refined_portals": route.mivnav_refined_portals,
        # §11: route crossings that paid a wrong-side lateral-mark penalty
        # for their direction of travel. Empty unless
        # `mivnav_directional_rules` was set. (Against-flow crossings are
        # forbidden outright, so they never appear on a route.)
        "topology_directional_penalized_portals": (
            route.topology_directional_penalized_portals
        ),
    }


#: Metres, the flat box (NOT chartcore's own scaled-by-distance corridor
#: pad — see `_bbox_around`) a macro-route pass searches around `from`/
#: `to`. Landmass-scale, not ocean-scale: enough to reach a real detour
#: like the Limfjord's own ~150nm-off-the-direct-line case, but bounded so
#: the macro grid (`_MACRO_MAX_DIM`, below) stays cheap. A caller wanting
#: to route to a different country entirely still gets today's honest
#: "routed as close as possible" fallback, not a false promise this pass
#: covers arbitrary distance.
_MACRO_BOX_PAD_M = 250_000.0
#: Metres per macro grid cell — coarse by design (the ordinary per-leg
#: search, re-run along whatever this finds, is what actually needs fine
#: resolution). See `chartcore::routing::raster::macro_route`'s own docs
#: for why a coarser cell here costs nothing a normal request would ever
#: pay: this pass only runs as a rare fallback.
_MACRO_CELL_SIZE_M = 300.0
#: Grid-dimension cap for the macro pass — `chartcore::routing::raster
#: ::size_grid_explicit` re-derives a coarser cell size rather than
#: exceed this, the same "never silently blow the cell budget" rule the
#: ordinary search's own `HARD_MAX_DIM` follows.
_MACRO_MAX_DIM = 800
#: Prefer chart cells at this scale or coarser (1:200,000 or up — a
#: genuine OVERVIEW chart, not a harbour or coastal one) for the macro
#: land pass: fewer, cheaper-to-decode cells that already answer "roughly
#: where is the land" at the resolution this pass actually uses. Falls
#: back to whatever is installed when nothing meets it (see
#: `land_indexes_for_macro_route`) — a set with no true overview chart
#: still gets an (more expensive, but correct) answer, not a silent gap.
#:
#: ALSO the dividing line `hazard_indexes_for_bbox`'s own land floor uses
#: to decide which candidates are detailed enough to trust unconditionally
#: — see that function's own docs' "The land floor" section for the real
#: bug this second use closes (#owqqcdqe-land-floor, found live: a real
#: 1:1,500,000 Denmark-wide overview chart, which generalizes away small
#: features like a marina notch by design, was making that notch
#: permanently unreachable everywhere the overview happened to cover —
#: which is EVERYWHERE, since an overview chart's whole point is covering
#: a huge area). One threshold, one meaning either way it's asked: is this
#: chart detailed enough to be trusted on its own for a LOCAL navigability
#: question, or is it only ever "roughly where the land is" at a glance.
_MACRO_OVERVIEW_SCALE_MIN = 200_000
#: Hard cap on how many cells the macro land pass decodes, regardless of
#: how many candidates a huge `_MACRO_BOX_PAD_M` box turns up — bounds
#: decode cost on a densely-charted region the same way `_MACRO_MAX_DIM`
#: bounds the grid itself.
_MACRO_MAX_CELLS = 40
#: Nautical miles. The dividing line `needs_macro_route` uses between "a
#: resolution miss the ordinary search's own per-leg refinement
#: (`chartcore::routing::raster::refine_flagged_legs`) can fix" and "a
#: genuinely out-of-corridor gap only a macro-scale detour could ever
#: close" — for a run touching the route's own START or END only.
#: Refinement already converges any FIXABLE run down to a short, tight
#: stub; a run that stays this long after it is not a resolution problem.
#: A MIDROUTE run needs no such threshold at all — `needs_macro_route`'s
#: own docs have the real bug that distinction closes (a short direct gap
#: is no evidence the real detour around it is short too). Not user-
#: configurable (an implementation-scale internal threshold, not a safety
#: setting) — `RoutingConfig.macro_route_enabled` is the on/off switch a
#: caller actually needs.
_MACRO_TRIGGER_NM = 3.0


def _macro_bbox(a: Point, b: Point, box_pad_m: float) -> tuple[float, float, float, float]:
    """(w, s, e, n) degrees for the macro pass's OWN much larger box — a
    flat metre pad around both `a` and `b`, unlike `_bbox_around`
    (chartcore's per-request corridor, capped far tighter — see
    `CORRIDOR_PAD_CAP_M`): a landmass-scale detour has no reason to scale
    with how far apart `a`/`b` already are."""
    lat_pad = box_pad_m / 111_320.0
    cos_lat = min(math.cos(math.radians(a.lat)), math.cos(math.radians(b.lat)))
    lon_pad = box_pad_m / (111_320.0 * max(cos_lat, 1e-6))
    w = min(a.lon, b.lon) - lon_pad
    e = max(a.lon, b.lon) + lon_pad
    s = min(a.lat, b.lat) - lat_pad
    n = max(a.lat, b.lat) + lat_pad
    return (w, s, e, n)


def land_indexes_for_macro_route(
    ocharts, a: Point, b: Point, timings: Timings | None = None
) -> list:
    """The `chartcore.HazardIndex` of every candidate cell over the
    macro pass's own much larger box (`_macro_bbox`), built LAND-ONLY —
    `ocharts.hazard_index(cs, cell, 0.0, 0.0)`, the same call
    `hazard_indexes_for_line` makes with a real draft/margin, but at
    `safety_depth_m=margin_m=0.0` and `air_draft_m` left at its own
    default (`0.0`, off) so only LNDARE (plus anything charted
    always-dry) contributes: draft, margin, and air draft are questions
    for the FINE per-leg re-search along whatever this macro pass finds,
    not this coarse "where is the land" one — the standing macro-route
    warning already tells the caller bridge/lock/cable clearance along a
    macro detour is checked only by that per-leg re-search, never by this
    pass. Hits the SAME `ocharts.hazard_index` LRU as every other caller —
    a `(cell, 0.0, 0.0, 0.0)` key of its own, never colliding with or
    evicting a real-draft entry.

    Prefers coarse/overview-scale cells (`_MACRO_OVERVIEW_SCALE_MIN`) —
    fewer, cheaper to decode, and exactly the resolution this pass's own
    grid (`_MACRO_CELL_SIZE_M`) uses — falling back to whatever candidates
    exist when none meet that threshold (a set with no true overview
    chart still gets an answer). Bounded to `_MACRO_MAX_CELLS` regardless,
    coarsest first, so a densely-charted region can't blow decode cost."""
    t0 = time.monotonic()
    candidates = _candidate_cells(ocharts, _macro_bbox(a, b, _MACRO_BOX_PAD_M))
    coarse = [pair for pair in candidates if pair[1].scale >= _MACRO_OVERVIEW_SCALE_MIN]
    chosen = sorted(coarse or candidates, key=lambda pair: -pair[1].scale)[:_MACRO_MAX_CELLS]
    if timings is not None:
        timings.record(
            "macro_candidate_cells", t0, f"{len(candidates)} candidates, {len(chosen)} used"
        )

    indexes = []
    for cs, cell in chosen:
        t1 = time.monotonic()
        try:
            idx = ocharts.hazard_index(cs, cell, 0.0, 0.0)
        except Exception:
            log.warning(
                "routing: cell %s unusable for the macro land pass", cell.path.name, exc_info=True
            )
            continue
        if timings is not None:
            timings.record(
                f"macro_land[{cell.path.name}]",
                t1,
                f"{idx.ring_count} rings" if idx is not None else "no land here",
            )
        if idx is not None:
            indexes.append(idx)
    return indexes


def natural_earth_land_rings(bbox: tuple[float, float, float, float]) -> list[list[tuple[float, float]]]:
    """Land polygon EXTERIOR rings (``[(lon, lat), ...]``) for every
    bundled Natural Earth Admin-0 country whose own bbox reaches
    ``bbox`` — the macro pass's land truth OUTSIDE any installed chart's
    own coverage.

    **Why this exists, found live, not hypothetical**: a real macro
    request wandered past the edge of the boat's installed o-charts set
    (``land_indexes_for_macro_route`` above found NOTHING there — no
    chart, no candidate cells, no hazard rings) and the macro pass, given
    no land data for that stretch at all, read the total absence as open
    water: it drew a real waypoint chain straight across tens of
    kilometres of dry, populated land (Denmark/Germany border country)
    with nothing to catch it. A chart gap is not evidence of water.

    ``mivnav.geo.countries`` (Natural Earth Admin-0, 1:50m — already
    bundled for ``Region.country`` resolution, no new dependency, no
    network, ~250 countries loaded and cached in well under 100ms) is
    global: unlike an installed chart set, it has no coverage gap to
    fall silently through. Cheap enough to pass on every macro attempt —
    ``country_bbox`` is an in-memory bbox walk, not a decode.

    Exterior ring ONLY (``polygon[0]``, dropping any hole rings) per
    polygon — see ``chartcore.macro_route``'s own docs for why: a lone,
    unpaired ring's interior is exact under nonzero-winding fill
    regardless of which way it winds, so this never risks an inverted
    (open ↔ closed) hole-pairing bug, at the bounded, minor cost of
    treating a country's own large lakes as land too.

    Filtered PER POLYGON, not per country (``country_bbox`` deliberately
    unused here): a country's own aggregate bbox is a naive min/max walk
    across every one of its polygons, including remote territories on the
    other side of the planet — for a country whose territory straddles
    the antimeridian (New Zealand's Pacific islands, found live while
    testing this: a naive aggregate bbox came back `(-176.8, ..., 178.5,
    ...)`, matching almost ANY longitude on Earth), that single bad bbox
    would poison candidate selection everywhere, not just near that
    country. A single polygon's own exterior ring bbox is far less prone
    to this (real geography, not a whole nation's scattered territories
    collapsed into one box) — cheap enough to compute on the fly (~100k
    points total across every bundled country, ~40ms, and this only ever
    runs on the rare macro-pass fallback, not every request)."""
    w, s, e, n = bbox
    rings: list[list[tuple[float, float]]] = []
    for iso, _name in list_countries():
        for polygon in country_polygon(iso):
            if not polygon:
                continue
            exterior = polygon[0]
            if not exterior:
                continue
            lons = [pt[0] for pt in exterior]
            lats = [pt[1] for pt in exterior]
            ring_bbox = (min(lons), min(lats), max(lons), max(lats))
            if _extents_intersect(ring_bbox, (w, s, e, n)):
                rings.append(exterior)
    return rings


def find_macro_detour(
    a: Point, b: Point, land_indexes: list, timings: Timings | None = None
) -> list[tuple[float, float]] | None:
    """A coarse `[(lon, lat), ...]` waypoint chain from `a` to `b` over
    the macro pass's own much larger area (`chartcore.macro_route`) — a
    GUIDE for `_stitch_macro_route` (routes.py) to re-run the real,
    per-leg search along, not a route to sail as returned. `None` when no
    macro-scale path exists either — the caller's existing straight-
    line-with-a-warning fallback stays the honest answer.

    Always supplements `land_indexes` with `natural_earth_land_rings`
    over this SAME call's own macro box (`_macro_bbox`, one source of
    truth with `land_indexes_for_macro_route`'s own candidate-cell
    selection) — see that function's own docs for why a chart gap must
    never silently read as open water."""
    t0 = time.monotonic()
    extra_rings = natural_earth_land_rings(_macro_bbox(a, b, _MACRO_BOX_PAD_M))
    waypoints = chartcore.macro_route(
        a.lon,
        a.lat,
        b.lon,
        b.lat,
        land_indexes,
        extra_land_rings=extra_rings,
        box_pad_m=_MACRO_BOX_PAD_M,
        cell_size_m=_MACRO_CELL_SIZE_M,
        max_dim=_MACRO_MAX_DIM,
    )
    if timings is not None:
        detail = f"{len(waypoints)} waypoints" if waypoints else "no path"
        timings.record(
            "macro_route",
            t0,
            f"{len(land_indexes)} land indexes, {len(extra_rings)} NE rings, {detail}",
        )
    return waypoints


def flagged_run_index_spans(legs: list[bool]) -> list[tuple[int, int]]:
    """Every contiguous run of `True` in `legs` as `[i, j)` WAYPOINT-index
    spans (`legs[i:j]` are the flagged legs; `waypoints[i]`/`waypoints[j]`
    are the run's own two endpoints), in order. The one piece of "walk
    `approximate_legs`, group into runs" logic `flagged_run_spans_nm`
    (below, nm-length per run) and `routes.py`'s own per-run reason-
    building — `_approximate_warnings` (the `/plan` endpoint) and
    `_verify_reasons` (the standalone `/verify` route-safety-check
    endpoint) — all need identically, extracted so the three stop being
    three independently-maintained copies of the same walk. Neither
    endpoint's own reason TEXT lives here — a searched route's runs and a
    user-drawn route's runs mean different things (see `_verify_reasons`'
    own docs for why `/verify` deliberately does not reuse `/plan`'s
    wording) — only the run-finding itself is shared."""
    n = len(legs)
    spans: list[tuple[int, int]] = []
    i = 0
    while i < n:
        if not legs[i]:
            i += 1
            continue
        j = i
        while j < n and legs[j]:
            j += 1
        spans.append((i, j))
        i = j
    return spans


def flagged_run_spans_nm(route) -> list[float]:
    """The great-circle span (nm) of every contiguous run of `True` in
    `route.approximate_legs` — one entry per run, in route order. Shared
    by `needs_macro_route` (below) and `routes.py`'s own "did the detour
    actually help" comparison after a macro attempt, so the two use
    exactly the same notion of "how big is this gap"."""
    spans: list[float] = []
    for i, j in flagged_run_index_spans(route.approximate_legs):
        lon0, lat0 = route.waypoints[i]
        lon1, lat1 = route.waypoints[j]
        spans.append(haversine_m(Point(lat0, lon0), Point(lat1, lon1)) / 1852.0)
    return spans


def needs_macro_route(route, threshold_nm: float = _MACRO_TRIGGER_NM) -> bool:
    """Is `route` badly enough unreachable that only a MACRO-scale detour
    could plausibly fix it, rather than the per-leg refinement
    `chartcore.shortest_path` already tries first?

    TWO independent triggers, not one:

    * ANY run in the MIDDLE of the route (`flagged_run_index_spans`' own
      `i != 0 and j != n` — the same test `_midroute_reason` uses)
      unconditionally needs a real detour attempt, regardless of how
      SHORT its own straight-line span is. Found live, a real narrow
      isthmus between two bays: the direct gap across the neck of land
      was well under `threshold_nm`, so this never used to trigger — but
      the real water route around it is long, because the land it
      crosses is the tip of a peninsula, not a straight-line-sized
      obstacle. A short DIRECT gap is no evidence the DETOUR is short —
      those are two different distances, and only `find_macro_detour`
      actually knows the second one. A start/end run gets no such
      exemption from `threshold_nm` below: that run is the user's own
      requested endpoint being unreachable, which the "routed as close as
      possible, then a straight line for the rest" fallback is a
      legitimate, honest answer for (the user asked to go exactly there)
      — a MIDROUTE run crossing charted land is never a legitimate answer
      to anything the user asked for, only a resolution gap this router
      owes a real attempt to close.
    * A run touching the start or end whose OWN straight-line span
      exceeds `threshold_nm` — see that constant's own docs for why that
      dividing line is meaningful there."""
    legs = route.approximate_legs
    n = len(legs)
    for (i, j), span in zip(flagged_run_index_spans(legs), flagged_run_spans_nm(route), strict=True):
        if i != 0 and j != n:
            return True
        if span > threshold_nm:
            return True
    return False


@dataclass
class StitchedRoute:
    """A `chartcore.RoutePath`-SHAPED result assembled in Python from
    several real per-leg searches along a macro-route guide
    (`_stitch_macro_route`, routes.py) — `chartcore.RoutePath` itself is a
    frozen pyo3 class with no Python-side constructor, so this is what
    `plan_route` actually returns from that path. Duck-types exactly the
    three attributes `plan_route`/`_approximate_warnings` read off a real
    `RoutePath` (`.waypoints`, `.distance_m`, `.approximate_legs`) and
    nothing else — this is never passed to `_route_detail` (which reads
    the RAW-search-only diagnostics fields no stitched result has)."""

    waypoints: list[tuple[float, float]] = field(default_factory=list)
    distance_m: float = 0.0
    approximate_legs: list[bool] = field(default_factory=list)
    #: One `leg_debug_info` dict per macro-stitched sub-leg, in order —
    #: only ever populated when the caller asked for debug info
    #: (`_stitch_macro_route`'s own `collect_debug`); `[]` otherwise, same
    #: "cheap, but still not free, so gate it" posture `Timings` itself
    #: doesn't need (that one really is unconditional — see its own
    #: docstring) because THIS payload can run to tens of thousands of
    #: ring points per leg (`leg_debug_info`'s own docs).
    leg_debugs: list[dict] = field(default_factory=list)
    #: Same shape/order as `approximate_legs` — `True` where the exact
    #: per-leg re-check flagged that leg for a human (openable bridge the
    #: boat can't clear closed, UNSARE water, …). `_stitch_mivnav_coarse_
    #: route` accumulates each `find_artifact_route` leg's own
    #: `check_manually_legs` here so a coarse-stitched detour carries the
    #: same safety signal every other `plan_route` path does; the
    #: `_stitch_macro_route` path leaves it `[]` (that path gets its
    #: manual-check flags from the whole-chain `chartcore.verify_route`
    #: post-pass instead).
    check_manually_legs: list[bool] = field(default_factory=list)
    #: Endpoint snap-distance warnings (`_artifact_snap_reason`), when the
    #: first leg's start or the last leg's destination snapped farther
    #: than a grid cell — the coarse path's equivalent of the parity
    #: `_plan_via_mivnav` gives a normal route. `[]` from
    #: `_stitch_macro_route`.
    endpoint_warnings: list[str] = field(default_factory=list)


def _route_detail(route: "chartcore.RoutePath | None") -> str:
    """The `shortest_path` `Timings` step's own detail string — grid
    dimensions, cell size, blocked-cell count, A* nodes expanded, and
    widen-retry attempts, all near-free byproducts `chartcore`'s search
    already computes (`RouteDiagnostics`, `chartcore/src/routing/raster.rs`),
    folded into the EXISTING step rather than a new one so
    `test_plan_returns_a_step_by_step_breakdown_when_debug_is_set`'s
    step-list assertions stay unchanged. This is what makes a slow or
    hanging request diagnosable from `routing.log` alone after the fact —
    the whole point of the persisted file handler above — without needing
    to reproduce it live against a running server again."""
    if route is None:
        return "no path"
    if route.used_direct_line:
        return f"{len(route.waypoints)} waypoints, direct line"
    cols, rows = route.grid_dims
    return (
        f"{len(route.waypoints)} waypoints, {cols}x{rows} grid @ {route.cell_size_m:.0f}m, "
        f"{route.blocked_cells} blocked, {route.nodes_expanded} nodes, "
        f"{route.corridor_widen_attempts} widen(s)"
    )
