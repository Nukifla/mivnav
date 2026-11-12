// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Per-CELL, depth-independent land-hazard distance-field bake.
//!
//! [`CellHazardBake::build`] precomputes exactly what `super::size_grid` +
//! `super::rasterize` + `super::distance_field::DistanceField` already
//! compute per REQUEST CORRIDOR — but once per chart CELL, at its own
//! natural resolution over its own full extent, independent of any
//! particular `from`/`to`. Promoted from a `#[cfg(test)]`-only measurement
//! prototype (`bake_prototype.rs`, since removed) that set out to answer
//! one feasibility question directly: is a per-cell bake (a) fine enough
//! to catch the resolution-miss bug `raster.rs`'s own
//! `a_thin_hazard_the_rasterizer_misses_is_still_caught_by_exact_leg_
//! verification` test demonstrates (grid resolution is set from the
//! REQUEST corridor's span, not local hazard density, so a hazard thinner
//! than the rasterizer's own row spacing can fall entirely between
//! samples), (b) cheap enough to build/store per cell, and (c) still need
//! the live `clip_to_authority` step near a chart boundary. Measured
//! against a real chart (`backend/data/fnc/DE6OSTIM.S57`): build cost
//! ~90–220µs, ~9.2KiB serialized, 4–6x faster per-request than live
//! rasterize+distance-field, and it DID reproduce the resolution-miss bug
//! directly (a live per-request grid at 10.5m/cell missed a strip a
//! whole-cell bake at 6.0m/cell — `MIN_CELL_M`'s own floor — caught).
//!
//! **Not wired into the search.** A cheaper, smaller fix closed the
//! specific gap the measurement found: `raster.rs`'s own
//! `REFINE_PAD_FLOOR_M` (vs. the full `CORRIDOR_PAD_FLOOR_M`) for
//! `refine_flagged_legs`'s own recursive re-search — a flagged run's own
//! two endpoints are already real bend points of an almost-working route,
//! not "two points a few metres apart" the full floor exists to protect,
//! so a smaller floor there reaches the SAME `MIN_CELL_M` resolution a
//! bake would, with no caching machinery at all (verified end to end:
//! `raster::tests::refine_pad_floor_catches_a_thin_hazard_the_top_level_
//! corridor_misses`). This module is landed anyway, as a real, tested,
//! standalone primitive: the measurement work already justified building
//! it for real rather than leaving it a throwaway prototype, and it has
//! its own legitimate consumers going forward — `macro_route`'s land-only
//! candidate-cell building already does something conceptually similar
//! (a coarse land/water topology query over a large box) at a much
//! coarser scale, and a future wiring into the search's own refine step
//! would build on exactly this primitive rather than starting over.
//!
//! # Depth independence
//!
//! `margin_m` is a real parameter (the caller's own hard-clearance-floor
//! constant — this crate has no opinion on what it should be); depth is
//! not. [`DEPTH_INDEPENDENT_PROBE_M`] is passed as `build_hazard_index`'s
//! own `safety_depth_m`, a sentinel far below any real charted depth
//! value, so every DEPTH-GATED class's own `d <= safety_depth_m` test
//! (`DEPARE`/`DRGARE`/`WRECKS`/`OBSTRN`/`UWTROC` — see
//! `crate::routing::hazards`'s own docs) is false for any real depth
//! reading, isolating exactly the depth-INDEPENDENT terms this bake needs
//! (`LNDARE` always; `RESARE`/`MIPARE` gated on entry-prohibition, not
//! depth) — the whole reason ONE bake can serve every `safety_depth_m` a
//! caller might separately ask for, keyed only on `margin_m`
//! (`backend/mivnav/features/ocharts/service.py`'s own cache key omits
//! depth for exactly this reason).
//!
//! # Self-limiting to Harbour/Approach scale
//!
//! [`CellHazardBake::build`] returns `None` when [`super::size_grid`]'s
//! own resolution decision for the cell's FULL extent would still need to
//! be coarser than [`super::MAX_CELL_M`] even at [`super::HARD_MAX_DIM`]'s
//! hard cell-count cap — i.e. the cell is too large for a per-cell bake to
//! be worth anything finer than what a per-request corridor already gets
//! for free. This is what scopes baking to small (Harbour/Approach-scale)
//! cells without hardcoding a chart-scale/usage-band check: a General or
//! Overview-scale cell's own huge extent self-selects out.

