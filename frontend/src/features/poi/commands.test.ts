import { describe, expect, test } from "bun:test";
import { poiCommands } from "./commands";
import type { CommandDeps } from "../../core/chrome/commands";
import { DEFAULT_SETTINGS, type ChartSettings } from "../../core/style/settings";

/** A deps stub over a mutable ChartSettings — poiCommands reads only
 * `settings`/`setSettings`; the rest are inert spies to satisfy the type. */
function harness(overrides: Partial<ChartSettings> = {}) {
  let settings: ChartSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const deps: CommandDeps = {
    onGoto: () => {},
    settings: () => settings,
    setSettings: (patch) => (settings = { ...settings, ...patch }),
    toggleWindUnit: () => {},
    openSettings: () => {},
    openRoutes: () => {},
    centreBoat: () => {},
    hasFix: () => false,
    openDashboard: () => {},
    openAutopilot: () => {},
    hasAutopilot: () => false,
    toggleMode: () => {},
    leaveMode: () => {},
    activeMode: () => null,
    togglePalette: () => {},
    debugLayers: () => false,
    setDebugLayers: () => {},
  };
  return { deps, settings: () => settings };
}

describe("poiCommands", () => {
  test("contributes toggle-pois with a group (a valid, registrable command)", () => {
    const cmds = poiCommands(harness().deps);
    const ids = cmds.map((c) => c.id);
    expect(ids).toEqual(["toggle-pois"]);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(cmds[0]!.group).toBeTruthy();
  });

  test("labels itself Show/Hide from the live showPois", () => {
    const off = poiCommands(harness({ showPois: false }).deps)[0]!;
    expect(off.label).toBe("Show OSM points of interest");
    const on = poiCommands(harness({ showPois: true }).deps)[0]!;
    expect(on.label).toBe("Hide OSM points of interest");
  });

  test("flips showPois through setSettings", () => {
    const h = harness({ showPois: false });
    poiCommands(h.deps)[0]!.run({ close: () => {}, prompt: () => {} });
    expect(h.settings().showPois).toBe(true);
  });
});
