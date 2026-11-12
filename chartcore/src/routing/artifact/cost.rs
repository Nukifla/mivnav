// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §10.1 cost UNITS and §13.1 DETERMINISM: fixed-point integer
//! millimetre-equivalents, and a total order on the open set.
//!
//! # Why integers
//!
//! §13.1: "Floating-point addition is not associative, so two expansion
//! orders that should tie will not." The existing `routing::raster`
//! search already costs its *unweighted* grid in integers
//! (`ORTHO_COST`/`DIAG_COST`, millimetre-scale) but switches to `f64`
//! the moment any soft preference is on (`CostModel`/
//! `combined_multiplier`). This module keeps the accumulation integral
//! all the way: geometry and the per-cell multiplier stay `f64` (there is
//! no benefit to a fixed-point secant-of-latitude), but the value that
//! actually enters the priority queue and the `g` array is an `i64` of
//! millimetre-equivalents, rounded once per STEP.
//!
//! # Why `(f, h, cell_id)`
//!
//! §13.1: "Order by `(f, h, cell_id)` lexicographically. Never by
//! insertion order, pointer, or hash iteration order." `f` alone leaves
//! ties to whatever the heap's internal sift happens to do with equal
//! keys, which is stable for a given binary but not a property anything
//! guarantees; `h` breaks ties toward the goal (the standard, and it
//! genuinely reduces expansions), and `cell_id` — a plain
//! `row * cols + col` — makes the remaining ties total. [`OpenNode`]'s
//! `Ord` IS that tuple, so a `BinaryHeap` cannot express any other order
//! even by accident.

use std::cmp::Ordering;

/// Fixed-point scale: one cost unit is one millimetre-equivalent.
pub const MM_PER_M: f64 = 1000.0;

/// §10.1's floor on `1 + Σ penalty`: "a bonus must never make a leg free,
/// or the router will chase fairway loops."
pub const MIN_MULTIPLIER: f64 = 0.2;

/// `length_m × multiplier`, in millimetre-equivalents, rounded once.
///
/// `multiplier` is clamped to [`MIN_MULTIPLIER`] here rather than at
/// every call site, so the §10.1 floor cannot be forgotten by one caller
/// and applied by another — which would break the A* heuristic's own
/// admissibility argument (see [`heuristic_mm`]).
pub fn step_cost_mm(length_m: f64, multiplier: f64) -> i64 {
    let m = if multiplier.is_finite() {
        multiplier.max(MIN_MULTIPLIER)
    } else {
        MIN_MULTIPLIER
    };
    (length_m * MM_PER_M * m).round() as i64
}

/// An ADMISSIBLE heuristic in the same units: the straight-line distance
/// scaled by the SMALLEST multiplier any cell of this search could
/// possibly carry, rounded DOWN.
///
/// Rounded down, not to nearest: A* admissibility needs `h ≤` the true
/// remaining cost, and a half-millimetre of rounding the wrong way is
/// still the wrong way. `lowest_multiplier` is the caller's own
/// `1 - (every negative penalty)`, floored at [`MIN_MULTIPLIER`] — the
/// same argument `routing::raster::octile_heuristic`'s own docs make for
/// its fairway discount, restated here because this module's penalty set
/// is different.
pub fn heuristic_mm(distance_m: f64, lowest_multiplier: f64) -> i64 {
    let m = if lowest_multiplier.is_finite() {
        lowest_multiplier.max(MIN_MULTIPLIER)
    } else {
        MIN_MULTIPLIER
    };
    (distance_m * MM_PER_M * m).floor() as i64
}

/// One entry of the open set, ordered EXACTLY by `(f, h, cell_id)`
/// lexicographically — §13.1.
///
/// `Ord` is ascending (smallest `f` is "least"), so the search pushes
/// `Reverse(OpenNode)` into a max-heap `BinaryHeap` to pop the smallest.
/// Deriving `Ord` on the struct in field order would give the same
/// result; it is written out to make the ordering contract impossible to
/// break by reordering fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenNode {
    pub f: i64,
    pub h: i64,
    pub cell_id: u32,
}

impl Ord for OpenNode {
    fn cmp(&self, other: &Self) -> Ordering {
        self.f
            .cmp(&other.f)
            .then(self.h.cmp(&other.h))
            .then(self.cell_id.cmp(&other.cell_id))
    }
}

