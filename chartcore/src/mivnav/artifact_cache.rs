// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! A process-global cache of one opened `.mivnav`, keyed on
//! `(path, chart-set identity)`.
//!
//! # Why this exists
//!
//! The served `"mivnav"` path ([`crate::python`]'s `topology_from_artifact`)
//! used to call [`ArtifactReader::from_file`] — a full owned
//! `std::fs::read` of the whole artifact — then [`load_region`] and
//! [`load_band`] on **every** `/routing/plan` request. On the one small
//! fixture that was 7× faster than rebuilding the region; on a real
//! national set the artifact is gigabytes and the measurement (see
//! `MIVNAV_ARTIFACT_TODO.md`, "What's explicitly NOT proven" item 2) put
//! it at ~2 s and ~6 GB resident **per request**. §0's whole promise is
//! an `O(1)` load, not an `O(region)` one.
//!
//! This module makes the load `O(1)` in the steady state: the file bytes
//! are read once per `(path, identity)`, the spatial field decoded once,
//! and each band / the hazard rings / the semantics decoded at most once
//! and then shared behind an [`Arc`]. A rebuild publishes at the same
//! path with a new `dir_sequence`, so the key changes, the miss reloads,
//! and the old [`OpenArtifact`] (with its owned file buffer) drops.
//!
//! # What it deliberately does NOT do yet
//!
//! - **No mmap.** It still does one owned `std::fs::read` per
//!   `(path, identity)`. [`ArtifactReader::from_slice`] over an mmap
//!   would drop even that one copy to lazy pages, but it saves nothing
//!   *per request* and needs the file mapped somewhere that outlives the
//!   reader — a `MivnavArtifact` handle the backend opens and holds, its
//!   own design piece. Noted in `MIVNAV_NEXT_TASKS.md`.
//! - **No config byte-budget.** Capacity is one artifact plus
//!   [`MAX_CACHED_BANDS`] decoded bands — a boat cycles through one or
//!   two drafts, so this is almost always 1–2 bands. Trading the
//!   per-request read+decode spike for a bounded steady resident set
//!   (the owned file buffer + the region + a couple of bands) is the
//!   accepted shape; a tunable budget like the RAM tile cache's can come
//!   later if a real deployment needs it.
//! - **No `load_band` slimming.** [`load_band`] still expands the
//!   run-length component labelling and every shortcut chain even though
//!   the served path reads only portals + landmarks + the two header
//!   counts. That waste is now paid once per band per `(path, identity)`
//!   rather than per request, so slimming it is lower priority and pairs
//!   with the mmap move.
//!
//! # Staleness
//!
//! [`get`] runs §19's [`ArtifactReader::staleness`] against
//! [`ArtifactVersions::CURRENT`] before caching, and returns the same
//! human string the direct path did on a stale or unreadable file — so
//! the caller's rebuild-and-say-why fallback is unchanged. Only a
//! artifact that is present, structurally sound, and NOT stale is ever
//! cached, which means a cached [`OpenArtifact`] for a key is always safe
//! to serve for that key.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::coords::WorldXy;

use super::directional::DirectionalSemantics;
use super::format::{ArtifactReader, ArtifactVersions, ChartSetIdentity, FormatError};
use super::persist::{load_band, load_hazard_rings, load_region, load_semantics};
use super::{BandTopology, BuiltRegion};

/// How many decoded [`BandTopology`]s one [`OpenArtifact`] keeps. The
/// band ladder has ten rungs but a given vessel's draft selects one; a
/// boat that changes its configured draft a few times still only touches
/// a handful. When full, the OLDEST decoded band is dropped (FIFO), one
/// at a time — a workload that cycles more than this many distinct bands
/// keeps re-decoding the evicted ones, but never thrashes the whole set.
pub const MAX_CACHED_BANDS: usize = 6;

