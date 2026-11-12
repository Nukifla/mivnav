/**
 * The bottom sheet's drag physics — adapted from the author's own
 * `steinerpublish` (`packages/ui/src/{sheet,gesture}.ts`), extended with
 * velocity projection, snap resolution and rubber-band overdrag.
 *
 * DECISIONS are pure functions ({@link resolveSnap}, {@link snapOffsets},
 * etc.) with no DOM, so the unit tests exercise them directly (this harness
 * has no browser); {@link createSheetDrag} is the thin Solid/touch WIRING.
 *
 * Drag-vs-scroll handoff: the sheet only takes a body drag when the content
 * has nowhere left to scroll that direction; everything else is left to
 * native scroll, never `preventDefault`'d.
 */
import {
  createContext,
  createEffect,
  createSignal,
  on,
  onCleanup,
  useContext,
  type Accessor,
} from "solid-js";

/** Slop (px) a body drag must travel before it's read as intent; below this a
 * touch stays a tap / is left to native scroll. The handle arms on touch. */
export const DRAG_SLOP_PX = 8;

/** How far past the lowest snap a release must PROJECT to dismiss instead of
 * springing back. `projected = offset + velocity·horizon`. */
export const DISMISS_DISTANCE_PX = 56;

/** Horizon (ms) release velocity is projected over to decide where the sheet
 * is heading — the single knob unifying flick- and drag-to-dismiss. */
export const SNAP_MOMENTUM_MS = 120;

/** Only the tail of a drag decides velocity — a slow pull ending in a flick
 * should dismiss, a flick ending in a stall should not. */
export const VELOCITY_WINDOW_MS = 90;

/** Rubber-band stiffness (px). Small overdrags feel ~1:1, falling away to
 * this value only in the limit. */
export const RUBBER_SCALE = 160;

/** Asymptotic resistance for pulling the sheet above fully-open (a dead stop
 * feels broken). Grows toward, never reaching, `scale`. `overdrag <= 0` → 0. */
export function rubberBand(overdrag: number, scale = RUBBER_SCALE): number {
  return overdrag > 0 ? (overdrag * scale) / (overdrag + scale) : 0;
}

/**
 * Live offset for a raw finger delta. At/below rest (`raw >= 0`) tracks 1:1
 * (dismiss territory). Above fully-open, `overdragAbove` picks rubber-band
 * resistance (Panel) vs. a hard clamp (route planner — stops it lifting off
 * `bottom-0` and exposing the rail/helm widgets beneath).
 */
export function overdragOffset(raw: number, overdragAbove = true): number {
  if (raw >= 0) return raw;
  return overdragAbove ? -rubberBand(-raw) : 0;
}

/** Snap FRACTIONS (1 = fully open, 0.5 = half showing) → translate OFFSETS in
 * px for a sheet of `height`, sorted ascending (first = fully-open, 0). */
export function snapOffsets(snapPoints: number[], height: number): number[] {
  return snapPoints.map((f) => height * (1 - f)).sort((a, b) => a - b);
}

export interface SnapResolution {
  /** Release should dismiss (animate fully out) rather than settle to a snap. */
  dismiss: boolean;
  /** The snap offset to settle at when not dismissing (px, 0 = fully open). */
  offset: number;
}

/**
 * Where a released drag settles — the dismiss-vs-snap decision, pure. Momentum
 * projects forward; nearest resting position wins (flick carries between
 * snaps). Past the lowest snap by more than the dismiss gap: dismiss.
 */
