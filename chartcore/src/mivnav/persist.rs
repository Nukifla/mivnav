// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Building a whole `.mivnav` file and reading one back — the top of
//! §20's build pipeline and the bottom of §15's query-time load.
//!
//! Everything under this module tree up to now produced *values in
//! memory*: [`super::build::build_region`] a spatial field,
//! [`super::topology::label_band`] a per-band labelling,
//! [`super::portals::detect_portals`] its portals,
//! [`super::shortcuts::build_shortcuts`] its contracted topology. Each of
//! those now has an encode/decode for its own section payload; what did
//! not exist was anything that ran the whole ladder and wrote one FILE,
//! or opened that file and handed a query the same structures back. That
//! is this module, and it is what makes §0's "build once at import time,
//! query cheap" true rather than aspirational — before it, every query
//! rebuilt the region from scratch, which is precisely the work the
//! precompute split exists to avoid.
//!
//! # The cost this moves, and where it lands
//!
//! [`build_all_bands`] runs `label_band` → `detect_portals` →
//! `build_shortcuts` for **every** rung of [`BAND_LADDER_M`], not just
//! the one a particular vessel needs: ten sweeps of the region, where a
//! single query-time build does one. So an artifact build is genuinely
//! `O(bands × region size)` — about 10× the per-band work of the
//! throwaway build a request does today, on top of the region build
//! itself.
//!
//! That is the trade, stated plainly rather than hidden, and it IS the
//! architecture's whole point: §6 forbids the build from knowing any
//! vessel's draft, so "which band do we need" is not a question the
//! builder is allowed to answer — it must precompute all of them or
//! none. The cost is paid once, on a manual trigger, off every
//! interactive path (the same framing [`super::build`]'s own "authority
//! and constraints are rebuilt per node" judgment call already uses), and
//! it buys every subsequent query an `O(1)` load instead of an
//! `O(region)` rebuild. On the boat's Pi — where the real constraint is
//! CPU, not bandwidth (CLAUDE.md) — that is the entire reason this module
//! tree exists.
//!
//! Each band's [`super::topology::label_band`] allocates one `u32` per
//! region cell — its union-find column, which it then relabels in place
//! and returns as the band's labelling — and nothing else `O(cells)`.
//!
//! # The loader is eager and owned, on purpose
//!
//! [`load_band`] decodes a band's components, portals and shortcuts into
//! owned `Vec`s, and [`load_region`] copies the flags column. §15 and
//! [`super::format`]'s docs both state a zero-copy aspiration (8-byte-
//! aligned payloads so a `u16`/`u64` SoA column can be read straight out
//! of an mmap), and this is not that.
//!
//! It is a deliberate first cut, in this module tree's usual "not yet
//! done, here is why" register rather than a silent shortcut. Zero-copy
//! needs every consumer to take a borrowed column instead of a `Vec`:
//! [`super::query::topology_route_with`] takes `&[Portal]`, so portals
//! could in principle borrow, but `Portal` has no `repr(C)` layout
//! guarantee and [`super::topology::Components`] is run-length encoded on
//! disk (see [`super::topology::encode_components`] for why), so neither
//! is readable in place without either a layout guarantee this crate does
//! not currently make or an expansion pass that defeats the point. Doing
//! it properly is real work with real API churn; doing it badly is a
//! `transmute` over untrusted file bytes, which is exactly what this
//! module tree's "checked reads, never indexing that can panic" rule
//! exists to forbid. Eager decode is correct, bounded and measurable
//! today; the aspiration stays documented rather than half-attempted.
//!
//! # What a loaded region does NOT carry
//!
//! [`super::build::BuildReport`] is §20's "record per run" telemetry —
//! tile counts per rung, blocked/no-coverage/charted cell counts — and it
//! is **not persisted**. A [`BuiltRegion`] from [`load_region`] carries
//! `BuildReport::default()`.
//!
//! This is not laziness about a section: `charted_depth_cells` is not
//! recoverable from the persisted columns at all. `field.rs`'s own depth
//! columns write a depth of `0` for an UNCHARTED land cell (§5.1: the
//! land is a fact, its depth is 0 by definition) without counting it as
//! charted, so a `depth_min == 0` land cell is indistinguishable
//! afterwards from a real charted drying height. A recomputed report
//! would be a near-miss presented as the real number — worse than an
//! obvious zero. Persisting it verbatim means a new [`SectionKind`] tag,
//! which is a file-contract decision, and nothing in the query path reads
//! the report (its only consumers are tests and the CLI demo's summary),
//! so it is left as documented future work. [`build_and_publish_region`]
//! returns the freshly built [`RegionArtifact`], report included, so a
//! build trigger can still report on the run it just did.
//!
//! # What a damaged artifact can and cannot do
//!
//! Every decoder here refuses a STRUCTURALLY impossible payload — a
//! count or stride the bytes cannot hold, a chain running past its pool,
//! a labelling that does not describe this file's own cell count, a band
//! section built at a depth this build's ladder does not put that band
//! at. None of them checks anything SEMANTIC, and there is no per-section
//! checksum in the format, so a bit flip INSIDE an otherwise well-formed
//! record is not detectable at this layer at all: a `max_draft_dm`
//! flipped from `0x0032` to `0xFFFF` decodes as a portal claiming
//! 6553.5 m of water, and nothing here will say otherwise.
//!
//! That is bounded, not ignored. What a corrupted portal can do is make
//! the topology layer pick the wrong CORRIDOR. It cannot put a route on
//! the water: the route a caller actually receives comes from
//! [`crate::routing::artifact`]'s fine search over real decoded cells,
//! plus §16's exact verification, neither of which reads this file — the
//! same reasoning [`super::format::chart_set_id_hash`]'s own docs give
//! for using a non-cryptographic hash there. A per-section checksum would
//! buy diagnosability ("this artifact is damaged, rebuild it") rather
//! than safety, and it is a file-contract change; it is a reasonable
//! future addition and deliberately not made here.
//! `tests/mivnav_persist_de6ostim.rs` records both halves of this: the
//! structurally-impossible damage that IS refused, and the one shape that
//! is not.
//!
//! # Running a query against a loaded artifact
//!
//! There is no new query API here and none is needed. A route request
//! against a persisted artifact is:
//!
//! ```text
//! let reader = ArtifactReader::from_file(path)?;
//! reader.staleness(chart_set, &ArtifactVersions::CURRENT)  // §19
//! let built = load_region(&reader)?;
//! let band  = load_band(&reader, &built, select_band_index(required_m))?;
//! topology_route_graced_with(&built, &band.portals, from, to, ...)
//! ```
//!
//! — the identical calls a freshly-built region takes, which is exactly
//! the property `tests/mivnav_persist_de6ostim.rs` proves on real chart
//! data: the answer off the loaded structures is `==` the answer off the
//! never-persisted ones.
//!
//! [`BAND_LADDER_M`]: super::field::BAND_LADDER_M
//! [`SectionKind`]: super::format::SectionKind

use std::io::{self, Seek, Write};
use std::path::Path;

use crate::coords::{Extent, WorldXy};
use crate::model::Cell;
use crate::routing::artifact::{constraints, CatzocMode, ConstraintParams};

use super::bands::band_to_dm;
use super::build::{
    build_region_impl, decode_u16_column, encode_u16_column, BuildProgress, BuildReport,
    BuiltRegion,
};
use super::directional::{
    build_directional_semantics, DirectionalMark, DirectionalSemantics, FlowZone,
};
use super::field::{decode_tile_index, encode_tile_index, TileEntry, BAND_LADDER_M};
use super::format::{
    write_artifact_atomically, ArtifactReader, ArtifactVersions, ArtifactWriter, BandTag,
    ChartSetIdentity, FormatError, SectionKind,
};
use super::landmarks::{build_band_landmarks, decode_landmarks, encode_landmarks, BandLandmarks};
use super::portals::{decode_portals, detect_portals, encode_portals, Portal};
use super::shortcuts::{build_shortcuts, decode_shortcuts, encode_shortcuts, Shortcut};
use super::stitch::{decode_stitch, encode_stitch};
use super::topology::{
    decode_components, decode_components_count, encode_components, label_band, Components,
};
use crate::routing::buoyage::LateralSide;

/// One band's whole precomputed topology: §8.1's labelling, §8.2's
/// portals, §8.4's contracted shortcuts, and the [`BandTag`] tying all
/// three to the same rung of [`BAND_LADDER_M`].
///
/// [`BAND_LADDER_M`]: super::field::BAND_LADDER_M
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BandTopology {
    /// Which band this is, in both the ladder-index and decimetre forms
    /// the file stores — see [`BandTag`].
    pub tag: BandTag,
    pub components: Components,
    pub portals: Vec<Portal>,
    pub shortcuts: Vec<Shortcut>,
    /// §14's ALT landmark / lower-bound table for this band — anchors
    /// farthest-point-sampled over the portal graph and their reduced-
    /// weight distance to every graph node. Empty when the band has no
    /// portals, or when loaded from an artifact written before
    /// [`super::format::SectionKind::Landmarks`] was filled — a caller
    /// then simply gets a weaker (straight-line only) lower bound, so its
    /// absence is not staleness, the same rule
    /// [`RegionArtifact::hazard_rings`]/`directional` follow.
    pub landmarks: BandLandmarks,
}

impl BandTopology {
    /// This band in metres, as [`BAND_LADDER_M`] states it. `None` for a
    /// `tag` whose `band_index` no rung of THIS build's ladder has — the
    /// case a `band_ladder_version` bump produces, which §19 wants
    /// reportable rather than fatal.
    ///
    /// [`BAND_LADDER_M`]: super::field::BAND_LADDER_M
    pub fn band_m(&self) -> Option<f64> {
        BAND_LADDER_M.get(self.tag.band_index as usize).copied()
    }
}

/// A whole region's artifact, in memory: the spatial field, every band's
/// topology in [`BAND_LADDER_M`] order, and §12.4's pre-clipped
/// hazard-ring geometry for local vector refinement.
///
/// [`BAND_LADDER_M`]: super::field::BAND_LADDER_M
#[derive(Debug, Clone)]
pub struct RegionArtifact {
    pub built: BuiltRegion,
    pub bands: Vec<BandTopology>,
    /// §12.4 — the region's HARD hazard rings, in world coordinates,
    /// signed-set convention (positive-area adds, negative-area
    /// subtracts). [`super::refine::refine_segment`] routes a demoted
    /// crossing against exactly these. Empty when the source charts
    /// carried no hard hazard, or when loaded from an artifact built
    /// before [`super::format::SectionKind::HazardRings`] existed — a
    /// caller then re-derives from
    /// `routing::artifact::constraints::build`, so the pre-store is a
    /// resident-set optimisation, not a correctness dependency.
    ///
    /// **Depth-blind** — see [`region_hazard_rings`]'s own SAFETY note
    /// and `refine`'s module docs: these are HARD hazards at
    /// `required_depth_m = 0.0`, not a shoal that blocks a deep vessel.
    pub hazard_rings: Vec<Vec<WorldXy>>,
    /// §11 — the region's directional / buoyage semantics: every charted
    /// traffic-flow polygon (`TSSLPT`/`DWRTPT`/one-way `RECTRC` with
    /// `ORIENT`) and every classifiable lateral mark. [`super::query`]
    /// consults it, once per portal, to forbid a crossing taken against
    /// the charted flow and to nudge a route onto the buoyage-consistent
    /// side. Empty when the source charts carried neither, or when
    /// loaded from an artifact built before
    /// [`super::format::SectionKind::Semantics`] was written — a caller
    /// then re-derives via [`build_directional_semantics`], so like
    /// [`Self::hazard_rings`] this is a resident-set optimisation, not a
    /// correctness dependency, and its absence is not staleness.
    pub directional: DirectionalSemantics,
}

impl RegionArtifact {
    /// This artifact's band at `band_index`, or `None`.
    pub fn band(&self, band_index: u8) -> Option<&BandTopology> {
        self.bands.iter().find(|b| b.tag.band_index == band_index)
    }
}

