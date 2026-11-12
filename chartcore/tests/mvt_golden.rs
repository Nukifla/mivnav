// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

// Golden tiles built from the decoded NOAA `.000` fixture (and the ingest
// CLI), so this needs the GDAL-backed reader; the whole file compiles out of
// the default (gdal-free) build. See the `s57-ingest` feature in Cargo.toml.
#![cfg(feature = "s57-ingest")]

//! Golden-tile tests: NOAA fixture cell → MVT tileset → PMTiles archive →
//! decode fixed z/x/y tiles and assert layer names, feature counts and
//! spot-checked geometry.
//!
//! The pinned values were derived at development time and cross-validated
//! against independent implementations: the archive structure and tile
//! blobs with the `pmtiles` python package (the spec's reference reader)
//! and `mapbox-vector-tile` (decoding every layer). If a pipeline change
//! legitimately alters them, re-derive the same way.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use chartcore::mvt::decode::{decode_tile, GeomType};
use chartcore::mvt::{build_tileset, zoom_range_for_scale, TagValue, Tileset};
use chartcore::pmtiles::Archive;
use chartcore::s57::{read_cell, S57OpenOptions};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/US5OAKIQ.000")
}

/// The MVT feature id chartcore now writes for an object of RCID `rcid` in
/// this fixture cell: `(cell_namespace(name) << 32) | rcid`. The bare RCID is
/// unique only per cell, so the id is namespaced by the cell's dataset name to
/// stay addressable once several cells merge into one served tile (see
/// `chartcore::mvt::cell_namespace`). The golden values below are the RCIDs;
/// this reapplies the same namespace the tiler did.
fn fid(rcid: u32) -> u64 {
    chartcore::mvt::namespaced_id(chartcore::mvt::cell_namespace("US5OAKIQ.000"), rcid)
}

fn lups_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lups-fixture.xml")
}

/// The archive built once by running the actual CLI binary on the fixture.
fn archive() -> &'static Archive {
    static ARCHIVE: OnceLock<Archive> = OnceLock::new();
    ARCHIVE.get_or_init(|| {
        let out = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("US5OAKIQ.pmtiles");
        let status = Command::new(env!("CARGO_BIN_EXE_chartcore"))
            .arg("ingest")
            .arg(fixture_path())
            .arg("-o")
            .arg(&out)
            // hermetic S-52 lookups: the committed fixture subset, never the
            // developer's MIVNAV_S57DATA or cache (tile bytes stay golden)
            .arg("--s52-data")
            .arg(lups_fixture_path())
            .env_remove("MIVNAV_S57DATA")
            .status()
            .expect("CLI runs");
        assert!(status.success(), "chartcore ingest failed");
        Archive::from_file(&out).expect("archive parses")
    })
}

