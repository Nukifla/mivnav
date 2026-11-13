// The routes feature: the pure geometry (projecting a point onto a leg, the
// nearest leg/waypoint, cross-track), the straight-line "Go to", the at-rest
// metrics, reverse/import/delete, the followed strip and the steering cues,
// and the overlay's data push. The From/Stop/To editor and the auto-routed
// "Go here" are the autorouting plugin's, tested there.
//
// No DOM, no map: a fake routes client and a fake SignalK.

import { createEffect, createRoot } from "solid-js";
import { describe, expect, test } from "bun:test";
import { knotsFromMs } from "../../core/cpa";
import { createSignal } from "solid-js";
import { RouteSaveError, type ActiveLeg, type Route, type RoutesClient, type Waypoint } from "../../core/routes";
import type { Notice } from "../../core/chrome/notices";
import type { SignalKState } from "../../core/signalk";
import { type GeoPoint, rangeNm } from "../../core/chrome/geo";
import { formatDuration } from "../../core/format";
import { DESK, type ReadCtx } from "../../core/chrome/registry";
import {
  ARRIVAL_RADIUS_NM,
  arrivalEvent,
  createRoutes,
  formatEta,
  crossTrack,
  mintUuid,
  directRoute,
  GO_HERE_ROUTE_ID,
  nearestInsertion,
  nearestLegTargetIndex,
  nearestWaypointIndex,
  planRouteMetrics,
  projectOntoLeg,
  reverseWaypoints,
  reversedCopy,
  routeMetrics,
} from "./index";
import { updateRouteData } from "./overlay";
import { testXmlParse } from "./testXml";
import { registerRoutePlanner, routePlanner } from "../../core/routePlanner";

const P = (lng: number, lat: number): GeoPoint => ({ lng, lat });

describe("projectOntoLeg", () => {
  test("foot at the midpoint of a leg the point sits square over", () => {
    const r = projectOntoLeg(P(1, 1), P(0, 0), P(2, 0));
    expect(r.t).toBeCloseTo(0.5, 6);
    expect(r.point.lng).toBeCloseTo(1, 6);
    expect(r.point.lat).toBeCloseTo(0, 6);
    // 1° of latitude off the leg ≈ 60 nm.
    expect(r.distNm).toBeCloseTo(60, 0);
  });

  test("clamps beyond the far end to the endpoint", () => {
    const r = projectOntoLeg(P(5, 0), P(0, 0), P(2, 0));
    expect(r.t).toBe(1);
    expect(r.point.lng).toBeCloseTo(2, 6);
  });

  test("clamps before the near end to the endpoint", () => {
    const r = projectOntoLeg(P(-3, 0), P(0, 0), P(2, 0));
    expect(r.t).toBe(0);
    expect(r.point.lng).toBeCloseTo(0, 6);
  });

  test("a degenerate leg has its foot at the start", () => {
    const r = projectOntoLeg(P(1, 1), P(0, 0), P(0, 0));
    expect(r.t).toBe(0);
    expect(r.point).toEqual(P(0, 0));
  });
});

describe("arrivalEvent", () => {
  const at = (index: number, count: number, routeId = "r") => ({ routeId, index, count });

  test("a one-step advance on the same route is a REACHED at the old waypoint", () => {
    // Steering to waypoint 1 (count 4), then to waypoint 2 → reached wp index 1.
    expect(arrivalEvent(at(1, 4), at(2, 4))).toEqual({ kind: "reached", reachedIndex: 1 });
  });

  test("the initial GO (null → first leg) fires nothing", () => {
    expect(arrivalEvent(null, at(0, 4))).toBeNull();
  });

  test("following ending from the LAST waypoint, the boat at it, completes the route", () => {
    // Was steering the final leg (index 2 of 3), last seen 0.1 nm off it → complete.
    expect(arrivalEvent({ ...at(2, 3), dtwNm: 0.1 }, null)).toEqual({ kind: "complete" });
  });

  test("a final-leg end FAR from the last waypoint is not a completion", () => {
    // A Stop (or delete) on another screen mid-way down the final leg.
    expect(arrivalEvent({ ...at(2, 3), dtwNm: 4 }, null)).toBeNull();
    // No fix seen: no evidence of an arrival.
    expect(arrivalEvent(at(2, 3), null)).toBeNull();
    expect(arrivalEvent({ ...at(2, 3), dtwNm: null }, null)).toBeNull();
  });

  test("this screen's own Stop/delete on the final leg is never a completion", () => {
    expect(arrivalEvent({ ...at(2, 3), dtwNm: 0.01 }, null, { userEnded: true })).toBeNull();
  });

  test("a manual Stop from the MIDDLE is not a completion", () => {
    // Index 1 of 3 is not the last waypoint, so → null is a Stop, not an arrival.
    expect(arrivalEvent(at(1, 3), null)).toBeNull();
  });

  test("a non-adjacent jump (a manual leg change) fires nothing", () => {
    expect(arrivalEvent(at(1, 6), at(4, 6))).toBeNull();
  });

  test("a backwards step fires nothing", () => {
    expect(arrivalEvent(at(3, 6), at(2, 6))).toBeNull();
  });

  test("swapping to a different route is not an arrival", () => {
    expect(arrivalEvent(at(1, 4, "r1"), at(2, 4, "r2"))).toBeNull();
  });

  test("still not following stays quiet", () => {
    expect(arrivalEvent(null, null)).toBeNull();
  });
});

describe("nearestInsertion", () => {
  const pts = [P(0, 0), P(2, 0), P(2, 2)]; // an L: leg 0 horizontal, leg 1 vertical

  test("a tap by the first leg inserts at index 1", () => {
    const ins = nearestInsertion(pts, P(1, 0.1))!;
    expect(ins.segment).toBe(0);
    expect(ins.index).toBe(1);
  });

  test("a tap by the second leg inserts at index 2 — between its two neighbours", () => {
    const ins = nearestInsertion(pts, P(2.1, 1))!;
    expect(ins.segment).toBe(1);
    expect(ins.index).toBe(2);
  });

  test("no leg to insert on with fewer than two points", () => {
    expect(nearestInsertion([P(0, 0)], P(0, 0))).toBeNull();
    expect(nearestInsertion([], P(0, 0))).toBeNull();
  });
});

