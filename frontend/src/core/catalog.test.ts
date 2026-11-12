/**
 * The catalog client's one job on a boat: never leave the plotter chartless
 * and silent.
 *
 * The bug this pins: the app fetched /catalog exactly once, and a single
 * failure — a transient 500, a backend still warming up, vite's dev proxy
 * answering a dropped upstream connection with a bare 500 — logged to the
 * console and left the map blank forever. Blank is also what "there are no
 * charts installed" looks like, so the mariner had no way to tell a broken
 * plotter from an empty one, and no way back but a page reload. At night,
 * at sea, that is the worst failure this app has.
 *
 * The delay is injected, so the backoff is asserted by its *schedule* rather
 * than by sleeping: a test that waits 30 real seconds for the cap would be
 * deleted by the first person in a hurry.
 *
 * NB: needs `--conditions=browser` (see the `test` script). Bare `bun test`
 * resolves solid-js's `node` export — the SSR build — and every reactive
 * assertion here would pass vacuously. That matters more here than anywhere:
 * this file tests an async retry loop.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  ATTEMPT_TIMEOUT_MAX_MS,
  ATTEMPT_TIMEOUT_MS,
  createCatalog,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  type ChartSet,
} from "./catalog";

const SET: ChartSet = {
  id: "US5OAKIQ",
  name: "Oakland Inner Harbor",
  bounds: [-122.4, 37.7, -122.2, 37.9],
  min_zoom: 10,
  max_zoom: 16,
  sequence: 1,
  tiles: "/tiles/US5OAKIQ/{z}/{x}/{y}",
  vector_layers: [{ id: "DEPARE", minzoom: 0, maxzoom: 16, fields: {} }],
};

/**
 * A backend under a script's control, plus the clock the retry loop sleeps
 * on. `delays` is the schedule the loop actually asked for — the backoff is
 * read off it, and nothing here waits.
 */
function harness(script: (() => Promise<ChartSet[]>)[]) {
  const delays: number[] = [];
  let pending: (() => void) | null = null;
  let calls = 0;
  return {
    delays,
    get calls() {
      return calls;
    },
    fetch: () => {
      const step = script[Math.min(calls, script.length - 1)];
      calls++;
      return step();
    },
    delay: (ms: number) =>
      new Promise<void>((resolve) => {
        delays.push(ms);
        pending = resolve;
      }),
    /** Let the pending backoff expire, and settle the fetch it starts. */
    tick: async () => {
      const resume = pending;
      pending = null;
      resume?.();
      await flush();
    },
  };
}

