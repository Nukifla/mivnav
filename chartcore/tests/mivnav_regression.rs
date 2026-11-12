// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §23's regression suite: the `mivnav` pipeline versus the §14
//! finest-everywhere reference solver, on real chart data, per case-shape
//! from the architecture doc's own list.
//!
//! # What each case checks
//!
//! For a `(fixture, from, to, params, weights)` case:
//!
//!  * **legality** — neither the pipeline route nor the reference route
//!    crosses the hard-constraint union (§16's exact verifier reports no
//!    `approximate_legs`). That union is already `lateral_margin_m`- and
//!    CATZOC-buffered and the grid is gated at `required_depth_m`, so a
//!    clean result subsumes "minimum clearance ≥ margin" and "minimum
//!    depth ≥ required" for a route the search produced.
//!  * **cost parity** — the pipeline's integrated cost is within
//!    `COST_TOL` of the reference's, both ways. The pipeline runs the
//!    production (corridor-coarsened) resolution; the reference is a
//!    genuine finest-everywhere brute force. They should agree closely;
//!    a large divergence is a regression in one of the layers `mivnav`
//!    adds on top of the shared fine search.
//!  * **optimality gap** — `RouteResult::optimality_gap` for the pipeline
//!    route is `≥ 0` and, for a passage where the straight-line bound is
//!    tight, under `GAP_CEILING`. The gap is an UPPER bound on the true
//!    gap (the denominator is itself only a lower bound), so a small
//!    value is a real "provably near-optimal" statement.
//!  * **topology bound** — where the topology layer finds a route, its
//!    ALT landmark lower bound does not exceed the topology cost it
//!    bounds (a second, independent check on `mivnav::landmarks`).
//!
//! # The fixture ceiling
//!
//! The repo has two OSENC cells with the geometry this suite needs
//! (`DE6OSTIM.S57` — a real harbour with moles and a narrow channel;
//! `DE6OSBRH.S57` — a real charted fairway). Neither charts a passage the
//! raster genuinely *closes*, an `UNSARE`, or a `RESARE` restricted area,
//! and the one compact real TSS cell (`US5OAKEE.000`) is GDAL-only. Those
//! §23 shapes are `#[ignore]`d stubs here with a one-line reason each;
//! the TSS case runs in `mivnav_regression_us5oakee.rs` under the
//! `s57-ingest` feature.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, Extent};
use chartcore::mivnav::{
    band_to_dm, build_band_landmarks, build_region, detect_portals, effective_min_multiplier,
    label_band, reference_route, select_band, snap_point, straight_line_lower_bound_mm,
    topology_route, BandLandmarks, RouteResult,
};
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::artifact::{
    artifact_route_lonlat, ArtifactParams, ArtifactRoute, ArtifactWeights, CatzocMode,
};

/// The pipeline cost may differ from the finest-everywhere reference by
/// this fraction either way — corridor coarsening vs a finest brute
/// force on the same real cells. Generous: the point is to catch a layer
/// that blew the route out, not to freeze an exact number.
const COST_TOL: f64 = 0.30;

/// `optimality_gap` ceiling. The bound is the straight-line great-circle
/// distance, so a route forced to detour (around a breakwater, into a
/// basin) legitimately shows a gap in the 0.1–0.5 range — that is "we
/// cannot cheaply prove the detour is unnecessary", not suboptimality.
/// This ceiling is set to catch a real BLOWOUT (a layer bug tripling the
/// route), not to assert every route is near-straight. Cases that set
/// `fairway_preference_weight > 0` opt out entirely — see
/// `Case::gap_ceiling` — because the discount deflates the bound's floor.
const GAP_CEILING: f64 = 0.6;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../backend/data/fnc")
        .join(name)
}

fn decode(name: &str) -> Cell {
    let file = std::fs::File::open(fixture(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    let mut cell = osenc::read_cell(file).unwrap_or_else(|e| panic!("{name} decodes: {e}"));
    chartcore::derive::apply(&mut cell);
    cell
}

fn de6ostim() -> &'static Cell {
    static C: OnceLock<Cell> = OnceLock::new();
    C.get_or_init(|| decode("DE6OSTIM.S57"))
}

fn de6osbrh() -> &'static Cell {
    static C: OnceLock<Cell> = OnceLock::new();
    C.get_or_init(|| decode("DE6OSBRH.S57"))
}

/// The cell's own extent plus a quarter-width margin — the same region
/// every `mivnav_*` integration test builds.
fn region_extent(cell: &Cell) -> Extent {
    let e = cell.extent;
    let pad = (e.xmax - e.xmin) / 4;
    Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad)
}

struct Case {
    name: &'static str,
    cell: &'static Cell,
    from: (f64, f64), // (lon, lat)
    to: (f64, f64),
    params: ArtifactParams,
    weights: ArtifactWeights,
}

impl Case {
    /// A case that discounts preferred water deflates the straight-line
    /// bound (its floor drops to MIN_MULTIPLIER), so the gap is
    /// legitimately looser there — only assert it is finite and
    /// non-negative.
    fn gap_ceiling(&self) -> f64 {
        if self.weights.fairway_preference_weight > 0.0 {
            f64::INFINITY
        } else {
            GAP_CEILING
        }
    }