/// The [`BandTag`] for rung `band_index` of THIS build's
/// [`BAND_LADDER_M`]. `None` for an index off the end of the ladder.
///
/// [`BAND_LADDER_M`]: super::field::BAND_LADDER_M
pub fn band_tag(band_index: u8) -> Option<BandTag> {
    let band_m = BAND_LADDER_M.get(band_index as usize).copied()?;
    Some(BandTag {
        band_index,
        band_dm: band_to_dm(band_m),
    })
}

/// Which band SECTION a vessel needing `required_m` of water must load —
/// [`super::query::select_band`]'s answer as a ladder INDEX rather than a
/// depth in metres.
///
/// `select_band` returns the band itself, which was all a caller needed
/// while every band was rebuilt in memory per request. Addressing a
/// persisted per-band section needs the index, and searching
/// `BAND_LADDER_M` for the returned float at every call site would put a
/// float comparison between a vessel's draft and the connectivity it gets
/// answered with — in ten different places eventually. One function, one
/// rule, and `select_band_index_agrees_with_select_band` below pins the
/// two to each other across the whole ladder and both out-of-range
/// directions, so the duplication cannot drift.
///
/// Every rule `select_band` documents applies here unchanged, including
/// the conservative direction on bad input (non-finite or negative
/// answers the DEEPEST band, never the shallowest) and the
/// quantised-feasibility caveat: a draft between two rungs is answered
/// against the rung above it, so `topology_route` returning `None` is
/// never the final word on routability — only §16's exact verification
/// downstream of the fine search is.
pub fn select_band_index(required_m: f64) -> u8 {
    let last = (BAND_LADDER_M.len() - 1) as u8;
    if !required_m.is_finite() || required_m < 0.0 {
        return last;
    }
    BAND_LADDER_M
        .iter()
        .position(|&b| b >= required_m)
        .map(|i| i as u8)
        .unwrap_or(last)
}

/// Build one band's topology over an already-built region.
///
/// `None` for a `band_index` off [`BAND_LADDER_M`]'s end — there is no
/// such band to build.
///
/// [`BAND_LADDER_M`]: super::field::BAND_LADDER_M
pub fn build_band_topology(built: &BuiltRegion, band_index: u8) -> Option<BandTopology> {
    let tag = band_tag(band_index)?;
    let band_m = BAND_LADDER_M[band_index as usize];
    let components = label_band(built, band_m);
    let portals = detect_portals(built, &components);
    let shortcuts = build_shortcuts(built, &portals);
    let landmarks = build_band_landmarks(built, &portals);
    Some(BandTopology {
        tag,
        components,
        portals,
        shortcuts,
        landmarks,
    })
}

/// Rough peak transient heap ONE [`build_band_topology`] holds live, per
/// region cell: [`label_band`]'s `u32` union-find column, relabelled in
/// place into the band's `label` column (4), plus the portal / shortcut /
/// landmark tables, which are far smaller than the labelling. Rounded up
/// to 8 as the divisor for [`band_pass_concurrency`]: guessing high only
/// serialises a manual, minutes-long, once-per-chart-set job, whereas
/// guessing low swap-kills it (a 16 GB box, `MIVNAV_NEXT_TASKS.md`).
const BAND_PASS_BYTES_PER_CELL: u64 = 8;

/// Fraction of currently-*available* RAM the band pass may commit to its
/// concurrent per-band working sets. The remainder is headroom for the
/// resident [`BuiltRegion`] SoA, the finished-band labellings that
/// accumulate until the file is written, rayon's stacks, and allocator
/// slack.
const BAND_PASS_MEM_FRACTION: f64 = 0.6;

/// `MemAvailable` from `/proc/meminfo`, in bytes — the kernel's own
/// estimate of what a fresh allocation can get without pushing the
/// machine into swap. `None` off Linux, or if the file can't be
/// read/parsed (callers then keep the ambient pool width unchanged).
fn mem_available_bytes() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let rest = text.lines().find_map(|l| l.strip_prefix("MemAvailable:"))?;
    let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
    Some(kb * 1024)
}

/// How many of [`BAND_LADDER_M`]'s bands [`build_all_bands_reporting`]
/// builds concurrently: `pool_width` (what the ambient rayon pool would
/// give this ten-item sweep anyway) unless a memory-budget estimate says
/// fewer per-band working sets fit at once, floored at 1. `region_cells`
/// is [`BuiltRegion::depth_min`]`.len()` — the SoA column length every
/// per-band structure is sized against.
///
/// On a fixture-scale region (or with no `/proc/meminfo` to read) this
/// returns `pool_width` unchanged, so the caller stays on the global
/// pool and behaviour is exactly as before; it only drops lower once
/// `region_cells` is large enough that `pool_width` per-band passes
/// would not fit in [`BAND_PASS_MEM_FRACTION`] of free RAM — the
/// national-set case that swap-killed a 16 GB box. A lower value changes
/// nothing in the output: [`build_all_bands_reporting`] collects an
/// indexed `map`, so ladder order is fixed regardless of concurrency.
fn band_pass_concurrency(region_cells: usize, pool_width: usize) -> usize {
    let ceiling = pool_width.max(1);
    let per_band = (region_cells as u64).saturating_mul(BAND_PASS_BYTES_PER_CELL);
    let Some(avail) = mem_available_bytes() else {
        return ceiling;
    };
    if per_band == 0 {
        return ceiling;
    }
    let budget = (avail as f64 * BAND_PASS_MEM_FRACTION) as u64;
    ((budget / per_band).max(1) as usize).min(ceiling)
}

/// Every band of [`BAND_LADDER_M`], in ladder order. The `O(bands ×
/// region size)` cost the module docs make explicit is real, but the
/// bands are fully independent — [`build_band_topology`] is a pure
/// function of `&built` and the index — so they are built in parallel
/// with `rayon`. Order is preserved (an indexed `map` → `collect`), so
/// the artifact is byte-identical to a serial build; `mivnav_persist_
/// de6ostim.rs`'s round-trip and determinism tests pin that.
///
/// [`BAND_LADDER_M`]: super::field::BAND_LADDER_M
pub fn build_all_bands(built: &BuiltRegion) -> Vec<BandTopology> {
    build_all_bands_reporting(built, None)
}

/// [`build_all_bands`] that also drives a [`BuildProgress`] sink — one
/// `report` as each band finishes (they run under `rayon`, so the
/// `done` count is an [`AtomicU64`] and arrives out of ladder order,
/// which is fine for a bar). Byte-identical to [`build_all_bands`]: the
/// indexed `map`→`collect` still fixes output order; only an atomic
/// increment and an optional callback are added.
///
/// Band concurrency is capped by [`band_pass_concurrency`] to a memory
/// budget — each per-band pass allocates an `O(region cells)` labelling
/// column (see [`BAND_PASS_BYTES_PER_CELL`]), so on a national set
/// the ten bands through the full-width rayon pool need more RAM than a
/// 16 GB box has. When the cap is below the pool width the sweep runs in
/// a scoped pool of that size; a fixture-scale region is unaffected
/// (cap == pool width → the global pool, no change).
pub fn build_all_bands_reporting(
    built: &BuiltRegion,
    prog: Option<&dyn BuildProgress>,
) -> Vec<BandTopology> {
    use rayon::prelude::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    let total = BAND_LADDER_M.len() as u64;
    let region_cells = built.depth_min.len();
    // What the ambient rayon pool would give this ten-item sweep anyway:
    // one thread per band, capped by the pool's own size (honours
    // `RAYON_NUM_THREADS`). The memory cap only ever pulls `concurrency`
    // BELOW this.
    let pool_width = rayon::current_num_threads().min(BAND_LADDER_M.len()).max(1);
    let concurrency = band_pass_concurrency(region_cells, pool_width);
    let done = AtomicU64::new(0);
    if let Some(p) = prog {
        p.report(
            "band topology",
            0,
            total,
            Some(&format!(
                "{total} depth bands, {concurrency} at a time ({region_cells} cells/band)"
            )),
        );
    }

    // Fire the per-band progress `report` (out of ladder order under
    // rayon — the `done` count is an atomic and the bar tolerates it).
    let report_band = |bt: &Option<BandTopology>, i: usize| {
        if let Some(p) = prog {
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            let note = bt.as_ref().map(|b| {
                format!(
                    "band {} m: {} components, {} portals, {} shortcuts",
                    BAND_LADDER_M[i],
                    b.components.count,
                    b.portals.len(),
                    b.shortcuts.len()
                )
            });
            p.report("band topology", n, total, note.as_deref());
        }
    };

    // Indexed `map` → `collect`: ladder order is fixed by the index, not
    // by which thread finishes first, so the result is byte-identical
    // for any `concurrency`. Only the `done` counter and the `report`
    // call order vary, and neither feeds the output.
    //
    let sweep = || {
        (0..BAND_LADDER_M.len())
            .into_par_iter()
            .map(|i| {
                let bt = build_band_topology(built, i as u8);
                report_band(&bt, i);
                bt
            })
            .collect::<Vec<Option<BandTopology>>>()
    };

    let built_bands = if concurrency >= pool_width {
        // The memory budget did not force us below what the pool already
        // does — run straight on it, no private pool.
        sweep()
    } else {
        // A narrower pool than the ambient one. If it can't be built —
        // thread-spawn failure, most likely under the very memory
        // pressure that selected this branch — fall back to the ambient
        // pool rather than panicking across the pyo3 boundary after a
        // build that may already have run for minutes. That risks more
        // memory than intended, but a completed build beats an abrupt,
        // misclassified `PanicException`.
        match rayon::ThreadPoolBuilder::new()
            .num_threads(concurrency)
            .thread_name(|i| format!("mivnav-band-{i}"))
            .build()
        {
            Ok(pool) => pool.install(sweep),
            Err(_) => sweep(),
        }
    };

    built_bands.into_iter().flatten().collect()
}

/// [`build_region`] plus [`build_all_bands`] — everything that goes into
/// a `.mivnav`, still in memory.
///
/// `catzoc_mode` is the one build-time policy knob, for exactly the
/// reason [`build_region`]'s own docs give: it is a survey-confidence
/// policy for the whole artifact, not a property of any vessel (§6).
pub fn build_artifact(
    cells: &[Cell],
    region_extent: Extent,
    catzoc_mode: CatzocMode,
) -> RegionArtifact {
    build_artifact_reporting(cells, region_extent, catzoc_mode, None)
}

/// [`build_artifact`] that also drives a [`BuildProgress`] sink through
/// the refine passes and the ten-band topology sweep. The build output
/// is identical with or without the sink.
pub fn build_artifact_reporting(
    cells: &[Cell],
    region_extent: Extent,
    catzoc_mode: CatzocMode,
    prog: Option<&dyn BuildProgress>,
) -> RegionArtifact {
    let built = build_region_impl(cells, region_extent, catzoc_mode, true, prog);
    let bands = build_all_bands_reporting(&built, prog);
    let hazard_rings = region_hazard_rings(cells, catzoc_mode);
    let directional = build_directional_semantics(cells);
    RegionArtifact {
        built,
        bands,
        hazard_rings,
        directional,
    }
}

/// §12.4 — the region's HARD hazard rings, for
/// [`super::refine::refine_segment`] to route a demoted crossing
/// against. Built from [`constraints::build`] at the SAME vessel-neutral
/// params [`build_region`] uses (§6: the build never knows a boat's
/// draft/air-draft/margin), so this is a physical fact about the charts,
/// not a query.
///
/// Only [`constraints::ArtifactConstraints::hard`] — never-crossable
/// geometry — is taken. `UNSARE`/no-coverage grace (§9.3) is the fine
/// search's job, not this pre-store's; treating unknown water as blocking
/// here would make refinement decline exactly where a graced route
/// exists. Unioned flat with NO authority resolution
/// ([`constraints::build`]'s own documented behaviour) — the same
/// errs-toward-blocking direction [`build_region`]'s own docs accept, and
/// the safe one for a bound whose whole job is to never wave a route
/// through geometry a coarser chart blocks.
///
/// # SAFETY — depth-blind
///
/// `required_depth_m` is `0.0` here (§6), so a shoal that is a "wall" for
/// a deep-draft vessel but open water for a shallow one is **NOT** in
/// this set — it is not "hard". A caller that hands only these rings to
/// [`super::refine::refine_segment`] and splices the result can route a
/// deep vessel across a shoal. The refinement's own module docs spell
/// out the two ways a production caller must close that (band
/// non-navigable geometry alongside the hard rings, or a draft-aware
/// re-verification over decoded cells); this function is the hard half
/// only, and that is why nothing in this commit consumes it on a route
/// path yet.
pub fn region_hazard_rings(cells: &[Cell], catzoc_mode: CatzocMode) -> Vec<Vec<WorldXy>> {
    if cells.is_empty() {
        return Vec::new();
    }
    let params = ConstraintParams {
        required_depth_m: 0.0,
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        catzoc_mode,
        allow_restricted_entry: false,
        // Only `.hard` is read below.
        build_charted_depth: false,
    };
    let refs: Vec<&Cell> = cells.iter().collect();
    constraints::build(&refs, &params).hard
}

