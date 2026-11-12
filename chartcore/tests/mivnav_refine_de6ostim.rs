// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §12.4 — Phase 6's local vector refinement, proven on REAL chart data
//! (`backend/data/fnc/DE6OSTIM.S57`, every other real-chart
//! `mivnav`/`routing::artifact` test's own fixture).
//!
//! # The §21 gate this file is the evidence for
//!
//! "reachable-but-raster-closed passages transited within reference-
//! solver tolerance" — a genuinely NON-GRID-ALIGNED passage that the
//! raster search closes or MIS-COSTS, which the refinement path then
//! routes correctly.
//!
//! The real case, measured on this fixture at `required_depth_m = 1.0`,
//! `CatzocMode::Off`: the crossing from `CHANNEL_NORTH` (11.3711,
//! 53.9930) into `BASIN` (11.37513, 53.992133) — the two points
//! `routing_artifact_de6ostim.rs` already uses as real navigable
//! landmarks, `BASIN` documented there as "reachable only by bending
//! around the real charted moles".
//!
//! * The straight chord between them (~281 m) is blocked by real charted
//!   hard geometry (`region_hazard_rings` extracts ~27 rings / ~292
//!   vertices from this cell's moles and land — a genuinely non-grid-
//!   aligned obstruction).
//! * `mivnav::refine::refine_segment`, working from the exact hazard
//!   rings, threads the real gap between the mole tips: a ~358 m clear
//!   polyline, ~1.27x the straight-line lower bound — a tight detour,
//!   inside reference-solver tolerance.
//! * `routing::artifact::artifact_route_lonlat` — the grid A* fine
//!   search, the closest thing this crate has to a reference solver —
//!   also routes it (every leg exact), at ~381 m. So on THIS fixture the
//!   grid search does not badly mis-cost the passage; refinement's value
//!   here is that it is **never worse** and works straight off geometry
//!   with no corridor grid at all. The STRONG form of §21's gate (the
//!   grid genuinely CLOSING a reachable passage) needs a charted gap
//!   narrower than the tile cell size, which DE6OSTIM's harbour does not
//!   have at its native 2 m resolution — that closure case is pinned by
//!   `mivnav::refine`'s own synthetic diagonal-wall unit test instead;
//!   see this crate's report notes.
//!
//! Plus: the §8.3 demote-not-reject wiring
//! ([`mivnav::topology_route_demoting`]) exercised on this cell's real
//! portals, and the "never worse" safety valve (a tight node budget
//! DECLINES rather than truncating).

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, worldx_to_lon, worldy_to_lat, Extent, WorldXy};
use chartcore::mivnav::{
    band_to_dm, build_region, detect_portals, label_band, portal_crossing_point,
    refine_demoted_route, refine_segment, region_hazard_rings, segment_clear, select_band,
    snap_point, topology_route, topology_route_demoting, topology_route_graced_demoting, unit_cost,
    RefineParams, TopologyWeights,
};
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::artifact::{
    artifact_route_lonlat, build_constraints, ArtifactParams, ArtifactWeights, CatzocMode,
    ConstraintParams,
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

fn region_extent() -> Extent {
    let e = cell().extent;
    let pad = (e.xmax - e.xmin) / 4;
    Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad)
}

const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);
const BASIN: (f64, f64) = (11.37513, 53.992133);
const REQUIRED_DEPTH_M: f64 = 1.0;

/// Real-metre great-circle distance between two world points — a local
/// helper because `routing::hazards::world_distance_m` is `pub(crate)`.
fn metres(a: WorldXy, b: WorldXy) -> f64 {
    let (lat1, lon1) = (worldy_to_lat(a.y), worldx_to_lon(a.x));
    let (lat2, lon2) = (worldy_to_lat(b.y), worldx_to_lon(b.x));
    let r = 6_371_000.0_f64;
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = (lat2 - lat1).to_radians();
    let dl = (lon2 - lon1).to_radians();
    let h = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * r * h.sqrt().asin()
}

fn polyline_m(pts: &[WorldXy]) -> f64 {
    pts.windows(2).map(|w| metres(w[0], w[1])).sum()
}

