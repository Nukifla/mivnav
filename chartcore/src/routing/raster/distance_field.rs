// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Exact squared-distance-to-nearest-blocked-cell, for every cell of a
//! [`super::Grid`] — the basis of the soft shallow-water preference (see
//! `super`'s module docs): a free cell's own distance from the hazard
//! union's hard `margin_m` boundary is what an A* edge-cost penalty decays
//! against, so a route can drift toward open water when doing so costs
//! little, without needing to know anything about real depth values.
//!
//! Felzenszwalb–Huttenlocher two-pass 1D-parabola-envelope transform
//! ("Distance Transforms of Sampled Functions", 2012) — exact, not a
//! chamfer approximation, and O(cols·rows): a 1D pass down every column,
//! then a 1D pass across every row of THAT result. At the search's own
//! hard cap (900×900 = 810,000 cells, `super::HARD_MAX_DIM`) this is a few
//! milliseconds, negligible next to the A* search itself — cheap enough to
//! recompute per corridor-widen attempt with no caching, matching this
//! module's whole "cost is bounded by grid resolution, not cached state"
//! design.
//!
//! `size_grid` already guarantees SQUARE cells (one `cell_size_m` shared
//! by both axes), so this module works entirely in cell units and lets
//! [`DistanceField::dist_m`] apply the metres conversion once at read
//! time — no anisotropic variant needed.
//!
//! # A second consumer, outside `routing::raster`
//!
//! [`crate::mivnav::portals`] measures §8.2's `min_horizontal_width` with
//! this same transform (the plan's own explicit call: "portal-local width
//! via a Felzenszwalb–Huttenlocher distance transform — reusing
//! `routing::raster::distance_field::DistanceField` directly"), which is
//! why this module and [`DistanceField`] itself are `pub(crate)` rather
//! than private to `routing::raster`. It enters through
//! [`DistanceField::from_blocked`] rather than [`DistanceField::build`]:
//! [`Grid`] stays private to `routing::raster`, since its own
//! off-grid-reads-as-blocked convention and its corridor-shaped
//! construction are that module's vocabulary, not the artifact's — the
//! shared thing is the transform, not the grid type. Nothing else about
//! this module changed for that consumer.

use super::Grid;

/// Squared distance (in CELL units) from every cell to the nearest
/// blocked cell.
pub(crate) struct DistanceField {
    cols: u32,
    rows: u32,
    dist2_cells: Vec<f64>,
}

impl DistanceField {
    /// [`Self::from_blocked`] over `grid`'s own dimensions and blocked
    /// mask — `routing::raster`'s own entry point, unchanged.
    pub(super) fn build(grid: &Grid) -> Option<DistanceField> {
        DistanceField::from_blocked(grid.cols, grid.rows, &grid.blocked)
    }

    /// `None` when nothing is blocked at all — nothing for any cell to be
    /// "close to", so the caller should skip the whole soft preference
    /// (every edge unpenalized) rather than pay for an `O(cols*rows)`
    /// pass whose answer would be "unboundedly far" for every cell
    /// anyway. The common case: a route far from any hazard.
    ///
    /// `blocked` is row-major, `cols * rows` entries. A slice that does
    /// not match those dimensions exactly is handled rather than trusted
    /// — a short one reads as free past its end (`get`-shaped, not a
    /// panic), and only the first `cols * rows` entries of a long one
    /// count towards "is anything blocked at all". Defensive only: no
    /// caller in this crate passes a mismatched slice.
    pub(crate) fn from_blocked(cols: u32, rows: u32, blocked: &[bool]) -> Option<DistanceField> {
        let (cols, rows) = (cols as usize, rows as usize);
        if cols == 0 || rows == 0 || !blocked.iter().take(cols * rows).any(|&b| b) {
            return None;
        }

        // A finite stand-in for "infinitely far", not `f64::INFINITY`:
        // the classic transform subtracts two `f[·]` values when finding
        // where two parabolas cross, and `INFINITY - INFINITY` is NaN,
        // not a large positive number — two never-reached cells would
        // silently poison the whole row/column. Any value strictly
        // greater than the largest POSSIBLE real squared distance on this
        // grid (`(cols-1)^2 + (rows-1)^2`) behaves identically to true
        // infinity for every comparison this algorithm makes, without the
        // NaN hazard.
        let sentinel = (cols * cols + rows * rows) as f64 + 1.0;

        // Column pass: transform each column (varying y) independently.
        let mut column_passed = vec![0.0f64; cols * rows];
        let mut col_buf = vec![0.0f64; rows];
        for x in 0..cols {
            for y in 0..rows {
                col_buf[y] = if blocked.get(y * cols + x).copied().unwrap_or(false) {
                    0.0
                } else {
                    sentinel
                };
            }
            let d = distance_transform_1d(&col_buf, sentinel);
            for y in 0..rows {
                column_passed[y * cols + x] = d[y];
            }
        }

        // Row pass: transform each row of the column pass's own output.
        let mut dist2_cells = vec![0.0f64; cols * rows];
        let mut row_buf = vec![0.0f64; cols];
        for y in 0..rows {
            row_buf.copy_from_slice(&column_passed[y * cols..(y + 1) * cols]);
            let d = distance_transform_1d(&row_buf, sentinel);
            dist2_cells[y * cols..(y + 1) * cols].copy_from_slice(&d);
        }

        Some(DistanceField {
            cols: cols as u32,
            rows: rows as u32,
            dist2_cells,
        })
    }

