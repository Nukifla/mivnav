// The route editor's pure geometry (projecting a click onto a leg, choosing
// the insert index — still used by `nearestLegTargetIndex`) and the
// From/Stop/To autorouting engine: setStop/insertStop/removeStop/
// reorderStops, all driven through `core/routing.ts`'s `planRoute`.
//
// No DOM, no map. A tap reaches the mode as plain numbers (`ModeClick`), so
// the whole of the interaction is drivable with a fake routes client and a
// fake `/api/routing/plan` fetch.

import { createEffect, createRoot } from "solid-js";
import { describe, expect, test } from "bun:test";
import { knotsFromMs } from "../../core/cpa";
import { createSignal } from "solid-js";
import { RouteSaveError, type ActiveLeg, type Route, type RoutesClient, type Waypoint } from "../../core/routes";
import type { Notice } from "../../core/chrome/notices";
import type { SignalKState } from "../../core/signalk";
import type { PlanFetch } from "../../core/routing";
import { type GeoPoint, rangeNm } from "../../core/chrome/geo";
import { formatDuration } from "../../core/format";
import { formatCoordinate } from "../../core/coordinate";
import type { ModeClick } from "../../core/chrome/modes";
import { DESK, type ReadCtx } from "../../core/chrome/registry";
import {
  arrivalEvent,
  createRoutes,
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
  routeFromPlan,
  routeMetrics,
} from "./index";
import { routeCommands } from "./commands";
import { updateRouteData } from "./overlay";
import type { CommandDeps } from "../../core/chrome/commands";
import { testXmlParse } from "./testXml";

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

  test("following ending from the LAST waypoint completes the route", () => {
    // Was steering the final leg (index 2 of 3), now not following → complete.
    expect(arrivalEvent(at(2, 3), null)).toEqual({ kind: "complete" });
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

describe("go-here (the pressed-point action)", () => {
  test("builds a boat→point route, saves it, and follows the point", async () => {
    await createRoot(async (dispose) => {
      const h = harness(); // fix at (0, 0)
      const ok = await h.model.goTo(P(2, 3), "Wreck");
      expect(ok).toBe(true);
      expect(h.client.saved).toHaveLength(1);
      const saved = h.client.saved[0];
      expect(saved.waypoints[0]).toMatchObject({ name: "Boat", lon: 0, lat: 0 });
      expect(saved.waypoints[1]).toMatchObject({ name: "Wreck", lon: 2, lat: 3 });
      expect(h.client.activeCalls.at(-1)).toEqual({
        route_id: saved.id,
        waypoint_id: saved.waypoints[1].id,
      });
      dispose();
    });
  });

  test("repeated Go here REUSES one ephemeral route, not a fresh one each tap", async () => {
    await createRoot(async (dispose) => {
      const h = harness(); // fix at (0, 0)
      await h.model.goTo(P(2, 3), "Wreck");
      await h.model.goTo(P(4, 5), "Buoy");
      // Both saves went to the SAME id (overwrite), so the list holds one
      // go-here route, not two orphans — the second tap's destination.
      const goHere = h.client.routes().filter((r) => r.id === GO_HERE_ROUTE_ID);
      expect(goHere).toHaveLength(1);
      expect(goHere[0].waypoints[1]).toMatchObject({ name: "Buoy", lon: 4, lat: 5 });
      // The second save echoed the first's rev as If-Match (rev bumped to 2 by
      // the fake), proving it overwrote rather than created.
      expect(h.client.saved).toHaveLength(2);
      expect(h.client.saved.every((r) => r.id === GO_HERE_ROUTE_ID)).toBe(true);
      // Following now points at the latest go-here destination.
      expect(h.client.activeCalls.at(-1)?.route_id).toBe(GO_HERE_ROUTE_ID);
      dispose();
    });
  });

  test("hasFix is true with a boat position", () =>
    createRoot((dispose) => {
      expect(harness().model.hasFix()).toBe(true);
      dispose();
    }));

  test("no fix → no route built, no leg set, resolves false", async () => {
    await createRoot(async (dispose) => {
      const client = fakeClient();
      const built = createRoutes({ signalk: fakeSignalK(null), client, mintId: () => "x" });
      expect(built.model.hasFix()).toBe(false);
      const ok = await built.model.goTo(P(2, 3));
      expect(ok).toBe(false);
      expect(client.saved).toHaveLength(0);
      expect(client.activeCalls).toHaveLength(0);
      dispose();
    });
  });

  test("a real hazard-avoiding plan (a bent path) saves EVERY waypoint the router returned, named in order", async () => {
    await createRoot(async (dispose) => {
      const h = harness(
        ["a", "b", "c"],
        fixedPlanFetch({
          waypoints: [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 0.5 },
            { lat: 2, lon: 1 },
          ],
          distance_nm: 12,
          warnings: [STANDING_CAVEAT],
          approximate_legs: [false, false],
        }),
      );
      const ok = await h.model.goTo(P(1, 2), "Marina");
      expect(ok).toBe(true);
      const saved = h.client.saved[0];
      expect(saved.waypoints).toHaveLength(3);
      expect(saved.waypoints[0]).toMatchObject({ id: "a", name: "Boat", lon: 0, lat: 0 });
      expect(saved.waypoints[1]).toMatchObject({ id: "b", name: "Waypoint 1", lon: 0.5, lat: 1 });
      expect(saved.waypoints[2]).toMatchObject({ id: "c", name: "Marina", lon: 1, lat: 2 });
      // The LEG is the destination, not the last-minted id by coincidence.
      expect(h.client.activeCalls.at(-1)).toEqual({
        route_id: saved.id,
        waypoint_id: saved.waypoints[2].id,
      });
      // A real route was found — no "couldn't avoid a hazard" notice.
      expect(h.notices).toHaveLength(0);
      dispose();
    });
  });

  test("the router couldn't avoid a hazard — still routes, but surfaces why", async () => {
    await createRoot(async (dispose) => {
      const h = harness(
        ["a", "b"],
        fixedPlanFetch({
          waypoints: [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 1 },
          ],
          distance_nm: 5,
          warnings: [
            "destination 1.0000, 1.0000 is itself inside charted danger " +
              "(draft 2.0m + 1.0m keel margin, 30m clearance) — routed as close " +
              "as possible, then a straight line for the rest",
            STANDING_CAVEAT,
          ],
          approximate_legs: [true],
        }),
      );
      const ok = await h.model.goTo(P(1, 1));
      expect(ok).toBe(true); // still builds and follows SOMETHING
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0].title).toContain("charted danger");
      expect(h.notices[0].detail).toContain("is itself inside charted danger");
      dispose();
    });
  });

  test("an approximate END run actually reaches the map — the active-leg highlight must not paint over it", async () => {
    // Regression: reported live. `routeFromPlan` always names the LAST
    // waypoint the active one (invariant #8) — for a "Go here" route the
    // destination therefore IS the active waypoint, so `ACTIVE_LEG_LAYER`
    // (a real followed leg's bright highlight, rendered ABOVE
    // `ROUTE_WARN_LAYER`) always covers the exact same segment as the
    // last leg's dashed run whenever that leg is flagged. Confirmed
    // against a real backend: the first and last legs both came back
    // approximate, yet only the START run was ever visible on the chart
    // — because nothing else ever covers leg 0, but the active-leg
    // highlight covers the last leg unconditionally. A real (non-
    // approximate) leg sits between the two flagged ones here, so the
    // two runs stay distinct rather than merging into one.
    await createRoot(async (dispose) => {
      const h = harness(
        ["a", "b", "c", "d"],
        fixedPlanFetch({
          waypoints: [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 0.5 },
            { lat: 1.5, lon: 0.7 },
            { lat: 2, lon: 1 },
          ],
          distance_nm: 5,
          warnings: [
            "start point 0.0000, 0.0000 is itself inside charted danger",
            "destination 2.0000, 1.0000 is itself inside charted danger",
            STANDING_CAVEAT,
          ],
          approximate_legs: [true, false, true],
        }),
      );
      const ok = await h.model.goTo(P(2, 1));
      expect(ok).toBe(true);
      expect(h.model.approximateLegs()).toEqual([true, false, true]);

      let pushed: { properties: { kind: string } }[] = [];
      const fakeMap = {
        getSource: () => ({
          setData: (fc: { features: { properties: { kind: string } }[] }) => {
            pushed = fc.features;
          },
        }),
      };
      updateRouteData(fakeMap as unknown as Parameters<typeof updateRouteData>[0], h.model);

      const kinds = pushed.map((f) => f.properties.kind);
      // Both runs actually reached the source...
      expect(kinds.filter((k) => k === "warn")).toHaveLength(2);
      // ...and the active-leg highlight — which for this route covers the
      // SAME last segment as the end run — must be suppressed, or it
      // paints over (hides) the dashed warning it renders above.
      expect(kinds).not.toContain("active-leg");
      dispose();
    });
  });

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

  test("the planning request itself fails — falls back to a straight line and says so", async () => {
    await createRoot(async (dispose) => {
      const h = harness(["a", "b"], throwingPlanFetch());
      const ok = await h.model.goTo(P(2, 3), "Wreck");
      expect(ok).toBe(true);
      const saved = h.client.saved[0];
      // Exactly `directRoute`'s shape: the old two-point fallback.
      expect(saved.waypoints).toHaveLength(2);
      expect(saved.waypoints[0]).toMatchObject({ name: "Boat", lon: 0, lat: 0 });
      expect(saved.waypoints[1]).toMatchObject({ name: "Wreck", lon: 2, lat: 3 });
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0].title).toContain("router");
      dispose();
    });
  });
});

