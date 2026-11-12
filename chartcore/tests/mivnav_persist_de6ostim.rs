// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! The load-bearing proof that a `.mivnav` file is real: build the whole
//! artifact for a REAL chart cell, publish it, re-open it FRESH from
//! disk, and show that a topology route computed off the LOADED
//! structures is identical — every hop, every id, every millimetre of
//! cost — to the same route computed off the never-persisted in-memory
//! build of the same input.
//!
//! That equality is the entire architectural claim `chartcore::mivnav`
//! rests on. §0's split is "build a complete navigation database at
//! chart-import time; at route-request time, perform only thresholding, a
//! search over a compiled topology, and localised refinement" — and until
//! a persisted artifact can answer a query with the SAME answer a fresh
//! build would, that split is aspirational. Everything else in this
//! module tree is downstream of it: if a route off a loaded file could
//! differ from a route off a fresh build, no amount of correct
//! precomputation would matter, because the boat would be navigating on
//! whichever of the two happened to be in memory.
//!
//! The fixture is `backend/data/fnc/DE6OSTIM.S57`, the same real, small,
//! CC0 freenauticalchart.net cell every other `mivnav_*` integration test
//! in this directory uses, at the same two known-good query points — so a
//! difference in outcome between files means something real changed, not
//! that two files picked different ground truth.
//!
//! # What this file does NOT prove
//!
//! Nothing here goes near the backend. `chartcore.mivnav_route`'s pyo3
//! binding DOES open a `.mivnav` now (Phase 9), through the process-global
//! `(path, sequence)` cache in `chartcore::mivnav::artifact_cache` — that
//! wiring and the cache are proven in `mivnav_artifact_cache_de6ostim.rs`
//! and `backend/tests/test_routing_mivnav.py`. This file proves the layer
//! underneath both: the file format and the raw `load_region`/`load_band`
//! path, with no cache in the picture.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::Extent;
use chartcore::mivnav::{
    band_to_dm, build_artifact, corridor_extent, load_artifact, load_band, load_region,
    publish_artifact, select_band, select_band_index, snap_point, topology_route,
    topology_route_graced_with, ArtifactReader, ArtifactVersions, BandTag, ChartSetIdentity,
    RegionArtifact, SectionKind, TopologyWeights,
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

/// Identical to every other `mivnav_*_de6ostim.rs` file's own region:
/// the cell's extent plus a quarter of its width of padding, so the "no
/// chart reaches here" rule is exercised at the margins in the same
/// build.
fn region_extent() -> Extent {
    let e = cell().extent;
    let pad = (e.xmax - e.xmin) / 4;
    Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad)
}

/// (lon, lat) — the same two real points every other file in this suite
/// uses for this cell: the west channel, the only substantial navigable
/// stretch here at a small draft.
const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);

/// The draft every test here queries at, and the band it selects. 1.0 m
/// is `BAND_LADDER_M`'s own shallowest rung, so `select_band_index`
/// answers 0 exactly and the quantised-feasibility caveat
/// (`query::select_band`'s docs) never enters into it.
const REQUIRED_M: f64 = 1.0;

/// The freshly-built, NEVER-PERSISTED artifact — the reference every
/// assertion in this file compares a loaded one against.
///
/// Built once for the whole binary: `build_artifact` is
/// `O(bands × region size)` by construction (ten `label_band` →
/// `detect_portals` → `build_shortcuts` sweeps, see `persist.rs`'s own
/// docs on why that cost is the point rather than a regression), and
/// re-running it per test would dominate this file's wall clock without
/// testing anything a second time.
fn fresh() -> &'static RegionArtifact {
    static A: OnceLock<RegionArtifact> = OnceLock::new();
    A.get_or_init(|| build_artifact(&[cell().clone()], region_extent(), CatzocMode::Off))
}

fn chart_set() -> ChartSetIdentity {
    ChartSetIdentity::new("de6ostim-persist-test", 1)
}

