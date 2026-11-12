/**
 * The marker on the chart: which point the panel is talking about, whether it
 * follows a thing that moves, and when the chart is allowed to move itself.
 *
 * Driven against a Map-shaped double — `InfoMarkerMap` is four methods, so
 * there is no WebGL, no DOM and no `mock.module` here (which would leak into
 * every other file in the run anyway).
 *
 * NB: needs `--conditions=browser` (the `test` script). Bare `bun test`
 * resolves solid-js's `node` export, whose createEffect never runs — the warp
 * assertions below would then pass by never happening.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal, type Accessor, type Setter } from "solid-js";
import type { ObscuredEdges } from "../chrome/Sheet";
import {
  createInfoMarker,
  EDGE_MARGIN_PX,
  isPointShown,
  visibleCentre,
  warpOffset,
  type InfoMarkerMap,
} from "./marker";
import { createInfoState, type InfoState } from "./state";
import type { InfoHit, InfoPoint, InfoProvider } from "./types";

/** Nothing covering the chart: the desktop card, and the baseline most of the
 * tests below want. */
const CLEAR: ObscuredEdges = { bottom: 0 };

/**
 * The sheet's coverage as an `ObscuredEdges` — a FIXTURE for the marker rules
 * below, a fixed fraction of the viewport height so a central point lands behind
 * the sheet, which is all these tests need. Production no longer guesses a
 * fraction: it MEASURES the sheet's real box (../chrome/Sheet.ts
 * `measureObscured`). The 0.85 default matches the old sheet ceiling, so the
 * numeric expectations below (e.g. the ~15% free strip) read the same.
 */
const sheetCover = (size: { clientHeight: number }, frac = 0.85): ObscuredEdges => ({
  bottom: size.clientHeight * frac,
});

const SIZE = { clientWidth: 800, clientHeight: 600 };

/** A phone, upright: the viewport the bug was reported on. */
const PHONE = { clientWidth: 390, clientHeight: 844 };

interface Warp {
  center: InfoPoint;
  offset: [number, number];
  duration: number;
}

/**
 * A map whose projection is a plain scale — 1 degree is 10 px, origin at the
 * container's top-left — so a screen expectation is readable as arithmetic.
 */
function fakeMap(size: { clientWidth: number; clientHeight: number } = SIZE) {
  const warps: Warp[] = [];
  let moveListener: (() => void) | undefined;
  let originLng = 0;
  const map: InfoMarkerMap = {
    project: (p) => ({ x: (p.lng - originLng) * 10, y: p.lat * 10 }),
    getContainer: () => size,
    easeTo: (o) => warps.push(o),
    on: (_type, listener) => {
      moveListener = listener;
    },
    off: () => {
      moveListener = undefined;
    },
  };
  return {
    map,
    warps,
    /** Pan the chart, as MapLibre would: the camera moved, no signal fired. */
    pan(byLng: number) {
      originLng += byLng;
      moveListener?.();
    },
    get listening() {
      return moveListener !== undefined;
    },
  };
}

/** A provider of things that do not move: located from the hit, as chart
 * objects are. */
const staticProvider: InfoProvider = {
  id: "chart",
  label: "Chart",
  queryAt: () => [],
  detail: () => ({ sections: [] }),
};

/** A provider of things that do: located live, from the id, like vessels. */
function movingProvider(positions: Accessor<Record<string, InfoPoint | undefined>>): InfoProvider {
  return {
    id: "vessels",
    label: "Vessels",
    queryAt: () => [],
    detail: () => ({ sections: [] }),
    locate: (hit) => positions()[hit.id],
  };
}

function chartHit(id: string, lngLat?: InfoPoint): InfoHit {
  return { providerId: "chart", id, priority: "aid", precision: "point", title: id, lngLat };
}

function vesselHit(id: string, lngLat?: InfoPoint): InfoHit {
  return { providerId: "vessels", id, priority: "traffic", precision: "point", title: id, lngLat };
}