describe("setStop / insertStop / choose-on-map (the From/Stop/To autorouting engine)", () => {
  test("setStop({kind:'to'}) seeds an empty draft: a 'Boat' waypoint plus the destination, both tagged `stop`, route named after it", async () => {
    await createRoot(async (dispose) => {
      const h = harness(); // fix at (0, 0)
      h.mode.enter!(); // blank draft, mints "a"
      expect(h.model.draft()!.waypoints).toHaveLength(0);
      const ok = await h.model.setStop({ kind: "to" }, P(2, 3), "Harbourmaster");
      expect(ok).toBe(true);
      const r = h.model.draft()!;
      expect(r.name).toBe("Harbourmaster");
      expect(r.waypoints).toHaveLength(2);
      expect(r.waypoints[0]).toMatchObject({ name: "Boat", lon: 0, lat: 0, stop: true });
      expect(r.waypoints[1]).toMatchObject({ name: "Harbourmaster", lon: 2, lat: 3, stop: true });
      expect(h.model.draftStops().map((w) => w.id)).toEqual([r.waypoints[0]!.id, r.waypoints[1]!.id]);
      dispose();
    });
  });

  test("no boat fix, nothing staged: picking a destination FIRST now stages it — no failure, no notify, no route built yet", () => {
    // The old contract here was "fails, notifies, no mutation" — deliberately
    // changed: a destination is a perfectly good first move even with no fix
    // (or no From picked yet). `trySeedFromStaged` just waits for a From to
    // also become known (staged, or a fix arriving later); nothing to
    // apologise for in the meantime. `stageTo`'s network call is awaited
    // internally by `setStop`, but nothing here calls `rebuildFromStops`
    // (only one end is known), so this needs no `PlanFetch` and stays sync.
    createRoot((dispose) => {
      const client = fakeClient();
      const notices: Notice[] = [];
      const built = createRoutes({ signalk: fakeSignalK(null), client, mintId: () => "x", notify: (n) => notices.push(n) });
      const mode = built.feature.core.modes![0];
      mode.enter!();
      void built.model.setStop({ kind: "to" }, P(2, 3));
      // A real route needs a second end — not built yet, but that is not a
      // failure: the pin already shows (`previewTo`) and `toLabel` reads it.
      expect(built.model.draft()!.waypoints).toHaveLength(0);
      expect(built.model.toLabel()).not.toBeNull();
      expect(built.model.previewTo()).toMatchObject({ point: { lng: 2, lat: 3 } });
      expect(notices).toHaveLength(0);
      dispose();
    });
  });

  test("destination first, then a start point — completes the route regardless of order", async () => {
    await createRoot(async (dispose) => {
      const client = fakeClient();
      let n = 0;
      const built = createRoutes({
        signalk: fakeSignalK(null),
        client,
        mintId: () => `id${n++}`,
        fetch: echoStraightLinePlanFetch(),
      });
      const mode = built.feature.core.modes![0];
      mode.enter!();
      await built.model.setStop({ kind: "to" }, P(2, 3), "Harbourmaster");
      expect(built.model.draft()!.waypoints).toHaveLength(0); // still just staged
      const ok = await built.model.setStop({ kind: "from" }, P(0, 0), "Marina");
      expect(ok).toBe(true);
      const r = built.model.draft()!;
      expect(r.waypoints).toHaveLength(2);
      expect(r.waypoints[0]).toMatchObject({ name: "Marina", lon: 0, lat: 0, stop: true });
      expect(r.waypoints[1]).toMatchObject({ name: "Harbourmaster", lon: 2, lat: 3, stop: true });
      dispose();
    });
  });

  test("previewFrom defaults to the boat's live position the moment the editor opens — a fix, with NOTHING picked yet", () => {
    createRoot((dispose) => {
      const h = harness(); // fixed at (0, 0)
      h.mode.enter!();
      expect(h.model.draft()!.waypoints).toHaveLength(0);
      expect(h.model.previewFrom()).toEqual({ point: { lng: 0, lat: 0 }, label: "Boat" });
      expect(h.model.previewTo()).toBeNull(); // no default destination to show
      dispose();
    });
  });

  test("previewFrom is null outside the editor — no route ring sitting on the boat", () => {
    createRoot((dispose) => {
      const h = harness(); // fixed at (0, 0), editor never entered
      expect(h.model.previewFrom()).toBeNull();
      h.mode.enter!();
      expect(h.model.previewFrom()).not.toBeNull();
      h.mode.leave!();
      expect(h.model.previewFrom()).toBeNull();
      dispose();
    });
  });

  test("previewFrom is null with no fix and nothing staged — nothing sensible to show yet", () => {
    createRoot((dispose) => {
      const client = fakeClient();
      const built = createRoutes({ signalk: fakeSignalK(null), client, mintId: () => "x" });
      const mode = built.feature.core.modes![0];
      mode.enter!();
      expect(built.model.previewFrom()).toBeNull();
      dispose();
    });
  });

  test("previewFrom/previewTo track a staged pick, and go null once a real route exists", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      h.model.setFromPoint(P(5, 6), "Marina");
      expect(h.model.previewFrom()).toEqual({ point: { lng: 5, lat: 6 }, label: "Marina" });
      await h.model.setStop({ kind: "to" }, P(2, 3), "Fuel dock");
      // A real route exists now — the preview pins step aside for the real ones.
      expect(h.model.previewFrom()).toBeNull();
      expect(h.model.previewTo()).toBeNull();
      dispose();
    });
  });

  test("setToBoat stages the boat as the DESTINATION, and refuses gracefully with no fix", () => {
    createRoot((dispose) => {
      const h = harness(); // fixed at (0, 0)
      h.mode.enter!();
      h.model.setToBoat();
      expect(h.model.toLabel()).toBe("Boat");
      expect(h.model.previewTo()).toEqual({ point: { lng: 0, lat: 0 }, label: "Boat" });
      dispose();
    });

    createRoot((dispose) => {
      const client = fakeClient();
      const notices: Notice[] = [];
      const built = createRoutes({
        signalk: fakeSignalK(null),
        client,
        mintId: () => "x",
        notify: (n) => notices.push(n),
      });
      built.feature.core.modes![0].enter!();
      built.model.setToBoat();
      expect(built.model.toLabel()).toBeNull();
      expect(notices).toHaveLength(1);
      expect(notices[0].title).toContain("No boat position");
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

  test("setStop({kind:'to'}) on a route that already has one REPLACES it, re-planning the leg into it — it does not append", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(2, 3), "Fuel dock");
      const named = h.model.draft()!.name;
      const ok = await h.model.setStop({ kind: "to" }, P(5, 6), "Harbourmaster");
      expect(ok).toBe(true);
      const r = h.model.draft()!;
      expect(r.name).toBe(named); // re-setting To doesn't rename the route
      expect(r.waypoints).toHaveLength(2); // still From + To — Fuel dock is GONE
      expect(r.waypoints[0]).toMatchObject({ name: "Boat", lon: 0, lat: 0 });
      expect(r.waypoints[1]).toMatchObject({ name: "Harbourmaster", lon: 5, lat: 6 });
      dispose();
    });
  });

  test("insertStop puts a new stop immediately BEFORE the given id, re-planning both legs it splits — this is what '+ Add a stop' calls, passing the current To's id", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(5, 6), "Harbourmaster");
      const toId = h.model.draftStops().at(-1)!.id;
      const ok = await h.model.insertStop(toId, P(2, 3), "Fuel dock");
      expect(ok).toBe(true);
      const stops = h.model.draftStops();
      expect(stops.map((s) => s.name)).toEqual(["Boat", "Fuel dock", "Harbourmaster"]);
      expect(stops[2]!.id).toBe(toId); // the old To keeps its identity
      // Every waypoint between the three stops is `stop: true` here (the
      // harness's default fetch echoes a direct two-point leg, no bends).
      expect(h.model.draft()!.waypoints).toHaveLength(3);
      dispose();
    });
  });

  test("a bent (hazard-avoiding) plan names the middle points plainly, untagged `stop`, and stamps `approximate` per waypoint", async () => {
    await createRoot(async (dispose) => {
      const h = harness(
        ["a", "b", "c"],
        fixedPlanFetch({
          waypoints: [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 0.5 },
            { lat: 2, lon: 1 },
          ],
          distance_nm: 12,
          warnings: [STANDING_CAVEAT],
          approximate_legs: [false, true],
        }),
      );
      h.mode.enter!();
      const ok = await h.model.setStop({ kind: "to" }, P(1, 2), "Marina");
      expect(ok).toBe(true);
      const r = h.model.draft()!;
      expect(r.waypoints).toHaveLength(3);
      expect(r.waypoints[0]).toMatchObject({ name: "Boat", approximate: false, stop: true });
      expect(r.waypoints[1]).toMatchObject({ name: "Waypoint", approximate: false, stop: false });
      expect(r.waypoints[2]).toMatchObject({ name: "Marina", approximate: true, stop: true });
      expect(h.model.draftStops().map((w) => w.id)).toEqual([r.waypoints[0]!.id, r.waypoints[2]!.id]);
      dispose();
    });
  });

  test("the planning request itself fails — falls back to a straight line into the draft and says so", async () => {
    await createRoot(async (dispose) => {
      const h = harness(["a", "b"], throwingPlanFetch());
      h.mode.enter!();
      const ok = await h.model.setStop({ kind: "to" }, P(2, 3), "Wreck");
      expect(ok).toBe(true);
      const r = h.model.draft()!;
      expect(r.waypoints).toHaveLength(2);
      expect(r.waypoints[1]).toMatchObject({ name: "Wreck", approximate: false });
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0].title).toContain("router");
      dispose();
    });
  });

  test("'Choose on map' (To): arms pickingOnMap({kind:'to'}), and the NEXT click resolves it — a further unarmed click is now INERT, not an append", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      expect(h.model.pickingOnMap()).toBeNull();
      h.model.beginPickOnMap({ kind: "to" });
      expect(h.model.pickingOnMap()).toEqual({ kind: "to" });

      // The click resolves the pick (an async setStop), not a plain waypoint
      // append — and disarms immediately so a SECOND, later click goes back
      // to being inert.
      h.mode.onClick!(clickAt(2, 3));
      expect(h.model.pickingOnMap()).toBeNull();
      await new Promise((r) => setTimeout(r, 0)); // let the async setStop settle
      const r = h.model.draft()!;
      expect(r.waypoints).toHaveLength(2);
      expect(r.waypoints[1]).toMatchObject({ lon: 2, lat: 3 });

      // A further click, unarmed, does nothing — no more freeform tap-to-add.
      h.mode.onClick!(clickAt(9, 9));
      expect(h.model.draft()!.waypoints).toHaveLength(2);
      dispose();
    });
  });

  test("beginPickOnMap defaults to {kind:'to'}", () => {
    createRoot((dispose) => {
      const h = harness();
      h.mode.enter!();
      h.model.beginPickOnMap();
      expect(h.model.pickingOnMap()).toEqual({ kind: "to" });
      dispose();
    });
  });

  test("cancelPickOnMap backs out without touching the draft", () => {
    createRoot((dispose) => {
      const h = harness();
      h.mode.enter!();
      h.model.beginPickOnMap({ kind: "to" });
      h.model.cancelPickOnMap();
      expect(h.model.pickingOnMap()).toBeNull();
      h.mode.onClick!(clickAt(9, 9));
      // The un-armed click does nothing.
      expect(h.model.draft()!.waypoints).toHaveLength(0);
      dispose();
    });
  });

  test("leaving the editor drops an armed pick — a later reopen starts unarmed", () => {
    createRoot((dispose) => {
      const h = harness();
      h.model.bindExit(() => h.mode.leave!());
      h.mode.enter!();
      h.model.beginPickOnMap({ kind: "to" });
      h.model.exitEditor();
      h.mode.enter!();
      expect(h.model.pickingOnMap()).toBeNull();
      dispose();
    });
  });
});

