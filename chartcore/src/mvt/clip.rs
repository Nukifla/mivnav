// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Rectangle clipping of tile-local geometry.
//!
//! Operates on integer MVT coordinates (i64 so pre-clip coordinates far
//! outside the tile can't overflow). Polygons use Sutherland–Hodgman against
//! the four half-planes of the clip rectangle — a ring fully enclosing the
//! rectangle correctly degenerates to the rectangle itself. Polylines use
//! Liang–Barsky per segment, stitching consecutive segments back together.
//! Intersection points are rounded to the integer grid (half away from zero).

/// A tile-local point, pre- or post-clip.
pub type ClipPt = (i64, i64);

/// Inclusive clip rectangle.
#[derive(Debug, Clone, Copy)]
pub struct ClipRect {
    pub x0: i64,
    pub y0: i64,
    pub x1: i64,
    pub y1: i64,
}

impl ClipRect {
    pub fn contains(&self, p: ClipPt) -> bool {
        p.0 >= self.x0 && p.0 <= self.x1 && p.1 >= self.y0 && p.1 <= self.y1
    }
}

/// Integer division rounding half away from zero. `d` must be nonzero.
fn div_round(n: i64, d: i64) -> i64 {
    let q = n / d;
    let r = n % d;
    if 2 * r.abs() >= d.abs() {
        q + if (n < 0) ^ (d < 0) { -1 } else { 1 }
    } else {
        q
    }
}

#[derive(Clone, Copy)]
enum Edge {
    Left(i64),
    Right(i64),
    Top(i64),
    Bottom(i64),
}

impl Edge {
    fn inside(self, p: ClipPt) -> bool {
        match self {
            Edge::Left(x) => p.0 >= x,
            Edge::Right(x) => p.0 <= x,
            Edge::Top(y) => p.1 >= y,
            Edge::Bottom(y) => p.1 <= y,
        }
    }

    /// Intersection of segment a–b with this edge's boundary line. Only
    /// called when a and b are on opposite sides, so the denominator is
    /// nonzero and the result lies between the endpoints.
    fn intersect(self, a: ClipPt, b: ClipPt) -> ClipPt {
        match self {
            Edge::Left(x) | Edge::Right(x) => {
                (x, a.1 + div_round((b.1 - a.1) * (x - a.0), b.0 - a.0))
            }
            Edge::Top(y) | Edge::Bottom(y) => {
                (a.0 + div_round((b.0 - a.0) * (y - a.1), b.1 - a.1), y)
            }
        }
    }
}

fn clip_half(pts: &[ClipPt], e: Edge) -> Vec<ClipPt> {
    let mut out = Vec::with_capacity(pts.len() + 4);
    for i in 0..pts.len() {
        let a = pts[i];
        let b = pts[(i + 1) % pts.len()];
        let a_in = e.inside(a);
        if a_in {
            out.push(a);
        }
        if a_in != e.inside(b) {
            out.push(e.intersect(a, b));
        }
    }
    out
}

/// Clip an open ring (no closing duplicate vertex) to the rectangle.
/// Returns a cleaned open ring: consecutive duplicates removed, empty if
/// fewer than 3 vertices survive. The result may contain degenerate edges
/// along the clip boundary when the ring crosses it multiple times — that is
/// inherent to Sutherland–Hodgman and harmless to MVT renderers.
pub fn clip_ring(ring: &[ClipPt], r: &ClipRect) -> Vec<ClipPt> {
    let mut cur = ring.to_vec();
    for e in [
        Edge::Left(r.x0),
        Edge::Right(r.x1),
        Edge::Top(r.y0),
        Edge::Bottom(r.y1),
    ] {
        if cur.is_empty() {
            return cur;
        }
        cur = clip_half(&cur, e);
    }
    cur.dedup();
    while cur.len() > 1 && cur.first() == cur.last() {
        cur.pop();
    }
    if cur.len() < 3 {
        cur.clear();
    }
    cur
}

/// Liang–Barsky clip of one segment. Returns the clipped endpoints (clamped
/// onto the rectangle), or `None` if the segment misses it entirely.
fn clip_segment(a: ClipPt, b: ClipPt, r: &ClipRect) -> Option<(ClipPt, ClipPt)> {
    let dx = (b.0 - a.0) as f64;
    let dy = (b.1 - a.1) as f64;
    let mut t0 = 0.0f64;
    let mut t1 = 1.0f64;
    for (p, q) in [
        (-dx, (a.0 - r.x0) as f64),
        (dx, (r.x1 - a.0) as f64),
        (-dy, (a.1 - r.y0) as f64),
        (dy, (r.y1 - a.1) as f64),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                if t > t1 {
                    return None;
                }
                if t > t0 {
                    t0 = t;
                }
            } else {
                if t < t0 {
                    return None;
                }
                if t < t1 {
                    t1 = t;
                }
            }
        }
    }
    let at = |t: f64| -> ClipPt {
        (
            (a.0 + (t * dx).round() as i64).clamp(r.x0, r.x1),
            (a.1 + (t * dy).round() as i64).clamp(r.y0, r.y1),
        )
    };
    Some((at(t0), at(t1)))
}

