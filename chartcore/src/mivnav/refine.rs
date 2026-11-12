// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §12.4 — local vector refinement for the passages the grid layer
//! cannot represent faithfully.
//!
//! # Why this exists
//!
//! Everything upstream of this module reasons on a grid: [`super::field`]
//! rasterizes the region onto a per-tile lattice, [`super::topology`]
//! labels navigable components cell by cell, [`super::portals`] measures a
//! crossing's width off that same raster. A grid is exact only down to its
//! own cell size, and §4.4/§24 both name the failure it produces: "a
//! conservative rasterisation closes channels". A channel that runs
//! DIAGONALLY across the lattice, or that is only one to two cells wide at
//! the band's chosen resolution, can read as blocked — or as a portal too
//! narrow for the vessel's beam — when the real charted geometry leaves a
//! perfectly usable gap.
//!
//! §8.3's rule for that case is **demote, never reject**: a marginal-width
//! portal ([`super::portals::Portal::min_horizontal_width_dm`] below a
//! beam threshold) stays a usable edge in the topology graph, and the
//! query records it (see [`super::query::TopologyRoute::demoted_portals`])
//! so this module gets a chance to route the crossing exactly, against the
//! chart's own hazard rings rather than their rasterization. If this
//! module then finds no clear local path, the caller keeps whatever the
//! grid layers produced — refinement can only ever *improve* a route or
//! decline, it can never make one worse or invent connectivity the exact
//! verifier (§16) would reject.
//!
//! # What it does
//!
//! [`refine_segment`] is a classic visibility-graph solve, scoped to one
//! straight sub-segment of a dense route:
//!
//! 1. Take the hazard rings whose bounding box is within a window of the
//!    `entry`→`exit` segment (the caller passes the full set;
//!    [`window_rings`] does the clip).
//! 2. Graph vertices are `entry`, `exit`, and every hazard-ring CORNER in
//!    that window that is not itself buried inside another hazard.
//!    Corners are exactly what
//!    [`crate::routing::visibility::visible`]/[`segments_cross`] were
//!    built to consume — see that module's own docs ("every candidate
//!    edge here legitimately shares an endpoint with the segment being
//!    tested whenever that endpoint IS a hazard vertex").
//! 3. An edge exists between two vertices iff the straight chord between
//!    them is `visible`-clear of every ring interior (the "supercover-
//!    clear" test §12.4 names — `visible` is the exact segment-vs-ring
//!    primitive, strictly better than a sampled supercover walk).
//! 4. Edge cost is real-metre length, scaled by an optional per-point
//!    cost multiplier (`cost_at`) so a caller can integrate the same
//!    soft-cost field the fine search uses (survey quality, fairway
//!    preference, TSS avoidance). The default multiplier is `1.0`
//!    everywhere — pure shortest geometric path.
//! 5. Dijkstra from `entry` to `exit`, deterministic `(cost, vertex
//!    index)` ordering. The reconstructed polyline is `visible`-clear on
//!    every consecutive pair by construction.
//!
//! [`splice`] puts the result back into the dense route.
//!
//! # Bounds and the conservative direction
//!
//! * The vertex count is capped ([`RefineParams::max_nodes`]). When the
//!   window's own corner set alone would exceed it, [`refine_segment`]
//!   returns `None` (decline) rather than solving a truncated graph —
//!   §8.3's "never worse" again.
//! * The visibility pass is `O(n²)` in the vertex count, each check
//!   `O(rings × edges)` with a bounding-box prefilter. `max_nodes` and
//!   the window clip are what keep that bounded; this path runs only for
//!   a demoted portal or a `VECTOR_REQUIRED` tile, never on an ordinary
//!   request.
//! * A returned path is guaranteed clear of every ring *this module was
//!   given*. It is NOT a substitute for §16's exact verification over
//!   decoded cells — the caller still owes that, exactly as it does for
//!   the fine search's own output.
//!
//! # Where the rings come from
//!
//! The plan's open storage question — re-derive hazard geometry from
//! decoded cells per query, or pre-store it — is resolved in favour of
//! **pre-storing** clipped rings per region at import time
//! ([`super::persist::load_hazard_rings`], [`super::format::SectionKind::
//! HazardRings`]): the query path then never has to hold decoded cells
//! resident just to refine a crossing. An artifact built before that
//! section existed simply carries no rings, and a caller re-derives them
//! from `routing::artifact::constraints::build` the same way the fine
//! search already does — so the pre-store is a resident-set optimisation,
//! not a correctness dependency.
//!
//! # SAFETY: the pre-stored rings are HARD hazards only — depth-blind
//!
//! [`super::persist::region_hazard_rings`] / the `HazardRings` section
//! hold `ArtifactConstraints::hard`, built at `required_depth_m = 0.0`
//! (§6 forbids the build from knowing a vessel's draft). They contain
//! land, breakwaters, foul ground, wrecks — **not** a shoal that is a
//! "wall" for a deep-draft vessel but open water for a shallow one. So
//! `refine_segment`, given only those rings, can return a polyline that
//! is genuinely clear of every HARD hazard yet runs through water too
//! shallow for the vessel — precisely the "shoal-narrowed portal" case
//! that gets demoted in the first place.
//!
//! Therefore a production caller that splices a refined leg **MUST**
//! either (a) hand `refine_segment` the band's non-navigable geometry
//! alongside the hard rings, or (b) re-run the fine search's own
//! draft-aware clearance / §16 leg verification
//! (`routing::raster::verify_route_legs`) over the spliced result and
//! keep the splice only if it passes.
//!
//! [`refine_demoted_route`] is that production caller, and it takes
//! route (b): every surviving splice's replacement legs are re-checked
//! with `routing::raster::verify_route_legs` against the request's
//! draft-aware hard-constraint union before the splice is kept. The
//! depth-blind `refine_rings` and the draft-aware `verify_rings` are
//! two different sets, passed separately — see that function's docs.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::coords::{worldx_to_lon, worldy_to_lat, WorldXy};
use crate::routing::hazards::{radius_world_units, rings_contain, world_distance_m};
use crate::routing::visibility::{visible, RingBox};

