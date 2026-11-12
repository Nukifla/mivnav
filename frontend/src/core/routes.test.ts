/**
 * The routes client: parsing the wire and round-tripping the per-route
 * planning speed. The fetch double is a small model of the backend's
 * /api/routes (mivnav/api/routes.py) — it stores what it is PUT and lists it
 * back, so anything the client gets wrong about the wire shape fails here
 * rather than on the boat.
 *
 * NB: needs `--conditions=browser` (see the `test` script), like every other
 * reactive test here — bare `bun test` resolves solid-js's SSR build and the
 * effects never run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createRoot, mapArray } from "solid-js";
import {
  type ActiveLeg,
  createRoutesClient,
  DEFAULT_PLAN_SPEED_KN,
  type Route,
  type RoutesClient,
} from "./routes";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const WPS = [{ id: "w1", name: "A", lat: 1, lon: 1 }];

/** A model of the backend store over fetch. Seed routes may omit
 * `plan_speed_kn` to stand in for an older server that never sent it.
 *
 * Tracks the active leg too, and exposes `setActive` to move it directly —
 * standing in for a server-side change this client didn't make (NavWatcher's
 * auto-advance, or a GO pressed on another device) — plus `getCalls` to
 * assert on how many times the poll actually hit the wire. */
function fakeBackend(seed: Partial<Route>[] = []) {
  const store = new Map<string, Record<string, unknown>>();
  let rev = 0;
  for (const r of seed) store.set(r.id as string, { ...r });
  let active: ActiveLeg | null = null;
  let getCalls = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url));
    const method = init?.method ?? "GET";
    if (path === "/api/routes" && method === "GET") {
      getCalls++;
      return json({ routes: [...store.values()], active });
    }
    if (path === "/api/routes/active" && method === "PUT") {
      active = init?.body ? (JSON.parse(String(init.body)) as typeof active) : null;
      return json({ active });
    }
    const id = path.replace("/api/routes/", "");
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // The backend owns rev/updated and fills plan_speed_kn's default when a
      // body omits it. Model both.
      const saved = {
        ...body,
        id,
        plan_speed_kn: body.plan_speed_kn ?? DEFAULT_PLAN_SPEED_KN,
        rev: ++rev,
        updated: rev,
      };
      store.set(id, saved);
      return json(saved);
    }
    return json({ detail: "unexpected" }, 500);
  }) as typeof fetch;

  return {
    store,
    setActive: (leg: ActiveLeg | null) => {
      active = leg;
    },
    get getCalls() {
      return getCalls;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the routes client and the planning speed", () => {
  test("a route arriving without plan_speed_kn is defaulted, not left undefined", async () => {
    await createRoot(async (dispose) => {
      fakeBackend([{ id: "old", name: "Legacy", waypoints: WPS, rev: 1, updated: 1 }]);
      const client = createRoutesClient({ pollMs: 0 });
      await client.refresh();
      const r = client.routes().find((x) => x.id === "old")!;
      expect(r.plan_speed_kn).toBe(DEFAULT_PLAN_SPEED_KN);
      dispose();
    });
  });

  test("a route's own planning speed is preserved on load", async () => {
    await createRoot(async (dispose) => {
      fakeBackend([{ id: "r1", name: "Fast", waypoints: WPS, plan_speed_kn: 7.5, rev: 1, updated: 1 }]);
      const client = createRoutesClient({ pollMs: 0 });
      await client.refresh();
      expect(client.routes().find((x) => x.id === "r1")!.plan_speed_kn).toBe(7.5);
      dispose();
    });
  });

  test("the planning speed round-trips through save", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend();
      const client = createRoutesClient({ pollMs: 0 });
      const route: Route = {
        id: "r2",
        name: "Passage",
        waypoints: WPS,
        plan_speed_kn: 6.5,
        rev: 0,
        updated: 0,
      };
      const saved = await client.save(route);
      expect(saved.plan_speed_kn).toBe(6.5);
      // ...and it is what reached the store.
      expect((backend.store.get("r2") as Route).plan_speed_kn).toBe(6.5);
      expect(client.routes().find((x) => x.id === "r2")!.plan_speed_kn).toBe(6.5);
      dispose();
    });
  });

  test("a save that omits the speed comes back at the backend default", async () => {
    await createRoot(async (dispose) => {
      fakeBackend();
      const client = createRoutesClient({ pollMs: 0 });
      // A body without plan_speed_kn (older client) — the backend fills it.
      const saved = await client.save({ id: "r3", name: "X", waypoints: WPS, rev: 0, updated: 0 } as Route);
      await settle();
      expect(saved.plan_speed_kn).toBe(DEFAULT_PLAN_SPEED_KN);
      dispose();
    });
  });
});