describe("nearestWaypointIndex", () => {
  // wpPoint flips lon→lng; a run due north up 0°E. (Inlined, not `W`, which is
  // defined lower in the file — a `describe` body runs eagerly, before it binds.)
  const wps: Waypoint[] = [
    { id: "0", name: "", lat: 0, lon: 0 },
    { id: "1", name: "", lat: 1, lon: 0 },
    { id: "2", name: "", lat: 2, lon: 0 },
  ];

  test("picks the waypoint closest to the boat, not the first or last", () => {
    expect(nearestWaypointIndex(P(0, 0.1), wps)).toBe(0);
    expect(nearestWaypointIndex(P(0, 0.9), wps)).toBe(1); // closest to wp1 at lat 1
    expect(nearestWaypointIndex(P(0, 2.2), wps)).toBe(2);
  });

  test("a tie resolves to the earlier index (begins at the first pass)", () => {
    // Boat halfway between wp0 (lat 0) and wp1 (lat 1): equidistant → the earlier.
    expect(nearestWaypointIndex(P(0, 0.5), wps)).toBe(0);
  });

  test("an empty list has no nearest", () => {
    expect(nearestWaypointIndex(P(0, 0), [])).toBe(-1);
  });
});

describe("nearestLegTargetIndex (the closest-next join point, #RT-GONAV)", () => {
  // An L again: leg 0 runs east (lat 0), leg 1 runs north up 2°E. wpPoint flips
  // lon→lng, so `lon` is the easting here.
  const wps: Waypoint[] = [
    { id: "0", name: "", lat: 0, lon: 0 },
    { id: "1", name: "", lat: 0, lon: 2 },
    { id: "2", name: "", lat: 2, lon: 2 },
  ];

  test("targets the ARRIVAL waypoint of the leg the boat is beside, not the nearest waypoint", () => {
    // Boat just south of the MIDDLE of leg 0 (0,0)→(0,2): the nearest waypoint is
    // wp0 (behind), but the nearest LEG's arrival is wp1 (index 1) — steer forward.
    expect(nearestLegTargetIndex(P(1, -0.05), wps)).toBe(1);
    // Beside the middle of leg 1 (0,2)→(2,2): the arrival is wp2 (index 2).
    expect(nearestLegTargetIndex(P(2.05, 1), wps)).toBe(2);
  });

  test("short of the start (in the marina) targets point 1, not point 2 across the corner", () => {
    // 0.1° west of wp0, before leg 0 begins: steer to the start first.
    expect(nearestLegTargetIndex(P(-0.1, 0), wps)).toBe(0);
    // Off to the south-west of the start, still before it.
    expect(nearestLegTargetIndex(P(-0.05, -0.05), wps)).toBe(0);
  });

  test("on (or just by) point 1 the first LEG is the target, not the start itself", () => {
    expect(nearestLegTargetIndex(P(0, 0), wps)).toBe(1);
    // ~30 m short of wp0: inside the arrival radius → point 2.
    expect(nearestLegTargetIndex(P(-ARRIVAL_RADIUS_NM / 60 / 2, 0), wps)).toBe(1);
    // Just past the start, beside leg 0: point 2.
    expect(nearestLegTargetIndex(P(0.01, -0.05), wps)).toBe(1);
  });

  test("no fix edge cases: empty → -1, a lone waypoint (no leg) → 0", () => {
    expect(nearestLegTargetIndex(P(0, 0), [])).toBe(-1);
    expect(nearestLegTargetIndex(P(5, 5), [wps[0]])).toBe(0);
  });
});

describe("crossTrack", () => {
  test("a boat left of the track reads side L", () => {
    // Track east along the equator; boat north of it = to the left of A→B.
    const xt = crossTrack(P(0, 0), P(2, 0), P(1, 0.5));
    expect(xt.side).toBe("L");
    expect(xt.nm).toBeCloseTo(30, 0);
  });

  test("a boat right of the track reads side R", () => {
    const xt = crossTrack(P(0, 0), P(2, 0), P(1, -0.5));
    expect(xt.side).toBe("R");
  });

  test("a zero-length track (a === b) has no line: reads the range to the point, side R", () => {
    // Degenerate leg at the origin; the point 1° north (~60 nm). With no track to
    // be off, the magnitude is the plain range and the side is the fixed "R".
    const a = P(0, 0);
    const p = P(0, 1);
    const xt = crossTrack(a, a, p);
    expect(xt.side).toBe("R");
    expect(xt.nm).toBe(rangeNm(a, p));
    expect(xt.nm).toBeCloseTo(60, 0);
  });
});

describe("directRoute", () => {
  test("boat is waypoint 0, the point waypoint 1 named as the leg", () => {
    const { route, activeWaypointId } = directRoute(
      P(10, 55),
      P(11, 56),
      { route: "r", from: "a", to: "b" },
      "Buoy",
    );
    expect(route.id).toBe("r");
    expect(route.name).toBe("Buoy");
    expect(route.waypoints).toHaveLength(2);
    // `lon`, not `lng` — the wire shape (routes.ts).
    expect(route.waypoints[0]).toMatchObject({ id: "a", name: "Boat", lon: 10, lat: 55 });
    expect(route.waypoints[1]).toMatchObject({ id: "b", name: "Buoy", lon: 11, lat: 56 });
    // The destination is the leg (invariant #8).
    expect(activeWaypointId).toBe("b");
  });

  test("falls back to a default name when none/blank is given", () => {
    for (const name of [undefined, "  "]) {
      const { route } = directRoute(P(0, 0), P(1, 1), { route: "r", from: "a", to: "b" }, name);
      expect(route.name).toBe("Go here");
      expect(route.waypoints[1].name).toBe("Go here");
    }
  });
});

