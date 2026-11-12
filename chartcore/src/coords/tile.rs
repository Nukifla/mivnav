// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only
//
// Port of ochartsng's Coordinates.h tile handling (TileBox, TileInfoBase,
// tileToBox, worldPointToTile) (GPLv2, Andreas Vogel).

use super::{
    bitshift, pixel_to_world, world_clip, world_shift, world_to_pixel, Extent, Pixel, PixelBox,
    PixelXy, World, WorldXy, COORD_ZOOM_LEVEL, HALF_SHIFT, SUB_PIXEL_BITS, TILE_SIZE_BITS,
    WORLD_MAX, WORLD_MIN, WORLD_SHIFT,
};

/// A slippy-map tile address (x, y, zoom). Reference `TileInfoBase`, minus
/// its `valid` flag (use `Option<Tile>` where absence matters).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Tile {
    pub x: i32,
    pub y: i32,
    pub zoom: u32,
}

impl Tile {
    pub const fn new(x: i32, y: i32, zoom: u32) -> Self {
        Tile { x, y, zoom }
    }
}

/// A tile's extent in world coordinates, remembering the zoom it was built
/// for so points can be projected into tile-local pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileBox {
    pub extent: Extent,
    pub zoom: u32,
}

impl TileBox {
    /// Union with another tile box; refused (returns false) if zooms differ.
    pub fn extend(&mut self, other: &TileBox) -> bool {
        if other.zoom != self.zoom {
            return false;
        }
        self.extent.extend(&other.extent)
    }

    /// A copy translated by (x, y) world units.
    pub fn shifted(&self, x: World, y: World) -> TileBox {
        TileBox {
            extent: self.extent.shifted(x, y),
            zoom: self.zoom,
        }
    }

    /// Tile-local pixel coordinates → absolute world coordinates.
    pub fn rel_pixel_to_world(&self, rel: PixelXy) -> WorldXy {
        WorldXy::new(
            world_shift(self.extent.xmin, pixel_to_world(rel.x, self.zoom)),
            world_shift(self.extent.ymin, pixel_to_world(rel.y, self.zoom)),
        )
    }

    /// Absolute world coordinates → tile-local pixel coordinates.
    pub fn world_to_pixel(&self, wp: WorldXy) -> PixelXy {
        PixelXy::new(
            world_to_pixel(world_shift(wp.x, -self.extent.xmin), self.zoom),
            world_to_pixel(world_shift(wp.y, -self.extent.ymin), self.zoom),
        )
    }

    /// The tile's own pixel bounds: 0..=size-1 in both axes (255 for an
    /// unbordered 256px tile).
    pub fn pixel_bounds(&self) -> PixelBox {
        let mut rt = Extent::tile_bounds();
        rt.xmax = world_to_pixel(self.extent.xmax + 1 - self.extent.xmin, self.zoom) - 1;
        rt.ymax = world_to_pixel(self.extent.ymax + 1 - self.extent.ymin, self.zoom) - 1;
        rt
    }
}

/// Tile address → its world-coordinate extent. `zoom` is clamped to
/// [`COORD_ZOOM_LEVEL`]. A positive `pixel_border` grows the extent by that
/// many pixels (at the tile's zoom) on every side.
pub fn tile_to_box(tile: Tile, pixel_border: u32) -> TileBox {
    let zoom = tile.zoom.min(COORD_ZOOM_LEVEL);
    let shift = (COORD_ZOOM_LEVEL - zoom + TILE_SIZE_BITS + SUB_PIXEL_BITS) as i32;
    let mut extent = Extent::new(
        world_shift(bitshift(tile.x, shift), HALF_SHIFT),
        world_shift(bitshift(tile.x + 1, shift) - 1, HALF_SHIFT),
        world_shift(bitshift(tile.y, shift), HALF_SHIFT),
        world_shift(bitshift(tile.y + 1, shift) - 1, HALF_SHIFT),
    );
    if pixel_border > 0 {
        let b = bitshift(
            pixel_border as i32,
            (COORD_ZOOM_LEVEL - zoom + SUB_PIXEL_BITS) as i32,
        );
        extent.expand(b, b);
    }
    TileBox { extent, zoom }
}

/// The tile containing a world point at `zoom` (clamped to
/// [`COORD_ZOOM_LEVEL`]). Lon overflow in x is normalized back into the
/// world; y is clipped (no overflow possible for latitude).
pub fn world_point_to_tile(wp: WorldXy, zoom: u32) -> Tile {
    let zoom = zoom.min(COORD_ZOOM_LEVEL);
    let mut x = wp.x;
    while x > WORLD_MAX {
        x = world_shift(x, -WORLD_SHIFT);
    }
    while x < WORLD_MIN {
        x = world_shift(x, WORLD_SHIFT);
    }
    let y = world_clip(wp.y);
    let shift = (COORD_ZOOM_LEVEL - zoom + TILE_SIZE_BITS + SUB_PIXEL_BITS) as i32;
    Tile::new(
        bitshift(x - HALF_SHIFT, -shift),
        bitshift(y - HALF_SHIFT, -shift),
        zoom,
    )
}

