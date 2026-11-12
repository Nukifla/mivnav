// Client for the server's own configuration (GET/PATCH /api/config) — a fact
// about the *boat*, every screen sees the same value, unlike persist.ts's
// per-device localStorage. One client for the whole document, so two panels can't disagree.

import type { CollisionSettings } from "./collisionSettings";
import type { GnssSettings } from "./gnssSettings";
import type { ShallowSettings } from "./shallow";
import { batch, createSignal, type Accessor } from "solid-js";
import { bumpChartEpoch } from "./chartProtocol";
import { DEFAULT_SCAMIN_ANCHOR, NEUTRAL_SCAMIN_BIAS, type ScaminBias } from "./style/expr";
import type { Region } from "./settings/regions";

/** Chart-detail bias `B` bounds — mirror mivnav.features.ocharts.service
 * CHART_DETAIL_MIN/MAX (and chartcore.serve_tile's own last-line clamp). */
export const CHART_DETAIL_MIN = 0.1;
export const CHART_DETAIL_MAX = 10;
export const DEFAULT_CHART_DETAIL = 1;

/** Clamp a raw chart-detail bias into the sane band; non-finite → neutral 1. */
export const clampChartDetail = (b: number): number =>
  Number.isFinite(b) ? Math.min(CHART_DETAIL_MAX, Math.max(CHART_DETAIL_MIN, b)) : DEFAULT_CHART_DETAIL;

/** Turn-on SPREAD `k` bounds — mirror mivnav.features.ocharts.service
 * CHART_DETAIL_SPREAD_MIN/_MAX (chartcore's `SCAMIN_SPREAD_MIN/MAX`). Second
 * half of the SCAMIN bias (#qqlzrkkn): `B` shifts turn-on zoom, `k` spaces it. */
export const CHART_DETAIL_SPREAD_MIN = 0.1;
export const CHART_DETAIL_SPREAD_MAX = 2;
export const DEFAULT_CHART_DETAIL_SPREAD = 1;

/** Clamp a raw spread into the sane band; non-finite → neutral 1. */
export const clampChartDetailSpread = (k: number): number =>
  Number.isFinite(k)
    ? Math.min(CHART_DETAIL_SPREAD_MAX, Math.max(CHART_DETAIL_SPREAD_MIN, k))
    : DEFAULT_CHART_DETAIL_SPREAD;

// The boat-wide SCAMIN bias, mirrored as a module GLOBAL (parallel to
// chartProtocol's `chartEpoch`) so the chart style can read it without
// threading the controller. Defaults to neutral: "no bias yet", never wrong.
const [scaminBias, setScaminBiasSignal] = createSignal<ScaminBias>(NEUTRAL_SCAMIN_BIAS);
export { scaminBias };

// Boat-wide "Beta autorouting" switch (`routing.beta_enabled`), mirrored as a
// global like `scaminBias` so the map chrome can gate the auto-router UI
// without the lazily-mounted settings controller. Off until the server says on.
const [betaAutorouting, setBetaAutorouting] = createSignal(false);
export { betaAutorouting };
/** Tests only — the app sets it from the server config. */
export const setBetaAutoroutingForTest = setBetaAutorouting;

/** Just the `B` multiplier of {@link scaminBias} — the historical accessor
 * for call sites that only ever cared about it. */
export const chartDetail = (): number => scaminBias().detail;

/** Read the three bias numbers off a config payload, clamped, falling back
 * to neutral. One function so `seedChartDetail`/`accept` can't drift. */
const biasFromConfig = (oc: Partial<OchartsServerConfig> | undefined): ScaminBias => ({
  detail: typeof oc?.chart_detail === "number" ? clampChartDetail(oc.chart_detail) : 1,
  spread:
    typeof oc?.chart_detail_spread === "number"
      ? clampChartDetailSpread(oc.chart_detail_spread)
      : DEFAULT_CHART_DETAIL_SPREAD,
  anchor:
    typeof oc?.chart_detail_anchor === "number" && oc.chart_detail_anchor > 0
      ? oc.chart_detail_anchor
      : DEFAULT_SCAMIN_ANCHOR,
});

/** o-charts service tunables. Every one of these was a `MIVNAV_*` env var
 * until removed, so this object + a text editor are now the only way to
 * reach them. Budgets in bytes, rescan in seconds. */