describe("Go to (straight line) and the overlay's data", () => {
  test("hasFix is true with a boat position", () =>
    createRoot((dispose) => {
      expect(harness().model.hasFix()).toBe(true);
      dispose();
    }));

  test("an approximate leg still renders as a warning with NO ephemeral signal at all — reload/reopen survival (#owqqcdqe)", () => {
    // The regression this exists to catch: the OLD ephemeral
    // `approximateLegs` signal only ever held the truth for the session
    // that planned the route — gone on reload, on reopening a saved
    // route, or just coming back later. `updateRouteData` must draw the
    // warning from each WAYPOINT's own persisted `approximate` field
    // instead, so this fake model deliberately supplies NO
    // `approximateLegs` method at all (not even one returning `[]`) —
    // if the overlay still secretly depended on it, this would throw
    // rather than silently pass.
    const route: Route = {
      id: "r",
      name: "Reef",
      waypoints: [
        { id: "a", name: "Boat", lat: 0, lon: 0, approximate: false },
        { id: "b", name: "Waypoint 1", lat: 1, lon: 0.5, approximate: true },
        { id: "c", name: "Reef", lat: 2, lon: 1, approximate: false },
      ],
      plan_speed_kn: 5,
      rev: 3,
      updated: 0,
    };
    const fakeModel = {
      route: () => route,
      activeWaypoint: () => null,
      editing: () => false,
      preview: () => null,
    } as unknown as Parameters<typeof updateRouteData>[1];

    let pushed: { properties: { kind: string } }[] = [];
    const fakeMap = {
      getSource: () => ({
        setData: (fc: { features: { properties: { kind: string } }[] }) => {
          pushed = fc.features;
        },
      }),
    };
    updateRouteData(fakeMap as unknown as Parameters<typeof updateRouteData>[0], fakeModel);

    const kinds = pushed.map((f) => f.properties.kind);
    expect(kinds).toContain("warn");
    expect(kinds).toContain("line");
  });

  test("updateRouteData keeps tracking route() (and every other model accessor) even on a run where the map source isn't ready yet — the frozen-map bug", async () => {
    // Live-caught, not hypothetical: a route editor whose SIDE PANEL kept
    // updating instantly (plain signal→DOM binding, unrelated to this
    // effect) while its own MAP never moved again after one run where
    // `map.getSource(...)` happened to return undefined (a style reload
    // that removes the source before `ensureRouteLayers` re-adds it) — a
    // full page reload was the only way to get it moving again. Root cause:
    // `updateRouteData` used to `return` on a missing source BEFORE reading
    // `model.route()` at all, so Solid never subscribed the caller's effect
    // to it on that run — and nothing else in the effect changes again to
    // re-trigger it. This test wraps the real function in a real
    // `createEffect` (a plain call wouldn't exercise Solid's dependency
    // tracking at all) and proves a LATER route change still reaches the
    // source once one exists, even though the FIRST run had none.
    //
    // Solid runs user effects DEFERRED, not synchronously on the signal
    // write (`core/chrome/useEnterExit.test.ts`'s own doc on this same
    // point) — each step below awaits a tick to let the effect queue drain
    // before asserting, the same pattern that file uses.
    return createRoot(async (dispose) => {
      const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
      const [route, setRoute] = createSignal<Route | null>(null);
      let sourceReady = false;
      let pushed: { properties: { kind: string } }[] | null = null;
      const fakeMap = {
        getSource: () =>
          sourceReady
            ? {
                setData: (fc: { features: { properties: { kind: string } }[] }) => {
                  pushed = fc.features;
                },
              }
            : undefined,
      };
      const fakeModel = {
        route,
        activeWaypoint: () => null,
        editing: () => false,
        preview: () => null,
      } as unknown as Parameters<typeof updateRouteData>[1];

      let runs = 0;
      createEffect(() => {
        runs++;
        updateRouteData(fakeMap as unknown as Parameters<typeof updateRouteData>[0], fakeModel);
      });
      await tick();

      // First run: no route yet AND no source yet — nothing to push, but
      // the effect must still have subscribed to `route()` regardless.
      expect(runs).toBe(1);
      expect(pushed).toBeNull();

      // The source becomes ready sometime later (the style finished
      // loading) — a separate concern (`wireOverlays`'s own `loaded()`
      // effect) triggers the re-run for that in the real app; this test
      // isolates the part that broke, below.
      sourceReady = true;

      // The route itself changes. If the old early return had starved this
      // effect of its subscription to `route()`, THIS would never fire and
      // `pushed` would stay null forever — exactly the frozen map.
      setRoute({
        id: "r",
        name: "Reef",
        waypoints: [
          { id: "a", name: "Boat", lat: 0, lon: 0, stop: true },
          { id: "b", name: "Reef", lat: 1, lon: 1, stop: true },
        ],
        plan_speed_kn: 5,
        rev: 1,
        updated: 0,
      });
      await tick();

      expect(runs).toBe(2);
      expect(pushed).not.toBeNull();
      expect(pushed!.map((f) => f.properties.kind)).toContain("line");
      dispose();
    });
  });

  test("updateRouteData draws a preview pin for previewFrom/previewTo before any real route exists", () => {
    const fakeModel = {
      route: () => null,
      activeWaypoint: () => null,
      previewFrom: () => ({ point: { lng: 1, lat: 2 }, label: "Boat" }),
      previewTo: () => ({ point: { lng: 3, lat: 4 }, label: "Fuel dock" }),
    } as unknown as Parameters<typeof updateRouteData>[1];
    let pushed: { properties: { kind: string; id?: string } }[] = [];
    const fakeMap = {
      getSource: () => ({
        setData: (fc: { features: typeof pushed }) => {
          pushed = fc.features;
        },
      }),
    };
    updateRouteData(fakeMap as unknown as Parameters<typeof updateRouteData>[0], fakeModel);
    const wpFeatures = pushed.filter((f) => f.properties.kind === "wp");
    expect(wpFeatures.map((f) => f.properties.id).sort()).toEqual(["preview-from", "preview-to"]);
  });
});

// `course` defaults to `null` — no SignalK course reported — so every
// existing caller keeps the old "purely local" behaviour; the target-mode
// tests below pass one explicitly to drive the yellow cue.
const fakeSignalK = (
  self: { lng: number; lat: number; sogMs?: number } | null,
  course: { nextLat: number; nextLng: number; prevLat?: number; prevLng?: number } | null = null,
): SignalKState => ({ self: () => self, course: () => course }) as unknown as SignalKState;

function fakeClient(): RoutesClient & {
  saved: Route[];
  activeCalls: (ActiveLeg | null)[];
  removed: { id: string; rev: number }[];
} {
  const [routes, setRoutes] = createSignal<Route[]>([]);
  const [active, setActive] = createSignal<ActiveLeg | null>(null);
  const saved: Route[] = [];
  const activeCalls: (ActiveLeg | null)[] = [];
  const removed: { id: string; rev: number }[] = [];
  return {
    routes,
    active,
    refresh: async () => {},
    save: async (r) => {
      const withRev = { ...r, rev: r.rev + 1 };
      saved.push(withRev);
      setRoutes((rs) => [withRev, ...rs.filter((x) => x.id !== r.id)]);
      return withRev;
    },
    remove: async (id, rev) => {
      removed.push({ id, rev });
      setRoutes((rs) => rs.filter((r) => r.id !== id));
    },
    setActive: async (leg) => {
      activeCalls.push(leg);
      setActive(leg);
    },
    saved,
    activeCalls,
    removed,
  };
}

function harness(mintIds = ["a", "b", "c", "d", "e"]) {
  let i = 0;
  const client = fakeClient();
  const notices: Notice[] = [];
  const built = createRoutes({
    signalk: fakeSignalK({ lng: 0, lat: 0, sogMs: 3 }),
    client,
    mintId: () => mintIds[i++] ?? `x${i}`,
    notify: (n) => notices.push(n),
  });
  return { ...built, client, notices };
}

// ── Reverse, undo, auto-save, and the whole-route metrics ───────────────────

const W = (id: string, lat: number, lon: number): Waypoint => ({ id, name: "", lat, lon });

