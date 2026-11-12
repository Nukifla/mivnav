// The route-test feature's command contribution — same shape as
// measure/commands.ts's `M` launcher.

import type { Accessor } from "solid-js";
import { defineCommand, type Command } from "../../core/chrome/command";
import type { CommandDeps } from "../../core/chrome/commands";

/** The route-test launcher — `T` toggles the mode. Contributes nothing (no
 * palette entry, no keybinding) unless the developer setting is on; the
 * command registry is a memo, so reading `enabled` here re-derives it. */
export function routeTestCommands(enabled: Accessor<boolean>): (deps: CommandDeps) => Command[] {
  return (deps) => (enabled() ? launcher(deps) : []);
}

function launcher(deps: CommandDeps): Command[] {
  return [
    defineCommand({
      id: "mode-route-test",
      label: deps.activeMode() === "routeTest" ? "Stop route test" : "Test a route",
      group: "Chart modes",
      hint: "Tap two points to check a line against real chart hazards",
      keybinding: { key: "t" },
      keywords: ["route", "plan", "hazard", "test", "routing"],
      run: (ctx) => {
        deps.toggleMode("routeTest");
        ctx.close();
      },
    }),
  ];
}
