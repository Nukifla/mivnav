// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Performance regression guard for `routing::raster::shortest_path`.
//!
//! The bug this exists to catch: the OLD visibility-graph search
//! (`routing::graph`, retired) padded its search corridor by a multiple of
//! the route's own direct distance, so a longer route got a
//! proportionally BIGGER corridor and therefore MORE candidate hazard
//! vertices — the O(n²) pairwise-visibility cost it was built to bound
//! came right back for any sufficiently long route. Measured against the
//! real installed Danish o-charts set before the raster rewrite: 1.3nm
//! ~0.3s, 18nm 1.1s, 85nm 7.6s, ~400nm never returned in 14 minutes. The
//! raster search's whole reason for existing is bounding cost by grid
//! resolution instead — this test is the guard that keeps that true,
//! since the original regression had no automated guard at all and
//! reappeared silently.
//!
//! **Can't use the real Danish o-charts set here**: its cells are
//! `.oesu`, o-charts-DRM-encrypted, and decoding them needs a registered
//! `oexserverd` daemon plus a live subscription key — categorically
//! unavailable in a test environment (harder than the GDAL unavailability
//! `ROUTING_TODO.md` already records for this same sandbox). Instead this
//! builds a deterministic synthetic dense hazard field — several hundred
//! small square "islands" tiling a real ~85nm-scale area — standing in
//! for "a real, densely-charted coastline" densely enough that the direct
//! line is genuinely obstructed and the search must actually run the
//! raster+A* path, not just the direct-line fast path.

use chartcore::coords::lat_lon_to_world;
use chartcore::routing::{shortest_path, shortest_path_weighted};
use std::time::Instant;

const LAT: f64 = 55.5; // mid-Danish-waters latitude, matching the real benchmarks
const LON: f64 = 12.0;

/// A square ring `half_side_m` metres from centre to edge, centred on
/// `(lat, lon)`. Rough (equirectangular) but fine at test scales — same
/// helper shape `raster.rs`'s and `hazards.rs`'s own tests already use.
fn square(lat: f64, lon: f64, half_side_m: f64) -> Vec<chartcore::coords::WorldXy> {
    let dlat = half_side_m / 111_320.0;
    let dlon = half_side_m / (111_320.0 * lat.to_radians().cos());
    vec![
        lat_lon_to_world(lat - dlat, lon - dlon),
        lat_lon_to_world(lat - dlat, lon + dlon),
        lat_lon_to_world(lat + dlat, lon + dlon),
        lat_lon_to_world(lat + dlat, lon - dlon),
    ]
}

/// A deterministic (no RNG dependency) field of ~35x35 = 1,225 small
/// islands tiling an ~85km x 85km area — dense enough that a straight
/// line corner-to-corner is genuinely obstructed, not just a decoy corpus
/// sitting outside the search's own corridor. Grid spacing with a simple
/// hash-like jitter avoids the islands lining up into trivially-passable
/// lanes.
fn dense_island_field() -> Vec<Vec<chartcore::coords::WorldXy>> {
    let grid_n = 35;
    let spacing_m = 2_500.0; // ~85km across the whole field
    let island_half_side_m = 220.0; // wide enough relative to spacing to force real detours
    let mut rings = Vec::with_capacity(grid_n * grid_n);
    for row in 0..grid_n {
        for col in 0..grid_n {
            // Deterministic jitter, not random — a fixed test must be
            // reproducible. Every third cell on the diagonal is skipped so
            // a path genuinely exists (this is a passability fixture, not
            // a fully-enclosing wall).
            if (row + col) % 5 == 0 {
                continue;
            }
            let jitter_m = (((row * 7 + col * 13) % 5) as f64 - 2.0) * 300.0;
            let north_m = row as f64 * spacing_m;
            let east_m = col as f64 * spacing_m + jitter_m;
            let dlat = north_m / 111_320.0;
            let dlon = east_m / (111_320.0 * LAT.to_radians().cos());
            rings.push(square(LAT + dlat, LON + dlon, island_half_side_m));
        }
    }
    rings
}

