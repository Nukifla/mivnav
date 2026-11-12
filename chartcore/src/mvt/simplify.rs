// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Ramer–Douglas–Peucker polyline simplification in world coordinates.

use crate::coords::WorldXy;

/// Simplify a point sequence, keeping every point farther than `tolerance`
/// (world units) from the chord of its containing span. Endpoints are always
/// kept, so a closed ring (first == last) stays closed.
pub fn simplify(pts: &[WorldXy], tolerance: f64) -> Vec<WorldXy> {
    if pts.len() <= 2 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let mut best = a;
        let mut best_d = -1.0f64;
        for i in a + 1..b {
            let d = segment_distance(pts[i], pts[a], pts[b]);
            if d > best_d {
                best = i;
                best_d = d;
            }
        }
        if best_d > tolerance {
            keep[best] = true;
            stack.push((a, best));
            stack.push((best, b));
        }
    }
    pts.iter()
        .zip(&keep)
        .filter(|(_, k)| **k)
        .map(|(p, _)| *p)
        .collect()
}

/// Distance from `p` to segment `a`–`b`. A degenerate segment (a == b, e.g.
/// the chord of a closed ring) falls back to point distance.
fn segment_distance(p: WorldXy, a: WorldXy, b: WorldXy) -> f64 {
    let dx = (b.x - a.x) as f64;
    let dy = (b.y - a.y) as f64;
    let px = (p.x - a.x) as f64;
    let py = (p.y - a.y) as f64;
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        ((px * dx + py * dy) / len2).clamp(0.0, 1.0)
    };
    let ex = px - t * dx;
    let ey = py - t * dy;
    (ex * ex + ey * ey).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: i32, y: i32) -> WorldXy {
        WorldXy::new(x, y)
    }

    #[test]
    fn collinear_points_collapse() {
        let line = vec![p(0, 0), p(10, 0), p(20, 0), p(30, 0)];
        assert_eq!(simplify(&line, 1.0), vec![p(0, 0), p(30, 0)]);
    }

    #[test]
    fn spike_above_tolerance_survives() {
        let line = vec![p(0, 0), p(10, 5), p(20, 0)];
        assert_eq!(simplify(&line, 1.0), line);
        // and collapses once the tolerance swallows it
        assert_eq!(simplify(&line, 10.0), vec![p(0, 0), p(20, 0)]);
    }

    #[test]
    fn closed_ring_stays_closed() {
        let ring = vec![
            p(0, 0),
            p(100, 2),
            p(200, 0),
            p(200, 200),
            p(0, 200),
            p(0, 0),
        ];
        let s = simplify(&ring, 5.0);
        assert_eq!(s.first(), s.last());
        // the near-collinear midpoint on the top edge is gone
        assert!(!s.contains(&p(100, 2)));
        assert_eq!(s.len(), 5);
    }

    #[test]
    fn short_inputs_pass_through() {
        assert_eq!(simplify(&[], 1.0), Vec::<WorldXy>::new());
        assert_eq!(simplify(&[p(1, 1)], 1.0), vec![p(1, 1)]);
        assert_eq!(simplify(&[p(1, 1), p(2, 2)], 1.0), vec![p(1, 1), p(2, 2)]);
    }
}
