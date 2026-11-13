// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! The disk pre-render plan: every tile some cell charts, over a zoom range.
//!
//! A port of the backend's `CellWarmer._pretile_tiles` (mivnav.features.
//! ocharts.warm), which stays as the reference the backend tests pin and this
//! must match tile for tile. Moved here because it was slow on the boat's Pi:
//! 98% of the Python version's time was inside [`coverage_tile_state`], and
//! almost all of that was re-simplifying the cell's coverage rings for every
//! tile, when they depend only on the cell and the zoom. This does that once
//! per cell and zoom, and runs without the GIL, so the backend no longer has
//! to throttle planning to keep requests flowing.

use std::collections::HashSet;

use super::{cov_rings_at_zoom, tile_state_with_rings, TileState};
use crate::coords::COORD_ZOOM_LEVEL;
use crate::coverage::Coverage;

/// (w, s, e, n) degrees.
pub type Extent = [f64; 4];

/// Every z/x/y in `min_zoom..=max_zoom` that some cell charts, coarsest zoom
/// first, then by x, then y. A cell is asked only about the tiles in its own
/// extent: with a coverage, a tile is charted unless
/// [`coverage_tile_state`](super::coverage_tile_state) says
/// [`TileState::Uncovered`]; without one, if the extent touches the tile.
pub fn charted_tiles(
    cells: &[(Extent, Option<&Coverage>)],
    min_zoom: u8,
    max_zoom: u8,
) -> Vec<(u8, u32, u32)> {
    let mut out = Vec::new();
    for z in min_zoom..=max_zoom.min(COORD_ZOOM_LEVEL as u8) {
        let n = 1u32 << z;
        let mut charted: HashSet<(u32, u32)> = HashSet::new();
        for (ext, cov) in cells {
            let [w, s, e, nn] = *ext;
            let (x0, y0) = lonlat_tile(w, nn, n);
            let (x1, y1) = lonlat_tile(e, s, n);
            // Simplified on first need: a cell whose every tile is already
            // charted by an earlier one never pays for it.
            let mut rings: Option<Option<Vec<_>>> = None;
            for x in x0..=x1 {
                for y in y0..=y1 {
                    if charted.contains(&(x, y)) {
                        continue;
                    }
                    let hit = match cov {
                        None => intersects(ext, &tile_bounds_deg(z, x, y)),
                        Some(c) => {
                            let r = rings.get_or_insert_with(|| cov_rings_at_zoom(c, z));
                            tile_state_with_rings(c, r.as_deref(), z, x, y) != TileState::Uncovered
                        }
                    };
                    if hit {
                        charted.insert((x, y));
                    }
                }
            }
        }
        let mut tiles: Vec<(u32, u32)> = charted.into_iter().collect();
        tiles.sort_unstable();
        out.extend(tiles.into_iter().map(|(x, y)| (z, x, y)));
    }
    out
}

