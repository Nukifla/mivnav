// THE ROUTE EDITOR: the chart-mode seam (./modes.ts), the band.top instruments,
// and the pure tap-onto-leg geometry — maplibre-free. See
// docs/architecture/route-model.md for the three-way split and why.

import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import type { QueryableMap } from "../../core/info/queryGuard";
import { createRouteProvider } from "./provider";
import { knotsFromMs, wrapLonDeltaDeg } from "../../core/cpa";
import {
  DEFAULT_PLAN_SPEED_KN,
  RouteSaveError,
  type Route,
  type RoutesClient,
  type SteerMode,
  type Waypoint,
} from "../../core/routes";
import type { Notice } from "../../core/chrome/notices";
import type { SignalKState } from "../../core/signalk";
import { planIsUnreachable, planRoute, type PlanFetch } from "../../core/routing";
import { formatCoordinate } from "../../core/coordinate";
import { nearestPlace } from "../../core/search/client";
import { bearingDeg, type GeoPoint, rangeNm } from "../../core/chrome/geo";
import { formatClock, formatDuration, formatRange, padDeg } from "../../core/format";
import { isHelmish, type Instrument, type Mode } from "../../core/chrome/registry";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { createRouteOverlay } from "./overlay";
import { routeCommands } from "./commands";
import { betaAutorouting } from "../../core/serverConfig";
import { haptic } from "./haptics";
import { downloadGpx } from "./download";
import { clampName, importGpx, importSummary, type XmlParse } from "./gpx";
import { createFollow, followName, type FollowLeg, type FollowResult } from "./follow";

// Re-exported from the leaf ./layers (TDZ cycle); keeps the "./index" surface.
export { ROUTE_LINE_LAYER, ROUTE_WAYPOINTS_LAYER } from "./layers";

const DEG_TO_RAD = Math.PI / 180;
const NM_PER_DEG = 60;

/** A waypoint's position as a `GeoPoint` — `lon`→`lng`, the wire→chrome flip. */
export const wpPoint = (w: Waypoint): GeoPoint => ({ lng: w.lon, lat: w.lat });

/** Foot of the perpendicular from `p` onto segment `a`→`b`, clamped to it, plus
 * how far off `p` was. Planar (equirectangular, like `geo.ts`/`cpa.ts`), with
 * `wrapLonDeltaDeg` handling the antimeridian. Exact enough to pick the INDEX. */
export function projectOntoLeg(
  p: GeoPoint,
  a: GeoPoint,
  b: GeoPoint,
): { point: GeoPoint; t: number; distNm: number } {
  const lat0 = (a.lat + b.lat) / 2;
  const kx = Math.cos(lat0 * DEG_TO_RAD);
  const bx = wrapLonDeltaDeg(b.lng - a.lng) * kx;
  const by = b.lat - a.lat;
  const px = wrapLonDeltaDeg(p.lng - a.lng) * kx;
  const py = p.lat - a.lat;
  const len2 = bx * bx + by * by;
  // A degenerate leg (a === b) has no direction; the foot is `a` itself.
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  const point: GeoPoint = {
    lng: a.lng + t * wrapLonDeltaDeg(b.lng - a.lng),
    lat: a.lat + t * (b.lat - a.lat),
  };
  const dx = px - t * bx;
  const dy = py - t * by;
  return { point, t, distNm: Math.hypot(dx, dy) * NM_PER_DEG };
}

export interface Insertion {
  /** The segment hit: waypoints[segment] → waypoints[segment + 1]. */
  segment: number;
  /** Where the new waypoint goes in the array — always `segment + 1`. */
  index: number;
  /** The foot on the leg, where the inserted waypoint lands. */
  point: GeoPoint;
  distNm: number;
}

/** Which leg of `pts` a tap at `p` is nearest, and where on it a waypoint
 * would land. `null` with fewer than two points. Insert index is `segment +
 * 1`, so the two points it splits stay its neighbours. */
export function nearestInsertion(pts: readonly GeoPoint[], p: GeoPoint): Insertion | null {
  let best: Insertion | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const { point, distNm } = projectOntoLeg(p, pts[i], pts[i + 1]);
    if (!best || distNm < best.distNm) best = { segment: i, index: i + 1, point, distNm };
  }
  return best;
}

/** Signed cross-track distance of `p` from track `a`→`b`, and which side (R =
 * starboard of track, steer to port). A zero-length track has no line to be
 * off, so the reading is then the range to the point. */
export function crossTrack(a: GeoPoint, b: GeoPoint, p: GeoPoint): { nm: number; side: "L" | "R" } {
  const lat0 = (a.lat + b.lat) / 2;
  const kx = Math.cos(lat0 * DEG_TO_RAD);
  const bx = wrapLonDeltaDeg(b.lng - a.lng) * kx;
  const by = b.lat - a.lat;
  const px = wrapLonDeltaDeg(p.lng - a.lng) * kx;
  const py = p.lat - a.lat;
  const len = Math.hypot(bx, by);
  if (len === 0) return { nm: rangeNm(a, p), side: "R" };
  // 2-D cross product of the track and the boat vector, per unit track length.
  // > 0 means `p` is to the LEFT of a→b, i.e. the boat is to port of the track.
  const cross = (bx * py - by * px) / len;
  return { nm: Math.abs(cross) * NM_PER_DEG, side: cross > 0 ? "L" : "R" };
}

/** The stable id of the single ephemeral "Go here" route, reused (overwritten)
 * on every "Go here" so repeated taps don't accumulate orphan routes. A FIXED
 * uuid: routes are SignalK resources, and SignalK refuses a non-uuid id
 * (the old `"go-here"` failed every save with "Invalid resource id"). A
 * minted uuid will never collide with it. */
export const GO_HERE_ROUTE_ID = "9e0e7e0e-0000-4000-a000-000000006e7e";

/**
 * A direct two-waypoint route from the boat to a point: waypoint 0 is where the
 * boat is now, waypoint 1 the destination, named as the leg (invariant #8) so
 * band.top's followed strip reads BRG/DTW straight to it. Pure.
 *
 * No longer `goTo`'s primary path (see `routeFromPlan`, which builds from a
 * real hazard-avoiding `chartcore.shortest_path` result instead) — kept as
 * its FALLBACK for when the planning request itself fails outright (a
 * network/server error, not the router finding no safe path — that case
 * already comes back as a valid, if unavoidably straight, `PlanResult`).
 * "Go here" degrading to the pre-routing straight line beats it refusing
 * to work at all when the router is briefly unreachable.
 */
export function directRoute(
  from: GeoPoint,
  to: GeoPoint,
  ids: { route: string; from: string; to: string },
  name?: string,
): { route: Route; activeWaypointId: string } {
  const label = name?.trim() || "Go here";
  const route: Route = {
    id: ids.route,
    name: label,
    waypoints: [
      { id: ids.from, name: "Boat", lat: from.lat, lon: from.lng, stop: true },
      { id: ids.to, name: label, lat: to.lat, lon: to.lng, stop: true },
    ],
    plan_speed_kn: DEFAULT_PLAN_SPEED_KN,
    rev: 0,
    updated: 0,
  };
  // The destination is the leg — GO would have you select it; here we name it
  // outright, which is the same decision made without the editor open.
  return { route, activeWaypointId: ids.to };
}

/**
 * A route built from a `chartcore.shortest_path` result (`POST
 * /api/routing/plan`, via `core/routing.ts`'s `planRoute`): waypoint 0 is
 * the boat, the LAST is the destination, named as the leg exactly like
 * `directRoute` (invariant #8) — and any points the real search bent
 * through in between (routing around charted danger) are named plainly,
 * "Waypoint N", since they exist for the router's reasons, not for a user
 * to rename. Pure, same shape as `directRoute`: ids come in pre-minted
 * (one per waypoint, in order) so the caller controls id generation — a
 * real uuid per point in the app, a deterministic fake in tests — and this
 * function only has to place them.
 *
 * `approximateLegs` (`PlanResult.approximateLegs`, one entry per LEG —
 * `waypoints[i]` -> `waypoints[i+1]`) is stamped onto each WAYPOINT's own
 * `approximate` field (#owqqcdqe, 2026-08-10): waypoint `i`'s flag is the
 * INCOMING leg's, `approximateLegs[i-1]` — the persisted, per-waypoint
 * home for the same fact the old ephemeral `approximateLegs` signal held
 * only for the session that planned it. Omitted (every waypoint gets
 * `false`) when the caller has none — `directRoute`'s own network-failure
 * fallback, which was never verified either way and says so through its
 * own toast instead.
 */
export function routeFromPlan(
  waypoints: readonly GeoPoint[],
  ids: { route: string; waypointIds: readonly string[] },
  name?: string,
  approximateLegs?: readonly boolean[],
): { route: Route; activeWaypointId: string } {
  const label = name?.trim() || "Go here";
  const n = waypoints.length;
  const wps: Waypoint[] = waypoints.map((p, i) => ({
    id: ids.waypointIds[i]!,
    name: i === 0 ? "Boat" : i === n - 1 ? label : `Waypoint ${i}`,
    lat: p.lat,
    lon: p.lng,
    approximate: i > 0 ? (approximateLegs?.[i - 1] ?? false) : false,
    // Boat and the destination are points the mariner actually chose; any
    // bend between them is the router's own — same tag the From/Stop/To
    // engine uses (`rebuildFromStops`), so this ephemeral route reads
    // sensibly if it is ever reopened in the editor.
    stop: i === 0 || i === n - 1,
  }));
  const route: Route = {
    id: ids.route,
    name: label,
    waypoints: wps,
    plan_speed_kn: DEFAULT_PLAN_SPEED_KN,
    rev: 0,
    updated: 0,
  };
  return { route, activeWaypointId: wps[n - 1]!.id };
}

/** The same route, sailed the other way: waypoint order reversed, ids/names
 * carried along, `rev`/`id` preserved so saving it OVERWRITES, not forks. */
export function reverseWaypoints(route: Route): Route {
  return { ...route, waypoints: [...route.waypoints].reverse() };
}

const REVERSED = " (reversed)";

/** The return passage as a NEW route: waypoint order reversed, every id
 * fresh (a copy must never share ids with the original — the active leg
 * names a waypoint by id), named "<name> (reversed)". Reversing a reversed
 * copy drops the suffix rather than stacking it. `approximate` belongs to
 * the leg ARRIVING at a waypoint, so it moves with its leg: the new j-th
 * point takes the flag the old (n-j)-th carried. The source is untouched. */
export function reversedCopy(route: Route, mintId: () => string): Route {
  const old = route.waypoints;
  const n = old.length;
  const base = route.name.trim() || "Route";
  const name = base.endsWith(REVERSED)
    ? base.slice(0, -REVERSED.length)
    : `${base.slice(0, 64 - REVERSED.length)}${REVERSED}`;
  return {
    ...route,
    id: mintId(),
    name: clampName(name),
    waypoints: old.map((_, j) => {
      const { approximate: _drop, ...w } = old[n - 1 - j]!;
      const approximate = j > 0 && (old[n - j]!.approximate ?? false);
      const copy: Waypoint = { ...w, id: mintId() };
      return approximate ? { ...copy, approximate } : copy;
    }),
    rev: 0,
    updated: 0,
  };
}

/** The index of the waypoint NEAREST `boat` — GO's "closest next" start, not
 * the final leg from wherever you are. `-1` for an empty list; a tie resolves
 * to the earlier index, so a doubled-back route begins at the first pass. */
export function nearestWaypointIndex(boat: GeoPoint, waypoints: readonly Waypoint[]): number {
  let best = -1;
  let bestNm = Infinity;
  for (let i = 0; i < waypoints.length; i++) {
    const nm = rangeNm(boat, wpPoint(waypoints[i]));
    if (nm < bestNm) {
      bestNm = nm;
      best = i;
    }
  }
  return best;
}

