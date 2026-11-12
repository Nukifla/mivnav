// Keyboard chart navigation: the arrow keys pan the chart and +/- zoom it,
// app-wide — no click on the map first. ("the arrow keys should move us
// around the map".) See docs/architecture/map-key-nav.md.
//
// MapLibre's own keyboard handler is switched off (MapView `wireMap`) and
// this replaces it, for two measured reasons:
//   - it listens on the map's canvas container only, and the app boots with
//     focus on <body>, so the arrows did nothing until the chart was clicked;
//   - its pan is an `easeTo` stamped with `originalEvent`, which follow-boat
//     then read as a gesture ZOOM (boat stays at its old offset), so with
//     follow on the chart glided straight back to the boat after every
//     press. (Follow-boat no longer makes that distinction — every move that
//     is not its own re-bases the offset, core/followGate.ts — but the first
//     reason stands, and one pan per frame is smoother than one ease per
//     keydown.)
//
// Three parts, all DOM-free so they test under `bun test`:
//   1. `chartKeyOf` / `ownsChartKeys` / `freeChartKey` — the ROUTING decision:
//      is this keydown a chart key nobody else has a use for? Same "free key"
//      reading as ../chrome/escape.ts (`isFreeEscape`): not claimed
//      (`defaultPrevented`), not composing, no foreign modifier, and the
//      focused control does not need it for itself.
//   2. `createKeyPan` — held keys → a per-frame pixel delta (smooth while
//      held, diagonal with two keys, a minimum step for a quick tap).
//   3. `createChartKeyNav` — the controller App.tsx's ONE keydown listener
//      calls after the command registry and Escape; MapView binds the map.

import { isTypingTarget } from "../chrome/accelerators";

/** The KeyboardEvent fields read — structural, so tests need no DOM. */
export interface ChartKeyEvent {
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

export type PanKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** Which way the VIEW moves, in screen pixels (down is +y): ArrowRight looks
 * further east, so the chart slides left under it — MapLibre's convention. */
export const PAN_DIRECTION: Readonly<Record<PanKey, readonly [number, number]>> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

export type ChartKey = { kind: "pan"; key: PanKey } | { kind: "zoom"; delta: 1 | -1 };

const isPanKey = (key: string): key is PanKey => Object.hasOwn(PAN_DIRECTION, key);

/**
 * The chart action a key SPELLS, from the key and its modifiers alone.
 *
 * Arrows pan; `+` / `=` zoom in and `-` zooms out (MapLibre's own keys).
 * Ctrl/Cmd/Alt chords belong to the browser and OS (Alt-Left is Back,
 * Cmd-Plus is page zoom). Shift-arrow is deliberately nothing: in MapLibre it
 * rotates and pitches, and the chart is permanently north-up and flat. Shift
 * is allowed on the zoom keys because `+` IS Shift-`=` on most layouts.
 */
export function chartKeyOf(e: ChartKeyEvent): ChartKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isPanKey(e.key)) return e.shiftKey ? null : { kind: "pan", key: e.key };
  if (e.key === "+" || e.key === "=") return { kind: "zoom", delta: 1 };
  if (e.key === "-") return { kind: "zoom", delta: -1 };
  return null;
}

/** The DOM bits the ownership walk reads — structural, not `HTMLElement`. */
export interface KeyTargetElement {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
  parentElement?: KeyTargetElement | null;
}

/** ARIA widgets whose own keyboard model uses the arrow keys. A handler that
 * forgets `preventDefault` (the weather ruler's slider does) must still keep
 * its arrows, so the role alone is enough. */
const ARROW_ROLES: ReadonlySet<string> = new Set([
  "slider",
  "spinbutton",
  "scrollbar",
  "listbox",
  "option",
  "combobox",
  "textbox",
  "searchbox",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "tablist",
  "radio",
  "radiogroup",
  "tree",
  "treeitem",
  "grid",
  "gridcell",
  "toolbar",
]);

