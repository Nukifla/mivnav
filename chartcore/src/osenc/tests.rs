// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! OSENC decoder round-trip tests against the synthetic writer.

use super::write::{reference_point, sm, RawTuple, SencWriter};
use super::*;
use crate::coords::LLBox;
use crate::model::Polygon;

/// The fixture cell's declared extent: a ~0.1° box in the German Bight.
fn cell_box() -> LLBox {
    LLBox {
        n_lat: 54.60,
        s_lat: 54.50,
        w_lon: 9.00,
        e_lon: 9.10,
    }
}

/// Writer with the standard header (senc.py order).
fn header(version: u16) -> SencWriter {
    let mut w = SencWriter::new();
    w.version(version)
        .cell_name("TEST01")
        .cell_edition(3)
        .cell_update(1)
        .extent(&cell_box())
        .native_scale(12000);
    w
}

fn assert_close(a: WorldXy, b: WorldXy, what: &str) {
    assert!(
        (a.x - b.x).abs() <= 1 && (a.y - b.y).abs() <= 1,
        "{what}: {a:?} != {b:?}"
    );
}

fn assert_ring_close(a: &[WorldXy], b: &[WorldXy], what: &str) {
    assert_eq!(
        a.len(),
        b.len(),
        "{what}: ring lengths differ\n{a:?}\n{b:?}"
    );
    for (i, (pa, pb)) in a.iter().zip(b).enumerate() {
        assert_close(*pa, *pb, &format!("{what}[{i}]"));
    }
}

#[test]
fn header_and_point_feature_round_trip() {
    let mut w = header(201);
    w.feature(75, 7, 1) // LIGHTS
        .attr_int(107, 4) // LITCHR (E) → Int
        .attr_double(179, 12.5) // VALSOU (F) → Float
        .attr_str(116, "Elbe 1") // OBJNAM (A) → Str
        .attr_str(75, "2,4") // COLOUR (L) → StrList
        .attr_int(133, 29999) // SCAMIN → typed field + attribute
        .point_geometry(54.55, 9.05);
    let cell = read_cell(&w.into_bytes()[..]).unwrap();

    assert_eq!(
        cell.meta,
        CellMeta {
            name: "TEST01".into(),
            edition: 3,
            update: 1,
            compilation_scale: 12000
        }
    );
    assert_eq!(cell.features.len(), 1);
    let f = &cell.features[0];
    assert_eq!(f.type_code, 75);
    assert_eq!(f.acronym, "LIGHTS");
    assert_eq!(f.rcid, Some(7));
    assert_eq!(f.lnam, None);
    assert_eq!(f.group, None);
    assert_eq!(f.scamin, Some(29999));
    assert_eq!(f.attr("LITCHR"), Some(&AttrValue::Int(4)));
    assert_eq!(f.attr("VALSOU"), Some(&AttrValue::Float(12.5)));
    assert_eq!(f.attr("OBJNAM"), Some(&AttrValue::Str("Elbe 1".into())));
    // list attribute: comma string split like the GDAL path's string lists
    assert_eq!(
        f.attr("COLOUR"),
        Some(&AttrValue::StrList(vec!["2".into(), "4".into()]))
    );
    assert_eq!(
        f.geometry,
        Some(Geometry::Point(lat_lon_to_world(54.55, 9.05)))
    );
}

#[test]
fn line_feature_via_vector_tables() {
    let rp = reference_point(&cell_box());
    let pts: Vec<(f32, f32)> = [(54.52, 9.02), (54.53, 9.03), (54.54, 9.03)]
        .iter()
        .map(|&(la, lo)| sm(la, lo, rp, 1.0))
        .collect();
    let n1 = sm(54.51, 9.01, rp, 1.0);
    let n2 = sm(54.55, 9.04, rp, 1.0);

    let mut w = header(201);
    w.feature(30, 1, 2) // COALNE
        .line_geometry(&cell_box(), &[RawTuple::with_nodes(1, 10, 2)], 4)
        .edge_table(&[(10, pts)], None)
        .node_table(&[(1, n1), (2, n2)], None);
    let cell = read_cell(&w.into_bytes()[..]).unwrap();

    let f = &cell.features[0];
    assert_eq!(f.acronym, "COALNE");
    let Some(Geometry::Lines(lines)) = &f.geometry else {
        panic!("{:?}", f.geometry)
    };
    assert_eq!(lines.len(), 1);
    let expected: Vec<WorldXy> = [
        (54.51, 9.01),
        (54.52, 9.02),
        (54.53, 9.03),
        (54.54, 9.03),
        (54.55, 9.04),
    ]
    .iter()
    .map(|&(la, lo)| lat_lon_to_world(la, lo))
    .collect();
    assert_ring_close(&lines[0], &expected, "line");
}