    /// Real-metre distance from grid cell `(x, y)` to the nearest blocked
    /// cell. Out-of-range reads as `0.0` — treated as "at the boundary",
    /// consistent with [`super::Grid::blocked`]'s own off-grid-is-blocked
    /// convention.
    pub(crate) fn dist_m(&self, x: i32, y: i32, cell_size_m: f64) -> f64 {
        if x < 0 || y < 0 || x as u32 >= self.cols || y as u32 >= self.rows {
            return 0.0;
        }
        let dist2 = self.dist2_cells[(y as u32 * self.cols + x as u32) as usize];
        dist2.sqrt() * cell_size_m
    }
}

/// One dimension of the Felzenszwalb–Huttenlocher transform: given sampled
/// values `f` (0.0 at a "source" position, `sentinel` everywhere else, or
/// any other sampled function — this routine doesn't care which), returns
/// `d[q] = min over p of (q-p)^2 + f[p]` for every `q` — the classic lower
/// envelope of upward parabolas, one rooted at each sample, found in a
/// single left-to-right sweep plus a single reconstruction pass, O(n)
/// overall despite there being O(n²) candidate (p, q) pairs.
fn distance_transform_1d(f: &[f64], sentinel: f64) -> Vec<f64> {
    let n = f.len();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![f[0]];
    }

    // v[k]: the sample index owning the k-th parabola of the lower
    // envelope, left to right. z[k]: the x-coordinate where the k-th and
    // (k+1)-th parabolas cross (envelope boundaries); z[0] = -sentinel
    // (every real q is to the right of it), the sentinel after the last
    // written entry stands in for +infinity for the same NaN-avoidance
    // reason `build` uses one at all.
    let mut v = vec![0usize; n];
    let mut z = vec![0.0f64; n + 1];
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -sentinel;
    z[1] = sentinel;

    for q in 1..n {
        loop {
            let vk = v[k];
            let s = ((f[q] + (q * q) as f64) - (f[vk] + (vk * vk) as f64))
                / (2.0 * q as f64 - 2.0 * vk as f64);
            if s <= z[k] {
                // This parabola is entirely shadowed by an earlier one —
                // drop it and retry against the next one back. `k == 0`
                // never enters this branch: `z[0] = -sentinel` and `s` is
                // always finite (see the sentinel's own docs on why),
                // so `s <= z[0]` is never true.
                k -= 1;
                continue;
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = sentinel;
            break;
        }
    }

    let mut d = vec![0.0f64; n];
    let mut k = 0usize;
    for (q, slot) in d.iter_mut().enumerate() {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let vk = v[k];
        let dq = q as f64 - vk as f64;
        *slot = dq * dq + f[vk];
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::raster::Grid;

    fn grid(cols: u32, rows: u32, blocked_cells: &[(u32, u32)]) -> Grid {
        let mut blocked = vec![false; (cols * rows) as usize];
        for &(x, y) in blocked_cells {
            blocked[(y * cols + x) as usize] = true;
        }
        Grid {
            cols,
            rows,
            blocked,
        }
    }

    #[test]
    fn all_free_grid_has_no_field() {
        let g = grid(5, 5, &[]);
        assert!(DistanceField::build(&g).is_none());
    }

    #[test]
    fn distance_from_a_single_blocked_cell_matches_known_offsets() {
        // 7x7, one blocked cell dead centre at (3,3).
        let g = grid(7, 7, &[(3, 3)]);
        let field = DistanceField::build(&g).expect("one blocked cell");
        let d2 = |x: u32, y: u32| field.dist2_cells[(y * field.cols + x) as usize];

        assert_eq!(d2(3, 3), 0.0, "the blocked cell itself");
        assert_eq!(d2(4, 3), 1.0, "one cell east");
        assert_eq!(d2(3, 2), 1.0, "one cell north");
        assert_eq!(d2(4, 4), 2.0, "one cell diagonally (sqrt(2))");
        assert_eq!(d2(5, 3), 4.0, "two cells east");
        assert_eq!(d2(5, 4), 5.0, "sqrt(5): two east, one south");
        assert_eq!(d2(0, 0), 18.0, "far corner: 3 east + 3 south = sqrt(18)");
    }

    #[test]
    fn distance_from_a_blocked_row_grows_linearly_away_from_it() {
        // 5 wide, 9 tall, row y=4 (the middle) entirely blocked — like a
        // straight coastline. Distance perpendicular to it should grow
        // linearly with no lateral (x) dependence at all.
        let blocked: Vec<(u32, u32)> = (0..5).map(|x| (x, 4)).collect();
        let g = grid(5, 9, &blocked);
        let field = DistanceField::build(&g).expect("a blocked row");
        for x in 0..5 {
            for dy in 0..=4u32 {
                let north = field.dist_m(x as i32, 4 - dy as i32, 1.0);
                let south = field.dist_m(x as i32, 4 + dy as i32, 1.0);
                assert_eq!(north, dy as f64, "north side, x={x}, dy={dy}");
                assert_eq!(south, dy as f64, "south side, x={x}, dy={dy}");
            }
        }
    }

    #[test]
    fn dist_m_applies_the_cell_size_and_treats_off_grid_as_boundary() {
        let g = grid(3, 3, &[(1, 1)]);
        let field = DistanceField::build(&g).unwrap();
        assert_eq!(field.dist_m(1, 1, 10.0), 0.0);
        assert_eq!(field.dist_m(0, 1, 10.0), 10.0);
        assert_eq!(
            field.dist_m(-1, 1, 10.0),
            0.0,
            "off-grid reads as at the boundary"
        );
        assert_eq!(
            field.dist_m(99, 1, 10.0),
            0.0,
            "off-grid reads as at the boundary"
        );
    }
}
