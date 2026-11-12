// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Feature geometry in world coordinates.

use crate::coords::{Extent, WorldXy};

/// A point with an associated vertical value (depth in meters, positive
/// down) — the S-57 3D multipoint used by SOUNDG.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointZ {
    pub pos: WorldXy,
    pub z: f64,
}

/// A polygon: one outer ring plus zero or more holes. Rings are closed
/// (first vertex == last vertex) and stored in the winding order the decoder
/// delivered them in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Polygon {
    pub outer: Vec<WorldXy>,
    pub holes: Vec<Vec<WorldXy>>,
}

/// Feature geometry — the three S-57 geometric primitives, in world
/// coordinates. Multi-part geometries are flattened into the part lists, so
/// e.g. a MultiPolygon is just `Areas` with several polygons.
#[derive(Debug, Clone, PartialEq)]
pub enum Geometry {
    Point(WorldXy),
    /// Sounding-style 3D multipoint (z = depth in meters).
    MultiPoint(Vec<PointZ>),
    /// One or more line strings.
    Lines(Vec<Vec<WorldXy>>),
    /// One or more polygons.
    Areas(Vec<Polygon>),
}

impl Geometry {
    /// Bounding extent over all vertices. Invalid for empty geometry.
    pub fn extent(&self) -> Extent {
        let mut ext = Extent::invalid();
        match self {
            Geometry::Point(p) => {
                ext.extend_point(*p);
            }
            Geometry::MultiPoint(pts) => {
                for p in pts {
                    ext.extend_point(p.pos);
                }
            }
            Geometry::Lines(lines) => {
                for line in lines {
                    for p in line {
                        ext.extend_point(*p);
                    }
                }
            }
            Geometry::Areas(polys) => {
                // holes lie within the outer ring; the outer rings suffice
                for poly in polys {
                    for p in &poly.outer {
                        ext.extend_point(*p);
                    }
                }
            }
        }
        ext
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::Extent;

    #[test]
    fn extents() {
        let p = Geometry::Point(WorldXy::new(3, 4));
        assert_eq!(p.extent(), Extent::new(3, 3, 4, 4));

        let l = Geometry::Lines(vec![
            vec![WorldXy::new(0, 0), WorldXy::new(10, -5)],
            vec![WorldXy::new(-2, 7)],
        ]);
        assert_eq!(l.extent(), Extent::new(-2, 10, -5, 7));

        let a = Geometry::Areas(vec![Polygon {
            outer: vec![
                WorldXy::new(0, 0),
                WorldXy::new(4, 0),
                WorldXy::new(4, 4),
                WorldXy::new(0, 0),
            ],
            holes: vec![],
        }]);
        assert_eq!(a.extent(), Extent::new(0, 4, 0, 4));

        assert!(!Geometry::Lines(vec![]).extent().valid);
    }
}