#[test]
fn stride3_reversed_edge_at_version_200() {
    let rp = reference_point(&cell_box());
    let pts: Vec<(f32, f32)> = [(54.52, 9.02), (54.53, 9.03)]
        .iter()
        .map(|&(la, lo)| sm(la, lo, rp, 1.0))
        .collect();
    let mut w = header(200);
    // direction != 0 → edge index written negative at stride 3
    w.feature(30, 1, 2)
        .line_geometry(
            &cell_box(),
            &[RawTuple {
                start_node: -1,
                edge: 10,
                end_node: -1,
                direction: 1,
            }],
            3,
        )
        .edge_table(&[(10, pts)], None);
    let cell = read_cell(&w.into_bytes()[..]).unwrap();
    let Some(Geometry::Lines(lines)) = &cell.features[0].geometry else {
        panic!()
    };
    // reversed traversal
    let expected: Vec<WorldXy> = [(54.53, 9.03), (54.52, 9.02)]
        .iter()
        .map(|&(la, lo)| lat_lon_to_world(la, lo))
        .collect();
    assert_ring_close(&lines[0], &expected, "reversed line");
}

/// Square ring of lat/lon corners (closed by the assembler, not here).
fn ring(n: f64, s: f64, w: f64, e: f64) -> Vec<(f64, f64)> {
    vec![(n, w), (n, e), (s, e), (s, w)]
}

fn ring_sm(ring: &[(f64, f64)], rp: WorldXy, scale: f64) -> Vec<(f32, f32)> {
    ring.iter().map(|&(la, lo)| sm(la, lo, rp, scale)).collect()
}

fn ring_world(ring: &[(f64, f64)]) -> Vec<WorldXy> {
    let mut v: Vec<WorldXy> = ring
        .iter()
        .map(|&(la, lo)| lat_lon_to_world(la, lo))
        .collect();
    v.push(v[0]);
    v
}

#[test]
fn area_with_hole_round_trip() {
    let rp = reference_point(&cell_box());
    let outer = ring(54.58, 54.52, 9.02, 9.08);
    let hole = ring(54.56, 54.54, 9.04, 9.06);
    let mut w = header(201);
    w.feature(42, 5, 3) // DEPARE
        .attr_double(87, 2.0) // DRVAL1
        .area_geometry(
            &cell_box(),
            // a dummy triangle group: parsed and dropped
            &[(
                4,
                vec![
                    sm(54.53, 9.03, rp, 1.0),
                    sm(54.53, 9.05, rp, 1.0),
                    sm(54.55, 9.04, rp, 1.0),
                ],
            )],
            &[RawTuple::forward(1), RawTuple::forward(2)],
            4,
            None,
        )
        .edge_table(
            &[(1, ring_sm(&outer, rp, 1.0)), (2, ring_sm(&hole, rp, 1.0))],
            None,
        );
    let cell = read_cell(&w.into_bytes()[..]).unwrap();

    let f = &cell.features[0];
    assert_eq!(f.acronym, "DEPARE");
    assert_eq!(f.attr("DRVAL1"), Some(&AttrValue::Float(2.0)));
    let Some(Geometry::Areas(polys)) = &f.geometry else {
        panic!("{:?}", f.geometry)
    };
    assert_eq!(polys.len(), 1);
    let Polygon { outer: o, holes } = &polys[0];
    assert_eq!(holes.len(), 1);
    // rings are closed; compare as unordered-start closed rings: the
    // assembler preserves start points here, so direct compare works
    // modulo orientation normalization (outer positive, hole negative)
    assert_eq!(o.first(), o.last());
    let expected_outer = ring_world(&outer);
    let expected_hole: Vec<WorldXy> = ring_world(&hole).into_iter().rev().collect();
    assert_ring_close(o, &expected_outer, "outer");
    assert_ring_close(&holes[0], &expected_hole, "hole");
}

