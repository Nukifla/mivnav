// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

// GDAL-backed `.000` ingest — dev-box-only, off the Pi wheel. Whole file
// compiles out of the default (gdal-free) build. See the `s57-ingest`
// feature in Cargo.toml.
#![cfg(feature = "s57-ingest")]

//! Integration tests for the GDAL-backed S-57 reader against a real NOAA
//! ENC cell.
//!
//! Fixture: `US5OAKIQ.000` (edition 1, update 0, 1:12000 harbor cell,
//! Sacramento River delta; lon [-121.725, -121.65], lat [38.025, 38.1]).
//! All expected values below were derived with `ogrinfo` (GDAL 3.13.1) on
//! the same file, e.g. `ogrinfo -ro -so US5OAKIQ.000 DEPARE`.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::LLBox;
use chartcore::model::{AttrValue, Cell, Geometry};
use chartcore::s57::{read_cell, S57OpenOptions};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/US5OAKIQ.000")
}

/// The decoded cell, shared across tests (GDAL open + full decode once).
fn cell() -> &'static Cell {
    static CELL: OnceLock<Cell> = OnceLock::new();
    CELL.get_or_init(|| {
        read_cell(&fixture_path(), &S57OpenOptions::default()).expect("fixture decodes")
    })
}

#[test]
fn cell_metadata() {
    let meta = &cell().meta;
    assert_eq!(meta.name, "US5OAKIQ.000");
    assert_eq!(meta.edition, 1);
    assert_eq!(meta.update, 0);
    assert_eq!(meta.compilation_scale, 12000);
}

#[test]
fn feature_counts_match_ogrinfo() {
    // ogrinfo -ro -so US5OAKIQ.000 <layer> | grep 'Feature Count'
    for (acronym, expected) in [
        ("DEPARE", 78),
        ("DEPCNT", 85),
        ("LIGHTS", 20),
        ("SOUNDG", 16),
        ("LNDARE", 19),
        ("BCNLAT", 15),
        ("M_COVR", 1),
    ] {
        assert_eq!(
            cell().features_of(acronym).count(),
            expected,
            "{acronym} count"
        );
    }
    // sum over all 39 non-DSID layers (ogrinfo total 513 including DSID)
    assert_eq!(cell().features.len(), 512);
}

#[test]
fn type_codes_and_metadata_fields() {
    // S-57 object class codes: DEPARE=42, LIGHTS=75, M_COVR=302
    assert!(cell().features_of("DEPARE").all(|f| f.type_code == 42));
    assert!(cell().features_of("LIGHTS").all(|f| f.type_code == 75));
    assert!(cell().features_of("M_COVR").all(|f| f.type_code == 302));
    // LNAM_REFS=ON (default) exposes the 16-hex-digit LNAM unique id
    assert!(cell()
        .features_of("LIGHTS")
        .all(|f| f.lnam.as_deref().is_some_and(|l| l.len() == 16)));
    assert!(cell().features.iter().all(|f| f.rcid.is_some()));
    // control fields must not leak into the attribute map
    for key in [
        "OBJL", "RCID", "LNAM", "PRIM", "GRUP", "FIDN", "FIDS", "AGEN", "RVER",
    ] {
        assert!(
            cell().features.iter().all(|f| f.attr(key).is_none()),
            "{key} leaked"
        );
    }
}