/// Temporary directory that cleans up on drop.
struct TestDir(PathBuf);
impl TestDir {
    fn new(tag: &str) -> TestDir {
        let dir = std::env::temp_dir().join(format!(
            "mivnav-persist-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        TestDir(dir)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Publish `fresh()` and hand back the file's bytes — the artifact
/// exactly as it lands on disk. Built once per binary for the same
/// reason `fresh()` is.
fn published_bytes() -> &'static [u8] {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    BYTES.get_or_init(|| {
        let dir = TestDir::new("bytes");
        let path = dir.path("DE6OSTIM.mivnav");
        publish_artifact(&path, chart_set(), fresh()).expect("atomic publish succeeds");
        std::fs::read(&path).expect("published file reads back")
    })
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

#[test]
fn a_route_off_a_loaded_artifact_is_identical_to_one_off_the_fresh_build() {
    // Publish to a real file and re-open it through the real
    // file-opening path — not `from_slice` over bytes still in hand.
    let dir = TestDir::new("round-trip");
    let path = dir.path("DE6OSTIM.mivnav");
    publish_artifact(&path, chart_set(), fresh()).expect("atomic publish succeeds");
    let reader = ArtifactReader::from_file(&path).expect("published file parses");
    assert_eq!(
        reader.staleness(chart_set(), &ArtifactVersions::CURRENT),
        None,
        "a just-published artifact must not read as stale"
    );

    let loaded_built = load_region(&reader).expect("the spatial field loads");
    let band_index = select_band_index(REQUIRED_M);
    assert_eq!(band_index, 0, "1.0 m is the ladder's own shallowest rung");
    let loaded_band = load_band(&reader, &loaded_built, band_index).expect("band 0 loads");
    assert_eq!(loaded_band.band_m(), Some(select_band(REQUIRED_M)));

    let fresh_built = &fresh().built;
    let fresh_band = fresh()
        .band(band_index)
        .expect("the fresh build has band 0");

    // The structures themselves come back identical, so the route
    // comparison below is a check on the QUERY, not a coincidence of two
    // different inputs happening to agree.
    assert_eq!(loaded_built.tiles, fresh_built.tiles);
    assert_eq!(loaded_built.depth_min, fresh_built.depth_min);
    assert_eq!(loaded_built.depth_max, fresh_built.depth_max);
    assert_eq!(loaded_built.flags, fresh_built.flags);
    assert_eq!(loaded_built.stitch, fresh_built.stitch);
    assert_eq!(&loaded_band, fresh_band);
    assert!(
        !loaded_band.portals.is_empty(),
        "the real cell must produce real portals at 1.0 m"
    );

    // ---- the actual claim ----
    let from = chartcore::coords::lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0);
    let to = chartcore::coords::lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0);

    let loaded_start = snap_point(&loaded_built, from).expect("channel north is inside the region");
    let loaded_goal = snap_point(&loaded_built, to).expect("channel south is inside the region");
    let fresh_start = snap_point(fresh_built, from).expect("channel north is inside the region");
    let fresh_goal = snap_point(fresh_built, to).expect("channel south is inside the region");
    assert_eq!(loaded_start, fresh_start);
    assert_eq!(loaded_goal, fresh_goal);

    let draft_dm = band_to_dm(REQUIRED_M);
    let loaded_route = topology_route(
        &loaded_built,
        &loaded_band.portals,
        loaded_start.tile,
        loaded_goal.tile,
        draft_dm,
    )
    .expect("the loaded artifact must route the real west channel");
    let fresh_route = topology_route(
        fresh_built,
        &fresh_band.portals,
        fresh_start.tile,
        fresh_goal.tile,
        draft_dm,
    )
    .expect("the fresh build must route the real west channel");

    assert_eq!(
        loaded_route, fresh_route,
        "a route off the persisted artifact must equal the route off the fresh build"
    );
    // Not a vacuous route: it really crosses the region rather than
    // starting where it ends.
    assert_ne!(loaded_route.start_tile, loaded_route.goal_tile);
    assert!(!loaded_route.hops.is_empty());
    assert!(loaded_route.cost_mm > 0);
    println!(
        "DE6OSTIM band {band_index} ({} m): {} tiles, {} portals, {} shortcuts; \
         route {} -> {} in {} hops, {} mm",
        select_band(REQUIRED_M),
        loaded_built.tiles.len(),
        loaded_band.portals.len(),
        loaded_band.shortcuts.len(),
        loaded_route.start_tile,
        loaded_route.goal_tile,
        loaded_route.hops.len(),
        loaded_route.cost_mm
    );

