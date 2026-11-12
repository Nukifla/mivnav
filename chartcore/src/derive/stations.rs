// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Pilot, signal, rescue and radio-station point facilities: PILBOP, RSCSTA,
//! SISTAT, SISTAW, RDOCAL, RDOSTA — flat `findLUPrecord` row picks, the same
//! shape as [`crate::derive::cables`]/[`crate::derive::tss`]. See
//! docs/architecture/stations-derive.md for the per-class S-52 rationale
//! (the CATROS=10 data-slip repair, PILBOP/RDOCAL label deviations).

use crate::model::{AttrValue, Cell, Feature, Geometry};

/// Point-only classes with a constant symbol and no text.
const CONSTANT_SYM: &[(&str, &str)] = &[
    ("RSCSTA", "rescue"),
    ("SISTAT", "signal"),
    ("SISTAW", "signal"),
];

pub fn apply(cell: &mut Cell) {
    for f in &mut cell.features {
        let is_point = matches!(f.geometry, Some(Geometry::Point(_)));
        let is_line = matches!(f.geometry, Some(Geometry::Lines(_)));

        if is_point {
            if let Some((_, sym)) = CONSTANT_SYM.iter().find(|(cls, _)| *cls == f.acronym) {
                set_sym(f, sym);
                continue;
            }
        }

        match f.acronym.as_str() {
            "RDOSTA" if is_point => {
                set_sym(f, "radio-mast");
                if int_list(f, "CATROS").contains(&10) {
                    f.attributes
                        .insert("txt".into(), AttrValue::Str("DGPS".into()));
                }
            }
            // Symbol only, no `txt` — deliberate deviation, see
            // docs/architecture/stations-derive.md.
            "PILBOP" if is_point => set_sym(f, "pilot-boarding"),
            "RDOCAL" if is_point || is_line => {
                set_sym(f, rdocal_sym(f));
                if let Some(txt) = rdocal_txt(f) {
                    f.attributes.insert("txt".into(), AttrValue::Str(txt));
                }
                if is_line {
                    f.attributes
                        .insert("bcol".into(), AttrValue::Str("TRFCD".into()));
                    f.attributes.insert("bwid".into(), AttrValue::Int(1));
                    f.attributes
                        .insert("lsty".into(), AttrValue::Str("dash".into()));
                }
            }
            _ => {}
        }
    }
}

fn set_sym(f: &mut Feature, sym: &'static str) {
    f.attributes
        .insert("sym".into(), AttrValue::Str(sym.into()));
}

fn int_list(f: &Feature, key: &str) -> Vec<i64> {
    f.attr(key)
        .and_then(AttrValue::as_int_list)
        .unwrap_or_default()
}

/// `ORIENT` present AND a recognised `TRAFIC` value -> oriented RDOCAL02/03;
/// otherwise the unconditional `RCLDEF01` default (never `None` — RDOCAL
/// always draws something, unlike `restricted.rs`'s `fairway_sym`).
fn rdocal_sym(f: &Feature) -> &'static str {
    if f.attr("ORIENT").is_some() {
        match f.attr("TRAFIC").and_then(AttrValue::as_int) {
            // RDOCAL02/03 differ only in arrow direction; the vendored set
            // has one VHF icon, so both land on it and the frontend rotates
            // by ORIENT.
            Some(1) | Some(2) | Some(3) | Some(4) => return "VHF",
            _ => {}
        }
    }
    "RCLDEF01"
}

