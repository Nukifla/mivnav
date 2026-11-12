// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §4.1/§4.2 — the resolution LADDER, and the rule that resolution is
//! capped by the source rather than chosen by the router.
//!
//! ```text
//! finest_allowed_cell(region) =
//!     max(
//!         2 m,
//!         compilation_scale / 2000,      # 0.5 mm at scale
//!         catzoc_horizontal(region) / 4  # do not out-resolve the survey
//!     )
//!     snapped up to the nearest ladder level
//! ```
//!
//! This is the one piece of v3's §4 that is real, testable and
//! implementable WITHOUT the persisted artifact: the resolution CHOICE
//! logic is a pure function of the chart's own compilation scale and its
//! `CATZOC` grade, and it replaces the existing `routing::raster`
//! algorithm's fixed 6m..120m heuristic (`MIN_CELL_M`/`MAX_CELL_M`) with
//! a source-driven one. The rest of §4 — precomputed per-tile
//! resolutions, per-tile variation, the refinement triggers of §4.3, the
//! boundary-cell stitching table of §4.2 — needs the artifact and is out
//! of scope; see [`super`]'s own module docs.
//!
//! # A noted discrepancy with v3's worked examples
//!
//! §4.1's prose says "snapped **up** to the nearest ladder level" and
//! then works three examples: 1:10 000 → 5m → "**4m** ladder level";
//! 1:25 000 → 12.5m → "16m"; 1:90 000 → 45m → "64m". Those are not all
//! the same operation — the second and third snap UP, the first snaps
//! DOWN (5m is between the 4m and 8m rungs). No single rule reproduces
//! all three: nearest-value gives 4/16/32, nearest-in-log2 gives 4/16/32,
//! snap-up gives 8/16/64.
//!
//! This implements the stated RULE (snap **up**), not the first worked
//! number, because the rule is the one with a safety argument behind it:
//! §4.1's own justification is "do not out-resolve the survey" and §24's
//! own trap entry is "a 1m grid over 1:25 000 geometry is confident
//! nonsense". Snapping up is the direction that cannot manufacture
//! precision the source does not support; snapping down is the direction
//! that can. So 1:10 000 resolves to **8m** here, not the doc's 4m.
//!
//! Being coarse is not free — §24 also says "conservative rasterisation
//! closes channels" — but that failure direction is the acceptable one
//! (a refused route, not a wrong one), and it is the direction the
//! existing algorithm's own `refine_flagged_legs` re-search pattern is
//! built to reopen.

/// §4.2's fixed ladder, metres. Uniform within one corridor for this MVP
/// (v3 allows it to vary between TILES, which needs the artifact).
pub const RESOLUTION_LADDER_M: [f64; 9] = [2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 256.0, 1024.0];

/// The finest rung at least as coarse as `m`. `m` past the top rung
/// returns the top rung — the caller ([`super::search`]) is what decides
/// whether to go off-ladder for a corridor too large to fit its cell
/// budget even at 1024m, since that is a BUDGET decision, not a
/// resolution-policy one.
pub fn snap_up_to_ladder(m: f64) -> f64 {
    for &rung in &RESOLUTION_LADDER_M {
        if rung >= m {
            return rung;
        }
    }
    RESOLUTION_LADDER_M[RESOLUTION_LADDER_M.len() - 1]
}

/// The next rung strictly COARSER than `m`, or `None` at the top of the
/// ladder — how [`super::search`] steps a corridor's resolution down
/// until it fits its cell budget, so every resolution it ever searches at
/// is a real ladder level rather than an arbitrary `span / max_dim`
/// quotient.
pub fn next_coarser_rung(m: f64) -> Option<f64> {
    RESOLUTION_LADDER_M.iter().copied().find(|&rung| rung > m)
}