use crate::coords::{
    lat_lon_to_world, lat_to_worldy, lon_to_worldx, worldx_to_lon, worldy_to_lat, WorldXy,
};
use crate::model::Cell;
use crate::routing::hazards::build_hazard_index;

use super::distance_field::DistanceField;
use super::{rasterize, size_grid, world_to_cell, Corridor, MAX_CELL_M};

/// Far below any real charted depth value — see the module's own "Depth
/// independence" docs for exactly what passing this as `safety_depth_m`
/// isolates.
const DEPTH_INDEPENDENT_PROBE_M: f64 = -9999.0;

/// A precomputed distance-to-nearest-land-hazard field over one chart
/// CELL's own full extent, at that cell's own natural resolution — see the
/// module's own docs for what it's for and why it's not (yet) wired into
/// the live search.
pub struct CellHazardBake {
    xmin: i32,
    xmax: i32,
    ymin: i32,
    ymax: i32,
    cell_size_world: f64,
    cell_size_m: f64,
    cols: u32,
    rows: u32,
    field: DistanceField,
}

impl CellHazardBake {
    /// Build from `cell`'s own decoded+derived features, buffered outward
    /// by `margin_m` real clearance metres (the caller's own hard-floor
    /// constant — see `super::CostModel::lateral_margin`'s own docs for
    /// why this crate never bakes a margin value in itself).
    ///
    /// `None` when: `cell` charts no depth-independent hazard at all
    /// (`build_hazard_index` itself returns `None` — nothing but open
    /// water, e.g. a coastal cell with no land in frame); the cell's own
    /// full-extent grid would need to be coarser than [`MAX_CELL_M`] even
    /// at [`super::HARD_MAX_DIM`]'s cap (see the module's own "Self-
    /// limiting" docs — too big a cell for a bake at this resolution to
    /// be worth anything); or (defensively; not expected once the extent
    /// check above already passed, since the hazard union comes from the
    /// same cell whose own extent sized the grid) rasterizing that hazard
    /// union onto the sized grid happens to mark nothing blocked at all.
    pub fn build(cell: &Cell, margin_m: f64) -> Option<CellHazardBake> {
        let idx = build_hazard_index(cell, DEPTH_INDEPENDENT_PROBE_M, margin_m, 0.0)?;
        let corridor = Corridor {
            xmin: cell.extent.xmin,
            xmax: cell.extent.xmax,
            ymin: cell.extent.ymin,
            ymax: cell.extent.ymax,
        };
        let spec = size_grid(&corridor);
        if spec.cell_size_m > MAX_CELL_M {
            return None;
        }
        let grid = rasterize(
            &idx.rings,
            &corridor,
            spec.cell_size_world,
            spec.cols,
            spec.rows,
        );
        let field = DistanceField::build(&grid)?;
        Some(CellHazardBake {
            xmin: corridor.xmin,
            xmax: corridor.xmax,
            ymin: corridor.ymin,
            ymax: corridor.ymax,
            cell_size_world: spec.cell_size_world,
            cell_size_m: spec.cell_size_m,
            cols: spec.cols,
            rows: spec.rows,
            field,
        })
    }

    fn corridor(&self) -> Corridor {
        Corridor {
            xmin: self.xmin,
            xmax: self.xmax,
            ymin: self.ymin,
            ymax: self.ymax,
        }
    }

    /// Distance in real ground metres from `(lon, lat)` to the nearest
    /// baked hazard cell — `0.0` when the query point's own cell is
    /// itself blocked, and also (same "off-grid reads as boundary"
    /// convention [`DistanceField::dist_m`] itself already has) when the
    /// point falls outside this bake's own extent entirely; a caller that
    /// cares about that distinction should check [`Self::extent_lonlat`]
    /// first.
    pub fn dist_m(&self, lon: f64, lat: f64) -> f64 {
        let p = lat_lon_to_world(lat, lon);
        let corridor = self.corridor();
        let (cx, cy) = world_to_cell(&corridor, self.cell_size_world, p);
        self.field.dist_m(cx, cy, self.cell_size_m)
    }