/** "Start route"'s target (#RT-GONAV): the ARRIVAL waypoint of the leg the
 * boat is nearest, not `nearestWaypointIndex` — beside the middle of leg 3→4
 * the nearest waypoint can be 3, BEHIND the boat, running the leg backwards. */
export function nearestLegTargetIndex(boat: GeoPoint, waypoints: readonly Waypoint[]): number {
  if (waypoints.length === 0) return -1;
  if (waypoints.length < 2) return 0;
  const ins = nearestInsertion(waypoints.map(wpPoint), boat);
  return ins ? ins.index : 0;
}

/** Boat→destination metrics for a route being followed. DTW is boat→next; DTG
 * sums every leg still ahead to the LAST waypoint. Both TTGs floor at a
 * becalmed 0.2 kn (no ETA below that). */
export interface RouteMetrics {
  brgDeg: number;
  dtwNm: number;
  dtgNm: number;
  ttgSec: number;
  ttgDestSec: number;
  xte: { nm: number; side: "L" | "R" } | null;
}

export function routeMetrics(
  boat: GeoPoint,
  waypoints: readonly Waypoint[],
  activeIndex: number,
  sogKn: number,
): RouteMetrics {
  const to = wpPoint(waypoints[activeIndex]);
  const dtwNm = rangeNm(boat, to);
  let dtgNm = dtwNm;
  for (let k = activeIndex; k < waypoints.length - 1; k++)
    dtgNm += rangeNm(wpPoint(waypoints[k]), wpPoint(waypoints[k + 1]));
  const brgDeg = bearingDeg(boat, to);
  const from = activeIndex > 0 ? wpPoint(waypoints[activeIndex - 1]) : null;
  return {
    brgDeg,
    dtwNm,
    dtgNm,
    ttgSec: sogKn > 0.2 ? (dtwNm / sogKn) * 3600 : Infinity,
    ttgDestSec: sogKn > 0.2 ? (dtgNm / sogKn) * 3600 : Infinity,
    xte: from ? crossTrack(from, to, boat) : null,
  };
}

// At-rest route metrics (the plan, RT-R2): pure, fix-free, leg-free — "what
// does this route look like sailed end to end at planning speed", reusing the
// SAME rangeNm/bearingDeg geometry `routeMetrics` (live follow) uses.

/** One leg at rest: distance, bearing, time at planning speed, and running
 * totals THROUGH this leg's end (the last leg's cumulative = the route's). */
export interface RouteLeg {
  fromIndex: number;
  toIndex: number;
  distNm: number;
  brgDeg: number;
  /** Seconds to sail this leg alone at the planning speed. `Infinity` if the
   * speed is not positive — a route planned at zero knots has no arrival. */
  timeSec: number;
  cumulativeNm: number;
  /** Time from the first waypoint through the end of this leg — the ETA offset
   * of arriving at `toIndex`. */
  cumulativeSec: number;
}

/** A whole route measured at rest: the per-leg breakdown plus the totals. */
export interface RoutePlan {
  legs: RouteLeg[];
  totalNm: number;
  totalSec: number;
}

/** Seconds to cover `distNm` at `speedKn` (nm/h). `Infinity` at a non-positive
 * speed, matching `routeMetrics`' becalmed answer — there is no arrival, and a
 * fabricated one is worse than saying so. */
const timeSecAt = (distNm: number, speedKn: number): number =>
  speedKn > 0 ? (distNm / speedKn) * 3600 : Infinity;

/** At-rest metrics for a route: total distance, per-leg distance/bearing, and
 * cumulative time from the planning speed — no active leg or fix needed. A
 * route with fewer than two waypoints has empty `legs` and zero totals. */
export function planRouteMetrics(
  waypoints: readonly Waypoint[],
  speedKn: number = DEFAULT_PLAN_SPEED_KN,
): RoutePlan {
  const legs: RouteLeg[] = [];
  let cumulativeNm = 0;
  let cumulativeSec = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = wpPoint(waypoints[i]);
    const to = wpPoint(waypoints[i + 1]);
    const distNm = rangeNm(from, to);
    const timeSec = timeSecAt(distNm, speedKn);
    cumulativeNm += distNm;
    cumulativeSec += timeSec;
    legs.push({
      fromIndex: i,
      toIndex: i + 1,
      distNm,
      brgDeg: bearingDeg(from, to),
      timeSec,
      cumulativeNm,
      cumulativeSec,
    });
  }
  return { legs, totalNm: cumulativeNm, totalSec: cumulativeSec };
}

// Arrival detection: NO backend event channel for "you arrived" — the server
// advances the leg (nav.watcher) and the client re-GETs /routes, so arrival is
// a pure heuristic off that motion. See docs/architecture/route-model.md.

export interface LegPos {
  routeId: string;
  /** The active waypoint's index — the destination the boat is steering to. */
  index: number;
  /** Total waypoints on the route, so `index === count - 1` is the last leg. */
  count: number;
}

export type ArrivalEvent =
  /** The boat reached a waypoint: the active leg advanced one step forward,
   * and `reachedIndex` is the waypoint it just arrived at (the OLD active). */
  | { kind: "reached"; reachedIndex: number }
  /** The whole route is done: following ended from the final waypoint. */
  | { kind: "complete" }
  | null;

/** Classify the change in the followed leg: only a +1 step on the SAME route
 * is an arrival; `atLast → null` is completion, since the server clears the
 * active leg ONLY at the last waypoint (nav.watcher `set_active(None)`). */
export function arrivalEvent(prev: LegPos | null, next: LegPos | null): ArrivalEvent {
  // Following ended. A completion is an arrival AT the last waypoint; a Stop
  // from the middle is not, and neither is a bare GO that never began.
  if (prev && !next) {
    return prev.index === prev.count - 1 ? { kind: "complete" } : null;
  }
  // No transition into a followed leg, or the initial GO (null → first leg).
  if (!prev || !next) return null;
  // A single forward step on the same route: the boat reached prev's target.
  if (prev.routeId === next.routeId && next.index === prev.index + 1) {
    return { kind: "reached", reachedIndex: prev.index };
  }
  // A route swap, a backwards step, or a jump of more than one waypoint.
  return null;
}

/** Mint a v4 UUID that works in ALL contexts: `crypto.randomUUID` is
 * secure-context-only (undefined over plain HTTP off localhost — the
 * boat's LAN deployment), so this falls back to `getRandomValues`/`Math.random`. */
export function mintUuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/** A fresh, empty route with a client-minted id (idempotent PUT — see routes.py). */
const newRoute = (mintId: () => string): Route => ({
  id: mintId(),
  name: "",
  waypoints: [],
  plan_speed_kn: DEFAULT_PLAN_SPEED_KN,
  rev: 0,
  updated: 0,
});

/** The overlay's whole input: what to draw, what is being edited, what is active. */
export interface RouteOverlay {
  /** The route the chart draws: the draft while editing, else the followed one. */
  route: Accessor<Route | null>;
  /** True while the mode is open — the layer draws the stop pins as draggable
   * handles (a router-inserted bend renders too, but as a small unlabeled dot,
   * not a handle — see `overlay.ts`'s `KIND.wp` / `KIND.bend` split). */
  editing: Accessor<boolean>;
  /** The active leg's destination waypoint id, highlighted as the target. */
  activeWaypoint: Accessor<string | null>;
  /** The steer-to (rejoin) line for the LOCAL followed leg, or null when
   * `targetLine` (below) is the truth — at most one steering cue draws. */
  steerLine: Accessor<{ from: GeoPoint; to: GeoPoint } | null>;
  /** The LOCAL active leg's steering mode (#RF-NAVMODE). No longer drives the
   * yellow cue (see `targetLine`) — kept for local-state consumers. */
  activeMode: Accessor<SteerMode | null>;
  /** THE YELLOW STEERING CUE (#RF-NAVMODE): boat position → SignalK's reported
   * course, not mivnav's local leg state. See docs/architecture/route-model.md. */
  targetLine: Accessor<{ from: GeoPoint; to: GeoPoint } | null>;
  /** The leg the plan sheet asked to FLASH, or null; set for ~1.4s. */
  flashLeg: Accessor<number | null>;
  /** The last "Go here" plan's per-leg approximate flags (`core/
   * routing.ts`'s `PlanResult.approximateLegs`) — ephemeral, like
   * `flashLeg` above, not part of the persisted `Route`. Not only the
   * first/last entry: a leg anywhere in the route can be flagged. The
   * overlay only honours this while `route()?.id === GO_HERE_ROUTE_ID`,
   * so a stale flag from an earlier tap never bleeds onto a different
   * route. */
  approximateLegs: Accessor<boolean[]>;
  /** Drag committed by the layer: move a STOP to a new position. Called many
   * times across a drag (the rubber-band visual); bracket a real drag with
   * `beginWaypointDrag`/`endWaypointDrag` so the leg(s) touching it are
   * re-routed through the planner exactly once, at drag-end — not "move the
   * dot, leave a straight line". Only ever called with a `stop: true`
   * waypoint's id; a router-inserted bend has no handle to grab. */
  moveWaypoint(id: string, at: GeoPoint): void;
  /** Open a drag SESSION on a stop (the overlay calls this the moment a press on
   * its handle moves past the slop): suppresses per-move auto-saves so the
   * followed route only reaches the boat once, at drag-end. A no-op if `id`
   * is not a stop. */
  beginWaypointDrag(id: string): void;
  /** Close the drag session: re-plan the leg(s) touching the dragged stop at its
   * dropped position, then flush the save (immediate for the followed route,
   * debounced otherwise). */
  endWaypointDrag(): void;
  /** Abort an in-flight drag (a pinch cancelled it): restore the handle to `at`
   * (its pre-drag position), re-plan nothing, save nothing. */
  abortDrag(id: string, at: GeoPoint): void;
  /** A live PIN to draw for the From end before any real route exists — so
   * picking (or even just opening the editor with a fix) shows something on
   * the chart immediately, not only once both ends are known and the first
   * leg has been planned. The staged point (a search pick or "Choose on
   * map"), or — the "defaults to the boat" behaviour — the boat's own live
   * position when nothing is staged and a fix exists. `null` once a real
   * route exists (its own first waypoint IS the pin by then) or when there
   * is genuinely nothing to show yet. */
  previewFrom: Accessor<{ point: GeoPoint; label: string } | null>;
  /** The same, for the To end — never falls back to anything (there is no
   * sensible default destination), so `null` until something is staged. */
  previewTo: Accessor<{ point: GeoPoint; label: string } | null>;
}

