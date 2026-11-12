// Bearing/range arithmetic behind the cursor readout and Measure (README #6).
// Pure/DOM-free so `bun test` can exercise it; range reuses `cpa.ts`'s
// audited formula. Formatting lives in `../format.ts` only.

import { rangeNm as cpaRangeNm, wrapLonDeltaDeg } from "../cpa";

export interface GeoPoint {
  lng: number;
  lat: number;
}

const ARCMIN_PER_DEG = 60;
const DEG_TO_RAD = Math.PI / 180;

/** Range in nautical miles. `cpa.ts`'s mid-latitude plane, unchanged. */
export const rangeNm = (from: GeoPoint, to: GeoPoint): number => cpaRangeNm(from, to);

/**
 * Bearing from `from` to `to`, degrees true, [0, 360). Rhumb, not
 * great-circle: drawn straight on a Mercator chart, which IS a rhumb line —
 * great-circle would name a direction the line doesn't go.
 */
export function bearingDeg(from: GeoPoint, to: GeoPoint): number {
  const midLatRad = ((from.lat + to.lat) / 2) * DEG_TO_RAD;
  const east = wrapLonDeltaDeg(to.lng - from.lng) * ARCMIN_PER_DEG * Math.cos(midLatRad);
  const north = (to.lat - from.lat) * ARCMIN_PER_DEG;
  // (east, north), not (x, y): bearing is clockwise from north, so north is
  // the FIRST argument — swapped, this is where sign errors live.
  const deg = Math.atan2(east, north) / DEG_TO_RAD;
  return (deg + 360) % 360;
}
