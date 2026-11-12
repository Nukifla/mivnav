// The measure feature's `M` launcher — moved from `chrome/commands.ts` since a
// mode's launcher belongs to the feature that owns the mode; the composition
// root fans it in via `featureCommands`, closing over the shared `CommandDeps`.

import { defineCommand, type Command } from "../../core/chrome/command";
import type { CommandDeps } from "../../core/chrome/commands";

export function measureCommands(deps: CommandDeps): Command[] {
  return [
    defineCommand({
      id: "mode-measure",
      label: deps.activeMode() === "measure" ? "Stop measuring" : "Measure distance",
      group: "Chart modes",
      hint: "Tap two points for range and bearing",
      keybinding: { key: "m" },
      keywords: ["range", "bearing", "ruler", "distance"],
      run: (ctx) => {
        deps.toggleMode("measure");
        ctx.close();
      },
    }),
  ];
}