    // The corridor derived from each is the same too — the thing a
    // caller would actually hand onward to the fine search.
    assert_eq!(
        corridor_extent(&loaded_built, &loaded_route, 250.0),
        corridor_extent(fresh_built, &fresh_route, 250.0)
    );

    // And the same holds for the graced entry point and for a WEIGHTED
    // search, so the equality is not an artifact of one code path: the
    // soft-cost multipliers read `touches_fairway`/`touches_tss` off the
    // decoded portal records, which a flag-bit mix-up in the encoding
    // would silently change.
    for weights in [
        TopologyWeights::default(),
        TopologyWeights {
            tss_avoidance_weight: 0.5,
            fairway_preference_weight: 0.25,
        },
    ] {
        let a = topology_route_graced_with(
            &loaded_built,
            &loaded_band.portals,
            from,
            to,
            draft_dm,
            150.0,
            weights,
        );
        let b = topology_route_graced_with(
            fresh_built,
            &fresh_band.portals,
            from,
            to,
            draft_dm,
            150.0,
            weights,
        );
        assert_eq!(
            a, b,
            "graced+weighted search must agree, weights {weights:?}"
        );
        assert!(a.is_some(), "the graced search must find the channel");
    }
}

#[test]
fn every_band_of_the_real_region_round_trips_through_the_file() {
    // Band 0 is what the route proof above exercises; this covers the
    // other nine, which a query at a different draft would reach.
    let reader = ArtifactReader::from_slice(published_bytes()).expect("published file parses");
    let loaded = load_artifact(&reader).expect("the whole artifact loads");
    let fresh = fresh();

    assert_eq!(loaded.bands.len(), fresh.bands.len());
    assert_eq!(loaded.built.tiles, fresh.built.tiles);
    assert_eq!(loaded.built.depth_min, fresh.built.depth_min);
    assert_eq!(loaded.built.depth_max, fresh.built.depth_max);
    assert_eq!(loaded.built.flags, fresh.built.flags);
    assert_eq!(loaded.built.stitch, fresh.built.stitch);
    for (i, (a, b)) in loaded.bands.iter().zip(&fresh.bands).enumerate() {
        assert_eq!(a, b, "band {i} did not round-trip");
    }

    // The bands genuinely differ from one another on this real chart —
    // without that, ten identical labellings would round-trip just as
    // well with the band tag ignored entirely, and this test would prove
    // nothing about per-band addressing.
    let distinct_portal_counts: std::collections::BTreeSet<usize> =
        loaded.bands.iter().map(|b| b.portals.len()).collect();
    assert!(
        distinct_portal_counts.len() > 1,
        "the real cell must produce different portal sets at different drafts, got {distinct_portal_counts:?}"
    );
    // A deeper band can only ever exclude water, never add it.
    for w in loaded.bands.windows(2) {
        for (i, &deep) in w[1].components.label.iter().enumerate() {
            if deep != chartcore::mivnav::NO_COMPONENT {
                assert_ne!(
                    w[0].components.label[i],
                    chartcore::mivnav::NO_COMPONENT,
                    "cell {i} navigable at {:?} m but not at {:?} m",
                    w[1].band_m(),
                    w[0].band_m()
                );
            }
        }
    }
}

#[test]
fn the_streamed_publish_writes_the_identical_file_one_band_at_a_time() {
    // `publish_region_streaming` builds and writes each band in turn,
    // never holding more than one resident — the national-scale memory
    // fix (`MIVNAV_NEXT_TASKS.md`'s "stream bands to disk" task). Hold the
    // region input fixed (reuse `fresh()`), so this isolates the WRITE:
    // the bytes must equal `publish_artifact`'s over the same
    // `RegionArtifact`, to the byte.
    let dir = TestDir::new("streamed");
    let path = dir.path("DE6OSTIM.streamed.mivnav");
    let a = fresh();
    let summary = chartcore::mivnav::publish_region_streaming(
        &path,
        chart_set(),
        &a.built,
        &a.hazard_rings,
        &a.directional,
        None,
    )
    .expect("streamed publish succeeds");

    assert_eq!(
        std::fs::read(&path).expect("streamed file reads back"),
        published_bytes(),
        "the streamed artifact must be byte-for-byte the non-streamed one"
    );

    // The summary carries exactly what the in-memory `RegionArtifact`
    // would have let the caller compute, and nothing else is kept.
    assert_eq!(summary.bands as usize, a.bands.len());
    assert_eq!(summary.bands, 10);
    assert_eq!(summary.report, a.built.report);
    assert_eq!(
        summary.portals,
        a.bands.iter().map(|b| b.portals.len() as u64).sum::<u64>()
    );
    assert_eq!(
        summary.shortcuts,
        a.bands
            .iter()
            .map(|b| b.shortcuts.len() as u64)
            .sum::<u64>()
    );
    assert!(
        summary.portals > 0,
        "the real cell has portals at some band"
    );
}

