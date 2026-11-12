/**
 * Regression: the boat/AIS symbols flashed on every SignalK delta.
 *
 * The defect was never in signalk.ts or signalkShips.ts — both are correct
 * in isolation. It lived entirely in MapView's reactive wiring: MapLibre
 * fires 'style.load' *synchronously* from inside setStyle(diff), so the
 * overlay-installer ran inside the style effect's tracking scope and its
 * reads of signalk.self()/targets() subscribed that effect to the SignalK
 * tick. Every delta then re-ran setStyle with a byte-identical style, whose
 * diff removed and re-added the signalk sources — and a re-added GeoJSON
 * source fades its symbols in from zero opacity.
 *
 * So this drives wireMap() against a Map double whose setStyle reproduces
 * the synchronous 'style.load', and asserts the style effect does not
 * subscribe to the tick. A test in signalk.ts would be tautological.
 *
 * NB: needs `--conditions=browser` (see the `test` script). Bare `bun test`
 * resolves solid-js's `node` export — the SSR build, whose createEffect
 * never runs, so every reactive assertion here would pass vacuously.
 */

import { describe, expect, mock, test } from "bun:test";
import { createRoot, createSignal, type Accessor } from "solid-js";
import type { ChartSet } from "./core/catalog";
import type { SignalKState, Vessel } from "./core/signalk";
import { DEFAULT_COLLISION_SETTINGS } from "./core/collisionSettings";
import { vesselsFromSignalK } from "./core/info/vessel";
import { DEFAULT_SETTINGS, type ChartSettings } from "./core/style/settings";
import { createFollowMoveGate, followMayRecentre } from "./core/followGate";

// chartStyle reads `location.origin` for the tile URLs
(globalThis as { location?: unknown }).location = { origin: "http://localhost" };

// MapView's module graph reaches WebGL and canvas; none of that is under test
// here, and the mocks keep the seam at MapView's own reads. Only modules that
// no other test file reaches are mocked — bun shares one module registry
// across the whole run, so mocking e.g. chartStyle (or chartProtocol, which
// chartStyle imports) leaks into chartStyle.test.ts and breaks it.
mock.module("maplibre-gl", () => ({
  default: { Map: class {}, NavigationControl: class {}, AttributionControl: class {} },
}));
mock.module("./features/sector-lights/overlay", () => ({
  SECTOR_LIGHTS_LAYER_ID: "sector-lights",
  SectorLightLayer: class {
    id = "sector-lights";
    visible: boolean | undefined;
    setVisible(v: boolean) {
      this.visible = v;
    }
    scheduleRefresh() {}
  },
  // The overlay factory is pure, but it lives in the same module as the WebGL
  // class this mock replaces, so reproduce it here. `z: -5` is `Z.sectorLights`
  // (../layers/overlay) — NEGATIVE, so the arcs opt out of the safety hoist and
  // are seated on the "Aids & lights" ENC group instead (`seatSectorLights` in
  // MapView). The constant cannot be referenced from this factory because the
  // mock runs before the test's `import` of it resolves; keep the two in step.
  createSectorLightsOverlay: (layer: { setVisible(v: boolean): void }) => ({
    id: "sector-lights",
    layerIds: ["sector-lights"],
    z: -5,
    ensure() {},
    update(_map: unknown, ctx: { settings(): { showLights: boolean } }) {
      layer.setVisible(ctx.settings().showLights);
    },
  }),
}));

const ensureSignalkLayers = mock(() => {});
const updateSignalkData = mock((_map: unknown, _self: Vessel | null, _targets: Vessel[]) => {});
mock.module("./core/layers/signalkShips", () => ({
  // Two ids so the target-vs-own-ship SPLIT is observable: a target that must
  // drop BELOW route/measure, and own-ship (last) that must stay topmost.
  SIGNALK_LAYER_IDS: ["signalk-targets", "signalk-own-ship"],
  OWN_SHIP_LAYER_ID: "signalk-own-ship",
  ensureSignalkLayers,
  updateSignalkData,
}));

const { wireMap, followFrame } = await import("./MapView");
// After the mocks, like wireMap: these reach ./signalk and ./cpa only, but
// import order is the whole reason this file is arranged the way it is.
const { createCursor } = await import("./core/chrome/cursor");
const { createMeasure } = await import("./features/measure");
const { createModeState } = await import("./core/chrome/modes");
const { createRegistry } = await import("./core/chrome/registry");
const { MEASURE_LAYER_IDS, createMeasureOverlay } = await import("./features/measure/overlay");
const { ROUTE_LAYER_IDS, createRouteOverlay } = await import("./features/route/overlay");
const { WEATHER_LAYER_IDS, createWeatherOverlay } = await import("./features/weather/overlay");
const { aisOverlay, ownShipOverlay, hoistOrder } = await import("./core/layers/overlay");
const { SectorLightLayer, createSectorLightsOverlay } = await import("./features/sector-lights");
const { TRACK_LAYER_IDS, createTrackOverlay } = await import("./features/track/overlay");
const { NOTICES_LAYER_IDS, createNoticesOverlay } = await import("./features/notices/overlay");

/** `arg` for the pointer handlers, which take a MapMouseEvent; the style/load
 * hooks take nothing and ignore it. */
type Handler = (arg?: never) => void;

/**
 * The load-bearing half of the double: `setStyle` fires 'style.load'
 * synchronously, exactly as MapLibre's Style.setState does. Take that away
 * and the bug cannot reproduce.
 */
class FakeMap {
  setStyleCalls: unknown[] = [];
  moved: string[] = [];
  // North-up enforcement: the three rotation interactions `wireMap` switches
  // off, each tracked separately so a test can prove all three were disabled.
  dragRotateDisabled = false;
  touchRotateDisabled = false;
  keyboardRotateDisabled = false;
  dragRotate = {
    disable: () => {
      this.dragRotateDisabled = true;
    },
  };
  touchZoomRotate = {
    disableRotation: () => {
      this.touchRotateDisabled = true;
    },
  };
  // MapLibre's whole keyboard handler is switched off (arrow pan / +/- zoom
  // are core/map/keyNav.ts), which is also what removes Shift-arrow rotation.
  keyboard = {
    disable: () => {
      this.keyboardRotateDisabled = true;
    },
  };
  private handlers = new Map<string, Handler[]>();

