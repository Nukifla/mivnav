// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Python bindings (`pyo3` feature): the chartcore↔backend bridge. Everything
//! touching decrypted chart data runs in-process here, so the decoded cell
//! model never crosses the daemon→client named pipe (see [`crate::oex`]).
//! Besides tiling it exposes the auto-routing surface — [`HazardIndex`],
//! `shortest_path`, `routing_corridor_bbox`, `macro_route`, `graph_route`
//! (see [`crate::routing`]).

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use pyo3::create_exception;
use pyo3::exceptions::{PyException, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};

use crate::coords::LLBox;
use crate::model;
use crate::mvt::decode::decode_tile;
use crate::mvt::{CellTiler, ScaminBias};
use crate::oex::{ChartKind, OexConfig, OexControl, OexError, OexState};
use crate::osenc::{self, OsencError};
use crate::s52::{self, S52Data};

create_exception!(
    chartcore,
    ChartError,
    PyException,
    "Chart decode/serve error."
);
create_exception!(
    chartcore,
    DecryptError,
    ChartError,
    "oexserverd refused to decrypt: invalid key or unregistered system fingerprint."
);
create_exception!(chartcore, ExpiredError, ChartError, "Chart expired.");
create_exception!(
    chartcore,
    DaemonError,
    ChartError,
    "oexserverd unavailable or misbehaving."
);

/// Upper bound on `serve_tile`'s cut `parallelism`; backend's
/// `OchartsConfig.parallelism` validates the same ceiling. A thread count
/// for one tile's cut fan-out, not a concurrent-request limit.
const PARALLELISM_MAX: usize = 16;

fn oex_err(e: OexError) -> PyErr {
    DaemonError::new_err(e.to_string())
}

fn osenc_err(e: OsencError) -> PyErr {
    match e {
        OsencError::Decrypt(_) => DecryptError::new_err(e.to_string()),
        OsencError::Expired(_) => ExpiredError::new_err(e.to_string()),
        // A daemon response-stream timeout surfaces here as a plain io::Error
        // — route it to DaemonError (retry-able) rather than a permanent
        // per-cell decode error.
        OsencError::Io(ref io_err) if io_err.kind() == std::io::ErrorKind::TimedOut => {
            DaemonError::new_err(e.to_string())
        }
        _ => ChartError::new_err(e.to_string()),
    }
}

fn state_str(s: OexState) -> &'static str {
    match s {
        OexState::Unknown => "unknown",
        OexState::Starting => "starting",
        OexState::Running => "running",
        OexState::Error => "error",
    }
}

/// Supervised `oexserverd` instance (see [`crate::oex::OexControl`]).
#[pyclass(module = "chartcore")]
struct Daemon {
    control: OexControl,
}

#[pymethods]
impl Daemon {
    /// `daemon`: path to the `oexserverd` executable (see `ensure_daemon`).
    /// `work_dir`: private directory for per-request response pipes.
    #[new]
    #[pyo3(signature = (daemon, work_dir, request_pipe=None, debug=false))]
    fn new(
        daemon: PathBuf,
        work_dir: PathBuf,
        request_pipe: Option<PathBuf>,
        debug: bool,
    ) -> PyResult<Daemon> {
        let mut config = OexConfig::new(daemon, work_dir);
        if let Some(pipe) = request_pipe {
            config.request_pipe = pipe;
        }
        config.debug = debug;
        let control = OexControl::new(config).map_err(|e| DaemonError::new_err(e.to_string()))?;
        Ok(Daemon { control })
    }

    /// Request daemon start (asynchronous; poll `state()` or use
    /// `wait_for_state`).
    fn start(&self) {
        self.control.start();
    }

    fn stop(&self) {
        self.control.stop();
    }

    /// Stop, then start again — the only recovery from the "error" state.
    fn restart(&self, py: Python<'_>) {
        py.detach(|| self.control.restart());
    }

    /// One of "unknown" / "starting" / "running" / "error".
    fn state(&self) -> &'static str {
        state_str(self.control.state())
    }

    fn last_error(&self) -> Option<String> {
        self.control.last_error()
    }

    /// Captured daemon stdout/stderr (bounded).
    fn log(&self) -> Vec<String> {
        self.control.log()
    }

    /// Block until the state equals `state`; False on timeout.
    fn wait_for_state(&self, py: Python<'_>, state: &str, timeout: f64) -> PyResult<bool> {
        let want = match state {
            "unknown" => OexState::Unknown,
            "starting" => OexState::Starting,
            "running" => OexState::Running,
            "error" => OexState::Error,
            _ => return Err(PyValueError::new_err(format!("unknown state {state:?}"))),
        };
        Ok(py.detach(|| {
            self.control
                .wait_for_state(want, Duration::from_secs_f64(timeout))
        }))
    }
}

/// Loaded S-52 lookup tables ([`crate::s52`]) for ATON symbol resolution.
/// Immutable — load once per process, share across every `Cell.open`.
#[pyclass(module = "chartcore", frozen)]
struct S52 {
    data: S52Data,
}

#[pymethods]
impl S52 {
    /// Load lookups from `chartsymbols.xml`, or a directory with optional
    /// `*Patch*.xml` overlays (the CLI's `--s52-data` semantics).
    #[staticmethod]
    fn load(py: Python<'_>, path: PathBuf) -> PyResult<S52> {
        let data = py.detach(|| s52::load(&path)).map_err(|e| {
            ChartError::new_err(format!("loading S-52 data {}: {e}", path.display()))
        })?;
        if data.is_empty() {
            return Err(ChartError::new_err(format!(
                "no S-52 lookups in {}",
                path.display()
            )));
        }
        Ok(S52 { data })
    }

    #[getter]
    fn lookup_count(&self) -> usize {
        self.data.len()
    }
}

/// The git-ignored S-52 data cache, shared with the CLI's `--fetch-s52` —
/// the backend's last-resort lookup location.
#[pyfunction]
fn s52_default_cache_dir() -> String {
    s52::default_cache_dir().to_string_lossy().into_owned()
}

/// Rough heap footprint of a decoded cell AND its tiler, for the backend's
/// RAM budget.
///
/// Calibrated against RSS (#MEM-GATE): the previous estimate charged 8 bytes
/// per vertex (a `WorldXy` is two f64s — 16; a sounding `PointZ` is 24) and
/// ignored the tiler's precomputed per-feature MVT tags, which clone the
/// render-relevant attributes as `(String, TagValue)` pairs. Measured on the
/// real DE/NL/DK union (a 128-cell low-zoom tile, cells cached, heap trimmed)
/// it reported 383 MB for ~665 MB of real RSS — so a 1 GiB `cell_budget`
/// really held ~1.75 GiB. The tag clone is charged at the attribute cost
/// (an upper bound: `attr_tags` only ever drops keys, never adds), and the
/// per-feature constant is fitted to measured RSS (see below).
fn cell_bytes(cell: &model::Cell) -> u64 {
    use std::mem::size_of;
    let xy = size_of::<crate::coords::WorldXy>() as u64;
    let pz = size_of::<model::PointZ>() as u64;
    let mut total = 0u64;
    for f in &cell.features {
        // Per-feature fixed cost: the `Feature` struct, its `BTreeMap` nodes,
        // the tiler's per-feature tag `Vec`, `derive`'s additions and the
        // allocator's per-chunk overhead. Fitted, not derived: after the
        // vertex/tag terms below, a residual of 690-785 bytes per feature
        // remained, consistently across the NL, DE and DK sets (60 cells
        // each, heap trimmed before and after loading) — was 160.
        total += 900;
        total += f.acronym.len() as u64;
        let mut attrs = 0u64;
        for (k, v) in &f.attributes {
            attrs += 64 + k.len() as u64;
            attrs += match v {
                model::AttrValue::Str(s) => s.len() as u64 + 24,
                model::AttrValue::StrList(l) => l.iter().map(|s| s.len() as u64 + 24).sum(),
                _ => 16,
            };
        }
        // The attributes themselves, plus the tiler's tag clone of them.
        total += 2 * attrs + 24;
        if let Some(g) = &f.geometry {
            total += 48
                + match g {
                    model::Geometry::Point(_) => xy,
                    model::Geometry::MultiPoint(p) => p.len() as u64 * pz,
                    model::Geometry::Lines(ls) => {
                        ls.iter().map(|l| l.len() as u64 * xy + 24).sum::<u64>()
                    }
                    model::Geometry::Areas(polys) => polys
                        .iter()
                        .map(|p| {
                            p.outer.len() as u64 * xy
                                + p.holes
                                    .iter()
                                    .map(|h| h.len() as u64 * xy + 24)
                                    .sum::<u64>()
                                + 48
                        })
                        .sum(),
                };
        }
    }
    total
}

/// Rough heap footprint of a `HazardIndex`'s rings, for the backend's
/// hazard-cache RAM budget — same order-of-magnitude style as `cell_bytes`
/// above, scaled down to just the ring points a `HazardIndex` actually
/// holds (no feature/attribute overhead: `build_hazard_index` already threw
/// that away).
fn hazard_bytes(idx: &crate::routing::HazardIndex) -> u64 {
    let points: usize = idx.rings.iter().map(Vec::len).sum();
    points as u64 * 8 + idx.rings.len() as u64 * 48 + 64
}

fn open_stream(
    daemon: Option<&Daemon>,
    path: &Path,
    key: &str,
    header_only: bool,
) -> PyResult<Box<dyn std::io::Read + Send>> {
    crate::oex::open_chart_stream(daemon.map(|d| &d.control), path, key, header_only)
        .map_err(oex_err)
}

/// An opened chart cell: decoded feature model + derived facts + a ready
/// tile cutter, all in RAM. Immutable once constructed; `cut` is pure.
#[pyclass(module = "chartcore", frozen)]
struct Cell {
    // `CellTiler` OWNS the decoded `model::Cell`, so no self-reference and no
    // unsafe. `frozen` (no &mut) + `Sync` means it's freely shareable, which
    // is what lets the serve path cut concurrently.
    tiler: CellTiler,
    approx_bytes: u64,
    feature_count: usize,
}

#[pymethods]
impl Cell {
    /// Open and fully decode a chart cell. Plain files read directly;
    /// encrypted `.oesu`/`.oesenc` go through `daemon` with `key`. Without
    /// `s52`, ATON `sym_s`/`lbl_*` stay absent (documented graceful skip).
    #[staticmethod]
    #[pyo3(signature = (path, key="", daemon=None, s52=None))]
    fn open(
        py: Python<'_>,
        path: PathBuf,
        key: &str,
        daemon: Option<PyRef<'_, Daemon>>,
        s52: Option<PyRef<'_, S52>>,
    ) -> PyResult<Cell> {
        let daemon = daemon.as_deref();
        let s52 = s52.as_deref();
        py.detach(|| {
            let stream = open_stream(daemon, &path, key, false)?;
            let mut cell = osenc::read_cell(stream).map_err(osenc_err)?;
            crate::derive::apply_with(&mut cell, s52.map(|s| &s.data));
            let approx_bytes = cell_bytes(&cell);
            let feature_count = cell.features.len();
            Ok(Cell {
                tiler: CellTiler::new(cell),
                approx_bytes,
                feature_count,
            })
        })
    }

    #[getter]
    fn name(&self) -> &str {
        &self.tiler.cell().meta.name
    }

    #[getter]
    fn edition(&self) -> u32 {
        self.tiler.cell().meta.edition
    }

    #[getter]
    fn update(&self) -> u32 {
        self.tiler.cell().meta.update
    }

    /// Compilation scale denominator, e.g. 12000 for 1:12000.
    #[getter]
    fn scale(&self) -> u32 {
        self.tiler.cell().meta.compilation_scale
    }

    /// Estimated resident bytes of the decoded model (RAM budget input).
    #[getter]
    fn approx_bytes(&self) -> u64 {
        self.approx_bytes
    }

    #[getter]
    fn feature_count(&self) -> usize {
        self.feature_count
    }

    /// The MVT cut of tile z/x/y, or None if empty. `finer` masks this
    /// cell's geometry wherever already-selected finer cells chart it, so
    /// one cell is authoritative per region (`chartcore::mvt::mask`).
    #[pyo3(signature = (z, x, y, finer=None))]
    fn cut(
        &self,
        py: Python<'_>,
        z: u8,
        x: u32,
        y: u32,
        finer: Option<Vec<PyRef<'_, Coverage>>>,
    ) -> Option<Py<PyBytes>> {
        let finer: Vec<&crate::coverage::Coverage> =
            finer.iter().flatten().map(|c| &c.inner).collect();
        let data = py.detach(|| self.tiler.cut_with(z, x, y, &finer))?;
        Some(PyBytes::new(py, &data).unbind())
    }

    /// The unsafe-water polygon for this cell at `safety_depth_m`
    /// (metres, chart datum — land, shoals shallower than this, charted
    /// hazards, entry-prohibited areas), buffered outward by
    /// `margin_m` of real clearance, plus `BRIDGE`/`CBLOHD` vertical
    /// obstructions the boat's own `air_draft_m` (mast height above the
    /// waterline, metres) cannot clear. `None` when nothing in this cell is
    /// unsafe at that depth/margin/air-draft. `air_draft_m=0.0` (the
    /// default) means no air-draft checking at all — byte-identical to
    /// this method before that feature existed. See
    /// `crate::routing::hazards` for exactly what counts and why the list
    /// stays deliberately narrow — this reads only facts `open`'s derive
    /// pass already computed, the same way `cut` does; nothing here
    /// re-touches raw S-57 attributes.
    #[pyo3(signature = (safety_depth_m, margin_m=0.0, air_draft_m=0.0))]
    fn hazard_index(
        &self,
        py: Python<'_>,
        safety_depth_m: f64,
        margin_m: f64,
        air_draft_m: f64,
    ) -> Option<HazardIndex> {
        py.detach(|| {
            crate::routing::build_hazard_index(
                self.tiler.cell(),
                safety_depth_m,
                margin_m,
                air_draft_m,
            )
        })
        .map(|inner| HazardIndex { inner })
    }

    /// [`build_land_only_hazard_index`](crate::routing::build_land_only_hazard_index):
    /// this cell's `LNDARE`/`UNSARE`/`SLCONS` union ALONE, buffered by
    /// `margin_m` — no depth/wreck/entry-restricted/air-draft hazard mixed
    /// in, and no `safety_depth_m`/`air_draft_m` parameter at all, since
    /// none of the three classes are gated by either. For
    /// `hazard_indexes_for_bbox` (`mivnav.features.routing.hazards`) to
    /// union in WITHOUT ever authority-clipping it — see that Rust
    /// function's own docs (its module's "Authority-clipping exemption for
    /// land" section) for the real bug this exists to close: a coarser
    /// chart's correct coastline silently erased along a thin strip
    /// wherever a finer chart's coverage overlapped ground that finer
    /// chart never itself re-digitized as land.
    #[pyo3(signature = (margin_m=0.0))]
    fn land_hazard_index(&self, py: Python<'_>, margin_m: f64) -> Option<HazardIndex> {
        py.detach(|| crate::routing::build_land_only_hazard_index(self.tiler.cell(), margin_m))
            .map(|inner| HazardIndex { inner })
    }

    /// The TSS-family "prefer to avoid" ring union for this cell —
    /// traffic lanes, roundabouts, crossings, precautionary areas.
    /// UNBUFFERED (no `margin_m`, unlike `hazard_index`): a legal-to-
    /// cross preference zone has no clearance margin of its own the way
    /// a charted hazard does. `None` when this cell charts none of those
    /// classes. See `crate::routing::preference` for exactly which
    /// classes and why (deliberately not the inshore traffic zone).
    fn tss_union(&self, py: Python<'_>) -> Option<HazardIndex> {
        py.detach(|| crate::routing::build_tss_union(self.tiler.cell()))
            .map(|inner| HazardIndex { inner })
    }

    /// The preferred-route "prefer if it connects" ring union for this
    /// cell — `FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT`, unioned into ONE set
    /// (`crate::routing::preference`'s own docs have the full reasoning
    /// for folding all four into one union/weight rather than one per
    /// class). Same unbuffered-for-area reasoning as `tss_union`; a
    /// line-charted `NAVLNE`/`RECTRC` gets a small fixed buffer instead —
    /// see `crate::routing::hazards::push_preferred_route_geometry`.
    /// `None` when this cell charts none of the four. Method name kept as
    /// `fairway_union` (not renamed to something like
    /// `preferred_route_union`) so the Python call site
    /// (`mivnav.features.routing.hazards.preference_indexes_for_line`)
    /// needed no change for this broadened scope.
    fn fairway_union(&self, py: Python<'_>) -> Option<HazardIndex> {
        py.detach(|| crate::routing::build_preferred_route_union(self.tiler.cell()))
            .map(|inner| HazardIndex { inner })
    }

    /// The "don't linger over/anchor near this" soft-avoid ring union for
    /// this cell — `CBLSUB` (submarine cable), `PIPSOL` (submarine
    /// pipeline). UNBUFFERED-when-Area/nominally-buffered-when-Point-or-
    /// Line, same convention as `tss_union`/`fairway_union` — neither
    /// class ever charts Area geometry, so this is always nominally
    /// buffered in practice. `None` when this cell charts neither class.
    /// See `crate::routing::preference::build_cable_union`'s own docs
    /// (and `CABLE_AVOID_CLASSES`'s, for why this is a SEPARATE weight
    /// from `caution_union` below rather than one shared dial).
    fn cable_union(&self, py: Python<'_>) -> Option<HazardIndex> {
        py.detach(|| crate::routing::build_cable_union(self.tiler.cell()))
            .map(|inner| HazardIndex { inner })
    }

    /// The "navigate with general caution" soft-avoid ring union for this
    /// cell — `ACHARE`/`CTNARE`, plus any `RESARE`/`MIPARE` NOT already
    /// hard-blocked by `Cell.hazard_index(...)`'s own entry-prohibited
    /// check (`RESTRN` containing `7`) — see
    /// `crate::routing::preference::build_caution_union`'s own docs for
    /// the full "never both, never neither" composition rule between this
    /// and `hazard_index`. `None` when this cell charts none of them.
    fn caution_union(&self, py: Python<'_>) -> Option<HazardIndex> {
        py.detach(|| crate::routing::build_caution_union(self.tiler.cell()))
            .map(|inner| HazardIndex { inner })
    }

    /// The low-confidence-survey soft-avoid ring union for this cell — the
    /// union of every `M_QUAL` zone whose `CATZOC` reads as C, D, or U (or
    /// carries no `CATZOC` at all — see
    /// `crate::routing::preference::build_low_confidence_survey_union`'s
    /// own docs for the CATZOC threshold and why a CATZOC-less zone counts
    /// too). UNBUFFERED, same convention as `tss_union`/`fairway_union`/
    /// `cable_union`/`caution_union` — `M_QUAL` is Area-only per the real
    /// S-57 catalogue, so no point/line buffering path is ever exercised.
    /// `None` when this cell charts no `M_QUAL` at all, or only zones at or
    /// above grade B.
    fn survey_union(&self, py: Python<'_>) -> Option<HazardIndex> {
        py.detach(|| crate::routing::build_low_confidence_survey_union(self.tiler.cell()))
            .map(|inner| HazardIndex { inner })
    }

    /// The `UNSARE` (unsurveyed area) ring union for this cell ALONE — NOT
    /// the same object `survey_union` returns, even though `UNSARE`
    /// contributes to that union too (see
    /// `crate::routing::preference::build_unsurveyed_union`'s own docs for
    /// why this stays a separate method): `survey_union` is what feeds
    /// `RoutingConfig.low_confidence_survey_avoidance_weight`'s COST term,
    /// this is the purely informational ring set
    /// `mivnav.features.routing.hazards.check_manually_indexes_for_bbox`
    /// runs an already-decided route's own exact legs against
    /// (`chartcore.verify_route`, ALONGSIDE `openable_bridge_union`'s own
    /// rings — the two share one flag) to flag "crosses unsurveyed water,
    /// check manually" (`PlanResponse.check_manually_legs`/
    /// `VerifyResponse.check_manually_legs`). UNBUFFERED, same convention
    /// as `survey_union`. `None` when this cell charts no `UNSARE` at all.
    fn unsurveyed_union(&self, py: Python<'_>) -> Option<HazardIndex> {
        py.detach(|| crate::routing::build_unsurveyed_union(self.tiler.cell()))
            .map(|inner| HazardIndex { inner })
    }

    /// Every `BRIDGE` this boat cannot clear CLOSED but whose `CATBRG`
    /// says it can open — `crate::routing::build_openable_bridge_union`'s
    /// own docs have the full reasoning: NOT the same object
    /// `Cell.hazard_index(...)`'s own air-draft check returns (an openable
    /// bridge is deliberately excluded from THAT hard union), the other
    /// half of the same "check manually" informational tier
    /// `unsurveyed_union` belongs to. `air_draft_m <= 0.0` => always
    /// `None`, mirroring `hazard_index`'s own air-draft gate.
    fn openable_bridge_union(&self, py: Python<'_>, air_draft_m: f64) -> Option<HazardIndex> {
        py.detach(|| crate::routing::build_openable_bridge_union(self.tiler.cell(), air_draft_m))
            .map(|inner| HazardIndex { inner })
    }

    /// The "wrong side of a lateral mark" penalty ring union for this
    /// cell, given the straight `(from_lon, from_lat)` -> `(to_lon,
    /// to_lat)` reference bearing the whole request is judged against —
    /// see `crate::routing::buoyage` for what "wrong side" means and why
    /// it needs a direction of travel at all, unlike `tss_union`/
    /// `fairway_union`. `region` is `"A"`/`"B"` (case-sensitive,
    /// `mivnav.features.routing.config.RoutingConfig.iala_region`'s own
    /// wire shape); anything else is treated as `"A"`, the more common
    /// region and this project's own default — a config-validation
    /// concern the Python side's `Literal["A", "B"]` field already
    /// enforces before this is ever called, not a case this needs to
    /// reject. `None` when this cell charts no classifiable lateral mark
    /// near the route, or when `from == to`.
    #[pyo3(signature = (from_lon, from_lat, to_lon, to_lat, region, radius_m))]
    #[allow(clippy::too_many_arguments)]
    fn buoyage_penalty(
        &self,
        py: Python<'_>,
        from_lon: f64,
        from_lat: f64,
        to_lon: f64,
        to_lat: f64,
        region: &str,
        radius_m: f64,
    ) -> Option<HazardIndex> {
        let from = crate::coords::lat_lon_to_world(from_lat, from_lon);
        let to = crate::coords::lat_lon_to_world(to_lat, to_lon);
        let region = parse_iala_region(region);
        py.detach(|| {
            crate::routing::build_buoyage_penalty(self.tiler.cell(), from, to, region, radius_m)
        })
        .map(|inner| HazardIndex { inner })
    }

    /// The IALA region (`"A"`/`"B"`) this cell's own charted `M_NSYS`
    /// meta-object declares, or `None` when it charts none — most cells
    /// don't. `mivnav.features.routing.hazards` scans every candidate
    /// cell for the first non-`None` answer, falling back to
    /// `RoutingConfig.iala_region` when none has one. See
    /// `crate::routing::buoyage::resolve_region`.
    fn iala_region(&self) -> Option<&'static str> {
        crate::routing::resolve_iala_region(self.tiler.cell()).map(|r| match r {
            crate::routing::IalaRegion::A => "A",
            crate::routing::IalaRegion::B => "B",
        })
    }

    /// A precomputed, depth-independent distance-to-nearest-land-hazard
    /// field over this cell's own full extent, buffered outward by
    /// `margin_m` — see `crate::routing::raster::bake`'s own module docs
    /// for what this is, why it exists standalone (not wired into the
    /// live search — a smaller fix elsewhere closed the specific gap it
    /// was built to investigate), and its self-limiting rule. `None` when
    /// this cell charts no depth-independent hazard at all, or is too
    /// large for a per-cell bake to be worth anything (that module's own
    /// docs).
    fn build_land_hazard_bake(&self, py: Python<'_>, margin_m: f64) -> Option<LandHazardBake> {
        py.detach(|| crate::routing::CellHazardBake::build(self.tiler.cell(), margin_m))
            .map(|inner| LandHazardBake { inner })
    }
}

/// `"A"`/`"B"` (case-sensitive) -> [`crate::routing::IalaRegion`],
/// defaulting anything else to `A` — see `Cell::buoyage_penalty`'s own
/// docs for why a permissive default, not an error, is right here.
fn parse_iala_region(s: &str) -> crate::routing::IalaRegion {
    match s {
        "B" => crate::routing::IalaRegion::B,
        _ => crate::routing::IalaRegion::A,
    }
}

fn llbox_tuple(b: &LLBox) -> (f64, f64, f64, f64) {
    (b.w_lon, b.s_lat, b.e_lon, b.n_lat)
}

