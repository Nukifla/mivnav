// Following a route without the autorouter (./follow.ts, wired through
// createRoutes): Follow from the nearest leg ahead, the same-route no-op, the
// "Switch to …?" ask, Next/Previous/Start at, the straight-line Go to — and
// that a MANUALLY drawn route (every point `stop: true`, no `approximate`)
// lights band.top, the XTE and the arrival notices like any other.

import { createRoot, createSignal } from "solid-js";
import { describe, expect, test } from "bun:test";
import type { ActiveLeg, Route, RoutesClient } from "../../core/routes";
import type { Notice } from "../../core/chrome/notices";
import type { SignalKState } from "../../core/signalk";
import type { InfoAction } from "../../core/info/types";
import { DESK, type ReadCtx } from "../../core/chrome/registry";
import { createRoutes, GO_HERE_ROUTE_ID, type ArrivalNotice } from "./index";
import { followStartIndex, skipTarget } from "./follow";
import { pickRouteByName } from "./commands";

const wp = (id: string, lon: number, lat: number, name = "") => ({ id, name, lon, lat, stop: true });

/** A route as the manual editor saves it: every point a stop, no `approximate`. */
const manual = (id = "m1", name = "Manual"): Route => ({
  id,
  name,
  waypoints: [wp(`${id}-a`, 0, 0, "Start"), wp(`${id}-b`, 0, 1), wp(`${id}-c`, 1, 1, "Buoy"), wp(`${id}-d`, 1, 2, "End")],
  plan_speed_kn: 5,
  rev: 3,
  updated: 0,
});

type Self = { lng: number; lat: number; sogMs?: number } | null;

function fakeClient(initial: Route[]) {
  const [routes, setRoutes] = createSignal<Route[]>(initial);
  const [active, setActiveSig] = createSignal<ActiveLeg | null>(null);
  const activeCalls: (ActiveLeg | null)[] = [];
  const saved: Route[] = [];
  let refreshes = 0;
  const client: RoutesClient = {
    routes,
    active,
    refresh: async () => {
      refreshes++;
    },
    save: async (r) => {
      const s = { ...r, rev: r.rev + 1 };
      saved.push(s);
      setRoutes((rs) => [s, ...rs.filter((x) => x.id !== r.id)]);
      return s;
    },
    remove: async () => {},
    setActive: async (leg) => {
      activeCalls.push(leg);
      setActiveSig(leg);
    },
  };
  return { client, activeCalls, saved, setActiveSig, refreshes: () => refreshes };
}

function harness(self: Self, routes: Route[] = [manual()]) {
  const [fix, setFix] = createSignal<Self>(self);
  const signalk = { self: fix, course: () => null } as unknown as SignalKState;
  const c = fakeClient(routes);
  const notices: Notice[] = [];
  const arrivals: ArrivalNotice[] = [];
  let fetched = 0;
  let n = 0;
  const built = createRoutes({
    signalk,
    client: c.client,
    mintId: () => `id${n++}`,
    notify: (x) => notices.push(x),
    onArrival: (x) => arrivals.push(x),
    // Nothing on the follow path may ask the router.
    fetch: async () => {
      fetched++;
      throw new Error("no routing here");
    },
  });
  return { ...c, ...built, notices, arrivals, setFix, fetched: () => fetched };
}

const ctx: ReadCtx = { density: DESK } as unknown as ReadCtx;