  on(event: string, fn: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  off(event: string, fn: Handler) {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== fn));
    return this;
  }
  fire(event: string, arg?: unknown) {
    for (const fn of this.handlers.get(event) ?? []) fn(arg as never);
  }
  setStyle(style: unknown) {
    this.setStyleCalls.push(style);
    this.fire("style.load");
    return this;
  }
  // Every layer resolves as present, sector-lights included: it is a real layer
  // on the map, and `seatSectorLights` (MapView) guards on `getLayer`, so a
  // double that reported it absent would make the whole seating pass invisible.
  getLayer(id: string) {
    return { id };
  }
  // Style layers with group metadata, so the generic reorder pass's ENC-group
  // resolver (`encGroupLayerIds`) has something to bucket, and the sector-lights
  // seating (which reads the LIVE stack order off `getStyle`) has an "aids" block
  // and a layer above it to seat against. Independent of setStyle here — the
  // reorder test drives the group ids directly.
  styleLayers: { id: string; metadata?: Record<string, unknown> }[] = [
    { id: "chart-dk-depare", metadata: { "mivnav:group": "fills" } },
    { id: "chart-dk-soundg", metadata: { "mivnav:group": "soundings" } },
    { id: "chart-dk-aton", metadata: { "mivnav:group": "aids" } },
    { id: "openseamap" },
  ];
  getStyle() {
    return { layers: this.styleLayers };
  }
  /** Every layer id `wireMap` added, in order — so a test can assert a layer was
   * actually CREATED, not merely that nothing threw. */
  addedLayerIds: string[] = [];
  addLayer(spec?: { id?: string }) {
    if (spec?.id) this.addedLayerIds.push(spec.id);
    return this;
  }
  /** `moved` keeps the ids alone (the hoist order most tests assert on);
   * `movedBefore` keeps the (id, beforeId) pairs, which is the only way to see
   * WHERE a layer was seated rather than merely that it was touched. */
  movedBefore: [string, string | undefined][] = [];
  moveLayer(id: string, before?: string) {
    this.moved.push(id);
    this.movedBefore.push([id, before]);
    return this;
  }
  // layers/route.ts's applyRoutePaint sets paint on the (present) overlay
  // layers; getLayer above reports them present, so this must exist. A no-op —
  // the palette/density paint values are exercised in the browser, not here.
  setPaintProperty() {
    return this;
  }
  // layers/route.ts also sets LAYOUT properties (the direction chevron's
  // `icon-image`/`icon-size`, which are layout, not paint) and registers the
  // per-palette chevron images. No-ops here for the same reason as the paint
  // stub — the icon bakes and their placement are a browser concern, exercised
  // there, not in this re-hoist test. `hasImage` returns true so the guarded
  // `addImage` is skipped.
  setLayoutProperty() {
    return this;
  }
  hasImage() {
    return true;
  }
  addImage() {
    return this;
  }
  // …and `hasImage` returning true is also what sends the NODATA03 pattern's
  // palette effect (core/style/nodataPattern.ts) down its re-ink path on every
  // theme change, so the double needs this too. Same reasoning: the tile's
  // pixels are pinned in nodataPattern.test.ts, not here.
  updateImage() {
    return this;
  }
  // Source surface for layers/measure.ts, which is deliberately NOT mocked: it
  // is real code with a real claim to test here — that its layers join
  // `ensureOverlays`'s re-hoist list, without which they vanish under the chart
  // on the next palette or settings change.
  //
  // A REAL REGISTRY, keyed by id, not a single always-truthy stub. It used to be
  // the stub, and that silently disarmed every `if (map.getSource(X)) return;`
  // add-once guard in `wireMap` — including the graticule's, so a test could set
  // `showGrid: () => true` and watch precisely nothing happen while passing.
  // With the registry an id is absent until added and gone again once removed,
  // which is what makes an add/remove effect testable at all.
  private sources = new Map<string, { setData: (data: unknown) => void }>();
  /** Every `setData` payload pushed into a source, by source id. */
  sourceData = new Map<string, unknown[]>();
  get measureData(): unknown[] {
    return this.sourceData.get("measure") ?? [];
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  addSource(id: string) {
    this.sources.set(id, {
      setData: (data: unknown) => {
        const seen = this.sourceData.get(id) ?? [];
        seen.push(data);
        this.sourceData.set(id, seen);
      },
    });
    return this;
  }
  // features/weather/overlay.ts (applyWeatherSources, run from ensureOverlays) reconciles
  // its four double-buffer slots against the map. Weather is off in these tests
  // (DEFAULT_SETTINGS), so `weatherDesired` is empty and it only ever tries to
  // REMOVE slots. No-ops: the overlay's real behaviour is a browser concern,
  // exercised there; here it must just not throw.
  removeLayer() {
    return this;
  }
  removeSource(id: string) {
    this.sources.delete(id);
    return this;
  }
  // The view the graticule builds its lines and edge labels from. A real span,
  // not a point: `gridStep` picks the spacing off `east - west`, and a zero-width
  // view would pick the finest step and build nothing useful.
  getBounds() {
    return {
      getWest: () => 12.0,
      getEast: () => 13.2,
      getSouth: () => 55.5,
      getNorth: () => 56.3,
    };
  }
  // Camera surface for createInitialView. Its behaviour is pinned in
  // initialView.test.ts against a double that models MapLibre properly; here
  // it only has to exist and not move anything these tests read.
  getCenter() {
    return { lng: 12.6, lat: 55.9 };
  }
  getZoom() {
    return 12;
  }
  jumpTo() {
    return this;
  }
  fitBounds() {
    return this;
  }
  remove() {}
}

