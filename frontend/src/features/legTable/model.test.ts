import { describe, expect, test } from "bun:test";
import { createEffect, createRoot, createSignal } from "solid-js";
import type { ActiveLeg, Route, RoutesClient } from "../../core/routes";
import type { Vessel } from "../../core/signalk";
import { createRegistry } from "../../core/chrome/registry";
import { createModeState } from "../../core/chrome/modes";
import { createRouteDraw, ROUTE_DRAW_MODE_ID } from "../routeDraw";
import { createLegTable } from "./index";
import { previewData } from "./overlay";

const saved: Route = {
  id: "r1",
  name: "North",
  plan_speed_kn: 6,
  rev: 2,
  updated: 0,
  waypoints: [
    { id: "a", name: "Harbour", lat: 55, lon: 10 },
    { id: "b", name: "", lat: 56, lon: 10 },
    { id: "c", name: "Anchorage", lat: 57, lon: 10 },
  ],
};

function harness() {
  return createRoot((dispose) => {
    const [routes, setRoutes] = createSignal<Route[]>([saved]);
    const [active, setActive] = createSignal<ActiveLeg | null>(null);
    const [self, setSelf] = createSignal<Vessel | null>(null);
    const client: RoutesClient = {
      routes,
      active,
      refresh: async () => {},
      save: async (r) => ({ ...r, rev: r.rev + 1 }),
      remove: async () => {},
      setActive: async (l) => void setActive(l),
    };
    const draw = createRouteDraw({ client, crosshairSetting: createSignal(false), mintId: () => "x" });
    const modes = createModeState(createRegistry([draw.feature.core]));
    draw.model.bindMode({ enter: () => modes.enter(ROUTE_DRAW_MODE_ID), leave: () => modes.leave() });
    const lt = createLegTable({ client, routeDraw: draw.model, self, clock: () => 0 });
    return { lt, draw, setRoutes, setActive, setSelf, dispose };
  });
}

describe("leg table model", () => {
  test("open is equality-stable: a poll's new route object does not re-fire it", () => {
    const h = harness();
    let runs = 0;
    createRoot(() => createEffect(() => (h.lt.model.open(), runs++)));
    h.lt.model.openRoute(saved);
    const before = runs;
    for (let i = 0; i < 3; i++) h.setRoutes([{ ...saved, waypoints: [...saved.waypoints] }]); // 5 s polls
    expect(runs).toBe(before);
    h.dispose();
  });

  test("a saved route: read-only, a row bands its leg in the preview", () => {
    const h = harness();
    h.lt.model.openRoute(saved);
    expect(h.lt.model.open()).toBe(true);
    expect(h.lt.model.editable()).toBe(false);
    expect(h.lt.model.table()!.rows.length).toBe(2);
    h.lt.model.pick(1);
    expect(h.lt.model.selectedLeg()).toBe(1);
    // Speed edits are the editor's only.
    h.lt.model.setPlanSpeed(9);
    expect(h.lt.model.route()!.plan_speed_kn).toBe(6);
    h.lt.model.close();
    expect(h.lt.model.open()).toBe(false);
    h.dispose();
  });

  test("deleting the saved route closes its table", () => {
    const h = harness();
    h.lt.model.openRoute(saved);
    h.setRoutes([]);
    expect(h.lt.model.open()).toBe(false);
    h.dispose();
  });

  test("the editor's draft: editable, a row selects the leg, closing the editor closes the table", () => {
    const h = harness();
    h.lt.model.openDraft(); // editor closed: nothing
    expect(h.lt.model.open()).toBe(false);
    h.draw.model.edit(saved);
    h.lt.model.openDraft();
    expect(h.lt.model.editable()).toBe(true);
    h.lt.model.pick(0);
    expect(h.draw.model.selection()).toEqual({ kind: "leg", leg: 0, at: { lng: 10, lat: 55.5 } });
    expect(h.lt.model.selectedLeg()).toBe(0);
    h.lt.model.setPlanSpeed(7.5);
    h.lt.model.setDepartAt("2026-11-06T09:30:00Z");
    expect(h.draw.model.draft()).toMatchObject({ plan_speed_kn: 7.5, depart_at: "2026-11-06T09:30:00Z" });
    expect(h.lt.model.table()!.departMs).toBe(Date.parse("2026-11-06T09:30:00Z"));
    h.draw.model.discard();
    expect(h.lt.model.open()).toBe(false);
    h.dispose();
  });

  test("the followed route with a fix counts from the boat", () => {
    const h = harness();
    h.lt.model.openRoute(saved);
    h.setActive({ route_id: "r1", waypoint_id: "b" });
    expect(h.lt.model.table()!.live).toBeNull(); // no fix yet
    h.setSelf({ lng: 10, lat: 55.5, sogMs: 2.5722 } as Vessel); // 5 kn
    const t = h.lt.model.table()!;
    expect(t.live!.sogKn).toBeCloseTo(5, 2);
    expect(t.rows.map((r) => r.state)).toEqual(["active", "ahead"]);
    h.dispose();
  });
});

describe("leg table preview", () => {
  test("line and points unless already drawn; the picked leg as a band", () => {
    const kinds = (d: ReturnType<typeof previewData>) => d.features.map((f) => f.properties!.kind);
    expect(previewData(null).features).toEqual([]);
    expect(kinds(previewData({ route: saved, line: true, leg: null }))).toEqual(["line", "point", "point", "point"]);
    expect(kinds(previewData({ route: saved, line: false, leg: 1 }))).toEqual(["leg"]);
    expect(kinds(previewData({ route: saved, line: false, leg: 5 }))).toEqual([]);
  });
});
