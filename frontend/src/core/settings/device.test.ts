/**
 * The DEVICE settings declarations (C3) — proved on the REAL registry the panel
 * renders, without a DOM (an on-screen eyeball of the generated sections is a
 * Phase-3 item). Asserts the four things the chunk requires:
 *
 *  (a) a declared simple setting generates the RIGHT control and its read/write
 *      binding drives the backing `ChartSettings` signal;
 *  (b) the escape hatches are honoured — the bespoke sections register as
 *      render-only (no generic generation), and the ODbL note as a `custom`
 *      control — so a bespoke component is emitted unchanged;
 *  (c) the master/sub cascade disables the sub when its master is off
 *      (Text→AtonText, and Text+Lights→LightDescriptions);
 *  (d) a declared coercion falls a malformed stored value back to its default.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { ChartSet } from "../catalog";
import type { ChromeConfig } from "../chrome/config";
import type { Registry } from "../chrome/registry";
import { createSettingsRegistry, deviceScopedSettings, isSettingEnabled } from "./registry";
import { DEFAULT_SETTINGS, type ChartSettings } from "../style/settings";
import { settingsFromProfile } from "../profiles";
import {
  APPEARANCE,
  CHART_DATA,
  DEVICE_CATEGORIES,
  DEVICE_SECTIONS,
  DEVICE_SETTINGS,
  type DeviceCtx,
} from "./device";

// The registry is no longer a module const (C4 un-static'd it — App.tsx builds it
// from the base declarations plus feature contributions). This proves the SAME
// base declarations the app assembles, so the C3 guarantees still hold.
const reg = createSettingsRegistry(DEVICE_SETTINGS, DEVICE_SECTIONS, DEVICE_CATEGORIES);

/** A DeviceCtx backed by real signals, so read/write can be exercised. */
function makeCtx(init: Partial<ChartSettings> = {}) {
  const [settings, setSettings] = createSignal<ChartSettings>({ ...DEFAULT_SETTINGS, ...init });
  const [debug, setDebug] = createSignal(false);
  const [tiles, setTiles] = createSignal(false);
  const [cells, setCells] = createSignal(false);
  const [fps, setFps] = createSignal(false);
  const [grid, setGrid] = createSignal(false);
  const ctx: DeviceCtx = {
    get settings() {
      return settings();
    },
    onSettings: (patch) => setSettings((s) => ({ ...s, ...patch })),
    get debugLayers() {
      return debug();
    },
    onDebugLayers: setDebug,
    get debugTiles() {
      return tiles();
    },
    onDebugTiles: setTiles,
    get debugCells() {
      return cells();
    },
    onDebugCells: setCells,
    get fpsDebug() {
      return fps();
    },
    onFpsDebug: setFps,
    get showGrid() {
      return grid();
    },
    onShowGrid: setGrid,
    sets: [] as ChartSet[],
    disabledSets: [],
    onToggleSet: () => {},
    catalogError: "",
    onRetryCatalog: () => {},
    reg: {} as Registry,
    chrome: (() => ({}) as ChromeConfig) as DeviceCtx["chrome"],
    onChrome: () => {},
  };
  return { ctx, settings, debug };
}

