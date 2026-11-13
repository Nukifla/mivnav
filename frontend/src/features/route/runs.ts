// Grouping a route's legs into runs by their `approximate` flag — the
// straight-line stand-ins the auto-router could not verify (a waypoint's
// `approximate`, `core/routes.ts`). The route overlay draws each approximate
// run dashed; the autorouting plugin's route-test probe draws a plan result
// the same way.

/** One consecutive run of legs, all sharing the same `approximate` flag —
 * `points` is ready to draw as its own polyline, sharing an endpoint with
 * its neighbour on each side so the drawn route reads continuous. */
export interface RouteRun<P> {
  points: P[];
  approximate: boolean;
}

/** Group `waypoints` into consecutive runs by `approximateLegs[i]` (one
 * entry per leg, `waypoints[i]` -> `waypoints[i + 1]`) — generalizes the
 * old "at most a leading + trailing stub" split (`splitApproximateLegs`,
 * back when only the two ends could ever be flagged) to a run landing
 * ANYWHERE: a single grid resolution shared across a long corridor can
 * miss a real, narrow hazard in the MIDDLE of a route too, not just near
 * its two ends — see the backend's own PlanResponse docstring. A single
 * waypoint with no legs at all comes back as one non-approximate run of
 * length 1; zero waypoints comes back empty. Shared by both overlays that
 * draw approximate runs (this feature's route overlay, the autorouting
 * plugin's route-test probe) so the grouping logic lives in exactly one place — the map
 * paint (dashed + warning colour on approximate runs) is each overlay's
 * own, everything already themed differently.
 *
 * `approximateLegs` is walked by LEG COUNT (`waypoints.length - 1`), not
 * by its own length, and a missing entry defaults to `false` — a real
 * regression, caught live: every ordinary saved route (not the "Go here"
 * ephemeral one) is drawn with `approximateLegs` gated to `[]` in
 * `route/overlay.ts`, and the old `while (i < approximateLegs.length)`
 * loop never ran at all for that empty array, so no line feature was
 * pushed AT ALL — only the waypoint handles, with nothing joining them. */
export function groupApproximateRuns<P>(waypoints: readonly P[], approximateLegs: readonly boolean[]): RouteRun<P>[] {
  const n = waypoints.length;
  if (n === 0) return [];
  if (n === 1) return [{ points: [waypoints[0]!], approximate: false }];
  const legCount = n - 1;
  const runs: RouteRun<P>[] = [];
  let i = 0;
  while (i < legCount) {
    const approximate = approximateLegs[i] ?? false;
    let j = i;
    while (j < legCount && (approximateLegs[j] ?? false) === approximate) j++;
    // Legs [i, j) span waypoints[i..j] inclusive.
    runs.push({ points: waypoints.slice(i, j + 1) as P[], approximate });
    i = j;
  }
  return runs;
}
