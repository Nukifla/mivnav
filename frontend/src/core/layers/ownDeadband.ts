// see docs/architecture/own-ship-deadband.md

import { rangeNm, wrapLonDeltaDeg } from "../cpa";
import type { Vessel } from "../signalk";

/** Below this, a heading/COG delta is compass/GPS-course noise, not a turn. */
export const OWN_ROTATION_DEADBAND_DEG = 2;
/** Below this, an SOG delta is GPS speed noise, not acceleration. */
export const OWN_SPEED_DEADBAND_MS = 0.05; // ~0.1 kn

function angleDelta(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(wrapLonDeltaDeg(a - b));
}

/** True iff `next` is within the deadband of `prev` on every field feeding
 * own-ship's rendered geometry or `computeCpa`'s track. SOG is included since
 * it feeds predictor length, so real acceleration off anchor breaks the freeze.
 *
 * Position has NO deadband: any new fix moves the boat, at rest too (user,
 * 2026-10-03: "the boat should move as soon as the gps has a new position";
 * the track's live tail ends at every fix, and a frozen icon drifted off
 * it). GPS is 1 Hz, so that bounds own-ship rebuilds at one a second; the
 * angle/speed bands still swallow compass and SOG noise between fixes. */
export function withinOwnDeadband(prev: Vessel, next: Vessel): boolean {
  return (
    rangeNm(prev, next) === 0 &&
    angleDelta(prev.headingDeg, next.headingDeg) < OWN_ROTATION_DEADBAND_DEG &&
    angleDelta(prev.cogDeg, next.cogDeg) < OWN_ROTATION_DEADBAND_DEG &&
    Math.abs((prev.sogMs ?? 0) - (next.sogMs ?? 0)) < OWN_SPEED_DEADBAND_MS
  );
}

/** Per-map last-committed own-ship pose. Keyed on an opaque handle (the `Map`
 * instance in production; tests use a plain object) so unrelated maps in the
 * same process never share a baseline. */
export type DeadbandKey = object;

const lastCommitted = new WeakMap<DeadbandKey, Vessel>();

/** `self`, or the last-committed pose if `self` is within its deadband.
 * Commits `self` as the new baseline whenever it is not, and clears the
 * baseline when `self` is `null` (no fix to settle against). */
export function settledSelf(key: DeadbandKey, self: Vessel | null): Vessel | null {
  if (!self) {
    lastCommitted.delete(key);
    return self;
  }
  const prev = lastCommitted.get(key);
  if (prev && withinOwnDeadband(prev, self)) return prev;
  lastCommitted.set(key, self);
  return self;
}