/// Write every section of `artifact` into an open [`ArtifactWriter`], in
/// the order a reader most naturally walks them: the spatial field first
/// (tile index, the three SoA columns, the stitch table), then the two
/// region-level stores, then each band's
/// `Components`/`Portals`/`Topology`/`Landmarks` quad.
///
/// Section ORDER is not load-bearing — a reader jumps by the section
/// table and never scans (see [`super::format`]'s own docs). This takes a
/// whole [`RegionArtifact`] with every band already built and resident;
/// [`build_and_publish_region_streaming`] writes the identical bytes one
/// band at a time so the finished bands are never all held waiting for
/// the write (~19 GB of them at national scale — see that function's
/// docs). Both drive [`write_region_sections`] and [`write_band_sections`],
/// so the two paths cannot drift.
pub fn write_artifact_body<W: Write + Seek>(
    w: &mut ArtifactWriter<W>,
    artifact: &RegionArtifact,
) -> io::Result<()> {
    let built = &artifact.built;
    // Every field of `RegionArtifact` is public and hand-constructible,
    // so a caller can assemble one whose bands do not match its region.
    // Writing it would produce a file that PARSES and then fails at
    // `load_band` with "components section is malformed" — a build-time
    // bug reported as a load-time corruption, in a different process on
    // a different day. Debug assertions rather than errors because
    // `build_artifact` cannot violate either one. (Found by code
    // review.) The streaming publisher does not need these: each band it
    // writes comes straight from `build_band_topology(&built, i)`, so
    // both invariants hold by construction there.
    debug_assert!(
        {
            let mut seen: Vec<u8> = artifact.bands.iter().map(|b| b.tag.band_index).collect();
            seen.sort_unstable();
            let n = seen.len();
            seen.dedup();
            seen.len() == n
        },
        "two bands share a band_index; only the first would ever be found"
    );
    debug_assert!(
        artifact
            .bands
            .iter()
            .all(|b| b.components.label.len() == built.depth_min.len()),
        "a band's labelling does not cover this region's cells"
    );
    write_region_sections(w, built, &artifact.hazard_rings, &artifact.directional)?;
    for band in &artifact.bands {
        write_band_sections(w, band)?;
    }
    Ok(())
}

/// The non-per-band half of a `.mivnav` body: the spatial field (tile
/// index, the three SoA columns, the boundary stitch) followed by the two
/// region-level stores (§12.4 hazard rings, §11 directional semantics).
/// Shared verbatim by [`write_artifact_body`] and
/// [`build_and_publish_region_streaming`] so a change here lands in both.
fn write_region_sections<W: Write + Seek>(
    w: &mut ArtifactWriter<W>,
    built: &BuiltRegion,
    hazard_rings: &[Vec<WorldXy>],
    directional: &DirectionalSemantics,
) -> io::Result<()> {
    w.write_section(SectionKind::TileIndex, &encode_tile_index(&built.tiles))?;
    w.write_section(SectionKind::DepthMin, &encode_u16_column(&built.depth_min))?;
    w.write_section(SectionKind::DepthMax, &encode_u16_column(&built.depth_max))?;
    w.write_section(SectionKind::Flags, &built.flags)?;
    w.write_section(SectionKind::BoundaryStitch, &encode_stitch(&built.stitch))?;
    // §12.4's pre-clipped hazard geometry. Written unconditionally (an
    // empty ring set is 4 bytes) so a reader can tell "built with the
    // section, no hard hazard" from "built before the section existed".
    w.write_section(SectionKind::HazardRings, &encode_hazard_rings(hazard_rings))?;
    // §11's directional / buoyage semantics. Written unconditionally
    // (an empty payload is 8 bytes) for the same reason `HazardRings`
    // is: so a reader can tell "built with the section, nothing
    // directional charted" from "built before the section existed".
    w.write_section(SectionKind::Semantics, &encode_semantics(directional))?;
    Ok(())
}

/// One band's four sections —
/// `Components`/`Portals`/`Topology`/`Landmarks`, each [`BandTag`]-
/// prefixed. Kept adjacent in the file on purpose: loading one band then
/// touches four neighbouring extents rather than four scattered ones,
/// which matters on an mmap over a Pi's SD card. Shared verbatim by
/// [`write_artifact_body`] and [`build_and_publish_region_streaming`].
fn write_band_sections<W: Write + Seek>(
    w: &mut ArtifactWriter<W>,
    band: &BandTopology,
) -> io::Result<()> {
    w.write_section(
        SectionKind::Components,
        &encode_components(band.tag, &band.components),
    )?;
    w.write_section(
        SectionKind::Portals,
        &encode_portals(band.tag, &band.portals),
    )?;
    w.write_section(
        SectionKind::Topology,
        &encode_shortcuts(band.tag, &band.shortcuts),
    )?;
    // §14's ALT table. Written unconditionally (an empty band's is 16
    // bytes) so a reader can tell "built with the section, no graph"
    // from "built before the section was filled" — same rule the
    // sections above and `HazardRings`/`Semantics` follow.
    w.write_section(
        SectionKind::Landmarks,
        &encode_landmarks(band.tag, &band.landmarks),
    )?;
    Ok(())
}

/// Publish `artifact` to `path` atomically, at this build's
/// [`ArtifactVersions::CURRENT`].
///
/// Thin by design: [`write_artifact_atomically`] already owns the part
/// that has to be right (temp file in the same directory, `sync_all`,
/// rename — so a rebuild never yanks pages out from under a reader that
/// has the old file mapped).
pub fn publish_artifact(
    path: &Path,
    chart_set: ChartSetIdentity,
    artifact: &RegionArtifact,
) -> io::Result<()> {
    write_artifact_atomically(path, chart_set, ArtifactVersions::CURRENT, |w| {
        write_artifact_body(w, artifact)
    })
}

/// The whole manual build trigger, in one call: build the region and
/// every band from `cells`, publish the `.mivnav` at `path`, and hand
/// back what was built so the caller can report on it (§20's "record per
/// run" — [`BuiltRegion::report`] is that summary, and it is a build-time
/// value no later [`load_region`] can recover; see the module docs).
pub fn build_and_publish_region(
    path: &Path,
    chart_set: ChartSetIdentity,
    cells: &[Cell],
    region_extent: Extent,
    catzoc_mode: CatzocMode,
) -> io::Result<RegionArtifact> {
    build_and_publish_region_reporting(path, chart_set, cells, region_extent, catzoc_mode, None)
}

/// [`build_and_publish_region`] that also drives a [`BuildProgress`]
/// sink — through the refine passes, the ten-band sweep, and one pair of
/// `report`s around the (single, non-incremental) file write. The
/// published bytes are identical with or without the sink.
pub fn build_and_publish_region_reporting(
    path: &Path,
    chart_set: ChartSetIdentity,
    cells: &[Cell],
    region_extent: Extent,
    catzoc_mode: CatzocMode,
    prog: Option<&dyn BuildProgress>,
) -> io::Result<RegionArtifact> {
    let artifact = build_artifact_reporting(cells, region_extent, catzoc_mode, prog);
    if let Some(p) = prog {
        p.report("writing artifact", 0, 1, Some("writing .mivnav to disk"));
    }
    publish_artifact(path, chart_set, &artifact)?;
    if let Some(p) = prog {
        p.report("writing artifact", 1, 1, None);
    }
    Ok(artifact)
}

/// What [`build_and_publish_region_streaming`] hands back in place of a
/// whole [`RegionArtifact`]: §20's [`BuildReport`] plus the per-band
/// totals a build trigger reports on (`crate::python`'s
/// `MivnavBuildReport`). Every band's full topology — which a
/// `RegionArtifact` would keep all ten of, resident, until the file was
/// written — is exactly what the streaming publish exists not to
/// accumulate.
#[derive(Debug, Clone, Default)]
pub struct StreamedArtifactSummary {
    /// The region phase's report — identical to the `report` field of a
    /// [`RegionArtifact::built`] from the non-streaming path.
    pub report: BuildReport,
    /// Bands written — rungs of [`BAND_LADDER_M`] that produced topology.
    pub bands: u32,
    /// Portals summed over every band written.
    pub portals: u64,
    /// Chain-contracted shortcuts summed over every band written.
    pub shortcuts: u64,
}

/// [`build_and_publish_region_reporting`], but it never accumulates the
/// finished bands: each is written to the artifact and dropped before the
/// next is built.
///
/// It builds the region, opens the artifact writer, writes the
/// spatial-field and region-level sections, then for each rung of
/// [`BAND_LADDER_M`] builds that one band, writes its four sections, and
/// drops it. So the only band data live at once is the ONE band currently
/// being built — where [`build_artifact_reporting`] +
/// [`write_artifact_body`] hold all ten [`BandTopology`] resident from
/// the end of the sweep until the file is written.
///
/// What that buys, measured on the FNC-DE national set
/// (`MIVNAV_NEXT_TASKS.md`, ~4.3×10⁸ cells, ~1.9 GB of labelling + portals
/// per band): the non-streaming path's true demand at write time is
/// `BuiltRegion` (~2 GB) + ten bands (~19 GB); on a 16 GB box that meant
/// the finished bands were pushed to swap as the later ones built and
/// then paged back in — ~35 GB of reads, 5.8×10⁵ major faults — to write
/// the file. Streaming holds `BuiltRegion` + one band, writes each band
/// straight out, and the run does NOT touch swap: 6.6×10³ major faults,
/// `Swaps: 0`, ~30 % less wall clock. Peak RSS drops only modestly
/// (~12.0 → ~10.7 GB) because a single band's `label_band` transient over
/// a 4.3×10⁸-cell region is now the binding term — shrinking THAT is a
/// `topology.rs` change (the shared per-tile scratch this module's own
/// docs flag as deferred), not this driver's.
///
/// The cost is band parallelism: bands are built serially here, where
/// [`build_all_bands_reporting`] fans them across `rayon`. That is the
/// intended trade at national scale — [`band_pass_concurrency`] already
/// forces that sweep to one band at a time once the region is large
/// enough for the memory to matter, so on the machine that needs
/// streaming there is no parallelism left to lose. A fixture-scale build
/// with RAM to spare can keep calling
/// [`build_and_publish_region_reporting`].
///
/// The published bytes are IDENTICAL to
/// [`build_and_publish_region_reporting`]'s: same sections, same order,
/// same encoders, through the shared [`write_region_sections`] /
/// [`write_band_sections`]. `mivnav_persist_de6ostim.rs` pins that on the
/// real cell.
pub fn build_and_publish_region_streaming(
    path: &Path,
    chart_set: ChartSetIdentity,
    cells: &[Cell],
    region_extent: Extent,
    catzoc_mode: CatzocMode,
    prog: Option<&dyn BuildProgress>,
) -> io::Result<StreamedArtifactSummary> {
    let built = build_region_impl(cells, region_extent, catzoc_mode, true, prog);
    let hazard_rings = region_hazard_rings(cells, catzoc_mode);
    let directional = build_directional_semantics(cells);
    publish_region_streaming(path, chart_set, &built, &hazard_rings, &directional, prog)
}

