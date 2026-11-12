// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §20's build pipeline: region-wide authority, the per-tile resolution
//! choice, rasterization and stitching, driven over a whole region and
//! written out as a `.mivnav` file.
//!
//! # The circularity [`super::field`]'s docs promise this module resolves
//!
//! [`super::field::choose_tile_resolution`] answers "how fine should THIS
//! extent be" — but a tile's extent is `TILE_CELLS` cells at whatever
//! resolution gets chosen, so the extent to ask about is not known until
//! the question is answered. [`build_region`] breaks the circularity with
//! a top-down recursive refine, exactly the shape a quadtree build always
//! takes:
//!
//! 1. Cover the whole region with CANDIDATE tiles at the ladder's
//!    coarsest rung (1024 m).
//! 2. For each candidate, ask `choose_tile_resolution` over its OWN
//!    extent. If the answer is no finer than the candidate's current
//!    rung — including every candidate already at the finest rung, which
//!    cannot refine further regardless of the answer — the candidate is
//!    a LEAF: rasterize it as-is.
//! 3. Otherwise the candidate's own extent contains something that needs
//!    a finer grid than the candidate itself is. Split it into
//!    `(ratio)²` children at the next-finer rung (`ratio` is the ladder
//!    step's own cell-size ratio — 2 for every step except the anomalous
//!    256→1024 m one, which is 4), and recurse into each.
//!
//! Recursion is well-founded (rung strictly decreases, bounded by the
//! ladder's own length) and each child's resolution is re-asked over ITS
//! OWN, smaller extent — so a child that turns out to be, say, pure open
//! water next to a harbour correctly settles back to a coarse leaf a
//! level or two down, rather than inheriting its sibling's fine rung.
//!
//! ## Judgment call: no re-coarsening
//!
//! A child is never merged back into something COARSER than the rung it
//! was created at, even when its own resolution answer turns out to want
//! that (a child created only because a SIBLING needed refinement, whose
//! own extent has nothing in it). Re-merging needs the sibling group's
//! agreement and is real complexity for a bounded cost: at most one
//! unnecessary refinement step at the border of a detailed region, not
//! unbounded over-refinement, because that same child's own children (if
//! it were split again) would immediately see no trigger and stop. This
//! is the tree taking one extra step it didn't strictly need, not a
//! correctness problem — noted rather than optimised away in Phase 2.
//!
//! ## The per-node geometry rebuild, and the four levers that tamed it
//!
//! Each recursion step re-runs [`region_authority`] and derives a
//! constraint set over its own (narrowed — see [`build_region`]'s
//! candidate-scope inheritance) cell set. Done naively — a full
//! [`constraints::build`] per quadtree node — a real region with deep
//! local refinement re-decodes and re-unions the same ground at every
//! level, and that was measured (not guessed) to be minutes-to-hours of
//! work on a 314-cell German set: the original Phase 2 shape. Four
//! byte-identical levers brought a full national `build_region` down to
//! tens of seconds on a desktop:
//!
//! 1. **`rayon` over the frontier** — every candidate in a level is
//!    independent, [`finish`] sorts leaves into canonical order, so a
//!    parallel build is byte-identical to the old depth-first one.
//! 2. **Parent→child constraint reuse** — a child whose ordered `kept`
//!    set equals its parent's reuses the parent's `Arc<ArtifactConstraints>`
//!    verbatim (the `inherited` fast-path in [`refine_candidate`]).
//! 3. **Per-cell constraint decode cache** — [`constraints::build`] has
//!    no cross-cell interaction, so each cell's feature decode + buffer
//!    runs once ([`constraints::build_one_cell`]) and every node
//!    `combine`s the subset its `kept` set names, never re-decoding.
//! 4. **Build-wide `combine` memo** — [`constraints::combine`]'s
//!    `rings_of` polygon union (measured as ~80 % of `build_region` at
//!    national density once 1–3 landed) is itself memoised on the
//!    ordered `kept` key, so siblings, cousins and the many scattered
//!    open-water nodes that resolve to the same one or two overview
//!    cells all share one union. See [`memoed_combine`].
//!
//! All four are pure-function reuses keyed on the ordered `kept` set, so
//! each is byte-identical, not an approximation
//! (`a_reused_constraint_set_is_byte_identical_to_a_rebuilt_one` and
//! `the_build_wide_combine_memo_is_byte_identical_to_a_full_rebuild`
//! pin it against [`build_region_no_reuse`]'s full per-tile rebuild).
//! The build is still a MANUAL, once-per-chart-set trigger (CLAUDE.md /
//! the user's own "manual trigger for now"), off every interactive and
//! query-time path.
//!
//! **National-scale band pass:** [`super::persist::build_all_bands`] is
//! `O(bands × region cells)` and each band's `UnionFind` plus its
//! `canonicalize` temporaries over a ~4×10⁸-cell national region are
//! multiple GB — running all ten through the full-width `rayon` pool
//! needs more RAM than a 16 GB box has (`MIVNAV_NEXT_TASKS.md` measured
//! it swap-killed). [`super::persist::build_all_bands_reporting`] now
//! caps band concurrency to a `/proc/meminfo` budget
//! ([`super::persist`]'s `band_pass_concurrency`), floored at one band
//! at a time; fixture-scale regions still fan out unchanged. The output
//! is byte-identical at any concurrency (indexed `map` → `collect`).
//!
//! ## Judgment call: the topology-bottleneck trigger is NOT this module's
//!
//! [`super::field::TRIGGER_TOPOLOGY_BOTTLENECK`] needs Phase 3's
//! component sweep to even know what a bottleneck is — this module
//! builds the region in one pass over [`TRIGGERS_IMPLEMENTED`] only.
//! Phase 3 is expected to run a second, TARGETED re-rasterization of
//! whatever tiles its own sweep flags, not to route back through this
//! whole top-down refine again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rayon::prelude::*;