export interface OchartsServerConfig {
  daemon_dir: string;
  work_dir: string;
  /** null = auto-detect chartcore's fetched S-52 cache — a real setting,
   * not "unset"; unlike the password, null here means null. */
  s52_path: string | null;
  /** RAM byte-LRU budgets — shared `*_budget_bytes` vocabulary (M-DATA-2).
   * o-charts has four: decoded cells, rendered tiles, `/routing/plan`'s
   * HazardIndex unions, and per-cell LandHazardBakes. */
  cell_budget_bytes: number;
  tile_budget_bytes: number;
  hazard_budget_bytes: number;
  land_bake_budget_bytes: number;
  /** NOT a cache: the admission budget for cold tile renders running at once,
   * in estimated peak RAM (3x the on-disk bytes of the cells each render loads;
   * mivnav.features.ocharts.admission). A heavier render still runs, alone. */
  render_budget_bytes: number;
  /** Persistent disk cache of rendered `/tiles/all` tiles (survives restarts;
   * mivnav.features.ocharts.disk_tiles). A disk budget, not RAM; 0 disables. */
  tile_disk_dir: string;
  tile_disk_budget_bytes: number;
  /** Pre-render every charted union tile down to this zoom into the disk
   * cache, in idle time. null disables pre-rendering. */
  pretile_max_zoom: number | null;
  /** Check the shop about daily and install newer editions of the installed
   * sets, replacing the old ones (OchartsConfig.auto_update). */
  auto_update: boolean;
  /** Rescan/refresh interval, seconds (shared `*_interval_s` vocabulary). */
  rescan_interval_s: number;
  /** Decode overview cells in the background so a cold viewport isn't a
   * stack of serialized ~400ms decodes (OchartsConfig.prefetch). */
  prefetch: boolean;
  // Serving-detail tuning (mivnav.features.ocharts.config.OchartsConfig):
  // experimental, hot-applied knobs surfaced in "Chart detail (advanced)".
  /** Zooms FINER than the reference the primary band reaches (old
   * `serving_headroom`, the dominant cold-decode cost). */
  over_zoom: number;
  /** Zooms COARSER than the reference that still count as normal chart
   * (vs. overzoomed rescue). */
  under_zoom: number;
  /** Staircase trigger: a region this many zooms coarser than the finest
   * detail present gets a finer cell pulled in. Keep small (1). */
  detail_gap: number;
  /** Upper bound on how many zooms FINER than the reference the detail fill
   * may reach — beyond it content is SCAMIN-hidden anyway. Must be > over_zoom. */
  overview_detail_cutoff: number;
  /** Last-resort SAFETY GUARD on cells compositing into one tile — should
   * never bite the authoritative set; backend logs loudly if it does. */
  max_cells_per_tile: number;
  /** Boat-wide chart-detail bias `B` (OchartsConfig.chart_detail): a
   * multiplier on every feature's SCAMIN gate — boat-wide because the server
   * hard-drops SCAMIN-hidden features off the shared tile. */
  chart_detail: number;
  /** Turn-on SPREAD `k` + anchor `A` (OchartsConfig.chart_detail_spread/
   * _anchor): `chart_detail` shifts every turn-on zoom uniformly; `k` warps
   * the spacing instead (`scamin' = A·(scamin/A)^k`). `k=1` is un-spread. */
  chart_detail_spread: number;
  chart_detail_anchor: number;
  /** Threads chartcore's process-global cut pool uses per-cell
   * (OchartsConfig.parallelism) — pure Pi-throughput knob, output is
   * byte-identical regardless. Clamped to [1, PARALLELISM_MAX]. */
  parallelism: number;
}

/** Whether the boat's active leg tracks SignalK's own course
 * (mivnav.features.route.config.NavConfig). mivnav no longer runs its own
 * route-following (#yprzuqtt) — it reacts to SignalK's own arrivals instead. */
export interface NavServerConfig {
  /** Adopt SignalK's reported course as the active leg, and advance it on
   * SignalK's own arrival notifications. `false` = the leg only ever moves
   * when a human presses GO. */
  course_sync: boolean;
  /** How close (metres) a SignalK-reported course point must be to one of
   * mivnav's own waypoints to count as the same point. */
  course_match_tolerance_m: number;
}

/** Safety depth/margin and several optional soft preferences for
 * `POST /routing/plan` (mivnav.features.routing.config.RoutingConfig) —
 * shallow-water, TSS avoidance, fairway preference, buoyage-side
 * avoidance, cable/pipeline avoidance, caution-area avoidance. Each
 * preference's own weight is OFF at `0` — see the individual fields' own
 * docs. */