    /// The MINIMUM baked distance (ground metres) over every cell whose
    /// own centre falls inside the `(west, south, east, north)` degrees
    /// box — a coarse "how close does charted land get, anywhere in this
    /// smaller box" query without re-rasterizing, cropped from the
    /// already-built whole-cell field. `None` when the box doesn't
    /// overlap this bake's own extent at all. The "crop" primitive a
    /// consumer like `macro_route`'s own land-only candidate-cell
    /// building (`raster.rs`) would use — see the module's own docs for
    /// why that consumer isn't wired to this yet.
    pub fn min_dist_m_in_box(&self, west: f64, south: f64, east: f64, north: f64) -> Option<f64> {
        let box_xmin = lon_to_worldx(west);
        let box_xmax = lon_to_worldx(east);
        // World y grows southward (`Corridor`'s own convention): north is
        // the SMALLER y.
        let box_ymin = lat_to_worldy(north);
        let box_ymax = lat_to_worldy(south);

        if box_xmax < self.xmin
            || box_xmin > self.xmax
            || box_ymax < self.ymin
            || box_ymin > self.ymax
        {
            return None;
        }

        let corridor = self.corridor();
        let (cx0, cy0) = world_to_cell(
            &corridor,
            self.cell_size_world,
            WorldXy::new(
                box_xmin.clamp(self.xmin, self.xmax),
                box_ymin.clamp(self.ymin, self.ymax),
            ),
        );
        let (cx1, cy1) = world_to_cell(
            &corridor,
            self.cell_size_world,
            WorldXy::new(
                box_xmax.clamp(self.xmin, self.xmax),
                box_ymax.clamp(self.ymin, self.ymax),
            ),
        );
        let cx0 = cx0.clamp(0, self.cols as i32 - 1);
        let cx1 = cx1.clamp(0, self.cols as i32 - 1);
        let cy0 = cy0.clamp(0, self.rows as i32 - 1);
        let cy1 = cy1.clamp(0, self.rows as i32 - 1);

        let mut min_dist = f64::INFINITY;
        for cy in cy0.min(cy1)..=cy0.max(cy1) {
            for cx in cx0.min(cx1)..=cx0.max(cx1) {
                min_dist = min_dist.min(self.field.dist_m(cx, cy, self.cell_size_m));
            }
        }
        Some(min_dist)
    }

    /// `(w, s, e, n)` degrees — the cell's own extent this bake covers.
    pub fn extent_lonlat(&self) -> (f64, f64, f64, f64) {
        (
            worldx_to_lon(self.xmin),
            worldy_to_lat(self.ymax),
            worldx_to_lon(self.xmax),
            worldy_to_lat(self.ymin),
        )
    }

    pub fn cell_size_m(&self) -> f64 {
        self.cell_size_m
    }

    /// `(cols, rows)` — the baked grid's own dimensions.
    pub fn dims(&self) -> (u32, u32) {
        (self.cols, self.rows)
    }

    /// Rough heap footprint, for the backend's own RAM budget
    /// (`OchartsService.land_bakes`, a `SingleFlightLRU` — same role
    /// `Cell.approx_bytes`/`HazardIndex.approx_bytes` play for their own
    /// caches, `python.rs`). The field is stored as `f64` internally
    /// (`DistanceField`'s own exact transform), so this is the actual
    /// resident size, not a hypothetical serialized one.
    pub fn approx_bytes(&self) -> u64 {
        self.cols as u64 * self.rows as u64 * std::mem::size_of::<f64>() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AttrValue, CellMeta, Feature, Geometry, Polygon};
    use std::collections::BTreeMap;

    const LAT: f64 = 55.0;
    const LON: f64 = 12.0;

    fn de6ostim_cell() -> Cell {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../backend/data/fnc/DE6OSTIM.S57");
        let file = std::fs::File::open(&path).expect("DE6OSTIM fixture reads");
        let mut cell = crate::osenc::read_cell(file).expect("DE6OSTIM fixture decodes");
        crate::derive::apply(&mut cell);
        cell
    }

    /// Same real-clearance margin `routing_de6ostim.rs`'s own tests and
    /// `mivnav/features/routing/routes.py`'s default use.
    const MARGIN_M: f64 = 30.0;

    /// Same shape as `hazards.rs`'s own private test helper of the same
    /// name — duplicated rather than reused (that one is `mod tests`-
    /// private to `hazards.rs`), unions every feature's own extent into
    /// the cell's.
    fn cell(features: Vec<Feature>) -> Cell {
        let mut extent = crate::coords::Extent::invalid();
        for f in &features {
            extent.extend(&f.extent);
        }
        Cell {
            meta: CellMeta::default(),
            features,
            extent,
        }
    }