#[test]
fn build_and_publish_region_streaming_matches_the_in_memory_build_end_to_end() {
    // The whole-pipeline entry the backend's `mivnav_build_artifact` now
    // calls (region build included). Byte-identical to `build_artifact` +
    // `publish_artifact` on the same cell — proving the streaming change
    // is about WHEN a band is held resident, never what is written.
    let dir = TestDir::new("streamed-e2e");
    let in_memory = dir.path("in-memory.mivnav");
    let streamed = dir.path("streamed.mivnav");

    let built = build_artifact(&[cell().clone()], region_extent(), CatzocMode::Off);
    publish_artifact(&in_memory, chart_set(), &built).expect("in-memory publish");

    let summary = chartcore::mivnav::build_and_publish_region_streaming(
        &streamed,
        chart_set(),
        &[cell().clone()],
        region_extent(),
        CatzocMode::Off,
        None,
    )
    .expect("streamed build + publish");

    assert_eq!(
        std::fs::read(&in_memory).unwrap(),
        std::fs::read(&streamed).unwrap(),
        "the streamed build must match the in-memory build byte-for-byte"
    );
    assert_eq!(summary.bands, 10);
    assert_eq!(summary.report, built.built.report);
    assert_eq!(
        summary.portals,
        built
            .bands
            .iter()
            .map(|b| b.portals.len() as u64)
            .sum::<u64>()
    );
}