function withMarker(
  body: (ctx: {
    state: InfoState;
    marker: ReturnType<typeof createInfoMarker>;
    map: ReturnType<typeof fakeMap>;
    setObscured: Setter<ObscuredEdges>;
  }) => void,
  opts: {
    providers?: readonly InfoProvider[];
    size?: { clientWidth: number; clientHeight: number };
  } = {},
) {
  const state = createInfoState();
  const map = fakeMap(opts.size);
  const [obscured, setObscured] = createSignal<ObscuredEdges>(CLEAR);
  // The body runs *outside* the root: Solid flushes the effects a root creates
  // when the root's body returns, so a body inside it would do all its work
  // before the warp effect had ever run once — and prove nothing. Out here,
  // every signal write flushes on its own, as it does in the app.
  const [marker, dispose] = createRoot((dispose) => {
    const model = createInfoMarker({
      state,
      providers: opts.providers ?? [staticProvider],
      map: map.map,
      obscured,
    });
    return [model, dispose] as const;
  });
  body({ state, marker, map, setObscured });
  dispose();
}

describe("isPointShown", () => {
  test("the middle of the chart is shown; beyond an edge is not", () => {
    expect(isPointShown({ x: 400, y: 300 }, SIZE, CLEAR)).toBe(true);
    expect(isPointShown({ x: -20, y: 300 }, SIZE, CLEAR)).toBe(false);
    expect(isPointShown({ x: 400, y: 900 }, SIZE, CLEAR)).toBe(false);
  });

  test("a sliver at the edge is not shown — the marker is drawn around its point", () => {
    expect(isPointShown({ x: 2, y: 300 }, SIZE, CLEAR)).toBe(false);
    expect(isPointShown({ x: 798, y: 300 }, SIZE, CLEAR)).toBe(false);
  });

  test("an unprojectable point is not shown rather than shown at NaN", () => {
    expect(isPointShown({ x: Number.NaN, y: 300 }, SIZE, CLEAR)).toBe(false);
  });

  test("a point behind the sheet is not shown, however central it looks", () => {
    // The bug in one assertion. Same point, same viewport; the only difference
    // is whether the thing describing it is covering it.
    const covered = sheetCover(PHONE);
    expect(isPointShown({ x: 195, y: 400 }, PHONE, CLEAR)).toBe(true);
    expect(isPointShown({ x: 195, y: 400 }, PHONE, covered)).toBe(false);
    // The strip the sheet leaves is still chart, and still shows things.
    expect(isPointShown({ x: 195, y: 60 }, PHONE, covered)).toBe(true);
  });

  test("a point under the top nav band is not shown; just below it is", () => {
    // Item 1(a): the nav-readout band across the top is now counted, so a point
    // it covers reads as hidden — the same argument as the sheet, other edge.
    const TOP = 90;
    const withBand: ObscuredEdges = { bottom: 0, top: TOP };
    expect(isPointShown({ x: 195, y: TOP - 10 }, PHONE, withBand)).toBe(false);
    // A marker's edge margin clear of the band is chart again.
    expect(isPointShown({ x: 195, y: TOP + EDGE_MARGIN_PX + 1 }, PHONE, withBand)).toBe(true);
    // Without the band, that same covered point was "shown" — the old bug.
    expect(isPointShown({ x: 195, y: TOP - 10 }, PHONE, CLEAR)).toBe(true);
  });
});

