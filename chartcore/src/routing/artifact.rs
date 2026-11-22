// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! The `"artifact"` routing algorithm — a from-scratch implementation of
//! `mivnav_routing_architecture_v3.md`'s hard-constraint model,
//! determinism rules and resolution policy.
//!
//! This is the FOURTH entry in `routing.algorithm`, alongside `"raster"`,
//! `"routeiq"` and `"graph"` — not a replacement for any of them. It
//! shares no code path with `routing::raster`'s search: that algorithm is
//! a mature, heavily live-bug-fixed per-request float-cost A\*, and this
//! one deliberately re-derives the same territory from v3's own model so
//! the two can be compared on a real boat rather than argued about. What
//! it DOES reuse, unmodified, is `routing::hazards`' geometry plumbing
//! (`finish_union`, the buffering helpers, the exact ring-containment
//! primitives) and `routing::raster::verify_route_legs`, the exact
//! per-leg verifier — see "Verification" below.
//!
//! # What this algorithm does that the others do not
//!
//! 1. **§3.3's expanded hard-constraint set.** `PONTON`, `FLODOC`,
//!    `HULKES`, `DAMCON`, `DYKCON`, `CAUSWY`, `PILPNT`, `MORFAC`,
//!    `GATCON` all block; `LOKBSN` explicitly does not; `SOUNDG` is read
//!    for hazard purposes for the first time in this crate; `PIPOHD` and
//!    `CONVYR` join the overhead-clearance set; `RESARE` `RESTRN=8` is
//!    implemented at all; `MARCUL`/`FSHFAC` block by default; absent
//!    `M_COVR` coverage BLOCKS (grace-eligible, see §9.3 below). `UNSARE`
//!    (unsurveyed area) NO LONGER blocks — a user decision: it is
//!    governed by its own charted depth via the §6 tiers below, and only
//!    feeds the optional `low_confidence_survey_avoidance_weight` and the
//!    `check_manually` flag. See [`constraints`].
//! 7. **§6 charted-depth SOFT tiers.** Beyond the `required_depth_m` hard
//!    floor, water charted in `(required, avoid_depth_m]` costs a heavy
//!    `avoid_depth_weight` and water in `(avoid_depth_m,
//!    soft_prefer_depth_m]` a light `prefer_depth_weight` — a
//!    "prefer deeper" preference on charted depth VALUE, not on distance
//!    from a hazard edge (`raster`'s `shallow_avoidance` is the latter).
//!    `0.0` thresholds disable it, byte-identical to before.
//! 2. **§3.4's CATZOC allowance as real geometry and a real depth
//!    subtraction**, not a soft cost — every hard-blocking feature is
//!    buffered by its own `M_QUAL` zone's horizontal figure, and every
//!    depth comparison happens after the zone's depth allowance is taken
//!    off the charted value. See [`catzoc`].
//! 3. **§9.3 endpoint grace** — the first and last legs may cross
//!    UNKNOWN water (unsurveyed / uncharted) within a radius of the
//!    REQUESTED endpoints, and only unknown water: never land, never a
//!    construction feature, never a depth or hazard block. A blocked
//!    endpoint snaps to the nearest navigable cell within the same
//!    radius and the snap distance is reported.
//! 4. **§13 determinism** — integer millimetre-equivalent costs, a
//!    `(f, h, cell_id)` total order on the open set, canonical endpoint
//!    snapping, and canonical endpoint ORDERING so `route(A→B)` is the
//!    reverse of `route(B→A)` by construction rather than by luck.
//! 5. **§4.1/§4.2's resolution ladder** driving corridor grid sizing from
//!    the chart's own compilation scale and CATZOC grade, replacing the
//!    existing algorithm's fixed 6m..120m heuristic. See [`ladder`].
//! 6. **§12.3's cost-integrating line of sight** — the only LOS primitive
//!    in this module returns an integrated cost or nothing; there is no
//!    passability-only variant to reach for by mistake. See [`search`].
//!
//! # Verification (§16) — reused, not reimplemented
//!
//! Every returned route is re-checked leg by leg against the exact
//! hard-constraint ring geometry by
//! `routing::raster::verify_route_legs` — the SAME function
//! `chartcore.verify_route` and the backend's `POST /routing/verify`
//! already call. It is algorithm-agnostic in fact and not only in
//! intention: it takes `(waypoints, hazard_rings)` and re-derives
//! everything else, with no reference to how the waypoints were produced.
//! Confirmed by reading it, not assumed.
//!
//! Its verdict lands in [`ArtifactRoute::approximate_legs`], keeping that
//! field's existing meaning across all four algorithms ("this leg is not
//! an exactly-verified result"). Legs that used §9.3 grace land in
//! [`ArtifactRoute::check_manually_legs`] instead, whose existing meaning
//! — "crosses `UNSARE` water, or an openable bridge; needs a human's own
//! judgement, never a reason the route was shaped or refused" — is
//! exactly what a graced leg is. No third parallel array is introduced.
//!
//! # Deliberately OUT of scope (v3 section → why)
//!
//! * **§15 the `.mivnav` artifact**, §20's build pipeline, §25 decision
//!   #5's ingest wiring. Everything here is computed fresh per request
//!   from decoded cells. The algorithm is NAMED for the artifact model it
//!   implements the semantics of; it does not build one.
//! * **§4's precomputed resolution ladder.** The §4.1 formula and the
//!   §4.2 rung set are implemented ([`ladder`]) and drive the corridor's
//!   own uniform resolution; per-tile variation, §4.3's refinement
//!   triggers and §4.2's boundary-cell stitching table all need the
//!   artifact.
//! * **§7.1/§7.2 depth bands and per-band topology**, and **§8's
//!   navigation topology** in its entirety — connected components,
//!   portals, capacity bounds, corridor contraction. Consequently §13.1's
//!   "quantised feasibility via the band ladder" and "deterministic
//!   corridor selection by portal ID" rules have nothing to attach to and
//!   are not implemented; §13.1's "bidirectional simplification" is also
//!   not implemented (canonical endpoint ordering makes it redundant for
//!   the reversal property it exists to protect).
//! * **§7.3's corridor-local clearance distance transform**, and with it
//!   §10.3's Clearance layer and §8.3's width-derived refinement
//!   triggers. This algorithm has no beam/clearance term at all; the
//!   `raster` and `graph` algorithms do.
//! * **§12.4 local vector refinement.** `routing::raster`'s
//!   refine-and-bisect pattern is the analogous mechanism and is not
//!   ported here — a flagged leg comes back flagged rather than
//!   re-searched at finer resolution.
//! * **§11 directional semantics**: TSS direction, one-way channels,
//!   lock and opening-bridge scheduling, buoyage side. `GATCON` and
//!   `BRIDGE` are plain hard-or-flagged here, never modelled transitions.
//! * **§14's `optimality_gap` / `best_known_lower_bound` /
//!   `PROVEN_WITHIN_TOLERANCE`** — there is no lower-bound or landmark
//!   machinery without the topology layer, so the response claims
//!   nothing about optimality rather than claiming it badly.
//! * **§3.2 authority resolution — done, in two stages.** `mivnav::
//!   authority::region_authority` (`mivnav::build_region`'s own §3.2
//!   pass, reused rather than reimplemented, so the router and the tile
//!   the mariner is looking at can never disagree about which chart is
//!   in charge of a stretch of water) drops a whole candidate cell a
//!   finer cell in the same query already charts in full over the
//!   corridor's own extent, before [`constraints::build_ring_clipped`]
//!   ever sees it (`authority_filtered`). What's left is then
//!   PER-RING-clipped, same shape as `raster`'s own `clip_to_authority`:
//!   a cell that is authoritative for only PART of the corridor keeps
//!   its full contribution there — it is not redundant, so the first
//!   pass rightly keeps it whole — but a strictly finer cell's own real
//!   coverage still silences its hazard-defining rings wherever that
//!   finer cell demonstrably charts the ground
//!   (`constraints::build_ring_clipped`'s own docs). Two real live
//!   findings drove this, in order: a DK-wide overview cell pulled into
//!   a long coarse-stitch leg's own candidate slice was inflating
//!   `catzoc_horizontal_m` (§4.1's ladder floor, the COARSEST figure
//!   over every cell consulted) and contributing its own generalised
//!   coastline — a SHORT leg to the exact same point never pulled that
//!   cell in at all, so it was walkable from one leg's own search and
//!   `goal_blocked` from another's (fixed by the whole-cell drop); then
//!   a real Nordby-narrows portal point STAYED `goal_blocked` after
//!   that fix landed, because the polluting coarse cell also charted
//!   real, unique ground elsewhere in the same corridor — not redundant
//!   by the whole-cell test, so kept whole, and still wrong exactly at
//!   the portal (closed by the per-ring pass). Still not here: the
//!   CATZOC/scale scalars' own "worst figure over whatever slice
//!   `cells_for_line` handed in" reach — the corridor's own extent
//!   bounds that but does not eliminate it, and it is §4.1's own
//!   deliberate "do not out-resolve the survey" conservatism, not a bug
//!   of the same shape as the two above.

