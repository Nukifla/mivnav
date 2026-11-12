// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Restricted / cautionary area group (specs-12.md §1.4): RESARE, ACHARE,
//! CTNARE, MIPARE, DMPGRD, CBLARE, PIPARE, TSSCRS, TSSRON, TSSLPT, ISTZNE,
//! PRCARE, FAIRWY, MARCUL, CTSARE, FERYRT, PILBOP (area half). All
//! settings-independent — the per-class LUP rows and the RESARE02/RESTRN01
//! conditional trees (`S52CondRules.cpp:1353-1533, 1535-1611`) resolve
//! entirely from chart attributes, baking to a shared `Group` schema: `sym`
//! (centred point symbol), `sym_cs` (second symbol RESTRN01 stacks on top),
//! `lc` (S-52 complex linestyle — Phase 5 degrades to a plain dash
//! client-side), `bcol`/`bwid` (boundary), `dpri` (display priority,
//! honouring RESARE02's `OP(6---)` escalation the reference parser drops —
//! divergence D4).
//!
//! `sym`/`sym_cs` and `lc` are two DIFFERENT namespaces that happen to share
//! spellings (`CTYARE51` names both a centred symbol and a dashed
//! boundary) — every `sym`/`sym_cs` is a vendored icon name
//! (`icons::resolve`, `port-map.json`); every `lc` is still the old
//! chartsymbols.xml token (patterns have no pivot, a separate migration).
//!
//! Divergences: D5 anchoring-restricted areas get `lc=ACHRES51` (reference:
//! RESARE51); D8 CATREA 27/28 emit no `sym`. Full per-class RCID provenance,
//! the FAIRWY/MARCUL/CTSARE/FERYRT/PILBOP reasoning, and why each vendored
//! icon was (or wasn't) chosen: docs/architecture/restricted-areas-derive.md.

use crate::model::{AttrValue, Cell, Feature, Geometry};

#[derive(Debug, PartialEq)]
struct Group {
    sym: Option<&'static str>,
    sym_cs: Option<&'static str>,
    lc: Option<&'static str>,
    bcol: Option<&'static str>,
    bwid: Option<i64>,
    dpri: i64,
}