describe("visibleCentre", () => {
  test("a clear viewport centres dead middle — desktop, both edges 0", () => {
    expect(visibleCentre(SIZE, CLEAR)).toEqual({
      x: SIZE.clientWidth / 2,
      y: SIZE.clientHeight / 2,
    });
  });

  test("with a sheet the y rides up into the strip the sheet leaves", () => {
    const obscured = sheetCover(PHONE);
    const strip = PHONE.clientHeight - obscured.bottom;
    const c = visibleCentre(PHONE, obscured);
    expect(c.x).toBe(PHONE.clientWidth / 2); // no horizontal obstruction
    expect(c.y).toBeCloseTo(strip / 2, 5); // the middle of the free strip
    expect(c.y).toBeLessThan(strip); // never under the sheet
  });

  test("is the point warpOffset aims at — the two cursors share one centre", () => {
    // The whole reason it is exported: the info marker warps *to* this, MapView's
    // weather crosshair *sits at* it. They must be the same arithmetic, forever.
    const obscured = { ...sheetCover(PHONE), top: 90 };
    const c = visibleCentre(PHONE, obscured);
    const off = warpOffset(PHONE, obscured);
    expect(off).toEqual([c.x - PHONE.clientWidth / 2, c.y - PHONE.clientHeight / 2]);
    // And whatever it returns is somewhere the rule calls shown — the property
    // the crosshair relies on so a tap there does not warp.
    expect(isPointShown({ x: c.x, y: c.y }, PHONE, obscured)).toBe(true);
  });
});

describe("warpOffset", () => {
  test("dead centre on desktop — the card is in the corner", () => {
    expect(warpOffset(SIZE, CLEAR)).toEqual([0, 0]);
  });

  test("above the sheet on a phone, never under it", () => {
    const [, dy] = warpOffset(SIZE, sheetCover(SIZE));
    const y = SIZE.clientHeight / 2 + dy;
    // The sheet can take the bottom 85dvh, so anything below 15% is covered.
    expect(y).toBeLessThan(SIZE.clientHeight * 0.15);
    expect(y).toBeGreaterThan(0);
  });

  test("centres the free strip — with no top band, the middle of what the sheet leaves", () => {
    // With only the sheet obscuring (no nav band → `obscured.top` 0), the free
    // region is the strip above the sheet, and the point lands in its centre —
    // the middle of the chart the mariner can actually see, not crammed at the
    // top edge (the reported overshoot) nor down against the sheet.
    const obscured = sheetCover(PHONE);
    const strip = PHONE.clientHeight - obscured.bottom; // ~126.6px, at the top
    const [, dy] = warpOffset(PHONE, obscured);
    const y = PHONE.clientHeight / 2 + dy;
    expect(y).toBeCloseTo(strip / 2, 5); //          the centre of the free strip
    expect(y).toBeLessThan(strip); //                never under the sheet
    expect(y).toBeGreaterThan(0); //                 never off the top
    expect(isPointShown({ x: PHONE.clientWidth / 2, y }, PHONE, obscured)).toBe(true);
  });

  test("with a top band, centres BETWEEN the band and the sheet — not under either", () => {
    // Item 1's core fix: the nav-readout band across the top is now counted, so
    // the free region is band-to-sheet and the warp centres THAT. Without it the
    // point landed under the band (`obscured.top` did not exist).
    const TOP = 90;
    const obscured = { ...sheetCover(PHONE), top: TOP };
    const bottom = PHONE.clientHeight - obscured.bottom;
    const [, dy] = warpOffset(PHONE, obscured);
    const y = PHONE.clientHeight / 2 + dy;
    expect(y).toBeGreaterThan(TOP); //   below the band, not under it
    expect(y).toBeLessThan(bottom); //   above the sheet
    expect(y).toBeCloseTo((TOP + bottom) / 2, 5); // the centre of the free region
    expect(isPointShown({ x: PHONE.clientWidth / 2, y }, PHONE, obscured)).toBe(true);
  });

  test("stays above the sheet on a viewport too short to spare an edge margin", () => {
    // A split-screen phone, and a landscape one. Clamping this up to a
    // comfortable margin would put the marker back under the sheet — the one
    // thing the offset is for. Regression-guarded because it has been fixed
    // once already, in ynqvnotm's own self-review.
    for (const clientHeight of [780, 600, 400, 240, 160]) {
      const size = { clientWidth: 390, clientHeight };
      const obscured = sheetCover(size);
      const [, dy] = warpOffset(size, obscured);
      const y = clientHeight / 2 + dy;
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(clientHeight - obscured.bottom);
      // The trigger and the placement must agree at every one of these
      // heights: a warp that lands somewhere `isPointShown` calls hidden would
      // re-warp on the next selection, forever.
      expect(isPointShown({ x: size.clientWidth / 2, y }, size, obscured)).toBe(true);
    }
  });
});