// The optimistic-placement + "planning" indicator: what a stop mutator shows
// BEFORE its real re-plan (`rebuildFromStops`, a network round trip per leg)
// resolves. Needs a fetch the test can hold open, unlike the harness default
// (`echoStraightLinePlanFetch`, which settles on the same tick) — mirrors the
// "gated" pattern `#RT-ADDRACE` already uses for save races.
describe("optimistic placement + the `planning` indicator", () => {
  /** Parks every `/api/routing/plan` call until `release()` is called — lets
   * a test inspect the draft mid-flight, between the instant provisional
   * patch and the real one. */
  function gatedPlanFetch(): { fetch: PlanFetch; release: () => void; calls: number } {
    const gates: Array<() => void> = [];
    return {
      fetch: async (_url, init) => {
        await new Promise<void>((res) => gates.push(res));
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          from: { lat: number; lon: number };
          to: { lat: number; lon: number };
        };
        return new Response(
          JSON.stringify({ waypoints: [body.from, body.to], distance_nm: 1, warnings: [], approximate_legs: [false] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      release: () => gates.splice(0).forEach((g) => g()),
      get calls() {
        return gates.length;
      },
    };
  }

  test("a new stop appears IMMEDIATELY with a straight line and its coordinates as the name, before the real plan resolves", async () => {
    await createRoot(async (dispose) => {
      const gated = gatedPlanFetch();
      const h = harness(["a", "b", "c"], gated.fetch);
      h.mode.enter!();
      const pending = h.model.setStop({ kind: "to" }, P(2, 3)); // no label — a bare map tap

      // Synchronous: the provisional patch lands before ANY await in the
      // caller, i.e. before this line even runs.
      const provisional = h.model.draft()!;
      expect(provisional.waypoints).toHaveLength(2);
      expect(provisional.waypoints[0]).toMatchObject({ name: "Boat", stop: true, approximate: false });
      expect(provisional.waypoints[1]).toMatchObject({
        name: formatCoordinate(3, 2),
        lon: 2,
        lat: 3,
        stop: true,
        approximate: true, // a provisional leg reuses the "not yet verified" dashed paint
      });
      expect(h.model.planning()).toBe(true);

      gated.release();
      await pending;
      expect(h.model.planning()).toBe(false);
      dispose();
    });
  });

  test("removeStop shows the collapsed straight line immediately, before its own re-plan resolves", async () => {
    await createRoot(async (dispose) => {
      // A fetch that passes through instantly UNTIL armed — lets the test
      // build up a 3-stop route at full speed, then gate only the ONE call
      // under test (`removeStop`'s own re-plan).
      let holding: Array<() => void> | null = null;
      const fetchImpl: PlanFetch = async (_url, init) => {
        if (holding) await new Promise<void>((res) => holding!.push(res));
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          from: { lat: number; lon: number };
          to: { lat: number; lon: number };
        };
        return new Response(
          JSON.stringify({ waypoints: [body.from, body.to], distance_nm: 1, warnings: [], approximate_legs: [false] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
      const h = harness(["a", "b", "c"], fetchImpl);
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(5, 6), "Harbourmaster");
      const toId = h.model.draftStops().at(-1)!.id;
      await h.model.insertStop(toId, P(2, 3), "Fuel dock");
      const fuelDockId = h.model.draftStops().find((s) => s.name === "Fuel dock")!.id;

      holding = [];
      const pending = h.model.removeStop(fuelDockId);
      const mid = h.model.draft()!;
      // Collapsed straight back to Boat → Harbourmaster, the moment the
      // removal is asked for — not after the network round trip.
      expect(mid.waypoints.map((w) => w.name)).toEqual(["Boat", "Harbourmaster"]);
      expect(h.model.planning()).toBe(true);

      holding.splice(0).forEach((g) => g());
      await pending;
      expect(h.model.planning()).toBe(false);
      dispose();
    });
  });

  test("a bare map-tap stop is renamed to a nearby charted place once the lookup resolves", async () => {
    await createRoot(async (dispose) => {
      const fetchImpl: PlanFetch = async (url, init) => {
        if (String(url).includes("/api/search")) {
          return new Response(
            JSON.stringify({ results: [{ title: "Aarhus Harbour", lat: 3.0001, lon: 2.0001 }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          from: { lat: number; lon: number };
          to: { lat: number; lon: number };
        };
        return new Response(
          JSON.stringify({ waypoints: [body.from, body.to], distance_nm: 1, warnings: [], approximate_legs: [false] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
      const h = harness(["a", "b"], fetchImpl);
      h.mode.enter!();
      const ok = await h.model.setStop({ kind: "to" }, P(2, 3)); // no label
      expect(ok).toBe(true);
      const r = h.model.draft()!;
      expect(r.waypoints[1]!.name).toBe("Aarhus Harbour");
      expect(r.name).toBe("Aarhus Harbour"); // seeding a route also names it after the destination
      dispose();
    });
  });

  test("a search-picked stop (already named) skips the nearby-place lookup entirely", async () => {
    await createRoot(async (dispose) => {
      let searchCalls = 0;
      const fetchImpl: PlanFetch = async (url, init) => {
        if (String(url).includes("/api/search")) {
          searchCalls++;
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          from: { lat: number; lon: number };
          to: { lat: number; lon: number };
        };
        return new Response(
          JSON.stringify({ waypoints: [body.from, body.to], distance_nm: 1, warnings: [], approximate_legs: [false] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
      const h = harness(["a", "b"], fetchImpl);
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(2, 3), "Harbourmaster"); // a real, given label
      expect(searchCalls).toBe(0);
      dispose();
    });
  });
});

describe("editable From", () => {
  test("defaults to 'Boat' with nothing staged", () => {
    createRoot((dispose) => {
      const h = harness();
      h.mode.enter!();
      expect(h.model.fromLabel()).toBe("Boat");
      dispose();
    });
  });

  test("setFromPoint on an empty draft stages a custom start — the seed plans FROM IT, not the boat, and names waypoint 0 after it", async () => {
    await createRoot(async (dispose) => {
      const h = harness(); // fix at (0, 0) — a wrong `from` would show up here
      h.mode.enter!();
      h.model.setFromPoint(P(5, 5), "Marina");
      expect(h.model.fromLabel()).toBe("Marina");
      const ok = await h.model.setStop({ kind: "to" }, P(2, 3), "Wreck");
      expect(ok).toBe(true);
      const r = h.model.draft()!;
      expect(r.waypoints[0]).toMatchObject({ name: "Marina", lon: 5, lat: 5 });
      expect(r.waypoints[1]).toMatchObject({ name: "Wreck", lon: 2, lat: 3 });
      dispose();
    });
  });

  test("a staged From needs no boat fix at all", async () => {
    await createRoot(async (dispose) => {
      const client = fakeClient();
      const built = createRoutes({ signalk: fakeSignalK(null), client, mintId: () => "x" });
      const mode = built.feature.core.modes![0];
      mode.enter!();
      built.model.setFromPoint(P(5, 5), "Marina");
      const ok = await built.model.setStop({ kind: "to" }, P(2, 3), "Wreck");
      expect(ok).toBe(true);
      expect(built.model.hasFix()).toBe(false); // the gap this closes
      dispose();
    });
  });

  test("blank/omitted label falls back to the point's own coordinates, not a generic name", () => {
    createRoot((dispose) => {
      const h = harness();
      h.mode.enter!();
      h.model.setFromPoint(P(5, 5), "   ");
      expect(h.model.fromLabel()).toBe(formatCoordinate(5, 5));
      dispose();
    });
  });

  test("setFromBoat resets a staged From back to the default (empty draft)", () => {
    createRoot((dispose) => {
      const h = harness();
      h.mode.enter!();
      h.model.setFromPoint(P(5, 5), "Marina");
      h.model.setFromBoat();
      expect(h.model.fromLabel()).toBe("Boat");
      dispose();
    });
  });

  test("the staged From is consumed once it seeds a draft — a later blank draft starts back at Boat", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.model.bindExit(() => h.mode.leave!());
      h.mode.enter!();
      h.model.setFromPoint(P(5, 5), "Marina");
      await h.model.setStop({ kind: "to" }, P(2, 3), "Wreck");
      expect(h.model.fromLabel()).toBe("Boat"); // consumed by the seed above
      h.model.exitEditor();
      h.mode.enter!();
      expect(h.model.fromLabel()).toBe("Boat");
      dispose();
    });
  });

  test("'Choose on map' (From): arms pickingOnMap({kind:'from'}), and the next click STAGES the point on an empty draft — it does not build anything yet", () => {
    createRoot((dispose) => {
      const h = harness();
      h.mode.enter!();
      h.model.beginPickOnMap({ kind: "from" });
      expect(h.model.pickingOnMap()).toEqual({ kind: "from" });
      h.mode.onClick!(clickAt(7, 8));
      expect(h.model.pickingOnMap()).toBeNull();
      // Staged, not built: no waypoint exists yet.
      expect(h.model.draft()!.waypoints).toHaveLength(0);
      expect(h.model.fromLabel()).toBe(formatCoordinate(8, 7)); // clickAt(lng, lat) = (7, 8)
      dispose();
    });
  });

  test("editing From on a route that already has stops is a REAL edit — replans the leg into it, keeps the rest, and re-plans immediately rather than staging", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(2, 3), "Fuel dock");
      h.model.setFromPoint(P(99, 99), "Somewhere else"); // NOT staged — the draft already has stops
      await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget re-plan settle
      const r = h.model.draft()!;
      expect(r.waypoints).toHaveLength(2); // still just From + To
      expect(r.waypoints[0]).toMatchObject({ name: "Somewhere else", lon: 99, lat: 99 });
      expect(r.waypoints[1]).toMatchObject({ name: "Fuel dock", lon: 2, lat: 3 });
      dispose();
    });
  });

  test("setFromBoat on a route that already has stops replaces the From stop with the boat's current fix", async () => {
    await createRoot(async (dispose) => {
      const h = harness(); // fix at (0, 0)
      h.mode.enter!();
      h.model.setFromPoint(P(9, 9), "Elsewhere");
      await h.model.setStop({ kind: "to" }, P(2, 3), "Fuel dock");
      h.model.setFromBoat();
      await new Promise((r) => setTimeout(r, 0));
      const r = h.model.draft()!;
      expect(r.waypoints[0]).toMatchObject({ name: "Boat", lon: 0, lat: 0 });
      dispose();
    });
  });
});

describe("routeFromPlan", () => {
  test("waypoint 0 is the boat, the LAST is the destination named as the leg, the rest are plain", () => {
    const { route, activeWaypointId } = routeFromPlan(
      [P(10, 55), P(10.5, 55.5), P(11, 56)],
      { route: "r", waypointIds: ["a", "b", "c"] },
      "Marina",
    );
    expect(route.id).toBe("r");
    expect(route.name).toBe("Marina");
    expect(route.waypoints).toHaveLength(3);
    expect(route.waypoints[0]).toMatchObject({ id: "a", name: "Boat", lon: 10, lat: 55 });
    expect(route.waypoints[1]).toMatchObject({ id: "b", name: "Waypoint 1", lon: 10.5, lat: 55.5 });
    expect(route.waypoints[2]).toMatchObject({ id: "c", name: "Marina", lon: 11, lat: 56 });
    expect(activeWaypointId).toBe("c");
  });

  test("a direct (unbent) plan is the same two-waypoint shape directRoute produces", () => {
    const { route, activeWaypointId } = routeFromPlan(
      [P(10, 55), P(11, 56)],
      { route: "r", waypointIds: ["a", "b"] },
      "Buoy",
    );
    expect(route.waypoints).toHaveLength(2);
    expect(route.waypoints[0]).toMatchObject({ name: "Boat" });
    expect(route.waypoints[1]).toMatchObject({ name: "Buoy" });
    expect(activeWaypointId).toBe("b");
  });

  test("falls back to a default name when none/blank is given", () => {
    for (const name of [undefined, "  "]) {
      const { route } = routeFromPlan([P(0, 0), P(1, 1)], { route: "r", waypointIds: ["a", "b"] }, name);
      expect(route.name).toBe("Go here");
      expect(route.waypoints[1].name).toBe("Go here");
    }
  });

  test("stamps each waypoint's own `approximate` from the INCOMING leg's flag (#owqqcdqe)", () => {
    // 4 waypoints, 3 legs: leg 0 (0->1) real, leg 1 (1->2) a guess, leg 2
    // (2->3) real again — waypoint i's own flag is leg (i-1)'s.
    const { route } = routeFromPlan(
      [P(0, 0), P(1, 1), P(2, 2), P(3, 3)],
      { route: "r", waypointIds: ["a", "b", "c", "d"] },
      "Reef",
      [false, true, false],
    );
    expect(route.waypoints.map((w) => w.approximate)).toEqual([false, false, true, false]);
  });

  test("every waypoint is `approximate: false` when no flags are given at all", () => {
    const { route } = routeFromPlan([P(0, 0), P(1, 1)], { route: "r", waypointIds: ["a", "b"] }, "Buoy");
    expect(route.waypoints.map((w) => w.approximate)).toEqual([false, false]);
  });
});

// ── The tap classification ───────────────────────────────────────────────────

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

/** A tap whose `pick` answers from a fixed map: layer id → feature ids under it. */
const clickAt = (lng: number, lat: number, hits: Record<string, string[]> = {}): ModeClick => ({
  point: { x: 0, y: 0 },
  lngLat: { lng, lat },
  radius: 8,
  pick: (layers) => layers.flatMap((l) => hits[l] ?? []),
});

/** A fake `/api/routing/plan` that echoes the request's own `from`/`to` back
 * as a plain two-point line — the real backend's "nothing in the way"
 * answer. `harness`'s default, so a "go-here" test not explicitly testing
 * the planning call still exercises the REAL `goTo` → `planRoute` path
 * (not an accidental fallback from the test env's `fetch` failing on a
 * relative URL — that failure mode gets its own dedicated test below). */
function echoStraightLinePlanFetch(warnings: string[] = [STANDING_CAVEAT]): PlanFetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      from: { lat: number; lon: number };
      to: { lat: number; lon: number };
    };
    return new Response(
      JSON.stringify({ waypoints: [body.from, body.to], distance_nm: 1, warnings, approximate_legs: [false] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

/** A fake `/api/routing/plan` returning a fixed body regardless of the
 * request — for a test that only cares about the response shape (a bent
 * route, an unreachable reason), not round-tripping the tapped point. */
function fixedPlanFetch(body: unknown, status = 200): PlanFetch {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fake `/api/routing/plan` that always fails at the network/fetch level
 * — the case `goTo` falls back to `directRoute` for. */
function throwingPlanFetch(): PlanFetch {
  return async () => {
    throw new Error("network down");
  };
}

/** The standing "no rules stage yet" caveat a found route always carries
 * (`mivnav.features.routing.routes._NO_RULES_WARNING`) — matched loosely
 * (`planIsUnreachable` only cares about the OTHER wording), so tests that
 * don't care about the exact copy can share this one constant. */
const STANDING_CAVEAT =
  "hazard-avoiding route only: traffic-lane crossing angle and buoyage/" +
  "cardinal-mark side are not checked yet — verify manually before following";

function harness(mintIds = ["a", "b", "c", "d", "e"], planFetch: PlanFetch = echoStraightLinePlanFetch()) {
  let i = 0;
  const client = fakeClient();
  const notices: Notice[] = [];
  const built = createRoutes({
    signalk: fakeSignalK({ lng: 0, lat: 0, sogMs: 3 }),
    client,
    mintId: () => mintIds[i++] ?? `x${i}`,
    notify: (n) => notices.push(n),
    fetch: planFetch,
  });
  const mode = built.feature.core.modes![0];
  return { ...built, client, mode, notices };
}

// A plain tap inside the editor is INERT unless a "choose on map" pick is
// armed — the redesign's whole point (#RT-TAP-ADD/#RT-GEST are gone: no more
// freeform tap-to-add, no more tap-to-select, no more deliberate-gesture
// reveal-×). See "setStop / insertStop / choose-on-map" above for the ARMED
// case.
describe("a plain chart tap in the editor", () => {
  test("outside the editor: inert, consumes nothing", () =>
    createRoot((dispose) => {
      const h = harness();
      expect(h.model.editing()).toBe(false);
      expect(h.mode.onClick!(clickAt(1, 1))).toBe(false);
      expect(h.model.route()).toBeNull();
      dispose();
    }));

  test("inside the editor, nothing armed: inert, mutates nothing", () =>
    createRoot((dispose) => {
      const h = harness();
      h.mode.enter!();
      expect(h.mode.onClick!(clickAt(1, 1))).toBe(false);
      expect(h.model.draft()!.waypoints).toHaveLength(0);
      dispose();
    }));
});

// ── GO (saveAndFollow) — the peek's smart GO: nearest-waypoint, or first ────
describe("GO (saveAndFollow)", () => {
  test("saves the draft, targets the waypoint NEAREST the boat, and exits", async () => {
    await createRoot(async (dispose) => {
      const h = harness(); // fix at (0, 0)
      const exit = { called: false };
      h.model.bindExit(() => (exit.called = true));
      h.mode.enter!();
      // Seed [Boat(0,0), Far(9,9)] — the boat itself is wp0, the nearest.
      await h.model.setStop({ kind: "to" }, P(9, 9), "Far");
      const wp0 = h.model.draftStops()[0]!.id;
      await h.model.saveAndFollow();
      expect(h.client.saved).toHaveLength(1);
      expect(h.client.activeCalls.at(-1)).toEqual({ route_id: h.client.saved[0].id, waypoint_id: wp0 });
      expect(exit.called).toBe(true);
      dispose();
    });
  });

  test("does nothing until the draft has a waypoint", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.saveAndFollow(); // empty draft → nothing persisted or followed
      expect(h.client.saved).toHaveLength(0);
      expect(h.client.activeCalls).toHaveLength(0);
      await h.model.setStop({ kind: "to" }, P(1, 1), "X");
      await h.model.saveAndFollow();
      expect(h.client.saved).toHaveLength(1);
      expect(h.client.activeCalls).toHaveLength(1);
      dispose();
    });
  });

  test("with no fix, begins the route at the FIRST waypoint", async () => {
    await createRoot(async (dispose) => {
      const client = fakeClient();
      const built = createRoutes({ signalk: fakeSignalK(null), client, mintId: mintUuid });
      built.feature.core.modes![0].enter!();
      built.model.setFromPoint(P(5, 5), "Start"); // stage — no fix to seed from
      await built.model.setStop({ kind: "to" }, P(1, 1), "End");
      const first = built.model.draftStops()[0]!.id;
      await built.model.saveAndFollow();
      expect(client.activeCalls.at(-1)?.waypoint_id).toBe(first);
      dispose();
    });
  });
});

// ── "Start route" (#RT-GONAV) — the drawer's explicit closest-next start ────
//
// A real route-follow (save + set the active leg + leave), NOT the direct
// single-leg `goTo`. "Go to selected waypoint" is gone with the selection
// concept the redesign drops — the drawer's Navigate section is `startRoute`
// alone now.
describe("Start route (#RT-GONAV)", () => {
  test("joins at the CLOSEST-NEXT leg's arrival waypoint", async () => {
    await createRoot(async (dispose) => {
      const h = harness(); // fix at (0, 0)
      h.mode.enter!();
      // North(0,2) → South(0,-2) → East(5,-2): the boat at (0,0) sits ON the
      // first leg, so the closest-next join is South, leg 0's arrival.
      h.model.setFromPoint(P(0, 2), "North");
      await h.model.setStop({ kind: "to" }, P(5, -2), "East");
      const eastId = h.model.draftStops().at(-1)!.id;
      await h.model.insertStop(eastId, P(0, -2), "South");
      const south = h.model.draftStops()[1]!;
      await h.model.startRoute();
      expect(h.client.activeCalls.at(-1)?.waypoint_id).toBe(south.id);
      dispose();
    });
  });

  test("with no fix, begins at the FIRST waypoint", async () => {
    await createRoot(async (dispose) => {
      const client = fakeClient();
      const built = createRoutes({ signalk: fakeSignalK(null), client, mintId: mintUuid });
      built.feature.core.modes![0].enter!();
      built.model.setFromPoint(P(5, 5), "Start");
      await built.model.setStop({ kind: "to" }, P(1, 1), "End");
      const first = built.model.draftStops()[0]!.id;
      await built.model.startRoute();
      expect(client.activeCalls.at(-1)?.waypoint_id).toBe(first);
      dispose();
    });
  });
});

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

// ── Auto-save: every edit debounce-persists; there is no Save/Discard ─────────
//
// The debounce is a real 500ms trailing timer, so these await just past it. The
// fake client's `save` pushes synchronously, so a flush (leave/GO) needs no wait.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 600; // > the model's 500ms debounce

describe("auto-save", () => {
  test("an edit persists after the debounce, not on the frame", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(1, 1)); // seeds → schedules a save
      expect(h.client.saved).toHaveLength(0); // debounced: nothing yet
      await wait(SETTLE_MS);
      expect(h.client.saved).toHaveLength(1); // the trailing save fired
      expect(h.client.saved[0].waypoints).toHaveLength(2);
      dispose();
    });
  });

  test("a drag is ONE trailing save, not one per move", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(1, 1)); // seeds [Boat, wp1]
      const [wp0] = h.model.route()!.waypoints.map((w) => w.id);
      // A drag: many moves in quick succession, all inside the debounce window.
      h.model.moveWaypoint(wp0, { lng: 2, lat: 2 });
      h.model.moveWaypoint(wp0, { lng: 3, lat: 3 });
      h.model.moveWaypoint(wp0, { lng: 4, lat: 4 });
      await wait(SETTLE_MS);
      // The seed's save + the whole drag coalesced into a single trailing save.
      expect(h.client.saved).toHaveLength(1);
      expect(h.client.saved[0].waypoints[0].lon).toBe(4);
      dispose();
    });
  });

  test("a brand-new EMPTY route never persists — not on a tick, not on close", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!(); // fresh empty draft, no edit
      await wait(SETTLE_MS);
      expect(h.client.saved).toHaveLength(0); // nothing scheduled → nothing saved
      h.mode.leave!(); // closing an untouched new route
      await wait(0);
      expect(h.client.saved).toHaveLength(0); // saves nothing
      dispose();
    });
  });

  test("closing flushes an edit still inside the debounce window", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(1, 1)); // scheduled, not yet saved
      expect(h.client.saved).toHaveLength(0);
      h.mode.leave!(); // the X: flushes the pending save before dropping the draft
      await wait(0);
      expect(h.client.saved).toHaveLength(1);
      dispose();
    });
  });

  test("GO follows the (already-saved) route and exits — no discard confirm to clear", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      let exited = 0;
      h.model.bindExit(() => exited++);
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(2, 0));
      await h.model.saveAndFollow();
      expect(h.client.saved).toHaveLength(1);
      expect(h.client.activeCalls).toHaveLength(1);
      expect(exited).toBe(1); // GO left once, cleanly
      dispose();
    });
  });
});