export interface RoutesModel extends RouteOverlay {
  /** Whether a leg is being followed — drives band.top's liveness. */
  following: Accessor<boolean>;
  /** Is there a boat position to route FROM? Gates "Go here". */
  hasFix: Accessor<boolean>;
  /** "Go here": build a direct route from the boat to `to`, save it, and make it
   * the active followed leg. Resolves `false` — building nothing — with no fix. */
  goTo(to: GeoPoint, label?: string): Promise<boolean>;
  /** "Go to" with "Beta autorouting" OFF: the same fixed `go-here` route, but a
   * plain STRAIGHT line boat → `to` (`directRoute`) — no router call, no
   * hazard check — saved and followed. `false`, building nothing, with no fix. */
  goStraight(to: GeoPoint, label?: string): Promise<boolean>;
  /** Follow a saved route from the nearest leg ahead (`./follow.ts`). Not
   * beta-gated. Another route followed and not `confirmed` → asks "Switch
   * to …?" through a notice; the same route again → a no-op. */
  follow(route: Route, opts?: { confirmed?: boolean }): Promise<FollowResult>;
  /** The followed route and its target index, or null. */
  followLeg: Accessor<FollowLeg | null>;
  /** Next (+1) / previous (-1) waypoint of the followed route. */
  skipWaypoint(delta: 1 | -1): Promise<boolean>;
  /** Make one waypoint of a route the active target ("Start here"). */
  startAt(routeId: string, waypointId: string): Promise<boolean>;
  /** Every saved route, for the route-list surface (`RouteList.tsx`). */
  routes: Accessor<Route[]>;
  /** The followed route's id, or null — the list marks which one is live. */
  activeRouteId: Accessor<string | null>;
  /** Open a saved route INTO the editor (a copy). Edits auto-save in place. */
  editRoute(route: Route): void;
  /** Start a BLANK new route and enter the editor — REGARDLESS of what is being
   * followed. Carries a one-shot "seed empty" flag past `seedDraft`'s default
   * (continue the followed route), so the followed one is untouched. */
  newRoute(): void;
  /** Delete a saved route. Deleting the followed one stops the follow too. */
  removeRoute(route: Route): Promise<void>;
  /** Save the return passage as a NEW route (`reversedCopy`), leaving the
   * original — and any follow of it — untouched. Notifies, offering to open
   * the copy in the manual editor. Resolves to the saved copy, or null. */
  reverseRoute(route: Route): Promise<Route | null>;
  /** Import a GPX file's routes (and tracks, simplified) as new routes
   * (`./gpx.ts`), then notify what happened. Resolves to the routes saved. */
  importGpx(text: string, fileName?: string): Promise<Route[]>;
  // The plan-mode surface (RT-R2): the sheet's read/action side, wired to the
  // same editor operations rather than reinventing tap/insert/GO.
  /** The route being edited, or null when closed. `route()` also returns it
   * while editing, but the sheet wants the draft SPECIFICALLY. */
  draft: Accessor<Route | null>;
  /** The draft measured at rest at its own planning speed (`planRouteMetrics`). */
  plan: Accessor<RoutePlan>;
  /** One line of guidance for the sheet's peek. */
  editorHint: Accessor<string>;
  /** Is the draft the route currently being FOLLOWED? Then the sheet offers a
   * Stop as well as a re-follow. */
  followingDraft: Accessor<boolean>;
  /** Set the draft's planning speed (knots); auto-saved like any edit. */
  setPlanSpeed(kn: number): void;
  /** Rename the draft (the backend caps `name` at 64). Also auto-saved. */
  renameDraft(name: string): void;
  /** Reverse the draft's whole From/Stop/To order — the return passage,
   * mid-edit ("Flip"). Geometry only (no re-plan needed: a route through the
   * same points sailed backwards is still a valid route), so it is instant. */
  reverseDraft(): void;
  /** GO: the draft is already saved (auto-save), so this just names the
   * target as the active leg and leaves the editor (invariant #8). */
  saveAndFollow(): Promise<void>;
  /** "Start route" (#RT-GONAV item 2): follow from the closest-next join point —
   * the arrival waypoint of the leg the boat is nearest, or the first waypoint
   * with no fix. Ignores the selection. */
  startRoute(): Promise<void>;
  /** Open the saved-routes MANAGER (#RT-GONAV item 3), leaving the editor first. */
  openManager(): void;
  /** App wires this to `openRoutes` so `openManager` can reach the route list. */
  bindOpenManager(open: () => void): void;
  // ── The From/Stop/To list — the Google-Maps-style autorouting surface ──────
  //
  // The sheet (RouteSheet.tsx) renders `draftStops()` as one ordered list, From
  // through To. Every structural edit (set a slot, insert/remove/reorder a stop)
  // re-plans through `core/routing.ts`'s `planRoute` and rewrites the draft's
  // whole `waypoints` array from the resulting stop list — a bend the router
  // inserts along a leg is never something a person edits directly, so there is
  // no partial-splice path to keep in sync; see `rebuildFromStops` for why a
  // full rebuild, not a touched-legs-only patch, is the whole of it.
  /** The stops a person actually chose, in route order — From, then each Stop,
   * then To — derived straight from `draft().waypoints.filter(w => w.stop)`.
   * Empty for a brand-new draft (nothing chosen yet; the sheet shows `fromLabel`
   * and a blank To in that state instead). */
  draftStops: Accessor<Waypoint[]>;
  /** True while a stop edit's real re-plan (`rebuildFromStops`, a network round
   * trip per leg) is in flight — the UI's one "something is happening" signal.
   * The edit itself is never invisible while this is true: every mutator
   * (`setStop`/`insertStop`/`removeStop`/`reorderStops`/the drag session)
   * patches the draft with a straight-line PROVISIONAL shape synchronously,
   * before this even flips true, so a pin/row appears immediately and this
   * flag only covers the gap until the real routed geometry replaces it. */
  planning: Accessor<boolean>;
  /** Set (or replace) one slot's point — From, To (the current last stop), or an
   * existing stop by id — and re-plan the leg(s) touching it. On a brand-new
   * draft, setting `{kind:"from"}` only STAGES the point (`fromLabel`/
   * `pendingFrom`, nothing to plan yet); setting `{kind:"to"}` there SEEDS the
   * whole route from the staged (or boat) From to this point — the same "search
   * or tap the chart" first move the empty bar has always offered. Resolves
   * `false` on no boat fix (seeding with no staged From and none given) or a
   * slot that doesn't resolve to an existing stop. */
  setStop(slot: StopSlot, point: GeoPoint, label?: string): Promise<boolean>;
  /** Insert a brand-new stop immediately before the stop `beforeId` — "+ Add a
   * stop" passes the current To's id, so the new stop lands just ahead of it.
   * Re-plans the two legs it now splits. `false` if `beforeId` isn't a stop on
   * the draft (there is always at least a To to insert before once any route
   * exists — the button is gated on that in the UI). */
  insertStop(beforeId: string, point: GeoPoint, label?: string): Promise<boolean>;
  /** Drop a stop and re-plan once between its former neighbours, collapsing two
   * legs into one. Dropping down to a single remaining stop leaves it as the
   * draft's sole waypoint (no leg to plan). A no-op if `id` isn't a stop. */
  removeStop(id: string): Promise<void>;
  /** Move a stop to a new position in the From/Stop/To order and re-plan every
   * leg touching its old or new neighbours. Indices are into `draftStops()`; a
   * no-op if either is out of range. */
  reorderStops(fromIndex: number, toIndex: number): Promise<void>;
  /** The staged From's display label — "Boat" (the default) until a search
   * pick or "Choose on map" stages a different start point (only meaningful
   * before the draft has any stops — see `setStop`). */
  fromLabel: Accessor<string>;
  /** Reset the From slot back to the boat: on a brand-new draft, resets the
   * staging; on a draft with stops, replaces the live From stop with the
   * boat's current fix (a real re-plan, like any other `setStop`). Resolves
   * with no fix and a draft that already has stops (nothing to set it to). */
  setFromBoat(): void;
  /** Stage or set a custom From point — see `setStop`'s `{kind:"from"}` case,
   * which this delegates to. `label` falls back to a generic name when
   * omitted/blank. */
  setFromPoint(point: GeoPoint, label?: string): void;
  /** The staged To's display label, or `null` while nothing is staged yet
   * (the sheet shows its own "Choose destination" placeholder then) — the
   * symmetric read to `fromLabel`, now that EITHER end can be picked first. */
  toLabel: Accessor<string | null>;
  /** Stage the boat's current position as the DESTINATION — the same "use
   * boat" affordance `setFromBoat` offers the From slot, now offered for To
   * as well. Resolves with no fix (nothing to set it to; the UI is expected
   * to not offer this option at all in that state — see `hasFix`). */
  setToBoat(): void;
  /** Stage or set a custom To point — see `setStop`'s `{kind:"to"}` case,
   * which this delegates to. Unlike `setFromPoint`, staging To NEVER
   * requires a boat fix: it just shows a pin (`previewTo`) and waits — the
   * route builds itself the moment a From becomes available too (staged, or
   * the boat, whichever comes first — see `trySeedFromStaged`). */
  setToPoint(point: GeoPoint, label?: string): void;
  /** Which slot an armed "Choose on map" resolves the NEXT chart tap against —
   * `null` when nothing is armed. */
  pickingOnMap: Accessor<MapPickTarget | null>;
  /** Arm "Choose on map" for `target` (default `{kind:"to"}`) — the search
   * overlay's pinned suggestion, for any slot. */
  beginPickOnMap(target?: MapPickTarget): void;
  /** Back out of an armed "Choose on map" without picking anything. */
  cancelPickOnMap(): void;
  /** Open the shared search overlay to resolve `target` — the From row, the To
   * row, an existing stop row (re-pick it in place), or "+ Add a stop"
   * (`{kind:"insert", beforeId}`). A no-op until `bindOpenSearchForSlot` is
   * wired (App.tsx). */
  openSearchForSlot(target: MapPickTarget): void;
  /** App wires this to open the search overlay with the right pinned
   * suggestions for `target`'s kind ("Use boat position" ahead of "Choose on
   * map" only for `{kind:"from"}`) and an `onSelect` that resolves through
   * `setStop`/`insertStop` (or `setFromBoat`/`setFromPoint` for `"from"`). */
  bindOpenSearchForSlot(open: (target: MapPickTarget) => void): void;
  /** Stop following (without deleting) — present only while `followingDraft`. */
  stopFollowing(): Promise<void>;
  /** Delete the whole route and leave: server-side if ever saved, else discard. */
  deleteDraftRoute(): Promise<void>;
  /** Flash a leg on the chart (the segment `seg`→`seg+1`) for ~1.4s — a leg row
   * tapped in the sheet reads onto the chart for a moment. */
  flashLegAt(seg: number): void;
  /** Leave the editor — routes through `modes.leave`, which flushes any pending
   * debounced save and drops the draft. The sheet's X. No confirm: everything is
   * already saved. */
  exitEditor(): void;
  /** App wires this to `modes.leave()` so GO/the X can close the editor. */
  bindExit(exit: () => void): void;
  /** App wires this to `modes.enter("route-edit")` so `editRoute` can open it. */
  bindEnter(enter: () => void): void;
}

/** The routes feature: the editor mode, the band.top instruments, and the
 * model the overlay layer reads. A factory over its dependencies. */
/** A transient arrival notice, ready for the notice strip. */
/** One slot in the From/Stop/To list: the start, the current last stop (the
 * destination), or an existing middle stop by id. What `setStop` resolves
 * against. */
export type StopSlot = { kind: "from" } | { kind: "to" } | { kind: "stop"; id: string };
/** Which slot an armed "Choose on map" (or an open search panel) resolves the
 * next pick against — a `StopSlot` to REPLACE a point in place, or an INSERT
 * ahead of an existing stop ("+ Add a stop" always inserts before the
 * current To). See `pickingOnMap`/`beginPickOnMap`/`openSearchForSlot`. */
export type MapPickTarget = StopSlot | { kind: "insert"; beforeId: string };

export interface ArrivalNotice {
  id: string;
  title: string;
  detail?: string;
}