const SETTINGS: ChartSettings = { ...DEFAULT_SETTINGS, showLights: true };
const VESSEL: Vessel = { lng: 12.6, lat: 55.9 };

/**
 * Mirrors createSignalK's real shape: every accessor reads a coalescing
 * `tick` signal, so any tracked read subscribes the reader to all deltas.
 */
function fakeSignalK(): { state: SignalKState; delta: () => void } {
  const [tick, setTick] = createSignal(0);
  return {
    state: {
      self: () => {
        tick();
        return VESSEL;
      },
      targets: () => {
        tick();
        return [];
      },
      status: () => "connected",
      autopilot: () => null,
      collisionSettings: () => DEFAULT_COLLISION_SETTINGS,
      // The single derived vessel list (C2). Reads `tick` like the other
      // accessors, so the AIS overlay's `update` effect — which now reads
      // `vessels()` instead of raw `self()`/`targets()` — still subscribes to
      // every delta.
      vessels: () => {
        tick();
        return vesselsFromSignalK(VESSEL, []);
      },
    },
    delta: () => setTick((t) => t + 1),
  };
}

/** wireMap under a root, loaded, with the settings signal exposed. `sets` is
 * injectable so a test can prove the style effect ignores a content-equal
 * catalog re-emit (a new array identity from an upstream rescan/config tick). */
function harness(
  opts: {
    sets?: Accessor<ChartSet[]>;
    disabledSets?: Accessor<string[]>;
    bandOrder?: Accessor<string[] | null>;
    showGrid?: Accessor<boolean>;
    /** The FEATURE overlays App drills in (C4). Defaults to route + measure,
     * the pre-C4 internal array the ensure/re-hoist assertions below assume; a
     * test that cares about another feature's overlay passes its own list. */
    overlays?: import("./core/layers/overlay").Overlay[];
  } = {},
) {
  const map = new FakeMap();
  const signalk = fakeSignalK();
  const [settings, setSettings] = createSignal<ChartSettings>(SETTINGS);
  // Inside the root: these own memos, and a memo built outside one is a memo
  // nobody disposes.
  const built = createRoot((dispose) => {
    const cursor = createCursor(signalk.state);
    const measure = createMeasure(signalk.state);
    const modes = createModeState(createRegistry([cursor.feature, measure.feature.core]));
    wireMap(map as unknown as import("maplibre-gl").Map, {
      sets: opts.sets ?? ((() => []) as Accessor<ChartSet[]>),
      disabledSets: opts.disabledSets ?? (() => []),
      osmWorldMinZoom: () => 0,
      osmWorldMaxZoom: () => 8,
      settings,
      signalk: signalk.state,
      debugLayers: () => false,
      debugTiles: () => false,
      debugCells: () => false,
      fpsDebug: () => false,
      showGrid: opts.showGrid ?? (() => false),
      modes,
      measure: measure.model,
      cursor: cursor.model,
      // The feature overlays (C4) are now drilled in as a prop, the way App
      // projects them from its one `features` list; base overlays (weather,
      // sector-lights, AIS) live inside wireMap. This reproduces the pre-C4
      // internal array so the ensure/re-hoist assertions below still hold.
      overlays: opts.overlays ?? [createRouteOverlay(undefined), createMeasureOverlay(measure.model)],
      bandOrder: opts.bandOrder,
    });
    return { cursor, measure, modes, dispose };
  });
  map.fire("load"); // style effect goes live from here
  return { map, signalk, setSettings, ...built };
}

/**
 * North-up, permanently: `wireMap` disables every rotation interaction so the
 * bearing can never leave 0 (the Map is also constructed with `bearing: 0`).
 * There is no toggle and no compass button — the chart cannot be turned.
 */
/**
 * The lat/long graticule. Filed as "the toggle stays off AND the grid never
 * shows" (qomnktpy) — two symptoms that could have been two faults, so this
 * pins the DRAW half independently of the toggle half: given `showGrid` true,
 * `wireMap` really does build both sources and both layers, and drops them again
 * when it goes false. It does, which is what makes the dead toggle in
 * `LayersPanel` (the panel is the grid's ONLY surface) the whole story.
 */
describe("the lat/long graticule follows showGrid", () => {
  test("showGrid on builds both sources and both layers", () => {
    const { map, dispose } = harness({ showGrid: () => true });
    expect(map.getSource("graticule")).toBeDefined();
    expect(map.getSource("graticule-labels")).toBeDefined();
    expect(map.addedLayerIds).toContain("graticule-line");
    expect(map.addedLayerIds).toContain("graticule-label");
    dispose();
  });

  test("off by default — nothing is built", () => {
    const { map, dispose } = harness();
    expect(map.getSource("graticule")).toBeUndefined();
    expect(map.addedLayerIds).not.toContain("graticule-line");
    dispose();
  });

  test("flipping the toggle adds it, and flipping back removes it", () => {
    const [showGrid, setShowGrid] = createSignal(false);
    const { map, dispose } = harness({ showGrid });
    expect(map.getSource("graticule")).toBeUndefined();
    setShowGrid(true);
    expect(map.getSource("graticule")).toBeDefined();
    setShowGrid(false);
    expect(map.getSource("graticule")).toBeUndefined();
    expect(map.getSource("graticule-labels")).toBeUndefined();
    dispose();
  });

  test("a pan past the built envelope pushes new line geometry", () => {
    const { map, dispose } = harness({ showGrid: () => true });
    const before = (map.sourceData.get("graticule") ?? []).length;
    // The lines are built for a padded envelope, so a move inside it is meant to
    // be a no-op; only leaving it rebuilds. Jump the view a long way east.
    map.getBounds = () => ({
      getWest: () => 40.0,
      getEast: () => 41.2,
      getSouth: () => 55.5,
      getNorth: () => 56.3,
    });
    map.fire("move");
    expect((map.sourceData.get("graticule") ?? []).length).toBeGreaterThan(before);
    dispose();
  });
});

