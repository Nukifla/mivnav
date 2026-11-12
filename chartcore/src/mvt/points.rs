// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Generic point-feature → MVT PMTiles tiler for the "ingest-bake" pipeline,
//! separate from the S-57 cell path ([`super::build_tileset`]). Points only,
//! pure Rust; projection matches the cell path's integer tiling but in floats.

use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::PI;

use super::{encode_tile, MvtFeature, MvtGeometry, TagValue, Tileset, EXTENT};
use crate::coords::{MAX_LAT, MIN_LAT};

/// One point to tile: geographic position plus its MVT tags (opaque to the
/// tiler — whatever the caller wants on the feature).
#[derive(Debug, Clone, PartialEq)]
pub struct PointFeature {
    pub lon: f64,
    pub lat: f64,
    pub tags: Vec<(String, TagValue)>,
    /// Per-feature start zoom (rank tier): tiled only from this zoom up.
    /// `None` falls back to the tileset's global floor; effective start is
    /// `max(global_floor, this)`. Above `max_zoom` the feature is dropped, not clamped.
    pub min_zoom: Option<u8>,
}

/// Slippy-map placement of a lon/lat at zoom `z`: tile `(x, y)` and its
/// tile-local MVT coords (0..=[`EXTENT`], y growing south). Longitude wraps
/// to [-180,180]; edges clamp so a point on the east/south edge stays in range.
pub(crate) fn place(lon: f64, lat: f64, z: u8) -> (u32, u32, i32, i32) {
    let mut lon = lon;
    while lon > 180.0 {
        lon -= 360.0;
    }
    while lon < -180.0 {
        lon += 360.0;
    }
    let lat = lat.clamp(MIN_LAT, MAX_LAT);

    let n = (1u64 << z) as f64;
    let fx = (lon + 180.0) / 360.0 * n;
    let lat_rad = lat.to_radians();
    let fy = (1.0 - lat_rad.tan().asinh() / PI) / 2.0 * n;

    let last = (1u64 << z) - 1;
    let tx = (fx.floor() as i64).clamp(0, last as i64) as u32;
    let ty = (fy.floor() as i64).clamp(0, last as i64) as u32;
    let mx = ((fx - tx as f64) * EXTENT as f64)
        .round()
        .clamp(0.0, EXTENT as f64) as i32;
    let my = ((fy - ty as f64) * EXTENT as f64)
        .round()
        .clamp(0.0, EXTENT as f64) as i32;
    (tx, ty, mx, my)
}

