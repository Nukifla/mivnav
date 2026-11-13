// THE ASSEMBLED SETTINGS SURFACE — the one registry, exactly as App.tsx builds it.
//
// The other settings tests each prove ONE declaration set in isolation (device.
// test.ts the device half, boat.test.ts the nav settings, registry.test.ts the
// index's invariants). Nothing proved the thing the redesign actually turns on:
// that the device declarations, the boat declarations and every feature's
// contributions compose into ONE ordered, navigable surface — which is what the
// shell iterates and therefore what a re-home can silently break.
//
// It also pins the CONSOLIDATIONS as facts rather than intentions: Charts absorbs
// the o-charts login, Datasets absorbs every provider's own data section, and both
// do it by generic category composition — POI and satellite name a category, they
// are not named by the core.

import { describe, expect, test } from "bun:test";
import {
  featureSettings,
  featureSettingsCategories,
  featureSettingsSections,
} from "./core/chrome/feature";
import { createRoot } from "solid-js";
import { createPoi } from "./features/poi";
import { createSatellite } from "./features/satellite";
import { createTrack } from "./features/track";
import { DEFAULT_SETTINGS } from "./core/style/settings";
import { BOAT_SETTINGS } from "./core/settings/boat";
import { COLLISION_SETTINGS } from "./core/settings/collision";
import { GNSS_SETTINGS } from "./core/settings/gnss";
import { SHALLOW_SECTION, SHALLOW_SETTINGS } from "./features/instruments/settings";
import { DEVICE_CATEGORIES, DEVICE_SECTIONS, DEVICE_SETTINGS } from "./core/settings/device";
import {
  createSettingsRegistry,
  defineSettingsCategory,
  isSettingEnabled,
  defineSettingsSection,
  type SettingsSection,
} from "./core/settings/registry";
import { BOAT_CATEGORIES, BOAT_SECTIONS } from "./core/settings/ServerSettings";
import type { SettingsCtx } from "./core/settings/ctx";

// Built under an owner (each feature's catalog uses createSignal/onCleanup), and
// with a stub fetch so nothing reaches the network — the same idiom as
// features/poi/feature.test.ts.
const noFetch = async () => [];
const features = createRoot(() => [
  createPoi({ fetch: noFetch }).feature,
  createSatellite({ fetch: noFetch }).feature,
  // The track feature's own "Ship track" section in the same `chart-data`
  // pane. Here for the composition itself: `createSettingsRegistry` throws on
  // a duplicate setting id or a section naming a category nobody declared, and
  // a feature that only ever assembles inside App.tsx would surface that as a
  // blank screen rather than a red gate. Its fetch is stubbed for the same
  // reason POI's and satellite's are — it is off by default and would not
  // fetch anyway, but the seam costs nothing and pins that.
  createTrack({
    settings: () => DEFAULT_SETTINGS,
    fetch: async () => ({ lines: [], recent: [], from: null, to: null, complete: true }),
  }).feature,
]);

/** Assembled as App.tsx assembles it. The instruments feature needs a live
 * SignalK client, so its shallow-water section is added directly — it is the
 * one that once landed in the rail by accident (no category named). */
const reg = createSettingsRegistry<SettingsCtx>(
  [...DEVICE_SETTINGS, ...BOAT_SETTINGS, ...COLLISION_SETTINGS, ...GNSS_SETTINGS, ...SHALLOW_SETTINGS, ...featureSettings(features)],
  [...DEVICE_SECTIONS, ...BOAT_SECTIONS, SHALLOW_SECTION, ...featureSettingsSections(features)],
  [...DEVICE_CATEGORIES, ...BOAT_CATEGORIES, ...featureSettingsCategories(features)],
);