describe("north-up enforcement", () => {
  test("wireMap disables drag-, touch- and keyboard-rotation", () => {
    const { map, dispose } = harness();
    expect(map.dragRotateDisabled).toBe(true);
    expect(map.touchRotateDisabled).toBe(true);
    expect(map.keyboardRotateDisabled).toBe(true);
    dispose();
  });
});

describe("style effect dependencies", () => {
  test("a SignalK delta does not rebuild the style", () => {
    const { map, signalk, dispose } = harness();
    const before = map.setStyleCalls.length;
    const updatesBefore = updateSignalkData.mock.calls.length;

    for (let i = 0; i < 5; i++) signalk.delta();

    // Guard against a vacuous pass: the deltas must actually be reaching the
    // live-data effect, or "no setStyle" would prove nothing.
    expect(updateSignalkData.mock.calls.length).toBeGreaterThan(updatesBefore + 4);
    expect(map.setStyleCalls.length).toBe(before);
    dispose();
  });

  test("a settings change still rebuilds the style and reaches the overlays", () => {
    const { map, setSettings, dispose } = harness();
    const before = map.setStyleCalls.length;

    setSettings({ ...SETTINGS, palette: "night" });

    // untrack sits inside ensureOverlays, not around setStyle, precisely so
    // the style effect keeps tracking settings.
    expect(map.setStyleCalls.length).toBe(before + 1);
    // and the synchronous 'style.load' still re-installs the overlays
    expect(map.moved).toContain("signalk-own-ship");
    dispose();
  });

  test("the overlay installer runs on every style application", () => {
    const { map, setSettings, dispose } = harness();
    const before = ensureSignalkLayers.mock.calls.length;

    setSettings({ ...SETTINGS, palette: "night" });

    expect(ensureSignalkLayers.mock.calls.length).toBe(before + 1);
    dispose();
  });

  test("a content-equal catalog re-emit does NOT call setStyle (no source churn)", () => {
    // The upstream catalog signal re-emits a NEW ARRAY IDENTITY on a rescan or a
    // /config round-trip even when nothing changed. Each such tick used to re-run
    // setStyle(diff) on a byte-identical style, whose diff removed and re-added
    // the imperatively-added weather sources — aborting an in-flight `.om` fetch
    // (the "weather loads only after a long time" + deployed 502s). A re-emit of
    // equal content must be a no-op; a real change must still repaint.
    const [sets, setSets] = createSignal<ChartSet[]>([]);
    const { map, setSettings, dispose } = harness({ sets });
    const before = map.setStyleCalls.length;

    setSets([]); // same content, fresh array identity
    expect(map.setStyleCalls.length).toBe(before); // guarded — no redundant setStyle

    // Non-vacuous: a genuine settings change still rebuilds and applies.
    setSettings({ ...SETTINGS, palette: "night" });
    expect(map.setStyleCalls.length).toBe(before + 1);
    dispose();
  });
});

/**
 * The measure overlay is a GeoJSON source + layers OUTSIDE the generated style,
 * exactly like the SignalK ones — so `setStyle(diff)` removes what it does not
 * know about and re-adds the chart layers above whatever survived. If these ids
 * ever fall out of `ensureOverlays`'s re-hoist list, the line does not merely
 * sit at the wrong height: it disappears under the chart, and it does so only
 * after a palette or settings change, which is the least likely moment for
 * anyone to be measuring.
 */
describe("the measure overlay joins ensureOverlays", () => {
  test("its layers are re-hoisted on every style application", () => {
    const { map, setSettings, dispose } = harness();
    map.moved.length = 0;

    setSettings({ ...SETTINGS, palette: "night" });

    for (const id of MEASURE_LAYER_IDS) expect(map.moved).toContain(id);
    dispose();
  });

  test("and it stays under own-ship: you never lose your own boat", () => {
    // Measure now sits ABOVE the AIS targets (its handles must stay grabbable)
    // but still below own-ship, which outranks everything.
    const { map, dispose } = harness();
    const order = map.moved.filter((id) => id !== "sector-lights");
    expect(order.indexOf("measure-line")).toBeLessThan(order.indexOf("signalk-own-ship"));
    dispose();
  });
});

/**
 * The overlay registry's z-order IS the safety-critical map stack. `hoistOrder`
 * is the pure function `wireMap` re-hoists by after every style application, so
 * pinning it here pins the stack: own-ship must be topmost; AIS TARGETS (traffic,
 * safety-critical) must sit above the ROUTE overlay so planning UI never hides
 * them; MEASURE stays above the AIS targets (an actively-held interactive tool
 * needs a grabbable handle) yet below own-ship; and the weather wash must sit
 * below every overlay (it is excluded from the hoist and inserted below the
 * seamarks). A drift in any `z` shows up as a failure here rather than as a boat
 * — or traffic — lost behind planning UI on the water.
 *
 * `aisOverlay`/`ownShipOverlay` come from `core/layers/overlay.ts`, whose
 * `AIS_TARGET_LAYER_IDS` is a MODULE-LEVEL constant computed once, at that
 * module's first evaluation, from `signalkShips`'s `SIGNALK_LAYER_IDS`. Bun
 * shares one module registry across the whole `bun test` run, so whichever
 * test file imports `core/layers/overlay.ts` FIRST decides what that constant
 * is for every other file for the rest of the run — this file's `mock.module`
 * of `signalkShips` (top of file) only shapes it if this file wins that race.
 * A prior version of this test re-derived its own expected id list from a
 * second, independent `signalkShips` import — which followed the same rule,
 * so it could (and, cross-file, did) disagree with what `aisOverlay.layerIds`
 * actually holds: an order-dependent failure, not a real z-order bug. Reading
 * `AIS_TARGET_IDS` straight off `aisOverlay.layerIds` sidesteps the race —
 * whatever `overlay.ts` baked in is what this asserts against — and matches
 * the original intent: RELATIVE order and the own-ship split are what's
 * pinned here, not the exact id list (that's pinned in `signalkShips`'s own
 * tests).
 */