export interface RoutingServerConfig {
  /** Show the auto-router UI (route editor, "Go here", its settings). Beta, off by default. */
  beta_enabled: boolean;
  /** Metres. Fallback draft when a plan request omits `draft_m` and
   * SignalK has no fix/no draft reported. */
  default_draft_m: number;
  /** Metres, added to draft to get the depth a router must treat as
   * unsafe. */
  under_keel_margin_m: number;
  /** Metres, HARD lateral clearance from a charted hazard's own boundary
   * — buffered directly into the hazard union before the search runs. */
  lateral_margin_m: number;
  /** Metres, the boat's own mast height above the waterline — a HARD
   * block: a bridge/overhead cable the boat cannot clear joins the
   * unsafe-water union outright, the same way a too-shallow depth area
   * does. `0` (the default) means OFF — no bridge/cable is ever
   * consulted, unlike the depth fields above (which are always-on hard
   * thresholds with a conservative placeholder default): there is no
   * sane universal non-zero default for a mast height, and a wrong guess
   * risks letting a route pass under a bridge that does not actually
   * clear. */
  air_draft_m: number;
  /** Metres beyond `lateral_margin_m` the soft shallow-water preference
   * still has some pull. Moot while `shallow_avoidance_weight` is `0`. */
  shallow_avoidance_radius_m: number;
  /** How strongly the search prefers water further from a hazard, within
   * `shallow_avoidance_radius_m` — `0` is OFF (today's plain
   * shortest-distance search). */
  shallow_avoidance_weight: number;
  /** How strongly the search prefers avoiding TSS-family zones (traffic
   * lanes, roundabouts, crossings, precautionary areas) — `0` is OFF. A
   * FLAT in-zone penalty, unlike the shallow-water field above: the full
   * weight applies everywhere inside the zone, not just a thin band near
   * its edge. Never a hard block — the router still crosses directly
   * when no reasonable alternative exists. */
  tss_avoidance_weight: number;
  /** How strongly the search prefers the "preferred route" family — a
   * marked fairway, recommended track, navigation line, or deep-water
   * route part, unioned into one shared preference — when one already
   * connects the route — `0` is OFF; never forces a detour into one that
   * doesn't actually help. */
  fairway_preference_weight: number;
  /** How strongly the search prefers avoiding a submarine cable or
   * pipeline (`CBLSUB`/`PIPSOL`) — `0` is OFF. A FLAT in-zone penalty
   * like `tss_avoidance_weight`, no distance falloff. A SEPARATE weight
   * from `caution_area_avoidance_weight` below — a genuinely different
   * kind of concern (protecting ground tackle/seabed infrastructure) —
   * not one shared dial. Briefly crossing a cable, as most routes
   * roughly perpendicular to the coast must, costs little regardless:
   * what this discourages is running ALONG one for real distance. Never
   * a hard block. */
  cable_avoidance_weight: number;
  /** How strongly the search prefers avoiding an anchorage
   * (`ACHARE`), caution area (`CTNARE`), or permitted-transit
   * restricted/military-practice area (`RESARE`/`MIPARE` not legally
   * entry-prohibited) — `0` is OFF. A FLAT in-zone penalty like
   * `tss_avoidance_weight`. These three share ONE weight: the router has
   * no way to distinguish them more precisely than "navigate here with
   * more general caution". Never a hard block — an entry-prohibited
   * `RESARE`/`MIPARE` is already a HARD block elsewhere (the safety
   * depth/margin fields above), never counted here too. */
  caution_area_avoidance_weight: number;
  /** How strongly the search prefers avoiding a charted low-confidence
   * survey — an `M_QUAL` zone whose CATZOC (Category of Zone of
   * Confidence) reads C, D, or U, or carries no CATZOC at all — `0` is
   * OFF. A FLAT in-zone penalty like `tss_avoidance_weight`, no distance
   * falloff. A genuinely different, more precise fact than chart
   * compilation scale: a large-scale harbour chart can still be compiled
   * from an old or coarse survey. Never a hard block. */
  low_confidence_survey_avoidance_weight: number;
  /** How strongly the search penalises a HEADING CHANGE, per grid step
   * DURING the search itself — not a zone/distance term like every other
   * field above; it costs a turn, not a place. `0` is OFF (today's plain
   * search, whose only zigzag cleanup is a post-hoc geometric shortcut
   * pass). Scales with how SHARP the turn is: a gentle 45° bend costs
   * less than a 90°+ one — a route curving through small bends to round a
   * headland or thread a channel is normal, not the pathology this
   * discourages; a route sawing back and forth is. Never a hard block —
   * a genuinely necessary sharp turn still gets taken, just at a real,
   * bounded extra cost. */
  turn_cost_weight: number;
  /** §6 charted-depth soft tiers — `artifact`/`mivnav` engines only, on
   * top of the hard depth floor (`default_draft_m + under_keel_margin_m`).
   * Water charted in `(floor, avoid_depth_below_m]` costs
   * `avoid_depth_weight` (heavy — taken only when there's no way around);
   * water in `(avoid_depth_below_m, soft_prefer_depth_below_m]` costs
   * `soft_prefer_depth_weight` (light "prefer deeper"). A preference on
   * charted depth VALUE, not distance from a hazard edge. All `0` is OFF. */
  avoid_depth_below_m: number;
  avoid_depth_weight: number;
  soft_prefer_depth_below_m: number;
  soft_prefer_depth_weight: number;
  /** `"A"`/`"B"` — the IALA buoyage region a lateral mark's `COLOUR` is
   * read against when the mark itself carries no `CATLAM`. Only a
   * fallback: a chart's own charted `M_NSYS`/`MARSYS` meta-object, when
   * present, wins over this default. */
  iala_region: "A" | "B";
  /** Metres — how far from a lateral mark (`BOYLAT`/`BCNLAT`) the "wrong
   * side" preference below reaches. A FLAT in-zone penalty like
   * `tss_avoidance_weight`, not distance-graded. */
  buoyage_avoidance_radius_m: number;
  /** How strongly the search prefers passing a lateral mark on its
   * charted-correct side (port-hand kept to port, starboard-hand to
   * starboard, for the direction actually being sailed) — `0` is OFF.
   * Scoped to pure lateral marks only, not preferred-channel or
   * cardinal/isolated-danger/safe-water marks. Never a hard block. */
  buoyage_avoidance_weight: number;
  /** Try a coarse, land-only macro pass when the ordinary per-leg search
   * (even after its own recursive refinement) still comes back badly
   * unreachable — the fix for a request that can only be completed by a
   * real detour around a whole landmass (e.g. ~150nm off the direct
   * line), entirely outside the ordinary search's own corridor by
   * construction. Default ON. When it fires, the response's own warning
   * text always says plainly that a long automatic detour has not been
   * checked for bridge/lock/cable clearance. */
  macro_route_enabled: boolean;
  /** Which engine `POST /routing/plan` uses: `"raster"` (the built-in
   * chartcore search, every field above); `"routeiq"` (a remote call to a
   * real signalk-routeiq plugin instance over the boat's own SignalK
   * connection — see `meta.routeiq_token_set` for whether it's actually
   * usable yet); `"graph"` (a local, structurally different second
   * algorithm — an adaptive-resolution graph, modelled on RouteIQ's own
   * approach but running against this boat's own charts, no SignalK/
   * remote dependency); or `"artifact"` (a local, from-scratch fourth
   * algorithm implementing a stricter/more-complete hard-constraint set
   * than any of the other three — the breakwater-family construction
   * features, unsurveyed water, individual soundings, and CATZOC-derived
   * horizontal/depth buffers none of the others check — plus deterministic
   * route output for the same request. Newer and less battle-tested than
   * the built-in raster search; not the full precomputed-artifact/portal-
   * topology architecture it is modelled on, just its hazard/determinism
   * rules computed fresh per request); or `"mivnav"` (a fifth engine that
   * runs that SAME `"artifact"` search — identical route out, today — with
   * the real precomputed-topology pipeline (depth bands, connected
   * components, portals, contracted shortcuts, a topology-graph search)
   * running alongside it purely for cross-check diagnostics. An early,
   * honestly-labelled testability build toward the full v3 architecture,
   * not that architecture finished — see the backend's own
   * `RoutingConfig.algorithm` docstring and `MIVNAV_ARTIFACT_TODO.md` at
   * the repo root for exactly how much of it is built). All five are
   * comparable live against the same request. Default `"raster"`. */
  algorithm: "raster" | "routeiq" | "graph" | "artifact" | "mivnav";
  /** Metres, sent as RouteIQ's own `beam` constraint, and (halved, plus
   * the hard lateral margin above) the graph algorithm's own beam-based
   * clearance filter. Live only for `algorithm === "routeiq" | "graph"` —
   * "raster" has no beam constraint at all, and "artifact" leaves
   * beam/width out of its own current MVP scope. */
  routeiq_beam_m: number;
  /** Metres, sent as RouteIQ's own `airDraft` constraint (mast height
   * above the waterline). Moot while `algorithm !== "routeiq"`. */
  routeiq_air_draft_m: number;
  /** Nautical miles, sent as RouteIQ's own `minCoastDistance`. Moot while
   * `algorithm !== "routeiq"`. */
  routeiq_min_coast_distance_nm: number;
  /** Metres. Only the FIRST and LAST leg of an `"artifact"` route may pass
   * through no-coverage or unsurveyed (`UNSARE`) water within this radius
   * of the actually-requested start/destination point — the fix for those
   * two being hard blocks for this algorithm (unlike the other three,
   * which treat `UNSARE` as a soft caution area): a marina or anchorage
   * sitting in genuinely unsurveyed water stays reachable without quietly
   * softening the hazard everywhere else along the route. Moot unless
   * `algorithm === "artifact"`. */
  artifact_endpoint_grace_radius_m: number;
  /** How much the `"artifact"` algorithm derates charted hazards by their
   * own CATZOC (Category of Zone of Confidence) survey grade — a
   * geometry-changing buffer, not a cost weight: `"full"` both grows every
   * hard-hazard boundary outward and subtracts a depth allowance before
   * comparing to the required depth, sized per feature from its own
   * cell's CATZOC (worse confidence = bigger buffer); `"half"` halves both
   * numbers; `"depth_only"` keeps the depth allowance but skips the
   * horizontal buffer; `"off"` applies neither, matching what the other
   * three algorithms already do. Default `"full"`. Moot unless
   * `algorithm === "artifact"`. */
  artifact_catzoc_allowance_mode: "full" | "half" | "depth_only" | "off";
  /** Overrides, for the `"artifact"` algorithm only, two of its default
   * hard blocks that the other algorithms don't implement at all:
   * `RESARE`/`MIPARE` entry-restricted (`RESTRN=8`) areas, and
   * marine-farm/fish-stake areas (`MARCUL`/`FSHFAC`). Does NOT override an
   * entry-PROHIBITED (`RESTRN=7`) area, a depth/hazard block, land, or a
   * blocking construction feature — those stay hard regardless. Default
   * `false`. Moot unless `algorithm === "artifact"`. */
  artifact_allow_restricted_entry: boolean;
  /** The vessel's beam in metres, for `algorithm === "mivnav"` only
   * (§8.3/§12.4). When `> 0`, a marginal-width crossing on the
   * precomputed topology route is re-routed locally against the chart's
   * own hazard geometry and re-verified against the draft-aware hard
   * constraints — the one case a `"mivnav"` route departs from the
   * `"artifact"` fine search's. `0` (default) disables it. Moot unless
   * `algorithm === "mivnav"`. */
  mivnav_beam_m: number;
  /** Directional / buoyage semantics for `algorithm === "mivnav"` only
   * (§11). When `true`, a precomputed-topology crossing taken against a
   * charted traffic flow (`TSSLPT` / one-way `DWRTPT` / `RECTRC` with
   * `ORIENT`) is forbidden, and a crossing on the wrong side of a
   * lateral mark for its direction of travel is soft-penalised. Can
   * change which corridor the topology layer reports, so it is opt-in;
   * it never moves the fine-search route itself, only the diagnostics
   * (`debug_legs[...].mivnav.topology_directional_penalized_portals`).
   * Default `false`. Moot unless `algorithm === "mivnav"`. */
  mivnav_directional_rules: boolean;
  /** `algorithm === "mivnav"` only. When `true`, a plan request whose
   * topology layer did not read a persisted `.mivnav` (none built, stale,
   * or the corridor spans several chart sets) is refused — straight line
   * plus a warning — instead of served from the per-request topology
   * rebuild. Changes no route a boat gets (the rebuild produces the same
   * fine-search route); it lets a test be certain it is on the artifact
   * read path. Default `false`. */
  mivnav_require_artifact: boolean;
}

