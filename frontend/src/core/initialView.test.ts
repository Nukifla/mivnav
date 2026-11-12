/**
 * The opening view is a race, and every leg of it has to be pinned.
 *
 * The map loading, the catalog fetch returning and the GPS getting a fix
 * arrive in any order, seconds apart, and any of them may never arrive. So
 * these drive `createInitialView` against a Map double and assert the four
 * things that actually matter on a boat: a late fix still centres, a fix
 * never steals a camera the crew (or the info panel) has already placed, no
 * fix at all still yields a chart, and the remembered zoom survives a reload
 * without the fallback's fit trampling it.
 *
 * The double models two MapLibre behaviours the state machine depends on and
 * that no assertion here would otherwise reach: camera calls fire 'moveend'
 * synchronously and carry their `eventData` on the event, and *bearing-only*
 * or resize-driven moves fire 'moveend' too — with no originalEvent and no
 * change to centre or zoom. Take that last one away and "the north lock
 * toggled, so we may never centre on the boat" is a bug you cannot see.
 *
 * NB: needs `--conditions=browser` (see the `test` script). Bare `bun test`
 * resolves solid-js's `node` export — the SSR build, whose createEffect never
 * runs, so every reactive assertion here would pass vacuously.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot, createSignal, type Setter } from "solid-js";
import type { ChartSet } from "./catalog";
import { createInitialView, DEFAULT_ZOOM } from "./initialView";
import type { Vessel } from "./signalk";

/**
 * bun has no localStorage, and storedSignal swallows that (by design — a
 * plotter with full storage must still work). Persistence is half of this
 * feature, so it needs a real one; installed per test and torn down after,
 * because bun shares one globalThis across every test file in the run.
 */
class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

interface Camera {
  center?: [number, number];
  zoom?: number;
}

class FakeMap {
  center = { lng: 0, lat: 0 };
  zoom = 3;
  jumps: Camera[] = [];
  fits: unknown[] = [];
  private handlers: ((e: unknown) => void)[] = [];

  getCenter() {
    return this.center;
  }
  getZoom() {
    return this.zoom;
  }
  on(event: string, fn: (e: unknown) => void) {
    if (event === "moveend") this.handlers.push(fn);
    return this;
  }
  off(_event: string, fn: (e: unknown) => void) {
    this.handlers = this.handlers.filter((h) => h !== fn);
    return this;
  }

  /** MapLibre spreads a camera call's `eventData` onto the events it fires. */
  private moveEnd(eventData: object) {
    for (const fn of [...this.handlers]) fn({ ...eventData });
  }
  private apply(camera: Camera) {
    if (camera.center) this.center = { lng: camera.center[0], lat: camera.center[1] };
    if (camera.zoom !== undefined) this.zoom = camera.zoom;
  }

  jumpTo(camera: Camera, eventData: object = {}) {
    this.jumps.push(camera);
    this.apply(camera);
    this.moveEnd(eventData);
    return this;
  }
  fitBounds(bounds: unknown, _options: unknown, eventData: object = {}) {
    this.fits.push(bounds);
    const [w, s, e, n] = bounds as [number, number, number, number];
    this.apply({ center: [(w + e) / 2, (s + n) / 2], zoom: 7 });
    this.moveEnd(eventData);
    return this;
  }

  /** A pan/zoom gesture: MapLibre tags these with the DOM event behind them. */
  gesture(camera: Camera) {
    this.apply(camera);
    this.moveEnd({ originalEvent: { type: "pointerup" } });
  }
  /** Another part of the app moving the camera — the info panel's warp. */
  warp(camera: Camera) {
    this.apply(camera);
    this.moveEnd({});
  }
  /** resize(), or the north lock's setBearing(0): no tag, no camera change. */
  bearingOnlyMove() {
    this.moveEnd({});
  }
}

