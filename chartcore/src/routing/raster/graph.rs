// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! An ADAPTIVE-RESOLUTION GRAPH search — nodes placed by recursive
//! quadtree subdivision (coarse in open water, fine near a hazard),
//! edges validated by exact `visibility::visible` geometry and a beam-
//! clearance check, A* over the resulting sparse graph with a cost
//! formula built from flat zone-membership multipliers. A genuinely
//! different SEARCH STRUCTURE from [`super`]'s own per-request UNIFORM
//! grid + flood-fill A* — built to compare the two live
//! ("give me a setting where i can select different routing algorithms").
//!
//! # What this is modelled on, and what it deliberately is NOT
//!
//! Modelled on signalk-routeiq (github.com/marcelrv/signalk-routeiq)'s
//! own documented approach — read directly from its real source
//! (`featurespecification.md`), not guessed: adaptive quadtree nodes from
//! ~500m in open water down to ~20m near hazards, A* over that graph,
//! `cost = distance × fairwayMultiplier × directionalPenalty ×
//! oneWayPenalty`. This module borrows the SHAPE of that (adaptive nodes,
//! a sparse graph instead of a uniform grid, a multiplicative cost
//! formula) but is not a literal port — two deliberate, DOCUMENTED
//! simplifications, not silent gaps:
//!
//! 1. **No supernode/contraction-hierarchy speedup.** RouteIQ's own
//!    hierarchy exists to keep a huge, persistent, planet-scale graph
//!    fast; this module's own corridor-bounded node budget
//!    ([`MAX_NODES`]) already keeps a single request fast at the scale
//!    this app cares about (coastal cruising, not continental transits) —
//!    see [`super::CORRIDOR_PAD_CAP_M`]'s own docs for the identical
//!    reasoning applied to the uniform-grid search.
//! 2. **Undirected, for now.** RouteIQ tests each mark's correct side
//!    against every individual EDGE's own local bearing — genuinely
//!    direction-sensitive. This module instead reuses the SAME
//!    whole-route-bearing buoyage ring the uniform-grid search already
//!    builds (`buoyage::build_buoyage_penalty`, one ring for the whole
//!    request) as a flat zone-membership term, identical regardless of
//!    which way an individual edge is walked — the same approximation
//!    [`super`]'s own `CostModel` already makes, not a new one. `directionalPenalty`/
//!    `oneWayPenalty` (TSS lane direction specifically) are not
//!    implemented at all: chartcore has no reader for a TSS lane's own
//!    `ORIENT` attribute yet.
//!
//! (Air-draft/bridge clearance, listed here as a third gap in an earlier
//! draft of this module, is no longer one: `BRIDGE`/`CBLOHD` vertical-
//! clearance blocking now lives in `routing::hazards::build_hazard_index`
//! itself — see that module's own "Air draft" docs — so this search gets
//! it automatically through the SAME `hazard_rings` its caller already
//! builds, with no graph-specific code of its own needed. A beam (width)
//! check IS graph-specific, and separately implemented here, via the same
//! [`DistanceField`] the shallow-water preference already uses.)
//!
//! Even with these three set aside, the remaining shape — adaptive nodes,
//! a sparse visibility-validated graph, a multiplicative fairway/TSS/
//! buoyage cost — is a real, structurally different search from
//! [`super::shortest_path_weighted`]'s uniform grid, which is the actual
//! point of building it.

use std::collections::VecDeque;

use super::distance_field::DistanceField;
use super::{rasterize, simplify_path, size_grid_explicit, Corridor};
use crate::coords::{sm_from_world, worldy_to_lat, WorldXy};
use crate::routing::hazards::rings_contain;
use crate::routing::visibility::{visible, RingBox};
use pathfinding::directed::astar::astar;

