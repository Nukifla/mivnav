// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! `BRIDGE` — decoded and consulted by the routing hazard engine
//! (`chartcore/src/routing/hazards.rs`, air-draft blocking) since that
//! feature shipped, but never RENDERED: no derive module computed its paint
//! facts and no frontend style layer ever referenced the `BRIDGE`
//! source-layer, so a charted bridge reached the tile (nothing in the tiler
//! filters by class — see `chartcore/src/mvt/mod.rs::build_tileset`) and
//! then drew nothing at all. Reported: a real bridge at 57°00.0'N
//! 009°17.6'E, present in the chart data and already known to routing,
//! invisible on the map.
//!
//! `chartsymbols.xml` (the pinned ochartsng commit, `s52::UPSTREAM_COMMIT`)
//! LUPs BRIDGE as an Area/Line `SY(BRIDGE01);TE(...);LS(SOLD,w,CHGRD)` at
//! `Displaybase` (always shown, like `CBLOHD` — see `cables.rs`) — but there
//! is no `BRIDGE01` artwork vendored under `chartcore/assets/s52-icons/`
//! (unlike lights/buoys/etc), so this module does not attempt that symbol.
//! Instead it follows quantenschaum's own vendored `s57-style.json` (same
//! `assets/s52-icons/` directory, `bridge`/`bridge-outline`/
//! `clearance-bridge`/`label-bridge` layers), which draws BRIDGE with a
//! plain grey line/fill outline plus a `clearance`/`clearance-safe` marker
//! (VERCLR/VERCSA) — both already-vendored SVGs, reused here rather than new
//! artwork sourced for this. The name label (OBJNAM/NOBJNM, `label-bridge`)
//! needs no derive work at all: neither attribute is stripped for this class
//! (`chartcore/src/mvt/mod.rs`'s `render_only_keep` has no BRIDGE entry), so
//! it already rides the tile untouched; the frontend reads it straight off
//! the feature.
//!
//! * `bcol`/`bwid`/`lsty` — the outline chart fact, Line/Area geometry only
//!   (S-52's own Point-type BRIDGE lookup is blank — nothing to outline for
//!   a bare point). Width differs by geometry per the LUP: 4 for Area
//!   (`LS(SOLD,4,CHGRD)`), 5 for Line (`LS(SOLD,5,CHGRD)`).
//! * `sym`/`txt` — the clearance marker, ANY geometry: a bridge charted as a
//!   bare point still gets one (the reference's `clearance-bridge` layer
//!   carries no geometry filter, so a point-geometry bridge is exactly where
//!   it is the ONLY thing that draws — matching what the user actually
//!   asked for, "shown as a POI like a light"). `sym` picks `clearance-safe`
//!   for VERCSA (BRIDGE does not normally carry this cable-only attribute,
//!   but the reference checks it first for every clearance-bearing class —
//!   mirrored rather than special-cased away) else `clearance` for VERCLR;
//!   `txt` is the winning value, formatted to one decimal like `cables.rs`'s
//!   own `clearance_text`.

use crate::model::{AttrValue, Cell, Feature, Geometry};

pub fn apply(cell: &mut Cell) {
    for f in &mut cell.features {
        if f.acronym != "BRIDGE" {
            continue;
        }
        if let Some(bwid) = outline_width(f) {
            f.attributes
                .insert("bcol".into(), AttrValue::Str("CHGRD".into()));
            f.attributes.insert("bwid".into(), AttrValue::Int(bwid));
            f.attributes
                .insert("lsty".into(), AttrValue::Str("sold".into()));
        }
        if let Some((sym, txt)) = clearance(f) {
            f.attributes
                .insert("sym".into(), AttrValue::Str(sym.into()));
            f.attributes.insert("txt".into(), AttrValue::Str(txt));
        }
    }
}

/// `LS(SOLD,w,CHGRD)`'s width — 4 for the Area LUP rows, 5 for the Line
/// rows, `None` for Point (and no-geometry) features, which have nothing to
/// outline.
fn outline_width(f: &Feature) -> Option<i64> {
    match f.geometry {
        Some(Geometry::Areas(_)) => Some(4),
        Some(Geometry::Lines(_)) => Some(5),
        _ => None,
    }
}