/// Header-only cell identification (name/edition/update/scale/extent). Uses
/// the header-only daemon command for encrypted cells — cheap enough for
/// startup scans of a whole chart set.
#[pyfunction]
#[pyo3(signature = (path, key="", daemon=None))]
fn read_header<'py>(
    py: Python<'py>,
    path: PathBuf,
    key: &str,
    daemon: Option<PyRef<'py, Daemon>>,
) -> PyResult<Bound<'py, PyDict>> {
    let daemon_ref = daemon.as_deref();
    let header = py.detach(|| {
        let stream = open_stream(daemon_ref, &path, key, true)?;
        osenc::read_header(stream).map_err(osenc_err)
    })?;
    let d = PyDict::new(py);
    d.set_item("name", &header.meta.name)?;
    d.set_item("edition", header.meta.edition)?;
    d.set_item("update", header.meta.update)?;
    d.set_item("scale", header.meta.compilation_scale)?;
    d.set_item("extent", llbox_tuple(&header.extent))?;
    // None means no M_COVR records — absence of shape info, not "charts
    // nothing" — so the caller falls back to the extent rectangle.
    d.set_item(
        "coverage",
        header
            .coverage
            .map(|inner| Py::new(py, Coverage { inner }))
            .transpose()?,
    )?;
    Ok(d)
}

/// A cell's true data coverage — where it actually charts, as opposed to
/// the rectangle it declares ([`crate::coverage`]). Handed out by
/// [`read_header`] so the serving path can decide before decoding.
#[pyclass(module = "chartcore", frozen)]
struct Coverage {
    inner: crate::coverage::Coverage,
}

#[pymethods]
impl Coverage {
    /// How much of tile z/x/y this cell charts: `"none"`/`"partial"`/`"full"`.
    /// `"none"` means the cell must not be decoded for this tile; `"full"`
    /// means no coarser cell can add anything there.
    fn tile_state(&self, z: u8, x: u32, y: u32) -> &'static str {
        match crate::mvt::coverage_tile_state(&self.inner, z, x, y) {
            crate::mvt::TileState::Uncovered => "none",
            crate::mvt::TileState::Partial => "partial",
            crate::mvt::TileState::Full => "full",
        }
    }

    /// Does this cell keep ground in tile z/x/y that `finer` (already-selected
    /// finer coverages) doesn't already chart? Conservative toward keeping:
    /// reports no-residual only when finer provably covers it all.
    fn has_residual_in_tile(&self, finer: Vec<PyRef<'_, Coverage>>, z: u8, x: u32, y: u32) -> bool {
        let finer: Vec<&crate::coverage::Coverage> = finer.iter().map(|c| &c.inner).collect();
        crate::mvt::coverage_has_residual_in_tile(&self.inner, &finer, z, x, y)
    }

    /// (w, s, e, n) degrees bounding every coverage ring — a superset of
    /// the coverage, never a statement about the area it bounds.
    fn extent(&self) -> (f64, f64, f64, f64) {
        let e = &self.inner.extent;
        (
            crate::coords::worldx_to_lon(e.xmin),
            crate::coords::worldy_to_lat(e.ymax),
            crate::coords::worldx_to_lon(e.xmax),
            crate::coords::worldy_to_lat(e.ymin),
        )
    }

    #[getter]
    fn ring_count(&self) -> usize {
        self.inner.rings.len()
    }

    /// Every coverage ring as `[(lon, lat), …]`, for the DEBUG coverage
    /// overlay (GeoJSON). Not on the serve path — that uses `tile_state` /
    /// `has_residual_in_tile`.
    fn rings_lonlat(&self) -> Vec<Vec<(f64, f64)>> {
        self.inner
            .rings
            .iter()
            .map(|ring| {
                ring.iter()
                    .map(|p| {
                        (
                            crate::coords::worldx_to_lon(p.x),
                            crate::coords::worldy_to_lat(p.y),
                        )
                    })
                    .collect()
            })
            .collect()
    }

    fn __repr__(&self) -> String {
        let (w, s, e, n) = self.extent();
        format!(
            "<Coverage {} rings, extent ({w:.4}, {s:.4}, {e:.4}, {n:.4})>",
            self.inner.rings.len()
        )
    }
}

/// A cell's unsafe-water polygon at one safety depth and clearance margin
/// (`crate::routing::hazards`) — everything a router must not cross.
/// Handed out by [`Cell::hazard_index`]. Opaque and immutable, same
/// posture as [`Coverage`]: the rings stay in Rust, Python only asks
/// narrow questions (today: is this point unsafe; later: a search
/// algorithm's own opaque queries land here too, not raw ring access).
#[pyclass(module = "chartcore", frozen)]
struct HazardIndex {
    inner: crate::routing::HazardIndex,
}

#[pymethods]
impl HazardIndex {
    /// (w, s, e, n) degrees bounding every hazard ring.
    fn extent(&self) -> (f64, f64, f64, f64) {
        let e = &self.inner.extent;
        (
            crate::coords::worldx_to_lon(e.xmin),
            crate::coords::worldy_to_lat(e.ymax),
            crate::coords::worldx_to_lon(e.xmax),
            crate::coords::worldy_to_lat(e.ymin),
        )
    }

    #[getter]
    fn ring_count(&self) -> usize {
        self.inner.rings.len()
    }

    /// Rough heap footprint, for the backend's hazard-cache RAM budget
    /// (`OchartsService.hazards`, a `SingleFlightLRU` keyed on cell +
    /// safety depth + margin) — same role `Cell.approx_bytes` plays for
    /// the decoded-cell cache.
    #[getter]
    fn approx_bytes(&self) -> u64 {
        hazard_bytes(&self.inner)
    }

    /// Is `(lon, lat)` unsafe to sail into — land, too shallow, a charted
    /// hazard, or entry-prohibited, at the depth/margin this index was
    /// built for?
    ///
    /// The one query today's straight-line `POST /routing/plan`
    /// placeholder (`mivnav.features.routing`) already has a use for:
    /// flag a route that crosses charted danger before the real
    /// hazard-avoiding search exists to route around it outright. The
    /// same primitive a grid or visibility-graph search needs for point
    /// classification / segment testing, so it is exposed now rather than
    /// only alongside the search that will lean on it harder.
    fn contains(&self, lon: f64, lat: f64) -> bool {
        let p = crate::coords::lat_lon_to_world(lat, lon);
        crate::routing::hazard_contains(&self.inner, p)
    }

    /// Every hazard ring as a `[(lon, lat), …]` polyline, for a DEBUG
    /// overlay — mirrors `Coverage.rings_lonlat`. Not on any serve path.
    fn rings_lonlat(&self) -> Vec<Vec<(f64, f64)>> {
        self.inner
            .rings
            .iter()
            .map(|ring| {
                ring.iter()
                    .map(|p| {
                        (
                            crate::coords::worldx_to_lon(p.x),
                            crate::coords::worldy_to_lat(p.y),
                        )
                    })
                    .collect()
            })
            .collect()
    }

    /// Remove any ground already charted by a MORE DETAILED chart —
    /// `finer_coverages`, one or more other candidate cells' own
    /// [`Coverage`] (their real charted extent, `Cell.open`'s header
    /// `coverage` field — cheap, no decode). `None` when `finer_coverages`
    /// is empty (nothing to clip against — the same object is the answer;
    /// a caller should skip this call entirely in that case rather than
    /// pay for a no-op) or when the finer charts vouch for the whole
    /// hazard. See `crate::routing::hazards::clip_to_authority`'s own docs
    /// for the real bug this exists for — a coarse overview chart's
    /// simplified coastline silently overriding an accurate harbour-scale
    /// chart's "this is open water" for the same ground, because the
    /// hazard union used to just union every overlapping chart with no
    /// regard for which one is actually authoritative there.
    fn clipped_to_authority(
        &self,
        py: Python<'_>,
        finer_coverages: Vec<PyRef<'_, Coverage>>,
    ) -> Option<HazardIndex> {
        let rings: Vec<Vec<crate::coords::WorldXy>> = finer_coverages
            .iter()
            .flat_map(|c| c.inner.rings.iter().cloned())
            .collect();
        py.detach(|| crate::routing::clip_to_authority(&self.inner, &rings))
            .map(|inner| HazardIndex { inner })
    }

    fn __repr__(&self) -> String {
        let (w, s, e, n) = self.extent();
        format!(
            "<HazardIndex {} rings, extent ({w:.4}, {s:.4}, {e:.4}, {n:.4})>",
            self.inner.rings.len()
        )
    }
}

/// Rough heap footprint of a [`LandHazardBake`]'s own distance field —
/// same "estimate the actual resident size" role `hazard_bytes`/
/// `cell_bytes` play for their own caches.
fn land_bake_bytes(bake: &crate::routing::CellHazardBake) -> u64 {
    bake.approx_bytes()
}

/// A precomputed, depth-independent distance-to-nearest-land-hazard field
/// over one chart cell's own full extent (`crate::routing::raster::bake`).
/// Handed out by [`Cell::build_land_hazard_bake`]. Opaque and immutable,
/// same posture as [`HazardIndex`]: the field stays in Rust, Python only
/// asks narrow questions.
#[pyclass(module = "chartcore", frozen)]
struct LandHazardBake {
    inner: crate::routing::CellHazardBake,
}

#[pymethods]
impl LandHazardBake {
    /// (w, s, e, n) degrees — the cell's own extent this bake covers.
    fn extent(&self) -> (f64, f64, f64, f64) {
        self.inner.extent_lonlat()
    }

    #[getter]
    fn cell_size_m(&self) -> f64 {
        self.inner.cell_size_m()
    }

    #[getter]
    fn dims(&self) -> (u32, u32) {
        self.inner.dims()
    }

    /// Rough heap footprint, for the backend's own RAM budget
    /// (`OchartsService.land_bakes`, a `SingleFlightLRU` keyed on cell +
    /// margin — deliberately NOT depth, see this bake's own docs).
    #[getter]
    fn approx_bytes(&self) -> u64 {
        land_bake_bytes(&self.inner)
    }

    /// Distance in real ground metres from `(lon, lat)` to the nearest
    /// baked land hazard.
    fn dist_m(&self, lon: f64, lat: f64) -> f64 {
        self.inner.dist_m(lon, lat)
    }

    /// The minimum baked distance (ground metres) anywhere inside the
    /// `(west, south, east, north)` degrees box — a coarse "how close does
    /// charted land get in this smaller box" query cropped from the
    /// already-built field, with no re-rasterizing. `None` when the box
    /// doesn't overlap this bake's own extent at all.
    fn min_dist_m_in_box(&self, west: f64, south: f64, east: f64, north: f64) -> Option<f64> {
        self.inner.min_dist_m_in_box(west, south, east, north)
    }

    fn __repr__(&self) -> String {
        let (w, s, e, n) = self.extent();
        let (cols, rows) = self.dims();
        format!(
            "<LandHazardBake {cols}x{rows} @ {:.2}m/cell, extent ({w:.4}, {s:.4}, {e:.4}, {n:.4})>",
            self.cell_size_m()
        )
    }
}

/// A found hazard-avoiding path (`crate::routing::raster::shortest_path`):
/// waypoints in `(lon, lat)` order from start to end inclusive, total
/// length in metres, and diagnostics from the search itself. Handed out by
/// [`shortest_path`].
#[pyclass(module = "chartcore", frozen)]
struct RoutePath {
    inner: crate::routing::RoutePath,
}

#[pymethods]
impl RoutePath {
    #[getter]
    fn waypoints(&self) -> Vec<(f64, f64)> {
        self.inner.waypoints.clone()
    }

    #[getter]
    fn distance_m(&self) -> f64 {
        self.inner.distance_m
    }

    /// One entry per LEG (`waypoints[i]` -> `waypoints[i+1]`,
    /// `len(waypoints) - 1` entries): `True` where that leg is a
    /// straight-line stand-in rather than an exactly-verified result —
    /// the true start/end itself unreachable (inside the hazard union,
    /// or no real path connects at all), OR any OTHER leg the final
    /// route-wide verification pass couldn't confirm exact at this
    /// grid's own resolution — see
    /// `crate::routing::raster::shortest_path_weighted`'s own docs for
    /// the mechanism and why it checks every leg, not just the ends.
    /// Every entry `False` is the ordinary, fully-exact case.
    #[getter]
    fn approximate_legs(&self) -> Vec<bool> {
        self.inner.approximate_legs.clone()
    }

    /// `True` when `from`/`to` had nothing in the way and the raster grid
    /// was never touched — the fast path, and the common case.
    #[getter]
    fn used_direct_line(&self) -> bool {
        self.inner.diagnostics.used_direct_line
    }

    /// `(cols, rows)` of the search grid, or `(0, 0)` on the direct-line
    /// fast path.
    #[getter]
    fn grid_dims(&self) -> (u32, u32) {
        (
            self.inner.diagnostics.grid_cols,
            self.inner.diagnostics.grid_rows,
        )
    }

    #[getter]
    fn cell_size_m(&self) -> f64 {
        self.inner.diagnostics.cell_size_m
    }

    #[getter]
    fn blocked_cells(&self) -> u32 {
        self.inner.diagnostics.blocked_cells
    }

    #[getter]
    fn nodes_expanded(&self) -> u32 {
        self.inner.diagnostics.nodes_expanded
    }

    /// How many corridor-widening retries the winning search attempt
    /// needed — 0 on the common case (the tight first corridor found a
    /// path).
    #[getter]
    fn corridor_widen_attempts(&self) -> u32 {
        self.inner.diagnostics.corridor_widen_attempts
    }

    fn __repr__(&self) -> String {
        let n_approx = self.inner.approximate_legs.iter().filter(|&&a| a).count();
        let approx = if n_approx == 0 {
            String::new()
        } else {
            format!(", {n_approx} approximate leg(s)")
        };
        format!(
            "<RoutePath {} waypoints, {:.0}m{approx}>",
            self.inner.waypoints.len(),
            self.inner.distance_m
        )
    }
}

/// The shortest hazard-avoiding path from `(from_lon, from_lat)` to
/// `(to_lon, to_lat)` — routed as far as the search honestly can reach
/// even when the start or end itself sits inside a hazard, or no real
/// path connects them at any corridor size tried, with a straight line
/// stitched on for whatever it couldn't reach or verify (`RoutePath.
/// approximate_legs` says which leg(s) — not only the first/last).
/// `None` only in the genuinely pathological case where no water at all
/// exists to route
/// through near either point. See `crate::routing::raster`'s module docs
/// for exactly what this does and does not check.
///
/// `hazard_indexes` are the [`HazardIndex`]es of every cell the route
/// might cross, concatenated internally rather than re-unioned — a
/// correct input for a route spanning several cells; rasterization only
/// needs area membership per grid cell, which a flat concatenated ring set
/// gives for free.
///
/// Releases the GIL: rasterizing a bounded grid and running A* over it is
/// comfortably sub-second on real fixtures
/// (`chartcore/tests/routing_de6ostim.rs`), but no reason to hold the GIL
/// for it.
///
/// `shallow_avoidance_radius_m`/`shallow_avoidance_weight`,
/// `lateral_margin_radius_m`, `tss_indexes`/`tss_avoidance_weight`,
/// `fairway_indexes`/`fairway_preference_weight` (built from `Cell.
/// fairway_union()` — despite the name, the UNIONED `FAIRWY`/`RECTRC`/
/// `NAVLNE`/`DWRTPT` preferred-route family, not `FAIRWY` alone; see
/// `crate::routing::preference`'s own docs for why all four share one
/// union and one weight), `buoyage_indexes`/`buoyage_avoidance_weight`,
/// `cable_indexes`/`cable_avoidance_weight` (built from `Cell.
/// cable_union()` — `CBLSUB`/`PIPSOL`), `caution_indexes`/
/// `caution_area_avoidance_weight` (built from `Cell.caution_union()` —
/// `ACHARE`/`CTNARE` plus permitted-transit `RESARE`/`MIPARE`; see
/// `crate::routing::preference`'s own docs for why cable and caution are
/// two SEPARATE weights rather than one shared dial), and `survey_indexes`/
/// `low_confidence_survey_avoidance_weight` (built from `Cell.
/// survey_union()` — a low-confidence `M_QUAL`/`CATZOC` zone) each default
/// to
/// `0.0`/`[]`
/// — OFF, byte-identical to calling `crate::routing::shortest_path`
/// directly (matching `RoutingConfig`'s own defaults,
/// `mivnav.features.routing.config`) — see
/// `crate::routing::raster::shortest_path_weighted`'s own docs for what
/// turning any of them on changes. `lateral_margin_radius_m` has no
/// matching `_weight` param — unlike every other preference here it is
/// not user-tunable, only its reach is (see `LATERAL_MARGIN_PREFERENCE_
/// WEIGHT`'s own docs in `raster.rs`); `hazard_indexes` itself is
/// expected to already be buffered by a small, fixed HARD floor only
/// (`mivnav.features.routing.routes`'s `_HARD_LATERAL_FLOOR_M`), not the
/// caller's full preferred margin — that preferred margin belongs here
/// instead. `tss_indexes`/`fairway_indexes`/`cable_indexes`/
/// `caution_indexes`/`survey_indexes` are `HazardIndex`es the same way
/// `hazard_indexes` is,
/// but built via `Cell.tss_union()`/`Cell.fairway_union()`/
/// `Cell.cable_union()`/`Cell.caution_union()`/`Cell.survey_union()`
/// instead of
/// `Cell.hazard_index(...)`; `buoyage_indexes` likewise, via
/// `Cell.buoyage_penalty(...)`.
///
/// `turn_cost_weight` — unlike every other preference above, it has no
/// matching ring set: it charges a per-heading-change cost DURING the
/// search itself (`crate::routing::raster::search_grid_with_turn_cost`),
/// not a zone/distance term over charted geometry, so there is nothing
/// for it to intersect against. `0.0` (the default) is OFF, byte-
/// identical to every call before this parameter existed — see that
/// function's own docs for the state-space expansion this turns on, its
/// real measured cost, and the admissibility argument for why it needs
/// no heuristic change.
///
/// `theta_star` — `false` by default, byte-identical to every call before
/// this parameter existed. Switches the search to an any-angle Lazy
/// Theta* (`crate::routing::raster::search_grid_theta_star`) instead of
/// the plain grid search, but ONLY when every preference weight above is
/// off — with any of them nonzero this silently falls back to the
/// ordinary weighted search rather than erroring, and wins over
/// `turn_cost_weight` if both are somehow set. See that function's own
/// docs for the full mechanism and why composing it with a soft
/// preference or turn cost is deliberately out of scope this round.
#[pyfunction]
#[pyo3(signature = (
    from_lon, from_lat, to_lon, to_lat, hazard_indexes,
    shallow_avoidance_radius_m=0.0, shallow_avoidance_weight=0.0,
    lateral_margin_radius_m=0.0,
    tss_indexes=vec![], tss_avoidance_weight=0.0,
    fairway_indexes=vec![], fairway_preference_weight=0.0,
    buoyage_indexes=vec![], buoyage_avoidance_weight=0.0,
    cable_indexes=vec![], cable_avoidance_weight=0.0,
    caution_indexes=vec![], caution_area_avoidance_weight=0.0,
    survey_indexes=vec![], low_confidence_survey_avoidance_weight=0.0,
    turn_cost_weight=0.0,
    theta_star=false,
))]
#[allow(clippy::too_many_arguments)]
fn shortest_path(
    py: Python<'_>,
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    hazard_indexes: Vec<PyRef<'_, HazardIndex>>,
    shallow_avoidance_radius_m: f64,
    shallow_avoidance_weight: f64,
    lateral_margin_radius_m: f64,
    tss_indexes: Vec<PyRef<'_, HazardIndex>>,
    tss_avoidance_weight: f64,
    fairway_indexes: Vec<PyRef<'_, HazardIndex>>,
    fairway_preference_weight: f64,
    buoyage_indexes: Vec<PyRef<'_, HazardIndex>>,
    buoyage_avoidance_weight: f64,
    cable_indexes: Vec<PyRef<'_, HazardIndex>>,
    cable_avoidance_weight: f64,
    caution_indexes: Vec<PyRef<'_, HazardIndex>>,
    caution_area_avoidance_weight: f64,
    survey_indexes: Vec<PyRef<'_, HazardIndex>>,
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    theta_star: bool,
) -> Option<RoutePath> {
    let from = crate::coords::lat_lon_to_world(from_lat, from_lon);
    let to = crate::coords::lat_lon_to_world(to_lat, to_lon);
    let flatten = |idxs: &[PyRef<'_, HazardIndex>]| -> Vec<Vec<crate::coords::WorldXy>> {
        idxs.iter()
            .flat_map(|idx| idx.inner.rings.iter().cloned())
            .collect()
    };
    let rings = flatten(&hazard_indexes);
    let tss_rings = flatten(&tss_indexes);
    let fairway_rings = flatten(&fairway_indexes);
    let buoyage_rings = flatten(&buoyage_indexes);
    let cable_rings = flatten(&cable_indexes);
    let caution_rings = flatten(&caution_indexes);
    let survey_rings = flatten(&survey_indexes);
    py.detach(|| {
        crate::routing::shortest_path_weighted(
            from,
            to,
            &rings,
            shallow_avoidance_radius_m,
            shallow_avoidance_weight,
            lateral_margin_radius_m,
            &tss_rings,
            tss_avoidance_weight,
            &fairway_rings,
            fairway_preference_weight,
            &buoyage_rings,
            buoyage_avoidance_weight,
            &cable_rings,
            cable_avoidance_weight,
            &caution_rings,
            caution_area_avoidance_weight,
            &survey_rings,
            low_confidence_survey_avoidance_weight,
            turn_cost_weight,
            theta_star,
        )
    })
    .map(|inner| RoutePath { inner })
}

/// One more exact, geometry-only shortcut + re-verify pass over an
/// ALREADY-ASSEMBLED waypoint chain (`waypoints`, `(lon, lat)` pairs, in
/// order) — for `mivnav.features.routing.routes._stitch_macro_route`,
/// whose own several independent `shortest_path` calls (one per
/// consecutive macro-waypoint pair) get concatenated in PYTHON, a real
/// waypoint boundary no single `shortest_path` call, and no in-crate
/// caller of `crate::routing::raster::resimplify_and_reverify`, ever
/// sees. See that function's own docs for the real bug this exists for
/// (#owqqcdqe, 2026-08-10) — the SAME mechanism `shortest_path` already
/// applies internally across its own spliced-in refinements, exposed here
/// so a caller that assembles a route across SEVERAL separate
/// `shortest_path` calls can apply it too, once, over the whole thing.
///
/// `hazard_indexes` should be the UNION relevant to the whole chain —
/// concatenating every sub-leg's own candidate indexes is correct (same
/// "flat concatenation, no re-union needed" reasoning `shortest_path`'s
/// own docs already state for rasterization-only membership tests).
///
/// `None` when `waypoints` has fewer than 2 points — nothing to simplify,
/// and the real callers of this (`_stitch_macro_route`) never have fewer
/// than that; every OTHER input, even two identical points, gets a real
/// (possibly single-leg) `RoutePath` back.
#[pyfunction]
fn resimplify_route(
    waypoints: Vec<(f64, f64)>,
    hazard_indexes: Vec<PyRef<'_, HazardIndex>>,
) -> Option<RoutePath> {
    if waypoints.len() < 2 {
        return None;
    }
    let rings: Vec<Vec<crate::coords::WorldXy>> = hazard_indexes
        .iter()
        .flat_map(|idx| idx.inner.rings.iter().cloned())
        .collect();
    let diagnostics = crate::routing::RouteDiagnostics {
        used_direct_line: false,
        grid_cols: 0,
        grid_rows: 0,
        cell_size_m: 0.0,
        blocked_cells: 0,
        nodes_expanded: 0,
        corridor_widen_attempts: 0,
    };
    Some(RoutePath {
        inner: crate::routing::raster::resimplify_and_reverify(&waypoints, &rings, diagnostics),
    })
}

/// Exact per-leg hazard check over a waypoint chain the caller supplies
/// AS-IS — no search, no [`simplify_path`] shortcutting, no waypoint
/// dropped or added. One `bool` per LEG (`waypoints.len() - 1`), `True`
/// where that exact straight segment crosses `hazard_indexes`' own union
/// at whatever `safety_depth_m`/`margin_m`/`air_draft_m` those indexes
/// were already built at (the caller's job, same as every other entry
/// point here — see [`shortest_path`]'s own docs for why depth/margin
/// live in the index, not this call).
///
/// For `mivnav.features.routing.routes`' standalone route-safety-check
/// endpoint: a user drew (or already has) a route this app never
/// searched, and wants to know which legs of THAT EXACT route cross
/// charted danger — deliberately NOT [`resimplify_route`], whose own
/// [`simplify_path`] pass can drop a user's own waypoint wherever a later
/// one is directly visible, which would silently renumber the legs a
/// caller asked about. A flagged leg here is never a hedge the way
/// [`RoutePath::approximate_legs`] sometimes is for a SEARCHED route —
/// nothing here was ever rasterized, so [`verify_legs`]'s own geometry
/// check is the whole answer, not an approximation of one.
///
/// `force_start`/`force_end` are both always `false` — unlike
/// `resimplify_and_reverify`'s internal callers, there is no already-known
/// "this endpoint was itself a forced stub" fact to defend in depth for
/// here; every leg gets the same, ordinary, exact geometry check.
///
/// `waypoints` are `(lon, lat)`, matching [`shortest_path`]'s and
/// [`resimplify_route`]'s own convention. Empty on fewer than 2
/// waypoints — same "nothing to check" case [`resimplify_route`] returns
/// `None` for, just shaped as an empty `Vec<bool>` instead since there is
/// no route object to omit here.
#[pyfunction]
fn verify_route(
    waypoints: Vec<(f64, f64)>,
    hazard_indexes: Vec<PyRef<'_, HazardIndex>>,
) -> Vec<bool> {
    let rings: Vec<Vec<crate::coords::WorldXy>> = hazard_indexes
        .iter()
        .flat_map(|idx| idx.inner.rings.iter().cloned())
        .collect();
    crate::routing::raster::verify_route_legs(&waypoints, &rings)
}