pub mod catzoc;
// `constraints`, `cost` and `search` are `pub(crate)`, not private: the
// persisted artifact (`crate::mivnav`, a SIBLING of `routing` — not a
// descendant of this module) reuses `constraints::build`'s §3.3/§3.4
// chart-truth pass, `search`'s shared §4.4 supercover walk, and `cost`'s
// mm-fixed-point rounding/admissibility contract (`heuristic_mm`,
// `step_cost_mm`, `MIN_MULTIPLIER`) rather than growing a second copy of
// any of them — `mivnav::shortcuts` is the first consumer of `cost` from
// outside this tree. Nothing outside the crate can see them.
pub(crate) mod constraints;
pub(crate) mod cost;
pub mod ladder;
pub(crate) mod search;

pub use catzoc::CatzocMode;
pub use constraints::{build as build_constraints, ArtifactConstraints, ConstraintParams};

use crate::coords::{Extent, WorldXy};
use crate::mivnav::authority::{cell_descs, region_authority, RegionCell};
use crate::model::Cell;

/// Drop every `cells` entry that a strictly finer entry, ALSO in `cells`,
/// already charts in full over their own combined extent — §3.2's "finest
/// cell wins", at the whole-cell grain, run over exactly the candidate
/// slice one query handed in. See this module's own "What this algorithm
/// does" docs for why (a coarse overview cell silently polluting one
/// leg's hazard union and `catzoc_horizontal_m` ladder floor, reproduced
/// live) and `mivnav::authority::region_authority`'s own docs for the
/// mechanism — the SAME pass `mivnav::build_region`'s whole-region bake
/// already runs, reused rather than reimplemented so a router decision
/// can never disagree with what the tile server draws for the same
/// ground.
///
/// A no-op below 2 cells (nothing CAN be redundant against itself), and
/// the common case above it too — most per-leg candidate slices are
/// already all-one-authority. `kept` is sorted back to `cells`' own
/// relative order first: [`constraints::build`]'s only order-sensitive
/// step (the first-match `M_QUAL` zone lookup) must see a stable input
/// order regardless of what order `region_authority` happens to return
/// indices in.
fn authority_filtered<'a>(cells: &[&'a Cell]) -> Vec<&'a Cell> {
    if cells.len() < 2 {
        return cells.to_vec();
    }
    let mut extent = Extent::invalid();
    for c in cells.iter().copied() {
        extent.extend(&c.extent);
    }
    let region_cells: Vec<RegionCell> = cells.iter().copied().map(RegionCell::from_cell).collect();
    let descs = cell_descs(&region_cells);
    let candidate_idx: Vec<usize> = (0..cells.len()).collect();
    let (mut kept, _redundant) = region_authority(&descs, &candidate_idx, extent);
    kept.sort_unstable();
    kept.into_iter().map(|i| cells[i]).collect()
}

/// [`constraints::build`], preceded by [`authority_filtered`] — every
/// direct query-time caller (`artifact_route`, `artifact_debug_lonlat`)
/// wants both together; `mivnav::build_region`'s own bake does not (it
/// runs `region_authority` itself, over each quadtree node's own extent,
/// and hands `constraints::build` an already-filtered slice — this would
/// just needlessly re-run the same pass a second time at a different
/// extent).
pub(crate) fn build_query_constraints(
    cells: &[&Cell],
    params: &ConstraintParams,
) -> ArtifactConstraints {
    let filtered = authority_filtered(cells);
    // Whole-cell drop first (`authority_filtered`), then the per-ring
    // clip of what survives (`build_ring_clipped`): without the second, a
    // coarse cell that is only PARTLY redundant lays its generalised
    // coastline over the finer charts in full — measured live: the whole
    // Copenhagen approach and every German estuary hard-blocked by
    // overview-scale LNDARE. Was unwired once for a CPU/RAM blow-up on
    // the DK set; `build_ring_clipped` now skips the coverage union for
    // cells nothing later can be clipped by and bbox-gates every
    // difference (see its docs).
    constraints::build_ring_clipped(&filtered, params)
}

/// The shared soft-cost dials, straight off `RoutingConfig` — this
/// algorithm adds none of its own (v3 §10.3's own starting constants are
/// internal defaults inside [`search`] where no existing knob covers a
/// layer, never new user-facing fields).
///
/// Absent from this list, and absent from the algorithm: the shallow-water
/// / lateral-clearance distance-graded terms, which need §7.3's
/// corridor-local distance transform (out of scope), and the buoyage
/// term, which is directional (§11, out of scope).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ArtifactWeights {
    pub tss_avoidance_weight: f64,
    pub fairway_preference_weight: f64,
    pub cable_avoidance_weight: f64,
    pub caution_area_avoidance_weight: f64,
    pub low_confidence_survey_avoidance_weight: f64,
    pub turn_cost_weight: f64,
    /// Added to a cell's multiplier when it is charted between
    /// `ConstraintParams::required_depth_m` and `avoid_depth_m` — a HEAVY
    /// "only if there's no way around" cost, not a block
    /// ([`ArtifactConstraints::depth_avoid`]).
    pub avoid_depth_weight: f64,
    /// Added when a cell is charted between `avoid_depth_m` and
    /// `soft_prefer_depth_m` — a LIGHT "prefer deeper" nudge
    /// ([`ArtifactConstraints::depth_soft`]).
    pub prefer_depth_weight: f64,
}