pub fn apply(cell: &mut Cell) {
    for f in &mut cell.features {
        let is_area = matches!(f.geometry, Some(Geometry::Areas(_)));
        let is_point = matches!(f.geometry, Some(Geometry::Point(_)));
        let int_list = |key: &str| -> Vec<i64> {
            f.attr(key)
                .and_then(AttrValue::as_int_list)
                .unwrap_or_default()
        };
        let restrn = f.attr("RESTRN").map(|_| int_list("RESTRN"));

        let g = match (f.acronym.as_str(), is_area, is_point) {
            ("RESARE", true, _) => {
                let catrea = int_list("CATREA");
                if catrea == [27] || catrea == [28] {
                    // ecological/particularly-sensitive sea area rows: pure
                    // LC(ESSARE01) boundaries, no centred symbol (D8)
                    Group {
                        sym: None,
                        sym_cs: None,
                        lc: Some("ESSARE01"),
                        bcol: Some("CHMGD"),
                        bwid: Some(2),
                        dpri: 5,
                    }
                } else {
                    let (sym, lc, dpri) = resare02(restrn.as_deref(), &catrea);
                    Group {
                        sym: Some(sym),
                        sym_cs: None,
                        lc: Some(lc),
                        bcol: Some("CHMGD"),
                        bwid: Some(2),
                        dpri,
                    }
                }
            }
            ("ACHARE", true, _) => {
                if f.attr("CATACH").and_then(AttrValue::as_int) == Some(8) {
                    Group {
                        sym: Some("anchor"),
                        sym_cs: restrn01(restrn.as_deref()),
                        lc: None, // dashed in both boundary tables
                        bcol: Some("CHMGF"),
                        bwid: Some(2),
                        dpri: 3,
                    }
                } else {
                    let (sym_cs, lc, dpri) = resare02(restrn.as_deref(), &int_list("CATREA"));
                    Group {
                        sym: Some("anchor"),
                        sym_cs: Some(sym_cs),
                        lc: Some(lc),
                        bcol: Some("CHMGD"),
                        bwid: Some(2),
                        dpri,
                    }
                }
            }
            ("ACHARE", _, true) => point_sym("anchor", 6),
            ("CTNARE", true, _) => Group {
                sym: Some("caution"),
                sym_cs: None,
                lc: Some("CTNARE51"),
                bcol: Some("TRFCD"),
                bwid: Some(2),
                dpri: 3,
            },
            ("CTNARE", _, true) => point_sym("notice-board", 4),
            ("MIPARE", true, _) => Group {
                sym: Some("caution"),
                sym_cs: restrn01(restrn.as_deref()),
                lc: Some("CTYARE51"),
                bcol: Some("CHMGD"),
                bwid: Some(2),
                dpri: 4,
            },
            ("MIPARE", _, true) => point_sym("notice-board", 4),
            ("DMPGRD", true, _) => {
                let catdpg5 = f.attr("CATDPG").and_then(AttrValue::as_int) == Some(5);
                Group {
                    sym: (!catdpg5).then_some("notice-board"),
                    sym_cs: restrn01(restrn.as_deref()),
                    lc: Some(if catdpg5 { "NAVARE51" } else { "CTYARE51" }),
                    bcol: Some("CHMGD"),
                    bwid: Some(1),
                    dpri: 3,
                }
            }
            ("DMPGRD", _, true) => point_sym("notice-board", 4),
            ("CBLARE", true, _) => Group {
                sym: Some("flash"),
                sym_cs: restrn01(restrn.as_deref()),
                lc: Some("CBLARE51"),
                bcol: Some("CHMGD"),
                bwid: Some(2),
                dpri: 3,
            },
            ("PIPARE", true, _) => {
                let benign = int_list("CATPIP").iter().any(|c| [2, 3, 4, 5].contains(c))
                    || int_list("PRODCT").contains(&3);
                Group {
                    sym: Some("notice-board"),
                    sym_cs: restrn01(restrn.as_deref()),
                    lc: Some(if benign { "PIPARE61" } else { "PIPARE51" }),
                    bcol: Some(if benign { "CHGRD" } else { "CHMGD" }),
                    bwid: Some(2),
                    dpri: 3,
                }
            }
            ("PIPARE", _, true) => point_sym("notice-board", 4),
            // PILBOP (module doc above): Area half only — the genuine Point
            // half lives in derive::stations, not touched here. No CS()
            // call at all, same flat-pick shape as CTSARE.
            ("PILBOP", true, _) => Group {
                sym: Some("pilot-boarding"),
                sym_cs: None, // no CS() call at all
                lc: Some("CTYARE51"),
                bcol: Some("TRFCF"),
                bwid: Some(2),
                dpri: 3,
            },
            // Traffic routes group (polygon classes): all CS(RESTRN01), none
            // branches on a chart attribute (see module doc). TSSCRS/TSSRON
            // have no boundary row at all (AP(TSSJCT02) pattern fill
            // deferred, no LC/LS) — sym/sym_cs only.
            ("TSSCRS", true, _) => Group {
                sym: Some("TSSCRS51"),
                sym_cs: restrn01(restrn.as_deref()),
                lc: None,
                bcol: None,
                bwid: None,
                dpri: 3,
            },
            ("TSSRON", true, _) => Group {
                sym: Some("TSSRON51"),
                sym_cs: restrn01(restrn.as_deref()),
                lc: None,
                bcol: None,
                bwid: None,
                dpri: 3,
            },
            // TSSLPT: two-way ORIENT branch (module doc) — the `txt` half
            // (INFORM, no-ORIENT branch only) is set below, after this match,
            // since Group carries no `txt` field for any other class.
            ("TSSLPT", true, _) => Group {
                sym: Some(if f.attr("ORIENT").is_some() {
                    // Real vendored icon (module doc above), not the old
                    // chartsymbols.xml TSSLPT51 token.
                    "TSS-arrow"
                } else {
                    "caution"
                }),
                sym_cs: restrn01(restrn.as_deref()),
                lc: None,
                bcol: None,
                bwid: None,
                dpri: 3,
            },
            ("ISTZNE", true, _) => Group {
                sym: Some("ITZARE51"),
                sym_cs: restrn01(restrn.as_deref()),
                lc: Some("RESARE51"), // Symbolized row's named token (D5-style pick)
                bcol: Some("TRFCD"),
                bwid: Some(1),
                dpri: 3,
            },
            ("PRCARE", true, _) => Group {
                sym: Some("caution"),
                sym_cs: restrn01(restrn.as_deref()),
                lc: Some("PRCARE51"),
                bcol: Some("TRFCD"),
                bwid: Some(2),
                dpri: 3,
            },
            ("PRCARE", _, true) => point_sym("caution", 4),
            // FAIRWY/MARCUL/CTSARE/FERYRT: this task's own slice (module doc
            // above has the full RCID/attribute reasoning).
            ("FAIRWY", true, _) => Group {
                sym: fairway_sym(f),
                sym_cs: restrn01(restrn.as_deref()),
                lc: Some("NAVARE51"),
                bcol: Some("CHGRD"),
                bwid: Some(1),
                dpri: 3,
            },
            ("MARCUL", true, _) => Group {
                sym: None, // AP(MARCUL02) pattern fill deferred, no separate SY()
                sym_cs: restrn01(restrn.as_deref()),
                lc: Some("NAVARE51"),
                bcol: Some("CHGRD"),
                bwid: Some(1),
                dpri: 3,
            },
            // Real vendored icon (module doc above), not the old sheet's
            // MARCUL02 token.
            ("MARCUL", _, true) => point_sym("marine-farm", 4),
            ("CTSARE", true, _) => Group {
                sym: Some("notice-board"),
                sym_cs: None, // no CS() call at all
                lc: Some("CTYARE51"),
                bcol: Some("CHMGF"),
                bwid: Some(1),
                dpri: 3,
            },
            ("CTSARE", _, true) => point_sym("notice-board", 4),
            ("FERYRT", true, _) => {
                let catfry2 = f.attr("CATFRY").and_then(AttrValue::as_int) == Some(2);
                Group {
                    // Real vendored icon (module doc above), constant
                    // regardless of branch — FRYARE51/52 differ only by
                    // colour in the old sheet, which the boundary carries.
                    sym: Some("ferry"),
                    sym_cs: None, // no CS() call at all
                    lc: Some("NAVARE51"),
                    bcol: Some(if catfry2 { "CHBLK" } else { "CHMGD" }),
                    bwid: Some(2),
                    dpri: 3,
                }
            }
            _ => continue,
        };

        // TSSLPT's INFORM caption: only the no-ORIENT (CTNARE51-fallback)
        // branch draws it (`TX(INFORM,...)`, chartsymbols.xml RCID 32236).
        if f.acronym == "TSSLPT" && f.attr("ORIENT").is_none() {
            if let Some(inform) = f.attr("INFORM").and_then(AttrValue::as_str) {
                f.attributes
                    .insert("txt".into(), AttrValue::Str(inform.to_string()));
            }
        }

        if let Some(sym) = g.sym {
            f.attributes
                .insert("sym".into(), AttrValue::Str(sym.into()));
        }
        if let Some(sym_cs) = g.sym_cs {
            f.attributes
                .insert("sym_cs".into(), AttrValue::Str(sym_cs.into()));
        }
        if let Some(lc) = g.lc {
            f.attributes.insert("lc".into(), AttrValue::Str(lc.into()));
        }
        if let Some(bcol) = g.bcol {
            f.attributes
                .insert("bcol".into(), AttrValue::Str(bcol.into()));
        }
        if let Some(bwid) = g.bwid {
            f.attributes.insert("bwid".into(), AttrValue::Int(bwid));
        }
        f.attributes.insert("dpri".into(), AttrValue::Int(g.dpri));
    }
}

