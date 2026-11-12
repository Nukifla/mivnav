// Global keyboard accelerators — desktop-feel layer, the guard shared by the
// direct helm accelerators (M, Esc) and Ctrl/Cmd-K (App.tsx). Pure/DOM-
// agnostic so it's testable with no DOM (see modes.test.ts).

/** The DOM bits `isTypingTarget` reads — structural, not `HTMLElement`, so
 * this runs the same under `bun test`'s no-DOM harness as in a browser. */
interface MaybeTypingElement {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * True when `target` is somewhere keystrokes are TEXT, not shortcuts —
 * typing "m" into a text field must not also toggle Measure. Duck-typed
 * (no `instanceof`/`document`) so this stays DOM-free like the rest of `chrome/`.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as MaybeTypingElement;
  if (el.isContentEditable) return true;
  switch (el.tagName) {
    case "INPUT":
    case "TEXTAREA":
    case "SELECT":
      return true;
    default:
      return false;
  }
}
