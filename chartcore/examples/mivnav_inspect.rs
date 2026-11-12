// Inspect a built `.mivnav` — tile/rung histogram, per-band component &
// portal density, a blocked-cell breakdown (land / hazard / outside
// M_COVR / UNSARE-or-no-depth), component-size distribution,
// portals-per-tile, and a snap report for query points. The measurement
// behind the "UNSARE areas hard-block the mivnav band topology, so most
// of Danish inner waters is unroutable even though the fine search would
// grace through them" finding (`MIVNAV_ARTIFACT_TODO.md`).
//
//   cargo run --release --example mivnav_inspect -- <path.mivnav> [required_depth_m]
//
// Extra args after the depth are "lat,lon lat,lon" query points to snap
// and report (default: a Samso crossing).

use std::collections::BTreeMap;
use std::path::PathBuf;

use chartcore::coords::lat_lon_to_world;
use chartcore::mivnav::{
    band_to_dm, load_band, load_region, snap_point, topology_route_graced, ArtifactReader,
    BuiltRegion, Portal, BAND_LADDER_M, DEPTH_NO_COVERAGE, FLAG_HARD_HAZARD, FLAG_LAND,
    FLAG_NO_COVERAGE,
};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = PathBuf::from(
        args.next()
            .expect("usage: mivnav_inspect <path.mivnav> [depth_m] [lat,lon ...]"),
    );
    let depth_m: f64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(1.5);

    let mut points: Vec<(f64, f64)> = args
        .filter_map(|s| {
            let (lat, lon) = s.split_once(',')?;
            Some((lat.trim().parse().ok()?, lon.trim().parse().ok()?))
        })
        .collect();
    if points.is_empty() {
        points = vec![
            (55.858, 10.35),
            (55.858, 10.98),
            (55.70, 12.60),
            (55.47, 8.44),
        ];
    }

    let reader = ArtifactReader::from_file(&path).expect("open artifact");
    let built = load_region(&reader).expect("load region");

    let cell_total = built.depth_min.len();
    println!("== region ==");
    println!("tiles: {}", built.tiles.len());
    println!("cells: {cell_total}");
    let mut per_rung: BTreeMap<u8, (u64, u64)> = BTreeMap::new(); // rung -> (tiles, cells)
    for t in &built.tiles {
        let e = per_rung.entry(t.rung).or_default();
        e.0 += 1;
        e.1 += t.cols as u64 * t.rows as u64;
    }
    for (rung, (tiles, cells)) in &per_rung {
        let m = BAND_LADDER_M
            .get(*rung as usize)
            .copied()
            .unwrap_or(f64::NAN);
        let _ = m; // rung is the RESOLUTION ladder, not BAND_LADDER — just print the index
        println!("  rung {rung:2}: {tiles:6} tiles  {cells:>12} cells");
    }
    println!("stitch runs: {}", built.stitch.len());

    let band_index = smallest_band_index_ge(depth_m);
    let band = load_band(&reader, &built, band_index).expect("load band");
    let draft_dm = band_to_dm(depth_m);
    println!(
        "\n== band {} (depth {depth_m} m -> {draft_dm} dm) ==",
        BAND_LADDER_M[band_index as usize]
    );
    println!("components: {}", band.components.count);
    println!("portals:    {}", band.portals.len());
    println!("shortcuts:  {}", band.shortcuts.len());

    // Component-size histogram from the flat label column.
    let mut comp_cells: BTreeMap<u32, u64> = BTreeMap::new();
    let mut blocked = 0u64;
    for &l in &band.components.label {
        if l == u32::MAX {
            blocked += 1;
        } else {
            *comp_cells.entry(l).or_default() += 1;
        }
    }

    // WHY are the blocked cells blocked? land / hazard / outside-M_COVR /
    // inside-coverage-but-no-charted-depth (the sentinel with no flag).
    let (mut b_land, mut b_haz, mut b_nocov, mut b_nodepth, mut b_shallow) =
        (0u64, 0u64, 0u64, 0u64, 0u64);
    for i in 0..cell_total {
        if band.components.label[i] != u32::MAX {
            continue;
        }
        let f = built.flags[i];
        if f & FLAG_LAND != 0 {
            b_land += 1;
        } else if f & FLAG_HARD_HAZARD != 0 {
            b_haz += 1;
        } else if f & FLAG_NO_COVERAGE != 0 {
            b_nocov += 1;
        } else if built.depth_max[i] == DEPTH_NO_COVERAGE {
            b_nodepth += 1;
        } else {
            b_shallow += 1;
        }
    }
    println!(
        "blocked breakdown: land {b_land}  hazard {b_haz}  outside-M_COVR {b_nocov}  \
         in-coverage-no-charted-depth {b_nodepth}  too-shallow {b_shallow}"
    );
    let mut sizes: Vec<u64> = comp_cells.values().copied().collect();
    sizes.sort_unstable_by(|a, b| b.cmp(a));
    let nav = cell_total as u64 - blocked;
    println!(
        "navigable cells: {nav} ({:.1}%)   blocked/no-coverage: {blocked}",
        100.0 * nav as f64 / cell_total as f64
    );
    if !sizes.is_empty() {
        let top: Vec<u64> = sizes.iter().take(8).copied().collect();
        let singletons = sizes.iter().filter(|&&s| s == 1).count();
        let tiny = sizes.iter().filter(|&&s| s <= 4).count();
        println!(
            "largest component: {} cells ({:.1}% of navigable)   top 8: {top:?}",
            sizes[0],
            100.0 * sizes[0] as f64 / nav.max(1) as f64
        );
        println!(
            "components with <=1 cell: {singletons}   with <=4: {tiny}   (of {})",
            sizes.len()
        );
    }

    // Portals per tile.
    let mut portals_on_tile: BTreeMap<u32, u32> = BTreeMap::new();
    for p in &band.portals {
        *portals_on_tile.entry(p.tile).or_default() += 1;
    }
    let tiles_with_portal = portals_on_tile.len();
    println!(
        "tiles with >=1 portal: {tiles_with_portal} / {} ({:.1}%)",
        built.tiles.len(),
        100.0 * tiles_with_portal as f64 / built.tiles.len() as f64
    );

    // Per query point: snap, report tile rung, component, portal-bearing
    // neighbourhood.
    println!("\n== query points (depth {depth_m} m) ==");
    for &(lat, lon) in &points {
        let w = lat_lon_to_world(lat, lon);
        match snap_point(&built, w) {
            None => println!("  {lat:.4},{lon:.4}: OUTSIDE the built region"),
            Some(s) => {
                let t = &built.tiles[s.tile as usize];
                let f = built.flags.get(s.global_index).copied().unwrap_or(0);
                let dmin = built
                    .depth_min
                    .get(s.global_index)
                    .copied()
                    .unwrap_or(DEPTH_NO_COVERAGE);
                let dmax = built
                    .depth_max
                    .get(s.global_index)
                    .copied()
                    .unwrap_or(DEPTH_NO_COVERAGE);
                let why = if f & FLAG_LAND != 0 {
                    "LAND"
                } else if f & FLAG_HARD_HAZARD != 0 {
                    "HAZARD"
                } else if f & FLAG_NO_COVERAGE != 0 {
                    "outside-M_COVR"
                } else if dmax == DEPTH_NO_COVERAGE {
                    "in-coverage-no-depth"
                } else {
                    "ok/shallow"
                };
                let comp = band
                    .components
                    .label
                    .get(s.global_index)
                    .copied()
                    .unwrap_or(u32::MAX);
                let comp_sz = if comp == u32::MAX {
                    0
                } else {
                    comp_cells.get(&comp).copied().unwrap_or(0)
                };
                let on_tile = portals_on_tile.get(&s.tile).copied().unwrap_or(0);
                let nearest = nearest_portal_tile_km(&built, &band.portals, s.tile, draft_dm);
                println!(
                    "  {lat:.4},{lon:.4}: tile {} rung {} ({}m/cell)  {}  dmin={} dmax={}  comp {}  portals-on-tile {on_tile}  nearest-portal {}",
                    s.tile,
                    t.rung,
                    t.cell_world,
                    why,
                    if dmin == DEPTH_NO_COVERAGE { "NC".to_string() } else { format!("{}", dmin) },
                    if dmax == DEPTH_NO_COVERAGE { "NC".to_string() } else { format!("{}", dmax) },
                    if comp == u32::MAX { "BLOCKED".to_string() } else { format!("{comp} ({comp_sz} cells)") },
                    match nearest {
                        Some(km) => format!("{km:.1} km"),
                        None => "none".to_string(),
                    },
                );
            }
        }
    }

    // Pairwise topology reachability at a few graces.
    if points.len() >= 2 {
        let (la, lo) = points[0];
        let (lb, lob) = points[1];
        let from = lat_lon_to_world(la, lo);
        let to = lat_lon_to_world(lb, lob);
        println!("\n== topology_route_graced {la:.3},{lo:.3} -> {lb:.3},{lob:.3} ==");
        for grace in [150.0, 2_000.0, 5_000.0, 15_000.0, 30_000.0] {
            let r = topology_route_graced(&built, &band.portals, from, to, draft_dm, grace);
            match r {
                None => println!("  grace {:>6.0} m: None", grace),
                Some((topo, sa, ga)) => {
                    let da = km(&built, from, &built.tiles[sa.tile as usize], sa.col, sa.row);
                    let dg = km(&built, to, &built.tiles[ga.tile as usize], ga.col, ga.row);
                    println!(
                        "  grace {:>6.0} m: {} hops, cost {:.1} km, start snapped {da:.1} km, goal snapped {dg:.1} km",
                        grace,
                        topo.hops.len(),
                        topo.cost_mm as f64 / 1e6,
                    );
                }
            }
        }
    }
}

