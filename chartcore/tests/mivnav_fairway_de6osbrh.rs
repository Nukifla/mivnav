// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! `Portal::touches_fairway`/`TopologyWeights::fairway_preference_
//! weight` (Phase 5), proven on a REAL charted fairway — every other
//! test of this mechanism (`chartcore/src/mivnav/portals.rs`,
//! `chartcore/src/mivnav/query.rs`) uses a synthetic, hand-built
//! fixture; this is the first to run it against a real S-57-decoded
//! feature. `backend/data/fnc/DE6OSTIM.S57` (every other real-chart
//! `mivnav`/`routing::artifact` test's own fixture) charts neither a
//! fairway nor a TSS zone — see that directory's own `SOURCE.txt` for
//! the direct feature-class scan that found this — so this is its own
//! file against a second, purpose-selected real cell,
//! `DE6OSBRH.S57` (34 KB, near Barhöft, a real charted `NAVLNE`+
//! `RECTRC` fairway).

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, Extent};
use chartcore::mivnav::{
    band_to_dm, build_region, detect_portals, label_band, select_band, snap_point,
    topology_route_with, TopologyWeights,
};
use chartcore::model::Cell;
use chartcore::osenc;
use chartcore::routing::artifact::CatzocMode;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../backend/data/fnc/DE6OSBRH.S57")
}

fn cell() -> &'static Cell {
    static CELL: OnceLock<Cell> = OnceLock::new();
    CELL.get_or_init(|| {
        let file = std::fs::File::open(fixture_path()).expect("DE6OSBRH fixture reads");
        let mut cell = osenc::read_cell(file).expect("DE6OSBRH fixture decodes");
        chartcore::derive::apply(&mut cell);
        cell
    })
}

fn region_extent() -> Extent {
    let e = cell().extent;
    let pad = (e.xmax - e.xmin) / 4;
    Extent::new(e.xmin - pad, e.xmax + pad, e.ymin - pad, e.ymax + pad)
}

/// (lon, lat) — the two ends of the cell's own charted `NAVLNE`
/// (confirmed by decoding this exact cell and reading its own feature
/// extent directly, not eyeballed off a chart image).
const FAIRWAY_NORTH: (f64, f64) = (13.03045, 54.43632);
const FAIRWAY_SOUTH: (f64, f64) = (13.03667, 54.43316);
const REQUIRED_DEPTH_M: f64 = 1.0;

#[test]
fn a_real_fairway_produces_touches_fairway_portals_on_real_decoded_data() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    assert!(
        !portals.is_empty(),
        "the real cell must have real portals at this band"
    );

    let fairway_portals: Vec<_> = portals.iter().filter(|p| p.touches_fairway).collect();
    assert!(
        !fairway_portals.is_empty(),
        "this cell charts a real NAVLNE/RECTRC fairway — at least one real portal must \
         report touches_fairway, or the flag never actually fires outside synthetic fixtures"
    );
    // No TSS charted on this small cell (confirmed by the same scan that
    // picked it) — asserted here so a future edit to the fixture, or to
    // FLAG_TSS's own derivation, that starts firing spuriously on this
    // cell doesn't go unnoticed.
    assert!(
        portals.iter().all(|p| !p.touches_tss),
        "this fixture charts no TSS-family feature; a touches_tss here would be spurious"
    );
}

#[test]
fn fairway_preference_weight_discounts_a_real_route_along_the_charted_fairway() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);

    let from = lat_lon_to_world(FAIRWAY_NORTH.1, FAIRWAY_NORTH.0);
    let to = lat_lon_to_world(FAIRWAY_SOUTH.1, FAIRWAY_SOUTH.0);
    let start = snap_point(&built, from).expect("the fairway's own north end is inside the region");
    let goal = snap_point(&built, to).expect("the fairway's own south end is inside the region");

    let draft_dm = band_to_dm(REQUIRED_DEPTH_M);
    let unweighted = topology_route_with(
        &built,
        &portals,
        start.tile,
        goal.tile,
        draft_dm,
        TopologyWeights::default(),
    )
    .expect("the real charted fairway must connect these two real points");
    assert!(!unweighted.hops.is_empty());

    let weights = TopologyWeights {
        tss_avoidance_weight: 0.0,
        fairway_preference_weight: 0.9,
    };
    let weighted = topology_route_with(&built, &portals, start.tile, goal.tile, draft_dm, weights)
        .expect("a preference weight must never turn a real route into no route at all");

    // The real, measurable proof: a 0.9 fairway preference must make
    // this REAL route's own reported cost markedly cheaper — not a
    // synthetic fixture's hand-placed flag, a real NAVLNE/RECTRC this
    // crate's own S-57 decode + derive pipeline produced.
    assert!(
        weighted.cost_mm < unweighted.cost_mm,
        "a 0.9 fairway preference on a route that runs the charted fairway's own length \
         must cost markedly less, not the same or more: {} vs {}",
        weighted.cost_mm,
        unweighted.cost_mm
    );
    // Every hop on the winning route must be a portal this cell's own
    // real fairway geometry actually flagged — the cost drop above is
    // explained by THIS, not some other coincidental effect.
    for hop in &weighted.hops {
        let portal = portals
            .iter()
            .find(|p| p.id == hop.portal)
            .expect("a route hop must reference a real portal");
        assert!(
            portal.touches_fairway,
            "portal {} on the discounted route must itself be fairway-flagged",
            portal.id
        );
    }
}
