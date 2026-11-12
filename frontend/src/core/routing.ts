// The fetch wrapper for POST /api/routing/plan (mivnav/features/routing) —
// same shape as core/routes.ts's client for the real route store: a thin,
// injectable wrapper, house lat/lon <-> GeoPoint {lng,lat} translation at
// this one seam so nothing above it has to know the wire spells it
// differently. See mivnav/features/routing/routes.py for the response
// shape this mirrors.
//
// Lives in core/, not a feature: both features/route (the real "Go here",
// which now calls this to get a hazard-avoiding path instead of a straight
// line) and features/routeTest (the click-and-see probe this was built
// for first) need it, and core is where a client shared across features
// belongs — same reasoning as core/routes.ts itself.

import type { GeoPoint } from "./chrome/geo";

export interface PlanResult {
  /** The real path: `[from, to]` when nothing was in the way, or a bent
   * multi-point route around charted danger — never empty. */
  waypoints: GeoPoint[];
  distanceNm: number;
  /** The standing "no rules stage yet" caveat on a found route, plus one
   * entry per approximate RUN (see `approximateLegs`) explaining why —
   * see the backend's own PlanResponse docstring. */
  warnings: string[];
  /** One entry per leg (`waypoints[i]` -> `waypoints[i + 1]`): `true`
   * where that leg is a straight-line stand-in — a real hazard (start/end
   * itself inside charted danger, or the search otherwise couldn't reach
   * that far), or the grid resolution this corridor was searched at being
   * too coarse to see a real, narrow hazard the exact per-leg re-check
   * still caught — draw it as a warning, not an ordinary route leg. Not
   * only `[0]`/`[length-1]`: a flagged leg can fall anywhere in the
   * middle of a long route. All `false` is the ordinary, fully-exact
   * case. */
  approximateLegs: boolean[];
  /** One entry per leg, same shape/order as `approximateLegs`: `true`
   * where that leg needs a human's own judgement — crosses charted
   * `UNSARE` (unsurveyed area) water, OR crosses a `BRIDGE` this boat
   * can't clear closed but that can mechanically open (this app has no
   * way to confirm an opening is actually available). Purely
   * informational, never a reason a leg was routed differently — both
   * are soft preferences for the search now, not hard hazards
   * (`chartcore::routing::hazards`' own module-doc notes); this is a
   * "check this stretch manually" flag, not a warning of danger. `[]`
   * (never `undefined`) when the backend didn't compute it for this
   * request's algorithm — see `PlanResponse.check_manually_legs`'s own
   * docstring for which ones don't yet. */
  checkManuallyLegs: boolean[];
  /** Present only when `planRoute` was called with `debug: true` — one
   * entry per REAL search actually run (the ordinary single leg, or one
   * per macro-stitched sub-leg — `mivnav.features.routing.hazards.
   * leg_debug_info`'s own docs), each the exact box that search looked in
   * and the exact hazard geometry it avoided. The debug layer's own core
   * payload (#owqqcdqe, 2026-08-10): "add a debugging layer... to check
   * why it puts points where they are". `undefined` when debug wasn't
   * asked for — distinct from `[]` (asked for, genuinely nothing to
   * show), so a caller can tell "not fetched" from "fetched, empty". */
  debugLegs?: DebugLeg[];
  /** Present only when `debug: true` AND a macro-scale detour was
   * actually used — the RAW coarse, land-only guide, before the real
   * per-leg search refined anything. Drawn distinctly so "is this bend
   * the macro guide's own fault, or the fine search's" is a visual
   * question, not a guess — the macro pass knows nothing about depth or
   * buoyage (`_MACRO_ROUTE_WARNING`, backend). `undefined` when debug
   * wasn't asked for OR no macro detour was used. */
  debugMacroWaypoints?: GeoPoint[];
}

/** One real search's own debug geometry — see `PlanResult.debugLegs`.
 *
 * Two shapes land here. The raster / direct-artifact search contributes
 * `bbox` + `hazardRings` (`leg_debug_info`, backend). A `"mivnav"` coarse
 * stitch leg that the fine search REJECTED contributes the richer
 * `find_artifact_route_debug` set — `reason`, `constraintRings` by class,
 * and `field` (the search grid raster). Every field is optional; a
 * renderer draws whatever a given leg carries. */
