// The map-gesture policy (docs/architecture/map-gesture-policy.md): 2+ fingers
// is always MapLibre's pinch, and no background camera move may fire while a
// person is touching or gesturing the chart (MapLibre's easeTo cancels every
// in-flight gesture — the "can't pinch on the route / course line" bug).

import { describe, expect, test } from "bun:test";
import {
  WHEEL_HOLD_MS,
  createUserGestureState,
  isMultiTouch,
  primaryButtonDown,
  touchCount,
  trackUserGestures,
  userGestureActive,
  type GestureTrackedMap,
} from "./userGesture";
import { warpToReveal } from "../info/marker";

const touches = (n: number) => ({ originalEvent: { touches: { length: n } } });
/** A MapLibre mouse event with the DOM event's live `buttons` bitmask. */
const mouse = (buttons: number) => ({ originalEvent: { buttons } });

/** A window stand-in: where a button released off the chart is heard. */
function fakeWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener(type: string, fn: (e: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn as (e: unknown) => void);
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      listeners.get(type)?.delete(fn as (e: unknown) => void);
    },
    fire(type: string, e?: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

/** Just enough of a MapLibre map to emit events at the tracker. */
function fakeMap() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const map = {
    on(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
      return map;
    },
    off(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
      return map;
    },
    fire(type: string, e?: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
  return map;
}
const asTracked = (m: ReturnType<typeof fakeMap>) => m as unknown as GestureTrackedMap;

describe("touchCount / isMultiTouch", () => {
  test("reads the live touch list; a mouse event or a missing event is 0", () => {
    expect(touchCount(touches(2))).toBe(2);
    expect(touchCount({ originalEvent: new Object() })).toBe(0);
    expect(touchCount(undefined)).toBe(0);
  });

  test("two or more fingers is a pinch; one is not", () => {
    expect(isMultiTouch(touches(1))).toBe(false);
    expect(isMultiTouch(touches(2))).toBe(true);
    expect(isMultiTouch(touches(3))).toBe(true);
    expect(isMultiTouch({})).toBe(false);
  });
});

describe("createUserGestureState", () => {
  test("fingers on the glass hold it, from the first touch until the last lifts", () => {
    const s = createUserGestureState();
    expect(s.active()).toBe(false);
    s.touch(touches(1));
    expect(s.active()).toBe(true);
    s.touch(touches(2)); // second finger: a pinch
    s.touch(touches(1)); // one lifted
    expect(s.active()).toBe(true);
    s.touch(touches(0)); // touchend of the last finger
    expect(s.active()).toBe(false);
  });

  test("a touchcancel clears it (its touch list is what is still down)", () => {
    const s = createUserGestureState();
    s.touch(touches(2));
    s.touch(touches(0));
    expect(s.active()).toBe(false);
  });

  test("a gesture-driven move (wheel zoom, inertia) holds it until moveend", () => {
    const s = createUserGestureState();
    s.movestart({ originalEvent: {} });
    expect(s.active()).toBe(true);
    s.moveend();
    expect(s.active()).toBe(false);
  });

  // MapLibre zooms on the render frame AFTER a wheel event (and after up to
  // 40 ms of wheel-vs-trackpad detection); only that frame fires movestart. A
  // follow recentre in between reset the scroll handler and the notch was
  // lost — measured: `wheel`, the recentre's easeTo 43 ms later, no zoom.
  test("a wheel event holds it BEFORE the zoom has started, then lets go by itself", () => {
    let t = 1000;
    const s = createUserGestureState(() => t);
    expect(s.active()).toBe(false);
    s.wheel();
    expect(s.active()).toBe(true); // no movestart yet
    t += WHEEL_HOLD_MS - 1;
    expect(s.active()).toBe(true);
    t += 1;
    expect(s.active()).toBe(false); // a wheel that moved nothing can't stick
    // A running zoom is held by its own movestart…moveend, as before.
    s.wheel();
    s.movestart({ originalEvent: {} });
    t += 10 * WHEEL_HOLD_MS;
    expect(s.active()).toBe(true);
    s.moveend();
    expect(s.active()).toBe(false);
  });

  // The lost notch, measured: a wheel event 39 ms before the PREVIOUS notch's
  // zoom ended. That moveend re-anchors the follow, whose recentre reset the
  // scroll handler before the new notch had a frame.
  test("a moveend does not release the wheel hold: the next notch may already be waiting", () => {
    let t = 0;
    const s = createUserGestureState(() => t);
    s.wheel();
    s.movestart(undefined);
    t += 600;
    s.wheel(); // the next notch…
    t += 39;
    s.moveend(); // …and the previous one's zoom ends
    expect(s.active()).toBe(true);
    t += WHEEL_HOLD_MS;
    expect(s.active()).toBe(false);
  });

  // "on pc when the "follow boat" button is on sometimes i cannot drag the
  // screen around": MapLibre's drag-pan is only ARMED by the press; it fires
  // no dragstart/movestart until the pointer moves, and a recentre in that
  // gap reset it. The press itself has to hold the chart.
  test("a pressed mouse button holds it BEFORE any drag has started", () => {
    const s = createUserGestureState();
    s.press(mouse(1));
    expect(s.active()).toBe(true); // no movestart yet — the gap that lost drags
    s.pointer(mouse(1)); // moving with the button down
    expect(s.active()).toBe(true);
    s.pointer(mouse(0)); // mouseup
    expect(s.active()).toBe(false);
  });

  test("a mouse drag stays held through its pan and inertia, then lets go", () => {
    const s = createUserGestureState();
    s.press(mouse(1));
    s.movestart({ originalEvent: {} }); // the pan starts
    s.pointer(mouse(0)); // button up, inertia still running
    expect(s.active()).toBe(true);
    s.moveend();
    expect(s.active()).toBe(false);
  });

  test("a lost mouseup self-corrects on the next mouse event with no button down", () => {
    const s = createUserGestureState();
    s.press(mouse(1));
    s.pointer(mouse(0)); // a plain mousemove later
    expect(s.active()).toBe(false);
  });

  test("only the primary button holds; a moving pointer never TAKES the hold", () => {
    const s = createUserGestureState();
    s.press(mouse(2)); // secondary: context menu, its mouseup may never arrive
    expect(s.active()).toBe(false);
    s.pointer(mouse(1)); // pressed on a panel, dragged across the chart
    expect(s.active()).toBe(false);
    s.press(mouse(3)); // primary + secondary
    expect(s.active()).toBe(true);
    s.release(); // window blur
    expect(s.active()).toBe(false);
  });

  test("primaryButtonDown reads a MapLibre event and a bare DOM event alike", () => {
    expect(primaryButtonDown(mouse(1))).toBe(true);
    expect(primaryButtonDown({ buttons: 1 })).toBe(true);
    expect(primaryButtonDown({ buttons: 0 })).toBe(false);
    expect(primaryButtonDown(touches(1))).toBe(false);
    expect(primaryButtonDown(undefined)).toBe(false);
  });

  test("our own background moves and programmatic go-tos are not the crew's gesture", () => {
    const s = createUserGestureState();
    s.movestart({ mivnavAuto: true, originalEvent: {} });
    expect(s.active()).toBe(false);
    s.movestart(undefined);
    expect(s.active()).toBe(false);
  });
});

describe("trackUserGestures", () => {
  test("follows the map's touch and move events; detach removes every listener", () => {
    const m = fakeMap();
    const detach = trackUserGestures(asTracked(m));
    expect(userGestureActive(m)).toBe(false);
    m.fire("touchstart", touches(1));
    expect(userGestureActive(m)).toBe(true);
    m.fire("touchstart", touches(2));
    m.fire("touchend", touches(0));
    expect(userGestureActive(m)).toBe(false);
    m.fire("movestart", { originalEvent: {} });
    expect(userGestureActive(m)).toBe(true);
    m.fire("moveend", { originalEvent: {} });
    expect(userGestureActive(m)).toBe(false);
    m.fire("touchstart", touches(1));
    m.fire("touchcancel", touches(0));
    expect(userGestureActive(m)).toBe(false);
    m.fire("wheel", {});
    expect(userGestureActive(m)).toBe(true);
    detach();
    expect(m.count()).toBe(0);
    m.fire("touchstart", touches(1));
    expect(userGestureActive(m)).toBe(false);
  });

  test("a mouse press holds the map until the button is released — on the chart, off it, or by blur", () => {
    const m = fakeMap();
    const w = fakeWindow();
    const detach = trackUserGestures(asTracked(m), w);
    m.fire("mousedown", mouse(1));
    expect(userGestureActive(m)).toBe(true);
    m.fire("mousemove", mouse(1));
    expect(userGestureActive(m)).toBe(true);
    m.fire("mouseup", mouse(0));
    expect(userGestureActive(m)).toBe(false);

    m.fire("mousedown", mouse(1));
    w.fire("mouseup", { buttons: 0 }); // released outside the canvas
    expect(userGestureActive(m)).toBe(false);

    m.fire("mousedown", mouse(1));
    w.fire("blur");
    expect(userGestureActive(m)).toBe(false);

    detach();
    expect(m.count()).toBe(0);
    expect(w.count()).toBe(0);
  });

  test("a map with no tracker is never 'gesturing' (test doubles keep old behaviour)", () => {
    expect(userGestureActive({})).toBe(false);
  });
});

describe("background camera moves stand down during a gesture", () => {
  /** A map whose projection puts every point far off screen, so the reveal
   * warp WOULD fire. */
  function warpMap() {
    const m = fakeMap();
    const eases: unknown[] = [];
    return Object.assign(m, {
      eases,
      project: () => ({ x: -1000, y: -1000 }),
      getContainer: () => ({ clientWidth: 390, clientHeight: 844 }),
      easeTo: (o: unknown) => void eases.push(o),
    });
  }

  test("warpToReveal skips while fingers are down (an easeTo would kill the pinch)", () => {
    const m = warpMap();
    trackUserGestures(asTracked(m));
    m.fire("touchstart", touches(2));
    warpToReveal(m, { lng: 10, lat: 56 }, { bottom: 0 });
    expect(m.eases).toEqual([]);
    m.fire("touchend", touches(0));
    warpToReveal(m, { lng: 10, lat: 56 }, { bottom: 0 });
    expect(m.eases).toHaveLength(1);
  });
});