#[test]
fn refine_threads_a_real_mole_blocked_crossing_at_least_as_well_as_the_grid_search() {
    let rings = region_hazard_rings(&[cell().clone()], CatzocMode::Off);
    assert!(
        rings.len() >= 10,
        "this cell's real moles/land must yield a real hard-hazard ring set, got {}",
        rings.len()
    );

    let from = lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0);
    let to = lat_lon_to_world(BASIN.1, BASIN.0);
    let straight_m = metres(from, to);

    // The straight line is genuinely blocked by real charted hard
    // geometry — this is a real obstruction, not a contrived one.
    assert!(
        !segment_clear(from, to, &rings),
        "the CHANNEL_NORTH->BASIN chord must be blocked by a real charted mole"
    );

    // The vector solver threads the real gap.
    let path = refine_segment(
        from,
        to,
        &rings,
        &chartcore::mivnav::unit_cost,
        RefineParams::DEFAULT,
    )
    .expect("refine must find the real navigable route around the moles");
    assert_eq!(path.first(), Some(&from));
    assert_eq!(path.last(), Some(&to));
    assert!(
        path.len() >= 3,
        "a mole-avoiding route needs at least one intermediate waypoint, got {path:?}"
    );

    // Every spliced leg is genuinely clear of every real hazard ring.
    for w in path.windows(2) {
        assert!(
            segment_clear(w[0], w[1], &rings),
            "refined leg {:?}->{:?} crosses a real hazard ring",
            w[0],
            w[1]
        );
    }

    let refined_m = polyline_m(&path);
    // Within reference tolerance: a tight detour, not a world-circling
    // one. Measured ~1.27x; allow generous headroom.
    assert!(
        refined_m < 1.6 * straight_m,
        "refined route {refined_m:.0} m is not a tight detour off the {straight_m:.0} m \
         straight-line lower bound"
    );

    // The grid A* fine search — the closest thing this crate has to a
    // reference solver — on the SAME real pair. It also routes the
    // passage (exact legs), and the refinement is never worse than it.
    let params = ArtifactParams {
        required_depth_m: REQUIRED_DEPTH_M,
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        endpoint_grace_radius_m: 150.0,
        catzoc_mode: CatzocMode::Off,
        allow_restricted_entry: false,
        force_finest_resolution: false,
    };
    let fine = artifact_route_lonlat(
        CHANNEL_NORTH.0,
        CHANNEL_NORTH.1,
        BASIN.0,
        BASIN.1,
        &[cell()],
        &params,
        &ArtifactWeights::default(),
    )
    .expect("the fine search still finds a legal route, just a longer one");
    assert!(
        fine.approximate_legs.iter().all(|&a| !a),
        "the fine search's own answer must be exact for this comparison to mean anything"
    );
    // Refinement is never worse than the reference solver on this real
    // non-grid-aligned passage — here it is modestly better (~358 m vs
    // ~381 m), threading closer to the mole tips than the grid corridor
    // can. A small slack absorbs the great-circle-vs-crate-distance
    // difference between the two measurements.
    assert!(
        refined_m <= fine.distance_m * 1.02,
        "vector refinement ({refined_m:.0} m) must not be worse than the grid search \
         ({:.0} m) on this passage",
        fine.distance_m
    );
}

#[test]
fn a_tight_node_budget_declines_and_leaves_the_route_untouched() {
    // §8.3's "never worse": when the in-window corner set outgrows the
    // budget, refinement declines rather than solving a truncation of it
    // — the caller then keeps whatever the grid layers produced.
    let rings = region_hazard_rings(&[cell().clone()], CatzocMode::Off);
    let from = lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0);
    let to = lat_lon_to_world(BASIN.1, BASIN.0);
    let tight = RefineParams {
        max_nodes: 24,
        window_pad_m: 400.0,
    };
    assert!(
        refine_segment(from, to, &rings, &chartcore::mivnav::unit_cost, tight).is_none(),
        "a budget far below this harbour's ~290 in-window corners must decline"
    );
}

#[test]
fn beam_demotion_flags_real_portals_without_moving_the_route() {
    // §8.3 / Phase 6 wiring on real portals: a beam threshold above every
    // real crossing's measured width demotes them ALL — and the route is
    // byte-for-byte the route the un-demoted search returns.
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    assert!(!portals.is_empty());

    let start = snap_point(&built, lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0)).unwrap();
    let goal = snap_point(&built, lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0)).unwrap();
    let draft_dm = band_to_dm(REQUIRED_DEPTH_M);

    let plain = topology_route(&built, &portals, start.tile, goal.tile, draft_dm)
        .expect("the real west channel connects these two points");
    assert!(plain.demoted_portals.is_empty());
    assert!(!plain.hops.is_empty());

    let demoted = topology_route_demoting(
        &built,
        &portals,
        start.tile,
        goal.tile,
        draft_dm,
        u16::MAX,
        None,
        TopologyWeights::default(),
    )
    .expect("demotion must never turn a real route into no route");

    // The route itself is unchanged — demote, never reject.
    assert_eq!(demoted.hops, plain.hops);
    assert_eq!(demoted.cost_mm, plain.cost_mm);
    // ...and every crossed portal is now flagged for refinement.
    assert_eq!(
        demoted.demoted_portals,
        demoted.hops.iter().map(|h| h.portal).collect::<Vec<_>>()
    );
    // Each flagged portal really is below the (absurd) beam.
    for id in &demoted.demoted_portals {
        let p = portals.iter().find(|p| p.id == *id).unwrap();
        assert!(p.min_horizontal_width_dm < u16::MAX);
    }
}