/// No node closer together than this near a hazard — RouteIQ's own
/// documented floor for a narrow channel.
const MIN_NODE_CELL_M: f64 = 20.0;
/// No node spacing coarser than this even in open water, as an absolute
/// UPPER bound for a genuinely large corridor — RouteIQ's own documented
/// open-water spacing. NOT the actual open-water target for a typical
/// request — see [`TARGET_BASE_DIM`] for why a fixed absolute value here
/// alone would be the wrong default.
const MAX_NODE_CELL_M: f64 = 500.0;
/// The open-water base resolution is CORRIDOR-RELATIVE, not
/// [`MAX_NODE_CELL_M`]'s fixed absolute value — real bug, caught by this
/// module's own tests: an 11km corridor alone needs ~1000+ nodes just to
/// cover it uniformly at a fixed 500m, exhausting [`MAX_NODES`] before
/// the hazard-adjacent refinement this whole module exists for ever ran.
/// Sizing the base cell so the corridor's own LONGER dimension divides
/// into roughly this many cells instead keeps the open-water node count
/// small regardless of corridor size — the same "cost must not scale
/// with the corridor's own span" instinct
/// [`super::CORRIDOR_PAD_CAP_M`]'s own docs already state for the old
/// visibility-graph search this module's sibling replaced. Clamped
/// against [`MAX_NODE_CELL_M`] so a genuinely huge corridor still gets
/// AT LEAST that fine a base resolution, not coarser.
const TARGET_BASE_DIM: f64 = 16.0;
/// A quadtree cell within this many multiples of its OWN current size of
/// a hazard's own bounding box gets refined (down to [`MIN_NODE_CELL_M`])
/// — SELF-RELATIVE, not a fixed absolute distance, and the difference is
/// load-bearing: a real bug, caught by this module's own tests, from an
/// earlier fixed-200m version. A fixed absolute margin costs nothing at
/// coarse levels but becomes ENORMOUS relative to a cell once cells
/// shrink near [`MIN_NODE_CELL_M`] — a 200m halo around even one modest
/// (~600m) obstacle demands refining a ~1km×1km area all the way to 20m,
/// up to ~2,500 nodes for ONE small hazard alone, exhausting [`MAX_NODES`]
/// before the search even reaches the far side of it. Scaling the margin
/// by the cell's OWN size instead is the standard adaptive-mesh-
/// refinement technique for exactly this failure mode: the test area
/// shrinks together with the cell at every level, so the total node cost
/// of "wrap a hazard's boundary down to fine resolution" stays bounded
/// (geometric, not exploding) regardless of how many recursion levels
/// deep the refinement goes.
const REFINE_MARGIN_FACTOR: f64 = 1.5;
/// Hard cap on total nodes, regardless of how much refinement a dense
/// hazard field would otherwise ask for — the same "never silently blow
/// the budget" rule [`super::HARD_MAX_DIM`] enforces for the uniform
/// grid. Subdivision simply stops early past this; the result degrades to
/// coarser-than-ideal resolution near a hazard rather than an unbounded
/// search.
const MAX_NODES: usize = 2_000;
/// Per node, how many of its CLOSEST other nodes are considered as edge
/// candidates — the near tier of [`NEAR_CANDIDATE_COUNT`] +
/// [`FAR_CANDIDATE_COUNT`], see that pair's own docs for why a single
/// "closest K" pool isn't enough on its own.
const NEAR_CANDIDATE_COUNT: usize = 16;
/// A STRATIFIED sample of `FAR_CANDIDATE_COUNT` further-out candidates,
/// evenly spread across the remaining distance range beyond
/// [`NEAR_CANDIDATE_COUNT`] — not more of the same "closest" pool. A real
/// bug, caught live against a real chart: a pure "closest K" candidate
/// pool fragments badly wherever node DENSITY varies by orders of
/// magnitude, which real hazard-adjacent refinement guarantees it will —
/// a small, densely hazard-refined cluster (a cluster of skerries, a
/// marina) has every one of ITS OWN members within a few tens of metres
/// of each other, so each one's own "closest 24" search fills up entirely
/// on other members of the SAME cluster, never once considering a node in
/// the sparser open-water mesh just beyond it, even though a perfectly
/// good, `visible()`-clear edge to one exists. Measured live: a
/// completely open-water request (confirmed independently via the
/// `raster` algorithm, which found a plain straight line) still came back
/// "no path" from this module — a BFS from `from`'s own component found
/// only 554 of 1,853 total nodes reachable, `to` not among them. Total
/// candidate count (16 + 8 = 24) is unchanged from before this fix — this
/// is a smarter SELECTION, not a bigger one, so it costs nothing extra.
const FAR_CANDIDATE_COUNT: usize = 8;
/// Per node, how many of its candidate edges (nearest first) are actually
/// kept once they pass the visibility/beam checks — bounds total graph
/// edge count, so A* itself stays cheap regardless of how open the water
/// around a given node is.
const MAX_OUT_DEGREE: usize = 8;
/// Half-width of the small box FORCIBLY subdivided (in its own budget,
/// see `graph_route`'s own docs) around `from` and `to` specifically,
/// regardless of what the corridor-wide budgeted quadtree decided nearby.
const ENDPOINT_SEED_RADIUS_M: f64 = 600.0;

/// RouteIQ's own documented fairway discount — see the module docs for
/// why this (and the two constants below) are FLAT zone-membership
/// multipliers here, not [`super::CostModel`]'s distance-graded terms.
const FAIRWAY_MULTIPLIER: f64 = 0.8;
/// RouteIQ's own documented open-water (non-fairway) multiplier — NOT
/// `1.0`: a fairway is preferred relative to ordinary open water, not
/// merely unpenalized.
const OPEN_WATER_MULTIPLIER: f64 = 1.2;
/// RouteIQ's own documented wrong-side-of-a-lateral-mark penalty.
const BUOYAGE_WRONG_SIDE_MULTIPLIER: f64 = 5.0;
/// A flat TSS-avoidance multiplier — RouteIQ's own `oneWayPenalty` needs
/// a lane's charted DIRECTION, which chartcore does not read (see the
/// module docs); this is a soft "prefer not to" cost instead, the same
/// role [`super::CostModel`]'s own TSS term plays, at a fixed weight
/// (this module has no configurable weight knob, matching RouteIQ's own
/// fixed-formula design).
const TSS_MULTIPLIER: f64 = 1.5;

