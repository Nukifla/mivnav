/**
 * Route test — the click-and-see probe for POST /api/routing/plan.
 *
 * Same split as measure.test.ts: taps go in as lng/lat, the model comes
 * out, no DOM and no map. `fetch` is injected (see client.ts's docstring
 * on why, not `mock.module` — CLAUDE.md's cross-file leak gotcha).
 *
 * NB: needs `--conditions=browser` (`bun run test`), same reason as every
 * other feature test in this tree.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createModeState } from "../../core/chrome/modes";
import { createRegistry, DESK, isModeHidden, type Feature } from "../../core/chrome/registry";
import type { CommandDeps } from "../../core/chrome/commands";
import type { ModeClick } from "../../core/chrome/modes";
import type { PlanFetch } from "../../core/routing";
import { createRouteTest } from "./index";

const at = (lng: number, lat: number): ModeClick => ({
  point: { x: 0, y: 0 },
  lngLat: { lng, lat },
  radius: 8,
  pick: () => [],
});

/** Flush the fetch → json() → setResult chain: a plain `await
 * Promise.resolve()` only advances one microtask, and `Response.json()`
 * spans more than one hop internally — a macrotask tick is the reliable
 * way to wait for "everything pending has settled" without hardcoding a
 * hop count that just happens to work today. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeFetch(body: unknown, status = 200): PlanFetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

const OK_BODY = {
  waypoints: [
    { lat: 55.9, lon: 12.6 },
    { lat: 56.0, lon: 12.6 },
  ],
  distance_nm: 6.0,
  warnings: [
    "hazard-avoiding route only: traffic-lane crossing angle and buoyage/" +
      "cardinal-mark side are not checked yet — verify manually before following",
  ],
  approximate_legs: [false],
};

function harness(fetch: PlanFetch) {
  return createRoot((dispose) => {
    const routeTest = createRouteTest({ fetch });
    const modes = createModeState(createRegistry([routeTest.feature.core]));
    return { ...routeTest.model, feature: routeTest.feature.core, modes, dispose };
  });
}

const modeOf = (feature: Feature) => feature.modes![0]!;

describe("the feature", () => {
  test("contributes exactly one mode", () => {
    createRoot((dispose) => {
      const { feature } = createRouteTest({ fetch: fakeFetch(OK_BODY) });
      expect(feature.core.modes?.map((m) => m.id)).toEqual(["routeTest"]);
      dispose();
    });
  });

  test("is a developer tool: no button and no launcher until the setting is on", () => {
    try {
      localStorage.removeItem("mivnav.routeTestEnabled");
    } catch {
      /* no storage in this runtime — the default path is the same */
    }
    createRoot((dispose) => {
      const { feature } = createRouteTest({ fetch: fakeFetch(OK_BODY) });
      const mode = modeOf(feature.core);
      const deps = { activeMode: () => null, toggleMode: () => {} } as unknown as CommandDeps;
      const setting = feature.settings!.settings.find((s) => s.id === "routeTestEnabled")!;
      expect(setting.default).toBe(false);
      expect(isModeHidden(mode)).toBe(true);
      expect(feature.commands!(deps)).toEqual([]);

      setting.write!({} as never, true);
      expect(isModeHidden(mode)).toBe(false);
      expect(feature.commands!(deps).map((c) => c.id)).toEqual(["mode-route-test"]);
      setting.write!({} as never, false);
      dispose();
    });
  });
});