#[test]
fn geometry_within_cell_bounds_in_world_coords() {
    // ogrinfo extent: (-121.725, 38.025) - (-121.65, 38.1)
    let bounds = LLBox {
        w_lon: -121.725,
        e_lon: -121.65,
        n_lat: 38.1,
        s_lat: 38.025,
    }
    .to_world();
    // one world unit of slack for rounding at the exact boundary
    let bounds = bounds.expanded(1, 1);

    assert!(cell().extent.valid);
    assert!(
        bounds.includes(&cell().extent),
        "cell extent exceeds chart bounds"
    );
    // the cell spans most of its declared bounds, not a degenerate corner
    assert!(
        (cell().extent.xmax - cell().extent.xmin) as f64 > 0.9 * (bounds.xmax - bounds.xmin) as f64
    );

    let mut with_geometry = 0;
    for f in &cell().features {
        if let Some(g) = &f.geometry {
            with_geometry += 1;
            let e = g.extent();
            assert!(e.valid, "{} rcid {:?}: empty geometry", f.acronym, f.rcid);
            assert!(
                bounds.includes(&e),
                "{} rcid {:?}: out of bounds",
                f.acronym,
                f.rcid
            );
            assert_eq!(e, f.extent);
        }
    }
    assert_eq!(
        with_geometry, 512,
        "every feature in this cell has geometry"
    );
}

#[test]
fn scamin_extracted() {
    // every LIGHTS feature in this cell has SCAMIN = 29999 (ogrinfo)
    assert!(cell()
        .features_of("LIGHTS")
        .all(|f| f.scamin == Some(29999)));
    // and SCAMIN is also still in the attribute map as S-57 truth
    assert!(cell()
        .features_of("LIGHTS")
        .all(|f| f.attr("SCAMIN").and_then(AttrValue::as_int) == Some(29999)));
}

#[test]
fn list_attributes_stay_lists() {
    // COLOUR is an enum-list attribute; OGR's S57 driver delivers it as a
    // string list of numeric codes. Every light here has exactly one colour,
    // from {3 = red, 4 = green, 6 = yellow} (ogrinfo).
    for f in cell().features_of("LIGHTS") {
        let colour = f.attr("COLOUR").expect("light has COLOUR");
        assert!(colour.is_list());
        let codes = colour.as_int_list().unwrap();
        assert_eq!(codes.len(), 1);
        assert!([3, 4, 6].contains(&codes[0]), "unexpected colour {codes:?}");
    }
    // CATLIT arrives as an *empty* list on these lights — set but empty,
    // which must be preserved (distinct from absent).
    assert!(cell()
        .features_of("LIGHTS")
        .all(|f| f.attr("CATLIT") == Some(&AttrValue::StrList(vec![]))));
}

#[test]
fn soundings_are_3d_multipoints() {
    for f in cell().features_of("SOUNDG") {
        let Some(Geometry::MultiPoint(points)) = &f.geometry else {
            panic!("SOUNDG should decode as MultiPoint, got {:?}", f.geometry);
        };
        assert!(!points.is_empty());
        for p in points {
            assert!(
                (0.0..=30.0).contains(&p.z),
                "implausible depth {} in a shallow delta cell",
                p.z
            );
        }
    }
}

#[test]
fn m_covr_coverage_polygon() {
    let covr: Vec<_> = cell().features_of("M_COVR").collect();
    assert_eq!(covr.len(), 1);
    let covr = covr[0];
    // CATCOV = 1: area of continuous coverage
    assert_eq!(covr.attr("CATCOV").and_then(AttrValue::as_int), Some(1));
    let Some(Geometry::Areas(polys)) = &covr.geometry else {
        panic!("M_COVR should be an area, got {:?}", covr.geometry);
    };
    assert_eq!(polys.len(), 1);
    let ring = &polys[0].outer;
    assert!(ring.len() >= 4);
    assert_eq!(ring.first(), ring.last(), "outer ring is closed");
    // the coverage polygon spans the whole cell
    assert_eq!(covr.extent, cell().extent);
}

#[test]
fn polygons_with_holes_survive() {
    // ogrinfo shows 20 polygons with interior rings in this cell
    let holed: usize = cell()
        .features
        .iter()
        .filter_map(|f| match &f.geometry {
            Some(Geometry::Areas(polys)) => {
                Some(polys.iter().filter(|p| !p.holes.is_empty()).count())
            }
            _ => None,
        })
        .sum();
    assert_eq!(holed, 20);
}

