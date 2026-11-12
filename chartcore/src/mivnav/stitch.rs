// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §4.2's boundary-cell table: "adjacent tiles may differ by any number of
//! levels; stitching is handled once, at tile boundaries, by an explicit
//! boundary-cell table rather than at every neighbour lookup."
//!
//! # What this solves
//!
//! [`super::field`] fixes tile cell count ([`super::field::TILE_CELLS`])
//! but lets resolution vary tile-to-tile, so two side-by-side tiles can
//! have wildly different `cell_world` — a 2 m harbour tile next to a
//! 1024 m open-water one. [`super::field::RegionLattice`] guarantees every
//! rung is a power-of-two multiple of the finest one and every tile's
//! origin lands on every finer lattice, which is exactly what makes the
//! mapping across such a boundary a clean integer division rather than a
//! geometric search: `ratio` consecutive fine cells along the shared edge
//! correspond to each one coarse cell, where `ratio = coarse.cell_world /
//! fine.cell_world` is itself a power of two — see [`StitchRun::expand`]
//! for turning that ratio into the actual per-cell pairing.
//!
//! [`compute_stitch`] finds every touching tile pair once, for the whole
//! region, and records that mapping as a table of [`StitchRun`]s — so
//! Phase 3's per-band union-find sweep (the actual consumer) walks a flat
//! list instead of re-deriving tile adjacency from world coordinates for
//! every boundary cell of every band.
//!
//! # Judgment calls
//!
//! * **Tile-pair adjacency is an O(n²) scan over the region's tile list.**
//!   Correct and simple; for the tile counts a `.mivnav` region actually
//!   produces (thousands, not millions — [`super::field::TILE_CELLS`]
//!   keeps per-tile byte cost roughly uniform specifically so tile COUNT
//!   stays the scaling knob) this runs in well under a second. A
//!   sweep-line or spatial-index version is a legitimate later
//!   optimisation, not a Phase 2 requirement — noted rather than built
//!   speculatively.
//! * **A run is emitted in BOTH directions** (once with `tile` as the fine
//!   side, once as the coarse side) rather than once with the consumer
//!   expected to know which side of the pair it holds. Phase 3 looks up
//!   "this tile's boundary cells" by `tile` id alone; making it also
//!   branch on which side of a `StitchRun` it is defeats the "handled
//!   once" promise §4.2 asks for.
//! * **Only rectangular, axis-aligned tile extents are considered** — true
//!   for every tile [`super::field::RegionLattice::tile_at`] produces.
//!   Nothing here assumes a strict recursive quadtree partition (no gaps,
//!   no overlaps): the scan only asks "do these two extents share a
//!   positive-length edge segment", which is well-defined even if
//!   [`super::build`]'s tiling leaves gaps (uncovered ground, itself
//!   `FLAG_NO_COVERAGE`) or, in a future revision, deliberately overlaps
//!   at a seam.
//! * **Tiles that touch only at a single POINT get no run at all, and
//!   deliberately so.** Every interior split of a quadtree region
//!   produces exactly this (two diagonal siblings sharing one corner),
//!   and it looks at first like a gap this module should also close. It
//!   is not one: [`super::topology`]'s own module docs carry the proof
//!   that ordinary edge stitching through the shared orthogonal sibling
//!   already provides the identical connectivity a direct corner union
//!   would, in every case corner-cut prevention would ever permit one. A
//!   `compute_corner_contacts`-shaped function was written, tested, and
//!   then removed once that proof held up — read `topology`'s docs
//!   before reintroducing it.

use crate::coords::Extent;

use super::field::TileEntry;

/// Which edge of `tile` a [`StitchRun`] lies on.
///
/// World y grows SOUTHWARD (`coords::lat_to_worldy`'s own doc: "north =
/// smaller y"; [`Extent`]'s own: "(xmin, ymin) is the north-west corner"),
/// so it is `origin_y` (`ymin`) that is North here and `extent().ymax`
/// that is South — the opposite of what the field names alone suggest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// `x == tile.origin_x`.
    West,
    /// `x == tile.extent().xmax`.
    East,
    /// `y == tile.origin_y` (`ymin`) — smaller y is NORTH.
    North,
    /// `y == tile.extent().ymax` — larger y is SOUTH.
    South,
}

impl Side {
    fn to_u8(self) -> u8 {
        match self {
            Side::West => 0,
            Side::East => 1,
            Side::North => 2,
            Side::South => 3,
        }
    }

    fn from_u8(b: u8) -> Option<Side> {
        match b {
            0 => Some(Side::West),
            1 => Some(Side::East),
            2 => Some(Side::North),
            3 => Some(Side::South),
            _ => None,
        }
    }