/** The collision alarm (mivnav.collision.config.CollisionConfig) — boat-wide:
 * the server runs it and raises it on SignalK, and every screen colours and
 * sounds by it. One shape with the snapshot's `collisionSettings`. */
export type CollisionServerConfig = CollisionSettings;

/** The GNSS-lost / connection alarms (mivnav.gnss.config.GnssConfig) —
 * boat-wide, one shape with the snapshot's `gnssSettings`. */
export type GnssServerConfig = GnssSettings;

/** The shallow-water alarm (mivnav.shallow.config.ShallowConfig) — boat-wide,
 * one shape with the snapshot's `shallowSettings`. */
export type ShallowServerConfig = ShallowSettings;

/** The ship's track (mivnav.features.track.config.TrackConfig). */
export interface TrackServerConfig {
  /** The SignalK history provider to read, by plugin id; `null` = SignalK's
   * own default. Choices come from `GET /track/providers`. */
  history_provider: string | null;
  /** This boat's earlier SignalK identities — hand-set, no UI. */
  past_contexts: string[];
}

/** Software-update checks (mivnav.config.model.UpdatesConfig) — Settings →
 * Software. */
export interface UpdatesServerConfig {
  /** Look up the newest release on GitHub when the Software panel opens (at
   * most every 6 h). `false` = only on "Check now". */
  check: boolean;
  /** Offer pre-releases (`v0.2.0-rc.1`) as an update too. */
  include_prereleases: boolean;
}