fn clearance(f: &Feature) -> Option<(&'static str, String)> {
    if let Some(v) = f.attr("VERCSA").and_then(AttrValue::as_float) {
        return Some(("clearance-safe", format!("{v:.1}")));
    }
    if let Some(v) = f.attr("VERCLR").and_then(AttrValue::as_float) {
        return Some(("clearance", format!("{v:.1}")));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::{CellMeta, Polygon};
    use std::collections::BTreeMap;

    fn feature(acronym: &str, geometry: Option<Geometry>, attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, acronym.into(), map, geometry)
    }

    fn line() -> Option<Geometry> {
        Some(Geometry::Lines(vec![vec![
            WorldXy::new(0, 0),
            WorldXy::new(1, 1),
        ]]))
    }

    fn area() -> Option<Geometry> {
        Some(Geometry::Areas(vec![Polygon {
            outer: vec![
                WorldXy::new(0, 0),
                WorldXy::new(1, 0),
                WorldXy::new(1, 1),
                WorldXy::new(0, 0),
            ],
            holes: vec![],
        }]))
    }

    fn point() -> Option<Geometry> {
        Some(Geometry::Point(WorldXy::new(0, 0)))
    }

    fn derive(f: Feature) -> Feature {
        let mut c = Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features: vec![f],
        };
        apply(&mut c);
        c.features.remove(0)
    }

    fn s(f: &Feature, key: &str) -> Option<String> {
        f.attr(key).and_then(AttrValue::as_str).map(str::to_string)
    }

    #[test]
    fn area_bridge_gets_a_4px_outline() {
        let f = derive(feature("BRIDGE", area(), &[]));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHGRD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(4)));
        assert_eq!(s(&f, "lsty").as_deref(), Some("sold"));
    }

    #[test]
    fn line_bridge_gets_a_5px_outline() {
        let f = derive(feature("BRIDGE", line(), &[]));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(5)));
    }

    #[test]
    fn point_bridge_gets_no_outline() {
        let f = derive(feature("BRIDGE", point(), &[]));
        assert!(f.attr("bwid").is_none());
        assert!(f.attr("bcol").is_none());
        assert!(f.attr("lsty").is_none());
    }

    #[test]
    fn other_classes_are_untouched() {
        let f = derive(feature(
            "CBLOHD",
            line(),
            &[("VERCLR", AttrValue::Float(24.5))],
        ));
        assert!(f.attr("bwid").is_none());
        assert!(f.attr("sym").is_none());
    }

    #[test]
    fn verclr_drives_the_plain_clearance_marker() {
        let f = derive(feature(
            "BRIDGE",
            area(),
            &[("VERCLR", AttrValue::Float(18.0))],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("clearance"));
        assert_eq!(s(&f, "txt").as_deref(), Some("18.0"));
    }

    #[test]
    fn versa_wins_over_verclr_and_picks_the_safe_marker() {
        let f = derive(feature(
            "BRIDGE",
            area(),
            &[
                ("VERCSA", AttrValue::Float(22.3)),
                ("VERCLR", AttrValue::Float(18.0)),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("clearance-safe"));
        assert_eq!(s(&f, "txt").as_deref(), Some("22.3"));
    }

    #[test]
    fn no_clearance_attribute_bakes_no_marker() {
        let f = derive(feature("BRIDGE", area(), &[]));
        assert!(f.attr("sym").is_none());
        assert!(f.attr("txt").is_none());
    }

    #[test]
    fn a_point_bridge_still_gets_its_clearance_marker() {
        // The one thing this module draws for a bare point: nothing to
        // outline, but the clearance marker has no geometry restriction,
        // matching the reference's own `clearance-bridge` layer — and it's
        // exactly what makes a point-charted bridge visible at all.
        let f = derive(feature(
            "BRIDGE",
            point(),
            &[("VERCLR", AttrValue::Float(5.0))],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("clearance"));
        assert_eq!(s(&f, "txt").as_deref(), Some("5.0"));
    }
}