export function resolveSnap(
  current: number,
  velocity: number,
  snaps: number[],
  opts?: { momentumMs?: number; dismissDistancePx?: number },
): SnapResolution {
  const horizon = opts?.momentumMs ?? SNAP_MOMENTUM_MS;
  const dismissGap = opts?.dismissDistancePx ?? DISMISS_DISTANCE_PX;
  const lowest = snaps.length ? snaps[snaps.length - 1]! : 0;
  const projected = current + velocity * horizon;
  if (projected >= lowest + dismissGap) return { dismiss: true, offset: lowest };
  const p = Math.min(Math.max(projected, 0), lowest);
  let best = snaps[0] ?? 0;
  let bestDist = Infinity;
  for (const s of snaps) {
    const d = Math.abs(p - s);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return { dismiss: false, offset: best };
}

/** Clamp `index` into `[0, count-1]`; an empty set pins to 0. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/** Which slide a settled horizontal scroll-snap rests on, pure. `step` is the
 * slide pitch in px; landed index is `scrollLeft/step` rounded and clamped.
 * Zero/negative step (nothing measured yet) pins to 0. */
export function slideIndexFromScroll(scrollLeft: number, step: number, count: number): number {
  if (step <= 0) return clampIndex(0, count);
  return clampIndex(Math.round(scrollLeft / step), count);
}

/** The axis a past-slop drag commits to, pure. `null` within slop on both axes
 * (a tap). Past slop, dominant delta wins; ties fall to `"y"` so a diagonal
 * never steals a scroll from the sheet. */
export function lockAxis(dx: number, dy: number, slop = DRAG_SLOP_PX): "x" | "y" | null {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/**
 * Which slide a horizontal pager drag lands on, pure — momentum-projected like
 * {@link resolveSnap}, bounded to `startIndex ± 1` so a flick carries one
 * slide over, never three. Non-positive `pitch` (unmeasured) holds the start.
 */
export function pagerLandingIndex(
  startIndex: number,
  dx: number,
  velocityX: number,
  pitch: number,
  count: number,
  opts?: { momentumMs?: number },
): number {
  if (pitch <= 0) return clampIndex(startIndex, count);
  const horizon = opts?.momentumMs ?? SNAP_MOMENTUM_MS;
  const projected = startIndex * pitch - dx - velocityX * horizon;
  const nearest = Math.round(projected / pitch);
  const bounded = Math.min(Math.max(nearest, startIndex - 1), startIndex + 1);
  return clampIndex(bounded, count);
}

/** The item whose measured centre is nearest `clientX`, pure. Nearest-centre
 * rather than a uniform division so it stays right for unequal-width icons
 * and a scrolled strip. Empty → 0. */
export function nearestIndex(clientX: number, centers: readonly number[]): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const d = Math.abs(clientX - centers[i]!);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Px of horizontal drag sweeping a scrub field across its whole range. Tuned
 * for a finger: 200px ≈ a relaxed thumb-swipe. */
export const SCRUB_TRAVEL_PX = 200;

/** Total pointer travel (px) below which a scrub-field press reads as a tap
 * (focus to type) rather than a drag. Shares the sheet's arm slop. */
export const SCRUB_TAP_SLOP_PX = DRAG_SLOP_PX;

/** Snap `value` to the `step` grid (anchored at `min`) and clamp to `[min,max]`
 * — shared by drag/arrow-keys/typed entry. The final round kills binary-float
 * drift (a 0.05 step can't be represented exactly). `step <= 0` = continuous. */
export function clampStep(value: number, min: number, max: number, step: number): number {
  const snapped = step > 0 ? Math.round((value - min) / step) * step + min : value;
  return Math.round(Math.min(Math.max(snapped, min), max) * 1e6) / 1e6;
}

/** The value a scrub drag of `delta` px lands on, starting from `start`
 * (snapshotted at pointer-down so a grab never jumps). `delta` maps linearly
 * onto `[min,max]` over `travelPx`, then {@link clampStep} snaps/clamps. */
export function scrubValue(
  start: number,
  delta: number,
  min: number,
  max: number,
  step: number,
  travelPx = SCRUB_TRAVEL_PX,
): number {
  const raw = start + ((max - min) * delta) / travelPx;
  return clampStep(raw, min, max, step);
}

/** Folds a 2-D scrub drag into the single delta {@link scrubValue} expects:
 * right or up raises the value (`dy` negated, screen Y grows downward). Axes
 * are added, not dominant-picked, so a diagonal drag scrubs faster, not
 * ambiguously. */
export function scrubDelta(dx: number, dy: number): number {
  return dx - dy;
}

/** Whether a press that moved `dx`,`dy` px stayed within tap slop (a tap, not
 * the start of a scrub drag). */
export function isScrubTap(dx: number, dy: number, slop = SCRUB_TAP_SLOP_PX): boolean {
  return Math.abs(dx) < slop && Math.abs(dy) < slop;
}

export interface VelocityTracker {
  reset(): void;
  push(timeMs: number, pos: number): void;
  /** px/ms across the retained window; 0 with fewer than two samples. */
  velocity(): number;
}

/** A short trailing-window velocity estimator. Timestamps are passed in
 * rather than read from a clock so the decision stays testable. */
export function createVelocityTracker(windowMs = VELOCITY_WINDOW_MS): VelocityTracker {
  let samples: { t: number; p: number }[] = [];
  return {
    reset() {
      samples = [];
    },
    push(timeMs, pos) {
      samples.push({ t: timeMs, p: pos });
      const cutoff = timeMs - windowMs;
      // Keep at least two samples so a fast flick sampled only twice survives.
      while (samples.length > 2 && samples[0]!.t < cutoff) samples.shift();
    },
    velocity() {
      if (samples.length < 2) return 0;
      const a = samples[0]!;
      const b = samples[samples.length - 1]!;
      const dt = b.t - a.t;
      return dt > 0 ? (b.p - a.p) / dt : 0;
    },
  };
}

/** Touch handlers for a surface that owns its drag outright (the grab handle). */
export interface TouchHandlers {
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: (e: TouchEvent) => void;
  onTouchCancel: (e: TouchEvent) => void;
}

export interface SheetDragConfig {
  /** The scrollable body — read for its `scrollTop` at the handoff decision. */
  scrollEl: Accessor<HTMLElement | undefined>;
  /** Where the sheet rests right now (px, 0 = fully open) — up-drags are only
   *  taken when this is > 0 (a taller detent above). */
  restingOffset: Accessor<number>;
  /** Current snap offsets ({@link snapOffsets} of the measured sheet). */
  snapOffsets: Accessor<number[]>;
  /** Settle to a snap offset. */
  onSnap: (offset: number) => void;
  /** Release cleared the dismiss line — animate the sheet out. */
  onDismiss: () => void;
  /** May the sheet be dragged above fully-open? Defaults `true` (Panel
   *  sheets). A floor-at-peek sheet (route planner) passes `false` so
   *  fully-open is a hard ceiling: no lift off `bottom-0`. */
  overdragAbove?: boolean;
  /** Clock injection point for tests; defaults to `performance.now`. */
  now?: () => number;
}

export interface SheetDrag {
  /** Wire onto the grab-handle strip (give it `touch-action: none`). */
  handle: TouchHandlers;
  /** The body's deferred-arm + scroll-handoff handlers — exposed so a nested
   *  recogniser owning the touches itself (the pager) can FORWARD the vertical
   *  axis here, reusing the drag-vs-scroll/dismiss/detent machine. */
  body: TouchHandlers;
  /** Ref callback for the scroll body; attaches the handoff listeners
   *  (non-passive touchmove) and auto-cleans them. */
  bindBody: (el: HTMLElement) => void;
  /** True while a drag is armed and tracking the finger. */
  dragging: Accessor<boolean>;
  /** The live absolute offset (px) while dragging; meaningless when idle. */
  offset: Accessor<number>;
  /** The scroll body this drag hands off to — exposed so a nested pager
   *  scrolls the SAME element the sheet reads for its boundary. */
  scrollEl: Accessor<HTMLElement | undefined>;
}

/** The touch machine behind {@link SheetDrag}: one state set drives both the
 * handle (armed on touch) and the body (deferred arm + scroll handoff). */
export function createSheetDrag(cfg: SheetDragConfig): SheetDrag {
  const now = cfg.now ?? (() => performance.now());
  const overdragAbove = cfg.overdragAbove ?? true;
  const [dragging, setDragging] = createSignal(false);
  const [offset, setOffset] = createSignal(0);
  const vel = createVelocityTracker();

  let start: { x: number; y: number } | null = null;
  let armed = false;
  let ignored = false; // latched out: gesture belongs to native scroll
  let armOffset = 0; // resting offset snapshot at the moment we armed

  const arm = (): void => {
    armed = true;
    armOffset = cfg.restingOffset();
    vel.reset();
    setOffset(armOffset);
    setDragging(true);
  };

  const reset = (): void => {
    start = null;
    armed = false;
    ignored = false;
  };

  // Tear down a live gesture, springing back to rest only if it had armed.
  const cancel = (): void => {
    const wasArmed = armed;
    reset();
    if (wasArmed) {
      setDragging(false);
      cfg.onSnap(cfg.restingOffset());
    }
  };

  const begin = (e: TouchEvent, immediate: boolean): void => {
    // A second finger abandons any drag — a sheet has no two-finger meaning.
    if (e.touches.length !== 1) {
      cancel();
      return;
    }
    const t = e.touches[0]!;
    start = { x: t.clientX, y: t.clientY };
    armed = false;
    ignored = false;
    // A touch starting on an interactive control must never arm a sheet drag
    // (a jittery press would otherwise lurch the sheet mid-tap).
    const target = e.target;
    if (target instanceof Element && target.closest("[data-no-drag]")) {
      ignored = true;
      return;
    }
    if (immediate) arm();
  };

  const move = (e: TouchEvent): void => {
    if (!start || ignored || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    const dy = t.clientY - start.y;
    const dx = t.clientX - start.x;
    if (!armed) {
      if (Math.abs(dy) < DRAG_SLOP_PX && Math.abs(dx) < DRAG_SLOP_PX) return;
      // Horizontal intent is never ours — latch out and leave the touch alone.
      if (Math.abs(dy) <= Math.abs(dx)) {
        ignored = true;
        return;
      }
      // The handoff: take the drag only where the content can't absorb it.
      const atTop = (cfg.scrollEl()?.scrollTop ?? 0) <= 0;
      const canExpand = cfg.restingOffset() > 0;
      if (dy > 0 && atTop) arm();
      else if (dy < 0 && canExpand) arm();
      else {
        ignored = true; // a real content scroll — hands off for the rest of it
        return;
      }
    }
    // Armed: block native scroll/overscroll so only the sheet moves.
    if (e.cancelable) e.preventDefault();
    const raw = armOffset + dy;
    setOffset(overdragOffset(raw, overdragAbove));
    vel.push(now(), t.clientY);
  };

  const end = (e: TouchEvent): void => {
    if (!start) return;
    const wasArmed = armed;
    const t = e.changedTouches[0];
    if (t) vel.push(now(), t.clientY);
    reset();
    if (!wasArmed) return;
    const res = resolveSnap(offset(), vel.velocity(), cfg.snapOffsets());
    setDragging(false);
    if (res.dismiss) cfg.onDismiss();
    else cfg.onSnap(res.offset);
  };

  const handle: TouchHandlers = {
    onTouchStart: (e) => begin(e, true),
    onTouchMove: move,
    onTouchEnd: end,
    onTouchCancel: cancel,
  };

  // Armed only past the scroll boundary, so a press starting on scrollable
  // content scrolls it instead.
  const body: TouchHandlers = {
    onTouchStart: (e) => begin(e, false),
    onTouchMove: move,
    onTouchEnd: end,
    onTouchCancel: cancel,
  };

  const bindBody = (el: HTMLElement): void => {
    el.addEventListener("touchstart", body.onTouchStart, { passive: true });
    el.addEventListener("touchmove", body.onTouchMove, { passive: false });
    el.addEventListener("touchend", body.onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", body.onTouchCancel, { passive: true });
    onCleanup(() => {
      el.removeEventListener("touchstart", body.onTouchStart);
      el.removeEventListener("touchmove", body.onTouchMove);
      el.removeEventListener("touchend", body.onTouchEnd);
      el.removeEventListener("touchcancel", body.onTouchCancel);
    });
  };

  return { handle, body, bindBody, dragging, offset, scrollEl: cfg.scrollEl };
}

/** The {@link SheetDrag} of the enclosing phone sheet, shared down the tree so
 * a nested recogniser can delegate its vertical axis to it. PhoneSheet
 * (chrome/Sheet.tsx) provides it; the pager (info/HitCarousel.tsx) consumes it. */
export const SheetDragContext = createContext<SheetDrag>();

/** The enclosing sheet's drag, or `undefined` outside a phone sheet. */
export function useSheetDrag(): SheetDrag | undefined {
  return useContext(SheetDragContext);
}

export interface ScrubSelectConfig {
  /** How many items the strip holds — a scrub does nothing on an empty set. */
  count: Accessor<number>;
  /** Select the item under the finger — called live as it slides, and once on
   *  a plain tap. Idempotent selects expected, so must be cheap to re-call. */
  onSelect: (index: number) => void;
}

export interface ScrubSelect {
  /** Ref callback for the icon strip; pointer capture rides on this element,
   *  so a slide off the pressed icon keeps feeding this handler. Children
   *  measured for centres need `[data-scrub-item]`. */
  bindRow: (el: HTMLElement) => void;
  /** True while a finger is down and scrubbing. */
  scrubbing: Accessor<boolean>;
}

/**
 * A scrubber over a row of items: the item under the finger is selected LIVE
 * as you slide, so you can rake through hits without lifting. No tap-vs-scrub
 * disambiguation needed: pointer-down already selects, so a tap is just a
 * scrub with no travel. Pointer capture on the row keeps every move routed
 * here even once the finger slides onto a neighbour icon.
 */
export function createScrubSelect(cfg: ScrubSelectConfig): ScrubSelect {
  const [scrubbing, setScrubbing] = createSignal(false);
  let row: HTMLElement | undefined;
  let pointerId: number | null = null;

  const selectAt = (clientX: number): void => {
    if (!row) return;
    const items = row.querySelectorAll<HTMLElement>("[data-scrub-item]");
    if (items.length === 0) return;
    const centers: number[] = [];
    items.forEach((it) => {
      const r = it.getBoundingClientRect();
      centers.push(r.left + r.width / 2);
    });
    cfg.onSelect(nearestIndex(clientX, centers));
  };

  const down = (e: PointerEvent): void => {
    // Only the primary contact scrubs; a second finger would fight the first.
    if (!e.isPrimary || cfg.count() < 1 || pointerId !== null) return;
    pointerId = e.pointerId;
    row?.setPointerCapture?.(e.pointerId);
    setScrubbing(true);
    selectAt(e.clientX);
  };

  const move = (e: PointerEvent): void => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    if (e.cancelable) e.preventDefault();
    selectAt(e.clientX);
  };

  const up = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    setScrubbing(false);
    // pointercancel (or a defensive second call) must not throw.
    if (row?.hasPointerCapture?.(e.pointerId)) row.releasePointerCapture(e.pointerId);
  };

  const bindRow = (el: HTMLElement): void => {
    row = el;
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    onCleanup(() => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    });
  };

  return { bindRow, scrubbing };
}

export interface PagerDragConfig {
  /** The current slide index — the track rests at `-index·pitch`, and a swipe
   *  starts paging from here. */
  index: Accessor<number>;
  /** How many slides the pager holds. */
  count: Accessor<number>;
  /** Slide PITCH in px (one full-width slide plus the inter-slide gutter),
   *  re-measured on resize. A swipe snaps to a multiple of it. */
  pitch: Accessor<number>;
  /** Adopt a settled swipe's landed slide. Idempotent selects expected. */
  onSelect: (index: number) => void;
  /** The enclosing sheet's drag — vertical drags are FORWARDED to its `body`
   *  handlers, reusing its drag-vs-scroll/dismiss/detent machine. When the
   *  sheet declines a move as content scroll (`dragging()` false) the pager
   *  must drive the scroll by hand, since its own `touch-action: none` (needed
   *  to keep iOS from stealing the horizontal swipe) leaves the browser
   *  nothing native to scroll there. */
  sheet: SheetDrag;
  /** Clock injection for tests; defaults to `performance.now`. */
  now?: () => number;
}

export interface PagerDrag {
  /** Ref/bind for the pager VIEWPORT — the `touch-action: none` region. */
  bindViewport: (el: HTMLElement) => void;
  /** The live track translate (px; 0 = slide 0, negative = later slides). */
  offset: Accessor<number>;
  /** True while a horizontal drag tracks the finger 1:1. */
  dragging: Accessor<boolean>;
  /** Whether the latest `offset` change should animate (settle/external
   *  select) vs. snap instantly (finger-tracking, resize realign). */
  animate: Accessor<boolean>;
}

/**
 * Opt-out marker for a horizontally scrollable region inside a pager slide
 * (a place's photo strip): a horizontal drag that STARTS on an element carrying
 * this attribute scrolls that element instead of paging — while it can still
 * scroll in the drag's direction, decided once when the axis locks (see
 * {@link canScrollX}). docs/architecture/pager-drag.md.
 */
export const PAGER_SCROLL_X_ATTR = "data-pager-scroll-x";

/**
 * Whether a horizontal finger delta `dx` can still scroll `el`, pure. A
 * leftward drag (`dx < 0`) reveals content to the right, so needs room below
 * the max `scrollLeft`; a rightward one needs `scrollLeft > 0`. 1px of slack
 * absorbs fractional scroll positions. A region that doesn't overflow can
 * never scroll, so the pager keeps it.
 */
export function canScrollX(
  el: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  dx: number,
): boolean {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 1 || dx === 0) return false;
  return dx < 0 ? el.scrollLeft < max - 1 : el.scrollLeft > 1;
}