/// FAIRWY's `sym` pick (module doc has the full RCID/attrib-code reasoning):
/// needs `ORIENT` present AND a recognised `TRAFIC` value, else `None`.
fn fairway_sym(f: &Feature) -> Option<&'static str> {
    if f.attr("ORIENT").is_none() {
        return None;
    }
    match f.attr("TRAFIC").and_then(AttrValue::as_int) {
        Some(1) | Some(2) | Some(3) => Some("FAIRWY51"),
        Some(4) => Some("FAIRWY52"),
        _ => None,
    }
}

fn point_sym(sym: &'static str, dpri: i64) -> Group {
    Group {
        sym: Some(sym),
        sym_cs: None,
        lc: None,
        bcol: None,
        bwid: None,
        dpri,
    }
}

/// RESARE02 (S52CondRules.cpp:1382-1532) → (sym, lc, dpri). `restrn`: `None`
/// = attribute absent (Continuation D), `Some` = the exploded list (possibly
/// empty, behaving like "only unknown values"). `sym` is a vendored icon
/// name, `lc` still a chartsymbols.xml token — see the module doc and
/// docs/architecture/restricted-areas-derive.md for the icon-merging rationale.
fn resare02(restrn: Option<&[i64]>, catrea: &[i64]) -> (&'static str, &'static str, i64) {
    let crea_c = catrea
        .iter()
        .any(|c| [1, 8, 9, 12, 14, 19, 21, 25].contains(c));
    let Some(restrn) = restrn else {
        // Continuation D: no RESTRN, classify by CATREA alone.
        // creaC&&creaI = CTYARE71, creaC = CTYARE51 (both `caution`);
        // creaI = INFARE51, neither = RSRDEF51 (both `notice-board`).
        let sym = if crea_c { "caution" } else { "notice-board" };
        return (sym, "CTYARE51", 5);
    };
    let has = |vals: &[i64]| restrn.iter().any(|r| vals.contains(r));
    let entry = has(&[7, 8, 14]);
    let anchor = has(&[1, 2]);
    let fish = has(&[3, 4, 5, 6]);
    let other = has(&[9, 10, 11, 12, 13]);
    if entry {
        // ENTRES61 / ENTRES71 / ENTRES51 — all `no-entry`
        ("no-entry", "RESARE51", 6) // OP(6---) honoured (D4)
    } else if anchor {
        // ACHRES61/71 and the bare RESTRN51 arm are all `no-anchor` now —
        // matches restrn01's arm (lppokvtq). See restricted-areas-derive.md.
        ("no-anchor", "ACHRES51", 6) // D5: ACHRES51, not the reference's RESARE51
    } else if fish {
        // FSHRES51 (creaC and default arms, reference verbatim) / FSHRES71
        // — all `no-fishing`
        ("no-fishing", "FSHRES51", 6)
    } else if other {
        ("notice-board", "CTYARE51", 5) // INFARE51
    } else {
        // RESTRN present but only unknown values (RSRDEF51)
        ("notice-board", "CTYARE51", 5)
    }
}

