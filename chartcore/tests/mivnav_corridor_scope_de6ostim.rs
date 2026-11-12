// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Real-chart evidence for the corridor-SCOPING decision — the reason
//! `chartcore::mivnav`'s `corridor_scope_extent` /
//! `filter_cells_to_corridor` exist, are public and tested, and are
//! deliberately wired into NOTHING.
//!
//! Read `chartcore::mivnav::corridor_scope_extent`'s own docs first: they
//! carry the bar (**scoping may change what a route COSTS to compute,
//! never what it IS**) and the measured counterexample showing that bar
//! cannot be met from outside `routing::artifact` today, because
//! `routing::artifact::constraints::build` derives two region-global
//! scalars over whatever cell slice it is handed. That counterexample
//! lives as a unit test beside the code it indicts
//! (`dropping_a_distant_cell_can_change_the_route_via_the_catzoc_scalar`,
//! in `mivnav/query.rs`); this file is the other half — what the filter
//! does on REAL chart data, which is the half that made the mechanism
//! look safe in the first place.
//!
//! Every assertion here compares WHOLE `ArtifactRoute`s. They are
//! `PartialEq`, so that covers every waypoint, the summed distance, both
//! snap distances, the per-leg approximate/check-manually flags, and all
//! eleven `ArtifactDiagnostics` fields — grid dims, ladder rung, CATZOC
//! figure, compilation scale, blocked/unknown cell counts, nodes
//! expanded, widen attempts, cost. A resolution-rung change of the kind
//! the counterexample produces could not hide from that.
//!
//! Ground truth is reused, never re-derived: `CHANNEL_NORTH`/
//! `CHANNEL_SOUTH`/`BASIN` on `backend/data/fnc/DE6OSTIM.S57` are
//! `routing_artifact_de6ostim.rs`'s own constants, and `FAIRWAY_NORTH`/
//! `FAIRWAY_SOUTH` on `backend/data/fnc/DE6OSBRH.S57` are
//! `mivnav_fairway_de6osbrh.rs`'s — so a difference in outcome between
//! files means something real changed, not that two files picked
//! different landmarks. Both fixtures are real CC0 freenauticalchart.net
//! cells; see `backend/data/fnc/SOURCE.txt`.
//!
//! # What each case is actually evidence FOR
//!
//! 1. **On a backend-shaped candidate set the filter is inert.**
//!    `hazards.py::_bbox_around` selects candidates against
//!    `chartcore.routing_corridor_bbox`, which resolves to the same box
//!    `corridor_scope_extent` unions in, so nothing is droppable.
//!    Measured, not assumed. Caveat worth knowing: the backend tests each
//!    cell's DECLARED header extent in degrees while the filter tests
//!    `Cell::extent`, the union of feature extents in World units — on
//!    both fixtures the union is 1-2 World units larger on every edge
//!    (the safe direction), but that is an observation about these charts,
//!    not a property of the two quantities.
//! 2. **Where the filter DOES bite, these particular fixtures happen to
//!    survive it.** A DE6OSTIM query handed both cells (DE6OSBRH is
//!    ~110 km away) really does drop one, and the route really is
//!    identical — because both share a compilation scale and neither
//!    charts an `M_QUAL` zone, so both contribute the same unzoned CATZOC
//!    figure and neither global scalar moves. That is luck about this
//!    data, which is exactly why the synthetic counterexample had to be
//!    constructed, and why this pair alone was not enough to justify
//!    wiring anything.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, Extent, LLBox};
use chartcore::mivnav::{
    band_to_dm, build_region, corridor_scope_extent, corridor_scope_pad_m, detect_portals,
    filter_cells_to_corridor, label_band, select_band, topology_route_graced_with, TopologyWeights,
};
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::artifact::{
    artifact_route_lonlat, ArtifactParams, ArtifactRoute, ArtifactWeights, CatzocMode,
};

fn decode(name: &str) -> Cell {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../backend/data/fnc")
        .join(name);
    let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("{name} reads: {e}"));
    let mut cell = osenc::read_cell(file).unwrap_or_else(|e| panic!("{name} decodes: {e}"));
    chartcore::derive::apply(&mut cell);
    cell
}

fn de6ostim() -> &'static Cell {
    static CELL: OnceLock<Cell> = OnceLock::new();
    CELL.get_or_init(|| decode("DE6OSTIM.S57"))
}

fn de6osbrh() -> &'static Cell {
    static CELL: OnceLock<Cell> = OnceLock::new();
    CELL.get_or_init(|| decode("DE6OSBRH.S57"))
}

/// The union of every cell's extent, padded a quarter of its own width —
/// the same region-sizing every other `mivnav_*` integration test in this
/// directory uses, generalised to more than one cell.
fn region_extent(cells: &[&Cell]) -> Extent {
    let mut e = Extent::invalid();
    for c in cells {
        e.extend(&c.extent);
    }
    let pad = (e.xmax - e.xmin) / 4;
    Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad)
}

