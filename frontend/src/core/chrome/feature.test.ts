/**
 * C4 acceptance — the convergence, proved.
 *
 * A feature is now ONE declaration (`defineFeature` from chrome/feature.ts) that
 * folds the kernel part (instruments / modes / dashboard) AND the app-layer
 * surfaces (overlay / provider / commands / widgets / settings). This test builds
 * a SYNTHETIC feature that contributes to every one of those, adds it to a
 * features list, and asserts it shows up in ALL five derived registries — plus
 * the info-provider projection — with ZERO edits anywhere else: the same
 * `feature*` collectors + `create*` fan-outs App.tsx uses.
 */

import { describe, expect, test } from "bun:test";
import Eye from "lucide-solid/icons/eye";
import {
  coreFeatures,
  defineFeature,
  featureCommands,
  featureOverlayControls,
  featureOverlays,
  featureProviders,
  featureSettings,
  featureSettingsSections,
  featureWidgets,
  type OverlayControlDeps,
} from "./feature";
import { createRegistry, type Instrument } from "./registry";
import { createCommandRegistry, type CommandDeps } from "./commands";
import { defineCommand } from "./command";
import { createWidgetRegistry, defineWidget } from "./widget";
import { createSettingsRegistry, defineSetting, defineSettingsSection } from "../settings/registry";
import type { DeviceCtx } from "../settings/device";
import { DEFAULT_SETTINGS } from "../style/settings";
import type { Overlay } from "../layers/overlay";
import type { InfoHit, InfoProvider, InfoQuery } from "../info/types";

// A minimal instrument the synthetic widget's `build` hands back.
const stubReading: Instrument = {
  id: "synthetic.reading",
  short: "SYN",
  label: "Synthetic",
  maxUrgency: "none",
  read: () => ({ value: "42" }),
};

const overlay: Overlay = {
  id: "synthetic-overlay",
  layerIds: ["synthetic-layer"],
  z: 25,
  ensure: () => {},
  update: () => {},
};

const provider: InfoProvider = {
  id: "synthetic-provider",
  label: "Synthetic",
  queryAt: (_q: InfoQuery): InfoHit[] => [],
  detail: () => ({ sections: [] }),
};

const widget = defineWidget({
  id: "synthetic-widget",
  kind: "static",
  label: "Synthetic widget",
  maxUrgency: "none",
  spec: [],
  build: () => stubReading,
});

const setting = defineSetting<DeviceCtx>({
  id: "synthetic-setting",
  scope: "device",
  control: { kind: "toggle" },
  label: "Synthetic setting",
  group: "synthetic-section",
  order: 10,
  default: false,
  coerce: (raw) => (typeof raw === "boolean" ? raw : false),
  read: (c) => c.debugLayers,
  write: (c, v) => c.onDebugLayers(v as boolean),
});

const section = defineSettingsSection<DeviceCtx>({
  id: "synthetic-section",
  title: "Synthetic section",
  icon: Eye,
  group: "device",
  order: 100,
});

/** The one synthetic feature — every surface a feature can contribute, in one
 * `defineFeature` call, the way an author would write it. */
const synthetic = defineFeature({
  id: "synthetic",
  instruments: [
    { id: "syn.inst", short: "SI", label: "Synthetic instrument", maxUrgency: "none", read: () => ({ value: "1" }) },
  ],
  modes: [{ id: "syn-mode", label: "Synthetic mode" }],
  dashboard: [{ id: "syn-page", label: "Synthetic", instruments: ["syn.inst"] }],
  overlay,
  provider,
  commands: (deps: CommandDeps) => [
    defineCommand({
      id: "syn-command",
      label: "Synthetic command",
      group: "Synthetic",
      run: (ctx) => ctx.close(),
    }),
  ],
  widgets: [widget],
  settings: { settings: [setting], sections: [section] },
  overlayControls: (deps) => [
    {
      id: "synthetic-overlay",
      label: "Synthetic overlay",
      visible: () => deps.settings().showPois,
      setVisible: (v) => deps.setSettings({ showPois: v }),
      opacity: () => deps.settings().satelliteOpacity,
      setOpacity: (v) => deps.setSettings({ satelliteOpacity: v }),
    },
  ],
});

// A pre-existing feature, so the assertions also prove the synthetic one is ADDED
// alongside rather than replacing — "zero other edits" means the rest survive.
const baseline = defineFeature({
  id: "baseline",
  instruments: [
    { id: "base.inst", short: "B", label: "Baseline", maxUrgency: "none", read: () => ({ value: "0" }) },
  ],
});

const deps = { activeMode: () => null, toggleMode: () => {} } as unknown as CommandDeps;

describe("C4 convergence — one feature declaration, every registry", () => {
  const features = [baseline, synthetic];

  test("the kernel registry gets its instruments, mode and dashboard page", () => {
    const reg = createRegistry(coreFeatures(features));
    expect(reg.byId("syn.inst")).toBeDefined();
    expect(reg.byId("base.inst")).toBeDefined(); // baseline survives
    expect(reg.modes.get("syn-mode")).toBeDefined();
    expect(reg.pages.some((p) => p.id === "syn-page")).toBe(true);
  });

  test("the overlay projection carries the feature's overlay", () => {
    expect(featureOverlays(features).map((o) => o.id)).toContain("synthetic-overlay");
  });

  test("the info-provider projection carries the feature's provider", () => {
    expect(featureProviders(features).map((p) => p.id)).toContain("synthetic-provider");
  });

  test("the overlay-control projection carries the feature's descriptor", () => {
    const deps = {
      settings: () => DEFAULT_SETTINGS,
      setSettings: () => {},
      activeMode: () => null,
    } as OverlayControlDeps;
    expect(featureOverlayControls(features, deps).map((o) => o.id)).toContain("synthetic-overlay");
  });

  test("the command registry gets the feature's command", () => {
    const cmds = createCommandRegistry(featureCommands(features, deps));
    expect(cmds.byId("syn-command")).toBeDefined();
  });

  test("the widget registry gets the feature's widget KIND", () => {
    const reg = createWidgetRegistry(featureWidgets(features));
    expect(reg.byKind("synthetic-widget")).toBeDefined();
  });

  test("the settings registry gets the feature's setting AND its section", () => {
    const reg = createSettingsRegistry(featureSettings(features), featureSettingsSections(features));
    expect(reg.byId("synthetic-setting")).toBeDefined();
    expect(reg.sectionById("synthetic-section")).toBeDefined();
    expect(reg.settingsFor("synthetic-section").map((s) => s.id)).toEqual(["synthetic-setting"]);
  });

  test("kernel validation still runs on the pure sub-object", () => {
    // A reserved-chrome id must still throw through the app-layer defineFeature —
    // the maplibre surfaces ride alongside, they do not bypass the kernel.
    expect(() => defineFeature({ id: "alarm-band" })).toThrow(/reserved chrome/);
  });
});