describe("reverseWaypoints", () => {
  test("flips the order and keeps id/rev so a save overwrites", () => {
    const route: Route = {
      id: "R",
      name: "Passage",
      waypoints: [W("a", 0, 0), W("b", 1, 0), W("c", 2, 0)],
      plan_speed_kn: 5,
      rev: 3,
      updated: 5,
    };
    const rev = reverseWaypoints(route);
    expect(rev.waypoints.map((w) => w.id)).toEqual(["c", "b", "a"]);
    expect(rev.id).toBe("R");
    expect(rev.rev).toBe(3); // same identity → PUT overwrites, never forks
    // The source is untouched (pure).
    expect(route.waypoints.map((w) => w.id)).toEqual(["a", "b", "c"]);
  });
});

describe("reversedCopy", () => {
  test("fresh ids, reversed order, suffixed name; approximate moves with its leg", () => {
    const route: Route = {
      id: "R",
      name: "Passage",
      waypoints: [W("a", 0, 0), { ...W("b", 1, 0), approximate: true }, W("c", 2, 0)],
      plan_speed_kn: 6,
      rev: 3,
      updated: 5,
    };
    let i = 0;
    const copy = reversedCopy(route, () => `n${i++}`);
    expect(copy.id).toBe("n0");
    expect(copy.rev).toBe(0);
    expect(copy.name).toBe("Passage (reversed)");
    expect(copy.plan_speed_kn).toBe(6);
    expect(copy.waypoints.map((w) => [w.id, w.lat])).toEqual([
      ["n1", 2],
      ["n2", 1],
      ["n3", 0],
    ]);
    // Old leg a→b was approximate (flag on b); reversed it is b→a (flag on a).
    expect(copy.waypoints.map((w) => w.approximate ?? false)).toEqual([false, false, true]);
    expect(route.waypoints.map((w) => w.id)).toEqual(["a", "b", "c"]);
    // Reversing the copy drops the suffix instead of stacking it.
    expect(reversedCopy(copy, () => "z").name).toBe("Passage");
    // Long names stay within the store's 64.
    expect(reversedCopy({ ...route, name: "x".repeat(64) }, () => "z").name).toHaveLength(64);
    expect(reversedCopy({ ...route, name: "" }, () => "z").name).toBe("Route (reversed)");
  });
});

describe("routeMetrics", () => {
  const wps = [W("0", 0, 0), W("1", 1, 0), W("2", 2, 0)]; // a straight run north

  test("DTG sums every leg still ahead, not just the current one", () => {
    const m = routeMetrics({ lng: 0, lat: 0 }, wps, 1, 6);
    // dtw = boat→wp1 ≈ 60 nm; dtg = that plus wp1→wp2 ≈ 120 nm.
    expect(m.dtwNm).toBeCloseTo(60, 0);
    expect(m.dtgNm).toBeCloseTo(120, 0);
    expect(m.dtgNm).toBeCloseTo(m.dtwNm * 2, 0);
  });

  test("on the last leg DTG equals DTW — nothing is left beyond it", () => {
    const m = routeMetrics({ lng: 0, lat: 1 }, wps, 2, 6);
    expect(m.dtgNm).toBeCloseTo(m.dtwNm, 6);
  });

  test("TTG and ETA-seconds scale with speed, and are Infinity when becalmed", () => {
    const moving = routeMetrics({ lng: 0, lat: 0 }, wps, 1, 6);
    // ttgDest = dtg / sog; 120 nm at 6 kn = 20 h = 72000 s.
    expect(moving.ttgDestSec).toBeCloseTo((moving.dtgNm / 6) * 3600, 0);
    expect(moving.ttgSec).toBeCloseTo((moving.dtwNm / 6) * 3600, 0);
    const still = routeMetrics({ lng: 0, lat: 0 }, wps, 1, 0);
    expect(still.ttgSec).toBe(Infinity);
    expect(still.ttgDestSec).toBe(Infinity);
  });

  test("XTE is null at the first waypoint — no prior leg to be off of", () => {
    // activeIndex 0 has no waypoints[-1], so there is no track: xte is null.
    expect(routeMetrics({ lng: 0, lat: 0 }, wps, 0, 6).xte).toBeNull();
    // From the second waypoint on there IS a prior leg, so xte is a reading.
    expect(routeMetrics({ lng: 0, lat: 0 }, wps, 1, 6).xte).not.toBeNull();
  });
});

describe("planRouteMetrics (at rest, no fix, no leg)", () => {
  // A three-waypoint route running due north: two legs, each ~1° of latitude.
  // 1° of latitude ≈ 60 nm, so total ≈ 120 nm; at 6 kn that is 20 h.
  const wps = [W("0", 0, 0), W("1", 1, 0), W("2", 2, 0)];

  test("per-leg distance, bearing and cumulative time from the planning speed", () => {
    const plan = planRouteMetrics(wps, 6);
    expect(plan.legs).toHaveLength(2);

    const [a, b] = plan.legs;
    expect(a.fromIndex).toBe(0);
    expect(a.toIndex).toBe(1);
    expect(a.distNm).toBeCloseTo(60, 0);
    expect(a.brgDeg).toBeCloseTo(0, 0); // due north
    // 60 nm at 6 kn = 10 h = 36000 s.
    expect(a.timeSec).toBeCloseTo(36000, 0);
    expect(a.cumulativeNm).toBeCloseTo(60, 0);
    expect(a.cumulativeSec).toBeCloseTo(36000, 0);

    // The second leg's cumulative values are the whole route.
    expect(b.distNm).toBeCloseTo(60, 0);
    expect(b.cumulativeNm).toBeCloseTo(120, 0);
    expect(b.cumulativeSec).toBeCloseTo(72000, 0);
  });

  test("totals are the sum of the legs / the last leg's cumulative values", () => {
    const plan = planRouteMetrics(wps, 6);
    expect(plan.totalNm).toBeCloseTo(120, 0);
    expect(plan.totalSec).toBeCloseTo(72000, 0);
    const last = plan.legs.at(-1)!;
    expect(plan.totalNm).toBeCloseTo(last.cumulativeNm, 6);
    expect(plan.totalSec).toBeCloseTo(last.cumulativeSec, 6);
  });

  test("time scales inversely with speed", () => {
    const slow = planRouteMetrics(wps, 3);
    const fast = planRouteMetrics(wps, 6);
    expect(slow.totalSec).toBeCloseTo(fast.totalSec * 2, 0);
    expect(slow.totalNm).toBeCloseTo(fast.totalNm, 6); // distance is speed-free
  });

  test("a non-positive speed yields Infinite times but real distances", () => {
    const plan = planRouteMetrics(wps, 0);
    expect(plan.totalNm).toBeCloseTo(120, 0);
    expect(plan.totalSec).toBe(Infinity);
    expect(plan.legs[0].timeSec).toBe(Infinity);
  });

  test("fewer than two waypoints has no leg and zero totals", () => {
    for (const w of [[], [W("0", 0, 0)]]) {
      const plan = planRouteMetrics(w, 6);
      expect(plan.legs).toHaveLength(0);
      expect(plan.totalNm).toBe(0);
      expect(plan.totalSec).toBe(0);
    }
  });

  test("defaults the planning speed when none is given", () => {
    // Same route measured explicitly at the default vs. implicitly.
    expect(planRouteMetrics(wps).totalSec).toBeCloseTo(planRouteMetrics(wps, 5).totalSec, 6);
  });
});