/// The band-pass-and-write half of [`build_and_publish_region_streaming`],
/// over a [`BuiltRegion`] the caller has already built (and its two
/// region-level stores — [`region_hazard_rings`] and
/// [`build_directional_semantics`]).
///
/// Splitting the region build from the streamed publish is the seam a
/// future incremental rebuild wants (§19's five independent version
/// numbers: a `band_ladder_version` bump invalidates only what this
/// function writes, not `built`), and it lets
/// `examples/mivnav_build_real.rs` print its region-phase profile without
/// building the region twice.
///
/// Builds one rung of [`BAND_LADDER_M`] at a time, writes its four
/// sections, drops it, next — so the finished bands are never held
/// resident waiting for the write (see
/// [`build_and_publish_region_streaming`] for the measured effect).
/// Output bytes are identical to [`write_artifact_body`] over the
/// equivalent [`RegionArtifact`].
pub fn publish_region_streaming(
    path: &Path,
    chart_set: ChartSetIdentity,
    built: &BuiltRegion,
    hazard_rings: &[Vec<WorldXy>],
    directional: &DirectionalSemantics,
    prog: Option<&dyn BuildProgress>,
) -> io::Result<StreamedArtifactSummary> {
    let total = BAND_LADDER_M.len() as u64;
    if let Some(p) = prog {
        p.report(
            "band topology",
            0,
            total,
            Some(&format!(
                "{total} depth bands, one at a time streamed to disk ({} cells/band)",
                built.depth_min.len()
            )),
        );
    }

    let mut bands = 0u32;
    let mut portals = 0u64;
    let mut shortcuts = 0u64;
    write_artifact_atomically(path, chart_set, ArtifactVersions::CURRENT, |w| {
        write_region_sections(w, built, hazard_rings, directional)?;
        for band_index in 0..BAND_LADDER_M.len() as u8 {
            // `0..BAND_LADDER_M.len()` never runs off the ladder, so this
            // is `Some` every iteration — the `continue` only mirrors
            // `build_all_bands_reporting`'s own `.flatten()`.
            let Some(band) = build_band_topology(built, band_index) else {
                continue;
            };
            write_band_sections(w, &band)?;
            bands += 1;
            portals += band.portals.len() as u64;
            shortcuts += band.shortcuts.len() as u64;
            if let Some(p) = prog {
                // The SAME note text `build_all_bands_reporting` emits, so
                // a streamed bake's log is indistinguishable from the
                // in-memory one (`test_routing_mivnav.py` reads these).
                p.report(
                    "band topology",
                    u64::from(band_index) + 1,
                    total,
                    Some(&format!(
                        "band {} m: {} components, {} portals, {} shortcuts",
                        BAND_LADDER_M[band_index as usize],
                        band.components.count,
                        band.portals.len(),
                        band.shortcuts.len()
                    )),
                );
            }
            // `band` is dropped here — its `O(region cells)` labelling is
            // freed before the next `build_band_topology` allocates the
            // next one. That is the whole point of this function.
        }
        if let Some(p) = prog {
            p.report("writing artifact", 0, 1, Some("writing .mivnav to disk"));
        }
        Ok(())
    })?;
    if let Some(p) = prog {
        p.report("writing artifact", 1, 1, None);
    }

    // Every ladder rung produced a band — the non-streaming path's
    // `RegionArtifact` would carry `BAND_LADDER_M.len()` of them, and the
    // backend's `MivnavBuildReport` asserts exactly that. A shortfall
    // means `build_band_topology` started refusing an in-range index.
    debug_assert_eq!(bands as usize, BAND_LADDER_M.len());

    Ok(StreamedArtifactSummary {
        report: built.report,
        bands,
        portals,
        shortcuts,
    })
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

fn missing(kind: SectionKind) -> FormatError {
    FormatError::Format(format!("artifact has no {kind:?} section"))
}

fn undecodable(what: &str) -> FormatError {
    FormatError::Format(format!("{what} section is malformed"))
}

/// Total cells in `tiles`, or `None` on an overflow no real region can
/// reach but a corrupted tile index can claim.
fn total_cells(tiles: &[TileEntry]) -> Option<usize> {
    tiles
        .iter()
        .try_fold(0usize, |acc, t| acc.checked_add(t.cell_count()))
}

/// Check that `tiles`' own `payload_offset`s are what
/// [`build_region`] writes: an in-order, gap-free, overlap-free
/// partition of the SoA columns, tile `i` starting exactly where tile
/// `i-1` ended. Returns the total cell count on success.
///
/// # Why a whole-partition check and not a per-tile range check
///
/// `payload_offset` comes straight off the file
/// ([`super::field::TileEntry::parse`] reads it as a bare `u64` and
/// validates nothing), and every consumer of a [`BuiltRegion`] treats it
/// as trustworthy: [`super::bands::navigable_at`] indexes
/// `flags[global]`/`depth_max[global]` DIRECTLY, not with `get`, where
/// `global = payload_offset + tile.index(col, row)`
/// ([`super::bands::global_index`]). So an offset past the columns is an
/// out-of-bounds panic inside `label_band`, and on this crate's actual
/// deployment that is the boat's server dying rather than an error
/// return.
///
/// `topology.rs` says as much in its own words — "a mismatched SoA
/// column length is a caller bug, not something a corrupted FILE could
/// ever reach (`build_region` guarantees this itself)". That was true
/// while `build_region` was the only producer of a `BuiltRegion`.
/// [`load_region`] is a second producer, from untrusted bytes, so it has
/// to re-establish the invariant that comment relies on rather than
/// inherit it. (Found by code review of this very commit.)
///
/// Checking the exact partition rather than merely "each tile fits"
/// costs the same and catches strictly more: two tiles ALIASING the same
/// payload range is in bounds, never panics, and silently reports one
/// tile's depths for another's water — a wrong answer, which is worse
/// than a refused file.
fn check_payload_partition(tiles: &[TileEntry]) -> Result<usize, FormatError> {
    let mut at = 0usize;
    for (i, t) in tiles.iter().enumerate() {
        if t.payload_offset != at as u64 {
            return Err(FormatError::Format(format!(
                "tile index is not a contiguous payload partition: tile {i} claims offset {}, \
                 the tiles before it end at {at}",
                t.payload_offset
            )));
        }
        at = at
            .checked_add(t.cell_count())
            .ok_or_else(|| FormatError::Format("tile index cell count overflows".to_string()))?;
    }
    Ok(at)
}

/// Rebuild the spatial field — everything [`build_region`] produces bar
/// its [`super::build::BuildReport`] (see the module docs) — out of a
/// `.mivnav`.
///
/// Every cross-section length is checked against the tile index rather
/// than trusted: the three SoA columns are indexed by
/// `tile.payload_offset + tile.index(col, row)`, so a column that is not
/// exactly as long as the tiles say would not fail loudly, it would
/// silently read a neighbouring tile's depths for every cell past the
/// discrepancy — a route through water that was never surveyed where the
/// file says it was. That check is also what BOUNDS the tile index's own
/// claimed cell count to something the file could really hold, which is
/// the precondition [`load_band`] relies on before handing that number to
/// [`decode_components`].
pub fn load_region(reader: &ArtifactReader<'_>) -> Result<BuiltRegion, FormatError> {
    load_region_impl(reader, true)
}

/// [`load_region`] for the QUERY side: the tile index and boundary
/// stitch, with every length check [`load_region`] makes, but the three
/// per-cell SoA columns (`depth_min`, `depth_max`, `flags`) left EMPTY.
/// Nothing a route query runs reads them — topology search, snapping,
/// coarse polylines and refinement all work off the tile lattice and the
/// band's portals — and decoding them cost ~5 bytes per region cell
/// (~4.8 GB on the national DK artifact). Pair with
/// [`load_band_for_query`], never [`load_band`] (which cross-checks the
/// columns).
pub fn load_region_lattice(reader: &ArtifactReader<'_>) -> Result<BuiltRegion, FormatError> {
    load_region_impl(reader, false)
}

fn load_region_impl(
    reader: &ArtifactReader<'_>,
    with_columns: bool,
) -> Result<BuiltRegion, FormatError> {
    let tiles = decode_tile_index(
        reader
            .find_section(SectionKind::TileIndex)
            .ok_or_else(|| missing(SectionKind::TileIndex))?,
    )
    .ok_or_else(|| undecodable("tile index"))?;
    // Both the total AND the per-tile partition — see
    // `check_payload_partition` for why the second is not optional.
    let cells = check_payload_partition(&tiles)?;

    let column = |kind: SectionKind, name: &str| -> Result<Vec<u16>, FormatError> {
        let bytes = reader.find_section(kind).ok_or_else(|| missing(kind))?;
        if !with_columns {
            // Same length check, no decode.
            return if bytes.len() as u64 == cells as u64 * 2 {
                Ok(Vec::new())
            } else {
                Err(FormatError::Format(format!(
                    "{name} column is {} bytes, {} expected for {} tiles",
                    bytes.len(),
                    cells.saturating_mul(2),
                    tiles.len()
                )))
            };
        }
        decode_u16_column(bytes, cells).ok_or_else(|| {
            FormatError::Format(format!(
                "{name} column is {} bytes, {} expected for {} tiles",
                bytes.len(),
                cells.saturating_mul(2),
                tiles.len()
            ))
        })
    };
    let depth_min = column(SectionKind::DepthMin, "depth_min")?;
    let depth_max = column(SectionKind::DepthMax, "depth_max")?;

    let flags = reader
        .find_section(SectionKind::Flags)
        .ok_or_else(|| missing(SectionKind::Flags))?;
    if flags.len() != cells {
        return Err(FormatError::Format(format!(
            "flags column is {} bytes, {cells} expected for {} tiles",
            flags.len(),
            tiles.len()
        )));
    }

    let stitch = decode_stitch(
        reader
            .find_section(SectionKind::BoundaryStitch)
            .ok_or_else(|| missing(SectionKind::BoundaryStitch))?,
    )
    .ok_or_else(|| undecodable("boundary stitch"))?;

    Ok(BuiltRegion {
        tiles,
        depth_min,
        depth_max,
        flags: if with_columns {
            flags.to_vec()
        } else {
            Vec::new()
        },
        stitch,
        report: Default::default(),
    })
}

/// Load one band's [`BandTopology`] out of a `.mivnav`, for a region
/// already loaded by [`load_region`].
///
/// `built` is not decoration: it supplies the cell count that bounds
/// [`decode_components`]' own allocation and cross-checks the labelling
/// against this file's tile index. That count is taken from the tile
/// index AND checked against `built.flags.len()` — a real, materialised
/// buffer — so a caller who hand-assembled a `BuiltRegion` with a
/// mismatched column cannot turn an untrusted `u16` product into an
/// allocation.
///
/// # The band a section claims, versus the band this build means
///
/// All three sections must carry the SAME `band_dm` this build's
/// [`BAND_LADDER_M`] gives for `band_index`, and a mismatch is an error
/// naming both values. §19 lets a stale artifact OPEN so its staleness
/// can be diagnosed — which means code here can genuinely be handed a
/// labelling built at 3.0 m while asking for what is now rung 4 at some
/// other depth. Reading it anyway would silently answer a draft question
/// against the wrong depth threshold, which is the one class of mistake
/// an acceleration structure over navigational data must never make.
///
/// [`BAND_LADDER_M`]: super::field::BAND_LADDER_M
pub fn load_band(
    reader: &ArtifactReader<'_>,
    built: &BuiltRegion,
    band_index: u8,
) -> Result<BandTopology, FormatError> {
    load_band_impl(reader, built, band_index, true)
}

/// [`load_band`] for the QUERY side, over a [`load_region_lattice`]
/// region: identical band-tag and structural validation, but the
/// components section is checked run by run without expanding its
/// per-cell `label` (see [`decode_components_count`]) — the returned
/// [`Components`] has the real `count` and an empty `label`.
pub fn load_band_for_query(
    reader: &ArtifactReader<'_>,
    built: &BuiltRegion,
    band_index: u8,
) -> Result<BandTopology, FormatError> {
    load_band_impl(reader, built, band_index, false)
}

fn load_band_impl(
    reader: &ArtifactReader<'_>,
    built: &BuiltRegion,
    band_index: u8,
    expand_labels: bool,
) -> Result<BandTopology, FormatError> {
    let expect = band_tag(band_index).ok_or_else(|| {
        FormatError::Format(format!(
            "band {band_index} is outside this build's {}-rung ladder",
            BAND_LADDER_M.len()
        ))
    })?;

    // `band_sections` yields the already-parsed tag alongside the
    // payload, so this does NOT re-parse it: an earlier draft called
    // `find_band_section` and then `BandTag::parse` again, whose failure
    // arm was unreachable by construction (a section only reaches
    // `find_band_section` if its tag already parsed) — dead code that
    // read like a real check. Found by code review.
    let section = |kind: SectionKind| -> Result<&[u8], FormatError> {
        let (tag, bytes) = reader
            .band_sections(kind)
            .find(|(t, _)| t.band_index == band_index)
            .ok_or_else(|| {
                FormatError::Format(format!(
                    "artifact has no {kind:?} section for band {band_index}"
                ))
            })?;
        if tag.band_dm != expect.band_dm {
            return Err(FormatError::Format(format!(
                "{kind:?} section for band {band_index} was built at {} dm, this build's ladder \
                 puts that band at {} dm (a band_ladder_version mismatch)",
                tag.band_dm, expect.band_dm
            )));
        }
        Ok(bytes)
    };

    let cells = total_cells(&built.tiles)
        .ok_or_else(|| undecodable("tile index (cell count overflows)"))?;
    let components = if expand_labels {
        // Bounds the allocation below by a real, materialised buffer.
        if cells != built.flags.len() {
            return Err(FormatError::Format(format!(
                "region's tile index claims {cells} cells but its flags column holds {}",
                built.flags.len()
            )));
        }
        decode_components(section(SectionKind::Components)?, cells)
    } else {
        // Allocates nothing per cell, so the tile index's own (already
        // partition-checked) count needs no materialised cross-check.
        decode_components_count(section(SectionKind::Components)?, cells)
    }
    .ok_or_else(|| undecodable("components"))?;
    let portals =
        decode_portals(section(SectionKind::Portals)?).ok_or_else(|| undecodable("portals"))?;
    let shortcuts =
        decode_shortcuts(section(SectionKind::Topology)?).ok_or_else(|| undecodable("topology"))?;

    // §14's ALT table. ABSENT is not an error — an artifact built before
    // this section was filled just carries no landmarks, and the caller
    // falls back to the straight-line lower bound (same compat rule as
    // `load_hazard_rings`/`load_semantics`). A PRESENT section is still
    // held to the same band-tag cross-check and structural decode as the
    // three above.
    let landmarks = match reader
        .band_sections(SectionKind::Landmarks)
        .find(|(t, _)| t.band_index == band_index)
    {
        Some((tag, bytes)) => {
            if tag.band_dm != expect.band_dm {
                return Err(FormatError::Format(format!(
                    "Landmarks section for band {band_index} was built at {} dm, this build's \
                     ladder puts that band at {} dm (a band_ladder_version mismatch)",
                    tag.band_dm, expect.band_dm
                )));
            }
            decode_landmarks(bytes).ok_or_else(|| undecodable("landmarks"))?
        }
        None => BandLandmarks::default(),
    };

    Ok(BandTopology {
        tag: expect,
        components,
        portals,
        shortcuts,
        landmarks,
    })
}

/// [`load_region`] plus every band the file carries for THIS build's
/// ladder — the mirror of [`build_artifact`].
///
/// A route request wants [`load_region`] + ONE [`load_band`] at
/// [`select_band_index`]; this decodes all ten, which is what a
/// round-trip check or a diagnostic dump wants and what a route request
/// emphatically does not.
///
/// Size it before reaching for it: each band's labelling expands to one
/// `u32` per cell, so all ten are resident at **40 bytes per cell**, on
/// top of the region's own 5 (`u16` + `u16` + `u8`). On the DE6OSTIM
/// test region that is 136 MB against a 17 MB file; on a real region
/// §5.3 sizes in gigabytes it is not something to do on a whim.
pub fn load_artifact(reader: &ArtifactReader<'_>) -> Result<RegionArtifact, FormatError> {
    let built = load_region(reader)?;
    let mut bands = Vec::with_capacity(BAND_LADDER_M.len());
    for band_index in 0..BAND_LADDER_M.len() as u8 {
        bands.push(load_band(reader, &built, band_index)?);
    }
    let hazard_rings = load_hazard_rings(reader)?;
    let directional = load_semantics(reader)?;
    Ok(RegionArtifact {
        built,
        bands,
        hazard_rings,
        directional,
    })
}

/// §12.4's pre-clipped hazard rings out of a `.mivnav`
/// ([`SectionKind::HazardRings`]).
///
/// `Ok(vec![])` when the section is ABSENT — an artifact built before the
/// section existed. That is not corruption and not staleness: the caller
/// re-derives the rings from `routing::artifact::constraints::build` the
/// same way the fine search already does. `Err` only on a structurally
/// impossible payload (short header, a ring running past the section
/// end).
///
/// [`SectionKind::HazardRings`]: super::format::SectionKind::HazardRings
pub fn load_hazard_rings(reader: &ArtifactReader<'_>) -> Result<Vec<Vec<WorldXy>>, FormatError> {
    match reader.find_section(SectionKind::HazardRings) {
        None => Ok(Vec::new()),
        Some(bytes) => decode_hazard_rings(bytes).ok_or_else(|| undecodable("hazard rings")),
    }
}

// ---------------------------------------------------------------------------
// §12.4 hazard-ring section payload
// ---------------------------------------------------------------------------

/// Serialize a signed ring set as the [`SectionKind::HazardRings`]
/// payload.
///
/// ```text
/// off  len  field
///   0    4  ring_count  u32
///  then ring_count times:
///   0    4  point_count u32
///   4  8*n  points: i32 x LE, i32 y LE  (World coordinates)
/// ```
///
/// Ring winding is preserved verbatim — [`super::refine`] reads the set
/// with `routing::visibility::visible`, whose nonzero-winding test needs
/// the original signs.
///
/// [`SectionKind::HazardRings`]: super::format::SectionKind::HazardRings
pub fn encode_hazard_rings(rings: &[Vec<WorldXy>]) -> Vec<u8> {
    let points: usize = rings.iter().map(|r| r.len()).sum();
    let mut out = Vec::with_capacity(4 + rings.len() * 4 + points * 8);
    out.extend_from_slice(&(rings.len() as u32).to_le_bytes());
    for ring in rings {
        out.extend_from_slice(&(ring.len() as u32).to_le_bytes());
        for p in ring {
            out.extend_from_slice(&p.x.to_le_bytes());
            out.extend_from_slice(&p.y.to_le_bytes());
        }
    }
    out
}

/// Parse a [`SectionKind::HazardRings`] payload. `None` on a short
/// header, a `point_count` the remaining bytes cannot hold, or trailing
/// bytes after the last ring (a writer/reader disagreement, same
/// exact-length discipline [`decode_u16_column`] keeps).
///
/// [`SectionKind::HazardRings`]: super::format::SectionKind::HazardRings
pub fn decode_hazard_rings(bytes: &[u8]) -> Option<Vec<Vec<WorldXy>>> {
    let ring_count = u32::from_le_bytes(bytes.get(..4)?.try_into().unwrap()) as usize;
    let mut at = 4usize;
    let mut rings = Vec::with_capacity(ring_count.min(4096));
    for _ in 0..ring_count {
        let point_count = u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().unwrap()) as usize;
        at += 4;
        let span = point_count.checked_mul(8)?;
        let end = at.checked_add(span)?;
        let raw = bytes.get(at..end)?;
        let ring: Vec<WorldXy> = raw
            .chunks_exact(8)
            .map(|c| {
                WorldXy::new(
                    i32::from_le_bytes(c[0..4].try_into().unwrap()),
                    i32::from_le_bytes(c[4..8].try_into().unwrap()),
                )
            })
            .collect();
        rings.push(ring);
        at = end;
    }
    if at != bytes.len() {
        return None;
    }
    Some(rings)
}