describe("overlay z-order (the safety-critical stack)", () => {
  // AIS targets = every id `aisOverlay` itself hoists (own-ship is split out
  // into `ownShipOverlay` — see core/layers/overlay.ts).
  const AIS_TARGET_IDS = aisOverlay.layerIds;

  test("own-ship is not among the AIS target ids (the split holds)", () => {
    // Guards the split itself: without this, a regression that folded
    // own-ship back into aisOverlay.layerIds would change both sides of the
    // hoist-order comparisons below identically and stay green.
    expect(AIS_TARGET_IDS).not.toContain(ownShipOverlay.layerIds[0]);
  });
  const overlays = [
    createWeatherOverlay({ raster: () => null }),
    createSectorLightsOverlay(new SectorLightLayer() as never),
    createRouteOverlay(undefined),
    createMeasureOverlay(undefined),
    aisOverlay,
    ownShipOverlay,
  ];

  test("hoist order is route → AIS targets → measure → own-ship", () => {
    // sector-lights is NOT here any more: it follows the "Aids & lights" ENC
    // group's stack position (USER DECISION 2026-07-29), so its `z` went
    // negative and it opts out of the hoist exactly as the weather wash does.
    expect(hoistOrder(overlays)).toEqual([
      ...ROUTE_LAYER_IDS,
      ...AIS_TARGET_IDS,
      ...MEASURE_LAYER_IDS,
      "signalk-own-ship",
    ]);
  });

  test("sector-lights left the hoist so it can ride the chart band", () => {
    expect(hoistOrder(overlays)).not.toContain("sector-lights");
  });

  test("own-ship is topmost — you never lose your own boat", () => {
    const order = hoistOrder(overlays);
    expect(order[order.length - 1]).toBe("signalk-own-ship");
  });

  test("AIS targets sit above the route, and measure above the AIS targets", () => {
    const order = hoistOrder(overlays);
    const last = (ids: readonly string[]) => Math.max(...ids.map((id) => order.indexOf(id)));
    // Route below the AIS targets — traffic must never hide under planning UI.
    expect(last(ROUTE_LAYER_IDS)).toBeLessThan(order.indexOf(AIS_TARGET_IDS[0]));
    // ...AIS targets below measure below own-ship (own-ship still outranks all).
    expect(last(AIS_TARGET_IDS)).toBeLessThan(order.indexOf(MEASURE_LAYER_IDS[0]));
    expect(last(MEASURE_LAYER_IDS)).toBeLessThan(order.indexOf("signalk-own-ship"));
  });

  test("the weather wash is excluded from the hoist (it stays below the seamarks)", () => {
    const order = hoistOrder(overlays);
    for (const id of WEATHER_LAYER_IDS) expect(order).not.toContain(id);
  });

  // Notices to Mariners (Z.notices): above POI, below the past track and every
  // fixed safety overlay — a notice is annotation over the chart, never over
  // the route, traffic or the boat.
  test("notices sit below the track, route, AIS targets and own-ship", () => {
    const order = hoistOrder([
      ...overlays,
      createTrackOverlay({ lines: () => [] }),
      createNoticesOverlay({ enabled: () => false, features: () => ({ type: "FeatureCollection", features: [] }) }),
    ]);
    const lastNotice = Math.max(...NOTICES_LAYER_IDS.map((id) => order.indexOf(id)));
    expect(order.slice(0, NOTICES_LAYER_IDS.length)).toEqual([...NOTICES_LAYER_IDS]);
    expect(lastNotice).toBeLessThan(order.indexOf(TRACK_LAYER_IDS[0]));
    expect(lastNotice).toBeLessThan(order.indexOf(ROUTE_LAYER_IDS[0]));
    expect(order[order.length - 1]).toBe("signalk-own-ship");
  });

  test("order follows z, not array position — a new overlay just picks a z", () => {
    const shuffled = [
      ownShipOverlay,
      aisOverlay,
      createMeasureOverlay(undefined),
      createWeatherOverlay({ raster: () => null }),
      createRouteOverlay(undefined),
    ];
    // Same relative order regardless of input order (weather still excluded).
    expect(hoistOrder(shuffled)).toEqual([
      ...ROUTE_LAYER_IDS,
      ...AIS_TARGET_IDS,
      ...MEASURE_LAYER_IDS,
      "signalk-own-ship",
    ]);
  });
});

/**
 * The generic REORDER (C). `bandOrder` moves the reorderable band (ENC groups +
 * washes) into the persisted order, but only ever BELOW the fixed safety
 * overlays — so own-ship stays topmost and the reorder can never bury the boat.
 * Skipped entirely when the order is the default (null).
 */
describe("the generic reorder pass", () => {
  test("null (default) order moves no chart-group layers", () => {
    const { map, dispose } = harness({ bandOrder: () => null });
    expect(map.moved).not.toContain("chart-dk-depare");
    expect(map.moved).not.toContain("chart-dk-soundg");
    // the safety hoist still ran — own-ship is on top as ever
    expect(map.moved).toContain("signalk-own-ship");
    dispose();
  });

  test("a non-default order applies the band and keeps own-ship hoisted", () => {
    const { map, dispose } = harness({ bandOrder: () => ["enc:soundings", "enc:fills"] });
    // Both ENC groups were re-seated (their metadata-tagged layers moved)...
    expect(map.moved).toContain("chart-dk-soundg");
    expect(map.moved).toContain("chart-dk-depare");
    // ...and own-ship is still hoisted by the safety pass (never in the band).
    expect(map.moved).toContain("signalk-own-ship");
    dispose();
  });

  // The sector arcs follow the "Aids & lights" group's stack POSITION as well as
  // its visibility and opacity (USER DECISION 2026-07-29, overriding wxpkzqqq).
  // They are a custom WebGL layer, so nothing about the group reaches them
  // implicitly: `seatSectorLights` moves them onto the group explicitly, and it
  // must do so in the DEFAULT order too, where `applyBandOrder` returns early.
  test("the sector arcs are seated on the aids group even in the default order", () => {
    const { map, dispose } = harness({ bandOrder: () => null });
    // The double's stack is [fills, soundings, aids, openseamap] — the arcs go
    // directly above the aids block, i.e. before `openseamap`.
    expect(map.movedBefore).toContainEqual(["sector-lights", "openseamap"]);
    dispose();
  });

  test("and re-seated when a panel drag moves the group", () => {
    const { map, dispose } = harness({ bandOrder: () => ["enc:aids", "enc:fills"] });
    expect(map.movedBefore.some(([id]) => id === "sector-lights")).toBe(true);
    dispose();
  });
});