/// The side label: `OBJNAM` verbatim, or nothing. The `'ch %s','COMCHA'`
/// clause is deliberately NOT folded in — the style already draws that
/// number inside the symbol's circle (docs/architecture/stations-derive.md).
fn rdocal_txt(f: &Feature) -> Option<String> {
    f.attr("OBJNAM")
        .and_then(AttrValue::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::CellMeta;
    use std::collections::BTreeMap;

    fn feature(acronym: &str, geometry: Geometry, attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, acronym.into(), map, Some(geometry))
    }

    fn point(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        feature(acronym, Geometry::Point(WorldXy::new(0, 0)), attrs)
    }

    fn line(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        feature(
            acronym,
            Geometry::Lines(vec![vec![WorldXy::new(0, 0), WorldXy::new(1, 1)]]),
            attrs,
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
    fn constant_sym_classes() {
        let f = derive(point(
            "RSCSTA",
            &[("OBJNAM", AttrValue::Str("Volunteer Station".into()))],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("rescue"));
        assert!(f.attr("txt").is_none(), "RSCSTA never draws a TE/TX");

        let f = derive(point("SISTAT", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("signal"));
        assert!(f.attr("txt").is_none());

        let f = derive(point("SISTAW", &[]));
        assert_eq!(
            s(&f, "sym").as_deref(),
            Some("signal"),
            "same glyph as SISTAT"
        );
    }

    #[test]
    fn rdosta_catros() {
        let f = derive(point("RDOSTA", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("radio-mast"));
        assert_eq!(s(&f, "txt"), None);

        // the Paper row's `SY(RDOSTA02);TX('DGPS')`, not the Simplified row's
        // undefined `SY(DGPS01DRFSTA01)` — see the module doc
        let f = derive(point("RDOSTA", &[("CATROS", AttrValue::IntList(vec![10]))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("radio-mast"));
        assert_eq!(s(&f, "txt").as_deref(), Some("DGPS"));

        let f = derive(point("RDOSTA", &[("CATROS", AttrValue::IntList(vec![1]))]));
        assert_eq!(
            s(&f, "sym").as_deref(),
            Some("radio-mast"),
            "1 is not the DGPS category"
        );
        assert_eq!(s(&f, "txt"), None, "1 is not the DGPS category");
    }

    #[test]
    fn pilbop_point() {
        let f = derive(point("PILBOP", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("pilot-boarding"));
        assert!(f.attr("txt").is_none());

        // A NAMED one gets no label either: the `TE('Plt %s','OBJNAM',…)` half
        // of the S-52 row is deliberately not drawn (module doc, jt qqmoqkul).
        // OBJNAM itself is untouched, so the info panel still names it.
        let f = derive(point(
            "PILBOP",
            &[("OBJNAM", AttrValue::Str("Pilot Station".into()))],
        ));
        assert!(f.attr("txt").is_none());
        assert_eq!(s(&f, "OBJNAM").as_deref(), Some("Pilot Station"));
    }

    #[test]
    fn pilbop_area_untouched() {
        // Deferred to a future slice (module doc) — not this module's scope.
        let f = feature("PILBOP", Geometry::Areas(vec![]), &[]);
        let f = derive(f);
        assert!(f.attr("sym").is_none());
    }

    #[test]
    fn rdocal_oriented_vs_fallback() {
        let f = derive(point(
            "RDOCAL",
            &[
                ("ORIENT", AttrValue::Float(45.0)),
                ("TRAFIC", AttrValue::Int(2)),
                ("OBJNAM", AttrValue::Str("Rotterdam Port Control".into())),
                ("COMCHA", AttrValue::Str("16".into())),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("VHF"));
        // The side label is OBJNAM alone. COMCHA is NOT folded in: the style
        // draws it inside the symbol's circle, and baking it here too drew
        // the channel twice on every oriented calling-in point.
        assert_eq!(s(&f, "txt").as_deref(), Some("Rotterdam Port Control"));

        // A channel with no name leaves `txt` ABSENT, not empty — an empty
        // string would still lay out a halo box next to the symbol.
        let f = derive(point(
            "RDOCAL",
            &[
                ("ORIENT", AttrValue::Float(45.0)),
                ("TRAFIC", AttrValue::Int(4)),
                ("COMCHA", AttrValue::Str("74".into())),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("VHF"));
        assert!(f.attr("txt").is_none(), "COMCHA alone is not a side label");

        // No ORIENT at all -> unconditional fallback, COMCHA dropped even
        // though present.
        let f = derive(point(
            "RDOCAL",
            &[
                ("OBJNAM", AttrValue::Str("Calling Point".into())),
                ("COMCHA", AttrValue::Str("67".into())),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("RCLDEF01"));
        assert_eq!(
            s(&f, "txt").as_deref(),
            Some("Calling Point"),
            "fallback TE never names COMCHA"
        );

        // ORIENT present but unrecognised TRAFIC -> still the fallback.
        let f = derive(point(
            "RDOCAL",
            &[
                ("ORIENT", AttrValue::Float(10.0)),
                ("TRAFIC", AttrValue::Int(9)),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("RCLDEF01"));
    }

    #[test]
    fn rdocal_line_geometry() {
        let f = derive(line(
            "RDOCAL",
            &[
                ("ORIENT", AttrValue::Float(0.0)),
                ("TRAFIC", AttrValue::Int(1)),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("VHF"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("TRFCD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));

        // Point geometry never gets the line boundary facts.
        let f = derive(point("RDOCAL", &[]));
        assert!(f.attr("bcol").is_none());
    }

    #[test]
    fn other_classes_untouched() {
        assert!(derive(point("FAIRWY", &[])).attr("sym").is_none());
        assert!(
            derive(line("RSCSTA", &[])).attr("sym").is_none(),
            "RSCSTA is Point-only"
        );
    }
}
