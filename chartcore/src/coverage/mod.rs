// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Chart data coverage from M_COVR meta objects. CATCOV=1 marks "coverage
//! available", CATCOV=2 "no coverage"; coverage is `union(1) − union(2)`.
//! See docs/architecture/coverage-semantics.md for the rest.

use crate::coords::{unwrap_anchor, unwrap_seam_x, Extent, WorldXy};
use crate::model::{AttrValue, Cell, Geometry};

/// A cell's true data coverage as a normalized ring set (see module docs).
#[derive(Debug, Clone, PartialEq)]
pub struct Coverage {
    /// Closed rings in world coordinates. Positive signed area (y-down)
    /// adds coverage, negative subtracts (and declares no-data, per the
    /// module docs).
    pub rings: Vec<Vec<WorldXy>>,
    /// Bounding extent of every ring, coverage-adding and no-data alike — the
    /// region the cell has anything to say about. A superset of the rings;
    /// not itself a statement about the area it bounds.
    pub extent: Extent,
}

/// Twice the signed area of a closed ring, y-down. i128: world coords span
/// 2^29, so per-vertex terms reach 2^59 and long rings could overflow i64.
/// `pub(crate)`: `mvt::cov_rings_at_zoom` needs the sign pre-simplification.
pub(crate) fn signed_area2_world(ring: &[WorldXy]) -> i128 {
    let mut sum = 0i128;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        sum += a.x as i128 * b.y as i128 - b.x as i128 * a.y as i128;
    }
    sum
}

/// Append `ring` oriented so its signed area matches `positive`. Zero-area
/// rings are dropped. Returns whether the ring was kept.
fn push_ring(rings: &mut Vec<Vec<WorldXy>>, mut ring: Vec<WorldXy>, positive: bool) -> bool {
    let a2 = signed_area2_world(&ring);
    if a2 == 0 {
        return false;
    }
    if (a2 > 0) != positive {
        ring.reverse();
    }
    rings.push(ring);
    true
}

impl Coverage {
    /// Build coverage from ring sets already split into covered/uncovered (as
    /// OSENC's `CELL_COVR`/`CELL_NOCOVR` carry them). Orientation normalized;
    /// `None` when no positive ring survives, same rule as [`cell_coverage`].
    pub fn from_rings(
        positive: Vec<Vec<WorldXy>>,
        negative: Vec<Vec<WorldXy>>,
    ) -> Option<Coverage> {
        let mut rings = Vec::new();
        let mut extent = Extent::invalid();
        let mut has_data = false;
        // one shared seam frame, exactly as in cell_coverage below
        let mut anchor: Option<i64> = None;
        for (mut ring, positive) in positive
            .into_iter()
            .map(|r| (r, true))
            .chain(negative.into_iter().map(|r| (r, false)))
        {
            unwrap_seam_x(&mut ring);
            match anchor {
                Some(a) => unwrap_anchor(&mut ring, a),
                None => anchor = ring.first().map(|p| p.x as i64),
            }
            if push_ring(&mut rings, ring, positive) {
                has_data |= positive;
                for p in rings.last().into_iter().flatten() {
                    extent.extend_point(*p);
                }
            }
        }
        has_data.then_some(Coverage { rings, extent })
    }

    /// Is this coverage nothing but the extent rectangle — one positive ring
    /// on [`extent`](Self::extent)'s corners, no no-data ring? See
    /// docs/architecture/coverage-semantics.md ([`crate::mvt::select`] uses this).
    pub fn is_extent_box(&self) -> bool {
        if self.rings.len() != 1 || !self.extent.valid {
            return false;
        }
        let ring = &self.rings[0];
        // `from_rings` keeps whatever closing repeat the source carried, so a
        // four-corner box arrives as either 4 or 5 points.
        let pts = match ring.len() {
            4 => &ring[..],
            5 if ring[0] == ring[4] => &ring[..4],
            _ => return false,
        };
        let e = &self.extent;
        if e.xmin == e.xmax || e.ymin == e.ymax {
            return false;
        }
        let corner =
            |p: &WorldXy| (p.x == e.xmin || p.x == e.xmax) && (p.y == e.ymin || p.y == e.ymax);
        // every vertex is an extent corner AND every corner is used — a ring
        // that walks only two of them is a degenerate sliver, not a rectangle
        pts.iter().all(corner)
            && [
                (e.xmin, e.ymin),
                (e.xmin, e.ymax),
                (e.xmax, e.ymin),
                (e.xmax, e.ymax),
            ]
            .iter()
            .all(|&(cx, cy)| pts.iter().any(|p| p.x == cx && p.y == cy))
    }
}

