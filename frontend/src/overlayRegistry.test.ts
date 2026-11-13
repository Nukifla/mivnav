/**
 * THE GENERIC OVERLAY REGISTRY, proved. The Layers panel renders map overlays
 * from `OverlayControl` descriptors (chrome/feature.ts), one per feature plus a
 * base list, with NO per-overlay special case. This builds the SAME registry
 * App.tsx does — the base OpenSeaMap descriptor plus the satellite / POI
 * feature projections (`featureOverlayControls`) — and asserts:
 *
 *  (a) every real overlay contributes a descriptor with a working toggle, and an
 *      opacity slider iff the overlay carries one (satellite ✓; POI and
 *      OpenSeaMap toggle-only) — so the panel can render both shapes;
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
import { createSatellite } from "./features/satellite";
import { createPoi } from "./features/poi";
import { DEFAULT_SETTINGS, type ChartSettings } from "./core/style/settings";

/** Build the real registry the way App does, under a reactive owner (the feature
 * catalogs use createSignal/onCleanup), with network fetches stubbed away and the
 * active mode driven by a signal. */
function harness() {
  return createRoot((dispose) => {
    const [settings, setSettings] = createSignal<ChartSettings>({ ...DEFAULT_SETTINGS });
    const [activeMode, setActiveMode] = createSignal<string | null>(null);
    const patch = (p: Partial<ChartSettings>) => setSettings((s) => ({ ...s, ...p }));

    const satellite = createSatellite({ fetchSets: async () => [], fetchSources: async () => [] });
    const poi = createPoi({ fetch: async () => [] });
    const features = [satellite.feature, poi.feature];

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
  test("satellite, POI and OpenSeaMap all appear", () => {
    const h = harness();
    expect(h.controls.map((c) => c.id).sort()).toEqual(
      ["openseamap", "poi", "satellite"].sort(),
    );
    h.dispose();
  });

  test("opacity is present for satellite, absent for POI + OpenSeaMap", () => {
    const h = harness();
    for (const id of ["satellite"]) {
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