const CELL: ChartSet = {
  id: "US5OAKIQ",
  name: "Oakland Inner Harbor",
  bounds: [-122.4, 37.7, -122.2, 37.9],
  min_zoom: 0,
  max_zoom: 15,
  sequence: 1,
  tiles: "/charts/US5OAKIQ/{z}/{x}/{y}.mvt",
  vector_layers: [],
};
const BOAT: Vessel = { lng: 12.6, lat: 55.9 };

interface Harness {
  map: FakeMap;
  setLoaded: Setter<boolean>;
  setSets: Setter<ChartSet[]>;
  setSelf: Setter<Vessel | null>;
  dispose: () => void;
}

/** A fresh map + view, with every input signal exposed. Nothing has arrived. */
function harness(map: FakeMap = new FakeMap()): Harness {
  const [loaded, setLoaded] = createSignal(false);
  const [sets, setSets] = createSignal<ChartSet[]>([]);
  const [self, setSelf] = createSignal<Vessel | null>(null);
  const dispose = createRoot((dispose) => {
    createInitialView(map as unknown as import("maplibre-gl").Map, { loaded, sets, self });
    return dispose;
  });
  return { map, setLoaded, setSets, setSelf, dispose };
}

describe("centring on the boat", () => {
  test("a fix arriving long after the map still centres", () => {
    const h = harness();
    h.setLoaded(true);
    expect(h.map.jumps).toHaveLength(0); // no fix yet: nothing to centre on

    h.setSelf(BOAT);

    expect(h.map.jumps).toEqual([{ center: [12.6, 55.9], zoom: DEFAULT_ZOOM }]);
    h.dispose();
  });

  test("nothing moves before the map has loaded", () => {
    const h = harness();
    h.setSelf(BOAT);
    h.setSets([CELL]);

    expect(h.map.jumps).toHaveLength(0);
    expect(h.map.fits).toHaveLength(0);

    h.setLoaded(true);
    expect(h.map.jumps).toHaveLength(1);
    h.dispose();
  });

  test("the boat wins over the catalog, and the catalog is never fitted", () => {
    const h = harness();
    h.setSets([CELL]);
    h.setSelf(BOAT);

    h.setLoaded(true);

    expect(h.map.fits).toHaveLength(0);
    expect(h.map.jumps).toHaveLength(1);
    h.dispose();
  });

  test("a fix after the catalog fallback supersedes it", () => {
    const h = harness();
    h.setLoaded(true);
    h.setSets([CELL]);
    expect(h.map.fits).toHaveLength(1);

    h.setSelf(BOAT);

    expect(h.map.jumps).toEqual([{ center: [12.6, 55.9], zoom: DEFAULT_ZOOM }]);
    h.dispose();
  });

  test("centres once, not on every delta", () => {
    const h = harness();
    h.setLoaded(true);
    h.setSelf(BOAT);
    for (let i = 1; i <= 5; i++) h.setSelf({ lng: 12.6 + i / 1000, lat: 55.9 });

    expect(h.map.jumps).toHaveLength(1);
    h.dispose();
  });

  test("a fixless vessel is not a position", () => {
    const h = harness();
    h.setLoaded(true);

    h.setSelf({ lng: Number.NaN, lat: Number.NaN });

    expect(h.map.jumps).toHaveLength(0);
    h.setSelf(BOAT);
    expect(h.map.jumps).toHaveLength(1);
    h.dispose();
  });
});

