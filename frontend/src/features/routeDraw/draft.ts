// The manual route editor's DRAFT: pure edit operations on an immutable
// `Route` snapshot, and the undo/redo history over those snapshots. No Solid,
// no map — every edit is `Route -> Route`, so the whole editor's data side is
// testable with plain values.
//
// A manually placed point is `stop: true` — a point a person chose, which is
// what the route display draws as a handle (features/route/overlay.ts: a
// `stop: false` waypoint is a router-inserted bend, a small unlabeled dot).
// `approximate` is never set here: it means "the router could not verify this
// leg", which no hand-drawn leg ever claimed.

import type { Route, Waypoint } from "../../core/routes";
import type { GeoPoint } from "../../core/chrome/geo";

/** The backend's `MAX_NAME_LENGTH` (mivnav/features/route/store.py). */
export const MAX_NAME_LENGTH = 64;
/** The backend's `MAX_WAYPOINTS`. An add past it is refused, not truncated. */
export const MAX_WAYPOINTS = 500;
/** How many undo steps are kept. A route is a handful of small objects. */
export const HISTORY_LIMIT = 200;

/** Longitude into [-180, 180] — the backend rejects anything outside it, and
 * an unprojected point on a world copy can be at 190°. */
export const wrapLng = (lng: number): number => {
  // In range: untouched — the modulo below adds float noise (10.6 → 10.600…023).
  if (lng >= -180 && lng <= 180) return lng;
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  // -180 and 180 are the same meridian; keep the caller's sign at the seam.
  return w === -180 && lng > 0 ? 180 : w;
};

const clampLat = (lat: number): number => Math.max(-90, Math.min(90, lat));

/** A deep-enough copy: the waypoint objects are never mutated, but a copy
 * makes the draft provably independent of the store's route. */
export const copyRoute = (r: Route): Route => ({ ...r, waypoints: r.waypoints.map((w) => ({ ...w })) });

/** A fresh, never-saved route. `rev: 0` is what `RoutesClient.save` reads as
 * "first create — no If-Match". */
export const blankRoute = (id: string, planSpeedKn: number): Route => ({
  id,
  name: "",
  waypoints: [],
  plan_speed_kn: planSpeedKn,
  rev: 0,
  updated: 0,
});

/** A new hand-placed waypoint. Unnamed: every display falls back to its number. */
export const newWaypoint = (id: string, at: GeoPoint): Waypoint => ({
  id,
  name: "",
  lat: clampLat(at.lat),
  lon: wrapLng(at.lng),
  stop: true,
});

/** Insert `wp` at `index` (clamped). Refused at `MAX_WAYPOINTS`. */
export function insertPoint(r: Route, index: number, wp: Waypoint): Route {
  if (r.waypoints.length >= MAX_WAYPOINTS) return r;
  const i = Math.max(0, Math.min(r.waypoints.length, index));
  const waypoints = [...r.waypoints];
  waypoints.splice(i, 0, wp);
  return { ...r, waypoints };
}

export function movePoint(r: Route, id: string, at: GeoPoint): Route {
  const i = r.waypoints.findIndex((w) => w.id === id);
  if (i < 0) return r;
  const old = r.waypoints[i]!;
  const lat = clampLat(at.lat);
  const lon = wrapLng(at.lng);
  if (old.lat === lat && old.lon === lon) return r;
  const waypoints = [...r.waypoints];
  waypoints[i] = { ...old, lat, lon };
  return { ...r, waypoints };
}

export function removePoint(r: Route, id: string): Route {
  if (!r.waypoints.some((w) => w.id === id)) return r;
  return { ...r, waypoints: r.waypoints.filter((w) => w.id !== id) };
}

const cleanName = (name: string): string => name.trim().slice(0, MAX_NAME_LENGTH);

export function renamePoint(r: Route, id: string, name: string): Route {
  const i = r.waypoints.findIndex((w) => w.id === id);
  if (i < 0) return r;
  const next = cleanName(name);
  if (r.waypoints[i]!.name === next) return r;
  const waypoints = [...r.waypoints];
  waypoints[i] = { ...r.waypoints[i]!, name: next };
  return { ...r, waypoints };
}

export function renameRoute(r: Route, name: string): Route {
  const next = cleanName(name);
  return r.name === next ? r : { ...r, name: next };
}

/** The planning speed (knots). A non-positive or non-finite one is refused —
 * the backend would reject it, and no route is planned at zero knots. */
export function setPlanSpeed(r: Route, kn: number): Route {
  if (!Number.isFinite(kn) || kn <= 0 || r.plan_speed_kn === kn) return r;
  return { ...r, plan_speed_kn: kn };
}

/** The planned departure (ISO UTC), or null for "leave now". */
export function setDepartAt(r: Route, iso: string | null): Route {
  return (r.depart_at ?? null) === iso ? r : { ...r, depart_at: iso };
}

/** Same route CONTENT — what "dirty" compares. `rev`/`updated` are server
 * bookkeeping, not an edit; waypoint flags count (a moved point keeps its). */
export function sameContent(a: Route, b: Route): boolean {
  if (a.id !== b.id || a.name !== b.name || a.plan_speed_kn !== b.plan_speed_kn) return false;
  if ((a.depart_at ?? null) !== (b.depart_at ?? null)) return false;
  if (a.waypoints.length !== b.waypoints.length) return false;
  return a.waypoints.every((w, i) => {
    const v = b.waypoints[i]!;
    return (
      w.id === v.id &&
      w.name === v.name &&
      w.lat === v.lat &&
      w.lon === v.lon &&
      !!w.stop === !!v.stop &&
      !!w.approximate === !!v.approximate
    );
  });
}

// ── Undo/redo ────────────────────────────────────────────────────────────────

/** Snapshot history. `present` is the draft; `past` and `future` are whole
 * routes, not diffs — a route is small and a snapshot can't drift. */
export interface History {
  past: readonly Route[];
  present: Route;
  future: readonly Route[];
}

export const historyOf = (r: Route): History => ({ past: [], present: r, future: [] });

/** One undo step: `next` becomes the draft, the old draft goes on the stack.
 * A no-op edit (the op returned the same object) records nothing. */
export function commit(h: History, next: Route): History {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

/** Replace the draft WITHOUT a history step — a drag's live rubber-band. The
 * drag's start is recorded once, at its end, via `commitFrom`. */
export const replacePresent = (h: History, next: Route): History => ({ ...h, present: next });

/** Close a drag: one undo step from `base` (the pre-drag draft) to the current
 * draft. Nothing recorded if the drag ended where it started. */
export function commitFrom(h: History, base: Route): History {
  if (sameContent(h.present, base)) return { ...h, present: base };
  return { past: [...h.past, base].slice(-HISTORY_LIMIT), present: h.present, future: [] };
}

export const canUndo = (h: History): boolean => h.past.length > 0;
export const canRedo = (h: History): boolean => h.future.length > 0;

export function undo(h: History): History {
  if (!canUndo(h)) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (!canRedo(h)) return h;
  return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) };
}
