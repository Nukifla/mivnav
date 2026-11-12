// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §12's query-time pipeline. Built so far: §7's band selection
//! ([`select_band`]), §12.1's TOPOLOGY search over one band's portal
//! graph ([`topology_route`]), §13.1's canonical world-point snap
//! ([`snap_point`]), and corridor extraction from a found
//! [`TopologyRoute`] ([`corridor_extent`]).
//!
//! # Scope of this slice
//!
//! §12.1's full pipeline is "topology search over portals/shortcuts →
//! corridor-local clearance DT → fine search reusing
//! `routing::artifact::search`'s grid A* → simplification → exact
//! verification (`routing::raster::verify_route_legs`)". Still missing:
//! the corridor-local clearance DT, the fine grid search itself,
//! simplification, and §16's exact verification — this module has
//! nothing yet that has looked at a single real depth sounding or hazard
//! ring at fine resolution, only the coarse per-band navigability the
//! artifact already precomputed, plus geometry over its own tile lattice
//! (extents, midpoints). Nothing in this module is a routable answer on
//! its own yet: per §8.4's own words (already quoted in `topology.rs`),
//! "the topology is an acceleration structure and never overrides §5.2
//! or §16".
//!
//! # Portals, not yet Shortcuts
//!
//! [`super::shortcuts::build_shortcuts`] exists and is tested, but this
//! search does not consume it yet — deliberately. A `Shortcut`'s two
//! endpoints are always JUNCTIONS (see that module's own docs); an
//! arbitrary start or goal tile snapped from a real query is, in
//! general, some ordinary interior tile of a long chain, which is not a
//! `Shortcut` endpoint by construction. Splicing a query point into the
//! middle of a contracted chain is real, scoped work (find which
//! `Shortcut` the tile's own tile-local portal lies on, split it back
//! into its constituent portals for the first/last leg only) that
//! belongs to its own follow-on commit, not folded into this one under
//! time pressure. [`topology_route`] instead searches the RAW portal
//! graph directly, which needs no such splicing — correct for any
//! start/end tile — and is fast enough to be the right MVP: §8.4's own
//! framing is that the portal graph is "portal-scale (hundreds to low
//! thousands of nodes)", squarely inside what a plain Dijkstra/A* on a
//! Raspberry Pi handles without the contraction at all. `Shortcut`
//! consumption is a real future speed-up, not a correctness requirement
//! this slice is missing.
//!
//! # Cost model: distance, times an optional soft-preference multiplier
//!
//! Every portal edge's BASE cost is
//! [`super::field::TileEntry::centre_distance_m`] between its two tiles
//! — the SAME coarse distance model [`super::shortcuts`] already uses
//! for its own cost bounds (see that module's docs for why this
//! approximation is an acceptable trade at graph scale). [`topology_
//! route`]/[`topology_route_graced`] (the plain, no-weights entry
//! points every caller before Phase 5 still uses unchanged) apply that
//! distance at multiplier `1.0` — matches the plan's own Phase 4 gate
//! ("No soft costs beyond distance yet") exactly.
//!
//! [`topology_route_with`]/[`topology_route_graced_with`] (Phase 5) add
//! [`TopologyWeights`]: each portal's OWN multiplier is `1.0 + Σ
//! penalties - Σ preferences`, the identical formula `routing::
//! artifact::search`'s own per-cell `multiplier` already applies,
//! floored at [`MIN_MULTIPLIER`] — which is exactly what keeps the
//! search heuristic ([`heuristic_mm`] at [`MIN_MULTIPLIER`]) admissible
//! against ANY weight combination a caller passes, the identical
//! admissibility argument [`super::shortcuts`]'s own `lower_bound_mm`
//! already documents, now actually exercised rather than merely
//! anticipated.
//!
//! # Determinism
//!
//! Open-set ordering reuses [`OpenNode`]'s exact `(f, h, cell_id)`
//! discipline — §13.1, the same one `routing::artifact::search`'s own
//! grid A* is built on — with a tile's own index as `cell_id`. Ties in
//! `g` are broken by NEVER re-relaxing on an equal (not strictly
//! smaller) cost, so which of two equal-cost paths wins is fixed by
//! `portals`' own canonical ordering (already deterministic — see
//! `portals.rs`) and this function's own fixed edge-iteration order, not
//! by hash iteration or heap tie-breaking accidents. `g`/`came_from` are
//! looked up by key only, never iterated to produce output, so using a
//! `HashMap` for that sparse per-tile bookkeeping (a plain array would
//! need to be region-tile-count-sized, not corridor-sized) costs nothing
//! in determinism — unlike `routing::artifact::search`'s dense fixed
//! grid, this graph's node space is exactly `built.tiles.len()`, with no
//! natural array packing worth reaching for at this scale.
//!
//! # Snapping: geometry only, no navigability check — grace lives one level up
//!
//! §13.1: "snap start and destination to the centre of the finest cell
//! containing them" — [`snap_point`] does exactly that lookup (which
//! tile, which cell, that cell's own persisted centre) and nothing more.
//! It deliberately does NOT check whether the snapped cell is actually
//! navigable at any band: that check needs a band (this function takes
//! none, since a raw world point is meaningful independent of which
//! draft is asking about it), and a point landing on land or a shoal is
//! not necessarily an error — §9.3's own grace mechanism
//! (`routing::artifact::search::Field::walkable`) exists precisely
//! because real marina/anchorage endpoints often sit inside charted but
//! practically-fine water.
//!
//! Reconciling that grace mechanism with this layer was the open item
//! `topology.rs`'s own docs flagged for "whoever wires this into Phase
//! 4": a real corridor that only exists by crossing a short
//! no-coverage gap near an endpoint appears as two disconnected
//! `Components` here, and could be pruned by [`topology_route`] before
//! the fine search — which DOES grace such gaps — ever gets a chance to
//! find it. [`topology_route_graced`] is that reconciliation: `snap_point`
//! itself stays exactly as coarse and honest as §13.1 describes, and
//! grace is applied one level up, as a WIDER SET OF CANDIDATE TILES to
//! try `topology_route` against, never as a change to what "navigable"
//! means at the cell level. `topology_route` and `snap_point` both stay
//! usable directly for a caller that does not need grace (most of the
//! test suite below still calls them that way, deliberately, to keep
//! `topology_route_graced`'s own tests focused on grace itself rather
//! than re-proving ordinary connectivity).
//!
//! [`corridor_extent`] is the union of every tile's own extent along a
//! found [`TopologyRoute`], padded outward — a first-cut, deliberately
//! coarse corridor (a single padded bounding box, not a buffered
//! polyline hugging the actual portal-crossing geometry). This is
//! honestly a looser corridor than the doc's own "k=3 corridors" framing
//! implies eventually, but it is a real, correct, safe OVER-approximation
//! (the true corridor is always a subset of this box), and every tile it
//! touches was already deemed part of a real found path — a tighter
//! corridor is a real future improvement, not a correctness gap this
//! slice is hiding.
//!
//! [`corridor_scope_extent`] + [`filter_cells_to_corridor`] are what a
//! caller WOULD use to turn that corridor into the cell slice
//! `crate::routing::artifact_route_lonlat` is handed, instead of the
//! caller's whole candidate set — **and nothing in this tree does, on
//! purpose.** Read `corridor_scope_extent`'s own docs before wiring
//! either of them anywhere: they carry the measured counterexample
//! showing that scoping the fine search's cells from outside
//! `routing::artifact` cannot be made answer-preserving today, which is
//! this layer's hardest conservative-direction call and the one most
//! likely to be undone by someone who only reads the function names.
//!
//! # `find_tile`'s cost: a known, unindexed linear scan
//!
//! [`find_tile`] checks every one of `built.tiles`' own extents in
//! order — O(tile count) per query point, with no spatial index. `Vec`
//! order was chosen at build time for the on-disk contract
//! (`encode_tile_index`'s own `(origin_y, origin_x)` sort — see
//! `build.rs`), not for query-time lookup, so this is a real, currently
//! unpaid cost on the same Pi-CPU-constrained serving path CLAUDE.md
//! flags throughout this crate. Left as a known cost rather than
//! restructured now, for the same reason `topology::union_within_tile`'s
//! own per-band grid rebuild was left as a known cost: a real spatial
//! index (sorted bands + binary search, or an R-tree) is a genuine
//! design decision for how the artifact's read path is structured, not
//! a change to make unilaterally inside one lookup function. A real
//! region's tile count (hundreds to low thousands, per §8.4's own
//! portal-scale framing) keeps this cheap enough to defer safely.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, HashMap};

use crate::coords::{Extent, LLBox, WorldXy};
use crate::model::Cell;
use crate::routing::artifact::cost::{heuristic_mm, step_cost_mm, OpenNode, MIN_MULTIPLIER};
use crate::routing::hazards::{radius_world_units, world_distance_m};

use super::bands::global_index;
use super::build::BuiltRegion;
use super::directional::{bearing_deg, DirectionalSemantics, TransitionRule};
use super::field::{TileEntry, BAND_LADDER_M};
use super::portals::{portal_crossing_point, Portal};

/// The smallest [`BAND_LADDER_M`] entry that is still `>= required_m` —
/// the tightest SAFE precomputed band for a vessel needing `required_m`
/// of water (see the module docs' safety argument: picking anything
/// SMALLER than the vessel's real requirement could include cells this
/// artifact only proved safe to a shallower draft).
///
/// Non-finite or negative input (a caller bug, never a real vessel
/// draft) is treated the same conservative direction this crate always
/// takes on bad input: the DEEPEST band, never the shallowest — see
/// `bands.rs`'s own `band_to_dm` for the identical "when unsure, demand
/// more depth, not less" rule. A `required_m` beyond the ladder's own
/// 15 m ceiling also returns the deepest band — the ladder's own
/// coverage limit, not something this function can manufacture a safe
/// answer for; whoever calls this for a genuinely deep-draft vessel
/// still owes §16's exact verification the final word, same as every
/// other topology-derived answer.
///
/// # Rounding up can make `topology_route` miss a real route
///
/// [`topology_route`] takes the SAME `required_m`, converted RAW (via
/// `bands::band_to_dm`, no rounding) for its own per-portal capacity
/// filter — deliberately NOT this function's rounded-up value. The two
/// numbers only coincide when `required_m` is itself a `BAND_LADDER_M`
/// entry. For anything between two rungs (say 1.2 m, between the 1.0 m
/// and 1.5 m rungs): [`super::topology::label_band`] only has
/// PRECOMPUTED components at the 1.5 m rung to hand back, so a cell
/// charted at exactly 1.3 m — genuinely deep enough for a 1.2 m draft —
/// is excluded from every component at that band and can make
/// [`topology_route`] report no path at all, even though the exact fine
/// search downstream (reused `routing::artifact` machinery, which
/// checks the real 1.2 m figure, not the rounded band) would still find
/// one. This is the quantised-feasibility trade-off §13.1 itself names
/// ("quantised feasibility via the band ladder") — a real, INHERENT cost
/// of precomputing connectivity at only ten fixed depths, not a bug —
/// and the reason no caller should ever treat `topology_route`
/// returning `None` as the final word on whether a route exists.
/// `select_bands_conservative_rounding_can_exclude_a_technically_
/// sufficient_cell` (below) demonstrates this concretely.
pub fn select_band(required_m: f64) -> f64 {
    // Non-finite OR negative both count as "not a real draft" here — a
    // bare `!is_finite()` check alone let a negative value fall through
    // to the ordinary `find`, where EVERY ladder entry is `>= a negative
    // number`, so it returned the SHALLOWEST band: the exact opposite of
    // this function's own documented rule (found by code review, fixed
    // here — `select_band(-5.0)` used to return `1.0`, now `15.0`).
    if !required_m.is_finite() || required_m < 0.0 {
        return *BAND_LADDER_M.last().expect("BAND_LADDER_M is non-empty");
    }
    BAND_LADDER_M
        .iter()
        .copied()
        .find(|&b| b >= required_m)
        .unwrap_or_else(|| *BAND_LADDER_M.last().expect("BAND_LADDER_M is non-empty"))
}

/// One portal crossing of a [`TopologyRoute`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopologyHop {
    pub portal: u32,
    pub tile: u32,
    pub neighbour_tile: u32,
}

/// The cheapest sequence of portal crossings [`topology_route`] found —
/// see the module docs for what this is NOT yet (a routable answer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopologyRoute {
    pub start_tile: u32,
    pub goal_tile: u32,
    /// Empty when `start_tile == goal_tile` — a real, valid "already
    /// there" answer, not a sentinel for failure (that is `None` from
    /// `topology_route` itself).
    pub hops: Vec<TopologyHop>,
    pub cost_mm: i64,
    /// §8.3's demoted portals: ids of portals ON this route whose
    /// [`super::portals::Portal::min_horizontal_width_dm`] is below the
    /// `min_beam_dm` a caller passed to [`topology_route_demoting`] /
    /// [`topology_route_graced_demoting`] (`w < min_beam_dm`, which
    /// includes the `w == 0` "not measurable" case — a beam that cannot
    /// be confirmed against the raster is exactly the case §12.4's local
    /// vector refinement exists to verify).
    ///
    /// These portals are **NOT rejected**: they stay full edges in the
    /// topology graph, so the route is the same route it would have been
    /// without the threshold. The list is a to-do for
    /// [`super::refine::refine_segment`] — the crossing should be routed
    /// exactly against chart geometry, and the grid-derived answer kept
    /// only if refinement declines. Always empty from
    /// [`topology_route`]/[`topology_route_with`] and their graced
    /// siblings (`min_beam_dm` is `0` there), so every pre-Phase-6 caller
    /// and test sees no change.
    pub demoted_portals: Vec<u32>,
    /// §11's directionally-penalised portals: ids of portals ON this
    /// route that carried a [`TransitionRule::Penalized`] rule (wrong
    /// side of a lateral mark for this direction of travel) when a
    /// caller passed `Some(semantics)` to [`topology_route_demoting`] /
    /// [`topology_route_graced_demoting`]. Diagnostics parity with
    /// [`Self::demoted_portals`]: the route already ROUTED with the
    /// penalty folded into its cost, this is just which crossings paid
    /// it. Portals whose against-flow direction was [`TransitionRule::
    /// Forbidden`] are NOT listed — a forbidden edge does not exist, so
    /// it can never be on a route. Always empty when `semantics` is
    /// `None` (every distance-only and pre-Phase-7 caller).
    pub directional_penalized_portals: Vec<u32>,
}

/// Soft preference weights for [`topology_route_with`]/
/// [`topology_route_graced_with`] — this layer's own, much smaller
/// analogue of [`crate::routing::artifact::ArtifactWeights`]. Only the
/// two weights this layer has real per-cell data for today
/// ([`Portal::touches_fairway`]/[`Portal::touches_tss`], read straight
/// off the SAME `FLAG_FAIRWAY`/`FLAG_TSS` bits the fine search's own
/// weights of the same name read) — `cable_avoidance_weight`/
/// `caution_area_avoidance_weight`/`low_confidence_survey_avoidance_
/// weight`/`turn_cost_weight` all need a semantics store this layer
/// does not have yet (real, separately scoped future work, not folded
/// in here under a placeholder). Default (`0.0` both, via `#[derive(
/// Default)]`) makes [`portal_multiplier`] return exactly `1.0` for
/// every portal — byte-identical to distance-only routing, which is
/// why [`topology_route`]/[`topology_route_graced`] can stay their own
/// unchanged, still-passing-every-existing-test convenience wrappers
/// over the `_with` variants below rather than needing every one of
/// their own call sites updated.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TopologyWeights {
    pub tss_avoidance_weight: f64,
    pub fairway_preference_weight: f64,
}

/// [`portal_multiplier`]'s own formula is `routing::artifact::search`'s
/// per-CELL `multiplier` (`1.0 + Σ penalties - Σ preferences`, floored at
/// [`MIN_MULTIPLIER`]) applied once per PORTAL instead — see that
/// function's own docs for why the floor matters. Flooring at
/// `MIN_MULTIPLIER` (not `0.0` or a negative number) is what keeps
/// [`heuristic_mm`] admissible against ANY weight combination a caller
/// passes: the heuristic is computed at `MIN_MULTIPLIER` regardless
/// (see [`topology_route_with`]'s own heuristic closure), which is a
/// valid lower bound on the real step cost only as long as no real
/// multiplier ever drops below it.
fn portal_multiplier(p: &Portal, weights: TopologyWeights) -> f64 {
    let mut m = 1.0;
    if p.touches_tss {
        m += weights.tss_avoidance_weight;
    }
    if p.touches_fairway {
        m -= weights.fairway_preference_weight;
    }
    m.max(MIN_MULTIPLIER)
}