#[test]
fn soundings_round_trip() {
    let rp = reference_point(&cell_box());
    let src = [
        (54.52, 9.02, 5.5f32),
        (54.53, 9.06, 12.25),
        (54.57, 9.08, 0.5),
    ];
    let triples: Vec<(f32, f32, f32)> = src
        .iter()
        .map(|&(la, lo, d)| {
            let (e, n) = sm(la, lo, rp, 1.0);
            (e, n, d)
        })
        .collect();
    let mut w = header(201);
    w.feature(129, 9, 1) // SOUNDG
        .multipoint(&cell_box(), &triples);
    let cell = read_cell(&w.into_bytes()[..]).unwrap();
    let Some(Geometry::MultiPoint(pts)) = &cell.features[0].geometry else {
        panic!()
    };
    assert_eq!(pts.len(), 3);
    for (pz, &(la, lo, d)) in pts.iter().zip(&src) {
        assert_close(pz.pos, lat_lon_to_world(la, lo), "sounding");
        assert_eq!(pz.z, d as f64);
    }
}

#[test]
fn ext_records_apply_scale_factor() {
    let rp = reference_point(&cell_box());
    let scale = 8.0;
    let outer = ring(54.58, 54.52, 9.02, 9.08);
    let mut w = header(201);
    w.feature(42, 5, 3)
        .area_geometry(&cell_box(), &[], &[RawTuple::forward(1)], 4, Some(scale))
        // vertices pre-multiplied by the scale factor; the decoder must
        // divide it back out (the reference forgets this for record 85)
        .edge_table(&[(1, ring_sm(&outer, rp, scale))], Some(scale))
        .node_table(&[(1, sm(54.50, 9.00, rp, scale))], Some(scale));
    let cell = read_cell(&w.into_bytes()[..]).unwrap();
    let Some(Geometry::Areas(polys)) = &cell.features[0].geometry else {
        panic!()
    };
    assert_ring_close(&polys[0].outer, &ring_world(&outer), "scaled outer");

    // degenerate scale factors mean 1
    let pts = ring_sm(&outer, rp, 1.0);
    let mut w = header(201);
    w.feature(42, 6, 3)
        .area_geometry(&cell_box(), &[], &[RawTuple::forward(1)], 4, Some(0.0))
        .edge_table(&[(1, pts)], Some(1e-9));
    let cell = read_cell(&w.into_bytes()[..]).unwrap();
    let Some(Geometry::Areas(polys)) = &cell.features[0].geometry else {
        panic!()
    };
    assert_ring_close(&polys[0].outer, &ring_world(&outer), "unscaled outer");
}

#[test]
fn server_status_verdicts() {
    // all-good status: decodes normally
    let ok = ServerStatus {
        server_status: 1,
        decrypt_status: 1,
        expire_status: 1,
        ..Default::default()
    };
    let mut w = SencWriter::new();
    w.server_status(ok);
    let mut rest = header(201);
    rest.feature(75, 1, 1).point_geometry(54.55, 9.05);
    let mut bytes = w.into_bytes();
    bytes.extend(rest.into_bytes());
    let cell = read_cell(&bytes[..]).unwrap();
    assert_eq!(cell.features.len(), 1);

    // decrypt refused
    let mut w = SencWriter::new();
    w.server_status(ServerStatus {
        decrypt_status: 0,
        expire_status: 1,
        ..ok
    });
    match read_cell(&w.into_bytes()[..]) {
        Err(OsencError::Decrypt(s)) => assert_eq!(s.decrypt_status, 0),
        other => panic!("{other:?}"),
    }

    // expired
    let mut w = SencWriter::new();
    w.server_status(ServerStatus {
        expire_status: 0,
        grace_days_allowed: 30,
        grace_days_remaining: 7,
        ..ok
    });
    match read_cell(&w.into_bytes()[..]) {
        Err(OsencError::Expired(s)) => assert_eq!(s.grace_days_remaining, 7),
        other => panic!("{other:?}"),
    }

    // the verdict is enforced in header-only mode too (divergence from the
    // reference, which skips record 200 when reading headers)
    let mut w = SencWriter::new();
    w.server_status(ServerStatus {
        decrypt_status: 0,
        expire_status: 1,
        ..ok
    });
    assert!(matches!(
        read_header(&w.into_bytes()[..]),
        Err(OsencError::Decrypt(_))
    ));
}