// ── Save-failure surfacing: a save that fails must be VISIBLE ──────────────────
//
// The silent 409 was a real defect: another cockpit device saving the same route
// first left our optimistic save throwing to `console.error` only — invisible to
// the user, and worse, re-POSTing the same stale rev on the next edit forever.
// These pin the fix: a 409 fires a user-visible notice, refreshes to the server's
// version, and reseats the draft so no silent loop is possible; a plain failure
// fires a notice too rather than vanishing.
describe("save-failure surfacing", () => {
  test("a 409 conflict fires a notice and refreshes to the server version — no silent loop", async () => {
    await createRoot(async (dispose) => {
      const notices: Notice[] = [];
      let refreshCalls = 0;
      let saveCalls = 0;
      const [routes, setRoutes] = createSignal<Route[]>([]);
      const [active] = createSignal<ActiveLeg | null>(null);
      // What the OTHER device already saved — a different geometry at a higher rev.
      const serverVersion: Route = {
        id: "R",
        name: "edited elsewhere",
        waypoints: [W("s1", 5, 5), W("s2", 6, 6)],
        plan_speed_kn: 5,
        rev: 9,
        updated: 1,
      };
      const client: RoutesClient = {
        routes,
        active,
        // A refresh pulls in the server's winning version (as the real poll would).
        refresh: async () => {
          refreshCalls++;
          setRoutes([serverVersion]);
        },
        // Every save loses the race — a stale `If-Match` rev → 409.
        save: async () => {
          saveCalls++;
          throw new RouteSaveError(409, "rev conflict");
        },
        remove: async () => {},
        setActive: async () => {},
      };
      const built = createRoutes({
        signalk: fakeSignalK({ lng: 0, lat: 0, sogMs: 3 }),
        client,
        mintId: () => "R", // the fresh draft's id == the server route's id
        notify: (n) => notices.push(n),
        fetch: echoStraightLinePlanFetch(), // a clean plan, so only the SAVE fails
      });
      const mode = built.feature.core.modes![0];
      mode.enter!();
      await built.model.setStop({ kind: "to" }, P(1, 1)); // an edit → schedules a save
      await wait(SETTLE_MS); // the debounce fires persist → 409

      expect(saveCalls).toBe(1);
      expect(refreshCalls).toBe(1); // pulled the server's version
      expect(notices).toHaveLength(1); // and TOLD the user
      expect(notices[0].title).toMatch(/another device/i);
      // The draft is reseated on the server's version (last-writer-refresh), so a
      // FURTHER edit saves against the fresh rev — the stale-rev loop is broken.
      expect(built.model.draft()!.rev).toBe(9);
      expect(built.model.draft()!.waypoints.map((w) => w.id)).toEqual(["s1", "s2"]);
      dispose();
    });
  });

  test("a plain (non-409) save failure still fires a user-visible notice", async () => {
    await createRoot(async (dispose) => {
      const notices: Notice[] = [];
      const [routes] = createSignal<Route[]>([]);
      const [active] = createSignal<ActiveLeg | null>(null);
      const client: RoutesClient = {
        routes,
        active,
        refresh: async () => {},
        save: async () => {
          throw new RouteSaveError(500, "server error");
        },
        remove: async () => {},
        setActive: async () => {},
      };
      const built = createRoutes({
        signalk: fakeSignalK({ lng: 0, lat: 0, sogMs: 3 }),
        client,
        mintId: () => "R",
        notify: (n) => notices.push(n),
        fetch: echoStraightLinePlanFetch(), // a clean plan, so only the SAVE fails
      });
      const mode = built.feature.core.modes![0];
      mode.enter!();
      await built.model.setStop({ kind: "to" }, P(1, 1));
      await wait(SETTLE_MS);

      expect(notices).toHaveLength(1);
      expect(notices[0].title).toMatch(/save/i);
      dispose();
    });
  });
});

