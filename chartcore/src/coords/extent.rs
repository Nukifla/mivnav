// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only
//
// Port of ochartsng's Coordinates.h `Box`/`LLBox` (GPLv2, Andreas Vogel).

use super::{
    lat_to_worldy, lon_to_worldx, world_shift, worldx_to_lon, worldy_to_lat, LLXy, LatLon, Point,
    World, TILE_SIZE,
};

/// Axis-aligned box in world/pixel coords; y grows south, so (xmin,ymin) is
/// NW and (xmax,ymax) SE, inclusive. `valid=false` is "empty" ([`extend`](Self::extend)
/// adopts the operand); unlike the reference, `new` sets `valid=true` directly.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Extent {
    pub valid: bool,
    /// west (upper-left x)
    pub xmin: World,
    /// east (lower-right x)
    pub xmax: World,
    /// north (upper-left y)
    pub ymin: World,
    /// south (lower-right y)
    pub ymax: World,
}

/// Extent in pixel coordinates (same representation — `Pixel` and `World`
/// are both `i32`, as in the reference).
pub type PixelBox = Extent;

impl Extent {
    /// A valid extent with the given bounds.
    pub const fn new(xmin: World, xmax: World, ymin: World, ymax: World) -> Self {
        Extent {
            valid: true,
            xmin,
            xmax,
            ymin,
            ymax,
        }
    }

    /// An invalid ("empty") extent, ready to be accumulated into via `extend`.
    pub const fn invalid() -> Self {
        Extent {
            valid: false,
            xmin: 0,
            xmax: 0,
            ymin: 0,
            ymax: 0,
        }
    }

    /// The fixed pixel bounds of a tile: 0..=TILE_SIZE (reference `TileBounds`).
    pub const fn tile_bounds() -> PixelBox {
        Extent::new(0, TILE_SIZE as i32, 0, TILE_SIZE as i32)
    }

    /// Do the two extents overlap (inclusive edges)? Returns false if `other`
    /// is invalid. Like the reference, `self.valid` is not checked.
    pub fn intersects(&self, other: &Extent) -> bool {
        if !other.valid {
            return false;
        }
        if self.xmax < other.xmin || self.ymax < other.ymin {
            return false;
        }
        if self.xmin > other.xmax || self.ymin > other.ymax {
            return false;
        }
        true
    }

    /// Is (x, y) inside (inclusive)?
    pub fn contains(&self, x: World, y: World) -> bool {
        x >= self.xmin && x <= self.xmax && y >= self.ymin && y <= self.ymax
    }

    /// Is the point inside (inclusive)?
    pub fn contains_point(&self, p: Point<World>) -> bool {
        self.contains(p.x, p.y)
    }

    /// Does `self` completely include `other`?
    pub fn includes(&self, other: &Extent) -> bool {
        other.xmin >= self.xmin
            && other.xmax <= self.xmax
            && other.ymin >= self.ymin
            && other.ymax <= self.ymax
    }

    /// Grow to the union with `other`. Returns whether anything changed.
    /// If `self` is invalid it adopts `other`. If `other` is invalid this is
    /// a no-op returning false (deviation: the reference throws).
    pub fn extend(&mut self, other: &Extent) -> bool {
        if !other.valid {
            return false;
        }
        if !self.valid {
            *self = *other;
            return true;
        }
        let mut changed = false;
        if other.xmin < self.xmin {
            self.xmin = other.xmin;
            changed = true;
        }
        if other.ymin < self.ymin {
            self.ymin = other.ymin;
            changed = true;
        }
        if other.xmax > self.xmax {
            self.xmax = other.xmax;
            changed = true;
        }
        if other.ymax > self.ymax {
            self.ymax = other.ymax;
            changed = true;
        }
        changed
    }

    /// Grow to include the point. Returns whether anything changed.
    pub fn extend_point(&mut self, p: Point<World>) -> bool {
        self.extend(&Extent::new(p.x, p.x, p.y, p.y))
    }

    /// Translate by (x, y) with saturating arithmetic. No-op on an invalid extent.
    pub fn shift(&mut self, x: World, y: World) -> bool {
        if !self.valid {
            return false;
        }
        self.xmin = world_shift(self.xmin, x);
        self.xmax = world_shift(self.xmax, x);
        self.ymin = world_shift(self.ymin, y);
        self.ymax = world_shift(self.ymax, y);
        true
    }

    /// A copy translated by (x, y).
    pub fn shifted(&self, x: World, y: World) -> Extent {
        let mut rt = *self;
        rt.shift(x, y);
        rt
    }

    /// Grow outward by `x` on both sides horizontally and `y` vertically.
    /// (Deviation: fixes the reference bug where `ymin` was expanded by `-x`.)
    pub fn expand(&mut self, x: World, y: World) {
        if !self.valid {
            return;
        }
        self.xmin = world_shift(self.xmin, -x);
        self.xmax = world_shift(self.xmax, x);
        self.ymin = world_shift(self.ymin, -y);
        self.ymax = world_shift(self.ymax, y);
    }