describe("route management (the list)", () => {
  const route = (id: string, rev = 1): Route => ({
    id,
    name: id,
    waypoints: [W("a", 0, 0), W("b", 1, 0)],
    plan_speed_kn: 5,
    rev,
    updated: 0,
  });

  test("reverseRoute saves a reversed COPY and leaves the original alone", async () => {
    await createRoot(async (dispose) => {
      const h = harness(["n", "w1", "w2"]);
      const original = route("R", 4);
      const saved = await h.model.reverseRoute(original);
      expect(h.client.saved).toHaveLength(1);
      const copy = h.client.saved[0];
      expect(saved).toEqual(copy);
      expect(copy.id).toBe("n");
      expect(copy.rev).toBe(1); // a create (rev 0 → no If-Match), not an overwrite
      expect(copy.name).toBe("R (reversed)");
      expect(copy.waypoints.map((w) => [w.id, w.lat])).toEqual([
        ["w1", 1],
        ["w2", 0],
      ]);
      expect(original.waypoints.map((w) => w.id)).toEqual(["a", "b"]);
      expect(h.notices.at(-1)).toMatchObject({ id: "route-reversed", title: "Reversed copy saved" });
      dispose();
    });
  });

  test("reverseRoute offers to open the copy in the manual editor", async () => {
    await createRoot(async (dispose) => {
      const notices: Notice[] = [];
      const opened: Route[] = [];
      const built = createRoutes({
        signalk: fakeSignalK({ lng: 0, lat: 0, sogMs: 3 }),
        client: fakeClient(),
        mintId: (() => {
          let i = 0;
          return () => `m${i++}`;
        })(),
        notify: (n) => notices.push(n),
        editPoints: (r) => opened.push(r),
      });
      const saved = await built.model.reverseRoute(route("R", 4));
      notices.at(-1)!.action!.run();
      expect(opened).toEqual([saved!]);
      dispose();
    });
  });

  test("importGpx saves each route and reports what it skipped", async () => {
    await createRoot(async (dispose) => {
      const notices: Notice[] = [];
      const client = fakeClient();
      const built = createRoutes({
        signalk: fakeSignalK({ lng: 0, lat: 0, sogMs: 3 }),
        client,
        mintId: (() => {
          let i = 0;
          return () => `m${i++}`;
        })(),
        notify: (n) => notices.push(n),
        parseXml: testXmlParse,
      });
      const saved = await built.model.importGpx(
        `<gpx><rte><name>One</name><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte><rte><name>Bad</name><rtept lat="x" lon="2"/></rte><wpt lat="1" lon="1"/></gpx>`,
        "t.gpx",
      );
      expect(saved.map((r) => r.name)).toEqual(["One"]);
      expect(client.saved).toHaveLength(1);
      expect(notices.at(-1)).toMatchObject({ id: "route-import", title: "Imported 1 route" });
      expect(notices.at(-1)!.detail).toContain("1 skipped");
      expect(notices.at(-1)!.detail).toContain("“Bad”");
      // The same file again: nothing new, and it says why.
      const again = await built.model.importGpx(
        `<gpx><rte><name>One</name><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte></gpx>`,
        "t.gpx",
      );
      expect(again).toEqual([]);
      expect(client.saved).toHaveLength(1);
      expect(notices.at(-1)!.detail).toContain("already imported");
      await built.model.importGpx("<nope", "t.gpx");
      expect(notices.at(-1)).toMatchObject({ title: "GPX import failed", detail: "This file is not valid XML." });
      dispose();
    });
  });

  test("removeRoute deletes by id and rev", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      await h.model.removeRoute(route("R", 7));
      expect(h.client.removed).toEqual([{ id: "R", rev: 7 }]);
      dispose();
    });
  });

  test("a failed delete / stop is said, not swallowed", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.client.remove = async () => {
        throw new Error("DELETE route → 500");
      };
      h.client.setActive = async () => {
        throw new Error("PUT active → 502");
      };
      await h.model.removeRoute(route("R", 7));
      expect(h.notices.at(-1)).toMatchObject({ id: "route-delete-failed", title: "Couldn’t delete R" });
      await h.model.stopFollowing();
      expect(h.notices.at(-1)).toMatchObject({ id: "route-stop-failed", title: "Couldn’t stop following" });
      dispose();
    });
  });
});

describe("Route complete — only on an arrival, never a Stop/delete", () => {
  // Following the final leg into wp1 at (1°N, 0); the boat's fix is settable.
  async function finalLeg(boat: { lng: number; lat: number }) {
    const [self, setSelf] = createSignal<{ lng: number; lat: number; sogMs?: number }>({ ...boat, sogMs: 3 });
    const client = fakeClient();
    const arrivals: string[] = [];
    const built = createRoutes({
      signalk: { self, course: () => null } as unknown as SignalKState,
      client,
      onArrival: (n) => arrivals.push(n.title),
    });
    const r: Route = { id: "R", name: "P", waypoints: [W("0", 0, 0), W("1", 1, 0)], plan_speed_kn: 5, rev: 0, updated: 0 };
    await client.save(r);
    await client.setActive({ route_id: "R", waypoint_id: "1" });
    return { built, client, arrivals, setSelf, route: client.routes()[0]! };
  }

  test("Stop following on the final leg, even at the mark, says nothing", async () => {
    await createRoot(async (dispose) => {
      const h = await finalLeg({ lng: 0, lat: 0.999 });
      await h.built.model.stopFollowing();
      expect(h.arrivals).toEqual([]);
      dispose();
    });
  });

  test("deleting the followed route on the final leg says nothing", async () => {
    await createRoot(async (dispose) => {
      const h = await finalLeg({ lng: 0, lat: 0.999 });
      await h.built.model.removeRoute(h.route);
      expect(h.arrivals).toEqual([]);
      dispose();
    });
  });

  test("the leg ending elsewhere (the watcher) with the boat at the mark is complete", async () => {
    await createRoot(async (dispose) => {
      const h = await finalLeg({ lng: 0, lat: 0.999 });
      await h.client.setActive(null); // as the server clearing it, not this screen's Stop
      expect(h.arrivals).toEqual(["Route complete"]);
      dispose();
    });
  });

  test("the leg ending elsewhere far from the mark is not complete", async () => {
    await createRoot(async (dispose) => {
      const h = await finalLeg({ lng: 0, lat: 0.5 });
      await h.client.setActive(null);
      expect(h.arrivals).toEqual([]);
      dispose();
    });
  });
});