#[test]
fn spatial_quapos_lifted_from_primitives() {
    // ogrinfo with RETURN_PRIMITIVES=ON: 61 spatial records carry QUAPOS=4
    // (52 edges, 9 isolated nodes); these are the features referencing them
    for (acronym, expected) in [("COALNE", 9), ("DEPCNT", 15), ("LNDARE", 7), ("SLCONS", 0)] {
        let n = cell()
            .features_of(acronym)
            .filter(|f| !f.spatial_quapos.is_empty())
            .count();
        assert_eq!(n, expected, "{acronym} features with spatial QUAPOS");
    }
    assert!(cell()
        .features
        .iter()
        .flat_map(|f| &f.spatial_quapos)
        .all(|q| *q == 4));
    // the primitive pseudo-layers are consumed by the lift, not emitted
    assert!(cell().features.iter().all(|f| {
        !["IsolatedNode", "ConnectedNode", "Edge", "Face"].contains(&f.acronym.as_str())
    }));
    // opting out leaves the field empty
    let opts = S57OpenOptions {
        lift_spatial_quapos: false,
        ..Default::default()
    };
    let plain = read_cell(&fixture_path(), &opts).expect("fixture decodes");
    assert!(plain.features.iter().all(|f| f.spatial_quapos.is_empty()));
}

#[test]
fn lnam_refs_lifted_and_aid_group_derived() {
    // The S57 driver exposes LNAM_REFS as a StringList on the *structure*
    // (buoy/beacon), listing its slaves' LNAMs (FFPT_RIND=2). This fixture's
    // first BCNLAT (LNAM 022612409D780001) points at a DAYMAR and a LIGHTS.
    let beacon = cell()
        .features_of("BCNLAT")
        .find(|f| f.lnam.as_deref() == Some("022612409D780001"))
        .expect("the referenced beacon exists");
    assert_eq!(
        beacon.lnam_refs,
        vec![
            "02263970732A0001".to_string(), // DAYMAR
            "0226210B95910001".to_string(), // LIGHTS
        ],
        "LNAM_REFS lifted as a string list"
    );

    // The derive pass turns that relationship into a shared aid_group id
    // (the master beacon's LNAM) on every component of the aid.
    let mut c = cell().clone();
    chartcore::derive::apply(&mut c);
    let group_of = |lnam: &str| -> Option<String> {
        c.features
            .iter()
            .find(|f| f.lnam.as_deref() == Some(lnam))
            .and_then(|f| f.attr("aid_group"))
            .and_then(AttrValue::as_str)
            .map(str::to_string)
    };
    assert_eq!(
        group_of("022612409D780001").as_deref(),
        Some("022612409D780001")
    );
    assert_eq!(
        group_of("02263970732A0001").as_deref(),
        Some("022612409D780001")
    );
    assert_eq!(
        group_of("0226210B95910001").as_deref(),
        Some("022612409D780001")
    );

    // At least a dozen aids group in this delta cell; the tag is present.
    let tagged = c
        .features
        .iter()
        .filter(|f| f.attr("aid_group").is_some())
        .count();
    assert!(
        tagged >= 6,
        "expected several grouped aid components, got {tagged}"
    );
}

#[test]
fn split_multipoint_option() {
    // With SPLIT_MULTIPOINT=ON the 16 SOUNDG multipoints explode into one
    // point feature per sounding, carrying a DEPTH attribute.
    let opts = S57OpenOptions {
        split_multipoint: true,
        ..Default::default()
    };
    let split = read_cell(&fixture_path(), &opts).expect("fixture decodes");
    let expected: usize = cell()
        .features_of("SOUNDG")
        .map(|f| match &f.geometry {
            Some(Geometry::MultiPoint(points)) => points.len(),
            _ => 0,
        })
        .sum();
    assert!(expected > 16);
    assert_eq!(split.features_of("SOUNDG").count(), expected);
    for f in split.features_of("SOUNDG") {
        assert!(matches!(f.geometry, Some(Geometry::Point(_))));
        assert!(f.attr("DEPTH").and_then(AttrValue::as_float).is_some());
    }
}
