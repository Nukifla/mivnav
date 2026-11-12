// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Turning a found [`TopologyRoute`] into a coarse world-space polyline
//! the backend can drive a LEG-BY-LEG fine search along.
//!
//! # Why this exists
//!
//! [`super::query`]'s own docs spell out the conservative call this module
//! works around: you cannot hand `routing::artifact`'s fine search a
//! corridor-scoped cell slice from outside that module, because
//! `routing::artifact::constraints::build` derives two region-global
//! scalars (finest `compilation_scale`, coarsest `catzoc_horizontal_m`)
//! over whatever slice it gets, so dropping a distant cell can move the
//! grid's resolution rung and change the route
//! ([`super::query::corridor_scope_extent`]'s counterexample test). That
//! closes the "one big fine search, scoped to a topology corridor" path.
//!
//! It does NOT close the *hierarchical* path: let the portal graph
//! produce a coarse polyline over the WHOLE chart set (no ±50 km
//! straight-line corridor cap — that cap is `routing::raster`'s, and the
//! portal graph search in [`super::query::topology_route_graced`] has no
//! such limit), then run the existing fine search between each pair of
//! consecutive coarse points. Every such leg is short, so its own honest
//! candidate-cell slice is small and the region-global-scalar problem
//! never bites — each leg genuinely is a local route. This is the same
//! shape the backend's `_stitch_macro_route` already uses for the
//! `raster` algorithm, driven there by `routing::raster::macro_route`
//! instead of this portal graph.
//!
//! This module is the seam between the two halves: [`coarse_polyline`]
//! extracts the polyline; the backend
//! (`mivnav.features.routing.routes._stitch_mivnav_coarse_route`) does
//! the per-leg composition. Nothing here looks at a real depth sounding
//! or hazard ring — it is pure geometry over the artifact's own tile
//! lattice and portal list, exactly as loose as [`super::query::
//! corridor_extent`] is and for the same reason (§8.4: "the topology is
//! an acceleration structure and never overrides §5.2 or §16").

use crate::coords::WorldXy;
use crate::routing::hazards::world_distance_m;

use super::build::BuiltRegion;
use super::portals::{portal_crossing_point, Portal};
use super::query::TopologyRoute;

/// Consecutive coarse points closer than this (real metres) are merged —
/// the second is dropped. Purely a guard against a DEGENERATE leg the
/// fine search cannot use (two portal crossings that are effectively the
/// same point: adjacent tiny tiles, or the same seam corner reached
/// twice on the way in and out of one tile). It is deliberately small:
/// a real bend in the route is two portals that are whole tiles apart,
/// well beyond this, so merging never straightens a turn the per-leg
/// fine search would then have to re-discover. Not a corridor-shaping
/// parameter — [`coarse_polyline`] shapes nothing, it only reports where
/// the portal graph already went.
pub const MIN_COARSE_LEG_M: f64 = 200.0;

/// The coarse world-space polyline implied by a found [`TopologyRoute`]:
/// the [`portal_crossing_point`] of each hop, in hop order, with a
/// consecutive point dropped when it sits within [`MIN_COARSE_LEG_M`] of
/// the previous kept one.
///
/// **INTERIOR points only.** `route`'s own `start_tile`/`goal_tile` are
/// tile indices, and a topology route's endpoints snap to tile CENTRES
/// ([`super::query::snap_point`]), not to where the caller's real query
/// points were — so the caller prepends its own `from` and appends its
/// own `to`, and re-applies the same near-merge at those two joints.
///
/// Empty when `route.hops` is empty — a same-tile "already there" route,
/// which is a valid answer (the caller's polyline is then just
/// `[from, to]`), not a failure. A hop whose `portal` index is out of
/// range for `portals`, or whose two tiles are not edge-adjacent in
/// `built` (neither can happen for a route this crate's own search
/// produced against the matching band), is skipped rather than panicked
/// on — this module tree's standing "a version-skewed or corrupt file
/// must not panic" rule.
pub fn coarse_polyline(
    built: &BuiltRegion,
    portals: &[Portal],
    route: &TopologyRoute,
) -> Vec<WorldXy> {
    let mut out: Vec<WorldXy> = Vec::with_capacity(route.hops.len());
    for hop in &route.hops {
        let Some(portal) = portals.get(hop.portal as usize) else {
            continue;
        };
        let Some(pt) = portal_crossing_point(built, portal) else {
            continue;
        };
        if let Some(&last) = out.last() {
            if world_distance_m(last, pt) < MIN_COARSE_LEG_M {
                continue;
            }
        }
        out.push(pt);
    }
    out
}