/// Everything one query needs: the vessel thresholds (all pre-existing
/// `RoutingConfig` fields) plus the three `artifact_*` options.
#[derive(Debug, Clone, Copy)]
pub struct ArtifactParams {
    /// `draft + under_keel_margin_m`, already combined by the caller —
    /// the same convention `routing::hazards`' `safety_depth_m` uses.
    /// Water charted shallower than this is a HARD block.
    pub required_depth_m: f64,
    /// §6 charted-depth SOFT tiers. Water in `(required_depth_m,
    /// avoid_depth_m]` costs `ArtifactWeights::avoid_depth_weight` extra;
    /// water in `(avoid_depth_m, soft_prefer_depth_m]` costs
    /// `prefer_depth_weight`. `0.0` (or `<= required_depth_m`) disables a
    /// tier — every pre-existing caller passes `0.0` and is unchanged.
    pub avoid_depth_m: f64,
    pub soft_prefer_depth_m: f64,
    /// Mast height above the waterline. `0.0` = OFF (no overhead check at
    /// all), mirroring `routing::hazards`' own air-draft gate and its
    /// reasoning about why there is no safe nonzero default.
    pub required_air_draft_m: f64,
    /// A hard clearance buffered onto every hard-blocking feature, on top
    /// of the CATZOC figure. Unlike the `raster` algorithm — where the
    /// lateral margin is deliberately a SOFT preference after a live user
    /// decision ("i would rather a smaller margin than go over land") —
    /// this algorithm treats it as hard, consistent with its own
    /// strict-by-construction premise. Callers that want the soft
    /// behaviour should pass `0.0` here and use `raster`.
    pub lateral_margin_m: f64,
    /// §9.3, `artifact_endpoint_grace_radius_m`. `0.0` disables grace
    /// entirely (unknown water then blocks unconditionally, and a blocked
    /// endpoint is simply unroutable).
    pub endpoint_grace_radius_m: f64,
    /// §3.4, `artifact_catzoc_allowance_mode`.
    pub catzoc_mode: CatzocMode,
    /// §3.3, `artifact_allow_restricted_entry` — releases `RESARE`
    /// `RESTRN=8`, `MARCUL` and `FSHFAC` together. Never releases
    /// `RESTRN=7`.
    pub allow_restricted_entry: bool,
    /// **Test / oracle use only.** When `true`, the corridor grid is
    /// pinned to `finest_allowed_cell_m` everywhere — the §4.1/§4.2
    /// coarsening ladder AND the `HARD_MAX_DIM` cell budget that normally
    /// force a coarser rung on a large corridor are both bypassed, so the
    /// search is a genuine finest-everywhere brute force. A defensive cap
    /// (`search::FORCE_FINEST_MAX_DIM`) makes an over-large corridor
    /// return `None` rather than silently truncate.
    ///
    /// Every shipping caller passes `false` and is byte-identical to
    /// before this field existed — it exists solely so
    /// [`crate::mivnav::reference_route`] can be an optimality oracle for
    /// the §23 regression suite. Do NOT set it on a real route request:
    /// on anything larger than a single fixture cell it is either far too
    /// slow or `None`.
    pub force_finest_resolution: bool,
}

/// Per-request search stats. Every field is a byproduct of the algorithm
/// itself, same posture as `routing::raster::RouteDiagnostics`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArtifactDiagnostics {
    pub grid_cols: u32,
    pub grid_rows: u32,
    /// The resolution actually searched at.
    pub cell_size_m: f64,
    /// The §4.2 ladder rung chosen, before the cell budget's own floor.
    pub ladder_cell_m: f64,
    /// §4.1's `finest_allowed_cell` for these charts — what the SOURCE
    /// allows, independent of corridor size. v3 §18's resolution overlay
    /// in one number: the first thing to look at when a channel is
    /// inexplicably closed.
    pub finest_allowed_cell_m: f64,
    /// The coarsest §3.4 horizontal figure over the `M_QUAL` zones
    /// consulted, after the mode scaling — i.e. how far hazards were
    /// actually grown.
    pub catzoc_horizontal_m: f64,
    /// The finest compilation-scale denominator over the cells consulted.
    pub compilation_scale: u32,
    pub blocked_cells: u32,
    pub unknown_cells: u32,
    pub nodes_expanded: u32,
    pub corridor_widen_attempts: u32,
    /// The route's own integrated cost, in the integer
    /// millimetre-equivalents §13.1 requires. Reported, not compared to
    /// any bound — see the module docs on §14.
    pub route_cost_mm: i64,
}

/// A found route.
#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactRoute {
    /// `(lon, lat)`, start to end inclusive. Both ends are CELL CENTRES
    /// (§13.1 canonical endpoints), not the requested points — see
    /// `start_snap_m`/`end_snap_m` for how far that moved them.
    pub waypoints: Vec<(f64, f64)>,
    pub distance_m: f64,
    /// One entry per leg. `true` where the exact verifier
    /// (`routing::raster::verify_route_legs`, reused unmodified) could
    /// not confirm the leg clear of the hard-constraint union.
    pub approximate_legs: Vec<bool>,
    /// One entry per leg. `true` where the leg used §9.3 grace (crossed
    /// unsurveyed or uncharted water), or crosses an openable bridge this
    /// boat cannot clear closed. Never a reason the route was shaped or
    /// refused.
    pub check_manually_legs: Vec<bool>,
    /// Ground metres between the REQUESTED start and the first waypoint —
    /// §9.3's "report the snap distance". Never more than
    /// `endpoint_grace_radius_m` plus half a grid cell.
    pub start_snap_m: f64,
    /// The same, for the destination.
    pub end_snap_m: f64,
    pub diagnostics: ArtifactDiagnostics,
}

/// Plan a route from `from` to `to` across `cells`.
///
/// `cells` is every decoded chart cell the corridor might cross, in any
/// order — the constraint build is order-independent apart from the
/// first-match `M_QUAL` zone lookup, which is stable for a stable input
/// order. `None` when no path exists within the corridor ladder, or when
/// an endpoint is blocked and no navigable cell lies within the grace
/// radius; there is no partial "get as close as you can" fallback here
/// (the same scope call `routing::raster::graph::graph_route` makes).
///
/// # Determinism
///
/// The two §13.2 assertions hold BY CONSTRUCTION, not by observation:
///
/// * `route(A, B)` is `route(B, A)` reversed, because the endpoints are
///   ordered canonically (lexicographically by world `(x, y)`) before the
///   search and the result is reversed afterward if the request ran the
///   other way. The search space is already symmetric — the corridor is
///   built from `min`/`max`, the grid lattice is globally anchored, and
///   every step cost is the AVERAGE of its two cells' multipliers — so
///   the only asymmetry canonical ordering removes is A\*'s tie-breaking
///   among equal-cost paths. That is a real class of bug (§13.2: "this
///   one assertion catches a large class of hierarchy, LOS-asymmetry and
///   refinement bugs"), so removing it by construction rather than
///   hoping is the point.
/// * Two identical queries produce byte-identical output, because every
///   stage is a pure function of the inputs with no hash iteration, no
///   insertion-order tie-break, and no floating-point accumulation in the
///   priority order.
pub fn artifact_route(
    from: WorldXy,
    to: WorldXy,
    cells: &[&Cell],
    params: &ArtifactParams,
    weights: &ArtifactWeights,
) -> Option<ArtifactRoute> {
    let constraints = build_query_constraints(
        cells,
        &ConstraintParams {
            required_depth_m: params.required_depth_m,
            avoid_depth_m: params.avoid_depth_m,
            soft_prefer_depth_m: params.soft_prefer_depth_m,
            required_air_draft_m: params.required_air_draft_m,
            lateral_margin_m: params.lateral_margin_m,
            catzoc_mode: params.catzoc_mode,
            allow_restricted_entry: params.allow_restricted_entry,
            // The fine search's coverage-complement grace reads it.
            build_charted_depth: true,
        },
    );
    route_with_constraints(from, to, &constraints, params, weights)
}

