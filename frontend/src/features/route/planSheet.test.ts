// The plan sheet's pure logic: the peek/bar summary (distance · time · ETA at
// the planning speed), the per-leg rows, and the planning-speed stepper. Map-
// free and DOM-free like `route.ts`'s geometry, so `bun test` pins them without
// a browser.

import { describe, expect, test } from "bun:test";
import type { Waypoint } from "../../core/routes";
import { planRouteMetrics } from "./index";
import {
  legRows,
  parseDatetimeLocal,
  parsePlanSpeed,
  PLAN_SPEED_MAX,
  PLAN_SPEED_MIN,
  routeSummary,
  stepPlanSpeed,
  toDatetimeLocal,
} from "./planSheet";

const W = (id: string, lat: number, lon: number, name = ""): Waypoint => ({ id, name, lat, lon });
// A three-waypoint route running due north: two legs, ~60 nm each at 1° lat.
const wps = [W("0", 0, 0), W("1", 1, 0), W("2", 2, 0)];

describe("routeSummary (speed → time/ETA)", () => {
  test("distance is speed-free; time and ETA follow the planning speed", () => {
    const slow = routeSummary(wps, 3, 0);
    const fast = routeSummary(wps, 6, 0);
    // Same distance both ways.
    expect(slow.plan.totalNm).toBeCloseTo(fast.plan.totalNm, 6);
    expect(slow.distUnit).toBe("nm");
    expect(Number(fast.distValue)).toBeCloseTo(120, 0);
    // Half the speed → twice the time.
    expect(slow.plan.totalSec).toBeCloseTo(fast.plan.totalSec * 2, 0);
    expect(fast.time).toMatch(/^\d+h \d\d$/); // 120 nm at 6 kn = 20h 00
    expect(fast.eta).toMatch(/^\d\d:\d\d$/);
    expect(slow.eta).toMatch(/^\d\d:\d\d$/);
    expect(slow.eta).not.toBe(fast.eta); // a slower plan arrives at a different clock
  });

  test("a non-positive speed has no arrival — the formatters refuse to invent one", () => {
    const becalmed = routeSummary(wps, 0, 0);
    expect(Number(becalmed.distValue)).toBeCloseTo(120, 0); // distance still real
    expect(becalmed.time).toBe("– –");
    expect(becalmed.eta).toBe("– –:– –");
  });

  test("the ETA counts from the departure instant, not just from now", () => {
    // 120 nm at 6 kn = 20 h. Departing at epoch 0 (UTC midnight) the arrival is
    // 20 h later, on the SAME clock the leg rows use — assert the offset, not a
    // wall-clock string (the test host's timezone is unknown).
    const s = routeSummary(wps, 6, 0);
    const later = routeSummary(wps, 6, 3600_000); // depart one hour later
    expect(s.eta).toMatch(/^\d\d:\d\d$/);
    expect(later.eta).not.toBe(s.eta); // a later departure ⇒ a later arrival clock
    // The whole-route ETA equals departure + total time, so both summaries land
    // exactly one hour apart (their only difference is the departure).
    const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
    expect((mins(later.eta) - mins(s.eta) + 1440) % 1440).toBe(60);
  });
});