describe("the camera the crew placed", () => {
  test("a fix does not steal the camera from someone who panned", () => {
    const h = harness();
    h.setLoaded(true);

    h.map.gesture({ center: [10, 54], zoom: 14 });
    h.setSelf(BOAT);

    expect(h.map.jumps).toHaveLength(0);
    expect(h.map.center).toEqual({ lng: 10, lat: 54 });
    h.dispose();
  });

  test("nor from the info panel warping to a tapped feature", () => {
    const h = harness();
    h.setLoaded(true);

    h.map.warp({ center: [10, 54] }); // no originalEvent, but not ours either
    h.setSelf(BOAT);

    expect(h.map.jumps).toHaveLength(0);
    h.dispose();
  });

  test("nor once the catalog fallback has been panned away from", () => {
    const h = harness();
    h.setLoaded(true);
    h.setSets([CELL]);

    h.map.gesture({ center: [10, 54], zoom: 14 });
    h.setSelf(BOAT);

    expect(h.map.jumps).toHaveLength(0);
    h.dispose();
  });

  test("a resize or a north-lock toggle is not the crew taking control", () => {
    const h = harness();
    h.setLoaded(true);

    h.map.bearingOnlyMove();
    h.setSelf(BOAT);

    expect(h.map.jumps).toHaveLength(1);
    h.dispose();
  });

  test("our own fit is not the crew taking control", () => {
    const h = harness();
    h.setLoaded(true);
    h.setSets([CELL]); // fires moveend, tagged as ours

    h.setSelf(BOAT);

    expect(h.map.jumps).toHaveLength(1);
    h.dispose();
  });
});

describe("remembering the zoom", () => {
  test("a zoom the crew chose survives a reload, and re-centres there", () => {
    const first = harness();
    first.setLoaded(true);
    first.setSelf(BOAT);
    first.map.gesture({ center: [12.6, 55.9], zoom: 14.5 });
    first.dispose();

    const next = harness();
    next.setLoaded(true);
    next.setSelf(BOAT);

    expect(next.map.jumps).toEqual([{ center: [12.6, 55.9], zoom: 14.5 }]);
    next.dispose();
  });

  test("the catalog fallback's fit does not overwrite the remembered zoom", () => {
    const first = harness();
    first.setLoaded(true);
    first.setSelf(BOAT);
    first.map.gesture({ center: [12.6, 55.9], zoom: 14.5 });
    first.dispose();

    // A reload with no fix: the fit lands on zoom 7, which must stay a view
    // and not become the crew's remembered choice.
    const noFix = harness();
    noFix.setLoaded(true);
    noFix.setSets([CELL]);
    expect(noFix.map.zoom).toBe(7);
    noFix.dispose();

    const withFix = harness();
    withFix.setLoaded(true);
    withFix.setSelf(BOAT);
    expect(withFix.map.jumps).toEqual([{ center: [12.6, 55.9], zoom: 14.5 }]);
    withFix.dispose();
  });

  test("the centre is deliberately not remembered", () => {
    const first = harness();
    first.setLoaded(true);
    first.map.gesture({ center: [-30, 12], zoom: 11 });
    first.dispose();

    const next = harness();
    next.setLoaded(true);
    next.setSelf(BOAT);

    // Remembering it would defeat "open centred on the boat" outright.
    expect(next.map.jumps).toEqual([{ center: [12.6, 55.9], zoom: 11 }]);
    next.dispose();
  });

  test("a corrupt stored zoom falls back to the default", () => {
    storage.setItem("mivnav.zoom", "null");
    const h = harness();
    h.setLoaded(true);

    h.setSelf(BOAT);

    expect(h.map.jumps).toEqual([{ center: [12.6, 55.9], zoom: DEFAULT_ZOOM }]);
    h.dispose();
  });

  test("panning after the boat centre leaves the remembered zoom alone", () => {
    const first = harness();
    first.setLoaded(true);
    first.map.gesture({ center: [0, 0], zoom: 16 });
    first.dispose();

    const next = harness();
    next.setLoaded(true);
    next.setSelf(BOAT); // centres at 16
    next.map.gesture({ center: [5, 5] }); // pan only: zoom untouched
    next.dispose();

    const third = harness();
    third.setLoaded(true);
    third.setSelf(BOAT);
    expect(third.map.jumps).toEqual([{ center: [12.6, 55.9], zoom: 16 }]);
    third.dispose();
  });
});