describe("followStartIndex", () => {
  const r = manual();
  test("no fix: the first LEG (target point 2), not point 1", () => {
    expect(followStartIndex(null, r.waypoints)).toBe(1);
  });
  test("one point: that point; none: -1", () => {
    expect(followStartIndex(null, r.waypoints.slice(0, 1))).toBe(0);
    expect(followStartIndex(null, [])).toBe(-1);
  });
  test("with a fix: the arrival point of the nearest leg", () => {
    // Beside the middle of leg b→c (lat 1, lon 0.5): target c, index 2.
    expect(followStartIndex({ lng: 0.5, lat: 1.05 }, r.waypoints)).toBe(2);
    // At the start: leg 1, target b.
    expect(followStartIndex({ lng: 0, lat: 0 }, r.waypoints)).toBe(1);
  });
  test("short of the start (in the marina): point 1 first, not point 2 across the corner", () => {
    // Route a(0,0)→b(0,1) runs north; the boat is 0.05° south of a.
    expect(followStartIndex({ lng: 0, lat: -0.05 }, r.waypoints)).toBe(0);
    expect(followStartIndex({ lng: -0.03, lat: -0.04 }, r.waypoints)).toBe(0);
  });
});

describe("skipTarget", () => {
  test("steps within the route, never off either end", () => {
    expect(skipTarget(1, 4, 1)).toBe(2);
    expect(skipTarget(1, 4, -1)).toBe(0);
    expect(skipTarget(3, 4, 1)).toBeNull();
    expect(skipTarget(0, 4, -1)).toBeNull();
  });
});

describe("follow (no route planner)", () => {
  test("a manual route followed via Follow publishes the nearest-leg-ahead waypoint", async () => {
    await createRoot(async (dispose) => {
      const h = harness({ lng: 0.5, lat: 1.05 });
      const r = h.client.routes()[0]!;
      expect(await h.model.follow(r)).toBe("started");
      expect(h.activeCalls).toEqual([{ route_id: "m1", waypoint_id: "m1-c" }]);
      expect(h.model.following()).toBe(true);
      expect(h.model.activeWaypoint()).toBe("m1-c");
      expect(h.fetched()).toBe(0);
      expect(h.notices.at(-1)).toMatchObject({ id: "route-follow", title: "Following Manual" });
      dispose();
    });
  });

  test("no fix: starts on leg 1 (target point 2)", async () => {
    await createRoot(async (dispose) => {
      const h = harness(null);
      await h.model.follow(h.client.routes()[0]!);
      expect(h.activeCalls).toEqual([{ route_id: "m1", waypoint_id: "m1-b" }]);
      dispose();
    });
  });

  test("following the same route again is a no-op — the target is not moved", async () => {
    await createRoot(async (dispose) => {
      const h = harness({ lng: 0, lat: 0 });
      const r = h.client.routes()[0]!;
      await h.model.follow(r);
      await h.model.skipWaypoint(1);
      const calls = h.activeCalls.length;
      expect(await h.model.follow(r)).toBe("already");
      expect(h.activeCalls.length).toBe(calls);
      dispose();
    });
  });

  test("another route followed: asks 'Switch to …?' non-modally; its action switches", async () => {
    await createRoot(async (dispose) => {
      const h = harness({ lng: 0, lat: 0 }, [manual("m1", "First"), manual("m2", "Second")]);
      const [first, second] = h.client.routes();
      await h.model.follow(first!);
      expect(await h.model.follow(second!)).toBe("asked");
      expect(h.client.active()?.route_id).toBe("m1");
      const ask = h.notices.find((x) => x.id === "route-follow-switch")!;
      expect(ask.title).toBe("Switch to Second?");
      expect(ask.detail).toBe("Now following First.");
      ask.action!.run();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.client.active()?.route_id).toBe("m2");
      // Confirmed inline elsewhere (route card / list): no ask.
      expect(await h.model.follow(first!, { confirmed: true })).toBe("started");
      dispose();
    });
  });

  test("a route the store doesn't hold (never saved) cannot be followed; a rev-0 one it does hold can", async () => {
    await createRoot(async (dispose) => {
      const h = harness(null, [{ ...manual(), rev: 0 }]);
      expect(await h.model.follow(manual("unsaved"))).toBe("failed");
      expect(h.activeCalls).toEqual([]);
      expect(await h.model.follow(h.client.routes()[0]!)).toBe("started");
      h.activeCalls.length = 0;
      expect(h.activeCalls).toEqual([]);
      dispose();
    });
  });
});

