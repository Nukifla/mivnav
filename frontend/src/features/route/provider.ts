// "What route is here?" — an `InfoProvider` surfacing the DRAWN route on a
// plain TAP when NOT in the editor. See docs/architecture/route-info-provider.md.

import type { Accessor } from "solid-js";
import RouteIcon from "lucide-solid/icons/route";
import Pencil from "lucide-solid/icons/pencil";
import CircleStop from "lucide-solid/icons/circle-stop";
import Download from "lucide-solid/icons/download";
import ListOrdered from "lucide-solid/icons/list-ordered";
import Navigation from "lucide-solid/icons/navigation";
import SkipForward from "lucide-solid/icons/skip-forward";
import SkipBack from "lucide-solid/icons/skip-back";
import Flag from "lucide-solid/icons/flag";
import EyeOff from "lucide-solid/icons/eye-off";
import type { RoutePlanner } from "../../core/routePlanner";
import type { QueryableMap } from "../../core/info/queryGuard";
import { scopedQuery } from "../../core/info/queryGuard";
import type {
  InfoAction,
  InfoDetail,
  InfoHit,
  InfoPoint,
  InfoProvider,
  InfoQuery,
  InfoRow,
} from "../../core/info/types";
import { formatClock, formatRange } from "../../core/format";
import type { Route } from "../../core/routes";
import { ROUTE_LINE_LAYER } from "./layers";
import { planRouteMetrics } from "./index";

export const ROUTE_PROVIDER_ID = "routes";

/** The live follow metrics the provider needs for the ETA — the destination
 * time-to-go in seconds. `Infinity`/absent when becalmed or not resolvable, in
 * which case no ETA row is shown. Structurally the `metrics` memo's result. */
export interface RouteFollowMetrics {
  ttgDestSec: number;
}

export interface RouteProviderDeps {
  /** The live map, filled in by the sibling overlay's `ensure`. `undefined`
   * until then, when `queryAt` answers nothing. Typed structurally so the
   * provider drives against a `queryRenderedFeatures` double in tests. */
  map: Accessor<QueryableMap | undefined>;
  /** The route the chart DRAWS (`shownRoute`) — the draft while editing, else
   * the followed route. Read live so a tap resolves against what is on screen. */
  route: Accessor<Route | null>;
  /** True while the editor is open; `queryAt` answers nothing then. */
  editing: Accessor<boolean>;
  /** Is a route currently being FOLLOWED — gates the ETA row. */
  following: Accessor<boolean>;
  /** The live boat→destination metrics, or null with no fix / no leg. Read at
   * resolve time and by `watch`, so the ETA stays honest under an open panel. */
  metrics: Accessor<RouteFollowMetrics | null>;
  /** The registered route planner (core/routePlanner.ts), or null: present,
   * "Edit route" opens the route in its editor. */
  planner: Accessor<RoutePlanner | null>;
  /** The id of the route being followed, or null. Gates "Stop following". */
  activeRouteId: Accessor<string | null>;
  /** Stop following the active route — the model's `stopFollowing`. */
  stopFollowing: () => void;
  /** Open the MANUAL route editor (features/routeDraw) on a route: "Edit
   * route" with no route planner, "Edit points" beside the planner's own
   * "Edit route" with one. */
  editPoints?: (route: Route) => void;
  /** The followed leg's target waypoint id, or null — marks the row and
   * places the Next/Previous controls. Absent → no follow controls. */
  activeWaypointId?: Accessor<string | null>;
  /** Follow this route (already confirmed if another one was followed — the
   * card asks inline). Absent hides "Follow". */
  follow?: (route: Route) => void;
  /** Next (+1) / previous (-1) waypoint of the followed route. */
  skipWaypoint?: (delta: 1 | -1) => void;
  /** Make a waypoint of this route the target ("Start here"). */
  startAt?: (routeId: string, waypointId: string) => void;
  /** Download the route as a .gpx file (`./download.ts`). Absent hides it. */
  exportGpx?: (route: Route) => void;
  /** Open the leg table on the route (features/legTable). Absent hides it. */
  showLegs?: (route: Route) => void;
  /** The route drawn without being followed (`RoutesModel.showRoute`), and
   * how to take it off the chart — the card's "Hide". */
  viewedRouteId?: Accessor<string | null>;
  hideRoute?: () => void;
}