/// `resimplify_route`'s more capable sibling: for the SAME already-
/// assembled `(waypoints, approximate_legs)` chain, RE-SEARCHES every
/// still-flagged run for a real detour (same mechanism `shortest_path`
/// already applies internally via `refine_flagged_legs`) before doing the
/// same final geometric resimplify pass — not just a shortcut collapse.
///
/// Why this is what `mivnav.features.routing.routes._stitch_macro_route`
/// actually needs, not `resimplify_route` alone (#owqqcdqe, 2026-08-10,
/// found live, the second half of the same bug): a pure geometric
/// shortcut pass can only DROP an existing waypoint when two OTHER
/// existing waypoints already see each other directly — it can never
/// propose a genuinely NEW bend point. A macro-stitch seam flagged
/// because BOTH adjacent sub-legs independently hit a real, small, local
/// hazard right at their shared macro waypoint (found live: a shallow
/// spot at the tip of a real headland) needs an actual RE-SEARCH of that
/// stretch to find the small real detour around it.
///
/// `waypoints.len()` must be `approximate_legs.len() + 1` — a caller
/// mistake here (not a routing outcome) raises rather than panicking
/// across the pyo3 boundary. Preference weights/rings all default to
/// `0.0`/`[]`, matching every other weighted entry point in this module.
#[pyfunction]
#[pyo3(signature = (
    waypoints, approximate_legs, hazard_indexes,
    shallow_avoidance_radius_m=0.0, shallow_avoidance_weight=0.0,
    lateral_margin_radius_m=0.0,
    tss_indexes=vec![], tss_avoidance_weight=0.0,
    fairway_indexes=vec![], fairway_preference_weight=0.0,
    buoyage_indexes=vec![], buoyage_avoidance_weight=0.0,
    cable_indexes=vec![], cable_avoidance_weight=0.0,
    caution_indexes=vec![], caution_area_avoidance_weight=0.0,
    survey_indexes=vec![], low_confidence_survey_avoidance_weight=0.0,
    turn_cost_weight=0.0,
    theta_star=false,
))]
#[allow(clippy::too_many_arguments)]
fn refine_route(
    waypoints: Vec<(f64, f64)>,
    approximate_legs: Vec<bool>,
    hazard_indexes: Vec<PyRef<'_, HazardIndex>>,
    shallow_avoidance_radius_m: f64,
    shallow_avoidance_weight: f64,
    lateral_margin_radius_m: f64,
    tss_indexes: Vec<PyRef<'_, HazardIndex>>,
    tss_avoidance_weight: f64,
    fairway_indexes: Vec<PyRef<'_, HazardIndex>>,
    fairway_preference_weight: f64,
    buoyage_indexes: Vec<PyRef<'_, HazardIndex>>,
    buoyage_avoidance_weight: f64,
    cable_indexes: Vec<PyRef<'_, HazardIndex>>,
    cable_avoidance_weight: f64,
    caution_indexes: Vec<PyRef<'_, HazardIndex>>,
    caution_area_avoidance_weight: f64,
    survey_indexes: Vec<PyRef<'_, HazardIndex>>,
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    theta_star: bool,
) -> PyResult<RoutePath> {
    if waypoints.len() != approximate_legs.len() + 1 {
        return Err(pyo3::exceptions::PyValueError::new_err(format!(
            "refine_route: {} waypoints needs exactly {} approximate_legs, got {}",
            waypoints.len(),
            waypoints.len().saturating_sub(1),
            approximate_legs.len()
        )));
    }
    let flatten = |idxs: &[PyRef<'_, HazardIndex>]| -> Vec<Vec<crate::coords::WorldXy>> {
        idxs.iter()
            .flat_map(|idx| idx.inner.rings.iter().cloned())
            .collect()
    };
    let rings = flatten(&hazard_indexes);
    let tss_rings = flatten(&tss_indexes);
    let fairway_rings = flatten(&fairway_indexes);
    let buoyage_rings = flatten(&buoyage_indexes);
    let cable_rings = flatten(&cable_indexes);
    let caution_rings = flatten(&caution_indexes);
    let survey_rings = flatten(&survey_indexes);
    Ok(RoutePath {
        inner: crate::routing::raster::refine_stitched_route(
            waypoints,
            approximate_legs,
            &rings,
            shallow_avoidance_radius_m,
            shallow_avoidance_weight,
            lateral_margin_radius_m,
            &tss_rings,
            tss_avoidance_weight,
            &fairway_rings,
            fairway_preference_weight,
            &buoyage_rings,
            buoyage_avoidance_weight,
            &cable_rings,
            cable_avoidance_weight,
            &caution_rings,
            caution_area_avoidance_weight,
            &survey_rings,
            low_confidence_survey_avoidance_weight,
            turn_cost_weight,
            theta_star,
        ),
    })
}

/// The lon/lat area `shortest_path(from_lon, from_lat, to_lon, to_lat,
/// ...)` might actually search — `(w, s, e, n)` degrees, same convention
/// `HazardIndex.extent` uses. A candidate-hazard-cell selection (e.g.
/// `mivnav.features.routing.hazards._candidate_cells`) should bound itself
/// to this box rather than a separately-tuned pad around the line's own
/// span, so the two stay in sync as the search's own corridor sizing
/// changes — see `crate::routing::raster::corridor_bbox_lonlat`'s docs.
#[pyfunction]
fn routing_corridor_bbox(
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
) -> (f64, f64, f64, f64) {
    let from = crate::coords::lat_lon_to_world(from_lat, from_lon);
    let to = crate::coords::lat_lon_to_world(to_lat, to_lon);
    crate::routing::corridor_bbox_lonlat(from, to)
}

/// A coarse, land-only topological path over a MUCH larger area than
/// [`shortest_path`] ever searches — for the case even that function's own
/// per-leg refinement cannot reach at all: a real detour around a whole
/// landmass, entirely outside its corridor's own reach by construction
/// (e.g. the only water connection between two points on either side of a
/// peninsula runs via a channel a hundred-plus nm off the direct line).
/// See `crate::routing::raster::macro_route`'s own docs for the full
/// mechanism, and `ROUTING_TODO.md`'s Limfjord entry for the real request
/// that motivated this.
///
/// `land_indexes` are [`HazardIndex`]es built LAND-ONLY — the same
/// `Cell.hazard_index(safety_depth_m, margin_m)` call every other hazard
/// index uses, called with `safety_depth_m=0.0, margin_m=0.0` so only
/// LNDARE (plus anything charted as always-dry) contributes, not the
/// draft-dependent DEPARE/DRGARE shallow-water union a real request uses
/// — draft is the FINE per-leg re-search's question, not this coarse
/// topology pass's.
///
/// `extra_land_rings` are additional land polygon EXTERIOR rings as plain
/// `[(lon, lat), ...]` lists, unioned in alongside `land_indexes` — for
/// land truth OUTSIDE any installed chart's own coverage. Found live, not
/// hypothetical: with nothing here, a macro request wandering past the
/// edge of the boat's installed chart set sees a total absence of hazard
/// rings in the gap (no chart there = nothing to select, not "unknown"),
/// which this coarse pass — asking only "where is the land" — reads as
/// open water, and drew a real macro path straight across tens of km of
/// dry, populated land with no chart to catch it. The caller
/// (`mivnav.features.routing.hazards`) supplies these from the bundled
/// Natural Earth Admin-0 country polygons (`mivnav.geo.countries`) —
/// chart-independent, global, and small enough to filter and pass on
/// every macro attempt. Exterior rings only (no interior/hole rings): a
/// lone, unpaired ring's own interior is exact under nonzero-winding
/// fill regardless of which way it winds (see [`rasterize`]'s own docs),
/// so dropping holes trades a bounded, minor over-caution near a large
/// lake for never risking an inverted (open ↔ closed) hole-pairing bug —
/// a right trade for a land source whose whole job is never being
/// false-CLOSED that mistakenly, but even worse, never false-OPEN either.
///
/// Returns `None` when no macro-scale path exists either — the caller's
/// existing straight-line-with-a-warning fallback stays the honest
/// answer. A returned waypoint chain is a coarse GUIDE, not a route to
/// sail as-is: re-run [`shortest_path`] leg by leg along it for the real,
/// safe, draft-aware path (see `macro_route`'s own docs for why this is
/// by design, not an oversight).
///
/// Releases the GIL for the same reason [`shortest_path`] does.
#[pyfunction]
#[pyo3(signature = (from_lon, from_lat, to_lon, to_lat, land_indexes, extra_land_rings=vec![], box_pad_m=250_000.0, cell_size_m=300.0, max_dim=800))]
#[allow(clippy::too_many_arguments)]
fn macro_route(
    py: Python<'_>,
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    land_indexes: Vec<PyRef<'_, HazardIndex>>,
    extra_land_rings: Vec<Vec<(f64, f64)>>,
    box_pad_m: f64,
    cell_size_m: f64,
    max_dim: u32,
) -> Option<Vec<(f64, f64)>> {
    let from = crate::coords::lat_lon_to_world(from_lat, from_lon);
    let to = crate::coords::lat_lon_to_world(to_lat, to_lon);
    let mut land_rings: Vec<Vec<crate::coords::WorldXy>> = land_indexes
        .iter()
        .flat_map(|idx| idx.inner.rings.iter().cloned())
        .collect();
    land_rings.extend(extra_land_rings.iter().map(|ring| {
        ring.iter()
            .map(|&(lon, lat)| crate::coords::lat_lon_to_world(lat, lon))
            .collect()
    }));
    py.detach(|| {
        crate::routing::macro_route(from, to, &land_rings, box_pad_m, cell_size_m, max_dim)
    })
}

/// A found path over [`graph_route`]'s adaptive graph: waypoints in
/// `(lon, lat)` order, start to end inclusive, and total length in real
/// ground metres. See `crate::routing::raster::graph::GraphRoute`'s own
/// docs for what this is and deliberately is not.
#[pyclass(module = "chartcore", frozen)]
struct GraphRoute {
    inner: crate::routing::GraphRoute,
}

#[pymethods]
impl GraphRoute {
    #[getter]
    fn waypoints(&self) -> Vec<(f64, f64)> {
        self.inner.waypoints.clone()
    }

    #[getter]
    fn distance_m(&self) -> f64 {
        self.inner.distance_m
    }

    fn __repr__(&self) -> String {
        format!(
            "<GraphRoute {} waypoints, {:.0}m>",
            self.inner.waypoints.len(),
            self.inner.distance_m
        )
    }
}

/// The ADAPTIVE-GRAPH search — a second, structurally different routing
/// algorithm from [`shortest_path`]'s uniform raster grid, modelled on
/// signalk-routeiq's own documented approach (see
/// `crate::routing::raster::graph`'s own module docs for the mechanism
/// and the three deliberate simplifications from a literal port, stated
/// there, not here, so there is one place this gets out of date rather
/// than two).
///
/// `hazard_indexes` is the same HARD safety union [`shortest_path`] takes
/// (draft/margin already baked in). `fairway_indexes`/`tss_indexes`/
/// `buoyage_indexes` are the SAME soft-preference ring sets
/// [`shortest_path`]'s own optional layers take too — `fairway_indexes`
/// carries the same unioned `FAIRWY`/`RECTRC`/`NAVLNE`/`DWRTPT`
/// preferred-route family `Cell.fairway_union()` now builds, not `FAIRWY`
/// alone. This function reuses them as flat zone-membership multipliers
/// (RouteIQ's own documented
/// `fairwayMultiplier` et al.), not [`shortest_path`]'s distance-graded
/// `CostModel`; see the module docs for why. `min_clearance_m` is a
/// vessel's own beam-based hard constraint (half beam plus whatever
/// margin the caller wants, already combined).
///
/// Unlike `shortest_path`, this has no partial/"as close as it can get"
/// fallback of its own: `None` when either endpoint is itself unsafe, or
/// no path connects them within this search's own node/edge budget — the
/// caller's existing straight-line-with-a-warning fallback is still the
/// honest answer in that case.
///
/// Releases the GIL for the same reason `shortest_path` does.
#[pyfunction]
#[pyo3(signature = (
    from_lon, from_lat, to_lon, to_lat, hazard_indexes,
    fairway_indexes=vec![], tss_indexes=vec![], buoyage_indexes=vec![],
    min_clearance_m=0.0,
))]
#[allow(clippy::too_many_arguments)]
fn graph_route(
    py: Python<'_>,
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    hazard_indexes: Vec<PyRef<'_, HazardIndex>>,
    fairway_indexes: Vec<PyRef<'_, HazardIndex>>,
    tss_indexes: Vec<PyRef<'_, HazardIndex>>,
    buoyage_indexes: Vec<PyRef<'_, HazardIndex>>,
    min_clearance_m: f64,
) -> Option<GraphRoute> {
    let from = crate::coords::lat_lon_to_world(from_lat, from_lon);
    let to = crate::coords::lat_lon_to_world(to_lat, to_lon);
    let flatten = |idxs: &[PyRef<'_, HazardIndex>]| -> Vec<Vec<crate::coords::WorldXy>> {
        idxs.iter()
            .flat_map(|idx| idx.inner.rings.iter().cloned())
            .collect()
    };
    let hazard_rings = flatten(&hazard_indexes);
    let fairway_rings = flatten(&fairway_indexes);
    let tss_rings = flatten(&tss_indexes);
    let buoyage_rings = flatten(&buoyage_indexes);
    py.detach(|| {
        crate::routing::graph_route(
            from,
            to,
            &hazard_rings,
            &fairway_rings,
            &tss_rings,
            &buoyage_rings,
            min_clearance_m,
        )
    })
    .map(|inner| GraphRoute { inner })
}

/// A found route from the `"artifact"` algorithm
/// (`crate::routing::artifact`) — the v3 architecture's own model:
/// a much wider hard-constraint feature set, `CATZOC` as a real
/// horizontal buffer and depth allowance, §9.3 endpoint grace, a
/// source-driven resolution ladder, and deterministic integer costs.
/// Handed out by [`artifact_route`].
#[pyclass(module = "chartcore", frozen)]
struct ArtifactRoute {
    inner: crate::routing::ArtifactRoute,
}

#[pymethods]
impl ArtifactRoute {
    /// `(lon, lat)` pairs, start to end inclusive. BOTH ends are grid
    /// CELL CENTRES, not the requested points — v3 §13.1's canonical
    /// endpoint snapping, which is what makes two nearby clicks produce
    /// the same route. `start_snap_m`/`end_snap_m` say how far that
    /// moved them.
    #[getter]
    fn waypoints(&self) -> Vec<(f64, f64)> {
        self.inner.waypoints.clone()
    }

    #[getter]
    fn distance_m(&self) -> f64 {
        self.inner.distance_m
    }

    /// One entry per LEG (`len(waypoints) - 1`): `True` where the EXACT
    /// verifier — `crate::routing::raster::verify_route_legs`, the same
    /// function [`verify_route`] and `POST /routing/verify` already use,
    /// reused unmodified — could not confirm that leg clear of the hard
    /// constraint union. Same meaning as `RoutePath.approximate_legs`.
    #[getter]
    fn approximate_legs(&self) -> Vec<bool> {
        self.inner.approximate_legs.clone()
    }

    /// One entry per LEG, same shape/order: `True` where the leg used
    /// §9.3 endpoint grace (crossed unsurveyed or uncharted water within
    /// the grace radius of a requested endpoint), or crosses an openable
    /// `BRIDGE` this boat cannot clear closed. Same meaning as
    /// `PlanResponse.check_manually_legs` — never a reason the route was
    /// shaped or refused, always a "a human should look at this leg".
    #[getter]
    fn check_manually_legs(&self) -> Vec<bool> {
        self.inner.check_manually_legs.clone()
    }

    /// Ground metres between the REQUESTED start and `waypoints[0]` —
    /// §9.3's "report the snap distance". Nonzero even for a perfectly
    /// navigable start, by up to half a grid diagonal, because of the
    /// canonical endpoint snapping above.
    #[getter]
    fn start_snap_m(&self) -> f64 {
        self.inner.start_snap_m
    }

    /// The same, for the destination.
    #[getter]
    fn end_snap_m(&self) -> f64 {
        self.inner.end_snap_m
    }

    #[getter]
    fn grid_dims(&self) -> (u32, u32) {
        (
            self.inner.diagnostics.grid_cols,
            self.inner.diagnostics.grid_rows,
        )
    }

    /// The resolution actually searched at, metres per cell.
    #[getter]
    fn cell_size_m(&self) -> f64 {
        self.inner.diagnostics.cell_size_m
    }

    /// The §4.2 ladder rung chosen for this corridor
    /// (`{2,4,8,16,32,64,128,256,1024}` metres), before the grid's own
    /// cell budget could force anything coarser.
    #[getter]
    fn ladder_cell_m(&self) -> f64 {
        self.inner.diagnostics.ladder_cell_m
    }

    /// §4.1's `finest_allowed_cell` for these charts —
    /// `max(2m, scale/2000, catzoc_horizontal/4)`, ladder-snapped. What
    /// the SOURCE allows, independent of corridor size: the first number
    /// to look at when a channel is inexplicably closed.
    #[getter]
    fn finest_allowed_cell_m(&self) -> f64 {
        self.inner.diagnostics.finest_allowed_cell_m
    }

    /// The coarsest §3.4 CATZOC horizontal figure over the `M_QUAL`
    /// zones consulted, AFTER the mode scaling — i.e. how far hard
    /// hazards were actually grown, in metres.
    #[getter]
    fn catzoc_horizontal_m(&self) -> f64 {
        self.inner.diagnostics.catzoc_horizontal_m
    }

    /// The finest compilation-scale denominator over the cells consulted
    /// (1:12 000 -> 12000); `0` when none recorded one.
    #[getter]
    fn compilation_scale(&self) -> u32 {
        self.inner.diagnostics.compilation_scale
    }

    #[getter]
    fn blocked_cells(&self) -> u32 {
        self.inner.diagnostics.blocked_cells
    }

    /// Grid cells that are UNKNOWN water — `UNSARE`, or outside every
    /// cell's `M_COVR` coverage. Blocking unless graced.
    #[getter]
    fn unknown_cells(&self) -> u32 {
        self.inner.diagnostics.unknown_cells
    }

    #[getter]
    fn nodes_expanded(&self) -> u32 {
        self.inner.diagnostics.nodes_expanded
    }

    #[getter]
    fn corridor_widen_attempts(&self) -> u32 {
        self.inner.diagnostics.corridor_widen_attempts
    }

    /// The route's own integrated cost in INTEGER millimetre-equivalents
    /// (v3 §13.1's fixed-point accumulation). Reported, never compared to
    /// a bound — this algorithm makes no optimality claim (§14 is out of
    /// scope; see the Rust module docs).
    #[getter]
    fn route_cost_mm(&self) -> i64 {
        self.inner.diagnostics.route_cost_mm
    }

    fn __repr__(&self) -> String {
        let n_approx = self.inner.approximate_legs.iter().filter(|&&a| a).count();
        let n_manual = self
            .inner
            .check_manually_legs
            .iter()
            .filter(|&&a| a)
            .count();
        format!(
            "<ArtifactRoute {} waypoints, {:.0}m, {:.0}m/cell, {n_approx} approximate, {n_manual} check-manually>",
            self.inner.waypoints.len(),
            self.inner.distance_m,
            self.inner.diagnostics.cell_size_m,
        )
    }
}

/// The `"artifact"` algorithm — the FOURTH `routing.algorithm` entry,
/// alongside `raster`/`routeiq`/`graph`, implementing
/// `mivnav_routing_architecture_v3.md`'s own hard-constraint model. See
/// `crate::routing::artifact`'s module docs for exactly which parts of
/// that architecture are in and out of scope (the persisted `.mivnav`
/// artifact, the depth-band ladder, the portal topology and directional
/// transitions are all OUT).
///
/// Unlike [`shortest_path`]/[`graph_route`], this takes decoded
/// **`Cell`s**, not prebuilt [`HazardIndex`]es: the whole point of the
/// algorithm is that it re-derives chart truth itself with a wider class
/// list (`PONTON`/`FLODOC`/`HULKES`/`DAMCON`/`DYKCON`/`CAUSWY`/`PILPNT`/
/// `MORFAC`/`GATCON`, `SOUNDG`, `PIPOHD`/`CONVYR`, `RESARE` `RESTRN=8`,
/// `MARCUL`/`FSHFAC`, `UNSARE`, absent `M_COVR`), and with a per-feature
/// `CATZOC` buffer that no existing `HazardIndex` carries. Pass every
/// cell the corridor might cross — `routing_corridor_bbox` gives the box
/// to select them by, exactly as for `shortest_path`.
///
/// The three `artifact_*` options are this algorithm's own new config
/// surface:
///
/// * `endpoint_grace_radius_m` (§9.3, default `150.0`) — how far from
///   the REQUESTED start/destination the first and last legs may cross
///   UNKNOWN water (`UNSARE` or uncharted). Never land, never a
///   construction feature, never a depth or hazard block. `0.0` disables
///   grace entirely.
/// * `catzoc_allowance_mode` (§3.4, default `"full"`) — one of
///   `"full"`, `"half"`, `"depth_only"`, `"off"`. `"full"` applies the
///   whole table (A1 +-5m, A2 +-20m, B +-50m, C +-500m, D/U/absent
///   +-1000m horizontal; 0.50m+1%, 1.00m+2%, 1.00m+2%, 2.00m+5%,
///   2.00m+5% of depth). Anything unrecognised falls back to `"full"`,
///   the strictest — a typo must never silently weaken a hard
///   constraint. **`"full"` on charts with no `M_QUAL` at all buffers
///   every hazard by a kilometre**, which is v3 §25 open decision #1
///   working as specified, not a bug; `"half"`/`"depth_only"`/`"off"`
///   exist for that.
/// * `allow_restricted_entry` (§3.3, default `False`) — releases
///   `RESARE`/`MIPARE` `RESTRN=8` (entry restricted), `MARCUL` and
///   `FSHFAC` together, down to a soft-avoid cost. NEVER releases
///   `RESTRN=7` (entry prohibited).
///
/// `required_depth_m` is `draft + under_keel_margin_m` already combined
/// (the same convention `Cell.hazard_index`'s `safety_depth_m` uses);
/// `required_air_draft_m` is mast height, `0.0` = no overhead check at
/// all; `lateral_margin_m` is buffered onto every hard feature as a HARD
/// wall here (unlike the `raster` algorithm, where it is deliberately a
/// soft preference — pass `0.0` if you want that behaviour). The six
/// weights are the existing shared `RoutingConfig` dials, all defaulting
/// to `0.0`/off. There is no shallow-water, lateral-clearance or buoyage
/// term: those need machinery this MVP does not have (see the module
/// docs).
///
/// `None` when no path exists within the corridor ladder, or when an
/// endpoint is blocked and no navigable cell lies within the grace
/// radius. There is no partial "get as close as you can" fallback — the
/// caller's existing straight-line-with-a-warning path stays the honest
/// answer, the same scope call [`graph_route`] makes.
///
/// Releases the GIL for the same reason [`shortest_path`] does.
#[pyfunction]
#[pyo3(signature = (
    from_lon, from_lat, to_lon, to_lat, cells,
    required_depth_m,
    required_air_draft_m=0.0,
    lateral_margin_m=0.0,
    endpoint_grace_radius_m=150.0,
    catzoc_allowance_mode="full",
    allow_restricted_entry=false,
    tss_avoidance_weight=0.0,
    fairway_preference_weight=0.0,
    cable_avoidance_weight=0.0,
    caution_area_avoidance_weight=0.0,
    low_confidence_survey_avoidance_weight=0.0,
    turn_cost_weight=0.0,
    avoid_depth_m=0.0,
    soft_prefer_depth_m=0.0,
    avoid_depth_weight=0.0,
    prefer_depth_weight=0.0,
))]
#[allow(clippy::too_many_arguments)]
fn artifact_route(
    py: Python<'_>,
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    cells: Vec<PyRef<'_, Cell>>,
    required_depth_m: f64,
    required_air_draft_m: f64,
    lateral_margin_m: f64,
    endpoint_grace_radius_m: f64,
    catzoc_allowance_mode: &str,
    allow_restricted_entry: bool,
    tss_avoidance_weight: f64,
    fairway_preference_weight: f64,
    cable_avoidance_weight: f64,
    caution_area_avoidance_weight: f64,
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    avoid_depth_m: f64,
    soft_prefer_depth_m: f64,
    avoid_depth_weight: f64,
    prefer_depth_weight: f64,
) -> Option<ArtifactRoute> {
    let params = crate::routing::ArtifactParams {
        required_depth_m,
        avoid_depth_m,
        soft_prefer_depth_m,
        required_air_draft_m,
        lateral_margin_m,
        endpoint_grace_radius_m,
        catzoc_mode: crate::routing::CatzocMode::parse(catzoc_allowance_mode),
        allow_restricted_entry,
        // Never on for a served route — the finest-everywhere brute force
        // is a test oracle only (`crate::mivnav::reference_route`).
        force_finest_resolution: false,
    };
    let weights = crate::routing::ArtifactWeights {
        tss_avoidance_weight,
        fairway_preference_weight,
        cable_avoidance_weight,
        caution_area_avoidance_weight,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        avoid_depth_weight,
        prefer_depth_weight,
    };
    // Borrow the decoded models out of the `frozen` (and therefore
    // `Sync`) `Cell` pyclasses BEFORE detaching — `&crate::model::Cell`
    // is what crosses the GIL boundary, never the `PyRef` itself.
    let models: Vec<&crate::model::Cell> = cells.iter().map(|c| c.tiler.cell()).collect();
    py.detach(|| {
        crate::routing::artifact_route_lonlat(
            from_lon, from_lat, to_lon, to_lat, &models, &params, &weights,
        )
    })
    .map(|inner| ArtifactRoute { inner })
}

