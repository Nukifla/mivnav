// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

// GDAL-backed `.000` ingest — dev-box-only, off the Pi wheel. Whole file
// compiles out of the default (gdal-free) build, same reasoning as
// `tests/s57_read.rs`. See the `s57-ingest` feature in Cargo.toml.
#![cfg(feature = "s57-ingest")]

//! `Portal::touches_tss`/`TopologyWeights::tss_avoidance_weight` (Phase 5),
//! proven on a REAL charted Traffic Separation Scheme — the mirror image of
//! `tests/mivnav_fairway_de6osbrh.rs`'s fairway proof, and the same kind of
//! gap it closed: every other real-chart `mivnav` test up to this point
//! used FNC (freenauticalchart.net, CC0) fixtures decoded via the plain-
//! OSENC reader, but neither committed FNC cell charts a TSS-family
//! feature (`DE6OSTIM.S57`: neither FAIRWAY nor TSS; `DE6OSBRH.S57`:
//! fairway only — see `backend/data/fnc/SOURCE.txt`), and a direct scan of
//! all 314 real FNC-DE cells found TSS geometry only in huge, overview-
//! scale cells unsuitable for a routing test (documented in
//! `MIVNAV_ARTIFACT_TODO.md`'s "Next up").
//!
//! Fixture: `US5OAKEE.000` — a real NOAA ENC cell, decoded via the
//! GDAL-backed reader ([`chartcore::s57`]), same mechanism and same
//! fixture LOCATION convention as `tests/fixtures/US5OAKIQ.000`
//! (`tests/s57_read.rs`, `tests/derive_phase5.rs`). This is a NEW cell,
//! not that one: `US5OAKIQ` (Sacramento River delta, harbour scale) charts
//! no TSS; `US5OAKEE` does.
//!
//! ## Provenance
//!
//! - Cell: `US5OAKEE`, "San Francisco Bay - Entrance to San Francisco Bay,
//!   CA", NOAA Office of Coast Survey ENC, edition 1, update 0, issued
//!   2025-12-05, compilation scale 1:22,000. Downloaded from NOAA's own
//!   ENC Product Catalog (`https://charts.noaa.gov/ENCs/ENCProdCat.xml`,
//!   read 2026-08-24), zip at `https://www.charts.noaa.gov/ENCs/
//!   US5OAKEE.zip` (25,654 bytes; the base cell `ENC_ROOT/US5OAKEE/
//!   US5OAKEE.000` inside it, 46,300 bytes, is this fixture — no `.001`+
//!   update files exist for this edition, so the base cell alone is the
//!   complete, current dataset).
//! - Licence: US government work, no copyright claimed under Title 17
//!   U.S.C.; NOAA additionally dedicates all Coast Survey data to the
//!   public domain via CC0-1.0 (`https://www.nauticalcharts.noaa.gov/
//!   data/data-licensing.html`, read 2026-08-24). Unambiguous — no
//!   attribution-chain caveat of the kind the FNC fixtures carry.
//! - Why this cell: real, charted `TSSLPT` (two lanes: "Main Ship Channel
//!   eastbound/westbound San Francisco Bay traffic lane") plus a `PRCARE`
//!   precautionary area, real S-57 `CATTSS`/`ORIENT`/`INFORM` attributes
//!   intact — this is the actual, real-world San Francisco Bay approach
//!   traffic scheme, not a stand-in. Small for a NOAA ENC (46 KB
//!   decoded), and its `TSSLPT`/`PRCARE` geometry only covers PART of the
//!   cell's own tile grid (unlike some neighbouring OAK-series cells
//!   where the precautionary area covers the entire extent) — that
//!   partial coverage is exactly what makes it useful here: it leaves
//!   real, charted, un-flagged water for a route to divert onto.
//! - A wider real-data search for TSS is documented in full in
//!   `MIVNAV_ARTIFACT_TODO.md`, including why an OSENC-format candidate
//!   found in the Netherlands FNC set (`fnc-nl.zip`, a real charted
//!   "Schouwenbank Junction" precautionary area) was NOT used: that
//!   publisher's own site marks the underlying RWS "ENC" data source's
//!   licence status as unconfirmed (a literal "(?)" next to that one
//!   entry, unlike every other source on the same page), unlike this
//!   NOAA cell's unambiguous public-domain status.
//!
//! ## Why this is chartcore-only (no backend HTTP-level TSS test)
//!
//! Unlike the FNC fixtures (which are plain OSENC despite their `.S57`
//! name — see `backend/data/fnc/SOURCE.txt`), a NOAA ENC `.000` file is
//! genuine ISO 8211 S-57 and needs the GDAL-backed reader
//! ([`chartcore::s57`], the `s57-ingest` cargo feature) to decode at all.
//! The backend's own chartcore Python wheel is built with `features =
//! ["pyo3"]` ONLY — no `s57-ingest`, ever, even for local dev builds (see
//! `chartcore/pyproject.toml`'s own comment, and CLAUDE.md's `#GD2`
//! entry) — by design, so the Pi links no libgdal. `backend/tests/
//! test_routing.py`'s `test_plan_survey_config_reaches_chartcore` hit
//! this identical shape already for `low_confidence_survey_avoidance_
//! weight`/real `M_QUAL` zones (see that test's own comment): a real
//! S-57-only fixture can prove the mechanism at the chartcore layer, but
//! the backend HTTP endpoint can only ever load a `.senc`-format cell, so
//! a real-TSS proof AT the backend layer over HTTP is not reachable
//! without either a `.senc`-format TSS fixture (not found — see above) or
//! building the backend's own wheel with GDAL, which is a deliberate
//! architecture decision (`#GD2`) this task does not get to override for
//! one test. `backend/tests/test_routing_mivnav.py` instead gets a
//! smaller, honestly-scoped addition: proof that `tss_avoidance_weight`
//! reaches `chartcore.mivnav_route` and the topology diagnostics over
//! HTTP without erroring, on the existing (TSS-free) `DE6OSBRH.S57`
//! fixture — the same "wiring reaches through" scope `test_plan_survey_
//! config_reaches_chartcore` uses, not a real-TSS-data claim.