/** "3 waypoints · 12.4 nm" — the one-line glance shown as the hit subtitle. */
function summary(route: Route): string {
  const n = route.waypoints.length;
  const dist = formatRange(planRouteMetrics(route.waypoints, route.plan_speed_kn).totalNm);
  return `${n} waypoint${n === 1 ? "" : "s"} · ${dist.value} ${dist.unit}`;
}

/** The card's hit for `route` — what a tap on its line yields, and what
 * band.top's tap opens (no `lngLat` then: there is no tapped spot, and the
 * panel must not warp the chart). */
export function routeHit(route: Route, lngLat?: InfoPoint): InfoHit {
  return {
    providerId: ROUTE_PROVIDER_ID,
    id: route.id,
    // A route CONSTRAINS the passage — the info ranking files routes under
    // "regulated" (see types.ts InfoPriority). Never a danger or an aid, so
    // it can't outrank a charted hazard under the same tap.
    priority: "regulated",
    precision: "line",
    title: route.name.trim() || "Route",
    subtitle: summary(route),
    // The tapped spot on the line — marks where the finger landed and lets
    // the shared Go here / Measure point-actions act, like any placed hit.
    ...(lngLat ? { lngLat } : {}),
    // The route snapshot, so `detail`/the Edit action act on the exact route
    // tapped even if the drawn route changes before resolve.
    payload: route,
  };
}

const wpName = (route: Route, i: number): string => route.waypoints[i]?.name.trim() || `WP ${i + 1}`;