/// The smallest multiplier ANY edge can carry — [`FAIRWAY_MULTIPLIER`],
/// since none of the others ever discount below `1.0`. The A* heuristic
/// scales a plain Euclidean distance by this, the exact
/// `heuristic_scale` proof [`super::octile_heuristic`]'s own docs already
/// establish for the uniform grid's fairway discount, applied here to a
/// continuous (not grid-quantized) heuristic instead.
const MIN_MULTIPLIER: f64 = FAIRWAY_MULTIPLIER;

/// A found path over the adaptive graph: waypoints in `(lon, lat)` order,
/// start to end inclusive, and total length in real ground metres. No
/// `approximate_legs` — see the module docs' point 2 (this module has no
/// exact-per-leg-reverification pass of its own yet; a found path is
/// exact by construction, via the same [`visible`] test
/// [`super::verify_legs`] itself uses, just checked once per edge at
/// build time rather than re-checked after the fact).
#[derive(Debug, Clone, PartialEq)]
pub struct GraphRoute {
    pub waypoints: Vec<(f64, f64)>,
    pub distance_m: f64,
}

/// The adaptive-graph search. `from`/`to` must both already be SAFE
/// (outside `hazard_rings`) — unlike [`super::shortest_path_weighted`],
/// this module has no "nudge onto the nearest free cell / stitch on a
/// straight stub" fallback for an unsafe endpoint (see the module docs'
/// own scope). `None` when either endpoint is itself unsafe, or no path
/// connects them within this search's own node/edge budget.
///
/// `min_clearance_m` is the vessel's own beam-based hard constraint
/// (HALF beam plus whatever margin the caller wants, already combined —
/// this function is agnostic of the convention, same as
/// `safety_depth_m` elsewhere in this crate): an edge is rejected when
/// its own minimum clearance to the hazard union, sampled via
/// [`DistanceField`], is less than this.
#[allow(clippy::too_many_arguments)]
pub fn graph_route(
    from: WorldXy,
    to: WorldXy,
    hazard_rings: &[Vec<WorldXy>],
    fairway_rings: &[Vec<WorldXy>],
    tss_rings: &[Vec<WorldXy>],
    buoyage_rings: &[Vec<WorldXy>],
    min_clearance_m: f64,
) -> Option<GraphRoute> {
    if rings_contain(hazard_rings, from) || rings_contain(hazard_rings, to) {
        return None;
    }

    let corridor = Corridor::around(from, to, 1.0);
    let hazard_bboxes: Vec<RingBox> = hazard_rings.iter().map(|r| RingBox::of(r)).collect();
    let ground_scale = worldy_to_lat(corridor.center().y).to_radians().cos();

    // -- node placement: recursive quadtree subdivision ---------------------
    let min_cell_world =
        crate::routing::hazards::radius_world_units(corridor.center(), MIN_NODE_CELL_M);
    let max_cell_world_cap =
        crate::routing::hazards::radius_world_units(corridor.center(), MAX_NODE_CELL_M);
    // Corridor-relative base cell (see TARGET_BASE_DIM's own docs): the
    // LARGER of "corridor span / TARGET_BASE_DIM cells" and
    // `max_cell_world_cap` (500m) — never finer than 500m regardless of
    // corridor size (that would just be the old, expensive fixed-absolute
    // behaviour again for a SMALL corridor), and for a bigger corridor,
    // coarser still, so the base node count stays near
    // `TARGET_BASE_DIM²` however large the corridor actually is.
    let long_span_world =
        ((corridor.xmax - corridor.xmin).max(corridor.ymax - corridor.ymin)) as f64;
    let max_cell_world = (long_span_world / TARGET_BASE_DIM).max(max_cell_world_cap);

    // A small, ADAPTIVE local subdivision around EACH real endpoint, in
    // its OWN node budget, separate from the corridor-wide pass below —
    // a real endpoint (a boat's actual mooring, tucked among piers and
    // other moored boats) can sit somewhere the corridor-wide budget
    // never happens to refine, however large that budget is: node
    // placement there is driven by the CORRIDOR's own overall hazard
    // shape, not by "is this exactly where `from` sits". Uses the SAME
    // adaptive `max_cell_world` as the main pass (coarse in open water,
    // fine only near an actual hazard) over a small radius centred on the
    // endpoint — not `min_cell_world` as the cap, which forces the WHOLE
    // box to full 20m resolution unconditionally and is both far slower
    // and mostly wasted on open water the endpoint isn't actually near. A
    // SEPARATE budget (not shared with the corridor-wide pass) matters:
    // a shared one let seeding silently steal nodes the corridor-wide
    // pass needed elsewhere, once tipping an already-tight scenario from
    // "finds the path" to "doesn't quite get there" — caught by this
    // module's own tests.
    let mut seed_nodes: Vec<WorldXy> = Vec::new();
    let seed_radius_world =
        crate::routing::hazards::radius_world_units(corridor.center(), ENDPOINT_SEED_RADIUS_M)
            as i32;
    for anchor in [from, to] {
        subdivide(
            anchor.x - seed_radius_world,
            anchor.x + seed_radius_world,
            anchor.y - seed_radius_world,
            anchor.y + seed_radius_world,
            hazard_rings,
            &hazard_bboxes,
            min_cell_world,
            max_cell_world,
            &mut seed_nodes,
        );
    }

    let mut nodes: Vec<WorldXy> = Vec::new();
    subdivide(
        corridor.xmin,
        corridor.xmax,
        corridor.ymin,
        corridor.ymax,
        hazard_rings,
        &hazard_bboxes,
        min_cell_world,
        max_cell_world,
        &mut nodes,
    );
    nodes.extend(seed_nodes);
    nodes.retain(|&p| !rings_contain(hazard_rings, p));

    let from_idx = nodes.len();
    nodes.push(from);
    let to_idx = nodes.len();
    nodes.push(to);

    // -- a beam-clearance field over the same corridor -----------------------
    // Reuses the shallow-water preference's own exact distance transform —
    // built once over a grid fine enough to resolve MIN_NODE_CELL_M, same
    // "cheap enough to build fresh per request, no caching" posture as
    // there.
    let spec = size_grid_explicit(&corridor, MIN_NODE_CELL_M, super::HARD_MAX_DIM);
    let grid = rasterize(
        hazard_rings,
        &corridor,
        spec.cell_size_world,
        spec.cols,
        spec.rows,
    );
    let field = DistanceField::build(&grid);
    let clearance_m = |p: WorldXy| -> f64 {
        match &field {
            None => f64::INFINITY, // no blocked cell anywhere on this grid at all
            Some(f) => {
                let (cx, cy) =
                    world_to_grid_cell(&corridor, spec.cell_size_world, p, spec.cols, spec.rows);
                f.dist_m(cx, cy, spec.cell_size_m)
            }
        }
    };

    // `from`/`to` get an EXACT clearance, not the grid-snapped one above —
    // real bug, caught live against a real chart (a real boat position a
    // few metres off a real jetty): the clearance grid classifies a whole
    // MIN_NODE_CELL_M (20m) cell as "blocked" the instant its CENTER falls
    // inside a hazard ring (`rasterize`'s own scanline test), so a real
    // endpoint sharing that cell with a jetty/breakwater — genuinely safe
    // by the exact `rings_contain` check just above, which is why
    // `graph_route` didn't already bail out — reads a grid-snapped
    // clearance of EXACTLY 0.0 regardless of how many metres of open water
    // it actually has. Every candidate edge touching that endpoint then
    // fails the beam-clearance gate unconditionally, stranding it with
    // degree zero and forcing the honest-straight-line fallback for what
    // was, geometrically, a perfectly fine start point — the reported
    // "never creates an actual route only straight lines" (arbitrary
    // internal quadtree nodes don't have this problem: they're cell
    // CENTERS placed by `subdivide` itself, already filtered by
    // `rings_contain`, so they're never adjacent-to-the-boundary the way
    // an externally supplied real-world point routinely is).
    let from_clearance = exact_clearance_m(from, hazard_rings, ground_scale);
    let to_clearance = exact_clearance_m(to, hazard_rings, ground_scale);

    // -- edges: nearest candidates, filtered by visibility + beam -----------
    let adjacency = build_adjacency(
        &nodes,
        hazard_rings,
        &hazard_bboxes,
        fairway_rings,
        tss_rings,
        buoyage_rings,
        &clearance_m,
        from_idx,
        from_clearance,
        to_idx,
        to_clearance,
        min_clearance_m,
        ground_scale,
    );

    // -- A*, admissible heuristic (see MIN_MULTIPLIER's own docs) -----------
    let goal = nodes[to_idx];
    let heuristic = |i: &usize| -> u64 {
        let (ex, ey) = sm_from_world(nodes[*i], goal);
        let d_m = (ex * ex + ey * ey).sqrt() * ground_scale;
        (d_m * MIN_MULTIPLIER) as u64
    };
    let (path, _cost) = astar(
        &from_idx,
        |&i| adjacency[i].iter().map(|&(j, cost)| (j, cost as u64)),
        heuristic,
        |&i| i == to_idx,
    )?;

    let world_path: Vec<WorldXy> = path.iter().map(|&i| nodes[i]).collect();
    let simplified = simplify_path(&world_path, hazard_rings, &hazard_bboxes, None);
    let distance_m = super::path_distance_m(&simplified, from, ground_scale);
    Some(GraphRoute {
        waypoints: simplified.iter().map(|&p| super::to_lonlat(p)).collect(),
        distance_m,
    })
}