#[test]
fn a_dense_field_at_real_passage_scale_stays_fast() {
    let rings = dense_island_field();
    let grid_n = 35.0;
    let spacing_m = 2_500.0;
    let span_m = grid_n * spacing_m; // ~85km, matching the real 85nm-ish benchmark scale
    let dlat = span_m / 111_320.0;
    let dlon = span_m / (111_320.0 * LAT.to_radians().cos());

    let a = lat_lon_to_world(LAT - 0.02, LON - 0.02); // just outside the field's SW corner
    let b = lat_lon_to_world(LAT + dlat + 0.02, LON + dlon + 0.02); // just outside its NE corner

    let start = Instant::now();
    let path = shortest_path(a, b, &rings);
    let elapsed = start.elapsed();

    eprintln!(
        "dense field ({} islands): {:?}, path found: {}",
        rings.len(),
        elapsed,
        path.is_some()
    );
    assert!(
        elapsed.as_secs_f64() < 5.0,
        "a corner-to-corner search across a dense, real-passage-scale hazard field \
         must stay well under 5s regardless of how many hazard rings are nearby — \
         took {elapsed:?}. This is exactly the regression class the raster rewrite \
         exists to prevent (see this file's own module docs)."
    );
    if let Some(route) = path {
        assert!(route.distance_m > 0.0);
    }
}

/// The other half of the regression this guards against: a route far
/// LONGER than any of the original visibility-graph benchmarks (the old
/// algorithm's cost scaled with distance itself, independent of hazard
/// density — this is what a ~400nm corner-to-corner request exercised,
/// and what never returned in 14 minutes before the raster rewrite).
/// Empty hazard set: the fast path should make this trivially instant
/// regardless, but it is also the cheapest possible way to prove distance
/// alone no longer costs anything by itself.
#[test]
fn a_very_long_route_with_nothing_in_the_way_is_instant() {
    let a = lat_lon_to_world(54.4, 3.3);
    let b = lat_lon_to_world(58.2, 16.4); // ~400nm apart, corner-to-corner across Denmark's own chart region

    let start = Instant::now();
    let path = shortest_path(a, b, &[]);
    let elapsed = start.elapsed();

    assert!(path.is_some());
    assert!(
        elapsed.as_secs_f64() < 1.0,
        "an unobstructed long route must hit the direct-line fast path, not scale \
         with distance at all — took {elapsed:?}"
    );
}

