// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §8.1's navigable connected components, per band, over a whole built
//! region — the first of the topology products (portals/shortcuts follow
//! in later Phase 3 work; this module is components alone).
//!
//! # Connectivity must match the fine search's, or the topology lies
//!
//! [`label_band`] is 8-connected with corner-cut prevention, the IDENTICAL
//! successor rule `routing::artifact::search::astar` already uses (`dx !=
//! 0 && dy != 0` requires both orthogonal neighbours navigable too — see
//! that module's own §4.4 citation). This is not a stylistic match: a
//! topology component is an acceleration structure the query path trusts
//! to say "a route through here is possible" (§8.4). If this module's own
//! connectivity were looser (say, plain 8-connected with no corner-cut
//! check), it could claim two cells are in one component when the fine
//! search, walking the identical grid, would refuse the one diagonal step
//! that actually joins them — a corridor chosen on the strength of that
//! component then fails to route, for a reason nothing about the
//! *topology* would explain. One rule, defined once, used by both.
//!
//! # Cross-tile connectivity reuses the stitch table's OWN pairing
//!
//! [`super::stitch::StitchRun::expand`] is the sole place that turns a
//! run's length ratio back into actual per-cell contacts; this module
//! does not re-derive it. A cross-tile pair is unioned when BOTH sides
//! are independently navigable — no corner-cut check applies to an
//! ordinary [`super::stitch::StitchRun`], because
//! [`super::stitch::compute_stitch`] only ever produces a run for tiles
//! that share a positive-length EDGE (never a bare corner — see that
//! module's own `tiles_that_only_touch_at_a_corner_stitch_nothing`
//! test), so every cross-tile pair from a run is already an ORTHOGONAL
//! contact, the one kind corner-cut prevention never restricts.
//!
//! # Tiles that touch only at a single point need no separate handling
//!
//! Every interior split of a quadtree region produces four same-rung
//! tiles meeting at exactly one point — `compute_stitch` correctly has
//! NO run for the two DIAGONAL pairs there (they share no positive-length
//! edge), which looks at first like a connectivity gap: two navigable
//! diagonal cells with both orthogonal notches also navigable, and
//! nothing in `built.stitch` to join them.
//!
//! It is not a gap, and an earlier draft of this module (caught before
//! landing, not after) added a `compute_corner_contacts`-style direct
//! union for exactly this case before proving it was unnecessary. The
//! proof: call the four tiles `nw`/`ne`/`sw`/`se`. `nw`'s own corner cell
//! (its bottom-right) is ORDINARY-edge-adjacent to `ne`'s own corner cell
//! (its bottom-left) — same row, adjacent tile columns — and `ne`'s
//! corner cell is in turn ordinary-edge-adjacent to `se`'s (same column,
//! adjacent tile rows). So whenever `ne`'s corner cell is navigable, `nw`
//! and `se` are ALREADY joined by two ordinary [`union_stitch_run`] hops
//! through it — with no diagonal step required at all. And whenever it
//! is NOT navigable, the corner-cut rule would refuse the direct diagonal
//! step anyway (`ne` is one of the two notches `nw`-`se` needs). Either
//! way, a direct `nw`-`se` union can never do anything a real diagonal
//! step through the shared sibling has not already done — checked
//! empirically too: `a_diagonal_connects_across_a_quadtree_split_point`
//! below passes with the ordinary within-tile and stitch-run passes
//! ALONE, no corner-specific code involved.
//!
//! # A residual gap this module does not yet close
//!
//! [`bands::navigable`] now excludes a `FLAG_NO_COVERAGE` cell only when
//! its `depth_max` is the `DEPTH_NO_COVERAGE` sentinel — a cell outside
//! every `M_COVR` that STILL carries a real charted `depth_max >= band`
//! (common on the o-charts DK base set, depth bled in from a coarse
//! overview cell) is navigable here, governed by depth rather than the
//! coverage declaration. What is still hard-excluded is genuine
//! uncharted void (the sentinel), with no equivalent of
//! `routing::artifact::search::Field::walkable`'s bounded GRACE for a
//! short such gap (§9.3). Nothing in Phase 3 consumes `Components` yet,
//! so this has no live effect today, but whoever wires it into Phase 4's
//! query path should read this: a real corridor that only exists by
//! crossing a short truly-uncharted gap near an endpoint would appear as
//! two disconnected components here and could be pruned before the fine
//! search — which DOES grace such gaps — ever gets a chance to find it.
//! Reconciling the two belongs to whichever phase actually wires this
//! in, not to a speculative fix now.

use rayon::prelude::*;

use crate::routing::artifact::search::diagonal_step_allowed;
use crate::union_find::UnionFind;

use super::bands::{global_index, navigable_at};
use super::build::BuiltRegion;
use super::field::TileEntry;
use super::format::{BandTag, BAND_TAG_LEN};
use super::stitch::{resolve_run_pair, StitchRun};

/// A cell with no navigable component at this band.
pub const NO_COMPONENT: u32 = u32::MAX;

/// §8.1's per-band navigable connected components over a whole region.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Components {
    /// One entry per cell, in the SAME flat order the SoA columns use
    /// (`tile.payload_offset + tile.index(col, row)`): the cell's
    /// CANONICAL component id, or [`NO_COMPONENT`].
    pub label: Vec<u32>,
    /// Distinct components. Canonical ids are `0..count`, assigned by
    /// ascending lowest-member flat index — §13.1's "canonical, not an
    /// accident of union-find's own internal root order" guarantee,
    /// extended from portals/shortcuts (where the plan states it
    /// explicitly) to components too, since everything downstream is
    /// numbered relative to these ids.
    pub count: u32,
}

