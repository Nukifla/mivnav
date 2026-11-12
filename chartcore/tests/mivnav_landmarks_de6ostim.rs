// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §14's ALT landmark / lower-bound tables, proven on a REAL chart cell.
//!
//! `mivnav::landmarks`' own unit tests establish the algebra on tiny
//! hand-built graphs; this file establishes the two things only real data
//! can:
//!
//! 1. **The bound is admissible on real topology.** For every pair among
//!    the three known-good points on `DE6OSTIM.S57`,
//!    `BandLandmarks::lower_bound_mm` is never greater than the real
//!    `topology_route` cost between the same tiles, in both travel
//!    directions — the end-to-end check on the whole "reduced weights are
//!    a lower bound, triangle inequality does the rest" argument in that
//!    module's docs.
//!
//! 2. **The symmetry the bound leans on actually holds.**
//!    `lower_bound_mm` takes the absolute anchor-distance difference,
//!    which is only valid because `detect_portals` emits every seam as a
//!    bidirectional pair with an identical `lower_bound_cost_mm`. That is
//!    an invariant of `detect_portals`, not of `landmarks`, so it is
//!    guarded here against real chart geometry.
//!
//! Plus the persistence round trip: a built table survives publish →
//! re-open byte for byte, and an artifact written without the section
//! loads with an empty table rather than an error (the same
//! absence-is-not-staleness rule `HazardRings`/`Semantics` follow).
//!
//! Fixture and query points are the same `backend/data/fnc/DE6OSTIM.S57`
//! and `CHANNEL_NORTH`/`CHANNEL_SOUTH`/`BASIN` every other `mivnav_*`
//! integration test in this directory uses.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, Extent};
use chartcore::mivnav::{
    band_to_dm, build_artifact, encode_components, encode_landmarks, encode_portals,
    encode_shortcuts, encode_stitch, encode_tile_index, encode_u16_column, load_artifact,
    load_region, publish_artifact, select_band_index, snap_point, topology_route, ArtifactReader,
    ArtifactVersions, ArtifactWriter, BandLandmarks, ChartSetIdentity, RegionArtifact, SectionKind,
    LANDMARK_ANCHORS,
};
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::artifact::CatzocMode;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../backend/data/fnc/DE6OSTIM.S57")
}

fn cell() -> &'static Cell {
    static CELL: OnceLock<Cell> = OnceLock::new();
    CELL.get_or_init(|| {
        let file = std::fs::File::open(fixture_path()).expect("DE6OSTIM fixture reads");
        let mut cell = osenc::read_cell(file).expect("DE6OSTIM fixture decodes");
        chartcore::derive::apply(&mut cell);
        cell
    })
}

fn region_extent() -> Extent {
    let e = cell().extent;
    let pad = (e.xmax - e.xmin) / 4;
    Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad)
}

// (lon, lat) — the real points every file in this suite reuses.
const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);
const BASIN: (f64, f64) = (11.37513, 53.992133);

const REQUIRED_M: f64 = 1.0;

fn fresh() -> &'static RegionArtifact {
    static A: OnceLock<RegionArtifact> = OnceLock::new();
    A.get_or_init(|| build_artifact(&[cell().clone()], region_extent(), CatzocMode::Off))
}

fn chart_set() -> ChartSetIdentity {
    ChartSetIdentity::new("de6ostim-landmarks-test", 1)
}

