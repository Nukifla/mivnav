// The manual route editor's commands: the launcher (palette, visible whether
// or not "Beta autorouting" is on) and the in-editor keys — Ctrl/⌘-Z undo,
// Ctrl/⌘-Shift-Z or Ctrl/⌘-Y redo, Enter = Done, Delete/Backspace deletes
// the selected point. Escape is the shell's `exit-mode`, which asks the mode
// (`requestLeave`) — Cancel, with a discard confirm when dirty.

import { defineCommand, type Command } from "../../core/chrome/command";
import type { CommandDeps } from "../../core/chrome/commands";
import { isTypingTarget } from "../../core/chrome/accelerators";
import { ROUTE_DRAW_MODE_ID } from "./ids";
import type { RouteDrawModel } from "./index";

const focused = (): (Element & { isContentEditable?: boolean }) | null => {
  if (typeof document === "undefined") return null;
  const el = document.activeElement;
  return el && el !== document.body ? el : null;
};

/** Focus is in a text field, which owns undo/Delete/Backspace/Enter itself.
 * A modifier chord fires even from a field (`dispatchKey`), so the undo keys
 * need this as much as the bare ones. */
const typing = (): boolean => isTypingTarget(focused());

/** Enter would PRESS a keyboard-focused button or link. `:focus-visible`, not
 * any focus: a button merely clicked with the mouse (Chrome keeps focus on
 * it — the pill's Undo, say) must not swallow Enter-for-Done. */
function enterOwnedByFocus(): boolean {
  const el = focused();
  if (!el) return false;
  if (isTypingTarget(el)) return true;
  const control = el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute?.("role") === "button";
  if (!control) return false;
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function routeDrawCommands(deps: CommandDeps, model: RouteDrawModel): Command[] {
  const editing = () => deps.activeMode() === ROUTE_DRAW_MODE_ID && model.active();
  const keysFree = () => editing() && !typing();
  return [
    defineCommand({
      id: "mode-route-draw",
      label: deps.activeMode() === ROUTE_DRAW_MODE_ID ? "Close route drawing" : "Draw a new route",
      group: "Chart modes",
      hint: "Place straight legs by hand — tap to add points",
      keywords: ["new route", "route", "waypoint", "plot", "plan", "manual", "draw", "leg"],
      run: (ctx) => {
        if (deps.activeMode() === ROUTE_DRAW_MODE_ID) deps.leaveMode();
        else model.newRoute();
        ctx.close();
      },
    }),
    defineCommand({
      id: "route-draw-undo",
      label: "Undo route edit",
      group: "Chart modes",
      keybinding: { key: "z", mod: true, shift: false },
      palette: false,
      enabled: () => keysFree() && model.canUndo(),
      run: () => model.undo(),
    }),
    defineCommand({
      id: "route-draw-redo",
      label: "Redo route edit",
      group: "Chart modes",
      keybinding: [
        { key: "z", mod: true, shift: true },
        { key: "y", mod: true },
      ],
      palette: false,
      enabled: () => keysFree() && model.canRedo(),
      run: () => model.redo(),
    }),
    defineCommand({
      id: "route-draw-done",
      label: "Save the route (Done)",
      group: "Chart modes",
      keybinding: { key: "Enter" },
      palette: false,
      enabled: () => editing() && !enterOwnedByFocus(),
      run: () => void model.done(),
    }),
    defineCommand({
      id: "route-draw-delete",
      label: "Delete the selected point",
      group: "Chart modes",
      keybinding: [{ key: "Delete" }, { key: "Backspace" }],
      palette: false,
      enabled: () => keysFree() && model.selection()?.kind === "point",
      run: () => model.deleteSelected(),
    }),
  ];
}