/**
 * Does the focused element — or anything it sits in — have its own use for
 * the arrow / +/- keys? Walks from the event target to the document root:
 *  - a text field, `<select>` or contenteditable (`isTypingTarget`; also
 *    covers native range / radio / number inputs, which are all `<input>`);
 *  - an ARIA widget that navigates with arrows (slider, listbox, menu, tabs,
 *    radio group…), or a trigger that opens one on ArrowDown
 *    (`aria-haspopup`: Kobalte's select and menu buttons);
 *  - a scrollable container (`scrolls`, DOM-only, injected): with focus
 *    inside a scrolling panel the arrows scroll it, and that is the browser's
 *    DEFAULT action, so nothing is `defaultPrevented` to warn us.
 * A plain button, a link, the map canvas and `<body>` own nothing.
 */
export function ownsChartKeys(
  target: EventTarget | null | undefined,
  scrolls?: (el: KeyTargetElement) => boolean,
): boolean {
  if (target === null || typeof target !== "object") return false;
  for (let el: KeyTargetElement | null | undefined = target as KeyTargetElement; el; el = el.parentElement) {
    if (el.tagName === "BODY" || el.tagName === "HTML") return false;
    if (isTypingTarget(el as EventTarget)) return true;
    const role = el.getAttribute?.("role");
    if (role && ARROW_ROLES.has(role)) return true;
    const popup = el.getAttribute?.("aria-haspopup");
    if (popup && popup !== "false") return true;
    if (scrolls?.(el)) return true;
  }
  return false;
}

/** What the routing decision needs beyond the event itself. */
export interface ChartKeyContext {
  /** A modal surface is open (dialog, menu, palette, search, lightbox): the
   * chart is not what the keyboard is talking to, wherever focus sits. */
  modalOpen: boolean;
  /** See `ownsChartKeys`. Omitted in tests / without a DOM. */
  scrolls?: (el: KeyTargetElement) => boolean;
}

/**
 * The chart action for `e`, or null when the key is not free: already claimed
 * (`defaultPrevented` — Kobalte's sliders/menus/tabs, the palette and search
 * lists, the lightbox), an IME composing (`keyCode` 229 is the legacy
 * spelling), a modal open, or the focused control owning the key.
 */
export function freeChartKey(e: ChartKeyEvent, ctx: ChartKeyContext): ChartKey | null {
  if (e.defaultPrevented) return null;
  if (e.isComposing || e.keyCode === 229) return null;
  const action = chartKeyOf(e);
  if (action === null) return null;
  if (ctx.modalOpen) return null;
  if (ownsChartKeys(e.target, ctx.scrolls)) return null;
  return action;
}

/** `scrolls` for a real DOM: can the arrow keys scroll this element? */
export function domScrolls(el: KeyTargetElement): boolean {
  if (typeof getComputedStyle !== "function") return false;
  const box = el as unknown as Element;
  const cs = getComputedStyle(box);
  const can = (overflow: string, scroll: number, client: number) =>
    (overflow === "auto" || overflow === "scroll") && scroll > client;
  return (
    can(cs.overflowY, box.scrollHeight, box.clientHeight) ||
    can(cs.overflowX, box.scrollWidth, box.clientWidth)
  );
}

// --- the pan itself --------------------------------------------------------

/** Pan speed while an arrow is held, px/s — a 1280 px chart crosses in ~2 s:
 * fast enough to travel, slow enough to stop on a mark. */
export const KEY_PAN_SPEED = 600;
/** The least one press moves, px (MapLibre's own step): a quick tap is
 * shorter than the time this takes, so the pan runs on after the key lifts. */
export const KEY_PAN_STEP = 100;
/** Longest frame gap integrated, ms — a stalled frame (tile decode, a
 * backgrounded tab) must not turn into one giant jump. Generous, so a device
 * rendering at 10 fps still pans at full speed. */
export const KEY_PAN_MAX_FRAME_MS = 100;

/** The frame clock, injectable so the pan is testable without a browser. */
export interface FrameEnv {
  now: () => number;
  requestFrame: (fn: () => void) => number;
  cancelFrame: (id: number) => void;
}

const browserFrames = (): FrameEnv => ({
  now: () => performance.now(),
  requestFrame: (fn) => requestAnimationFrame(fn),
  cancelFrame: (id) => cancelAnimationFrame(id),
});

/**
 * Held arrow keys → a stream of per-frame pixel deltas. Velocity-based (not
 * one ease per keydown), so it is smooth and continuous for as long as a key
 * is held, independent of the OS auto-repeat rate, and two held keys simply
 * add into a diagonal; opposite keys cancel. A press always moves at least
 * `KEY_PAN_STEP`, so a tap is a usable step.
 */
