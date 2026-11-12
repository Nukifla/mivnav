// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only
//
// Port of ochartsng's provider/include/Coordinates.h
// (Copyright (C) 2022 by Andreas Vogel, GPLv2).

//! WebMercator "world" integer coordinates: fixed-zoom pixel coords with a
//! sub-pixel bit, shifted towards negative by [`HALF_SHIFT`] for ±180°
//! overflow headroom. Bit-layout rationale: see
//! docs/architecture/world-coordinates.md.

mod extent;
mod point;
mod tile;

pub use extent::{Extent, LLBox, PixelBox};
pub use point::{LLXy, PixelXy, Point, WorldXy};
pub use tile::{tile_to_box, world_extent_to_pixel, world_point_to_tile, Tile, TileBox};

use std::f64::consts::PI;

/// Latitude/longitude in degrees.
pub type LatLon = f64;
/// World coordinate (WebMercator pixels at [`COORD_ZOOM_LEVEL`], shifted by [`HALF_SHIFT`]).
pub type World = i32;
/// Pixel coordinate — world coordinates without the sub-pixel bits.
pub type Pixel = i32;

pub const WGS84_SEMIMAJOR_AXIS_METERS: f64 = 6378137.0;
pub const MERCATOR_K0: f64 = 0.9996;

/// Fixed maximum zoom level world coordinates are computed for.
pub const COORD_ZOOM_LEVEL: u32 = 20;
pub const TILE_SIZE_BITS: u32 = 8;
pub const TILE_SIZE: u32 = 1 << TILE_SIZE_BITS;
pub const SUB_PIXEL_BITS: u32 = 1;
pub const SUB_PIXEL_MASK: u32 = (1 << SUB_PIXEL_BITS) - 1;
pub const SUB_PIXEL_MUL: LatLon = (1u32 << SUB_PIXEL_BITS) as LatLon;
/// World units per tile: tile size × sub-pixel multiplier.
pub const WORLD_FACTOR: u32 = TILE_SIZE * (1 << SUB_PIXEL_BITS);
pub const ZOOM_FACTOR: u32 = 1 << COORD_ZOOM_LEVEL;
/// World units for the whole earth: 2^29.
pub const COORD_FACTOR: LatLon = ZOOM_FACTOR as LatLon * WORLD_FACTOR as LatLon;
/// WebMercator latitude limits.
pub const MAX_LAT: LatLon = 85.0511;
pub const MIN_LAT: LatLon = -85.0511;

/// The shift applied to raw projected coordinates (0..2^29) to center the
/// usable range around 0: `-(2^28 - 1)`.
pub const HALF_SHIFT: World =
    -((1 << (COORD_ZOOM_LEVEL + TILE_SIZE_BITS + SUB_PIXEL_BITS - 1)) - 1);
/// Minimum world coordinate of the normal (non-overflowed) range.
pub const WORLD_MIN: World = HALF_SHIFT;
/// Maximum world coordinate of the normal (non-overflowed) range.
pub const WORLD_MAX: World =
    (1 << (COORD_ZOOM_LEVEL + TILE_SIZE_BITS + SUB_PIXEL_BITS)) - 1 + HALF_SHIFT;
/// The value to add/subtract to shift a coordinate by a whole earth (in lon): 2^29.
pub const WORLD_SHIFT: World = WORLD_MAX - WORLD_MIN + 1;

/// Saturating add — the reference's `Limits::shift`, clipping at the type
/// (not world-range) min/max.
#[inline]
pub fn world_shift(v: World, shift: World) -> World {
    v.saturating_add(shift)
}

/// Clip a value to the normal world range [`WORLD_MIN`]..=[`WORLD_MAX`].
#[inline]
pub fn world_clip(v: World) -> World {
    v.clamp(WORLD_MIN, WORLD_MAX)
}

/// Is the value within the normal world range (no overflow)?
#[inline]
pub fn world_in_range(v: World) -> bool {
    (WORLD_MIN..=WORLD_MAX).contains(&v)
}

