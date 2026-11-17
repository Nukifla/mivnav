// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! The persisted `.mivnav` routing artifact.
//!
//! # What this module is
//!
//! This is the *precomputed* half of `mivnav_routing_architecture_v3.md`:
//! a navigation database built **once per chart set**, at import time,
//! written to a single `.mivnav` file, published atomically, and then only
//! ever read (memory-mapped) by the query path. §0's governing principle is
//! the split itself — "build a complete navigation database at chart-import
//! time; at route-request time, perform only thresholding, a search over a
//! compiled topology, and localised refinement".
//!
//! The artifact holds, per §15: a tile index over a multi-resolution
//! spatial field, the SoA cell payload (`depth_min`/`depth_max`/`flags`,
//! §5.1), a boundary-stitch table between differing-resolution tiles
//! (§4.2), an attributed semantics store, and per band (§7.1) the
//! connected components, portals with capacity, contracted topology, and
//! landmark/lower-bound tables. None of it is vessel-dependent — §6: draft,
//! air draft, beam, tide and the depth-preference curve are *thresholds*
//! applied at query time, never inputs to the build. Anything that changes
//! when the boat changes is on the wrong side of this boundary.
//!
//! # Naming: `mivnav::` vs `routing::artifact::`
//!
//! Two things in this crate are called "artifact" and they are **not the
//! same thing**. Read this before touching either.
//!
//! - [`crate::routing::artifact`] — a *query-time* routing algorithm
//!   (`routing.algorithm = "artifact"`). It implements v3's hard-constraint,
//!   `CATZOC` and determinism rules, but recomputes everything **per
//!   request** from decoded cells, exactly like the older `raster`
//!   algorithm does. It persists nothing, needs no build step, and works on
//!   any chart set including ones nobody has ever built a `.mivnav` for.
//!   The word "artifact" there names the *cost/constraint model* it ports,
//!   not a file. It is separately shipped and tested; nothing in this
//!   module modifies it.
//!
//! - `chartcore::mivnav` (this module) — the *persisted artifact* proper:
//!   a real on-disk file format (`format.rs`), the build pipeline that
//!   emits it (§20), and the query path that searches the compiled topology
//!   inside it. This is the `"mivnav"` algorithm, a fifth option alongside
//!   `raster`/`routeiq`/`graph`/`artifact`.
//!
//! The rule of thumb: if it has an `offset` and a `len`, it is this module.
//! If it takes a `Vec<Cell>` and returns a route without ever touching the
//! filesystem, it is `routing::artifact`. Where the two overlap in *logic*
//! (the ladder, the supercover LOS, the exact verifier) this module reuses
//! `routing::`'s code rather than reimplementing it — the split is about
//! *when* work happens, not about owning a second copy of the maths.
//!
//! # State
//!
//! Phase 0 (the format and versioning contract, [`mod@format`]) and Phase
//! 2 (the spatial field) are both done: §3.2's region-wide authority
//! resolution ([`mod@authority`]), §4/§5.1's tile lattice/resolution/SoA
//! raster ([`mod@field`]), §4.2's boundary-cell stitch table
//! ([`mod@stitch`]), and §20's build pipeline tying them together into a
//! published `.mivnav` file ([`mod@build`]). Still missing from Phase 2:
//! the §18 debug overlays.
//!
//! Phase 3 is under way: §7's per-band navigability test ([`mod@bands`]),
//! §8.1's navigable connected components ([`mod@topology`]), §8.1/8.2's
//! portal detection with `max_draft`/`min_horizontal_width`/
//! `lower_bound_cost` capacity plus `touches_fairway`/`touches_tss`
//! (Phase 5's own soft-preference data, read straight off the SAME
//! per-cell flags — see [`mod@portals`]'s own docs), and §8.4's
//! chain-contracted shortcuts ([`mod@shortcuts`]).
//! `min_horizontal_width` is the plan's own portal-local Felzenszwalb–
//! Huttenlocher distance transform, reusing
//! `routing::raster::distance_field` (widened to `pub(crate)` for exactly
//! this): the widest disc of band-navigable water that can be centred on
//! a crossing, measured in a window sized off the crossing's own run,
//! rasterized at the FINER of the two tiles' cell sizes, saturating
//! rather than unbounded — [`mod@portals`]'s own docs argue each of those
//! choices, including why the value is a MAX over the crossing rather
//! than a min and why §8.3's marginal-width portals are flagged (the
//! measured number is simply stored) rather than filtered out. The §14
//! landmark/lower-bound tables threaded through from here onward are now
//! done ([`mod@landmarks`], Phase 8 commit 5a — per-band ALT anchors and
//! their reduced-weight distance matrix, persisted as
//! [`format::SectionKind::Landmarks`]). Still missing from Phase 3:
//! `max_air_draft` (the last §8.2 capacity field, blocked on a semantics
//! store).
//!
//! Phase 4's MVP gate ("distance + hard constraints only... no soft
//! costs beyond distance yet") has been DEMONSTRATED to compose, on one
//! real chart cell with one real query pair
//! (`tests/mivnav_query_de6ostim.rs`) — §7's band selection, §12.1's
//! topology search over the raw portal graph, §13.1's canonical endpoint
//! snap, and corridor extraction (all [`mod@query`]) →
//! `routing::artifact::artifact_route` (reused UNMODIFIED, per that
//! module's own docs) for the fine grid search, simplification, and
//! §16's exact verification, which that module already does internally.
//! No new production glue code was needed at that seam, and — measured
//! this time rather than assumed — none is currently POSSIBLE: a
//! corridor's only job is telling a caller which decoded cells to fetch,
//! and [`query::corridor_scope_extent`] +
//! [`query::filter_cells_to_corridor`] are that operation, built, tested
//! and deliberately left unwired. `corridor_scope_extent`'s own docs
//! carry the counterexample: `routing::artifact::constraints::build`
//! derives two REGION-GLOBAL scalars over whatever cell slice it gets,
//! so dropping a cell 110 km from the route can move the corridor grid's
//! resolution rung and change the answer. Read those docs before wiring
//! either function anywhere. "Demonstrated to compose" is a narrower claim
//! than "proven correct" — one small fixture and one query pair bound
//! what that single integration test can actually establish (code
//! review caught an earlier, over-generous corridor padding on this
//! same fixture making the test's own central assertion nearly
//! tautological; the test now uses a tight-enough pad to prove
//! something real, but it is still one geometry, not a corpus). Genuinely
//! still open, not merely unexercised: §7.3's clearance distance
//! transform / beam constraint (`routing::artifact` never had one either
//! — see that module's own "deliberately out of scope" list), §12.4's
//! local vector refinement (Phase 6), §11's directional semantics
//! (Phase 7), the quantised-feasibility trade-off `query.rs`'s own
//! `select_band` docs now spell out (a topology route can be missed for
//! a draft that falls between two ladder rungs even when the exact fine
//! search would still find one), and `topology_route` returning exactly
//! ONE best path today rather than §12.2's ranked "k=3 corridors".
//! `topology.rs`'s own flagged reconciliation between §9.3's endpoint
//! grace and this layer's connectivity IS now done —
//! [`query::topology_route_graced`] — but it is a tile-granularity
//! widening of which candidate tile an endpoint maps to, not a
//! per-cell grace to match the fine search's own finer one; a marina
//! berth whose entire own TILE has no usable portal at all still needs
//! `grace_radius_m` to reach a genuinely nearby connected tile, same as
//! before.
//!
//! Phase 5 is PARTIALLY done: fairway-preference/TSS-avoidance soft
//! costs are real and layered onto the topology search
//! ([`query::TopologyWeights`], [`query::topology_route_with`],
//! [`query::topology_route_graced_with`]) — the plan's own "cheapest
//! phase" framing held up, since both preferences already had real
//! per-cell data (`FLAG_FAIRWAY`/`FLAG_TSS`) sitting unused at this
//! layer. `topology_route`/`topology_route_graced` themselves are
//! unchanged convenience wrappers at zero weight, so this cost nothing
//! in behaviour or test coverage for every existing caller. Genuinely
//! still missing from Phase 5: `cable_avoidance_weight`/`caution_area_
//! avoidance_weight`/`low_confidence_survey_avoidance_weight`/
//! `turn_cost_weight` — each needs real per-cell data this layer does
//! not have yet (a semantics store, not a flag already sitting there to
//! read), so folding them in is real, separately scoped future work,
//! not a placeholder left half-wired here.

