// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Removing the geometry a more detailed cell is already charting: each
//! cell's geometry is cut back to `coverage_c − ⋃(coverage of every finer
//! selected cell)`. See docs/architecture/coverage-masking.md for the
//! measurement (harbour tiles composite 5+ generalizations of one contour)
//! and why ordering / a per-cell over-claim can't fix it instead.

use geo::{BooleanOps, BoundingRect, Contains};
use geo::{Coord, LineString, MultiLineString, MultiPolygon, Point, Polygon};

use crate::geom_log;

use super::encode::{MvtFeature, MvtGeometry};
use super::{
    cov_rings_at_zoom, oriented, project, ring_to_tile, signed_area2, tile_origin, unwrapped_col,
};
use super::{tile_range, BUFFERED_RECT};
use crate::coords::{WorldXy, COORD_ZOOM_LEVEL};
use crate::coverage::{signed_area2_world, Coverage};

/// Integer tile-local bounding box.
type BBox = (i64, i64, i64, i64); // xmin, xmax, ymin, ymax

/// MVT layers whose polygon rings are stroked by the style, so a partial cut
/// would render a fabricated closing edge as a charted limit — these stay
/// all-or-nothing (backlog #sttooosq) instead. Derivation and sources to
/// re-derive the set: docs/architecture/outlined-area-layers.md.
const OUTLINED_AREA_LAYERS: &[&str] = &[
    // aidsHazards.ts restricted-group boundaries
    "RESARE", "ACHARE", "CTNARE", "MIPARE", "DMPGRD", "CBLARE", "PIPARE", "ISTZNE", "PRCARE",
    "FAIRWY", "MARCUL", "CTSARE", "FERYRT", //
    // aidsHazards.ts hazard-area edges
    "OBSTRN", "WRECKS", //
    // industrial.ts / lndmrk.ts / sbdare.ts
    "SILTNK", "PRDARE", "LNDMRK", "SBDARE", //
    // chartStyle.ts unfiltered line layers
    "UNSARE", "DRGARE", "SLCONS",
];

/// Does the style stroke this layer's polygon rings? See
/// [`OUTLINED_AREA_LAYERS`].
fn outline_symbolized(layer: &str) -> bool {
    OUTLINED_AREA_LAYERS.contains(&layer)
}

/// The region of one tile that more detailed cells already chart.
pub struct TileMask {
    geom: MultiPolygon,
    bbox: BBox,
}

fn ring_bbox(pts: &[(i64, i64)]) -> BBox {
    let mut b = (i64::MAX, i64::MIN, i64::MAX, i64::MIN);
    for &(x, y) in pts {
        b.0 = b.0.min(x);
        b.1 = b.1.max(x);
        b.2 = b.2.min(y);
        b.3 = b.3.max(y);
    }
    b
}

fn bbox_union(a: BBox, b: BBox) -> BBox {
    (a.0.min(b.0), a.1.max(b.1), a.2.min(b.2), a.3.max(b.3))
}

fn bbox_disjoint(a: BBox, b: BBox) -> bool {
    a.1 < b.0 || b.1 < a.0 || a.3 < b.2 || b.3 < a.2
}

fn bbox_contains(outer: BBox, inner: BBox) -> bool {
    outer.0 <= inner.0 && outer.1 >= inner.1 && outer.2 <= inner.2 && outer.3 >= inner.3
}

/// A minimal one-MVT-unit square at `ring`'s (world-space) centroid,
/// projected into this tile — the fallback representation for a declared
/// no-coverage ring too small to survive integer clipping at this zoom (see
/// the [`TileMask::new`] call site). `None` when the projected centroid does
/// not land in or near the buffered tile rect at all — the ring is simply
/// elsewhere, not sub-pixel *here*, and must not fabricate a hole in a tile
/// it has nothing to do with.
fn minimal_hole_square(ring: &[WorldXy], origin: (i64, i64), zoom: u8) -> Option<Polygon> {
    let n = ring.len().max(1) as i64;
    let (sx, sy) = ring.iter().fold((0i64, 0i64), |(sx, sy), p| {
        (sx + p.x as i64, sy + p.y as i64)
    });
    let centroid = WorldXy::new((sx / n) as i32, (sy / n) as i32);
    let (cx, cy) = project(centroid, origin, zoom);
    if !(BUFFERED_RECT.x0 - 1..=BUFFERED_RECT.x1 + 1).contains(&cx)
        || !(BUFFERED_RECT.y0 - 1..=BUFFERED_RECT.y1 + 1).contains(&cy)
    {
        return None;
    }
    int_polygon(&[(cx, cy), (cx + 1, cy), (cx + 1, cy + 1), (cx, cy + 1)])
}

/// One single-ring polygon from tile-local integer points, or `None` when
/// they cannot form one (fewer than three points). `geo`/`i_overlay` closes
/// the ring itself and tolerates whatever winding the points arrive in — the
/// overlay orients rings from their slot (exterior vs interior), not from
/// their signed area — so nothing is normalized here.
fn int_polygon(pts: &[(i64, i64)]) -> Option<Polygon> {
    if pts.len() < 3 {
        return None;
    }
    Some(Polygon::new(int_ring(pts), vec![]))
}

/// A `geo` ring from tile-local integer points.
fn int_ring(pts: &[(i64, i64)]) -> LineString {
    LineString::new(
        pts.iter()
            .map(|&(x, y)| Coord {
                x: x as f64,
                y: y as f64,
            })
            .collect(),
    )
}

/// `a − b`. GEOS rejected self-touching/pinched input (what our own rect
/// clipping strands) until repaired; `i_overlay` nodes and re-polygonizes it
/// as part of the overlay, so this is one infallible call — no repair needed.
fn difference(a: &MultiPolygon, b: &MultiPolygon) -> MultiPolygon {
    a.difference(b)
}

