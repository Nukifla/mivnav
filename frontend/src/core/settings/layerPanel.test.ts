/**
 * The Layers quick-panel selector (`layerQuickPanel`) — the pure logic behind the
 * CHART-DETAIL half of the rail's Layers button, proved on the REAL assembled
 * registry the panel renders, without a DOM. (The map OVERLAYS — weather,
 * satellite, POI, OpenSeaMap — are the generic `OverlayControl` registry now,
 * covered by overlayRegistry.test.ts, not this selector.) Asserts:
 *
 *  (a) the curated chart-detail subset is grouped and ordered as the panel draws
 *      it, and every returned setting is a TOGGLE with a live read/write binding
 *      (so the panel can render + drive it);
 *  (b) it REUSES the registry declarations — a chart-detail toggle's read/write
 *      drives the same ChartSettings field the deep settings does, and its cascade
 *      (Text→names) is the same one;
 *  (c) a chart-detail id absent from the registry is simply dropped rather than
 *      crashing (the same tolerance the rest of the app shows a layer it lacks);
 *  (d) the Vessels layers (declared bespoke, not the registry) ride
 *      VESSEL_LAYERS and drive their ChartSettings fields.
 *  (e) the PANEL'S OWN CONTEXT (`layersPanelCtx`) actually backs those
 *      descriptors — the App→panel seam, and the one thing (a)–(d) cannot see,
 *      because they each hand the descriptor a ctx they built themselves.
 *
 * (e) exists because it did not, and `showGrid` shipped dead: the panel built a
 * ctx with `showGrid: false, onShowGrid: () => {}` hardcoded. Note also that the
 * `makeCtx` fixture below is annotated `DeviceCtx` but used to OMIT the
 * device-only fields (`showGrid`, the diagnostics signals, `applyLayout`) — it
 * compiled only because tsconfig excludes `src/**\/*.test.ts`, so a fixture that
 * had silently drifted from the real context is part of why this was invisible.
 * It is complete now; keep it that way.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { ChartSet } from "../catalog";
import type { ChromeConfig } from "../chrome/config";
import type { Registry } from "../chrome/registry";
import { layersPanelCtx, type LayersPanelProps } from "../chrome/LayersPanel";
import { createSettingsRegistry, isSettingEnabled } from "./registry";
import { DEFAULT_SETTINGS, type ChartSettings } from "../style/settings";
import {
  CHART_DETAIL_ONLY_LAYERS,
  DEVICE_SECTIONS,
  DEVICE_SETTINGS,
  layerQuickPanel,
  VESSEL_LAYERS,
  type DeviceCtx,
} from "./device";

// The registry the app assembles: the base device settings. This is what App.tsx
// drills to the panel, so the selector is tested against the real thing.
const reg = createSettingsRegistry([...DEVICE_SETTINGS], DEVICE_SECTIONS);
// A registry missing one chart-detail declaration — proves the by-id lookup drops
// a missing layer rather than crashing. `showLightDescriptions` is a cascade LEAF
// (it depends on `showLights`; nothing depends on it), so removing it leaves the
// registry's dependsOn graph intact. It took over from `symbolStylePaper`, which
// was the stand-in until the paper-symbol toggle was retired (qpznkrtr).
const regNoLeaf = createSettingsRegistry(
  DEVICE_SETTINGS.filter((s) => s.id !== "showLightDescriptions"),
  DEVICE_SECTIONS,
);

/** A DeviceCtx backed by real signals, so read/write can be exercised. COMPLETE
 * — every field of the real `DeviceCtx`, including the device-only signals
 * (`showGrid`, the diagnostics toggles) that are not `ChartSettings` fields.
 * Nothing typechecks this file (tsconfig excludes tests), so a missing field
 * here is a blind spot, not a compile error. */
function makeCtx(init: Partial<ChartSettings> = {}) {
  const [settings, setSettings] = createSignal<ChartSettings>({ ...DEFAULT_SETTINGS, ...init });
  const [showGrid, setShowGrid] = createSignal(false);
  const ctx: DeviceCtx = {
    get settings() {
      return settings();
    },
    onSettings: (patch) => setSettings((s) => ({ ...s, ...patch })),
    debugLayers: false,
    onDebugLayers: () => {},
    debugTiles: false,
    onDebugTiles: () => {},
    debugCells: false,
    onDebugCells: () => {},
    fpsDebug: false,
    onFpsDebug: () => {},
    get showGrid() {
      return showGrid();
    },
    onShowGrid: setShowGrid,
    sets: [] as ChartSet[],
    disabledSets: [],
    onToggleSet: () => {},
    catalogError: "",
    onRetryCatalog: () => {},
    reg: {} as Registry,
    chrome: (() => ({}) as ChromeConfig) as DeviceCtx["chrome"],
    onChrome: () => {},
    applyLayout: () => {},
  };
  return { ctx, settings, showGrid };
}