export interface DebugLeg {
  /** `(w, s, e, n)` degrees — the candidate-cell box this leg's own search
   * actually looked in. Raster / direct-artifact legs only. */
  bbox?: [number, number, number, number];
  /** Every hazard ring this leg's search treated as unsafe, each a closed
   * polygon ring. Rendered as-is (no hole/fill-rule reconstruction).
   * Raster / direct-artifact legs only. */
  hazardRings?: GeoPoint[][];
  /** WHICH of the fine search's failure points fired: `"ok"` (the leg was
   * fine — a partially-recovered stitch), `"no_field"`, `"start_blocked"`,
   * `"goal_blocked"`, `"severed"` (walkable start and goal, no path
   * between), `"grid_too_large"`. `find_artifact_route_debug` legs only. */
  reason?: string;
  /** The leg's own `(from, to)` — the coarse-guide pair the fine search
   * was asked to connect. */
  from?: GeoPoint;
  to?: GeoPoint;
  /** Ground metres from `from`/`to` to the cell `nearest_walkable` actually
   * snapped to — `null` when that end never snapped at all (chartcore's
   * `f64::NAN` sentinel, turned into JSON `null` server-side: a bare `NaN`
   * literal isn't valid JSON and `JSON.parse` would throw on it), e.g. a
   * `start_blocked`/`goal_blocked` leg's own blocked end.
   * `find_artifact_route_debug` legs only. */
  startSnapM?: number | null;
  goalSnapM?: number | null;
  /** Every constraint class the build produced for this leg's corridor,
   * keyed by name (`hard`, `charted_depth`, `coverage`, `depth_avoid`,
   * `depth_soft`, `unsurveyed`, `caution`, `cable`, `tss`, `preferred`,
   * `survey`, `atba`, `check_manually`), each a list of rings. */
  constraintRings?: Record<string, GeoPoint[][]>;
  /** The fine search's own cell grid — `null` when no field was built. */
  field?: DebugField | null;
}

/** The `"artifact"`/`"mivnav"` fine search's cell grid, for the debug
 * overlay — a raster of what the search could and could not cross. */
export interface DebugField {
  cols: number;
  rows: number;
  cellSizeM: number;
  /** NW, NE, SE, SW as `[lng, lat]` — MapLibre image-source corner order. */
  corners: [[number, number], [number, number], [number, number], [number, number]];
  /** `cols * rows` bytes, row-major from the NW corner — `0` open · `1`
   * hard · `2` unknown-blocked · `3` unknown-graced · `4` soft-penalised.
   * Empty when the grid was too large to serialise. */
  codes: Uint8Array;
  /** The snapped start/goal as `[col, row]`, or `null` when that endpoint
   * had no walkable cell within the grace radius. */
  startCell?: [number, number] | null;
  goalCell?: [number, number] | null;
}

/** base64 (backend `codes_b64`) → one byte per cell. */
function decodeFieldCodes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const BASE = "/api/routing";

export class PlanError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

export type PlanFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Is `plan` the "the router couldn't verify at least one leg of this
 * request" case — a real hazard at an end, the search otherwise couldn't
 * connect all the way, or a leg anywhere in the middle the exact per-leg
 * re-check flagged — rather than the ordinary fully-exact route?
 * Structured, not a warning-text substring match:
 * `PlanResponse.approximate_legs` is exactly this fact, straight from
 * `chartcore.shortest_path` itself. Shared by both callers that need to
 * tell the two apart (features/route's `goTo`, features/routeTest's
 * pill). */
export function planIsUnreachable(plan: Pick<PlanResult, "approximateLegs">): boolean {
  return plan.approximateLegs.some(Boolean);
}

/** One consecutive run of legs, all sharing the same `approximate` flag —
 * `points` is ready to draw as its own polyline, sharing an endpoint with
 * its neighbour on each side so the drawn route reads continuous. */
export interface RouteRun<P> {
  points: P[];
  approximate: boolean;
}

/** Group `waypoints` into consecutive runs by `approximateLegs[i]` (one
 * entry per leg, `waypoints[i]` -> `waypoints[i + 1]`) — generalizes the
 * old "at most a leading + trailing stub" split (`splitApproximateLegs`,
 * back when only the two ends could ever be flagged) to a run landing
 * ANYWHERE: a single grid resolution shared across a long corridor can
 * miss a real, narrow hazard in the MIDDLE of a route too, not just near
 * its two ends — see the backend's own PlanResponse docstring. A single
 * waypoint with no legs at all comes back as one non-approximate run of
 * length 1; zero waypoints comes back empty. Shared by both overlays that
 * draw a `PlanResult` (features/route's "Go here", features/routeTest's
 * probe) so the grouping logic lives in exactly one place — the map
 * paint (dashed + warning colour on approximate runs) is each overlay's
 * own, everything already themed differently.
 *
 * `approximateLegs` is walked by LEG COUNT (`waypoints.length - 1`), not
 * by its own length, and a missing entry defaults to `false` — a real
 * regression, caught live: every ordinary saved route (not the "Go here"
 * ephemeral one) is drawn with `approximateLegs` gated to `[]` in
 * `route/overlay.ts`, and the old `while (i < approximateLegs.length)`
 * loop never ran at all for that empty array, so no line feature was
 * pushed AT ALL — only the waypoint handles, with nothing joining them. */
