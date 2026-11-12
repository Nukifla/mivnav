// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Industrial land structures: SILTNK (silo/tank) and PRDARE (production /
//! storage area) — a flat `findLUPrecord` row pick per class, same shape as
//! [`crate::derive::cables`]/[`crate::derive::tss`]/[`crate::derive::waterways`].
//! Full RCID trace, the CATSIL/CATPRA symbol tables, and the barrel-buoy
//! regression (jt wyzqklzz) are in docs/architecture/industrial-derive.md.

use crate::model::{AttrValue, Cell, Feature, Geometry};

pub fn apply(cell: &mut Cell) {
    for f in &mut cell.features {
        let is_area = matches!(f.geometry, Some(Geometry::Areas(_)));
        let is_point = matches!(f.geometry, Some(Geometry::Point(_)));
        let convis1 = f.attr("CONVIS").and_then(AttrValue::as_int) == Some(1);

        match (f.acronym.as_str(), is_area, is_point) {
            ("SILTNK", true, _) => {
                bake(f, None, if convis1 { "CHBLK" } else { "LANDF" });
            }
            ("SILTNK", _, true) => {
                let catsil = f.attr("CATSIL").and_then(AttrValue::as_int);
                // Old sheet's CONVIS pairs merge here (one vendored icon each,
                // port-map.json) except SILBUI11/01, which map to two
                // different icons, so CATSIL=1 keeps its CONVIS branch.
                let sym = match catsil {
                    Some(1) if convis1 => "watertower", // SILBUI11
                    Some(1) => "building",              // SILBUI01
                    Some(2) => "building",              // TNKCON12/02
                    Some(3) => "tower-lmk",             // TOWERS03/01
                    Some(4) => "watertower",            // CATSIL=4, either CONVIS branch
                    // no recognised CATSIL (RCID 31301) / no attribute at
                    // all (RCID 31302) — TNKCON12/02 again
                    _ => "building",
                };
                bake(f, Some(sym), "");
            }
            ("PRDARE", true, _) => {
                let catpra = f.attr("CATPRA").and_then(AttrValue::as_int);
                let (sym, bcol) = match catpra {
                    Some(5) if convis1 => (Some("flare-stack"), "CHBLK"),
                    Some(5) => (Some("flare-stack"), "LANDF"),
                    // TNKFRM11/01 — `barrel` here drew a barrel BUOY (see the
                    // module doc); `building` matches the TNKCON arms below.
                    Some(8) if convis1 => (Some("building"), "CHBLK"),
                    Some(8) => (Some("building"), "LANDF"),
                    Some(9) if convis1 => (Some("windmotor"), "CHBLK"),
                    Some(9) => (Some("windmotor"), "LANDF"),
                    Some(1) => (Some("QUARRY01"), "LANDF"),
                    Some(6) => (Some("TMBYRD01"), "LANDF"),
                    _ => (None, "LANDF"),
                };
                bake(f, sym, bcol);
            }
            ("PRDARE", _, true) => {
                let catpra = f.attr("CATPRA").and_then(AttrValue::as_int);
                let sym = match catpra {
                    Some(5) => Some("flare-stack"), // FLASTK11/01, either CONVIS branch
                    Some(8) => Some("building"),    // TNKCON12/02
                    Some(9) => Some("windmill"),    // WIMCON11/01
                    Some(6) => Some("TMBYRD01"),
                    Some(1 | 2 | 3 | 4 | 7 | 10) => Some("PRDINS02"),
                    _ => None, // no recognised CATPRA at all: no default (RCID 31271)
                };
                if let Some(sym) = sym {
                    f.attributes
                        .insert("sym".into(), AttrValue::Str(sym.into()));
                }
            }
            _ => {}
        }
    }
}