export interface SignalKServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  tls: boolean;
  /** Boat-wide extra SignalK paths to subscribe to, on top of the curated
   * set (mivnav.config.model.SignalKConfig.extra_paths). Chosen, enumerated
   * paths only — never a wildcard; the backend rejects `*`. */
  extra_paths: string[];
}

/** The o-charts login as the *server* describes it: `password` is always
 * null on the way out (mivnav.config.model.redacted) — there is no shape of
 * this object in which a client has been told the password. */
export interface OchartsCredentialsView {
  user: string;
  password: null;
}

export interface ServerConfig {
  version: number;
  ocharts: OchartsServerConfig;
  /** Root every dataset provider's directory sits under
   * (mivnav.config.model.Config.data_root). Replaces `charts.dir`; the
   * backend migrates an existing config.json's `charts.dir` on load. */
  data_root: string;
  nav: NavServerConfig;
  routing: RoutingServerConfig;
  signalk: SignalKServerConfig;
  collision: CollisionServerConfig;
  gnss?: GnssServerConfig;
  shallow: ShallowServerConfig;
  track: TrackServerConfig;
  updates: UpdatesServerConfig;
  /** Boat-wide named areas of interest (mivnav.config.model.Region), shared
   * by POI/satellite bake pickers — settings/regions.tsx owns the
   * read-modify-write for this list. */
  regions: Region[];
  credentials: { ocharts: OchartsCredentialsView };
}