    /// The edge `neighbour_tile` sees the SAME contact on — a run whose
    /// `tile` side is `East` always has its `neighbour_tile` on `West`,
    /// and likewise `North`/`South`. [`super::topology`]'s cross-tile
    /// pass uses this to find which of `neighbour_tile`'s OWN cells
    /// `neighbour_start`/`neighbour_end` are indexing, without a second
    /// lookup into `built.stitch` for the reverse-direction run.
    pub fn opposite(self) -> Side {
        match self {
            Side::West => Side::East,
            Side::East => Side::West,
            Side::North => Side::South,
            Side::South => Side::North,
        }
    }
}

/// One directed boundary contact: a contiguous run of `tile`'s own
/// edge-cell indices (`[start, end)`, row index for an East/West edge,
/// column index for a North/South one) and the run of `neighbour_tile`'s
/// edge-cell indices on the OTHER side of the same ground segment.
///
/// The two runs cover the identical stretch of ground by construction,
/// and `(end - start)` is always a whole power-of-two MULTIPLE or
/// fraction of `(neighbour_end - neighbour_start)` — never independent
/// numbers — because that ratio is exactly `neighbour_tile.cell_world /
/// tile.cell_world` (or its reciprocal). It is NOT true in general that
/// one side is a single cell: two leaves several ladder rungs apart, or
/// two same-rung leaves sharing a full tile edge, both produce runs where
/// BOTH lengths exceed one. [`expand`](StitchRun::expand) is the one
/// place that turns this ratio back into actual per-cell correspondences
/// — use it rather than assuming either side's shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StitchRun {
    pub tile: u32,
    pub side: Side,
    pub start: u16,
    pub end: u16,
    pub neighbour_tile: u32,
    pub neighbour_start: u16,
    pub neighbour_end: u16,
}

/// Serialized size of one [`StitchRun`], bytes.
pub const STITCH_RUN_LEN: usize = 20;

impl StitchRun {
    fn to_bytes(self) -> [u8; STITCH_RUN_LEN] {
        let mut b = [0u8; STITCH_RUN_LEN];
        b[0..4].copy_from_slice(&self.tile.to_le_bytes());
        b[4..8].copy_from_slice(&self.neighbour_tile.to_le_bytes());
        b[8..10].copy_from_slice(&self.start.to_le_bytes());
        b[10..12].copy_from_slice(&self.end.to_le_bytes());
        b[12..14].copy_from_slice(&self.neighbour_start.to_le_bytes());
        b[14..16].copy_from_slice(&self.neighbour_end.to_le_bytes());
        b[16] = self.side.to_u8();
        // 17..20 reserved
        b
    }

    fn parse(b: &[u8]) -> Option<StitchRun> {
        if b.len() < STITCH_RUN_LEN {
            return None;
        }
        let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let u16_at = |o: usize| u16::from_le_bytes(b[o..o + 2].try_into().unwrap());
        Some(StitchRun {
            tile: u32_at(0),
            neighbour_tile: u32_at(4),
            start: u16_at(8),
            end: u16_at(10),
            neighbour_start: u16_at(12),
            neighbour_end: u16_at(14),
            side: Side::from_u8(b[16])?,
        })
    }

    /// Expand this run into actual per-cell `(tile_local, neighbour_local)`
    /// correspondences — the one place the power-of-two ratio between the
    /// two run lengths turns back into which cell touches which.
    ///
    /// `(end - start)` and `(neighbour_end - neighbour_start)` are each
    /// positive, and one is always a whole multiple of the other —
    /// [`RegionLattice`](super::field::RegionLattice) guarantees the
    /// ratio between any two rungs' cell sizes is a power of two, and
    /// both lengths are the SAME world-unit overlap divided by each
    /// side's own cell size, so the division is always exact, never a
    /// remainder. The shorter side's cell `i` borders the longer side's
    /// `ratio` consecutive cells `[i*ratio, (i+1)*ratio)` — the two runs
    /// walk the identical ground segment in the same direction, so
    /// there is no reordering to account for.
    pub fn expand(&self) -> Vec<(u16, u16)> {
        let len_a = self.end.saturating_sub(self.start);
        let len_b = self.neighbour_end.saturating_sub(self.neighbour_start);
        if len_a == 0 || len_b == 0 {
            return Vec::new();
        }
        // Genuinely exact for every run `super::field::RegionLattice`'s
        // own guarantees produce (see the module docs). A future
        // lattice-misalignment bug that broke this WOULD have shown up
        // as "no `StitchRun` at all" before `local_row_range`/
        // `local_col_range` moved to floor/ceil — this keeps that same
        // loud signal for the one case still worth distinguishing from
        // an honest partial-cell touch: a remainder here means the two
        // sides disagree about where cell boundaries fall, not just
        // about how much of one cell the other's edge reaches.
        debug_assert!(
            len_a.is_multiple_of(len_b) || len_b.is_multiple_of(len_a),
            "StitchRun {self:?} has a non-power-of-two length ratio ({len_a}:{len_b}) — \
             the two tiles are not on the same RegionLattice"
        );
        let mut out = Vec::with_capacity(len_a.max(len_b) as usize);
        if len_a <= len_b {
            let ratio = len_b / len_a;
            for i in 0..len_a {
                for j in 0..ratio {
                    out.push((self.start + i, self.neighbour_start + i * ratio + j));
                }
            }
        } else {
            let ratio = len_a / len_b;
            for j in 0..len_b {
                for i in 0..ratio {
                    out.push((self.start + j * ratio + i, self.neighbour_start + j));
                }
            }
        }
        out
    }
}

