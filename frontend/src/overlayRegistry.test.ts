/**
 * THE GENERIC OVERLAY REGISTRY, proved. The Layers panel renders map overlays
 * from `OverlayControl` descriptors (chrome/feature.ts), one per feature plus a
 * base list, with NO per-overlay special case. This builds the SAME registry
 * App.tsx does — the base OpenSeaMap descriptor plus the weather / satellite / POI
 * feature projections (`featureOverlayControls`) — and asserts:
 *
 *  (a) every real overlay contributes a descriptor with a working toggle, and an
 *      opacity slider iff the overlay carries one (weather ✓, satellite ✓; POI
 *      and OpenSeaMap toggle-only) — so the panel can render both shapes;
 *  (b) WEATHER's control drives `keepVisible` and NOT the interactive mode — the
 *      reported bug: toggling weather in the panel shows/hides the wash without
 *      entering the weather MODE. `visible` also reflects the in-mode state.
 *  (c) SATELLITE / POI / OpenSeaMap toggles drive their ChartSettings fields, and
 *      satellite's opacity drives `satelliteOpacity`.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  featureOverlayControls,
  type OverlayControl,
  type OverlayControlDeps,
} from "./core/chrome/feature";
import { createWeather } from "./features/weather";
import { createSatellite } from "./features/satellite";
import { createPoi } from "./features/poi";
import { DEFAULT_SETTINGS, type ChartSettings } from "./core/style/settings";

/** Build the real registry the way App does, under a reactive owner (the feature
 * catalogs use createSignal/onCleanup), with network fetches stubbed away and the
 * active mode driven by a signal so the weather in-mode path is exercisable. */
function harness() {
  return createRoot((dispose) => {
    const [settings, setSettings] = createSignal<ChartSettings>({ ...DEFAULT_SETTINGS });
    const [activeMode, setActiveMode] = createSignal<string | null>(null);
    const patch = (p: Partial<ChartSettings>) => setSettings((s) => ({ ...s, ...p }));

    const weather = createWeather({
      settings,
      setSettings: (fn) => setSettings(fn),
      toggleWindUnit: () => {},
    });
    const satellite = createSatellite({ fetchSets: async () => [], fetchSources: async () => [] });
    const poi = createPoi({ fetch: async () => [] });
    const features = [weather.feature, satellite.feature, poi.feature];

    // App's base list: OpenSeaMap (a chart-style raster, no feature module).
    const base: OverlayControl[] = [
      {
        id: "openseamap",
        label: "OpenSeaMap seamarks",
        visible: () => settings().showOpenSeaMap,
        setVisible: (v) => patch({ showOpenSeaMap: v }),
      },
    ];
    const deps: OverlayControlDeps = { settings, setSettings: patch, activeMode };
    const controls = [...base, ...featureOverlayControls(features, deps)];
    const byId = (id: string) => controls.find((c) => c.id === id)!;
    return { controls, byId, settings, setActiveMode, dispose };
  });
}

describe("(a) the registry covers every overlay, toggle + opacity as declared", () => {
  test("weather, satellite, POI and OpenSeaMap all appear", () => {
    const h = harness();
    expect(h.controls.map((c) => c.id).sort()).toEqual(
      ["openseamap", "poi", "satellite", "weather"].sort(),
    );
    h.dispose();
  });

  test("opacity is present for weather + satellite, absent for POI + OpenSeaMap", () => {
    const h = harness();
    for (const id of ["weather", "satellite"]) {
      const c = h.byId(id);
      expect(typeof c.opacity).toBe("function");
      expect(typeof c.setOpacity).toBe("function");
    }
    for (const id of ["poi", "openseamap"]) {
      const c = h.byId(id);
      expect(c.opacity).toBeUndefined();
      expect(c.setOpacity).toBeUndefined();
    }
    h.dispose();
  });

  test("every control has a label and a working toggle", () => {
    const h = harness();
    for (const c of h.controls) {
      expect(typeof c.label).toBe("string");
      expect(typeof c.visible).toBe("function");
      expect(typeof c.setVisible).toBe("function");
    }
    h.dispose();
  });
});

describe("(b) weather's control drives keepVisible, NOT the mode", () => {
  test("toggling on shows the wash via keepVisible and never enters the mode", () => {
    const h = harness();
    const w = h.byId("weather");
    expect(w.visible()).toBe(false); // off, not in mode
    w.setVisible(true);
    expect(h.settings().weather.keepVisible).toBe(true); // it flipped keepVisible…
    expect(w.visible()).toBe(true);
    h.dispose();
  });

  test("visible() also reflects the in-mode state (wash shows while the tool is open)", () => {
    const h = harness();
    const w = h.byId("weather");
    expect(w.visible()).toBe(false);
    h.setActiveMode("weather"); // the interactive mode opened elsewhere
    expect(w.visible()).toBe(true); // shown even though keepVisible is still off
    expect(h.settings().weather.keepVisible).toBe(false);
    h.dispose();
  });

  test("toggling off clears keepVisible", () => {
    const h = harness();
    const w = h.byId("weather");
    w.setVisible(true);
    w.setVisible(false);
    expect(h.settings().weather.keepVisible).toBe(false);
    h.dispose();
  });
});

describe("(c) settings overlays drive their ChartSettings fields", () => {
  test("satellite toggle + opacity drive showSatellite / satelliteOpacity", () => {
    const h = harness();
    const s = h.byId("satellite");
    s.setVisible(true);
    expect(h.settings().showSatellite).toBe(true);
    s.setOpacity!(0.4);
    expect(h.settings().satelliteOpacity).toBe(0.4);
    h.dispose();
  });

  test("POI toggle drives showPois", () => {
    const h = harness();
    h.byId("poi").setVisible(true);
    expect(h.settings().showPois).toBe(true);
    h.dispose();
  });

  test("OpenSeaMap toggle drives showOpenSeaMap", () => {
    const h = harness();
    h.byId("openseamap").setVisible(true);
    expect(h.settings().showOpenSeaMap).toBe(true);
    h.dispose();
  });
});
