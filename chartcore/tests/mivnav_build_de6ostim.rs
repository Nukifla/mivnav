// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! End-to-end check of the `.mivnav` build pipeline
//! ([`chartcore::mivnav::build_region`]) on a REAL chart cell: decode →
//! derive → `build_region` → `write_artifact_atomically` →
//! `ArtifactReader`, against `backend/data/fnc/DE6OSTIM.S57` — the same
//! real, small, CC0 freenauticalchart.net cell the `"artifact"` routing
//! algorithm's own end-to-end test uses (`routing_artifact_de6ostim.rs`),
//! so a regression here is directly comparable to what that algorithm
//! sees on the identical ground truth.
//!
//! This is Phase 2's own closing integration test: authority, per-tile
//! resolution, rasterization and stitching, run together over a whole
//! region and actually published as a file, then read back.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::Extent;
use chartcore::mivnav::{
    band_to_dm, build_region, build_shortcuts, chart_set_id_hash, corridor_extent, decode_stitch,
    decode_tile_index, detect_portals, find_tile, label_band, navigable_at, select_band,
    snap_point, topology_route, write_artifact_atomically, ArtifactReader, ArtifactVersions,
    BuiltRegion, ChartSetIdentity, SectionKind, DEPTH_NO_COVERAGE, FLAG_LAND, NO_COMPONENT,
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

/// A little padding around the cell's own extent — real regions are
/// never exactly cell-sized, and this exercises the "no chart reaches
/// here" no-coverage rule at the margins in the same build.
fn region_extent() -> Extent {
    let e = cell().extent;
    let pad = (e.xmax - e.xmin) / 4;
    Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad)
}

#[test]
fn the_real_cell_builds_refines_and_rasterizes_without_losing_the_breakwater() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);

    assert!(!built.tiles.is_empty());
    // Compilation scale 1:4 000 -> §4.1's own 2 m floor; the cell carries
    // real SLCONS/PILPNT/UWTROC, so at least part of the region must
    // refine all the way down to see them.
    assert!(
        built.tiles.iter().any(|t| t.rung == 0),
        "must reach the 2 m floor somewhere"
    );
    // And the padding around the cell has nothing charted at all, so it
    // must stay coarse — refinement here is genuinely local.
    assert!(
        built.tiles.iter().any(|t| t.rung > 0),
        "the uncharted padding must not also refine"
    );

    // The breakwater-family SLCONS lines are real hazards: some cells
    // must be blocked.
    assert!(built.report.blocked_cells > 0);
    // And the 32 real soundings/DEPARE bands must produce real depth
    // values, not just the no-coverage sentinel everywhere.
    assert!(built.report.charted_depth_cells > 0);
    assert!(built.depth_min.iter().any(|&d| d != DEPTH_NO_COVERAGE));

    // The padding, with no chart reaching it, must be flagged
    // no-coverage rather than silently reading as free water (§24's own
    // rule, already pinned in field.rs — this test is the whole-pipeline
    // version of the same claim).
    assert!(built.report.no_coverage_cells > 0);

    // The stitch table is internally consistent: every run references a
    // real tile pair, and every tile that isn't alone in the index has
    // at least one contact (the region is a single contiguous block, not
    // scattered islands).
    for run in &built.stitch {
        assert!((run.tile as usize) < built.tiles.len());
        assert!((run.neighbour_tile as usize) < built.tiles.len());
        assert_ne!(run.tile, run.neighbour_tile);
    }
    if built.tiles.len() > 1 {
        assert!(!built.stitch.is_empty());
    }
}

