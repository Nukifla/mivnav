// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Exact segment-vs-hazard-ring geometry: is a straight chord between two
//! points genuinely clear of every hazard ring's interior?
//!
//! Split out of the old visibility-graph search (`routing::graph`, retired
//! in favor of `routing::raster` — see `ROUTING_TODO.md`'s "raster grid"
//! entry) because [`raster`](super::raster) needs this exact primitive
//! twice: once for the direct-line fast path, and again for string-pulling
//! a raw grid path down to a handful of clean waypoints. Moved verbatim,
//! not rewritten — `visible`'s own docs below record two real, hard-won
//! bugs (a missed hazard near the far end of a long segment; a
//! non-monotonic-margin regression caused by ray-casting a boundary point)
//! that a fresh reimplementation would risk reintroducing.

use crate::coords::WorldXy;
use crate::routing::hazards::rings_contain_scaled;

/// A ring's own axis-aligned bounding box, for the cheap prefilter
/// [`visible`] runs before the real edge-crossing pass.
pub(crate) struct RingBox {
    xmin: i32,
    xmax: i32,
    ymin: i32,
    ymax: i32,
}

impl RingBox {
    pub(crate) fn of(ring: &[WorldXy]) -> RingBox {
        let mut b = RingBox {
            xmin: i32::MAX,
            xmax: i32::MIN,
            ymin: i32::MAX,
            ymax: i32::MIN,
        };
        for p in ring {
            b.xmin = b.xmin.min(p.x);
            b.xmax = b.xmax.max(p.x);
            b.ymin = b.ymin.min(p.y);
            b.ymax = b.ymax.max(p.y);
        }
        b
    }

    /// Does this box overlap the (inclusive) box `(xmin, xmax, ymin, ymax)`?
    pub(crate) fn overlaps(&self, xmin: i32, xmax: i32, ymin: i32, ymax: i32) -> bool {
        self.xmin <= xmax
            && xmax >= xmin
            && self.xmax >= xmin
            && self.ymin <= ymax
            && self.ymax >= ymin
    }
}

/// Is the straight segment `a`→`b` clear of every hazard ring's interior?
///
/// Exact, not sampled — an earlier sampled version of this (fixed sample
/// count along the whole segment) missed a small hazard sitting near one
/// end of a long segment: with the interesting region a tiny fraction of
/// the segment's own length, no fixed sample count can be trusted to land
/// inside it (caught by `a_small_hazard_far_along_a_long_segment_is_not_
/// missed`, in `raster.rs`'s test module — a real bug, not a hypothetical
/// one). This tests every ring edge for a genuine crossing (per-ring
/// bounding-box prefiltered, since a segment can only cross an edge whose
/// own box it touches), and falls back to ONE containment check at the
/// midpoint for the case where two hazard vertices are mutually
/// visible-looking but the chord between them is fully swallowed by a
/// hazard without crossing its boundary (both are vertices of the same
/// convex hazard, non-adjacent). That single sample is enough — with no
/// boundary crossing anywhere, nothing changes classification partway
/// along the segment, so one point decides the whole thing. The midpoint
/// check runs against every ring unfiltered, not just the bbox-relevant
/// ones: point-in-polygon via ray-casting can be affected by a ring far
/// outside the segment's own box (its rightward ray can still cross a
/// distant ring's edges), so bbox-filtering there would be wrong, not
/// just an optimisation choice.
pub(crate) fn visible(
    a: WorldXy,
    b: WorldXy,
    hazard_rings: &[Vec<WorldXy>],
    bboxes: &[RingBox],
) -> bool {
    let (sxmin, sxmax) = (a.x.min(b.x), a.x.max(b.x));
    let (symin, symax) = (a.y.min(b.y), a.y.max(b.y));
    for (ring, bb) in hazard_rings.iter().zip(bboxes) {
        if !bb.overlaps(sxmin, sxmax, symin, symax) {
            continue;
        }
        let n = ring.len();
        for i in 0..n {
            if segments_cross(a, b, ring[i], ring[(i + 1) % n]) {
                return false;
            }
        }
    }
    // Twice the true midpoint, undivided — see `rings_contain_scaled`'s
    // docs on why this must not be rounded to a lattice point first.
    let mid2x = a.x as i64 + b.x as i64;
    let mid2y = a.y as i64 + b.y as i64;
    !rings_contain_scaled(hazard_rings, mid2x, mid2y, 2)
}

/// Do open segments `a1`-`a2` and `b1`-`b2` cross transversally — properly
/// intersect in both segments' interiors, not merely touch at a shared
/// endpoint or run collinear? The latter must read as "not crossing":
/// every candidate edge here legitimately shares an endpoint with the
/// segment being tested whenever that endpoint IS a hazard vertex, and
/// that must never itself count as blocking. Standard four-orientation
/// test (Cormen et al.); exact in `i64` (`WorldXy` is `i32`, so every
/// product fits with room to spare).
pub(crate) fn segments_cross(a1: WorldXy, a2: WorldXy, b1: WorldXy, b2: WorldXy) -> bool {
    fn orientation(p: (i64, i64), q: (i64, i64), r: (i64, i64)) -> i64 {
        (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0)
    }
    let (a1, a2, b1, b2) = (
        (a1.x as i64, a1.y as i64),
        (a2.x as i64, a2.y as i64),
        (b1.x as i64, b1.y as i64),
        (b2.x as i64, b2.y as i64),
    );
    let d1 = orientation(b1, b2, a1);
    let d2 = orientation(b1, b2, a2);
    let d3 = orientation(a1, a2, b1);
    let d4 = orientation(a1, a2, b2);
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}
