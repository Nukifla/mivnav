// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Merging per-cell tile cuts into one multi-cell tile.
//!
//! Layers concatenate in cut order (coarse-to-detailed); adjacent cells'
//! LineStrings are NOT stitched (see docs/architecture/mvt-merge-notes.md).

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

use super::decode::{decode_tile, DecodedFeature, GeomType};
use super::{encode_tile, MvtFeature, MvtGeometry, TagValue, NODATA_LAYER};

pub(crate) fn decoded_to_mvt(f: &DecodedFeature) -> Option<MvtFeature> {
    let geom = match f.geom_type {
        GeomType::Point => {
            MvtGeometry::Points(f.parts.iter().flatten().copied().collect::<Vec<_>>())
        }
        GeomType::Line => MvtGeometry::Lines(f.parts.clone()),
        GeomType::Polygon => MvtGeometry::Polygons(f.parts.clone()),
        GeomType::Unknown => return None,
    };
    Some(MvtFeature {
        id: f.id,
        tags: f.tags.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        geom,
    })
}

pub fn merge_tiles(tiles: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    merge_tiles_impl(tiles, None)
}

/// Like [`merge_tiles`], but stamp each `tiles[i]` with a `"set"` tag
/// (`set_ids[i]`) for `/tiles/all` per-set provenance (#qwxtvtwo; see
/// docs/architecture/mvt-merge-notes.md). `set_ids.len()` must equal `tiles.len()`.
pub fn merge_tiles_tagged(
    tiles: &[Vec<u8>],
    set_ids: &[Option<String>],
) -> Result<Vec<u8>, String> {
    merge_tiles_impl(tiles, Some(set_ids))
}

fn merge_tiles_impl(
    tiles: &[Vec<u8>],
    set_ids: Option<&[Option<String>]>,
) -> Result<Vec<u8>, String> {
    let mut layers: BTreeMap<String, Vec<MvtFeature>> = BTreeMap::new();
    for (i, tile) in tiles.iter().enumerate() {
        let set_tag = set_ids.and_then(|ids| ids[i].as_deref());
        for layer in decode_tile(tile)?.layers {
            let out = layers.entry(layer.name).or_default();
            out.extend(layer.features.iter().filter_map(|f| {
                let mut mvt = decoded_to_mvt(f)?;
                if let Some(sid) = set_tag {
                    mvt.tags
                        .push(("set".to_string(), TagValue::Str(sid.to_string())));
                }
                Some(mvt)
            }));
        }
    }
    if let Some(nodata) = layers.get_mut(NODATA_LAYER) {
        dissolve_claims(nodata);
    }
    Ok(encode_tile(&layers))
}

/// Merge like [`merge_tiles`], but reconcile each point's `scamin` gate to the
/// most-permissive value across cells that chart it — fixes multi-cell SCAMIN
/// "winking" (see docs/architecture/mvt-merge-notes.md).
pub fn merge_tiles_reconciled(
    masked: &[Vec<u8>],
    donors: &[Vec<u8>],
    z: u8,
) -> Result<Vec<u8>, String> {
    merge_tiles_reconciled_impl(masked, None, donors, z, RECONCILE_BUDGET)
}

/// Like [`merge_tiles_reconciled`], tagging each `masked[i]` with `"set"` (see
/// [`merge_tiles_tagged`]). Tag is appended AFTER [`reconcile_feature`] —
/// earlier would diverge a survivor's [`mvt_signature`] from its donor's.
pub fn merge_tiles_reconciled_tagged(
    masked: &[Vec<u8>],
    set_ids: &[Option<String>],
    donors: &[Vec<u8>],
    z: u8,
) -> Result<Vec<u8>, String> {
    merge_tiles_reconciled_impl(masked, Some(set_ids), donors, z, RECONCILE_BUDGET)
}

/// Wall-clock budget for one reconciled merge's feature pass, checked once
/// per feature (never mid geometry-op, #urlwssln). Exhausting it degrades
/// the tile rather than failing it (#wzqvxxyk) — see mvt-merge-notes.md.
const RECONCILE_BUDGET: Duration = Duration::from_secs(8);

fn merge_tiles_reconciled_impl(
    masked: &[Vec<u8>],
    set_ids: Option<&[Option<String>]>,
    donors: &[Vec<u8>],
    z: u8,
    budget: Duration,
) -> Result<Vec<u8>, String> {
    let index = build_donor_index(donors, z)?;
    let deadline = Instant::now() + budget;
    // Once set, remaining features pass through unreconciled (RECONCILE_BUDGET).
    let mut degraded = false;
    let mut layers: BTreeMap<String, Vec<MvtFeature>> = BTreeMap::new();
    for (i, tile) in masked.iter().enumerate() {
        let set_tag = set_ids.and_then(|ids| ids[i].as_deref());
        for layer in decode_tile(tile)?.layers {
            let out = layers.entry(layer.name.clone()).or_default();
            for f in &layer.features {
                degraded = degraded || Instant::now() >= deadline;
                let Some(mut mvt) = decoded_to_mvt(f) else {
                    continue;
                };
                if !degraded && matches!(f.geom_type, GeomType::Point | GeomType::Polygon) {
                    reconcile_feature(&layer.name, &mut mvt, &index, z);
                }
                if let Some(sid) = set_tag {
                    mvt.tags
                        .push(("set".to_string(), TagValue::Str(sid.to_string())));
                }
                out.push(mvt);
            }
        }
    }
    // Skip the tail dissolve too if the feature pass already ate the budget.
    if Instant::now() < deadline {
        if let Some(nodata) = layers.get_mut(NODATA_LAYER) {
            dissolve_claims(nodata);
        }
    }
    Ok(encode_tile(&layers))
}

/// A donor point: an unmasked copy of the same mark charted by another cell,
/// carrying the gate that cell would apply. Points match on layer + COLOUR +
/// tolerant position; `name_key` only widens the reach.
struct PointDonor {
    pos: (i32, i32),
    name_key: Option<String>,
    colour: Option<String>,
    scamin: Option<i64>,
}

/// A donor area. Matches on layer + geometry type + equal style-attribute
/// signature + strong spatial overlap — see [`reconcile_area`] for why that
/// cannot fuse two distinct areas.
struct AreaDonor {
    rings: Vec<Vec<(i32, i32)>>,
    bbox: (i32, i32, i32, i32),
    /// Area centroid, a representative interior point for the containment
    /// overlap test; `None` for degenerate geometry.
    centroid: Option<(f64, f64)>,
    scamin: Option<i64>,
}

/// One layer's donors, bucketed by what the match predicate requires so a
/// survivor visits only donors that could match (#wzqvxxyk) — needed because
/// SOUNDG makes a flat scan O(survivors × donors); see mvt-merge-notes.md.
struct LayerDonors {
    points: Vec<PointDonor>,
    /// Grid cell (see [`DonorIndex::cell_of`]) → indices into `points`.
    grid: HashMap<(i32, i32), Vec<u32>>,
    /// [`normalize_name`] key → indices into `points` (named donors only).
    by_name: HashMap<String, Vec<u32>>,
    /// Style signature → the areas carrying it.
    areas: HashMap<Vec<(String, String)>, Vec<AreaDonor>>,
}

impl LayerDonors {
    fn new() -> Self {
        LayerDonors {
            points: Vec::new(),
            grid: HashMap::new(),
            by_name: HashMap::new(),
            areas: HashMap::new(),
        }
    }
}

/// Every donor tile's features, indexed per layer for [`reconcile_feature`].
struct DonorIndex {
    layers: BTreeMap<String, LayerDonors>,
    /// Point-grid cell size, tile-local units: the unnamed fuse reach at this
    /// tile zoom, so a match can never be more than one cell away.
    cell: i32,
}

impl DonorIndex {
    fn cell_of(&self, pos: (i32, i32)) -> (i32, i32) {
        (pos.0.div_euclid(self.cell), pos.1.div_euclid(self.cell))
    }
}

/// Fold a chart name to a comparison key ignoring case and the Danish digraph
/// spellings (Å = Aa, Ø = Oe, Æ = Ae) the same object carries across cells.
/// Secondary signal only — identity is decided by colour + position, not name.
fn normalize_name(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.to_lowercase().chars() {
        match ch {
            'å' => out.push_str("aa"),
            'ø' => out.push_str("oe"),
            'æ' => out.push_str("ae"),
            c if c.is_whitespace() => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            }
            c => out.push(c),
        }
    }
    out.trim().to_string()
}

/// Tolerance for fusing the same buoy's copies when a name pins identity.
/// Named marks don't need zoom-scaling (OBJNAM pins identity); see
/// mvt-merge-notes.md for why the unnamed tolerance below must scale with zoom.
const TOL2_NAMED: i64 = 96 * 96;

/// Zoom at which the unnamed tolerance below is calibrated (8 units ≈ 11 m of
/// ground on the Danish set — the reach that lifts multi-cell buoys correctly).
const Z_REF: i32 = 12;
/// Unnamed fuse reach at [`Z_REF`], in tile-local units. Kept tight so two
/// distinct same-colour marks are never fused.
const TOL_UNNAMED_Z_REF: f64 = 8.0;
/// Floor on the (post-scaling) linear reach: below z12 the scaling would
/// shrink it past the calibrated 8 units and drop a real lift (`wnopqtyk`
/// regression); nearest distinct same-colour mark measured 482 units away.
const TOL_UNNAMED_FLOOR: f64 = 8.0;
/// Ceiling on the (post-scaling) linear reach: only bites past ~z17 overzoom,
/// so the fuse can never span a large fraction of the 4096-unit tile.
const TOL_UNNAMED_MAX: f64 = 256.0;

/// Squared position tolerance for fusing an *unnamed* mark's copies at tile
/// zoom `z`. Scale-invariant in ground metres (see [`tol_unnamed`]), clamped
/// to [`TOL_UNNAMED_FLOOR`]..=[`TOL_UNNAMED_MAX`].
fn tol2_unnamed(z: u8) -> i64 {
    let linear = tol_unnamed(z);
    (linear * linear).round() as i64
}

/// The linear form of [`tol2_unnamed`] — also the point grid's cell size (see
/// [`LayerDonors`]): with cells this wide, every donor within the unnamed reach
/// of a survivor lies in the survivor's own cell or one of its 8 neighbours.
fn tol_unnamed(z: u8) -> f64 {
    let scale = 2f64.powi(z as i32 - Z_REF);
    (TOL_UNNAMED_Z_REF * scale).clamp(TOL_UNNAMED_FLOOR, TOL_UNNAMED_MAX)
}

fn tag_string(v: &TagValue) -> String {
    match v {
        TagValue::Str(s) => s.clone(),
        TagValue::Int(i) => i.to_string(),
        TagValue::Double(x) => x.to_string(),
        TagValue::Bool(b) => b.to_string(),
    }
}

fn dec_str(f: &DecodedFeature, key: &str) -> Option<String> {
    f.tags.get(key).map(tag_string)
}

fn dec_point(f: &DecodedFeature) -> Option<(i32, i32)> {
    f.parts.iter().flatten().next().copied()
}

fn dec_scamin(f: &DecodedFeature) -> Option<i64> {
    match f.tags.get("scamin") {
        Some(TagValue::Int(i)) => Some(*i),
        _ => None,
    }
}

