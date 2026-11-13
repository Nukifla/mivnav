// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import { groupApproximateRuns } from "./runs";

describe("groupApproximateRuns", () => {
  const pts = [0, 1, 2, 3] as const; // stand-ins for waypoints; identity matters more than shape

  test("no leg approximate: the whole thing is one real run", () => {
    const runs = groupApproximateRuns(pts, [false, false, false]);
    expect(runs).toEqual([{ points: [0, 1, 2, 3], approximate: false }]);
  });

  test("start leg approximate: a leading run, sharing its endpoint with the real run", () => {
    const runs = groupApproximateRuns(pts, [true, false, false]);
    expect(runs).toEqual([
      { points: [0, 1], approximate: true },
      { points: [1, 2, 3], approximate: false },
    ]);
  });

  test("end leg approximate: a trailing run, sharing its endpoint with the real run", () => {
    const runs = groupApproximateRuns(pts, [false, false, true]);
    expect(runs).toEqual([
      { points: [0, 1, 2], approximate: false },
      { points: [2, 3], approximate: true },
    ]);
  });

  test("both ends approximate, real run in between", () => {
    const runs = groupApproximateRuns(pts, [true, false, true]);
    expect(runs).toEqual([
      { points: [0, 1], approximate: true },
      { points: [1, 2], approximate: false },
      { points: [2, 3], approximate: true },
    ]);
  });

  test("a run in the MIDDLE — not just the two ends", () => {
    const five = [0, 1, 2, 3, 4] as const;
    const runs = groupApproximateRuns(five, [false, true, false, false]);
    expect(runs).toEqual([
      { points: [0, 1], approximate: false },
      { points: [1, 2], approximate: true },
      { points: [2, 3, 4], approximate: false },
    ]);
  });

  test("degenerate: only 2 points and the one leg is approximate — no real run at all", () => {
    const two = [0, 1] as const;
    expect(groupApproximateRuns(two, [true])).toEqual([{ points: [0, 1], approximate: true }]);
  });

  test("a single waypoint, no legs: one non-approximate run of length 1", () => {
    expect(groupApproximateRuns([0] as const, [])).toEqual([{ points: [0], approximate: false }]);
  });

  test("no waypoints at all: empty", () => {
    expect(groupApproximateRuns([], [])).toEqual([]);
  });

  // A real regression, caught live: `route/overlay.ts` gates `approximateLegs`
  // to `[]` for every route except the ephemeral "Go here" one (see
  // `RouteOverlay.approximateLegs`'s own docs) — so an ORDINARY multi-waypoint
  // saved route reaches this function with `waypoints.length >= 2` but an
  // EMPTY `approximateLegs`. The old implementation walked
  // `while (i < approximateLegs.length)`, which never ran at all for an empty
  // array — zero runs, so the caller drew no line feature whatsoever (only the
  // waypoint handles, with nothing joining them). Must still produce one
  // whole, non-approximate run spanning every waypoint.
  test("empty approximateLegs on a multi-waypoint route: one whole real run, not zero", () => {
    const runs = groupApproximateRuns(pts, []);
    expect(runs).toEqual([{ points: [0, 1, 2, 3], approximate: false }]);
  });

  // Same shape, short by one entry rather than fully empty — defensive: a
  // mismatched-length input should still cover every leg, defaulting any
  // missing entry to "not approximate" rather than silently truncating the
  // route.
  test("approximateLegs shorter than legCount: the missing tail defaults to not-approximate", () => {
    const runs = groupApproximateRuns(pts, [true]);
    expect(runs).toEqual([
      { points: [0, 1], approximate: true },
      { points: [1, 2, 3], approximate: false },
    ]);
  });
});