    /// A square ring `half_side_m` metres from centre to edge, closed
    /// (first point repeated) — same shape as `hazards.rs`'s own helper.
    fn square(lat: f64, lon: f64, half_side_m: f64) -> Vec<WorldXy> {
        let dlat = half_side_m / 111_320.0;
        let dlon = half_side_m / (111_320.0 * lat.to_radians().cos());
        vec![
            lat_lon_to_world(lat - dlat, lon - dlon),
            lat_lon_to_world(lat - dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon + dlon),
            lat_lon_to_world(lat + dlat, lon - dlon),
            lat_lon_to_world(lat - dlat, lon - dlon),
        ]
    }

    fn lndare(lat: f64, lon: f64, side_m: f64) -> Feature {
        Feature::new(
            71,
            "LNDARE".into(),
            BTreeMap::new(),
            Some(Geometry::Areas(vec![Polygon {
                outer: square(lat, lon, side_m),
                holes: vec![],
            }])),
        )
    }

    /// A `WRECKS` point carrying an already-derived `depth_value` — same
    /// shape as `hazards.rs`'s own helper.
    fn wreck(lat: f64, lon: f64, depth_value: f64) -> Feature {
        let mut attrs = BTreeMap::new();
        attrs.insert("depth_value".to_string(), AttrValue::Float(depth_value));
        Feature::new(
            159,
            "WRECKS".into(),
            attrs,
            Some(Geometry::Point(lat_lon_to_world(lat, lon))),
        )
    }

    #[test]
    fn builds_a_real_bake_for_a_real_small_cell() {
        let c = de6ostim_cell();
        let bake = CellHazardBake::build(&c, MARGIN_M).expect("DE6OSTIM charts real land");
        assert!(bake.cell_size_m() <= MAX_CELL_M);
        let (cols, rows) = bake.dims();
        assert!(cols > 0 && rows > 0);
        assert!(bake.approx_bytes() > 0);
        // MIN_CELL_M is the finest this crate ever rasterizes at — a real
        // small cell like DE6OSTIM should reach it (same number the
        // feasibility measurement this module replaces found: 6.0m/cell).
        assert_eq!(bake.cell_size_m(), super::super::MIN_CELL_M);
    }

    #[test]
    fn depth_independence_matches_a_sub_chart_minimum_safety_depth_bake_when_nothing_is_depth_gated(
    ) {
        // DE6OSTIM's own shallowest charted `drval1` is 0.0 (a real drying
        // band on this Wadden-Sea-adjacent cell — measured: only 0.0 and
        // 2.0 occur at all). `hazards::build_hazard_index` gates DEPARE on
        // `drval1 <= safety_depth_m` (the band's SHALLOW edge — see that
        // module's own docs for why), so `safety_depth_m=0.0` would now
        // hit that band; -0.5 stays below every real value on this fixture
        // while still being a realistic depth, not `DEPTH_INDEPENDENT_
        // PROBE_M`'s own far-below-anything sentinel.
        const BELOW_CHART_MINIMUM_M: f64 = -0.5;
        let c = de6ostim_cell();
        let idx_probe =
            build_hazard_index(&c, DEPTH_INDEPENDENT_PROBE_M, MARGIN_M, 0.0).expect("real land");
        let idx_zero =
            build_hazard_index(&c, BELOW_CHART_MINIMUM_M, MARGIN_M, 0.0).expect("real land");
        assert_eq!(
            idx_probe, idx_zero,
            "no DE6OSTIM DEPARE band's drval1 is this shallow — the two safety depths must agree"
        );

        let bake = CellHazardBake::build(&c, MARGIN_M).expect("real land");
        let (w, s, e, n) = bake.extent_lonlat();
        let lerp = |a: f64, b: f64, t: f64| a + (b - a) * t;
        for &(tx, ty) in &[(0.25, 0.5), (0.5, 0.5), (0.75, 0.25), (0.1, 0.9)] {
            let lon = lerp(w, e, tx);
            let lat = lerp(s, n, ty);

            // A live rasterize+field at the SAME grid the bake itself
            // used, straight from `idx_zero` — proves the bake's own
            // depth-independent construction is not silently including/
            // excluding anything a real, below-chart-minimum
            // `safety_depth_m` query wouldn't.
            let corridor = Corridor {
                xmin: c.extent.xmin,
                xmax: c.extent.xmax,
                ymin: c.extent.ymin,
                ymax: c.extent.ymax,
            };
            let spec = size_grid(&corridor);
            let grid = rasterize(
                &idx_zero.rings,
                &corridor,
                spec.cell_size_world,
                spec.cols,
                spec.rows,
            );
            let field = DistanceField::build(&grid).expect("real land blocks some cells");
            let p = lat_lon_to_world(lat, lon);
            let (cx, cy) = world_to_cell(&corridor, spec.cell_size_world, p);
            let expected = field.dist_m(cx, cy, spec.cell_size_m);

            assert_eq!(
                bake.dist_m(lon, lat),
                expected,
                "bake and a live below-chart-minimum-depth field must agree at ({lon}, {lat})"
            );
        }
    }