/// [`coarse_polyline`], with `from` prepended and `to` appended and the
/// same [`MIN_COARSE_LEG_M`] near-merge applied at both joints — the
/// full `[from, …interior…, to]` polyline a leg-stitching caller wants,
/// always at least `[from, to]`.
pub fn coarse_polyline_with_endpoints(
    built: &BuiltRegion,
    portals: &[Portal],
    route: &TopologyRoute,
    from: WorldXy,
    to: WorldXy,
) -> Vec<WorldXy> {
    let interior = coarse_polyline(built, portals, route);
    let mut out: Vec<WorldXy> = Vec::with_capacity(interior.len() + 2);
    out.push(from);
    for pt in interior {
        if world_distance_m(*out.last().expect("from was pushed"), pt) >= MIN_COARSE_LEG_M {
            out.push(pt);
        }
    }
    // `to` replaces EVERY trailing interior point within the merge slack
    // of it — a loop, not a single pop, and symmetric with the leading
    // joint above: `coarse_polyline` only spaces interior points against
    // each OTHER, never against `to`, so more than one can sit inside the
    // slack of the real destination. `out.len() > 1` keeps `from`.
    while out.len() > 1 && world_distance_m(*out.last().expect("non-empty"), to) < MIN_COARSE_LEG_M
    {
        out.pop();
    }
    out.push(to);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::lat_lon_to_world;
    use crate::mivnav::build::{BuildReport, BuiltRegion};
    use crate::mivnav::field::TileEntry;
    use crate::mivnav::query::{TopologyHop, TopologyRoute};

    // `cols * CELL_WORLD` world units ~ 2.8 km at the strip's latitude —
    // comfortably more than MIN_COARSE_LEG_M, so adjacent seams are never
    // merged just for being adjacent.
    const CELL_WORLD: i32 = 4096;
    const COLS: u16 = 16;
    const ROWS: u16 = 16;

    /// A horizontal strip of `n` identical square tiles anchored near
    /// 55°N 10°E (so `world_distance_m`'s secant(lat) scaling is
    /// realistic), tile `k` one tile-width east of tile `k - 1`.
    /// Edge-adjacent, same rung — enough for [`portal_crossing_point`]'s
    /// seam geometry, which is all [`coarse_polyline`] leans on. Payload
    /// columns are left empty: nothing here reads them.
    fn strip(n: u32) -> BuiltRegion {
        let anchor = lat_lon_to_world(55.0, 10.0);
        let tiles = (0..n)
            .map(|k| TileEntry {
                origin_x: anchor.x + k as i32 * i32::from(COLS) * CELL_WORLD,
                origin_y: anchor.y,
                cell_world: CELL_WORLD,
                rung: 0,
                tile_flags: 0,
                cols: COLS,
                rows: ROWS,
                triggers: 0,
                payload_offset: 0,
            })
            .collect();
        BuiltRegion {
            tiles,
            depth_min: Vec::new(),
            depth_max: Vec::new(),
            flags: Vec::new(),
            stitch: Vec::new(),
            report: BuildReport::default(),
        }
    }

    fn seam_x(built: &BuiltRegion, left_tile: u32) -> i32 {
        let t = &built.tiles[left_tile as usize];
        t.origin_x + i32::from(t.cols) * t.cell_world
    }

    /// An East-facing portal on tile `t`'s shared seam with tile `t + 1`,
    /// spanning tile rows `[start, end)` of the seam.
    fn east_portal(id: u32, t: u32, start: u16, end: u16) -> Portal {
        Portal {
            id,
            component: 0,
            tile: t,
            tile_start: start,
            tile_end: end,
            neighbour_tile: t + 1,
            neighbour_start: start,
            neighbour_end: end,
            max_draft_dm: 50,
            min_horizontal_width_dm: 2000,
            touches_fairway: false,
            touches_tss: false,
            lower_bound_cost_mm: 0,
        }
    }

    fn hop(portal: u32, tile: u32) -> TopologyHop {
        TopologyHop {
            portal,
            tile,
            neighbour_tile: tile + 1,
        }
    }

    fn route(hops: Vec<TopologyHop>) -> TopologyRoute {
        TopologyRoute {
            start_tile: 0,
            goal_tile: hops.last().map_or(0, |h| h.neighbour_tile),
            hops,
            cost_mm: 0,
            demoted_portals: Vec::new(),
            directional_penalized_portals: Vec::new(),
        }
    }

    #[test]
    fn one_crossing_point_per_hop_in_order_on_each_seam() {
        let built = strip(3);
        let portals = vec![east_portal(0, 0, 0, ROWS), east_portal(1, 1, 0, ROWS)];
        let line = coarse_polyline(&built, &portals, &route(vec![hop(0, 0), hop(1, 1)]));
        assert_eq!(line.len(), 2);
        assert_eq!(line[0].x, seam_x(&built, 0));
        assert_eq!(line[1].x, seam_x(&built, 1));
        // Full-seam span -> midpoint row -> same y for both.
        assert_eq!(line[0].y, line[1].y);
    }

    #[test]
    fn a_same_tile_route_has_no_interior_points() {
        let built = strip(2);
        let portals = vec![east_portal(0, 0, 0, ROWS)];
        assert!(coarse_polyline(&built, &portals, &route(vec![])).is_empty());
    }

    #[test]
    fn consecutive_duplicate_crossings_are_merged() {
        let built = strip(3);
        // Two portals on the SAME seam (0|1) with the IDENTICAL span ->
        // the identical crossing point -> the second is dropped. hop 2
        // crosses the next seam and is kept.
        let portals = vec![
            east_portal(0, 0, 4, 12),
            east_portal(1, 0, 4, 12),
            east_portal(2, 1, 0, ROWS),
        ];
        let line = coarse_polyline(
            &built,
            &portals,
            &route(vec![hop(0, 0), hop(1, 0), hop(2, 1)]),
        );
        assert_eq!(line.len(), 2);
        assert_eq!(line[0].x, seam_x(&built, 0));
        assert_eq!(line[1].x, seam_x(&built, 1));
    }

    #[test]
    fn an_out_of_range_portal_index_is_skipped_not_panicked() {
        let built = strip(3);
        let portals = vec![east_portal(0, 0, 0, ROWS)];
        let line = coarse_polyline(&built, &portals, &route(vec![hop(0, 0), hop(9, 1)]));
        assert_eq!(line.len(), 1);
        assert_eq!(line[0].x, seam_x(&built, 0));
    }

    #[test]
    fn endpoints_wrapper_always_brackets_from_and_to() {
        let built = strip(3);
        let portals = vec![east_portal(0, 0, 0, ROWS), east_portal(1, 1, 0, ROWS)];
        // Well clear of the strip's own seams (tiles are ~2.8 km wide).
        let west = built.tiles[0].origin_x;
        let mid_y = built.tiles[0].origin_y + i32::from(ROWS) * CELL_WORLD / 2;
        let from = WorldXy::new(west - 10 * CELL_WORLD, mid_y);
        let to = WorldXy::new(seam_x(&built, 1) + 10 * CELL_WORLD, mid_y);
        let line = coarse_polyline_with_endpoints(
            &built,
            &portals,
            &route(vec![hop(0, 0), hop(1, 1)]),
            from,
            to,
        );
        assert_eq!(*line.first().unwrap(), from);
        assert_eq!(*line.last().unwrap(), to);
        assert_eq!(line.len(), 4);
    }

    #[test]
    fn endpoints_wrapper_on_a_same_tile_route_is_just_from_to() {
        let built = strip(2);
        let portals: Vec<Portal> = Vec::new();
        let from = WorldXy::new(0, 0);
        let to = WorldXy::new(100, 100);
        let line = coarse_polyline_with_endpoints(&built, &portals, &route(vec![]), from, to);
        assert_eq!(line, vec![from, to]);
    }

    #[test]
    fn the_trailing_to_merge_drops_every_interior_point_near_the_destination() {
        // A dedicated fine-cell region so two SURVIVING interior points
        // (>= MIN_COARSE_LEG_M apart) can BOTH still sit within the merge
        // slack of `to` — the asymmetry a single trailing `pop()` missed.
        let anchor = lat_lon_to_world(55.0, 10.0);
        let cw: i32 = 512;
        let rows: u16 = 32;
        let cols: u16 = 16;
        let tile = |k: u32| TileEntry {
            origin_x: anchor.x + k as i32 * i32::from(cols) * cw,
            origin_y: anchor.y,
            cell_world: cw,
            rung: 0,
            tile_flags: 0,
            cols,
            rows,
            triggers: 0,
            payload_offset: 0,
        };
        let built = BuiltRegion {
            tiles: vec![tile(0), tile(1)],
            depth_min: Vec::new(),
            depth_max: Vec::new(),
            flags: Vec::new(),
            stitch: Vec::new(),
            report: BuildReport::default(),
        };
        // Two crossings on the one seam, rows 10..14 and 20..24 -> seam
        // midpoints ~10 rows * 512 ~ 219 m apart (just over the floor, so
        // both survive `coarse_polyline`). An artificial two-hop route:
        // it only has to exercise the trailing merge, not be a realistic
        // topology path.
        let portals = vec![east_portal(0, 0, 10, 14), east_portal(1, 0, 20, 24)];
        let a = portal_crossing_point(&built, &portals[0]).unwrap();
        let b = portal_crossing_point(&built, &portals[1]).unwrap();
        assert!(
            world_distance_m(a, b) >= MIN_COARSE_LEG_M,
            "both interior points survive"
        );
        // `to` at the seam, midway between the two crossings: within the
        // slack of BOTH.
        let to = WorldXy::new(a.x, (a.y + b.y) / 2);
        assert!(world_distance_m(a, to) < MIN_COARSE_LEG_M);
        assert!(world_distance_m(b, to) < MIN_COARSE_LEG_M);

        let from = WorldXy::new(anchor.x - 20 * cw, to.y);
        let line = coarse_polyline_with_endpoints(
            &built,
            &portals,
            &route(vec![hop(0, 0), hop(1, 0)]),
            from,
            to,
        );
        assert_eq!(
            line,
            vec![from, to],
            "both near-`to` interior points dropped, not just one"
        );
    }
}
