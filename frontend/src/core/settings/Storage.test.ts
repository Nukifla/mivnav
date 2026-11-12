/**
 * `diskSegments` — the pure split behind the Storage section's disk bar
 * (mivnav's own bytes / other used / free, as % of the whole disk).
 */

import { describe, expect, test } from "bun:test";
import { diskSegments } from "./Storage";

const disk = (total: number, used: number, free: number) => ({ path: "/d", total, used, free });

describe("diskSegments", () => {
  test("splits used into mivnav and other, plus free", () => {
    expect(diskSegments(disk(1000, 600, 400), 200)).toEqual({ mivnav: 20, other: 40, free: 40 });
  });

  test("mivnav is clamped into used (caches may sit on another filesystem)", () => {
    expect(diskSegments(disk(1000, 300, 700), 500)).toEqual({ mivnav: 30, other: 0, free: 70 });
  });

  test("an unreadable zero-size disk draws nothing", () => {
    expect(diskSegments(disk(0, 0, 0), 10)).toEqual({ mivnav: 0, other: 0, free: 0 });
  });
});
