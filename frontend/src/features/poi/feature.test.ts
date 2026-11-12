/**
 * THE PROOF (frontend half): adding the POI feature is one `defineFeature`, and
 * it surfaces in every registry projection with no other wiring. `createPoi()`
 * returns one `AppFeature`; the `feature*` collectors (chrome/feature.ts) then
 * pull its overlay, provider and Layers-panel overlay control into the overlay
 * list, the info-panel providers and the map-layer registry respectively. POI's
 * visibility is that overlay control, not a deep-settings toggle, so it
 * contributes no `Setting`.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  featureDatasetParams,
  featureOverlays,
  featureOverlayControls,
  featureProviders,
  featureSettings,
  type AppFeature,
} from "../../core/chrome/feature";
import { createSettingsRegistry } from "../../core/settings/registry";
import { DEVICE_SECTIONS, DEVICE_SETTINGS } from "../../core/settings/device";
import { DEFAULT_SETTINGS } from "../../core/style/settings";
import PoiDatasetParams from "./DatasetParams";
import { createPoi } from "./index";

/** Build the feature under an owner (its catalog uses createSignal/onCleanup),
 * with the network fetch stubbed away. */
function poiFeature(): AppFeature {
  return createRoot(() => createPoi({ fetch: async () => [] }).feature);
}

describe("the one defineFeature surfaces in every projection", () => {
  test("kernel feature id is 'poi'", () => {
    expect(poiFeature().core.id).toBe("poi");
  });

  test("contributes exactly one overlay and provider, and no device setting", () => {
    const features = [poiFeature()];
    expect(featureOverlays(features).map((o) => o.id)).toEqual(["poi"]);
    expect(featureProviders(features).map((p) => p.id)).toEqual(["poi"]);
    // POI visibility is the Layers-panel overlay control now, not a deep-settings
    // toggle, so the feature contributes no `Setting` to the registry.
    expect(featureSettings(features)).toEqual([]);
  });

  test("its visibility is a Layers-panel overlay control, not a settings toggle", () => {
    const features = [poiFeature()];
    // Assembled exactly as App.tsx does it — base declarations plus the feature's
    // contributions. POI adds no setting, so no section anywhere carries a
    // `showPois` entry.
    const reg = createSettingsRegistry(
      [...DEVICE_SETTINGS, ...featureSettings(features)],
      [...DEVICE_SECTIONS],
    );
    expect(reg.byId("showPois")).toBeUndefined();
    // The visibility toggle rides the overlay-control projection instead: id "poi",
    // bound to `showPois` (a toggle alone — POI markers are symbols, not a wash).
    const controls = featureOverlayControls(features, {
      settings: () => DEFAULT_SETTINGS,
      setSettings: () => {},
      activeMode: () => null,
    });
    expect(controls.map((c) => c.id)).toEqual(["poi"]);
  });

  test("registers the POI dataset params form (the source picker)", () => {
    expect(featureDatasetParams([poiFeature()])).toEqual({ poi: PoiDatasetParams });
  });
});