/** Drain the microtask queue: the loop is promises all the way down. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const fails = (status: number) => () =>
  Promise.reject(new Error(`catalog: HTTP ${status}`)) as Promise<ChartSet[]>;
const serves = (...sets: ChartSet[]) => () => Promise.resolve(sets);

describe("createCatalog", () => {
  test("a failure schedules a retry the splash can count down to", async () => {
    await createRoot(async (dispose) => {
      const h = harness([fails(502), serves(SET)]);
      const catalog = createCatalog({ fetch: h.fetch, delay: h.delay });
      const before = Date.now();
      await flush();

      const at = catalog.nextRetryAt();
      expect(at).toBeDefined();
      expect(at! - before).toBeGreaterThanOrEqual(RETRY_MIN_MS);
      expect(at! - Date.now()).toBeLessThanOrEqual(RETRY_MIN_MS);

      await h.tick();
      // Arrived: nothing is scheduled any more.
      expect(catalog.sets()).toEqual([SET]);
      expect(catalog.nextRetryAt()).toBeUndefined();
      dispose();
    });
  });

  test("each attempt gets longer to answer, so a slow Pi isn't cut off at the same point forever", async () => {
    await createRoot(async (dispose) => {
      const timeouts: number[] = [];
      const h = harness([fails(500)]);
      createCatalog({
        fetch: (timeoutMs) => {
          timeouts.push(timeoutMs);
          return h.fetch();
        },
        delay: h.delay,
      });
      await flush();
      for (let i = 0; i < 5; i++) await h.tick();

      expect(timeouts[0]).toBe(ATTEMPT_TIMEOUT_MS);
      expect(timeouts[1]).toBe(ATTEMPT_TIMEOUT_MS * 2);
      expect(Math.max(...timeouts)).toBe(ATTEMPT_TIMEOUT_MAX_MS);
      dispose();
    });
  });

  test("a transient 500 is not terminal: the chart arrives on the retry", async () => {
    await createRoot(async (dispose) => {
      const h = harness([fails(500), serves(SET)]);
      const catalog = createCatalog({ fetch: h.fetch, delay: h.delay });
      await flush();

      // The reproduction: one 500, and the old client stopped here forever.
      expect(catalog.sets()).toEqual([]);
      expect(catalog.error()).toContain("500");

      await h.tick();
      expect(catalog.sets()).toEqual([SET]);
      // ...and the failure state clears itself, without a page reload.
      expect(catalog.error()).toBe("");
      dispose();
    });
  });

  test("a backend that is down for a while is backed off, not hammered", async () => {
    await createRoot(async (dispose) => {
      const h = harness([fails(500)]);
      createCatalog({ fetch: h.fetch, delay: h.delay });
      await flush();

      for (let i = 0; i < 10; i++) await h.tick();

      // Exponential from RETRY_MIN_MS, capped — never a tight loop, and
      // never a retry that outlives the mariner's patience either.
      expect(h.delays[0]).toBe(RETRY_MIN_MS);
      expect(h.delays[1]).toBe(RETRY_MIN_MS * 2);
      expect(h.delays[2]).toBe(RETRY_MIN_MS * 4);
      expect(Math.max(...h.delays)).toBe(RETRY_MAX_MS);
      expect(h.delays.every((ms) => ms >= RETRY_MIN_MS)).toBe(true);
      // One request per delay: the loop is serial, never overlapping.
      expect(h.calls).toBe(h.delays.length);
      dispose();
    });
  });

  test("it recovers after a long outage — the backoff cap is not a give-up", async () => {
    await createRoot(async (dispose) => {
      const script = Array.from({ length: 12 }, () => fails(503));
      const h = harness([...script, serves(SET)]);
      const catalog = createCatalog({ fetch: h.fetch, delay: h.delay });
      await flush();

      // Long enough that the backoff is pinned at its cap and staying there.
      for (let i = 0; i < 11; i++) await h.tick();
      expect(catalog.sets()).toEqual([]);
      expect(h.delays.at(-1)).toBe(RETRY_MAX_MS);

      await h.tick(); // the backend comes back
      expect(catalog.sets()).toEqual([SET]);
      expect(catalog.error()).toBe("");
      dispose();
    });
  });

  test("'the charts failed to load' is not 'there are no charts here'", async () => {
    await createRoot(async (dispose) => {
      // These two look identical on a blank map, and the whole point of the
      // failure state is that they must not look identical to the mariner.
      const broken = harness([fails(500)]);
      const failed = createCatalog({ fetch: broken.fetch, delay: broken.delay });
      const bare = harness([serves()]);
      const empty = createCatalog({ fetch: bare.fetch, delay: bare.delay });
      await flush();

      expect(failed.sets()).toEqual([]);
      expect(empty.sets()).toEqual([]);
      // ...and only one of them is a fault.
      expect(failed.error()).not.toBe("");
      expect(empty.error()).toBe("");
      dispose();
    });
  });

  test("refresh() retries at once, rather than waiting out the backoff", async () => {
    await createRoot(async (dispose) => {
      const h = harness([fails(500), fails(500), serves(SET)]);
      const catalog = createCatalog({ fetch: h.fetch, delay: h.delay });
      await flush();
      await h.tick();
      expect(h.calls).toBe(2);

      // The mariner taps Retry. It must not queue behind a 30 s sleep.
      catalog.refresh();
      await flush();
      expect(h.calls).toBe(3);
      expect(catalog.sets()).toEqual([SET]);
      dispose();
    });
  });

  test("refresh() replaces the running loop rather than racing a second one", async () => {
    await createRoot(async (dispose) => {
      const h = harness([fails(500)]);
      const catalog = createCatalog({ fetch: h.fetch, delay: h.delay });
      await flush();

      const before = h.calls;
      catalog.refresh();
      catalog.refresh();
      await flush();
      // Two taps, two fetches — not two loops each retrying forever, which
      // is how a Retry button turns an outage into a self-inflicted DoS.
      expect(h.calls).toBe(before + 2);
      const delaysAfter = h.delays.length;
      await h.tick();
      expect(h.calls).toBe(before + 3);
      expect(h.delays.length).toBe(delaysAfter + 1);
      dispose();
    });
  });

  test("a failed refetch keeps the chart that is already on screen", async () => {
    await createRoot(async (dispose) => {
      const h = harness([serves(SET), fails(500)]);
      const catalog = createCatalog({ fetch: h.fetch, delay: h.delay });
      await flush();
      expect(catalog.sets()).toEqual([SET]);

      catalog.refresh(); // e.g. after an install; the backend hiccups
      await flush();
      // The catalog we have is stale, not wrong. Blanking the plotter over a
      // failed *refresh* would be the bug this file exists to kill, inverted.
      expect(catalog.sets()).toEqual([SET]);
      expect(catalog.error()).toContain("500");
      dispose();
    });
  });

  test("dispose stops the retry loop", async () => {
    await createRoot(async (dispose) => {
      const h = harness([fails(500)]);
      createCatalog({ fetch: h.fetch, delay: h.delay });
      await flush();
      const calls = h.calls;
      dispose();
      await h.tick();
      // A closed tab must not keep asking the boat's server for a catalog.
      expect(h.calls).toBe(calls);
    });
  });
});