/// Shift `x` by whole worlds ([`WORLD_SHIFT`]) until within half a world of
/// `anchor` — may leave the normal range on purpose, making ±180° geometry
/// contiguous. Saturates at `i32` bounds for pathological anchors.
pub fn unwrap_towards(x: World, anchor: i64) -> World {
    let mut v = x as i64;
    let half = WORLD_SHIFT as i64 / 2;
    while v - anchor > half {
        v -= WORLD_SHIFT as i64;
    }
    while anchor - v > half {
        v += WORLD_SHIFT as i64;
    }
    v.clamp(i32::MIN as i64, i32::MAX as i64) as World
}

/// Unwrap a connected point sequence across the ±180° seam: every vertex is
/// shifted by whole worlds so consecutive x-jumps stay within half a world.
/// A ring crossing the antimeridian becomes contiguous (partly outside the
/// normal world x-range) instead of spanning the whole world.
pub fn unwrap_seam_x(pts: &mut [WorldXy]) {
    for i in 1..pts.len() {
        let prev = pts[i - 1].x as i64;
        pts[i].x = unwrap_towards(pts[i].x, prev);
    }
}

/// Shift a whole (already unwrapped) part by one common multiple of
/// [`WORLD_SHIFT`] so its first vertex lands within half a world of
/// `anchor` — keeps the parts of a multi-part geometry in one seam frame.
pub fn unwrap_anchor(pts: &mut [WorldXy], anchor: i64) {
    let Some(first) = pts.first() else { return };
    let delta = unwrap_towards(first.x, anchor) as i64 - first.x as i64;
    if delta != 0 {
        for p in pts.iter_mut() {
            p.x = (p.x as i64 + delta).clamp(i32::MIN as i64, i32::MAX as i64) as World;
        }
    }
}

/// Sign-preserving bit shift (`shift > 0` shifts left); negative values are
/// negated before shifting, so right shifts round toward zero — unlike
/// Rust's `>>`. Matches the reference; downstream geometry depends on this.
#[inline]
pub fn bitshift(v: i32, shift: i32) -> i32 {
    if v == 0 || shift == 0 {
        return v;
    }
    if shift < 0 {
        if v < 0 {
            -((-v) >> (-shift))
        } else {
            v >> (-shift)
        }
    } else if v < 0 {
        -((-v) << shift)
    } else {
        v << shift
    }
}

/// Longitude → world x, normalizing lon into [-180, 180] first.
#[inline]
pub fn lon_to_worldx(mut lon: LatLon) -> World {
    while lon > 180.0 {
        lon -= 360.0;
    }
    while lon < -180.0 {
        lon += 360.0;
    }
    lon_to_worldx_no_clip(lon)
}

/// Longitude → world x without normalization: the result may overflow the
/// normal world range (used for easting/northing relative coordinates near
/// ±180°). Range checking is the caller's job.
#[inline]
pub fn lon_to_worldx_no_clip(lon: LatLon) -> World {
    // f64→i32 `as` saturates in Rust; the reference's implicit double→int32
    // conversion is UB when out of range, so saturation is a strict improvement.
    world_shift(
        ((lon + 180.0) / 360.0 * COORD_FACTOR).floor() as World,
        HALF_SHIFT,
    )
}

/// Latitude → world y. Latitude is clamped to [`MIN_LAT`], [`MAX_LAT`].
/// Note: y grows southward (north = smaller y).
#[inline]
pub fn lat_to_worldy(lat: LatLon) -> World {
    let lat = lat.clamp(MIN_LAT, MAX_LAT);
    let latrad = lat * PI / 180.0;
    world_shift(
        (((1.0 - latrad.tan().asinh() / PI) / 2.0 * COORD_FACTOR).floor()) as World,
        HALF_SHIFT,
    )
}

/// World x → longitude, wrapped into [-180, 180].
#[inline]
pub fn worldx_to_lon(x: World) -> LatLon {
    let mut rt = worldx_to_lon_no_clip(x);
    while rt > 180.0 {
        rt -= 360.0;
    }
    while rt < -180.0 {
        rt += 360.0;
    }
    rt
}

