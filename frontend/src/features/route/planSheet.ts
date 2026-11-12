// Plan sheet's pure logic (map/DOM-free, so `bun test` can pin it). Reads the
// SAME metrics (`planRouteMetrics`, RT-R1) and formatters as the live
// followed strip, so the plan and the passage never disagree on a number.

import { formatClock, formatDuration, formatRange, padDeg } from "../../core/format";
import { planRouteMetrics, type RoutePlan } from "./index";
import type { Waypoint } from "../../core/routes";

/** Whole-route summary at the planning speed. `time`/`eta` are `"– –"` when
 * speed is not positive (mirrors the live strip). `departMs` defaults to
 * `Date.now()` and is injectable so tests can pin it. */
export interface RouteSummary {
  plan: RoutePlan;
  distValue: string;
  distUnit: string;
  time: string;
  eta: string;
}

export function routeSummary(
  waypoints: readonly Waypoint[],
  speedKn: number,
  departMs: number = Date.now(),
): RouteSummary {
  const plan = planRouteMetrics(waypoints, speedKn);
  const dist = formatRange(plan.totalNm);
  return {
    plan,
    distValue: dist.value,
    distUnit: dist.unit,
    time: formatDuration(plan.totalSec),
    eta: formatClock(plan.totalSec, departMs),
  };
}

/** One row of the per-leg list. `seg` is the segment index the chart flashes
 * when the row is tapped (`fromIndex` — the leg `seg`→`seg+1`). */
export interface LegRow {
  seg: number;
  /** The leg number a mariner reads, 1-based (waypoint the leg arrives at). */
  n: number;
  toName: string;
  brg: string;
  distValue: string;
  distUnit: string;
  /** How long THIS leg alone takes at the planning speed. Companion to
   * `arrival`: `arrival` is the wall-clock ETA, `legTime` is the run to reach it. */
  legTime: string;
  arrival: string;
}

export function legRows(
  waypoints: readonly Waypoint[],
  plan: RoutePlan,
  departMs: number = Date.now(),
): LegRow[] {
  return plan.legs.map((leg) => {
    const to = waypoints[leg.toIndex];
    const dist = formatRange(leg.distNm);
    return {
      seg: leg.fromIndex,
      n: leg.toIndex,
      toName: to?.name.trim() || `Waypoint ${leg.toIndex + 1}`,
      brg: padDeg(leg.brgDeg),
      distValue: dist.value,
      distUnit: dist.unit,
      legTime: formatDuration(leg.timeSec),
      arrival: formatClock(leg.cumulativeSec, departMs),
    };
  });
}

/** The planning-speed stepper's bounds and grain (knots) — a sailing plan is a
 * few knots, and a step finer than a half-knot is noise on an estimate. Mirrors
 * the mockup's `[1.5, 20]` clamp and 0.5 step. */
export const PLAN_SPEED_MIN = 1.5;
export const PLAN_SPEED_MAX = 20;
export const PLAN_SPEED_STEP = 0.5;

/** Nudge a planning speed by ±`PLAN_SPEED_STEP`, clamped and rounded to one
 * decimal (float addition otherwise drifts to `5.999…`). */
export function stepPlanSpeed(speedKn: number, dir: 1 | -1): number {
  const next = Math.round((speedKn + dir * PLAN_SPEED_STEP) * 10) / 10;
  return Math.min(PLAN_SPEED_MAX, Math.max(PLAN_SPEED_MIN, next));
}

/** Parse a TYPED knots value (RT-R6-B), clamped/rounded like the stepper.
 * Returns `fallback` for non-finite text so a half-typed field ("", "1.", "-")
 * keeps the last good speed rather than snapping to a bound mid-keystroke. */
export function parsePlanSpeed(raw: string, fallback: number): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(PLAN_SPEED_MAX, Math.max(PLAN_SPEED_MIN, Math.round(n * 10) / 10));
}

// Departure ↔ <input type="datetime-local"> conversion (RT-R6-C). The
// field's value is LOCAL wall-clock with no timezone — converted in LOCAL
// time here too, since a passage is planned on the sailor's own clock, not UTC.

/** An epoch-ms instant as the `value` an `<input type="datetime-local">` wants:
 * `YYYY-MM-DDTHH:mm` in LOCAL time (seconds dropped — the field has no seconds). */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Parse an `<input type="datetime-local">` value back to epoch ms, read as
 * LOCAL time. `null` for an empty or unparseable value, so the caller falls
 * back to "depart now". */
export function parseDatetimeLocal(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
