// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! The unsafe-water polygon: everything a boat of a given draft, at a
//! given safety margin, must not sail into.
//!
//! [`build_hazard_index`] unions, per cell:
//!
//! * `LNDARE` — land, always;
//! * `SLCONS` — shoreline construction (breakwater, mole, pier, jetty,
//!   quay, wharf…) — always, same unconditional footing as `LNDARE`, not
//!   depth-gated the way `WRECKS`/`OBSTRN`/`UWTROC` below are: a real
//!   charted structure is impassable regardless of a boat's draft. Point,
//!   line, or area, S-57 allows all three (most breakwaters/piers are
//!   charted as a LINE, not a closed polygon, which is why this reuses
//!   [`push_hazard_geometry`], not the area-only [`push_areas`] `LNDARE`
//!   uses). Found live: a real breakwater at a real Danish harbour
//!   (Strandby) was routed straight through, because nothing in this
//!   module ever looked at the class at all — `mvt::mask`'s
//!   `OUTLINED_AREA_LAYERS` already knew `SLCONS` needed stroking for TILE
//!   rendering, but that is an entirely separate pipeline the routing
//!   hazard union never shared a class list with;
//! * `DEPARE`/`DRGARE` area geometry whose `drval1` (post-`derive::apply`,
//!   see `crate::derive`) is at or below the caller's safety depth — the
//!   SHALLOW boundary of the charted band, not the deep one: a band only
//!   states that its bottom lies somewhere between `drval1` and `drval2`,
//!   so a boat needing `safety_depth_m` of water is not safe anywhere in
//!   the band unless even its shallow edge clears that depth. Found live:
//!   real Danish west-coast cells chart wide bands (0-4m, 0-10m) that a
//!   `drval2`-based check let a shoal-draft route sail straight through,
//!   because the band's deep edge alone (4m/10m) is well past any
//!   sensible `safety_depth_m` even though its shallow edge is the
//!   coastline itself;
//! * `WRECKS`/`OBSTRN`/`UWTROC` whose `depth_value` (same derive pass) is
//!   at or below the safety depth — point, line, or area, S-57 allows all
//!   three for this group;
//! * `RESARE`/`MIPARE` whose `RESTRN` attribute contains `7` (entry
//!   prohibited);
//! * `BRIDGE`/`CBLOHD` — a vertical obstruction — when `air_draft_m` is
//!   configured (nonzero) and the boat cannot clear it. See "Air draft"
//!   below.
//!
//! Everything included gets buffered outward by `margin_m` before the
//! union — real clearance, not the charted boundary itself, because a
//! router should keep a margin away from the edge of legal water, not
//! graze it. `margin_m` also gives point/line hazards their entire shape
//! (a wreck is one lon/lat pair with no area of its own); those always get
//! at least a nominal buffer so they exist in the union at all, even with
//! `margin_m == 0`.
//!
//! **Deliberately narrow for a first cut** (see `ROUTING_TODO.md` at the
//! repo root): no `SOUNDG` (point depth samples are informative, not a
//! charted hazard, and the depth-area union already captures the general
//! pattern), and only `RESARE`/`MIPARE` for entry-prohibited — not the
//! whole `derive::restricted` group (`CTNARE`/`FAIRWY`/`TSSLPT`/…), whose
//! `RESTRN`/`CATREA` nuance belongs in the traffic-lane/buoyage rules pass
//! this feeds into, not in the hard-hazard polygon. Widen this list
//! deliberately, not by broadening the class filter blindly — a fairway
//! wrongly treated as entry-prohibited would refuse a route through a
//! marked channel.
//!
//! # The soft-avoid tier (`routing::preference`)
//!
//! `RESARE`/`MIPARE` are HARD-blocked here only when [`entry_prohibited`]
//! (`RESTRN` contains `7`) — every other case (a different restriction
//! level, or no `RESTRN` at all) is legal to cross, not a hazard this
//! module concerns itself with. `routing::preference::build_caution_union`
//! is where that legal-but-discouraged remainder actually gets a cost, via
//! the SAME [`entry_prohibited`] predicate and [`ENTRY_RESTRICTABLE_CLASSES`]
//! list (reused, not duplicated), so a feature can never be counted both
//! places at once — see that function's own docs and [`entry_prohibited`]'s
//! for the full reasoning, including why `RESTRN`-absent is soft-avoided
//! rather than either hard-blocked or silently ignored. The same module
//! also covers `ACHARE`/`CTNARE` (always soft-avoid) and `CBLSUB`/`PIPSOL`
//! (a submarine cable/pipeline: never a transit hazard the way a charted
//! wreck is, but worth discouraging lingering over/anchoring near).
//!
//! `UNSARE` (unsurveyed area) is NOT in this module at all — it used to be
//! a HARD, unconditional block here (the same footing as `LNDARE`/
//! `SLCONS` above), on the reasoning that an area a surveyor never sounded
//! has no charted depth to compare against `safety_depth_m`, so treating
//! its absence as "passes the depth test" would be backwards. Found live:
//! a real UNSARE patch off the Danish coast (57°03.2′N 009°57.0′E, near
//! Skagen) with no genuinely better-surveyed alternative nearby made the
//! router refuse an otherwise fine route outright, with no way to say "I
//! understand the risk, route through it anyway and just tell me". Downgraded
//! to `routing::preference::build_low_confidence_survey_union`'s own
//! soft-avoid weight instead — the SAME union `M_QUAL`/`CATZOC`-C/D/U
//! water already joins, since "never surveyed at all" is just the most
//! extreme case of exactly the low-confidence-survey concern that union
//! already exists to express (see that function's own docs). A route is
//! now free to cross unsurveyed water when nothing better exists nearby,
//! biased away from it otherwise — never blocked outright.
//!
//! # Air draft
//!
//! A `BRIDGE` (point, line, or area — the S-57 class allows all three) or
//! `CBLOHD` (line) feature is a HARD hazard, exactly like a depth-gated
//! `DEPARE`/`WRECKS`: legal water that becomes genuinely impassable given a
//! caller-supplied vessel parameter, not a soft routing preference — see
//! `routing::preference`'s own module docs for why a *legal-to-cross* zone
//! (a fairway, a TSS lane) belongs in that separate module instead, and why
//! this one does not. **Except** a `BRIDGE` whose `CATBRG` says it can
//! OPEN ([`is_openable_bridge`]): the charted CLOSED clearance is not the
//! whole story for one of these, so it is deliberately excluded from this
//! hard union — [`build_openable_bridge_union`] is the separate, purely
//! informational "check manually" flag it joins instead (the same framing
//! `routing::preference::build_unsurveyed_union` already established: not
//! every legally-real obstacle is one this router can fully resolve on
//! its own, and refusing a route outright over one it CAN'T resolve is
//! its own kind of wrong). Gated by `air_draft_m` (the boat's mast height above
//! the waterline, metres): `0.0` (the field's own default — see
//! `mivnav::features::routing::config::RoutingConfig::air_draft_m`) means
//! OFF, the whole `AIR_DRAFT_CLASSES` scan is skipped, and the union is
//! byte-identical to a build from before this feature existed — a real
//! correctness requirement (every pre-existing regression fixture's hazard
//! output must not change), not just a performance nicety.
//!
//! **No universal safe default exists**, unlike `safety_depth_m` (every
//! boat displaces some water, so a depth check is always meaningful even
//! at a conservative placeholder). A boat's mast height is not something
//! this project can infer (SignalK carries no common air-draft path the
//! way it can report draft), and picking an arbitrary nonzero "on by
//! default" height would either under-protect a taller boat (a false
//! sense of safety — worse than no check, since a wrong PASS reads as "the
//! router verified this") or block routes for a boat with no meaningful
//! air-draft constraint at all, the first time this code runs, before its
//! own real mast height is ever entered anywhere. `0.0`/unconfigured is
//! also a legitimate END STATE here, not merely "not set up yet" the way
//! it would be for draft: plenty of real boats have no bridge-clearance
//! concern worth checking. Contrast `mivnav`'s own `routeiq_air_draft_m`
//! (`RoutingConfig`), which DOES ship a nonzero default (18m) — that field
//! has no off-switch available to it at all: it is a value sent verbatim
//! to a remote API that requires one, where `0` would mean "a boat with no
//! mast" and falsely block on almost any bridge with a real clearance
//! figure. This module controls its own hazard union end to end, so it can
//! (and does) express "skip this check" directly instead of smuggling it
//! through a physically-meaningless vessel dimension.
//!
//! **A `BRIDGE`/`CBLOHD` feature with no `VERCLR` attribute at all is
//! treated as blocking** — the same "absence is not evidence of safety"
//! instinct `UNSARE`'s own original reasoning above already applies, but
//! for an independently-reasoned cause here: `VERCLR` is mandatory, under
//! the S-57 encoding
//! rules, for any non-opening `BRIDGE` over navigable water (IHO S-57
//! Appendix A/DCEG; confirmed against the published attribute-encoding
//! guidance, not assumed) — unlike a hydrographic depth sounding, which is
//! routinely and legitimately absent over large charted areas that simply
//! were never surveyed to that precision, a charted bridge or overhead
//! cable is a single, individually-surveyed man-made structure whose
//! entire reason for being charted at all is to warn about the vertical
//! obstruction. Its base rate of "genuinely missing clearance data" is far
//! lower than a depth area's, so the failure this decision guards against
//! (a real, low structure with undigitized clearance, sailed under as if
//! clear) is a plausible one and a dangerous one, while the cost of the
//! opposite mistake — an occasional needless detour around a navigable
//! structure whose ample clearance was never encoded — is a nuisance, not
//! a hazard. This is deliberately UNLIKE `DEPARE`/`WRECKS`'s own missing-
//! value handling (`drval1`/`depth_value` absent ⇒ that feature is simply
//! not included, see the depth-gated loops below) — that class of feature
//! legitimately lacks a value across huge swathes of every chart for
//! reasons that say nothing about danger, so treating its absence as
//! "unsafe" would make the union wildly, uselessly conservative; a bridge
//! is not that kind of feature.
//!
//! **Deliberately scoped to `VERCLR` only, not `VERCCL`/`VERCOP`** (an
//! *opening* bridge's closed/open clearance): whether an opening bridge is
//! currently open is live, dynamic state this offline chart router has no
//! way to query, so encoding a static pass/fail against either figure
//! would claim a certainty the router does not have. An opening bridge
//! with no plain `VERCLR` therefore falls to the "no `VERCLR`" rule above
//! and is blocked — the right conservative outcome (a human, not an
//! unattended router, should be the one deciding to time a passage through
//! an opening bridge), not a gap. Also deliberately scoped to `BRIDGE`/
//! `CBLOHD` only, not the wider IHO "Cables and Pipelines" group
//! `derive::cables` shares code with (`CBLSUB`, `PIPSOL`, `PIPOHD`): a
//! submarine cable/pipe is never a vertical-clearance concern, and
//! `PIPOHD` (overhead pipeline, otherwise identical in shape to `CBLOHD`)
//! was left for a follow-up rather than included on faith — see
//! `AIR_DRAFT_CLASSES`'s own doc comment and `ROUTING_TODO.md`.
//!
//! # Authority-clipping exemption for land
//!
//! [`build_land_only_hazard_index`] exposes [`build_hazard_index`]'s two
//! unconditional classes (`LNDARE`/`SLCONS`) alone, for a caller
//! (`hazard_indexes_for_bbox`, `mivnav.features.routing.hazards`) that
//! unions it in WITHOUT ever passing it through [`clip_to_authority`] — see
//! that function's own docs for the real bug this closes: a coarser
//! chart's correct coastline silently erased along a thin strip wherever a
//! finer chart's coverage overlaps ground that finer chart itself never
//! re-digitized as land. `clip_to_authority` stays exactly as it was for
//! every other class (depth areas, wrecks, obstructions, entry-restricted
//! areas, air-draft obstructions) — genuine scale-driven navigability
//! disagreements it was built to resolve.
//!
//! # Buffering across latitude
//!
//! World coordinates are WebMercator pixels (`crate::coords`), which
//! stretch ground distance by `secant(latitude)` in projected space — one
//! world unit covers more real metres at the equator than at 60°N. A
//! uniform buffer distance in world units would therefore under-buffer
//! near the poles and over-buffer near the equator relative to the same
//! *real* clearance. [`radius_world_units`] corrects for this per feature,
//! using that feature's own extent centre — accurate enough for a
//! clearance measured in tens to low hundreds of metres; a feature
//! spanning enough latitude for the correction to drift within its own
//! extent is not a case a coastal router needs to worry about.
//!
//! # Where the geometry comes from
//!
//! Same pure-Rust boolean engine as `crate::mvt::mask` — `geo`'s
//! `BooleanOps`/`Buffer`, backed by `i_overlay` — but working directly in
//! whole-cell world coordinates rather than mask.rs's tile-local
//! projected space: there is no tile to clip to here, the hazard index is
//! built once per cell and consumed by a search that spans many tiles.

