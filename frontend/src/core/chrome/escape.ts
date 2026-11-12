// The Escape key: one press closes the topmost open window. The DECISION
// only — pure and DOM-free like ./accelerators.ts — of whether a given
// keydown is an Escape nobody else has claimed. What it then closes is the
// back-stack's top layer (./backStack.ts `dismissTopBackLayer`), the same
// dismissers the hardware Back button peels, so a surface needs no Escape
// listener of its own. Wired once, in App.tsx's keydown listener.
//
// "Claimed" is how double-closing is avoided. Every surface with its own
// Escape handling marks the event before it reaches the window's bubble
// phase: Kobalte's dialogs/popovers/menus `preventDefault()` it from a
// document listener, the palette / search / lightbox stop it in the capture
// phase, an inline edit `preventDefault()`s its cancel. So an unprevented
// Escape arriving here means nothing above the stack's top layer wanted it.

/** The KeyboardEvent fields read — structural, so tests need no DOM. */
export interface EscapeKeyEvent {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

interface MaybeField {
  tagName?: string;
  type?: string;
  value?: unknown;
}

/** Escape already means something to the focused control itself, and the
 * browser does it as a DEFAULT action (so nothing is `defaultPrevented`): a
 * native `<select>` closes its dropdown, a non-empty `type="search"` field
 * clears. That comes first; the next press closes the window. */
function fieldOwnsEscape(target: EventTarget | null | undefined): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as MaybeField;
  if (el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && el.type === "search" && el.value !== "" && el.value != null;
}

/**
 * True when `e` is a plain Escape press that no one has claimed and that the
 * focused control does not need for itself — i.e. one that may close a window.
 *
 * Not while an IME is composing (Escape cancels the composition; `keyCode`
 * 229 is the legacy spelling of the same state), not on auto-repeat (one
 * press = one layer, a held key must not strip the whole stack), and not with
 * a modifier (Shift/Ctrl/Alt-Escape belong to the browser and the OS).
 */
export function isFreeEscape(e: EscapeKeyEvent): boolean {
  if (e.key !== "Escape") return false;
  if (e.defaultPrevented) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.repeat) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  return !fieldOwnsEscape(e.target);
}

/**
 * Close the topmost window on a free Escape. `dismissTop` reports whether it
 * closed anything; if so the event is claimed (`preventDefault`) so nothing
 * further out acts on the same press. Returns whether a window was closed.
 */
export function dismissOnEscape(e: EscapeKeyEvent, dismissTop: () => boolean): boolean {
  if (!isFreeEscape(e)) return false;
  if (!dismissTop()) return false;
  e.preventDefault();
  return true;
}