/// The polygons of one MVT ring set — "each exterior followed by its
/// interiors" ([`MvtGeometry::Polygons`]) — appended to `out`. A ring too
/// short to form one is skipped rather than fatal: a smaller polygon set
/// removes less, which is the safe direction for a mask. Holes only ever
/// attach to the exterior in progress, so a dropped exterior drops its holes
/// with it.
fn ring_set_polygons(rings: &[Vec<(i32, i32)>], out: &mut Vec<Polygon>) {
    let mut exterior: Option<LineString> = None;
    let mut holes: Vec<LineString> = Vec::new();
    for ring in rings {
        let pts: Vec<(i64, i64)> = ring.iter().map(|&(a, b)| (a as i64, b as i64)).collect();
        if pts.len() < 3 {
            continue;
        }
        if signed_area2(&pts) > 0 {
            if let Some(ext) = exterior.take() {
                out.push(Polygon::new(ext, std::mem::take(&mut holes)));
            }
            exterior = Some(int_ring(&pts));
        } else if exterior.is_some() {
            holes.push(int_ring(&pts));
        }
    }
    if let Some(ext) = exterior.take() {
        out.push(Polygon::new(ext, holes));
    }
}

/// A multipolygon from an MVT ring set, or `None` when it has no usable
/// polygon (all rings too short) — the safe "removes less" direction.
fn ring_set_multipolygon(rings: &[Vec<(i32, i32)>]) -> Option<MultiPolygon> {
    let mut polys = Vec::new();
    ring_set_polygons(rings, &mut polys);
    (!polys.is_empty()).then_some(MultiPolygon(polys))
}

/// A multilinestring from MVT line parts, or `None` when none has two points.
fn parts_multilinestring(parts: &[Vec<(i32, i32)>]) -> Option<MultiLineString> {
    let lines: Vec<LineString> = parts
        .iter()
        .filter(|p| p.len() >= 2)
        .map(|p| {
            LineString::new(
                p.iter()
                    .map(|&(x, y)| Coord {
                        x: x as f64,
                        y: y as f64,
                    })
                    .collect(),
            )
        })
        .collect();
    (!lines.is_empty()).then_some(MultiLineString(lines))
}

/// Dissolves several features' polygon rings into one, so overlapping
/// no-coverage claims blend once under MapLibre's per-feature fill instead of
/// compositing darker per claim — see docs/architecture/coverage-masking.md.
/// `None` on failure; callers must keep the originals (a dropped claim shows
/// basemap through it, the one direction this must never fail in).
pub(super) fn dissolve(features: &[Vec<Vec<(i32, i32)>>]) -> Option<Vec<Vec<(i32, i32)>>> {
    // One `unary_union` over all claims' polygons merges overlaps AND resolves
    // the self-touching rings our own tile-rect clipping produces — no separate
    // repair pass, unlike the old GEOS `buffer(0)`/`unary_union` two-step.
    let mut polys: Vec<Polygon> = Vec::new();
    for rings in features {
        ring_set_polygons(rings, &mut polys);
    }
    if polys.is_empty() {
        return geom_log::note(None, "dissolve: no usable polygon in the claims");
    }
    let dissolved = geo::unary_union(&polys);
    let mut out = Vec::new();
    multipolygon_rings(&dissolved, &mut out);
    geom_log::note(
        (!out.is_empty()).then_some(out),
        "dissolve: unary_union produced nothing",
    )
}

/// Collect every ring of a multipolygon as tile-local ints, re-wound to the
/// MVT rule: exteriors positive area, holes negative. `geo` exposes a
/// polygon's exterior and interior rings separately, so the exterior/hole
/// split is read from the API rather than from ring index or winding.
fn multipolygon_rings(mp: &MultiPolygon, out: &mut Vec<Vec<(i32, i32)>>) {
    for poly in &mp.0 {
        push_ring(poly.exterior(), true, out);
        for hole in poly.interiors() {
            push_ring(hole, false, out);
        }
    }
}

/// One ring's vertices as tile-local ints, re-wound to `exterior`.
fn push_ring(ring: &LineString, exterior: bool, out: &mut Vec<Vec<(i32, i32)>>) {
    let mut pts: Vec<(i64, i64)> = ring
        .0
        .iter()
        .map(|c| (c.x.round() as i64, c.y.round() as i64))
        .collect();
    // `geo` repeats the first point to close a ring; MVT does not carry it
    if pts.len() > 1 && pts.first() == pts.last() {
        pts.pop();
    }
    let a2 = signed_area2(&pts);
    if pts.len() < 3 || a2 == 0 {
        return;
    }
    out.push(oriented(pts, a2, exterior));
}

/// Collect every linestring of a multilinestring as tile-local ints.
fn multiline_parts(ml: &MultiLineString, out: &mut Vec<Vec<(i32, i32)>>) {
    for ls in &ml.0 {
        let pts: Vec<(i32, i32)> =
            ls.0.iter()
                .map(|c| (c.x.round() as i32, c.y.round() as i32))
                .collect();
        if pts.len() >= 2 {
            out.push(pts);
        }
    }
}