/// The turn-cost feature's own real, measured performance cost — asked for
/// directly, not estimated: the search's node type expands from `cell` to
/// `(cell, incoming_direction)` when `turn_cost_weight > 0.0`
/// (`routing::raster::search_grid_with_turn_cost`), 8x the theoretical state
/// space at the same grid resolution. This is the dense-hazard-field
/// scenario the task asked to measure against specifically — the same
/// corpus `a_dense_field_at_real_passage_scale_stays_fast` above already
/// uses, so the "off" and "on" numbers are directly comparable at the exact
/// same grid/corridor/hazard density, not two different scenarios.
///
/// Not a strict pass/fail gate on the exact ratio (a real `pathfinding::
/// astar` directed search's own expansion count is corpus-shape-dependent,
/// not a fixed multiple) — see this test's own `eprintln!` (`cargo test
/// turn_cost_state_expansion -- --nocapture`) and `ROUTING_TODO.md`'s
/// turn-cost entry for the real numbers this was checked against before
/// shipping. Still asserts a real ceiling (`< 5.0s`, matching the sibling
/// test above) so a genuine future regression — not just "turn cost costs
/// something", which is expected and documented, but "turn cost costs an
/// UNBOUNDED amount" — still fails loud.
#[test]
fn turn_cost_state_expansion_measured_cost_on_the_dense_field() {
    let rings = dense_island_field();
    let grid_n = 35.0;
    let spacing_m = 2_500.0;
    let span_m = grid_n * spacing_m;
    let dlat = span_m / 111_320.0;
    let dlon = span_m / (111_320.0 * LAT.to_radians().cos());

    let a = lat_lon_to_world(LAT - 0.02, LON - 0.02);
    let b = lat_lon_to_world(LAT + dlat + 0.02, LON + dlon + 0.02);

    let start_off = Instant::now();
    let off = shortest_path_weighted(
        a,
        b,
        &rings,
        0.0,
        0.0,
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        0.0,
        false,
    )
    .expect("a way through the dense field exists");
    let elapsed_off = start_off.elapsed();

    // A real, non-token weight — not near-zero (which would risk measuring
    // nothing) and not at the field's own ceiling.
    let turn_cost_weight = 0.5;
    let start_on = Instant::now();
    let on = shortest_path_weighted(
        a,
        b,
        &rings,
        0.0,
        0.0,
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        turn_cost_weight,
        false,
    )
    .expect("turning on turn-cost weighting must not itself break an existing route");
    let elapsed_on = start_on.elapsed();

    eprintln!(
        "turn-cost OFF: {:?}, nodes_expanded={}, grid={}x{}, waypoints={}",
        elapsed_off,
        off.diagnostics.nodes_expanded,
        off.diagnostics.grid_cols,
        off.diagnostics.grid_rows,
        off.waypoints.len()
    );
    eprintln!(
        "turn-cost ON (weight={turn_cost_weight}): {:?}, nodes_expanded={}, grid={}x{}, waypoints={}",
        elapsed_on,
        on.diagnostics.nodes_expanded,
        on.diagnostics.grid_cols,
        on.diagnostics.grid_rows,
        on.waypoints.len()
    );
    eprintln!(
        "nodes_expanded ratio (on/off): {:.2}x, wall-clock ratio (on/off): {:.2}x",
        on.diagnostics.nodes_expanded as f64 / off.diagnostics.nodes_expanded.max(1) as f64,
        elapsed_on.as_secs_f64() / elapsed_off.as_secs_f64().max(1e-9)
    );

    assert!(
        elapsed_on.as_secs_f64() < 5.0,
        "turn-cost-weighted search on a real-passage-scale dense field must still stay well \
         under 5s — took {elapsed_on:?} ({} nodes expanded, vs {} with turn-cost off)",
        on.diagnostics.nodes_expanded,
        off.diagnostics.nodes_expanded
    );
}

/// A wall segment centred on `(lat, lon)` — same shape as [`square`], just
/// independently sized on each axis so a real serpentine channel (below)
/// can build long, thin walls rather than small square islands.
fn wall_segment(
    lat: f64,
    lon: f64,
    half_lat_m: f64,
    half_lon_m: f64,
) -> Vec<chartcore::coords::WorldXy> {
    let dlat = half_lat_m / 111_320.0;
    let dlon = half_lon_m / (111_320.0 * lat.to_radians().cos());
    vec![
        lat_lon_to_world(lat - dlat, lon - dlon),
        lat_lon_to_world(lat - dlat, lon + dlon),
        lat_lon_to_world(lat + dlat, lon + dlon),
        lat_lon_to_world(lat + dlat, lon - dlon),
    ]
}

/// The turn-cost feature's own deliberately ADVERSARIAL scenario — not the
/// dense-island field above (measured near-zero overhead there: a fairly
/// direct route with little zigzag potential to explore in the first
/// place) but a real, forced-many-turns shape: a ~7nm serpentine channel,
/// walled from alternating north/south banks with a narrow gap that
/// switches side every ~0.9nm, so the ONLY route through genuinely bends
/// hard, many times — the shape most likely to make the turn-cost search's
/// extra `(cell, incoming_direction)` state space actually bite, since
/// every one of those forced bends is exactly where the state-expanded
/// search has real, non-trivial direction bookkeeping to do that the plain
/// search never had to.
fn serpentine_channel() -> Vec<Vec<chartcore::coords::WorldXy>> {
    let n = 8;
    let step_m = 1_600.0; // ~0.86nm between successive walls
    let mut rings = Vec::with_capacity(n);
    for i in 0..n {
        let north_m = i as f64 * step_m;
        let dlat = north_m / 111_320.0;
        // Alternating bank: even i walls from the north bank leaving a
        // south gap, odd i from the south bank leaving a north gap — long
        // enough (half_lon 900m) to force the route hard against the
        // opposite bank each time, short enough (channel ~1.2km wide) that
        // a real, narrow gap remains.
        let (wall_lat_offset, half_lat_m) = if i % 2 == 0 {
            (600.0 / 111_320.0, 600.0) // wall hangs down from the north bank
        } else {
            (-600.0 / 111_320.0, 600.0) // wall rises up from the south bank
        };
        rings.push(wall_segment(
            LAT + dlat + wall_lat_offset,
            LON,
            half_lat_m,
            900.0,
        ));
    }
    rings
}

