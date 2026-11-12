// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! The corridor grid, the search over it, and the cost-integrating
//! line-of-sight discipline of §12.3.
//!
//! # Which search, and why
//!
//! A plain **8-connected grid A\*** with corner-cut prevention, followed
//! by a cost-integrating string-pull. NOT an any-angle search (Theta\*/
//! Lazy Theta\*).
//!
//! §12.3's complaint about Lazy Theta\* is not that any-angle search is
//! wrong, it is that its line-of-sight check "asks only 'is the straight
//! line free?' and then charges Euclidean distance, so every soft cost in
//! §10.3 is invisible to the shortcut and the router silently cuts across
//! expensive water". The fix — integrate the cost field along the segment
//! — is what makes an any-angle LOS check expensive, and it is needed
//! ANYWAY for the string-pull in §17. So this MVP pays for it exactly
//! once, in [`Traversal::los`], and uses it only where it buys something:
//! simplification. The dense search itself stays on the grid, where every
//! step's cost is exact by construction and there is no shortcut to get
//! wrong. §12.4's local vector refinement — the thing that would justify
//! any-angle search in the fine stage — is out of scope (see [`super`]).
//!
//! The discipline §12.3 actually demands holds absolutely: **there is no
//! passability-only LOS check anywhere in this module.** [`Traversal::los`]
//! returns the integrated cost or nothing; it has no "is this clear"
//! mode, so a future caller cannot accidentally get one.
//!
//! # Supercover, not centre-sampling
//!
//! §4.4: "A centre-sampling DDA will hop a one-cell diagonal barrier,
//! which is a silent, safety-relevant failure." Two things implement
//! that here:
//!
//! * [`Traversal::los`] walks the segment with an Amanatides–Woo grid
//!   traversal extended at exact corner crossings to visit BOTH
//!   corner-adjacent cells, so no segment slips between two diagonally
//!   touching blocked cells.
//! * The A\* successor rule refuses a diagonal step unless both of its
//!   orthogonal components are also walkable — the same barrier, in the
//!   dense search.
//!
//! That walk itself lives in [`Supercover`], a `pub(crate)` iterator over
//! *cell-unit* coordinates that knows nothing about fields, flags or
//! costs. THREE call sites share it and there is deliberately no second
//! copy of the DDA anywhere in the crate:
//!
//! 1. [`Traversal::los`] — cost-integrating, using each step's
//!    `t_enter`/`t_exit` span.
//! 2. [`stamp_segment`] — mark-only, stamping a ring boundary into this
//!    module's own corridor field.
//! 3. `mivnav::field`'s §4.4 thin-blocking-feature rasterizer, which
//!    needs the identical "every cell the line touches" guarantee on the
//!    persisted artifact's grid.
//!
//! A second, subtly-different copy of a supercover walk is exactly the
//! failure §4.4 warns about: the two would disagree about one diagonal
//! barrier and the disagreement would be invisible.
//!
//! # Grid anchoring
//!
//! The lattice is anchored to a GLOBAL multiple of the cell size in
//! world units, not to the corridor's own `xmin`. §13.1 asks for
//! "canonical endpoints ... two clicks 30 cm apart must produce the same
//! route", which in v3 means snapping to the artifact's own precomputed
//! cell. There is no artifact here, so the closest honest analogue is a
//! lattice that does not move when the query does: with a global anchor,
//! two nearby clicks that resolve to the same ladder rung snap to the
//! same cell centre and produce byte-identical output. A corridor-relative
//! anchor (what `routing::raster` uses) would shift the whole grid by the
//! click delta and defeat the rule entirely.

use std::collections::{BinaryHeap, VecDeque};

use crate::coords::{lat_lon_to_world, sm_from_world, worldx_to_lon, worldy_to_lat, WorldXy};
use crate::routing::hazards::radius_world_units;
use crate::routing::raster::{
    CORRIDOR_PAD_CAP_M, CORRIDOR_PAD_FACTORS, CORRIDOR_PAD_FLOOR_M, HARD_MAX_DIM,
    SHORTCUT_COST_TOLERANCE,
};
use crate::routing::visibility::RingBox;

use super::cost::{heuristic_mm, step_cost_mm, turn_cost_mm, OpenNode};
use super::ladder::{finest_allowed_cell_m, next_coarser_rung};
use super::{ArtifactConstraints, ArtifactWeights};

/// The dimension cap that applies **only** when
/// [`super::ArtifactParams::force_finest_resolution`] is set — the
/// finest-everywhere test oracle. A corridor needing more than this many
/// finest cells on its long side is declined (`build_field` returns
/// `None`) rather than searched, so [`crate::mivnav::reference_route`]
/// answers "too large to brute-force" instead of running out of memory or
/// truncating. `3000` = at most 9 M grid cells (~90 MB of `Field`
/// buffers); a single fixture cell is well under it. Never consulted on a
/// normal request — [`HARD_MAX_DIM`] still bounds those.
pub(super) const FORCE_FINEST_MAX_DIM: u32 = 3000;

// `HARD_MAX_DIM`, `CORRIDOR_PAD_FACTORS`, `CORRIDOR_PAD_FLOOR_M` and
// `CORRIDOR_PAD_CAP_M` are `routing::raster`'s own, imported above rather
// than copy-duplicated at the same literal values — the same "cost is a
// function of grid resolution, not of route length or coastline density"
// bound, and the same corridor-widen ladder `routing::raster`'s own docs
// explain (a very short hop still needs a real corridor; an uncapped pad
// on a 400nm route produces a bbox spanning half the planet). Sharing the
// constant, not just the number, is what keeps the two algorithms'
// worst-case behaviour provably comparable if either is ever retuned.

/// §10.3's "Area to be avoided ... +5.0" as an internal base penalty.
/// The shared `caution_area_avoidance_weight` is ADDED on top rather than
/// multiplied in, so the ATBA tier is always genuinely heavy (a user who
/// has never touched the caution dial still gets §10.3's own figure)
/// while the dial still moves it. A pure multiplication would make an
/// area-to-be-avoided completely free at the config default of `0.0`,
/// which is the opposite of what "heavy soft cost, not blocked" means.
const ATBA_BASE_PENALTY: f64 = 5.0;

/// What a graced leg pays for crossing unknown water. Deliberately large
/// relative to every §10.3 tier: grace exists so a marina berth is
/// REACHABLE, not so unknown water becomes an ordinary shortcut. Bounded
/// (not a hard block) precisely because §9.3 says the first and last legs
/// may pass through it.
const GRACE_UNKNOWN_PENALTY: f64 = 8.0;

// `SHORTCUT_COST_TOLERANCE` is `routing::raster`'s own, imported above —
// same reasoning: generous enough never to reject a shortcut over
// sampling noise, tight enough to still catch a real difference.

// Per-cell flag bits.
const F_HARD: u8 = 1 << 0;
const F_UNKNOWN: u8 = 1 << 1;
const F_CAUTION: u8 = 1 << 2;
const F_CABLE: u8 = 1 << 3;
const F_TSS: u8 = 1 << 4;
const F_PREFERRED: u8 = 1 << 5;
const F_SURVEY: u8 = 1 << 6;
const F_ATBA: u8 = 1 << 7;

// ── The shared supercover walk (§4.4) ─────────────────────────────────

/// One cell a [`Supercover`] walk touches, and how much of the segment
/// lies inside it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SupercoverCell {
    pub x: i32,
    pub y: i32,
    /// Parameter `t ∈ [0, 1]` along `a→b` at which the segment enters
    /// this cell.
    pub t_enter: f64,
    /// …and at which it leaves it. Equal to `t_enter` for the two extra
    /// cells an exact corner crossing visits: those are *touched*, not
    /// traversed, so they carry no length and integrate no cost — while
    /// still being visited, which is the whole point of supercover.
    pub t_exit: f64,
}

impl SupercoverCell {
    /// The fraction of the segment inside this cell, never negative.
    #[inline]
    pub(crate) fn span(&self) -> f64 {
        (self.t_exit - self.t_enter).max(0.0)
    }
}

/// Why a [`Supercover`] walk stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SupercoverEnd {
    /// Not finished yet.
    Running,
    /// Landed on the cell containing `b` — the only successful outcome.
    Reached,
    /// Stepped past `b` without ever landing on its cell. Only reachable
    /// through float slop on a near-axis-aligned segment; the caller
    /// decides whether to stamp [`Supercover::end_cell`] anyway (a
    /// rasterizer does, being conservative) or to refuse (a line-of-sight
    /// check does, having failed to prove the chord clear).
    Overshot,
    /// Ran out of step budget.
    Limit,
}