describe("createInfoMarker", () => {
  test("marks the selected hit and follows the cycling", () => {
    withMarker(({ state, marker }) => {
      expect(marker.lngLat()).toBeUndefined();

      state.show([chartHit("wreck", { lng: 10, lat: 20 }), chartHit("sounding", { lng: 11, lat: 21 })]);
      expect(marker.lngLat()).toEqual({ lng: 10, lat: 20 });
      expect(marker.screen()).toEqual({ x: 100, y: 200 });

      state.next();
      expect(marker.lngLat()).toEqual({ lng: 11, lat: 21 });
      expect(marker.screen()).toEqual({ x: 110, y: 210 });

      state.select(0);
      expect(marker.lngLat()).toEqual({ lng: 10, lat: 20 });
    });
  });

  test("clears when the panel closes", () => {
    withMarker(({ state, marker }) => {
      state.show([chartHit("wreck", { lng: 10, lat: 20 })]);
      expect(marker.screen()).toBeDefined();
      state.close();
      expect(marker.lngLat()).toBeUndefined();
      expect(marker.screen()).toBeUndefined();
    });
  });

  test("a hit with no position — an area — marks nothing", () => {
    withMarker(({ state, marker }) => {
      state.show([chartHit("depth-area")]);
      expect(marker.screen()).toBeUndefined();
    });
  });

  test("re-projects as the chart is panned under it", () => {
    withMarker(({ state, marker, map }) => {
      state.show([chartHit("wreck", { lng: 10, lat: 20 })]);
      expect(marker.screen()).toEqual({ x: 100, y: 200 });
      map.pan(5);
      expect(marker.screen()).toEqual({ x: 50, y: 200 });
    });
  });

  test("does NOT listen to the camera while nothing is selected", () => {
    // The panel is closed for most of a session, and an idle info marker that
    // still reprojected on every pan/zoom frame was per-frame waste on the chart-
    // navigation path. It subscribes only while a hit is selected.
    const state = createInfoState();
    const map = fakeMap();
    const dispose = createRoot((dispose) => {
      createInfoMarker({ state, providers: [staticProvider], map: map.map, obscured: () => CLEAR });
      return dispose;
    });
    expect(map.listening).toBe(false); // nothing selected → nothing to track
    state.show([chartHit("wreck", { lng: 10, lat: 20 })]);
    expect(map.listening).toBe(true); // a selection appears → it tracks the camera
    state.close();
    expect(map.listening).toBe(false); // panel closes → it lets go again
    dispose();
  });

  test("stops listening to the map when its owner goes", () => {
    const map = fakeMap();
    const state = createInfoState();
    const dispose = createRoot((dispose) => {
      createInfoMarker({ state, providers: [staticProvider], map: map.map, obscured: () => CLEAR });
      return dispose;
    });
    // A selection is what makes it subscribe (see the idle test above); with one
    // shown, disposing the owner must remove the listener.
    state.show([chartHit("wreck", { lng: 10, lat: 20 })]);
    expect(map.listening).toBe(true);
    dispose();
    expect(map.listening).toBe(false);
  });
});