/// The real worst-case measurement the task asked for, not just the
/// dense-field's own near-zero-overhead case: `nodes_expanded`/wall-clock,
/// off vs on, through the deliberately adversarial [`serpentine_channel`].
/// See this test's own `eprintln!` (`cargo test turn_cost_state_expansion_worst_case
/// -- --nocapture`) and `ROUTING_TODO.md`'s turn-cost entry for the actual
/// numbers this was measured at.
#[test]
fn turn_cost_state_expansion_worst_case_on_a_serpentine_channel() {
    let rings = serpentine_channel();
    let a = lat_lon_to_world(LAT - 0.01, LON);
    let b = lat_lon_to_world(LAT + 0.01 + (8.0 * 1_600.0) / 111_320.0, LON);

    let start_off = Instant::now();
    let off = shortest_path_weighted(
        a,
        b,
        &rings,
        0.0,
        0.0,
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        0.0,
        false,
    )
    .expect("a way through the serpentine channel exists");
    let elapsed_off = start_off.elapsed();

    let turn_cost_weight = 0.5;
    let start_on = Instant::now();
    let on = shortest_path_weighted(
        a,
        b,
        &rings,
        0.0,
        0.0,
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        turn_cost_weight,
        false,
    )
    .expect("turn-cost weighting must not itself break the route");
    let elapsed_on = start_on.elapsed();

    eprintln!(
        "serpentine channel, turn-cost OFF: {:?}, nodes_expanded={}, grid={}x{}, waypoints={}",
        elapsed_off,
        off.diagnostics.nodes_expanded,
        off.diagnostics.grid_cols,
        off.diagnostics.grid_rows,
        off.waypoints.len()
    );
    eprintln!(
        "serpentine channel, turn-cost ON (weight={turn_cost_weight}): {:?}, nodes_expanded={}, grid={}x{}, waypoints={}",
        elapsed_on,
        on.diagnostics.nodes_expanded,
        on.diagnostics.grid_cols,
        on.diagnostics.grid_rows,
        on.waypoints.len()
    );
    eprintln!(
        "nodes_expanded ratio (on/off): {:.2}x, wall-clock ratio (on/off): {:.2}x",
        on.diagnostics.nodes_expanded as f64 / off.diagnostics.nodes_expanded.max(1) as f64,
        elapsed_on.as_secs_f64() / elapsed_off.as_secs_f64().max(1e-9)
    );

    assert!(
        on.waypoints.len() > 2,
        "must genuinely bend through the serpentine channel: {on:?}"
    );
    assert!(
        elapsed_on.as_secs_f64() < 5.0,
        "even the adversarial serpentine case must stay well under 5s on a single request — \
         took {elapsed_on:?} ({} nodes expanded, vs {} off)",
        on.diagnostics.nodes_expanded,
        off.diagnostics.nodes_expanded
    );
}