/// Amanatides–Woo grid traversal of the segment `a→b`, extended at exact
/// corner crossings to visit BOTH corner-adjacent cells — §4.4's
/// supercover rule.
///
/// Coordinates are in **cell units**: the caller has already subtracted
/// its grid origin and divided by its cell size, so this type knows
/// nothing about world coordinates, latitude, flags or cost. That is what
/// lets the corridor search, the corridor rasterizer and the persisted
/// artifact's own rasterizer (`mivnav::field`) share one walk instead of
/// three that drift apart — see the module docs.
///
/// The walk yields the primary cell first, then (on a corner crossing)
/// the two corner-adjacent cells, then continues — the exact visiting
/// ORDER the cost-integrating consumer needs, since it charges the
/// primary cell's span before the corner pair is examined.
pub(crate) struct Supercover {
    cx: i32,
    cy: i32,
    ex: i32,
    ey: i32,
    step_x: i32,
    step_y: i32,
    t_delta_x: f64,
    t_delta_y: f64,
    t_max_x: f64,
    t_max_y: f64,
    t_prev: f64,
    /// Corner-adjacent cells queued by the previous step, emitted before
    /// the walk moves on.
    pending: [Option<(i32, i32)>; 2],
    pending_t: f64,
    budget: usize,
    end: SupercoverEnd,
}

impl Supercover {
    /// Walk `(ax, ay) → (bx, by)`, both in cell units, for at most
    /// `limit` primary cells.
    pub(crate) fn new(ax: f64, ay: f64, bx: f64, by: f64, limit: usize) -> Supercover {
        let (dx, dy) = (bx - ax, by - ay);
        let cx = ax.floor() as i32;
        let cy = ay.floor() as i32;
        let sign = |d: f64| {
            if d > 0.0 {
                1
            } else if d < 0.0 {
                -1
            } else {
                0
            }
        };
        let step_x = sign(dx);
        let step_y = sign(dy);
        let t_max_x = match step_x {
            1 => ((cx + 1) as f64 - ax) / dx,
            -1 => (cx as f64 - ax) / dx,
            _ => f64::MAX,
        };
        let t_max_y = match step_y {
            1 => ((cy + 1) as f64 - ay) / dy,
            -1 => (cy as f64 - ay) / dy,
            _ => f64::MAX,
        };
        Supercover {
            cx,
            cy,
            ex: bx.floor() as i32,
            ey: by.floor() as i32,
            step_x,
            step_y,
            t_delta_x: if dx != 0.0 {
                (1.0 / dx).abs()
            } else {
                f64::MAX
            },
            t_delta_y: if dy != 0.0 {
                (1.0 / dy).abs()
            } else {
                f64::MAX
            },
            t_max_x,
            t_max_y,
            t_prev: 0.0,
            pending: [None, None],
            pending_t: 0.0,
            budget: limit,
            end: SupercoverEnd::Running,
        }
    }

    /// How the walk ended. [`SupercoverEnd::Running`] until it has.
    pub(crate) fn end(&self) -> SupercoverEnd {
        self.end
    }

    /// The cell containing `b`, whether or not the walk reached it.
    pub(crate) fn end_cell(&self) -> (i32, i32) {
        (self.ex, self.ey)
    }
}

impl Iterator for Supercover {
    type Item = SupercoverCell;

    fn next(&mut self) -> Option<SupercoverCell> {
        for slot in self.pending.iter_mut() {
            if let Some((x, y)) = slot.take() {
                return Some(SupercoverCell {
                    x,
                    y,
                    t_enter: self.pending_t,
                    t_exit: self.pending_t,
                });
            }
        }
        if self.end != SupercoverEnd::Running {
            return None;
        }
        if self.budget == 0 {
            self.end = SupercoverEnd::Limit;
            return None;
        }
        self.budget -= 1;

        let at_end = self.cx == self.ex && self.cy == self.ey;
        let t_next = if at_end {
            1.0
        } else {
            self.t_max_x.min(self.t_max_y).min(1.0)
        };
        let cell = SupercoverCell {
            x: self.cx,
            y: self.cy,
            t_enter: self.t_prev,
            t_exit: t_next,
        };
        if at_end {
            self.end = SupercoverEnd::Reached;
            return Some(cell);
        }
        self.t_prev = t_next;

        // An exact corner crossing: queue BOTH corner-adjacent cells
        // before stepping diagonally, so no segment slips between two
        // diagonally touching blocked cells (§4.4).
        if (self.t_max_x - self.t_max_y).abs() <= f64::EPSILON * 8.0 {
            self.pending = [
                Some((self.cx + self.step_x, self.cy)),
                Some((self.cx, self.cy + self.step_y)),
            ];
            self.pending_t = t_next;
            self.cx += self.step_x;
            self.cy += self.step_y;
            self.t_max_x += self.t_delta_x;
            self.t_max_y += self.t_delta_y;
        } else if self.t_max_x < self.t_max_y {
            self.cx += self.step_x;
            self.t_max_x += self.t_delta_x;
        } else {
            self.cy += self.step_y;
            self.t_max_y += self.t_delta_y;
        }
        if self.t_max_x.min(self.t_max_y) > 1.0 && !(self.cx == self.ex && self.cy == self.ey) {
            self.end = SupercoverEnd::Overshot;
        }
        Some(cell)
    }
}

/// A padded box around `from`/`to`.
#[derive(Clone, Copy)]
struct Corridor {
    xmin: i32,
    xmax: i32,
    ymin: i32,
    ymax: i32,
}

impl Corridor {
    fn centre(&self) -> WorldXy {
        WorldXy::new(
            ((self.xmin as i64 + self.xmax as i64) / 2) as i32,
            ((self.ymin as i64 + self.ymax as i64) / 2) as i32,
        )
    }
}

/// The distinct `(pad_factor_index, pad_m)` attempts for a route of this
/// length — two factors can clamp to the identical pad, and rebuilding a
/// byte-identical grid twice changes nothing but the clock. Same dedup
/// `routing::raster::widen_attempts_for` performs.
fn widen_attempts(from: WorldXy, to: WorldXy) -> Vec<(u32, f64)> {
    let (ex, ey) = sm_from_world(to, from);
    let direct_m = (ex * ex + ey * ey).sqrt();
    let mut out: Vec<(u32, f64)> = Vec::with_capacity(CORRIDOR_PAD_FACTORS.len());
    for (i, &f) in CORRIDOR_PAD_FACTORS.iter().enumerate() {
        let pad = (direct_m * f).clamp(CORRIDOR_PAD_FLOOR_M, CORRIDOR_PAD_CAP_M);
        if out.last().map(|&(_, p)| p) != Some(pad) {
            out.push((i as u32, pad));
        }
    }
    out
}

/// The flag/cost grid plus everything needed to map between world
/// coordinates and cell ids.
pub(super) struct Field {
    pub cols: u32,
    pub rows: u32,
    /// Global lattice anchor (see the module docs).
    origin_x: i32,
    origin_y: i32,
    /// Cell size in world units — an INTEGER, so the lattice does not
    /// drift with float noise between two nearly-identical queries.
    cell_world: i32,
    pub cell_size_m: f64,
    /// The §4.1/§4.2 rung this corridor actually searched at.
    pub ladder_cell_m: f64,
    /// The rung §4.1 alone asked for, before the cell budget forced
    /// anything coarser — a diagnostic, so "why is this channel closed"
    /// is answerable (v3 §18's resolution overlay, in one number).
    pub finest_allowed_cell_m: f64,
    flags: Vec<u8>,
    /// Per-cell `1 + Σ penalty`, already floored — precomputed once so
    /// the search and the LOS integrator cannot disagree about it.
    mult: Vec<f64>,
    /// Cells where §9.3 grace applies (within the grace radius of a
    /// requested endpoint).
    graced: Vec<bool>,
    lowest_mult: f64,
    ground_scale: f64,
}

impl Field {
    #[inline]
    fn id(&self, x: i32, y: i32) -> u32 {
        y as u32 * self.cols + x as u32
    }

