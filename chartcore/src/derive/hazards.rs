// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! WRECKS / OBSTRN / UWTROC derived facts (specs-12.md §1.3), the
//! settings-independent split of OBSTRN04/WRECKS02. Full rationale,
//! attribute list and documented reference divergences (D1-D3):
//! see docs/architecture/derive-facts.md.

use crate::coords::WorldXy;
use crate::model::{AttrValue, Cell, Feature, Geometry, Polygon};

const CLASSES: [&str; 3] = ["WRECKS", "OBSTRN", "UWTROC"];

pub fn apply(cell: &mut Cell) {
    // enclosing depth areas: (rings, post-DEPARE01-default drval1) — the
    // derive order guarantees depth_area_range already ran
    let depth_areas: Vec<(Vec<Polygon>, f64)> = cell
        .features
        .iter()
        .filter(|f| ["DEPARE", "DRGARE"].contains(&f.acronym.as_str()))
        .filter_map(
            |f| match (&f.geometry, f.attr("drval1").and_then(AttrValue::as_float)) {
                (Some(Geometry::Areas(polys)), Some(d)) => Some((polys.clone(), d)),
                _ => None,
            },
        )
        .collect();

    for f in &mut cell.features {
        if !CLASSES.contains(&f.acronym.as_str()) {
            continue;
        }
        let mut derived: Vec<(&str, AttrValue)> = Vec::new();

        let valsou = f.attr("VALSOU").and_then(AttrValue::as_float);
        let watlev = f.attr("WATLEV").and_then(AttrValue::as_int);
        let catobs = f.attr("CATOBS").and_then(AttrValue::as_int);
        let catwrk = f.attr("CATWRK").and_then(AttrValue::as_int);
        let wrecks = f.acronym == "WRECKS";

        // depth_value — always emitted (S52CondRules.cpp:296-331, 540-589)
        let depth_value = valsou.unwrap_or_else(|| {
            if wrecks {
                match catwrk {
                    Some(1) => 20.0,
                    Some(2) => 0.0,
                    Some(4) | Some(5) => -15.0,
                    _ => match watlev {
                        Some(3) => 0.01,
                        Some(5) => 0.0,
                        _ => -15.0,
                    },
                }
            } else if catobs == Some(6) {
                0.01
            } else {
                match watlev {
                    Some(5) => 0.0,
                    Some(3) => 0.01,
                    _ => -15.0,
                }
            }
        });
        derived.push(("depth_value", AttrValue::Float(depth_value)));

        // encl_drval1 — official UDWHAZ03's enclosing-depth-area input
        if let Some(encl) = enclosing_drval1(f, &depth_areas) {
            derived.push(("encl_drval1", AttrValue::Float(encl)));
        }

        // quasou7 — "depth unknown" wrecks gate the danger predicate
        if wrecks
            && f.attr("QUASOU")
                .and_then(AttrValue::as_int_list)
                .is_some_and(|q| q.contains(&7))
        {
            derived.push(("quasou7", AttrValue::Bool(true)));
        }

        // quapos was lifted by the base pass (QUAPOS_CLASSES includes the
        // hazard classes); reuse it for CSQUAPNT01 and boundary styles
        let quapos = f.attr("quapos").and_then(AttrValue::as_int);
        let inaccurate = quapos.is_some(); // lifted values are already in [2,10)

        match &f.geometry {
            Some(Geometry::Point(_)) => {
                // CSQUAPNT01 (S52CondRules.cpp:243-280). LOWACC03 is absent
                // from the reference xml — the retired sprite atlas aliased it
                // to QUESMRK1, and jt task ntyrwnnr drew it for real off
                // LOWACC01, the symbol upstream's own SLCONS03 uses for this
                // exact QUAPOS range (see LOWACC03.svg's header).
                if let Some(q) = quapos {
                    let sym_pos = match q {
                        4 => "QUAPOS01",
                        5 => "QUAPOS02",
                        7 | 8 => "QUAPOS03",
                        _ => "LOWACC03",
                    };
                    derived.push(("sym_pos", AttrValue::Str(sym_pos.into())));
                }
                let (sym, snd, dispcat) = point_symbol(&f.acronym, valsou, watlev, catobs, catwrk);
                if let Some(sym) = sym {
                    derived.push(("sym", AttrValue::Str(sym.into())));
                }
                if snd {
                    derived.push(("snd", AttrValue::Bool(true)));
                }
                derived.push(("dispcat", AttrValue::Str(dispcat.into())));
            }
            Some(Geometry::Lines(_)) => {
                // only OBSTRN has line lookups (WRECKS/UWTROC are point/area)
                let direct = matches!(catobs, Some(8) | Some(9) | Some(10)) || watlev == Some(7);
                let (lsty, snd) = if direct {
                    ("dash", false)
                } else if inaccurate {
                    ("dash", false) // LC(LOWACC31/41) degraded to dash
                } else {
                    match valsou {
                        Some(v) if v <= 20.0 => ("dott", true),
                        Some(_) => ("dash", false),
                        None => ("dott", false),
                    }
                };
                derived.push(("lsty", AttrValue::Str(lsty.into())));
                if snd {
                    derived.push(("snd", AttrValue::Bool(true)));
                }
                derived.push((
                    "dispcat",
                    AttrValue::Str(if direct { "base" } else { "standard" }.into()),
                ));
            }
            Some(Geometry::Areas(_)) => {
                let (sym, lsty, fill, snd, dispcat) = if wrecks {
                    wrecks_area(valsou, watlev, catwrk, inaccurate)
                } else {
                    obstrn_area(valsou, watlev, catobs, inaccurate)
                };
                if let Some(sym) = sym {
                    derived.push(("sym", AttrValue::Str(sym.into())));
                }
                derived.push(("lsty", AttrValue::Str(lsty.into())));
                if let Some(fill) = fill {
                    derived.push(("fill", AttrValue::Str(fill.into())));
                }
                if snd {
                    derived.push(("snd", AttrValue::Bool(true)));
                }
                derived.push(("dispcat", AttrValue::Str(dispcat.into())));
            }
            _ => {}
        }

        for (k, v) in derived {
            f.attributes.insert(k.into(), v);
        }
    }
}

