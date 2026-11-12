// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §3.4 — `CATZOC` as a HORIZONTAL and a VERTICAL allowance, not only a
//! soft cost.
//!
//! The existing algorithms (`routing::preference::
//! build_low_confidence_survey_union`) read `M_QUAL`/`CATZOC` purely as a
//! soft "prefer better-surveyed water" term. v3 §3.4's complaint is that
//! this throws away the half of the information that is a HARD constraint
//! input: a zone-of-confidence grade is a stated position and depth
//! uncertainty, so a charted hazard inside a CATZOC-C zone may genuinely
//! be up to 500m away from where it is drawn, and a charted depth may be
//! up to `2.00m + 5%` shallower than printed.
//!
//! This module owns that table and nothing else. [`ArtifactConstraints`]
//! (`super::constraints`) applies [`CatzocAllowance::horizontal_m`] as a
//! real per-feature BUFFER on hard-blocking geometry, and
//! [`CatzocAllowance::effective_depth_m`] before every
//! `required_depth` comparison.
//!
//! # Judgment calls (v3 leaves these open — §3.4's table says only
//! "worse than C" for D, and "treat as D" for U)
//!
//! * **D / U / absent horizontal = 1000m** — twice C's 500m. There is no
//!   IHO figure for D at all (the S-57 ZOC table's D row is literally
//!   "worse than C"), so any number here is a choice; 2×C is the smallest
//!   choice that is still unambiguously "worse than C" rather than
//!   "C with extra steps". **This is large enough to close a great deal of
//!   real inshore water at `Full`** — which is exactly what v3 §25 open
//!   decision #1 warns about ("Full application ... will close a great
//!   deal of Danish inshore water where CATZOC is B or worse"), not a bug
//!   in this table. `Half`/`DepthOnly`/`Off` exist for that.
//! * **D / U / absent depth allowance = C's numbers** (`2.00m + 5%`),
//!   NOT a further-inflated figure. Depth allowance is subtracted from a
//!   charted depth, and inflating it without evidence would start
//!   rejecting deep, perfectly safe water on a chart that merely never
//!   recorded its survey grade — a far more common case than a genuinely
//!   D-grade survey. The horizontal figure has no such failure mode (it
//!   only ever grows a hazard that is already charted), which is why the
//!   two are treated differently rather than both scaled together.
//! * **Absent `M_QUAL` is treated as `U`**, not as "no allowance" — the
//!   same "absence is not evidence of the safe case" posture
//!   `routing::hazards`' own missing-`VERCLR` rule and
//!   `routing::preference`'s own `CATZOC`-less `M_QUAL` rule already take.

/// How much of §3.4's allowance actually gets applied — v3 §25 open
/// decision #1, exposed as a query option (`RoutingConfig.
/// artifact_catzoc_allowance_mode`) rather than decided here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatzocMode {
    /// Both the horizontal buffer and the depth allowance, at the table's
    /// own figures. The default — the doc's own lean, and the safer
    /// default for an algorithm whose whole selling point is a stricter
    /// hard-constraint set.
    Full,
    /// Both, halved.
    Half,
    /// The depth allowance only; no horizontal buffering at all. The
    /// cheapest mode by a wide margin — buffering every hard-blocking
    /// polygon by hundreds of metres is real geometry work, a depth
    /// subtraction is one float op.
    DepthOnly,
    /// Neither — matches what the existing `raster`/`graph` algorithms do
    /// today (CATZOC as a soft cost only).
    Off,
}

impl CatzocMode {
    /// Parse the wire value (`RoutingConfig.artifact_catzoc_allowance_mode`'s
    /// `Literal["full", "half", "depth_only", "off"]`). Anything
    /// unrecognised falls back to [`CatzocMode::Full`] — the permissive-
    /// default posture `Cell::buoyage_penalty`'s own `parse_iala_region`
    /// already established for an enum the Python side's own `Literal`
    /// validates before this is ever reached, except that here the
    /// fallback is deliberately the *strictest* option rather than the
    /// most common one: a typo must never silently weaken a safety
    /// constraint.
    pub fn parse(s: &str) -> CatzocMode {
        match s {
            "half" => CatzocMode::Half,
            "depth_only" => CatzocMode::DepthOnly,
            "off" => CatzocMode::Off,
            _ => CatzocMode::Full,
        }
    }