struct TestDir(PathBuf);
impl TestDir {
    fn new(tag: &str) -> TestDir {
        let dir = std::env::temp_dir().join(format!(
            "mivnav-landmarks-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        TestDir(dir)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn snap_tile(art: &RegionArtifact, lonlat: (f64, f64)) -> u32 {
    let p = lat_lon_to_world(lonlat.1, lonlat.0);
    snap_point(&art.built, p)
        .unwrap_or_else(|| panic!("{lonlat:?} snaps inside the region"))
        .tile
}

#[test]
fn every_band_table_is_structurally_sound() {
    let art = fresh();
    for band in &art.bands {
        let l = &band.landmarks;
        if l.is_empty() {
            continue;
        }
        // node_tiles is the sorted-unique key.
        assert!(
            l.node_tiles.windows(2).all(|w| w[0] < w[1]),
            "band {} node_tiles not strictly ascending",
            band.tag.band_index
        );
        // Anchors are graph nodes, and there are as many as the graph
        // affords, capped at LANDMARK_ANCHORS.
        assert_eq!(
            l.anchors.len(),
            LANDMARK_ANCHORS.min(l.node_tiles.len()),
            "band {} anchor count",
            band.tag.band_index
        );
        for a in &l.anchors {
            assert!(
                l.node_tiles.binary_search(a).is_ok(),
                "band {} anchor {a} is not a graph node",
                band.tag.band_index
            );
        }
        // No repeated anchor.
        let mut sorted = l.anchors.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            l.anchors.len(),
            "band {} repeated anchor",
            band.tag.band_index
        );
        // The matrix is exactly anchors × nodes.
        assert_eq!(l.dist_mm.len(), l.anchors.len() * l.node_tiles.len());
        // Every anchor reaches itself at zero cost.
        let n = l.node_tiles.len();
        for (ai, a) in l.anchors.iter().enumerate() {
            let self_pos = l.node_tiles.binary_search(a).unwrap();
            assert_eq!(l.dist_mm[ai * n + self_pos], 0);
        }
    }
}

#[test]
fn the_build_is_deterministic() {
    // Farthest-point sampling and the per-anchor Dijkstra are pure
    // functions of the portal set; a second build of the identical input
    // must produce byte-identical tables.
    let a = build_artifact(&[cell().clone()], region_extent(), CatzocMode::Off);
    let b = build_artifact(&[cell().clone()], region_extent(), CatzocMode::Off);
    for (x, y) in a.bands.iter().zip(&b.bands) {
        assert_eq!(
            x.landmarks, y.landmarks,
            "band {} landmarks not deterministic",
            x.tag.band_index
        );
    }
}

#[test]
fn portals_come_in_symmetric_equal_weight_pairs() {
    // `lower_bound_mm`'s use of the absolute difference depends on this.
    let art = fresh();
    for band in &art.bands {
        for p in &band.portals {
            let reverse = band
                .portals
                .iter()
                .find(|q| q.tile == p.neighbour_tile && q.neighbour_tile == p.tile);
            let reverse = reverse.unwrap_or_else(|| {
                panic!(
                    "band {} portal {} ({}->{}) has no reverse record",
                    band.tag.band_index, p.id, p.tile, p.neighbour_tile
                )
            });
            assert_eq!(
                reverse.lower_bound_cost_mm, p.lower_bound_cost_mm,
                "band {} portal {} and its reverse disagree on lower_bound_cost_mm",
                band.tag.band_index, p.id
            );
        }
    }
}

#[test]
fn the_bound_never_exceeds_the_real_topology_cost() {
    let art = fresh();
    let band_index = select_band_index(REQUIRED_M);
    let band = art.band(band_index).expect("the shallowest band exists");
    let draft_dm = band_to_dm(REQUIRED_M);

    let points = [
        ("CHANNEL_NORTH", snap_tile(art, CHANNEL_NORTH)),
        ("CHANNEL_SOUTH", snap_tile(art, CHANNEL_SOUTH)),
        ("BASIN", snap_tile(art, BASIN)),
    ];

    // The ALT bound is on the TOPOLOGY route cost (tile-centre graph),
    // which is exactly what `topology_route` returns — an apples-to-
    // apples comparison. It is NOT a bound on the fine grid route.
    let mut checked_a_real_route = false;
    for &(sn, s) in &points {
        for &(gn, g) in &points {
            if s == g {
                continue;
            }
            let bound = band.landmarks.lower_bound_mm(s, g);
            assert!(bound >= 0, "{sn}->{gn} bound is negative");
            // Symmetric by construction.
            assert_eq!(
                bound,
                band.landmarks.lower_bound_mm(g, s),
                "{sn}<->{gn} bound is not symmetric"
            );
            if let Some(route) = topology_route(&art.built, &band.portals, s, g, draft_dm) {
                checked_a_real_route = true;
                assert!(
                    bound <= route.cost_mm,
                    "{sn}->{gn}: lower bound {bound} exceeds the real topology cost {}",
                    route.cost_mm
                );
            }
        }
    }
    assert!(
        checked_a_real_route,
        "at least one of the known point pairs must actually route, or this proves nothing"
    );
}

#[test]
fn tables_survive_the_publish_round_trip() {
    let dir = TestDir::new("round-trip");
    let path = dir.0.join("region.mivnav");
    let art = fresh();
    publish_artifact(&path, chart_set(), art).expect("publish succeeds");

    let reader = ArtifactReader::from_file(&path).expect("published file parses");
    let loaded = load_artifact(&reader).expect("artifact loads");

    assert_eq!(loaded.bands.len(), art.bands.len());
    for (want, got) in art.bands.iter().zip(&loaded.bands) {
        assert_eq!(
            want.landmarks, got.landmarks,
            "band {} landmarks did not round-trip",
            want.tag.band_index
        );
    }
    // Sanity: at least one band actually carries a non-empty table, so
    // the round trip is not vacuously comparing ten empty structs.
    assert!(
        art.bands.iter().any(|b| !b.landmarks.is_empty()),
        "the fixture built no landmark tables at all"
    );
}

#[test]
fn an_artifact_written_without_the_landmarks_section_loads_with_empty_tables() {
    let dir = TestDir::new("no-section");
    let path = dir.0.join("region.mivnav");
    let a = fresh();

    let mut buf = std::io::Cursor::new(Vec::new());
    let mut w = ArtifactWriter::new(&mut buf).unwrap();
    w.write_section(SectionKind::TileIndex, &encode_tile_index(&a.built.tiles))
        .unwrap();
    w.write_section(
        SectionKind::DepthMin,
        &encode_u16_column(&a.built.depth_min),
    )
    .unwrap();
    w.write_section(
        SectionKind::DepthMax,
        &encode_u16_column(&a.built.depth_max),
    )
    .unwrap();
    w.write_section(SectionKind::Flags, &a.built.flags).unwrap();
    w.write_section(SectionKind::BoundaryStitch, &encode_stitch(&a.built.stitch))
        .unwrap();
    for band in &a.bands {
        w.write_section(
            SectionKind::Components,
            &encode_components(band.tag, &band.components),
        )
        .unwrap();
        w.write_section(
            SectionKind::Portals,
            &encode_portals(band.tag, &band.portals),
        )
        .unwrap();
        w.write_section(
            SectionKind::Topology,
            &encode_shortcuts(band.tag, &band.shortcuts),
        )
        .unwrap();
        // deliberately no Landmarks section
    }
    w.finish(chart_set(), ArtifactVersions::CURRENT).unwrap();
    std::fs::write(&path, buf.into_inner()).unwrap();

    let reader = ArtifactReader::from_file(&path).unwrap();
    load_region(&reader).expect("region still loads");
    let loaded = load_artifact(&reader).expect("a landmark-less artifact still loads");
    for band in &loaded.bands {
        assert!(
            band.landmarks.is_empty(),
            "band {} should have an empty table when the section is absent",
            band.tag.band_index
        );
    }
}

#[test]
fn encode_of_a_default_table_decodes_back_to_default() {
    // The per-band write path calls `encode_landmarks` even for a band
    // whose graph is empty; that payload must round-trip.
    let tag = fresh().bands[0].tag;
    let bytes = encode_landmarks(tag, &BandLandmarks::default());
    let reader_ok = chartcore::mivnav::decode_landmarks(&bytes);
    assert_eq!(reader_ok, Some(BandLandmarks::default()));
}