/// [`artifact_route`]'s second half, given an already-built constraint
/// set — split out so a test (or a future caller with a cached
/// constraint set) can exercise the search without re-deriving chart
/// truth every time.
pub fn route_with_constraints(
    from: WorldXy,
    to: WorldXy,
    constraints: &ArtifactConstraints,
    params: &ArtifactParams,
    weights: &ArtifactWeights,
) -> Option<ArtifactRoute> {
    // §13.1 canonical endpoints, extended to canonical ORDER — see this
    // function's own docs.
    let reversed = (to.x, to.y) < (from.x, from.y);
    let (a, b) = if reversed { (to, from) } else { (from, to) };

    let outcome = search::search(
        a,
        b,
        constraints,
        weights,
        params.endpoint_grace_radius_m,
        params.force_finest_resolution,
    )?;

    let mut waypoints = outcome.waypoints;
    // Summed BEFORE the reversal, on the canonical point order: float
    // addition is not associative, so re-summing the reversed list could
    // differ in the last bit and break §13.2's reversal assertion on a
    // number that is meant to describe the identical polyline.
    let distance_m = search::path_distance_m(&waypoints);
    let mut graced = outcome.graced_legs;
    let (mut start_snap_m, mut end_snap_m) = (outcome.start_snap_m, outcome.end_snap_m);
    if reversed {
        waypoints.reverse();
        graced.reverse();
        std::mem::swap(&mut start_snap_m, &mut end_snap_m);
    }

    let lonlat: Vec<(f64, f64)> = waypoints.iter().map(|&p| search::to_lonlat(p)).collect();

    // §16: the exact verifier, reused as-is. Its `true` means "this leg
    // crosses the union" — the same meaning `approximate_legs` already
    // carries for every other algorithm.
    let approximate_legs = crate::routing::raster::verify_route_legs(&lonlat, &constraints.hard);
    let crosses_flagged =
        crate::routing::raster::verify_route_legs(&lonlat, &constraints.check_manually);
    let check_manually_legs: Vec<bool> = (0..lonlat.len().saturating_sub(1))
        .map(|i| {
            graced.get(i).copied().unwrap_or(false)
                || crosses_flagged.get(i).copied().unwrap_or(false)
        })
        .collect();

    Some(ArtifactRoute {
        waypoints: lonlat,
        distance_m,
        approximate_legs,
        check_manually_legs,
        start_snap_m,
        end_snap_m,
        diagnostics: ArtifactDiagnostics {
            grid_cols: outcome.cols,
            grid_rows: outcome.rows,
            cell_size_m: outcome.cell_size_m,
            ladder_cell_m: outcome.ladder_cell_m,
            finest_allowed_cell_m: outcome.finest_allowed_cell_m,
            catzoc_horizontal_m: constraints.catzoc_horizontal_m,
            compilation_scale: constraints.compilation_scale,
            blocked_cells: outcome.blocked_cells,
            unknown_cells: outcome.unknown_cells,
            nodes_expanded: outcome.nodes_expanded,
            corridor_widen_attempts: outcome.corridor_widen_attempts,
            route_cost_mm: outcome.cost_mm,
        },
    })
}

/// [`artifact_route`] from `(lon, lat)` pairs — the shape every pyo3
/// entry point in this crate already speaks.
pub fn artifact_route_lonlat(
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    cells: &[&Cell],
    params: &ArtifactParams,
    weights: &ArtifactWeights,
) -> Option<ArtifactRoute> {
    artifact_route(
        search::from_lonlat(from_lon, from_lat),
        search::from_lonlat(to_lon, to_lat),
        cells,
        params,
        weights,
    )
}

/// The debug-overlay bundle for one `(from, to)` request: the constraint
/// set that would be built, and what [`search`](search::search) would do
/// with it — including WHICH failure point fired when it finds no route.
/// Runs the identical `constraints::build` + first corridor attempt the
/// real search uses; nothing here is a cheaper approximation of it.
pub(crate) struct ArtifactDebug {
    pub constraints: ArtifactConstraints,
    pub search: search::SearchDebug,
}

/// [`ArtifactDebug`] from `(lon, lat)` pairs. Always returns — a no-route
/// request is the case this exists for.
pub(crate) fn artifact_debug_lonlat(
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    cells: &[&Cell],
    params: &ArtifactParams,
    weights: &ArtifactWeights,
) -> ArtifactDebug {
    let constraints = build_query_constraints(
        cells,
        &ConstraintParams {
            required_depth_m: params.required_depth_m,
            avoid_depth_m: params.avoid_depth_m,
            soft_prefer_depth_m: params.soft_prefer_depth_m,
            required_air_draft_m: params.required_air_draft_m,
            lateral_margin_m: params.lateral_margin_m,
            catzoc_mode: params.catzoc_mode,
            allow_restricted_entry: params.allow_restricted_entry,
            build_charted_depth: true,
        },
    );
    let dbg = search::search_debug(
        search::from_lonlat(from_lon, from_lat),
        search::from_lonlat(to_lon, to_lat),
        &constraints,
        weights,
        params.endpoint_grace_radius_m,
        params.force_finest_resolution,
    );
    ArtifactDebug {
        constraints,
        search: dbg,
    }
}

#[cfg(test)]
mod tests {
    use super::constraints::fixtures::*;
    use super::*;
    use crate::model::AttrValue;

    const LAT: f64 = 55.0;
    const LON: f64 = 12.0;

    fn params() -> ArtifactParams {
        ArtifactParams {
            required_depth_m: 2.0,
            avoid_depth_m: 0.0,
            soft_prefer_depth_m: 0.0,
            required_air_draft_m: 0.0,
            lateral_margin_m: 0.0,
            endpoint_grace_radius_m: 150.0,
            catzoc_mode: CatzocMode::Off,
            allow_restricted_entry: false,
            force_finest_resolution: false,
        }
    }

    /// A cell that charts a wide area of coverage plus whatever else the
    /// test needs — so the "absent coverage blocks" rule has a real
    /// statement to work from rather than the extent fallback.
    fn covered_cell(mut features: Vec<crate::model::Feature>, half_side_m: f64) -> Cell {
        features.insert(0, coverage(LAT, LON, half_side_m));
        cell_of(features, 10_000)
    }