export function createRoutes(deps: {
  signalk: SignalKState;
  client: RoutesClient;
  /** Injectable for deterministic tests; defaults to a real uuid. */
  mintId?: () => string;
  /** Fired when the followed leg reaches a waypoint or completes — a FRONTEND
   * heuristic (`arrivalEvent`), since the backend has no arrival event channel. */
  onArrival?: (notice: ArrivalNotice) => void;
  /** Push a transient notice to the SAME strip `onArrival` feeds — surfacing a
   * save failure / cross-device conflict rather than a silent `console.error`. */
  notify?: (notice: Notice) => void;
  /** Injectable for `goTo`'s planning request — same seam
   * `features/routeTest`'s `opts.fetch` drives, chosen for the same
   * cross-file mock-leak reason (CLAUDE.md). Defaults to the real `fetch`. */
  fetch?: PlanFetch;
  /** The route the MANUAL editor (features/routeDraw) is drawing a draft of,
   * or null. Its saved copy is not drawn meanwhile, so the two never
   * double-draw; the boat's own course cue (`targetLine`) still is. */
  hiddenRouteId?: Accessor<string | null>;
  /** Open the manual editor on a route — the route card's "Edit points". */
  editPoints?: (route: Route) => void;
  /** Open the leg table on a route — the route card's "Legs". */
  showLegs?: (route: Route) => void;
  /** XML parser for GPX import; defaults to `DOMParser` (`./gpx.ts`). Tests
   * inject `./testXml.ts` — bun has no DOM. */
  parseXml?: XmlParse;
}): { feature: AppFeature; model: RoutesModel } {
  const { signalk, client } = deps;
  const mintId = deps.mintId ?? mintUuid;
  const fetchImpl = deps.fetch ?? fetch;

  const [draft, setDraft] = createSignal<Route | null>(null);
  // Armed by "Choose on map" (the search overlay's pinned suggestion), for
  // WHICH slot — the NEXT chart tap resolves against that slot instead of
  // being inert (see the mode's `onClick`). `null` = not armed. One-shot;
  // cleared the moment a tap consumes it, or by `cancelPickOnMap`.
  const [awaitingMapPick, setAwaitingMapPick] = createSignal<MapPickTarget | null>(null);
  // The staged From/To — EITHER end can be picked first now (search, "Choose
  // on map", or "Use boat position"), independently, before a route exists.
  // `null` for From means the default, the boat — `trySeedFromStaged` falls
  // back to `signalk.self()` in that case; `null` for To means genuinely
  // nothing picked yet (there is no sensible default destination). Both are
  // consumed (reset to `null`) the moment a draft is actually seeded from
  // them, since staging is only ever a pre-route thing — once the waypoints
  // are real, every further edit goes through `setStop`/`setFromBoat`/
  // `setToBoat` instead, a real re-plan rather than a stage. `namedByUser`
  // marks a label that came from the caller (a search result) rather than
  // this file's own coordinate fallback, so the "what's charted here"
  // upgrade (`nearestPlace`) only ever fires for the latter.
  type Staged = { point: GeoPoint; label: string; namedByUser: boolean; isBoat?: boolean };
  const [pendingFrom, setPendingFrom] = createSignal<Staged | null>(null);
  const [pendingTo, setPendingTo] = createSignal<Staged | null>(null);
  // The stop currently being dragged, or null — set at drag-start, cleared at
  // drag-end / abort. Read by the overlay so the dragged handle can highlight.
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  // True between `beginWaypointDrag` and `endWaypointDrag`/`abortDrag`: while a
  // real drag is in flight, per-move edits DO NOT schedule an auto-save (so a
  // >500ms pause mid-drag can never publish intermediate geometry to the
  // autopilot) — the single re-plan + save is flushed at drag-end instead.
  // Direct `moveWaypoint` callers (programmatic / tests) leave it false and
  // keep the trailing-debounced save.
  let inDrag = false;
  // A COUNTER, not a boolean: `commitRebuild` (below) can overlap — a fast
  // second edit before the first one's re-plan lands — and `planning()` must
  // stay true until the LAST one settles, not flip false the moment any one
  // of them finishes.
  const [planningCount, setPlanningCount] = createSignal(0);
  const planning = () => planningCount() > 0;
  // The leg the plan sheet asked to flash, and its clearing timer.
  const [flashLeg, setFlashLeg] = createSignal<number | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const FLASH_MS = 1400;
  const flashLegAt = (seg: number) => {
    setFlashLeg(seg);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlashLeg(null), FLASH_MS);
  };
  onCleanup(() => clearTimeout(flashTimer));
  // The last "Go here" plan's per-leg approximate flags (`PlanResult.
  // approximateLegs`) — ephemeral, like `flashLeg` above: never part of
  // the persisted `Route`/`Waypoint` shape (no `/routes` schema change
  // needed for this), only ever read by the overlay while the CURRENTLY
  // DRAWN route is the go-here one (`route()?.id === GO_HERE_ROUTE_ID` —
  // a route the user opened for editing, or the followed leg, never
  // carries a stale flag from an earlier "Go here" tap this way, with no
  // separate clearing needed). Set right after a plan comes back; left
  // at `[]` on the network-failure fallback (`directRoute`) — a
  // different, already-notified failure mode, not "the router found
  // part of this unreachable".
  const [approximateLegs, setApproximateLegs] = createSignal<boolean[]>([]);
  // Auto-save: no Save/Discard. Every edit schedules a trailing-debounced save;
  // a drag's many `moveWaypoint` calls collapse to one at drag-end. `persist`
  // cancels any pending timer, so an explicit GO/close never races it.
  const SAVE_DEBOUNCE_MS = 500;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  // Chained: each `persist` awaits the previous, so an immediate save can never
  // overlap a debounced one with a stale `If-Match` (#RT-ADDRACE). See
  // docs/architecture/route-model.md ("rev is server SYNC state").
  let saveChain: Promise<string | null> = Promise.resolve(null);
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void persist();
    }, SAVE_DEBOUNCE_MS);
  };
  onCleanup(() => clearTimeout(saveTimer));
  // A route the list asked to open, consumed by the next `seedDraft`. Lets the
  // editor be opened onto an arbitrary saved route, not only the followed one.
  const [pendingOpen, setPendingOpen] = createSignal<Route | null>(null);
  // A one-shot "start blank" flag, consumed by the next `seedDraft`. Overrides the
  // seed-from-followed default so a NEW route can be begun while a route is being
  // followed (`newRoute` below) without the followed one hijacking the draft.
  const [pendingBlank, setPendingBlank] = createSignal(false);
  let exit: (() => void) | undefined;
  let enterEditor: (() => void) | undefined;
  // App wires this to `openRoutes` (the SAME mechanism the command palette's
  // "Open routes" and the rail Tools menu use) so the editor can open the
  // saved-routes manager (#RT-GONAV item 3). Left undefined outside App/tests.
  let openManagerFn: (() => void) | undefined;
  // App wires this to open the shared search overlay for a given slot — the
  // right pinned suggestions for its kind ("Use boat position" ahead of
  // "Choose on map" only for `{kind:"from"}`) and an `onSelect` that resolves
  // through `setStop`/`insertStop` (or `setFromBoat`/`setFromPoint` for
  // `"from"`). Same bind-a-callback shape as `bindOpenManager`. Left
  // undefined outside App/tests, in which case every From/Stop/To row is
  // simply inert.
  let openSearchForSlotFn: ((target: MapPickTarget) => void) | undefined;

  // No undo/redo stack: the redesign (route tool, autorouting-only) replaces
  // history-based correction with direct list actions instead — delete a
  // stop, drag-reorder it, or Flip the whole order. A mistaken edit is undone
  // by doing the obvious opposite action, not by popping a snapshot.

  // ── The followed leg — read from the PERSISTED active leg, never inferred ──
  const active = () => client.active();
  const following = () => !!active();
  const activeRoute = createMemo<Route | null>(() => {
    const a = active();
    return a ? (client.routes().find((r) => r.id === a.route_id) ?? null) : null;
  });
  const activeWaypoint = () => active()?.waypoint_id ?? null;
  /** The followed leg's steering mode (#RF-NAVMODE), or null when not
   * following. `?? "line"` is belt-and-braces for an unnormalised leg. */
  const activeMode = (): SteerMode | null => {
    const a = active();
    return a ? (a.mode ?? "line") : null;
  };

  /** The destination waypoint of the active leg, and the one before it — the
   * track for cross-track is (previous → active). If the active waypoint is the
   * first on the route there is no track, only a bearing to it. */
  const leg = createMemo(() => {
    const r = activeRoute();
    const a = active();
    if (!r || !a) return null;
    const i = r.waypoints.findIndex((w) => w.id === a.waypoint_id);
    if (i < 0) return null;
    return { to: r.waypoints[i], from: i > 0 ? r.waypoints[i - 1] : null, index: i, route: r };
  });

  /** Boat→destination metrics, or null with no fix / no leg. The arithmetic —
   * DTW, the DTG sum and both TTGs — is the pure `routeMetrics`; this memo only
   * gathers the boat, the route and the followed index for it. */
  const metrics = createMemo(() => {
    const l = leg();
    const self = signalk.self();
    if (!l || !self) return null;
    const boat: GeoPoint = { lng: self.lng, lat: self.lat };
    const sogKn = knotsFromMs(self.sogMs ?? 0);
    return { ...routeMetrics(boat, l.route.waypoints, l.index, sogKn), to: l.to, index: l.index };
  });

  /** THE YELLOW STEERING CUE (#RF-NAVMODE, #wutpmypo): the ACTUAL SignalK
   * course, not mivnav's local leg state (which lied under a second client).
   * See docs/architecture/route-model.md. */
  const targetLine = createMemo<{ from: GeoPoint; to: GeoPoint } | null>(() => {
    const self = signalk.self();
    const c = signalk.course();
    if (c?.nextLat == null || c?.nextLng == null) return null;
    const from: GeoPoint | null =
      c.prevLat != null && c.prevLng != null
        ? { lng: c.prevLng, lat: c.prevLat }
        : self
          ? { lng: self.lng, lat: self.lat }
          : null;
    if (!from) return null;
    return { from, to: { lng: c.nextLng, lat: c.nextLat } };
  });

  /** The steer-to (rejoin) line: boat fix → the cross-track return point on the
   * LOCAL active leg. Suppressed whenever `targetLine()` is non-null — at
   * most one steering cue draws at a time, and `targetLine` is the truth. */
  const steerLine = createMemo<{ from: GeoPoint; to: GeoPoint } | null>(() => {
    const l = leg();
    const self = signalk.self();
    if (!l || !self) return null;
    if (targetLine()) return null;
    const boat: GeoPoint = { lng: self.lng, lat: self.lat };
    const to = l.from ? projectOntoLeg(boat, wpPoint(l.from), wpPoint(l.to)).point : wpPoint(l.to);
    return { from: boat, to };
  });

  // Arrival notices: turns each polled leg MOVE into a notice via the pure
  // `arrivalEvent`. Names resolve AT THE MOMENT OF TRANSITION — the reached
  // waypoint is the PREVIOUS snapshot's.
  if (deps.onArrival) {
    const onArrival = deps.onArrival;
    interface LegSnapshot extends LegPos {
      routeName: string;
      waypointName: string;
    }
    const snapshot = createMemo<LegSnapshot | null>(() => {
      const l = leg();
      if (!l) return null;
      return {
        routeId: l.route.id,
        index: l.index,
        count: l.route.waypoints.length,
        routeName: l.route.name.trim(),
        waypointName: l.to.name.trim(),
      };
    });
    const label = (name: string, index: number) => name || `WP ${index + 1}`;
    let prev: LegSnapshot | null = null;
    createEffect(() => {
      const cur = snapshot();
      const ev = arrivalEvent(prev, cur);
      const before = prev;
      prev = cur;
      if (!ev) return;
      if (ev.kind === "reached" && before && cur) {
        onArrival({
          id: `arrival:${cur.routeId}:${ev.reachedIndex}`,
          title: `Reached ${label(before.waypointName, ev.reachedIndex)}`,
          detail: `Next: ${label(cur.waypointName, cur.index)}`,
        });
      } else if (ev.kind === "complete" && before) {
        onArrival({
          id: `arrival-complete:${before.routeId}`,
          title: "Route complete",
          detail: before.routeName || undefined,
        });
      }
    });
  }

  // ── The From/Stop/To list — the autorouting engine ─────────────────────────
  //
  // Every structural edit below (set a slot, insert/remove/reorder a stop)
  // funnels through `rebuildFromStops`: rebuild the ENTIRE flattened
  // `waypoints` array from an ordered list of stop seeds, re-planning every
  // leg between them. A partial "only re-plan the touched leg(s)" splice would
  // save a network round trip or two, but a real route here runs to a handful
  // of stops — the full rebuild is simple, cannot desync a bend from the stop
  // it borders, and there is no separate "planned route" state to keep in
  // sync with the persisted draft. `patch`/`scheduleSave` are the same
  // primitives every other edit uses.
  const patch = (fn: (r: Route) => Route) => setDraft((r) => (r ? fn(r) : r));

  interface StopSeed {
    id: string;
    label: string;
    point: GeoPoint;
  }
  const toSeed = (w: Waypoint): StopSeed => ({ id: w.id, label: w.name, point: wpPoint(w) });

  /** `planRoute` plus the "a router miss still returns a valid (if straight)
   * `PlanResult`; only the REQUEST failing falls back to a bare straight
   * line" split `goTo` also uses. */
  const planLegOrFallback = async (
    from: GeoPoint,
    to: GeoPoint,
  ): Promise<{ points: GeoPoint[]; approx: readonly boolean[] }> => {
    try {
      const p = await planRoute(from, to, undefined, fetchImpl);
      if (planIsUnreachable(p)) {
        deps.notify?.({
          id: "route-plan-hazard",
          title: "Route may cross charted danger",
          detail: p.warnings[0],
        });
      }
      return { points: p.waypoints, approx: p.approximateLegs };
    } catch (e) {
      console.error("route: plan-to failed, falling back to a straight line", e);
      deps.notify?.({
        id: "route-plan-unreachable",
        title: "Couldn’t reach the router",
        detail: "Drew a straight line instead — verify manually before following.",
      });
      return { points: [from, to], approx: [] };
    }
  };

  /** Rebuild a whole `Waypoint[]` from an ordered list of stops: plan every
   * leg between consecutive stops and concatenate, tagging each seed's own
   * point `stop: true` (keeping its id/label) and every router-inserted bend
   * `stop: false` (a fresh id, generic name) — the same per-waypoint
   * `approximate` convention `routeFromPlan` uses (waypoint `i`'s flag is the
   * INCOMING leg's). A single seed needs no planning at all. */
  const rebuildFromStops = async (stops: readonly StopSeed[]): Promise<Waypoint[]> => {
    if (stops.length === 0) return [];
    if (stops.length === 1) {
      const s = stops[0]!;
      return [{ id: s.id, name: s.label, lat: s.point.lat, lon: s.point.lng, approximate: false, stop: true }];
    }
    const out: Waypoint[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i]!;
      const b = stops[i + 1]!;
      const { points, approx } = await planLegOrFallback(a.point, b.point);
      // `points[0]` is `a` — already pushed as the previous pair's own
      // endpoint for every pair but the first, so only the FIRST pair
      // contributes it.
      for (let k = i === 0 ? 0 : 1; k < points.length; k++) {
        const p = points[k]!;
        const approximate = k > 0 ? (approx[k - 1] ?? false) : false;
        if (k === 0) out.push({ id: a.id, name: a.label, lat: p.lat, lon: p.lng, approximate, stop: true });
        else if (k === points.length - 1)
          out.push({ id: b.id, name: b.label, lat: p.lat, lon: p.lng, approximate, stop: true });
        else out.push({ id: mintId(), name: "Waypoint", lat: p.lat, lon: p.lng, approximate, stop: false });
      }
    }
    return out;
  };

  /** The stops a person actually chose, in route order — `RoutesModel`'s own
   * doc has the full contract. */
  const draftStops = createMemo<Waypoint[]>(() => draft()?.waypoints.filter((w) => w.stop) ?? []);

  /** The synchronous, NETWORK-FREE shape of `rebuildFromStops`: straight
   * lines between consecutive seeds, `approximate: true` on every incoming
   * leg but the first (reusing the existing dashed "not yet verified" paint
   * — see `overlay.ts` — since a provisional line is exactly that, just for
   * a different reason). This is what makes a stop edit show up on the map
   * and in the list INSTANTLY: every mutator below patches with this before
   * `commitRebuild`'s awaited real re-plan even starts. */
  const provisionalRebuild = (stops: readonly StopSeed[]): Waypoint[] =>
    stops.map((s, i) => ({
      id: s.id,
      name: s.label,
      lat: s.point.lat,
      lon: s.point.lng,
      approximate: i > 0,
      stop: true,
    }));

  /** The label a picked point shows the INSTANT it lands — the caller's own
   * name (a search result already has one) or, for a bare map tap, its
   * coordinates (`core/coordinate.ts`'s canonical DDM form) — never the old
   * generic "Waypoint", and never blank while a real name resolves. */
  const instantLabel = (point: GeoPoint, label?: string): string =>
    label?.trim() || formatCoordinate(point.lat, point.lng);

  /** Run the real leg re-plan (`rebuildFromStops`) and, for a fresh
   * unlabeled point, a "what's charted here" lookup (`nearestPlace`)
   * TOGETHER — `Promise.all`, not sequentially, so the name lookup is free
   * (it settles well inside the routing round trip) and, critically,
   * whichever finishes first can never clobber the other: the final patch
   * is applied ONCE, after both are in. `planningCount` brackets the whole
   * thing — the one signal every stop mutator's "is something happening"
   * indicator reads. */
  const commitRebuild = async (
    seeds: readonly StopSeed[],
    named?: { id: string; point: GeoPoint; alreadyNamed: boolean },
  ): Promise<Waypoint[]> => {
    setPlanningCount((n) => n + 1);
    try {
      const namePromise =
        named && !named.alreadyNamed ? nearestPlace(named.point, fetchImpl) : Promise.resolve(null);
      const [resolved, waypoints] = await Promise.all([namePromise, rebuildFromStops(seeds)]);
      if (!resolved || !named) return waypoints;
      // The real re-plan already carries the coordinate label baked in (it
      // snapshotted `seeds` before the name lookup could have finished) —
      // upgrade just that one waypoint now that a real name is in.
      return waypoints.map((w) => (w.id === named.id ? { ...w, name: resolved.title } : w));
    } finally {
      setPlanningCount((n) => n - 1);
    }
  };

  /** Once EITHER end is staged, try to complete the route: From is the
   * staged point or — the "defaults to the boat" behaviour — the boat's
   * live position; To is the staged point. Builds only when BOTH are
   * actually available; otherwise a no-op — whichever end WAS just staged
   * already has its own preview pin (`previewFrom`/`previewTo`), so staging
   * alone is never invisible. Called after every staging write
   * (`setFromPoint`/`setToPoint`/`setFromBoat`/`setToBoat`), so either
   * order — From first, To first, or the boat default already covering
   * From the moment a bare To is staged — completes the instant the second
   * end becomes known. */
  const trySeedFromStaged = async (): Promise<void> => {
    if (draftStops().length > 0) return; // already a real route — nothing to seed
    const to = pendingTo();
    if (!to) return; // still needs a destination
    const staged = pendingFrom();
    // The boat can be EITHER end, never both at once (the user's own
    // framing): if To is explicitly staged AS the boat and nothing else is
    // staged for From, do NOT fall through to the "defaults to the boat"
    // behaviour below — that would silently build a zero-distance
    // boat-to-boat route. Stay staged; the pin already shows either way,
    // and this only ever un-blocks once a genuinely different From arrives.
    if (!staged && to.isBoat) return;
    let fromPoint = staged?.point ?? null;
    const fromName = staged?.label ?? "Boat";
    if (!fromPoint) {
      const self = signalk.self();
      if (!self) return; // no fix either — stay staged; To's own pin already shows
      fromPoint = { lng: self.lng, lat: self.lat };
    }
    const fromId = mintId();
    const toId = mintId();
    const seeds: StopSeed[] = [
      { id: fromId, label: fromName, point: fromPoint },
      { id: toId, label: to.label, point: to.point },
    ];
    patch((cur) => (cur ? { ...cur, name: to.label, waypoints: provisionalRebuild(seeds) } : cur));
    haptic();
    setPendingFrom(null);
    setPendingTo(null);
    const waypoints = await commitRebuild(seeds, { id: toId, point: to.point, alreadyNamed: to.namedByUser });
    // Start and goal snapped to the same spot: nothing new to show.
    if (waypoints.length < 2) return;
    const finalName = waypoints.find((w) => w.id === toId)?.name ?? to.label;
    patch((cur) => (cur ? { ...cur, name: finalName, waypoints } : cur));
    scheduleSave();
  };

  const setStop = async (slot: StopSlot, point: GeoPoint, label?: string): Promise<boolean> => {
    const r = draft();
    if (!r) return false;
    const name = instantLabel(point, label);
    const stops = draftStops();
    if (stops.length === 0) {
      // Await the SAME staging call `setFromPoint`/`setToPoint` make (not a
      // second, redundant `trySeedFromStaged()` of our own — by the time
      // that one's own synchronous portion returns control here, the
      // staged signal it consumed is already cleared, so a second call
      // would see nothing to do and resolve instantly, defeating the
      // await): `setStop`'s own contract is "settled when this resolves",
      // same as every other branch below.
      await (slot.kind === "from" ? stageFrom(point, label) : stageTo(point, label));
      return true;
    }
    const idx =
      slot.kind === "from" ? 0 : slot.kind === "to" ? stops.length - 1 : stops.findIndex((s) => s.id === slot.id);
    if (idx < 0) return false;
    const targetId = stops[idx]!.id;
    const seeds = stops.map((s, i) => (i === idx ? { id: s.id, label: name, point } : toSeed(s)));
    patch((cur) => ({ ...cur, waypoints: provisionalRebuild(seeds) }));
    haptic();
    const waypoints = await commitRebuild(seeds, { id: targetId, point, alreadyNamed: !!label?.trim() });
    patch((cur) => ({ ...cur, waypoints }));
    scheduleSave();
    return true;
  };

  const insertStop = async (beforeId: string, point: GeoPoint, label?: string): Promise<boolean> => {
    const stops = draftStops();
    const idx = stops.findIndex((s) => s.id === beforeId);
    if (idx < 0) return false;
    const name = instantLabel(point, label);
    const newId = mintId();
    const seeds = [
      ...stops.slice(0, idx).map(toSeed),
      { id: newId, label: name, point },
      ...stops.slice(idx).map(toSeed),
    ];
    patch((cur) => ({ ...cur, waypoints: provisionalRebuild(seeds) }));
    haptic();
    const waypoints = await commitRebuild(seeds, { id: newId, point, alreadyNamed: !!label?.trim() });
    patch((cur) => ({ ...cur, waypoints }));
    scheduleSave();
    return true;
  };

  const removeStop = async (id: string): Promise<void> => {
    const remaining = draftStops()
      .filter((s) => s.id !== id)
      .map(toSeed);
    patch((cur) => ({ ...cur, waypoints: provisionalRebuild(remaining) }));
    const waypoints = await commitRebuild(remaining);
    patch((cur) => ({ ...cur, waypoints }));
    scheduleSave();
  };

  const reorderStops = async (fromIndex: number, toIndex: number): Promise<void> => {
    const seeds = draftStops().map(toSeed);
    if (fromIndex < 0 || fromIndex >= seeds.length || toIndex < 0 || toIndex >= seeds.length) return;
    const [moved] = seeds.splice(fromIndex, 1);
    seeds.splice(toIndex, 0, moved!);
    patch((cur) => ({ ...cur, waypoints: provisionalRebuild(seeds) }));
    const waypoints = await commitRebuild(seeds);
    patch((cur) => ({ ...cur, waypoints }));
    scheduleSave();
  };

  // ── The drag session — grab a STOP handle, drop it, re-plan its leg(s) ─────
  //
  // A live drag rubber-bands the point directly (`moveWaypoint`, called many
  // times, no re-plan) so it tracks the finger with no network round trip in
  // the loop; only `endWaypointDrag` re-plans, once, against the dropped
  // position — "move the dot, leave a straight line" is exactly what pin
  // dragging no longer does.
  const moveWaypoint = (id: string, at: GeoPoint) => {
    // A real drag defers its single save to drag-end (`endWaypointDrag`), so a
    // mid-drag pause never publishes an intermediate to the followed route. A
    // direct caller (not in a drag session) keeps the trailing-debounced save.
    if (!inDrag) scheduleSave();
    patch((r) => ({
      ...r,
      waypoints: r.waypoints.map((w) => (w.id === id ? { ...w, lat: at.lat, lon: at.lng } : w)),
    }));
  };

  const beginWaypointDrag = (id: string) => {
    const wp = draft()?.waypoints.find((w) => w.id === id);
    if (!wp?.stop) return; // only a chosen stop has a handle to grab
    inDrag = true;
    setDraggingId(id);
    haptic(); // grabbed a handle — a confirmation tick (#RT-FEEL G4)
  };

  const endWaypointDrag = () => {
    if (!inDrag) return;
    inDrag = false;
    const id = draggingId();
    setDraggingId(null);
    const wp = id ? draft()?.waypoints.find((w) => w.id === id) : undefined;
    if (!id || !wp) return;
    const seeds = draftStops().map((s) =>
      s.id === id ? { id: s.id, label: s.name, point: wpPoint(wp) } : toSeed(s),
    );
    // Instant straight-line stub to the dragged point's neighbors — the
    // dragged pin itself already tracked the finger (`moveWaypoint`, every
    // move), but its OLD bends to either side are stale the instant it
    // drops; a provisional rebuild clears them immediately rather than
    // leaving a crossed/stale line up until the real re-plan lands.
    patch((cur) => ({ ...cur, waypoints: provisionalRebuild(seeds) }));
    void (async () => {
      // A drag never renames the point it moved — it already has a real
      // name (it was a stop before the drag), and re-deriving one from the
      // new spot is a separate, not-yet-asked-for feature.
      const waypoints = await commitRebuild(seeds);
      patch((cur) => ({ ...cur, waypoints }));
      // Flush ON drag-end: the followed route publishes its settled geometry to
      // the boat NOW (never a mid-drag frame); any other route persists debounced.
      if (followingDraft()) void persist();
      else scheduleSave();
    })();
  };

  const abortDrag = (id: string, at: GeoPoint) => {
    if (!inDrag) return;
    patch((r) => ({
      ...r,
      waypoints: r.waypoints.map((w) => (w.id === id ? { ...w, lat: at.lat, lon: at.lng } : w)),
    }));
    inDrag = false;
    setDraggingId(null);
    // No save/re-plan: the geometry is back to what is already persisted.
  };

  /** Reverse the DRAFT's whole From/Stop/To order — the return passage,
   * mid-edit ("Flip"). Geometry only: a route through the same points sailed
   * backwards is still a valid route, so this never re-plans. */
  const reverseDraft = () => {
    const r = draft();
    if (!r || r.waypoints.length < 2) return;
    setDraft(reverseWaypoints(r));
    scheduleSave();
  };

  /** Persist the draft; keep editing it at its new rev. A brand-new EMPTY route
   * never persists. Guards the draft update with the id so a concurrent leave
   * (which nulls the draft) can't reopen the sheet. */
  const persist = async (): Promise<string | null> => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    // Snapshot SYNCHRONOUSLY (before any await): `leave` nulls the draft on
    // the same tick and relies on this read landing first.
    const snap = draft();
    if (!snap || snap.waypoints.length === 0) return null;
    // Chained behind `saveChain` so an immediate-persist path never fires a
    // second `client.save` while a debounced one is in flight (#RT-ADDRACE).
    const run = saveChain.then(async () => {
      // Re-read: the live draft carries the rev the prior ack reseated AND any
      // geometry edited since. Falls back to `snap` if `leave` already nulled it.
      const live = draft();
      const r = live && live.id === snap.id ? live : snap;
      if (r.waypoints.length === 0) return null;
      try {
        const saved = await client.save(r);
        // Updates ONLY `rev`, never the draft geometry — an older echo could
        // drop edits made during the network window (#RT-ADDRACE). Guarded on
        // id so a concurrent `leave` can't reopen a closed editor.
        setDraft((cur) => (cur && cur.id === saved.id ? { ...cur, rev: saved.rev } : cur));
        return saved.id;
      } catch (e) {
        // A 409 is a cross-device conflict: last-writer-refresh (#RT-UNDO) —
        // pull the server's version and RESEAT the draft, scheduling NO
        // further save, so a repeat 409 is impossible without a new edit.
        if (e instanceof RouteSaveError && e.status === 409) {
          await client.refresh();
          const server = client.routes().find((x) => x.id === r.id);
          if (server) {
            setDraft((cur) => (cur && cur.id === server.id ? server : cur));
          }
          deps.notify?.({
            id: `route-conflict:${r.id}`,
            title: "Route changed on another device",
            detail: "Showing the latest saved version.",
          });
          return null;
        }
        // Transient error: warn the change is unsaved. No auto-retry loop (a
        // sustained outage would spin) — the next edit reschedules a save.
        console.error("route: save failed", e);
        deps.notify?.({
          id: `route-save-failed:${r.id}`,
          title: "Couldn’t save route",
          detail: "Your last change isn’t saved yet.",
        });
        return null;
      }
    });
    // The chain link never rejects (the callback swallows every error), so the
    // next `.then` always runs; track the untyped tail as the barrier.
    saveChain = run;
    return run;
  };

  /** The waypoint GO steers to: the one NEAREST the boat's fix — the
   * "closest next" waypoint, the natural place to pick up a route the boat is
   * already among, NOT the last one (which would steer the final leg from
   * wherever you are). With no fix, GO begins the route at its FIRST waypoint
   * (index 0). Invariant #8 still holds: this sets the INITIAL active target
   * and never auto-advances it afterward. `null` only for an empty draft. */
  const goTarget = (): string | null => {
    const r = draft();
    if (!r || r.waypoints.length === 0) return null;
    const self = signalk.self();
    const i = self ? nearestWaypointIndex({ lng: self.lng, lat: self.lat }, r.waypoints) : 0;
    return r.waypoints[i >= 0 ? i : 0].id;
  };

  /** GO: the draft is already auto-saved, so this just names the GO target as
   * the active leg — outright, invariant #8. It flushes any pending debounced
   * save first (a `persist` that cancels the timer), so the followed route is
   * never a frame stale. Leaves the mode so band.top takes the chart.
   *
   * `targetId`, when given, is the exact waypoint to make active (`startRoute`,
   * #RT-GONAV, passes it); omitted, the smart `goTarget` (nearest-or-first) is
   * used, which is the peek GO. */
  const go = async (targetId?: string) => {
    const wpId = targetId ?? goTarget();
    const id = await persist();
    if (!id || !wpId) return;
    try {
      await client.setActive({ route_id: id, waypoint_id: wpId });
      exit?.();
    } catch (e) {
      console.error("route: GO failed", e);
    }
  };

  /** "Start route" (#RT-GONAV item 2): begin following from the CLOSEST-NEXT join
   * point — the arrival waypoint of the leg the boat is nearest (`nearestLegTargetIndex`),
   * so the boat picks up the route beside the leg it is actually next to rather
   * than always leg 1. Ignores the selection outright. With no fix there is no
   * "nearest", so it starts at the FIRST waypoint. */
  const startRoute = async () => {
    const r = draft();
    if (!r || r.waypoints.length === 0) return;
    const self = signalk.self();
    const i = self ? nearestLegTargetIndex({ lng: self.lng, lat: self.lat }, r.waypoints) : 0;
    await go(r.waypoints[i >= 0 ? i : 0].id);
  };

  const stop = async () => {
    try {
      await client.setActive(null);
    } catch (e) {
      console.error("route: stop failed", e);
    }
  };

  // ── "Go here" — the pressed-point surface's hazard-avoiding route ──────────
  //
  // Not part of the editor mode: it needs no draft and no tap sequence, only the
  // boat's fix and one point. It reuses the SAME client save + setActive the
  // editor's GO does, so band.top lights up identically — the difference is
  // only that the route is PLANNED (a request to POST /api/routing/plan) rather
  // than dropped waypoint by waypoint or drawn as a bare straight line.
  const hasFix = () => !!signalk.self();

  const goTo = async (to: GeoPoint, label?: string): Promise<boolean> => {
    const self = signalk.self();
    if (!self) return false; // no fix → no route from an unknown start
    const from: GeoPoint = { lng: self.lng, lat: self.lat };

    // Ask the real hazard-avoiding search first; fall back to the plain
    // straight line only if the REQUEST ITSELF fails (network/server
    // error) — the router finding no safe path is a different, already-
    // handled outcome that still comes back as a valid `PlanResult` (a
    // straight line plus a reason), not a thrown error. See
    // `routeFromPlan`/`directRoute`'s own docs.
    let built: { route: Route; activeWaypointId: string };
    try {
      const plan = await planRoute(from, to, undefined, fetchImpl);
      built = routeFromPlan(
        plan.waypoints,
        { route: GO_HERE_ROUTE_ID, waypointIds: plan.waypoints.map(() => mintId()) },
        label,
        plan.approximateLegs,
      );
      setApproximateLegs(plan.approximateLegs);
      if (planIsUnreachable(plan)) {
        // The router couldn't verify at least one leg — it still drew a
        // line, bending around real danger as far as it honestly could
        // (see `approximateLegs`, which the overlay draws as a dashed
        // warning run wherever it falls), but the user must be told WHY
        // rather than sail on a silently-degraded route.
        deps.notify?.({
          id: "go-here-hazard",
          title: "Route may cross charted danger",
          detail: plan.warnings[0],
        });
      }
    } catch (e) {
      console.error("route: go-here planning failed, falling back to a straight line", e);
      built = directRoute(from, to, { route: GO_HERE_ROUTE_ID, from: mintId(), to: mintId() }, label);
      // A network/server failure, not the router finding part of the
      // request unreachable — a different failure mode (see the module
      // docstring), so no dashed-warning stub here, only the toast.
      setApproximateLegs([]);
      deps.notify?.({
        id: "go-here-plan-unreachable",
        title: "Couldn’t reach the router",
        detail: "Drew a straight line instead — verify manually before following.",
      });
    }

    return saveAndFollowGoHere(built);
  };

  /** Save `built` over the fixed go-here route and follow it — shared by the
   * autorouted `goTo` and the straight-line `goStraight`. */
  const saveAndFollowGoHere = async (built: { route: Route; activeWaypointId: string }): Promise<boolean> => {
    // Echo the go-here route's CURRENT rev as the If-Match to overwrite it in
    // place (see GO_HERE_ROUTE_ID); the first-ever tap has none, so rev 0 creates it.
    const existing = client.routes().find((r) => r.id === GO_HERE_ROUTE_ID);
    try {
      const saved = await client.save(existing ? { ...built.route, rev: existing.rev } : built.route);
      await client.setActive({ route_id: saved.id, waypoint_id: built.activeWaypointId });
      return true;
    } catch (e) {
      console.error("route: go-here failed", e);
      return false;
    }
  };

  /** "Go to" without the autorouter: a straight line from the boat, nothing
   * asked of `/routing/*`. Said so in the notice — no hazard check was made. */
  const goStraight = async (to: GeoPoint, label?: string): Promise<boolean> => {
    const self = signalk.self();
    if (!self) return false;
    const built = directRoute(
      { lng: self.lng, lat: self.lat },
      to,
      { route: GO_HERE_ROUTE_ID, from: mintId(), to: mintId() },
      label,
    );
    setApproximateLegs([]);
    const ok = await saveAndFollowGoHere(built);
    if (ok) {
      deps.notify?.({
        id: "route-follow",
        title: `Going to ${followName(built.route)}`,
        detail: "Straight line from the boat — not checked for hazards.",
      });
    } else {
      deps.notify?.({ id: "route-follow-failed", title: "Couldn’t start Go to" });
    }
    return ok;
  };

  const followCtl = createFollow({
    client,
    boat: () => {
      const self = signalk.self();
      return self ? { lng: self.lng, lat: self.lat } : null;
    },
    notify: deps.notify,
  });

  /** The staged From's display label — "Boat" (the default) unless a search
   * pick or "Choose on map" has staged a different start point. Only
   * meaningful before the draft has any stops — see `setStop`. */
  const fromLabel = (): string => pendingFrom()?.label ?? "Boat";
  /** The staged To's display label, or `null` while nothing is staged —
   * there is no default destination to fall back to the way From falls
   * back to the boat. */
  const toLabel = (): string | null => pendingTo()?.label ?? null;

  /** Stage a bare map-tap/coordinate point (no caller-given label) at `set`,
   * then fire the SAME "what's charted here" upgrade every fresh stop gets
   * (`nearestPlace`) — staging is the one path that doesn't otherwise go
   * through `commitRebuild` (nothing to re-plan yet; there may be no second
   * point at all). Fire-and-forget: if the staged point moves on before this
   * resolves, the stale write is discarded by the `cur.point === point`
   * identity check rather than clobbering whatever is there now. */
  const upgradeStagedName = (
    point: GeoPoint,
    set: (fn: (cur: Staged | null) => Staged | null) => void,
  ): void => {
    void nearestPlace(point, fetchImpl).then((resolved) => {
      if (!resolved) return;
      set((cur) => (cur && cur.point === point ? { ...cur, label: resolved.title } : cur));
    });
  };

  /** The STAGING half of setting From/To on an EMPTY draft — the shared
   * body `setFromPoint`/`setToPoint`/`setFromBoat`/`setToBoat` all delegate
   * to below, and what `setStop`'s empty-draft branch awaits DIRECTLY
   * (rather than also calling `trySeedFromStaged()` a second time itself)
   * so its own `Promise<boolean>` contract — resolved once the edit is
   * FULLY settled, same as every other `setStop` path — still holds. Each
   * returns `trySeedFromStaged()`'s own promise; its own doc covers when
   * that actually builds vs. stays merely staged. */
  const stageFrom = (point: GeoPoint, label?: string, isBoat = false): Promise<void> => {
    const namedByUser = !!label?.trim();
    setPendingFrom({ point, label: instantLabel(point, label), namedByUser, isBoat });
    if (!namedByUser) upgradeStagedName(point, setPendingFrom);
    return trySeedFromStaged();
  };
  const stageTo = (point: GeoPoint, label?: string, isBoat = false): Promise<void> => {
    const namedByUser = !!label?.trim();
    setPendingTo({ point, label: instantLabel(point, label), namedByUser, isBoat });
    if (!namedByUser) upgradeStagedName(point, setPendingTo);
    return trySeedFromStaged();
  };

  /** Reset the From slot to the boat: on a brand-new draft, resets the
   * staging (`pendingFrom`) back to the implicit default — which may itself
   * complete the route right away if a To is already staged and a fix
   * exists (`trySeedFromStaged`'s own boat fallback) — on a draft that
   * already has stops, this is a real edit — replace the live From stop
   * with the boat's CURRENT fix via `setStop`, same as picking any other
   * point for that slot. */
  const setFromBoat = () => {
    if (draftStops().length === 0) {
      setPendingFrom(null);
      void trySeedFromStaged();
      return;
    }
    const self = signalk.self();
    if (!self) {
      deps.notify?.({
        id: "route-plan-no-fix",
        title: "No boat position yet",
        detail: "Can't set the start to the boat without a GPS fix.",
      });
      return;
    }
    void setStop({ kind: "from" }, { lng: self.lng, lat: self.lat }, "Boat");
  };
  /** The symmetric "use boat" for the DESTINATION — the UI is expected to
   * only ever offer this while `hasFix()` (App.tsx's pinned search row), but
   * still resolves gracefully (notifies, no mutation) if it isn't. Unlike
   * From, To has no "implicit default" to reset TO — the boat is staged
   * explicitly here, same as any other destination pick. */
  const setToBoat = () => {
    const self = signalk.self();
    if (!self) {
      deps.notify?.({
        id: "route-plan-no-fix",
        title: "No boat position yet",
        detail: "Can't set the destination to the boat without a GPS fix.",
      });
      return;
    }
    const point = { lng: self.lng, lat: self.lat };
    if (draftStops().length === 0) {
      void stageTo(point, "Boat", true);
      return;
    }
    void setStop({ kind: "to" }, point, "Boat");
  };
  /** Stage or set a custom From point (a search pick or "Choose on map"
   * resolving against the From slot). On a brand-new draft this only STAGES
   * the point (`stageFrom`) — the route completes the moment a To is ALSO
   * known (staged here already, or arriving right after this); once the
   * draft has stops it is a real edit, delegated straight to `setStop`. */
  const setFromPoint = (point: GeoPoint, label?: string) => {
    if (draftStops().length === 0) {
      void stageFrom(point, label);
      return;
    }
    void setStop({ kind: "from" }, point, label);
  };
  /** The symmetric stage for To — see `setFromPoint`'s doc; the one real
   * difference is that staging To NEVER needs a boat fix up front (there is
   * no "no fix" rejection here at all): it just shows a pin (`previewTo`)
   * and `trySeedFromStaged` waits for a From to also become available,
   * whichever order that happens in. This is what lets a destination be
   * picked BEFORE a start point. */
  const setToPoint = (point: GeoPoint, label?: string) => {
    if (draftStops().length === 0) {
      void stageTo(point, label);
      return;
    }
    void setStop({ kind: "to" }, point, label);
  };

  /** The From/To PIN previews the map draws before a real route exists —
   * see `RouteOverlay`'s own doc on each. From falls back to the boat's
   * live position (the "defaults to the boat" behaviour); To never does. */
  const previewFrom = createMemo<{ point: GeoPoint; label: string } | null>(() => {
    if (draftStops().length > 0) return null;
    const staged = pendingFrom();
    if (staged) return { point: staged.point, label: staged.label };
    // The boat default is a pin only while a route is being made (the
    // editor's draft, or a staged To waiting on a From). Outside the editor
    // there is no draft, and an ungated fallback drew a waypoint ring on
    // the boat at all times — a second "where the boat is" that disagreed
    // with the own-ship icon.
    if (!draft() && !pendingTo()) return null;
    const self = signalk.self();
    return self ? { point: { lng: self.lng, lat: self.lat }, label: "Boat" } : null;
  });
  const previewTo = createMemo<{ point: GeoPoint; label: string } | null>(() => {
    if (draftStops().length > 0) return null;
    const staged = pendingTo();
    return staged ? { point: staged.point, label: staged.label } : null;
  });

  /** Arm "Choose on map" for `target` (default `{kind:"to"}`) — the next chart
   * tap resolves against that slot instead of being inert. */
  const beginPickOnMap = (target: MapPickTarget = { kind: "to" }) => setAwaitingMapPick(target);
  /** Back out of an armed "Choose on map" without picking anything. */
  const cancelPickOnMap = () => setAwaitingMapPick(null);

  // The plan-mode surface (RT-R2): thin wrappers over the editor operations
  // above, no parallel routing logic.

  /** The draft measured at rest at its planning speed. Empty with no draft or
   * fewer than two waypoints. */
  const plan = createMemo<RoutePlan>(() => {
    const r = draft();
    return r
      ? planRouteMetrics(r.waypoints, r.plan_speed_kn)
      : { legs: [], totalNm: 0, totalSec: 0 };
  });

  /** The one-line guidance the peek shows. */
  const editorHint = (): string => {
    const r = draft();
    if (!r) return "";
    if (r.waypoints.length === 0) return "Search or tap the chart to set your start and destination";
    return "Drag a pin to adjust it — the route re-plans around the new spot";
  };

  const followingDraft = () => following() && active()?.route_id === draft()?.id;

  // Planning speed and the name are NON-geometry edits: they auto-save
  // (debounced) like any edit.
  const setPlanSpeed = (kn: number) => {
    patch((r) => ({ ...r, plan_speed_kn: kn }));
    scheduleSave();
  };
  const renameDraft = (name: string) => {
    patch((r) => ({ ...r, name: name.slice(0, 64) }));
    scheduleSave();
  };

  /** Delete the whole route and leave: removed server-side if ever saved
   * (rev > 0), else just dropped. Cancels the pending save first so a queued
   * auto-save can't re-create the route just deleted. */
  const deleteDraftRoute = async () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const r = draft();
    if (r && r.rev > 0) await removeRoute(r);
    exit?.();
  };

  // ── Route management (the route-list surface) ──────────────────────────────
  //
  // The store already holds every saved route; these are the open/delete/
  // reverse the list needs, reusing the SAME client the editor does. No parallel
  // routing implementation — a list action is one client call plus, for open,
  // seeding the editor.

  /** Seed the draft when the mode opens: the list's pending route if one was
   * asked for, else — unless a BLANK start was requested — the followed route
   * (continue it), else a fresh empty one. Always a COPY. Resets the
   * per-session editor state and cancels any leftover pending save. The
   * `pendingBlank` one-shot forces the fresh-empty path even while following,
   * so `newRoute` gets a blank draft the follow can't hijack. */
  const seedDraft = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const opened = pendingOpen();
    const blank = pendingBlank();
    setPendingOpen(null);
    setPendingBlank(false);
    const r = blank ? null : (opened ?? activeRoute());
    setDraft(r ? { ...r, waypoints: [...r.waypoints] } : newRoute(mintId));
    setAwaitingMapPick(null);
    setPendingFrom(null);
    setPendingTo(null);
  };

  const editRoute = (route: Route) => {
    setPendingOpen({ ...route, waypoints: [...route.waypoints] });
    // Already editing → re-seed in place (entering an active mode is a no-op).
    // Otherwise ask App to enter the mode, whose `enter` seeds from the pending.
    if (draft()) seedDraft();
    else enterEditor?.();
  };

  /** Start a BLANK new route ("New route"), ignoring `activeRoute()`: arms the
   * one-shot `pendingBlank` so `seedDraft` skips its default seed-from-followed.
   * `client.setActive` is never called, so the followed route keeps autopilot. */
  const newRouteAction = () => {
    if (draft() && saveTimer !== undefined) void persist();
    setPendingOpen(null);
    setPendingBlank(true);
    if (draft()) seedDraft();
    else enterEditor?.();
  };

  const removeRoute = async (route: Route) => {
    try {
      await client.remove(route.id, route.rev);
    } catch (e) {
      console.error("route: delete failed", e);
    }
  };

  /** "Open it in the editor" as a notice action, when there is one. */
  const editAction = (r: Route): Notice["action"] =>
    deps.editPoints ? { label: "Edit", run: () => deps.editPoints!(r) } : undefined;

  const reverseRoute = async (route: Route): Promise<Route | null> => {
    try {
      const saved = await client.save(reversedCopy(route, mintId));
      deps.notify?.({
        id: "route-reversed",
        title: "Reversed copy saved",
        detail: saved.name,
        action: editAction(saved),
      });
      return saved;
    } catch (e) {
      console.error("route: reverse failed", e);
      deps.notify?.({ id: "route-reversed", title: "Couldn’t save the reversed route" });
      return null;
    }
  };

  const importGpxAction = async (text: string, fileName?: string): Promise<Route[]> => {
    const parsed = importGpx(text, { fileName, mintId, parse: deps.parseXml });
    if (!parsed.ok) {
      deps.notify?.({ id: "route-import", title: "GPX import failed", detail: parsed.error });
      return [];
    }
    const saved: Route[] = [];
    const failed: string[] = [];
    // One at a time: the store serialises writes anyway, and a refusal (the
    // 200-route cap, say) then names the route it hit.
    for (const r of parsed.routes) {
      try {
        saved.push(await client.save(r));
      } catch (e) {
        console.error("route: import save failed", e);
        failed.push(`“${r.name}”: ${e instanceof Error ? e.message : "not saved"}`);
      }
    }
    const summary = importSummary({ ...parsed, routes: saved, skipped: [...parsed.skipped, ...failed] });
    const why = [...parsed.skipped, ...failed];
    deps.notify?.({
      id: "route-import",
      title: saved.length > 0 ? `Imported ${saved.length === 1 ? "1 route" : `${saved.length} routes`}` : "Nothing imported",
      detail: [summary, ...why.slice(0, 3), ...(why.length > 3 ? [`…and ${why.length - 3} more`] : []), ...parsed.notes.slice(0, 2)].join(" — "),
      action: saved.length === 1 ? editAction(saved[0]!) : undefined,
    });
    return saved;
  };

  const shownRoute = createMemo<Route | null>(() => {
    const d = draft();
    if (d) return d;
    const a = activeRoute();
    return a && a.id === deps.hiddenRouteId?.() ? null : a;
  });

  // Gate the raw `approximateLegs` signal on the CURRENTLY SHOWN route
  // actually being the go-here one — otherwise a stale flag from an
  // earlier "Go here" tap would bleed onto whatever route/draft the user
  // opens next. Computed here, not in `overlay.ts`, specifically so that
  // file never needs to import `GO_HERE_ROUTE_ID` (a VALUE import from
  // `./index` back into `./overlay` would reopen the exact runtime
  // import cycle `./layers` was carved out to avoid — see this file's
  // own header comment on `ROUTE_LINE_LAYER`).
  const gatedApproximateLegs = (): boolean[] =>
    shownRoute()?.id === GO_HERE_ROUTE_ID ? approximateLegs() : [];

  // ── The mode: a tap resolves an armed "choose on map" pick, or is inert ────
  const mode: Mode = {
    id: "route-edit",
    label: "Route",
    // SOLO: the shell suppresses helm widgets and the ModePill — the plan sheet
    // (RouteSheet.tsx) is this mode's whole UI.
    solo: true,
    // The editor IS the auto-router: no tool button with "Beta autorouting" off.
    hidden: () => !betaAutorouting(),
    enter: seedDraft,
    // No `requestLeave`: nothing to veto — every edit auto-saved already.
    leave: () => {
      // Flush the last edit before dropping the draft, in case of a close
      // inside the debounce window; `persist`'s id-guard stops it reopening.
      if (saveTimer !== undefined) void persist();
      inDrag = false;
      setDraft(null);
      setDraggingId(null);
      setAwaitingMapPick(null);
      setPendingFrom(null);
      setPendingTo(null);
    },
    // A tap does exactly one route-related thing: resolve an armed "choose on
    // map" pick (`beginPickOnMap`/the From/Stop/To row that armed it), wherever
    // on the chart it lands. Not armed — the ordinary case — a tap is INERT
    // (returns `false`, so the info panel/other handlers still see it): the
    // redesign's whole point is that the chart is not where a route gets
    // edited freehand any more; dragging an existing stop's own handle is a
    // SEPARATE gesture (`overlay.ts`'s `attachRouteDragging`), not a click.
    onClick: (click) => {
      if (!draft()) return false;
      const pick = awaitingMapPick();
      if (!pick) return false;
      setAwaitingMapPick(null);
      const p: GeoPoint = { lng: click.lngLat.lng, lat: click.lngLat.lat };
      if (pick.kind === "insert") void insertStop(pick.beforeId, p);
      else void setStop(pick, p);
      return true;
    },
  };

  // The band.top instruments (the followed strip): present only while
  // following. Home band is `top` only — a next-waypoint bearing has no
  // meaning on the rail when nothing is being followed.
  const topInstrument = (
    id: string,
    short: string,
    label: string,
    read: Instrument["read"],
    extra?: Partial<Instrument>,
  ): Instrument => ({
    id,
    short,
    label,
    band: "top",
    bands: ["top"],
    maxUrgency: "none",
    when: following,
    read,
    ...extra,
  });

  // One app-layer `defineFeature` folds the editor MODE, band.top instruments,
  // chart OVERLAY and `Edit route` COMMAND into a single `AppFeature` (the
  // POI/weather shape). The overlay is attached below, once `model` exists.
  const feature = defineFeature({
    id: "routes",
    // Closes over `model` (built below) so the in-editor Undo/GO commands
    // drive the SAME `undo`/`saveAndFollow` the sheet does.
    commands: (deps) => routeCommands(deps, model),
    modes: [mode],
    // The board's "Route" tab: every member is `when: following`, so it shows
    // passage data under way and is empty otherwise.
    dashboard: [
      {
        id: "route",
        label: "Route",
        instruments: [
          "route.wpt",
          "route.brg",
          "route.dtw",
          "route.dtg",
          "route.xte",
          "route.eta",
          "route.ttg",
          "route.ttd",
        ],
      },
    ],
    instruments: [
      topInstrument("route.wpt", "WPT", "Next waypoint", (ctx) => {
        const l = leg();
        if (!l) return { value: "– –", state: "null" };
        // At helm, the leg number (glove-legible in one glance); at desk, the
        // waypoint's name if it has one, else its number.
        const num = `${l.index + 1}`;
        const name = l.to.name.trim();
        return isHelmish(ctx.density)
          ? { value: `→${num}`, sub: activeRoute()?.name || undefined }
          : { value: name || `WP ${num}`, sub: activeRoute()?.name || undefined };
      }),
      // BTW, not BRG: the cursor readout already owns "BRG", and both can be on
      // screen at desk density — one short string each, kept distinct.
      topInstrument("route.brg", "BTW", "Bearing to waypoint", () => {
        const m = metrics();
        return m
          ? { value: padDeg(m.brgDeg), unit: "°T" }
          : { value: "– – –", unit: "°T", state: "null" };
      }),
      topInstrument("route.dtw", "DTW", "Distance to waypoint", () => {
        const m = metrics();
        if (!m) return { value: "– –", unit: "nm", state: "null" };
        const r = formatRange(m.dtwNm);
        return { value: r.value, unit: r.unit };
      }),
      // DTG sums every leg still ahead; `maxUrgency: "none"` — distance still
      // to run is never an alarm, so no invariant-#2 clamp is needed here.
      topInstrument("route.dtg", "DTG", "Distance to destination", () => {
        const m = metrics();
        if (!m) return { value: "– –", unit: "nm", state: "null" };
        const r = formatRange(m.dtgNm);
        return { value: r.value, unit: r.unit };
      }),
      topInstrument("route.eta", "ETA", "Arrival time at destination", () => {
        const m = metrics();
        if (!m) return { value: "– –:– –", state: "null" };
        return { value: formatClock(m.ttgDestSec) };
      }),
      topInstrument(
        "route.xte",
        "XTE",
        "Cross-track error",
        () => {
          const m = metrics();
          if (!m || !m.xte) return { value: "– –", unit: "nm", state: "null" };
          const r = formatRange(m.xte.nm);
          return { value: r.value, unit: r.unit, sub: m.xte.side === "L" ? "steer R" : "steer L" };
        },
        {
          // Invariant #2, kept live: XTE asks `alarm` past 0.1 nm off track, but
          // the kernel clamps it to `notice` — drifting off a route isn't a depth alarm.
          maxUrgency: "notice",
          urgency: () => {
            const m = metrics();
            return m?.xte && m.xte.nm > 0.1 ? "alarm" : "none";
          },
        },
      ),
      // The time pair mirroring DTW/DTG: TTW the leg, TTD the whole passage.
      topInstrument("route.ttg", "TTW", "Time to waypoint", () => {
        const m = metrics();
        if (!m) return { value: "– –", state: "null" };
        return { value: formatDuration(m.ttgSec) };
      }),
      topInstrument("route.ttd", "TTD", "Time to destination", () => {
        const m = metrics();
        if (!m) return { value: "– –", state: "null" };
        return { value: formatDuration(m.ttgDestSec) };
      }),
    ],
  });

  const model: RoutesModel = {
    route: shownRoute,
    editing: () => !!draft(),
    activeWaypoint,
    steerLine,
    activeMode,
    targetLine,
    flashLeg,
    approximateLegs: gatedApproximateLegs,
    moveWaypoint,
    beginWaypointDrag,
    endWaypointDrag,
    abortDrag,
    previewFrom,
    previewTo,
    following,
    hasFix,
    goTo,
    goStraight,
    follow: followCtl.follow,
    followLeg: followCtl.leg,
    skipWaypoint: followCtl.skip,
    startAt: followCtl.startAt,
    routes: client.routes,
    activeRouteId: () => active()?.route_id ?? null,
    editRoute,
    newRoute: newRouteAction,
    removeRoute,
    reverseRoute,
    importGpx: importGpxAction,
    // ── The plan-mode surface (RT-R2) ──
    draft,
    plan,
    editorHint,
    followingDraft,
    setPlanSpeed,
    renameDraft,
    reverseDraft,
    saveAndFollow: go,
    startRoute,
    openManager: () => {
      // Leave the editor first (auto-saved; frees the desktop dock the manager
      // also docks into) — picking a route there re-enters via `editRoute`.
      exit?.();
      openManagerFn?.();
    },
    bindOpenManager: (fn) => (openManagerFn = fn),
    draftStops,
    planning,
    setStop,
    insertStop,
    removeStop,
    reorderStops,
    pickingOnMap: awaitingMapPick,
    beginPickOnMap,
    cancelPickOnMap,
    openSearchForSlot: (target) => openSearchForSlotFn?.(target),
    bindOpenSearchForSlot: (fn) => (openSearchForSlotFn = fn),
    fromLabel,
    setFromBoat,
    setFromPoint,
    toLabel,
    setToBoat,
    setToPoint,
    stopFollowing: stop,
    deleteDraftRoute,
    flashLegAt,
    exitEditor: () => exit?.(),
    bindExit: (fn) => (exit = fn),
    bindEnter: (fn) => (enterEditor = fn),
  };

  // The overlay closes over `model`, so it's attached now that model exists.
  // `ensure` also forwards the live map into `routeMap`, the shared signal the
  // info provider hit-tests the route line through.
  const [routeMap, setRouteMap] = createSignal<MLMap>();
  feature.overlay = createRouteOverlay(model, setRouteMap);

  // The tap-for-info provider (#RT-INFO): surfaces the DRAWN route as a card,
  // reusing the feature's own live `following`/`metrics`.
  feature.provider = createRouteProvider({
    map: () => routeMap() as QueryableMap | undefined,
    route: shownRoute,
    editing: () => !!draft(),
    following,
    metrics: () => metrics(),
    editRoute,
    activeRouteId: () => active()?.route_id ?? null,
    stopFollowing: () => void stop(),
    activeWaypointId: activeWaypoint,
    follow: (r) => void followCtl.follow(r, { confirmed: true }),
    skipWaypoint: (d) => void followCtl.skip(d),
    startAt: (routeId, wpId) => void followCtl.startAt(routeId, wpId),
    editPoints: deps.editPoints,
    exportGpx: downloadGpx,
    showLegs: deps.showLegs,
  });

  return { feature, model };
}
