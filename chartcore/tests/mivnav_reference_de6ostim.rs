// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §14's reference solver and `RouteResult`, on a REAL chart cell.
//!
//! `mivnav::reference_route` runs the shipped `routing::artifact` fine
//! search with `ArtifactParams::force_finest_resolution` forced on — a
//! genuine finest-everywhere brute force, the oracle the §23 regression
//! suite (commit 5c) measures the pipeline against. This file pins the
//! reference solver and the `RouteResult` type themselves on real
//! DE6OSTIM data:
//!
//!  * `reference_route` returns a legal route and it really did run at
//!    the finest chart rung (`searched_at_finest`) — 8 m without the
//!    knob, 2 m with it, on this cell;
//!  * a `RouteResult` assembled from a fine route plus the artifact's
//!    §14 landmark bound has `best_known_lower_bound_mm ≤ route_cost_mm`
//!    and a small, non-negative `optimality_gap` at the request's own
//!    effective multiplier floor — the multiplier-aware bound, not the
//!    5× loose raw one;
//!  * the whole thing is direction-symmetric.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, Extent};
use chartcore::mivnav::{
    band_to_dm, build_artifact, effective_min_multiplier, reference_route, select_band_index,
    snap_point, straight_line_lower_bound_mm, topology_route, RegionArtifact, RouteResult,
    VerificationStatus,
};
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::artifact::{
    artifact_route_lonlat, ArtifactParams, ArtifactWeights, CatzocMode,
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

// (lon, lat) — the shared real points. CHANNEL_NORTH↔CHANNEL_SOUTH is the
// west channel, the one substantial navigable stretch here at 1 m.
const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);

const REQUIRED_M: f64 = 1.0;

fn fresh() -> &'static RegionArtifact {
    static A: OnceLock<RegionArtifact> = OnceLock::new();
    A.get_or_init(|| build_artifact(&[cell().clone()], region_extent(), CatzocMode::Off))
}

fn params() -> ArtifactParams {
    ArtifactParams {
        required_depth_m: REQUIRED_M,
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        endpoint_grace_radius_m: 150.0,
        // Zero M_QUAL on this cell, so `full` closes the harbour — every
        // routable test here uses `off` (v3 §25 open-decision-1).
        catzoc_mode: CatzocMode::Off,
        allow_restricted_entry: false,
        // reference_route forces this true regardless; false here proves
        // that.
        force_finest_resolution: false,
    }
}

/// The effective multiplier floor for a default (no-preference) request —
/// what every bound in this file is measured at.
const M: f64 = 1.0;

#[test]
fn reference_route_runs_at_finest_and_is_legal() {
    let cells = [cell()];

    // Without the knob the same passage coarsens (2 km pad + 900-cell
    // cap → 8 m cells on this cell); with it, the reference is a genuine
    // finest brute force.
    let plain = artifact_route_lonlat(
        CHANNEL_NORTH.0,
        CHANNEL_NORTH.1,
        CHANNEL_SOUTH.0,
        CHANNEL_SOUTH.1,
        &cells,
        &params(),
        &ArtifactWeights::default(),
    )
    .expect("plain fine route exists");
    assert!(
        plain.diagnostics.cell_size_m > plain.diagnostics.finest_allowed_cell_m,
        "expected the plain search to be coarsened on this passage; if it now runs at finest \
         the force_finest knob has nothing to prove here"
    );

    let r = reference_route(
        &cells,
        CHANNEL_NORTH,
        CHANNEL_SOUTH,
        &params(),
        &ArtifactWeights::default(),
    )
    .expect("the west channel routes at 1 m with catzoc off");
    assert!(
        r.searched_at_finest(),
        "reference solver must run at the finest rung: cell_size {} vs finest_allowed {}",
        r.cell_size_m(),
        r.finest_allowed_cell_m()
    );
    assert!(
        r.legal(),
        "the reference route crosses the hard-constraint union"
    );
    assert!(r.route_cost_mm() > 0);
    assert!(r.distance_m() > 0.0);
    // The finer grid should not make the route materially longer than
    // the coarse one — same passage, more resolution.
    assert!(r.distance_m() <= plain.distance_m * 1.5);
}

