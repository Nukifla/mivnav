// THE TRACK CLIENT'S TWO RULES, both about NOT asking:
//
//  (a) it asks nothing at all while the overlay is off — the endpoint costs the
//      boat's SignalK box a database query, and the track is off by default;
//  (b) it stops asking, permanently, once the server says this boat keeps no
//      history (501) — while any OTHER failure leaves the poll running, because
//      those are the ones that come back.
//
// Plus the reactive plumbing those two ride on: turning the overlay on fetches
// at once, a window change refetches at once, and turning it off clears the
// drawn line rather than leaving a stale one to flash on re-enable.

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createTrackClient, TrackUnsupported, type Track } from "./client";

const track = (n: number, complete = true): Track => ({
  lines: [Array.from({ length: n }, (_, i) => [12 + i * 0.01, 55] as [number, number])],
  recent: [],
  from: "2026-07-29T06:00:00Z",
  to: "2026-07-29T12:00:00Z",
  last: "2026-07-29T11:59:50Z",
  complete,
});
const points = (t: Track) => t.lines.flat().length;

/** A client whose fetch records every window it was asked for. */
function harness(opts: { enabled?: boolean; hours?: number; fetch?: (h: number) => Promise<Track> } = {}) {
  return createRoot((dispose) => {
    const [enabled, setEnabled] = createSignal(opts.enabled ?? true);
    const [hours, setHours] = createSignal(opts.hours ?? 6);
    const asked: number[] = [];
    const load = opts.fetch ?? (async () => track(3));
    const client = createTrackClient({
      enabled,
      hours,
      pollMs: 10_000, // long enough that no test races the interval
      fetch: (h) => {
        asked.push(h);
        return load(h);
      },
    });
    return { client, asked, setEnabled, setHours, dispose };
  });
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("(a) it only asks while the overlay is on", () => {
  test("disabled: no request is ever made", async () => {
    const h = harness({ enabled: false });
    await settle();
    expect(h.asked).toEqual([]);
    h.dispose();
  });

  test("turning it on fetches immediately, not on the next tick of a poll", async () => {
    const h = harness({ enabled: false });
    h.setEnabled(true);
    await settle();
    expect(h.asked).toEqual([6]);
    expect(points(h.client.track())).toBe(3);
    h.dispose();
  });

  test("turning it off clears the line so re-enabling never flashes a stale one", async () => {
    const h = harness();
    await settle();
    expect(points(h.client.track())).toBe(3);
    h.setEnabled(false);
    expect(h.client.track().lines).toEqual([]);
    h.dispose();
  });

  test("a window change refetches at once, with the new window", async () => {
    const h = harness();
    await settle();
    h.setHours(24);
    await settle();
    expect(h.asked).toEqual([6, 24]);
    h.dispose();
  });
});

describe("(b) a boat with no history is asked once, not forever", () => {
  test("501 latches `supported` false and stops the polling", async () => {
    const h = harness({
      fetch: async () => {
        throw new TrackUnsupported("no history provider");
      },
    });
    await settle();
    expect(h.asked.length).toBe(1);
    expect(h.client.supported()).toBe(false);
    // Even an explicit refetch is a no-op now: there is nothing to ask.
    h.client.refetch();
    await settle();
    expect(h.asked.length).toBe(1);
    h.dispose();
  });

  test("any other failure leaves `supported` alone — those come back", async () => {
    const h = harness({
      fetch: async () => {
        throw new Error("502 the box is down");
      },
    });
    await settle();
    expect(h.client.supported()).toBe(true);
    // And the last good data is not wiped by a failed poll.
    expect(h.client.track().lines).toEqual([]);
    h.client.refetch();
    await settle();
    expect(h.asked.length).toBe(2);
    h.dispose();
  });
});

describe("the poll", () => {
  test("an incomplete answer is followed up at once, a complete one is not", async () => {
    const answers = [track(1, false), track(2, false), track(3, true)];
    const h = harness({ fetch: async () => answers.shift() ?? track(3) });
    await new Promise((r) => setTimeout(r, 2_500));
    // Two follow-ups at FILL_MS, then the long (10 s test) period.
    expect(h.asked.length).toBe(3);
    expect(points(h.client.track())).toBe(3);
    h.dispose();
  });

  test("a stale response from the previous window is dropped", async () => {
    let release!: (t: Track) => void;
    const slow = new Promise<Track>((r) => (release = r));
    const h = harness({ fetch: (hrs) => (hrs === 6 ? slow : Promise.resolve(track(5))) });
    await settle();
    h.setHours(24);
    await settle();
    release(track(9));
    await settle();
    expect(points(h.client.track())).toBe(5);
    h.dispose();
  });
});