#[test]
fn a_corrupted_portals_section_never_panics_and_never_answers_anyway() {
    // §19's own posture, one layer down: a damaged artifact must be
    // REFUSED, not misread. A portal record misparsed by even one field
    // is a route through a channel the vessel does not fit — the exact
    // failure this whole module tree's "checked reads, never indexing
    // that can panic" rule exists to prevent — and a reader that panics
    // instead takes the boat's server down with it.
    let base = published_bytes().to_vec();
    let reader = ArtifactReader::from_slice(&base).expect("published file parses");
    let built = load_region(&reader).expect("the spatial field loads");
    let target = reader
        .sections()
        .find(|e| {
            e.kind == SectionKind::Portals
                && BandTag::parse(reader.section_bytes(*e))
                    .map(|t| t.band_index == 3)
                    .unwrap_or(false)
        })
        .expect("band 3 has a portals section");
    drop(reader);

    let start = target.offset as usize;
    let end = (target.offset + target.len) as usize;
    assert!(target.len > 16, "band 3 must have a non-trivial payload");

    // Seven kinds of STRUCTURALLY IMPOSSIBLE damage to the same
    // section, each of which a bad SD card, a half-finished copy or a
    // version skew could plausibly produce. Every one must be refused
    // by name.
    //
    // Note which layer each reaches, because it is not obvious and an
    // earlier draft of this test got it wrong (found by code review):
    // blanking the WHOLE payload also destroys its `BandTag`, so
    // `find_band_section(Portals, 3)` simply does not find the section
    // and `decode_portals` is never called at all. Those cases test the
    // band LOOKUP. The `_body` variants below leave the 8-byte tag
    // intact and blank everything after it, which is what actually puts
    // the corrupted bytes in front of the decoder.
    let mut damaged: Vec<(&str, Vec<u8>)> = Vec::new();

    let mut all_ff = base.clone();
    all_ff[start..end].fill(0xFF);
    damaged.push(("every byte 0xFF (tag destroyed, lookup fails)", all_ff));

    let mut all_zero = base.clone();
    all_zero[start..end].fill(0x00);
    damaged.push(("every byte zero (tag destroyed, lookup fails)", all_zero));

    // Tag intact, body blanked — these DO reach `decode_portals`.
    let mut body_ff = base.clone();
    body_ff[start + 8..end].fill(0xFF);
    damaged.push(("body 0xFF, tag intact (reaches the decoder)", body_ff));

    let mut body_zero = base.clone();
    body_zero[start + 8..start + 16].fill(0x00);
    damaged.push(("header zeroed, tag intact (reaches the decoder)", body_zero));

    // A record count larger than the payload can hold.
    let mut over_count = base.clone();
    over_count[start + 8..start + 12].copy_from_slice(&u32::MAX.to_le_bytes());
    damaged.push(("count = u32::MAX", over_count));

    // A stride the reader cannot walk.
    let mut bad_stride = base.clone();
    bad_stride[start + 12..start + 16].copy_from_slice(&1u32.to_le_bytes());
    damaged.push(("stride = 1", bad_stride));

    // A band tag claiming a depth this build's rung 3 is not — §19's
    // stale-ladder case, which must be named rather than silently read.
    let mut wrong_band = base.clone();
    let bogus_dm = BandTag::parse(&base[start..end]).unwrap().band_dm + 7;
    wrong_band[start + 2..start + 4].copy_from_slice(&bogus_dm.to_le_bytes());
    damaged.push(("band tag depth moved", wrong_band));

    for (what, bytes) in damaged {
        let Ok(reader) = ArtifactReader::from_slice(&bytes) else {
            // Refusing the whole file is also an acceptable answer; what
            // is not acceptable is a panic or a wrong route.
            continue;
        };
        // The spatial field is untouched and must still load...
        let built_again = load_region(&reader).expect("the field survives a damaged band section");
        assert_eq!(built_again.tiles, built.tiles, "{what}");
        // ...band 3 must be refused. (`Debug`-printing a whole
        // `BandTopology` on failure would dump a million component
        // labels, so the assertion is spelled out by hand rather than
        // left to `expect_err`.)
        match load_band(&reader, &built_again, 3) {
            Err(e) => assert!(
                !e.to_string().is_empty(),
                "{what}: the refusal must say something"
            ),
            Ok(_) => panic!("{what}: a damaged portals section must not load"),
        }
        // ...and every other band must be unaffected, so one damaged
        // section does not cost the whole artifact. Band 0 is in this
        // list on purpose: the all-zero case retags the damaged section
        // as `band_index = 0`, so there are then TWO sections claiming
        // band 0 and this is also asserting that `find_band_section`'s
        // documented first-wins rule picks the real one (written
        // earlier in file order) rather than the wreckage.
        for other in [0u8, 1, 2, 4, 9] {
            assert!(
                load_band(&reader, &built_again, other).is_ok(),
                "{what}: band {other} must be unaffected"
            );
        }
    }

    // The case that does NOT get refused, recorded honestly rather than
    // asserted away: zero the RECORDS but leave the section header
    // intact, and the payload is still structurally valid — `count`
    // records of `stride` bytes each, every field a legal integer. It
    // loads. `decode_portals` checks structure, not semantics, on
    // purpose (its own docs say so), and there is no per-section
    // checksum in the format, so an in-record bit flip is simply not
    // detectable at this layer.
    //
    // What DOES hold, and is worth pinning, is the direction the damage
    // takes: a zeroed record reads as `max_draft_dm == 0`, which
    // `topology_route_with` filters out as an unusable edge, so the
    // corrupted band answers "no route" rather than inventing one. The
    // generous direction (a record flipped to 0xFFFF, claiming 6553.5 m
    // of water) is NOT excluded by anything here — see this test's own
    // note below and `persist.rs`'s docs. It is bounded elsewhere: the
    // topology layer only ever picks a CORRIDOR, and the route a caller
    // actually gets comes from `routing::artifact`'s fine search over
    // real decoded cells plus §16's exact verification, neither of which
    // reads this file.
    let mut torn = base.clone();
    torn[start + 16..end].fill(0x00);
    let reader = ArtifactReader::from_slice(&torn).expect("a zeroed record table still parses");
    let built_again = load_region(&reader).expect("the field is untouched");
    let band = load_band(&reader, &built_again, 3).expect("zeroed records are structurally valid");
    assert!(
        !band.portals.is_empty(),
        "the zeroed records are still records"
    );
    assert!(
        band.portals.iter().all(|p| p.max_draft_dm == 0),
        "a zeroed record must read as zero capacity"
    );
    let from = chartcore::coords::lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0);
    let to = chartcore::coords::lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0);
    let s = snap_point(&built_again, from).unwrap();
    let g = snap_point(&built_again, to).unwrap();
    assert_eq!(
        topology_route(
            &built_again,
            &band.portals,
            s.tile,
            g.tile,
            band_to_dm(REQUIRED_M)
        ),
        None,
        "zero-capacity portals must route nothing, not everything"
    );

    // Finally: every truncation of the whole file at 4 KiB steps. Some
    // parse and some do not; none may panic, at any layer.
    for len in (0..base.len()).step_by(4096) {
        if let Ok(reader) = ArtifactReader::from_slice(&base[..len]) {
            if let Ok(built) = load_region(&reader) {
                let _ = load_band(&reader, &built, 3);
            }
        }
    }
}

