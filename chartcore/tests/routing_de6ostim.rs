// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! End-to-end routing check on a real chart cell: decode → derive →
//! `build_hazard_index` → `shortest_path`, against `backend/data/fnc/
//! DE6OSTIM.S57` (a real, small, CC0 freenauticalchart.net cell — see that
//! directory's `SOURCE.txt`). Despite the `.S57` extension it is plain
//! OSENC (`mivnav.features.ocharts.fnc`'s module docstring explains why),
//! which `osenc::read_cell` reads directly with no GDAL and no renaming —
//! unlike `derive_phase5.rs`'s NOAA fixture, this file needs no
//! `s57-ingest` feature gate and runs in the default (Pi-matching) build.
//!
//! `margin_m = 30.0` here — a real clearance, not a placeholder. Earlier
//! versions of this test pinned `margin_m` to 0.0 to sidestep a
//! margin-buffering bug (non-monotonic graph connectivity as margin grew,
//! `ROUTING_TODO.md`'s now-closed "margin buffering is not yet
//! trustworthy" entry); that bug is fixed
//! (`routing::raster::tests::margin_buffering_is_monotonic_on_a_real_
//! coastline`, no longer ignored), so this test now exercises the same
//! real clearance `mivnav/features/routing/routes.py` defaults to.
//!
//! No TSS-avoidance/fairway-preference test lives here: checked directly
//! (`cell.features_of("TSSLPT"/"TSSRON"/"TSSCRS"/"PRCARE"/"FAIRWY").count()`
//! after decode, since a raw-byte string search on the file is
//! inconclusive — OSENC encodes classes numerically, not as ASCII
//! acronyms) — this small coastal cell charts none of them, only
//! `LNDARE`. `routing::raster::tests`' synthetic tests
//! (`tss_avoidance_*`/`fairway_preference_*`) are the only coverage for
//! those two preferences, same reasoning `routing_raster_perf.rs`'s own
//! module docs already give for why ITS coverage is synthetic too.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::lat_lon_to_world;
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::{
    build_hazard_index, hazard_contains, hazard_contains_scaled, shortest_path,
    shortest_path_weighted,
};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../backend/data/fnc/DE6OSTIM.S57")
}

fn cell() -> &'static Cell {
    static CELL: OnceLock<Cell> = OnceLock::new();
    CELL.get_or_init(|| {
        let file = std::fs::File::open(fixture_path()).expect("DE6OSTIM fixture reads");
        let mut cell = osenc::read_cell(file).expect("DE6OSTIM fixture decodes");
        chartcore::derive::apply(&mut cell);
        cell
    })
}

#[test]
fn land_is_a_real_hazard_on_the_real_cell() {
    let idx = build_hazard_index(cell(), 0.0, 30.0, 0.0).expect("the cell charts real land");
    assert!(idx.extent.valid);
}

/// The real bug `STRUCTURAL_HAZARD_CLASSES` (`routing::hazards`) closes:
/// found live at a real Danish harbour (Strandby) — a route was drawn
/// straight through a charted breakwater, because `build_hazard_index`
/// never looked at `SLCONS` at all, on any chart. This fixture charts 9
/// real `SLCONS` features (checked directly against the decoded cell, not
/// assumed) — pick the first one's own extent centre and confirm it is
/// now inside the union, at a permissive safety depth (`SLCONS` is
/// unconditional, unlike the depth-gated classes — see that constant's
/// own docs).
#[test]
fn a_real_charted_breakwater_is_a_hazard_on_the_real_cell() {
    let slcons = cell()
        .features_of("SLCONS")
        .next()
        .expect("DE6OSTIM charts real SLCONS features");
    let centre = chartcore::coords::WorldXy::new(
        (slcons.extent.xmin + slcons.extent.xmax) / 2,
        (slcons.extent.ymin + slcons.extent.ymax) / 2,
    );
    let idx = build_hazard_index(cell(), -100.0, 30.0, 0.0).expect("real hazards on this cell");
    assert!(hazard_contains(&idx, centre));
}