/// The debug-overlay bundle for one `"artifact"`/`"mivnav"` fine-search
/// request: the constraint set that would be built (every ring class, as
/// `[lon, lat]` pairs), and what the search would do with it — most
/// importantly WHICH of its failure points fired on a no-route request
/// (`reason`: `"ok"` / `"no_field"` / `"start_blocked"` / `"goal_blocked"`
/// / `"severed"` / `"grid_too_large"`), plus a per-cell raster of the
/// search grid (`field.codes`: `0` open · `1` hard · `2` unknown-blocked ·
/// `3` unknown-graced · `4` soft-penalised).
///
/// Opt-in debug payload only (`PlanRequest.debug`); the ring lists run to
/// tens of thousands of points on a real Danish corridor. Never on a
/// served route. Same `ArtifactParams`/`ArtifactWeights` as
/// [`artifact_route`] so it profiles the identical search.
#[pyfunction]
#[pyo3(signature = (
    from_lon, from_lat, to_lon, to_lat, cells,
    required_depth_m,
    required_air_draft_m=0.0,
    lateral_margin_m=0.0,
    endpoint_grace_radius_m=150.0,
    catzoc_allowance_mode="full",
    allow_restricted_entry=false,
    tss_avoidance_weight=0.0,
    fairway_preference_weight=0.0,
    cable_avoidance_weight=0.0,
    caution_area_avoidance_weight=0.0,
    low_confidence_survey_avoidance_weight=0.0,
    turn_cost_weight=0.0,
    avoid_depth_m=0.0,
    soft_prefer_depth_m=0.0,
    avoid_depth_weight=0.0,
    prefer_depth_weight=0.0,
))]
#[allow(clippy::too_many_arguments)]
fn artifact_route_debug<'py>(
    py: Python<'py>,
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    cells: Vec<PyRef<'_, Cell>>,
    required_depth_m: f64,
    required_air_draft_m: f64,
    lateral_margin_m: f64,
    endpoint_grace_radius_m: f64,
    catzoc_allowance_mode: &str,
    allow_restricted_entry: bool,
    tss_avoidance_weight: f64,
    fairway_preference_weight: f64,
    cable_avoidance_weight: f64,
    caution_area_avoidance_weight: f64,
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    avoid_depth_m: f64,
    soft_prefer_depth_m: f64,
    avoid_depth_weight: f64,
    prefer_depth_weight: f64,
) -> PyResult<Bound<'py, PyDict>> {
    use crate::coords::{worldx_to_lon, worldy_to_lat};
    use pyo3::types::PyBytes;

    let params = crate::routing::ArtifactParams {
        required_depth_m,
        avoid_depth_m,
        soft_prefer_depth_m,
        required_air_draft_m,
        lateral_margin_m,
        endpoint_grace_radius_m,
        catzoc_mode: crate::routing::CatzocMode::parse(catzoc_allowance_mode),
        allow_restricted_entry,
        force_finest_resolution: false,
    };
    let weights = crate::routing::ArtifactWeights {
        tss_avoidance_weight,
        fairway_preference_weight,
        cable_avoidance_weight,
        caution_area_avoidance_weight,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        avoid_depth_weight,
        prefer_depth_weight,
    };
    let models: Vec<&crate::model::Cell> = cells.iter().map(|c| c.tiler.cell()).collect();
    let dbg = py.detach(|| {
        crate::routing::artifact_debug_lonlat(
            from_lon, from_lat, to_lon, to_lat, &models, &params, &weights,
        )
    });

    let rings_to_py = |rings: &[Vec<crate::coords::WorldXy>]| -> Vec<Vec<(f64, f64)>> {
        rings
            .iter()
            .map(|ring| {
                ring.iter()
                    .map(|p| (worldx_to_lon(p.x), worldy_to_lat(p.y)))
                    .collect()
            })
            .collect()
    };

    let c = &dbg.constraints;
    let rings = PyDict::new(py);
    for (name, set) in [
        ("hard", &c.hard),
        ("charted_depth", &c.charted_depth),
        ("coverage", &c.coverage),
        ("depth_avoid", &c.depth_avoid),
        ("depth_soft", &c.depth_soft),
        ("unsurveyed", &c.unsurveyed),
        ("caution", &c.caution),
        ("cable", &c.cable),
        ("tss", &c.tss),
        ("preferred", &c.preferred),
        ("survey", &c.survey),
        ("atba", &c.atba),
        ("check_manually", &c.check_manually),
    ] {
        rings.set_item(name, rings_to_py(set))?;
    }

    let finite = |v: f64| if v.is_finite() { Some(v) } else { None };
    let out = PyDict::new(py);
    out.set_item("reason", dbg.search.reason)?;
    out.set_item("start_snap_m", finite(dbg.search.start_snap_m))?;
    out.set_item("goal_snap_m", finite(dbg.search.goal_snap_m))?;
    out.set_item("constraint_rings", rings)?;

    match &dbg.search.field {
        None => out.set_item("field", py.None())?,
        Some(f) => {
            let fd = PyDict::new(py);
            fd.set_item("cols", f.cols)?;
            fd.set_item("rows", f.rows)?;
            fd.set_item("cell_size_m", f.cell_size_m)?;
            fd.set_item(
                "corners",
                f.corners.iter().map(|&(x, y)| [x, y]).collect::<Vec<_>>(),
            )?;
            fd.set_item("codes", PyBytes::new(py, &f.codes))?;
            fd.set_item("start_cell", f.start_cell.map(|(x, y)| [x, y]))?;
            fd.set_item("goal_cell", f.goal_cell.map(|(x, y)| [x, y]))?;
            out.set_item("field", fd)?;
        }
    }
    Ok(out)
}

/// Diagnostics-only summary of the `chartcore::mivnav` PRECOMPUTED-
/// artifact pipeline (`mivnav_routing_architecture_v3.md`'s §2 topology
/// layer), run over the SAME decoded cells [`mivnav_route`] hands the
/// fine search — never the ACTUAL routing decision. See [`MivnavRoute`]'s
/// own docs for why.
struct TopologyDiagnostics {
    band_m: f64,
    components: u32,
    portals: u32,
    shortcuts: u32,
    route_found: bool,
    hops: u32,
    cost_mm: i64,
    /// §8.3's width-demoted portals ON the topology route — ids of
    /// crossings whose `min_horizontal_width_dm` is below the request's
    /// `mivnav_beam_m`, kept as full edges but flagged for
    /// [`crate::mivnav::refine_demoted_route`]. Empty unless
    /// `mivnav_beam_m > 0`.
    demoted_portals: Vec<u32>,
    /// §11's directionally-penalised portals ON the topology route (wrong
    /// side of a lateral mark for the direction of travel). Empty unless
    /// `mivnav_directional_rules` was set.
    directional_penalized_portals: Vec<u32>,
    /// `(west_lon, south_lat, east_lon, north_lat)` — only when a
    /// topology route was actually found.
    corridor_bbox: Option<(f64, f64, f64, f64)>,
    /// §14's best known LOWER bound on the optimal FINE ROUTE cost
    /// between these endpoints, millimetre fixed-point — the straight-
    /// line great-circle distance at the request's own effective
    /// multiplier floor ([`crate::mivnav::straight_line_lower_bound_mm`] /
    /// [`crate::mivnav::effective_min_multiplier`]). Feeds
    /// [`MivnavRoute::optimality_gap`].
    ///
    /// Deliberately NOT the ALT landmark bound: that one bounds the
    /// tile-centre topology cost, which the fine search can beat by
    /// corner-cutting, so it is not a valid bound on the fine route. It
    /// is surfaced separately as [`Self::topology_lower_bound_mm`].
    best_known_lower_bound_mm: i64,
    /// §14's ALT landmark lower bound on the TOPOLOGY route cost
    /// (`topology_cost_mm`), off the artifact's own
    /// [`crate::mivnav::BandLandmarks`]. `0` on the rebuilt path (no
    /// landmark table) and whenever an endpoint is not a topology-graph
    /// node. Diagnostic only — it is not comparable to the fine route
    /// cost.
    topology_lower_bound_mm: i64,
    /// Where these numbers came from: [`TOPOLOGY_SOURCE_ARTIFACT`] (a
    /// persisted `.mivnav`, the v3 architecture's own answer) or
    /// [`TOPOLOGY_SOURCE_REBUILT`] (this request rebuilt the region from
    /// its own candidate cells, the pre-persistence behaviour).
    source: &'static str,
    /// Why a persisted artifact was NOT used, when one was asked for —
    /// §19's own [`crate::mivnav::Staleness`] text, or the I/O/decode
    /// error that stopped it being opened at all. `None` means either
    /// "the artifact was used" or "no artifact was asked for"; `source`
    /// distinguishes those two.
    ///
    /// This exists so the fallback can never be SILENT. CLAUDE.md's
    /// `#TSSLPT-OVERSCALE` entry is the same failure one layer up: a
    /// stale cached answer is indistinguishable from a correct fresh one
    /// unless something names the staleness, so this carries the named
    /// reason all the way to the wire rather than collapsing it to a
    /// boolean (or to nothing at all).
    fallback_reason: Option<String>,
}

/// [`TopologyDiagnostics::source`]: the numbers came off a persisted
/// `.mivnav` artifact.
const TOPOLOGY_SOURCE_ARTIFACT: &str = "artifact";
/// [`TopologyDiagnostics::source`]: the region was rebuilt from this
/// request's own candidate cells.
const TOPOLOGY_SOURCE_REBUILT: &str = "rebuilt";

impl Default for TopologyDiagnostics {
    /// The honest "nothing computed" answer — used when there was no
    /// cell to build a region from at all (an empty `cells` list; the
    /// caller's own corridor selection found nothing to hand over),
    /// never silently claimed as "found no route" (`route_found` here
    /// means the same as everywhere else: `false`, but paired with
    /// `components/portals/shortcuts == 0` a caller can tell "never ran"
    /// apart from "ran and genuinely found nothing").
    fn default() -> Self {
        TopologyDiagnostics {
            band_m: 0.0,
            components: 0,
            portals: 0,
            shortcuts: 0,
            route_found: false,
            hops: 0,
            cost_mm: 0,
            demoted_portals: Vec::new(),
            directional_penalized_portals: Vec::new(),
            corridor_bbox: None,
            best_known_lower_bound_mm: 0,
            topology_lower_bound_mm: 0,
            source: TOPOLOGY_SOURCE_REBUILT,
            fallback_reason: None,
        }
    }
}

/// Everything [`crate::mivnav::refine_demoted_route`] needs, carried out
/// of whichever topology path ran ([`topology_diagnostics`] or
/// [`topology_from_artifact`]) so [`mivnav_route`] can consume
/// [`crate::mivnav::TopologyRoute::demoted_portals`] on the LIVE route
/// rather than just reporting it.
///
/// `None` unless `mivnav_beam_m > 0`: refinement is opt-in, and
/// assembling these inputs costs a hazard-ring extraction
/// ([`crate::mivnav::region_hazard_rings`]) or a
/// [`crate::mivnav::load_hazard_rings`] read that an ordinary request
/// should not pay.
struct RefineInputs {
    /// Shared with the process-global artifact cache on the served path
    /// ([`topology_from_artifact`]); a fresh `Arc` wrapping the
    /// per-request rebuild on the fallback path ([`topology_diagnostics`]).
    built: std::sync::Arc<crate::mivnav::BuiltRegion>,
    /// The selected band's portals — `find`-indexed by id in
    /// [`crate::mivnav::refine_demoted_route`], so a filtered/reordered
    /// slice is still safe.
    portals: Vec<crate::mivnav::Portal>,
    demoted: Vec<u32>,
    /// Depth-blind HARD rings: the pre-stored `HazardRings` section, or
    /// re-derived from the request's cells. Empty is valid — the caller
    /// then re-verifies splices against the draft-aware set alone.
    hazard_rings: Vec<Vec<crate::coords::WorldXy>>,
}

/// Builds the region, runs §7/§8's band→components→portals→shortcuts
/// pipeline, and searches [`crate::mivnav::topology_route_graced`] —
/// exactly [`crate::mivnav`]'s own module docs' "Phase 4" pipeline,
/// exactly as `examples/mivnav_route.rs` already exercises by hand. Never
/// panics on a degenerate `cells` (empty, or every cell's own extent
/// invalid) — returns [`TopologyDiagnostics::default`] instead, the same
/// "nothing to compute" answer a caller gets from an empty candidate-cell
/// selection anywhere else in this crate.
#[allow(clippy::too_many_arguments)]
fn topology_diagnostics(
    cells: &[crate::model::Cell],
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    required_depth_m: f64,
    grace_radius_m: f64,
    catzoc_mode: crate::routing::CatzocMode,
    topology_weights: crate::mivnav::TopologyWeights,
    min_beam_dm: u16,
    directional_rules: bool,
) -> (TopologyDiagnostics, Option<RefineInputs>) {
    use crate::coords::{lat_lon_to_world, worldx_to_lon, worldy_to_lat, Extent};
    use crate::mivnav::{
        band_to_dm, build_directional_semantics, build_region, build_shortcuts, corridor_extent,
        detect_portals, label_band, region_hazard_rings, select_band,
        topology_route_graced_demoting,
    };

    let mut region_extent = Extent::invalid();
    for c in cells {
        region_extent.extend(&c.extent);
    }
    if !region_extent.valid {
        return (TopologyDiagnostics::default(), None);
    }

    // MUST be the same CATZOC policy the fine search runs under — this
    // was found by code review to be hardcoded to `Off` in an earlier
    // draft, silently checking a DIFFERENT (always laxer) hazard policy
    // than `artifact_route_lonlat` in the same request. `build_region`'s
    // own docs call `catzoc_mode` "the one legitimate build-time knob...
    // a survey-confidence POLICY", not a no-op — the topology layer's
    // whole value as a cross-check depends on it seeing the SAME
    // constraints the fine search did.
    let built = build_region(cells, region_extent, catzoc_mode);
    let band_m = select_band(required_depth_m);
    let comps = label_band(&built, band_m);
    let portals = detect_portals(&built, &comps);
    let shortcuts = build_shortcuts(&built, &portals);

    let from = lat_lon_to_world(from_lat, from_lon);
    let to = lat_lon_to_world(to_lat, to_lon);
    // §11 directional / buoyage semantics (Phase 7), opt-in per request.
    // Rebuilt from the same cells this diagnostics pass already holds —
    // the persisted-artifact path reads its `Semantics` section instead
    // (`topology_from_artifact`). Skipped entirely when the flag is off,
    // so an ordinary request pays nothing.
    let semantics = directional_rules.then(|| build_directional_semantics(cells));
    // Same reasoning as `catzoc_mode` above: `topology_weights` MUST be
    // the fine search's own fairway/TSS weights, not a hardcoded
    // default, or this cross-check would silently disagree with the
    // fine search over a preference the caller actually asked for.
    // `_demoting` with `min_beam_dm == 0` is byte-identical to
    // `topology_route_graced_with` (its own docs), so the pre-Phase-6
    // diagnostics path is unchanged when the beam knob is off.
    let found = topology_route_graced_demoting(
        &built,
        &portals,
        from,
        to,
        band_to_dm(required_depth_m),
        grace_radius_m,
        min_beam_dm,
        semantics.as_ref(),
        topology_weights,
    );

    let corridor_bbox = found.as_ref().map(|(topo, _, _)| {
        // `Extent`'s own y axis grows SOUTH (`ymin` = north edge), the
        // same convention `LLBox`'s own `from_extent` already accounts
        // for — see that function, `chartcore/src/coords/extent.rs`.
        let c = corridor_extent(&built, topo, 0.0);
        (
            worldx_to_lon(c.xmin),
            worldy_to_lat(c.ymax),
            worldx_to_lon(c.xmax),
            worldy_to_lat(c.ymin),
        )
    });

    let demoted_portals = found
        .as_ref()
        .map(|(t, _, _)| t.demoted_portals.clone())
        .unwrap_or_default();
    let directional_penalized_portals = found
        .as_ref()
        .map(|(t, _, _)| t.directional_penalized_portals.clone())
        .unwrap_or_default();
    // §14: the straight-line great-circle bound at the request's own
    // effective multiplier floor — the only bound that is valid against
    // the FINE route cost. The tighter ALT landmark bound needs a built
    // artifact (`crate::mivnav::landmarks`) and only bounds the topology
    // cost anyway, so the rebuilt path leaves `topology_lower_bound_mm`
    // at 0.
    let best_known_lower_bound_mm = crate::mivnav::straight_line_lower_bound_mm(
        (from_lon, from_lat),
        (to_lon, to_lat),
        crate::mivnav::effective_min_multiplier(topology_weights.fairway_preference_weight),
    );
    let diag = TopologyDiagnostics {
        band_m,
        components: comps.count,
        portals: portals.len() as u32,
        shortcuts: shortcuts.len() as u32,
        route_found: found.is_some(),
        hops: found.as_ref().map_or(0, |(t, _, _)| t.hops.len() as u32),
        cost_mm: found.as_ref().map_or(0, |(t, _, _)| t.cost_mm),
        demoted_portals: demoted_portals.clone(),
        directional_penalized_portals,
        corridor_bbox,
        best_known_lower_bound_mm,
        topology_lower_bound_mm: 0,
        source: TOPOLOGY_SOURCE_REBUILT,
        fallback_reason: None,
    };

    // Only pay for the refinement inputs when the beam knob asked for
    // them AND a portal was actually demoted — `region_hazard_rings`
    // decodes hard geometry out of every cell, exactly the per-request
    // cost the persisted-artifact path exists to avoid, and with nothing
    // demoted `refine_fine_route` would only discard it.
    let refine_inputs = (min_beam_dm > 0 && !demoted_portals.is_empty()).then(|| RefineInputs {
        built: std::sync::Arc::new(built),
        portals,
        demoted: demoted_portals,
        hazard_rings: region_hazard_rings(cells, catzoc_mode),
    });

    (diag, refine_inputs)
}

/// The SAME topology answer as [`topology_diagnostics`], read off a
/// persisted `.mivnav` instead of rebuilt from the request's own cells —
/// the whole point of the v3 precompute split (`crate::mivnav::persist`'s
/// own module docs: `O(1)` load instead of `O(region)` rebuild, on a Pi
/// where CPU is the constraint).
///
/// The call shape is exactly the one `persist.rs`'s module docs fix, and
/// exactly what `tests/mivnav_persist_de6ostim.rs` proves equal to a
/// fresh build on real chart data:
///
/// ```text
/// ArtifactReader::from_file -> staleness -> load_region -> load_band
///   -> topology_route_graced_with
/// ```
///
/// # Every failure is a reason, never a panic and never a silent zero
///
/// `Err` carries text meant to be shown: §19's [`crate::mivnav::
/// Staleness`] names WHICH component moved (schema/derivation/authority/
/// band-ladder/resolution-policy, or a chart-set/sequence mismatch), and
/// an I/O or decode failure carries the decoder's own message. The caller
/// ([`mivnav_route`]) turns that into
/// [`TopologyDiagnostics::fallback_reason`] and rebuilds — see that
/// field's docs for why the reason must reach the wire.
///
/// # A stale artifact is refused, never read
///
/// §19 lets a stale artifact OPEN so its staleness can be diagnosed; this
/// deliberately does not go on to READ one. `load_band`'s own docs give
/// the sharpest case (a labelling built at 3.0 m answering what is now
/// rung 4 at a different depth), but the general rule is the same one
/// `build_region`'s `catzoc_mode` argument already enforces: an
/// acceleration structure that answers a draft question against the wrong
/// threshold is worse than no acceleration structure.
#[allow(clippy::too_many_arguments)]
fn topology_from_artifact(
    artifact_path: &std::path::Path,
    chart_set: crate::mivnav::ChartSetIdentity,
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    required_depth_m: f64,
    grace_radius_m: f64,
    topology_weights: crate::mivnav::TopologyWeights,
    min_beam_dm: u16,
    directional_rules: bool,
) -> Result<(TopologyDiagnostics, Option<RefineInputs>), String> {
    use crate::coords::{lat_lon_to_world, worldx_to_lon, worldy_to_lat};
    use crate::mivnav::{
        artifact_cache, band_to_dm, corridor_extent, effective_min_multiplier, select_band,
        select_band_index, snap_point, straight_line_lower_bound_mm,
        topology_route_graced_demoting,
    };

    // One opened, staleness-checked artifact, from a process-global cache
    // keyed on `(path, identity)`: the file is read and the region
    // decoded once per `(path, sequence)`, not once per request — see
    // `crate::mivnav::artifact_cache`. A missing / unreadable / stale
    // file returns the same human string the direct read did, so the
    // caller's rebuild-and-say-why fallback is unchanged (and "never
    // built" still reads differently from "damaged").
    let art = artifact_cache::get(artifact_path, chart_set)?;
    let built = art.region();
    let band_index = select_band_index(required_depth_m);
    let band = art.band(band_index)?;

    let band_m = select_band(required_depth_m);
    let from = lat_lon_to_world(from_lat, from_lon);
    let to = lat_lon_to_world(to_lat, to_lon);
    // §11 directional / buoyage semantics (Phase 7), opt-in per request,
    // read straight off the artifact's own `Semantics` section — the
    // whole point of the precompute split: no cell decode, no geometry
    // rebuild on the served path. An artifact written before the section
    // existed yields an empty set here and the crossing rules simply do
    // not fire (documented not-staleness, same as `load_hazard_rings`).
    // Skipped entirely when the flag is off.
    let semantics = directional_rules.then(|| art.semantics());
    // `_demoting` with `min_beam_dm == 0` is byte-identical to
    // `topology_route_graced_with`, so an artifact request with the beam
    // knob off returns exactly the diagnostics it did before Phase 6.
    let found = topology_route_graced_demoting(
        built,
        &band.portals,
        from,
        to,
        band_to_dm(required_depth_m),
        grace_radius_m,
        min_beam_dm,
        semantics.as_deref(),
        topology_weights,
    );

    // Identical to `topology_diagnostics`' own — `Extent`'s y axis grows
    // SOUTH, so `ymax` is the southern edge.
    let corridor_bbox = found.as_ref().map(|(topo, _, _)| {
        let c = corridor_extent(built, topo, 0.0);
        (
            worldx_to_lon(c.xmin),
            worldy_to_lat(c.ymax),
            worldx_to_lon(c.xmax),
            worldy_to_lat(c.ymin),
        )
    });

    let demoted_portals = found
        .as_ref()
        .map(|(t, _, _)| t.demoted_portals.clone())
        .unwrap_or_default();
    let directional_penalized_portals = found
        .as_ref()
        .map(|(t, _, _)| t.directional_penalized_portals.clone())
        .unwrap_or_default();
    // §14: the fine-route bound is the straight-line term at the
    // request's effective multiplier floor (the only one valid against
    // the fine cost). The ALT landmark bound off the artifact's own
    // table is computed too, but it bounds the TOPOLOGY cost only and is
    // surfaced separately. Both are cheap — no cell decode, no Dijkstra
    // on the served path.
    let best_known_lower_bound_mm = straight_line_lower_bound_mm(
        (from_lon, from_lat),
        (to_lon, to_lat),
        effective_min_multiplier(topology_weights.fairway_preference_weight),
    );
    let topology_lower_bound_mm = match (snap_point(built, from), snap_point(built, to)) {
        (Some(s), Some(g)) => band.landmarks.lower_bound_mm(s.tile, g.tile),
        _ => 0,
    };
    let diag = TopologyDiagnostics {
        band_m,
        components: band.components.count,
        portals: band.portals.len() as u32,
        shortcuts: band.shortcuts.len() as u32,
        route_found: found.is_some(),
        hops: found.as_ref().map_or(0, |(t, _, _)| t.hops.len() as u32),
        cost_mm: found.as_ref().map_or(0, |(t, _, _)| t.cost_mm),
        demoted_portals: demoted_portals.clone(),
        directional_penalized_portals,
        corridor_bbox,
        best_known_lower_bound_mm,
        topology_lower_bound_mm,
        source: TOPOLOGY_SOURCE_ARTIFACT,
        fallback_reason: None,
    };

    // §12.4's whole point: refine a demoted crossing without holding
    // decoded cells resident. The pre-stored `HazardRings` section
    // supplies the geometry; an artifact built before that section
    // existed returns an empty set here and the caller re-derives from
    // the request's cells (`load_hazard_rings`' own docs). Only assembled
    // when a beam was set AND a portal was actually demoted, so the
    // clones below (a shared `Arc` of the region, a copy of the band's
    // portals, a copy of the rings) are off every ordinary request.
    let refine_inputs = (min_beam_dm > 0 && !demoted_portals.is_empty()).then(|| RefineInputs {
        built: std::sync::Arc::clone(built),
        portals: band.portals.clone(),
        demoted: demoted_portals,
        hazard_rings: (*art.hazard_rings()).clone(),
    });

    Ok((diag, refine_inputs))
}