/// Build [`Components`] for `band_m` over `built`.
///
/// Peak transient memory is the union-find's `u32` parent column and
/// nothing else: [`canonicalize`] relabels that same column in place and
/// hands it back as [`Components::label`], so a band costs 4 bytes per
/// region cell (it was ~28 with `usize` parents and three separate
/// canonicalize buffers — too much for a national set on a 16 GB box).
pub fn label_band(built: &BuiltRegion, band_m: f64) -> Components {
    // `BuiltRegion`'s fields are all public and hand-constructible (this
    // module's own tests do exactly that) — a mismatched SoA column
    // length is a caller bug, not something a corrupted FILE could ever
    // reach (`build_region` guarantees this itself), so a debug_assert
    // catches it in tests without paying for the check in release.
    debug_assert_eq!(built.flags.len(), built.depth_min.len());
    debug_assert_eq!(built.depth_max.len(), built.depth_min.len());
    let n = built.depth_min.len();
    let mut uf = UnionFind::new(n);

    // Converted exactly ONCE per call, not once per cell — see
    // `bands::navigable`'s own doc comment for why this matters.
    let band_dm = super::bands::band_to_dm(band_m);

    // Within-tile pass, in parallel. A tile's cells occupy the
    // contiguous global range `[payload_offset, payload_offset +
    // cell_count)` (`build_region` writes them as a gap-free partition,
    // and `load_region::check_payload_partition` re-proves it), and
    // `union_within_tile` only ever unions two cells of the SAME tile —
    // so tile `t`'s work touches `parent[t.range]` and nothing else, and
    // the `&mut` sub-slices handed to the workers never alias. Each
    // worker runs the identical path-halving / min-root union this
    // build's serial pass did, on the identical set of pairs in the
    // identical per-tile order, so the merged `parent` column is
    // byte-for-byte what the serial `for tile in &built.tiles` loop
    // produced. The cross-tile `stitch` pass and `canonicalize` below
    // then run on it exactly as before.
    let mut ranges: Vec<(&mut [u32], &TileEntry)> = Vec::with_capacity(built.tiles.len());
    let mut rest: &mut [u32] = uf.parent_mut();
    let mut cursor = 0usize;
    for tile in &built.tiles {
        // `build::finish` assigns `payload_offset` while concatenating
        // the SoA columns in this same tile order, so the ranges line up
        // by construction. A hand-built test region that violates it
        // trips here rather than silently unioning the wrong cells —
        // same "caller bug, caught in tests" stance as the length
        // `debug_assert`s above.
        debug_assert_eq!(cursor as u64, tile.payload_offset);
        let (head, tail) = std::mem::take(&mut rest).split_at_mut(tile.cell_count());
        ranges.push((head, tile));
        rest = tail;
        cursor += tile.cell_count();
    }
    ranges.into_par_iter().for_each(|(range, tile)| {
        let base = tile.payload_offset as usize;
        union_within_tile(
            |a, b| slice_union(range, base, a, b),
            tile,
            &built.flags,
            &built.depth_max,
            band_dm,
        );
    });

    // Every undirected tile-pair contact appears twice in `built.stitch`
    // (once emitted from each side — `stitch.rs`'s own documented
    // judgment call). Processing both is redundant work, not a
    // correctness risk: union is idempotent.
    for run in &built.stitch {
        union_stitch_run(&mut uf, built, run, band_dm);
    }
    // No third pass for tiles that touch only at a point — see the
    // module docs for the proof that ordinary edge stitching through
    // the shared orthogonal sibling already covers it.

    canonicalize(uf, &built.flags, &built.depth_max, band_dm)
}

// ---------------------------------------------------------------------------
// Within-tile pass
// ---------------------------------------------------------------------------

/// The four directions that cover every undirected 8-connected pair
/// exactly once: each cell's own turn as "here" reaches its EAST, SOUTH,
/// SOUTH-EAST and SOUTH-WEST neighbours, and every WEST/NORTH pair is
/// covered when the mirror cell takes its own turn. Same shape as
/// `routing::artifact::search`'s dense fill passes, which walk rows
/// top-to-bottom for the identical reason.
const FORWARD_DIRS: [(i64, i64); 4] = [(1, 0), (0, 1), (1, 1), (-1, 1)];

/// [`UnionFind::find`], byte-for-byte, over one tile's contiguous slice
/// of the global `parent` column. `slice[i - base]` holds cell `i`'s
/// parent (a global index); path halving and the loop are identical to
/// the shared implementation, only the indexing is offset. Kept in step
/// with [`crate::union_find`] by [`slice_matches_unionfind`] in the
/// tests below.
fn slice_find(parent: &mut [u32], base: usize, mut x: usize) -> usize {
    while parent[x - base] as usize != x {
        parent[x - base] = parent[parent[x - base] as usize - base];
        x = parent[x - base] as usize;
    }
    x
}

/// [`UnionFind::union`], byte-for-byte, over one tile's slice — the
/// larger root always attaches under the smaller, so the merged column
/// is independent of which order the tiles' workers finished in.
fn slice_union(parent: &mut [u32], base: usize, a: usize, b: usize) {
    let (ra, rb) = (slice_find(parent, base, a), slice_find(parent, base, b));
    if ra != rb {
        parent[ra.max(rb) - base] = ra.min(rb) as u32;
    }
}

