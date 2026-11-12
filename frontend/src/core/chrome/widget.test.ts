/**
 * The unified Widget registry (C-WIDGET). Three things the chunk MUST prove are
 * asserted directly:
 *
 *  (a) a NEW widget KIND registers via one `defineWidget` descriptor + one array
 *      line — it appears in the registry the picker derives its sources from, and
 *      carries the `spec` schema the add/edit forms are GENERATED from, with NO
 *      edit to config.ts / DashboardEditor.tsx;
 *  (b) the SAFETY invariant holds — a parameterized (user) widget is forced to
 *      `maxUrgency:"none"`, cannot request urgency / raise an alarm, and is never
 *      in `alerts()`;
 *  (c) the persistence MIGRATION maps an old `skWidgets` spec onto the new
 *      `{kind, spec}` shape without loss, and the migrated instance resolves.
 *
 * NB: needs `--conditions=browser` (the `test` script).
 */

import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import type { PathValue } from "../signalk";
import { normalize, type ChromeConfig, type WidgetSpec } from "./config";
import {
  alerts,
  createRegistry,
  DESK,
  defineFeature,
  urgencyOf,
  type ReadCtx,
  type Registry,
} from "./registry";
import { createWidgetRegistry, defineWidget, withWidgets, type Widget, type WidgetCtx } from "./widget";
import { SK_WIDGET, WIDGETS } from "./widgets";

const CTX: ReadCtx = { density: DESK, band: "rail", room: "board" };

const paths = (v: Record<string, PathValue> = {}): WidgetCtx => ({ paths: () => v });

const base: Registry = createRegistry([
  defineFeature({
    id: "core",
    instruments: [
      { id: "nav.sog", short: "SOG", label: "Speed", maxUrgency: "none", read: () => ({ value: "5" }) },
    ],
  }),
]);

const cfg = (widgets: ChromeConfig["dashboard"]["widgets"]): ChromeConfig => ({
  density: DESK,
  pointerCoarse: false,
  enabled: {},
  bands: { rail: { order: [] }, top: { order: [] } },
  dashboard: { tabs: [], widgets },
});

describe("defineWidget — validates and enforces the safety invariant", () => {
  test("a parameterized widget without an idPrefix is refused", () => {
    expect(() =>
      defineWidget({ id: "x", kind: "parameterized", label: "X", maxUrgency: "none", spec: [], build: () => base.byId("nav.sog")! }),
    ).toThrow(/idPrefix/);
  });

  test("a static widget with an idPrefix is refused", () => {
    expect(() =>
      defineWidget({ id: "x", kind: "static", label: "X", idPrefix: "x:", maxUrgency: "none", spec: [], build: () => base.byId("nav.sog")! }),
    ).toThrow(/must not have an idPrefix/);
  });

  test("a parameterized widget is FORCED to maxUrgency:none, whatever it asks for", () => {
    const w = defineWidget({
      id: "danger",
      kind: "parameterized",
      idPrefix: "d:",
      label: "Danger",
      maxUrgency: "alarm", // an author tries to grant itself an alarm…
      spec: [{ key: "path", type: "text", label: "PATH", required: true }],
      build: (id) => ({ id, short: "D", label: "D", maxUrgency: "alarm", read: () => ({ value: "1" }) }),
    });
    expect(w.maxUrgency).toBe("none"); // …and defineWidget takes it away
  });

  test("capability flags default per kind", () => {
    const paramWithSpec = defineWidget({
      id: "p",
      kind: "parameterized",
      idPrefix: "p:",
      label: "P",
      maxUrgency: "none",
      spec: [{ key: "path", type: "text", label: "PATH", required: true }],
      build: (id) => ({ id, short: "P", label: "P", maxUrgency: "none", read: () => ({ value: "1" }) }),
    });
    expect(paramWithSpec.editable).toBe(true);
    expect(paramWithSpec.deletable).toBe(true);

    const stat = defineWidget({
      id: "s",
      kind: "static",
      label: "S",
      maxUrgency: "none",
      spec: [],
      build: (id) => ({ id, short: "S", label: "S", maxUrgency: "none", read: () => ({ value: "1" }) }),
    });
    expect(stat.editable).toBe(false);
    expect(stat.deletable).toBe(false);
  });
});