    #[inline]
    fn in_range(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as u32) < self.cols && (y as u32) < self.rows
    }

    /// Out-of-range is NOT walkable — never a valid move off the grid,
    /// the same convention `routing::raster::Grid::blocked` uses.
    #[inline]
    pub(super) fn walkable(&self, x: i32, y: i32) -> bool {
        if !self.in_range(x, y) {
            return false;
        }
        let i = self.id(x, y) as usize;
        let f = self.flags[i];
        if f & F_HARD != 0 {
            return false;
        }
        f & F_UNKNOWN == 0 || self.graced[i]
    }

    #[inline]
    fn unknown(&self, x: i32, y: i32) -> bool {
        self.in_range(x, y) && self.flags[self.id(x, y) as usize] & F_UNKNOWN != 0
    }

    #[inline]
    fn multiplier(&self, x: i32, y: i32) -> f64 {
        if !self.in_range(x, y) {
            return 1.0;
        }
        self.mult[self.id(x, y) as usize]
    }

    pub(super) fn cell_of(&self, p: WorldXy) -> (i32, i32) {
        let cx = (p.x as i64 - self.origin_x as i64).div_euclid(self.cell_world as i64) as i32;
        let cy = (p.y as i64 - self.origin_y as i64).div_euclid(self.cell_world as i64) as i32;
        (
            cx.clamp(0, self.cols as i32 - 1),
            cy.clamp(0, self.rows as i32 - 1),
        )
    }

    /// The CENTRE of a cell — §13.1's canonical endpoint, and the only
    /// coordinate this algorithm ever emits as a waypoint.
    pub(super) fn centre_of(&self, cell: (i32, i32)) -> WorldXy {
        WorldXy::new(
            self.origin_x + cell.0 * self.cell_world + self.cell_world / 2,
            self.origin_y + cell.1 * self.cell_world + self.cell_world / 2,
        )
    }

    fn blocked_count(&self) -> u32 {
        self.flags.iter().filter(|f| *f & F_HARD != 0).count() as u32
    }

    fn unknown_count(&self) -> u32 {
        self.flags.iter().filter(|f| *f & F_UNKNOWN != 0).count() as u32
    }

    /// One byte per cell, row-major from the NORTH-WEST corner (world Y
    /// increases southward, so row 0 is the northernmost) — the debug
    /// overlay's raster. See [`FieldSnapshot`].
    fn debug_codes(&self) -> Vec<u8> {
        (0..self.flags.len() as u32)
            .map(|i| {
                let f = self.flags[i as usize];
                if f & F_HARD != 0 {
                    DBG_HARD
                } else if f & F_UNKNOWN != 0 {
                    if self.graced[i as usize] {
                        DBG_UNKNOWN_GRACED
                    } else {
                        DBG_UNKNOWN_BLOCKED
                    }
                } else if self.mult[i as usize] > 1.0 + 1e-9 {
                    DBG_SOFT
                } else {
                    DBG_OPEN
                }
            })
            .collect()
    }

    /// The four cell-grid corners as `(lon, lat)`, in MapLibre image-source
    /// order: NW, NE, SE, SW.
    fn debug_corners(&self) -> [(f64, f64); 4] {
        let x_lo = self.origin_x;
        let x_hi = self.origin_x + self.cols as i32 * self.cell_world;
        let y_lo = self.origin_y; // north
        let y_hi = self.origin_y + self.rows as i32 * self.cell_world; // south
        let ll = |x: i32, y: i32| (worldx_to_lon(x), worldy_to_lat(y));
        [
            ll(x_lo, y_lo),
            ll(x_hi, y_lo),
            ll(x_hi, y_hi),
            ll(x_lo, y_hi),
        ]
    }
}

/// [`Field::debug_codes`] cell classes.
pub(super) const DBG_OPEN: u8 = 0;
pub(super) const DBG_HARD: u8 = 1;
pub(super) const DBG_UNKNOWN_BLOCKED: u8 = 2;
pub(super) const DBG_UNKNOWN_GRACED: u8 = 3;
pub(super) const DBG_SOFT: u8 = 4;

/// The largest cell count [`search_debug`] will serialise a raster for.
/// A normal corridor tops out at `HARD_MAX_DIM² ≈ 810 k` cells (one byte
/// each), which is fine for an opt-in debug call on the boat LAN; this
/// only guards the `force_finest` oracle path, which nothing served
/// reaches. Above it the reason and dimensions still come back, just no
/// `codes`.
const DBG_MAX_CELLS: usize = 1_000_000;

/// A snapshot of one built [`Field`] for the debug overlay.
pub(crate) struct FieldSnapshot {
    pub cols: u32,
    pub rows: u32,
    pub cell_size_m: f64,
    /// NW, NE, SE, SW as `(lon, lat)`.
    pub corners: [(f64, f64); 4],
    /// `cols * rows` bytes, row-major from the NW corner. Empty when the
    /// grid exceeded [`DBG_MAX_CELLS`].
    pub codes: Vec<u8>,
    /// The snapped start/goal cell as `(col, row)`, or `None` when that
    /// endpoint had no walkable cell within the grace radius.
    pub start_cell: Option<(u32, u32)>,
    pub goal_cell: Option<(u32, u32)>,
}

/// What [`search`] would do for this request, and — when it would fail —
/// which of its four failure points fired, plus the field it got that far
/// with. Runs the SAME first corridor attempt `search` uses; it does not
/// widen, because `search` itself gives up on the first `astar` miss.
pub(crate) struct SearchDebug {
    /// `"ok"` · `"no_field"` · `"start_blocked"` · `"goal_blocked"` ·
    /// `"severed"` (a walkable start and goal with no walkable path
    /// between them) · `"grid_too_large"`.
    pub reason: &'static str,
    pub field: Option<FieldSnapshot>,
    pub start_snap_m: f64,
    pub goal_snap_m: f64,
}

pub(crate) fn search_debug(
    from: WorldXy,
    to: WorldXy,
    constraints: &ArtifactConstraints,
    weights: &ArtifactWeights,
    grace_radius_m: f64,
    force_finest: bool,
) -> SearchDebug {
    let reversed = (to.x, to.y) < (from.x, from.y);
    let (a, b) = if reversed { (to, from) } else { (from, to) };

    for (_, pad_m) in widen_attempts(a, b) {
        let corridor = corridor_with_pad(a, b, pad_m);
        let Some(field) = build_field(
            &corridor,
            constraints,
            weights,
            a,
            b,
            grace_radius_m,
            force_finest,
        ) else {
            continue;
        };

        let max_ground_m = grace_radius_m.max(0.0);
        let start = nearest_walkable(&field, field.cell_of(a), a, max_ground_m);
        let goal = nearest_walkable(&field, field.cell_of(b), b, max_ground_m);

        let n = field.cols as usize * field.rows as usize;
        let snapshot = FieldSnapshot {
            cols: field.cols,
            rows: field.rows,
            cell_size_m: field.cell_size_m,
            corners: field.debug_corners(),
            codes: if n <= DBG_MAX_CELLS {
                field.debug_codes()
            } else {
                Vec::new()
            },
            start_cell: start.map(|(x, y)| (x as u32, y as u32)),
            goal_cell: goal.map(|(x, y)| (x as u32, y as u32)),
        };
        let start_snap_m = start
            .map(|c| ground_distance_m(a, field.centre_of(c), field.ground_scale))
            .unwrap_or(f64::NAN);
        let goal_snap_m = goal
            .map(|c| ground_distance_m(b, field.centre_of(c), field.ground_scale))
            .unwrap_or(f64::NAN);

        let reason = match (start, goal) {
            (None, _) => "start_blocked",
            (_, None) => "goal_blocked",
            (Some(s), Some(g)) if s == g => "ok",
            (Some(s), Some(g)) if astar(&field, s, g).is_some() => "ok",
            _ => "severed",
        };
        let reason = if snapshot.codes.is_empty() && n > DBG_MAX_CELLS {
            "grid_too_large"
        } else {
            reason
        };
        return SearchDebug {
            reason,
            field: Some(snapshot),
            start_snap_m,
            goal_snap_m,
        };
    }
    SearchDebug {
        reason: "no_field",
        field: None,
        start_snap_m: f64::NAN,
        goal_snap_m: f64::NAN,
    }
}

