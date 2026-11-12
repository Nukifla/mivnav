// The route editor's stop drag (`attachRouteDragging`) against the map-gesture
// policy (docs/architecture/map-gesture-policy.md): it may capture a ONE-finger
// drag, only in the editor and only on a stop's handle; 2+ fingers is always
// MapLibre's pinch; a second finger mid-drag cancels the edit cleanly; and
// outside an armed drag it never touches dragPan or the cursor.

import { describe, expect, test } from "bun:test";
import type { Map as MLMap } from "maplibre-gl";
import type { Route } from "../../core/routes";
import type { GeoPoint } from "../../core/chrome/geo";
import { attachRouteDragging } from "./overlay";
import { ROUTE_WAYPOINTS_LAYER } from "./layers";

/** One stop handle, at screen (100, 100). */
const STOP = { x: 100, y: 100 };

function setup(opts: { editing?: boolean } = {}) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const calls: string[] = [];
  const canvas = { style: { cursor: "" } };
  const map = {
    on(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    off(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    getLayer: (id: string) => (id === ROUTE_WAYPOINTS_LAYER ? {} : undefined),
    queryRenderedFeatures: (box: [[number, number], [number, number]]) => {
      const [[x0, y0], [x1, y1]] = box;
      return STOP.x >= x0 && STOP.x <= x1 && STOP.y >= y0 && STOP.y <= y1 ? [{ properties: { id: "wp1" } }] : [];
    },
    dragPan: {
      enabled: true,
      enable() {
        calls.push("dragPan.enable");
        this.enabled = true;
      },
      disable() {
        calls.push("dragPan.disable");
        this.enabled = false;
      },
    },
    getCanvas: () => canvas,
  };
  const route: Route = {
    id: "r",
    name: "r",
    plan_speed_kn: 5,
    rev: 1,
    updated: 0,
    waypoints: [{ id: "wp1", name: "1", lat: 56, lon: 10, stop: true }],
  };
  const model = {
    editing: () => opts.editing ?? true,
    route: () => route,
    moveWaypoint: (id: string, p: GeoPoint) => void calls.push(`move ${id} ${p.lng},${p.lat}`),
    beginWaypointDrag: (id: string) => void calls.push(`begin ${id}`),
    endWaypointDrag: () => void calls.push("end"),
    abortDrag: (id: string, p: GeoPoint) => void calls.push(`abort ${id} ${p.lng},${p.lat}`),
  };
  const detach = attachRouteDragging(map as unknown as MLMap, model);

  const fire = (type: string, at: { x: number; y: number }, fingers: number) => {
    let prevented = false;
    const e = {
      point: at,
      lngLat: { lng: at.x / 10, lat: at.y / 10 },
      originalEvent: { touches: { length: fingers } },
      preventDefault: () => (prevented = true),
    };
    for (const fn of listeners.get(type) ?? []) fn(e);
    return prevented;
  };
  return { map, calls, canvas, fire, detach, listeners };
}

describe("attachRouteDragging — the gesture policy", () => {
  test("outside the editor a touch on a stop/line is the map's: no arm, no dragPan change, no preventDefault", () => {
    const { calls, fire, map } = setup({ editing: false });
    expect(fire("touchstart", STOP, 1)).toBe(false);
    fire("touchmove", { x: 100, y: 160 }, 1);
    fire("touchend", { x: 100, y: 160 }, 0);
    expect(calls).toEqual([]);
    expect(map.dragPan.enabled).toBe(true);
  });

  test("a pinch (2 fingers) outside an armed drag touches nothing — not dragPan, not the cursor", () => {
    const { calls, fire, canvas } = setup({ editing: false });
    fire("touchstart", STOP, 1);
    fire("touchstart", STOP, 2);
    fire("touchmove", { x: 100, y: 140 }, 2);
    fire("touchend", STOP, 0);
    expect(calls).toEqual([]);
    expect(canvas.style.cursor).toBe("");
  });

  test("in the editor, a one-finger touch on the LINE (no stop under it) pans the map", () => {
    const { calls, fire, map } = setup();
    expect(fire("touchstart", { x: 300, y: 100 }, 1)).toBe(false);
    fire("touchmove", { x: 300, y: 160 }, 1);
    expect(calls).toEqual([]);
    expect(map.dragPan.enabled).toBe(true);
  });

  test("in the editor, a one-finger drag on a stop's handle drags that stop and never preventDefaults", () => {
    const { calls, fire, map } = setup();
    expect(fire("touchstart", STOP, 1)).toBe(false);
    expect(map.dragPan.enabled).toBe(false); // the handle owns this one-finger drag
    fire("touchmove", { x: 100, y: 130 }, 1);
    fire("touchend", { x: 100, y: 130 }, 0);
    expect(calls).toEqual(["dragPan.disable", "begin wp1", "move wp1 10,13", "end", "dragPan.enable"]);
    expect(map.dragPan.enabled).toBe(true);
  });

  test("a second finger mid-drag cancels the edit (stop restored, nothing committed) and hands over to the pinch", () => {
    const { calls, fire, map } = setup();
    fire("touchstart", STOP, 1);
    fire("touchmove", { x: 100, y: 130 }, 1);
    fire("touchstart", { x: 200, y: 200 }, 2);
    expect(calls).toEqual(["dragPan.disable", "begin wp1", "move wp1 10,13", "abort wp1 10,56", "dragPan.enable"]);
    expect(map.dragPan.enabled).toBe(true);
    // The rest of the pinch moves no stop, and its lift commits nothing.
    fire("touchmove", { x: 100, y: 160 }, 2);
    fire("touchend", { x: 100, y: 160 }, 1);
    fire("touchmove", { x: 100, y: 190 }, 1);
    fire("touchend", { x: 100, y: 190 }, 0);
    expect(calls).toHaveLength(5);
  });

  test("a second finger before the drag slop: no edit at all, pinch proceeds", () => {
    const { calls, fire, map } = setup();
    fire("touchstart", STOP, 1);
    fire("touchstart", { x: 200, y: 200 }, 2);
    expect(calls).toEqual(["dragPan.disable", "dragPan.enable"]);
    expect(map.dragPan.enabled).toBe(true);
  });

  test("both fingers landing together on a stop is a pinch, never an arm", () => {
    const { calls, fire } = setup();
    fire("touchstart", STOP, 2);
    fire("touchmove", { x: 100, y: 160 }, 2);
    expect(calls).toEqual([]);
  });

  test("a cancelled touch mid-drag aborts it and restores dragPan (never stuck disabled)", () => {
    const { calls, fire, map } = setup();
    fire("touchstart", STOP, 1);
    fire("touchmove", { x: 100, y: 130 }, 1);
    fire("touchcancel", { x: 100, y: 130 }, 0);
    expect(calls.slice(-2)).toEqual(["abort wp1 10,56", "dragPan.enable"]);
    expect(map.dragPan.enabled).toBe(true);
  });

  test("detach removes every listener, touchcancel included", () => {
    const { detach, listeners } = setup();
    detach();
    expect([...listeners.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
  });
});
