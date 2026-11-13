import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot, createSignal, For } from "solid-js";
import type { ChartSet } from "./catalog";
import {
  createOchartsDevice,
  defaultDeviceName,
  DISCONNECT_GRACE_MS,
  FAST_POLL_MS,
  POLL_MS,
  serverReachableAt,
  drawableSets,
  pendingEulaIds,
  seenText,
  shouldPrompt,
  unionFor,
  type DeviceStatus,
} from "./ochartsDevice";

function status(over: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    gate: true,
    max: 5,
    count: 0,
    registered: false,
    removed: false,
    allowed: false,
    device: null,
    eulas: [{ id: "e1", sets: ["Denmark 2026"], accepted: false }],
    ...over,
  };
}

const ALLOWED = status({ registered: true, allowed: true, count: 1 });

describe("which union a screen draws", () => {
  test("all until the first answer, and whenever nothing is enforced", () => {
    expect(unionFor(undefined)).toBe("all");
    expect(unionFor(status({ gate: false, allowed: true }))).toBe("all");
    expect(unionFor(ALLOWED)).toBe("all");
  });

  test("free while a licensed set is installed and this screen may not show it", () => {
    expect(unionFor(status())).toBe("free");
    // registered, but a changed EULA is not accepted yet
    expect(unionFor(status({ registered: true, allowed: false }))).toBe("free");
  });

  test("the free style leaves the licensed sets out", () => {
    const sets = [
      { id: "oc", licensed: true },
      { id: "fnc", licensed: false },
      { id: "pm" },
    ] as ChartSet[];
    expect(drawableSets(sets, "free").map((s) => s.id)).toEqual(["fnc", "pm"]);
    expect(drawableSets(sets, "all")).toBe(sets);
  });
});

describe("the prompt", () => {
  test("opens once per launch, never after don't-show-again, only when needed", () => {
    expect(shouldPrompt(status(), false, false)).toBe(true);
    expect(shouldPrompt(status(), true, false)).toBe(false);
    expect(shouldPrompt(status(), false, true)).toBe(false);
    expect(shouldPrompt(status({ gate: false, allowed: true }), false, false)).toBe(false);
    expect(shouldPrompt(ALLOWED, false, false)).toBe(false);
    expect(shouldPrompt(undefined, false, false)).toBe(false);
  });
});

describe("default device names", () => {
  const IPAD_SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  test.each([
    [IPAD_SAFARI, true, false, "iPad · Safari"],
    [IPAD_SAFARI, false, false, "Mac · Safari"],
    [IPAD_SAFARI, true, true, "iPad · Safari app"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1",
      true,
      false,
      "iPhone · Chrome",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      true,
      false,
      "Android tablet · Chrome",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0",
      false,
      false,
      "Windows · Edge",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0", false, false, "Linux · Firefox"],
  ])("%s", (ua, touch, standalone, expected) => {
    expect(defaultDeviceName(ua, touch, standalone)).toBe(expected);
  });
});

test("last-used text reads the server's age, coarsely", () => {
  expect(seenText(30)).toBe("In use now");
  expect(seenText(10 * 60)).toBe("Last used 10 min ago");
  expect(seenText(5 * 3600)).toBe("Last used 5 h ago");
  expect(seenText(5 * 86400)).toBe("Last used 5 days ago");
});

describe("the controller", () => {
  // bun has no localStorage, and shares one globalThis across the run (see
  // persist.test.ts): install a fresh one per test, then take it away.
  beforeEach(() => {
    const items = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, String(v)),
      removeItem: (k: string) => void items.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  function fakeServer(answers: DeviceStatus[]) {
    const calls: string[] = [];
    let i = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const body = url.endsWith("/devices/me") ? answers[Math.min(i++, answers.length - 1)] : answers.at(-1);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  test("opens the prompt once on the first refusal, not again on the next poll", async () => {
    const { fetchImpl } = fakeServer([status(), status()]);
    const d = createOchartsDevice({ fetch: fetchImpl, clearTiles: () => {} });
    await d.refresh();
    expect(d.promptOpen()).toBe(true);
    d.closePrompt();
    await d.refresh();
    expect(d.promptOpen()).toBe(false);
    expect(d.union()).toBe("free");
  });

  test("don't show again sticks across launches", async () => {
    const { fetchImpl } = fakeServer([status()]);
    const first = createOchartsDevice({ fetch: fetchImpl, clearTiles: () => {} });
    await first.refresh();
    first.hidePromptForever();
    const second = createOchartsDevice({ fetch: fetchImpl, clearTiles: () => {} });
    await second.refresh();
    expect(second.promptOpen()).toBe(false);
    // Settings can still open it by hand.
    second.openPrompt();
    expect(second.promptOpen()).toBe(true);
  });

  test("losing the slot while running drops the cached tiles", async () => {
    let cleared = 0;
    const { fetchImpl } = fakeServer([ALLOWED, ALLOWED, status()]);
    const d = createOchartsDevice({ fetch: fetchImpl, clearTiles: () => cleared++ });
    await d.refresh();
    await d.refresh();
    expect(cleared).toBe(0);
    await d.refresh();
    expect(cleared).toBe(1);
    expect(d.union()).toBe("free");
  });

  test("learning at boot that another screen removed this one drops them too", async () => {
    let cleared = 0;
    const { fetchImpl } = fakeServer([status({ removed: true })]);
    const d = createOchartsDevice({ fetch: fetchImpl, clearTiles: () => cleared++ });
    await d.refresh();
    expect(cleared).toBe(1);
  });

  test("a refused registration surfaces the server's reason", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: "all device slots are taken; remove one first" }), {
        status: 409,
      })) as unknown as typeof fetch;
    const d = createOchartsDevice({ fetch: fetchImpl, clearTiles: () => {} });
    await expect(d.register("Phone", ["e1"])).rejects.toThrow("all device slots are taken");
  });

  test("an unreachable server keeps the last answer", async () => {
    let up = true;
    const fetchImpl = (async () => {
      if (!up) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(ALLOWED), { status: 200 });
    }) as unknown as typeof fetch;
    const d = createOchartsDevice({ fetch: fetchImpl, clearTiles: () => {} });
    await d.refresh();
    up = false;
    await d.refresh();
    expect(d.union()).toBe("all");
  });
});

