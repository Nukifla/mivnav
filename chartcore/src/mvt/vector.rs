// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Generic point/line-feature → multi-layer MVT PMTiles tiler for the
//! OSM basemap "ingest-bake" pipeline — the line-capable sibling of
//! [`super::points`]. No polygon support (coastline renders as a stroke, not
//! fill). See docs/architecture/osm-vector-tiler.md.

use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::PI;

use super::clip::{clip_polyline, ClipRect};
use super::points::place;
use super::{encode_tile, MvtFeature, MvtGeometry, TagValue, TileKey, Tileset, BUFFER, EXTENT};
use crate::coords::{MAX_LAT, MIN_LAT};

/// A feature to bake: either a single point or one open polyline, both in
/// lon/lat degrees.
#[derive(Debug, Clone, PartialEq)]
pub enum VectorGeom {
    Point(f64, f64),
    /// >= 2 vertices; shorter lines are silently dropped when tiled.
    Line(Vec<(f64, f64)>),
}

/// One feature of one named layer. `min_zoom` is the same per-feature
/// rank-tier convention as `PointFeature::min_zoom`: tiles only from
/// `max(global_floor, min_zoom)` upward, for road-class/place-rank decluttering.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorFeature {
    pub geom: VectorGeom,
    pub tags: Vec<(String, TagValue)>,
    pub min_zoom: Option<u8>,
}

/// Safety cap on tiles a single feature may land in at one zoom — guards
/// against a malformed (e.g. world-spanning) input turning one bad feature
/// into an unbounded loop; drops the offending feature-zoom, not the bake.
const MAX_TILES_PER_FEATURE_ZOOM: i64 = 4096;

/// Project lon/lat into this zoom's continuous pixel space: plain
/// Web-Mercator pixels scaled by `EXTENT` instead of 256. Longitude does a
/// bare wrap into [-180, 180] (no antimeridian seam-unwrapping).
fn project(lon: f64, lat: f64, scale: f64) -> (f64, f64) {
    let mut lon = lon;
    while lon > 180.0 {
        lon -= 360.0;
    }
    while lon < -180.0 {
        lon += 360.0;
    }
    let lat = lat.clamp(MIN_LAT, MAX_LAT);
    let fx = (lon + 180.0) / 360.0 * scale;
    let lat_rad = lat.to_radians();
    let fy = (1.0 - lat_rad.tan().asinh() / PI) / 2.0 * scale;
    (fx, fy)
}

/// Perpendicular distance from `p` to segment `a`-`b`.
fn point_seg_dist(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let (px, py) = (p.0 - a.0, p.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        ((px * dx + py * dy) / len2).clamp(0.0, 1.0)
    };
    let (ex, ey) = (px - t * dx, py - t * dy);
    (ex * ex + ey * ey).sqrt()
}

