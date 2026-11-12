// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import { groupApproximateRuns, planIsUnreachable, planRoute, type PlanFetch } from "./routing";

const jsonFetch =
  (body: unknown): PlanFetch =>
  async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

describe("planIsUnreachable", () => {
  test("false when no leg is approximate", () => {
    expect(planIsUnreachable({ approximateLegs: [false, false, false] })).toBe(false);
  });
  test("true when any leg is approximate — start, end, or the middle", () => {
    expect(planIsUnreachable({ approximateLegs: [true, false, false] })).toBe(true);
    expect(planIsUnreachable({ approximateLegs: [false, false, true] })).toBe(true);
    expect(planIsUnreachable({ approximateLegs: [false, true, false] })).toBe(true);
  });
  test("false with no legs at all", () => {
    expect(planIsUnreachable({ approximateLegs: [] })).toBe(false);
  });
});

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

describe("planRoute — debug_legs parsing", () => {
  const A = { lng: 10.5, lat: 55.9 };
  const B = { lng: 10.63, lat: 55.95 };

  test("the raster / direct shape: bbox + hazard_rings", async () => {
    const r = await planRoute(
      A,
      B,
      undefined,
      jsonFetch({
        waypoints: [
          { lat: 55.9, lon: 10.5 },
          { lat: 55.95, lon: 10.63 },
        ],
        distance_nm: 3,
        warnings: ["x"],
        approximate_legs: [false],
        debug_legs: [
          {
            bbox: [10, 55, 11, 56],
            hazard_rings: [
              [
                [10.1, 55.1],
                [10.2, 55.1],
                [10.2, 55.2],
              ],
            ],
          },
        ],
      }),
      true,
    );
    expect(r.debugLegs).toHaveLength(1);
    const leg = r.debugLegs![0]!;
    expect(leg.bbox).toEqual([10, 55, 11, 56]);
    expect(leg.hazardRings![0]![0]).toEqual({ lng: 10.1, lat: 55.1 });
    expect(leg.reason).toBeUndefined();
    expect(leg.field).toBeUndefined();
  });

  test("the find_artifact_route_debug shape: reason, constraint rings, base64 grid", async () => {
    // A 2x2 grid, codes [open, hard, unknown-blocked, unknown-graced] = [0,1,2,3].
    const codesB64 = btoa(String.fromCharCode(0, 1, 2, 3));
    const r = await planRoute(
      A,
      B,
      undefined,
      jsonFetch({
        waypoints: [
          { lat: 55.9, lon: 10.5 },
          { lat: 55.95, lon: 10.63 },
        ],
        distance_nm: 3,
        warnings: ["coarse route found but a leg was rejected", "caveat"],
        approximate_legs: [true],
        debug_legs: [
          {
            reason: "severed",
            start_snap_m: 0,
            goal_snap_m: null,
            from: [10.5, 55.9],
            to: [10.63, 55.95],
            constraint_rings: {
              hard: [
                [
                  [10.5, 55.9],
                  [10.6, 55.9],
                  [10.6, 55.95],
                ],
              ],
              charted_depth: [],
            },
            field: {
              cols: 2,
              rows: 2,
              cell_size_m: 40,
              corners: [
                [10, 56],
                [11, 56],
                [11, 55],
                [10, 55],
              ],
              codes_b64: codesB64,
              start_cell: [0, 0],
              goal_cell: null,
            },
          },
        ],
      }),
      true,
    );
    const leg = r.debugLegs![0]!;
    expect(leg.reason).toBe("severed");
    expect(leg.from).toEqual({ lng: 10.5, lat: 55.9 });
    // A real regression: these two were in the wire payload
    // (`find_artifact_route_debug`, backend) from the start but never
    // reached `DebugLeg` at all — `start_snap_m`/`goal_snap_m` were absent
    // from `planRoute`'s response body type, so they were silently
    // dropped rather than parsed.
    expect(leg.startSnapM).toBe(0);
    expect(leg.goalSnapM).toBeNull();
    expect(leg.constraintRings!.hard![0]![1]).toEqual({ lng: 10.6, lat: 55.9 });
    expect(leg.constraintRings!.charted_depth).toEqual([]);
    expect(leg.bbox).toBeUndefined();
    expect(leg.hazardRings).toBeUndefined();
    expect(leg.field!.cols).toBe(2);
    expect(Array.from(leg.field!.codes)).toEqual([0, 1, 2, 3]);
    expect(leg.field!.startCell).toEqual([0, 0]);
    expect(leg.field!.goalCell).toBeNull();
  });
});
