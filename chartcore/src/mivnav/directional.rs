// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §11's directional / buoyage semantics: per-direction legality and cost
//! for a topology edge.
//!
//! Every other cost this layer applies is direction-blind — a portal's
//! [`super::portals::Portal::touches_tss`] is a soft scalar, the same
//! whichever way you cross it (Phase 5). §11 is the first thing that has
//! to know which way the boat is going:
//!
//! * **A Traffic Separation Scheme lane has a legal direction of flow.**
//!   Crossing a `TSSLPT` — or a `DWRTPT`/`RECTRC` that is *explicitly*
//!   one-way (`TRAFIC ∈ {1,2,3}`; `TSSLPT` needs no `TRAFIC`, it is
//!   one-way by definition) — clearly against its charted `ORIENT` is
//!   **forbidden**, not merely penalised: the edge does not exist for
//!   that direction of travel. Crossing at (or near) a right angle to the
//!   flow — the textbook-legal way to cross a TSS — is left alone; so is
//!   any crossing of a two-way or `TRAFIC`-less route. See
//!   [`AGAINST_FLOW_COS_MAX`] for why "clearly against" carries a margin
//!   past 90°.
//! * **A lateral mark has a correct side** relative to the direction of
//!   travel. A crossing that would pass a port-hand mark to starboard (or
//!   vice versa) for its own direction gets a bounded, distance-graded
//!   **penalty** — soft, reusing [`crate::routing::buoyage`]'s existing
//!   IALA hand-resolution verbatim.
//!
//! # Why this is geometry, not a per-portal verdict table
//!
//! [`super::portals::detect_portals`] numbers portals canonically PER
//! BAND (§7.1's ten-rung ladder — each band has its own components, its
//! own portal set, its own ids). A rule table keyed by portal id would
//! therefore be band-specific, and a region-level artifact section
//! (§15's single "attributed semantics store") cannot carry ten of them
//! without becoming per-band like `Components`/`Portals`/`Topology`.
//!
//! So [`DirectionalSemantics`] stores the **compiled zones** — the
//! `ORIENT`-bearing flow polygons and the classified lateral marks — not
//! a verdict per directed edge. The expensive, once-per-build work
//! (walking every cell's features, parsing polygons, resolving each
//! mark's hand against the cell's own `M_NSYS`) happens in
//! [`build_directional_semantics`]. The cheap part — a point-in-polygon
//! test and a dot product per portal — runs in
//! [`super::query::route_core`]'s adjacency build, once per edge per
//! query, over the handful of zones a real region charts. That is still
//! "compiled once" in the sense §0 means it: no feature decode, no
//! geometry construction, on the query path.
//!
//! # Bearings
//!
//! A crossing's direction of travel is the bearing from
//! [`super::portals::Portal::tile`]'s centre to
//! [`super::portals::Portal::neighbour_tile`]'s centre — the SAME coarse
//! tile-centre geometry [`super::field::TileEntry::centre_distance_m`]
//! and [`super::query::corridor_extent`] already use for this layer, not
//! the exact crossing-cell path. [`bearing_deg`] returns it in compass
//! degrees (0 = true north, 90 = east); World coordinates increase Y
//! **southward** (`crate::coords`), so north is `-Y` and the conversion
//! is `atan2(Δeast, Δnorth)` with `Δnorth = from.y - to.y`.
//!
//! Angular comparisons go through `cos(a − b)` rather than a normalised
//! angle difference: cosine is even and 2π-periodic, so there is no
//! wraparound case to get wrong, and the one threshold this module needs
//! ([`AGAINST_FLOW_COS_MAX`] `= 0.0`, i.e. exactly 90°) falls out of it
//! directly.
//!
//! # Scope — what this phase does NOT produce
//!
//! [`TransitionRule`] reserves [`TransitionRule::Preferred`] (a discount
//! for a recommended/preferred route) and
//! [`TransitionRule::ScheduledGate`] (a lock or opening bridge as a fixed
//! expected-wait cost, §9.2). Both round-trip through the on-disk format
//! so the numbering is fixed, but nothing here emits them:
//!
//! * `ScheduledGate` needs `M_NSYS`-independent lock/bridge handling and
//!   overlaps the semantics-store work Phase 5's remaining soft costs
//!   also wait on. A `route_time_unix` query parameter is accepted from
//!   day one (§9.2) but unused until this exists.
//! * `Preferred` needs a defensible discount magnitude and a way to keep
//!   the search heuristic admissible against a NEGATIVE added cost — real
//!   work, deferred rather than guessed at.
//!
//! One-way `RECTRC`/`NAVLNE` recommended tracks are only picked up when
//! they carry AREA geometry; a line-geometry track would need buffering
//! to a polygon first, which is its own scoped follow-up (same bucket as
//! the deferred items above). `TSSRON` (roundabout) has no single
//! `ORIENT` and is skipped.