#[test]
fn the_real_artifact_is_a_sane_size_and_the_run_length_labelling_pays_for_itself() {
    // `topology::encode_components`' own docs claim a run-length
    // labelling is worth its cost on real data rather than in principle.
    // This is that measurement, on the real cell, printed so a future
    // change to the encoding shows its effect rather than merely passing.
    let bytes = published_bytes();
    let reader = ArtifactReader::from_slice(bytes).expect("published file parses");

    let cells: usize = fresh().built.tiles.iter().map(|t| t.cell_count()).sum();
    assert!(cells > 0);

    let components: u64 = reader
        .sections()
        .filter(|e| e.kind == SectionKind::Components)
        .map(|e| e.len)
        .sum();
    let portals: u64 = reader
        .sections()
        .filter(|e| e.kind == SectionKind::Portals)
        .map(|e| e.len)
        .sum();
    let topology: u64 = reader
        .sections()
        .filter(|e| e.kind == SectionKind::Topology)
        .map(|e| e.len)
        .sum();
    let field: u64 = reader
        .sections()
        .filter(|e| {
            matches!(
                e.kind,
                SectionKind::TileIndex
                    | SectionKind::DepthMin
                    | SectionKind::DepthMax
                    | SectionKind::Flags
                    | SectionKind::BoundaryStitch
            )
        })
        .map(|e| e.len)
        .sum();
    let hazard_rings: u64 = reader
        .sections()
        .filter(|e| e.kind == SectionKind::HazardRings)
        .map(|e| e.len)
        .sum();
    let semantics: u64 = reader
        .sections()
        .filter(|e| e.kind == SectionKind::Semantics)
        .map(|e| e.len)
        .sum();
    let landmarks: u64 = reader
        .sections()
        .filter(|e| e.kind == SectionKind::Landmarks)
        .map(|e| e.len)
        .sum();

    // What a flat u32-per-cell column would have cost for all ten bands.
    let flat = (cells * 4 * 10) as u64;
    println!(
        "DE6OSTIM artifact: {} cells, {} bytes total\n  \
         field {field} B, components {components} B (flat would be {flat} B, \
         {:.1}x), portals {portals} B, topology {topology} B",
        cells,
        bytes.len(),
        flat as f64 / components.max(1) as f64,
    );
    println!("  hazard rings {hazard_rings} B, semantics {semantics} B, landmarks {landmarks} B");
    assert!(
        components * 4 < flat,
        "the run-length labelling must beat a flat column by a real margin on real data: \
         {components} B vs {flat} B"
    );

    // The section table accounts for the whole file bar the header, the
    // 8-byte alignment padding between payloads, and the table itself —
    // i.e. nothing is being written that the table does not describe.
    let payload: u64 = reader.sections().map(|e| e.len).sum();
    assert_eq!(
        payload,
        field + hazard_rings + semantics + landmarks + components + portals + topology
    );
    assert!(payload < bytes.len() as u64);
    // 5 spatial + hazard rings + directional semantics + 4 per band
    // (components / portals / topology / landmarks).
    assert_eq!(reader.sections().count(), 7 + 4 * 10);
}
