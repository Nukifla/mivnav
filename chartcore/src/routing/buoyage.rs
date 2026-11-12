// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Lateral-mark "correct side" preference — a soft routing cost, same
//! family as `routing::preference`'s TSS-avoidance/fairway-preference
//! zones: legal to cross, but a route that passes a port-hand mark to
//! starboard (or vice versa) given the direction it is actually being
//! sailed gets a bounded penalty. Not a hazard: `routing::hazards` stays
//! deliberately narrow, and a mark's own charted danger — if any — is
//! already in that union via whatever real `WRECKS`/`OBSTRN`/shallow
//! `DEPARE` it is marking, independently of this module.
//!
//! **Deliberately scoped to pure lateral marks** (`CATLAM` 1/2 — port,
//! starboard) on `BOYLAT`/`BCNLAT` (and the lowercase inland-ENC variants
//! `derive::aton`'s own `FLOATING_CLASSES`/`RIGID_CLASSES` already carry):
//! not `CATLAM` 3/4 (preferred-channel marks at a bifurcation — a
//! genuinely different rule, "either side is fine, one is preferred"
//! rather than "one side is correct"), and not cardinal/isolated-danger/
//! safe-water marks (`BOYCAR`/`BOYISD`/`BOYSAW` and their `BCN*`
//! equivalents) — those name a compass quadrant or a point to keep clear
//! of, not a route-direction-dependent side, a different-enough mechanism
//! to be its own follow-up (see `ROUTING_TODO.md`). Same "widen
//! deliberately, not by broadening the class filter blindly" discipline
//! `hazards.rs`'s own module docs already state.
//!
//! # Which side is "correct"
//!
//! Unlike every other preference in this crate, this one needs to know
//! which way the boat is actually going: a lateral mark's correct side is
//! only defined relative to the direction of travel (the textbook rule —
//! "keep a port-hand mark to port, a starboard-hand mark to starboard" —
//! is meaningless without a direction to hold it against). `from`/`to` (a
//! single straight reference bearing for the whole request, `to - from`,
//! not the eventual bent path — that doesn't exist yet when this is
//! built, and re-deriving the bearing from a curved path would be its own
//! source of drift) supply that direction: this project's router treats
//! the request's own `from`→`to` as "the direction being sailed", which
//! composes correctly for a return leg — going back `to`→`from` reverses
//! the direction and therefore which side of each mark is correct,
//! exactly as it should.
//!
//! `CATLAM` (1 = port, 2 = starboard) already tells you which hand a mark
//! is on, regardless of IALA region — region only matters as a fallback
//! when `CATLAM` is absent and the side has to be inferred from `COLOUR`
//! instead (real data: `DE6OSTIM.S57`'s two mole-head beacons carry
//! `COLOUR` but no `CATLAM` at all — checked directly against the real
//! fixture, not assumed). Region A: red (3) = port, green (4) =
//! starboard. Region B: reversed. `resolve_region` reads the chart's own
//! `M_NSYS`/`MARSYS` meta-object when the cell carries one (`DE6OSTIM`
//! does); `mivnav.features.routing` falls back to a configured default
//! when no candidate cell has one.
//!
//! # The geometry
//!
//! A route on the wrong side of a mark is penalized within `radius_m` of
//! it — a half-disc, not a full one: only the WRONG half of a circle
//! around the mark, built as `disc ∩ half-plane`, where the half-plane is
//! the side of the line through the mark (parallel to the direction of
//! travel) that is wrong for this mark's hand. `geo`'s `BooleanOps`
//! (`i_overlay`-backed, the same pure-Rust engine `routing::hazards`/
//! `mvt::mask` already use) computes the intersection; no trigonometric
//! arc sampling needed.
//!
//! World coordinates increase Y **southward** (`crate::coords`'
//! `lat_to_worldy`: Y shrinks as latitude grows) — a left-handed frame
//! relative to standard x-right/y-up math, so "left of the direction of
//! travel" is `cross(d, v) < 0`, not `> 0`. Verified with a worked
//! example, not assumed: facing East (`d = (1, 0)`), North (left) is `v =
//! (0, -1)` in this Y-south frame, and `cross(d, v) = 1×(-1) − 0×0 = -1 <
//! 0`. See `on_left`'s call site.

use crate::coords::WorldXy;
use crate::model::{AttrValue, Cell, Feature, Geometry};
use crate::routing::hazards::{finish_union, radius_world_units, HazardIndex};
use geo::{BooleanOps, Buffer};

