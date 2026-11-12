// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

// Golden checks on the decoded NOAA `.000` fixture — needs the GDAL-backed
// reader, so the whole file compiles out of the default (gdal-free) build.
// See the `s57-ingest` feature in Cargo.toml.
#![cfg(feature = "s57-ingest")]

//! Phase 5 golden tests: the aids-&-hazards derived attributes on the real
//! NOAA fixture cell (US5OAKIQ.000 — 20 LIGHTS, 15 BCNLAT, 4 BCNSPP,
//! 16 DAYMAR, 6 OBSTRN, 3 WRECKS, 6 RESARE, 6 CTNARE).
//!
//! ATON `sym_s` are attribute-resolved now (jt uzosnxzs — a Rust
//! port of quantenschaum/mapping's `s57.json`, [`chartcore::derive::aton`]),
//! not looked up against `chartsymbols.xml` — the fixture LUP tables below
//! feed only `lbl_s` (still LUP-driven) and `scamin` exemption.
//! `tests/fixtures/lups-fixture.xml` is the complete row sets of
//! [`FIXTURE_CLASSES`], `<lookup>` records extracted verbatim (main file +
//! LUPPatch*) from the pinned ochartsng `chartsymbols.xml` (commit
//! [`chartcore::s52::UPSTREAM_COMMIT`]), so `cargo test` never touches the
//! network. `full_xml_agrees` additionally cross-checks the subset against a
//! full s57data directory when `MIVNAV_S57DATA` is set, and skips silently
//! otherwise — its `sym_s` comparison is trivially equal on both
//! sides now (neither depends on the LUP data anymore); `lbl_s`/
//! `scamin` are the checks that still exercise the lookup tables.
//!
//! Expected symbol names were derived by hand from `chartcore::derive::aton`
//! (the s57.json port); expected `litdsn` strings from the LITDSN01
//! formatting rules; `encl_drval1` values cross-checked against the
//! fixture's DEPARE polygons.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::model::{AttrValue, Cell, Feature};
use chartcore::s52;
use chartcore::s57::{read_cell, S57OpenOptions};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// The decoded + fully derived cell, shared across tests.
fn cell() -> &'static Cell {
    static CELL: OnceLock<Cell> = OnceLock::new();
    CELL.get_or_init(|| {
        let lups = s52::load(&fixtures().join("lups-fixture.xml")).expect("LUP fixture loads");
        assert!(!lups.is_empty());
        let mut cell = read_cell(&fixtures().join("US5OAKIQ.000"), &S57OpenOptions::default())
            .expect("fixture decodes");
        chartcore::derive::apply_with(&mut cell, Some(&lups));
        cell
    })
}

fn s<'a>(f: &'a Feature, key: &str) -> Option<&'a str> {
    f.attr(key).and_then(AttrValue::as_str)
}

fn fl(f: &Feature, key: &str) -> Option<f64> {
    f.attr(key).and_then(AttrValue::as_float)
}

fn colour(f: &Feature) -> Vec<i64> {
    f.attr("COLOUR")
        .and_then(AttrValue::as_int_list)
        .unwrap_or_default()
}

#[test]
fn bcnlat_symbols_and_labels() {
    let beacons: Vec<&Feature> = cell().features_of("BCNLAT").collect();
    assert_eq!(beacons.len(), 15);
    for f in beacons {
        // every BCNLAT here is a stake (BCNSHP=1), green (4) or red (3)
        assert_eq!(f.attr("BCNSHP").and_then(AttrValue::as_int), Some(1));
        // sym_s: attribute-resolved BCNSHP/COLPAT/COLOUR (jt uzosnxzs,
        // ported from quantenschaum/mapping's s57.json `beacon` layer, which
        // has no Paper/Simplified split — hence the single key, qpznkrtr).
        let sym = match colour(f).as_slice() {
            [4] => "BCNSHP/1/0/4",
            [3] => "BCNSHP/1/0/3",
            other => panic!("unexpected COLOUR {other:?}"),
        };
        assert_eq!(s(f, "sym_s"), Some(sym), "rcid {:?}", f.rcid);
        // lbl_s are still the LUP-fixture's TE('%s','OBJNAM',…), unchanged
        let objnam = s(f, "OBJNAM").expect("fixture beacons are named");
        assert_eq!(s(f, "lbl_s"), Some(objnam));
    }
}