    fn horizontal_scale(self) -> f64 {
        match self {
            CatzocMode::Full => 1.0,
            CatzocMode::Half => 0.5,
            CatzocMode::DepthOnly | CatzocMode::Off => 0.0,
        }
    }

    fn depth_scale(self) -> f64 {
        match self {
            CatzocMode::Full | CatzocMode::DepthOnly => 1.0,
            CatzocMode::Half => 0.5,
            CatzocMode::Off => 0.0,
        }
    }
}

/// One CATZOC grade's own allowance, already scaled by a [`CatzocMode`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CatzocAllowance {
    /// Metres of horizontal position uncertainty — buffered onto every
    /// hard-blocking feature that falls inside this zone.
    pub horizontal_m: f64,
    /// Fixed part of the depth allowance, metres.
    pub depth_fixed_m: f64,
    /// Proportional part of the depth allowance, as a fraction of the
    /// charted depth (`0.01` = 1%).
    pub depth_fraction: f64,
}

impl CatzocAllowance {
    /// No allowance at all — what [`CatzocMode::Off`] produces for every
    /// grade, and the identity for [`CatzocAllowance::effective_depth_m`].
    pub const NONE: CatzocAllowance = CatzocAllowance {
        horizontal_m: 0.0,
        depth_fixed_m: 0.0,
        depth_fraction: 0.0,
    };

    /// The charted depth a `required_depth` comparison should actually
    /// use: `charted - (fixed + fraction × charted)`.
    ///
    /// The proportional term is taken on the charted depth's own
    /// magnitude clamped at zero, so a NEGATIVE charted depth (a drying
    /// height, which S-57 does encode — see `derive::hazards`' own
    /// `depth_value` defaults, which produce `-15.0` for an "unknown,
    /// assume dangerous" wreck) is made no *shallower* by the percentage
    /// term than it already is. Without the clamp, `-15.0` at 5% would be
    /// nudged 0.75m DEEPER, i.e. safer — exactly the wrong direction for
    /// an allowance whose whole job is conservatism.
    pub fn effective_depth_m(&self, charted_depth_m: f64) -> f64 {
        charted_depth_m - (self.depth_fixed_m + self.depth_fraction * charted_depth_m.max(0.0))
    }
}

/// The base (unscaled) table, keyed by the S-57 `CATZOC` enumeration:
/// `1`=A1, `2`=A2, `3`=B, `4`=C, `5`=D, `6`=U — the same domain
/// `routing::preference::CATZOC_LOW_CONFIDENCE_MIN` already documents as
/// checked directly against the real `s57expectedinput.csv` table.
fn base_allowance(catzoc: Option<i64>) -> CatzocAllowance {
    match catzoc {
        Some(1) => CatzocAllowance {
            horizontal_m: 5.0,
            depth_fixed_m: 0.50,
            depth_fraction: 0.01,
        },
        Some(2) => CatzocAllowance {
            horizontal_m: 20.0,
            depth_fixed_m: 1.00,
            depth_fraction: 0.02,
        },
        Some(3) => CatzocAllowance {
            horizontal_m: 50.0,
            depth_fixed_m: 1.00,
            depth_fraction: 0.02,
        },
        Some(4) => CatzocAllowance {
            horizontal_m: 500.0,
            depth_fixed_m: 2.00,
            depth_fraction: 0.05,
        },
        // D (5), U (6), any unrecognised code, and CATZOC-absent /
        // M_QUAL-absent alike — see the module docs' judgment-call notes.
        _ => CatzocAllowance {
            horizontal_m: 1000.0,
            depth_fixed_m: 2.00,
            depth_fraction: 0.05,
        },
    }
}