use crate::coords::WorldXy;
use crate::model::{AttrValue, Cell, Geometry};
use crate::routing::buoyage::{lateral_marks, IalaRegion, LateralSide};
use crate::routing::hazards::{rings_contain, world_distance_m};

/// A crossing is [`TransitionRule::Forbidden`] only when it is *clearly*
/// against the charted flow: `cos(bearing − ORIENT)` below this, i.e.
/// more than ~105° of separation.
///
/// The plan's literal spec is `0.0` (exactly 90° — any component opposing
/// the flow). This carries a deliberate ~15° margin below that because
/// the `bearing` fed in is the COARSE tile-centre-to-tile-centre bearing
/// (see the module docs' "Bearings" section, and
/// [`super::field::TileEntry::centre_distance_m`] for the same coarse
/// model elsewhere in this layer), NOT the exact heading through the
/// portal's own navigable gap. A near-right-angle crossing whose true
/// heading is legal (< 90° off) but whose tile-centre bearing reads a few
/// degrees over must not be deleted from the graph — forbidding removes
/// the edge outright, and on an unlucky fixture that could be the only
/// route. So the rule only fires when even a coarse bearing leaves no
/// doubt the transit opposes the lane; a genuine wrong-way transit (~180°
/// off) clears this by a wide margin. Same conservative direction the
/// rest of this crate takes when a measurement is approximate: when
/// unsure, do not block.
pub const AGAINST_FLOW_COS_MAX: f64 = -0.26;

/// How far from a lateral mark (real metres) its wrong-side penalty
/// reaches — the same role `shallow_avoidance_radius_m` plays for the
/// shallow-water preference and `radius_m` plays in
/// [`crate::routing::buoyage::build_buoyage_penalty`]. A crossing farther
/// than this from every wrong-side mark is [`TransitionRule::Allowed`].
pub const LATERAL_RADIUS_M: f64 = 150.0;

/// Ceiling on the summed wrong-side lateral penalty for one crossing, in
/// millimetre cost units (`routing::artifact::cost::MM_PER_M` = 1000, so
/// this is a 300 m detour-equivalent). A soft nudge between two real
/// crossings of the same tile pair, never enough on its own to make a
/// consistent-passage route lose to a genuinely longer one.
pub const LATERAL_MAX_PENALTY_MM: i64 = 300_000;

/// S-57 area classes that can carry a directed traffic flow as `ORIENT`.
/// `TSSLPT` (traffic separation scheme lane part) is one-way by
/// definition — its `ORIENT` *is* "the direction of established traffic
/// flow" and it carries no `TRAFIC`. `DWRTPT` (deep water route part) and
/// `RECTRC` (recommended track) can each be one-way OR two-way, and both
/// carry `TRAFIC`, so they only count as a flow zone here when
/// `TRAFIC ∈ {1, 2, 3}` (see [`ONE_WAY_TRAFIC`]) — a two-way route has no
/// single legal direction to forbid a crossing against. All three still
/// require AREA geometry and a usable `ORIENT`.
const FLOW_AREA_CLASSES: [&str; 3] = ["TSSLPT", "DWRTPT", "RECTRC"];