describe("(a) a NEW widget kind registers via ONE descriptor + ONE array line", () => {
  // A brand-new parameterized kind — the acceptance test's "gauge". No edit to
  // config.ts or DashboardEditor.tsx: just this descriptor and the array below.
  const GAUGE: Widget = defineWidget({
    id: "gauge",
    kind: "parameterized",
    idPrefix: "g:",
    label: "Gauge",
    maxUrgency: "none",
    spec: [
      { key: "path", type: "text", label: "PATH", required: true },
      { key: "max", type: "number", label: "MAX", default: 100 },
    ],
    build: (id, spec, ctx) => ({
      id,
      short: "G",
      label: typeof spec.label === "string" ? spec.label : "Gauge",
      maxUrgency: "none",
      read: () => ({ value: String(ctx.paths()[String(spec.path)]?.value ?? "—") }),
    }),
  });

  const reg = createWidgetRegistry([...WIDGETS, GAUGE]);

  test("appears in the registry the picker derives its sources from", () => {
    // DashboardEditor's PICK_SOURCES is `[INSTRUMENT_SOURCE, ...reg.parameterized.map(...)]`,
    // so being in `.parameterized` IS appearing in the picker.
    expect(reg.parameterized.map((w) => w.id)).toContain("gauge");
    expect(reg.byKind("gauge")).toBe(GAUGE);
  });

  test("carries the spec schema the add/edit forms are GENERATED from", () => {
    // A field stated once drives both forms; there is no per-kind form to write.
    expect(GAUGE.spec.map((f) => f.key)).toEqual(["path", "max"]);
    expect(GAUGE.spec.find((f) => f.key === "max")?.default).toBe(100);
  });

  test("a stored instance resolves through withWidgets.byId, built from its spec", () => {
    const chrome = () => cfg({ "g:1": { kind: "gauge", spec: { path: "elec.v", max: 200 } } });
    const merged = withWidgets(base, reg, chrome, paths({ "elec.v": { value: 12.6 } }));
    const inst = merged.byId("g:1");
    expect(inst?.id).toBe("g:1");
    expect(inst?.read(CTX).value).toBe("12.6");
  });

  test("a duplicate kind is refused at registry construction", () => {
    expect(() => createWidgetRegistry([GAUGE, GAUGE])).toThrow(/duplicate widget kind/);
  });
});

describe("(b) the SAFETY invariant — a parameterized widget can never alarm", () => {
  // A malicious/buggy build that tries to be alarm-grade and scream every tick.
  const ROGUE: Widget = defineWidget({
    id: "rogue",
    kind: "parameterized",
    idPrefix: "r:",
    label: "Rogue",
    maxUrgency: "none",
    spec: [{ key: "path", type: "text", label: "PATH", required: true }],
    build: (id) => ({
      id,
      short: "R",
      label: "Rogue",
      maxUrgency: "alarm", // tries to grant itself an alarm ceiling
      urgency: () => "alarm", // …and to request one every tick
      alertText: () => ["ROGUE", "should never fire"] as const,
      read: () => ({ value: "1" }),
    }),
  });
  const reg = createWidgetRegistry([ROGUE]);
  const chrome = () => cfg({ "r:1": { kind: "rogue", spec: { path: "a" } } });
  const merged = withWidgets(base, reg, chrome, paths());

  test("the built instance is clamped: maxUrgency none, no urgency, no alertText", () => {
    const inst = merged.byId("r:1")!;
    expect(inst.maxUrgency).toBe("none");
    expect(inst.urgency).toBeUndefined();
    expect(inst.alertText).toBeUndefined();
    expect(urgencyOf(inst)).toBe("none");
  });

  test("it is NOT in reg.instruments, so alerts() never sees it", () => {
    expect(merged.instruments).toBe(base.instruments);
    expect(merged.instruments.some((i) => i.id === "r:1")).toBe(false);
    expect(alerts(merged)).toEqual([]);
  });

  test("base instruments still resolve unchanged", () => {
    expect(merged.byId("nav.sog")).toBe(base.byId("nav.sog"));
  });

  test("an unknown / unstored id is undefined", () => {
    expect(merged.byId("r:404")).toBeUndefined();
    expect(merged.byId("nope")).toBeUndefined();
  });
});

describe("(c) persistence MIGRATION — old skWidgets → {kind, spec}, no loss", () => {
  const legacy = {
    density: "desk",
    enabled: {},
    bands: { rail: { order: [] }, top: { order: [] } },
    dashboard: {
      tabs: [{ id: "nav", label: "Nav", order: ["sk:1"] }],
      skWidgets: {
        "sk:1": { path: "electrical.batteries.house.voltage", label: "House", unit: "V", decimals: 2 },
      },
    },
  } as unknown as ChromeConfig;

  test("normalize lifts each legacy spec onto {kind:'sk', spec} verbatim", () => {
    const migrated = normalize(legacy);
    expect(migrated.dashboard.widgets["sk:1"]).toEqual({
      kind: "sk",
      spec: { path: "electrical.batteries.house.voltage", label: "House", unit: "V", decimals: 2 },
    });
    // the tab that referenced sk:1 is untouched — the user's dashboard is intact
    expect(migrated.dashboard.tabs[0].order).toEqual(["sk:1"]);
  });

  test("the migrated instance resolves and reads through the unified registry", () => {
    const migrated = normalize(legacy);
    const reg = createWidgetRegistry(WIDGETS); // sk is the only kind
    const merged = withWidgets(
      base,
      reg,
      () => migrated,
      paths({ "electrical.batteries.house.voltage": { value: 12.634, units: "V" } }),
    );
    const inst = merged.byId("sk:1");
    expect(inst?.label).toBe("House");
    // decimals:2 and unit:V overrides survived the migration
    expect(inst?.read(CTX)).toEqual({ value: "12.63", unit: "V" });
  });

  test("SK_WIDGET is the first descriptor and is parameterized at the sk: prefix", () => {
    expect(SK_WIDGET.kind).toBe("parameterized");
    expect(SK_WIDGET.idPrefix).toBe("sk:");
    expect(WIDGETS[0]).toBe(SK_WIDGET);
  });
});
