// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Line-geometry facts for MARCUL and FERYRT (their Area/Point rows live in
//! [`crate::derive::restricted`]). Full RCID/attribute reasoning:
//! docs/architecture/derive-facts.md

use crate::model::{AttrValue, Cell, Geometry};

pub fn apply(cell: &mut Cell) {
    for f in &mut cell.features {
        if !matches!(f.geometry, Some(Geometry::Lines(_))) {
            continue;
        }
        match f.acronym.as_str() {
            "MARCUL" => {
                f.attributes
                    .insert("bcol".into(), AttrValue::Str("CHGRF".into()));
                f.attributes.insert("bwid".into(), AttrValue::Int(2));
                f.attributes
                    .insert("lsty".into(), AttrValue::Str("dash".into()));
            }
            "FERYRT" => {
                let cable = f.attr("CATFRY").and_then(AttrValue::as_int) == Some(1);
                f.attributes.insert(
                    "lc".into(),
                    AttrValue::Str(if cable { "FERYRT01" } else { "FERYRT02" }.into()),
                );
                f.attributes.insert(
                    "bcol".into(),
                    AttrValue::Str(if cable { "CHMGD" } else { "CHBLK" }.into()),
                );
                f.attributes.insert("bwid".into(), AttrValue::Int(1));
                f.attributes
                    .insert("lsty".into(), AttrValue::Str("dash".into()));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::{CellMeta, Feature};
    use std::collections::BTreeMap;

    fn line(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(
            0,
            acronym.into(),
            map,
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
    fn marcul_line_row() {
        let f = derive(line("MARCUL", &[]));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHGRF"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(2)));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));
        assert!(f.attr("lc").is_none(), "MARCUL's line row has no named LC");
    }

    #[test]
    fn feryrt_line_row() {
        let f = derive(line("FERYRT", &[("CATFRY", AttrValue::Int(1))]));
        assert_eq!(s(&f, "lc").as_deref(), Some("FERYRT01"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));

        for attrs in [vec![], vec![("CATFRY", AttrValue::Int(2))]] {
            let f = derive(line("FERYRT", &attrs));
            assert_eq!(s(&f, "lc").as_deref(), Some("FERYRT02"));
            assert_eq!(s(&f, "bcol").as_deref(), Some("CHBLK"));
        }
    }

    #[test]
    fn other_classes_and_geometry_untouched() {
        assert!(derive(line("FAIRWY", &[])).attr("bcol").is_none());
        let pt = Feature::new(
            0,
            "MARCUL".into(),
            BTreeMap::new(),
            Some(Geometry::Point(WorldXy::new(0, 0))),
        );
        assert!(derive(pt).attr("bcol").is_none());
    }
}