/// `TSSLPT` needs no `TRAFIC` gate — it is one-way by definition.
const IMPLICIT_ONE_WAY_CLASS: &str = "TSSLPT";

/// `DWRTPT` / `RECTRC` / `NAVLNE` `TRAFIC` values that mean one-way
/// (inbound / outbound / one-way). `4` is two-way — no single legal
/// direction, so not a flow zone. Absent `TRAFIC` is treated as
/// not-one-way too: an unknown direction must not forbid a crossing,
/// same conservative direction as [`AGAINST_FLOW_COS_MAX`]'s margin.
const ONE_WAY_TRAFIC: [i64; 3] = [1, 2, 3];

/// Per-direction verdict for one crossing of one topology edge.
///
/// The bidirectional seam is two directed [`super::portals::Portal`]
/// records (`portals.rs`' own convention); each is judged on its own
/// bearing, so a lane can be `Forbidden` one way and `Allowed` the
/// other from the same [`DirectionalSemantics`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionRule {
    /// No directional constraint on this crossing.
    Allowed,
    /// Against the charted traffic flow of a TSS lane / one-way route —
    /// the edge does not exist for this direction of travel.
    Forbidden,
    /// Wrong side of one or more lateral marks for this direction —
    /// `extra_mm` (`>= 0`, capped at [`LATERAL_MAX_PENALTY_MM`]) is added
    /// to the edge's step cost AFTER the soft-preference multiplier.
    Penalized { extra_mm: i64 },
    /// RESERVED for the on-disk format — a discount for a preferred /
    /// recommended route. Not produced this phase; see the module docs.
    Preferred { discount_mm: i64 },
    /// RESERVED for the on-disk format — a lock or opening bridge as a
    /// fixed expected-wait cost (§9.2). Not produced this phase.
    ScheduledGate { wait_mm: i64 },
}

/// On-disk tag for a [`TransitionRule`] variant — see
/// [`super::persist::encode_semantics`]. Kept here next to the enum so a
/// new variant and its tag land together.
impl TransitionRule {
    /// `(tag, operand)` for the payload. `Allowed` never reaches the
    /// wire (an unlisted portal IS allowed), but has a tag for
    /// completeness.
    pub fn to_tag(self) -> (u8, i64) {
        match self {
            TransitionRule::Allowed => (0, 0),
            TransitionRule::Forbidden => (1, 0),
            TransitionRule::Penalized { extra_mm } => (2, extra_mm),
            TransitionRule::Preferred { discount_mm } => (3, discount_mm),
            TransitionRule::ScheduledGate { wait_mm } => (4, wait_mm),
        }
    }

    /// Inverse of [`Self::to_tag`]. `None` for an unknown tag (a newer
    /// build's variant an older boat cannot interpret).
    pub fn from_tag(tag: u8, operand: i64) -> Option<TransitionRule> {
        Some(match tag {
            0 => TransitionRule::Allowed,
            1 => TransitionRule::Forbidden,
            2 => TransitionRule::Penalized { extra_mm: operand },
            3 => TransitionRule::Preferred {
                discount_mm: operand,
            },
            4 => TransitionRule::ScheduledGate { wait_mm: operand },
            _ => return None,
        })
    }
}

/// One directed traffic zone: a charted polygon plus its `ORIENT`.
///
/// `rings` are the polygons' OUTER rings only, in world coordinates —
/// [`rings_contain`]'s nonzero-winding test needs no hole/exterior
/// grouping, and a TSS lane has no holes in practice. Ignoring any hole
/// errs toward treating more of the lane as "inside", i.e. toward
/// applying the directional rule, which is the conservative direction
/// for a lane whose whole point is a one-way constraint.
#[derive(Debug, Clone, PartialEq)]
pub struct FlowZone {
    pub rings: Vec<Vec<WorldXy>>,
    /// Charted `ORIENT`, degrees true (0 = north, 90 = east) — the
    /// direction traffic legally flows along this zone.
    pub orient_deg: f64,
}

