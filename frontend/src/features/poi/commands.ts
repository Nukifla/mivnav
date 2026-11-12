// The POI feature's command contribution — keyboard/palette way in to the
// `showPois` overlay toggle. Mirrors chrome/commands.ts's core toggles: writes
// through the SAME `deps.setSettings` the device toggle calls, never a second copy.

import { defineCommand, type Command } from "../../core/chrome/command";
import type { CommandDeps } from "../../core/chrome/commands";

/** The POI overlay toggle, labelled Show/Hide from the live `showPois`. */
export function poiCommands(deps: CommandDeps): Command[] {
  return [
    defineCommand({
      id: "toggle-pois",
      label: `${deps.settings().showPois ? "Hide" : "Show"} OSM points of interest`,
      group: "Overlays",
      hint: "Marinas, fuel and harbour offices from the boat's local OSM data",
      keywords: ["poi", "osm", "marina", "fuel", "harbour", "harbor", "overlay", "points"],
      run: (ctx) => {
        deps.setSettings({ showPois: !deps.settings().showPois });
        ctx.close();
      },
    }),
  ];
}
