// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! A bounded-budget raster grid + A* shortest path around a hazard union.
//!
//! Replaces an earlier visibility-graph search (`routing::graph`, retired —
//! see `ROUTING_TODO.md`'s "raster grid" entry) whose cost scaled with BOTH
//! how far apart `from`/`to` were AND how much real coastline happened to
//! sit nearby: its own "corridor" filter padded by the route's own direct
//! distance, so a longer route got a proportionally bigger corridor and
//! therefore MORE candidate hazard vertices, not fewer — the O(n²)
//! pairwise-visibility cost it was built to bound came right back for any
//! route long enough. Measured against the real installed Danish o-charts
//! set: 1.3nm ~0.3s, 18nm 1.1s, 85nm 7.6s, ~400nm never returned in 14
//! minutes.
//!
//! This module makes the cost a function of ONE thing this code controls
//! directly: grid resolution (see [`TARGET_DIM`]/[`HARD_MAX_DIM`]) —
//! independent of route length and of coastline vertex density. The
//! candidate hazard polygons get rasterized onto a bounded-size blocked/
//! free grid around a corridor, [`pathfinding::directed::astar`] finds a
//! path over it, and the raw cell-by-cell path is shortcut back down to a
//! handful of clean waypoints by line-of-sight string-pulling
//! ([`simplify_path`]) — the same exact-crossing [`visibility::visible`]
//! primitive the old visibility graph already relied on and had two real
//! bugs fixed in, reused rather than re-derived.
//!
//! # What stays exact
//!
//! The direct-line fast path ([`shortest_path`]'s first check) and the
//! string-pulling shortcuts both use exact segment-vs-ring geometry, not
//! grid-quantized approximations — only the SEARCH over an obstructed
//! route is grid-resolution-limited, and only within the bounds the
//! rasterizer's own conservative "any overlap blocks" rule already favors
//! (same direction `Corridor`'s ring-level filtering favored before).
//! Start/end points are never snapped to a grid cell in the returned
//! waypoints — see [`shortest_path`]'s own handling of the first/last
//! point.

mod bake;
/// `pub(crate)`, not private to this module: [`crate::mivnav::portals`]
/// reuses the same Felzenszwalb–Huttenlocher transform for §8.2's
/// portal-local `min_horizontal_width` — see that module's own docs, and
/// `distance_field`'s, for the seam between the two consumers ([`Grid`]
/// itself deliberately stays private).
pub(crate) mod distance_field;
mod graph;

pub use bake::CellHazardBake;
pub use graph::{graph_route, GraphRoute};

use crate::coords::{lat_lon_to_world, sm_from_world, worldx_to_lon, worldy_to_lat, WorldXy};
use crate::routing::hazards::{radius_world_units, rings_contain};
use crate::routing::visibility::{visible, RingBox};
use distance_field::DistanceField;
use pathfinding::directed::astar::astar;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

/// A found path: waypoints in `(lon, lat)` order from start to end
/// inclusive, its total length in real ground metres, and diagnostics for
/// `backend/mivnav/features/routing/hazards.py`'s `Timings` log (see
/// [`RouteDiagnostics`]).
///
/// `approximate_legs`: one entry per LEG (`waypoints[i]` →
/// `waypoints[i+1]`, so `waypoints.len() - 1` entries), `true` where that
/// leg is a straight-line stand-in rather than an exactly-verified
/// result — asked for directly ("get as close as you can with the good
/// autoroute and then do a straight line the rest"), then generalized
/// again once real testing showed it needed to be: NOT ONLY the first/
/// last leg (`from`/`to` itself inside the hazard union — a harbour
/// basin the safety-depth polygon swallows whole is the common real
/// case, or no real path connects them at all even once both ends are
/// nudged onto safe water) but ANY leg, ANYWHERE along the route.
///
/// Why any leg, not just the ends: a single grid resolution shared
/// across one whole corridor coarsens for a long passage (bounded by
/// [`HARD_MAX_DIM`]) — coarse enough that a real, narrow hazard feature
/// (a headland, a strait) can fall entirely between the rasterizer's own
/// samples and never register as blocked at all, ANYWHERE the corridor
/// passes it, not only near a snapped endpoint. [`shortest_path_weighted`]
/// therefore exactly re-verifies EVERY leg of the final simplified route
/// against the real hazard geometry (not just the shortcut candidates
/// [`simplify_path`] already checks) and marks any that fails —
/// confirmed live, not hypothetical: a real ~63nm test threaded a leg
/// straight through a real headland near its start at 220m grid
/// resolution, passing the grid's OWN walkability check the whole way,
/// which a narrower "only re-check the ends" fix would not have caught
/// had the same gap shown up at a real strait mid-route instead.
///
/// Every entry `false` (today's only case before this existed) is the
/// ordinary fully-exact route. See [`shortest_path_weighted`]'s own docs
/// for the mechanism.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutePath {
    pub waypoints: Vec<(f64, f64)>,
    pub distance_m: f64,
    pub diagnostics: RouteDiagnostics,
    pub approximate_legs: Vec<bool>,
}

/// Per-request search stats, folded into the backend's existing
/// `"shortest_path"` `Timings` step detail string rather than a new step —
/// see `hazards.py`'s own docs. Every field is a near-free byproduct of
/// the algorithm itself (grid dimensions the sizing already computed,
/// blocked-cell count from rasterizing, node-expansion count from the A*
/// successors closure, widen-attempt index from the retry loop) — nothing
/// here costs a separate pass to collect.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RouteDiagnostics {
    /// `true` when `from`→`to` was already clear and the grid was never
    /// touched — the common case for a route with nothing in the way.
    pub used_direct_line: bool,
    pub grid_cols: u32,
    pub grid_rows: u32,
    pub cell_size_m: f64,
    pub blocked_cells: u32,
    pub nodes_expanded: u32,
    /// Index into `CORRIDOR_PAD_FACTORS` the winning attempt used — 0 on
    /// the common case (tight corridor found a path first try).
    pub corridor_widen_attempts: u32,
}

impl RouteDiagnostics {
    fn direct() -> Self {
        RouteDiagnostics {
            used_direct_line: true,
            grid_cols: 0,
            grid_rows: 0,
            cell_size_m: 0.0,
            blocked_cells: 0,
            nodes_expanded: 0,
            corridor_widen_attempts: 0,
        }
    }
}

/// No coastal cell needs finer than this — resolves a tight marina/
/// channel gap without wasting grid budget everywhere else.
const MIN_CELL_M: f64 = 6.0;
/// No point being coarser than this even for a long open-water passage —
/// keeps a real bend point from being rasterized away entirely.
const MAX_CELL_M: f64 = 120.0;
/// Soft target for the grid's longer dimension — ~160,000 cells nominal.
const TARGET_DIM: u32 = 400;
/// Hard cap on either grid dimension, overriding [`MIN_CELL_M`] if needed
/// — ~810,000 cells worst case. THIS, not vertex count or route length,
/// is what bounds `shortest_path`'s cost.
pub(crate) const HARD_MAX_DIM: u32 = 900;
/// Corridor padding, as a multiple of the direct `from`-`to` distance,
/// tried in order until a path is found. Starts tight — a wide corridor
/// for a route that doesn't need to detour far just wastes grid
/// resolution on empty margin — and widens only for a genuine dead end
/// (e.g. a destination up a narrow inlet needing more lateral room than
/// the first guess allowed).
pub(crate) const CORRIDOR_PAD_FACTORS: [f64; 3] = [0.3, 1.0, 3.0];
/// Floor under the pad below, so a very short hop (two points a few
/// metres apart) still gets a real corridor.
pub(crate) const CORRIDOR_PAD_FLOOR_M: f64 = 2000.0;
/// The SAME floor as [`CORRIDOR_PAD_FLOOR_M`], but for
/// [`refine_flagged_legs`]'s own recursive re-search ONLY (`depth > 0` in
/// [`refine_recursive`]) — never the original top-level request. A flagged
/// run's own two endpoints are already real bend points of an
/// almost-working route (`refine_flagged_legs`'s own docs), not "two points
/// a few metres apart" the full floor exists to protect (see
/// [`CORRIDOR_PAD_FLOOR_M`]'s own docs) — so a smaller floor here still
/// gives the widen ladder real room to find a genuine local detour, while
/// no longer forcibly coarsening a SHORT flagged leg's own corridor past
/// [`MIN_CELL_M`] the way the full floor does.
///
/// Measured, not guessed (`bake_prototype::pad_floor_hypothesis_
/// measurement`, since deleted with the rest of that prototype — numbers
/// captured here): a real ~343m flagged-run-shaped request inside
/// `DE6OSTIM.S57` sizes to `cell_size_m=10.504` under the full 2000m floor
/// — coarse enough to reproduce the resolution-miss bug directly — but
/// already reaches `cell_size_m=6.000` (exactly [`MIN_CELL_M`], matching a
/// per-cell hazard bake's own natural resolution with zero caching
/// machinery) at a 1000m floor, and every floor tried from 1000m down to 0m
/// gave the identical 6.000m result for that request. 1000m — half the
/// original floor, not the smallest value that happened to work — is
/// picked to keep real, deliberate margin over the point where behaviour
/// stops changing: for a short leg the floor still guarantees a full
/// kilometre of pad on every widen attempt (plenty of room for a local
/// detour around a headland or a breakwater), and for a longer flagged run
/// the floor rarely binds at all (`direct_m * pad_factor` already exceeds
/// it), so this changes nothing there.
const REFINE_PAD_FLOOR_M: f64 = 1000.0;
/// Cap under the pad below — as important as the floor, for the opposite
/// reason: `pad_m` scales with `from`-`to`'s own direct distance (see
/// [`CORRIDOR_PAD_FACTORS`]'s docs), which is exactly right for a modest
/// coastal hop but, left uncapped, reproduces this module's whole reason
/// for existing at long range — a 400nm route's widest attempt would pad
/// by `3 * 740km ≈ 2,200km` EACH SIDE, ballooning
/// [`corridor_bbox_lonlat`] into a candidate-hazard-cell selection
/// spanning half the planet (measured: an uncapped bbox for a real 400nm
/// pair came back `(west 6°, south -90°, east -117°, north 90°)` —
/// wrapped nonsense at the poles/antimeridian, and even before wrapping,
/// far wider than any real detour could need). No real coastal detour
/// needs more lateral room than this to route around even a large
/// peninsula or island chain, so capping it costs nothing a real route
/// would ever want.
pub(crate) const CORRIDOR_PAD_CAP_M: f64 = 50_000.0;

/// A padded box around `from`/`to` at a given [`CORRIDOR_PAD_FACTORS`]
/// entry.
#[derive(Clone)]
struct Corridor {
    xmin: i32,
    xmax: i32,
    ymin: i32,
    ymax: i32,
}

/// `direct_m * pad_factor`, clamped — the pure function [`Corridor::around`]
/// applies; split out so a caller that already has `direct_m` (the widen
/// loop, deduping its own attempts below) doesn't recompute it per attempt.
/// `floor_m` is the caller's choice of pad floor — [`CORRIDOR_PAD_FLOOR_M`]
/// for [`Corridor::around`] and the top-level search, [`REFINE_PAD_FLOOR_M`]
/// for [`refine_flagged_legs`]'s own recursive re-search (see that
/// constant's own docs for why these differ).
fn clamped_pad_m(direct_m: f64, pad_factor: f64, floor_m: f64) -> f64 {
    (direct_m * pad_factor).clamp(floor_m, CORRIDOR_PAD_CAP_M)
}

/// Which of [`CORRIDOR_PAD_FACTORS`]' attempts are actually DISTINCT for a
/// route of this direct length, as `(original_factor_index, pad_m)` pairs in
/// order — the widen loop in [`shortest_path_weighted`] uses this instead of
/// iterating `CORRIDOR_PAD_FACTORS` directly. `floor_m` — see
/// [`clamped_pad_m`]'s own docs.
///
/// Two different factors can clamp to the IDENTICAL pad in metres: any route
/// past ~50km direct distance saturates [`CORRIDOR_PAD_CAP_M`] at both
/// factor `1.0` and factor `3.0` (measured against a real long request this
/// module can't yet route — see `ROUTING_TODO.md`'s corridor-cap section —
/// which paid for a byte-identical 400k+-cell rasterize-and-search TWICE for
/// nothing before this existed). Building `Corridor`/`GridSpec`/`Grid` is a
/// pure function of `(from, to, pad_m)` alone, so a repeated `pad_m` is
/// GUARANTEED to reproduce the exact same grid and therefore the exact same
/// search outcome — skipping the repeat changes no result, only how many
/// times an identical one gets computed. The returned index is always the
/// FIRST original `CORRIDOR_PAD_FACTORS` index that reaches a given `pad_m`,
/// so `routing.log`'s `corridor_widen_attempts` diagnostic keeps its
/// existing meaning ("how far did we have to widen") rather than a
/// deduped-list position nobody outside this function knows about.
fn widen_attempts_for(direct_m: f64, floor_m: f64) -> Vec<(usize, f64)> {
    let mut attempts: Vec<(usize, f64)> = Vec::with_capacity(CORRIDOR_PAD_FACTORS.len());
    for (i, &factor) in CORRIDOR_PAD_FACTORS.iter().enumerate() {
        let pad_m = clamped_pad_m(direct_m, factor, floor_m);
        if attempts.last().map(|&(_, p)| p) != Some(pad_m) {
            attempts.push((i, pad_m));
        }
    }
    attempts
}

impl Corridor {
    fn around(from: WorldXy, to: WorldXy, pad_factor: f64) -> Corridor {
        let (ex, ey) = sm_from_world(to, from);
        let direct_m = (ex * ex + ey * ey).sqrt();
        Corridor::with_pad(
            from,
            to,
            clamped_pad_m(direct_m, pad_factor, CORRIDOR_PAD_FLOOR_M),
        )
    }

    /// Same box [`Corridor::around`] builds, given an already-clamped pad in
    /// metres directly — the primitive the widen loop uses once it has
    /// deduped which distinct `pad_m` values [`CORRIDOR_PAD_FACTORS`]
    /// actually produces for this route, so two factors that clamp to the
    /// identical cap (any route past ~50km direct distance: factors `1.0`
    /// and `3.0` both saturate [`CORRIDOR_PAD_CAP_M`]) build the corridor
    /// only once rather than twice.
    fn with_pad(from: WorldXy, to: WorldXy, pad_m: f64) -> Corridor {
        let center = WorldXy::new(
            ((from.x as i64 + to.x as i64) / 2) as i32,
            ((from.y as i64 + to.y as i64) / 2) as i32,
        );
        let pad = radius_world_units(center, pad_m) as i32;
        Corridor {
            xmin: from.x.min(to.x).saturating_sub(pad),
            xmax: from.x.max(to.x).saturating_add(pad),
            ymin: from.y.min(to.y).saturating_sub(pad),
            ymax: from.y.max(to.y).saturating_add(pad),
        }
    }

    fn center(&self) -> WorldXy {
        WorldXy::new(
            ((self.xmin as i64 + self.xmax as i64) / 2) as i32,
            ((self.ymin as i64 + self.ymax as i64) / 2) as i32,
        )
    }

    /// Every ring of `rings` whose own bounding box reaches this corridor
    /// at all — a ring entirely outside it cannot supply a useful bend
    /// point for THIS route (reaching it and back would already cost more
    /// than the padding itself allows), so dropping it changes nothing
    /// about the path found. Cloned, not referenced — the input can be the
    /// full concatenated rings of several chart cells; the filtered copy
    /// this returns is what rasterization actually works with.
    fn relevant_rings(&self, rings: &[Vec<WorldXy>]) -> Vec<Vec<WorldXy>> {
        rings
            .iter()
            .filter(|ring| RingBox::of(ring).overlaps(self.xmin, self.xmax, self.ymin, self.ymax))
            .cloned()
            .collect()
    }
}

/// The lon/lat bounding box a candidate-hazard-cell selection should use
/// for THIS `from`/`to` — the widest [`CORRIDOR_PAD_FACTORS`] entry, since
/// cell selection is cheap (header extents only, no decode) so it is fine
/// to over-select relative to what the tight first search attempt needs;
/// it just must cover whatever the widest widen-retry attempt might need.
/// One source of truth for "how wide an area does this route need",
/// shared between `backend/mivnav/features/routing/hazards.py`'s
/// candidate-cell selection and the search corridor above, instead of two
/// independently-tuned pads that can drift apart. Returned as
/// `(w, s, e, n)` degrees, matching `hazards.py`'s existing convention.
pub fn corridor_bbox_lonlat(from: WorldXy, to: WorldXy) -> (f64, f64, f64, f64) {
    let widest = CORRIDOR_PAD_FACTORS[CORRIDOR_PAD_FACTORS.len() - 1];
    let corridor = Corridor::around(from, to, widest);
    let west = worldx_to_lon(corridor.xmin);
    let east = worldx_to_lon(corridor.xmax);
    // World y grows southward (see `coords::Extent`'s own docs): ymin is
    // the corridor's NORTH edge, ymax its SOUTH edge.
    let north = worldy_to_lat(corridor.ymin);
    let south = worldy_to_lat(corridor.ymax);
    (west, south, east, north)
}

#[derive(Clone, Copy)]
struct GridSpec {
    cols: u32,
    rows: u32,
    cell_size_world: f64,
    cell_size_m: f64,
}

/// Size a grid for `corridor` — bounded by [`HARD_MAX_DIM`] regardless of
/// the corridor's own real-world size, per this module's whole reason for
/// existing. Real-meter spans (ground-corrected, not raw WebMercator-
/// projected ones — same `cos(latitude)` correction `radius_world_units`
/// and the old visibility graph's own `ground_scale` already apply) at the
/// corridor's own centre latitude.
fn size_grid(corridor: &Corridor) -> GridSpec {
    let center = corridor.center();
    let (x0, y0) = sm_from_world(WorldXy::new(corridor.xmin, corridor.ymin), center);
    let (x1, y1) = sm_from_world(WorldXy::new(corridor.xmax, corridor.ymax), center);
    let ground_scale = worldy_to_lat(center.y).to_radians().cos();
    let span_x_m = ((x1 - x0).abs() * ground_scale).max(1.0);
    let span_y_m = ((y1 - y0).abs() * ground_scale).max(1.0);
    let long_span_m = span_x_m.max(span_y_m);

    let mut cell_size_m = (long_span_m / TARGET_DIM as f64).clamp(MIN_CELL_M, MAX_CELL_M);
    if long_span_m / cell_size_m > HARD_MAX_DIM as f64 {
        cell_size_m = long_span_m / HARD_MAX_DIM as f64;
    }
    let cell_size_world = radius_world_units(center, cell_size_m).max(1.0);

    let cols = ((span_x_m / cell_size_m).ceil() as u32).clamp(1, HARD_MAX_DIM);
    let rows = ((span_y_m / cell_size_m).ceil() as u32).clamp(1, HARD_MAX_DIM);
    GridSpec {
        cols,
        rows,
        cell_size_world,
        cell_size_m,
    }
}

/// [`size_grid`]'s same math, but with the resolution/budget tradeoff
/// picked by the CALLER (`cell_size_m`/`max_dim`) rather than this
/// module's own [`TARGET_DIM`]/[`MIN_CELL_M`]/[`MAX_CELL_M`]/
/// [`HARD_MAX_DIM`] constants — [`macro_route`]'s own grid is sized for a
/// much larger area at a much coarser resolution than any per-request
/// search ever needs, so it has no business sharing those constants. Still
/// re-derives a coarser `cell_size_m` when `max_dim` would otherwise be
/// exceeded, same "never silently blow the cell budget" rule `size_grid`
/// itself follows.
fn size_grid_explicit(corridor: &Corridor, cell_size_m: f64, max_dim: u32) -> GridSpec {
    let center = corridor.center();
    let (x0, y0) = sm_from_world(WorldXy::new(corridor.xmin, corridor.ymin), center);
    let (x1, y1) = sm_from_world(WorldXy::new(corridor.xmax, corridor.ymax), center);
    let ground_scale = worldy_to_lat(center.y).to_radians().cos();
    let span_x_m = ((x1 - x0).abs() * ground_scale).max(1.0);
    let span_y_m = ((y1 - y0).abs() * ground_scale).max(1.0);
    let long_span_m = span_x_m.max(span_y_m);

    let mut cell_m = cell_size_m.max(1.0);
    if long_span_m / cell_m > max_dim as f64 {
        cell_m = long_span_m / max_dim as f64;
    }
    let cell_size_world = radius_world_units(center, cell_m).max(1.0);

    let cols = ((span_x_m / cell_m).ceil() as u32).clamp(1, max_dim);
    let rows = ((span_y_m / cell_m).ceil() as u32).clamp(1, max_dim);
    GridSpec {
        cols,
        rows,
        cell_size_world,
        cell_size_m: cell_m,
    }
}

fn world_to_cell(corridor: &Corridor, cell_size_world: f64, p: WorldXy) -> (i32, i32) {
    let cx = ((p.x - corridor.xmin) as f64 / cell_size_world).floor() as i32;
    let cy = ((p.y - corridor.ymin) as f64 / cell_size_world).floor() as i32;
    (cx, cy)
}

fn cell_center(corridor: &Corridor, cell_size_world: f64, cell: (i32, i32)) -> WorldXy {
    let x = corridor.xmin as f64 + (cell.0 as f64 + 0.5) * cell_size_world;
    let y = corridor.ymin as f64 + (cell.1 as f64 + 0.5) * cell_size_world;
    WorldXy::new(x.round() as i32, y.round() as i32)
}

fn clamp_cell(c: (i32, i32), cols: u32, rows: u32) -> (i32, i32) {
    (c.0.clamp(0, cols as i32 - 1), c.1.clamp(0, rows as i32 - 1))
}

/// A blocked/free grid, row-major, `cols * rows` cells.
#[derive(Clone)]
struct Grid {
    cols: u32,
    rows: u32,
    blocked: Vec<bool>,
}

impl Grid {
    /// Out-of-range reads as blocked — never a valid move off the grid.
    fn blocked(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x as u32 >= self.cols || y as u32 >= self.rows {
            return true;
        }
        self.blocked[(y as u32 * self.cols + x as u32) as usize]
    }

    /// Membership test for a TSS/fairway PREFERENCE grid — same storage
    /// as `blocked`, but out-of-range reads as `false`, the OPPOSITE
    /// convention. Load-bearing, not a style choice: reusing `blocked`'s
    /// true-out-of-range convention for a fairway grid would mean
    /// "outside the corridor = inside a fairway", an unbounded
    /// free-travel incentive right at the boundary that would silently
    /// invalidate `CostModel::heuristic_scale`'s own admissibility proof
    /// (which assumes the fairway discount is bounded by
    /// `fairway_preference_weight` EVERYWHERE, not unboundedly large at
    /// an edge case). `blocked` stays exactly as-is for the walkability
    /// grid; `filled` is used only for TSS/fairway membership grids.
    fn filled(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x as u32 >= self.cols || y as u32 >= self.rows {
            return false;
        }
        self.blocked[(y as u32 * self.cols + x as u32) as usize]
    }
}

/// Rasterize `rings` (already corridor-filtered, see
/// [`Corridor::relevant_rings`]) onto a `cols x rows` grid of
/// `cell_size_world`-sized cells anchored at `(corridor.xmin,
/// corridor.ymin)`. `true` = blocked: the hazard union's interior touches
/// this cell's own centre — a single-sample-per-cell test, not exact
/// coverage, matching the resolution-bounded design this module exists
/// for (same "a superset is the safe direction" call `Corridor`'s own
/// filtering already favors).
///
/// Standard scanline fill: for each grid row, find every ring-edge
/// crossing of that row's horizontal line (the same crossing test
/// `hazards::ring_crossing_odd_scaled` uses for a single query point,
/// here collecting every crossing along a row instead of testing one
/// point), sort them, and sweep left to right accumulating a winding
/// number — the same nonzero-winding rule `hazards::rings_contain`/
/// `rings_contain_scaled` already use, not a new fill rule, but applied
/// per EDGE here rather than per ring: each crossing's sign comes from
/// that specific edge's own vertical direction (`by > ay` = entering as y
/// increases, `+1`; the reverse, `-1`), not the ring's overall signed
/// area. This matters even for a single simple ring — its two crossings
/// of any one scanline always run in OPPOSITE directions (one edge headed
/// down through the line, the other headed up), so a per-edge sign is
/// what makes the winding number return to zero past the ring's far side
/// at all; weighting every crossing by one fixed per-ring sign instead
/// (an earlier, broken version of this function) leaves the winding
/// number monotonically growing across a ring's own two crossings and
/// NEVER closes the span — a real bug, caught by
/// `rasterizer_blocks_the_interior_of_a_known_square_and_nothing_else`.
/// `HazardIndex::rings`'s own convention (exterior rings forced
/// positive-area, holes forced negative — see `hazards::push_ring`) means
/// hole rings are always wound opposite their enclosing exterior, so this
/// per-edge rule composes correctly across exterior/hole pairs too, with
/// no separate ring-sign bookkeeping needed.
fn rasterize(
    rings: &[Vec<WorldXy>],
    corridor: &Corridor,
    cell_size_world: f64,
    cols: u32,
    rows: u32,
) -> Grid {
    let mut blocked = vec![false; cols as usize * rows as usize];
    if cols == 0 || rows == 0 {
        return Grid {
            cols,
            rows,
            blocked,
        };
    }
    let ring_boxes: Vec<RingBox> = rings.iter().map(|r| RingBox::of(r)).collect();

    for ry in 0..rows {
        let y = corridor.ymin as f64 + (ry as f64 + 0.5) * cell_size_world;
        let y_lo = y.floor() as i32;
        let y_hi = y.ceil() as i32;

        let mut crossings: Vec<(f64, i32)> = Vec::new();
        for (ring, bb) in rings.iter().zip(&ring_boxes) {
            if !bb.overlaps(corridor.xmin, corridor.xmax, y_lo, y_hi) {
                continue;
            }
            let n = ring.len();
            for i in 0..n {
                let a = ring[i];
                let b = ring[(i + 1) % n];
                let (ay, by) = (a.y as f64, b.y as f64);
                if (ay > y) != (by > y) {
                    let t = (y - ay) / (by - ay);
                    let x = a.x as f64 + t * (b.x as f64 - a.x as f64);
                    let sign = if by > ay { 1 } else { -1 };
                    crossings.push((x, sign));
                }
            }
        }
        crossings.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap());

        let mut winding = 0i32;
        let mut span_start: Option<f64> = None;
        for &(x, sign) in &crossings {
            let was_inside = winding != 0;
            winding += sign;
            let is_inside = winding != 0;
            if !was_inside && is_inside {
                span_start = Some(x);
            } else if was_inside && !is_inside {
                if let Some(start) = span_start.take() {
                    fill_span(
                        &mut blocked,
                        cols,
                        ry,
                        corridor.xmin,
                        cell_size_world,
                        start,
                        x,
                    );
                }
            }
        }
    }

    Grid {
        cols,
        rows,
        blocked,
    }
}

/// [`rasterize`], but OPTIMISTIC rather than conservative — for
/// [`macro_route`] only, where a false-CLOSED cell would hide the very
/// detour the whole pass exists to find (see that function's own docs).
/// Rasterizes at DOUBLE the resolution in each axis, then downsamples 2x2
/// -> 1: a coarse cell is blocked only when ALL FOUR of its finer
/// sub-cells are — "any water anywhere in this cell keeps it open". A
/// real channel narrower than `cell_size_world` but wider than half of it
/// still reads as passable, at 4x this function's own rasterize cost (not
/// [`rasterize`]'s caller's search cost, which stays at the coarse
/// `cols * rows` size) — worth paying here because [`macro_route`] runs
/// rarely, as a fallback, not on every request the way [`rasterize`]
/// itself does.
fn rasterize_optimistic(
    rings: &[Vec<WorldXy>],
    corridor: &Corridor,
    cell_size_world: f64,
    cols: u32,
    rows: u32,
) -> Grid {
    if cols == 0 || rows == 0 {
        return Grid {
            cols,
            rows,
            blocked: Vec::new(),
        };
    }
    let fine_cell = (cell_size_world / 2.0).max(1.0);
    let fine = rasterize(rings, corridor, fine_cell, cols * 2, rows * 2);
    let mut blocked = vec![false; (cols * rows) as usize];
    for ry in 0..rows {
        for rx in 0..cols {
            let all_blocked = (0..2)
                .all(|dy| (0..2).all(|dx| fine.blocked(rx as i32 * 2 + dx, ry as i32 * 2 + dy)));
            blocked[(ry * cols + rx) as usize] = all_blocked;
        }
    }
    Grid {
        cols,
        rows,
        blocked,
    }
}

fn fill_span(
    blocked: &mut [bool],
    cols: u32,
    row: u32,
    xmin: i32,
    cell_size_world: f64,
    x_start: f64,
    x_end: f64,
) {
    if cols == 0 || x_end <= xmin as f64 {
        return;
    }
    let col_start = (((x_start - xmin as f64) / cell_size_world).floor().max(0.0)) as u32;
    let col_end_f = ((x_end - xmin as f64) / cell_size_world).ceil().max(0.0);
    let col_end = (col_end_f as u32).min(cols);
    if col_start >= col_end {
        return;
    }
    let row_base = (row * cols) as usize;
    for c in col_start..col_end {
        blocked[row_base + c as usize] = true;
    }
}

/// 8-connected neighbour offsets, shared by the unweighted BFS walks
/// below ([`nearest_free_cell`], [`closest_reachable`]) — `search_grid`'s
/// own A* keeps its own copy paired with per-direction step costs.
const NEIGHBORS_8: [(i32, i32); 8] = [
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, 1),
    (1, -1),
    (-1, 1),
    (-1, -1),
];

/// The nearest FREE cell to `from` (BFS, grid steps — a reasonable proxy
/// for "nearest" at this module's own resolution), or `None` if EVERY
/// cell in `grid` is blocked. `from` itself, if already free, is returned
/// immediately at zero cost — the common case once an endpoint isn't
/// itself unsafe (see [`shortest_path_weighted`]'s own docs on the
/// "grazing the edge" quantization tolerance this preserves rather than
/// duplicates).
///
/// Used only when the TRUE `from`/`to` sits inside the hazard union by
/// exact geometry (`hazards::rings_contain`) — the search cannot just
/// walk from there the way it always could from an already-safe point: a
/// route whose own endpoint is reused verbatim would silently claim a
/// real path into a hazard it never actually crossed.
fn nearest_free_cell(grid: &Grid, from: (i32, i32)) -> Option<(i32, i32)> {
    if grid.cols == 0 || grid.rows == 0 {
        return None;
    }
    let start = (
        from.0.clamp(0, grid.cols as i32 - 1),
        from.1.clamp(0, grid.rows as i32 - 1),
    );
    if !grid.blocked(start.0, start.1) {
        return Some(start);
    }
    let idx = |c: (i32, i32)| (c.1 as u32 * grid.cols + c.0 as u32) as usize;
    let mut visited = vec![false; (grid.cols * grid.rows) as usize];
    visited[idx(start)] = true;
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(start);
    while let Some((x, y)) = queue.pop_front() {
        for &(dx, dy) in &NEIGHBORS_8 {
            let n = (x + dx, y + dy);
            if n.0 < 0 || n.1 < 0 || n.0 as u32 >= grid.cols || n.1 as u32 >= grid.rows {
                continue;
            }
            if visited[idx(n)] {
                continue;
            }
            visited[idx(n)] = true;
            if !grid.blocked(n.0, n.1) {
                return Some(n);
            }
            queue.push_back(n);
        }
    }
    None
}

fn grid_dist2(a: (i32, i32), b: (i32, i32)) -> i64 {
    let dx = (a.0 - b.0) as i64;
    let dy = (a.1 - b.1) as i64;
    dx * dx + dy * dy
}

/// LAST RESORT when no path connects `start` to `goal` at all — a
/// genuinely enclosed area (`shortest_path_weighted`'s own corridor-widen
/// ladder exhausted, see its docs). Floods `grid`'s free cells outward
/// from `start` (plain BFS — this is already a degraded fallback, not
/// the search proper, so no soft preferences apply here) and returns the
/// path to whichever visited cell ends up CLOSEST to `goal` (grid-step
/// distance) — "get as close as the real search honestly can, then
/// straight-line the rest" is exactly what this feeds.
///
/// `None` only when `start` itself is blocked — never true for a caller
/// that got `start` from [`nearest_free_cell`]. Bounded by the grid's own
/// size (`HARD_MAX_DIM`² worst case), same ceiling every other pass in
/// this module already accepts.
fn closest_reachable(grid: &Grid, start: (i32, i32), goal: (i32, i32)) -> Option<Vec<(i32, i32)>> {
    if grid.blocked(start.0, start.1) {
        return None;
    }
    let idx = |c: (i32, i32)| (c.1 as u32 * grid.cols + c.0 as u32) as usize;
    let mut came_from: Vec<Option<(i32, i32)>> = vec![None; (grid.cols * grid.rows) as usize];
    let mut visited = vec![false; (grid.cols * grid.rows) as usize];
    visited[idx(start)] = true;
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(start);
    let mut best = start;
    let mut best_dist = grid_dist2(start, goal);
    while let Some(cur) = queue.pop_front() {
        let d = grid_dist2(cur, goal);
        if d < best_dist {
            best_dist = d;
            best = cur;
        }
        for &(dx, dy) in &NEIGHBORS_8 {
            let n = (cur.0 + dx, cur.1 + dy);
            if n.0 < 0 || n.1 < 0 || n.0 as u32 >= grid.cols || n.1 as u32 >= grid.rows {
                continue;
            }
            if visited[idx(n)] || grid.blocked(n.0, n.1) {
                continue;
            }
            visited[idx(n)] = true;
            came_from[idx(n)] = Some(cur);
            queue.push_back(n);
        }
    }
    let mut path = vec![best];
    let mut cur = best;
    while cur != start {
        cur = came_from[idx(cur)]?;
        path.push(cur);
    }
    path.reverse();
    Some(path)
}

const ORTHO_COST: u32 = 1000;
const DIAG_COST: u32 = 1414; // 1000 * sqrt(2), rounded — matches the old graph's millimetre-scale integer costs

/// A* over `grid`'s free cells, 8-connected. `start`/`goal` are always
/// treated as walkable regardless of what the grid rasterized there — the
/// caller already proved the real `from`/`to` points are clear via an
/// exact containment test before ever building a grid; a cell-centre
/// rasterization sample landing on the wrong side of a boundary a real
/// point sits just outside of must not strand the search at its own
/// starting point. Returns the raw cell path, its cost, and how many
/// nodes A* expanded (a free diagnostic — `pathfinding::astar` doesn't
/// expose this itself, so it's counted directly in the successors
/// closure).
///
/// `cost_model`, when given, is every soft cost preference active for
/// this attempt (shallow-water, TSS avoidance, fairway preference — see
/// [`CostModel`]). `None` reproduces today's plain distance search
/// exactly, at zero extra cost per edge.
fn search_grid(
    grid: &Grid,
    start: (i32, i32),
    goal: (i32, i32),
    cost_model: Option<&CostModel>,
) -> Option<(Vec<(i32, i32)>, u32)> {
    const NEIGHBORS: [(i32, i32, u32); 8] = [
        (1, 0, ORTHO_COST),
        (-1, 0, ORTHO_COST),
        (0, 1, ORTHO_COST),
        (0, -1, ORTHO_COST),
        (1, 1, DIAG_COST),
        (1, -1, DIAG_COST),
        (-1, 1, DIAG_COST),
        (-1, -1, DIAG_COST),
    ];
    let expansions = std::cell::Cell::new(0u32);
    let is_walkable = |p: (i32, i32)| p == start || p == goal || !grid.blocked(p.0, p.1);
    let result = astar(
        &start,
        |&(x, y)| {
            expansions.set(expansions.get() + 1);
            NEIGHBORS
                .iter()
                .filter_map(|&(dx, dy, base_cost)| {
                    let p = (x + dx, y + dy);
                    if !is_walkable(p) {
                        return None;
                    }
                    let cost = match cost_model {
                        Some(model) => {
                            let ma = combined_multiplier((x, y), model);
                            let mb = combined_multiplier(p, model);
                            // .ceil(), not .round(): guarantees cost >=
                            // base_cost * MIN_MULTIPLIER always, never
                            // occasionally under by a rounding accident —
                            // see `octile_heuristic`'s own docs on why
                            // that inequality is what keeps it admissible.
                            (base_cost as f64 * (ma + mb) / 2.0).ceil().max(1.0) as u32
                        }
                        None => base_cost,
                    };
                    Some((p, cost))
                })
                .collect::<Vec<_>>()
        },
        |&(x, y)| {
            let h = octile_heuristic(x, y, goal.0, goal.1);
            match cost_model {
                // .floor(), not .round()/.ceil(): flooring can only make
                // the bound SMALLER, never risk pushing it above the true
                // (scaled) minimum cost — see `octile_heuristic`'s own
                // docs for the admissibility proof this is load-bearing
                // for.
                Some(model) => (h as f64 * model.heuristic_scale).floor() as u32,
                None => h,
            }
        },
        |&p| p == goal,
    );
    result.map(|(path, _cost)| (path, expansions.get()))
}