/// One classified lateral mark: its charted position and which hand it
/// marks (resolved by [`crate::routing::buoyage`] against the cell's own
/// `CATLAM`/`COLOUR` + IALA region).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DirectionalMark {
    pub pos: WorldXy,
    pub side: LateralSide,
}

/// The compiled §11 semantics for a region: every directed traffic zone
/// and every classifiable lateral mark. Empty is the normal state for a
/// chart set that charts neither — [`is_empty`](Self::is_empty) is then
/// true and [`super::query`] treats it exactly as `None`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DirectionalSemantics {
    pub flow_zones: Vec<FlowZone>,
    pub marks: Vec<DirectionalMark>,
}

impl DirectionalSemantics {
    pub fn is_empty(&self) -> bool {
        self.flow_zones.is_empty() && self.marks.is_empty()
    }

    /// The [`TransitionRule`] for crossing at world point `point` on a
    /// true bearing of `bearing_deg` degrees.
    ///
    /// [`TransitionRule::Forbidden`] wins outright: if `point` lies in
    /// any flow zone whose `ORIENT` opposes `bearing_deg` by more than
    /// 90° ([`AGAINST_FLOW_COS_MAX`]), that is the answer and lateral
    /// marks are not consulted. Otherwise every wrong-side lateral mark
    /// within [`LATERAL_RADIUS_M`] contributes `(1 − dist/radius) ×
    /// [`LATERAL_MAX_PENALTY_MM`]`, summed and capped; a nonzero sum is
    /// [`TransitionRule::Penalized`], zero is [`TransitionRule::Allowed`].
    pub fn rule_for_crossing(&self, point: WorldXy, bearing_deg: f64) -> TransitionRule {
        for zone in &self.flow_zones {
            if !rings_contain(&zone.rings, point) {
                continue;
            }
            let along = (bearing_deg - zone.orient_deg).to_radians().cos();
            if along < AGAINST_FLOW_COS_MAX {
                return TransitionRule::Forbidden;
            }
        }

        let mut penalty_mm: i64 = 0;
        for mark in &self.marks {
            let dist_m = world_distance_m(point, mark.pos);
            if dist_m >= LATERAL_RADIUS_M {
                continue;
            }
            if !wrong_side(mark.side, point, mark.pos, bearing_deg) {
                continue;
            }
            let graded = (1.0 - dist_m / LATERAL_RADIUS_M) * LATERAL_MAX_PENALTY_MM as f64;
            penalty_mm = penalty_mm.saturating_add(graded.round() as i64);
        }
        let penalty_mm = penalty_mm.clamp(0, LATERAL_MAX_PENALTY_MM);
        if penalty_mm > 0 {
            TransitionRule::Penalized {
                extra_mm: penalty_mm,
            }
        } else {
            TransitionRule::Allowed
        }
    }
}

/// The plan's `edge_allowed`, in compiled form: the [`TransitionRule`]
/// for one directed crossing. A thin free-function alias over
/// [`DirectionalSemantics::rule_for_crossing`] for callers that read
/// better with a verb.
pub fn edge_allowed(
    sem: &DirectionalSemantics,
    crossing_point: WorldXy,
    bearing_deg: f64,
) -> TransitionRule {
    sem.rule_for_crossing(crossing_point, bearing_deg)
}

/// Compass bearing from `from` to `to`, degrees true: 0 = north, 90 =
/// east, in `(−180, 180]`. World Y grows southward, so north is `−Y`.
/// Returns `0.0` for a zero-length input (a degenerate tile pair — no
/// direction to speak of; the caller then can only ever get
/// [`TransitionRule::Allowed`] out of it, the safe direction).
pub fn bearing_deg(from: WorldXy, to: WorldXy) -> f64 {
    let east = (to.x - from.x) as f64;
    let north = (from.y - to.y) as f64;
    if east == 0.0 && north == 0.0 {
        return 0.0;
    }
    east.atan2(north).to_degrees()
}

