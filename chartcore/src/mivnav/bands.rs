// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §7.1's depth-band ladder and §5.2's depth-interval rule, specialised
//! to the one question [`super::topology`] needs answered per cell: is
//! this cell part of the band's navigable connectivity?
//!
//! The ladder itself is [`super::field::BAND_LADDER_M`] — already built
//! in Phase 2, since §4.3's own depth-band refinement trigger needed it
//! first. This module adds nothing to the ladder; it is the §5.2 rule
//! applied per band, extended by one explicit judgment call.
//!
//! # Mixed cells are OPTIMISTIC here, on purpose
//!
//! §5.2 gives three outcomes: definitely navigable (`depth_min > band`),
//! definitely blocked (`depth_max < band`), and mixed
//! (`depth_min <= band <= depth_max`, which the doc says must `REFINE`,
//! never be silently treated as `SAFE`). [`navigable`] treats "mixed" as
//! passable for CONNECTIVITY purposes — it excludes only the provably
//! blocked case. This is not the same as calling a mixed cell safe: §8.4
//! is explicit that "the topology is an acceleration structure and never
//! overrides §5.2 or §16" — the exact verifier (§16,
//! `routing::raster::verify_route_legs`, reused unmodified downstream)
//! is what actually enforces §5.2's `REFINE` against the real threshold,
//! at the real corridor resolution, not at a band's own coarse one.
//! Excluding mixed cells here instead would make components smaller and
//! more numerous than the true navigable space — the wrong direction for
//! an acceleration structure, whose only job is to not miss a real route.

use super::field::TileEntry;
use super::format::{DEPTH_NO_COVERAGE, DEPTH_UNIT_DM_PER_M, FLAG_HARD_HAZARD, FLAG_LAND};

/// The `flags` bits that exclude a cell from every band's connectivity,
/// regardless of its depth — land and everything §3.3 hard-blocks
/// unconditionally.
///
/// `FLAG_NO_COVERAGE` (outside every `M_COVR`) is deliberately NOT here.
/// A user decision — "i do not know what this low certainty is, just
/// avoid all under 2 m" — extended past `UNSARE` to coverage-declaration
/// gaps too: on the `oeuSENC-DK` base set ~31 % of the region is outside
/// `M_COVR` yet carries a real charted `DEPARE` depth (bled in from a
/// coarse overview cell), and blocking all of it left routing unusable
/// in Danish inner waters. So a no-coverage cell is navigable iff it has
/// a real `depth_max >= band` — one with the `DEPTH_NO_COVERAGE`
/// sentinel (genuinely no charted depth) is still blocked, by the
/// sentinel check in [`navigable_dm`]. `FLAG_RESTRICTED`, `FLAG_OVERHEAD`,
/// `FLAG_TSS` and `FLAG_FAIRWAY` are also NOT here: whether they block
/// depends on a vessel's own permission/mast/direction, which §6 forbids
/// this (vessel-independent) layer from knowing.
const BAND_BLOCKING_FLAGS: u8 = FLAG_LAND | FLAG_HARD_HAZARD;

/// Is one cell (given its own `flags` and `depth_max`) part of `band_m`'s
/// navigable connectivity? See the module docs for why "mixed" passes.
///
/// Converts `band_m` to decimetres on every call — fine for a one-off
/// check (tests, a caller with a single cell in hand), but
/// [`super::topology`]'s own sweeps call the decimetre-native
/// [`navigable_dm`]/[`navigable_at`] directly instead, converting
/// `band_m` exactly ONCE per [`super::topology::label_band`] run rather
/// than once per cell it touches — a real cost on the Pi this artifact
/// builds on (CLAUDE.md: "Constrained = Pi CPU / decode throughput, not
/// bandwidth"), since a region sweep does this for every cell, in every
/// tile, for every one of the ten [`super::field::BAND_LADDER_M`]
/// entries.
#[inline]
pub fn navigable(flags: u8, depth_max_dm: u16, band_m: f64) -> bool {
    navigable_dm(flags, depth_max_dm, band_to_dm(band_m))
}

/// `band_m` (metres) to the same `u16` decimetre unit `depth_max` is
/// already stored in — saturating, mirroring `field::depth_dm`'s own
/// rounding/clamping.
#[inline]
pub fn band_to_dm(band_m: f64) -> u16 {
    // Clamped to ONE BELOW the sentinel, not to `u16::MAX` itself — the
    // exact `field::depth_dm` rule, for the exact same reason: `u16::MAX`
    // IS `DEPTH_NO_COVERAGE`. A band clamped to the sentinel would make
    // `navigable_dm`'s `depth_max_dm >= band_dm` compare a real depth
    // against "no coverage", and since the sentinel is excluded as
    // blocked a few lines above, EVERY cell — real depth or not — would
    // read as unnavigable at that band, silently, rather than saturating
    // to "so deep nothing charted is ever too shallow".
    (band_m * f64::from(DEPTH_UNIT_DM_PER_M))
        .round()
        .clamp(0.0, f64::from(DEPTH_NO_COVERAGE - 1)) as u16
}

