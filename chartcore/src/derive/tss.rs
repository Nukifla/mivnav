// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! TSSBND (traffic separation scheme boundary) derive pass.
//! See docs/architecture/traffic-routes-style.md for the full rationale
//! (why this bakes `bcol`/`bwid`/`lsty` and how it fits the traffic-routes group).

use crate::model::{AttrValue, Cell, Geometry};

pub fn apply(cell: &mut Cell) {
    for f in &mut cell.features {
        if f.acronym != "TSSBND" || !matches!(f.geometry, Some(Geometry::Lines(_))) {
            continue;
        }
        f.attributes
            .insert("bcol".into(), AttrValue::Str("TRFCD".into()));
        f.attributes.insert("bwid".into(), AttrValue::Int(2));
        f.attributes
            .insert("lsty".into(), AttrValue::Str("dash".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::{CellMeta, Feature};
    use std::collections::BTreeMap;

    fn line(acronym: &str) -> Feature {
        Feature::new(
            0,
            acronym.into(),
            BTreeMap::new(),
            Some(Geometry::Lines(vec![vec![
                WorldXy::new(0, 0),
                WorldXy::new(1, 1),
            ]])),
        )
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
    fn tssbnd_row() {
        let f = derive(line("TSSBND"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("TRFCD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(2)));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));
    }

    #[test]
    fn other_classes_and_geometry_untouched() {
        assert!(derive(line("FAIRWY")).attr("bcol").is_none());
        let pt = Feature::new(
            0,
            "TSSBND".into(),
            BTreeMap::new(),
            Some(Geometry::Point(WorldXy::new(0, 0))),
        );
        assert!(derive(pt).attr("bcol").is_none());
    }
}