#[test]
fn the_build_publishes_atomically_and_reads_back_byte_identical() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);

    let dir = std::env::temp_dir().join(format!("mivnav-build-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let path = dir.join("DE6OSTIM.mivnav");

    let chart_set = ChartSetIdentity::new("de6ostim-test", 1);
    write_artifact_atomically(&path, chart_set, ArtifactVersions::CURRENT, |w| {
        w.write_section(
            SectionKind::TileIndex,
            &chartcore::mivnav::encode_tile_index(&built.tiles),
        )?;
        w.write_section(
            SectionKind::DepthMin,
            &chartcore::mivnav::encode_u16_column(&built.depth_min),
        )?;
        w.write_section(
            SectionKind::DepthMax,
            &chartcore::mivnav::encode_u16_column(&built.depth_max),
        )?;
        w.write_section(SectionKind::Flags, &built.flags)?;
        w.write_section(
            SectionKind::BoundaryStitch,
            &chartcore::mivnav::encode_stitch(&built.stitch),
        )?;
        Ok(())
    })
    .expect("atomic publish succeeds");

    let bytes = std::fs::read(&path).expect("published file reads back");
    let reader = ArtifactReader::from_bytes(bytes).expect("published file parses");
    assert!(reader.version_mismatches().is_empty());
    assert_eq!(
        reader.header().chart_set.id_hash,
        chart_set_id_hash("de6ostim-test")
    );

    let tiles = decode_tile_index(reader.find_section(SectionKind::TileIndex).unwrap()).unwrap();
    assert_eq!(tiles, built.tiles);

    let stitch = decode_stitch(reader.find_section(SectionKind::BoundaryStitch).unwrap()).unwrap();
    assert_eq!(stitch, built.stitch);

    let flags = reader.find_section(SectionKind::Flags).unwrap();
    assert_eq!(flags, built.flags.as_slice());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn components_on_the_real_cell_never_include_land_and_are_deterministic() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let comps = label_band(&built, 1.0);

    assert!(
        comps.count > 0,
        "the real chart must have SOME navigable water at 1.0 m"
    );
    for (i, &label) in comps.label.iter().enumerate() {
        let land = built.flags[i] & FLAG_LAND != 0;
        if land {
            assert_eq!(
                label, NO_COMPONENT,
                "a land cell must never carry a component"
            );
        } else if label != NO_COMPONENT {
            assert!(
                navigable_at(&built.flags, &built.depth_max, i, band_to_dm(1.0)),
                "a labeled cell must actually be navigable at this band"
            );
        }
    }

    let again = label_band(&built, 1.0);
    assert_eq!(
        again, comps,
        "labeling the same real build twice must be byte-identical"
    );
}

#[test]
fn portals_on_the_real_cell_are_capacity_bounded_by_the_real_soundings() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let comps = label_band(&built, 1.0);
    let portals = detect_portals(&built, &comps);

    assert!(
        !portals.is_empty(),
        "the real chart refines to multiple tiles at its own boundary with the padding, so a real stitch seam (and therefore a portal) must exist"
    );
    for p in &portals {
        assert!(
            (p.tile as usize) < built.tiles.len()
                && (p.neighbour_tile as usize) < built.tiles.len(),
            "portal {p:?} references a tile outside the built region"
        );
        assert!(p.tile_start < p.tile_end);
        assert_ne!(
            p.max_draft_dm,
            chartcore::mivnav::DEPTH_NO_COVERAGE,
            "a portal's capacity must be a real charted figure, never the no-coverage sentinel"
        );
        assert_eq!(
            p.component,
            comps.label[global_index_of(&built, p)],
            "portal must report the component its own crossing actually belongs to"
        );
    }

    let again = detect_portals(&built, &comps);
    assert_eq!(
        again, portals,
        "detecting the same real portals twice must be byte-identical"
    );
}

/// (lon, lat) — the same two real points every other file in this suite
/// uses for this cell (`mivnav_query_de6ostim.rs`,
/// `routing_artifact_de6ostim.rs`), deliberately not re-derived: the west
/// channel, the only substantial navigable stretch here at a small draft.
const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);

