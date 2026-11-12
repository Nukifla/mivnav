// THE LIVE TAIL: the boat's own positions drawn on the end of the track between
// polls. What it must get right is the seam with history — never a gap the
// boat did sail, never a line across water it did not, never the same stretch
// twice — and that it ends exactly at the latest fix.

import { describe, expect, test } from "bun:test";
import type { TrackCoordinate } from "./client";
import {
  appendLive,
  coveredUntil,
  distanceM,
  MAX_LIVE,
  trimLive,
  withLiveTail,
  type LivePoint,
} from "./live";

/** ~`m` metres east of 12°E, 55°N. */
const east = (m: number): TrackCoordinate => [12 + m / (111_320 * Math.cos((55 * Math.PI) / 180)), 55];
const at = (t: number, m: number): LivePoint => ({ t, c: east(m) });

describe("appendLive", () => {
  test("a boat under way adds its positions", () => {
    let tail: readonly LivePoint[] = [];
    for (let i = 0; i < 5; i++) tail = appendLive(tail, at(i * 1000, i * 3));
    expect(tail.length).toBe(5);
  });

  test("every new fix is added, however close — the line ends at the boat", () => {
    expect(appendLive([at(0, 0)], at(1000, 0.3)).length).toBe(2);
  });

  test("the same fix again adds nothing: same array back", () => {
    const tail = [at(0, 0)];
    expect(appendLive(tail, at(1000, 0))).toBe(tail);
  });

  test("a hop faster than any boat is a bad fix, dropped", () => {
    const tail = [at(0, 0)];
    expect(appendLive(tail, at(1000, 500))).toBe(tail);
  });

  test("bounded: the oldest go first", () => {
    let tail: readonly LivePoint[] = [];
    for (let i = 0; i < MAX_LIVE + 10; i++) tail = appendLive(tail, at(i * 1000, i * 3));
    expect(tail.length).toBe(MAX_LIVE);
    expect(tail[0]!.t).toBe(10_000);
  });
});

describe("coveredUntil", () => {
  test("history 10 s behind its own now reaches 10 s before the answer landed", () => {
    const t = { to: "2026-10-02T12:00:10Z", last: "2026-10-02T12:00:00Z" };
    expect(coveredUntil(t, 50_000)).toBe(40_000);
  });

  test("a last fix 'after' now (clock skew) is no lag, not negative lag", () => {
    const t = { to: "2026-10-02T12:00:00Z", last: "2026-10-02T12:00:05Z" };
    expect(coveredUntil(t, 50_000)).toBe(50_000);
  });

  test("no fix in the answer: nothing to measure from", () => {
    expect(coveredUntil({ to: "2026-10-02T12:00:00Z", last: null }, 1)).toBeNull();
  });
});

describe("trimLive", () => {
  const tail = [at(1000, 0), at(2000, 3), at(3000, 6)];
  test("drops what history now holds", () => {
    expect(trimLive(tail, 2000).map((p) => p.t)).toEqual([3000]);
  });
  test("keeps everything when history reaches nothing", () => {
    expect(trimLive(tail, null)).toBe(tail);
  });
  test("history past the whole tail empties it", () => {
    expect(trimLive(tail, 5000)).toEqual([]);
  });
});

describe("withLiveTail", () => {
  const recent = [[east(0), east(30)]];

  test("continues the newest line from its last fix", () => {
    const out = withLiveTail(recent, [at(11_000, 33), at(12_000, 36)], 10_000);
    expect(out.length).toBe(1);
    expect(out[0]!.slice(-3)).toEqual([east(30), east(33), east(36)]);
  });

  test("does not mutate what the client holds", () => {
    withLiveTail(recent, [at(11_000, 33), at(12_000, 36)], 10_000);
    expect(recent[0]!.length).toBe(2);
  });

  test("a hop the boat could not have made is its own line, not a join", () => {
    const out = withLiveTail(recent, [at(11_000, 5_000), at(12_000, 5_003)], 10_000);
    expect(out.length).toBe(2);
    expect(distanceM(out[1]![0]!, east(5_000))).toBeLessThan(0.01);
  });

  test("no history yet: the tail alone", () => {
    expect(withLiveTail([], [at(1, 0), at(2, 3)], null)).toEqual([[east(0), east(3)]]);
  });

  test("no tail: history as it was", () => {
    expect(withLiveTail(recent, [], 10_000)).toEqual(recent.map((l) => [...l]));
  });
});