use super::build::BuiltRegion;
use super::portals::{portal_crossing_point, Portal};

/// Knobs for one [`refine_segment`] solve.
#[derive(Debug, Clone, Copy)]
pub struct RefineParams {
    /// Hard cap on total graph vertices (window corners kept, plus the
    /// two endpoints). When the window's corner set alone would exceed
    /// this, [`refine_segment`] declines (`None`) — it never solves a
    /// truncated graph, because a path missed that way would look exactly
    /// like "no clear route" and could lose a real passage.
    pub max_nodes: usize,
    /// How far past the straight `entry`→`exit` segment's own bounding
    /// box a hazard ring may sit and still be considered, in real metres.
    /// A ring entirely outside this window cannot pinch the local
    /// passage, and dropping it keeps the visibility pass bounded.
    pub window_pad_m: f64,
}

impl RefineParams {
    /// A window wide enough for a harbour-entrance detour, and a vertex
    /// cap that keeps the `O(n²)` visibility pass on a Pi's budget while
    /// still admitting every corner of a realistically intricate mole
    /// field. Measured on the real DE6OSTIM harbour: ~290 hazard-ring
    /// corners fall in a 400 m window around a mole-blocked crossing, so
    /// the cap is set well above that — a genuinely larger charted
    /// obstruction field still declines (`None`), which keeps the
    /// caller's route unchanged rather than solving a truncated graph.
    pub const DEFAULT: RefineParams = RefineParams {
        max_nodes: 1024,
        window_pad_m: 400.0,
    };
}

impl Default for RefineParams {
    fn default() -> RefineParams {
        RefineParams::DEFAULT
    }
}

/// Refine one straight sub-segment `entry`→`exit` of a dense route
/// against the exact hazard geometry in `hazard_rings` (signed ring set,
/// the [`crate::routing::artifact::constraints::ArtifactConstraints`]
/// convention: positive-area ring adds, negative-area ring subtracts,
/// nonzero winding decides — [`visible`] already reads it that way).
///
/// `cost_at` returns a per-point cost multiplier (`>= 0`); an edge's cost
/// is its real-metre length times the mean of its two endpoints'
/// multipliers. Pass [`unit_cost`] for a pure shortest-geometric-path
/// solve.
///
/// The returned polyline is clear of every ring **in `hazard_rings`** and
/// nothing more — see the module docs' SAFETY section: the pre-stored
/// hazard set is HARD hazards only, so a caller splicing this over a
/// draft-constrained route still owes a draft-aware / §16 re-check.
///
/// Returns a polyline that starts at `entry`, ends at `exit`, and is
/// `visible`-clear on every consecutive pair. Returns `None` — meaning
/// "keep your input unchanged" — when:
///
/// * `entry` or `exit` is itself inside a hazard ring (nothing to route
///   between);
/// * the window's hazard-corner set would exceed [`RefineParams::
///   max_nodes`] (declined rather than truncated);
/// * no visibility-graph path connects `entry` to `exit`.
///
/// When the straight `entry`→`exit` chord is already clear, the returned
/// polyline is exactly `[entry, exit]` — the shortest possible answer,
/// and the caller's splice becomes a no-op.
pub fn refine_segment(
    entry: WorldXy,
    exit: WorldXy,
    hazard_rings: &[Vec<WorldXy>],
    cost_at: &dyn Fn(WorldXy) -> f64,
    params: RefineParams,
) -> Option<Vec<WorldXy>> {
    if rings_contain(hazard_rings, entry) || rings_contain(hazard_rings, exit) {
        return None;
    }

    let win = WindowBox::around(entry, exit, params.window_pad_m);
    // Whole rings whose bbox meets the window are kept (`window_rings`),
    // so `visible`'s edge-crossing test always sees a COMPLETE ring — a
    // clipped one could open or close a gap that is not there.
    let rings = window_rings(entry, exit, hazard_rings, params.window_pad_m);
    let bboxes: Vec<RingBox> = rings.iter().map(|r| RingBox::of(r)).collect();

    // Straight line already clear: that IS the optimal refinement.
    if visible(entry, exit, &rings, &bboxes) {
        return Some(vec![entry, exit]);
    }

    // Vertices: the two endpoints, then every ring corner that (a) falls
    // INSIDE the window — a corner far outside it can only ever add a
    // pointless long detour, never open a local passage — and (b) is not
    // buried inside some OTHER hazard (its own ring's boundary never
    // counts as "inside": `rings_contain` resolves an exactly-on-a-
    // boundary point to "clear", see its docs).
    let mut nodes: Vec<WorldXy> = Vec::with_capacity(params.max_nodes.min(1024));
    nodes.push(entry);
    nodes.push(exit);
    for ring in &rings {
        for &v in ring {
            if !win.contains(v) {
                continue;
            }
            if nodes.len() >= params.max_nodes {
                // The in-window corner set outgrew the budget — decline
                // rather than solve over an arbitrary truncation of it.
                return None;
            }
            if !rings_contain(&rings, v) {
                nodes.push(v);
            }
        }
    }

    // The per-node cost multiplier, sampled ONCE per node (not once per
    // edge): with a real soft-cost sampler `cost_at` is a spatial-field
    // lookup, and the adjacency pass below is `O(n²)`.
    let mult: Vec<f64> = nodes.iter().map(|&p| cost_at(p).max(0.0)).collect();

    // Adjacency: every visible pair, real-metre length times the mean of
    // the endpoints' cost multipliers. `O(n²)` visibility checks, each
    // bounding-box-prefiltered inside `visible`.
    let n = nodes.len();
    let mut adj: Vec<Vec<(usize, i64)>> = vec![Vec::new(); n];
    for i in 0..n {
        for j in (i + 1)..n {
            if !visible(nodes[i], nodes[j], &rings, &bboxes) {
                continue;
            }
            let len_m = world_distance_m(nodes[i], nodes[j]);
            let cost = edge_cost_mm(len_m, mult[i], mult[j]);
            adj[i].push((j, cost));
            adj[j].push((i, cost));
        }
    }

    let path = dijkstra(&adj, 0, 1)?;
    Some(path.into_iter().map(|i| nodes[i]).collect())
}