/// Point symbol tables (specs-12.md §1.3a) → (sym, snd, dispcat).
fn point_symbol(
    class: &str,
    valsou: Option<f64>,
    watlev: Option<i64>,
    catobs: Option<i64>,
    catwrk: Option<i64>,
) -> (Option<&'static str>, bool, &'static str) {
    match class {
        "WRECKS" => {
            // LUP-direct row: CATWRK=3 -> "foul", a deliberate divergence
            // from s57-style.json (user call 2026-07-29). See
            // docs/architecture/derive-facts.md ("CATWRK=3 row").
            if catwrk == Some(3) {
                return (Some("foul"), false, "standard");
            }
            if valsou.is_some() {
                // settings-dependent DANGER51/52 pick stays client-side (S2);
                // the reference appends the sounding unconditionally (:620)
                return (None, true, "standard");
            }
            // official no-VALSOU branching (divergence D1): both CATWRK and
            // WATLEV must be present, else no symbol
            let sym = match (catwrk, watlev) {
                (Some(1), Some(3)) => Some("wreck-hull_showing"),
                (Some(2), Some(3)) => Some("wreck-hull_showing"),
                (Some(4) | Some(5), Some(_)) => Some("wreck-non-dangerous"),
                (Some(_), Some(1) | Some(2) | Some(4) | Some(5)) => Some("wreck-non-dangerous"),
                (Some(_), Some(_)) => Some("wreck-hull_showing"),
                _ => None,
            };
            (sym, false, "standard")
        }
        "UWTROC" => {
            let sym = match valsou {
                Some(v) if v <= 20.0 => match watlev {
                    Some(4) | Some(5) => return (Some("rock-submerged"), false, "standard"),
                    _ => "DANGER51",
                },
                Some(_) => "DANGER52",
                None => {
                    return (
                        Some(match watlev {
                            Some(2) => "LNDARE01",
                            Some(3) => "rock-awash",
                            _ => "rock-submerged",
                        }),
                        false,
                        "standard",
                    )
                }
            };
            (Some(sym), true, "standard")
        }
        _ => {
            // OBSTRN — LUP-direct rows bypass the CS (chartsymbols.xml
            // Simplified OBSTRN block; dispcat per specs-12.md §1.3).
            // `SY(FLTHAZ02)` (booms and anything WATLEV=floating) resolves to
            // the vendored `obstruction` — see [`obstrn_area`]'s note.
            match catobs {
                Some(7) => return (Some("foul"), false, "standard"),
                Some(8) | Some(10) => return (Some("obstruction"), false, "base"),
                Some(9) => return (Some("anchor"), false, "base"),
                _ if watlev == Some(7) => return (Some("obstruction"), false, "base"),
                _ => {}
            }
            match valsou {
                Some(v) if v <= 20.0 => match watlev {
                    None => (Some("DANGER01"), true, "standard"),
                    Some(1) | Some(2) => (Some("LNDARE01"), false, "standard"),
                    Some(3) => (Some("DANGER52"), true, "standard"),
                    Some(4) | Some(5) => (Some("DANGER53"), true, "standard"),
                    Some(_) => (Some("DANGER51"), true, "standard"),
                },
                Some(_) => (Some("DANGER52"), true, "standard"),
                None => (
                    Some(match watlev {
                        Some(1) | Some(2) => "foul",
                        Some(4) | Some(5) => "obstruction",
                        _ => "obstruction",
                    }),
                    false,
                    "standard",
                ),
            }
        }
    }
}