#[cfg(test)]
mod topology_diagnostics_tests {
    use super::*;
    use crate::routing::CatzocMode;

    /// The real DE6OSTIM fixture, decoded — same cell every other
    /// `mivnav`/`routing::artifact` integration test in this crate uses.
    fn de6ostim_cell() -> crate::model::Cell {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../backend/data/fnc/DE6OSTIM.S57");
        let file = std::fs::File::open(&path).expect("DE6OSTIM fixture reads");
        let mut cell = crate::osenc::read_cell(file).expect("DE6OSTIM fixture decodes");
        crate::derive::apply(&mut cell);
        cell
    }

    /// Regression for the exact bug code review found: `topology_
    /// diagnostics` (called from [`mivnav_route`]) used to hardcode
    /// `CatzocMode::Off` for the topology layer's own region build,
    /// regardless of what `catzoc_allowance_mode` the actual caller
    /// asked for — silently running the topology cross-check under a
    /// DIFFERENT, always-laxer hazard policy than whatever the fine
    /// search used for the same request. `mivnav_route`'s own
    /// integration path can't exercise this directly (this fixture's
    /// harbour closes ENTIRELY under `Full`'s D/U depth allowance —
    /// `test_routing_artifact.py`'s own `test_catzoc_mode_changes_
    /// whether_this_harbour_is_navigable_at_all` — so the fine search
    /// itself returns `None` before the topology layer would ever run,
    /// which is exactly why this is a direct unit test of `topology_
    /// diagnostics` instead of a `find_mivnav_route`-level one: calling
    /// it directly bypasses that short-circuit and proves the PARAMETER
    /// is actually threaded through, independent of whether the fine
    /// search would also survive `Full` on this cell).
    #[test]
    fn topology_diagnostics_uses_the_callers_catzoc_mode_not_a_hardcoded_one() {
        let cell = de6ostim_cell();
        let cells = std::slice::from_ref(&cell);

        let (off, _) = topology_diagnostics(
            cells,
            11.3711,
            53.9930,
            11.3711,
            53.9896,
            0.5,
            150.0,
            CatzocMode::Off,
            crate::mivnav::TopologyWeights::default(),
            0,
            false,
        );
        let (full, _) = topology_diagnostics(
            cells,
            11.3711,
            53.9930,
            11.3711,
            53.9896,
            0.5,
            150.0,
            CatzocMode::Full,
            crate::mivnav::TopologyWeights::default(),
            0,
            false,
        );

        assert!(
            off.route_found,
            "the ordinary Off case must still find a route"
        );
        assert_ne!(
            (off.components, off.portals, off.route_found),
            (full.components, full.portals, full.route_found),
            "Off and Full must build DIFFERENT topologies on this real cell — identical \
             numbers here is exactly the bug's own signature (both silently using Off)"
        );
    }
}

/// A found route from the `"mivnav"` algorithm
/// (`RoutingConfig.algorithm == "mivnav"`) — the fifth `routing.
/// algorithm` entry, and the first backend-reachable slice of
/// `crate::mivnav`, the PRECOMPUTED-artifact half of
/// `mivnav_routing_architecture_v3.md` (see that module's own docs for
/// what "precomputed" does and does not mean yet).
///
/// # The route itself is IDENTICAL to `"artifact"`'s — read this before
/// wiring anything to `topology_*` fields
///
/// [`mivnav_route`] runs `crate::routing::artifact_route_lonlat` —
/// REUSED UNMODIFIED, the exact same fine grid search, cost model, and
/// §16 exact verification `"artifact"` already ships — over the exact
/// same decoded `cells` a caller hands it. The `topology_*` getters below
/// come from running `crate::mivnav`'s own band→components→portals→
/// shortcuts→topology-search pipeline ALONGSIDE that, on the SAME cells,
/// but that pipeline's result does not gate, filter, or alter the fine
/// search's own answer.
///
/// # Why the corridor still does not select the cells — this is now a
/// measured decision, not an unfinished one
///
/// The obvious next step (hand `artifact_route_lonlat` only the cells the
/// topology corridor reaches, instead of the caller's whole candidate
/// set) was built, tested against real chart data, and then NOT wired,
/// because it cannot be made answer-preserving from outside
/// `routing::artifact`. `routing::artifact::constraints::build` derives
/// two REGION-GLOBAL scalars — the finest `compilation_scale` and the
/// coarsest `catzoc_horizontal_m` — over whatever slice it is handed,
/// with no spatial restriction at all, and both feed
/// `routing::artifact::ladder::finest_allowed_cell_m`, i.e. the
/// resolution rung the corridor grid is built at. Dropping a cell 110 km
/// from the route can therefore move every grid cell centre and change
/// the route. `crate::mivnav::corridor_scope_extent`'s own docs carry the
/// full argument and the measured counterexample; the machinery
/// (`corridor_scope_extent`, `corridor_scope_pad_m`,
/// `filter_cells_to_corridor`) is built, tested and public, waiting for
/// `constraints::build` to grow a way to be handed those two scalars from
/// the UNFILTERED slice.
///
/// Do not re-wire it here without that. The perf case does not justify
/// the risk either: measured on the real fixtures, dropping a whole chart
/// cell saves ~0.5 ms of a ~6 ms fine search, behind a ~200 ms topology
/// rebuild, and drops zero cells for any caller in this repo.
///
/// The other half of the v3 split — reading a PERSISTED `.mivnav` file
/// built once per chart set rather than rebuilding the region on every
/// request — is still real, scoped, future work; see `crate::mivnav`'s
/// own "State" doc section for exactly what is and is not built yet.
///
/// What this DOES prove, today, on real backend-selected chart data
/// (not just the one hardcoded fixture `examples/mivnav_route.rs`
/// exercises by hand): the whole precompute pipeline runs correctly
/// end-to-end over an arbitrary chart-set's own decoded cells, from a
/// real HTTP request, and its own topology-level answer (`topology_
/// route_found`, band, hop count, corridor bounds) can be compared
/// against what the fine search actually did — exactly the kind of
/// real-world cross-check `tests/mivnav_query_de6ostim.rs` already does
/// on one fixture, now exercisable on whatever chart set is actually
/// installed.
///
/// Handed out by [`mivnav_route`].
#[pyclass(module = "chartcore", frozen)]
struct MivnavRoute {
    inner: crate::routing::ArtifactRoute,
    topo: TopologyDiagnostics,
    /// `Some` only when `mivnav_beam_m > 0` demoted at least one portal
    /// on this route AND [`crate::mivnav::refine_demoted_route`] kept at
    /// least one splice. When it is `Some`, the route-shape getters
    /// (`waypoints`/`distance_m`/`approximate_legs`/`check_manually_legs`)
    /// return the REFINED route; otherwise they return the fine search's
    /// own output byte-for-byte, so a request with the beam knob off is
    /// still identical to `"artifact"`.
    refined: Option<MivnavRefined>,
}

/// The fine route after Phase 6's local vector refinement of every
/// demoted crossing that survived the length and draft-aware
/// re-verification gates — see [`crate::mivnav::refine_demoted_route`].
struct MivnavRefined {
    waypoints: Vec<(f64, f64)>,
    distance_m: f64,
    approximate_legs: Vec<bool>,
    check_manually_legs: Vec<bool>,
    /// Ids of the demoted portals whose refinement splice was kept.
    refined_portals: Vec<u32>,
}

#[pymethods]
impl MivnavRoute {
    /// See [`ArtifactRoute::waypoints`]. Identical to the fine search's
    /// own unless a Phase 6 refinement splice was kept (see
    /// [`MivnavRoute::refined`]), in which case these are the refined
    /// route's waypoints.
    #[getter]
    fn waypoints(&self) -> Vec<(f64, f64)> {
        match &self.refined {
            Some(r) => r.waypoints.clone(),
            None => self.inner.waypoints.clone(),
        }
    }

    #[getter]
    fn distance_m(&self) -> f64 {
        match &self.refined {
            Some(r) => r.distance_m,
            None => self.inner.distance_m,
        }
    }

    #[getter]
    fn approximate_legs(&self) -> Vec<bool> {
        match &self.refined {
            Some(r) => r.approximate_legs.clone(),
            None => self.inner.approximate_legs.clone(),
        }
    }

    #[getter]
    fn check_manually_legs(&self) -> Vec<bool> {
        match &self.refined {
            Some(r) => r.check_manually_legs.clone(),
            None => self.inner.check_manually_legs.clone(),
        }
    }

    #[getter]
    fn start_snap_m(&self) -> f64 {
        self.inner.start_snap_m
    }

    #[getter]
    fn end_snap_m(&self) -> f64 {
        self.inner.end_snap_m
    }

    #[getter]
    fn route_cost_mm(&self) -> i64 {
        self.inner.diagnostics.route_cost_mm
    }

    /// See [`ArtifactRoute::cell_size_m`] — needed by the SAME
    /// backend `_artifact_snap_reason` threshold check `_plan_via_mivnav`
    /// reuses for this route's own snap warnings.
    #[getter]
    fn cell_size_m(&self) -> f64 {
        self.inner.diagnostics.cell_size_m
    }

    // The remaining `ArtifactRoute` grid/ladder/CATZOC diagnostics —
    // added by code review, which found `mivnav_diagnostics`
    // (`hazards.py`) and this class's own module docs claiming FULL
    // parity with `artifact_diagnostics` while only 3 of its 14 fields
    // actually existed here. See each field's own doc on [`ArtifactRoute`]
    // for what it means; these are the identical fields, off the
    // identical fine-search run, since [`MivnavRoute`]'s route IS an
    // `artifact_route_lonlat` result.

    #[getter]
    fn grid_dims(&self) -> (u32, u32) {
        (
            self.inner.diagnostics.grid_cols,
            self.inner.diagnostics.grid_rows,
        )
    }

    #[getter]
    fn ladder_cell_m(&self) -> f64 {
        self.inner.diagnostics.ladder_cell_m
    }

    #[getter]
    fn finest_allowed_cell_m(&self) -> f64 {
        self.inner.diagnostics.finest_allowed_cell_m
    }

    #[getter]
    fn catzoc_horizontal_m(&self) -> f64 {
        self.inner.diagnostics.catzoc_horizontal_m
    }

    #[getter]
    fn compilation_scale(&self) -> u32 {
        self.inner.diagnostics.compilation_scale
    }

    #[getter]
    fn blocked_cells(&self) -> u32 {
        self.inner.diagnostics.blocked_cells
    }

    #[getter]
    fn unknown_cells(&self) -> u32 {
        self.inner.diagnostics.unknown_cells
    }

    #[getter]
    fn nodes_expanded(&self) -> u32 {
        self.inner.diagnostics.nodes_expanded
    }

    #[getter]
    fn corridor_widen_attempts(&self) -> u32 {
        self.inner.diagnostics.corridor_widen_attempts
    }

    /// The §7 depth band the topology layer connectivity-searched at —
    /// [`crate::mivnav::select_band`]'s own conservative rounding of
    /// `required_depth_m` up to the nearest precomputed ladder rung.
    #[getter]
    fn topology_band_m(&self) -> f64 {
        self.topo.band_m
    }

    #[getter]
    fn topology_components(&self) -> u32 {
        self.topo.components
    }

    #[getter]
    fn topology_portals(&self) -> u32 {
        self.topo.portals
    }

    #[getter]
    fn topology_shortcuts(&self) -> u32 {
        self.topo.shortcuts
    }

    /// Whether the COARSE topology layer itself found a portal path
    /// between the two (possibly §9.3-graced) endpoint tiles — an
    /// independent cross-check against the fine search's own answer,
    /// not the reason this route exists or does not (see this class's
    /// own docs).
    #[getter]
    fn topology_route_found(&self) -> bool {
        self.topo.route_found
    }

    #[getter]
    fn topology_hops(&self) -> u32 {
        self.topo.hops
    }

    #[getter]
    fn topology_cost_mm(&self) -> i64 {
        self.topo.cost_mm
    }

    /// `(west_lon, south_lat, east_lon, north_lat)`, or `None` when no
    /// topology route was found — the coarse box
    /// [`crate::mivnav::corridor_extent`] derived from it, padded by
    /// `0.0` (a caller wanting real margin should pad the bbox itself;
    /// this is a diagnostic, and NOT a cell-selection input — see this
    /// class's own docs for why the corridor deliberately still selects
    /// nothing, and [`crate::mivnav::corridor_scope_extent`] for the box
    /// a caller would have to use if it ever did).
    #[getter]
    fn topology_corridor_bbox(&self) -> Option<(f64, f64, f64, f64)> {
        self.topo.corridor_bbox
    }

    /// `"artifact"` when the topology numbers above were LOADED from a
    /// persisted `.mivnav` (the v3 architecture's own path), `"rebuilt"`
    /// when this request rebuilt the region from its own candidate cells.
    ///
    /// Always present, on every route, because "which of the two ran" is
    /// not observable from the numbers themselves: a correct artifact and
    /// a correct rebuild are supposed to agree, so without this a build
    /// that silently never happened looks exactly like one that did.
    #[getter]
    fn topology_source(&self) -> &'static str {
        self.topo.source
    }

    /// Why the persisted artifact was not used, when one was asked for —
    /// §19's [`crate::mivnav::Staleness`] text (which NAMES the stale
    /// component) or the open/decode error. `None` when the artifact WAS
    /// used, and also `None` when no artifact was asked for at all;
    /// [`MivnavRoute::topology_source`] separates those.
    #[getter]
    fn topology_fallback_reason(&self) -> Option<String> {
        self.topo.fallback_reason.clone()
    }

    /// §8.3's width-demoted portals ON the topology route: crossings
    /// whose measured `min_horizontal_width_dm` is below the request's
    /// `mivnav_beam_m`. Kept as full edges (never rejected), each one a
    /// candidate for [`crate::mivnav::refine_demoted_route`]. Empty when
    /// `mivnav_beam_m` is `0` (the default) or when the route crosses no
    /// marginal-width portal.
    #[getter]
    fn topology_demoted_portals(&self) -> Vec<u32> {
        self.topo.demoted_portals.clone()
    }

    /// §11's directionally-penalised portals ON the topology route:
    /// crossings that paid a wrong-side lateral-mark penalty for their
    /// direction of travel, when `mivnav_directional_rules` was set.
    /// Diagnostics only — the route was already priced with the penalty
    /// folded in. Empty when the flag is off, when the region charts no
    /// lateral marks, or when the route stayed buoyage-consistent.
    /// Against-flow (forbidden) crossings never appear here: a forbidden
    /// edge does not exist, so it cannot be on a route.
    #[getter]
    fn topology_directional_penalized_portals(&self) -> Vec<u32> {
        self.topo.directional_penalized_portals.clone()
    }

    /// The subset of [`MivnavRoute::topology_demoted_portals`] whose
    /// local vector refinement splice was actually KEPT — it produced a
    /// clear detour no longer than the stretch it replaced, and that
    /// detour re-verified clear of the request's draft-aware
    /// hard-constraint union. Non-empty exactly when the route-shape
    /// getters return the refined route rather than the fine search's.
    #[getter]
    fn mivnav_refined_portals(&self) -> Vec<u32> {
        match &self.refined {
            Some(r) => r.refined_portals.clone(),
            None => Vec::new(),
        }
    }

    /// §14's best known LOWER bound on the optimal FINE ROUTE cost
    /// between these endpoints, millimetre fixed-point — the straight-
    /// line great-circle distance at this request's effective multiplier
    /// floor. The denominator of [`MivnavRoute::optimality_gap`].
    #[getter]
    fn best_known_lower_bound_mm(&self) -> i64 {
        self.topo.best_known_lower_bound_mm
    }

    /// §14's ALT landmark lower bound on the TOPOLOGY route cost
    /// ([`MivnavRoute::topology_cost_mm`]), off the persisted artifact's
    /// own landmark tables. `0` when the route rebuilt the region (no
    /// tables) or when an endpoint is not a topology-graph node.
    /// Diagnostic only — it bounds the tile-centre topology cost, which
    /// the fine search can beat by corner-cutting, so it is NOT
    /// comparable to `route_cost_mm` and never feeds `optimality_gap`.
    #[getter]
    fn topology_lower_bound_mm(&self) -> i64 {
        self.topo.topology_lower_bound_mm
    }

    /// §14's optimality gap: `(route_cost_mm − best_known_lower_bound_mm)
    /// / best_known_lower_bound_mm`, clamped at `0.0` and `0.0` when the
    /// bound is `0`. An UPPER bound on the true gap (the denominator is
    /// itself only a lower bound), so "0.02" means the route is provably
    /// within 2 % of optimal — it may be closer. Computed against the
    /// fine search's own `route_cost_mm`; when a `mivnav_beam_m` splice
    /// was kept the returned route is shorter still, so the real gap is
    /// then even smaller than reported.
    #[getter]
    fn optimality_gap(&self) -> f64 {
        let lb = self.topo.best_known_lower_bound_mm.max(0);
        let cost = self.inner.diagnostics.route_cost_mm;
        if lb > 0 {
            ((cost - lb) as f64 / lb as f64).max(0.0)
        } else {
            0.0
        }
    }

    /// §16's verification outcome: `"verified"` when the exact verifier
    /// confirmed every leg clear of the hard-constraint union,
    /// `"approximate_legs"` when at least one leg could not be confirmed
    /// (the same meaning [`MivnavRoute::check_manually_legs`] and the
    /// per-leg `approximate_legs` already carry). Never `"unverified"`
    /// today — that spelling is reserved for a future §16-skipping fast
    /// path.
    #[getter]
    fn verification_status(&self) -> &'static str {
        let status = if self.inner.approximate_legs.iter().any(|&x| x) {
            crate::mivnav::VerificationStatus::ApproximateLegs
        } else {
            crate::mivnav::VerificationStatus::Verified
        };
        status.as_str()
    }

    fn __repr__(&self) -> String {
        let n = self
            .refined
            .as_ref()
            .map_or(self.inner.waypoints.len(), |r| r.waypoints.len());
        let d = self
            .refined
            .as_ref()
            .map_or(self.inner.distance_m, |r| r.distance_m);
        format!(
            "<MivnavRoute {} waypoints, {:.0}m, topology ({}): {} band={:.1}m components={} portals={} shortcuts={}{}>",
            n,
            d,
            self.topo.source,
            if self.topo.route_found { "found" } else { "not found" },
            self.topo.band_m,
            self.topo.components,
            self.topo.portals,
            self.topo.shortcuts,
            match &self.refined {
                Some(r) => format!(", refined {} crossing(s)", r.refined_portals.len()),
                None => String::new(),
            },
        )
    }
}