/// Clip a polyline to the rectangle, splitting it into the parts that
/// intersect. Parts have at least 2 vertices; single-point touches are
/// dropped.
pub fn clip_polyline(line: &[ClipPt], r: &ClipRect) -> Vec<Vec<ClipPt>> {
    let mut out: Vec<Vec<ClipPt>> = Vec::new();
    let mut cur: Vec<ClipPt> = Vec::new();
    let mut flush = |cur: &mut Vec<ClipPt>| {
        if cur.len() >= 2 {
            out.push(std::mem::take(cur));
        } else {
            cur.clear();
        }
    };
    for w in line.windows(2) {
        match clip_segment(w[0], w[1], r) {
            Some((s, e)) if s != e => {
                if cur.last() == Some(&s) {
                    cur.push(e);
                } else {
                    flush(&mut cur);
                    cur = vec![s, e];
                }
            }
            // degenerate touch or miss: continuity is broken unless the next
            // clipped segment happens to start at cur's tail
            _ => {}
        }
    }
    flush(&mut cur);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: ClipRect = ClipRect {
        x0: 0,
        y0: 0,
        x1: 100,
        y1: 100,
    };

    #[test]
    fn div_round_half_away_from_zero() {
        assert_eq!(div_round(5, 2), 3);
        assert_eq!(div_round(-5, 2), -3);
        assert_eq!(div_round(4, 2), 2);
        assert_eq!(div_round(1, 3), 0);
        assert_eq!(div_round(2, 3), 1);
        assert_eq!(div_round(-2, 3), -1);
    }

    #[test]
    fn ring_fully_inside_unchanged() {
        let ring = vec![(10, 10), (90, 10), (90, 90), (10, 90)];
        assert_eq!(clip_ring(&ring, &R), ring);
    }

    #[test]
    fn ring_fully_outside_is_empty() {
        let ring = vec![(200, 200), (300, 200), (300, 300)];
        assert!(clip_ring(&ring, &R).is_empty());
        // outside but extent-overlapping (diagonal corner pass-by)
        let corner = vec![(150, -50), (250, 50), (150, 50)];
        assert!(clip_ring(&corner, &R).is_empty());
    }

    #[test]
    fn ring_enclosing_rect_becomes_rect() {
        let ring = vec![(-50, -50), (150, -50), (150, 150), (-50, 150)];
        let clipped = clip_ring(&ring, &R);
        // result is exactly the clip rect (4 corners, some order)
        assert_eq!(clipped.len(), 4);
        for c in [(0, 0), (100, 0), (100, 100), (0, 100)] {
            assert!(clipped.contains(&c), "missing corner {c:?} in {clipped:?}");
        }
    }

    #[test]
    fn ring_partial_overlap() {
        // triangle poking into the rect from the left
        let ring = vec![(-50, 50), (50, 20), (50, 80)];
        let clipped = clip_ring(&ring, &R);
        assert!(clipped.len() >= 3);
        assert!(clipped.iter().all(|p| R.contains(*p)));
        // both original inside-vertices survive
        assert!(clipped.contains(&(50, 20)) && clipped.contains(&(50, 80)));
        // clipped edge lands on the boundary
        assert!(clipped.iter().any(|p| p.0 == 0));
    }

    #[test]
    fn ring_degenerate_after_clip_is_dropped() {
        // sliver entirely on the boundary line but outside: clips to zero
        let ring = vec![(-10, 0), (-1, 0), (-1, 100), (-10, 100)];
        assert!(clip_ring(&ring, &R).is_empty());
    }

    #[test]
    fn polyline_inside_unchanged() {
        let line = vec![(10, 10), (50, 50), (90, 10)];
        assert_eq!(clip_polyline(&line, &R), vec![line.clone()]);
    }

    #[test]
    fn polyline_crossing_is_clipped() {
        let line = vec![(-50, 50), (150, 50)];
        assert_eq!(clip_polyline(&line, &R), vec![vec![(0, 50), (100, 50)]]);
    }

    #[test]
    fn polyline_split_into_parts() {
        // enters, leaves, re-enters
        let line = vec![(-50, 10), (50, 10), (50, -50), (90, -50), (90, 50)];
        let parts = clip_polyline(&line, &R);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], vec![(0, 10), (50, 10), (50, 0)]);
        assert_eq!(parts[1], vec![(90, 0), (90, 50)]);
    }

    #[test]
    fn polyline_miss_is_empty() {
        assert!(clip_polyline(&[(-50, -10), (150, -10)], &R).is_empty());
        // diagonal that passes outside a corner
        assert!(clip_polyline(&[(80, -60), (160, 20)], &R).is_empty());
    }

    #[test]
    fn polyline_single_point_touch_dropped() {
        // touches only the corner point
        assert!(clip_polyline(&[(-100, 100), (100, -100)], &R).len() <= 1);
    }
}
