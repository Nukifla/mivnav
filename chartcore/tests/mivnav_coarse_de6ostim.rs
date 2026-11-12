// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! `mivnav::coarse` on a REAL chart cell — `backend/data/fnc/DE6OSTIM.S57`,
//! the same fixture and the same `CHANNEL_NORTH`/`CHANNEL_SOUTH`/`BASIN`
//! landmarks `mivnav_query_de6ostim.rs` / `mivnav_refine_de6ostim.rs`
//! already established, reused here rather than re-discovered.
//!
//! Scope: this cell is ONE small harbour — a few hundred metres across,
//! smaller than a couple of `MIN_COARSE_LEG_M` floors — so it cannot
//! demonstrate a multi-kilometre coarse route bending around a landmass;
//! that is the backend HTTP test's job, against the real national DK
//! artifact (`backend/tests/test_routing_mivnav.py`). What it CAN prove,
//! on real portal geometry: `coarse_polyline` maps each `TopologyRoute`
//! hop to that portal's own crossing point, keeps it inside the region,
//! and returns nothing for a same-tile route or a draft no portal
//! admits. Merging / ordering / endpoint bracketing at realistic scale
//! are covered by `mivnav::coarse`'s own synthetic unit tests.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, worldx_to_lon, worldy_to_lat, Extent, WorldXy};
use chartcore::mivnav::{
    band_to_dm, build_region, coarse_polyline, coarse_polyline_with_endpoints, detect_portals,
    find_tile, label_band, portal_crossing_point, select_band, topology_route_graced, BuiltRegion,
    Portal, MIN_COARSE_LEG_M,
};
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::artifact::CatzocMode;

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

/// Real-metre great-circle distance — a local helper because
/// `routing::hazards::world_distance_m` is `pub(crate)` (same helper,
/// same reason, as `mivnav_refine_de6ostim.rs`).
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

struct Band {
    built: BuiltRegion,
    portals: Vec<Portal>,
}

fn band() -> &'static Band {
    static BAND: OnceLock<Band> = OnceLock::new();
    BAND.get_or_init(|| {
        let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
        let comps = label_band(&built, select_band(REQUIRED_DEPTH_M));
        let portals = detect_portals(&built, &comps);
        Band { built, portals }
    })
}

#[test]
fn coarse_polyline_maps_each_hop_to_its_own_portal_crossing_inside_the_region() {
    let Band { built, portals } = band();
    // CHANNEL_SOUTH -> BASIN is a real one-hop topology route on this
    // cell (`mivnav_refine_de6ostim.rs` uses the same passage).
    let from = lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0);
    let to = lat_lon_to_world(BASIN.1, BASIN.0);
    let (topo, _s, _g) = topology_route_graced(
        built,
        portals,
        from,
        to,
        band_to_dm(REQUIRED_DEPTH_M),
        150.0,
    )
    .expect("CHANNEL_SOUTH reaches BASIN");
    assert!(
        !topo.hops.is_empty(),
        "this passage crosses at least one portal"
    );

    let interior = coarse_polyline(built, portals, &topo);
    assert!(
        !interior.is_empty(),
        "a hop-bearing route yields at least one coarse point"
    );
    assert!(
        interior.len() <= topo.hops.len(),
        "merging only ever drops points"
    );

    let hop_points: Vec<WorldXy> = topo
        .hops
        .iter()
        .filter_map(|h| portal_crossing_point(built, &portals[h.portal as usize]))
        .collect();
    // Every kept point is some hop's EXACT crossing, and they stay in
    // hop order (a subsequence of `hop_points`).
    let mut hp = hop_points.iter().copied();
    for &pt in &interior {
        assert!(
            hp.by_ref().any(|h| h == pt),
            "interior point {pt:?} must be a later hop's exact portal crossing"
        );
        assert!(
            find_tile(built, pt).is_some(),
            "and must sit inside the built region"
        );
    }
}

#[test]
fn the_endpoint_wrapper_always_brackets_from_and_to_with_no_sub_floor_leg() {
    let Band { built, portals } = band();
    let from = lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0);
    let to = lat_lon_to_world(BASIN.1, BASIN.0);
    let (topo, _s, _g) = topology_route_graced(
        built,
        portals,
        from,
        to,
        band_to_dm(REQUIRED_DEPTH_M),
        150.0,
    )
    .unwrap();

    let line = coarse_polyline_with_endpoints(built, portals, &topo, from, to);
    assert_eq!(*line.first().unwrap(), from);
    assert_eq!(*line.last().unwrap(), to);
    assert!(line.len() >= 2);
    // The one exception the wrapper allows is a degenerate `[from, to]`
    // when every interior point merged into an endpoint (this harbour is
    // small enough that it does). Any leg that SURVIVES must clear the
    // floor.
    if line.len() > 2 {
        for w in line.windows(2) {
            assert!(
                metres(w[0], w[1]) >= MIN_COARSE_LEG_M - 5.0,
                "surviving leg {:.1} m is under the merge floor",
                metres(w[0], w[1])
            );
        }
    }
}

#[test]
fn a_same_tile_route_has_no_coarse_points() {
    let Band { built, portals } = band();
    // CHANNEL_NORTH and BASIN both snap to the same tile on this cell —
    // a valid 0-hop "already there" topology answer.
    let from = lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0);
    let to = lat_lon_to_world(BASIN.1, BASIN.0);
    let (topo, _s, _g) = topology_route_graced(
        built,
        portals,
        from,
        to,
        band_to_dm(REQUIRED_DEPTH_M),
        150.0,
    )
    .unwrap();
    assert!(topo.hops.is_empty(), "sanity: these points share a tile");
    assert!(coarse_polyline(built, portals, &topo).is_empty());
    assert_eq!(
        coarse_polyline_with_endpoints(built, portals, &topo, from, to),
        vec![from, to]
    );
}

#[test]
fn a_draft_no_portal_admits_has_no_coarse_route() {
    let Band { built, portals } = band();
    // This shallow harbour's deepest portal admits ~2 m; a 3 m draft
    // reaches nothing — the genuine "not reachable at this draft" case
    // `mivnav_coarse_route` returns `Ok(None)` for.
    let from = lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0);
    let to = lat_lon_to_world(BASIN.1, BASIN.0);
    assert!(
        topology_route_graced(built, portals, from, to, band_to_dm(3.0), 0.0).is_none(),
        "no portal admits a 3 m draft on this cell"
    );
}