/// The `"mivnav"` algorithm — see [`MivnavRoute`]'s own docs for exactly
/// what this does and does not prove yet. Parameters and defaults are
/// identical to [`artifact_route`]'s own (this wraps that same search),
/// plus none new: `endpoint_grace_radius_m` doubles as the topology
/// layer's own [`crate::mivnav::topology_route_graced`] grace radius —
/// the same "how far from a requested endpoint are we willing to relax
/// navigability" question, even though the two layers apply it at
/// different granularity (per-cell there, per-tile here).
///
/// `None` under the exact same conditions [`artifact_route`] returns
/// `None` — this algorithm's actual accept/reject decision is entirely
/// the fine search's, unchanged.
///
/// # Reading a persisted `.mivnav` (`artifact_path`)
///
/// `artifact_path` + `chart_set_id` + `chart_set_sequence` together turn
/// the topology layer from "rebuild the region from this request's own
/// cells" into "load the region a build already published" — v3's actual
/// architecture, and the reason `crate::mivnav::persist` exists.
/// `chart_set_sequence` must be the backend's own `cs.sequence`, the same
/// max-mtime number that already invalidates the tile cache, so the two
/// caches can never disagree about what "current" means
/// ([`crate::mivnav::ChartSetIdentity`]'s own docs).
///
/// **The fallback is a REBUILD, and it is never silent.** A missing,
/// unreadable or §19-stale artifact falls back to the pre-persistence
/// behaviour (rebuild from `cells`) rather than refusing the request,
/// because the topology layer is a cross-check that does not decide this
/// route: the waypoints come from the fine search either way, so refusing
/// would cost a real route to protect a diagnostic. What it must NOT do
/// is hide which one ran — [`MivnavRoute::topology_source`] always says,
/// and [`MivnavRoute::topology_fallback_reason`] carries §19's own named
/// reason. A stale artifact is refused and rebuilt over, never read; see
/// [`topology_from_artifact`].
///
/// Passing `artifact_path` without `chart_set_id` is a caller bug rather
/// than a request for the pre-persistence path: there is no identity to
/// check staleness against, so the file cannot be trusted at all. It
/// falls back with that as the reason, for the same "say what happened"
/// reason as every other fallback here.
///
/// # Local vector refinement (`mivnav_beam_m`)
///
/// `mivnav_beam_m` is the vessel's beam in metres. When it is `> 0`,
/// §8.3's demote-not-reject kicks in: a portal on the topology route
/// whose measured `min_horizontal_width_dm` is below it (the `w == 0`
/// "not measurable" case included) is kept as a full edge but recorded in
/// [`crate::mivnav::TopologyRoute::demoted_portals`], and
/// [`crate::mivnav::refine_demoted_route`] then tries to route each such
/// crossing exactly, against the chart's hazard-ring geometry rather than
/// its rasterisation. A refined splice is kept only when it is no longer
/// than the stretch it replaces AND its legs re-verify clear of the
/// request's **draft-aware** hard-constraint union
/// (`routing::raster::verify_route_legs`, the fine search's own §16
/// verifier) — the pre-stored / re-derived hazard rings are HARD hazards
/// at draft 0, so this second check is what stops a bend the fine search
/// put in to clear a shoal being straightened aground.
///
/// When a splice is kept, `waypoints`/`distance_m`/`approximate_legs`/
/// `check_manually_legs` describe the REFINED route and
/// [`MivnavRoute::mivnav_refined_portals`] is non-empty. `mivnav_beam_m
/// == 0` (the default) disables the whole mechanism and the route is
/// byte-for-byte `"artifact"`'s, exactly as before.
///
/// Releases the GIL for the same reason [`shortest_path`] does.
#[pyfunction]
#[pyo3(signature = (
    from_lon, from_lat, to_lon, to_lat, cells,
    required_depth_m,
    required_air_draft_m=0.0,
    lateral_margin_m=0.0,
    endpoint_grace_radius_m=150.0,
    catzoc_allowance_mode="full",
    allow_restricted_entry=false,
    tss_avoidance_weight=0.0,
    fairway_preference_weight=0.0,
    cable_avoidance_weight=0.0,
    caution_area_avoidance_weight=0.0,
    low_confidence_survey_avoidance_weight=0.0,
    turn_cost_weight=0.0,
    avoid_depth_m=0.0,
    soft_prefer_depth_m=0.0,
    avoid_depth_weight=0.0,
    prefer_depth_weight=0.0,
    artifact_path=None,
    chart_set_id=None,
    chart_set_sequence=0,
    mivnav_beam_m=0.0,
    mivnav_directional_rules=false,
    route_time_unix=None,
))]
#[allow(clippy::too_many_arguments)]
fn mivnav_route(
    py: Python<'_>,
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    cells: Vec<PyRef<'_, Cell>>,
    required_depth_m: f64,
    required_air_draft_m: f64,
    lateral_margin_m: f64,
    endpoint_grace_radius_m: f64,
    catzoc_allowance_mode: &str,
    allow_restricted_entry: bool,
    tss_avoidance_weight: f64,
    fairway_preference_weight: f64,
    cable_avoidance_weight: f64,
    caution_area_avoidance_weight: f64,
    low_confidence_survey_avoidance_weight: f64,
    turn_cost_weight: f64,
    avoid_depth_m: f64,
    soft_prefer_depth_m: f64,
    avoid_depth_weight: f64,
    prefer_depth_weight: f64,
    artifact_path: Option<PathBuf>,
    chart_set_id: Option<String>,
    chart_set_sequence: u64,
    mivnav_beam_m: f64,
    mivnav_directional_rules: bool,
    route_time_unix: Option<f64>,
) -> Option<MivnavRoute> {
    // §9.2 reserves a request time for the deferred `ScheduledGate`
    // (lock / opening-bridge expected-wait) rule. Accepted from day one
    // so the wire contract is stable, but nothing consumes it yet — see
    // `crate::mivnav::directional`'s module docs.
    let _ = route_time_unix;
    let params = crate::routing::ArtifactParams {
        required_depth_m,
        avoid_depth_m,
        soft_prefer_depth_m,
        required_air_draft_m,
        lateral_margin_m,
        endpoint_grace_radius_m,
        catzoc_mode: crate::routing::CatzocMode::parse(catzoc_allowance_mode),
        allow_restricted_entry,
        // Never on for a served route — the finest-everywhere brute force
        // is a test oracle only (`crate::mivnav::reference_route`).
        force_finest_resolution: false,
    };
    let weights = crate::routing::ArtifactWeights {
        tss_avoidance_weight,
        fairway_preference_weight,
        cable_avoidance_weight,
        caution_area_avoidance_weight,
        low_confidence_survey_avoidance_weight,
        turn_cost_weight,
        avoid_depth_weight,
        prefer_depth_weight,
    };
    // Borrow the decoded models out of the `frozen` `Cell` pyclasses
    // BEFORE detaching, exactly like `artifact_route`'s own `models` —
    // zero-copy, no `Cell` clone yet.
    let models: Vec<&crate::model::Cell> = cells.iter().map(|c| c.tiler.cell()).collect();
    let topology_weights = crate::mivnav::TopologyWeights {
        tss_avoidance_weight: weights.tss_avoidance_weight,
        fairway_preference_weight: weights.fairway_preference_weight,
    };
    // Beam (metres) -> decimetres for the portal-width comparison, the
    // same unit `Portal::min_horizontal_width_dm` is stored in. A
    // non-finite or non-positive beam means "no beam constraint" -> `0`,
    // which makes the whole demote/refine path a no-op.
    let min_beam_dm: u16 = if mivnav_beam_m.is_finite() && mivnav_beam_m > 0.0 {
        (mivnav_beam_m * 10.0)
            .round()
            .clamp(1.0, f64::from(u16::MAX)) as u16
    } else {
        0
    };

    py.detach(|| {
        // The fine search runs FIRST, over the caller's WHOLE candidate
        // slice, and its `?` short-circuits the topology pipeline on a
        // no-route request. That ordering is deliberate and was
        // re-confirmed by measurement, not left over: a draft of this
        // function ran the topology layer first so its corridor could
        // select `models` down to a smaller slice
        // (`crate::mivnav::filter_cells_to_corridor`), and that turned out
        // to be unsafe at any tightness — `crate::mivnav::
        // corridor_scope_extent`'s docs carry the counterexample. Nothing
        // about the topology result may reach `artifact_route_lonlat`
        // until `routing::artifact::constraints::build` can be handed its
        // two region-global scalars from the UNFILTERED slice.
        let fine = crate::routing::artifact_route_lonlat(
            from_lon, from_lat, to_lon, to_lat, &models, &params, &weights,
        )?;
        // Owned, not borrowed: `build_region` (inside `topology_
        // diagnostics`) needs `&[Cell]`, not `&[&Cell]`. Cloned HERE,
        // inside the already-detached closure — an earlier draft cloned
        // before `py.detach` (found by code review), paying a real
        // `Cell` clone (its `Vec<Feature>` geometry + attribute maps,
        // per candidate cell) while still holding the GIL, on every
        // `"mivnav"` request; `models` above stays the zero-copy borrow
        // `artifact_route` itself uses, so this clone is the only extra
        // cost `"mivnav"` pays over `"artifact"`, and it now pays it off
        // the GIL like everything else in this closure. Keeping it AFTER
        // the `?` above also keeps a no-route request from paying it at
        // all.
        //
        // The persisted-artifact path runs FIRST, and only its failure
        // pays for the clone below — the whole point of the precompute
        // split is that a served request does no region rebuild at all
        // (`crate::mivnav::persist`'s own module docs).
        let from_artifact = match (artifact_path.as_deref(), chart_set_id.as_deref()) {
            (None, _) => None,
            (Some(_), None) => Some(Err(
                "artifact_path was given without a chart_set_id, so the file's \
                 §19 identity could not be checked"
                    .to_string(),
            )),
            (Some(path), Some(id)) => Some(topology_from_artifact(
                path,
                crate::mivnav::ChartSetIdentity::new(id, chart_set_sequence),
                from_lon,
                from_lat,
                to_lon,
                to_lat,
                required_depth_m,
                endpoint_grace_radius_m,
                topology_weights,
                min_beam_dm,
                mivnav_directional_rules,
            )),
        };
        // `from_artifact` no longer short-circuits with an early return:
        // Phase 6's refinement needs the same `RefineInputs` regardless of
        // WHICH topology path produced them, so both paths converge here.
        let (from_artifact_ok, fallback_reason) = match from_artifact {
            Some(Ok(pair)) => (Some(pair), None),
            Some(Err(reason)) => (None, Some(reason)),
            None => (None, None),
        };
        let (mut topo, refine_inputs) = match from_artifact_ok {
            Some(pair) => pair,
            None => {
                // Owned, not borrowed: `build_region` (inside
                // `topology_diagnostics`) needs `&[Cell]`. Cloned HERE,
                // off the GIL, and only on the artifact-miss path — the
                // whole point of the precompute split is that a served
                // request does no region rebuild (`crate::mivnav::persist`
                // module docs).
                let owned: Vec<crate::model::Cell> = models.iter().map(|c| (*c).clone()).collect();
                topology_diagnostics(
                    &owned,
                    from_lon,
                    from_lat,
                    to_lon,
                    to_lat,
                    required_depth_m,
                    endpoint_grace_radius_m,
                    params.catzoc_mode,
                    topology_weights,
                    min_beam_dm,
                    mivnav_directional_rules,
                )
            }
        };
        topo.fallback_reason = fallback_reason;

        let refined = refine_fine_route(
            &fine,
            refine_inputs,
            min_beam_dm,
            &models,
            &weights,
            params.catzoc_mode,
            required_depth_m,
            required_air_draft_m,
            lateral_margin_m,
            allow_restricted_entry,
        );
        Some(MivnavRoute {
            inner: fine,
            topo,
            refined,
        })
    })
}

/// The COARSE portal-graph polyline for a `"mivnav"` request the ordinary
/// [`mivnav_route`] fine search could not answer — handed out by
/// [`mivnav_coarse_route`], consumed by the backend's
/// `_stitch_mivnav_coarse_route`, which runs the real draft-aware fine
/// search leg by leg between its points.
///
/// This is deliberately NOT a routable answer on its own (§8.4: the
/// topology is an acceleration structure, never the final word on
/// routability — only the per-leg fine search + §16 verification is). Its
/// only job is to escape `routing::raster`'s ±50 km straight-line
/// corridor cap for a detour that genuinely leaves it — around an island,
/// a peninsula, the whole top of a country — by using the portal graph's
/// region-global connectivity, which has no such cap. See
/// [`crate::mivnav::coarse`]'s own docs for why the hierarchical shape is
/// the only answer-preserving way to do that from outside
/// `routing::artifact`.
#[pyclass(module = "chartcore", frozen)]
struct MivnavCoarseRoute {
    /// `(lon, lat)`, in order, always at least `[from, to]`. Consecutive
    /// points are at least [`crate::mivnav::MIN_COARSE_LEG_M`] apart.
    waypoints: Vec<(f64, f64)>,
    /// Portal crossings on the underlying [`crate::mivnav::TopologyRoute`]
    /// — `waypoints.len()` is not this plus two, since near-duplicate
    /// crossings are merged and the endpoints are the caller's own.
    hops: u32,
    /// The topology route's own coarse tile-centre cost, millimetre
    /// fixed-point — diagnostics only, not the fine route's distance.
    cost_mm: i64,
    /// The band's connected-component count / portal count — the same two
    /// numbers [`MivnavRoute`]'s topology diagnostics report, for spotting
    /// an over-fragmented graph.
    components: u32,
    portals: u32,
    /// The [`crate::mivnav::BAND_LADDER_M`] rung this route was searched
    /// at (metres) — the conservative band for `required_depth_m`.
    band_m: f64,
}

#[pymethods]
impl MivnavCoarseRoute {
    #[getter]
    fn waypoints(&self) -> Vec<(f64, f64)> {
        self.waypoints.clone()
    }

    #[getter]
    fn hops(&self) -> u32 {
        self.hops
    }

    #[getter]
    fn cost_mm(&self) -> i64 {
        self.cost_mm
    }

    #[getter]
    fn components(&self) -> u32 {
        self.components
    }

    #[getter]
    fn portals(&self) -> u32 {
        self.portals
    }

    #[getter]
    fn band_m(&self) -> f64 {
        self.band_m
    }

    fn __repr__(&self) -> String {
        format!(
            "<MivnavCoarseRoute {} waypoints, {} hops, band={:.1}m, {} components, {} portals, cost={}mm>",
            self.waypoints.len(),
            self.hops,
            self.band_m,
            self.components,
            self.portals,
            self.cost_mm,
        )
    }
}

/// The COARSE portal-graph route for `from`->`to` over a persisted
/// `.mivnav`, for the backend to drive a leg-by-leg fine search along
/// when the ordinary [`mivnav_route`] fine search returns no path.
///
/// `Ok(None)` when the portal graph itself has no connection between the
/// two points at `required_depth_m` — genuinely not reachable by
/// navigable water at this draft, given the band ladder's quantised
/// feasibility (see [`crate::mivnav::query::select_band`]'s docs: a route
/// can still be missed for a draft between two rungs, so the caller must
/// not treat this as the last word either — but it is the last word this
/// layer can give). `Err` (a `ValueError`) when the artifact is missing,
/// unreadable, or §19-stale: the caller then reports "no artifact" and
/// routes a straight line, exactly as [`mivnav_route`]'s own
/// rebuild-and-say-why fallback does when it has no usable file.
///
/// `tss_avoidance_weight` / `fairway_preference_weight` /
/// `mivnav_directional_rules` mean exactly what they do on [`mivnav_route`]'s
/// own topology layer, and are threaded through here for the same reason:
/// this coarse route becomes the CORRIDOR the per-leg fine search is then
/// confined to, so if it were chosen distance-only it could route the
/// stitched legs straight through a TSS the request asked to soft-avoid,
/// or — with directional rules on — down a one-way channel the wrong way,
/// which no amount of per-leg weighting downstream can undo. Same
/// `TopologyWeights` + §11 semantics `topology_from_artifact` applies.
///
/// No fine search, no cell decode, no geometry rebuild — just the cached,
/// staleness-checked region plus one band's portal graph
/// ([`crate::mivnav::artifact_cache`]) and an A* over it
/// ([`crate::mivnav::topology_route_graced_demoting`]). Releases the GIL
/// like [`mivnav_route`].
#[pyfunction]
#[pyo3(signature = (
    from_lon, from_lat, to_lon, to_lat,
    artifact_path, chart_set_id, chart_set_sequence,
    required_depth_m,
    endpoint_grace_radius_m=150.0,
    tss_avoidance_weight=0.0,
    fairway_preference_weight=0.0,
    mivnav_directional_rules=false,
))]
#[allow(clippy::too_many_arguments)]
fn mivnav_coarse_route(
    py: Python<'_>,
    from_lon: f64,
    from_lat: f64,
    to_lon: f64,
    to_lat: f64,
    artifact_path: PathBuf,
    chart_set_id: String,
    chart_set_sequence: u64,
    required_depth_m: f64,
    endpoint_grace_radius_m: f64,
    tss_avoidance_weight: f64,
    fairway_preference_weight: f64,
    mivnav_directional_rules: bool,
) -> PyResult<Option<MivnavCoarseRoute>> {
    use crate::coords::{lat_lon_to_world, worldx_to_lon, worldy_to_lat};
    use crate::mivnav::{
        artifact_cache, band_to_dm, coarse_polyline_with_endpoints, select_band, select_band_index,
        topology_route_graced_demoting, ChartSetIdentity, TopologyWeights,
    };

    let topology_weights = TopologyWeights {
        tss_avoidance_weight,
        fairway_preference_weight,
    };

    py.detach(|| {
        let art = artifact_cache::get(
            &artifact_path,
            ChartSetIdentity::new(&chart_set_id, chart_set_sequence),
        )
        .map_err(PyValueError::new_err)?;
        let built = art.region();
        let band = art
            .band(select_band_index(required_depth_m))
            .map_err(PyValueError::new_err)?;
        // §11 directional / buoyage semantics, opt-in per request, read
        // straight off the artifact's own section — same as
        // `topology_from_artifact`. Skipped entirely when the flag is off.
        let semantics = mivnav_directional_rules.then(|| art.semantics());

        let from = lat_lon_to_world(from_lat, from_lon);
        let to = lat_lon_to_world(to_lat, to_lon);

        // `min_beam_dm = 0`: width demotion never CHANGES the route (a
        // demoted portal stays a full edge, it is only recorded), and the
        // coarse guide has no use for the recorded list — the per-leg fine
        // search is what verifies clearance. Everything else matches
        // `topology_from_artifact`'s own call.
        let Some((topo, _start, _goal)) = topology_route_graced_demoting(
            built,
            &band.portals,
            from,
            to,
            band_to_dm(required_depth_m),
            endpoint_grace_radius_m,
            0,
            semantics.as_deref(),
            topology_weights,
        ) else {
            return Ok(None);
        };

        let waypoints = coarse_polyline_with_endpoints(built, &band.portals, &topo, from, to)
            .iter()
            .map(|p| (worldx_to_lon(p.x), worldy_to_lat(p.y)))
            .collect();

        Ok(Some(MivnavCoarseRoute {
            waypoints,
            hops: topo.hops.len() as u32,
            cost_mm: topo.cost_mm,
            components: band.components.count,
            portals: band.portals.len() as u32,
            band_m: select_band(required_depth_m),
        }))
    })
}

/// Consume [`crate::mivnav::TopologyRoute::demoted_portals`] on the live
/// route: for each demoted crossing, refine the fine route's bracket
/// around it and keep the splice only if it survives the length and
/// draft-aware re-verification gates (see [`crate::mivnav::
/// refine_demoted_route`]). `None` — keep the fine route unchanged — when
/// the beam knob is off, no portal was demoted, or no splice survived.
///
/// # The re-verification set is wider than `ArtifactConstraints::hard`
///
/// The geometry solve inside [`crate::mivnav::refine_segment`] runs on
/// [`crate::mivnav::unit_cost`] — pure shortest path, blind to the soft
/// cost field the fine search uses. So a straighter splice could clip a
/// zone the fine search and topology layer both steered around. The
/// `verify_rings` handed to [`crate::mivnav::refine_demoted_route`] is
/// therefore `hard` PLUS the same-polarity blocking sets a bounded
/// splice would most obviously cut a corner of: `atba` (§10.3's
/// area-to-be-avoided) and the weighted `tss` / `caution` / `cable`
/// zones (only when their weight is `> 0`). A replacement leg that
/// crosses any of them is rejected and the fine route is kept.
///
/// NOT in this set, and deliberately: the §6 charted-depth SOFT tiers
/// (`depth_avoid` / `depth_soft`), for the same reason `preferred` /
/// `survey` / `turn_cost` are not — they are avoid-if-possible costs,
/// not blocks, and on a shallow harbour chart the 2–4 m band is
/// pervasive enough that hard-gating splices on it would suppress
/// refinement outright. And `UNSARE`: since the tiers landed it is not a
/// routing constraint at all, only a `check_manually` advisory —
/// unsurveyed water that is charted too shallow is already caught by
/// `hard`.
///
/// Two things this gate deliberately does NOT cover, both inverse-
/// polarity to a ring union and so not expressible as another
/// `verify_route_legs` set: the §9.3 no-coverage rule (water OUTSIDE
/// `coverage` blocks — the fine search rasterises `coverage` and
/// complements it, logic private to `routing::artifact::search`), and the
/// fine search's own per-leg grace bits, which `check_manually_legs` here
/// re-derives geometrically over `check_manually` (openable bridges +
/// UNSARE) rather than carrying forward. A fine route that graced through
/// a no-coverage gap far from the demoted crossing therefore keeps its
/// straight-line geometry in the refined route but loses that one
/// advisory `check_manually` bit. Bounded — the refinement bracket spans
/// covered fine-route waypoints ~400 m apart — but real: do not enable
/// `mivnav_beam_m` in a region with only partial M_COVR coverage.
///
/// # Cost
///
/// Building the constraint set means decoding hard geometry out of every
/// candidate cell — a second `build_constraints` after the one the fine
/// search already ran with identical inputs (code review flagged the
/// duplication; `route_with_constraints` would let it be built once, a
/// larger refactor of the frozen `routing::artifact` entry points). It is
/// only ever paid on a request that BOTH set a beam AND routes across a
/// demoted portal — [`topology_diagnostics`] / [`topology_from_artifact`]
/// do not even assemble [`RefineInputs`] otherwise.
#[allow(clippy::too_many_arguments)]
fn refine_fine_route(
    fine: &crate::routing::ArtifactRoute,
    inputs: Option<RefineInputs>,
    min_beam_dm: u16,
    models: &[&crate::model::Cell],
    weights: &crate::routing::ArtifactWeights,
    catzoc_mode: crate::routing::CatzocMode,
    required_depth_m: f64,
    required_air_draft_m: f64,
    lateral_margin_m: f64,
    allow_restricted_entry: bool,
) -> Option<MivnavRefined> {
    if min_beam_dm == 0 {
        return None;
    }
    let inputs = inputs?;
    if inputs.demoted.is_empty() || fine.waypoints.len() < 2 {
        return None;
    }

    let cparams = crate::routing::artifact::ConstraintParams {
        required_depth_m,
        // Depth-blind geometry solve; the §6 SOFT tiers do not apply to
        // a hard-pass/fail splice re-verification (same reason `preferred`
        // / `survey` / `turn_cost` are not in `verify_rings` either) — and
        // on a shallow harbour chart the 2–4 m band is pervasive, so
        // gating splices on it here just suppresses refinement entirely.
        // Shallow-ENOUGH unsurveyed water is already caught by `hard`.
        avoid_depth_m: 0.0,
        soft_prefer_depth_m: 0.0,
        required_air_draft_m,
        lateral_margin_m,
        catzoc_mode,
        allow_restricted_entry,
        // Geometry splice re-verification, not a `build_field` search —
        // `charted_depth` (coverage-complement grace only) is not read here.
        build_charted_depth: false,
    };
    let vc = crate::routing::artifact::build_query_constraints(models, &cparams);
    // Depth-blind rings for the geometry solve; an artifact predating the
    // `HazardRings` section, or a set with no hard hazard, leaves this
    // empty — fall back to the draft-aware set (a valid, if conservative,
    // input for `refine_segment` too).
    let refine_rings: &[Vec<crate::coords::WorldXy>] = if inputs.hazard_rings.is_empty() {
        &vc.hard
    } else {
        &inputs.hazard_rings
    };

    // The re-verification set: `hard`, plus the same-polarity blocking
    // sets the `unit_cost` solve is blind to (see this function's docs).
    // Cloned once here — bounded, and only on a genuine refinement
    // request.
    let mut verify_rings: Vec<Vec<crate::coords::WorldXy>> = vc.hard.clone();
    verify_rings.extend(vc.atba.iter().cloned());
    if weights.tss_avoidance_weight > 0.0 {
        verify_rings.extend(vc.tss.iter().cloned());
    }
    if weights.caution_area_avoidance_weight > 0.0 {
        verify_rings.extend(vc.caution.iter().cloned());
    }
    if weights.cable_avoidance_weight > 0.0 {
        verify_rings.extend(vc.cable.iter().cloned());
    }

    let fine_world: Vec<crate::coords::WorldXy> = fine
        .waypoints
        .iter()
        .map(|&(lon, lat)| crate::coords::lat_lon_to_world(lat, lon))
        .collect();
    let refined = crate::mivnav::refine_demoted_route(
        &fine_world,
        &inputs.built,
        &inputs.portals,
        &inputs.demoted,
        refine_rings,
        &verify_rings,
        &crate::mivnav::unit_cost,
        crate::mivnav::RefineParams::DEFAULT,
    )?;

    let lonlat: Vec<(f64, f64)> = refined
        .waypoints
        .iter()
        .map(|&p| {
            (
                crate::coords::worldx_to_lon(p.x),
                crate::coords::worldy_to_lat(p.y),
            )
        })
        .collect();

    // Re-derive the per-leg flags for the whole refined polyline: the
    // splice changed the leg set, and the fine search's own vectors no
    // longer line up with it. `check_manually_legs` here is the charted-
    // feature crossing test only (openable bridges + UNSARE, no per-leg
    // §9.3 grace bit) — acceptable since that flag never shapes or
    // refuses a route; see this function's docs for the one bounded
    // no-coverage case it can under-report.
    let approximate_legs = crate::routing::raster::verify_route_legs(&lonlat, &vc.hard);
    let check_manually_legs =
        crate::routing::raster::verify_route_legs(&lonlat, &vc.check_manually);

    Some(MivnavRefined {
        waypoints: lonlat,
        distance_m: refined.distance_m,
        approximate_legs,
        check_manually_legs,
        refined_portals: refined.refined_portals,
    })
}

/// Bridges [`crate::mivnav::BuildProgress`] to a Python callable
/// `progress(phase: str, done: int, total: int, note: str | None)`.
///
/// `report` re-acquires the GIL (the build runs inside `py.detach`) — a
/// few dozen times per national build, never per tile, so the cost is
/// noise. A raising callback is swallowed and printed, never propagated:
/// progress reporting must not be able to fail a build. `Py<PyAny>` is
/// `Send + Sync`, so this satisfies `BuildProgress: Sync` and can be
/// shared across the band sweep's `rayon` threads.
struct PyProgress {
    cb: Py<PyAny>,
}

impl crate::mivnav::BuildProgress for PyProgress {
    fn report(&self, phase: &str, done: u64, total: u64, note: Option<&str>) {
        Python::attach(|py| {
            if let Err(e) = self.cb.call1(py, (phase, done, total, note)) {
                e.print(py);
            }
        });
    }
}