/// [`navigable`], against a band ALREADY in decimetres — an integer
/// compare, no per-call float division.
#[inline]
pub fn navigable_dm(flags: u8, depth_max_dm: u16, band_dm: u16) -> bool {
    if flags & BAND_BLOCKING_FLAGS != 0 {
        return false;
    }
    // Defensive: a clear (non-blocked-flag) cell should always carry a
    // real depth (`field::depth_columns`'s own contract), but a sentinel
    // here is treated as blocked rather than trusted, the same
    // conservative direction §5.2 itself takes on missing evidence.
    if depth_max_dm == DEPTH_NO_COVERAGE {
        return false;
    }
    depth_max_dm >= band_dm
}

/// [`navigable_dm`] against a whole region's flat SoA columns
/// (`BuiltRegion::flags`/`depth_max`) at `global` — the index
/// `tile.payload_offset + tile.index(col, row)` already used throughout
/// [`super::topology`].
#[inline]
pub fn navigable_at(flags: &[u8], depth_max: &[u16], global: usize, band_dm: u16) -> bool {
    navigable_dm(flags[global], depth_max[global], band_dm)
}

/// The global SoA index of `(col, row)` inside `tile`.
#[inline]
pub fn global_index(tile: &TileEntry, col: u32, row: u32) -> usize {
    tile.payload_offset as usize + tile.index(col, row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitely_blocked_excludes_definitely_navigable_and_mixed_both_pass() {
        // depth_max in decimetres: band 3.0 m -> 30 dm.
        assert!(
            !navigable(0, 29, 3.0),
            "depth_max < band: definitely blocked"
        );
        assert!(
            navigable(0, 30, 3.0),
            "depth_max == band: not LESS than, so not blocked"
        );
        assert!(navigable(0, 100, 3.0), "definitely navigable");
        // "mixed" for band 3.0m with depth_max=30dm means depth_min<=30<=depth_max;
        // depth_min is not even consulted here — the point of the module docs'
        // judgment call — so a shallow depth_min does not exclude it.
        assert!(
            navigable(0, 35, 3.0),
            "depth_max above band despite a hypothetically mixed range"
        );
    }

    #[test]
    fn every_blocking_flag_excludes_regardless_of_depth() {
        for bit in [FLAG_LAND, FLAG_HARD_HAZARD] {
            assert!(
                !navigable(bit, 65000, 1.0),
                "flag {bit:#x} must block even at huge depth"
            );
        }
    }

    #[test]
    fn no_coverage_is_governed_by_charted_depth_now_not_the_flag() {
        use super::super::format::FLAG_NO_COVERAGE;
        // `FLAG_NO_COVERAGE` is no longer a `BAND_BLOCKING_FLAGS` member.
        // A no-coverage cell WITH a real charted depth deep enough is
        // navigable (bled-in DEPARE from a coarse overview cell — most
        // of the o-charts DK base set outside `M_COVR`)...
        assert!(navigable(FLAG_NO_COVERAGE, 100, 1.0));
        assert!(!navigable(FLAG_NO_COVERAGE, 5, 1.0), "still too shallow");
        // ...but one with the sentinel (genuinely no charted depth) is
        // still blocked, by the sentinel check — the only thing keeping
        // pure uncharted void out of the topology.
        assert!(!navigable(FLAG_NO_COVERAGE, DEPTH_NO_COVERAGE, 1.0));
        assert!(!navigable(0, DEPTH_NO_COVERAGE, 1.0));
    }

    #[test]
    fn non_blocking_flags_never_exclude_on_their_own() {
        use super::super::format::{FLAG_FAIRWAY, FLAG_OVERHEAD, FLAG_RESTRICTED, FLAG_TSS};
        let all = FLAG_FAIRWAY | FLAG_OVERHEAD | FLAG_RESTRICTED | FLAG_TSS;
        assert!(navigable(all, 100, 1.0));
    }

    #[test]
    fn an_extreme_band_saturates_never_collides_with_the_no_coverage_sentinel() {
        // A huge band_m must clamp one below DEPTH_NO_COVERAGE, not onto
        // it — landing exactly on the sentinel would make `navigable_dm`
        // read every real depth as unnavigable (excluded as "blocked" by
        // the very same check that excludes true no-coverage cells).
        let band_dm = band_to_dm(1_000_000.0);
        assert_ne!(band_dm, DEPTH_NO_COVERAGE);
        assert_eq!(band_dm, DEPTH_NO_COVERAGE - 1);
        // A cell charted at the deepest representable real value must
        // still read navigable against this saturated band.
        assert!(navigable_dm(0, DEPTH_NO_COVERAGE - 1, band_dm));
    }
}