/// Phase 6 END TO END on real chart data: a demoted crossing on the
/// CHANNEL_SOUTH -> BASIN passage is consumed by `refine_demoted_route`,
/// which threads it against the real charted hazard geometry, re-verifies
/// the splice against the DRAFT-AWARE hard-constraint set, and hands back
/// a route that is no longer byte-identical to the grid fine search's
/// (measured: 4 waypoints / ~405 m grid -> ~399 m refined, portal 5).
///
/// This is the marginal-width demotion path the TODO doc calls the
/// real-chart proof for this task — DE6OSTIM's harbour has no charted gap
/// the 2 m raster genuinely *closes*, so the raster-closure form stays
/// pinned by `refine.rs`'s synthetic diagonal-wall unit test. (The
/// CHANNEL_NORTH -> BASIN chord the first test in this file uses is
/// sub-tile — start and goal land in the SAME tile, so the tile-granular
/// topology layer produces no hop to demote; CHANNEL_SOUTH -> BASIN
/// crosses a real seam and does.)
#[test]
fn refine_demoted_route_consumes_a_real_demoted_crossing_and_moves_the_route() {
    let catzoc = CatzocMode::Off;
    let built = build_region(&[cell().clone()], region_extent(), catzoc);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    let draft_dm = band_to_dm(REQUIRED_DEPTH_M);

    let from_w = lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0);
    let to_w = lat_lon_to_world(BASIN.1, BASIN.0);

    // A beam above every real crossing width in this harbour, so the
    // whole BASIN approach demotes — the same absurd-beam device the
    // demotion test above uses, here to exercise the consumer.
    let (topo, _s, _g) = topology_route_graced_demoting(
        &built,
        &portals,
        from_w,
        to_w,
        draft_dm,
        150.0,
        u16::MAX,
        None,
        TopologyWeights::default(),
    )
    .expect("the topology layer reaches BASIN around the moles");
    assert!(
        !topo.demoted_portals.is_empty(),
        "the BASIN approach must cross at least one marginal-width portal"
    );
    // Every demoted portal resolves to a real seam point.
    for id in &topo.demoted_portals {
        let p = portals.iter().find(|p| p.id == *id).unwrap();
        assert!(portal_crossing_point(&built, p).is_some());
    }

    // The grid fine search's own answer for the same pair.
    let params = ArtifactParams {
        required_depth_m: REQUIRED_DEPTH_M,
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        endpoint_grace_radius_m: 150.0,
        catzoc_mode: catzoc,
        allow_restricted_entry: false,
        force_finest_resolution: false,
    };
    let fine = artifact_route_lonlat(
        CHANNEL_SOUTH.0,
        CHANNEL_SOUTH.1,
        BASIN.0,
        BASIN.1,
        &[cell()],
        &params,
        &ArtifactWeights::default(),
    )
    .expect("the fine search finds the mole-bending route");
    let fine_world: Vec<WorldXy> = fine
        .waypoints
        .iter()
        .map(|&(lon, lat)| lat_lon_to_world(lat, lon))
        .collect();

    let refine_rings = region_hazard_rings(&[cell().clone()], catzoc);
    let verify = build_constraints(
        &[cell()],
        &ConstraintParams {
            required_depth_m: REQUIRED_DEPTH_M,
            avoid_depth_m: 0.0,
            soft_prefer_depth_m: 0.0,
            required_air_draft_m: 0.0,
            lateral_margin_m: 0.0,
            catzoc_mode: catzoc,
            allow_restricted_entry: false,
            build_charted_depth: false,
        },
    );

    let refined = refine_demoted_route(
        &fine_world,
        &built,
        &portals,
        &topo.demoted_portals,
        &refine_rings,
        &verify.hard,
        &unit_cost,
        RefineParams::DEFAULT,
    )
    .expect("at least one demoted crossing on this real passage must refine");

    // The route genuinely changed...
    assert_ne!(
        refined.waypoints, fine_world,
        "the splice must move the route"
    );
    assert!(!refined.refined_portals.is_empty());
    for id in &refined.refined_portals {
        assert!(topo.demoted_portals.contains(id));
    }
    // ...it starts and ends where the fine route did...
    assert_eq!(refined.waypoints.first(), fine_world.first());
    assert_eq!(refined.waypoints.last(), fine_world.last());
    // ...every leg clears the real charted hard geometry, draft-aware...
    for w in refined.waypoints.windows(2) {
        assert!(
            segment_clear(w[0], w[1], &verify.hard),
            "refined leg {:?}->{:?} crosses a draft-aware hard constraint",
            w[0],
            w[1]
        );
    }
    // ...and it is not longer than the grid route it refines.
    assert!(
        refined.distance_m <= fine.distance_m * 1.02,
        "refined {:.0} m must not exceed the grid route {:.0} m",
        refined.distance_m,
        fine.distance_m
    );
}