export function createKeyPan(move: (dx: number, dy: number) => void, env: FrameEnv = browserFrames()) {
  const held = new Set<PanKey>();
  /** Per key: what is left of its guaranteed minimum step, px. */
  const owed = new Map<PanKey, number>();
  let frame: number | undefined;
  let last = 0;

  const tick = () => {
    frame = undefined;
    const t = env.now();
    const dist = (KEY_PAN_SPEED * Math.min(t - last, KEY_PAN_MAX_FRAME_MS)) / 1000;
    last = t;
    let dx = 0;
    let dy = 0;
    for (const key of [...owed.keys()]) {
      const left = owed.get(key) ?? 0;
      // Released: only finish the step. Held: run on at full speed.
      const d = held.has(key) ? dist : Math.min(dist, left);
      const [x, y] = PAN_DIRECTION[key];
      dx += x * d;
      dy += y * d;
      if (left > d) owed.set(key, left - d);
      else if (held.has(key)) owed.set(key, 0);
      else owed.delete(key);
    }
    if (dx !== 0 || dy !== 0) move(dx, dy);
    if (owed.size > 0) frame = env.requestFrame(tick);
  };

  return {
    /** keydown. Idempotent while held, so auto-repeat keydowns are harmless;
     * a fresh press ADDS its step to whatever an earlier tap still has to
     * run, so three quick taps are three steps. */
    press(key: PanKey) {
      if (held.has(key)) return;
      held.add(key);
      owed.set(key, (owed.get(key) ?? 0) + KEY_PAN_STEP);
      if (frame === undefined) {
        last = env.now();
        frame = env.requestFrame(tick);
      }
    },
    /** keyup: the key stops driving; an unfinished minimum step completes. */
    release(key: PanKey) {
      held.delete(key);
    },
    /** Stop dead (window blur, a modifier chord, unbind): a `keyup` we will
     * never see must not leave the chart sailing away. */
    stop() {
      held.clear();
      owed.clear();
      if (frame !== undefined) env.cancelFrame(frame);
      frame = undefined;
    },
    active: () => owed.size > 0,
  };
}

/** What the controller drives — MapView binds the real map. */
export interface ChartKeyDriver {
  /** Move the view by this many screen pixels, immediately. */
  panBy(dx: number, dy: number): void;
  /** One zoom step in (+1) or out (-1); `e` is the key event that asked. */
  zoomBy(delta: 1 | -1, e: ChartKeyEvent): void;
}

/**
 * The controller: App.tsx owns one and feeds it the window's key events;
 * MapView `bind`s the map when it exists. Until a map is bound every key is
 * left alone (not handled, not `preventDefault`ed).
 */
export function createChartKeyNav(env?: FrameEnv) {
  let driver: ChartKeyDriver | undefined;
  const pan = createKeyPan((dx, dy) => driver?.panBy(dx, dy), env);
  return {
    bind(d: ChartKeyDriver): () => void {
      driver = d;
      return () => {
        if (driver !== d) return;
        pan.stop();
        driver = undefined;
      };
    },
    /** A keydown no command and no Escape took. Returns whether it was a
     * chart key (and is now claimed with `preventDefault`, which also stops
     * the browser scrolling the page with the same arrow). */
    keydown(e: ChartKeyEvent, ctx: ChartKeyContext): boolean {
      // A chord starting mid-hold (Cmd-Tab, Alt-…): macOS never delivers the
      // `keyup` of a key released under Cmd, so stop rather than run on.
      if (e.ctrlKey || e.metaKey || e.altKey) pan.stop();
      if (!driver) return false;
      const action = freeChartKey(e, ctx);
      if (action === null) return false;
      e.preventDefault();
      if (action.kind === "pan") pan.press(action.key);
      else driver.zoomBy(action.delta, e);
      return true;
    },
    /** Every keyup, unconditionally: a key pressed on the chart and released
     * in a text field must still let go. */
    keyup(e: { key: string }) {
      if (isPanKey(e.key)) pan.release(e.key);
    },
    /** The window lost focus. */
    release() {
      pan.stop();
    },
    panning: () => pan.active(),
  };
}

export type ChartKeyNav = ReturnType<typeof createChartKeyNav>;