/// World x → longitude without wrapping (overflowed coordinates map outside ±180°).
#[inline]
pub fn worldx_to_lon_no_clip(x: World) -> LatLon {
    (x as LatLon - HALF_SHIFT as LatLon) / COORD_FACTOR * 360.0 - 180.0
}

/// World y → latitude.
#[inline]
pub fn worldy_to_lat(y: World) -> LatLon {
    let n = PI - 2.0 * PI * (y as LatLon - HALF_SHIFT as LatLon) / COORD_FACTOR;
    180.0 / PI * (0.5 * (n.exp() - (-n).exp())).atan()
}

/// (lat, lon) → world point. Note the argument order: latitude first,
/// but the point stores x = lon-derived, y = lat-derived.
#[inline]
pub fn lat_lon_to_world(lat: LatLon, lon: LatLon) -> WorldXy {
    WorldXy::new(lon_to_worldx(lon), lat_to_worldy(lat))
}

/// (lon, lat) point → world point (`LLXy` stores x = lon, y = lat).
#[inline]
pub fn ll_to_world(ll: LLXy) -> WorldXy {
    WorldXy::new(lon_to_worldx(ll.x), lat_to_worldy(ll.y))
}

/// World → pixel at `zoom`, dropping sub-pixel bits. The result is still
/// [`HALF_SHIFT`]-shifted, so it's only meaningful relative to a tile
/// origin; use [`world_to_abs_pixel`] for absolute 0-based pixels.
#[inline]
pub fn world_to_pixel(c: World, zoom: u32) -> Pixel {
    if zoom > COORD_ZOOM_LEVEL {
        return c;
    }
    bitshift(c, -(((COORD_ZOOM_LEVEL - zoom) + SUB_PIXEL_BITS) as i32))
}

/// World → absolute 0-based pixel at `zoom`, normalizing lon-overflow first.
#[inline]
pub fn world_to_abs_pixel(mut c: World, zoom: u32) -> Pixel {
    while c > WORLD_MAX {
        c = world_shift(c, -WORLD_SHIFT);
    }
    while c < WORLD_MIN {
        c = world_shift(c, WORLD_SHIFT);
    }
    c = world_clip(c);
    world_to_pixel(world_shift(c, -HALF_SHIFT), zoom)
}

/// World point → pixel point at `zoom` (relative; see [`world_to_pixel`]).
#[inline]
pub fn world_to_pixel_xy(c: WorldXy, zoom: u32) -> PixelXy {
    PixelXy::new(world_to_pixel(c.x, zoom), world_to_pixel(c.y, zoom))
}

/// Pixel at `zoom` → world units (zoom is clamped to [`COORD_ZOOM_LEVEL`]).
#[inline]
pub fn pixel_to_world(c: Pixel, zoom: u32) -> World {
    let zoom = zoom.min(COORD_ZOOM_LEVEL);
    bitshift(c, ((COORD_ZOOM_LEVEL - zoom) + SUB_PIXEL_BITS) as i32)
}

/// Easting/northing in Simple-Mercator meters relative to a reference point
/// (already in world coordinates) → world point. The x result may overflow
/// the normal world range near ±180°, by design (reference `worldFromSM`).
#[inline]
pub fn world_from_sm(x: f64, y: f64, ref_point: WorldXy) -> WorldXy {
    let z = WGS84_SEMIMAJOR_AXIS_METERS * MERCATOR_K0;
    // mercator meters → world units
    let iwz = COORD_FACTOR / (2.0 * PI * z);
    let yr = (ref_point.y as f64 - (y * iwz).round()) as World;
    let xr = (ref_point.x as f64 + (x * iwz).round()) as World;
    WorldXy::new(xr, yr)
}

