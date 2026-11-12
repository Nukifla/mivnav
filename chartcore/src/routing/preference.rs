// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Soft routing-cost preference zones — charted areas a route is
//! LEGAL to cross but should be biased away from (Traffic Separation
//! Scheme lanes; an anchorage/caution/permitted-restricted area; a
//! submarine cable or pipeline) or toward (a marked fairway, a
//! recommended track, a navigation line, or a deep-water route part). Not
//! hazards:
//! `routing::hazards` stays deliberately narrow to hard, safety-relevant
//! danger — its own module docs already reject widening that list to
//! include a fairway ("a fairway wrongly treated as entry-prohibited
//! would refuse a route through a marked channel") — so this is a
//! separate module on purpose, not a widened `hazards.rs` class list.
//! `routing::raster`'s `CostModel`/`combined_multiplier` is what actually
//! turns the ring unions built here into a cost, not this module.
//!
//! Unbuffered when charted as an area (`margin_m = 0.0` at every call into
//! `hazards::push_areas`): a TSS lane or a preferred-route feature has no
//! clearance margin of its own the way a charted hazard does — the
//! charted boundary itself is what matters. A preferred-route feature
//! charted as a LINE (`NAVLNE`/`RECTRC`) is a partial exception to
//! "unbuffered" — see [`build_preferred_route_union`] and
//! `hazards::push_preferred_route_geometry`'s own docs for why it still
//! needs a small, fixed, non-tunable width to exist as a preference zone
//! at all.
//!
//! # Why the four "prefer" classes share ONE union and ONE weight
//!
//! `FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT` are folded into a single
//! [`build_preferred_route_union`] feeding a single
//! `RoutingConfig.fairway_preference_weight` (documented there as
//! covering all four — the field itself is not renamed, to avoid rippling
//! a purely cosmetic change through the pyo3/backend/frontend wire
//! surface for no functional benefit), rather than each class — or even
//! each of RECTRC/NAVLNE/DWRTPT as one group distinct from FAIRWY —
//! getting its own independently-tunable weight. This mirrors
//! [`TSS_AVOID_CLASSES`]'s own precedent exactly: `TSSLPT`/`TSSRON`/
//! `TSSCRS`/`PRCARE` already share one `tss_avoidance_weight` despite
//! being charted as distinct classes, because nobody tuning this router
//! has a real, evidenced basis to say a roundabout should be avoided more
//! or less strongly than a lane part. The same is true here: a
//! recommended track (`RECTRC`) is charted with more editorial intent
//! than a fairway (an authority actively recommends this exact line,
//! rather than merely designating a channel as fairway), which COULD
//! argue for a stronger pull — but that argument has no real-world
//! tuning basis yet either (no user request, no observed case where
//! FAIRWY-strength pull was wrong for a recommended track), so inventing
//! three more dials nobody can meaningfully set is worse than reusing the
//! one that exists. If a real need to distinguish them ever shows up,
//! `RoutingConfig` gaining `rectrc_preference_weight` etc. is a small,
//! additive change from here — not a reason to speculatively build it now.
//!
//! Geometrically, the four classes are unioned into the SAME ring set
//! (one [`HazardIndex`], via `hazards::finish_union`'s real
//! `geo::unary_union` boolean-OR, not a bare concatenation) rather than
//! kept as separate per-class unions the way `TSS_AVOID_CLASSES` and
//! `PREFERRED_ROUTE_CLASSES` are kept separate FROM EACH OTHER. This
//! matters for "double-preferenced" water — e.g. a recommended track
//! running through a fairway: `raster::CostModel` has exactly ONE
//! `fairway: Option<(&Grid, weight)>` field, a flat zone-MEMBERSHIP
//! discount (inside the union or not, never "how many source classes
//! overlap here"), so a real geometric union at THIS layer is what makes
//! overlapping water cost exactly one discount rather than two
//! multiplied together (`(1 - w) * (1 - w)`, which would also silently
//! lower `combined_multiplier`'s true minimum below the `1 -
//! fairway_preference_weight` floor `raster::octile_heuristic`'s
//! admissibility proof relies on — see that function's own docs). Kept
//! separate from `TSS_AVOID_CLASSES`, unlike RECTRC/NAVLNE/DWRTPT are
//! from FAIRWY, because avoid and prefer are opposite-signed terms in
//! `combined_multiplier` — unioning an avoid zone into a prefer zone
//! would be a category error, not a strength question.

use crate::model::Cell;
use crate::routing::hazards::{
    entry_prohibited, finish_union, push_areas, push_preferred_route_geometry,
    push_soft_avoid_geometry, HazardIndex, ENTRY_RESTRICTABLE_CLASSES,
};

/// The traffic-separation-scheme "prefer to avoid" family: lane parts,
/// roundabouts, crossings, and the precautionary areas where lanes
/// converge. Deliberately NOT `ISTZNE` (inshore traffic zone): COLREG
/// Rule 10(d) makes it the PREFERRED alternative for a vessel that can
/// safely use it (small craft, sail) rather than the main lanes, so it
/// is not part of what this avoids — see `crate::derive::mod`'s own
/// "traffic routes" module doc for the same class family grouped for
/// symbolization instead.
const TSS_AVOID_CLASSES: [&str; 4] = ["TSSLPT", "TSSRON", "TSSCRS", "PRCARE"];