const STITCH_TABLE_HEADER_LEN: usize = 8;

/// Serialize a stitch table: `count`, entry stride, then the runs — same
/// skip-what-you-do-not-know shape as
/// [`super::field::encode_tile_index`], for the same reason (a reader
/// built against an older [`STITCH_RUN_LEN`] still walks a newer file).
pub fn encode_stitch(runs: &[StitchRun]) -> Vec<u8> {
    let mut out = Vec::with_capacity(STITCH_TABLE_HEADER_LEN + runs.len() * STITCH_RUN_LEN);
    out.extend_from_slice(&(runs.len() as u32).to_le_bytes());
    out.extend_from_slice(&(STITCH_RUN_LEN as u32).to_le_bytes());
    for r in runs {
        out.extend_from_slice(&r.to_bytes());
    }
    out
}

/// Parse a stitch table. `None` on a structurally impossible payload.
pub fn decode_stitch(bytes: &[u8]) -> Option<Vec<StitchRun>> {
    if bytes.len() < STITCH_TABLE_HEADER_LEN {
        return None;
    }
    let count = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let stride = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if stride < STITCH_RUN_LEN {
        return None;
    }
    let need = count
        .checked_mul(stride)?
        .checked_add(STITCH_TABLE_HEADER_LEN)?;
    if bytes.len() < need {
        return None;
    }
    let mut runs = Vec::with_capacity(count);
    for i in 0..count {
        let at = STITCH_TABLE_HEADER_LEN + i * stride;
        runs.push(StitchRun::parse(&bytes[at..at + stride])?);
    }
    Some(runs)
}

/// The `(col, row)` on `tile`'s own `side` at edge-local index `idx` —
/// the inverse of how [`local_row_range`]/[`local_col_range`] derived
/// that index in the first place. Shared by [`super::topology`] (which
/// side of the seam each cross-tile union touches) and
/// [`super::portals`] (which side each portal's member cells sit on).
pub fn edge_cell(tile: &TileEntry, side: Side, idx: u16) -> (u32, u32) {
    // `saturating_sub`, not a bare `- 1`: a `TileEntry` with `cols == 0`
    // or `rows == 0` is nonsensical (nothing this crate's own build
    // pipeline ever produces) but is exactly the shape a corrupted or
    // version-skewed decoded file could hand this function, and it must
    // not underflow-panic on the way to whatever bounds check the
    // caller runs next (see [`resolve_run_pair`], the caller that
    // actually performs that check).
    match side {
        Side::West => (0, u32::from(idx)),
        Side::East => (u32::from(tile.cols).saturating_sub(1), u32::from(idx)),
        Side::North => (u32::from(idx), 0),
        Side::South => (u32::from(idx), u32::from(tile.rows).saturating_sub(1)),
    }
}

/// Resolve one [`StitchRun::expand`] pair `(a_idx, b_idx)` into
/// validated global SoA cell indices `(global_a, global_b)` — `None` if
/// either index falls outside its OWN tile's `cols`/`rows`. Never `None`
/// for a run this crate's own [`super::build`] produced (its indices are
/// always in range by construction); real for a `StitchRun` decoded from
/// a corrupted or version-skewed on-disk file, which is exactly the case
/// [`super::topology::union_stitch_run`] and
/// [`super::portals::detect_portals`] both need to not panic on — shared
/// here so hardening it once reaches both, rather than needing the same
/// fix applied twice (or, before this existed, applied to only one).
pub fn resolve_run_pair(
    tile: &TileEntry,
    side: Side,
    neighbour: &TileEntry,
    neighbour_side: Side,
    a_idx: u16,
    b_idx: u16,
) -> Option<(usize, usize)> {
    let (ac, ar) = edge_cell(tile, side, a_idx);
    let (bc, br) = edge_cell(neighbour, neighbour_side, b_idx);
    if ac >= u32::from(tile.cols) || ar >= u32::from(tile.rows) {
        return None;
    }
    if bc >= u32::from(neighbour.cols) || br >= u32::from(neighbour.rows) {
        return None;
    }
    Some((
        super::bands::global_index(tile, ac, ar),
        super::bands::global_index(neighbour, bc, br),
    ))
}