/// 8-connect one tile's navigable cells (corner-cut prevented, matching
/// the fine search — see the module docs), calling `union(here, there)`
/// for each joined pair. `union` is a closure so the serial whole-region
/// `UnionFind` and the parallel per-tile `slice_union` share this body.
fn union_within_tile(
    mut union: impl FnMut(usize, usize),
    tile: &TileEntry,
    flags: &[u8],
    depth_max: &[u16],
    band_dm: u16,
) {
    let cols = tile.cols as usize;
    let rows = tile.rows as usize;
    // Precomputed once: the corner-cut check below would otherwise
    // recompute EAST/SOUTH's own `navigable_at` a second time as the
    // SE/SW diagonal's own notch — a plain array read replaces the
    // flag/depth lookup and float divide `navigable_at` does, for every
    // cell touched twice in the same pass.
    let mut grid = vec![false; cols * rows];
    for row in 0..rows {
        for col in 0..cols {
            let g = global_index(tile, col as u32, row as u32);
            grid[tile.index(col as u32, row as u32)] = navigable_at(flags, depth_max, g, band_dm);
        }
    }
    let at = |c: i64, r: i64| -> bool {
        c >= 0
            && r >= 0
            && (c as usize) < cols
            && (r as usize) < rows
            && grid[tile.index(c as u32, r as u32)]
    };
    for row in 0..rows as i64 {
        for col in 0..cols as i64 {
            if !at(col, row) {
                continue;
            }
            let here = global_index(tile, col as u32, row as u32);
            for &(dx, dy) in &FORWARD_DIRS {
                let (nc, nr) = (col + dx, row + dy);
                if !at(nc, nr) {
                    continue;
                }
                if !diagonal_step_allowed(dx != 0 && dy != 0, at(col + dx, row), at(col, row + dy))
                {
                    continue;
                }
                let there = global_index(tile, nc as u32, nr as u32);
                union(here, there);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Cross-tile pass — shared edges
// ---------------------------------------------------------------------------

fn union_stitch_run(uf: &mut UnionFind, built: &BuiltRegion, run: &StitchRun, band_dm: u16) {
    let Some(tile) = built.tiles.get(run.tile as usize) else {
        return;
    };
    let Some(neighbour) = built.tiles.get(run.neighbour_tile as usize) else {
        return;
    };
    let neighbour_side = run.side.opposite();
    for (a_idx, b_idx) in run.expand() {
        // `resolve_run_pair` is the one place this bounds check lives —
        // a corrupted or version-skewed file must not panic deep inside
        // a union-find loop, and [`super::portals::detect_portals`]
        // needs the identical defence, not a second copy of it.
        let Some((a, b)) =
            resolve_run_pair(tile, run.side, neighbour, neighbour_side, a_idx, b_idx)
        else {
            continue;
        };
        if navigable_at(&built.flags, &built.depth_max, a, band_dm)
            && navigable_at(&built.flags, &built.depth_max, b, band_dm)
        {
            uf.union(a, b);
        }
    }
}

// ---------------------------------------------------------------------------
// Canonical numbering
// ---------------------------------------------------------------------------

/// Relabel the union-find's parent column, IN PLACE, into canonical
/// component ids: ascending by each component's smallest member index
/// (§13.1's "canonical, not an accident of build order").
///
/// Two invariants of [`UnionFind`]'s min-root union with path halving
/// make this one serial ascending pass with no `find` and no extra
/// buffer: a component's root IS its smallest member, and every parent
/// pointer goes to a smaller index (`parent[i] <= i`). So when the sweep
/// reaches cell `i`, its parent `p < i` has already been overwritten with
/// its component id (`p` is a member of the same component, hence
/// navigable), and a root (`p == i`) is the first cell of its component
/// the sweep sees — the next id. Blocked cells were never unioned, so
/// nothing points at them and they can be overwritten with
/// [`NO_COMPONENT`] freely. Ids come out identical to the earlier
/// root-gather-and-sort version, which [`canonicalize_matches_the_sort_
/// based_reference`] pins.
fn canonicalize(uf: UnionFind, flags: &[u8], depth_max: &[u16], band_dm: u16) -> Components {
    let mut label = uf.into_parent();
    let mut count: u32 = 0;
    for i in 0..label.len() {
        if !navigable_at(flags, depth_max, i, band_dm) {
            label[i] = NO_COMPONENT;
            continue;
        }
        let p = label[i] as usize;
        if p == i {
            label[i] = count;
            count += 1;
        } else {
            debug_assert!(p < i, "parent pointer {p} not below {i}");
            label[i] = label[p];
        }
    }
    Components { label, count }
}

// ---------------------------------------------------------------------------
// §8.1's on-disk form — SectionKind::Components, one section per band
// ---------------------------------------------------------------------------

/// Bytes per run record in a [`Components`] payload: `label`, `length`.
pub const COMPONENT_RUN_LEN: usize = 8;

/// Fixed header length of a [`super::format::SectionKind::Components`]
/// payload — [`BandTag`] plus the run table's own header.
const COMPONENTS_HEADER_LEN: usize = BAND_TAG_LEN + 24;

/// Serialize `components` as the per-band
/// [`super::format::SectionKind::Components`] payload for `tag`'s band.
///
/// ```text
/// off  len  field
///   0    8  BandTag           which band this labelling is for
///   8    8  cell_count   u64  labels; the runs must expand to EXACTLY this
///  16    4  count        u32  Components::count (distinct components)
///  20    4  run_stride   u32  bytes per run record (COMPONENT_RUN_LEN today)
///  24    8  run_count    u64
///  32  ...  runs: label u32, length u32   (length is never 0)
/// ```
///
/// # Why run-length, when `DepthMin`/`DepthMax` are a flat SoA column
///
/// The obvious encoding — one `u32` per cell, mirroring
/// [`super::build::encode_u16_column`] — costs 4 bytes per cell **per
/// band**, and there are ten bands ([`super::field::BAND_LADDER_M`]).
/// That is 40 bytes per cell of components against the 5 bytes per cell
/// the whole spatial field costs (`u16` + `u16` + `u8`): the labelling
/// would be eight times the size of the thing it labels, in a file §5.3
/// already sizes in gigabytes.
///
/// A component labelling is also the most run-friendly product in the
/// artifact. Cells are stored tile by tile in row-major order, and within
/// a tile a whole row is typically one component or [`NO_COMPONENT`] end
/// to end — open water, or ground no chart reaches. On the real DE6OSTIM
/// region this encoding is measured at a small fraction of the flat
/// column's size (see `tests/mivnav_persist_de6ostim.rs`, which computes
/// and asserts the real ratio rather than trusting this paragraph).
///
/// What it costs: the flat column could one day be read zero-copy out of
/// an mmap (this module tree's stated aspiration — see
/// [`super::format`]'s own docs), and a run-length column cannot; it has
/// to be expanded into an owned `Vec<u32>`. That trade is deliberate and
/// one-directional for now — nothing reads components zero-copy today,
/// the expansion is a single linear pass, and an artifact eight times
/// larger than it needs to be is a cost paid on every build, every copy
/// and every page fault on the boat's Pi.
pub fn encode_components(tag: BandTag, components: &Components) -> Vec<u8> {
    // `decode_components` refuses a label that is neither NO_COMPONENT
    // nor below `count`, so encoding one would produce a payload this
    // crate's own decoder rejects — a build-time bug surfacing as a
    // mystery `None` at load time, a long way from its cause.
    // `canonicalize` always satisfies this, so a debug assertion is the
    // right cost: unreachable from the build path, caught in tests if
    // that ever stops being true. (Found by code review.)
    debug_assert!(
        components
            .label
            .iter()
            .all(|&l| l == NO_COMPONENT || l < components.count),
        "a label must be NO_COMPONENT or below count"
    );
    let mut out = Vec::with_capacity(COMPONENTS_HEADER_LEN + 64 * COMPONENT_RUN_LEN);
    out.extend_from_slice(&tag.to_bytes());
    out.extend_from_slice(&(components.label.len() as u64).to_le_bytes());
    out.extend_from_slice(&components.count.to_le_bytes());
    out.extend_from_slice(&(COMPONENT_RUN_LEN as u32).to_le_bytes());
    let run_count_at = out.len();
    out.extend_from_slice(&0u64.to_le_bytes()); // patched below

    let mut run_count: u64 = 0;
    let mut push_run = |out: &mut Vec<u8>, label: u32, length: u32| {
        out.extend_from_slice(&label.to_le_bytes());
        out.extend_from_slice(&length.to_le_bytes());
        run_count += 1;
    };
    let mut iter = components.label.iter().copied();
    if let Some(first) = iter.next() {
        let mut label = first;
        let mut length: u32 = 1;
        for value in iter {
            // A run longer than `u32::MAX` cells simply becomes two runs
            // — the decoder joins them back into identical labels and
            // never sees the difference. Only a >4-billion-cell region
            // can reach this, but a silent wrap here would corrupt every
            // label after it.
            if value == label && length < u32::MAX {
                length += 1;
            } else {
                push_run(&mut out, label, length);
                label = value;
                length = 1;
            }
        }
        push_run(&mut out, label, length);
    }
    out[run_count_at..run_count_at + 8].copy_from_slice(&run_count.to_le_bytes());
    out
}

/// Parse a per-band [`Components`] payload, expanding the runs.
///
/// `expected_cells` is the region's own cell count — the sum of every
/// [`super::field::TileEntry::cell_count`] in the tile index the same
/// artifact carries. It is a REQUIRED argument, not a convenience:
///
/// 1. It bounds the allocation. `cell_count` is a `u64` read straight off
///    an untrusted file, and reserving from it would let a two-byte edit
///    turn opening an artifact into a multi-gigabyte allocation. Nothing
///    here ever allocates more than `expected_cells` labels. That makes
///    `expected_cells` itself the number a caller must not take from
///    untrusted bytes unchecked — [`super::persist::load_band`] cross-
///    checks it against an already-materialised column length before
///    passing it, which is what actually bounds it in practice.
/// 2. It cross-checks two sections against each other. A `Components`
///    section that does not describe the same number of cells as this
///    file's own tile index is not usable at all — every index into
///    `label` is a flat SoA index shared with `depth_min`/`flags` — and
///    catching that here is the difference between a `None` and a
///    silently misaligned labelling that reports the wrong component for
///    every cell after the first discrepancy.
///
/// `None` on any structural problem: short header, a stride below
/// [`COMPONENT_RUN_LEN`], a truncated run table, a zero-length run, runs
/// that do not expand to exactly `expected_cells`, or a label that is
/// neither [`NO_COMPONENT`] nor below the payload's own `count`.
pub fn decode_components(bytes: &[u8], expected_cells: usize) -> Option<Components> {
    let head = bytes.get(..COMPONENTS_HEADER_LEN)?;
    let cell_count = u64::from_le_bytes(head[8..16].try_into().unwrap());
    let count = u32::from_le_bytes(head[16..20].try_into().unwrap());
    let run_stride = u32::from_le_bytes(head[20..24].try_into().unwrap()) as usize;
    let run_count = u64::from_le_bytes(head[24..32].try_into().unwrap());

    if cell_count != expected_cells as u64 {
        return None;
    }
    if run_stride < COMPONENT_RUN_LEN {
        return None;
    }
    // Checked BEFORE the loop, so `run_count` from a corrupted file can
    // never drive an unbounded walk (or an unbounded `with_capacity`).
    let run_count = usize::try_from(run_count).ok()?;
    let need = run_count
        .checked_mul(run_stride)?
        .checked_add(COMPONENTS_HEADER_LEN)?;
    if bytes.len() < need {
        return None;
    }

    let mut label = Vec::with_capacity(expected_cells);
    for i in 0..run_count {
        let at = COMPONENTS_HEADER_LEN + i * run_stride;
        let r = &bytes[at..at + COMPONENT_RUN_LEN];
        let value = u32::from_le_bytes(r[0..4].try_into().unwrap());
        let length = u32::from_le_bytes(r[4..8].try_into().unwrap()) as usize;
        if length == 0 {
            return None;
        }
        if value != NO_COMPONENT && value >= count {
            return None;
        }
        // Bounded by `expected_cells` at every step: a run claiming more
        // cells than the region has is refused here rather than after
        // allocating for it.
        if length > expected_cells - label.len() {
            return None;
        }
        label.resize(label.len() + length, value);
    }
    if label.len() != expected_cells {
        return None;
    }
    Some(Components { label, count })
}

/// [`decode_components`] without materialising the per-cell `label`
/// column: the same header and run-table validation (cell count, run
/// stride, every run's length and value), but the result carries only
/// `count` and an EMPTY `label`. For the query side, which reads a band's
/// component count for diagnostics and never a per-cell label — expanding
/// it cost 4 bytes per region cell per cached band (~3.9 GB per band on
/// the national DK artifact).
pub fn decode_components_count(bytes: &[u8], expected_cells: usize) -> Option<Components> {
    let head = bytes.get(..COMPONENTS_HEADER_LEN)?;
    let cell_count = u64::from_le_bytes(head[8..16].try_into().unwrap());
    let count = u32::from_le_bytes(head[16..20].try_into().unwrap());
    let run_stride = u32::from_le_bytes(head[20..24].try_into().unwrap()) as usize;
    let run_count = u64::from_le_bytes(head[24..32].try_into().unwrap());
    if cell_count != expected_cells as u64 || run_stride < COMPONENT_RUN_LEN {
        return None;
    }
    let run_count = usize::try_from(run_count).ok()?;
    let need = run_count
        .checked_mul(run_stride)?
        .checked_add(COMPONENTS_HEADER_LEN)?;
    if bytes.len() < need {
        return None;
    }
    let mut covered = 0usize;
    for i in 0..run_count {
        let at = COMPONENTS_HEADER_LEN + i * run_stride;
        let r = &bytes[at..at + COMPONENT_RUN_LEN];
        let value = u32::from_le_bytes(r[0..4].try_into().unwrap());
        let length = u32::from_le_bytes(r[4..8].try_into().unwrap()) as usize;
        if length == 0 || (value != NO_COMPONENT && value >= count) {
            return None;
        }
        if length > expected_cells - covered {
            return None;
        }
        covered += length;
    }
    (covered == expected_cells).then_some(Components {
        label: Vec::new(),
        count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{lat_lon_to_world, Extent};
    use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry, Polygon};
    use crate::routing::artifact::CatzocMode;
    use std::collections::BTreeMap;

    const LAT: f64 = 54.0;
    const LON: f64 = 11.0;

    fn small_region_extent() -> Extent {
        Extent::new(
            lat_lon_to_world(LAT, LON - 0.01).x,
            lat_lon_to_world(LAT, LON + 0.01).x,
            lat_lon_to_world(LAT + 0.01, LON).y,
            lat_lon_to_world(LAT - 0.01, LON).y,
        )
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

    /// Open water everywhere covered, plus one square LNDARE blocking
    /// obstruction near the middle — the shared fixture for the tests
    /// below, so each just adjusts the obstruction's placement/size.
    fn built_with_obstruction(half_land_m: f64, offset_m: f64) -> BuiltRegion {
        let extent = small_region_extent();
        let mid = extent.midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let dlon = offset_m / (111_320.0 * lat.to_radians().cos());
        // Coverage AND a background depth statement always both exist —
        // LNDARE, when present, is carved out of otherwise-charted
        // water, not a replacement for it. Without the DEPARE, every
        // clear-water cell would read as the DEPTH_NO_COVERAGE sentinel
        // (no depth statement reaches it) and `navigable`'s own
        // defensive check would exclude it — the fixture's own bug the
        // first draft of these tests hit, not a real logic bug.
        let mut features = vec![
            area("M_COVR", lat, lon, 900.0, &[("CATCOV", AttrValue::Int(1))]),
            area(
                "DEPARE",
                lat,
                lon,
                900.0,
                &[
                    ("drval1", AttrValue::Float(20.0)),
                    ("drval2", AttrValue::Float(30.0)),
                ],
            ),
        ];
        if half_land_m > 0.0 {
            features.push(area("LNDARE", lat, lon + dlon, half_land_m, &[]));
        }
        let c = cell_of(features, 4_000);
        super::super::build::build_region(&[c], extent, CatzocMode::Off)
    }

    #[test]
    fn open_water_with_no_obstruction_is_one_component() {
        let built = built_with_obstruction(0.0, 0.0);
        let comps = label_band(&built, 5.0);
        assert_eq!(comps.count, 1);
        let any_navigable = comps.label.iter().any(|&l| l != NO_COMPONENT);
        assert!(any_navigable);
        for (i, &lbl) in comps.label.iter().enumerate() {
            if navigable_at(
                &built.flags,
                &built.depth_max,
                i,
                crate::mivnav::bands::band_to_dm(5.0),
            ) {
                assert_eq!(lbl, 0, "every navigable cell must share the one component");
            } else {
                assert_eq!(lbl, NO_COMPONENT);
            }
        }
    }

    #[test]
    fn a_wall_spanning_the_whole_region_splits_it_into_two_components() {
        // A wide, thin LNDARE strip crossing the whole region east-west,
        // wider than the region's own coverage so it truly spans it
        // (not a square big enough to be square in BOTH axes, which
        // would just engulf the whole covered area and leave nothing
        // navigable at all).
        let extent = small_region_extent();
        let mid = extent.midpoint();
        let (lat, lon) = (
            crate::coords::worldy_to_lat(mid.y),
            crate::coords::worldx_to_lon(mid.x),
        );
        let dlat = 50.0 / 111_320.0;
        let dlon = 2000.0 / (111_320.0 * lat.to_radians().cos());
        let corners = [
            lat_lon_to_world(lat - dlat, lon - dlon),
            lat_lon_to_world(lat - dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon - dlon),
        ];
        let wall = feature(
            "LNDARE",
            &[],
            Geometry::Areas(vec![Polygon {
                outer: corners.to_vec(),
                holes: vec![],
            }]),
        );
        // A bare AREA-shaped LNDARE fires none of §4.3's triggers on its
        // own — `tile_triggers`'s blocking-line check requires LINE
        // geometry (`field.rs`'s own `is_blocking_line_feature`), which a
        // real chart satisfies via a companion COALNE coastline, not via
        // LNDARE's own area. Without it this fixture stays at the
        // coarsest rung and the wall barely registers at all — a real
        // gotcha this test itself hit before this comment existed.
        let coastline = feature(
            "COALNE",
            &[],
            Geometry::Lines(vec![
                vec![corners[0], corners[1]],
                vec![corners[2], corners[3]],
            ]),
        );
        let c = cell_of(
            vec![
                area("M_COVR", lat, lon, 900.0, &[("CATCOV", AttrValue::Int(1))]),
                area(
                    "DEPARE",
                    lat,
                    lon,
                    900.0,
                    &[
                        ("drval1", AttrValue::Float(20.0)),
                        ("drval2", AttrValue::Float(30.0)),
                    ],
                ),
                wall,
                coastline,
            ],
            4_000,
        );
        let built = super::super::build::build_region(&[c], extent, CatzocMode::Off);
        let comps = label_band(&built, 5.0);
        assert_eq!(comps.count, 2, "a full-span wall must split the region");
    }

    /// A 3x3 single-tile `BuiltRegion` with `land` marking which cells
    /// are `FLAG_LAND` and everything else clear water at a real depth —
    /// enough to hand-place an exact diagonal checkerboard, which no
    /// real chart fixture can guarantee at a specific cell boundary.
    fn tiny_hand_built_tile(land: &[(u32, u32)]) -> BuiltRegion {
        use super::super::field::TileEntry;
        use super::super::format::FLAG_LAND;
        let tile = TileEntry {
            origin_x: 0,
            origin_y: 0,
            cell_world: 100,
            rung: 0,
            tile_flags: 0,
            cols: 3,
            rows: 3,
            triggers: 0,
            payload_offset: 0,
        };
        let n = tile.cell_count();
        let mut flags = vec![0u8; n];
        for &(c, r) in land {
            flags[tile.index(c, r)] = FLAG_LAND;
        }
        BuiltRegion {
            tiles: vec![tile],
            depth_min: vec![50u16; n],
            depth_max: vec![100u16; n],
            flags,
            stitch: vec![],
            report: Default::default(),
        }
    }

    #[test]
    fn a_diagonal_step_across_two_blocked_notches_is_refused() {
        // (0,0) and (1,1) touch only at a corner; BOTH orthogonal
        // notches, (1,0) and (0,1), are land — the exact shape
        // `routing::artifact::search::astar`'s own corner-cut rule
        // exists for, mirrored here.
        let built = tiny_hand_built_tile(&[(1, 0), (0, 1)]);
        let comps = label_band(&built, 1.0);
        let a = global_index(&built.tiles[0], 0, 0);
        let b = global_index(&built.tiles[0], 1, 1);
        assert_ne!(
            comps.label[a], comps.label[b],
            "a diagonal step must not slip between two blocked notches"
        );
    }

    #[test]
    fn the_same_diagonal_joins_once_a_notch_opens() {
        // Identical layout, but only ONE notch is land — real diagonal
        // connectivity (not a corner squeeze) must still join them, so
        // this is not testing "diagonals never connect", only "corners
        // don't get cut".
        let built = tiny_hand_built_tile(&[(1, 0)]);
        let comps = label_band(&built, 1.0);
        let a = global_index(&built.tiles[0], 0, 0);
        let b = global_index(&built.tiles[0], 1, 1);
        assert_eq!(
            comps.label[a], comps.label[b],
            "with one notch clear this is a normal, permitted diagonal step"
        );
    }

    #[test]
    fn cross_tile_same_rung_boundary_cells_join_one_component() {
        // Build two independent single-tile regions and confirm the
        // shared union-find/stitch machinery, driven directly rather
        // than through build_region, joins a matching pair of navigable
        // boundary cells into one component.
        use super::super::field::{RegionLattice, TILE_CELLS};
        use super::super::stitch::compute_stitch;
        let l = RegionLattice::for_region(small_region_extent());
        let p = lat_lon_to_world(LAT, LON);
        let west = l.tile_at(3, p.x, p.y);
        let east = l.tile_at(
            3,
            west.origin_x + i32::from(west.cols) * west.cell_world,
            p.y,
        );
        let n = west.cell_count();
        let cells = TILE_CELLS as u16;
        assert_eq!(cells, west.cols);

        let mut west_t = west;
        west_t.payload_offset = 0;
        let mut east_t = east;
        east_t.payload_offset = n as u64;

        let flags = vec![0u8; n * 2]; // all clear water
        let depth_max = vec![100u16; n * 2]; // 10.0 m everywhere

        let stitch = compute_stitch(&[west_t, east_t]);
        assert!(!stitch.is_empty());

        let built = BuiltRegion {
            tiles: vec![west_t, east_t],
            depth_min: vec![50u16; n * 2],
            depth_max,
            flags,
            stitch,
            report: Default::default(),
        };
        let comps = label_band(&built, 5.0);
        assert_eq!(
            comps.count, 1,
            "clear water on both sides of a stitched seam must join"
        );
    }

    #[test]
    fn labeling_is_deterministic_across_repeated_runs() {
        let built = built_with_obstruction(300.0, 200.0);
        let first = label_band(&built, 3.0);
        for _ in 0..2 {
            assert_eq!(label_band(&built, 3.0), first);
        }
    }

    #[test]
    fn the_parallel_within_tile_pass_labels_identically_every_run() {
        // `label_band`'s within-tile union pass runs one worker per tile
        // over disjoint `parent` sub-slices. Four hand-built tiles is
        // enough for `rayon` to actually spread the work; a data race in
        // the split would show up as an occasional different labelling,
        // so run it enough times to make that unlikely to hide.
        let built = quadrants_meeting_at_a_point(&[]);
        assert!(built.tiles.len() == 4);
        let reference = label_band(&built, 3.0);
        for _ in 0..80 {
            assert_eq!(label_band(&built, 3.0), reference);
        }
    }

    #[test]
    fn slice_union_and_slice_find_match_the_shared_unionfind() {
        // `slice_find` / `slice_union` are a hand copy of
        // `crate::union_find::UnionFind`'s own path-halving + min-root
        // logic, offset by a base index. Drive both with the identical
        // call sequence and confirm every element resolves to the same
        // root, so the copy cannot silently drift from the original.
        let n = 200usize;
        let base = 1_000_000usize; // a tile that does not start at 0
        let pairs = [
            (5, 9),
            (9, 5),
            (0, 199),
            (100, 50),
            (50, 51),
            (51, 52),
            (199, 100),
            (7, 7),
            (12, 40),
            (40, 12),
            (198, 3),
        ];

        let mut reference = UnionFind::new(n);
        for &(a, b) in &pairs {
            reference.union(a, b);
        }

        let mut slice: Vec<u32> = (base as u32..(base + n) as u32).collect();
        for &(a, b) in &pairs {
            slice_union(&mut slice, base, base + a, base + b);
        }

        for i in 0..n {
            assert_eq!(
                slice_find(&mut slice, base, base + i) - base,
                reference.find(i),
                "element {i} resolves to a different root than the shared UnionFind"
            );
        }
    }

    /// The pre-in-place `canonicalize`: gather each component's root and
    /// smallest member, sort roots by it, then label through a root→id
    /// map. Kept only as the reference the in-place relabel must match.
    fn sort_based_reference(built: &BuiltRegion, band_m: f64) -> Components {
        let band_dm = super::super::bands::band_to_dm(band_m);
        let n = built.depth_min.len();
        let mut uf = UnionFind::new(n);
        for tile in &built.tiles {
            union_within_tile(
                |a, b| uf.union(a, b),
                tile,
                &built.flags,
                &built.depth_max,
                band_dm,
            );
        }
        for run in &built.stitch {
            union_stitch_run(&mut uf, built, run, band_dm);
        }
        let mut min_by_root = vec![u32::MAX; n];
        let mut root_of = vec![NO_COMPONENT; n];
        for i in 0..n {
            if !navigable_at(&built.flags, &built.depth_max, i, band_dm) {
                continue;
            }
            let r = uf.find(i);
            root_of[i] = r as u32;
            min_by_root[r] = min_by_root[r].min(i as u32);
        }
        let mut roots: Vec<usize> = (0..n).filter(|&r| min_by_root[r] != u32::MAX).collect();
        roots.sort_by_key(|&r| min_by_root[r]);
        let mut canon = vec![NO_COMPONENT; n];
        for (id, &r) in roots.iter().enumerate() {
            canon[r] = id as u32;
        }
        let label = root_of
            .iter()
            .map(|&r| {
                if r == NO_COMPONENT {
                    NO_COMPONENT
                } else {
                    canon[r as usize]
                }
            })
            .collect();
        Components {
            label,
            count: roots.len() as u32,
        }
    }

    #[test]
    fn canonicalize_matches_the_sort_based_reference() {
        // Several shapes (multi-tile stitching, blocked quadrants, an
        // obstruction splitting water) across the band ladder, including
        // bands where everything or nothing is navigable.
        let regions = [
            quadrants_meeting_at_a_point(&[]),
            quadrants_meeting_at_a_point(&["nw"]),
            quadrants_meeting_at_a_point(&["ne", "sw"]),
            built_with_obstruction(0.0, 0.0),
        ];
        for built in &regions {
            for &band_m in super::super::field::BAND_LADDER_M.iter() {
                assert_eq!(
                    label_band(built, band_m),
                    sort_based_reference(built, band_m),
                    "band {band_m}"
                );
            }
        }
    }

    #[test]
    fn a_coarser_band_is_never_more_connected_than_a_finer_one_here() {
        // Not a general theorem about arbitrary charts, but true for
        // this fixture: the same DEPARE gives every clear cell the same
        // depth, so raising the band only ever turns navigable cells
        // into blocked ones, never the reverse — component COUNT can
        // only grow or stay level as the band rises here.
        let built = built_with_obstruction(0.0, 0.0);
        let shallow = label_band(&built, 1.0);
        let deep = label_band(&built, 25.0);
        assert!(deep.count >= shallow.count);
    }

    /// Four same-rung, single-tile-each quadrants meeting at one point —
    /// the shape `compute_stitch` gives no direct run for between the two
    /// DIAGONAL pairs (see the module docs' proof that this needs no
    /// separate handling). `blocked` names which of the four tiles (by
    /// role: nw/ne/sw/se) is entirely `FLAG_LAND`; everything else is
    /// clear water at a real depth.
    fn quadrants_meeting_at_a_point(blocked: &[&str]) -> BuiltRegion {
        use super::super::format::FLAG_LAND;
        use super::super::stitch::compute_stitch;
        let mk = |dx: i32, dy: i32, offset: u64| TileEntry {
            origin_x: dx * 200,
            origin_y: dy * 200,
            cell_world: 100,
            rung: 0,
            tile_flags: 0,
            cols: 2,
            rows: 2,
            triggers: 0,
            payload_offset: offset,
        };
        let named = [
            ("nw", mk(0, 0, 0)),
            ("ne", mk(1, 0, 4)),
            ("sw", mk(0, 1, 8)),
            ("se", mk(1, 1, 12)),
        ];
        let n = 16;
        let mut flags = vec![0u8; n];
        for (name, tile) in &named {
            if blocked.contains(name) {
                for i in 0..4 {
                    flags[tile.payload_offset as usize + i] = FLAG_LAND;
                }
            }
        }
        let tiles: Vec<TileEntry> = named.iter().map(|&(_, t)| t).collect();
        let stitch = compute_stitch(&tiles);
        BuiltRegion {
            tiles,
            depth_min: vec![50u16; n],
            depth_max: vec![100u16; n],
            flags,
            stitch,
            report: Default::default(),
        }
    }

    #[test]
    fn a_diagonal_connects_across_a_quadtree_split_point() {
        // The claim the module docs prove: NO corner-specific code is
        // needed here — `union_within_tile` and `union_stitch_run` ALONE
        // (this test calls nothing else) already join every cell in an
        // open crossroads, because nw-se and ne-sw are each bridged by
        // two ordinary edge hops through the shared orthogonal sibling.
        let built = quadrants_meeting_at_a_point(&[]);
        let comps = label_band(&built, 1.0);
        assert_eq!(comps.count, 1, "an open crossroads must be one component");
    }

    #[test]
    fn blocking_one_whole_bridging_tile_still_connects_through_the_other() {
        // `ne` entirely land: nw-se can no longer bridge through it, but
        // `sw` is still open and bridges them just as well — ordinary
        // edge connectivity is resilient to losing ONE of the two
        // possible bridges, not just tolerant of a fully open crossroads.
        let built = quadrants_meeting_at_a_point(&["ne"]);
        let comps = label_band(&built, 1.0);
        let nw = global_index(&built.tiles[0], 1, 1);
        let se = global_index(&built.tiles[3], 0, 0);
        assert_eq!(
            comps.label[nw], comps.label[se],
            "nw and se must still connect via sw when ne alone is blocked"
        );
    }

    #[test]
    fn blocking_both_bridging_tiles_genuinely_disconnects_the_diagonal() {
        // With BOTH `ne` and `sw` blocked there is no bridge left at
        // all — nw and se must end up in different components. This is
        // ordinary within-tile/edge disconnection, not a corner-cut
        // case: with both notches gone there is nothing left to squeeze
        // past even if a direct diagonal union existed.
        let built = quadrants_meeting_at_a_point(&["ne", "sw"]);
        let comps = label_band(&built, 1.0);
        let nw = global_index(&built.tiles[0], 1, 1);
        let se = global_index(&built.tiles[3], 0, 0);
        assert_ne!(comps.label[nw], comps.label[se]);
    }

    // -----------------------------------------------------------------
    // §8.1's on-disk form
    // -----------------------------------------------------------------

    fn tag() -> BandTag {
        BandTag {
            band_index: 4,
            band_dm: 30,
        }
    }

    fn round_trip(label: Vec<u32>, count: u32) {
        let n = label.len();
        let c = Components { label, count };
        let bytes = encode_components(tag(), &c);
        assert_eq!(BandTag::parse(&bytes), Some(tag()));
        assert_eq!(decode_components(&bytes, n), Some(c));
    }

    #[test]
    fn components_round_trip_through_their_run_length_payload() {
        round_trip(Vec::new(), 0);
        round_trip(vec![NO_COMPONENT], 0);
        round_trip(vec![0, 0, 0, 1, 1, NO_COMPONENT, 0], 2);
        // Alternating labels — the worst case for a run encoding, and
        // the one that must still be exact rather than merely compact.
        round_trip((0..64).map(|i| i % 2).collect(), 2);
        // A long uniform run, which is the case the encoding exists for.
        round_trip(vec![NO_COMPONENT; 10_000], 0);
    }

    #[test]
    fn a_run_length_payload_beats_a_flat_column_on_realistic_labelling() {
        // Not a claim about arbitrary input — see `encode_components`'
        // own docs and the real-chart measurement in
        // `tests/mivnav_persist_de6ostim.rs`. This pins the mechanism on
        // a labelling shaped like a real one: long uniform stretches of
        // water and of no-coverage ground.
        let mut label = vec![NO_COMPONENT; 4096];
        label[1000..3000].fill(0);
        let n = label.len();
        let bytes = encode_components(tag(), &Components { label, count: 1 });
        assert!(
            bytes.len() * 8 < n * 4,
            "{} bytes for {} cells is not a win over a flat u32 column",
            bytes.len(),
            n
        );
    }

    #[test]
    fn a_malformed_components_payload_is_refused_and_never_panics() {
        let good = encode_components(
            tag(),
            &Components {
                label: vec![0, 0, NO_COMPONENT, 1],
                count: 2,
            },
        );
        assert!(decode_components(&good, 4).is_some());

        // Every truncation of a valid payload, byte by byte: none may
        // panic, and none may decode as if it were whole.
        for len in 0..good.len() {
            assert_eq!(decode_components(&good[..len], 4), None, "len {len}");
        }
        // A cell count that disagrees with the tile index is refused in
        // both directions — this is the cross-section check, and it is
        // the difference between "no" and a labelling silently offset
        // against `depth_min`/`flags` from the first discrepancy on.
        assert_eq!(decode_components(&good, 3), None);
        assert_eq!(decode_components(&good, 5), None);
        assert_eq!(decode_components(&good, 0), None);

        // A zero-length run would let a payload claim any number of runs
        // without ever advancing — refused.
        let mut zero_run = good.clone();
        zero_run[COMPONENTS_HEADER_LEN + 4..COMPONENTS_HEADER_LEN + 8]
            .copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode_components(&zero_run, 4), None);

        // A run longer than the region — the case that would otherwise
        // expand into an allocation bounded only by the file's own u32.
        let mut huge_run = good.clone();
        huge_run[COMPONENTS_HEADER_LEN + 4..COMPONENTS_HEADER_LEN + 8]
            .copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode_components(&huge_run, 4), None);

        // A label above the payload's own component count is not a
        // label at all — a query indexing a per-component table with it
        // would read past the end.
        let mut bad_label = good.clone();
        bad_label[COMPONENTS_HEADER_LEN..COMPONENTS_HEADER_LEN + 4]
            .copy_from_slice(&99u32.to_le_bytes());
        assert_eq!(decode_components(&bad_label, 4), None);
        // ...but NO_COMPONENT itself always is, at any count.
        let mut no_comp = good.clone();
        no_comp[COMPONENTS_HEADER_LEN..COMPONENTS_HEADER_LEN + 4]
            .copy_from_slice(&NO_COMPONENT.to_le_bytes());
        assert!(decode_components(&no_comp, 4).is_some());

        // A stride below one run record could not address the table.
        let mut short_stride = good.clone();
        short_stride[20..24].copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(decode_components(&short_stride, 4), None);

        // A run count that would overflow the byte-length arithmetic is
        // refused rather than wrapped into an accidental fit.
        let mut huge_runs = good.clone();
        huge_runs[24..32].copy_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(decode_components(&huge_runs, 4), None);

        // ...and pure garbage of every plausible length.
        for len in [0usize, 1, 8, 31, 32, 40, 64, 4096] {
            assert_eq!(decode_components(&vec![0xFF; len], 4), None, "len {len}");
            assert_eq!(decode_components(&vec![0x00; len], 4), None, "len {len}");
        }
    }

    #[test]
    fn a_newer_builds_wider_run_stride_still_decodes() {
        // The stride exists so an older reader walks a newer file's run
        // table, reading the prefix it understands and stepping over the
        // rest — the same forward-compatibility rule
        // `field::encode_tile_index` and `stitch::encode_stitch` follow.
        let c = Components {
            label: vec![0, 0, NO_COMPONENT],
            count: 1,
        };
        let wide_stride = COMPONENT_RUN_LEN + 8;
        let mut bytes = encode_components(tag(), &c);
        bytes.truncate(COMPONENTS_HEADER_LEN);
        bytes[20..24].copy_from_slice(&(wide_stride as u32).to_le_bytes());
        for (label, length) in [(0u32, 2u32), (NO_COMPONENT, 1)] {
            let mut run = vec![0u8; wide_stride];
            run[0..4].copy_from_slice(&label.to_le_bytes());
            run[4..8].copy_from_slice(&length.to_le_bytes());
            run[8..16].copy_from_slice(&0xDEAD_BEEF_CAFE_F00Du64.to_le_bytes());
            bytes.extend_from_slice(&run);
        }
        assert_eq!(decode_components(&bytes, 3), Some(c));
    }
}