/// [`topology_route_with`], at [`TopologyWeights::default`] — distance
/// only, exactly this function's own behaviour before Phase 5's soft
/// preferences existed. Kept as its own function (rather than requiring
/// every caller to thread a weights value) for the same "convenience
/// wrapper + a real `_with` variant" split [`super::field::rasterize_
/// tile`]/[`super::field::rasterize_tile_with`] already establish in
/// this crate.
///
/// A*, over the graph whose nodes are tile indices into `built.tiles`
/// and whose directed edges are `portals` (already scoped to one band by
/// whoever built them — see [`super::topology::label_band`]/
/// [`super::portals::detect_portals`]), filtered to `required_draft_dm`
/// (decimetres — a portal narrower than the vessel's own draft is not a
/// usable edge at all, not merely an expensive one). `None` when no
/// portal path connects the two tiles at this band/draft — including
/// when they are simply in different [`super::topology::Components`],
/// which this function does not need to check explicitly: no edge ever
/// crosses between components (`portals.rs`'s own invariant), so the
/// search just finds nothing, the same honest answer either way.
pub fn topology_route(
    built: &BuiltRegion,
    portals: &[Portal],
    start_tile: u32,
    goal_tile: u32,
    required_draft_dm: u16,
) -> Option<TopologyRoute> {
    topology_route_with(
        built,
        portals,
        start_tile,
        goal_tile,
        required_draft_dm,
        TopologyWeights::default(),
    )
}

/// [`topology_route`], with [`TopologyWeights`]'s own soft fairway-
/// preference/TSS-avoidance costs layered onto each portal's own step
/// cost — see that struct's docs for exactly which preferences this
/// layer has data for today.
///
/// This is the `min_beam_dm == 0` case of [`topology_route_demoting`]:
/// no portal is width-demoted and [`TopologyRoute::demoted_portals`] is
/// always empty.
pub fn topology_route_with(
    built: &BuiltRegion,
    portals: &[Portal],
    start_tile: u32,
    goal_tile: u32,
    required_draft_dm: u16,
    weights: TopologyWeights,
) -> Option<TopologyRoute> {
    route_core(
        built,
        portals,
        start_tile,
        goal_tile,
        required_draft_dm,
        0,
        None,
        weights,
    )
}

/// [`topology_route_with`], plus §8.3's demotion: a portal whose
/// [`Portal::min_horizontal_width_dm`] is `< min_beam_dm` (decimetres;
/// the `w == 0` "not measurable" case included — the conservative
/// direction) is **kept as a full edge** — the route is unchanged — and,
/// if it ends up ON the chosen route, its id is recorded in
/// [`TopologyRoute::demoted_portals`] for [`super::refine`] to verify
/// against exact chart geometry.
///
/// `min_beam_dm == 0` disables the mechanism entirely and this is
/// identical to [`topology_route_with`]. Nothing here ever REJECTS a
/// portal on width — the TODO doc is explicit that a width filter
/// without a refinement path to demote to would silently lose real
/// routes.
///
/// `semantics` is §11's directional / buoyage store (Phase 7). `Some`
/// makes a crossing taken against a charted traffic flow
/// ([`TransitionRule::Forbidden`]) not exist as an edge at all for that
/// direction of travel, and folds a wrong-side lateral-mark penalty
/// ([`TransitionRule::Penalized`]) into the crossing's step cost;
/// [`TopologyRoute::directional_penalized_portals`] then reports which
/// route portals paid one. `None` is byte-identical to
/// [`topology_route_with`] plus demotion — every pre-Phase-7 caller.
/// With `semantics` `Some`, `route(A,B)` is deliberately no longer
/// expected to equal `route(B,A).reverse()`: a TSS lane is one-way.
#[allow(clippy::too_many_arguments)]
pub fn topology_route_demoting(
    built: &BuiltRegion,
    portals: &[Portal],
    start_tile: u32,
    goal_tile: u32,
    required_draft_dm: u16,
    min_beam_dm: u16,
    semantics: Option<&DirectionalSemantics>,
    weights: TopologyWeights,
) -> Option<TopologyRoute> {
    route_core(
        built,
        portals,
        start_tile,
        goal_tile,
        required_draft_dm,
        min_beam_dm,
        semantics,
        weights,
    )
}

/// One outgoing edge in [`route_core`]'s adjacency: `(portal id,
/// neighbour tile, edge length in metres, soft-preference multiplier,
/// §11 additive penalty in mm)`. A named alias purely to satisfy
/// clippy's `type_complexity`, same reason [`RankKey`] exists.
type AdjEdge = (u32, u32, f64, f64, i64);

#[allow(clippy::too_many_arguments)]
fn route_core(
    built: &BuiltRegion,
    portals: &[Portal],
    start_tile: u32,
    goal_tile: u32,
    required_draft_dm: u16,
    min_beam_dm: u16,
    semantics: Option<&DirectionalSemantics>,
    weights: TopologyWeights,
) -> Option<TopologyRoute> {
    built.tiles.get(start_tile as usize)?;
    let goal_entry = built.tiles.get(goal_tile as usize)?;
    if start_tile == goal_tile {
        return Some(TopologyRoute {
            start_tile,
            goal_tile,
            hops: Vec::new(),
            cost_mm: 0,
            demoted_portals: Vec::new(),
            directional_penalized_portals: Vec::new(),
        });
    }

    // A cheap no-op when no directional store was passed, or it charts
    // nothing — skip the per-portal crossing-point / bearing work
    // entirely and behave exactly as the pre-Phase-7 search.
    let semantics = semantics.filter(|s| !s.is_empty());

    // §11: the directional verdict for crossing directed portal `p`. The
    // bearing is the COARSE tile-centre-to-tile-centre one (the same
    // approximation the rest of this layer uses — `centre_distance_m`,
    // `corridor_extent`), NOT the exact heading through the portal's own
    // navigable gap: for an oblique or size-mismatched tile pair those
    // can differ by tens of degrees. `DirectionalSemantics::
    // rule_for_crossing` carries a deliberate margin past 90°
    // (`directional::AGAINST_FLOW_COS_MAX`) precisely so a coarse bearing
    // near a right angle never *forbids* — a `Forbidden` verdict deletes
    // the edge, and the safe direction on an approximate measurement is
    // to keep it. `None` here means "no directional store" -> `Allowed`.
    let portal_rule = |p: &Portal| -> TransitionRule {
        let Some(sem) = semantics else {
            return TransitionRule::Allowed;
        };
        let (Some(a), Some(b)) = (
            built.tiles.get(p.tile as usize),
            built.tiles.get(p.neighbour_tile as usize),
        ) else {
            return TransitionRule::Allowed;
        };
        let Some(crossing) = portal_crossing_point(built, p) else {
            return TransitionRule::Allowed;
        };
        sem.rule_for_crossing(
            crossing,
            bearing_deg(a.extent().midpoint(), b.extent().midpoint()),
        )
    };

    // tile -> [one `AdjEdge` per usable outgoing portal], built once,
    // filtered to portals this vessel's draft can actually use AND
    // (Phase 7) to portals whose crossing is not directionally
    // forbidden. `BTreeMap`/`Vec` only — see the module docs'
    // determinism section for why a `HashMap` here would still be safe,
    // but there is no need to reach for one when the key space is
    // already orderable.
    let mut adjacency: BTreeMap<u32, Vec<AdjEdge>> = BTreeMap::new();
    for p in portals {
        if p.max_draft_dm < required_draft_dm {
            continue;
        }
        let (Some(a), Some(b)) = (
            built.tiles.get(p.tile as usize),
            built.tiles.get(p.neighbour_tile as usize),
        ) else {
            continue;
        };
        let directional_penalty_mm = match portal_rule(p) {
            // §11: against the charted traffic flow — the edge does not
            // exist for this direction. The reverse directed portal is
            // a separate record and is judged on its own bearing.
            TransitionRule::Forbidden => continue,
            TransitionRule::Penalized { extra_mm } => extra_mm.max(0),
            _ => 0,
        };
        adjacency.entry(p.tile).or_default().push((
            p.id,
            p.neighbour_tile,
            a.centre_distance_m(b),
            portal_multiplier(p, weights),
            directional_penalty_mm,
        ));
    }

    let heuristic = |tile: u32| -> i64 {
        let d = built
            .tiles
            .get(tile as usize)
            .map_or(0.0, |t| t.centre_distance_m(goal_entry));
        heuristic_mm(d, MIN_MULTIPLIER)
    };

    let mut g: HashMap<u32, i64> = HashMap::new();
    let mut came_from: HashMap<u32, (u32, u32)> = HashMap::new(); // tile -> (portal id, prev tile)
    let mut open: BinaryHeap<Reverse<OpenNode>> = BinaryHeap::new();

    g.insert(start_tile, 0);
    let h0 = heuristic(start_tile);
    open.push(Reverse(OpenNode {
        f: h0,
        h: h0,
        cell_id: start_tile,
    }));

    while let Some(Reverse(node)) = open.pop() {
        let tile = node.cell_id;
        let g_here = *g.get(&tile).unwrap_or(&i64::MAX);
        // Stale lazy-deleted entry: a cheaper path to `tile` was already
        // relaxed after this one was pushed. `node.f` was computed from
        // the `g` in effect at push time, so a mismatch against the
        // CURRENT best proves this entry is obsolete.
        if node.f != g_here.saturating_add(node.h) {
            continue;
        }
        if tile == goal_tile {
            break;
        }
        let Some(edges) = adjacency.get(&tile) else {
            continue;
        };
        for &(portal_id, neighbour, length_m, multiplier, directional_penalty_mm) in edges {
            // §11's additive penalty is applied AFTER the soft-preference
            // multiplier (it is a fixed cost in mm, not a scale), and is
            // non-negative — so the search heuristic ([`heuristic_mm`] at
            // [`MIN_MULTIPLIER`]) stays an admissible lower bound exactly
            // as it was: forbidden edges only remove options, a penalty
            // only raises real cost.
            let step = step_cost_mm(length_m, multiplier).saturating_add(directional_penalty_mm);
            let candidate = g_here.saturating_add(step);
            if candidate < *g.get(&neighbour).unwrap_or(&i64::MAX) {
                g.insert(neighbour, candidate);
                came_from.insert(neighbour, (portal_id, tile));
                let h = heuristic(neighbour);
                open.push(Reverse(OpenNode {
                    f: candidate.saturating_add(h),
                    h,
                    cell_id: neighbour,
                }));
            }
        }
    }

    let cost_mm = *g.get(&goal_tile)?;
    let mut hops = Vec::new();
    let mut current = goal_tile;
    // Bounded by `built.tiles.len()`: a real path never revisits a tile
    // (`g` only accepts a STRICTLY smaller cost, so a real cycle back to
    // an already-settled tile could never have been relaxed), so this
    // cannot fire on well-formed data — defense-in-depth against a
    // corrupted/degenerate `BuiltRegion` where two distinct tile indices
    // share an identical centre point (a zero-length edge), the one
    // shape that could otherwise turn this walk into an infinite loop.
    for _ in 0..=built.tiles.len() {
        if current == start_tile {
            break;
        }
        let &(portal, prev) = came_from.get(&current)?;
        hops.push(TopologyHop {
            portal,
            tile: prev,
            neighbour_tile: current,
        });
        current = prev;
    }
    if current != start_tile {
        return None; // corrupted input outran the bound above
    }
    hops.reverse();

    // §8.3 demotion: which portals ON this route are marginal-width at
    // `min_beam_dm`. `min_beam_dm == 0` short-circuits to empty. Looked
    // up by `find` rather than `portals[id]` so a caller that hands in a
    // filtered/reordered slice still gets a correct answer (or simply no
    // match, which reads as "not demoted" — the safe direction, since
    // nothing is rejected).
    let demoted_portals: Vec<u32> = if min_beam_dm == 0 {
        Vec::new()
    } else {
        let mut ids: Vec<u32> = hops
            .iter()
            .filter(|hop| {
                portals
                    .iter()
                    .find(|p| p.id == hop.portal)
                    .is_some_and(|p| p.min_horizontal_width_dm < min_beam_dm)
            })
            .map(|hop| hop.portal)
            .collect();
        ids.dedup();
        ids
    };

    // §11 diagnostics parity with `demoted_portals`: which portals ON
    // the chosen route carried a wrong-side lateral penalty. Recomputed
    // per hop (the route is already priced with the penalty folded in —
    // this only reports it), same `find`-by-id-not-index discipline the
    // demotion pass above uses so a filtered/reordered `portals` slice
    // stays safe. Empty whenever no directional store was in play.
    let directional_penalized_portals: Vec<u32> = if semantics.is_none() {
        Vec::new()
    } else {
        let mut ids: Vec<u32> = hops
            .iter()
            .filter(|hop| {
                portals
                    .iter()
                    .find(|p| p.id == hop.portal)
                    .map(&portal_rule)
                    .is_some_and(|r| matches!(r, TransitionRule::Penalized { .. }))
            })
            .map(|hop| hop.portal)
            .collect();
        ids.dedup();
        ids
    };

    Some(TopologyRoute {
        start_tile,
        goal_tile,
        hops,
        cost_mm,
        demoted_portals,
        directional_penalized_portals,
    })
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/// A world point resolved to its containing cell in `built`'s own
/// lattice — see the module docs for what this does and does not check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Snap {
    pub tile: u32,
    pub col: u32,
    pub row: u32,
    /// The persisted lattice's own canonical point for this cell —
    /// [`super::field::TileEntry::centre_of`], not the raw query point.
    pub cell_centre: WorldXy,
    /// `bands::global_index(tile, col, row)` — the flat SoA index a
    /// caller needs to check `flags`/`depth_min`/`depth_max` directly.
    pub global_index: usize,
}

/// The tile in `built.tiles` containing `point`, or `None` when `point`
/// falls outside every tile this region actually built (including the
/// region's own outer boundary). Matches `TileEntry::cell_of`'s own
/// half-open `[origin, origin + cols*cell_world)` containment exactly —
/// NOT `Extent::contains_point`, which is fully INCLUSIVE on both ends
/// (found by code review: the inclusive check let a point sitting
/// exactly on a shared seam between two adjacent tiles match BOTH of
/// them, silently picking whichever tile happened to sort first in
/// `built.tiles` rather than the one `cell_of`'s own half-open rule
/// actually owns that boundary — and then `snap_point` below would call
/// `cell_of` on the WRONG tile, get `None` from ITS OWN in-range check,
/// and misreport "outside the region" for a point that was actually
/// sitting on an ordinary internal seam). Delegating to `cell_of`
/// directly, instead of a second hand-written boundary rule, makes the
/// two functions structurally unable to disagree again.
pub fn find_tile(built: &BuiltRegion, point: WorldXy) -> Option<u32> {
    built
        .tiles
        .iter()
        .position(|t| t.cell_of(point).is_some())
        .map(|i| i as u32)
}

/// §13.1's canonical snap: `point` to the centre of the finest cell
/// containing it. `None` when `point` is outside the built region
/// entirely (see [`find_tile`]) — deliberately NOT when the snapped
/// cell is unnavigable; see the module docs for why that check does not
/// belong here.
pub fn snap_point(built: &BuiltRegion, point: WorldXy) -> Option<Snap> {
    let tile_idx = find_tile(built, point)?;
    let tile = built.tiles.get(tile_idx as usize)?;
    let (col, row) = tile.cell_of(point)?;
    Some(Snap {
        tile: tile_idx,
        col,
        row,
        cell_centre: tile.centre_of(col, row),
        global_index: global_index(tile, col, row),
    })
}

// ---------------------------------------------------------------------------
// §9.3's grace, ported to tile granularity
// ---------------------------------------------------------------------------

/// Cap on how many candidate tiles [`topology_route_graced`] will try per
/// endpoint — defensive, not a tuning knob a real caller should ever need
/// to hit: §9.3's grace is meant to bridge a marina berth a few cells
/// across, not turn a misconfigured huge `grace_radius_m` into an
/// unbounded scan of `built.tiles`.
const MAX_GRACE_CANDIDATES: usize = 8;

/// `topology_route_graced`'s own ranking key — see that function's docs.
type RankKey = (f64, i64, u32, u32);