#[test]
fn version_gates() {
    for bad in [1024u16, 199, 300] {
        let mut w = SencWriter::new();
        w.version(bad);
        match read_cell(&w.into_bytes()[..]) {
            Err(OsencError::Version(v)) => assert_eq!(v, bad),
            other => panic!("version {bad}: {other:?}"),
        }
    }
}

#[test]
fn read_header_stops_early_and_reports_missing() {
    let mut w = header(201);
    // a feature whose payload would error if parsed with a current object
    w.feature(75, 1, 1).point_geometry(54.55, 9.05);
    let mut bytes = w.into_bytes();
    // truncate mid-way through the feature records: header reading must
    // already have stopped before them
    bytes.truncate(bytes.len() - 3);
    let h = read_header(&bytes[..]).unwrap();
    assert_eq!(h.meta.name, "TEST01");
    assert_eq!(h.meta.edition, 3);
    assert_eq!(h.meta.compilation_scale, 12000);
    assert_eq!(h.extent, cell_box());

    // missing native scale → MissingRecord
    let mut w = SencWriter::new();
    w.version(201)
        .cell_name("X")
        .cell_edition(1)
        .extent(&cell_box());
    assert!(matches!(
        read_header(&w.into_bytes()[..]),
        Err(OsencError::MissingRecord("native scale"))
    ));
}

#[test]
fn skips_orphan_records_and_unknown_attributes() {
    let mut w = header(201);
    // geometry + attribute records with no open feature: skipped
    w.point_geometry(54.55, 9.05).attr_int(107, 4);
    w.feature(75, 1, 1)
        .attr_int(64999, 1) // unknown attribute code: dropped
        .point_geometry(54.55, 9.05);
    let cell = read_cell(&w.into_bytes()[..]).unwrap();
    assert_eq!(cell.features.len(), 1);
    assert!(cell.features[0].attributes.is_empty());
}

#[test]
fn unknown_class_code_keeps_feature_visible() {
    let mut w = header(201);
    w.feature(64000, 1, 1).point_geometry(54.55, 9.05);
    let cell = read_cell(&w.into_bytes()[..]).unwrap();
    assert_eq!(cell.features[0].acronym, "OBJL64000");
}

#[test]
fn geometry_before_extent_is_an_error() {
    let mut w = SencWriter::new();
    w.version(201)
        .feature(129, 1, 1)
        .multipoint(&cell_box(), &[(0.0, 0.0, 1.0)]);
    assert!(matches!(
        read_cell(&w.into_bytes()[..]),
        Err(OsencError::Format(_))
    ));
}

#[test]
fn ocharts_extension_class_resolves() {
    let mut w = header(201);
    w.feature(17028, 1, 1).point_geometry(54.55, 9.05); // bcnlat
    let cell = read_cell(&w.into_bytes()[..]).unwrap();
    assert_eq!(cell.features[0].acronym, "bcnlat");
}

#[test]
fn cell_extent_is_union_of_features() {
    let mut w = header(201);
    w.feature(75, 1, 1).point_geometry(54.55, 9.05);
    w.feature(75, 2, 1).point_geometry(54.56, 9.07);
    let cell = read_cell(&w.into_bytes()[..]).unwrap();
    let mut expected = Extent::invalid();
    expected.extend_point(lat_lon_to_world(54.55, 9.05));
    expected.extend_point(lat_lon_to_world(54.56, 9.07));
    assert_eq!(cell.extent, expected);
}