use crate::coords::{world_from_sm, worldy_to_lat, Extent, WorldXy};
use crate::coverage::signed_area2_world;
use crate::model::{AttrValue, Cell, Feature, Geometry};
use geo::{BooleanOps, Buffer};

const DEPTH_AREA_CLASSES: [&str; 2] = ["DEPARE", "DRGARE"];
const HAZARD_CLASSES: [&str; 3] = ["WRECKS", "OBSTRN", "UWTROC"];
/// Shoreline construction — see the module docs' `SLCONS` bullet for why
/// this is unconditional (like `LNDARE`), not depth-gated (like
/// `HAZARD_CLASSES` above), and for the real routed-through-a-breakwater
/// bug this exists to close.
const STRUCTURAL_HAZARD_CLASSES: [&str; 1] = ["SLCONS"];
/// See the module docs on why this list stays short. `pub(crate)`, not
/// private: `routing::preference::build_caution_union` reuses this SAME
/// list (not a re-typed copy) to scan for the soft-avoid half of these two
/// classes — see [`entry_prohibited`]'s own docs for why sharing both the
/// list and the predicate is what keeps the hard-block/soft-avoid split
/// mutually exclusive by construction rather than by two independently
/// maintained class lists happening to agree today.
pub(crate) const ENTRY_RESTRICTABLE_CLASSES: [&str; 2] = ["RESARE", "MIPARE"];
/// Vertical-clearance obstructions: a bridge (point/line/area — S-57
/// allows all three) and an overhead cable (line only). See the module
/// docs' "Air draft" section for the gating rule and the no-`VERCLR`
/// decision. Deliberately NOT `CBLSUB`/`PIPSOL`/`PIPOHD` (`derive::cables`'
/// sibling classes in the same IHO group): a submarine cable is never an
/// air-draft concern, and an overhead PIPE (`PIPOHD`) was left out of this
/// first cut alongside `CBLOHD` only by omission risk — no real fixture
/// charts one to verify attribute survival against, unlike `CBLOHD`
/// (confirmed live in `derive::cables`) — see `ROUTING_TODO.md`.
const AIR_DRAFT_CLASSES: [&str; 2] = ["BRIDGE", "CBLOHD"];
/// S-57 `CATBRG` (Category of bridge) values that mean the bridge itself
/// can move to give clearance — see [`is_openable_bridge`]'s own docs for
/// why this matters and [`build_openable_bridge_union`] for what it
/// feeds. Per the real domain table (`s57expectedinput.csv`, checked
/// directly): `1`=fixed, `2`=opening, `3`=swing, `4`=lifting, `5`=bascule,
/// `6`=pontoon, `7`=draw, `8`=transporter, `9`=footbridge, `10`=viaduct,
/// `11`=aqueduct, `12`=suspension. This list is the mechanically-movable
/// half — `9`-`12` are all fixed structures despite not being literally
/// `1`, so this is an explicit allow-list, not `!= 1`.
pub(crate) const OPENABLE_BRIDGE_CATBRG: [i64; 7] = [2, 3, 4, 5, 6, 7, 8];
/// S-57 `RESTRN` enumeration value for "entry prohibited".
const RESTRN_ENTRY_PROHIBITED: i64 = 7;
/// Point/line hazards get at least this many world units of buffer even
/// when `margin_m` is 0, so they exist in the union as an area at all
/// (see the module docs).
const MIN_HAZARD_RADIUS_WORLD: f64 = 1.0;

/// The unsafe-water polygon for one cell, at one safety depth and margin
/// (see the module docs). `rings` follows [`crate::coverage::Coverage`]'s
/// convention: closed rings in world coordinates, a ring whose signed area
/// (y-down) is positive *adds* unsafe area and a negative ring is a hole
/// (safe water enclosed within a hazard union) — orientation is normalized
/// here, so nothing about the source geometry's own winding survives into
/// it.
#[derive(Debug, Clone, PartialEq)]
pub struct HazardIndex {
    pub rings: Vec<Vec<WorldXy>>,
    pub extent: Extent,
}

/// Build the unsafe-water polygon for `cell`. `None` when nothing in the
/// cell is unsafe at this depth/margin/air-draft — an empty union, not an
/// error.
///
/// `air_draft_m` is the boat's own mast height above the waterline, in
/// metres — `0.0` means OFF (see the module docs' "Air draft" section):
/// no `BRIDGE`/`CBLOHD` feature is ever consulted, byte-identical to
/// this function before air-draft checking existed. When positive, a
/// `BRIDGE`/`CBLOHD` feature blocks (joins the union) whenever
/// `air_draft_m >= VERCLR` — equal counts as unsafe, the same
/// boundary-favours-caution convention `safety_depth_m` already uses for
/// `DEPARE`/`DRGARE` (`drval1 <= safety_depth_m`) — or whenever `VERCLR`
/// is absent entirely (unknown clearance is treated as blocking, not
/// passable; see the module docs for why this differs from the
/// depth-gated classes' own "absent value = not a hazard" rule).
pub fn build_hazard_index(
    cell: &Cell,
    safety_depth_m: f64,
    margin_m: f64,
    air_draft_m: f64,
) -> Option<HazardIndex> {
    let mut polys: Vec<geo::Polygon<f64>> = Vec::new();

    push_unconditional_land(cell, margin_m, &mut polys);

    for f in &cell.features {
        if !DEPTH_AREA_CLASSES.contains(&f.acronym.as_str()) {
            continue;
        }
        // The SHALLOW edge of the band, not the deep one — a `DEPARE`
        // only promises its bottom lies somewhere between drval1 and
        // drval2, so a wide band (0-4m, 0-10m: real on the Danish west
        // coast) is unsafe the instant its shallow edge is, regardless of
        // how deep its far edge gets. See the module docs' `DEPARE` bullet.
        let drval1 = f.attr("drval1").and_then(AttrValue::as_float);
        if drval1.is_some_and(|d| d <= safety_depth_m) {
            push_areas(f, margin_m, &mut polys);
        }
    }

    for f in &cell.features {
        if !HAZARD_CLASSES.contains(&f.acronym.as_str()) {
            continue;
        }
        let depth = f.attr("depth_value").and_then(AttrValue::as_float);
        if depth.is_some_and(|d| d <= safety_depth_m) {
            push_hazard_geometry(f, margin_m, &mut polys);
        }
    }

    for f in &cell.features {
        if !ENTRY_RESTRICTABLE_CLASSES.contains(&f.acronym.as_str()) {
            continue;
        }
        if entry_prohibited(f) {
            push_areas(f, margin_m, &mut polys);
        }
    }

    // Air-draft gate: skip the class scan entirely when off, so an
    // unconfigured caller pays nothing extra and — the correctness
    // requirement this exists for — gets a byte-identical union to
    // before this feature existed. See the module docs.
    if air_draft_m > 0.0 {
        for f in &cell.features {
            if !AIR_DRAFT_CLASSES.contains(&f.acronym.as_str()) {
                continue;
            }
            let verclr = f.attr("VERCLR").and_then(AttrValue::as_float);
            let blocked = match verclr {
                Some(clr) => air_draft_m >= clr,
                None => true,
            };
            // An openable BRIDGE this boat can't clear CLOSED is not a
            // hard block — see `is_openable_bridge`'s own docs and
            // `build_openable_bridge_union`, the soft "check manually"
            // tier it joins instead. `CBLOHD` never reaches this branch
            // (it isn't `BRIDGE`), so an overhead cable stays exactly as
            // hard-blocked as before this existed.
            if blocked && !(f.acronym == "BRIDGE" && is_openable_bridge(f)) {
                push_hazard_geometry(f, margin_m, &mut polys);
            }
        }
    }

    finish_union(polys)
}

/// Push [`build_hazard_index`]'s two UNCONDITIONAL classes — `LNDARE`,
/// `SLCONS` — onto `out`. No `safety_depth_m`/`air_draft_m` gate applies
/// to either (see the module docs' own bullets), so this needs no such
/// parameter either; shared between `build_hazard_index` (folded into the
/// same union as every conditional class) and
/// [`build_land_only_hazard_index`] (this subset alone). `UNSARE` is
/// deliberately NOT here — see the module docs' own note on why it moved
/// to `routing::preference`'s soft-avoid tier instead.
fn push_unconditional_land(cell: &Cell, margin_m: f64, out: &mut Vec<geo::Polygon<f64>>) {
    for f in cell.features_of("LNDARE") {
        push_areas(f, margin_m, out);
    }
    for f in &cell.features {
        if !STRUCTURAL_HAZARD_CLASSES.contains(&f.acronym.as_str()) {
            continue;
        }
        push_hazard_geometry(f, margin_m, out);
    }
}

/// [`build_hazard_index`]'s two unconditional classes ALONE — `LNDARE`,
/// `SLCONS` — with no depth/margin/air-draft-gated hazard mixed in. For
/// `hazard_indexes_for_bbox` (`mivnav.features.routing.hazards`)
/// to union in UNCONDITIONALLY, bypassing `clip_to_authority` entirely —
/// found live, against a real commercial chart set: a coarser cell's
/// correctly-charted coastline was silently erased along a thin strip
/// exactly where a FINER cell's own declared coverage overlapped it
/// without that finer cell itself re-charting the same stretch as land —
/// a real digitization gap in the finer chart, not a scale disagreement
/// `clip_to_authority` was ever meant to resolve. That mechanism exists
/// to let an ACCURATE finer chart's "this is open water" claim override a
/// crude coarser chart's wrong land shape (the original Grenen bug, see
/// `clip_to_authority`'s own docs) — a legitimate call for classes where
/// "which chart is right about navigability here" is a real question
/// (depth areas, wrecks, obstructions: finer surveys genuinely do
/// supersede coarser ones). Land is not that kind of feature: dry ground
/// does not become submerged at a larger scale, so a finer chart's
/// coverage overlapping a stretch it simply never re-digitized should
/// never make correctly-charted land vanish from the union. Callers still
/// get the ordinary depth-gated union too (`build_hazard_index`, still
/// authority-clipped exactly as before) — this is an ADDITIONAL,
/// always-kept floor under it, not a replacement.
pub fn build_land_only_hazard_index(cell: &Cell, margin_m: f64) -> Option<HazardIndex> {
    let mut polys: Vec<geo::Polygon<f64>> = Vec::new();
    push_unconditional_land(cell, margin_m, &mut polys);
    finish_union(polys)
}

/// Every `BRIDGE` this boat cannot clear CLOSED (the same `blocked` test
/// [`build_hazard_index`]'s own air-draft loop uses) but whose `CATBRG`
/// says it can OPEN ([`is_openable_bridge`]) — NOT a hard block (see that
/// loop's own comment for why it skips exactly these), a purely
/// informational "check this manually" union instead: a real opening can
/// be requested, but this router has no schedule/VHF-coordination concept
/// to confirm one is actually available, so it is deliberately never
/// counted as passable water either. Same shape as `routing::preference::
/// build_unsurveyed_union` (see that function's own docs for the shared
/// "check manually" framing) — a caller runs an already-decided route's
/// own exact legs against this with the SAME generic `verify_route_legs`/
/// `chartcore.verify_route` machinery, never folds it into the hard
/// hazard union.
///
/// `air_draft_m <= 0.0` (unconfigured) => always `None` — mirrors
/// `build_hazard_index`'s own air-draft gate exactly: no meaningful
/// "cannot clear" question exists without a real mast height to ask it
/// with. `margin_m` is always `0.0` (unbuffered) here, unlike the hard
/// air-draft block: this is an informational flag on the charted
/// structure itself, not a hazard a router needs real clearance around.
pub fn build_openable_bridge_union(cell: &Cell, air_draft_m: f64) -> Option<HazardIndex> {
    let mut polys: Vec<geo::Polygon<f64>> = Vec::new();
    if air_draft_m > 0.0 {
        for f in &cell.features {
            if f.acronym != "BRIDGE" || !is_openable_bridge(f) {
                continue;
            }
            let verclr = f.attr("VERCLR").and_then(AttrValue::as_float);
            let blocked = match verclr {
                Some(clr) => air_draft_m >= clr,
                None => true,
            };
            if blocked {
                push_hazard_geometry(f, 0.0, &mut polys);
            }
        }
    }
    finish_union(polys)
}

