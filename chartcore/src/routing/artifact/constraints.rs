// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §3.3 — the EXPANDED hard-constraint feature set, plus §3.4's CATZOC
//! horizontal buffer applied per feature.
//!
//! This is the half of v3 that actually changes what a route is allowed
//! to cross. `routing::hazards::build_hazard_index` (the existing
//! algorithm's union, deliberately left untouched) covers `LNDARE`,
//! `SLCONS`, depth-gated `DEPARE`/`DRGARE`/`WRECKS`/`OBSTRN`/`UWTROC`,
//! entry-prohibited `RESARE`/`MIPARE`, and air-draft `BRIDGE`/`CBLOHD`.
//! v3 §3.3's own table is wider, and this module implements the whole of
//! it for this algorithm alone:
//!
//! | Added here | v3 rule |
//! |---|---|
//! | `PONTON` `FLODOC` `HULKES` `DAMCON` `DYKCON` `CAUSWY` `PILPNT` `MORFAC` `GATCON` | hard block, unconditional |
//! | `LOKBSN` | explicitly NOT blocking — a lock basin is water you sit in |
//! | `UNSARE` | hard block, but grace-eligible (§9.3) |
//! | absent `M_COVR` coverage | hard block, but grace-eligible (§9.3) |
//! | `SOUNDG` | each sounding shallower than required is its own point hazard |
//! | `PIPOHD` `CONVYR` | air-draft block, same rule as `BRIDGE`/`CBLOHD` |
//! | `RESARE` `RESTRN=8` | hard block unless `allow_restricted_entry` |
//! | `RESARE` `RESTRN=14` | heavy soft cost, never a block |
//! | `MARCUL` `FSHFAC` | hard block unless `allow_restricted_entry` |
//! | every hard feature | buffered by its own zone's §3.4 CATZOC horizontal figure |
//!
//! # Bugs deliberately not repeated
//!
//! Three of the existing algorithm's own live-found bugs have exact
//! analogues here, and are pre-empted rather than rediscovered:
//!
//! * **`DRVAL1`, not `DRVAL2`** (fixed upstream in commit `fa6fbb3e`): a
//!   depth band only promises its bottom lies somewhere between its
//!   shallow and deep edge, so the SHALLOW edge is what gates. A real
//!   0-10m Danish band is unsafe at 2.3m draft however deep its far edge
//!   gets.
//! * **`CATBRG` is a LIST attribute** (fixed upstream in commit
//!   `28dda296`): a real OSENC producer encodes `CATBRG` as
//!   `AttrValue::StrList(["2"])`, so `as_int` silently returns `None` for
//!   every real bridge and every openable span stays wrongly hard-blocked.
//!   [`is_openable_bridge`] uses `as_int_list`. The same applies to
//!   `RESTRN` (already `as_int_list` in `routing::hazards`) and to
//!   `CATOBS`, which is a SINGLE-valued attribute — [`is_foul_obstruction`]
//!   accepts both encodings rather than betting on one.
//! * **A missing attribute is not evidence of safety**: a `WRECKS`/
//!   `OBSTRN`/`UWTROC` with no `VALSOU`, or a `BRIDGE`/`CBLOHD`/`PIPOHD`/
//!   `CONVYR` with no `VERCLR`, BLOCKS. This is deliberately stricter than
//!   the existing algorithm, which includes a hazard only when
//!   `depth_value` is present — v3 §3.3 states the strict rule for all
//!   three hazard classes ("unknown VALSOU → blocked"), and this
//!   algorithm's whole premise is that stricter rule.
//!
//! # Judgment calls
//!
//! * **`CAUSWY`, not `CAUSWAY`.** v3's table (and the task spec derived
//!   from it) writes `CAUSWAY`; the real S-57 acronym in chartcore's own
//!   vendored `s57objectclasses.csv` (class 26, "Causeway") is `CAUSWY`.
//!   Both strings are in the class list, so neither spelling can be
//!   silently dropped by a producer that surprises us.
//! * **`GATCON` is a plain block, `LOKBSN` is not a block at all.** §11
//!   directional transitions are out of scope for this MVP (see
//!   [`super`]'s own module docs), so a gate cannot be modelled as a
//!   high-cost transition. Blocking is the conservative direction and is
//!   what v3 §3.3 itself specifies for the un-modelled case ("Gate —
//!   blocking unless modelled as a transition"). `LOKBSN` gets the
//!   opposite treatment for the same reason it is listed separately in
//!   that table: the basin is navigable water, and blocking it would make
//!   every lock approach unreachable rather than merely un-schedulable.
//! * **`SLCONS` is filtered by `CATSLC`.** v3: "Blocking for most CATSLC
//!   values ... ramps, slipways and landing steps do not block navigable
//!   water." [`NON_BLOCKING_CATSLC`] is that exemption list. A `CATSLC`
//!   that is absent or unrecognised BLOCKS — absence is not evidence of a
//!   ramp. (The existing algorithm blocks every `SLCONS` unconditionally;
//!   this is the one place where the new algorithm is deliberately LESS
//!   strict than the old, and only for values v3 names explicitly.)
//! * **`<=`, not `<`, at the depth boundary.** v3 writes
//!   `DRVAL1 < required_depth`. This uses `<=`, matching the
//!   boundary-favours-caution convention `routing::hazards` already
//!   applies throughout (`drval1 <= safety_depth_m`,
//!   `air_draft_m >= VERCLR`) — strictly more conservative than the doc,
//!   and consistent within the crate rather than differing by one
//!   algorithm.
//! * **`MARCUL`/`FSHFAC` share `allow_restricted_entry`** with `RESARE`
//!   `RESTRN=8` rather than getting an override of their own. One knob
//!   for the whole MVP; splitting it later is additive.

use geo::{BooleanOps, BoundingRect, Buffer, Intersects};

use crate::coords::{Extent, WorldXy};
use crate::coverage::{cell_coverage, signed_area2_world, Coverage};
use crate::model::{AttrValue, Cell, Feature, Geometry, Polygon};
use crate::routing::hazards::{
    entry_prohibited, finish_union, geo_ring, is_openable_bridge, push_areas,
    push_preferred_route_geometry, push_soft_avoid_geometry, radius_world_units, rings_contain,
};
use crate::routing::preference::CATZOC_LOW_CONFIDENCE_MIN;

use super::catzoc::{allowance, CatzocAllowance, CatzocMode};

/// v3 §3.3's "shoreline and harbour construction — the omitted class",
/// minus `SLCONS` (which is `CATSLC`-filtered, see
/// [`NON_BLOCKING_CATSLC`]) and minus `LOKBSN` (explicitly navigable).
/// Every one of these is a hard block regardless of depth or draft: a
/// real charted structure is impassable, the same footing `LNDARE` has.
pub(crate) const STRUCTURE_BLOCK_CLASSES: [&str; 10] = [
    "PONTON", "FLODOC", "HULKES", "DAMCON", "DYKCON", "CAUSWY", "CAUSWAY", "PILPNT", "MORFAC",
    "GATCON",
];

/// `CATSLC` values that describe a shore structure a small vessel can be
/// over without grounding on it — v3 §3.3's own "ramps, slipways and
/// landing steps do not block navigable water". Per the IHO S-57
/// Appendix A domain: `11`=landing steps, `12`=ramp, `13`=slipway,
/// `17`=log ramp. Everything else — breakwater, groyne, mole, pier,
/// training wall, quay, sea wall, rip-rap, revetment, fender, wharf —
/// blocks.
const NON_BLOCKING_CATSLC: [i64; 4] = [11, 12, 13, 17];

/// Depth-gated area classes, exactly as `routing::hazards` — `DRVAL1`
/// (the SHALLOW edge), see the module docs.
pub(crate) const DEPTH_AREA_CLASSES: [&str; 2] = ["DEPARE", "DRGARE"];

/// Depth-gated point/line/area hazards. Unlike `routing::hazards`, a
/// MISSING `VALSOU` blocks here.
pub(crate) const DEPTH_HAZARD_CLASSES: [&str; 3] = ["WRECKS", "OBSTRN", "UWTROC"];

/// Vertical-clearance obstructions — v3 §3.3's overhead table in full.
/// Two classes wider than `routing::hazards::AIR_DRAFT_CLASSES`, which
/// deliberately deferred `PIPOHD` (and never covered `CONVYR`).
pub(crate) const AIR_DRAFT_CLASSES: [&str; 4] = ["BRIDGE", "CBLOHD", "PIPOHD", "CONVYR"];

/// Hard-blocked by default, released by `allow_restricted_entry` —
/// v3 §3.3's "Additional soft-block candidates ... both are physically
/// obstructive and poorly surveyed".
pub(crate) const RESTRICTED_ENTRY_CLASSES: [&str; 2] = ["MARCUL", "FSHFAC"];

/// The two classes that carry `RESTRN` as an entry rule — shared with
/// `routing::hazards::ENTRY_RESTRICTABLE_CLASSES` in spirit, re-declared
/// here because this algorithm reads THREE `RESTRN` codes, not one.
pub(crate) const ENTRY_RESTRICTABLE_CLASSES: [&str; 2] = ["RESARE", "MIPARE"];

/// Soft-avoid families, reusing `routing::preference`'s own class split
/// (and therefore its two config weights) verbatim.
pub(crate) const TSS_AVOID_CLASSES: [&str; 4] = ["TSSLPT", "TSSRON", "TSSCRS", "PRCARE"];
pub(crate) const PREFERRED_ROUTE_CLASSES: [&str; 4] = ["FAIRWY", "RECTRC", "NAVLNE", "DWRTPT"];
const CABLE_AVOID_CLASSES: [&str; 2] = ["CBLSUB", "PIPSOL"];
const CAUTION_AVOID_CLASSES: [&str; 2] = ["ACHARE", "CTNARE"];

/// S-57 `RESTRN` codes this algorithm reads. `7` = entry prohibited
/// (always hard, no override); `8` = entry restricted (hard by default,
/// overridable); `14` = area to be avoided (heavy soft cost, never hard).
const RESTRN_ENTRY_PROHIBITED: i64 = 7;
const RESTRN_ENTRY_RESTRICTED: i64 = 8;
const RESTRN_AREA_TO_BE_AVOIDED: i64 = 14;

/// `CATOBS` values that mean foul ground: `6` = foul area, `7` = foul
/// ground. v3 §3.3: "CATOBS foul area → blocked regardless of depth."
const FOUL_CATOBS: [i64; 2] = [6, 7];

// `CATZOC_LOW_CONFIDENCE_MIN` (the `>= 4`/C-D-U threshold for the SOFT
// survey-quality term) is `routing::preference::CATZOC_LOW_CONFIDENCE_MIN`,
// imported above — shared so a future retune of the threshold can't leave
// this algorithm silently disagreeing with `raster` about the identical
// M_QUAL zone.

/// A `SOUNDG` point is a point observation, not an area, so it needs a
/// nominal footprint to exist in a ring union at all — the same problem
/// `routing::hazards::MIN_HAZARD_RADIUS_WORLD` solves for a bare `WRECKS`
/// point, but sized as a real distance rather than a one-world-unit
/// epsilon, because a sounding's own position carries real uncertainty
/// and there is no per-feature margin behind it here. Deliberately a
/// fixed internal constant, not a config field: nobody has a basis to
/// tune it, exactly as `routing::hazards::LINE_PREFERENCE_HALF_WIDTH_M`'s
/// own docs argue for that constant.
const SOUNDING_HAZARD_RADIUS_M: f64 = 7.5;