/// Every boundary contact between the tiles in `tiles`, in both
/// directions (see the module docs' second judgment call).
///
/// `tiles` is indexed positionally — `StitchRun::tile`/`neighbour_tile`
/// are indices into THIS slice, which must be the same order the caller
/// persists as the artifact's own `TileIndex` section, or the runs point
/// at the wrong tiles.
pub fn compute_stitch(tiles: &[TileEntry]) -> Vec<StitchRun> {
    let extents: Vec<Extent> = tiles.iter().map(TileEntry::extent).collect();
    let mut runs = Vec::new();

    for i in 0..tiles.len() {
        for j in (i + 1)..tiles.len() {
            contact(tiles, &extents, i, j, &mut runs);
        }
    }
    runs
}

/// Do tiles `i` and `j` share a positive-length edge segment? If so, push
/// both directions' [`StitchRun`]s.
fn contact(tiles: &[TileEntry], extents: &[Extent], i: usize, j: usize, out: &mut Vec<StitchRun>) {
    let (a, b) = (&extents[i], &extents[j]);

    // Vertical shared edge (one tile's east side against the other's
    // west): touching in x, overlapping in y.
    if a.xmax == b.xmin {
        push_vertical_contact(tiles, i, Side::East, j, Side::West, a, b, out);
    } else if b.xmax == a.xmin {
        push_vertical_contact(tiles, j, Side::East, i, Side::West, b, a, out);
    }

    // Horizontal shared edge (one tile's south side against the other's
    // north — y grows SOUTHWARD, so `a.ymax == b.ymin` means `a` sits
    // north of `b`, and it is `a`'s own SOUTH edge that touches `b`'s
    // own NORTH edge): touching in y, overlapping in x.
    if a.ymax == b.ymin {
        push_horizontal_contact(tiles, i, Side::South, j, Side::North, a, b, out);
    } else if b.ymax == a.ymin {
        push_horizontal_contact(tiles, j, Side::South, i, Side::North, b, a, out);
    }
}

/// `east_idx` is the tile whose EAST edge (`east_extent.xmax`) touches
/// `west_idx`'s WEST edge (`west_extent.xmin`). Builds the row-indexed
/// runs on both sides of that seam.
#[allow(clippy::too_many_arguments)]
fn push_vertical_contact(
    tiles: &[TileEntry],
    east_idx: usize,
    east_side: Side,
    west_idx: usize,
    west_side: Side,
    east_extent: &Extent,
    west_extent: &Extent,
    out: &mut Vec<StitchRun>,
) {
    let ov_lo = east_extent.ymin.max(west_extent.ymin);
    let ov_hi = east_extent.ymax.min(west_extent.ymax);
    if ov_hi <= ov_lo {
        return; // touching only at a corner point, not an edge
    }
    let et = &tiles[east_idx];
    let wt = &tiles[west_idx];
    let Some((e_start, e_end)) = local_row_range(et, ov_lo, ov_hi) else {
        return;
    };
    let Some((w_start, w_end)) = local_row_range(wt, ov_lo, ov_hi) else {
        return;
    };
    out.push(StitchRun {
        tile: east_idx as u32,
        side: east_side,
        start: e_start,
        end: e_end,
        neighbour_tile: west_idx as u32,
        neighbour_start: w_start,
        neighbour_end: w_end,
    });
    out.push(StitchRun {
        tile: west_idx as u32,
        side: west_side,
        start: w_start,
        end: w_end,
        neighbour_tile: east_idx as u32,
        neighbour_start: e_start,
        neighbour_end: e_end,
    });
}

/// The column-indexed equivalent of [`push_vertical_contact`]: `upper_idx`
/// is the tile with the SMALLER y (i.e. geographically north, since world
/// y grows southward) whose own SOUTH edge touches `lower_idx`'s own
/// NORTH edge. Each tile's OWN contact side is passed explicitly rather
/// than derived here — `contact` computes it, so a future north/south mixup
/// can only happen in one place, not silently inside this generic helper.
#[allow(clippy::too_many_arguments)]
fn push_horizontal_contact(
    tiles: &[TileEntry],
    upper_idx: usize,
    upper_side: Side,
    lower_idx: usize,
    lower_side: Side,
    upper_extent: &Extent,
    lower_extent: &Extent,
    out: &mut Vec<StitchRun>,
) {
    let ov_lo = upper_extent.xmin.max(lower_extent.xmin);
    let ov_hi = upper_extent.xmax.min(lower_extent.xmax);
    if ov_hi <= ov_lo {
        return;
    }
    let ut = &tiles[upper_idx];
    let lt = &tiles[lower_idx];
    let Some((u_start, u_end)) = local_col_range(ut, ov_lo, ov_hi) else {
        return;
    };
    let Some((l_start, l_end)) = local_col_range(lt, ov_lo, ov_hi) else {
        return;
    };
    out.push(StitchRun {
        tile: upper_idx as u32,
        side: upper_side,
        start: u_start,
        end: u_end,
        neighbour_tile: lower_idx as u32,
        neighbour_start: l_start,
        neighbour_end: l_end,
    });
    out.push(StitchRun {
        tile: lower_idx as u32,
        side: lower_side,
        start: l_start,
        end: l_end,
        neighbour_tile: upper_idx as u32,
        neighbour_start: u_start,
        neighbour_end: u_end,
    });
}

