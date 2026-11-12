/**
 * The arithmetic behind the cursor readout and Measure.
 *
 * `rangeNm` is `cpa.ts`'s, whose own tests already pin it against a haversine
 * reference — so what is worth asserting here is the bearing, which is new, and
 * the formatting, which is where chrome and the chart label can quietly disagree
 * about how to round.
 */

import { describe, expect, test } from "bun:test";
import { bearingDeg, rangeNm } from "./geo";
import { formatClock, formatDuration, formatRange, formatRangeStr, padDeg } from "../format";

/** Øresund, where the boat lives. */
const HOME = { lng: 12.6, lat: 55.9 };

describe("bearingDeg", () => {
  test("the four cardinals", () => {
    expect(bearingDeg(HOME, { lng: 12.6, lat: 56.0 })).toBeCloseTo(0, 4);
    expect(bearingDeg(HOME, { lng: 12.8, lat: 55.9 })).toBeCloseTo(90, 4);
    expect(bearingDeg(HOME, { lng: 12.6, lat: 55.8 })).toBeCloseTo(180, 4);
    expect(bearingDeg(HOME, { lng: 12.4, lat: 55.9 })).toBeCloseTo(270, 4);
  });

  test("is always in [0, 360) — a bearing is never negative", () => {
    // NW: the naive atan2 answer here is -45ish, and printing "-45°T" is the
    // classic version of this bug.
    const nw = bearingDeg(HOME, { lng: 12.4, lat: 56.0 });
    expect(nw).toBeGreaterThan(270);
    expect(nw).toBeLessThan(360);
  });

  test("east is compressed by the cosine of the latitude, not ignored", () => {
    // One degree north and one degree east from 55.9°N: a degree of longitude
    // is ~0.56 of a degree of latitude up here, so the bearing is well east of
    // 45°. A flat-earth atan2(dLon, dLat) would answer exactly 45 — which is
    // the whole reason this function is not one line.
    const brg = bearingDeg(HOME, { lng: 13.6, lat: 56.9 });
    expect(brg).toBeGreaterThan(28);
    expect(brg).toBeLessThan(32);
  });

  test("reciprocal: there and back is 180° apart", () => {
    const there = { lng: 12.9, lat: 56.1 };
    const out = bearingDeg(HOME, there);
    const back = bearingDeg(there, HOME);
    expect((out + 180) % 360).toBeCloseTo(back, 3);
  });

  test("the antimeridian is a place, not a wall", () => {
    // 179°E → 179°W is one degree east, not 358 degrees west.
    expect(bearingDeg({ lng: 179, lat: 0 }, { lng: -179, lat: 0 })).toBeCloseTo(90, 4);
    expect(bearingDeg({ lng: -179, lat: 0 }, { lng: 179, lat: 0 })).toBeCloseTo(270, 4);
  });

  test("zero separation does not produce NaN", () => {
    expect(Number.isFinite(bearingDeg(HOME, { ...HOME }))).toBe(true);
  });
});

describe("rangeNm", () => {
  test("a degree of latitude is 60 nm, by the definition of the nm", () => {
    expect(rangeNm({ lng: 12.6, lat: 55 }, { lng: 12.6, lat: 56 })).toBeCloseTo(60, 1);
  });
});

describe("formatRange", () => {
  test("nautical miles at and above one", () => {
    expect(formatRange(1)).toEqual({ value: "1.00", unit: "nm" });
    expect(formatRange(12.345)).toEqual({ value: "12.35", unit: "nm" });
  });

  test("metres below one, rounded to the nearest 10 m — the tree's one range convention", () => {
    expect(formatRange(0.5)).toEqual({ value: "930", unit: "m" });
    expect(formatRange(0)).toEqual({ value: "0", unit: "m" });
  });

  test("the switch is at exactly 1 nm, and lands on nm", () => {
    expect(formatRange(0.9999).unit).toBe("m");
    expect(formatRange(1).unit).toBe("nm");
  });
});

describe("formatRangeStr", () => {
  test("value and unit joined — what a slider label or settings row shows", () => {
    expect(formatRangeStr(2.5)).toBe("2.50 nm");
    expect(formatRangeStr(0.5)).toBe("930 m");
  });
});

describe("padDeg", () => {
  test("three digits, always — a bearing is written 047, not 47", () => {
    expect(padDeg(47)).toBe("047");
    expect(padDeg(7)).toBe("007");
    expect(padDeg(0)).toBe("000");
    expect(padDeg(359.6)).toBe("000"); // rounds to 360, which is 000
    expect(padDeg(180)).toBe("180");
  });
});

describe("formatDuration", () => {
  test("minutes under 60", () => {
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(59 * 60)).toBe("59 min");
  });

  test("hours and minutes above", () => {
    expect(formatDuration(60 * 60)).toBe("1h 00");
    expect(formatDuration(5400)).toBe("1h 30");
    expect(formatDuration(3600 * 4 + 60 * 5)).toBe("4h 05");
  });

  /** The switch is at 60 min, not 90 — and rounding must never land on "60 min". */
  test("the 60-minute boundary: never '60 min', never '90 min'", () => {
    expect(formatDuration(59.4 * 60)).toBe("59 min"); // rounds to 59, stays minutes
    expect(formatDuration(59.6 * 60)).toBe("1h 00"); // rounds to 60 → hours, not "60 min"
    expect(formatDuration(89 * 60)).toBe("1h 29");
    expect(formatDuration(90 * 60)).toBe("1h 30"); // never "90 min"
  });

  /** Stopped is not 999h. Division by zero is a state, not a number. */
  test("no answer is said, not fabricated", () => {
    expect(formatDuration(Infinity)).toBe("– –");
    expect(formatDuration(NaN)).toBe("– –");
    expect(formatDuration(-1)).toBe("– –");
  });
});

describe("formatClock", () => {
  test("adds the seconds to now and shows HH:MM, zero-padded", () => {
    // 09:05 on the device clock, plus 90 minutes → 10:35.
    const now = new Date(2026, 0, 1, 9, 5, 0).getTime();
    expect(formatClock(90 * 60, now)).toBe("10:35");
    // Under an hour, still padded.
    expect(formatClock(3 * 60, new Date(2026, 0, 1, 0, 6, 0).getTime())).toBe("00:09");
  });

  /** A becalmed boat has no ETA — the same refusal `formatDuration` makes. */
  test("no arrival time is fabricated when there is no answer", () => {
    expect(formatClock(Infinity)).toBe("– –:– –");
    expect(formatClock(NaN)).toBe("– –:– –");
    expect(formatClock(-1)).toBe("– –:– –");
  });
});
