// Snap to marks, as pure decisions. A point placed (or dropped) within a
// point's hit radius of a standalone mark (features/marks — a Signal K
// waypoint resource) lands EXACTLY on the mark and takes its name if it has
// none. The route point is a COPY: moving the mark later never moves it —
// there are no linked points.

import type { Route, Waypoint } from "../../core/routes";
import type { GeoPoint } from "../../core/chrome/geo";
import { MAX_NAME_LENGTH } from "./draft";
import type { Px } from "./gesture";

/** What a point can snap to — `features/marks`' `Mark` fits it as is. */
export interface SnapMark {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/**
 * The mark a point at `at` snaps to: the nearest one whose screen position is
 * within `radius` px, else null. `project` is the map's (geo → screen px).
 */
export function findSnap(
  at: GeoPoint,
  marks: readonly SnapMark[],
  project: (p: GeoPoint) => Px,
  radius: number,
): SnapMark | null {
  if (marks.length === 0) return null;
  const p = project(at);
  let best: SnapMark | null = null;
  let bestD = Infinity;
  for (const m of marks) {
    const q = project({ lng: m.lon, lat: m.lat });
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= radius && d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

/** The waypoint moved onto `mark`, named after it when it has no name of its own. */
export function snapWaypoint(wp: Waypoint, mark: SnapMark): Waypoint {
  const name = wp.name || mark.name.trim().slice(0, MAX_NAME_LENGTH);
  if (wp.lat === mark.lat && wp.lon === mark.lon && wp.name === name) return wp;
  return { ...wp, lat: mark.lat, lon: mark.lon, name };
}

/** Route op: point `id` moved onto `mark` (see `snapWaypoint`). Same object back if nothing changes. */
export function snapPoint(r: Route, id: string, mark: SnapMark): Route {
  const i = r.waypoints.findIndex((w) => w.id === id);
  if (i < 0) return r;
  const next = snapWaypoint(r.waypoints[i]!, mark);
  if (next === r.waypoints[i]) return r;
  const waypoints = [...r.waypoints];
  waypoints[i] = next;
  return { ...r, waypoints };
}