/// Ramer-Douglas-Peucker simplification in this module's per-zoom float
/// pixel space (see module docs for why this doesn't reuse
/// [`super::simplify`]). Endpoints are always kept.
fn simplify_line(pts: &[(f64, f64)], tolerance: f64) -> Vec<(f64, f64)> {
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
            let d = point_seg_dist(pts[i], pts[a], pts[b]);
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

/// Simplify a lon/lat line at `zoom`, then split it into the tile(s) it
/// touches, clipped (with [`BUFFER`] headroom) to tile-local MVT
/// coordinates. A line reduced below 2 vertices contributes nothing.
fn project_line_to_tiles(pts: &[(f64, f64)], zoom: u8) -> Vec<(u32, u32, Vec<(i32, i32)>)> {
    if pts.len() < 2 {
        return Vec::new();
    }
    let scale = (1u64 << zoom) as f64 * EXTENT as f64;
    let projected: Vec<(f64, f64)> = pts
        .iter()
        .map(|&(lon, lat)| project(lon, lat, scale))
        .collect();
    // one MVT unit, matching the cell path's own per-zoom tolerance.
    let simplified = simplify_line(&projected, 1.0);
    if simplified.len() < 2 {
        return Vec::new();
    }

    let (mut minx, mut maxx, mut miny, mut maxy) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &(x, y) in &simplified {
        minx = minx.min(x);
        maxx = maxx.max(x);
        miny = miny.min(y);
        maxy = maxy.max(y);
    }
    let n = 1i64 << zoom;
    let ext = EXTENT as f64;
    let tx0 = (minx / ext).floor() as i64;
    let tx1 = (maxx / ext).floor() as i64;
    let ty0 = (miny / ext).floor() as i64;
    let ty1 = (maxy / ext).floor() as i64;
    let (tx0, tx1) = (tx0.clamp(0, n - 1), tx1.clamp(0, n - 1));
    let (ty0, ty1) = (ty0.clamp(0, n - 1), ty1.clamp(0, n - 1));
    if (tx1 - tx0 + 1).saturating_mul(ty1 - ty0 + 1) > MAX_TILES_PER_FEATURE_ZOOM {
        return Vec::new();
    }

    let rect = ClipRect {
        x0: -BUFFER,
        y0: -BUFFER,
        x1: EXTENT as i64 + BUFFER,
        y1: EXTENT as i64 + BUFFER,
    };
    let mut out = Vec::new();
    for ty in ty0..=ty1 {
        for tx in tx0..=tx1 {
            let (ox, oy) = (tx as f64 * ext, ty as f64 * ext);
            let local: Vec<(i64, i64)> = simplified
                .iter()
                .map(|&(x, y)| ((x - ox).round() as i64, (y - oy).round() as i64))
                .collect();
            for part in clip_polyline(&local, &rect) {
                if part.len() >= 2 {
                    out.push((
                        tx as u32,
                        ty as u32,
                        part.into_iter()
                            .map(|(x, y)| (x as i32, y as i32))
                            .collect(),
                    ));
                }
            }
        }
    }
    out
}

/// Bake `layers` (named point/line feature sets) into one multi-layer
/// [`Tileset`], generalized over [`super::points::build_point_tileset`] to
/// more than one layer sharing the same tiles (encoded together, not per-layer).
pub fn build_layer_tileset(
    layers: &[(&str, &[VectorFeature])],
    min_zoom: u8,
    max_zoom: u8,
) -> Tileset {
    assert!(min_zoom <= max_zoom, "empty zoom range");
    assert!(max_zoom < 32, "zoom beyond the PMTiles id space");

    let mut acc: BTreeMap<TileKey, BTreeMap<String, Vec<MvtFeature>>> = BTreeMap::new();
    let mut layer_names: BTreeSet<String> = BTreeSet::new();
    for (layer_name, features) in layers {
        for f in features.iter() {
            let effective_start = f.min_zoom.map_or(min_zoom, |z| z.max(min_zoom));
            if effective_start > max_zoom {
                continue;
            }
            for zoom in effective_start..=max_zoom {
                match &f.geom {
                    VectorGeom::Point(lon, lat) => {
                        let (tx, ty, mx, my) = place(*lon, *lat, zoom);
                        acc.entry((zoom, tx, ty))
                            .or_default()
                            .entry(layer_name.to_string())
                            .or_default()
                            .push(MvtFeature {
                                id: None,
                                tags: f.tags.clone(),
                                geom: MvtGeometry::Points(vec![(mx, my)]),
                            });
                        layer_names.insert(layer_name.to_string());
                    }
                    VectorGeom::Line(pts) => {
                        for (tx, ty, local) in project_line_to_tiles(pts, zoom) {
                            acc.entry((zoom, tx, ty))
                                .or_default()
                                .entry(layer_name.to_string())
                                .or_default()
                                .push(MvtFeature {
                                    id: None,
                                    tags: f.tags.clone(),
                                    geom: MvtGeometry::Lines(vec![local]),
                                });
                            layer_names.insert(layer_name.to_string());
                        }
                    }
                }
            }
        }
    }

    let tiles = acc
        .into_iter()
        .map(|(key, layer_map)| (key, encode_tile(&layer_map)))
        .collect::<BTreeMap<_, _>>();

    Tileset {
        tiles,
        layers: layer_names,
        min_zoom,
        max_zoom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::LLBox;
    use crate::coords::{lat_lon_to_world, world_point_to_tile};
    use crate::mvt::decode::{decode_tile, GeomType};
    use crate::pmtiles::{write_archive, Archive, ArchiveInfo};

    fn line_feature(pts: &[(f64, f64)]) -> VectorFeature {
        VectorFeature {
            geom: VectorGeom::Line(pts.to_vec()),
            tags: vec![("name".into(), TagValue::Str("test".into()))],
            min_zoom: None,
        }
    }

    fn point_feature(lon: f64, lat: f64) -> VectorFeature {
        VectorFeature {
            geom: VectorGeom::Point(lon, lat),
            tags: vec![("name".into(), TagValue::Str("place".into()))],
            min_zoom: None,
        }
    }

    #[test]
    fn line_lands_in_expected_tile_and_round_trips() {
        // A short line near Flensburg, well inside one z10 tile.
        let f = line_feature(&[(9.0, 54.5), (9.01, 54.51)]);
        let ts = build_layer_tileset(&[("roads", &[f])], 10, 10);
        assert_eq!(ts.layers.iter().collect::<Vec<_>>(), vec!["roads"]);

        let w = lat_lon_to_world(54.5, 9.0);
        let t = world_point_to_tile(w, 10);
        let raw = ts
            .tiles
            .get(&(10, t.x as u32, t.y as u32))
            .expect("tile present");
        let decoded = decode_tile(raw).unwrap();
        let layer = decoded.layer("roads").expect("roads layer present");
        assert_eq!(layer.features.len(), 1);
        assert_eq!(layer.features[0].geom_type, GeomType::Line);

        // round-trips through the PMTiles writer too
        let info = ArchiveInfo {
            name: "osm".into(),
            bounds: LLBox {
                w_lon: 9.0,
                e_lon: 9.01,
                s_lat: 54.5,
                n_lat: 54.51,
            },
            min_zoom: 10,
            max_zoom: 10,
            layers: ts.layers.iter().cloned().collect(),
        };
        let mut buf = Vec::new();
        write_archive(&mut buf, &ts.tiles, &info).unwrap();
        let ar = Archive::from_bytes(buf).unwrap();
        assert!(ar.tile(10, t.x as u32, t.y as u32).unwrap().is_some());
    }

    #[test]
    fn line_crossing_tile_boundary_splits_into_two_tiles() {
        // A line spanning two z2 tiles east-west (each z2 tile is 90 degrees wide).
        let f = line_feature(&[(-10.0, 10.0), (10.0, 10.0)]);
        let ts = build_layer_tileset(&[("coastline", &[f])], 2, 2);
        // both halves of the world-straddling line must appear somewhere
        assert!(
            ts.tiles.len() >= 2,
            "expected the line split across >=2 tiles, got {}",
            ts.tiles.len()
        );
    }

    #[test]
    fn collinear_points_are_simplified_away() {
        // A dense, perfectly straight line: the interior points should not
        // survive simplification into extra geometry commands.
        let mut pts = Vec::new();
        for i in 0..=100 {
            pts.push((9.0 + i as f64 * 0.0001, 54.5));
        }
        let f = line_feature(&pts);
        let ts = build_layer_tileset(&[("roads", &[f])], 12, 12);
        let w = lat_lon_to_world(54.5, 9.0);
        let t = world_point_to_tile(w, 12);
        let raw = ts.tiles.get(&(12, t.x as u32, t.y as u32)).unwrap();
        let decoded = decode_tile(raw).unwrap();
        let layer = decoded.layer("roads").unwrap();
        // a straight line simplifies to its two endpoints, not 101 vertices
        assert_eq!(layer.features[0].parts[0].len(), 2);
    }

    #[test]
    fn point_and_line_layers_share_one_tile() {
        let line = line_feature(&[(9.0, 54.5), (9.001, 54.501)]);
        let point = point_feature(9.0005, 54.5005);
        let ts = build_layer_tileset(&[("roads", &[line]), ("places", &[point])], 10, 10);
        assert_eq!(
            ts.layers.iter().collect::<Vec<_>>(),
            vec!["places", "roads"]
        );
        let w = lat_lon_to_world(54.5, 9.0);
        let t = world_point_to_tile(w, 10);
        let raw = ts.tiles.get(&(10, t.x as u32, t.y as u32)).unwrap();
        let decoded = decode_tile(raw).unwrap();
        assert!(decoded.layer("roads").is_some());
        assert!(decoded.layer("places").is_some());
    }

    #[test]
    fn per_feature_min_zoom_gates_lines_same_as_points() {
        let mut ranked = line_feature(&[(9.0, 54.5), (9.01, 54.51)]);
        ranked.min_zoom = Some(12);
        let ts = build_layer_tileset(&[("roads", &[ranked])], 8, 12);
        for z in 8u8..12 {
            let w = lat_lon_to_world(54.5, 9.0);
            let t = world_point_to_tile(w, z as u32);
            assert!(
                !ts.tiles.contains_key(&(z, t.x as u32, t.y as u32)),
                "z{z} should have no tile below the feature's rank"
            );
        }
        let w = lat_lon_to_world(54.5, 9.0);
        let t = world_point_to_tile(w, 12);
        assert!(ts.tiles.contains_key(&(12, t.x as u32, t.y as u32)));
    }

    #[test]
    fn empty_input_yields_empty_tileset() {
        let ts = build_layer_tileset(&[], 0, 3);
        assert!(ts.tiles.is_empty());
        assert!(ts.layers.is_empty());
    }
}