describe("the assembled settings surface", () => {
  test("assembles at all — no duplicate id, no dangling section or cascade", () => {
    // `createSettingsRegistry` throws on any of those; reaching here is the proof.
    expect(reg.categories.length).toBeGreaterThan(0);
  });

  test("the two tabs are the whole surface — every category is device or server", () => {
    const device = reg.categoriesIn("device").map((c) => c.id);
    const server = reg.categoriesIn("server").map((c) => c.id);
    expect(device.length + server.length).toBe(reg.orderedCategories.length);
    // Task xpstmort's IA pass: Profiles promoted to first (a profile snapshots
    // every setting on the tab, not one category's worth); Depth/Display/Text &
    // Lights/Display density merged into one "appearance" pane; "overlays" is
    // gone (its members either moved into Display or into the Layers panel).
    // The theme editor is a section of "diagnostics" (Developer), not a pane.
    expect(device).toEqual(["profiles", "appearance", "chart-data", "ais", "diagnostics"]);
    expect(server).toEqual([
      "charts",
      // Datasets + the regions they are baked for.
      "datasets",
      "storage",
      "signalk",
      // Collision, shallow-water, GNSS & connection.
      "alarms",
      // Route following (+ the autorouting plugin's sections).
      "routes",
      "advanced",
      "plugins",
      // The server's own version and its release updates (/api/system).
      "software",
    ]);
  });

  test("Alarms is collision, shallow water, then GNSS & connection", () => {
    expect(reg.sectionsFor("alarms").map((s) => s.id)).toEqual(["collision", "shallow", "gnss"]);
  });

  // The auto-router's three sections join this pane from the autorouting
  // plugin (its own settings.test.ts); the core has route following alone.
  test("Routes is route following", () => {
    expect(reg.sectionsFor("routes").map((s) => s.id)).toEqual(["nav"]);
  });

  test("Advanced holds Chart detail, above the locked set-once fields", () => {
    expect(reg.sectionsFor("advanced").map((s) => s.id)).toEqual(["chart-detail", "advanced"]);
  });

  test("Datasets holds the regions it bakes for", () => {
    expect(reg.sectionsFor("datasets").map((s) => s.id)).toEqual(["datasets", "regions"]);
  });

  test("Developer holds the diagnostics toggles, then the theme editor", () => {
    expect(reg.sectionsFor("diagnostics").map((s) => s.id)).toEqual(["diagnostics", "theme-editor"]);
  });

  test("every section lands in exactly one pane, and every pane can be drawn", () => {
    const placed = reg.orderedCategories.flatMap((c) => reg.sectionsFor(c.id).map((s) => s.id));
    expect(placed.slice().sort()).toEqual(reg.sections.map((s) => s.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
    for (const c of reg.orderedCategories) expect(c.icon).toBeDefined();
  });

  // The consolidation: two sections that spent their prose pointing at each other.
  test("Charts is the library, the o-charts login, its screens and its licences, in that order", () => {
    expect(reg.sectionsFor("charts").map((s) => s.id)).toEqual([
      "charts",
      "ocharts",
      "ocharts-screens",
      "chart-licences",
    ]);
  });

  // The genericity bar, one step further than a joined category: POI's and
  // satellite's own "POI data"/"Satellite imagery" list+delete sections
  // (PoiData.tsx/SatelliteData.tsx) are GONE now, not just folded under this
  // category — their list/delete capability moved INTO the generic list
  // itself (DatasetList.tsx's `declared: false` rows), so there is nothing
  // left for either feature to contribute here. A third provider could still
  // join this category with its own section; neither of these two needs to
  // anymore.
  test("Datasets is the generic list (plus Regions) — POI/satellite folded in rather than joining", () => {
    expect(reg.sectionsFor("datasets").map((s) => s.id)).toEqual(["datasets", "regions"]);
    // Dropping the features changes nothing here now (unlike Charts, whose
    // o-charts login section IS feature-contributed) — confirms this pane
    // was never depending on a feature section to begin with.
    const core = createSettingsRegistry<SettingsCtx>(
      [...DEVICE_SETTINGS, ...BOAT_SETTINGS],
      [...DEVICE_SECTIONS, ...BOAT_SECTIONS],
      [...DEVICE_CATEGORIES, ...BOAT_CATEGORIES],
    );
    expect(core.sectionsFor("datasets").map((s) => s.id)).toEqual(["datasets", "regions"]);
  });

  // "Data on this chart": Chart sets (core) beside the satellite source picker
  // and the ship-track window — each a FEATURE's own section joining a core
  // category by name, all answering "what data does this screen draw", with
  // the core naming none of them.
  test("the satellite source picker joins Chart sets rather than sitting in Display", () => {
    expect(reg.sectionsFor("chart-data").map((s) => s.id)).toEqual([
      "sets",
      "satellite-source",
      "track",
    ]);
    expect(reg.byId("satelliteSource")?.group).toBe("satellite-source");
    expect(reg.settingsFor("display").map((s) => s.id)).not.toContain("satelliteSource");
  });

  // Appearance ("how this screen draws") absorbs the four sections that used to
  // be four separate rail rows — task xpstmort.
  test("Appearance is Depth, Display, Text & Lights and Display density, one pane", () => {
    expect(reg.sectionsFor("appearance").map((s) => s.id)).toEqual([
      "depth",
      "display",
      "text",
      "chrome",
    ]);
  });
});

describe("categories tolerate a contribution they have never heard of", () => {
  const orphan: SettingsSection<SettingsCtx> = defineSettingsSection<SettingsCtx>({
    id: "plugin-section",
    title: "A plugin",
    group: "server",
    order: 500,
    category: "a-pane-this-build-does-not-have",
    render: () => null,
  });

  test("an unknown category degrades to a pane of its own, never a boot throw", () => {
    const r = createSettingsRegistry<SettingsCtx>([], [orphan], []);
    expect(r.categoriesIn("server").map((c) => c.id)).toEqual(["plugin-section"]);
    expect(r.sectionsFor("plugin-section").map((s) => s.id)).toEqual(["plugin-section"]);
  });

  test("a section naming no category at all is its own pane, inheriting its title", () => {
    const solo = defineSettingsSection<SettingsCtx>({
      id: "solo",
      title: "Solo",
      icon: (() => null) as never,
      group: "device",
      order: 5,
    });
    const r = createSettingsRegistry<SettingsCtx>([], [solo], []);
    expect(r.categoryById("solo")?.title).toBe("Solo");
    expect(r.categoryById("solo")?.group).toBe("device");
  });

  test("but a category that disagrees about its GROUP is a wiring bug and throws", () => {
    const cat = defineSettingsCategory({
      id: "server-pane",
      title: "Server pane",
      icon: (() => null) as never,
      group: "server",
      order: 1,
    });
    const wrong = defineSettingsSection<SettingsCtx>({
      id: "wrong",
      title: "Wrong tab",
      group: "device",
      order: 1,
      category: "server-pane",
      render: () => null,
    });
    expect(() => createSettingsRegistry<SettingsCtx>([], [wrong], [cat])).toThrow(
      /targets category/,
    );
  });

  test("a duplicate category id is caught at assembly", () => {
    const one = defineSettingsCategory({
      id: "dupe",
      title: "One",
      icon: (() => null) as never,
      group: "device",
      order: 1,
    });
    expect(() => createSettingsRegistry<SettingsCtx>([], [], [one, one])).toThrow(
      /duplicate category id/,
    );
  });
});

describe("the ship-track window", () => {
  test("is choosable while the track is off — a disabled select looked broken", () => {
    const setting = reg.byId("trackHours")!;
    const ctx = { settings: { ...DEFAULT_SETTINGS, showTrack: false } } as unknown as SettingsCtx;
    expect(isSettingEnabled(reg, setting, ctx)).toBe(true);
  });
});