describe("(a) generation — the right control, and read/write drives the signal", () => {
  test("the generated sections appear in order, interleaved with the bespoke ones", () => {
    expect(reg.orderedSections.map((s) => s.id)).toEqual([
      "depth",
      "display",
      "text",
      "chrome",
      "ais",
      "sets",
      "profiles",
      "diagnostics",
      "theme-editor",
    ]);
  });

  // The "This device" RAIL — one row per pane, in rail order (task xpstmort).
  // Profiles is FIRST now (promoted — a profile snapshots every setting on the
  // tab, not one slice of it, see DEVICE_CATEGORIES' own comment). Appearance is
  // the one device category besides "Data on this chart" that holds more than
  // one section — Depth/Display/Text & Lights/Display density, the four "how
  // this draws" sections that used to be four separate rail rows. Diagnostics
  // is last and deliberately low-traffic.
  test("the device rail is the declared category order", () => {
    expect(reg.categoriesIn("device").map((c) => c.id)).toEqual([
      "profiles",
      APPEARANCE,
      CHART_DATA,
      "ais",
      "diagnostics",
    ]);
    expect(reg.categoriesIn("server")).toEqual([]);
    // Every rail row can draw itself: a hand-declared category carries an icon.
    for (const cat of reg.categoriesIn("device")) expect(cat.icon).toBeDefined();
  });

  test("Chart sets is a section OF the 'Data on this chart' pane, not a pane of its own", () => {
    expect(reg.sectionsFor(CHART_DATA).map((s) => s.id)).toEqual(["sets"]);
    expect(reg.categoryById("sets")).toBeUndefined();
  });

  // Depth/Display/Text & Lights/Display density (the "chrome" section) share
  // the Appearance pane; Depth/Display/Text & Lights are generated sections,
  // Display density is render-only (ChromeSection).
  test("Appearance holds Depth, Display, Text & Lights and Display density, in that order", () => {
    expect(reg.sectionsFor(APPEARANCE).map((s) => s.id)).toEqual([
      "depth",
      "display",
      "text",
      "chrome",
    ]);
  });

  // The four developer overlays used to be mixed in among the sailor-facing
  // Overlays toggles; they are their own low-traffic pane now, and nothing was
  // dropped on the way. Overlays itself is gone (task xpstmort): its members
  // either moved into Display (attribution) or out of deep Settings entirely
  // into the Layers-panel-only `CHART_DETAIL_ONLY_LAYERS` (showOsmOnLand,
  // showGrid — see device.tsx's own comment on why). `windTunerDebug` (the
  // WindTuner dev panel's gate) was the fifth — removed with the tuner once
  // FLOW_* was baked from a live tuning pass (task qusvzylu).
  test("Diagnostics holds exactly the four developer overlays; Overlays no longer exists", () => {
    expect(reg.settingsFor("diagnostics").map((s) => s.id)).toEqual([
      "debugLayers",
      "debugTiles",
      "debugCells",
      "fpsDebug",
    ]);
    expect(reg.sectionById("overlays")).toBeUndefined();
    expect(reg.settingsFor("display").map((s) => s.id)).toEqual([
      "palette",
      "atonIconScale",
      "ownShipScale",
      "keepScreenOn",
      "attribution",
    ]);
  });

  test("Depth generates a contour slider with the right range/format, plus the no-alarm note", () => {
    const items = reg.settingsFor("depth");
    // `depthNote` is a display-only custom control clarifying the sliders adjust
    // shading only (there is no depth alarm) — it carries no value. Sounding
    // VISIBILITY is no longer a toggle here — it is the `enc:soundings` layer group
    // in the Layers panel — so Depth is just the two shading sliders plus the note.
    expect(items.map((s) => s.id)).toEqual(["shallowDepth", "safetyContour", "deepDepth", "depthNote"]);
    expect(reg.byId("depthNote")!.control.kind).toBe("custom");
    const contour = reg.byId("safetyContour")!;
    expect(contour.control).toMatchObject({ kind: "number", min: 0, max: 100, step: 0.1, as: "field" });
    expect((contour.control as { format: (v: number) => string }).format(6)).toBe("6 m");
    expect(contour.label).toBe("Level 2 up to — safety contour (m)");
  });

  test("the level-2 slider moves the safety depth with the safety contour", () =>
    createRoot((dispose) => {
      const { ctx, settings } = makeCtx({ safetyContour: 4, safetyDepth: 4 });
      reg.byId("safetyContour")!.write!(ctx, 5);
      expect(settings().safetyContour).toBe(5);
      expect(settings().safetyDepth).toBe(5);
      dispose();
    }));

  test("a boolean setting reads and writes its ChartSettings field", () =>
    createRoot((dispose) => {
      const { ctx, settings } = makeCtx({ showText: true });
      const s = reg.byId("showText")!;
      expect(s.control.kind).toBe("toggle");
      expect(s.read!(ctx)).toBe(true);
      s.write!(ctx, false);
      expect(settings().showText).toBe(false);
      expect(s.read!(ctx)).toBe(false);
      dispose();
    }));

  test("the palette enum is a dropdown over every theme", () => {
    const p = reg.byId("palette")!;
    expect(p.control).toMatchObject({ kind: "enum", as: "select" });
    // Dropdown order: the day/dusk/night ROLES first (uqolozkr — `paper2` and
    // `graphite2` hold the day and dusk roles now), then the old S-52 tables
    // under their unchanged ids, offered as "S52-Day"/"S52-Dusk".
    expect((p.control as { options: readonly string[] }).options).toEqual([
      "paper2",
      "graphite2",
      "night",
      "day",
      "dusk",
      "whiteback",
      "blackback",
      "slick",
      "paper",
      "graphite",
      "sunset",
      "vintage",
      "modern-paper-2",
      "modern-paper-2-night-dim",
      "modern-paper-2-night-red",
      "modern-paper-2-moonlight",
    ]);
  });

  test("debugLayers is generated but backed by its OWN signal, not ChartSettings", () =>
    createRoot((dispose) => {
      const { ctx, debug, settings } = makeCtx();
      const s = reg.byId("debugLayers")!;
      expect(s.read!(ctx)).toBe(false);
      s.write!(ctx, true);
      expect(debug()).toBe(true);
      // it must NOT have leaked into the ChartSettings blob
      expect((settings() as unknown as Record<string, unknown>).debugLayers).toBeUndefined();
      dispose();
    }));
});

