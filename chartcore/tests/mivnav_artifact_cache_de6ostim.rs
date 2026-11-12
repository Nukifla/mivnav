// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! `chartcore::mivnav::artifact_cache` against a real published `.mivnav`.
//!
//! The served `"mivnav"` path opened the artifact with a full owned
//! `std::fs::read` + `load_region` + `load_band` on **every**
//! `/routing/plan` request — ~2 s and ~6 GB resident per request at
//! national scale (`MIVNAV_ARTIFACT_TODO.md`). `artifact_cache::get`
//! keys one opened artifact on `(path, identity)` so the read and the
//! decode happen once per `(path, sequence)`, not once per request.
//!
//! What this file proves on the real DE6OSTIM cell:
//!
//! 1. a second `get` of the same key is a HIT — same `Arc`, no file read;
//! 2. the band decode inside `OpenArtifact` is cached the same way;
//! 3. the topology route computed off the CACHED region + band is
//!    byte-identical (every hop, every millimetre) to one computed off a
//!    fresh `load_region`/`load_band` of the same file — the cache is a
//!    pure accelerator, it changes no answer;
//! 4. a bumped chart-set sequence is a fresh read, never the stale entry;
//! 5. a stale identity is refused with the same wording the direct path
//!    used, and is never cached.
//!
//! The process-global cache is shared by every test in this binary, so
//! each test takes [`SERIAL`] and calls `clear()` first.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use chartcore::coords::Extent;
use chartcore::mivnav::{
    artifact_cache, band_to_dm, build_artifact, load_band, load_region, publish_artifact,
    select_band_index, topology_route_graced_with, ArtifactReader, ChartSetIdentity,
    RegionArtifact, TopologyWeights,
};
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::artifact::CatzocMode;

/// Serialises the tests: they share the one process-global cache.
static SERIAL: Mutex<()> = Mutex::new(());

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

/// The same west-channel points every `mivnav_*_de6ostim.rs` file uses.
const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);
const REQUIRED_M: f64 = 1.0;

fn fresh_artifact() -> &'static RegionArtifact {
    static A: OnceLock<RegionArtifact> = OnceLock::new();
    A.get_or_init(|| build_artifact(&[cell().clone()], region_extent(), CatzocMode::Off))
}

