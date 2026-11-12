// Long-press and right-click on the chart → "drop a mark here". MapLibre has
// no long-press event, and only some mobile browsers turn a long touch into
// `contextmenu` (Android Chrome does, iOS Safari doesn't) — so touches are
// timed here, and a `contextmenu` arriving right after a long-press fired is
// the same gesture, not a second mark.

import type { Map as MLMap, MapMouseEvent } from "maplibre-gl";

export const LONG_PRESS_MS = 600;
/** A finger that drifts further than this (px) is panning, not pressing. */
export const LONG_PRESS_SLOP_PX = 10;
/** One gesture can fire both paths; the second within this window is dropped. */
const DEDUPE_MS = 1_500;

export interface Pt {
  x: number;
  y: number;
}

export interface LongPressDeps {
  onPress: (at: Pt) => void;
  delayMs?: number;
  slopPx?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** The pure timer/slop logic, fed touch points; testable without a DOM. */
export function createLongPress(deps: LongPressDeps) {
  const delay = deps.delayMs ?? LONG_PRESS_MS;
  const slop = deps.slopPx ?? LONG_PRESS_SLOP_PX;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let origin: Pt | undefined;

  const cancel = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    origin = undefined;
  };

  return {
    /** `touches`: every finger currently down. Two fingers = a pinch. */
    start(touches: readonly Pt[]) {
      cancel();
      if (touches.length !== 1) return;
      const at = touches[0];
      origin = at;
      timer = setTimer(() => {
        timer = undefined;
        origin = undefined;
        deps.onPress(at);
      }, delay);
    },
    move(touches: readonly Pt[]) {
      if (!origin) return;
      const t = touches[0];
      if (touches.length !== 1 || !t || Math.hypot(t.x - origin.x, t.y - origin.y) > slop) cancel();
    },
    end: cancel,
  };
}

/**
 * Wire long-press (touch) and right-click to `map`. `allowed()` false (a chart
 * mode owns the chart) ignores the gesture. Returns the detach function.
 */
export function attachMarkDrop(
  map: MLMap,
  drop: (lngLat: { lng: number; lat: number }) => void,
  allowed: () => boolean,
  now: () => number = () => Date.now(),
): () => void {
  let last: { at: number; via: "touch" | "menu" } | undefined;
  const fire = (x: number, y: number, via: "touch" | "menu") => {
    if (!allowed()) return;
    // The OTHER path, just now: the same finger, already handled. Two
    // right-clicks in a row are two marks.
    if (last && last.via !== via && now() - last.at < DEDUPE_MS) return;
    last = { at: now(), via };
    const ll = map.unproject([x, y]);
    drop({ lng: ll.lng, lat: ll.lat });
  };
  const canvas = map.getCanvasContainer();
  const local = (t: Touch): Pt => {
    const r = canvas.getBoundingClientRect();
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  const press = createLongPress({ onPress: (at) => fire(at.x, at.y, "touch") });
  const onStart = (e: TouchEvent) => press.start(Array.from(e.touches, local));
  const onMove = (e: TouchEvent) => press.move(Array.from(e.touches, local));
  const onEnd = () => press.end();
  const onContext = (e: MapMouseEvent) => {
    e.preventDefault();
    e.originalEvent?.preventDefault?.();
    fire(e.point.x, e.point.y, "menu");
  };
  canvas.addEventListener("touchstart", onStart, { passive: true });
  canvas.addEventListener("touchmove", onMove, { passive: true });
  canvas.addEventListener("touchend", onEnd, { passive: true });
  canvas.addEventListener("touchcancel", onEnd, { passive: true });
  map.on("contextmenu", onContext);
  return () => {
    press.end();
    canvas.removeEventListener("touchstart", onStart);
    canvas.removeEventListener("touchmove", onMove);
    canvas.removeEventListener("touchend", onEnd);
    canvas.removeEventListener("touchcancel", onEnd);
    map.off("contextmenu", onContext);
  };
}
