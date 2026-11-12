/**
 * The SignalK scene push is COALESCED and DEDUPED.
 *
 * A real DevTools profile (~73 AIS targets) put 73% of scripting time under
 * `socket.onmessage → updateSignalkData`: every delta — and they arrive many
 * times a second — rebuilt the whole scene and called `setData` twice, each of
 * which makes MapLibre reparse the entire GeoJSON. `scheduleScenePush` fixes
 * that WITHOUT staling the picture, and this pins both halves:
 *
 *   - COALESCE: many pushes within one frame collapse to ONE build + push (the
 *     latest producer wins, so freshness is throttled to a frame, not lost);
 *   - DEDUPE: a produced FeatureCollection identical to the last drawn calls
 *     `setData` for neither source.
 *
 * The coalescer's frame scheduler is injected here so `frame()` fires it
 * deterministically — no dependence on an ambient `requestAnimationFrame`. This
 * is deliberately NOT routed through `signalkShips.ts` (MapView's tests mock that
 * module wholesale, and bun shares one module registry across the run), which is
 * exactly why the coalescer lives in its own module.
 *
 * NB: needs `--conditions=browser` (see the `test` script) like the rest.
 */

import { describe, expect, test } from "bun:test";
import type { FeatureCollection } from "geojson";
import {
  AIS_TARGET_THROTTLE_MS,
  invalidateScenePush,
  scheduleScenePush,
  type ScenePayload,
} from "./scenePush";

/** A GeoJSON source double that counts its `setData` calls. */
class FakeSource {
  calls = 0;
  setData() {
    this.calls++;
  }
}

/** A hand-driven frame: capture the scheduled callback, fire it on `run()`. */
function manualFrame() {
  let pending: (() => void) | null = null;
  return {
    schedule: (cb: () => void) => {
      pending = cb;
    },
    run: () => {
      const cb = pending;
      pending = null;
      cb?.();
    },
  };
}

/** A hand-driven clock: `now()` for the throttle, `advance(ms)` to move time. */
function manualClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

/** A hand-driven timer: capture the scheduled callback + delay, fire on `run()`. */
function manualTimer() {
  let pending: { cb: () => void; ms: number } | null = null;
  return {
    schedule: (cb: () => void, ms: number) => {
      pending = { cb, ms };
    },
    /** The delay of the currently-armed timer, or null if none. */
    armedMs: () => pending?.ms ?? null,
    run: () => {
      const p = pending;
      pending = null;
      p?.cb();
    },
  };
}

const fc = (features: FeatureCollection["features"]): FeatureCollection => ({
  type: "FeatureCollection",
  features,
});

const point = (lng: number, lat: number): FeatureCollection["features"][number] => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties: {},
});

/** A stand-in map — `scheduleScenePush` only uses it as a WeakMap key. */
const fakeMap = () => ({}) as unknown as import("maplibre-gl").Map;

describe("scheduleScenePush coalesces per frame", () => {
  test("many pushes within one frame collapse to a single build + push", () => {
    const map = fakeMap();
    const frame = manualFrame();
    const own = new FakeSource();
    const tgt = new FakeSource();
    let builds = 0;
    const produce = (): ScenePayload => {
      builds++;
      return { own, tgt, ownData: fc([point(12.6, 55.9)]), tgtData: fc([point(12.7, 56)]) };
    };

    // Ten deltas arrive back-to-back (one frame of a busy AIS picture).
    for (let i = 0; i < 10; i++) scheduleScenePush(map, produce, frame.schedule);

    // Nothing built or pushed yet — the work is deferred, not run ten times.
    expect(builds).toBe(0);
    expect(own.calls + tgt.calls).toBe(0);

    frame.run();

    // One build, one push per source — regardless of how many deltas landed.
    expect(builds).toBe(1);
    expect(own.calls).toBe(1);
    expect(tgt.calls).toBe(1);
  });

  test("the LATEST producer within the frame is the one run (freshness kept)", () => {
    const map = fakeMap();
    const frame = manualFrame();
    const own = new FakeSource();
    const tgt = new FakeSource();
    const seen: number[] = [];
    const at = (lat: number) => () =>
      ({ own, tgt, ownData: fc([point(12.6, lat)]), tgtData: fc([]) }) as ScenePayload;

    scheduleScenePush(map, () => (seen.push(1), at(55.9)()), frame.schedule);
    scheduleScenePush(map, () => (seen.push(2), at(56.0)()), frame.schedule);
    scheduleScenePush(map, () => (seen.push(3), at(56.1)()), frame.schedule);
    frame.run();

    // Only the last producer ran — the superseded earlier deltas were never built.
    expect(seen).toEqual([3]);
    expect(own.calls).toBe(1);
  });
});