/// Does `tile` have at least one [`Portal`] usable at `required_draft_dm`
/// — i.e. does the topology graph actually reach it at all, at this
/// draft?
fn tile_has_usable_portal(tile: u32, portals: &[Portal], required_draft_dm: u16) -> bool {
    portals
        .iter()
        .any(|p| p.tile == tile && p.max_draft_dm >= required_draft_dm)
}

/// A [`Snap`] for `tile`'s own geometric centre cell — not a real query
/// point's cell, since a grace candidate tile was never actually clicked
/// on; its own centre is the same coarse, honest representative point
/// [`super::shortcuts`]/[`corridor_extent`] already use for tile-level
/// geometry (extent midpoints), not a claim about where in the tile the
/// vessel truly is.
fn tile_centre_snap(tile_idx: u32, tile: &TileEntry) -> Snap {
    let col = u32::from(tile.cols) / 2;
    let row = u32::from(tile.rows) / 2;
    Snap {
        tile: tile_idx,
        col,
        row,
        cell_centre: tile.centre_of(col, row),
        global_index: global_index(tile, col, row),
    }
}

/// Candidate snap tiles for `point`, in the order [`topology_route_graced`]
/// should try them, paired with how far (real metres) each one's own
/// [`Snap::cell_centre`] sits from `point` — [`topology_route_graced`]
/// needs that distance to rank PAIRS jointly, not just to order one
/// endpoint's own list (see that function's own docs for why "closest
/// first, tried in list order" alone is not enough).
///
/// The DIRECT [`snap_point`] result is always first (unconditionally —
/// even when it has no usable portal, so a `start_tile == goal_tile`
/// trivial "already there" route, which [`topology_route`] returns
/// regardless of portal presence, is never broken by this wrapper), then
/// — only when `grace_radius_m > 0.0` — every OTHER tile within
/// `grace_radius_m` real metres that DOES have a usable portal, nearest
/// first, ties broken by ascending tile id for determinism, capped at
/// [`MAX_GRACE_CANDIDATES`] (the cap keeps the CLOSEST candidates on
/// this axis, dropping the farthest — the sort exists for that, even
/// though the final joint ranking in [`topology_route_graced`] no longer
/// depends on this list's own iteration order). Empty when `point` is
/// outside the built region entirely (`snap_point` itself returns
/// `None`) — grace never extends the region's own outer boundary, only
/// which tile *within* it a point maps to.
fn candidate_snaps(
    built: &BuiltRegion,
    portals: &[Portal],
    point: WorldXy,
    required_draft_dm: u16,
    grace_radius_m: f64,
) -> Vec<(f64, Snap)> {
    let Some(direct) = snap_point(built, point) else {
        return Vec::new();
    };
    let mut candidates = vec![(world_distance_m(point, direct.cell_centre), direct)];
    if grace_radius_m > 0.0 {
        let mut nearby: Vec<(f64, u32, Snap)> = built
            .tiles
            .iter()
            .enumerate()
            .filter(|&(i, _)| i as u32 != direct.tile)
            .filter(|&(i, _)| tile_has_usable_portal(i as u32, portals, required_draft_dm))
            .filter_map(|(i, t)| {
                let snap = tile_centre_snap(i as u32, t);
                let d = world_distance_m(point, snap.cell_centre);
                (d <= grace_radius_m).then_some((d, i as u32, snap))
            })
            .collect();
        nearby.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        candidates.extend(
            nearby
                .into_iter()
                .take(MAX_GRACE_CANDIDATES.saturating_sub(1))
                .map(|(d, _, s)| (d, s)),
        );
    }
    candidates
}

/// [`topology_route`], with §9.3's own endpoint grace mechanism
/// (`routing::artifact::search::Field::walkable`'s bounded tolerance for
/// short unsurveyed gaps near a real endpoint) ported to this layer's own
/// tile granularity — the exact reconciliation `topology.rs`'s own module
/// docs flag as still open: "a real corridor that only exists by crossing
/// a short no-coverage gap near an endpoint would appear as two
/// disconnected components here and could be pruned before the fine
/// search — which DOES grace such gaps — ever gets a chance to find it."
///
/// When the DIRECT snap of `from`/`to` already reaches a real
/// [`topology_route`], this returns exactly that — identical to calling
/// [`snap_point`] and [`topology_route`] by hand, no behaviour change.
/// Only when the direct pairing fails does this widen the search: EVERY
/// candidate start paired with EVERY candidate goal (see
/// [`candidate_snaps`]; each list is already capped at
/// [`MAX_GRACE_CANDIDATES`], so this is at most
/// `MAX_GRACE_CANDIDATES²` [`topology_route`] calls, not unbounded) is
/// tried, and the WINNER is the pairing with the smallest total endpoint
/// displacement (`start`'s own distance from `from` plus `goal`'s from
/// `to`, in real metres — how far grace had to reach on both ends
/// combined), route cost, then tile ids breaking any remaining tie,
/// fully deterministically.
///
/// An earlier version of this function returned the FIRST pairing found
/// while trying start candidates outer, goal candidates inner — nearest
/// PER AXIS, but not nearest as a PAIR: found by code review, with a
/// concrete counterexample, that this could settle on a needlessly
/// distant substitute for one endpoint (the direct-snap start, which
/// happened to connect via a long detour to a far goal candidate) while
/// a much closer, equally valid pairing existed further down a
/// differently-sorted list and was never tried. Evaluating the full
/// product and ranking by total displacement fixes that: with both
/// candidate lists this small, the product is cheap, and the answer no
/// longer depends on which axis happens to be the outer loop.
///
/// This never INVENTS connectivity: every candidate tile was only ever
/// tried because [`detect_portals`] already found it a real usable
/// portal, and [`topology_route`] itself still performs the real
/// connectivity search on every pairing — grace only ever widens which
/// TILE an endpoint is allowed to map to, exactly the same "first/last
/// leg only" spirit the fine search's own per-cell grace already applies,
/// scoped up one level of granularity to match this layer's own.
///
/// Returns the route together with the actual [`Snap`]s used, since a
/// graced endpoint may not be the literal tile `from`/`to` fell in — a
/// caller building a corridor or handing coordinates to the fine search
/// needs to know which tile the route actually starts/ends at.
///
/// `None` when either point is outside the built region entirely, or no
/// candidate pairing connects — the same honest "no route found"
/// [`topology_route`] itself already returns, not a distinct error case.
pub fn topology_route_graced(
    built: &BuiltRegion,
    portals: &[Portal],
    from: WorldXy,
    to: WorldXy,
    required_draft_dm: u16,
    grace_radius_m: f64,
) -> Option<(TopologyRoute, Snap, Snap)> {
    topology_route_graced_with(
        built,
        portals,
        from,
        to,
        required_draft_dm,
        grace_radius_m,
        TopologyWeights::default(),
    )
}

/// [`topology_route_graced`], with [`TopologyWeights`]'s own soft
/// preferences applied to every candidate pairing's own search — see
/// [`topology_route_with`]'s docs for the cost model, and [`topology_
/// route_graced`]'s own docs (still accurate here) for the grace
/// mechanism itself.
#[allow(clippy::too_many_arguments)]
pub fn topology_route_graced_with(
    built: &BuiltRegion,
    portals: &[Portal],
    from: WorldXy,
    to: WorldXy,
    required_draft_dm: u16,
    grace_radius_m: f64,
    weights: TopologyWeights,
) -> Option<(TopologyRoute, Snap, Snap)> {
    graced_core(
        built,
        portals,
        from,
        to,
        required_draft_dm,
        grace_radius_m,
        0,
        None,
        weights,
    )
}

/// [`topology_route_graced_with`], plus §8.3's width demotion — see
/// [`topology_route_demoting`] for exactly what `min_beam_dm` does (kept
/// as an edge, recorded in [`TopologyRoute::demoted_portals`], never
/// rejected). `min_beam_dm == 0` is identical to
/// [`topology_route_graced_with`].
///
/// `semantics` is §11's directional / buoyage store (Phase 7) — see
/// [`topology_route_demoting`] for exactly what it does (forbid an
/// against-flow crossing, penalise a wrong-side lateral crossing). Every
/// candidate endpoint pairing's own search gets it. `None` is
/// byte-identical to the pre-Phase-7 behaviour.
#[allow(clippy::too_many_arguments)]
pub fn topology_route_graced_demoting(
    built: &BuiltRegion,
    portals: &[Portal],
    from: WorldXy,
    to: WorldXy,
    required_draft_dm: u16,
    grace_radius_m: f64,
    min_beam_dm: u16,
    semantics: Option<&DirectionalSemantics>,
    weights: TopologyWeights,
) -> Option<(TopologyRoute, Snap, Snap)> {
    graced_core(
        built,
        portals,
        from,
        to,
        required_draft_dm,
        grace_radius_m,
        min_beam_dm,
        semantics,
        weights,
    )
}

#[allow(clippy::too_many_arguments)]
fn graced_core(
    built: &BuiltRegion,
    portals: &[Portal],
    from: WorldXy,
    to: WorldXy,
    required_draft_dm: u16,
    grace_radius_m: f64,
    min_beam_dm: u16,
    semantics: Option<&DirectionalSemantics>,
    weights: TopologyWeights,
) -> Option<(TopologyRoute, Snap, Snap)> {
    let starts = candidate_snaps(built, portals, from, required_draft_dm, grace_radius_m);
    let goals = candidate_snaps(built, portals, to, required_draft_dm, grace_radius_m);

    // Rank key: (total endpoint displacement, route cost, start tile,
    // goal tile) — `total_cmp` on the float field keeps this a genuine
    // total order (our distances are always finite, never NaN, but
    // `total_cmp` costs nothing to use defensively here regardless). A
    // named alias, not an inline tuple type, purely to satisfy clippy's
    // `type_complexity` — same reason `shortcuts.rs`'s own `SeamKey`
    // exists.
    let mut best: Option<(RankKey, TopologyRoute, Snap, Snap)> = None;
    for &(start_d, start) in &starts {
        for &(goal_d, goal) in &goals {
            let Some(route) = route_core(
                built,
                portals,
                start.tile,
                goal.tile,
                required_draft_dm,
                min_beam_dm,
                semantics,
                weights,
            ) else {
                continue;
            };
            let key = (start_d + goal_d, route.cost_mm, start.tile, goal.tile);
            let is_better = best.as_ref().is_none_or(|(best_key, ..)| {
                key.0
                    .total_cmp(&best_key.0)
                    .then(key.1.cmp(&best_key.1))
                    .then(key.2.cmp(&best_key.2))
                    .then(key.3.cmp(&best_key.3))
                    == std::cmp::Ordering::Less
            });
            if is_better {
                best = Some((key, route, start, goal));
            }
        }
    }
    best.map(|(_, route, start, goal)| (route, start, goal))
}

// ---------------------------------------------------------------------------
// Corridor extraction
// ---------------------------------------------------------------------------

/// The union of every tile's own extent along `route` (including its
/// `start_tile`, even when `hops` is empty for a same-tile route),
/// padded outward by `pad_m` REAL METRES on every side — see the module
/// docs for why this coarse a corridor is still a correct, if loose,
/// first cut. `Extent::invalid()` (see `coords::Extent`) if
/// `route.start_tile` is not actually one of `built.tiles` (a caller
/// passing a `TopologyRoute` built from a DIFFERENT `BuiltRegion` —
/// nothing downstream should ever do this, but nothing here trusts the
/// caller not to).
///
/// `pad_m` is converted to World units via
/// [`radius_world_units`](crate::routing::hazards::radius_world_units)
/// at the corridor's own midpoint — an EARLIER version passed `pad_m`
/// straight into `Extent::expand`, which takes raw World units, not
/// metres (found by code review, same root cause as
/// `TileEntry::centre_distance_m`'s own fix: `COORD_FACTOR` is units per
/// 360° of longitude, not units per metre). Every real caller asking for
/// "500 m of margin" was actually getting roughly 500 World units, well
/// under two cells of even the coarsest ladder rung.
pub fn corridor_extent(built: &BuiltRegion, route: &TopologyRoute, pad_m: f64) -> Extent {
    let mut acc = Extent::invalid();
    if let Some(start) = built.tiles.get(route.start_tile as usize) {
        acc.extend(&start.extent());
    }
    for hop in &route.hops {
        if let Some(t) = built.tiles.get(hop.neighbour_tile as usize) {
            acc.extend(&t.extent());
        }
    }
    if !acc.valid {
        return acc;
    }
    // A negative or non-finite pad is a caller bug, not license to
    // SHRINK the corridor below what the route itself already spans —
    // clamped to 0 rather than trusted. `radius_world_units` already
    // takes a metres radius directly (its own `radius_m<=0.0` guard
    // returns 0.0 too) — called once with the real `pad_m`, not
    // decomposed into a per-metre rate and multiplied, so there is
    // exactly one rounding step between "metres requested" and "world
    // units applied", not two.
    let pad_m = if pad_m.is_finite() {
        pad_m.max(0.0)
    } else {
        0.0
    };
    let pad_units = radius_world_units(acc.midpoint(), pad_m).round();
    // `as i32` saturates on a huge finite `pad_m` (well-defined float->int
    // cast, no UB/wraparound) rather than growing the corridor unboundedly.
    acc.expanded(pad_units as i32, pad_units as i32)
}

// ---------------------------------------------------------------------------
// Corridor SCOPING — which candidate cells the fine search is handed
// ---------------------------------------------------------------------------

/// The round-trip slack, in World units, [`corridor_scope_extent`] grows
/// the fine search's own corridor box by after converting it back out of
/// degrees.
///
/// [`crate::routing::corridor_bbox_lonlat`] is the ONLY public way to ask
/// `routing::raster` for that box (its `Corridor` type is private), and it
/// answers in degrees. Converting back with `lon_to_worldx`/`lat_to_worldy`
/// is a float round trip through a `floor()`, so the recovered integer can
/// land one unit INSIDE the original. One World unit is ~7.5 cm at the
/// equator (`COORD_FACTOR` is 2^29 units for the whole earth), so two units
/// of slack costs ~15 cm of extra box and buys an exact guarantee that the
/// recovered box is never SMALLER than the one the fine search will really
/// use — the only direction that matters here.
///
/// MEASURED, not assumed: `the_recovered_search_corridor_never_comes_back_
/// smaller_than_the_real_one` (below) reconstructs the real widest corridor
/// from `routing::raster`'s own constants and compares. At `0` slack it
/// FAILS on a real pair — a San Francisco Bay approach leg comes back one
/// unit short on its south edge. `2` is that measured loss plus one, the
/// same "keep real margin over the point where behaviour stops changing"
/// choice `routing::raster::REFINE_PAD_FLOOR_M` documents for its own
/// measured floor.
const SCOPE_ROUND_TRIP_SLACK_UNITS: i32 = 2;

/// How far past the topology route's own tile extents
/// [`corridor_scope_extent`] grows its corridor term, in real metres.
///
/// The topology corridor tracks TILE-granularity hops. The fine search's
/// actual path is finer than that in every direction: it detours around
/// individual hazards, walks §12.3's supercover line of sight, snaps and
/// graces its endpoints, and buffers every hard feature by
/// `lateral_margin_m` plus the CATZOC horizontal figure. So a real
/// fine-search route can legitimately leave a tightly-padded topology
/// corridor, and the pad has to cover the two request-level distances that
/// bound how far:
///
/// * `endpoint_grace_radius_m` (§9.3) — the fine search may snap an
///   endpoint, and route the first/last leg, up to this far from the
///   REQUESTED point, i.e. outside every tile the topology layer ever
///   looked at.
/// * `lateral_margin_m` — every hard feature is inflated by this much, so
///   the water the fine search actually has to steer through can sit this
///   much further from the obstacle than the tile lattice suggests.
///
/// Both are ADDED, not maxed: they act at the same place (an endpoint
/// inside a margin-inflated basin needs both), and this is the
/// larger/safer of the two readings — the same conservative-direction
/// rule [`select_band`] applies to a bad draft and
/// [`super::portals::Portal::min_horizontal_width_dm`] applies to
/// unmeasurable water.
///
/// Non-finite or negative inputs contribute `0.0` rather than poisoning
/// the sum; the result is never negative.
///
/// This pad is deliberately NOT the whole safety story — see
/// [`corridor_scope_extent`], which unions the padded corridor with the
/// fine search's own maximal corridor box precisely because no pad
/// derived from request parameters alone can be *proven* sufficient.
pub fn corridor_scope_pad_m(endpoint_grace_radius_m: f64, lateral_margin_m: f64) -> f64 {
    let sane = |v: f64| if v.is_finite() { v.max(0.0) } else { 0.0 };
    sane(endpoint_grace_radius_m) + sane(lateral_margin_m)
}