#[test]
fn bcnspp_symbols() {
    let mut by_shape: BTreeMap<i64, Vec<&Feature>> = BTreeMap::new();
    for f in cell().features_of("BCNSPP") {
        by_shape
            .entry(f.attr("BCNSHP").and_then(AttrValue::as_int).unwrap())
            .or_default()
            .push(f);
    }
    // one pile beacon (BCNSHP=4, COLOUR=1)
    assert_eq!(by_shape[&4].len(), 1);
    assert_eq!(s(by_shape[&4][0], "sym_s"), Some("BCNSHP/4/0/1"));
    // four USGS poles (BCNSHP=1) with COLOUR present-but-empty — treated as
    // absent (see `aton::raw_list`), so COLOUR falls to its default (2)
    assert_eq!(by_shape[&1].len(), 4);
    for f in &by_shape[&1] {
        assert_eq!(f.attr("COLOUR"), Some(&AttrValue::StrList(vec![])));
        assert_eq!(s(f, "sym_s"), Some("BCNSHP/1/0/2"));
    }
}

/// Every daymark in this cell caps a real beacon on the beacon's OWN
/// coordinate, so every emitted key carries that beacon's own symbol as its
/// mount reference (`aton::body_keys`, jt task vplwqzmr) — which is what
/// lets `icons::composite::stack_overlay` pad the daymark sprite against the
/// mast height and lean of the shape it actually sits on, instead of a fixed
/// `pillar` stand-in. This is the fixture-backed proof that the join fires
/// on real chart data, not just on synthetic features.
#[test]
fn daymar_symbols() {
    let mut squares = 0;
    let mut triangles = 0;
    for f in cell().features_of("DAYMAR") {
        match f.attr("TOPSHP").and_then(AttrValue::as_int) {
            Some(19) => {
                // green square board: TOPSHP19 + COLPAT6 + COLOUR"4,4",
                // always on a green USGS pole (BCNSHP=1, COLOUR=4)
                assert_eq!(colour(f), vec![4, 4]);
                assert_eq!(s(f, "sym_s"), Some("TOPSHP/19/6/4,4@BCNSHP/1/0/4"));
                squares += 1;
            }
            Some(24) => {
                // red triangle board: TOPSHP24 + COLPAT6 + COLOUR"3,3", on a
                // red pole or (once) on a white BCNSPP tower
                assert_eq!(colour(f), vec![3, 3]);
                assert!(
                    matches!(
                        s(f, "sym_s"),
                        Some("TOPSHP/24/6/3,3@BCNSHP/1/0/3" | "TOPSHP/24/6/3,3@BCNSHP/4/0/1")
                    ),
                    "unexpected mount: {:?}",
                    s(f, "sym_s")
                );
                triangles += 1;
            }
            other => panic!("unexpected TOPSHP {other:?}"),
        }
        // no OBJNAM on the fixture's daymarks -> no labels
        assert_eq!(s(f, "lbl_s"), None);
    }
    assert_eq!((squares, triangles), (9, 7));
}

#[test]
fn lights_flares_colours_and_descriptions() {
    let lights: Vec<&Feature> = cell().features_of("LIGHTS").collect();
    assert_eq!(lights.len(), 20);
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for f in lights {
        // non-sectored minor lights: flare by colour, never a ring or arc
        assert!(f.attr("lit_arc").is_none());
        assert!(f.attr("lit_ring_off").is_none());
        assert!(f.attr("sym_extra").is_none());
        let (sym, col) = match colour(f).as_slice() {
            [3] => ("light/red", "LITRD"),
            [4] => ("light/green", "LITGN"),
            [6] => ("light/yellow", "LITYW"),
            other => panic!("unexpected COLOUR {other:?}"),
        };
        assert_eq!(s(f, "sym"), Some(sym), "rcid {:?}", f.rcid);
        assert_eq!(s(f, "lit_col"), Some(col), "rcid {:?}", f.rcid);
        *counts.entry(sym).or_default() += 1;
        assert!(s(f, "litdsn").is_some());
    }
    assert_eq!(
        counts,
        BTreeMap::from([("light/red", 7), ("light/green", 9), ("light/yellow", 4)])
    );

    // pinned description strings (C printf width padding preserved)
    let by_rcid = |rcid: u32| {
        cell()
            .features_of("LIGHTS")
            .find(|f| f.rcid == Some(rcid))
            .unwrap_or_else(|| panic!("no LIGHTS rcid {rcid}"))
    };
    // rcid 37: Fl green, 4s, 4.6 m, 4 nm
    let f = by_rcid(37);
    assert_eq!(s(f, "litdsn"), Some("FlG 4s  5m 4Nm"));
    assert_eq!(s(f, "litdsn_ft"), Some("FlG 4s 15ft 4Nm"));
    assert_eq!(s(f, "litdsn_fm"), Some("FlG 4s  3fm 4Nm"));
    // rcid 38: fractional period
    assert_eq!(s(by_rcid(38), "litdsn"), Some("FlG 2.5s  5m 3Nm"));
    // rcid 52: red, 6.1 m
    assert_eq!(s(by_rcid(52), "litdsn"), Some("FlR 2.5s  6m 3Nm"));
    // rcid 53: yellow USGS pole — no HEIGHT/VALNMR, so no ft/fm variants
    let f = by_rcid(53);
    assert_eq!(s(f, "litdsn"), Some("FlY 2s"));
    assert!(f.attr("litdsn_ft").is_none());
    assert!(f.attr("litdsn_fm").is_none());
}