use std::path::PathBuf;
use std::sync::OnceLock;

use chartcore::coords::{lat_lon_to_world, Extent};
use chartcore::mivnav::{
    band_to_dm, build_region, detect_portals, label_band, select_band, snap_point,
    topology_route_with, TopologyWeights,
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

/// (lon, lat) — real NOAA-charted aids to navigation, both `OBJNAM`ed
/// directly after the traffic scheme they mark ("San Francisco Main Ship
/// Channel Lighted Bell Buoy 7" / "...Lighted Whistle Buoy 8"), confirmed
/// by decoding this exact cell and reading each `BOYLAT` feature's own
/// point geometry directly (not eyeballed off a chart image) — the same
/// "use the feature's own charted coordinates" discipline
/// `mivnav_fairway_de6osbrh.rs`'s `FAIRWAY_NORTH`/`FAIRWAY_SOUTH` used.
/// The two buoys sit in adjacent tiles at this band's tile resolution,
/// connected by TWO separate real charted crossings of the shared tile
/// boundary: one runs through the charted `TSSLPT` lane (`touches_tss`),
/// the other does not — see the second test below for what that split
/// makes possible.
const BUOY_7: (f64, f64) = (-122.589910, 37.781869);
const BUOY_8: (f64, f64) = (-122.587354, 37.775345);
const REQUIRED_DEPTH_M: f64 = 1.0;

#[test]
fn a_real_tss_produces_touches_tss_portals_on_real_decoded_data() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    assert!(
        !portals.is_empty(),
        "the real cell must have real portals at this band"
    );

    let tss_portals: Vec<_> = portals.iter().filter(|p| p.touches_tss).collect();
    assert!(
        !tss_portals.is_empty(),
        "this cell charts a real TSSLPT/PRCARE traffic scheme — at least one real portal must \
         report touches_tss, or the flag never actually fires outside synthetic fixtures"
    );
    // Unlike `DE6OSBRH.S57` (zero FAIRWAY features, so the fairway test
    // could assert touches_fairway is universally false), this cell DOES
    // chart one real FAIRWY feature too — see the module doc's provenance
    // note — so there is no equivalent "this cell charts nothing else"
    // assertion to make here. The second test below still checks the
    // specific portals it relies on individually.
}