impl PartialOrd for OpenNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// §10.3's turn cost, "30 m per 30°", in millimetre-equivalents, scaled
/// by the caller's `turn_cost_weight` (`0.0` = off, matching every other
/// preference dial in this crate).
///
/// Applied POST-HOC during simplification, never as search state — §12.5
/// offers exactly that choice ("Either accept the multiplier over a
/// quantised heading set, or apply turn cost only during simplification
/// (§17) where the polyline already exists. Decide in Phase 0; the second
/// option is cheaper and probably sufficient"), and this MVP takes the
/// cheap option. The existing `routing::raster` algorithm took the other
/// one (`search_grid_with_turn_cost`, a state-expanded search), so
/// between the two algorithms both branches of §12.5 are now actually
/// implemented and comparable — which is the point of shipping a fourth
/// algorithm rather than patching the third.
pub const TURN_COST_M_PER_30_DEG: f64 = 30.0;

/// The turn penalty for a heading change of `degrees`, in
/// millimetre-equivalents.
pub fn turn_cost_mm(degrees: f64, weight: f64) -> i64 {
    if weight <= 0.0 || !degrees.is_finite() || degrees <= 0.0 {
        return 0;
    }
    (degrees / 30.0 * TURN_COST_M_PER_30_DEG * MM_PER_M * weight).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    #[test]
    fn a_metre_at_multiplier_one_is_a_thousand_units() {
        assert_eq!(step_cost_mm(1.0, 1.0), 1000);
        assert_eq!(step_cost_mm(2.5, 1.0), 2500);
        assert_eq!(step_cost_mm(1.0, 1.5), 1500);
    }

    #[test]
    fn the_multiplier_floor_is_applied_inside_not_at_call_sites() {
        // A fairway bonus larger than 1.0 must not make a leg free, let
        // alone negative-cost (which would break A* outright).
        assert_eq!(
            step_cost_mm(100.0, -3.0),
            step_cost_mm(100.0, MIN_MULTIPLIER)
        );
        assert!(step_cost_mm(100.0, -3.0) > 0);
        assert_eq!(
            step_cost_mm(100.0, f64::NAN),
            step_cost_mm(100.0, MIN_MULTIPLIER)
        );
    }

    #[test]
    fn the_heuristic_rounds_down_so_it_stays_admissible() {
        // 1.0004 m at multiplier 1.0 = 1000.4 mm: the true cost rounds to
        // 1000, so a heuristic that rounded to nearest would also be 1000
        // — fine — but 1.0006 m rounds the true cost to 1001 while the
        // heuristic must never EXCEED it for a same-length step.
        for len in [0.0009_f64, 1.0004, 1.0006, 37.4999] {
            assert!(
                heuristic_mm(len, 1.0) <= step_cost_mm(len, 1.0),
                "h must not exceed the true cost of the same step at len={len}"
            );
        }
    }

    #[test]
    fn open_nodes_order_by_f_then_h_then_cell_id() {
        let a = OpenNode {
            f: 10,
            h: 5,
            cell_id: 7,
        };
        let b = OpenNode {
            f: 10,
            h: 5,
            cell_id: 8,
        };
        let c = OpenNode {
            f: 10,
            h: 6,
            cell_id: 0,
        };
        let d = OpenNode {
            f: 11,
            h: 0,
            cell_id: 0,
        };
        assert!(a < b, "cell_id breaks the final tie");
        assert!(b < c, "h outranks cell_id");
        assert!(c < d, "f outranks everything");
    }

    #[test]
    fn the_heap_pops_in_exactly_that_order_regardless_of_push_order() {
        let nodes = [
            OpenNode {
                f: 11,
                h: 0,
                cell_id: 0,
            },
            OpenNode {
                f: 10,
                h: 6,
                cell_id: 0,
            },
            OpenNode {
                f: 10,
                h: 5,
                cell_id: 8,
            },
            OpenNode {
                f: 10,
                h: 5,
                cell_id: 7,
            },
        ];
        // Every permutation of the same four nodes must drain identically
        // — the property `f`-only ordering cannot promise.
        let expect: Vec<u32> = vec![7, 8, 0, 0];
        for rotation in 0..nodes.len() {
            let mut heap = BinaryHeap::new();
            for i in 0..nodes.len() {
                heap.push(Reverse(nodes[(i + rotation) % nodes.len()]));
            }
            let mut got = Vec::new();
            while let Some(Reverse(n)) = heap.pop() {
                got.push(n.cell_id);
            }
            assert_eq!(got, expect, "rotation {rotation}");
        }
    }

    #[test]
    fn turn_cost_is_off_at_weight_zero_and_linear_in_the_angle() {
        assert_eq!(turn_cost_mm(90.0, 0.0), 0);
        assert_eq!(turn_cost_mm(0.0, 1.0), 0);
        assert_eq!(turn_cost_mm(30.0, 1.0), 30_000);
        assert_eq!(turn_cost_mm(90.0, 1.0), 90_000);
        assert_eq!(turn_cost_mm(30.0, 0.5), 15_000);
    }
}