describe("legRows", () => {
  test("one row per leg: number, destination, bearing, distance, cumulative ETA", () => {
    const named = [W("0", 0, 0), W("1", 1, 0, "Fladen"), W("2", 2, 0)];
    const rows = legRows(named, planRouteMetrics(named, 6), 0);
    expect(rows).toHaveLength(2);

    const [a, b] = rows;
    expect(a.seg).toBe(0); // the segment the chart flashes on tap
    expect(a.n).toBe(1); // arrives at waypoint 1
    expect(a.toName).toBe("Fladen"); // the destination's name
    expect(a.brg).toBe("000"); // due north
    expect(a.distUnit).toBe("nm");
    expect(Number(a.distValue)).toBeCloseTo(60, 0);
    // This leg's OWN duration: 60 nm at 6 kn = 10 h → "10h 00" (formatDuration).
    expect(a.legTime).toBe("10h 00");
    expect(a.arrival).toMatch(/^\d\d:\d\d$/);
    // The two time values are distinct kinds: a duration (this leg) vs a clock
    // (arrival at it), and must never read as the same string.
    expect(a.legTime).not.toBe(a.arrival);

    expect(b.seg).toBe(1);
    expect(b.n).toBe(2);
    // An unnamed waypoint falls back to its number.
    expect(b.toName).toBe("Waypoint 3");
    // Each leg's own duration is the same 10 h here; the cumulative arrival is not.
    expect(b.legTime).toBe("10h 00");
    // Cumulative arrival is later than the first leg's (monotonic).
    expect(b.arrival).not.toBe(a.arrival);
  });

  test("a becalmed plan has no leg duration — the formatter refuses one", () => {
    const rows = legRows(wps, planRouteMetrics(wps, 0), 0);
    expect(rows[0].legTime).toBe("– –");
  });

  test("per-leg arrivals count from the departure instant", () => {
    // Two 60 nm legs at 6 kn = 10 h each. From epoch 0 the arrivals are 10 h and
    // 20 h out; a later departure shifts BOTH by the same amount.
    const at0 = legRows(wps, planRouteMetrics(wps, 6), 0);
    const at2h = legRows(wps, planRouteMetrics(wps, 6), 7200_000); // depart +2 h
    const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
    for (let i = 0; i < at0.length; i++) {
      expect((mins(at2h[i].arrival) - mins(at0[i].arrival) + 1440) % 1440).toBe(120);
    }
  });

  test("no legs for a route with fewer than two waypoints", () => {
    expect(legRows([W("0", 0, 0)], planRouteMetrics([W("0", 0, 0)], 6), 0)).toHaveLength(0);
  });
});

describe("stepPlanSpeed", () => {
  test("steps by half a knot and rounds cleanly", () => {
    expect(stepPlanSpeed(5, 1)).toBe(5.5);
    expect(stepPlanSpeed(5, -1)).toBe(4.5);
    // Float addition would give 5.999… without the round.
    expect(stepPlanSpeed(5.5, 1)).toBe(6);
  });

  test("clamps to the sailing-plan bounds", () => {
    expect(stepPlanSpeed(PLAN_SPEED_MAX, 1)).toBe(PLAN_SPEED_MAX);
    expect(stepPlanSpeed(PLAN_SPEED_MIN, -1)).toBe(PLAN_SPEED_MIN);
    expect(stepPlanSpeed(1.7, -1)).toBe(PLAN_SPEED_MIN);
  });
});

describe("parsePlanSpeed (tap-to-type)", () => {
  test("parses a typed value, rounds to one decimal", () => {
    expect(parsePlanSpeed("6", 5)).toBe(6);
    expect(parsePlanSpeed("6.5", 5)).toBe(6.5);
    expect(parsePlanSpeed("6.47", 5)).toBe(6.5); // rounded to a tenth
    expect(parsePlanSpeed("  7.0 ", 5)).toBe(7); // parseFloat tolerates whitespace
  });

  test("clamps to the same bounds the stepper uses", () => {
    expect(parsePlanSpeed("99", 5)).toBe(PLAN_SPEED_MAX);
    expect(parsePlanSpeed("0", 5)).toBe(PLAN_SPEED_MIN);
    expect(parsePlanSpeed("-3", 5)).toBe(PLAN_SPEED_MIN);
  });

  test("keeps the last good speed for a half-typed or empty field", () => {
    expect(parsePlanSpeed("", 6.5)).toBe(6.5);
    expect(parsePlanSpeed("kn", 6.5)).toBe(6.5);
    // A bare "." is not yet a number — hold, do not snap to a bound.
    expect(parsePlanSpeed(".", 6.5)).toBe(6.5);
  });
});

describe("datetime-local ↔ epoch ms (departure)", () => {
  test("round-trips a local instant through the field's string form", () => {
    // Pick an instant on a minute boundary (the field has no seconds); the
    // round trip must land back on the same minute regardless of the host zone.
    const minute = 60_000;
    const ms = Math.floor(Date.now() / minute) * minute;
    expect(parseDatetimeLocal(toDatetimeLocal(ms))).toBe(ms);
  });

  test("the string form is the field's YYYY-MM-DDTHH:mm shape", () => {
    expect(toDatetimeLocal(Date.now())).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  });

  test("an empty or unparseable value is null — the caller falls back to now", () => {
    expect(parseDatetimeLocal("")).toBeNull();
    expect(parseDatetimeLocal("not a date")).toBeNull();
  });
});