describe("two taps", () => {
  test("first tap sets `from`; nothing is planned yet", () => {
    const h = harness(fakeFetch(OK_BODY));
    h.modes.enter("routeTest");
    expect(h.modes.handleClick(at(12.6, 55.9))).toBe(true);
    expect(h.from()).toEqual({ lng: 12.6, lat: 55.9 });
    expect(h.to()).toBeNull();
    expect(h.result()).toBeNull();
    h.dispose();
  });

  test("second tap sets `to` and the plan comes back", async () => {
    const h = harness(fakeFetch(OK_BODY));
    h.modes.enter("routeTest");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    expect(h.to()).toEqual({ lng: 12.6, lat: 56.0 });
    await flush();
    expect(h.status()).toBe("idle");
    expect(h.result()?.distanceNm).toBe(6.0);
    expect(h.result()?.waypoints).toEqual([
      { lng: 12.6, lat: 55.9 },
      { lng: 12.6, lat: 56.0 },
    ]);
    h.dispose();
  });

  test("always asks the backend for debug geometry — this mode IS the debug layer", async () => {
    const requests: unknown[] = [];
    const capturingFetch: PlanFetch = async (_input, init) => {
      requests.push(JSON.parse(init!.body as string));
      return new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const h = harness(capturingFetch);
    h.modes.enter("routeTest");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    await flush();
    expect(requests).toEqual([{ from: { lat: 55.9, lon: 12.6 }, to: { lat: 56.0, lon: 12.6 }, debug: true }]);
    h.dispose();
  });

  test("the debug hazard/box/macro geometry the backend returns reaches the model", async () => {
    const h = harness(
      fakeFetch({
        ...OK_BODY,
        debug_legs: [
          {
            bbox: [12.55, 55.85, 12.65, 56.05],
            hazard_rings: [
              [
                [12.61, 55.95],
                [12.62, 55.95],
                [12.62, 55.96],
              ],
            ],
          },
        ],
        debug_macro_waypoints: [[12.6, 55.95]],
      }),
    );
    h.modes.enter("routeTest");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    await flush();
    expect(h.result()?.debugLegs).toEqual([
      {
        bbox: [12.55, 55.85, 12.65, 56.05],
        hazardRings: [
          [
            { lng: 12.61, lat: 55.95 },
            { lng: 12.62, lat: 55.95 },
            { lng: 12.62, lat: 55.96 },
          ],
        ],
      },
    ]);
    expect(h.result()?.debugMacroWaypoints).toEqual([{ lng: 12.6, lat: 55.95 }]);
    h.dispose();
  });

  test("a third tap starts a new probe rather than dragging the old one", async () => {
    const h = harness(fakeFetch(OK_BODY));
    h.modes.enter("routeTest");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    await flush();
    h.modes.handleClick(at(13.0, 55.5));
    expect(h.from()).toEqual({ lng: 13.0, lat: 55.5 });
    expect(h.to()).toBeNull();
    expect(h.result()).toBeNull();
    h.dispose();
  });

  test("leaving the mode clears the probe", async () => {
    const h = harness(fakeFetch(OK_BODY));
    h.modes.enter("routeTest");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    await flush();
    h.modes.leave();
    expect(h.from()).toBeNull();
    expect(h.result()).toBeNull();
    h.dispose();
  });
});

describe("a real hazard-avoiding route", () => {
  test("a direct line (nothing in the way) reports clear", async () => {
    const h = harness(fakeFetch(OK_BODY));
    h.modes.enter("routeTest");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    await flush();
    const pill = modeOf(h.feature).pill!({ density: DESK });
    expect(pill.status).toBe("Clear — direct line, no charted hazard nearby");
    h.dispose();
  });

  test("a bent route (waypoints beyond the two endpoints) is summarised, not re-read the caveat", async () => {
    const h = harness(
      fakeFetch({
        ...OK_BODY,
        waypoints: [
          { lat: 55.9, lon: 12.6 },
          { lat: 55.95, lon: 12.65 },
          { lat: 56.0, lon: 12.6 },
        ],
      }),
    );
    h.modes.enter("routeTest");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    await flush();
    const pill = modeOf(h.feature).pill!({ density: DESK });
    expect(pill.status).toBe("Routed around charted danger (1 bend)");
    h.dispose();
  });

  test("no route at all — the start point is itself unsafe — surfaces that reason verbatim", async () => {
    const h = harness(
      fakeFetch({
        ...OK_BODY,
        warnings: [
          "start point 55.9000, 12.6000 is itself inside charted danger " +
            "(draft 2.0m + 1.0m keel margin, 30m clearance)",
        ],
        approximate_legs: [true],
      }),
    );
    h.modes.enter("routeTest");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    await flush();
    const pill = modeOf(h.feature).pill!({ density: DESK });
    expect(pill.status).toContain("start point");
    expect(pill.status).toContain("is itself inside charted danger");
    h.dispose();
  });
});

describe("a failed request", () => {
  test("the pill reports the failure rather than hanging silent", async () => {
    const failing: PlanFetch = async () => new Response("boom", { status: 500 });
    const h = harness(failing);
    h.modes.enter("routeTest");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    await flush();
    expect(h.status()).toBe("error");
    const pill = modeOf(h.feature).pill!({ density: DESK });
    expect(pill.status).toContain("Request failed");
    h.dispose();
  });
});