/// Bakes `sym` (optional) and `bcol`/`bwid` (every Area row here is a plain
/// `LS`). `bcol=""` is a sentinel used by Point-row arms (no boundary) so
/// they can share this helper without an `Option`; never passed for a real area row.
fn bake(f: &mut Feature, sym: Option<&'static str>, bcol: &'static str) {
    if let Some(sym) = sym {
        f.attributes
            .insert("sym".into(), AttrValue::Str(sym.into()));
    }
    if !bcol.is_empty() {
        f.attributes
            .insert("bcol".into(), AttrValue::Str(bcol.into()));
        f.attributes.insert("bwid".into(), AttrValue::Int(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::{CellMeta, Polygon};
    use std::collections::BTreeMap;

    fn feature(acronym: &str, geom: Geometry, attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, acronym.into(), map, Some(geom))
    }

    fn area(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        let ring = vec![
            WorldXy::new(0, 0),
            WorldXy::new(10, 0),
            WorldXy::new(10, 10),
            WorldXy::new(0, 10),
            WorldXy::new(0, 0),
        ];
        feature(
            acronym,
            Geometry::Areas(vec![Polygon {
                outer: ring,
                holes: vec![],
            }]),
            attrs,
        )
    }

    fn point(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        feature(acronym, Geometry::Point(WorldXy::new(0, 0)), attrs)
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
    fn siltnk_area_boundary() {
        let f = derive(area("SILTNK", &[("CONVIS", AttrValue::Int(1))]));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHBLK"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));
        assert!(f.attr("sym").is_none(), "no SY() on SILTNK's area row");

        let f = derive(area("SILTNK", &[]));
        assert_eq!(s(&f, "bcol").as_deref(), Some("LANDF"));
    }

    #[test]
    fn siltnk_point_sym() {
        let cases: &[(&[(&str, AttrValue)], &str)] = &[
            (
                &[("CATSIL", AttrValue::Int(1)), ("CONVIS", AttrValue::Int(1))],
                "watertower",
            ),
            (&[("CATSIL", AttrValue::Int(1))], "building"),
            (
                &[("CATSIL", AttrValue::Int(2)), ("CONVIS", AttrValue::Int(1))],
                "building",
            ),
            (&[("CATSIL", AttrValue::Int(2))], "building"),
            (
                &[("CATSIL", AttrValue::Int(3)), ("CONVIS", AttrValue::Int(1))],
                "tower-lmk",
            ),
            (&[("CATSIL", AttrValue::Int(3))], "tower-lmk"),
            (
                &[("CATSIL", AttrValue::Int(4)), ("CONVIS", AttrValue::Int(1))],
                "watertower",
            ),
            (&[("CATSIL", AttrValue::Int(4))], "watertower"),
            (&[("CONVIS", AttrValue::Int(1))], "building"),
            (&[], "building"),
        ];
        for (attrs, want) in cases {
            let f = derive(point("SILTNK", attrs));
            assert_eq!(s(&f, "sym").as_deref(), Some(*want), "{attrs:?}");
        }
    }

    #[test]
    fn prdare_area_sym_and_boundary() {
        let cases: &[(&[(&str, AttrValue)], Option<&str>, &str)] = &[
            (
                &[("CATPRA", AttrValue::Int(5)), ("CONVIS", AttrValue::Int(1))],
                Some("flare-stack"),
                "CHBLK",
            ),
            (
                &[("CATPRA", AttrValue::Int(5))],
                Some("flare-stack"),
                "LANDF",
            ),
            (
                &[("CATPRA", AttrValue::Int(8)), ("CONVIS", AttrValue::Int(1))],
                Some("building"),
                "CHBLK",
            ),
            (&[("CATPRA", AttrValue::Int(8))], Some("building"), "LANDF"),
            (
                &[("CATPRA", AttrValue::Int(9)), ("CONVIS", AttrValue::Int(1))],
                Some("windmotor"),
                "CHBLK",
            ),
            (&[("CATPRA", AttrValue::Int(9))], Some("windmotor"), "LANDF"),
            (
                &[("CATPRA", AttrValue::Int(1)), ("CONVIS", AttrValue::Int(1))],
                Some("QUARRY01"),
                "LANDF",
            ),
            (&[("CATPRA", AttrValue::Int(6))], Some("TMBYRD01"), "LANDF"),
            (&[("CATPRA", AttrValue::Int(2))], None, "LANDF"),
            (&[], None, "LANDF"),
        ];
        for (attrs, want_sym, want_bcol) in cases {
            let f = derive(area("PRDARE", attrs));
            assert_eq!(s(&f, "sym").as_deref(), *want_sym, "{attrs:?}");
            assert_eq!(s(&f, "bcol").as_deref(), Some(*want_bcol), "{attrs:?}");
            assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)), "{attrs:?}");
        }
    }

    #[test]
    fn prdare_point_sym() {
        let cases: &[(&[(&str, AttrValue)], Option<&str>)] = &[
            (
                &[("CATPRA", AttrValue::Int(5)), ("CONVIS", AttrValue::Int(1))],
                Some("flare-stack"),
            ),
            (&[("CATPRA", AttrValue::Int(5))], Some("flare-stack")),
            (
                &[("CATPRA", AttrValue::Int(8)), ("CONVIS", AttrValue::Int(1))],
                Some("building"),
            ),
            (&[("CATPRA", AttrValue::Int(8))], Some("building")),
            (
                &[("CATPRA", AttrValue::Int(9)), ("CONVIS", AttrValue::Int(1))],
                Some("windmill"),
            ),
            (&[("CATPRA", AttrValue::Int(9))], Some("windmill")),
            (&[("CATPRA", AttrValue::Int(6))], Some("TMBYRD01")),
            (&[("CATPRA", AttrValue::Int(1))], Some("PRDINS02")),
            (&[("CATPRA", AttrValue::Int(10))], Some("PRDINS02")),
            (&[], None), // RCID 31271: no unconditional default, unlike SILTNK
        ];
        for (attrs, want) in cases {
            let f = derive(point("PRDARE", attrs));
            assert_eq!(s(&f, "sym").as_deref(), *want, "{attrs:?}");
        }
    }

    #[test]
    fn other_classes_and_geometry_untouched() {
        assert!(derive(area("FAIRWY", &[])).attr("bcol").is_none());
        let line = feature(
            "SILTNK",
            Geometry::Lines(vec![vec![WorldXy::new(0, 0), WorldXy::new(1, 1)]]),
            &[],
        );
        assert!(derive(line).attr("bcol").is_none());
    }
}