/// The 8-connected step directions [`search_grid_with_turn_cost`] moves
/// through, ROTATIONALLY ordered — each consecutive index, wrapping,
/// is exactly one 45° step around from the last. Unlike [`search_grid`]'s
/// own local `NEIGHBORS` const (grouped orthogonal-then-diagonal, an
/// ordering that has no notion of "adjacent" between entries), this
/// array's rotational order is the whole point: it is what lets a plain
/// INDEX difference between two entries directly encode an ANGLE
/// difference (see [`angular_steps`]), with no trigonometry needed at
/// search time. No relation implied to true compass direction — world
/// coordinates increase Y *southward* (`coords::lat_to_worldy`'s own
/// docs, also noted directly in `routing::buoyage`'s sign-convention
/// docs), so these indices are only ever compared to EACH OTHER, never
/// read as North/East/South/West.
const NEIGHBORS_TURN: [(i32, i32, u32); 8] = [
    (1, 0, ORTHO_COST),
    (1, 1, DIAG_COST),
    (0, 1, ORTHO_COST),
    (-1, 1, DIAG_COST),
    (-1, 0, ORTHO_COST),
    (-1, -1, DIAG_COST),
    (0, -1, ORTHO_COST),
    (1, -1, DIAG_COST),
];

/// Sentinel `incoming_direction` for [`search_grid_with_turn_cost`]'s own
/// START state — no step has been taken yet, so there is nothing to
/// compare the very first move against; a state carrying this value is
/// never charged a turn cost for whichever direction it moves in first.
/// `8`, not a 9th [`NEIGHBORS_TURN`] entry: this is the one genuinely
/// extra piece of state the search space carries beyond `cols * rows *
/// 8`, and it exists at exactly one cell (`start`), not one per cell.
const NO_INCOMING_DIRECTION: u8 = 8;

/// Angular distance between two [`NEIGHBORS_TURN`] direction indices, in
/// 45° steps — `0` (same direction, straight on) through `4` (a full
/// 180° reversal). `NEIGHBORS_TURN`'s rotational ordering is exactly what
/// makes a plain index difference, wrapped the SHORT way around the
/// 8-direction circle, equal the true angular difference: e.g. index `0`
/// vs index `7` are adjacent directions (45° apart) despite differing by
/// `7`, not `1`, as plain integers — `min(7, 8-7) == 1` recovers the real
/// answer. `a`/`b` must each be in `0..8` ([`NO_INCOMING_DIRECTION`] is
/// never passed here — callers check for it separately, since "no prior
/// direction" has no angle to measure at all, not a `0`-length one).
fn angular_steps(a: u8, b: u8) -> u8 {
    let diff = (a as i8 - b as i8).unsigned_abs();
    diff.min(8 - diff)
}

/// The unit [`turn_penalty`] is expressed in: `weight * steps` of THIS —
/// the same base unit [`ORTHO_COST`]/[`DIAG_COST`] already use for plain
/// grid distance, so `turn_cost_weight = 1.0` reads as "one 45° heading
/// change costs as much as one whole extra orthogonal grid step" — a
/// directly comparable, dimensionally sane mental model, not an
/// arbitrary unit of its own a caller would have to separately learn the
/// scale of.
const TURN_COST_UNIT: f64 = ORTHO_COST as f64;

/// The cost charged for arriving somewhere via `steps` * 45° of heading
/// change from the PREVIOUS step — `0` for continuing straight on
/// (`steps == 0`) or for the search's own very first step (never passed
/// here at all; see [`NO_INCOMING_DIRECTION`]).
///
/// Scales LINEARLY with `steps`, not a flat per-turn charge regardless of
/// sharpness — design question #2 (module-level turn-cost docs, above
/// [`search_grid_with_turn_cost`]): suppressing zigzag specifically wants
/// to discourage SHARP direction changes more than gentle ones, since a
/// route that curves through a sequence of small 45°-adjacent bends is a
/// normal, often-necessary shape (rounding a headland, threading a
/// channel), while one that saws back and forth through 90°+ reversals
/// with no geometric reason to is the actual pathology this feature
/// exists to suppress. Under this formula a real reversal (`steps == 4`,
/// 180°) costs exactly 4x a single 45° nudge — proportionate to how sharp
/// the turn actually is, not a cliff that treats every non-straight step
/// alike.
///
/// `.ceil()`, not `.round()`: for ANY `weight > 0.0` and `steps > 0`, this
/// guarantees a strictly positive (>= 1) cost — a small-but-nonzero
/// configured weight can never silently round down to a no-op edge cost,
/// the exact failure mode `ROUTING_TODO.md` documents for an
/// earlier under-tuned preference (the shallow-water term's first
/// attempt). This is purely a "make a nonzero weight actually bite"
/// choice here, not an admissibility requirement the way `search_grid`'s
/// own multiplicative `.ceil()` is: this term is ADDITIVE and
/// non-negative regardless of how it rounds — see
/// [`search_grid_with_turn_cost`]'s own admissibility docs for why any
/// non-negative rounding keeps the search exact.
fn turn_penalty(steps: u8, weight: f64) -> u32 {
    if steps == 0 || weight <= 0.0 {
        return 0;
    }
    (weight * steps as f64 * TURN_COST_UNIT).ceil() as u32
}

/// [`search_grid`], but with the search STATE expanded from `cell` to
/// `(cell, incoming_direction)` so a genuine, per-turn cost can be
/// charged DURING the search itself, steering it away from producing
/// zigzag in the first place — rather than only cleaning zigzag up
/// afterward the way [`simplify_path`]'s geometric string-pulling always
/// has. Only ever called (by [`search_once`]) when `turn_cost_weight >
/// 0.0`; the ordinary [`search_grid`] handles the `<= 0.0` case exactly
/// as before, so a request with no turn-cost preference pays NONE of this
/// function's extra state or exploration cost.
///
/// **Why the state needs expanding at all**: `pathfinding::astar`, like
/// plain Dijkstra/A*, assumes an edge's cost depends only on its two
/// endpoints (`u`, `v`) — every other cost term this module has (shallow/
/// margin/TSS/fairway/buoyage/cable/caution/survey) fits that assumption
/// exactly, since each is POSITION-dependent (`combined_multiplier` reads
/// only the cell(s) an edge touches). A turn cost is HISTORY-dependent
/// instead: the cost of moving to a cell depends on which DIRECTION the
/// search arrived from at the PREVIOUS step, which a bare `(i32, i32)`
/// cell cannot express — two paths reaching the same cell from different
/// directions are, for turn-cost purposes, genuinely different states,
/// not the same one. Expanding the node type to `(cell,
/// incoming_direction)` — the standard fix for a direction/turn-dependent
/// cost in a grid search — makes the assumption true again: an edge from
/// `((x,y), dir_in)` to `((x2,y2), dir_out)` has a cost that depends only
/// on ITS OWN two (now direction-aware) endpoints once more.
///
/// **State space cost, measured, not assumed** — see `ROUTING_TODO.md`'s
/// turn-cost entry for the real before/after `nodes_expanded`/wall-clock
/// numbers this was checked against on real chart data before shipping:
/// the theoretical space is `cols * rows * 8` (up to ~6.48M states at
/// [`HARD_MAX_DIM`]=900, vs ~810K for the plain search) — but
/// `pathfinding::astar` is a DIRECTED search, not exhaustive, so the
/// nodes it actually expands for a typical request is far below that
/// ceiling; [`RouteDiagnostics::nodes_expanded`] already exists
/// specifically to make this measurable per-request, and continues to
/// cover this path too.
///
/// **Admissible**, for the same reason [`octile_heuristic`]'s own docs
/// already prove for every other raise-only preference term: the
/// heuristic used here is exactly [`search_grid`]'s own — a function of
/// POSITION only, entirely ignorant of the direction component of the
/// state. A turn cost only ever ADDS a non-negative amount on top of the
/// ordinary (possibly already-weighted) distance cost
/// (`turn_penalty`'s own docs: `weight <= 0.0` or `steps == 0` gives
/// exactly `0`, otherwise strictly positive — never negative), so for any
/// state `s`, `true_cost(s) = distance_cost(s) + turn_cost(s) >=
/// distance_cost(s) >= heuristic(position(s))` always holds, regardless
/// of how many more turns a path from `s` still needs to make. No change
/// to `heuristic_scale` (already correctly scaled for the fairway
/// discount, if any) or to the heuristic formula itself is needed, or
/// made — pinned by `turn_cost_search_finds_the_true_optimum_by_brute_
/// force` below, the same brute-force-vs-`search_grid` proof style
/// `heuristic_scale_keeps_the_weighted_search_exact` already established.
fn search_grid_with_turn_cost(
    grid: &Grid,
    start: (i32, i32),
    goal: (i32, i32),
    cost_model: Option<&CostModel>,
    turn_cost_weight: f64,
) -> Option<(Vec<(i32, i32)>, u32)> {
    let expansions = std::cell::Cell::new(0u32);
    let is_walkable = |p: (i32, i32)| p == start || p == goal || !grid.blocked(p.0, p.1);
    let start_state: ((i32, i32), u8) = (start, NO_INCOMING_DIRECTION);
    let result = astar(
        &start_state,
        |&((x, y), incoming)| {
            expansions.set(expansions.get() + 1);
            NEIGHBORS_TURN
                .iter()
                .enumerate()
                .filter_map(|(dir_idx, &(dx, dy, base_cost))| {
                    let p = (x + dx, y + dy);
                    if !is_walkable(p) {
                        return None;
                    }
                    let dist_cost = match cost_model {
                        Some(model) => {
                            let ma = combined_multiplier((x, y), model);
                            let mb = combined_multiplier(p, model);
                            // Same `.ceil().max(1.0)` convention as
                            // `search_grid`'s own edge cost — see that
                            // function's docs for why.
                            (base_cost as f64 * (ma + mb) / 2.0).ceil().max(1.0) as u32
                        }
                        None => base_cost,
                    };
                    let dir = dir_idx as u8;
                    let turn_cost = if incoming == NO_INCOMING_DIRECTION {
                        0
                    } else {
                        turn_penalty(angular_steps(incoming, dir), turn_cost_weight)
                    };
                    Some(((p, dir), dist_cost + turn_cost))
                })
                .collect::<Vec<_>>()
        },
        |&((x, y), _incoming)| {
            let h = octile_heuristic(x, y, goal.0, goal.1);
            match cost_model {
                Some(model) => (h as f64 * model.heuristic_scale).floor() as u32,
                None => h,
            }
        },
        |&(p, _incoming)| p == goal,
    );
    result.map(|(path, _cost)| {
        (
            path.into_iter().map(|(p, _incoming)| p).collect(),
            expansions.get(),
        )
    })
}

/// **Lazy Theta\*** — an any-angle upgrade to [`search_grid`]'s own plain
/// 8-connected grid search: mivnav's own architecture audit identified
/// plain grid A* as the source of grid-aligned zigzag (every route is
/// forced through a staircase of 45°/90° moves even where the water is
/// wide open and a single straight line would do, since a grid search can
/// only ever consider edges between ADJACENT cells) and named this as the
/// top-priority fix. The fix: let a node also connect straight to its own
/// GRANDPARENT (`parent(s)`, not just `s` itself) whenever that longer,
/// non-adjacent edge is both cheaper and genuinely unobstructed — reusing
/// this crate's existing exact [`visible`] primitive for "genuinely
/// unobstructed", the same primitive [`simplify_path`]'s own post-hoc
/// string-pulling already relies on.
///
/// **Lazy** (Nash, Koenig & Tovey 2010): plain Theta* would call
/// `visible()` on every relaxation attempt — every neighbour of every
/// expanded node, toward every one of its ancestors — expensive, and
/// mostly wasted, since most relaxed shortcuts never end up on the final
/// path at all. Instead, the grandparent shortcut is taken OPTIMISTICALLY
/// at relaxation time — `parent(s') = parent(s)` at cost `g(parent(s)) +
/// dist(parent(s), s')` (real Euclidean distance, not `ORTHO_COST`/
/// `DIAG_COST`'s grid-step multiples) — whenever that beats the ordinary
/// one-hop grid step `g(s) + dist(s, s')`, with NO visibility check at
/// relaxation time at all. The assumed line of sight is only ever
/// verified once a node is actually POPPED for expansion: if `visible
/// (parent(s), s)` then turns out false, `s`'s parent/cost are corrected
/// back to its own best ORDINARY (plain adjacent-grid-step) alternative —
/// tracked in parallel throughout via `ordinary_g`/`ordinary_parent` — and
/// `s` is re-pushed rather than expanded immediately, since its true cost
/// just went up and some other open node may now be cheaper. This is
/// exactly what keeps real `visible()` calls bounded by nodes EXPANDED
/// rather than by relaxation attempts (which run up to 8x higher, one per
/// neighbour of every expanded node) — pinned directly by
/// `lazy_visibility_checks_are_bounded_by_nodes_expanded_not_relaxation_
/// attempts` below.
///
/// **Not composed with `cost_model`/turn cost this round** (deliberately
/// out of scope, not an oversight): [`search_once`] only ever calls this
/// when NO soft `CostModel` preference is active — an integrated any-angle
/// cost under a distance-graded/zone preference is a genuinely harder
/// question (does a shortcut need integrated preference cost too?) left
/// for later — and this takes priority over `search_grid_with_turn_cost`
/// when a caller somehow requests both, since it already produces
/// straighter paths BY CONSTRUCTION (an any-angle shortcut IS a zero-turn
/// edge wherever one is geometrically available), which is most of what a
/// turn-cost penalty exists to encourage in the first place.
///
/// **Admissibility — no heuristic change needed.** [`octile_heuristic`]
/// already equals the cost of the CHEAPEST path between two cells using
/// only grid-aligned 45°/90° moves — by definition an ACHIEVABLE path
/// length, so it is always `>=` the straight-line Euclidean distance
/// between the same two points (a straight line is the shortest possible
/// path of any kind; a grid-constrained path, being *a* path, can only be
/// longer or equal). Theta*'s own shortcut edges are costed at exactly
/// that straight-line Euclidean distance (same `ORTHO_COST`-per-cell
/// scale) — and by the triangle inequality, no sequence of shortcut-plus-
/// grid edges from any node `n` to `goal` can ever cost less than the
/// straight-line distance from `n` to `goal` either. So `octile_heuristic
/// (n)`, being `>=` that straight-line distance, remains a valid lower
/// bound on Theta*'s true remaining cost from `n` — verbatim, with no
/// adjustment — even though the true optimum it now bounds can be
/// genuinely CHEAPER than the grid-only optimum it was originally derived
/// from. The only practical effect is a WEAKER (still correct) bound: a
/// diagonal-ish shortcut can beat the octile-grid-path cost it is being
/// compared against, so this search can expand more nodes for the same
/// corridor than a hypothetical, tighter any-angle-aware heuristic would —
/// a real, measured cost paid for correctness, not a defect. Pinned by
/// `theta_star_finds_the_true_any_angle_optimum_by_brute_force` below, the
/// same brute-force-vs-reference style `heuristic_scale_keeps_the_
/// weighted_search_exact` already uses for `search_grid`'s own proofs —
/// note that this admissibility proof only guarantees this search finds
/// the best path REACHABLE via its own grandparent-only shortcut
/// mechanism, which is a real, accepted scope limit of Lazy Theta* itself
/// (Nash/Koenig/Tovey 2010), not an oversight here: reconsidering only ONE
/// hop of ancestry per relaxation can, in scenes where the true optimum
/// needs touching more than one tangent point in sequence, land a small
/// but real amount above the full pairwise-visibility-graph shortest
/// path — measured directly at ~0.6% over on a solid square obstacle
/// (needing both its near and far tangent corners to clear) while writing
/// that test's own brute-force reference, which is why the test itself
/// instead pins the textbook single-REFLEX-CORNER case (a one-cell-wide
/// wall with exactly one relevant corner) this mechanism is provably exact
/// for. Always at least as good as `search_grid`'s own grid-only optimum,
/// per the bound above; just not a promise of matching the
/// theoretically-best any-angle path in every scene.
///
/// **No `closed` set — reopening-tolerant by design**, same "lazy
/// relaxation, allow reopening" discipline [`octile_heuristic`]'s own docs
/// already establish for the plain search's `pathfinding::astar` (needed
/// there because the heuristic is admissible but not strictly consistent,
/// so a node cannot always be trusted as final the instant it is first
/// popped). A popped entry is only processed if its own pushed cost still
/// matches the node's CURRENT best `g` (a stale entry — superseded by
/// either a cheaper relaxation or the lazy visibility correction above —
/// is silently skipped), and a node CAN be relaxed again, and re-expanded,
/// after being processed once, if a later, cheaper path to it is found.
/// Standard and correct for a non-negative-edge-cost lazy-deletion binary
/// heap; the only cost is potentially processing a node more than once,
/// already reflected in the `expansions` this returns.
///
/// Returns `(raw cell path, nodes expanded, real visible() calls made)`.
/// The raw path's consecutive waypoints are **not necessarily grid-
/// adjacent** any more — a shortcut edge can span many cells at once —
/// but every downstream consumer (`simplify_path`, `verify_legs`,
/// `path_distance_m`) already treats its input as an arbitrary polyline,
/// never assumes adjacency, so this needs no changes anywhere downstream.
fn search_grid_theta_star(
    grid: &Grid,
    start: (i32, i32),
    goal: (i32, i32),
    corridor: &Corridor,
    cell_size_world: f64,
    hazard_rings: &[Vec<WorldXy>],
    hazard_bboxes: &[RingBox],
) -> Option<(Vec<(i32, i32)>, u32, u32)> {
    const NEIGHBORS: [(i32, i32, u32); 8] = [
        (1, 0, ORTHO_COST),
        (-1, 0, ORTHO_COST),
        (0, 1, ORTHO_COST),
        (0, -1, ORTHO_COST),
        (1, 1, DIAG_COST),
        (1, -1, DIAG_COST),
        (-1, 1, DIAG_COST),
        (-1, -1, DIAG_COST),
    ];
    let is_walkable = |p: (i32, i32)| p == start || p == goal || !grid.blocked(p.0, p.1);
    if !is_walkable(start) || !is_walkable(goal) {
        return None;
    }

    // Real Euclidean distance between two CELLS, in the same cost unit
    // ORTHO_COST/DIAG_COST already use (1000 per orthogonal grid step) —
    // consistent with the rest of this module's own simplifying
    // assumption that the grid is locally metric-uniform (one
    // `cell_size_world`/`cell_size_m` for the whole corridor), not a
    // second, independently-calibrated unit shortcut edges would need
    // reconciling against.
    let euclid_cost = |a: (i32, i32), b: (i32, i32)| -> u32 {
        let dx = (a.0 - b.0) as f64;
        let dy = (a.1 - b.1) as f64;
        (dx.hypot(dy) * ORTHO_COST as f64).round() as u32
    };
    let heuristic = |p: (i32, i32)| octile_heuristic(p.0, p.1, goal.0, goal.1);

    let mut g: HashMap<(i32, i32), u32> = HashMap::new();
    let mut parent: HashMap<(i32, i32), (i32, i32)> = HashMap::new();
    // The best cost/parent reachable via an ORDINARY one-hop grid step
    // alone (ignoring every shortcut) — the fallback [`Lazy Theta*`]'s own
    // correction step above needs the instant an assumed shortcut fails
    // its real visibility check. Updated by the exact same relaxation
    // rule as `g`/`parent`, just restricted to `NEIGHBORS` edges.
    let mut ordinary_g: HashMap<(i32, i32), u32> = HashMap::new();
    let mut ordinary_parent: HashMap<(i32, i32), (i32, i32)> = HashMap::new();
    // `(f, g_at_push, insertion_seq, cell)` — `g_at_push` is what makes a
    // stale entry detectable at pop time (compare against the cell's
    // CURRENT `g`, cheap `HashMap` lookup, no `decrease-key` support
    // needed from `BinaryHeap`); `insertion_seq` only breaks ties
    // deterministically.
    let mut open: BinaryHeap<Reverse<(u32, u32, u64, (i32, i32))>> = BinaryHeap::new();
    let mut seq: u64 = 0;

    g.insert(start, 0);
    parent.insert(start, start);
    ordinary_g.insert(start, 0);
    ordinary_parent.insert(start, start);
    open.push(Reverse((heuristic(start), 0, seq, start)));
    seq += 1;

    let mut expansions = 0u32;
    let mut visibility_checks = 0u32;

    while let Some(Reverse((_f, g_at_push, _, s))) = open.pop() {
        if g.get(&s) != Some(&g_at_push) {
            // Stale — this cell's cost has since improved (or been
            // corrected, see below) since this entry was pushed; the
            // fresher entry (already popped, or still pending) is the
            // live one. NOT counted as an expansion or a visibility
            // check — see `lazy_visibility_checks_are_bounded_by_nodes_
            // expanded_not_relaxation_attempts` below, which depends on
            // this early-continue happening before either counter moves.
            continue;
        }
        expansions += 1;

        if s != start {
            let p = parent[&s];
            let ordinary_p = ordinary_parent[&s];
            // Only a SHORTCUT parent (anything other than the plain
            // grid-adjacent one) needs verifying — an ordinary parent is
            // exactly the edge `search_grid` itself already treats as
            // walkable with no geometry check at all, so re-checking it
            // here would only be wasted work, never a correctness gap.
            if p != ordinary_p {
                visibility_checks += 1;
                let a = cell_center(corridor, cell_size_world, p);
                let b = cell_center(corridor, cell_size_world, s);
                if !visible(a, b, hazard_rings, hazard_bboxes) {
                    // The assumed line of sight was wrong — fall back to
                    // the ordinary grid-step parent/cost and re-enter the
                    // open list at the CORRECTED priority rather than
                    // expanding now: the corrected cost may no longer be
                    // the cheapest open node.
                    let corrected = ordinary_g[&s];
                    g.insert(s, corrected);
                    parent.insert(s, ordinary_p);
                    open.push(Reverse((
                        corrected.saturating_add(heuristic(s)),
                        corrected,
                        seq,
                        s,
                    )));
                    seq += 1;
                    continue;
                }
            }
        }

        if s == goal {
            let mut path = vec![s];
            let mut cur = s;
            while cur != start {
                cur = parent[&cur];
                path.push(cur);
            }
            path.reverse();
            return Some((path, expansions, visibility_checks));
        }

        let gp = parent[&s];
        let g_s = g[&s];
        let g_gp = *g.get(&gp).unwrap_or(&g_s);
        for &(dx, dy, step_cost) in &NEIGHBORS {
            let sp = (s.0 + dx, s.1 + dy);
            if !is_walkable(sp) {
                continue;
            }
            // Ordinary one-hop grid-step relaxation — the exact edge
            // `search_grid` itself would use.
            let ordinary_candidate = g_s.saturating_add(step_cost);
            if ordinary_candidate < *ordinary_g.get(&sp).unwrap_or(&u32::MAX) {
                ordinary_g.insert(sp, ordinary_candidate);
                ordinary_parent.insert(sp, s);
            }

            // The grandparent-shortcut relaxation — real Euclidean
            // distance, taken OPTIMISTICALLY: no `visible()` call here at
            // all. This is the entire "lazy" in Lazy Theta* — see this
            // function's own docs.
            let shortcut_candidate = g_gp.saturating_add(euclid_cost(gp, sp));

            let (best_cost, best_parent) = if shortcut_candidate < ordinary_candidate {
                (shortcut_candidate, gp)
            } else {
                (ordinary_candidate, s)
            };

            if best_cost < *g.get(&sp).unwrap_or(&u32::MAX) {
                g.insert(sp, best_cost);
                parent.insert(sp, best_parent);
                open.push(Reverse((
                    best_cost.saturating_add(heuristic(sp)),
                    best_cost,
                    seq,
                    sp,
                )));
                seq += 1;
            }
        }
    }
    None
}

/// The shallow-water-preference cost multiplier's own contribution at one
/// cell, `dist_m` from the nearest hazard boundary: `weight` right at the
/// boundary (`dist_m == 0`), decaying linearly to `0` by `radius_m` out,
/// `0` everywhere beyond — see `shortest_path_weighted`'s module docs for
/// why linear decay, not some other curve. `radius_m <= 0.0` is always
/// off, matching `RoutingConfig.shallow_avoidance_radius_m`'s own default.
fn shallow_penalty(dist_m: f64, radius_m: f64, weight: f64) -> f64 {
    if radius_m <= 0.0 {
        return 0.0;
    }
    weight * (1.0 - dist_m / radius_m).clamp(0.0, 1.0)
}

/// The fixed weight [`CostModel::lateral_margin`] penalizes at — unlike
/// every OTHER preference here, this one is not user-tunable; only its
/// own `radius_m` (`RoutingConfig.lateral_margin_m`) is. User decision
/// (#owqqcdqe, 2026-08-10): "make the lateral margin a preference not a
/// hard no go, i would rather a smaller margin than go over land" —
/// `lateral_margin_m` used to be buffered directly into the hazard union
/// itself (an absolute wall no route could cross, however narrow the
/// only real gap happened to be); the hazard union this module receives
/// is now buffered by a small, fixed floor instead — the caller's own
/// choice, not this crate's (`mivnav.features.routing.routes`'s
/// `_HARD_LATERAL_FLOOR_M`, since `build_hazard_index`'s own `margin_m`
/// stays a fully generic parameter other callers legitimately pass `0`
/// to, e.g. the macro pass's land-only topology query — a blanket floor
/// baked in HERE would wrongly affect those too) — never zero, so a
/// route can still never touch charted danger or cross land. THIS term
/// — reusing [`shallow_penalty`]'s own
/// distance-graded shape, same [`DistanceField`] — is what makes the
/// user's larger preferred margin a PREFERENCE from there outward: full
/// weight right at the hard floor, decaying to none by `radius_m`
/// (`lateral_margin_m`) out, same as `shallow_avoidance` but always on
/// whenever `radius_m > 0` rather than gated behind its own separate
/// weight dial — the whole point is that a real margin applies by
/// default the instant a user sets one, with no second "and also turn
/// the preference on" step to forget. `1.0`: right at the hard floor a
/// cell costs double, comfortably enough to route around a hazard when
/// there is room to, without being so dominant it fights a genuinely
/// narrow-but-safe passage the way an unconditional multi-times weight
/// would.
const LATERAL_MARGIN_PREFERENCE_WEIGHT: f64 = 1.0;

/// Floor under [`combined_multiplier`] — a second, independent guarantee
/// alongside `RoutingConfig.fairway_preference_weight`'s own `<1.0`
/// ceiling that no configured combination of weights can ever drive a
/// cost to zero or negative. `0.01`: `ORTHO_COST=1000` floors to `10`, a
/// comfortably positive integer cost nowhere near the search's own
/// diagonal/orthogonal cost granularity.
const MIN_MULTIPLIER: f64 = 0.01;