/**
 * sonqwmry — the past track is a BAND layer, not the band's anchor.
 *
 * "Ship track" is a Layers-panel row (`features/track`'s `overlayControls`), so
 * App lists it in `bandOrder` and the panel gives it a drag grip. Its overlay
 * was nevertheless absent from `BAND_OVERLAY_IDS`, which made it the lowest
 * FIXED overlay once sector-lights went negative — i.e. the anchor the whole
 * band is seated beneath. The band pass then found its own anchor in the order
 * and moved the track against itself: `moveLayer("track-casing","track-casing")`
 * is a MapLibre no-op, but `moveLayer("track-line","track-casing")` is not — it
 * buries the line under its own 5px casing, and every band layer moved after it
 * lands BETWEEN the two, drawing over the track instead of under it.
 *
 * The fix is band membership, so the anchor is route again (`Z.route`, the
 * lowest fixed overlay) and the two track layers move together, below it.
 */
describe("the past track rides the band, not the anchor (sonqwmry)", () => {
  const isTrack = (id: string | undefined) =>
    id != null && (TRACK_LAYER_IDS as readonly string[]).includes(id);
  // Route + track: the track overlay must be present for MapView to resolve
  // "track" at all, and route is what should be the anchor once it is.
  const withTrack = (order: string[]) =>
    harness({
      bandOrder: () => order,
      overlays: [createRouteOverlay(undefined), createTrackOverlay({ lines: () => [] })],
    });

  test("a drag never makes a track layer the anchor the band is buried under", () => {
    const { map, dispose } = withTrack(["enc:fills", "enc:soundings", "track"]);
    expect(map.movedBefore.some(([, before]) => isTrack(before))).toBe(false);
    dispose();
  });

  // The band pass runs more than once (the `ensureOverlays` hook and the
  // `bandOrder` effect both call it), so these assert on the moves made against
  // the ANCHOR rather than on a single sequence — the anchor's identity and the
  // relative order within it are what the stack actually depends on.
  test("both track layers are seated below the ROUTE anchor, casing still under line", () => {
    const { map, dispose } = withTrack(["enc:fills", "enc:soundings", "track"]);
    const againstAnchor = map.movedBefore.filter(([, before]) => before === ROUTE_LAYER_IDS[0]);
    const trackMoves = againstAnchor.filter(([id]) => isTrack(id));
    expect(new Set(trackMoves.map(([id]) => id))).toEqual(new Set(TRACK_LAYER_IDS));
    // Casing first, line second: each is inserted just under the anchor, so the
    // later one ends up higher — the line stays over the casing it outlines.
    expect(againstAnchor.findIndex(([id]) => id === TRACK_LAYER_IDS[0])).toBeLessThan(
      againstAnchor.findIndex(([id]) => id === TRACK_LAYER_IDS[1]),
    );
    dispose();
  });

  test("the track sits at the TOP of the band when the panel puts it there", () => {
    const { map, dispose } = withTrack(["enc:fills", "enc:soundings", "track"]);
    const againstAnchor = map.movedBefore.filter(([, before]) => before === ROUTE_LAYER_IDS[0]);
    // Last in the order ⇒ last seated under the anchor ⇒ topmost of the band:
    // the same place `Z.track` (below route, above the chart) put it by default.
    expect(isTrack(againstAnchor[againstAnchor.length - 1]![0])).toBe(true);
    dispose();
  });

  // The GENERAL invariant, so this cannot recur one overlay at a time: whatever
  // the panel can drag is a band member, and a band member is never the anchor.
  // Deriving the anchor from the live `bandOrder` — not only from the hardcoded
  // BAND_OVERLAY_IDS — is what makes that true by construction, so this uses an
  // overlay that is deliberately NOT in that set. Route is the case that proves
  // it: it is the lowest FIXED overlay and thus today's anchor, so if a future
  // release gave it a Layers-panel row it would be the next #sonqwmry.
  test("an overlay the panel can drag is never the anchor, listed in the set or not", () => {
    const { map, dispose } = withTrack(["enc:fills", "route", "track"]);
    expect(map.movedBefore.some(([, before]) => ROUTE_LAYER_IDS.includes(before!))).toBe(false);
    // …and it is actually carried by the band rather than merely skipped.
    expect(map.movedBefore.some(([id]) => ROUTE_LAYER_IDS.includes(id))).toBe(true);
    dispose();
  });
});

/**
 * §3.4: `wireMap` registered NO pointer handlers before this — the only one in
 * the whole tree was the `map.on("click")` in info/attach.tsx. So hover is
 * net-new, and these are the assertions that it is wired at all.
 */
describe("the cursor readout's hover wiring", () => {
  const move = (map: FakeMap, lng: number, lat: number) =>
    map.fire("mousemove", { lngLat: { lng, lat } });

  test("a mousemove reaches the cursor model", () => {
    const { map, cursor, dispose } = harness();
    move(map, 12.7, 55.95);
    expect(cursor.model.at()).toEqual({ lng: 12.7, lat: 55.95 });
    dispose();
  });

  test("leaving the chart clears it rather than staling it", () => {
    const { map, cursor, dispose } = harness();
    move(map, 12.7, 55.95);
    map.fire("mouseout");
    expect(cursor.model.at()).toBeNull();
    dispose();
  });

  test("disposal takes the handlers with it", () => {
    const { map, cursor, dispose } = harness();
    dispose();
    move(map, 12.7, 55.95);
    expect(cursor.model.at()).toBeNull();
  });
});

