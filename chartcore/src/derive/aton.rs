// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Aids-to-navigation derived facts: the `floating` topmark join and
//! attribute resolution of point symbols into `sym_s`/`sym_topmark`/`lbl_s`.
//! See docs/architecture/aton-icon-port.md.

use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap};

use crate::icons;
use crate::model::{AttrValue, Cell, Feature, Geometry};
use crate::s52::{self, LupTable, S52Data};

/// Classes whose exact point coordinate marks a *floating* platform for the
/// TOPMAR01 join (`OESUChart.cpp:784-817`). Lowercase entries are the
/// inland-ENC variants.
const FLOATING_CLASSES: [&str; 10] = [
    "BOYCAR", "BOYINB", "BOYISD", "BOYLAT", "BOYSAW", "BOYSPP", "boylat", "boywtw", "LITVES",
    "LITFLT",
];

/// Classes marking a *rigid* platform — rigid wins ties.
const RIGID_CLASSES: [&str; 7] = [
    "BCNCAR", "BCNISD", "BCNLAT", "BCNSAW", "BCNSPP", "bcnlat", "bcnwtw",
];

/// Is this class resolved against the point-symbol scheme? Extended past the
/// old LUP-driven set with `mooring`/`light-vessel`/`dir-buoyage`, which
/// used to get no `sym_*` at all. See docs/architecture/aton-icon-port.md.
pub fn is_aton_class(acronym: &str) -> bool {
    let up = acronym.to_ascii_uppercase();
    up.starts_with("BOY")
        || up.starts_with("BCN")
        || matches!(
            up.as_str(),
            "TOPMAR" | "DAYMAR" | "MORFAC" | "LITVES" | "LITFLT" | "M_NSYS"
        )
}

/// The `floating` join and symbol resolution (attribute-based, no `s52` data
/// needed); `lbl_s` only when `s52` lookup tables are available.
pub fn apply(cell: &mut Cell, s52: Option<&S52Data>) {
    let point_set = |classes: &[&str]| -> BTreeSet<(i32, i32)> {
        cell.features
            .iter()
            .filter(|f| classes.contains(&f.acronym.as_str()))
            .filter_map(|f| match f.geometry {
                Some(Geometry::Point(p)) => Some((p.x, p.y)),
                _ => None,
            })
            .collect()
    };
    let floating = point_set(&FLOATING_CLASSES);
    let rigid = point_set(&RIGID_CLASSES);
    let bodies = body_keys(cell);

    for f in &mut cell.features {
        if !is_aton_class(&f.acronym) || !matches!(f.geometry, Some(Geometry::Point(_))) {
            continue;
        }
        let Some(Geometry::Point(p)) = f.geometry else {
            unreachable!()
        };
        let at = (p.x, p.y);
        // `floating` no longer feeds symbol resolution (TOPSHP alone keys
        // the icon now) but stays a real, previously-tested derived fact.
        if f.acronym == "TOPMAR" && floating.contains(&at) && !rigid.contains(&at) {
            f.attributes
                .insert("floating".into(), AttrValue::Bool(true));
        }

        if let Some(mut sym) = resolve_symbol(f) {
            // A topmark/daymark names the body it rides, when one is charted
            // under it — see `body_keys`.
            if is_overlay_class(&f.acronym) {
                if let Some(base) = bodies.get(&at) {
                    sym.push(icons::OVERLAY_REF_SEP);
                    sym.push_str(&base.1);
                }
            }
            f.attributes.insert("sym_s".into(), AttrValue::Str(sym));
        }
        if let Some(overlay) = topmark_overlay(f) {
            f.attributes
                .insert("sym_topmark".into(), AttrValue::Str(overlay.into()));
        }

        let Some(s52) = s52 else { continue };
        let Some(lup) = s52.find_lup(LupTable::Simplified, &f.acronym, &f.attributes) else {
            continue;
        };
        if let (Some(fmt), Some(objnam)) = (
            s52::objnam_format(&lup.instruction),
            f.attributes.get("OBJNAM").and_then(AttrValue::as_str),
        ) {
            f.attributes
                .insert("lbl_s".into(), AttrValue::Str(fmt.replace("%s", objnam)));
        }
    }
}

