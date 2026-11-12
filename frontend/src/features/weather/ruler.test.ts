import { describe, expect, it } from "bun:test";
import {
  clockLabel,
  fracToOffset,
  offsetToFrac,
  pageHours,
  rulerModel,
} from "./ruler";

// A fixed "now": Saturday 18 July 2026, 17:00 local. Built from local components
// so the maths is timezone-independent (midnight-today is local midnight).
const NOW = new Date(2026, 6, 18, 17, 0, 0, 0).getTime();
const MAX = 48;
const STEP = 3;
const HOUR = 3_600_000;

describe("rulerModel", () => {
  const m = rulerModel(NOW, MAX);

  it("frames the display window from local midnight today to now+maxHours", () => {
    expect(m.startMs).toBe(new Date(2026, 6, 18, 0, 0, 0, 0).getTime());
    expect(m.endMs).toBe(NOW + MAX * HOUR); // Mon 20 Jul 17:00
    expect(m.nowMs).toBe(NOW);
  });

  it("touches the calendar days the window spans, labelled DD-MM", () => {
    // Sat 18 (from midnight) → Sun 19 → Mon 20 (up to 17:00): three days.
    expect(m.days.map((d) => d.date)).toEqual(["18-07", "19-07", "20-07"]);
  });

  it("draws N+1 daylines for N days", () => {
    expect(m.daylines.length).toBe(m.days.length + 1);
    expect(m.daylines[0]).toBe(0);
    expect(m.daylines[m.daylines.length - 1]).toBe(1);
  });

  it("centres each day label inside its real (uneven) segment", () => {
    for (const d of m.days) {
      expect(d.centerFrac).toBeCloseTo((d.startFrac + d.endFrac) / 2, 10);
      expect(d.startFrac).toBeGreaterThanOrEqual(0);
      expect(d.endFrac).toBeLessThanOrEqual(1);
    }
    // The first day is partial (midnight→end of window), so its left edge is 0.
    expect(m.days[0].startFrac).toBe(0);
  });

  it("places 'now' partway into the first day (17h of a 65h window)", () => {
    // span = midnight Sat → 17:00 Mon = 65h; now = 17h in.
    expect(m.nowFrac).toBeCloseTo(17 / 65, 6);
  });
});

describe("offset ⇄ fraction", () => {
  const m = rulerModel(NOW, MAX);

  it("maps offset 0 to nowFrac and maxHours to 1", () => {
    expect(offsetToFrac(m, 0)).toBeCloseTo(m.nowFrac, 10);
    expect(offsetToFrac(m, MAX)).toBeCloseTo(1, 10);
  });

  it("round-trips an on-step offset through the fraction", () => {
    for (const h of [0, 3, 24, 45, 48]) {
      expect(fracToOffset(m, offsetToFrac(m, h), STEP)).toBe(h);
    }
  });

  it("snaps a fraction to the nearest step", () => {
    // A point just past the +24h position should still snap to a multiple of 3.
    const f = offsetToFrac(m, 24) + 0.001;
    expect(fracToOffset(m, f, STEP) % STEP).toBe(0);
  });

  it("clamps the non-selectable past (left of now) to 0", () => {
    expect(fracToOffset(m, 0, STEP)).toBe(0);
    expect(fracToOffset(m, m.nowFrac / 2, STEP)).toBe(0);
  });

  it("clamps the far right to maxHours", () => {
    expect(fracToOffset(m, 1, STEP)).toBe(MAX);
    expect(fracToOffset(m, 2, STEP)).toBe(MAX);
  });
});

describe("rulerModel over a one-week window", () => {
  const WEEK = 168;
  const m = rulerModel(NOW, WEEK);

  it("spans the eight calendar days midnight Sat 18 → 17:00 Sat 25", () => {
    expect(m.days.map((d) => d.date)).toEqual([
      "18-07", "19-07", "20-07", "21-07", "22-07", "23-07", "24-07", "25-07",
    ]);
    expect(m.daylines.length).toBe(m.days.length + 1);
    expect(m.endMs).toBe(NOW + WEEK * HOUR);
  });

  it("maps the week horizon to the right edge and round-trips week offsets", () => {
    expect(offsetToFrac(m, WEEK)).toBeCloseTo(1, 10);
    for (const h of [0, 3, 24, 72, 120, 165, 168]) {
      expect(fracToOffset(m, offsetToFrac(m, h), STEP)).toBe(h);
    }
  });

  it("pages by a day and clamps at the week horizon", () => {
    expect(pageHours(144, 1, WEEK, STEP)).toBe(168);
    expect(pageHours(165, 1, WEEK, STEP)).toBe(168);
  });
});

describe("pageHours", () => {
  it("pages a day forward and back, snapped and clamped", () => {
    expect(pageHours(0, 1, MAX, STEP)).toBe(24);
    expect(pageHours(24, 1, MAX, STEP)).toBe(48);
    expect(pageHours(30, 1, MAX, STEP)).toBe(48); // clamp at horizon
    expect(pageHours(0, -1, MAX, STEP)).toBe(0); // clamp at now
    expect(pageHours(24, -1, MAX, STEP)).toBe(0);
  });
});

describe("clockLabel", () => {
  it("shows the wall clock of the selected offset", () => {
    // +0h is 17:00; the exact string is locale-formatted, so assert it contains
    // the hour and reads as a time.
    expect(clockLabel(NOW, 0)).toMatch(/17|5/); // 17:00 or 5:00 PM
    expect(clockLabel(NOW, 3)).not.toBe(clockLabel(NOW, 0));
  });
});