/// Web-mercator tile holding lon/lat, clamped to the grid. Same arithmetic,
/// in the same order, as warm.py's `_lonlat_tile`, so a cell edge on a tile
/// boundary lands on the same side.
fn lonlat_tile(lon: f64, lat: f64, n: u32) -> (u32, u32) {
    let lat = lat.clamp(-85.0511, 85.0511);
    let nf = n as f64;
    let x = ((lon + 180.0) / 360.0 * nf) as i64;
    let r = lat.to_radians();
    let y = ((1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0 * nf) as i64;
    let last = n as i64 - 1;
    (x.clamp(0, last) as u32, y.clamp(0, last) as u32)
}

/// (w, s, e, n) degrees of a tile — disk_tiles.py's `tile_bounds_deg`.
fn tile_bounds_deg(z: u8, x: u32, y: u32) -> Extent {
    let n = (1u64 << z) as f64;
    let lat = |yy: f64| {
        (std::f64::consts::PI * (1.0 - 2.0 * yy / n))
            .sinh()
            .atan()
            .to_degrees()
    };
    let (x, y) = (x as f64, y as f64);
    [
        x / n * 360.0 - 180.0,
        lat(y + 1.0),
        (x + 1.0) / n * 360.0 - 180.0,
        lat(y),
    ]
}

/// service.py's `_intersects`: closed boxes, touching counts.
fn intersects(a: &Extent, b: &Extent) -> bool {
    !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{lat_to_worldy, lon_to_worldx, worldx_to_lon, worldy_to_lat, WorldXy};
    use crate::mvt::coverage_tile_state;

    fn extent_of(cov: &Coverage) -> Extent {
        let e = &cov.extent;
        [
            worldx_to_lon(e.xmin),
            worldy_to_lat(e.ymax),
            worldx_to_lon(e.xmax),
            worldy_to_lat(e.ymin),
        ]
    }

    /// An irregular ring (a lopsided star), so tiles at its edge are
    /// partial, some inside are full and some in its notches are uncovered.
    fn star(cx: f64, cy: f64, r: f64) -> Coverage {
        let mut ring: Vec<WorldXy> = (0..14)
            .map(|i| {
                let a = i as f64 / 14.0 * std::f64::consts::TAU;
                let k = if i % 2 == 0 { r } else { r * 0.35 };
                WorldXy::new((cx + k * a.cos()) as i32, (cy + k * a.sin()) as i32)
            })
            .collect();
        ring.push(ring[0]);
        Coverage::from_rings(vec![ring], vec![]).expect("positive ring")
    }

    /// Exactly the exhaustive answer: every tile in any extent, kept iff
    /// some cell's own per-tile question says it charts it.
    #[test]
    fn matches_asking_every_cell_about_every_tile() {
        let (cx, cy) = (lon_to_worldx(11.0) as f64, lat_to_worldy(56.0) as f64);
        // ~16 z12 tiles across its arms, ~6 to its notches
        let r = (1u64 << (COORD_ZOOM_LEVEL + 8 + 1 - 12)) as f64 * 16.0;
        let big = star(cx, cy, r);
        let small = star(cx + r * 0.3, cy - r * 0.2, r * 0.1);
        let bare_ext: Extent = [3.0, 51.0, 3.1, 51.1];
        let cells = vec![
            (extent_of(&big), Some(&big)),
            (extent_of(&small), Some(&small)),
            (bare_ext, None),
        ];
        let got = charted_tiles(&cells, 4, 12);

        let mut want = Vec::new();
        for z in 4u8..=12 {
            let n = 1u32 << z;
            let mut cand = std::collections::BTreeSet::new();
            for (ext, _) in &cells {
                let (x0, y0) = lonlat_tile(ext[0], ext[3], n);
                let (x1, y1) = lonlat_tile(ext[2], ext[1], n);
                for x in x0..=x1 {
                    for y in y0..=y1 {
                        let any = cells.iter().any(|(e2, c2)| match c2 {
                            None => intersects(e2, &tile_bounds_deg(z, x, y)),
                            Some(c2) => coverage_tile_state(c2, z, x, y) != TileState::Uncovered,
                        });
                        if any {
                            cand.insert((x, y));
                        }
                    }
                }
            }
            want.extend(cand.into_iter().map(|(x, y)| (z, x, y)));
        }
        assert_eq!(got, want);
        // the star really does exercise every state at the finest zoom
        let states: Vec<_> = got
            .iter()
            .filter(|t| t.0 == 12)
            .map(|&(z, x, y)| coverage_tile_state(&big, z, x, y))
            .collect();
        assert!(states.contains(&TileState::Full) && states.contains(&TileState::Partial));
        assert!(got.len() > 50, "{}", got.len());
    }

    #[test]
    fn lonlat_tile_clamps_to_the_grid() {
        assert_eq!(lonlat_tile(-180.0, 89.0, 16), (0, 0));
        assert_eq!(lonlat_tile(180.0, -89.0, 16), (15, 15));
    }
}