fn smallest_band_index_ge(m: f64) -> u8 {
    BAND_LADDER_M
        .iter()
        .position(|&b| b >= m)
        .unwrap_or(BAND_LADDER_M.len() - 1) as u8
}

fn tile_has_usable_portal(tile: u32, portals: &[Portal], draft_dm: u16) -> bool {
    portals
        .iter()
        .any(|p| p.tile == tile && p.max_draft_dm >= draft_dm)
}

fn nearest_portal_tile_km(
    built: &BuiltRegion,
    portals: &[Portal],
    from_tile: u32,
    draft_dm: u16,
) -> Option<f64> {
    if tile_has_usable_portal(from_tile, portals, draft_dm) {
        return Some(0.0);
    }
    let origin = &built.tiles[from_tile as usize];
    let (ox, oy) = tile_centre(origin);
    let mut best: Option<f64> = None;
    for (i, t) in built.tiles.iter().enumerate() {
        if !tile_has_usable_portal(i as u32, portals, draft_dm) {
            continue;
        }
        let (x, y) = tile_centre(t);
        let d = world_km(ox, oy, x, y);
        best = Some(best.map_or(d, |b: f64| b.min(d)));
    }
    best
}

fn tile_centre(t: &chartcore::mivnav::TileEntry) -> (f64, f64) {
    (
        t.origin_x as f64 + t.cols as f64 * t.cell_world as f64 / 2.0,
        t.origin_y as f64 + t.rows as f64 * t.cell_world as f64 / 2.0,
    )
}

// Very rough world-unit -> km (COORD_FACTOR = 2^29 for 360deg; ~0.0745 m
// per unit at the equator, /cos(lat) north-south — good enough for a
// "how far" readout).
fn world_km(x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    let du = ((x0 - x1).powi(2) + (y0 - y1).powi(2)).sqrt();
    du * (40_075.0 / 536_870_912.0) * 0.56
}

fn km(
    built: &BuiltRegion,
    p: chartcore::coords::WorldXy,
    t: &chartcore::mivnav::TileEntry,
    col: u32,
    row: u32,
) -> f64 {
    let _ = built;
    let cx = t.origin_x as f64 + (col as f64 + 0.5) * t.cell_world as f64;
    let cy = t.origin_y as f64 + (row as f64 + 0.5) * t.cell_world as f64;
    world_km(p.x as f64, p.y as f64, cx, cy)
}
