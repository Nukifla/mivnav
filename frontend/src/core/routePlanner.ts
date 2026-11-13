// The ROUTE PLANNER seam: an auto-router a plugin can register (the
// `autorouting` plugin). Present, the app's route verbs go through it — "Go
// here" is a hazard-avoiding plan, opening or starting a route uses its
// editor; absent, they fall back to the core's own: a straight-line "Go to"
// and the manual editor (features/routeDraw). Reactive, so what reads it
// (the route list, the info card, the "Go here" button) follows a
// registration.

import { createSignal } from "solid-js";
import type { GeoPoint } from "./chrome/geo";
import type { Route } from "./routes";

export interface RoutePlanner {
  /** "Go here": plan a route from the boat to `to`, save it over the go-here
   * route and follow it. Resolves `false`, building nothing, with no fix. */
  goTo(to: GeoPoint, label?: string): Promise<boolean>;
  /** Open a saved route in the planner's editor. */
  editRoute(route: Route): void;
  /** Start a blank new route in the planner's editor. */
  newRoute(): void;
}

const [planner, setPlanner] = createSignal<RoutePlanner | null>(null);

/** The registered planner, or null. */
export const routePlanner = planner;

/** Register `p` as THE route planner (the last registration wins). Returns
 * the un-registration — for a test, since bun shares one module registry
 * across test files, and for a plugin's cleanup. */
export function registerRoutePlanner(p: RoutePlanner): () => void {
  setPlanner(() => p);
  return () => {
    if (planner() === p) setPlanner(null);
  };
}