/// The "prefer if it connects" family — see this module's own "Why the
/// four 'prefer' classes share ONE union and ONE weight" docs above for
/// the reasoning. Per `s57objectclasses.csv` (chartcore's own vendored
/// catalogue, checked directly): `FAIRWY` and `DWRTPT` ("Deep water route
/// part" — NOT "point", despite the acronym's read; confirmed against the
/// real catalogue rather than assumed) are Area-only, `NAVLNE` is
/// Line-only, `RECTRC` permits either — see
/// `hazards::push_preferred_route_geometry` for how each geometry
/// primitive becomes a preference-zone polygon.
const PREFERRED_ROUTE_CLASSES: [&str; 4] = ["FAIRWY", "RECTRC", "NAVLNE", "DWRTPT"];

/// The "don't linger over/anchor near this" family — a submarine cable or
/// pipeline. Per `s57objectclasses.csv` (checked directly): `CBLSUB` is
/// Line-only, `PIPSOL` is Point;Line — NEITHER ever permits Area geometry,
/// unlike every other class in this module, so this family is ALWAYS
/// nominally buffered (see [`push_soft_avoid_geometry`]), never charted as
/// a real area of its own.
///
/// # Why cable/pipeline gets its OWN weight, separate from "caution" below
///
/// This module's own long-standing precedent ([`TSS_AVOID_CLASSES`],
/// [`PREFERRED_ROUTE_CLASSES`]) is to fold several classes into ONE shared
/// weight whenever nobody has a real, evidenced basis to tune them
/// differently — and that reasoning still applies WITHIN each of the two
/// groups below (no basis to weight `CBLSUB` differently from `PIPSOL`, or
/// `ACHARE` differently from `CTNARE`). But BETWEEN the two groups, the
/// underlying concern is a genuinely different KIND of caution, not just a
/// different charted class:
///
/// * A submarine cable/pipeline is not a transit hazard the way a charted
///   `WRECKS`/`OBSTRN` point is — briefly crossing one, as almost any route
///   roughly perpendicular to the coast must, costs nothing extra worth
///   discouraging (a flat zone-membership cost is proportional to distance
///   ACTUALLY spent inside the zone, so a perpendicular crossing is already
///   cheap regardless of weight). What genuinely matters is not RUNNING
///   ALONG one for any real distance — the real-world risk is dragging an
///   anchor or towed gear across a cable/pipeline route, not the instant of
///   crossing it.
/// * `ACHARE` (anchorage — other traffic may be anchored there, unmarked)
///   and `CTNARE` (caution area — charted specifically because a producer
///   judged "navigate here with more awareness than usual" worth flagging,
///   with no more specific reason encoded) are both a general "be more
///   aware here" signal, not an anchoring-specific one; permitted-transit
///   `RESARE`/`MIPARE` (this module's own `build_caution_union`, below)
///   folds in for the identical reason: legally sensitive, but the router
///   has no way to know WHY (military practice, environmental protection,
///   an unspecified restriction) any more precisely than "be careful",
///   exactly `CTNARE`'s own shape of information.
///
/// So the split here is not "more classes deserve more dials" — it is that
/// these two groups represent different REASONS to raise cost (protect
/// ground tackle/seabed infrastructure vs. general navigational/legal
/// awareness), and collapsing them into one shared weight would force a
/// user who cares about one to accept the other at an identical strength
/// with no way to differ, the same over-collapsing risk the fairway
/// module docs above warn against tuning AWAY from without a real reason.
/// Kept to exactly two weights, not one per class, for the same "no
/// evidenced basis to go further" restraint the existing groups already
/// apply.
const CABLE_AVOID_CLASSES: [&str; 2] = ["CBLSUB", "PIPSOL"];

/// The "navigate here with more general caution" family: `ACHARE`
/// (anchorage — unmarked anchored traffic may be present) and `CTNARE`
/// (caution area, charted with no more specific reason encoded) always
/// join this union; `RESARE`/`MIPARE` join it ONLY when
/// [`entry_prohibited`] is false (i.e. NOT the case `hazards::
/// build_hazard_index`'s own hard-block loop already claims) — see
/// [`build_caution_union`]'s own docs for the composition rule between the
/// two, and [`CABLE_AVOID_CLASSES`]'s own docs for why this family is a
/// separate weight from cable/pipeline rather than one shared dial.
const CAUTION_AVOID_CLASSES: [&str; 2] = ["ACHARE", "CTNARE"];

