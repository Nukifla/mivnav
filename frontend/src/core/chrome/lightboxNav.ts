// The pure decisions behind ./Lightbox.tsx — which photo an index lands on,
// what a finger's travel means, what a key does — kept DOM-free so the rules
// are unit-tested (./lightboxNav.test.ts) rather than only eyeballed.

import { DRAG_SLOP_PX } from "../gesture";

/** A released horizontal drag this far (px) or further pages; shorter springs
 * back. A floor, not the whole rule — see {@link swipeStep}. */
export const LIGHTBOX_SWIPE_PX = 48;

/** …or this fraction of the stage width, whichever is SMALLER — so a narrow
 * phone doesn't need a thumb-length sweep, and a wide desktop stage doesn't
 * page on a twitch. */
export const LIGHTBOX_SWIPE_FRACTION = 0.2;

/** `i` wrapped into `[0, count)` — prev on the first photo lands on the last,
 * next on the last lands on the first. `0` for an empty set. */
export function wrapIndex(i: number, count: number): number {
  if (count <= 0 || !Number.isFinite(i)) return 0;
  const t = Math.trunc(i);
  return ((t % count) + count) % count;
}

/** `i` clamped into `[0, count - 1]` — for a starting index that must name a
 * real photo (a stale index after the set shrank opens the nearest one). `0`
 * for an empty set. */
export function clampIndex(i: number, count: number): number {
  if (count <= 0 || !Number.isFinite(i)) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(i)));
}

/** The distance a release must clear to page, for a stage `width` px wide
 * (unmeasured/0 → the fixed floor). */
export function swipeThreshold(width: number): number {
  return width > 0 ? Math.min(LIGHTBOX_SWIPE_PX, width * LIGHTBOX_SWIPE_FRACTION) : LIGHTBOX_SWIPE_PX;
}

/**
 * What a released drag of `(dx, dy)` means: `+1` next (finger went LEFT, the
 * next photo comes in from the right), `-1` previous, `0` stay. Only a
 * predominantly HORIZONTAL drag pages — a vertical or diagonal-ish one is
 * never read as a swipe.
 */
export function swipeStep(dx: number, dy: number, width = 0): -1 | 0 | 1 {
  if (Math.abs(dx) <= Math.abs(dy)) return 0;
  if (Math.abs(dx) < swipeThreshold(width)) return 0;
  return dx < 0 ? 1 : -1;
}

/** Did the pointer move far enough that its trailing `click` is the END of a
 * drag, not a tap? (A swipe that starts on the backdrop must not close it.) */
export function isDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) >= DRAG_SLOP_PX || Math.abs(dy) >= DRAG_SLOP_PX;
}

/** A keypress while the lightbox is open: page, close, or not ours. */
export function lightboxKey(key: string): 1 | -1 | "close" | undefined {
  if (key === "ArrowRight") return 1;
  if (key === "ArrowLeft") return -1;
  if (key === "Escape") return "close";
  return undefined;
}

/** The position readout, `"2 / 5"`. */
export function positionLabel(index: number, count: number): string {
  return `${wrapIndex(index, count) + 1} / ${count}`;
}
