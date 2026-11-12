/**
 * region-draw — the map's two-tap-per-box rectangle drawer for the Regions
 * settings section (kolmnrsk). Asserted with no DOM and no map, the same
 * split `features/measure/measure.test.ts` uses: taps go in as lng/lat, the
 * model comes out.
 *
 * Covers the real-usage TESTED feedback this file's own header documents:
 *   1. the mode is `hidden` — registered, but not a tool-stack button;
 *   2. a session accumulates MULTIPLE boxes before "Done" ends it, rather
 *      than exiting after the first;
 *   3. `existing` boxes ride through `start` for the overlay to draw as
 *      context, and are never touched by drawing;
 *   4. "Done" fires `onDone` exactly once, with every committed box, and
 *      only when there is at least one — an empty "Done" behaves like
 *      "Cancel"; "Cancel" never fires `onDone` at all, even with boxes
 *      already committed.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createRegionDraw, rectFromCorners } from "./index";
import { createModeState, type ModeClick } from "../../core/chrome/modes";
import { createRegistry, DESK, type Feature } from "../../core/chrome/registry";
import type { BBox } from "../../core/settings/regions";

const at = (lng: number, lat: number): ModeClick => ({
  point: { x: 0, y: 0 },
  lngLat: { lng, lat },
  radius: 8,
  pick: () => [],
});

function harness() {
  return createRoot((dispose) => {
    const rd = createRegionDraw();
    const modes = createModeState(createRegistry([rd.feature.core]));
    rd.model.bindEnter(() => modes.enter("region-draw"));
    rd.model.bindExit(() => modes.leave());
    let leftCount = 0;
    rd.model.bindLeft(() => leftCount++);
    return { ...rd.model, feature: rd.feature.core, modes, dispose, leftCount: () => leftCount };
  });
}

const modeOf = (feature: Feature) => feature.modes![0]!;
const pillOf = (h: ReturnType<typeof harness>) => modeOf(h.feature).pill!({ density: DESK });
const doneAction = (h: ReturnType<typeof harness>) => pillOf(h).actions!.find((a) => a.id === "done")!;
const cancelAction = (h: ReturnType<typeof harness>) => pillOf(h).actions!.find((a) => a.id === "cancel")!;

describe("rectFromCorners", () => {
  test("normalises regardless of which corner was tapped first", () => {
    const a = rectFromCorners({ lng: 10, lat: 50 }, { lng: 12, lat: 48 });
    const b = rectFromCorners({ lng: 12, lat: 48 }, { lng: 10, lat: 50 });
    expect(a).toEqual({ minLon: 10, minLat: 48, maxLon: 12, maxLat: 50 });
    expect(b).toEqual(a);
  });
});

describe("the feature", () => {
  test("contributes exactly one mode, and it is hidden from both tool stacks", () => {
    createRoot((dispose) => {
      const { feature } = createRegionDraw();
      expect(feature.core.modes?.map((m) => m.id)).toEqual(["region-draw"]);
      expect(feature.core.modes![0]!.hidden).toBe(true);
      dispose();
    });
  });
});

describe("existing boxes (context)", () => {
  test("start seeds `existing`, drawing never mutates it", () => {
    const h = harness();
    const existing: BBox[] = [{ min_lon: 0, min_lat: 0, max_lon: 1, max_lat: 1 }];
    h.start({ existing, onDone: () => {} });
    expect(h.existing()).toEqual(existing);
    h.modes.handleClick(at(10, 10));
    h.modes.handleClick(at(11, 11));
    expect(h.existing()).toEqual(existing);
    h.dispose();
  });

  test("leaving the mode clears `existing` too, not just the in-progress draw", () => {
    const h = harness();
    h.start({ existing: [{ min_lon: 0, min_lat: 0, max_lon: 1, max_lat: 1 }], onDone: () => {} });
    h.modes.leave();
    expect(h.existing()).toEqual([]);
    h.dispose();
  });
});

describe("multi-box sessions (TESTED feedback: many boxes, one Done)", () => {
  test("a second tap COMMITS the box and stays in the mode — no exit", () => {
    const h = harness();
    let calls = 0;
    h.start({ existing: [], onDone: () => calls++ });
    h.modes.handleClick(at(10, 10));
    h.modes.handleClick(at(11, 11));
    expect(h.committed()).toEqual([{ min_lon: 10, min_lat: 10, max_lon: 11, max_lat: 11 }]);
    expect(h.modes.active()).toBe("region-draw"); // still drawing
    expect(calls).toBe(0); // onDone has not fired yet
    h.dispose();
  });

  test("drawing three boxes accumulates all three", () => {
    const h = harness();
    h.start({ existing: [], onDone: () => {} });
    h.modes.handleClick(at(0, 0));
    h.modes.handleClick(at(1, 1));
    h.modes.handleClick(at(2, 2));
    h.modes.handleClick(at(3, 3));
    h.modes.handleClick(at(4, 4));
    h.modes.handleClick(at(5, 5));
    expect(h.committed()).toHaveLength(3);
    h.dispose();
  });

  test("a degenerate second tap (same point) commits nothing and keeps the corner", () => {
    const h = harness();
    h.start({ existing: [], onDone: () => {} });
    h.modes.handleClick(at(10, 10));
    h.modes.handleClick(at(10, 10));
    expect(h.committed()).toEqual([]);
    expect(h.corner()).toEqual({ lng: 10, lat: 10 });
    h.dispose();
  });

  test("Done fires onDone exactly once, with every committed box, and leaves the mode", () => {
    const h = harness();
    let received: BBox[] | null = null;
    let calls = 0;
    h.start({
      existing: [],
      onDone: (boxes) => {
        calls++;
        received = boxes;
      },
    });
    h.modes.handleClick(at(0, 0));
    h.modes.handleClick(at(1, 1));
    h.modes.handleClick(at(2, 2));
    h.modes.handleClick(at(3, 3));
    doneAction(h).run();
    expect(calls).toBe(1);
    expect(received).toEqual([
      { min_lon: 0, min_lat: 0, max_lon: 1, max_lat: 1 },
      { min_lon: 2, min_lat: 2, max_lon: 3, max_lat: 3 },
    ]);
    expect(h.modes.active()).toBeNull();
    expect(h.leftCount()).toBe(1); // Settings reopens on every exit
    h.dispose();
  });

  test("Done with zero boxes behaves like Cancel — no onDone call", () => {
    const h = harness();
    let calls = 0;
    h.start({ existing: [], onDone: () => calls++ });
    doneAction(h).run();
    expect(calls).toBe(0);
    expect(h.modes.active()).toBeNull();
    h.dispose();
  });

  test("Cancel never fires onDone, even with boxes already committed", () => {
    const h = harness();
    let calls = 0;
    h.start({ existing: [], onDone: () => calls++ });
    h.modes.handleClick(at(0, 0));
    h.modes.handleClick(at(1, 1));
    cancelAction(h).run();
    expect(calls).toBe(0);
    expect(h.modes.active()).toBeNull();
    h.dispose();
  });

  test("a cancelled session's onDone does not leak into the next entry", () => {
    const h = harness();
    let calls = 0;
    h.start({ existing: [], onDone: () => calls++ });
    h.modes.handleClick(at(0, 0));
    h.modes.handleClick(at(1, 1));
    cancelAction(h).run();
    // Re-enter with no new `start()` call (the mode itself, not the model) —
    // the stale callback from the cancelled session must not fire.
    h.modes.enter("region-draw");
    h.modes.handleClick(at(5, 5));
    h.modes.handleClick(at(6, 6));
    doneAction(h).run();
    expect(calls).toBe(0);
    h.dispose();
  });
});