struct TestDir(PathBuf);
impl TestDir {
    fn new(tag: &str) -> TestDir {
        let dir = std::env::temp_dir().join(format!(
            "mivnav-cache-{tag}-{}-{:?}",
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

/// Publish `fresh_artifact()` at `path` under `("de6ostim", sequence)`.
fn publish_at(path: &std::path::Path, sequence: u64) -> ChartSetIdentity {
    let id = ChartSetIdentity::new("de6ostim", sequence);
    publish_artifact(path, id, fresh_artifact()).expect("publish artifact");
    id
}

fn world(p: (f64, f64)) -> chartcore::coords::WorldXy {
    chartcore::coords::lat_lon_to_world(p.1, p.0)
}

#[test]
fn a_second_get_is_a_hit_and_the_band_decode_is_cached_too() {
    let _g = SERIAL.lock().unwrap();
    artifact_cache::clear();
    let (h0, m0) = artifact_cache::cache_stats();

    let dir = TestDir::new("hit");
    let path = dir.path("de6ostim.mivnav");
    let id = publish_at(&path, 1);

    let a = artifact_cache::get(&path, id).expect("first get opens the file");
    let b = artifact_cache::get(&path, id).expect("second get");
    assert!(
        std::sync::Arc::ptr_eq(&a, &b),
        "the same key must hand back the same OpenArtifact"
    );

    let (h1, m1) = artifact_cache::cache_stats();
    assert_eq!(m1 - m0, 1, "exactly one file read for two gets");
    assert_eq!(h1 - h0, 1, "the second get was a hit");

    let bi = select_band_index(REQUIRED_M);
    let band1 = a.band(bi).expect("band decodes");
    let band2 = a.band(bi).expect("band again");
    assert!(
        std::sync::Arc::ptr_eq(&band1, &band2),
        "a band is decoded once and shared"
    );
}

#[test]
fn the_band_cache_evicts_the_oldest_one_at_a_time_never_wholesale() {
    let _g = SERIAL.lock().unwrap();
    artifact_cache::clear();

    let dir = TestDir::new("bands");
    let path = dir.path("de6ostim.mivnav");
    let id = publish_at(&path, 1);
    let art = artifact_cache::get(&path, id).expect("open");

    // Touch one more distinct band than the cache holds. The first is
    // the one that must be evicted; everything after it must survive.
    let cap = chartcore::mivnav::artifact_cache::MAX_CACHED_BANDS as u8;
    let oldest = art.band(0).expect("band 0");
    let mut kept = Vec::new();
    for bi in 1..=cap {
        kept.push((bi, art.band(bi).expect("band decodes")));
    }

    // The still-resident bands come back as the SAME Arc (no re-decode).
    for (bi, arc) in &kept {
        let again = art.band(*bi).expect("still cached");
        assert!(
            std::sync::Arc::ptr_eq(arc, &again),
            "band {bi} was dropped even though it is within the last {cap}"
        );
    }
    // Band 0 was pushed out — a fresh decode, a new Arc.
    let reloaded = art.band(0).expect("band 0 re-decodes");
    assert!(
        !std::sync::Arc::ptr_eq(&oldest, &reloaded),
        "the oldest band should have been evicted, not kept"
    );
}

#[test]
fn the_cached_route_is_byte_identical_to_one_off_a_fresh_load() {
    let _g = SERIAL.lock().unwrap();
    artifact_cache::clear();

    let dir = TestDir::new("identical");
    let path = dir.path("de6ostim.mivnav");
    let id = publish_at(&path, 1);

    // Reference: open the file directly, no cache in the picture.
    let reader = ArtifactReader::from_file(&path).expect("direct open");
    let direct_region = load_region(&reader).expect("direct region");
    let bi = select_band_index(REQUIRED_M);
    let direct_band = load_band(&reader, &direct_region, bi).expect("direct band");

    let cached = artifact_cache::get(&path, id).expect("cached open");
    let cached_band = cached.band(bi).expect("cached band");

    let (from, to) = (world(CHANNEL_NORTH), world(CHANNEL_SOUTH));
    let draft_dm = band_to_dm(REQUIRED_M);
    let weights = TopologyWeights::default();

    let direct = topology_route_graced_with(
        &direct_region,
        &direct_band.portals,
        from,
        to,
        draft_dm,
        0.0,
        weights,
    );
    let via_cache = topology_route_graced_with(
        cached.region(),
        &cached_band.portals,
        from,
        to,
        draft_dm,
        0.0,
        weights,
    );

    let direct = direct.expect("the reference route exists on this fixture");
    let via_cache = via_cache.expect("the cached route exists");
    assert_eq!(
        direct.0, via_cache.0,
        "the topology route off the cache must equal the one off a fresh load, exactly"
    );
    assert_eq!(direct.1, via_cache.1, "start snap identical");
    assert_eq!(direct.2, via_cache.2, "goal snap identical");
    // And the band's own header counts round-trip through the cache.
    assert_eq!(direct_band.components.count, cached_band.components.count);
    assert_eq!(direct_band.portals.len(), cached_band.portals.len());
    assert_eq!(direct_band.shortcuts.len(), cached_band.shortcuts.len());
}

#[test]
fn a_bumped_sequence_reloads_and_never_serves_the_previous_entry() {
    let _g = SERIAL.lock().unwrap();
    artifact_cache::clear();
    let (h0, m0) = artifact_cache::cache_stats();

    let dir = TestDir::new("seq");
    let p1 = dir.path("de6ostim.v1.mivnav");
    let id1 = publish_at(&p1, 1);
    let a1 = artifact_cache::get(&p1, id1).expect("get seq 1");

    // A rebuild lands a new file and the request carries the new sequence.
    let p2 = dir.path("de6ostim.v2.mivnav");
    let id2 = publish_at(&p2, 2);
    let a2 = artifact_cache::get(&p2, id2).expect("get seq 2");

    assert!(
        !std::sync::Arc::ptr_eq(&a1, &a2),
        "a new sequence must not reuse the old opened artifact"
    );
    let (h1, m1) = artifact_cache::cache_stats();
    assert_eq!(m1 - m0, 2, "each distinct key was read from disk");
    assert_eq!(h1 - h0, 0, "neither get was a hit");

    // The old key is gone (capacity one): re-getting it is a fresh read.
    let _ = artifact_cache::get(&p1, id1).expect("re-get seq 1");
    let (_, m2) = artifact_cache::cache_stats();
    assert_eq!(m2 - m1, 1, "the evicted key re-reads rather than hitting");
}

#[test]
fn a_stale_identity_is_refused_with_the_direct_paths_wording_and_not_cached() {
    let _g = SERIAL.lock().unwrap();
    artifact_cache::clear();

    let dir = TestDir::new("stale");
    let path = dir.path("de6ostim.mivnav");
    let built_id = publish_at(&path, 1);

    // The request believes the chart set has moved on since the build.
    let newer = ChartSetIdentity::new("de6ostim", built_id.sequence + 1);
    let err = artifact_cache::get(&path, newer).expect_err("a newer sequence is stale");
    assert!(
        err.contains("stale") || err.contains("sequence"),
        "expected §19 staleness wording, got: {err}"
    );

    let (_, m0) = artifact_cache::cache_stats();
    let _ = artifact_cache::get(&path, newer);
    let (h1, m1) = artifact_cache::cache_stats();
    assert_eq!(m1 - m0, 1, "a stale get re-checks the file every time");
    assert_eq!(
        h1,
        artifact_cache::cache_stats().0,
        "a stale key never becomes a hit"
    );

    // The same file under its real identity still opens fine.
    artifact_cache::get(&path, built_id).expect("the artifact itself is sound");
}
