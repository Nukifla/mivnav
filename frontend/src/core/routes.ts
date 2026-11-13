// Client for the boat's sailing routes and the leg it is following — GET/PUT
// /api/routes. Routes are BOAT data, stored server-side (not localStorage).
// See docs/architecture/routes-api-design.md for the API contract mirrored here.

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { components } from "../api.generated";

/** One point on a route. `lon`, not `lng` — the wire shape is the backend's
 * (mivnav.config.routes.Waypoint). `id` is stable for the waypoint's life: it is
 * what the active leg points at, so it survives a rename or a reorder. */
export interface Waypoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Was the LEG ARRIVING at this waypoint a straight-line stand-in
   * `POST /routing/plan` could not actually verify (`PlanResult.
   * approximateLegs`, the autorouting plugin's `routeFromPlan`)?
   * Optional — absent (treated as `false`) for a route saved before this
   * field existed, or any waypoint a person placed by hand. #owqqcdqe,
   * 2026-08-10: this used to live ONLY in an ephemeral signal, gone the
   * moment the page reloaded — a genuinely-flagged "verify manually"
   * stretch then silently rendered as an ordinary, fully-trusted leg.
   * Persisted here so the warning survives for the life of the route. */
  approximate?: boolean;
  /** Was this point a stop the mariner actually chose — From/a stop/To, set
   * via search, "use boat position", or "choose on map" — as opposed to a
   * bend the router inserted while routing between two stops? Optional —
   * absent (treated as `false`) for a route saved before this field
   * existed. `features/route/index.ts`'s `draftStops` derives the
   * From/Stop/To list a reopened route shows entirely from this flag, so a
   * route with none set reads as having no stops (its waypoints render as
   * plain route-line bends). */
  stop?: boolean;
}

/** Default planning speed (knots) for a route that carries none — mirrors the
 * backend's `DEFAULT_PLAN_SPEED_KN`; also the fallback for an older-server
 * route arriving without the field. */
export const DEFAULT_PLAN_SPEED_KN = 5.0;

export interface Route {
  id: string;
  name: string;
  waypoints: Waypoint[];
  /** Planning speed in knots, persisted with the route boat-wide. Drives the
   * at-rest ETA/time estimates (see chrome/route.ts `planRouteMetrics`). */
  plan_speed_kn: number;
  /** Planned departure, ISO 8601 UTC (`2026-11-06T09:30:00Z`); absent/null =
   * "leave now" — the leg table then counts its ETAs from the current time. */
  depart_at?: string | null;
  /** Server-owned concurrency token. Echoed back on save as `If-Match`. */
  rev: number;
  updated: number;
}

/** A route from the wire, defaulting `plan_speed_kn` if it is absent. The
 * backend fills the default on load, so this only bites an older server; it is
 * cheap insurance that no route reaches the app without a planning speed. */
const withPlanSpeed = (r: Route): Route =>
  r.plan_speed_kn > 0 ? r : { ...r, plan_speed_kn: DEFAULT_PLAN_SPEED_KN };

/** Two wire routes with identical content. `rev`/`updated` alone would do for
 * every server-side edit we know of, but a whole-document compare is cheap for
 * a handful of small routes and does not bet on the server bumping them. */
const sameRoute = (a: Route, b: Route): boolean =>
  a.id === b.id && a.rev === b.rev && a.updated === b.updated && JSON.stringify(a) === JSON.stringify(b);

/** The polled list, but with the PREVIOUS object kept for every route whose
 * content is unchanged — and the previous array itself when nothing changed.
 * Without this every 5 s poll handed `<For>` lists (RouteList) fresh objects,
 * so they rebuilt every row's DOM under the user's finger and taps landing
 * mid-poll were lost. A route that
 * really changed (new rev, new content) still gets a new object, so memos and
 * effects keyed on it re-run exactly when they should. */
export function reuseUnchanged(prev: readonly Route[], next: Route[]): Route[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  const merged = next.map((r) => {
    const old = byId.get(r.id);
    return old && sameRoute(old, r) ? old : r;
  });
  const same = merged.length === prev.length && merged.every((r, i) => r === prev[i]);
  return same ? (prev as Route[]) : merged;
}

/** How the active leg is steered (#RF-NAVMODE, backend contract): `"line"`
 * follows the planned leg with cross-track, `"target"` steers straight to the
 * waypoint. Backend-owned — the frontend reads it, never sets it on GO. */
export type SteerMode = "target" | "line";

/** What the boat is following: a route and the waypoint GO selected. Never
 * inferred, never advanced (invariant #8). `null` = following nothing. */
export interface ActiveLeg {
  route_id: string;
  waypoint_id: string;
  /** Steering mode (#RF-NAVMODE). Optional on the wire (older server); backend
   * owns it, so `setActive` never sets it — `withSteerMode` fills the read-side
   * default. */
  mode?: SteerMode;
}

/** Defaults `mode` to `"line"` when absent (pre-mode behaviour, so a no-op
 * visual change) — same insurance as `withPlanSpeed`, for an older server or
 * a leg persisted before the mode existed. */
const withSteerMode = (a: ActiveLeg | null): ActiveLeg | null =>
  a ? { ...a, mode: a.mode ?? "line" } : null;

/** `PUT /routes/active`'s body — off the OpenAPI schema. No `mode`: the
 * backend's own `ActiveLeg` model dropped it (#yprzuqtt, see that class's
 * docstring) — the frontend's `mode?` above only still exists to hold what
 * `withSteerMode` defaults on READ, and every real `setActive` call site
 * already sends just `{route_id, waypoint_id}`, so narrowing the WRITE type
 * to the real request schema costs nothing and catches this if it ever
 * changes back. */