/// Take a lock, recovering the guard if a previous holder panicked. The
/// cache protects only a capacity-one slot and a short band list — there
/// is nothing an interrupted write can leave half-consistent — and a
/// poisoned mutex here would otherwise turn every later `/routing/plan`
/// into a panic across the pyo3 boundary with no rebuild fallback.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One opened, staleness-checked `.mivnav`: the file bytes owned once,
/// the spatial field decoded once, bands / hazard rings / semantics
/// decoded lazily and shared.
///
/// `Debug` prints only shapes and counts, never the gigabyte payload —
/// [`ArtifactReader`]'s own `Debug` already elides its bytes.
#[derive(Debug)]
pub struct OpenArtifact {
    reader: ArtifactReader<'static>,
    region: Arc<BuiltRegion>,
    /// Decoded bands, newest last — a plain `Vec` because there are at
    /// most [`MAX_CACHED_BANDS`] and a linear scan of that is free.
    bands: Mutex<Vec<(u8, Arc<BandTopology>)>>,
    hazard_rings: OnceLock<Arc<Vec<Vec<WorldXy>>>>,
    semantics: OnceLock<Arc<DirectionalSemantics>>,
}

impl OpenArtifact {
    /// The decoded spatial field, shared. `&Arc<_>` so a caller can
    /// [`Arc::clone`] it into a longer-lived structure (`RefineInputs`)
    /// or deref it to `&BuiltRegion` for a topology call.
    pub fn region(&self) -> &Arc<BuiltRegion> {
        &self.region
    }

    /// The topology for one band of [`super::BAND_LADDER_M`], decoded on
    /// first use and shared after. `Err` carries the same
    /// `"artifact band N is unusable: …"` string the direct
    /// [`load_band`] path produced.
    pub fn band(&self, band_index: u8) -> Result<Arc<BandTopology>, String> {
        // Held across the decode: `load_band` on this fixture is a few
        // ms, the whole point of the artifact is that a request does NOT
        // pay a region-scale decode, and serialising two first-touches of
        // the SAME band is strictly better than both allocating a full
        // `u32` component column at once on a memory-tight Pi.
        let mut bands = lock(&self.bands);
        if let Some((_, b)) = bands.iter().find(|(i, _)| *i == band_index) {
            return Ok(Arc::clone(b));
        }
        let decoded = Arc::new(
            load_band(&self.reader, &self.region, band_index)
                .map_err(|e| format!("artifact band {band_index} is unusable: {e}"))?,
        );
        if bands.len() >= MAX_CACHED_BANDS {
            bands.remove(0); // FIFO: drop the oldest, keep the rest
        }
        bands.push((band_index, Arc::clone(&decoded)));
        Ok(decoded)
    }

    /// §12.4 pre-clipped HARD hazard rings, decoded on first use. Empty
    /// for an artifact written before the `HazardRings` section existed —
    /// not corruption, not staleness ([`load_hazard_rings`]' own docs);
    /// the caller re-derives from the request's cells. A genuine decode
    /// error (a structurally broken `HazardRings` section in an
    /// otherwise-sound file) is logged once and then also treated as
    /// empty — the route itself still comes from the fine search + §16
    /// exact verification, which never read this file.
    pub fn hazard_rings(&self) -> Arc<Vec<Vec<WorldXy>>> {
        Arc::clone(self.hazard_rings.get_or_init(|| {
            Arc::new(match load_hazard_rings(&self.reader) {
                Ok(rings) => rings,
                Err(e) => {
                    eprintln!(
                        "mivnav artifact_cache: hazard-ring section unreadable, \
                         routing without pre-stored rings: {e}"
                    );
                    Vec::new()
                }
            })
        }))
    }

    /// §11 directional / buoyage semantics, decoded on first use. Empty
    /// for an artifact predating the `Semantics` section — same
    /// not-staleness rule as [`Self::hazard_rings`], and a real decode
    /// error is likewise logged once and treated as "no rules".
    pub fn semantics(&self) -> Arc<DirectionalSemantics> {
        Arc::clone(self.semantics.get_or_init(|| {
            Arc::new(match load_semantics(&self.reader) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!(
                        "mivnav artifact_cache: semantics section unreadable, \
                         routing without directional rules: {e}"
                    );
                    DirectionalSemantics::default()
                }
            })
        }))
    }
}

type CacheKey = (PathBuf, ChartSetIdentity);
/// The whole cache: at most one opened artifact, with the key it was
/// opened under. Capacity one — see the module docs.
type CacheSlot = Mutex<Option<(CacheKey, Arc<OpenArtifact>)>>;