/// Point/line geometry gets at least this many world units of buffer so
/// it exists in the union as an area at all — mirrors
/// `routing::hazards::MIN_HAZARD_RADIUS_WORLD`.
const MIN_HAZARD_RADIUS_WORLD: f64 = 1.0;

/// Everything one `artifact` query needs to know about chart truth,
/// as flat signed ring sets in world coordinates (the same convention
/// `routing::hazards::HazardIndex::rings` and `coverage::Coverage::rings`
/// both use: positive-area ring adds, negative-area ring subtracts,
/// nonzero winding decides).
#[derive(Debug, Clone, Default)]
pub struct ArtifactConstraints {
    /// §3.3's hard blocks, CATZOC- and margin-buffered. Never crossable,
    /// never graced.
    pub hard: Vec<Vec<WorldXy>>,
    /// Water charted between `required_depth_m` and `avoid_depth_m` —
    /// `avoid_depth_weight`, a HEAVY soft cost `search::build_field`
    /// folds straight into the per-cell multiplier. Empty when the tier
    /// is disabled.
    pub depth_avoid: Vec<Vec<WorldXy>>,
    /// Water charted between `avoid_depth_m` and `soft_prefer_depth_m` —
    /// `prefer_depth_weight`, a LIGHT "prefer deeper" nudge. Empty when
    /// disabled. Exclusive of `depth_avoid` (a 3 m area is only in the
    /// avoid tier).
    pub depth_soft: Vec<Vec<WorldXy>>,
    /// Every `DEPARE`/`DRGARE` polygon in the corridor, ANY depth, UNbuffered
    /// — "a chart states a depth here". `search` uses it to let a cell
    /// that is OUTSIDE `M_COVR` but nonetheless carries a real charted
    /// depth be crossed (at the unknown-water cost) instead of hard-
    /// blocked: on the o-charts DK base set ~⅓ of the region is outside
    /// `M_COVR` yet has a `DEPARE` depth bled in from a coarse overview
    /// cell, and blocking it left routing unusable. A no-coverage cell
    /// with NO `charted_depth` under it stays blocked.
    pub charted_depth: Vec<Vec<WorldXy>>,
    /// `UNSARE`. Blocking, but GRACE-ELIGIBLE (§9.3) — unknown water, not
    /// known-bad water.
    ///
    /// **Dead as of the depth-tier change**: `build_one_cell`'s `UNSARE`
    /// arm no longer fills this (charted depth governs unsurveyed water
    /// now, per a user decision — "i do not know what this low certainty
    /// is, just avoid all under 2 m"). Only absent-`M_COVR` water still
    /// reaches `search`'s `F_UNKNOWN` block, via the `coverage`
    /// complement. Kept as a field so callers still compile; remove when
    /// nothing reads it.
    pub unsurveyed: Vec<Vec<WorldXy>>,
    /// Positive chart coverage. Anything OUTSIDE this is no-coverage,
    /// which blocks on the same grace-eligible footing as `unsurveyed`.
    /// EMPTY means "no cell made any coverage statement at all", in which
    /// case the no-coverage rule has no ground to stand on and is skipped
    /// entirely rather than blocking the whole world.
    pub coverage: Vec<Vec<WorldXy>>,
    /// `ACHARE`/`CTNARE` + permitted-transit `RESARE`/`MIPARE` —
    /// `caution_area_avoidance_weight`.
    pub caution: Vec<Vec<WorldXy>>,
    /// `CBLSUB`/`PIPSOL` — `cable_avoidance_weight`.
    pub cable: Vec<Vec<WorldXy>>,
    /// `TSSLPT`/`TSSRON`/`TSSCRS`/`PRCARE` — `tss_avoidance_weight`.
    pub tss: Vec<Vec<WorldXy>>,
    /// `FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT` — `fairway_preference_weight`,
    /// the one NEGATIVE term.
    pub preferred: Vec<Vec<WorldXy>>,
    /// Low-confidence `M_QUAL` zones + `UNSARE` —
    /// `low_confidence_survey_avoidance_weight`.
    pub survey: Vec<Vec<WorldXy>>,
    /// `RESARE` `RESTRN=14`, area to be avoided — §10.3's `+5.0` tier.
    pub atba: Vec<Vec<WorldXy>>,
    /// Purely informational: an openable `BRIDGE` this boat cannot clear
    /// closed, and `UNSARE`. Feeds `check_manually_legs`, never the
    /// search.
    pub check_manually: Vec<Vec<WorldXy>>,
    /// The COARSEST §3.4 horizontal figure over every `M_QUAL` zone
    /// consulted (or the D/U figure when none was) — feeds
    /// [`super::ladder::finest_allowed_cell_m`].
    pub catzoc_horizontal_m: f64,
    /// The FINEST (numerically smallest nonzero) compilation-scale
    /// denominator over the cells consulted — the other half of §4.1's
    /// formula. `0` when no cell recorded one.
    pub compilation_scale: u32,
}

/// The vessel/query inputs [`build`] needs. Every field except the three
/// `artifact_*` ones already exists on `RoutingConfig`.
#[derive(Debug, Clone, Copy)]
pub struct ConstraintParams {
    /// `draft + under_keel_margin` (already combined by the caller, the
    /// same convention `routing::hazards`' `safety_depth_m` uses). Water
    /// charted shallower than this is a HARD block (`hard`).
    pub required_depth_m: f64,
    /// Charted depths in `(required_depth_m, avoid_depth_m]` go to
    /// [`ArtifactConstraints::depth_avoid`] — a HEAVY soft cost the
    /// search takes only when there is no way around. `<= required_depth_m`
    /// disables the tier (it would be a subset of `hard`).
    pub avoid_depth_m: f64,
    /// Charted depths in `(avoid_depth_m, soft_prefer_depth_m]` go to
    /// [`ArtifactConstraints::depth_soft`] — a LIGHT "prefer deeper"
    /// nudge. `<= max(required_depth_m, avoid_depth_m)` disables it.
    pub soft_prefer_depth_m: f64,
    /// Mast height above the waterline. `0.0` = OFF; the whole overhead
    /// scan is skipped, matching `routing::hazards`' own air-draft gate.
    pub required_air_draft_m: f64,
    /// A fixed clearance buffered onto every hard-blocking feature, on
    /// TOP of the CATZOC figure.
    pub lateral_margin_m: f64,
    pub catzoc_mode: CatzocMode,
    /// Releases `RESARE` `RESTRN=8`, `MARCUL` and `FSHFAC` — one knob for
    /// all three, see the module docs.
    pub allow_restricted_entry: bool,
    /// Populate [`ArtifactConstraints::charted_depth`] — the union of
    /// EVERY `DEPARE`/`DRGARE` ring, any depth. Only
    /// `routing::artifact::search::build_field`'s coverage-complement
    /// grace reads it, so it is `true` only on the fine-search path.
    /// The whole-region `mivnav` bake leaves it `false`: depth areas are
    /// the most numerous polygon class on a chart and their `rings_of`
    /// union is ~80 % of `build_region` already (see `mivnav::build`) —
    /// unioning them a second time for a field the bake never reads
    /// roughly doubled DK build time.
    pub build_charted_depth: bool,
}

/// One `M_QUAL` zone, kept as raw rings for the point-in-zone lookup
/// [`catzoc_at`] does per hard feature.
struct QualityZone {
    rings: Vec<Vec<WorldXy>>,
    extent: Extent,
    catzoc: Option<i64>,
}

/// Build the whole constraint set for `cells` at `params`.
///
/// `cells` is every chart cell the corridor might cross, in the caller's
/// own order, unioned flatly with NO authority resolution of its own
/// (§3.2's "finest cell wins") — that pass runs one level up, at the
/// CELL-SELECTION grain, not here: query-time callers go through
/// [`super::build_query_constraints`], which drops a whole `cells` entry
/// a finer one already charts in full before this function ever sees it
/// ([`super`]'s own "What this algorithm does" docs have the story); the
/// persisted-artifact bake (`crate::mivnav::build_region`) runs the
/// identical pass itself, over each quadtree node's own extent, and hands
/// an already-filtered slice straight to THIS function. Calling `build`
/// directly with an unfiltered `cells` (as `mivnav::authority`'s own
/// callers must not, and as no code in this tree still does) skips that
/// pass entirely: cells would union flatly again, and a coarse cell's own
/// ring can outvote a finer cell's "this is open water" for the same
/// ground — the acceptable failure direction for a strict algorithm
/// (errs toward blocking) but still a real, avoidable false refusal.
pub fn build(cells: &[&Cell], params: &ConstraintParams) -> ArtifactConstraints {
    // `build` has NO cross-cell interaction — every cell's rings and
    // scalar contributions are accumulated independently (concat for the
    // ring vecs, `max`/`min` for the two scalars), and only then unioned
    // by `combine`'s `rings_of`. So `build(cells)` is exactly
    // `combine(cells.map(build_one_cell))`, which lets a caller that
    // builds the same cell against many overlapping extents
    // (`mivnav::build_region`'s quadtree) decode each cell ONCE and just
    // re-`combine` the relevant subset per tile. `combine` runs the same
    // `rings_of` over the same accumulated polygons, so the result is
    // byte-identical — pinned by `build_equals_the_sum_of_its_per_cell_parts`.
    let parts: Vec<CellConstraints> = cells.iter().map(|c| build_one_cell(c, params)).collect();
    combine(&parts)
}

/// One cell's contribution to an [`ArtifactConstraints`], BEFORE the
/// per-ring-type union `combine`/`build` finish with. Accumulate as many
/// of these as the corridor needs, then hand them all to [`combine`].
///
/// The `geo::Polygon` vecs are already per-feature buffered (the CATZOC
/// horizontal figure at each hard feature's own `M_QUAL` zone, plus the
/// caller's fixed lateral margin) — that decode + buffer is the
/// expensive part, and it depends only on the cell and `params`, never
/// on any extent, so it is exactly what a per-cell cache should hold.
#[derive(Debug, Clone, Default)]
pub struct CellConstraints {
    hard: Vec<geo::Polygon<f64>>,
    depth_avoid: Vec<geo::Polygon<f64>>,
    depth_soft: Vec<geo::Polygon<f64>>,
    charted_depth: Vec<geo::Polygon<f64>>,
    unsurveyed: Vec<geo::Polygon<f64>>,
    coverage: Vec<geo::Polygon<f64>>,
    caution: Vec<geo::Polygon<f64>>,
    cable: Vec<geo::Polygon<f64>>,
    tss: Vec<geo::Polygon<f64>>,
    preferred: Vec<geo::Polygon<f64>>,
    survey: Vec<geo::Polygon<f64>>,
    atba: Vec<geo::Polygon<f64>>,
    check_manually: Vec<geo::Polygon<f64>>,
    coarsest_horizontal_m: f64,
    finest_scale: u32,
}