/// OBSTRN area table → (sym, lsty, fill, snd, dispcat).
///
/// `SY(FLTHAZ02)` row (CATOBS 8/10, WATLEV=7) emits the vendored
/// `obstruction`, not the unrenderable `FLTHAZ02` token — see
/// docs/architecture/derive-facts.md ("SY(FLTHAZ02) row").
fn obstrn_area(
    valsou: Option<f64>,
    watlev: Option<i64>,
    catobs: Option<i64>,
    inaccurate: bool,
) -> (
    Option<&'static str>,
    &'static str,
    Option<&'static str>,
    bool,
    &'static str,
) {
    let _ = inaccurate; // OBSTRN04's area branch has no quapos boundary case

    // LUP-direct rows (chartsymbols.xml Plain OBSTRN block)
    match catobs {
        Some(7) => return (Some("foul"), "dash", None, false, "standard"),
        Some(8) | Some(10) => return (Some("obstruction"), "dash", None, false, "base"),
        Some(9) => return (Some("anchor"), "dash", None, false, "base"),
        _ if watlev == Some(7) => return (Some("obstruction"), "dash", None, false, "base"),
        _ => {}
    }
    match valsou {
        Some(v) => {
            // sounding appended for every VALSOU area (:482-489); fill only
            // for the foul-ground special case
            let fill = (watlev == Some(3) && catobs == Some(6)).then_some("depvs");
            (
                None,
                if v <= 20.0 { "dott" } else { "dash" },
                fill,
                true,
                "standard",
            )
        }
        None => {
            let (lsty, fill) = match watlev {
                Some(1) | Some(2) => ("sold", "chbrn"),
                Some(4) => ("dash", "depit"),
                _ => ("dott", "depvs"),
            };
            (None, lsty, Some(fill), false, "standard")
        }
    }
}

