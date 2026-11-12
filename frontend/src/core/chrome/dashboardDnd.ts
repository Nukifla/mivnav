// The dashboard editor's drag-and-drop — the touch-first successor to the
// picker + move-buttons. See docs/architecture/dashboard-drag.md for the
// pure-decisions/DOM-wiring split, the Pointer-Events choice, and how a
// resolved DropPlan maps onto config.ts's writers.

import { createSignal, onCleanup, type Accessor } from "solid-js";

/**
 * The final index an item at `from` lands at when dropped into insertion gap
 * `gap`. Dropping AFTER the item's own slot means one fewer item precedes it
 * once lifted out, so the gap is decremented; dropping before leaves it.
 */
export function dropTargetIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/**
 * The adjacent-neighbour swaps (by id) that move the item at `from` to `to`
 * within `ids` — each pair a valid `moveWidgetInTab(cfg, tab, a, b)` call.
 * Bubbling swaps because the writer is a SWAP, not an insert, and every step
 * swaps two VISIBLE ids, so the move stays honest past whatever is hidden.
 */
export function reorderSwaps(ids: readonly string[], from: number, to: number): [string, string][] {
  const swaps: [string, string][] = [];
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return swaps;
  const arr = [...ids];
  const step = from < to ? 1 : -1;
  for (let i = from; i !== to; i += step) {
    swaps.push([arr[i]!, arr[i + step]!]);
    [arr[i], arr[i + step]] = [arr[i + step]!, arr[i]!];
  }
  return swaps;
}

/**
 * What a released drag should DO, keyed on which drop target the pointer was
 * over at release; the component executes it against `config.ts`'s writers.
 * A `deletable` widget (permanent, no undo) ARMS the two-step confirm rather
 * than deleting on a gesture; everything else is reversible.
 */
export type DropPlan =
  | { kind: "none" }
  | { kind: "reorder"; tabId: string; swaps: [string, string][] }
  | { kind: "toTab"; id: string; toTabId: string }
  | { kind: "toTabAt"; id: string; toTabId: string; gap: number }
  | { kind: "removeFromTab"; tabId: string; id: string }
  | { kind: "confirmDelete"; id: string };

export interface DropInput {
  id: string;
  /** The TARGET the drag started on — a tab id, or `RAIL_TARGET`. */
  originTab: string;
  overRemove: boolean;
  /** The tab HEADER under the pointer, if any — drives append-to-another-tab. */
  overTab: string | null;
  /** The TARGET whose grid/slot is under the pointer — a tab id or
   * `RAIL_TARGET`, resolved from the slot's OWN `data-slot-tab`/`data-grid`,
   * not compared to a single "active" grid. Null when over no grid. */
  overGrid: string | null;
  /** Whether this widget's kind is a permanent delete (a user SignalK path). */
  deletable: boolean;
  /** The insertion gap within `overGrid`'s grid, or null (not over a grid). */
  gap: number | null;
  /** The drawn ids of `overGrid` (the reorder target), in order — the reorder is
   * by visible neighbour. */
  visibleIds: readonly string[];
}

export function planDrop(a: DropInput): DropPlan {
  if (a.overRemove) {
    return a.deletable
      ? { kind: "confirmDelete", id: a.id }
      : { kind: "removeFromTab", tabId: a.originTab, id: a.id };
  }
  // Dropped on ANOTHER tab's header → append to that tab.
  if (a.overTab && a.overTab !== a.originTab) return { kind: "toTab", id: a.id, toTabId: a.overTab };
  // Over no grid at all → nothing to do.
  if (a.overGrid == null) return { kind: "none" };
  // Over a DIFFERENT zone's grid (a tab reached by hover-hold, or the rail strip):
  // move it there and, if it landed on a gap, position it; else append.
  if (a.overGrid !== a.originTab) {
    return a.gap == null
      ? { kind: "toTab", id: a.id, toTabId: a.overGrid }
      : { kind: "toTabAt", id: a.id, toTabId: a.overGrid, gap: a.gap };
  }
  // Over its OWN zone's grid → reorder to the gap.
  if (a.gap == null) return { kind: "none" };
  const from = a.visibleIds.indexOf(a.id);
  if (from < 0) return { kind: "none" };
  const swaps = reorderSwaps(a.visibleIds, from, dropTargetIndex(from, a.gap));
  return swaps.length ? { kind: "reorder", tabId: a.originTab, swaps } : { kind: "none" };
}

