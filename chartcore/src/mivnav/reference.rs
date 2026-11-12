// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! §14's reference solver — the oracle the §23 regression suite measures
//! the `mivnav` pipeline against.
//!
//! # What it is, and the independence trade
//!
//! [`reference_route`] runs the shipped [`crate::routing::artifact`] fine
//! search over **every** cell handed to it, and exposes whether that
//! search ran at the finest resolution the source charts allow
//! ([`ReferenceRoute::searched_at_finest`]). That is the whole solver:
//! same cost/constraint model, same A\* engine, same §16 verifier — no
//! third from-scratch implementation.
//!
//! This is a deliberate trade, stated up front the same way the plan's
//! own judgment-call log does. A fully independent oracle would catch a
//! bug that lives in `constraints::build` or `artifact::search` itself;
//! this one cannot, because the pipeline it grades shares that code. What
//! it *does* catch is every bug in the layers `mivnav` adds **on top** —
//! band selection, the topology search, corridor extraction, the
//! `mivnav_beam_m` demote/refine path — by pinning their combined output
//! to the plain finest-everywhere fine search for the same request. The
//! independent check on `constraints::build` is the existing Python
//! hazard-corpus test suite (`backend/`), unchanged.
//!
//! # Why "finest everywhere" needs no reach-in
//!
//! [`crate::routing::artifact::search`] starts at the finest ladder rung
//! the charts allow and only steps COARSER when a corridor would exceed
//! its cell budget. The §23 regression cases are all single small fixture
//! cells, so the corridor never grows enough to force a coarser rung and
//! the search already sits at `finest_allowed_cell_m`.
//! [`reference_route`] surfaces both figures and
//! [`ReferenceRoute::searched_at_finest`] compares them; a caller asserts
//! it, and a case that ever fails the assertion is one where this module
//! stopped being a valid oracle — a loud test failure, not a silent
//! wrong answer. Nothing here modifies `routing::artifact`.

use crate::model::Cell;
use crate::routing::{artifact_route_lonlat, ArtifactParams, ArtifactRoute, ArtifactWeights};

/// A route from [`reference_route`], plus the facts the regression suite
/// checks beyond the polyline itself.
#[derive(Debug, Clone)]
pub struct ReferenceRoute {
    /// The raw fine-search result — `waypoints`, `distance_m`,
    /// `approximate_legs`, `check_manually_legs`, `diagnostics`.
    pub route: ArtifactRoute,
}

impl ReferenceRoute {
    /// The route's own integrated cost, millimetre fixed-point (§13.1).
    pub fn route_cost_mm(&self) -> i64 {
        self.route.diagnostics.route_cost_mm
    }

    /// Ground metres along the polyline.
    pub fn distance_m(&self) -> f64 {
        self.route.distance_m
    }

    /// Whether §16's exact verifier
    /// ([`crate::routing::raster::verify_route_legs`], run inside the
    /// fine search) confirmed **every** leg clear of the hard-constraint
    /// union. That union is already `lateral_margin_m`- and
    /// CATZOC-buffered and the grid is gated at `required_depth_m`, so a
    /// clean result here subsumes "minimum clearance ≥ margin" and
    /// "minimum depth ≥ required" for a route the search produced —
    /// re-deriving those as separate numeric samples would only re-check
    /// what the buffered union already encodes.
    pub fn legal(&self) -> bool {
        self.route.approximate_legs.iter().all(|&x| !x)
    }

    /// Whether any leg used §9.3 grace (crossed unsurveyed / uncharted
    /// water) or crosses an openable bridge this vessel cannot clear
    /// closed.
    pub fn graced(&self) -> bool {
        self.route.check_manually_legs.iter().any(|&x| x)
    }

    /// The resolution the search actually ran at.
    pub fn cell_size_m(&self) -> f64 {
        self.route.diagnostics.cell_size_m
    }

    /// The finest resolution the source charts allow, independent of
    /// corridor size.
    pub fn finest_allowed_cell_m(&self) -> f64 {
        self.route.diagnostics.finest_allowed_cell_m
    }

    /// The oracle precondition: the search ran at the finest rung, so
    /// nothing was skipped by coarsening. A caller MUST assert this
    /// before treating the route as a reference — see the module docs.
    pub fn searched_at_finest(&self) -> bool {
        (self.cell_size_m() - self.finest_allowed_cell_m()).abs() < 1e-6
    }
}

/// Run the reference solver: [`crate::routing::artifact`]'s fine search
/// over **all** of `cells`, at the same `params` / `weights` the request
/// under test used but with
/// [`ArtifactParams::force_finest_resolution`] forced on regardless of
/// what the caller passed — the whole point of the oracle. `None` when no
/// route exists, or when the finest-everywhere grid would exceed
/// `search::FORCE_FINEST_MAX_DIM` (the region is too large to brute
/// force — a real answer, not a failure).
///
/// A caller that wants to distinguish "no route" from "too large" checks
/// [`ReferenceRoute::searched_at_finest`] is unreachable here (it is
/// always `true` when a route comes back); the `None`-because-too-large
/// case is what a regression case on a big region should treat as
/// "skip / not applicable".
pub fn reference_route(
    cells: &[&Cell],
    from_lonlat: (f64, f64),
    to_lonlat: (f64, f64),
    params: &ArtifactParams,
    weights: &ArtifactWeights,
) -> Option<ReferenceRoute> {
    let forced = ArtifactParams {
        force_finest_resolution: true,
        ..*params
    };
    let route = artifact_route_lonlat(
        from_lonlat.0,
        from_lonlat.1,
        to_lonlat.0,
        to_lonlat.1,
        cells,
        &forced,
        weights,
    )?;
    Some(ReferenceRoute { route })
}