/// Build the field for one corridor attempt.
#[allow(clippy::too_many_arguments)]
fn build_field(
    corridor: &Corridor,
    constraints: &ArtifactConstraints,
    weights: &ArtifactWeights,
    from: WorldXy,
    to: WorldXy,
    grace_radius_m: f64,
    force_finest: bool,
) -> Option<Field> {
    let centre = corridor.centre();
    let ground_scale = worldy_to_lat(centre.y).to_radians().cos();
    let (x0, y0) = sm_from_world(WorldXy::new(corridor.xmin, corridor.ymin), centre);
    let (x1, y1) = sm_from_world(WorldXy::new(corridor.xmax, corridor.ymax), centre);
    let span_x_m = ((x1 - x0).abs() * ground_scale).max(1.0);
    let span_y_m = ((y1 - y0).abs() * ground_scale).max(1.0);
    let long_span_m = span_x_m.max(span_y_m);

    // §4.1/§4.2: start at the finest rung the SOURCE allows, then step
    // COARSER along the ladder until the corridor fits the cell budget.
    // Only when even the top rung cannot is the ladder abandoned — a
    // budget decision, never a resolution-policy one.
    let finest = finest_allowed_cell_m(
        constraints.compilation_scale,
        constraints.catzoc_horizontal_m,
    );
    // §4.1/§4.2 coarsening, UNLESS a test oracle asked for finest
    // everywhere (`ArtifactParams::force_finest_resolution`). In that
    // mode a corridor that would need more than `FORCE_FINEST_MAX_DIM`
    // cells on a side is declined outright — a finest brute force at that
    // size is an OOM, not an oracle — rather than silently truncated at
    // the dimension clamp below.
    let mut ladder_cell_m = finest;
    if !force_finest {
        while long_span_m / ladder_cell_m > HARD_MAX_DIM as f64 {
            match next_coarser_rung(ladder_cell_m) {
                Some(next) => ladder_cell_m = next,
                None => break,
            }
        }
    } else if long_span_m / finest > FORCE_FINEST_MAX_DIM as f64 {
        return None;
    }
    let dim_cap = if force_finest {
        FORCE_FINEST_MAX_DIM
    } else {
        HARD_MAX_DIM
    };
    let cell_size_m = if force_finest {
        finest
    } else {
        ladder_cell_m.max(long_span_m / HARD_MAX_DIM as f64)
    };

    // Integer cell size in world units, anchored to a global multiple of
    // itself — see the module docs.
    let cell_world = (radius_world_units(centre, cell_size_m).round() as i32).max(1);
    let origin_x = (corridor.xmin as i64).div_euclid(cell_world as i64) as i32 * cell_world;
    let origin_y = (corridor.ymin as i64).div_euclid(cell_world as i64) as i32 * cell_world;
    let cols = (((corridor.xmax - origin_x) as f64 / cell_world as f64).ceil() as u32 + 1)
        .clamp(1, dim_cap);
    let rows = (((corridor.ymax - origin_y) as f64 / cell_world as f64).ceil() as u32 + 1)
        .clamp(1, dim_cap);

    let n = cols as usize * rows as usize;
    let mut field = Field {
        cols,
        rows,
        origin_x,
        origin_y,
        cell_world,
        cell_size_m,
        ladder_cell_m,
        finest_allowed_cell_m: finest,
        flags: vec![0u8; n],
        mult: vec![1.0; n],
        graced: vec![false; n],
        lowest_mult: 1.0,
        ground_scale,
    };

    for (rings, bit) in [
        (&constraints.hard, F_HARD),
        // `constraints.unsurveyed` is dead — `build_one_cell`'s `UNSARE`
        // arm stopped filling it when charted-depth tiers replaced the
        // survey-quality block. `F_UNKNOWN` now comes only from the
        // coverage complement below (genuine absent `M_COVR`). Left as
        // an empty pass rather than removed, so re-enabling an
        // `unsurveyed`-blocking rule later is a one-line change.
        (&constraints.unsurveyed, F_UNKNOWN),
        (&constraints.caution, F_CAUTION),
        (&constraints.cable, F_CABLE),
        (&constraints.tss, F_TSS),
        (&constraints.preferred, F_PREFERRED),
        (&constraints.survey, F_SURVEY),
        (&constraints.atba, F_ATBA),
    ] {
        rasterize_into(&mut field, rings, bit);
    }

    // Absent coverage is unknown water — but only when SOME cell
    // actually made a coverage statement. With none, the rule has no
    // ground to stand on and marking the whole corridor unknown would be
    // inventing a claim no chart made.
    //
    // `F_UNKNOWN` alone would hard-block it (`walkable`: only graced
    // `F_UNKNOWN` is passable). A cell outside `M_COVR` that STILL has a
    // real charted `DEPARE` depth under it (`constraints.charted_depth` —
    // ~⅓ of the o-charts DK base region, depth bled in from a coarse
    // overview cell) is instead marked `graced` so it is passable at the
    // `GRACE_UNKNOWN_PENALTY` cost, matching the "route on charted depth,
    // not on the coverage declaration" call `bands::BAND_BLOCKING_FLAGS`
    // makes for the topology. A no-coverage cell with NO charted depth
    // stays hard-blocked.
    if !constraints.coverage.is_empty() {
        let mut covered = Field {
            flags: vec![0u8; n],
            ..clone_shape(&field)
        };
        rasterize_into(&mut covered, &constraints.coverage, F_HARD);
        // Only rasterize the (corridor-wide, potentially thousands of
        // rings on a Danish corridor) charted-depth set when there is
        // one AND some cell is actually uncovered — a corridor wholly
        // inside `M_COVR` never reads it. Same guard shape as the
        // `depth_avoid`/`depth_soft` scratch passes above.
        let any_uncovered = (0..n).any(|i| covered.flags[i] & F_HARD == 0);
        let charted = (any_uncovered && !constraints.charted_depth.is_empty()).then(|| {
            let mut s = Field {
                flags: vec![0u8; n],
                ..clone_shape(&field)
            };
            rasterize_into(&mut s, &constraints.charted_depth, F_HARD);
            s.flags
        });
        for i in 0..n {
            if covered.flags[i] & F_HARD == 0 {
                field.flags[i] |= F_UNKNOWN;
                if charted.as_ref().is_some_and(|c| c[i] & F_HARD != 0) {
                    field.graced[i] = true;
                }
            }
        }
    }

    // §9.3: grace is anchored to the REQUESTED endpoints, not to every
    // endpoint the search happens to touch.
    //
    // Bounded to a box around each anchor sized by the grace radius
    // itself, not a full grid scan: on a corridor near `HARD_MAX_DIM`
    // (900×900 = 810,000 cells), the default 150m radius covers only a
    // few hundred to ~1,100 cells, so scanning every cell for both
    // anchors was ~2 orders of magnitude more work than needed — on a
    // Raspberry Pi, where CPU (not storage or bandwidth) is what's
    // constrained, per this project's own conventions.
    let grace_world = radius_world_units(centre, grace_radius_m.max(0.0));
    if grace_world > 0.0 {
        let r2 = grace_world * grace_world;
        let radius_cells = (grace_world / field.cell_world as f64).ceil() as i32;
        for anchor in [from, to] {
            let (acx, acy) = field.cell_of(anchor);
            let rx_lo = (acx - radius_cells).max(0);
            let rx_hi = (acx + radius_cells).min(cols as i32 - 1);
            let ry_lo = (acy - radius_cells).max(0);
            let ry_hi = (acy + radius_cells).min(rows as i32 - 1);
            for ry in ry_lo..=ry_hi {
                for rx in rx_lo..=rx_hi {
                    let c = field.centre_of((rx, ry));
                    let dx = (c.x - anchor.x) as f64;
                    let dy = (c.y - anchor.y) as f64;
                    if dx * dx + dy * dy <= r2 {
                        let i = field.id(rx, ry) as usize;
                        field.graced[i] = true;
                    }
                }
            }
        }
    }

    // §6 charted-depth tiers. Two scratch rasterizations (same
    // scratch-`Field` + `rasterize_into(_, _, F_HARD)` shape the coverage
    // complement above uses), read per cell in the multiplier loop.
    // Nested at query time: a cell in `depth_avoid` gets ONLY the heavy
    // weight even though its polygon is a subset of nothing here — the
    // tiers were made exclusive back in `constraints::build_one_cell`.
    // Skip the whole scratch pass when the weight is zero — a threshold
    // set with no weight would rasterize a `HARD_MAX_DIM` grid for a
    // `m += 0.0` that does nothing.
    let depth_avoid = (weights.avoid_depth_weight != 0.0 && !constraints.depth_avoid.is_empty())
        .then(|| {
            let mut s = Field {
                flags: vec![0u8; n],
                ..clone_shape(&field)
            };
            rasterize_into(&mut s, &constraints.depth_avoid, F_HARD);
            s.flags
        });
    let depth_soft = (weights.prefer_depth_weight != 0.0 && !constraints.depth_soft.is_empty())
        .then(|| {
            let mut s = Field {
                flags: vec![0u8; n],
                ..clone_shape(&field)
            };
            rasterize_into(&mut s, &constraints.depth_soft, F_HARD);
            s.flags
        });

    let mut lowest = f64::INFINITY;
    for i in 0..n {
        let f = field.flags[i];
        let mut m = 1.0;
        if f & F_CAUTION != 0 {
            m += weights.caution_area_avoidance_weight;
        }
        if f & F_CABLE != 0 {
            m += weights.cable_avoidance_weight;
        }
        if f & F_TSS != 0 {
            m += weights.tss_avoidance_weight;
        }
        if f & F_SURVEY != 0 {
            m += weights.low_confidence_survey_avoidance_weight;
        }
        if f & F_PREFERRED != 0 {
            m -= weights.fairway_preference_weight;
        }
        if f & F_ATBA != 0 {
            m += ATBA_BASE_PENALTY + weights.caution_area_avoidance_weight;
        }
        if f & F_UNKNOWN != 0 {
            m += GRACE_UNKNOWN_PENALTY;
        }
        // Charted-depth tiers — only where nothing hard already blocks.
        if f & F_HARD == 0 {
            if depth_avoid.as_ref().is_some_and(|s| s[i] & F_HARD != 0) {
                m += weights.avoid_depth_weight;
            } else if depth_soft.as_ref().is_some_and(|s| s[i] & F_HARD != 0) {
                m += weights.prefer_depth_weight;
            }
        }
        let m = m.max(super::cost::MIN_MULTIPLIER);
        field.mult[i] = m;
        if m < lowest {
            lowest = m;
        }
    }
    field.lowest_mult = if lowest.is_finite() { lowest } else { 1.0 };
    Some(field)
}

