// ROUTE TEST — a click-and-see probe for POST /api/routing/plan
// (mivnav/features/routing), so the backend's live hazard-avoiding search
// has a surface to test against before the real route editor shows the
// same thing. See ROUTING_TODO.md at the repo root for where that work
// stands: the endpoint now returns a real path that bends around charted
// danger (chartcore's visibility-graph search), not a placeholder straight
// line — this mode draws whatever it comes back with. This mode is the
// click-and-see version of the curl/Swagger-UI check, nothing more.
//
// Deliberately NOT the route editor's "Go here": that commits to an actual
// followed leg (SignalK publish, autopilot engagement) and this is a
// throwaway probe — nothing here is boat state, and leaving the mode drops
// it (same `enter`/`leave` = `clear` shape as Measure).
//
// Two taps: the first places `from`, the second places `to` AND fires the
// request. A third tap starts a new probe. `defineFeature({ modes: [...] })`
// — one line in App.tsx, no shell edit — same shape as measure/index.ts.

import { createSignal, type Accessor } from "solid-js";
import { coerceBoolean, deviceSetting } from "../../core/persist";
import { defineSetting } from "../../core/settings/registry";
import { DIAGNOSTICS } from "../../core/settings/device";
import type { SettingsCtx } from "../../core/settings/ctx";
import type { GeoPoint } from "../../core/chrome/geo";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { createRouteTestOverlay } from "./overlay";
import { routeTestCommands } from "./commands";
import { planIsUnreachable, planRoute, type PlanFetch, type PlanResult } from "../../core/routing";

/** The pill's one-line status for a completed plan. The backend always
 * appends the standing "no rules stage yet" caveat LAST (see the
 * backend's `PlanResponse` docstring) — any approximate-end reason(s)
 * come before it, so `warnings.slice(0, -1)` is exactly those, 0-2 of
 * them. Shown verbatim when the route is approximate; a fully-exact
 * route is summarised instead — nobody testing this needs the rules-
 * stage caveat re-read on every tap, and `waypoints.length > 2` is
 * itself the proof a detour happened. */
function describeResult(r: PlanResult): string {
  if (planIsUnreachable(r)) {
    const base = r.warnings.slice(0, -1).join(" ") || r.warnings[0]!;
    // When the mivnav coarse stitch failed, `debugLegs` carries WHICH of
    // the fine search's failure points fired on the rejected leg — the
    // one thing the warning text cannot say. Surface it after the prose.
    const reasons = [
      ...new Set(
        (r.debugLegs ?? [])
          .map((leg) => leg.reason)
          .filter((x): x is string => !!x && x !== "ok"),
      ),
    ];
    return reasons.length ? `${base} [fine search: ${reasons.join(", ")}]` : base;
  }
  const bends = r.waypoints.length - 2;
  return bends > 0
    ? `Routed around charted danger (${bends} bend${bends === 1 ? "" : "s"})`
    : "Clear — direct line, no charted hazard nearby";
}

export type RouteTestStatus = "idle" | "loading" | "error";

export interface RouteTestModel {
  from: Accessor<GeoPoint | null>;
  to: Accessor<GeoPoint | null>;
  result: Accessor<PlanResult | null>;
  status: Accessor<RouteTestStatus>;
  errorMessage: Accessor<string | null>;
}