/// The S-57 `CATZOC` (Category of Zone of Confidence) coded values that
/// count as "low confidence" for this router — see
/// [`build_low_confidence_survey_union`]'s own docs for the full reasoning
/// behind the cut. Per the real domain table (`s57expectedinput.csv`,
/// checked directly, not assumed): `1`=A1, `2`=A2, `3`=B, `4`=C, `5`=D,
/// `6`=U (unassessed). This threshold is `>= 4` — C, D, and U.
pub(crate) const CATZOC_LOW_CONFIDENCE_MIN: i64 = 4;

/// The union of every `M_QUAL` zone in `cell` whose `CATZOC` reads as
/// "low confidence" — see [`CATZOC_LOW_CONFIDENCE_MIN`]. `None` when
/// `cell` charts no `M_QUAL` at all, or only zones at/above grade B.
///
/// # Why a threshold, not a 6-level graded penalty
///
/// The official IHO definitions (S-57 Appendix A, the zone-of-confidence
/// diagram) show a real step change at the B/C boundary, not a smooth
/// gradient: A1/A2/B all carry IHO S-44 Order-1-class position accuracy
/// (5m or 20m) and at least a partial systematic search; C's own defining
/// text is "large depth anomalies MAY BE EXPECTED" and 500m position
/// accuracy — an order of magnitude worse than B, and a real statement
/// that an uncharted hazard is plausible, not just "somewhat less
/// precise". D is worse still, and U ("not assessed") is definitionally
/// unknown — treated at least as cautiously as the worst assessed grade,
/// not as a neutral absence (same "absence is not evidence of the safe
/// case" instinct `hazards::entry_prohibited`'s own docs already apply to
/// a `RESTRN`-less `RESARE`).
///
/// A flat threshold, not a 6-level graded cost curve, for the same reason
/// `tss_avoidance_weight`/`cable_avoidance_weight`/etc. are each a single
/// dial rather than a per-class one: nobody tuning this router has real
/// usage data to say a CATZOC-D zone should cost e.g. twice a CATZOC-C
/// one — inventing that curve now would be precision this router cannot
/// back up, not real safety value (`ROUTING_TODO.md`'s own "tune the
/// preferences' weights once there's real usage" entry already flags this
/// whole family as untuned). The B/C step is also where mariner guidance
/// conventionally draws the line for "exercise increased caution" — this
/// is a defensible cut, not an arbitrary one.
///
/// # Why this applies everywhere charted, not only "close-quarters" water
///
/// This router has no geometric definition of "close quarters" anywhere
/// today (no channel-width/corridor-narrowness concept exists in
/// `hazards.rs`/`raster.rs`) — inventing one for this feature alone would
/// be new, untested complexity to match a framing, not a real requirement.
/// A flat zone-membership AVOID term (same shape as `tss`/`cable`/
/// `caution`) already produces the right practical behaviour without it:
/// it only changes a route's shape when a better-surveyed alternative
/// actually exists nearby to prefer, and never blocks or meaningfully
/// distorts a route where no such alternative exists (open water, or a
/// region charted ONLY from a low-confidence survey) — the same
/// "discourage, don't forbid" posture as every other soft preference.
///
/// # `UNSARE` joins the same union, not a separate one
///
/// `UNSARE` (unsurveyed area) used to be a HARD, unconditional block in
/// `routing::hazards` — downgraded to a soft-avoid term here instead.
/// Found live: a real UNSARE patch off the Danish coast (near Skagen)
/// with no genuinely better-surveyed water nearby made the router refuse
/// an otherwise fine route outright, with no way to say "cross it anyway,
/// just flag it". `UNSARE` carries no `CATZOC` of its own — it is not a
/// graded assessment at all, it is the ABSENCE of one: no surveyor ever
/// sounded this water. That is not a different kind of concern from a
/// CATZOC-C/D/U `M_QUAL` zone, it is the most extreme case of the exact
/// SAME one this union already exists to express (worse even than `U`
/// "not assessed" — U at least means a survey was attempted), so it joins
/// unconditionally here rather than getting its own weight/dial — the
/// same "no evidenced basis to split further" restraint the rest of this
/// module's own class groupings already apply. See
/// [`build_unsurveyed_union`] for the SEPARATE, UNSARE-only union this
/// module also exposes — not for cost (that's this function), but for a
/// caller that wants to know, after the fact, whether an already-decided
/// route's own exact line crosses unsurveyed water at all, to flag it for
/// a manual check.
pub fn build_low_confidence_survey_union(cell: &Cell) -> Option<HazardIndex> {
    let mut polys = Vec::new();
    for f in &cell.features {
        match f.acronym.as_str() {
            "M_QUAL" => {
                let catzoc = f.attr("CATZOC").and_then(crate::model::AttrValue::as_int);
                // No CATZOC at all on a real M_QUAL feature: treated as
                // low confidence (see the module docs above) rather than
                // silently skipped — an M_QUAL zone with no assessed
                // quality recorded is not evidence the survey was good.
                let low_confidence = catzoc.is_none_or(|v| v >= CATZOC_LOW_CONFIDENCE_MIN);
                if low_confidence {
                    push_areas(f, 0.0, &mut polys);
                }
            }
            "UNSARE" => push_areas(f, 0.0, &mut polys),
            _ => {}
        }
    }
    finish_union(polys)
}