/// Tile `features` into a single-layer [`Tileset`]. Each point starts tiling
/// from `max(min_zoom, feature.min_zoom)`; exceeding `max_zoom` drops it
/// (never clamped). Tiles with no features are never created.
pub fn build_point_tileset(
    features: &[PointFeature],
    layer: &str,
    min_zoom: u8,
    max_zoom: u8,
) -> Tileset {
    assert!(min_zoom <= max_zoom, "empty zoom range");
    assert!(max_zoom < 32, "zoom beyond the PMTiles id space");

    // per-tile feature accumulation, then a single encode per tile
    let mut acc: BTreeMap<(u8, u32, u32), Vec<MvtFeature>> = BTreeMap::new();
    for f in features {
        // the feature's rank floor, raised to the global floor; above max_zoom
        // this yields an empty range and the feature is dropped from all tiles.
        let effective_start = f.min_zoom.map_or(min_zoom, |z| z.max(min_zoom));
        for zoom in effective_start..=max_zoom {
            let (tx, ty, mx, my) = place(f.lon, f.lat, zoom);
            acc.entry((zoom, tx, ty)).or_default().push(MvtFeature {
                id: None,
                tags: f.tags.clone(),
                geom: MvtGeometry::Points(vec![(mx, my)]),
            });
        }
    }

    let tiles = acc
        .into_iter()
        .map(|(key, feats)| {
            let mut one: BTreeMap<String, Vec<MvtFeature>> = BTreeMap::new();
            one.insert(layer.to_string(), feats);
            (key, encode_tile(&one))
        })
        .collect::<BTreeMap<_, _>>();

    let mut layers = BTreeSet::new();
    if !tiles.is_empty() {
        layers.insert(layer.to_string());
    }
    Tileset {
        tiles,
        layers,
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

    fn pf(lon: f64, lat: f64, name: &str) -> PointFeature {
        PointFeature {
            lon,
            lat,
            tags: vec![("name".into(), TagValue::Str(name.into()))],
            min_zoom: None,
        }
    }

    /// Same as [`pf`] but with a per-feature start zoom (rank tier).
    fn pf_ranked(lon: f64, lat: f64, name: &str, start: u8) -> PointFeature {
        PointFeature {
            min_zoom: Some(start),
            ..pf(lon, lat, name)
        }
    }

    #[test]
    fn place_agrees_with_cell_path_tiling() {
        // the float slippy formula must bucket into the same tile as the
        // integer world math the cell path uses
        for &(lon, lat) in &[
            (9.0, 54.5),
            (-122.4194, 37.7749),
            (0.0, 0.0),
            (151.2, -33.86),
        ] {
            for z in [4u8, 8, 12, 14] {
                let (tx, ty, mx, my) = place(lon, lat, z);
                let t = world_point_to_tile(lat_lon_to_world(lat, lon), z as u32);
                assert_eq!(
                    (tx, ty),
                    (t.x as u32, t.y as u32),
                    "lon {lon} lat {lat} z{z}"
                );
                assert!((0..=EXTENT as i32).contains(&mx));
                assert!((0..=EXTENT as i32).contains(&my));
            }
        }
    }

    #[test]
    fn tiles_round_trip_through_pmtiles_reader() {
        // two points that separate into distinct tiles at z8..z10
        let a = pf(9.0, 54.5, "alpha"); // Flensburg-ish
        let b = pf(-122.4194, 37.7749, "beta"); // San Francisco
        let (min_z, max_z) = (8u8, 10u8);
        let ts = build_point_tileset(&[a.clone(), b.clone()], "poi", min_z, max_z);

        assert_eq!(ts.layers.iter().collect::<Vec<_>>(), vec!["poi"]);
        // both points, at three zooms, in different tiles → 6 tiles
        assert_eq!(ts.tiles.len(), 6);

        // the expected tile addresses exist
        for &(lon, lat) in &[(9.0, 54.5), (-122.4194, 37.7749)] {
            for z in min_z..=max_z {
                let (tx, ty, _, _) = place(lon, lat, z);
                assert!(
                    ts.tiles.contains_key(&(z, tx, ty)),
                    "missing z{z} {tx}/{ty}"
                );
            }
        }

        // round-trip through the PMTiles writer + reader
        let info = ArchiveInfo {
            name: "poi".into(),
            bounds: LLBox {
                w_lon: -122.4194,
                e_lon: 9.0,
                s_lat: 37.7749,
                n_lat: 54.5,
            },
            min_zoom: min_z,
            max_zoom: max_z,
            layers: ts.layers.iter().cloned().collect(),
        };
        let mut buf = Vec::new();
        write_archive(&mut buf, &ts.tiles, &info).unwrap();
        let ar = Archive::from_bytes(buf).unwrap();

        // fetch the tile holding point A at z10 and decode it
        let (ax, ay, amx, amy) = place(9.0, 54.5, 10);
        let raw = ar
            .tile(10, ax, ay)
            .unwrap()
            .expect("tile present in archive");
        let decoded = decode_tile(&raw).unwrap();
        let layer = decoded.layer("poi").expect("layer 'poi' present");
        assert_eq!(layer.features.len(), 1);
        let feat = &layer.features[0];
        assert_eq!(feat.geom_type, GeomType::Point);
        assert_eq!(feat.parts, vec![vec![(amx, amy)]]);
        assert_eq!(feat.tags["name"], TagValue::Str("alpha".into()));
    }

    #[test]
    fn empty_input_yields_empty_tileset() {
        let ts = build_point_tileset(&[], "poi", 0, 3);
        assert!(ts.tiles.is_empty());
        assert!(ts.layers.is_empty());
    }

    /// How many `poi` features land in the tile containing `(lon, lat)` at `z`.
    fn feature_count_at(ts: &Tileset, lon: f64, lat: f64, z: u8) -> usize {
        let (tx, ty, _, _) = place(lon, lat, z);
        match ts.tiles.get(&(z, tx, ty)) {
            None => 0,
            Some(raw) => decode_tile(raw)
                .unwrap()
                .layer("poi")
                .map_or(0, |l| l.features.len()),
        }
    }

    #[test]
    fn per_feature_min_zoom_places_only_from_its_rank_up() {
        // Two co-located points (same tile column at every zoom) so a tile's
        // feature count isolates which of them was placed there.
        let lon = 9.0;
        let lat = 54.5;
        let ranked = pf_ranked(lon, lat, "rank14", 14); // a dense shop
        let floored = pf(lon, lat, "always"); // no rank → full range
        let (min_z, max_z) = (6u8, 14u8);
        let ts = build_point_tileset(&[ranked, floored], "poi", min_z, max_z);

        // Low zooms carry only the un-ranked feature; the rank-14 one is absent.
        for z in 6u8..=13 {
            assert_eq!(
                feature_count_at(&ts, lon, lat, z),
                1,
                "z{z}: only the un-ranked feature should be present"
            );
        }
        // At z14 (== the feature's rank) both are present.
        assert_eq!(
            feature_count_at(&ts, lon, lat, 14),
            2,
            "z14: rank-14 feature joins the un-ranked one"
        );

        // No empty tile was written anywhere.
        for raw in ts.tiles.values() {
            assert!(!decode_tile(raw).unwrap().layers.is_empty());
        }
    }

    #[test]
    fn per_feature_min_zoom_absent_tiles_full_range_as_before() {
        // Backward-compat: without any per-feature min_zoom the tileset is
        // identical to the pre-feature behaviour — full range, every zoom.
        let a = pf(9.0, 54.5, "alpha");
        let b = pf(-122.4194, 37.7749, "beta");
        let (min_z, max_z) = (8u8, 10u8);
        let ts = build_point_tileset(&[a, b], "poi", min_z, max_z);
        // two separated points × three zooms = 6 tiles, exactly as the
        // round-trip test asserts for the no-rank case.
        assert_eq!(ts.tiles.len(), 6);
        for &(lon, lat) in &[(9.0, 54.5), (-122.4194, 37.7749)] {
            for z in min_z..=max_z {
                assert_eq!(feature_count_at(&ts, lon, lat, z), 1, "z{z}");
            }
        }
    }

    #[test]
    fn per_feature_min_zoom_below_floor_is_raised_to_the_floor() {
        // A rank below the global floor behaves like no rank (full range).
        let (min_z, max_z) = (8u8, 10u8);
        let ts = build_point_tileset(&[pf_ranked(9.0, 54.5, "low", 3)], "poi", min_z, max_z);
        for z in min_z..=max_z {
            assert_eq!(feature_count_at(&ts, 9.0, 54.5, z), 1, "z{z}");
        }
    }

    #[test]
    fn per_feature_min_zoom_above_max_is_dropped() {
        // A rank above max_zoom leaves the feature in no tile (empty range).
        let (min_z, max_z) = (6u8, 10u8);
        let ts = build_point_tileset(&[pf_ranked(9.0, 54.5, "toohigh", 12)], "poi", min_z, max_z);
        assert!(ts.tiles.is_empty());
        assert!(ts.layers.is_empty());
    }
}