/// World-y range `[lo, hi)` as `tile`-local row indices — every row this
/// tile touches ANY part of, not only a range that happens to land on
/// this tile's own cell boundaries at BOTH ends.
///
/// That distinction used to be invisible: for every rung pair up to a
/// 256x ratio, one whole tile's overlap edge always DOES land on an
/// exact cell boundary of the other (`TILE_CELLS` cells per tile, so a
/// ratio at or under `TILE_CELLS` never lets one tile's full extent fall
/// short of the other's single cell). The ladder's own top step is 4x
/// rather than 2x, though, so its FULL span (2 m to 1024 m) is 512x —
/// past `TILE_CELLS`. A rung-0 tile immediately beside an untouched
/// rung-8 tile then spans less than ONE of the coarse tile's own cells,
/// and no position ever lands both of that span's edges on a coarse
/// cell boundary at once — `(hi - lo)` there is provably not a whole
/// multiple of `cw`, regardless of alignment. Floor/ceil answers "which
/// cell(s) does this span touch" instead of "does this span exactly
/// equal a whole number of cells", which is what every caller actually
/// needs and what the exactness check quietly assumed without needing
/// to, until [`super::build`]'s real recursive refinement made the
/// 512x case reachable.
fn local_row_range(tile: &TileEntry, lo: i32, hi: i32) -> Option<(u16, u16)> {
    let cw = i64::from(tile.cell_world);
    if cw <= 0 {
        return None;
    }
    let oy = i64::from(tile.origin_y);
    let (lo, hi) = (i64::from(lo) - oy, i64::from(hi) - oy);
    if lo < 0 || hi <= lo {
        return None;
    }
    let start = lo.div_euclid(cw);
    let end = (hi - 1).div_euclid(cw) + 1;
    if start >= i64::from(tile.rows) || end > i64::from(tile.rows) {
        return None;
    }
    Some((start as u16, end as u16))
}