/// The union of every `UNSARE` (unsurveyed area) polygon in `cell` —
/// ALONE, not folded into [`build_low_confidence_survey_union`]'s own
/// wider union that function also joins for COST purposes. `None` when
/// `cell` charts no `UNSARE` at all.
///
/// Not consumed by `routing::raster`'s `CostModel` — this is not another
/// avoidance weight. It exists purely so a caller can run an already-
/// decided route's own exact legs against it (the same generic
/// `verify_route_legs`/`chartcore.verify_route` machinery
/// `mivnav.features.routing.routes`' `/verify` endpoint already uses for
/// the hard hazard union) to answer one narrow, purely informational
/// question: does this route cross unsurveyed water at all? A `true`
/// there is one of the two things that can set `PlanResponse.
/// check_manually_legs`/`VerifyResponse.check_manually_legs` — the other
/// being `hazards::build_openable_bridge_union`, an unrelated reason a
/// leg needs a human's own judgement — "check this stretch manually",
/// never a reason to alter or refuse the route itself. Kept separate from
/// the low-confidence-survey union rather than reusing its ring set for
/// this too: a CATZOC-D `M_QUAL` zone is still a real (if imprecise)
/// survey, genuinely different from water nobody ever sounded at all, and
/// conflating the two here would flag "check manually" on ordinary
/// lower-confidence charted water the mariner has no special reason to
/// re-verify by hand.
pub fn build_unsurveyed_union(cell: &Cell) -> Option<HazardIndex> {
    build_class_union(cell, &["UNSARE"])
}

/// The union of every TSS-family area feature in `cell` — see
/// [`TSS_AVOID_CLASSES`]. `None` when `cell` charts none of them.
pub fn build_tss_union(cell: &Cell) -> Option<HazardIndex> {
    build_class_union(cell, &TSS_AVOID_CLASSES)
}

/// The union of every cable/pipeline soft-avoid feature (`CBLSUB`,
/// `PIPSOL`) in `cell` — see [`CABLE_AVOID_CLASSES`]'s own docs for why
/// this is a separate weight/union from [`build_caution_union`]. Always
/// nominally buffered (`push_soft_avoid_geometry`): neither class ever
/// charts Area geometry. `None` when `cell` charts neither class.
pub fn build_cable_union(cell: &Cell) -> Option<HazardIndex> {
    let mut polys = Vec::new();
    for f in &cell.features {
        if CABLE_AVOID_CLASSES.contains(&f.acronym.as_str()) {
            push_soft_avoid_geometry(f, &mut polys);
        }
    }
    finish_union(polys)
}

/// The union of every "navigate with caution" soft-avoid feature in
/// `cell` — [`CAUTION_AVOID_CLASSES`] (`ACHARE`/`CTNARE`, always) plus any
/// `RESARE`/`MIPARE` NOT already claimed by `hazards::build_hazard_index`'s
/// own hard entry-prohibited block.
///
/// # Composing correctly with the hard block — never both, never neither
///
/// [`entry_prohibited`] is the SAME function (not a re-derived duplicate)
/// `build_hazard_index` calls to decide its own hard-block inclusion, so
/// the two are complementary by construction: a `RESARE`/`MIPARE` feature
/// is hard-blocked exactly when `entry_prohibited(f)`, and lands here
/// exactly when `!entry_prohibited(f)` — every such feature goes to
/// EXACTLY ONE of the two unions, never both (redundant, and would
/// double-penalize an already-excluded route) and never neither (the bug
/// this whole soft-avoid tier exists to close: before this function
/// existed, a permitted-transit `RESARE`/`MIPARE` — or one with no
/// `RESTRN` at all — was silently invisible to the router). See
/// [`entry_prohibited`]'s own docs for why a `RESTRN`-absent feature
/// resolves to soft-avoid specifically, not a third, differently-handled
/// case.
///
/// One shared union/weight with `ACHARE`/`CTNARE`, not a third dial of its
/// own — see [`CABLE_AVOID_CLASSES`]'s own docs for the reasoning: a
/// permitted-but-restricted area and a plain caution area are the same
/// shape of information to this router (something here warrants more
/// care; no more specific reason is encoded), so nothing here has a real
/// evidenced basis to weight one more strongly than the other.
pub fn build_caution_union(cell: &Cell) -> Option<HazardIndex> {
    let mut polys = Vec::new();
    for f in &cell.features {
        let acronym = f.acronym.as_str();
        if CAUTION_AVOID_CLASSES.contains(&acronym) {
            push_soft_avoid_geometry(f, &mut polys);
        } else if ENTRY_RESTRICTABLE_CLASSES.contains(&acronym) && !entry_prohibited(f) {
            push_soft_avoid_geometry(f, &mut polys);
        }
    }
    finish_union(polys)
}

