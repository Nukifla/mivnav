// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

// GDAL-backed `.000` ingest — dev-box-only, off the Pi wheel. Whole file
// compiles out of the default (gdal-free) build, same reasoning as
// `tests/mivnav_tss_us5oakee.rs`. See the `s57-ingest` feature in Cargo.toml.
#![cfg(feature = "s57-ingest")]

//! Phase 7 (§11) directional / buoyage semantics, proven on the SAME real
//! NOAA ENC cell `tests/mivnav_tss_us5oakee.rs` uses — `US5OAKEE.000`,
//! which charts a real `TSSLPT` traffic lane with a real `ORIENT` plus
//! real `BOYLAT` lateral marks ("San Francisco Main Ship Channel Lighted
//! Bell Buoy 7" / "...Whistle Buoy 8"). See that file's module docs for
//! full fixture provenance and licence (NOAA, public domain / CC0-1.0).
//!
//! Task 4's "Done when": *lateral marks passed on the correct side in
//! both directions; a TSS never transited against flow; on real chart
//! data.*

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, Extent};
use chartcore::mivnav::{
    band_to_dm, bearing_deg, build_directional_semantics, build_region, decode_semantics,
    detect_portals, encode_semantics, label_band, portal_crossing_point, select_band, snap_point,
    topology_route_graced_demoting, topology_route_with, TopologyWeights, TransitionRule,
};
use chartcore::model::Cell;
use chartcore::routing::artifact::CatzocMode;
use chartcore::s57::{read_cell, S57OpenOptions};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/US5OAKEE.000")
}

fn cell() -> &'static Cell {
    static CELL: OnceLock<Cell> = OnceLock::new();
    CELL.get_or_init(|| {
        let mut cell = read_cell(&fixture_path(), &S57OpenOptions::default())
            .expect("US5OAKEE fixture decodes");
        chartcore::derive::apply(&mut cell);
        cell
    })
}

fn region_extent() -> Extent {
    let e = cell().extent;
    let pad = (e.xmax - e.xmin) / 4;
    Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad)
}

// Same two real charted aids `mivnav_tss_us5oakee.rs` uses — see that
// file for how the coordinates were read straight off the decoded
// `BOYLAT` geometry. They sit in adjacent tiles connected by two real
// crossings of the shared boundary: one runs through the charted TSSLPT
// lane, the other does not.
const BUOY_7: (f64, f64) = (-122.589910, 37.781869);
const BUOY_8: (f64, f64) = (-122.587354, 37.775345);
const REQUIRED_DEPTH_M: f64 = 1.0;

#[test]
fn a_real_tsslpt_compiles_into_a_flow_zone_with_a_usable_orient() {
    let sem = build_directional_semantics(&[cell().clone()]);
    assert!(
        !sem.flow_zones.is_empty(),
        "US5OAKEE charts a real TSSLPT — build_directional_semantics must \
         produce at least one flow zone, or ORIENT extraction never fires \
         outside synthetic fixtures"
    );
    for z in &sem.flow_zones {
        assert!(z.orient_deg.is_finite());
        assert!(
            z.rings.iter().any(|r| r.len() >= 3),
            "a flow zone must carry real polygon geometry"
        );
    }
    assert!(
        !sem.marks.is_empty(),
        "US5OAKEE charts real BOYLAT marks — they must be classified into \
         DirectionalMarks"
    );
}

#[test]
fn the_tss_crossing_is_forbidden_one_way_and_allowed_the_other() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    let sem = build_directional_semantics(&[cell().clone()]);

    let from = lat_lon_to_world(BUOY_7.1, BUOY_7.0);
    let to = lat_lon_to_world(BUOY_8.1, BUOY_8.0);
    let start = snap_point(&built, from).expect("Buoy 7 inside the region");
    let goal = snap_point(&built, to).expect("Buoy 8 inside the region");
    assert_ne!(start.tile, goal.tile);

    let draft_dm = band_to_dm(REQUIRED_DEPTH_M);
    let unweighted = topology_route_with(
        &built,
        &portals,
        start.tile,
        goal.tile,
        draft_dm,
        TopologyWeights::default(),
    )
    .expect("the real charted channel connects these two buoys");
    let tss_portal_id = unweighted.hops[0].portal;
    let tss_portal = portals
        .iter()
        .find(|p| p.id == tss_portal_id)
        .expect("a hop references a real portal");
    assert!(
        tss_portal.touches_tss,
        "sanity: the default route between these buoys crosses the TSS-flagged portal"
    );

    // Judge that exact crossing, forward and reverse, with the same
    // tile-centre bearing `route_core` itself uses.
    let a = built.tiles[tss_portal.tile as usize].extent().midpoint();
    let b = built.tiles[tss_portal.neighbour_tile as usize]
        .extent()
        .midpoint();
    let crossing = portal_crossing_point(&built, tss_portal).expect("edge-adjacent tiles");
    let fwd = sem.rule_for_crossing(crossing, bearing_deg(a, b));
    let rev = sem.rule_for_crossing(crossing, bearing_deg(b, a));

    assert!(
        (fwd == TransitionRule::Forbidden) ^ (rev == TransitionRule::Forbidden),
        "a one-way TSS lane must forbid exactly ONE direction of this \
         crossing, not zero and not both: fwd={fwd:?} rev={rev:?}"
    );
}