describe("formatEta (band.top / info card ETA)", () => {
  const now = new Date(2026, 10, 13, 10, 0).getTime(); // Fri 13 Nov 10:00 local
  test("today reads as a bare clock", () => {
    expect(formatEta(2 * 3600, now)).toBe("12:00");
  });
  test("a 30 h passage names the day, not today's clock", () => {
    expect(formatEta(30 * 3600, now)).toBe("Sat 16:00");
  });
  test("no ETA when becalmed", () => {
    expect(formatEta(Infinity, now)).toBe("– –:– –");
  });
});

// ── The followed strip's time pair (TTW/TTD) and the steer-to line ───────────
//
// Both read the SAME live follow state — a fix plus a persisted active leg — so
// a small helper puts a three-waypoint run north on the boat and follows its
// second waypoint (index 1), then drives the instrument reads and the model's
// steer-line memo.

const CTX: ReadCtx = { density: DESK } as ReadCtx;

/** A harness following a straight run north (wp0/1/2 at 0/1/2°N up 0°E), steering
 * the leg into waypoint 1, with the boat's fix at (0,0) and SOG 3 kn (harness). */
async function followingHarness() {
  const h = harness();
  const wps = [W("0", 0, 0), W("1", 1, 0), W("2", 2, 0)];
  const route: Route = { id: "R", name: "Passage", waypoints: wps, plan_speed_kn: 5, rev: 0, updated: 0 };
  await h.client.save(route);
  await h.client.setActive({ route_id: "R", waypoint_id: "1" });
  const instrument = (id: string) => h.feature.core.instruments.find((i) => i.id === id)!;
  return { ...h, instrument };
}

describe("the followed time pair (TTW / TTD)", () => {
  test("TTW keeps its old short label renamed, TTD is the new one", () => {
    const h = harness();
    const ttw = h.feature.core.instruments.find((i) => i.id === "route.ttg")!;
    const ttd = h.feature.core.instruments.find((i) => i.id === "route.ttd")!;
    expect(ttw.short).toBe("TTW");
    expect(ttw.label).toBe("Time to waypoint");
    expect(ttd.short).toBe("TTD");
    expect(ttd.label).toBe("Time to destination");
    // TTD rides the same conditional strip as the rest of the followed band.
    expect(ttd.band).toBe("top");
  });

  test("TTW reads the leg time, TTD the whole-passage time, while following", async () => {
    await createRoot(async (dispose) => {
      const h = await followingHarness();
      // The model reads SOG from the fix in m/s (harness sogMs: 3) and converts;
      // mirror that so the expected duration matches what the instrument shows.
      const m = routeMetrics({ lng: 0, lat: 0 }, h.model.route()!.waypoints, 1, knotsFromMs(3));
      expect(h.instrument("route.ttg").read(CTX).value).toBe(formatDuration(m.ttgSec));
      expect(h.instrument("route.ttd").read(CTX).value).toBe(formatDuration(m.ttgDestSec));
      // TTD (whole passage) is longer than TTW (this leg) — the two are distinct.
      expect(m.ttgDestSec).toBeGreaterThan(m.ttgSec);
      dispose();
    });
  });

  test("TTD reads the null placeholder when not following", () =>
    createRoot((dispose) => {
      const h = harness();
      const ttd = h.feature.core.instruments.find((i) => i.id === "route.ttd")!;
      const r = ttd.read(CTX);
      expect(r.state).toBe("null");
      dispose();
    }));
});

/** Like `followingHarness`, but the boat fix and the active waypoint are the
 * test's choice — used to drive `steerLine` on and off the leg, and at the
 * route's first waypoint (no previous leg to project onto). Same straight-north
 * route (wp0/1/2 at 0/1/2°N up 0°E) as `followingHarness`. */
async function followingHarnessAt(self: { lng: number; lat: number }, activeWaypointId: string) {
  let i = 0;
  const client = fakeClient();
  const built = createRoutes({
    signalk: fakeSignalK({ ...self, sogMs: 3 }),
    client,
    mintId: () => `x${i++}`,
  });
  const wps = [W("0", 0, 0), W("1", 1, 0), W("2", 2, 0)];
  const route: Route = { id: "R", name: "Passage", waypoints: wps, plan_speed_kn: 5, rev: 0, updated: 0 };
  await client.save(route);
  await client.setActive({ route_id: "R", waypoint_id: activeWaypointId });
  return built;
}

describe("the steer-to (rejoin) line", () => {
  test("null when not following", () =>
    createRoot((dispose) => {
      expect(harness().model.steerLine()).toBeNull();
      dispose();
    }));

  test("boat OFF the leg → the return point is the perpendicular foot, not the waypoint", async () => {
    await createRoot(async (dispose) => {
      // Leg wp0(0,0)→wp1(1,0) runs along lng 0; the boat at (0.5, 0.5) is off to
      // the east of it. The foot of its perpendicular is back on the leg at
      // (0, 0.5) — distinct from the active waypoint at (0, 1).
      const h = await followingHarnessAt({ lng: 0.5, lat: 0.5 }, "1");
      const line = h.model.steerLine()!;
      expect(line).not.toBeNull();
      expect(line.from).toEqual({ lng: 0.5, lat: 0.5 });
      expect(line.to.lng).toBeCloseTo(0, 6);
      expect(line.to.lat).toBeCloseTo(0.5, 6);
      expect(line.to).not.toEqual({ lng: 0, lat: 1 }); // not the waypoint
      dispose();
    });
  });

  test("boat ON the leg → the line is zero-length (already at the return point)", async () => {
    await createRoot(async (dispose) => {
      // (0, 0.5) sits exactly on the wp0(0,0)→wp1(1,0) leg, so the projected foot
      // is the boat itself.
      const h = await followingHarnessAt({ lng: 0, lat: 0.5 }, "1");
      const line = h.model.steerLine()!;
      expect(line.to).toEqual(line.from);
      dispose();
    });
  });

  test("active waypoint is the route's first point → no leg, falls back to the waypoint", async () => {
    await createRoot(async (dispose) => {
      const h = await followingHarnessAt({ lng: 5, lat: 5 }, "0");
      const line = h.model.steerLine()!;
      expect(line.from).toEqual({ lng: 5, lat: 5 });
      expect(line.to).toEqual({ lng: 0, lat: 0 }); // wpPoint(wp0) — leg().from is null
      dispose();
    });
  });

  test("goes null again when following stops", async () => {
    await createRoot(async (dispose) => {
      const h = await followingHarness();
      expect(h.model.steerLine()).not.toBeNull();
      await h.client.setActive(null);
      expect(h.model.steerLine()).toBeNull();
      dispose();
    });
  });
});