// ---------------------------------------------------------------------------
// §11 directional / buoyage semantics section payload
// ---------------------------------------------------------------------------

/// §11's directional / buoyage semantics out of a `.mivnav`
/// ([`SectionKind::Semantics`]).
///
/// `Ok(DirectionalSemantics::default())` (empty) when the section is
/// ABSENT — an artifact built before it was written. Same posture as
/// [`load_hazard_rings`]: not corruption, not staleness, the caller
/// re-derives via [`build_directional_semantics`]. `Err` only on a
/// structurally impossible payload.
///
/// [`SectionKind::Semantics`]: super::format::SectionKind::Semantics
pub fn load_semantics(reader: &ArtifactReader<'_>) -> Result<DirectionalSemantics, FormatError> {
    match reader.find_section(SectionKind::Semantics) {
        None => Ok(DirectionalSemantics::default()),
        Some(bytes) => decode_semantics(bytes).ok_or_else(|| undecodable("directional semantics")),
    }
}

/// Serialize [`DirectionalSemantics`] as the [`SectionKind::Semantics`]
/// payload.
///
/// ```text
/// off  len  field
///   0    4  flow_zone_count  u32
///  then flow_zone_count times:
///   0    8  orient_deg       f64 LE (IEEE-754 bits)
///   8    4  ring_count       u32
///  then ring_count times:
///   0    4  point_count      u32
///   4  8*n  points: i32 x LE, i32 y LE   (World coordinates)
///  then:
///   0    4  mark_count       u32
///  then mark_count times:
///   0    4  x                i32 LE
///   4    4  y                i32 LE
///   8    1  side             u8  (0 = Port, 1 = Starboard)
/// ```
///
/// [`SectionKind::Semantics`]: super::format::SectionKind::Semantics
pub fn encode_semantics(sem: &DirectionalSemantics) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(sem.flow_zones.len() as u32).to_le_bytes());
    for zone in &sem.flow_zones {
        out.extend_from_slice(&zone.orient_deg.to_le_bytes());
        out.extend_from_slice(&(zone.rings.len() as u32).to_le_bytes());
        for ring in &zone.rings {
            out.extend_from_slice(&(ring.len() as u32).to_le_bytes());
            for p in ring {
                out.extend_from_slice(&p.x.to_le_bytes());
                out.extend_from_slice(&p.y.to_le_bytes());
            }
        }
    }
    out.extend_from_slice(&(sem.marks.len() as u32).to_le_bytes());
    for m in &sem.marks {
        out.extend_from_slice(&m.pos.x.to_le_bytes());
        out.extend_from_slice(&m.pos.y.to_le_bytes());
        out.push(match m.side {
            LateralSide::Port => 0,
            LateralSide::Starboard => 1,
        });
    }
    out
}