/// A closed lat/lon ring, as the coverage records carry them.
fn covr_ring(s: f32, n: f32, w: f32, e: f32) -> Vec<(f32, f32)> {
    vec![(s, w), (n, w), (n, e), (s, e), (s, w)]
}

/// Twice the signed area of a world ring (y-down): positive adds coverage.
fn ring_area2(ring: &[WorldXy]) -> i128 {
    let mut sum = 0i128;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        sum += a.x as i128 * b.y as i128 - b.x as i128 * a.y as i128;
    }
    sum
}

/// The coverage block reaches a *header* read: it sits after CELL_EXTENT
/// and before the first feature, which is the whole reason serving can know
/// a cell's coverage without decoding it.
#[test]
fn header_read_carries_cell_coverage() {
    let mut w = header(201);
    w.coverage_ring(rt::CELL_COVR, &covr_ring(54.50, 54.60, 9.00, 9.10));
    w.coverage_ring(rt::CELL_NOCOVR, &covr_ring(54.52, 54.54, 9.02, 9.04));
    w.feature(75, 1, 1).point_geometry(54.55, 9.05);

    let h = read_header(&w.into_bytes()[..]).unwrap();
    let cov = h.coverage.expect("the header carries the coverage rings");
    // one charted ring plus one declared-uncharted ring, normalized so the
    // no-coverage ring subtracts
    assert_eq!(cov.rings.len(), 2);
    let signs: Vec<bool> = cov.rings.iter().map(|r| ring_area2(r) > 0).collect();
    assert_eq!(signs, vec![true, false]);
}

/// A cell with no coverage records is not a cell with no coverage: the
/// header says `None` and the caller falls back to the extent.
#[test]
fn header_without_coverage_records_yields_none() {
    let mut w = header(201);
    w.feature(75, 1, 1).point_geometry(54.55, 9.05);
    assert!(read_header(&w.into_bytes()[..]).unwrap().coverage.is_none());

    // NOCOVR alone declares no coverage to fall back *from* either
    let mut w = header(201);
    w.coverage_ring(rt::CELL_NOCOVR, &covr_ring(54.52, 54.54, 9.02, 9.04));
    w.feature(75, 1, 1).point_geometry(54.55, 9.05);
    assert!(read_header(&w.into_bytes()[..]).unwrap().coverage.is_none());
}

/// The layout is load-bearing and was reverse-engineered, so a payload that
/// does not match it must fail loudly rather than truncate a coverage ring
/// into a wrong shape.
#[test]
fn malformed_coverage_ring_is_an_error() {
    let mut w = header(201);
    // claims 4 points, carries 1
    w.record(rt::CELL_COVR, &[4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    match read_header(&w.into_bytes()[..]) {
        Err(OsencError::Format(m)) => assert!(m.contains("coverage ring"), "{m}"),
        other => panic!("expected a format error, got {other:?}"),
    }
}

/// The coverage records and the M_COVR features say the same thing, so a
/// cell carrying both must not disagree with itself — the premise the
/// serving path's coverage-based selection rests on (module docs).
#[test]
fn covr_records_agree_with_m_covr_features() {
    let mut w = header(201);
    w.coverage_ring(rt::CELL_COVR, &covr_ring(54.50, 54.60, 9.00, 9.10));
    let from_header = read_header(&w.into_bytes()[..]).unwrap().coverage.unwrap();

    // the same square as an M_COVR CATCOV=1 area feature
    let ring: Vec<crate::coords::WorldXy> = covr_ring(54.50, 54.60, 9.00, 9.10)
        .iter()
        .map(|(la, lo)| lat_lon_to_world(*la as f64, *lo as f64))
        .collect();
    let mut attrs = BTreeMap::new();
    attrs.insert("CATCOV".to_string(), AttrValue::Int(1));
    let cell = Cell {
        meta: CellMeta::default(),
        features: vec![Feature::new(
            302,
            "M_COVR".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring,
                holes: vec![],
            }])),
        )],
        extent: Extent::invalid(),
    };
    let from_features = crate::coverage::cell_coverage(&cell).unwrap();
    assert_eq!(from_header.extent, from_features.extent);
    assert_eq!(from_header.rings.len(), from_features.rings.len());
}