impl CellConstraints {
    /// Clip every hazard-DEFINING class against `finer_regions` — one
    /// already-resolved finer cell's own charted [`Coverage`] region at a
    /// time, folded (never a pre-unioned batch of several; see
    /// [`build_ring_clipped`]'s own docs for why). A no-op when
    /// `finer_regions` is empty (the common case: most per-leg candidate
    /// slices have nothing finer to defer to at all).
    ///
    /// Deliberately NOT `coverage` (additive — every cell's own `M_COVR`
    /// statement counts, clipping it would just be erasing information)
    /// and NOT `charted_depth` (deliberately permissive DEPARE/DRGARE
    /// evidence for the no-coverage-but-charted-depth rule — see its own
    /// field docs; clipping it would only ever REDUCE routability, the
    /// opposite of what that rule exists for). `unsurveyed` is always
    /// empty (see the `UNSARE` arm) so clipping it is a no-op regardless.
    fn clip_hazard_classes(&mut self, finer_regions: &[geo::MultiPolygon<f64>]) {
        if finer_regions.is_empty() {
            return;
        }
        for polys in [
            &mut self.hard,
            &mut self.depth_avoid,
            &mut self.depth_soft,
            &mut self.caution,
            &mut self.cable,
            &mut self.tss,
            &mut self.preferred,
            &mut self.survey,
            &mut self.atba,
            &mut self.check_manually,
        ] {
            clip_polys(polys, finer_regions);
        }
    }
}

/// `polys`, minus every ring in `finer_regions`, folded ONE REGION at a
/// time — `(A − B) − C == A − (B ∪ C)` by plain set algebra, so this
/// computes the identical answer to differencing against one big union
/// while never asking the overlay engine to reason about more than two
/// `MultiPolygon`s at once (`routing::hazards::clip_to_authority`'s own
/// docs have the measured `i_overlay` non-monotonicity this fold
/// pattern avoids). A no-op on an empty `polys` — nothing to clip.
///
/// Bbox-gated per polygon: a polygon is only differenced against the
/// regions whose bounding rect touches its own, and one that touches
/// none is kept as-is without entering the overlay engine at all — the
/// cheap "a ring whose own bbox misses the accumulator cannot touch any
/// ground it might still hold" gate `clip_to_authority` relies on.
fn clip_polys(polys: &mut Vec<geo::Polygon<f64>>, finer_regions: &[geo::MultiPolygon<f64>]) {
    if polys.is_empty() || finer_regions.is_empty() {
        return;
    }
    let region_boxes: Vec<Option<geo::Rect<f64>>> =
        finer_regions.iter().map(|r| r.bounding_rect()).collect();
    let mut out: Vec<geo::Polygon<f64>> = Vec::with_capacity(polys.len());
    for poly in std::mem::take(polys) {
        let Some(pbox) = poly.bounding_rect() else {
            continue;
        };
        let mut acc: Option<geo::MultiPolygon<f64>> = None;
        for (region, rbox) in finer_regions.iter().zip(&region_boxes) {
            let Some(rbox) = rbox else { continue };
            if !pbox.intersects(rbox) {
                continue;
            }
            let cur = acc.get_or_insert_with(|| geo::MultiPolygon::new(vec![poly.clone()]));
            if cur.0.is_empty() {
                break;
            }
            *cur = cur.difference(region);
        }
        match acc {
            None => out.push(poly),
            Some(mp) => out.extend(mp.0),
        }
    }
    *polys = out;
}

/// One cell's own charted region — `Coverage`'s nonzero-winding rule
/// (positive rings add, negative rings declare no-data and subtract),
/// resolved into a plain `geo::MultiPolygon` — the authority mask
/// [`build_ring_clipped`] clips a coarser cell's own hazard-defining
/// polygons against. Mirrors `mivnav::authority`'s own `region_within`
/// (the identical reconstruction, there also clipped to an extent and
/// antimeridian-shifted — neither needed here: a routing corridor is
/// always local, and this crate has no chart set anywhere near the
/// seam), kept as its own small copy rather than exposed from a module
/// this one has no other reason to depend on.
///
/// `None` when the cell declares no POSITIVE coverage at all — nothing
/// to clip against, so the caller must KEEP the coarser cell's geometry
/// rather than treat this as "covers everything" or "covers nothing";
/// the same "unprovable ⇒ keep" direction
/// `mivnav::authority::has_residual_in_region` documents for the
/// identical case.
fn coverage_region(cov: &Coverage) -> Option<geo::MultiPolygon<f64>> {
    let mut adds: Vec<geo::Polygon<f64>> = Vec::new();
    let mut subs: Vec<&Vec<WorldXy>> = Vec::new();
    for ring in &cov.rings {
        match signed_area2_world(ring) {
            a if a > 0 => adds.push(geo::Polygon::new(geo_ring(ring), vec![])),
            a if a < 0 => subs.push(ring),
            _ => {}
        }
    }
    if adds.is_empty() {
        return None;
    }
    let mut region = geo::unary_union(&adds);
    for neg in subs {
        if region.0.is_empty() {
            return None;
        }
        region = region.difference(&geo::MultiPolygon::new(vec![geo::Polygon::new(
            geo_ring(neg),
            vec![],
        )]));
    }
    (!region.0.is_empty()).then_some(region)
}

/// [`build`], plus a second §3.2 pass over what's left: a cell's own
/// hazard-defining polygons are clipped against every strictly-finer
/// cell's own real coverage before the per-class union runs — the
/// PARTIAL case [`super::authority_filtered`]'s whole-cell drop cannot
/// reach. A cell authoritative for only SOME of a corridor keeps its
/// full geometric contribution there (it is not redundant, so
/// `authority_filtered` correctly keeps it whole) but must not also
/// outvote a finer cell's "this is open water" for ground that finer
/// cell demonstrably covers — the exact live-reproduced case a whole-
/// cell drop alone does not fix: a real Nordby-narrows portal point
/// stayed `goal_blocked` after `authority_filtered` landed, because the
/// coarse cell polluting it also charts real, unique ground elsewhere in
/// the same leg's corridor.
///
/// `cells` is assumed ALREADY whole-cell-filtered
/// (`super::authority_filtered`) — this pass is strictly additional, not
/// a substitute: a fully-redundant cell dropped there never reaches this
/// function at all, cheaper than clipping its contribution down to
/// nothing here. Calling this directly with an unfiltered `cells` still
/// produces a safe (if needlessly expensive) answer — a cell this pass
/// would clip to nothing on its own is just clipped to nothing instead
/// of never being decoded — but every real caller goes through
/// `super::build_query_constraints`, which does both in order.
///
/// Processed FINEST scale first (a `0`, meaning no recorded scale, sorts
/// as if coarsest — the same "worst-case, not best-case" call the
/// unzoned CATZOC fallback elsewhere in this file makes), mirroring
/// `hazard_indexes_for_bbox`'s own ordering. A per-leg candidate slice is
/// small — single digits to a few dozen cells, typically one or two
/// distinct scale tiers — nowhere near the "dozens of edge-tiling cells
/// in one bbox" scale `clip_to_authority`'s docs measured non-monotonic,
/// so folding by CELL rather than by ring (one cell's own `Coverage` can
/// itself be a multi-ring shape) stays well inside the safe regime that
/// fold pattern exists for.
pub(crate) fn build_ring_clipped(
    cells: &[&Cell],
    params: &ConstraintParams,
) -> ArtifactConstraints {
    if cells.len() < 2 {
        return build(cells, params);
    }
    let mut order: Vec<usize> = (0..cells.len()).collect();
    order.sort_by_key(|&i| {
        let scale = cells[i].meta.compilation_scale;
        if scale == 0 {
            u32::MAX
        } else {
            scale
        }
    });

    let mut parts: Vec<CellConstraints> = Vec::with_capacity(cells.len());
    let mut finer_regions: Vec<geo::MultiPolygon<f64>> = Vec::new();
    for (k, &i) in order.iter().enumerate() {
        let mut part = build_one_cell(cells[i], params);
        part.clip_hazard_classes(&finer_regions);
        // A cell's coverage region only ever clips cells LATER in this
        // order, and only where their extents meet — so skip the
        // `unary_union` entirely when no later cell overlaps this one.
        // That always skips the coarsest cell (typically a national
        // overview whose coverage is hundreds of island patches — the
        // union that made this pass unaffordable per query).
        let clips_something = order[k + 1..]
            .iter()
            .any(|&j| cells[j].extent.intersects(&cells[i].extent));
        if clips_something {
            if let Some(cov) = cell_coverage(cells[i]) {
                if let Some(region) = coverage_region(&cov) {
                    finer_regions.push(region);
                }
            }
        }
        parts.push(part);
    }
    // `combine` has no ordering requirement of its own (`build`'s docs:
    // the only order-sensitive step, `M_QUAL` zone first-match, is
    // entirely PER-CELL — `quality_zones`/`catzoc_at` never look past
    // the one cell they were called with) — `parts` in scale order
    // rather than `cells`' own input order is exactly as valid an input,
    // and still a deterministic function of `cells` (a stable sort of a
    // deterministic key), so the §13.2 byte-identical-repeated-query
    // guarantee still holds.
    combine(&parts)
}