use crate::coords::Extent;
use crate::model::Cell;
use crate::routing::artifact::constraints;
use crate::routing::artifact::ladder::RESOLUTION_LADDER_M;
use crate::routing::artifact::{CatzocMode, ConstraintParams};

use super::authority::{cell_descs, region_authority, RegionCell};
use super::field::{
    choose_tile_resolution_with, rasterize_tile_with, RegionLattice, TileEntry, TileRaster,
    TileReport, TILE_CELLS, TILE_FLAG_VECTOR_REQUIRED, TRIGGER_INHERITED_FROM_SPLIT,
};
use super::stitch::{compute_stitch, StitchRun};
use crate::coverage::Coverage;
use crate::mvt::select::CellDesc;

/// Coarse build-phase progress, for a caller that runs [`build_region`] /
/// [`super::persist::build_artifact`] with the GIL (or any lock)
/// released and wants to surface "what is the bake doing" while it runs.
///
/// Called from [`build_region`] between quadtree refine passes, from
/// [`super::persist::build_all_bands`] as each band finishes, and once
/// around the file write — a few dozen calls for a whole national build,
/// **never per tile** — so an implementation that re-acquires a lock or
/// the Python GIL per call is fine. `total == 0` means "size unknown,
/// show an indeterminate bar". A `note` is a one-line human log message
/// (only some calls carry one; the frequent bar-only updates do not, so
/// a capped log is not flooded). It must not panic or block for long.
pub trait BuildProgress: Sync {
    fn report(&self, phase: &str, done: u64, total: u64, note: Option<&str>);
}

/// Fire `p.report(...)` iff a progress sink is present. `note` is a
/// closure so its `format!` never runs on the sink-less path — every
/// serve-time and test caller goes through the non-reporting entry
/// points with `prog == None`, and this is called once per ladder rung.
fn progress(
    p: Option<&dyn BuildProgress>,
    phase: &str,
    done: u64,
    total: u64,
    note: impl FnOnce() -> Option<String>,
) {
    if let Some(p) = p {
        p.report(phase, done, total, note().as_deref());
    }
}

/// The ladder's own coarsest rung — every [`build_region`] run starts
/// candidates here. See [`super::field::OPEN_WATER_CELL_M`], which is
/// this same rung's metre value.
const COARSEST_RUNG: u8 = (RESOLUTION_LADDER_M.len() - 1) as u8;

/// Everything [`build_region`] produces: the finished tile index, the
/// concatenated SoA payload columns (indexed by each tile's own
/// `payload_offset`), and the boundary-stitch table over the finished
/// tiles.
#[derive(Debug, Clone, Default)]
pub struct BuiltRegion {
    /// Sorted `(origin_y, origin_x)`, per [`super::field::encode_tile_index`]'s
    /// own documented on-disk order — `StitchRun::tile`/`neighbour_tile`
    /// and every `payload_offset` are positions into THIS order.
    pub tiles: Vec<TileEntry>,
    pub depth_min: Vec<u16>,
    pub depth_max: Vec<u16>,
    pub flags: Vec<u8>,
    pub stitch: Vec<StitchRun>,
    pub report: BuildReport,
}

/// §20's "record per run": the numbers a real build should print, not
/// just the bytes it writes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BuildReport {
    pub tile_count: u32,
    pub vector_required_tiles: u32,
    pub total_cells: u64,
    pub blocked_cells: u64,
    pub no_coverage_cells: u64,
    pub charted_depth_cells: u64,
    /// Tiles at each rung, indexed by rung (`[0]` is 2 m, `[8]` is
    /// 1024 m) — §20's "area per ladder level", in tile counts rather
    /// than area since every tile is the same cell count
    /// ([`TILE_CELLS`]).
    pub tiles_per_rung: [u32; RESOLUTION_LADDER_M.len()],
}

/// Build a region's spatial field: authority, resolution, rasterization
/// and stitching, over every chart cell in `cells` that reaches
/// `region_extent`.
///
/// `cells` should already be whatever the caller considers "this chart
/// set" — [`build_region`] does its OWN region-wide authority resolution
/// per candidate tile (§3.2), so passing overlapping charts in is
/// correct, not a caller error.
///
/// # Vessel-independence (§6) is enforced HERE, not trusted from the caller
///
/// `catzoc_mode` is the one legitimate build-time knob
/// [`ConstraintParams`] carries — a survey-confidence POLICY fixed for
/// the whole artifact, not a property of any one boat. Every other field
/// (`required_depth_m`, `required_air_draft_m`, `lateral_margin_m`,
/// `allow_restricted_entry`) is a vessel or per-query permission, and §6
/// forbids the build from depending on any of them — [`super::field`]'s
/// own docs already say so ("the build calls it at `required_depth_m =
/// 0.0`"). Taking a bare `CatzocMode` here, rather than a whole
/// `ConstraintParams` a future caller could hand in with real vessel
/// figures already set, makes the wrong call impossible to write instead
/// of merely documented against — `constraints::build`/
/// `choose_tile_resolution_with`/`rasterize_tile_with` below always see
/// the fixed, neutral params this function constructs itself.
pub fn build_region(cells: &[Cell], region_extent: Extent, catzoc_mode: CatzocMode) -> BuiltRegion {
    build_region_impl(cells, region_extent, catzoc_mode, true, None)
}

/// [`build_region`] with the parent→child constraint reuse forced OFF —
/// every quadtree node re-decodes its own `constraints::build`. Only a
/// test uses this, to prove the reuse path is byte-identical to the
/// from-scratch one on real multi-cell chart data
/// (`a_reused_constraint_set_is_byte_identical_to_a_rebuilt_one`).
#[cfg(test)]
pub(crate) fn build_region_no_reuse(
    cells: &[Cell],
    region_extent: Extent,
    catzoc_mode: CatzocMode,
) -> BuiltRegion {
    build_region_impl(cells, region_extent, catzoc_mode, false, None)
}