/// Clip `hazard` to remove any ground already charted by a MORE DETAILED
/// chart — `finer_coverage`, the union of one or more other candidate
/// cells' own [`crate::coverage::Coverage`] rings, at a strictly finer
/// compilation scale than the cell `hazard` came from.
///
/// Real, not hypothetical: `hazard_indexes_for_line`'s candidate-cell
/// selection unions EVERY overlapping chart's hazard polygon regardless of
/// scale ("errs toward including" is deliberate — see that function's own
/// docs), which is fine when charts agree but silently wrong when they
/// don't: a very-coarse OVERVIEW chart's simplified coastline can swallow
/// real, navigable water a genuine harbour-scale chart correctly charts
/// as clear — confirmed on a real installed chart set (a 1:1,500,000
/// overview cell's crude land shape blocking an actual marina entrance a
/// 1:8,000 harbour chart says is open). Tile SERVING already resolves
/// exactly this ("a finer chart is authoritative over the ground it
/// actually covers", `mvt::select`); the hazard union never applied the
/// same rule until now.
///
/// `finer_coverage` and `hazard.rings` share the identical "flat,
/// nonzero-winding signed ring set" convention (`Coverage`'s own docs,
/// `HazardIndex`'s own docs say it follows Coverage's), so this reuses
/// the SAME `geo::BooleanOps` (`i_overlay`-backed) machinery
/// `build_hazard_index`/`finish_union` already do — a plain `difference`
/// between two ring soups, verified (not assumed) to reconstruct correct
/// nonzero-winding geometry from ARBITRARILY GROUPED input rings (no
/// exterior/hole pairing needed): each ring, hazard or coverage, wrapped
/// as its own hole-less `geo::Polygon` before the boolean op runs.
///
/// `None` when `finer_coverage` is empty (nothing to clip against — the
/// unclipped `hazard` already IS the answer, callers should skip this
/// call entirely rather than pay for a no-op difference) or when the
/// clip consumes the hazard whole (finer charts vouch for all of it).
pub fn clip_to_authority(
    hazard: &HazardIndex,
    finer_coverage: &[Vec<WorldXy>],
) -> Option<HazardIndex> {
    if finer_coverage.is_empty() {
        return Some(hazard.clone());
    }
    let hazard_polys: Vec<geo::Polygon<f64>> = hazard
        .rings
        .iter()
        .map(|r| geo::Polygon::new(geo_ring(r), vec![]))
        .collect();
    // Difference against `finer_coverage` ONE RING AT A TIME, folding the
    // result forward, rather than building one big subtrahend
    // `MultiPolygon` and differencing once (#owqqcdqe, 2026-08-11, found
    // live against real chart data at Grenen, the tip of Denmark):
    // `hazard_indexes_for_bbox` accumulates every already-processed
    // candidate's raw `Coverage` rings into `finer_coverage` as the
    // candidate count grows — dozens of real-world chart cells that
    // legitimately TILE edge-to-edge, sharing boundaries and near-touching
    // vertices. Handing `i_overlay` that many polygons AT ONCE, either as
    // the difference's subtrahend directly or pre-unioned into one first
    // (tried — `geo::unary_union` itself was already measured to DROP the
    // very sliver of ground a smaller union of the same rings correctly
    // resolved, before a `difference` even runs), measured NON-MONOTONIC
    // live: the exact same query point went from correctly clipped (not a
    // hazard) with a small subtrahend to WRONGLY left unclipped (a coarse
    // overview chart's hazard survived) once one more, entirely unrelated
    // coverage ring joined the set — impossible for a mathematically
    // correct set difference (`A - (B∪C)` can only ever remove AT LEAST as
    // much as `A - B`), so this is the overlay engine's own numerical
    // fragility on a large multi-polygon input, not a modelling choice.
    // `(A - B) - C == A - (B∪C)` exactly, by plain set algebra, for ANY B
    // and C — so folding one small, single-ring `difference` at a time
    // computes the identical mathematical answer while never asking
    // `i_overlay` to reason about more than two polygons at once. Verified
    // against the real bisected repro (`testdata/clip_monotonic_grenen.
    // txt`): the batched forms above both still reproduce the bug; this
    // sequential fold does not.
    // `hazard.extent` never shrinks as folding narrows `acc` — cheap and
    // still exact for filtering: a coverage ring whose OWN bbox misses it
    // entirely cannot touch any ground `acc` might still hold, so an exact
    // `difference` call against it is pure waste. On a whole-route bbox
    // (`_stitch_macro_route`'s post-stitch resimplify, the case this
    // exists for) most candidate rings sit nowhere near any ONE hazard
    // cell's own small extent — real cost the per-ring fold above would
    // otherwise pay for nothing.
    let mut acc = geo::MultiPolygon::new(hazard_polys);
    for ring in finer_coverage {
        // Nothing left to clip away — stop folding rather than pay for
        // (harmless, but pointless) `difference` calls against an already
        // empty accumulator. Common on a busy bbox: a genuinely small
        // hazard is often fully authority-covered well before every
        // candidate cell's coverage has been folded in.
        if acc.0.is_empty() {
            break;
        }
        if !extent_overlaps_ring(&hazard.extent, ring) {
            continue;
        }
        let one = geo::MultiPolygon::new(vec![geo::Polygon::new(geo_ring(ring), vec![])]);
        acc = acc.difference(&one);
    }
    finish_union(acc.0)
}

/// Does `ring`'s own bounding box overlap `extent` at all? A cheap,
/// conservative pre-filter for [`clip_to_authority`]'s per-ring fold — see
/// its own docs for why this is safe (a shrinking accumulator can only
/// ever be a SUBSET of `extent`, never outside it).
fn extent_overlaps_ring(extent: &Extent, ring: &[WorldXy]) -> bool {
    if ring.is_empty() {
        return false;
    }
    let (mut xmin, mut xmax, mut ymin, mut ymax) = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
    for p in ring {
        xmin = xmin.min(p.x);
        xmax = xmax.max(p.x);
        ymin = ymin.min(p.y);
        ymax = ymax.max(p.y);
    }
    extent.intersects(&Extent::new(xmin, xmax, ymin, ymax))
}

/// Union, round-and-reunion, and flatten `polys` into a [`HazardIndex`]'s
/// `rings`/`extent` shape — the tail end [`build_hazard_index`] shares
/// with `routing::preference`'s own class unions (a TSS/fairway zone is
/// not a hazard, but the same "signed nonzero-winding ring set + extent"
/// shape and the same round-then-reunion correctness fix both need).
/// `None` when `polys` is empty.
pub(crate) fn finish_union(polys: Vec<geo::Polygon<f64>>) -> Option<HazardIndex> {
    if polys.is_empty() {
        return None;
    }

    let unioned = union_polys(&polys);

    // Round every vertex to world-unit (≈7cm) precision, THEN self-union
    // again before flattening to rings. Rounding each float vertex of a
    // complex real polygon independently can occasionally pinch a narrow
    // feature shut (or leave it a hair open) — a tight buffer-join arc
    // around a reflex vertex, a thin isthmus — introducing a self-touch
    // the pre-rounding float geometry never had. `i_overlay`'s "node and
    // re-polygonize self-touching input" (the exact mechanism
    // `crate::mvt::mask` already relies on for the same reason) cleans
    // this up for free with a second `unary_union` call. Confirmed
    // necessary, not theoretical: without this step, routing around a
    // real chart cell's real coastline (`DE6OSTIM.S57`) showed graph
    // connectivity that was NOT monotonic as `margin_m` grew — passable
    // at 10m, impassable at 5m and 20m — which is impossible for
    // correctly-computed geometry (a bigger buffer can only ever grow a
    // hazard). See `ROUTING_TODO.md`.
    let rounded: Vec<geo::Polygon<f64>> = unioned.0.iter().map(round_to_world_precision).collect();
    let cleaned = union_polys(&rounded);

    let mut rings = Vec::new();
    let mut extent = Extent::invalid();
    for poly in &cleaned.0 {
        push_ring(poly.exterior(), true, &mut rings, &mut extent);
        for hole in poly.interiors() {
            push_ring(hole, false, &mut rings, &mut extent);
        }
    }
    (!rings.is_empty()).then_some(HazardIndex { rings, extent })
}

/// `geo::unary_union`, but on `i_overlay` 9 directly: geo 0.33's bundled
/// `i_overlay` 4.5 loops forever on some real ring-clipped inputs (a
/// 179-polygon DK leg never finished; 9.2 unions it in ~13 ms, and agrees
/// with 4.5 to <1e-6 relative area on every input 4.5 does finish).
///
/// Each polygon is oriented first (exterior CCW, holes CW) and unioned
/// under `NonZero`, so the result never depends on which ring comes first
/// — `geo::unary_union` picks `Positive`/`Negative` from the first ring
/// alone, silently dropping any polygon wound the other way.
pub(crate) fn union_polys(polys: &[geo::Polygon<f64>]) -> geo::MultiPolygon<f64> {
    use geo::orient::{Direction, Orient};
    use i_overlay::core::fill_rule::FillRule;
    use i_overlay::core::overlay_rule::OverlayRule;
    use i_overlay::float::overlay::{FloatOverlay, OverlayOptions};

    fn open_ring(ls: &geo::LineString<f64>) -> Vec<[f64; 2]> {
        let mut v: Vec<[f64; 2]> = ls.coords().map(|c| [c.x, c.y]).collect();
        if v.len() > 1 && v.first() == v.last() {
            v.pop();
        }
        v
    }
    fn closed_ring(r: Vec<[f64; 2]>) -> geo::LineString<f64> {
        geo::LineString::new(r.into_iter().map(|[x, y]| geo::Coord { x, y }).collect())
    }

    let mut subj: Vec<Vec<[f64; 2]>> = Vec::new();
    for poly in polys {
        let poly = poly.orient(Direction::Default);
        subj.push(open_ring(poly.exterior()));
        subj.extend(poly.interiors().iter().map(open_ring));
    }
    subj.retain(|r| r.len() >= 3);
    if subj.is_empty() {
        return geo::MultiPolygon::new(vec![]);
    }
    let shapes = FloatOverlay::with_subj_custom(&subj, OverlayOptions::ogc(), Default::default())
        .overlay(OverlayRule::Subject, FillRule::NonZero);
    geo::MultiPolygon::new(
        shapes
            .into_iter()
            .filter(|s| !s.is_empty())
            .map(|mut s| {
                let exterior = closed_ring(s.remove(0));
                geo::Polygon::new(exterior, s.into_iter().map(closed_ring).collect())
            })
            .collect(),
    )
}

/// Round every vertex of `poly` to the nearest whole world unit — see
/// [`build_hazard_index`]'s call site for why this needs a self-union
/// afterward, not just a cast.
fn round_to_world_precision(poly: &geo::Polygon<f64>) -> geo::Polygon<f64> {
    let round_ring = |ls: &geo::LineString<f64>| -> geo::LineString<f64> {
        geo::LineString::new(
            ls.coords()
                .map(|c| geo::Coord {
                    x: c.x.round(),
                    y: c.y.round(),
                })
                .collect(),
        )
    };
    geo::Polygon::new(
        round_ring(poly.exterior()),
        poly.interiors().iter().map(round_ring).collect(),
    )
}

/// Is `p` inside the unsafe-water union — nonzero winding over
/// [`HazardIndex::rings`], same convention [`crate::coverage::Coverage`]
/// uses for its own flat signed ring set: sum each ring's ±1 (sign of its
/// own signed area) wherever a rightward ray from `p` crosses that ring's
/// boundary an odd number of times, and `p` is covered iff the total is
/// nonzero. This is the standard nonzero-fill-rule test for a flat,
/// signed multi-contour region — it needs no hole-to-exterior grouping
/// (there isn't one; see [`HazardIndex::rings`]'s own docs), which is
/// exactly why the union keeps that flat shape instead of reconstructing
/// polygon-with-holes structure it doesn't otherwise need.
pub fn hazard_contains(idx: &HazardIndex, p: WorldXy) -> bool {
    rings_contain(&idx.rings, p)
}