/// One cell's [`CellConstraints`] — the body of what [`build`]'s cell
/// loop used to do inline, extracted so a caller can cache it.
pub fn build_one_cell(cell: &Cell, params: &ConstraintParams) -> CellConstraints {
    let mut hard: Vec<geo::Polygon<f64>> = Vec::new();
    let mut depth_avoid: Vec<geo::Polygon<f64>> = Vec::new();
    let mut depth_soft: Vec<geo::Polygon<f64>> = Vec::new();
    let mut charted_depth: Vec<geo::Polygon<f64>> = Vec::new();
    // Never filled any more (see the `UNSARE` arm) — kept for the
    // `CellConstraints` field until nothing reads `unsurveyed`.
    let unsurveyed: Vec<geo::Polygon<f64>> = Vec::new();
    let mut coverage: Vec<geo::Polygon<f64>> = Vec::new();
    let mut caution: Vec<geo::Polygon<f64>> = Vec::new();
    let mut cable: Vec<geo::Polygon<f64>> = Vec::new();
    let mut tss: Vec<geo::Polygon<f64>> = Vec::new();
    let mut preferred: Vec<geo::Polygon<f64>> = Vec::new();
    let mut survey: Vec<geo::Polygon<f64>> = Vec::new();
    let mut atba: Vec<geo::Polygon<f64>> = Vec::new();
    let mut check_manually: Vec<geo::Polygon<f64>> = Vec::new();

    // The worst §3.4 horizontal figure ACTUALLY APPLIED in this cell —
    // both from a declared `M_QUAL` zone's own grade (below) AND from
    // every hard-blocking feature's own per-feature buffer (tracked
    // inline in the feature loop, since a feature outside every zone gets
    // the unzoned U fallback, which is coarser than any single declared
    // zone and must not be silently dropped just because SOME zone
    // happens to exist elsewhere in the same corridor — see the bug this
    // replaced: it used to report only the coarsest ZONED grade, wrongly
    // picking a fine ladder rung for a corridor whose real hard hazards
    // sat outside every zone at the much coarser unzoned figure).
    let mut coarsest_horizontal_m: f64 = 0.0;
    let mut finest_scale: u32 = 0;

    {
        if cell.meta.compilation_scale > 0
            && (finest_scale == 0 || cell.meta.compilation_scale < finest_scale)
        {
            finest_scale = cell.meta.compilation_scale;
        }

        let zones = quality_zones(cell);
        for z in &zones {
            let h = allowance(z.catzoc, params.catzoc_mode).horizontal_m;
            coarsest_horizontal_m = coarsest_horizontal_m.max(h);
        }

        // The whole-cell fallback: a feature in no M_QUAL zone at all is
        // treated as U (see `catzoc`'s own module docs).
        let unzoned = allowance(None, params.catzoc_mode);

        push_cell_coverage(cell, &mut coverage);

        for f in &cell.features {
            let acronym = f.acronym.as_str();
            // Every HARD class shares one buffer computation: the
            // feature's own zone's CATZOC horizontal figure plus the
            // caller's fixed lateral margin. Computed lazily per feature
            // rather than per class, so no class can accidentally skip it.
            let depth_allowance = |f: &Feature| -> CatzocAllowance {
                match catzoc_at(&zones, feature_centre(f)) {
                    Some(z) => allowance(z, params.catzoc_mode),
                    // In no zone at all: the whole-cell U fallback.
                    None => unzoned,
                }
            };

            match acronym {
                // ── Land and construction: unconditional hard blocks ───
                "LNDARE" => {
                    let da = depth_allowance(f);
                    coarsest_horizontal_m = coarsest_horizontal_m.max(da.horizontal_m);
                    push_geometry(f, params.lateral_margin_m + da.horizontal_m, &mut hard);
                }
                "SLCONS" => {
                    if slcons_blocks(f) {
                        let da = depth_allowance(f);
                        coarsest_horizontal_m = coarsest_horizontal_m.max(da.horizontal_m);
                        push_geometry(f, params.lateral_margin_m + da.horizontal_m, &mut hard);
                    }
                }
                // The class family neither `raster` nor `graph` knows
                // about at all — v3 §3.3's "omitted class".
                _ if STRUCTURE_BLOCK_CLASSES.contains(&acronym) => {
                    let da = depth_allowance(f);
                    coarsest_horizontal_m = coarsest_horizontal_m.max(da.horizontal_m);
                    push_geometry(f, params.lateral_margin_m + da.horizontal_m, &mut hard);
                }
                // Explicitly navigable — listed so a future reader sees
                // the omission is deliberate, not an oversight.
                "LOKBSN" => {}

                // ── Unsurveyed area (UNSARE) ──────────────────────────
                //
                // NO LONGER a hard block. User decision: "i do not know
                // what this low certainty is. just avoid all under 2 m"
                // — an unsurveyed area is governed by its own charted
                // depth (the `hard` / `depth_avoid` / `depth_soft` tiers
                // above, from whatever DEPARE covers it), not by the
                // survey grade. It still feeds the OPTIONAL, default-off
                // `low_confidence_survey_avoidance_weight` and still
                // raises `check_manually` for the human. `unsurveyed`
                // (→ `search`'s `F_UNKNOWN` block) is deliberately NOT
                // filled here any more — only absent `M_COVR` coverage
                // reaches that block now.
                "UNSARE" => {
                    push_areas(f, 0.0, &mut survey);
                    push_areas(f, 0.0, &mut check_manually);
                }

                // ── Depth ─────────────────────────────────────────────
                _ if DEPTH_AREA_CLASSES.contains(&acronym) => {
                    let drval1 = f.attr("drval1").and_then(AttrValue::as_float);
                    let drval2 = f.attr("drval2").and_then(AttrValue::as_float);
                    // "a chart states a depth here" — any depth, no buffer.
                    // Gated on EITHER `DRVAL` being present, matching the
                    // mivnav bake's `field::depth_columns` rule (a real
                    // `depth_max` iff `d1` or `d2` is set; `(None, None)`
                    // contributes nothing). Keeping this in step with the
                    // bake is the whole point of the field: a no-coverage
                    // cell the band topology calls navigable must be
                    // grace-eligible in the fine search too, not an
                    // ungraced `F_UNKNOWN` hard block — and a DRVAL2-only
                    // DEPARE stamps a `depth_max` in the bake just the same.
                    if params.build_charted_depth && (drval1.is_some() || drval2.is_some()) {
                        push_geometry(f, 0.0, &mut charted_depth);
                    }
                    let Some(drval1) = drval1 else {
                        // Absent DRVAL1 is genuinely common across whole
                        // charted areas and says nothing about danger —
                        // treating it as unsafe would make the union
                        // uselessly conservative. Same call
                        // `routing::hazards` makes, and deliberately
                        // UNLIKE the VALSOU/VERCLR rule below.
                        continue;
                    };
                    // One CATZOC lookup, reused for both the depth test
                    // and the buffer — computing it twice (once per use)
                    // was real, measured double work on busy harbour
                    // corridors with thousands of depth-gated features.
                    let da = depth_allowance(f);
                    let eff = da.effective_depth_m(drval1);
                    let buffer = params.lateral_margin_m + da.horizontal_m;
                    match depth_tier(eff, params) {
                        DepthTier::Hard => {
                            coarsest_horizontal_m = coarsest_horizontal_m.max(da.horizontal_m);
                            push_geometry(f, buffer, &mut hard);
                        }
                        // A soft "prefer deeper" zone must NOT coarsen the
                        // corridor grid — only a hard hazard does (matches
                        // pre-tier behaviour: a 3 m DEPARE at `required`
                        // 2 m never touched `coarsest_horizontal_m`).
                        DepthTier::Avoid => push_geometry(f, buffer, &mut depth_avoid),
                        DepthTier::Soft => push_geometry(f, buffer, &mut depth_soft),
                        DepthTier::None => {}
                    }
                }
                "SOUNDG" => {
                    let da = depth_allowance(f);
                    coarsest_horizontal_m = coarsest_horizontal_m.max(da.horizontal_m);
                    let buffer = params.lateral_margin_m + da.horizontal_m;
                    push_shallow_soundings(f, da, params.required_depth_m, buffer, &mut hard);
                    if params.avoid_depth_m > params.required_depth_m {
                        push_soundings_between(
                            f,
                            da,
                            params.required_depth_m,
                            params.avoid_depth_m,
                            buffer,
                            &mut depth_avoid,
                        );
                    }
                    if params.soft_prefer_depth_m
                        > params.avoid_depth_m.max(params.required_depth_m)
                    {
                        push_soundings_between(
                            f,
                            da,
                            params.avoid_depth_m.max(params.required_depth_m),
                            params.soft_prefer_depth_m,
                            buffer,
                            &mut depth_soft,
                        );
                    }
                }

                // ── Charted hazards ───────────────────────────────────
                _ if DEPTH_HAZARD_CLASSES.contains(&acronym) => {
                    let da = depth_allowance(f);
                    let valsou = f.attr("VALSOU").and_then(AttrValue::as_float);
                    let blocked = match valsou {
                        // Absence is not evidence of safety (§3.3).
                        None => true,
                        Some(v) => da.effective_depth_m(v) <= params.required_depth_m,
                    } || (acronym == "OBSTRN" && is_foul_obstruction(f));
                    if blocked {
                        coarsest_horizontal_m = coarsest_horizontal_m.max(da.horizontal_m);
                        push_geometry(f, params.lateral_margin_m + da.horizontal_m, &mut hard);
                    }
                }

                // ── Overhead ──────────────────────────────────────────
                _ if AIR_DRAFT_CLASSES.contains(&acronym) => {
                    if params.required_air_draft_m <= 0.0 {
                        continue;
                    }
                    let verclr = f.attr("VERCLR").and_then(AttrValue::as_float);
                    let blocked = match verclr {
                        Some(clr) => params.required_air_draft_m >= clr,
                        None => true,
                    };
                    if !blocked {
                        continue;
                    }
                    if acronym == "BRIDGE" && is_openable_bridge(f) {
                        // Not a hard block: a real opening can be
                        // requested, but this router cannot confirm one is
                        // available. Same "check manually" tier
                        // `routing::hazards::build_openable_bridge_union`
                        // established — unbuffered, it is a flag on the
                        // structure, not a hazard needing clearance.
                        push_geometry(f, 0.0, &mut check_manually);
                    } else {
                        let da = depth_allowance(f);
                        coarsest_horizontal_m = coarsest_horizontal_m.max(da.horizontal_m);
                        push_geometry(f, params.lateral_margin_m + da.horizontal_m, &mut hard);
                    }
                }

                // ── Regulatory ────────────────────────────────────────
                _ if ENTRY_RESTRICTABLE_CLASSES.contains(&acronym) => {
                    let codes = f
                        .attr("RESTRN")
                        .and_then(AttrValue::as_int_list)
                        .unwrap_or_default();
                    if codes.contains(&RESTRN_ENTRY_PROHIBITED)
                        || (codes.contains(&RESTRN_ENTRY_RESTRICTED)
                            && !params.allow_restricted_entry)
                    {
                        let da = depth_allowance(f);
                        coarsest_horizontal_m = coarsest_horizontal_m.max(da.horizontal_m);
                        push_geometry(f, params.lateral_margin_m + da.horizontal_m, &mut hard);
                    } else if codes.contains(&RESTRN_AREA_TO_BE_AVOIDED) {
                        push_soft_avoid_geometry(f, &mut atba);
                    } else {
                        // Includes RESTRN-absent — see
                        // `routing::hazards::entry_prohibited`'s own docs
                        // for why absence resolves to soft-avoid rather
                        // than to either extreme.
                        debug_assert!(!entry_prohibited(f));
                        push_soft_avoid_geometry(f, &mut caution);
                    }
                }
                _ if RESTRICTED_ENTRY_CLASSES.contains(&acronym) => {
                    if params.allow_restricted_entry {
                        push_soft_avoid_geometry(f, &mut caution);
                    } else {
                        let da = depth_allowance(f);
                        coarsest_horizontal_m = coarsest_horizontal_m.max(da.horizontal_m);
                        push_geometry(f, params.lateral_margin_m + da.horizontal_m, &mut hard);
                    }
                }

                // ── Soft tiers ────────────────────────────────────────
                _ if CAUTION_AVOID_CLASSES.contains(&acronym) => {
                    push_soft_avoid_geometry(f, &mut caution)
                }
                _ if CABLE_AVOID_CLASSES.contains(&acronym) => {
                    push_soft_avoid_geometry(f, &mut cable)
                }
                _ if TSS_AVOID_CLASSES.contains(&acronym) => push_areas(f, 0.0, &mut tss),
                _ if PREFERRED_ROUTE_CLASSES.contains(&acronym) => {
                    push_preferred_route_geometry(f, &mut preferred)
                }
                "M_QUAL" => {
                    let catzoc = f.attr("CATZOC").and_then(AttrValue::as_int);
                    if catzoc.is_none_or(|v| v >= CATZOC_LOW_CONFIDENCE_MIN) {
                        push_areas(f, 0.0, &mut survey);
                    }
                }
                _ => {}
            }
        }
    }

    CellConstraints {
        hard,
        depth_avoid,
        depth_soft,
        charted_depth,
        unsurveyed,
        coverage,
        caution,
        cable,
        tss,
        preferred,
        survey,
        atba,
        check_manually,
        coarsest_horizontal_m,
        finest_scale,
    }
}

/// Which depth tier `eff` (the CATZOC-adjusted charted depth) falls in.
enum DepthTier {
    Hard,
    Avoid,
    Soft,
    None,
}

fn depth_tier(eff: f64, p: &ConstraintParams) -> DepthTier {
    if eff <= p.required_depth_m {
        DepthTier::Hard
    } else if eff <= p.avoid_depth_m {
        DepthTier::Avoid
    } else if eff <= p.soft_prefer_depth_m {
        DepthTier::Soft
    } else {
        DepthTier::None
    }
}