pub(super) fn build_region_impl(
    cells: &[Cell],
    region_extent: Extent,
    catzoc_mode: CatzocMode,
    reuse_constraints: bool,
    prog: Option<&dyn BuildProgress>,
) -> BuiltRegion {
    let params = ConstraintParams {
        required_depth_m: 0.0,
        // The bake is vessel-independent (§6): it stores raw depth, not a
        // draft verdict, so the query-time soft-depth tiers are OFF here.
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        catzoc_mode,
        allow_restricted_entry: false,
        // The bake never reads `charted_depth`; unioning every DEPARE a
        // second time (the `rings_of` union is already ~80 % of
        // `build_region`) roughly doubled DK build time. Only the
        // fine-search path (`artifact_route`) sets this.
        build_charted_depth: false,
    };
    let params = &params;

    let lattice = RegionLattice::for_region(region_extent);
    let region_cells: Vec<RegionCell> = cells.iter().map(RegionCell::from_cell).collect();
    let descs = cell_descs(&region_cells);
    let all_idx: Vec<usize> = (0..cells.len()).collect();

    // Decode + per-feature buffer each cell's constraint geometry ONCE.
    // `constraints::build(cells)` has no cross-cell interaction — it
    // accumulates each cell's rings and folds the two scalars — so a
    // tile's constraints are `constraints::combine` over just the cells
    // its own authority resolution kept, and the expensive decode never
    // repeats. Byte-identical: `combine` runs the identical `rings_of`
    // union over the identical accumulated polygons, in the same cell
    // order the old per-tile `constraints::build` used. Skipped entirely
    // on the `!reuse_constraints` reference path.
    let cell_constraints: Vec<constraints::CellConstraints> = if reuse_constraints {
        cells
            .par_iter()
            .map(|c| constraints::build_one_cell(c, params))
            .collect()
    } else {
        Vec::new()
    };

    // Level-synchronous BFS refine, one ladder rung per pass. Every
    // candidate in a frontier is INDEPENDENT — its resolution decision
    // and raster depend only on its own extent and its inherited cell
    // scope, never on a sibling's result — so the per-candidate work
    // (the expensive part: `region_authority` + `constraints::build` +
    // `rasterize_tile_with`, which the module docs call out as the
    // build's dominant cost) is fanned out with `rayon`. Output is
    // order-independent: `finish` sorts the leaves into the canonical
    // `(origin_y, origin_x)` order regardless of the order they were
    // produced in, so a parallel build is byte-identical to the old
    // depth-first one (pinned by `mivnav_persist_de6ostim.rs`'s
    // round-trip and `mivnav_build_de6ostim.rs`'s determinism checks).
    //
    // Each candidate also carries what its PARENT resolved: the parent's
    // `kept` cell set and the `ArtifactConstraints` built from it. A
    // child whose own authority-resolved `kept` is byte-identical to its
    // parent's reuses that constraint set instead of re-decoding hazard
    // geometry — `constraints::build` is a pure function of its cells, so
    // same cells in means same constraints out, and this is
    // byte-identical, not an approximation. The hit rate is highest
    // exactly where it costs the most: a large extent covered by one or
    // two overview cells splits into four children with the same `kept`,
    // all the way down until finer cells actually partition the ground.
    //
    // The parent→child check only catches a node identical to its OWN
    // parent. A build-wide memo keyed on the ordered `kept` set catches
    // every other repeat too — siblings, cousins, and the many
    // scattered open-water nodes that all resolve to the same one or two
    // overview cells. `constraints::combine` is a pure function of its
    // ordered parts (measured as ~80 % of `build_region` at national
    // density — the `rings_of` polygon union per ring class), so a memo
    // on `kept` returns the byte-identical set, exactly like the parent
    // fast-path does. A racing double-compute is possible and harmless
    // (identical result); the expensive `combine` runs OUTSIDE the lock.
    let combine_memo: CombineMemo = Mutex::new(HashMap::new());
    let mut frontier: Vec<(TileEntry, Option<Arc<Inherited>>)> =
        root_tiles(&lattice, region_extent)
            .into_iter()
            .map(|t| (t, None))
            .collect();
    let mut built: Vec<(TileEntry, TileRaster)> = Vec::new();

    // One pass per ladder rung, coarsest first — a bounded, always-forward
    // denominator for the progress bar (`pass` never exceeds the ladder
    // length; a shallow region just finishes several passes early).
    let max_passes = RESOLUTION_LADDER_M.len() as u64;
    let mut pass = 0u64;
    while !frontier.is_empty() {
        progress(
            prog,
            "refining tiles",
            pass.min(max_passes),
            max_passes,
            || {
                Some(format!(
                    "refine pass {pass}: {} candidate tile(s), {} finished",
                    frontier.len(),
                    built.len()
                ))
            },
        );
        let outcomes: Vec<TileOutcome> = frontier
            .par_iter()
            .map(|(candidate, inherited)| {
                refine_candidate(
                    candidate,
                    inherited.as_deref(),
                    cells,
                    &descs,
                    &lattice,
                    params,
                    &all_idx,
                    &cell_constraints,
                    &combine_memo,
                    reuse_constraints,
                )
            })
            .collect();

        let mut next: Vec<(TileEntry, Option<Arc<Inherited>>)> = Vec::new();
        for outcome in outcomes {
            match outcome {
                TileOutcome::Leaf(leaf, raster) => built.push((leaf, raster)),
                TileOutcome::Split(children) => next.extend(children),
            }
        }
        frontier = next;
        pass += 1;
    }

    progress(prog, "refining tiles", max_passes, max_passes, || {
        Some(format!("{} leaf tiles rasterized", built.len()))
    });
    finish(built)
}