/** A measurement is data through setData, never a style rebuild — same rule the
 * vessels follow, and the reason the flash bug this file exists for cannot
 * recur through a new overlay. */
describe("measure data", () => {
  test("a tap pushes GeoJSON and does not touch the style", () => {
    const { map, measure, modes, dispose } = harness();
    const styleBefore = map.setStyleCalls.length;
    const dataBefore = map.measureData.length;

    modes.enter("measure");
    modes.handleClick({ point: { x: 0, y: 0 }, lngLat: { lng: 12.6, lat: 55.9 }, radius: 8, pick: () => [] });

    expect(map.measureData.length).toBeGreaterThan(dataBefore);
    expect(map.setStyleCalls.length).toBe(styleBefore);
    expect(measure.model.a()).toEqual({ lng: 12.6, lat: 55.9 });
    dispose();
  });
});

/**
 * The desktop rubber-band: the SAME mousemove that feeds the cursor readout
 * moves the measure far end while the mode is live, so range and bearing update
 * continuously without a tap. Off the mode it must NOT — the boat is the default
 * anchor, so an ungated feed would draw a line from the boat to the cursor
 * across the whole app.
 */
describe("measure follows the pointer while in the mode", () => {
  const move = (map: FakeMap, lng: number, lat: number) =>
    map.fire("mousemove", { lngLat: { lng, lat } });

  test("a mousemove in the mode moves the far end and pushes new geometry", () => {
    const { map, measure, modes, dispose } = harness();
    modes.enter("measure");
    const dataBefore = map.measureData.length;

    move(map, 12.6, 56.0); // due north of the boat (55.9), 6 nm
    expect(measure.model.b()).toEqual({ lng: 12.6, lat: 56.0 });
    expect(measure.model.leg()?.rangeNm).toBeCloseTo(6, 1);
    expect(map.measureData.length).toBeGreaterThan(dataBefore);
    dispose();
  });

  test("a mousemove OUT of the mode draws no line from the boat", () => {
    const { map, measure, dispose } = harness();
    move(map, 12.6, 56.0);
    expect(measure.model.b()).toBeNull();
    expect(measure.model.leg()).toBeNull();
    dispose();
  });
});

/**
 * Relative follow's one piece of testable geometry: given the boat's projected
 * screen point and the container size, is the boat still in the frame and — if
 * so — what pixel offset from centre does it now sit at? The live wiring (the
 * drag-pause, the mivnavAuto distinction, the easeTo offset) drives the real
 * camera in the component and needs an in-app eyeball; this is the pure kernel
 * the pan-end handler decides on, pinned here so the in-frame / off-frame call
 * and the offset sign convention can't drift.
 */
describe("followFrame", () => {
  const size = { width: 800, height: 600 };

  test("a centred boat is in-frame with a zero offset", () => {
    expect(followFrame({ x: 400, y: 300 }, size)).toEqual({ inFrame: true, offset: [0, 0] });
  });

  test("an off-centre-but-on-screen boat yields its offset from centre", () => {
    // Right and down of centre → positive dx, positive dy (y grows downward).
    expect(followFrame({ x: 500, y: 450 }, size)).toEqual({ inFrame: true, offset: [100, 150] });
    // Left and up of centre → negative both.
    expect(followFrame({ x: 300, y: 150 }, size)).toEqual({ inFrame: true, offset: [-100, -150] });
  });

  test("a boat projected outside the container is not in-frame", () => {
    expect(followFrame({ x: -10, y: 300 }, size).inFrame).toBe(false);
    expect(followFrame({ x: 810, y: 300 }, size).inFrame).toBe(false);
    expect(followFrame({ x: 400, y: -1 }, size).inFrame).toBe(false);
    expect(followFrame({ x: 400, y: 601 }, size).inFrame).toBe(false);
  });

  test("the margin pulls the in-frame box in from the edge", () => {
    // 10px from the left edge: in-frame with no margin, gone with a 24px margin.
    expect(followFrame({ x: 10, y: 300 }, size).inFrame).toBe(true);
    expect(followFrame({ x: 10, y: 300 }, size, 24).inFrame).toBe(false);
    // Still comfortably inside the margin stays in-frame.
    expect(followFrame({ x: 100, y: 300 }, size, 24).inFrame).toBe(true);
  });
});

/**
 * The follow-boat RULE, end to end on a model camera: the chart moves WITH
 * the boat, a crew zoom or pan by any input leaves the boat where that move
 * put it, and only the follow button centres. ("it should not move the map to
 * center the boat if i did not press the button ... it only happens on pc".)
 *
 * The live wiring is in the component and drives the real camera (measured in
 * a browser: experiments/followHoldOffset.ts). This composes the same three
 * pure pieces the component does — `createFollowMoveGate`,
 * `followMayRecentre`, `followFrame` — in the same way, so the rule they add
 * up to is pinned: a gate that exempts some input from re-anchoring (as it
 * did for `originalEvent`-stamped zooms) fails here.
 */