// The active leg's steering `mode` (#RF-NAVMODE) is threaded off the wire: the
// backend owns it, the client normalises an absent one to "line" (the pre-mode
// behaviour) so a consumer always reads a concrete mode, and a "target" leg is
// carried through untouched for the overlay to draw its yellow cue from.
describe("the active leg's steering mode (#RF-NAVMODE)", () => {
  test("an active leg without a mode is normalised to \"line\"", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend([{ id: "r1", name: "P", waypoints: WPS, rev: 1, updated: 1 }]);
      // An older server sends the leg with no `mode` field at all.
      backend.setActive({ route_id: "r1", waypoint_id: "w1" } as ActiveLeg);
      const client = createRoutesClient({ pollMs: 0, followPollMs: 0 });
      await client.refresh();
      expect(client.active()).toEqual({ route_id: "r1", waypoint_id: "w1", mode: "line" });
      dispose();
    });
  });

  test("a \"target\" mode leg is carried through unchanged", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend([{ id: "r1", name: "P", waypoints: WPS, rev: 1, updated: 1 }]);
      backend.setActive({ route_id: "r1", waypoint_id: "w1", mode: "target" });
      const client = createRoutesClient({ pollMs: 0, followPollMs: 0 });
      await client.refresh();
      expect(client.active()?.mode).toBe("target");
      dispose();
    });
  });
});

// A route's active leg can change on the server without this client asking —
// NavWatcher auto-advances it on arrival, or another device presses GO — and
// this client only learns that from GET /routes. `followPollMs` re-reads the
// store on a short interval, but only while `active()` is non-null, so
// band.top and the route overlay's highlight catch up within a few seconds
// instead of sitting stale until the next general poll.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("polling the active leg while a route is followed", () => {
  test("refresh fires on an interval while following, picking up a server-side change", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend([{ id: "r1", name: "Passage", waypoints: WPS, rev: 1, updated: 1 }]);
      const client = createRoutesClient({ pollMs: 0, followPollMs: 5 });
      await client.refresh();
      expect(client.active()).toBeNull();

      // GO — starts the follow-poll. `mode` is defaulted to "line" on read
      // (#RF-NAVMODE, `withSteerMode`) even though the write omitted it.
      await client.setActive({ route_id: "r1", waypoint_id: "w1" });
      expect(client.active()).toEqual({ route_id: "r1", waypoint_id: "w1", mode: "line" });

      // The server moves the active leg on its own (NavWatcher's
      // auto-advance) — not through this client's setActive.
      backend.setActive({ route_id: "r1", waypoint_id: "w2" });
      await wait(40);
      expect(client.active()).toEqual({ route_id: "r1", waypoint_id: "w2", mode: "line" });

      dispose();
    });
  });

  test("no poll runs when nothing is followed", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend([{ id: "r1", name: "Passage", waypoints: WPS, rev: 1, updated: 1 }]);
      const client = createRoutesClient({ pollMs: 0, followPollMs: 5 });
      await client.refresh();
      expect(client.active()).toBeNull();

      // The server has an active leg (say, from before this client opened),
      // but this client never followed it — the poll must not surface it.
      backend.setActive({ route_id: "r1", waypoint_id: "w1" });
      await wait(40);
      expect(client.active()).toBeNull();

      dispose();
    });
  });

  test("the poll stops when the leg is cleared, and its interval is cleared on dispose", async () => {
    const backend = fakeBackend([{ id: "r1", name: "Passage", waypoints: WPS, rev: 1, updated: 1 }]);
    // `client` is created inside `createRoot` (like every other test here) so
    // its follow-poll effect is owned by the root `dispose` tears down below —
    // built outside, its effect would answer to no owner and `dispose()`
    // would be a no-op on it.
    let client!: RoutesClient;
    let dispose!: () => void;
    await createRoot(async (d) => {
      dispose = d;
      client = createRoutesClient({ pollMs: 0, followPollMs: 5 });
      await client.refresh();
      await client.setActive({ route_id: "r1", waypoint_id: "w1" });
      await wait(20); // let the follow-poll tick a few times

      // Clearing GO stops it — a further server-side change must not reach
      // client.active().
      await client.setActive(null);
      backend.setActive({ route_id: "r1", waypoint_id: "w1" });
      await wait(40);
      expect(client.active()).toBeNull();
    });

    // Re-follow, then dispose the root outright (component unmount) — the
    // interval must not survive to keep polling afterwards.
    await client.setActive({ route_id: "r1", waypoint_id: "w1" });
    await wait(20);
    dispose();
    const callsAtDispose = backend.getCalls;
    await wait(40);
    expect(backend.getCalls).toBe(callsAtDispose);
  });
});