/** Read-only facts the UI needs and must never send back — kept out of
 * `config` so that document stays round-trippable. */
export interface ConfigMeta {
  path: string;
  credentials_path: string;
  profiles_path: string;
  /** Whether a password exists, never which. */
  ocharts_password_set: boolean;
  /** Whether the autopilot write token is configured, never its value —
   * shown as "granted" vs "not configured"; the access-request button
   * (signalkAccess.ts) is how it becomes true. */
  signalk_token_set: boolean;
  /** Whether the RouteIQ access token is configured, never its value —
   * the routing settings' RouteIQ section shows "connected" vs "not
   * connected" from this, and its own access-request button
   * (routeiqAccess.ts) is how it becomes true. A SEPARATE grant from
   * `signalk_token_set`: RouteIQ is a plugin on the same box, but its own
   * device access-request grant is independently revocable. */
  routeiq_token_set: boolean;
  signalk_url: string;
  /** Random per-process, minted fresh each backend start, never persisted —
   * the only way a client can tell "backend restarted" apart from "config
   * changed" (`createServerConfig`'s `accept` bumps the chart epoch on change). */
  boot_id: string;
}

export interface ConfigPayload {
  config: ServerConfig;
  meta: ConfigMeta;
}

/** The o-charts login as a *patch*. `password: null` means **leave the
 * stored one unchanged** (mivnav.config.store._drop_null_password) — the
 * only reason this UI can exist. `""` clears it deliberately. */
export interface OchartsCredentialsPatch {
  user?: string;
  password?: string | null;
}

/** A merge patch: send the fields you changed. PATCH rather than PUT —
 * several independent owners in this UI, and a whole-document write would
 * let each revert the others from a stale copy. */
export interface ConfigPatch {
  ocharts?: Partial<OchartsServerConfig>;
  data_root?: string;
  nav?: Partial<NavServerConfig>;
  routing?: Partial<RoutingServerConfig>;
  signalk?: Partial<SignalKServerConfig>;
  collision?: Partial<CollisionServerConfig>;
  gnss?: Partial<GnssServerConfig>;
  shallow?: Partial<ShallowServerConfig>;
  track?: Partial<TrackServerConfig>;
  updates?: Partial<UpdatesServerConfig>;
  /** Whole-list replace. Entries must be in the country-XOR-bbox wire shape
   * — see `regionPatch` (settings/regions.tsx), every writer's path. */
  regions?: object[];
  credentials?: { ocharts?: OchartsCredentialsPatch };
}

const BASE = "/api/config";

/** A 422's detail, made readable in a 264px panel: strips pydantic's raw
 * five-line dump down to the sentence + field name. Non-pydantic errors
 * (a 409, the shop's own text) pass through untouched. */