/// Union each [`CellConstraints`] ring type across `parts` and assemble
/// the finished [`ArtifactConstraints`] — the tail [`build`]'s cell loop
/// used to do inline. `catzoc_horizontal_m` is the `max` of every part's
/// own (folded over both its M_QUAL zones and its hard features,
/// including the unzoned U fallback); `compilation_scale` is the
/// numerically smallest nonzero.
pub fn combine<'a>(parts: impl IntoIterator<Item = &'a CellConstraints>) -> ArtifactConstraints {
    let mut hard: Vec<geo::Polygon<f64>> = Vec::new();
    let mut depth_avoid: Vec<geo::Polygon<f64>> = Vec::new();
    let mut depth_soft: Vec<geo::Polygon<f64>> = Vec::new();
    let mut charted_depth: Vec<geo::Polygon<f64>> = Vec::new();
    let mut unsurveyed: Vec<geo::Polygon<f64>> = Vec::new();
    let mut coverage: Vec<geo::Polygon<f64>> = Vec::new();
    let mut caution: Vec<geo::Polygon<f64>> = Vec::new();
    let mut cable: Vec<geo::Polygon<f64>> = Vec::new();
    let mut tss: Vec<geo::Polygon<f64>> = Vec::new();
    let mut preferred: Vec<geo::Polygon<f64>> = Vec::new();
    let mut survey: Vec<geo::Polygon<f64>> = Vec::new();
    let mut atba: Vec<geo::Polygon<f64>> = Vec::new();
    let mut check_manually: Vec<geo::Polygon<f64>> = Vec::new();
    let mut coarsest_horizontal_m: f64 = 0.0;
    let mut finest_scale: u32 = 0;

    for p in parts {
        hard.extend(p.hard.iter().cloned());
        depth_avoid.extend(p.depth_avoid.iter().cloned());
        depth_soft.extend(p.depth_soft.iter().cloned());
        charted_depth.extend(p.charted_depth.iter().cloned());
        unsurveyed.extend(p.unsurveyed.iter().cloned());
        coverage.extend(p.coverage.iter().cloned());
        caution.extend(p.caution.iter().cloned());
        cable.extend(p.cable.iter().cloned());
        tss.extend(p.tss.iter().cloned());
        preferred.extend(p.preferred.iter().cloned());
        survey.extend(p.survey.iter().cloned());
        atba.extend(p.atba.iter().cloned());
        check_manually.extend(p.check_manually.iter().cloned());
        coarsest_horizontal_m = coarsest_horizontal_m.max(p.coarsest_horizontal_m);
        if p.finest_scale > 0 && (finest_scale == 0 || p.finest_scale < finest_scale) {
            finest_scale = p.finest_scale;
        }
    }

    ArtifactConstraints {
        hard: rings_of(hard),
        depth_avoid: rings_of(depth_avoid),
        depth_soft: rings_of(depth_soft),
        charted_depth: rings_of(charted_depth),
        unsurveyed: rings_of(unsurveyed),
        coverage: rings_of(coverage),
        caution: rings_of(caution),
        cable: rings_of(cable),
        tss: rings_of(tss),
        preferred: rings_of(preferred),
        survey: rings_of(survey),
        atba: rings_of(atba),
        check_manually: rings_of(check_manually),
        catzoc_horizontal_m: coarsest_horizontal_m,
        compilation_scale: finest_scale,
    }
}

/// Union `polys` and flatten to [`ArtifactConstraints`]' ring convention —
/// reusing `routing::hazards::finish_union` (the round-then-reunion pass
/// whose own docs record the real non-monotonic-connectivity bug it
/// exists to prevent) rather than a second, subtly different flattener.
fn rings_of(polys: Vec<geo::Polygon<f64>>) -> Vec<Vec<WorldXy>> {
    finish_union(polys).map(|idx| idx.rings).unwrap_or_default()
}

/// Every `M_COVR` `CATCOV=1` area of `cell`, minus its `CATCOV=2` areas —
/// via `coverage::cell_coverage`, the SAME function the tile-serving path
/// already resolves coverage with, so "where does this chart actually
/// chart" cannot mean two different things in two subsystems. A cell that
/// declares no positive coverage at all falls back to its own declared
/// extent rectangle, which is exactly what `read_header`'s own callers do.
fn push_cell_coverage(cell: &Cell, out: &mut Vec<geo::Polygon<f64>>) {
    if let Some(cov) = crate::coverage::cell_coverage(cell) {
        for ring in &cov.rings {
            out.push(geo::Polygon::new(geo_ring(ring), vec![]));
        }
        return;
    }
    let e = &cell.extent;
    if !e.valid {
        return;
    }
    out.push(geo::Polygon::new(
        geo_ring(&[
            WorldXy::new(e.xmin, e.ymin),
            WorldXy::new(e.xmax, e.ymin),
            WorldXy::new(e.xmax, e.ymax),
            WorldXy::new(e.xmin, e.ymax),
            WorldXy::new(e.xmin, e.ymin),
        ]),
        vec![],
    ));
}

/// Every `M_QUAL` area feature of `cell`, as raw rings plus its own
/// `CATZOC` — the lookup table [`catzoc_at`] resolves a hard feature's
/// own zone against.
fn quality_zones(cell: &Cell) -> Vec<QualityZone> {
    let mut zones = Vec::new();
    for f in cell.features_of("M_QUAL") {
        let Some(Geometry::Areas(polys)) = &f.geometry else {
            continue;
        };
        let mut rings: Vec<Vec<WorldXy>> = Vec::new();
        for poly in polys {
            if poly.outer.len() >= 3 {
                rings.push(poly.outer.clone());
            }
        }
        if rings.is_empty() {
            continue;
        }
        zones.push(QualityZone {
            rings,
            extent: f.extent,
            catzoc: f.attr("CATZOC").and_then(AttrValue::as_int),
        });
    }
    zones
}

/// The `CATZOC` of the first zone containing `p`, in cell/feature order.
/// `None` when `p` is in no zone at all — which [`super::catzoc`] treats
/// as `U`, NOT as "no allowance".
///
/// Deliberately first-match rather than worst-match: `M_QUAL` zones
/// tile a cell without overlapping in practice, feature order is stable
/// across runs (it is the decode order), and a worst-of-all-overlapping
/// rule would silently make one stray zone's grade infect its neighbours.
/// Each zone's own bbox pre-filters the ring test.
fn catzoc_at(zones: &[QualityZone], p: WorldXy) -> Option<Option<i64>> {
    for z in zones {
        if !z.extent.contains(p.x, p.y) {
            continue;
        }
        if rings_contain(&z.rings, p) {
            return Some(z.catzoc);
        }
    }
    None
}

fn feature_centre(f: &Feature) -> WorldXy {
    WorldXy::new(
        ((f.extent.xmin as i64 + f.extent.xmax as i64) / 2) as i32,
        ((f.extent.ymin as i64 + f.extent.ymax as i64) / 2) as i32,
    )
}

/// Does this `SLCONS` block? See [`NON_BLOCKING_CATSLC`]. `CATSLC` absent
/// or unrecognised ⇒ blocks.
pub(crate) fn slcons_blocks(f: &Feature) -> bool {
    match f.attr("CATSLC").and_then(AttrValue::as_int_list) {
        Some(codes) if !codes.is_empty() => !codes.iter().all(|c| NON_BLOCKING_CATSLC.contains(c)),
        // Single-valued encodings and absence alike.
        _ => match f.attr("CATSLC").and_then(AttrValue::as_int) {
            Some(c) => !NON_BLOCKING_CATSLC.contains(&c),
            None => true,
        },
    }
}

// `is_openable_bridge` is `routing::hazards::is_openable_bridge`, imported
// above — the exact CATBRG-list-attribute logic commit `28dda296` fixed
// live, shared rather than re-forked so a future S-57 quirk fix in one
// algorithm can't silently miss the other.

/// Is `f` (assumed `OBSTRN`) a foul area/ground — blocked regardless of
/// depth? `CATOBS` is catalogued single-valued, but a producer that
/// encodes it as a one-element list must not silently read as absent, so
/// both accessors are tried (the exact shape of the `CATBRG` bug).
fn is_foul_obstruction(f: &Feature) -> bool {
    let Some(v) = f.attr("CATOBS") else {
        return false;
    };
    if let Some(c) = v.as_int() {
        return FOUL_CATOBS.contains(&c);
    }
    v.as_int_list()
        .is_some_and(|codes| codes.iter().any(|c| FOUL_CATOBS.contains(c)))
}

/// Every sounding of `f` (a `SOUNDG` 3D multipoint) whose CATZOC-adjusted
/// depth fails `required_depth_m`, as its own buffered point hazard.
///
/// v3 §3.3 lists `SOUNDG` as a depth CONTRIBUTOR ("often the only depth
/// data between contours inside a channel") feeding a per-cell
/// `depth_min` — which needs the artifact's raster. Without it, the
/// honest MVP reading is the one that survives into the same ring union
/// everything else uses: a sounding shallower than the boat needs is a
/// point hazard, buffered by [`SOUNDING_HAZARD_RADIUS_M`] plus whatever
/// CATZOC/margin buffer its neighbourhood already carries. No existing
/// algorithm in this crate reads `SOUNDG` for hazard purposes at all.
fn push_shallow_soundings(
    f: &Feature,
    allow: CatzocAllowance,
    required_depth_m: f64,
    buffer_m: f64,
    out: &mut Vec<geo::Polygon<f64>>,
) {
    let Some(Geometry::MultiPoint(points)) = &f.geometry else {
        return;
    };
    let r = radius_world_units(feature_centre(f), buffer_m + SOUNDING_HAZARD_RADIUS_M)
        .max(MIN_HAZARD_RADIUS_WORLD);
    for pz in points {
        if allow.effective_depth_m(pz.z) <= required_depth_m {
            out.extend(
                geo::Point::new(pz.pos.x as f64, pz.pos.y as f64)
                    .buffer(r)
                    .0,
            );
        }
    }
}

/// [`push_shallow_soundings`] for a depth-tier BAND: soundings whose
/// CATZOC-adjusted depth is in `(lo_m, hi_m]` (`lo_m` exclusive so a
/// sounding is only ever in one tier).
fn push_soundings_between(
    f: &Feature,
    allow: CatzocAllowance,
    lo_m: f64,
    hi_m: f64,
    buffer_m: f64,
    out: &mut Vec<geo::Polygon<f64>>,
) {
    let Some(Geometry::MultiPoint(points)) = &f.geometry else {
        return;
    };
    let r = radius_world_units(feature_centre(f), buffer_m + SOUNDING_HAZARD_RADIUS_M)
        .max(MIN_HAZARD_RADIUS_WORLD);
    for pz in points {
        let eff = allow.effective_depth_m(pz.z);
        if eff > lo_m && eff <= hi_m {
            out.extend(
                geo::Point::new(pz.pos.x as f64, pz.pos.y as f64)
                    .buffer(r)
                    .0,
            );
        }
    }
}

