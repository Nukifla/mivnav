// THE ROUTES FEATURE: the route store's live view, following, the band.top
// instruments, the route overlay and info card, the straight-line "Go to",
// and the pure tap-onto-leg geometry — maplibre-free. See
// docs/architecture/route-model.md for the three-way split and why.
//
// The auto-routing editor (From/Stop/To, `route-edit`) and the auto-routed
// "Go here" are the `autorouting` plugin's: it attaches to this feature as
// the overlay's edit session (`attachEditor`) and registers itself as the
// route planner (core/routePlanner.ts). Without it, routes are made in the
// manual editor (features/routeDraw) and "Go to" is a straight line.

import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import type { QueryableMap } from "../../core/info/queryGuard";
import { createRouteProvider } from "./provider";
import { knotsFromMs, wrapLonDeltaDeg } from "../../core/cpa";
import {
  DEFAULT_PLAN_SPEED_KN,
  type Route,
  type RoutesClient,
  type SteerMode,
  type Waypoint,
} from "../../core/routes";
import type { Notice } from "../../core/chrome/notices";
import type { SignalKState } from "../../core/signalk";
import { bearingDeg, type GeoPoint, rangeNm } from "../../core/chrome/geo";
import { formatDuration, formatRange, padDeg } from "../../core/format";
import { formatWhen } from "../legTable/table";
import { isHelmish, type Instrument } from "../../core/chrome/registry";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { createRouteOverlay } from "./overlay";
import { routeCommands } from "./commands";
import { routePlanner } from "../../core/routePlanner";
import { downloadGpx } from "./download";
import { clampName, importGpx, importSummary, type XmlParse } from "./gpx";
import { createFollow, followName, type FollowLeg, type FollowResult } from "./follow";

// Re-exported from the leaf ./layers (TDZ cycle); keeps the "./index" surface.
export { ROUTE_LINE_LAYER, ROUTE_WAYPOINTS_LAYER } from "./layers";

const DEG_TO_RAD = Math.PI / 180;
const NM_PER_DEG = 60;

/** Wall-clock ETA `seconds` from `nowMs`, with the day when it isn't today
 * (`14:05`, `Sat 09:30`, `12 Nov 09:30`) — the leg table's `formatWhen`. */
export function formatEta(seconds: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "– –:– –";
  return formatWhen(nowMs + seconds * 1000, nowMs);
}

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
 * The straight-line "Go to" (`goStraight`), and the autorouting plugin's
 * fallback for when its planning request fails outright.
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

/** How close to a waypoint counts as "at" it, for the frontend's own
 * judgements (follow's start target, "Route complete"). SignalK owns the real
 * arrival circle and does not tell us; 0.05 nm (~90 m) is the common plotter
 * default (OpenCPN's), a boat length or two of GPS noise around a mark. */
export const ARRIVAL_RADIUS_NM = 0.05;

/** "Start route"'s target (#RT-GONAV): the ARRIVAL waypoint of the leg the
 * boat is nearest, not `nearestWaypointIndex` — beside the middle of leg 3→4
 * the nearest waypoint can be 3, BEHIND the boat, running the leg backwards.
 * The exception is the start: a boat short of point 1 (nearest leg is leg 0,
 * projecting before its start, and farther than `ARRIVAL_RADIUS_NM` from it —
 * in the marina, a route starting at the harbour entrance) targets point 1,
 * not point 2, so it does not cut the corner. Sitting on point 1 → point 2. */
export function nearestLegTargetIndex(boat: GeoPoint, waypoints: readonly Waypoint[]): number {
  if (waypoints.length === 0) return -1;
  if (waypoints.length < 2) return 0;
  const pts = waypoints.map(wpPoint);
  const ins = nearestInsertion(pts, boat);
  if (!ins) return 0;
  if (ins.segment === 0 && ins.distNm > ARRIVAL_RADIUS_NM && projectOntoLeg(boat, pts[0], pts[1]).t <= 0) return 0;
  return ins.index;
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
  /** The boat's last known distance to the active waypoint, nm — the
   * evidence a final-leg end was an ARRIVAL. Absent/null: no fix seen. */
  dtwNm?: number | null;
}

