// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! End-to-end check that `mivnav::query`'s topology layer actually
//! composes with the EXISTING `routing::artifact` fine search on a REAL
//! chart cell — `backend/data/fnc/DE6OSTIM.S57`, the same fixture and
//! the same `CHANNEL_NORTH`/`CHANNEL_SOUTH`/`BASIN` points
//! `routing_artifact_de6ostim.rs` already established as real,
//! known-navigable/known-blocked landmarks on this cell, reused here
//! rather than re-discovered, so a difference in outcome between the two
//! test files means something REAL changed, not that the two picked
//! different ground truth.
//!
//! This is the first test in the whole session that runs `mivnav`'s
//! topology search AND the exact-verified fine search together and
//! checks they agree — `select_band` → `label_band` → `detect_portals`
//! → `snap_point` (both endpoints) → `topology_route` → `corridor_extent`
//! → `routing::artifact::artifact_route_lonlat` (reused UNMODIFIED, per
//! `mivnav::query`'s own module docs: "reuses `routing::artifact::
//! search`'s grid A*", never a second implementation). No new
//! production glue code turned out to be needed for this seam — the
//! corridor's only real job is telling a caller which decoded cells to
//! fetch (`artifact_route`'s own `cells` parameter, populated by
//! `cells_for_line`-style bbox selection at the backend layer in a real
//! deployment), and this fixture's one cell already covers the whole
//! corridor by construction, so this test exercises exactly the
//! production call shape.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, Extent};
use chartcore::mivnav::{
    band_to_dm, build_region, corridor_extent, detect_portals, label_band, select_band, snap_point,
    topology_route,
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

/// (lon, lat) — identical to `routing_artifact_de6ostim.rs`'s own
/// constants, deliberately not re-derived.
const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);
const REQUIRED_DEPTH_M: f64 = 1.0;

fn route_params() -> ArtifactParams {
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
fn topology_confirms_the_same_real_channel_the_fine_search_already_routes() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    assert!(
        !portals.is_empty(),
        "the real cell must have real portals at this band"
    );

    let from = lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0);
    let to = lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0);
    let start = snap_point(&built, from).expect("channel north is inside the built region");
    let goal = snap_point(&built, to).expect("channel south is inside the built region");

    let topo = topology_route(
        &built,
        &portals,
        start.tile,
        goal.tile,
        band_to_dm(REQUIRED_DEPTH_M),
    )
    .expect(
        "the topology layer must confirm a path here too — this is the SAME real channel \
         routing_artifact_de6ostim.rs's a_real_route_down_the_west_channel_verifies_exactly \
         already proves the fine search routes",
    );

    // The corridor around that topology route — a SMALL pad
    // (20 m, not the 200 m an earlier draft of this test used), because
    // on this fixture's own ~400 m cell a generous pad made the
    // corridor cover the ENTIRE built region regardless of what
    // `topology_route` actually found, which would make every
    // assertion below trivially true rather than a real check (found by
    // code review, which measured the earlier padded corridor engulfing
    // `region_extent()` on every side). The check right after this one
    // exists specifically to prove THIS corridor is not that.
    let corridor = corridor_extent(&built, &topo, 20.0);
    assert!(corridor.valid);
    assert!(
        built.tiles.iter().any(|t| !corridor.includes(&t.extent())),
        "a real corridor must NOT cover the whole built region on this fixture — if it does, \
         this test cannot tell a correct corridor from a vacuous one"
    );

    // Reused UNMODIFIED, exactly as mivnav::query's own docs promise —
    // this is the same call shape (and the same route_params()) as
    // routing_artifact_de6ostim.rs's own `route()` helper.
    let fine = artifact_route_lonlat(
        CHANNEL_NORTH.0,
        CHANNEL_NORTH.1,
        CHANNEL_SOUTH.0,
        CHANNEL_SOUTH.1,
        &[cell()],
        &route_params(),
        &ArtifactWeights::default(),
    )
    .expect("the fine search must still find the real route on its own real cell");

    assert!(
        fine.approximate_legs.iter().all(|&a| !a),
        "{:?}",
        fine.approximate_legs
    );
    assert!(fine.distance_m > 0.0);

    // The real property this test exists to check: every waypoint the
    // EXACT fine search actually produced must land inside the coarse
    // topology-derived corridor — proving the corridor is not just
    // "some box" but a genuine, sufficient bound on where the real
    // route goes, on real chart geometry, not merely on a synthetic
    // fixture built to make it trivially true.
    for &(lon, lat) in &fine.waypoints {
        let p = lat_lon_to_world(lat, lon);
        assert!(
            corridor.contains_point(p),
            "waypoint ({lon},{lat}) -> {p:?} fell outside the topology-derived corridor {corridor:?}"
        );
    }
}

#[test]
fn a_point_the_topology_never_reaches_gives_no_topology_route_either() {
    // A point far outside the built region entirely — neither layer
    // should find anything, and neither should panic reaching for it.
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);

    let from = lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0);
    let far_away = lat_lon_to_world(CHANNEL_NORTH.1 + 5.0, CHANNEL_NORTH.0 + 5.0);
    assert!(
        snap_point(&built, from).is_some(),
        "channel north is inside the built region"
    );
    assert!(
        snap_point(&built, far_away).is_none(),
        "5 degrees away must be well outside this small region"
    );

    // Confirm the SAME distant query is ALSO unroutable through the
    // existing fine search — but NOT, per code review's own
    // measurement, for the same underlying reason: `snap_point` here
    // rejects it because the point is outside the built region entirely
    // (a clean, direct "not this region" answer). `artifact_route`'s own
    // corridor-widening logic instead keeps trying to fit a 5-degree-wide
    // corridor, coarsens its grid far past this cell's real 2 m
    // resolution to do it, and at that coarsened resolution the
    // channel's own real cell gets folded into a giant, definitely-
    // blocked cell alongside the land around it — a DIFFERENT failure
    // mode (grid coarsening swallowing real detail), not "nothing
    // charted there". Both layers correctly refuse the query; this test
    // checks only that shared boolean outcome, not a shared mechanism —
    // an earlier draft's comment claimed the mechanism was the same,
    // which code review checked by instrumenting the search directly and
    // found false.
    let far_route = artifact_route_lonlat(
        CHANNEL_NORTH.0,
        CHANNEL_NORTH.1,
        CHANNEL_NORTH.0 + 5.0,
        CHANNEL_NORTH.1 + 5.0,
        &[cell()],
        &route_params(),
        &ArtifactWeights::default(),
    );
    assert!(far_route.is_none());
}