/// Parse a [`SectionKind::Semantics`] payload. `None` on a short header,
/// a count the remaining bytes cannot hold, an unknown `side` byte, or
/// trailing bytes after the last mark (a writer/reader disagreement —
/// the same exact-length discipline [`decode_hazard_rings`] keeps).
///
/// [`SectionKind::Semantics`]: super::format::SectionKind::Semantics
pub fn decode_semantics(bytes: &[u8]) -> Option<DirectionalSemantics> {
    let u32_at = |b: &[u8], at: usize| -> Option<usize> {
        Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().unwrap()) as usize)
    };
    let i32_at = |b: &[u8], at: usize| -> Option<i32> {
        Some(i32::from_le_bytes(b.get(at..at + 4)?.try_into().unwrap()))
    };

    let zone_count = u32_at(bytes, 0)?;
    let mut at = 4usize;
    let mut flow_zones = Vec::with_capacity(zone_count.min(4096));
    for _ in 0..zone_count {
        let orient_deg = f64::from_le_bytes(bytes.get(at..at + 8)?.try_into().unwrap());
        at += 8;
        let ring_count = u32_at(bytes, at)?;
        at += 4;
        let mut rings = Vec::with_capacity(ring_count.min(4096));
        for _ in 0..ring_count {
            let point_count = u32_at(bytes, at)?;
            at += 4;
            let span = point_count.checked_mul(8)?;
            let end = at.checked_add(span)?;
            let raw = bytes.get(at..end)?;
            rings.push(
                raw.chunks_exact(8)
                    .map(|c| {
                        WorldXy::new(
                            i32::from_le_bytes(c[0..4].try_into().unwrap()),
                            i32::from_le_bytes(c[4..8].try_into().unwrap()),
                        )
                    })
                    .collect(),
            );
            at = end;
        }
        flow_zones.push(FlowZone { rings, orient_deg });
    }

    let mark_count = u32_at(bytes, at)?;
    at += 4;
    let mut marks = Vec::with_capacity(mark_count.min(1 << 16));
    for _ in 0..mark_count {
        let x = i32_at(bytes, at)?;
        let y = i32_at(bytes, at + 4)?;
        let side = match bytes.get(at + 8)? {
            0 => LateralSide::Port,
            1 => LateralSide::Starboard,
            _ => return None,
        };
        marks.push(DirectionalMark {
            pos: WorldXy::new(x, y),
            side,
        });
        at += 9;
    }

    if at != bytes.len() {
        return None;
    }
    Some(DirectionalSemantics { flow_zones, marks })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::mivnav::query::select_band;
    use crate::mivnav::topology::NO_COMPONENT;
    use crate::model::{AttrValue, CellMeta, Feature, Geometry, Polygon};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    const LAT: f64 = 54.0;
    const LON: f64 = 11.0;

    /// Temporary directory that cleans up on drop, same helper shape as
    /// `format.rs`'s own tests.
    struct TestDir(PathBuf);
    impl TestDir {
        fn new(tag: &str) -> TestDir {
            let dir = std::env::temp_dir().join(format!(
                "chartcore-mivnav-persist-{tag}-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TestDir(dir)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn square(lat: f64, lon: f64, half_side_m: f64) -> Vec<crate::coords::WorldXy> {
        let dlat = half_side_m / 111_320.0;
        let dlon = half_side_m / (111_320.0 * lat.to_radians().cos());
        vec![
            lat_lon_to_world(lat - dlat, lon - dlon),
            lat_lon_to_world(lat - dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon - dlon),
        ]
    }

    fn area(class: &str, lat: f64, lon: f64, half: f64, attrs: &[(&str, AttrValue)]) -> Feature {
        let mut map = BTreeMap::new();
        for (k, v) in attrs {
            map.insert((*k).to_string(), v.clone());
        }
        Feature::new(
            1,
            class.into(),
            map,
            Some(Geometry::Areas(vec![Polygon {
                outer: square(lat, lon, half),
                holes: vec![],
            }])),
        )
    }

    /// A small region with real coverage, a real depth range spanning
    /// several ladder rungs, and a real obstruction — so the bands differ
    /// from each other rather than all being the same labelling.
    fn sample_cells() -> Vec<Cell> {
        let features = vec![
            area("M_COVR", LAT, LON, 400.0, &[("CATCOV", AttrValue::Int(1))]),
            area(
                "DEPARE",
                LAT,
                LON,
                350.0,
                &[
                    ("drval1", AttrValue::Float(4.0)),
                    ("drval2", AttrValue::Float(9.0)),
                ],
            ),
            area("LNDARE", LAT, LON, 60.0, &[]),
        ];
        let mut extent = Extent::invalid();
        for f in &features {
            extent.extend(&f.extent);
        }
        vec![Cell {
            meta: CellMeta {
                compilation_scale: 4_000,
                ..CellMeta::default()
            },
            features,
            extent,
        }]
    }

    fn sample_extent() -> Extent {
        Extent::new(
            lat_lon_to_world(LAT, LON - 0.005).x,
            lat_lon_to_world(LAT, LON + 0.005).x,
            lat_lon_to_world(LAT + 0.005, LON).y,
            lat_lon_to_world(LAT - 0.005, LON).y,
        )
    }

    fn identity() -> ChartSetIdentity {
        ChartSetIdentity::new("persist-test", 7)
    }

    /// The sample artifact, built ONCE for the whole module.
    ///
    /// [`build_artifact`] is `O(bands × region size)` by construction —
    /// that is this module's whole point, argued in its docs — which
    /// makes it far too expensive to run per test in a debug build
    /// (measured: ~12.5 s each, so five tests were spending a minute
    /// rebuilding identical bytes). Same `OnceLock` shape the real-chart
    /// integration tests use for exactly this reason. Nothing here
    /// mutates it, so sharing is safe as well as fast.
    fn artifact() -> &'static RegionArtifact {
        static A: std::sync::OnceLock<RegionArtifact> = std::sync::OnceLock::new();
        A.get_or_init(|| build_artifact(&sample_cells(), sample_extent(), CatzocMode::Off))
    }

    #[test]
    fn band_tags_cover_the_whole_ladder_and_nothing_past_it() {
        for (i, &band_m) in BAND_LADDER_M.iter().enumerate() {
            let tag = band_tag(i as u8).expect("every ladder rung has a tag");
            assert_eq!(tag.band_index, i as u8);
            assert_eq!(tag.band_dm, band_to_dm(band_m));
        }
        assert_eq!(band_tag(BAND_LADDER_M.len() as u8), None);
        assert_eq!(band_tag(u8::MAX), None);
        // Distinct rungs must never collide on the decimetre value, or
        // `load_band`'s own cross-check could accept a section built for
        // a different band.
        let mut dms: Vec<u16> = (0..BAND_LADDER_M.len() as u8)
            .map(|i| band_tag(i).unwrap().band_dm)
            .collect();
        dms.sort_unstable();
        dms.dedup();
        assert_eq!(dms.len(), BAND_LADDER_M.len());
    }

    #[test]
    fn band_pass_concurrency_caps_only_a_huge_region_and_never_leaves_its_bounds() {
        // A tiny region: 320 KB per per-band pass, so the memory budget
        // is never the limit whatever the pool width — the caller stays
        // on the global pool, exactly as before. This is the path every
        // fixture-scale test and a single-small-set Pi bake take.
        for width in [1_usize, 3, 8, 10, 16] {
            assert_eq!(band_pass_concurrency(10_000, width), width.max(1));
            // No `/proc/meminfo` (or a huge region) still never exceeds
            // the pool width or drops below 1.
            assert_eq!(band_pass_concurrency(0, width), width.max(1));
            let capped = band_pass_concurrency(usize::MAX / 4, width);
            assert!((1..=width.max(1)).contains(&capped));
        }

        // A region whose ONE per-band pass dwarfs any plausible budget:
        // with a real budget in hand it serialises to a single band.
        if mem_available_bytes().is_some() {
            let huge = (usize::MAX / BAND_PASS_BYTES_PER_CELL as usize) - 1;
            assert_eq!(band_pass_concurrency(huge, 16), 1);
        }

        // Monotone: a bigger region never gets MORE concurrency.
        assert!(band_pass_concurrency(usize::MAX / 4, 16) <= band_pass_concurrency(10_000, 16));
    }

    #[test]
    fn mem_available_bytes_parses_this_linux_box_or_is_none_elsewhere() {
        // On the Linux CI/dev box /proc/meminfo exists and MemAvailable is
        // a positive, sane figure (more than a megabyte). Off Linux the
        // helper returns None and callers keep the ambient pool width —
        // nothing to assert there.
        if let Some(b) = mem_available_bytes() {
            assert!(b > 1 << 20, "MemAvailable {b} implausibly small");
        }
    }

    #[test]
    fn select_band_index_agrees_with_select_band() {
        // The whole point of having two functions rather than one is that
        // they cannot disagree. Every rung, every midpoint between rungs,
        // and both out-of-range directions including the bad-input ones
        // `select_band`'s own docs single out.
        let mut probes = vec![f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -5.0, 0.0, 100.0];
        for (i, &b) in BAND_LADDER_M.iter().enumerate() {
            probes.push(b);
            probes.push(b - 0.01);
            if let Some(&next) = BAND_LADDER_M.get(i + 1) {
                probes.push((b + next) / 2.0);
            }
        }
        for p in probes {
            let idx = select_band_index(p);
            assert_eq!(
                BAND_LADDER_M[idx as usize],
                select_band(p),
                "select_band_index({p}) = {idx} disagrees with select_band"
            );
        }
    }

    #[test]
    fn hazard_rings_round_trip_through_their_section_payload() {
        let a = WorldXy::new(10, 20);
        let b = WorldXy::new(-30, 40);
        let c = WorldXy::new(i32::MIN, i32::MAX);
        let rings = vec![vec![a, b, c, WorldXy::new(0, 0)], vec![b, c]];
        let bytes = encode_hazard_rings(&rings);
        assert_eq!(decode_hazard_rings(&bytes), Some(rings));

        // Empty set: a valid, distinct-from-absent 4-byte payload.
        assert_eq!(
            decode_hazard_rings(&encode_hazard_rings(&[])),
            Some(Vec::new())
        );

        // Structurally impossible payloads are refused, never panic.
        assert_eq!(decode_hazard_rings(&[]), None);
        assert_eq!(decode_hazard_rings(&[1, 0, 0]), None); // short header
                                                           // ring_count = 1 but no ring header behind it
        assert_eq!(decode_hazard_rings(&[1, 0, 0, 0]), None);
        // ring_count = 1, point_count = 99, but no points
        let mut truncated = 1u32.to_le_bytes().to_vec();
        truncated.extend_from_slice(&99u32.to_le_bytes());
        assert_eq!(decode_hazard_rings(&truncated), None);
        // trailing bytes after the last ring
        let mut trailing = encode_hazard_rings(&[vec![a, b]]);
        trailing.push(0);
        assert_eq!(decode_hazard_rings(&trailing), None);
    }

    #[test]
    fn directional_semantics_round_trip_through_their_section_payload() {
        let sem = DirectionalSemantics {
            flow_zones: vec![
                FlowZone {
                    rings: vec![vec![
                        WorldXy::new(0, 0),
                        WorldXy::new(100, 0),
                        WorldXy::new(100, 100),
                        WorldXy::new(0, 0),
                    ]],
                    orient_deg: 42.5,
                },
                FlowZone {
                    rings: vec![],
                    orient_deg: -170.0,
                },
            ],
            marks: vec![
                DirectionalMark {
                    pos: WorldXy::new(-5, 7),
                    side: LateralSide::Port,
                },
                DirectionalMark {
                    pos: WorldXy::new(i32::MIN, i32::MAX),
                    side: LateralSide::Starboard,
                },
            ],
        };
        assert_eq!(decode_semantics(&encode_semantics(&sem)), Some(sem));

        // Empty: valid, distinct from an absent section.
        assert_eq!(
            decode_semantics(&encode_semantics(&DirectionalSemantics::default())),
            Some(DirectionalSemantics::default())
        );

        // Structurally impossible payloads are refused, never panic.
        assert_eq!(decode_semantics(&[]), None);
        assert_eq!(decode_semantics(&[0, 0, 0]), None); // short header
        let mut trailing = encode_semantics(&DirectionalSemantics::default());
        trailing.push(0);
        assert_eq!(decode_semantics(&trailing), None);
        // an unknown lateral-side byte
        let mut one_mark = 0u32.to_le_bytes().to_vec(); // zero flow zones
        one_mark.extend_from_slice(&1u32.to_le_bytes()); // one mark
        one_mark.extend_from_slice(&0i32.to_le_bytes());
        one_mark.extend_from_slice(&0i32.to_le_bytes());
        one_mark.push(9); // not 0 or 1
        assert_eq!(decode_semantics(&one_mark), None);
    }

    #[test]
    fn an_artifact_carries_directional_semantics_and_they_survive_the_round_trip() {
        // `sample_cells()` charts no TSS/buoyage, so the built set is
        // empty — but the section is still WRITTEN (distinct from
        // absent), and `load_artifact`/`load_semantics` must agree.
        let built = artifact();
        let dir = TestDir::new("directional-semantics");
        let path = dir.0.join("region.mivnav");
        publish_artifact(&path, identity(), built).unwrap();
        let reader = ArtifactReader::from_file(&path).unwrap();
        let loaded = load_artifact(&reader).unwrap();
        assert_eq!(loaded.directional, built.directional);
        assert_eq!(load_semantics(&reader).unwrap(), built.directional);
    }

    #[test]
    fn a_built_artifact_carries_real_hard_hazard_rings_and_they_survive_the_round_trip() {
        // `sample_cells()` charts a real LNDARE — a hard block.
        let built = artifact();
        assert!(
            !built.hazard_rings.is_empty(),
            "the fixture's LNDARE must produce at least one hard hazard ring"
        );

        let dir = TestDir::new("hazard-rings");
        let path = dir.0.join("region.mivnav");
        publish_artifact(&path, identity(), built).unwrap();
        let reader = ArtifactReader::from_file(&path).unwrap();
        let loaded = load_artifact(&reader).unwrap();
        assert_eq!(loaded.hazard_rings, built.hazard_rings);
        // The standalone loader agrees with the whole-artifact one.
        assert_eq!(load_hazard_rings(&reader).unwrap(), built.hazard_rings);
    }

    #[test]
    fn an_artifact_written_without_the_hazard_rings_section_loads_with_an_empty_set() {
        // §12.4's own compat rule: absence is not corruption and not
        // staleness — a pre-Phase-6 artifact just carries no rings, and
        // the caller re-derives.
        let dir = TestDir::new("no-hazard-section");
        let path = dir.0.join("region.mivnav");
        let a = artifact();
        let mut buf = io::Cursor::new(Vec::new());
        let mut w = ArtifactWriter::new(&mut buf).unwrap();
        // Everything write_artifact_body writes EXCEPT the HazardRings
        // section.
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
        }
        w.finish(identity(), ArtifactVersions::CURRENT).unwrap();
        std::fs::write(&path, buf.into_inner()).unwrap();

        let reader = ArtifactReader::from_file(&path).unwrap();
        assert_eq!(
            load_hazard_rings(&reader).unwrap(),
            Vec::<Vec<WorldXy>>::new()
        );
        let loaded = load_artifact(&reader).expect("a section-less artifact still loads");
        assert!(loaded.hazard_rings.is_empty());
    }

    #[test]
    fn build_and_publish_region_publishes_exactly_what_it_returns() {
        // Deliberately an EMPTY region (one coarse all-no-coverage leaf,
        // per `build::an_empty_region_is_one_coarse_leaf_all_no_coverage`)
        // so the one-call build trigger is covered without a second
        // ten-band sweep — the substantive round trip is the test below,
        // over the shared fixture.
        let dir = TestDir::new("publish-driver");
        let path = dir.0.join("empty.mivnav");
        let built =
            build_and_publish_region(&path, identity(), &[], sample_extent(), CatzocMode::Off)
                .expect("publish succeeds");
        assert_eq!(built.bands.len(), BAND_LADDER_M.len());
        assert!(!built.built.tiles.is_empty());

        let reader = ArtifactReader::from_file(&path).expect("published file parses");
        let loaded = load_artifact(&reader).expect("artifact loads");
        assert_eq!(loaded.built.tiles, built.built.tiles);
        assert_eq!(loaded.bands, built.bands);
    }

    #[test]
    fn build_reporting_drives_the_progress_sink_through_every_phase() {
        // The `*_reporting` entry points must call a `BuildProgress` sink
        // for each build phase — this is what makes the backend bake job
        // show a real progress bar and per-band log lines instead of one
        // opaque "building" for minutes. An EMPTY region is enough: it
        // still runs one refine pass, the full ten-band sweep, and the
        // write.
        #[derive(Default)]
        struct Rec(std::sync::Mutex<Vec<(String, u64, u64)>>);
        impl BuildProgress for Rec {
            fn report(&self, phase: &str, done: u64, total: u64, _note: Option<&str>) {
                self.0.lock().unwrap().push((phase.to_owned(), done, total));
            }
        }

        let dir = TestDir::new("progress-sink");
        let path = dir.0.join("p.mivnav");
        let rec = Rec::default();
        build_and_publish_region_reporting(
            &path,
            identity(),
            &[],
            sample_extent(),
            CatzocMode::Off,
            Some(&rec),
        )
        .expect("publish succeeds");
        let calls = rec.0.into_inner().unwrap();

        let phases: std::collections::BTreeSet<&str> =
            calls.iter().map(|(p, _, _)| p.as_str()).collect();
        assert!(phases.contains("refining tiles"), "{phases:?}");
        assert!(phases.contains("band topology"), "{phases:?}");
        assert!(phases.contains("writing artifact"), "{phases:?}");

        // The band sweep runs under `rayon`, so `done` arrives unordered
        // — only the SET matters: an opening `0`, then every rung `1..=N`.
        let band_done: std::collections::BTreeSet<u64> = calls
            .iter()
            .filter(|(p, _, _)| p == "band topology")
            .map(|(_, d, _)| *d)
            .collect();
        assert_eq!(
            band_done,
            (0..=BAND_LADDER_M.len() as u64).collect(),
            "each of the {} bands should report completion, plus the opening 0",
            BAND_LADDER_M.len()
        );
        assert!(calls
            .iter()
            .filter(|(p, _, _)| p == "band topology")
            .all(|(_, _, total)| *total == BAND_LADDER_M.len() as u64));
        // The write phase both opens (0/1) and closes (1/1).
        assert!(calls.contains(&("writing artifact".to_owned(), 0, 1)));
        assert!(calls.contains(&("writing artifact".to_owned(), 1, 1)));
    }

    #[test]
    fn the_streaming_publish_is_byte_identical_to_the_in_memory_one() {
        // `build_and_publish_region_streaming` holds one band resident at
        // a time; `build_artifact` + `publish_artifact` holds all ten.
        // The file on disk must be the same bytes either way — same
        // sections, same order, same encoders (they share
        // `write_region_sections` / `write_band_sections`).
        let dir = TestDir::new("streaming-eq");
        let in_memory = dir.0.join("in-memory.mivnav");
        let streamed = dir.0.join("streamed.mivnav");

        let built = build_artifact(&sample_cells(), sample_extent(), CatzocMode::Off);
        publish_artifact(&in_memory, identity(), &built).unwrap();

        let summary = build_and_publish_region_streaming(
            &streamed,
            identity(),
            &sample_cells(),
            sample_extent(),
            CatzocMode::Off,
            None,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(&in_memory).unwrap(),
            std::fs::read(&streamed).unwrap(),
            "streamed and in-memory publishes must produce identical files"
        );
        assert_eq!(summary.bands as usize, BAND_LADDER_M.len());
        assert_eq!(summary.report, built.built.report);
        assert_eq!(
            summary.portals,
            built
                .bands
                .iter()
                .map(|b| b.portals.len() as u64)
                .sum::<u64>()
        );
        assert_eq!(
            summary.shortcuts,
            built
                .bands
                .iter()
                .map(|b| b.shortcuts.len() as u64)
                .sum::<u64>()
        );
    }

    #[test]
    fn the_streaming_publish_drives_the_same_progress_phases() {
        // The streamed path must feed a `BuildProgress` sink the same
        // phases the in-memory `*_reporting` one does, so the backend bake
        // job's bar and per-band log are unchanged
        // (`test_routing_mivnav.py` reads those lines). An empty region is
        // enough — it still runs the ten-band sweep and the write.
        #[derive(Default)]
        struct Rec(std::sync::Mutex<Vec<(String, u64, u64, Option<String>)>>);
        impl BuildProgress for Rec {
            fn report(&self, phase: &str, done: u64, total: u64, note: Option<&str>) {
                self.0.lock().unwrap().push((
                    phase.to_owned(),
                    done,
                    total,
                    note.map(str::to_owned),
                ));
            }
        }

        let dir = TestDir::new("streaming-progress");
        let path = dir.0.join("p.mivnav");
        let rec = Rec::default();
        build_and_publish_region_streaming(
            &path,
            identity(),
            &[],
            sample_extent(),
            CatzocMode::Off,
            Some(&rec),
        )
        .unwrap();
        let calls = rec.0.into_inner().unwrap();

        let band_done: std::collections::BTreeSet<u64> = calls
            .iter()
            .filter(|(p, ..)| p == "band topology")
            .map(|(_, d, ..)| *d)
            .collect();
        assert_eq!(
            band_done,
            (0..=BAND_LADDER_M.len() as u64).collect(),
            "each band plus the opening 0 must report"
        );
        assert!(calls.contains(&(
            "writing artifact".to_owned(),
            0,
            1,
            Some("writing .mivnav to disk".to_owned())
        )));
        assert!(calls
            .iter()
            .any(|(p, d, t, _)| p == "writing artifact" && *d == 1 && *t == 1));
        // A per-band note in the exact shape the backend log test keys on:
        // "band <m> m: <c> components, <p> portals, <s> shortcuts".
        let band_notes: Vec<&str> = calls
            .iter()
            .filter_map(|(p, d, _, n)| (p == "band topology" && *d > 0).then_some(n.as_deref()?))
            .collect();
        assert_eq!(band_notes.len(), BAND_LADDER_M.len());
        assert!(band_notes
            .iter()
            .all(|n| n.starts_with("band ") && n.contains(" m:") && n.contains("shortcuts")));
    }

    #[test]
    fn every_band_round_trips_through_a_published_file() {
        let dir = TestDir::new("round-trip");
        let path = dir.0.join("region.mivnav");
        let built = artifact();
        publish_artifact(&path, identity(), built).expect("publish succeeds");

        assert_eq!(built.bands.len(), BAND_LADDER_M.len());

        let reader = ArtifactReader::from_file(&path).expect("published file parses");
        assert!(reader
            .staleness(identity(), &ArtifactVersions::CURRENT)
            .is_none());
        let loaded = load_artifact(&reader).expect("artifact loads");

        // The spatial field comes back identical, field by field. The
        // report deliberately does not (see the module docs).
        assert_eq!(loaded.built.tiles, built.built.tiles);
        assert_eq!(loaded.built.depth_min, built.built.depth_min);
        assert_eq!(loaded.built.depth_max, built.built.depth_max);
        assert_eq!(loaded.built.flags, built.built.flags);
        assert_eq!(loaded.built.stitch, built.built.stitch);
        assert_eq!(loaded.built.report, Default::default());

        // ...and so does every band's whole topology.
        assert_eq!(loaded.bands, built.bands);

        // The tag assertions have to be made against the FILE's own
        // bytes, not against `BandTopology::tag`. `load_band` returns
        // the tag it EXPECTED (the file's is matched against it, never
        // propagated into the result), so `band.tag == band_tag(i)`
        // holds for any file contents whatsoever and proves nothing —
        // it read like round-trip evidence and was not. (Found by code
        // review.) Reading the tag off the payload is the real check.
        for (i, kind) in [
            SectionKind::Components,
            SectionKind::Portals,
            SectionKind::Topology,
            SectionKind::Landmarks,
        ]
        .into_iter()
        .flat_map(|k| (0..BAND_LADDER_M.len() as u8).map(move |i| (i, k)))
        {
            let payload = reader
                .find_band_section(kind, i)
                .unwrap_or_else(|| panic!("no {kind:?} section for band {i}"));
            assert_eq!(
                BandTag::parse(payload),
                band_tag(i),
                "the {kind:?} payload for band {i} does not name that band on disk"
            );
        }
        // A band-by-band load agrees with the whole-artifact one.
        for i in 0..BAND_LADDER_M.len() as u8 {
            assert_eq!(
                load_band(&reader, &loaded.built, i).unwrap(),
                loaded.bands[i as usize]
            );
            assert_eq!(loaded.band(i), Some(&loaded.bands[i as usize]));
        }
        // A band past this build's ladder is refused by name, not by an
        // opaque "missing section".
        let err = load_band(&reader, &loaded.built, BAND_LADDER_M.len() as u8).unwrap_err();
        assert!(err.to_string().contains("ladder"), "{err}");
    }

    #[test]
    fn the_query_loaders_keep_everything_but_the_per_cell_columns() {
        let dir = TestDir::new("query-loaders");
        let path = dir.0.join("region.mivnav");
        let built = artifact();
        publish_artifact(&path, identity(), built).expect("publish succeeds");
        let reader = ArtifactReader::from_file(&path).expect("published file parses");

        let full = load_region(&reader).unwrap();
        let lattice = load_region_lattice(&reader).unwrap();
        assert_eq!(lattice.tiles, full.tiles);
        assert_eq!(lattice.stitch, full.stitch);
        assert!(lattice.depth_min.is_empty() && lattice.depth_max.is_empty());
        assert!(lattice.flags.is_empty());

        for i in 0..BAND_LADDER_M.len() as u8 {
            let want = load_band(&reader, &full, i).unwrap();
            let got = load_band_for_query(&reader, &lattice, i).unwrap();
            assert_eq!(got.components.count, want.components.count, "band {i}");
            assert!(got.components.label.is_empty(), "band {i}");
            assert_eq!(got.portals, want.portals, "band {i}");
            assert_eq!(got.shortcuts, want.shortcuts, "band {i}");
            assert_eq!(got.landmarks, want.landmarks, "band {i}");
            assert_eq!(got.tag, want.tag, "band {i}");
        }
        let err = load_band_for_query(&reader, &lattice, BAND_LADDER_M.len() as u8).unwrap_err();
        assert!(err.to_string().contains("ladder"), "{err}");
    }

    #[test]
    fn the_bands_really_differ_so_the_round_trip_is_not_comparing_ten_copies() {
        // A round-trip test over ten IDENTICAL labellings would pass just
        // as well with the band tag ignored entirely — this is what makes
        // `every_band_round_trips_through_a_published_file` mean
        // something.
        let artifact = artifact();
        let first = &artifact.bands[0].components;
        assert!(
            artifact
                .bands
                .iter()
                .any(|b| &b.components != first || b.portals != artifact.bands[0].portals),
            "the fixture must produce bands that differ from one another"
        );
    }

    #[test]
    fn a_deeper_band_is_never_navigable_where_a_shallower_one_is_not() {
        // A sanity check on the whole per-band sweep rather than one
        // band: a deeper draft can only ever exclude cells, so no band
        // may label a cell the shallowest band left unlabelled.
        let artifact = artifact();
        let shallow = &artifact.bands[0].components;
        for band in &artifact.bands[1..] {
            for (i, &label) in band.components.label.iter().enumerate() {
                if label != NO_COMPONENT {
                    assert_ne!(
                        shallow.label[i],
                        NO_COMPONENT,
                        "cell {i} is navigable at {:?} m but not at {} m",
                        band.band_m(),
                        BAND_LADDER_M[0]
                    );
                }
            }
        }
    }

    #[test]
    fn a_missing_or_truncated_section_is_an_error_not_a_panic() {
        let dir = TestDir::new("truncated");
        let path = dir.0.join("region.mivnav");
        publish_artifact(&path, identity(), artifact()).unwrap();
        let bytes = std::fs::read(&path).unwrap();

        // A file with only the header and no sections at all.
        let mut empty = io::Cursor::new(Vec::new());
        ArtifactWriter::new(&mut empty)
            .unwrap()
            .finish(identity(), ArtifactVersions::CURRENT)
            .unwrap();
        let empty = empty.into_inner();
        let reader = ArtifactReader::from_slice(&empty).unwrap();
        assert!(load_region(&reader).is_err());

        // One real section payload at a time, every byte flipped to
        // 0xFF: whatever a decode makes of the bytes, it must be an
        // error and never a panic. Band 0's own three sections are
        // included by construction — the loop covers every section in
        // the file — and `load_band` is asked for band 0 specifically so
        // the sweep stays one load per corruption rather than ten.
        //
        // The per-decoder malformed-input cases live with the decoders
        // themselves (`topology::decode_components`,
        // `portals::decode_portals`, `shortcuts::decode_shortcuts` each
        // have their own), where a hand-built payload can target one
        // field instead of blanking a whole section.
        let reader = ArtifactReader::from_slice(&bytes).unwrap();
        let built = load_region(&reader).unwrap();
        let mut corrupted_sections = 0;
        for entry in reader.sections() {
            let mut corrupt = bytes.clone();
            for b in &mut corrupt[entry.offset as usize..(entry.offset + entry.len) as usize] {
                *b = 0xFF;
            }
            let Ok(reader) = ArtifactReader::from_slice(&corrupt) else {
                continue;
            };
            corrupted_sections += 1;
            // `load_region` only for the spatial-field sections it
            // actually reads: it re-decodes both depth columns every
            // call, and running it for all band sections spent ~25 s
            // re-proving that corrupting a band's payload does not
            // affect a loader that never looks at one.
            if !matches!(
                entry.kind,
                SectionKind::Components
                    | SectionKind::Portals
                    | SectionKind::Topology
                    | SectionKind::Landmarks
            ) {
                let _ = load_region(&reader);
            }
            let _ = load_band(&reader, &built, 0);
            let _ = load_hazard_rings(&reader);
            let _ = load_semantics(&reader);
        }
        assert_eq!(
            corrupted_sections,
            7 + 4 * BAND_LADDER_M.len(),
            "the sweep must reach every section this build writes \
             (5 spatial + hazard rings + directional semantics + 4 per band)"
        );

        // Truncations of the whole FILE, ~256 probes spread across it:
        // an artifact cut short mid-publish (or mid-copy off the boat)
        // must be refused at some layer and never panic at any of them.
        // Sampled rather than exhaustive because each probe re-decodes
        // the whole tile index and both depth columns — a byte-by-byte
        // sweep of a real artifact is minutes, and the structurally
        // interesting boundaries (header, each section start, the
        // section table) are all a few bytes wide and hit by the header
        // and bounds checks regardless of where the cut lands.
        for len in (0..bytes.len()).step_by((bytes.len() / 256).max(1)) {
            if let Ok(reader) = ArtifactReader::from_slice(&bytes[..len]) {
                if let Ok(built) = load_region(&reader) {
                    let _ = load_band(&reader, &built, 0);
                }
            }
        }
    }

    #[test]
    fn a_band_section_built_at_a_different_depth_is_refused() {
        // §19's own scenario: the ladder moved under an artifact that
        // still opens. Rewrite band 4's Portals tag to a depth this
        // build's rung 4 is not, and the load must refuse it by name
        // rather than answer a 3 m question with 9 m connectivity.
        let mut buf = io::Cursor::new(Vec::new());
        let mut w = ArtifactWriter::new(&mut buf).unwrap();
        write_artifact_body(&mut w, artifact()).unwrap();
        w.finish(identity(), ArtifactVersions::CURRENT).unwrap();
        let mut bytes = buf.into_inner();

        let reader = ArtifactReader::from_slice(&bytes).unwrap();
        let target = reader
            .sections()
            .find(|e| {
                e.kind == SectionKind::Portals
                    && BandTag::parse(reader.section_bytes(*e)).unwrap().band_index == 4
            })
            .expect("band 4 has a portals section");
        // `SectionEntry` is `Copy` and borrows nothing, but the reader
        // itself borrows `bytes` — which the next line mutates.
        drop(reader);
        let at = target.offset as usize + 2;
        let wrong = band_tag(4).unwrap().band_dm + 5;
        bytes[at..at + 2].copy_from_slice(&wrong.to_le_bytes());

        let reader = ArtifactReader::from_slice(&bytes).unwrap();
        let built = load_region(&reader).unwrap();
        let err = load_band(&reader, &built, 4).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("band 4"), "{msg}");
        assert!(msg.contains("band_ladder_version"), "{msg}");
        // Every other band is untouched and still loads.
        for i in [0u8, 3, 5, 9] {
            assert!(load_band(&reader, &built, i).is_ok());
        }
    }

    /// A tile index whose per-tile `payload_offset`s do not partition
    /// the SoA columns must be refused, even when the columns are
    /// exactly as long as the tile COUNT says.
    ///
    /// This is the code-review finding this test exists for: the sum
    /// check alone passed, `load_region` returned `Ok`, and the
    /// resulting `BuiltRegion` then panicked with an out-of-bounds index
    /// inside `label_band` — `bands::navigable_at` indexes
    /// `flags[payload_offset + ...]` directly, not with `get`. On the
    /// boat that is the server process dying on a corrupted file.
    #[test]
    fn a_tile_index_that_does_not_partition_the_columns_is_refused() {
        let artifact = artifact();
        let built = &artifact.built;
        assert!(built.tiles.len() > 1, "the fixture needs several tiles");

        let publish = |tiles: &[TileEntry]| -> Vec<u8> {
            let mut buf = io::Cursor::new(Vec::new());
            let mut w = ArtifactWriter::new(&mut buf).unwrap();
            w.write_section(SectionKind::TileIndex, &encode_tile_index(tiles))
                .unwrap();
            w.write_section(SectionKind::DepthMin, &encode_u16_column(&built.depth_min))
                .unwrap();
            w.write_section(SectionKind::DepthMax, &encode_u16_column(&built.depth_max))
                .unwrap();
            w.write_section(SectionKind::Flags, &built.flags).unwrap();
            w.write_section(SectionKind::BoundaryStitch, &encode_stitch(&built.stitch))
                .unwrap();
            w.finish(identity(), ArtifactVersions::CURRENT).unwrap();
            buf.into_inner()
        };

        // The untampered tiles must still load, or this test proves
        // nothing about the tampering below.
        let ok = publish(&built.tiles);
        let reader = ArtifactReader::from_slice(&ok).unwrap();
        assert_eq!(load_region(&reader).unwrap().tiles, built.tiles);

        // 1. An offset far past the end of the columns. The COLUMNS are
        //    untouched and still exactly `total_cells` long, so the sum
        //    check cannot see this.
        let mut past_eof = built.tiles.clone();
        past_eof[0].payload_offset = u64::MAX / 2;
        // 2. Two tiles aliasing the same payload range: always in
        //    bounds, never panics, and silently reports one tile's
        //    depths for another tile's water — a WRONG ANSWER, which is
        //    worse than a refused file.
        let mut aliased = built.tiles.clone();
        aliased[1].payload_offset = aliased[0].payload_offset;
        // 3. A gap: every tile in bounds, none overlapping, but cells
        //    nothing accounts for.
        let mut gapped = built.tiles.clone();
        for t in gapped.iter_mut().skip(1) {
            t.payload_offset += 1;
        }

        for (what, tiles) in [
            ("offset past EOF", past_eof),
            ("two tiles aliased", aliased),
            ("a gap between tiles", gapped),
        ] {
            let bytes = publish(&tiles);
            let reader = ArtifactReader::from_slice(&bytes).unwrap();
            let err = match load_region(&reader) {
                Err(e) => e,
                Ok(_) => panic!("{what}: must be refused"),
            };
            assert!(err.to_string().contains("partition"), "{what}: {err}");
        }
    }

    #[test]
    fn a_region_whose_columns_disagree_with_its_tile_index_is_refused() {
        // The cross-section check, from both sides. A column even one
        // value short does not fail where it is USED — every index past
        // the discrepancy silently reads the next tile's depths.
        let artifact = artifact();
        for drop_kind in [
            SectionKind::DepthMin,
            SectionKind::DepthMax,
            SectionKind::Flags,
        ] {
            let mut buf = io::Cursor::new(Vec::new());
            let mut w = ArtifactWriter::new(&mut buf).unwrap();
            let built = &artifact.built;
            w.write_section(SectionKind::TileIndex, &encode_tile_index(&built.tiles))
                .unwrap();
            let short_by = |v: &[u16]| encode_u16_column(&v[..v.len() - 1]);
            w.write_section(
                SectionKind::DepthMin,
                &if drop_kind == SectionKind::DepthMin {
                    short_by(&built.depth_min)
                } else {
                    encode_u16_column(&built.depth_min)
                },
            )
            .unwrap();
            w.write_section(
                SectionKind::DepthMax,
                &if drop_kind == SectionKind::DepthMax {
                    short_by(&built.depth_max)
                } else {
                    encode_u16_column(&built.depth_max)
                },
            )
            .unwrap();
            let flags = if drop_kind == SectionKind::Flags {
                &built.flags[..built.flags.len() - 1]
            } else {
                &built.flags[..]
            };
            w.write_section(SectionKind::Flags, flags).unwrap();
            w.write_section(SectionKind::BoundaryStitch, &encode_stitch(&built.stitch))
                .unwrap();
            w.finish(identity(), ArtifactVersions::CURRENT).unwrap();
            let bytes = buf.into_inner();
            let reader = ArtifactReader::from_slice(&bytes).unwrap();
            let err = load_region(&reader).unwrap_err();
            assert!(err.to_string().contains("expected"), "{drop_kind:?}: {err}");
        }
    }
}