/// §4.1's formula, ladder-snapped. `compilation_scale` is the chart's own
/// scale denominator (1:12 000 → `12_000`); `catzoc_horizontal_m` is the
/// COARSEST §3.4 horizontal figure over the charts consulted
/// (`super::constraints::ArtifactConstraints::catzoc_horizontal_m`).
///
/// A `compilation_scale` of `0` (a cell whose header records none) simply
/// drops out of the `max` — it contributes no evidence either way, and
/// treating it as "infinitely fine" (which a naive divide would) or as
/// "infinitely coarse" would both be inventing information.
pub fn finest_allowed_cell_m(compilation_scale: u32, catzoc_horizontal_m: f64) -> f64 {
    let floor_m = RESOLUTION_LADDER_M[0];
    let scale_m = compilation_scale as f64 / 2000.0;
    let survey_m = catzoc_horizontal_m / 4.0;
    snap_up_to_ladder(floor_m.max(scale_m).max(survey_m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapping_up_lands_on_a_real_rung() {
        assert_eq!(snap_up_to_ladder(0.0), 2.0);
        assert_eq!(snap_up_to_ladder(2.0), 2.0);
        assert_eq!(snap_up_to_ladder(2.1), 4.0);
        assert_eq!(snap_up_to_ladder(4.0), 4.0);
        assert_eq!(snap_up_to_ladder(5.0), 8.0);
        assert_eq!(snap_up_to_ladder(12.5), 16.0);
        assert_eq!(snap_up_to_ladder(45.0), 64.0);
        assert_eq!(snap_up_to_ladder(300.0), 1024.0);
        // Past the top rung: clamped, never extrapolated.
        assert_eq!(snap_up_to_ladder(5000.0), 1024.0);
    }

    #[test]
    fn stepping_coarser_walks_the_ladder_and_then_stops() {
        assert_eq!(next_coarser_rung(2.0), Some(4.0));
        assert_eq!(next_coarser_rung(3.0), Some(4.0));
        assert_eq!(next_coarser_rung(256.0), Some(1024.0));
        assert_eq!(next_coarser_rung(1024.0), None);
        assert_eq!(next_coarser_rung(9999.0), None);
    }

    #[test]
    fn compilation_scale_drives_the_choice_at_0_5mm_at_scale() {
        // 1:10 000 -> 5m -> 8m (see the module docs on why NOT the doc's
        // own worked "4m").
        assert_eq!(finest_allowed_cell_m(10_000, 0.0), 8.0);
        // 1:25 000 -> 12.5m -> 16m, exactly as v3 works it.
        assert_eq!(finest_allowed_cell_m(25_000, 0.0), 16.0);
        // 1:90 000 -> 45m -> 64m, exactly as v3 works it.
        assert_eq!(finest_allowed_cell_m(90_000, 0.0), 64.0);
    }

    #[test]
    fn the_2m_floor_holds_for_any_harbour_scale_chart() {
        // 1:2 000 -> 1m, below the ladder's own floor.
        assert_eq!(finest_allowed_cell_m(2_000, 0.0), 2.0);
        assert_eq!(finest_allowed_cell_m(500, 0.0), 2.0);
        // No recorded scale at all contributes no evidence.
        assert_eq!(finest_allowed_cell_m(0, 0.0), 2.0);
    }

    #[test]
    fn catzoc_horizontal_caps_resolution_independently_of_scale() {
        // A harbour-scale chart (which alone would allow 2m) inside a
        // CATZOC-C zone (500m horizontal): 500/4 = 125m -> 128m rung.
        // "Buffering by +-500m and then routing on a 4m grid is
        // incoherent" (§3.4).
        assert_eq!(finest_allowed_cell_m(2_000, 500.0), 128.0);
        // CATZOC B (50m): 12.5m -> 16m, which now outranks the scale term.
        assert_eq!(finest_allowed_cell_m(10_000, 50.0), 16.0);
        // CATZOC A1 (5m): 1.25m, below the floor — the scale term wins.
        assert_eq!(finest_allowed_cell_m(10_000, 5.0), 8.0);
    }

    #[test]
    fn the_formula_is_a_max_not_a_sum() {
        // Both terms present: the COARSER one alone decides.
        let scale_only = finest_allowed_cell_m(90_000, 0.0);
        let both = finest_allowed_cell_m(90_000, 20.0);
        assert_eq!(scale_only, both);
    }
}