    fn route(cell: &Cell, from: (f64, f64), to: (f64, f64)) -> Option<ArtifactRoute> {
        artifact_route_lonlat(
            from.0,
            from.1,
            to.0,
            to.1,
            &[cell],
            &params(),
            &ArtifactWeights::default(),
        )
    }

    #[test]
    fn open_water_routes_and_reports_a_real_distance() {
        let c = covered_cell(vec![], 20_000.0);
        let r = route(&c, (LON - 0.02, LAT), (LON + 0.02, LAT)).expect("nothing in the way");
        assert!(r.waypoints.len() >= 2);
        assert!(r.distance_m > 1_000.0, "{}", r.distance_m);
        assert!(
            r.approximate_legs.iter().all(|&a| !a),
            "an open-water route must verify exactly: {:?}",
            r.approximate_legs
        );
        assert_eq!(r.approximate_legs.len(), r.waypoints.len() - 1);
        assert_eq!(r.check_manually_legs.len(), r.waypoints.len() - 1);
    }

    #[test]
    fn a_breakwater_family_feature_forces_a_real_detour() {
        // MORFAC — a mooring dolphin field. None of the existing three
        // algorithms know this class at all.
        let c = covered_cell(vec![area("MORFAC", LAT, LON, 500.0)], 20_000.0);
        let r = route(&c, (LON - 0.02, LAT), (LON + 0.02, LAT)).expect("a way round exists");
        assert!(
            r.waypoints.len() > 2,
            "must bend around the obstacle: {:?}",
            r.waypoints
        );
        assert!(r.approximate_legs.iter().all(|&a| !a));
    }

    fn route_with(
        cell: &Cell,
        from: (f64, f64),
        to: (f64, f64),
        params: &ArtifactParams,
        weights: &ArtifactWeights,
    ) -> Option<ArtifactRoute> {
        artifact_route_lonlat(from.0, from.1, to.0, to.1, &[cell], params, weights)
    }

    #[test]
    fn a_shallow_but_passable_band_is_avoided_when_the_tier_is_on_used_when_it_is_not() {
        // A 3 m DEPARE band straight across the corridor. It clears the
        // 2 m hard floor, so with the tiers OFF the route sails through
        // it; with the avoid tier ON (out to 4 m, heavy weight) the route
        // bends around it.
        let band = attributed_area(
            "DEPARE",
            LAT,
            LON,
            600.0,
            &[
                ("drval1", AttrValue::Float(3.0)),
                ("drval2", AttrValue::Float(3.0)),
            ],
        );
        let c = covered_cell(vec![band], 20_000.0);
        let a = (LON - 0.02, LAT);
        let b = (LON + 0.02, LAT);

        let off = route(&c, a, b).expect("passable with tiers off");
        assert_eq!(
            off.waypoints.len(),
            2,
            "3 m clears the floor: {:?}",
            off.waypoints
        );

        let tiers = ArtifactParams {
            avoid_depth_m: 4.0,
            ..params()
        };
        let heavy = ArtifactWeights {
            avoid_depth_weight: 4.0,
            ..ArtifactWeights::default()
        };
        let on = route_with(&c, a, b, &tiers, &heavy).expect("still routable — soft, not hard");
        assert!(
            on.waypoints.len() > 2,
            "the avoid tier must bend the route around the 3 m band: {:?}",
            on.waypoints
        );
        // Nothing was hard-blocked or graced — every leg still verifies.
        assert!(on.approximate_legs.iter().all(|&a| !a));
    }

    #[test]
    fn the_avoid_tier_is_soft_a_walled_in_shallow_patch_is_still_crossed() {
        // The 3 m band is the ONLY way through (land on both flanks). The
        // avoid tier must NOT turn it into a wall.
        let band = attributed_area(
            "DEPARE",
            LAT,
            LON,
            2_000.0,
            &[
                ("drval1", AttrValue::Float(3.0)),
                ("drval2", AttrValue::Float(3.0)),
            ],
        );
        let north = area("LNDARE", LAT + 0.03, LON, 2_500.0);
        let south = area("LNDARE", LAT - 0.03, LON, 2_500.0);
        let c = covered_cell(vec![band, north, south], 20_000.0);
        let tiers = ArtifactParams {
            avoid_depth_m: 4.0,
            ..params()
        };
        let heavy = ArtifactWeights {
            avoid_depth_weight: 5.0,
            ..ArtifactWeights::default()
        };
        let r = route_with(&c, (LON - 0.02, LAT), (LON + 0.02, LAT), &tiers, &heavy)
            .expect("the shallow patch is soft, not a block");
        assert!(r.waypoints.len() >= 2);
        assert!(r.approximate_legs.iter().all(|&a| !a));
    }

    // ── §13.2's two REQUIRED determinism assertions ───────────────────

    #[test]
    fn route_a_to_b_reversed_equals_route_b_to_a() {
        // §13.2's headline assertion: "this one assertion catches a large
        // class of hierarchy, LOS-asymmetry and refinement bugs". This
        // MVP has no directional cost term at all, so it must hold for
        // EVERY query — asserted generically over several scenarios, not
        // on one lucky pair.
        let scenarios: Vec<(&str, Cell)> = vec![
            ("open water", covered_cell(vec![], 20_000.0)),
            (
                "one obstacle",
                covered_cell(vec![area("LNDARE", LAT, LON, 600.0)], 20_000.0),
            ),
            (
                "two obstacles with a gap",
                covered_cell(
                    vec![
                        area("SLCONS", LAT + 0.006, LON, 400.0),
                        area("DAMCON", LAT - 0.006, LON, 400.0),
                    ],
                    20_000.0,
                ),
            ),
            (
                "soft cost in the way",
                covered_cell(
                    vec![attributed_area(
                        "RESARE",
                        LAT,
                        LON,
                        800.0,
                        &[("RESTRN", AttrValue::IntList(vec![14]))],
                    )],
                    20_000.0,
                ),
            ),
        ];
        let weights = ArtifactWeights {
            caution_area_avoidance_weight: 0.5,
            turn_cost_weight: 0.2,
            ..ArtifactWeights::default()
        };
        for (name, cell) in &scenarios {
            let a = (LON - 0.02, LAT - 0.004);
            let b = (LON + 0.02, LAT + 0.004);
            let ab = artifact_route_lonlat(a.0, a.1, b.0, b.1, &[cell], &params(), &weights)
                .unwrap_or_else(|| panic!("{name}: A->B must route"));
            let ba = artifact_route_lonlat(b.0, b.1, a.0, a.1, &[cell], &params(), &weights)
                .unwrap_or_else(|| panic!("{name}: B->A must route"));

            let mut ba_reversed = ba.waypoints.clone();
            ba_reversed.reverse();
            assert_eq!(ab.waypoints, ba_reversed, "{name}: geometry must reverse");

            let mut ba_flags = ba.approximate_legs.clone();
            ba_flags.reverse();
            assert_eq!(ab.approximate_legs, ba_flags, "{name}: flags must reverse");

            let mut ba_manual = ba.check_manually_legs.clone();
            ba_manual.reverse();
            assert_eq!(ab.check_manually_legs, ba_manual, "{name}: flags reverse");

            assert_eq!(ab.distance_m, ba.distance_m, "{name}: distance");
            assert_eq!(
                ab.diagnostics.route_cost_mm, ba.diagnostics.route_cost_mm,
                "{name}: cost"
            );
            assert_eq!(ab.start_snap_m, ba.end_snap_m, "{name}: snaps swap");
        }
    }