/// The saturation ceiling `portals.rs` imposes on one portal's measured
/// width: twice `WIDTH_MARGIN_MAX_CELLS - 1 - sqrt(2)/2` of the FINER of
/// the two tiles' cells (see that module's own design point 3 for where
/// the shortfall comes from). Recomputed here from public data rather
/// than exported, so that widening the window in `portals.rs` shows up
/// as a real edit to this test's own expectations too.
fn width_ceiling_dm(built: &BuiltRegion, p: &chartcore::mivnav::Portal) -> f64 {
    let a = built.tiles[p.tile as usize].cell_size_m();
    let b = built.tiles[p.neighbour_tile as usize].cell_size_m();
    // f64, not u16: on this cell's own rung-7 (256 m) tiles the ceiling
    // is ~155 000 dm, and `as u16` would saturate it to 65535 — turning
    // the assertion below into one that cannot fail on exactly the
    // coarse seams where a width bug would be largest.
    2.0 * (32.0 - 1.0 - std::f64::consts::SQRT_2 / 2.0) * a.min(b) * 10.0
}

#[test]
fn min_horizontal_width_measures_the_real_west_channel_and_tells_it_from_a_sliver() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(1.0);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    assert!(!portals.is_empty());

    for p in &portals {
        assert!(
            p.min_horizontal_width_dm > 0,
            "every real portal is navigable water by construction, so it must measure SOME \
             real width — 0 is this field's own 'not measurable' answer, reachable only from \
             a structurally broken tile entry: {p:?}"
        );
        assert!(
            f64::from(p.min_horizontal_width_dm) <= width_ceiling_dm(&built, p),
            "a measured width may saturate at the window ceiling but must never exceed it: {p:?}"
        );
    }

    // The real channel: the crossing the topology layer's own route
    // between the two charted channel points actually uses.
    let from = chartcore::coords::lat_lon_to_world(CHANNEL_NORTH.1, CHANNEL_NORTH.0);
    let to = chartcore::coords::lat_lon_to_world(CHANNEL_SOUTH.1, CHANNEL_SOUTH.0);
    let start = snap_point(&built, from).expect("channel north is inside the built region");
    let goal = snap_point(&built, to).expect("channel south is inside the built region");
    let route = topology_route(&built, &portals, start.tile, goal.tile, band_to_dm(1.0))
        .expect("the same real channel mivnav_query_de6ostim.rs already routes down");
    let on_route = route
        .hops
        .iter()
        .map(|h| portals[h.portal as usize].min_horizontal_width_dm)
        .min()
        .expect("the two channel points are in different tiles, so the route has real hops");

    // A real harbour entrance, measured on 2 m cells: as of this commit
    // it reads 102.2 m, which is a sane figure for this cell's own west
    // channel and — the part worth pinning — is well UNDER the ~121 m
    // window ceiling those 2 m tiles impose, so it is a real measurement
    // of real charted banks, not a saturated "at least this wide".
    // Bracketed rather than pinned exactly: it is chart-derived, and a
    // change in rasterization could legitimately move it by a cell or
    // two without meaning anything is wrong.
    let route_portal = &portals[route.hops[0].portal as usize];
    assert!(
        f64::from(on_route) < width_ceiling_dm(&built, route_portal),
        "the channel reading must be a real measurement, not the window's own saturation \
         value — a saturated reading here would make the bracket below meaningless"
    );
    assert!(
        (200..=2000).contains(&on_route),
        "the real west channel must measure between 20 m and 200 m wide, got {on_route} dm"
    );

    // And it has to DISCRIMINATE, or the number is decoration. The
    // narrowest crossings in this same region are two real slivers where
    // the charted water only just touches a tile seam — tile 17 is 99.8%
    // NO-COVERAGE ground (§24: "no coverage is not free water"), so its
    // whole contact with the harbour is a two-to-three-cell strip along
    // its own east edge, and the width field says so: ~1.2 m and ~5.2 m
    // against the channel's ~102 m.
    let narrowest = portals
        .iter()
        .map(|p| p.min_horizontal_width_dm)
        .min()
        .unwrap();
    assert!(
        u32::from(on_route) >= u32::from(narrowest) * 10,
        "the real channel ({on_route} dm) must measure an order of magnitude wider than the \
         region's narrowest real crossing ({narrowest} dm) — a width that cannot separate \
         those two is not measuring anything"
    );
}