/// The column equivalent of [`local_row_range`].
fn local_col_range(tile: &TileEntry, lo: i32, hi: i32) -> Option<(u16, u16)> {
    let cw = i64::from(tile.cell_world);
    if cw <= 0 {
        return None;
    }
    let ox = i64::from(tile.origin_x);
    let (lo, hi) = (i64::from(lo) - ox, i64::from(hi) - ox);
    if lo < 0 || hi <= lo {
        return None;
    }
    let start = lo.div_euclid(cw);
    let end = (hi - 1).div_euclid(cw) + 1;
    if start >= i64::from(tile.cols) || end > i64::from(tile.cols) {
        return None;
    }
    Some((start as u16, end as u16))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::mivnav::field::{RegionLattice, TILE_CELLS};

    const LAT: f64 = 54.0;
    const LON: f64 = 11.0;

    fn lattice() -> RegionLattice {
        RegionLattice::for_region(Extent::new(
            lat_lon_to_world(LAT, LON - 0.2).x,
            lat_lon_to_world(LAT, LON + 0.2).x,
            lat_lon_to_world(LAT + 0.2, LON).y,
            lat_lon_to_world(LAT - 0.2, LON).y,
        ))
    }

    #[test]
    fn opposite_is_its_own_inverse_and_pairs_the_real_axes() {
        assert_eq!(Side::West.opposite(), Side::East);
        assert_eq!(Side::East.opposite(), Side::West);
        assert_eq!(Side::North.opposite(), Side::South);
        assert_eq!(Side::South.opposite(), Side::North);
        for s in [Side::West, Side::East, Side::North, Side::South] {
            assert_eq!(s.opposite().opposite(), s);
        }
    }

    #[test]
    fn a_run_round_trips_through_bytes() {
        let r = StitchRun {
            tile: 3,
            side: Side::North,
            start: 10,
            end: 20,
            neighbour_tile: 7,
            neighbour_start: 100,
            neighbour_end: 101,
        };
        assert_eq!(StitchRun::parse(&r.to_bytes()), Some(r));
        let bytes = encode_stitch(&[r]);
        assert_eq!(decode_stitch(&bytes), Some(vec![r]));
        assert!(decode_stitch(&bytes[..bytes.len() - 1]).is_none());
        assert!(decode_stitch(&[]).is_none());
    }

    #[test]
    fn a_full_ladder_span_gap_still_stitches() {
        // rung 0 (finest) directly adjacent to rung 8 (coarsest): ratio
        // 512, the ONE pairing where a whole fine tile (256 cells) spans
        // LESS than one coarse cell (cw_coarse = 512 * cw_fine, since
        // TILE_CELLS=256 < the ladder's own 512x total span). Regression
        // for a real bug: `local_row_range`/`local_col_range` used to
        // require the overlap to land on an EXACT cell boundary on BOTH
        // sides, which is mathematically impossible here (256*cw_fine is
        // not a whole multiple of 512*cw_fine), so this pair silently
        // produced zero StitchRuns despite genuinely sharing an edge —
        // exactly the "adjacent tiles may differ by any number of
        // levels" case §4.2 itself names.
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let fine = l.tile_at(0, p.x, p.y);
        // Hand-built, not `tile_at()` — at a 512x size ratio, `tile_at`
        // would snap the coarse tile to whichever HUGE coarse cell
        // CONTAINS that point, generally nowhere near actually touching
        // `fine`'s edge (see `a_coarse_tile_stitches_many_to_one...`'s
        // own precedent for the same reasoning at a smaller ratio).
        let coarse = TileEntry {
            origin_x: fine.origin_x + i32::from(fine.cols) * fine.cell_world,
            origin_y: fine.origin_y,
            cell_world: l.cell_world(8),
            rung: 8,
            tile_flags: 0,
            cols: TILE_CELLS as u16,
            rows: TILE_CELLS as u16,
            triggers: 0,
            payload_offset: 0,
        };
        let runs = compute_stitch(&[fine, coarse]);
        assert!(
            !runs.is_empty(),
            "a rung 0 / rung 8 adjacency must still stitch"
        );
        let f2c = runs.iter().find(|r| r.tile == 0).expect("fine->coarse run");
        assert_eq!(
            (f2c.start, f2c.end),
            (0, fine.rows),
            "the whole fine edge touches"
        );
        // The coarse side touches exactly ONE cell — the fine tile's
        // whole height (256 cells) is half of one coarse cell's own
        // width (512 fine-cell-widths), so it can never straddle two.
        assert_eq!(f2c.neighbour_end - f2c.neighbour_start, 1);
        let pairs = f2c.expand();
        assert_eq!(pairs.len(), fine.rows as usize);
        for &(fine_idx, coarse_idx) in &pairs {
            assert_eq!(
                coarse_idx, f2c.neighbour_start,
                "every fine row pairs with the one touched coarse cell, got fine {fine_idx}"
            );
        }
    }

    #[test]
    fn two_tiles_at_the_same_rung_stitch_one_to_one() {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let west = l.tile_at(3, p.x, p.y);
        let east_origin_x = west.origin_x + west.cols as i32 * west.cell_world;
        let east = l.tile_at(3, east_origin_x, p.y);
        assert_eq!(east.origin_x, east_origin_x, "adjacent, not overlapping");

        let runs = compute_stitch(&[west, east]);
        // One run each direction.
        assert_eq!(runs.len(), 2);
        let w2e = runs.iter().find(|r| r.tile == 0).unwrap();
        assert_eq!(w2e.side, Side::East);
        assert_eq!((w2e.start, w2e.end), (0, west.rows));
        assert_eq!(w2e.neighbour_tile, 1);
        assert_eq!((w2e.neighbour_start, w2e.neighbour_end), (0, east.rows));

        let e2w = runs.iter().find(|r| r.tile == 1).unwrap();
        assert_eq!(e2w.side, Side::West);
        assert_eq!(e2w.neighbour_tile, 0);
        assert_eq!((e2w.start, e2w.end), (0, east.rows));
    }

    #[test]
    fn north_south_sides_match_the_codebases_own_y_grows_south_convention() {
        // `north` is the tile at the GEOGRAPHICALLY northern position (a
        // higher latitude — `lat_to_worldy`'s own doc: "north = smaller
        // y"), constructed independently via lat/lon so this test does
        // not just re-derive whatever `Side` happens to encode.
        let l = lattice();
        let north_pt = lat_lon_to_world(LAT + 0.05, LON);
        let north = l.tile_at(3, north_pt.x, north_pt.y);
        let south_origin_y = north.origin_y + i32::from(north.rows) * north.cell_world;
        let south_pt = lat_lon_to_world(LAT, LON);
        let south = l.tile_at(3, south_pt.x, south_origin_y);
        assert_eq!(south.origin_y, south_origin_y, "adjacent, not overlapping");
        assert!(
            crate::coords::worldy_to_lat(north.origin_y)
                > crate::coords::worldy_to_lat(south.origin_y),
            "fixture must actually be north of its neighbour"
        );

        let runs = compute_stitch(&[north, south]);
        assert_eq!(runs.len(), 2);
        // The northern tile's own contact edge is its SOUTH side — it is
        // touching the tile below it.
        let n2s = runs.iter().find(|r| r.tile == 0).unwrap();
        assert_eq!(n2s.side, Side::South);
        assert_eq!(n2s.neighbour_tile, 1);
        // And the southern tile's own contact edge is its NORTH side.
        let s2n = runs.iter().find(|r| r.tile == 1).unwrap();
        assert_eq!(s2n.side, Side::North);
        assert_eq!(s2n.neighbour_tile, 0);
    }

    #[test]
    fn a_coarse_tile_stitches_many_to_one_against_a_finer_neighbour() {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        // The coarse tile is anchored normally, to ITS OWN grid...
        let coarse = l.tile_at(4, p.x, p.y);
        // ...and the fine tile is placed BY HAND immediately to its west,
        // rather than via `tile_at` (which snaps to the FINE tile grid
        // and would generally miss `coarse.origin_x` — only cell
        // boundaries, not tile boundaries, are guaranteed to coincide
        // across rungs; see the module docs' third judgment call). This
        // is exactly the shape a real quadtree build produces: a coarse
        // leaf next to a run of finer leaves subdividing its neighbour.
        let fine_cell_world = l.cell_world(3);
        let cells = TILE_CELLS as u16;
        let fine = TileEntry {
            origin_x: coarse.origin_x - i32::from(cells) * fine_cell_world,
            origin_y: coarse.origin_y,
            cell_world: fine_cell_world,
            rung: 3,
            tile_flags: 0,
            cols: cells,
            rows: cells,
            triggers: 0,
            payload_offset: 0,
        };
        assert_eq!(
            fine.origin_x + i32::from(fine.cols) * fine.cell_world,
            coarse.origin_x,
            "fixture must actually be touching"
        );

        let ratio = (coarse.cell_world / fine.cell_world) as u16;
        assert!(ratio >= 2, "fixture must actually differ in resolution");

        let runs = compute_stitch(&[fine, coarse]);
        let f2c = runs.iter().find(|r| r.tile == 0).unwrap();
        assert_eq!(f2c.side, Side::East);
        // The fine tile's own edge is untouched — always its own full
        // row range on ITS side, regardless of what is across the seam.
        assert_eq!((f2c.start, f2c.end), (0, fine.rows));

        let c2f = runs.iter().find(|r| r.tile == 1).unwrap();
        assert_eq!(c2f.side, Side::West);
        // The coarse tile's own row range, in ITS OWN cell units, is
        // proportionally narrower — this is the actual "many fine cells
        // per one coarse cell" contact, expressed on the coarse side.
        assert_eq!(c2f.end - c2f.start, fine.rows / ratio);

        // And each side's NEIGHBOUR range matches the other side's own
        // range exactly — same ground segment, described from both ends.
        assert_eq!(
            (f2c.neighbour_start, f2c.neighbour_end),
            (c2f.start, c2f.end)
        );
        assert_eq!(
            (c2f.neighbour_start, c2f.neighbour_end),
            (f2c.start, f2c.end)
        );
    }

    #[test]
    fn tiles_that_only_touch_at_a_corner_stitch_nothing() {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let sw = l.tile_at(3, p.x, p.y);
        let tw = sw.cols as i32 * sw.cell_world;
        // Diagonally adjacent: shares exactly the one corner point, no
        // edge segment.
        let ne = l.tile_at(3, sw.origin_x + tw, sw.origin_y + tw);
        assert!(compute_stitch(&[sw, ne]).is_empty());
    }

    #[test]
    fn tiles_that_do_not_touch_at_all_stitch_nothing() {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let a = l.tile_at(3, p.x, p.y);
        let far = l.tile_at(3, p.x + 100 * a.cell_world * a.cols as i32, p.y);
        assert!(compute_stitch(&[a, far]).is_empty());
    }

    #[test]
    fn three_tiles_produce_the_expected_run_count() {
        // west | mid | east, all the same rung: two seams, two runs each.
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let west = l.tile_at(2, p.x, p.y);
        let tw = west.cols as i32 * west.cell_world;
        let mid = l.tile_at(2, west.origin_x + tw, p.y);
        let east = l.tile_at(2, west.origin_x + 2 * tw, p.y);
        let runs = compute_stitch(&[west, mid, east]);
        assert_eq!(runs.len(), 4, "west<->mid and mid<->east, both directions");
        assert!(runs.iter().all(|r| r.tile != r.neighbour_tile));
    }

    #[test]
    fn expand_pairs_a_same_rung_run_one_to_one_in_walk_order() {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let west = l.tile_at(3, p.x, p.y);
        let east = l.tile_at(3, west.origin_x + west.cols as i32 * west.cell_world, p.y);
        let runs = compute_stitch(&[west, east]);
        let w2e = runs.iter().find(|r| r.tile == 0).unwrap();
        let pairs = w2e.expand();
        assert_eq!(pairs.len(), west.rows as usize);
        for (i, &(a, b)) in pairs.iter().enumerate() {
            assert_eq!(a, i as u16);
            assert_eq!(b, i as u16, "same-rung seam must pair index-for-index");
        }
    }

    #[test]
    fn expand_groups_the_finer_sides_ratio_cells_under_each_coarser_one() {
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let coarse = l.tile_at(4, p.x, p.y);
        let fine_cell_world = l.cell_world(3);
        let cells = TILE_CELLS as u16;
        let fine = TileEntry {
            origin_x: coarse.origin_x - i32::from(cells) * fine_cell_world,
            origin_y: coarse.origin_y,
            cell_world: fine_cell_world,
            rung: 3,
            tile_flags: 0,
            cols: cells,
            rows: cells,
            triggers: 0,
            payload_offset: 0,
        };
        let ratio = (coarse.cell_world / fine.cell_world) as u16;
        let runs = compute_stitch(&[fine, coarse]);
        let f2c = runs.iter().find(|r| r.tile == 0).unwrap();
        let pairs = f2c.expand();
        // Both sides have MORE than one cell here (the coarse side's own
        // range is fine.rows/ratio, not 1) — exactly the general case the
        // module docs warn is not "one side is always a single cell".
        assert!(f2c.end - f2c.start > 1);
        assert_eq!(
            pairs.len(),
            fine.rows as usize,
            "every fine cell gets exactly one pairing"
        );
        for &(fine_idx, coarse_idx) in &pairs {
            assert_eq!(
                coarse_idx,
                fine_idx / ratio,
                "fine cell {fine_idx} must pair with coarse cell {}, not {coarse_idx}",
                fine_idx / ratio
            );
        }
        // And the reverse direction groups the same way, the other way.
        let c2f = runs.iter().find(|r| r.tile == 1).unwrap();
        let rev = c2f.expand();
        assert_eq!(rev.len(), fine.rows as usize);
        let mut forward: Vec<(u16, u16)> = pairs.iter().map(|&(a, b)| (b, a)).collect();
        let mut reverse = rev.clone();
        forward.sort_unstable();
        reverse.sort_unstable();
        assert_eq!(forward, reverse, "expand() must agree in both directions");
    }

    #[test]
    fn a_coarse_tile_gets_two_separate_runs_against_two_finer_neighbours() {
        // One coarse tile, two DIFFERENT finer leaves each bordering only
        // half its edge (the shape a real quadtree split-then-refine
        // produces: a sibling stays coarse, the other sibling's own
        // children end up finer still). compute_stitch must not merge
        // these into one run or drop either.
        let l = lattice();
        let p = lat_lon_to_world(LAT, LON);
        let coarse = l.tile_at(4, p.x, p.y);
        let fine_cell_world = l.cell_world(3);
        let cells = TILE_CELLS as u16;
        let half_edge = fine_cell_world * i32::from(cells);
        let fine_a = TileEntry {
            origin_x: coarse.origin_x - half_edge,
            origin_y: coarse.origin_y,
            cell_world: fine_cell_world,
            rung: 3,
            tile_flags: 0,
            cols: cells,
            rows: cells,
            triggers: 0,
            payload_offset: 0,
        };
        // Immediately follows fine_a along the same edge — not derived
        // from coarse's own height, so this does not rely on the ratio
        // between these two particular rungs happening to be 2.
        let fine_b = TileEntry {
            origin_y: fine_a.origin_y + i32::from(cells) * fine_cell_world,
            ..fine_a
        };
        let runs = compute_stitch(&[coarse, fine_a, fine_b]);
        let coarse_runs: Vec<_> = runs.iter().filter(|r| r.tile == 0).collect();
        assert_eq!(
            coarse_runs.len(),
            2,
            "must see both finer neighbours separately"
        );
        let targets: std::collections::HashSet<u32> =
            coarse_runs.iter().map(|r| r.neighbour_tile).collect();
        assert_eq!(targets, std::collections::HashSet::from([1, 2]));
        for r in &coarse_runs {
            assert!(!r.expand().is_empty());
        }
    }
}