    #[test]
    fn two_identical_queries_produce_byte_identical_output() {
        let c = covered_cell(
            vec![
                area("LNDARE", LAT + 0.004, LON, 400.0),
                area("PILPNT", LAT - 0.005, LON + 0.004, 200.0),
            ],
            20_000.0,
        );
        let first = route(&c, (LON - 0.02, LAT), (LON + 0.02, LAT)).expect("routes");
        for _ in 0..3 {
            let again = route(&c, (LON - 0.02, LAT), (LON + 0.02, LAT)).expect("routes");
            assert_eq!(first, again, "repeated identical queries must not drift");
        }
    }

    #[test]
    fn two_clicks_a_few_centimetres_apart_snap_to_the_same_route() {
        // §13.1's "two clicks 30 cm apart must produce the same route",
        // as far as it is meaningful without the artifact's own global
        // cell grid — the lattice here is globally anchored, so a
        // sub-cell jitter that does not change the ladder rung resolves
        // to the same canonical endpoints. NOT one of the two REQUIRED
        // assertions; a bonus the anchoring choice buys.
        let c = covered_cell(vec![area("LNDARE", LAT, LON, 400.0)], 20_000.0);
        let base = route(&c, (LON - 0.02, LAT), (LON + 0.02, LAT)).expect("routes");
        // ~1e-7 degrees of longitude is well under a centimetre.
        let jittered = route(&c, (LON - 0.02 + 1e-7, LAT), (LON + 0.02, LAT)).expect("routes");
        assert_eq!(base.waypoints, jittered.waypoints);
    }

    // ── §9.3 endpoint grace ───────────────────────────────────────────

    #[test]
    fn a_destination_in_unsurveyed_water_is_reachable_and_flagged() {
        // The dock-to-dock fix: UNSARE is a hard block for this
        // algorithm (unlike `raster`, which downgraded it after a live
        // bug report) and grace is what keeps that from making a real
        // berth unreachable.
        let c = covered_cell(vec![area("UNSARE", LAT, LON + 0.019, 120.0)], 20_000.0);
        let dest = (LON + 0.019, LAT);
        let r = route(&c, (LON - 0.02, LAT), dest).expect("grace must make this reachable");
        assert!(
            r.check_manually_legs.iter().any(|&m| m),
            "a graced leg must be flagged: {:?}",
            r.check_manually_legs
        );
        assert!(
            r.approximate_legs.iter().all(|&a| !a),
            "grace is not the same as unverified against HARD geometry"
        );
    }

    #[test]
    fn a_bare_unsurveyed_wall_no_longer_blocks_but_is_flagged_for_a_human() {
        // A wall of UNSARE across the middle of the corridor, no charted
        // depth stated. Since the depth-tier change, UNSARE is not a
        // routing constraint — the route goes STRAIGHT through it (2
        // waypoints, no detour) — but the crossing is flagged
        // `check_manually` so a human still knows the survey is thin.
        let c = covered_cell(vec![area("UNSARE", LAT, LON, 400.0)], 20_000.0);
        let r = route(&c, (LON - 0.02, LAT), (LON + 0.02, LAT)).expect("route exists");
        assert_eq!(
            r.waypoints.len(),
            2,
            "no detour around bare unsurveyed water any more: {:?}",
            r.waypoints
        );
        assert!(
            r.check_manually_legs.iter().any(|&m| m),
            "the unsurveyed crossing must still be flagged for a human: {:?}",
            r.check_manually_legs
        );
    }

    #[test]
    fn an_endpoint_on_land_snaps_within_the_radius_and_reports_the_distance() {
        // A small island exactly under the requested destination.
        let dest = (LON + 0.019, LAT);
        let c = covered_cell(vec![area("LNDARE", LAT, LON + 0.019, 40.0)], 20_000.0);
        let r = route(&c, (LON - 0.02, LAT), dest).expect("snapping must rescue this");
        assert!(r.end_snap_m > 0.0, "the snap must be reported");
        assert!(
            r.end_snap_m <= params().endpoint_grace_radius_m + r.diagnostics.cell_size_m,
            "snap {} must stay inside the grace radius",
            r.end_snap_m
        );
    }

    #[test]
    fn land_within_the_grace_radius_still_blocks_the_route_through_it() {
        // §9.3: "Grace applies to *unknown* water only, never to
        // *known-bad* water." A solid land bar right next to the
        // destination must still be routed AROUND, not through, even
        // though it is well inside the grace radius.
        let dest = (LON + 0.019, LAT);
        let bar = attributed_area("LNDARE", LAT, LON + 0.0175, 60.0, &[]);
        let c = covered_cell(vec![bar], 20_000.0);
        let r = route(&c, (LON - 0.02, LAT), dest).expect("a way round the bar exists");
        // Every returned leg must verify exactly against the hard union —
        // i.e. nothing was let through on grace.
        assert!(
            r.approximate_legs.iter().all(|&a| !a),
            "no leg may cross land, graced or not: {:?}",
            r.approximate_legs
        );
    }

    #[test]
    fn a_real_hazard_within_the_grace_radius_still_blocks() {
        // Same rule, for a depth/hazard block rather than land: a wreck
        // with no VALSOU at all (which this algorithm blocks on) sitting
        // beside the destination.
        let dest = (LON + 0.019, LAT);
        let c = covered_cell(
            vec![attributed_area("WRECKS", LAT, LON + 0.0178, 50.0, &[])],
            20_000.0,
        );
        let r = route(&c, (LON - 0.02, LAT), dest).expect("routes around it");
        assert!(r.approximate_legs.iter().all(|&a| !a));
    }

    #[test]
    fn no_coverage_beyond_the_chart_is_grace_eligible_but_not_free() {
        // The chart covers only a narrow band; the destination sits just
        // outside it. Reachable via grace, and flagged.
        // Coverage reaches ~300m from the cell centre; the destination
        // sits ~380m out, i.e. ~80m into uncharted water and well within
        // the 150m grace radius of itself.
        let c = cell_of(vec![coverage(LAT, LON, 300.0)], 10_000);
        let r = artifact_route_lonlat(
            LON - 0.0031, // ~200m west of centre, inside coverage
            LAT,
            LON + 0.0060, // ~383m east of centre, outside it
            LAT,
            &[&c],
            &params(),
            &ArtifactWeights::default(),
        )
        .expect("a short hop into the uncharted edge is graced");
        assert!(
            r.check_manually_legs.iter().any(|&m| m),
            "crossing uncharted water must be flagged: {:?}",
            r.check_manually_legs
        );
    }