/// RESTRN01 (S52CondRules.cpp:1535-1611) → the stacked `sym_cs`, `None`
/// when RESTRN is absent. Vendored icon names, with the same arm merging
/// (and the same reasoning) as [`resare02`] above.
fn restrn01(restrn: Option<&[i64]>) -> Option<&'static str> {
    let restrn = restrn?;
    let has = |vals: &[i64]| restrn.iter().any(|r| vals.contains(r));
    let (entry, anchor) = (has(&[7, 8, 14]), has(&[1, 2]));
    let (fish, other) = (has(&[3, 4, 5, 6]), has(&[9, 10, 11, 12, 13]));
    Some(if entry {
        "no-entry" // ENTRES61 / ENTRES71 / ENTRES51
    } else if anchor {
        // ACHRES61 / ACHRES71 / ACHRES51 — every arm, bare one included, and
        // since lppokvtq RESARE02's matching arm agrees
        "no-anchor"
    } else if fish {
        "no-fishing" // FSHRES71 / FSHRES51
    } else if other {
        "notice-board" // INFARE51
    } else {
        "notice-board" // RSRDEF51
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::{CellMeta, Feature, Polygon};
    use std::collections::BTreeMap;

    fn area(acronym: &str, attrs: &[(&str, AttrValue)]) -> Feature {
        let ring = vec![
            WorldXy::new(0, 0),
            WorldXy::new(10, 0),
            WorldXy::new(10, 10),
            WorldXy::new(0, 10),
            WorldXy::new(0, 0),
        ];
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(
            0,
            acronym.into(),
            map,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring,
                holes: vec![],
            }])),
        )
    }

    fn point(acronym: &str) -> Feature {
        Feature::new(
            0,
            acronym.into(),
            BTreeMap::new(),
            Some(Geometry::Point(WorldXy::new(0, 0))),
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

    fn restrn(vals: &[i64]) -> (&'static str, AttrValue) {
        ("RESTRN", AttrValue::IntList(vals.to_vec()))
    }

    fn catrea(vals: &[i64]) -> (&'static str, AttrValue) {
        ("CATREA", AttrValue::IntList(vals.to_vec()))
    }

    #[test]
    fn resare02_tree() {
        // (restrn, catrea) -> (sym, lc, dpri)
        let cases: &[(Option<&[i64]>, &[i64], (&str, &str, i64))] = &[
            (Some(&[7]), &[], ("no-entry", "RESARE51", 6)),
            (Some(&[8, 1]), &[], ("no-entry", "RESARE51", 6)),
            (Some(&[14]), &[9], ("no-entry", "RESARE51", 6)), // creaC
            (Some(&[7]), &[10], ("no-entry", "RESARE51", 6)), // creaI
            (Some(&[7, 9]), &[], ("no-entry", "RESARE51", 6)), // other
            (Some(&[1]), &[], ("no-anchor", "ACHRES51", 6)),  // the bare arm
            (Some(&[2, 3]), &[], ("no-anchor", "ACHRES51", 6)),
            (Some(&[1]), &[1], ("no-anchor", "ACHRES51", 6)),
            (Some(&[2, 12]), &[], ("no-anchor", "ACHRES51", 6)),
            (Some(&[3]), &[], ("no-fishing", "FSHRES51", 6)),
            (Some(&[4]), &[8], ("no-fishing", "FSHRES51", 6)), // creaC arm (verbatim)
            (Some(&[5, 13]), &[], ("no-fishing", "FSHRES51", 6)),
            (Some(&[6]), &[4], ("no-fishing", "FSHRES51", 6)), // creaI
            (Some(&[9]), &[], ("notice-board", "CTYARE51", 5)),
            (Some(&[99]), &[], ("notice-board", "CTYARE51", 5)), // unknown values only
            (Some(&[]), &[], ("notice-board", "CTYARE51", 5)),   // present but empty
            (None, &[], ("notice-board", "CTYARE51", 5)),        // Continuation D
            (None, &[1], ("caution", "CTYARE51", 5)),
            (None, &[4], ("notice-board", "CTYARE51", 5)),
            (None, &[1, 4], ("caution", "CTYARE51", 5)),
        ];
        for (restrn, catrea, expect) in cases {
            assert_eq!(
                resare02(*restrn, catrea),
                *expect,
                "restrn {restrn:?} catrea {catrea:?}"
            );
        }
    }

    #[test]
    fn restrn01_tree() {
        assert_eq!(restrn01(None), None);
        let cases: &[(&[i64], &str)] = &[
            (&[7], "no-entry"),
            (&[7, 1], "no-entry"),
            (&[7, 3], "no-entry"),
            (&[7, 9], "no-entry"),
            (&[1], "no-anchor"), // ACHRES51 here, unlike RESARE02
            (&[1, 4], "no-anchor"),
            (&[2, 10], "no-anchor"),
            (&[3], "no-fishing"),
            (&[3, 11], "no-fishing"),
            (&[12], "notice-board"),
            (&[99], "notice-board"),
        ];
        for (restrn, expect) in cases {
            assert_eq!(restrn01(Some(restrn)), Some(*expect), "restrn {restrn:?}");
        }
    }

    #[test]
    fn resare_rows() {
        let f = derive(area("RESARE", &[restrn(&[8])]));
        assert_eq!(s(&f, "sym").as_deref(), Some("no-entry"));
        assert_eq!(s(&f, "lc").as_deref(), Some("RESARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(2)));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(6)));
        // CATREA 27/28: LC-only rows, no centred symbol (D8)
        for c in [27, 28] {
            let f = derive(area("RESARE", &[catrea(&[c])]));
            assert!(f.attr("sym").is_none(), "CATREA {c}");
            assert_eq!(s(&f, "lc").as_deref(), Some("ESSARE01"));
            assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(5)));
        }
        // a CATREA *list* containing 27 is not the exact "27" row
        let f = derive(area("RESARE", &[catrea(&[27, 1]), restrn(&[1])]));
        assert_eq!(s(&f, "sym").as_deref(), Some("no-anchor")); // 27 not in creaC/creaI
    }

    #[test]
    fn achare_rows() {
        let f = derive(point("ACHARE"));
        assert_eq!(s(&f, "sym").as_deref(), Some("anchor"));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(6)));
        assert!(f.attr("bcol").is_none());

        let f = derive(area(
            "ACHARE",
            &[("CATACH", AttrValue::Int(8)), restrn(&[1])],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("anchor"));
        assert_eq!(s(&f, "sym_cs").as_deref(), Some("no-anchor"));
        assert!(f.attr("lc").is_none());
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGF"));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(3)));

        let f = derive(area("ACHARE", &[restrn(&[1])]));
        assert_eq!(s(&f, "sym").as_deref(), Some("anchor"));
        assert_eq!(s(&f, "sym_cs").as_deref(), Some("no-anchor")); // via RESARE02
        assert_eq!(s(&f, "lc").as_deref(), Some("ACHRES51"));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(6)));
    }

    #[test]
    fn ctnare_mipare_dmpgrd_rows() {
        let f = derive(area("CTNARE", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("caution"));
        assert_eq!(s(&f, "lc").as_deref(), Some("CTNARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("TRFCD"));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(3)));
        assert_eq!(
            s(&derive(point("CTNARE")), "sym").as_deref(),
            Some("notice-board")
        );

        let f = derive(area("MIPARE", &[restrn(&[7])]));
        assert_eq!(s(&f, "sym").as_deref(), Some("caution"));
        assert_eq!(s(&f, "sym_cs").as_deref(), Some("no-entry"));
        assert_eq!(s(&f, "lc").as_deref(), Some("CTYARE51"));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(4)));
        // no RESTRN -> RESTRN01 contributes nothing
        assert!(derive(area("MIPARE", &[])).attr("sym_cs").is_none());

        let f = derive(area("DMPGRD", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("notice-board"));
        assert_eq!(s(&f, "lc").as_deref(), Some("CTYARE51"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));
        let f = derive(area("DMPGRD", &[("CATDPG", AttrValue::Int(5))]));
        assert!(f.attr("sym").is_none());
        assert_eq!(s(&f, "lc").as_deref(), Some("NAVARE51"));
        assert_eq!(
            s(&derive(point("DMPGRD")), "sym").as_deref(),
            Some("notice-board")
        );
    }

    #[test]
    fn cblare_pipare_rows() {
        let f = derive(area("CBLARE", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("flash"));
        assert_eq!(s(&f, "lc").as_deref(), Some("CBLARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(2)));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(3)));
        assert!(f.attr("sym_cs").is_none());
        let f = derive(area("CBLARE", &[restrn(&[3])]));
        assert_eq!(s(&f, "sym_cs").as_deref(), Some("no-fishing"));

        // default (no CATPIP/PRODCT): "potentially dangerous", magenta PIPARE51
        let f = derive(area("PIPARE", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("notice-board"));
        assert_eq!(s(&f, "lc").as_deref(), Some("PIPARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGD"));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(3)));
        // a named benign product category: "generally non-dangerous", grey PIPARE61
        for (key, vals) in [("CATPIP", vec![3i64]), ("PRODCT", vec![3])] {
            let f = derive(area("PIPARE", &[(key, AttrValue::IntList(vals))]));
            assert_eq!(s(&f, "lc").as_deref(), Some("PIPARE61"), "{key}");
            assert_eq!(s(&f, "bcol").as_deref(), Some("CHGRD"), "{key}");
        }
        assert_eq!(
            s(&derive(point("PIPARE")), "sym").as_deref(),
            Some("notice-board")
        );
    }

    #[test]
    fn traffic_routes_rows() {
        // TSSCRS/TSSRON: sym + sym_cs only, no boundary (AP() fill deferred)
        let f = derive(area("TSSCRS", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("TSSCRS51"));
        assert!(f.attr("lc").is_none());
        assert!(f.attr("bcol").is_none());
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(3)));
        let f = derive(area("TSSRON", &[restrn(&[7])]));
        assert_eq!(s(&f, "sym").as_deref(), Some("TSSRON51"));
        assert_eq!(s(&f, "sym_cs").as_deref(), Some("no-entry"));

        // TSSLPT: ORIENT present -> oriented arrow (real vendored icon), no
        // INFORM caption
        let f = derive(area("TSSLPT", &[("ORIENT", AttrValue::Float(90.0))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("TSS-arrow"));
        assert!(f.attr("txt").is_none());
        // no ORIENT -> generic-caution fallback + INFORM caption when present
        let f = derive(area("TSSLPT", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("caution"));
        assert!(f.attr("txt").is_none());
        let f = derive(area(
            "TSSLPT",
            &[("INFORM", AttrValue::Str("caution".into()))],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("caution"));
        assert_eq!(s(&f, "txt").as_deref(), Some("caution"));
        // both present: ORIENT wins, INFORM is not drawn (matches the
        // no-ORIENT-only TX(INFORM,...) row)
        let f = derive(area(
            "TSSLPT",
            &[
                ("ORIENT", AttrValue::Float(45.0)),
                ("INFORM", AttrValue::Str("caution".into())),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("TSS-arrow"));
        assert!(f.attr("txt").is_none());

        // ISTZNE/PRCARE: sym + sym_cs + boundary
        let f = derive(area("ISTZNE", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("ITZARE51"));
        assert_eq!(s(&f, "lc").as_deref(), Some("RESARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("TRFCD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));

        let f = derive(area("PRCARE", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("caution"));
        assert_eq!(s(&f, "lc").as_deref(), Some("PRCARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("TRFCD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(2)));
        assert_eq!(
            s(&derive(point("PRCARE")), "sym").as_deref(),
            Some("caution")
        );
        assert_eq!(
            derive(point("PRCARE")).attr("dpri"),
            Some(&AttrValue::Int(4))
        );
    }

    #[test]
    fn fairway_marcul_ctsare_feryrt_rows() {
        // FAIRWY: needs ORIENT present AND a recognised TRAFIC value for a sym
        let f = derive(area("FAIRWY", &[]));
        assert!(
            f.attr("sym").is_none(),
            "no ORIENT, no TRAFIC -> boundary only"
        );
        assert_eq!(s(&f, "lc").as_deref(), Some("NAVARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHGRD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(3)));
        for t in [1, 2, 3] {
            let f = derive(area(
                "FAIRWY",
                &[
                    ("ORIENT", AttrValue::Float(90.0)),
                    ("TRAFIC", AttrValue::Int(t)),
                ],
            ));
            assert_eq!(s(&f, "sym").as_deref(), Some("FAIRWY51"), "TRAFIC {t}");
        }
        let f = derive(area(
            "FAIRWY",
            &[
                ("ORIENT", AttrValue::Float(90.0)),
                ("TRAFIC", AttrValue::Int(4)),
            ],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("FAIRWY52"));
        // ORIENT absent -> no sym even with a recognised TRAFIC
        let f = derive(area("FAIRWY", &[("TRAFIC", AttrValue::Int(1))]));
        assert!(f.attr("sym").is_none());
        let f = derive(area("FAIRWY", &[restrn(&[3])]));
        assert_eq!(s(&f, "sym_cs").as_deref(), Some("no-fishing"));

        // MARCUL: AP() pattern fill deferred -> sym always None on the area row
        let f = derive(area("MARCUL", &[]));
        assert!(f.attr("sym").is_none());
        assert_eq!(s(&f, "lc").as_deref(), Some("NAVARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHGRD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));
        let f = derive(area("MARCUL", &[restrn(&[7])]));
        assert_eq!(s(&f, "sym_cs").as_deref(), Some("no-entry"));
        assert_eq!(
            s(&derive(point("MARCUL")), "sym").as_deref(),
            Some("marine-farm")
        );
        assert_eq!(
            derive(point("MARCUL")).attr("dpri"),
            Some(&AttrValue::Int(4))
        );

        // CTSARE: flat pick, no CS() call at all
        let f = derive(area("CTSARE", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("notice-board"));
        assert!(f.attr("sym_cs").is_none());
        assert_eq!(s(&f, "lc").as_deref(), Some("CTYARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGF"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(1)));
        // RESTRN present is irrelevant: no CS() call reads it
        let f = derive(area("CTSARE", &[restrn(&[1])]));
        assert!(f.attr("sym_cs").is_none());
        assert_eq!(
            s(&derive(point("CTSARE")), "sym").as_deref(),
            Some("notice-board")
        );

        // FERYRT: CATFRY branch, no CS() call, no Point row. `sym` is the
        // constant vendored "ferry" regardless of branch (module doc); only
        // the boundary colour tracks CATFRY.
        let f = derive(area("FERYRT", &[]));
        assert_eq!(
            s(&f, "sym").as_deref(),
            Some("ferry"),
            "no CATFRY -> fallback"
        );
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGD"));
        let f = derive(area("FERYRT", &[("CATFRY", AttrValue::Int(1))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("ferry"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHMGD"));
        let f = derive(area("FERYRT", &[("CATFRY", AttrValue::Int(2))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("ferry"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("CHBLK"));
        assert_eq!(s(&f, "lc").as_deref(), Some("NAVARE51"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(2)));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(3)));
    }

    #[test]
    fn pilbop_area_row() {
        // Area half only — no CS() call, unconditional pick.
        let f = derive(area("PILBOP", &[]));
        assert_eq!(s(&f, "sym").as_deref(), Some("pilot-boarding"));
        assert!(f.attr("sym_cs").is_none());
        assert_eq!(s(&f, "lc").as_deref(), Some("CTYARE51"));
        assert_eq!(s(&f, "bcol").as_deref(), Some("TRFCF"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(2)));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(3)));
        // RESTRN present is irrelevant: no CS() call reads it (same as CTSARE)
        let f = derive(area("PILBOP", &[restrn(&[1])]));
        assert!(f.attr("sym_cs").is_none());
        // Point geometry is untouched here — derive::stations owns it.
        assert!(derive(point("PILBOP")).attr("dpri").is_none());
    }

    #[test]
    fn other_classes_untouched() {
        let f = derive(area("FAIRWY", &[restrn(&[1])]));
        assert!(f.attr("dpri").is_some(), "FAIRWY now IS a Group member");
        let f = derive(area("DWRTCL", &[restrn(&[1])]));
        assert!(f.attr("sym").is_none());
        assert!(f.attr("dpri").is_none());
        // RESARE line geometry (shouldn't exist; area-only class) untouched
        let line = Feature::new(
            0,
            "RESARE".into(),
            BTreeMap::new(),
            Some(Geometry::Lines(vec![vec![
                WorldXy::new(0, 0),
                WorldXy::new(1, 1),
            ]])),
        );
        let f = derive(line);
        assert!(f.attr("dpri").is_none());
    }
}