export function createRouteTest(opts: { fetch?: PlanFetch } = {}): {
  feature: AppFeature;
  model: RouteTestModel;
} {
  const [from, setFrom] = createSignal<GeoPoint | null>(null);
  const [to, setTo] = createSignal<GeoPoint | null>(null);
  const [result, setResult] = createSignal<PlanResult | null>(null);
  const [status, setStatus] = createSignal<RouteTestStatus>("idle");
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  const clear = () => {
    setFrom(null);
    setTo(null);
    setResult(null);
    setStatus("idle");
    setErrorMessage(null);
  };

  const runPlan = async (a: GeoPoint, b: GeoPoint) => {
    setStatus("loading");
    setErrorMessage(null);
    try {
      // `debug: true` always — this mode IS the debugging layer
      // (#owqqcdqe, 2026-08-10): "add a debugging layer... to check why
      // it puts points where they are". Every other caller of
      // `planRoute` (features/route's real "Go here") stays plain — the
      // extra hazard-ring/corridor payload is a real, sometimes-large
      // cost (a single coastline ring can run to tens of thousands of
      // points) that only belongs on a deliberate, one-off test click,
      // not the boat's own live navigation path.
      const r = await planRoute(a, b, undefined, opts.fetch, true);
      setResult(r);
      setStatus("idle");
      // The overlay reads pixels off a translucent stack (constraint rings
      // over the field raster) that's genuinely hard to eyeball precisely —
      // this is the exact numbers behind it, for whoever is actually
      // chasing a rejected leg down. `reason: "ok"` legs are omitted; a
      // clean plan logs nothing.
      const rejected = (r.debugLegs ?? []).filter((leg) => leg.reason && leg.reason !== "ok");
      if (rejected.length) {
        // A plain object/array argument prints as a collapsed, per-property
        // LAZY preview in both Firefox's and Chromium's console (each
        // nested object needing its own click to expand) — copy-paste
        // unfriendly for handing numbers back verbatim. Log the fully
        // expanded JSON string too, so one copy gets everything.
        const summary = rejected.map((leg) => ({
          reason: leg.reason,
          from: leg.from,
          to: leg.to,
          startSnapM: leg.startSnapM,
          goalSnapM: leg.goalSnapM,
          field: leg.field
            ? { cols: leg.field.cols, rows: leg.field.rows, cellSizeM: leg.field.cellSizeM }
            : null,
        }));
        console.debug("routeTest: rejected fine-search leg(s)", summary);
        console.debug("routeTest: rejected fine-search leg(s) (JSON)", JSON.stringify(summary, null, 2));
      }
    } catch (e) {
      setStatus("error");
      setErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const model: RouteTestModel = { from, to, result, status, errorMessage };

  // A developer tool, not a sailing one: its button and `T` launcher only
  // exist once this per-device Diagnostics toggle is on. Off by default.
  const [enabled, setEnabled] = deviceSetting<boolean>("routeTestEnabled", {
    coerce: (raw) => coerceBoolean(raw, false),
  });

  const feature = defineFeature({
    id: "routeTest",
    overlay: createRouteTestOverlay(model),
    commands: routeTestCommands(enabled),
    settings: {
      settings: [
        defineSetting<SettingsCtx>({
          id: "routeTestEnabled",
          scope: "device",
          control: { kind: "toggle" },
          label: "Route test tool",
          help: "Show the \"Test route\" button — tap two points to probe the routing backend, with its debug overlay. For development.",
          group: DIAGNOSTICS,
          order: 50,
          default: false,
          coerce: (raw) => coerceBoolean(raw, false),
          read: () => enabled(),
          write: (_c, v) => setEnabled(v as boolean),
        }),
      ],
    },
    modes: [
      {
        id: "routeTest",
        label: "Test route",
        hidden: () => !enabled(),
        enter: clear,
        leave: clear,
        hint: () =>
          status() === "loading"
            ? "Checking against live chart data…"
            : !from()
              ? "Tap the start point"
              : !to()
                ? "Tap the end point"
                : "Tap again to start a new test",
        onClick: (click) => {
          const pt: GeoPoint = { lng: click.lngLat.lng, lat: click.lngLat.lat };
          // A completed (or not yet started) probe: the next tap begins a
          // fresh one at the new point, same "two taps in, two taps out"
          // rule Measure uses — `to()`, not `result()`, decides it, so a
          // still-loading probe still resets rather than getting stuck.
          if (!from() || to()) {
            setFrom(pt);
            setTo(null);
            setResult(null);
            setStatus("idle");
            setErrorMessage(null);
          } else {
            setTo(pt);
            void runPlan(from()!, pt);
          }
          return true;
        },
        pill: () => {
          const err = errorMessage();
          const r = result();
          return {
            status:
              status() === "loading"
                ? "Checking…"
                : err
                  ? `Request failed: ${err}`
                  : r
                    ? describeResult(r)
                    : undefined,
            actions: [
              {
                id: "clear",
                label: "Clear",
                disabled: !from() && !to(),
                run: clear,
              },
            ],
          };
        },
      },
    ],
  });

  return { feature, model };
}