describe("scheduleScenePush dedups an unchanged scene", () => {
  test("a push identical to the last drawn calls setData for neither source", () => {
    const map = fakeMap();
    const frame = manualFrame();
    const own = new FakeSource();
    const tgt = new FakeSource();
    const same = (): ScenePayload => ({
      own,
      tgt,
      ownData: fc([point(12.6, 55.9)]),
      tgtData: fc([point(12.7, 56)]),
    });

    scheduleScenePush(map, same, frame.schedule);
    frame.run();
    expect(own.calls).toBe(1);
    expect(tgt.calls).toBe(1);

    // The same scene again — MapLibre must reparse nothing.
    scheduleScenePush(map, same, frame.schedule);
    frame.run();
    expect(own.calls).toBe(1);
    expect(tgt.calls).toBe(1);
  });

  test("only the collection that changed is re-pushed", () => {
    const map = fakeMap();
    const frame = manualFrame();
    const clock = manualClock();
    const timer = manualTimer();
    const own = new FakeSource();
    const tgt = new FakeSource();
    const ownData = fc([point(12.6, 55.9)]); // own ship never moves here

    scheduleScenePush(
      map,
      () => ({ own, tgt, ownData, tgtData: fc([point(12.7, 56.0)]) }),
      frame.schedule,
      clock.now,
      timer.schedule,
    );
    frame.run();
    expect(own.calls).toBe(1);
    expect(tgt.calls).toBe(1);

    // Past the throttle window so the second target move flushes on its own
    // leading edge (the throttle itself is covered by its own tests below).
    clock.advance(AIS_TARGET_THROTTLE_MS);

    // Move only a target: targets change, own ship does not.
    scheduleScenePush(
      map,
      () => ({ own, tgt, ownData, tgtData: fc([point(12.7, 56.3)]) }),
      frame.schedule,
      clock.now,
      timer.schedule,
    );
    frame.run();
    expect(tgt.calls).toBe(2);
    expect(own.calls).toBe(1); // own ship unchanged → not re-pushed
  });

  test("the CPA source is deduped independently — an own-ship-only move skips the big target push", () => {
    // The follow-up win: the CPA figure moves every own-ship (GPS) fix, but the
    // ~73-feature target source moves only at AIS rate. Split into its own
    // source, an own-ship-only tick re-pushes ONLY the small cpa source while the
    // big tgt source (and own) dedup-skip — so MapLibre reparses a handful of
    // features, not 73.
    const map = fakeMap();
    const frame = manualFrame();
    const own = new FakeSource();
    const tgt = new FakeSource();
    const cpa = new FakeSource();
    const ownData = fc([point(12.6, 55.9)]);
    const tgtData = fc([point(12.7, 56.0)]);

    scheduleScenePush(
      map,
      () => ({ own, tgt, cpa, ownData, tgtData, cpaData: fc([point(12.65, 55.95)]) }),
      frame.schedule,
    );
    frame.run();
    expect(own.calls).toBe(1);
    expect(tgt.calls).toBe(1);
    expect(cpa.calls).toBe(1);

    // Own ship moved a hair (own re-pushes) and the CPA figure moved with it —
    // but no target moved, so the big target source must NOT be re-pushed.
    scheduleScenePush(
      map,
      () => ({
        own,
        tgt,
        cpa,
        ownData: fc([point(12.6001, 55.9001)]),
        tgtData,
        cpaData: fc([point(12.6502, 55.9502)]),
      }),
      frame.schedule,
    );
    frame.run();
    expect(cpa.calls).toBe(2); // the CPA figure re-pushed
    expect(own.calls).toBe(2); // own ship re-pushed
    expect(tgt.calls).toBe(1); // the 73-feature source did NOT — the whole point
  });

  test("an unchanged CPA figure is not re-pushed either", () => {
    const map = fakeMap();
    const frame = manualFrame();
    const own = new FakeSource();
    const tgt = new FakeSource();
    const cpa = new FakeSource();
    const same = (): ScenePayload => ({
      own,
      tgt,
      cpa,
      ownData: fc([point(12.6, 55.9)]),
      tgtData: fc([point(12.7, 56)]),
      cpaData: fc([point(12.65, 55.95)]),
    });

    scheduleScenePush(map, same, frame.schedule);
    frame.run();
    expect(cpa.calls).toBe(1);

    scheduleScenePush(map, same, frame.schedule);
    frame.run();
    expect(cpa.calls).toBe(1); // identical → reparses nothing
  });

  test("invalidateScenePush forces a refill even when the content is unchanged", () => {
    // A style reload re-creates the sources EMPTY; the next push must refill them
    // even though nothing moved, or the vessels vanish until one next moves.
    const map = fakeMap();
    const frame = manualFrame();
    const own = new FakeSource();
    const tgt = new FakeSource();
    const same = (): ScenePayload => ({
      own,
      tgt,
      ownData: fc([point(12.6, 55.9)]),
      tgtData: fc([point(12.7, 56)]),
    });

    scheduleScenePush(map, same, frame.schedule);
    frame.run();
    expect(own.calls).toBe(1);

    invalidateScenePush(map); // the source was just emptied by a style reload

    scheduleScenePush(map, same, frame.schedule);
    frame.run();
    expect(own.calls).toBe(2); // refilled despite identical content
    expect(tgt.calls).toBe(2);
  });
});

