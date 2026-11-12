// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only
//
// Port of ochartsng's Coordinates.h `Point` template (GPLv2, Andreas Vogel).

use super::{LatLon, Pixel, World};
use std::ops::Neg;

/// Generic 2D point; `x`/`y` semantics depend on the coordinate space.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Point<T> {
    pub x: T,
    pub y: T,
}

pub type WorldXy = Point<World>;
pub type PixelXy = Point<Pixel>;
/// x = longitude, y = latitude (not the other way round).
pub type LLXy = Point<LatLon>;

impl<T> Point<T> {
    pub const fn new(x: T, y: T) -> Self {
        Point { x, y }
    }
}

impl<T: Copy + Neg<Output = T>> Point<T> {
    pub fn inverted(self) -> Self {
        Point::new(-self.x, -self.y)
    }
}

impl<T: Copy + std::ops::Add<Output = T>> Point<T> {
    /// Plain (non-saturating) addition, like the reference's `Point::shift`.
    pub fn shifted(self, dx: T, dy: T) -> Self {
        Point::new(self.x + dx, self.y + dy)
    }

    pub fn shifted_by(self, other: Self) -> Self {
        self.shifted(other.x, other.y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_ops() {
        let p = WorldXy::new(3, -4);
        assert_eq!(p.shifted(1, 2), WorldXy::new(4, -2));
        assert_eq!(p.shifted_by(WorldXy::new(-3, 4)), WorldXy::new(0, 0));
        assert_eq!(p.inverted(), WorldXy::new(-3, 4));
        assert_eq!(WorldXy::default(), WorldXy::new(0, 0));
    }
}