fn build_donor_index(donors: &[Vec<u8>], z: u8) -> Result<DonorIndex, String> {
    let mut index = DonorIndex {
        layers: BTreeMap::new(),
        // ≥ 1 so `div_euclid` is well-defined; the reach is floored at 8 units
        // anyway (`TOL_UNNAMED_FLOOR`), this is belt and braces.
        cell: (tol_unnamed(z).ceil() as i32).max(1),
    };
    let mut pending: Vec<(String, PointDonor)> = Vec::new();
    for tile in donors {
        for layer in decode_tile(tile)?.layers {
            for f in &layer.features {
                let scamin = dec_scamin(f);
                match f.geom_type {
                    GeomType::Point => {
                        let Some(pos) = dec_point(f) else { continue };
                        pending.push((
                            layer.name.clone(),
                            PointDonor {
                                pos,
                                name_key: dec_str(f, "OBJNAM").map(|s| normalize_name(&s)),
                                colour: dec_str(f, "COLOUR"),
                                scamin,
                            },
                        ));
                    }
                    GeomType::Polygon => {
                        let Some(bbox) = rings_bbox(&f.parts) else {
                            continue;
                        };
                        index
                            .layers
                            .entry(layer.name.clone())
                            .or_insert_with(LayerDonors::new)
                            .areas
                            .entry(dec_signature(f))
                            .or_default()
                            .push(AreaDonor {
                                centroid: poly_centroid(&f.parts),
                                rings: f.parts.clone(),
                                bbox,
                                scamin,
                            });
                    }
                    // Lines are deferred (see `reconcile_feature`): no line
                    // donors are indexed, so line survivors pay nothing.
                    GeomType::Line | GeomType::Unknown => continue,
                }
            }
        }
    }
    // Points second, so the grid/name buckets can hold `points` indices.
    for (layer, donor) in pending {
        let cell = index.cell_of(donor.pos);
        let l = index.layers.entry(layer).or_insert_with(LayerDonors::new);
        let i = l.points.len() as u32;
        l.grid.entry(cell).or_default().push(i);
        if let Some(name) = &donor.name_key {
            l.by_name.entry(name.clone()).or_default().push(i);
        }
        l.points.push(donor);
    }
    Ok(index)
}

fn mvt_str(f: &MvtFeature, key: &str) -> Option<String> {
    f.tags
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| tag_string(v))
}

fn set_scamin(f: &mut MvtFeature, value: Option<i64>) {
    f.tags.retain(|(k, _)| k != "scamin");
    if let Some(v) = value {
        f.tags.push(("scamin".to_string(), TagValue::Int(v)));
    }
}

fn own_scamin(f: &MvtFeature) -> Option<i64> {
    f.tags
        .iter()
        .find(|(k, _)| k == "scamin")
        .and_then(|(_, v)| match v {
            TagValue::Int(i) => Some(*i),
            _ => None,
        })
}

/// Write the survivor's `scamin` only when donors loosen it toward a bounded,
/// higher gate — never to always-show (would be un-filterable server-side;
/// see mvt-merge-notes.md).
fn apply_lift(f: &mut MvtFeature, own: Option<i64>, _any_none: bool, max_some: Option<i64>) {
    let reconciled = max_some;
    let loosens = match (own, reconciled) {
        (Some(o), Some(r)) => r > o, // a more-permissive (higher) SCAMIN
        (Some(_), None) => false,    // no bounded donor: keep our own real gate
        (None, _) => false,          // already always shown
    };
    if loosens {
        set_scamin(f, reconciled);
    }
}

/// Reconcile one surviving feature's SCAMIN gate against the donor index.
/// Dispatches by geometry; lines are deferred (see below).
fn reconcile_feature(layer: &str, f: &mut MvtFeature, index: &DonorIndex, z: u8) {
    match &f.geom {
        MvtGeometry::Points(_) => reconcile_point(layer, f, index, z),
        MvtGeometry::Polygons(_) => reconcile_area(layer, f, index),
        // TODO(lines): not yet reconciled — needs a scale-invariant match that
        // survives mask.rs's endpoint truncation; RESARE (polygons) was the
        // driving case, lines are a follow-up rather than a shaky predicate.
        MvtGeometry::Lines(_) => {}
    }
}

fn reconcile_point(layer: &str, f: &mut MvtFeature, index: &DonorIndex, z: u8) {
    let own = own_scamin(f);
    // No own SCAMIN = already shown at every scale, so a lift is a no-op
    // (`apply_lift`'s `(None, _)` arm) — skip the donor scan (#urlwssln).
    if own.is_none() {
        return;
    }
    let MvtGeometry::Points(pts) = &f.geom else {
        return;
    };
    let Some(&pos) = pts.first() else { return };
    let colour = mvt_str(f, "COLOUR");
    let name_key = mvt_str(f, "OBJNAM").map(|s| normalize_name(&s));

    let mut any_none = false;
    let mut max_some = own;
    let mut take = |d: &PointDonor| match d.scamin {
        None => any_none = true,
        Some(v) => max_some = Some(max_some.map_or(v, |m| m.max(v))),
    };
    if let Some(l) = index.layers.get(layer) {
        // Identity is COLOUR + tile-local proximity, NOT OBJNAM (spelling
        // splits across cells, e.g. "Aarhus"/"Århus") — see mvt-merge-notes.md.
        // Two lookups partition donors: name-agreeing via `by_name`, else grid.
        let tol2_id = tol2_unnamed(z);
        let (cx, cy) = index.cell_of(pos);
        for gy in cy - 1..=cy + 1 {
            for gx in cx - 1..=cx + 1 {
                for &i in l.grid.get(&(gx, gy)).into_iter().flatten() {
                    let d = &l.points[i as usize];
                    if d.colour != colour {
                        continue;
                    }
                    if matches!((&name_key, &d.name_key), (Some(a), Some(b)) if a == b) {
                        continue; // handled by the by-name pass, wider reach
                    }
                    if dist2(pos, d.pos) > tol2_id {
                        continue;
                    }
                    take(d);
                }
            }
        }
        if let Some(name) = &name_key {
            for &i in l.by_name.get(name).into_iter().flatten() {
                let d = &l.points[i as usize];
                if d.colour != colour {
                    continue;
                }
                if dist2(pos, d.pos) > TOL2_NAMED {
                    continue;
                }
                take(d);
            }
        }
    }
    apply_lift(f, own, any_none, max_some);
}

fn dist2(a: (i32, i32), b: (i32, i32)) -> i64 {
    let (dx, dy) = ((b.0 - a.0) as i64, (b.1 - a.1) as i64);
    dx * dx + dy * dy
}

/// Minimum bbox IoU for the fallback area-overlap test. 0.5 is conservative:
/// combined with equal style signature, a wrong match can only show an area a
/// stricter cell would have hidden — never a hidden hazard.
const AREA_BBOX_IOU_MIN: f64 = 0.5;

/// Reconcile a surviving polygon's SCAMIN gate against area donors. Matches
/// require same layer + geometry + style signature + strong spatial overlap
/// — see mvt-merge-notes.md for why that combination cannot fuse two areas.
fn reconcile_area(layer: &str, f: &mut MvtFeature, index: &DonorIndex) {
    let own = own_scamin(f);
    // A survivor with no own SCAMIN can never be loosened further
    // (`apply_lift`'s `(None, _)` arm), so skip the donor scan (#urlwssln).
    if own.is_none() {
        return;
    }
    let Some(l) = index.layers.get(layer) else {
        return;
    };
    let MvtGeometry::Polygons(rings) = &f.geom else {
        return;
    };
    let Some(bbox) = rings_bbox(rings) else {
        return;
    };
    let sig = mvt_signature(f);
    let centroid = poly_centroid(rings);
    // Signature equality is a bucket key now, not a per-donor test: areas of a
    // different object class never enter the loop at all (see `LayerDonors`).
    let Some(list) = l.areas.get(&sig) else {
        return;
    };

    let mut any_none = false;
    let mut max_some = own;
    let mut matched = false;
    for d in list {
        let AreaDonor {
            rings: drings,
            bbox: dbbox,
            centroid: dcentroid,
            scamin: dscamin,
        } = d;
        if bbox_disjoint(bbox, *dbbox) {
            continue; // nowhere near: no geometry test
        }
        if !areas_overlap(rings, bbox, centroid, drings, *dbbox, *dcentroid) {
            continue;
        }
        matched = true;
        match dscamin {
            None => any_none = true,
            Some(v) => max_some = Some(max_some.map_or(*v, |m| m.max(*v))),
        }
    }
    if matched {
        apply_lift(f, own, any_none, max_some);
    }
}

/// Strong overlap: mutual containment of representative interior points
/// (primary), else a high bbox IoU (fallback for concave shapes). Callers
/// bbox-reject first.
fn areas_overlap(
    a_rings: &[Vec<(i32, i32)>],
    a_bbox: (i32, i32, i32, i32),
    a_centroid: Option<(f64, f64)>,
    b_rings: &[Vec<(i32, i32)>],
    b_bbox: (i32, i32, i32, i32),
    b_centroid: Option<(f64, f64)>,
) -> bool {
    if let (Some(a), Some(b)) = (a_centroid, b_centroid) {
        if point_in_rings(a.0, a.1, b_rings) && point_in_rings(b.0, b.1, a_rings) {
            return true;
        }
    }
    bbox_iou(a_bbox, b_bbox) >= AREA_BBOX_IOU_MIN
}

/// Bounding box `(xmin, xmax, ymin, ymax)` of a ring set, or `None` when it has
/// no vertices.
fn rings_bbox(rings: &[Vec<(i32, i32)>]) -> Option<(i32, i32, i32, i32)> {
    if rings.iter().all(|r| r.is_empty()) {
        return None;
    }
    Some(bbox_of(rings))
}

fn bbox_disjoint(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    a.1 < b.0 || b.1 < a.0 || a.3 < b.2 || b.3 < a.2
}

/// Intersection-over-union of two bounding boxes, in `[0, 1]`.
fn bbox_iou(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> f64 {
    let ix = (a.1.min(b.1) - a.0.max(b.0)).max(0) as f64;
    let iy = (a.3.min(b.3) - a.2.max(b.2)).max(0) as f64;
    let inter = ix * iy;
    if inter <= 0.0 {
        return 0.0;
    }
    let area = |bb: (i32, i32, i32, i32)| ((bb.1 - bb.0) as f64 * (bb.3 - bb.2) as f64).max(0.0);
    let union = area(a) + area(b) - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

/// Area centroid of an MVT ring set (exteriors positive, holes negative), or
/// `None` for degenerate geometry. Used as the containment test's interior
/// point; a concave shape placing it outside just fails safe.
fn poly_centroid(rings: &[Vec<(i32, i32)>]) -> Option<(f64, f64)> {
    let mut area2 = 0f64;
    let mut cx = 0f64;
    let mut cy = 0f64;
    for ring in rings {
        let n = ring.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let (x0, y0) = (ring[i].0 as f64, ring[i].1 as f64);
            let (x1, y1) = (ring[(i + 1) % n].0 as f64, ring[(i + 1) % n].1 as f64);
            let cross = x0 * y1 - x1 * y0;
            area2 += cross;
            cx += (x0 + x1) * cross;
            cy += (y0 + y1) * cross;
        }
    }
    if area2.abs() < f64::EPSILON {
        return None;
    }
    Some((cx / (3.0 * area2), cy / (3.0 * area2)))
}

/// Even-odd point-in-polygon over a whole MVT ring set — the standard
/// exterior/hole nesting the tiler emits.
fn point_in_rings(px: f64, py: f64, rings: &[Vec<(i32, i32)>]) -> bool {
    let mut inside = false;
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            let (x1, y1) = (ring[i].0 as f64, ring[i].1 as f64);
            let (x2, y2) = (ring[(i + 1) % n].0 as f64, ring[(i + 1) % n].1 as f64);
            if (y1 > py) != (y2 > py) {
                let xint = x1 + (py - y1) * (x2 - x1) / (y2 - y1);
                if px < xint {
                    inside = !inside;
                }
            }
        }
    }
    inside
}