// ── rev is server SYNC state, read fresh at every persist ──────────────────────
//
// The optimistic save bumps the server `rev` on every write; the client tracks
// the latest. `persist` always reads the LIVE draft's rev (never a captured
// snapshot's), so two sequential edits each carry the fresh rev the previous
// save's ack reseated — no self-inflicted 409 — while a GENUINE cross-device
// write (the server rev advancing out from under us) still 409s for real and
// is handled: refresh, notify, reseat on the server's winning version.
describe("save conflicts: only a genuine cross-device write 409s", () => {
  const seedRoute: Route = {
    id: "R",
    name: "Passage",
    waypoints: [W("a", 0, 0), W("b", 1, 0)], // b at lat 1, lon 0
    plan_speed_kn: 5,
    rev: 1,
    updated: 0,
  };

  // A stateful fake that enforces `If-Match` exactly as the backend does: a save
  // whose rev != the server's current rev is a 409.
  function statefulClient(initial: Route) {
    const [routes, setRoutes] = createSignal<Route[]>([initial]);
    const [active] = createSignal<ActiveLeg | null>(null);
    const server = new Map<string, Route>([[initial.id, initial]]);
    const saveCalls: { ifMatch: number; ok: boolean }[] = [];
    const state = { refreshCalls: 0 };
    const client: RoutesClient = {
      routes,
      active,
      refresh: async () => {
        state.refreshCalls++;
        setRoutes([...server.values()]);
      },
      save: async (r) => {
        const cur = server.get(r.id);
        if (cur && r.rev > 0 && r.rev !== cur.rev) {
          saveCalls.push({ ifMatch: r.rev, ok: false });
          throw new RouteSaveError(409, `If-Match ${r.rev} != server ${cur.rev}`);
        }
        const saved = { ...r, rev: (cur?.rev ?? 0) + 1 };
        server.set(r.id, saved);
        setRoutes((rs) => [saved, ...rs.filter((x) => x.id !== r.id)]);
        saveCalls.push({ ifMatch: r.rev, ok: true });
        return saved;
      },
      remove: async () => {},
      setActive: async () => {},
    };
    // Simulate a DIFFERENT cockpit device saving first: the server rev advances
    // out from under us, and our live rev never learns of it.
    const externalWrite = (patch: Partial<Route>) => {
      const cur = server.get(initial.id)!;
      server.set(initial.id, { ...cur, ...patch, rev: cur.rev + 1 });
    };
    return { client, saveCalls, state, externalWrite };
  }

  const build = (client: RoutesClient, notices: Notice[]) => {
    const built = createRoutes({
      signalk: fakeSignalK({ lng: 0, lat: 0, sogMs: 3 }),
      client,
      mintId: () => "R",
      notify: (n) => notices.push(n),
    });
    built.model.bindEnter(() => built.feature.core.modes![0].enter!());
    return built;
  };

  test("two sequential edits each carry the FRESH rev — no self-inflicted 409", async () => {
    await createRoot(async (dispose) => {
      const notices: Notice[] = [];
      const { client, saveCalls, state } = statefulClient(seedRoute);
      const built = build(client, notices);
      built.model.editRoute(seedRoute); // draft rev 1

      const wpB = built.model.route()!.waypoints[1].id;
      built.model.moveWaypoint(wpB, { lng: 9, lat: 9 });
      await wait(SETTLE_MS); // save #1: If-Match 1 OK → server rev 2, draft rev 2

      built.model.moveWaypoint(wpB, { lng: 4, lat: 4 });
      await wait(SETTLE_MS); // save #2: must carry the LIVE rev (2), not the stale 1

      expect(state.refreshCalls).toBe(0);
      expect(notices).toHaveLength(0);
      expect(saveCalls.every((c) => c.ok)).toBe(true); // neither save 409'd
      expect(saveCalls.map((c) => c.ifMatch)).toEqual([1, 2]); // fresh rev each time
      dispose();
    });
  });

  test("a GENUINE cross-device 409 (another writer advanced the server) still refreshes + notifies", async () => {
    await createRoot(async (dispose) => {
      const notices: Notice[] = [];
      const { client, state, externalWrite } = statefulClient(seedRoute);
      const built = build(client, notices);
      built.model.editRoute(seedRoute); // draft rev 1

      // Another cockpit device saves first: the server jumps to rev 2 with new
      // geometry; our live rev (1) is now genuinely stale.
      externalWrite({ waypoints: [W("s1", 5, 5), W("s2", 6, 6)] });

      const wpB = built.model.route()!.waypoints[1].id;
      built.model.moveWaypoint(wpB, { lng: 9, lat: 9 }); // our edit, on stale rev 1
      await wait(SETTLE_MS); // save: If-Match 1 != server 2 → real 409

      expect(state.refreshCalls).toBe(1);
      expect(notices).toHaveLength(1);
      expect(notices[0].title).toMatch(/another device/i);
      // Reseated on the server's winning version — the real-conflict path intact.
      expect(built.model.draft()!.rev).toBe(2);
      expect(built.model.draft()!.waypoints.map((w) => w.id)).toEqual(["s1", "s2"]);
      dispose();
    });
  });
});