// Each poll used to hand back brand-new route objects, so `<For>` lists keyed
// by identity (RouteList, the palette) rebuilt their rows every 5 s and taps
// landing mid-poll were lost. Unchanged routes must keep their identity; a
// route that really changed must not.
describe("polling keeps identity for unchanged routes", () => {
  const seed = () => [
    { id: "a", name: "A", waypoints: WPS, plan_speed_kn: 5, rev: 1, updated: 1 },
    { id: "b", name: "B", waypoints: WPS, plan_speed_kn: 5, rev: 1, updated: 1 },
  ];

  test("a no-op poll keeps every route object and the array itself", async () => {
    await createRoot(async (dispose) => {
      fakeBackend(seed());
      const client = createRoutesClient({ pollMs: 0, followPollMs: 0 });
      await client.refresh();
      const before = client.routes();
      await client.refresh();
      expect(client.routes()).toBe(before);
      expect(client.routes()[0]).toBe(before[0]);
      expect(client.routes()[1]).toBe(before[1]);
      dispose();
    });
  });

  // What `<For>` does under the hood: rows are mapped once per item identity.
  // No DOM test env here, so this stands in for "a RouteList row's DOM node
  // survives a no-op poll" — a row is only rebuilt when its map fn re-runs.
  test("a <For>-style mapping builds each row once across no-op polls", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend(seed());
      const client = createRoutesClient({ pollMs: 0, followPollMs: 0 });
      const built: string[] = [];
      const rows = mapArray(client.routes, (r) => {
        built.push(r.id);
        return { id: r.id };
      });
      await client.refresh();
      const first = rows();
      expect(built).toEqual(["a", "b"]);
      await client.refresh();
      rows();
      await client.refresh();
      expect(rows()[0]).toBe(first[0]!);
      expect(built).toEqual(["a", "b"]);
      // A real change rebuilds just that row.
      backend.store.set("a", { ...backend.store.get("a"), rev: 2, updated: 2 });
      await client.refresh();
      const after = rows();
      expect(built).toEqual(["a", "b", "a"]);
      expect(after[0]).not.toBe(first[0]!);
      expect(after[1]).toBe(first[1]!);
      dispose();
    });
  });

  test("a rev bump yields a new object for that route only", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend(seed());
      const client = createRoutesClient({ pollMs: 0, followPollMs: 0 });
      await client.refresh();
      const [a0, b0] = client.routes();
      backend.store.set("b", { ...backend.store.get("b"), name: "B2", rev: 2, updated: 2 });
      await client.refresh();
      const [a1, b1] = client.routes();
      expect(a1).toBe(a0);
      expect(b1).not.toBe(b0);
      expect(b1!.name).toBe("B2");
      expect(b1!.rev).toBe(2);
      dispose();
    });
  });

  test("changed content under the same rev still yields a new object", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend(seed());
      const client = createRoutesClient({ pollMs: 0, followPollMs: 0 });
      await client.refresh();
      const a0 = client.routes()[0];
      backend.store.set("a", { ...backend.store.get("a"), name: "A-renamed" });
      await client.refresh();
      expect(client.routes()[0]).not.toBe(a0);
      expect(client.routes()[0]!.name).toBe("A-renamed");
      dispose();
    });
  });

  test("a deleted route drops out and the array changes", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend(seed());
      const client = createRoutesClient({ pollMs: 0, followPollMs: 0 });
      await client.refresh();
      const before = client.routes();
      backend.store.delete("a");
      await client.refresh();
      expect(client.routes()).not.toBe(before);
      expect(client.routes().map((r) => r.id)).toEqual(["b"]);
      expect(client.routes()[0]).toBe(before[1]);
      dispose();
    });
  });

  test("the active leg keeps identity until it really moves", async () => {
    await createRoot(async (dispose) => {
      const backend = fakeBackend(seed());
      const client = createRoutesClient({ pollMs: 0, followPollMs: 0 });
      backend.setActive({ route_id: "a", waypoint_id: "w1" });
      await client.refresh();
      const leg = client.active();
      await client.refresh();
      expect(client.active()).toBe(leg);
      backend.setActive({ route_id: "a", waypoint_id: "w2" });
      await client.refresh();
      expect(client.active()).not.toBe(leg);
      expect(client.active()?.waypoint_id).toBe("w2");
      dispose();
    });
  });
});