export function readableDetail(detail: string): string {
  if (!/^\d+ validation errors? for /.test(detail)) return detail;
  const parts: string[] = [];
  const lines = detail
    .split("\n")
    .slice(1) // "1 validation error for Config"
    .filter((line) => line.trim() && !/^\s*For further information/.test(line));
  for (let i = 0; i < lines.length; i += 2) {
    const field = lines[i].trim();
    const message = (lines[i + 1] ?? "").trim().replace(/\s*\[type=[^\]]*\]\s*$/, "");
    parts.push(message ? `${field}: ${message}` : field);
  }
  return parts.join("; ") || detail;
}

async function request(url: string, init?: RequestInit): Promise<ConfigPayload> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      body && typeof (body as { detail?: unknown }).detail === "string"
        ? readableDetail((body as { detail: string }).detail)
        : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body as ConfigPayload;
}

export const fetchServerConfig = (): Promise<ConfigPayload> => request(BASE);

// Module scope, not inside `createServerConfig()`'s closure: that
// controller lives in the lazily-mounted settings panel and would only
// catch a restart while open; module scope lets `seedChartDetail` see it too.
let lastBootId: string | null = null;

/** Compare a freshly-fetched `boot_id` against the last one seen by ANY
 * caller this session and bump the chart epoch iff it moved (backend
 * restarted). First call this session only seeds the baseline. */
function noteBootId(bootId: string): void {
  if (lastBootId !== null && bootId !== lastBootId) bumpChartEpoch();
  lastBootId = bootId;
}

/** Prime the chart-detail global `B` and check for a restart — once at app
 * start and on every periodic re-poll, since the settings panel that would
 * otherwise sync `B` is lazily mounted. Errors swallowed: keeps neutral default. */
export async function seedChartDetail(): Promise<void> {
  try {
    const payload = await fetchServerConfig();
    setScaminBiasSignal(biasFromConfig(payload.config.ocharts));
    setBetaAutorouting(payload.config.routing?.beta_enabled === true);
    noteBootId(payload.meta.boot_id);
  } catch {
    // unreachable server → keep the neutral default
  }
}

