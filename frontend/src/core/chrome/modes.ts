// Chart modes — the click seam (invariant #9). A click means "what is here?"
// until a mode says otherwise. DOM-free and map-free (`chrome/` may never
// import `maplibre-gl` for a value). See docs/architecture/chart-modes.md.

import { createMemo, createSignal, type Accessor } from "solid-js";
import type { Density, Mode, Registry } from "./registry";

/** Where a click landed, in both spaces — a mode may need either, and neither
 * is derivable from the other without the map. Structurally `info/`'s
 * `InfoQuery`, on purpose: it is the same event, asked a different question. */
export interface ModeClick {
  /** Screen pixels, relative to the map container. */
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
  /** Tap tolerance in screen pixels — already grown for density. See `tapRadius`. */
  radius: number;
  /** Screen-space hit-test against the mode's OWN overlay layers (see
   * docs/architecture/chart-modes.md) — returns feature ids under the tap
   * box, nearest first. A layer id this build lacks is skipped, never thrown. */
  pick: (layerIds: readonly string[]) => readonly string[];
}

/** One button in the pill. Data plus a closure, never JSX: the shell is the
 * sole renderer, which is the rule that keeps every decision here testable. */
export interface ModeAction {
  id: string;
  label: string;
  /** `toggle` draws pressed when `on`; `primary` is the commit. Default plain. */
  kind?: "plain" | "toggle" | "primary";
  on?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** A mode's whole UI, minus its name and its exit, which every mode has. */
export interface ModePillView {
  /** One mono line of what the CHART cannot say — e.g. Measure's leg time at
   * the boat's actual speed, which has nowhere else to be shown. */
  status?: string;
  actions?: readonly ModeAction[];
}

/** `Instrument.read`'s `ReadCtx`, for a mode (README #7: kernel says how
 * tight it is, widget decides what to drop) — at `helm` the grown buttons
 * leave ~58px for status, enough to ellipsize into a plausible-looking lie. */
export interface ModePillCtx {
  density: Density;
}

/** Tap tolerance in screen pixels, by POINTER not density (#DENS-SLIDER): a
 * gloved hand needs a bigger target regardless of tile scale. 14px is what's
 * left of the 44px recommendation once a tap must still distinguish two buoys. */
export const tapRadius = (pointerCoarse: boolean): number => (pointerCoarse ? 14 : 8);

export interface ModeState {
  /** The active mode's id, or null. Prop-drilled to `Rail` to light the launcher. */
  active: Accessor<string | null>;
  current: Accessor<Mode | null>;
  enter(id: string): void;
  /** Leave the active mode. Returns false when the mode VETOED (`requestLeave`)
   * — e.g. the route editor armed a discard confirm instead of dropping a
   * draft — so a caller mid-switch knows not to proceed. */
  leave(): boolean;
  /** Entering the mode that is already active leaves it — the launcher entry is
   * a toggle, because a menu item that only ever turns something on is a trap. */
  toggle(id: string): void;
  /** THE SEAM. Returns true if the active mode consumed the click, in which
   * case the caller must NOT probe. False (or no `onClick`) lets the click
   * through: a mode does not have to mean the chart stops answering questions. */
  handleClick(click: ModeClick): boolean;
}

/** The mode state machine, given a registry (the feature list's business, not
 * this file's). `enter` on an unknown id is a no-op, not a throw: the id can
 * come from stale config or a build lacking the feature. */
export function createModeState(reg: Registry): ModeState {
  const [active, setActive] = createSignal<string | null>(null);
  const current = createMemo(() => {
    const id = active();
    return (id && reg.modes.get(id)) || null;
  });

  const leave = (): boolean => {
    // The mode's veto is asked FIRST — before its state is touched — so it can
    // hold the exit open (a discard confirm) rather than lose an unsaved draft.
    if (current()?.requestLeave?.() === false) return false;
    // Read before clearing: `leave()` is the mode's chance to drop its state,
    // and it must still know which mode it is when it runs.
    current()?.leave?.();
    setActive(null);
    return true;
  };

  const enter = (id: string) => {
    const mode = reg.modes.get(id);
    if (!mode) return;
    if (active() === id) return;
    // Leave-then-enter, not a swap: a mode's `enter` may seed state its
    // predecessor's `leave` clears. A vetoed leave aborts the switch too.
    if (active() && !leave()) return;
    setActive(id);
    mode.enter?.();
  };

  return {
    active,
    current,
    enter,
    leave,
    toggle: (id) => (active() === id ? leave() : enter(id)),
    handleClick: (click) => current()?.onClick?.(click) === true,
  };
}