#[test]
fn route_result_off_real_data_has_a_small_non_negative_gap() {
    let art = fresh();
    let band_index = select_band_index(REQUIRED_M);
    let band = art.band(band_index).expect("shallowest band exists");

    let from = lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0);
    let to = lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0);
    let s = snap_point(&art.built, from).expect("start snaps").tile;
    let g = snap_point(&art.built, to).expect("goal snaps").tile;

    let fine = artifact_route_lonlat(
        CHANNEL_NORTH.0,
        CHANNEL_NORTH.1,
        CHANNEL_SOUTH.0,
        CHANNEL_SOUTH.1,
        &[cell()],
        &params(),
        &ArtifactWeights::default(),
    )
    .expect("fine route exists");

    // The FINE-route bound is the straight-line great-circle distance at
    // this request's effective multiplier floor (1.0 — no preference
    // weight). The ALT landmark bound is NOT mixed in: it bounds the
    // tile-centre topology cost, which the fine search beats by
    // corner-cutting, so it is not a valid bound on the fine route.
    assert_eq!(effective_min_multiplier(0.0), M);
    let straight_raw = straight_line_lower_bound_mm(CHANNEL_NORTH, CHANNEL_SOUTH, 0.2);
    let lb = straight_line_lower_bound_mm(CHANNEL_NORTH, CHANNEL_SOUTH, M);
    let result = RouteResult::from_fine_route(&fine, lb);

    println!(
        "DE6OSTIM CHANNEL_NORTH->SOUTH: cost {} mm, straight-line lb@0.2 {} mm, \
         straight-line lb@1.0 {} mm, optimality_gap {:.4}",
        result.route_cost_mm, straight_raw, lb, result.optimality_gap
    );

    assert_eq!(result.best_known_lower_bound_mm, lb);
    assert!(
        result.best_known_lower_bound_mm <= result.route_cost_mm,
        "the lower bound {} exceeds the route cost {}",
        result.best_known_lower_bound_mm,
        result.route_cost_mm
    );
    assert!(result.optimality_gap >= 0.0);
    // This passage is nearly a straight line, so the multiplier-aware
    // bound is tight and the gap is tiny. A regression that reinstated
    // the raw 0.2 floor would push this toward ~4.
    assert!(
        result.optimality_gap < 0.2,
        "optimality gap {:.3} is far larger than a near-straight passage should show — \
         has the raw MIN_MULTIPLIER-floored bound crept back?",
        result.optimality_gap
    );
    assert!(
        lb > straight_raw * 4,
        "the multiplier-aware bound {lb} should be ~5x the raw {straight_raw}"
    );
    assert_eq!(result.verification_status, VerificationStatus::Verified);

    // The ALT landmark bound bounds the TOPOLOGY cost (apples-to-apples
    // with topology_route), not the fine route.
    let alt = band.landmarks.lower_bound_mm(s, g);
    if let Some(t) = topology_route(&art.built, &band.portals, s, g, band_to_dm(REQUIRED_M)) {
        assert!(alt > 0, "ALT lower bound collapsed to 0 on a routable pair");
        assert!(
            alt <= t.cost_mm,
            "ALT lower bound {alt} exceeds the topology cost {} it bounds",
            t.cost_mm
        );
    }
}

#[test]
fn the_reference_route_and_result_are_direction_symmetric() {
    let cells = [cell()];
    let ab = reference_route(
        &cells,
        CHANNEL_NORTH,
        CHANNEL_SOUTH,
        &params(),
        &ArtifactWeights::default(),
    )
    .expect("A->B routes");
    let ba = reference_route(
        &cells,
        CHANNEL_SOUTH,
        CHANNEL_NORTH,
        &params(),
        &ArtifactWeights::default(),
    )
    .expect("B->A routes");
    assert_eq!(
        ab.route_cost_mm(),
        ba.route_cost_mm(),
        "reference cost is not symmetric"
    );

    let a2b = RouteResult::from_fine_route(
        &artifact_route_lonlat(
            CHANNEL_NORTH.0,
            CHANNEL_NORTH.1,
            CHANNEL_SOUTH.0,
            CHANNEL_SOUTH.1,
            &cells,
            &params(),
            &ArtifactWeights::default(),
        )
        .unwrap(),
        straight_line_lower_bound_mm(CHANNEL_NORTH, CHANNEL_SOUTH, M),
    );
    let b2a = RouteResult::from_fine_route(
        &artifact_route_lonlat(
            CHANNEL_SOUTH.0,
            CHANNEL_SOUTH.1,
            CHANNEL_NORTH.0,
            CHANNEL_NORTH.1,
            &cells,
            &params(),
            &ArtifactWeights::default(),
        )
        .unwrap(),
        straight_line_lower_bound_mm(CHANNEL_SOUTH, CHANNEL_NORTH, M),
    );
    assert_eq!(a2b.route_cost_mm, b2a.route_cost_mm);
    assert_eq!(a2b.best_known_lower_bound_mm, b2a.best_known_lower_bound_mm);
    assert!((a2b.optimality_gap - b2a.optimality_gap).abs() < 1e-9);
}