// ── THE YELLOW STEERING CUE, from SignalK truth (#RF-NAVMODE / qmrnxuns) ────
//
// `targetLine` used to come from mivnav's own local active-leg `mode`: "line"
// showed the dashed rejoin `steerLine`, "target" showed a yellow boat→
// waypoint line instead. That showed mivnav's INTENT, not the boat's ACTUAL
// course — wrong the moment another client (a second cockpit screen, or
// pypilot itself) set the course. Now `targetLine` reads `signalk.course()`
// directly (the v2 Course API's `nextPoint`, mirrored server-side): it draws
// whenever SignalK reports a course and there is a fix, independent of the
// local leg's `mode` — indeed independent of there being a local followed leg
// at all — and `steerLine` (the local rejoin cue) is suppressed exactly when
// it does. These pin which geometry each SOURCE produces — the pixels are
// browser-verified, the decision is here.

/** Like `followingHarnessAt`, but SignalK also reports an active course
 * (`courseNext`), independent of the local leg's `mode`. Same straight-north
 * route (wp0/1/2 at lat 0/1/2, lon 0). */
async function followingHarnessCourse(
  self: { lng: number; lat: number },
  activeWaypointId: string,
  courseNext: { nextLat: number; nextLng: number; prevLat?: number; prevLng?: number } | null,
) {
  let i = 0;
  const client = fakeClient();
  const built = createRoutes({
    signalk: fakeSignalK({ ...self, sogMs: 3 }, courseNext),
    client,
    mintId: () => `x${i++}`,
  });
  const wps = [W("0", 0, 0), W("1", 1, 0), W("2", 2, 0)];
  const route: Route = { id: "R", name: "Passage", waypoints: wps, plan_speed_kn: 5, rev: 0, updated: 0 };
  await client.save(route);
  await client.setActive({ route_id: "R", waypoint_id: activeWaypointId });
  return built;
}

describe("the yellow steering cue reads SignalK's course, not local state (#RF-NAVMODE)", () => {
  test("targetLine is null when not following and SignalK reports no course", () =>
    createRoot((dispose) => {
      const h = harness();
      expect(h.model.targetLine()).toBeNull();
      dispose();
    }));

  test("no SignalK course: the dashed local steer line stays, no yellow line", async () => {
    await createRoot(async (dispose) => {
      const h = await followingHarnessCourse({ lng: 0.5, lat: 0.5 }, "1", null);
      expect(h.model.steerLine()).not.toBeNull(); // local rejoin cue unchanged
      expect(h.model.targetLine()).toBeNull(); // nothing for SignalK to report
      dispose();
    });
  });

  test("SignalK reports a course with no previousPoint yet: yellow line falls back to boat → next point, not any local waypoint", async () => {
    await createRoot(async (dispose) => {
      // wp1 (the LOCAL active leg's target) sits at (0, 1); SignalK's course
      // points somewhere else entirely (2, 3) — the yellow line must follow
      // SignalK, proving it is decoupled from the local route's geometry.
      // No prevLat/prevLng: this exercises the fallback-to-boat-fix case.
      const h = await followingHarnessCourse({ lng: 0.5, lat: 0.5 }, "1", { nextLat: 3, nextLng: 2 });
      const line = h.model.targetLine()!;
      expect(line).not.toBeNull();
      expect(line.from).toEqual({ lng: 0.5, lat: 0.5 }); // fallback: the boat's live fix
      expect(line.to).toEqual({ lng: 2, lat: 3 }); // SignalK's nextPoint, NOT wpPoint(wp1)
      dispose();
    });
  });

  test("SignalK reports both previousPoint and nextPoint: yellow line is the fixed course, not the boat's fix", async () => {
    await createRoot(async (dispose) => {
      const h = await followingHarnessCourse({ lng: 0.5, lat: 0.5 }, "1", {
        prevLat: 5,
        prevLng: 4,
        nextLat: 3,
        nextLng: 2,
      });
      const line = h.model.targetLine()!;
      expect(line).not.toBeNull();
      expect(line.from).toEqual({ lng: 4, lat: 5 }); // SignalK's previousPoint, NOT the boat's fix
      expect(line.to).toEqual({ lng: 2, lat: 3 });
      dispose();
    });
  });

  test("a reported course suppresses the local dashed steer line", async () => {
    await createRoot(async (dispose) => {
      const h = await followingHarnessCourse({ lng: 0.5, lat: 0.5 }, "1", { nextLat: 1, nextLng: 0 });
      expect(h.model.steerLine()).toBeNull(); // replaced by the yellow target line
      dispose();
    });
  });

  test("SignalK's course draws even with no local followed leg at all", async () => {
    await createRoot(async (dispose) => {
      // No client.setActive at all: mivnav is following nothing locally, but
      // some other client set a course on the boat's SignalK box — the "no
      // matter who set it" requirement means the yellow line must still show.
      const client = fakeClient();
      const built = createRoutes({
        signalk: fakeSignalK({ lng: 0.5, lat: 0.5, sogMs: 3 }, { nextLat: 1, nextLng: 0 }),
        client,
      });
      expect(built.model.following()).toBe(false);
      const line = built.model.targetLine()!;
      expect(line).not.toBeNull();
      expect(line.to).toEqual({ lng: 0, lat: 1 });
      dispose();
    });
  });

  test("no previousPoint yet: the yellow line's START falls back to the boat and follows it as it moves", async () => {
    await createRoot(async (dispose) => {
      const [self, setSelf] = createSignal<{ lng: number; lat: number; sogMs?: number }>({
        lng: 0.5,
        lat: 0.5,
        sogMs: 3,
      });
      const client = fakeClient();
      const built = createRoutes({
        signalk: { self, course: () => ({ nextLat: 1, nextLng: 0 }) } as unknown as SignalKState,
        client,
      });
      expect(built.model.targetLine()!.from).toEqual({ lng: 0.5, lat: 0.5 });
      // The boat moves — the memo re-runs and the fallback line's start tracks it.
      setSelf({ lng: 0.8, lat: 0.9, sogMs: 3 });
      expect(built.model.targetLine()!.from).toEqual({ lng: 0.8, lat: 0.9 });
      expect(built.model.targetLine()!.to).toEqual({ lng: 0, lat: 1 }); // target unchanged
      dispose();
    });
  });

  test("previousPoint reported: the yellow line's START is the fixed course origin, NOT the boat — it does not follow the boat", async () => {
    await createRoot(async (dispose) => {
      const [self, setSelf] = createSignal<{ lng: number; lat: number; sogMs?: number }>({
        lng: 0.5,
        lat: 0.5,
        sogMs: 3,
      });
      const client = fakeClient();
      const built = createRoutes({
        signalk: {
          self,
          course: () => ({ prevLat: 0.1, prevLng: 0.2, nextLat: 1, nextLng: 0 }),
        } as unknown as SignalKState,
        client,
      });
      expect(built.model.targetLine()!.from).toEqual({ lng: 0.2, lat: 0.1 });
      // The boat moves — the course line is fixed for the leg and must NOT track it.
      setSelf({ lng: 0.8, lat: 0.9, sogMs: 3 });
      expect(built.model.targetLine()!.from).toEqual({ lng: 0.2, lat: 0.1 });
      expect(built.model.targetLine()!.to).toEqual({ lng: 0, lat: 1 });
      dispose();
    });
  });
});