/// A same-shape, empty-flags `Field` — for the throwaway coverage
/// rasterization above, which needs the identical lattice but none of the
/// derived state.
fn clone_shape(f: &Field) -> Field {
    Field {
        cols: f.cols,
        rows: f.rows,
        origin_x: f.origin_x,
        origin_y: f.origin_y,
        cell_world: f.cell_world,
        cell_size_m: f.cell_size_m,
        ladder_cell_m: f.ladder_cell_m,
        finest_allowed_cell_m: f.finest_allowed_cell_m,
        flags: Vec::new(),
        mult: Vec::new(),
        graced: Vec::new(),
        lowest_mult: 1.0,
        ground_scale: f.ground_scale,
    }
}

/// Nonzero-winding scanline fill of `rings` onto the `(cols, rows)` grid
/// anchored at `(origin_x, origin_y)` with `cell_world`-sized cells,
/// reporting every filled run as `(row, col_start, col_end)` — `col_end`
/// exclusive — instead of writing anywhere itself.
///
/// The crossing sign is **per EDGE**, not per ring — copy-adapted from
/// `routing::raster::rasterize`, whose own docs record the real bug a
/// per-RING sign produced (a winding number that never closes across a
/// ring's own two crossings). Handing back spans rather than filling a
/// specific buffer is what lets `mivnav::field`'s artifact rasterizer
/// share this exact fill (it writes three SoA columns, not one flag
/// array) instead of carrying a fourth near-copy of the same scanline.
pub(crate) fn scanline_spans(
    rings: &[Vec<WorldXy>],
    origin_x: i32,
    origin_y: i32,
    cell_world: i32,
    cols: u32,
    rows: u32,
    mut span: impl FnMut(u32, u32, u32),
) {
    if rings.is_empty() || cols == 0 || rows == 0 || cell_world <= 0 {
        return;
    }
    let boxes: Vec<RingBox> = rings.iter().map(|r| RingBox::of(r)).collect();
    let cw = cell_world as f64;
    let ox = origin_x as f64;
    let xmax_world = origin_x.saturating_add((cols as i32).saturating_mul(cell_world));
    for ry in 0..rows {
        let y = origin_y as f64 + (ry as f64 + 0.5) * cw;
        let (y_lo, y_hi) = (y.floor() as i32, y.ceil() as i32);
        let mut crossings: Vec<(f64, i32)> = Vec::new();
        for (ring, bb) in rings.iter().zip(&boxes) {
            if !bb.overlaps(origin_x, xmax_world, y_lo, y_hi) {
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
                    crossings.push((x, if by > ay { 1 } else { -1 }));
                }
            }
        }
        if crossings.is_empty() {
            continue;
        }
        crossings.sort_by(|p, q| p.0.total_cmp(&q.0));
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
                    if x <= ox {
                        continue;
                    }
                    let col_start = ((start - ox) / cw).floor().max(0.0) as u32;
                    let col_end = (((x - ox) / cw).ceil().max(0.0) as u32).min(cols);
                    if col_start < col_end {
                        span(ry, col_start, col_end);
                    }
                }
            }
        }
    }
}

/// Scanline-fill `rings` into `bit`, then stamp their boundaries.
fn rasterize_into(field: &mut Field, rings: &[Vec<WorldXy>], bit: u8) {
    if rings.is_empty() || field.cols == 0 || field.rows == 0 {
        return;
    }
    let (cols, rows) = (field.cols, field.rows);
    let (origin_x, origin_y, cell_world) = (field.origin_x, field.origin_y, field.cell_world);
    let flags = &mut field.flags;
    scanline_spans(
        rings,
        origin_x,
        origin_y,
        cell_world,
        cols,
        rows,
        |row, col_start, col_end| {
            let base = (row * cols) as usize;
            for c in col_start..col_end {
                flags[base + c as usize] |= bit;
            }
        },
    );

    // §4.4, and the property that makes conservative rasterization plus
    // supercover LOS actually SOUND rather than merely careful: every
    // cell a ring's BOUNDARY touches is stamped too, not only the cells
    // whose centre the interior covers.
    //
    // The scanline pass above is a centre-sample fill, so a hazard can
    // poke into a cell without covering its centre — and then a chord
    // between two "free" cell centres crosses real hazard geometry while
    // every cell it visits reads clear. That is the exact gap
    // `routing::raster` lives with (its `approximate_legs` mechanism
    // exists partly to report it). Stamping the boundary closes it: a
    // chord can only cross a ring inside a cell the ring's boundary
    // passes through, `Traversal::los` visits every cell a chord touches
    // (supercover), so a crossing chord is always rejected. The same
    // argument covers the dense A* path, whose steps lie inside the union
    // of two adjacent cells.
    //
    // It is also what makes a THIN feature exist at all — a breakwater
    // narrower than one cell has no interior to fill, and §4.4 calls its
    // disappearance the specific silent failure to avoid.
    //
    // Applied to the SOFT bits as well, where it merely grows a
    // preference zone by one cell (harmless), and to the coverage bit,
    // where it grows the COVERED area by one cell — mildly
    // anti-conservative, and deliberately accepted: one cell of chart
    // edge is far inside the §9.3 grace radius that already governs the
    // uncharted boundary.
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            stamp_segment(field, bit, ring[i], ring[(i + 1) % n]);
        }
    }
}

/// Stamp every cell the segment `a`→`b` touches — the shared
/// [`Supercover`] walk, mark-only (no cost integration).
fn stamp_segment(field: &mut Field, bit: u8, a: WorldXy, b: WorldXy) {
    let cw = field.cell_world as f64;
    // A ring edge can be far longer than the corridor; the traversal is
    // bounded by the grid it can actually reach, plus corner slack.
    let limit = 4 * (field.cols + field.rows) as usize + 8;
    let mut walk = Supercover::new(
        (a.x - field.origin_x) as f64 / cw,
        (a.y - field.origin_y) as f64 / cw,
        (b.x - field.origin_x) as f64 / cw,
        (b.y - field.origin_y) as f64 / cw,
        limit,
    );
    let set = |field: &mut Field, x: i32, y: i32| {
        if field.in_range(x, y) {
            let i = field.id(x, y) as usize;
            field.flags[i] |= bit;
        }
    };
    for c in &mut walk {
        set(field, c.x, c.y);
    }
    if walk.end() == SupercoverEnd::Overshot {
        // Past the far endpoint (only reachable through float slop) —
        // stamp it anyway, the conservative direction for a rasterizer.
        let (ex, ey) = walk.end_cell();
        set(field, ex, ey);
    }
}