/// Lazy Theta*'s own real, measured performance cost and payoff — asked
/// for directly, not estimated: `routing::raster::search_grid_theta_star`
/// vs. plain `search_grid`, on the SAME dense-hazard-field corpus
/// [`turn_cost_state_expansion_measured_cost_on_the_dense_field`] above
/// already uses, so the "off" and "on" numbers are directly comparable at
/// the exact same grid/corridor/hazard density, not two different
/// scenarios. `search_grid_theta_star`'s own internal `visibility_checks`
/// count isn't part of the public API (`RouteDiagnostics` doesn't carry
/// it) — that specific count is pinned separately, at the unit level, by
/// `routing::raster::tests::lazy_visibility_checks_are_bounded_by_nodes_
/// expanded_not_relaxation_attempts`; this test measures what IS public:
/// wall-clock and `nodes_expanded`, plus the route's own `distance_m`/
/// `waypoints.len()` as a proxy for the any-angle straightening effect.
///
/// Not a strict pass/fail gate on the exact ratio, same discipline the
/// turn-cost measurement above already follows — a directed search's own
/// expansion count is corpus-shape-dependent. Still asserts a real ceiling
/// (`< 5.0s`) so a genuine future regression fails loud, and asserts
/// Theta* does not produce a LONGER route than the plain search on the
/// same field (it should never need to — see `search_grid_theta_star`'s
/// own admissibility docs).
#[test]
fn theta_star_measured_cost_and_payoff_on_the_dense_field() {
    let rings = dense_island_field();
    let grid_n = 35.0;
    let spacing_m = 2_500.0;
    let span_m = grid_n * spacing_m;
    let dlat = span_m / 111_320.0;
    let dlon = span_m / (111_320.0 * LAT.to_radians().cos());

    let a = lat_lon_to_world(LAT - 0.02, LON - 0.02);
    let b = lat_lon_to_world(LAT + dlat + 0.02, LON + dlon + 0.02);

    let start_off = Instant::now();
    let off = shortest_path_weighted(
        a,
        b,
        &rings,
        0.0,
        0.0,
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        0.0,
        false, // theta_star off — plain search_grid
    )
    .expect("a way through the dense field exists");
    let elapsed_off = start_off.elapsed();

    let start_on = Instant::now();
    let on = shortest_path_weighted(
        a,
        b,
        &rings,
        0.0,
        0.0,
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        &[],
        0.0,
        0.0,
        true, // theta_star on
    )
    .expect("enabling theta_star must not itself break an existing route");
    let elapsed_on = start_on.elapsed();

    eprintln!(
        "theta_star OFF: {:?}, nodes_expanded={}, grid={}x{}, waypoints={}, distance_m={:.1}",
        elapsed_off,
        off.diagnostics.nodes_expanded,
        off.diagnostics.grid_cols,
        off.diagnostics.grid_rows,
        off.waypoints.len(),
        off.distance_m
    );
    eprintln!(
        "theta_star ON:  {:?}, nodes_expanded={}, grid={}x{}, waypoints={}, distance_m={:.1}",
        elapsed_on,
        on.diagnostics.nodes_expanded,
        on.diagnostics.grid_cols,
        on.diagnostics.grid_rows,
        on.waypoints.len(),
        on.distance_m
    );
    eprintln!(
        "nodes_expanded ratio (on/off): {:.2}x, wall-clock ratio (on/off): {:.2}x, \
         distance_m ratio (on/off): {:.4}x",
        on.diagnostics.nodes_expanded as f64 / off.diagnostics.nodes_expanded.max(1) as f64,
        elapsed_on.as_secs_f64() / elapsed_off.as_secs_f64().max(1e-9),
        on.distance_m / off.distance_m.max(1e-9)
    );

    assert!(
        on.distance_m <= off.distance_m + 1.0, // +1.0m float-noise slack
        "Theta* must never find a LONGER route than the plain grid search on the same field — \
         theta_star distance_m={} vs plain search_grid distance_m={}",
        on.distance_m,
        off.distance_m
    );
    assert!(
        elapsed_on.as_secs_f64() < 5.0,
        "theta_star on a real-passage-scale dense field must still stay well under 5s — took \
         {elapsed_on:?} ({} nodes expanded, vs {} with theta_star off)",
        on.diagnostics.nodes_expanded,
        off.diagnostics.nodes_expanded
    );
}
