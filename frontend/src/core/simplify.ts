// Polyline simplification on the sphere, in METRES — Douglas–Peucker over a
// local equirectangular projection. Used to turn a recorded track (thousands
// of fixes) into a route a person can read and edit (tens of waypoints): the
// ship track's "Make route from track" and a GPX `<trk>` import.
//
// Pure, no DOM, no MapLibre. Local projection is fine at track scale: the
// error of a flat plane over a few hundred km is far below the tolerances
// used here (tens of metres).

/** A point in degrees — `lon`, matching the route store's waypoints. */
export interface LatLon {
  lat: number;
  lon: number;
}

const R = 6_371_008.8; // mean Earth radius, metres
const RAD = Math.PI / 180;

/** Longitude difference wrapped to [-180, 180) — a track crossing the
 * antimeridian stays one short line, not a trip round the world. */
const dLon = (a: number, b: number): number => ((((b - a) % 360) + 540) % 360) - 180;

/** Project to local x/y metres around `origin` (equirectangular). */
function project(points: readonly LatLon[], origin: LatLon): Float64Array {
  const k = Math.cos(origin.lat * RAD);
  const out = new Float64Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    out[2 * i] = dLon(origin.lon, p.lon) * RAD * R * k;
    out[2 * i + 1] = (p.lat - origin.lat) * RAD * R;
  }
  return out;
}

/** Path length in metres (sum of the flat-projected legs). */
export function pathLengthM(points: readonly LatLon[]): number {
  if (points.length < 2) return 0;
  const xy = project(points, meanOrigin(points));
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    sum += Math.hypot(xy[2 * i]! - xy[2 * i - 2]!, xy[2 * i + 1]! - xy[2 * i - 1]!);
  }
  return sum;
}

function meanOrigin(points: readonly LatLon[]): LatLon {
  let lat = 0;
  for (const p of points) lat += p.lat;
  return { lat: lat / points.length, lon: points[0]!.lon };
}

/** Squared distance from P to the SEGMENT AB (not the infinite line: a track
 * that doubles back must keep its turning point). */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/**
 * Douglas–Peucker: the subset of `points` (endpoints always kept, order
 * preserved) such that no dropped point lies further than `toleranceM` from
 * the simplified line. Iterative (an explicit stack), so a 100k-fix track
 * cannot blow the call stack. Returns a new array of the ORIGINAL objects.
 */
export function simplifyPath<T extends LatLon>(points: readonly T[], toleranceM: number): T[] {
  const n = points.length;
  if (n <= 2) return [...points];
  const xy = project(points, meanOrigin(points));
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = Math.max(0, toleranceM) ** 2;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    const ax = xy[2 * first]!;
    const ay = xy[2 * first + 1]!;
    const bx = xy[2 * last]!;
    const by = xy[2 * last + 1]!;
    let worst = -1;
    let worstD = tol2;
    for (let i = first + 1; i < last; i++) {
      const d = segDist2(xy[2 * i]!, xy[2 * i + 1]!, ax, ay, bx, by);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(first, worst, worst, last);
    }
  }
  const out: T[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

/** The starting tolerance for a track of `lengthM`: 1/500 of its length,
 * held between 20 m (a short harbour hop keeps its turns) and 50 m (a long
 * passage does not keep every wobble of the helm). */
export function trackToleranceM(lengthM: number): number {
  return Math.min(50, Math.max(20, lengthM / 500));
}

/** Waypoint budget for a route made from a track — well below the store's
 * 500, so the result stays editable by hand on a phone. */
export const TRACK_ROUTE_MAX_POINTS = 200;

export interface TrackSimplification<T> {
  points: T[];
  /** The tolerance actually used, metres (raised past the start if needed). */
  toleranceM: number;
}

/**
 * Simplify a recorded track for use as a route: Douglas–Peucker at
 * `trackToleranceM(length)`, then — if that still leaves more than
 * `maxPoints` — raised ×1.5 until it fits. Consecutive duplicates (a boat at
 * rest logs the same fix over and over) are dropped first.
 */
export function simplifyTrack<T extends LatLon>(
  points: readonly T[],
  maxPoints: number = TRACK_ROUTE_MAX_POINTS,
): TrackSimplification<T> {
  const deduped: T[] = [];
  for (const p of points) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.lat !== p.lat || prev.lon !== p.lon) deduped.push(p);
  }
  let toleranceM = trackToleranceM(pathLengthM(deduped));
  let out = simplifyPath(deduped, toleranceM);
  // Bounded: each pass multiplies the tolerance, and at any tolerance beyond
  // the track's extent DP returns just the two endpoints.
  for (let i = 0; i < 60 && out.length > Math.max(2, maxPoints); i++) {
    toleranceM *= 1.5;
    out = simplifyPath(deduped, toleranceM);
  }
  return { points: out, toleranceM };
}