/// §4.4's corner-cut rule: refuse a diagonal step unless BOTH orthogonal
/// neighbours it would cut across are also navigable. Not diagonal at
/// all (`is_diagonal = false`) always passes — this predicate exists
/// only to gate the diagonal case.
///
/// Shared by this module's own `astar` successor rule below and
/// `mivnav::topology::union_within_tile`'s identical rule over the
/// persisted artifact's own grid: that module's docs say "one rule,
/// defined once, used by both", and a copy-pasted boolean check is
/// exactly the kind of thing that quietly stops being one rule the next
/// time either side gets edited.
pub(crate) fn diagonal_step_allowed(
    is_diagonal: bool,
    orth_a_navigable: bool,
    orth_b_navigable: bool,
) -> bool {
    !is_diagonal || (orth_a_navigable && orth_b_navigable)
}

/// 8-connected neighbour offsets, in a FIXED order — the search never
/// depends on it (the open set is totally ordered, §13.1) but a fixed
/// order keeps the expansion trace itself reproducible for debugging.
const NEIGHBORS_8: [(i32, i32); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];

/// The nearest walkable cell to `anchor` (the ACTUAL requested endpoint,
/// not `start`'s own discretized cell), never farther than `max_ground_m`
/// true ground metres — §9.3's "if the endpoint itself is on land or
/// inside a blocking feature, snap to the nearest navigable cell within
/// the radius".
///
/// BFS over grid steps, but grid steps are Chebyshev distance and the
/// radius is a real-world circle: an 8-connected step bound alone would
/// accept a diagonal cell up to `sqrt(2)` times farther than
/// `max_ground_m`, silently blowing the configured grace radius. So the
/// step count only bounds how far the search LOOKS (`max_ground_m /
/// cell_size_m` steps is provably enough — Chebyshev distance never
/// exceeds Euclidean distance, so every cell within `max_ground_m` of
/// `anchor` is reached within that many steps); the actual ACCEPTANCE
/// test is the true ground distance from `anchor`, checked per candidate.
/// Neighbours are visited in [`NEIGHBORS_8`] order, which keeps the
/// answer deterministic even when several cells tie on that test.
fn nearest_walkable(
    field: &Field,
    start: (i32, i32),
    anchor: WorldXy,
    max_ground_m: f64,
) -> Option<(i32, i32)> {
    if field.walkable(start.0, start.1) {
        return Some(start);
    }
    if max_ground_m <= 0.0 || field.cell_size_m <= 0.0 {
        return None;
    }
    let max_cells = (max_ground_m / field.cell_size_m).ceil() as i32;
    let within_radius = |cell: (i32, i32)| {
        ground_distance_m(anchor, field.centre_of(cell), field.ground_scale) <= max_ground_m
    };
    let n = field.cols as usize * field.rows as usize;
    let mut seen = vec![false; n];
    seen[field.id(start.0, start.1) as usize] = true;
    let mut queue = VecDeque::new();
    queue.push_back((start, 0i32));
    while let Some(((x, y), d)) = queue.pop_front() {
        if d >= max_cells {
            continue;
        }
        for &(dx, dy) in &NEIGHBORS_8 {
            let (nx, ny) = (x + dx, y + dy);
            if !field.in_range(nx, ny) {
                continue;
            }
            let i = field.id(nx, ny) as usize;
            if seen[i] {
                continue;
            }
            seen[i] = true;
            if field.walkable(nx, ny) && within_radius((nx, ny)) {
                return Some((nx, ny));
            }
            queue.push_back(((nx, ny), d + 1));
        }
    }
    None
}

/// A\* over `field`'s walkable cells. Returns the raw cell path (as
/// cell ids), its integer cost, and the node-expansion count.
///
/// The open set is a `BinaryHeap<Reverse<OpenNode>>`, i.e. ordered
/// exactly `(f, h, cell_id)` — §13.1. `g` is an `i64` array indexed by
/// cell id, never a `HashMap`, so no hash iteration order exists to leak
/// into the result.
fn astar(field: &Field, start: (i32, i32), goal: (i32, i32)) -> Option<(Vec<u32>, i64, u32)> {
    let n = field.cols as usize * field.rows as usize;
    let start_id = field.id(start.0, start.1);
    let goal_id = field.id(goal.0, goal.1);
    let mut g = vec![i64::MAX; n];
    let mut came: Vec<u32> = vec![u32::MAX; n];
    let mut closed = vec![false; n];
    let mut open: BinaryHeap<std::cmp::Reverse<OpenNode>> = BinaryHeap::new();

    let h_of = |id: u32| -> i64 {
        let (x, y) = ((id % field.cols) as i32, (id / field.cols) as i32);
        let dx = (x - goal.0).unsigned_abs() as f64;
        let dy = (y - goal.1).unsigned_abs() as f64;
        let (lo, hi) = if dx < dy { (dx, dy) } else { (dy, dx) };
        let octile_m = (lo * std::f64::consts::SQRT_2 + (hi - lo)) * field.cell_size_m;
        heuristic_mm(octile_m, field.lowest_mult)
    };

    g[start_id as usize] = 0;
    open.push(std::cmp::Reverse(OpenNode {
        f: h_of(start_id),
        h: h_of(start_id),
        cell_id: start_id,
    }));
    let mut expanded = 0u32;

    while let Some(std::cmp::Reverse(node)) = open.pop() {
        let id = node.cell_id;
        if closed[id as usize] {
            continue;
        }
        closed[id as usize] = true;
        expanded += 1;
        if id == goal_id {
            let mut path = vec![id];
            let mut cur = id;
            while cur != start_id {
                cur = came[cur as usize];
                if cur == u32::MAX {
                    return None;
                }
                path.push(cur);
            }
            path.reverse();
            return Some((path, g[goal_id as usize], expanded));
        }
        let (x, y) = ((id % field.cols) as i32, (id / field.cols) as i32);
        let here_mult = field.multiplier(x, y);
        for &(dx, dy) in &NEIGHBORS_8 {
            let (nx, ny) = (x + dx, y + dy);
            if !field.walkable(nx, ny) {
                continue;
            }
            // §4.4: never squeeze between two diagonally touching
            // blocked cells.
            if !diagonal_step_allowed(
                dx != 0 && dy != 0,
                field.walkable(x + dx, y),
                field.walkable(x, y + dy),
            ) {
                continue;
            }
            let nid = field.id(nx, ny);
            if closed[nid as usize] {
                continue;
            }
            let len_m = if dx != 0 && dy != 0 {
                field.cell_size_m * std::f64::consts::SQRT_2
            } else {
                field.cell_size_m
            };
            // The AVERAGE of the two cells' multipliers, not the
            // destination's: a direction-dependent step cost would make
            // `route(A,B)` and `route(B,A)` genuinely different problems,
            // not merely differently tie-broken ones.
            let step = step_cost_mm(len_m, 0.5 * (here_mult + field.multiplier(nx, ny)));
            let tentative = g[id as usize].saturating_add(step);
            if tentative < g[nid as usize] {
                g[nid as usize] = tentative;
                came[nid as usize] = id;
                let h = h_of(nid);
                open.push(std::cmp::Reverse(OpenNode {
                    f: tentative.saturating_add(h),
                    h,
                    cell_id: nid,
                }));
            }
        }
    }
    None
}

/// The result of walking a straight chord across the field.
pub(super) struct Traversal {
    /// Integrated cost in millimetre-equivalents.
    pub cost_mm: i64,
    /// Did the chord cross any unknown (UNSARE / no-coverage) cell?
    pub touched_unknown: bool,
}

impl Traversal {
    /// Supercover traversal of the chord `a`→`b`, integrating the cost
    /// field along it. `None` when ANY cell it touches is not walkable.
    ///
    /// This is the only line-of-sight primitive in this module, and it
    /// has no passability-only mode by design — §12.3, and see the module
    /// docs.
    pub(super) fn los(field: &Field, a: WorldXy, b: WorldXy) -> Option<Traversal> {
        let cw = field.cell_world as f64;
        let ax = (a.x - field.origin_x) as f64 / cw;
        let ay = (a.y - field.origin_y) as f64 / cw;
        let bx = (b.x - field.origin_x) as f64 / cw;
        let by = (b.y - field.origin_y) as f64 / cw;
        let (dx, dy) = (bx - ax, by - ay);
        let len_m = (dx * dx + dy * dy).sqrt() * field.cell_size_m;

        // Bound: a straight chord cannot touch more cells than the grid's
        // own perimeter walk, with slack for the corner-doubling.
        let limit = 4 * (field.cols + field.rows) as usize + 8;
        let mut walk = Supercover::new(ax, ay, bx, by, limit);

        let mut cost = 0.0f64;
        let mut touched_unknown = false;
        for c in &mut walk {
            if !field.walkable(c.x, c.y) {
                return None;
            }
            touched_unknown |= field.unknown(c.x, c.y);
            // A corner-adjacent cell has a zero span: it is checked for
            // passability and unknown-ness but charges no cost, exactly
            // as it is not traversed.
            cost += c.span() * len_m * field.multiplier(c.x, c.y);
        }
        // Anything but reaching `b`'s own cell means the chord was never
        // proven clear all the way across — refuse it.
        if walk.end() != SupercoverEnd::Reached {
            return None;
        }
        Some(Traversal {
            cost_mm: (cost * super::cost::MM_PER_M).round() as i64,
            touched_unknown,
        })
    }
}

