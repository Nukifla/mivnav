// The ONE rule for who owns the chart while a person is touching it. See
// docs/architecture/map-gesture-policy.md.
//
// MapLibre cancels EVERY in-flight gesture (pinch, pan, even a pending tap)
// whenever the camera is moved programmatically: `easeTo`/`jumpTo`/`fitBounds`
// all go through `Camera._stop(false)` → `handlers.stop(false)`. So any
// background camera move that fires while fingers are on the glass — the
// follow-boat recentre runs on EVERY SignalK snapshot — silently kills the
// pinch or drag the crew is in the middle of. That was the "can't pinch or
// drag when my fingers hit the route / the course line" bug: with the boat in
// frame (follow-boat on, the default) the course line starts at the boat, which
// is exactly where you put your fingers to zoom.
//
// The mouse has the same hole, only narrower, so it reads as "sometimes": a
// pressed mouse button arms MapLibre's drag-pan, but the pan only STARTS
// (`dragstart`/`movestart`) once the pointer has moved past the click
// tolerance. A recentre landing between the press and that first movement
// resets the armed handler and the whole drag is dead — the chart never
// moves, however far the mouse then goes. ("on pc when the "follow boat"
// button is on sometimes i cannot drag the screen around".) So a held mouse
// button counts as a hand on the chart exactly like a finger does.
//
// Two halves, both here so there is one place to read the policy:
//   1. `trackUserGestures(map)` / `userGestureActive(map)` — "is a person
//      touching, pressing, wheeling or gesturing the chart right now?". Background
//      camera moves (follow recentre, the reveal-warp) must skip while it is
//      true.
//   2. `isMultiTouch(e)` — map-native one-finger interactions (the route
//      editor's stop drag) must never claim a gesture with 2+ fingers on the
//      glass: that is always MapLibre's pinch.

import type { Map as MLMap } from "maplibre-gl";

/** The slice of a MapLibre touch/mouse event this module reads. */
export interface TouchishEvent {
  originalEvent?: { touches?: { length: number } } | unknown;
}

/** Fingers currently on the glass for a map touch event (0 for a mouse event
 * or a `touchend` that lifted the last finger). */
export function touchCount(e: TouchishEvent | undefined): number {
  const oe = e?.originalEvent as { touches?: { length: number } } | undefined;
  return oe?.touches?.length ?? 0;
}

/** Two or more fingers down: a pinch, which always belongs to MapLibre — no
 * app handler may arm, preventDefault or disable a map handler for it. */
export function isMultiTouch(e: TouchishEvent | undefined): boolean {
  return touchCount(e) > 1;
}

/** The slice of a MapLibre (or DOM) mouse event the tracker reads. */
export interface MouseishEvent {
  originalEvent?: { buttons?: number } | unknown;
  buttons?: number;
}

/** Is the PRIMARY mouse button down, per the event's own live `buttons`
 * bitmask? Only the primary one: it is the button that pans (rotation is off,
 * so the secondary does nothing), and a context-menu press may never deliver
 * its `mouseup` to the page. */
export function primaryButtonDown(e: MouseishEvent | undefined): boolean {
  const oe = (e?.originalEvent ?? e) as { buttons?: number } | undefined;
  return ((oe?.buttons ?? 0) & 1) === 1;
}

/** A camera event as the tracker reads it (MapLibre stamps `originalEvent`
 * on every gesture-driven move; our own background moves carry `mivnavAuto`). */
interface CameraEventLike {
  originalEvent?: unknown;
  mivnavAuto?: boolean;
}

/** What `trackUserGestures` needs from the map. */
export type GestureTrackedMap = Pick<MLMap, "on" | "off">;

/** Where a mouse button released OUTSIDE the chart is heard (the window): a
 * drag that leaves the canvas, or the browser window, ends there, and the map
 * itself never fires `mouseup` for it. */
export interface ReleaseTarget {
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
}

/** How long one wheel event holds the chart, ms. MapLibre does not move the
 * camera ON the wheel event: it waits up to 40 ms to tell a mouse wheel from
 * a trackpad, then zooms on the next render frame — and only that frame fires
 * `movestart`. A recentre landing in between resets the scroll handler and
 * the notch is simply lost (measured, experiments/followHoldOffset.ts TRACE:
 * `wheel`, then the follow's `easeTo` 43 ms later, and no zoom at all). The
 * same hole as the pressed-but-not-yet-moved mouse button, so the wheel event
 * itself holds, for a fixed time after the LAST one. Generous on purpose:
 * with real charts on a slow renderer the first frame came 220 ms+ after the
 * wheel event and a 300 ms hold still lost notches. Deliberately NOT released
 * by a `moveend`: a notch arriving just as the previous notch's zoom ends is
 * exactly the one that was lost (that zoom's `moveend` re-anchors the follow,
 * whose recentre then reset the handler before the new notch's frame). The
 * cost is that follow waits this long after the last wheel event before it
 * tracks the boat again. */
