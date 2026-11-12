// The leg table's numbers, as pure functions of a route and a clock: one row
// per leg (from → to, bearing, distance, running total, ETA at its end) and
// the header totals. Two ways to count time:
//
// - PLAN: from the route's `depart_at` (or now, when it has none) at its
//   planning speed — `planRouteMetrics`, the same at-rest figures the route
//   card and plan sheet show.
// - LIVE: the route is the one being followed and there is a fix — from the
//   boat, at its speed over ground, for the legs still ahead. Boat→next is
//   `routeMetrics` (the band.top DTW/TTG); each later point adds the planned
//   legs between, timed at the same ratio as `routeMetrics`' own TTG to the
//   destination, so the last row's ETA IS the instrument's.
//
// Times are LOCAL wall-clock (the sailor's clock), with the day when it isn't
// today.

import type { Route } from "../../core/routes";
import type { GeoPoint } from "../../core/chrome/geo";
import { planRouteMetrics, routeMetrics } from "../route";

/** The boat, for a live table: where it is, how fast, and which waypoint the
 * followed leg is heading to (an index into the route's waypoints). */
export interface LiveFix {
  boat: GeoPoint;
  sogKn: number;
  activeIndex: number;
}

export type LegState = "plan" | "done" | "active" | "ahead";

export interface LegRowData {
  /** 0-based leg index — the leg `from`→`to`, `to = from + 1`. */
  leg: number;
  /** 0-based point indices (display is +1). */
  from: number;
  to: number;
  /** The points' own names; "" when unnamed (display falls back to the number). */
  fromName: string;
  toName: string;
  brgDeg: number;
  distNm: number;
  /** Route distance from point 1 through this leg's end. */
  cumNm: number;
  /** Arrival at `to`, epoch ms. Null when there is none: a non-positive
   * planning speed, a becalmed boat, or (live) a leg already sailed. */
  etaMs: number | null;
  /** `plan` outside a follow; live: `done` behind the boat, `active` the leg
   * being sailed, `ahead` the rest. */
  state: LegState;
}

export interface LegTableData {
  rows: LegRowData[];
  totalNm: number;
  speedKn: number;
  /** The route's planned departure, or null ("now"). */
  departMs: number | null;
  /** What plan ETAs count from: `departMs`, else now. */
  startMs: number;
  /** Planned passage time at `speedKn` (Infinity at a non-positive speed). */
  totalSec: number;
  /** Arrival at the last point: planned, or live from the boat. */
  arriveMs: number | null;
  /** Set while the table counts from the boat. */
  live: { sogKn: number; remainingNm: number; remainingSec: number } | null;
}

/** `depart_at` as epoch ms, or null when absent or unreadable. */
export function departMsOf(route: Pick<Route, "depart_at">): number | null {
  const iso = route.depart_at;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch ms as the wire's `depart_at` — UTC, whole seconds, `Z` (the form the
 * backend stores, so a saved route compares equal to its draft). */
export function departIso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const etaAt = (startMs: number, sec: number): number | null =>
  Number.isFinite(sec) && sec >= 0 ? startMs + sec * 1000 : null;

export function legTable(route: Route, nowMs: number, live?: LiveFix | null): LegTableData {
  const wps = route.waypoints;
  const plan = planRouteMetrics(wps, route.plan_speed_kn);
  const departMs = departMsOf(route);
  const startMs = departMs ?? nowMs;
  const base = plan.legs.map((l) => ({
    leg: l.fromIndex,
    from: l.fromIndex,
    to: l.toIndex,
    fromName: wps[l.fromIndex]?.name.trim() ?? "",
    toName: wps[l.toIndex]?.name.trim() ?? "",
    brgDeg: l.brgDeg,
    distNm: l.distNm,
    cumNm: l.cumulativeNm,
  }));

  const followable = live && live.activeIndex >= 0 && live.activeIndex < wps.length;
  if (!followable) {
    return {
      rows: base.map((r, i) => ({ ...r, etaMs: etaAt(startMs, plan.legs[i]!.cumulativeSec), state: "plan" })),
      totalNm: plan.totalNm,
      speedKn: route.plan_speed_kn,
      departMs,
      startMs,
      totalSec: plan.totalSec,
      arriveMs: plan.legs.length ? etaAt(startMs, plan.totalSec) : null,
      live: null,
    };
  }

  const a = live.activeIndex;
  const m = routeMetrics(live.boat, wps, a, live.sogKn);
  // Route distance from point 1 to point k.
  const cumTo = (k: number) => (k === 0 ? 0 : (plan.legs[k - 1]?.cumulativeNm ?? 0));
  // Boat → point k (k ≥ a): to the active point, then along the route.
  const fromBoat = (k: number) => m.dtwNm + cumTo(k) - cumTo(a);
  // Seconds per nm at the rate `routeMetrics` used for the destination TTG
  // (Infinity when becalmed — no ETA, as the instrument).
  const secAt = (nm: number) => (m.dtgNm > 0 ? (m.ttgDestSec * nm) / m.dtgNm : 0);
  const rows: LegRowData[] = base.map((r) => {
    if (r.to < a) return { ...r, etaMs: null, state: "done" };
    return { ...r, etaMs: etaAt(nowMs, secAt(fromBoat(r.to))), state: r.to === a ? "active" : "ahead" };
  });
  return {
    rows,
    totalNm: plan.totalNm,
    speedKn: route.plan_speed_kn,
    departMs,
    startMs,
    totalSec: plan.totalSec,
    arriveMs: etaAt(nowMs, m.ttgDestSec),
    live: { sogKn: live.sogKn, remainingNm: m.dtgNm, remainingSec: m.ttgDestSec },
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => `${n}`.padStart(2, "0");
const DAY_MS = 86_400_000;

/** Local calendar days from `nowMs`'s date to `ms`'s (DST-proof: by date, not by 24 h). */
function dayDiff(ms: number, nowMs: number): number {
  const a = new Date(ms);
  const b = new Date(nowMs);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((da - db) / DAY_MS);
}

/** A time in LOCAL wall-clock: `14:05` today, `Sat 09:30` within the week
 * around today, `12 Nov 09:30` further out. `– –` for none. */
export function formatWhen(ms: number | null, nowMs: number): string {
  if (ms === null || !Number.isFinite(ms)) return "– –";
  const d = new Date(ms);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const days = dayDiff(ms, nowMs);
  if (days === 0) return hm;
  if (Math.abs(days) < 7) return `${WEEKDAY[d.getDay()]} ${hm}`;
  return `${d.getDate()} ${MONTH[d.getMonth()]} ${hm}`;
}

/** A point as the table names it: `3 Fairway`, or just `3` when unnamed. */
export const pointLabel = (index: number, name: string): string => (name ? `${index + 1} ${name}` : `${index + 1}`);

/** The midpoint of leg `leg` (plane average, antimeridian-safe) — where the
 * editor's "Insert here" lands for a leg selected from the table. */
export function legMidpoint(route: Pick<Route, "waypoints">, leg: number): GeoPoint | null {
  const a = route.waypoints[leg];
  const b = route.waypoints[leg + 1];
  if (!a || !b) return null;
  let dLon = b.lon - a.lon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  let lng = a.lon + dLon / 2;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return { lng, lat: (a.lat + b.lat) / 2 };
}