impl TileMask {
    /// The union of `covers`' coverage over tile `zoom`/`x`/`y`, in
    /// tile-local MVT coordinates. `None` when they cover nothing here —
    /// which is the signal to skip masking entirely rather than to mask
    /// with an empty geometry.
    pub fn new(covers: &[&Coverage], zoom: u8, x: u32, y: u32) -> Option<TileMask> {
        if covers.is_empty() || (zoom as u32) > COORD_ZOOM_LEVEL {
            return None;
        }
        let n = 1i64 << zoom;
        // Each cell's region (coverage ∩ tile), collected and dissolved at the
        // end. A single `unary_union` over the lot is both the union across
        // cells and the final repair pass — cheaper and more robust than
        // folding pairwise.
        let mut regions: Vec<Polygon> = Vec::new();
        for cov in covers {
            let Some(rings) = cov_rings_at_zoom(cov, zoom) else {
                continue;
            };
            let ext = &cov.extent;
            let (txs, tys) = tile_range(
                (
                    ext.xmin as i64,
                    ext.xmax as i64,
                    ext.ymin as i64,
                    ext.ymax as i64,
                ),
                zoom,
            );
            if !tys.contains(&(y as i64)) {
                continue;
            }
            let Some(tx) = unwrapped_col(&txs, x, n) else {
                continue;
            };
            let origin = tile_origin(tx, y as i64, zoom);
            // A cell's coverage is one flat ring set under the nonzero
            // winding rule (crate::coverage): positive rings chart, negative
            // rings un-chart. The boolean engine has no such rule, so it is
            // rebuilt as union(positive) − union(negative), which is the same
            // region for the non-overlapping M_COVR S-57 guarantees.
            let mut adds: Vec<Polygon> = Vec::new();
            let mut subs: Vec<Polygon> = Vec::new();
            for ring in &rings {
                let clipped = ring_to_tile(ring, origin, zoom, &BUFFERED_RECT);
                let a2 = signed_area2(&clipped);
                if clipped.len() < 3 || a2 == 0 {
                    // Collapsed under integer rounding to the MVT grid. A dropped
                    // NEGATIVE (declared-uncovered) ring must still remove the one
                    // point it rounds to, or coverage over-claims ground the cell
                    // declared it doesn't chart — see coverage-masking.md (kkkqkumv).
                    if signed_area2_world(ring) < 0 {
                        if let Some(square) = minimal_hole_square(ring, origin, zoom) {
                            subs.push(square);
                        }
                    }
                    continue;
                }
                let Some(poly) = int_polygon(&clipped) else {
                    continue;
                };
                if a2 > 0 {
                    adds.push(poly);
                } else {
                    subs.push(poly);
                }
            }
            if adds.is_empty() {
                continue;
            }
            let region = geo::unary_union(&adds);
            let region = if subs.is_empty() {
                region
            } else {
                difference(&region, &geo::unary_union(&subs))
            };
            regions.extend(region.0);
        }
        if regions.is_empty() {
            return None;
        }
        let geom = geo::unary_union(&regions);
        if geom.0.is_empty() {
            return None;
        }
        // `bounding_rect` gives the envelope bounds directly, so no envelope
        // geometry is built just to read four numbers off it. A mask whose
        // bounds cannot be read is skipped (no mask), the safe direction.
        let bb = geom.bounding_rect()?;
        Some(TileMask {
            bbox: (
                bb.min().x.floor() as i64,
                bb.max().x.ceil() as i64,
                bb.min().y.floor() as i64,
                bb.max().y.ceil() as i64,
            ),
            geom,
        })
    }

    /// `feature` with everything the mask covers removed, or `None` when
    /// nothing of it survives.
    ///
    /// `layer` is the MVT layer the feature will land in (`super::layer_name`).
    /// It only matters for polygons, where it decides between a true partial
    /// cut and the all-or-nothing rule — see [`OUTLINED_AREA_LAYERS`].
    ///
    /// The bbox tests before each boolean are what makes this affordable:
    /// most features of a masked cell are nowhere near the finer cell's
    /// footprint and are returned untouched.
    pub fn subtract(&self, layer: &str, mut feature: MvtFeature) -> Option<MvtFeature> {
        feature.geom = match feature.geom {
            MvtGeometry::Points(pts) => {
                let kept: Vec<(i32, i32)> = pts
                    .into_iter()
                    .filter(|&(px, py)| {
                        let p = (px as i64, py as i64);
                        if bbox_disjoint(self.bbox, (p.0, p.0, p.1, p.1)) {
                            return true; // nowhere near the mask
                        }
                        !self.covers_point(px, py)
                    })
                    .collect();
                if kept.is_empty() {
                    return None;
                }
                MvtGeometry::Points(kept)
            }
            MvtGeometry::Lines(parts) => {
                let bbox = parts
                    .iter()
                    .map(|p| {
                        ring_bbox(
                            &p.iter()
                                .map(|&(a, b)| (a as i64, b as i64))
                                .collect::<Vec<_>>(),
                        )
                    })
                    .reduce(bbox_union)?;
                if bbox_disjoint(self.bbox, bbox) {
                    // untouched: no boolean
                    feature.geom = MvtGeometry::Lines(parts);
                    return Some(feature);
                }
                let Some(ml) = geom_log::note(
                    parts_multilinestring(&parts),
                    "line feature had no usable part",
                ) else {
                    // construction failed — keep the original rather than
                    // silently drop chart data (fail safe)
                    feature.geom = MvtGeometry::Lines(parts);
                    return Some(feature);
                };
                // `clip(_, invert=true)` keeps the part of the line OUTSIDE the
                // mask — the line difference. Drawing a line twice is a cosmetic
                // bug; not drawing it is a safety one, so if the clip returns
                // nothing but the geometry was non-degenerate we still let the
                // empty result stand only when it is genuinely all inside.
                let clipped = self.geom.clip(&ml, true);
                let mut out = Vec::new();
                multiline_parts(&clipped, &mut out);
                if out.is_empty() {
                    return None; // genuinely all inside the finer cell
                }
                MvtGeometry::Lines(out)
            }
            MvtGeometry::Polygons(rings) => {
                let bbox = rings
                    .iter()
                    .map(|p| {
                        ring_bbox(
                            &p.iter()
                                .map(|&(a, b)| (a as i64, b as i64))
                                .collect::<Vec<_>>(),
                        )
                    })
                    .reduce(bbox_union)?;
                if bbox_disjoint(self.bbox, bbox) {
                    // untouched: no boolean
                    feature.geom = MvtGeometry::Polygons(rings);
                    return Some(feature);
                }
                // "each exterior followed by its interiors" (MvtGeometry)
                let Some(mp) = geom_log::note(
                    ring_set_multipolygon(&rings),
                    "polygon feature had no usable ring",
                ) else {
                    // construction failed — keep the original (fail safe)
                    feature.geom = MvtGeometry::Polygons(rings);
                    return Some(feature);
                };
                // A partial difference closes its surviving ring with a NEW
                // straight edge along the mask boundary, which reads as a
                // fabricated charted limit for stroked classes (#sttooosq) —
                // see docs/architecture/coverage-masking.md. [`OUTLINED_AREA_LAYERS`]
                // stays all-or-nothing; everything else is cut for real.
                let diff = difference(&mp, &self.geom);
                if diff.0.is_empty() {
                    return None; // genuinely all inside the finer cell
                }
                if outline_symbolized(layer) {
                    feature.geom = MvtGeometry::Polygons(rings);
                    return Some(feature);
                }
                let mut cut = Vec::new();
                multipolygon_rings(&diff, &mut cut);
                if cut.is_empty() {
                    // the difference was non-empty but every ring degenerated
                    // on the way back to integer tile coordinates — keep the
                    // original rather than lose a charted area (fail safe)
                    feature.geom = MvtGeometry::Polygons(rings);
                    return Some(feature);
                }
                MvtGeometry::Polygons(cut)
            }
        };
        Some(feature)
    }