#[test]
fn shortcuts_on_the_real_cell_partition_every_portal_exactly_once() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let comps = label_band(&built, 1.0);
    let portals = detect_portals(&built, &comps);
    let shortcuts = build_shortcuts(&built, &portals);

    assert!(
        !shortcuts.is_empty(),
        "the real chart has real portals, so chain contraction must produce real shortcuts"
    );

    for s in &shortcuts {
        assert!((s.tile as usize) < built.tiles.len());
        assert!((s.other_tile as usize) < built.tiles.len());
        assert!(!s.portal_chain.is_empty());
        for &id in &s.portal_chain {
            assert!(
                (id as usize) < portals.len(),
                "shortcut {s:?} references a portal id outside the real portal set"
            );
        }
        assert_ne!(
            s.max_draft_dm, DEPTH_NO_COVERAGE,
            "a shortcut's capacity must be a real charted figure, never the no-coverage sentinel"
        );
        assert!(
            s.lower_bound_mm > 0 && s.lower_bound_mm <= s.upper_bound_mm,
            "shortcut {s:?} must have a real, ordered [lower, upper] cost bound"
        );
        // Every constituent portal must actually carry this shortcut's
        // own component (see shortcuts.rs's own debug_assert for the
        // same claim — this is the release-mode, real-data version).
        for &id in &s.portal_chain {
            assert_eq!(portals[id as usize].component, s.component);
        }
    }

    // Chain contraction must be a real PARTITION of the portal graph:
    // every portal — the real chart's own bidirectional crossings —
    // belongs to EXACTLY ONE shortcut's chain, not zero (silently
    // dropped) and not more than one (double-counted).
    let mut used: Vec<u32> = shortcuts
        .iter()
        .flat_map(|s| s.portal_chain.iter().copied())
        .collect();
    used.sort_unstable();
    let expected: Vec<u32> = (0..portals.len() as u32).collect();
    assert_eq!(
        used, expected,
        "every real portal must be used in exactly one shortcut's chain"
    );
    // NOT asserted: "every tile a portal touches is a shortcut
    // endpoint" — false in general, not just for pure rings. An
    // ordinary straight-chain shortcut (see
    // `a_straight_channel_contracts_to_one_shortcut_each_way`) already
    // elides its own interior tiles, and this real cell has at least
    // one "lollipop" (a loop that departs and returns to the same real
    // junction, e.g. tile 17 here) whose interior tiles are correctly
    // elided the identical way. The regression this module actually
    // guards against — a MULTI-EDGE tile pair silently misclassified as
    // a junction-free pure cycle — is covered directly, on a
    // constructed fixture where the correct answer is unambiguous, by
    // `shortcuts.rs`'s own `a_multi_edge_seam_stays_a_junction_not_a_pure_cycle`.

    let again = build_shortcuts(&built, &portals);
    assert_eq!(
        again, shortcuts,
        "contracting the same real portal graph twice must be byte-identical"
    );
}

#[test]
fn topology_route_finds_a_real_deterministic_path_on_the_real_cell() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    // A real vessel draft well inside what this cell's own real soundings
    // support (`portals_on_the_real_cell_are_capacity_bounded_by_the_real_soundings`
    // proves real portals exist here) — `select_band` is exercised as a
    // real caller would use it, not handed a band constant directly.
    let band_m = select_band(1.0);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    assert!(!portals.is_empty());

    // Every portal in `comp0` is, by construction, a real edge of the
    // tile-level portal graph within one component (`portals.rs`'s own
    // invariant) — so the lowest- and highest-indexed tiles touched by
    // ANY of those portals are guaranteed reachable from each other
    // through that graph, without needing to search for a pair by hand.
    let comp0 = portals[0].component;
    let mut tiles_in_comp: Vec<u32> = portals
        .iter()
        .filter(|p| p.component == comp0)
        .flat_map(|p| [p.tile, p.neighbour_tile])
        .collect();
    tiles_in_comp.sort_unstable();
    tiles_in_comp.dedup();
    let start = *tiles_in_comp.first().unwrap();
    let goal = *tiles_in_comp.last().unwrap();

    let route = topology_route(&built, &portals, start, goal, band_to_dm(1.0))
        .expect("both tiles share a real component, so a real portal path must connect them");
    assert_eq!(route.start_tile, start);
    assert_eq!(route.goal_tile, goal);
    assert!(route.cost_mm >= 0);
    for hop in &route.hops {
        assert!((hop.portal as usize) < portals.len());
        assert_eq!(portals[hop.portal as usize].component, comp0);
    }
    for w in route.hops.windows(2) {
        assert_eq!(w[0].neighbour_tile, w[1].tile);
    }
    if start != goal {
        assert!(!route.hops.is_empty());
        assert_eq!(route.hops.first().unwrap().tile, start);
        assert_eq!(route.hops.last().unwrap().neighbour_tile, goal);
    }

    let again = topology_route(&built, &portals, start, goal, band_to_dm(1.0));
    assert_eq!(
        again,
        Some(route),
        "searching the same real topology twice must be byte-identical"
    );
}

