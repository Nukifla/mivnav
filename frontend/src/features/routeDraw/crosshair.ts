// Crosshair mode, as pure decisions: a fixed crosshair at the map centre is
// the aim, "+ Here" / "Move here" act on it, and a dashed rubber band runs to
// it from the point the action would join — the selected point (what "Move
// here" moves) or, with nothing selected, the last point ("+ Here" appends).

import type { Waypoint } from "../../core/routes";
import { bearingDeg, rangeNm, type GeoPoint } from "../../core/chrome/geo";

/** The point the rubber band starts from, or null (no points yet). */
export function aimAnchor(waypoints: readonly Waypoint[], selectedId: string | null): Waypoint | null {
  if (selectedId) {
    const sel = waypoints.find((w) => w.id === selectedId);
    if (sel) return sel;
  }
  return waypoints[waypoints.length - 1] ?? null;
}

export interface AimLeg {
  from: GeoPoint;
  to: GeoPoint;
  brgDeg: number;
  distNm: number;
}

/** Below this the band has no length worth a bearing — the aim sits on the
 * anchor (right after "+ Here", say). 5 m: the readout rounds to 10 m
 * (`formatRange`), so anything shorter would read "0 m" under a bearing that
 * means nothing. Band and readout hide together. */
export const MIN_AIM_NM = 5 / 1852;

/** The rubber band from `anchor` to the aim (already snapped, if it snaps). */
export function aimLeg(anchor: Waypoint | null, aim: GeoPoint | null): AimLeg | null {
  if (!anchor || !aim) return null;
  const from = { lng: anchor.lon, lat: anchor.lat };
  const distNm = rangeNm(from, aim);
  if (distNm < MIN_AIM_NM) return null;
  return { from, to: aim, brgDeg: bearingDeg(from, aim), distNm };
}
