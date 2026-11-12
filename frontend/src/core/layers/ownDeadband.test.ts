/**
 * `settledSelf` freezes own-ship's rendered pose at the last-committed fix
 * while GPS/compass jitter keeps arriving, so scenePush's byte-identical
 * dedup can skip a `setData` that would otherwise fire on every tick (see the
 * module header for the real-device trace that motivated this).
 */

import { describe, expect, test } from "bun:test";
import type { Vessel } from "../signalk";
import {
  OWN_ROTATION_DEADBAND_DEG,
  OWN_SPEED_DEADBAND_MS,
  settledSelf,
  withinOwnDeadband,
} from "./ownDeadband";

function vessel(overrides: Partial<Vessel> = {}): Vessel {
  return { lat: 55.9, lng: 12.6, headingDeg: 90, cogDeg: 90, sogMs: 2, ...overrides };
}

describe("settledSelf", () => {
  test("commits the first fix as-is", () => {
    const key = {};
    const self = vessel();
    expect(settledSelf(key, self)).toBe(self);
  });

  test("null self clears the baseline and passes through", () => {
    const key = {};
    settledSelf(key, vessel());
    expect(settledSelf(key, null)).toBeNull();
    // baseline cleared: the next fix is treated as a first commit, not a delta
    const next = vessel({ lat: 55.90001 });
    expect(settledSelf(key, next)).toBe(next);
  });

  test("any new position commits, at rest too — the boat moves with every fix", () => {
    const key = {};
    const first = vessel({ sogMs: 0.05 });
    settledSelf(key, first);
    // ~0.3 m north: GPS wander at a berth, still a new fix
    const next = vessel({ sogMs: 0.05, lat: first.lat + 0.0000027 });
    expect(settledSelf(key, next)).toBe(next);
  });

  test("an unchanged position with compass jitter is still deduped", () => {
    const key = {};
    const first = vessel({ headingDeg: 90 });
    settledSelf(key, first);
    expect(settledSelf(key, vessel({ headingDeg: 90.5 }))).toBe(first);
  });

  test("a real move past the position deadband commits the new fix", () => {
    const key = {};
    const first = vessel();
    settledSelf(key, first);
    // ~11 m north — past the 2 m deadband
    const moved = vessel({ lat: first.lat + 0.0001 });
    expect(settledSelf(key, moved)).toBe(moved);
    // and it becomes the new baseline
    expect(settledSelf(key, vessel({ ...moved }))).toBe(moved);
  });

  test("a heading swing past the rotation deadband commits the new fix", () => {
    const key = {};
    const first = vessel({ headingDeg: 90 });
    settledSelf(key, first);
    const turned = vessel({ headingDeg: 95 });
    expect(settledSelf(key, turned)).toBe(turned);
  });

  test("heading wraparound near 0/360 is not a false positive", () => {
    const key = {};
    const first = vessel({ headingDeg: 359 });
    settledSelf(key, first);
    const jittered = vessel({ headingDeg: 0.5 }); // 1.5 deg away through 0, not 358.5
    expect(settledSelf(key, jittered)).toBe(first);
  });

  test("heading appearing/disappearing always breaks the freeze", () => {
    const key = {};
    const first = vessel({ headingDeg: 90 });
    settledSelf(key, first);
    const noHeading = vessel({ headingDeg: undefined });
    expect(settledSelf(key, noHeading)).toBe(noHeading);
  });

  test("an SOG change past the speed deadband commits the new fix", () => {
    const key = {};
    const first = vessel({ sogMs: 0 });
    settledSelf(key, first);
    const accelerating = vessel({ sogMs: 0.5 }); // well past the ~0.05 m/s deadband
    expect(settledSelf(key, accelerating)).toBe(accelerating);
  });

  test("distinct keys never share a baseline", () => {
    const a = {};
    const b = {};
    const first = vessel();
    settledSelf(a, first);
    const turnedForB = vessel({ headingDeg: 90.5 });
    // b has no baseline yet, so this is a first commit, not a freeze
    expect(settledSelf(b, turnedForB)).toBe(turnedForB);
  });
});

describe("withinOwnDeadband", () => {
  test("thresholds are the documented magnitudes", () => {
    expect(OWN_ROTATION_DEADBAND_DEG).toBe(2);
    expect(OWN_SPEED_DEADBAND_MS).toBe(0.05);
  });

  test("identical vessels are within the deadband", () => {
    const v = vessel();
    expect(withinOwnDeadband(v, { ...v })).toBe(true);
  });
});