describe("controls while following", () => {
  test("Next / Previous step the target, re-reading the store first; stop at the ends", async () => {
    await createRoot(async (dispose) => {
      const h = harness({ lng: 0, lat: 0 });
      await h.model.follow(h.client.routes()[0]!); // target b (1)
      const before = h.refreshes();
      expect(await h.model.skipWaypoint(1)).toBe(true);
      expect(h.refreshes()).toBe(before + 1);
      expect(h.model.activeWaypoint()).toBe("m1-c");
      expect(await h.model.skipWaypoint(1)).toBe(true);
      expect(await h.model.skipWaypoint(1)).toBe(false); // at the last point
      expect(h.model.activeWaypoint()).toBe("m1-d");
      expect(await h.model.skipWaypoint(-1)).toBe(true);
      expect(h.model.activeWaypoint()).toBe("m1-c");
      dispose();
    });
  });

  test("Next builds on a watcher auto-advance seen by the refresh", async () => {
    await createRoot(async (dispose) => {
      const h = harness({ lng: 0, lat: 0 });
      await h.model.follow(h.client.routes()[0]!); // b
      // The backend NavWatcher advanced to c meanwhile (the next poll shows it).
      h.setActiveSig({ route_id: "m1", waypoint_id: "m1-c" });
      await h.model.skipWaypoint(1);
      expect(h.model.activeWaypoint()).toBe("m1-d");
      dispose();
    });
  });

  test("Start at a chosen waypoint", async () => {
    await createRoot(async (dispose) => {
      const h = harness(null);
      await h.model.follow(h.client.routes()[0]!);
      expect(await h.model.startAt("m1", "m1-a")).toBe(true);
      expect(h.client.active()).toEqual({ route_id: "m1", waypoint_id: "m1-a" });
      expect(await h.model.startAt("m1", "nope")).toBe(false);
      dispose();
    });
  });

  test("a manual route's band.top, XTE and arrival notices work when followed", async () => {
    await createRoot(async (dispose) => {
      // Beside leg b→c, a little north of it (lat 1.05): target c, off track.
      const h = harness({ lng: 0.5, lat: 1.05, sogMs: 2.5 });
      await h.model.follow(h.client.routes()[0]!);
      const inst = (id: string) => h.feature.core.instruments.find((i) => i.id === id)!;
      expect(inst("route.wpt").when!()).toBe(true);
      expect(inst("route.wpt").read(ctx).value).toBe("Buoy");
      expect(inst("route.dtw").read(ctx).state).not.toBe("null");
      const xte = inst("route.xte").read(ctx);
      expect(xte.state).not.toBe("null");
      expect(xte.value).toBe("3.00");
      expect(xte.sub).toBe("steer R");
      // The watcher advances c → d: an arrival notice names the reached point.
      h.setActiveSig({ route_id: "m1", waypoint_id: "m1-d" });
      expect(h.arrivals.at(-1)).toMatchObject({ title: "Reached Buoy", detail: "Next: End" });
      dispose();
    });
  });
});

describe("Go to — the straight line (no autorouter)", () => {
  test("no fix: builds nothing", async () => {
    await createRoot(async (dispose) => {
      const h = harness(null);
      expect(await h.model.goStraight({ lng: 1, lat: 1 }, "Buoy")).toBe(false);
      expect(h.saved).toEqual([]);
      dispose();
    });
  });

  test("saves the go-here route boat → point and follows its destination, never asking the router", async () => {
    await createRoot(async (dispose) => {
      const h = harness({ lng: 0, lat: 0 }, []);
      expect(await h.model.goStraight({ lng: 1, lat: 1 }, "Buoy")).toBe(true);
      expect(h.fetched()).toBe(0);
      const r = h.saved.at(-1)!;
      expect(r.id).toBe(GO_HERE_ROUTE_ID);
      expect(r.waypoints.map((w) => [w.name, w.lon, w.lat])).toEqual([
        ["Boat", 0, 0],
        ["Buoy", 1, 1],
      ]);
      expect(h.client.active()).toEqual({ route_id: GO_HERE_ROUTE_ID, waypoint_id: r.waypoints[1]!.id });
      expect(h.notices.at(-1)!.detail).toContain("not checked for hazards");
      // Again: overwrites in place (echoes the current rev), no second route.
      await h.model.goStraight({ lng: 2, lat: 2 }, "Pier");
      expect(h.saved.at(-1)!.rev).toBe(r.rev + 1);
      expect(h.client.routes().filter((x) => x.id === GO_HERE_ROUTE_ID)).toHaveLength(1);
      dispose();
    });
  });
});