/** How near the last waypoint the boat's last seen fix must be for a
 * final-leg end to read as "Route complete". Wider than `ARRIVAL_RADIUS_NM`:
 * SignalK's own arrival circle (which ends the leg) is set server-side and may
 * be larger, and the fix we last saw lags the poll that saw the leg end. */
export const COMPLETE_RADIUS_NM = 0.25;

export type ArrivalEvent =
  /** The boat reached a waypoint: the active leg advanced one step forward,
   * and `reachedIndex` is the waypoint it just arrived at (the OLD active). */
  | { kind: "reached"; reachedIndex: number }
  /** The whole route is done: following ended from the final waypoint. */
  | { kind: "complete" }
  | null;

/** Classify the change in the followed leg: only a +1 step on the SAME route
 * is an arrival; `atLast → null` is completion only with evidence — the boat
 * was last seen within `COMPLETE_RADIUS_NM` of the last waypoint, and this
 * screen did not itself stop following / delete the route (`userEnded`). A
 * Stop or delete on the final leg is not an arrival. */
export function arrivalEvent(
  prev: LegPos | null,
  next: LegPos | null,
  opts: { userEnded?: boolean } = {},
): ArrivalEvent {
  // Following ended. A completion is an arrival AT the last waypoint; a Stop
  // from the middle is not, and neither is a bare GO that never began.
  if (prev && !next) {
    const atLast = prev.index === prev.count - 1;
    const near = prev.dtwNm != null && prev.dtwNm <= COMPLETE_RADIUS_NM;
    return atLast && near && !opts.userEnded ? { kind: "complete" } : null;
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

/** What a route EDITOR lends the overlay while it is open — the autorouting
 * plugin's From/Stop/To editor (`RoutesModel.attachEditor`). Its draft is
 * drawn instead of the followed route, with the stops as drag handles; the
 * drag verbs are its own (it re-plans the legs on drop). */
export interface RouteEditSession {
  /** The route being edited, or null while the editor is closed. */
  draft: Accessor<Route | null>;
  previewFrom: RouteOverlay["previewFrom"];
  previewTo: RouteOverlay["previewTo"];
  flashLeg: RouteOverlay["flashLeg"];
  moveWaypoint: RouteOverlay["moveWaypoint"];
  beginWaypointDrag: RouteOverlay["beginWaypointDrag"];
  endWaypointDrag: RouteOverlay["endWaypointDrag"];
  abortDrag: RouteOverlay["abortDrag"];
}

export interface RoutesModel extends RouteOverlay {
  /** Whether a leg is being followed — drives band.top's liveness. */
  following: Accessor<boolean>;
  /** Is there a boat position to route FROM? Gates "Go here"/"Go to". */
  hasFix: Accessor<boolean>;
  /** "Go to" without a route planner: the fixed `go-here` route as a plain
   * STRAIGHT line boat → `to` (`directRoute`) — no router call, no hazard
   * check — saved and followed. `false`, building nothing, with no fix. */
  goStraight(to: GeoPoint, label?: string): Promise<boolean>;
  /** Save `built` over the fixed go-here route (`GO_HERE_ROUTE_ID`) and
   * follow it from `activeWaypointId` — `goStraight`'s second half, and
   * the planner's auto-routed "Go here". `false` if the save/follow fails. */
  followGoHere(built: { route: Route; activeWaypointId: string }): Promise<boolean>;
  /** Follow a saved route from the nearest leg ahead (`./follow.ts`). Another
   * route followed and not `confirmed` → asks "Switch to …?" through a
   * notice; the same route again → a no-op. */
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
  /** Delete a saved route. Deleting the followed one stops the follow too. */
  removeRoute(route: Route): Promise<void>;
  /** Save the return passage as a NEW route (`reversedCopy`), leaving the
   * original — and any follow of it — untouched. Notifies, offering to open
   * the copy in the manual editor. Resolves to the saved copy, or null. */
  reverseRoute(route: Route): Promise<Route | null>;
  /** Import a GPX file's routes (and tracks, simplified) as new routes
   * (`./gpx.ts`), then notify what happened. Resolves to the routes saved. */
  importGpx(text: string, fileName?: string): Promise<Route[]>;
  /** Stop following (without deleting). */
  stopFollowing(): Promise<void>;
  /** Draw a saved route on the chart without following it (null hides it) —
   * the route just finished in the editor, or one picked from the list.
   * `fit` frames it. The followed route, while there is one, wins. */
  showRoute(route: Route | null, opts?: { fit?: boolean }): void;
  /** The route `showRoute` put up, or null. */
  viewedRouteId: Accessor<string | null>;
  /** Draw `session`'s draft instead of the followed route while it has one
   * (the autorouting plugin's editor). One at a time; returns the detach. */
  attachEditor(session: RouteEditSession): () => void;
}

/** A transient arrival notice, ready for the notice strip. */
export interface ArrivalNotice {
  id: string;
  title: string;
  detail?: string;
}

/** The routes feature: the band.top instruments, the follow commands, the
 * overlay and info card, and the model they read. A factory over its
 * dependencies. */
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

  // The attached editor (the autorouting plugin), or null. Its draft, while
  // it has one, is what the overlay draws and drags.
  const [session, setSession] = createSignal<RouteEditSession | null>(null);
  const draft = (): Route | null => session()?.draft() ?? null;
  const attachEditor = (s: RouteEditSession): (() => void) => {
    setSession(() => s);
    return () => {
      if (session() === s) setSession(null);
    };
  };


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

  /** Set while THIS screen is ending following (Stop, or deleting the
   * followed route): the leg's end that follows is not a "Route complete". */
  let userEnded = false;
  const errText = (e: unknown): string | undefined => (e instanceof Error ? e.message : undefined);

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
    // The boat's last seen distance to the target, kept per leg so the moment
    // the leg ends (and `metrics()` goes null) still knows how close it was.
    let lastDtw: { routeId: string; index: number; nm: number } | null = null;
    createEffect(() => {
      const m = metrics();
      const l = leg();
      if (m && l) lastDtw = { routeId: l.route.id, index: l.index, nm: m.dtwNm };
    });
    let prev: LegSnapshot | null = null;
    createEffect(() => {
      const cur = snapshot();
      const d = lastDtw;
      const prevPos =
        prev && { ...prev, dtwNm: d && d.routeId === prev.routeId && d.index === prev.index ? d.nm : null };
      const ev = arrivalEvent(prevPos, cur, { userEnded: !cur && userEnded });
      if (!cur) userEnded = false;
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

  const stop = async () => {
    userEnded = true;
    try {
      await client.setActive(null);
    } catch (e) {
      userEnded = false;
      console.error("route: stop failed", e);
      deps.notify?.({ id: "route-stop-failed", title: "Couldn’t stop following", detail: errText(e) });
    }
  };

  const hasFix = () => !!signalk.self();

  /** Save `built` over the fixed go-here route and follow it — `goStraight`'s
   * and the route planner's auto-routed "Go here". */
  const followGoHere = async (built: { route: Route; activeWaypointId: string }): Promise<boolean> => {
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
    const ok = await followGoHere(built);
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

  const removeRoute = async (route: Route) => {
    // Deleting the followed route ends following — the user's doing, not an arrival.
    const wasActive = active()?.route_id === route.id;
    if (wasActive) userEnded = true;
    try {
      await client.remove(route.id, route.rev);
    } catch (e) {
      if (wasActive) userEnded = false;
      console.error("route: delete failed", e);
      deps.notify?.({
        id: "route-delete-failed",
        title: `Couldn’t delete ${followName(route)}`,
        detail: errText(e),
      });
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

  // A saved route drawn without being followed (`showRoute`). By id, so a
  // rename/edit shows the latest copy and a delete simply drops it.
  const [viewedId, setViewedId] = createSignal<string | null>(null);
  const viewedRoute = createMemo<Route | null>(() => {
    const id = viewedId();
    return id ? (client.routes().find((r) => r.id === id) ?? null) : null;
  });
  // Starting a follow replaces the viewed route — stopping later must not
  // resurrect a stale one.
  createEffect(() => {
    if (active()) setViewedId(null);
  });

  const shownRoute = createMemo<Route | null>(() => {
    const d = draft();
    if (d) return d;
    const hidden = deps.hiddenRouteId?.();
    const a = activeRoute();
    if (a) return a.id === hidden ? null : a;
    const v = viewedRoute();
    return v && v.id !== hidden ? v : null;
  });

  const [routeMap, setRouteMap] = createSignal<MLMap>();
  const showRoute = (route: Route | null, opts?: { fit?: boolean }) => {
    setViewedId(route?.id ?? null);
    if (!route || !opts?.fit || route.waypoints.length === 0) return;
    const map = routeMap();
    if (!map || typeof map.fitBounds !== "function") return;
    const lats = route.waypoints.map((w) => w.lat);
    // Longitudes unwrapped against the first point, so a route over the
    // antimeridian frames the short way round.
    const lon0 = route.waypoints[0]!.lon;
    const lons = route.waypoints.map((w) => lon0 + wrapLonDeltaDeg(w.lon - lon0));
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 80, maxZoom: 14, duration: 600 },
    );
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

  // One app-layer `defineFeature` folds the band.top instruments, chart
  // OVERLAY and the follow COMMANDS into a single `AppFeature` (the
  // POI/weather shape). The overlay is attached below, once `model` exists.
  const feature = defineFeature({
    id: "routes",
    // Closes over `model` (built below).
    commands: (deps) => routeCommands(deps, model),
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
        // `14:05` today, `Sat 09:30` on another day: a 30 h passage must not
        // read as arriving today.
        return { value: formatEta(m.ttgDestSec) };
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

  const noop = () => {};
  const model: RoutesModel = {
    route: shownRoute,
    editing: () => !!draft(),
    activeWaypoint,
    steerLine,
    activeMode,
    targetLine,
    // The edit session's, while one is attached; inert otherwise (no editor,
    // nothing to flash, preview or drag).
    flashLeg: () => session()?.flashLeg() ?? null,
    moveWaypoint: (id, at) => session()?.moveWaypoint(id, at),
    beginWaypointDrag: (id) => session()?.beginWaypointDrag(id),
    endWaypointDrag: () => (session()?.endWaypointDrag ?? noop)(),
    abortDrag: (id, at) => session()?.abortDrag(id, at),
    previewFrom: () => session()?.previewFrom() ?? null,
    previewTo: () => session()?.previewTo() ?? null,
    following,
    hasFix,
    goStraight,
    followGoHere,
    follow: followCtl.follow,
    followLeg: followCtl.leg,
    skipWaypoint: followCtl.skip,
    startAt: followCtl.startAt,
    routes: client.routes,
    activeRouteId: () => active()?.route_id ?? null,
    removeRoute,
    reverseRoute,
    importGpx: importGpxAction,
    stopFollowing: stop,
    showRoute,
    viewedRouteId: () => viewedRoute()?.id ?? null,
    attachEditor,
  };

  // The overlay closes over `model`, so it's attached now that model exists.
  // `ensure` also forwards the live map into `routeMap`, the shared signal the
  // info provider hit-tests the route line through.
  feature.overlay = createRouteOverlay(model, setRouteMap);

  // The tap-for-info provider (#RT-INFO): surfaces the DRAWN route as a card,
  // reusing the feature's own live `following`/`metrics`.
  feature.provider = createRouteProvider({
    map: () => routeMap() as QueryableMap | undefined,
    route: shownRoute,
    editing: () => !!draft(),
    following,
    metrics: () => metrics(),
    planner: routePlanner,
    activeRouteId: () => active()?.route_id ?? null,
    stopFollowing: () => void stop(),
    activeWaypointId: activeWaypoint,
    follow: (r) => void followCtl.follow(r, { confirmed: true }),
    skipWaypoint: (d) => void followCtl.skip(d),
    startAt: (routeId, wpId) => void followCtl.startAt(routeId, wpId),
    editPoints: deps.editPoints,
    exportGpx: downloadGpx,
    showLegs: deps.showLegs,
    viewedRouteId: () => viewedRoute()?.id ?? null,
    hideRoute: () => setViewedId(null),
  });

  return { feature, model };
}