/// Which S-57 object classes this module looks at — pure lateral marks,
/// floating or rigid, plus the lowercase inland-ENC variants
/// `derive::aton::FLOATING_CLASSES`/`RIGID_CLASSES` also carry.
const LATERAL_CLASSES: [&str; 4] = ["BOYLAT", "BCNLAT", "boylat", "bcnlat"];

/// IALA buoyage region — which colour means which hand when a mark's own
/// `CATLAM` is absent. See the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IalaRegion {
    A,
    B,
}

/// Which hand a pure lateral mark marks. `pub` so `mivnav::directional`
/// (§11's directional semantics) can reuse this module's own IALA
/// hand-resolution rather than re-deriving it — see [`lateral_marks`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LateralSide {
    Port,
    Starboard,
}

/// The IALA region this cell's own charted `M_NSYS` meta-object declares
/// (`MARSYS`: 1 = A, 2 = B — any other/absent value maps to `None`, same
/// "can't classify, skip" instinct as `resolve_lateral_side`). `None` when
/// `cell` charts no `M_NSYS` at all, which most cells don't — the caller
/// (`mivnav.features.routing`) is expected to fall back to a configured
/// default in that case, same shape as `safety_depth_m`'s SignalK/config
/// fallback chain.
pub fn resolve_region(cell: &Cell) -> Option<IalaRegion> {
    cell.features_of("M_NSYS")
        .find_map(|f| match f.attr("MARSYS").and_then(AttrValue::as_int) {
            Some(1) => Some(IalaRegion::A),
            Some(2) => Some(IalaRegion::B),
            _ => None,
        })
}

/// Which hand `f` marks, or `None` when it cannot be classified (no usable
/// `CATLAM`/`COLOUR`, or a `CATLAM` value outside the pure-lateral 1/2
/// this module scopes to — see the module docs on why 3/4 are excluded).
fn resolve_lateral_side(f: &Feature, region: IalaRegion) -> Option<LateralSide> {
    match f.attr("CATLAM").and_then(AttrValue::as_int) {
        Some(1) => return Some(LateralSide::Port),
        Some(2) => return Some(LateralSide::Starboard),
        _ => {}
    }
    let colour = f
        .attr("COLOUR")
        .and_then(AttrValue::as_int_list)
        .and_then(|l| l.into_iter().next())?;
    match (colour, region) {
        (3, IalaRegion::A) | (4, IalaRegion::B) => Some(LateralSide::Port),
        (4, IalaRegion::A) | (3, IalaRegion::B) => Some(LateralSide::Starboard),
        _ => None,
    }
}

/// Every classifiable pure lateral mark in `cell` — its charted point
/// position and which hand ([`LateralSide`]) it marks, resolved by the
/// same [`resolve_lateral_side`] logic [`build_buoyage_penalty`] uses
/// (its `CATLAM`, else `COLOUR` against `region`). Marks with no usable
/// `CATLAM`/`COLOUR`, a non-pure-lateral `CATLAM` (3/4 — see the module
/// docs), or non-point geometry are skipped.
///
/// Factored out of [`build_buoyage_penalty`]'s own feature loop so
/// `mivnav::directional` reuses it verbatim — §11's hard directional
/// rule and this module's soft penalty must agree on which mark is on
/// which hand, so the resolution lives in exactly one place.
pub fn lateral_marks(cell: &Cell, region: IalaRegion) -> Vec<(WorldXy, LateralSide)> {
    let mut out = Vec::new();
    for f in &cell.features {
        if !LATERAL_CLASSES.contains(&f.acronym.as_str()) {
            continue;
        }
        let Some(Geometry::Point(p)) = &f.geometry else {
            continue;
        };
        let Some(side) = resolve_lateral_side(f, region) else {
            continue;
        };
        out.push((*p, side));
    }
    out
}