// ── #RT-ADDRACE: a save response must not clobber the LIVE draft geometry ──────
//
// The optimistic save echoes the route it SENT (older, minus anything added during
// the network window). The old success branch reseated the whole draft on that
// echo, so a waypoint added while the save was in flight vanished (blink-then-gone)
// and the sheet re-rendered (the blip). The fix reseats ONLY `rev` — server sync
// state, never the editable document — and serializes saves so an immediate-persist
// path can't dispatch a second `client.save` with a stale `If-Match` while a
// debounced one is still in flight.
describe("a save response updates only rev, never the live draft geometry (#RT-ADDRACE)", () => {
  const seed: Route = {
    id: "R",
    name: "Passage",
    waypoints: [W("a", 0, 0), W("b", 1, 1)], // two waypoints, rev 1
    plan_speed_kn: 5,
    rev: 1,
    updated: 0,
  };

  // Stateful + If-Match-enforcing like the describe above, but each `save` PARKS
  // on a gate until `releaseNext()` — so a save can be held "in flight" while the
  // draft is edited underneath it, which is the whole point of the race.
  function gatedClient(initial: Route) {
    const [routes, setRoutes] = createSignal<Route[]>([initial]);
    const [active] = createSignal<ActiveLeg | null>(null);
    const server = new Map<string, Route>([[initial.id, initial]]);
    const saveCalls: { ifMatch: number; ok: boolean }[] = [];
    const gates: Array<() => void> = [];
    const client: RoutesClient = {
      routes,
      active,
      refresh: async () => setRoutes([...server.values()]),
      save: async (r) => {
        await new Promise<void>((res) => gates.push(res)); // park until released
        const cur = server.get(r.id);
        if (cur && r.rev > 0 && r.rev !== cur.rev) {
          saveCalls.push({ ifMatch: r.rev, ok: false });
          throw new RouteSaveError(409, `If-Match ${r.rev} != server ${cur.rev}`);
        }
        const saved = { ...r, rev: (cur?.rev ?? 0) + 1 };
        server.set(r.id, saved);
        setRoutes((rs) => [saved, ...rs.filter((x) => x.id !== r.id)]);
        saveCalls.push({ ifMatch: r.rev, ok: true });
        return saved;
      },
      remove: async () => {},
      setActive: async () => {},
    };
    return {
      client,
      saveCalls,
      server,
      inFlight: () => gates.length,
      releaseNext: () => gates.shift()?.(),
    };
  }

  const build = (client: RoutesClient, notices: Notice[]) => {
    const built = createRoutes({
      signalk: fakeSignalK({ lng: 0, lat: 0, sogMs: 3 }),
      client,
      mintId: () => "b",
      notify: (n) => notices.push(n),
    });
    built.model.bindEnter(() => built.feature.core.modes![0].enter!());
    return built;
  };

  test("a waypoint moved while a save is in flight survives; only rev advances", async () => {
    await createRoot(async (dispose) => {
      const notices: Notice[] = [];
      const { client, inFlight, releaseNext } = gatedClient(seed);
      const built = build(client, notices);
      built.model.editRoute(seed); // draft [A, B] @ rev 1

      built.model.moveWaypoint("a", { lng: 0, lat: 0.5 }); // an edit → schedules save#1
      await wait(SETTLE_MS); // the debounce fires → client.save([A,B])@1, now PARKED
      expect(inFlight()).toBe(1);

      // The user drags B while save#1 is still on the wire — a SYNCHRONOUS edit
      // (moveWaypoint patches directly; it doesn't wait on the planner).
      built.model.moveWaypoint("b", { lng: 9, lat: 9 });
      expect(built.model.route()!.waypoints[1]).toMatchObject({ lon: 9, lat: 9 });

      releaseNext(); // save#1 resolves with the echo [A,B]@1 → rev 2
      await wait(0); // let the success branch run

      // B's move MUST still be there (the bug dropped a mid-flight edit), and rev
      // must have advanced to 2.
      expect(built.model.route()!.waypoints[1]).toMatchObject({ lon: 9, lat: 9 });
      expect(built.model.route()!.rev).toBe(2);
      expect(notices).toHaveLength(0); // no self-inflicted conflict
      dispose();
    });
  });

  test("an immediate-persist path can't overlap a debounced save → no self-409", async () => {
    await createRoot(async (dispose) => {
      const notices: Notice[] = [];
      const { client, saveCalls, inFlight, releaseNext, server } = gatedClient(seed);
      const built = build(client, notices);
      built.model.editRoute(seed); // draft [A, B] @ rev 1

      built.model.moveWaypoint("a", { lng: 0, lat: 0.5 }); // schedules save#1
      await wait(SETTLE_MS); // save#1 dispatched [A,B]@1 and PARKED
      expect(inFlight()).toBe(1);

      built.model.moveWaypoint("b", { lng: 9, lat: 9 }); // a further edit mid-flight
      // An immediate-persist path (GO) fires while save#1 is still in flight. It
      // must NOT dispatch a second save yet — serialization holds it behind save#1.
      const goP = built.model.saveAndFollow(); // go(): an immediate-persist path
      await wait(0);
      expect(inFlight()).toBe(1); // still only save#1 on the wire — no overlap

      releaseNext(); // save#1 resolves → server rev 2, draft reseats rev only
      await wait(0);
      expect(inFlight()).toBe(1); // NOW GO's save dispatches — with the FRESH rev 2

      releaseNext(); // GO's save resolves → server rev 3
      await goP;

      expect(saveCalls.every((c) => c.ok)).toBe(true); // no save 409'd
      expect(saveCalls.map((c) => c.ifMatch)).toEqual([1, 2]); // serialized: fresh rev each
      expect(server.get("R")!.waypoints[1]).toMatchObject({ lon: 9, lat: 9 }); // B's move persisted
      expect(notices).toHaveLength(0);
      dispose();
    });
  });
});