/// Comma-joined raw string of a *non-empty* list attribute. A
/// present-but-empty S-57 list is treated as absent, matching how
/// s57.json's `coalesce`/`!has` read an empty tile property.
fn raw_list(f: &Feature, key: &str) -> Option<String> {
    match f.attr(key)? {
        AttrValue::StrList(v) if !v.is_empty() => Some(v.join(",")),
        AttrValue::IntList(v) if !v.is_empty() => {
            Some(v.iter().map(i64::to_string).collect::<Vec<_>>().join(","))
        }
        AttrValue::FloatList(v) if !v.is_empty() => {
            Some(v.iter().map(f64::to_string).collect::<Vec<_>>().join(","))
        }
        _ => None,
    }
}

fn int_or(f: &Feature, key: &str, default: i64) -> i64 {
    f.attr(key).and_then(AttrValue::as_int).unwrap_or(default)
}

/// Is this an ATON class drawn as a topmark/daymark riding another aid's
/// mast, rather than as a body of its own?
fn is_overlay_class(acronym: &str) -> bool {
    let up = acronym.to_ascii_uppercase();
    up == "TOPMAR" || up == "DAYMAR"
}

/// Every ATON *body* point in the cell, keyed by coordinate, as
/// `(is_rigid, its own resolved symbol key)` — the mount join so a stacked
/// topmark sprite can pad against the real body's mast height/lean.
fn body_keys(cell: &Cell) -> HashMap<(i32, i32), (bool, String)> {
    let mut out: HashMap<(i32, i32), (bool, String)> = HashMap::new();
    for f in &cell.features {
        if !is_aton_class(&f.acronym) || is_overlay_class(&f.acronym) {
            continue;
        }
        let Some(Geometry::Point(p)) = f.geometry else {
            continue;
        };
        let Some(sym) = resolve_symbol(f) else {
            continue;
        };
        let is_rigid = RIGID_CLASSES.contains(&f.acronym.as_str());
        match out.entry((p.x, p.y)) {
            Entry::Vacant(v) => {
                v.insert((is_rigid, sym));
            }
            Entry::Occupied(mut o) => {
                if is_rigid && !o.get().0 {
                    o.insert((is_rigid, sym));
                }
            }
        }
    }
    out
}

/// Body symbol for the class this feature belongs to (`buoy`/`beacon`/
/// `topmark`/`daymark`/`mooring`/`light-vessel`/`dir-buoyage` layers of
/// s57.json). `None` for classes this module doesn't resolve.
fn resolve_symbol(f: &Feature) -> Option<String> {
    let up = f.acronym.to_ascii_uppercase();
    if up.starts_with("BOY") {
        Some(boyshp_symbol(f))
    } else if up.starts_with("BCN") {
        Some(bcnshp_symbol(f))
    } else if up == "TOPMAR" || up == "DAYMAR" {
        Some(topshp_symbol(f))
    } else if up == "MORFAC" {
        Some(mooring_symbol(f))
    } else if up == "LITVES" || up == "LITFLT" {
        Some(light_vessel_symbol(f))
    } else if up == "M_NSYS" {
        Some(dir_buoyage_symbol(f).to_string())
    } else {
        None
    }
}

/// `buoy` layer: `concat("BOYSHP/", BOYSHP|5, "/", COLPAT|0, "/", COLOUR|2)`.
fn boyshp_symbol(f: &Feature) -> String {
    format!(
        "BOYSHP/{}/{}/{}",
        int_or(f, "BOYSHP", 5),
        raw_list(f, "COLPAT").unwrap_or_else(|| "0".into()),
        raw_list(f, "COLOUR").unwrap_or_else(|| "2".into()),
    )
}