    #[test]
    fn grace_disabled_makes_a_blocked_endpoint_unroutable() {
        let mut p = params();
        p.endpoint_grace_radius_m = 0.0;
        let c = covered_cell(vec![area("LNDARE", LAT, LON + 0.019, 200.0)], 20_000.0);
        assert!(artifact_route_lonlat(
            LON - 0.02,
            LAT,
            LON + 0.019,
            LAT,
            &[&c],
            &p,
            &ArtifactWeights::default(),
        )
        .is_none());
    }

    // ── the resolution ladder actually drives the grid ────────────────

    #[test]
    fn a_coarser_chart_is_searched_at_a_coarser_ladder_rung() {
        let fine = cell_of(vec![coverage(LAT, LON, 20_000.0)], 10_000); // -> 8m
        let coarse = cell_of(vec![coverage(LAT, LON, 20_000.0)], 90_000); // -> 64m
        let go = |c: &Cell| {
            artifact_route_lonlat(
                LON - 0.02,
                LAT,
                LON + 0.02,
                LAT,
                &[c],
                &params(),
                &ArtifactWeights::default(),
            )
            .expect("routes")
            .diagnostics
        };
        let f = go(&fine);
        let c = go(&coarse);
        assert_eq!(f.finest_allowed_cell_m, 8.0);
        assert_eq!(c.finest_allowed_cell_m, 64.0);
        assert!(
            c.cell_size_m > f.cell_size_m,
            "the coarser chart must search on a coarser grid: {} vs {}",
            c.cell_size_m,
            f.cell_size_m
        );
        assert!(
            super::ladder::RESOLUTION_LADDER_M.contains(&c.ladder_cell_m),
            "the chosen rung must be a real ladder level: {}",
            c.ladder_cell_m
        );
    }

    #[test]
    fn catzoc_caps_resolution_independently_of_scale() {
        let mut p = params();
        p.catzoc_mode = CatzocMode::Full;
        // A harbour-scale chart in a CATZOC-C zone: 500/4 = 125 -> 128m.
        let c = cell_of(
            vec![coverage(LAT, LON, 20_000.0), m_qual(LAT, LON, 20_000.0, 4)],
            2_000,
        );
        let d = artifact_route_lonlat(
            LON - 0.02,
            LAT,
            LON + 0.02,
            LAT,
            &[&c],
            &p,
            &ArtifactWeights::default(),
        )
        .expect("routes")
        .diagnostics;
        assert_eq!(d.finest_allowed_cell_m, 128.0);
        assert_eq!(d.catzoc_horizontal_m, 500.0);
    }

    // ── soft costs really bend the route ──────────────────────────────

    #[test]
    fn an_area_to_be_avoided_is_crossed_only_when_nothing_else_will_do() {
        let c = covered_cell(
            vec![attributed_area(
                "RESARE",
                LAT,
                LON,
                700.0,
                &[("RESTRN", AttrValue::IntList(vec![14]))],
            )],
            20_000.0,
        );
        let straight = artifact_route_lonlat(
            LON - 0.02,
            LAT,
            LON + 0.02,
            LAT,
            &[&cell_of(vec![coverage(LAT, LON, 20_000.0)], 10_000)],
            &params(),
            &ArtifactWeights::default(),
        )
        .expect("routes");
        let avoided = artifact_route_lonlat(
            LON - 0.02,
            LAT,
            LON + 0.02,
            LAT,
            &[&c],
            &params(),
            &ArtifactWeights::default(),
        )
        .expect("routes — ATBA is never a block");
        assert!(
            avoided.distance_m > straight.distance_m,
            "the +5.0 tier must bend the route: {} vs {}",
            avoided.distance_m,
            straight.distance_m
        );
    }

    #[test]
    fn the_cost_is_reported_in_integer_millimetre_equivalents() {
        let c = covered_cell(vec![], 20_000.0);
        let r = route(&c, (LON - 0.02, LAT), (LON + 0.02, LAT)).expect("routes");
        assert!(r.diagnostics.route_cost_mm > 0);
        // ~2.5 km at multiplier 1.0 is ~2.5e6 mm; the grid path is a
        // little longer than the direct line but the order of magnitude
        // pins the units.
        assert!(
            r.diagnostics.route_cost_mm as f64 > r.distance_m * 500.0,
            "cost {} vs distance {}",
            r.diagnostics.route_cost_mm,
            r.distance_m
        );
    }

    // ── the debug bundle (`artifact_debug_lonlat`) ────────────────────

    fn debug_of(cell: &Cell, from: (f64, f64), to: (f64, f64)) -> ArtifactDebug {
        artifact_debug_lonlat(
            from.0,
            from.1,
            to.0,
            to.1,
            &[cell],
            &params(),
            &ArtifactWeights::default(),
        )
    }

    #[test]
    fn debug_reports_ok_and_a_field_for_open_water() {
        let c = covered_cell(vec![], 20_000.0);
        let d = debug_of(&c, (LON - 0.02, LAT), (LON + 0.02, LAT));
        assert_eq!(d.search.reason, "ok");
        let f = d.search.field.expect("a field was built");
        assert_eq!(f.codes.len(), f.cols as usize * f.rows as usize);
        assert!(f.start_cell.is_some() && f.goal_cell.is_some());
        // Open water: no hard cells in the raster.
        assert!(f.codes.iter().all(|&code| code != search::DBG_HARD));
        // And the constraint rings carry the coverage statement.
        assert!(!d.constraints.coverage.is_empty());
        assert!(d.constraints.hard.is_empty());
    }

    #[test]
    fn debug_reports_severed_across_an_uncovered_gap() {
        // Two disjoint `M_COVR` patches with an endpoint inside each and
        // ~2.4 km of NO coverage between them. That gap is `F_UNKNOWN` and
        // ungraced (the 150 m grace radius does not reach it), so the fine
        // search has a walkable start and goal with no path between —
        // exactly the real-world failure the debug layer exists to show.
        let c = cell_of(
            vec![
                coverage(LAT, LON - 0.05, 2_000.0),
                coverage(LAT, LON + 0.05, 2_000.0),
            ],
            10_000,
        );
        let d = debug_of(&c, (LON - 0.05, LAT), (LON + 0.05, LAT));
        assert_eq!(d.search.reason, "severed");
        let f = d.search.field.expect("a field was built");
        assert!(
            f.codes
                .iter()
                .any(|&code| code == search::DBG_UNKNOWN_BLOCKED),
            "the uncovered gap must show as ungraced-unknown cells"
        );
        assert!(!d.constraints.coverage.is_empty());
    }