/// The allowance for `catzoc` under `mode`. `catzoc = None` means "this
/// point is in no `M_QUAL` zone at all, or in one that records no
/// `CATZOC`" — treated as `U`, see the module docs.
pub fn allowance(catzoc: Option<i64>, mode: CatzocMode) -> CatzocAllowance {
    let base = base_allowance(catzoc);
    CatzocAllowance {
        horizontal_m: base.horizontal_m * mode.horizontal_scale(),
        depth_fixed_m: base.depth_fixed_m * mode.depth_scale(),
        depth_fraction: base.depth_fraction * mode.depth_scale(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_wire_value_and_defaults_to_the_strictest() {
        assert_eq!(CatzocMode::parse("full"), CatzocMode::Full);
        assert_eq!(CatzocMode::parse("half"), CatzocMode::Half);
        assert_eq!(CatzocMode::parse("depth_only"), CatzocMode::DepthOnly);
        assert_eq!(CatzocMode::parse("off"), CatzocMode::Off);
        // A typo must never silently weaken a hard constraint.
        assert_eq!(CatzocMode::parse("Off"), CatzocMode::Full);
        assert_eq!(CatzocMode::parse(""), CatzocMode::Full);
    }

    #[test]
    fn the_full_table_matches_v3_3_4() {
        let f = CatzocMode::Full;
        for (code, horiz, fixed, frac) in [
            (1i64, 5.0, 0.50, 0.01),
            (2, 20.0, 1.00, 0.02),
            (3, 50.0, 1.00, 0.02),
            (4, 500.0, 2.00, 0.05),
        ] {
            let a = allowance(Some(code), f);
            assert_eq!(a.horizontal_m, horiz, "CATZOC={code} horizontal");
            assert_eq!(a.depth_fixed_m, fixed, "CATZOC={code} fixed");
            assert_eq!(a.depth_fraction, frac, "CATZOC={code} fraction");
        }
    }

    #[test]
    fn d_u_and_absent_are_all_the_same_worse_than_c_bucket() {
        let f = CatzocMode::Full;
        let d = allowance(Some(5), f);
        assert_eq!(allowance(Some(6), f), d, "U must be treated as D");
        assert_eq!(allowance(None, f), d, "absent must be treated as D");
        assert_eq!(allowance(Some(99), f), d, "an unknown code must be too");
        let c = allowance(Some(4), f);
        assert!(
            d.horizontal_m > c.horizontal_m,
            "D must be strictly worse than C horizontally: {d:?} vs {c:?}"
        );
        assert_eq!(
            (d.depth_fixed_m, d.depth_fraction),
            (c.depth_fixed_m, c.depth_fraction),
            "D reuses C's DEPTH numbers — see the module docs"
        );
    }

    #[test]
    fn half_halves_both_terms() {
        let full = allowance(Some(3), CatzocMode::Full);
        let half = allowance(Some(3), CatzocMode::Half);
        assert_eq!(half.horizontal_m, full.horizontal_m / 2.0);
        assert_eq!(half.depth_fixed_m, full.depth_fixed_m / 2.0);
        assert_eq!(half.depth_fraction, full.depth_fraction / 2.0);
    }

    #[test]
    fn depth_only_drops_the_buffer_and_keeps_the_depth() {
        let full = allowance(Some(4), CatzocMode::Full);
        let depth_only = allowance(Some(4), CatzocMode::DepthOnly);
        assert_eq!(depth_only.horizontal_m, 0.0);
        assert_eq!(depth_only.depth_fixed_m, full.depth_fixed_m);
        assert_eq!(depth_only.depth_fraction, full.depth_fraction);
    }

    #[test]
    fn off_is_no_allowance_at_all_for_any_grade() {
        for code in [None, Some(1), Some(3), Some(4), Some(6)] {
            assert_eq!(allowance(code, CatzocMode::Off), CatzocAllowance::NONE);
        }
    }

    #[test]
    fn effective_depth_subtracts_fixed_plus_percentage() {
        // CATZOC B, 20m charted: 20 - (1.00 + 2% of 20) = 18.6
        let b = allowance(Some(3), CatzocMode::Full);
        assert!((b.effective_depth_m(20.0) - 18.6).abs() < 1e-9);
        // CATZOC A1, 10m charted: 10 - (0.50 + 1% of 10) = 9.4
        let a1 = allowance(Some(1), CatzocMode::Full);
        assert!((a1.effective_depth_m(10.0) - 9.4).abs() < 1e-9);
        // Off is the identity.
        assert_eq!(CatzocAllowance::NONE.effective_depth_m(7.25), 7.25);
    }

    #[test]
    fn a_drying_height_is_never_made_deeper_by_the_percentage_term() {
        // -15.0 is a real value `derive::hazards` emits for an
        // unknown-depth wreck. A naive `charted * fraction` would ADD
        // 0.75m of depth to it.
        let c = allowance(Some(4), CatzocMode::Full);
        let eff = c.effective_depth_m(-15.0);
        assert!(eff <= -15.0, "must not get deeper: {eff}");
        assert!(
            (eff - -17.0).abs() < 1e-9,
            "fixed term still applies: {eff}"
        );
    }
}