/// The identity cost multiplier — pass this to [`refine_segment`] for a
/// pure shortest-geometric-path solve.
pub fn unit_cost(_p: WorldXy) -> f64 {
    1.0
}

/// Is the straight chord `a`→`b` clear of every hazard ring's interior?
/// A thin wrapper over [`crate::routing::visibility::visible`] (which is
/// `pub(crate)`), exposed so a caller that has just spliced a refined
/// leg into a route can re-check it, and so the refinement's own output
/// can be verified leg by leg from outside the crate.
pub fn segment_clear(a: WorldXy, b: WorldXy, hazard_rings: &[Vec<WorldXy>]) -> bool {
    let bboxes: Vec<RingBox> = hazard_rings.iter().map(|r| RingBox::of(r)).collect();
    visible(a, b, hazard_rings, &bboxes)
}

/// Millimetre fixed-point edge cost: real-metre `len_m`, scaled by the
/// mean of the two endpoint multipliers, saturating rather than
/// wrapping on an absurd input.
fn edge_cost_mm(len_m: f64, mi: f64, mj: f64) -> i64 {
    let mult = 0.5 * (mi + mj);
    let mm = len_m * 1000.0 * mult;
    if !mm.is_finite() {
        return i64::MAX;
    }
    mm.round().clamp(0.0, i64::MAX as f64) as i64
}

/// The straight `entry`→`exit` segment's own bounding box, grown by a
/// real-metre pad — the region [`refine_segment`] draws graph vertices
/// from.
#[derive(Debug, Clone, Copy)]
struct WindowBox {
    xmin: i64,
    xmax: i64,
    ymin: i64,
    ymax: i64,
}

impl WindowBox {
    fn around(entry: WorldXy, exit: WorldXy, pad_m: f64) -> WindowBox {
        let mid = WorldXy::new(
            ((entry.x as i64 + exit.x as i64) / 2) as i32,
            ((entry.y as i64 + exit.y as i64) / 2) as i32,
        );
        let pad = if pad_m.is_finite() && pad_m > 0.0 {
            radius_world_units(mid, pad_m).round() as i64
        } else {
            0
        };
        WindowBox {
            xmin: entry.x.min(exit.x) as i64 - pad,
            xmax: entry.x.max(exit.x) as i64 + pad,
            ymin: entry.y.min(exit.y) as i64 - pad,
            ymax: entry.y.max(exit.y) as i64 + pad,
        }
    }

    fn contains(&self, p: WorldXy) -> bool {
        let (x, y) = (p.x as i64, p.y as i64);
        x >= self.xmin && x <= self.xmax && y >= self.ymin && y <= self.ymax
    }

    /// Does `ring`'s own bounding box overlap this window at all? Kept
    /// generous (whole-ring, not clipped) so `visible`'s edge-crossing
    /// test always sees a complete ring.
    fn meets_ring(&self, ring: &[WorldXy]) -> bool {
        let clamp = |v: i64| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
        RingBox::of(ring).overlaps(
            clamp(self.xmin),
            clamp(self.xmax),
            clamp(self.ymin),
            clamp(self.ymax),
        )
    }
}