describe("the route card's follow controls", () => {
  test("followed: Next/Previous/Start at/Stop, the target marked; none of it planner-gated", async () => {
    await createRoot(async (dispose) => {
      const h = harness({ lng: 0, lat: 0 });
      await h.model.follow(h.client.routes()[0]!); // target b
      const provider = h.feature.provider!;
      const hit = { providerId: "routes", id: "m1", priority: "regulated", precision: "line", title: "Manual", payload: h.client.routes()[0] } as const;
      const d = provider.detail!(hit as never) as { actions: InfoAction[]; sections: { rows: { label: string; value: string }[] }[] };
      const labels = d.actions.map((a) => a.label);
      expect(labels).toEqual(expect.arrayContaining(["Next waypoint", "Previous waypoint", "Start at…", "Stop following"]));
      expect(labels).not.toContain("Follow");
      expect(d.sections[0]!.rows.find((r) => r.label === "Next")!.value).toBe("WP 2 (2 of 4)");
      expect(d.sections[1]!.rows[1]!.label).toBe("→ WP 2");
      d.actions.find((a) => a.label === "Next waypoint")!.run();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.model.activeWaypoint()).toBe("m1-c");
      const startAt = d.actions.find((a) => a.label === "Start at…")!;
      expect(startAt.form!.submitLabel).toBe("Start here");
      startAt.form!.submit({ wp: "m1-a" });
      await new Promise((r) => setTimeout(r, 0));
      expect(h.model.activeWaypoint()).toBe("m1-a");
      dispose();
    });
  });

  test("not followed while another is: Follow asks 'Switch to …?' inline", async () => {
    await createRoot(async (dispose) => {
      const h = harness({ lng: 0, lat: 0 }, [manual("m1", "First"), manual("m2", "Second")]);
      await h.model.follow(h.client.routes().find((r) => r.id === "m1")!);
      const second = h.client.routes().find((r) => r.id === "m2")!;
      const d = h.feature.provider!.detail!({ providerId: "routes", id: "m2", payload: second } as never) as {
        actions: InfoAction[];
      };
      const follow = d.actions.find((a) => a.label === "Follow")!;
      expect(follow.confirm).toEqual({ question: "Switch to Second?", label: "Switch" });
      follow.run();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.client.active()?.route_id).toBe("m2");
      dispose();
    });
  });
});

describe("pickRouteByName (Follow route… prompt)", () => {
  const routes = [manual("a", "Harbour run"), manual("b", "Harbour return"), manual("c", "Island")];
  test("exact, unique substring, ambiguous, none", () => {
    expect(pickRouteByName(routes, "island")).toMatchObject({ ok: true, value: { id: "c" } });
    expect(pickRouteByName(routes, "run")).toMatchObject({ ok: true, value: { id: "a" } });
    expect(pickRouteByName(routes, "harbour")).toMatchObject({ ok: false });
    expect(pickRouteByName(routes, "zzz")).toEqual({ ok: false, error: "No saved route by that name" });
    expect(pickRouteByName([{ ...routes[2]!, waypoints: [] }], "island").ok).toBe(false);
  });
});