/// WRECKS area table → (sym, lsty, fill, snd, dispcat).
fn wrecks_area(
    valsou: Option<f64>,
    watlev: Option<i64>,
    catwrk: Option<i64>,
    inaccurate: bool,
) -> (
    Option<&'static str>,
    &'static str,
    Option<&'static str>,
    bool,
    &'static str,
) {
    // LUP-direct row: CATWRK=3 -> dash CHBLK boundary, nothing else
    if catwrk == Some(3) {
        return (None, "dash", None, false, "standard");
    }
    let lsty = if inaccurate {
        "dash" // LC(LOWACC41) degraded
    } else {
        match watlev {
            Some(1) | Some(2) => "sold",
            Some(4) => "dash",
            _ => "dott",
        }
    };
    match valsou {
        Some(v) => (None, lsty, None, v <= 20.0, "standard"),
        None => {
            // official (D1): fill only without VALSOU
            let fill = match watlev {
                Some(1) | Some(2) => "chbrn",
                Some(4) => "depit",
                _ => "depvs",
            };
            (None, lsty, Some(fill), false, "standard")
        }
    }
}

/// Post-DEPARE01-default `drval1` of the enclosing depth area(s): points
/// take the max over containing polygons, lines/areas the max over depth
/// areas containing any vertex (see module docs).
fn enclosing_drval1(f: &Feature, depth_areas: &[(Vec<Polygon>, f64)]) -> Option<f64> {
    let vertices: Vec<WorldXy> = match &f.geometry {
        Some(Geometry::Point(p)) => vec![*p],
        Some(Geometry::Lines(lines)) => lines.iter().flatten().copied().collect(),
        Some(Geometry::Areas(polys)) => {
            polys.iter().flat_map(|p| p.outer.iter()).copied().collect()
        }
        _ => return None,
    };
    depth_areas
        .iter()
        .filter(|(polys, _)| {
            vertices
                .iter()
                .any(|v| polys.iter().any(|poly| polygon_contains(poly, *v)))
        })
        .map(|(_, d)| *d)
        .max_by(f64::total_cmp)
}

/// Point-in-polygon (even-odd ray cast, integer-safe), holes subtract.
fn polygon_contains(poly: &Polygon, p: WorldXy) -> bool {
    ring_contains(&poly.outer, p) && !poly.holes.iter().any(|h| ring_contains(h, p))
}

