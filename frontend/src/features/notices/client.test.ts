// The notices client: INERT when off (no status poll, no clock), polls the
// tiny status while on, fetches the map GeoJSON only when the snapshot
// `version` moves, and keeps the last good map through a failed fetch.
//
// NB: run with `--conditions=browser` (`bun run test`).

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import MAP from "./fixtures/map.json";
import STATUS from "./fixtures/status.json";
import { CLOCK_MS, createNoticesClient, fetchNoticesMap, fetchNoticesStatus, nextPollMs } from "./client";
import type { NoticesMap, NoticesStatus } from "./types";

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(opts: { on?: boolean; status?: () => NoticesStatus | undefined; map?: () => NoticesMap | undefined } = {}) {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const statusCalls: number[] = [];
  const mapCalls: string[] = [];
  let status = opts.status ?? (() => STATUS as NoticesStatus);
  let map = opts.map ?? (() => MAP as unknown as NoticesMap);
  let clock = 1791028800000 + 15_000; // 15 s past a minute
  const [on, setOn] = createSignal(opts.on ?? true);
  let dispose!: () => void;
  const client = createRoot((d) => {
    dispose = d;
    return createNoticesClient({
      enabled: on,
      fetchStatus: async () => {
        statusCalls.push(clock);
        return status();
      },
      fetchMap: async (v) => {
        mapCalls.push(v);
        return map();
      },
      schedule: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
      now: () => clock,
    });
  });
  const live = () => timers.filter((t) => !t.cancelled);
  /** Fire every live timer once (cancelling it), like time passing. */
  const fire = async (pred: (t: { ms: number }) => boolean = () => true) => {
    for (const t of live().filter(pred)) {
      t.cancelled = true;
      t.fn();
    }
    await flush();
  };
  return {
    client,
    setOn,
    dispose,
    timers: live,
    fire,
    statusCalls,
    mapCalls,
    setStatus: (f: () => NoticesStatus | undefined) => (status = f),
    setMap: (f: () => NoticesMap | undefined) => (map = f),
    advance: (ms: number) => (clock += ms),
  };
}

describe("inert when off", () => {
  test("off from the start: no status request, no timer, no data", async () => {
    const h = harness({ on: false });
    await flush();
    expect(h.statusCalls).toEqual([]);
    expect(h.mapCalls).toEqual([]);
    expect(h.timers()).toEqual([]);
    expect(h.client.status()).toBeUndefined();
    h.dispose();
  });

  test("turning off cancels the poll and the clock", async () => {
    const h = harness();
    await flush();
    expect(h.timers().length).toBe(2); // poll + clock
    h.setOn(false);
    expect(h.timers()).toEqual([]);
    expect(h.client.status()).toBeUndefined();
    h.dispose();
  });
});

describe("a late answer", () => {
  test("a status that lands after the toggle went off is dropped (no map fetch, no timer)", async () => {
    let release!: (s: NoticesStatus) => void;
    const [on, setOn] = createSignal(true);
    const mapCalls: string[] = [];
    const timers: number[] = [];
    let dispose!: () => void;
    const client = createRoot((d) => {
      dispose = d;
      return createNoticesClient({
        enabled: on,
        fetchStatus: () => new Promise<NoticesStatus>((r) => (release = r)),
        fetchMap: async (v) => {
          mapCalls.push(v);
          return MAP as unknown as NoticesMap;
        },
        schedule: (_fn, ms) => {
          timers.push(ms);
          return () => {};
        },
      });
    });
    setOn(false);
    const scheduled = timers.length; // just the clock tick from switching on
    release(STATUS as NoticesStatus);
    await flush();
    expect(client.status()).toBeUndefined();
    expect(mapCalls).toEqual([]);
    expect(timers.length).toBe(scheduled);
    dispose();
  });
});

describe("polling", () => {
  test("on: asks status at once, then the map for its version", async () => {
    const h = harness();
    await flush();
    expect(h.statusCalls.length).toBe(1);
    expect(h.mapCalls).toEqual([STATUS.version]);
    expect(h.client.data()?.features.length).toBe(MAP.features.length);
    expect(h.client.version()).toBe(STATUS.version);
    h.dispose();
  });

  test("the same version again fetches no map; a new version does", async () => {
    const h = harness();
    await flush();
    await h.fire((t) => t.ms === nextPollMs("ready"));
    expect(h.statusCalls.length).toBe(2);
    expect(h.mapCalls.length).toBe(1);
    h.setStatus(() => ({ ...(STATUS as NoticesStatus), version: "v2" }));
    await h.fire((t) => t.ms === nextPollMs("ready"));
    expect(h.mapCalls).toEqual([STATUS.version, "v2"]);
    expect(h.client.version()).toBe("v2");
    h.dispose();
  });

  test("a failed map fetch keeps the last good data and retries next poll", async () => {
    const h = harness();
    await flush();
    const good = h.client.data();
    h.setStatus(() => ({ ...(STATUS as NoticesStatus), version: "v2" }));
    h.setMap(() => undefined);
    await h.fire((t) => t.ms === nextPollMs("ready"));
    expect(h.client.data()).toBe(good);
    expect(h.client.version()).toBe(STATUS.version);
    h.setMap(() => MAP as unknown as NoticesMap);
    await h.fire((t) => t.ms === nextPollMs("ready"));
    expect(h.client.version()).toBe("v2");
    h.dispose();
  });

  test("backend down (no status): keeps polling at the slow rate, no map request", async () => {
    const h = harness({ status: () => undefined });
    await flush();
    expect(h.mapCalls).toEqual([]);
    expect(h.timers().some((t) => t.ms === 60_000)).toBe(true);
    h.dispose();
  });

  test("poll period follows the backend's state", () => {
    expect(nextPollMs("loading")).toBeLessThan(nextPollMs("idle"));
    expect(nextPollMs("idle")).toBeLessThan(nextPollMs("ready"));
    expect(nextPollMs("offline")).toBe(nextPollMs("ready"));
  });

  test("poll() while a request is in flight does not start a second loop", async () => {
    const h = harness();
    h.client.poll();
    h.client.poll();
    await flush();
    expect(h.statusCalls.length).toBe(1);
    expect(h.timers().filter((t) => t.ms !== 45_000).length).toBe(1);
    h.dispose();
  });
});

describe("the minute clock", () => {
  test("ticks on the next minute boundary, then every minute", async () => {
    const h = harness();
    await flush();
    const tick = h.timers().find((t) => t.ms === 45_000); // 15 s past → 45 s to go
    expect(tick).toBeDefined();
    h.advance(45_000);
    await h.fire((t) => t.ms === 45_000);
    expect(h.client.now() % CLOCK_MS).toBe(0);
    expect(h.timers().some((t) => t.ms === CLOCK_MS)).toBe(true);
    h.dispose();
  });
});

describe("the HTTP seams", () => {
  test("status and map hit /api/notices, the map with a version cache-buster", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.includes("status") ? STATUS : MAP));
    }) as unknown as typeof fetch;
    expect((await fetchNoticesStatus(fake))?.version).toBe(STATUS.version);
    expect((await fetchNoticesMap("v 1", fake))?.type).toBe("FeatureCollection");
    expect(urls).toEqual(["/api/notices/status", "/api/notices/map.geojson?v=v%201"]);
  });

  test("a 404 (routes not deployed) or a network error is undefined, never a throw", async () => {
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const down = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchNoticesStatus(notFound)).toBeUndefined();
    expect(await fetchNoticesStatus(down)).toBeUndefined();
  });
});