pub mod artifact_cache;
pub mod authority;
pub mod bands;
pub mod build;
pub mod coarse;
pub mod directional;
pub mod field;
pub mod format;
pub mod landmarks;
pub mod persist;
pub mod portals;
pub mod query;
pub mod reference;
pub mod refine;
pub mod shortcuts;
pub mod stitch;
pub mod topology;

pub use artifact_cache::OpenArtifact;
pub use authority::{cell_descs, has_residual_in_region, region_authority, RegionCell};
pub use bands::{band_to_dm, global_index, navigable, navigable_at, navigable_dm};
pub use build::{
    build_region, decode_u16_column, encode_u16_column, BuildProgress, BuildReport, BuiltRegion,
};
pub use coarse::{coarse_polyline, coarse_polyline_with_endpoints, MIN_COARSE_LEG_M};
pub use directional::{
    bearing_deg, build_directional_semantics, edge_allowed, DirectionalMark, DirectionalSemantics,
    FlowZone, TransitionRule,
};
pub use field::{
    choose_tile_resolution, choose_tile_resolution_with, decode_tile_index, encode_tile_index,
    rasterize_tile, rasterize_tile_with, supercover_cells, trigger_names, RegionLattice, TileEntry,
    TileRaster, TileReport, TileResolution, BAND_LADDER_M, OPEN_WATER_CELL_M, SOUNDG_CLUSTER_MIN,
    TILE_CELLS, TILE_ENTRY_LEN, TILE_FLAG_VECTOR_REQUIRED, TRIGGERS_IMPLEMENTED,
    TRIGGER_BLOCKING_LINE, TRIGGER_DEPTH_BAND, TRIGGER_HAZARD, TRIGGER_NARROW_WATER,
    TRIGGER_OVERHEAD, TRIGGER_PREFERRED_ROUTE, TRIGGER_TOPOLOGY_BOTTLENECK, TRIGGER_TSS_BOUNDARY,
};
pub use format::{
    chart_set_id_hash, write_artifact_atomically, ArtifactReader, ArtifactVersions, ArtifactWriter,
    BandTag, ChartSetIdentity, FileHeader, FormatError, SectionEntry, SectionKind, Staleness,
    VersionComponent, VersionMismatch, BAND_TAG_LEN, DEPTH_NO_COVERAGE, DEPTH_UNIT_DM_PER_M,
    FLAG_FAIRWAY, FLAG_HARD_HAZARD, FLAG_LAND, FLAG_NO_COVERAGE, FLAG_OVERHEAD, FLAG_RESTRICTED,
    FLAG_TSS, FLAG_VECTOR_REQUIRED,
};
pub use landmarks::{
    build_band_landmarks, decode_landmarks, encode_landmarks, BandLandmarks, LANDMARK_ANCHORS,
};
pub use persist::{
    band_tag, build_all_bands, build_all_bands_reporting, build_and_publish_region,
    build_and_publish_region_reporting, build_and_publish_region_streaming, build_artifact,
    build_artifact_reporting, build_band_topology, decode_hazard_rings, decode_semantics,
    encode_hazard_rings, encode_semantics, load_artifact, load_band, load_hazard_rings,
    load_region, load_semantics, publish_artifact, publish_region_streaming, region_hazard_rings,
    select_band_index, write_artifact_body, BandTopology, RegionArtifact, StreamedArtifactSummary,
};
pub use portals::{
    decode_portals, detect_portals, encode_portals, portal_crossing_point, Portal,
    PORTAL_RECORD_LEN,
};
pub use query::{
    corridor_extent, corridor_scope_extent, corridor_scope_pad_m, effective_min_multiplier,
    filter_cells_to_corridor, find_tile, select_band, snap_point, straight_line_lower_bound_mm,
    topology_route, topology_route_demoting, topology_route_graced, topology_route_graced_demoting,
    topology_route_graced_with, topology_route_with, RouteResult, Snap, TopologyHop, TopologyRoute,
    TopologyWeights, VerificationStatus,
};
pub use reference::{reference_route, ReferenceRoute};
pub use refine::{
    refine_demoted_route, refine_segment, segment_clear, splice, unit_cost, window_rings,
    RefineParams, RefinedRoute,
};
pub use shortcuts::{
    build_shortcuts, decode_shortcuts, encode_shortcuts, Shortcut, SHORTCUT_RECORD_LEN,
};
pub use stitch::{
    compute_stitch, decode_stitch, edge_cell, encode_stitch, resolve_run_pair, Side, StitchRun,
    STITCH_RUN_LEN,
};
pub use topology::{
    decode_components, encode_components, label_band, Components, COMPONENT_RUN_LEN, NO_COMPONENT,
};