    /// A copy grown outward by (x, y).
    pub fn expanded(&self, x: World, y: World) -> Extent {
        let mut rt = *self;
        rt.expand(x, y);
        rt
    }

    /// Center point, computed overflow-safely as `min/2 + max/2`.
    pub fn midpoint(&self) -> Point<World> {
        Point::new(self.xmin / 2 + self.xmax / 2, self.ymin / 2 + self.ymax / 2)
    }
}

/// Bounding box in lat/lon degrees.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LLBox {
    pub e_lon: LatLon,
    pub w_lon: LatLon,
    pub n_lat: LatLon,
    pub s_lat: LatLon,
}

impl LLBox {
    /// Convert to a world extent. North latitude becomes `ymin` (y grows south).
    pub fn to_world(&self) -> Extent {
        Extent::new(
            lon_to_worldx(self.w_lon),
            lon_to_worldx(self.e_lon),
            lat_to_worldy(self.n_lat),
            lat_to_worldy(self.s_lat),
        )
    }

    pub fn from_world(ext: &Extent) -> LLBox {
        LLBox {
            e_lon: worldx_to_lon(ext.xmax),
            s_lat: worldy_to_lat(ext.ymax),
            w_lon: worldx_to_lon(ext.xmin),
            n_lat: worldy_to_lat(ext.ymin),
        }
    }

    /// Naive midpoint (x = lon, y = lat). Does not handle the ±180° crossing
    /// (open TODO in the reference as well).
    pub fn midpoint(&self) -> LLXy {
        LLXy::new(
            (self.e_lon + self.w_lon) / 2.0,
            (self.s_lat + self.n_lat) / 2.0,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::WorldXy;

    #[test]
    fn extend_from_invalid_adopts_other() {
        let mut e = Extent::invalid();
        assert!(!e.valid);
        assert!(e.extend(&Extent::new(1, 2, 3, 4)));
        assert_eq!(e, Extent::new(1, 2, 3, 4));
        // extending with an invalid extent is a no-op
        assert!(!e.extend(&Extent::invalid()));
        assert_eq!(e, Extent::new(1, 2, 3, 4));
    }

    #[test]
    fn extend_union() {
        let mut e = Extent::new(0, 10, 0, 10);
        assert!(!e.extend(&Extent::new(2, 8, 2, 8))); // contained: no change
        assert!(e.extend(&Extent::new(-5, 5, 5, 15)));
        assert_eq!(e, Extent::new(-5, 10, 0, 15));
    }

    #[test]
    fn extend_point_accumulates() {
        let mut e = Extent::invalid();
        e.extend_point(WorldXy::new(5, -3));
        e.extend_point(WorldXy::new(-2, 7));
        assert_eq!(e, Extent::new(-2, 5, -3, 7));
    }

    #[test]
    fn intersects_and_includes() {
        let a = Extent::new(0, 10, 0, 10);
        assert!(a.intersects(&Extent::new(5, 15, 5, 15)));
        assert!(a.intersects(&Extent::new(10, 20, 10, 20))); // touching edge counts
        assert!(!a.intersects(&Extent::new(11, 20, 0, 10)));
        assert!(!a.intersects(&Extent::new(0, 10, -20, -1)));
        assert!(!a.intersects(&Extent::invalid()));
        assert!(a.includes(&Extent::new(2, 8, 2, 8)));
        assert!(!a.includes(&Extent::new(2, 11, 2, 8)));
        assert!(a.contains(0, 10) && a.contains(10, 0));
        assert!(!a.contains(-1, 5));
        assert!(a.contains_point(WorldXy::new(5, 5)));
    }

    #[test]
    fn shift_expand_midpoint() {
        let e = Extent::new(0, 10, 20, 30);
        assert_eq!(e.shifted(5, -5), Extent::new(5, 15, 15, 25));
        assert_eq!(e.expanded(1, 2), Extent::new(-1, 11, 18, 32));
        assert_eq!(e.midpoint(), WorldXy::new(5, 25));
        // saturation at type bounds
        let mut f = Extent::new(i32::MAX - 1, i32::MAX - 1, 0, 0);
        f.shift(10, 0);
        assert_eq!(f.xmax, i32::MAX);
    }

    #[test]
    fn llbox_world_round_trip() {
        let ll = LLBox {
            w_lon: 8.0,
            e_lon: 10.0,
            n_lat: 55.0,
            s_lat: 54.0,
        };
        let ext = ll.to_world();
        assert!(ext.valid);
        assert!(ext.xmin < ext.xmax && ext.ymin < ext.ymax); // north = smaller y
        let back = LLBox::from_world(&ext);
        assert!((back.w_lon - 8.0).abs() < 1e-5);
        assert!((back.e_lon - 10.0).abs() < 1e-5);
        assert!((back.n_lat - 55.0).abs() < 1e-5);
        assert!((back.s_lat - 54.0).abs() < 1e-5);
        assert!((ll.midpoint().x - 9.0).abs() < 1e-9);
        assert!((ll.midpoint().y - 54.5).abs() < 1e-9);
    }
}