/// Push `f`'s geometry — point, line, multipoint or area — buffered
/// outward by `buffer_m` real ground metres at its own latitude.
///
/// Copy-adapted from `routing::hazards::push_hazard_geometry` (private
/// there) rather than shared, because the buffer distance here is a
/// PER-FEATURE quantity (its own CATZOC zone's) rather than one
/// request-wide `margin_m`, and because that function has no
/// `MultiPoint` arm. Same `MIN_HAZARD_RADIUS_WORLD` floor for
/// point/line geometry, same reason: a bare point must become a real
/// polygon or it silently vanishes from the union.
fn push_geometry(f: &Feature, buffer_m: f64, out: &mut Vec<geo::Polygon<f64>>) {
    let centre = feature_centre(f);
    let r = radius_world_units(centre, buffer_m);
    match &f.geometry {
        Some(Geometry::Point(p)) => out.extend(
            geo::Point::new(p.x as f64, p.y as f64)
                .buffer(r.max(MIN_HAZARD_RADIUS_WORLD))
                .0,
        ),
        Some(Geometry::MultiPoint(points)) => {
            for pz in points {
                out.extend(
                    geo::Point::new(pz.pos.x as f64, pz.pos.y as f64)
                        .buffer(r.max(MIN_HAZARD_RADIUS_WORLD))
                        .0,
                );
            }
        }
        Some(Geometry::Lines(lines)) => {
            for line in lines {
                if line.len() < 2 {
                    continue;
                }
                out.extend(geo_ring(line).buffer(r.max(MIN_HAZARD_RADIUS_WORLD)).0);
            }
        }
        Some(Geometry::Areas(polys)) => {
            for poly in polys {
                let gp = geo_polygon(poly);
                if r > 0.0 {
                    out.extend(gp.buffer(r).0);
                } else {
                    out.push(gp);
                }
            }
        }
        None => {}
    }
}

fn geo_polygon(poly: &Polygon) -> geo::Polygon<f64> {
    geo::Polygon::new(
        geo_ring(&poly.outer),
        poly.holes.iter().map(|h| geo_ring(h)).collect(),
    )
}

/// Test-only feature builders, shared with [`super`]'s own integration
/// tests so both sides construct S-57 shapes the same way.
#[cfg(test)]
pub(super) mod fixtures {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::model::{CellMeta, PointZ};
    use std::collections::BTreeMap;

    pub(crate) fn cell_of(features: Vec<Feature>, scale: u32) -> Cell {
        let mut extent = Extent::invalid();
        for f in &features {
            extent.extend(&f.extent);
        }
        Cell {
            meta: CellMeta {
                compilation_scale: scale,
                ..CellMeta::default()
            },
            features,
            extent,
        }
    }

    /// A square ring `half_side_m` from centre to edge, NOT repeat-closed
    /// (`Polygon::outer`'s own convention here) — mirrors `hazards.rs`'s
    /// own test helper, deliberately duplicated rather than shared, the
    /// same call every other per-module test helper in this crate makes.
    pub(crate) fn square(lat: f64, lon: f64, half_side_m: f64) -> Vec<WorldXy> {
        let dlat = half_side_m / 111_320.0;
        let dlon = half_side_m / (111_320.0 * lat.to_radians().cos());
        vec![
            lat_lon_to_world(lat - dlat, lon - dlon),
            lat_lon_to_world(lat - dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon - dlon),
        ]
    }

    pub(crate) fn area(class: &str, lat: f64, lon: f64, half_side_m: f64) -> Feature {
        attributed_area(class, lat, lon, half_side_m, &[])
    }

    pub(crate) fn attributed_area(
        class: &str,
        lat: f64,
        lon: f64,
        half_side_m: f64,
        attrs: &[(&str, AttrValue)],
    ) -> Feature {
        let mut map = BTreeMap::new();
        for (k, v) in attrs {
            map.insert((*k).to_string(), v.clone());
        }
        Feature::new(
            1,
            class.into(),
            map,
            Some(Geometry::Areas(vec![Polygon {
                outer: square(lat, lon, half_side_m),
                holes: vec![],
            }])),
        )
    }

    pub(crate) fn point(class: &str, lat: f64, lon: f64, attrs: &[(&str, AttrValue)]) -> Feature {
        let mut map = BTreeMap::new();
        for (k, v) in attrs {
            map.insert((*k).to_string(), v.clone());
        }
        Feature::new(
            1,
            class.into(),
            map,
            Some(Geometry::Point(lat_lon_to_world(lat, lon))),
        )
    }

    pub(crate) fn line(class: &str, lat: f64, lon: f64, attrs: &[(&str, AttrValue)]) -> Feature {
        let mut map = BTreeMap::new();
        for (k, v) in attrs {
            map.insert((*k).to_string(), v.clone());
        }
        Feature::new(
            1,
            class.into(),
            map,
            Some(Geometry::Lines(vec![vec![
                lat_lon_to_world(lat, lon - 0.002),
                lat_lon_to_world(lat, lon + 0.002),
            ]])),
        )
    }

    pub(crate) fn soundg(lat: f64, lon: f64, depths: &[f64]) -> Feature {
        Feature::new(
            129,
            "SOUNDG".into(),
            BTreeMap::new(),
            Some(Geometry::MultiPoint(
                depths
                    .iter()
                    .enumerate()
                    .map(|(i, &z)| PointZ {
                        pos: lat_lon_to_world(lat + i as f64 * 0.0005, lon),
                        z,
                    })
                    .collect(),
            )),
        )
    }

    /// A full-cell `M_COVR` `CATCOV=1` square, so a synthetic cell makes
    /// a real coverage statement instead of falling back to its extent.
    pub(crate) fn coverage(lat: f64, lon: f64, half_side_m: f64) -> Feature {
        attributed_area(
            "M_COVR",
            lat,
            lon,
            half_side_m,
            &[("CATCOV", AttrValue::Int(1))],
        )
    }

    pub(crate) fn m_qual(lat: f64, lon: f64, half_side_m: f64, catzoc: i64) -> Feature {
        attributed_area(
            "M_QUAL",
            lat,
            lon,
            half_side_m,
            &[("CATZOC", AttrValue::Int(catzoc))],
        )
    }