    fn effective_floor(&self) -> f64 {
        effective_min_multiplier(self.weights.fairway_preference_weight)
    }
}

fn base_params(catzoc: CatzocMode, grace_m: f64, required_depth_m: f64) -> ArtifactParams {
    ArtifactParams {
        required_depth_m,
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        endpoint_grace_radius_m: grace_m,
        catzoc_mode: catzoc,
        allow_restricted_entry: false,
        force_finest_resolution: false,
    }
}

/// Run one case's whole check. Panics with a case-labelled message on any
/// failure.
fn run(case: &Case) {
    let cells = [case.cell];

    // --- the mivnav pipeline (beam 0, no directional rules) is exactly
    // artifact_route_lonlat over the caller's cells: the corridor is
    // diagnostics-only (deliberately unwired, see mivnav::query), and the
    // beam/refine path is off. ---
    let pipeline: ArtifactRoute = artifact_route_lonlat(
        case.from.0,
        case.from.1,
        case.to.0,
        case.to.1,
        &cells,
        &case.params,
        &case.weights,
    )
    .unwrap_or_else(|| panic!("{}: the mivnav pipeline found no route", case.name));

    assert!(
        !pipeline.approximate_legs.iter().any(|&x| x),
        "{}: the pipeline route crosses the hard-constraint union",
        case.name
    );

    // --- the finest-everywhere reference oracle ---
    let reference = reference_route(&cells, case.from, case.to, &case.params, &case.weights);
    match &reference {
        Some(r) => {
            assert!(
                r.searched_at_finest(),
                "{}: reference did not run at finest ({} vs {})",
                case.name,
                r.cell_size_m(),
                r.finest_allowed_cell_m()
            );
            assert!(r.legal(), "{}: the reference route is not legal", case.name);
            let p = pipeline.diagnostics.route_cost_mm as f64;
            let q = r.route_cost_mm() as f64;
            assert!(
                p <= q * (1.0 + COST_TOL) && q <= p * (1.0 + COST_TOL),
                "{}: pipeline cost {p} and reference cost {q} diverge past {:.0}%",
                case.name,
                COST_TOL * 100.0
            );
        }
        None => {
            // The only benign None is "corridor too large to brute force
            // at finest" — a real answer for a bigger cell, not a bug.
            // Everything in this suite is a small cell, so this should not
            // fire; if it does, the message says which case to shrink.
            eprintln!(
                "{}: reference_route returned None (region too large for a finest brute \
                 force?) — cost parity not checked",
                case.name
            );
        }
    }

    // --- the optimality statement on the pipeline route ---
    let lb = straight_line_lower_bound_mm(case.from, case.to, case.effective_floor());
    let result = RouteResult::from_fine_route(&pipeline, lb);
    eprintln!(
        "{}: cost {} mm, lb {} mm, gap {:.4}, {} waypoints",
        case.name,
        result.route_cost_mm,
        result.best_known_lower_bound_mm,
        result.optimality_gap,
        result.waypoints.len()
    );
    assert!(
        result.best_known_lower_bound_mm <= result.route_cost_mm,
        "{}: lower bound {} exceeds route cost {}",
        case.name,
        result.best_known_lower_bound_mm,
        result.route_cost_mm
    );
    assert!(result.optimality_gap >= 0.0, "{}: negative gap", case.name);
    assert!(
        result.optimality_gap < case.gap_ceiling(),
        "{}: optimality gap {:.3} exceeds the ceiling {:.3}",
        case.name,
        result.optimality_gap,
        case.gap_ceiling()
    );

    // --- the topology-layer bound, where a topology route exists ---
    let built = build_region(
        std::slice::from_ref(case.cell),
        region_extent(case.cell),
        case.params.catzoc_mode,
    );
    let band_m = select_band(case.params.required_depth_m);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    let landmarks: BandLandmarks = build_band_landmarks(&built, &portals);
    let from_w = lat_lon_to_world(case.from.1, case.from.0);
    let to_w = lat_lon_to_world(case.to.1, case.to.0);
    if let (Some(s), Some(g)) = (snap_point(&built, from_w), snap_point(&built, to_w)) {
        if let Some(topo) = topology_route(
            &built,
            &portals,
            s.tile,
            g.tile,
            band_to_dm(case.params.required_depth_m),
        ) {
            let tlb = landmarks.lower_bound_mm(s.tile, g.tile);
            assert!(
                tlb <= topo.cost_mm,
                "{}: topology lower bound {tlb} exceeds topology cost {}",
                case.name,
                topo.cost_mm
            );
        }
    }
}

// (lon, lat) — the shared real points.
const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);
const BASIN: (f64, f64) = (11.37513, 53.992133);
const FAIRWAY_NORTH: (f64, f64) = (13.03045, 54.43632);
const FAIRWAY_SOUTH: (f64, f64) = (13.03667, 54.43316);

