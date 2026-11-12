// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! LNDMRK (landmark) point/area/line symbol derivation — a deliberately
//! partial port of `CS(LNDMRK01)`, sourced from chartsymbols.xml's
//! Simplified point table (RCID 31188-31225) plus Area/Line boundary rows.
//! Full per-CATLMK/FUNCTN rationale, rejected mappings, and provenance: see
//! docs/architecture/lndmrk-symbols.md.

use crate::model::{AttrValue, Cell, Feature, Geometry};

pub fn apply(cell: &mut Cell) {
    for f in &mut cell.features {
        if f.acronym != "LNDMRK" {
            continue;
        }
        let is_point = matches!(f.geometry, Some(Geometry::Point(_)));
        let is_area = matches!(f.geometry, Some(Geometry::Areas(_)));
        let is_line = matches!(f.geometry, Some(Geometry::Lines(_)));
        if !(is_point || is_area || is_line) {
            continue;
        }

        if is_point {
            let sym = point_sym(f);
            f.attributes
                .insert("sym".into(), AttrValue::Str(sym.into()));
        }

        if is_area || is_line {
            // RCID 32121-32124/32460-32463 (Area), 31838-31839 (Line): plain
            // `LS(SOLD,1,·)` boundary — CHBLK when CONVIS=1, else LANDF.
            let convis1 = f.attr("CONVIS").and_then(AttrValue::as_int) == Some(1);
            f.attributes.insert(
                "bcol".into(),
                AttrValue::Str(if convis1 { "CHBLK" } else { "LANDF" }.into()),
            );
            f.attributes.insert("bwid".into(), AttrValue::Int(1));
        }

        // RCID 32121/32122 (Area), 31192/31199 (Point): TX(OBJNAM) under
        // CATLMK=17+FUNCTN=33; Line rows (31838/31839) carry no TX at all.
        if is_point || is_area {
            let catlmk = f
                .attr("CATLMK")
                .and_then(AttrValue::as_int_list)
                .unwrap_or_default();
            let functn = f
                .attr("FUNCTN")
                .and_then(AttrValue::as_int_list)
                .unwrap_or_default();
            if catlmk.contains(&17) && functn.contains(&33) {
                if let Some(objnam) = f.attr("OBJNAM").and_then(AttrValue::as_str) {
                    let txt = objnam.to_string();
                    f.attributes.insert("txt".into(), AttrValue::Str(txt));
                }
            }
        }
    }
}