/// Like [`hazard_contains`], but for a query point given as an exact
/// fraction — `(x, y)` = `scale` × the true point's own coordinates — with
/// no rounding to the nearest whole world unit first.
///
/// For most callers `hazard_contains` is the right entry point; reach for
/// this one specifically to check a point that is NOT naturally a lattice
/// point, such as a fractional step along a line between two `WorldXy`
/// endpoints. Rounding that step to the nearest `WorldXy` first (the
/// obvious-looking way to do it) can silently move the sample off the true
/// line — by design this never matters for a point genuinely deep inside
/// or outside a hazard, but for one that legitimately runs right along a
/// hazard's own boundary (a route hugging its safety margin as tightly as
/// allowed, which a shortest-path search does on purpose, not by
/// accident) that rounding error is exactly the margin of error that
/// flips the verdict — see [`rings_contain_scaled`]'s docs for the same
/// mechanism inside the router itself, where it was a real bug.
pub fn hazard_contains_scaled(idx: &HazardIndex, x: i64, y: i64, scale: i64) -> bool {
    rings_contain_scaled(&idx.rings, x, y, scale)
}

/// The nonzero-winding test [`hazard_contains`] runs, factored out to work
/// on a plain ring slice — what `routing::visibility`'s exact segment test
/// needs, since it works with rings gathered from (potentially)
/// several cells' [`HazardIndex`]es concatenated together, not one.
///
/// A point that lands EXACTLY on a ring's boundary is treated as clear
/// (not contained), for any ring — see [`ring_crossing_odd_scaled`]'s docs
/// on why ray-casting cannot be trusted to answer that case at all, and why
/// "on the line" must resolve to "not hazard" rather than either ray-cast
/// outcome.
pub(crate) fn rings_contain(rings: &[Vec<WorldXy>], p: WorldXy) -> bool {
    rings_contain_scaled(rings, p.x as i64, p.y as i64, 1)
}

/// Like [`rings_contain`], but the query point is given pre-scaled: `(px,
/// py)` = `scale` × the true point's own coordinates.
///
/// `routing::visibility::visible` uses this to test its candidate
/// segment's exact midpoint without ever performing the division that
/// finding a midpoint normally needs. Dividing `a.x + b.x` by 2 in integer
/// arithmetic silently drops the sample off the true line between `a` and
/// `b` whenever that sum is odd — the true midpoint isn't a lattice point,
/// so rounding each axis independently produces some OTHER nearby point
/// instead, by up to half a world unit off-axis. For a short ring edge
/// (exactly the case that matters most: two adjacent vertices of the same
/// ring, i.e. "walk along the hazard boundary") that's enough error to
/// land the sample on the wrong side of the boundary. Passing the UNDIVIDED
/// sum `(a.x + b.x, a.y + b.y)` at `scale = 2` instead keeps the sample
/// exactly twice the true midpoint, with nothing rounded away, so it's
/// exactly on the line whenever the true midpoint is.
pub(crate) fn rings_contain_scaled(rings: &[Vec<WorldXy>], px: i64, py: i64, scale: i64) -> bool {
    let mut winding = 0i32;
    for ring in rings {
        if ring.len() < 3 {
            continue;
        }
        match ring_crossing_odd_scaled(ring, px, py, scale) {
            None => return false,
            Some(true) => winding += if signed_area2_world(ring) > 0 { 1 } else { -1 },
            Some(false) => {}
        }
    }
    winding != 0
}

/// Standard ray-casting point-in-simple-polygon test: does a rightward ray
/// from `(px, py)` (= `scale` × the true query point) cross `ring`'s edges
/// (each vertex likewise scaled) an odd number of times? `None` when the
/// point lands exactly ON one of the ring's own edges — ray-casting has no
/// principled answer for a point exactly on the boundary (which side it
/// falls on depends on which edge it happens to sit on and the ray's
/// direction, not on anything meaningful), so this is detected and
/// reported explicitly rather than left to fall out of the ray-cast by
/// accident.
///
/// **This was a real, load-bearing bug**, not a defensive touch-up: found
/// via an instrumented pass over the old visibility-graph search's
/// visibility test (`routing::graph`, since retired in favor of
/// `routing::raster` — see `ROUTING_TODO.md`'s now-closed "margin
/// buffering is not yet trustworthy" entry for the full account, including
/// the diagnostic that localized it). `routing::visibility::visible`'s
/// exact-crossing loop (moved verbatim from that old module)
/// already correctly identifies "this chord runs exactly along a hazard's
/// own edge" as *not* a crossing (Cormen four-orientation test, a
/// degenerate zero for a shared or collinear pair) — but its fallback then
/// asked this function whether the chord's midpoint was contained, and a
/// chord that runs along a ring's own edge has its midpoint sitting
/// exactly on that edge. The un-fixed ray-cast answered essentially at
/// random depending on which edge and rounding happened to apply,
/// misclassifying ~30-40% of a real ring's own boundary edges as "blocked"
/// on `backend/data/fnc/DE6OSTIM.S57` — which ones flipped shifted with
/// every change to vertex positions (i.e. with margin), which is exactly
/// the non-monotonic-connectivity symptom that bug produced. Fixing only
/// the on-boundary detection cut that to a residual few percent, still
/// wrong: the *sample point itself* (the naive `/2` midpoint) was often not
/// exactly on the boundary it was meant to test, for the reason
/// [`rings_contain_scaled`] explains — hence this scaled form, which
/// removes the rounding division entirely rather than only detecting its
/// symptom. Orientation-agnostic on its own — [`rings_contain_scaled`] is
/// what turns this into a hole-aware test by weighting each ring's
/// contribution by its sign.
fn ring_crossing_odd_scaled(ring: &[WorldXy], px: i64, py: i64, scale: i64) -> Option<bool> {
    let mut inside = false;
    let n = ring.len();
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        let (ax, ay) = (a.x as i64 * scale, a.y as i64 * scale);
        let (bx, by) = (b.x as i64 * scale, b.y as i64 * scale);
        if point_on_segment(ax, ay, bx, by, px, py) {
            return None;
        }
        if (ay > py) != (by > py) {
            // x_at_y = ax + (py-ay)*(bx-ax)/(by-ay); compare to px without
            // dividing: multiply both sides by (by-ay), flipping the
            // inequality when it's negative.
            let den = by - ay;
            let lhs = (bx - ax) * (py - ay);
            let rhs = (px - ax) * den;
            let crosses = if den > 0 { lhs > rhs } else { lhs < rhs };
            if crosses {
                inside = !inside;
            }
        }
    }
    Some(inside)
}

/// Exact (integer) test: does `(px, py)` lie on the closed segment
/// `(ax,ay)`-`(bx,by)`? Collinear (zero cross product) AND within the
/// segment's own bounding box. Every argument here is already scaled by
/// the caller (see [`ring_crossing_odd_scaled`]); at `scale <= 2` and
/// `WorldXy`'s `i32` range, every product fits `i64` with room to spare,
/// same reasoning as `routing::visibility::segments_cross`.
fn point_on_segment(ax: i64, ay: i64, bx: i64, by: i64, px: i64, py: i64) -> bool {
    let cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if cross != 0 {
        return false;
    }
    px >= ax.min(bx) && px <= ax.max(bx) && py >= ay.min(by) && py <= ay.max(by)
}

/// Does `f` (a `RESARE`/`MIPARE` feature) carry `RESTRN` containing `7`
/// (entry prohibited)? `pub(crate)`, not private: `routing::preference::
/// build_caution_union` calls this SAME function — not a re-derived
/// duplicate — to explicitly EXCLUDE whatever [`build_hazard_index`]'s own
/// hard-block loop above already claims, so a feature can never land in
/// both the hard hazard union and the soft-avoid one (redundant, and would
/// double-penalize a route already excluded from the search space by the
/// hard block).
///
/// `false` when `RESTRN` is absent entirely — deliberately, not "unknown
/// therefore assume the worst" the way a missing `BRIDGE`/`CBLOHD` VERCLR
/// is treated above. The two cases differ in what the ABSENCE actually
/// means: `VERCLR` is mandatory under the S-57 DCEG for any charted bridge
/// over navigable water, so its absence is itself surprising and worth
/// treating conservatively. `RESTRN` has no such mandatory-encoding rule —
/// a producer charts `RESARE`/`MIPARE` at all specifically because SOME
/// restriction or military-practice designation applies to the area (that
/// is the class's own definition), independent of whether the specific
/// enumerated restriction TYPE was ever digitized into `RESTRN`. So a
/// `RESARE`/`MIPARE` with no `RESTRN` is not evidence of "no restriction"
/// (which would make it invisible to the router, the exact gap this
/// two-tier split exists to close) — but it is also not evidence of
/// specifically "entry prohibited" (`RESTRN` value `7`), which is what
/// `build_hazard_index`'s hard block requires. `false` here therefore
/// routes a `RESTRN`-absent feature to `build_caution_union`'s soft-avoid
/// tier instead of the hard block — visible and cost-penalized, never
/// silently dropped, but not blocked without positive evidence the router
/// cannot legally cross it.
pub(crate) fn entry_prohibited(f: &Feature) -> bool {
    f.attr("RESTRN")
        .and_then(AttrValue::as_int_list)
        .is_some_and(|vals| vals.contains(&RESTRN_ENTRY_PROHIBITED))
}

/// Is `f` (assumed already `BRIDGE`) mechanically able to open for a
/// vessel — see [`OPENABLE_BRIDGE_CATBRG`]? `false` when `CATBRG` is
/// absent entirely — the same "absence is not evidence of the passable
/// case" instinct a missing `VERCLR` above already gets, for an
/// independently-reasoned cause here: a bridge whose category was never
/// digitized is not evidence it opens, and wrongly downgrading a real
/// fixed bridge to "check manually, might open" would be actively unsafe
/// (a mariner waiting for an opening that will never come). `false` is
/// also the answer for a `CATBRG` value this router doesn't recognise at
/// all (an enum value outside the real domain table) — same "unknown is
/// not the safe case" posture, not silently treated as one bucket or the
/// other on a guess.
///
/// `as_int_list`, not `as_int`: `CATBRG`'s own catalogued `Attributetype`
/// is `L` (list — `s57attributes.csv`, checked directly), same shape as
/// `RESTRN` above, and a real OSENC producer encodes a list-typed
/// attribute as a comma-joined string (`AttrValue::StrList`, see
/// `osenc::mod`'s own decode switch) even when — as here — only one code
/// applies. A first cut used `as_int`, which only ever matches a bare
/// `AttrValue::Int` and silently returned `None` for every real `CATBRG`
/// this way — found live, against the real installed Danish chart set: a
/// genuine opening span of Aggersundbroen (57°00.0′N 009°17.6′E, one of
/// several separately-charted segments of the same bridge — the others
/// are `CATBRG=1`/fixed) carries `CATBRG=StrList(["2"])`
/// (opening bridge) exactly as expected, but was read as absent and so
/// stayed hard-blocked.
pub(crate) fn is_openable_bridge(f: &Feature) -> bool {
    f.attr("CATBRG")
        .and_then(AttrValue::as_int_list)
        .is_some_and(|vals| vals.iter().any(|v| OPENABLE_BRIDGE_CATBRG.contains(v)))
}

fn extent_center(e: &Extent) -> WorldXy {
    WorldXy::new(
        ((e.xmin as i64 + e.xmax as i64) / 2) as i32,
        ((e.ymin as i64 + e.ymax as i64) / 2) as i32,
    )
}

/// A real-world clearance `radius_m` converted to world units at `center`'s
/// latitude — see the module docs' "Buffering across latitude" section.
/// `world_from_sm` already converts *projected* Mercator metres to world
/// units with no latitude term of its own (`crate::coords` docs); the
/// `secant(lat)` factor here is what turns a *real ground* metre figure
/// into the projected-metre figure that function expects.
///
/// `pub(crate)`, not private: `routing::raster::shortest_path` reuses this
/// exact conversion for its own corridor padding and grid cell sizing —
/// same "one reference latitude is accurate enough at coastal scale" call,
/// no reason to duplicate the secant(lat) arithmetic a second time.
pub(crate) fn radius_world_units(center: WorldXy, radius_m: f64) -> f64 {
    if radius_m <= 0.0 {
        return 0.0;
    }
    let lat = worldy_to_lat(center.y);
    let cos_lat = lat.to_radians().cos().max(0.01); // no marine chart sails this close to a pole
    let projected_m = radius_m / cos_lat;
    let shifted = world_from_sm(projected_m, 0.0, center);
    (shifted.x as i64 - center.x as i64).unsigned_abs() as f64
}