#[test]
fn a_tss_is_never_transited_against_flow_in_either_travel_direction() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    let sem = build_directional_semantics(&[cell().clone()]);
    let draft_dm = band_to_dm(REQUIRED_DEPTH_M);

    let b7 = lat_lon_to_world(BUOY_7.1, BUOY_7.0);
    let b8 = lat_lon_to_world(BUOY_8.1, BUOY_8.0);

    // The directional rule must never turn a real route into no route.
    for (name, from, to) in [("7->8", b7, b8), ("8->7", b8, b7)] {
        let (route, _s, _g) = topology_route_graced_demoting(
            &built,
            &portals,
            from,
            to,
            draft_dm,
            150.0,
            0,
            Some(&sem),
            TopologyWeights::default(),
        )
        .unwrap_or_else(|| panic!("{name}: directional rules must not delete the only route"));

        // No portal ON the chosen route is one the directional store
        // would forbid for the direction it is crossed.
        for hop in &route.hops {
            let p = portals.iter().find(|p| p.id == hop.portal).unwrap();
            let a = built.tiles[hop.tile as usize].extent().midpoint();
            let c = built.tiles[hop.neighbour_tile as usize].extent().midpoint();
            let crossing = portal_crossing_point(&built, p).unwrap();
            assert_ne!(
                sem.rule_for_crossing(crossing, bearing_deg(a, c)),
                TransitionRule::Forbidden,
                "{name}: the chosen route crosses portal {} against the charted traffic flow",
                hop.portal
            );
        }
    }
}

#[test]
fn the_against_flow_route_differs_from_the_unconstrained_one() {
    // The whole point: turning directional rules on must actually change
    // which crossing the against-flow direction takes (onto the clean,
    // non-TSS boundary crossing `mivnav_tss_us5oakee.rs` establishes
    // exists), not silently no-op.
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    let sem = build_directional_semantics(&[cell().clone()]);
    let draft_dm = band_to_dm(REQUIRED_DEPTH_M);

    let b7 = lat_lon_to_world(BUOY_7.1, BUOY_7.0);
    let b8 = lat_lon_to_world(BUOY_8.1, BUOY_8.0);

    // Whichever travel direction is against the lane flow: find it by
    // asking the store about the default crossing both ways.
    let start = snap_point(&built, b7).unwrap();
    let goal = snap_point(&built, b8).unwrap();
    let base = topology_route_with(
        &built,
        &portals,
        start.tile,
        goal.tile,
        draft_dm,
        TopologyWeights::default(),
    )
    .unwrap();
    let tss_portal = portals
        .iter()
        .find(|p| p.id == base.hops[0].portal)
        .unwrap();
    let a = built.tiles[tss_portal.tile as usize].extent().midpoint();
    let b = built.tiles[tss_portal.neighbour_tile as usize]
        .extent()
        .midpoint();
    let crossing = portal_crossing_point(&built, tss_portal).unwrap();
    let seven_to_eight_forbidden =
        sem.rule_for_crossing(crossing, bearing_deg(a, b)) == TransitionRule::Forbidden;

    let (from, to) = if seven_to_eight_forbidden {
        (b7, b8)
    } else {
        (b8, b7)
    };
    let s = snap_point(&built, from).unwrap();
    let g = snap_point(&built, to).unwrap();

    let unconstrained = topology_route_with(
        &built,
        &portals,
        s.tile,
        g.tile,
        draft_dm,
        TopologyWeights::default(),
    )
    .unwrap();
    let constrained = topology_route_graced_demoting(
        &built,
        &portals,
        from,
        to,
        draft_dm,
        150.0,
        0,
        Some(&sem),
        TopologyWeights::default(),
    )
    .unwrap()
    .0;

    let unconstrained_crosses_tss = portals
        .iter()
        .find(|p| p.id == unconstrained.hops[0].portal)
        .unwrap()
        .touches_tss;
    assert!(
        unconstrained_crosses_tss,
        "sanity: without directional rules the against-flow direction still takes the TSS crossing"
    );
    assert_ne!(
        constrained.hops[0].portal, unconstrained.hops[0].portal,
        "directional rules must move the against-flow leg onto a different real crossing"
    );
}

#[test]
fn lateral_marks_are_consistent_in_both_directions() {
    // A real BOYLAT mark, judged from a crossing point a short way off
    // it: exactly one direction of travel keeps it on its correct hand.
    let sem = build_directional_semantics(&[cell().clone()]);
    let mark = *sem.marks.first().expect("US5OAKEE charts BOYLAT marks");

    // Cross ~40 m north of the mark (world Y grows south, so `-40`).
    let crossing = chartcore::coords::WorldXy::new(mark.pos.x, mark.pos.y - 40);
    let east = sem.rule_for_crossing(crossing, 90.0);
    let west = sem.rule_for_crossing(crossing, -90.0);
    let penalised = |r: TransitionRule| matches!(r, TransitionRule::Penalized { .. });
    assert!(
        penalised(east) ^ penalised(west),
        "a lateral mark is on the wrong hand for exactly one of two opposite \
         courses past it: east={east:?} west={west:?}"
    );
}

#[test]
fn the_built_semantics_survive_the_section_round_trip() {
    let sem = build_directional_semantics(&[cell().clone()]);
    assert!(!sem.is_empty());
    let bytes = encode_semantics(&sem);
    assert_eq!(decode_semantics(&bytes).as_ref(), Some(&sem));
}