    /// Closes a real gap the measurement prototype this module replaces
    /// left open (see `bake.rs`'s own module docs): DE6OSTIM's real
    /// coastline never exercised a case where a DEPTH-GATED class
    /// actually qualifies at some `safety_depth_m` — this synthetic case
    /// does, and proves the bake still excludes it regardless.
    #[test]
    fn depth_gated_hazards_never_affect_the_bake_even_when_they_would_qualify_at_some_depth() {
        // A single WRECKS point at a shallow charted depth (2m) with NO
        // land anywhere in the cell — would qualify as a hazard at any
        // `safety_depth_m >= 2.0`, but must be completely invisible to the
        // depth-independent bake regardless.
        let c = cell(vec![wreck(LAT, LON, 2.0)]);

        // Sanity: this WRECKS point IS a real hazard at a real safety
        // depth — proves the fixture itself is valid, not a false-negative
        // setup.
        let idx_at_depth =
            build_hazard_index(&c, 5.0, MARGIN_M, 0.0).expect("the wreck qualifies at 5m");
        assert!(!idx_at_depth.rings.is_empty());

        // But the depth-INDEPENDENT bake must see nothing at all — no
        // land, no qualifying hazard — so `build` itself returns `None`
        // (nothing to bake), never a bake that happens to still catch the
        // wreck.
        assert!(
            CellHazardBake::build(&c, MARGIN_M).is_none(),
            "a depth-gated-only cell must bake to None, not silently include the wreck"
        );
    }

    #[test]
    fn self_limits_to_none_for_a_cell_too_large_to_bake_usefully() {
        // A cell spanning most of the globe in longitude, with a small
        // real land patch somewhere inside it — far past the point where
        // `size_grid`'s own HARD_MAX_DIM cap would force `cell_size_m`
        // coarser than MAX_CELL_M. Land existing inside it is not the
        // point (proven separately below); sizing alone must already say
        // "not worth it".
        let land = lndare(LAT, LON, 5_000.0);
        let west_edge = lat_lon_to_world(LAT, -170.0);
        let east_edge = lat_lon_to_world(LAT, 170.0);
        let mut c = cell(vec![land]);
        c.extent.xmin = west_edge.x;
        c.extent.xmax = east_edge.x;

        assert!(
            build_hazard_index(&c, DEPTH_INDEPENDENT_PROBE_M, MARGIN_M, 0.0).is_some(),
            "setup invalid: the cell must chart real land"
        );
        assert!(
            CellHazardBake::build(&c, MARGIN_M).is_none(),
            "a near-global-width cell must self-limit to no bake, not force a hugely coarse one"
        );
    }

    #[test]
    fn min_dist_m_in_box_crops_correctly() {
        let c = de6ostim_cell();
        let bake = CellHazardBake::build(&c, MARGIN_M).expect("real land");
        let (w, s, e, n) = bake.extent_lonlat();

        // The whole extent as a box must agree with the minimum over
        // every cell computed directly.
        let whole = bake
            .min_dist_m_in_box(w, s, e, n)
            .expect("the bake's own extent must overlap itself");
        let (cols, rows) = bake.dims();
        let mut direct_min = f64::INFINITY;
        for cy in 0..rows as i32 {
            for cx in 0..cols as i32 {
                direct_min = direct_min.min(bake.field.dist_m(cx, cy, bake.cell_size_m));
            }
        }
        assert_eq!(whole, direct_min);

        // A box entirely outside the extent is `None`.
        assert!(bake
            .min_dist_m_in_box(w - 10.0, s - 10.0, w - 5.0, s - 5.0)
            .is_none());
    }
}