/// The world-space box it is SAFE to filter the fine search's candidate
/// cells to, given a found [`TopologyRoute`] — the union of
///
/// 1. [`corridor_extent`]`(built, route, pad_m)`, the topology corridor
///    itself (see [`corridor_scope_pad_m`] for the pad),
/// 2. the raw `from`/`to` query points, so the box provably contains both
///    endpoints whatever the topology layer snapped them to, and
/// 3. **the fine search's own maximal corridor box** —
///    [`crate::routing::corridor_bbox_lonlat`], which is
///    `routing::raster::Corridor::around(from, to, CORRIDOR_PAD_FACTORS
///    [2])`: the WIDEST widen-retry attempt
///    `routing::artifact::search::search` will ever rasterize.
///
/// [`Extent::invalid`] when the degrees→World round trip of term 3 comes
/// back malformed — specifically when `worldx_to_lon`'s ±180° wrap leaves
/// the recovered west edge EAST of the east edge, which is what an
/// antimeridian-crossing corridor does (verified in both crossing
/// directions). [`filter_cells_to_corridor`] treats an invalid box as "do
/// not filter", so such a query falls back to the caller's full cell set
/// rather than a wrongly-shaped one. Terms 1 and 2 alone never produce an
/// invalid result: `extend_point` adopts `from` on an invalid accumulator,
/// so a `route` whose `start_tile` is not in `built` still yields a valid
/// (if tiny) box.
///
/// # NOTHING IN THIS TREE USES THIS TO FILTER, AND THAT IS THE POINT
///
/// **The bar this mechanism is held to: scoping may change the COST of
/// computing a route, never the ANSWER.** A route the unscoped fine search
/// finds must still be found, byte for byte, after scoping — the same
/// conservative-direction rule stated for [`select_band`]'s rounding, for
/// [`corridor_scope_pad_m`]'s addition, and for [`super::portals`]'
/// `min_horizontal_width` saturation: when two readings are defensible,
/// take the one that cannot lose a real route.
///
/// **This function cannot meet that bar, and neither can any tighter one
/// written from outside `routing::artifact`.** An earlier draft wired
/// `crate::python::mivnav_route` to filter by this box and argued term 3
/// made it safe. It does not. `routing::artifact::constraints::build`
/// derives two REGION-GLOBAL scalars over whatever cell slice it is
/// handed, with no spatial restriction whatsoever:
///
/// * `compilation_scale` — the finest nonzero CSCL over every cell.
/// * `catzoc_horizontal_m` — the coarsest §3.4 horizontal figure applied
///   anywhere, including the unzoned-U fallback (1000 m under
///   `CatzocMode::Full`) that EVERY hard feature outside an `M_QUAL` zone
///   contributes, from any distance at all.
///
/// Both feed `routing::artifact::ladder::finest_allowed_cell_m`, i.e. the
/// resolution rung the corridor grid is built at, so dropping one cell
/// moves every grid cell centre. `compilation_scale` can be guarded
/// exactly and cheaply ([`filter_cells_to_corridor`] does), but
/// `catzoc_horizontal_m` cannot be without re-walking §3.3's whole hard
/// class list — and the "it is covered structurally, because term 3 keeps
/// everything the fine search could rasterize" argument is simply FALSE: a
/// cell contributes to that scalar by EXISTING with a hard feature, not by
/// being near the route.
///
/// The measured counterexample, reproduced as
/// `dropping_a_distant_cell_can_change_the_route_via_the_catzoc_scalar`
/// (below) so it can never quietly stop being true — two cells, backend
/// defaults (`CatzocMode::Full`, `lateral_margin_m = 30.0`), with the far
/// cell placed so term 3 provably does NOT reach it and the filter really
/// does drop it:
///
/// ```text
/// term3 reaches the far cell?  false     (so it IS dropped)
/// unscoped  catzoc_h=1000  ladder=256 m  dist=1144.86 m
/// scoped    catzoc_h=   5  ladder=  8 m  dist=1103.30 m
/// ```
///
/// Two further gaps, found by the same review and not measured to a route
/// change but real in the code, so listed rather than forgotten:
///
/// * `routing::artifact::search::build_field` snaps its grid to a GLOBAL
///   lattice, so the rasterized field runs one to two full grid cells
///   PAST the corridor box on each side (hundreds of metres at a coarse
///   rung). A cell in that fringe is droppable by term 3 yet does
///   contribute rings — and its `M_COVR` statement, whose absence §3.3
///   turns into blocking UNKNOWN water.
/// * every hard feature is inflated by `lateral_margin_m +
///   catzoc_horizontal_m` (up to 1000 m from the unzoned fallback alone,
///   and `lateral_margin_m` has no upper bound in config), so geometry
///   from a cell outside the box can reach inside it.
///
/// Closing all three means expanding term 3 by `lateral_margin_m +
/// allowance(None, catzoc_mode).horizontal_m + 2 * ladder_cell_m` AND
/// giving `constraints::build` (or the already-public
/// `routing::route_with_constraints`) a way to be handed the two scalars
/// computed over the UNFILTERED slice. That is real work inside
/// `routing::artifact`, deliberately not done here.
///
/// # And the perf case does not justify hurrying it
///
/// The backend's own candidate-cell selection
/// (`mivnav.features.routing.hazards._bbox_around` →
/// `chartcore.routing_corridor_bbox`) resolves to the same
/// `routing::raster::Corridor::around(from, to, CORRIDOR_PAD_FACTORS[2])`
/// term 3 does, by explicit design ("one source of truth for how wide an
/// area does this route need", that function's own docs). So the filter
/// drops nothing for any caller in this repo — measured, on the real
/// fixtures — and the only regime where it does anything at all is exactly
/// the over-selecting regime where the hole above bites. Measured cost
/// either way (release, real FNC fixtures): the fine search takes 5.6 ms
/// over one cell and 6.1 ms over two, so a dropped cell is worth ~0.5 ms;
/// the topology pipeline that produces the corridor costs 176-234 ms
/// rebuilt per request. Corridor scoping cannot pay for itself before the
/// `.mivnav` artifact is actually persisted.
///
/// One caveat on "drops nothing", so the claim is not overstated: the
/// backend selects on each cell's DECLARED header extent in degrees, while
/// this filter tests `crate::model::Cell::extent`, the union of the cell's
/// feature extents in World units. They are not the same quantity. On both
/// real fixtures the union is 1-2 World units LARGER on every edge (i.e.
/// the safe direction), measured — but that is an observation about these
/// chart sets, not a property.
pub fn corridor_scope_extent(
    built: &BuiltRegion,
    route: &TopologyRoute,
    from: WorldXy,
    to: WorldXy,
    pad_m: f64,
) -> Extent {
    let mut acc = corridor_extent(built, route, pad_m);
    acc.extend_point(from);
    acc.extend_point(to);
    if let Some(search_box) = fine_search_corridor_extent(from, to) {
        acc.extend(&search_box);
    } else {
        // The one box that MUST be covered could not be recovered — say
        // "do not filter" rather than filter against a partial answer.
        return Extent::invalid();
    }
    acc
}

/// The fine search's own widest corridor box in World units, recovered
/// through [`crate::routing::corridor_bbox_lonlat`] (the only public
/// entry point to it) and grown by [`SCOPE_ROUND_TRIP_SLACK_UNITS`].
/// `None` when the degrees round trip comes back malformed — see
/// [`corridor_scope_extent`].
fn fine_search_corridor_extent(from: WorldXy, to: WorldXy) -> Option<Extent> {
    let (west, south, east, north) = crate::routing::corridor_bbox_lonlat(from, to);
    if !(west.is_finite() && south.is_finite() && east.is_finite() && north.is_finite()) {
        return None;
    }
    let ext = LLBox {
        w_lon: west,
        e_lon: east,
        n_lat: north,
        s_lat: south,
    }
    .to_world();
    // `worldx_to_lon` wraps into ±180°, so an antimeridian-crossing
    // corridor comes back with its west edge EAST of its east edge (true
    // in BOTH crossing directions — checked, not assumed). That box is
    // not the one the fine search will use, and silently filtering
    // against it could drop a real cell, so refuse instead.
    //
    // This does NOT catch the polar case, and does not claim to: past
    // `coords::MAX_LAT` the round trip CLAMPS rather than inverting, so
    // the box comes back valid but ~497 World units short on its north
    // edge — far past `SCOPE_ROUND_TRIP_SLACK_UNITS`. Reach is a corridor
    // whose north edge passes above 85.0511°N (so a route above ~84.6°N),
    // which is outside anything this crate charts; recorded here rather
    // than guarded, because a guard nothing can reach is a guard nothing
    // tests. Tighten to `ymin <= lat_to_worldy(MAX_LAT)` if that ever
    // stops being true.
    if ext.xmin > ext.xmax || ext.ymin > ext.ymax {
        return None;
    }
    Some(ext.expanded(SCOPE_ROUND_TRIP_SLACK_UNITS, SCOPE_ROUND_TRIP_SLACK_UNITS))
}

/// Every cell of `cells` whose own extent reaches `scope`, in the SAME
/// order.
///
/// **Nothing in this tree calls this.** It is the filter half of a
/// corridor-scoping mechanism that [`corridor_scope_extent`]'s docs show
/// cannot currently be made answer-preserving — read those first; the
/// function is kept public, tested and honest so the next attempt starts
/// from what was measured rather than from the function name.
///
/// Input order is preserved because it is load-bearing:
/// `routing::artifact::constraints::build`'s `M_QUAL` zone lookup is
/// first-match per cell and the backend hands cells finest-scale-first on
/// purpose (§13's determinism rule — see `hazards.py`'s `cells_for_line`).
/// A filter that reordered would be a determinism bug even if it kept
/// exactly the same cells.
///
/// # Three ways this refuses to filter
///
/// The bar is stated in full on [`corridor_scope_extent`]: scoping may
/// change what a route COSTS to compute, never what it IS. Each of these
/// is a case where the safe answer is the caller's untouched slice, not a
/// clever one:
///
/// 1. **`scope` is invalid.** This is what a caller passes when the
///    topology layer found no route, or could not run at all (no band, no
///    portals, an empty region). A topology `None` is never the final word
///    on routability — [`select_band`]'s own docs spell out why (the
///    quantised-feasibility gap: a draft between two `BAND_LADDER_M` rungs
///    can make this layer report no path where the exact fine search still
///    finds one), and it must therefore never narrow what the fine search
///    is allowed to look at. Input returned unchanged.
/// 2. **Nothing survived.** An empty result from a non-empty input means
///    the scope was computed in the wrong space, or against a different
///    region than the cells came from — not that the caller handed over
///    cells with no bearing on their own query. Input returned unchanged.
///    (The weaker floor "at least the cells containing the raw endpoints
///    survive" is guaranteed by construction rather than checked here:
///    [`corridor_scope_extent`] extends its box over `from` and `to`
///    explicitly, so any cell containing either endpoint intersects it.)
/// 3. **The finest compilation scale did not survive.** Dropping the one
///    cell carrying the region's finest nonzero CSCL changes
///    `constraints::build`'s `compilation_scale`, hence
///    `ladder::finest_allowed_cell_m`, hence the corridor grid's rung,
///    hence every cell centre and the route itself — see
///    [`corridor_scope_extent`] for the full mechanism. Cheap to check
///    exactly (one `u32` read per cell) and exact, so it is checked rather
///    than argued about. Input returned unchanged.
///
/// A cell whose own extent is INVALID is always kept: an extent that makes
/// no claim cannot be proven irrelevant, and `Extent::intersects` reports
/// `false` for an invalid operand, which would silently drop it.
///
/// `catzoc_horizontal_m`, the OTHER global scalar
/// [`corridor_scope_extent`] names, gets NO check here, and there is no
/// cheap exact one to add: deriving a single cell's contribution means a
/// second copy of §3.3's whole hard class list, which would drift from
/// the first. That unguarded scalar is exactly the hole that keeps this
/// function unwired — see `corridor_scope_extent`'s own measured
/// counterexample. Do not read the two guards above as making this
/// operation safe; they make it *less* unsafe.
pub fn filter_cells_to_corridor<'a>(cells: &[&'a Cell], scope: Extent) -> Vec<&'a Cell> {
    if !scope.valid {
        return cells.to_vec();
    }
    let kept: Vec<&'a Cell> = cells
        .iter()
        .copied()
        .filter(|c| !c.extent.valid || scope.intersects(&c.extent))
        .collect();
    if kept.len() == cells.len() {
        return kept;
    }
    if kept.is_empty() || finest_compilation_scale(&kept) != finest_compilation_scale(cells) {
        return cells.to_vec();
    }
    kept
}

/// The finest (numerically smallest) NONZERO compilation-scale
/// denominator over `cells`, or `0` when none recorded one — the exact
/// quantity `routing::artifact::constraints::build` computes as its own
/// `finest_scale`, duplicated here only to compare two slices of the same
/// input without running the (much more expensive) constraint build twice.
fn finest_compilation_scale(cells: &[&Cell]) -> u32 {
    cells
        .iter()
        .map(|c| c.meta.compilation_scale)
        .filter(|&s| s != 0)
        .min()
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// §14 — a route plus a statement of how close to optimal it is
// ---------------------------------------------------------------------------

/// §16's verification outcome for a returned route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationStatus {
    /// Every leg was confirmed clear of the hard-constraint union by
    /// `routing::raster::verify_route_legs` (§16's exact check).
    Verified,
    /// At least one leg could not be confirmed clear — the same meaning
    /// [`crate::routing::ArtifactRoute::approximate_legs`] carries. The
    /// route is still the search's best answer; a human should look at
    /// the flagged legs.
    ApproximateLegs,
    /// No verification was run. Never produced by the pipeline today —
    /// reserved for a future fast path that deliberately skips §16.
    Unverified,
}

impl VerificationStatus {
    /// The wire spelling, shared with the backend `debug_legs` block and
    /// the frontend routing debug panel.
    pub fn as_str(self) -> &'static str {
        match self {
            VerificationStatus::Verified => "verified",
            VerificationStatus::ApproximateLegs => "approximate_legs",
            VerificationStatus::Unverified => "unverified",
        }
    }
}

/// §14's route result: the route, plus a statement of how close to
/// optimal it provably is.
///
/// **Not** retrofitted onto [`crate::routing::ArtifactRoute`], which
/// deliberately claims nothing about optimality and stays that way — this
/// is the `mivnav` pipeline's own richer answer, assembled from that fine
/// route ([`Self::from_fine_route`]) plus the best lower bound the
/// precompute affords.
#[derive(Debug, Clone, PartialEq)]
pub struct RouteResult {
    pub waypoints: Vec<(f64, f64)>,
    /// The route's own integrated cost, millimetre fixed-point (§13.1) —
    /// [`crate::routing::ArtifactDiagnostics::route_cost_mm`] verbatim.
    pub route_cost_mm: i64,
    /// The best lower bound known on the OPTIMAL route cost between these
    /// endpoints: the larger of the straight-line great-circle bound
    /// ([`straight_line_lower_bound_mm`]) and the §14 ALT landmark bound
    /// ([`super::landmarks::BandLandmarks::lower_bound_mm`]). `0` only
    /// when neither was available (no built artifact and a degenerate
    /// straight line).
    pub best_known_lower_bound_mm: i64,
    /// `(route_cost_mm − best_known_lower_bound_mm) / best_known_lower_bound_mm`,
    /// clamped at `0.0`, and `0.0` when the bound is `0`. Small means
    /// "provably near-optimal". It is an UPPER bound on the true gap —
    /// the denominator is itself only a lower bound, so the real route
    /// can only be closer to optimal than this says, never further.
    pub optimality_gap: f64,
    pub verification_status: VerificationStatus,
    pub approximate_legs: Vec<bool>,
    pub check_manually_legs: Vec<bool>,
}