// removeStop/reorderStops — the list's own × and drag-reorder, replacing the
// old select-on-chart + delete-× + undo/redo correction flow entirely.
describe("removeStop / reorderStops", () => {
  test("removing a MIDDLE stop re-plans the leg across the gap it leaves, keeping From/To", async () => {
    await createRoot(async (dispose) => {
      const h = harness(); // fix at (0, 0)
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(9, 9), "End"); // [Boat, End]
      const endId = h.model.draftStops().at(-1)!.id;
      await h.model.insertStop(endId, P(2, 3), "Middle"); // [Boat, Middle, End]
      const [boat, middle, end] = h.model.draftStops();
      await h.model.removeStop(middle!.id);
      const stops = h.model.draftStops();
      expect(stops.map((s) => s.id)).toEqual([boat!.id, end!.id]);
      expect(h.model.draft()!.waypoints).toHaveLength(2); // the leg through it collapsed to one
      dispose();
    });
  });

  test("removing down to ONE remaining stop leaves it as the draft's sole waypoint — no leg to plan", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(9, 9), "End");
      const [boat, end] = h.model.draftStops();
      await h.model.removeStop(end!.id);
      const stops = h.model.draftStops();
      expect(stops).toHaveLength(1);
      expect(stops[0]!.id).toBe(boat!.id);
      expect(h.model.draft()!.waypoints).toHaveLength(1);
      dispose();
    });
  });

  test("reorderStops moves a stop to a new position, re-planning the legs around it", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(9, 9), "C");
      const cId = h.model.draftStops().at(-1)!.id;
      await h.model.insertStop(cId, P(2, 2), "B"); // [Boat, B, C]
      await h.model.reorderStops(1, 2); // swap B and C → [Boat, C, B]
      expect(h.model.draftStops().map((s) => s.name)).toEqual(["Boat", "C", "B"]);
      dispose();
    });
  });

  test("reorderStops is a no-op with an out-of-range index", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(9, 9), "End");
      const before = h.model.draftStops().map((s) => s.id);
      await h.model.reorderStops(0, 5);
      expect(h.model.draftStops().map((s) => s.id)).toEqual(before);
      dispose();
    });
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

  test("editRoute enters the editor seeded with a COPY", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      // App wires bindEnter → modes.enter → mode.enter; mirror that here.
      h.model.bindEnter(() => h.mode.enter!());
      const r: Route = {
        id: "R",
        name: "R",
        waypoints: [
          { ...W("a", 0, 0), stop: true },
          { ...W("b", 1, 0), stop: true },
        ],
        plan_speed_kn: 5,
        rev: 2,
        updated: 0,
      };
      h.model.editRoute(r);
      expect(h.model.route()!.id).toBe("R");
      expect(h.model.route()!.waypoints).toHaveLength(2);
      // A copy: editing the draft must not touch the passed route.
      await h.model.insertStop("b", P(5, 5), "New");
      expect(h.model.route()!.waypoints).toHaveLength(3);
      expect(r.waypoints).toHaveLength(2);
      dispose();
    });
  });

  // #RT-NEW: starting a new route while FOLLOWING must seed a blank draft and NOT
  // disturb the followed route — the autopilot keeps tracking it, the new draft is
  // a separate route until GO.
  test("newRoute seeds a BLANK draft while following, leaving the followed route active", async () => {
    await createRoot(async (dispose) => {
      const h = harness();
      h.model.bindEnter(() => h.mode.enter!());
      // Follow a saved route.
      const r = route("R", 1);
      await h.client.save(r);
      await h.client.setActive({ route_id: "R", waypoint_id: "b" });
      expect(h.model.editing()).toBe(false);
      expect(h.model.activeRouteId()).toBe("R");
      const activeCallsBefore = h.client.activeCalls.length;

      // New route while following.
      h.model.newRoute();

      // A blank draft was seeded — NOT the followed route.
      expect(h.model.editing()).toBe(true);
      expect(h.model.draft()!.id).not.toBe("R");
      expect(h.model.draft()!.waypoints).toHaveLength(0);
      // The followed route is untouched: still active, and no setActive/stop fired.
      expect(h.model.activeRouteId()).toBe("R");
      expect(h.model.following()).toBe(true);
      expect(h.client.activeCalls.length).toBe(activeCallsBefore);
      // The new draft is a separate route, not the followed one.
      expect(h.model.followingDraft()).toBe(false);
      dispose();
    });
  });

  // The chart-gesture entry (a hold/double-click on the followed route's own
  // handle/line, outside the editor) is GONE with the redesign: the one way
  // in from outside now is the info panel's tap → "Edit route" action
  // (`provider.ts`'s `createRouteProvider`, exercised in provider.test.ts),
  // which just calls this same `editRoute`.
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