/// The "wrong side of a lateral mark" penalty union for `cell`, given the
/// straight `from`→`to` reference bearing this whole request is judged
/// against (see the module docs), `region` (the `CATLAM`-absent fallback),
/// and `radius_m` (how far from a mark its penalty reaches — same role
/// `shallow_avoidance_radius_m` plays for the shallow-water preference).
///
/// `None` when `cell` charts no classifiable lateral mark near the route,
/// OR when `from == to` (no direction to judge a side against at all —
/// degrade rather than guess).
pub fn build_buoyage_penalty(
    cell: &Cell,
    from: WorldXy,
    to: WorldXy,
    region: IalaRegion,
    radius_m: f64,
) -> Option<HazardIndex> {
    let dx = to.x as f64 - from.x as f64;
    let dy = to.y as f64 - from.y as f64;
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1.0 {
        return None;
    }
    let (dx, dy) = (dx / len, dy / len);

    let mut polys: Vec<geo::Polygon<f64>> = Vec::new();
    for f in &cell.features {
        if !LATERAL_CLASSES.contains(&f.acronym.as_str()) {
            continue;
        }
        let Some(Geometry::Point(p)) = &f.geometry else {
            continue;
        };
        let Some(side) = resolve_lateral_side(f, region) else {
            continue;
        };

        // cross(d, mark - from) < 0 => mark is to the LEFT (port side) of
        // the direction of travel — see the module docs' worked example
        // for why, in this Y-south-increasing frame, the sign is flipped
        // from the standard x-right/y-up convention.
        let cross = dx * (p.y as f64 - from.y as f64) - dy * (p.x as f64 - from.x as f64);
        let on_left = cross < 0.0;
        let correct = matches!(
            (side, on_left),
            (LateralSide::Port, true) | (LateralSide::Starboard, false)
        );
        if correct {
            continue;
        }

        let r = radius_world_units(*p, radius_m);
        if r <= 0.0 {
            continue;
        }
        // The wrong-side half-plane's outward normal: a port mark is
        // wrong when found on the RIGHT (`(-dy, dx)`); a starboard mark
        // is wrong on the LEFT (`(dy, -dx)`). Both already unit length —
        // rotating a unit vector by 90° preserves its length.
        let normal = if side == LateralSide::Port {
            (-dy, dx)
        } else {
            (dy, -dx)
        };
        let disc = geo::Point::new(p.x as f64, p.y as f64).buffer(r);
        let half_plane = geo::MultiPolygon::new(vec![wrong_side_quad(*p, (dx, dy), normal, r)]);
        polys.extend(disc.intersection(&half_plane).0);
    }
    finish_union(polys)
}