impl RouteResult {
    /// Assemble a result from a fine-search route and the best lower
    /// bound already known (millimetre fixed-point; pass `0` when none is
    /// available). The caller is expected to have taken the `max` of the
    /// straight-line term and any ALT term — see
    /// [`straight_line_lower_bound_mm`] and
    /// [`super::landmarks::BandLandmarks::lower_bound_mm`].
    pub fn from_fine_route(
        route: &crate::routing::ArtifactRoute,
        best_known_lower_bound_mm: i64,
    ) -> RouteResult {
        let cost = route.diagnostics.route_cost_mm;
        let lb = best_known_lower_bound_mm.max(0);
        let optimality_gap = if lb > 0 {
            ((cost - lb) as f64 / lb as f64).max(0.0)
        } else {
            0.0
        };
        let verification_status = if route.approximate_legs.iter().any(|&x| x) {
            VerificationStatus::ApproximateLegs
        } else {
            VerificationStatus::Verified
        };
        RouteResult {
            waypoints: route.waypoints.clone(),
            route_cost_mm: cost,
            best_known_lower_bound_mm: lb,
            optimality_gap,
            verification_status,
            approximate_legs: route.approximate_legs.clone(),
            check_manually_legs: route.check_manually_legs.clone(),
        }
    }
}

/// The straight-line great-circle lower bound on route cost between two
/// `(lon, lat)` points, millimetre fixed-point: [`heuristic_mm`] over the
/// real ground distance at `min_multiplier` (clamped to
/// `[MIN_MULTIPLIER, ∞)` by `heuristic_mm` itself).
///
/// A route cannot be shorter than the straight line, and no real per-cell
/// multiplier drops below the request's own effective floor
/// `(1.0 − Σ preference weights).max(MIN_MULTIPLIER)` — pass that as
/// `min_multiplier` for the tight bound, or [`MIN_MULTIPLIER`] for the
/// weakest always-valid one. This is the term [`RouteResult`] takes the
/// `max` against [`super::landmarks::BandLandmarks::lower_bound_mm`].
pub fn straight_line_lower_bound_mm(
    from_lonlat: (f64, f64),
    to_lonlat: (f64, f64),
    min_multiplier: f64,
) -> i64 {
    let a = crate::coords::lat_lon_to_world(from_lonlat.1, from_lonlat.0);
    let b = crate::coords::lat_lon_to_world(to_lonlat.1, to_lonlat.0);
    heuristic_mm(world_distance_m(a, b), min_multiplier)
}