// ── The route commands (launcher + in-editor Undo / GO) ──────────────────────
//
// `routeCommands` closes over the model; the launcher toggles the mode, and
// Undo/GO drive the SAME `undo`/`saveAndFollow` the sheet does and are enabled
// only while route-edit is the active mode.
describe("the route commands", () => {
  /** A minimal CommandDeps: routeCommands reads `activeMode`, and the launcher
   * writes the mode through `toggleMode`. */
  function deps(mode: string | null): CommandDeps {
    return {
      activeMode: () => mode,
      toggleMode: () => {},
    } as unknown as CommandDeps;
  }
  const find = (cmds: ReturnType<typeof routeCommands>, id: string) => {
    const c = cmds.find((x) => x.id === id);
    if (!c) throw new Error(`no command ${id}`);
    return c;
  };

  test("mode-route labels itself by the active mode", () =>
    createRoot((dispose) => {
      const h = harness();
      expect(find(routeCommands(deps(null), h.model), "mode-route").label).toBe("Edit route");
      expect(find(routeCommands(deps("route-edit"), h.model), "mode-route").label).toBe(
        "Close route editor",
      );
      dispose();
    }));

  // route-undo/route-redo are gone with the redesign — Undo/Redo are no
  // longer part of the route editor at all (list actions replace them).

  test("go runs saveAndFollow (sets the active leg) and carries no keybinding", async () => {
    await createRoot(async (dispose) => {
      const h = harness(); // fix at (0,0)
      h.mode.enter!();
      await h.model.setStop({ kind: "to" }, P(2, 0));
      const go = find(routeCommands(deps("route-edit"), h.model), "route-go");
      expect(go.keybinding).toBeUndefined();
      expect(go.enabled!()).toBe(true);
      go.run({ close: () => {}, prompt: () => {} });
      await wait(SETTLE_MS);
      expect(h.client.activeCalls.length).toBeGreaterThan(0); // GO named the active leg
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

  test("the DEFAULT mintId still opens the editor with a valid waypoint id", () =>
    createRoot((dispose) => {
      withoutRandomUUID(() => {
        // No deps.mintId → exercises the real default path that threw on the boat.
        const built = createRoutes({ signalk: fakeSignalK({ lng: 0, lat: 0, sogMs: 3 }), client: fakeClient() });
        const mode = built.feature.core.modes![0];
        mode.enter!(); // seedDraft → newRoute(mintId): threw here before the fix
        expect(built.model.editing()).toBe(true);
        expect(built.model.route()).not.toBeNull();
        expect(built.model.route()!.id).toBeTruthy();
      });
      dispose();
    }));
});
