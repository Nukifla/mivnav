// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Route planning support.
//!
//! [`hazards`] builds the one polygon a path search needs to avoid: the
//! union of everything a boat of a given draft, at a given safety margin,
//! must not sail into — shallow water, land, hazards, and entry-prohibited
//! areas. [`preference`] builds the SOFT cost-preference zones a route may
//! legally cross but should be biased away from (TSS lanes; an anchorage,
//! caution area, or permitted-transit restricted/military area; a
//! submarine cable or pipeline; a low-confidence-survey `M_QUAL`/`CATZOC`
//! zone) or toward (a marked fairway, recommended track, navigation line,
//! or deep-water route part — folded into one preferred-route union, see
//! that module's own docs for why) — not
//! hazards, a separate module on purpose (see its own docs). [`buoyage`] builds the same shape of soft preference for a
//! lateral mark's "correct side", which — unlike TSS/fairway — depends on
//! the direction of travel, not just charted position (see its own docs).
//! [`raster`] rasterizes all three onto a bounded-size grid and searches
//! it; nothing downstream re-reads raw S-57 attributes itself. See
//! `ROUTING_TODO.md` at the repo root for the state of the wider build
//! this is one piece of.
//!
//! [`artifact`] is a SEPARATE, fourth algorithm — a from-scratch
//! implementation of `mivnav_routing_architecture_v3.md`'s own model
//! (a much wider hard-constraint feature set, `CATZOC` as a real
//! horizontal buffer and depth allowance, endpoint grace, a
//! source-driven resolution ladder, integer-deterministic costs). It
//! re-derives chart truth from `Cell` features itself rather than
//! consuming the unions above, and shares none of [`raster`]'s search;
//! what it does reuse is [`hazards`]' geometry plumbing and
//! [`raster`]'s exact per-leg verifier. See its own module docs for
//! exactly which parts of v3 are in and out of scope.

pub mod artifact;
pub mod buoyage;
pub mod hazards;
pub mod preference;
pub mod raster;
// `pub(crate)` so `mivnav::refine`'s §12.4 visibility-graph solver can
// reuse the exact segment-vs-hazard-ring primitive rather than owning a
// second copy — its items are already `pub(crate)`.
pub(crate) mod visibility;

/// Debug-overlay bundle builder — `pub(crate)`, consumed only by the
/// `python.rs` `artifact_route_debug` pyfn.
pub(crate) use artifact::artifact_debug_lonlat;
pub use artifact::ladder::finest_allowed_cell_m as ladder_finest_allowed_cell_m;
pub use artifact::{
    artifact_route, artifact_route_lonlat, build_constraints as build_artifact_constraints,
    ArtifactConstraints, ArtifactDiagnostics, ArtifactParams, ArtifactRoute, ArtifactWeights,
    CatzocMode, ConstraintParams,
};

pub use buoyage::{build_buoyage_penalty, resolve_region as resolve_iala_region, IalaRegion};
pub use hazards::{
    build_hazard_index, build_land_only_hazard_index, build_openable_bridge_union,
    clip_to_authority, hazard_contains, hazard_contains_scaled, HazardIndex,
};
pub use preference::{
    build_cable_union, build_caution_union, build_low_confidence_survey_union,
    build_preferred_route_union, build_tss_union, build_unsurveyed_union,
};
pub use raster::{
    corridor_bbox_lonlat, graph_route, macro_route, shortest_path, shortest_path_weighted,
    CellHazardBake, GraphRoute, RouteDiagnostics, RoutePath,
};