/// The real minimum distance from `p` to the hazard union's boundary —
/// exact point-to-segment distance over every ring edge, not the
/// [`DistanceField`]'s grid-snapped approximation. See `graph_route`'s own
/// docs on `from_clearance`/`to_clearance` for why an externally supplied
/// endpoint specifically needs this rather than the fast grid lookup every
/// other clearance query in this module uses.
///
/// Unconditional over every ring/edge — no bounding-box pre-filter, unlike
/// [`visible`]'s own. This runs at most TWICE per request (`from`, `to`),
/// so even a hazard-index-heavy real chart request (dozens of cells,
/// hundreds of rings) costs nothing worth guarding; a metres-vs-world-units
/// pad here would be one more thing to get wrong for a search this hot
/// path never actually needs to be.
fn exact_clearance_m(p: WorldXy, hazard_rings: &[Vec<WorldXy>], ground_scale: f64) -> f64 {
    let mut best = f64::INFINITY;
    for ring in hazard_rings {
        let n = ring.len();
        for i in 0..n {
            let a = ring[i];
            let b = ring[(i + 1) % n];
            let d = point_to_segment_distance_m(p, a, b, ground_scale);
            if d < best {
                best = d;
            }
        }
    }
    best
}

/// Point-to-segment distance in real ground metres, via the same
/// Simple-Mercator metric conversion ([`sm_from_world`]) every other exact
/// distance in this module already uses.
fn point_to_segment_distance_m(p: WorldXy, a: WorldXy, b: WorldXy, ground_scale: f64) -> f64 {
    let (px, py) = sm_from_world(p, a);
    let (bx, by) = sm_from_world(b, a);
    let (px, py) = (px * ground_scale, py * ground_scale);
    let (bx, by) = (bx * ground_scale, by * ground_scale);
    let seg_len2 = bx * bx + by * by;
    let t = if seg_len2 > 0.0 {
        ((px * bx + py * by) / seg_len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (cx, cy) = (bx * t, by * t);
    let (dx, dy) = (px - cx, py - cy);
    (dx * dx + dy * dy).sqrt()
}

/// BREADTH-first, not depth-first — a real bug, caught live against a real
/// chart: the original recursive (depth-first, call-stack) version spends
/// [`MAX_NODES`] in whatever quadrant it happens to visit FIRST, purely by
/// `(xmin, ymin)` ordering. A real ~4nm Danish coastal request had its
/// entire node budget consumed refining one complex, hazard-dense corner
/// of the corridor before recursion ever reached the quadrant the actual
/// start point sat in — that point's nearest surviving node ended up
/// ~1.9km away (and not even visible from there), giving it degree ZERO
/// regardless of how correct its own clearance value was. A `VecDeque`
/// FIFO processed level-by-level instead means every region of the
/// corridor gets its fair share of the budget at each refinement depth
/// BEFORE any single region is allowed to go deeper — the standard fix for
/// budget-capped adaptive quadtree refinement, and the reason this isn't a
/// recursive function anymore.
#[allow(clippy::too_many_arguments)]
fn subdivide(
    xmin: i32,
    xmax: i32,
    ymin: i32,
    ymax: i32,
    hazard_rings: &[Vec<WorldXy>],
    hazard_bboxes: &[RingBox],
    min_cell_world: f64,
    max_cell_world: f64,
    nodes: &mut Vec<WorldXy>,
) {
    let mut queue: VecDeque<(i32, i32, i32, i32)> = VecDeque::new();
    queue.push_back((xmin, xmax, ymin, ymax));
    while let Some((xmin, xmax, ymin, ymax)) = queue.pop_front() {
        if nodes.len() >= MAX_NODES {
            break;
        }
        let size = ((xmax - xmin).max(ymax - ymin)) as f64;
        // SELF-relative margin (this cell's own current size × a fixed
        // factor) — see REFINE_MARGIN_FACTOR's own docs for why a fixed
        // ABSOLUTE margin here was a real, since-fixed bug.
        let margin = (size * REFINE_MARGIN_FACTOR) as i32;
        // Collected ONCE, reused for both the `near_hazard` test and the
        // "fully buried" sample below — a real performance bug, caught
        // live against a real chart: `rings_contain` scans EVERY hazard
        // ring unconditionally (no bbox pre-filter of its own), and a
        // real chart's hazard set can be over a thousand rings (many
        // small rocks/shoals). Calling it via the FULL `hazard_rings`
        // slice for every near-hazard cell this BFS visits — potentially
        // thousands of them across a hazard-dense corridor — cost over a
        // MINUTE per request. Filtering to just the rings whose bbox
        // could plausibly matter HERE (typically a small handful, however
        // large the corridor's total hazard set is) turns that into a
        // local, bounded cost per cell.
        // Cloned, not just referenced: `rings_contain` needs an owned
        // `&[Vec<WorldXy>]` slice to preserve its own nonzero-WINDING
        // semantics exactly (a hazard ring with a hole cut out of it via
        // an opposite-wound inner ring) — a plain "inside ANY single
        // ring" OR test would silently get that case wrong. The subset
        // being cloned is the whole point of filtering first: typically a
        // handful of small rings, however large the corridor's total
        // hazard set is.
        let nearby: Vec<Vec<WorldXy>> = hazard_rings
            .iter()
            .zip(hazard_bboxes)
            .filter(|(_, bb)| {
                bb.overlaps(xmin - margin, xmax + margin, ymin - margin, ymax + margin)
            })
            .map(|(r, _)| r.clone())
            .collect();
        let near_hazard = !nearby.is_empty();
        if near_hazard {
            // A ring's own BBOX (used just above, deliberately cheap) can
            // be far bigger than its actual footprint — one big, complex
            // coastline polygon's bbox can span an entire corridor even
            // though the corridor only clips a small bite out of it. Left
            // unchecked, `near_hazard` fires for every cell anywhere near
            // that bbox, not just near the real shoreline, forcing
            // refinement all the way to MIN_NODE_CELL_M over solid
            // land/interior water — a REAL bug, caught live against a real
            // chart. A cheap corner+center sample catches the common
            // case — a cell already fully buried inside a hazard, nowhere
            // near its actual boundary — and stops right there: no node,
            // no further splitting, budget preserved for cells that are
            // actually near a hazard EDGE.
            let cx = xmin + (xmax - xmin) / 2;
            let cy = ymin + (ymax - ymin) / 2;
            let sample = [
                WorldXy::new(xmin, ymin),
                WorldXy::new(xmax, ymin),
                WorldXy::new(xmin, ymax),
                WorldXy::new(xmax, ymax),
                WorldXy::new(cx, cy),
            ];
            if sample.iter().all(|&p| rings_contain(&nearby, p)) {
                continue;
            }
        }
        let must_split = size > max_cell_world || (near_hazard && size > min_cell_world);
        if must_split && size > min_cell_world {
            let mx = xmin + (xmax - xmin) / 2;
            let my = ymin + (ymax - ymin) / 2;
            queue.push_back((xmin, mx, ymin, my));
            queue.push_back((mx, xmax, ymin, my));
            queue.push_back((xmin, mx, my, ymax));
            queue.push_back((mx, xmax, my, ymax));
        } else {
            nodes.push(WorldXy::new(
                xmin + (xmax - xmin) / 2,
                ymin + (ymax - ymin) / 2,
            ));
        }
    }
}

/// A query point's cell in the SAME grid `field` was built over — the
/// same mapping [`super::world_to_cell`]/[`super::clamp_cell`] apply,
/// duplicated as a two-line inline rather than exposed, since this is
/// the only place outside [`super`]'s own search loop that needs it.
fn world_to_grid_cell(
    corridor: &Corridor,
    cell_size_world: f64,
    p: WorldXy,
    cols: u32,
    rows: u32,
) -> (i32, i32) {
    let cx = ((p.x - corridor.xmin) as f64 / cell_size_world).floor() as i32;
    let cy = ((p.y - corridor.ymin) as f64 / cell_size_world).floor() as i32;
    (cx.clamp(0, cols as i32 - 1), cy.clamp(0, rows as i32 - 1))
}

#[allow(clippy::too_many_arguments)]
fn build_adjacency(
    nodes: &[WorldXy],
    hazard_rings: &[Vec<WorldXy>],
    hazard_bboxes: &[RingBox],
    fairway_rings: &[Vec<WorldXy>],
    tss_rings: &[Vec<WorldXy>],
    buoyage_rings: &[Vec<WorldXy>],
    clearance_m: &impl Fn(WorldXy) -> f64,
    from_idx: usize,
    from_clearance: f64,
    to_idx: usize,
    to_clearance: f64,
    min_clearance_m: f64,
    ground_scale: f64,
) -> Vec<Vec<(usize, f64)>> {
    // `from`/`to` use their own EXACT clearance (see `graph_route`'s own
    // docs on `exact_clearance_m`) rather than a fresh `clearance_m(...)`
    // grid lookup per call — same node, same answer, and the point of the
    // exact version is specifically to NOT re-derive the grid-snapped one.
    let node_clearance = |k: usize, p: WorldXy| -> f64 {
        if k == from_idx {
            from_clearance
        } else if k == to_idx {
            to_clearance
        } else {
            clearance_m(p)
        }
    };
    let n = nodes.len();
    let mut adjacency = vec![Vec::new(); n];
    for i in 0..n {
        // ALL other nodes by raw world-unit distance — cheap (no sqrt, no
        // metre conversion) since this is purely a ranking, not a real
        // distance. Split into a NEAR tier (closest) and a stratified FAR
        // tier (see [`FAR_CANDIDATE_COUNT`]'s own docs) rather than just
        // truncating to the closest — the far tier is what lets a locally
        // dense hazard-refined cluster bridge out to the sparser mesh
        // beyond it.
        let mut ranked: Vec<(usize, i64)> = (0..n)
            .filter(|&j| j != i)
            .map(|j| {
                let dx = (nodes[j].x - nodes[i].x) as i64;
                let dy = (nodes[j].y - nodes[i].y) as i64;
                (j, dx * dx + dy * dy)
            })
            .collect();
        ranked.sort_unstable_by_key(|&(_, d2)| d2);

        let near: Vec<(usize, i64)> = ranked.iter().copied().take(NEAR_CANDIDATE_COUNT).collect();
        let rest = &ranked[near.len().min(ranked.len())..];
        let far: Vec<(usize, i64)> = if rest.is_empty() {
            Vec::new()
        } else {
            let stride = (rest.len() / FAR_CANDIDATE_COUNT.max(1)).max(1);
            rest.iter()
                .step_by(stride)
                .take(FAR_CANDIDATE_COUNT)
                .copied()
                .collect()
        };

        let try_add = |adjacency: &mut Vec<Vec<(usize, f64)>>, j: usize| -> bool {
            if !visible(nodes[i], nodes[j], hazard_rings, hazard_bboxes) {
                return false;
            }
            let mid = WorldXy::new((nodes[i].x + nodes[j].x) / 2, (nodes[i].y + nodes[j].y) / 2);
            if clearance_m(mid) < min_clearance_m
                || node_clearance(i, nodes[i]) < min_clearance_m
                || node_clearance(j, nodes[j]) < min_clearance_m
            {
                return false;
            }
            let (ex, ey) = sm_from_world(nodes[j], nodes[i]);
            let distance_m = (ex * ex + ey * ey).sqrt() * ground_scale;
            let mut multiplier = if rings_contain(fairway_rings, mid) {
                FAIRWAY_MULTIPLIER
            } else {
                OPEN_WATER_MULTIPLIER
            };
            if rings_contain(tss_rings, mid) {
                multiplier *= TSS_MULTIPLIER;
            }
            if rings_contain(buoyage_rings, mid) {
                multiplier *= BUOYAGE_WRONG_SIDE_MULTIPLIER;
            }
            let cost = distance_m * multiplier;
            adjacency[i].push((j, cost));
            // Mirror onto j too: a pure one-directional k-NN pick is not
            // enough on its own — a node in a locally sparse pocket next
            // to a much denser
            // cluster (this module's own "near a small, locally-refined
            // hazard" shape, exactly) can end up in several OTHER nodes'
            // own candidate lists without any of THEM ever appearing in
            // its own — real bug, caught by this module's own tests: a
            // request's own destination point had eight outgoing edges
            // but not one incoming one, unreachable from anywhere despite
            // not being "isolated" by any single-node degree check.
            if !adjacency[j].iter().any(|&(k, _)| k == i) {
                adjacency[j].push((i, cost));
            }
            true
        };

        // The near tier gets first crack at the budget, but NOT all of
        // it — a fixed reserve is set aside for the far tier so a dense
        // local cluster (where the near tier alone would happily fill
        // every slot) can't crowd the bridging candidates out before
        // they're even tried. See [`FAR_CANDIDATE_COUNT`]'s own docs.
        let far_reserve = FAR_CANDIDATE_COUNT.min(MAX_OUT_DEGREE / 2);
        let near_budget = MAX_OUT_DEGREE.saturating_sub(far_reserve);
        for &(j, _) in &near {
            if adjacency[i].len() >= near_budget {
                break;
            }
            try_add(&mut adjacency, j);
        }
        for &(j, _) in &far {
            if adjacency[i].len() >= MAX_OUT_DEGREE {
                break;
            }
            try_add(&mut adjacency, j);
        }
    }
    adjacency
}

#[cfg(test)]
mod tests {
    use super::super::to_lonlat;
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::coverage::signed_area2_world;

    const LAT: f64 = 55.0;
    const LON: f64 = 10.0;

    /// A square hazard ring, `half_side_m` from centre to edge, wound
    /// positive — mirrors `raster::tests::square` (duplicated, not
    /// shared: same reasoning as every other per-module test helper in
    /// this crate).
    fn square(lat: f64, lon: f64, half_side_m: f64) -> Vec<WorldXy> {
        let dlat = half_side_m / 111_320.0;
        let dlon = half_side_m / (111_320.0 * lat.to_radians().cos());
        let mut ring = vec![
            lat_lon_to_world(lat - dlat, lon - dlon),
            lat_lon_to_world(lat - dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon - dlon),
        ];
        if signed_area2_world(&ring) < 0 {
            ring.reverse();
        }
        ring
    }

    #[test]
    fn open_water_finds_the_exact_endpoints() {
        let a = lat_lon_to_world(LAT, LON);
        let b = lat_lon_to_world(LAT + 0.02, LON + 0.02);
        let route = graph_route(a, b, &[], &[], &[], &[], 0.0).expect("nothing in the way");
        assert!(route.waypoints.len() >= 2);
        assert_eq!(route.waypoints[0], to_lonlat(a));
        assert_eq!(*route.waypoints.last().unwrap(), to_lonlat(b));
        assert!(route.distance_m > 0.0);
    }

    #[test]
    fn a_square_obstacle_forces_a_real_detour() {
        let obstacle = square(LAT, LON, 300.0);
        let a = lat_lon_to_world(LAT, LON - 0.02);
        let b = lat_lon_to_world(LAT, LON + 0.02);
        let hazards = vec![obstacle];
        let route = graph_route(a, b, &hazards, &[], &[], &[], 0.0).expect("a way around exists");
        assert!(
            route.waypoints.len() > 2,
            "must bend around the square: {route:?}"
        );
        let bboxes: Vec<RingBox> = hazards.iter().map(|r| RingBox::of(r)).collect();
        for w in route.waypoints.windows(2) {
            let p0 = lat_lon_to_world(w[0].1, w[0].0);
            let p1 = lat_lon_to_world(w[1].1, w[1].0);
            assert!(
                visible(p0, p1, &hazards, &bboxes),
                "leg crosses the obstacle: {w:?}"
            );
        }
    }

    #[test]
    fn both_endpoints_must_already_be_safe() {
        let hazard = square(LAT, LON, 500.0);
        let inside = lat_lon_to_world(LAT, LON);
        let outside = lat_lon_to_world(LAT, LON - 0.05);
        let hazards = vec![hazard];
        assert!(graph_route(inside, outside, &hazards, &[], &[], &[], 0.0).is_none());
        assert!(graph_route(outside, inside, &hazards, &[], &[], &[], 0.0).is_none());
    }

    #[test]
    fn no_path_within_the_node_budget_is_an_honest_none_not_a_panic() {
        // A fully enclosing ring around `b` — mirrors raster.rs's own
        // `no_path_exists_through_a_fully_enclosing_ring`, but this
        // module has no partial-route fallback (see its own docs): both
        // endpoints are technically "safe" (outside the ring itself is
        // safe, and this test puts `b` OUTSIDE too, immediately next to
        // a wall with no gap) — genuinely no path exists at all.
        let wall = square(LAT, LON, 50_000.0); // a huge solid square, no gap
        let a = lat_lon_to_world(LAT, LON - 1.0);
        let b = lat_lon_to_world(LAT, LON); // deep inside — actually unsafe
        let hazards = vec![wall];
        assert!(graph_route(a, b, &hazards, &[], &[], &[], 0.0).is_none());
    }

    #[test]
    fn too_narrow_for_the_requested_beam_forces_a_different_path() {
        // Two obstacles with a real but narrow gap between them (~40m) —
        // passable at a small beam requirement, not at a large one.
        let left = square(LAT, LON - 0.0003, 100.0);
        let right = square(LAT, LON + 0.0003, 100.0);
        let a = lat_lon_to_world(LAT + 0.01, LON);
        let b = lat_lon_to_world(LAT - 0.01, LON);
        let hazards = vec![left, right];

        let narrow_beam = graph_route(a, b, &hazards, &[], &[], &[], 2.0);
        let wide_beam = graph_route(a, b, &hazards, &[], &[], &[], 500.0);
        assert!(
            narrow_beam.is_some(),
            "a small vessel should fit the real gap"
        );
        // A beam wider than the whole scenario must not thread the same
        // gap — either no route at all, or a measurably longer one that
        // goes around both obstacles instead of between them.
        if let (Some(n), Some(w)) = (&narrow_beam, &wide_beam) {
            assert!(
                w.distance_m > n.distance_m,
                "a boat too wide for the gap must not take the same short path: narrow={n:?} wide={w:?}"
            );
        }
    }

    #[test]
    fn a_fairway_edge_costs_less_than_the_same_edge_without_one() {
        let a = lat_lon_to_world(LAT, LON);
        let b = lat_lon_to_world(LAT, LON + 0.01);
        let nodes = vec![a, b];
        let clearance = |_: WorldXy| f64::INFINITY;

        let plain = build_adjacency(
            &nodes,
            &[],
            &[],
            &[],
            &[],
            &[],
            &clearance,
            usize::MAX,
            0.0,
            usize::MAX,
            0.0,
            0.0,
            1.0,
        );
        let fairway_rings = vec![square(LAT, LON + 0.005, 2_000.0)]; // covers the edge's own midpoint
        let with_fairway = build_adjacency(
            &nodes,
            &[],
            &[],
            &fairway_rings,
            &[],
            &[],
            &clearance,
            usize::MAX,
            0.0,
            usize::MAX,
            0.0,
            0.0,
            1.0,
        );

        let plain_cost = plain[0].iter().find(|&&(j, _)| j == 1).unwrap().1;
        let fairway_cost = with_fairway[0].iter().find(|&&(j, _)| j == 1).unwrap().1;
        assert!(
            fairway_cost < plain_cost,
            "fairway={fairway_cost} plain={plain_cost}"
        );
    }

    #[test]
    fn a_buoyage_wrong_side_edge_costs_more_than_the_same_edge_without_one() {
        let a = lat_lon_to_world(LAT, LON);
        let b = lat_lon_to_world(LAT, LON + 0.01);
        let nodes = vec![a, b];
        let clearance = |_: WorldXy| f64::INFINITY;

        let plain = build_adjacency(
            &nodes,
            &[],
            &[],
            &[],
            &[],
            &[],
            &clearance,
            usize::MAX,
            0.0,
            usize::MAX,
            0.0,
            0.0,
            1.0,
        );
        let buoyage_rings = vec![square(LAT, LON + 0.005, 2_000.0)];
        let with_penalty = build_adjacency(
            &nodes,
            &[],
            &[],
            &[],
            &[],
            &buoyage_rings,
            &clearance,
            usize::MAX,
            0.0,
            usize::MAX,
            0.0,
            0.0,
            1.0,
        );

        let plain_cost = plain[0].iter().find(|&&(j, _)| j == 1).unwrap().1;
        let penalized_cost = with_penalty[0].iter().find(|&&(j, _)| j == 1).unwrap().1;
        assert!(
            penalized_cost > plain_cost,
            "penalized={penalized_cost} plain={plain_cost}"
        );
    }
}
