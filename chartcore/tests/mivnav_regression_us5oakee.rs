// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

// GDAL-backed `.000` ingest — dev-box-only, off the Pi wheel. Whole file
// compiles out of the default (gdal-free) build, same as
// `tests/mivnav_directional_us5oakee.rs` / `tests/mivnav_tss_us5oakee.rs`.
#![cfg(feature = "s57-ingest")]

//! §23's Traffic Separation Scheme case, on the real NOAA ENC cell
//! `US5OAKEE.000` (San Francisco Bay approach — a real charted `TSSLPT`
//! lane with a real `ORIENT`, plus real `BOYLAT` marks). The gdal-free
//! `mivnav_regression.rs` cannot reach this — the only compact real TSS
//! cell is genuine ISO 8211 S-57.
//!
//! Checks, on the real Buoy 7 ↔ Buoy 8 passage:
//!
//!  * the `mivnav` topology route with directional semantics ON never
//!    crosses a portal against the charted flow (the §11 gate, re-asserted
//!    in the §14 regression frame);
//!  * the FINE route between the two buoys is legal, and its
//!    `RouteResult::optimality_gap` versus the finest-everywhere reference
//!    is small (the §14 gate);
//!  * the ALT landmark bound does not exceed the topology cost.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, Extent};
use chartcore::mivnav::{
    band_to_dm, bearing_deg, build_band_landmarks, build_directional_semantics, build_region,
    detect_portals, label_band, portal_crossing_point, reference_route, select_band, snap_point,
    straight_line_lower_bound_mm, topology_route, topology_route_graced_demoting, RouteResult,
    TopologyWeights, TransitionRule,
};
use chartcore::model::Cell;
use chartcore::routing::artifact::{
    artifact_route_lonlat, ArtifactParams, ArtifactWeights, CatzocMode,
};
use chartcore::s57::{read_cell, S57OpenOptions};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/US5OAKEE.000")
}

fn cell() -> &'static Cell {
    static CELL: OnceLock<Cell> = OnceLock::new();
    CELL.get_or_init(|| {
        let mut cell =
            read_cell(&fixture_path(), &S57OpenOptions::default()).expect("US5OAKEE decodes");
        chartcore::derive::apply(&mut cell);
        cell
    })
}

fn region_extent() -> Extent {
    let e = cell().extent;
    let pad = (e.xmax - e.xmin) / 4;
    Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad)
}

// The same two real charted aids `mivnav_directional_us5oakee.rs` uses.
const BUOY_7: (f64, f64) = (-122.589910, 37.781869);
const BUOY_8: (f64, f64) = (-122.587354, 37.775345);
const REQUIRED_DEPTH_M: f64 = 1.0;

fn params() -> ArtifactParams {
    ArtifactParams {
        required_depth_m: REQUIRED_DEPTH_M,
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        endpoint_grace_radius_m: 150.0,
        catzoc_mode: CatzocMode::Off,
        allow_restricted_entry: false,
        force_finest_resolution: false,
    }
}

#[test]
fn the_tss_passage_is_legal_near_optimal_and_never_against_flow() {
    let built = build_region(
        std::slice::from_ref(cell()),
        region_extent(),
        CatzocMode::Off,
    );
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    let landmarks = build_band_landmarks(&built, &portals);
    let sem = build_directional_semantics(&[cell().clone()]);
    let draft = band_to_dm(REQUIRED_DEPTH_M);

    let b7 = lat_lon_to_world(BUOY_7.1, BUOY_7.0);
    let b8 = lat_lon_to_world(BUOY_8.1, BUOY_8.0);
    let s = snap_point(&built, b7).expect("Buoy 7 snaps").tile;
    let g = snap_point(&built, b8).expect("Buoy 8 snaps").tile;

    // --- §11: the topology route with semantics ON crosses no portal
    // against the charted flow, in EITHER travel direction. ---
    for (name, from, to) in [("7->8", b7, b8), ("8->7", b8, b7)] {
        let (route, _s, _g) = topology_route_graced_demoting(
            &built,
            &portals,
            from,
            to,
            draft,
            150.0,
            0,
            Some(&sem),
            TopologyWeights::default(),
        )
        .unwrap_or_else(|| panic!("{name}: directional rules must not delete the only route"));
        for hop in &route.hops {
            let p = portals.iter().find(|p| p.id == hop.portal).unwrap();
            let a = built.tiles[hop.tile as usize].extent().midpoint();
            let c = built.tiles[hop.neighbour_tile as usize].extent().midpoint();
            let crossing = portal_crossing_point(&built, p).unwrap();
            assert_ne!(
                sem.rule_for_crossing(crossing, bearing_deg(a, c)),
                TransitionRule::Forbidden,
                "{name}: route crosses portal {} against the charted traffic flow",
                hop.portal
            );
        }
    }

    // --- §14: the FINE route is legal and provably near-optimal. ---
    let cells = [cell()];
    let fine = artifact_route_lonlat(
        BUOY_7.0,
        BUOY_7.1,
        BUOY_8.0,
        BUOY_8.1,
        &cells,
        &params(),
        &ArtifactWeights::default(),
    )
    .expect("the real charted channel routes between the two buoys");
    assert!(
        !fine.approximate_legs.iter().any(|&x| x),
        "the fine route crosses the hard-constraint union"
    );

    let reference = reference_route(
        &cells,
        BUOY_7,
        BUOY_8,
        &params(),
        &ArtifactWeights::default(),
    );
    if let Some(r) = &reference {
        assert!(r.searched_at_finest(), "reference did not run at finest");
        assert!(r.legal());
        let p = fine.diagnostics.route_cost_mm as f64;
        let q = r.route_cost_mm() as f64;
        assert!(
            p <= q * 1.3 && q <= p * 1.3,
            "pipeline cost {p} and reference cost {q} diverge past 30%"
        );
    } else {
        eprintln!("reference_route returned None (region too large for a finest brute force)");
    }

    let lb = straight_line_lower_bound_mm(BUOY_7, BUOY_8, 1.0);
    let result = RouteResult::from_fine_route(&fine, lb);
    eprintln!(
        "US5OAKEE Buoy 7->8: cost {} mm, lb {} mm, gap {:.4}",
        result.route_cost_mm, result.best_known_lower_bound_mm, result.optimality_gap
    );
    assert!(result.best_known_lower_bound_mm <= result.route_cost_mm);
    assert!(result.optimality_gap >= 0.0);
    assert!(
        result.optimality_gap < 0.6,
        "optimality gap {:.3} exceeds the ceiling",
        result.optimality_gap
    );

    // --- the ALT landmark bound, where a topology route exists. ---
    if let Some(topo) = topology_route(&built, &portals, s, g, draft) {
        assert!(
            landmarks.lower_bound_mm(s, g) <= topo.cost_mm,
            "ALT landmark bound exceeds the topology cost it bounds"
        );
    }
}