/// Is a mark of hand `side` on the WRONG side of a boat at `at` heading
/// `bearing_deg`? Mirrors [`crate::routing::buoyage`]'s own convention
/// exactly: in the Y-south frame "left of the direction of travel" is
/// `cross(d, v) < 0`, a port mark belongs on the left and a starboard
/// mark on the right, and anything else is wrong.
fn wrong_side(side: LateralSide, at: WorldXy, mark: WorldXy, bearing_deg: f64) -> bool {
    let r = bearing_deg.to_radians();
    // Direction of travel in the Y-south frame: east = sin(bearing),
    // north = cos(bearing) and north is −Y.
    let (dx, dy) = (r.sin(), -r.cos());
    let (vx, vy) = ((mark.x - at.x) as f64, (mark.y - at.y) as f64);
    let cross = dx * vy - dy * vx;
    let on_left = cross < 0.0;
    let correct = matches!(
        (side, on_left),
        (LateralSide::Port, true) | (LateralSide::Starboard, false)
    );
    !correct
}

/// Compile [`DirectionalSemantics`] from a region's decoded cells: every
/// `ORIENT`-bearing traffic polygon ([`FLOW_AREA_CLASSES`]) and every
/// classifiable lateral mark ([`crate::routing::buoyage::lateral_marks`]).
///
/// The IALA region for the `CATLAM`-absent colour fallback is read from
/// the cells' own `M_NSYS`
/// ([`crate::routing::buoyage::resolve_region`]); when no cell charts
/// one, [`IalaRegion::A`] is the documented default (the backend can
/// thread a configured region later — out of scope here).
///
/// Deterministic: zones and marks are appended in `cells` order, then
/// feature order within each cell. Never panics on degenerate input —
/// an empty or feature-less cell simply contributes nothing.
pub fn build_directional_semantics(cells: &[Cell]) -> DirectionalSemantics {
    let region = cells
        .iter()
        .find_map(crate::routing::buoyage::resolve_region)
        .unwrap_or(IalaRegion::A);

    let mut flow_zones = Vec::new();
    let mut marks = Vec::new();

    for cell in cells {
        for f in &cell.features {
            if !FLOW_AREA_CLASSES.contains(&f.acronym.as_str()) {
                continue;
            }
            let Some(orient_deg) = f.attr("ORIENT").and_then(AttrValue::as_float) else {
                continue; // no charted flow direction — nothing directional to say
            };
            if !orient_deg.is_finite() {
                continue;
            }
            // Only `TSSLPT` is one-way by definition. `DWRTPT`/`RECTRC`
            // both carry `TRAFIC` and can be two-way (`TRAFIC = 4`) or
            // unmarked — either way there is no single legal direction to
            // forbid a crossing against, so they are a flow zone only
            // with an explicit one-way `TRAFIC`.
            if f.acronym != IMPLICIT_ONE_WAY_CLASS {
                let one_way = f
                    .attr("TRAFIC")
                    .and_then(AttrValue::as_int)
                    .is_some_and(|t| ONE_WAY_TRAFIC.contains(&t));
                if !one_way {
                    continue;
                }
            }
            let Some(Geometry::Areas(polys)) = &f.geometry else {
                continue; // line-geometry tracks need buffering first — deferred
            };
            let rings: Vec<Vec<WorldXy>> = polys.iter().map(|p| p.outer.clone()).collect();
            if rings.iter().all(|r| r.len() < 3) {
                continue;
            }
            flow_zones.push(FlowZone { rings, orient_deg });
        }

        for (pos, side) in lateral_marks(cell, region) {
            marks.push(DirectionalMark { pos, side });
        }
    }

    DirectionalSemantics { flow_zones, marks }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::Extent;
    use crate::model::{AttrValue, CellMeta, Feature, Geometry, Polygon};

    fn square(cx: i32, cy: i32, half: i32) -> Polygon {
        Polygon {
            outer: vec![
                WorldXy::new(cx - half, cy - half),
                WorldXy::new(cx + half, cy - half),
                WorldXy::new(cx + half, cy + half),
                WorldXy::new(cx - half, cy + half),
                WorldXy::new(cx - half, cy - half),
            ],
            holes: vec![],
        }
    }

    fn feat(acronym: &str, geom: Geometry, attrs: &[(&str, AttrValue)]) -> Feature {
        Feature::new(
            0,
            acronym.to_string(),
            attrs
                .iter()
                .map(|(k, v)| ((*k).to_string(), v.clone()))
                .collect(),
            Some(geom),
        )
    }

    fn cell_with(features: Vec<Feature>) -> Cell {
        Cell {
            meta: CellMeta::default(),
            features,
            extent: Extent::invalid(),
        }
    }

    /// A TSS lane centred on the origin, flow due east (`ORIENT = 90`).
    fn eastbound_lane() -> DirectionalSemantics {
        build_directional_semantics(&[cell_with(vec![feat(
            "TSSLPT",
            Geometry::Areas(vec![square(0, 0, 1000)]),
            &[("ORIENT", AttrValue::Float(90.0))],
        )])])
    }

    #[test]
    fn bearing_is_compass_true_north_zero_east_ninety() {
        assert!((bearing_deg(WorldXy::new(0, 0), WorldXy::new(0, -10)) - 0.0).abs() < 1e-9);
        assert!((bearing_deg(WorldXy::new(0, 0), WorldXy::new(10, 0)) - 90.0).abs() < 1e-9);
        assert!((bearing_deg(WorldXy::new(0, 0), WorldXy::new(0, 10)).abs() - 180.0).abs() < 1e-9);
        assert!((bearing_deg(WorldXy::new(0, 0), WorldXy::new(-10, 0)) + 90.0).abs() < 1e-9);
        assert_eq!(bearing_deg(WorldXy::new(5, 5), WorldXy::new(5, 5)), 0.0);
    }

    #[test]
    fn crossing_against_the_flow_is_forbidden_with_it_is_allowed() {
        let sem = eastbound_lane();
        let p = WorldXy::new(0, 0);
        // Heading west, straight against a due-east flow.
        assert_eq!(
            sem.rule_for_crossing(p, -90.0),
            TransitionRule::Forbidden,
            "westbound through an eastbound lane"
        );
        // Heading east, with the flow.
        assert_eq!(sem.rule_for_crossing(p, 90.0), TransitionRule::Allowed);
        // Heading due north — a right-angle crossing, the legal way to
        // cross a TSS.
        assert_eq!(sem.rule_for_crossing(p, 0.0), TransitionRule::Allowed);
    }

    #[test]
    fn the_against_flow_rule_carries_a_margin_past_a_right_angle() {
        // ORIENT 90 (due east). The `AGAINST_FLOW_COS_MAX` margin means a
        // crossing only a few degrees past square is NOT forbidden — the
        // tile-centre bearing is too coarse to delete an edge on that.
        let sem = eastbound_lane();
        let p = WorldXy::new(0, 0);
        // ~91° of separation (bearing -1° vs ORIENT 90°): within margin.
        assert_eq!(
            sem.rule_for_crossing(p, -1.0),
            TransitionRule::Allowed,
            "a hair past square must NOT be forbidden on a coarse bearing"
        );
        // ~135° of separation: unambiguously against the flow.
        assert_eq!(
            sem.rule_for_crossing(p, -45.0),
            TransitionRule::Forbidden,
            "clearly opposing the lane"
        );
    }

    #[test]
    fn a_two_way_or_trafic_less_dwrtpt_is_not_a_flow_zone() {
        // DWRTPT carries TRAFIC and can be two-way — unlike TSSLPT it is
        // NOT one-way by construction.
        let two_way = build_directional_semantics(&[cell_with(vec![feat(
            "DWRTPT",
            Geometry::Areas(vec![square(0, 0, 1000)]),
            &[
                ("ORIENT", AttrValue::Float(90.0)),
                ("TRAFIC", AttrValue::Int(4)),
            ],
        )])]);
        assert!(two_way.flow_zones.is_empty());

        let no_trafic = build_directional_semantics(&[cell_with(vec![feat(
            "DWRTPT",
            Geometry::Areas(vec![square(0, 0, 1000)]),
            &[("ORIENT", AttrValue::Float(90.0))],
        )])]);
        assert!(no_trafic.flow_zones.is_empty());
    }

    #[test]
    fn a_one_way_dwrtpt_is_a_flow_zone() {
        let sem = build_directional_semantics(&[cell_with(vec![feat(
            "DWRTPT",
            Geometry::Areas(vec![square(0, 0, 1000)]),
            &[
                ("ORIENT", AttrValue::Float(90.0)),
                ("TRAFIC", AttrValue::Int(1)),
            ],
        )])]);
        assert_eq!(sem.flow_zones.len(), 1);
        assert_eq!(
            sem.rule_for_crossing(WorldXy::new(0, 0), -90.0),
            TransitionRule::Forbidden
        );
    }

    #[test]
    fn a_crossing_outside_every_zone_is_untouched() {
        let sem = eastbound_lane();
        // Well outside the 1000-unit half-width square.
        assert_eq!(
            sem.rule_for_crossing(WorldXy::new(50_000, 50_000), -90.0),
            TransitionRule::Allowed
        );
    }

    #[test]
    fn wrong_side_lateral_mark_penalizes_correct_side_does_not() {
        // Port mark (CATLAM 1) north of the origin. Heading east, a port
        // mark belongs to port = the boat's left = north in the Y-south
        // frame, so north-of-track is CORRECT: no penalty.
        let correct = build_directional_semantics(&[cell_with(vec![feat(
            "BOYLAT",
            Geometry::Point(WorldXy::new(0, -30)),
            &[("CATLAM", AttrValue::Int(1))],
        )])]);
        assert_eq!(
            correct.rule_for_crossing(WorldXy::new(0, 0), 90.0),
            TransitionRule::Allowed
        );

        // Same port mark now SOUTH of an eastbound track — wrong side.
        let wrong = build_directional_semantics(&[cell_with(vec![feat(
            "BOYLAT",
            Geometry::Point(WorldXy::new(0, 30)),
            &[("CATLAM", AttrValue::Int(1))],
        )])]);
        match wrong.rule_for_crossing(WorldXy::new(0, 0), 90.0) {
            TransitionRule::Penalized { extra_mm } => {
                assert!(extra_mm > 0 && extra_mm <= LATERAL_MAX_PENALTY_MM);
            }
            other => panic!("expected a penalty, got {other:?}"),
        }
    }

    #[test]
    fn reversing_the_crossing_flips_which_lateral_side_is_wrong() {
        let sem = build_directional_semantics(&[cell_with(vec![feat(
            "BOYLAT",
            Geometry::Point(WorldXy::new(0, 30)),
            &[("CATLAM", AttrValue::Int(1))],
        )])]);
        // Eastbound: wrong side (penalised, established above).
        assert!(matches!(
            sem.rule_for_crossing(WorldXy::new(0, 0), 90.0),
            TransitionRule::Penalized { .. }
        ));
        // Westbound past the same mark: now correct side.
        assert_eq!(
            sem.rule_for_crossing(WorldXy::new(0, 0), -90.0),
            TransitionRule::Allowed
        );
    }

    #[test]
    fn the_lateral_penalty_decays_with_distance() {
        let sem = build_directional_semantics(&[cell_with(vec![feat(
            "BOYLAT",
            Geometry::Point(WorldXy::new(0, 20)),
            &[("CATLAM", AttrValue::Int(1))],
        )])]);
        let near = sem.rule_for_crossing(WorldXy::new(0, 0), 90.0);
        // Slide the crossing point east so the mark is farther away but
        // still south of the (still eastbound) track.
        let sem_far = build_directional_semantics(&[cell_with(vec![feat(
            "BOYLAT",
            Geometry::Point(WorldXy::new(0, 20)),
            &[("CATLAM", AttrValue::Int(1))],
        )])]);
        let far = sem_far.rule_for_crossing(WorldXy::new(-120, 0), 90.0);
        let ex = |r: TransitionRule| match r {
            TransitionRule::Penalized { extra_mm } => extra_mm,
            _ => 0,
        };
        assert!(
            ex(near) > ex(far) && ex(far) >= 0,
            "near {:?} should outweigh far {:?}",
            near,
            far
        );
    }

    #[test]
    fn a_two_way_rectrc_is_not_a_flow_zone() {
        let sem = build_directional_semantics(&[cell_with(vec![feat(
            "RECTRC",
            Geometry::Areas(vec![square(0, 0, 1000)]),
            &[
                ("ORIENT", AttrValue::Float(90.0)),
                ("TRAFIC", AttrValue::Int(4)),
            ],
        )])]);
        assert!(sem.flow_zones.is_empty());
        assert_eq!(
            sem.rule_for_crossing(WorldXy::new(0, 0), -90.0),
            TransitionRule::Allowed
        );
    }

    #[test]
    fn a_one_way_rectrc_area_is_a_flow_zone() {
        let sem = build_directional_semantics(&[cell_with(vec![feat(
            "RECTRC",
            Geometry::Areas(vec![square(0, 0, 1000)]),
            &[
                ("ORIENT", AttrValue::Float(90.0)),
                ("TRAFIC", AttrValue::Int(2)),
            ],
        )])]);
        assert_eq!(sem.flow_zones.len(), 1);
        assert_eq!(
            sem.rule_for_crossing(WorldXy::new(0, 0), -90.0),
            TransitionRule::Forbidden
        );
    }

    #[test]
    fn a_flow_area_without_orient_is_skipped() {
        let sem = build_directional_semantics(&[cell_with(vec![feat(
            "TSSLPT",
            Geometry::Areas(vec![square(0, 0, 1000)]),
            &[],
        )])]);
        assert!(sem.is_empty());
    }

    #[test]
    fn line_geometry_tracks_are_deferred_not_consumed() {
        let sem = build_directional_semantics(&[cell_with(vec![feat(
            "RECTRC",
            Geometry::Lines(vec![vec![WorldXy::new(-1000, 0), WorldXy::new(1000, 0)]]),
            &[
                ("ORIENT", AttrValue::Float(90.0)),
                ("TRAFIC", AttrValue::Int(2)),
            ],
        )])]);
        assert!(sem.flow_zones.is_empty());
    }

    #[test]
    fn transition_rule_tags_round_trip() {
        for r in [
            TransitionRule::Allowed,
            TransitionRule::Forbidden,
            TransitionRule::Penalized { extra_mm: 12_345 },
            TransitionRule::Preferred {
                discount_mm: -6_000,
            },
            TransitionRule::ScheduledGate { wait_mm: 900_000 },
        ] {
            let (tag, operand) = r.to_tag();
            assert_eq!(TransitionRule::from_tag(tag, operand), Some(r));
        }
        assert_eq!(TransitionRule::from_tag(9, 0), None);
    }

    #[test]
    fn edge_allowed_matches_the_method() {
        let sem = eastbound_lane();
        let p = WorldXy::new(0, 0);
        assert_eq!(
            edge_allowed(&sem, p, -90.0),
            sem.rule_for_crossing(p, -90.0)
        );
    }

    #[test]
    fn empty_when_the_region_charts_nothing_directional() {
        assert!(build_directional_semantics(&[]).is_empty());
        assert!(build_directional_semantics(&[cell_with(vec![])]).is_empty());
    }
}
