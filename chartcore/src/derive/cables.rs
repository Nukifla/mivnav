// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Submarine cables and pipelines — the four *line* classes of the IHO
//! "Cables and Pipelines" group (area classes CBLARE/PIPARE live in
//! [`crate::derive::restricted`]); see docs/architecture/cables-pipelines.md

use crate::model::{AttrValue, Cell, Feature, Geometry};

const LINE_CLASSES: [&str; 4] = ["CBLSUB", "CBLOHD", "PIPSOL", "PIPOHD"];

struct LineFact {
    lc: Option<&'static str>,
    bcol: &'static str,
    bwid: i64,
    lsty: &'static str,
    sym: Option<&'static str>,
    txt: Option<String>,
}

pub fn apply(cell: &mut Cell) {
    for f in &mut cell.features {
        if !LINE_CLASSES.contains(&f.acronym.as_str())
            || !matches!(f.geometry, Some(Geometry::Lines(_)))
        {
            continue;
        }

        let int_list = |key: &str| -> Vec<i64> {
            f.attr(key)
                .and_then(AttrValue::as_int_list)
                .unwrap_or_default()
        };
        // CONRAD is a scalar (1/3 = radar conspicuous), unlike CATCBL/CATPIP/PRODCT.
        let racnsp = matches!(f.attr("CONRAD").and_then(AttrValue::as_int), Some(1 | 3));

        let fact = match f.acronym.as_str() {
            "CBLSUB" => {
                // CATCBL=6 ("power line", RCID 31785): a plain LS(DASH,1,CHMGD)
                // row — no LC. Everything else (incl. no CATCBL) falls to the
                // attribute-less default row, LC(CBLSUB06), same colour.
                let power = int_list("CATCBL").contains(&6);
                LineFact {
                    lc: (!power).then_some("CBLSUB06"),
                    bcol: "CHMGD",
                    bwid: 1,
                    lsty: "dash",
                    sym: None,
                    txt: None,
                }
            }
            "CBLOHD" => LineFact {
                lc: None,
                bcol: "CHGRD",
                bwid: 4,
                lsty: "dash",
                sym: racnsp.then_some("RACNSP01"),
                txt: clearance_text(f, true),
            },
            "PIPSOL" => {
                let benign = int_list("CATPIP").iter().any(|c| [2, 3, 4, 5].contains(c))
                    || int_list("PRODCT").contains(&3);
                LineFact {
                    lc: Some(if benign { "PIPSOL06" } else { "PIPSOL05" }),
                    bcol: if benign { "CHGRD" } else { "CHMGD" },
                    bwid: 1,
                    lsty: "dash",
                    sym: None,
                    txt: None,
                }
            }
            "PIPOHD" => LineFact {
                lc: None,
                bcol: "CHGRD",
                bwid: 3,
                lsty: "sold",
                sym: racnsp.then_some("RACNSP01"),
                txt: clearance_text(f, false),
            },
            _ => unreachable!("LINE_CLASSES filter above"),
        };

        f.attributes
            .insert("bcol".into(), AttrValue::Str(fact.bcol.into()));
        f.attributes
            .insert("bwid".into(), AttrValue::Int(fact.bwid));
        f.attributes
            .insert("lsty".into(), AttrValue::Str(fact.lsty.into()));
        if let Some(lc) = fact.lc {
            f.attributes.insert("lc".into(), AttrValue::Str(lc.into()));
        }
        if let Some(sym) = fact.sym {
            f.attributes
                .insert("sym".into(), AttrValue::Str(sym.into()));
        }
        if let Some(txt) = fact.txt {
            f.attributes.insert("txt".into(), AttrValue::Str(txt));
        }
    }
}