/// What a quadtree candidate inherits from its parent: the parent's own
/// candidate cell set (`scope_idx`, the search space for this child's
/// extent-intersection filter), the parent's authority-resolved `kept`
/// set, and the `ArtifactConstraints` built from it. Shared by all four
/// children of a split via `Arc`.
struct Inherited {
    scope_idx: Vec<usize>,
    kept: Vec<usize>,
    constraints: Arc<constraints::ArtifactConstraints>,
}

/// One frontier candidate's fate: either a finished leaf, or the child
/// candidates it splits into (each carrying this node's own
/// [`Inherited`]).
enum TileOutcome {
    Leaf(TileEntry, TileRaster),
    Split(Vec<(TileEntry, Option<Arc<Inherited>>)>),
}

/// Build-wide `constraints::combine` memo, keyed on the ordered
/// authority-resolved `kept` cell-index set. See the comment at the
/// frontier loop for why keying on `kept` is byte-identical.
type CombineMemo = Mutex<HashMap<Vec<usize>, Arc<constraints::ArtifactConstraints>>>;

/// `constraints::combine` over `kept`'s per-cell precompute, memoised in
/// `memo` on the ordered `kept` key. The lock is taken only for the
/// map lookup and the insert — never across the `combine` call itself
/// (each `lock()` guard is confined to its own `{}` block, both so a
/// racing thread can compute in parallel and so this cannot re-enter the
/// non-reentrant mutex). A lost race just means two threads compute the
/// same (byte-identical) union and the second insert wins harmlessly.
fn memoed_combine(
    memo: &CombineMemo,
    kept: &[usize],
    cell_constraints: &[constraints::CellConstraints],
) -> Arc<constraints::ArtifactConstraints> {
    let hit = {
        let map = memo.lock().unwrap();
        map.get(kept).cloned()
    };
    if let Some(hit) = hit {
        return hit;
    }
    let built = Arc::new(constraints::combine(
        kept.iter().map(|&i| &cell_constraints[i]),
    ));
    let mut map = memo.lock().unwrap();
    // A racing thread may have inserted first — keep whichever landed, so
    // every node with this `kept` shares one `Arc` (both are the same
    // union, so this is a memory tidy, not a correctness point).
    Arc::clone(map.entry(kept.to_vec()).or_insert(built))
}