#[test]
fn obstrn_derived() {
    let obstructions: Vec<&Feature> = cell().features_of("OBSTRN").collect();
    assert_eq!(obstructions.len(), 6);
    for f in &obstructions {
        assert_eq!(s(f, "dispcat"), Some("standard"));
        assert!(f.attr("snd").is_none(), "no VALSOU in the fixture");
    }
    // the one line obstruction: dotted boundary
    let line = obstructions.iter().find(|f| f.rcid == Some(183)).unwrap();
    assert_eq!(s(line, "lsty"), Some("dott"));
    assert_eq!(fl(line, "depth_value"), Some(0.01));
    // rcid 186 sits on a QUAPOS=4 ("position approximate") spatial record:
    // the lifted quapos becomes the CSQUAPNT01 "PA" marker
    for f in &obstructions {
        let expect = (f.rcid == Some(186)).then_some("QUAPOS01");
        assert_eq!(s(f, "sym_pos"), expect, "rcid {:?}", f.rcid);
    }
    // points: WATLEV 3 -> OBSTRN01/0.01, WATLEV 4 -> OBSTRN03/-15 — both
    // chartsymbols tokens now emit the one vendored `obstruction` icon
    // (assets/s52-icons/port-map.json), so only depth_value tells them apart
    for (rcid, sym, depth) in [
        (184, "obstruction", 0.01),
        (185, "obstruction", 0.01), // CATOBS=1 is not a LUP-direct row
        (186, "obstruction", -15.0),
        (187, "obstruction", 0.01),
        (188, "obstruction", 0.01),
    ] {
        let f = obstructions.iter().find(|f| f.rcid == Some(rcid)).unwrap();
        assert_eq!(s(f, "sym"), Some(sym), "rcid {rcid}");
        assert_eq!(fl(f, "depth_value"), Some(depth), "rcid {rcid}");
    }
}

#[test]
fn wrecks_derived() {
    let wrecks: Vec<&Feature> = cell().features_of("WRECKS").collect();
    assert_eq!(wrecks.len(), 3);
    let by_rcid = |rcid: u32| {
        wrecks
            .iter()
            .find(|f| f.rcid == Some(rcid))
            .copied()
            .unwrap()
    };

    // rcid 189: CATWRK=5, WATLEV=2, no VALSOU -> official WRECKS01 (D1),
    // emitted as the vendored `wreck-non-dangerous`
    let f = by_rcid(189);
    assert_eq!(fl(f, "depth_value"), Some(-15.0));
    assert_eq!(s(f, "sym"), Some("wreck-non-dangerous"));
    assert!(f.attr("snd").is_none());

    // rcid 190: VALSOU=6.4 -> no baked sym (client picks DANGER51/52),
    // sounding text, QUASOU=6 is not "depth unknown"
    let f = by_rcid(190);
    assert_eq!(fl(f, "depth_value"), Some(6.4));
    assert!(f.attr("sym").is_none());
    assert_eq!(f.attr("snd"), Some(&AttrValue::Bool(true)));
    assert!(f.attr("quasou7").is_none());

    // rcid 191: CATWRK=2, WATLEV=3, no VALSOU -> depth 0, WRECKS05 ->
    // vendored `wreck-hull_showing`
    let f = by_rcid(191);
    assert_eq!(fl(f, "depth_value"), Some(0.0));
    assert_eq!(s(f, "sym"), Some("wreck-hull_showing"));
}