export function createRouteProvider(deps: RouteProviderDeps): InfoProvider {
  /** The follow verbs for `route`: Next/Previous/Start at while it is the
   * followed one, else Follow (asking first if another route is followed). */
  const followActions = (route: Route): InfoAction[] => {
    const activeId = deps.activeRouteId();
    if (activeId === route.id) {
      const target = deps.activeWaypointId?.() ?? null;
      const i = route.waypoints.findIndex((w) => w.id === target);
      if (i < 0) return [];
      const n = route.waypoints.length;
      const acts: InfoAction[] = [];
      if (deps.skipWaypoint && i < n - 1)
        acts.push({ label: "Next waypoint", icon: SkipForward, keepOpen: true, run: () => deps.skipWaypoint!(1) });
      if (deps.skipWaypoint && i > 0)
        acts.push({ label: "Previous waypoint", icon: SkipBack, keepOpen: true, run: () => deps.skipWaypoint!(-1) });
      if (deps.startAt && n > 1)
        acts.push({
          label: "Start at…",
          icon: Flag,
          run: () => {},
          form: {
            fields: [
              {
                key: "wp",
                label: "Waypoint",
                value: route.waypoints[i]!.id,
                maxLength: 64,
                options: route.waypoints.map((w, k) => ({ value: w.id, label: `${k + 1}. ${wpName(route, k)}` })),
              },
            ],
            submitLabel: "Start here",
            submit: (v) => {
              if (v.wp) deps.startAt!(route.id, v.wp);
            },
          },
        });
      return acts;
    }
    if (!deps.follow || route.waypoints.length === 0) return [];
    return [
      {
        label: "Follow",
        icon: Navigation,
        run: () => deps.follow!(route),
        // Another route is being sailed: replacing it is never one stray tap.
        ...(activeId ? { confirm: { question: `Switch to ${route.name.trim() || "this route"}?`, label: "Switch" } } : {}),
      },
    ];
  };

  return {
    id: ROUTE_PROVIDER_ID,
    label: "Route",

    // The route's identity mark in the list and header — a route glyph. A LINE
    // hit has no per-point symbol, so there is no `icon(hit)`; this fallback is
    // the whole of it (else the seam shows the generic priority chip).
    defaultIcon: RouteIcon,

    queryAt(q: InfoQuery): InfoHit[] {
      // Never surface the route as a subject while editing it — "Edit route" is
      // meaningless when already open.
      if (deps.editing()) return [];
      const map = deps.map();
      const route = deps.route();
      // A line needs two points to be drawn (and hit-tested); a 0/1-waypoint draft
      // has no `ROUTE_LINE_LAYER` geometry to tap.
      if (!map || !route || route.waypoints.length < 2) return [];
      const { x, y } = q.point;
      const r = q.radius;
      const query = scopedQuery(map, { layerIds: [ROUTE_LINE_LAYER] });
      const features = query([
        [x - r, y - r],
        [x + r, y + r],
      ]);
      if (features.length === 0) return [];
      return [routeHit(route, q.lngLat)];
    },

    // Re-resolve while following so the ETA counts down under an open panel,
    // and the Next/Previous controls track the target (theirs, the watcher's).
    watch() {
      deps.activeRouteId();
      deps.activeWaypointId?.();
      if (deps.following()) deps.metrics();
    },

    detail(hit: InfoHit): InfoDetail {
      const route = (hit.payload as Route | undefined) ?? deps.route();
      if (!route) return { sections: [] };
      const plan = planRouteMetrics(route.waypoints, route.plan_speed_kn);
      const n = route.waypoints.length;
      const dist = formatRange(plan.totalNm);

      const summaryRows: InfoRow[] = [
        { label: "Distance", value: `${dist.value} ${dist.unit}` },
        { label: "Waypoints", value: String(n) },
      ];
      // ETA only while THIS route is the one being followed — the live wall-clock
      // arrival at the last waypoint. Becalmed (Infinity) → no meaningful ETA.
      const m = deps.following() ? deps.metrics() : null;
      if (m && Number.isFinite(m.ttgDestSec)) {
        summaryRows.push({ label: "ETA", value: formatClock(m.ttgDestSec) });
      }

      // The compact waypoint list: each waypoint by name (or number) with its
      // cumulative distance from the start — the leg totals `planRouteMetrics`
      // already computed, so this reuses the plan rather than re-summing.
      // While followed, the target waypoint is marked "→" and named above.
      const target = deps.activeRouteId() === route.id ? (deps.activeWaypointId?.() ?? null) : null;
      const ti = target ? route.waypoints.findIndex((w) => w.id === target) : -1;
      if (ti >= 0) summaryRows.push({ label: "Next", value: `${wpName(route, ti)} (${ti + 1} of ${n})` });
      const wpRows: InfoRow[] = route.waypoints.map((w, i) => {
        const cumNm = i === 0 ? 0 : (plan.legs[i - 1]?.cumulativeNm ?? 0);
        const at = formatRange(cumNm);
        return {
          label: `${i === ti ? "→ " : ""}${w.name.trim() || `WP ${i + 1}`}`,
          value: `${at.value} ${at.unit}`,
        };
      });

      return {
        title: route.name.trim() || "Route",
        subtitle: summary(route),
        sections: [
          { label: "Route", rows: summaryRows },
          { label: "Waypoints", rows: wpRows },
        ],
        actions: [
          // Follow / Next / Previous / Start at — none of it needs a planner.
          ...followActions(route),
          // Not planner-gated: with no planner's editor this card is the only
          // way to stop following a route.
          ...(deps.activeRouteId() === route.id
            ? [{ label: "Stop following", icon: CircleStop, run: () => deps.stopFollowing() }]
            : []),
          // "Edit route" is the route planner's editor when one is registered,
          // else the manual editor; beside a planner, the manual one is "Edit points".
          ...(deps.planner()
            ? [{ label: "Edit route", icon: Pencil, run: () => deps.planner()?.editRoute(route) }]
            : []),
          ...(deps.editPoints
            ? [
                {
                  label: deps.planner() ? "Edit points" : "Edit route",
                  icon: Pencil,
                  run: () => deps.editPoints!(route),
                },
              ]
            : []),
          ...(deps.showLegs && route.waypoints.length >= 2
            ? [{ label: "Legs", icon: ListOrdered, run: () => deps.showLegs!(route) }]
            : []),
          ...(deps.exportGpx
            ? [{ label: "Export GPX", icon: Download, run: () => deps.exportGpx!(route) }]
            : []),
          ...(deps.hideRoute && deps.viewedRouteId?.() === route.id && deps.activeRouteId() !== route.id
            ? [{ label: "Hide", icon: EyeOff, run: () => deps.hideRoute!() }]
            : []),
        ],
      };
    },
  };
}