/// Real-metre straight-line distance between two world points, via the
/// same secant(lat) conversion [`radius_world_units`] already applies —
/// "one rule, defined once": [`crate::mivnav::field::TileEntry::
/// centre_distance_m`] and [`crate::mivnav::query`]'s own graced
/// snapping both need this exact number, so it lives here rather than
/// being hand-rolled a second (or third) time. Raw World-unit deltas are
/// NOT metres (`COORD_FACTOR` is units per 360° of longitude, not units
/// per metre) — this is the one place in the crate that turns a
/// world-space `hypot` into a real distance; every caller measuring one
/// should route through this rather than reimplementing the conversion.
pub(crate) fn world_distance_m(a: WorldXy, b: WorldXy) -> f64 {
    let world_units = f64::from(a.x - b.x).hypot(f64::from(a.y - b.y));
    let units_per_metre = radius_world_units(a, 1.0);
    if units_per_metre <= 0.0 {
        return 0.0; // defensive: radius_world_units only returns <=0 for radius_m<=0, unreachable here
    }
    world_units / units_per_metre
}

pub(crate) fn geo_ring(pts: &[WorldXy]) -> geo::LineString<f64> {
    geo::LineString::new(
        pts.iter()
            .map(|p| geo::Coord {
                x: p.x as f64,
                y: p.y as f64,
            })
            .collect(),
    )
}

fn geo_polygon(poly: &crate::model::Polygon) -> geo::Polygon<f64> {
    geo::Polygon::new(
        geo_ring(&poly.outer),
        poly.holes.iter().map(|h| geo_ring(h)).collect(),
    )
}

/// Push `f`'s area geometry, buffered outward by `margin_m` at its own
/// latitude, onto `out`. A no-op for features without `Areas` geometry.
/// `pub(crate)`, not private: `routing::preference`'s own class unions
/// reuse this with `margin_m = 0.0` (unbuffered — a TSS/fairway zone
/// isn't a hazard with its own clearance).
pub(crate) fn push_areas(f: &Feature, margin_m: f64, out: &mut Vec<geo::Polygon<f64>>) {
    let Some(Geometry::Areas(area_polys)) = &f.geometry else {
        return;
    };
    let r = radius_world_units(extent_center(&f.extent), margin_m);
    for poly in area_polys {
        let gp = geo_polygon(poly);
        if r > 0.0 {
            out.extend(gp.buffer(r).0);
        } else {
            out.push(gp);
        }
    }
}

/// Push a hazard feature's geometry — point, line, or area, S-57 allows
/// all three for `WRECKS`/`OBSTRN`/`UWTROC` and `SLCONS` (see the module
/// docs' bullet for each) — buffered by `margin_m` at its own latitude.
/// Point/line geometry always gets at least [`MIN_HAZARD_RADIUS_WORLD`]
/// so it exists in the union as an area (see the module docs).
fn push_hazard_geometry(f: &Feature, margin_m: f64, out: &mut Vec<geo::Polygon<f64>>) {
    let center = extent_center(&f.extent);
    let r = radius_world_units(center, margin_m);
    match &f.geometry {
        Some(Geometry::Point(p)) => {
            let gp = geo::Point::new(p.x as f64, p.y as f64);
            out.extend(gp.buffer(r.max(MIN_HAZARD_RADIUS_WORLD)).0);
        }
        Some(Geometry::Lines(lines)) => {
            for line in lines {
                if line.len() < 2 {
                    continue;
                }
                out.extend(geo_ring(line).buffer(r.max(MIN_HAZARD_RADIUS_WORLD)).0);
            }
        }
        Some(Geometry::Areas(area_polys)) => {
            for poly in area_polys {
                let gp = geo_polygon(poly);
                if r > 0.0 {
                    out.extend(gp.buffer(r).0);
                } else {
                    out.push(gp);
                }
            }
        }
        _ => {}
    }
}

/// Nominal half-width applied to a preferred-route feature charted as a
/// LINE (`NAVLNE` always; `RECTRC` when a producer charts it as a line
/// rather than an area — S-57 permits either, see
/// `s57objectclasses.csv`) so it exists as a real preference AREA at all —
/// the same problem [`MIN_HAZARD_RADIUS_WORLD`] solves for a point/line
/// HAZARD, but that floor is a near-zero (single world unit, ~7.5cm at the
/// equator) epsilon ONLY because the caller's own real `margin_m` (always
/// > 0 for a live safety search) is what gives a hazard its real,
/// safety-relevant footprint on top of it. A `routing::preference` zone
/// has no such second buffering step — `margin_m` there is
/// unconditionally `0.0` by design (see that module's own docs: "the
/// charted boundary itself is what matters") — so reusing
/// `MIN_HAZARD_RADIUS_WORLD`'s epsilon verbatim would leave a
/// line-charted `NAVLNE`/`RECTRC` SYSTEMATICALLY invisible to the router:
/// `raster::rasterize`'s single-centre-per-cell sample test would
/// essentially never land inside a corridor 7.5cm wide, at any of this
/// crate's real grid resolutions (`raster::MIN_CELL_M` = 6m ..
/// `raster::MAX_CELL_M` = 120m). Sized comfortably above `MAX_CELL_M` (the
/// COARSEST cell this module ever rasterizes at) so the preference
/// registers reliably regardless of how coarse a given request's grid
/// ends up, not just on a short, fine-resolution one. S-57 charts no width
/// attribute for either class (`NAVLNE`: `CATNAV;DATEND;DATSTA;ORIENT;
/// PEREND;PERSTA;STATUS`; `RECTRC`: no width attribute either), so this is
/// a deliberately nominal stand-in, not a charted value — kept as a fixed
/// internal constant rather than a new `RoutingConfig` field, mirroring
/// `MIN_HAZARD_RADIUS_WORLD`'s own precedent: nobody has a real basis to
/// tune a preferred-route corridor width yet, any more than a bare hazard
/// point's own existence-floor is user-tunable today.
const LINE_PREFERENCE_HALF_WIDTH_M: f64 = 150.0;

/// Push a preferred-route feature's geometry (`routing::preference`'s own
/// class list — `FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT`) onto `out`, UNBUFFERED
/// when charted as an AREA (the charted boundary itself is the preference
/// zone, same `margin_m = 0.0` convention [`push_areas`] already uses) but
/// buffered by [`LINE_PREFERENCE_HALF_WIDTH_M`] when charted as a LINE —
/// see that constant's own docs for why a zero-width line preference zone
/// would otherwise be a silent no-op. No `Point` arm: per
/// `s57objectclasses.csv`, none of the four classes this exists for
/// permits point geometry (`RECTRC`: Line;Area, `NAVLNE`: Line, `DWRTPT`:
/// Area, `FAIRWY`: Area) — confirmed directly against chartcore's own
/// vendored catalogue, not assumed from the class name (`DWRTPT` reads as
/// "deep water route point" but is actually "Deep water route **part**",
/// an AREA class, no different in shape from `FAIRWY`).
pub(crate) fn push_preferred_route_geometry(f: &Feature, out: &mut Vec<geo::Polygon<f64>>) {
    match &f.geometry {
        Some(Geometry::Areas(area_polys)) => {
            for poly in area_polys {
                out.push(geo_polygon(poly));
            }
        }
        Some(Geometry::Lines(lines)) => {
            let r = radius_world_units(extent_center(&f.extent), LINE_PREFERENCE_HALF_WIDTH_M);
            for line in lines {
                if line.len() < 2 {
                    continue;
                }
                out.extend(geo_ring(line).buffer(r).0);
            }
        }
        _ => {}
    }
}

/// Push a soft-avoid preference feature's geometry (`routing::preference`'s
/// cable/caution class families) onto `out` — UNBUFFERED when charted as
/// an AREA (same `margin_m = 0.0` convention [`push_areas`]/
/// [`push_preferred_route_geometry`] already use: the charted boundary
/// itself is the preference zone) but buffered by
/// [`LINE_PREFERENCE_HALF_WIDTH_M`] when charted as a LINE or POINT.
///
/// Unlike [`push_preferred_route_geometry`] (no `Point` arm — none of its
/// four classes permit point geometry), this DOES need one: per
/// `s57objectclasses.csv` (checked directly, not assumed), `CBLSUB` is
/// Line-only, `PIPSOL` is Point;Line, and `ACHARE`/`CTNARE`/`MIPARE` are
/// all Point;Area — an anchorage or caution area charted as a single point
/// at overview scale is a real, common case, not a hypothetical one. A
/// bare point buffered only by [`MIN_HAZARD_RADIUS_WORLD`] (this module's
/// own near-zero epsilon for a HAZARD point, where the caller's real
/// `margin_m` does the actual sizing) would be invisible at any of this
/// crate's real grid resolutions, for exactly the reason
/// [`LINE_PREFERENCE_HALF_WIDTH_M`]'s own docs give for why a line needs
/// more than that epsilon — so a soft-avoid POINT reuses that same nominal
/// width rather than a smaller, untuned one of its own: there is no more
/// evidence to size a point-charted anchorage differently than a
/// line-charted cable than there was to size `NAVLNE` differently from
/// `RECTRC`.
pub(crate) fn push_soft_avoid_geometry(f: &Feature, out: &mut Vec<geo::Polygon<f64>>) {
    match &f.geometry {
        Some(Geometry::Areas(area_polys)) => {
            for poly in area_polys {
                out.push(geo_polygon(poly));
            }
        }
        Some(Geometry::Lines(lines)) => {
            let r = radius_world_units(extent_center(&f.extent), LINE_PREFERENCE_HALF_WIDTH_M);
            for line in lines {
                if line.len() < 2 {
                    continue;
                }
                out.extend(geo_ring(line).buffer(r).0);
            }
        }
        Some(Geometry::Point(p)) => {
            let r = radius_world_units(extent_center(&f.extent), LINE_PREFERENCE_HALF_WIDTH_M);
            let gp = geo::Point::new(p.x as f64, p.y as f64);
            out.extend(gp.buffer(r).0);
        }
        _ => {}
    }
}