/// Build a `.mivnav` artifact for a whole chart set and publish it at
/// `path` — the manual build trigger's own chartcore half
/// ([`crate::mivnav::build_and_publish_region_streaming`]: each depth
/// band is written to the file and dropped before the next is built, so
/// a national build never holds all ten finished bands resident and does
/// not thrash swap the way the in-memory publish did — see that
/// function's own docs for the measured numbers).
///
/// `cells` is the WHOLE chart set decoded, not a per-request corridor
/// selection: §6 forbids the build from knowing any vessel's draft, so it
/// precomputes every rung of the band ladder over the whole region or
/// none of it. That makes this `O(bands × region size)` — ten sweeps
/// where a query does one — which is exactly the cost the architecture
/// exists to move OFF the request path. Do not call this from one.
///
/// `catzoc_allowance_mode` is the one legitimate build-time policy knob
/// ([`crate::mivnav::build_region`]'s own docs): a survey-confidence
/// policy for the whole artifact, not a property of any boat. It is NOT
/// recorded in the file, so a caller that can build under more than one
/// mode must keep the modes in separate files — which is what the
/// backend's own `artifact_path_for` does.
///
/// Returns §20's "record per run" ([`MivnavBuildReport`]) — the only
/// signal anyone gets that the build saw the charts it should have.
///
/// Raises `ValueError` for an empty/degenerate `cells`, and `OSError` for
/// a publish that could not be written.
///
/// Releases the GIL: this runs for minutes on a real region. `progress`,
/// when given, is called back (GIL re-acquired) at each refine pass, as
/// each of the ten depth bands is built and streamed out, and around the
/// final file flush — see [`PyProgress`].
#[pyfunction]
#[pyo3(signature = (
    path, chart_set_id, chart_set_sequence, cells, catzoc_allowance_mode="full", progress=None,
))]
fn mivnav_build_artifact(
    py: Python<'_>,
    path: PathBuf,
    chart_set_id: &str,
    chart_set_sequence: u64,
    cells: Vec<PyRef<'_, Cell>>,
    catzoc_allowance_mode: &str,
    progress: Option<Py<PyAny>>,
) -> PyResult<MivnavBuildReport> {
    use crate::coords::Extent;

    let models: Vec<&crate::model::Cell> = cells.iter().map(|c| c.tiler.cell()).collect();
    let mut region_extent = Extent::invalid();
    for c in &models {
        region_extent.extend(&c.extent);
    }
    if !region_extent.valid {
        return Err(PyValueError::new_err(
            "no usable chart cell to build a .mivnav from (empty cell list, or every \
             cell's own extent is degenerate)",
        ));
    }
    let identity = crate::mivnav::ChartSetIdentity::new(chart_set_id, chart_set_sequence);
    let catzoc_mode = crate::routing::CatzocMode::parse(catzoc_allowance_mode);
    let cell_count = models.len() as u32;

    let sink = progress.map(|cb| PyProgress { cb });
    let summary = py.detach(|| {
        // Owned for the same reason `mivnav_route`'s own clone is:
        // `build_region` needs `&[Cell]`, not `&[&Cell]`. Inside the
        // detached closure, so a whole chart set's clone never holds the
        // GIL.
        let owned: Vec<crate::model::Cell> = models.iter().map(|c| (*c).clone()).collect();
        let prog = sink
            .as_ref()
            .map(|p| p as &(dyn crate::mivnav::BuildProgress + '_));
        // The STREAMING publish: each band is written to the artifact as
        // it is built and then dropped, so a national build never holds
        // all ten finished bands resident waiting for the write — which
        // on a 16 GB box meant swapping them out and paging ~35 GB back
        // in (`MIVNAV_NEXT_TASKS.md`'s national-build measurement). The
        // bytes are identical to `build_and_publish_region_reporting`'s;
        // it just never holds the whole `RegionArtifact` at once, so
        // there is nothing to hand back but §20's report + the per-band
        // totals.
        crate::mivnav::build_and_publish_region_streaming(
            &path,
            identity,
            &owned,
            region_extent,
            catzoc_mode,
            prog,
        )
    })?;

    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let report = summary.report;
    Ok(MivnavBuildReport {
        path: path.to_string_lossy().into_owned(),
        bytes,
        cell_count,
        tile_count: report.tile_count,
        vector_required_tiles: report.vector_required_tiles,
        total_cells: report.total_cells,
        blocked_cells: report.blocked_cells,
        no_coverage_cells: report.no_coverage_cells,
        charted_depth_cells: report.charted_depth_cells,
        tiles_per_rung: report.tiles_per_rung.to_vec(),
        resolution_ladder_m: crate::routing::artifact::ladder::RESOLUTION_LADDER_M.to_vec(),
        bands: summary.bands,
        portals: summary.portals,
        shortcuts: summary.shortcuts,
    })
}

/// §20's "record per run" for one [`mivnav_build_artifact`] call.
///
/// Every field here answers "did the build see the charts it should
/// have". `crate::mivnav::persist`'s own docs record why this cannot be
/// recovered later: [`crate::mivnav::BuildReport`] is not persisted (and
/// `charted_depth_cells` is not even recomputable from the persisted
/// columns), so a build trigger that does not surface these numbers when
/// it has them throws away the only evidence there is.
#[pyclass(module = "chartcore", frozen, get_all)]
struct MivnavBuildReport {
    /// Where the artifact was published.
    path: String,
    /// Its size on disk.
    bytes: u64,
    /// How many decoded chart cells went in — a zero-ish number here
    /// against a chart set that has hundreds is the "the build saw
    /// nothing" symptom this report exists to make visible.
    cell_count: u32,
    tile_count: u32,
    vector_required_tiles: u32,
    total_cells: u64,
    blocked_cells: u64,
    no_coverage_cells: u64,
    charted_depth_cells: u64,
    /// Tiles at each rung of `resolution_ladder_m`, same index.
    tiles_per_rung: Vec<u32>,
    /// The rung sizes in metres, so a caller need not hardcode the
    /// ladder to label `tiles_per_rung`.
    resolution_ladder_m: Vec<f64>,
    /// Bands written — every rung of `BAND_LADDER_M`.
    bands: u32,
    /// Portals summed over every band.
    portals: u64,
    /// Chain-contracted shortcuts summed over every band.
    shortcuts: u64,
}

#[pymethods]
impl MivnavBuildReport {
    fn __repr__(&self) -> String {
        format!(
            "<MivnavBuildReport {} tiles, {} cells, {} bands, {} portals, {} bytes>",
            self.tile_count, self.total_cells, self.bands, self.portals, self.bytes
        )
    }
}

/// Whether the `.mivnav` at `path` may be used for this chart set right
/// now, and if not, precisely why — [`crate::mivnav::ArtifactReader::
/// staleness`] (§19) plus the two states it cannot describe because they
/// stop the file being opened at all (absent, unreadable).
///
/// Returns a dict:
///
/// * `present` — the path exists and parsed as a `.mivnav`.
/// * `usable` — present AND current for `(chart_set_id,
///   chart_set_sequence)` at this build's [`crate::mivnav::
///   ArtifactVersions::CURRENT`].
/// * `reason` — human text when not usable, `None` when it is.
/// * `kind` — machine-readable: `"missing"`, `"unreadable"`,
///   `"chart_set"`, `"sequence"`, `"versions"`, or `None` when usable.
/// * `bytes`, `built_sequence`, `current_sequence`.
///
/// Never raises: "is there a usable artifact" is a question a status
/// endpoint asks about a path that very often does not exist yet.
#[pyfunction]
#[pyo3(signature = (path, chart_set_id, chart_set_sequence))]
fn mivnav_artifact_status<'py>(
    py: Python<'py>,
    path: PathBuf,
    chart_set_id: &str,
    chart_set_sequence: u64,
) -> PyResult<Bound<'py, PyDict>> {
    use crate::mivnav::{ArtifactReader, ArtifactVersions, ChartSetIdentity, Staleness};

    let d = PyDict::new(py);
    d.set_item("path", path.to_string_lossy())?;
    d.set_item("current_sequence", chart_set_sequence)?;
    d.set_item("bytes", std::fs::metadata(&path).map(|m| m.len()).ok())?;
    d.set_item("built_sequence", py.None())?;

    if !path.exists() {
        d.set_item("present", false)?;
        d.set_item("usable", false)?;
        d.set_item("kind", "missing")?;
        d.set_item(
            "reason",
            format!("no .mivnav has been built at {}", path.to_string_lossy()),
        )?;
        return Ok(d);
    }

    let reader = match ArtifactReader::from_file(&path) {
        Ok(r) => r,
        Err(e) => {
            d.set_item("present", false)?;
            d.set_item("usable", false)?;
            d.set_item("kind", "unreadable")?;
            d.set_item("reason", format!("artifact could not be opened: {e}"))?;
            return Ok(d);
        }
    };
    d.set_item("present", true)?;
    d.set_item("built_sequence", reader.header().chart_set.sequence)?;

    let identity = ChartSetIdentity::new(chart_set_id, chart_set_sequence);
    match reader.staleness(identity, &ArtifactVersions::CURRENT) {
        None => {
            d.set_item("usable", true)?;
            d.set_item("kind", py.None())?;
            d.set_item("reason", py.None())?;
        }
        Some(stale) => {
            d.set_item("usable", false)?;
            d.set_item(
                "kind",
                match stale {
                    Staleness::ChartSet { .. } => "chart_set",
                    Staleness::Sequence { .. } => "sequence",
                    Staleness::Versions(_) => "versions",
                },
            )?;
            d.set_item("reason", stale.to_string())?;
        }
    }
    Ok(d)
}

/// `(hits, misses)` for the process-global opened-`.mivnav` cache
/// ([`crate::mivnav::artifact_cache`]) since the process started. A hit
/// answered a `/routing/plan` request with an already-open artifact (no
/// file read, no region decode); a miss read and decoded one, or failed
/// its §19 staleness check. Diagnostics / test hook only — nothing on the
/// serve path reads it.
#[pyfunction]
fn mivnav_artifact_cache_stats() -> (u64, u64) {
    crate::mivnav::artifact_cache::cache_stats()
}

/// Begin counting degenerate serve-time geometry ops into a breadcrumb.
/// Name kept for the backend's `status()` contract (predates the
/// GEOS→pure-Rust swap); now arms `geom_log`. Idempotent, opt-in.
#[pyfunction]
fn install_gdal_log() {
    crate::geom_log::install();
}

/// Geometry-op breadcrumb since `install_gdal_log`, or None if never armed:
/// `{"warnings","failures","debug","recent"}` — name/shape are the backend's
/// `status()` contract; counts track pure-Rust ops producing unusable residue.
#[pyfunction]
fn gdal_log(py: Python<'_>) -> Option<Py<PyDict>> {
    let log = crate::geom_log::captured()?;
    let d = PyDict::new(py);
    d.set_item("warnings", log.warnings).ok()?;
    d.set_item("failures", log.failures).ok()?;
    d.set_item("debug", log.debug).ok()?;
    d.set_item("recent", log.recent).ok()?;
    Some(d.unbind())
}

/// Provoke a degenerate geometry op for testing the breadcrumb above. The
/// pure-Rust backend no longer raises on this input, so this records a
/// synthetic entry, keeping the `TopologyException` string the backend's test asserts on.
#[pyfunction]
fn provoke_gdal_error_for_test() {
    let _ = crate::geom_log::note::<()>(
        None,
        "TopologyException: provoked degenerate geometry op (test hook)",
    );
}

/// Merge encoded MVT tiles (same z/x/y) into one: same-named layers combine,
/// feature order preserved — pass coarse-to-detailed so detail draws on top.
#[pyfunction]
fn merge_tiles(py: Python<'_>, tiles: Vec<Vec<u8>>) -> PyResult<Py<PyBytes>> {
    let merged = py.detach(|| crate::mvt::merge::merge_tiles(&tiles));
    match merged {
        Ok(data) => Ok(PyBytes::new(py, &data).unbind()),
        Err(e) => Err(ChartError::new_err(format!("tile merge failed: {e}"))),
    }
}

/// Like [`merge_tiles`], but stamps each `tiles[i]`'s features with a `"set"`
/// tag naming `set_ids[i]` (`set_ids.len()` must equal `tiles.len()`). Used by
/// `/tiles/all` and `/poi/tiles/all` (POI needs no per-cell reconciliation).
#[pyfunction]
fn merge_tiles_tagged(
    py: Python<'_>,
    tiles: Vec<Vec<u8>>,
    set_ids: Vec<Option<String>>,
) -> PyResult<Py<PyBytes>> {
    if set_ids.len() != tiles.len() {
        return Err(ChartError::new_err(format!(
            "merge_tiles_tagged: {} tiles but {} set_ids",
            tiles.len(),
            set_ids.len()
        )));
    }
    let merged = py.detach(|| crate::mvt::merge::merge_tiles_tagged(&tiles, &set_ids));
    match merged {
        Ok(data) => Ok(PyBytes::new(py, &data).unbind()),
        Err(e) => Err(ChartError::new_err(format!("tile merge failed: {e}"))),
    }
}

/// Like [`merge_tiles`], but reconciles each point's SCAMIN gate to the most
/// permissive value across `donors` (same cells cut WITHOUT masking) — fixes
/// multi-cell SCAMIN winking. `z` sizes the point-fuse tolerance in ground distance.
#[pyfunction]
fn merge_tiles_reconciled(
    py: Python<'_>,
    masked: Vec<Vec<u8>>,
    donors: Vec<Vec<u8>>,
    z: u8,
) -> PyResult<Py<PyBytes>> {
    let merged = py.detach(|| crate::mvt::merge::merge_tiles_reconciled(&masked, &donors, z));
    match merged {
        Ok(data) => Ok(PyBytes::new(py, &data).unbind()),
        Err(e) => Err(ChartError::new_err(format!("tile merge failed: {e}"))),
    }
}

/// Encoded MVT tile containing only a whole-tile `_nodata` polygon — the
/// set-level no-data claim. Tile-independent: same bytes for every z/x/y.
#[pyfunction]
fn nodata_tile(py: Python<'_>) -> Py<PyBytes> {
    PyBytes::new(py, &crate::mvt::nodata_tile()).unbind()
}

/// Call `serve_tile`/`serve_tile_union`'s `admit` hook (see their `admit`
/// param) with the caller-side indices of every cell the tile will load:
/// kept cells, then donors (donors are only loaded when there is more than
/// one — mirror that here so the caller meters exactly what gets loaded).
/// Generic over the spec tuple so both entry points share it.
fn admit_cells<S: SpecIndex>(
    py: Python<'_>,
    admit: Option<&Py<PyAny>>,
    specs: &[S],
    kept: &[usize],
    donors: &[usize],
) -> PyResult<()> {
    let Some(admit) = admit else { return Ok(()) };
    let mut idx: Vec<usize> = kept.iter().map(|&ci| specs[ci].index()).collect();
    if donors.len() > 1 {
        idx.extend(donors.iter().map(|&ci| specs[ci].index()));
    }
    admit.call1(py, (idx,))?;
    Ok(())
}

/// The caller's own index carried in slot 0 of a serve spec tuple.
trait SpecIndex {
    fn index(&self) -> usize;
}
impl<A, B, C, D> SpecIndex for (usize, A, B, C, D) {
    fn index(&self) -> usize {
        self.0
    }
}
impl<A, B, C, D, E> SpecIndex for (usize, A, B, C, D, E) {
    fn index(&self) -> usize {
        self.0
    }
}

/// The whole serve pipeline below the cache: reference-scale selection +
/// cut + coverage-mask + SCAMIN-reconciled merge, in one call. `specs`:
/// `(index, scale, max_zoom, name, coverage)`, `index` fed back to `load_cell`.
#[pyfunction]
#[pyo3(signature = (specs, z, x, y, over_zoom, under_zoom, detail_gap, overview_detail_cutoff, max_cells, chart_detail, chart_detail_spread, chart_detail_anchor, parallelism, claim_allowed, load_cell, set_max_zoom=None, admit=None))]
#[allow(clippy::too_many_arguments)]
fn serve_tile(
    py: Python<'_>,
    specs: Vec<(usize, u32, u8, String, Option<Py<Coverage>>)>,
    z: u8,
    x: u32,
    y: u32,
    over_zoom: u8,
    under_zoom: u8,
    detail_gap: u8,
    overview_detail_cutoff: u8,
    max_cells: usize,
    // SCAMIN bias (mvt::ScaminBias): feature shows iff display_scale_denom(z)
    // <= bias.effective(scamin), scamin' = A·(scamin/A)^k. Only the final
    // drop, not selection; clamped to sane bands by `ScaminBias::new`.
    chart_detail: f64,
    chart_detail_spread: f64,
    chart_detail_anchor: f64,
    // Threads of the shared bounded cut pool this tile may use. `1` = exact
    // serial path; `>1` cuts cells in parallel but reassembles in the same
    // order, so output is byte-identical. See docs/architecture/mvt-cut-pool.md.
    parallelism: usize,
    claim_allowed: bool,
    load_cell: Py<PyAny>,
    // The set's advertised tileset max_zoom (the one tile SCAMIN drop must
    // exempt from overzoom). None falls back to the max per-cell max_zoom
    // charting this tile — safe (never drops) but under-declutters some tiles.
    set_max_zoom: Option<u8>,
    // Admission hook (#MEM-GATE): called ONCE, after selection and before any
    // cell is loaded, with the caller's indices (`specs[_].0`) of every cell
    // this tile will actually load — kept cells then donors. The caller blocks
    // in it until it may spend the memory those cells cost (a low-zoom union
    // tile can decode and cut several hundred MB of cells, and the peak is
    // ~3x their on-disk size), or raises (e.g. `TimeoutError`) to refuse; the
    // error propagates out of this call unchanged. Release is the CALLER's
    // job (a `finally` around this call), so no exit path here can leak an
    // admission. `None` = unmetered, the pre-#MEM-GATE behaviour.
    admit: Option<Py<PyAny>>,
) -> PyResult<(
    Option<Py<PyBytes>>,
    Option<(bool, usize, usize, Vec<(String, u32)>)>,
)> {
    use crate::mvt::select::{select, CellDesc, Knobs};

    // Selection — coverage rings + scalars only, no decode.
    let (kept, masks, donors, claims_nodata, overflow) = {
        // `Coverage` is a frozen pyclass, so `Py::get` hands out `&inner`
        // without a borrow guard — which is what lets selection run with the
        // GIL RELEASED. It is not cheap: on the real DE/NL/DK union a
        // low-zoom tile's select over a 400-600-cell pool measured 1-2 s on
        // the dev box, and holding the GIL for that froze every other
        // request, the websocket and the event loop along with it.
        let descs: Vec<CellDesc<'_, crate::coverage::Coverage>> = specs
            .iter()
            .map(|s| CellDesc {
                scale: s.1,
                max_zoom: s.2,
                name: &s.3,
                coverage: s.4.as_ref().map(|c| &c.get().inner),
            })
            .collect();
        let knobs = Knobs {
            over_zoom,
            under_zoom,
            detail_gap,
            overview_detail_cutoff,
            max_cells,
        };
        let sel = py.detach(|| select(&descs, z, x, y, &knobs));
        (
            sel.kept,
            sel.masks,
            sel.donors,
            sel.claims_nodata,
            sel.overflow,
        )
    };
    let overflow_out = overflow.map(|o| (o.rescued, o.kept_before_trim, o.cap, o.dropped));
    admit_cells(py, admit.as_ref(), &specs, &kept, &donors)?;

    let parallelism = parallelism.clamp(1, PARALLELISM_MAX);

    let mut cuts: Vec<Vec<u8>> = Vec::new();
    if claim_allowed && claims_nodata {
        cuts.push(crate::mvt::nodata_tile());
    }
    // Donor cuts (unmasked) for SCAMIN reconciliation — only when >1 donor.
    let mut donor_cuts: Vec<Vec<u8>> = Vec::new();
    let want_donors = donors.len() > 1;

    if parallelism <= 1 {
        for (pos, &ci) in kept.iter().enumerate() {
            // `masks[pos]`, not `kept[pos + 1..]`: only a strictly finer kept
            // cell may mask (#vzvprkqo — see `select::Selection::masks`).
            let finer: Vec<Py<Coverage>> = masks[pos]
                .iter()
                .filter_map(|&j| specs[j].4.as_ref().map(|c| c.clone_ref(py)))
                .collect();
            let cell = load_cell.call1(py, (specs[ci].0,))?;
            let cut: Option<Vec<u8>> = cell
                .call_method1(py, "cut", (z, x, y, finer))?
                .extract(py)?;
            if let Some(data) = cut {
                cuts.push(data);
            }
        }
        if want_donors {
            for &ci in &donors {
                let cell = load_cell.call1(py, (specs[ci].0,))?;
                let none: Option<Vec<Py<Coverage>>> = None;
                let d: Option<Vec<u8>> =
                    cell.call_method1(py, "cut", (z, x, y, none))?.extract(py)?;
                if let Some(data) = d {
                    donor_cuts.push(data);
                }
            }
        }
    } else {
        // Fan per-cell cuts across the shared rayon pool. GIL-held loading of
        // decoded `Cell`s must happen HERE so the geometry cut (py.detach)
        // touches no Python object; handles live in these Vecs for lifetime.
        let kept_objs: Vec<Py<PyAny>> = kept
            .iter()
            .map(|&ci| load_cell.call1(py, (specs[ci].0,)))
            .collect::<PyResult<_>>()?;
        let kept_cells: Vec<&Cell> = kept_objs
            .iter()
            .map(|o| {
                o.bind(py)
                    .downcast::<Cell>()
                    .map(|b| b.get())
                    .map_err(PyErr::from)
            })
            .collect::<PyResult<_>>()?;
        let kept_tasks: Vec<crate::mvt::CutTask<'_>> = kept_cells
            .iter()
            .enumerate()
            .map(|(pos, cell)| crate::mvt::CutTask {
                tiler: &cell.tiler,
                // `masks[pos]` — see the serial branch above (#vzvprkqo).
                finer: masks[pos]
                    .iter()
                    .filter_map(|&j| specs[j].4.as_ref().map(|c| &c.bind(py).get().inner))
                    .collect(),
            })
            .collect();

        let donor_objs: Vec<Py<PyAny>> = if want_donors {
            donors
                .iter()
                .map(|&ci| load_cell.call1(py, (specs[ci].0,)))
                .collect::<PyResult<_>>()?
        } else {
            Vec::new()
        };
        let donor_cells: Vec<&Cell> = donor_objs
            .iter()
            .map(|o| {
                o.bind(py)
                    .downcast::<Cell>()
                    .map(|b| b.get())
                    .map_err(PyErr::from)
            })
            .collect::<PyResult<_>>()?;
        let donor_tasks: Vec<crate::mvt::CutTask<'_>> = donor_cells
            .iter()
            .map(|cell| crate::mvt::CutTask {
                tiler: &cell.tiler,
                finer: Vec::new(),
            })
            .collect();

        let (kept_res, donor_res) = py.detach(|| {
            (
                crate::mvt::cut_tiles(&kept_tasks, z, x, y, parallelism),
                crate::mvt::cut_tiles(&donor_tasks, z, x, y, parallelism),
            )
        });
        cuts.extend(kept_res.into_iter().flatten());
        donor_cuts.extend(donor_res.into_iter().flatten());
    }
    if cuts.is_empty() {
        return Ok((None, overflow_out));
    }

    let merged = if !donor_cuts.is_empty() {
        py.detach(|| crate::mvt::merge::merge_tiles_reconciled(&cuts, &donor_cuts, z))
            .map_err(|e| ChartError::new_err(format!("tile merge failed: {e}")))?
    } else if cuts.len() == 1 {
        cuts.into_iter().next().expect("len == 1")
    } else {
        py.detach(|| crate::mvt::merge::merge_tiles(&cuts))
            .map_err(|e| ChartError::new_err(format!("tile merge failed: {e}")))?
    };
    // Drop features SCAMIN would hide at integer zoom z, unless this is the
    // overzoomed finest tile (z >= max_zoom). Runs AFTER reconciliation, so a
    // legitimately loosened gate is respected.
    let max_zoom = set_max_zoom.unwrap_or_else(|| specs.iter().map(|s| s.2).max().unwrap_or(0));
    let bias = ScaminBias::new(chart_detail, chart_detail_spread, chart_detail_anchor);
    let merged = py
        .detach(|| crate::mvt::drop_scamin_hidden_tile(&merged, z, max_zoom, bias))
        .map_err(|e| ChartError::new_err(format!("scamin drop failed: {e}")))?;
    if merged.is_empty() {
        return Ok((None, overflow_out));
    }
    Ok((Some(PyBytes::new(py, &merged).unbind()), overflow_out))
}