    #[test]
    fn debug_labels_the_blocked_endpoint_in_request_order() {
        // `search_debug` runs in a canonical direction; a blocked
        // destination must still read as `goal_blocked` (and a blocked
        // start as `start_blocked`) whichever way that order falls.
        // A 1 km island well past the 150 m grace radius on its inland
        // endpoint.
        let island = attributed_area("LNDARE", LAT, LON + 0.02, 1_000.0, &[]);
        let c = covered_cell(vec![island], 20_000.0);
        let water = (LON - 0.02, LAT);
        let land = (LON + 0.02, LAT);
        for (from, to, want) in [
            (water, land, "goal_blocked"),
            (land, water, "start_blocked"),
        ] {
            let d = debug_of(&c, from, to);
            assert_eq!(d.search.reason, want, "{from:?} -> {to:?}");
            let f = d.search.field.expect("a field was built");
            let (walkable, blocked) = if want == "goal_blocked" {
                (f.start_cell, f.goal_cell)
            } else {
                (f.goal_cell, f.start_cell)
            };
            assert!(
                walkable.is_some() && blocked.is_none(),
                "{from:?} -> {to:?}"
            );
            let (snap_ok, snap_none) = if want == "goal_blocked" {
                (d.search.start_snap_m, d.search.goal_snap_m)
            } else {
                (d.search.goal_snap_m, d.search.start_snap_m)
            };
            assert!(snap_ok.is_finite() && snap_none.is_nan());
        }
    }

    /// The reported bug, reproduced directly: a coarse (overview-scale)
    /// cell's own `LNDARE` sits over ground a FINER cell, also in the
    /// candidate slice, fully covers and charts as open water. Both
    /// cells' own `M_COVR` matches exactly (so `region_authority` can
    /// prove the coarse cell adds nothing over their shared extent) —
    /// `build_query_constraints` must drop the coarse cell whole, so the
    /// LNDARE never reaches `hard` at all. Plain `constraints::build`
    /// (no authority pass) is the control: run on the SAME two cells, it
    /// must still see the hazard — proving the drop is
    /// `authority_filtered`'s doing, not something already true of the
    /// raw cells.
    #[test]
    fn a_redundant_overview_cells_own_land_never_reaches_hard() {
        let fine = cell_of(
            vec![coverage(LAT, LON, 300.0)],
            5_000, // a real harbour-scale chart
        );
        let coarse = cell_of(
            vec![coverage(LAT, LON, 300.0), area("LNDARE", LAT, LON, 100.0)],
            200_000, // a country-wide overview chart
        );
        let p = constraints::fixtures::params(2.0);

        let filtered = build_query_constraints(&[&fine, &coarse], &p);
        assert!(
            filtered.hard.is_empty(),
            "the redundant overview cell's own LNDARE must not reach `hard`: {:?}",
            filtered.hard
        );

        let unfiltered = constraints::build(&[&fine, &coarse], &p);
        assert!(
            !unfiltered.hard.is_empty(),
            "control: without the authority pass the same two cells DO produce a hazard"
        );
    }

    /// The other side of the same fix: a coarse cell that charts REAL
    /// ground no finer cell reaches (its own coverage square is bigger
    /// than the fine cell's) must survive whole — `region_authority`
    /// only drops a cell once it is FULLY redundant, never partially.
    #[test]
    fn a_coarse_cell_charting_unique_ground_is_kept() {
        let fine = cell_of(vec![coverage(LAT, LON, 300.0)], 5_000);
        // The coarse cell's own LNDARE sits OUTSIDE the fine cell's own
        // 300 m coverage square, so no finer cell in the slice ever
        // charts that ground — the coarse cell is authoritative there.
        let coarse = cell_of(
            vec![
                coverage(LAT, LON, 2_000.0),
                area("LNDARE", LAT, LON + 0.02, 100.0),
            ],
            200_000,
        );
        let p = constraints::fixtures::params(2.0);

        let filtered = build_query_constraints(&[&fine, &coarse], &p);
        assert!(
            !filtered.hard.is_empty(),
            "a coarse cell's OWN unique ground must survive the authority pass"
        );
    }

    /// The exact live-reproduced case a whole-cell drop alone cannot
    /// reach (a real Nordby-narrows portal point stayed `goal_blocked`
    /// after `authority_filtered` landed): the coarse cell's own LNDARE
    /// sits on ground a FINER cell also covers, but the coarse cell ALSO
    /// covers real, unique ground elsewhere in the corridor — so the
    /// whole-cell pass correctly keeps it (it is not redundant overall),
    /// and only the per-ring pass can still remove its hazard from the
    /// one spot the finer cell disputes.
    #[test]
    fn a_kept_coarse_cells_land_is_still_clipped_where_a_finer_cell_disagrees() {
        let fine = cell_of(vec![coverage(LAT, LON, 300.0)], 5_000);
        let coarse = cell_of(
            vec![
                // Matches the fine cell's own footprint exactly, so the
                // finer chart is fully authoritative right where the
                // LNDARE sits...
                coverage(LAT, LON, 300.0),
                area("LNDARE", LAT, LON, 100.0),
                // ...but the coarse cell ALSO reaches ground ~5.5 km
                // away no finer cell in the slice ever touches, so
                // `region_authority` must keep it whole rather than drop
                // it entirely.
                coverage(LAT, LON + 0.05, 2_000.0),
            ],
            200_000,
        );
        let p = constraints::fixtures::params(2.0);

        let unfiltered = constraints::build(&[&fine, &coarse], &p);
        assert!(
            !unfiltered.hard.is_empty(),
            "control: with no authority pass at all the LNDARE reaches `hard`"
        );

        let whole_cell_only = constraints::build(&authority_filtered(&[&fine, &coarse]), &p);
        assert!(
            !whole_cell_only.hard.is_empty(),
            "control: the coarse cell is NOT redundant overall (it charts unique \
             ground 5.5 km away), so a whole-cell-only pass must keep it — and its \
             LNDARE along with it"
        );

        // The real query path: whole-cell filter, then the per-ring clip.
        let fully_filtered = build_query_constraints(&[&fine, &coarse], &p);
        assert!(
            fully_filtered.hard.is_empty(),
            "the per-ring pass must still remove the coarse cell's own LNDARE \
             where the finer cell's own coverage disagrees, even though the \
             coarse cell survives whole: {:?}",
            fully_filtered.hard
        );
    }

    /// `authority_filtered` on its own: order is `cells`' own relative
    /// order, never `region_authority`'s internal tier order — pinned
    /// directly since a `constraints::build` assertion alone (the two
    /// tests above) could not tell a reordering from a drop.
    #[test]
    fn authority_filtered_keeps_the_callers_own_relative_order() {
        let a = cell_of(vec![coverage(LAT, LON, 300.0)], 5_000);
        let b = cell_of(vec![coverage(LAT, LON + 0.02, 300.0)], 6_000);
        let c = cell_of(vec![coverage(LAT, LON + 0.04, 300.0)], 7_000);
        // None is redundant (three disjoint coverage squares) — every
        // input must survive, in its own original order.
        let kept = authority_filtered(&[&c, &a, &b]);
        assert_eq!(kept.len(), 3);
        assert!(std::ptr::eq(kept[0], &c));
        assert!(std::ptr::eq(kept[1], &a));
        assert!(std::ptr::eq(kept[2], &b));
    }

    /// Fewer than 2 cells: nothing CAN be redundant, and the short-circuit
    /// must still hand back every cell it was given (not an empty vec).
    #[test]
    fn authority_filtered_is_a_no_op_under_two_cells() {
        assert!(authority_filtered(&[]).is_empty());
        let a = cell_of(vec![coverage(LAT, LON, 300.0)], 5_000);
        assert_eq!(authority_filtered(&[&a]).len(), 1);
    }
}