/// Every ring in `all` whose bounding box overlaps the straight
/// `entry`→`exit` segment's box grown by `pad_m` real metres — the set
/// [`refine_segment`] would consider. Exposed for a caller that refines
/// several segments against one large ring set and wants to clip once.
///
/// Rings are cloned so the caller can hand in a set it owns transiently;
/// the clone is bounded by the window, off the ordinary request path.
pub fn window_rings(
    entry: WorldXy,
    exit: WorldXy,
    all: &[Vec<WorldXy>],
    pad_m: f64,
) -> Vec<Vec<WorldXy>> {
    let win = WindowBox::around(entry, exit, pad_m);
    all.iter().filter(|r| win.meets_ring(r)).cloned().collect()
}

/// Plain Dijkstra over `adj` (index → `[(neighbour, cost_mm)]`), from
/// `start` to `goal`. Deterministic: the open set is ordered by
/// `(cost, vertex index)`, and a vertex is only ever relaxed on a
/// STRICTLY smaller cost, so which of two equal-cost paths wins is fixed
/// by `adj`'s own (build-order-deterministic) iteration, never by heap
/// tie-breaking. `None` when `goal` is unreachable.
fn dijkstra(adj: &[Vec<(usize, i64)>], start: usize, goal: usize) -> Option<Vec<usize>> {
    let n = adj.len();
    let mut dist = vec![i64::MAX; n];
    let mut prev = vec![usize::MAX; n];
    let mut heap: BinaryHeap<Reverse<(i64, usize)>> = BinaryHeap::new();
    dist[start] = 0;
    heap.push(Reverse((0, start)));
    while let Some(Reverse((d, u))) = heap.pop() {
        if d != dist[u] {
            continue; // stale
        }
        if u == goal {
            break;
        }
        for &(v, w) in &adj[u] {
            let nd = d.saturating_add(w);
            if nd < dist[v] {
                dist[v] = nd;
                prev[v] = u;
                heap.push(Reverse((nd, v)));
            }
        }
    }
    if dist[goal] == i64::MAX {
        return None;
    }
    let mut path = vec![goal];
    let mut at = goal;
    // Bounded by `n`: `prev` forms a tree rooted at `start` (only set on a
    // strict improvement), so this cannot cycle on well-formed input.
    for _ in 0..n {
        if at == start {
            break;
        }
        at = prev[at];
        if at == usize::MAX {
            return None; // defensive: broken predecessor chain
        }
        path.push(at);
    }
    if *path.last()? != start {
        return None;
    }
    path.reverse();
    Some(path)
}

/// Replace `dense[i..=j]` with `replacement`, which must start at
/// `dense[i]` and end at `dense[j]`. Returns the spliced route.
///
/// A `replacement` that does not match its endpoints, or indices out of
/// range / out of order, leave `dense` returned unchanged — a splice is
/// an optimisation, and a malformed one is declined, not forced.
pub fn splice(dense: &[WorldXy], i: usize, j: usize, replacement: &[WorldXy]) -> Vec<WorldXy> {
    if i >= j || j >= dense.len() || replacement.len() < 2 {
        return dense.to_vec();
    }
    if replacement.first() != Some(&dense[i]) || replacement.last() != Some(&dense[j]) {
        return dense.to_vec();
    }
    let mut out = Vec::with_capacity(dense.len() + replacement.len());
    out.extend_from_slice(&dense[..i]);
    out.extend_from_slice(replacement);
    out.extend_from_slice(&dense[j + 1..]);
    out
}

/// Sum of [`world_distance_m`] along consecutive `points`.
fn polyline_len_m(points: &[WorldXy]) -> f64 {
    points
        .windows(2)
        .map(|w| world_distance_m(w[0], w[1]))
        .sum()
}