/// Extract the cell's coverage from its M_COVR features. `None` if it
/// declares no positive-area CATCOV=1 coverage — caller should then fall
/// back to the cell extent.
pub fn cell_coverage(cell: &Cell) -> Option<Coverage> {
    let mut rings = Vec::new();
    let mut extent = Extent::invalid();
    let mut has_data = false;
    // one shared seam frame: rings crossing/abutting ±180° are unwrapped
    // into contiguous (possibly overflowed) x, anchored to the first ring,
    // so the winding sum and the extent stay meaningful at the seam
    let mut anchor: Option<i64> = None;
    for f in cell.features_of("M_COVR") {
        let positive = match f.attr("CATCOV").and_then(AttrValue::as_int) {
            Some(1) => true,
            Some(2) => false,
            _ => continue,
        };
        let Some(Geometry::Areas(polys)) = &f.geometry else {
            continue;
        };
        for poly in polys {
            let mut outer = poly.outer.clone();
            unwrap_seam_x(&mut outer);
            match anchor {
                Some(a) => unwrap_anchor(&mut outer, a),
                None => anchor = outer.first().map(|p| p.x as i64),
            }
            // holes anchor to their own outer ring
            let hole_anchor = outer.first().map(|p| p.x as i64);
            if push_ring(&mut rings, outer, positive) {
                has_data |= positive;
                for p in rings.last().into_iter().flatten() {
                    extent.extend_point(*p);
                }
            }
            for hole in &poly.holes {
                let mut h = hole.clone();
                unwrap_seam_x(&mut h);
                if let Some(a) = hole_anchor {
                    unwrap_anchor(&mut h, a);
                }
                push_ring(&mut rings, h, !positive);
            }
        }
    }
    has_data.then_some(Coverage { rings, extent })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CellMeta, Feature, Polygon};
    use std::collections::BTreeMap;

    fn square(x0: i32, y0: i32, size: i32) -> Vec<WorldXy> {
        // y-down clockwise on screen: positive shoelace
        vec![
            WorldXy::new(x0, y0),
            WorldXy::new(x0 + size, y0),
            WorldXy::new(x0 + size, y0 + size),
            WorldXy::new(x0, y0 + size),
            WorldXy::new(x0, y0),
        ]
    }

    fn m_covr(catcov: i64, polys: Vec<Polygon>) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("CATCOV".to_string(), AttrValue::Int(catcov));
        Feature::new(302, "M_COVR".into(), attrs, Some(Geometry::Areas(polys)))
    }

    fn cell_of(features: Vec<Feature>) -> Cell {
        let mut extent = Extent::invalid();
        for f in &features {
            extent.extend(&f.extent);
        }
        Cell {
            meta: CellMeta::default(),
            features,
            extent,
        }
    }

    #[test]
    fn ring_signs_are_normalized() {
        let mut ccw = square(0, 0, 100);
        ccw.reverse();
        let cov1 = m_covr(
            1,
            vec![Polygon {
                outer: ccw,
                holes: vec![square(10, 10, 20)],
            }],
        );
        let cov2 = m_covr(
            2,
            vec![Polygon {
                outer: square(50, 50, 30),
                holes: vec![],
            }],
        );
        let cov = cell_coverage(&cell_of(vec![cov1, cov2])).unwrap();
        assert_eq!(cov.rings.len(), 3);
        let signs: Vec<bool> = cov
            .rings
            .iter()
            .map(|r| signed_area2_world(r) > 0)
            .collect();
        // CATCOV=1 outer positive, its hole negative, CATCOV=2 outer negative
        assert_eq!(signs, vec![true, false, false]);
        assert_eq!(cov.extent, Extent::new(0, 100, 0, 100));
    }

    #[test]
    fn no_positive_coverage_yields_none() {
        // no M_COVR at all
        assert_eq!(cell_coverage(&cell_of(vec![])), None);
        // only CATCOV=2
        let cov2 = m_covr(
            2,
            vec![Polygon {
                outer: square(0, 0, 10),
                holes: vec![],
            }],
        );
        assert_eq!(cell_coverage(&cell_of(vec![cov2])), None);
        // degenerate CATCOV=1 ring (zero area)
        let line = vec![WorldXy::new(0, 0), WorldXy::new(10, 0), WorldXy::new(0, 0)];
        let deg = m_covr(
            1,
            vec![Polygon {
                outer: line,
                holes: vec![],
            }],
        );
        assert_eq!(cell_coverage(&cell_of(vec![deg])), None);
    }

    /// The predicate that tells "I declared where I chart" from "I only
    /// declared my bounding box" (#ymwnqnmr). It must be true for exactly the
    /// shape freenauticalchart's `.senc` writes — one rectangle on the extent
    /// corners, closed or not — and false for anything carrying more.
    #[test]
    fn is_extent_box_matches_a_bare_rectangle_and_nothing_else() {
        let box_cov = Coverage::from_rings(vec![square(0, 0, 100)], vec![]).unwrap();
        assert!(box_cov.is_extent_box(), "the 5-point closed rectangle case");

        let unclosed = square(0, 0, 100)[..4].to_vec();
        assert!(Coverage::from_rings(vec![unclosed], vec![])
            .unwrap()
            .is_extent_box());

        // one corner cut off: a real declaration, however slight
        let mut chamfered = square(0, 0, 100);
        chamfered.insert(2, WorldXy::new(100, 20));
        chamfered[1] = WorldXy::new(80, 0);
        assert!(!Coverage::from_rings(vec![chamfered], vec![])
            .unwrap()
            .is_extent_box());

        // a declared no-data hole is information too, box or not
        let holed =
            Coverage::from_rings(vec![square(0, 0, 100)], vec![square(20, 20, 10)]).unwrap();
        assert!(!holed.is_extent_box());

        // two disjoint boxes are not "the extent box"
        let two = Coverage::from_rings(vec![square(0, 0, 10), square(50, 50, 10)], vec![]).unwrap();
        assert!(!two.is_extent_box());
    }
}