export const WHEEL_HOLD_MS = 1000;

/** Pure state machine behind the tracker — event-driven, map-free, so the
 * rule is unit-testable without MapLibre. `now` is injectable for tests. */
export function createUserGestureState(now: () => number = () => performance.now()) {
  let fingers = 0;
  let pressed = false;
  let gestureMove = false;
  let wheelUntil = -Infinity;
  return {
    /** A wheel event on the chart (mouse wheel, trackpad scroll or pinch). */
    wheel() {
      wheelUntil = now() + WHEEL_HOLD_MS;
    },
    /** A mouse press on the chart (`mousedown`): held from here until the
     * button is seen up again. */
    press(e: MouseishEvent | undefined) {
      pressed = primaryButtonDown(e);
    },
    /** Any later mouse event (`mousemove` on the chart, `mouseup` anywhere):
     * its live `buttons` mask can only RELEASE the hold, never take it — a
     * button pressed on a panel and dragged across the chart is not a chart
     * gesture. Like the touch list, it self-corrects after a lost `mouseup`. */
    pointer(e: MouseishEvent | undefined) {
      if (pressed && !primaryButtonDown(e)) pressed = false;
    },
    /** The window lost focus: whatever was held is no longer ours to track. */
    release() {
      pressed = false;
    },
    /** touchstart / touchend / touchcancel: the event's own live touch list
     * is the truth, so a lost event self-corrects on the next one. */
    touch(e: TouchishEvent | undefined) {
      fingers = touchCount(e);
    },
    movestart(e: CameraEventLike | undefined) {
      if (e?.originalEvent !== undefined && !e.mivnavAuto) gestureMove = true;
    },
    /** Any moveend means the camera has stopped (MapLibre fires it only once
     * nothing is moving), so it always clears — it can never stick. */
    moveend() {
      gestureMove = false;
    },
    /** Fingers on the glass, the mouse button held on the chart, a wheel
     * event just received, or a gesture-driven move (pinch, pan, wheel,
     * zoom-button ease, pan inertia) still running. */
    active: () => fingers > 0 || pressed || gestureMove || now() < wheelUntil,
  };
}

const trackers = new WeakMap<object, ReturnType<typeof createUserGestureState>>();

/** Install the tracker on `map` (MapView, once per map). Returns a detach.
 * `releaseTarget` defaults to the window when there is one (none under
 * `bun test`, where the map's own events are all a test can fire). */
export function trackUserGestures(
  map: GestureTrackedMap,
  releaseTarget: ReleaseTarget | undefined = typeof window === "undefined" ? undefined : window,
): () => void {
  const state = createUserGestureState();
  trackers.set(map, state);
  const onTouch = (e: TouchishEvent) => state.touch(e);
  const onPress = (e: MouseishEvent) => state.press(e);
  const onPointer = (e: MouseishEvent) => state.pointer(e);
  const onWheel = () => state.wheel();
  const onWindowUp = (e: Event) => state.pointer(e as MouseishEvent);
  const onBlur = () => state.release();
  const onMoveStart = (e: CameraEventLike) => state.movestart(e);
  const onMoveEnd = () => state.moveend();
  map.on("touchstart", onTouch);
  map.on("touchend", onTouch);
  map.on("touchcancel", onTouch);
  map.on("mousedown", onPress);
  map.on("mousemove", onPointer);
  map.on("mouseup", onPointer);
  map.on("wheel", onWheel);
  map.on("movestart", onMoveStart);
  map.on("moveend", onMoveEnd);
  releaseTarget?.addEventListener("mouseup", onWindowUp);
  releaseTarget?.addEventListener("blur", onBlur);
  return () => {
    map.off("mousedown", onPress);
    map.off("mousemove", onPointer);
    map.off("mouseup", onPointer);
    map.off("wheel", onWheel);
    releaseTarget?.removeEventListener("mouseup", onWindowUp);
    releaseTarget?.removeEventListener("blur", onBlur);
    map.off("touchstart", onTouch);
    map.off("touchend", onTouch);
    map.off("touchcancel", onTouch);
    map.off("movestart", onMoveStart);
    map.off("moveend", onMoveEnd);
    if (trackers.get(map) === state) trackers.delete(map);
  };
}

/** Is a person touching, pressing or gesturing `map` right now? `false` for a map with
 * no tracker installed (test doubles), so callers keep their old behaviour. */
export function userGestureActive(map: object): boolean {
  return trackers.get(map)?.active() ?? false;
}