/// Real-metre distance from `p` to the segment `a`→`b`. The projection
/// parameter is computed in raw world units — good enough to PICK the
/// nearest leg, the modest x/y anisotropy at these latitudes cannot flip
/// which leg wins — and the returned gap is measured with the
/// crate-standard [`world_distance_m`] at the clamped foot of the
/// perpendicular.
fn point_to_segment_m(p: WorldXy, a: WorldXy, b: WorldXy) -> f64 {
    let (ax, ay) = (f64::from(a.x), f64::from(a.y));
    let (bx, by) = (f64::from(b.x), f64::from(b.y));
    let (px, py) = (f64::from(p.x), f64::from(p.y));
    let (dx, dy) = (bx - ax, by - ay);
    let seg2 = dx * dx + dy * dy;
    let t = if seg2 > 0.0 {
        (((px - ax) * dx + (py - ay) * dy) / seg2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let clamp = |v: f64| v.round().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32;
    let foot = WorldXy::new(clamp(ax + t * dx), clamp(ay + t * dy));
    world_distance_m(p, foot)
}

/// One demoted crossing: bracket `work` around `crossing`, refine that
/// stretch against `refine_rings`, and keep the splice only if it (a) is
/// no longer than the sub-path it replaces and (b) survives a re-check of
/// its replacement legs against `verify_rings` — the draft-aware blocking
/// union (at least `ArtifactConstraints::hard`, plus whatever
/// same-polarity sets the caller folds in), which `refine_rings` (HARD
/// hazards at `required_depth_m = 0.0`, module docs' SAFETY section) does
/// NOT include.
///
/// Returns the spliced route, or `None` to keep `work` unchanged: fewer
/// than two waypoints, a degenerate bracket, [`refine_segment`] declined
/// or returned only the straight `[entry, exit]` chord, the detour came
/// out longer, or the draft-aware re-check flagged a replacement leg.
fn refine_one_crossing(
    work: &[WorldXy],
    crossing: WorldXy,
    refine_rings: &[Vec<WorldXy>],
    verify_rings: &[Vec<WorldXy>],
    cost_at: &dyn Fn(WorldXy) -> f64,
    params: RefineParams,
) -> Option<Vec<WorldXy>> {
    if work.len() < 2 {
        return None;
    }
    // Anchor on the LEG that passes closest to the crossing, not the two
    // globally-nearest route VERTICES: where the fine route doubles back
    // near the crossing (a hairpin around a mole) the nearest pair of
    // vertices can lie on different passes, so the pair need neither be
    // adjacent nor bracket the leg that actually crosses the demoted
    // portal. Point-to-segment picks the real crossing leg. `total_cmp`
    // keeps the choice deterministic (our distances are finite).
    let seg = (0..work.len() - 1).min_by(|&a, &b| {
        point_to_segment_m(crossing, work[a], work[a + 1]).total_cmp(&point_to_segment_m(
            crossing,
            work[b],
            work[b + 1],
        ))
    })?;
    // One waypoint of margin beyond each end of that leg, so the
    // visibility solver has room to re-shape the approach — and, where
    // the fine route's grid answer zig-zags here, to replace the whole
    // wasteful bend rather than a single straight leg it could only ever
    // lengthen (the length gate below rejects anything that does not come
    // out shorter).
    let i = seg.saturating_sub(1);
    let j = (seg + 2).min(work.len() - 1);
    if i >= j {
        return None;
    }

    let replacement = refine_segment(work[i], work[j], refine_rings, cost_at, params)?;
    // `refine_segment` returns exactly `[entry, exit]` when the straight
    // chord is already clear — nothing to splice.
    if replacement.len() < 3 {
        return None;
    }
    // Never lengthen the route: the stretch being replaced is the grid
    // fine search's own hazard-avoiding answer here, and §8.3 is explicit
    // that refinement may only improve a route or decline. The 1 mm slack
    // absorbs float noise between two distance sums of the same span.
    if polyline_len_m(&replacement) > polyline_len_m(&work[i..=j]) + 1.0e-3 {
        return None;
    }
    // The load-bearing re-check. `refine_rings` is depth-blind, so a
    // detour it calls clear can still cross water too shallow for the
    // vessel — exactly the "shoal-narrowed portal" that got demoted.
    // `verify_rings` is the request's draft-aware hard union, the same
    // set `routing::raster::verify_route_legs` checks the fine search's
    // own legs against (`routing::artifact::route_with_constraints`). A
    // straightened-aground splice is rejected here and `work` is kept.
    let repl_lonlat: Vec<(f64, f64)> = replacement
        .iter()
        .map(|&p| (worldx_to_lon(p.x), worldy_to_lat(p.y)))
        .collect();
    if crate::routing::raster::verify_route_legs(&repl_lonlat, verify_rings)
        .iter()
        .any(|&crosses| crosses)
    {
        return None;
    }

    let spliced = splice(work, i, j, &replacement);
    if spliced.as_slice() == work {
        None
    } else {
        Some(spliced)
    }
}

/// The fine route with every KEPT Phase-6 refinement splice applied, in
/// world coordinates — what a production caller gets from consuming
/// [`super::query::TopologyRoute::demoted_portals`].
#[derive(Debug, Clone, PartialEq)]
pub struct RefinedRoute {
    /// The fine search's waypoints with each surviving splice applied,
    /// start to end.
    pub waypoints: Vec<WorldXy>,
    /// Ground metres along [`Self::waypoints`], summed with the crate's
    /// standard [`world_distance_m`] (the fine search's own
    /// `search::path_distance_m` is module-private; the two agree to
    /// within great-circle-vs-projection rounding).
    pub distance_m: f64,
    /// Ids of the demoted portals whose splice was actually kept — a
    /// subset of the `demoted` input. Never empty: an all-declined pass
    /// returns `None` from [`refine_demoted_route`], not a `RefinedRoute`.
    pub refined_portals: Vec<u32>,
}

/// For each portal id in `demoted` (the marginal-width portals §8.3
/// demoted onto a [`super::query::TopologyRoute`]), bracket
/// `fine_waypoints` around that crossing (via
/// [`super::portals::portal_crossing_point`]) and try to replace the
/// bracketed stretch with a [`refine_segment`] solve against
/// `refine_rings`. A splice is kept only when it is no longer than the
/// sub-path it replaces AND its replacement legs re-verify clear of
/// `verify_rings` — see [`refine_one_crossing`] and this module's SAFETY
/// section for why the second gate is not optional.
///
/// `refine_rings` is the depth-blind HARD hazard set (pre-stored
/// [`super::persist::RegionArtifact::hazard_rings`], or re-derived from
/// `routing::artifact::constraints::build`); `verify_rings` is the
/// draft-aware set a replacement leg must test CLEAR of before its splice
/// is kept — at minimum the request's hard-constraint union
/// (`routing::artifact::ArtifactConstraints::hard`), and a caller may
/// fold in further same-polarity blocking sets it wants the refinement to
/// respect that the `unit_cost` geometry solve is blind to (UNSARE,
/// area-to-be-avoided, weighted TSS / caution / cable zones). The two
/// arguments are DIFFERENT sets on purpose — `refine_rings` shapes the
/// solve, `verify_rings` vetoes its result.
///
/// Returns `None` — "keep the fine route exactly as it is" — when no
/// splice survives, so a caller can treat `Some` as "the route genuinely
/// changed" without re-comparing.
#[allow(clippy::too_many_arguments)]
pub fn refine_demoted_route(
    fine_waypoints: &[WorldXy],
    built: &BuiltRegion,
    portals: &[Portal],
    demoted: &[u32],
    refine_rings: &[Vec<WorldXy>],
    verify_rings: &[Vec<WorldXy>],
    cost_at: &dyn Fn(WorldXy) -> f64,
    params: RefineParams,
) -> Option<RefinedRoute> {
    let mut work = fine_waypoints.to_vec();
    let mut refined_portals = Vec::new();
    for &pid in demoted {
        let Some(portal) = portals.iter().find(|p| p.id == pid) else {
            continue;
        };
        let Some(crossing) = portal_crossing_point(built, portal) else {
            continue;
        };
        if let Some(next) =
            refine_one_crossing(&work, crossing, refine_rings, verify_rings, cost_at, params)
        {
            work = next;
            refined_portals.push(pid);
        }
    }
    if refined_portals.is_empty() {
        return None;
    }
    let distance_m = polyline_len_m(&work);
    Some(RefinedRoute {
        waypoints: work,
        distance_m,
        refined_portals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ring set with ONE feature: a wall running diagonally across the
    /// lattice, with a gap in the middle — the canonical "non-grid-
    /// aligned passage a conservative rasterisation would close". Built
    /// as two disjoint rectangles (the two halves of the wall) so the
    /// gap between them is real open water.
    fn diagonal_wall_with_gap() -> Vec<Vec<WorldXy>> {
        // World units. A rectangle from (x0,y0) to (x1,y1) as a CCW ring.
        fn rect(x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<WorldXy> {
            vec![
                WorldXy::new(x0, y0),
                WorldXy::new(x1, y0),
                WorldXy::new(x1, y1),
                WorldXy::new(x0, y1),
            ]
        }
        // Lower-left half of the wall and upper-right half, offset so the
        // wall runs corner-to-corner and the ~200-unit gap sits off both
        // lattice axes.
        vec![rect(0, 0, 1200, 400), rect(1400, 600, 2600, 1000)]
    }

    #[test]
    fn straight_line_through_a_clear_window_is_returned_untouched() {
        let rings = diagonal_wall_with_gap();
        // Both points well clear of either wall segment, chord misses both.
        let entry = WorldXy::new(-500, 2000);
        let exit = WorldXy::new(3200, 2000);
        let got = refine_segment(entry, exit, &rings, &unit_cost, RefineParams::DEFAULT)
            .expect("a clear straight line must refine to itself");
        assert_eq!(got, vec![entry, exit]);
    }

    #[test]
    fn a_blocked_diagonal_passage_is_routed_through_the_real_gap() {
        let rings = diagonal_wall_with_gap();
        // `entry` below the wall, `exit` above it: the straight chord
        // slices clean through the lower rectangle, so the grid layer
        // (which sees only rasterized cells) would call this closed.
        let entry = WorldXy::new(700, -400);
        let exit = WorldXy::new(1900, 1400);
        let path = refine_segment(entry, exit, &rings, &unit_cost, RefineParams::DEFAULT)
            .expect("the real charted gap between the two wall segments must be found");
        assert_eq!(path.first(), Some(&entry));
        assert_eq!(path.last(), Some(&exit));
        assert!(path.len() > 2, "a detour through the gap needs a waypoint");

        // Every consecutive pair is genuinely clear of the walls.
        let bboxes: Vec<RingBox> = rings.iter().map(|r| RingBox::of(r)).collect();
        for w in path.windows(2) {
            assert!(
                visible(w[0], w[1], &rings, &bboxes),
                "spliced leg {:?}->{:?} crosses a wall",
                w[0],
                w[1]
            );
        }
        // The detour actually goes near the gap (x in [1200, 1400]).
        assert!(
            path.iter().any(|p| (1150..=1450).contains(&p.x)),
            "the route must thread the real gap, not go around the world: {path:?}"
        );
    }

    #[test]
    fn an_endpoint_inside_a_hazard_declines() {
        let rings = diagonal_wall_with_gap();
        let inside = WorldXy::new(600, 200); // squarely inside the lower rectangle
        let outside = WorldXy::new(-500, 2000);
        assert!(
            refine_segment(inside, outside, &rings, &unit_cost, RefineParams::DEFAULT).is_none()
        );
        assert!(
            refine_segment(outside, inside, &rings, &unit_cost, RefineParams::DEFAULT).is_none()
        );
    }

    #[test]
    fn a_fully_walled_off_pair_finds_no_path_and_declines() {
        // A wall whose ENDS are far outside any sane refinement window
        // (~38 km each way), so there is genuinely no way around it
        // locally: no in-window corner, no graph vertex, no path.
        let rings = vec![vec![
            WorldXy::new(-2_000_000, 0),
            WorldXy::new(2_000_000, 0),
            WorldXy::new(2_000_000, 400),
            WorldXy::new(-2_000_000, 400),
        ]];
        let entry = WorldXy::new(0, -400);
        let exit = WorldXy::new(0, 800);
        assert!(refine_segment(entry, exit, &rings, &unit_cost, RefineParams::DEFAULT).is_none());
    }

    #[test]
    fn the_node_budget_is_enforced_by_declining_not_truncating() {
        let rings = diagonal_wall_with_gap();
        let entry = WorldXy::new(700, -400);
        let exit = WorldXy::new(1900, 1400);
        // Two rectangles = 8 corners; a budget of 6 (2 endpoints + 4)
        // cannot hold them all, so the solve must decline.
        let tight = RefineParams {
            max_nodes: 6,
            window_pad_m: 400.0,
        };
        assert!(refine_segment(entry, exit, &rings, &unit_cost, tight).is_none());
    }

    #[test]
    fn cost_multiplier_bends_the_route_away_from_expensive_water() {
        // A corridor with NO hazards at all but a cost ridge down the
        // middle (x near 0 is expensive): the straight line is clear, so
        // with unit cost we get it back untouched...
        let rings: Vec<Vec<WorldXy>> = Vec::new();
        let entry = WorldXy::new(-1000, 0);
        let exit = WorldXy::new(1000, 0);
        let flat = refine_segment(entry, exit, &rings, &unit_cost, RefineParams::DEFAULT).unwrap();
        assert_eq!(flat, vec![entry, exit]);
        // ...and with no hazards there are no graph vertices to bend
        // around, so cost alone cannot reroute here. This documents the
        // boundary: `refine_segment` optimises PATH CHOICE among hazard
        // corners; it is not a free-space cost-field descent. A caller
        // wanting the latter seeds extra vertices via the ring set.
        let ridge = |p: WorldXy| if p.x.abs() < 200 { 10.0 } else { 1.0 };
        let got = refine_segment(entry, exit, &rings, &ridge, RefineParams::DEFAULT).unwrap();
        assert_eq!(got, vec![entry, exit]);
    }

    #[test]
    fn splice_replaces_the_bracketed_run() {
        let dense = vec![
            WorldXy::new(0, 0),
            WorldXy::new(10, 0),
            WorldXy::new(20, 0),
            WorldXy::new(30, 0),
        ];
        let repl = vec![
            WorldXy::new(10, 0),
            WorldXy::new(15, 5),
            WorldXy::new(20, 0),
        ];
        let out = splice(&dense, 1, 2, &repl);
        assert_eq!(
            out,
            vec![
                WorldXy::new(0, 0),
                WorldXy::new(10, 0),
                WorldXy::new(15, 5),
                WorldXy::new(20, 0),
                WorldXy::new(30, 0),
            ]
        );
    }

    #[test]
    fn splice_declines_a_mismatched_replacement() {
        let dense = vec![WorldXy::new(0, 0), WorldXy::new(10, 0), WorldXy::new(20, 0)];
        // endpoints don't match dense[1]/dense[2]
        let bad = vec![WorldXy::new(1, 1), WorldXy::new(20, 0)];
        assert_eq!(splice(&dense, 1, 2, &bad), dense);
        // out-of-order / out-of-range
        assert_eq!(splice(&dense, 2, 1, &dense), dense);
        assert_eq!(splice(&dense, 0, 9, &dense), dense);
    }

    /// A grid route that clears the wall by a needlessly wide bend. The
    /// bracket around the gap, refined, replaces that bend with a tighter
    /// one — shorter, and re-verified clear against the SAME ring set.
    #[test]
    fn refine_one_crossing_tightens_a_wide_grid_bend_and_keeps_the_splice() {
        let rings = diagonal_wall_with_gap();
        // entry below the lower rect, exit above the upper rect; the
        // interior vertices take the long way up the x=1300 gap column.
        let work = vec![
            WorldXy::new(600, -200),
            WorldXy::new(1300, -100),
            WorldXy::new(1300, 1100),
            WorldXy::new(2000, 1200),
        ];
        let crossing = WorldXy::new(1300, 450); // squarely in the gap
        let got = refine_one_crossing(
            &work,
            crossing,
            &rings,
            &rings,
            &unit_cost,
            RefineParams::DEFAULT,
        )
        .expect("a tighter clear bend exists and must be kept");
        assert_eq!(got.first(), work.first());
        assert_eq!(got.last(), work.last());
        assert_ne!(got, work, "the splice must actually change the route");
        // Every leg of the result clears the walls.
        let bboxes: Vec<RingBox> = rings.iter().map(|r| RingBox::of(r)).collect();
        for w in got.windows(2) {
            assert!(
                visible(w[0], w[1], &rings, &bboxes),
                "kept leg crosses a wall"
            );
        }
        assert!(
            polyline_len_m(&got) < polyline_len_m(&work),
            "the kept splice must not lengthen the route"
        );
    }

    /// The load-bearing safety gate: `refine_rings` (depth-blind) leaves
    /// the gap open, but `verify_rings` adds a ring sealing it — a shoal
    /// that is open water to a shallow vessel and a wall to this one. The
    /// splice `refine_segment` proposes through the gap must be REJECTED
    /// and the route left untouched.
    #[test]
    fn refine_one_crossing_rejects_a_splice_that_the_draft_aware_recheck_flags() {
        let refine_rings = diagonal_wall_with_gap();
        // Same walls, plus a block straddling the x=1300 gap corridor.
        let mut verify_rings = diagonal_wall_with_gap();
        verify_rings.push(vec![
            WorldXy::new(1150, 300),
            WorldXy::new(1500, 300),
            WorldXy::new(1500, 700),
            WorldXy::new(1150, 700),
        ]);
        let work = vec![
            WorldXy::new(600, -200),
            WorldXy::new(1300, -100),
            WorldXy::new(1300, 1100),
            WorldXy::new(2000, 1200),
        ];
        let crossing = WorldXy::new(1300, 450);
        assert!(
            refine_one_crossing(
                &work,
                crossing,
                &refine_rings,
                &verify_rings,
                &unit_cost,
                RefineParams::DEFAULT,
            )
            .is_none(),
            "a splice through a charted shoal must be rejected by the draft-aware re-check"
        );
    }

    /// Finding: the bracket must follow the LEG nearest the crossing, not
    /// the two nearest route VERTICES. Here the fine route passes the
    /// crossing twice — a clear pass whose vertices sit ~45 units away,
    /// and a wasteful zig-zag pass whose crossing leg runs right through
    /// it. Anchoring on the nearest vertices brackets the clear pass
    /// (already straight → nothing to do) and the real marginal-width
    /// crossing is never refined; anchoring on the nearest leg brackets
    /// the zig-zag and straightens it.
    #[test]
    fn refine_one_crossing_anchors_on_the_crossing_leg_not_the_nearest_vertices() {
        fn rect(x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<WorldXy> {
            vec![
                WorldXy::new(x0, y0),
                WorldXy::new(x1, y0),
                WorldXy::new(x1, y1),
                WorldXy::new(x0, y1),
            ]
        }
        // Two thin bars with a gap at x in (1250, 1350).
        let bars = vec![rect(600, 480, 1250, 520), rect(1350, 480, 2000, 520)];
        let crossing = WorldXy::new(1300, 500); // in the gap

        let work = vec![
            WorldXy::new(0, 400),     // 0
            WorldXy::new(1280, 460),  // 1  clear pass, ~45 from crossing
            WorldXy::new(1320, 460),  // 2  clear pass, ~45 from crossing
            WorldXy::new(2600, 400),  // 3
            WorldXy::new(2600, 1500), // 4  excursion
            WorldXy::new(200, 1500),  // 5  excursion
            WorldXy::new(200, 500),   // 6  zig-zag pass start
            WorldXy::new(1300, 100),  // 7  dives south of both bars
            WorldXy::new(1300, 900),  // 8  climbs north — leg 7->8 runs through the crossing
            WorldXy::new(2400, 500),  // 9  zig-zag pass end
        ];

        let got = refine_one_crossing(
            &work,
            crossing,
            &bars,
            &bars,
            &unit_cost,
            RefineParams::DEFAULT,
        )
        .expect("the zig-zag crossing pass must be found and straightened");
        assert_eq!(got.first(), work.first());
        assert_eq!(got.last(), work.last());
        // The clear pass (vertices 1, 2) is untouched; the change is in
        // the zig-zag stretch (original indices 6..=9).
        assert!(got.contains(&work[1]) && got.contains(&work[2]));
        assert!(!got.contains(&work[7]) || !got.contains(&work[8]));
        assert!(
            polyline_len_m(&got) < polyline_len_m(&work),
            "straightening the zig-zag must shorten the route"
        );
        let bboxes: Vec<RingBox> = bars.iter().map(|r| RingBox::of(r)).collect();
        for w in got.windows(2) {
            assert!(
                visible(w[0], w[1], &bars, &bboxes),
                "kept leg crosses a bar"
            );
        }
    }

    /// When the bracketed stretch is already the straight chord and it is
    /// clear, `refine_segment` returns `[entry, exit]` and there is
    /// nothing to splice — the crossing is left alone.
    #[test]
    fn refine_one_crossing_declines_when_the_bracket_is_already_clear() {
        let rings = diagonal_wall_with_gap();
        let work = vec![WorldXy::new(-500, 2000), WorldXy::new(3200, 2000)];
        let crossing = WorldXy::new(1300, 2000);
        assert!(refine_one_crossing(
            &work,
            crossing,
            &rings,
            &rings,
            &unit_cost,
            RefineParams::DEFAULT,
        )
        .is_none());
    }
}