/// (lon, lat) — `routing_artifact_de6ostim.rs`'s own constants.
const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);
const BASIN: (f64, f64) = (11.37513, 53.992133);
/// (lon, lat) — `mivnav_fairway_de6osbrh.rs`'s own constants.
const FAIRWAY_NORTH: (f64, f64) = (13.03045, 54.43632);
const FAIRWAY_SOUTH: (f64, f64) = (13.03667, 54.43316);

const REQUIRED_DEPTH_M: f64 = 1.0;

/// `CatzocMode::Off` throughout: DE6OSTIM charts ZERO `M_QUAL` zones, so
/// the default `"full"` mode buffers every hazard by a kilometre and
/// closes the whole 400 m harbour — v3 §25 open decision #1 working as
/// specified, and the same reason every other test file here sets it
/// explicitly (see `MIVNAV_ARTIFACT_TODO.md`'s known-good points).
fn params(endpoint_grace_radius_m: f64) -> ArtifactParams {
    ArtifactParams {
        required_depth_m: REQUIRED_DEPTH_M,
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        endpoint_grace_radius_m,
        catzoc_mode: CatzocMode::Off,
        allow_restricted_entry: false,
        force_finest_resolution: false,
    }
}

/// What a corridor-scoping caller WOULD do: build the region, run the
/// topology search, derive the scope, filter, then run the fine search
/// over what survived. Returns `(route, kept, total)` so a caller can
/// assert on how much the filter actually removed as well as on what came
/// back.
///
/// Nothing in production does this — `chartcore.mivnav_route` hands the
/// fine search the caller's whole slice, and `corridor_scope_extent`'s
/// docs say why. This is the hypothetical, run against real charts, so
/// the decision rests on measurement rather than on argument.
fn scoped_route(
    from: (f64, f64),
    to: (f64, f64),
    cells: &[&Cell],
    grace_m: f64,
) -> (Option<ArtifactRoute>, usize, usize) {
    let p = params(grace_m);
    let owned: Vec<Cell> = cells.iter().map(|c| (*c).clone()).collect();
    let built = build_region(&owned, region_extent(cells), p.catzoc_mode);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);

    let from_w = lat_lon_to_world(from.1, from.0);
    let to_w = lat_lon_to_world(to.1, to.0);
    let found = topology_route_graced_with(
        &built,
        &portals,
        from_w,
        to_w,
        band_to_dm(REQUIRED_DEPTH_M),
        grace_m,
        TopologyWeights::default(),
    );

    let scope = found.as_ref().map_or(Extent::invalid(), |(topo, _, _)| {
        corridor_scope_extent(
            &built,
            topo,
            from_w,
            to_w,
            corridor_scope_pad_m(grace_m, p.lateral_margin_m),
        )
    });
    let kept = filter_cells_to_corridor(cells, scope);
    let n_kept = kept.len();
    let route = artifact_route_lonlat(
        from.0,
        from.1,
        to.0,
        to.1,
        &kept,
        &p,
        &ArtifactWeights::default(),
    );
    (route, n_kept, cells.len())
}

/// The same fine search with NO scoping at all — exactly what
/// `mivnav_route` actually does today.
fn unscoped_route(
    from: (f64, f64),
    to: (f64, f64),
    cells: &[&Cell],
    grace_m: f64,
) -> Option<ArtifactRoute> {
    artifact_route_lonlat(
        from.0,
        from.1,
        to.0,
        to.1,
        cells,
        &params(grace_m),
        &ArtifactWeights::default(),
    )
}

/// Every DE6OSTIM query pair this crate already treats as known-good,
/// each way round — reversal included because §13.2's own
/// `route(A,B) == route(B,A).reverse()` assertion is exactly the kind of
/// property a cell-set change could break asymmetrically.
fn de6ostim_pairs() -> Vec<((f64, f64), (f64, f64))> {
    vec![
        (CHANNEL_NORTH, CHANNEL_SOUTH),
        (CHANNEL_SOUTH, CHANNEL_NORTH),
        (CHANNEL_NORTH, BASIN),
        (BASIN, CHANNEL_NORTH),
        (CHANNEL_SOUTH, BASIN),
        (BASIN, CHANNEL_SOUTH),
    ]
}

#[test]
fn every_known_good_de6ostim_pair_routes_identically_with_and_without_scoping() {
    let cells = [de6ostim()];
    for (from, to) in de6ostim_pairs() {
        let (scoped, kept, total) = scoped_route(from, to, &cells, 150.0);
        let plain = unscoped_route(from, to, &cells, 150.0);
        assert_eq!(kept, total, "{from:?}→{to:?}: nothing to drop here");
        assert_eq!(
            scoped, plain,
            "{from:?}→{to:?}: corridor scoping changed the route — every waypoint, \
             distance, flag, snap and diagnostic must be identical, not merely close"
        );
    }
    // Guard against the whole file passing vacuously on a fixture that
    // stopped routing at all: at least the west-channel pair must be a
    // real found route with real waypoints.
    let (r, _, _) = scoped_route(CHANNEL_NORTH, CHANNEL_SOUTH, &cells, 150.0);
    let r = r.expect("the real west channel must still route");
    assert!(r.waypoints.len() >= 2 && r.distance_m > 0.0);
}