export function groupApproximateRuns<P>(waypoints: readonly P[], approximateLegs: readonly boolean[]): RouteRun<P>[] {
  const n = waypoints.length;
  if (n === 0) return [];
  if (n === 1) return [{ points: [waypoints[0]!], approximate: false }];
  const legCount = n - 1;
  const runs: RouteRun<P>[] = [];
  let i = 0;
  while (i < legCount) {
    const approximate = approximateLegs[i] ?? false;
    let j = i;
    while (j < legCount && (approximateLegs[j] ?? false) === approximate) j++;
    // Legs [i, j) span waypoints[i..j] inclusive.
    runs.push({ points: waypoints.slice(i, j + 1) as P[], approximate });
    i = j;
  }
  return runs;
}

/** `fetchImpl` is the seam a test drives — same shape as
 * `core/autopilot.ts`'s injected fetch, chosen over `mock.module` for the
 * same reason: a module mock leaks across every test file in one bun run
 * (see CLAUDE.md), and this module is reached from more than one. */
export async function planRoute(
  from: GeoPoint,
  to: GeoPoint,
  draftM?: number,
  fetchImpl: PlanFetch = fetch,
  debug = false,
): Promise<PlanResult> {
  const res = await fetchImpl(`${BASE}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: { lat: from.lat, lon: from.lng },
      to: { lat: to.lat, lon: to.lng },
      ...(draftM !== undefined ? { draft_m: draftM } : {}),
      ...(debug ? { debug: true } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new PlanError(res.status, detail || `${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    waypoints: { lat: number; lon: number }[];
    distance_nm: number;
    warnings: string[];
    approximate_legs: boolean[];
    check_manually_legs: boolean[];
    debug_legs:
      | {
          bbox?: [number, number, number, number];
          hazard_rings?: [number, number][][];
          reason?: string;
          from?: [number, number];
          to?: [number, number];
          start_snap_m?: number | null;
          goal_snap_m?: number | null;
          constraint_rings?: Record<string, [number, number][][]>;
          field?: {
            cols: number;
            rows: number;
            cell_size_m: number;
            corners: [number, number][];
            codes_b64: string;
            start_cell?: [number, number] | null;
            goal_cell?: [number, number] | null;
          } | null;
        }[]
      | null;
    debug_macro_waypoints: [number, number][] | null;
  };
  const ringsToPts = (rings: [number, number][][]): GeoPoint[][] =>
    rings.map((ring) => ring.map(([lng, lat]) => ({ lng, lat })));
  return {
    waypoints: body.waypoints.map((w) => ({ lng: w.lon, lat: w.lat })),
    distanceNm: body.distance_nm,
    warnings: body.warnings,
    approximateLegs: body.approximate_legs,
    // `?? []`, not a bare pass-through: existing callers/tests built
    // before this field existed send a response with no
    // `check_manually_legs` key at all, and every consumer
    // (`groupApproximateRuns`-shaped indexing, `.some()`) expects a real
    // array, never `undefined`.
    checkManuallyLegs: body.check_manually_legs ?? [],
    debugLegs: body.debug_legs?.map((leg) => ({
      bbox: leg.bbox,
      hazardRings: leg.hazard_rings ? ringsToPts(leg.hazard_rings) : undefined,
      reason: leg.reason,
      from: leg.from ? { lng: leg.from[0], lat: leg.from[1] } : undefined,
      to: leg.to ? { lng: leg.to[0], lat: leg.to[1] } : undefined,
      startSnapM: leg.start_snap_m,
      goalSnapM: leg.goal_snap_m,
      constraintRings: leg.constraint_rings
        ? Object.fromEntries(
            Object.entries(leg.constraint_rings).map(([k, rings]) => [k, ringsToPts(rings)]),
          )
        : undefined,
      field:
        leg.field == null
          ? leg.field
          : {
              cols: leg.field.cols,
              rows: leg.field.rows,
              cellSizeM: leg.field.cell_size_m,
              corners: leg.field.corners as DebugField["corners"],
              codes: decodeFieldCodes(leg.field.codes_b64),
              startCell: leg.field.start_cell ?? null,
              goalCell: leg.field.goal_cell ?? null,
            },
    })),
    debugMacroWaypoints: body.debug_macro_waypoints?.map(([lng, lat]) => ({ lng, lat })),
  };
}