describe("(b) escape hatches — bespoke sections render-only, prose as custom", () => {
  test("the AIS / chart-sets / chrome / profiles sections are render-only", () => {
    for (const id of ["ais", "sets", "chrome", "profiles"]) {
      const sec = reg.sectionById(id)!;
      expect(typeof sec.render).toBe("function");
      // render-only means NO generic settings target it — it is emitted verbatim
      expect(reg.settingsFor(id)).toHaveLength(0);
    }
  });

  test("the ODbL attribution is a custom control, not a generated one", () => {
    const note = reg.byId("attribution")!;
    expect(note.control.kind).toBe("custom");
    expect(typeof (note.control as { component: unknown }).component).toBe("function");
    // a display-only custom control carries no value binding
    expect(note.read).toBeUndefined();
    expect(note.coerce).toBeUndefined();
  });
});

describe("(c) the master/sub cascade", () => {
  test("Buoy & beacon names is disabled when Text labels is off", () => {
    const sub = reg.byId("showAtonText")!;
    expect(isSettingEnabled(reg, sub, makeCtx({ showText: false }).ctx)).toBe(false);
    expect(isSettingEnabled(reg, sub, makeCtx({ showText: true }).ctx)).toBe(true);
  });

  test("Light descriptions needs BOTH Text labels and Lights on", () => {
    const sub = reg.byId("showLightDescriptions")!;
    expect(isSettingEnabled(reg, sub, makeCtx({ showText: true, showLights: false }).ctx)).toBe(false);
    expect(isSettingEnabled(reg, sub, makeCtx({ showText: false, showLights: true }).ctx)).toBe(false);
    expect(isSettingEnabled(reg, sub, makeCtx({ showText: true, showLights: true }).ctx)).toBe(true);
  });
});

describe("(d) coercion of a malformed stored value falls back to the default", () => {
  test("every generated device setting has a total, default-stable coerce", () => {
    for (const s of reg.settings) {
      if (s.control.kind === "custom") continue;
      expect(typeof s.coerce).toBe("function");
      // malformed input never throws and never escapes the value domain
      expect(() => s.coerce!(Symbol("junk") as unknown)).not.toThrow();
      expect(s.coerce!(s.default)).toBe(s.default!);
    }
  });

  test("safetyContour rejects a corrupt stored value back to 4 m", () => {
    const s = reg.byId("safetyContour")!;
    expect(s.coerce!("deep")).toBe(4);
    expect(s.coerce!(null)).toBe(4);
    expect(s.coerce!(9.5)).toBe(9.5);
  });
});

describe("(e) profile scope — a profile is a snapshot of the device-scoped settings", () => {
  // The profile-scope adapter (B4): loading a profile blob coerces every
  // ChartSettings-backed device setting from it (a copy into the device signals,
  // not a live binding), realized by `settingsFromProfile`. `deviceScopedSettings`
  // is the registry's statement of WHICH settings a profile is a snapshot of.
  test("loading a blob coerces every ChartSettings-backed device setting", () =>
    createRoot((dispose) => {
      // a hand-editable blob: good values, plus one corrupt field
      const blob = {
        palette: "night",
        atonIconScale: 1.5,
        safetyContour: "junk", // corrupt → must fall to the default via coercion
      };
      const { ctx } = makeCtx(settingsFromProfile(blob));

      // every profiled device setting emerges COERCED — a value valid for its own
      // domain, never a raw blob entry. (`showOsmOnLand` and `showGrid` no
      // longer appear in `deviceScopedSettings(reg)` at all — task xpstmort
      // moved both out of DEVICE_SETTINGS into the Layers-panel-only
      // CHART_DETAIL_ONLY_LAYERS; `showOsmOnLand` is still profiled, just by
      // `settingsFromProfile` directly, independent of this registry.)
      for (const s of deviceScopedSettings(reg)) {
        if (s.control.kind === "custom") continue; // attribution: no value
        // device-only toggles backed by their own signals, not ChartSettings —
        // deliberately not part of a visual profile snapshot.
        if (
          s.id === "debugLayers" ||
          s.id === "debugTiles" ||
          s.id === "debugCells" ||
          s.id === "fpsDebug"
        )
          continue;
        const v = s.read!(ctx);
        expect(s.coerce!(v)).toBe(v);
      }

      // the good values landed through the registry's reads
      expect(reg.byId("palette")!.read!(ctx)).toBe("night");
      expect(reg.byId("atonIconScale")!.read!(ctx)).toBe(1.5);
      // the corrupt one fell back to its default, not into the value domain
      expect(reg.byId("safetyContour")!.read!(ctx)).toBe(DEFAULT_SETTINGS.safetyContour);
      dispose();
    }));

  test("every profiled device setting is scope:'device' and coerce-backed", () => {
    for (const s of deviceScopedSettings(reg)) {
      expect(s.scope).toBe("device");
      if (s.control.kind !== "custom") expect(typeof s.coerce).toBe("function");
    }
  });
});