describe("follow-boat holds the boat where the crew's own move left it", () => {
  const size = { width: 800, height: 600 };
  const MARGIN = 24;
  type Ev = { mivnavAuto?: boolean; originalEvent?: unknown } | undefined;
  const AUTO: Ev = { mivnavAuto: true };

  function model() {
    // World px at scale 1; screen = (world - centre) * scale + size / 2.
    let centre: [number, number] = [0, 0];
    let scale = 1;
    let boat: [number, number] = [0, 0];
    let offset: [number, number] = [0, 0];
    const screen = (): [number, number] => [
      (boat[0] - centre[0]) * scale + size.width / 2,
      (boat[1] - centre[1]) * scale + size.height / 2,
    ];
    const frame = () => {
      const [x, y] = screen();
      return followFrame({ x, y }, size, MARGIN);
    };
    const gate = createFollowMoveGate(() => {
      const f = frame();
      if (f.inFrame) offset = f.offset;
    });
    /** The follow's own recentre: boat to containerCentre + offset, zoom kept. */
    const recentre = () => {
      gate.movestart(AUTO);
      centre = [boat[0] - offset[0] / scale, boat[1] - offset[1] / scale];
      gate.moveend(AUTO);
    };
    return {
      /** Boat offset from the container centre, px. */
      boatOffset: (): [number, number] => {
        const [x, y] = screen();
        return [Math.round(x - size.width / 2), Math.round(y - size.height / 2)];
      },
      centre: () => centre,
      /** A position fix: the recentre effect's body. */
      fix(to: [number, number] = boat) {
        boat = to;
        if (followMayRecentre({ crewMoving: gate.moving(), userGesture: false, inFrame: frame().inFrame })) recentre();
      },
      /** A crew zoom about a screen point, as MapLibre reports it. */
      zoom(factor: number, about: [number, number], start: Ev, end: Ev) {
        gate.movestart(start);
        const wx = centre[0] + (about[0] - size.width / 2) / scale;
        const wy = centre[1] + (about[1] - size.height / 2) / scale;
        scale *= factor;
        centre = [wx - (about[0] - size.width / 2) / scale, wy - (about[1] - size.height / 2) / scale];
        this.fix(); // a fix lands mid-move: the recentre must stand down
        gate.moveend(end);
      },
      /** A crew pan of the chart by screen px. */
      pan(dx: number, dy: number, start: Ev, end: Ev, drag = false) {
        gate.movestart(start);
        if (drag) gate.dragstart();
        centre = [centre[0] - dx / scale, centre[1] - dy / scale];
        this.fix();
        gate.moveend(end);
      },
      /** The follow button. */
      button() {
        gate.cancel();
        offset = [0, 0];
        recentre();
      },
    };
  }

  const wheel = { originalEvent: { type: "wheel" } };
  const click = { originalEvent: { type: "click" } };
  const CURSOR: [number, number] = [700, 500];
  const MIDDLE: [number, number] = [400, 300];
  const inputs: Array<[string, (m: ReturnType<typeof model>) => void]> = [
    ["mouse wheel about the cursor (movestart unstamped)", (m) => m.zoom(1.6, CURSOR, undefined, wheel)],
    ["trackpad scroll / pinch about the cursor", (m) => m.zoom(1.6, CURSOR, wheel, wheel)],
    ["wheel zoom out", (m) => m.zoom(0.6, CURSOR, wheel, wheel)],
    ["double-click zoom", (m) => m.zoom(2, CURSOR, { originalEvent: { type: "dblclick" } }, { originalEvent: { type: "dblclick" } })],
    ["zoom-in button (about the middle)", (m) => m.zoom(2, MIDDLE, click, click)],
    ["zoom-out button", (m) => m.zoom(0.5, MIDDLE, click, click)],
    ["+ key", (m) => m.zoom(2, MIDDLE, { originalEvent: { key: "+" } }, { originalEvent: { key: "+" } })],
    ["mouse drag", (m) => m.pan(-120, 70, { originalEvent: { type: "mousemove" } }, { originalEvent: { type: "mouseup" } }, true)],
    ["arrow key (an untagged panBy)", (m) => m.pan(-100, 0, undefined, undefined)],
    ["touch pinch with no pan in it", (m) => m.zoom(0.6, [200, 450], { originalEvent: { type: "touchmove" } }, { originalEvent: { type: "touchend" } })],
  ];

  for (const start of [[0, 0], [50, 30], [150, 90]] as Array<[number, number]>)
    for (const [name, input] of inputs)
      test(`${name}, boat at ${start}: no glide back on the fixes that follow`, () => {
        const m = model();
        m.fix([1000, 2000]);
        m.button(); // boot: centred on the boat
    m.button(); // boot: centred on the boat
        m.pan(start[0], start[1], undefined, undefined); // the crew put the boat off-centre
        m.fix();
        expect(m.boatOffset()).toEqual(start);

        input(m);
        const left = m.boatOffset(); // where the crew's own move left the boat
        const centre = m.centre();
        for (let i = 0; i < 5; i++) m.fix(); // boat stationary: nothing may move
        expect(m.boatOffset()).toEqual(left);
        expect(m.centre()).toEqual(centre);

        // The boat sails on: the camera goes with it, the boat keeps its spot.
        for (let i = 1; i <= 5; i++) m.fix([1000 + 7 * i, 2000 - 3 * i]);
        expect(m.boatOffset()).toEqual(left);
        expect(m.centre()).not.toEqual(centre);
      });

  test("only the follow button centres — and the boat then stays centred", () => {
    const m = model();
    m.fix([1000, 2000]);
    m.button(); // boot: centred on the boat
    m.pan(150, 90, undefined, undefined);
    m.zoom(1.6, CURSOR, wheel, wheel);
    expect(m.boatOffset()).not.toEqual([0, 0]);
    m.button();
    expect(m.boatOffset()).toEqual([0, 0]);
    for (let i = 1; i <= 3; i++) m.fix([1000 + 7 * i, 2000]);
    expect(m.boatOffset()).toEqual([0, 0]);
  });

  test("zoomed or panned off screen is a PAUSE: the chart holds still, and a pan back resumes where it left the boat", () => {
    const m = model();
    m.fix([1000, 2000]);
    m.button(); // boot: centred on the boat
    m.pan(150, 90, undefined, undefined);
    m.zoom(8, CURSOR, wheel, wheel); // the boat is pushed out of the frame
    const centre = m.centre();
    m.fix([1001, 2000]);
    expect(m.centre()).toEqual(centre); // paused: no recentre
    m.zoom(1 / 8, CURSOR, wheel, wheel); // back in frame
    const back = m.boatOffset();
    m.fix([1010, 2000]);
    expect(m.boatOffset()).toEqual(back);
    expect(m.centre()).not.toEqual(centre);
  });
});