/// `beacon` layer: withy-pole special case for an uncoloured lateral beacon,
/// else the same `BCNSHP/…/COLPAT/COLOUR` scheme as `buoy`. Upstream's
/// "perch-*" arms key off a property no S-57 decoder produces — not ported.
fn bcnshp_symbol(f: &Feature) -> String {
    let bcnshp = f.attr("BCNSHP").and_then(AttrValue::as_int);
    let catlam = f.attr("CATLAM").and_then(AttrValue::as_int);
    let has_colour = raw_list(f, "COLOUR").is_some();
    if bcnshp == Some(2) && catlam == Some(2) && !has_colour {
        return "withy-starboard".into();
    }
    if bcnshp == Some(2) && catlam == Some(1) && !has_colour {
        return "withy-port".into();
    }
    format!(
        "BCNSHP/{}/{}/{}",
        bcnshp.unwrap_or(5),
        raw_list(f, "COLPAT").unwrap_or_else(|| "0".into()),
        raw_list(f, "COLOUR").unwrap_or_else(|| "2".into()),
    )
}

/// `topmark`/`daymark` layers: `concat("TOPSHP/", TOPSHP|3, "/", COLPAT|0,
/// "/", COLOUR|0)` — same scheme as `buoy`/`beacon` but keyed on TOPSHP and
/// with COLOUR defaulting to 0, not 2.
fn topshp_symbol(f: &Feature) -> String {
    format!(
        "TOPSHP/{}/{}/{}",
        int_or(f, "TOPSHP", 3),
        raw_list(f, "COLPAT").unwrap_or_else(|| "0".into()),
        raw_list(f, "COLOUR").unwrap_or_else(|| "0".into()),
    )
}

/// `mooring` layer (MORFAC): a CATMOR=7 mooring buoy gets the `buoy` scheme;
/// every other mooring facility (dolphin, pile, bollard, …) gets the fixed
/// `pilpnt` icon.
fn mooring_symbol(f: &Feature) -> String {
    if f.attr("CATMOR").and_then(AttrValue::as_int) == Some(7) {
        boyshp_symbol(f)
    } else {
        "pilpnt".into()
    }
}

/// `light-vessel` layer (LITVES/LITFLT): `"light_float/" + colour word`,
/// keyed on the RAW (un-defaulted) COLOUR value — unlike the other schemes
/// here, a COLOUR this doesn't recognise (including absent/empty) falls to
/// the literal word `"x"`, matching upstream's `match` fallback exactly.
fn light_vessel_symbol(f: &Feature) -> String {
    let word = match raw_list(f, "COLOUR").as_deref() {
        Some("1") => "white",
        Some("2") => "black",
        Some("3") => "red",
        Some("4") => "green",
        Some("6") => "yellow",
        Some("7") => "grey",
        _ => "x",
    };
    format!("light_float/{word}")
}

/// `dir-buoyage` layer (M_NSYS): `match(MARSYS, 2, "dir-buoyage-b",
/// "dir-buoyage-a")`. The frontend's own layer filter (`has(ORIENT)`) stays
/// a rendering concern — this derives the name unconditionally.
fn dir_buoyage_symbol(f: &Feature) -> &'static str {
    if f.attr("MARSYS").and_then(AttrValue::as_int) == Some(2) {
        "dir-buoyage-b"
    } else {
        "dir-buoyage-a"
    }
}

/// `topmark-buoy`/`topmark-beacon` layers: a second icon stacked on the
/// buoy/beacon feature itself, inferred from ITS OWN COLOUR/CATSPM/CATCAM —
/// independent of any separate `TOPMAR` feature's own `topshp_symbol`.
fn topmark_overlay(f: &Feature) -> Option<&'static str> {
    let up = f.acronym.to_ascii_uppercase();
    if up.starts_with("BOY") {
        topmark_overlay_buoy(f)
    } else if up.starts_with("BCN") {
        topmark_overlay_beacon(f)
    } else {
        None
    }
}

fn topmark_overlay_buoy(f: &Feature) -> Option<&'static str> {
    let colour = raw_list(f, "COLOUR");
    if colour.as_deref() == Some("3,1") {
        return Some("sphere/red");
    }
    topmark_overlay_common(f, colour)
}