/// The per-candidate work of [`build_region`]'s refine — a pure function
/// of the candidate, its inherited context, and the immutable region
/// inputs, so a whole frontier of these runs in parallel.
#[allow(clippy::too_many_arguments)]
fn refine_candidate(
    candidate: &TileEntry,
    inherited: Option<&Inherited>,
    cells: &[Cell],
    descs: &[CellDesc<'_, Coverage>],
    lattice: &RegionLattice,
    params: &ConstraintParams,
    all_idx: &[usize],
    cell_constraints: &[constraints::CellConstraints],
    combine_memo: &CombineMemo,
    reuse_constraints: bool,
) -> TileOutcome {
    let extent = candidate.extent();
    // The parent's own candidate set is already a superset of anything
    // that can matter here — every cell that reaches THIS extent also
    // reached the parent's larger one — so re-scanning only that (not all
    // of `cells`) is exact, not an approximation, and keeps a deep local
    // refinement from re-doing an O(total cells) scan at every level. A
    // root has no parent and scans everything.
    let scope: &[usize] = inherited.map_or(all_idx, |i| &i.scope_idx);
    let candidate_idx: Vec<usize> = scope
        .iter()
        .copied()
        .filter(|&i| cells[i].extent.intersects(&extent))
        .collect();
    let (kept, _redundant) = region_authority(descs, &candidate_idx, extent);
    let kept_cells: Vec<&Cell> = kept.iter().map(|&i| &cells[i]).collect();

    // Four ways to get this node's constraints, cheapest first:
    //  1. the parent's, verbatim, when this node resolved to the exact
    //     same cells (ordered — `constraints::build`'s only
    //     order-sensitivity is its first-match `M_QUAL` lookup);
    //  2. the build-wide `combine_memo`, when some earlier node anywhere
    //     in the tree already unioned this exact ordered `kept` set;
    //  3. `combine` over the per-cell precompute for just this node's
    //     `kept` set — no feature re-decode, but the `rings_of` union is
    //     still run, so its result goes into the memo;
    //  4. the reference path (`!reuse_constraints`) — a full per-tile
    //     `constraints::build`, kept so a test can prove 1–3 identical.
    let constraints: Arc<constraints::ArtifactConstraints> = if !reuse_constraints {
        Arc::new(constraints::build(&kept_cells, params))
    } else if let Some(p) = inherited.filter(|p| p.kept == kept) {
        Arc::clone(&p.constraints)
    } else {
        memoed_combine(combine_memo, &kept, cell_constraints)
    };
    let resolution = choose_tile_resolution_with(&kept_cells, extent, &constraints);

    if candidate.rung == 0 || resolution.rung >= candidate.rung {
        let raster = rasterize_tile_with(candidate, &kept_cells, &constraints);
        let mut leaf = *candidate;
        leaf.triggers = resolution.triggers;
        if resolution.triggers == 0 && candidate.rung < COARSEST_RUNG {
            // This leaf's own content triggered nothing — an independent
            // build of this exact extent would have settled at
            // COARSEST_RUNG (see `choose_tile_resolution_with`:
            // `triggers == 0` and "no trigger" are the same branch, and
            // that branch always answers the coarsest rung). It is finer
            // than that only because a SIBLING inside the same split
            // needed it — the "no re-coarsening" judgment call. Record
            // that so §18's overlay never reads this as an unexplained
            // fine tile.
            leaf.triggers |= TRIGGER_INHERITED_FROM_SPLIT;
        }
        leaf.tile_flags = if raster.report.vector_required {
            TILE_FLAG_VECTOR_REQUIRED
        } else {
            0
        };
        TileOutcome::Leaf(leaf, raster)
    } else {
        // Every child of this split inherits this node's own resolved
        // context: its candidate set (the child's scan space), its
        // `kept`, and its constraints (reused directly when the child
        // resolves the same cells).
        let child_ctx = Arc::new(Inherited {
            scope_idx: candidate_idx,
            kept,
            constraints,
        });
        TileOutcome::Split(
            quadtree_children(lattice, candidate)
                .into_iter()
                .map(|child| (child, Some(Arc::clone(&child_ctx))))
                .collect(),
        )
    }
}

/// Sort the built leaves into the on-disk order, assign `payload_offset`
/// in that order, concatenate the SoA columns, compute the stitch table
/// over the finished positions, and roll up [`BuildReport`].
fn finish(mut built: Vec<(TileEntry, TileRaster)>) -> BuiltRegion {
    built.sort_by_key(|(t, _)| (t.origin_y, t.origin_x));

    let mut tiles = Vec::with_capacity(built.len());
    let mut depth_min = Vec::new();
    let mut depth_max = Vec::new();
    let mut flags = Vec::new();
    let mut report = BuildReport {
        tile_count: built.len() as u32,
        ..BuildReport::default()
    };

    for (mut tile, raster) in built {
        tile.payload_offset = depth_min.len() as u64;
        depth_min.extend_from_slice(&raster.depth_min);
        depth_max.extend_from_slice(&raster.depth_max);
        flags.extend_from_slice(&raster.flags);
        accumulate(&mut report, &tile, &raster.report);
        tiles.push(tile);
    }

    let stitch = compute_stitch(&tiles);
    BuiltRegion {
        tiles,
        depth_min,
        depth_max,
        flags,
        stitch,
        report,
    }
}

fn accumulate(report: &mut BuildReport, tile: &TileEntry, tr: &TileReport) {
    if tr.vector_required {
        report.vector_required_tiles += 1;
    }
    report.total_cells += tile.cell_count() as u64;
    report.blocked_cells += u64::from(tr.blocked_cells);
    report.no_coverage_cells += u64::from(tr.no_coverage_cells);
    report.charted_depth_cells += u64::from(tr.charted_depth_cells);
    if let Some(slot) = report.tiles_per_rung.get_mut(tile.rung as usize) {
        *slot += 1;
    }
}

/// Cover `region_extent` with candidate tiles at [`COARSEST_RUNG`],
/// anchored to `lattice`'s own grid at that rung (so two overlapping
/// build regions produce identical root tiles wherever they overlap —
/// §13's determinism applies to the build, not only the query).
fn root_tiles(lattice: &RegionLattice, region_extent: Extent) -> Vec<TileEntry> {
    let tw = lattice.tile_world(COARSEST_RUNG);
    if tw <= 0 || !region_extent.valid {
        return Vec::new();
    }
    let cw = lattice.cell_world(COARSEST_RUNG);
    let cells = TILE_CELLS as u16;

    let first_ox = i64::from(region_extent.xmin).div_euclid(tw) * tw;
    let first_oy = i64::from(region_extent.ymin).div_euclid(tw) * tw;

    let mut out = Vec::new();
    let mut oy = first_oy;
    while oy < i64::from(region_extent.ymax) {
        let mut ox = first_ox;
        while ox < i64::from(region_extent.xmax) {
            out.push(TileEntry {
                origin_x: ox as i32,
                origin_y: oy as i32,
                cell_world: cw,
                rung: COARSEST_RUNG,
                tile_flags: 0,
                cols: cells,
                rows: cells,
                triggers: 0,
                payload_offset: 0,
            });
            ox += tw;
        }
        oy += tw;
    }
    out
}

/// Split `parent` into the `(ratio)²` children one ladder step finer,
/// where `ratio` is that step's own cell-size ratio (2, except the one
/// 256→1024 m step, which is 4) — see [`super::field::RegionLattice`]'s
/// own docs on why every ratio here comes from cell sizes, never from a
/// rung-index difference.
fn quadtree_children(lattice: &RegionLattice, parent: &TileEntry) -> Vec<TileEntry> {
    debug_assert!(parent.rung > 0);
    let child_rung = parent.rung - 1;
    let child_tw = lattice.tile_world(child_rung);
    let parent_tw = lattice.tile_world(parent.rung);
    if child_tw <= 0 {
        return Vec::new();
    }
    let ratio = (parent_tw / child_tw).max(1);
    let cw = lattice.cell_world(child_rung);
    let cells = TILE_CELLS as u16;

    let mut out = Vec::with_capacity((ratio * ratio) as usize);
    for j in 0..ratio {
        for i in 0..ratio {
            out.push(TileEntry {
                origin_x: parent.origin_x + (i * child_tw) as i32,
                origin_y: parent.origin_y + (j * child_tw) as i32,
                cell_world: cw,
                rung: child_rung,
                tile_flags: 0,
                cols: cells,
                rows: cells,
                triggers: 0,
                payload_offset: 0,
            });
        }
    }
    out
}

/// Byte-serialize a `u16` SoA column, little-endian — the raw
/// [`super::format::SectionKind::DepthMin`]/`DepthMax` payload shape.
pub fn encode_u16_column(values: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 2);
    for &v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Parse a `u16` SoA column back out of a section payload —
/// [`encode_u16_column`]'s inverse.
///
/// `expected` is the number of values the tile index says this column
/// must hold, and it is checked EXACTLY, not as a lower bound. The three
/// SoA columns are addressed by a shared flat index
/// (`tile.payload_offset + tile.index(col, row)`, see
/// [`super::field::TileEntry`]), so a column even one value short of the
/// tile index does not fail where it is used — it quietly returns the
/// NEXT tile's depths for every cell past the discrepancy. Rejecting the
/// whole column here is the only place that can still be loud about it.
pub fn decode_u16_column(bytes: &[u8], expected: usize) -> Option<Vec<u16>> {
    if bytes.len() != expected.checked_mul(2)? {
        return None;
    }
    Some(
        bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::model::{AttrValue, CellMeta, Feature, Geometry, Polygon};
    use crate::routing::artifact::CatzocMode;
    use std::collections::BTreeMap;

    const LAT: f64 = 54.0;
    const LON: f64 = 11.0;

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

    fn feature(class: &str, attrs: &[(&str, AttrValue)], geom: Geometry) -> Feature {
        let mut map = BTreeMap::new();
        for (k, v) in attrs {
            map.insert((*k).to_string(), v.clone());
        }
        Feature::new(1, class.into(), map, Some(geom))
    }

    fn area(class: &str, lat: f64, lon: f64, half: f64, attrs: &[(&str, AttrValue)]) -> Feature {
        feature(
            class,
            attrs,
            Geometry::Areas(vec![Polygon {
                outer: square(lat, lon, half),
                holes: vec![],
            }]),
        )
    }

    fn cell_of(features: Vec<Feature>, scale: u32) -> Cell {
        let mut extent = Extent::invalid();
        for f in &features {
            extent.extend(&f.extent);
        }
        Cell {
            meta: CellMeta {
                compilation_scale: scale,
                ..CellMeta::default()
            },
            features,
            extent,
        }
    }

    fn small_region_extent() -> Extent {
        Extent::new(
            lat_lon_to_world(LAT, LON - 0.01).x,
            lat_lon_to_world(LAT, LON + 0.01).x,
            lat_lon_to_world(LAT + 0.01, LON).y,
            lat_lon_to_world(LAT - 0.01, LON).y,
        )
    }

    #[test]
    fn a_reused_constraint_set_is_byte_identical_to_a_rebuilt_one() {
        // The parent→child `constraints::build` reuse is only a speedup
        // if it never changes the output. Two feature-carrying cells far
        // apart in a large region: the empty ground between them makes
        // every split inherit an unchanged (empty) `kept` — reuse fires
        // at every level — and the ground around each cell exercises the
        // "same single cell, unchanged `kept`" reuse too.
        let far_lat = LAT + 1.5;
        let far_lon = LON + 2.0;
        let harbour = |lat: f64, lon: f64| {
            cell_of(
                vec![
                    area("M_COVR", lat, lon, 900.0, &[("CATCOV", AttrValue::Int(1))]),
                    feature(
                        "SLCONS",
                        &[("CATSLC", AttrValue::Int(1))],
                        Geometry::Lines(vec![vec![
                            lat_lon_to_world(lat, lon - 0.001),
                            lat_lon_to_world(lat, lon + 0.001),
                        ]]),
                    ),
                    feature(
                        "UWTROC",
                        &[],
                        Geometry::Point(lat_lon_to_world(lat + 0.0008, lon)),
                    ),
                ],
                4_000,
            )
        };
        let cells = [harbour(LAT, LON), harbour(far_lat, far_lon)];
        let region = Extent::new(
            lat_lon_to_world(LAT, LON - 0.05).x,
            lat_lon_to_world(far_lat, far_lon + 0.05).x,
            lat_lon_to_world(far_lat + 0.05, far_lon).y,
            lat_lon_to_world(LAT - 0.05, LON).y,
        );

        for mode in [CatzocMode::Off, CatzocMode::Full] {
            let reused = build_region(&cells, region, mode);
            let rebuilt = build_region_no_reuse(&cells, region, mode);
            assert_eq!(reused.tiles, rebuilt.tiles, "{mode:?}: tiles differ");
            assert_eq!(reused.depth_min, rebuilt.depth_min, "{mode:?}: depth_min");
            assert_eq!(reused.depth_max, rebuilt.depth_max, "{mode:?}: depth_max");
            assert_eq!(reused.flags, rebuilt.flags, "{mode:?}: flags");
            assert_eq!(reused.stitch, rebuilt.stitch, "{mode:?}: stitch");
            assert_eq!(reused.report, rebuilt.report, "{mode:?}: report");
            // And it actually refined — otherwise the quadtree never
            // recursed and there was nothing to reuse.
            assert!(
                reused.tiles.len() > 4,
                "{mode:?}: region did not refine, test proves nothing"
            );
        }
    }

    #[test]
    fn the_build_wide_combine_memo_is_byte_identical_to_a_full_rebuild() {
        // The parent→child fast-path only catches a node identical to its
        // OWN parent. The `combine_memo` also collapses siblings and
        // cousins that resolve to the same ordered `kept` set — a repeat
        // the parent check never sees. Two large OVERLAPPING cells of
        // different compilation scale, each carrying its own hazard, so
        // authority keeps BOTH across the whole overlap and the
        // two-element `kept` recurs at every refined node in the tree,
        // exercised against `build_region_no_reuse`'s full per-tile
        // `constraints::build`.
        let coarse = cell_of(
            vec![
                area(
                    "M_COVR",
                    LAT,
                    LON,
                    4_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                feature(
                    "SLCONS",
                    &[("CATSLC", AttrValue::Int(1))],
                    Geometry::Lines(vec![vec![
                        lat_lon_to_world(LAT + 0.01, LON - 0.02),
                        lat_lon_to_world(LAT + 0.01, LON + 0.02),
                    ]]),
                ),
            ],
            22_000,
        );
        let fine = cell_of(
            vec![
                area(
                    "M_COVR",
                    LAT,
                    LON,
                    4_000.0,
                    &[("CATCOV", AttrValue::Int(1))],
                ),
                feature(
                    "UWTROC",
                    &[],
                    Geometry::Point(lat_lon_to_world(LAT - 0.01, LON + 0.005)),
                ),
            ],
            4_000,
        );
        let cells = [coarse, fine];
        let region = Extent::new(
            lat_lon_to_world(LAT, LON - 0.06).x,
            lat_lon_to_world(LAT, LON + 0.06).x,
            lat_lon_to_world(LAT + 0.06, LON).y,
            lat_lon_to_world(LAT - 0.06, LON).y,
        );

        for mode in [CatzocMode::Off, CatzocMode::Full] {
            let memoed = build_region(&cells, region, mode);
            let rebuilt = build_region_no_reuse(&cells, region, mode);
            assert_eq!(memoed.tiles, rebuilt.tiles, "{mode:?}: tiles");
            assert_eq!(memoed.depth_min, rebuilt.depth_min, "{mode:?}: depth_min");
            assert_eq!(memoed.depth_max, rebuilt.depth_max, "{mode:?}: depth_max");
            assert_eq!(memoed.flags, rebuilt.flags, "{mode:?}: flags");
            assert_eq!(memoed.stitch, rebuilt.stitch, "{mode:?}: stitch");
            assert_eq!(memoed.report, rebuilt.report, "{mode:?}: report");
            assert!(
                memoed.tiles.len() > 4,
                "{mode:?}: region did not refine, test proves nothing"
            );
        }
    }

    #[test]
    fn an_empty_region_is_one_coarse_leaf_all_no_coverage() {
        let extent = small_region_extent();
        let built = build_region(&[], extent, CatzocMode::Off);
        assert_eq!(built.tiles.len(), 1);
        assert_eq!(built.tiles[0].rung, COARSEST_RUNG);
        assert!(built
            .depth_min
            .iter()
            .all(|&d| d == super::super::format::DEPTH_NO_COVERAGE));
        assert_eq!(built.report.tile_count, 1);
        assert_eq!(built.report.charted_depth_cells, 0);
    }

    #[test]
    fn a_harbour_amid_open_water_refines_locally_and_stitches_to_its_neighbours() {
        let extent = small_region_extent();
        let mid = extent.midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        // A small, real breakwater near the centre — small enough that
        // most of the region is genuinely open water around it.
        let c = cell_of(
            vec![
                area("M_COVR", lat, lon, 800.0, &[("CATCOV", AttrValue::Int(1))]),
                feature(
                    "SLCONS",
                    &[("CATSLC", AttrValue::Int(1))],
                    Geometry::Lines(vec![vec![
                        lat_lon_to_world(lat, lon - 0.001),
                        lat_lon_to_world(lat, lon + 0.001),
                    ]]),
                ),
            ],
            4_000,
        );
        let built = build_region(&[c], extent, CatzocMode::Off);

        // More than one tile: the region did NOT stay uniformly coarse.
        assert!(built.tiles.len() > 1, "must have refined somewhere");
        // At least one tile is fine enough to see the breakwater at all.
        assert!(built.tiles.iter().any(|t| t.rung < COARSEST_RUNG));
        // Refinement was LOCAL, not a blanket refine of the whole region:
        // some tiles end up strictly coarser than others. (The coarsest
        // ROOT tile is ~262 km — this whole test region sits inside a
        // single one of those — so once it needs any refinement at all,
        // none of its own children can land back at COARSEST_RUNG itself;
        // see the module docs' "no re-coarsening" judgment call. The real
        // invariant this test wants is variety, not a specific rung.)
        let min_rung = built.tiles.iter().map(|t| t.rung).min().unwrap();
        let max_rung = built.tiles.iter().map(|t| t.rung).max().unwrap();
        assert!(
            max_rung > min_rung,
            "refinement must be local: got a uniform rung {min_rung} everywhere"
        );
        // At least one fine tile has nothing of its own to trigger it —
        // it only refined because a sibling in the same split did — and
        // that must be recorded, not silently read back as "no reason".
        assert!(
            built
                .tiles
                .iter()
                .any(|t| t.rung < COARSEST_RUNG && t.triggers == TRIGGER_INHERITED_FROM_SPLIT),
            "at least one sibling of the refined tile must be inherited-only"
        );
        // Every SoA column is exactly as long as the tiles' own cell
        // counts sum to, and payload_offset is a valid, non-overlapping
        // partition of it.
        let total: usize = built.tiles.iter().map(|t| t.cell_count()).sum();
        assert_eq!(built.depth_min.len(), total);
        assert_eq!(built.depth_max.len(), total);
        assert_eq!(built.flags.len(), total);
        let mut offsets: Vec<u64> = built.tiles.iter().map(|t| t.payload_offset).collect();
        offsets.sort_unstable();
        offsets.dedup();
        assert_eq!(offsets.len(), built.tiles.len(), "offsets must be unique");

        // The tile index is in the documented (origin_y, origin_x) order.
        let mut prev: Option<(i32, i32)> = None;
        for t in &built.tiles {
            let key = (t.origin_y, t.origin_x);
            if let Some(p) = prev {
                assert!(p <= key, "tiles must be sorted (origin_y, origin_x)");
            }
            prev = Some(key);
        }

        // Stitching found real contacts: with more than one tile, at
        // least the coarse/fine seam around the refined area must
        // produce runs.
        assert!(!built.stitch.is_empty());
        for run in &built.stitch {
            assert_ne!(run.tile, run.neighbour_tile);
            assert!((run.tile as usize) < built.tiles.len());
            assert!((run.neighbour_tile as usize) < built.tiles.len());
        }

        assert!(
            built.report.vector_required_tiles >= 1,
            "a bare SLCONS line must be thin"
        );
    }

    #[test]
    fn a_shallow_depare_never_hard_blocks_regardless_of_any_vessels_draft() {
        // §6: the artifact stores physical facts, never a vessel's own
        // threshold. build_region does not even take a required_depth_m
        // any more (see its own docs) — this proves the CONSEQUENCE: a
        // charted 1 m DEPARE, which `routing::artifact::constraints`
        // would hard-block for any boat drawing more than 1 m, must
        // never show up as FLAG_HARD_HAZARD here, only as a real
        // depth_min/depth_max value for the query layer to threshold
        // later.
        let extent = small_region_extent();
        let mid = extent.midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let c = cell_of(
            vec![
                area("M_COVR", lat, lon, 800.0, &[("CATCOV", AttrValue::Int(1))]),
                area(
                    "DEPARE",
                    lat,
                    lon,
                    300.0,
                    &[
                        ("drval1", AttrValue::Float(1.0)),
                        ("drval2", AttrValue::Float(1.0)),
                    ],
                ),
            ],
            4_000,
        );
        let built = build_region(&[c], extent, CatzocMode::Off);

        assert!(
            built.report.charted_depth_cells > 0,
            "the DEPARE must be charted"
        );
        assert!(
            built
                .depth_min
                .iter()
                .any(|&d| d != super::super::format::DEPTH_NO_COVERAGE && d < 20),
            "a real ~1 m depth value must be stored"
        );
        // Land/hard-hazard classes still block as normal — this is
        // specifically about a DEPTH gate, not every hazard.
        assert_eq!(
            built.report.blocked_cells, 0,
            "a bare shallow DEPARE must not hard-block at build time"
        );
    }

    #[test]
    fn build_is_deterministic() {
        let extent = small_region_extent();
        let mid = extent.midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let c = cell_of(
            vec![
                area("M_COVR", lat, lon, 800.0, &[("CATCOV", AttrValue::Int(1))]),
                area("LNDARE", lat, lon, 200.0, &[]),
            ],
            4_000,
        );
        let first = build_region(std::slice::from_ref(&c), extent, CatzocMode::Off);
        for _ in 0..2 {
            let again = build_region(std::slice::from_ref(&c), extent, CatzocMode::Off);
            assert_eq!(again.tiles, first.tiles);
            assert_eq!(again.depth_min, first.depth_min);
            assert_eq!(again.depth_max, first.depth_max);
            assert_eq!(again.flags, first.flags);
            assert_eq!(again.stitch, first.stitch);
        }
    }

    #[test]
    fn a_region_bigger_than_one_coarse_tile_gets_several_roots() {
        // COARSEST_RUNG's own tile is huge (1024 m * 256 cells ~ 262 km);
        // force multiple roots with a region several tiles wide instead.
        let l = RegionLattice::for_region(small_region_extent());
        let tw = l.tile_world(COARSEST_RUNG);
        // Grid-ALIGNED bounds: an arbitrary start could straddle a tile
        // boundary and legitimately need one extra row/column, which
        // would make the exact count below a fixture bug, not a real
        // assertion. Aligning removes that ambiguity.
        let aligned_x = i64::from(small_region_extent().xmin).div_euclid(tw) * tw;
        let aligned_y = i64::from(small_region_extent().ymin).div_euclid(tw) * tw;
        let wide = Extent::new(
            aligned_x as i32,
            (aligned_x + 3 * tw) as i32,
            aligned_y as i32,
            (aligned_y + 2 * tw) as i32,
        );
        let roots = root_tiles(&l, wide);
        assert_eq!(roots.len(), 3 * 2);
        let mut seen = std::collections::HashSet::new();
        for r in &roots {
            assert!(
                seen.insert((r.origin_x, r.origin_y)),
                "roots must not repeat"
            );
        }
    }

    #[test]
    fn quadtree_children_exactly_tile_their_parent_with_no_gap_or_overlap() {
        let l = RegionLattice::for_region(small_region_extent());
        let p = lat_lon_to_world(LAT, LON);
        let parent = l.tile_at(COARSEST_RUNG, p.x, p.y);
        let children = quadtree_children(&l, &parent);
        // The anomalous 256->1024 step is a 4x ratio -> 16 children.
        assert_eq!(children.len(), 16);
        let parent_extent = parent.extent();
        let mut covered = Extent::invalid();
        for c in &children {
            assert_eq!(c.rung, parent.rung - 1);
            let ce = c.extent();
            assert!(ce.xmin >= parent_extent.xmin && ce.xmax <= parent_extent.xmax);
            assert!(ce.ymin >= parent_extent.ymin && ce.ymax <= parent_extent.ymax);
            covered.extend(&ce);
        }
        assert_eq!(covered, parent_extent);

        // A non-anomalous step is a clean 2x2 = 4.
        let mid_parent = l.tile_at(4, p.x, p.y);
        assert_eq!(quadtree_children(&l, &mid_parent).len(), 4);
    }

    #[test]
    fn u16_columns_round_trip_little_endian() {
        let bytes = encode_u16_column(&[0, 1, 65535, 300]);
        assert_eq!(bytes.len(), 8);
        let decoded: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(decoded, vec![0, 1, 65535, 300]);
        assert_eq!(decode_u16_column(&bytes, 4), Some(vec![0, 1, 65535, 300]));
    }

    #[test]
    fn a_u16_column_of_the_wrong_length_is_refused_in_both_directions() {
        let bytes = encode_u16_column(&[7, 8, 9]);
        assert_eq!(decode_u16_column(&bytes, 3), Some(vec![7, 8, 9]));
        // Short of what the tile index promised...
        assert_eq!(decode_u16_column(&bytes, 4), None);
        // ...and longer than it, which is just as wrong: a column with
        // an extra value means the writer and the tile index disagree,
        // and every index past the discrepancy would be silently off.
        assert_eq!(decode_u16_column(&bytes, 2), None);
        // An odd byte count can never be a u16 column.
        assert_eq!(decode_u16_column(&bytes[..5], 3), None);
        assert_eq!(decode_u16_column(&[], 0), Some(Vec::new()));
        // A length that would overflow the byte count is refused, not
        // wrapped into an accidental match.
        assert_eq!(decode_u16_column(&bytes, usize::MAX), None);
    }
}
