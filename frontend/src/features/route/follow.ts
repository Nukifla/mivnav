// FOLLOWING A ROUTE, planner-independent: start following a saved route, skip to
// the next/previous waypoint, restart at a chosen waypoint. No autorouting and
// no hazard checks — every action here is one `PUT /routes/active` naming a
// waypoint (invariant #8); the backend publishes it to SignalK and its
// NavWatcher keeps auto-advancing on arrival exactly as for any other GO.
//
// Pure helpers first (`followStartIndex`, `skipTarget`), then the controller
// `createFollow` that `./index.ts` folds into the routes model.

import type { Accessor } from "solid-js";
import type { Notice } from "../../core/chrome/notices";
import type { GeoPoint } from "../../core/chrome/geo";
import type { Route, RoutesClient } from "../../core/routes";
import { nearestLegTargetIndex } from "./index";

/** A route's display name — the same fallback the route list uses. */
export const followName = (r: Route): string => r.name.trim() || "Untitled route";

/** A waypoint's display name: its own, else "WP n" (1-based), like band.top. */
const wpLabel = (r: Route, i: number): string => r.waypoints[i]?.name.trim() || `WP ${i + 1}`;

/**
 * Which waypoint "Follow" makes the active target.
 *
 * - With a fix: the arrival waypoint of the leg the boat is nearest
 *   (`nearestLegTargetIndex`, the autorouting editor's "Start route" rule) — beside
 *   the middle of leg 3→4 that is 4, never 3 behind the boat.
 * - With NO fix: index 1 — the first LEG (point 1 → point 2), not point 1
 *   itself. A route's first point is conventionally where it departs from;
 *   targeting it would make the opening "leg" a bearing-only steer to the
 *   start (no track, no XTE), and with the boat sitting at the start the
 *   watcher would advance straight past it anyway. Leg 1 gives a real track
 *   (XTE) from the start. A boat that is genuinely elsewhere can press
 *   "Previous waypoint" to steer to point 1 first.
 * - A one-point route has only that point: 0. Empty: -1.
 */
export function followStartIndex(boat: GeoPoint | null, waypoints: Route["waypoints"]): number {
  if (waypoints.length === 0) return -1;
  if (waypoints.length === 1) return 0;
  if (!boat) return 1;
  const i = nearestLegTargetIndex(boat, waypoints);
  return i >= 0 ? i : 1;
}

/** The index `delta` waypoints from `index` on a route of `count` points, or
 * null when that steps off either end (no wrap: past the last point there is
 * nothing to follow, before the first there is nothing to go back to). */
export function skipTarget(index: number, count: number, delta: number): number | null {
  const j = index + delta;
  return index >= 0 && j >= 0 && j < count ? j : null;
}

/** The followed leg as positions on its route — what the controls need. */
export interface FollowLeg {
  route: Route;
  /** Index of the active (target) waypoint. */
  index: number;
}

export type FollowResult = "started" | "already" | "asked" | "failed";

export interface FollowControls {
  /** The followed route and target index, or null. */
  leg: Accessor<FollowLeg | null>;
  /**
   * Start following `route` (`followStartIndex`). Following it already →
   * `"already"`, nothing sent (the target is NOT moved). Another route
   * followed and not `confirmed` → a non-modal "Switch to <name>?" notice
   * whose action re-runs this confirmed → `"asked"`. Surfaces with their own
   * inline confirm (the route card, the route list) pass `confirmed`.
   */
  follow(route: Route, opts?: { confirmed?: boolean }): Promise<FollowResult>;
  /** Make waypoint `waypointId` of `routeId` the active target — "Start
   * here" on a point of the followed route. */
  startAt(routeId: string, waypointId: string): Promise<boolean>;
  /** Next (+1) / previous (-1) waypoint of the followed route. Re-reads the
   * store first, so a NavWatcher auto-advance a moment ago is the base. */
  skip(delta: 1 | -1): Promise<boolean>;
}

export function createFollow(deps: {
  client: RoutesClient;
  /** The boat's fix, or null. */
  boat: () => GeoPoint | null;
  notify?: (n: Notice) => void;
}): FollowControls {
  const { client } = deps;
  const notify = (n: Notice) => deps.notify?.(n);

  const legOf = (): FollowLeg | null => {
    const a = client.active();
    if (!a) return null;
    const route = client.routes().find((r) => r.id === a.route_id);
    if (!route) return null;
    const index = route.waypoints.findIndex((w) => w.id === a.waypoint_id);
    return index < 0 ? null : { route, index };
  };

  const activate = async (route: Route, index: number, title: string): Promise<boolean> => {
    const wp = route.waypoints[index];
    if (!wp) return false;
    try {
      await client.setActive({ route_id: route.id, waypoint_id: wp.id });
      notify({
        id: "route-follow",
        title,
        detail: `To ${wpLabel(route, index)} (${index + 1} of ${route.waypoints.length})`,
      });
      return true;
    } catch (e) {
      console.error("route: follow failed", e);
      notify({ id: "route-follow-failed", title: "Couldn’t change the followed route", detail: String(e) });
      return false;
    }
  };

  const follow = async (route: Route, opts: { confirmed?: boolean } = {}): Promise<FollowResult> => {
    // Only a route the STORE holds — the backend resolves the waypoint there.
    // (Not `rev > 0`: a route made by another SignalK app lists with rev 0.)
    if (route.waypoints.length === 0 || !client.routes().some((r) => r.id === route.id)) return "failed";
    const a = client.active();
    if (a?.route_id === route.id) return "already";
    if (a && !opts.confirmed) {
      const current = client.routes().find((r) => r.id === a.route_id);
      notify({
        id: "route-follow-switch",
        title: `Switch to ${followName(route)}?`,
        detail: current ? `Now following ${followName(current)}.` : undefined,
        action: { label: "Switch", run: () => void follow(route, { confirmed: true }) },
      });
      return "asked";
    }
    const i = followStartIndex(deps.boat(), route.waypoints);
    return (await activate(route, i, `Following ${followName(route)}`)) ? "started" : "failed";
  };

  const startAt = async (routeId: string, waypointId: string): Promise<boolean> => {
    const route = client.routes().find((r) => r.id === routeId);
    const i = route ? route.waypoints.findIndex((w) => w.id === waypointId) : -1;
    if (!route || i < 0) return false;
    return activate(route, i, `Following ${followName(route)}`);
  };

  const skip = async (delta: 1 | -1): Promise<boolean> => {
    // The backend may have auto-advanced since the last poll: build on that.
    await client.refresh();
    const l = legOf();
    if (!l) return false;
    const j = skipTarget(l.index, l.route.waypoints.length, delta);
    if (j === null) return false;
    return activate(l.route, j, delta > 0 ? "Skipped to the next waypoint" : "Back to the previous waypoint");
  };

  return { leg: legOf, follow, startAt, skip };
}
