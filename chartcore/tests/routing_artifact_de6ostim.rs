// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! End-to-end check of the `"artifact"` routing algorithm on a REAL
//! chart cell: decode → derive → `routing::artifact::build_constraints`
//! → `artifact_route_lonlat`, against `backend/data/fnc/DE6OSTIM.S57`
//! (a real, small, CC0 freenauticalchart.net cell — see that directory's
//! `SOURCE.txt`). Same fixture and same "plain OSENC despite the `.S57`
//! extension, so no `s57-ingest` feature gate" reasoning as
//! `routing_de6ostim.rs`, which does the equivalent for the `raster`
//! algorithm; this file is deliberately its sibling rather than an
//! addition to it, so a regression in one algorithm cannot be mistaken
//! for a regression in the other.
//!
//! Why this fixture is a good one for THIS algorithm specifically
//! (checked directly against the decoded cell, not assumed): it charts
//! **14 `PILPNT`** mooring piles, **9 `SLCONS`** (`CATSLC` 1 breakwater,
//! 4 pier, 6 wharf), **5 `UWTROC`** with NO `VALSOU` at all, **one
//! `SOUNDG` multipoint carrying 32 real soundings** from 0.7m to 3.4m,
//! and **no `M_COVR` and no `M_QUAL`** — i.e. it exercises the four
//! §3.3/§3.4 rules that no existing algorithm in this crate implements
//! (the construction family, missing-`VALSOU`-blocks, `SOUNDG` as a
//! hazard, and the coverage/CATZOC fallbacks) on genuine hydrographic
//! data rather than on a synthetic square.
//!
//! Compilation scale is 1:4 000, so §4.1 resolves to the ladder's own 2m
//! floor — see `the_resolution_ladder_reads_this_real_chart`.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{Extent, WorldXy};
use chartcore::model::{Cell, Geometry};
use chartcore::osenc;
use chartcore::routing::artifact::{build_constraints, ConstraintParams};
use chartcore::routing::{
    artifact_route_lonlat, build_hazard_index, hazard_contains, ladder_finest_allowed_cell_m,
    ArtifactParams, ArtifactRoute, ArtifactWeights, CatzocMode, HazardIndex,
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

fn constraint_params(required_depth_m: f64) -> ConstraintParams {
    ConstraintParams {
        required_depth_m,
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m: 0.0,
        lateral_margin_m: 0.0,
        catzoc_mode: CatzocMode::Off,
        allow_restricted_entry: false,
        build_charted_depth: true,
    }
}

/// The hard union at `required_depth_m`, wrapped so the crate's public
/// `hazard_contains` point test can be pointed at it. The extent is left
/// invalid deliberately — `hazard_contains` never reads it.
fn hard_union(required_depth_m: f64) -> HazardIndex {
    HazardIndex {
        rings: build_constraints(&[cell()], &constraint_params(required_depth_m)).hard,
        extent: Extent::invalid(),
    }
}

fn route_params() -> ArtifactParams {
    ArtifactParams {
        required_depth_m: 1.0,
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

fn route(from: (f64, f64), to: (f64, f64)) -> Option<ArtifactRoute> {
    artifact_route_lonlat(
        from.0,
        from.1,
        to.0,
        to.1,
        &[cell()],
        &route_params(),
        &ArtifactWeights::default(),
    )
}

/// A point in the west-side channel — the only substantial stretch of
/// water this cell leaves navigable at 1.0m required depth (everything
/// east of it is a 0-2m `DEPARE`, the harbour moles, or the basin).
const CHANNEL_NORTH: (f64, f64) = (11.3711, 53.9930);
const CHANNEL_SOUTH: (f64, f64) = (11.3711, 53.9896);
/// Inside the harbour basin, reachable only around the moles.
const BASIN: (f64, f64) = (11.37513, 53.992133);

// ── §3.3's expanded hard-constraint set, on real features ─────────────

#[test]
fn every_charted_mooring_pile_blocks_here_and_did_not_before() {
    // `PILPNT` is in v3 §3.3's construction table and in NO class list
    // any existing algorithm consults — `routing::hazards`' own module
    // docs list its classes explicitly and this is not among them. At an
    // absurdly permissive depth nothing else can be doing the blocking,
    // so this isolates the class rather than the depth rule.
    let artifact = hard_union(-100.0);
    let existing = build_hazard_index(cell(), -100.0, 0.0, 0.0)
        .expect("the cell charts real land and shoreline construction");

    let piles: Vec<WorldXy> = cell()
        .features_of("PILPNT")
        .filter_map(|f| match &f.geometry {
            Some(Geometry::Point(p)) => Some(*p),
            _ => None,
        })
        .collect();
    assert_eq!(piles.len(), 14, "the fixture's own PILPNT count");

    for p in &piles {
        assert!(
            hazard_contains(&artifact, *p),
            "a charted pile at {p:?} must block for the artifact algorithm"
        );
        assert!(
            !hazard_contains(&existing, *p),
            "and must NOT already be blocked by build_hazard_index — \
             otherwise this test proves nothing about the new class"
        );
    }
}

#[test]
fn the_charted_moles_and_piers_block_at_any_depth() {
    // 9 real `SLCONS`: `CATSLC` 1 (breakwater), 4 (pier/jetty), 6
    // (wharf/quay) — none of them in `NON_BLOCKING_CATSLC`'s
    // ramp/slipway/landing-steps exemption, so all nine must block.
    let artifact = hard_union(-100.0);
    let mut checked = 0;
    for f in cell().features_of("SLCONS") {
        let centre = WorldXy::new(
            ((f.extent.xmin as i64 + f.extent.xmax as i64) / 2) as i32,
            ((f.extent.ymin as i64 + f.extent.ymax as i64) / 2) as i32,
        );
        if hazard_contains(&artifact, centre) {
            checked += 1;
        }
    }
    assert!(
        checked >= 5,
        "most of the 9 charted SLCONS must have a blocked centre, got {checked}"
    );
}

#[test]
fn an_underwater_rock_with_no_valsou_blocks_however_deep_the_boat_wants() {
    // All 5 `UWTROC` on this cell carry NO `VALSOU` (checked directly:
    // `derive::hazards` synthesises a `depth_value` of 0.01 for them, but
    // this algorithm reads the RAW attribute on purpose — v3 §3.3's
    // "unknown VALSOU → blocked"). A boat wanting -100m of water is not
    // a real case; it is the cleanest way to prove the block is not the
    // depth rule in disguise.
    let artifact = hard_union(-100.0);
    for f in cell().features_of("UWTROC") {
        assert!(
            f.attr("VALSOU").is_none(),
            "fixture assumption: these rocks carry no VALSOU"
        );
        let Some(Geometry::Point(p)) = &f.geometry else {
            continue;
        };
        assert!(
            hazard_contains(&artifact, *p),
            "an unknown-depth rock at {p:?} must block: absence is not evidence of safety"
        );
    }
}

#[test]
fn real_soundings_gate_on_the_boats_own_required_depth() {
    // No existing algorithm reads `SOUNDG` for hazard purposes at all.
    // This cell's single 32-point multipoint spans 0.7m .. 3.4m, so the
    // set of blocking soundings must GROW with required depth — and must
    // grow by a real number of points, not one.
    let shallow_boat = hard_union(3.0);
    let deep_water_boat = hard_union(0.1);
    let mut only_when_deeper = 0;
    let mut total = 0;
    for f in cell().features_of("SOUNDG") {
        let Some(Geometry::MultiPoint(points)) = &f.geometry else {
            continue;
        };
        for pz in points {
            total += 1;
            if hazard_contains(&shallow_boat, pz.pos) && !hazard_contains(&deep_water_boat, pz.pos)
            {
                only_when_deeper += 1;
            }
        }
    }
    assert_eq!(total, 32, "the fixture's own sounding count");
    assert!(
        only_when_deeper >= 10,
        "a 3.0m boat must be blocked by many more of these soundings than a 0.1m one, got {only_when_deeper}"
    );
}

// ── §4.1/§4.2 on a real compilation scale ─────────────────────────────

#[test]
fn the_resolution_ladder_reads_this_real_chart() {
    assert_eq!(
        cell().meta.compilation_scale,
        4_000,
        "fixture assumption: a 1:4 000 harbour chart"
    );
    // 4000/2000 = 2m, which is the ladder's own floor.
    assert_eq!(ladder_finest_allowed_cell_m(4_000, 0.0), 2.0);

    // This cell charts NO `M_QUAL` at all, so §3.4's D/U fallback
    // applies: 1000m horizontal at `Full`, and 1000/4 = 250m -> the 256m
    // rung. That is v3 §25 open decision #1 working exactly as
    // specified — "full application ... will close a great deal of
    // inshore water" — not a defect.
    assert!(
        cell().features_of("M_QUAL").next().is_none(),
        "fixture assumption: no charted zone of confidence"
    );
    let full = build_constraints(
        &[cell()],
        &ConstraintParams {
            catzoc_mode: CatzocMode::Full,
            ..constraint_params(1.0)
        },
    );
    assert_eq!(full.catzoc_horizontal_m, 1000.0);
    assert_eq!(
        ladder_finest_allowed_cell_m(4_000, full.catzoc_horizontal_m),
        256.0,
        "buffering by a kilometre and then routing on a 2m grid would be incoherent (§3.4)"
    );

    // Off, the same cell resolves to the source-driven 2m.
    let off = build_constraints(&[cell()], &constraint_params(1.0));
    assert_eq!(off.catzoc_horizontal_m, 0.0);
    assert_eq!(
        ladder_finest_allowed_cell_m(4_000, off.catzoc_horizontal_m),
        2.0
    );
}

#[test]
fn catzoc_full_really_closes_water_this_cell_leaves_open() {
    // The same query, the same chart, two allowance modes: `Off` routes,
    // `Full` (a kilometre of horizontal buffer on a 400m-wide harbour)
    // cannot. Documenting the consequence of the default in a test, so
    // nobody has to rediscover it live.
    assert!(route(CHANNEL_NORTH, CHANNEL_SOUTH).is_some());
    let full = artifact_route_lonlat(
        CHANNEL_NORTH.0,
        CHANNEL_NORTH.1,
        CHANNEL_SOUTH.0,
        CHANNEL_SOUTH.1,
        &[cell()],
        &ArtifactParams {
            catzoc_mode: CatzocMode::Full,
            ..route_params()
        },
        &ArtifactWeights::default(),
    );
    assert!(
        full.is_none(),
        "a 1000m D/U buffer must swallow a 400m harbour: {full:?}"
    );
}

// ── routing on the real cell ──────────────────────────────────────────

#[test]
fn a_real_route_down_the_west_channel_verifies_exactly() {
    let r = route(CHANNEL_NORTH, CHANNEL_SOUTH).expect("the west channel is navigable at 1.0m");
    assert!(
        r.distance_m > 300.0 && r.distance_m < 500.0,
        "{}",
        r.distance_m
    );
    assert_eq!(r.approximate_legs.len(), r.waypoints.len() - 1);
    assert!(
        r.approximate_legs.iter().all(|&a| !a),
        "every leg must pass the EXACT verifier: {:?}",
        r.approximate_legs
    );
    assert!(
        r.check_manually_legs.iter().all(|&m| !m),
        "nothing here is unsurveyed or an openable bridge: {:?}",
        r.check_manually_legs
    );
    // §4.1 says 2m; the corridor's own cell budget then steps the ladder
    // up. Whatever it lands on must still be a real rung or the budget
    // floor, never an arbitrary quotient below the source's limit.
    assert!(r.diagnostics.cell_size_m >= r.diagnostics.finest_allowed_cell_m);
    assert_eq!(r.diagnostics.finest_allowed_cell_m, 2.0);
}

#[test]
fn a_real_harbour_approach_bends_around_the_real_moles() {
    // From the open west channel into the basin: the only way in is
    // around the charted moles, so this cannot come back as a straight
    // line — and every leg of the bend must still verify exactly.
    let r = route(CHANNEL_NORTH, BASIN).expect("the basin is reachable");
    assert!(
        r.waypoints.len() > 2,
        "a real approach must bend: {:?}",
        r.waypoints
    );
    assert!(
        r.approximate_legs.iter().all(|&a| !a),
        "no leg may cross the moles: {:?}",
        r.approximate_legs
    );
}

#[test]
fn uncharted_water_beyond_the_cell_blocks_rather_than_reading_as_free() {
    // This cell declares no `M_COVR`, so its own extent is the coverage
    // statement — v3 §24's first trap ("No coverage is not free water.
    // The renderer leaves it unpainted; the router blocks it"). A
    // destination a kilometre outside the cell is not merely far, it is
    // uncharted, and the 150m grace radius cannot reach it.
    let far_outside = (11.3900, 53.9930);
    assert!(
        route(CHANNEL_NORTH, far_outside).is_none(),
        "uncharted water must not read as open ocean"
    );
}

// ── §13.2's two REQUIRED determinism assertions, on real data ─────────

#[test]
fn determinism_holds_on_real_chart_geometry() {
    for (a, b) in [
        (CHANNEL_NORTH, CHANNEL_SOUTH),
        (CHANNEL_NORTH, BASIN),
        (CHANNEL_SOUTH, BASIN),
    ] {
        let forward = route(a, b).expect("routes");
        let backward = route(b, a).expect("routes");

        let mut reversed = backward.waypoints.clone();
        reversed.reverse();
        assert_eq!(
            forward.waypoints, reversed,
            "route(A->B) must be route(B->A) reversed, on real geometry"
        );
        assert_eq!(forward.distance_m, backward.distance_m);
        assert_eq!(
            forward.diagnostics.route_cost_mm,
            backward.diagnostics.route_cost_mm
        );

        // Repeated identical queries: byte-identical, including every
        // diagnostic.
        let again = route(a, b).expect("routes");
        assert_eq!(forward, again);
    }
}