export interface DashboardDragConfig {
  /** The tab whose grid is shown right now (the board's `tab()` signal). */
  activeTab: Accessor<string>;
  /** Switch the shown tab — the hover-hold-over-a-header affordance calls this. */
  setActiveTab: (id: string) => void;
  /** How long a header must be hovered before the view switches to it (ms). */
  hoverSwitchMs?: number;
  /** A released drag — the component resolves a {@link DropPlan} and executes it. */
  onEnd: (final: {
    id: string;
    originTab: string;
    overRemove: boolean;
    overTab: string | null;
    overGrid: string | null;
    gap: number | null;
  }) => void;
}

export interface DashboardDrag {
  /** The widget id being dragged, or null when idle. */
  draggingId: Accessor<string | null>;
  /** The live pointer position (for the floating ghost); null when idle. */
  pointer: Accessor<{ x: number; y: number } | null>;
  /** The insertion gap in the grid under the pointer, or null. */
  dropGap: Accessor<number | null>;
  /** The tab HEADER under the pointer, or null. */
  overTab: Accessor<string | null>;
  /**
   * The TARGET (tab id or `RAIL_TARGET`) of the grid/slot currently under the
   * pointer — resolved from the slot's/grid's own `data-slot-tab`/`data-grid`,
   * not compared to any shown tab. Lets the rail strip register as a target
   * even when it is not the board's active tab. Null when over no grid.
   */
  overGrid: Accessor<string | null>;
  /** Whether the pointer is over the remove zone. */
  overRemove: Accessor<boolean>;
  /**
   * Begin a drag from a `pointerdown`. The drag only LIFTS once the pointer
   * has moved past a few px (a tap never flashes the ghost). `opts.press`:
   * the press landed on a card body that must stay scrollable by touch
   * (`touch-action: pan-y`) — a TOUCH there lifts only after a still
   * long-press, and a swipe is left to the browser as a scroll. A mouse/pen,
   * or a touch on the dedicated grip handle (`press` unset), lifts on move.
   */
  start: (id: string, tabId: string, e: PointerEvent, opts?: DragStartOpts) => void;
}

export interface DragStartOpts {
  press?: boolean;
}

/** Movement (px) before a handle/mouse press lifts into a drag. */
export const LIFT_SLOP_PX = 5;
/** A long-press drifting further than this (px) is a scroll, not a lift. */
export const PRESS_SLOP_PX = 8;
/** How long a still touch on a card body must hold before it lifts (ms). */
export const LONG_PRESS_MS = 350;
/** The auto-scroll band at a scroll container's edge while dragging (px). */
export const AUTOSCROLL_EDGE_PX = 64;
/** Auto-scroll speed at the very edge (px per frame), easing to 0 inward. */
export const AUTOSCROLL_MAX_PX = 14;

/**
 * Edge auto-scroll step for a pointer at `p` along one axis of a container
 * spanning `[lo, hi]`: negative inside the low edge band, positive inside the
 * high one, 0 elsewhere (including OUTSIDE the container — a pointer over
 * chrome beyond it never scrolls it). Pure, so the feel is unit-tested.
 */
export function autoScrollStep(p: number, lo: number, hi: number, edge = AUTOSCROLL_EDGE_PX): number {
  if (p < lo || p > hi) return 0;
  const band = Math.min(edge, (hi - lo) / 3);
  if (p < lo + band) return -Math.ceil(((lo + band - p) / band) * AUTOSCROLL_MAX_PX);
  if (p > hi - band) return Math.ceil(((p - (hi - band)) / band) * AUTOSCROLL_MAX_PX);
  return 0;
}

// Number of drags currently LIFTED — read by `guardDragScroll`'s listener.
let liftedDrags = 0;

/**
 * Bind on a drag SOURCE: a non-passive `touchmove` that cancels the native
 * scroll while a drag is lifted. Must be on the element at touchstart time
 * (Chrome decides whether a touch sequence's moves are cancelable when it
 * starts), which is why the source binds it rather than the drag adding a
 * window listener mid-gesture. A card body is `pan-y` so it can scroll the
 * board; once a long-press lifts it, this is what stops the scroll.
 */