/// `TE('clr %4.1lf','VERCLR',…)` / CBLOHD's `'sf clr %4.1lf','VERCSA'`
/// variant. `allow_csa`: only CBLOHD's rows offer the VERCSA ("safe
/// clearance") alternative; PIPOHD's TE clause always names VERCLR.
fn clearance_text(f: &Feature, allow_csa: bool) -> Option<String> {
    if let Some(v) = f.attr("VERCLR").and_then(AttrValue::as_float) {
        return Some(format!("clr {v:.1}"));
    }
    if allow_csa {
        if let Some(v) = f.attr("VERCSA").and_then(AttrValue::as_float) {
            return Some(format!("sf clr {v:.1}"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::CellMeta;
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
    fn cblsub_rows() {
        let f = derive(line("CBLSUB", &[]));
        assert_eq!(s(&f, "lc").as_deref(), Some("CBLSUB06"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));

        let f = derive(line("CBLSUB", &[("CATCBL", AttrValue::IntList(vec![6]))]));
        assert!(f.attr("lc").is_none(), "CATCBL=6 is already a plain LS row");
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGD"));
    }

    #[test]
    fn cblohd_rows() {
        let f = derive(line("CBLOHD", &[]));
        assert!(f.attr("lc").is_none());
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHGRD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(4)));
        assert!(f.attr("sym").is_none());
        assert!(f.attr("txt").is_none());

        let f = derive(line("CBLOHD", &[("CONRAD", AttrValue::Int(1))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("RACNSP01"));
        let f = derive(line("CBLOHD", &[("CONRAD", AttrValue::Int(2))]));
        assert!(f.attr("sym").is_none(), "2 = not radar conspicuous");

        let f = derive(line("CBLOHD", &[("VERCLR", AttrValue::Float(24.5))]));
        assert_eq!(s(&f, "txt").as_deref(), Some("clr 24.5"));
        let f = derive(line("CBLOHD", &[("VERCSA", AttrValue::Float(18.0))]));
        assert_eq!(s(&f, "txt").as_deref(), Some("sf clr 18.0"));
        // VERCLR wins if somehow both are present
        let f = derive(line(
            "CBLOHD",
            &[
                ("VERCLR", AttrValue::Float(1.0)),
                ("VERCSA", AttrValue::Float(2.0)),
            ],
        ));
        assert_eq!(s(&f, "txt").as_deref(), Some("clr 1.0"));
    }

    #[test]
    fn pipsol_rows() {
        let f = derive(line("PIPSOL", &[]));
        assert_eq!(s(&f, "lc").as_deref(), Some("PIPSOL05"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGD"));

        for (key, vals) in [("CATPIP", vec![4i64]), ("PRODCT", vec![3])] {
            let f = derive(line("PIPSOL", &[(key, AttrValue::IntList(vals))]));
            assert_eq!(s(&f, "lc").as_deref(), Some("PIPSOL06"), "{key}");
            assert_eq!(s(&f, "bcol").as_deref(), Some("CHGRD"), "{key}");
        }
    }

    #[test]
    fn pipohd_rows() {
        let f = derive(line("PIPOHD", &[]));
        assert!(f.attr("lc").is_none());
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHGRD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(3)));
        assert_eq!(s(&f, "lsty").as_deref(), Some("sold"));

        let f = derive(line("PIPOHD", &[("CONRAD", AttrValue::Int(3))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("RACNSP01"));

        // PIPOHD's TE is always the VERCLR form, no VERCSA alternative
        let f = derive(line("PIPOHD", &[("VERCSA", AttrValue::Float(9.0))]));
        assert!(f.attr("txt").is_none());
        let f = derive(line("PIPOHD", &[("VERCLR", AttrValue::Float(9.0))]));
        assert_eq!(s(&f, "txt").as_deref(), Some("clr 9.0"));
    }

    #[test]
    fn other_classes_and_geometry_untouched() {
        assert!(derive(line("FAIRWY", &[])).attr("bcol").is_none());
        // point geometry of a cable class (shouldn't occur; line-only class)
        let pt = Feature::new(
            0,
            "CBLSUB".into(),
            BTreeMap::new(),
            Some(Geometry::Point(WorldXy::new(0, 0))),
        );
        assert!(derive(pt).attr("bcol").is_none());
    }
}