/**
 * A horizontal slide pager that owns BOTH touch axes (nested in a dragging
 * bottom sheet); vertical is forwarded to the sheet's {@link SheetDrag}. See
 * docs/architecture/pager-drag.md for why, and the stopPropagation history.
 * A horizontal drag that starts on a {@link PAGER_SCROLL_X_ATTR} region that
 * can scroll that way scrolls it by hand instead of paging.
 */
export function createPagerDrag(cfg: PagerDragConfig): PagerDrag {
  const now = cfg.now ?? (() => performance.now());
  const [offset, setOffset] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  const [animate, setAnimate] = createSignal(true);
  const vel = createVelocityTracker();

  let start: { x: number; y: number } | null = null;
  // "scroll-x": a horizontal drag that a PAGER_SCROLL_X_ATTR region owns.
  let axis: "x" | "y" | "scroll-x" | null = null;
  let viewport: HTMLElement | null = null;
  let scroller: HTMLElement | null = null; // the opt-out region this touch began on
  let scrollerStart = 0; // its scrollLeft at touchstart
  let startIndex = 0; // index the current swipe began paging from
  let startOffset = 0; // track translate at that index
  let lastY = 0; // previous clientY, for incremental content-scroll

  // External select (indicator/keyboard) → glide to that slide; skipped while
  // a horizontal drag owns the track.
  createEffect(
    on(cfg.index, (i) => {
      if (axis === "x") return;
      setAnimate(true);
      setOffset(-i * cfg.pitch());
    }),
  );

  // Resize/rotate → realign the current slide to the new pitch, instantly.
  createEffect(
    on(cfg.pitch, (p) => {
      if (axis === "x") return;
      setAnimate(false);
      setOffset(-cfg.index() * p);
    }),
  );

  const clear = (): void => {
    start = null;
    axis = null;
    scroller = null;
  };

  /** The opt-out region (inside this viewport) a touch began on, if any. */
  const scrollerAt = (target: EventTarget | null): HTMLElement | null => {
    const hit = (target as Element | null)?.closest?.(`[${PAGER_SCROLL_X_ATTR}]`);
    return hit && viewport?.contains(hit) ? (hit as HTMLElement) : null;
  };

  const cancel = (e?: TouchEvent): void => {
    // See docs/architecture/pager-drag.md (#5th-attempt-carousel-stuck).
    e?.stopPropagation();
    if (e) cfg.sheet.body.onTouchCancel(e);
    if (axis === "x") {
      setDragging(false);
      setAnimate(true);
      setOffset(-clampIndex(cfg.index(), cfg.count()) * cfg.pitch());
    }
    clear();
  };

  const begin = (e: TouchEvent): void => {
    e.stopPropagation();
    if (e.touches.length !== 1) {
      cancel(e);
      return;
    }
    const t = e.touches[0]!;
    start = { x: t.clientX, y: t.clientY };
    axis = null;
    scroller = scrollerAt(e.target);
    scrollerStart = scroller?.scrollLeft ?? 0;
    lastY = t.clientY;
    vel.reset();
    // Sheet needs the same start snapshot in case this turns vertical
    // (harmless if we go horizontal).
    cfg.sheet.body.onTouchStart(e);
  };

  const move = (e: TouchEvent): void => {
    // See docs/architecture/pager-drag.md (#5th-attempt-carousel-stuck).
    e.stopPropagation();
    if (!start) return;
    if (e.touches.length !== 1) {
      cancel(e);
      return;
    }
    const t = e.touches[0]!;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    if (axis === null) {
      const locked = lockAxis(dx, dy);
      if (!locked) return; // still a tap
      axis = locked;
      // Decided ONCE, here: a region that can still scroll this way owns the
      // whole drag; one at its edge (or not overflowing) leaves it to paging.
      if (axis === "x" && scroller && canScrollX(scroller, dx)) axis = "scroll-x";
      if (axis === "x") {
        startIndex = clampIndex(cfg.index(), cfg.count());
        startOffset = -startIndex * cfg.pitch();
        setAnimate(false);
        setDragging(true);
      }
    }

    if (axis === "x") {
      if (e.cancelable) e.preventDefault();
      vel.push(now(), t.clientX);
      setOffset(startOffset + dx);
      return;
    }

    if (axis === "scroll-x") {
      // By hand, like the vertical content scroll below: the viewport's
      // touch-action: none leaves the browser nothing native to run. The
      // browser clamps scrollLeft to its range.
      if (e.cancelable) e.preventDefault();
      scroller!.scrollLeft = scrollerStart - dx;
      return;
    }

    // Vertical: sheet owns the decision; drive the scroll it declined.
    cfg.sheet.body.onTouchMove(e);
    if (!cfg.sheet.dragging()) {
      const el = cfg.sheet.scrollEl();
      if (el) el.scrollTop -= t.clientY - lastY;
    }
    lastY = t.clientY;
  };

  const end = (e: TouchEvent): void => {
    // Same reasoning as move() — stop propagation before the `!start` guard.
    e.stopPropagation();
    if (!start) return;
    if (axis === "x") {
      const t = e.changedTouches[0];
      if (t) vel.push(now(), t.clientX);
      const dx = t ? t.clientX - start.x : 0;
      const landed = pagerLandingIndex(
        startIndex,
        dx,
        vel.velocity(),
        cfg.pitch(),
        cfg.count(),
      );
      setDragging(false);
      setAnimate(true);
      setOffset(-landed * cfg.pitch());
      cfg.onSelect(landed);
    } else if (axis === "scroll-x") {
      // The region scrolled; the track never moved and nothing is selected.
    } else {
      // Vertical or never-locked (a tap): let sheet finish its gesture.
      cfg.sheet.body.onTouchEnd(e);
    }
    clear();
  };

  const bindViewport = (el: HTMLElement): void => {
    viewport = el;
    el.addEventListener("touchstart", begin, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", cancel, { passive: true });
    onCleanup(() => {
      el.removeEventListener("touchstart", begin);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", cancel);
    });
  };

  return { bindViewport, offset, dragging, animate };
}
