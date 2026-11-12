/**
 * Regression test for the rubber-band-never-paints bug: the pill's numbers
 * recomputed live from the model while the map source silently never got a
 * second `setData` call after the first snapshot. Root cause, found with a
 * real browser (playwright against a dev server, not guessed from the source):
 * `updateMeasureData` used to check `map.getSource(SOURCE)` and `return` BEFORE
 * reading `model.a()`/`b()`/`leg()`. It runs inside `wireOverlays`'s per-overlay
 * `createEffect` (`core/layers/overlay.ts`), which tracks exactly what a run
 * reads. `MapView.wireMap`'s `map.on("load", …)` handler calls `setLoaded(true)`
 * and THEN `ensureOverlays()` (which adds the source) on the next line, and in
 * a real browser a plain Solid signal write reruns its subscribers
 * SYNCHRONOUSLY — before that next line runs. So this effect's first live run
 * lands in the gap where `loaded()` is already true but the source has not
 * been added yet: with the guard first, that run returned before touching the
 * model, so Solid recorded the dependency set as `{loaded}` and nothing else —
 * and since `loaded` never flips again, the effect was reactively dead for the
 * session. `ensureOverlays`'s own UNTRACKED `update()` call (right after it
 * adds the source) papered over this with one static snapshot, which is
 * exactly why the boat's ring painted once and then never moved again.
 *
 * This test reproduces that exact race with a fake map whose source is absent
 * on the effect's first live run, then drives a real `MeasureModel` (via
 * `createMeasure`, the same harness `measure.test.ts` uses) through a hover
 * change and asserts the source actually receives a second, live `setData`.
 * Each step is separated by a microtask tick (`await Promise.resolve()`) —
 * this test's `bun test` environment defers `createEffect`'s runs to the
 * microtask queue rather than running them synchronously on the signal write
 * (unlike a real browser's Solid, observed directly via Chrome devtools during
 * the investigation), so a tick is what stands in for "the next task" here.
 * What both share, and what this test actually pins, is the race itself: does
 * the effect's first live run see the source before or after it exists, and
 * does a later, independent model change still reach a source added late.
 *
 * NB: needs `--conditions=browser` (`bun run test`) — see `measure.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { createEffect, createRoot, createSignal } from "solid-js";
import type { Map as MLMap } from "maplibre-gl";
import type { SignalKState, Vessel } from "../../core/signalk";
import { createMeasure } from "./index";
import { updateMeasureData } from "./overlay";

const BOAT: Vessel = { lng: 12.6, lat: 55.9, sogMs: 3 };

function fakeSignalK(): SignalKState {
  return { self: () => BOAT, targets: () => [], status: () => "connected", autopilot: () => null };
}

/** A map whose "measure" source starts ABSENT and is installed later, on
 * demand — the exact shape of the real race (`ensureOverlays` adds the source
 * strictly after `setLoaded(true)` has already re-run every subscriber). */
function fakeMap() {
  let installed = false;
  const setDataCalls: GeoJSON.FeatureCollection[] = [];
  const source = { setData: (d: GeoJSON.FeatureCollection) => setDataCalls.push(d) };
  const map = {
    getSource: (id: string) => (id === "measure" && installed ? source : undefined),
  };
  return {
    map: map as unknown as MLMap,
    install: () => (installed = true),
    setDataCalls,
    lastKinds: () => setDataCalls.at(-1)?.features.map((f) => f.properties!.kind as string) ?? [],
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("outside the mode", () => {
  test("no ring on the boat: `From boat` draws nothing until measure is entered", () => {
    const { map, install, setDataCalls, lastKinds } = fakeMap();
    install();
    const { model, feature } = createMeasure(fakeSignalK());
    const mode = feature.core.modes![0]!;
    updateMeasureData(map, model);
    expect(lastKinds()).toEqual([]);
    mode.enter!();
    updateMeasureData(map, model);
    expect(lastKinds()).toEqual(["end"]);
    mode.leave!();
    updateMeasureData(map, model);
    expect(lastKinds()).toEqual([]);
    expect(setDataCalls.length).toBe(3);
  });
});

describe("the update effect survives the source-not-installed-yet race", () => {
  test("a hover after the late install still reaches the source (regression: it used to go silent forever)", async () => {
    const { map, install, setDataCalls, lastKinds } = fakeMap();
    const { model, feature } = createMeasure(fakeSignalK());
    feature.core.modes![0]!.enter!(); // measuring: nothing is drawn outside the mode
    const [loaded, setLoaded] = createSignal(false);
    let dispose: () => void = () => {};

    createRoot((d) => {
      dispose = d;
      // The exact wiring `wireOverlays` (core/layers/overlay.ts) sets up for
      // every overlay's `update`.
      createEffect(() => {
        if (loaded()) updateMeasureData(map, model);
      });
    });

    // `map.on("load", () => { setLoaded(true); ensureOverlays(); })` — the
    // source is deliberately still uninstalled when this first live run
    // happens.
    setLoaded(true);
    await tick();
    expect(setDataCalls.length).toBe(0); // no source yet — nothing pushed

    // `ensureOverlays()` now adds the source.
    install();

    // The live rubber-band: a hover with no tap, `From boat` still on by
    // default, so this alone produces a leg.
    model.hover({ lng: 12.6, lat: 56.0 });
    await tick();

    // The bug: with the guard-before-read order, the effect's only-ever
    // "live" run (the `setLoaded(true)` above) never touched `a`/`b`/`leg`,
    // so it was never subscribed to them — this hover would reach nobody and
    // `setDataCalls` would stay empty forever.
    expect(setDataCalls.length).toBeGreaterThan(0);
    // And it is the real leg, not a stale/partial push: both ends, the leg
    // line, and its label.
    expect(lastKinds().sort()).toEqual(["end", "end", "label", "leg"]);

    dispose();
  });
});