export const patchServerConfig = (patch: ConfigPatch): Promise<ConfigPayload> =>
  request(BASE, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

/** Ensure the boat subscribes to `path` (DE-E). `extra_paths` is a
 * whole-list field a PATCH replaces wholesale (the UNION every device
 * wants), so this is a deliberate read-modify-write. */
export async function subscribeExtraPath(path: string): Promise<void> {
  const { config } = await fetchServerConfig();
  const current = config.signalk.extra_paths ?? [];
  if (current.includes(path)) return;
  await patchServerConfig({ signalk: { extra_paths: [...current, path] } });
}

/** Re-read a hand-edited config file. The escape hatch's other half: that
 * file is the same document this UI writes, so an operator who edited it
 * over ssh should not have to bounce the server to be believed. */
export const reloadServerConfig = (): Promise<ConfigPayload> =>
  request(`${BASE}/reload`, { method: "POST" });

/** The server config, and every rule the UI obeys about it — none of the
 * markup. ServerSettings.tsx renders it; tests drive it directly, so an
 * unreachable server or a refused patch is asserted without a DOM. */
export interface ServerConfigController {
  /** null until the first successful fetch, and after a failed first one. */
  config: Accessor<ServerConfig | null>;
  meta: Accessor<ConfigMeta | null>;
  loading: Accessor<boolean>;
  /** A write is in flight; the UI disables its controls. */
  busy: Accessor<boolean>;
  /** Non-empty when the config could not be fetched. Everything else keeps
   * working (chart settings are local, persist.ts) — a settings panel must
   * never be able to break the chart. */
  offline: Accessor<string>;
  /** Last refused write, in the server's own words. */
  error: Accessor<string>;
  /** Last successful write. */
  status: Accessor<string>;
  /** Which caller the current `error`/`status` belongs to — so a refused
   * SignalK port is not also reported under the o-charts login. */
  scope: Accessor<string>;
  refresh: () => Promise<void>;
  /** Applies `patch`; resolves `true` when taken, never rejects. On success
   * everything refills from the *response* — the merged truth, not what we
   * hoped was stored. */
  patch: (patch: ConfigPatch, opts?: WriteOptions) => Promise<boolean>;
  reload: (opts?: WriteOptions) => Promise<boolean>;
}

export interface WriteOptions {
  /** Shown on success, in the section that asked. */
  done?: string;
  /** Which section owns the resulting feedback. See `scope`. */
  scope?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createServerConfig(): ServerConfigController {
  const [config, setConfig] = createSignal<ServerConfig | null>(null);
  const [meta, setMeta] = createSignal<ConfigMeta | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [offline, setOffline] = createSignal("");
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [scope, setScope] = createSignal("");

  const accept = (payload: ConfigPayload) =>
    batch(() => {
      setConfig(payload.config);
      setMeta(payload.meta);
      setOffline("");
      // Keep the SCAMIN-bias global in step: style must use the same B/k/A the server drops features by.
      setScaminBiasSignal(biasFromConfig(payload.config.ocharts));
      setBetaAutorouting(payload.config.routing?.beta_enabled === true);
      // Also a chance to notice the backend restarted mid-session
      // (`noteBootId`, shared module scope with `seedChartDetail`).
      noteBootId(payload.meta.boot_id);
    });

  const refresh = async () => {
    setLoading(true);
    try {
      accept(await fetchServerConfig());
    } catch (e) {
      // resolves, never rejects: the section renders its own offline notice
      setOffline(message(e));
    } finally {
      setLoading(false);
    }
  };

  /** Every write goes through here, so a refusal can never be a silent
   * no-op: exactly one of `error` / `status` is set afterwards, always. */
  const write = async (fn: () => Promise<ConfigPayload>, opts: WriteOptions, fallback: string) => {
    batch(() => {
      setBusy(true);
      setError("");
      setStatus("");
      setScope(opts.scope ?? "");
    });
    try {
      accept(await fn());
      setStatus(opts.done ?? fallback);
      return true;
    } catch (e) {
      // "Not saved" first, and in those words: the field still shows what
      // was typed into it, so the one thing worth saying is that the boat
      // does not have it. A 409 (an install is running) reads the same way.
      setError(`Not saved: ${message(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  void refresh();

  return {
    config,
    meta,
    loading,
    busy,
    offline,
    error,
    status,
    scope,
    refresh,
    patch: (patch, opts = {}) => write(() => patchServerConfig(patch), opts, "Saved."),
    reload: (opts = {}) => write(reloadServerConfig, opts, "Reloaded from the file."),
  };
}

/** The o-charts login form's state. Password is **write-only**: never
 * filled from a GET, emptied on save — an empty box means "not changing it"
 * (`password: null`); `""` would log the boat out on every username fix. */
export interface OchartsLoginController {
  user: Accessor<string>;
  setUser: (value: string) => void;
  /** The draft, never the stored secret. */
  password: Accessor<string>;
  setPassword: (value: string) => void;
  /** The username differs from the server's, or a password was typed. */
  dirty: Accessor<boolean>;
  /** A password is stored on the boat (from meta; never its value). */
  stored: Accessor<boolean>;
  save: () => Promise<void>;
  /** Deliberately clear the stored password — the only way to, since an
   * empty box means "unchanged". */
  forget: () => Promise<void>;
}

/** Feedback from this controller's writes belongs to the o-charts section.
 * Exported so the section names the same string it renders. */
export const OCHARTS_SCOPE = "ocharts";

export function createOchartsLogin(cfg: ServerConfigController): OchartsLoginController {
  const [draft, setDraft] = createSignal<string | null>(null);
  const [password, setPassword] = createSignal("");

  // The username shows the server's value until someone types, then their
  // draft — so a refresh (or another device's edit) does not fight the
  // cursor, and an untouched field cannot be stale.
  const serverUser = () => cfg.config()?.credentials.ocharts.user ?? "";
  const user = () => draft() ?? serverUser();
  const stored = () => cfg.meta()?.ocharts_password_set ?? false;

  const save = async () => {
    const typed = password();
    const ok = await cfg.patch(
      {
        credentials: {
          ocharts: {
            user: user().trim(),
            // The trap, disarmed: null is "leave it alone", so saving an
            // edited username with an empty password box cannot wipe it.
            password: typed === "" ? null : typed,
          },
        },
      },
      {
        scope: OCHARTS_SCOPE,
        done: typed === "" ? "Saved the o-charts username." : "Saved the o-charts login.",
      },
    );
    if (!ok) return; // keep the drafts: the mariner retries, not retypes
    batch(() => {
      setPassword("");
      setDraft(null); // the response is the truth now
    });
  };

  const forget = async () => {
    const ok = await cfg.patch(
      { credentials: { ocharts: { password: "" } } },
      { scope: OCHARTS_SCOPE, done: "Forgot the stored o-charts password." },
    );
    if (ok) setPassword("");
  };

  return {
    user,
    setUser: setDraft,
    password,
    setPassword,
    dirty: () => password() !== "" || user().trim() !== serverUser(),
    stored,
    save,
    forget,
  };
}