fn topmark_overlay_beacon(f: &Feature) -> Option<&'static str> {
    let bcnshp = f.attr("BCNSHP").and_then(AttrValue::as_int);
    let catlam = f.attr("CATLAM").and_then(AttrValue::as_int);
    let colour = raw_list(f, "COLOUR");
    if bcnshp == Some(1) && catlam == Some(2) && colour.is_none() {
        return Some("besom_point_down");
    }
    if bcnshp == Some(1) && catlam == Some(1) && colour.is_none() {
        return Some("besom_point_up");
    }
    topmark_overlay_common(f, colour)
}

/// The CATSPM/CATCAM arms shared by both `topmark-buoy` and `topmark-beacon`
/// (and buoy's extra `COLOUR == "3,1"` -> sphere/red arm is checked by the
/// caller first — beacons don't have it).
fn topmark_overlay_common(f: &Feature, colour: Option<String>) -> Option<&'static str> {
    if colour.as_deref() == Some("2,3,2") {
        return Some("2_spheres/black");
    }
    if raw_list(f, "CATSPM").as_deref() == Some("46") {
        return Some("flag/generic");
    }
    match f.attr("CATCAM").and_then(AttrValue::as_int) {
        Some(1) => Some("2_cones_up/black"),
        Some(2) => Some("2_cones_base_together/black"),
        Some(3) => Some("2_cones_down/black"),
        Some(4) => Some("2_cones_point_together/black"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{Extent, WorldXy};
    use crate::model::CellMeta;

    fn point_feature(acronym: &str, at: WorldXy, attrs: &[(&str, AttrValue)]) -> Feature {
        let map = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Feature::new(0, acronym.into(), map, Some(Geometry::Point(at)))
    }

    fn cell(features: Vec<Feature>) -> Cell {
        Cell {
            meta: CellMeta::default(),
            extent: Extent::invalid(),
            features,
        }
    }

    fn lup_fixture() -> S52Data {
        let mut d = S52Data::default();
        d.parse_xml(
            r#"<lookups>
            <lookup id="1" RCID="1" name="TOPMAR"><type>Point</type>
              <disp-prio>Point Symbol</disp-prio><table-name>Paper</table-name>
              <attrib-code index="0">TOPSHP1</attrib-code>
              <instruction>CS(TOPMAR01)</instruction><display-cat>Standard</display-cat></lookup>
            <lookup id="2" RCID="2" name="TOPMAR"><type>Point</type>
              <disp-prio>Point Symbol</disp-prio><table-name>Paper</table-name>
              <instruction>SY(TOPMAR01)</instruction><display-cat>Standard</display-cat></lookup>
            <lookup id="3" RCID="3" name="TOPMAR"><type>Point</type>
              <disp-prio>Point Symbol</disp-prio><table-name>Simplified</table-name>
              <instruction></instruction><display-cat>Standard</display-cat></lookup>
            <lookup id="4" RCID="4" name="BOYLAT"><type>Point</type>
              <disp-prio>Hazards</disp-prio><table-name>Simplified</table-name>
              <attrib-code index="0">COLOUR4</attrib-code>
              <instruction>SY(BOYLAT24);TE('by %s','OBJNAM',2,1,2,'15110',-1,-1,CHBLK,21)</instruction>
              <display-cat>Standard</display-cat></lookup>
            <lookup id="5" RCID="5" name="BOYLAT"><type>Point</type>
              <disp-prio>Hazards</disp-prio><table-name>Paper</table-name>
              <instruction>SY(BOYSPR01)</instruction><display-cat>Standard</display-cat></lookup>
            </lookups>"#,
        );
        d
    }

    #[test]
    fn floating_join_is_exact_coordinate_and_rigid_wins_ties() {
        let at_buoy = WorldXy::new(100, 200);
        let at_beacon = WorldXy::new(300, 400);
        let at_both = WorldXy::new(500, 600);
        let lone = WorldXy::new(700, 800);
        let mut c = cell(vec![
            point_feature("BOYLAT", at_buoy, &[]),
            point_feature("BCNLAT", at_beacon, &[]),
            point_feature("BOYSPP", at_both, &[]),
            point_feature("BCNSPP", at_both, &[]),
            point_feature("TOPMAR", at_buoy, &[("TOPSHP", AttrValue::Int(1))]),
            point_feature("TOPMAR", at_beacon, &[("TOPSHP", AttrValue::Int(1))]),
            point_feature("TOPMAR", at_both, &[("TOPSHP", AttrValue::Int(1))]),
            point_feature("TOPMAR", lone, &[("TOPSHP", AttrValue::Int(1))]),
        ]);
        apply(&mut c, Some(&lup_fixture()));
        let flt = |i: usize| c.features[i].attr("floating").is_some();
        assert!(flt(4), "topmark on a buoy floats");
        assert!(!flt(5), "topmark on a beacon is rigid");
        assert!(!flt(6), "rigid wins the tie");
        assert!(!flt(7), "lone topmark defaults rigid");
        // `floating` no longer feeds symbol choice: both the floating and
        // the rigid TOPSHP=1 topmark resolve to the identical TOPSHP-keyed
        // name (unlike the old TOPMAR02-vs-TOPMAR22 CS(TOPMAR01) split).
        // …but each DOES name the body it caps, so `stack_overlay` can pad
        // its sprite against that body's own mast height and lean
        // (`body_keys`; rigid wins the shared coordinate at index 6).
        let sym = |i: usize| c.features[i].attr("sym_s").and_then(AttrValue::as_str);
        assert_eq!(sym(4), Some("TOPSHP/1/0/0@BOYSHP/5/0/2"));
        assert_eq!(sym(5), Some("TOPSHP/1/0/0@BCNSHP/5/0/2"));
        assert_eq!(sym(7), Some("TOPSHP/1/0/0"), "no body under it, no mount");
        // non-TOPMAR aton classes never get `floating`
        assert!(c.features[0].attr("floating").is_none());
    }

    #[test]
    fn buoy_beacon_symbols_and_labels() {
        let mut c = cell(vec![point_feature(
            "BOYLAT",
            WorldXy::new(1, 2),
            &[
                ("COLOUR", AttrValue::StrList(vec!["4".into()])),
                ("OBJNAM", AttrValue::Str("No 7".into())),
            ],
        )]);
        apply(&mut c, Some(&lup_fixture()));
        let f = &c.features[0];
        // BOYSHP/COLPAT absent -> defaults 5/0, COLOUR "4" -> BOYSHP/5/0/4
        assert_eq!(
            f.attr("sym_s"),
            Some(&AttrValue::Str("BOYSHP/5/0/4".into()))
        );
        // label resolution is untouched, still LUP-driven — off the
        // Simplified table only (the Paper LUP in this fixture has no TE at
        // all, which is why `lbl_s` is the half that survived qpznkrtr)
        assert_eq!(f.attr("lbl_s"), Some(&AttrValue::Str("by No 7".into())));
    }

    #[test]
    fn beacon_withy_special_case_needs_no_colour() {
        let withy_starboard = point_feature(
            "BCNLAT",
            WorldXy::new(0, 0),
            &[("BCNSHP", AttrValue::Int(2)), ("CATLAM", AttrValue::Int(2))],
        );
        let withy_port = point_feature(
            "BCNLAT",
            WorldXy::new(0, 0),
            &[("BCNSHP", AttrValue::Int(2)), ("CATLAM", AttrValue::Int(1))],
        );
        // same shape/category but WITH a colour -> falls through to the
        // general BCNSHP/COLPAT/COLOUR scheme instead
        let coloured = point_feature(
            "BCNLAT",
            WorldXy::new(0, 0),
            &[
                ("BCNSHP", AttrValue::Int(2)),
                ("CATLAM", AttrValue::Int(2)),
                ("COLOUR", AttrValue::StrList(vec!["3".into()])),
            ],
        );
        let mut c = cell(vec![withy_starboard, withy_port, coloured]);
        apply(&mut c, None);
        let s = |i: usize| c.features[i].attr("sym_s").and_then(AttrValue::as_str);
        assert_eq!(s(0), Some("withy-starboard"));
        assert_eq!(s(1), Some("withy-port"));
        assert_eq!(s(2), Some("BCNSHP/2/0/3"));
    }

    #[test]
    fn beacon_real_fixture_shapes_spot_check() {
        // BCNLAT/BCNSPP attribute shapes as decoded from US5OAKIQ.000
        // (chartcore/examples/dump_aton.rs): BCNSHP/CATLAM are scalar Int,
        // COLOUR/CATSPM are single-element StrList, and one BCNSPP record
        // has a present-but-EMPTY COLOUR (StrList([])) — the case raw_list
        // treats as absent.
        let lat = point_feature(
            "BCNLAT",
            WorldXy::new(0, 0),
            &[
                ("BCNSHP", AttrValue::Int(1)),
                ("CATLAM", AttrValue::Int(1)),
                ("COLOUR", AttrValue::StrList(vec!["4".into()])),
            ],
        );
        let spp_empty_colour = point_feature(
            "BCNSPP",
            WorldXy::new(0, 0),
            &[
                ("BCNSHP", AttrValue::Int(1)),
                ("CATSPM", AttrValue::StrList(vec!["10".into()])),
                ("COLOUR", AttrValue::StrList(vec![])),
            ],
        );
        let mut c = cell(vec![lat, spp_empty_colour]);
        apply(&mut c, None);
        assert_eq!(
            c.features[0].attr("sym_s").and_then(AttrValue::as_str),
            Some("BCNSHP/1/0/4")
        );
        // empty COLOUR list -> treated as absent -> default 2, no topmark
        // overlay (CATSPM "10" != "46", no CATCAM, CATLAM absent so besom
        // arms don't fire either)
        assert_eq!(
            c.features[1].attr("sym_s").and_then(AttrValue::as_str),
            Some("BCNSHP/1/0/2")
        );
        assert!(c.features[1].attr("sym_topmark").is_none());
    }

    #[test]
    fn topmark_beacon_overlay_besom_and_stacked_categories() {
        let besom_down = point_feature(
            "BCNLAT",
            WorldXy::new(0, 0),
            &[("BCNSHP", AttrValue::Int(1)), ("CATLAM", AttrValue::Int(2))],
        );
        let besom_up = point_feature(
            "BCNLAT",
            WorldXy::new(0, 0),
            &[("BCNSHP", AttrValue::Int(1)), ("CATLAM", AttrValue::Int(1))],
        );
        let cardinal = point_feature(
            "BCNCAR",
            WorldXy::new(0, 0),
            &[("CATCAM", AttrValue::Int(3))],
        );
        let special = point_feature(
            "BCNSPP",
            WorldXy::new(0, 0),
            &[("CATSPM", AttrValue::StrList(vec!["46".into()]))],
        );
        let two_spheres = point_feature(
            "BCNISD",
            WorldXy::new(0, 0),
            &[(
                "COLOUR",
                AttrValue::StrList(vec!["2".into(), "3".into(), "2".into()]),
            )],
        );
        let mut c = cell(vec![besom_down, besom_up, cardinal, special, two_spheres]);
        apply(&mut c, None);
        let ov = |i: usize| {
            c.features[i]
                .attr("sym_topmark")
                .and_then(AttrValue::as_str)
        };
        assert_eq!(ov(0), Some("besom_point_down"));
        assert_eq!(ov(1), Some("besom_point_up"));
        assert_eq!(ov(2), Some("2_cones_down/black"));
        assert_eq!(ov(3), Some("flag/generic"));
        assert_eq!(ov(4), Some("2_spheres/black"));
    }

    #[test]
    fn topmark_buoy_overlay_sphere_red_is_buoy_only() {
        let f = point_feature(
            "BOYLAT",
            WorldXy::new(0, 0),
            &[("COLOUR", AttrValue::StrList(vec!["3".into(), "1".into()]))],
        );
        let mut c = cell(vec![f]);
        apply(&mut c, None);
        assert_eq!(
            c.features[0]
                .attr("sym_topmark")
                .and_then(AttrValue::as_str),
            Some("sphere/red")
        );
        // a beacon with the same COLOUR does NOT get sphere/red — only the
        // buoy layer has that arm
        let f = point_feature(
            "BCNLAT",
            WorldXy::new(0, 0),
            &[("COLOUR", AttrValue::StrList(vec!["3".into(), "1".into()]))],
        );
        let mut c = cell(vec![f]);
        apply(&mut c, None);
        assert!(c.features[0].attr("sym_topmark").is_none());
    }

    #[test]
    fn mooring_light_vessel_dir_buoyage_symbols() {
        // MORFAC CATMOR=7 (real fixture shape: no BOYSHP/COLPAT/COLOUR at
        // all) -> the buoy default scheme
        let mooring_buoy = point_feature(
            "MORFAC",
            WorldXy::new(0, 0),
            &[("CATMOR", AttrValue::Int(7))],
        );
        // any other CATMOR -> fixed pilpnt
        let dolphin = point_feature(
            "MORFAC",
            WorldXy::new(0, 0),
            &[("CATMOR", AttrValue::Int(3))],
        );
        let light_vessel = point_feature(
            "LITVES",
            WorldXy::new(0, 0),
            &[("COLOUR", AttrValue::StrList(vec!["4".into()]))],
        );
        let light_vessel_unrecognised = point_feature("LITFLT", WorldXy::new(0, 0), &[]);
        let dir_buoyage_b = point_feature(
            "M_NSYS",
            WorldXy::new(0, 0),
            &[("MARSYS", AttrValue::Int(2))],
        );
        let dir_buoyage_a = point_feature(
            "M_NSYS",
            WorldXy::new(0, 0),
            &[("MARSYS", AttrValue::Int(1))],
        );
        let mut c = cell(vec![
            mooring_buoy,
            dolphin,
            light_vessel,
            light_vessel_unrecognised,
            dir_buoyage_b,
            dir_buoyage_a,
        ]);
        apply(&mut c, None);
        let s = |i: usize| c.features[i].attr("sym_s").and_then(AttrValue::as_str);
        assert_eq!(s(0), Some("BOYSHP/5/0/2"));
        assert_eq!(s(1), Some("pilpnt"));
        assert_eq!(s(2), Some("light_float/green"));
        assert_eq!(s(3), Some("light_float/x"));
        assert_eq!(s(4), Some("dir-buoyage-b"));
        assert_eq!(s(5), Some("dir-buoyage-a"));
    }

    #[test]
    fn no_lup_data_still_derives_floating_and_symbols_but_not_labels() {
        // Symbol resolution is attribute-only now — it no longer needs
        // `s52` data at all, unlike the labels (still LUP-driven).
        let at = WorldXy::new(9, 9);
        let mut c = cell(vec![
            point_feature(
                "BOYLAT",
                at,
                &[("COLOUR", AttrValue::StrList(vec!["4".into()]))],
            ),
            point_feature("TOPMAR", at, &[("TOPSHP", AttrValue::Int(1))]),
        ]);
        apply(&mut c, None);
        assert_eq!(
            c.features[0].attr("sym_s").and_then(AttrValue::as_str),
            Some("BOYSHP/5/0/4")
        );
        assert!(c.features[0].attr("lbl_s").is_none());
        assert_eq!(c.features[1].attr("floating"), Some(&AttrValue::Bool(true)));
        assert_eq!(
            c.features[1].attr("sym_s").and_then(AttrValue::as_str),
            Some("TOPSHP/1/0/0@BOYSHP/5/0/4"),
            "the topmark names the co-located buoy it is mounted on"
        );
    }

    #[test]
    fn attribute_less_topmark_gets_the_topshp_default() {
        // no TOPSHP/COLPAT/COLOUR -> the coalesce defaults 3/0/0, matching
        // s57.json's own literal fallback string for the `topmark` layer.
        let mut c = cell(vec![point_feature("TOPMAR", WorldXy::new(1, 1), &[])]);
        apply(&mut c, Some(&lup_fixture()));
        assert_eq!(
            c.features[0].attr("sym_s"),
            Some(&AttrValue::Str("TOPSHP/3/0/0".into()))
        );
    }
}