export function guardDragScroll(el: HTMLElement): () => void {
  const onMove = (e: TouchEvent): void => {
    if (liftedDrags > 0 && e.cancelable) e.preventDefault();
  };
  el.addEventListener("touchmove", onMove, { passive: false });
  return () => el.removeEventListener("touchmove", onMove);
}

const scrollableAncestor = (el: Element | null, axis: "x" | "y"): HTMLElement | null => {
  for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const ov = axis === "y" ? cs.overflowY : cs.overflowX;
    if (!/(auto|scroll)/.test(ov)) continue;
    if (axis === "y" ? n.scrollHeight > n.clientHeight + 1 : n.scrollWidth > n.clientWidth + 1) return n;
  }
  return null;
};

/**
 * The Pointer-Events machine behind the board's drag: tracks the finger,
 * hit-tests the board via `elementFromPoint` + `data-*` drop targets
 * (`data-grid`, `data-slot`/`data-slot-tab`/`data-slot-index`/`data-slot-axis`,
 * `data-tab-drop`, `data-remove-zone`), and on release hands the raw hover
 * state to `onEnd`, which resolves it through `planDrop`.
 */
export function createDashboardDrag(cfg: DashboardDragConfig): DashboardDrag {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [pointer, setPointer] = createSignal<{ x: number; y: number } | null>(null);
  const [dropGap, setDropGap] = createSignal<number | null>(null);
  const [overTab, setOverTab] = createSignal<string | null>(null);
  const [overGrid, setOverGrid] = createSignal<string | null>(null);
  const [overRemove, setOverRemove] = createSignal(false);

  let originTab = "";
  let hoverTab: string | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const hoverMs = cfg.hoverSwitchMs ?? 500;

  // A press that has not LIFTED yet (see `start`).
  let pending: {
    id: string;
    tabId: string;
    x0: number;
    y0: number;
    pointerId: number;
    el: Element | null;
    press: boolean;
  } | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let lifted = false;
  let raf: number | undefined;
  let last: { x: number; y: number } | null = null;

  const clearHover = (): void => {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = undefined;
    hoverTab = null;
  };

  const detach = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", cancel);
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = undefined;
    if (raf !== undefined) cancelAnimationFrame(raf);
    raf = undefined;
    if (lifted) liftedDrags--;
    lifted = false;
    pending = null;
    last = null;
  };

  const reset = (): void => {
    setDraggingId(null);
    setPointer(null);
    setDropGap(null);
    setOverTab(null);
    setOverGrid(null);
    setOverRemove(false);
    clearHover();
  };

  // Resolve the drop target under the point and update the live hover state.
  const hit = (x: number, y: number): void => {
    const el = document.elementFromPoint(x, y);
    if (el?.closest("[data-remove-zone]")) {
      setOverRemove(true);
      setOverTab(null);
      setOverGrid(null);
      setDropGap(null);
      clearHover();
      return;
    }
    setOverRemove(false);
    const tabEl = el?.closest<HTMLElement>("[data-tab-drop]");
    if (tabEl) {
      const t = tabEl.dataset.tabDrop!;
      setOverTab(t);
      setOverGrid(null);
      setDropGap(null);
      // Hover-hold over ANOTHER tab's header switches the view to it, so a card
      // can be dropped into position there rather than only appended.
      if (t !== cfg.activeTab()) {
        if (hoverTab !== t) {
          clearHover();
          hoverTab = t;
          hoverTimer = setTimeout(() => {
            cfg.setActiveTab(t);
            clearHover();
          }, hoverMs);
        }
      } else clearHover();
      return;
    }
    setOverTab(null);
    clearHover();
    // ANY rendered grid is a target now — read the slot's/grid's own target,
    // never a comparison to the one shown tab.
    const slot = el?.closest<HTMLElement>("[data-slot]");
    if (slot) {
      setOverGrid(slot.dataset.slotTab ?? null);
      const idx = Number(slot.dataset.slotIndex);
      const r = slot.getBoundingClientRect();
      // Reading-order gap: past the slot's midpoint on its layout axis drops
      // AFTER it — vertical for the rail strip (a column), horizontal for a grid.
      const after =
        slot.dataset.slotAxis === "y" ? y - r.top > r.height / 2 : x - r.left > r.width / 2;
      setDropGap(after ? idx + 1 : idx);
      return;
    }
    const grid = el?.closest<HTMLElement>("[data-grid]");
    if (grid) {
      setOverGrid(grid.dataset.grid ?? null);
      setDropGap(Number(grid.dataset.gridCount)); // over the grid, off any cell → append
      return;
    }
    setOverGrid(null);
    setDropGap(null);
  };

  // Edge auto-scroll, every frame while lifted: whichever scroll container is
  // under the finger (the board body vertically, the tab strip horizontally)
  // scrolls when the finger rests in its edge band — so a card can reach a
  // slot or a tab header that is off-screen. Never over the remove pill or a
  // tab header (the hover-switch owns those).
  const tick = (): void => {
    raf = undefined;
    if (!lifted || !last) return;
    const { x, y } = last;
    if (!overRemove()) {
      const under = document.elementFromPoint(x, y);
      let moved = false;
      const sy = overTab() ? null : scrollableAncestor(under, "y");
      if (sy) {
        const r = sy.getBoundingClientRect();
        const d = autoScrollStep(y, r.top, r.bottom);
        if (d) {
          const before = sy.scrollTop;
          sy.scrollTop += d;
          moved ||= sy.scrollTop !== before;
        }
      }
      const sx = scrollableAncestor(under, "x");
      if (sx) {
        const r = sx.getBoundingClientRect();
        const d = autoScrollStep(x, r.left, r.right, Math.min(AUTOSCROLL_EDGE_PX, 40));
        if (d) {
          const before = sx.scrollLeft;
          sx.scrollLeft += d;
          moved ||= sx.scrollLeft !== before;
        }
      }
      if (moved) hit(x, y);
    }
    raf = requestAnimationFrame(tick);
  };

  const lift = (x: number, y: number): void => {
    const p = pending;
    if (!p) return;
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = undefined;
    lifted = true;
    liftedDrags++;
    originTab = p.tabId;
    setDraggingId(p.id);
    setPointer({ x, y });
    setDropGap(null);
    setOverTab(null);
    setOverGrid(null);
    setOverRemove(false);
    // Capture keeps the source receiving pointer events even as the finger
    // leaves it; the window listeners are what actually drive the drag.
    try {
      (p.el as Element | null)?.setPointerCapture?.(p.pointerId);
    } catch {
      /* capture is best-effort — the window listeners work without it */
    }
    // A long-press lift gets a tick of haptics where the device has it.
    if (p.press) navigator.vibrate?.(10);
    last = { x, y };
    hit(x, y);
    raf = requestAnimationFrame(tick);
  };

  const move = (e: PointerEvent): void => {
    if (!lifted) {
      const p = pending;
      if (!p || e.pointerId !== p.pointerId) return;
      const dist = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
      if (p.press) {
        // Drifted before the long-press fired → it's a scroll; let it go.
        if (dist > PRESS_SLOP_PX) cancel();
        return;
      }
      if (dist < LIFT_SLOP_PX) return;
      lift(e.clientX, e.clientY);
    }
    if (e.cancelable) e.preventDefault();
    last = { x: e.clientX, y: e.clientY };
    setPointer(last);
    hit(e.clientX, e.clientY);
  };

  const end = (): void => {
    const id = lifted ? draggingId() : null;
    detach();
    if (!id) {
      reset();
      return;
    }
    const final = {
      id,
      originTab,
      overRemove: overRemove(),
      overTab: overTab(),
      overGrid: overGrid(),
      gap: dropGap(),
    };
    reset();
    cfg.onEnd(final);
  };

  // Also the browser taking a `pan-y` press over as a scroll (pointercancel).
  const cancel = (): void => {
    detach();
    reset();
  };

  const start = (id: string, tabId: string, e: PointerEvent, opts?: DragStartOpts): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (pending || lifted) cancel();
    const press = !!opts?.press && e.pointerType === "touch";
    // A press on a scrollable card body must NOT preventDefault, or the
    // browser never gets to scroll it; a handle/mouse press does (no text
    // selection, no native drag).
    if (!press) e.preventDefault();
    e.stopPropagation();
    pending = {
      id,
      tabId,
      x0: e.clientX,
      y0: e.clientY,
      pointerId: e.pointerId,
      el: e.currentTarget as Element | null,
      press,
    };
    if (press) pressTimer = setTimeout(() => lift(pending!.x0, pending!.y0), LONG_PRESS_MS);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  };

  onCleanup(() => {
    detach();
    clearHover();
  });

  return { draggingId, pointer, dropGap, overTab, overGrid, overRemove, start };
}