/// Every z/x/y in `min_zoom..=max_zoom` that some cell charts, coarsest zoom
/// first: the disk pre-render plan. `cells` is `(extent (w, s, e, n), coverage
/// or None)` per cell. See `chartcore::mvt::plan` — the backend's Python
/// planner (`CellWarmer._pretile_tiles`) is the reference it matches.
#[pyfunction]
fn charted_tiles(
    py: Python<'_>,
    cells: Vec<((f64, f64, f64, f64), Option<PyRef<'_, Coverage>>)>,
    min_zoom: u8,
    max_zoom: u8,
) -> Vec<(u8, u32, u32)> {
    let cells: Vec<(crate::mvt::plan::Extent, Option<&crate::coverage::Coverage>)> = cells
        .iter()
        .map(|((w, s, e, n), c)| ([*w, *s, *e, *n], c.as_ref().map(|c| &c.inner)))
        .collect();
    py.detach(|| crate::mvt::plan::charted_tiles(&cells, min_zoom, max_zoom))
}

/// The union serve pipeline for `/tiles/all`: same selection as
/// [`serve_tile`], run once over pooled cells from every subscribed chart
/// set, plus per-feature `"set"` tags. See docs/architecture/ocharts-union-tile.md.
#[pyfunction]
#[pyo3(signature = (specs, z, x, y, over_zoom, under_zoom, detail_gap, overview_detail_cutoff, max_cells, chart_detail, chart_detail_spread, chart_detail_anchor, parallelism, claim_allowed, load_cell, set_max_zoom=None, admit=None))]
#[allow(clippy::too_many_arguments)]
fn serve_tile_union(
    py: Python<'_>,
    // (index, scale, max_zoom, name, coverage, set_id): set_id is the only
    // addition over `serve_tile`'s specs, carried purely for the "set" tag.
    specs: Vec<(usize, u32, u8, String, Option<Py<Coverage>>, String)>,
    z: u8,
    x: u32,
    y: u32,
    over_zoom: u8,
    under_zoom: u8,
    detail_gap: u8,
    overview_detail_cutoff: u8,
    max_cells: usize,
    chart_detail: f64,
    chart_detail_spread: f64,
    chart_detail_anchor: f64,
    // Same parallelism knob, clamp, and byte-identical guarantee as `serve_tile`.
    parallelism: usize,
    claim_allowed: bool,
    load_cell: Py<PyAny>,
    set_max_zoom: Option<u8>,
    // Admission hook (#MEM-GATE): called ONCE, after selection and before any
    // cell is loaded, with the caller's indices (`specs[_].0`) of every cell
    // this tile will actually load — kept cells then donors. The caller blocks
    // in it until it may spend the memory those cells cost (a low-zoom union
    // tile can decode and cut several hundred MB of cells, and the peak is
    // ~3x their on-disk size), or raises (e.g. `TimeoutError`) to refuse; the
    // error propagates out of this call unchanged. Release is the CALLER's
    // job (a `finally` around this call), so no exit path here can leak an
    // admission. `None` = unmetered, the pre-#MEM-GATE behaviour.
    admit: Option<Py<PyAny>>,
) -> PyResult<(
    Option<Py<PyBytes>>,
    Option<(bool, usize, usize, Vec<(String, u32)>)>,
)> {
    use crate::mvt::merge::{merge_tiles_reconciled_tagged, merge_tiles_tagged};
    use crate::mvt::select::{select, CellDesc, Knobs};

    let (kept, masks, donors, claims_nodata, overflow) = {
        // `Coverage` is a frozen pyclass, so `Py::get` hands out `&inner`
        // without a borrow guard — which is what lets selection run with the
        // GIL RELEASED. It is not cheap: on the real DE/NL/DK union a
        // low-zoom tile's select over a 400-600-cell pool measured 1-2 s on
        // the dev box, and holding the GIL for that froze every other
        // request, the websocket and the event loop along with it.
        let descs: Vec<CellDesc<'_, crate::coverage::Coverage>> = specs
            .iter()
            .map(|s| CellDesc {
                scale: s.1,
                max_zoom: s.2,
                name: &s.3,
                coverage: s.4.as_ref().map(|c| &c.get().inner),
            })
            .collect();
        let knobs = Knobs {
            over_zoom,
            under_zoom,
            detail_gap,
            overview_detail_cutoff,
            max_cells,
        };
        let sel = py.detach(|| select(&descs, z, x, y, &knobs));
        (
            sel.kept,
            sel.masks,
            sel.donors,
            sel.claims_nodata,
            sel.overflow,
        )
    };
    let overflow_out = overflow.map(|o| (o.rescued, o.kept_before_trim, o.cap, o.dropped));
    admit_cells(py, admit.as_ref(), &specs, &kept, &donors)?;

    let parallelism = parallelism.clamp(1, PARALLELISM_MAX);

    let mut cuts: Vec<Vec<u8>> = Vec::new();
    let mut cut_set_ids: Vec<Option<String>> = Vec::new();
    if claim_allowed && claims_nodata {
        cuts.push(crate::mvt::nodata_tile());
        // The whole-tile claim has no single owning set.
        cut_set_ids.push(None);
    }
    let want_donors = donors.len() > 1;
    let mut donor_cuts: Vec<Vec<u8>> = Vec::new();

    if parallelism <= 1 {
        for (pos, &ci) in kept.iter().enumerate() {
            // `masks[pos]`, not `kept[pos + 1..]`: only a strictly finer kept
            // cell may mask (#vzvprkqo — see `select::Selection::masks`).
            let finer: Vec<Py<Coverage>> = masks[pos]
                .iter()
                .filter_map(|&j| specs[j].4.as_ref().map(|c| c.clone_ref(py)))
                .collect();
            let cell = load_cell.call1(py, (specs[ci].0,))?;
            let cut: Option<Vec<u8>> = cell
                .call_method1(py, "cut", (z, x, y, finer))?
                .extract(py)?;
            if let Some(data) = cut {
                cuts.push(data);
                cut_set_ids.push(Some(specs[ci].5.clone()));
            }
        }
        if want_donors {
            for &ci in &donors {
                let cell = load_cell.call1(py, (specs[ci].0,))?;
                let none: Option<Vec<Py<Coverage>>> = None;
                let d: Option<Vec<u8>> =
                    cell.call_method1(py, "cut", (z, x, y, none))?.extract(py)?;
                if let Some(data) = d {
                    donor_cuts.push(data);
                }
            }
        }
    } else {
        // Mirrors `serve_tile`'s parallel branch; additionally zips each
        // kept cut back with `specs[ci].5` so `cut_set_ids` stays aligned
        // with `cuts` (see docs/architecture/ocharts-union-tile.md).
        let kept_objs: Vec<Py<PyAny>> = kept
            .iter()
            .map(|&ci| load_cell.call1(py, (specs[ci].0,)))
            .collect::<PyResult<_>>()?;
        let kept_cells: Vec<&Cell> = kept_objs
            .iter()
            .map(|o| {
                o.bind(py)
                    .downcast::<Cell>()
                    .map(|b| b.get())
                    .map_err(PyErr::from)
            })
            .collect::<PyResult<_>>()?;
        let kept_tasks: Vec<crate::mvt::CutTask<'_>> = kept_cells
            .iter()
            .enumerate()
            .map(|(pos, cell)| crate::mvt::CutTask {
                tiler: &cell.tiler,
                // `masks[pos]` — see the serial branch above (#vzvprkqo).
                finer: masks[pos]
                    .iter()
                    .filter_map(|&j| specs[j].4.as_ref().map(|c| &c.bind(py).get().inner))
                    .collect(),
            })
            .collect();

        let donor_objs: Vec<Py<PyAny>> = if want_donors {
            donors
                .iter()
                .map(|&ci| load_cell.call1(py, (specs[ci].0,)))
                .collect::<PyResult<_>>()?
        } else {
            Vec::new()
        };
        let donor_cells: Vec<&Cell> = donor_objs
            .iter()
            .map(|o| {
                o.bind(py)
                    .downcast::<Cell>()
                    .map(|b| b.get())
                    .map_err(PyErr::from)
            })
            .collect::<PyResult<_>>()?;
        let donor_tasks: Vec<crate::mvt::CutTask<'_>> = donor_cells
            .iter()
            .map(|cell| crate::mvt::CutTask {
                tiler: &cell.tiler,
                finer: Vec::new(),
            })
            .collect();

        let (kept_res, donor_res) = py.detach(|| {
            (
                crate::mvt::cut_tiles(&kept_tasks, z, x, y, parallelism),
                crate::mvt::cut_tiles(&donor_tasks, z, x, y, parallelism),
            )
        });
        for (&ci, cut) in kept.iter().zip(kept_res) {
            if let Some(data) = cut {
                cuts.push(data);
                cut_set_ids.push(Some(specs[ci].5.clone()));
            }
        }
        donor_cuts.extend(donor_res.into_iter().flatten());
    }
    if cuts.is_empty() {
        return Ok((None, overflow_out));
    }

    // Always through the tagging merge — see docs/architecture/ocharts-union-tile.md.
    let merged = if !donor_cuts.is_empty() {
        py.detach(|| merge_tiles_reconciled_tagged(&cuts, &cut_set_ids, &donor_cuts, z))
            .map_err(|e| ChartError::new_err(format!("tile merge failed: {e}")))?
    } else {
        py.detach(|| merge_tiles_tagged(&cuts, &cut_set_ids))
            .map_err(|e| ChartError::new_err(format!("tile merge failed: {e}")))?
    };
    let max_zoom = set_max_zoom.unwrap_or_else(|| specs.iter().map(|s| s.2).max().unwrap_or(0));
    let bias = ScaminBias::new(chart_detail, chart_detail_spread, chart_detail_anchor);
    let merged = py
        .detach(|| crate::mvt::drop_scamin_hidden_tile(&merged, z, max_zoom, bias))
        .map_err(|e| ChartError::new_err(format!("scamin drop failed: {e}")))?;
    if merged.is_empty() {
        return Ok((None, overflow_out));
    }
    Ok((Some(PyBytes::new(py, &merged).unbind()), overflow_out))
}

/// DIAGNOSTIC: reference-scale selection for a tile, no decode. Returns
/// `(kept, rescued, claims_nodata)`; same inputs as `serve_tile`'s
/// selection, for reproducing seam decisions from a script.
#[pyfunction]
#[allow(clippy::too_many_arguments)]
fn select_debug(
    py: Python<'_>,
    specs: Vec<(usize, u32, u8, String, Option<Py<Coverage>>)>,
    z: u8,
    x: u32,
    y: u32,
    over_zoom: u8,
    under_zoom: u8,
    detail_gap: u8,
    overview_detail_cutoff: u8,
    max_cells: usize,
) -> PyResult<(Vec<(String, u32, u8)>, bool, bool)> {
    use crate::mvt::select::{select, CellDesc, Knobs};
    let guards: Vec<Option<PyRef<'_, Coverage>>> = specs
        .iter()
        .map(|s| s.4.as_ref().map(|c| c.borrow(py)))
        .collect();
    let descs: Vec<CellDesc<'_, crate::coverage::Coverage>> = specs
        .iter()
        .zip(&guards)
        .map(|(s, g)| CellDesc {
            scale: s.1,
            max_zoom: s.2,
            name: &s.3,
            coverage: g.as_ref().map(|r| &r.inner),
        })
        .collect();
    let sel = select(
        &descs,
        z,
        x,
        y,
        &Knobs {
            over_zoom,
            under_zoom,
            detail_gap,
            overview_detail_cutoff,
            max_cells,
        },
    );
    let kept = sel
        .kept
        .iter()
        .map(|&i| (descs[i].name.to_string(), descs[i].scale, descs[i].max_zoom))
        .collect();
    Ok((kept, sel.rescued, sel.claims_nodata))
}

/// Layer names present in an encoded MVT tile (tests/diagnostics).
#[pyfunction]
fn tile_layers(tile: Vec<u8>) -> PyResult<Vec<String>> {
    let decoded = decode_tile(&tile).map_err(|e| ChartError::new_err(e))?;
    Ok(decoded.layers.into_iter().map(|l| l.name).collect())
}

/// Feature tag dicts of one layer in an encoded MVT tile
/// (tests/diagnostics; empty when the layer is absent).
#[pyfunction]
fn tile_feature_tags<'py>(
    py: Python<'py>,
    tile: Vec<u8>,
    layer: &str,
) -> PyResult<Vec<Bound<'py, PyDict>>> {
    use crate::mvt::TagValue;
    let decoded = decode_tile(&tile).map_err(|e| ChartError::new_err(e))?;
    let mut out = Vec::new();
    for l in decoded.layers.into_iter().filter(|l| l.name == layer) {
        for f in &l.features {
            let d = PyDict::new(py);
            for (k, v) in &f.tags {
                match v {
                    TagValue::Str(s) => d.set_item(k, s)?,
                    TagValue::Double(x) => d.set_item(k, x)?,
                    TagValue::Int(i) => d.set_item(k, i)?,
                    TagValue::Bool(b) => d.set_item(k, b)?,
                }
            }
            out.push(d);
        }
    }
    Ok(out)
}

/// (min_zoom, max_zoom) for a chart's compilation scale.
#[pyfunction]
fn zoom_range_for_scale(scale: u32) -> (u8, u8) {
    crate::mvt::zoom_range_for_scale(scale)
}

/// Ensure the pinned `oexserverd` vendor binary exists in `cache_dir`
/// (public download, skipped when present); returns the executable path.
#[pyfunction]
fn ensure_daemon(py: Python<'_>, cache_dir: PathBuf) -> PyResult<String> {
    let path = py
        .detach(|| crate::oex::ensure_daemon(&cache_dir))
        .map_err(|e| DaemonError::new_err(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Generate the system fingerprint via `oexserverd -g`: returns
/// (fpr_file_name, hex_value) — the shop's (xfprName, xfpr).
#[pyfunction]
#[pyo3(signature = (daemon, tmp_dir, timeout=60.0))]
fn get_fingerprint(
    py: Python<'_>,
    daemon: PathBuf,
    tmp_dir: PathBuf,
    timeout: f64,
) -> PyResult<(String, String)> {
    let fpr = py
        .detach(|| crate::oex::get_fingerprint(&daemon, &tmp_dir, Duration::from_secs_f64(timeout)))
        .map_err(oex_err)?;
    Ok((fpr.name, fpr.value_hex))
}

/// `props` dict → typed MVT tags: `str` → string, `bool` → bool (checked
/// before `int` — Python `bool` is an `int` subclass), `int` → sint,
/// `float` → double. Shared by [`build_pmtiles`]/[`build_vector_pmtiles`].
fn dict_to_tags(
    py: Python<'_>,
    props: &Py<PyDict>,
) -> PyResult<Vec<(String, crate::mvt::TagValue)>> {
    use crate::mvt::TagValue;
    let mut tags: Vec<(String, TagValue)> = Vec::new();
    for (k, v) in props.bind(py).iter() {
        let key: String = k.extract()?;
        let tag = if let Ok(b) = v.downcast::<pyo3::types::PyBool>() {
            TagValue::Bool(b.is_true())
        } else if let Ok(s) = v.extract::<String>() {
            TagValue::Str(s)
        } else if let Ok(i) = v.extract::<i64>() {
            TagValue::Int(i)
        } else if let Ok(f) = v.extract::<f64>() {
            TagValue::Double(f)
        } else {
            return Err(PyValueError::new_err(format!(
                "unsupported tag value type for key {key:?}: {}",
                v.get_type().name()?
            )));
        };
        tags.push((key, tag));
    }
    Ok(tags)
}

/// Feature's start zoom (rank tier) from the `min_zoom` prop; also stays an
/// MVT tag for the frontend's label sort-key. Clamped to `0..=max_zoom` so
/// an out-of-range rank still lands at the deepest tile (visible via overzoom).
fn feature_min_zoom(py: Python<'_>, props: &Py<PyDict>, max_zoom: u8) -> PyResult<Option<u8>> {
    Ok(props
        .bind(py)
        .get_item("min_zoom")?
        .and_then(|v| v.extract::<i64>().ok())
        .map(|z| z.clamp(0, max_zoom as i64) as u8))
}

/// Bake point features into an MVT PMTiles archive (gdal-free ingest-bake).
/// A feature's integer `min_zoom` prop places it only from that rank
/// upward, so low zooms stay light; absent/non-int tiles across full range.
#[pyfunction]
fn build_pmtiles(
    py: Python<'_>,
    features: Vec<(f64, f64, Py<PyDict>)>,
    layer: String,
    min_zoom: u8,
    max_zoom: u8,
    out: PathBuf,
) -> PyResult<usize> {
    use crate::coords::LLBox;
    use crate::mvt::{build_point_tileset, PointFeature};
    use crate::pmtiles::{write_archive_to_path, ArchiveInfo};

    if min_zoom > max_zoom {
        return Err(PyValueError::new_err(format!(
            "empty zoom range {min_zoom}..{max_zoom}"
        )));
    }
    if max_zoom >= 32 {
        return Err(PyValueError::new_err("max_zoom must be < 32"));
    }

    // Tag conversion on the GIL (cheap); tiling below detaches.
    let mut points: Vec<PointFeature> = Vec::with_capacity(features.len());
    let (mut w, mut e, mut s, mut n) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for (lon, lat, props) in &features {
        let tags = dict_to_tags(py, props)?;
        let feat_min_zoom = feature_min_zoom(py, props, max_zoom)?;

        w = w.min(*lon);
        e = e.max(*lon);
        s = s.min(*lat);
        n = n.max(*lat);
        points.push(PointFeature {
            lon: *lon,
            lat: *lat,
            tags,
            min_zoom: feat_min_zoom,
        });
    }

    let bounds = if points.is_empty() {
        LLBox::default()
    } else {
        LLBox {
            w_lon: w,
            e_lon: e,
            s_lat: s,
            n_lat: n,
        }
    };

    let ((tiles, info), _) = py.detach(|| {
        let ts = build_point_tileset(&points, &layer, min_zoom, max_zoom);
        let info = ArchiveInfo {
            name: layer.clone(),
            bounds,
            min_zoom,
            max_zoom,
            layers: ts.layers.iter().cloned().collect(),
        };
        ((ts.tiles, info), ())
    });

    let count = tiles.len();
    write_archive_to_path(&out, &tiles, &info)
        .map_err(|e| ChartError::new_err(format!("writing {}: {e}", out.display())))?;
    Ok(count)
}

/// Bake point AND line features into one multi-layer MVT archive — the
/// line-capable sibling of [`build_pmtiles`], used by the OSM basemap bake
/// (`mivnav.features.osm.ingest`). No polygons yet (v1).
#[pyfunction]
fn build_vector_pmtiles(
    py: Python<'_>,
    point_layers: Vec<(String, Vec<(f64, f64, Py<PyDict>)>)>,
    line_layers: Vec<(String, Vec<(Vec<(f64, f64)>, Py<PyDict>)>)>,
    min_zoom: u8,
    max_zoom: u8,
    out: PathBuf,
) -> PyResult<usize> {
    use crate::coords::LLBox;
    use crate::mvt::{build_layer_tileset, VectorFeature, VectorGeom};
    use crate::pmtiles::{write_archive_to_path, ArchiveInfo};

    if min_zoom > max_zoom {
        return Err(PyValueError::new_err(format!(
            "empty zoom range {min_zoom}..{max_zoom}"
        )));
    }
    if max_zoom >= 32 {
        return Err(PyValueError::new_err("max_zoom must be < 32"));
    }

    let (mut w, mut e, mut s, mut n) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    let mut named_layers: Vec<(String, Vec<VectorFeature>)> = Vec::new();

    for (name, features) in &point_layers {
        let mut out_feats = Vec::with_capacity(features.len());
        for (lon, lat, props) in features {
            let tags = dict_to_tags(py, props)?;
            let feat_min_zoom = feature_min_zoom(py, props, max_zoom)?;
            w = w.min(*lon);
            e = e.max(*lon);
            s = s.min(*lat);
            n = n.max(*lat);
            out_feats.push(VectorFeature {
                geom: VectorGeom::Point(*lon, *lat),
                tags,
                min_zoom: feat_min_zoom,
            });
        }
        named_layers.push((name.clone(), out_feats));
    }

    for (name, features) in &line_layers {
        let mut out_feats = Vec::with_capacity(features.len());
        for (coords, props) in features {
            if coords.len() < 2 {
                continue;
            }
            let tags = dict_to_tags(py, props)?;
            let feat_min_zoom = feature_min_zoom(py, props, max_zoom)?;
            for &(lon, lat) in coords {
                w = w.min(lon);
                e = e.max(lon);
                s = s.min(lat);
                n = n.max(lat);
            }
            out_feats.push(VectorFeature {
                geom: VectorGeom::Line(coords.clone()),
                tags,
                min_zoom: feat_min_zoom,
            });
        }
        named_layers.push((name.clone(), out_feats));
    }

    let bounds = if w > e {
        LLBox::default()
    } else {
        LLBox {
            w_lon: w,
            e_lon: e,
            s_lat: s,
            n_lat: n,
        }
    };

    let ((tiles, info), _) = py.detach(|| {
        let layer_refs: Vec<(&str, &[VectorFeature])> = named_layers
            .iter()
            .map(|(name, feats)| (name.as_str(), feats.as_slice()))
            .collect();
        let ts = build_layer_tileset(&layer_refs, min_zoom, max_zoom);
        let info = ArchiveInfo {
            name: "osm".to_string(),
            bounds,
            min_zoom,
            max_zoom,
            layers: ts.layers.iter().cloned().collect(),
        };
        ((ts.tiles, info), ())
    });

    let count = tiles.len();
    write_archive_to_path(&out, &tiles, &info)
        .map_err(|e| ChartError::new_err(format!("writing {}: {e}", out.display())))?;
    Ok(count)
}

/// Bake raster XYZ tiles into a PMTiles v3 archive, streaming — the
/// gdal-free raster counterpart of [`build_pmtiles`]; replaces the former
/// Python writer. See docs/architecture/satellite-raster-pmtiles-writer.md.
#[pyfunction]
fn build_raster_pmtiles(
    py: Python<'_>,
    out: PathBuf,
    tiles: Bound<'_, PyAny>,
    name: String,
    bounds: (f64, f64, f64, f64),
    min_zoom: u8,
    max_zoom: u8,
    tile_type: u8,
    tile_format: String,
) -> PyResult<usize> {
    use crate::pmtiles::{
        finish_raster_archive, spool_raster_tiles, RasterArchiveInfo, RasterTile,
    };

    if min_zoom > max_zoom {
        return Err(PyValueError::new_err(format!(
            "empty zoom range {min_zoom}..{max_zoom}"
        )));
    }

    let (w, s, e, n) = bounds;
    let info = RasterArchiveInfo {
        name,
        bounds: LLBox {
            w_lon: w,
            e_lon: e,
            s_lat: s,
            n_lat: n,
        },
        min_zoom,
        max_zoom,
        tile_type,
        tile_format,
    };

    // Pass 1: drive under the GIL; extract each tile's bytes as a borrowed
    // &[u8] view — `Vec<u8>: FromPyObject` would copy element-by-element,
    // disastrously slow for 100 KB+ imagery tiles.
    let source_error = |e: PyErr| io::Error::other(e.to_string());
    let rust_iter = tiles
        .try_iter()?
        .map(move |item| -> io::Result<RasterTile> {
            let item = item.map_err(source_error)?;
            let (z, x, y, data): (u8, u32, u32, Bound<'_, PyBytes>) =
                item.extract().map_err(source_error)?;
            Ok((z, x, y, data.as_bytes().to_vec()))
        });
    let spooled = spool_raster_tiles(&out, rust_iter)
        .map_err(|e| ChartError::new_err(format!("writing {}: {e}", out.display())))?;

    // Pass 2 touches no Python object — release the GIL for it.
    let count = py
        .detach(|| finish_raster_archive(&out, &spooled, &info))
        .map_err(|e| ChartError::new_err(format!("writing {}: {e}", out.display())))?;
    Ok(count)
}

/// Is this file a chart this bridge can open, and does it need the daemon?
/// Returns "oesu" / "oesenc" / "senc" or None.
#[pyfunction]
fn chart_kind(path: PathBuf) -> Option<&'static str> {
    match ChartKind::from_path(&path)? {
        ChartKind::Oesu => Some("oesu"),
        ChartKind::Oesenc => Some("oesenc"),
        ChartKind::Senc => Some("senc"),
    }
}

/// Render one ATON symbol key to a pivot-centred SVG, or None for a
/// non-ATON key (frontend treats a 404 as expected, not an error). `roles`
/// swaps day colours for `#fe00XX` theme-substitution sentinels; default day paint.
#[pyfunction]
#[pyo3(signature = (key, roles = false))]
fn render_aton_icon(py: Python<'_>, key: &str, roles: bool) -> Option<String> {
    let mode = if roles {
        crate::icons::ColourMode::Roles
    } else {
        crate::icons::ColourMode::Day
    };
    // Pure CPU over a &str — no Python objects touched, so release the GIL.
    py.detach(|| crate::icons::pack::render_with(key, mode).ok())
}

#[pymodule]
pub fn chartcore(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", crate::version())?;
    m.add("ChartError", m.py().get_type::<ChartError>())?;
    m.add("DecryptError", m.py().get_type::<DecryptError>())?;
    m.add("ExpiredError", m.py().get_type::<ExpiredError>())?;
    m.add("DaemonError", m.py().get_type::<DaemonError>())?;
    m.add_class::<Daemon>()?;
    m.add_class::<Cell>()?;
    m.add_class::<S52>()?;
    m.add_class::<Coverage>()?;
    m.add_class::<HazardIndex>()?;
    m.add_class::<LandHazardBake>()?;
    m.add_class::<RoutePath>()?;
    m.add_class::<GraphRoute>()?;
    m.add_class::<ArtifactRoute>()?;
    m.add_class::<MivnavRoute>()?;
    m.add_class::<MivnavCoarseRoute>()?;
    m.add_class::<MivnavBuildReport>()?;
    m.add_function(wrap_pyfunction!(charted_tiles, m)?)?;
    m.add_function(wrap_pyfunction!(shortest_path, m)?)?;
    m.add_function(wrap_pyfunction!(resimplify_route, m)?)?;
    m.add_function(wrap_pyfunction!(verify_route, m)?)?;
    m.add_function(wrap_pyfunction!(refine_route, m)?)?;
    m.add_function(wrap_pyfunction!(routing_corridor_bbox, m)?)?;
    m.add_function(wrap_pyfunction!(macro_route, m)?)?;
    m.add_function(wrap_pyfunction!(graph_route, m)?)?;
    m.add_function(wrap_pyfunction!(artifact_route, m)?)?;
    m.add_function(wrap_pyfunction!(artifact_route_debug, m)?)?;
    m.add_function(wrap_pyfunction!(mivnav_route, m)?)?;
    m.add_function(wrap_pyfunction!(mivnav_coarse_route, m)?)?;
    m.add_function(wrap_pyfunction!(mivnav_build_artifact, m)?)?;
    m.add_function(wrap_pyfunction!(mivnav_artifact_status, m)?)?;
    m.add_function(wrap_pyfunction!(mivnav_artifact_cache_stats, m)?)?;
    m.add_function(wrap_pyfunction!(s52_default_cache_dir, m)?)?;
    m.add_function(wrap_pyfunction!(read_header, m)?)?;
    m.add_function(wrap_pyfunction!(merge_tiles, m)?)?;
    m.add_function(wrap_pyfunction!(merge_tiles_tagged, m)?)?;
    m.add_function(wrap_pyfunction!(merge_tiles_reconciled, m)?)?;
    m.add_function(wrap_pyfunction!(install_gdal_log, m)?)?;
    m.add_function(wrap_pyfunction!(gdal_log, m)?)?;
    m.add_function(wrap_pyfunction!(provoke_gdal_error_for_test, m)?)?;
    m.add_function(wrap_pyfunction!(nodata_tile, m)?)?;
    m.add_function(wrap_pyfunction!(serve_tile, m)?)?;
    m.add_function(wrap_pyfunction!(serve_tile_union, m)?)?;
    m.add_function(wrap_pyfunction!(select_debug, m)?)?;
    m.add_function(wrap_pyfunction!(tile_layers, m)?)?;
    m.add_function(wrap_pyfunction!(tile_feature_tags, m)?)?;
    m.add_function(wrap_pyfunction!(zoom_range_for_scale, m)?)?;
    m.add_function(wrap_pyfunction!(ensure_daemon, m)?)?;
    m.add_function(wrap_pyfunction!(get_fingerprint, m)?)?;
    m.add_function(wrap_pyfunction!(chart_kind, m)?)?;
    m.add_function(wrap_pyfunction!(build_pmtiles, m)?)?;
    m.add_function(wrap_pyfunction!(build_vector_pmtiles, m)?)?;
    m.add_function(wrap_pyfunction!(build_raster_pmtiles, m)?)?;
    m.add_function(wrap_pyfunction!(render_aton_icon, m)?)?;
    Ok(())
}