/// A quad covering the half-plane on the `normal` side of the line
/// through `center` in direction `along` — big enough (twice the disc
/// radius `r`, plus a unit of slop) that intersecting it with a
/// `center`-radius-`r` disc yields exactly the half-disc on that side and
/// nothing of the other half. `normal`/`along` must already be unit
/// vectors.
fn wrong_side_quad(
    center: WorldXy,
    along: (f64, f64),
    normal: (f64, f64),
    r: f64,
) -> geo::Polygon<f64> {
    let big = r * 2.0 + 1.0;
    let (cx, cy) = (center.x as f64, center.y as f64);
    let corner = |along_dist: f64, normal_dist: f64| geo::Coord {
        x: cx + along.0 * along_dist + normal.0 * normal_dist,
        y: cy + along.1 * along_dist + normal.1 * normal_dist,
    };
    geo::Polygon::new(
        geo::LineString::new(vec![
            corner(-big, 0.0),
            corner(big, 0.0),
            corner(big, big),
            corner(-big, big),
            corner(-big, 0.0),
        ]),
        vec![],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::Extent;
    use crate::model::{Cell, CellMeta};

    fn feature(acronym: &str, x: i32, y: i32, attrs: &[(&str, AttrValue)]) -> Feature {
        let attributes = attrs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect();
        Feature::new(
            0,
            acronym.to_string(),
            attributes,
            Some(Geometry::Point(WorldXy::new(x, y))),
        )
    }

    fn cell_with(features: Vec<Feature>) -> Cell {
        Cell {
            meta: CellMeta::default(),
            features,
            extent: Extent::invalid(),
        }
    }

    // A stretch of "channel" running due east along y=0, with a port mark
    // (green in region B... here region A, so red/CATLAM=1) at (1000, -50)
    // — north of the line, i.e. to the LEFT when traveling east — and a
    // starboard mark (CATLAM=2) at (1000, 50) — to the RIGHT. Both on
    // their textbook-correct side for eastbound travel.
    #[test]
    fn marks_on_their_textbook_side_get_no_penalty() {
        let cell = cell_with(vec![
            feature("BOYLAT", 1000, -50, &[("CATLAM", AttrValue::Int(1))]),
            feature("BOYLAT", 1000, 50, &[("CATLAM", AttrValue::Int(2))]),
        ]);
        let from = WorldXy::new(0, 0);
        let to = WorldXy::new(10_000, 0);
        let idx = build_buoyage_penalty(&cell, from, to, IalaRegion::A, 200.0);
        assert!(idx.is_none(), "{idx:?}");
    }

    #[test]
    fn a_port_mark_kept_to_starboard_is_penalized() {
        // Same port mark as above, but now on the RIGHT (south) of an
        // eastbound line — wrong side.
        let cell = cell_with(vec![feature(
            "BOYLAT",
            1000,
            50,
            &[("CATLAM", AttrValue::Int(1))],
        )]);
        let from = WorldXy::new(0, 0);
        let to = WorldXy::new(10_000, 0);
        let idx = build_buoyage_penalty(&cell, from, to, IalaRegion::A, 200.0);
        assert!(idx.is_some());
    }

    #[test]
    fn reversing_the_leg_reverses_which_side_is_correct() {
        // The exact same charted mark; only the direction of travel flips.
        let mark = feature("BOYLAT", 1000, 50, &[("CATLAM", AttrValue::Int(1))]);
        let a = WorldXy::new(0, 0);
        let b = WorldXy::new(10_000, 0);

        let eastbound =
            build_buoyage_penalty(&cell_with(vec![mark.clone()]), a, b, IalaRegion::A, 200.0);
        assert!(eastbound.is_some(), "wrong side heading east");

        let westbound = build_buoyage_penalty(&cell_with(vec![mark]), b, a, IalaRegion::A, 200.0);
        assert!(westbound.is_none(), "{westbound:?}");
    }

    #[test]
    fn colour_fallback_flips_with_region_when_catlam_is_absent() {
        // Red (COLOUR=3), no CATLAM at all — DE6OSTIM's real mole-head
        // beacons are shaped exactly like this. Region A: red = port, so
        // this is the SAME "north of an eastbound line" case as the first
        // test above — no penalty. Region B: red = starboard, so the same
        // charted mark at the same position is now on ITS wrong side.
        let mark = feature(
            "BCNLAT",
            1000,
            -50,
            &[("COLOUR", AttrValue::StrList(vec!["3".into()]))],
        );
        let from = WorldXy::new(0, 0);
        let to = WorldXy::new(10_000, 0);

        let region_a = build_buoyage_penalty(
            &cell_with(vec![mark.clone()]),
            from,
            to,
            IalaRegion::A,
            200.0,
        );
        assert!(region_a.is_none(), "{region_a:?}");

        let region_b =
            build_buoyage_penalty(&cell_with(vec![mark]), from, to, IalaRegion::B, 200.0);
        assert!(region_b.is_some());
    }

    #[test]
    fn an_unclassifiable_mark_is_skipped_not_penalized() {
        // No CATLAM, no COLOUR at all — nothing to classify against.
        let cell = cell_with(vec![feature("BOYLAT", 1000, 50, &[])]);
        let from = WorldXy::new(0, 0);
        let to = WorldXy::new(10_000, 0);
        assert!(build_buoyage_penalty(&cell, from, to, IalaRegion::A, 200.0).is_none());
    }

    #[test]
    fn a_preferred_channel_catlam_is_out_of_scope() {
        // CATLAM 3/4 (preferred-channel marks) are deliberately not
        // classified by this module — see the module docs.
        let cell = cell_with(vec![feature(
            "BOYLAT",
            1000,
            50,
            &[("CATLAM", AttrValue::Int(3))],
        )]);
        let from = WorldXy::new(0, 0);
        let to = WorldXy::new(10_000, 0);
        assert!(build_buoyage_penalty(&cell, from, to, IalaRegion::A, 200.0).is_none());
    }

    #[test]
    fn no_direction_yields_no_penalty() {
        let cell = cell_with(vec![feature(
            "BOYLAT",
            1000,
            50,
            &[("CATLAM", AttrValue::Int(1))],
        )]);
        let p = WorldXy::new(0, 0);
        assert!(build_buoyage_penalty(&cell, p, p, IalaRegion::A, 200.0).is_none());
    }

    #[test]
    fn resolve_region_reads_marsys() {
        let cell_a = cell_with(vec![feature(
            "M_NSYS",
            0,
            0,
            &[("MARSYS", AttrValue::Int(1))],
        )]);
        assert_eq!(resolve_region(&cell_a), Some(IalaRegion::A));

        let cell_b = cell_with(vec![feature(
            "M_NSYS",
            0,
            0,
            &[("MARSYS", AttrValue::Int(2))],
        )]);
        assert_eq!(resolve_region(&cell_b), Some(IalaRegion::B));

        let cell_none = cell_with(vec![]);
        assert_eq!(resolve_region(&cell_none), None);
    }
}