/// All per-cell soft cost preferences active for ONE search attempt —
/// shallow-water penalty (`DistanceField`-based, decaying with distance
/// to the nearest HARD hazard) and TSS avoidance / fairway preference /
/// buoyage-side avoidance (all three flat, `Grid`-membership-based — each
/// is a binary "inside the charted/computed zone or not", not a
/// distance-graded concept, so no distance transform is built for any of
/// them). Bundled so `search_grid`'s edge-cost/heuristic closures and
/// `simplify_path`'s `segment_penalized_cost_m` compute the IDENTICAL
/// formula via [`combined_multiplier`], never two independently
/// maintained ones — that drift is exactly what let the shallow-water
/// preference's own shortcut-erasure bug slip through once already (see
/// `simplify_path`'s docs); with a fourth cost term now added, writing
/// the formula twice would only make that risk worse.
struct CostModel<'a> {
    corridor: &'a Corridor,
    cell_size_world: f64,
    cell_size_m: f64,

    shallow: Option<(
        &'a DistanceField,
        f64, /* radius_m */
        f64, /* weight */
    )>,
    /// The user's PREFERRED lateral standoff (`RoutingConfig.
    /// lateral_margin_m`) as a soft term, same shape as `shallow` (and
    /// often the SAME underlying `DistanceField` — both measure distance
    /// to the same hazard union, just at different radii/weights) — see
    /// [`LATERAL_MARGIN_PREFERENCE_WEIGHT`]'s own docs for why this is a
    /// separate field rather than folded into `shallow` itself: the two
    /// are independently configured (`shallow_avoidance_weight` is a
    /// user dial, this one's weight is fixed) and a caller may want
    /// either alone.
    lateral_margin: Option<(
        &'a DistanceField,
        f64, /* radius_m */
        f64, /* weight */
    )>,
    tss: Option<(&'a Grid, f64 /* weight */)>,
    /// The preferred-route DISCOUNT — despite the field name, this is the
    /// UNIONED `FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT` zone
    /// (`routing::preference::build_preferred_route_union`), not `FAIRWY`
    /// alone; the field itself keeps its original name rather than being
    /// renamed, to avoid rippling a purely cosmetic change through the
    /// pyo3/backend/frontend wire surface (`fairway_rings`/
    /// `fairway_preference_weight`) for no functional benefit — see
    /// `routing::preference`'s own module docs for the full reasoning on
    /// why all four classes share this one field instead of each getting
    /// its own.
    fairway: Option<(&'a Grid, f64 /* weight */)>,
    /// Same flat-membership shape as `tss` — an AVOID term, not a
    /// discount like `fairway` — over the "wrong side of a lateral mark"
    /// grid `routing::buoyage::build_buoyage_penalty` rasterizes. See
    /// that module's own docs for what "wrong side" means and why it
    /// needs the route's own direction to compute at all.
    buoyage: Option<(&'a Grid, f64 /* weight */)>,
    /// Flat zone-membership AVOID term for the "don't linger over/anchor
    /// near this" family (`CBLSUB`/`PIPSOL`,
    /// `routing::preference::build_cable_union`) — same shape as `tss`/
    /// `buoyage`, a SEPARATE field/weight from `caution` below rather than
    /// unioned into it (see `routing::preference::CABLE_AVOID_CLASSES`'s
    /// own docs for why: a genuinely different KIND of concern, not just a
    /// different charted class).
    cable: Option<(&'a Grid, f64 /* weight */)>,
    /// Flat zone-membership AVOID term for the "navigate with general
    /// caution" family (`ACHARE`/`CTNARE`, plus permitted-transit
    /// `RESARE`/`MIPARE` — `routing::preference::build_caution_union`).
    /// Same shape as `tss`/`buoyage`/`cable`.
    caution: Option<(&'a Grid, f64 /* weight */)>,
    /// Flat zone-membership AVOID term for a low-confidence-survey
    /// `M_QUAL`/`CATZOC` zone (`routing::preference::
    /// build_low_confidence_survey_union`) — same shape as `tss`/
    /// `buoyage`/`cable`/`caution`, a pure AVOID term with no distance
    /// falloff. See that function's own docs for the CATZOC threshold and
    /// why this is a flat, everywhere-charted membership cost rather than
    /// a "close quarters" geometric detector this codebase has no other
    /// concept of.
    survey: Option<(&'a Grid, f64 /* weight */)>,

    /// `1.0 - fairway_preference_weight` (or `1.0` when fairway
    /// preference is off) — see [`octile_heuristic`]'s own docs for the
    /// admissibility proof this number is load-bearing for. Precomputed
    /// once per search attempt rather than derived at call time, so
    /// `search_grid`'s hot heuristic closure does one multiply, not an
    /// `Option` match plus a subtraction, per node.
    heuristic_scale: f64,
}

/// The ONE per-cell cost multiplier every caller (`search_grid`'s edge
/// cost AND heuristic scale's own proof, `simplify_path`'s
/// `segment_penalized_cost_m`) computes through — see [`CostModel`]'s own
/// docs for why sharing this matters.
///
/// `(1 + shallow_penalty) * (1 + lateral_margin_penalty) * (1 +
/// tss_penalty) * (1 + buoyage_penalty) * (1 + cable_penalty) * (1 +
/// caution_penalty) * (1 + survey_penalty) * (1 - fairway_discount)` —
/// where `fairway_discount`
/// is the UNIONED preferred-route (`FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT`)
/// zone, one flat discount for however many of those classes' own charted
/// geometry overlaps a given cell, never stacked (see
/// `routing::preference`'s own docs): `shallow_penalty`/
/// `lateral_margin_penalty` both decay with distance to the nearest hard
/// hazard (the SAME [`shallow_penalty`] shape, just two independently
/// radius/weighted terms over it — see [`CostModel::lateral_margin`]'s own
/// docs); `tss_penalty`/`buoyage_penalty`/`cable_penalty`/
/// `caution_penalty`/`survey_penalty`/`fairway_discount` are each a FLAT
/// `weight` when
/// `cell` is inside that layer's own membership grid (tested via
/// [`Grid::filled`] — NOT
/// [`Grid::blocked`]; see that method's own docs for why the out-of-range
/// convention must differ here), `0` otherwise. Floored at
/// [`MIN_MULTIPLIER`].
fn combined_multiplier(cell: (i32, i32), model: &CostModel) -> f64 {
    let shallow = model.shallow.map_or(0.0, |(field, radius_m, weight)| {
        shallow_penalty(
            field.dist_m(cell.0, cell.1, model.cell_size_m),
            radius_m,
            weight,
        )
    });
    let lateral_margin = model
        .lateral_margin
        .map_or(0.0, |(field, radius_m, weight)| {
            shallow_penalty(
                field.dist_m(cell.0, cell.1, model.cell_size_m),
                radius_m,
                weight,
            )
        });
    let tss = model.tss.map_or(0.0, |(grid, weight)| {
        if grid.filled(cell.0, cell.1) {
            weight
        } else {
            0.0
        }
    });
    let buoyage = model.buoyage.map_or(0.0, |(grid, weight)| {
        if grid.filled(cell.0, cell.1) {
            weight
        } else {
            0.0
        }
    });
    let fairway = model.fairway.map_or(0.0, |(grid, weight)| {
        if grid.filled(cell.0, cell.1) {
            weight
        } else {
            0.0
        }
    });
    let cable = model.cable.map_or(0.0, |(grid, weight)| {
        if grid.filled(cell.0, cell.1) {
            weight
        } else {
            0.0
        }
    });
    let caution = model.caution.map_or(0.0, |(grid, weight)| {
        if grid.filled(cell.0, cell.1) {
            weight
        } else {
            0.0
        }
    });
    let survey = model.survey.map_or(0.0, |(grid, weight)| {
        if grid.filled(cell.0, cell.1) {
            weight
        } else {
            0.0
        }
    });
    ((1.0 + shallow)
        * (1.0 + lateral_margin)
        * (1.0 + tss)
        * (1.0 + buoyage)
        * (1.0 + cable)
        * (1.0 + caution)
        * (1.0 + survey)
        * (1.0 - fairway))
        .max(MIN_MULTIPLIER)
}

/// Admissible (never overestimates) for [`ORTHO_COST`]/[`DIAG_COST`]: the
/// true minimum grid-step cost between two cells `dx`/`dy` apart is
/// `min(dx,dy)` diagonal steps plus the remaining `|dx-dy|` orthogonal
/// ones, which is exactly this — the standard octile-distance heuristic.
///
/// **Stays valid for the WEIGHTED search too, via [`CostModel::
/// heuristic_scale`]** — proof, not assertion, since a fairway DISCOUNT
/// (`combined_multiplier` can go below `1.0`) breaks the simpler "weighted
/// cost is always >= unweighted cost" argument a pure-penalty-only search
/// (shallow-water/TSS alone) could rely on unmodified. This still holds
/// after `fairway` was broadened from `FAIRWY` alone to the UNIONED
/// `FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT` preferred-route family
/// (`routing::preference::build_preferred_route_union`): the proof below
/// depends only on `CostModel` having exactly ONE `fairway` field capped
/// at one weight, never on which S-57 classes fed its ring set, and the
/// four classes are unioned into that ONE ring set at the geometry layer
/// (a real `geo::unary_union`, not two independent grids) specifically so
/// "double-preferenced" water (e.g. a RECTRC running through a FAIRWY)
/// still reads as ordinary single-zone membership here — not a second,
/// independently-weighted discount that could multiply the floor down to
/// `(1 - W)^2` and invalidate this bound. See
/// `heuristic_scale_keeps_the_weighted_search_exact_through_an_overlapping_
/// preferred_route_union` below for the brute-force regression pinning
/// this specifically.
///
/// `combined_multiplier`'s minimum possible value, over every cell
/// anywhere in the grid, is exactly `1 - fairway_preference_weight` — the
/// shallow/lateral-margin/TSS/buoyage/cable/caution/survey terms only ever
/// raise
/// it (each is a `(1 + weight)` or `(1 + distance-graded penalty)` factor,
/// never below `1.0`), and the fairway term is the ONLY one that can lower
/// it, by at most its own configured weight. Adding `cable`/`caution` (two
/// more flat AVOID terms, same shape as `tss`/`buoyage`) changes nothing
/// about this bound — confirmed against this proof directly, not assumed
/// by analogy: they multiply the SAME way `tss`/`buoyage` already do,
/// contributing `(1 + weight) >= 1.0` each, so the product's floor is
/// still driven entirely by the one `(1 - fairway)` factor. `survey` (the
/// low-confidence-survey `M_QUAL`/`CATZOC` term) is the SAME shape again —
/// see `survey_avoidance_needs_no_heuristic_change_to_stay_exact` below for
/// its own instance of the identical brute-force-verified regression. See
/// `cable_and_caution_avoidance_need_no_heuristic_change_to_stay_exact`
/// below for the same brute-force-verified regression style
/// `heuristic_scale_keeps_the_weighted_search_exact` already uses for the
/// fairway discount, applied here to confirm a pure-AVOID addition needs
/// (and gets) none. `search_grid`'s edge cost is
/// `(base_cost * multiplier).ceil()`, so every weighted edge cost is `>=
/// base_cost * (1 - fairway_preference_weight)`, always. Chaining: for
/// any path, `weighted_cost >= (1 - W) * unweighted_cost >= (1 - W) *
/// unweighted_optimal_cost >= (1 - W) * octile_heuristic(n)` (the last
/// step is this function's OWN existing, unmodified admissibility proof).
/// So `octile_heuristic(n) * (1 - W)`, floored (`search_grid`'s heuristic
/// closure — flooring only shrinks the bound, never risks exceeding it),
/// is a valid lower bound on the weighted-optimal cost from any node.
///
/// This is merely ADMISSIBLE, not strictly CONSISTENT (two nodes' scaled
/// heuristics can disagree by up to 1, from independent flooring) — A*
/// still finds the exact optimum regardless, confirmed against the
/// vendored `pathfinding` 4.15.0 source: its main loop re-checks `cost >
/// c` on every pop and re-inserts a node when a strictly cheaper
/// cost-so-far is found (`directed/astar.rs`), a lazy-relaxation
/// implementation, not "closed once popped" — exactly what a merely-
/// admissible heuristic needs to still guarantee optimality. The only
/// practical cost is `nodes_expanded` running higher (a weaker heuristic
/// close to Dijkstra when `fairway_preference_weight` is near its own
/// ceiling) — already visible for free via `RouteDiagnostics.nodes_expanded`.
///
/// **Also stays admissible, unmodified, for [`search_grid_theta_star`]'s**
/// real-Euclidean-distance shortcut edges — see that function's own docs
/// for the short, separate proof (octile distance is an ACHIEVABLE grid
/// path length, hence always `>=` straight-line distance; nothing can beat
/// straight-line distance either, by the triangle inequality).
fn octile_heuristic(x: i32, y: i32, gx: i32, gy: i32) -> u32 {
    let dx = (x - gx).unsigned_abs() as f64;
    let dy = (y - gy).unsigned_abs() as f64;
    let (lo, hi) = if dx < dy { (dx, dy) } else { (dy, dx) };
    (lo * DIAG_COST as f64 + (hi - lo) * ORTHO_COST as f64).round() as u32
}

/// Fractional slop allowed between a candidate shortcut's own integrated
/// penalty cost and the raw sub-path's — sampling/quantization noise, not
/// a real erosion of any preference. Generous enough to never reject a
/// shortcut over noise, tight enough to still catch a real difference
/// (the regression this whole mechanism exists for measured roughly a
/// 2x cost gap between hugging and bulging, nowhere near this tolerance).
pub(crate) const SHORTCUT_COST_TOLERANCE: f64 = 0.02;

/// The cost of travelling the STRAIGHT chord `a`-`b` under `model`'s
/// preferences — length × [`combined_multiplier`], Riemann-summed over
/// samples about one grid cell wide (the same resolution the search
/// itself costed edges at). This is the metric [`simplify_path`]'s
/// shortcut check actually compares, not raw distance-to-hazard/zone
/// membership: a chord can touch the exact same WORST clearance as a
/// bulging path (their shared, fixed endpoints, most obviously) while
/// still costing far more, because the bulge spent most of its OWN
/// length in a cheaper region — a worst-case/minimum comparison cannot
/// see that difference, only an integrated one can. A real gap, not a
/// hypothetical one: caught by
/// `shallow_avoidance_bulges_away_from_a_hugged_edge_without_a_big_detour`
/// using exactly this scenario (a fixed-endpoint hug where MIN clearance
/// is identical either way, but total cost is not) — the same mechanism
/// now protects the TSS/fairway terms too, for free.
fn segment_penalized_cost_m(a: WorldXy, b: WorldXy, model: &CostModel) -> f64 {
    let dx = (b.x - a.x) as f64;
    let dy = (b.y - a.y) as f64;
    let length_world = (dx * dx + dy * dy).sqrt();
    if length_world == 0.0 {
        return 0.0;
    }
    let samples = ((length_world / model.cell_size_world).ceil().max(1.0) as usize).min(4096);
    let step_length_m = length_world / samples as f64 * (model.cell_size_m / model.cell_size_world);
    (0..samples)
        .map(|s| {
            let t = (s as f64 + 0.5) / samples as f64; // sample each sub-step's own midpoint
            let p = WorldXy::new(
                (a.x as f64 + t * dx).round() as i32,
                (a.y as f64 + t * dy).round() as i32,
            );
            let cell = world_to_cell(model.corridor, model.cell_size_world, p);
            step_length_m * combined_multiplier(cell, model)
        })
        .sum()
}

/// The raw sub-path's own accumulated penalized cost from `cells[i]` to
/// `cells[mid]` inclusive — summing [`segment_penalized_cost_m`] over
/// each consecutive pair, the same metric a candidate shortcut is judged
/// against.
fn raw_subpath_cost_m(cells: &[WorldXy], i: usize, mid: usize, model: &CostModel) -> f64 {
    cells[i..mid]
        .iter()
        .zip(&cells[i + 1..=mid])
        .map(|(&a, &b)| segment_penalized_cost_m(a, b, model))
        .sum()
}

/// Greedily shortcut `cells` (a raw grid path, world coordinates) down to
/// the few real bend points a route needs, via a furthest-visible-point
/// binary search against `hazard_rings`/`bboxes` — O(log n) `visible()`
/// tests per accepted waypoint rather than a linear scan, since a raw
/// path can run to well over a thousand cells on a large grid. Every
/// accepted segment is individually `visible()`-verified, so correctness
/// never depends on the binary search's assumption that visibility is
/// monotonic along the path — only how close to maximally simplified the
/// result ends up if that assumption doesn't quite hold somewhere.
///
/// `cost_model`, when given, adds a SECOND acceptance test alongside
/// `visible()`: a candidate shortcut must not cost measurably more (in
/// integrated preference cost, [`segment_penalized_cost_m`]) than the raw
/// sub-path it replaces already did. Load-bearing, not defensive —
/// without it, `visible()` alone happily erases a cost-motivated bulge:
/// nothing HAZARD-wise blocks the direct chord between two points on
/// open water (that's exactly why the search had to detour on COST, not
/// geometry), so an unconditional shortcut would collapse every such
/// bulge straight back to the direct line, silently making the whole
/// preference a no-op wherever it mattered most. Caught by
/// `shallow_avoidance_bulges_away_from_a_hugged_edge_without_a_big_detour`
/// — a real bug, not a hypothetical one.
fn simplify_path(
    cells: &[WorldXy],
    rings: &[Vec<WorldXy>],
    bboxes: &[RingBox],
    cost_model: Option<&CostModel>,
) -> Vec<WorldXy> {
    if cells.len() <= 2 {
        return cells.to_vec();
    }
    let mut result = vec![cells[0]];
    let mut i = 0usize;
    while i < cells.len() - 1 {
        let (mut lo, mut hi) = (i + 1, cells.len() - 1);
        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2; // bias high: find the FURTHEST visible index
            let geo_ok = visible(cells[i], cells[mid], rings, bboxes);
            let cost_ok = match cost_model {
                None => true,
                Some(model) => {
                    let candidate_cost = segment_penalized_cost_m(cells[i], cells[mid], model);
                    let raw_cost = raw_subpath_cost_m(cells, i, mid, model);
                    candidate_cost <= raw_cost * (1.0 + SHORTCUT_COST_TOLERANCE)
                }
            };
            if geo_ok && cost_ok {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        result.push(cells[lo]);
        i = lo;
    }
    result
}

/// `waypoints`' own approximate flags, one per LEG — see [`RoutePath::
/// approximate_legs`]'s own docs for why this exists and checks every
/// leg, not just [`simplify_path`]'s own shortcut candidates.
///
/// `force_start`/`force_end`: the leg touching an endpoint that was
/// ITSELF unsafe (`from_blocked`/`to_blocked` in the caller), or the
/// trailing stub `best_effort_partial_route` stitches on when no real
/// path could be found at all, is forced `true` WITHOUT a geometry
/// check. NOT because `visible` is unreliable for a fully-interior
/// segment — verified directly, not assumed: `visible`'s own trailing
/// midpoint test is provably exact for that case too, by winding-number
/// continuity (zero crossings along a segment means the winding number,
/// and therefore inside/outside status, cannot change anywhere along
/// it — including the midpoint — so a segment between two points of the
/// same hazard is always correctly caught; see this module's own test
/// `verify_legs_forces_the_end_legs_without_a_geometry_check`, which
/// found this out by trying to prove the opposite). Forced anyway, for
/// two real reasons: (1) defense in depth against a genuinely degenerate
/// case `segments_cross` cannot promise to classify consistently — a
/// query segment passing EXACTLY through a ring vertex — cheap insurance
/// given `from_blocked`/`to_blocked` are already computed regardless;
/// (2) for `best_effort_partial_route`'s own trailing stub specifically,
/// "no confirmed path was found" is DIFFERENT information from "this one
/// straight chord happens not to cross a hazard" — the bounded search
/// genuinely could not connect to `to`, which is worth flagging even on
/// the rare occasion the straight line back to it tests geometrically
/// clear. Every OTHER leg is exactly checked against `hazard_rings`/
/// `bboxes`, with no such override.
fn verify_legs(
    waypoints: &[WorldXy],
    hazard_rings: &[Vec<WorldXy>],
    bboxes: &[RingBox],
    force_start: bool,
    force_end: bool,
) -> Vec<bool> {
    let n = waypoints.len();
    if n < 2 {
        return Vec::new();
    }
    (0..n - 1)
        .map(|i| {
            if (i == 0 && force_start) || (i == n - 2 && force_end) {
                true
            } else {
                !visible(waypoints[i], waypoints[i + 1], hazard_rings, bboxes)
            }
        })
        .collect()
}

fn to_lonlat(p: WorldXy) -> (f64, f64) {
    (worldx_to_lon(p.x), worldy_to_lat(p.y))
}

/// Sum of ground-metre distances along consecutive `points`, all
/// projected relative to the same `ref_point` (any fixed point works —
/// `sm_from_world`'s projected-metre differences between two points don't
/// depend on which reference the projection used) and corrected by one
/// `ground_scale` — same "one reference latitude" call as everywhere else
/// in this module.
fn path_distance_m(points: &[WorldXy], ref_point: WorldXy, ground_scale: f64) -> f64 {
    points
        .windows(2)
        .map(|w| {
            let (x0, y0) = sm_from_world(w[0], ref_point);
            let (x1, y1) = sm_from_world(w[1], ref_point);
            ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt()
        })
        .sum::<f64>()
        * ground_scale
}

/// A deliberately coarse, optimistic land/water topology search over a
/// MUCH larger area than any per-request corridor ever covers — for the
/// case [`shortest_path_weighted`] (even with its own per-leg refinement)
/// cannot reach at all: a real detour around a whole landmass, entirely
/// outside [`CORRIDOR_PAD_CAP_M`]'s reach by construction, not a
/// resolution miss [`refine_flagged_legs`] could already fix. Found live:
/// a request from one side of a peninsula to the other, where the only
/// real water connection is ~150nm off the direct line — see
/// `ROUTING_TODO.md`'s Limfjord entry for the full story and the numbers
/// behind why this needs a SEPARATE, coarser pass rather than a bigger
/// version of the normal search (a grid wide enough to contain a detour
/// that large, at the normal search's own cell budget, would be coarser
/// than the detour's own channels — the same failure this function's own
/// optimistic rasterization exists to route around, at macro scale).
///
/// Deliberately NOT shaped like [`shortest_path_weighted`]: no soft
/// preferences, no per-leg exact re-verification, no widen ladder — this
/// answers one coarse TOPOLOGY question ("does a path exist, and roughly
/// where") as cheaply as possible. The real, safe, draft-aware routing is
/// the CALLER's job: re-run [`shortest_path_weighted`] leg by leg along
/// whatever waypoint chain this returns. A returned waypoint chain is NOT
/// itself guaranteed geometrically clear of `land_rings` at the single-
/// cell scale — the optimistic rasterization this function needs (see
/// below) can occasionally let a raw grid step graze real land where the
/// macro grid has no finer cell to fall back to, and unlike
/// [`shortest_path_weighted`] this function has no `verify_legs` of its
/// own to catch it. That is fine BY DESIGN: the caller's real per-leg
/// re-search is what actually verifies and guarantees safety, exactly as
/// it already does for any other unsafe/approximate endpoint.
///
/// `land_rings` should be LAND-ONLY (no depth-based hazard) — draft and
/// margin are questions for the fine per-leg re-search along this macro
/// path, not this coarse topology pass, which only needs to know where
/// the land is. See [`rasterize_optimistic`]'s own docs for why the grid
/// this builds is optimistic (false-OPEN, never false-CLOSED) rather than
/// [`rasterize`]'s usual conservative rule.
///
/// `box_pad_m` bounds the searched box around `from`/`to` — a FLAT
/// distance, unlike [`CORRIDOR_PAD_FACTORS`]'s pad (which scales with the
/// request's own direct distance): a landmass-scale detour has no reason
/// to grow with how far apart `from`/`to` already are. `cell_size_m`/
/// `max_dim` size the grid directly, with no [`TARGET_DIM`]-style
/// auto-picking — the caller decides the resolution/cost tradeoff
/// explicitly, since this only ever runs as a rare fallback, not on every
/// request the way the normal search does.
///
/// `None` when no macro-scale path exists either — genuinely no water
/// connects the two areas within `box_pad_m` (or the endpoints are
/// themselves in areas with no free cell nearby at this resolution) — the
/// caller's own existing straight-line-with-a-warning fallback is still
/// the honest answer in that case.
pub fn macro_route(
    from: WorldXy,
    to: WorldXy,
    land_rings: &[Vec<WorldXy>],
    box_pad_m: f64,
    cell_size_m: f64,
    max_dim: u32,
) -> Option<Vec<(f64, f64)>> {
    let corridor = Corridor::with_pad(from, to, box_pad_m);
    let relevant = corridor.relevant_rings(land_rings);
    let spec = size_grid_explicit(&corridor, cell_size_m, max_dim);
    if spec.cols == 0 || spec.rows == 0 {
        return None;
    }
    let grid = rasterize_optimistic(
        &relevant,
        &corridor,
        spec.cell_size_world,
        spec.cols,
        spec.rows,
    );

    let raw_start_cell = clamp_cell(
        world_to_cell(&corridor, spec.cell_size_world, from),
        spec.cols,
        spec.rows,
    );
    let raw_goal_cell = clamp_cell(
        world_to_cell(&corridor, spec.cell_size_world, to),
        spec.cols,
        spec.rows,
    );
    let start_cell = nearest_free_cell(&grid, raw_start_cell)?;
    let goal_cell = nearest_free_cell(&grid, raw_goal_cell)?;

    let (raw_path, _expansions) = search_grid(&grid, start_cell, goal_cell, None)?;
    let mut cells_world: Vec<WorldXy> = raw_path
        .iter()
        .map(|&c| cell_center(&corridor, spec.cell_size_world, c))
        .collect();
    if let Some(first) = cells_world.first_mut() {
        *first = from;
    }
    if let Some(last) = cells_world.last_mut() {
        *last = to;
    }

    let relevant_bboxes: Vec<RingBox> = relevant.iter().map(|r| RingBox::of(r)).collect();
    let simplified = simplify_path(&cells_world, &relevant, &relevant_bboxes, None);
    Some(simplified.iter().map(|&p| to_lonlat(p)).collect())
}

/// The shortest hazard-avoiding path from `from` to `to` — routing right
/// up to the hazard union's own boundary and stitching on a straight
/// line for whatever it genuinely can't reach (`from`/`to` itself inside
/// a hazard, or a fully enclosing boundary between them with no gap —
/// see [`Corridor::relevant_rings`]'s widen ladder, tried at up to three
/// corridor sizes, and [`best_effort_partial_route`] for the very last
/// resort), rather than giving up outright — see [`RoutePath`]'s own
/// `approximate_legs` for how a caller tells a partial result (and
/// exactly which leg) from a fully exact one. `None` only in the genuinely
/// pathological case where not even ONE free cell exists anywhere near
/// either point — no water at all to route through. Equivalent to
/// [`shortest_path_weighted`] with the shallow-water preference off — see
/// that function's own docs for what turning it on changes.
pub fn shortest_path(
    from: WorldXy,
    to: WorldXy,
    hazard_rings: &[Vec<WorldXy>],
) -> Option<RoutePath> {
    shortest_path_weighted(
        from,
        to,
        hazard_rings,
        0.0,
        0.0,
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        0.0,
        false,
    )
}

/// [`shortest_path`], plus nine optional SOFT preferences layered on the
/// same search: water further from the hazard union's own (small, fixed-
/// floor-buffered) boundary in general, water at least the PREFERRED
/// lateral margin from it specifically, water away from TSS-family zones
/// (traffic lanes, roundabouts, crossings, precautionary areas), water
/// inside the preferred-route family (a marked fairway, recommended
/// track, navigation line, or deep-water route part) that already
/// connects `from`/`to`, water on the CORRECT side of a lateral
/// buoy/beacon for the direction actually being sailed, water away from a
/// submarine cable/pipeline (`cable_rings`/`cable_avoidance_weight`),
/// water away from an anchorage/caution/permitted-transit-restricted area
/// (`caution_rings`/`caution_area_avoidance_weight` —
/// `routing::preference::build_cable_union`/`build_caution_union`, see
/// those functions' own docs for exactly which S-57 classes and why they
/// are two separate weights rather than one), water away from a charted
/// low-confidence-survey `M_QUAL`/`CATZOC` zone (`survey_rings`/
/// `low_confidence_survey_avoidance_weight` —
/// `routing::preference::build_low_confidence_survey_union`), and a
/// per-heading-change
/// TURN cost (`turn_cost_weight`, see [`search_grid_with_turn_cost`]'s own
/// docs — structurally different from the other eight, see below). Every
/// weight/radius defaulting to `0.0` is OFF, byte-identical to
/// [`shortest_path`] (matching `RoutingConfig`'s own defaults,
/// `mivnav.features.routing.config`).
///
/// **Shallow-water / lateral-margin** (the latter added #owqqcdqe,
/// 2026-08-10 — see [`LATERAL_MARGIN_PREFERENCE_WEIGHT`]'s own docs for
/// why `lateral_margin_m` moved from a hard buffer baked into the hazard
/// union itself to a soft preference here instead): every free grid
/// cell's distance to the nearest blocked cell
/// ([`distance_field::DistanceField`], a Felzenszwalb–Huttenlocher exact
/// 2D transform) feeds [`shallow_penalty`] — full weight right at the
/// hazard union's own small, fixed hard floor (never zero — a route can
/// still never touch charted danger or cross land), decaying LINEARLY to
/// zero by `shallow_avoidance_radius_m`/`lateral_margin_radius_m`
/// respectively, beyond it. Two independent terms over the SAME distance
/// field, not one: `lateral_margin_radius_m` is always on (a FIXED
/// weight, [`LATERAL_MARGIN_PREFERENCE_WEIGHT`]) the instant it is
/// nonzero, so a configured margin applies with no separate "and also
/// turn a preference on" step; `shallow_avoidance_weight`/`_radius_m`
/// remain the existing, separately user-dialable, OFF-by-default extra
/// pull for a caller who wants more than the preferred margin alone.
///
/// **TSS avoidance / fairway (preferred-route) preference /
/// buoyage-side avoidance / cable avoidance / caution-area avoidance /
/// low-confidence-survey avoidance**:
/// unlike shallow-water, these are FLAT, zone-MEMBERSHIP costs, not
/// distance-graded — a TSS lane, a preferred-route zone
/// (`FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT`, unioned into ONE ring set by
/// `routing::preference::build_preferred_route_union` — see that module's
/// own docs for why all four share one union and weight rather than each
/// getting its own), the "wrong side of this mark" region
/// `routing::buoyage::build_buoyage_penalty` computes, a submarine
/// cable/pipeline (`routing::preference::build_cable_union`), an
/// anchorage/caution/permitted-transit-restricted area
/// (`routing::preference::build_caution_union`), or a charted `M_QUAL`
/// zone whose `CATZOC` reads as low-confidence
/// (`routing::preference::build_low_confidence_survey_union`) is
/// charted/computed as "inside" or "outside", so each reuses
/// [`rasterize`] directly against its own ring set (no distance
/// transform) to build a `Grid` tested via [`Grid::filled`]. A route
/// still crosses a TSS/cable/caution/low-confidence-survey zone (or passes
/// a mark on its wrong
/// side) directly when no reasonable alternative exists — a flat per-cell
/// penalty is never a hard block, and minimizing distance actually spent
/// inside a penalized zone already tends toward a short, direct
/// crossing, with no need to parse S-57 traffic-flow attributes.
///
/// All eight of the above combine through [`combined_multiplier`] — the
/// ONE formula [`search_grid`]'s edge cost and [`simplify_path`]'s
/// shortcut check both use, never two independently maintained ones. See
/// [`octile_heuristic`]'s own docs for why the fairway DISCOUNT this
/// introduces needs (and gets) a proven heuristic-scaling fix, not just
/// an unmodified reuse of the shallow-water-only proof — buoyage/cable/
/// caution/survey are all AVOID terms like TSS, so none of them needs such
/// a fix
/// (confirmed against the proof directly, not assumed — see
/// [`octile_heuristic`]'s own docs).
///
/// **Turn cost** (`turn_cost_weight`) does NOT join `combined_multiplier`
/// at all — it is the one preference here that is HISTORY-dependent (the
/// cost of a step depends on which direction the search arrived from at
/// the PREVIOUS step), not position-dependent, so it cannot be expressed
/// as a per-cell multiplier the way every term above is. It is charged
/// entirely inside [`search_grid_with_turn_cost`], a state-expanded
/// sibling to the plain [`search_grid`] that [`search_once`] switches to
/// only when `turn_cost_weight > 0.0` — see that function's own docs for
/// the full mechanism, the admissibility argument, and the measured
/// performance cost of the state expansion.
///
/// **`theta_star`** switches the search to [`search_grid_theta_star`]
/// instead — an any-angle upgrade, see that function's own docs for the
/// full mechanism and admissibility argument — but ONLY when no soft
/// `CostModel` preference above is active at all (`search_once` checks
/// this) and takes priority over `turn_cost_weight` if a caller somehow
/// sets both. Neither restriction is a technical wall this session ran
/// out of time for so much as a deliberate scope cut: composing an
/// any-angle shortcut with a distance-graded/zone preference cost raises
/// a genuinely open design question (does the shortcut edge need
/// INTEGRATED preference cost, or is real distance alone fine?) left for
/// later, and Theta*'s own shortcuts already produce straighter paths BY
/// CONSTRUCTION — an any-angle shortcut is a zero-turn edge wherever one
/// is geometrically available — which is most of what a turn-cost penalty
/// exists to encourage in the first place, so there is little for the two
/// to usefully compose over even setting the design question aside.
///
/// After the search itself, also RECURSIVELY REFINES any leg
/// [`RoutePath::approximate_legs`] flags — see [`refine_flagged_legs`]'s own
/// docs for why a single shared grid resolution can leave a real, avoidable
/// hazard flagged as a straight-line stand-in rather than actually routed
/// around, and why re-searching just that (much shorter) leg on its own
/// tighter corridor fixes it where the whole-route corridor couldn't.
#[allow(clippy::too_many_arguments)]
pub fn shortest_path_weighted(
    from: WorldXy,
    to: WorldXy,
    hazard_rings: &[Vec<WorldXy>],
    shallow_avoidance_radius_m: f64,
    shallow_avoidance_weight: f64,
    lateral_margin_radius_m: f64,
    tss_rings: &[Vec<WorldXy>],
    tss_avoidance_weight: f64,
    fairway_rings: &[Vec<WorldXy>],
    fairway_preference_weight: f64,
    buoyage_rings: &[Vec<WorldXy>],
    buoyage_avoidance_weight: f64,
    cable_rings: &[Vec<WorldXy>],
    cable_avoidance_weight: f64,
    caution_rings: &[Vec<WorldXy>],
    caution_area_avoidance_weight: f64,
    survey_rings: &[Vec<WorldXy>],
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    theta_star: bool,
) -> Option<RoutePath> {
    refine_recursive(
        from,
        to,
        hazard_rings,
        shallow_avoidance_radius_m,
        shallow_avoidance_weight,
        lateral_margin_radius_m,
        tss_rings,
        tss_avoidance_weight,
        fairway_rings,
        fairway_preference_weight,
        buoyage_rings,
        buoyage_avoidance_weight,
        cable_rings,
        cable_avoidance_weight,
        caution_rings,
        caution_area_avoidance_weight,
        survey_rings,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        theta_star,
        0,
    )
}

/// How many times a single flagged leg may be recursively re-searched on
/// its own (much shorter, therefore finer-resolution) corridor before
/// [`refine_flagged_legs`] gives up and leaves the straight stand-in in
/// place — bounds the wasted search cost on a leg that turns out to be
/// GENUINELY unreachable (its own endpoint is the true unsafe `from`/`to`,
/// or a fully enclosing ring with no gap at any resolution) rather than
/// merely a grid-resolution miss: [`refine_flagged_legs`]'s own
/// "only accept real progress" rule already stops the waste of SPLICING a
/// non-improving result in, but a genuinely stuck leg would otherwise keep
/// re-searching an identical dead end at every depth.
const MAX_REFINE_DEPTH: u32 = 3;

/// Below this direct distance, [`bisect_run`] stops splitting — not an
/// arbitrary cutoff: at [`REFINE_PAD_FLOOR_M`]'s own floor, a run this
/// short already reaches [`MIN_CELL_M`] (the finest resolution this
/// module ever rasterizes at) on its very first search, so a run still
/// flagged at this length is genuinely unreachable, not a resolution
/// miss a smaller corridor could still fix. Worked out from
/// [`size_grid`]'s own formula: `(direct_m + 2 * REFINE_PAD_FLOOR_M) /
/// TARGET_DIM <= MIN_CELL_M` solves to `direct_m <= 400`.
const BISECT_MIN_DISTANCE_M: f64 = 400.0;

/// How many times [`bisect_run`] may halve a still-fully-flagged run
/// before giving up on that branch — a real live-request cost bound, not
/// a correctness one (`bisect_run`'s own `budget` parameter is the real
/// backstop, see its own docs): 8 halvings takes a run down from ~100km
/// to well under [`BISECT_MIN_DISTANCE_M`], covering any real macro-
/// stitched span this router would ever hand it.
const BISECT_MAX_DEPTH: u32 = 8;

/// Total leaf searches [`bisect_run`] may spend PER [`refine_flagged_legs`]
/// call, shared across every run it processes — bounds the cost of a
/// genuinely, uniformly unreachable run (hazard on every side, at every
/// scale) directly: [`BISECT_MAX_DEPTH`] alone only bounds how deep one
/// branch can go, not the up-to-`2^depth` total searches a fully
/// adversarial run could otherwise reach at that depth.
///
/// 128, not a smaller number, on real measurement, not a guess: a
/// synthetic dual-wall test (both sides of the run genuinely hard, a
/// symmetric worst case a single real bridge crossing rarely is) needed
/// more than 32 to resolve BOTH sides rather than exhausting budget on
/// whichever branch happened to recurse first — `first`/`second` are
/// tried in a fixed order, sharing one pool, so an asymmetric split can
/// starve the second branch of budget the first one didn't actually need.
/// Tried smaller values (16, 64) against the real live Aggersund case
/// this whole mechanism exists for and got WORSE completeness at both —
/// not because a lower budget is cheaper here (measured: total request
/// cost across 16/64/128 stayed in the same tens-of-seconds range
/// regardless — see below), only less lucky about which branch it spent
/// budget on. This value is deliberately generous rather than tightly
/// tuned for that reason: on this measurement, a smaller budget bought no
/// real speed, only a real chance of worse correctness.
///
/// **Cost is real but not new**: on the actual installed Danish chart set
/// (a genuinely long, complex macro-stitched route through a narrow real
/// strait), total request latency measured 25-45 seconds — but that
/// range was ALREADY true before `bisect_run` existed at all (the
/// pre-existing macro-route sub-leg searches this feeds into are the
/// dominant cost, confirmed directly: the SAME multi-second
/// `resimplify_macro_stitch` step this fallback lives inside was already
/// the slowest single step in a trace captured before this round's own
/// changes). `bisect_run` turns a silent, total failure (a bare 2-point
/// straight line, no indication anything was even attempted) into real,
/// honestly-flagged partial progress on the SAME already-slow request —
/// a correctness fix, not a performance one; the macro-route pipeline's
/// own live-coastline cost is real, pre-existing, and out of scope here.
const BISECT_TOTAL_BUDGET: u32 = 128;

/// One search-and-refine round: [`search_once`] (the whole widen-ladder +
/// [`best_effort_partial_route`] search this module always did), then, if
/// budget remains and the result still has a flagged leg,
/// [`refine_flagged_legs`] on it. The recursion bottoms out either when
/// `depth` reaches [`MAX_REFINE_DEPTH`] or when nothing is flagged any
/// more — whichever comes first.
#[allow(clippy::too_many_arguments)]
fn refine_recursive(
    from: WorldXy,
    to: WorldXy,
    hazard_rings: &[Vec<WorldXy>],
    shallow_avoidance_radius_m: f64,
    shallow_avoidance_weight: f64,
    lateral_margin_radius_m: f64,
    tss_rings: &[Vec<WorldXy>],
    tss_avoidance_weight: f64,
    fairway_rings: &[Vec<WorldXy>],
    fairway_preference_weight: f64,
    buoyage_rings: &[Vec<WorldXy>],
    buoyage_avoidance_weight: f64,
    cable_rings: &[Vec<WorldXy>],
    cable_avoidance_weight: f64,
    caution_rings: &[Vec<WorldXy>],
    caution_area_avoidance_weight: f64,
    survey_rings: &[Vec<WorldXy>],
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    theta_star: bool,
    depth: u32,
) -> Option<RoutePath> {
    // The top-level request (`depth == 0`) keeps the full floor — a real
    // hop that genuinely is only a few metres end to end still gets a real
    // corridor (`CORRIDOR_PAD_FLOOR_M`'s own docs). Any recursive re-search
    // `refine_flagged_legs` runs (`depth > 0`) is over a flagged run's own
    // two endpoints — already real bend points of an almost-working route,
    // not a raw request — so it gets the smaller `REFINE_PAD_FLOOR_M`
    // instead, unlocking the finer resolution a short flagged run needs
    // (see that constant's own docs for the measurement behind this).
    let pad_floor_m = if depth == 0 {
        CORRIDOR_PAD_FLOOR_M
    } else {
        REFINE_PAD_FLOOR_M
    };
    let route = search_once(
        from,
        to,
        hazard_rings,
        shallow_avoidance_radius_m,
        shallow_avoidance_weight,
        lateral_margin_radius_m,
        tss_rings,
        tss_avoidance_weight,
        fairway_rings,
        fairway_preference_weight,
        buoyage_rings,
        buoyage_avoidance_weight,
        cable_rings,
        cable_avoidance_weight,
        caution_rings,
        caution_area_avoidance_weight,
        survey_rings,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        theta_star,
        pad_floor_m,
    )?;
    if depth + 1 >= MAX_REFINE_DEPTH || !route.approximate_legs.iter().any(|&flagged| flagged) {
        return Some(route);
    }
    Some(refine_flagged_legs(
        route,
        hazard_rings,
        shallow_avoidance_radius_m,
        shallow_avoidance_weight,
        lateral_margin_radius_m,
        tss_rings,
        tss_avoidance_weight,
        fairway_rings,
        fairway_preference_weight,
        buoyage_rings,
        buoyage_avoidance_weight,
        cable_rings,
        cable_avoidance_weight,
        caution_rings,
        caution_area_avoidance_weight,
        survey_rings,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        theta_star,
        depth,
    ))
}

/// For every maximal RUN of flagged legs in `route.approximate_legs`,
/// re-search just that run's own two endpoints (`route.waypoints[start]` →
/// `route.waypoints[end]`) via [`refine_recursive`] at `depth + 1`, and
/// splice the result in place of the straight stand-in WHEN it makes real
/// progress.
///
/// Why this can find what the original search couldn't, without changing
/// [`size_grid`]'s own budget: a flagged run's own two endpoints almost
/// always sit much closer together than the whole route's `from`/`to` —
/// they are two waypoints of an ALREADY-FOUND multi-point route, not the
/// original request's own ends — so [`Corridor::around`]/[`size_grid`]
/// naturally hand the re-search a proportionally finer `cell_size_m` for
/// the exact same [`TARGET_DIM`]/[`HARD_MAX_DIM`] budget, without this
/// function knowing anything about resolution itself. This is exactly the
/// live-found bug's own shape: a real ~63nm route already had real bend
/// waypoints from OTHER coastline nearby, and only the (much shorter) leg
/// between two of them crossed a real headland the outer, coarse corridor
/// missed.
///
/// A run that is STILL fully flagged after that direct re-search falls
/// through to [`bisect_run`] before giving up — found live: a macro-
/// stitched route's own leftover flagged run can be several NM long in
/// its own right (not the "two nearby bend points" shape the paragraph
/// above assumes), in which case `refine_recursive`'s own re-search of
/// the SAME `a`/`b` at a deeper `depth` is not actually a different
/// search at all — [`MAX_REFINE_DEPTH`]'s own docs already say so
/// ("keep re-searching an identical dead end at every depth") — a real,
/// narrow, genuinely passable gap (a ~28m opening-bridge span, in the
/// live case this was found against) needs a corridor short enough to
/// reach [`MIN_CELL_M`], which no amount of re-searching the SAME long
/// `a`/`b` pair can ever produce. `bisect_run` is what actually shortens
/// the corridor, by inserting a genuinely NEW point.
///
/// "Real progress" is deliberately narrow: a re-searched run is accepted
/// only when at least one of ITS OWN legs comes back verified exact
/// (`!approximate_legs[i]`) — a re-search that is STILL fully flagged
/// (the genuinely-unreachable case: an enclosed area, or the run touches
/// the request's own true unsafe endpoint) is rejected and the original
/// straight stub is kept untouched, rather than replacing one flagged stub
/// with a longer, differently-shaped, EQUALLY flagged one. Runs are
/// processed in REVERSE waypoint-index order so splicing an earlier run
/// never invalidates a later run's still-pending indices.
#[allow(clippy::too_many_arguments)]
pub(crate) fn refine_flagged_legs(
    route: RoutePath,
    hazard_rings: &[Vec<WorldXy>],
    shallow_avoidance_radius_m: f64,
    shallow_avoidance_weight: f64,
    lateral_margin_radius_m: f64,
    tss_rings: &[Vec<WorldXy>],
    tss_avoidance_weight: f64,
    fairway_rings: &[Vec<WorldXy>],
    fairway_preference_weight: f64,
    buoyage_rings: &[Vec<WorldXy>],
    buoyage_avoidance_weight: f64,
    cable_rings: &[Vec<WorldXy>],
    cable_avoidance_weight: f64,
    caution_rings: &[Vec<WorldXy>],
    caution_area_avoidance_weight: f64,
    survey_rings: &[Vec<WorldXy>],
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    theta_star: bool,
    depth: u32,
) -> RoutePath {
    let RoutePath {
        mut waypoints,
        diagnostics,
        mut approximate_legs,
        ..
    } = route;

    // Maximal runs of `true`, as waypoint-index pairs `(start, end)` — legs
    // `[start, end)` span `waypoints[start..=end]`.
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < approximate_legs.len() {
        if !approximate_legs[i] {
            i += 1;
            continue;
        }
        let start = i;
        while i < approximate_legs.len() && approximate_legs[i] {
            i += 1;
        }
        runs.push((start, i));
    }

    // Shared across every run this call processes (not per-run, not
    // per-`bisect_run`-call) — see [`BISECT_TOTAL_BUDGET`]'s own docs for
    // why a per-run budget alone would not actually bound worst-case cost.
    let mut bisect_budget = BISECT_TOTAL_BUDGET;

    for &(start, end) in runs.iter().rev() {
        let (lon_a, lat_a) = waypoints[start];
        let (lon_b, lat_b) = waypoints[end];
        let a = lat_lon_to_world(lat_a, lon_a);
        let b = lat_lon_to_world(lat_b, lon_b);

        // First choice: re-search past the run's own endpoints, a short
        // way along the exact chain on either side — see
        // `SEAM_EXTENSION_M`'s docs for why aiming at `a`/`b` themselves
        // can bake in a backtrack no later shortcut pass can remove.
        let world: Vec<WorldXy> = waypoints
            .iter()
            .map(|&(lon, lat)| lat_lon_to_world(lat, lon))
            .collect();
        let (keep_len, a_ext) = extend_along_exact_legs(&world, &approximate_legs, start, false);
        let (keep_from, b_ext) = extend_along_exact_legs(&world, &approximate_legs, end, true);
        if a_ext != a || b_ext != b {
            let extended = refine_recursive(
                a_ext,
                b_ext,
                hazard_rings,
                shallow_avoidance_radius_m,
                shallow_avoidance_weight,
                lateral_margin_radius_m,
                tss_rings,
                tss_avoidance_weight,
                fairway_rings,
                fairway_preference_weight,
                buoyage_rings,
                buoyage_avoidance_weight,
                cable_rings,
                cable_avoidance_weight,
                caution_rings,
                caution_area_avoidance_weight,
                survey_rings,
                low_confidence_survey_avoidance_weight,
                turn_cost_weight,
                theta_star,
                depth + 1,
            );
            // Accept only a fully exact result, bar the forced stub at a
            // chain end that is itself the true (possibly unsafe) request
            // endpoint — that stub was flagged before this ran and stays
            // flagged whatever the search does. Anything else falls back
            // to the plain `a`→`b` re-search below, unchanged.
            let last_leg = waypoints.len() - 2;
            let accepted = extended.filter(|sub| {
                let n = sub.approximate_legs.len();
                sub.approximate_legs
                    .iter()
                    .enumerate()
                    .all(|(i, &flagged)| {
                        !flagged
                            || (i == 0 && keep_len == 0)
                            || (i == n - 1 && keep_from > last_leg + 1)
                    })
            });
            if let Some(sub) = accepted {
                let mut legs: Vec<bool> = approximate_legs[..keep_len].to_vec();
                legs.extend(&sub.approximate_legs);
                legs.extend(&approximate_legs[(keep_from - 1).min(approximate_legs.len())..]);
                let mut chain: Vec<(f64, f64)> = waypoints[..keep_len].to_vec();
                chain.extend(&sub.waypoints);
                chain.extend(&waypoints[keep_from..]);
                waypoints = chain;
                approximate_legs = legs;
                continue;
            }
        }

        let Some(sub) = refine_recursive(
            a,
            b,
            hazard_rings,
            shallow_avoidance_radius_m,
            shallow_avoidance_weight,
            lateral_margin_radius_m,
            tss_rings,
            tss_avoidance_weight,
            fairway_rings,
            fairway_preference_weight,
            buoyage_rings,
            buoyage_avoidance_weight,
            cable_rings,
            cable_avoidance_weight,
            caution_rings,
            caution_area_avoidance_weight,
            survey_rings,
            low_confidence_survey_avoidance_weight,
            turn_cost_weight,
            theta_star,
            depth + 1,
        ) else {
            continue;
        };
        if !sub.approximate_legs.iter().any(|&flagged| !flagged) {
            // No real progress from a direct re-search of this run's own
            // `a`/`b` — before keeping the straight stub, try BISECTING
            // it: search each half independently, at its own (genuinely
            // shorter, not just deeper-`depth`) corridor. See
            // `bisect_run`'s own docs and this function's own "A run that
            // is STILL fully flagged" paragraph for why a same-`a`/`b`
            // re-search can never find what this can.
            if let Some(bisected) = bisect_run(
                a,
                b,
                hazard_rings,
                shallow_avoidance_radius_m,
                shallow_avoidance_weight,
                lateral_margin_radius_m,
                tss_rings,
                tss_avoidance_weight,
                fairway_rings,
                fairway_preference_weight,
                buoyage_rings,
                buoyage_avoidance_weight,
                cable_rings,
                cable_avoidance_weight,
                caution_rings,
                caution_area_avoidance_weight,
                survey_rings,
                low_confidence_survey_avoidance_weight,
                turn_cost_weight,
                theta_star,
                0,
                &mut bisect_budget,
            ) {
                // Placeholder flags, not a claim any of these legs are
                // exact — `resimplify_and_reverify`'s own tail below
                // recomputes `approximate_legs` fresh, from real geometry,
                // over the WHOLE assembled chain regardless of what goes
                // in here (see its own body: `verify_legs` never reads an
                // incoming flag). This splice only needs the right LENGTH.
                let leg_count = bisected.len() - 1;
                waypoints.splice(start..=end, bisected);
                approximate_legs.splice(start..end, vec![true; leg_count]);
            }
            continue;
        }
        // `sub.waypoints` starts and ends at exactly `a`/`b` (that is what
        // was searched), so splicing it in place of `waypoints[start..=end]`
        // introduces no gap or duplicate at the seam.
        waypoints.splice(start..=end, sub.waypoints);
        approximate_legs.splice(start..end, sub.approximate_legs);
    }

    // A run's own two endpoints (`start`/`end` above) are wherever the
    // ORIGINAL coarse/best-effort search happened to place a bend — a
    // grid-resolution artifact, not a genuinely necessary waypoint. Once
    // every flagged run is spliced with its own real, exact detour, a
    // point just BEFORE a splice can have a perfectly clear exact line
    // straight past its own interior, into whatever comes after — see
    // [`resimplify_and_reverify`]'s own docs for the real bug this fixes.
    resimplify_and_reverify(&waypoints, hazard_rings, diagnostics)
}

/// How far past each end of a flagged run [`refine_flagged_legs`] extends
/// its re-search, along the chain's own exact legs.
///
/// A run's endpoints are wherever the coarse search put a bend, and when
/// the coarse search started from a blocked `from` that endpoint is the
/// NUDGED start cell: the nearest free coarse cell, which need not even
/// be in the same basin. Found live (Aarhus, 2026-10-20): a boat in a
/// marina got nudged to a 120 m cell inside the neighbouring commercial
/// harbour; the fine re-search of "marina → that cell" faithfully went
/// out the marina mouth, round the breakwater and back IN to it, and the
/// coarse chain then went straight back out again. The later shortcut
/// pass can only drop existing points, and none sat at the breakwater
/// corner, so a pointless dogleg survived. Re-searching to a point
/// beyond the seam lets the fine search choose its own way out instead.
///
/// 1500 m: comfortably more than a nudge plus the coarse search's own
/// wander around it (a few 120 m cells), while the extended search's
/// corridor stays a few km across, so its cells stay ~10 m.
const SEAM_EXTENSION_M: f64 = 1500.0;

/// Walk [`SEAM_EXTENSION_M`] along `points` from `points[idx]`, forward or
/// backward, over exact legs only (stopping early at a flagged leg or the
/// chain's end). Returns the point reached and where the original chain
/// resumes: backward, `keep_len` — `points[..keep_len]` precede the
/// returned point; forward, `keep_from` — `points[keep_from..]` follow it.
/// Either way the connecting piece is part of one exact leg, so it stays
/// exact. With no exact leg to walk, the point is `points[idx]` itself.
fn extend_along_exact_legs(
    points: &[WorldXy],
    approximate_legs: &[bool],
    idx: usize,
    forward: bool,
) -> (usize, WorldXy) {
    let ground_scale = worldy_to_lat(points[idx].y).to_radians().cos();
    let mut remaining = SEAM_EXTENSION_M;
    let mut i = idx;
    loop {
        let leg = if forward {
            if i >= approximate_legs.len() || approximate_legs[i] {
                return (i + 1, points[i]);
            }
            i
        } else {
            if i == 0 || approximate_legs[i - 1] {
                return (i, points[i]);
            }
            i - 1
        };
        let (p, q) = if forward {
            (points[leg], points[leg + 1])
        } else {
            (points[leg + 1], points[leg])
        };
        let (dx, dy) = sm_from_world(q, p);
        let length_m = (dx * dx + dy * dy).sqrt() * ground_scale;
        if length_m > remaining {
            let t = remaining / length_m;
            let at = WorldXy::new(
                (p.x as f64 + t * (q.x - p.x) as f64).round() as i32,
                (p.y as f64 + t * (q.y - p.y) as f64).round() as i32,
            );
            return (leg + 1, at);
        }
        remaining -= length_m;
        i = if forward { i + 1 } else { i - 1 };
    }
}

/// Try to resolve a run that [`refine_flagged_legs`] found STILL fully
/// flagged after a direct re-search, by BISECTING it: insert the
/// midpoint of `a`/`b` and search each half independently, at its own
/// (genuinely shorter) corridor — repeating recursively wherever a half
/// is itself still fully flagged. Same reason a human manually splitting
/// a too-long request into smaller segments finds a route this module's
/// own same-`a`/`b` retry (bounded by [`MAX_REFINE_DEPTH`]) cannot: found
/// live, a real macro-stitched route through a narrow Danish strait
/// (Aggersund) — the only actually passable gap was a ~28m opening-bridge
/// span, and the flagged run left over after stitching spanned several
/// nautical miles, far too long for [`size_grid`]'s own corridor-
/// proportional resolution to ever resolve a 28m feature within, no
/// matter how many times the SAME long `a`/`b` pair was re-searched.
///
/// Returns the WAYPOINTS to splice in place of the run — never
/// `approximate_legs`/`distance_m`: [`refine_flagged_legs`]'s own tail
/// (`resimplify_and_reverify`) recomputes both EXACTLY over the whole
/// assembled chain regardless of what this returns, so this only needs
/// to decide which extra points are worth handing it. `None` when
/// bisection made no real progress at all (a genuinely enclosed area, or
/// the run's own endpoint touches the request's true unsafe `from`/`to`)
/// — the run stays exactly the straight stub it already was, the SAME
/// "no improvement, don't replace" rule [`refine_flagged_legs`] already
/// applies to its own direct re-search.
///
/// A half that itself makes no progress contributes its own straight
/// stub (its endpoint alone) rather than being dropped — "real progress"
/// on ONE half of a run is still real progress, the same partial-credit
/// shape [`refine_flagged_legs`]'s "real progress" rule already accepts
/// leg by leg.
///
/// `depth`/[`BISECT_MAX_DEPTH`] bound how many times ONE branch may
/// halve; `budget`/[`BISECT_TOTAL_BUDGET`] (shared across every run and
/// every branch within one top-level [`refine_flagged_legs`] call —
/// threaded by `&mut` reference for exactly that reason) bounds the
/// TOTAL leaf searches, which depth alone does not: a fully adversarial
/// run (hazard on every side, at every scale) would otherwise double its
/// own cost at every level.
#[allow(clippy::too_many_arguments)]
fn bisect_run(
    a: WorldXy,
    b: WorldXy,
    hazard_rings: &[Vec<WorldXy>],
    shallow_avoidance_radius_m: f64,
    shallow_avoidance_weight: f64,
    lateral_margin_radius_m: f64,
    tss_rings: &[Vec<WorldXy>],
    tss_avoidance_weight: f64,
    fairway_rings: &[Vec<WorldXy>],
    fairway_preference_weight: f64,
    buoyage_rings: &[Vec<WorldXy>],
    buoyage_avoidance_weight: f64,
    cable_rings: &[Vec<WorldXy>],
    cable_avoidance_weight: f64,
    caution_rings: &[Vec<WorldXy>],
    caution_area_avoidance_weight: f64,
    survey_rings: &[Vec<WorldXy>],
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    theta_star: bool,
    depth: u32,
    budget: &mut u32,
) -> Option<Vec<(f64, f64)>> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    let route = search_once(
        a,
        b,
        hazard_rings,
        shallow_avoidance_radius_m,
        shallow_avoidance_weight,
        lateral_margin_radius_m,
        tss_rings,
        tss_avoidance_weight,
        fairway_rings,
        fairway_preference_weight,
        buoyage_rings,
        buoyage_avoidance_weight,
        cable_rings,
        cable_avoidance_weight,
        caution_rings,
        caution_area_avoidance_weight,
        survey_rings,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        theta_star,
        REFINE_PAD_FLOOR_M,
    )?;
    if !route.approximate_legs.iter().any(|&flagged| flagged) {
        // Fully resolved at this corridor already — no need to split
        // further, whether this is the top-level call or a recursive one.
        return Some(route.waypoints);
    }
    if depth + 1 >= BISECT_MAX_DEPTH {
        return None;
    }
    let (dx, dy) = sm_from_world(b, a);
    if (dx * dx + dy * dy).sqrt() < BISECT_MIN_DISTANCE_M {
        return None;
    }
    let mid = WorldXy::new(
        ((a.x as i64 + b.x as i64) / 2) as i32,
        ((a.y as i64 + b.y as i64) / 2) as i32,
    );
    let first = bisect_run(
        a,
        mid,
        hazard_rings,
        shallow_avoidance_radius_m,
        shallow_avoidance_weight,
        lateral_margin_radius_m,
        tss_rings,
        tss_avoidance_weight,
        fairway_rings,
        fairway_preference_weight,
        buoyage_rings,
        buoyage_avoidance_weight,
        cable_rings,
        cable_avoidance_weight,
        caution_rings,
        caution_area_avoidance_weight,
        survey_rings,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        theta_star,
        depth + 1,
        budget,
    );
    let second = bisect_run(
        mid,
        b,
        hazard_rings,
        shallow_avoidance_radius_m,
        shallow_avoidance_weight,
        lateral_margin_radius_m,
        tss_rings,
        tss_avoidance_weight,
        fairway_rings,
        fairway_preference_weight,
        buoyage_rings,
        buoyage_avoidance_weight,
        cable_rings,
        cable_avoidance_weight,
        caution_rings,
        caution_area_avoidance_weight,
        survey_rings,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        theta_star,
        depth + 1,
        budget,
    );
    match (first, second) {
        (None, None) => None,
        (Some(f), None) => {
            let mut out = f;
            out.push(to_lonlat(b));
            Some(out)
        }
        (None, Some(s)) => {
            let mut out = vec![to_lonlat(a)];
            out.extend(s);
            Some(out)
        }
        (Some(f), Some(s)) => {
            // `mid` is the last point of `f` and the first point of `s` —
            // include it once.
            let mut out = f;
            out.extend(s.into_iter().skip(1));
            Some(out)
        }
    }
}

/// One more exact, geometry-only shortcut pass (`simplify_path`, no
/// `cost_model`) plus a fresh exact `verify_legs`, over an ALREADY-BUILT
/// waypoint chain — used both by [`refine_flagged_legs`]'s own tail
/// (spliced-together sub-searches, all still within ONE `shortest_path`
/// call) and, exposed via pyo3 as [`crate::python::resimplify_route`],
/// by `mivnav.features.routing.routes._stitch_macro_route` (SEVERAL
/// independent `shortest_path` calls concatenated in Python — a real
/// waypoint boundary this module's own single-call refinement never
/// sees at all).
///
/// The bug this exists for (#owqqcdqe, 2026-08-10, found live against a
/// real chart): a boat exiting a marina genuinely had to round its own
/// breakwater, but wherever the ORIGINAL coarse/best-effort/macro search
/// happened to place a bend or a stitch seam is a grid-resolution or
/// macro-topology artifact, not a genuinely necessary waypoint — refining
/// "reach exactly that boundary point" can faithfully find a real path TO
/// it, a real but POINTLESS backtrack, since the onward journey never
/// needed to touch that specific point at all; no single sub-search
/// (bounded to its own two given endpoints) can ever see that on its own.
/// A whole-chain shortcut pass, working from the FULL point sequence
/// after everything is assembled, is what catches it: every existing
/// segment was already individually cost-optimized within its own
/// sub-search, so a pass with no `cost_model` here only removes an
/// artificial waypoint BOUNDARY a single sub-search had no way to see
/// past, never erodes a preference bulge genuinely earned within one.
///
/// `waypoints` are `(lon, lat)`, `hazard_rings` the UNION relevant to the
/// whole chain (every sub-search's own hazard set, concatenated — same
/// "flat concatenation is a correct input" reasoning
/// [`crate::python::shortest_path`]'s own docs already state).
/// `force_start`/`force_end` are always `false`: a genuinely unsafe TRUE
/// endpoint is still caught by exact geometry alone (`verify_legs`'s own
/// docs — the force flags exist as defense in depth for
/// [`best_effort_partial_route`]'s specific "no confirmed path" case, not
/// because plain geometry misses it) — a caller that already knows one
/// end is a genuine unsafe stub (`_stitch_macro_route`'s own leading/
/// trailing run, if any) gets that leg re-flagged correctly regardless,
/// by geometry, not by this function trusting anything it was told.
///
/// Panics if `waypoints` is empty — every real caller already has at
/// least the two original request endpoints; an empty chain is a caller
/// bug, not a routing outcome to represent.
pub(crate) fn resimplify_and_reverify(
    waypoints: &[(f64, f64)],
    hazard_rings: &[Vec<WorldXy>],
    diagnostics: RouteDiagnostics,
) -> RoutePath {
    assert!(
        !waypoints.is_empty(),
        "resimplify_and_reverify: empty waypoint chain"
    );
    let world_points: Vec<WorldXy> = waypoints
        .iter()
        .map(|&(lon, lat)| lat_lon_to_world(lat, lon))
        .collect();
    let hazard_bboxes: Vec<RingBox> = hazard_rings.iter().map(|r| RingBox::of(r)).collect();
    let simplified = if world_points.len() <= EXHAUSTIVE_SHORTCUT_MAX_POINTS {
        shortcut_chain_exhaustive(&world_points, hazard_rings, &hazard_bboxes)
    } else {
        simplify_path(&world_points, hazard_rings, &hazard_bboxes, None)
    };
    let approximate_legs = verify_legs(&simplified, hazard_rings, &hazard_bboxes, false, false);

    let ref_point = simplified[0];
    let ground_scale = worldy_to_lat(ref_point.y).to_radians().cos();
    let distance_m = path_distance_m(&simplified, ref_point, ground_scale);

    RoutePath {
        waypoints: simplified.iter().map(|&p| to_lonlat(p)).collect(),
        distance_m,
        diagnostics,
        approximate_legs,
    }
}

/// Up to this many points, [`resimplify_and_reverify`] shortcuts with
/// [`shortcut_chain_exhaustive`] rather than [`simplify_path`]'s binary
/// search. An assembled chain is normally a few dozen points (spliced
/// refinements, macro-stitch seams), so the O(n²) worst case is a few
/// thousand `visible()` calls at most; past the cap, the binary search
/// stays as a bound on a pathological chain.
const EXHAUSTIVE_SHORTCUT_MAX_POINTS: usize = 64;

/// Greedy furthest-visible shortcutting, like [`simplify_path`] without a
/// cost model, but scanning DOWN from the chain's end instead of binary
/// searching. The binary search assumes visibility is monotonic along the
/// path, and a spliced chain breaks that exactly where it matters: a
/// refinement that backtracks into a basin and out again puts blocked
/// points in the MIDDLE of a run of visible ones. Found live (Aarhus,
/// 2026-10-20): the bend just past a marina mouth could see a waypoint
/// 18 nm on, but the binary search probed a basin point first, saw it
/// blocked, and kept a pointless backtrack bend instead.
fn shortcut_chain_exhaustive(
    points: &[WorldXy],
    rings: &[Vec<WorldXy>],
    bboxes: &[RingBox],
) -> Vec<WorldXy> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let last = points.len() - 1;
    let mut result = vec![points[0]];
    let mut i = 0usize;
    while i < last {
        let next = (i + 2..=last)
            .rev()
            .find(|&j| visible(points[i], points[j], rings, bboxes))
            .unwrap_or(i + 1);
        result.push(points[next]);
        i = next;
    }
    result
}

/// [`verify_legs`], exposed for a waypoint chain the caller supplies AS
/// IS — no [`simplify_path`] shortcutting, no waypoint dropped, added, or
/// renumbered, unlike [`resimplify_and_reverify`]. For
/// `crate::python::verify_route`: a user-drawn (or otherwise already-
/// fixed) route this crate never searched, where the caller wants to know
/// which of THOSE EXACT legs cross `hazard_rings`' own union — not a
/// resimplified stand-in whose leg numbering could silently drift from
/// the input's.
///
/// `force_start`/`force_end` are not exposed — always `false`: there is
/// no "this endpoint is a forced stub" fact for a caller-supplied chain
/// to defend in depth for (contrast [`resimplify_and_reverify`]'s own
/// internal callers, which sometimes do know that). Every leg gets the
/// same ordinary, exact geometry check.
///
/// `waypoints` are `(lon, lat)`. Returns one `bool` per LEG
/// (`waypoints.len() - 1`), or an empty `Vec` on fewer than 2 waypoints —
/// nothing to check, not an error.
pub(crate) fn verify_route_legs(
    waypoints: &[(f64, f64)],
    hazard_rings: &[Vec<WorldXy>],
) -> Vec<bool> {
    if waypoints.len() < 2 {
        return Vec::new();
    }
    let world_points: Vec<WorldXy> = waypoints
        .iter()
        .map(|&(lon, lat)| lat_lon_to_world(lat, lon))
        .collect();
    let hazard_bboxes: Vec<RingBox> = hazard_rings.iter().map(|r| RingBox::of(r)).collect();
    verify_legs(&world_points, hazard_rings, &hazard_bboxes, false, false)
}

/// [`refine_flagged_legs`], exposed for an ALREADY-ASSEMBLED
/// `(waypoints, approximate_legs)` chain a caller built OUTSIDE this
/// module — for `mivnav.features.routing.routes._stitch_macro_route`
/// (via `chartcore.resimplify_route`'s sibling, `chartcore.refine_route`),
/// whose several independent `shortest_path` calls (one per consecutive
/// macro-waypoint pair) get concatenated in PYTHON.
///
/// Why this, not just [`resimplify_and_reverify`] alone (#owqqcdqe,
/// 2026-08-10, found live, the second half of the same bug):
/// `resimplify_and_reverify` is a pure geometric SHORTCUT pass — it can
/// only DROP an existing waypoint when two OTHER existing waypoints
/// already see each other directly, never propose a genuinely NEW bend
/// point. A macro-stitch seam that is flagged because BOTH adjacent
/// sub-legs independently hit a real, small, local hazard right at their
/// shared macro waypoint (found live: a shallow spot at the tip of a
/// real headland) needs an actual RE-SEARCH of that stretch to find the
/// small real detour around it — exactly what [`refine_flagged_legs`]
/// already does within a single `shortest_path` call, now run once more
/// across the STITCHED chain, so a real detour a macro-level seam hides
/// gets found instead of just accepted as an approximate stub with
/// nothing dropped to shortcut past.
///
/// `waypoints.len() - 1` must equal `approximate_legs.len()`; the
/// pyo3 binding validates this instead of panicking on a caller mistake.
#[allow(clippy::too_many_arguments)]
pub(crate) fn refine_stitched_route(
    waypoints: Vec<(f64, f64)>,
    approximate_legs: Vec<bool>,
    hazard_rings: &[Vec<WorldXy>],
    shallow_avoidance_radius_m: f64,
    shallow_avoidance_weight: f64,
    lateral_margin_radius_m: f64,
    tss_rings: &[Vec<WorldXy>],
    tss_avoidance_weight: f64,
    fairway_rings: &[Vec<WorldXy>],
    fairway_preference_weight: f64,
    buoyage_rings: &[Vec<WorldXy>],
    buoyage_avoidance_weight: f64,
    cable_rings: &[Vec<WorldXy>],
    cable_avoidance_weight: f64,
    caution_rings: &[Vec<WorldXy>],
    caution_area_avoidance_weight: f64,
    survey_rings: &[Vec<WorldXy>],
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    theta_star: bool,
) -> RoutePath {
    let route = RoutePath {
        waypoints,
        distance_m: 0.0, // recomputed unconditionally by `resimplify_and_reverify`'s own tail
        diagnostics: RouteDiagnostics {
            used_direct_line: false,
            grid_cols: 0,
            grid_rows: 0,
            cell_size_m: 0.0,
            blocked_cells: 0,
            nodes_expanded: 0,
            corridor_widen_attempts: 0,
        },
        approximate_legs,
    };
    if !route.approximate_legs.iter().any(|&flagged| flagged) {
        // No flagged run at all — `refine_flagged_legs` itself already
        // still runs the geometric resimplify pass on a no-op input, but
        // skip the (pointless) run-finding scan and call straight through
        // to what it would end up doing anyway.
        return resimplify_and_reverify(&route.waypoints, hazard_rings, route.diagnostics);
    }
    refine_flagged_legs(
        route,
        hazard_rings,
        shallow_avoidance_radius_m,
        shallow_avoidance_weight,
        lateral_margin_radius_m,
        tss_rings,
        tss_avoidance_weight,
        fairway_rings,
        fairway_preference_weight,
        buoyage_rings,
        buoyage_avoidance_weight,
        cable_rings,
        cable_avoidance_weight,
        caution_rings,
        caution_area_avoidance_weight,
        survey_rings,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        theta_star,
        0,
    )
}

/// The single search this module always did: the corridor-widen ladder plus
/// [`best_effort_partial_route`] — everything [`shortest_path_weighted`] did
/// before per-leg refinement existed. [`shortest_path_weighted`] itself is
/// now a thin wrapper over [`refine_recursive`]; this is the primitive that
/// wrapper (and [`refine_flagged_legs`]'s own per-leg re-searches) both
/// call. `pad_floor_m` is [`refine_recursive`]'s own choice of
/// [`CORRIDOR_PAD_FLOOR_M`] vs [`REFINE_PAD_FLOOR_M`] — see the latter's
/// docs for why a re-search gets a smaller floor than the original request.
#[allow(clippy::too_many_arguments)]
fn search_once(
    from: WorldXy,
    to: WorldXy,
    hazard_rings: &[Vec<WorldXy>],
    shallow_avoidance_radius_m: f64,
    shallow_avoidance_weight: f64,
    lateral_margin_radius_m: f64,
    tss_rings: &[Vec<WorldXy>],
    tss_avoidance_weight: f64,
    fairway_rings: &[Vec<WorldXy>],
    fairway_preference_weight: f64,
    buoyage_rings: &[Vec<WorldXy>],
    buoyage_avoidance_weight: f64,
    cable_rings: &[Vec<WorldXy>],
    cable_avoidance_weight: f64,
    caution_rings: &[Vec<WorldXy>],
    caution_area_avoidance_weight: f64,
    survey_rings: &[Vec<WorldXy>],
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    theta_star: bool,
    pad_floor_m: f64,
) -> Option<RoutePath> {
    // Exact geometry, not the grid's own coarse rasterization: is the
    // TRUE `from`/`to` itself inside the hazard union? A harbour basin
    // (or a berth) the safety-depth polygon swallows whole is the common
    // real case this exists for, not a hypothetical one — asked for
    // directly while testing from inside one. `search_grid`'s own
    // `is_walkable` already tolerates the CELL containing a safe point
    // rasterizing as blocked (single-sample-per-cell quantization,
    // unrelated to this); this is a stronger, EXACT fact about the point
    // itself, and it changes what a found route is allowed to claim: the
    // search must never silently reuse `from`/`to` verbatim as if it had
    // been reached, when it truly hasn't.
    let from_blocked = rings_contain(hazard_rings, from);
    let to_blocked = rings_contain(hazard_rings, to);

    let ground_scale = worldy_to_lat(from.y).to_radians().cos();
    let shallow_enabled = shallow_avoidance_weight > 0.0 && shallow_avoidance_radius_m > 0.0;
    // Always on — no separate weight dial, see `LATERAL_MARGIN_PREFERENCE_
    // WEIGHT`'s own docs — the instant a caller (`RoutingConfig.
    // lateral_margin_m`) asks for a preferred margin at all.
    let lateral_margin_enabled = lateral_margin_radius_m > 0.0;
    let tss_enabled = tss_avoidance_weight > 0.0;
    let fairway_enabled = fairway_preference_weight > 0.0;
    let buoyage_enabled = buoyage_avoidance_weight > 0.0;
    let cable_enabled = cable_avoidance_weight > 0.0;
    let caution_enabled = caution_area_avoidance_weight > 0.0;
    let survey_enabled = low_confidence_survey_avoidance_weight > 0.0;
    let any_preference_enabled = shallow_enabled
        || lateral_margin_enabled
        || tss_enabled
        || fairway_enabled
        || buoyage_enabled
        || cable_enabled
        || caution_enabled
        || survey_enabled;
    // Theta* is mutually exclusive with every soft `CostModel` preference
    // above THIS round (see `search_grid_theta_star`'s own docs for why —
    // an open design question, not a technical wall) — falls back to the
    // ordinary weighted search whenever any of them is active, regardless
    // of the `theta_star` request, rather than silently ignoring the
    // preference the caller actually asked to be weighted by.
    let use_theta_star = theta_star && !any_preference_enabled;
    let direct_line = |from: WorldXy, to: WorldXy| -> RoutePath {
        let (ex, ey) = sm_from_world(to, from);
        RoutePath {
            waypoints: vec![to_lonlat(from), to_lonlat(to)],
            distance_m: (ex * ex + ey * ey).sqrt() * ground_scale,
            diagnostics: RouteDiagnostics::direct(),
            // The ONE leg is exactly `visible()`-gated before this closure
            // is ever called (the fast path, and the corridor loop's own
            // "nothing relevant" shortcut) — never approximate.
            approximate_legs: vec![false],
        }
    };

    // Load-bearing, not (only) an optimisation: keeps the exact-2-point-
    // echo behaviour a grid-quantized search cannot give (see the module
    // docs). Cheap — one bbox-prefiltered segment test per ring set, not
    // O(n²).
    //
    // Skipped, per layer, once that layer is on AND something is
    // actually nearby: "clear but hugging a hazard/lane/fairway edge" is
    // EXACTLY the case each preference is meant to affect (`visible`
    // already returns true for it today), so taking the fast path there
    // would silently make that whole preference a no-op for its own main
    // use case. A layer with an EMPTY ring set is still a free,
    // behaviour-preserving fast path regardless — there is provably
    // nothing nearby for it to react to.
    //
    // NEVER taken when either endpoint is itself unsafe (`from_blocked`/
    // `to_blocked`) — not because `visible()` would fail to notice (its
    // own trailing midpoint test is provably exact even for two points
    // deep inside the same hazard with no boundary crossing between
    // them, by winding-number continuity — see `verify_legs`'s own docs,
    // corrected there after a test disproved the opposite claim this
    // comment used to make). The real reason: the fast path returns a
    // BARE 2-point `direct_line` with no approximate flag at all, so an
    // unsafe endpoint must never reach it regardless — a route starting
    // or ending inside charted danger must always come back flagged,
    // and routing through the snap-and-verify machinery below is what
    // guarantees that, not a defence against `visible()` itself.
    //
    // `turn_cost_weight` deliberately has NO entry in this list, unlike
    // every other preference above — a bare 2-point direct line already
    // has the fewest turns physically possible (zero), so unlike "clear
    // but hugging a hazard's edge" (exactly the case the OTHER
    // preferences exist to affect), there is no "clear but zigzagging"
    // case for the fast path to silently make a no-op of: taking it is
    // always at least as good, from a turn-cost standpoint, as anything
    // the full search could return.
    let all_bboxes: Vec<RingBox> = hazard_rings.iter().map(|r| RingBox::of(r)).collect();
    let take_fast_path = !from_blocked
        && !to_blocked
        && visible(from, to, hazard_rings, &all_bboxes)
        && (!shallow_enabled || hazard_rings.is_empty())
        && (!lateral_margin_enabled || hazard_rings.is_empty())
        && (!tss_enabled || tss_rings.is_empty())
        && (!fairway_enabled || fairway_rings.is_empty())
        && (!buoyage_enabled || buoyage_rings.is_empty())
        && (!cable_enabled || cable_rings.is_empty())
        && (!caution_enabled || caution_rings.is_empty())
        && (!survey_enabled || survey_rings.is_empty());
    if take_fast_path {
        return Some(direct_line(from, to));
    }

    let (dm_x, dm_y) = sm_from_world(to, from);
    let direct_m = (dm_x * dm_x + dm_y * dm_y).sqrt();
    let widen_attempts = widen_attempts_for(direct_m, pad_floor_m);

    // The last widen attempt's own built grid, kept around so
    // `best_effort_partial_route` — which always searches at the SAME
    // widest pad — doesn't rasterize a fourth, identical grid once this
    // loop's own widest attempt has already failed to connect at all.
    let mut widest_built: Option<(Corridor, Vec<Vec<WorldXy>>, GridSpec, Grid)> = None;

    for &(attempt, pad_m) in &widen_attempts {
        let corridor = Corridor::with_pad(from, to, pad_m);
        let relevant = corridor.relevant_rings(hazard_rings);
        let relevant_tss = corridor.relevant_rings(tss_rings);
        let relevant_fairway = corridor.relevant_rings(fairway_rings);
        let relevant_buoyage = corridor.relevant_rings(buoyage_rings);
        let relevant_cable = corridor.relevant_rings(cable_rings);
        let relevant_caution = corridor.relevant_rings(caution_rings);
        let relevant_survey = corridor.relevant_rings(survey_rings);
        let spec = size_grid(&corridor);
        let grid = rasterize(
            &relevant,
            &corridor,
            spec.cell_size_world,
            spec.cols,
            spec.rows,
        );

        // Cheap short-circuit for the case that forced us past the fast
        // path above (some layer on, its ring set non-empty overall) but
        // THIS corridor's own tighter filtering found nothing relevant in
        // ANY layer — the same direct line the top-level fast path would
        // have given. Guarded by `!from_blocked && !to_blocked` for the
        // same reason the fast path above is: an unsafe endpoint must
        // never be echoed back as an ordinary found route. (In practice
        // this guard never actually fires here — a hazard ring
        // containing `from`/`to` necessarily overlaps a corridor that
        // always covers at least their own bounding box — but the module
        // docs' own "widen deliberately, not by broadening blindly"
        // discipline argues for stating it rather than relying on that
        // implication silently.)
        if !from_blocked
            && !to_blocked
            && relevant.is_empty()
            && relevant_tss.is_empty()
            && relevant_fairway.is_empty()
            && relevant_buoyage.is_empty()
            && relevant_cable.is_empty()
            && relevant_caution.is_empty()
            && relevant_survey.is_empty()
        {
            return Some(direct_line(from, to));
        }

        // Stash this attempt's grid — cheap (a `Vec<bool>`/`Vec<Vec<WorldXy>>`
        // clone, not a re-rasterize) — so it's available to
        // `best_effort_partial_route` below without rebuilding, on
        // whichever attempt turns out to be the last one this loop runs.
        widest_built = Some((corridor.clone(), relevant.clone(), spec, grid.clone()));

        // Built once whenever EITHER distance-graded term needs it —
        // `shallow`/`lateral_margin` below share the SAME field (both
        // measure distance to the SAME hazard union), not two separately
        // built ones.
        let field = (shallow_enabled || lateral_margin_enabled)
            .then(|| DistanceField::build(&grid))
            .flatten();
        let tss_grid = (tss_enabled && !relevant_tss.is_empty()).then(|| {
            rasterize(
                &relevant_tss,
                &corridor,
                spec.cell_size_world,
                spec.cols,
                spec.rows,
            )
        });
        let fairway_grid = (fairway_enabled && !relevant_fairway.is_empty()).then(|| {
            rasterize(
                &relevant_fairway,
                &corridor,
                spec.cell_size_world,
                spec.cols,
                spec.rows,
            )
        });
        let buoyage_grid = (buoyage_enabled && !relevant_buoyage.is_empty()).then(|| {
            rasterize(
                &relevant_buoyage,
                &corridor,
                spec.cell_size_world,
                spec.cols,
                spec.rows,
            )
        });
        let cable_grid = (cable_enabled && !relevant_cable.is_empty()).then(|| {
            rasterize(
                &relevant_cable,
                &corridor,
                spec.cell_size_world,
                spec.cols,
                spec.rows,
            )
        });
        let caution_grid = (caution_enabled && !relevant_caution.is_empty()).then(|| {
            rasterize(
                &relevant_caution,
                &corridor,
                spec.cell_size_world,
                spec.cols,
                spec.rows,
            )
        });
        let survey_grid = (survey_enabled && !relevant_survey.is_empty()).then(|| {
            rasterize(
                &relevant_survey,
                &corridor,
                spec.cell_size_world,
                spec.cols,
                spec.rows,
            )
        });

        let cost_model = (any_preference_enabled
            && (field.is_some()
                || tss_grid.is_some()
                || fairway_grid.is_some()
                || buoyage_grid.is_some()
                || cable_grid.is_some()
                || caution_grid.is_some()
                || survey_grid.is_some()))
        .then(|| CostModel {
            corridor: &corridor,
            cell_size_world: spec.cell_size_world,
            cell_size_m: spec.cell_size_m,
            shallow: field
                .as_ref()
                .filter(|_| shallow_enabled)
                .map(|f| (f, shallow_avoidance_radius_m, shallow_avoidance_weight)),
            lateral_margin: field
                .as_ref()
                .filter(|_| lateral_margin_enabled)
                .map(|f| (f, lateral_margin_radius_m, LATERAL_MARGIN_PREFERENCE_WEIGHT)),
            tss: tss_grid.as_ref().map(|g| (g, tss_avoidance_weight)),
            fairway: fairway_grid
                .as_ref()
                .map(|g| (g, fairway_preference_weight)),
            buoyage: buoyage_grid.as_ref().map(|g| (g, buoyage_avoidance_weight)),
            cable: cable_grid.as_ref().map(|g| (g, cable_avoidance_weight)),
            caution: caution_grid
                .as_ref()
                .map(|g| (g, caution_area_avoidance_weight)),
            survey: survey_grid
                .as_ref()
                .map(|g| (g, low_confidence_survey_avoidance_weight)),
            heuristic_scale: if fairway_enabled {
                1.0 - fairway_preference_weight
            } else {
                1.0
            },
        });

        let raw_start_cell = clamp_cell(
            world_to_cell(&corridor, spec.cell_size_world, from),
            spec.cols,
            spec.rows,
        );
        let raw_goal_cell = clamp_cell(
            world_to_cell(&corridor, spec.cell_size_world, to),
            spec.cols,
            spec.rows,
        );
        // An unsafe endpoint is nudged onto the nearest free cell THIS
        // corridor's own grid can find before the search ever runs —
        // `None` here just means "try a wider corridor", exactly like a
        // failed `search_grid` call already does below. A SAFE endpoint
        // is passed through raw and unsnapped, unchanged from before:
        // `search_grid`'s own `is_walkable` override is what tolerates
        // ITS cell rasterizing as blocked despite the exact point being
        // fine, and snapping it here would move the search away from a
        // point it never needed to leave.
        let Some(start_cell) = (if from_blocked {
            nearest_free_cell(&grid, raw_start_cell)
        } else {
            Some(raw_start_cell)
        }) else {
            continue;
        };
        let Some(goal_cell) = (if to_blocked {
            nearest_free_cell(&grid, raw_goal_cell)
        } else {
            Some(raw_goal_cell)
        }) else {
            continue;
        };

        // Built once here (rather than only after the search, as before
        // this feature existed) so `search_grid_theta_star`'s own
        // `visible()` calls and `simplify_path`'s shortcut checks below
        // share exactly the same ring/bbox pairing — never two
        // independently built copies.
        let relevant_bboxes: Vec<RingBox> = relevant.iter().map(|r| RingBox::of(r)).collect();

        // Priority, when more than one of `theta_star`/`turn_cost_weight`
        // is requested at once: Theta* wins (see `use_theta_star`'s own
        // docs above and `search_grid_theta_star`'s own module docs for
        // why) — otherwise `turn_cost_weight <= 0.0` (the default,
        // matching every other preference this session) takes the exact
        // old code path, the plain unexpanded `search_grid`, so a request
        // with every one of these preferences off is byte-identical to
        // before any of them existed, at zero extra state/exploration
        // cost.
        let Some((raw_path, expansions)) = (if use_theta_star {
            search_grid_theta_star(
                &grid,
                start_cell,
                goal_cell,
                &corridor,
                spec.cell_size_world,
                &relevant,
                &relevant_bboxes,
            )
            .map(|(path, expansions, _visibility_checks)| (path, expansions))
        } else if turn_cost_weight > 0.0 {
            search_grid_with_turn_cost(
                &grid,
                start_cell,
                goal_cell,
                cost_model.as_ref(),
                turn_cost_weight,
            )
        } else {
            search_grid(&grid, start_cell, goal_cell, cost_model.as_ref())
        }) else {
            continue;
        };

        let mut cells_world: Vec<WorldXy> = raw_path
            .iter()
            .map(|&c| cell_center(&corridor, spec.cell_size_world, c))
            .collect();
        // Snap the search's own first/last cell centres to the TRUE
        // `from`/`to` only when that endpoint was safe to begin with —
        // when it was blocked, the search's own start/goal cell centre
        // IS the real endpoint of the exact portion; the true (unsafe)
        // point is stitched on separately below as its own straight
        // stub, never substituted in as if the search had reached it.
        if !from_blocked {
            if let Some(first) = cells_world.first_mut() {
                *first = from;
            }
        }
        if !to_blocked {
            if let Some(last) = cells_world.last_mut() {
                *last = to;
            }
        }

        let simplified = simplify_path(
            &cells_world,
            &relevant,
            &relevant_bboxes,
            cost_model.as_ref(),
        );

        let mut waypoints_world = simplified;
        if from_blocked {
            waypoints_world.insert(0, from);
        }
        if to_blocked {
            waypoints_world.push(to);
        }
        // Re-verify EVERY leg of the final route against the real hazard
        // geometry — not just `simplify_path`'s own shortcut candidates —
        // see `RoutePath::approximate_legs`'s own docs for why: this
        // grid's own resolution (coarsened for a long corridor) can miss
        // a real, narrow hazard anywhere along the route, not only near a
        // snapped endpoint.
        let approximate_legs = verify_legs(
            &waypoints_world,
            &relevant,
            &relevant_bboxes,
            from_blocked,
            to_blocked,
        );
        let distance_m = path_distance_m(&waypoints_world, from, ground_scale);
        let blocked_cells = grid.blocked.iter().filter(|&&b| b).count() as u32;

        return Some(RoutePath {
            waypoints: waypoints_world.iter().map(|&p| to_lonlat(p)).collect(),
            distance_m,
            diagnostics: RouteDiagnostics {
                used_direct_line: false,
                grid_cols: spec.cols,
                grid_rows: spec.rows,
                cell_size_m: spec.cell_size_m,
                blocked_cells,
                nodes_expanded: expansions,
                corridor_widen_attempts: attempt as u32,
            },
            approximate_legs,
        });
    }

    // No corridor size connected the (possibly nudged) endpoints at all —
    // a genuinely enclosed area, or an unsafe endpoint whose entire
    // nearby water is itself unreachable from the other side. One more,
    // best-effort attempt: "get as close as you can with the good
    // autoroute, then a straight line for the rest" — asked for
    // directly, not a hypothetical. Hands over whichever attempt's grid
    // this loop built LAST (always the widest `pad_m` it tried — the very
    // grid `best_effort_partial_route` would otherwise rebuild from
    // scratch) so the widest corridor is rasterized once, not twice;
    // `widen_attempts` is never empty (`CORRIDOR_PAD_FACTORS` isn't), so
    // this is always `Some` by the time the loop above falls through.
    best_effort_partial_route(from, to, from_blocked, ground_scale, widest_built)
}

/// [`shortest_path_weighted`]'s LAST RESORT, run once its own corridor-
/// widen ladder is exhausted with no connection found at any size: one
/// more grid at the WIDEST corridor, UNWEIGHTED (no soft preferences —
/// this is already a degraded fallback, not the search proper), routing
/// as far as [`closest_reachable`] honestly can from a safe start toward
/// the goal, then a straight line stitched on for whatever is left.
///
/// `prebuilt`: the `(Corridor, relevant rings, GridSpec, Grid)` the
/// caller's own widen loop already built at this same widest pad — reused
/// instead of rasterizing a fourth, identical grid. Rebuilt from
/// `hazard_rings` only in the defensive `None` case (there is no live
/// caller today that passes `None`; kept so this function stays correct
/// standalone rather than relying on its one caller's own invariant).
///
/// `None` only when not even ONE free cell exists anywhere in the widest
/// corridor for the (possibly already-unsafe) start — genuinely no water
/// to route through at all, at which point the caller's own straight-
/// line-with-a-warning fallback (unchanged, `mivnav.features.routing`)
/// is the honest answer.
fn best_effort_partial_route(
    from: WorldXy,
    to: WorldXy,
    from_blocked: bool,
    ground_scale: f64,
    prebuilt: Option<(Corridor, Vec<Vec<WorldXy>>, GridSpec, Grid)>,
) -> Option<RoutePath> {
    // `None` is unreachable via the only real caller today (its own
    // `widen_attempts` is never empty — see this function's docs) — but
    // this is a request-path library called across the pyo3 boundary, so a
    // future second caller passing `None` gets an honest "nothing found"
    // rather than a panic that would abort or throw mid-request.
    let (corridor, relevant, spec, grid) = prebuilt?;

    let raw_start_cell = clamp_cell(
        world_to_cell(&corridor, spec.cell_size_world, from),
        spec.cols,
        spec.rows,
    );
    let raw_goal_cell = clamp_cell(
        world_to_cell(&corridor, spec.cell_size_world, to),
        spec.cols,
        spec.rows,
    );
    let start_cell = nearest_free_cell(&grid, raw_start_cell)?;
    // Only used as a target to get close to below — never treated as
    // reached (that would already have been found by the normal search
    // above, had it been reachable).
    let goal_cell = nearest_free_cell(&grid, raw_goal_cell).unwrap_or(raw_goal_cell);

    let raw_path = closest_reachable(&grid, start_cell, goal_cell)?;
    let mut cells_world: Vec<WorldXy> = raw_path
        .iter()
        .map(|&c| cell_center(&corridor, spec.cell_size_world, c))
        .collect();
    if !from_blocked {
        if let Some(first) = cells_world.first_mut() {
            *first = from;
        }
    }

    let relevant_bboxes: Vec<RingBox> = relevant.iter().map(|r| RingBox::of(r)).collect();
    let simplified = simplify_path(&cells_world, &relevant, &relevant_bboxes, None);

    let mut waypoints_world = simplified;
    if from_blocked {
        waypoints_world.insert(0, from);
    }
    waypoints_world.push(to);

    // The tail is ALWAYS a stub here (the reached endpoint is never the
    // true `to` — see this function's own docs), so `force_end = true`
    // unconditionally; every other leg (including the BFS-derived middle
    // ones) gets the same real verification the main search's own success
    // path does — same reasoning, `RoutePath::approximate_legs`'s own docs.
    let approximate_legs = verify_legs(
        &waypoints_world,
        &relevant,
        &relevant_bboxes,
        from_blocked,
        true,
    );
    let distance_m = path_distance_m(&waypoints_world, from, ground_scale);
    let blocked_cells = grid.blocked.iter().filter(|&&b| b).count() as u32;

    Some(RoutePath {
        waypoints: waypoints_world.iter().map(|&p| to_lonlat(p)).collect(),
        distance_m,
        diagnostics: RouteDiagnostics {
            used_direct_line: false,
            grid_cols: spec.cols,
            grid_rows: spec.rows,
            cell_size_m: spec.cell_size_m,
            blocked_cells,
            // A BFS flood-fill, not `search_grid`'s A* — no comparable
            // per-node expansion count to report.
            nodes_expanded: 0,
            // One past the real ladder's last index — signals "the whole
            // widen ladder was exhausted" to `hazards.py`'s Timings
            // detail string, distinct from any real attempt index.
            corridor_widen_attempts: CORRIDOR_PAD_FACTORS.len() as u32,
        },
        approximate_legs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coverage::signed_area2_world;

    const LAT: f64 = 55.0;
    const LON: f64 = 12.0;

    /// A square ring, `half_side_m` metres from centre to edge, wound so
    /// its signed area is POSITIVE (a hazard-adding ring). Rough
    /// (equirectangular) but fine at test scales — same helper shape as
    /// `hazards.rs`'s own tests.
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
    fn open_water_is_a_direct_two_point_line() {
        let a = lat_lon_to_world(LAT, LON);
        let b = lat_lon_to_world(LAT + 0.01, LON + 0.01);
        let path = shortest_path(a, b, &[]).expect("nothing in the way");
        assert_eq!(path.waypoints.len(), 2);
        assert!(path.diagnostics.used_direct_line);
    }

    #[test]
    fn a_square_obstacle_forces_a_detour_around_one_corner() {
        // Start west of the square, end east of it, both at the square's
        // own latitude — a straight line would run right through it.
        let obstacle = square(LAT, LON, 200.0);
        let a = lat_lon_to_world(LAT, LON - 0.01);
        let b = lat_lon_to_world(LAT, LON + 0.01);
        let direct_m = {
            let (ax, ay) = sm_from_world(a, a);
            let (bx, by) = sm_from_world(b, a);
            ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt() * LAT.to_radians().cos()
        };
        let path =
            shortest_path(a, b, std::slice::from_ref(&obstacle)).expect("a way around exists");
        assert!(
            path.waypoints.len() > 2,
            "must bend around the square: {path:?}"
        );
        assert!(!path.diagnostics.used_direct_line);
        assert!(
            path.distance_m > direct_m,
            "a detour cannot be shorter than the blocked direct line"
        );
        // And it must not cross the obstacle: sample every leg.
        for w in path.waypoints.windows(2) {
            let p0 = lat_lon_to_world(w[0].1, w[0].0);
            let p1 = lat_lon_to_world(w[1].1, w[1].0);
            let bboxes = vec![RingBox::of(&obstacle)];
            assert!(
                visible(p0, p1, std::slice::from_ref(&obstacle), &bboxes),
                "leg {p0:?} -> {p1:?} must not cross the obstacle"
            );
        }
    }

    #[test]
    fn a_gap_between_two_obstacles_is_found() {
        // Two squares side by side with a gap between them; start north,
        // end south, straight through the gap — proves multi-obstacle
        // routing threads a real corridor rather than just going around
        // one shape's outside.
        let left = square(LAT, LON - 0.01, 150.0);
        let right = square(LAT, LON + 0.01, 150.0);
        let a = lat_lon_to_world(LAT + 0.02, LON);
        let b = lat_lon_to_world(LAT - 0.02, LON);
        let hazards = vec![left, right];
        let path = shortest_path(a, b, &hazards).expect("the gap is passable");
        for w in path.waypoints.windows(2) {
            let p0 = lat_lon_to_world(w[0].1, w[0].0);
            let p1 = lat_lon_to_world(w[1].1, w[1].0);
            let bboxes: Vec<RingBox> = hazards.iter().map(|r| RingBox::of(r)).collect();
            assert!(
                visible(p0, p1, &hazards, &bboxes),
                "leg must clear both obstacles"
            );
        }
    }

    #[test]
    fn air_draft_wiring_actually_blocks_a_route_through_a_real_too_low_bridge() {
        // Integration proof, `Cell`/`Feature` through to `shortest_path`,
        // that `air_draft_m` is really wired end to end — not just that
        // `build_hazard_index` computes the right rings in isolation
        // (`hazards.rs`'s own unit tests already cover that). A `BRIDGE`
        // area entirely surrounding the destination, charted with
        // VERCLR=10.0: an 18m mast cannot clear it (blocked, same
        // "get as close as you can" partial-route behaviour
        // `no_path_exists_through_a_fully_enclosing_ring` pins for any
        // other fully-enclosing hazard), a 5m mast can (clean, direct).
        use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry, Polygon};
        use std::collections::BTreeMap;

        let a = lat_lon_to_world(LAT, LON - 1.0); // far outside
        let b = lat_lon_to_world(LAT, LON); // dead centre of the bridge

        let mut attrs = BTreeMap::new();
        attrs.insert("VERCLR".to_string(), AttrValue::Float(10.0));
        let bridge_feature = Feature::new(
            11,
            "BRIDGE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: square(LAT, LON, 500.0),
                holes: vec![],
            }])),
        );
        let mut extent = crate::coords::Extent::invalid();
        extent.extend(&bridge_feature.extent);
        let cell = Cell {
            meta: CellMeta::default(),
            features: vec![bridge_feature],
            extent,
        };

        // A tall mast: the bridge joins the hazard union and the
        // destination becomes unreachable, same partial-route shape as
        // any other fully-enclosing hazard.
        let tall_mast_idx = crate::routing::hazards::build_hazard_index(&cell, 0.0, 0.0, 18.0);
        let blocked_route = shortest_path(
            a,
            b,
            &tall_mast_idx
                .expect("an 18m mast cannot clear a 10m bridge")
                .rings,
        )
        .expect("gets as close as it can");
        assert!(
            *blocked_route.approximate_legs.last().unwrap(),
            "an 18m mast must never be routed under a bridge charted at 10m clearance"
        );

        // A short mast: VERCLR=10.0 clears it, so build_hazard_index
        // returns nothing at all for this cell — the direct line is
        // untouched, exactly as if the bridge were never charted.
        let short_mast_idx = crate::routing::hazards::build_hazard_index(&cell, 0.0, 0.0, 5.0);
        assert!(
            short_mast_idx.is_none(),
            "a 5m mast clears a 10m bridge — must not join the hazard union at all"
        );
        let clear_route = shortest_path(a, b, &[]).expect("nothing in the way");
        assert_eq!(clear_route.waypoints.len(), 2);
        assert!(clear_route.diagnostics.used_direct_line);

        // And air_draft_m=0.0 (off, unconfigured) must ignore the same
        // bridge entirely, even though its charted clearance (10.0) is
        // far below a real boat's typical mast height — the correctness
        // requirement this whole feature is gated on.
        let off_idx = crate::routing::hazards::build_hazard_index(&cell, 0.0, 0.0, 0.0);
        assert!(
            off_idx.is_none(),
            "air_draft_m=0.0 must never consult BRIDGE/CBLOHD at all"
        );
    }

    /// A rectangle `half_lat_m`x`half_lon_m` from centre to edge, wound
    /// positive — same convention as `square`, just non-square so a route
    /// can run alongside a long edge rather than around a compact shape.
    fn rect(lat: f64, lon: f64, half_lat_m: f64, half_lon_m: f64) -> Vec<WorldXy> {
        let dlat = half_lat_m / 111_320.0;
        let dlon = half_lon_m / (111_320.0 * lat.to_radians().cos());
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

    /// The concrete "cheap gain taken, no big detour" proof: a long
    /// obstacle with an open lane along its north edge. `from`/`to` sit
    /// right along that edge — clear today (`visible` is already true,
    /// so `shallow_avoidance_weight = 0.0` must reproduce the exact
    /// direct line, unchanged), but genuinely "close to safe" in the same
    /// sense the feature exists for. With a non-zero weight the search
    /// should bulge measurably north (away from the obstacle) while
    /// barely growing total distance; with the pull's own radius made
    /// tiny, the bulge should all but vanish — proving the preference is
    /// bounded, not an unbounded detour-chaser.
    #[test]
    fn shallow_avoidance_bulges_away_from_a_hugged_edge_without_a_big_detour() {
        // Wide enough (30km) that routing around either end is obviously
        // more expensive than a small northward bulge over the middle.
        let obstacle = rect(54.9, 12.0, 6_000.0, 15_000.0); // north edge at lat ~54.954
        let a = lat_lon_to_world(54.955, 11.9); // ~110m north of the edge, inside the obstacle's own lon span
        let b = lat_lon_to_world(54.955, 12.1);
        let hazards = [obstacle];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("nothing blocks the direct line");
        assert!(
            unweighted.diagnostics.used_direct_line,
            "hugging the edge is still `visible` — must stay the fast path"
        );
        assert_eq!(unweighted.waypoints.len(), 2);

        let weighted = shortest_path_weighted(
            a,
            b,
            &hazards,
            300.0,
            2.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(
            !weighted.diagnostics.used_direct_line,
            "a non-empty hazard set must skip the fast path once weighting is on"
        );
        assert!(
            weighted.waypoints.len() > 2,
            "must bend away from the edge: {weighted:?}"
        );

        let max_north_m = weighted
            .waypoints
            .iter()
            .map(|&(_, lat)| (lat - 54.955) * 111_320.0)
            .fold(0.0_f64, f64::max);
        assert!(
            max_north_m > 50.0,
            "must bulge measurably north of the direct line, got {max_north_m}m"
        );

        let growth = weighted.distance_m / unweighted.distance_m;
        assert!(
            growth < 1.05,
            "a cheap bulge must not cost much extra distance: {growth}x"
        );

        // A tiny radius: the same pull, but with nothing left to gain
        // past a few metres — the bulge should shrink close to nothing.
        let barely_weighted = shortest_path_weighted(
            a,
            b,
            &hazards,
            1.0,
            2.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable");
        let barely_growth = barely_weighted.distance_m / unweighted.distance_m;
        assert!(
            barely_growth < growth,
            "a much smaller radius must pull less, not more: barely={barely_growth}x, full={growth}x"
        );
        assert!(
            barely_growth < 1.005,
            "a 1m radius must cost almost nothing: {barely_growth}x"
        );
    }

    /// The user decision this whole term exists for (#owqqcdqe,
    /// 2026-08-10): "make the lateral margin a preference not a hard no
    /// go, i would rather a smaller margin than go over land". Two
    /// halves: `lateral_margin_radius_m` pulls the route away when there
    /// is cheap room (same shape as `shallow_avoidance`'s own bulge
    /// test, reused deliberately — it IS the same mechanism, just a
    /// different, always-on weight/radius pair over the same distance
    /// field), and — the actual regression this test guards — it must
    /// NEVER turn a real, narrow-but-safe gap into an impassable wall
    /// the way the old hard `lateral_margin_m` buffer did.
    #[test]
    fn lateral_margin_preference_bulges_when_there_is_room_but_still_threads_a_gap_narrower_than_it(
    ) {
        // Same obstacle/bulge shape as `shallow_avoidance_bulges_away_
        // from_a_hugged_edge_without_a_big_detour` above.
        let obstacle = rect(54.9, 12.0, 6_000.0, 15_000.0); // north edge at lat ~54.954
        let a = lat_lon_to_world(54.955, 11.9);
        let b = lat_lon_to_world(54.955, 12.1);
        let hazards = [obstacle];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("nothing blocks the direct line");
        assert!(
            unweighted.diagnostics.used_direct_line,
            "hugging the edge is still `visible` — must stay the fast path when off"
        );

        let with_margin = shortest_path_weighted(
            a,
            b,
            &hazards,
            0.0,
            0.0,
            300.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just preferring more clearance");
        assert!(
            !with_margin.diagnostics.used_direct_line,
            "a preferred margin must skip the fast path once something is actually nearby"
        );
        assert!(
            with_margin.waypoints.len() > 2,
            "must bend away from the edge: {with_margin:?}"
        );
        let max_north_m = with_margin
            .waypoints
            .iter()
            .map(|&(_, lat)| (lat - 54.955) * 111_320.0)
            .fold(0.0_f64, f64::max);
        assert!(
            max_north_m > 50.0,
            "must bulge measurably north of the direct line, got {max_north_m}m"
        );

        // The actual "preference, not a hard no-go" proof: two long,
        // flanking walls (thin in longitude, so routing AROUND either
        // one costs kilometres) with a real but narrow ~200m gap between
        // them — well inside the 500m preferred margin below. Buffering
        // the hazard union by a real 500m HARD margin (`lateral_margin_m`'s
        // OLD behaviour) would close a gap this narrow outright; the new
        // soft preference must still be ABLE to thread it rather than
        // detour around either wall.
        let left = rect(LAT, LON - 0.003_132, 3_000.0, 100.0);
        let right = rect(LAT, LON + 0.003_132, 3_000.0, 100.0);
        let gap_a = lat_lon_to_world(LAT + 0.01, LON);
        let gap_b = lat_lon_to_world(LAT - 0.01, LON);
        let (dx, dy) = sm_from_world(gap_b, gap_a);
        let direct_m = (dx * dx + dy * dy).sqrt();
        let gap_hazards = [left, right];
        let through_gap = shortest_path_weighted(
            gap_a,
            gap_b,
            &gap_hazards,
            0.0,
            0.0,
            500.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("a preferred margin must never turn a real, safe gap into a hard no-go");
        let growth = through_gap.distance_m / direct_m;
        assert!(
            growth < 1.5,
            "must still thread the narrow gap rather than detour kilometres around either wall: {growth}x, {through_gap:?}"
        );
    }

    #[test]
    fn tss_avoidance_prefers_a_real_alternative_when_one_exists() {
        // A compact TSS zone squarely astride the direct line — going
        // around it is a real, cheap alternative.
        let tss = rect(55.0, 12.0, 3_000.0, 3_000.0);
        let a = lat_lon_to_world(55.0, 11.9);
        let b = lat_lon_to_world(55.0, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];
        let tss_rings = [tss.clone()];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &tss_rings,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("a TSS zone never blocks");
        assert!(
            unweighted.diagnostics.used_direct_line,
            "TSS never blocks — must stay the fast path when off"
        );

        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &tss_rings,
            3.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(
            !weighted.diagnostics.used_direct_line,
            "a non-empty TSS ring set must skip the fast path once weighting is on"
        );
        assert!(
            weighted.waypoints.len() > 2,
            "must bend around the zone: {weighted:?}"
        );

        // Less of the weighted path's own length sits inside the zone
        // than the direct line's would.
        let in_zone_m = |waypoints: &[(f64, f64)]| -> f64 {
            waypoints
                .windows(2)
                .map(|w| {
                    let p0 = lat_lon_to_world(w[0].1, w[0].0);
                    let p1 = lat_lon_to_world(w[1].1, w[1].0);
                    let mid = WorldXy::new((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
                    let (x0, y0) = sm_from_world(p0, p0);
                    let (x1, y1) = sm_from_world(p1, p0);
                    let len = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
                    if rings_contain(&tss_rings, mid) {
                        len
                    } else {
                        0.0
                    }
                })
                .sum()
        };
        let unweighted_in_zone = in_zone_m(&unweighted.waypoints);
        let weighted_in_zone = in_zone_m(&weighted.waypoints);
        assert!(
            weighted_in_zone < unweighted_in_zone,
            "weighted path must spend less distance inside the TSS zone: {weighted_in_zone}m vs {unweighted_in_zone}m"
        );

        let growth = weighted.distance_m / unweighted.distance_m;
        assert!(
            growth < 1.30,
            "avoiding a compact zone must not cost much extra distance: {growth}x"
        );
    }

    #[test]
    fn tss_avoidance_still_crosses_directly_when_the_zone_spans_the_whole_corridor() {
        // The SAME zone, but huge in BOTH directions — `CORRIDOR_PAD_CAP_M`
        // (50km) bounds every corridor-widen attempt's own pad no matter
        // how wide the ring itself is, so a zone spanning well past that
        // in EVERY direction leaves no escape route to bend toward, in
        // either latitude or longitude.
        let tss = rect(55.0, 12.0, 100_000.0, 200_000.0);
        let a = lat_lon_to_world(55.0, 11.9);
        let b = lat_lon_to_world(55.0, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];
        let tss_rings = [tss];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &tss_rings,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .unwrap();
        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &tss_rings,
            3.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable — a flat penalty never hard-blocks");

        let growth = weighted.distance_m / unweighted.distance_m;
        assert!(
            growth < 1.02,
            "with no real way around, the router must cross roughly directly, not hunt for an escape: {growth}x"
        );
    }

    #[test]
    fn buoyage_avoidance_prefers_a_real_alternative_when_one_exists() {
        // Same shape as the TSS test above — a compact "wrong side of a
        // lateral mark" zone squarely astride the direct line, built the
        // same synthetic-ring way (this test is scoped to proving the
        // WIRING — that `buoyage_rings`/`buoyage_avoidance_weight` reach
        // `combined_multiplier` and actually bend the route; the geometry
        // that turns a real chart's `BOYLAT`/`BCNLAT` marks into exactly
        // this shape of ring is `routing::buoyage::build_buoyage_penalty`'s
        // own, separately unit-tested, job).
        let wrong_side = rect(55.0, 12.0, 3_000.0, 3_000.0);
        let a = lat_lon_to_world(55.0, 11.9);
        let b = lat_lon_to_world(55.0, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];
        let buoyage_rings = [wrong_side];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &buoyage_rings,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("a buoyage-side zone never blocks");
        assert!(
            unweighted.diagnostics.used_direct_line,
            "buoyage-side avoidance never blocks — must stay the fast path when off"
        );

        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &buoyage_rings,
            3.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(
            !weighted.diagnostics.used_direct_line,
            "a non-empty buoyage ring set must skip the fast path once weighting is on"
        );
        assert!(
            weighted.waypoints.len() > 2,
            "must bend around the wrong-side zone: {weighted:?}"
        );

        let growth = weighted.distance_m / unweighted.distance_m;
        assert!(
            growth < 1.30,
            "avoiding a compact zone must not cost much extra distance: {growth}x"
        );
    }

    #[test]
    fn fairway_preference_pulls_toward_a_connecting_fairway_without_a_big_detour() {
        // Same shape as the shallow-water bulge test, but the zone here is
        // a FAIRWY the router should bend INTO (south of the direct line)
        // rather than away from.
        let fairway = rect(54.9, 12.0, 6_000.0, 15_000.0); // north edge at lat ~54.954
        let a = lat_lon_to_world(54.955, 11.9);
        let b = lat_lon_to_world(54.955, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];
        let fairway_rings = [fairway];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &fairway_rings,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .unwrap();
        assert!(unweighted.diagnostics.used_direct_line);

        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &fairway_rings,
            0.5,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(
            !weighted.diagnostics.used_direct_line,
            "a non-empty fairway ring set must skip the fast path once weighting is on"
        );
        assert!(
            weighted.waypoints.len() > 2,
            "must bend toward the fairway: {weighted:?}"
        );

        let max_south_m = weighted
            .waypoints
            .iter()
            .map(|&(_, lat)| (54.955 - lat) * 111_320.0)
            .fold(0.0_f64, f64::max);
        assert!(
            max_south_m > 50.0,
            "must bend measurably south, into the fairway, got {max_south_m}m"
        );

        let growth = weighted.distance_m / unweighted.distance_m;
        assert!(
            growth < 1.05,
            "a cheap pull into a connecting fairway must not cost much extra distance: {growth}x"
        );
    }

    #[test]
    fn fairway_preference_never_forces_a_detour_into_an_unhelpful_fairway() {
        // The same fairway, far enough from the direct line that bending
        // toward it is not a bargain at any real weight.
        let fairway = rect(53.5, 12.0, 6_000.0, 15_000.0);
        let a = lat_lon_to_world(54.955, 11.9);
        let b = lat_lon_to_world(54.955, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];
        let fairway_rings = [fairway];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &fairway_rings,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .unwrap();
        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &fairway_rings,
            0.9,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable");

        let growth = weighted.distance_m / unweighted.distance_m;
        assert!(
            growth < 1.001,
            "a fairway nowhere near the route must not pull the path toward it at all: {growth}x"
        );
    }

    #[test]
    fn preferred_route_wiring_bends_a_route_toward_a_real_rectrc_not_just_fairwy() {
        // Integration proof, `Cell`/`Feature` through
        // `build_preferred_route_union` to `shortest_path_weighted` — the
        // SAME shape `air_draft_wiring_actually_blocks_a_route_through_a_
        // real_too_low_bridge` uses for air draft — that the BROADENED
        // class list actually reaches the search for a class OTHER than
        // FAIRWY. `fairway_preference_pulls_toward_a_connecting_fairway_
        // without_a_big_detour` above already proves the raster mechanism
        // responds to `fairway_rings`/`fairway_preference_weight`
        // generically; this proves a real charted `RECTRC` (recommended
        // track) feature, run through the actual chartcore geometry
        // pipeline `routing::preference::build_preferred_route_union`,
        // produces those rings in the first place.
        use crate::model::{Cell, CellMeta, Feature, Geometry, Polygon};
        use std::collections::BTreeMap;

        let rectrc_ring = rect(54.9, 12.0, 6_000.0, 15_000.0); // south of the direct line
        let rectrc_feature = Feature::new(
            109, // RECTRC's own S-57 object class code
            "RECTRC".into(),
            BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: rectrc_ring,
                holes: vec![],
            }])),
        );
        let mut extent = crate::coords::Extent::invalid();
        extent.extend(&rectrc_feature.extent);
        let cell = Cell {
            meta: CellMeta::default(),
            features: vec![rectrc_feature],
            extent,
        };

        let preferred_route = crate::routing::preference::build_preferred_route_union(&cell)
            .expect("a charted RECTRC must join the preferred-route union");

        let a = lat_lon_to_world(54.955, 11.9);
        let b = lat_lon_to_world(54.955, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &preferred_route.rings,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .unwrap();
        assert!(unweighted.diagnostics.used_direct_line);

        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &preferred_route.rings,
            0.5,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(
            weighted.waypoints.len() > 2,
            "a real RECTRC must bend the route toward it, exactly like a FAIRWY does: {weighted:?}"
        );
        let max_south_m = weighted
            .waypoints
            .iter()
            .map(|&(_, lat)| (54.955 - lat) * 111_320.0)
            .fold(0.0_f64, f64::max);
        assert!(
            max_south_m > 50.0,
            "must bend measurably toward the charted RECTRC, got {max_south_m}m"
        );
    }

    /// A found path's own real cost under `model` — the SAME per-edge
    /// formula `search_grid`'s successors closure computes, replicated
    /// here (not called directly — that closure is private to
    /// `search_grid`) so this test can independently verify optimality
    /// rather than merely trust the search's own internal bookkeeping.
    fn path_cost(path: &[(i32, i32)], model: &CostModel) -> u32 {
        path.windows(2)
            .map(|w| {
                let (a, b) = (w[0], w[1]);
                let base = if a.0 != b.0 && a.1 != b.1 {
                    DIAG_COST
                } else {
                    ORTHO_COST
                };
                let ma = combined_multiplier(a, model);
                let mb = combined_multiplier(b, model);
                (base as f64 * (ma + mb) / 2.0).ceil().max(1.0) as u32
            })
            .sum()
    }

    /// Every SIMPLE path (no repeated cell) from `start` to `goal` over
    /// `grid`'s free cells, branch-and-bound DFS pruned against the best
    /// cost found so far — tractable at the tiny grid size this is used
    /// at (16 cells), and a genuine exhaustive search, not a hand-picked
    /// comparison.
    fn brute_force_best_cost(
        grid: &Grid,
        start: (i32, i32),
        goal: (i32, i32),
        model: &CostModel,
    ) -> u32 {
        const NEIGHBORS: [(i32, i32); 8] = [
            (1, 0),
            (-1, 0),
            (0, 1),
            (0, -1),
            (1, 1),
            (1, -1),
            (-1, 1),
            (-1, -1),
        ];
        let mut best = u32::MAX;
        let mut visited = vec![false; (grid.cols * grid.rows) as usize];
        let mut path = vec![start];
        fn idx(grid: &Grid, p: (i32, i32)) -> usize {
            (p.1 as u32 * grid.cols + p.0 as u32) as usize
        }
        fn dfs(
            grid: &Grid,
            goal: (i32, i32),
            model: &CostModel,
            path: &mut Vec<(i32, i32)>,
            visited: &mut [bool],
            best: &mut u32,
        ) {
            let here = *path.last().unwrap();
            if here == goal {
                let cost = path_cost(path, model);
                if cost < *best {
                    *best = cost;
                }
                return;
            }
            let so_far = path_cost(path, model);
            if so_far >= *best {
                return; // branch-and-bound: this branch can't possibly improve on `best`
            }
            for (dx, dy) in NEIGHBORS {
                let p = (here.0 + dx, here.1 + dy);
                if p.0 < 0 || p.1 < 0 || p.0 as u32 >= grid.cols || p.1 as u32 >= grid.rows {
                    continue;
                }
                if grid.blocked(p.0, p.1) && p != goal {
                    continue;
                }
                let i = idx(grid, p);
                if visited[i] {
                    continue;
                }
                visited[i] = true;
                path.push(p);
                dfs(grid, goal, model, path, visited, best);
                path.pop();
                visited[i] = false;
            }
        }
        visited[idx(grid, start)] = true;
        dfs(grid, goal, model, &mut path, &mut visited, &mut best);
        best
    }

    #[test]
    fn heuristic_scale_keeps_the_weighted_search_exact() {
        // 4x4, no walls — an all-free walkability grid, so every bit of
        // cost structure comes from the fairway discount below,
        // exercising `heuristic_scale` specifically without
        // hazard-avoidance noise muddying which mechanism is under test.
        let cols = 4u32;
        let rows = 4u32;
        let walk_grid = Grid {
            cols,
            rows,
            blocked: vec![false; (cols * rows) as usize],
        };

        // A fairway strip along the bottom row only — off the direct
        // diagonal from (0,0) to (3,3), so reaching it costs real extra
        // distance; a strong discount should still make routing through
        // it cheaper overall.
        let mut fairway_blocked = vec![false; (cols * rows) as usize];
        for x in 0..cols {
            fairway_blocked[(3 * cols + x) as usize] = true;
        }
        let fairway_grid = Grid {
            cols,
            rows,
            blocked: fairway_blocked,
        };

        let corridor = Corridor {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
        }; // unused by search_grid/combined_multiplier directly
        let weight = 0.9; // RoutingConfig's own real ceiling
        let model = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: Some((&fairway_grid, weight)),
            buoyage: None,
            cable: None,
            caution: None,
            survey: None,
            heuristic_scale: 1.0 - weight,
        };

        let (found_path, _expansions) =
            search_grid(&walk_grid, (0, 0), (3, 3), Some(&model)).expect("reachable");
        let found_cost = path_cost(&found_path, &model);
        let true_best = brute_force_best_cost(&walk_grid, (0, 0), (3, 3), &model);
        assert_eq!(
            found_cost, true_best,
            "search_grid must find the TRUE optimum under the scaled heuristic, not merely a plausible path"
        );
    }

    /// Direct pin of the design choice `routing::preference` makes for the
    /// broadened preferred-route family (`FAIRWY`/`RECTRC`/`NAVLNE`/
    /// `DWRTPT`): overlapping source zones must union into ONE flat
    /// discount, never stack into two multiplied together. Builds the
    /// `fairway` grid as the UNION of two overlapping raw regions
    /// (standing in for what `build_preferred_route_union`'s real
    /// `geo::unary_union` does at the geometry layer for two overlapping
    /// classes) and checks the overlap cell's own multiplier is exactly
    /// `1 - weight`, not `(1 - weight)^2` — the value a second,
    /// independently-weighted field would have produced instead.
    #[test]
    fn overlapping_preferred_route_zones_do_not_stack_a_discount() {
        let cols = 4u32;
        let rows = 4u32;
        // Region A: left half. Region B: top half. They overlap in the
        // top-left quadrant — cell (0,0) is inside BOTH.
        let mut a_blocked = vec![false; (cols * rows) as usize];
        let mut b_blocked = vec![false; (cols * rows) as usize];
        for y in 0..rows {
            for x in 0..cols {
                let i = (y * cols + x) as usize;
                if x < cols / 2 {
                    a_blocked[i] = true;
                }
                if y < rows / 2 {
                    b_blocked[i] = true;
                }
            }
        }
        // The union `build_preferred_route_union` would hand `CostModel`
        // — ONE grid, filled wherever EITHER source region was.
        let unioned_blocked: Vec<bool> = a_blocked
            .iter()
            .zip(&b_blocked)
            .map(|(&a, &b)| a || b)
            .collect();
        let fairway_grid = Grid {
            cols,
            rows,
            blocked: unioned_blocked,
        };

        let corridor = Corridor {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
        };
        let weight = 0.9;
        let model = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: Some((&fairway_grid, weight)),
            buoyage: None,
            cable: None,
            caution: None,
            survey: None,
            heuristic_scale: 1.0 - weight,
        };

        // (0,0) is inside both source regions.
        let overlap_multiplier = combined_multiplier((0, 0), &model);
        let single_zone_floor = 1.0 - weight;
        let stacked_floor = single_zone_floor * single_zone_floor;
        assert!(
            (overlap_multiplier - single_zone_floor).abs() < 1e-9,
            "an overlap cell must cost exactly the ONE discount floor ({single_zone_floor}), \
             got {overlap_multiplier} (the wrong, stacked answer would be {stacked_floor})"
        );
    }

    /// The brute-force admissibility regression design question 3 asks
    /// for specifically: search_grid must still find the TRUE optimum
    /// (`heuristic_scale = 1 - fairway_preference_weight`, unchanged)
    /// even when the discount zone comes from a UNION of two overlapping
    /// source regions — the exact shape `build_preferred_route_union`
    /// produces when e.g. a RECTRC overlaps a FAIRWY — not just a single
    /// simple zone the way `heuristic_scale_keeps_the_weighted_search_
    /// exact` above already covers.
    #[test]
    fn heuristic_scale_keeps_the_weighted_search_exact_through_an_overlapping_preferred_route_union(
    ) {
        let cols = 4u32;
        let rows = 4u32;
        let walk_grid = Grid {
            cols,
            rows,
            blocked: vec![false; (cols * rows) as usize],
        };

        // Two overlapping strips, off the direct (0,0)->(3,3) diagonal,
        // unioned exactly as `build_preferred_route_union`'s real
        // `geo::unary_union` would — a FAIRWY-shaped bottom-row strip and
        // an overlapping RECTRC-shaped right-column strip.
        let mut a_blocked = vec![false; (cols * rows) as usize];
        for x in 0..cols {
            a_blocked[(3 * cols + x) as usize] = true; // bottom row
        }
        let mut b_blocked = vec![false; (cols * rows) as usize];
        for y in 0..rows {
            b_blocked[(y * cols + 3) as usize] = true; // right column
        }
        let unioned_blocked: Vec<bool> = a_blocked
            .iter()
            .zip(&b_blocked)
            .map(|(&a, &b)| a || b)
            .collect();
        let fairway_grid = Grid {
            cols,
            rows,
            blocked: unioned_blocked,
        };

        let corridor = Corridor {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
        };
        let weight = 0.9;
        let model = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: Some((&fairway_grid, weight)),
            buoyage: None,
            cable: None,
            caution: None,
            survey: None,
            heuristic_scale: 1.0 - weight,
        };

        let (found_path, _expansions) =
            search_grid(&walk_grid, (0, 0), (3, 3), Some(&model)).expect("reachable");
        let found_cost = path_cost(&found_path, &model);
        let true_best = brute_force_best_cost(&walk_grid, (0, 0), (3, 3), &model);
        assert_eq!(
            found_cost, true_best,
            "search_grid must find the TRUE optimum even when the discount zone is a union of \
             two overlapping preferred-route source regions"
        );
    }

    #[test]
    fn no_path_exists_through_a_fully_enclosing_ring() {
        // The end point is INSIDE a big square that entirely surrounds it
        // and the start is outside — no path can ever reach a point
        // strictly enclosed by a single simple ring with no gap, at any
        // of the widen-ladder's corridor sizes. Since "get as close as
        // you can, then a straight line for the rest" landed, this is no
        // longer a bare `None`: the search routes right up to the
        // square's own boundary and stitches on a straight stub for the
        // unreachable interior, flagged on the last leg of
        // `approximate_legs`.
        let ring = square(LAT, LON, 500.0);
        let a = lat_lon_to_world(LAT, LON - 1.0); // far outside
        let b = lat_lon_to_world(LAT, LON); // dead centre of the ring
        let route =
            shortest_path(a, b, std::slice::from_ref(&ring)).expect("gets as close as it can");
        assert!(!route.approximate_legs[0], "the start was never unsafe");
        assert!(
            *route.approximate_legs.last().unwrap(),
            "the interior point was never actually reached"
        );
        // The route's real portion must end SOMEWHERE ON/NEAR the ring's
        // own boundary, not still far outside it — a real gap closed by
        // an honest search, not just an early bail. Generous bound, not
        // a tight one: `nearest_free_cell`'s own BFS picks by GRID-STEP
        // count, which can land on a corner-adjacent cell (~707m from
        // centre for a 500m half-side square) rather than the metrically
        // nearer edge midpoint (500m) — plus normal grid-resolution
        // rounding on top. What this asserts is "closed almost all of a
        // 62km gap", not "found the exact nearest metre".
        let last_real = route.waypoints[route.waypoints.len() - 2];
        let last_real_world = lat_lon_to_world(last_real.1, last_real.0);
        let (ex, ey) = sm_from_world(last_real_world, b);
        let dist_to_center_m = (ex * ex + ey * ey).sqrt();
        assert!(
            dist_to_center_m < 2_500.0,
            "the real portion should end close to the 500m half-side square's boundary, got {dist_to_center_m}m from centre (direct a->b distance was ~62km)"
        );
        // And the true (unreachable) centre is still the LAST waypoint —
        // the caller always gets the real destination to draw a line to.
        let last = *route.waypoints.last().unwrap();
        assert!(
            (last.0 - LON).abs() < 1e-6 && (last.1 - LAT).abs() < 1e-6,
            "{last:?}"
        );
    }

    #[test]
    fn start_point_inside_a_hazard_gets_as_close_as_possible() {
        // The mirror image of the test above: the START is the one
        // strictly enclosed, the destination is clear. Same mechanism,
        // opposite end flagged.
        let ring = square(LAT, LON, 500.0);
        let a = lat_lon_to_world(LAT, LON); // dead centre of the ring
        let b = lat_lon_to_world(LAT, LON - 1.0); // far outside
        let route =
            shortest_path(a, b, std::slice::from_ref(&ring)).expect("gets as close as it can");
        assert!(
            route.approximate_legs[0],
            "the interior point was never actually reached"
        );
        assert!(
            !*route.approximate_legs.last().unwrap(),
            "the destination was never unsafe"
        );
        // The true (unreachable) centre is still the FIRST waypoint.
        let first = route.waypoints[0];
        assert!(
            (first.0 - LON).abs() < 1e-6 && (first.1 - LAT).abs() < 1e-6,
            "{first:?}"
        );
        // The real portion starts close to the square's own boundary.
        let first_real = route.waypoints[1];
        let first_real_world = lat_lon_to_world(first_real.1, first_real.0);
        let (ex, ey) = sm_from_world(first_real_world, a);
        assert!(
            (ex * ex + ey * ey).sqrt() < 2_500.0,
            "the real portion should start close to the square's boundary"
        );
    }

    #[test]
    fn a_wall_spanning_the_whole_corridor_still_gets_as_close_as_possible() {
        // BOTH endpoints are individually safe (a narrow wall — only 3km
        // each side of centre — with `a`/`b` a further ~3.4km outside
        // that on either side), but the wall is 500km TALL, so no detour
        // north or south fits inside `CORRIDOR_PAD_CAP_M` (50km) at any
        // widen-ladder attempt. Same "spans well past the corridor cap"
        // shape `tss_avoidance_still_crosses_directly_when_the_zone_
        // spans_the_whole_corridor` uses for a SOFT preference — here as
        // a HARD hazard, which genuinely blocks rather than merely
        // discourages. No corridor width can find a gap, so this
        // exercises `best_effort_partial_route` specifically, not the
        // in-loop endpoint-snapping the two tests above exercise.
        let wall = rect(LAT, LON, 500_000.0, 3_000.0);
        let a = lat_lon_to_world(LAT, LON - 0.1);
        let b = lat_lon_to_world(LAT, LON + 0.1);
        let route =
            shortest_path(a, b, std::slice::from_ref(&wall)).expect("gets as close as it can");
        assert!(!route.approximate_legs[0], "the start was never unsafe");
        // NOT `.last()` specifically any more: `refine_flagged_legs`'s own
        // `bisect_run` fallback can now resolve a genuinely SEPARATE,
        // disconnected piece near `b` (open water past the wall's own
        // east edge is reachable "from nearby" even though nothing
        // connects it back to `a`) and mark THAT leg exact, while the
        // real, unresolved crossing lands on an EARLIER leg instead — this
        // is the same "real progress" partial-credit shape
        // `refine_flagged_legs`'s own docs already establish, just now
        // reachable for a run this long. The property that actually
        // matters is unchanged: with no real gap anywhere, AT LEAST ONE
        // leg must stay honestly unresolved.
        assert!(
            route.approximate_legs.iter().any(|&flagged| flagged),
            "no gap exists in a wall taller than the corridor cap"
        );
        // Still routes SOMEWHERE, not a bare 2-point line landing right
        // back on the direct chord — the real portion must have moved
        // measurably off the straight line toward the (unreachable) wall.
        assert!(route.waypoints.len() >= 2);
        let last = *route.waypoints.last().unwrap();
        assert!(
            (last.0 - (LON + 0.1)).abs() < 1e-6 && (last.1 - LAT).abs() < 1e-6,
            "{last:?}"
        );
    }

    // ── `macro_route`: the toy-scale Limfjord — a wall the normal search
    // can NEVER get around (same shape as the test just above: taller than
    // any per-request corridor could ever pad), but with a real gap far
    // enough off the direct line that only a much larger search box can
    // reach it. ──

    #[test]
    fn macro_route_finds_a_detour_the_normal_corridor_cap_could_never_reach() {
        // Two wall segments, same narrow width (6km) as the test above,
        // with a 10km gap centred ~100km north of `a`/`b`'s own latitude —
        // an order of magnitude past `CORRIDOR_PAD_CAP_M` (50km), so the
        // ORDINARY search (proven by the test just above, same wall shape
        // minus the gap) can never find it, at any widen-ladder attempt.
        let south_segment = rect(LAT - 1.819, LON, 297_500.0, 3_000.0); // up to ~95km north of LAT
        let north_segment = rect(LAT + 3.167, LON, 247_500.0, 3_000.0); // from ~105km north of LAT
        let land = vec![south_segment, north_segment];
        let a = lat_lon_to_world(LAT, LON - 0.1);
        let b = lat_lon_to_world(LAT, LON + 0.1);

        // Sanity: the ordinary search really cannot get around this wall
        // (mirrors the test above exactly, confirming the gap is really
        // out of its reach and this isn't just a differently-shaped
        // wall). NOT `.last()` — see that test's own updated comment for
        // why `bisect_run` can now resolve a disconnected piece near
        // either end while the real crossing stays flagged elsewhere.
        let ordinary = shortest_path(a, b, &land).expect("gets as close as it can");
        assert!(
            ordinary.approximate_legs.iter().any(|&flagged| flagged),
            "sanity: the ordinary search must still be unable to get around"
        );

        // A box too small to reach the gap (matching the normal cap)
        // finds nothing either — proves the win below comes from the
        // BIGGER box, not from `macro_route` being magic regardless of
        // its own parameters.
        let too_small = macro_route(a, b, &land, 50_000.0, 1_000.0, 800);
        assert!(
            too_small.is_none(),
            "a 50km box cannot reach a gap ~100km off the direct line: {too_small:?}"
        );

        // A box that actually reaches the gap finds a real way through.
        //
        // NOTE what this deliberately does NOT assert: that every raw
        // macro leg is individually clear of `land` (`visible()`-true).
        // `macro_route`'s own docs are explicit that it is not that kind
        // of function — its optimistic rasterization can occasionally let
        // a raw grid step graze real land at the single-cell scale (this
        // test's own adversarial 10km gap at 1km resolution hits exactly
        // that), and there is no finer cell to fall back to within a
        // coarse macro grid. That is fine: the caller re-runs the real,
        // exact, depth-aware search (`shortest_path_weighted`, complete
        // with its own `verify_legs`/`refine_flagged_legs`) leg by leg
        // along whatever this returns — THAT is what actually guarantees
        // safety, not this coarse topology guide.
        let route = macro_route(a, b, &land, 300_000.0, 1_000.0, 800)
            .expect("a real gap exists within a 300km box");
        assert!(route.len() >= 3, "must bend to reach the gap: {route:?}");
        assert_eq!(route[0], to_lonlat(a));
        assert_eq!(*route.last().unwrap(), to_lonlat(b));

        // And it must actually pass NEAR the gap (~100km north of LAT),
        // not some other, nonexistent way around — the whole point of
        // this test.
        let passes_near_gap = route
            .iter()
            .any(|&(_, lat)| (lat - (LAT + 100_000.0 / 111_320.0)).abs() < 0.3);
        assert!(
            passes_near_gap,
            "the route should pass near the real ~100km-north gap: {route:?}"
        );
    }

    #[test]
    fn macro_route_is_an_honest_none_when_nothing_connects_at_all() {
        // The SAME wall, no gap anywhere (mirrors the ordinary-search
        // wall test exactly) — even a huge box must come back `None`,
        // not a bogus path across solid land.
        let wall = rect(LAT, LON, 500_000.0, 3_000.0);
        let a = lat_lon_to_world(LAT, LON - 0.1);
        let b = lat_lon_to_world(LAT, LON + 0.1);
        let route = macro_route(a, b, std::slice::from_ref(&wall), 300_000.0, 1_000.0, 800);
        assert!(route.is_none(), "{route:?}");
    }

    // ── `widen_attempts_for`: dedupe the corridor-widen ladder itself when
    // two `CORRIDOR_PAD_FACTORS` entries clamp to the same pad — a real
    // regression found live: for any route past ~50km direct distance the
    // `1.0` and `3.0` factors both saturate `CORRIDOR_PAD_CAP_M`, so the
    // old unconditional 3-attempt loop rasterized and searched an
    // IDENTICAL 400k+-cell grid twice for nothing on every long request
    // this module still can't route (see `ROUTING_TODO.md`'s corridor-cap
    // section). ──

    #[test]
    fn widen_attempts_dedupes_factors_that_clamp_to_the_same_cap() {
        // 100km direct: 0.3x (30km) stays under the 50km cap, unclamped —
        // but 1.0x (100km) and 3.0x (300km) both saturate it. Only the
        // tight attempt and the (now single) capped attempt are genuinely
        // distinct, so 3 factors collapse to exactly 2 real attempts —
        // this is precisely the shape of the real Aarhus-to-west-Jutland
        // request that motivated this (measured ~70nm direct, both its
        // 1.0x and 3.0x attempts landing on the identical 50km/256m/
        // 900x462 grid before this existed).
        let attempts = widen_attempts_for(100_000.0, CORRIDOR_PAD_FLOOR_M);
        assert_eq!(
            attempts.len(),
            2,
            "factors 1.0 and 3.0 both saturate the 50km cap at this distance: {attempts:?}"
        );
        assert_eq!(
            attempts[0].0, 0,
            "the tight attempt keeps its original index"
        );
        assert_eq!(
            attempts[1].0, 1,
            "the capped attempt reports the FIRST factor that reached it (1.0x), not the last (3.0x)"
        );
        assert_eq!(attempts[0].1, 100_000.0 * 0.3);
        assert_eq!(attempts[1].1, CORRIDOR_PAD_CAP_M);
    }

    #[test]
    fn widen_attempts_keeps_all_three_when_genuinely_distinct() {
        // A direct distance in the "nothing clamps" middle ground (0.3x
        // above the floor, 3.0x below the cap) keeps all three attempts
        // distinct — the common case, unaffected by the dedup.
        let attempts = widen_attempts_for(10_000.0, CORRIDOR_PAD_FLOOR_M); // 10km direct
        assert_eq!(attempts.len(), 3, "{attempts:?}");
        assert_eq!(
            attempts.iter().map(|&(i, _)| i).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(attempts[0].1, 10_000.0 * 0.3);
        assert_eq!(attempts[1].1, 10_000.0 * 1.0);
        assert_eq!(attempts[2].1, 10_000.0 * 3.0);
    }

    #[test]
    fn widen_attempts_dedupes_factors_that_clamp_to_the_same_floor() {
        // A very short hop floors EVERY factor to `CORRIDOR_PAD_FLOOR_M`
        // (`direct_m * 3.0 < FLOOR` too) — all three collapse to one.
        let attempts = widen_attempts_for(500.0, CORRIDOR_PAD_FLOOR_M); // 500m direct
        assert_eq!(attempts, vec![(0, CORRIDOR_PAD_FLOOR_M)], "{attempts:?}");
    }

    #[test]
    fn widen_attempts_honours_a_caller_supplied_floor() {
        // Same 500m direct hop as the test above, but through
        // `REFINE_PAD_FLOOR_M` instead — half the pad. Factors 0.3 and 1.0
        // (150m, 500m) both still land below the smaller floor and collapse
        // to it, but factor 3.0 (1500m) now clears it and stays genuinely
        // distinct — proof this is a real, materially smaller corridor than
        // the top-level floor gives, not just a relabelled identical one.
        let attempts = widen_attempts_for(500.0, REFINE_PAD_FLOOR_M);
        assert_eq!(
            attempts,
            vec![(0, REFINE_PAD_FLOOR_M), (2, 1500.0)],
            "{attempts:?}"
        );
        assert!(REFINE_PAD_FLOOR_M < CORRIDOR_PAD_FLOOR_M);
    }

    #[test]
    fn best_effort_partial_route_with_no_prebuilt_grid_is_an_honest_none_not_a_panic() {
        // `shortest_path_weighted`'s own widen loop always hands over a
        // built grid (its `widen_attempts` is never empty) — this defends
        // the OTHER branch: a hypothetical future caller with no grid to
        // reuse gets a plain `None`, not a panic that could abort or throw
        // mid-request across the pyo3 boundary.
        let a = lat_lon_to_world(LAT, LON);
        let route = best_effort_partial_route(a, a, false, 1.0, None);
        assert!(route.is_none());
    }

    // ── `refine_flagged_legs`/`refine_recursive`: re-search a flagged leg
    // on its own (shorter, finer-resolution) corridor and splice in a real
    // detour where one exists — the fix for the class of bug
    // `a_thin_hazard_the_rasterizer_misses_is_still_caught_by_exact_leg_
    // verification` above proves gets FLAGGED: this is what turns that
    // flag into a real bent path instead of a straight warning stub,
    // whenever a real, findable detour actually exists. ──

    #[test]
    fn refine_replaces_a_flagged_leg_with_a_real_detour_when_one_exists() {
        // A 3-waypoint route, leg 0 (a->b) already real, leg 1 (b->c)
        // hand-flagged approximate as a stand-in for "the outer search
        // missed something here" — regardless of WHY it was flagged, a
        // real, easily-avoidable square obstacle sits squarely between b
        // and c, so refining that leg on its own must find and splice in
        // a real detour around it.
        let obstacle = square(LAT, LON, 300.0);
        let a = lat_lon_to_world(LAT, LON - 0.05);
        let b = lat_lon_to_world(LAT, LON - 0.01);
        let c = lat_lon_to_world(LAT, LON + 0.01);
        let route = RoutePath {
            waypoints: vec![to_lonlat(a), to_lonlat(b), to_lonlat(c)],
            distance_m: 0.0,
            diagnostics: RouteDiagnostics::direct(),
            approximate_legs: vec![false, true],
        };
        let hazard_rings = [obstacle];
        let refined = refine_flagged_legs(
            route,
            &hazard_rings,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
            0,
        );

        assert!(
            refined.waypoints.len() > 3,
            "a real detour around the obstacle must add waypoints: {refined:?}"
        );
        assert!(
            !refined.approximate_legs.iter().any(|&f| f),
            "the whole leg is now exactly verified: {refined:?}"
        );
        // The route's own true endpoints (a and c) are untouched — only
        // the flagged run's interior was spliced.
        assert_eq!(refined.waypoints[0], to_lonlat(a));
        assert_eq!(*refined.waypoints.last().unwrap(), to_lonlat(c));
        // And the spliced-in detour must not itself cross the obstacle —
        // same check `a_square_obstacle_forces_a_detour_around_one_corner`
        // makes on the top-level search.
        let bboxes: Vec<RingBox> = [&hazard_rings[0]].iter().map(|r| RingBox::of(r)).collect();
        for w in refined.waypoints.windows(2) {
            let p0 = lat_lon_to_world(w[0].1, w[0].0);
            let p1 = lat_lon_to_world(w[1].1, w[1].0);
            assert!(
                visible(p0, p1, &hazard_rings, &bboxes),
                "a spliced leg still crosses the obstacle: {w:?}"
            );
        }
    }

    /// The real live-found bug (#owqqcdqe, 2026-08-10): a boat leaving a
    /// marina had to round its own breakwater regardless, but the coarse
    /// search's own flagged-run boundary happened to land partway round
    /// it — refining "reach exactly that boundary point" faithfully
    /// found a real path TO it, a real but POINTLESS backtrack, since the
    /// onward journey never needed to touch that specific point at all.
    /// Reproduced synthetically: `a` must round a square obstacle to
    /// reach `c` (north-east of it); the coarse stand-in route ALSO
    /// insists on visiting `mid` — a point back down at the obstacle's
    /// OWN latitude, east of it — before continuing to `c`, even though
    /// the real optimal route never needs to descend back to that
    /// latitude at all once it has rounded the corner. `mid -> c` is
    /// genuinely clear (not flagged) — only `a -> mid` needs refining —
    /// so this exercises the post-splice whole-route re-simplify, not
    /// `refine_recursive`'s own per-run search.
    #[test]
    fn refine_does_not_leave_a_pointless_backtrack_through_an_unnecessary_waypoint() {
        let obstacle = square(LAT, LON, 300.0);
        let a = lat_lon_to_world(LAT, LON - 0.02);
        let c = lat_lon_to_world(LAT + 0.005, LON + 0.03);
        let mid = lat_lon_to_world(LAT, LON + 0.005);
        let hazards = [obstacle];

        // `mid -> c` really must be clear for this test's own input to be
        // valid (it claims so via `approximate_legs`, unflagged).
        let bboxes: Vec<RingBox> = hazards.iter().map(|r| RingBox::of(r)).collect();
        assert!(
            visible(mid, c, &hazards, &bboxes),
            "test setup is invalid: mid->c must be clear water"
        );

        let route = RoutePath {
            waypoints: vec![to_lonlat(a), to_lonlat(mid), to_lonlat(c)],
            distance_m: 0.0,
            diagnostics: RouteDiagnostics::direct(),
            approximate_legs: vec![true, false],
        };
        let refined = refine_flagged_legs(
            route,
            &hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
            0,
        );

        // The ground truth: the real shortest hazard-avoiding path from
        // `a` straight to `c`, with no artificial waypoint forced onto
        // it at all.
        let truth = shortest_path(a, c, &hazards).expect("a way around exists");

        assert!(
            !refined.approximate_legs.iter().any(|&f| f),
            "the whole leg is now exactly verified: {refined:?}"
        );
        let growth = refined.distance_m / truth.distance_m;
        assert!(
            growth < 1.05,
            "refining must not leave a material backtrack through the now-pointless \
             waypoint: refined={:.0}m truth={:.0}m ({growth:.3}x) refined_waypoints={:?}",
            refined.distance_m,
            truth.distance_m,
            refined.waypoints
        );
    }

    /// The SAME live-found bug (#owqqcdqe, 2026-08-10), one level up:
    /// `mivnav.features.routing.routes._stitch_macro_route` concatenates
    /// SEVERAL independent `shortest_path` results (one per macro-
    /// waypoint pair) in Python — a seam no single `shortest_path` call,
    /// and no `refine_flagged_legs` splice, ever sees, since each
    /// sub-leg is searched in complete isolation from its neighbours.
    /// `resimplify_and_reverify` (exposed to Python as
    /// `chartcore.resimplify_route`) is the fix: run once, after
    /// concatenation, over the WHOLE stitched chain.
    #[test]
    fn resimplify_and_reverify_collapses_a_pointless_waypoint_at_a_macro_stitch_seam() {
        let obstacle = square(LAT, LON, 300.0);
        let a = lat_lon_to_world(LAT, LON - 0.02);
        let c = lat_lon_to_world(LAT + 0.005, LON + 0.03);
        // The shared "macro waypoint" two independently-searched legs
        // were stitched at — same shape as the single-leg test above,
        // but this time NEVER passed through `refine_flagged_legs` at
        // all: two already-complete, already-verified `RoutePath`s are
        // simply concatenated, exactly as `_stitch_macro_route` does.
        let mid = lat_lon_to_world(LAT, LON + 0.005);

        let leg1 = shortest_path(a, mid, &[obstacle.clone()]).expect("a way around exists");
        let leg2 = shortest_path(mid, c, &[obstacle.clone()]).expect("mid->c is clear water");
        assert!(
            leg2.waypoints.len() == 2,
            "test setup expects a plain clear hop mid->c"
        );

        let mut stitched_waypoints = leg1.waypoints.clone();
        stitched_waypoints.extend(leg2.waypoints[1..].iter().copied());

        let hazards = [obstacle];
        let resimplified =
            resimplify_and_reverify(&stitched_waypoints, &hazards, RouteDiagnostics::direct());

        let truth = shortest_path(a, c, &hazards).expect("a way around exists");
        assert!(
            !resimplified.approximate_legs.iter().any(|&f| f),
            "every leg of the resimplified chain must be exactly verified: {resimplified:?}"
        );
        let growth = resimplified.distance_m / truth.distance_m;
        assert!(
            growth < 1.05,
            "stitching two independent legs must not leave a material backtrack through the \
             now-pointless shared waypoint: stitched={:.0}m truth={:.0}m ({growth:.3}x) \
             resimplified_waypoints={:?}",
            resimplified.distance_m,
            truth.distance_m,
            resimplified.waypoints
        );
    }

    #[test]
    fn resimplify_and_reverify_rejects_an_empty_chain_from_the_pyo3_binding_only() {
        // `resimplify_and_reverify` itself asserts non-empty (every
        // in-crate caller already guarantees at least the two original
        // request endpoints); the EMPTY-input guard is `chartcore.
        // resimplify_route`'s own job (`waypoints.len() < 2 => None`),
        // covered on the Python side (`test_routing.py`) since it needs
        // the pyo3 boundary this crate's own tests don't build by
        // default (`--features pyo3`). This test just pins the single-
        // point boundary this function DOES accept, so a future change
        // here can't silently start requiring 2+ without a test noticing.
        let a = lat_lon_to_world(LAT, LON);
        let result = resimplify_and_reverify(&[to_lonlat(a)], &[], RouteDiagnostics::direct());
        assert_eq!(result.waypoints, vec![to_lonlat(a)]);
        assert_eq!(result.approximate_legs, Vec::<bool>::new());
    }

    /// `resimplify_and_reverify`'s own limit (#owqqcdqe, 2026-08-10,
    /// found live, the second half of the same bug): a PURE geometric
    /// shortcut pass can only DROP existing waypoints when two others
    /// already see each other directly — it can never propose a
    /// genuinely NEW bend point. Reproduces the actual failure this
    /// exposed: both sub-legs adjacent to a shared macro waypoint that
    /// turns out to sit INSIDE a real hazard each honestly stub their own
    /// approach to it (forced, per `verify_legs`'s own docs) — but the
    /// direct chord SKIPPING that shared point entirely is ALSO blocked
    /// (by the same hazard, from a different angle), so no amount of
    /// shortcutting among the EXISTING points can ever find the small
    /// real detour a fresh re-search trivially would.
    /// `refine_stitched_route` (`chartcore.refine_route`) is the fix.
    #[test]
    fn refine_stitched_route_finds_a_real_detour_a_pure_resimplify_pass_cannot() {
        let obstacle = square(LAT, LON, 300.0);
        let a = lat_lon_to_world(LAT, LON - 0.02);
        let c = lat_lon_to_world(LAT, LON + 0.02);
        let mid = lat_lon_to_world(LAT, LON); // dead centre of the obstacle — genuinely unsafe
        let hazards = [obstacle];

        // Both `a->mid` and `mid->c` are honestly flagged (mirrors two
        // independently-searched sub-legs each stubbing their own
        // approach to the same bad shared point) — and the direct `a->c`
        // shortcut a pure resimplify pass could try instead is ALSO
        // blocked by the very same obstacle, so no existing-point
        // shortcut can ever fix this; only a real re-search (which finds
        // a path around a CORNER of the square, never touching `mid`) can.
        let waypoints = vec![to_lonlat(a), to_lonlat(mid), to_lonlat(c)];
        let approximate_legs = vec![true, true];

        let bboxes: Vec<RingBox> = hazards.iter().map(|r| RingBox::of(r)).collect();
        assert!(
            !visible(a, c, &hazards, &bboxes),
            "test setup is invalid: a->c must ALSO be blocked, or a pure resimplify could fix this too"
        );

        let refined = refine_stitched_route(
            waypoints,
            approximate_legs,
            &hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        );

        let truth = shortest_path(a, c, &hazards).expect("a way around exists");
        assert!(
            !refined.approximate_legs.iter().any(|&f| f),
            "a real detour exists and must be found, not left as a stub: {refined:?}"
        );
        assert!(
            !refined.waypoints.contains(&to_lonlat(mid)),
            "the real detour must not route through the genuinely unsafe shared point: {refined:?}"
        );
        let growth = refined.distance_m / truth.distance_m;
        assert!(
            growth < 1.1,
            "must find a real detour close to optimal, not just any technically-connected \
             path: refined={:.0}m truth={:.0}m ({growth:.3}x) refined_waypoints={:?}",
            refined.distance_m,
            truth.distance_m,
            refined.waypoints
        );
    }

    /// Visibility is NOT monotonic along an assembled chain: `a` sees `q`
    /// and `c`, but not `p` or `r` between them (both behind the
    /// obstacle). `simplify_path`'s binary search probes `r`, sees it
    /// blocked, and settles for `q`; the exhaustive scan must find `c`.
    #[test]
    fn resimplify_finds_a_shortcut_past_blocked_points_mid_chain() {
        let obstacle = square(LAT, LON, 300.0);
        let a = lat_lon_to_world(LAT, LON - 0.02);
        let q = lat_lon_to_world(LAT + 0.01, LON);
        let p = lat_lon_to_world(LAT, LON + 0.01);
        let r = lat_lon_to_world(LAT - 0.001, LON + 0.02);
        let c = lat_lon_to_world(LAT + 0.015, LON + 0.03);
        let hazards = [obstacle];
        let bboxes: Vec<RingBox> = hazards.iter().map(|r| RingBox::of(r)).collect();
        assert!(visible(a, c, &hazards, &bboxes), "setup: a must see c");
        assert!(!visible(a, p, &hazards, &bboxes), "setup: a must not see p");
        assert!(!visible(a, r, &hazards, &bboxes), "setup: a must not see r");

        let chain: Vec<(f64, f64)> = [a, q, p, r, c].iter().map(|&w| to_lonlat(w)).collect();
        let binary = simplify_path(&[a, q, p, r, c], &hazards, &bboxes, None);
        assert_eq!(
            binary.len(),
            3,
            "setup: the binary search must miss this: {binary:?}"
        );

        let route = resimplify_and_reverify(&chain, &hazards, RouteDiagnostics::direct());
        assert_eq!(route.waypoints.len(), 2, "{:?}", route.waypoints);
    }

    /// The seam half of the live Aarhus bug (2026-10-20): the coarse
    /// search's flagged-run endpoint (`mid`) is an artifact well off the
    /// sensible line, and refining "reach exactly `mid`" keeps the
    /// dogleg through it — `a → mid` is clear on its own and `a → c` is
    /// blocked, so no shortcut pass can drop `mid`. Re-searching past
    /// the seam (`SEAM_EXTENSION_M` along `mid → c`) must find the real
    /// way round instead.
    #[test]
    fn refine_searches_past_an_artifact_seam_instead_of_through_it() {
        let obstacle = square(LAT, LON, 300.0);
        let a = lat_lon_to_world(LAT, LON - 0.03);
        let mid = lat_lon_to_world(LAT - 0.01, LON);
        let c = lat_lon_to_world(LAT, LON + 0.03);
        let hazards = [obstacle];
        let bboxes: Vec<RingBox> = hazards.iter().map(|r| RingBox::of(r)).collect();
        assert!(
            visible(a, mid, &hazards, &bboxes),
            "setup: a->mid must be clear"
        );
        assert!(
            visible(mid, c, &hazards, &bboxes),
            "setup: mid->c must be clear"
        );
        assert!(
            !visible(a, c, &hazards, &bboxes),
            "setup: a->c must be blocked"
        );

        let route = RoutePath {
            waypoints: vec![to_lonlat(a), to_lonlat(mid), to_lonlat(c)],
            distance_m: 0.0,
            diagnostics: RouteDiagnostics::direct(),
            approximate_legs: vec![true, false],
        };
        let refined = refine_flagged_legs(
            route,
            &hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
            0,
        );
        let truth = shortest_path(a, c, &hazards).expect("a way around exists");

        assert!(
            !refined.approximate_legs.iter().any(|&f| f),
            "the whole route is exactly verified: {refined:?}"
        );
        assert!(
            !refined.waypoints.contains(&to_lonlat(mid)),
            "the artifact seam point must not survive: {:?}",
            refined.waypoints
        );
        let growth = refined.distance_m / truth.distance_m;
        assert!(
            growth < 1.03,
            "refined={:.0}m truth={:.0}m ({growth:.3}x) waypoints={:?}",
            refined.distance_m,
            truth.distance_m,
            refined.waypoints
        );
    }

    #[test]
    fn extend_along_exact_legs_stops_at_flagged_legs_and_chain_ends() {
        // Four points ~1000 m apart along one parallel; leg 2 flagged.
        let step = 1000.0 / (111_320.0 * LAT.to_radians().cos());
        let pts: Vec<WorldXy> = (0..4)
            .map(|i| lat_lon_to_world(LAT, LON + step * i as f64))
            .collect();
        let legs = [false, false, true];

        // Forward from 0: 1500 m lands mid-leg 1, so the chain resumes at 2.
        let (keep_from, p) = extend_along_exact_legs(&pts, &legs, 0, true);
        assert_eq!(keep_from, 2);
        assert!(p.x > pts[1].x && p.x < pts[2].x, "{p:?}");
        // Forward from 2: leg 2 is flagged — no movement.
        assert_eq!(extend_along_exact_legs(&pts, &legs, 2, true), (3, pts[2]));
        // Backward from 2: mid-leg 0, so only pts[0] precedes.
        let (keep_len, p) = extend_along_exact_legs(&pts, &legs, 2, false);
        assert_eq!(keep_len, 1);
        assert!(p.x > pts[0].x && p.x < pts[1].x, "{p:?}");
        // Backward from 1: runs out of chain at pts[0] itself.
        assert_eq!(extend_along_exact_legs(&pts, &legs, 1, false), (0, pts[0]));
        // Forward from the last point: nothing to walk.
        assert_eq!(extend_along_exact_legs(&pts, &legs, 3, true), (4, pts[3]));
    }

    #[test]
    fn refine_keeps_the_original_stub_when_nothing_free_exists_nearby_at_all() {
        // The mirror case: `b` AND `c` both sit deep inside one hazard
        // FAR bigger than the widest corridor (`CORRIDOR_PAD_CAP_M`, 50km)
        // could ever pad around them — every widen attempt's own grid is
        // then 100% blocked, so re-searching this leg can only ever come
        // back `None` (not even `best_effort_partial_route`'s own
        // `nearest_free_cell` finds anywhere to start from). The ORIGINAL
        // straight stub must be kept rather than dropped or panicked on.
        let giant_hazard = rect(LAT, LON, 200_000.0, 200_000.0); // 400km square
        let a = lat_lon_to_world(LAT, LON - 5.0); // far outside, clear
        let b = lat_lon_to_world(LAT, LON - 0.01); // deep inside the giant hazard
        let c = lat_lon_to_world(LAT, LON + 0.01); // also deep inside it
        let route = RoutePath {
            waypoints: vec![to_lonlat(a), to_lonlat(b), to_lonlat(c)],
            distance_m: 0.0,
            diagnostics: RouteDiagnostics::direct(),
            approximate_legs: vec![false, true],
        };
        let hazard_rings = [giant_hazard];
        let refined = refine_flagged_legs(
            route,
            &hazard_rings,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
            0,
        );
        assert_eq!(
            refined.waypoints,
            vec![to_lonlat(a), to_lonlat(b), to_lonlat(c)],
            "nothing free exists to route through, so the original stub must survive unchanged: {refined:?}"
        );
        // BOTH legs, not just `b->c` — the final whole-route re-verify
        // pass (added alongside the post-splice re-simplify, #owqqcdqe
        // 2026-08-10) is honest about `a->b` too: `b` sits deep inside
        // the SAME giant hazard, so the chord from outside-`a` to
        // inside-`b` necessarily crosses its boundary (winding-number
        // continuity — the exact property `verify_legs`'s own docs cite),
        // regardless of what this test's own hand-built INPUT route
        // claimed. The old behaviour trusted that stale `false` verbatim;
        // this is strictly more accurate, not a regression.
        assert_eq!(refined.approximate_legs, vec![true, true]);
    }

    #[test]
    fn refine_recursive_terminates_on_a_genuinely_unreachable_leg() {
        // The full public entry point, end to end, on the same fully-
        // enclosing-ring shape `no_path_exists_through_a_fully_enclosing_
        // ring` (below) exercises directly — proves the wrapping via
        // `shortest_path_weighted` doesn't hang or panic once refinement
        // is layered on top, and reaches the SAME depth-bounded, honest
        // answer the un-refined search always gave.
        let ring = square(LAT, LON, 500.0);
        let a = lat_lon_to_world(LAT, LON - 1.0);
        let b = lat_lon_to_world(LAT, LON);
        let route =
            shortest_path(a, b, std::slice::from_ref(&ring)).expect("gets as close as it can");
        assert!(
            *route.approximate_legs.last().unwrap(),
            "still honestly flagged — refinement cannot manufacture a path through a closed ring"
        );
    }

    // ── `verify_legs`: the general "flag ANY leg the search couldn't
    // exactly verify" pass, not just the two ends. Asked for directly —
    // a real ~63nm test crossed a real headland near ITS start at 220m
    // grid resolution, passing the grid's own walkability check the
    // whole way; a narrower "only re-check the ends" fix would not have
    // caught the same gap recurring at a real strait mid-route instead. ──

    #[test]
    fn verify_legs_flags_only_the_leg_that_actually_crosses_a_hazard() {
        // Four waypoints in a straight line; a hazard square sits astride
        // ONLY the middle leg (index 1). Neither end is forced.
        let hazard = square(LAT, LON, 200.0);
        let waypoints = [
            lat_lon_to_world(LAT, LON - 0.02),
            lat_lon_to_world(LAT, LON - 0.005), // leg 0: clear
            lat_lon_to_world(LAT, LON + 0.005), // leg 1: crosses the square
            lat_lon_to_world(LAT, LON + 0.02),  // leg 2: clear
        ];
        let bboxes: Vec<RingBox> = [&hazard].iter().map(|r| RingBox::of(r)).collect();
        let rings = [hazard];

        let flags = verify_legs(&waypoints, &rings, &bboxes, false, false);
        assert_eq!(flags, vec![false, true, false], "{flags:?}");
    }

    #[test]
    fn verify_route_legs_matches_a_plain_exact_check_with_no_forcing_or_reshaping() {
        // `verify_route_legs` (the caller-supplied-chain entry point,
        // `crate::python::verify_route`'s own backer) must agree exactly
        // with a raw `verify_legs(..., false, false)` call on the SAME
        // waypoints — no shortcut/simplify pass may have run (unlike
        // `resimplify_and_reverify`), and the leg count/order must be
        // untouched (`waypoints.len() - 1` legs, in input order).
        let hazard = square(LAT, LON, 200.0);
        let waypoints_lonlat = [
            (LON - 0.02, LAT),
            (LON - 0.005, LAT), // leg 0: clear
            (LON + 0.005, LAT), // leg 1: crosses the square
            (LON + 0.02, LAT),  // leg 2: clear
        ];
        let rings = vec![hazard];

        let flags = verify_route_legs(&waypoints_lonlat, &rings);
        assert_eq!(flags, vec![false, true, false], "{flags:?}");
    }

    #[test]
    fn verify_route_legs_is_empty_on_fewer_than_two_waypoints() {
        assert_eq!(verify_route_legs(&[], &[]), Vec::<bool>::new());
        assert_eq!(verify_route_legs(&[(LON, LAT)], &[]), Vec::<bool>::new());
    }

    #[test]
    fn verify_legs_forces_the_end_legs_unconditionally() {
        // `force_start`/`force_end` must flag their leg regardless of
        // what a geometry check on it would say — proven here against a
        // leg that is GEOMETRICALLY CLEAR (visible() would say `false`
        // approximate on its own), specifically because forcing is not
        // "papering over a visible() gap" (see verify_legs's own docs
        // for why that's not the real justification) — it is a genuinely
        // independent fact ("this leg touches a point the search never
        // actually confirmed") that must win regardless of what one
        // local geometry check on that same leg concludes.
        let hazard = square(LAT, LON + 5.0, 100.0); // nowhere near any waypoint below
        let waypoints = [
            lat_lon_to_world(LAT, LON - 0.01),
            lat_lon_to_world(LAT, LON + 0.01),
            lat_lon_to_world(LAT, LON + 0.02),
        ];
        let bboxes: Vec<RingBox> = [&hazard].iter().map(|r| RingBox::of(r)).collect();
        let rings = [hazard];

        let unforced = verify_legs(&waypoints, &rings, &bboxes, false, false);
        assert_eq!(
            unforced,
            vec![false, false],
            "sanity: both legs are genuinely clear"
        );

        let forced = verify_legs(&waypoints, &rings, &bboxes, true, true);
        assert_eq!(forced, vec![true, true], "{forced:?}");
    }

    #[test]
    fn a_thin_hazard_the_rasterizer_misses_is_still_caught_by_exact_leg_verification() {
        // The real failure mode, reproduced synthetically: a hazard
        // THINNER than the grid's own cell size, positioned so the
        // rasterizer's row-sampling (one y-sample per row, see
        // `rasterize`'s own docs) never lands inside it — the grid search
        // walks straight through as if nothing were there — but the
        // FINAL exact per-leg verification still catches it.
        let corridor = Corridor::around(
            lat_lon_to_world(LAT, LON - 0.02),
            lat_lon_to_world(LAT, LON + 0.02),
            0.3,
        );
        let spec = size_grid(&corridor);
        // A strip spanning the whole corridor width, centred between two
        // row samples: row centres sit at ymin + (ry+0.5)*cell, so the
        // gap BETWEEN row ry and ry+1 is centred at ymin + (ry+1)*cell —
        // put a strip a few world units thick right there.
        let mid_row = spec.rows / 2;
        let gap_y = corridor.ymin + (mid_row as f64 * spec.cell_size_world) as i32;
        let half_thick = 2; // world units — far thinner than a real cell
        let strip = vec![
            WorldXy::new(corridor.xmin, gap_y - half_thick),
            WorldXy::new(corridor.xmax, gap_y - half_thick),
            WorldXy::new(corridor.xmax, gap_y + half_thick),
            WorldXy::new(corridor.xmin, gap_y + half_thick),
            WorldXy::new(corridor.xmin, gap_y - half_thick),
        ];

        let grid = rasterize(
            std::slice::from_ref(&strip),
            &corridor,
            spec.cell_size_world,
            spec.cols,
            spec.rows,
        );
        // Confirm the setup actually reproduces the miss: the rasterizer
        // sees NOTHING blocked anywhere (the whole premise of this test).
        assert!(
            grid.blocked.iter().all(|&b| !b),
            "setup invalid: the thin strip was not actually missed by rasterization"
        );

        // A waypoint pair straddling the strip, close enough together
        // that `visible()` — EXACT geometry, unlike the grid — still
        // finds the real crossing.
        let a = WorldXy::new(corridor.center().x, gap_y - 50);
        let b = WorldXy::new(corridor.center().x, gap_y + 50);
        let bboxes: Vec<RingBox> = [&strip].iter().map(|r| RingBox::of(r)).collect();
        let rings = [strip];
        let flags = verify_legs(&[a, b], &rings, &bboxes, false, false);
        assert_eq!(
            flags,
            vec![true],
            "the exact check must catch what the grid missed"
        );
    }

    #[test]
    fn refine_pad_floor_catches_a_thin_hazard_the_top_level_corridor_misses() {
        // The real fix `REFINE_PAD_FLOOR_M` exists for, exercised through
        // the FULL `shortest_path` pipeline (not just a synthetic grid
        // check, unlike the test above): a thin strip positioned so the
        // TOP-LEVEL corridor's own grid rasterizes right through it, same
        // setup as `a_thin_hazard_the_rasterizer_misses_is_still_caught_
        // by_exact_leg_verification`. That test stops at "exact
        // verification correctly flags the leg approximate" — this one
        // goes one step further and proves `refine_flagged_legs`'s own
        // re-search, at `REFINE_PAD_FLOOR_M`'s smaller floor, now finds
        // and VERIFIES a real detour instead of just re-flagging the same
        // straight stand-in a second time.
        // A SHORT hop (~300m — the scale a flagged run's own two endpoints
        // actually have, see `REFINE_PAD_FLOOR_M`'s own docs) — unlike the
        // synthetic test above (~4.5km), a leg this short is exactly where
        // `CORRIDOR_PAD_FLOOR_M`'s 2000m floor dominates the corridor size
        // and coarsens resolution well past what the leg's own length would
        // otherwise need, and where `REFINE_PAD_FLOOR_M` actually changes
        // the resulting `cell_size_m` rather than being a no-op.
        //
        // NORTH-SOUTH (`LAT` varies, `LON` fixed) — the resolution-miss
        // mode `rasterize` actually has is row-sampling only (one y-sample
        // per row; see its own docs), which only misses a hazard thin in
        // the NORTH-SOUTH direction. `fill_span`'s own column fill rounds
        // OUTWARD (floor/ceil, not a single sample), so a hazard thin in
        // the EAST-WEST direction has no equivalent miss mode — an
        // east-west leg crossing a north-south-thin hazard would not
        // reproduce the bug this test exists for.
        let a = lat_lon_to_world(LAT - 0.0025, LON);
        let b = lat_lon_to_world(LAT + 0.0025, LON);

        // The strip's own y-position: exactly between two of the TOP-LEVEL
        // corridor's own grid rows (`CORRIDOR_PAD_FLOOR_M`, depth 0) —
        // identical construction to the test above.
        let top_corridor = Corridor::around(a, b, CORRIDOR_PAD_FACTORS[0]);
        let top_spec = size_grid(&top_corridor);
        let mid_row = top_spec.rows / 2;
        let gap_y = top_corridor.ymin + (mid_row as f64 * top_spec.cell_size_world) as i32;

        // This whole 2-point route becomes its own single flagged run once
        // `refine_flagged_legs` kicks in (there is no other waypoint to
        // split on), so its own re-search corridor is built over these
        // SAME `a`/`b`, just at `REFINE_PAD_FLOOR_M`'s smaller floor.
        let (dm_x, dm_y) = sm_from_world(b, a);
        let direct_m = (dm_x * dm_x + dm_y * dm_y).sqrt();
        let refine_pad = clamped_pad_m(direct_m, CORRIDOR_PAD_FACTORS[0], REFINE_PAD_FLOOR_M);
        let refine_corridor = Corridor::with_pad(a, b, refine_pad);
        let refine_spec = size_grid(&refine_corridor);
        assert!(
            refine_spec.cell_size_m < top_spec.cell_size_m,
            "setup invalid: the refine floor was supposed to give a materially finer grid \
             (top {:.3}m/cell, refine {:.3}m/cell)",
            top_spec.cell_size_m,
            refine_spec.cell_size_m
        );

        // `gap_y` alone is the worst case for the TOP grid specifically
        // (exactly halfway between two of ITS row centres) but says
        // nothing about the REFINE grid — whether it happens to land near
        // one of the refine grid's OWN (much more numerous) row samples is
        // not implied by that at all. Re-centre onto the nearest REFINE
        // row's own sample line instead — within half a refine cell of
        // `gap_y` by construction, and (since a refine cell is much
        // smaller than a top cell here) still comfortably inside the same
        // gap between top row samples — same technique the bake
        // feasibility prototype used to compare a finer grid's own catch
        // against a coarser one's own miss.
        let refine_row = (((gap_y - refine_corridor.ymin) as f64 / refine_spec.cell_size_world)
            .floor() as i32)
            .clamp(0, refine_spec.rows as i32 - 1);
        let strip_y =
            refine_corridor.ymin + ((refine_row as f64 + 0.5) * refine_spec.cell_size_world) as i32;
        // Full thickness must sit strictly BETWEEN the two grids' own cell
        // spacing: bigger than `REFINE`'s (so refine's grid — which never
        // gets finer than `MIN_CELL_M` however deep `refine_flagged_legs`
        // recurses; every recursive sub-search below measured exactly
        // 6.0m/cell for this leg — is GUARANTEED to have a row sample
        // inside the strip regardless of exactly where its own rows fall,
        // by the pigeonhole principle: an interval at least one cell wide
        // must contain a sample spaced one cell apart), but small enough
        // to stay within `gap_y`'s own margin to the nearest TOP row (half
        // a top cell, `gap_y` being built exactly halfway between two —
        // see above), so the TOP grid still deterministically misses it.
        // A thickness of 2 world units (the original synthetic test's own
        // choice, ~0.09m at this resolution) is thinner than a real chart
        // feature would ever be and, empirically, too thin to reliably
        // land ON a refine sample even after re-centring — this is the
        // realistic middle ground the fix is actually for.
        let half_thick = (refine_spec.cell_size_world * 0.6).ceil() as i32;
        assert!(
            (half_thick as f64) < top_spec.cell_size_world / 2.0,
            "setup invalid: half_thick ({half_thick}) must stay under half a TOP cell \
             ({:.1}) or the top grid would catch it too",
            top_spec.cell_size_world / 2.0
        );
        // A HEADLAND, not a full wall: from the corridor's own west edge
        // out to just past the route's own x (`a.x == b.x`, same
        // longitude) — comfortably blocking the direct north-south line —
        // but stopping well short of the corridor's east edge, leaving a
        // real gap to detour through. A full-width wall would have no
        // detour at ANY resolution (a correctly-flagged `best_effort`
        // result, not the bug this test is for) — this shape is what
        // makes "does refine's finer grid actually find a real detour"
        // the genuine question being asked, matching the module's own
        // "headland"/"strait" framing (`RoutePath::approximate_legs`'s own
        // docs) rather than an unroutable barrier.
        let strip_xmin = top_corridor.xmin.min(refine_corridor.xmin);
        let corridor_width = top_corridor.xmax - top_corridor.xmin;
        let strip_xmax = a.x + corridor_width / 20;
        let strip = vec![
            WorldXy::new(strip_xmin, strip_y - half_thick),
            WorldXy::new(strip_xmax, strip_y - half_thick),
            WorldXy::new(strip_xmax, strip_y + half_thick),
            WorldXy::new(strip_xmin, strip_y + half_thick),
            WorldXy::new(strip_xmin, strip_y - half_thick),
        ];

        // Confirm the TOP-LEVEL grid really does miss it.
        let top_grid = rasterize(
            std::slice::from_ref(&strip),
            &top_corridor,
            top_spec.cell_size_world,
            top_spec.cols,
            top_spec.rows,
        );
        assert!(
            top_grid.blocked.iter().all(|&blocked| !blocked),
            "setup invalid: the top-level grid was supposed to miss the strip"
        );

        // Confirm the REFINE-floor grid actually catches it — the premise
        // the fix depends on, not an assumption.
        let refine_grid = rasterize(
            std::slice::from_ref(&strip),
            &refine_corridor,
            refine_spec.cell_size_world,
            refine_spec.cols,
            refine_spec.rows,
        );
        assert!(
            refine_grid.blocked.iter().any(|&blocked| blocked),
            "setup invalid: the refine-floor grid was supposed to catch the strip"
        );

        // The real end-to-end behaviour: the full search's FINAL route has
        // every leg exactly verified — refine's own re-search found and
        // confirmed a real detour around the strip, not just a re-flagged
        // straight stand-in through it.
        let path = shortest_path(a, b, std::slice::from_ref(&strip))
            .expect("a way around the thin strip exists");
        assert!(
            path.waypoints.len() > 2,
            "must bend around the strip once refine catches it: {path:?}"
        );
        assert!(
            path.approximate_legs.iter().all(|&flagged| !flagged),
            "refine must find a fully exact detour, not leave an approximate stand-in: {path:?}"
        );
        let bboxes = vec![RingBox::of(&strip)];
        for w in path.waypoints.windows(2) {
            let p0 = lat_lon_to_world(w[0].1, w[0].0);
            let p1 = lat_lon_to_world(w[1].1, w[1].0);
            assert!(
                visible(p0, p1, std::slice::from_ref(&strip), &bboxes),
                "leg {p0:?} -> {p1:?} must not cross the strip"
            );
        }
    }

    /// The real live bug [`bisect_run`] exists for, reproduced
    /// synthetically: a macro-stitched route's own leftover flagged run
    /// can be several km long in its own right, with the only actually
    /// passable water a gap far narrower than that whole run's own
    /// corridor could ever resolve — found live, a real ~28m opening-
    /// bridge span (Aggersund, a real narrow Danish strait) inside a
    /// flagged run several nautical miles long. Two long walls spanning
    /// the WHOLE corridor's own width (not a headland with an open end to
    /// route around — see `refine_pad_floor_catches_...`'s own docs for
    /// why that shape is a different test and a different fix), with a
    /// narrow gap between them.
    #[test]
    fn refine_bisects_a_long_flagged_run_to_find_a_real_narrow_gap() {
        // ~8km direct — comfortably past `BISECT_MIN_DISTANCE_M`, and (see
        // the assertion below) already too far for the TOP-LEVEL corridor's
        // own resolution to see a real ~20m gap at all.
        let half_route_m = 4_000.0;
        let dlon = half_route_m / (111_320.0 * LAT.to_radians().cos());
        let a = lat_lon_to_world(LAT, LON - dlon);
        let b = lat_lon_to_world(LAT, LON + dlon);

        // A real bridge-opening scale, not a razor-thin artifact — well
        // under the top-level grid's own ~40m/cell resolution at this
        // distance (confirmed below, not assumed), comfortably above
        // `MIN_CELL_M` (6m) so a fully-bisected leaf can resolve it.
        let gap_half_m = 12.0;
        // Each wall spans well past the corridor's own east-west extent
        // (the corridor is only `half_route_m` plus a modest pad wide) and
        // north-south extent (the corridor's own pad, not `half_route_m` —
        // `a`/`b` share the same latitude, so pad alone sets its height),
        // so nothing here is `rasterize`'s own row-sampling miss (already
        // covered by `refine_pad_floor_catches_...`) — this is a genuine
        // "gap narrower than the resolution" miss, present at EVERY row.
        // Wide enough that no realistic corridor pad reaches past the
        // wall's own east-west edge to slip around it that way, but
        // SHORT of `half_route_m` by a real margin — `a`/`b` must stay
        // genuinely OUTSIDE the wall's own footprint (open water beyond
        // its far edge for `nearest_free_cell`/`best_effort_partial_
        // route` to actually reach), not buried inside it: an earlier
        // draft set this past `half_route_m` and put `a`/`b` themselves
        // inside the wall, so EVERY corridor touching them — down to the
        // smallest bisected leaf — rasterized fully blocked, and
        // `best_effort_partial_route`'s own `nearest_free_cell` silently
        // returned `None` (propagating out of `search_once` and through
        // `bisect_run`'s own `?` with no chance to log anything, which is
        // exactly what made this failure mode so opaque to debug).
        let wall_half_lon_m = 1_500.0;
        // Bigger than `CORRIDOR_PAD_CAP_M` (50km): the walls must stay
        // impassable at every widen attempt the search could ever try, or
        // it simply routes around their far end at a wide-enough pad
        // instead of ever needing the gap at all — measured live in an
        // earlier draft of this test, which used 20km and got exactly
        // that "goes around, not through" route back.
        let wall_half_lat_m = 60_000.0;
        // `rect`'s own `lon` is a real DEGREE coordinate, not a metre
        // offset — convert the wall's own centre distance from `LON`
        // through the same `111_320 * cos(lat)` factor `dlon` above
        // already uses.
        let m_per_lon_deg = 111_320.0 * LAT.to_radians().cos();
        let wall_center_dlon = (gap_half_m + wall_half_lon_m) / m_per_lon_deg;
        let left = rect(
            LAT,
            LON - wall_center_dlon,
            wall_half_lat_m,
            wall_half_lon_m,
        );
        let right = rect(
            LAT,
            LON + wall_center_dlon,
            wall_half_lat_m,
            wall_half_lon_m,
        );
        let rings = vec![left, right];

        // Confirm the premise: `visible` (exact geometry — the direct
        // straight line genuinely IS blocked by the wall) but the
        // TOP-LEVEL corridor's own RASTER grid still finds no free path
        // at all near it — the gap is real, but too narrow for this
        // resolution to see, not just "the direct line happens to be
        // blocked" (a trivially different, uninteresting case).
        let bboxes_setup: Vec<RingBox> = rings.iter().map(|r| RingBox::of(r)).collect();
        assert!(
            !visible(a, b, &rings, &bboxes_setup),
            "setup invalid: the direct a->b line must cross a wall"
        );
        let top_corridor = Corridor::around(a, b, CORRIDOR_PAD_FACTORS[0]);
        let top_spec = size_grid(&top_corridor);
        assert!(
            top_spec.cell_size_m > gap_half_m * 2.0,
            "setup invalid: the top-level grid ({:.1}m/cell) was supposed to be coarser \
             than the {}m gap",
            top_spec.cell_size_m,
            gap_half_m * 2.0
        );

        // `bisect_run` directly, not the full `shortest_path` pipeline:
        // `search_once`'s own widen ladder/`best_effort_partial_route`
        // fallback (deliberately made unreachable-around here, by the
        // walls' own height) does not hand `refine_flagged_legs` back the
        // EXACT original `a`/`b` as one run's own endpoints — it can
        // legitimately wander along the wall's own edge first (chasing
        // "closest reachable") before giving up, so the run it ends up
        // bisecting is a real but NON-deterministic pair for a test to
        // pin exactly. `bisect_run` is what actually matters here; the
        // full pipeline reaching it at all is already covered by every
        // OTHER `refine_flagged_legs`/`shortest_path` test in this file
        // still passing unchanged.
        let mut budget = BISECT_TOTAL_BUDGET;
        let bisected = bisect_run(
            a,
            b,
            &rings,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
            0,
            &mut budget,
        )
        .expect("bisection must find the real gap");
        assert!(
            bisected.len() >= 3,
            "must be a real bend through the gap, not a straight a->b stand-in: {bisected:?}"
        );
        // `bisect_run` itself only decides which points are worth
        // splicing in (see its own docs) — the real exactness guarantee
        // `refine_flagged_legs` relies on is its own downstream
        // `resimplify_and_reverify` pass over the FULL assembled chain,
        // run here directly for the same reason (two sub-searches meeting
        // at `mid` are not guaranteed to land on the exact same point, so
        // a raw concatenation can still leave an unverified seam —
        // `resimplify_and_reverify` is what actually re-checks it, not
        // `bisect_run` itself). The bar this run meets is the SAME "real
        // progress" one `refine_flagged_legs`'s own direct re-search
        // already uses (`!approximate_legs.any(flagged) is NOT required
        // — a run this component-heavy composing several independent
        // sub-searches is not guaranteed to fully resolve in one pass,
        // only to make real progress no same-corridor retry ever could):
        // at least one leg comes back genuinely exact, proving a real
        // detour through the gap was found, not just re-flagged.
        let reverified = resimplify_and_reverify(&bisected, &rings, RouteDiagnostics::direct());
        assert!(
            reverified.approximate_legs.iter().any(|&flagged| !flagged),
            "must make real progress through the gap, not stay fully approximate \
             end to end: {reverified:?}"
        );
    }

    /// FIXED BUG, kept as a permanent regression: see `ROUTING_TODO.md`'s
    /// now-closed "margin buffering is not yet trustworthy" entry. On
    /// `backend/data/fnc/DE6OSTIM.S57`'s real coastline, connectivity
    /// between two fixed points must never IMPROVE as `margin_m` grows —
    /// a bigger buffer can only ever grow a hazard's footprint. See
    /// `visibility::visible`'s own docs for the root cause this originally
    /// exposed (still exercised here since a raster search is built
    /// directly on top of the same exact-crossing primitives).
    #[test]
    fn margin_buffering_is_monotonic_on_a_real_coastline() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../backend/data/fnc/DE6OSTIM.S57");
        let file = std::fs::File::open(&path).unwrap();
        let mut cell = crate::osenc::read_cell(file).unwrap();
        crate::derive::apply(&mut cell);

        let a = lat_lon_to_world(53.991333651899645, 11.35);
        let b = lat_lon_to_world(53.991333651899645, 11.40);

        let mut connected_at = Vec::new();
        for margin in [0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0] {
            let idx = crate::routing::build_hazard_index(&cell, 0.0, margin, 0.0).unwrap();
            let ok = shortest_path(a, b, &idx.rings).is_some();
            connected_at.push((margin, ok));
        }
        eprintln!("connectivity by margin: {connected_at:?}");

        let mut saw_disconnect = false;
        for &(margin, ok) in &connected_at {
            if !ok {
                saw_disconnect = true;
            }
            assert!(
                !(saw_disconnect && ok),
                "margin {margin}m is connected AFTER a smaller margin already \
                 disconnected it — buffering must be monotonic: {connected_at:?}"
            );
        }
    }

    #[test]
    fn rasterizer_blocks_the_interior_of_a_known_square_and_nothing_else() {
        let ring = square(LAT, LON, 100.0);
        let corridor = Corridor::around(
            lat_lon_to_world(LAT, LON - 0.01),
            lat_lon_to_world(LAT, LON + 0.01),
            1.0,
        );
        let cell_size_world = radius_world_units(corridor.center(), 20.0); // 20m cells
        let cols = ((corridor.xmax - corridor.xmin) as f64 / cell_size_world).ceil() as u32;
        let rows = ((corridor.ymax - corridor.ymin) as f64 / cell_size_world).ceil() as u32;
        let grid = rasterize(
            std::slice::from_ref(&ring),
            &corridor,
            cell_size_world,
            cols,
            rows,
        );

        // The centre cell (over the square's own centre) must be blocked;
        // a cell at the grid's own corner (far from the square) must not.
        let center_cell = world_to_cell(&corridor, cell_size_world, lat_lon_to_world(LAT, LON));
        assert!(
            grid.blocked(center_cell.0, center_cell.1),
            "the square's own centre must be blocked"
        );
        assert!(
            !grid.blocked(0, 0),
            "a far corner of the corridor must be free"
        );
        assert!(grid.blocked.iter().any(|&b| b), "something must be blocked");
        assert!(grid.blocked.iter().any(|&b| !b), "something must be free");
    }

    #[test]
    fn astar_threads_a_gap_in_a_wall() {
        // A hand-built 5x5 grid: column 2 is a wall except row 2, which is
        // the gap. Path from (0,0) to (4,4) must route through (2,2).
        let cols = 5u32;
        let rows = 5u32;
        let mut blocked = vec![false; (cols * rows) as usize];
        for y in 0..rows {
            if y != 2 {
                blocked[(y * cols + 2) as usize] = true;
            }
        }
        let grid = Grid {
            cols,
            rows,
            blocked,
        };
        let (path, _expansions) =
            search_grid(&grid, (0, 0), (4, 4), None).expect("the gap is passable");
        assert!(
            path.contains(&(2, 2)),
            "the path must thread the gap: {path:?}"
        );
        assert_eq!(*path.first().unwrap(), (0, 0));
        assert_eq!(*path.last().unwrap(), (4, 4));
    }

    #[test]
    fn astar_finds_no_path_through_a_solid_wall() {
        let cols = 5u32;
        let rows = 5u32;
        let mut blocked = vec![false; (cols * rows) as usize];
        for y in 0..rows {
            blocked[(y * cols + 2) as usize] = true;
        }
        let grid = Grid {
            cols,
            rows,
            blocked,
        };
        assert!(search_grid(&grid, (0, 0), (4, 4), None).is_none());
    }

    // ── Cable/pipeline and caution-area soft-avoid wiring ───────────────

    #[test]
    fn cable_avoidance_prefers_a_real_alternative_when_one_exists() {
        // Same shape as `tss_avoidance_prefers_a_real_alternative_when_
        // one_exists` — a compact cable/pipeline zone astride the direct
        // line, going around it is a real, cheap alternative.
        let cable = rect(55.0, 12.0, 3_000.0, 3_000.0);
        let a = lat_lon_to_world(55.0, 11.9);
        let b = lat_lon_to_world(55.0, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];
        let cable_rings = [cable.clone()];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &cable_rings,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("a cable zone never blocks");
        assert!(
            unweighted.diagnostics.used_direct_line,
            "cable avoidance never blocks — must stay the fast path when off"
        );

        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &cable_rings,
            3.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(
            !weighted.diagnostics.used_direct_line,
            "a non-empty cable ring set must skip the fast path once weighting is on"
        );
        assert!(
            weighted.waypoints.len() > 2,
            "must bend around the cable zone: {weighted:?}"
        );

        let in_zone_m = |waypoints: &[(f64, f64)]| -> f64 {
            waypoints
                .windows(2)
                .map(|w| {
                    let p0 = lat_lon_to_world(w[0].1, w[0].0);
                    let p1 = lat_lon_to_world(w[1].1, w[1].0);
                    let mid = WorldXy::new((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
                    let (x0, y0) = sm_from_world(p0, p0);
                    let (x1, y1) = sm_from_world(p1, p0);
                    let len = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
                    if rings_contain(&cable_rings, mid) {
                        len
                    } else {
                        0.0
                    }
                })
                .sum()
        };
        let unweighted_in_zone = in_zone_m(&unweighted.waypoints);
        let weighted_in_zone = in_zone_m(&weighted.waypoints);
        assert!(
            weighted_in_zone < unweighted_in_zone,
            "weighted path must spend less distance inside the cable zone: {weighted_in_zone}m vs {unweighted_in_zone}m"
        );
    }

    #[test]
    fn caution_area_avoidance_prefers_a_real_alternative_when_one_exists() {
        // Same shape/proof, for the SEPARATE `caution` weight — a real
        // alternative around an anchorage/caution zone.
        let caution = rect(55.0, 12.0, 3_000.0, 3_000.0);
        let a = lat_lon_to_world(55.0, 11.9);
        let b = lat_lon_to_world(55.0, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];
        let caution_rings = [caution.clone()];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &caution_rings,
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("a caution zone never blocks");
        assert!(unweighted.diagnostics.used_direct_line);

        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &caution_rings,
            3.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(!weighted.diagnostics.used_direct_line);
        assert!(
            weighted.waypoints.len() > 2,
            "must bend around the caution zone: {weighted:?}"
        );

        let in_zone_m = |waypoints: &[(f64, f64)]| -> f64 {
            waypoints
                .windows(2)
                .map(|w| {
                    let p0 = lat_lon_to_world(w[0].1, w[0].0);
                    let p1 = lat_lon_to_world(w[1].1, w[1].0);
                    let mid = WorldXy::new((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
                    let (x0, y0) = sm_from_world(p0, p0);
                    let (x1, y1) = sm_from_world(p1, p0);
                    let len = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
                    if rings_contain(&caution_rings, mid) {
                        len
                    } else {
                        0.0
                    }
                })
                .sum()
        };
        assert!(
            in_zone_m(&weighted.waypoints) < in_zone_m(&unweighted.waypoints),
            "weighted path must spend less distance inside the caution zone"
        );
    }

    #[test]
    fn cable_and_caution_are_independent_weights_that_both_apply_when_zones_overlap() {
        // The design-question-1 proof at the raster layer: cable and
        // caution are DELIBERATELY separate `CostModel` fields (unlike
        // TSS/fairway's own broadened-but-still-single-field families) —
        // see `routing::preference::CABLE_AVOID_CLASSES`'s own docs for
        // the reasoning. Confirm the mechanics actually compose as
        // designed: overlapping cable+caution water costs MORE than
        // either alone (they stack, unlike two classes WITHIN one family,
        // which union into a single non-stacking discount/penalty).
        let cols = 4u32;
        let rows = 4u32;
        let all_filled = Grid {
            cols,
            rows,
            blocked: vec![true; (cols * rows) as usize],
        };
        let corridor = Corridor {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
        };
        let base = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: None,
            buoyage: None,
            cable: None,
            caution: None,
            survey: None,
            heuristic_scale: 1.0,
        };
        let cable_only = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: None,
            buoyage: None,
            cable: Some((&all_filled, 2.0)),
            caution: None,
            survey: None,
            heuristic_scale: 1.0,
        };
        let caution_only = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: None,
            buoyage: None,
            cable: None,
            caution: Some((&all_filled, 2.0)),
            survey: None,
            heuristic_scale: 1.0,
        };
        let both = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: None,
            buoyage: None,
            cable: Some((&all_filled, 2.0)),
            caution: Some((&all_filled, 2.0)),
            survey: None,
            heuristic_scale: 1.0,
        };
        let cell = (0, 0);
        let m_none = combined_multiplier(cell, &base);
        let m_cable = combined_multiplier(cell, &cable_only);
        let m_caution = combined_multiplier(cell, &caution_only);
        let m_both = combined_multiplier(cell, &both);
        assert!(m_cable > m_none && m_caution > m_none);
        assert!(
            (m_both - m_cable * m_caution / m_none).abs() < 1e-9,
            "cable and caution must multiply independently, not union into one shared penalty: \
             none={m_none} cable={m_cable} caution={m_caution} both={m_both}"
        );
    }

    /// Design question 3's proof, not an assumption: `cable`/`caution` are
    /// pure AVOID terms (same shape as `tss`/`buoyage`), so
    /// `octile_heuristic`'s existing admissibility proof already covers
    /// them ("any raise-only term") with NO `heuristic_scale` change
    /// needed — unlike the fairway DISCOUNT, which needed a real fix. This
    /// is the SAME brute-force-vs-`search_grid` proof
    /// `heuristic_scale_keeps_the_weighted_search_exact` uses for the
    /// fairway case, run here with a strong caution AVOID weight and
    /// `heuristic_scale` left at its OFF default (`1.0`, no fairway
    /// involved at all) — confirming `search_grid` still finds the TRUE
    /// optimum under a real avoid penalty with the unmodified heuristic.
    #[test]
    fn cable_and_caution_avoidance_need_no_heuristic_change_to_stay_exact() {
        let cols = 4u32;
        let rows = 4u32;
        let walk_grid = Grid {
            cols,
            rows,
            blocked: vec![false; (cols * rows) as usize],
        };

        // A caution strip along the direct diagonal's own row 1 — cheap to
        // avoid by stepping around it, expensive to plow straight through
        // at this weight, exactly the shape that would fool a heuristic
        // that undershoots the true avoid-inflated cost.
        let mut caution_blocked = vec![false; (cols * rows) as usize];
        for x in 0..cols {
            caution_blocked[(cols + x) as usize] = true;
        }
        let caution_grid = Grid {
            cols,
            rows,
            blocked: caution_blocked,
        };

        let corridor = Corridor {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
        };
        let model = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: None,
            buoyage: None,
            cable: None,
            caution: Some((&caution_grid, 4.0)), // well above RoutingConfig's own 5.0 cap's midpoint
            survey: None,
            heuristic_scale: 1.0, // OFF — no fairway discount in this test
        };

        let (found_path, _expansions) =
            search_grid(&walk_grid, (0, 0), (3, 3), Some(&model)).expect("reachable");
        let found_cost = path_cost(&found_path, &model);
        let true_best = brute_force_best_cost(&walk_grid, (0, 0), (3, 3), &model);
        assert_eq!(
            found_cost, true_best,
            "a pure AVOID term must not need any heuristic change to stay exact: search_grid \
             found {found_cost}, true optimum is {true_best}"
        );
    }

    #[test]
    fn cable_wiring_bends_a_route_around_a_real_charted_cblsub() {
        // Integration proof, `Cell`/`Feature` through
        // `routing::preference::build_cable_union` to
        // `shortest_path_weighted` — same shape as
        // `preferred_route_wiring_bends_a_route_toward_a_real_rectrc_not_
        // just_fairwy` — proving the ACTUAL S-57 class scan produces rings
        // that reach the search, not just that the raster mechanism
        // responds to an arbitrary ring set.
        //
        // The cable LINE runs COINCIDENT with (not merely crossing) the
        // direct route for a real stretch — deliberately, not an
        // oversight: a route crossing a cable PERPENDICULARLY, briefly, is
        // exactly the case `CABLE_AVOID_CLASSES`'s own docs say should
        // cost almost nothing (that's the whole reasoning for splitting
        // cable/pipeline out as its own, narrower concern) — so a
        // perpendicular-crossing shape would not exercise "prefers a real
        // alternative" at all, only "correctly does nothing", a different
        // (already covered) property. Running ALONG one, the case that
        // actually matters, must still bend the route.
        use crate::model::{Cell, CellMeta, Feature, Geometry};
        use std::collections::BTreeMap;

        let cblsub_line = vec![lat_lon_to_world(55.0, 11.95), lat_lon_to_world(55.0, 12.05)];
        let cblsub = Feature::new(
            22, // CBLSUB's own S-57 object class code
            "CBLSUB".into(),
            BTreeMap::new(),
            Some(Geometry::Lines(vec![cblsub_line])),
        );
        let mut extent = crate::coords::Extent::invalid();
        extent.extend(&cblsub.extent);
        let cell = Cell {
            meta: CellMeta::default(),
            features: vec![cblsub],
            extent,
        };
        let cable_union = crate::routing::preference::build_cable_union(&cell)
            .expect("a charted CBLSUB must join the cable union");

        let a = lat_lon_to_world(55.0, 11.9);
        let b = lat_lon_to_world(55.0, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &cable_union.rings,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("a cable line never blocks");
        assert!(unweighted.diagnostics.used_direct_line);

        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &cable_union.rings,
            3.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(
            weighted.waypoints.len() > 2,
            "a real charted CBLSUB, run through the actual geometry pipeline, must bend a route \
             running ALONG it: {weighted:?}"
        );
    }

    #[test]
    fn caution_wiring_bends_a_route_around_a_real_charted_permitted_transit_resare() {
        // Integration proof for the RESARE two-tier composition end to
        // end: a real RESARE `Feature`, `RESTRN` present but NOT `7`
        // (fishing prohibited only — legal to transit), through
        // `routing::preference::build_caution_union` to
        // `shortest_path_weighted`. Proves both halves of the design at
        // once — the feature correctly resolves to the SOFT-avoid tier
        // (not silently invisible, not hard-blocked: `hazards::
        // build_hazard_index` on the SAME cell must be `None`), and the
        // resulting ring set actually bends a route squarely astride it.
        use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry, Polygon};
        use std::collections::BTreeMap;

        let mut attrs = BTreeMap::new();
        attrs.insert("RESTRN".to_string(), AttrValue::IntList(vec![3]));
        let resare_ring = rect(55.0, 12.0, 3_000.0, 3_000.0);
        let resare = Feature::new(
            112, // RESARE's own S-57 object class code
            "RESARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: resare_ring,
                holes: vec![],
            }])),
        );
        let mut extent = crate::coords::Extent::invalid();
        extent.extend(&resare.extent);
        let cell = Cell {
            meta: CellMeta::default(),
            features: vec![resare],
            extent,
        };

        assert!(
            crate::routing::hazards::build_hazard_index(&cell, 2.0, 0.0, 0.0).is_none(),
            "RESTRN=[3] (not 7) must NOT be hard-blocked"
        );
        let caution_union = crate::routing::preference::build_caution_union(&cell)
            .expect("a permitted-transit RESARE must join the caution union");

        let a = lat_lon_to_world(55.0, 11.9);
        let b = lat_lon_to_world(55.0, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];

        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &caution_union.rings,
            3.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(
            weighted.waypoints.len() > 2,
            "a real charted permitted-transit RESARE, run through the actual geometry pipeline, \
             must bend the route: {weighted:?}"
        );
    }

    /// Design question 1/2's proof at the raster layer for the
    /// low-confidence-survey term: same brute-force-vs-`search_grid` proof
    /// `cable_and_caution_avoidance_need_no_heuristic_change_to_stay_exact`
    /// above uses, confirming `survey` is the SAME pure-AVOID shape (no
    /// `heuristic_scale` change needed) rather than assuming it by analogy.
    #[test]
    fn survey_avoidance_needs_no_heuristic_change_to_stay_exact() {
        let cols = 4u32;
        let rows = 4u32;
        let walk_grid = Grid {
            cols,
            rows,
            blocked: vec![false; (cols * rows) as usize],
        };

        let mut survey_blocked = vec![false; (cols * rows) as usize];
        for x in 0..cols {
            survey_blocked[(cols + x) as usize] = true;
        }
        let survey_grid = Grid {
            cols,
            rows,
            blocked: survey_blocked,
        };

        let corridor = Corridor {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
        };
        let model = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: None,
            buoyage: None,
            cable: None,
            caution: None,
            survey: Some((&survey_grid, 4.0)),
            heuristic_scale: 1.0,
        };

        let (found_path, _expansions) =
            search_grid(&walk_grid, (0, 0), (3, 3), Some(&model)).expect("reachable");
        let found_cost = path_cost(&found_path, &model);
        let true_best = brute_force_best_cost(&walk_grid, (0, 0), (3, 3), &model);
        assert_eq!(
            found_cost, true_best,
            "a pure AVOID term must not need any heuristic change to stay exact: search_grid \
             found {found_cost}, true optimum is {true_best}"
        );
    }

    #[test]
    fn survey_wiring_bends_a_route_around_a_real_charted_low_confidence_zone() {
        // Integration proof, `Cell`/`Feature` through
        // `routing::preference::build_low_confidence_survey_union` to
        // `shortest_path_weighted` — same shape as
        // `cable_wiring_bends_a_route_around_a_real_charted_cblsub` above:
        // proving the ACTUAL S-57 class/attribute scan produces rings that
        // reach the search, not just that the raster mechanism responds to
        // an arbitrary ring set.
        use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry, Polygon};
        use std::collections::BTreeMap;

        let mut attrs = BTreeMap::new();
        attrs.insert("CATZOC".to_string(), AttrValue::Int(5)); // Zone D
        let mqual_ring = rect(55.0, 12.0, 3_000.0, 3_000.0);
        let mqual = Feature::new(
            308, // M_QUAL's own S-57 object class code
            "M_QUAL".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: mqual_ring,
                holes: vec![],
            }])),
        );
        let mut extent = crate::coords::Extent::invalid();
        extent.extend(&mqual.extent);
        let cell = Cell {
            meta: CellMeta::default(),
            features: vec![mqual],
            extent,
        };
        let survey_union = crate::routing::preference::build_low_confidence_survey_union(&cell)
            .expect("a charted CATZOC-D M_QUAL zone must join the survey union");

        let a = lat_lon_to_world(55.0, 11.9);
        let b = lat_lon_to_world(55.0, 12.1);
        let no_hazards: [Vec<WorldXy>; 0] = [];

        let unweighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &survey_union.rings,
            0.0,
            0.0,
            false,
        )
        .expect("a low-confidence-survey zone never blocks");
        assert!(unweighted.diagnostics.used_direct_line);

        let weighted = shortest_path_weighted(
            a,
            b,
            &no_hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &survey_union.rings,
            3.0,
            0.0,
            false,
        )
        .expect("still passable, just weighted");
        assert!(
            weighted.waypoints.len() > 2,
            "a real charted low-confidence-survey zone, run through the actual geometry \
             pipeline, must bend the route: {weighted:?}"
        );
    }

    // ── Turn cost: baked into the search itself, not just cleaned up
    // afterward by `simplify_path`'s string-pulling. See
    // `search_grid_with_turn_cost`'s own module docs for the full design
    // reasoning (state-space expansion, admissibility, measured
    // performance). ──

    /// [`brute_force_best_cost`]'s turn-cost-aware sibling: exhaustive DFS
    /// over every SIMPLE path from `start` to `goal`, additionally
    /// tracking which [`NEIGHBORS_TURN`] direction the path most recently
    /// moved in so each step's own [`turn_penalty`] is added on top of the
    /// ordinary (optionally weighted) distance cost — the ground truth
    /// [`search_grid_with_turn_cost`]'s own regression tests check
    /// against, same branch-and-bound-pruned-DFS shape
    /// `brute_force_best_cost` already established for the fairway-
    /// discount proofs above.
    #[allow(clippy::too_many_arguments)]
    fn brute_force_best_turn_cost(
        grid: &Grid,
        start: (i32, i32),
        goal: (i32, i32),
        model: Option<&CostModel>,
        turn_cost_weight: f64,
    ) -> u32 {
        fn idx(grid: &Grid, p: (i32, i32)) -> usize {
            (p.1 as u32 * grid.cols + p.0 as u32) as usize
        }
        #[allow(clippy::too_many_arguments)]
        fn dfs(
            grid: &Grid,
            goal: (i32, i32),
            model: Option<&CostModel>,
            turn_cost_weight: f64,
            here: (i32, i32),
            incoming: u8,
            cost_so_far: u32,
            visited: &mut [bool],
            best: &mut u32,
        ) {
            if here == goal {
                if cost_so_far < *best {
                    *best = cost_so_far;
                }
                return;
            }
            if cost_so_far >= *best {
                return; // branch-and-bound, same as `brute_force_best_cost`
            }
            for (dir_idx, &(dx, dy, base_cost)) in NEIGHBORS_TURN.iter().enumerate() {
                let p = (here.0 + dx, here.1 + dy);
                if p.0 < 0 || p.1 < 0 || p.0 as u32 >= grid.cols || p.1 as u32 >= grid.rows {
                    continue;
                }
                if grid.blocked(p.0, p.1) && p != goal {
                    continue;
                }
                let i = idx(grid, p);
                if visited[i] {
                    continue;
                }
                let dist_cost = match model {
                    Some(m) => {
                        let ma = combined_multiplier(here, m);
                        let mb = combined_multiplier(p, m);
                        (base_cost as f64 * (ma + mb) / 2.0).ceil().max(1.0) as u32
                    }
                    None => base_cost,
                };
                let dir = dir_idx as u8;
                let turn_cost = if incoming == NO_INCOMING_DIRECTION {
                    0
                } else {
                    turn_penalty(angular_steps(incoming, dir), turn_cost_weight)
                };
                visited[i] = true;
                dfs(
                    grid,
                    goal,
                    model,
                    turn_cost_weight,
                    p,
                    dir,
                    cost_so_far + dist_cost + turn_cost,
                    visited,
                    best,
                );
                visited[i] = false;
            }
        }
        let mut visited = vec![false; (grid.cols * grid.rows) as usize];
        visited[idx(grid, start)] = true;
        let mut best = u32::MAX;
        dfs(
            grid,
            goal,
            model,
            turn_cost_weight,
            start,
            NO_INCOMING_DIRECTION,
            0,
            &mut visited,
            &mut best,
        );
        best
    }

    /// A found cell path's own real turn-charged cost — the SAME per-edge
    /// distance formula `path_cost` already replicates, plus
    /// `turn_penalty` charged wherever consecutive steps change direction
    /// — independent verification for `search_grid_with_turn_cost`'s
    /// tests, the same role `path_cost` plays for the plain/fairway-only
    /// search's own tests.
    fn path_turn_cost(
        path: &[(i32, i32)],
        model: Option<&CostModel>,
        turn_cost_weight: f64,
    ) -> u32 {
        let mut total = 0u32;
        let mut incoming = NO_INCOMING_DIRECTION;
        for w in path.windows(2) {
            let (a, b) = (w[0], w[1]);
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let (dir_idx, &(_, _, base_cost)) = NEIGHBORS_TURN
                .iter()
                .enumerate()
                .find(|&(_, &(ndx, ndy, _))| ndx == dx && ndy == dy)
                .expect("every path step must be one of the 8 grid directions");
            let dir = dir_idx as u8;
            let dist_cost = match model {
                Some(m) => {
                    let ma = combined_multiplier(a, m);
                    let mb = combined_multiplier(b, m);
                    (base_cost as f64 * (ma + mb) / 2.0).ceil().max(1.0) as u32
                }
                None => base_cost,
            };
            let turn_cost = if incoming == NO_INCOMING_DIRECTION {
                0
            } else {
                turn_penalty(angular_steps(incoming, dir), turn_cost_weight)
            };
            total += dist_cost + turn_cost;
            incoming = dir;
        }
        total
    }

    /// Design questions #2/#3's own narrative case, made concrete and
    /// exact: displacement `(4, 2)` on a fully open grid has a true
    /// distance-only optimum of `2 diagonal + 2 orthogonal` steps (octile
    /// distance: `min(4,2)=2` diagonal, `|4-2|=2` remaining orthogonal),
    /// cost `2*1414 + 2*1000 = 4828` — and that composition can be
    /// ARRANGED in more than one order, all tied at exactly this cost,
    /// with different turn counts: grouping the two diagonal steps
    /// together (`D,D,O,O`) costs exactly 1 turn (the single D→O
    /// transition), while alternating them (`O,D,O,D`) costs 3 (every
    /// step changes direction from the last) — a real, EXACT tie in
    /// today's plain distance cost, which is precisely what this module's
    /// own docs mean by "the raw grid path can bend at any 45° step for
    /// free": among cost-tied reorderings, a plain (turn-cost-off) search
    /// has no basis to prefer one over the other, and the actual bug this
    /// whole feature exists to fix is that it doesn't try to.
    ///
    /// No hazard geometry is needed to demonstrate this — it is a
    /// property of the grid's own step-cost structure, not of any
    /// obstacle shape — so this runs on a small, fully open grid, exactly
    /// large enough to contain the `(0,0)` → `(4,2)` displacement.
    #[test]
    fn turn_cost_prefers_the_fewer_turn_arrangement_of_an_exactly_tied_distance_cost() {
        let cols = 5u32;
        let rows = 3u32;
        let grid = Grid {
            cols,
            rows,
            blocked: vec![false; (cols * rows) as usize],
        };
        let start = (0, 0);
        let goal = (4, 2);

        // The two named arrangements, confirmed by direct construction to
        // both reach `goal` from `start` using the same multiset of step
        // types (2 diagonal, 2 orthogonal) — hence, by `path_turn_cost`
        // with `turn_cost_weight = 0.0`, an EXACT cost tie, not merely a
        // close one.
        let smooth = [(0, 0), (1, 1), (2, 2), (3, 2), (4, 2)]; // D, D, O, O — 1 turn
        let zigzag = [(0, 0), (1, 0), (2, 1), (3, 1), (4, 2)]; // O, D, O, D — 3 turns
        assert_eq!(*smooth.last().unwrap(), goal);
        assert_eq!(*zigzag.last().unwrap(), goal);

        let smooth_distance_only = path_turn_cost(&smooth, None, 0.0);
        let zigzag_distance_only = path_turn_cost(&zigzag, None, 0.0);
        assert_eq!(
            smooth_distance_only, 4828,
            "the smooth arrangement's own distance-only cost must be the true octile optimum"
        );
        assert_eq!(
            smooth_distance_only, zigzag_distance_only,
            "both arrangements must be an EXACT distance-cost tie before any turn cost is applied \
             — that tie is the whole premise of this test"
        );

        let turn_cost_weight = 0.5;
        let (found_path, _expansions) =
            search_grid_with_turn_cost(&grid, start, goal, None, turn_cost_weight)
                .expect("reachable on an open grid");

        // The search must not trade away real distance to save a turn —
        // the found path's own distance-only cost must still be the exact
        // tied optimum, not some longer detour that happens to have fewer
        // bends.
        let found_distance_only = path_turn_cost(&found_path, None, 0.0);
        assert_eq!(
            found_distance_only, smooth_distance_only,
            "turn-cost weighting must never sacrifice real distance for a straighter shape: {found_path:?}"
        );

        // And it must be the TRUE turn-charged optimum, not merely A
        // tied-distance path picked by search-order happenstance —
        // verified against brute force, not assumed from the formula
        // alone.
        let found_turn_cost = path_turn_cost(&found_path, None, turn_cost_weight);
        let true_best = brute_force_best_turn_cost(&grid, start, goal, None, turn_cost_weight);
        assert_eq!(
            found_turn_cost, true_best,
            "search_grid_with_turn_cost must find the TRUE turn-charged optimum: {found_path:?}"
        );
        // Which, by hand-derivation above, is exactly the smooth (1-turn)
        // arrangement's own cost — not the zigzag's.
        let smooth_turn_cost = path_turn_cost(&smooth, None, turn_cost_weight);
        let zigzag_turn_cost = path_turn_cost(&zigzag, None, turn_cost_weight);
        assert!(
            zigzag_turn_cost > smooth_turn_cost,
            "sanity: the zigzag arrangement must really cost more once turns are charged"
        );
        assert_eq!(
            found_turn_cost, smooth_turn_cost,
            "the search must land on the fewer-turn arrangement of the tied-distance options: {found_path:?}"
        );
    }

    /// The brute-force admissibility proof, general-purpose: a small grid
    /// with real obstacles (not the hand-picked open-grid tie above) AND a
    /// simultaneous fairway DISCOUNT active — the one cost term whose own
    /// heuristic-scale mechanism (`CostModel::heuristic_scale`) turn cost
    /// must compose correctly with, not just coexist beside in theory.
    /// Confirms directly, not just by the written proof in
    /// `search_grid_with_turn_cost`'s own docs, that adding a turn cost on
    /// top of an ALREADY heuristic-scaled search still finds the true
    /// optimum — same style `heuristic_scale_keeps_the_weighted_search_
    /// exact` and `cable_and_caution_avoidance_need_no_heuristic_change_
    /// to_stay_exact` already established for every other term added this
    /// session.
    #[test]
    fn turn_cost_search_finds_the_true_optimum_with_a_fairway_discount_active() {
        let cols = 5u32;
        let rows = 5u32;
        // A single blocked cell forcing a real detour, off the direct
        // diagonal, so the optimum isn't trivially "just go straight".
        let mut blocked = vec![false; (cols * rows) as usize];
        blocked[(2 * cols + 2) as usize] = true; // (2,2), astride the direct (0,0)->(4,4) diagonal
        let walk_grid = Grid {
            cols,
            rows,
            blocked,
        };

        // A fairway strip along the bottom row — same shape
        // `heuristic_scale_keeps_the_weighted_search_exact` uses.
        let mut fairway_blocked = vec![false; (cols * rows) as usize];
        for x in 0..cols {
            fairway_blocked[(4 * cols + x) as usize] = true;
        }
        let fairway_grid = Grid {
            cols,
            rows,
            blocked: fairway_blocked,
        };

        let corridor = Corridor {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
        };
        let fairway_weight = 0.9;
        let model = CostModel {
            corridor: &corridor,
            cell_size_world: 1.0,
            cell_size_m: 1.0,
            shallow: None,
            lateral_margin: None,
            tss: None,
            fairway: Some((&fairway_grid, fairway_weight)),
            buoyage: None,
            cable: None,
            caution: None,
            survey: None,
            heuristic_scale: 1.0 - fairway_weight,
        };
        let turn_cost_weight = 1.0;

        let (found_path, _expansions) =
            search_grid_with_turn_cost(&walk_grid, (0, 0), (4, 4), Some(&model), turn_cost_weight)
                .expect("reachable around the single blocked cell");
        let found_cost = path_turn_cost(&found_path, Some(&model), turn_cost_weight);
        let true_best =
            brute_force_best_turn_cost(&walk_grid, (0, 0), (4, 4), Some(&model), turn_cost_weight);
        assert_eq!(
            found_cost, true_best,
            "search_grid_with_turn_cost must find the TRUE optimum even with a fairway discount \
             (heuristic_scale < 1.0) active simultaneously: {found_path:?}"
        );
    }

    /// Design question #3/the "off by default" requirement, pinned
    /// directly: `turn_cost_weight = 0.0` must be BYTE-IDENTICAL to a call
    /// that has never heard of turn cost at all — `search_once` takes the
    /// exact old `search_grid` code path whenever the weight is `<= 0.0`
    /// (not merely "a state-expanded search that happens to add zero"),
    /// so this isn't just "the numbers come out the same", it's "the same
    /// code runs". Checked on a real forced-detour scenario (the same
    /// hugged-edge shape `shallow_avoidance_bulges_away_from_a_hugged_
    /// edge_without_a_big_detour` uses), not just open water, so the
    /// comparison exercises the full search — corridor widening, A*,
    /// `simplify_path`, leg verification — not merely the trivial
    /// direct-line fast path.
    #[test]
    fn turn_cost_weight_zero_is_byte_identical_to_no_turn_cost_at_all() {
        let obstacle = rect(54.9, 12.0, 6_000.0, 15_000.0);
        let a = lat_lon_to_world(54.955, 11.9);
        let b = lat_lon_to_world(54.955, 12.1);
        let hazards = [obstacle];

        // `shortest_path` predates this feature entirely and forwards
        // `0.0` for every optional term including `turn_cost_weight` —
        // see its own doc comment/implementation.
        let without = shortest_path(a, b, &hazards).expect("still passable");
        let with_zero_turn_cost = shortest_path_weighted(
            a,
            b,
            &hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable");

        assert_eq!(without.waypoints, with_zero_turn_cost.waypoints);
        assert_eq!(without.distance_m, with_zero_turn_cost.distance_m);
        assert_eq!(
            without.approximate_legs,
            with_zero_turn_cost.approximate_legs
        );
        assert_eq!(
            without.diagnostics.nodes_expanded, with_zero_turn_cost.diagnostics.nodes_expanded,
            "turn_cost_weight=0.0 must expand the exact same number of nodes as no turn cost at \
             all — proof the OLD, unexpanded search_grid ran, not a state-expanded search that \
             merely happens to add zero"
        );
    }

    /// Design question #3/the "off by default" requirement, [`search_grid_
    /// theta_star`]'s own instance: `theta_star = false` must be
    /// BYTE-IDENTICAL to a call that has never heard of Theta* at all —
    /// `search_once` takes the exact old `search_grid` code path whenever
    /// `use_theta_star` is false (not merely "an any-angle search that
    /// happens to reproduce the grid answer"), so this isn't just "the
    /// numbers come out the same", it's "the same code runs". Same
    /// hugged-edge scenario, same reasoning, as `turn_cost_weight_zero_is_
    /// byte_identical_to_no_turn_cost_at_all` above.
    #[test]
    fn theta_star_false_is_byte_identical_to_no_theta_star_at_all() {
        let obstacle = rect(54.9, 12.0, 6_000.0, 15_000.0);
        let a = lat_lon_to_world(54.955, 11.9);
        let b = lat_lon_to_world(54.955, 12.1);
        let hazards = [obstacle];

        let without = shortest_path(a, b, &hazards).expect("still passable");
        let with_theta_star_false = shortest_path_weighted(
            a,
            b,
            &hazards,
            0.0,
            0.0,
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            &[],
            0.0,
            0.0,
            false,
        )
        .expect("still passable");

        assert_eq!(without.waypoints, with_theta_star_false.waypoints);
        assert_eq!(without.distance_m, with_theta_star_false.distance_m);
        assert_eq!(
            without.approximate_legs,
            with_theta_star_false.approximate_legs
        );
        assert_eq!(
            without.diagnostics.nodes_expanded, with_theta_star_false.diagnostics.nodes_expanded,
            "theta_star=false must expand the exact same number of nodes as no theta_star at \
             all — proof the OLD, unexpanded search_grid ran, not search_grid_theta_star merely \
             disabled"
        );
    }

    /// Total real Euclidean length, in CELL units, of a raw cell path —
    /// works for BOTH an ordinary `search_grid` path (every consecutive
    /// pair grid-adjacent) and a `search_grid_theta_star` path (consecutive
    /// pairs can be a non-adjacent shortcut), since it makes no adjacency
    /// assumption at all — the same "treat the raw path as an arbitrary
    /// polyline" contract `search_grid_theta_star`'s own docs establish for
    /// every downstream consumer.
    fn path_len_cells(path: &[(i32, i32)]) -> f64 {
        path.windows(2)
            .map(|w| {
                let dx = (w[1].0 - w[0].0) as f64;
                let dy = (w[1].1 - w[0].1) as f64;
                dx.hypot(dy)
            })
            .sum()
    }

    /// The concrete "an any-angle shortcut beats the grid staircase" proof
    /// design question 1 asked for: open water, zero hazards, a shallow
    /// offset with no clean 0/45/90° ratio — a classic 7-24-25 right
    /// triangle, chosen so the TRUE straight-line optimum is a round
    /// number (`25.0` cell units) checkable by hand, while `search_grid`'s
    /// own 8-connected octile distance (`min(dx,dy)` diagonal steps plus
    /// the remainder orthogonal: `7*sqrt(2) + 17 ≈ 26.8995`) is providably
    /// ~7.6% longer — the exact gap [`octile_heuristic`]'s own admissibility
    /// docs describe as "an ACHIEVABLE grid path length, hence always `>=`
    /// straight-line distance". `search_grid_theta_star` gets the same
    /// grid, same endpoints, and (being open water) an unconditionally
    /// clear line of sight the whole way — its grandparent-shortcut
    /// relaxation should collapse most of that gap.
    #[test]
    fn theta_star_finds_a_genuinely_shorter_path_than_the_grid_staircase_on_open_water() {
        let cols = 30u32;
        let rows = 15u32;
        let grid = Grid {
            cols,
            rows,
            blocked: vec![false; (cols * rows) as usize],
        };
        // Unused by `search_grid`; only `xmin`/`ymin` matter to
        // `search_grid_theta_star`'s own `cell_center` calls, and with no
        // hazard rings at all `visible()` never actually consults any
        // geometry either — so any fixed values work here.
        let corridor = Corridor {
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
        };
        let cell_size_world = 1000.0;
        let start = (2, 2);
        let goal = (26, 9); // dx=24, dy=7 — the 7-24-25 triangle

        let (grid_path, _grid_expansions) =
            search_grid(&grid, start, goal, None).expect("open water is always reachable");
        let (theta_path, _expansions, _visibility_checks) =
            search_grid_theta_star(&grid, start, goal, &corridor, cell_size_world, &[], &[])
                .expect("open water is always reachable");

        let grid_len = path_len_cells(&grid_path);
        let theta_len = path_len_cells(&theta_path);
        let true_straight = 25.0_f64; // sqrt(24^2 + 7^2), exactly

        let expected_grid_len = 7.0 * std::f64::consts::SQRT_2 + 17.0;
        assert!(
            (grid_len - expected_grid_len).abs() < 0.01,
            "sanity: the plain grid staircase must cost the expected octile distance \
             ({expected_grid_len}), got {grid_len}"
        );
        assert!(
            theta_len < grid_len,
            "Theta* must find a strictly shorter path than search_grid's own staircase on open \
             water: theta={theta_len}, grid={grid_len}"
        );
        assert!(
            (theta_len - true_straight) / true_straight < 0.03,
            "Theta* must land within a tight tolerance of the TRUE straight-line optimum \
             ({true_straight} cells) on open water with an unobstructed any-angle shortcut \
             available the whole way, got {theta_len} ({:.2}% over)",
            (theta_len - true_straight) / true_straight * 100.0
        );
    }

    /// A rectangular hazard ring covering GRID CELLS `[x0,x1] x [y0,y1]`
    /// inclusive, exactly aligned to `rasterize`'s own cell-centre
    /// sampling — lets a synthetic Theta* test place obstacles by CELL
    /// coordinate directly rather than through a lat/lon round-trip, since
    /// these tests have no need for real ground scale (only
    /// `search_grid_theta_star`'s own abstract cell-space geometry is
    /// under test). Same "force positive winding" convention `square`/
    /// `rect` above already use.
    fn cell_rect_ring(
        corridor: &Corridor,
        cell_size_world: f64,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
    ) -> Vec<WorldXy> {
        let left = (corridor.xmin as f64 + x0 as f64 * cell_size_world).round() as i32;
        let right = (corridor.xmin as f64 + (x1 + 1) as f64 * cell_size_world).round() as i32;
        let top = (corridor.ymin as f64 + y0 as f64 * cell_size_world).round() as i32;
        let bottom = (corridor.ymin as f64 + (y1 + 1) as f64 * cell_size_world).round() as i32;
        let mut ring = vec![
            WorldXy::new(left, top),
            WorldXy::new(right, top),
            WorldXy::new(right, bottom),
            WorldXy::new(left, bottom),
        ];
        if signed_area2_world(&ring) < 0 {
            ring.reverse();
        }
        ring
    }

    /// Pinned directly by name, referenced from `search_grid_theta_star`'s
    /// own doc comments: real `visible()` calls are bounded by nodes
    /// EXPANDED, never by the ~8x-higher count of relaxation ATTEMPTS (one
    /// per neighbour of every expanded node) — the entire "lazy" in Lazy
    /// Theta*. A moderately hazard-dense sprinkle (not the trivial
    /// open-water case above, where almost no shortcut parent ever
    /// differs from the ordinary one) so the search genuinely attempts —
    /// and sometimes corrects — real shortcuts, not a vacuous zero-check
    /// pass.
    #[test]
    fn lazy_visibility_checks_are_bounded_by_nodes_expanded_not_relaxation_attempts() {
        let cols = 40u32;
        let rows = 40u32;
        let cell_size_world = 1000.0;
        // `rasterize`'s own row-scan prefilters every hazard ring's bbox
        // against `corridor.xmin`/`xmax` directly (see `RingBox::overlaps`
        // call sites) — unlike `search_grid_theta_star`'s own
        // `cell_center` calls, which only ever read `xmin`/`ymin`, this
        // corridor's `xmax`/`ymax` are load-bearing here and must actually
        // span the grid, not a placeholder `0`.
        let corridor = Corridor {
            xmin: 0,
            xmax: (cols as f64 * cell_size_world) as i32,
            ymin: 0,
            ymax: (rows as f64 * cell_size_world) as i32,
        };

        // Deterministic sprinkle of 2x2-cell blocked squares tiling the
        // grid, skipping every 5th (row+col) diagonal so a route always
        // exists — the same "no RNG, still not a trivially passable lane"
        // discipline `routing_raster_perf.rs`'s own `dense_island_field`
        // already uses.
        let mut rings: Vec<Vec<WorldXy>> = Vec::new();
        for row in 0..10 {
            for col in 0..10 {
                if (row + col) % 5 == 0 {
                    continue;
                }
                let x0 = col * 4 + 1;
                let y0 = row * 4 + 1;
                rings.push(cell_rect_ring(
                    &corridor,
                    cell_size_world,
                    x0,
                    y0,
                    x0 + 1,
                    y0 + 1,
                ));
            }
        }
        let bboxes: Vec<RingBox> = rings.iter().map(|r| RingBox::of(r)).collect();
        let grid = rasterize(&rings, &corridor, cell_size_world, cols, rows);

        let start = (0, 0);
        let goal = (cols as i32 - 1, rows as i32 - 1);
        let (_path, expansions, visibility_checks) = search_grid_theta_star(
            &grid,
            start,
            goal,
            &corridor,
            cell_size_world,
            &rings,
            &bboxes,
        )
        .expect("a route through the sprinkle exists");

        // Real measured numbers — relaxation attempts run up to 8 per
        // expansion (one per `NEIGHBORS` entry), so this is the count a
        // non-lazy Theta* would have called `visible()` against instead.
        eprintln!(
            "expansions={expansions}, visibility_checks={visibility_checks}, \
             relaxation_attempts<={}, visibility_checks/expansions={:.3}",
            expansions * 8,
            visibility_checks as f64 / expansions as f64
        );

        assert!(
            visibility_checks <= expansions,
            "each expansion makes AT MOST one real visible() call (only for a shortcut parent) — \
             visibility_checks ({visibility_checks}) must never exceed expansions ({expansions})"
        );
        // A real, non-degenerate measurement — not a vacuous `0 <= 0` pass
        // from a search that never actually attempted a shortcut.
        assert!(
            expansions > 50 && visibility_checks > 0,
            "expected a real search over a hazard-dense field with real shortcuts attempted, \
             got expansions={expansions} visibility_checks={visibility_checks}"
        );
    }

    /// `search_grid_theta_star`'s own edge cost formula, replicated here
    /// (not called directly — it's private to that function's closure) so
    /// this test can independently verify optimality against a reference
    /// computation rather than merely trust the search's own bookkeeping —
    /// same discipline `path_cost`/`path_turn_cost` above already
    /// establish for their own searches.
    fn theta_edge_cost(a: (i32, i32), b: (i32, i32)) -> u32 {
        let dx = (a.0 - b.0) as f64;
        let dy = (a.1 - b.1) as f64;
        (dx.hypot(dy) * ORTHO_COST as f64).round() as u32
    }

    fn theta_path_cost(path: &[(i32, i32)]) -> u32 {
        path.windows(2).map(|w| theta_edge_cost(w[0], w[1])).sum()
    }

    /// Dijkstra over the FULL visibility graph on `grid`'s free cells
    /// (plus `start`/`goal`, always walkable regardless of rasterization —
    /// the same convention `search_grid`/`search_grid_theta_star`
    /// themselves use): an edge exists between any two cells with a clear
    /// `visible()` line of sight between them, at real Euclidean cost.
    /// This IS `search_grid_theta_star`'s own solution space — any
    /// sequence of mutually-visible grid-cell waypoints — with no lazy/
    /// optimistic shortcuts taken, so it is a genuinely exhaustive
    /// reference computation, not a hand-picked comparison, tractable at
    /// the tiny grid size this is used at (`O(n^3)` Dijkstra over `n`
    /// free cells).
    #[allow(clippy::too_many_arguments)]
    fn brute_force_visibility_graph_best_cost(
        grid: &Grid,
        start: (i32, i32),
        goal: (i32, i32),
        corridor: &Corridor,
        cell_size_world: f64,
        hazard_rings: &[Vec<WorldXy>],
        hazard_bboxes: &[RingBox],
    ) -> u32 {
        let is_walkable = |p: (i32, i32)| p == start || p == goal || !grid.blocked(p.0, p.1);
        let mut free: Vec<(i32, i32)> = Vec::new();
        for y in 0..grid.rows as i32 {
            for x in 0..grid.cols as i32 {
                if is_walkable((x, y)) {
                    free.push((x, y));
                }
            }
        }
        let n = free.len();
        let start_i = free.iter().position(|&p| p == start).unwrap();
        let goal_i = free.iter().position(|&p| p == goal).unwrap();
        let mut dist = vec![u32::MAX; n];
        let mut visited = vec![false; n];
        dist[start_i] = 0;
        for _ in 0..n {
            let Some((u, _)) = dist
                .iter()
                .enumerate()
                .filter(|&(i, _)| !visited[i])
                .min_by_key(|&(_, &d)| d)
            else {
                break;
            };
            if dist[u] == u32::MAX {
                break;
            }
            visited[u] = true;
            let a = cell_center(corridor, cell_size_world, free[u]);
            for v in 0..n {
                if visited[v] {
                    continue;
                }
                let b = cell_center(corridor, cell_size_world, free[v]);
                if !visible(a, b, hazard_rings, hazard_bboxes) {
                    continue;
                }
                let cand = dist[u].saturating_add(theta_edge_cost(free[u], free[v]));
                if cand < dist[v] {
                    dist[v] = cand;
                }
            }
        }
        dist[goal_i]
    }

    /// Pinned directly by name, referenced from `search_grid_theta_star`'s
    /// own admissibility-proof doc comments: this is the "does it actually
    /// find the true any-angle optimum" regression, same brute-force-vs-
    /// reference style `heuristic_scale_keeps_the_weighted_search_exact`
    /// already established for the plain grid search.
    ///
    /// **Scope note, found while writing this test** (see the task
    /// report): Lazy Theta*'s grandparent-only shortcut is a real, accepted
    /// scope limit from the source literature (Nash/Koenig/Tovey 2010), not
    /// a bug — it only ever reconsiders ONE hop of ancestry per relaxation,
    /// so it is admissible/never-worse-than-`search_grid` (the module's own
    /// proof above) but is NOT guaranteed to reproduce the full pairwise-
    /// visibility-graph shortest path when reaching the true optimum needs
    /// touching more than one tangent point in sequence. Measured directly
    /// while writing this test: a solid SQUARE obstacle centred between
    /// `start`/`goal` (the same shape
    /// `a_square_obstacle_forces_a_detour_around_one_corner` above already
    /// covers geometrically) actually needs TWO tangent corners to clear —
    /// both the near and far edge of its own width — and cost 10212
    /// against a true visibility-graph optimum of 10152 (~0.6% over): a
    /// real, small, measured gap, not a hypothetical one. This test instead
    /// uses the textbook single-REFLEX-CORNER case (a thin wall hanging
    /// down from the grid's own top edge, one cell wide, so there is
    /// exactly ONE relevant corner — the wall's free bottom tip — between
    /// `start` and `goal`, not two) that a single grandparent shortcut both
    /// CAN and DOES express exactly.
    #[test]
    fn theta_star_finds_the_true_any_angle_optimum_by_brute_force() {
        let cols = 10u32;
        let rows = 10u32;
        let cell_size_world = 1000.0;
        // Same `xmax`/`ymax`-must-actually-span-the-grid note as
        // `lazy_visibility_checks_are_bounded_by_nodes_expanded_not_
        // relaxation_attempts` above — `rasterize`'s own bbox prefilter
        // needs a real corridor, not a `0` placeholder.
        let corridor = Corridor {
            xmin: 0,
            xmax: (cols as f64 * cell_size_world) as i32,
            ymin: 0,
            ymax: (rows as f64 * cell_size_world) as i32,
        };
        // A single-cell-wide wall hanging from the grid's own top edge
        // (y=0) down through row 6 — the only way around it is beneath its
        // free bottom tip at (4,6), a single reflex corner with a clear
        // line of sight to both `start` and `goal` (the wall is only ONE
        // cell wide, so there is no second, far-edge corner to also touch
        // the way a solid square's own opposite edge would need).
        let rings = vec![cell_rect_ring(&corridor, cell_size_world, 4, 0, 4, 6)];
        let bboxes: Vec<RingBox> = rings.iter().map(|r| RingBox::of(r)).collect();
        let grid = rasterize(&rings, &corridor, cell_size_world, cols, rows);

        let start = (0, 4);
        let goal = (9, 4);

        let (theta_path, _expansions, _visibility_checks) = search_grid_theta_star(
            &grid,
            start,
            goal,
            &corridor,
            cell_size_world,
            &rings,
            &bboxes,
        )
        .expect("a way around the obstacle exists");
        let found_cost = theta_path_cost(&theta_path);
        let true_best = brute_force_visibility_graph_best_cost(
            &grid,
            start,
            goal,
            &corridor,
            cell_size_world,
            &rings,
            &bboxes,
        );

        assert_eq!(
            found_cost, true_best,
            "search_grid_theta_star must find the TRUE any-angle optimum over the visibility \
             graph, not merely a plausible any-angle path: found={found_cost} \
             true_best={true_best} path={theta_path:?}"
        );
    }
}