    pub(crate) fn params(required_depth_m: f64) -> ConstraintParams {
        ConstraintParams {
            required_depth_m,
            avoid_depth_m: 0.0,
            soft_prefer_depth_m: 0.0,
            required_air_draft_m: 0.0,
            lateral_margin_m: 0.0,
            catzoc_mode: CatzocMode::Off,
            allow_restricted_entry: false,
            // On by default for the routing-artifact fixtures — this is
            // the fine-search path, and several tests assert on it.
            build_charted_depth: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;
    use crate::coords::lat_lon_to_world;

    const LAT: f64 = 55.0;
    const LON: f64 = 12.0;

    fn built(features: Vec<Feature>, p: ConstraintParams) -> ArtifactConstraints {
        let c = cell_of(features, 10_000);
        build(&[&c], &p)
    }

    /// The invariant `mivnav::build_region`'s per-cell constraint cache
    /// relies on: `build(cells)` == `combine(cells.map(build_one_cell))`,
    /// byte for byte, over a scenario that touches every accumulator and
    /// both scalars (a hard structure, an M_QUAL grade that buffers it,
    /// a soft TSS area, and cells of differing scale).
    #[test]
    fn build_equals_the_combine_of_its_per_cell_parts() {
        // `Full` so the CATZOC horizontal buffer is actually applied and
        // the `catzoc_horizontal_m` scalar is a real, non-zero value the
        // equality has to reproduce.
        let p = ConstraintParams {
            catzoc_mode: CatzocMode::Full,
            ..params(2.0)
        };
        let a = cell_of(
            vec![
                area("PONTON", LAT, LON, 150.0),
                attributed_area("M_QUAL", LAT, LON, 600.0, &[("CATZOC", AttrValue::Int(6))]),
            ],
            10_000,
        );
        let b = cell_of(vec![area("TSSLPT", LAT + 0.02, LON, 300.0)], 4_000);

        let monolithic = build(&[&a, &b], &p);
        let parts = [build_one_cell(&a, &p), build_one_cell(&b, &p)];
        let combined = combine(&parts);

        assert_eq!(combined.hard, monolithic.hard);
        assert_eq!(combined.tss, monolithic.tss);
        assert_eq!(combined.survey, monolithic.survey);
        assert_eq!(combined.coverage, monolithic.coverage);
        assert_eq!(combined.catzoc_horizontal_m, monolithic.catzoc_horizontal_m);
        assert_eq!(combined.compilation_scale, monolithic.compilation_scale);
        // …and the scenario really exercised both scalars.
        assert_eq!(monolithic.compilation_scale, 4_000, "the finer scale wins");
        assert!(monolithic.catzoc_horizontal_m > 0.0, "CATZOC 6 buffers");
        assert!(!monolithic.hard.is_empty() && !monolithic.tss.is_empty());
    }

    fn hard_at(c: &ArtifactConstraints, lat: f64, lon: f64) -> bool {
        rings_contain(&c.hard, lat_lon_to_world(lat, lon))
    }

    fn avoid_at(c: &ArtifactConstraints, lat: f64, lon: f64) -> bool {
        rings_contain(&c.depth_avoid, lat_lon_to_world(lat, lon))
    }

    fn soft_at(c: &ArtifactConstraints, lat: f64, lon: f64) -> bool {
        rings_contain(&c.depth_soft, lat_lon_to_world(lat, lon))
    }

    fn charted_at(c: &ArtifactConstraints, lat: f64, lon: f64) -> bool {
        rings_contain(&c.charted_depth, lat_lon_to_world(lat, lon))
    }

    /// [`params`] with the §6 soft-depth tiers switched on.
    fn tiered_params(required: f64, avoid: f64, soft: f64) -> ConstraintParams {
        ConstraintParams {
            avoid_depth_m: avoid,
            soft_prefer_depth_m: soft,
            ..params(required)
        }
    }

    // ── the construction family (§3.3's "omitted class") ──────────────

    #[test]
    fn every_construction_class_v3_lists_is_a_hard_block() {
        for class in STRUCTURE_BLOCK_CLASSES {
            let c = built(vec![area(class, LAT, LON, 200.0)], params(2.0));
            assert!(
                hard_at(&c, LAT, LON),
                "{class} must hard-block — none of the existing algorithms handle it"
            );
        }
    }

    #[test]
    fn a_construction_feature_blocks_at_any_draft() {
        // Same shape as `routing::hazards`' own "even an absurdly
        // permissive safety depth must not let it through".
        let c = built(vec![area("PONTON", LAT, LON, 200.0)], params(-100.0));
        assert!(hard_at(&c, LAT, LON));
    }

    #[test]
    fn a_lock_basin_is_navigable_water_not_a_block() {
        let c = built(vec![area("LOKBSN", LAT, LON, 200.0)], params(2.0));
        assert!(
            c.hard.is_empty(),
            "LOKBSN is explicitly NOT blocking (§3.3): {:?}",
            c.hard.len()
        );
    }

    #[test]
    fn a_gate_is_a_plain_block_in_this_mvp() {
        let c = built(vec![area("GATCON", LAT, LON, 200.0)], params(2.0));
        assert!(hard_at(&c, LAT, LON), "no transition modelling (§11) yet");
    }

    #[test]
    fn slcons_blocks_unless_catslc_says_ramp_slipway_or_landing_steps() {
        for blocking in [1i64, 2, 3, 4, 6, 7, 10, 15] {
            let c = built(
                vec![line(
                    "SLCONS",
                    LAT,
                    LON,
                    &[("CATSLC", AttrValue::StrList(vec![blocking.to_string()]))],
                )],
                params(2.0),
            );
            assert!(!c.hard.is_empty(), "CATSLC={blocking} must block");
        }
        for passable in NON_BLOCKING_CATSLC {
            let c = built(
                vec![line(
                    "SLCONS",
                    LAT,
                    LON,
                    &[("CATSLC", AttrValue::StrList(vec![passable.to_string()]))],
                )],
                params(2.0),
            );
            assert!(c.hard.is_empty(), "CATSLC={passable} must not block");
        }
        // Absent CATSLC blocks: absence is not evidence of a ramp.
        let c = built(vec![line("SLCONS", LAT, LON, &[])], params(2.0));
        assert!(!c.hard.is_empty(), "a CATSLC-less SLCONS must block");
    }

    // ── depth ─────────────────────────────────────────────────────────

    #[test]
    fn a_wide_band_is_gated_by_drval1_not_drval2() {
        // The exact bug commit fa6fbb3e fixed in the other algorithm: a
        // real 0-10m Danish band, sailed through by a 2.3m-draft route
        // when only the DEEP edge was consulted.
        let wide = attributed_area(
            "DEPARE",
            LAT,
            LON,
            200.0,
            &[
                ("drval1", AttrValue::Float(0.0)),
                ("drval2", AttrValue::Float(10.0)),
            ],
        );
        let c = built(vec![wide], params(2.3));
        assert!(hard_at(&c, LAT, LON));

        let deep = attributed_area(
            "DEPARE",
            LAT,
            LON,
            200.0,
            &[
                ("drval1", AttrValue::Float(5.0)),
                ("drval2", AttrValue::Float(30.0)),
            ],
        );
        let c = built(vec![deep], params(2.3));
        assert!(
            c.hard.is_empty(),
            "a band whose shallow edge clears is safe"
        );
    }

    #[test]
    fn a_shallow_sounding_becomes_its_own_point_hazard() {
        // No existing algorithm reads SOUNDG for hazard purposes at all.
        let c = built(vec![soundg(LAT, LON, &[1.2])], params(2.0));
        assert!(
            hard_at(&c, LAT, LON),
            "a 1.2m sounding must block a 2.0m-draft boat"
        );
        let c = built(vec![soundg(LAT, LON, &[18.0])], params(2.0));
        assert!(c.hard.is_empty(), "a deep sounding must not block");
    }

    #[test]
    fn only_the_shallow_soundings_of_a_multipoint_contribute() {
        // One SOUNDG feature carries many points; the shallow ones must
        // not drag the deep ones into the union with them.
        let c = built(vec![soundg(LAT, LON, &[20.0, 20.0, 0.5])], params(2.0));
        assert!(!c.hard.is_empty());
        assert!(
            !hard_at(&c, LAT, LON),
            "the first (deep) sounding's own position must stay clear"
        );
        assert!(
            hard_at(&c, LAT + 0.0010, LON),
            "the third (0.5m) sounding must block"
        );
    }

    // ── §6 charted-depth soft tiers ───────────────────────────────────

    fn depare(lat: f64, lon: f64, half: f64, drval1: f64) -> Feature {
        attributed_area(
            "DEPARE",
            lat,
            lon,
            half,
            &[
                ("drval1", AttrValue::Float(drval1)),
                ("drval2", AttrValue::Float(drval1 + 20.0)),
            ],
        )
    }

    #[test]
    fn a_drval2_only_depare_still_lands_in_charted_depth() {
        // The mivnav bake's `field::depth_columns` stamps a real
        // `depth_max` for a DEPARE carrying only DRVAL2 (its `(None,
        // Some(b))` arm), so the band topology can call an
        // outside-`M_COVR` cell over it navigable. `build_one_cell` must
        // add the same polygon to `charted_depth` — gated on EITHER
        // DRVAL, not DRVAL1 alone — or the fine search leaves that cell an
        // ungraced `F_UNKNOWN` block and the coarse route it accelerates
        // has no fine counterpart.
        let deep_edge_only = attributed_area(
            "DEPARE",
            LAT,
            LON,
            200.0,
            &[("drval2", AttrValue::Float(12.0))],
        );
        let c = built(vec![deep_edge_only], tiered_params(2.0, 4.0, 6.0));
        assert!(
            charted_at(&c, LAT, LON),
            "a DRVAL2-only DEPARE is still 'a chart states a depth here'"
        );
        // No DRVAL1 ⇒ no depth test ran ⇒ no tier, no hard block.
        assert!(c.hard.is_empty());
        assert!(!avoid_at(&c, LAT, LON) && !soft_at(&c, LAT, LON));
    }

    #[test]
    fn a_depare_with_no_drval_at_all_contributes_no_charted_depth() {
        // `(None, None)` — the bake's `depth_columns` `continue`s on it,
        // so `charted_depth` must skip it too: no false "a depth is
        // charted here" for a cell the band topology also leaves blocked.
        let bare = attributed_area("DEPARE", LAT, LON, 200.0, &[]);
        let c = built(vec![bare], tiered_params(2.0, 4.0, 6.0));
        assert!(!charted_at(&c, LAT, LON));
    }

    #[test]
    fn a_depare_between_required_and_avoid_lands_in_the_avoid_tier_not_hard() {
        // 3 m water, hard floor 2 m, avoid tier out to 4 m.
        let c = built(
            vec![depare(LAT, LON, 200.0, 3.0)],
            tiered_params(2.0, 4.0, 6.0),
        );
        assert!(c.hard.is_empty(), "3 m clears the 2 m hard floor");
        assert!(avoid_at(&c, LAT, LON), "and falls in the heavy avoid tier");
        assert!(
            !soft_at(&c, LAT, LON),
            "tiers are exclusive — not also in soft"
        );
    }

    #[test]
    fn a_depare_between_avoid_and_soft_prefer_lands_in_the_soft_tier() {
        let c = built(
            vec![depare(LAT, LON, 200.0, 5.0)],
            tiered_params(2.0, 4.0, 6.0),
        );
        assert!(c.hard.is_empty());
        assert!(!avoid_at(&c, LAT, LON));
        assert!(
            soft_at(&c, LAT, LON),
            "5 m is in the light 'prefer deeper' tier"
        );
    }

    #[test]
    fn deep_water_is_in_no_tier_and_the_hard_floor_still_bites() {
        let c = built(
            vec![depare(LAT, LON, 200.0, 10.0)],
            tiered_params(2.0, 4.0, 6.0),
        );
        assert!(c.hard.is_empty() && !avoid_at(&c, LAT, LON) && !soft_at(&c, LAT, LON));

        let c = built(
            vec![depare(LAT, LON, 200.0, 1.5)],
            tiered_params(2.0, 4.0, 6.0),
        );
        assert!(
            hard_at(&c, LAT, LON),
            "1.5 m is below the 2 m floor — still HARD"
        );
        assert!(
            !avoid_at(&c, LAT, LON),
            "a hard-blocked area is not also a soft tier"
        );
    }

    #[test]
    fn the_tiers_are_off_when_the_thresholds_are_zero() {
        // Every pre-existing caller passes 0.0 — the exact old behaviour.
        let c = built(vec![depare(LAT, LON, 200.0, 3.0)], params(2.0));
        assert!(c.hard.is_empty() && c.depth_avoid.is_empty() && c.depth_soft.is_empty());
    }

    #[test]
    fn shallow_soundings_bucket_into_the_right_tier() {
        let c = built(
            vec![soundg(LAT, LON, &[1.5, 3.0, 5.0, 12.0])],
            tiered_params(2.0, 4.0, 6.0),
        );
        // `soundg` lays the points at `LAT + i * 0.0005`.
        assert!(hard_at(&c, LAT, LON), "1.5 m sounding — hard");
        assert!(avoid_at(&c, LAT + 0.0005, LON), "3 m sounding — avoid tier");
        assert!(soft_at(&c, LAT + 0.0010, LON), "5 m sounding — soft tier");
        assert!(
            !hard_at(&c, LAT + 0.0015, LON)
                && !avoid_at(&c, LAT + 0.0015, LON)
                && !soft_at(&c, LAT + 0.0015, LON),
            "12 m sounding — no tier"
        );
    }

    // ── charted hazards ───────────────────────────────────────────────

    #[test]
    fn a_hazard_with_no_valsou_blocks() {
        for class in DEPTH_HAZARD_CLASSES {
            let c = built(vec![point(class, LAT, LON, &[])], params(2.0));
            assert!(
                hard_at(&c, LAT, LON),
                "{class} with no VALSOU must block — absence is not evidence of safety"
            );
        }
    }

    #[test]
    fn a_deep_hazard_with_a_real_valsou_does_not_block() {
        for class in DEPTH_HAZARD_CLASSES {
            let c = built(
                vec![point(
                    class,
                    LAT,
                    LON,
                    &[("VALSOU", AttrValue::Float(40.0))],
                )],
                params(2.0),
            );
            assert!(c.hard.is_empty(), "{class} at 40m must not block a 2m boat");
        }
    }

    #[test]
    fn a_foul_obstruction_blocks_regardless_of_depth() {
        for catobs in FOUL_CATOBS {
            for encoded in [
                AttrValue::Int(catobs),
                AttrValue::StrList(vec![catobs.to_string()]),
            ] {
                let c = built(
                    vec![point(
                        "OBSTRN",
                        LAT,
                        LON,
                        &[("VALSOU", AttrValue::Float(80.0)), ("CATOBS", encoded)],
                    )],
                    params(2.0),
                );
                assert!(
                    hard_at(&c, LAT, LON),
                    "CATOBS={catobs} foul ground blocks even at 80m"
                );
            }
        }
    }

    // ── overhead ──────────────────────────────────────────────────────

    #[test]
    fn every_overhead_class_v3_lists_is_air_draft_gated() {
        for class in AIR_DRAFT_CLASSES {
            let mut p = params(2.0);
            p.required_air_draft_m = 18.0;
            let low = built(
                vec![line(class, LAT, LON, &[("VERCLR", AttrValue::Float(10.0))])],
                p,
            );
            assert!(
                !low.hard.is_empty(),
                "{class} at 10m must block an 18m mast"
            );
            let high = built(
                vec![line(class, LAT, LON, &[("VERCLR", AttrValue::Float(40.0))])],
                p,
            );
            assert!(high.hard.is_empty(), "{class} at 40m must not");
        }
    }

    #[test]
    fn air_draft_zero_skips_the_whole_overhead_scan() {
        let c = built(
            vec![line("CBLOHD", LAT, LON, &[])], // no VERCLR: would block if consulted
            params(2.0),
        );
        assert!(c.hard.is_empty());
    }

    #[test]
    fn a_missing_verclr_blocks() {
        let mut p = params(2.0);
        p.required_air_draft_m = 18.0;
        let c = built(vec![line("PIPOHD", LAT, LON, &[])], p);
        assert!(!c.hard.is_empty());
    }

    #[test]
    fn an_openable_bridge_is_check_manually_not_a_hard_block() {
        let mut p = params(2.0);
        p.required_air_draft_m = 18.0;
        // `StrList`, exactly the shape the real Danish chart carries and
        // the shape the `as_int` bug (commit 28dda296) silently missed.
        let c = built(
            vec![point(
                "BRIDGE",
                LAT,
                LON,
                &[
                    ("VERCLR", AttrValue::Float(4.0)),
                    ("CATBRG", AttrValue::StrList(vec!["2".into()])),
                ],
            )],
            p,
        );
        assert!(c.hard.is_empty(), "an openable span must not hard-block");
        assert!(
            rings_contain(&c.check_manually, lat_lon_to_world(LAT, LON)),
            "it must be flagged for a human instead"
        );
    }

    #[test]
    fn a_fixed_bridge_still_hard_blocks_even_with_catbrg_present() {
        let mut p = params(2.0);
        p.required_air_draft_m = 18.0;
        let c = built(
            vec![point(
                "BRIDGE",
                LAT,
                LON,
                &[
                    ("VERCLR", AttrValue::Float(4.0)),
                    ("CATBRG", AttrValue::StrList(vec!["1".into()])),
                ],
            )],
            p,
        );
        assert!(!c.hard.is_empty());
        assert!(c.check_manually.is_empty());
    }

    // ── regulatory ────────────────────────────────────────────────────

    #[test]
    fn restrn_7_blocks_and_no_override_releases_it() {
        let f = || {
            attributed_area(
                "RESARE",
                LAT,
                LON,
                200.0,
                &[("RESTRN", AttrValue::IntList(vec![7]))],
            )
        };
        assert!(hard_at(&built(vec![f()], params(2.0)), LAT, LON));
        let mut p = params(2.0);
        p.allow_restricted_entry = true;
        assert!(
            hard_at(&built(vec![f()], p), LAT, LON),
            "entry PROHIBITED has no override (§3.3)"
        );
    }

    #[test]
    fn restrn_8_blocks_by_default_and_is_released_by_the_override() {
        let f = || {
            attributed_area(
                "RESARE",
                LAT,
                LON,
                200.0,
                &[("RESTRN", AttrValue::IntList(vec![8]))],
            )
        };
        assert!(
            hard_at(&built(vec![f()], params(2.0)), LAT, LON),
            "neither existing algorithm implements RESTRN=8 at all"
        );
        let mut p = params(2.0);
        p.allow_restricted_entry = true;
        let c = built(vec![f()], p);
        assert!(c.hard.is_empty());
        assert!(
            rings_contain(&c.caution, lat_lon_to_world(LAT, LON)),
            "released, but still soft-avoided rather than free"
        );
    }

    #[test]
    fn restrn_14_is_a_heavy_soft_cost_never_a_block() {
        let c = built(
            vec![attributed_area(
                "RESARE",
                LAT,
                LON,
                200.0,
                &[("RESTRN", AttrValue::IntList(vec![14]))],
            )],
            params(2.0),
        );
        assert!(c.hard.is_empty(), "ATBA must never hard-block");
        assert!(rings_contain(&c.atba, lat_lon_to_world(LAT, LON)));
    }

    #[test]
    fn a_prohibited_atba_is_still_prohibited() {
        // RESTRN carrying both 7 and 14: the hard code wins.
        let c = built(
            vec![attributed_area(
                "RESARE",
                LAT,
                LON,
                200.0,
                &[("RESTRN", AttrValue::IntList(vec![14, 7]))],
            )],
            params(2.0),
        );
        assert!(hard_at(&c, LAT, LON));
        assert!(c.atba.is_empty());
    }

    #[test]
    fn a_restrn_less_resare_is_soft_avoided_not_blocked() {
        let c = built(vec![area("RESARE", LAT, LON, 200.0)], params(2.0));
        assert!(c.hard.is_empty());
        assert!(rings_contain(&c.caution, lat_lon_to_world(LAT, LON)));
    }

    #[test]
    fn marine_farms_and_fish_stakes_block_under_the_same_one_override() {
        for class in RESTRICTED_ENTRY_CLASSES {
            let c = built(vec![area(class, LAT, LON, 200.0)], params(2.0));
            assert!(hard_at(&c, LAT, LON), "{class} blocks by default");
            let mut p = params(2.0);
            p.allow_restricted_entry = true;
            let c = built(vec![area(class, LAT, LON, 200.0)], p);
            assert!(c.hard.is_empty(), "{class} released by the override");
        }
    }

    // ── unknown water ─────────────────────────────────────────────────

    #[test]
    fn unsare_no_longer_blocks_it_is_governed_by_charted_depth() {
        // User decision — "i do not know what this low certainty is, just
        // avoid all under 2 m". A bare UNSARE area (no depth stated) is
        // NOT a constraint any more: not `hard`, and no longer in
        // `unsurveyed` (→ `search`'s `F_UNKNOWN` block). It still feeds
        // the optional `survey` weight and the `check_manually` flag.
        let c = built(vec![area("UNSARE", LAT, LON, 200.0)], params(2.0));
        assert!(c.hard.is_empty(), "UNSARE is not a hard block");
        assert!(
            c.unsurveyed.is_empty(),
            "UNSARE no longer reaches the F_UNKNOWN block — depth governs it now"
        );
        assert!(rings_contain(&c.check_manually, lat_lon_to_world(LAT, LON)));
        assert!(rings_contain(&c.survey, lat_lon_to_world(LAT, LON)));
    }

    #[test]
    fn a_cells_coverage_statement_is_read_from_m_covr() {
        let c = built(
            vec![coverage(LAT, LON, 500.0), area("LNDARE", LAT, LON, 50.0)],
            params(2.0),
        );
        assert!(rings_contain(&c.coverage, lat_lon_to_world(LAT, LON)));
        assert!(
            !rings_contain(&c.coverage, lat_lon_to_world(LAT + 0.05, LON)),
            "well outside the M_COVR square is not covered"
        );
    }

    #[test]
    fn a_cell_with_no_m_covr_falls_back_to_its_own_extent() {
        let c = built(vec![area("LNDARE", LAT, LON, 200.0)], params(2.0));
        assert!(!c.coverage.is_empty());
        assert!(rings_contain(&c.coverage, lat_lon_to_world(LAT, LON)));
    }

    // ── CATZOC as real geometry ───────────────────────────────────────

    #[test]
    fn the_catzoc_horizontal_figure_really_grows_the_hard_geometry() {
        let make = |mode: CatzocMode| {
            let mut p = params(2.0);
            p.catzoc_mode = mode;
            built(
                vec![
                    m_qual(LAT, LON, 3_000.0, 3), // CATZOC B => 50m
                    area("LNDARE", LAT, LON, 100.0),
                ],
                p,
            )
        };
        let off = make(CatzocMode::Off);
        let half = make(CatzocMode::Half);
        let full = make(CatzocMode::Full);
        let width = |c: &ArtifactConstraints| {
            let mut e = Extent::invalid();
            for ring in &c.hard {
                for p in ring {
                    e.extend_point(*p);
                }
            }
            (e.xmax - e.xmin) as i64
        };
        assert!(
            width(&off) < width(&half) && width(&half) < width(&full),
            "off={} half={} full={}",
            width(&off),
            width(&half),
            width(&full)
        );
        // 100m half-side + 50m buffer: a point 130m out is now unsafe.
        assert!(!hard_at(&off, LAT, LON + 0.00204));
        assert!(hard_at(&full, LAT, LON + 0.00204));
    }

    #[test]
    fn depth_only_keeps_the_geometry_but_still_shallows_the_depth_test() {
        let mut p = params(2.0);
        p.catzoc_mode = CatzocMode::DepthOnly;
        // CATZOC C: 2.00m + 5%. A charted 4.0m band reads as
        // 4.0 - (2.0 + 0.2) = 1.8m, which fails a 2.0m requirement.
        let c = built(
            vec![
                m_qual(LAT, LON, 3_000.0, 4),
                attributed_area(
                    "DEPARE",
                    LAT,
                    LON,
                    200.0,
                    &[("drval1", AttrValue::Float(4.0))],
                ),
            ],
            p,
        );
        assert!(hard_at(&c, LAT, LON));
        // Off: the same band passes.
        let c = built(
            vec![
                m_qual(LAT, LON, 3_000.0, 4),
                attributed_area(
                    "DEPARE",
                    LAT,
                    LON,
                    200.0,
                    &[("drval1", AttrValue::Float(4.0))],
                ),
            ],
            params(2.0),
        );
        assert!(c.hard.is_empty());
    }

    #[test]
    fn a_features_own_zone_decides_its_buffer_not_the_cells_worst_zone() {
        let mut p = params(2.0);
        p.catzoc_mode = CatzocMode::Full;
        // Two zones side by side: A1 (5m) around the wreck, C (500m)
        // well away from it. The wreck must get A1's tiny buffer.
        let c = built(
            vec![
                m_qual(LAT, LON, 400.0, 1),
                m_qual(LAT, LON + 0.05, 400.0, 4),
                point("UWTROC", LAT, LON, &[("VALSOU", AttrValue::Float(0.5))]),
            ],
            p,
        );
        assert!(hard_at(&c, LAT, LON));
        assert!(
            !hard_at(&c, LAT, LON + 0.0016), // ~100m east
            "an A1-zone wreck must not carry C's 500m buffer"
        );
        // The reported ladder input is still the COARSEST zone present.
        assert_eq!(c.catzoc_horizontal_m, 500.0);
    }

    #[test]
    fn no_m_qual_anywhere_reports_the_d_u_horizontal_figure() {
        let mut p = params(2.0);
        p.catzoc_mode = CatzocMode::Full;
        let c = built(vec![area("LNDARE", LAT, LON, 100.0)], p);
        assert_eq!(c.catzoc_horizontal_m, 1000.0);
    }

    /// The bug this guards against: a corridor with ONE small declared
    /// M_QUAL zone (A1, 5m) plus a hard hazard sitting OUTSIDE that zone
    /// (so it gets the much larger unzoned D/U fallback, 1000m at
    /// `Full`) must report the LARGER figure — not just the coarsest
    /// grade among the zones that happen to exist. Reporting only 5m
    /// here would size the resolution ladder for a 5m buffer while a
    /// real hazard is actually buffered by 1000m: exactly the
    /// "incoherent" case this module's own docs warn about, and it used
    /// to happen for any corridor with partial M_QUAL coverage — the
    /// normal case, not an edge case.
    #[test]
    fn an_unzoned_hazard_outside_a_small_zone_still_widens_the_reported_figure() {
        let mut p = params(2.0);
        p.catzoc_mode = CatzocMode::Full;
        let c = built(
            vec![
                // A tiny A1 zone (5m) nowhere near the hazard below.
                m_qual(LAT, LON, 50.0, 1),
                // A wreck far outside that zone: falls back to unzoned
                // U (1000m at Full), which is coarser than the zone's
                // own 5m grade.
                point(
                    "UWTROC",
                    LAT,
                    LON + 0.5,
                    &[("VALSOU", AttrValue::Float(0.5))],
                ),
            ],
            p,
        );
        assert_eq!(
            c.catzoc_horizontal_m, 1000.0,
            "the unzoned hazard's own 1000m buffer must not be hidden behind the zone's 5m"
        );
    }

    #[test]
    fn the_finest_compilation_scale_over_every_cell_is_reported() {
        let coarse = cell_of(vec![area("LNDARE", LAT, LON, 100.0)], 90_000);
        let fine = cell_of(vec![area("LNDARE", LAT, LON, 100.0)], 12_000);
        let c = build(&[&coarse, &fine], &params(2.0));
        assert_eq!(c.compilation_scale, 12_000);
    }

    // ── soft tiers keep the existing modules' class split ──────────────

    #[test]
    fn the_soft_families_land_in_their_existing_config_weights_buckets() {
        let c = built(
            vec![
                area("ACHARE", LAT, LON, 200.0),
                line("CBLSUB", LAT, LON, &[]),
                area("TSSLPT", LAT, LON, 200.0),
                area("FAIRWY", LAT, LON, 200.0),
                m_qual(LAT, LON, 200.0, 5),
            ],
            params(2.0),
        );
        let p = lat_lon_to_world(LAT, LON);
        assert!(rings_contain(&c.caution, p));
        assert!(rings_contain(&c.cable, p));
        assert!(rings_contain(&c.tss, p));
        assert!(rings_contain(&c.preferred, p));
        assert!(rings_contain(&c.survey, p));
        assert!(c.hard.is_empty(), "none of them is a hard block");
    }
}