fn cache() -> &'static CacheSlot {
    static C: OnceLock<CacheSlot> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// Hit / miss counters, for tests and diagnostics. A "hit" returned a
/// cached [`OpenArtifact`] with no file read; a "miss" read and decoded
/// (or failed the staleness check).
pub static CACHE_HITS: AtomicU64 = AtomicU64::new(0);
pub static CACHE_MISSES: AtomicU64 = AtomicU64::new(0);

/// `(hits, misses)` since process start.
pub fn cache_stats() -> (u64, u64) {
    (
        CACHE_HITS.load(Ordering::Relaxed),
        CACHE_MISSES.load(Ordering::Relaxed),
    )
}

/// Drop the cached artifact, if any. The `(path, identity)` key already
/// invalidates on a rebuild; this is for tests and for a caller that
/// knows the on-disk file is gone.
pub fn clear() {
    *lock(cache()) = None;
}

/// The opened, staleness-checked artifact for `path` under `identity`,
/// from cache when the last opened one matches, otherwise read and
/// decoded now and cached.
///
/// `Err` is the human string for "never built" / "unreadable" /
/// "$COMPONENT is stale" — the exact text the direct-read path returned,
/// so the caller's fallback-and-explain behaviour does not change.
///
/// The cache lock is held across the read+decode of a miss. That is
/// seconds on a national artifact and it blocks a concurrent request for
/// a *different* key — but `"mivnav"` routing is a sailor planning a
/// route, not a hot path, there is one chart set per boat, and the
/// alternative (decode outside the lock) lets N concurrent cold-cache
/// requests each `std::fs::read` the whole multi-GB file at once, which
/// is the exact memory spike this cache exists to remove. Serialising
/// the rare cold open is the safe trade.
pub fn get(path: &Path, identity: ChartSetIdentity) -> Result<Arc<OpenArtifact>, String> {
    let key: CacheKey = (path.to_path_buf(), identity);
    let mut guard = lock(cache());
    if let Some((k, art)) = guard.as_ref() {
        if *k == key {
            CACHE_HITS.fetch_add(1, Ordering::Relaxed);
            return Ok(Arc::clone(art));
        }
    }
    CACHE_MISSES.fetch_add(1, Ordering::Relaxed);
    let art = Arc::new(open(path, identity)?);
    *guard = Some((key, Arc::clone(&art)));
    Ok(art)
}

/// Read, staleness-check and partly decode one artifact. Never touches
/// the cache — [`get`] owns that.
fn open(path: &Path, identity: ChartSetIdentity) -> Result<OpenArtifact, String> {
    // "Never built" and "built but damaged" get different text on
    // purpose: the first is the ordinary state of a boat that has not
    // run a build and warrants no alarm, the second is a real fault. The
    // caller's user-facing warning gate depends on telling them apart.
    let reader = ArtifactReader::from_file(path).map_err(|e| match &e {
        FormatError::Io(io) if io.kind() == std::io::ErrorKind::NotFound => {
            format!("no .mivnav has been built at {}", path.to_string_lossy())
        }
        _ => format!("artifact could not be opened: {e}"),
    })?;
    if let Some(stale) = reader.staleness(identity, &ArtifactVersions::CURRENT) {
        return Err(stale.to_string());
    }
    let region =
        Arc::new(load_region(&reader).map_err(|e| format!("artifact region is unusable: {e}"))?);
    Ok(OpenArtifact {
        reader,
        region,
        bands: Mutex::new(Vec::new()),
        hazard_rings: OnceLock::new(),
        semantics: OnceLock::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mivnav::ChartSetIdentity;

    #[test]
    fn a_missing_file_is_reported_as_never_built_and_never_cached() {
        let path =
            std::env::temp_dir().join(format!("mivnav-cache-absent-{}.mivnav", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let id = ChartSetIdentity::new("nope", 1);

        let before = cache_stats().1;
        for _ in 0..2 {
            let err = get(&path, id).expect_err("no such file");
            assert!(
                err.contains("no .mivnav has been built"),
                "want the never-built wording, got: {err}"
            );
        }
        // A failed open is a miss every time — nothing about an absent
        // file is ever cached.
        assert_eq!(cache_stats().1, before + 2, "each absent get re-reads");
    }
}