/// The effective per-metre multiplier floor for a request with these
/// soft-preference weights: `1.0` minus every discount term, clamped to
/// `[MIN_MULTIPLIER, ∞)`. Penalty weights only raise a multiplier, so
/// they do not enter — only `fairway_preference_weight` (the one
/// discount) does. This is what [`straight_line_lower_bound_mm`] and
/// [`super::landmarks::BandLandmarks::lower_bound_mm`] should be passed so
/// their bounds stay admissible AND tight for the common no-preference
/// request.
pub fn effective_min_multiplier(fairway_preference_weight: f64) -> f64 {
    let w = if fairway_preference_weight.is_finite() {
        fairway_preference_weight.max(0.0)
    } else {
        0.0
    };
    (1.0 - w).max(MIN_MULTIPLIER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::mivnav::field::{RegionLattice, TileEntry};
    use crate::mivnav::stitch::compute_stitch;
    use crate::mivnav::topology::label_band;

    const LAT: f64 = 54.0;
    const LON: f64 = 11.0;

    #[test]
    fn select_band_picks_the_tightest_safe_ladder_entry() {
        assert_eq!(select_band(0.0), 1.0);
        assert_eq!(
            select_band(1.0),
            1.0,
            "exact match is its own tightest bound"
        );
        assert_eq!(select_band(1.1), 1.5);
        assert_eq!(select_band(2.4), 2.5);
        assert_eq!(select_band(14.9), 15.0);
    }

    #[test]
    fn select_band_never_under_shoots_a_draft_beyond_the_ladder() {
        assert_eq!(
            select_band(100.0),
            15.0,
            "the ladder's own ceiling, not a fabricated deeper band"
        );
    }

    #[test]
    fn select_band_treats_non_finite_input_conservatively() {
        // NaN and either infinity are all "not a real draft" — every one
        // of them must return the deepest band, never the shallowest,
        // same "demand more depth, not less" rule bad input gets
        // everywhere else in this crate.
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(select_band(bad), 15.0, "{bad}");
        }
    }

    #[test]
    fn select_band_treats_negative_finite_input_conservatively() {
        // A regression test: a bare `!is_finite()` check alone let a
        // negative-but-finite draft fall through to the ordinary
        // ladder search, where EVERY entry is `>= a negative number` —
        // returning the SHALLOWEST band, the exact opposite of this
        // function's own documented rule. Found by code review.
        assert_eq!(select_band(-5.0), 15.0);
        assert_eq!(select_band(-0.001), 15.0);
    }

    #[test]
    fn select_bands_conservative_rounding_can_exclude_a_technically_sufficient_cell() {
        // A single tile, one cell, charted to 1.3 m (13 dm) — genuinely
        // enough water for a 1.2 m draft (`band_to_dm(1.2) = 12 dm`),
        // but NOT enough for the 1.5 m ladder rung `select_band(1.2)`
        // rounds up to (`band_to_dm(1.5) = 15 dm > 13`). Demonstrates
        // `select_band`'s own documented quantised-feasibility
        // trade-off concretely, found worth a real test by code review:
        // `topology_route`'s draft filter and `label_band`'s own
        // connectivity gate are fed DIFFERENT numbers on purpose
        // (`select_band`'s rounded value for the band, the raw draft
        // for portal capacity) — this proves that split is real and
        // does what its own docs claim, not merely that the two numbers
        // happen not to collide on some untested depth.
        use crate::mivnav::topology::NO_COMPONENT;
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let tile = TileEntry {
            payload_offset: 0,
            ..l.tile_at(0, p.x, p.y)
        };
        let n = tile.cell_count();
        let built = BuiltRegion {
            tiles: vec![tile],
            depth_min: vec![13u16; n],
            depth_max: vec![13u16; n],
            flags: vec![0u8; n],
            stitch: vec![],
            report: Default::default(),
        };

        let required_m = 1.2;
        assert_eq!(
            select_band(required_m),
            1.5,
            "1.2 must round up to the next real ladder rung"
        );

        // At the ROUNDED band, this cell is conservatively excluded —
        // never wrongly INCLUDED, which is the direction that would
        // actually be unsafe.
        let comps_rounded = label_band(&built, select_band(required_m));
        assert!(
            comps_rounded.label.iter().all(|&c| c == NO_COMPONENT),
            "13 dm charted depth is less than the rounded 15 dm band, so no component may include it"
        );

        // But at the vessel's REAL, unrounded requirement, the same
        // cell IS navigable — proving the exclusion above is a
        // quantisation effect, not some other bug making the cell
        // wrongly unreachable at every band.
        let comps_raw = label_band(&built, required_m);
        assert!(
            comps_raw.label.iter().all(|&c| c != NO_COMPONENT),
            "the vessel's real 1.2 m draft is genuinely satisfied by 1.3 m of charted depth"
        );
    }

    fn lattice() -> RegionLattice {
        RegionLattice::for_region(crate::coords::Extent::new(
            lat_lon_to_world(LAT, LON - 0.2).x,
            lat_lon_to_world(LAT, LON + 0.2).x,
            lat_lon_to_world(LAT + 0.2, LON).y,
            lat_lon_to_world(LAT - 0.2, LON).y,
        ))
    }

    /// `count` same-rung tiles in a west-to-east row, every cell open
    /// water at 5.0 m — the same shape `shortcuts.rs`'s own tests use.
    fn open_row(count: usize) -> BuiltRegion {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let first = l.tile_at(3, p.x, p.y);
        let mut tiles = Vec::with_capacity(count);
        for i in 0..count {
            tiles.push(TileEntry {
                origin_x: first.origin_x + i as i32 * i32::from(first.cols) * first.cell_world,
                payload_offset: (i * first.cell_count()) as u64,
                ..first
            });
        }
        let n_each = first.cell_count();
        let n = n_each * count;
        let stitch = compute_stitch(&tiles);
        BuiltRegion {
            tiles,
            depth_min: vec![50u16; n],
            depth_max: vec![100u16; n],
            flags: vec![0u8; n],
            stitch,
            report: Default::default(),
        }
    }

    #[test]
    fn a_straight_channel_routes_start_to_goal_through_every_tile() {
        let built = open_row(5);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let route = topology_route(&built, &portals, 0, 4, 10).expect("a route must exist");
        assert_eq!(route.hops.len(), 4);
        assert_eq!(route.hops.first().unwrap().tile, 0);
        assert_eq!(route.hops.last().unwrap().neighbour_tile, 4);
        // Each hop's neighbour must feed the next hop's own tile.
        for w in route.hops.windows(2) {
            assert_eq!(w[0].neighbour_tile, w[1].tile);
        }
        assert!(route.cost_mm > 0);
    }

    #[test]
    fn the_same_tile_routes_to_itself_with_no_hops_and_zero_cost() {
        let built = open_row(3);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let route = topology_route(&built, &portals, 1, 1, 10).unwrap();
        assert!(route.hops.is_empty());
        assert_eq!(route.cost_mm, 0);
    }

    #[test]
    fn a_marginal_width_portal_is_demoted_onto_the_route_never_rejected() {
        // §8.3 / Phase 6: a portal narrower than the vessel's beam must
        // be DEMOTED to local vector refinement, not filtered out of the
        // topology graph — a width filter without a refinement path
        // would silently lose real routes (TODO doc, explicit).
        let built = open_row(3);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);

        // Baseline: no beam threshold -> no demotion, a real 2-hop route.
        let plain = topology_route(&built, &portals, 0, 2, 10).expect("route exists");
        assert!(plain.demoted_portals.is_empty());
        assert_eq!(plain.hops.len(), 2);

        // An absurd beam (`u16::MAX` dm): every portal on the route reads
        // as too narrow. The route must be the SAME route — same hops,
        // same cost — with every crossed portal now flagged for
        // refinement.
        let demoted = topology_route_demoting(
            &built,
            &portals,
            0,
            2,
            10,
            u16::MAX,
            None,
            TopologyWeights::default(),
        )
        .expect("demotion must never turn a real route into no route");
        assert_eq!(demoted.hops, plain.hops, "the route itself must not move");
        assert_eq!(demoted.cost_mm, plain.cost_mm);
        assert_eq!(
            demoted.demoted_portals,
            demoted.hops.iter().map(|h| h.portal).collect::<Vec<_>>(),
            "every crossed portal is marginal at this absurd beam"
        );

        // A 1 dm beam is below every real portal width here -> nothing
        // demoted, route unchanged.
        let none = topology_route_demoting(
            &built,
            &portals,
            0,
            2,
            10,
            1,
            None,
            TopologyWeights::default(),
        )
        .unwrap();
        assert!(none.demoted_portals.is_empty());
        assert_eq!(none.hops, plain.hops);

        // The graced variant carries the same guarantee.
        let from = built.tiles[0].centre_of(1, 1);
        let to = built.tiles[2].centre_of(1, 1);
        let (graced, ..) = topology_route_graced_demoting(
            &built,
            &portals,
            from,
            to,
            10,
            0.0,
            u16::MAX,
            None,
            TopologyWeights::default(),
        )
        .expect("graced demotion still routes");
        assert!(!graced.demoted_portals.is_empty());
        assert_eq!(
            graced.demoted_portals,
            graced.hops.iter().map(|h| h.portal).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_draft_deeper_than_any_portal_finds_no_route() {
        let built = open_row(3);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        // 5.0 m of charted depth everywhere -> 50 dm; ask for more.
        assert!(topology_route(&built, &portals, 0, 2, 51).is_none());
    }

    // ── topology_route_graced ──────────────────────────────────────────

    /// `open_row(2)`'s own two connected tiles (0, 1), plus a THIRD
    /// same-rung tile immediately east of tile 1 that is entirely
    /// `FLAG_NO_COVERAGE` — a marina-berth-shaped fixture: tile 2 has NO
    /// portal to anything at all (its stitch run against tile 1 loses
    /// navigability on tile 2's own side), exactly the "short
    /// no-coverage gap near an endpoint" shape `topology.rs`'s own
    /// module docs name as the reconciliation `topology_route_graced`
    /// exists for.
    fn open_row_with_unsurveyed_tail() -> BuiltRegion {
        use super::super::format::{DEPTH_NO_COVERAGE, FLAG_NO_COVERAGE};
        let mut built = open_row(2);
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let first = l.tile_at(3, p.x, p.y);
        let n_each = first.cell_count();
        let tail = TileEntry {
            origin_x: first.origin_x + 2 * i32::from(first.cols) * first.cell_world,
            payload_offset: (2 * n_each) as u64,
            ..first
        };
        built.tiles.push(tail);
        // A GENUINELY blocked tail: outside `M_COVR` AND no charted depth
        // (the sentinel). Since `FLAG_NO_COVERAGE` left `BAND_BLOCKING_
        // FLAGS`, a no-coverage tile with a real `depth_max` is navigable
        // — this fixture needs the still-blocked case to exercise §9.3
        // grace bridging it.
        built.depth_min.extend(vec![DEPTH_NO_COVERAGE; n_each]);
        built.depth_max.extend(vec![DEPTH_NO_COVERAGE; n_each]);
        built.flags.extend(vec![FLAG_NO_COVERAGE; n_each]);
        built.stitch = compute_stitch(&built.tiles);
        built
    }

    /// A point inside `open_row_with_unsurveyed_tail`'s own tail tile
    /// (index 2) — the "marina" endpoint sitting in unsurveyed water.
    fn marina_point(built: &BuiltRegion) -> WorldXy {
        let tail = built.tiles[2];
        WorldXy::new(
            tail.origin_x + tail.cell_world / 2,
            tail.origin_y + tail.cell_world / 2,
        )
    }

    #[test]
    fn direct_snap_into_an_unsurveyed_marina_finds_no_route_without_grace() {
        let built = open_row_with_unsurveyed_tail();
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);

        let from = lat_lon_to_world(LAT, LON); // inside tile 0
        let marina = marina_point(&built);

        let direct = snap_point(&built, marina).expect("still inside the built region");
        assert_eq!(
            direct.tile, 2,
            "sanity: the marina point snaps to the unsurveyed tail tile"
        );
        assert!(
            topology_route(&built, &portals, 0, direct.tile, 10).is_none(),
            "an isolated no-coverage tile has no portal, so the direct route must fail"
        );

        // No grace radius at all must degrade to exactly that same
        // failure, not silently succeed some other way.
        assert!(topology_route_graced(&built, &portals, from, marina, 10, 0.0).is_none());
    }

    #[test]
    fn a_wide_enough_grace_radius_reaches_past_the_unsurveyed_gap() {
        let built = open_row_with_unsurveyed_tail();
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);

        let from = lat_lon_to_world(LAT, LON);
        let marina = marina_point(&built);

        let (route, start, goal) =
            topology_route_graced(&built, &portals, from, marina, 10, 1_000_000.0)
                .expect("a generous grace radius must find tile 1's real portal");
        assert_eq!(start.tile, 0);
        assert_eq!(
            goal.tile, 1,
            "graced goal must be the nearest tile that actually has a portal, not the \
             unsurveyed one itself"
        );
        assert!(!route.hops.is_empty());
        assert!(route.cost_mm > 0);
    }

    #[test]
    fn too_small_a_grace_radius_still_finds_no_route() {
        let built = open_row_with_unsurveyed_tail();
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let from = lat_lon_to_world(LAT, LON);
        let marina = marina_point(&built);
        // Well under one tile width — grace is bounded, not unlimited.
        assert!(topology_route_graced(&built, &portals, from, marina, 10, 0.5).is_none());
    }

    #[test]
    fn when_the_direct_snap_already_has_a_portal_grace_changes_nothing() {
        // Ordinary open-row case: no gap to bridge, so the graced
        // wrapper must return the exact same route the ungraced call
        // does, using the DIRECT snap tiles, no matter how generous
        // `grace_radius_m` is.
        let built = open_row(3);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let direct = topology_route(&built, &portals, 0, 2, 10).unwrap();

        let from = lat_lon_to_world(LAT, LON);
        let to = built.tiles[2].centre_of(0, 0);
        let (graced, start, goal) =
            topology_route_graced(&built, &portals, from, to, 10, 999_999.0).unwrap();
        assert_eq!(start.tile, 0);
        assert_eq!(goal.tile, 2);
        assert_eq!(graced, direct);
    }

    #[test]
    fn topology_route_graced_is_deterministic_across_repeated_calls() {
        let built = open_row_with_unsurveyed_tail();
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let from = lat_lon_to_world(LAT, LON);
        let marina = marina_point(&built);
        let first = topology_route_graced(&built, &portals, from, marina, 10, 1_000_000.0);
        assert!(first.is_some());
        for _ in 0..3 {
            assert_eq!(
                topology_route_graced(&built, &portals, from, marina, 10, 1_000_000.0),
                first
            );
        }
    }

    #[test]
    fn a_point_outside_the_built_region_finds_no_graced_route_either() {
        // Grace only ever widens which TILE within the region an
        // endpoint maps to — it never extends the region's own outer
        // boundary.
        let built = open_row(2);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let from = lat_lon_to_world(LAT, LON);
        let far_away = lat_lon_to_world(LAT + 5.0, LON + 5.0);
        assert!(topology_route_graced(&built, &portals, from, far_away, 10, 1_000_000.0).is_none());
    }

    /// The exact counterexample code review found: two DISJOINT
    /// components, `{G, A'}` (tiles 0, 1) and `{A, Z}` (tiles 3, 4), kept
    /// permanently apart by a `FLAG_LAND` wall tile (2) between them, plus
    /// an isolated `FLAG_NO_COVERAGE` tile `B` (5, south of `G`) with no
    /// portal at all. `from` sits exactly at `A`'s own centre (distance
    /// 0, the direct start) and `to` sits exactly at `B`'s own centre
    /// (isolated, the direct goal always fails) — but the tiles are
    /// spaced so `G` is much closer to `to` than `Z` is, while `A'` is
    /// only a little farther from `from` than `A` itself. A start-major
    /// "first pairing that connects" search tries `start = A` (distance
    /// 0) against every goal candidate BEFORE `A'` is ever tried, and
    /// `(A, A)` — `A` also appears in `A`'s own goal candidate list,
    /// since it has a real portal within grace radius of `to` too —
    /// succeeds as a trivial same-tile "already there" route long before
    /// the real, much better `(A', G)` pairing is reached. The jointly
    /// closest pairing by TOTAL endpoint displacement is `(A', G)`,
    /// not `(A, A)` or `(A, Z)`.
    fn two_disjoint_components_with_a_closer_alternate_pairing() -> BuiltRegion {
        use super::super::format::{DEPTH_NO_COVERAGE, FLAG_LAND, FLAG_NO_COVERAGE};
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let first = l.tile_at(3, p.x, p.y);
        let w = i32::from(first.cols) * first.cell_world; // tile width == height (square)
        let n_each = first.cell_count();

        let mk = |dx: i32, dy: i32, offset: usize| TileEntry {
            origin_x: first.origin_x + dx * w,
            origin_y: first.origin_y + dy * w,
            payload_offset: (offset * n_each) as u64,
            ..first
        };
        // index: 0=G  1=A'  2=WALL  3=A  4=Z  5=B
        let tiles = vec![
            mk(0, 0, 0),
            mk(1, 0, 1),
            mk(2, 0, 2),
            mk(3, 0, 3),
            mk(4, 0, 4),
            mk(0, 1, 5), // B, south of G — only corner-touches tile 1, no shared edge
        ];

        let mut flags = vec![0u8; n_each * 6];
        let mut depth_min = vec![50u16; n_each * 6];
        let mut depth_max = vec![100u16; n_each * 6];
        for i in 0..n_each {
            flags[2 * n_each + i] = FLAG_LAND; // WALL: entirely land, blocks both its seams
                                               // B: no coverage AND no charted depth — genuinely blocked, so
                                               // no portal at all. (Since `FLAG_NO_COVERAGE` left
                                               // `BAND_BLOCKING_FLAGS`, no-coverage water WITH a real depth
                                               // is navigable — that would connect B to G here and defeat
                                               // the isolated-B shape this fixture needs.)
            flags[5 * n_each + i] = FLAG_NO_COVERAGE;
            depth_min[5 * n_each + i] = DEPTH_NO_COVERAGE;
            depth_max[5 * n_each + i] = DEPTH_NO_COVERAGE;
        }
        let stitch = compute_stitch(&tiles);
        BuiltRegion {
            tiles,
            depth_min,
            depth_max,
            flags,
            stitch,
            report: Default::default(),
        }
    }

    #[test]
    fn topology_route_graced_picks_the_jointly_closest_pairing_not_the_first_found() {
        let built = two_disjoint_components_with_a_closer_alternate_pairing();
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);

        // Sanity: A and Z really are one component, A' and G really are
        // a DIFFERENT one, and B is genuinely isolated — otherwise this
        // test would not be exercising the shape it claims to.
        assert!(
            topology_route(&built, &portals, 3, 4, 10).is_some(),
            "A-Z must connect"
        );
        assert!(
            topology_route(&built, &portals, 1, 0, 10).is_some(),
            "A'-G must connect"
        );
        assert!(
            topology_route(&built, &portals, 3, 0, 10).is_none(),
            "A and G must NOT be in the same component"
        );
        assert!(
            topology_route(&built, &portals, 3, 5, 10).is_none(),
            "B must be isolated"
        );

        let a = built.tiles[3];
        let b = built.tiles[5];
        let from = a.centre_of(u32::from(a.cols) / 2, u32::from(a.rows) / 2);
        let to = b.centre_of(u32::from(b.cols) / 2, u32::from(b.rows) / 2);

        let (route, start, goal) =
            topology_route_graced(&built, &portals, from, to, 10, 1_000_000.0)
                .expect("the {A', G} component must produce a real graced route");
        assert_eq!(
            start.tile, 1,
            "must pick A' (tile 1), not settle for the direct A (tile 3)"
        );
        assert_eq!(
            goal.tile, 0,
            "must pick G (tile 0), not the far Z (tile 4) or the isolated direct B (tile 5)"
        );
        assert!(
            !route.hops.is_empty(),
            "the winning pairing is a real crossing, not a same-tile accident"
        );
    }

    /// Four same-rung 2x2 tiles arranged NW/NE/SW/SE — the identical
    /// "quadrants meeting at a point" shape `topology.rs` and
    /// `shortcuts.rs` already use: a genuine 4-cycle (each tile touches
    /// exactly its two orthogonal neighbours; NW-SE and NE-SW are
    /// diagonal, no direct edge — see `topology.rs`'s own proof).
    /// `blocked` names which tiles (by role) are entirely `FLAG_LAND`.
    fn quadrants_ring(blocked: &[&str]) -> BuiltRegion {
        use super::super::format::FLAG_LAND;
        let mk = |dx: i32, dy: i32, offset: u64| TileEntry {
            origin_x: dx * 200,
            origin_y: dy * 200,
            cell_world: 100,
            rung: 0,
            tile_flags: 0,
            cols: 2,
            rows: 2,
            triggers: 0,
            payload_offset: offset,
        };
        let named = [
            ("nw", mk(0, 0, 0)),
            ("ne", mk(1, 0, 4)),
            ("sw", mk(0, 1, 8)),
            ("se", mk(1, 1, 12)),
        ];
        let n = 16;
        let mut flags = vec![0u8; n];
        for (name, tile) in &named {
            if blocked.contains(name) {
                for i in 0..4 {
                    flags[tile.payload_offset as usize + i] = FLAG_LAND;
                }
            }
        }
        let tiles: Vec<TileEntry> = named.iter().map(|&(_, t)| t).collect();
        let stitch = compute_stitch(&tiles);
        BuiltRegion {
            tiles,
            depth_min: vec![50u16; n],
            depth_max: vec![100u16; n],
            flags,
            stitch,
            report: Default::default(),
        }
    }

    #[test]
    fn a_blocked_corner_forces_the_detour_around_the_ring() {
        // NW (0) to SE (3) are diagonal — never directly stitched — so
        // an open ring offers two symmetric 2-hop paths: via NE (1) or
        // via SW (2). Blocking NE entirely must force every route onto
        // the SW path instead of merely being one of two equally likely
        // answers — determinism together with a real topological
        // constraint, not just "a path exists".
        let built = quadrants_ring(&["ne"]);
        let comps = label_band(&built, 1.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let route = topology_route(&built, &portals, 0, 3, 10).expect("the sw path must exist");
        assert_eq!(route.hops.len(), 2);
        assert_eq!(route.hops[0].tile, 0);
        assert_eq!(
            route.hops[0].neighbour_tile, 2,
            "must detour via sw (tile 2), not the blocked ne"
        );
        assert_eq!(route.hops[1].tile, 2);
        assert_eq!(route.hops[1].neighbour_tile, 3);
    }

    #[test]
    fn blocking_both_bridges_leaves_no_route_at_all() {
        let built = quadrants_ring(&["ne", "sw"]);
        let comps = label_band(&built, 1.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        assert!(topology_route(&built, &portals, 0, 3, 10).is_none());
    }

    #[test]
    fn a_genuine_tie_breaks_deterministically_toward_the_lower_tile_id() {
        // NOTHING blocked this time: NW->NE->SE and NW->SW->SE are
        // exactly equal-length round trips (the fixture is fully
        // symmetric) — a REAL tie in path cost, not merely a
        // repeated-call check. A*'s own `(f, h, cell_id)` tie-break (see
        // `cost::OpenNode`) settles NE (tile 1) before SW (tile 2)
        // whenever their `f`/`h` are equal, since 1 < 2 — so NE's own
        // edge to SE is relaxed first, and SW's later, equal-cost
        // relaxation attempt is rejected by the search's own strict `<`
        // improvement rule (a tie never overwrites an already-settled
        // cost). This fixes WHICH of the two symmetric answers wins,
        // not merely that repeated calls agree with each other.
        let built = quadrants_ring(&[]);
        let comps = label_band(&built, 1.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let route = topology_route(&built, &portals, 0, 3, 10).unwrap();
        assert_eq!(route.hops.len(), 2);
        assert_eq!(
            route.hops[0].neighbour_tile, 1,
            "the tie must resolve toward ne (tile 1), not sw (tile 2)"
        );
        assert_eq!(route.hops[1].tile, 1);
        assert_eq!(route.hops[1].neighbour_tile, 3);

        for _ in 0..3 {
            assert_eq!(topology_route(&built, &portals, 0, 3, 10).unwrap(), route);
        }
    }

    // ── TopologyWeights / topology_route_with ──────────────────────────

    #[test]
    fn topology_route_with_default_weights_matches_topology_route_exactly() {
        let built = quadrants_ring(&[]);
        let comps = label_band(&built, 1.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let unweighted = topology_route(&built, &portals, 0, 3, 10).unwrap();
        let weighted =
            topology_route_with(&built, &portals, 0, 3, 10, TopologyWeights::default()).unwrap();
        assert_eq!(unweighted, weighted);
    }

    #[test]
    fn tss_avoidance_weight_pushes_the_route_off_a_flagged_portal() {
        use super::super::format::FLAG_TSS;
        // Flag NE's (tile 1) own cells TSS — both its portals (NW-NE,
        // NE-SE) then report `touches_tss`. The default, UNWEIGHTED
        // tie-break picks NE
        // (`a_genuine_tie_breaks_deterministically_toward_the_lower_
        // tile_id`, above) — a real, nonzero `tss_avoidance_weight` must
        // be enough to overcome that tie-break bias and push the route
        // onto the SW (tile 2) path instead, since TSS avoidance now
        // makes NE's own edges the STRICTLY more expensive choice, not
        // merely an equally-cheap alternative the tie-break happens to
        // favour.
        let mut built = quadrants_ring(&[]);
        let ne = built.tiles[1];
        for i in 0..4 {
            built.flags[ne.payload_offset as usize + i] |= FLAG_TSS;
        }
        let comps = label_band(&built, 1.0);
        let portals = super::super::portals::detect_portals(&built, &comps);

        let unweighted = topology_route(&built, &portals, 0, 3, 10).unwrap();
        assert_eq!(
            unweighted.hops[0].neighbour_tile, 1,
            "sanity: unweighted must still prefer ne, or this test proves nothing"
        );

        let weights = TopologyWeights {
            tss_avoidance_weight: 1.0,
            fairway_preference_weight: 0.0,
        };
        let weighted = topology_route_with(&built, &portals, 0, 3, 10, weights).unwrap();
        assert_eq!(
            weighted.hops[0].neighbour_tile, 2,
            "tss avoidance must push the route onto sw (tile 2) instead"
        );
        // NOT a `cost_mm` comparison against `unweighted`: the fixture is
        // fully symmetric and SW's own edges carry no weight in this
        // test (only NE's do), so the WINNING path's raw cost is
        // identical either way — the penalty only ever showed up on the
        // path that lost and was never taken. The real, meaningful proof
        // here is the switch to tile 2 above, not a cost delta between
        // two different winning paths that happen to be equal-length by
        // construction (found by running this exact assertion and
        // measuring: `weighted.cost_mm == unweighted.cost_mm`, both
        // 30770 — not a bug, just the wrong comparison to make; the
        // mirror-image `fairway_preference_weight` test below flags the
        // WINNING path instead, where a `cost_mm` comparison IS the
        // right proof).
        assert!(weighted.cost_mm > 0);
    }

    #[test]
    fn fairway_preference_weight_pulls_the_route_onto_a_flagged_portal() {
        use super::super::format::FLAG_FAIRWAY;
        // The mirror image of the TSS test above: flag SW's (tile 2) own
        // cells FAIRWAY, and check a real `fairway_preference_weight`
        // discounts SW's own edges enough to win over NE's default
        // tie-break advantage.
        let mut built = quadrants_ring(&[]);
        let sw = built.tiles[2];
        for i in 0..4 {
            built.flags[sw.payload_offset as usize + i] |= FLAG_FAIRWAY;
        }
        let comps = label_band(&built, 1.0);
        let portals = super::super::portals::detect_portals(&built, &comps);

        let unweighted = topology_route(&built, &portals, 0, 3, 10).unwrap();
        assert_eq!(
            unweighted.hops[0].neighbour_tile, 1,
            "sanity: unweighted must still prefer ne, or this test proves nothing"
        );

        let weights = TopologyWeights {
            tss_avoidance_weight: 0.0,
            fairway_preference_weight: 0.5,
        };
        let weighted = topology_route_with(&built, &portals, 0, 3, 10, weights).unwrap();
        assert_eq!(
            weighted.hops[0].neighbour_tile, 2,
            "fairway preference must pull the route onto sw (tile 2) instead"
        );
        assert!(
            weighted.cost_mm < unweighted.cost_mm,
            "a discounted, fairway-flagged portal must cost less mm, not more: {} vs {}",
            weighted.cost_mm,
            unweighted.cost_mm
        );
    }

    #[test]
    fn a_weight_that_would_floor_below_min_multiplier_is_clamped_not_negative() {
        // An absurdly large fairway_preference_weight must still floor
        // at MIN_MULTIPLIER, never reach zero or go negative — a
        // negative or zero step cost would break A*'s own admissibility
        // (and `step_cost_mm`'s own fixed-point rounding besides).
        use super::super::format::FLAG_FAIRWAY;
        let mut built = quadrants_ring(&[]);
        let ne = built.tiles[1];
        for i in 0..4 {
            built.flags[ne.payload_offset as usize + i] |= FLAG_FAIRWAY;
        }
        let comps = label_band(&built, 1.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let weights = TopologyWeights {
            tss_avoidance_weight: 0.0,
            fairway_preference_weight: 1_000_000.0,
        };
        let route = topology_route_with(&built, &portals, 0, 3, 10, weights).unwrap();
        assert!(
            route.cost_mm > 0,
            "an absurd preference weight must never drive the route cost to zero or negative"
        );
    }

    #[test]
    fn topology_route_graced_with_also_applies_weights_to_every_candidate_pairing() {
        // `topology_route_graced_with` re-derives its own adjacency per
        // candidate pairing via `topology_route_with` — this proves the
        // weights argument actually reaches THAT call, not just the
        // plain `topology_route_with` entry point tested above.
        use super::super::format::FLAG_TSS;
        let mut built = quadrants_ring(&[]);
        let ne = built.tiles[1];
        for i in 0..4 {
            built.flags[ne.payload_offset as usize + i] |= FLAG_TSS;
        }
        let comps = label_band(&built, 1.0);
        let portals = super::super::portals::detect_portals(&built, &comps);

        let nw = built.tiles[0].centre_of(0, 0);
        let se = built.tiles[3].centre_of(1, 1);
        let weights = TopologyWeights {
            tss_avoidance_weight: 1.0,
            fairway_preference_weight: 0.0,
        };
        let (route, start, goal) =
            topology_route_graced_with(&built, &portals, nw, se, 10, 0.0, weights).unwrap();
        assert_eq!(start.tile, 0);
        assert_eq!(goal.tile, 3);
        assert_eq!(
            route.hops[0].neighbour_tile, 2,
            "grace's own weighted search must also avoid the TSS-flagged ne portal"
        );
    }

    #[test]
    fn a_multi_edge_seam_still_routes_deterministically() {
        // The same "one blocked row splits the seam into two disjoint
        // crossings" shape `shortcuts.rs`'s own
        // `a_multi_edge_seam_stays_a_junction_not_a_pure_cycle` uses —
        // two parallel portals between the same tile pair, feeding
        // straight into `topology_route` this time rather than
        // `build_shortcuts`. Must find a real route across one of the
        // two parallel edges without double-counting them into `g` or
        // misattributing the winning hop's own portal id.
        use super::super::bands::global_index;
        use super::super::field::TILE_CELLS;
        use super::super::format::FLAG_LAND;
        let mut built = open_row(2);
        let mid = TILE_CELLS / 2;
        let west = built.tiles[0];
        let east = built.tiles[1];
        built.flags[global_index(&west, u32::from(west.cols) - 1, mid)] = FLAG_LAND;
        built.flags[global_index(&east, 0, mid)] = FLAG_LAND;

        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        assert_eq!(
            portals.len(),
            4,
            "one blocked row splits the seam into two crossings, each direction"
        );

        let route = topology_route(&built, &portals, 0, 1, 10)
            .expect("a route across one of the two parallel portals must exist");
        assert_eq!(route.hops.len(), 1);
        assert_eq!(route.hops[0].tile, 0);
        assert_eq!(route.hops[0].neighbour_tile, 1);
        let winner = &portals[route.hops[0].portal as usize];
        assert_eq!(winner.tile, 0);
        assert_eq!(winner.neighbour_tile, 1);

        for _ in 0..3 {
            assert_eq!(topology_route(&built, &portals, 0, 1, 10).unwrap(), route);
        }
    }

    #[test]
    fn determinism_holds_across_repeated_runs() {
        let built = open_row(6);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let first = topology_route(&built, &portals, 0, 5, 10).unwrap();
        for _ in 0..3 {
            assert_eq!(topology_route(&built, &portals, 0, 5, 10).unwrap(), first);
        }
    }

    #[test]
    fn an_unknown_tile_index_is_rejected_not_panicked() {
        let built = open_row(2);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        assert!(topology_route(&built, &portals, 0, 99, 10).is_none());
        assert!(topology_route(&built, &portals, 99, 0, 10).is_none());
    }

    #[test]
    fn find_tile_locates_the_containing_tile_and_rejects_outside_points() {
        let built = open_row(3);
        for i in 0..3u32 {
            let mid = built.tiles[i as usize].extent().midpoint();
            assert_eq!(find_tile(&built, mid), Some(i));
        }
        let far_outside = WorldXy::new(
            built.tiles[0].origin_x - 10_000_000,
            built.tiles[0].origin_y - 10_000_000,
        );
        assert_eq!(find_tile(&built, far_outside), None);
    }

    #[test]
    fn find_tile_resolves_a_shared_seam_the_same_way_cell_of_does() {
        // A point exactly on the shared vertical seam between tile 0
        // (west) and tile 1 (east): `Extent::contains_point` is fully
        // INCLUSIVE, so an earlier version of `find_tile` matched BOTH
        // tiles here and silently picked whichever sorted first (west,
        // the WRONG owner under `cell_of`'s own half-open rule) —
        // regression for the bug code review found. `find_tile` must
        // agree with `cell_of` on every tile it's asked about, not just
        // the tile it ultimately returns.
        let built = open_row(2);
        let seam_x = built.tiles[1].origin_x; // == tile 0's own xmax
        let on_seam = WorldXy::new(seam_x, built.tiles[0].origin_y);
        assert_eq!(
            find_tile(&built, on_seam),
            Some(1),
            "the east tile owns its own west edge, not the west tile its east edge"
        );
        assert!(built.tiles[1].cell_of(on_seam).is_some());
        assert!(
            built.tiles[0].cell_of(on_seam).is_none(),
            "cell_of's own half-open rule must exclude the west tile here"
        );

        // And snap_point must not misreport this as "outside the region"
        // just because it happens to land on an internal seam.
        let snap =
            snap_point(&built, on_seam).expect("an internal seam is still inside the region");
        assert_eq!(snap.tile, 1);
        assert_eq!(snap.col, 0);
    }

    #[test]
    fn snap_point_returns_the_lattices_own_canonical_cell_centre() {
        let built = open_row(2);
        let tile = built.tiles[1];
        let inside = WorldXy::new(
            tile.origin_x + tile.cell_world / 3,
            tile.origin_y + tile.cell_world / 3,
        );
        let snap = snap_point(&built, inside).expect("inside the built region");
        assert_eq!(snap.tile, 1);
        assert_eq!(snap.col, 0);
        assert_eq!(snap.row, 0);
        assert_eq!(snap.cell_centre, tile.centre_of(0, 0));
        assert_eq!(snap.global_index, global_index(&tile, 0, 0));

        let far_outside = WorldXy::new(
            built.tiles[0].origin_x - 10_000_000,
            built.tiles[0].origin_y - 10_000_000,
        );
        assert!(snap_point(&built, far_outside).is_none());
    }

    #[test]
    fn corridor_extent_covers_every_tile_the_route_actually_crossed() {
        let built = open_row(5);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let route = topology_route(&built, &portals, 0, 4, 10).unwrap();

        let unpadded = corridor_extent(&built, &route, 0.0);
        for tile in &built.tiles {
            assert!(
                unpadded.includes(&tile.extent()),
                "corridor must cover every tile on the route: {tile:?}"
            );
        }
        let padded = corridor_extent(&built, &route, 500.0);
        assert!(padded.includes(&unpadded));
        assert_ne!(
            padded, unpadded,
            "a positive pad must actually grow the box"
        );
    }

    #[test]
    fn corridor_extent_on_a_same_tile_route_is_just_that_one_tile() {
        let built = open_row(3);
        let route = TopologyRoute {
            start_tile: 1,
            goal_tile: 1,
            hops: Vec::new(),
            cost_mm: 0,
            demoted_portals: Vec::new(),
            directional_penalized_portals: Vec::new(),
        };
        let corridor = corridor_extent(&built, &route, 0.0);
        assert_eq!(corridor, built.tiles[1].extent());
    }

    #[test]
    fn corridor_extent_clamps_bad_padding_rather_than_shrinking() {
        let built = open_row(2);
        let route = TopologyRoute {
            start_tile: 0,
            goal_tile: 0,
            hops: Vec::new(),
            cost_mm: 0,
            demoted_portals: Vec::new(),
            directional_penalized_portals: Vec::new(),
        };
        let plain = corridor_extent(&built, &route, 0.0);
        for bad in [-500.0, f64::NAN, f64::NEG_INFINITY] {
            assert_eq!(corridor_extent(&built, &route, bad), plain);
        }
    }

    #[test]
    fn corridor_extent_pad_is_real_metres_not_raw_world_units() {
        // Regression: an earlier version passed `pad_m` straight into
        // `Extent::expand`, which takes raw World units — a 500 m
        // request grew the box by roughly 500 world units, ~37 real
        // metres at this latitude (found by code review, same root
        // cause as `centre_distance_m`'s own fix). Checked against
        // `radius_world_units` directly, the identical conversion
        // `corridor_extent` itself now uses — not a magic tolerance.
        let built = open_row(1);
        let route = TopologyRoute {
            start_tile: 0,
            goal_tile: 0,
            hops: Vec::new(),
            cost_mm: 0,
            demoted_portals: Vec::new(),
            directional_penalized_portals: Vec::new(),
        };
        let unpadded = corridor_extent(&built, &route, 0.0);
        let pad_m = 500.0;
        let padded = corridor_extent(&built, &route, pad_m);
        let expected_units =
            crate::routing::hazards::radius_world_units(unpadded.midpoint(), pad_m).round() as i32;
        assert_eq!(padded.xmin, unpadded.xmin - expected_units);
        assert_eq!(padded.xmax, unpadded.xmax + expected_units);
        assert_eq!(padded.ymin, unpadded.ymin - expected_units);
        assert_eq!(padded.ymax, unpadded.ymax + expected_units);
        // A bug reporting ~13x too little padding would fail the exact
        // equalities above; belt-and-braces, also assert the grown span
        // is a real, substantial fraction of the requested metres in
        // world-unit terms (loose bound, just rules out an order-of-
        // magnitude regression slipping back in unnoticed).
        assert!(
            expected_units > 1000,
            "500 m must be far more than 500 world units at this latitude"
        );
    }

    // ── Corridor SCOPING ──────────────────────────────────────────────

    /// A featureless `Cell` that claims exactly `extent` at `scale` —
    /// everything [`filter_cells_to_corridor`] actually reads, and
    /// nothing else. Hand-built rather than borrowed from
    /// `routing::artifact::constraints::fixtures` (which is
    /// `pub(super)` to `routing::artifact`, deliberately) — this needs
    /// no geometry at all.
    fn cell_claiming(extent: Extent, scale: u32) -> Cell {
        Cell {
            meta: crate::model::CellMeta {
                compilation_scale: scale,
                ..Default::default()
            },
            features: Vec::new(),
            extent,
        }
    }

    /// A world box `half_side_m` around (`lat`, `lon`).
    fn box_around(lat: f64, lon: f64, half_side_m: f64) -> Extent {
        let c = lat_lon_to_world(lat, lon);
        let r = radius_world_units(c, half_side_m).round() as i32;
        Extent::new(c.x - r, c.x + r, c.y - r, c.y + r)
    }

    #[test]
    fn filter_keeps_the_cells_the_scope_reaches_and_drops_the_rest() {
        // All three share the finest scale, so rule 3 (the compilation-
        // scale guard) cannot be what keeps a cell here.
        let inside = cell_claiming(box_around(LAT, LON, 200.0), 10_000);
        let touching = cell_claiming(box_around(LAT, LON + 0.02, 200.0), 10_000);
        let far = cell_claiming(box_around(LAT, LON + 5.0, 200.0), 10_000);
        let cells = [&inside, &touching, &far];

        let scope = box_around(LAT, LON + 0.01, 1500.0);
        assert!(scope.intersects(&inside.extent) && scope.intersects(&touching.extent));
        assert!(!scope.intersects(&far.extent));

        let kept = filter_cells_to_corridor(&cells, scope);
        assert_eq!(kept.len(), 2, "the far cell must be dropped");
        assert!(std::ptr::eq(kept[0], &inside));
        assert!(
            std::ptr::eq(kept[1], &touching),
            "input order must survive — `constraints::build`'s M_QUAL \
             lookup is first-match per cell"
        );
    }

    #[test]
    fn filter_on_an_invalid_scope_returns_the_input_untouched() {
        // The "topology found no route" path: never narrow the fine
        // search's own candidate set on this layer's `None`.
        let a = cell_claiming(box_around(LAT, LON, 200.0), 10_000);
        let b = cell_claiming(box_around(LAT, LON + 5.0, 200.0), 10_000);
        let cells = [&a, &b];
        let kept = filter_cells_to_corridor(&cells, Extent::invalid());
        assert_eq!(kept.len(), 2);
        assert!(std::ptr::eq(kept[0], &a) && std::ptr::eq(kept[1], &b));
    }

    #[test]
    fn filter_falls_back_rather_than_returning_an_empty_set() {
        let a = cell_claiming(box_around(LAT, LON, 200.0), 10_000);
        let cells = [&a];
        let elsewhere = box_around(LAT + 10.0, LON + 10.0, 200.0);
        assert!(!elsewhere.intersects(&a.extent));
        let kept = filter_cells_to_corridor(&cells, elsewhere);
        assert_eq!(
            kept.len(),
            1,
            "an empty filtered set means the scope was computed wrong, \
             not that the caller's cells are irrelevant"
        );
    }

    #[test]
    fn filter_falls_back_when_the_finest_compilation_scale_would_be_lost() {
        // The exact mechanism `corridor_scope_extent`'s docs describe:
        // dropping the ONLY 1:5000 cell changes `constraints::build`'s
        // `compilation_scale`, hence `ladder::finest_allowed_cell_m`,
        // hence the corridor grid's rung — a different route with no
        // geometry near it having moved at all.
        let near = cell_claiming(box_around(LAT, LON, 200.0), 40_000);
        let finest_but_far = cell_claiming(box_around(LAT, LON + 5.0, 200.0), 5_000);
        let cells = [&near, &finest_but_far];
        let scope = box_around(LAT, LON, 1500.0);
        assert!(!scope.intersects(&finest_but_far.extent));

        let kept = filter_cells_to_corridor(&cells, scope);
        assert_eq!(kept.len(), 2, "the finest-scale cell must not be lost");

        // Same geometry, but the finest scale is ALSO present on a cell
        // the scope keeps: now the far one is genuinely droppable.
        let near_finest = cell_claiming(box_around(LAT, LON, 200.0), 5_000);
        let cells = [&near_finest, &finest_but_far];
        let kept = filter_cells_to_corridor(&cells, scope);
        assert_eq!(kept.len(), 1);
        assert!(std::ptr::eq(kept[0], &near_finest));
    }

    #[test]
    fn filter_always_keeps_a_cell_that_claims_no_extent() {
        // `Extent::intersects` answers `false` for an invalid operand,
        // which would silently drop a cell that made no claim at all.
        let quiet = cell_claiming(Extent::invalid(), 10_000);
        let near = cell_claiming(box_around(LAT, LON, 200.0), 10_000);
        let cells = [&quiet, &near];
        let kept = filter_cells_to_corridor(&cells, box_around(LAT, LON, 1500.0));
        assert_eq!(kept.len(), 2);
        assert!(std::ptr::eq(kept[0], &quiet));
    }

    #[test]
    fn scope_pad_adds_grace_and_lateral_margin_and_survives_nonsense() {
        assert_eq!(corridor_scope_pad_m(150.0, 20.0), 170.0);
        assert_eq!(corridor_scope_pad_m(0.0, 0.0), 0.0);
        // A caller bug must contribute nothing, never a negative pad or
        // a NaN that would poison `corridor_extent`'s own clamp.
        assert_eq!(corridor_scope_pad_m(-150.0, 20.0), 20.0);
        assert_eq!(corridor_scope_pad_m(f64::NAN, 20.0), 20.0);
        assert_eq!(corridor_scope_pad_m(150.0, f64::INFINITY), 150.0);
    }

    #[test]
    fn scope_contains_both_raw_endpoints_whatever_the_topology_snapped_to() {
        // The floor `filter_cells_to_corridor`'s docs rely on holding by
        // construction rather than by runtime check: any cell containing
        // either raw query point survives, because the scope is extended
        // over both points explicitly.
        let built = open_row(2);
        let route = TopologyRoute {
            start_tile: 0,
            goal_tile: 0,
            hops: Vec::new(),
            cost_mm: 0,
            demoted_portals: Vec::new(),
            directional_penalized_portals: Vec::new(),
        };
        let from = built.tiles[0].centre_of(1, 1);
        let to = built.tiles[1].centre_of(1, 1);

        let scope = corridor_scope_extent(&built, &route, from, to, 150.0);
        assert!(scope.valid);
        assert!(scope.contains_point(from) && scope.contains_point(to));
    }

    #[test]
    fn an_antimeridian_crossing_query_refuses_to_produce_a_scope_at_all() {
        // `worldx_to_lon` wraps into ±180°, so the recovered box would
        // come back inside out. Both crossing directions must refuse —
        // and refusing means `filter_cells_to_corridor` leaves the
        // caller's slice alone, which is the safe answer.
        for (lon_a, lon_b) in [(179.9, -179.9), (-179.9, 179.9)] {
            let from = lat_lon_to_world(60.0, lon_a);
            let to = lat_lon_to_world(60.0, lon_b);
            assert!(
                fine_search_corridor_extent(from, to).is_none(),
                "({lon_a}, {lon_b}) crosses the antimeridian and must not produce a box"
            );
            let built = open_row(1);
            let route = TopologyRoute {
                start_tile: 0,
                goal_tile: 0,
                hops: Vec::new(),
                cost_mm: 0,
                demoted_portals: Vec::new(),
                directional_penalized_portals: Vec::new(),
            };
            assert!(!corridor_scope_extent(&built, &route, from, to, 150.0).valid);
        }
    }

    /// **The reason [`filter_cells_to_corridor`] is not wired into
    /// `crate::python::mivnav_route`.** Kept as an executable proof rather
    /// than a paragraph, so that if `routing::artifact` ever grows a way
    /// to keep its two region-global scalars across a cell drop, this test
    /// fails and tells whoever did it that corridor scoping just became
    /// possible.
    ///
    /// Two cells at backend defaults (`CatzocMode::Full`,
    /// `lateral_margin_m = 30.0`). The near cell is entirely inside its
    /// own `M_QUAL` CATZOC=1 (A1, 5 m) zone; the far cell is ~110 km east
    /// with an unzoned `LNDARE`, so it contributes the U/absent 1000 m
    /// fallback to `constraints::build`'s `coarsest_horizontal_m` — from
    /// any distance at all. Dropping it moves
    /// `ladder::finest_allowed_cell_m` from the 256 m rung to the 8 m one
    /// and the route with it.
    #[test]
    fn dropping_a_distant_cell_can_change_the_route_via_the_catzoc_scalar() {
        use crate::model::{AttrValue, CellMeta, Feature, Geometry, Polygon};
        use crate::routing::artifact::{
            artifact_route_lonlat, ArtifactParams, ArtifactWeights, CatzocMode,
        };

        fn ring(lat: f64, lon: f64, half_m: f64) -> Vec<WorldXy> {
            let dlat = half_m / 111_320.0;
            let dlon = half_m / (111_320.0 * lat.to_radians().cos());
            vec![
                lat_lon_to_world(lat - dlat, lon - dlon),
                lat_lon_to_world(lat - dlat, lon + dlon),
                lat_lon_to_world(lat + dlat, lon + dlon),
                lat_lon_to_world(lat + dlat, lon - dlon),
            ]
        }
        fn area(class: &str, lat: f64, lon: f64, half_m: f64, attrs: &[(&str, i64)]) -> Feature {
            let mut map = BTreeMap::new();
            for (k, v) in attrs {
                map.insert((*k).to_string(), AttrValue::Int(*v));
            }
            Feature::new(
                1,
                class.into(),
                map,
                Some(Geometry::Areas(vec![Polygon {
                    outer: ring(lat, lon, half_m),
                    holes: vec![],
                }])),
            )
        }
        fn cell_of(features: Vec<Feature>) -> Cell {
            let mut extent = Extent::invalid();
            for f in &features {
                extent.extend(&f.extent);
            }
            Cell {
                meta: CellMeta {
                    compilation_scale: 10_000,
                    ..Default::default()
                },
                features,
                extent,
            }
        }

        let near = cell_of(vec![
            area("M_COVR", LAT, LON, 3000.0, &[("CATCOV", 1)]),
            area("M_QUAL", LAT, LON, 3000.0, &[("CATZOC", 1)]),
            area("LNDARE", LAT + 0.02, LON, 100.0, &[]),
        ]);
        let far = cell_of(vec![
            area("M_COVR", LAT, LON + 1.7, 3000.0, &[("CATCOV", 1)]),
            area("LNDARE", LAT, LON + 1.7, 100.0, &[]),
        ]);

        let from = (LON - 0.005, LAT - 0.004);
        let to = (LON + 0.005, LAT + 0.004);
        let params = ArtifactParams {
            required_depth_m: 1.0,
            avoid_depth_m: 0.0,
            soft_prefer_depth_m: 0.0,
            required_air_draft_m: 0.0,
            lateral_margin_m: 30.0,
            endpoint_grace_radius_m: 150.0,
            catzoc_mode: CatzocMode::Full,
            allow_restricted_entry: false,
            force_finest_resolution: false,
        };
        let weights = ArtifactWeights::default();

        // The far cell really is droppable: the scope's own mandatory
        // term — the fine search's widest corridor — does not reach it.
        let from_w = lat_lon_to_world(from.1, from.0);
        let to_w = lat_lon_to_world(to.1, to.0);
        let term3 = fine_search_corridor_extent(from_w, to_w).expect("a well-formed corridor here");
        assert!(
            !term3.intersects(&far.extent),
            "the far cell must sit outside the fine search's own widest corridor, or this              test is not about the drop path at all"
        );

        let both: Vec<&Cell> = vec![&near, &far];
        let kept = filter_cells_to_corridor(&both, term3);
        assert_eq!(kept.len(), 1, "the far cell is dropped by the filter");

        let unscoped = artifact_route_lonlat(from.0, from.1, to.0, to.1, &both, &params, &weights)
            .expect("open water routes");
        let scoped = artifact_route_lonlat(from.0, from.1, to.0, to.1, &kept, &params, &weights)
            .expect("open water routes");

        assert_eq!(unscoped.diagnostics.catzoc_horizontal_m, 1000.0);
        assert_eq!(scoped.diagnostics.catzoc_horizontal_m, 5.0);
        assert_eq!(unscoped.diagnostics.ladder_cell_m, 256.0);
        assert_eq!(scoped.diagnostics.ladder_cell_m, 8.0);
        assert_ne!(
            unscoped, scoped,
            "THE POINT: dropping a cell 110 km from the route changed the answer. If this              ever stops being true, `routing::artifact::constraints::build` has learned to              keep its region-global scalars across a cell drop, and corridor scoping (see              `corridor_scope_extent`) can finally be wired up."
        );
    }

    #[test]
    fn the_recovered_search_corridor_never_comes_back_smaller_than_the_real_one() {
        // The load-bearing claim of the whole mechanism, measured rather
        // than read off two files: `fine_search_corridor_extent` recovers
        // its box through `corridor_bbox_lonlat`'s DEGREES, and must
        // never come back smaller than the World-unit box
        // `routing::artifact::search`'s widest widen attempt actually
        // builds. Reconstructed here from the same `pub(crate)`
        // constants and the same two primitives both real
        // implementations call (`routing::raster::Corridor::with_pad` and
        // `routing::artifact::search::corridor_with_pad` are the same
        // arithmetic; neither is reachable from here, both are three
        // lines).
        use crate::coords::sm_from_world;
        use crate::routing::raster::{
            CORRIDOR_PAD_CAP_M, CORRIDOR_PAD_FACTORS, CORRIDOR_PAD_FLOOR_M,
        };

        let widest_corridor = |from: WorldXy, to: WorldXy| -> Extent {
            let (ex, ey) = sm_from_world(to, from);
            let direct_m = (ex * ex + ey * ey).sqrt();
            let pad_m = (direct_m * CORRIDOR_PAD_FACTORS[CORRIDOR_PAD_FACTORS.len() - 1])
                .clamp(CORRIDOR_PAD_FLOOR_M, CORRIDOR_PAD_CAP_M);
            let centre = WorldXy::new(
                ((from.x as i64 + to.x as i64) / 2) as i32,
                ((from.y as i64 + to.y as i64) / 2) as i32,
            );
            let pad = radius_world_units(centre, pad_m) as i32;
            Extent::new(
                from.x.min(to.x).saturating_sub(pad),
                from.x.max(to.x).saturating_add(pad),
                from.y.min(to.y).saturating_sub(pad),
                from.y.max(to.y).saturating_add(pad),
            )
        };

        // A spread of real regimes, not one convenient pair: a degenerate
        // zero-length query, a few metres (the pad FLOOR binds), a few
        // hundred metres (this crate's fixture scale), a coastal hop, and
        // a leg long enough to saturate the 50 km pad CAP. Southern
        // hemisphere and a negative longitude included, since the World
        // y axis and the ±180° wrap are where a round trip would break.
        for &(lat0, lon0, lat1, lon1) in &[
            (54.0, 11.0, 54.0, 11.0),
            (54.0, 11.0, 54.00003, 11.00003),
            (53.9930, 11.3711, 53.9896, 11.3711),
            (54.43632, 13.03045, 54.43316, 13.03667),
            (55.0, 12.0, 55.5, 12.9),
            (37.78, -122.59, 37.30, -123.40),
            (-33.86, 151.20, -34.20, 151.60),
            (60.0, -5.0, 59.0, 1.0),
        ] {
            let from = lat_lon_to_world(lat0, lon0);
            let to = lat_lon_to_world(lat1, lon1);
            let real = widest_corridor(from, to);
            let recovered =
                fine_search_corridor_extent(from, to).expect("a well-formed corridor here");
            assert!(
                recovered.includes(&real),
                "({lat0},{lon0})→({lat1},{lon1}): recovered {recovered:?} must cover the \
                 fine search's own widest corridor {real:?} — a degrees round trip that \
                 came back SHORT would let a real cell be dropped"
            );
            // …and the slack must stay slack, not silently become a
            // second, sloppy pad: no edge may be more than
            // `SCOPE_ROUND_TRIP_SLACK_UNITS` plus one rounding step out.
            let bound = SCOPE_ROUND_TRIP_SLACK_UNITS + 1;
            assert!(
                (real.xmin - recovered.xmin) <= bound
                    && (recovered.xmax - real.xmax) <= bound
                    && (real.ymin - recovered.ymin) <= bound
                    && (recovered.ymax - real.ymax) <= bound,
                "({lat0},{lon0})→({lat1},{lon1}): recovered {recovered:?} drifted far past \
                 the intended {SCOPE_ROUND_TRIP_SLACK_UNITS}-unit slack around {real:?}"
            );
        }
    }

    #[test]
    fn scope_grows_with_the_pad_but_never_below_the_search_corridor() {
        let built = open_row(2);
        let comps = label_band(&built, 5.0);
        let portals = super::super::portals::detect_portals(&built, &comps);
        let route = topology_route(&built, &portals, 0, 1, 10).expect("a route must exist");
        let from = built.tiles[0].centre_of(1, 1);
        let to = built.tiles[1].centre_of(1, 1);

        let tight = corridor_scope_extent(&built, &route, from, to, 0.0);
        // 20 km is far past the fine search's own 2 km pad floor for a
        // hop this short, so the corridor term genuinely dominates and
        // the pad has to show up in the answer.
        let loose = corridor_scope_extent(&built, &route, from, to, 20_000.0);
        assert!(loose.includes(&tight));
        assert_ne!(loose, tight, "a real pad must actually grow the scope");
    }

    #[test]
    fn a_cell_just_outside_the_raw_corridor_survives_the_padded_scope() {
        // Padding is not decoration: a cell the tile-granularity corridor
        // misses, but that a real fine-search detour could still need,
        // must stay in the slice.
        let built = open_row(2);
        let route = TopologyRoute {
            start_tile: 0,
            goal_tile: 0,
            hops: Vec::new(),
            cost_mm: 0,
            demoted_portals: Vec::new(),
            directional_penalized_portals: Vec::new(),
        };
        let raw = corridor_extent(&built, &route, 0.0);
        // A one-world-unit sliver hugging the corridor's east edge from
        // outside — inside nothing but the pad.
        let just_outside = Extent::new(raw.xmax + 1, raw.xmax + 2, raw.ymin, raw.ymax);
        assert!(!raw.intersects(&just_outside));

        let cell = cell_claiming(just_outside, 10_000);
        let other = cell_claiming(raw, 10_000);
        let cells = [&other, &cell];

        let padded = corridor_extent(&built, &route, 500.0);
        assert!(padded.intersects(&just_outside));
        assert_eq!(filter_cells_to_corridor(&cells, padded).len(), 2);
        // …and it is dropped without the pad, so the assertion above is
        // really about the pad rather than about nothing.
        assert_eq!(filter_cells_to_corridor(&cells, raw).len(), 1);
    }

    #[test]
    fn straight_line_lower_bound_grows_with_distance_and_is_symmetric() {
        let m = 1.0;
        let near = straight_line_lower_bound_mm((LON, LAT), (LON + 0.01, LAT), m);
        let far = straight_line_lower_bound_mm((LON, LAT), (LON + 0.10, LAT), m);
        assert!(near > 0);
        assert!(far > near);
        assert_eq!(
            straight_line_lower_bound_mm((LON, LAT), (LON + 0.10, LAT), m),
            straight_line_lower_bound_mm((LON + 0.10, LAT), (LON, LAT), m),
        );
        // Degenerate: same point → 0, never negative.
        assert_eq!(straight_line_lower_bound_mm((LON, LAT), (LON, LAT), m), 0);
        // Tighter floor → strictly larger bound.
        assert!(
            straight_line_lower_bound_mm((LON, LAT), (LON + 0.10, LAT), 1.0)
                > straight_line_lower_bound_mm((LON, LAT), (LON + 0.10, LAT), MIN_MULTIPLIER)
        );
    }

    #[test]
    fn effective_min_multiplier_is_one_without_preference_and_floors_at_min() {
        assert_eq!(effective_min_multiplier(0.0), 1.0);
        assert_eq!(effective_min_multiplier(0.3), 0.7);
        // Clamped at MIN_MULTIPLIER, never below.
        assert_eq!(effective_min_multiplier(5.0), MIN_MULTIPLIER);
        // Non-finite / negative → treated as no discount.
        assert_eq!(effective_min_multiplier(f64::NAN), 1.0);
        assert_eq!(effective_min_multiplier(-1.0), 1.0);
    }

    #[test]
    fn verification_status_wire_spellings_are_stable() {
        assert_eq!(VerificationStatus::Verified.as_str(), "verified");
        assert_eq!(
            VerificationStatus::ApproximateLegs.as_str(),
            "approximate_legs"
        );
        assert_eq!(VerificationStatus::Unverified.as_str(), "unverified");
    }

    #[test]
    fn route_result_gap_is_zero_at_the_bound_and_clamps_below_it() {
        // A hand-built ArtifactRoute is verbose; the gap arithmetic is
        // the part worth pinning in isolation. `from_fine_route` takes
        // the route only for its cost / legs, so a minimal one suffices.
        let route = crate::routing::ArtifactRoute {
            waypoints: vec![(0.0, 0.0), (1.0, 0.0)],
            distance_m: 0.0,
            approximate_legs: vec![false],
            check_manually_legs: vec![false],
            start_snap_m: 0.0,
            end_snap_m: 0.0,
            diagnostics: crate::routing::ArtifactDiagnostics {
                grid_cols: 0,
                grid_rows: 0,
                cell_size_m: 0.0,
                ladder_cell_m: 0.0,
                finest_allowed_cell_m: 0.0,
                catzoc_horizontal_m: 0.0,
                compilation_scale: 0,
                blocked_cells: 0,
                unknown_cells: 0,
                nodes_expanded: 0,
                corridor_widen_attempts: 0,
                route_cost_mm: 1_000,
            },
        };
        // cost == bound → gap 0.
        assert_eq!(
            RouteResult::from_fine_route(&route, 1_000).optimality_gap,
            0.0
        );
        // cost above bound → positive gap.
        let g = RouteResult::from_fine_route(&route, 800).optimality_gap;
        assert!((g - 0.25).abs() < 1e-9, "{g}");
        // bound above cost (can't happen with an admissible bound, but be
        // defensive) → clamped, not negative.
        assert_eq!(
            RouteResult::from_fine_route(&route, 5_000).optimality_gap,
            0.0
        );
        // no bound → gap 0, status Verified (no approximate legs).
        let r = RouteResult::from_fine_route(&route, 0);
        assert_eq!(r.optimality_gap, 0.0);
        assert_eq!(r.verification_status, VerificationStatus::Verified);
    }

    #[test]
    fn route_result_status_follows_the_approximate_legs() {
        let mut route = crate::routing::ArtifactRoute {
            waypoints: vec![(0.0, 0.0), (1.0, 0.0)],
            distance_m: 0.0,
            approximate_legs: vec![true],
            check_manually_legs: vec![false],
            start_snap_m: 0.0,
            end_snap_m: 0.0,
            diagnostics: crate::routing::ArtifactDiagnostics {
                grid_cols: 0,
                grid_rows: 0,
                cell_size_m: 0.0,
                ladder_cell_m: 0.0,
                finest_allowed_cell_m: 0.0,
                catzoc_horizontal_m: 0.0,
                compilation_scale: 0,
                blocked_cells: 0,
                unknown_cells: 0,
                nodes_expanded: 0,
                corridor_widen_attempts: 0,
                route_cost_mm: 1_000,
            },
        };
        assert_eq!(
            RouteResult::from_fine_route(&route, 900).verification_status,
            VerificationStatus::ApproximateLegs
        );
        route.approximate_legs = vec![false];
        assert_eq!(
            RouteResult::from_fine_route(&route, 900).verification_status,
            VerificationStatus::Verified
        );
    }
}