/// Project a world extent into pixel coordinates local to `tile`
/// (reference `worldExtentToPixel`).
pub fn world_extent_to_pixel(ext: &Extent, tile: &TileBox) -> PixelBox {
    let shifted = ext.shifted(-tile.extent.xmin, -tile.extent.ymin);
    Extent::new(
        world_to_pixel(shifted.xmin, tile.zoom) as Pixel,
        world_to_pixel(shifted.xmax, tile.zoom) as Pixel,
        world_to_pixel(shifted.ymin, tile.zoom) as Pixel,
        world_to_pixel(shifted.ymax, tile.zoom) as Pixel,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{lat_lon_to_world, WORLD_MAX, WORLD_MIN};

    // Expected values computed from the reference math in Python, plus the
    // standard slippy-map tile formula as an independent cross-check.

    #[test]
    fn world_point_to_tile_known_value() {
        // (54.5N, 9.0E) at z10 is slippy tile (537, 326)
        let w = lat_lon_to_world(54.5, 9.0);
        assert_eq!(world_point_to_tile(w, 10), Tile::new(537, 326, 10));
        // zoom above max is clamped to COORD_ZOOM_LEVEL
        assert_eq!(world_point_to_tile(w, 25).zoom, COORD_ZOOM_LEVEL);
        // a point shifted a whole world east lands in the same tile
        let we = WorldXy::new(w.x + WORLD_SHIFT, w.y);
        assert_eq!(world_point_to_tile(we, 10), Tile::new(537, 326, 10));
    }

    #[test]
    fn tile_to_box_known_values() {
        let tb = tile_to_box(Tile::new(537, 326, 10), 0);
        assert_eq!(tb.zoom, 10);
        assert!(tb.extent.valid);
        assert_eq!(tb.extent.xmin, 13_107_201);
        assert_eq!(tb.extent.xmax, 13_631_488);
        assert_eq!(tb.extent.ymin, -97_517_567);
        assert_eq!(tb.extent.ymax, -96_993_280);
        // the point that addressed the tile is inside it
        assert!(tb.extent.contains_point(lat_lon_to_world(54.5, 9.0)));
        // zoom 0, tile (0,0) covers the whole world range
        let world = tile_to_box(Tile::new(0, 0, 0), 0);
        assert_eq!(world.extent.xmin, WORLD_MIN);
        assert_eq!(world.extent.xmax, WORLD_MAX);
        assert_eq!(world.extent.ymin, WORLD_MIN);
        assert_eq!(world.extent.ymax, WORLD_MAX);
    }

    #[test]
    fn tile_box_round_trip() {
        let w = lat_lon_to_world(54.5, 9.0);
        for zoom in [0u32, 10, 20] {
            let tile = world_point_to_tile(w, zoom);
            let tb = tile_to_box(tile, 0);
            assert!(tb.extent.contains_point(w), "zoom {zoom}");
            // neighbours don't contain it
            assert!(!tile_to_box(Tile::new(tile.x + 1, tile.y, zoom), 0)
                .extent
                .contains_point(w));
        }
    }

    #[test]
    fn tile_box_pixel_projection() {
        let tb = tile_to_box(Tile::new(537, 326, 10), 0);
        // NW corner maps to pixel (0,0) and back
        let nw = WorldXy::new(tb.extent.xmin, tb.extent.ymin);
        assert_eq!(tb.world_to_pixel(nw), PixelXy::new(0, 0));
        assert_eq!(tb.rel_pixel_to_world(PixelXy::new(0, 0)), nw);
        // SE corner is the last pixel
        let se = WorldXy::new(tb.extent.xmax, tb.extent.ymax);
        assert_eq!(tb.world_to_pixel(se), PixelXy::new(255, 255));
        assert_eq!(tb.pixel_bounds(), Extent::new(0, 255, 0, 255));
    }

    #[test]
    fn tile_to_box_pixel_border() {
        let plain = tile_to_box(Tile::new(537, 326, 10), 0);
        let bordered = tile_to_box(Tile::new(537, 326, 10), 4);
        // 4 pixels at z10 = 4 << (20-10+1) world units
        let d = 4 << 11;
        assert_eq!(bordered.extent.xmin, plain.extent.xmin - d);
        assert_eq!(bordered.extent.xmax, plain.extent.xmax + d);
        assert_eq!(bordered.extent.ymin, plain.extent.ymin - d);
        assert_eq!(bordered.extent.ymax, plain.extent.ymax + d);
    }

    #[test]
    fn tile_box_extend_requires_same_zoom() {
        let mut a = tile_to_box(Tile::new(537, 326, 10), 0);
        let b = tile_to_box(Tile::new(538, 326, 10), 0);
        let xmax_b = b.extent.xmax;
        assert!(a.extend(&b));
        assert_eq!(a.extent.xmax, xmax_b);
        assert!(!a.extend(&tile_to_box(Tile::new(100, 100, 9), 0)));
    }

    #[test]
    fn world_extent_to_pixel_known_value() {
        let tb = tile_to_box(Tile::new(537, 326, 10), 0);
        let px = world_extent_to_pixel(&tb.extent, &tb);
        assert!(px.valid);
        assert_eq!(px.xmin, 0);
        assert_eq!(px.ymin, 0);
        // xmax is the inclusive world max: (2^19 - 1) >> 11 = 255
        assert_eq!(px.xmax, 255);
        assert_eq!(px.ymax, 255);
    }
}