#[test]
fn narrow_channel() {
    run(&Case {
        name: "narrow_channel (DE6OSTIM west channel)",
        cell: de6ostim(),
        from: CHANNEL_NORTH,
        to: CHANNEL_SOUTH,
        params: base_params(CatzocMode::Off, 150.0, 1.0),
        weights: ArtifactWeights::default(),
    });
}

#[test]
fn breakwater_detour() {
    run(&Case {
        name: "breakwater_detour (DE6OSTIM channel -> basin around the moles)",
        cell: de6ostim(),
        from: CHANNEL_SOUTH,
        to: BASIN,
        params: base_params(CatzocMode::Off, 150.0, 1.0),
        weights: ArtifactWeights::default(),
    });
}

#[test]
fn marina_approach_with_endpoint_grace() {
    run(&Case {
        name: "marina_approach_with_endpoint_grace (DE6OSTIM channel -> basin)",
        cell: de6ostim(),
        from: CHANNEL_NORTH,
        to: BASIN,
        params: base_params(CatzocMode::Off, 150.0, 0.5),
        weights: ArtifactWeights::default(),
    });
}

#[test]
fn fairway_preference_reaches_the_topology_cost() {
    // §23's "buoyed-channel preference" shape. The FINE route on
    // DE6OSBRH's charted fairway is a long grace-heavy detour (the NAVLNE
    // endpoints do not sit over charted deep water — see
    // test_routing_mivnav.py), which makes it a poor fine-route
    // regression case; the mechanism is already proven fine-side by
    // `mivnav_fairway_de6osbrh.rs` and over HTTP. Here we check only that
    // the preference term reaches the TOPOLOGY cost — a real charted
    // fairway's topology route must get cheaper as the weight rises,
    // never more expensive.
    let cell = de6osbrh();
    let built = build_region(
        std::slice::from_ref(cell),
        region_extent(cell),
        CatzocMode::Off,
    );
    let band_m = select_band(1.0);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    let from_w = lat_lon_to_world(FAIRWAY_NORTH.1, FAIRWAY_NORTH.0);
    let to_w = lat_lon_to_world(FAIRWAY_SOUTH.1, FAIRWAY_SOUTH.0);
    let s = snap_point(&built, from_w)
        .expect("fairway north snaps")
        .tile;
    let g = snap_point(&built, to_w).expect("fairway south snaps").tile;
    let draft = band_to_dm(1.0);

    let plain = topology_route(&built, &portals, s, g, draft)
        .expect("the fairway's own endpoints must route at the topology layer");
    let discounted = chartcore::mivnav::topology_route_with(
        &built,
        &portals,
        s,
        g,
        draft,
        chartcore::mivnav::TopologyWeights {
            fairway_preference_weight: 0.5,
            ..Default::default()
        },
    )
    .expect("...and still route with the fairway discount applied");
    assert!(
        discounted.cost_mm <= plain.cost_mm,
        "fairway_preference: discounted topology cost {} is not <= plain {}",
        discounted.cost_mm,
        plain.cost_mm
    );
}

#[test]
fn routes_are_direction_symmetric() {
    // §13.2: route(A, B) is route(B, A) reversed, cost identical. Checked
    // on the breakwater-detour case (the one with real bends, so a
    // tie-breaking asymmetry would actually show).
    let cells = [de6ostim()];
    let params = base_params(CatzocMode::Off, 150.0, 1.0);
    let w = ArtifactWeights::default();
    let ab = artifact_route_lonlat(
        CHANNEL_SOUTH.0,
        CHANNEL_SOUTH.1,
        BASIN.0,
        BASIN.1,
        &cells,
        &params,
        &w,
    )
    .expect("channel -> basin routes");
    let ba = artifact_route_lonlat(
        BASIN.0,
        BASIN.1,
        CHANNEL_SOUTH.0,
        CHANNEL_SOUTH.1,
        &cells,
        &params,
        &w,
    )
    .expect("basin -> channel routes");
    assert_eq!(
        ab.diagnostics.route_cost_mm, ba.diagnostics.route_cost_mm,
        "route cost is not direction-symmetric"
    );
    let mut ba_rev = ba.waypoints.clone();
    ba_rev.reverse();
    assert_eq!(
        ab.waypoints, ba_rev,
        "route geometry is not the reverse of B->A"
    );
}

// ---------------------------------------------------------------------------
// §23 shapes with no OSENC fixture in the repo — stubbed, not silently
// missing. See the module docs.
// ---------------------------------------------------------------------------

#[test]
#[ignore = "no repo fixture charts a passage the raster genuinely CLOSES — \
            refine.rs's synthetic diagonal-wall unit test covers the raster-closure case"]
fn raster_closed_passage() {}

#[test]
#[ignore = "no repo fixture charts an UNSARE zone on a routable line"]
fn unsurveyed_area_transit() {}

#[test]
#[ignore = "no repo fixture charts a RESARE restricted area on a routable line"]
fn restricted_area_entry() {}

#[test]
#[ignore = "TSS-against-flow runs in mivnav_regression_us5oakee.rs (feature s57-ingest) — \
            the only compact real TSS cell is GDAL-only"]
fn traffic_separation_scheme() {}