describe("createInfoMarker — a subject that moves", () => {
  test("the marker follows the ship, and is never pinned to the tap's snapshot", () => {
    const [positions, setPositions] = createSignal<Record<string, InfoPoint | undefined>>({
      "mmsi:1": { lng: 10, lat: 20 },
    });
    withMarker(
      ({ state, marker }) => {
        // The hit carries where the ship *was*, exactly as a tap builds it.
        state.show([vesselHit("mmsi:1", { lng: 10, lat: 20 })]);
        expect(marker.lngLat()).toEqual({ lng: 10, lat: 20 });

        setPositions({ "mmsi:1": { lng: 12, lat: 20 } }); // a SignalK tick
        expect(marker.lngLat()).toEqual({ lng: 12, lat: 20 });
        expect(marker.screen()).toEqual({ x: 120, y: 200 });
      },
      { providers: [movingProvider(positions)] },
    );
  });

  test("a target that stops resolving loses its marker rather than keeping a stale one", () => {
    const [positions, setPositions] = createSignal<Record<string, InfoPoint | undefined>>({
      "mmsi:1": { lng: 10, lat: 20 },
    });
    withMarker(
      ({ state, marker }) => {
        state.show([vesselHit("mmsi:1", { lng: 10, lat: 20 })]);
        expect(marker.screen()).toBeDefined();
        setPositions({}); // expired, or a positional id that moved
        // `hit.lngLat` is still sitting right there. Using it would put the
        // marker exactly where the ship provably is not.
        expect(marker.lngLat()).toBeUndefined();
        expect(marker.screen()).toBeUndefined();
      },
      { providers: [movingProvider(positions)] },
    );
  });
});

describe("createInfoMarker — the warp rule", () => {
  test("does not warp to a hit that is already on screen — a tap is one", () => {
    withMarker(({ state, map }) => {
      state.show([chartHit("wreck", { lng: 40, lat: 30 })]); // (400, 300)
      expect(map.warps).toEqual([]);
    });
  });

  test("does not warp while cycling a tap's other hits", () => {
    withMarker(({ state, map }) => {
      state.show([chartHit("a", { lng: 40, lat: 30 }), chartHit("b", { lng: 40.1, lat: 30.1 })]);
      state.next();
      state.prev();
      state.select(1);
      expect(map.warps).toEqual([]);
    });
  });

  test("a tap in the margin does warp — the rule is 'shown', and a sliver is not", () => {
    // Observed on a phone: a tap 18 px from the right edge. The marker is
    // drawn *around* its point, so leaving that one alone would answer
    // "which one?" with a half-clipped ring at the screen edge. The tap-does-
    // not-warp property is a consequence of taps being visible, not a rule of
    // its own, and this is where the two come apart.
    withMarker(({ state, map }) => {
      state.show([chartHit("edge", { lng: 79, lat: 30 })]); // (790, 300) of 800
      expect(map.warps).toHaveLength(1);
    });
  });

  test("warps to a hit that is off screen — the list/search/alarm entry point", () => {
    withMarker(({ state, map }) => {
      // No tap: a hit built from an id, for a subject nowhere near the view.
      state.show([chartHit("far", { lng: 500, lat: 30 })]);
      expect(map.warps).toHaveLength(1);
      expect(map.warps[0]?.center).toEqual({ lng: 500, lat: 30 });
      expect(map.warps[0]?.duration).toBeLessThanOrEqual(400);
    });
  });

  test("a phone warp aims above the sheet, not under it", () => {
    withMarker(({ state, map, setObscured }) => {
      const obscured = sheetCover(SIZE);
      setObscured(obscured);
      state.show([chartHit("far", { lng: 500, lat: 30 })]);
      expect(map.warps[0]?.offset[1]).toBeLessThan(0);
      expect(map.warps[0]?.offset).toEqual(warpOffset(SIZE, obscured));
    });
  });

  test("does not chase a moving target once it is open", () => {
    const [positions, setPositions] = createSignal<Record<string, InfoPoint | undefined>>({
      "mmsi:1": { lng: 40, lat: 30 },
    });
    withMarker(
      ({ state, map }) => {
        state.show([vesselHit("mmsi:1")]);
        expect(map.warps).toEqual([]);
        // It sails clean off the chart. The marker goes with it; the camera
        // does not — the mariner asked once, and moving the view is a reply to
        // being asked.
        setPositions({ "mmsi:1": { lng: 500, lat: 30 } });
        expect(map.warps).toEqual([]);
      },
      { providers: [movingProvider(positions)] },
    );
  });

  test("a hit that cannot be placed is not a reason to move the chart", () => {
    withMarker(({ state, map }) => {
      state.show([chartHit("depth-area")]);
      expect(map.warps).toEqual([]);
    });
  });
});