#[test]
fn hazard_enclosing_depth_areas() {
    // every fixture hazard lies inside some DEPARE; pin the resolved
    // enclosing drval1 (cross-checked against the DEPARE polygons)
    let pins: &[(&str, u32, f64)] = &[
        ("WRECKS", 189, ENCL_WRECKS_189),
        ("WRECKS", 190, ENCL_WRECKS_190),
        ("WRECKS", 191, ENCL_WRECKS_191),
        ("OBSTRN", 184, ENCL_OBSTRN_184),
        ("OBSTRN", 186, ENCL_OBSTRN_186),
    ];
    for (class, rcid, expect) in pins {
        let f = cell()
            .features_of(class)
            .find(|f| f.rcid == Some(*rcid))
            .unwrap();
        assert_eq!(fl(f, "encl_drval1"), Some(*expect), "{class} rcid {rcid}");
    }
}

// Pinned from the fixture's DEPARE polygons (see hazard_enclosing_depth_areas):
// the shoal wrecks/obstructions sit in 0 m areas, the submerged wreck 190 in
// the 5.4-9.1 m channel, the drying obstruction 186 inside the 1.8 m band —
// all members of the cell's contour set {0, 1.8, 5.4, 9.1}.
const ENCL_WRECKS_189: f64 = 0.0;
const ENCL_WRECKS_190: f64 = 5.4;
const ENCL_WRECKS_191: f64 = 0.0;
const ENCL_OBSTRN_184: f64 = 0.0;
const ENCL_OBSTRN_186: f64 = 1.8;

#[test]
fn restricted_areas_derived() {
    for f in cell().features_of("RESARE") {
        // RESTRN = {8} (entry restricted), no CATREA. `sym` is a vendored
        // icon name now; `lc` is still a chartsymbols.xml line-pattern
        // token — two namespaces, only one of them ported.
        assert_eq!(s(f, "sym"), Some("no-entry"));
        assert_eq!(s(f, "lc"), Some("RESARE51"));
        assert_eq!(s(f, "bcol"), Some("CHMGD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(2)));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(6)));
        assert!(f.attr("sym_cs").is_none());
    }
    assert_eq!(cell().features_of("RESARE").count(), 6);
    for f in cell().features_of("CTNARE") {
        assert_eq!(s(f, "sym"), Some("caution"));
        assert_eq!(s(f, "lc"), Some("CTNARE51"));
        assert_eq!(s(f, "bcol"), Some("TRFCD"));
        assert_eq!(f.attr("bwid"), Some(&AttrValue::Int(2)));
        assert_eq!(f.attr("dpri"), Some(&AttrValue::Int(3)));
    }
    assert_eq!(cell().features_of("CTNARE").count(), 6);
}

/// The classes the LUP fixture carries complete row sets for. Outside them
/// the subset resolves nothing, which is visible in `scamin` (the full
/// tables gate many more classes) but not in the ATON symbols.
const FIXTURE_CLASSES: [&str; 8] = [
    "BCNLAT", "BCNSPP", "DAYMAR", "LIGHTS", "TOPMAR", "CBLOHD", "DEPCNT", "SOUNDG",
];

/// Cross-check: resolving against a full s57data directory (chartsymbols.xml
/// plus patches) produces the same ATON symbols as the committed fixture
/// subset, and the same SCAMIN gate for the classes the subset covers.
/// Runs only when MIVNAV_S57DATA points at such a directory.
#[test]
fn full_xml_agrees_with_fixture_subset() {
    let Ok(dir) = std::env::var("MIVNAV_S57DATA") else {
        eprintln!("MIVNAV_S57DATA not set; skipping full-xml cross-check");
        return;
    };
    let full = s52::load(std::path::Path::new(&dir)).expect("full s57data loads");
    let mut other = read_cell(&fixtures().join("US5OAKIQ.000"), &S57OpenOptions::default())
        .expect("fixture decodes");
    chartcore::derive::apply_with(&mut other, Some(&full));
    for (a, b) in cell().features.iter().zip(&other.features) {
        for key in ["sym_s", "lbl_s"] {
            assert_eq!(
                a.attr(key),
                b.attr(key),
                "{} rcid {:?} {key}",
                a.acronym,
                a.rcid
            );
        }
        if FIXTURE_CLASSES.contains(&a.acronym.as_str()) {
            assert_eq!(
                a.attr("scamin"),
                b.attr("scamin"),
                "{} rcid {:?}",
                a.acronym,
                a.rcid
            );
        }
    }
    // the full tables gate classes the subset cannot resolve — so the
    // subset's silence there is missing lookups, not a missing gate
    assert!(other
        .features
        .iter()
        .any(|f| f.attr("scamin").is_some() && !FIXTURE_CLASSES.contains(&f.acronym.as_str())));
}