// Regression: the boat runs over plain HTTP off localhost, a NON-secure context
// where `crypto.randomUUID` is undefined. The default id-minter must not depend
// on it, or entering the editor throws and the sheet never opens (#RT-CRYPTO).
describe("id-minting works in a non-secure context (no crypto.randomUUID)", () => {
  // Simulate the boat's plain-HTTP origin: randomUUID gone, getRandomValues kept.
  function withoutRandomUUID<T>(fn: () => T): T {
    const orig = globalThis.crypto.randomUUID;
    (globalThis.crypto as { randomUUID?: unknown }).randomUUID = undefined;
    try {
      return fn();
    } finally {
      (globalThis.crypto as { randomUUID?: unknown }).randomUUID = orig;
    }
  }

  test("mintUuid returns unique non-empty strings without randomUUID", () =>
    withoutRandomUUID(() => {
      const a = mintUuid();
      const b = mintUuid();
      expect(a).toBeTruthy();
      expect(typeof a).toBe("string");
      expect(a).not.toBe(b); // two mints differ
    }));
});

// The two seams the autorouting plugin plugs into: the overlay's edit session
// and the route planner registry.
describe("attachEditor (the overlay's edit session)", () => {
  test("the attached editor's draft is drawn instead of the followed route, until detached", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      const followed: Route = { id: "F", name: "F", waypoints: [W("f1", 0, 0), W("f2", 1, 0)], plan_speed_kn: 5, rev: 0, updated: 0 };
      await h.client.save(followed);
      await h.client.setActive({ route_id: "F", waypoint_id: "f2" });
      expect(h.model.route()?.id).toBe("F");
      expect(h.model.editing()).toBe(false);

      const [draft, setDraft] = createSignal<Route | null>(null);
      const moved: string[] = [];
      const detach = h.model.attachEditor({
        draft,
        previewFrom: () => null,
        previewTo: () => null,
        flashLeg: () => 2,
        moveWaypoint: (id) => moved.push(id),
        beginWaypointDrag: () => {},
        endWaypointDrag: () => {},
        abortDrag: () => {},
      });
      // Attached but closed: still the followed route.
      expect(h.model.route()?.id).toBe("F");
      setDraft({ ...followed, id: "D" });
      expect(h.model.route()?.id).toBe("D");
      expect(h.model.editing()).toBe(true);
      expect(h.model.flashLeg()).toBe(2);
      h.model.moveWaypoint("f1", { lng: 1, lat: 1 });
      expect(moved).toEqual(["f1"]);

      detach();
      expect(h.model.route()?.id).toBe("F");
      expect(h.model.editing()).toBe(false);
      expect(h.model.flashLeg()).toBeNull();
      dispose();
    });
  });
});

describe("the route planner registry", () => {
  test("registers, is read reactively, and un-registers only itself", () => {
    const planner = { goTo: async () => true, editRoute: () => {}, newRoute: () => {} };
    const other = { ...planner };
    expect(routePlanner()).toBeNull();
    const off = registerRoutePlanner(planner);
    expect(routePlanner()).toBe(planner);
    const offOther = registerRoutePlanner(other);
    off(); // no longer the registered one: a no-op
    expect(routePlanner()).toBe(other);
    offOther();
    expect(routePlanner()).toBeNull();
  });

  test("the route card's Edit route goes to the planner while one is registered", async () => {
    await createRoot(async (dispose) => {
      const edited: Route[] = [];
      const h = harness();
      const r: Route = { id: "R", name: "R", waypoints: [W("a", 0, 0), W("b", 1, 0)], plan_speed_kn: 5, rev: 0, updated: 0 };
      const hit = { providerId: "routes", id: "R", priority: "regulated", precision: "line", title: "R", payload: r } as const;
      const labels = () =>
        (h.feature.provider!.detail!(hit as never) as { actions: { label: string; run: () => void }[] }).actions;
      expect(labels().some((a) => a.label === "Edit route")).toBe(false);
      const off = registerRoutePlanner({ goTo: async () => true, editRoute: (x) => edited.push(x), newRoute: () => {} });
      try {
        labels().find((a) => a.label === "Edit route")!.run();
        expect(edited).toEqual([r]);
      } finally {
        off();
      }
      dispose();
    });
  });
});

describe("showRoute — a saved route drawn without following it", () => {
  const mk = (id: string): Route => ({
    id,
    name: id,
    waypoints: [W(`${id}1`, 0, 0), W(`${id}2`, 1, 0)],
    plan_speed_kn: 5,
    rev: 0,
    updated: 0,
  });

  test("shows it, tracks edits by id, drops it on delete", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      const a = await h.client.save(mk("A"));
      expect(h.model.route()).toBeNull();
      h.model.showRoute(a);
      expect(h.model.route()?.id).toBe("A");
      expect(h.model.viewedRouteId()).toBe("A");
      await h.client.save({ ...a, name: "renamed" });
      expect(h.model.route()?.name).toBe("renamed");
      await h.model.removeRoute(h.client.routes()[0]!);
      expect(h.model.route()).toBeNull();
      expect(h.model.viewedRouteId()).toBeNull();
      dispose();
    });
  });

  test("the followed route wins, and starting a follow clears the viewed one", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      const a = await h.client.save(mk("A"));
      const b = await h.client.save(mk("B"));
      h.model.showRoute(a);
      await h.client.setActive({ route_id: b.id, waypoint_id: "B2" });
      expect(h.model.route()?.id).toBe("B");
      expect(h.model.viewedRouteId()).toBeNull();
      await h.client.setActive(null);
      expect(h.model.route()).toBeNull();
      dispose();
    });
  });

  test("showRoute(null) hides it", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.model.showRoute(await h.client.save(mk("A")));
      h.model.showRoute(null);
      expect(h.model.route()).toBeNull();
      dispose();
    });
  });
});