#[test]
fn cli_rejects_bad_usage() {
    let bin = env!("CARGO_BIN_EXE_chartcore");
    for args in [
        vec![],
        vec!["ingest"],
        vec!["ingest", "x.000"],
        vec!["frobnicate"],
    ] {
        let out = Command::new(bin).args(&args).output().unwrap();
        assert_eq!(out.status.code(), Some(2), "args {args:?}");
    }
    // runtime failure (missing file) is exit 1
    let out = Command::new(bin)
        .args(["ingest", "/nonexistent.000", "-o", "/dev/null"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
}

#[test]
fn archive_header() {
    let h = &archive().header;
    // zoom range derived from the cell's 1:12000 compilation scale
    assert_eq!(zoom_range_for_scale(12_000), (10, 16));
    assert_eq!((h.min_zoom, h.max_zoom), (10, 16));
    assert_eq!(h.tile_type, chartcore::pmtiles::TILE_TYPE_MVT);
    assert!(h.clustered);
    // fixture cell bounds: lon [-121.725, -121.65], lat [38.025, 38.1]
    assert!((h.bounds[0] - -121.725).abs() < 1e-4, "{:?}", h.bounds);
    assert!((h.bounds[1] - 38.025).abs() < 1e-4);
    assert!((h.bounds[2] - -121.65).abs() < 1e-4);
    assert!((h.bounds[3] - 38.1).abs() < 1e-4);
    // golden: tile/entry/blob counts for this cell at z10-z16
    assert_eq!(h.addressed_tiles, 401);
    assert_eq!(h.tile_entries, 401);
    assert_eq!(h.tile_contents, 270); // identical tiles dedup'd

    let meta = archive().metadata_json().unwrap();
    assert!(meta.contains("\"name\":\"US5OAKIQ.000\""));
    assert!(meta.contains("\"vector_layers\""));
    assert!(meta.contains("{\"id\":\"DEPARE\",\"minzoom\":10,\"maxzoom\":16,\"fields\":{}}"));
    // the synthetic no-data layer would be advertised like any other, but
    // this cell declares no uncovered area, so it has no such layer
    assert!(!meta.contains("_nodata"));
}

/// The whole 1:12000 cell fits in one z10 tile — but that tile is now
/// **decluttered server-side**: every feature the frontend would hide by
/// SCAMIN at z10 (`display_scale_denom(10) ≈ 272_989`) is dropped before the tile is
/// baked, because z10 is far below the tileset's z16 max and is never
/// overzoomed (`chartcore::mvt::drop_scamin_hidden`). So the gated classes
/// (soundings, depth contours, buoys, lights) are GONE here and only reappear
/// on finer tiles — see `golden_scamin_gate`. The always-show group-1 / DISPLAYBASE
/// classes remain, unchanged.
#[test]
fn golden_tile_z10_overview_is_decluttered() {
    let bytes = archive().tile(10, 165, 394).unwrap().expect("tile exists");
    let tile = decode_tile(&bytes).unwrap();
    // no other z10 tile exists
    for (x, y) in [(164, 394), (166, 394), (165, 393), (165, 395)] {
        assert_eq!(archive().tile(10, x, y).unwrap(), None, "{x}/{y}");
    }

    // 38 object-class layers before the drop; the 5 fully-gated ones (ATON,
    // DAYMAR, DEPCNT, LIGHTS, SOUNDG) are dropped whole at z10, leaving 33.
    assert_eq!(tile.layers.len(), 33);
    for gone in ["ATON", "DEPCNT", "LIGHTS", "SOUNDG"] {
        assert!(
            tile.layer(gone).is_none(),
            "{gone} is SCAMIN-hidden at z10 and must be dropped off the wire"
        );
    }
    // layer order is sorted (deterministic encoding)
    let names: Vec<&str> = tile.layers.iter().map(|l| l.name.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);

    // golden feature counts of the surviving always-show classes (unchanged by
    // the drop — none of these carry a SCAMIN gate)
    for (name, count) in [
        ("COALNE", 26),
        ("DEPARE", 78),
        ("LNDARE", 19),
        ("M_COVR", 1),
        ("SLCONS", 49),
        ("WRECKS", 3),
    ] {
        let layer = tile.layer(name).unwrap_or_else(|| panic!("{name} missing"));
        assert_eq!(layer.features.len(), count, "{name} count");
        assert_eq!(layer.version, 2);
        assert_eq!(layer.extent, 4096);
    }

    // the restricted-group areas resolved their group schema (RESARE is not
    // SCAMIN-gated, so it survives at the overview). `no-entry` is the
    // vendored icon name the old chartsymbols.xml ENTRES51 token now maps to
    // (chartcore/assets/s52-icons/port-map.json).
    let resare = tile.layer("RESARE").unwrap();
    assert!(resare
        .features
        .iter()
        .all(|f| f.tags.get("sym") == Some(&TagValue::Str("no-entry".into()))));
    // area label points (specs-12.md §1.5): exactly one Point per RESARE
    // area in the whole-cell tile, alongside the 6 polygons
    let (pts, polys): (Vec<_>, Vec<_>) = resare
        .features
        .iter()
        .partition(|f| f.geom_type == GeomType::Point);
    assert_eq!((pts.len(), polys.len()), (6, 6));

    // area features expose polygon geometry with MVT winding: first ring
    // (exterior) has positive area in y-down tile space
    let depare = tile.layer("DEPARE").unwrap();
    for f in &depare.features {
        assert_eq!(f.geom_type, GeomType::Polygon);
        assert!(f.id.is_some());
        assert!(
            signed_area2(&f.parts[0]) > 0,
            "exterior ring must be positive"
        );
    }
}

#[test]
fn golden_tile_z16_center() {
    let bytes = archive()
        .tile(16, 10616, 25266)
        .unwrap()
        .expect("tile exists");
    let tile = decode_tile(&bytes).unwrap();
    let got: Vec<(&str, usize)> = tile
        .layers
        .iter()
        .map(|l| (l.name.as_str(), l.features.len()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("COALNE", 1),
            ("CTNARE", 1),
            ("DEPARE", 3),
            ("DEPCNT", 2),
            ("DRGARE", 3),
            ("FAIRWY", 1),
            ("LNDARE", 1),
            ("MAGVAR", 1),
            ("M_COVR", 1),
            ("M_NPUB", 1),
            ("M_NSYS", 1),
            ("M_QUAL", 2),
            ("RESARE", 1),
            ("SEAARE", 2),
            ("SOUNDG", 3),
        ]
    );
    // clipped geometry stays within the buffered tile square
    for layer in &tile.layers {
        for f in &layer.features {
            for part in &f.parts {
                for (x, y) in part {
                    assert!((-64..=4096 + 64).contains(x), "{}: x {x}", layer.name);
                    assert!((-64..=4096 + 64).contains(y), "{}: y {y}", layer.name);
                }
            }
        }
    }
}

/// Named sea areas keep their NAME all the way to the tile, and get exactly
/// one label point each per zoom.
///
/// The first half pins a fact a previous change asserted the opposite of:
/// SEAARE is not in `render_only_keep`, so OBJNAM/NOBJNM survive the tiler
/// untouched and the bay/sound/channel names are a pure frontend styling
/// question, not an ingest change. This cell's 12 SEAARE areas are all named.
///
/// The second half is why `wants_label_point` now covers SEAARE: these areas
/// span many tiles (334 polygon features over the z10-z16 pyramid from 12
/// source areas), and MapLibre labels each tile's clipped polygon at its own
/// centroid — so the synthetic point is the only thing that stops a name
/// repeating the length of a river.
#[test]
fn golden_seaare_keeps_its_name_and_gets_one_label_point() {
    let mut polys_by_name: BTreeMap<String, usize> = BTreeMap::new();
    let mut points_by_name: BTreeMap<String, usize> = BTreeMap::new();
    for x in 10608..=10622u32 {
        for y in 25255..=25273u32 {
            let Some(bytes) = archive().tile(16, x, y).unwrap() else {
                continue;
            };
            let tile = decode_tile(&bytes).unwrap();
            let Some(layer) = tile.layer("SEAARE") else {
                continue;
            };
            for f in &layer.features {
                let name = match f.tags.get("OBJNAM").or_else(|| f.tags.get("NOBJNM")) {
                    Some(TagValue::Str(s)) => s.clone(),
                    other => panic!(
                        "SEAARE at 16/{x}/{y} lost its name: {other:?}, {:?}",
                        f.tags
                    ),
                };
                match f.geom_type {
                    GeomType::Point => *points_by_name.entry(name).or_default() += 1,
                    GeomType::Polygon => *polys_by_name.entry(name).or_default() += 1,
                    other => panic!("unexpected SEAARE geometry {other:?}"),
                }
            }
        }
    }
    // one label point per source AREA across the whole zoom: 12 areas under
    // 10 distinct names ("Big Break" is three separate polygons).
    assert_eq!(
        points_by_name.values().sum::<usize>(),
        12,
        "{points_by_name:?}"
    );
    assert_eq!(points_by_name["Big Break"], 3);
    assert!(
        points_by_name
            .iter()
            .all(|(n, c)| *c == 1 || n == "Big Break"),
        "one label point per area: {points_by_name:?}"
    );
    // … while its polygon is cut across many tiles — the duplication the
    // label point exists to avoid (Taylor Slough alone spans ~10 z16 tiles)
    assert!(
        polys_by_name["Taylor Slough"] >= 8,
        "Taylor Slough polygons: {}",
        polys_by_name["Taylor Slough"]
    );
    assert_eq!(points_by_name.len(), 10, "named areas with a label point");
}

/// The M_COVR coverage partition at z16 on real data. The cell carries one
/// CATCOV=1 polygon — its bounding rectangle — and no CATCOV=2 feature, so
/// it declares no area uncovered anywhere and `_nodata` never appears.
///
/// Regression: the tiler used to emit "buffered tile rect minus coverage"
/// wherever the z16 grid overhung that rectangle, so all 64 perimeter tiles
/// of the 15x19 grid carried a grey polygon over open water the cell simply
/// does not reach. Multiplied over a chart set's cells and their bounding
/// boxes, that is the grey that swamped the chart.
#[test]
fn golden_no_nodata_without_a_declared_no_coverage_area() {
    // the former worst offender: a west-edge tile, ~64% of it grey
    // (coverage started at x=2621 of the buffered rect)
    let bytes = archive()
        .tile(16, 10608, 25264)
        .unwrap()
        .expect("edge tile");
    assert!(decode_tile(&bytes).unwrap().layer("_nodata").is_none());

    // and nowhere in the z16 grid, edge or interior
    for x in 10608..=10622u32 {
        for y in 25255..=25273u32 {
            let bytes = archive()
                .tile(16, x, y)
                .unwrap()
                .unwrap_or_else(|| panic!("{x}/{y}"));
            assert!(
                decode_tile(&bytes).unwrap().layer("_nodata").is_none(),
                "{x}/{y}"
            );
        }
    }
}

/// Spot-checked geometry and attributes: the single light in z16 tile
/// (10609, 25271), cross-validated with mapbox-vector-tile (which reports
/// the same point y-flipped: (2176, 4096-2766)).
#[test]
fn golden_light_feature() {
    let bytes = archive()
        .tile(16, 10609, 25271)
        .unwrap()
        .expect("tile exists");
    let tile = decode_tile(&bytes).unwrap();
    let lights = tile.layer("LIGHTS").expect("LIGHTS layer");
    assert_eq!(lights.features.len(), 1);
    let f = &lights.features[0];
    assert_eq!(f.id, Some(fid(47)));
    assert_eq!(f.geom_type, GeomType::Point);
    assert_eq!(f.parts, vec![vec![(2176, 2766)]]);
    // scalar attributes keep native types
    assert_eq!(f.tags.get("SCAMIN"), Some(&TagValue::Int(29999)));
    assert_eq!(f.tags.get("HEIGHT"), Some(&TagValue::Double(7.6)));
    assert_eq!(
        f.tags.get("SIGSEQ"),
        Some(&TagValue::Str("00.4+(03.6)".into()))
    );
    // list attributes: comma-joined codes; empty-but-set list = empty string
    assert_eq!(f.tags.get("COLOUR"), Some(&TagValue::Str("3".into())));
    assert_eq!(f.tags.get("CATLIT"), Some(&TagValue::Str(String::new())));
}

/// Derived attributes (chartcore::derive) in the encoded tiles: DEPARE and
/// DRGARE carry the DEPARE01-resolved `drval1`/`drval2` next to the raw
/// S-57 truth, DEPCNT carries `valdco_prev` (the next shallower distinct
/// contour value in the cell — distinct VALDCOs of this cell are
/// 0.0, 1.8, 3.6, 5.4, 9.1).
#[test]
fn golden_derived_depth_attributes() {
    let bytes = archive()
        .tile(16, 10616, 25266)
        .unwrap()
        .expect("tile exists");
    let tile = decode_tile(&bytes).unwrap();

    let depare = tile.layer("DEPARE").unwrap();
    // every depth area has the resolved range
    for f in &depare.features {
        assert!(
            matches!(f.tags.get("drval1"), Some(TagValue::Double(_))),
            "{:?}",
            f.id
        );
        assert!(
            matches!(f.tags.get("drval2"), Some(TagValue::Double(_))),
            "{:?}",
            f.id
        );
    }
    let by_id = |rcid: u32| {
        depare
            .features
            .iter()
            .find(|f| f.id == Some(fid(rcid)))
            .unwrap()
    };
    assert_eq!(by_id(251).tags.get("drval1"), Some(&TagValue::Double(9.1)));
    assert_eq!(by_id(251).tags.get("drval2"), Some(&TagValue::Double(18.2)));

    // DRGARE with only DRVAL1: drval2 defaults to drval1 + 0.01
    let drgare = tile.layer("DRGARE").unwrap();
    let d270 = drgare
        .features
        .iter()
        .find(|f| f.id == Some(fid(270)))
        .unwrap();
    assert_eq!(d270.tags.get("DRVAL1"), Some(&TagValue::Double(10.5)));
    assert_eq!(d270.tags.get("DRVAL2"), None);
    assert_eq!(d270.tags.get("drval1"), Some(&TagValue::Double(10.5)));
    assert_eq!(d270.tags.get("drval2"), Some(&TagValue::Double(10.51)));

    // contours: valdco_prev is the next shallower distinct VALDCO
    let depcnt = tile.layer("DEPCNT").unwrap();
    let c = |rcid: u32| {
        depcnt
            .features
            .iter()
            .find(|f| f.id == Some(fid(rcid)))
            .unwrap()
    };
    assert_eq!(c(328).tags.get("VALDCO"), Some(&TagValue::Double(5.4)));
    assert_eq!(c(328).tags.get("valdco_prev"), Some(&TagValue::Double(3.6)));
    assert_eq!(c(374).tags.get("VALDCO"), Some(&TagValue::Double(9.1)));
    assert_eq!(c(374).tags.get("valdco_prev"), Some(&TagValue::Double(5.4)));

    // the shallowest contour in the cell (VALDCO 0.0) has none. DEPCNT is
    // SCAMIN-gated, so it survives only on the overzoomed z16 (max) tiles;
    // (16, 10609, 25259) carries the 0.0 contour.
    let bytes = archive()
        .tile(16, 10609, 25259)
        .unwrap()
        .expect("tile exists");
    let tile = decode_tile(&bytes).unwrap();
    let zeroes: Vec<_> = tile
        .layer("DEPCNT")
        .unwrap()
        .features
        .iter()
        .filter(|f| f.tags.get("VALDCO") == Some(&TagValue::Double(0.0)))
        .collect();
    assert!(!zeroes.is_empty());
    for f in &zeroes {
        assert_eq!(f.tags.get("valdco_prev"), None, "{:?}", f.id);
    }
}

/// Phase 3 derived attributes and raw carries in the whole-cell z10 tile:
/// `quapos` lifted from spatial records, `catlnd_marsh` on LNDRGN, and the
/// raw attributes the per-class styles branch on. Golden counts derived
/// with ogrinfo on the fixture (RETURN_PRIMITIVES/RETURN_LINKAGES: 61
/// spatial records carry QUAPOS=4; 9 COALNE / 15 DEPCNT / 7 LNDARE
/// features reference at least one of them; no SLCONS does).
#[test]
fn golden_phase3_attributes() {
    let bytes = archive().tile(10, 165, 394).unwrap().expect("tile exists");
    let tile = decode_tile(&bytes).unwrap();

    let quapos_count = |name: &str| {
        tile.layer(name)
            .unwrap_or_else(|| panic!("{name} missing"))
            .features
            .iter()
            .filter(|f| f.tags.get("quapos") == Some(&TagValue::Int(4)))
            .count()
    };
    assert_eq!(quapos_count("COALNE"), 9);
    // DEPCNT is SCAMIN-gated, so it is dropped at the z10 overview (its quapos
    // lift is spot-checked on a z16 tile below); COALNE / LNDARE / SLCONS are
    // always-show and stay here.
    assert_eq!(quapos_count("LNDARE"), 7);
    assert_eq!(quapos_count("SLCONS"), 0);
    // quapos is the only value the attribute takes here, and it never leaks
    // onto classes outside the lift set
    for layer in &tile.layers {
        for f in &layer.features {
            if let Some(q) = f.tags.get("quapos") {
                assert_eq!(q, &TagValue::Int(4), "{}", layer.name);
                assert!(
                    // Phase 5 lifts quapos onto the hazard classes too
                    // (OBSTRN rcid 186 sits on a QUAPOS=4 node)
                    ["COALNE", "DEPCNT", "LNDARE", "OBSTRN", "WRECKS", "UWTROC"]
                        .contains(&layer.name.as_str()),
                    "{} must not carry quapos",
                    layer.name
                );
            }
        }
    }

    // LNDRGN: 12 features (9 areas + 3 point landings); the 7 marsh areas
    // (CATLND=2) carry the derived flag, the named ones their OBJNAM
    let lndrgn = tile.layer("LNDRGN").expect("LNDRGN layer");
    assert_eq!(lndrgn.features.len(), 12);
    let marsh = lndrgn
        .features
        .iter()
        .filter(|f| f.tags.get("catlnd_marsh") == Some(&TagValue::Bool(true)));
    assert_eq!(marsh.count(), 7);
    let named: Vec<&TagValue> = lndrgn
        .features
        .iter()
        .filter_map(|f| f.tags.get("OBJNAM"))
        .collect();
    assert_eq!(named.len(), 5);
    assert!(named.contains(&&TagValue::Str("Jersey Point".into())));

    // raw attribute carries for the per-class styles: SLCONS category /
    // water level / condition, COALNE coastline category
    let slcons = tile.layer("SLCONS").unwrap();
    assert!(slcons
        .features
        .iter()
        .all(|f| f.tags.get("CATSLC") == Some(&TagValue::Int(4))));
    let watlev = |v: i64| {
        slcons
            .features
            .iter()
            .filter(|f| f.tags.get("WATLEV") == Some(&TagValue::Int(v)))
            .count()
    };
    assert_eq!((watlev(2), watlev(3)), (42, 7));
    assert_eq!(
        slcons
            .features
            .iter()
            .filter(|f| f.tags.get("CONDTN") == Some(&TagValue::Int(2)))
            .count(),
        1
    );
    let coalne = tile.layer("COALNE").unwrap();
    assert_eq!(
        coalne
            .features
            .iter()
            .filter(|f| f.tags.get("CATCOA") == Some(&TagValue::Int(8)))
            .count(),
        9
    );

    // this cell has no line-primitive DEPARE and no UNSARE layer
    assert!(tile.layer("UNSARE").is_none());

    // DEPCNT is SCAMIN-gated and dropped at z10, so verify its Phase-3 carries
    // on an overzoomed z16 (max) tile that keeps it: every DEPCNT is a true
    // contour (VALDCO present, no drval1), and the quapos lift reaches it.
    let bytes = archive()
        .tile(16, 10611, 25255)
        .unwrap()
        .expect("tile exists");
    let tile = decode_tile(&bytes).unwrap();
    let depcnt = tile
        .layer("DEPCNT")
        .expect("DEPCNT kept on the finest tile");
    for f in &depcnt.features {
        assert!(f.tags.contains_key("VALDCO"));
        assert!(!f.tags.contains_key("drval1"));
    }
    assert!(
        depcnt
            .features
            .iter()
            .any(|f| f.tags.get("quapos") == Some(&TagValue::Int(4))),
        "quapos is lifted onto DEPCNT"
    );
}

/// The library pipeline and the CLI produce byte-identical tiles.
#[test]
fn library_matches_cli_output() {
    static TS: OnceLock<Tileset> = OnceLock::new();
    let ts = TS.get_or_init(|| {
        let lups = chartcore::s52::load(&lups_fixture_path()).unwrap();
        let mut cell = read_cell(&fixture_path(), &S57OpenOptions::default()).unwrap();
        chartcore::derive::apply_with(&mut cell, Some(&lups));
        build_tileset(&cell, 10, 16)
    });
    assert_eq!(ts.tiles.len(), 401);
    let mut per_zoom: BTreeMap<u8, usize> = BTreeMap::new();
    for (z, _, _) in ts.tiles.keys() {
        *per_zoom.entry(*z).or_default() += 1;
    }
    assert_eq!(
        per_zoom.into_iter().collect::<Vec<_>>(),
        vec![
            (10, 1),
            (11, 1),
            (12, 2),
            (13, 8),
            (14, 24),
            (15, 80),
            (16, 285)
        ]
    );
    for key in [
        (10u8, 165u32, 394u32),
        (16, 10616, 25266),
        (16, 10609, 25271),
    ] {
        let from_archive = archive().tile(key.0, key.1, key.2).unwrap().unwrap();
        assert_eq!(ts.tiles.get(&key), Some(&from_archive), "tile {key:?}");
    }
}

/// Twice the signed area of a ring in y-down tile space (MVT shoelace).
fn signed_area2(ring: &[(i32, i32)]) -> i64 {
    let mut sum = 0i64;
    for i in 0..ring.len() {
        let (ax, ay) = ring[i];
        let (bx, by) = ring[(i + 1) % ring.len()];
        sum += ax as i64 * by as i64 - bx as i64 * ay as i64;
    }
    sum
}

/// SCAMIN (`S57Object.cpp:659`) end to end: the derive pass writes a `scamin`
/// gate next to the raw attribute only for the features S-52 actually gates
/// (DISPLAYBASE / group-1 objects are exempt and get none), and chartcore now
/// acts on that gate at bake time — dropping gated features from every tile
/// below the tileset max, and keeping them on the overzoomed finest tile so
/// MapLibre's re-filter still reveals them as you zoom in
/// (`chartcore::mvt::drop_scamin_hidden`).
#[test]
fn golden_scamin_gate() {
    // -- z10 overview (well below the z16 max): the gated overview clutter is
    // dropped off the wire, the always-show classes stay.
    let bytes = archive().tile(10, 165, 394).unwrap().expect("tile exists");
    let tile = decode_tile(&bytes).unwrap();

    // the reported bug: spot soundings (gated 1:17999) and depth contours
    // (1:21999 / 1:44999) would clutter the overview; the frontend hid them at
    // render time, now the server never ships them at z10.
    assert!(
        tile.layer("SOUNDG").is_none(),
        "gated soundings dropped at z10"
    );
    assert!(
        tile.layer("DEPCNT").is_none(),
        "gated contours dropped at z10"
    );

    // overhead cables are Displaybase: no gate, so they survive the drop with
    // their raw SCAMIN intact (an always-show object is never dropped)
    let cblohd = tile.layer("CBLOHD").unwrap();
    assert_eq!(cblohd.features.len(), 3);
    for f in &cblohd.features {
        assert_eq!(f.tags.get("SCAMIN"), Some(&TagValue::Int(44999)));
        assert_eq!(f.tags.get("scamin"), None, "Displaybase must bypass SCAMIN");
    }
    // group 1 skin of the earth carries no SCAMIN gate, and survives
    for f in &tile.layer("DEPARE").unwrap().features {
        assert_eq!(f.tags.get("scamin"), None);
    }

    // -- z16 finest tile (== tileset max): overzoomed, so the drop is exempt
    // and the gated features are present WITH their derived gate, ready for
    // the client to re-filter above z16.
    let bytes = archive()
        .tile(16, 10616, 25266)
        .unwrap()
        .expect("tile exists");
    let tile = decode_tile(&bytes).unwrap();
    let soundg = tile
        .layer("SOUNDG")
        .expect("soundings kept on the finest tile");
    for f in &soundg.features {
        assert_eq!(f.tags.get("SCAMIN"), Some(&TagValue::Int(17999)));
        assert_eq!(
            f.tags.get("scamin"),
            Some(&TagValue::Int(17999)),
            "sounding gate survives on the overzoomed tile"
        );
    }
    let depcnt = tile
        .layer("DEPCNT")
        .expect("contours kept on the finest tile");
    assert!(
        depcnt
            .features
            .iter()
            .all(|f| f.tags.contains_key("scamin")),
        "every contour carries its gate on the finest tile"
    );
}