/// The heading of `a`→`b` in degrees, from world deltas. WebMercator is
/// conformal, so an angle measured in world units is the true angle — no
/// latitude correction needed for a TURN, unlike for a distance.
fn heading_deg(a: WorldXy, b: WorldXy) -> f64 {
    ((b.y - a.y) as f64).atan2((b.x - a.x) as f64).to_degrees()
}

fn turn_deg(prev: WorldXy, at: WorldXy, next: WorldXy) -> f64 {
    let mut d = heading_deg(at, next) - heading_deg(prev, at);
    while d > 180.0 {
        d -= 360.0;
    }
    while d < -180.0 {
        d += 360.0;
    }
    d.abs()
}

/// The raw sub-path's own integrated cost from `points[i]` to
/// `points[mid]`, INCLUDING the turn cost of every bend it contains —
/// §12.5's cheap option (turn cost applied at simplification, where the
/// polyline already exists). Without the turn term here a shortcut that
/// removes three bends would be judged purely on distance and rejected
/// whenever it happened to cost a metre more.
fn raw_subpath_cost_mm(
    field: &Field,
    points: &[WorldXy],
    i: usize,
    mid: usize,
    turn_weight: f64,
) -> Option<i64> {
    let mut total: i64 = 0;
    for k in i..mid {
        total = total.saturating_add(Traversal::los(field, points[k], points[k + 1])?.cost_mm);
    }
    for k in (i + 1)..mid {
        total = total.saturating_add(turn_cost_mm(
            turn_deg(points[k - 1], points[k], points[k + 1]),
            turn_weight,
        ));
    }
    Some(total)
}

/// §17 string-pulling with a COST-INTEGRATING line of sight — a shortcut
/// is accepted only when it is both traversable and no more expensive
/// than the sub-path it replaces. Copy-adapted from
/// `routing::raster::simplify_path`, whose own docs record the real bug
/// the cost half closes (an unconditional shortcut collapses every
/// cost-motivated bulge straight back to the direct line, making the
/// preference a silent no-op exactly where it mattered).
fn simplify(field: &Field, points: &[WorldXy], turn_weight: f64) -> Vec<WorldXy> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut result = vec![points[0]];
    let mut i = 0usize;
    while i < points.len() - 1 {
        let (mut lo, mut hi) = (i + 1, points.len() - 1);
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2); // bias high: find the FURTHEST reachable index
            let ok = match Traversal::los(field, points[i], points[mid]) {
                None => false,
                Some(t) => match raw_subpath_cost_mm(field, points, i, mid, turn_weight) {
                    None => false,
                    Some(raw) => {
                        (t.cost_mm as f64) <= (raw as f64) * (1.0 + SHORTCUT_COST_TOLERANCE)
                    }
                },
            };
            if ok {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        result.push(points[lo]);
        i = lo;
    }
    result
}

/// What one corridor attempt produced.
pub(super) struct SearchOutcome {
    pub waypoints: Vec<WorldXy>,
    pub graced_legs: Vec<bool>,
    pub cost_mm: i64,
    pub nodes_expanded: u32,
    pub cols: u32,
    pub rows: u32,
    pub cell_size_m: f64,
    pub ladder_cell_m: f64,
    pub finest_allowed_cell_m: f64,
    pub blocked_cells: u32,
    pub unknown_cells: u32,
    pub corridor_widen_attempts: u32,
    pub start_snap_m: f64,
    pub end_snap_m: f64,
}

/// Run the widen ladder until a corridor produces a path. `None` when
/// none does — this algorithm has no partial/"as close as it can get"
/// fallback of its own (the same scope call `routing::raster::graph`
/// makes); the caller's existing straight-line-with-a-warning path is the
/// honest answer.
pub(super) fn search(
    from: WorldXy,
    to: WorldXy,
    constraints: &ArtifactConstraints,
    weights: &ArtifactWeights,
    grace_radius_m: f64,
    force_finest: bool,
) -> Option<SearchOutcome> {
    for (attempt, pad_m) in widen_attempts(from, to) {
        let corridor = corridor_with_pad(from, to, pad_m);
        let Some(field) = build_field(
            &corridor,
            constraints,
            weights,
            from,
            to,
            grace_radius_m,
            force_finest,
        ) else {
            continue;
        };
        // §9.3: an endpoint may be snapped only within the grace radius —
        // a true ground-distance bound, enforced inside `nearest_walkable`
        // itself (see its own docs for why a step count alone is not
        // enough).
        let max_ground_m = grace_radius_m.max(0.0);
        let Some(start) = nearest_walkable(&field, field.cell_of(from), from, max_ground_m) else {
            continue;
        };
        let Some(goal) = nearest_walkable(&field, field.cell_of(to), to, max_ground_m) else {
            continue;
        };
        let start_pt = field.centre_of(start);
        let goal_pt = field.centre_of(goal);

        let (raw, cost_mm, expanded) = if start == goal {
            (vec![field.id(start.0, start.1)], 0i64, 1u32)
        } else {
            astar(&field, start, goal)?
        };

        let dense: Vec<WorldXy> = raw
            .iter()
            .map(|&id| field.centre_of(((id % field.cols) as i32, (id / field.cols) as i32)))
            .collect();
        let mut waypoints = simplify(&field, &dense, weights.turn_cost_weight);
        if waypoints.len() < 2 {
            waypoints = vec![start_pt, goal_pt];
        }

        let graced_legs = waypoints
            .windows(2)
            .map(|w| {
                Traversal::los(&field, w[0], w[1])
                    .map(|t| t.touched_unknown)
                    .unwrap_or(true)
            })
            .collect();

        return Some(SearchOutcome {
            start_snap_m: ground_distance_m(from, waypoints[0], field.ground_scale),
            end_snap_m: ground_distance_m(to, *waypoints.last().unwrap(), field.ground_scale),
            waypoints,
            graced_legs,
            cost_mm,
            nodes_expanded: expanded,
            cols: field.cols,
            rows: field.rows,
            cell_size_m: field.cell_size_m,
            ladder_cell_m: field.ladder_cell_m,
            finest_allowed_cell_m: field.finest_allowed_cell_m,
            blocked_cells: field.blocked_count(),
            unknown_cells: field.unknown_count(),
            corridor_widen_attempts: attempt,
        });
    }
    None
}

/// The padded box for one widen attempt. Symmetric in `from`/`to` by
/// construction (`min`/`max`, and a midpoint that is the same either way
/// round) — one of the two things that make `route(A,B)` and `route(B,A)`
/// see an identical search space, the other being [`super`]'s canonical
/// endpoint ordering.
fn corridor_with_pad(from: WorldXy, to: WorldXy, pad_m: f64) -> Corridor {
    let centre = WorldXy::new(
        ((from.x as i64 + to.x as i64) / 2) as i32,
        ((from.y as i64 + to.y as i64) / 2) as i32,
    );
    let pad = radius_world_units(centre, pad_m) as i32;
    Corridor {
        xmin: from.x.min(to.x).saturating_sub(pad),
        xmax: from.x.max(to.x).saturating_add(pad),
        ymin: from.y.min(to.y).saturating_sub(pad),
        ymax: from.y.max(to.y).saturating_add(pad),
    }
}

