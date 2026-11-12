// A runnable demo of the mivnav routing artifact pipeline built up over
// this session's Phase 0-4 work: decode a real chart cell, build the
// persisted-artifact-shaped topology (region field -> bands -> components
// -> portals -> shortcuts), run the topology search between two real
// points, extract a corridor around it, then hand that corridor's cells
// to the EXISTING routing::artifact fine search (reused unmodified) for
// an actual, exact-verified route.
//
//   cargo run --example mivnav_route --features pyo3
//   cargo run --example mivnav_route --features pyo3 -- <lon1> <lat1> <lon2> <lat2> [required_depth_m]
//
// With no arguments, routes CHANNEL_NORTH -> CHANNEL_SOUTH on the real
// DE6OSTIM.S57 fixture cell (see backend/data/fnc/SOURCE.txt) at 1.0m
// required depth — the same real channel
// chartcore/tests/routing_artifact_de6ostim.rs and
// chartcore/tests/mivnav_query_de6ostim.rs already prove is navigable.

use std::path::PathBuf;

use chartcore::coords::{lat_lon_to_world, Extent};
use chartcore::mivnav::{
    band_to_dm, build_region, build_shortcuts, corridor_extent, detect_portals, label_band,
    select_band, snap_point, topology_route,
};
use chartcore::osenc;
use chartcore::routing::artifact::{
    artifact_route_lonlat, ArtifactParams, ArtifactWeights, CatzocMode,
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (from_lon, from_lat, to_lon, to_lat, required_depth_m) = if args.len() >= 4 {
        (
            args[0].parse().expect("lon1"),
            args[1].parse().expect("lat1"),
            args[2].parse().expect("lon2"),
            args[3].parse().expect("lat2"),
            args.get(4)
                .map_or(1.0, |s| s.parse().expect("required_depth_m")),
        )
    } else {
        (11.3711, 53.9930, 11.3711, 53.9896, 1.0)
    };

    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../backend/data/fnc/DE6OSTIM.S57");
    println!("chart cell:      {}", fixture.display());
    let file = std::fs::File::open(&fixture).expect("fixture reads");
    let mut cell = osenc::read_cell(file).expect("fixture decodes");
    chartcore::derive::apply(&mut cell);

    let e = cell.extent;
    let pad = (e.xmax - e.xmin) / 4;
    let region_extent = Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad);

    println!(
        "query:           ({from_lon}, {from_lat}) -> ({to_lon}, {to_lat}), required depth {required_depth_m} m"
    );

    // ---- Build the persisted-artifact-shaped topology ---------------
    let built = build_region(&[cell.clone()], region_extent, CatzocMode::Off);
    println!(
        "built region:    {} tiles, {} blocked cells, {} charted-depth cells, {} no-coverage cells",
        built.tiles.len(),
        built.report.blocked_cells,
        built.report.charted_depth_cells,
        built.report.no_coverage_cells
    );

    let band_m = select_band(required_depth_m);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    let shortcuts = build_shortcuts(&built, &portals);
    println!(
        "topology @ {band_m}m band: {} components, {} portals, {} shortcuts",
        comps.count,
        portals.len(),
        shortcuts.len()
    );

    // ---- Topology search ---------------------------------------------
    let from = lat_lon_to_world(from_lat, from_lon);
    let to = lat_lon_to_world(to_lat, to_lon);
    let Some(start) = snap_point(&built, from) else {
        println!("FROM point is outside the built region — nothing to route.");
        return;
    };
    let Some(goal) = snap_point(&built, to) else {
        println!("TO point is outside the built region — nothing to route.");
        return;
    };
    println!(
        "snapped:         from tile {}, to tile {}",
        start.tile, goal.tile
    );

    match topology_route(
        &built,
        &portals,
        start.tile,
        goal.tile,
        band_to_dm(required_depth_m),
    ) {
        Some(topo) => {
            println!(
                "topology route:  {} hop(s), cost {} mm",
                topo.hops.len(),
                topo.cost_mm
            );
            let corridor = corridor_extent(&built, &topo, 100.0);
            println!(
                "corridor:        x[{}, {}] y[{}, {}] (world units, 100m pad)",
                corridor.xmin, corridor.xmax, corridor.ymin, corridor.ymax
            );
        }
        None => {
            println!(
                "topology route:  NONE — no portal path connects these two tiles at this band/draft."
            );
        }
    }

    // ---- Fine search: the EXISTING routing::artifact algorithm, reused
    // unmodified, over the one decoded cell this demo has on hand (a
    // real deployment would fetch only cells intersecting the corridor
    // above from its own chart-set store).
    println!();
    let params = ArtifactParams {
        required_depth_m,
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        endpoint_grace_radius_m: 150.0,
        catzoc_mode: CatzocMode::Off,
        allow_restricted_entry: false,
        force_finest_resolution: false,
    };
    match artifact_route_lonlat(
        from_lon,
        from_lat,
        to_lon,
        to_lat,
        &[&cell],
        &params,
        &ArtifactWeights::default(),
    ) {
        Some(route) => {
            println!(
                "FINE ROUTE:      {} waypoints, {:.1} m, {} nodes expanded, {:.1} m/cell",
                route.waypoints.len(),
                route.distance_m,
                route.diagnostics.nodes_expanded,
                route.diagnostics.cell_size_m
            );
            println!(
                "verification:    every leg exact = {}",
                route.approximate_legs.iter().all(|&a| !a)
            );
            for (lon, lat) in &route.waypoints {
                println!("  ({lon:.6}, {lat:.6})");
            }
        }
        None => println!("FINE ROUTE:      NONE — no route within the corridor/grace radius."),
    }
}