/// The genuine Point primitive's symbol pick. Never `None`: RCID 31224/31225
/// are unconditional catch-alls in the Simplified Point table, so every
/// LNDMRK point gets at least `POSGEN03`/`POSGEN01`.
fn point_sym(f: &Feature) -> &'static str {
    let convis1 = f.attr("CONVIS").and_then(AttrValue::as_int) == Some(1);
    let catlmk = f
        .attr("CATLMK")
        .and_then(AttrValue::as_int_list)
        .unwrap_or_default();
    let functn = f
        .attr("FUNCTN")
        .and_then(AttrValue::as_int_list)
        .unwrap_or_default();
    let has_catlmk = |v: i64| catlmk.contains(&v);
    let has_functn = |v: i64| functn.contains(&v);

    // RCID 31188-31200 family: church requires CATLMK in {15,17,20};
    // chapel (FUNCTN=21) exists ONLY with CONVIS=1 in this table, church
    // (FUNCTN=20) with or without. See docs/architecture/lndmrk-symbols.md.
    let church_catlmk = has_catlmk(15) || has_catlmk(17) || has_catlmk(20);
    if church_catlmk && (has_functn(20) || (has_functn(21) && convis1)) {
        return "church";
    }
    // RCID 31195/31196: the ONLY row either FUNCTN value has — stricter
    // than the church check above (CATLMK=20 AND CONVIS=1 both required).
    if has_catlmk(20) && convis1 && (has_functn(26) || has_functn(27)) {
        return "building"; // mosque/marabout; chartsymbols.xml BUIREL15
    }
    if has_catlmk(1) && convis1 {
        return "cairn-lmk";
    }
    if has_catlmk(3) {
        return "chimney";
    }
    if has_catlmk(4) && convis1 {
        return "dish_aerial";
    }
    if has_catlmk(5) && convis1 {
        return "flagstaff";
    }
    if has_catlmk(6) {
        return "flare-stack";
    }
    if has_catlmk(7) {
        return "mast";
    }
    if has_catlmk(9) && convis1 {
        return "monument";
    }
    if has_catlmk(10) && convis1 {
        return "column";
    }
    if has_catlmk(12) && convis1 {
        return "obelisk";
    }
    if has_catlmk(13) && convis1 {
        return "statue";
    }
    if has_catlmk(15) {
        return "dome";
    }
    if has_catlmk(16) {
        return "radar_scanner";
    }
    if has_catlmk(17) {
        return "tower-lmk";
    }
    if has_catlmk(18) && convis1 {
        return "windmill";
    }
    if has_catlmk(19) && convis1 {
        return "windmotor";
    }
    // RCID 31224/31225: the unconditional catch-alls — every LNDMRK point
    // gets a symbol, never nothing.
    if convis1 {
        "POSGEN03"
    } else {
        "POSGEN01"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::WorldXy;
    use std::collections::BTreeMap;

    fn feature(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(
            0,
            acronym.into(),
            map,
            Some(Geometry::Point(WorldXy::new(0, 0))),
        )
    }

    fn derive(f: Feature) -> Feature {
        let mut c = Cell {
            meta: crate::model::CellMeta::default(),
            extent: crate::coords::Extent::invalid(),
            features: vec![f],
        };
        apply(&mut c);
        c.features.remove(0)
    }

    fn s(f: &Feature, key: &str) -> Option<String> {
        f.attr(key).and_then(AttrValue::as_str).map(str::to_string)
    }

    #[test]
    fn catlmk_shape_symbols() {
        let cases: &[(i64, bool, &str)] = &[
            (1, true, "cairn-lmk"),
            (1, false, "POSGEN01"), // no non-CONVIS Simplified row for cairn
            (3, true, "chimney"),
            (3, false, "chimney"), // collapses CONVIS, like watertower
            (4, true, "dish_aerial"),
            (4, false, "POSGEN01"),
            (5, true, "flagstaff"),
            (5, false, "POSGEN01"),
            (6, true, "flare-stack"),
            (6, false, "flare-stack"),
            (7, true, "mast"),
            (7, false, "mast"),
            (9, true, "monument"),
            (9, false, "POSGEN01"),
            (10, true, "column"),
            (10, false, "POSGEN01"),
            (12, true, "obelisk"),
            (12, false, "POSGEN01"),
            (13, true, "statue"),
            (13, false, "POSGEN01"),
            (15, true, "dome"),
            (15, false, "dome"),
            (16, true, "radar_scanner"),
            (16, false, "radar_scanner"),
            (17, true, "tower-lmk"),
            (17, false, "tower-lmk"),
            (18, true, "windmill"),
            (18, false, "POSGEN01"),
            (19, true, "windmotor"),
            (19, false, "POSGEN01"),
        ];
        for (catlmk, convis1, want) in cases {
            let mut attrs = vec![("CATLMK", AttrValue::IntList(vec![*catlmk]))];
            if *convis1 {
                attrs.push(("CONVIS", AttrValue::Int(1)));
            }
            let f = derive(feature("LNDMRK", &attrs));
            assert_eq!(
                s(&f, "sym").as_deref(),
                Some(*want),
                "CATLMK={catlmk} CONVIS1={convis1}"
            );
        }
    }

    #[test]
    fn rejected_catlmk_values_fall_back_to_posgen() {
        // CATLMK=8 (windsock), 14 (cross), 20 (spire alone) — chartsymbols.xml
        // gives these no distinct pictograph (see module doc "Rejected"), but
        // all three still land on the unconditional CONVIS=1 catch-all
        // (RCID 31224 -> POSGEN03), whether via their own explicit row
        // (8, 20) or by falling through to the catch-all (14, which has no
        // row of its own at all).
        for catlmk in [8, 14, 20] {
            let f = derive(feature(
                "LNDMRK",
                &[
                    ("CATLMK", AttrValue::IntList(vec![catlmk])),
                    ("CONVIS", AttrValue::Int(1)),
                ],
            ));
            assert_eq!(s(&f, "sym").as_deref(), Some("POSGEN03"), "CATLMK={catlmk}");
        }
    }

    #[test]
    fn functn_church_requires_catlmk_15_17_or_20() {
        // FUNCTN=20 (church) draws regardless of CONVIS, for each of the
        // three CATLMK values chartsymbols.xml actually has a row for.
        for catlmk in [15, 17, 20] {
            for convis1 in [true, false] {
                let mut attrs = vec![
                    ("CATLMK", AttrValue::IntList(vec![catlmk])),
                    ("FUNCTN", AttrValue::IntList(vec![20])),
                ];
                if convis1 {
                    attrs.push(("CONVIS", AttrValue::Int(1)));
                }
                let f = derive(feature("LNDMRK", &attrs));
                assert_eq!(
                    s(&f, "sym").as_deref(),
                    Some("church"),
                    "FUNCTN=20 CATLMK={catlmk} CONVIS1={convis1}"
                );
            }
        }
        // FUNCTN=21 (chapel) draws ONLY with CONVIS=1 — no non-CONVIS
        // chapel row exists in the Simplified table at all.
        for catlmk in [15, 17, 20] {
            let f = derive(feature(
                "LNDMRK",
                &[
                    ("CATLMK", AttrValue::IntList(vec![catlmk])),
                    ("FUNCTN", AttrValue::IntList(vec![21])),
                    ("CONVIS", AttrValue::Int(1)),
                ],
            ));
            assert_eq!(s(&f, "sym").as_deref(), Some("church"), "CATLMK={catlmk}");
        }
    }

    #[test]
    fn functn_chapel_without_convis_does_not_match() {
        // No FUNCTN=21-without-CONVIS row exists anywhere in the table —
        // falls through to whatever CATLMK draws on its own.
        let f = derive(feature(
            "LNDMRK",
            &[
                ("CATLMK", AttrValue::IntList(vec![17])),
                ("FUNCTN", AttrValue::IntList(vec![21])),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("tower-lmk"));
    }

    #[test]
    fn functn_church_requires_matching_catlmk_not_just_any_shape() {
        // The bug this slice fixes: CATLMK=3 (chimney) + FUNCTN=20 has no
        // combined row in chartsymbols.xml — chimney is the actual best
        // match, not church.
        let f = derive(feature(
            "LNDMRK",
            &[
                ("CATLMK", AttrValue::IntList(vec![3])),
                ("FUNCTN", AttrValue::IntList(vec![20])),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("chimney"));

        // CATLMK=99 (unrecognised) + FUNCTN=20, CONVIS=1: falls all the way
        // to the generic conspicuous catch-all.
        let f = derive(feature(
            "LNDMRK",
            &[
                ("CATLMK", AttrValue::IntList(vec![99])),
                ("FUNCTN", AttrValue::IntList(vec![20])),
                ("CONVIS", AttrValue::Int(1)),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("POSGEN03"));
    }

    #[test]
    fn functn_mosque_marabout_requires_catlmk20_and_convis() {
        // RCID 31195/31196: CATLMK=20 AND CONVIS=1 both required — the only
        // row either FUNCTN value has, unlike the church check above (which
        // ignores CATLMK; see module doc for why mosque/marabout stays
        // strict).
        for functn in [26, 27] {
            let f = derive(feature(
                "LNDMRK",
                &[
                    ("CATLMK", AttrValue::IntList(vec![20])),
                    ("FUNCTN", AttrValue::IntList(vec![functn])),
                    ("CONVIS", AttrValue::Int(1)),
                ],
            ));
            assert_eq!(s(&f, "sym").as_deref(), Some("building"), "FUNCTN={functn}");
        }

        // Without CATLMK=20 the row never matches — falls through to
        // whatever CATLMK draws on its own (chimney here), not mosque.
        let f = derive(feature(
            "LNDMRK",
            &[
                ("CATLMK", AttrValue::IntList(vec![3])),
                ("FUNCTN", AttrValue::IntList(vec![26])),
                ("CONVIS", AttrValue::Int(1)),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("chimney"));

        // Without CONVIS=1, falls to the generic non-conspicuous default.
        let f = derive(feature(
            "LNDMRK",
            &[
                ("CATLMK", AttrValue::IntList(vec![20])),
                ("FUNCTN", AttrValue::IntList(vec![26])),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("POSGEN01"));
    }

    #[test]
    fn multi_valued_catlmk_matches_any_member() {
        // CATLMK is list-valued (S-57 code 35, "L") — a feature carrying
        // both a non-matching and a matching value must still match.
        let f = derive(feature(
            "LNDMRK",
            &[
                ("CATLMK", AttrValue::IntList(vec![2, 17])), // cemetery + tower
                ("CONVIS", AttrValue::Int(1)),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("tower-lmk"));
    }

    #[test]
    fn other_classes_untouched() {
        let f = derive(feature(
            "LNDRGN",
            &[("CATLMK", AttrValue::IntList(vec![17]))],
        ));
        assert!(f.attr("sym").is_none());
        assert!(f.attr("bcol").is_none());
    }

    #[test]
    fn no_catlmk_or_functn_falls_back_to_posgen() {
        let f = derive(feature("LNDMRK", &[("CONVIS", AttrValue::Int(1))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("POSGEN03"));

        let f = derive(feature("LNDMRK", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("POSGEN01"));
    }

    fn area(attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, "LNDMRK".into(), map, Some(Geometry::Areas(vec![])))
    }

    fn line(attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, "LNDMRK".into(), map, Some(Geometry::Lines(vec![])))
    }

    #[test]
    fn area_and_line_bake_boundary_never_sym() {
        // RCID 32121-32124/32460-32463 (Area) and 31838-31839 (Line): a
        // plain CONVIS-driven CHBLK/LANDF boundary, identical fact for both
        // geometries. Neither ever carries `SY()`.
        let f = derive(area(&[("CONVIS", AttrValue::Int(1))]));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHBLK"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));
        assert!(f.attr("sym").is_none());

        let f = derive(area(&[]));
        assert_eq!(s(&f, "bcol").as_deref(), Some("LANDF"));

        let f = derive(line(&[("CONVIS", AttrValue::Int(1))]));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHBLK"));
        assert!(f.attr("sym").is_none());

        let f = derive(line(&[]));
        assert_eq!(s(&f, "bcol").as_deref(), Some("LANDF"));
    }

    #[test]
    fn catlmk17_functn33_objnam_label_on_point_and_area_not_line() {
        // RCID 32121/32122 (Area) and 31192/31199 (genuine Point) both carry
        // `TX(OBJNAM,…)` under this exact condition; 31838/31839 (Line)
        // carry no `TX` at all.
        let attrs: &[(&str, AttrValue)] = &[
            ("CATLMK", AttrValue::IntList(vec![17])),
            ("FUNCTN", AttrValue::IntList(vec![33])),
            ("OBJNAM", AttrValue::Str("Kirknes Light".into())),
        ];

        let f = derive(feature("LNDMRK", attrs));
        assert_eq!(s(&f, "txt").as_deref(), Some("Kirknes Light"));
        assert_eq!(s(&f, "sym").as_deref(), Some("tower-lmk"));

        let f = derive(area(attrs));
        assert_eq!(s(&f, "txt").as_deref(), Some("Kirknes Light"));

        let f = derive(line(attrs));
        assert!(f.attr("txt").is_none(), "Line row carries no TX at all");
    }

    #[test]
    fn objnam_label_absent_without_catlmk17_functn33_or_objnam() {
        // Wrong CATLMK/FUNCTN combination: no label.
        let f = derive(feature(
            "LNDMRK",
            &[
                ("CATLMK", AttrValue::IntList(vec![3])),
                ("FUNCTN", AttrValue::IntList(vec![33])),
                ("OBJNAM", AttrValue::Str("Not A Tower".into())),
            ],
        ));
        assert!(f.attr("txt").is_none());

        // Right combination but no OBJNAM on the feature at all: nothing to
        // format, nothing baked.
        let f = derive(feature(
            "LNDMRK",
            &[
                ("CATLMK", AttrValue::IntList(vec![17])),
                ("FUNCTN", AttrValue::IntList(vec![33])),
            ],
        ));
        assert!(f.attr("txt").is_none());
    }
}