pub(super) fn ground_distance_m(a: WorldXy, b: WorldXy, ground_scale: f64) -> f64 {
    let (x0, y0) = sm_from_world(a, a);
    let (x1, y1) = sm_from_world(b, a);
    (((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt()) * ground_scale
}

/// Sum of ground-metre distances along consecutive `points`.
///
/// The `ground_scale` reference is the MIDPOINT of the path's own y
/// range, not `points[0]` — an order-independent choice, so reversing the
/// point list cannot change the answer. (`routing::raster::path_distance_m`
/// uses `points[0]`, which is fine there because nothing asserts
/// reversal equality on its output; here §13.2 does.) The summation
/// itself is only run once per route, on the CANONICAL point order, and
/// the reversed direction reuses that number rather than re-summing —
/// float addition is not associative, so re-summing in the other order
/// could differ in the last bit even with an identical reference.
pub(super) fn path_distance_m(points: &[WorldXy]) -> f64 {
    if points.len() < 2 {
        return 0.0;
    }
    let reference = points[0];
    let (mut ymin, mut ymax) = (i32::MAX, i32::MIN);
    for p in points {
        ymin = ymin.min(p.y);
        ymax = ymax.max(p.y);
    }
    let mid_y = ((ymin as i64 + ymax as i64) / 2) as i32;
    let ground_scale = worldy_to_lat(mid_y).to_radians().cos();
    points
        .windows(2)
        .map(|w| {
            let (x0, y0) = sm_from_world(w[0], reference);
            let (x1, y1) = sm_from_world(w[1], reference);
            ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt()
        })
        .sum::<f64>()
        * ground_scale
}

pub(super) fn to_lonlat(p: WorldXy) -> (f64, f64) {
    (worldx_to_lon(p.x), worldy_to_lat(p.y))
}

pub(super) fn from_lonlat(lon: f64, lat: f64) -> WorldXy {
    lat_lon_to_world(lat, lon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::coverage::signed_area2_world;
    use crate::routing::artifact::{ArtifactConstraints, ArtifactWeights};

    const LAT: f64 = 55.0;
    const LON: f64 = 12.0;

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

    fn field_with(hard: Vec<Vec<WorldXy>>) -> Field {
        let c = ArtifactConstraints {
            hard,
            compilation_scale: 10_000,
            catzoc_horizontal_m: 0.0,
            ..ArtifactConstraints::default()
        };
        let from = lat_lon_to_world(LAT, LON - 0.02);
        let to = lat_lon_to_world(LAT, LON + 0.02);
        let corridor = corridor_with_pad(from, to, CORRIDOR_PAD_FLOOR_M);
        build_field(
            &corridor,
            &c,
            &ArtifactWeights::default(),
            from,
            to,
            0.0,
            false,
        )
        .unwrap()
    }

    #[test]
    fn the_grid_lattice_is_globally_anchored_not_corridor_anchored() {
        // Two queries whose corridors differ by a few world units must
        // land on the SAME lattice, which is what makes two nearby clicks
        // produce the same canonical endpoints (§13.1).
        let f = field_with(vec![]);
        assert_eq!(f.origin_x % f.cell_world, 0);
        assert_eq!(f.origin_y % f.cell_world, 0);
    }

    #[test]
    fn a_cell_centre_round_trips_through_cell_of() {
        let f = field_with(vec![]);
        for (x, y) in [(0, 0), (3, 7), (f.cols as i32 - 1, f.rows as i32 - 1)] {
            assert_eq!(f.cell_of(f.centre_of((x, y))), (x, y));
        }
    }

    #[test]
    fn los_refuses_a_chord_through_a_blocked_cell_and_costs_a_clear_one() {
        let obstacle = square(LAT, LON, 400.0);
        let f = field_with(vec![obstacle]);
        let a = lat_lon_to_world(LAT, LON - 0.02);
        let b = lat_lon_to_world(LAT, LON + 0.02);
        assert!(
            Traversal::los(&f, a, b).is_none(),
            "a chord straight through the obstacle must be refused"
        );
        let clear = Traversal::los(&f, a, lat_lon_to_world(LAT - 0.01, LON - 0.015))
            .expect("a chord in open water is clear");
        assert!(clear.cost_mm > 0);
    }

    #[test]
    fn los_is_symmetric_in_both_cost_and_passability() {
        let f = field_with(vec![square(LAT + 0.01, LON, 300.0)]);
        let a = lat_lon_to_world(LAT - 0.01, LON - 0.02);
        let b = lat_lon_to_world(LAT - 0.005, LON + 0.02);
        let ab = Traversal::los(&f, a, b).expect("clear");
        let ba = Traversal::los(&f, b, a).expect("clear");
        // Sampling the same cells in the opposite order can differ by at
        // most rounding of the final millimetre.
        assert!(
            (ab.cost_mm - ba.cost_mm).abs() <= 1,
            "{} vs {}",
            ab.cost_mm,
            ba.cost_mm
        );
    }

    #[test]
    fn a_diagonal_barrier_is_not_hopped_by_the_search() {
        // Two blocked cells touching only at a corner: an 8-connected
        // search without corner-cut prevention walks straight between
        // them. §4.4 calls this "a silent, safety-relevant failure".
        let f = field_with(vec![]);
        let mut f = f;
        let mid = (f.cols as i32 / 2, f.rows as i32 / 2);
        let a = (mid.0, mid.1);
        let b = (mid.0 + 1, mid.1 + 1);
        let (ia, ib) = (f.id(a.0, a.1) as usize, f.id(b.0, b.1) as usize);
        f.flags[ia] |= F_HARD;
        f.flags[ib] |= F_HARD;
        // The only way from (mid.0+1, mid.1) to (mid.0, mid.1+1) that
        // does not go the long way round is the forbidden diagonal.
        let start = (mid.0 + 1, mid.1);
        let goal = (mid.0, mid.1 + 1);
        let (path, _, _) = astar(&f, start, goal).expect("a long way round exists");
        assert!(
            path.len() > 2,
            "the search must not slip through the corner: {path:?}"
        );
    }

    #[test]
    fn nearest_walkable_is_bounded_by_the_grace_radius_in_ground_metres() {
        let mut f = field_with(vec![]);
        // Block a solid disc of radius ~5 cells around the centre.
        let mid = (f.cols as i32 / 2, f.rows as i32 / 2);
        for dy in -5..=5 {
            for dx in -5..=5 {
                if f.in_range(mid.0 + dx, mid.1 + dy) {
                    let id = f.id(mid.0 + dx, mid.1 + dy) as usize;
                    f.flags[id] |= F_HARD;
                }
            }
        }
        let anchor = f.centre_of(mid);
        assert!(
            nearest_walkable(&f, mid, anchor, 2.0 * f.cell_size_m).is_none(),
            "2 cells' worth of metres is not enough"
        );
        assert!(
            nearest_walkable(&f, mid, anchor, 12.0 * f.cell_size_m).is_some(),
            "12 cells' worth of metres is"
        );
    }

    /// The bug this guards against: an 8-connected step count is a
    /// Chebyshev bound, not a Euclidean one. A radius wide enough to
    /// reach a walkable cell only in a DIAGONAL direction must reject a
    /// cell that is that same step count away but in an ORTHOGONAL
    /// direction beyond the true radius — the two are not
    /// interchangeable once `sqrt(2)` enters, and accepting the diagonal
    /// case while getting the orthogonal one right (or vice versa) would
    /// mean the true ground-distance gate, not the step count, is what's
    /// actually doing the work.
    #[test]
    fn the_grace_radius_is_ground_distance_not_chebyshev_steps() {
        let mut f = field_with(vec![]);
        let mid = (f.cols as i32 / 2, f.rows as i32 / 2);
        let cs = f.cell_size_m;
        // Block only `mid` itself, so the search must step outward.
        let id = f.id(mid.0, mid.1) as usize;
        f.flags[id] |= F_HARD;
        let anchor = f.centre_of(mid);

        // A radius of exactly one cell's diagonal (cs * sqrt(2)) reaches
        // the diagonal neighbour...
        let diagonal_radius = cs * std::f64::consts::SQRT_2;
        assert!(
            nearest_walkable(&f, mid, anchor, diagonal_radius).is_some(),
            "a diagonal neighbour at exactly cs*sqrt(2) must be reachable"
        );

        // ...but a radius of one cell (cs), comfortably short of the
        // diagonal, must NOT accept that same diagonal neighbour even
        // though it is one grid step away. Every orthogonal neighbour is
        // blocked too (the 4-neighbourhood around `mid`), so the only
        // walkable cells within one step are the four diagonals — all of
        // them out of true range at radius `cs`.
        for &(dx, dy) in &[(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (mid.0 + dx, mid.1 + dy);
            let id = f.id(nx, ny) as usize;
            f.flags[id] |= F_HARD;
        }
        assert!(
            nearest_walkable(&f, mid, anchor, cs).is_none(),
            "a diagonal neighbour must not be accepted at a radius shorter than its true distance"
        );
    }
}