describe("createInfoMarker — 'shown' means shown once the sheet is open", () => {
  // The bug, verbatim: "on mobile it doesnt keep the POI in view when the info
  // drawer opens".
  //
  // The rule was right and its input was wrong. "Already shown" was asked of
  // the *pre-open* viewport, but opening the panel is what makes the sheet
  // appear — so on a phone a POI in the lower 85% was shown when the question
  // was asked and covered a frame later, and the trigger had already decided
  // not to warp. `warpOffset` aims above the sheet and never got the chance to
  // run: the whole sheet-aware half of this file was dead on the surface it was
  // written for.
  //
  // So the sheet cannot be "handled in placement, not the trigger". On a phone
  // its presence decides whether the trigger should fire at all.

  test("a phone tap on a POI the sheet is about to cover warps it clear", () => {
    withMarker(
      ({ state, map, setObscured }) => {
        setObscured(sheetCover(PHONE));
        // Dead centre of the phone's screen: as visible as a tap gets, and
        // under the sheet the moment the panel it opened is up.
        state.show([chartHit("buoy", { lng: 19.5, lat: 40 })]); // (195, 400)
        expect(map.warps).toHaveLength(1);
      },
      { size: PHONE },
    );
  });

  test("the warp lands the POI in the strip the sheet leaves, not under it", () => {
    withMarker(
      ({ state, map, setObscured }) => {
        const obscured = sheetCover(PHONE);
        setObscured(obscured);
        state.show([chartHit("buoy", { lng: 19.5, lat: 40 })]);
        // easeTo centres `center` and then shifts it by `offset`, so this is
        // where the point ends up.
        const strip = PHONE.clientHeight - obscured.bottom;
        const y = PHONE.clientHeight / 2 + map.warps[0]!.offset[1];
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(strip);
        // The centre of the free strip — not crammed at the top (the bug).
        expect(y).toBeCloseTo(strip / 2, 5);
        // And having warped, it now passes the rule that moved it — otherwise
        // the two halves disagree and the next selection warps it again.
        expect(isPointShown({ x: 195, y }, PHONE, obscured)).toBe(true);
      },
      { size: PHONE },
    );
  });

  test("a point under the top nav band warps out from under it; the band-to-sheet strip does not", () => {
    // Item 1: with the band counted, a tap the band covers is no longer "shown"
    // and earns a warp into the free region; a tap already in the strip between
    // band and sheet is shown and stays put (no auto-centre when avoidable).
    const TOP = 120;
    withMarker(
      ({ state, map, setObscured }) => {
        setObscured({ ...sheetCover(PHONE), top: TOP });
        // Under the band (y = 80 < TOP): warps clear.
        state.show([chartHit("under-band", { lng: 19.5, lat: 8 })]); // (195, 80)
        expect(map.warps).toHaveLength(1);
        const y = PHONE.clientHeight / 2 + map.warps[0]!.offset[1];
        expect(y).toBeGreaterThan(TOP); // below the band, not under it
        expect(y).toBeLessThan(PHONE.clientHeight - sheetCover(PHONE).bottom);
      },
      { size: PHONE },
    );
  });

  test("a point already in the band-to-sheet strip is not warped — no auto-centre when avoidable", () => {
    withMarker(
      ({ state, map, setObscured }) => {
        // A band up top and a sheet that leaves real room between them (a
        // partially-open sheet). A point in that clear middle is shown → no warp.
        setObscured({ top: 120, bottom: 300 });
        state.show([chartHit("clear", { lng: 19.5, lat: 40 })]); // (195, 400)
        expect(map.warps).toEqual([]);
      },
      { size: PHONE },
    );
  });

  test("desktop is unmoved: the card is in a corner, the chart's middle is clear", () => {
    // The same tap that must warp on a phone must not warp here. The surfaces
    // differ, so the answer differs — a floating card obscures nothing the
    // marker has to dodge.
    withMarker(({ state, map }) => {
      state.show([chartHit("buoy", { lng: 40, lat: 30 })]); // (400, 300)
      expect(map.warps).toEqual([]);
    });
  });
});