/// Style-attribute signature of a decoded donor: every tag except `scamin`.
/// Sorted `BTreeMap` iteration makes this comparable with [`mvt_signature`].
fn dec_signature(f: &DecodedFeature) -> Vec<(String, String)> {
    f.tags
        .iter()
        .filter(|(k, _)| k.as_str() != "scamin")
        .map(|(k, v)| (k.clone(), tag_string(v)))
        .collect()
}

/// The style-attribute signature of a surviving feature: every tag except the
/// `scamin` gate, sorted so it compares regardless of emission order.
fn mvt_signature(f: &MvtFeature) -> Vec<(String, String)> {
    let mut sig: Vec<(String, String)> = f
        .tags
        .iter()
        .filter(|(k, _)| k != "scamin")
        .map(|(k, v)| (k.clone(), tag_string(v)))
        .collect();
    sig.sort();
    sig
}

/// Collapse the tile's no-data claims into one non-overlapping feature.
/// Nothing paints `_nodata` today, but repealing this re-arms a double-blend
/// bug the moment rendering returns; fails toward the claim — mvt-merge-notes.md.
fn dissolve_claims(features: &mut Vec<MvtFeature>) {
    if features.len() < 2 {
        return; // the overwhelming majority of tiles: nothing to dissolve
    }
    let sets: Vec<Vec<Vec<(i32, i32)>>> = features
        .iter()
        .filter_map(|f| match &f.geom {
            MvtGeometry::Polygons(rings) => Some(rings.clone()),
            _ => None,
        })
        .collect();
    if sets.len() != features.len() {
        return; // something here is not a polygon: leave it alone
    }
    // Disjoint bounding boxes cannot double-composite, so the boolean is
    // skipped: claims from different cells are usually nowhere near each
    // other, and this keeps the cost on the tiles that actually stack.
    if !any_bbox_overlap(&sets) {
        return;
    }
    let Some(dissolved) = crate::mvt::mask::dissolve(&sets) else {
        return; // fail toward the claim (see above)
    };
    let tags = features[0].tags.clone();
    features.clear();
    features.push(MvtFeature {
        id: None,
        tags,
        geom: MvtGeometry::Polygons(dissolved),
    });
}

fn bbox_of(rings: &[Vec<(i32, i32)>]) -> (i32, i32, i32, i32) {
    let mut b = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
    for r in rings {
        for &(x, y) in r {
            b.0 = b.0.min(x);
            b.1 = b.1.max(x);
            b.2 = b.2.min(y);
            b.3 = b.3.max(y);
        }
    }
    b
}

