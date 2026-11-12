// Deliberately a THRESHOLD, not a 1:1 finger-track: the target sheet isn't
// mounted while closed, so a true continuous pull would mean mounting it under
// the finger and handing the touch across. Opens once the finger clears the threshold.

import { DRAG_SLOP_PX, lockAxis } from "../gesture";

/** How far up the finger must travel past the slop before the pull opens. */
export const SWIPE_OPEN_PX = 30;

/**
 * Read an upward-swipe intent from a drag delta, pure so it's unit-testable
 * without a finger on the glass: `null` undecided, `"abort"` committed to
 * another axis/direction, `"open"` cleared `openPx`. Axis-lock reuses
 * {@link lockAxis} so a diagonal never steals the pull.
 */
export function swipeUpIntent(
  dx: number,
  dy: number,
  openPx: number = SWIPE_OPEN_PX,
): "open" | "abort" | null {
  const axis = lockAxis(dx, dy, DRAG_SLOP_PX);
  if (axis === null) return null;
  if (axis === "x" || dy > 0) return "abort";
  return -dy >= openPx ? "open" : null;
}

/** The touch handlers to spread onto the bar element. */
export interface SwipeUpHandlers {
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

/**
 * A single-touch "swipe up to open" recognizer. Each gesture latches once
 * decided, so a long drag fires `onOpen` exactly once. `enabled` gates it
 * off while the target is already open.
 */
export function createSwipeUp(opts: {
  enabled: () => boolean;
  onOpen: () => void;
  openPx?: number;
}): SwipeUpHandlers {
  let start: { x: number; y: number } | null = null;
  let latched = false;
  const reset = (): void => {
    start = null;
    latched = false;
  };
  return {
    onTouchStart(e) {
      // A second finger (a pinch-zoom) is never an open pull.
      if (e.touches.length !== 1) {
        start = null;
        latched = true;
        return;
      }
      const t = e.touches[0]!;
      start = { x: t.clientX, y: t.clientY };
      latched = false;
    },
    onTouchMove(e) {
      if (!start || latched || !opts.enabled() || e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const intent = swipeUpIntent(t.clientX - start.x, t.clientY - start.y, opts.openPx);
      if (intent === null) return;
      latched = true;
      if (intent === "open") opts.onOpen();
    },
    onTouchEnd: reset,
    onTouchCancel: reset,
  };
}