describe("no o-charts without a live connection (licence, plan W2)", () => {
  test("unreachable only after the grace period, on either sign", () => {
    const G = DISCONNECT_GRACE_MS;
    expect(G).toBe(20_000);
    expect(serverReachableAt(100_000, null, null)).toBe(true);
    expect(serverReachableAt(100_000, 100_000 - G, null)).toBe(true); // a blip: not yet
    expect(serverReachableAt(100_000, 100_000 - G - 1, null)).toBe(false);
    expect(serverReachableAt(100_000, null, 100_000 - G - 1)).toBe(false);
    expect(unionFor(ALLOWED, false)).toBe("free");
    expect(unionFor(undefined, false)).toBe("free");
  });

  // A controller on a fake clock and tick timer, with a server that can be
  // switched off, and the backend websocket's `linkDownSince` as a signal.
  function harness() {
    let t = 1_000_000;
    let up = true;
    let polls = 0;
    let tick: () => void = () => {};
    const [link, setLink] = createSignal<number | null>(null);
    const fetchImpl = (async () => {
      polls++;
      if (!up) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(ALLOWED), { status: 200 });
    }) as unknown as typeof fetch;
    let cleared = 0;
    const d = createOchartsDevice({
      fetch: fetchImpl,
      clearTiles: () => cleared++,
      now: () => t,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {},
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    /** Advance the clock second by second, as the real 1 s tick would. */
    const advance = async (ms: number) => {
      for (let i = 0; i < ms / 1000; i++) {
        t += 1000;
        tick();
        await flush();
      }
    };
    return {
      d,
      link,
      setLink,
      advance,
      flush,
      now: () => t,
      setUp: (v: boolean) => (up = v),
      polls: () => polls,
      cleared: () => cleared,
    };
  }

  test("websocket down past the grace period → free; back up → all", async () => {
    const h = harness();
    const stop = h.d.start(h.link);
    await h.flush();
    expect(h.d.union()).toBe("all");

    h.setUp(false);
    h.setLink(h.now());
    await h.advance(DISCONNECT_GRACE_MS);
    expect(h.d.serverReachable()).toBe(true); // still within the grace
    expect(h.d.union()).toBe("all");
    await h.advance(2_000);
    expect(h.d.serverReachable()).toBe(false);
    expect(h.d.union()).toBe("free");
    // Not the slot-loss path: the SW tile cache (free tiles only) is kept.
    expect(h.cleared()).toBe(0);

    // While lost it probes every few seconds, not once a minute.
    const before = h.polls();
    await h.advance(4 * FAST_POLL_MS);
    expect(h.polls() - before).toBeGreaterThanOrEqual(3);

    h.setUp(true);
    h.setLink(null);
    await h.advance(FAST_POLL_MS);
    expect(h.d.serverReachable()).toBe(true);
    expect(h.d.union()).toBe("all");
    stop();
  });

  test("the status poll failing past the grace period → free, even with no websocket", async () => {
    const h = harness();
    const stop = h.d.start(); // no link wired: the poll alone decides
    await h.flush();
    h.setUp(false);
    await h.advance(POLL_MS); // the next slow poll is the first to fail
    expect(h.d.union()).toBe("all");
    await h.advance(DISCONNECT_GRACE_MS + FAST_POLL_MS);
    expect(h.d.union()).toBe("free");
    h.setUp(true);
    await h.advance(FAST_POLL_MS);
    expect(h.d.union()).toBe("all");
    stop();
  });

  test("a proxy's 502 for a stopped backend is a failure, not contact", async () => {
    let t = 0;
    const fetchImpl = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const d = createOchartsDevice({ fetch: fetchImpl, clearTiles: () => {}, now: () => t });
    await d.refresh();
    t += DISCONNECT_GRACE_MS + 1;
    await d.refresh();
    expect(d.union()).toBe("free");
  });
});

describe("the prompt's EULA frames", () => {
  test("keyed by id: a poll's fresh status object does not remount a frame", () => {
    const [st, setSt] = createSignal<DeviceStatus>(status());
    let mounts = 0;
    createRoot((dispose) => {
      // What DeviceRegistration renders: <For each={pendingEulaIds(status())}>.
      const frames = For({
        get each() {
          return pendingEulaIds(st());
        },
        children: (id: string) => {
          mounts++;
          return id;
        },
      });
      expect(frames()).toEqual(["e1"]);
      for (let i = 0; i < 3; i++) {
        // A 60 s poll: equal content, all-new objects.
        setSt(status({ eulas: [{ id: "e1", sets: ["Denmark 2026"], accepted: false }] }));
        expect(frames()).toEqual(["e1"]);
      }
      expect(mounts).toBe(1);
      setSt(status({ eulas: [{ id: "e1", sets: ["Denmark 2026"], accepted: true }] }));
      expect(frames()).toEqual([]);
      dispose();
    });
  });
});