fn any_bbox_overlap(sets: &[Vec<Vec<(i32, i32)>>]) -> bool {
    let boxes: Vec<_> = sets.iter().map(|s| bbox_of(s)).collect();
    for i in 0..boxes.len() {
        for j in i + 1..boxes.len() {
            let (a, b) = (boxes[i], boxes[j]);
            if !(a.1 < b.0 || b.1 < a.0 || a.3 < b.2 || b.3 < a.2) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::{lat_lon_to_world, WorldXy};
    use crate::model::{AttrValue, Cell, CellMeta, Feature, Geometry, Polygon};
    use crate::mvt::{CellTiler, EXTENT, NODATA_LAYER};

    const Z: u8 = 16;

    fn ring(n: f64, s: f64, w: f64, e: f64) -> Vec<WorldXy> {
        vec![
            lat_lon_to_world(n, w),
            lat_lon_to_world(n, e),
            lat_lon_to_world(s, e),
            lat_lon_to_world(s, w),
            lat_lon_to_world(n, w),
        ]
    }

    fn m_covr(catcov: i64, n: f64, s: f64, w: f64, e: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("CATCOV".to_string(), AttrValue::Int(catcov));
        Feature::new(
            302,
            "M_COVR".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring(n, s, w, e),
                holes: vec![],
            }])),
        )
    }

    fn depare(n: f64, s: f64, w: f64, e: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("drval1".to_string(), AttrValue::Float(10.0));
        Feature::new(
            42,
            "DEPARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring(n, s, w, e),
                holes: vec![],
            }])),
        )
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

    /// The z16 tile holding 38.063N/-121.687E — the anchor all the test
    /// cells' coverage boxes sit in or around.
    fn tile_xy() -> (u32, u32) {
        let w = lat_lon_to_world(38.063, -121.687);
        let wpt = super::super::world_per_tile(Z);
        let min = crate::coords::WORLD_MIN as i64;
        (
            ((w.x as i64 - min) / wpt) as u32,
            ((w.y as i64 - min) / wpt) as u32,
        )
    }

    fn cut(c: &Cell, x: u32, y: u32) -> Option<Vec<u8>> {
        CellTiler::new(c.clone()).cut(Z, x, y)
    }

    fn layer_names(tile: &[u8]) -> Vec<String> {
        decode_tile(tile)
            .unwrap()
            .layers
            .into_iter()
            .map(|l| l.name)
            .collect()
    }

    fn square_ring(cx: i32, cy: i32, half: i32, verts_per_side: usize) -> Vec<(i32, i32)> {
        let mut pts = Vec::new();
        let n = verts_per_side as i32;
        for i in 0..n {
            pts.push((cx - half + (2 * half * i) / n, cy - half));
        }
        for i in 0..n {
            pts.push((cx + half, cy - half + (2 * half * i) / n));
        }
        for i in 0..n {
            pts.push((cx + half - (2 * half * i) / n, cy + half));
        }
        for i in 0..n {
            pts.push((cx - half, cy + half - (2 * half * i) / n));
        }
        pts.push(pts[0]);
        pts
    }

    /// A DEPARE-like polygon feature, tagged identically across every call
    /// (same style signature: `drval1`, plus `scamin` when `scamin` is
    /// `Some`) so `reconcile_area`'s `dsig != sig` identity guard never
    /// rejects it — the low-zoom case #urlwssln root-caused: thousands of
    /// depth areas across a whole-country chart set share one `drval1` band.
    fn same_signature_square(
        cx: i32,
        cy: i32,
        half: i32,
        verts_per_side: usize,
        scamin: Option<i64>,
    ) -> MvtFeature {
        let pts = square_ring(cx, cy, half, verts_per_side);
        let mut tags = vec![("drval1".to_string(), TagValue::Double(10.0))];
        if let Some(v) = scamin {
            tags.push(("scamin".to_string(), TagValue::Int(v)));
        }
        MvtFeature {
            id: None,
            tags,
            geom: MvtGeometry::Polygons(vec![pts]),
        }
    }

    /// An encoded tile with `k` same-signature, mutually bbox-overlapping
    /// DEPARE polygons — every one of them a candidate match for every one
    /// of another such tile's, the low-zoom-union shape that defeats both of
    /// `reconcile_area`'s cheap pre-filters (bbox-disjoint and style
    /// signature) at once. `scamin` is `Some` to exercise the full O(K×D)
    /// scan, or `None` to exercise the early-exit skip (#urlwssln) instead.
    fn pathological_depare_tile(
        k: usize,
        verts: usize,
        set_offset: i32,
        scamin: Option<i64>,
    ) -> Vec<u8> {
        let mut layers: BTreeMap<String, Vec<MvtFeature>> = BTreeMap::new();
        let feats: Vec<_> = (0..k)
            .map(|i| {
                same_signature_square(
                    2000 + set_offset + (i as i32 % 3),
                    2000,
                    1500,
                    verts,
                    scamin,
                )
            })
            .collect();
        layers.insert("DEPARE".to_string(), feats);
        encode_tile(&layers)
    }

    /// Regression test for #urlwssln: a live-incident hang, 3 threads pinned
    /// at 190–265% CPU for 30+ minutes on a low-zoom (z5/z6) `/tiles/all`
    /// union of three whole-country chart sets. `reconcile_area` (SCAMIN
    /// reconciliation against the donor index) is a linear scan of one
    /// layer's donor list per surviving feature — O(survivors × donors) —
    /// gated only by a bbox-disjoint test and an exact style-signature
    /// match, both assumed to reject almost everything. At z5/z6 they don't:
    /// a whole country compresses into one 4096-unit tile (nothing is
    /// bbox-disjoint), and thousands of DEPARE polygons across the set share
    /// one `drval1` band (nothing is signature-distinct). Scaling
    /// measurements on exactly this shape (dev machine, release build,
    /// before this fix): K=50 → ~0.8ms, K=100 → ~2ms, K=200 → ~6.7ms,
    /// K=400 → ~25ms, K=800 → ~96ms, K=1600 → ~380ms, K=3200 → ~1.5s —
    /// wall time roughly quadruples every doubling, textbook O(K²), which
    /// extrapolates to a multi-*minute* hang somewhere past ~10^5
    /// same-signature overlapping polygons — well within reach of three
    /// whole-country sets unioned at low zoom. Not a non-terminating loop;
    /// an uncapped quadratic a big enough low-zoom union makes
    /// indistinguishable from one.
    ///
    /// This proves the fix bounds it rather than waiting out a real hang: a
    /// zero budget on the same pathological shape must stop reconciling on the
    /// very first feature, deterministically — not "eventually, if this
    /// machine is slow enough": a small-but-nonzero budget would make whether
    /// it trips mid-loop depend on this host's speed relative to the K chosen,
    /// which is exactly the flakiness this test must not have. The
    /// pathological construction above (same signature, mutually
    /// bbox-overlapping, K in the thousands) still documents the real shape;
    /// zero just makes the assertion itself hardware-independent.
    ///
    /// The budget used to return `Err` here, and #wzqvxxyk is what that cost:
    /// the serve path turns the error into a failed tile, i.e. one square of
    /// bare basemap in the middle of the chart. So the assertion is now
    /// "bounded **and** still a complete tile" — every feature present,
    /// carrying its own SCAMIN, which is what the merge did before
    /// reconciliation existed (see `RECONCILE_BUDGET`).
    #[test]
    fn reconciled_merge_bounds_a_pathological_same_signature_union() {
        let k = 2000;
        let masked = pathological_depare_tile(k, 8, 0, Some(1000));
        let donor_a = pathological_depare_tile(k, 8, 5, Some(2000));
        let donor_b = pathological_depare_tile(k, 8, -5, Some(2000));
        let start = std::time::Instant::now();
        let out =
            merge_tiles_reconciled_impl(&[masked], None, &[donor_a, donor_b], 5, Duration::ZERO)
                .expect("a pathological low-zoom union must degrade, never fail the tile");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "the bound took {:?} to fire — too slow to call it bounded",
            start.elapsed()
        );
        let feats = &decode_tile(&out).expect("decodes").layers[0].features;
        assert_eq!(
            feats.len(),
            k,
            "the chart must survive the bound — a dropped feature here is a \
             hole in the tile, which is the failure #wzqvxxyk reported"
        );
        assert!(
            feats
                .iter()
                .all(|f| matches!(f.tags.get("scamin"), Some(TagValue::Int(1000)))),
            "with the budget spent the features keep their own gate, unlifted"
        );
    }

    /// The same shape with a budget that is not exhausted: the lift DOES
    /// happen, so the degraded path above is a degradation and not the
    /// behaviour everywhere.
    #[test]
    fn a_budget_that_holds_still_lifts_the_gate() {
        let masked = pathological_depare_tile(20, 8, 0, Some(1000));
        let donor = pathological_depare_tile(20, 8, 5, Some(2000));
        let out =
            merge_tiles_reconciled_impl(&[masked], None, &[donor], 5, Duration::from_secs(30))
                .expect("merges");
        let feats = &decode_tile(&out).expect("decodes").layers[0].features;
        assert!(
            feats
                .iter()
                .all(|f| matches!(f.tags.get("scamin"), Some(TagValue::Int(2000)))),
            "every survivor should have taken the donor's more permissive gate"
        );
    }

    /// Regression test for the complementary #urlwssln fix: `reconcile_area`/
    /// `reconcile_point` skip the whole donor scan when a surviving feature
    /// has no own SCAMIN, because `apply_lift` can never loosen it further
    /// (its `(None, _) => false` arm) — the scan's result would be computed
    /// and discarded either way. This is a real complexity reduction (O(1)
    /// per such survivor instead of O(donors)), not a bound: same output,
    /// less work.
    ///
    /// Proof: the SAME pathological same-signature, same-bbox shape as
    /// `reconciled_merge_bounds_a_pathological_same_signature_union` above,
    /// but with every feature's `scamin` tag omitted, reconciled with a huge
    /// donor list and a **generous** budget. If the skip is in place, this
    /// finishes in a few milliseconds regardless of K; if it regressed back
    /// to scanning, K=4000 survivors against 8000 donors would reproduce the
    /// multi-second cost measured in the sibling test (and likely blow the
    /// generous budget below, turning this into a bound-triggered `Err`
    /// instead of the `Ok` this test requires).
    #[test]
    fn reconcile_skips_the_donor_scan_when_a_survivor_has_no_own_scamin() {
        let k = 4000;
        let masked = pathological_depare_tile(k, 8, 0, None);
        let donor_a = pathological_depare_tile(k, 8, 5, Some(1000));
        let donor_b = pathological_depare_tile(k, 8, -5, Some(1000));
        let start = std::time::Instant::now();
        merge_tiles_reconciled_impl(
            &[masked],
            None,
            &[donor_a, donor_b],
            5,
            Duration::from_secs(2),
        )
        .expect("no-own-SCAMIN survivors must skip the scan, not pay for it");
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "took {:?} — the no-own-SCAMIN early exit should make this ~instant \
             regardless of donor-list size; a regression back to scanning would \
             land in the multi-second range at this K (see the sibling test's \
             measurements)",
            start.elapsed()
        );
    }

    /// The point donor scan exactly as it was before the buckets went in
    /// (#wzqvxxyk): one flat pass over the layer's donors, `names_agree`
    /// choosing the tolerance per candidate. The reference the bucketed
    /// lookup is proved equal to.
    fn reconcile_point_flat(layer: &str, f: &mut MvtFeature, index: &DonorIndex, z: u8) {
        let own = own_scamin(f);
        if own.is_none() {
            return;
        }
        let MvtGeometry::Points(pts) = &f.geom else {
            return;
        };
        let Some(&pos) = pts.first() else { return };
        let colour = mvt_str(f, "COLOUR");
        let name_key = mvt_str(f, "OBJNAM").map(|s| normalize_name(&s));
        let mut any_none = false;
        let mut max_some = own;
        if let Some(l) = index.layers.get(layer) {
            let tol2_id = tol2_unnamed(z);
            for d in &l.points {
                if d.colour != colour {
                    continue;
                }
                let names_agree = matches!((&name_key, &d.name_key), (Some(a), Some(b)) if a == b);
                let tol2 = if names_agree { TOL2_NAMED } else { tol2_id };
                if dist2(pos, d.pos) > tol2 {
                    continue;
                }
                match d.scamin {
                    None => any_none = true,
                    Some(v) => max_some = Some(max_some.map_or(v, |m| m.max(v))),
                }
            }
        }
        apply_lift(f, own, any_none, max_some);
    }

    /// Deterministic xorshift — a seeded generator so the randomized
    /// equivalence check below is reproducible.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u32) -> u32 {
            (self.next() % n as u64) as u32
        }
    }

    fn point_feature(
        pos: (i32, i32),
        colour: Option<&str>,
        name: Option<&str>,
        scamin: Option<i64>,
    ) -> MvtFeature {
        let mut tags = Vec::new();
        if let Some(c) = colour {
            tags.push(("COLOUR".to_string(), TagValue::Str(c.to_string())));
        }
        if let Some(n) = name {
            tags.push(("OBJNAM".to_string(), TagValue::Str(n.to_string())));
        }
        if let Some(v) = scamin {
            tags.push(("scamin".to_string(), TagValue::Int(v)));
        }
        MvtFeature {
            id: None,
            tags,
            geom: MvtGeometry::Points(vec![pos]),
        }
    }

    fn random_points(rng: &mut Rng, n: usize, spread: u32) -> Vec<MvtFeature> {
        // A deliberately awkward mix: the same handful of names spelled two
        // ways (so `normalize_name` folding matters), colours that mostly
        // agree (so the cheap COLOUR reject does NOT do the work), and
        // positions clustered tightly enough that many pairs land inside the
        // reach — including right on the tolerance boundary.
        const COLOURS: [Option<&str>; 3] = [None, Some("1"), Some("3")];
        const NAMES: [Option<&str>; 4] = [None, Some("Århus Fyr"), Some("Aarhus fyr"), Some("Møn")];
        const SCAMINS: [Option<i64>; 4] = [None, Some(1_000), Some(60_000), Some(1_500_000)];
        (0..n)
            .map(|_| {
                let pos = (
                    rng.below(spread) as i32 - (spread / 2) as i32,
                    rng.below(spread) as i32 - (spread / 2) as i32,
                );
                point_feature(
                    pos,
                    COLOURS[rng.below(3) as usize],
                    NAMES[rng.below(4) as usize],
                    SCAMINS[rng.below(4) as usize],
                )
            })
            .collect()
    }

    fn point_tile(feats: &[MvtFeature]) -> Vec<u8> {
        let mut layers: BTreeMap<String, Vec<MvtFeature>> = BTreeMap::new();
        layers.insert("ATON".to_string(), feats.to_vec());
        encode_tile(&layers)
    }

    /// #wzqvxxyk: the bucketed donor lookup (position grid + name bucket) must
    /// be an exact reimplementation of the flat scan it replaced, not an
    /// approximation of it — the whole argument for not bumping anything about
    /// the SCAMIN contract is that the *same* gate comes out. Randomized
    /// input at three zooms (the reach is 8 units at z8/z12 and 128 at z16, so
    /// the grid cell size changes under it), compared feature by feature
    /// against `reconcile_point_flat`.
    #[test]
    fn bucketed_point_lookup_matches_the_flat_scan() {
        for z in [8u8, 12, 16] {
            for seed in [1u64, 7, 2026] {
                let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
                // spread 300 at z16 means a 128-unit reach spans a large part
                // of it: many candidates, plenty of boundary cases.
                let donors = random_points(&mut rng, 400, 300);
                let survivors = random_points(&mut rng, 200, 300);
                let index = build_donor_index(&[point_tile(&donors)], z).expect("index");
                for f in &survivors {
                    let (mut a, mut b) = (f.clone(), f.clone());
                    reconcile_point("ATON", &mut a, &index, z);
                    reconcile_point_flat("ATON", &mut b, &index, z);
                    assert_eq!(
                        own_scamin(&a),
                        own_scamin(&b),
                        "z{z} seed{seed}: bucketed lookup disagrees with the flat \
                         scan for {:?} at {:?}",
                        f.tags,
                        f.geom
                    );
                }
            }
        }
    }

    /// #wzqvxxyk, the measured production shape: SOUNDG. Soundings are
    /// nameless, colourless and carry a SCAMIN, so every cheap pre-filter the
    /// flat scan relied on passes and it degenerates into a true square —
    /// 77076 soundings on the real union tile 8/131/82 meant 5.9×10⁹ pair
    /// tests, 8s+ of CPU, the reconciliation budget spent, and (before the
    /// budget learned to degrade) one completely blank tile.
    ///
    /// The assertion is semantic rather than a wall-clock threshold, so it
    /// cannot go flaky on a slow host: with a budget that a bucketed lookup
    /// finishes inside easily, every survivor must come out LIFTED. A
    /// regression to the flat scan spends the budget instead, and the
    /// features come back carrying their own gate.
    ///
    /// K is calibrated to keep both margins wide (measured, debug build):
    /// bucketed lookup 40ms at K=12000 and linear in K, so ~80ms here against
    /// a 3s budget; the flat scan is quadratic — 1.8s at K=12000, so ~7s here,
    /// well past it.
    #[test]
    fn dense_unnamed_points_reconcile_without_spending_the_budget() {
        const K: usize = 24_000;
        let mut rng = Rng(0xC0FF_EE01);
        let mk = |rng: &mut Rng, scamin: i64| -> Vec<MvtFeature> {
            (0..K)
                .map(|_| {
                    point_feature(
                        (rng.below(4096) as i32, rng.below(4096) as i32),
                        None,
                        None,
                        Some(scamin),
                    )
                })
                .collect()
        };
        // Every survivor sits exactly on a donor (same seed sequence), so the
        // lift is unambiguous: 160000 → 1500000.
        let survivors = mk(&mut Rng(0xC0FF_EE01), 160_000);
        let donors = mk(&mut rng, 1_500_000);
        let out = merge_tiles_reconciled_impl(
            &[point_tile(&survivors)],
            None,
            &[point_tile(&donors)],
            8,
            Duration::from_secs(3),
        )
        .expect("merges");
        let feats = &decode_tile(&out).expect("decodes").layers[0].features;
        assert_eq!(feats.len(), K);
        let lifted = feats
            .iter()
            .filter(|f| matches!(f.tags.get("scamin"), Some(TagValue::Int(1_500_000))))
            .count();
        assert_eq!(
            lifted, K,
            "{lifted}/{K} soundings lifted — a flat donor scan at this density \
             spends the whole budget and leaves the rest unreconciled"
        );
    }

    /// Twice the signed area of a decoded ring, for winding assertions.
    fn signed_area2(ring: &[(i32, i32)]) -> i64 {
        let mut sum = 0i64;
        for i in 0..ring.len() {
            let (ax, ay) = ring[i];
            let (bx, by) = ring[(i + 1) % ring.len()];
            sum += ax as i64 * by as i64 - bx as i64 * ay as i64;
        }
        sum
    }

    /// Regression: a cell whose coverage leaves part of a tile blank used to
    /// declare that remainder `_nodata` — the buffered tile rect minus its
    /// own coverage. The style renders the layer as a set-wide AC(NODTA), so
    /// a neighbouring cell's charted water turned grey, and merging had to
    /// subtract every cell's coverage back out to undo it. The cell never
    /// had grounds for the claim: outside its coverage it knows nothing.
    #[test]
    fn a_cells_own_gap_is_not_a_no_data_claim() {
        let (x, y) = tile_xy();
        // coverage (and data) over a small square of the tile only
        let partial = cell(vec![
            m_covr(1, 38.0635, 38.0625, -121.6875, -121.6865),
            depare(38.0635, 38.0625, -121.6875, -121.6865),
        ]);
        let partial_cut = cut(&partial, x, y).expect("partial cell cuts this tile");
        let names = layer_names(&partial_cut);
        assert!(
            !names.contains(&NODATA_LAYER.to_string()),
            "a gap in one cell's coverage declares nothing: {names:?}"
        );
        assert!(names.contains(&"DEPARE".to_string()), "{names:?}");

        // and nothing appears when several such cells merge, however much
        // of the tile their gaps overlap — no claim plus no claim is no
        // claim (this used to compose into one full-tile grey wash)
        let b = cell(vec![
            m_covr(1, 38.0645, 38.0640, -121.6875, -121.6865),
            depare(38.0645, 38.0640, -121.6875, -121.6865),
        ]);
        let merged = merge_tiles(&[partial_cut, cut(&b, x, y).unwrap()]).unwrap();
        let names = layer_names(&merged);
        assert!(!names.contains(&NODATA_LAYER.to_string()), "{names:?}");
        assert!(names.contains(&"DEPARE".to_string()), "{names:?}");
    }

    /// The half that must survive (PLAN.md "Coverage"): where the ENC
    /// *declares* an area uncovered — an M_COVR CATCOV=2 area — that is a
    /// real, safety-relevant statement, and it still reaches the client as
    /// an AC(NODTA) island, merged or not.
    #[test]
    fn declared_no_coverage_survives_merge() {
        let (x, y) = tile_xy();
        let a = cell(vec![
            m_covr(1, 38.0640, 38.0620, -121.6880, -121.6860),
            m_covr(2, 38.0635, 38.0625, -121.6875, -121.6865),
            depare(38.0640, 38.0620, -121.6880, -121.6860),
        ]);
        let a_cut = cut(&a, x, y).expect("cell cuts this tile");
        assert!(layer_names(&a_cut).contains(&NODATA_LAYER.to_string()));

        // a second cell, charting elsewhere in the tile, must not erase it
        let b = cell(vec![
            m_covr(1, 38.0655, 38.0650, -121.6875, -121.6865),
            depare(38.0655, 38.0650, -121.6875, -121.6865),
        ]);
        let merged = merge_tiles(&[a_cut, cut(&b, x, y).unwrap()]).unwrap();
        let tile = decode_tile(&merged).unwrap();
        let nd = tile
            .layer(NODATA_LAYER)
            .expect("the declared area survives");
        assert_eq!(nd.features.len(), 1);
        // one solid island: the CATCOV=2 square, MVT-exterior wound. No
        // tile rect, so the grey is exactly what was declared and no more.
        let signs: Vec<bool> = nd.features[0]
            .parts
            .iter()
            .map(|r| signed_area2(r) > 0)
            .collect();
        assert_eq!(signs, vec![true]);
        // and it is an island, not the tile: well inside the buffered rect
        let xs: Vec<i32> = nd.features[0].parts[0].iter().map(|p| p.0).collect();
        assert!(
            xs.iter().all(|x| *x > 0 && *x < EXTENT as i32),
            "the claim covers only the declared area: {xs:?}"
        );
    }

    /// REPRO: a tile inside a cell's coverage *bounding box* but touching
    /// none of its coverage rings. The cell is not authoritative there and
    /// emits no content — it has no information about the area at all — yet
    /// it used to claim the whole tile as `_nodata`, which the style paints
    /// as a set-wide AC(NODTA). Wanted: no claim, hence no tile.
    #[test]
    fn tile_with_no_coverage_evidence_makes_no_claim() {
        let (x, y) = tile_xy();
        // two coverage squares on opposite diagonal corners of the bbox;
        // the anchor tile sits between them, inside the bbox, uncovered
        let c = cell(vec![
            m_covr(1, 38.0695, 38.0685, -121.6945, -121.6935),
            depare(38.0695, 38.0685, -121.6945, -121.6935),
            m_covr(1, 38.0575, 38.0565, -121.6805, -121.6795),
            depare(38.0575, 38.0565, -121.6805, -121.6795),
        ]);
        assert_eq!(
            cut(&c, x, y),
            None,
            "a cell with no coverage here must contribute nothing to the tile"
        );
    }

    /// How many `_nodata` features cover a tile point — the question
    /// `queryRenderedFeatures` answers, and the one that matters: MapLibre
    /// `fill` layers blend **per feature**, so two features over the same
    /// ground composite twice and the wash goes from alpha 0.5 to 0.75.
    fn nodata_stack_at(tile: &[u8], px: i32, py: i32) -> usize {
        let decoded = decode_tile(tile).unwrap();
        let Some(l) = decoded.layer(NODATA_LAYER) else {
            return 0;
        };
        l.features
            .iter()
            .filter(|f| {
                // nonzero winding within one feature: exteriors add, holes
                // subtract. Rings of ONE feature never double-composite.
                let mut wind = 0i32;
                for ring in &f.parts {
                    if point_in_ring(px, py, ring) {
                        wind += if signed_area2(ring) > 0 { 1 } else { -1 };
                    }
                }
                wind > 0
            })
            .count()
    }

    fn point_in_ring(px: i32, py: i32, ring: &[(i32, i32)]) -> bool {
        let mut inside = false;
        let n = ring.len();
        for i in 0..n {
            let (x1, y1) = ring[i];
            let (x2, y2) = ring[(i + 1) % n];
            if (y1 > py) != (y2 > py) {
                let xint = x1 as f64 + (py - y1) as f64 * (x2 - x1) as f64 / (y2 - y1) as f64;
                if (px as f64) < xint {
                    inside = !inside;
                }
            }
        }
        inside
    }

    /// REPRO: two cells whose *declared* no-coverage areas overlap put two
    /// `_nodata` features over the same ground. Since the NODATA03 wash
    /// renders at fill-opacity 0.5 and MapLibre blends per feature, the
    /// overlap composites to 0.75 — so the grey's darkness encodes *how
    /// many cells happened to declare*, which is an implementation artifact
    /// a mariner must not be able to read. Worse, it inverts the wash's
    /// purpose: only ~25% of the basemap survives where the grey is
    /// heaviest. Measured on the real Danish set before this fix: 33 tiles
    /// with overlapping `_nodata`, up to 4 features deep.
    ///
    /// The union is the claim; the count is not part of it.
    #[test]
    fn overlapping_no_data_claims_dissolve_into_one() {
        let (x, y) = tile_xy();
        // two cells, each charting a strip and declaring no-coverage over a
        // box; the two declared boxes overlap in the middle
        let a = cell(vec![
            m_covr(1, 38.0660, 38.0600, -121.6900, -121.6840),
            m_covr(2, 38.0650, 38.0620, -121.6890, -121.6860),
            depare(38.0660, 38.0655, -121.6900, -121.6840),
        ]);
        let b = cell(vec![
            m_covr(1, 38.0660, 38.0600, -121.6900, -121.6840),
            m_covr(2, 38.0645, 38.0615, -121.6880, -121.6850),
            depare(38.0605, 38.0600, -121.6900, -121.6840),
        ]);
        let merged = merge_tiles(&[cut(&a, x, y).unwrap(), cut(&b, x, y).unwrap()]).unwrap();

        // a point inside BOTH declared boxes
        let w = lat_lon_to_world(38.0632, -121.6870);
        let wpt = super::super::world_per_tile(Z);
        let min = crate::coords::WORLD_MIN as i64;
        let px = (((w.x as i64 - min) - x as i64 * wpt) * EXTENT as i64 / wpt) as i32;
        let py = (((w.y as i64 - min) - y as i64 * wpt) * EXTENT as i64 / wpt) as i32;

        let n = nodata_stack_at(&merged, px, py);
        assert_eq!(
            n, 1,
            "two cells declaring no-coverage over the same ground must \
             produce ONE claim there, not {n} stacked features: the wash \
             blends per feature, so {n} of them read as a darker grey that \
             means nothing"
        );
        // and the claim is still made everywhere it was
        let w2 = lat_lon_to_world(38.0640, -121.6885);
        let px2 = (((w2.x as i64 - min) - x as i64 * wpt) * EXTENT as i64 / wpt) as i32;
        let py2 = (((w2.y as i64 - min) - y as i64 * wpt) * EXTENT as i64 / wpt) as i32;
        assert_eq!(
            nodata_stack_at(&merged, px2, py2),
            1,
            "dissolving must not drop a claim: under-claiming no-data shows \
             basemap where there is no chart"
        );
    }

    fn aton(name: &str, colour: &str, scamin: Option<i64>, lat: f64, lon: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("OBJNAM".to_string(), AttrValue::Str(name.to_string()));
        attrs.insert("COLOUR".to_string(), AttrValue::Str(colour.to_string()));
        if let Some(s) = scamin {
            // the derive pass names the gate lowercase `scamin`; set it
            // directly here to exercise the merge without a full derive
            attrs.insert("scamin".to_string(), AttrValue::Int(s));
        }
        Feature::new(
            5,
            "ATON".into(),
            attrs,
            Some(Geometry::Point(lat_lon_to_world(lat, lon))),
        )
    }

    fn aton_scamin(tile: &[u8], name: &str) -> Option<Option<i64>> {
        let decoded = decode_tile(tile).unwrap();
        let l = decoded.layer("ATON")?;
        for f in &l.features {
            if f.tags.get("OBJNAM") == Some(&TagValue::Str(name.to_string())) {
                return Some(match f.tags.get("scamin") {
                    Some(TagValue::Int(i)) => Some(*i),
                    _ => None,
                });
            }
        }
        None
    }

    /// The fix: a buoy charted by both a coarse and a fine cell carries a
    /// different SCAMIN in each; the fine copy is what survives masking, and
    /// it must inherit the coarse cell's more-permissive (higher) gate so its
    /// visibility stays monotonic in zoom instead of winking off across the
    /// seam. The donor is the coarse cell cut WITHOUT masking.
    #[test]
    fn reconcile_lifts_scamin_to_most_permissive() {
        let (x, y) = tile_xy();
        let (lat, lon) = (38.063, -121.687);
        let fine = cell(vec![aton("No 25", "3,1", Some(1000), lat, lon)]);
        let coarse = cell(vec![aton("No 25", "3,1", Some(9000), lat, lon)]);
        let merged = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&coarse, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(aton_scamin(&merged, "No 25"), Some(Some(9000)));
    }

    /// Task 2 (the anti-wink hoist cap): a survivor that carries its OWN real
    /// SCAMIN must NOT be promoted to always-show just because a donor cell
    /// lacks a gate — that would strip the gate to `None` and make the object
    /// un-droppable by the server-side SCAMIN filter forever. With no *bounded*
    /// donor to loosen toward, the survivor keeps its own 1000 and stays
    /// droppable. (Before the cap this asserted `Some(None)`; a hidden buoy is
    /// the hazard SCAMIN reconciliation guards against, and keeping a real gate
    /// never hides one — it only lets the overview declutter reach the object.)
    #[test]
    fn no_scamin_donor_does_not_strip_a_real_gate() {
        let (x, y) = tile_xy();
        let (lat, lon) = (38.063, -121.687);
        let fine = cell(vec![aton("Skoven", "7", Some(1000), lat, lon)]);
        let coarse = cell(vec![aton("Skoven", "7", None, lat, lon)]);
        let merged = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&coarse, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(
            aton_scamin(&merged, "Skoven"),
            Some(Some(1000)),
            "a real SCAMIN survives a no-scamin donor, so it stays droppable"
        );
    }

    /// The cap does not break the legitimate loosening: a no-scamin donor
    /// present ALONGSIDE a higher bounded donor still lifts the survivor to the
    /// higher bounded gate (1000 → 9000), just never past it to always-show.
    #[test]
    fn bounded_donor_still_lifts_past_a_no_scamin_donor() {
        let (x, y) = tile_xy();
        let (lat, lon) = (38.063, -121.687);
        let fine = cell(vec![aton("No 25", "3,1", Some(1000), lat, lon)]);
        let always = cell(vec![aton("No 25", "3,1", None, lat, lon)]);
        let coarse = cell(vec![aton("No 25", "3,1", Some(9000), lat, lon)]);
        let merged = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&always, x, y).unwrap(), cut(&coarse, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(aton_scamin(&merged, "No 25"), Some(Some(9000)));
    }

    /// The safety guard: reconciliation must never tighten a gate, and never
    /// fuse two *distinct* marks. Identity is COLOUR + a tight, floored
    /// position tolerance (no longer OBJNAM), so a different COLOUR at the same
    /// spot, or the same colour beyond tolerance, is not a match.
    #[test]
    fn reconcile_never_tightens_or_fuses_distinct() {
        let (x, y) = tile_xy();
        let (lat, lon) = (38.063, -121.687);
        let fine = cell(vec![aton("No 25", "3,1", Some(9000), lat, lon)]);

        // a stricter (lower) donor gate must not lower the surviving one
        let stricter = cell(vec![aton("No 25", "3,1", Some(1000), lat, lon)]);
        let m1 = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&stricter, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(aton_scamin(&m1, "No 25"), Some(Some(9000)), "never tighten");

        // a different COLOUR at the same spot is a different mark: no fuse.
        // (Colour is now the discriminator — the name is not; two spellings of
        // one object must still fuse, see the Aa/Å test below.)
        let other_colour = cell(vec![aton("No 25", "6", None, lat, lon)]);
        let m2 = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&other_colour, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(
            aton_scamin(&m2, "No 25"),
            Some(Some(9000)),
            "distinct colour"
        );

        // the same colour well beyond tolerance (~44 m) is a different buoy
        let far = cell(vec![aton("No 25", "3,1", None, lat + 0.0004, lon)]);
        let m3 =
            merge_tiles_reconciled(&[cut(&fine, x, y).unwrap()], &[cut(&far, x, y).unwrap()], Z)
                .unwrap();
        assert_eq!(aton_scamin(&m3, "No 25"), Some(Some(9000)), "too far");
    }

    /// The primary fix (fail→pass): the SAME physical light is spelled two ways
    /// across cells — "Århus Havn Forfyr" in the fine cell, "Aarhus Havn Forfyr"
    /// in the coarse one — with the same colour at the same spot. The old exact-
    /// OBJNAM gate split it and never lifted the strict fine gate to the coarse
    /// cell's permissive one, so the frontend winked it off mid-zoom. Matching
    /// on colour + position (with the normalized name only widening the reach)
    /// lifts it. This is the real Aarhus Forfyr case in miniature.
    #[test]
    fn reconcile_lifts_across_aa_aring_name_split() {
        let (x, y) = tile_xy();
        let (lat, lon) = (38.063, -121.687);
        let fine = cell(vec![aton(
            "Århus Havn Forfyr",
            "3,1",
            Some(179_999),
            lat,
            lon,
        )]);
        let coarse = cell(vec![aton(
            "Aarhus Havn Forfyr",
            "3,1",
            Some(1_499_999),
            lat,
            lon,
        )]);
        let merged = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&coarse, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(
            aton_scamin(&merged, "Århus Havn Forfyr"),
            Some(Some(1_499_999)),
            "the coarse cell's permissive gate must lift across the Aa/Å \
             spelling split — the wink fix"
        );
    }

    /// [`normalize_name`] folds the case + Danish digraph differences that make
    /// one object read as two names across cells, and keeps genuinely different
    /// names apart.
    #[test]
    fn normalize_name_folds_danish_digraphs_and_case() {
        assert_eq!(
            normalize_name("Århus Havn Forfyr"),
            normalize_name("Aarhus Havn  Forfyr"),
            "Å = Aa, case, and collapsed whitespace fold together"
        );
        assert_eq!(normalize_name("Øresund"), normalize_name("Oeresund"));
        assert_ne!(normalize_name("No 25"), normalize_name("No 27"));
    }

    /// An UNNAMED aton (no OBJNAM) at an explicit world position, so a test can
    /// offset a buoy's two copies by an exact world distance.
    fn aton_unnamed_at(colour: &str, scamin: Option<i64>, w: WorldXy) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("COLOUR".to_string(), AttrValue::Str(colour.to_string()));
        if let Some(s) = scamin {
            attrs.insert("scamin".to_string(), AttrValue::Int(s));
        }
        Feature::new(6, "ATON".into(), attrs, Some(Geometry::Point(w)))
    }

    fn cut_z(c: &Cell, z: u8, x: u32, y: u32) -> Option<Vec<u8>> {
        CellTiler::new(c.clone()).cut(z, x, y)
    }

    /// Tile column/row holding world point `w` at zoom `z`.
    fn tile_at(w: WorldXy, z: u8) -> (u32, u32) {
        let wpt = super::super::world_per_tile(z);
        let min = crate::coords::WORLD_MIN as i64;
        (
            ((w.x as i64 - min) / wpt) as u32,
            ((w.y as i64 - min) / wpt) as u32,
        )
    }

    /// SCAMIN of the sole ATON point in a tile (the unnamed survivor).
    fn first_aton_scamin(tile: &[u8]) -> Option<Option<i64>> {
        let decoded = decode_tile(tile).unwrap();
        let l = decoded.layer("ATON")?;
        let f = l.features.first()?;
        Some(match f.tags.get("scamin") {
            Some(TagValue::Int(i)) => Some(*i),
            _ => None,
        })
    }

    /// Tile-local position of the sole ATON point in a cut.
    fn only_aton_pos(tile: &[u8]) -> (i32, i32) {
        let decoded = decode_tile(tile).unwrap();
        let l = decoded.layer("ATON").expect("ATON layer");
        dec_point(l.features.first().expect("one aton")).expect("point")
    }

    /// REPRO of the buoy WINK (the primary fix). An unnamed buoy is charted by
    /// a coarse cell (permissive SCAMIN) and a fine cell (strict SCAMIN); the
    /// two generalized copies sit a fixed *ground* distance apart. The fine
    /// copy survives masking and must inherit the coarse copy's permissive gate
    /// — but that lift only happens if the position match reaches across the
    /// copies' offset. In tile-local units that offset DOUBLES per zoom, so the
    /// OLD fixed 8-unit (64 squared) tolerance spans it at z12 yet fails by z14,
    /// dropping the lift and winking the buoy off mid-zoom. The z-scaled
    /// tolerance keeps the reach constant in metres, so the lift holds.
    #[test]
    fn reconcile_unnamed_lift_survives_higher_zoom() {
        // ~96 world units ≈ 7 m: a realistic gap between a buoy's coarse- and
        // fine-cell generalized positions. 96 is a whole multiple of the
        // world-units-per-tile-local-unit at z12 (32) and z14 (8), so the
        // decoded offset is exactly 3 units at z12 and 12 at z14.
        const DX_WORLD: i32 = 96;
        const TOL2_UNNAMED_OLD: i64 = 8 * 8; // the fixed constant this replaces
        let base = lat_lon_to_world(38.063, -121.687);
        let off = WorldXy::new(base.x + DX_WORLD, base.y);
        let fine = cell(vec![aton_unnamed_at("3,1", Some(1000), base)]);
        let coarse = cell(vec![aton_unnamed_at("3,1", Some(9000), off)]);

        // z12: the copies are 3 units apart — within BOTH the old and the new
        // tolerance, so the lift succeeds (this is the zoom the fix preserves).
        {
            let (x, y) = tile_at(base, 12);
            let fc = cut_z(&fine, 12, x, y).unwrap();
            let cc = cut_z(&coarse, 12, x, y).unwrap();
            let (dx, dy) = {
                let (fx, fy) = only_aton_pos(&fc);
                let (cx, cy) = only_aton_pos(&cc);
                ((cx - fx) as i64, (cy - fy) as i64)
            };
            assert!(dx * dx + dy * dy <= TOL2_UNNAMED_OLD, "z12 within old tol");
            let merged = merge_tiles_reconciled(&[fc], &[cc], 12).unwrap();
            assert_eq!(
                first_aton_scamin(&merged),
                Some(Some(9000)),
                "z12 lift (baseline)"
            );
        }

        // z14: the SAME ground offset is now 12 units — BEYOND the old fixed
        // tolerance (would have failed → wink), but within the z-scaled reach,
        // so the lift now succeeds.
        {
            let (x, y) = tile_at(base, 14);
            let fc = cut_z(&fine, 14, x, y).unwrap();
            let cc = cut_z(&coarse, 14, x, y).unwrap();
            let (dx, dy) = {
                let (fx, fy) = only_aton_pos(&fc);
                let (cx, cy) = only_aton_pos(&cc);
                ((cx - fx) as i64, (cy - fy) as i64)
            };
            let d2 = dx * dx + dy * dy;
            assert!(
                d2 > TOL2_UNNAMED_OLD,
                "z14 offset {d2} must exceed the old fixed tol {TOL2_UNNAMED_OLD} \
                 (else this would not reproduce the wink)"
            );
            assert!(d2 <= tol2_unnamed(14), "z14 within the z-scaled tol");
            let merged = merge_tiles_reconciled(&[fc], &[cc], 14).unwrap();
            assert_eq!(
                first_aton_scamin(&merged),
                Some(Some(9000)),
                "z14 lift now succeeds where the fixed tolerance failed"
            );
        }
    }

    /// The tolerance is scale-invariant in metres: the squared tolerance is the
    /// z12 base scaled by 4^(z-12), z12 is unchanged, and it never runs away.
    #[test]
    fn unnamed_tolerance_scales_with_zoom() {
        assert_eq!(tol2_unnamed(12), 64, "z12 preserved (8 units)");
        assert_eq!(tol2_unnamed(13), 256, "linear doubles: 16 units");
        assert_eq!(tol2_unnamed(14), 1024, "32 units");
        assert_eq!(tol2_unnamed(16), 16384, "128 units");
        // low zoom is FLOORED, not shrunk: the down-scaling would give ~4 units
        // at z11 (the wnopqtyk wink), so it is clamped to the calibrated 8.
        let floor2 = (TOL_UNNAMED_FLOOR * TOL_UNNAMED_FLOOR) as i64;
        assert_eq!(tol2_unnamed(11), floor2, "z11 floored to 8 units, not ~4");
        assert_eq!(tol2_unnamed(10), floor2, "z10 floored to 8 units");
        assert_eq!(tol2_unnamed(9), floor2, "z9 floored to 8 units");
        // capped so it cannot span a large fraction of the tile at overzoom
        let cap = (TOL_UNNAMED_MAX * TOL_UNNAMED_MAX) as i64;
        assert_eq!(tol2_unnamed(18), cap, "bounded at overzoom");
        assert!(tol2_unnamed(20) <= cap, "cap holds");
    }

    /// Safety: two same-colour UNNAMED marks a real-world distance apart (well
    /// beyond the 8-unit floor — the scout measured the nearest distinct mark at
    /// 482 tile-local units) must NOT fuse, at any zoom including the floored low
    /// ones. The permissive donor gate must stay off the distinct survivor.
    #[test]
    fn reconcile_does_not_fuse_distinct_unnamed_marks() {
        // 768 world units: past the 8-unit floor at every zoom tested (12
        // tile-local units at z11, 24 at z12, 96 at z14) yet a small fraction
        // of the tile, so both copies stay in the survivor's tile.
        const DX_WORLD: i32 = 768;
        let base = lat_lon_to_world(38.063, -121.687);
        let off = WorldXy::new(base.x + DX_WORLD, base.y);
        let survivor = cell(vec![aton_unnamed_at("3,1", Some(1000), base)]);
        let distinct = cell(vec![aton_unnamed_at("3,1", None, off)]);
        for z in [11u8, 12, 14] {
            let (x, y) = tile_at(base, z);
            let sc = cut_z(&survivor, z, x, y).unwrap();
            let dc = cut_z(&distinct, z, x, y).unwrap();
            // confirm the offset really exceeds the tolerance at this zoom
            let (sx, sy) = only_aton_pos(&sc);
            let (dx, dy) = only_aton_pos(&dc);
            let d2 = ((dx - sx) as i64).pow(2) + ((dy - sy) as i64).pow(2);
            assert!(
                d2 > tol2_unnamed(z),
                "z{z}: offset {d2} must exceed tol {} to test the guard",
                tol2_unnamed(z)
            );
            let merged = merge_tiles_reconciled(&[sc], &[dc], z).unwrap();
            assert_eq!(
                first_aton_scamin(&merged),
                Some(Some(1000)),
                "z{z}: a distinct same-colour mark {DX_WORLD} world units away \
                 must not fuse or lift the survivor's gate"
            );
        }
    }

    /// A RESARE-style restricted area with an explicit `scamin` gate and its
    /// S-52 style signature tags, set directly (like `aton`) to exercise the
    /// merge without a full derive+S52 pass. `sym`/`lc`/`bcol`/`bwid`/`dpri`
    /// are exactly what `crate::derive::restricted` bakes; equal on both copies
    /// means an equal reconciliation signature.
    fn resare(sym: &str, scamin: Option<i64>, n: f64, s: f64, w: f64, e: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("sym".to_string(), AttrValue::Str(sym.to_string()));
        attrs.insert("lc".to_string(), AttrValue::Str("RESARE51".into()));
        attrs.insert("bcol".to_string(), AttrValue::Str("CHMGD".into()));
        attrs.insert("bwid".to_string(), AttrValue::Int(2));
        attrs.insert("dpri".to_string(), AttrValue::Int(6));
        if let Some(v) = scamin {
            attrs.insert("scamin".to_string(), AttrValue::Int(v));
        }
        Feature::new(
            112,
            "RESARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring(n, s, w, e),
                holes: vec![],
            }])),
        )
    }

    /// SCAMIN of the RESARE *polygon* in a tile. A RESARE with a `sym` also
    /// emits a §1.5 label point into the same layer, so the polygon is selected
    /// by geometry type, not by position.
    fn resare_area_scamin(tile: &[u8]) -> Option<Option<i64>> {
        let decoded = decode_tile(tile).unwrap();
        let l = decoded.layer("RESARE")?;
        let f = l
            .features
            .iter()
            .find(|f| f.geom_type == GeomType::Polygon)?;
        Some(match f.tags.get("scamin") {
            Some(TagValue::Int(i)) => Some(*i),
            _ => None,
        })
    }

    /// The RESARE wink (the driving case): the same restricted area is charted
    /// by a coarse and a fine cell with a *different* per-cell SCAMIN. The fine
    /// copy survives, and — same signature, overlapping — must inherit the
    /// coarse cell's more-permissive gate so it stays visible across the seam
    /// instead of winking off, exactly as points already do.
    #[test]
    fn reconcile_lifts_area_scamin_to_most_permissive() {
        let (x, y) = tile_xy();
        let fine = cell(vec![resare(
            "no-entry",
            Some(179_999),
            38.0634,
            38.0626,
            -121.6874,
            -121.6866,
        )]);
        let coarse = cell(vec![resare(
            "no-entry",
            Some(1_499_999),
            38.0634,
            38.0626,
            -121.6874,
            -121.6866,
        )]);
        let merged = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&coarse, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(resare_area_scamin(&merged), Some(Some(1_499_999)));
    }

    /// Task 2 (the anti-wink hoist cap), area path: an overlapping
    /// same-signature donor with NO SCAMIN must NOT strip the survivor's real
    /// gate to always-show — that would make the restricted area un-droppable
    /// server-side. With no bounded donor to loosen toward, the survivor keeps
    /// its own 179999. (Before the cap this asserted `Some(None)`.)
    #[test]
    fn area_no_scamin_donor_does_not_strip_a_real_gate() {
        let (x, y) = tile_xy();
        let fine = cell(vec![resare(
            "no-entry",
            Some(179_999),
            38.0634,
            38.0626,
            -121.6874,
            -121.6866,
        )]);
        let coarse = cell(vec![resare(
            "no-entry", None, 38.0634, 38.0626, -121.6874, -121.6866,
        )]);
        let merged = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&coarse, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(resare_area_scamin(&merged), Some(Some(179_999)));
    }

    /// The safety guard: two areas of the SAME class overlapping the SAME
    /// ground but with a DIFFERENT style signature (a different restriction
    /// symbol) are distinct objects and must NOT be fused — the survivor's gate
    /// is untouched. The equal-signature requirement, not the overlap, is what
    /// keeps distinct restricted areas apart.
    #[test]
    fn reconcile_does_not_fuse_areas_of_different_signature() {
        let (x, y) = tile_xy();
        let fine = cell(vec![resare(
            "no-entry",
            Some(179_999),
            38.0634,
            38.0626,
            -121.6874,
            -121.6866,
        )]);
        let other = cell(vec![resare(
            "no-anchor", // different centred symbol: a different restriction
            None,
            38.0634,
            38.0626,
            -121.6874,
            -121.6866,
        )]);
        let merged = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&other, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(
            resare_area_scamin(&merged),
            Some(Some(179_999)),
            "a different style signature must never lift the gate"
        );
    }

    /// Same class, same signature, but the two areas are DISJOINT boxes
    /// elsewhere in the tile: no spatial overlap, so no match and no lift.
    #[test]
    fn reconcile_does_not_match_non_overlapping_areas() {
        let (x, y) = tile_xy();
        let survivor = cell(vec![resare(
            "no-entry",
            Some(179_999),
            38.0634,
            38.0630,
            -121.6874,
            -121.6870,
        )]);
        let elsewhere = cell(vec![resare(
            "no-entry", None, 38.0628, 38.0624, -121.6866, -121.6862,
        )]);
        let merged = merge_tiles_reconciled(
            &[cut(&survivor, x, y).unwrap()],
            &[cut(&elsewhere, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(
            resare_area_scamin(&merged),
            Some(Some(179_999)),
            "non-overlapping same-class areas must not match"
        );
    }

    /// Loosen-only for areas: an overlapping same-signature donor whose gate is
    /// STRICTER (lower) than the survivor's must not lower it.
    #[test]
    fn reconcile_area_never_tightens() {
        let (x, y) = tile_xy();
        let fine = cell(vec![resare(
            "no-entry",
            Some(1_499_999),
            38.0634,
            38.0626,
            -121.6874,
            -121.6866,
        )]);
        let stricter = cell(vec![resare(
            "no-entry",
            Some(179_999),
            38.0634,
            38.0626,
            -121.6874,
            -121.6866,
        )]);
        let merged = merge_tiles_reconciled(
            &[cut(&fine, x, y).unwrap()],
            &[cut(&stricter, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(
            resare_area_scamin(&merged),
            Some(Some(1_499_999)),
            "reconciliation must never tighten an area's gate"
        );
    }

    /// The dissolve must not invent a claim: ground no cell declared stays
    /// unclaimed.
    #[test]
    fn dissolve_does_not_grow_the_claim() {
        let (x, y) = tile_xy();
        let a = cell(vec![
            m_covr(1, 38.0660, 38.0600, -121.6900, -121.6840),
            m_covr(2, 38.0650, 38.0645, -121.6890, -121.6885),
            depare(38.0660, 38.0655, -121.6900, -121.6840),
        ]);
        let b = cell(vec![
            m_covr(1, 38.0660, 38.0600, -121.6900, -121.6840),
            m_covr(2, 38.0615, 38.0610, -121.6855, -121.6850),
            depare(38.0605, 38.0600, -121.6900, -121.6840),
        ]);
        let merged = merge_tiles(&[cut(&a, x, y).unwrap(), cut(&b, x, y).unwrap()]).unwrap();
        // between the two disjoint declared boxes: nobody declared here
        let w = lat_lon_to_world(38.0632, -121.6870);
        let wpt = super::super::world_per_tile(Z);
        let min = crate::coords::WORLD_MIN as i64;
        let px = (((w.x as i64 - min) - x as i64 * wpt) * EXTENT as i64 / wpt) as i32;
        let py = (((w.y as i64 - min) - y as i64 * wpt) * EXTENT as i64 / wpt) as i32;
        assert_eq!(
            nodata_stack_at(&merged, px, py),
            0,
            "the union of two disjoint claims must not fill the gap between them"
        );
    }

    /// Namespacing the feature id makes a chart object addressable across the
    /// cells a tile merges. RCID is unique only per cell, and up to
    /// `MAX_CELLS_PER_TILE` cells concatenate into one served tile, so on the
    /// bare RCID two *unrelated* objects from different cells collide in one
    /// tile — a `["==",["id"],rcid]` highlight would light the wrong polygon
    /// elsewhere on screen. The id is now `(cell_namespace(name) << 32) | rcid`
    /// ([`crate::mvt::cell_namespace`]), so within one merged tile the SAME
    /// rcid from DIFFERENT cells reads as DISTINCT ids, while two objects of the
    /// SAME cell keep that cell's namespace and differ only in their rcid.
    #[test]
    fn namespacing_disambiguates_rcid_across_cells() {
        use crate::mvt::{cell_namespace, namespaced_id};
        let (x, y) = tile_xy();

        // cell A: two DEPAREs (rcid 7 and 8) under one coverage box
        let mut a = cell(vec![
            m_covr(1, 38.0650, 38.0620, -121.6880, -121.6860),
            {
                let mut d = depare(38.0635, 38.0625, -121.6875, -121.6865);
                d.rcid = Some(7);
                d
            },
            {
                let mut d = depare(38.0648, 38.0640, -121.6875, -121.6865);
                d.rcid = Some(8);
                d
            },
        ]);
        a.meta.name = "US5OAKIQ.000".into();

        // cell B: a DEPARE reusing rcid 7 — an unrelated object, another cell
        let mut b = cell(vec![m_covr(1, 38.0665, 38.0652, -121.6880, -121.6860), {
            let mut d = depare(38.0662, 38.0654, -121.6875, -121.6865);
            d.rcid = Some(7);
            d
        }]);
        b.meta.name = "DK6NORDA.000".into();

        let ns_a = cell_namespace("US5OAKIQ.000");
        let ns_b = cell_namespace("DK6NORDA.000");
        assert_ne!(ns_a, ns_b, "distinct cells must get distinct namespaces");

        let merged = merge_tiles(&[cut(&a, x, y).unwrap(), cut(&b, x, y).unwrap()]).unwrap();
        let tile = decode_tile(&merged).unwrap();
        let depare = tile.layer("DEPARE").expect("DEPARE survives merge");
        let ids: std::collections::BTreeSet<u64> =
            depare.features.iter().filter_map(|f| f.id).collect();

        // three objects, three distinct ids
        assert_eq!(
            ids,
            [
                namespaced_id(ns_a, 7),
                namespaced_id(ns_a, 8),
                namespaced_id(ns_b, 7),
            ]
            .into_iter()
            .collect()
        );
        // the same rcid from two cells is now two ids (the whole point)
        assert_ne!(namespaced_id(ns_a, 7), namespaced_id(ns_b, 7));
        // every id carries its rcid in the low 32 bits
        for id in &ids {
            let rcid = id & 0xffff_ffff;
            assert!(rcid == 7 || rcid == 8, "rcid preserved in low bits: {rcid}");
        }
        // one cell's two objects share its namespace (stable per cell), and the
        // whole id stays within JS's safe-integer range
        assert_eq!(namespaced_id(ns_a, 7) >> 32, namespaced_id(ns_a, 8) >> 32);
        assert!(*ids.iter().max().unwrap() <= (1u64 << 53) - 1);
    }

    // ---- #qwxtvtwo: the "set" provenance tag (/tiles/all union serving) ----

    /// `merge_tiles` is untouched: with no `set_ids`, output is unaffected by
    /// the tagging machinery — nothing gets a `"set"` tag. Pins "additive, not
    /// a replacement" for the existing `/tiles/{set}` path.
    #[test]
    fn merge_tiles_without_tags_adds_no_set_property() {
        let (x, y) = tile_xy();
        let a = cell(vec![depare(38.0640, 38.0620, -121.6880, -121.6860)]);
        let merged = merge_tiles(&[cut(&a, x, y).unwrap()]).unwrap();
        let tile = decode_tile(&merged).unwrap();
        let f = &tile.layer("DEPARE").unwrap().features[0];
        assert!(
            !f.tags.contains_key("set"),
            "the untagged merge path must never add a set property"
        );
    }

    /// `merge_tiles_tagged`: each input cut's features carry the `"set"` tag
    /// of that cut's own entry in `set_ids` — the mechanism two overlapping
    /// chart sets' cells rely on for per-feature provenance in `/tiles/all`.
    #[test]
    fn merge_tiles_tagged_stamps_each_cuts_own_set() {
        let (x, y) = tile_xy();
        let a = cell(vec![depare(38.0640, 38.0620, -121.6880, -121.6860)]);
        let b = cell(vec![depare(38.0655, 38.0650, -121.6875, -121.6865)]);
        let merged = merge_tiles_tagged(
            &[cut(&a, x, y).unwrap(), cut(&b, x, y).unwrap()],
            &[Some("SET-A".to_string()), Some("SET-B".to_string())],
        )
        .unwrap();
        let tile = decode_tile(&merged).unwrap();
        let sets: std::collections::BTreeSet<String> = tile
            .layer("DEPARE")
            .unwrap()
            .features
            .iter()
            .map(|f| match f.tags.get("set") {
                Some(TagValue::Str(s)) => s.clone(),
                other => panic!("expected a Str set tag, got {other:?}"),
            })
            .collect();
        assert_eq!(
            sets,
            std::collections::BTreeSet::from(["SET-A".to_string(), "SET-B".to_string()]),
            "each feature must carry the set id of the cut it came from"
        );
    }

    /// A `None` entry (the synthetic whole-tile `_nodata` claim, which has no
    /// single owning set) stays untagged even when its neighbours are tagged.
    #[test]
    fn merge_tiles_tagged_none_entry_stays_untagged() {
        let (x, y) = tile_xy();
        let a = cell(vec![depare(38.0640, 38.0620, -121.6880, -121.6860)]);
        let synthetic = super::super::nodata_tile();
        let merged = merge_tiles_tagged(
            &[cut(&a, x, y).unwrap(), synthetic],
            &[Some("SET-A".to_string()), None],
        )
        .unwrap();
        let tile = decode_tile(&merged).unwrap();
        let nd = tile.layer(NODATA_LAYER).expect("synthetic claim present");
        assert!(!nd.features[0].tags.contains_key("set"));
        let depare = &tile.layer("DEPARE").unwrap().features[0];
        assert_eq!(
            depare.tags.get("set"),
            Some(&TagValue::Str("SET-A".to_string()))
        );
    }

    /// The `mvt_signature`/`dec_signature` hazard this change had to avoid:
    /// area SCAMIN reconciliation ([`reconcile_area`]) matches a survivor
    /// against its donor on "every tag except scamin". If the `"set"` tag were
    /// added *before* that match, a tagged survivor would carry a key its
    /// (always untagged) donor lacks and the signatures would never agree —
    /// silently breaking the RESARE-wink fix for every union-served area.
    /// Reusing `reconcile_lifts_area_scamin_to_most_permissive`'s fixture
    /// through `merge_tiles_reconciled_tagged` pins that the lift still fires
    /// AND the survivor still ends up tagged.
    #[test]
    fn reconcile_tagged_still_lifts_area_scamin_and_still_tags() {
        let (x, y) = tile_xy();
        let fine = cell(vec![resare(
            "no-entry",
            Some(179_999),
            38.0634,
            38.0626,
            -121.6874,
            -121.6866,
        )]);
        let coarse = cell(vec![resare(
            "no-entry",
            Some(1_499_999),
            38.0634,
            38.0626,
            -121.6874,
            -121.6866,
        )]);
        let merged = merge_tiles_reconciled_tagged(
            &[cut(&fine, x, y).unwrap()],
            &[Some("FINE-SET".to_string())],
            &[cut(&coarse, x, y).unwrap()],
            Z,
        )
        .unwrap();
        assert_eq!(
            resare_area_scamin(&merged),
            Some(Some(1_499_999)),
            "tagging must not interfere with the area SCAMIN lift"
        );
        let tile = decode_tile(&merged).unwrap();
        let poly = tile
            .layer("RESARE")
            .unwrap()
            .features
            .iter()
            .find(|f| f.geom_type == GeomType::Polygon)
            .unwrap();
        assert_eq!(
            poly.tags.get("set"),
            Some(&TagValue::Str("FINE-SET".to_string())),
            "the surviving (fine) copy must still carry its own set tag"
        );
    }

    // ---- REPRO (task kkkqkumv): a declared no-data hole in one chart must
    // let a genuinely DIFFERENT chart's real data show through, through the
    // FULL select→cut→merge pipeline (not just the raw-cut merge above,
    // which never runs selection or masking at all). --------------------

    fn depare_marked(n: f64, s: f64, w: f64, e: f64, drval1: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("drval1".to_string(), AttrValue::Float(drval1));
        Feature::new(
            42,
            "DEPARE".into(),
            attrs,
            Some(Geometry::Areas(vec![Polygon {
                outer: ring(n, s, w, e),
                holes: vec![],
            }])),
        )
    }

    fn depare_drval1s(tile: &[u8]) -> Vec<i64> {
        let Ok(decoded) = decode_tile(tile) else {
            return Vec::new();
        };
        let Some(l) = decoded.layer("DEPARE") else {
            return Vec::new();
        };
        l.features
            .iter()
            .filter_map(|f| match f.tags.get("drval1") {
                Some(TagValue::Double(v)) => Some(v.round() as i64),
                Some(TagValue::Int(v)) => Some(*v),
                _ => None,
            })
            .collect()
    }

    /// Runs the real serve shape (`python.rs::serve_tile`, ported here without
    /// pyo3): `select::select` over real [`crate::coverage::Coverage`], then
    /// cut each kept cell coarse→fine with `kept[pos+1..]` as its finer mask
    /// (exactly `serve_tile`'s loop), then [`merge_tiles`]. Returns `None`
    /// when nothing kept anything.
    fn serve(cells: &[(&'static str, u32, u8, Cell)], z: u8, x: u32, y: u32) -> Option<Vec<u8>> {
        use crate::mvt::select::{select, CellDesc, Knobs};

        let covs: Vec<Option<crate::coverage::Coverage>> = cells
            .iter()
            .map(|(_, _, _, c)| crate::coverage::cell_coverage(c))
            .collect();
        let descs: Vec<CellDesc<'_, crate::coverage::Coverage>> = cells
            .iter()
            .zip(&covs)
            .map(|((name, scale, max_zoom, _), cov)| CellDesc {
                scale: *scale,
                max_zoom: *max_zoom,
                name,
                coverage: cov.as_ref(),
            })
            .collect();
        let knobs = Knobs {
            over_zoom: 4,
            under_zoom: 4,
            detail_gap: 1,
            overview_detail_cutoff: 6,
            max_cells: 48,
        };
        let sel = select(&descs, z, x, y, &knobs);
        let tilers: Vec<CellTiler> = cells
            .iter()
            .map(|(_, _, _, c)| CellTiler::new(c.clone()))
            .collect();
        let mut cuts = Vec::new();
        for (pos, &ci) in sel.kept.iter().enumerate() {
            let finer: Vec<&crate::coverage::Coverage> = sel.kept[pos + 1..]
                .iter()
                .filter_map(|&j| covs[j].as_ref())
                .collect();
            if let Some(data) = tilers[ci].cut_with(z, x, y, &finer) {
                cuts.push(data);
            }
        }
        (!cuts.is_empty()).then(|| merge_tiles(&cuts).unwrap())
    }

    /// REPRO (task kkkqkumv): cell A (a chart product) declares a CATCOV=2
    /// hole in the middle of its coverage — a documented survey gap. Cell B
    /// is a DIFFERENT chart product (same compilation scale — a "border
    /// cells duplicated across regional packs" peer, `union_version`'s own
    /// example, not a nested finer/coarser relation) whose coverage reaches
    /// exactly that hole with real DEPARE content. Nothing in A's own data
    /// says B doesn't exist there, and `Coverage` already excludes the hole
    /// from A's claimed ground (`cell_coverage`'s CATCOV=2 handling) — so B
    /// must survive both selection (kept, not dropped as redundant) and
    /// cutting (its DEPARE must not be masked away), and the merged tile
    /// must carry B's marked DEPARE, not just A's.
    #[test]
    fn a_declared_hole_lets_a_different_same_scale_chart_show_through() {
        let (x, y) = tile_xy();
        let a = cell(vec![
            m_covr(1, 38.0660, 38.0600, -121.6900, -121.6840),
            m_covr(2, 38.0650, 38.0620, -121.6890, -121.6860),
            depare_marked(38.0660, 38.0600, -121.6900, -121.6840, 10.0),
        ]);
        let b = cell(vec![
            m_covr(1, 38.0652, 38.0618, -121.6892, -121.6858),
            depare_marked(38.0652, 38.0618, -121.6892, -121.6858, 99.0),
        ]);
        let cells = [("PRIMARY", 22_000, Z, a), ("FILLER", 22_000, Z, b)];
        let merged = serve(&cells, Z, x, y).expect("both cells chart this tile");

        let drvals = depare_drval1s(&merged);
        assert!(
            drvals.contains(&99),
            "the different chart's real DEPARE (drval1=99) must survive \
             through the declared hole, not just the primary's own \
             (drval1=10): got {drvals:?}"
        );
    }

    /// Tile coordinates for `lat`/`lon` at an arbitrary zoom (unlike
    /// [`tile_xy`], which is pinned to `Z`) — needed to reproduce the
    /// low-zoom vanishing-hole bug at a zoom coarser than this file's usual
    /// z16 fixtures.
    fn tile_xy_at(z: u8, lat: f64, lon: f64) -> (u32, u32) {
        let w = lat_lon_to_world(lat, lon);
        let wpt = super::super::world_per_tile(z);
        let min = crate::coords::WORLD_MIN as i64;
        (
            ((w.x as i64 - min) / wpt) as u32,
            ((w.y as i64 - min) / wpt) as u32,
        )
    }

    /// REPRO (task kkkqkumv, low-zoom shape): cell A is a detailed chart with
    /// a real-world TINY declared hole (~11m x 6m — a genuine surveyed
    /// obstruction gap). Cell B is a coarser, broader UNDERLYING chart (an
    /// overview regional cell, extending well past A on every side) with one
    /// real point object (a beacon) sitting exactly at the hole's
    /// coordinates. A point, not an area, so the repro cannot be confused
    /// with "the object is itself too small to render at this zoom" — a
    /// point has no area to simplify away.
    ///
    /// At the requested overview zoom, A's hole ring simplifies below the
    /// renderable point count (measured via `cov_rings_at_zoom`: this exact
    /// hole survives at z10, gone by z8) and — before the fix — A's
    /// `Coverage` reads as gap-free there. B is coarser, so at cut time A
    /// (finer) is B's mask (`TileMask`, built from A's `Coverage`): a
    /// gap-free A wrongly covers the beacon's spot, and
    /// `TileMask::subtract`'s point branch removes any point the mask
    /// contains — deleting the underlying chart's real beacon under a hole
    /// that was supposed to let it show through. This is the "opaque NODATA
    /// area hides valid data from a different, underlying chart" bug,
    /// zoom-dependent because the hole's vanishing is.
    #[test]
    fn a_tiny_declared_hole_does_not_erase_the_underlying_chart_at_overview_zoom() {
        let z = 8;
        let (x, y) = tile_xy_at(z, 56.036, 12.615);
        let a = cell(vec![
            m_covr(1, 56.05, 56.02, 12.60, 12.63),
            m_covr(2, 56.0360, 56.0359, 12.6150, 12.6151),
        ]);
        let b = cell(vec![
            m_covr(1, 56.5, 55.5, 12.0, 13.0),
            aton("BEACON", "red", None, 56.03595, 12.61505),
        ]);
        let cells = [("PRIMARY", 22_000, 10, a), ("UNDERLYING", 180_000, 8, b)];
        let merged = serve(&cells, z, x, y).expect("both cells chart this tile");

        assert!(
            aton_scamin(&merged, "BEACON").is_some(),
            "the underlying chart's real beacon, sitting exactly at the tiny \
             declared hole, must survive — not be erased by a mask that \
             wrongly treats the vanished hole as full coverage"
        );
    }
}