/// The union of every preferred-route-family feature in `cell` — see
/// [`PREFERRED_ROUTE_CLASSES`] and this module's own "Why the four
/// 'prefer' classes share ONE union and ONE weight" docs. `None` when
/// `cell` charts none.
pub fn build_preferred_route_union(cell: &Cell) -> Option<HazardIndex> {
    let mut polys = Vec::new();
    for f in &cell.features {
        if PREFERRED_ROUTE_CLASSES.contains(&f.acronym.as_str()) {
            push_preferred_route_geometry(f, &mut polys);
        }
    }
    finish_union(polys)
}

fn build_class_union(cell: &Cell, classes: &[&str]) -> Option<HazardIndex> {
    let mut polys = Vec::new();
    for f in &cell.features {
        if classes.contains(&f.acronym.as_str()) {
            push_areas(f, 0.0, &mut polys);
        }
    }
    finish_union(polys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::model::{CellMeta, Feature, Geometry, Polygon};
    use std::collections::BTreeMap;

    const LAT: f64 = 55.0;
    const LON: f64 = 12.0;

    fn cell(features: Vec<Feature>) -> Cell {
        let mut extent = crate::coords::Extent::invalid();
        for f in &features {
            extent.extend(&f.extent);
        }
        Cell {
            meta: CellMeta::default(),
            features,
            extent,
        }
    }

    /// A square ring `half_side_m` metres from centre to edge, centred on
    /// `(lat, lon)` — same helper shape as `hazards.rs`'s own tests.
    fn square(lat: f64, lon: f64, half_side_m: f64) -> Vec<crate::coords::WorldXy> {
        let dlat = half_side_m / 111_320.0;
        let dlon = half_side_m / (111_320.0 * lat.to_radians().cos());
        vec![
            lat_lon_to_world(lat - dlat, lon - dlon),
            lat_lon_to_world(lat - dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon - dlon),
            lat_lon_to_world(lat - dlat, lon - dlon),
        ]
    }

    fn area_feature(class: &str, lat: f64, lon: f64, half_side_m: f64) -> Feature {
        let mut ring = square(lat, lon, half_side_m);
        ring.pop(); // `Polygon.outer` is not repeat-closed, unlike the `square` test helper's own ring
        Feature::new(
            1,
            class.into(),
            BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: ring,
                holes: vec![],
            }])),
        )
    }

    /// A short straight line, `half_len_m` either side of `(lat, lon)`
    /// along the parallel — enough vertices for a real `geo` linestring.
    fn line_feature(class: &str, lat: f64, lon: f64, half_len_m: f64) -> Feature {
        let dlon = half_len_m / (111_320.0 * lat.to_radians().cos());
        let line = vec![
            lat_lon_to_world(lat, lon - dlon),
            lat_lon_to_world(lat, lon + dlon),
        ];
        Feature::new(
            1,
            class.into(),
            BTreeMap::new(),
            Some(Geometry::Lines(vec![line])),
        )
    }

    #[test]
    fn preferred_route_union_includes_all_four_classes() {
        for class in ["FAIRWY", "RECTRC", "NAVLNE", "DWRTPT"] {
            let f = if class == "NAVLNE" {
                line_feature(class, LAT, LON, 2_000.0)
            } else {
                area_feature(class, LAT, LON, 200.0)
            };
            let c = cell(vec![f]);
            assert!(
                build_preferred_route_union(&c).is_some(),
                "{class} must join the preferred-route union"
            );
        }
    }

    #[test]
    fn preferred_route_union_ignores_unrelated_classes() {
        let c = cell(vec![area_feature("LNDARE", LAT, LON, 200.0)]);
        assert!(build_preferred_route_union(&c).is_none());
    }

    #[test]
    fn dwrtpt_area_geometry_is_unbuffered_like_fairwy() {
        // The class name reads as "deep water route point", but per the
        // real S-57 catalogue it is "Deep water route part", Area
        // geometry only — same shape as FAIRWY, no line-buffer path
        // involved. An unbuffered area feature's own union extent must
        // match a plain FAIRWY area of the identical size exactly (both
        // go through the SAME unbuffered `Areas` arm of
        // `push_preferred_route_geometry`) — proof this class needs no
        // point/line buffering at all, unlike the task's own initial
        // premise.
        let half_side_m = 200.0;
        let dwrtpt = cell(vec![area_feature("DWRTPT", LAT, LON, half_side_m)]);
        let fairwy = cell(vec![area_feature("FAIRWY", LAT, LON, half_side_m)]);
        let dwrtpt_idx = build_preferred_route_union(&dwrtpt).expect("a charted DWRTPT area");
        let fairwy_idx = build_preferred_route_union(&fairwy).expect("a charted FAIRWY area");
        assert_eq!(
            dwrtpt_idx.extent, fairwy_idx.extent,
            "an Area-geometry DWRTPT must union identically to the same-size FAIRWY, unbuffered"
        );
    }

    #[test]
    fn navlne_line_geometry_gets_a_real_non_degenerate_buffer() {
        // Without a line buffer, a zero-width NAVLNE would vanish from
        // the union entirely (or produce a degenerate polygon
        // `finish_union` drops) — see `hazards::LINE_PREFERENCE_HALF_
        // WIDTH_M`'s own docs for why that would silently defeat the
        // whole point of charting NAVLNE as a preference at all.
        let c = cell(vec![line_feature("NAVLNE", LAT, LON, 3_000.0)]);
        let idx = build_preferred_route_union(&c).expect("a charted NAVLNE line");
        assert!(idx.extent.valid);
        let width_world = idx.extent.ymax - idx.extent.ymin;
        assert!(
            width_world > 0,
            "a line-geometry preference zone must have real width, not a degenerate sliver: {idx:?}"
        );
    }

    #[test]
    fn rectrc_as_a_line_also_gets_buffered() {
        // RECTRC permits either Line or Area geometry (S-57) — the line
        // arm must be reachable for RECTRC too, not hardcoded to NAVLNE.
        let c = cell(vec![line_feature("RECTRC", LAT, LON, 3_000.0)]);
        let idx = build_preferred_route_union(&c).expect("a line-charted RECTRC");
        assert!(idx.extent.ymax - idx.extent.ymin > 0);
    }

    #[test]
    fn overlapping_fairwy_and_rectrc_union_into_one_clean_region() {
        // A recommended track running straight through a fairway — the
        // real-world case this module's own docs reason about. The two
        // source rings overlap; `finish_union` must produce ONE clean
        // union (no self-intersection / duplicate-ring artifact a naive
        // concatenation could leave behind), proving the "one discount,
        // not two stacked" design at the geometry layer, not just by
        // `CostModel` having a single field.
        let fairway = area_feature("FAIRWY", LAT, LON, 1_000.0);
        let rectrc = area_feature("RECTRC", LAT, LON, 600.0); // fully inside the fairway
        let c = cell(vec![fairway, rectrc]);
        let idx = build_preferred_route_union(&c).expect("a real union");
        // A RECTRC fully enclosed by FAIRWY must not introduce a second,
        // disjoint ring or a hole — the union's extent is exactly the
        // (larger) fairway's own, and it stays a single simple region:
        // `rings_contain` at the fairway's own centre must read `true`.
        assert!(crate::routing::hazards::rings_contain(
            &idx.rings,
            lat_lon_to_world(LAT, LON)
        ));
    }

    // ── Cable/pipeline and caution soft-avoid unions ────────────────────

    use crate::model::AttrValue;

    fn point_feature(class: &str, lat: f64, lon: f64) -> Feature {
        Feature::new(
            1,
            class.into(),
            BTreeMap::new(),
            Some(Geometry::Point(lat_lon_to_world(lat, lon))),
        )
    }

    fn resare_with_restrn(class: &str, lat: f64, lon: f64, restrn: Option<Vec<i64>>) -> Feature {
        let mut attrs = BTreeMap::new();
        if let Some(vals) = restrn {
            attrs.insert("RESTRN".to_string(), AttrValue::IntList(vals));
        }
        Feature::new(
            1,
            class.into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: {
                    let mut ring = square(lat, lon, 200.0);
                    ring.pop();
                    ring
                },
                holes: vec![],
            }])),
        )
    }

    #[test]
    fn cable_union_includes_cblsub_and_pipsol() {
        // CBLSUB is Line-only, PIPSOL is Point;Line (checked directly
        // against s57objectclasses.csv) — exercise both geometry shapes.
        let cblsub = cell(vec![line_feature("CBLSUB", LAT, LON, 2_000.0)]);
        let pipsol_line = cell(vec![line_feature("PIPSOL", LAT, LON, 2_000.0)]);
        let pipsol_point = cell(vec![point_feature("PIPSOL", LAT, LON)]);
        assert!(
            build_cable_union(&cblsub).is_some(),
            "a charted CBLSUB line"
        );
        assert!(
            build_cable_union(&pipsol_line).is_some(),
            "a charted PIPSOL line"
        );
        assert!(
            build_cable_union(&pipsol_point).is_some(),
            "a charted PIPSOL point"
        );
    }

    #[test]
    fn cable_union_ignores_unrelated_classes() {
        let c = cell(vec![area_feature("ACHARE", LAT, LON, 200.0)]);
        assert!(build_cable_union(&c).is_none());
    }

    #[test]
    fn cable_point_and_line_geometry_get_a_real_non_degenerate_buffer() {
        // Neither CBLSUB nor PIPSOL ever charts Area geometry — without a
        // nominal buffer, both would vanish from the union entirely (or
        // produce a degenerate `finish_union` drops), the same failure
        // mode `navlne_line_geometry_gets_a_real_non_degenerate_buffer`
        // above pins for the preferred-route family.
        let line = cell(vec![line_feature("CBLSUB", LAT, LON, 3_000.0)]);
        let point = cell(vec![point_feature("PIPSOL", LAT, LON)]);
        for idx in [
            build_cable_union(&line).expect("a charted CBLSUB line"),
            build_cable_union(&point).expect("a charted PIPSOL point"),
        ] {
            assert!(idx.extent.valid);
            let width_world = idx.extent.ymax - idx.extent.ymin;
            assert!(
                width_world > 0,
                "a cable/pipeline soft-avoid zone must have real width: {idx:?}"
            );
        }
    }

    #[test]
    fn caution_union_includes_achare_and_ctnare() {
        for class in ["ACHARE", "CTNARE"] {
            let c = cell(vec![area_feature(class, LAT, LON, 200.0)]);
            assert!(
                build_caution_union(&c).is_some(),
                "{class} must join the caution union"
            );
        }
    }

    #[test]
    fn caution_union_ignores_unrelated_classes() {
        let c = cell(vec![area_feature("LNDARE", LAT, LON, 200.0)]);
        assert!(build_caution_union(&c).is_none());
    }

    #[test]
    fn caution_union_includes_resare_when_restrn_does_not_prohibit_entry() {
        // RESTRN present, but only e.g. "fishing prohibited" (3) — legal
        // to transit, so this is exactly the case that used to be
        // silently invisible before this soft-avoid tier existed.
        let c = cell(vec![resare_with_restrn("RESARE", LAT, LON, Some(vec![3]))]);
        assert!(build_caution_union(&c).is_some());
    }

    #[test]
    fn caution_union_excludes_resare_when_restrn_prohibits_entry() {
        // RESTRN contains 7 — `hazards::build_hazard_index` already hard-
        // blocks this; the soft-avoid tier must NOT also claim it (see
        // `build_caution_union`'s own "never both" docs).
        let c = cell(vec![resare_with_restrn("RESARE", LAT, LON, Some(vec![7]))]);
        assert!(build_caution_union(&c).is_none());
    }

    #[test]
    fn caution_union_includes_mipare_with_no_restrn_attribute_at_all() {
        // No RESTRN attribute whatsoever — `entry_prohibited` reads this
        // as `false` (see its own docs on why absence is not "entry
        // prohibited" evidence), so this lands in the soft-avoid tier
        // rather than being silently dropped OR wrongly hard-blocked.
        let c = cell(vec![resare_with_restrn("MIPARE", LAT, LON, None)]);
        assert!(build_caution_union(&c).is_some());
    }

    #[test]
    fn resare_hard_block_and_soft_avoid_are_mutually_exclusive_across_every_restrn_case() {
        // The real integration proof: for a representative spread of
        // RESTRN values (including absent), a RESARE/MIPARE feature is
        // claimed by EXACTLY ONE of `hazards::build_hazard_index` (hard
        // block) and `build_caution_union` (soft avoid) — never both,
        // never neither. This is what actually guarantees the "never
        // double-penalize, never silently invisible" property, not just
        // each function's own docs asserting it.
        for restrn in [
            None,
            Some(vec![3]),
            Some(vec![7]),
            Some(vec![3, 7]),
            Some(vec![1, 2]),
        ] {
            for class in ["RESARE", "MIPARE"] {
                let c = cell(vec![resare_with_restrn(class, LAT, LON, restrn.clone())]);
                let hard = crate::routing::hazards::build_hazard_index(&c, 2.0, 0.0, 0.0).is_some();
                let soft = build_caution_union(&c).is_some();
                assert_ne!(
                    hard, soft,
                    "{class} with RESTRN={restrn:?} must be claimed by exactly one tier (hard={hard}, soft={soft})"
                );
            }
        }
    }

    #[test]
    fn overlapping_achare_and_ctnare_union_into_one_clean_region() {
        // Same "one discount/penalty, not two stacked" proof as
        // `overlapping_fairwy_and_rectrc_union_into_one_clean_region`
        // above, for the AVOID side: overlapping caution-family water must
        // still union into one clean region, not two independently
        // counted rings.
        let achare = area_feature("ACHARE", LAT, LON, 1_000.0);
        let ctnare = area_feature("CTNARE", LAT, LON, 600.0); // fully inside
        let c = cell(vec![achare, ctnare]);
        let idx = build_caution_union(&c).expect("a real union");
        assert!(crate::routing::hazards::rings_contain(
            &idx.rings,
            lat_lon_to_world(LAT, LON)
        ));
    }

    // ── Low-confidence-survey (M_QUAL/CATZOC) union ─────────────────────

    fn mqual_feature(lat: f64, lon: f64, half_side_m: f64, catzoc: Option<i64>) -> Feature {
        let mut attrs = BTreeMap::new();
        if let Some(v) = catzoc {
            attrs.insert("CATZOC".to_string(), AttrValue::Int(v));
        }
        Feature::new(
            308, // M_QUAL's own S-57 object class code
            "M_QUAL".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: {
                    let mut ring = square(lat, lon, half_side_m);
                    ring.pop();
                    ring
                },
                holes: vec![],
            }])),
        )
    }

    #[test]
    fn low_confidence_survey_union_includes_catzoc_c_d_and_u() {
        // 4=C, 5=D, 6=U (the real S-57 CATZOC domain, checked directly
        // against s57expectedinput.csv) — every one of these must join
        // the union.
        for catzoc in [4, 5, 6] {
            let c = cell(vec![mqual_feature(LAT, LON, 200.0, Some(catzoc))]);
            assert!(
                build_low_confidence_survey_union(&c).is_some(),
                "CATZOC={catzoc} must count as low confidence"
            );
        }
    }

    #[test]
    fn low_confidence_survey_union_excludes_catzoc_a1_a2_and_b() {
        // 1=A1, 2=A2, 3=B — modern-enough survey standard, must NOT join.
        for catzoc in [1, 2, 3] {
            let c = cell(vec![mqual_feature(LAT, LON, 200.0, Some(catzoc))]);
            assert!(
                build_low_confidence_survey_union(&c).is_none(),
                "CATZOC={catzoc} must NOT count as low confidence"
            );
        }
    }

    #[test]
    fn low_confidence_survey_union_treats_a_missing_catzoc_as_low_confidence() {
        // A real M_QUAL feature with no CATZOC attribute at all is not
        // evidence of a good survey — same "absence is not the safe case"
        // reasoning `hazards::entry_prohibited` already applies to a
        // RESTRN-less RESARE.
        let c = cell(vec![mqual_feature(LAT, LON, 200.0, None)]);
        assert!(
            build_low_confidence_survey_union(&c).is_some(),
            "a CATZOC-less M_QUAL must be treated as low confidence, not silently skipped"
        );
    }

    #[test]
    fn low_confidence_survey_union_ignores_unrelated_classes() {
        let c = cell(vec![area_feature("LNDARE", LAT, LON, 200.0)]);
        assert!(build_low_confidence_survey_union(&c).is_none());
    }

    #[test]
    fn low_confidence_survey_union_ignores_unrelated_attributes_on_other_classes() {
        // A CATZOC-shaped attribute on some OTHER class must never be
        // mistaken for an M_QUAL zone — this function only ever reads the
        // M_QUAL class itself.
        let mut attrs = BTreeMap::new();
        attrs.insert("CATZOC".to_string(), AttrValue::Int(6));
        let f = Feature::new(
            1,
            "DEPARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: {
                    let mut ring = square(LAT, LON, 200.0);
                    ring.pop();
                    ring
                },
                holes: vec![],
            }])),
        );
        let c = cell(vec![f]);
        assert!(build_low_confidence_survey_union(&c).is_none());
    }

    #[test]
    fn overlapping_catzoc_c_and_d_union_into_one_clean_region() {
        // Same "one penalty, not two stacked" proof as the ACHARE/CTNARE
        // case above: two overlapping low-confidence M_QUAL zones (a real,
        // legal shape — S-57 doesn't forbid adjacent/overlapping M_QUAL
        // declarations) must union into one clean region.
        let c_zone = mqual_feature(LAT, LON, 1_000.0, Some(4));
        let d_zone = mqual_feature(LAT, LON, 600.0, Some(5)); // fully inside
        let c = cell(vec![c_zone, d_zone]);
        let idx = build_low_confidence_survey_union(&c).expect("a real union");
        assert!(crate::routing::hazards::rings_contain(
            &idx.rings,
            lat_lon_to_world(LAT, LON)
        ));
    }

    // ── Unsurveyed area (UNSARE) ─────────────────────────────────────────

    #[test]
    fn low_confidence_survey_union_includes_a_bare_unsare_with_no_catzoc_at_all() {
        // UNSARE joins `build_low_confidence_survey_union` directly, not
        // via any CATZOC threshold — see that function's own "UNSARE
        // joins the same union" docs. No CATZOC attribute at all here
        // (UNSARE never carries one) — must still join.
        let c = cell(vec![area_feature("UNSARE", LAT, LON, 200.0)]);
        assert!(build_low_confidence_survey_union(&c).is_some());
    }

    #[test]
    fn unsurveyed_union_includes_unsare_alone() {
        let c = cell(vec![area_feature("UNSARE", LAT, LON, 200.0)]);
        assert!(build_unsurveyed_union(&c).is_some());
    }

    #[test]
    fn unsurveyed_union_ignores_unrelated_classes() {
        // Including a CATZOC-D M_QUAL zone — proves this union is
        // genuinely UNSARE-only, not an alias for the wider low-
        // confidence-survey union it also joins.
        let c = cell(vec![mqual_feature(LAT, LON, 200.0, Some(5))]);
        assert!(build_unsurveyed_union(&c).is_none());
    }

    #[test]
    fn unsurveyed_union_and_low_confidence_survey_union_agree_on_a_real_unsare_zone() {
        // The same charted UNSARE polygon must produce the identical
        // ring set through both functions — one geometry, read by two
        // callers for two different purposes (cost vs. crossing-flag),
        // never two independently-computed shapes that could silently
        // drift apart.
        let c = cell(vec![area_feature("UNSARE", LAT, LON, 200.0)]);
        let via_survey = build_low_confidence_survey_union(&c).expect("a real union");
        let via_unsurveyed = build_unsurveyed_union(&c).expect("a real union");
        assert_eq!(via_survey.rings, via_unsurveyed.rings);
    }
}