describe("scheduleScenePush throttles the big target source", () => {
  test("target moves within the interval collapse to one setData; a trailing push flushes the LATEST after the interval", () => {
    // 73 targets keep broadcasting, so left alone the target `setData` fires
    // every frame and the render loop never settles. The target source is capped
    // to one push per interval: moves inside the window are held, and a single
    // trailing timer flushes the freshest snapshot at the boundary.
    const map = fakeMap();
    const frame = manualFrame();
    const clock = manualClock();
    const timer = manualTimer();
    const own = new FakeSource();
    const tgt = new FakeSource();
    const lastDrawn: FeatureCollection[] = [];
    const drawTgt = new (class {
      setData(d: FeatureCollection) {
        tgt.setData();
        lastDrawn.push(d);
      }
    })();
    const at = (lat: number) => () =>
      ({
        own,
        tgt: drawTgt,
        ownData: fc([point(12.6, 55.9)]),
        tgtData: fc([point(12.7, lat)]),
      }) as ScenePayload;

    // Leading edge at t=0: the first move draws immediately.
    scheduleScenePush(map, at(56.0), frame.schedule, clock.now, timer.schedule);
    frame.run();
    expect(tgt.calls).toBe(1);

    // Two more moves inside the window — neither draws; ONE trailing timer arms.
    clock.set(100);
    scheduleScenePush(map, at(56.1), frame.schedule, clock.now, timer.schedule);
    frame.run();
    clock.set(150);
    scheduleScenePush(map, at(56.2), frame.schedule, clock.now, timer.schedule);
    frame.run();
    expect(tgt.calls).toBe(1); // still one — the moves were coalesced + held
    expect(timer.armedMs()).toBe(AIS_TARGET_THROTTLE_MS - 100); // armed at the boundary

    // The interval elapses and the trailing timer fires: the LATEST snapshot
    // (56.2, not 56.1) is what gets drawn.
    clock.set(AIS_TARGET_THROTTLE_MS);
    timer.run();
    expect(tgt.calls).toBe(2);
    expect(lastDrawn.at(-1)).toEqual(fc([point(12.7, 56.2)]));
  });

  test("own ship stays per-frame live while the target source is throttled", () => {
    // Own/CPA are tiny and must not lag: they push every frame even while the
    // big target source is held inside the throttle window.
    const map = fakeMap();
    const frame = manualFrame();
    const clock = manualClock();
    const timer = manualTimer();
    const own = new FakeSource();
    const tgt = new FakeSource();
    const scene = (ownLat: number, tgtLat: number) => () =>
      ({
        own,
        tgt,
        ownData: fc([point(12.6, ownLat)]),
        tgtData: fc([point(12.7, tgtLat)]),
      }) as ScenePayload;

    scheduleScenePush(map, scene(55.9, 56.0), frame.schedule, clock.now, timer.schedule);
    frame.run();
    expect(own.calls).toBe(1);
    expect(tgt.calls).toBe(1);

    // Inside the window: own ship AND a target both move.
    clock.set(50);
    scheduleScenePush(map, scene(55.95, 56.05), frame.schedule, clock.now, timer.schedule);
    frame.run();
    expect(own.calls).toBe(2); // own ship pushed live
    expect(tgt.calls).toBe(1); // target held by the throttle
  });

  test("a move after the interval draws on its own leading edge — no trailing timer needed", () => {
    const map = fakeMap();
    const frame = manualFrame();
    const clock = manualClock();
    const timer = manualTimer();
    const own = new FakeSource();
    const tgt = new FakeSource();
    const at = (lat: number) => () =>
      ({
        own,
        tgt,
        ownData: fc([point(12.6, 55.9)]),
        tgtData: fc([point(12.7, lat)]),
      }) as ScenePayload;

    scheduleScenePush(map, at(56.0), frame.schedule, clock.now, timer.schedule);
    frame.run();
    expect(tgt.calls).toBe(1);

    clock.set(AIS_TARGET_THROTTLE_MS + 10); // window already elapsed
    scheduleScenePush(map, at(56.1), frame.schedule, clock.now, timer.schedule);
    frame.run();
    expect(tgt.calls).toBe(2); // leading edge, drawn at once
    expect(timer.armedMs()).toBeNull(); // no trailing timer armed
  });
});