#[test]
fn the_real_de6osbrh_fairway_pair_routes_identically_too() {
    // 500 m of grace, not the 150 m default: this fixture's own `NAVLNE`
    // endpoints do not sit over charted soundings, measured and
    // documented when `test_fairway_preference_weight_reaches_the_
    // topology_diagnostics_over_http` was written (see
    // `MIVNAV_ARTIFACT_TODO.md`'s "Next up" item 2).
    let cells = [de6osbrh()];
    for (from, to) in [
        (FAIRWAY_NORTH, FAIRWAY_SOUTH),
        (FAIRWAY_SOUTH, FAIRWAY_NORTH),
    ] {
        let (scoped, kept, total) = scoped_route(from, to, &cells, 500.0);
        let plain = unscoped_route(from, to, &cells, 500.0);
        assert_eq!(kept, total);
        assert_eq!(
            scoped, plain,
            "{from:?}→{to:?}: corridor scoping changed the route on the real fairway cell"
        );
    }
}

#[test]
fn the_scope_drops_nothing_from_a_backend_shaped_candidate_set_on_these_charts() {
    // Reproduce `hazards.py::_bbox_around`'s own selection rule — every
    // cell whose extent overlaps `chartcore.routing_corridor_bbox` — and
    // prove the scope keeps all of it. This is the measurement behind
    // `corridor_scope_extent`'s claim that the filter is a no-op for
    // every caller in this repo, not an assumption about it.
    let all = [de6ostim(), de6osbrh()];
    for (from, to) in de6ostim_pairs() {
        let from_w = lat_lon_to_world(from.1, from.0);
        let to_w = lat_lon_to_world(to.1, to.0);
        let (w, s, e, n) = chartcore::routing::corridor_bbox_lonlat(from_w, to_w);
        let select_box = LLBox {
            w_lon: w,
            e_lon: e,
            n_lat: n,
            s_lat: s,
        }
        .to_world();
        let candidates: Vec<&Cell> = all
            .iter()
            .copied()
            .filter(|c| select_box.intersects(&c.extent))
            .collect();
        assert_eq!(
            candidates.len(),
            1,
            "only DE6OSTIM is within {from:?}→{to:?}'s own corridor bbox — if this ever \
             picks up DE6OSBRH the two fixtures are no longer ~110 km apart and the \
             over-selection test below has lost its subject"
        );

        let (_, kept, total) = scoped_route(from, to, &candidates, 150.0);
        assert_eq!(
            kept, total,
            "{from:?}→{to:?}: a backend-shaped candidate set must survive scoping intact"
        );
    }
}

#[test]
fn an_over_selecting_caller_gets_a_real_drop_that_these_two_fixtures_survive() {
    // The one shape where the filter does real work: a caller that hands
    // over a cell no corridor for this query could contain. DE6OSBRH is
    // ~110 km north-east of DE6OSTIM's harbour, far outside even the
    // fine search's widest widen-retry corridor (2 km pad floor for a
    // hop this short).
    let both = [de6ostim(), de6osbrh()];
    let only = [de6ostim()];

    for (from, to) in de6ostim_pairs() {
        let (scoped, kept, total) = scoped_route(from, to, &both, 150.0);
        assert_eq!(total, 2);
        assert_eq!(
            kept, 1,
            "{from:?}→{to:?}: the far cell must actually be dropped, or this test proves \
             nothing about the drop path"
        );
        // Identical to the fine search over the caller's WHOLE slice —
        // the property that matters — and identical to the fine search
        // over the correctly-scoped slice as well.
        assert_eq!(
            scoped,
            unscoped_route(from, to, &both, 150.0),
            "{from:?}→{to:?}: dropping a cell 110 km away changed the route"
        );
        assert_eq!(scoped, unscoped_route(from, to, &only, 150.0));
    }
}

#[test]
fn a_topology_layer_that_finds_nothing_leaves_the_cell_set_alone() {
    // A draft no portal on this cell can carry: the topology layer
    // reports `None`, which must never narrow what the exact search
    // looks at (`mivnav::select_band`'s quantised-feasibility argument —
    // this layer returning `None` is never the final word on
    // routability). Asserted directly on the filter, since a `None`
    // topology route yields `Extent::invalid()` by construction.
    let both: [&Cell; 2] = [de6ostim(), de6osbrh()];
    let kept = filter_cells_to_corridor(&both, Extent::invalid());
    assert_eq!(kept.len(), 2);
    assert!(std::ptr::eq(kept[0], both[0]) && std::ptr::eq(kept[1], both[1]));
}