/// A straight line across the fixture's real land must be rerouted, not
/// silently accepted, and the found path must actually clear the real
/// hazard polygon end to end — not just "some path", but one whose every
/// leg is genuinely visible.
#[test]
fn a_line_across_real_land_is_routed_around_it() {
    let idx = build_hazard_index(cell(), 0.0, 30.0, 0.0).expect("the cell charts real land");

    use chartcore::coords::{worldx_to_lon, worldy_to_lat};
    let pad = 0.01; // degrees, ~1.1 km at this latitude — comfortably outside the island
    let mid_lat = (worldy_to_lat(idx.extent.ymin) + worldy_to_lat(idx.extent.ymax)) / 2.0;
    let west = worldx_to_lon(idx.extent.xmin) - pad;
    let east = worldx_to_lon(idx.extent.xmax) + pad;
    let a = lat_lon_to_world(mid_lat, west);
    let b = lat_lon_to_world(mid_lat, east);
    assert!(!hazard_contains(&idx, a), "the start point must be clear");
    assert!(!hazard_contains(&idx, b), "the end point must be clear");

    let path = shortest_path(a, b, &idx.rings).expect("a way around the land exists");
    assert!(
        path.waypoints.len() > 2,
        "a direct line crosses land; the path must bend: {path:?}"
    );

    // Every leg of the found path must itself be hazard-free — sample each
    // one and check against the SAME hazard index the search used: proof
    // the search's output is actually usable, not just that it returned
    // something. Interpolate in WORLD coordinates, not lon/lat: `visible`
    // (and hence the search) reasons about a straight line in world
    // (WebMercator-pixel) space, which is a genuinely different curve from
    // a straight line in lon/lat space (Mercator's y is nonlinear in
    // latitude). And sample via `hazard_contains_scaled` at an EXACT
    // fraction rather than rounding each step to the nearest `WorldXy`
    // first: a shortest-path search hugs a hazard's boundary as tightly
    // as the margin allows on purpose (found and fixed as a real
    // load-bearing bug, not a hypothetical — see `hazard_contains_scaled`'s
    // docs), and for a leg that runs along a nearly-flat stretch of that
    // boundary, rounding a sample point to the nearest whole world unit
    // is enough error to toss it across the line.
    //
    // One more precision layer sits on top of that, unavoidably: the leg
    // ENDPOINTS themselves come from `path.waypoints`, which is `(lon,
    // lat)` — `RoutePath`'s own public, lossy representation of an
    // internal `WorldXy` node (`worldx_to_lon`/`worldy_to_lat`, floating
    // point). Converting back via `lat_lon_to_world` does not perfectly
    // invert that: measured up to 1 world unit (~7cm at this latitude) of
    // drift for a node that was an exact hazard-ring vertex internally.
    // For a leg that runs along the boundary (the case this whole
    // exercise is about), 7cm of drift is exactly the kind of noise that
    // can toss an endpoint from "exactly on the line" to "one unit
    // inside" — immaterial for real navigation, but enough to fail a
    // strict exact-boundary check. `effectively_clear` tolerates that one
    // specific, bounded, already-understood source of slop without
    // weakening the check for anything else: a leg that's genuinely INSIDE
    // the hazard by more than a world unit still fails.
    for leg in path.waypoints.windows(2) {
        let (lon0, lat0) = leg[0];
        let (lon1, lat1) = leg[1];
        let w0 = lat_lon_to_world(lat0, lon0);
        let w1 = lat_lon_to_world(lat1, lon1);
        const STEPS: i64 = 20;
        for i in 0..=STEPS {
            // Exact point at i/STEPS along w0->w1, expressed as (x, y) =
            // STEPS * the true fractional point — no rounding.
            let x = w0.x as i64 * (STEPS - i) + w1.x as i64 * i;
            let y = w0.y as i64 * (STEPS - i) + w1.y as i64 * i;
            assert!(
                effectively_clear(&idx, x, y, STEPS),
                "leg {leg:?} at t={} lands inside the hazard it was supposed to avoid, \
                 by more than the lon/lat round-trip's own precision floor",
                i as f64 / STEPS as f64
            );
        }
    }
}

/// [`hazard_contains_scaled`] at `(x, y)`/`scale`, tolerant of up to 1
/// whole world unit (~7cm) of positional slop — see the doc comment at
/// this function's one call site for exactly what that's compensating for
/// and why it's bounded and specific, not a general fudge factor.
fn effectively_clear(idx: &chartcore::routing::HazardIndex, x: i64, y: i64, scale: i64) -> bool {
    [(0, 0), (scale, 0), (-scale, 0), (0, scale), (0, -scale)]
        .into_iter()
        .any(|(dx, dy)| !hazard_contains_scaled(idx, x + dx, y + dy, scale))
}

/// The turn-cost feature's real, measured cost/behaviour on an actual
/// decoded chart cell, not just the synthetic corpus
/// `routing_raster_perf.rs`'s own turn-cost measurement uses — the same
/// real-around-real-land detour `a_line_across_real_land_is_routed_around_
/// it` above already exercises, run twice (`turn_cost_weight` off, then a
/// real nonzero value) so the `nodes_expanded`/wall-clock/waypoint-count
/// numbers are directly comparable on genuine chart geometry, not just a
/// hand-built grid. `cargo test turn_cost -- --nocapture` to see the
/// numbers; `ROUTING_TODO.md`'s turn-cost entry records what these were
/// measured at before shipping.
#[test]
fn turn_cost_on_a_real_land_detour_measured() {
    let idx = build_hazard_index(cell(), 0.0, 30.0, 0.0).expect("the cell charts real land");

    use chartcore::coords::{worldx_to_lon, worldy_to_lat};
    let pad = 0.01;
    let mid_lat = (worldy_to_lat(idx.extent.ymin) + worldy_to_lat(idx.extent.ymax)) / 2.0;
    let west = worldx_to_lon(idx.extent.xmin) - pad;
    let east = worldx_to_lon(idx.extent.xmax) + pad;
    let a = lat_lon_to_world(mid_lat, west);
    let b = lat_lon_to_world(mid_lat, east);

    let start_off = std::time::Instant::now();
    let off = shortest_path_weighted(
        a,
        b,
        &idx.rings,
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
    .expect("a way around the real land exists");
    let elapsed_off = start_off.elapsed();

    let turn_cost_weight = 0.5;
    let start_on = std::time::Instant::now();
    let on = shortest_path_weighted(
        a,
        b,
        &idx.rings,
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
    .expect("turn-cost weighting must not itself break a route that exists without it");
    let elapsed_on = start_on.elapsed();

    eprintln!(
        "DE6OSTIM real-land detour, turn-cost OFF: {:?}, nodes_expanded={}, waypoints={}",
        elapsed_off,
        off.diagnostics.nodes_expanded,
        off.waypoints.len()
    );
    eprintln!(
        "DE6OSTIM real-land detour, turn-cost ON (weight={turn_cost_weight}): {:?}, nodes_expanded={}, waypoints={}",
        elapsed_on,
        on.diagnostics.nodes_expanded,
        on.waypoints.len()
    );

    // Still a real, verified route around the real hazard — turning turn
    // cost on must never trade away actual safety for a straighter shape.
    assert!(
        on.waypoints.len() > 2,
        "must still bend around real land: {on:?}"
    );
    assert!(
        elapsed_on.as_secs_f64() < 5.0,
        "turn-cost-weighted search on a real chart cell must stay well under 5s — took {elapsed_on:?}"
    );
}