describe("(a) grouping, order, and control kind", () => {
  test("two groups, titled and ordered as the panel draws them", () => {
    expect(layerQuickPanel(reg).map((g) => g.title)).toEqual(["Chart detail", "Vessels"]);
  });

  test("Chart detail is the curated chart-detail layers, in order", () => {
    const g = layerQuickPanel(reg).find((g) => g.title === "Chart detail")!;
    // Sounding visibility is the `enc:soundings` layer group in the Map-layers list,
    // not a Chart-detail toggle, so it is deliberately absent here.
    // `showOsmOnLand`/`showGrid` are appended from `CHART_DETAIL_ONLY_LAYERS`
    // (task xpstmort) — neither is a registry lookup any more, since removing
    // their deep-Settings duplicate meant removing their DEVICE_SETTINGS entry.
    expect(g.settings.map((s) => s.id)).toEqual([
      "showText",
      "showAtonText",
      "showLights",
      "showLightDescriptions",
      "showOsmOnLand",
      "showGrid",
    ]);
  });

  test("Vessels is the bespoke VESSEL_LAYERS toggles", () => {
    const g = layerQuickPanel(reg).find((g) => g.title === "Vessels")!;
    expect(g.settings).toBe(VESSEL_LAYERS);
    expect(g.settings.map((s) => s.id)).toEqual([
      "showAisTargets",
      "showAisRisk",
      "showHeadingLine",
      "showAisGhost",
    ]);
  });

  test("every exposed layer is a toggle with a read/write binding", () => {
    for (const g of layerQuickPanel(reg))
      for (const s of g.settings) {
        expect(s.control.kind).toBe("toggle");
        expect(typeof s.read).toBe("function");
        expect(typeof s.write).toBe("function");
      }
  });
});

describe("(b) it reuses the registry declarations (state + cascade)", () => {
  test("a chart-detail toggle drives the same ChartSettings field", () =>
    createRoot((dispose) => {
      const { ctx, settings } = makeCtx({ showText: true });
      const s = layerQuickPanel(reg)[0]!.settings.find((s) => s.id === "showText")!;
      expect(s.read!(ctx)).toBe(true);
      s.write!(ctx, false);
      expect(settings().showText).toBe(false);
      dispose();
    }));

  test("the Text→names cascade still gates the sub-toggle", () => {
    const sub = layerQuickPanel(reg)[0]!.settings.find((s) => s.id === "showAtonText")!;
    expect(isSettingEnabled(reg, sub, makeCtx({ showText: false }).ctx)).toBe(false);
    expect(isSettingEnabled(reg, sub, makeCtx({ showText: true }).ctx)).toBe(true);
  });
});

describe("(c) a missing declaration drops its layer, no crash", () => {
  test("Chart detail omits the toggle whose declaration is absent", () => {
    const g = layerQuickPanel(regNoLeaf).find((g) => g.title === "Chart detail")!;
    expect(g.settings.map((s) => s.id)).not.toContain("showLightDescriptions");
    expect(g.settings.map((s) => s.id)).toContain("showText");
  });
});

describe("(d) the Vessels layers drive their ChartSettings fields", () => {
  test("collision colouring and heading line read/write settings", () =>
    createRoot((dispose) => {
      const { ctx, settings } = makeCtx({ showAisRisk: false, showHeadingLine: true });
      const risk = VESSEL_LAYERS.find((s) => s.id === "showAisRisk")!;
      const heading = VESSEL_LAYERS.find((s) => s.id === "showHeadingLine")!;
      expect(risk.read!(ctx)).toBe(false);
      risk.write!(ctx, true);
      expect(settings().showAisRisk).toBe(true);
      heading.write!(ctx, false);
      expect(settings().showHeadingLine).toBe(false);
      dispose();
    }));
});

describe("(e) the panel's own context backs the descriptors it renders", () => {
  /** The props App drills in, over live signals — `layersPanelCtx` reads them
   * through getters, so the ctx must track them, not snapshot them. */
  function makeProps(grid: boolean) {
    const [showGrid, setShowGrid] = createSignal(grid);
    const [settings, setSettings] = createSignal<ChartSettings>(DEFAULT_SETTINGS);
    const props = {
      open: true,
      onOpenChange: () => {},
      reg,
      get settings() {
        return settings();
      },
      onSettings: (patch: Partial<ChartSettings>) => setSettings((s) => ({ ...s, ...patch })),
      layers: [],
      onReorder: () => {},
      onMoreSettings: () => {},
      get showGrid() {
        return showGrid();
      },
      onShowGrid: setShowGrid,
    } as unknown as LayersPanelProps;
    return { props, showGrid, settings };
  }

  const grid = CHART_DETAIL_ONLY_LAYERS.find((s) => s.id === "showGrid")!;

  test("Lat/long grid reads this device's signal, not a hardcoded false", () =>
    createRoot((dispose) => {
      const { props } = makeProps(true);
      expect(grid.read!(layersPanelCtx(props))).toBe(true);
      dispose();
    }));

  test("toggling Lat/long grid writes back, and the toggle then reads ON", () =>
    createRoot((dispose) => {
      const { props, showGrid } = makeProps(false);
      const ctx = layersPanelCtx(props);
      grid.write!(ctx, true);
      // The write reaches this device's signal…
      expect(showGrid()).toBe(true);
      // …and the toggle reads its new value back, instead of springing to off.
      expect(grid.read!(ctx)).toBe(true);
      dispose();
    }));

  test("a chart-detail toggle still drives ChartSettings through the same ctx", () =>
    createRoot((dispose) => {
      const { props, settings } = makeProps(false);
      const ctx = layersPanelCtx(props);
      const text = layerQuickPanel(reg)[0]!.settings.find((s) => s.id === "showText")!;
      text.write!(ctx, false);
      expect(settings().showText).toBe(false);
      dispose();
    }));
});
