import { describe, expect, test } from "bun:test";
import type { Route } from "../../core/routes";
import { planRouteMetrics, routeMetrics } from "../route";
import { departIso, departMsOf, formatWhen, legMidpoint, legTable, pointLabel } from "./table";

// Three points due north along 10°E, one degree of latitude (= 60 nm) apart,
// so leg distances and times are round numbers.
const route = (over: Partial<Route> = {}): Route => ({
  id: "r1",
  name: "North",
  plan_speed_kn: 6,
  rev: 1,
  updated: 0,
  waypoints: [
    { id: "a", name: "Harbour", lat: 55, lon: 10 },
    { id: "b", name: "", lat: 56, lon: 10 },
    { id: "c", name: "Anchorage", lat: 57, lon: 10 },
  ],
  ...over,
});

// Local wall-clock, so every assertion holds in any TZ.
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = local(2026, 11, 6, 8, 0); // a Friday
const HOUR = 3_600_000;

describe("legTable — plan", () => {
  test("one row per leg: from → to, bearing, distance, running total", () => {
    const t = legTable(route(), NOW);
    expect(t.rows.map((r) => [r.leg, r.from, r.to, r.fromName, r.toName])).toEqual([
      [0, 0, 1, "Harbour", ""],
      [1, 1, 2, "", "Anchorage"],
    ]);
    expect(t.rows[0]!.brgDeg).toBeCloseTo(0, 5);
    expect(t.rows[0]!.distNm).toBeCloseTo(60, 0);
    expect(t.rows[1]!.cumNm).toBeCloseTo(120, 0);
    expect(t.totalNm).toBeCloseTo(120, 0);
    expect(t.rows.every((r) => r.state === "plan")).toBe(true);
    expect(t.live).toBeNull();
  });

  test("no departure: ETAs count from now at the planning speed", () => {
    const t = legTable(route(), NOW);
    const plan = planRouteMetrics(route().waypoints, 6);
    expect(t.departMs).toBeNull();
    expect(t.startMs).toBe(NOW);
    expect(t.rows[0]!.etaMs).toBe(NOW + plan.legs[0]!.cumulativeSec * 1000);
    expect(t.rows[0]!.etaMs! - NOW).toBeCloseTo(10 * HOUR, -4); // 60 nm at 6 kn
    expect(t.arriveMs).toBe(NOW + plan.totalSec * 1000);
    expect(t.totalSec).toBeCloseTo(20 * 3600, -1);
  });

  test("a planned departure moves every ETA", () => {
    const depart = local(2026, 11, 7, 6, 0);
    const t = legTable(route({ depart_at: new Date(depart).toISOString() }), NOW);
    expect(t.departMs).toBe(depart);
    expect(t.startMs).toBe(depart);
    expect(t.rows[1]!.etaMs! - depart).toBeCloseTo(20 * HOUR, -4);
  });

  test("an unreadable departure is 'now'", () => {
    expect(legTable(route({ depart_at: "soon" }), NOW).startMs).toBe(NOW);
  });

  test("a single point has no legs and no arrival", () => {
    const t = legTable(route({ waypoints: [route().waypoints[0]!] }), NOW);
    expect(t.rows).toEqual([]);
    expect(t.totalNm).toBe(0);
    expect(t.arriveMs).toBeNull();
  });
});

describe("legTable — live (the followed route)", () => {
  // Boat halfway up leg 1 (55.5°N), heading for point 2 ("b", index 1).
  const boat = { lng: 10, lat: 55.5 };

  test("legs behind are done, the leg sailed is active, ETAs count from the boat at SOG", () => {
    const t = legTable(route(), NOW, { boat, sogKn: 5, activeIndex: 1 });
    expect(t.rows.map((r) => r.state)).toEqual(["active", "ahead"]);
    // 30 nm to b at 5 kn = 6 h; then 60 more = 18 h.
    expect(t.rows[0]!.etaMs! - NOW).toBeCloseTo(6 * HOUR, -4);
    expect(t.rows[1]!.etaMs! - NOW).toBeCloseTo(18 * HOUR, -4);
    // The last ETA IS the instrument's (routeMetrics' destination TTG).
    const m = routeMetrics(boat, route().waypoints, 1, 5);
    expect(t.arriveMs).toBe(NOW + m.ttgDestSec * 1000);
    expect(t.rows[1]!.etaMs).toBeCloseTo(t.arriveMs!, 0);
    expect(t.live!.remainingNm).toBeCloseTo(90, 0);
  });

  test("past legs have no ETA", () => {
    const t = legTable(route(), NOW, { boat: { lng: 10, lat: 56.5 }, sogKn: 5, activeIndex: 2 });
    expect(t.rows.map((r) => r.state)).toEqual(["done", "active"]);
    expect(t.rows[0]!.etaMs).toBeNull();
    expect(t.rows[1]!.etaMs! - NOW).toBeCloseTo(6 * HOUR, -4);
  });

  test("becalmed: no ETAs (the instrument's 0.2 kn floor)", () => {
    const t = legTable(route(), NOW, { boat, sogKn: 0.1, activeIndex: 1 });
    expect(t.rows.map((r) => r.etaMs)).toEqual([null, null]);
    expect(t.arriveMs).toBeNull();
  });

  test("a stale active index falls back to the plan", () => {
    expect(legTable(route(), NOW, { boat, sogKn: 5, activeIndex: 7 }).live).toBeNull();
  });
});

describe("legTable — helpers", () => {
  test("formatWhen: time today, weekday within the week, date further out", () => {
    expect(formatWhen(local(2026, 11, 6, 14, 5), NOW)).toBe("14:05");
    expect(formatWhen(local(2026, 11, 7, 9, 30), NOW)).toBe("Sat 09:30");
    expect(formatWhen(local(2026, 11, 5, 23, 0), NOW)).toBe("Thu 23:00");
    expect(formatWhen(local(2026, 11, 20, 7, 0), NOW)).toBe("20 Nov 07:00");
    expect(formatWhen(null, NOW)).toBe("– –");
  });

  test("departIso ↔ departMsOf: UTC, whole seconds", () => {
    const ms = Date.UTC(2026, 10, 6, 9, 30, 12, 345);
    expect(departIso(ms)).toBe("2026-11-06T09:30:12Z");
    expect(departIso(null)).toBeNull();
    expect(departMsOf({ depart_at: "2026-11-06T09:30:12Z" })).toBe(Date.UTC(2026, 10, 6, 9, 30, 12));
    expect(departMsOf({ depart_at: null })).toBeNull();
    expect(departMsOf({})).toBeNull();
  });

  test("pointLabel and legMidpoint", () => {
    expect(pointLabel(0, "Harbour")).toBe("1 Harbour");
    expect(pointLabel(1, "")).toBe("2");
    expect(legMidpoint(route(), 0)).toEqual({ lng: 10, lat: 55.5 });
    expect(legMidpoint(route(), 2)).toBeNull();
    const seam = route({
      waypoints: [
        { id: "a", name: "", lat: 0, lon: 179 },
        { id: "b", name: "", lat: 0, lon: -179 },
      ],
    });
    expect(Math.abs(legMidpoint(seam, 0)!.lng)).toBeCloseTo(180, 6);
  });
});