    fn covers_point(&self, x: i32, y: i32) -> bool {
        self.geom.contains(&Point::new(x as f64, y as f64))
    }
}

/// Do the two coverage world extents overlap? Extents are a *superset* of the
/// rings, so a false "overlap" only costs a wasted boolean and a false "no
/// overlap" is impossible for genuinely overlapping rings — the safe direction
/// for the fast path below. Invalid extents (a coverage with no rings) never
/// overlap.
fn extents_overlap(a: &crate::coords::Extent, b: &crate::coords::Extent) -> bool {
    if !a.valid || !b.valid {
        return false;
    }
    !(a.xmax < b.xmin || b.xmax < a.xmin || a.ymax < b.ymin || b.ymax < a.ymin)
}

/// Does `cov` keep any renderable ground in tile `zoom`/`x`/`y` once `finer`
/// coverage is subtracted — the per-region authority test selection runs
/// beneath [`super::coverage_tile_state`]. Same region algebra [`TileMask`]
/// cuts geometry by, so what selection keeps and what the cut draws agree by
/// construction. Conservative in the SAFE direction: returns `true` (keep)
/// unless fully masked is *provable* — over-claiming "masked" would drop real
/// chart and leave a hole. See docs/architecture/coverage-masking.md.
pub(crate) fn coverage_has_residual_in_tile(
    cov: &Coverage,
    finer: &[&Coverage],
    zoom: u8,
    x: u32,
    y: u32,
) -> bool {
    // Fast path, no geometry: if no finer coverage's world extent even overlaps
    // the candidate's, nothing finer can mask it anywhere, least of all in one
    // tile. The common case on a real set, and the gate the hot loop leans on.
    if !finer
        .iter()
        .any(|f| extents_overlap(&cov.extent, &f.extent))
    {
        return true;
    }
    // The candidate's own region in the tile. When it cannot be built as a
    // polygon — coverage sub-unit at this zoom, or every ring clips away —
    // nothing can be *proven* masked, so keep the cell (the safe direction).
    let Some(cand) = TileMask::new(&[cov], zoom, x, y) else {
        return true;
    };
    // The finer union's region in the tile. `TileMask::new` skips finer cells
    // that do not reach the tile (a cheap tile-range test, no boolean) and
    // returns None when none of them do — nothing to subtract, so keep.
    let Some(mask) = TileMask::new(finer, zoom, x, y) else {
        return true;
    };
    // Cheap gate before the boolean: if the finer union's bbox does not enclose
    // the candidate's, some of the candidate lies outside it, so there is
    // residual by inspection — no difference needed.
    if !bbox_contains(mask.bbox, cand.bbox) {
        return true;
    }
    // The candidate is bbox-enclosed by the finer coverage: pay for the one
    // difference. Non-empty residual ⇒ the candidate charts ground no finer
    // cell does ⇒ keep. i_overlay resolves the self-touching rings rect
    // clipping strands (see `difference`), so this is one infallible call.
    !difference(&cand.geom, &mask.geom).0.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{lat_lon_to_world, WorldXy};
    use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry, Polygon};
    use crate::mvt::decode::decode_tile;
    use crate::mvt::CellTiler;
    use std::collections::BTreeMap;

    const Z: u8 = 14;
    // a patch of the Øresund off Helsingør, the tile the doubling was
    // measured on
    const LAT: f64 = 56.036;
    const LON: f64 = 12.615;

    fn ring(s: f64, n: f64, w: f64, e: f64) -> Vec<WorldXy> {
        vec![
            lat_lon_to_world(n, w),
            lat_lon_to_world(n, e),
            lat_lon_to_world(s, e),
            lat_lon_to_world(s, w),
            lat_lon_to_world(n, w),
        ]
    }

    fn m_covr(catcov: i64, s: f64, n: f64, w: f64, e: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("CATCOV".to_string(), AttrValue::Int(catcov));
        Feature::new(
            302,
            "M_COVR".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring(s, n, w, e),
                holes: vec![],
            }])),
        )
    }

    /// A regular n-gon approximating a circle, closed like `ring()`. Good
    /// enough to tell "still curved" from "clipped along a straight line" —
    /// exactness of the geographic circle does not matter, only that no
    /// three consecutive points are ever collinear along the coverage seam.
    fn circle(lat: f64, lon: f64, r: f64, n: usize) -> Vec<WorldXy> {
        (0..=n)
            .map(|i| {
                let theta = std::f64::consts::TAU * (i as f64) / (n as f64);
                lat_lon_to_world(lat + r * theta.sin(), lon + r * theta.cos())
            })
            .collect()
    }

    /// A restricted-area-shaped polygon (S-52 draws RESARE's own ring as a
    /// dashed boundary line, aidsHazards.ts) straddling the harbour cell's
    /// coverage boundary — the repro shape for backlog #sttooosq.
    fn resare(lat: f64, lon: f64, r: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("CATREA".to_string(), AttrValue::Int(1));
        Feature::new(
            302,
            "RESARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: circle(lat, lon, r, 24),
                holes: vec![],
            }])),
        )
    }

    /// A depth contour running west→east across the whole patch — the line
    /// both cells generalize and both used to draw.
    fn depcnt(lat: f64, w: f64, e: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("VALDCO".to_string(), AttrValue::Float(10.0));
        Feature::new(
            43,
            "DEPCNT".into(),
            attrs,
            Some(Geometry::Lines(vec![vec![
                lat_lon_to_world(lat, w),
                lat_lon_to_world(lat, e),
            ]])),
        )
    }

    /// A depth-area-shaped polygon — same circle as [`resare`], but in a class
    /// nothing in the style strokes (chartStyle.ts gives DEPARE a `fill` and no
    /// edge layer). The counterpart shape: this one MUST be cut for real.
    fn depare(lat: f64, lon: f64, r: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("DRVAL1".to_string(), AttrValue::Float(5.0));
        attrs.insert("DRVAL2".to_string(), AttrValue::Float(10.0));
        Feature::new(
            42,
            "DEPARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: circle(lat, lon, r, 24),
                holes: vec![],
            }])),
        )
    }

    /// An M_COVR whose ring is an arbitrary polygon, not a rectangle — so the
    /// coverage it yields is a real declaration and not
    /// [`Coverage::is_extent_box`].
    fn m_covr_ring(catcov: i64, ring: Vec<WorldXy>) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("CATCOV".to_string(), AttrValue::Int(catcov));
        Feature::new(
            302,
            "M_COVR".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring,
                holes: vec![],
            }])),
        )
    }

    /// A rectangular depth area, in the fill-only class the style never
    /// strokes — the base fill whose absence reads as no chart data at all.
    fn depare_rect(s: f64, n: f64, w: f64, e: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("DRVAL1".to_string(), AttrValue::Float(5.0));
        attrs.insert("DRVAL2".to_string(), AttrValue::Float(10.0));
        Feature::new(
            42,
            "DEPARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring(s, n, w, e),
                holes: vec![],
            }])),
        )
    }

    /// Tile-local x of a longitude, in MVT units.
    fn tile_x_of(lon: f64, x: u32) -> i32 {
        let wpt = super::super::world_per_tile(Z);
        let origin = crate::coords::WORLD_MIN as i64 + x as i64 * wpt;
        let wx = lat_lon_to_world(LAT, lon).x as i64;
        ((wx - origin) * super::super::EXTENT as i64 / wpt) as i32
    }

    /// Smallest tile-local x any polygon of `layer` reaches, or `None`.
    fn min_poly_x(tile: &[u8], layer: &str) -> Option<i32> {
        let t = decode_tile(tile).ok()?;
        let l = t.layer(layer)?;
        l.features
            .iter()
            .flat_map(|f| f.parts.iter())
            .flat_map(|p| p.iter())
            .map(|&(px, _)| px)
            .min()
    }

    /// REPRO (#ymwnqnmr, reported from the boat): where two chart sets overlap
    /// the tile came out with NO base fill at all, and because no-coverage is
    /// deliberately unpainted the mariner saw the OSM basemap through it.
    ///
    /// The shape, from the real union tile 8/137/81: a freenauticalchart German
    /// 1:90k cell declares its coverage as one extent RECTANGLE (all 314 of
    /// them do) while its geometry stops at the DE/DK maritime boundary; the
    /// o-charts Danish 1:180k cell beside it declares an 802-point ring that
    /// follows that boundary and charts the water on the far side. Being
    /// strictly finer, the German box both silenced the Danish cell in
    /// `authority` and masked it in the cut — deleting 93% of its declared
    /// coverage on that tile, on the strength of a claim its owner charts none
    /// of. Nobody painted the wedge.
    ///
    /// Here: `boxy` declares the whole patch and charts only its eastern half;
    /// `honest` declares a triangle in the west and charts it. The merged tile
    /// must still have DEPARE west of where `boxy`'s data stops.
    #[test]
    fn a_bare_extent_box_does_not_delete_the_chart_beside_it() {
        use crate::mvt::merge::merge_tiles;
        use crate::mvt::select::{select, CellDesc, Knobs};
        let (x, y) = tile_xy();
        const EDGE: f64 = 12.625; // where boxy's geometry stops
        const WEST: f64 = 12.60;
        const EAST: f64 = 12.63;
        const S: f64 = 56.02;
        const N: f64 = 56.05;

        // The over-claiming finer cell: coverage is exactly its extent box.
        let boxy = cell(vec![
            m_covr(1, S, N, WEST, EAST),
            depare_rect(S, N, EDGE, EAST),
        ]);
        let boxy_cov = crate::coverage::cell_coverage(&boxy).unwrap();
        assert!(
            boxy_cov.is_extent_box(),
            "the repro needs a coverage that is nothing but the extent box"
        );

        // The coarser cell that actually charts the west. Its ring is the same
        // patch with one corner cut off — a real declaration rather than a
        // bounding box, which is the whole of what tells the two apart.
        let ring_with_a_corner_cut = vec![
            lat_lon_to_world(N, WEST),
            lat_lon_to_world(N, EAST - 0.004),
            lat_lon_to_world(N - 0.004, EAST),
            lat_lon_to_world(S, EAST),
            lat_lon_to_world(S, WEST),
            lat_lon_to_world(N, WEST),
        ];
        let honest = cell(vec![
            m_covr_ring(1, ring_with_a_corner_cut),
            depare_rect(S, N, WEST, EDGE),
        ]);
        let honest_cov = crate::coverage::cell_coverage(&honest).unwrap();
        assert!(!honest_cov.is_extent_box());

        let cells = [
            CellDesc {
                scale: 180_000,
                max_zoom: 12,
                name: "HONEST",
                coverage: Some(&honest_cov),
            },
            CellDesc {
                scale: 90_000,
                max_zoom: 13,
                name: "BOXY",
                coverage: Some(&boxy_cov),
            },
        ];
        let knobs = Knobs {
            over_zoom: 6,
            under_zoom: 2,
            detail_gap: 1,
            overview_detail_cutoff: 6,
            max_cells: 128,
        };
        let sel = select(&cells, Z, x, y, &knobs);
        assert_eq!(
            sel.kept.len(),
            2,
            "a bare box may not silence the cell that charts the ground: kept {:?}",
            sel.kept.iter().map(|&i| cells[i].name).collect::<Vec<_>>()
        );

        let tilers = [CellTiler::new(honest.clone()), CellTiler::new(boxy.clone())];
        let mut cuts = Vec::new();
        for (pos, &ci) in sel.kept.iter().enumerate() {
            let finer: Vec<&crate::coverage::Coverage> = sel.masks[pos]
                .iter()
                .map(|&j| if j == 0 { &honest_cov } else { &boxy_cov })
                .collect();
            if let Some(d) = tilers[ci].cut_with(Z, x, y, &finer) {
                cuts.push(d);
            }
        }
        let merged = merge_tiles(&cuts).unwrap();

        let edge_x = tile_x_of(EDGE, x);
        let min_x =
            min_poly_x(&merged, "DEPARE").expect("the merged tile must carry a base fill at all");
        assert!(
            min_x < edge_x - 8,
            "the wedge west of {EDGE} must still be painted: DEPARE reaches \
             x={min_x}, boxy's data edge is x={edge_x} — a bare extent box \
             deleted the chart beside it"
        );
    }

    fn cell(features: Vec<Feature>) -> Cell {
        let mut cell = Cell {
            meta: CellMeta::default(),
            features,
            extent: Default::default(),
        };
        for f in &cell.features {
            let e = f.extent;
            cell.extent.extend(&e);
        }
        cell
    }

    fn tile_xy() -> (u32, u32) {
        let w = lat_lon_to_world(LAT, LON);
        let wpt = super::super::world_per_tile(Z);
        let min = crate::coords::WORLD_MIN as i64;
        (
            ((w.x as i64 - min) / wpt) as u32,
            ((w.y as i64 - min) / wpt) as u32,
        )
    }

    /// Total x-extent of a layer's line geometry, in MVT units — the thing
    /// the user sees doubled, and unlike a vertex count it shrinks when a
    /// line is merely truncated.
    fn line_span(tile: &[u8], layer: &str) -> i64 {
        let Ok(t) = decode_tile(tile) else { return 0 };
        let Some(l) = t.layer(layer) else { return 0 };
        let mut span = 0i64;
        for f in &l.features {
            for part in &f.parts {
                let xs: Vec<i64> = part.iter().map(|p| p.0 as i64).collect();
                if let (Some(mn), Some(mx)) = (xs.iter().min(), xs.iter().max()) {
                    span += mx - mn;
                }
            }
        }
        span
    }

    /// REPRO (backlog #59): around a harbour every coverage boundary crosses
    /// the tile, so no cell is ever `Full`, whole-tile authority drops
    /// nothing, and the coarse cell draws its DEPCNT straight through the
    /// harbour cell's ground — a second generalization of the same contour.
    /// Measured at Helsingør: five cells, five DEPCNT generalizations.
    ///
    /// The coarse cell must keep its contour *outside* the harbour cell's
    /// coverage and lose it *inside*.
    #[test]
    fn a_coarse_cells_geometry_stops_where_a_finer_cell_charts() {
        let (x, y) = tile_xy();
        // coarse cell: covers the whole patch, one contour across all of it
        let coarse = cell(vec![
            m_covr(1, 56.02, 56.05, 12.60, 12.63),
            depcnt(56.036, 12.60, 12.63),
        ]);
        // harbour cell: covers only the eastern half — neither is Full here
        let harbour = cell(vec![
            m_covr(1, 56.02, 56.05, 12.6155, 12.63),
            depcnt(56.036, 12.6155, 12.63),
        ]);
        let harbour_cov = crate::coverage::cell_coverage(&harbour).unwrap();

        let unmasked = CellTiler::new(coarse.clone()).cut(Z, x, y).unwrap();
        let masked = CellTiler::new(coarse.clone())
            .cut_with(Z, x, y, &[&harbour_cov])
            .unwrap();

        let before = line_span(&unmasked, "DEPCNT");
        let after = line_span(&masked, "DEPCNT");
        assert!(before > 0, "the coarse cell draws a contour here at all");
        assert!(
            after > 0,
            "and keeps it where the harbour cell does not chart: the mask \
             removes geometry, it does not claim the tile"
        );
        assert!(
            after < before,
            "the coarse contour must stop at the harbour cell's coverage, \
             not run through it: before={before} after={after}"
        );

        // the surviving geometry is west of the harbour cell's western edge
        let boundary = {
            let wpt = super::super::world_per_tile(Z);
            let min = crate::coords::WORLD_MIN as i64;
            let origin = min + x as i64 * wpt;
            let wx = lat_lon_to_world(56.036, 12.6155).x as i64;
            ((wx - origin) * super::super::EXTENT as i64 / wpt) as i32
        };
        let tile = decode_tile(&masked).unwrap();
        for f in &tile.layer("DEPCNT").unwrap().features {
            for part in &f.parts {
                for &(px, _) in part {
                    assert!(
                        px <= boundary + 2,
                        "coarse geometry survived inside the harbour cell's \
                         coverage at x={px} (boundary {boundary})"
                    );
                }
            }
        }
    }

    /// The mask only ever removes. A cell with no finer cell under it is
    /// untouched — byte-identical to an unmasked cut, so the finest cell of
    /// every tile pays nothing at all.
    #[test]
    fn no_finer_cell_means_no_mask_and_no_change() {
        let (x, y) = tile_xy();
        let c = cell(vec![
            m_covr(1, 56.02, 56.05, 12.60, 12.63),
            depcnt(56.036, 12.60, 12.63),
        ]);
        let plain = CellTiler::new(c.clone()).cut(Z, x, y);
        let empty_mask = CellTiler::new(c.clone()).cut_with(Z, x, y, &[]);
        assert_eq!(plain, empty_mask);
        assert!(TileMask::new(&[], Z, x, y).is_none());
    }

    /// REPRO (backlog #sttooosq): a RESARE-shaped circle captured only by the
    /// coarse cell, straddling a harbour cell's coverage boundary elsewhere in
    /// the same tile. `subtract`'s polygon branch used to run a plain
    /// `difference`, whose surviving ring closes with a NEW edge exactly along
    /// the mask boundary — dead straight, regardless of the original shape's
    /// curvature. RESARE's own ring is what S-52 draws as the dashed boundary
    /// (aidsHazards.ts `${cls}-bdy`), so that fabricated closing edge rendered
    /// as a charted limit: an arc plus a straight chord across the circle,
    /// right at the cell seam.
    ///
    /// Fixed direction: unlike a line feature's clip (truncate only, never
    /// invent an edge), a polygon not *fully* superseded keeps its whole,
    /// original, un-clipped shape rather than a partial difference. The only
    /// case that still removes geometry is full containment (asserted by the
    /// DEPCNT-doubling test above via `coverage_has_residual_in_tile`, and
    /// unaffected by this fix).
    #[test]
    fn a_polygon_not_fully_superseded_keeps_its_true_shape_not_a_partial_clip() {
        let (x, y) = tile_xy();
        // RESARE dead-centred on the harbour cell's western boundary
        // (lon 12.6155), radius small enough to stay inside the coarse
        // patch's own coverage on both sides.
        let coarse = cell(vec![
            m_covr(1, 56.02, 56.05, 12.60, 12.63),
            resare(56.036, 12.6155, 0.008),
        ]);
        // harbour cell: finer coverage over the eastern half only — no RESARE
        // copy of its own, so the coarse cell is the *only* source of this
        // object anywhere it charts.
        let harbour = cell(vec![m_covr(1, 56.02, 56.05, 12.6155, 12.63)]);
        let harbour_cov = crate::coverage::cell_coverage(&harbour).unwrap();

        let unmasked = CellTiler::new(coarse.clone()).cut(Z, x, y).unwrap();
        let masked = CellTiler::new(coarse.clone())
            .cut_with(Z, x, y, &[&harbour_cov])
            .unwrap();

        let unmasked_resare = decode_tile(&unmasked).unwrap();
        let masked_resare = decode_tile(&masked).unwrap();
        let before = &unmasked_resare.layer("RESARE").unwrap().features;
        let after = &masked_resare.layer("RESARE").unwrap().features;
        assert_eq!(before.len(), 1, "the coarse cell charts the circle at all");
        assert_eq!(
            after, before,
            "a RESARE not fully superseded must keep its ORIGINAL ring \
             (whole circle), not a partial difference that closes with a \
             synthetic straight edge along the harbour cell's coverage \
             boundary — that edge is what rendered as a fabricated chord"
        );
    }

    /// The counterpart, and the reason the rule above is now per-layer: the
    /// SAME circle in a class the style never strokes (DEPARE — `fill` only,
    /// no edge layer) IS cut for real. All-or-nothing here bought nothing and
    /// cost a doubled fill wherever the coarse cell's area overlapped the
    /// finer cell's own copy.
    ///
    /// Asserted on the surviving ring's x-extent rather than a vertex count:
    /// a real cut moves the eastern edge back to the harbour cell's coverage
    /// boundary, while the old all-or-nothing behaviour leaves the circle's
    /// full width untouched.
    #[test]
    fn a_fill_only_polygon_at_a_seam_is_cut_for_real() {
        let (x, y) = tile_xy();
        let coarse = cell(vec![
            m_covr(1, 56.02, 56.05, 12.60, 12.63),
            depare(56.036, 12.6155, 0.008),
        ]);
        let harbour = cell(vec![m_covr(1, 56.02, 56.05, 12.6155, 12.63)]);
        let harbour_cov = crate::coverage::cell_coverage(&harbour).unwrap();

        let unmasked = CellTiler::new(coarse.clone()).cut(Z, x, y).unwrap();
        let masked = CellTiler::new(coarse.clone())
            .cut_with(Z, x, y, &[&harbour_cov])
            .unwrap();

        let boundary = {
            let wpt = super::super::world_per_tile(Z);
            let min = crate::coords::WORLD_MIN as i64;
            let origin = min + x as i64 * wpt;
            let wx = lat_lon_to_world(56.036, 12.6155).x as i64;
            ((wx - origin) * super::super::EXTENT as i64 / wpt) as i32
        };

        let max_x = |tile: &[u8]| -> i32 {
            let t = decode_tile(tile).unwrap();
            t.layer("DEPARE")
                .unwrap()
                .features
                .iter()
                .flat_map(|f| f.parts.iter().flat_map(|p| p.iter().map(|&(px, _)| px)))
                .max()
                .unwrap()
        };

        assert!(
            max_x(&unmasked) > boundary + 4,
            "the unmasked circle reaches well east of the seam"
        );
        assert!(
            max_x(&masked) <= boundary + 2,
            "a fill-only polygon must be cut back to the harbour cell's \
             coverage boundary, not kept whole: max_x={} boundary={boundary}",
            max_x(&masked)
        );
        assert!(
            !decode_tile(&masked)
                .unwrap()
                .layer("DEPARE")
                .unwrap()
                .features
                .is_empty(),
            "and it must still be charted west of the seam — the mask removes, \
             it does not claim the tile"
        );
    }

    /// A finer cell whose coverage does not reach the tile masks nothing:
    /// the mask is built from coverage, so an irrelevant cell costs one
    /// ring test and no boolean.
    #[test]
    fn a_finer_cell_elsewhere_masks_nothing() {
        let (x, y) = tile_xy();
        let elsewhere = cell(vec![m_covr(1, 54.0, 54.1, 9.0, 9.1)]);
        let cov = crate::coverage::cell_coverage(&elsewhere).unwrap();
        assert!(TileMask::new(&[&cov], Z, x, y).is_none());
    }

    // ---- coverage_has_residual_in_tile (region-based authority) -----------
    //
    // The predicate the serving selection keeps a candidate by: does it chart
    // ground the finer kept cells do not? Kept when yes, dropped when no.

    fn coverage(features: Vec<Feature>) -> crate::coverage::Coverage {
        crate::coverage::cell_coverage(&cell(features)).unwrap()
    }

    /// Disjoint coverages: a finer cell beside the candidate removes nothing.
    #[test]
    fn residual_disjoint_coverages_keeps_candidate() {
        let (x, y) = tile_xy();
        let cand = coverage(vec![m_covr(1, 56.02, 56.05, 12.60, 12.6155)]);
        let finer = coverage(vec![m_covr(1, 56.02, 56.05, 12.6155, 12.63)]);
        assert!(coverage_has_residual_in_tile(&cand, &[&finer], Z, x, y));
    }

    /// A candidate wholly inside one finer cell's coverage charts nothing new
    /// and is dropped — the one direction that removes a cell.
    #[test]
    fn residual_candidate_inside_finer_is_dropped() {
        let (x, y) = tile_xy();
        let cand = coverage(vec![m_covr(1, 56.03, 56.04, 12.61, 12.62)]);
        let finer = coverage(vec![m_covr(1, 56.00, 56.07, 12.55, 12.68)]);
        assert!(!coverage_has_residual_in_tile(&cand, &[&finer], Z, x, y));
    }

    /// Partial overlap: the candidate keeps the half the finer cell does not
    /// chart, so it stays authoritative there.
    #[test]
    fn residual_partial_overlap_keeps_candidate() {
        let (x, y) = tile_xy();
        let cand = coverage(vec![m_covr(1, 56.02, 56.05, 12.60, 12.63)]);
        let finer = coverage(vec![m_covr(1, 56.02, 56.05, 12.6155, 12.63)]);
        assert!(coverage_has_residual_in_tile(&cand, &[&finer], Z, x, y));
    }

    /// Bbox fast path: a finer cell whose world extent misses the candidate's
    /// masks nothing, resolved with no boolean at all.
    #[test]
    fn residual_bbox_disjoint_fast_path_keeps_candidate() {
        let (x, y) = tile_xy();
        let cand = coverage(vec![m_covr(1, 56.02, 56.05, 12.60, 12.63)]);
        let elsewhere = coverage(vec![m_covr(1, 54.0, 54.1, 9.0, 9.1)]);
        assert!(coverage_has_residual_in_tile(&cand, &[&elsewhere], Z, x, y));
    }

    /// No finer cell: nothing to subtract, always residual.
    #[test]
    fn residual_no_finer_keeps_candidate() {
        let (x, y) = tile_xy();
        let cand = coverage(vec![m_covr(1, 56.02, 56.05, 12.60, 12.63)]);
        assert!(coverage_has_residual_in_tile(&cand, &[], Z, x, y));
    }

    /// The union of several finer cells that together (neither alone) blanket
    /// the candidate drops it — the residual is against the whole finer set.
    #[test]
    fn residual_union_of_finer_covers_candidate() {
        let (x, y) = tile_xy();
        let cand = coverage(vec![m_covr(1, 56.02, 56.05, 12.60, 12.63)]);
        let west = coverage(vec![m_covr(1, 56.00, 56.07, 12.55, 12.62)]);
        let east = coverage(vec![m_covr(1, 56.00, 56.07, 12.61, 12.68)]);
        assert!(!coverage_has_residual_in_tile(
            &cand,
            &[&west, &east],
            Z,
            x,
            y
        ));
    }

    /// Cross-tile determinism: the predicate depends only on (cov, finer, z, x,
    /// y), so a candidate authoritative over ground straddling a tile boundary
    /// is kept in *both* tiles, and one fully covered by a finer cell is
    /// dropped in both — the seam-free-by-construction property.
    #[test]
    fn residual_is_consistent_across_adjacent_tiles() {
        let (x, y) = tile_xy();
        // A finer cell charting only the far-eastern strip (east of every tile
        // here); a coarse candidate over the whole patch keeps residual across
        // all the tiles the finer cell does not reach.
        let cand = coverage(vec![m_covr(1, 56.00, 56.08, 12.55, 12.70)]);
        let finer = coverage(vec![m_covr(1, 56.00, 56.08, 12.68, 12.70)]);
        for tx in [x, x + 1] {
            for ty in [y, y + 1] {
                assert!(
                    coverage_has_residual_in_tile(&cand, &[&finer], Z, tx, ty),
                    "coarse candidate keeps residual in tile {tx}/{ty}"
                );
            }
        }
        // A candidate wholly inside a blanketing finer cell is dropped in every
        // tile it charts.
        let inside = coverage(vec![m_covr(1, 55.95, 56.15, 12.55, 12.75)]);
        let blanket = coverage(vec![m_covr(1, 55.9, 56.2, 12.5, 12.8)]);
        for tx in [x, x + 1] {
            for ty in [y, y + 1] {
                assert!(
                    !coverage_has_residual_in_tile(&inside, &[&blanket], Z, tx, ty),
                    "candidate inside the blanket is dropped in tile {tx}/{ty}"
                );
            }
        }
    }
}