/// Inverse of [`world_from_sm`]: world point → Simple-Mercator
/// easting/northing meters relative to `ref_point`. Used by the OSENC
/// fixture writer; `world_from_sm(sm_from_world(p))` round-trips to within
/// the f64→world rounding.
#[inline]
pub fn sm_from_world(p: WorldXy, ref_point: WorldXy) -> (f64, f64) {
    let z = WGS84_SEMIMAJOR_AXIS_METERS * MERCATOR_K0;
    // world units → mercator meters
    let wz = (2.0 * PI * z) / COORD_FACTOR;
    let e = (p.x as f64 - ref_point.x as f64) * wz;
    let n = (ref_point.y as f64 - p.y as f64) * wz;
    (e, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values computed by replicating the reference's double math
    // (Coordinates.h) independently in Python — not from this implementation.

    #[test]
    fn constants() {
        assert_eq!(HALF_SHIFT, -268_435_455);
        assert_eq!(WORLD_MIN, -268_435_455);
        assert_eq!(WORLD_MAX, 268_435_456);
        assert_eq!(WORLD_SHIFT, 536_870_912);
        assert_eq!(COORD_FACTOR, 536_870_912.0);
        assert_eq!(WORLD_FACTOR, 512);
        assert_eq!(TILE_SIZE, 256);
    }

    #[test]
    fn lon_to_worldx_known_values() {
        assert_eq!(lon_to_worldx(0.0), 1);
        assert_eq!(lon_to_worldx(9.0), 13_421_773);
        assert_eq!(lon_to_worldx(10.1234), 15_097_109);
        assert_eq!(lon_to_worldx(-122.4194), -182_565_041);
        assert_eq!(lon_to_worldx(-180.0), WORLD_MIN);
        // +180 is not wrapped (reference: `while (lon > 180)`), so it lands
        // one past WORLD_MAX.
        assert_eq!(lon_to_worldx(180.0), WORLD_MAX + 1);
        // wrapping
        assert_eq!(lon_to_worldx(190.0), lon_to_worldx(-170.0));
        assert_eq!(lon_to_worldx(-370.0), lon_to_worldx(-10.0));
    }

    #[test]
    fn lat_to_worldy_known_values() {
        assert_eq!(lat_to_worldy(0.0), 1);
        assert_eq!(lat_to_worldy(54.5), -97_332_342);
        assert_eq!(lat_to_worldy(37.7749), -60_923_608);
        assert_eq!(lat_to_worldy(-33.8568), 53_715_067);
        // clamping at the mercator latitude limit
        assert_eq!(lat_to_worldy(85.0511), -268_434_958);
        assert_eq!(lat_to_worldy(89.0), lat_to_worldy(85.0511));
        assert_eq!(lat_to_worldy(-89.0), lat_to_worldy(-85.0511));
        // north = smaller y
        assert!(lat_to_worldy(54.5) < lat_to_worldy(54.4));
    }

    #[test]
    fn round_trips() {
        // one world unit is ~6.7e-7 degrees of lon; allow a few units of slack
        for &lon in &[0.0, 9.0, -122.4194, 179.9, -179.9] {
            assert!(
                (worldx_to_lon(lon_to_worldx(lon)) - lon).abs() < 1e-5,
                "lon {lon}"
            );
        }
        for &lat in &[0.0, 54.5, 37.7749, -33.8568, 80.0, -80.0] {
            assert!(
                (worldy_to_lat(lat_to_worldy(lat)) - lat).abs() < 1e-5,
                "lat {lat}"
            );
        }
        // world-level round trip: lat/lon derived from a world coord maps back
        let w = lat_lon_to_world(54.5, 9.0);
        let back = lat_lon_to_world(worldy_to_lat(w.y), worldx_to_lon(w.x));
        assert!((back.x - w.x).abs() <= 1 && (back.y - w.y).abs() <= 1);
    }

    #[test]
    fn unwrap_seam_makes_crossings_contiguous() {
        let e = lon_to_worldx(179.99); // near WORLD_MAX
        let w = lon_to_worldx(-179.99); // near WORLD_MIN

        // eastward crossing: the western point unwraps past WORLD_MAX
        let mut pts = vec![WorldXy::new(e, 0), WorldXy::new(w, 0)];
        unwrap_seam_x(&mut pts);
        assert_eq!(pts[1].x, w + WORLD_SHIFT);
        assert!((pts[1].x as i64 - pts[0].x as i64).abs() < WORLD_SHIFT as i64 / 2);
        // westward crossing: the eastern point unwraps below WORLD_MIN
        let mut pts = vec![WorldXy::new(w, 0), WorldXy::new(e, 0)];
        unwrap_seam_x(&mut pts);
        assert_eq!(pts[1].x, e - WORLD_SHIFT);
        // no crossing: untouched
        let a = lon_to_worldx(9.0);
        let b = lon_to_worldx(10.0);
        let mut pts = vec![WorldXy::new(a, 1), WorldXy::new(b, 2)];
        unwrap_seam_x(&mut pts);
        assert_eq!(pts, vec![WorldXy::new(a, 1), WorldXy::new(b, 2)]);
    }

    #[test]
    fn unwrap_anchor_shifts_whole_parts() {
        let e = lon_to_worldx(179.99);
        let w = lon_to_worldx(-179.99);
        // a part on the far side of the seam moves as one block
        let mut part = vec![WorldXy::new(w, 0), WorldXy::new(w + 100, 0)];
        unwrap_anchor(&mut part, e as i64);
        assert_eq!(part[0].x, w + WORLD_SHIFT);
        assert_eq!(part[1].x, w + 100 + WORLD_SHIFT);
        // already in frame: untouched
        let mut near = vec![WorldXy::new(e - 50, 0)];
        unwrap_anchor(&mut near, e as i64);
        assert_eq!(near[0].x, e - 50);
    }

    #[test]
    fn bitshift_rounds_toward_zero() {
        assert_eq!(bitshift(5, -1), 2);
        assert_eq!(bitshift(-5, -1), -2); // Rust `-5 >> 1` would give -3
        assert_eq!(bitshift(5, 1), 10);
        assert_eq!(bitshift(-5, 1), -10);
        assert_eq!(bitshift(0, 5), 0);
        assert_eq!(bitshift(7, 0), 7);
    }

    #[test]
    fn abs_pixel() {
        // lon 0 at zoom 20: half of the 2^28-pixel world
        assert_eq!(world_to_abs_pixel(lon_to_worldx(0.0), 20), 134_217_728);
        // at zoom 0 the world is one 256px tile; lon 0 is at its center
        assert_eq!(world_to_abs_pixel(lon_to_worldx(0.0), 0), 128);
        assert_eq!(world_to_abs_pixel(WORLD_MIN, 0), 0);
        // lon overflow gets normalized back into the world first
        let x = lon_to_worldx(0.0) + WORLD_SHIFT;
        assert_eq!(world_to_abs_pixel(x, 0), 128);
    }

    #[test]
    fn pixel_world_round_trip() {
        for zoom in [0u32, 10, 20] {
            let w = pixel_to_world(123, zoom);
            assert_eq!(world_to_pixel(w, zoom), 123);
        }
        // above the max zoom, world coords pass through unchanged
        assert_eq!(world_to_pixel(4242, 25), 4242);
    }

    #[test]
    fn world_from_sm_known_values() {
        let rp = WorldXy::new(lon_to_worldx(9.0), lat_to_worldy(54.5));
        assert_eq!(world_from_sm(0.0, 0.0, rp), rp);
        // 1000m east, 2000m north of the reference point
        assert_eq!(
            world_from_sm(1000.0, 2000.0, rp),
            WorldXy::new(13_435_175, -97_359_146)
        );
    }

    #[test]
    fn sm_round_trips_through_world() {
        let rp = WorldXy::new(lon_to_worldx(9.0), lat_to_worldy(54.5));
        for p in [
            rp,
            WorldXy::new(rp.x + 4321, rp.y - 999),
            WorldXy::new(rp.x - 100_000, rp.y + 55_555),
        ] {
            let (e, n) = sm_from_world(p, rp);
            assert_eq!(world_from_sm(e, n, rp), p);
        }
        // and the known forward values invert
        let (e, n) = sm_from_world(WorldXy::new(13_435_175, -97_359_146), rp);
        assert!(
            (e - 1000.0).abs() < 0.5 && (n - 2000.0).abs() < 0.5,
            "{e} {n}"
        );
    }
}