fn ring_contains(ring: &[WorldXy], p: WorldXy) -> bool {
    let (px, py) = (p.x as i64, p.y as i64);
    let mut inside = false;
    let n = ring.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (ring[i].x as i64, ring[i].y as i64);
        let (xj, yj) = (ring[j].x as i64, ring[j].y as i64);
        if (yi > py) != (yj > py) {
            // x of the edge at height py, compared without division:
            // px < xi + (xj - xi) * (py - yi) / (yj - yi)
            let lhs = (px - xi) * (yj - yi);
            let rhs = (xj - xi) * (py - yi);
            if if yj > yi { lhs < rhs } else { lhs > rhs } {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::Extent;
    use crate::model::CellMeta;
    use std::collections::BTreeMap;

    fn feat(acronym: &str, geometry: Geometry, attrs: &[(&str, AttrValue)]) -> Feature {
        let map: BTreeMap<String, AttrValue> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, acronym.into(), map, Some(geometry))
    }

    fn pt(x: i32, y: i32) -> Geometry {
        Geometry::Point(WorldXy::new(x, y))
    }

    fn square(x0: i32, y0: i32, x1: i32, y1: i32) -> Polygon {
        Polygon {
            outer: vec![
                WorldXy::new(x0, y0),
                WorldXy::new(x1, y0),
                WorldXy::new(x1, y1),
                WorldXy::new(x0, y1),
                WorldXy::new(x0, y0),
            ],
            holes: vec![],
        }
    }

    fn derive_one(f: Feature) -> Feature {
        derive_with_areas(f, vec![])
    }

    /// Run the full derive pipeline (depth_area_range first) on one hazard
    /// plus optional DEPARE features.
    fn derive_with_areas(f: Feature, areas: Vec<Feature>) -> Feature {
        let mut features = areas;
        features.push(f);
        let mut c = Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features,
        };
        crate::derive::apply(&mut c);
        c.features.pop().unwrap()
    }

    fn s(f: &Feature, key: &str) -> Option<String> {
        f.attr(key).and_then(AttrValue::as_str).map(str::to_string)
    }

    fn fl(f: &Feature, key: &str) -> Option<f64> {
        f.attr(key).and_then(AttrValue::as_float)
    }

    #[test]
    fn depth_value_defaults() {
        // VALSOU wins everywhere
        let f = derive_one(feat(
            "OBSTRN",
            pt(0, 0),
            &[("VALSOU", AttrValue::Float(7.5))],
        ));
        assert_eq!(fl(&f, "depth_value"), Some(7.5));
        // WRECKS CATWRK table
        for (catwrk, expect) in [(1, 20.0), (2, 0.0), (4, -15.0), (5, -15.0)] {
            let f = derive_one(feat(
                "WRECKS",
                pt(0, 0),
                &[("CATWRK", AttrValue::Int(catwrk))],
            ));
            assert_eq!(fl(&f, "depth_value"), Some(expect), "CATWRK {catwrk}");
        }
        // WRECKS WATLEV fallback (no CATWRK or CATWRK=3)
        for (watlev, expect) in [(3, 0.01), (5, 0.0), (1, -15.0), (6, -15.0)] {
            let f = derive_one(feat(
                "WRECKS",
                pt(0, 0),
                &[("WATLEV", AttrValue::Int(watlev))],
            ));
            assert_eq!(fl(&f, "depth_value"), Some(expect), "WATLEV {watlev}");
        }
        let f = derive_one(feat("WRECKS", pt(0, 0), &[]));
        assert_eq!(fl(&f, "depth_value"), Some(-15.0));
        // OBSTRN/UWTROC: CATOBS=6 then WATLEV
        let f = derive_one(feat("OBSTRN", pt(0, 0), &[("CATOBS", AttrValue::Int(6))]));
        assert_eq!(fl(&f, "depth_value"), Some(0.01));
        for (watlev, expect) in [(5, 0.0), (3, 0.01), (4, -15.0)] {
            let f = derive_one(feat(
                "UWTROC",
                pt(0, 0),
                &[("WATLEV", AttrValue::Int(watlev))],
            ));
            assert_eq!(fl(&f, "depth_value"), Some(expect), "WATLEV {watlev}");
        }
    }

    #[test]
    fn obstrn_point_symbols() {
        let v = |v: f64| ("VALSOU", AttrValue::Float(v));
        let w = |w: i64| ("WATLEV", AttrValue::Int(w));
        for (attrs, sym, snd) in [
            (vec![v(5.0)], "DANGER01", true),
            (vec![v(5.0), w(1)], "LNDARE01", false),
            (vec![v(5.0), w(3)], "DANGER52", true),
            (vec![v(5.0), w(4)], "DANGER53", true),
            (vec![v(5.0), w(6)], "DANGER51", true),
            (vec![v(25.0), w(3)], "DANGER52", true),
            (vec![w(1)], "foul", false),
            (vec![w(5)], "obstruction", false),
            (vec![w(3)], "obstruction", false),
            (vec![], "obstruction", false),
        ] {
            let f = derive_one(feat("OBSTRN", pt(0, 0), &attrs));
            assert_eq!(s(&f, "sym").as_deref(), Some(sym), "{attrs:?}");
            assert_eq!(f.attr("snd").is_some(), snd, "{attrs:?}");
            assert_eq!(s(&f, "dispcat").as_deref(), Some("standard"));
        }
        // LUP-direct rows
        for (catobs, sym, dispcat) in [
            (7, "foul", "standard"),
            (8, "obstruction", "base"),
            (9, "anchor", "base"),
            (10, "obstruction", "base"),
        ] {
            let f = derive_one(feat(
                "OBSTRN",
                pt(0, 0),
                &[("CATOBS", AttrValue::Int(catobs))],
            ));
            assert_eq!(s(&f, "sym").as_deref(), Some(sym), "CATOBS {catobs}");
            assert_eq!(
                s(&f, "dispcat").as_deref(),
                Some(dispcat),
                "CATOBS {catobs}"
            );
        }
        let f = derive_one(feat("OBSTRN", pt(0, 0), &[("WATLEV", AttrValue::Int(7))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("obstruction"));
        assert_eq!(s(&f, "dispcat").as_deref(), Some("base"));
    }

    #[test]
    fn uwtroc_point_symbols() {
        let v = |v: f64| ("VALSOU", AttrValue::Float(v));
        let w = |w: i64| ("WATLEV", AttrValue::Int(w));
        for (attrs, sym, snd) in [
            (vec![v(5.0), w(4)], "rock-submerged", false),
            (vec![v(5.0), w(5)], "rock-submerged", false),
            (vec![v(5.0), w(3)], "DANGER51", true),
            (vec![v(5.0)], "DANGER51", true),
            (vec![v(25.0)], "DANGER52", true),
            (vec![w(2)], "LNDARE01", false),
            (vec![w(3)], "rock-awash", false),
            (vec![w(4)], "rock-submerged", false),
            (vec![], "rock-submerged", false),
        ] {
            let f = derive_one(feat("UWTROC", pt(0, 0), &attrs));
            assert_eq!(s(&f, "sym").as_deref(), Some(sym), "{attrs:?}");
            assert_eq!(f.attr("snd").is_some(), snd, "{attrs:?}");
        }
    }

    #[test]
    fn wrecks_point_symbols() {
        let c = |c: i64| ("CATWRK", AttrValue::Int(c));
        let w = |w: i64| ("WATLEV", AttrValue::Int(w));
        // with VALSOU: no sym (client S2), sounding always
        let f = derive_one(feat(
            "WRECKS",
            pt(0, 0),
            &[("VALSOU", AttrValue::Float(6.4)), c(2), w(3)],
        ));
        assert!(f.attr("sym").is_none());
        assert_eq!(f.attr("snd"), Some(&AttrValue::Bool(true)));
        // official no-VALSOU table (D1)
        for (attrs, sym) in [
            (vec![c(1), w(3)], Some("wreck-hull_showing")),
            (vec![c(2), w(3)], Some("wreck-hull_showing")),
            (vec![c(4), w(3)], Some("wreck-non-dangerous")),
            (vec![c(5), w(6)], Some("wreck-non-dangerous")),
            (vec![c(2), w(1)], Some("wreck-non-dangerous")),
            (vec![c(2), w(4)], Some("wreck-non-dangerous")),
            (vec![c(2), w(6)], Some("wreck-hull_showing")),
            (vec![c(2)], None), // WATLEV missing -> no sym
            (vec![w(3)], None), // CATWRK missing -> no sym
        ] {
            let f = derive_one(feat("WRECKS", pt(0, 0), &attrs));
            assert_eq!(s(&f, "sym").as_deref(), sym, "{attrs:?}");
        }
        // CATWRK=3 LUP-direct row
        let f = derive_one(feat(
            "WRECKS",
            pt(0, 0),
            &[c(3), ("VALSOU", AttrValue::Float(2.0))],
        ));
        assert_eq!(s(&f, "sym").as_deref(), Some("foul"));
        assert!(f.attr("snd").is_none());
    }

    #[test]
    fn quasou7_and_sym_pos() {
        let f = derive_one(feat(
            "WRECKS",
            pt(0, 0),
            &[("QUASOU", AttrValue::StrList(vec!["7".into()]))],
        ));
        assert_eq!(f.attr("quasou7"), Some(&AttrValue::Bool(true)));
        let f = derive_one(feat(
            "WRECKS",
            pt(0, 0),
            &[("QUASOU", AttrValue::StrList(vec!["6".into()]))],
        ));
        assert!(f.attr("quasou7").is_none());
        // sym_pos from the lifted quapos
        for (q, sym) in [
            (4, "QUAPOS01"),
            (5, "QUAPOS02"),
            (7, "QUAPOS03"),
            (8, "QUAPOS03"),
            (3, "LOWACC03"),
        ] {
            let mut h = feat("UWTROC", pt(0, 0), &[]);
            h.spatial_quapos = vec![q];
            let f = derive_one(h);
            assert_eq!(s(&f, "sym_pos").as_deref(), Some(sym), "quapos {q}");
        }
        let f = derive_one(feat("UWTROC", pt(0, 0), &[]));
        assert!(f.attr("sym_pos").is_none());
    }

    #[test]
    fn obstrn_lines() {
        let line = || Geometry::Lines(vec![vec![WorldXy::new(0, 0), WorldXy::new(10, 0)]]);
        let f = derive_one(feat("OBSTRN", line(), &[]));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dott"));
        assert!(f.attr("snd").is_none());
        let f = derive_one(feat("OBSTRN", line(), &[("VALSOU", AttrValue::Float(5.0))]));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dott"));
        assert_eq!(f.attr("snd"), Some(&AttrValue::Bool(true)));
        let f = derive_one(feat(
            "OBSTRN",
            line(),
            &[("VALSOU", AttrValue::Float(25.0))],
        ));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));
        assert!(f.attr("snd").is_none());
        // low positional accuracy degrades to dash and suppresses sounding
        let mut h = feat("OBSTRN", line(), &[("VALSOU", AttrValue::Float(5.0))]);
        h.spatial_quapos = vec![4];
        let f = derive_one(h);
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));
        assert!(f.attr("snd").is_none());
        // LUP-direct line rows
        let f = derive_one(feat("OBSTRN", line(), &[("CATOBS", AttrValue::Int(9))]));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));
        assert_eq!(s(&f, "dispcat").as_deref(), Some("base"));
    }

    #[test]
    fn obstrn_areas() {
        let area = || Geometry::Areas(vec![square(0, 0, 100, 100)]);
        let w = |w: i64| ("WATLEV", AttrValue::Int(w));
        // no VALSOU: fill + boundary by WATLEV
        for (attrs, lsty, fill) in [
            (vec![w(1)], "sold", "chbrn"),
            (vec![w(4)], "dash", "depit"),
            (vec![w(3)], "dott", "depvs"),
            (vec![], "dott", "depvs"),
        ] {
            let f = derive_one(feat("OBSTRN", area(), &attrs));
            assert_eq!(s(&f, "lsty").as_deref(), Some(lsty), "{attrs:?}");
            assert_eq!(s(&f, "fill").as_deref(), Some(fill), "{attrs:?}");
        }
        // VALSOU: no fill, sounding, dott/dash on 20
        let f = derive_one(feat("OBSTRN", area(), &[("VALSOU", AttrValue::Float(5.0))]));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dott"));
        assert!(f.attr("fill").is_none());
        assert_eq!(f.attr("snd"), Some(&AttrValue::Bool(true)));
        let f = derive_one(feat(
            "OBSTRN",
            area(),
            &[("VALSOU", AttrValue::Float(25.0))],
        ));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));
        assert_eq!(f.attr("snd"), Some(&AttrValue::Bool(true)));
        // foul ground keeps its fill even with VALSOU
        let f = derive_one(feat(
            "OBSTRN",
            area(),
            &[
                ("VALSOU", AttrValue::Float(5.0)),
                w(3),
                ("CATOBS", AttrValue::Int(6)),
            ],
        ));
        assert_eq!(s(&f, "fill").as_deref(), Some("depvs"));
        // LUP-direct area rows
        let f = derive_one(feat("OBSTRN", area(), &[("CATOBS", AttrValue::Int(7))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("foul"));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));
        let f = derive_one(feat("OBSTRN", area(), &[("CATOBS", AttrValue::Int(8))]));
        assert_eq!(s(&f, "sym").as_deref(), Some("obstruction"));
        assert_eq!(s(&f, "dispcat").as_deref(), Some("base"));
    }

    #[test]
    fn wrecks_areas() {
        let area = || Geometry::Areas(vec![square(0, 0, 100, 100)]);
        let w = |w: i64| ("WATLEV", AttrValue::Int(w));
        for (attrs, lsty, fill) in [
            (vec![w(1)], "sold", "chbrn"),
            (vec![w(4)], "dash", "depit"),
            (vec![w(5)], "dott", "depvs"),
        ] {
            let f = derive_one(feat("WRECKS", area(), &attrs));
            assert_eq!(s(&f, "lsty").as_deref(), Some(lsty), "{attrs:?}");
            assert_eq!(s(&f, "fill").as_deref(), Some(fill), "{attrs:?}");
        }
        // VALSOU: no fill; snd only <= 20
        let f = derive_one(feat(
            "WRECKS",
            area(),
            &[("VALSOU", AttrValue::Float(5.0)), w(3)],
        ));
        assert!(f.attr("fill").is_none());
        assert_eq!(f.attr("snd"), Some(&AttrValue::Bool(true)));
        let f = derive_one(feat(
            "WRECKS",
            area(),
            &[("VALSOU", AttrValue::Float(30.0))],
        ));
        assert!(f.attr("snd").is_none());
        // quapos-inaccurate boundary
        let mut h = feat("WRECKS", area(), &[w(1)]);
        h.spatial_quapos = vec![5];
        let f = derive_one(h);
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));
        // CATWRK=3 area LUP row
        let f = derive_one(feat("WRECKS", area(), &[("CATWRK", AttrValue::Int(3))]));
        assert_eq!(s(&f, "lsty").as_deref(), Some("dash"));
        assert!(f.attr("fill").is_none());
    }

    #[test]
    fn encl_drval1_from_containing_depth_areas() {
        let depare = |x0, y0, x1, y1, drval1: f64| {
            feat(
                "DEPARE",
                Geometry::Areas(vec![square(x0, y0, x1, y1)]),
                &[
                    ("DRVAL1", AttrValue::Float(drval1)),
                    ("DRVAL2", AttrValue::Float(drval1 + 5.0)),
                ],
            )
        };
        // point inside two stacked areas: max drval1 wins
        let f = derive_with_areas(
            feat("UWTROC", pt(50, 50), &[]),
            vec![depare(0, 0, 100, 100, 2.0), depare(25, 25, 75, 75, 5.4)],
        );
        assert_eq!(fl(&f, "encl_drval1"), Some(5.4));
        // point outside every area: omitted
        let f = derive_with_areas(
            feat("UWTROC", pt(500, 500), &[]),
            vec![depare(0, 0, 100, 100, 2.0)],
        );
        assert!(f.attr("encl_drval1").is_none());
        // line: max over areas containing any vertex
        let line = Geometry::Lines(vec![vec![WorldXy::new(10, 10), WorldXy::new(150, 10)]]);
        let f = derive_with_areas(
            feat("OBSTRN", line, &[]),
            vec![depare(0, 0, 100, 100, 2.0), depare(100, 0, 200, 100, 7.0)],
        );
        assert_eq!(fl(&f, "encl_drval1"), Some(7.0));
        // hole in the depth area excludes the point
        let mut holed = square(0, 0, 100, 100);
        holed.holes.push(square(40, 40, 60, 60).outer);
        let dep = feat(
            "DEPARE",
            Geometry::Areas(vec![holed]),
            &[("DRVAL1", AttrValue::Float(3.0))],
        );
        let f = derive_with_areas(feat("UWTROC", pt(50, 50), &[]), vec![dep]);
        assert!(f.attr("encl_drval1").is_none());
        // DRGARE counts too, and the derived (defaulted) drval1 is used
        let drgare = feat(
            "DRGARE",
            Geometry::Areas(vec![square(0, 0, 100, 100)]),
            &[("DRVAL1", AttrValue::Float(4.2))],
        );
        let f = derive_with_areas(feat("WRECKS", pt(10, 10), &[]), vec![drgare]);
        assert_eq!(fl(&f, "encl_drval1"), Some(4.2));
    }

    #[test]
    fn polygon_contains_basics() {
        let sq = square(0, 0, 10, 10);
        assert!(polygon_contains(&sq, WorldXy::new(5, 5)));
        assert!(!polygon_contains(&sq, WorldXy::new(15, 5)));
        assert!(!polygon_contains(&sq, WorldXy::new(-1, -1)));
    }
}