type ActiveLegRequest = components["schemas"]["ActiveLeg"];

/** The previous active-leg object when the polled one is the same leg, so
 * readers of `active()` don't re-run on every poll. */
const sameLeg = (prev: ActiveLeg | null, next: ActiveLeg | null): ActiveLeg | null =>
  prev && next && prev.route_id === next.route_id && prev.waypoint_id === next.waypoint_id && prev.mode === next.mode
    ? prev
    : next;

export interface RoutesClient {
  /** Every route, newest-saved first (the server's order). */
  routes: Accessor<Route[]>;
  /** The persisted active leg, or null. */
  active: Accessor<ActiveLeg | null>;
  /** Re-read the whole store — picks up edits made on another device. */
  refresh(): Promise<void>;
  /** Create or replace a route; resolves to it with its new `rev`. */
  save(route: Route): Promise<Route>;
  /** Delete a route, guarded by its `rev`. */
  remove(id: string, rev: number): Promise<void>;
  /** Press GO on a waypoint, or clear it with `null`. */
  setActive(leg: ActiveLegRequest | null): Promise<void>;
}

/** Carries the HTTP status so the caller can tell a 409 concurrency conflict
 * (another cockpit device saved first) from a plain network failure and react
 * differently: refresh-to-server vs. warn-unsaved. */
export class RouteSaveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RouteSaveError";
  }
}

const BASE = "/api/routes";

interface Options {
  /** Re-read the store this often, to reflect edits from other screens aboard.
   * A route store is a handful of small documents; a slow poll is nothing and it
   * is the whole of "boat-wide". 0 disables it (tests). */
  pollMs?: number;
  /** While a route is followed, re-read the store this often too — the
   * backend's NavWatcher advances the active leg server-side and republishes
   * to SignalK, but this client only learns it from GET /routes, so band.top
   * would sit stale otherwise. Starts/stops with `active()`; 0 disables. */
  followPollMs?: number;
}

/**
 * A live view of the server's route store, plus the writers the editor needs.
 *
 * Constructed once in App.tsx and prop-drilled, like every other client here.
 * The editor (`chrome/route.ts`) takes this as an injected dependency — a
 * `RoutesClient` — so its tap/insert/GO logic is testable against a fake with no
 * network, exactly as the measure feature is testable against a fake SignalK.
 */
export function createRoutesClient(opts: Options = {}): RoutesClient {
  const [routes, setRoutes] = createSignal<Route[]>([]);
  const [active, setActiveState] = createSignal<ActiveLeg | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch(BASE);
      if (!res.ok) throw new Error(`GET ${BASE} → ${res.status}`);
      const body = (await res.json()) as { routes: Route[]; active: ActiveLeg | null };
      setRoutes((prev) => reuseUnchanged(prev, (body.routes ?? []).map(withPlanSpeed)));
      setActiveState((prev) => sameLeg(prev, withSteerMode(body.active ?? null)));
    } catch (e) {
      // A plotter that cannot reach the store keeps whatever it last saw; a
      // route list that blanks itself on one dropped poll is worse than a stale
      // one. The next poll (or the next explicit refresh) recovers.
      console.error("routes: refresh failed", e);
    }
  };

  const save = async (route: Route): Promise<Route> => {
    const res = await fetch(`${BASE}/${encodeURIComponent(route.id)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        // Guard a concurrent edit — omit it only for a first create, which has
        // no rev to match. rev 0 is a route this client minted and never saved.
        ...(route.rev > 0 ? { "If-Match": `"${route.rev}"` } : {}),
      },
      body: JSON.stringify(route),
    });
    if (!res.ok) throw new RouteSaveError(res.status, `PUT route → ${res.status}: ${await res.text()}`);
    const saved = withPlanSpeed((await res.json()) as Route);
    setRoutes((rs) => {
      const rest = rs.filter((r) => r.id !== saved.id);
      return [saved, ...rest];
    });
    return saved;
  };

  const remove = async (id: string, rev: number): Promise<void> => {
    const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: rev > 0 ? { "If-Match": `"${rev}"` } : {},
    });
    if (!res.ok && res.status !== 404) throw new Error(`DELETE route → ${res.status}`);
    setRoutes((rs) => rs.filter((r) => r.id !== id));
    // Deleting the followed route stops the follow, server-side
    // (RouteStore._settle_active). Reflect that here so band.top vanishes at
    // once rather than at the next poll.
    setActiveState((a) => (a?.route_id === id ? null : a));
  };

  const setActive = async (leg: ActiveLegRequest | null): Promise<void> => {
    const res = await fetch(`${BASE}/active`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(leg),
    });
    if (!res.ok) throw new Error(`PUT active → ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { active: ActiveLeg | null };
    setActiveState(withSteerMode(body.active ?? null));
  };

  void refresh();
  const pollMs = opts.pollMs ?? 5000;
  if (pollMs > 0 && typeof setInterval !== "undefined") {
    const timer = setInterval(() => void refresh(), pollMs);
    onCleanup(() => clearInterval(timer));
  }

  // Re-runs whenever `active()` flips null<->leg; Solid's `onCleanup` stops
  // the previous interval before starting the next, so this tracks the
  // followed state (and stops on unmount/dispose) automatically.
  const followPollMs = opts.followPollMs ?? 3000;
  if (followPollMs > 0 && typeof setInterval !== "undefined") {
    createEffect(() => {
      if (active() === null) return;
      const timer = setInterval(() => void refresh(), followPollMs);
      onCleanup(() => clearInterval(timer));
    });
  }

  return { routes, active, refresh, save, remove, setActive };
}