#[test]
fn snap_and_corridor_agree_on_the_real_cell() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);

    // A real world point genuinely inside the built region — the cell's
    // own extent midpoint.
    let point = cell().extent.midpoint();
    let snap = snap_point(&built, point).expect("the cell's own midpoint is inside the region");
    assert_eq!(
        find_tile(&built, point),
        Some(snap.tile),
        "find_tile and snap_point must agree on which tile a point lands in"
    );
    let tile = &built.tiles[snap.tile as usize];
    assert!(tile.extent().contains_point(point));
    assert_eq!(tile.cell_of(point), Some((snap.col, snap.row)));
    assert_eq!(snap.cell_centre, tile.centre_of(snap.col, snap.row));
    assert_eq!(
        snap.global_index,
        chartcore::mivnav::global_index(tile, snap.col, snap.row)
    );
    // Repeated snapping of the identical real point is byte-identical.
    assert_eq!(snap_point(&built, point), Some(snap));

    // A real topology route (same technique as the topology_route test
    // above) and its corridor: every tile the route actually crosses
    // must be fully covered, and padding must genuinely grow the box.
    let comps = label_band(&built, select_band(1.0));
    let portals = detect_portals(&built, &comps);
    let comp0 = portals[0].component;
    let mut tiles_in_comp: Vec<u32> = portals
        .iter()
        .filter(|p| p.component == comp0)
        .flat_map(|p| [p.tile, p.neighbour_tile])
        .collect();
    tiles_in_comp.sort_unstable();
    tiles_in_comp.dedup();
    let start = *tiles_in_comp.first().unwrap();
    let goal = *tiles_in_comp.last().unwrap();
    let route = topology_route(&built, &portals, start, goal, band_to_dm(1.0)).unwrap();

    let unpadded = corridor_extent(&built, &route, 0.0);
    assert!(unpadded.includes(&built.tiles[start as usize].extent()));
    assert!(unpadded.includes(&built.tiles[goal as usize].extent()));
    for hop in &route.hops {
        assert!(unpadded.includes(&built.tiles[hop.neighbour_tile as usize].extent()));
    }
    let padded = corridor_extent(&built, &route, 200.0);
    assert!(padded.includes(&unpadded));
    if start != goal {
        assert_ne!(padded, unpadded);
    }
}

/// The global SoA index of a portal's own first member cell, for
/// cross-checking `p.component` against `Components` independently of
/// `detect_portals`'s own internal bookkeeping.
fn global_index_of(built: &BuiltRegion, p: &chartcore::mivnav::Portal) -> usize {
    let tile = &built.tiles[p.tile as usize];
    let side = built
        .stitch
        .iter()
        .find(|r| r.tile == p.tile && r.neighbour_tile == p.neighbour_tile)
        .map(|r| r.side)
        .expect("portal must come from a real stitch run");
    let (col, row) = chartcore::mivnav::edge_cell(tile, side, p.tile_start);
    chartcore::mivnav::global_index(tile, col, row)
}