/// One `geo` ring, re-wound to [`HazardIndex::rings`]'s convention (see
/// its docs) and appended to `rings`/`extent`. Mirrors
/// `crate::coverage::Coverage`'s own `push_ring` — same convention, same
/// "drop `geo`'s closing repeat, drop degenerate rings" handling.
fn push_ring(
    ring: &geo::LineString<f64>,
    positive: bool,
    rings: &mut Vec<Vec<WorldXy>>,
    extent: &mut Extent,
) {
    let mut pts: Vec<WorldXy> = ring
        .coords()
        .map(|c| WorldXy::new(c.x.round() as i32, c.y.round() as i32))
        .collect();
    if pts.len() > 1 && pts.first() == pts.last() {
        pts.pop();
    }
    if pts.len() < 3 {
        return;
    }
    let a2 = signed_area2_world(&pts);
    if a2 == 0 {
        return;
    }
    if (a2 > 0) != positive {
        pts.reverse();
    }
    for p in &pts {
        extent.extend_point(*p);
    }
    rings.push(pts);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::model::{CellMeta, Polygon};
    use std::collections::BTreeMap;

    const LAT: f64 = 55.0;
    const LON: f64 = 12.0;

    /// Parses `testdata/union_hang_dk.txt` (see its header).
    fn load_union_hang_fixture() -> Vec<geo::Polygon<f64>> {
        let text = include_str!("testdata/union_hang_dk.txt");
        let mut polys = Vec::new();
        let mut rings: Vec<geo::LineString<f64>> = Vec::new();
        let flush = |rings: &mut Vec<geo::LineString<f64>>, polys: &mut Vec<geo::Polygon<f64>>| {
            if !rings.is_empty() {
                let exterior = rings.remove(0);
                polys.push(geo::Polygon::new(exterior, std::mem::take(rings)));
            }
        };
        for line in text.lines().filter(|l| !l.starts_with('#')) {
            if line == "P" {
                flush(&mut rings, &mut polys);
                continue;
            }
            let nums: Vec<f64> = line
                .strip_prefix('R')
                .expect("ring line")
                .split_whitespace()
                .map(|t| t.parse().expect("number"))
                .collect();
            rings.push(geo::LineString::new(
                nums.chunks(2).map(|c| geo::Coord { x: c[0], y: c[1] }).collect(),
            ));
        }
        flush(&mut rings, &mut polys);
        polys
    }

    /// The real DK input geo 0.33's `unary_union` (i_overlay 4.5) never
    /// returns on. Run on a worker with a deadline so a regression fails
    /// this test instead of hanging the whole suite.
    #[test]
    fn finish_union_returns_on_the_real_dk_input_that_hung_geos_union() {
        let polys = load_union_hang_fixture();
        assert_eq!(polys.len(), 179);
        let input_area: f64 = {
            use geo::Area;
            polys.iter().map(|p| p.unsigned_area()).fold(0.0, f64::max)
        };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(finish_union(polys));
        });
        let idx = rx
            .recv_timeout(std::time::Duration::from_secs(60))
            .expect("finish_union did not return within 60 s")
            .expect("non-empty union");
        assert!(!idx.rings.is_empty());
        // The union covers at least its largest input polygon.
        let union_area: f64 = idx.rings.iter().map(|r| signed_area2_world(r) as f64 / 2.0).sum();
        assert!(union_area >= input_area * 0.999, "{union_area} < {input_area}");
    }

    /// `union_polys` must not depend on input ring orientation — a CW
    /// square overlapping a CCW one still unions to their full extent.
    #[test]
    fn union_polys_ignores_input_winding() {
        use geo::Area;
        let sq = |x0: f64, cw: bool| {
            let mut c = vec![(x0, 0.0), (x0 + 10.0, 0.0), (x0 + 10.0, 10.0), (x0, 10.0), (x0, 0.0)];
            if cw {
                c.reverse();
            }
            geo::Polygon::new(geo::LineString::from(c), vec![])
        };
        let u = union_polys(&[sq(0.0, false), sq(5.0, true)]);
        assert_eq!(u.0.len(), 1);
        assert!((u.unsigned_area() - 150.0).abs() < 1e-6);
        let u = union_polys(&[sq(0.0, true), sq(5.0, false)]);
        assert!((u.unsigned_area() - 150.0).abs() < 1e-6);
    }

    fn cell(features: Vec<Feature>) -> Cell {
        let mut extent = Extent::invalid();
        for f in &features {
            extent.extend(&f.extent);
        }
        Cell {
            meta: CellMeta::default(),
            features,
            extent,
        }
    }

    /// A square ring `half_side_m` metres from centre to edge (so
    /// `2*half_side_m` on a side), centred on `(lat, lon)`. Rough
    /// (equirectangular) but fine at test scales.
    fn square(lat: f64, lon: f64, half_side_m: f64) -> Vec<WorldXy> {
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

    fn lndare(lat: f64, lon: f64, side_m: f64) -> Feature {
        Feature::new(
            71,
            "LNDARE".into(),
            BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: square(lat, lon, side_m),
                holes: vec![],
            }])),
        )
    }

    fn unsare(lat: f64, lon: f64, side_m: f64) -> Feature {
        Feature::new(
            154,
            "UNSARE".into(),
            BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: square(lat, lon, side_m),
                holes: vec![],
            }])),
        )
    }

    /// A `DEPARE` carrying already-derived `drval1`/`drval2` — as it would
    /// arrive after `derive::apply` (see `crate::derive::mod::
    /// depth_area_range`), which this module reads and never re-derives.
    /// A narrow 1m-wide band ending at `drval2` — the shape every existing
    /// caller wants; use [`wide_depare`] when the shallow/deep edges need
    /// to differ.
    fn depare(lat: f64, lon: f64, side_m: f64, drval2: f64) -> Feature {
        wide_depare(lat, lon, side_m, drval2 - 1.0, drval2)
    }

    /// A `DEPARE` with independently-chosen `drval1`/`drval2` — for
    /// exercising a wide band whose shallow edge and deep edge disagree
    /// about safety, the real shape of a Danish west-coast 0-4m/0-10m band
    /// (see `wide_shallow_depare_band_is_unsafe_even_with_a_deep_far_edge`).
    fn wide_depare(lat: f64, lon: f64, side_m: f64, drval1: f64, drval2: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("drval1".to_string(), AttrValue::Float(drval1));
        attrs.insert("drval2".to_string(), AttrValue::Float(drval2));
        Feature::new(
            42,
            "DEPARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: square(lat, lon, side_m),
                holes: vec![],
            }])),
        )
    }

    /// A `WRECKS` point carrying an already-derived `depth_value` (see
    /// `crate::derive::hazards`).
    fn wreck(lat: f64, lon: f64, depth_value: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("depth_value".to_string(), AttrValue::Float(depth_value));
        Feature::new(
            159,
            "WRECKS".into(),
            attrs,
            Some(Geometry::Point(lat_lon_to_world(lat, lon))),
        )
    }

    fn resare(lat: f64, lon: f64, side_m: f64, restrn: Vec<i64>) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("RESTRN".to_string(), AttrValue::IntList(restrn));
        Feature::new(
            112,
            "RESARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: square(lat, lon, side_m),
                holes: vec![],
            }])),
        )
    }

    /// An `SLCONS` line — a breakwater/pier/mole, the common real-world
    /// charted shape (see the module docs' `SLCONS` bullet): a LINE, not a
    /// closed polygon, which is exactly why `STRUCTURAL_HAZARD_CLASSES`
    /// routes through `push_hazard_geometry` rather than the area-only
    /// `push_areas`.
    fn slcons_line(lat: f64, lon: f64) -> Feature {
        Feature::new(
            122,
            "SLCONS".into(),
            BTreeMap::new(),
            Some(Geometry::Lines(vec![vec![
                lat_lon_to_world(lat, lon - 0.001),
                lat_lon_to_world(lat, lon + 0.001),
            ]])),
        )
    }

    /// A `BRIDGE` point carrying `VERCLR` when `verclr` is `Some` — real
    /// bridges are commonly charted as a point (a line/area variant would
    /// exercise the exact same `push_hazard_geometry` path already proven
    /// by `wreck`/`a_bare_hazard_point_still_gets_an_area` above, so this
    /// stays a point for simplicity).
    fn bridge(lat: f64, lon: f64, verclr: Option<f64>) -> Feature {
        bridge_with_catbrg(lat, lon, verclr, None)
    }

    /// A `BRIDGE` point carrying `VERCLR` and `CATBRG` when each is
    /// `Some` — for exercising the openable/fixed split
    /// [`is_openable_bridge`] draws.
    fn bridge_with_catbrg(lat: f64, lon: f64, verclr: Option<f64>, catbrg: Option<i64>) -> Feature {
        let mut attrs = BTreeMap::new();
        if let Some(v) = verclr {
            attrs.insert("VERCLR".to_string(), AttrValue::Float(v));
        }
        if let Some(c) = catbrg {
            // `StrList`, not `Int` — CATBRG's own catalogued `Attributetype`
            // is `L` (list), and a real OSENC producer encodes it as a
            // comma-joined string even for a single code (see `osenc::mod`'s
            // own decode switch) — a real Danish chart cell, checked
            // directly, carries exactly this shape
            // (`CATBRG: StrList(["2"])`). Building the test fixture as a
            // bare `AttrValue::Int` here is what let a real
            // `as_int`-vs-`as_int_list` bug (found live, against that same
            // real chart) through this whole test file undetected.
            attrs.insert(
                "CATBRG".to_string(),
                AttrValue::StrList(vec![c.to_string()]),
            );
        }
        Feature::new(
            11,
            "BRIDGE".into(),
            attrs,
            Some(Geometry::Point(lat_lon_to_world(lat, lon))),
        )
    }

    /// A `CBLOHD` line carrying `VERCLR` when `verclr` is `Some` — S-57
    /// only ever charts this class as a line, unlike `BRIDGE`.
    fn cblohd(lat: f64, lon: f64, verclr: Option<f64>) -> Feature {
        let mut attrs = BTreeMap::new();
        if let Some(v) = verclr {
            attrs.insert("VERCLR".to_string(), AttrValue::Float(v));
        }
        Feature::new(
            21,
            "CBLOHD".into(),
            attrs,
            Some(Geometry::Lines(vec![vec![
                lat_lon_to_world(lat, lon - 0.001),
                lat_lon_to_world(lat, lon + 0.001),
            ]])),
        )
    }

    #[test]
    fn empty_cell_yields_none() {
        assert!(build_hazard_index(&cell(vec![]), 2.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn land_is_always_unsafe_regardless_of_safety_depth() {
        let c = cell(vec![lndare(LAT, LON, 200.0)]);
        assert!(build_hazard_index(&c, -100.0, 0.0, 0.0).is_some());
    }

    #[test]
    fn unsurveyed_area_is_never_a_hard_block() {
        // UNSARE used to be an unconditional hard block here (like LNDARE)
        // — downgraded to a soft-avoid term instead
        // (`routing::preference::build_low_confidence_survey_union`, see
        // the module docs' own note). Found live: a real UNSARE patch off
        // the Danish coast near Skagen, with no genuinely better-surveyed
        // water nearby, made the router refuse an otherwise fine route
        // outright. A lone UNSARE feature, with nothing else in the cell,
        // must now produce NO hazard at all — the mirror image of the old
        // `unsurveyed_area_is_always_unsafe_regardless_of_safety_depth`
        // this test replaces.
        let c = cell(vec![unsare(LAT, LON, 200.0)]);
        assert!(build_hazard_index(&c, -100.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn a_charted_breakwater_is_always_unsafe_regardless_of_safety_depth() {
        // The real bug this class exists for (Strandby, a real Danish
        // harbour: a route was drawn straight through a charted
        // breakwater because SLCONS was never in any hazard class list at
        // all): a structure is impassable regardless of draft, exactly
        // like LNDARE — mirrors that test's own "even an absurdly
        // permissive safety depth must not let it through" shape.
        let c = cell(vec![slcons_line(LAT, LON)]);
        assert!(build_hazard_index(&c, -100.0, 0.0, 0.0).is_some());
    }

    #[test]
    fn land_only_hazard_index_includes_land_and_slcons_but_not_unsare() {
        // The two unconditional classes, each alone, must both produce a
        // real land-only union — matches build_hazard_index's own
        // unconditional treatment of these two, just without any of the
        // conditional classes mixed in (proven by the next test). UNSARE
        // alone must produce NONE — it is no longer unconditional at all
        // (see `unsurveyed_area_is_never_a_hard_block`), so it must be
        // just as absent from this land-only floor as any other
        // conditional class.
        for c in [
            cell(vec![lndare(LAT, LON, 200.0)]),
            cell(vec![slcons_line(LAT, LON)]),
        ] {
            assert!(build_land_only_hazard_index(&c, 0.0).is_some());
        }
        assert!(build_land_only_hazard_index(&cell(vec![unsare(LAT, LON, 200.0)]), 0.0).is_none());
    }

    #[test]
    fn land_only_hazard_index_excludes_every_conditional_class() {
        // The whole point of this function existing separately (see its
        // own docs' "Authority-clipping exemption for land" section): a
        // caller that unions it in WITHOUT authority-clipping must never
        // accidentally get a depth/wreck/restricted-area/bridge/unsurveyed
        // hazard along for the ride — those classes' scale-driven
        // disagreements are exactly what clip_to_authority exists to
        // resolve, unlike land. UNSARE joins this list now that it is a
        // soft-avoid class rather than one of `push_unconditional_land`'s
        // own two.
        let c = cell(vec![
            depare(LAT, LON, 200.0, 1.0), // shallow enough to matter, if it counted
            wreck(LAT, LON, 1.0),         // ditto
            resare(LAT, LON, 200.0, vec![7]), // entry-prohibited, if it counted
            bridge(LAT, LON, None),       // no VERCLR, would block if it counted
            unsare(LAT, LON, 200.0),      // no longer unconditional, if it counted
        ]);
        assert!(build_land_only_hazard_index(&c, 0.0).is_none());
    }

    #[test]
    fn a_bare_breakwater_line_still_gets_an_area() {
        // Same "point/line geometry needs margin_m's floor or it silently
        // vanishes" property `a_bare_hazard_point_still_gets_an_area`
        // proves for WRECKS — SLCONS is charted as a line far more often
        // than WRECKS is a bare point, so this is the common real case,
        // not an edge case.
        let c = cell(vec![slcons_line(LAT, LON)]);
        let idx = build_hazard_index(&c, 3.0, 0.0, 0.0).expect("a line hazard with margin 0");
        assert!(hazard_contains(&idx, lat_lon_to_world(LAT, LON)));
    }

    #[test]
    fn shallow_depare_is_unsafe_deep_is_not() {
        let shallow = cell(vec![depare(LAT, LON, 200.0, 1.0)]);
        let deep = cell(vec![depare(LAT, LON, 200.0, 20.0)]);
        assert!(build_hazard_index(&shallow, 3.0, 0.0, 0.0).is_some());
        assert!(build_hazard_index(&deep, 3.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn depare_at_exactly_safety_depth_is_unsafe() {
        // <= safety depth, not <: a shoal exactly at the safety contour is
        // the boundary a router must stay outside of, not graze.
        let c = cell(vec![depare(LAT, LON, 200.0, 3.0)]);
        assert!(build_hazard_index(&c, 3.0, 0.0, 0.0).is_some());
    }

    #[test]
    fn wide_shallow_depare_band_is_unsafe_even_with_a_deep_far_edge() {
        // Real bug, found live on the Danish west coast (Skagen and
        // beyond): a 0-4m (and elsewhere 0-10m) DEPARE band was sailed
        // straight through by a ~2.3m-draft route, because the old
        // `drval2 <= safety_depth_m` check only looked at the band's DEEP
        // edge — 4.0/10.0, both comfortably past any sensible
        // safety_depth_m. The band's bottom can be anywhere between
        // drval1 and drval2, so its SHALLOW edge (0.0 here) is what must
        // gate: it's the coastline itself, unsafe at any positive draft.
        let c = cell(vec![wide_depare(LAT, LON, 200.0, 0.0, 4.0)]);
        assert!(build_hazard_index(&c, 2.3, 0.0, 0.0).is_some());

        let c = cell(vec![wide_depare(LAT, LON, 200.0, 0.0, 10.0)]);
        assert!(build_hazard_index(&c, 2.3, 0.0, 0.0).is_some());

        // A band whose SHALLOW edge already clears the safety depth is
        // genuinely safe, however deep its far edge goes.
        let c = cell(vec![wide_depare(LAT, LON, 200.0, 5.0, 30.0)]);
        assert!(build_hazard_index(&c, 2.3, 0.0, 0.0).is_none());
    }

    #[test]
    fn shallow_hazard_point_is_unsafe_deep_one_is_not() {
        let shallow = cell(vec![wreck(LAT, LON, 1.0)]);
        let deep = cell(vec![wreck(LAT, LON, 50.0)]);
        assert!(build_hazard_index(&shallow, 3.0, 0.0, 0.0).is_some());
        assert!(build_hazard_index(&deep, 3.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn a_bare_hazard_point_still_gets_an_area() {
        // margin_m = 0: the point still has to become a real polygon, via
        // MIN_HAZARD_RADIUS_WORLD, or it would silently vanish from the union.
        let c = cell(vec![wreck(LAT, LON, 1.0)]);
        let idx = build_hazard_index(&c, 3.0, 0.0, 0.0).expect("a shallow wreck is unsafe");
        assert!(idx.extent.valid);
        assert!(idx.extent.xmax > idx.extent.xmin);
        assert!(idx.extent.ymax > idx.extent.ymin);
    }

    #[test]
    fn margin_widens_the_union() {
        let no_margin = cell(vec![lndare(LAT, LON, 200.0)]);
        let with_margin = cell(vec![lndare(LAT, LON, 200.0)]);
        let a = build_hazard_index(&no_margin, 2.0, 0.0, 0.0).unwrap();
        let b = build_hazard_index(&with_margin, 2.0, 100.0, 0.0).unwrap();
        let width = |idx: &HazardIndex| (idx.extent.xmax - idx.extent.xmin) as i64;
        assert!(
            width(&b) > width(&a),
            "a 100m margin must widen the hazard extent: {} vs {}",
            width(&a),
            width(&b)
        );
    }

    #[test]
    fn entry_prohibited_restricted_area_is_unsafe() {
        let c = cell(vec![resare(LAT, LON, 200.0, vec![7])]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 0.0).is_some());
    }

    #[test]
    fn restricted_area_without_entry_prohibited_is_ignored() {
        // RESTRN present, but only e.g. "fishing prohibited" (3) — passable
        // by a router, not a hard hazard. See the module docs.
        let c = cell(vec![resare(LAT, LON, 200.0, vec![3])]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 0.0).is_none());
    }

    // ── Air draft: BRIDGE/CBLOHD vertical-clearance blocking ────────────

    #[test]
    fn air_draft_off_by_default_ignores_an_otherwise_blocking_bridge() {
        // A mast far taller than the charted clearance — would block at
        // any positive air_draft_m — but air_draft_m itself is 0.0 (off).
        let c = cell(vec![bridge(LAT, LON, Some(10.0))]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn a_mast_taller_than_the_charted_clearance_is_blocked() {
        let c = cell(vec![bridge(LAT, LON, Some(10.0))]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 15.0).is_some());
    }

    #[test]
    fn a_mast_shorter_than_the_charted_clearance_is_not_blocked() {
        let c = cell(vec![bridge(LAT, LON, Some(10.0))]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 5.0).is_none());
    }

    #[test]
    fn a_mast_exactly_at_the_charted_clearance_is_blocked() {
        // >= VERCLR, not >: the boundary favours caution, the same
        // convention `depare_at_exactly_safety_depth_is_unsafe` already
        // pins for the depth side.
        let c = cell(vec![bridge(LAT, LON, Some(10.0))]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 10.0).is_some());
    }

    #[test]
    fn a_mast_a_hair_under_the_charted_clearance_is_not_blocked() {
        let c = cell(vec![bridge(LAT, LON, Some(10.0))]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 9.999).is_none());
    }

    #[test]
    fn a_bridge_with_no_verclr_is_blocked_regardless_of_air_draft() {
        // Unknown clearance — see the module docs' "Air draft" section for
        // why this differs from a depth-gated feature's own missing-value
        // handling. Even a tiny, dinghy-scale air draft must not pass.
        let c = cell(vec![bridge(LAT, LON, None)]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 0.1).is_some());
    }

    #[test]
    fn an_openable_bridge_the_boat_cannot_clear_closed_is_not_a_hard_block() {
        // CATBRG=2 (opening bridge, per the real s57expectedinput.csv
        // domain — see OPENABLE_BRIDGE_CATBRG's own docs), VERCLR too low
        // for this mast: the old behaviour (every earlier bridge test
        // above) would hard-block this. It must not any more — see the
        // module docs' "Air draft" section's own note.
        let c = cell(vec![bridge_with_catbrg(LAT, LON, Some(10.0), Some(2))]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 18.0).is_none());
    }

    #[test]
    fn a_string_list_encoded_catbrg_is_read_correctly_not_silently_dropped() {
        // Found live, against the real installed Danish chart set: a real
        // opening span of Aggersundbroen (57°00.0'N 009°17.6'E — one of
        // several separately-charted segments of the same bridge, the
        // others CATBRG=1/fixed) carries `CATBRG: StrList(["2"])`, not a
        // bare `AttrValue::Int(2)` — a first cut of `is_openable_bridge`
        // read it with `as_int`, which only matches `Int`, so a real
        // opening bridge was silently treated as unrecognised (stayed
        // hard-blocked) rather than joining the check-manually tier. Built
        // directly with `AttrValue::StrList`, not through
        // `bridge_with_catbrg` (which now already builds this shape,
        // exactly BECAUSE this bug slipped through undetected while that
        // helper used `Int` too) — this test exists to pin the WIRE SHAPE
        // itself, independent of whatever the shared helper does next.
        let mut attrs = BTreeMap::new();
        attrs.insert("VERCLR".to_string(), AttrValue::Float(10.0));
        attrs.insert(
            "CATBRG".to_string(),
            AttrValue::StrList(vec!["2".to_string()]),
        );
        let f = Feature::new(
            11,
            "BRIDGE".into(),
            attrs,
            Some(Geometry::Point(lat_lon_to_world(LAT, LON))),
        );
        let c = cell(vec![f]);
        assert!(
            build_hazard_index(&c, 2.0, 0.0, 18.0).is_none(),
            "a StrList-encoded opening CATBRG must exempt this bridge from the hard block"
        );
        assert!(build_openable_bridge_union(&c, 18.0).is_some());
    }

    #[test]
    fn a_fixed_bridge_the_boat_cannot_clear_is_still_a_hard_block() {
        // CATBRG=1 (fixed bridge): the openable exemption must not
        // over-apply to every BRIDGE regardless of category.
        let c = cell(vec![bridge_with_catbrg(LAT, LON, Some(10.0), Some(1))]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 18.0).is_some());
    }

    #[test]
    fn a_bridge_with_no_catbrg_at_all_is_still_a_hard_block() {
        // No CATBRG digitized: `is_openable_bridge` reads this as `false`
        // (see its own "absence is not evidence of the passable case"
        // docs) — same VERCLR-absence posture, applied to CATBRG instead.
        let c = cell(vec![bridge_with_catbrg(LAT, LON, Some(10.0), None)]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 18.0).is_some());
    }

    #[test]
    fn a_bridge_type_this_router_does_not_recognise_is_still_a_hard_block() {
        // CATBRG=999 — outside the real domain table entirely. Unknown
        // must not be silently treated as openable on a guess.
        let c = cell(vec![bridge_with_catbrg(LAT, LON, Some(10.0), Some(999))]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 18.0).is_some());
    }

    #[test]
    fn an_openable_bridge_the_boat_clears_fine_is_neither_blocked_nor_flagged() {
        // Plenty of clearance: not a hard block (same as any bridge), and
        // nothing to "check manually" either — there was never a real
        // obstacle here to coordinate an opening for.
        let c = cell(vec![bridge_with_catbrg(LAT, LON, Some(30.0), Some(2))]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 18.0).is_none());
        assert!(build_openable_bridge_union(&c, 18.0).is_none());
    }

    #[test]
    fn openable_bridge_union_includes_exactly_the_bridges_the_hard_union_excludes_for_it() {
        // The real integration proof, same shape as `resare_hard_block_
        // and_soft_avoid_are_mutually_exclusive_across_every_restrn_case`:
        // for every CATBRG case, a BRIDGE the boat cannot clear closed is
        // claimed by EXACTLY ONE of `build_hazard_index` (hard block) and
        // `build_openable_bridge_union` (check-manually) — never both,
        // never neither.
        for catbrg in [
            None,
            Some(1),
            Some(2),
            Some(3),
            Some(4),
            Some(5),
            Some(6),
            Some(7),
            Some(8),
            Some(9),
            Some(999),
        ] {
            let c = cell(vec![bridge_with_catbrg(LAT, LON, Some(10.0), catbrg)]);
            let hard = build_hazard_index(&c, 2.0, 0.0, 18.0).is_some();
            let check_manually = build_openable_bridge_union(&c, 18.0).is_some();
            assert_ne!(
                hard, check_manually,
                "CATBRG={catbrg:?} must be claimed by exactly one tier (hard={hard}, check_manually={check_manually})"
            );
        }
    }

    #[test]
    fn openable_bridge_union_is_off_by_default_like_the_hard_air_draft_check() {
        let c = cell(vec![bridge_with_catbrg(LAT, LON, Some(10.0), Some(2))]);
        assert!(build_openable_bridge_union(&c, 0.0).is_none());
    }

    #[test]
    fn an_overhead_cable_is_gated_the_same_way_as_a_bridge() {
        let low = cell(vec![cblohd(LAT, LON, Some(12.0))]);
        let high = cell(vec![cblohd(LAT, LON, Some(30.0))]);
        assert!(build_hazard_index(&low, 2.0, 0.0, 18.0).is_some());
        assert!(build_hazard_index(&high, 2.0, 0.0, 18.0).is_none());
    }

    #[test]
    fn a_cable_with_no_verclr_is_blocked_regardless_of_air_draft() {
        let c = cell(vec![cblohd(LAT, LON, None)]);
        assert!(build_hazard_index(&c, 2.0, 0.0, 0.1).is_some());
    }

    #[test]
    fn a_bare_bridge_point_still_gets_an_area() {
        // Same `MIN_HAZARD_RADIUS_WORLD` floor `a_bare_hazard_point_
        // still_gets_an_area` already pins for WRECKS — a blocked BRIDGE
        // point must not silently vanish from the union at margin_m=0.
        let c = cell(vec![bridge(LAT, LON, Some(5.0))]);
        let idx = build_hazard_index(&c, 2.0, 0.0, 20.0).expect("a too-low bridge is unsafe");
        assert!(idx.extent.valid);
        assert!(idx.extent.xmax > idx.extent.xmin);
        assert!(idx.extent.ymax > idx.extent.ymin);
    }

    #[test]
    fn a_hazard_fully_inside_another_does_not_enlarge_the_union() {
        // A wreck well inside a shallow DEPARE's own (margin-buffered)
        // footprint contributes no new area — proof the union actually
        // merges overlapping claims (unary_union) rather than just
        // concatenating every hazard's own polygon regardless of overlap.
        // Real sizes (a 20m margin, not the MIN_HAZARD_RADIUS_WORLD floor):
        // a bare-floor disc is only ~0.15m across and rounds to whole world
        // units unpredictably, which is a rounding-precision question, not
        // a union-correctness one.
        let margin = 20.0;
        let depare_only = cell(vec![depare(LAT, LON, 300.0, 1.0)]);
        let with_wreck = cell(vec![depare(LAT, LON, 300.0, 1.0), wreck(LAT, LON, 1.0)]);
        let a = build_hazard_index(&depare_only, 3.0, margin, 0.0).unwrap();
        let b = build_hazard_index(&with_wreck, 3.0, margin, 0.0).unwrap();
        assert_eq!(a.extent, b.extent);
    }

    #[test]
    fn contains_true_inside_a_hazard_false_outside() {
        let c = cell(vec![lndare(LAT, LON, 200.0)]);
        let idx = build_hazard_index(&c, 2.0, 0.0, 0.0).unwrap();
        assert!(hazard_contains(&idx, lat_lon_to_world(LAT, LON)));
        assert!(!hazard_contains(&idx, lat_lon_to_world(LAT + 1.0, LON)));
    }

    #[test]
    fn contains_is_false_inside_a_hole() {
        // Built by hand, not through build_hazard_index: a hole never
        // arises from today's sources (nothing subtracts), but the
        // nonzero-winding query must still handle one correctly, since
        // Coverage's own rings can carry them and this mirrors that
        // convention on purpose.
        let outer = square(LAT, LON, 300.0); // positive: signed_area2_world > 0 by construction below
        let hole = square(LAT, LON, 100.0);
        let mut extent = Extent::invalid();
        for p in outer.iter().chain(hole.iter()) {
            extent.extend_point(*p);
        }
        // normalize signs exactly like push_ring does: outer positive, hole negative
        let mut outer = outer;
        if signed_area2_world(&outer) < 0 {
            outer.reverse();
        }
        let mut hole = hole;
        if signed_area2_world(&hole) > 0 {
            hole.reverse();
        }
        let idx = HazardIndex {
            rings: vec![outer, hole],
            extent,
        };
        // in the annulus (inside outer, outside hole): unsafe
        assert!(hazard_contains(
            &idx,
            lat_lon_to_world(LAT + 250.0 / 111_320.0, LON)
        ));
        // inside the hole: safe
        assert!(!hazard_contains(&idx, lat_lon_to_world(LAT, LON)));
        // fully outside both: safe
        assert!(!hazard_contains(&idx, lat_lon_to_world(LAT + 10.0, LON)));
    }

    #[test]
    fn radius_grows_with_latitude() {
        // WebMercator stretch (secant(lat)): the same real-world radius is
        // more world units at 60N than at the equator.
        let equator = WorldXy::new(lat_lon_to_world(0.0, 0.0).x, lat_lon_to_world(0.0, 0.0).y);
        let sixty_north =
            WorldXy::new(lat_lon_to_world(60.0, 0.0).x, lat_lon_to_world(60.0, 0.0).y);
        let r_eq = radius_world_units(equator, 100.0);
        let r_60 = radius_world_units(sixty_north, 100.0);
        // secant(60deg) = 2: the 60N radius should be ~double the equator's.
        assert!(
            (r_60 / r_eq - 2.0).abs() < 0.05,
            "expected ~2x, got r_eq={r_eq} r_60={r_60} ratio={}",
            r_60 / r_eq
        );
    }

    // ── clip_to_authority: a finer chart's coverage wins over a coarser
    // chart's hazard claim over the same ground — the real bug this exists
    // for: a 1:1,500,000 overview cell's crude LNDARE swallowing a real
    // harbour a 1:8,000 cell correctly charts as open water. ──

    #[test]
    fn finer_coverage_removes_the_coarse_hazard_it_overlaps() {
        // A coarse cell's 1000m "land" square, and a finer cell's 300m
        // coverage square sitting entirely inside it (the harbour-scale
        // chart's own charted extent, correctly saying "I know this
        // ground, and I say it's fine" — its own hazard union, built
        // separately, is what actually decides that; this call only
        // removes the COARSE claim from the ground the finer chart owns).
        let coarse_hazard =
            build_hazard_index(&cell(vec![lndare(LAT, LON, 1000.0)]), 3.0, 0.0, 0.0)
                .expect("coarse cell charts land");
        let finer_coverage = vec![square(LAT, LON, 300.0)];

        let clipped = clip_to_authority(&coarse_hazard, &finer_coverage)
            .expect("hazard remains outside the finer coverage");

        // Dead centre (inside the finer cell's own coverage) is no longer
        // claimed by the coarse hazard...
        let centre = lat_lon_to_world(LAT, LON);
        assert!(!hazard_contains(&clipped, centre), "{clipped:?}");
        // ...but a point still within the coarse square, OUTSIDE the
        // finer cell's own coverage, is still correctly unsafe — clipping
        // only removes what the finer chart actually vouches for.
        let still_coarse_only =
            lat_lon_to_world(LAT, LON + (700.0 / (111_320.0 * LAT.to_radians().cos())));
        assert!(hazard_contains(&clipped, still_coarse_only), "{clipped:?}");
    }

    #[test]
    fn no_finer_coverage_leaves_the_hazard_unchanged() {
        let hazard =
            build_hazard_index(&cell(vec![lndare(LAT, LON, 500.0)]), 3.0, 0.0, 0.0).unwrap();
        let clipped = clip_to_authority(&hazard, &[]).unwrap();
        assert_eq!(clipped, hazard);
    }

    #[test]
    fn finer_coverage_disjoint_from_the_hazard_changes_nothing() {
        let hazard =
            build_hazard_index(&cell(vec![lndare(LAT, LON, 200.0)]), 3.0, 0.0, 0.0).unwrap();
        let elsewhere_coverage = vec![square(LAT + 5.0, LON + 5.0, 200.0)];
        let clipped = clip_to_authority(&hazard, &elsewhere_coverage).unwrap();
        assert_eq!(clipped, hazard);
    }

    #[test]
    fn finer_coverage_can_consume_the_whole_hazard() {
        // The finer chart's coverage fully contains the coarse hazard —
        // nothing coarse-only survives.
        let hazard =
            build_hazard_index(&cell(vec![lndare(LAT, LON, 100.0)]), 3.0, 0.0, 0.0).unwrap();
        let big_finer_coverage = vec![square(LAT, LON, 1000.0)];
        assert!(clip_to_authority(&hazard, &big_finer_coverage).is_none());
    }

    /// Parses `testdata/clip_monotonic_grenen.txt` (see that file's own
    /// header) into `(hit, hazard_rings, base_coverage, extra_coverage)`,
    /// all in world coordinates. Each of `HAZARD`/`BASE`/`EXTRA` is one
    /// ring per line, `lon,lat` pairs space-separated, terminated by `END`.
    fn load_clip_monotonic_fixture() -> (
        WorldXy,
        Vec<Vec<WorldXy>>,
        Vec<Vec<WorldXy>>,
        Vec<Vec<WorldXy>>,
    ) {
        let text = include_str!("testdata/clip_monotonic_grenen.txt");
        let parse_ring = |line: &str| -> Vec<WorldXy> {
            line.split(' ')
                .map(|pair| {
                    let (lon, lat) = pair.split_once(',').expect("malformed lon,lat pair");
                    lat_lon_to_world(
                        lat.parse().expect("malformed lat"),
                        lon.parse().expect("malformed lon"),
                    )
                })
                .collect()
        };
        let mut lines = text.lines().filter(|l| !l.starts_with('#'));
        let hit_line = lines.next().expect("missing HIT line");
        let mut hit_parts = hit_line.split(' ');
        assert_eq!(hit_parts.next(), Some("HIT"));
        let hit_lon: f64 = hit_parts.next().unwrap().parse().unwrap();
        let hit_lat: f64 = hit_parts.next().unwrap().parse().unwrap();
        let hit = lat_lon_to_world(hit_lat, hit_lon);

        let mut sections: std::collections::HashMap<&str, Vec<Vec<WorldXy>>> =
            std::collections::HashMap::new();
        let mut current: Option<&str> = None;
        let mut rings: Vec<Vec<WorldXy>> = Vec::new();
        for line in lines {
            match line {
                "HAZARD" | "BASE" | "EXTRA" => current = Some(line),
                "END" => {
                    sections.insert(
                        current.take().expect("END without a section"),
                        rings.clone(),
                    );
                    rings.clear();
                }
                _ => rings.push(parse_ring(line)),
            }
        }
        (
            hit,
            sections.remove("HAZARD").expect("missing HAZARD section"),
            sections.remove("BASE").expect("missing BASE section"),
            sections.remove("EXTRA").expect("missing EXTRA section"),
        )
    }

    #[test]
    fn clipping_stays_monotonic_as_more_real_coverage_joins_the_subtrahend() {
        // #owqqcdqe, 2026-08-11, found live against real chart data at
        // Grenen (the tip of Denmark, near where a real saved route kept
        // getting flagged as an unverified straight-line stub): a query
        // point that a small, real `finer_coverage` set (4 real chart
        // cells' own coverage polygons: `BASE` below) correctly clipped —
        // removing a coarse 1:1,500,000 overview chart's false hazard
        // there — came back UNCLIPPED once ONE more real chart cell's
        // coverage (`EXTRA`) joined the subtrahend, even though that fifth
        // coverage polygon sits nowhere near the query point itself.
        // Mathematically impossible for a correct set difference (`A -
        // (B∪C)` can only ever remove AT LEAST as much as `A - B` — never
        // less), so this was the overlay engine's own numerical fragility
        // on a large, real-world "many chart cells share edges" subtrahend,
        // not a modelling choice. Bisected down from the ~90-coverage
        // whole-route candidate set that triggered it live to this minimal
        // 5-coverage, 1-hazard-ring reproduction (`testdata/
        // clip_monotonic_grenen.txt`, dumped from the real installed chart
        // set — see that file's own header for provenance).
        let (hit, hazard_rings, base, extra) = load_clip_monotonic_fixture();
        let hazard = finish_union(
            hazard_rings
                .iter()
                .map(|r| geo::Polygon::new(geo_ring(r), vec![]))
                .collect(),
        )
        .expect("fixture hazard ring is non-empty");
        // `None` (fully clipped away) counts as "does not contain the
        // point" too — a caller that unwrapped it would just see no
        // hazard there at all, same as this predicate reports.
        let still_hits = |clipped: &Option<HazardIndex>| {
            clipped
                .as_ref()
                .is_some_and(|idx| hazard_contains(idx, hit))
        };

        let clipped_base = clip_to_authority(&hazard, &base);
        assert!(
            !still_hits(&clipped_base),
            "the fixture's own BASE coverage must already clip the query point: {clipped_base:?}"
        );

        let mut base_and_extra = base.clone();
        base_and_extra.extend(extra);
        let clipped_more = clip_to_authority(&hazard, &base_and_extra);
        assert!(
            !still_hits(&clipped_more),
            "adding ONE more real, unrelated chart cell's coverage must not un-clip a point \
             already correctly clipped by a smaller subtrahend: {clipped_more:?}"
        );
    }
}