#[test]
fn tss_avoidance_weight_diverts_a_real_route_off_the_charted_traffic_lane() {
    let built = build_region(&[cell().clone()], region_extent(), CatzocMode::Off);
    let band_m = select_band(REQUIRED_DEPTH_M);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);

    let from = lat_lon_to_world(BUOY_7.1, BUOY_7.0);
    let to = lat_lon_to_world(BUOY_8.1, BUOY_8.0);
    let start =
        snap_point(&built, from).expect("Buoy 7's own charted position is inside the region");
    let goal = snap_point(&built, to).expect("Buoy 8's own charted position is inside the region");
    assert_ne!(
        start.tile, goal.tile,
        "sanity: the two buoys must snap to different tiles, or this test proves nothing about \
         portal choice"
    );

    let draft_dm = band_to_dm(REQUIRED_DEPTH_M);
    let unweighted = topology_route_with(
        &built,
        &portals,
        start.tile,
        goal.tile,
        draft_dm,
        TopologyWeights::default(),
    )
    .expect("the real charted channel must connect these two real buoys");
    assert_eq!(
        unweighted.hops.len(),
        1,
        "sanity: these two tiles are direct neighbours on the real grid"
    );
    let unweighted_portal_id = unweighted.hops[0].portal;
    let unweighted_portal = portals
        .iter()
        .find(|p| p.id == unweighted_portal_id)
        .expect("a route hop must reference a real portal");
    assert!(
        unweighted_portal.touches_tss,
        "sanity: the default (unweighted) search must cross the TSS-flagged portal here, or \
         there is nothing for avoidance to push it off of"
    );

    let weights = TopologyWeights {
        tss_avoidance_weight: 0.9,
        fairway_preference_weight: 0.0,
    };
    let weighted = topology_route_with(&built, &portals, start.tile, goal.tile, draft_dm, weights)
        .expect("an avoidance weight must never turn a real route into no route at all");
    assert_eq!(weighted.hops.len(), 1);
    let weighted_portal_id = weighted.hops[0].portal;
    let weighted_portal = portals
        .iter()
        .find(|p| p.id == weighted_portal_id)
        .expect("a route hop must reference a real portal");

    // The real, measurable proof: a real, nonzero TSS avoidance weight
    // makes this REAL route cross a DIFFERENT real charted portal — not a
    // synthetic fixture's hand-placed flag. The two buoys' shared tile
    // boundary is crossed by two separate real navigable segments (a genuine
    // fact about this chart, confirmed by decoding it directly): one runs
    // through the charted TSSLPT lane, the other does not. Avoidance must
    // push the route onto the clean one.
    assert_ne!(
        weighted_portal_id, unweighted_portal_id,
        "tss avoidance must move this route onto a different real charted crossing"
    );
    assert!(
        !weighted_portal.touches_tss,
        "the portal the avoidance-weighted route settles on must itself be TSS-free"
    );

    // NOT a `cost_mm` strict-inequality comparison, unlike the fairway
    // test's own mirror-image assertion: `topology_route_with`'s edge cost
    // is `tile.centre_distance_m(neighbour) * portal_multiplier(...)`
    // (`chartcore/src/mivnav/query.rs`) — a function of the TILE PAIR, not
    // the specific portal segment crossing their shared boundary. Both of
    // this real boundary's two crossings connect the exact same tile
    // pair, so their UNWEIGHTED distance is identical; avoidance raises
    // only the flagged one's multiplier above 1.0, which is enough to
    // flip the WINNING portal without changing the winning path's own
    // total cost (the search was choosing between two equal-cost options,
    // same shape as `query.rs`'s own synthetic `tss_avoidance_weight_
    // pushes_the_route_off_a_flagged_portal` test, now measured on a real
    // chart instead of a hand-built ring). Asserted equal, not just
    // "don't care", so a future change to the cost model that breaks this
    // real tie is caught rather than silently changing which fact this
    // test is proving.
    assert_eq!(
        weighted.cost_mm, unweighted.cost_mm,
        "these two real crossings connect the same tile pair, so a real avoidance weight should \
         change WHICH portal wins, not the winning path's own cost: {} vs {}",
        weighted.cost_mm, unweighted.cost_mm
    );
}
