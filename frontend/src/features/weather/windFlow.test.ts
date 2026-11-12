import { describe, expect, it, spyOn } from "bun:test";
import type { Map as MLMap } from "maplibre-gl";
import { FLOW_SPEED_CAP, WindFlowOverlay, type WindSourceDesc } from "./windFlow";
import {
  capProblems,
  capWindVector,
  clampScreenSize,
  decodeFloatMerc,
  decodeSignedUnit,
  encodeFloatMerc,
  encodeSignedUnit,
  lngLatToMercator,
  overscanViewport,
  particleStateSize,
  precisionDefs,
  resampleWindToEquirect,
  tileIndex,
  tileWindSampler,
  viewportParticleBounds,
  WIND_ENCODE_MAX,
  type GeoWindSampler,
  type WindGpuCaps,
  type WindGpuLayer,
  type WindTile,
} from "./windGpu";

// A minimal MapLibre map stub: enough surface for the overlay's layer add/remove
// and style-loaded checks, plus a small realistic viewport (so the om-path/tile
// tests below cover ~1 tile at WIND_TILE_ZOOM, not the whole globe). No WebGL is
// touched (the GL layer's setWind is spied).
function fakeMap(bounds: [number, number, number, number] = [10.5, 55, 11.5, 55.5]) {
  const layers = new Set<string>();
  return {
    on() {},
    off() {},
    isStyleLoaded: () => true,
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: (l: { id: string }) => void layers.add(l.id),
    removeLayer: (id: string) => void layers.delete(id),
    getBounds: () => ({
      getWest: () => bounds[0],
      getSouth: () => bounds[1],
      getEast: () => bounds[2],
      getNorth: () => bounds[3],
    }),
    triggerRepaint() {},
  } as unknown as MLMap;
}

function uniformTile(u: number, v: number, size = 2): WindTile {
  const data = new Uint8Array(size * size * 4);
  const r = Math.round(encodeSignedUnit(u, WIND_ENCODE_MAX) * 255);
  const g = Math.round(encodeSignedUnit(v, WIND_ENCODE_MAX) * 255);
  for (let i = 0; i < size * size; i++) {
    const k = i * 4;
    data[k] = r;
    data[k + 1] = g;
    data[k + 2] = 0;
    data[k + 3] = 255;
  }
  return { size, data };
}

const SOURCE: WindSourceDesc = {
  sourceId: "om:dwd_icon",
  variable: "wind",
  time: "2026-07-29T12:00:00Z",
};

// Flush pending microtasks so an awaited fetch chain settles before asserting —
// a single macrotask boundary drains any depth of purely-microtask (no real
// timer) promise chains, which is all the `fetchTileFn` stub ever produces.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("WindFlowOverlay — setSource feeds the GL layer", () => {
  it("fetches field tiles and builds a texture straight from the descriptor — no resolve step", async () => {
    // The descriptor IS the address now (an opaque source id, a canonical
    // variable, an explicit instant), so there is no manifest resolve to fail
    // and no retry to schedule. The bounded retry this replaces existed only
    // because `latest.json` could race ahead of the backend.
    const seen: { sourceId: string; variable: string; time: string }[] = [];
    const fetchTileFn = async (sourceId: string, variable: string, time: string) => {
      seen.push({ sourceId, variable, time });
      return uniformTile(6, 0);
    };
    const overlay = new WindFlowOverlay(fakeMap(), { fetchTileFn });
    const layer = (overlay as unknown as { layer: WindGpuLayer }).layer;
    const setWind = spyOn(layer, "setWind");

    overlay.setEnabled(true);
    overlay.setSource(SOURCE);
    await flush();

    const texCall = setWind.mock.calls.find((c) => c[0] != null);
    expect(texCall).toBeDefined();
    expect(texCall![0]).toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) });
    // Every tile was asked for with exactly what MapView resolved.
    expect(seen.length).toBeGreaterThan(0);
    for (const t of seen) expect(t).toEqual(SOURCE);

    overlay.destroy();
  });

  it("clears the field when pointed at nothing — a source that cannot serve wind draws no particles", async () => {
    const overlay = new WindFlowOverlay(fakeMap(), { fetchTileFn: async () => uniformTile(6, 0) });
    const layer = (overlay as unknown as { layer: WindGpuLayer }).layer;
    overlay.setEnabled(true);
    overlay.setSource(SOURCE);
    await flush();
    const setWind = spyOn(layer, "setWind");
    overlay.setSource(null);
    expect(setWind).toHaveBeenCalledWith(null);
    overlay.destroy();
  });

  it("refetches on a scrub — a new instant is a different source", async () => {
    let fetches = 0;
    const overlay = new WindFlowOverlay(fakeMap(), {
      fetchTileFn: async () => {
        fetches++;
        return uniformTile(6, 0);
      },
    });
    overlay.setEnabled(true);
    overlay.setSource(SOURCE);
    await flush();
    const afterFirst = fetches;
    expect(afterFirst).toBeGreaterThan(0);
    // Same descriptor: nothing refetches (the tile cache is kept).
    overlay.setSource({ ...SOURCE });
    await flush();
    expect(fetches).toBe(afterFirst);
    // A different valid time: the cache is dropped and the tiles refetched.
    overlay.setSource({ ...SOURCE, time: "2026-07-29T15:00:00Z" });
    await flush();
    expect(fetches).toBeGreaterThan(afterFirst);
    overlay.destroy();
  });
});

describe("WindFlowOverlay — placeLayer failures are observable (mrkyzrtx)", () => {
  it("logs a caught addLayer error instead of swallowing it silently", () => {
    // The bug this guards: placeLayer's try/catch used to swallow ANY addLayer
    // throw with no log — indistinguishable from a benign "style not ready
    // yet" retry vs. a permanent GL/shader init failure (onAdd throwing from a
    // shader compile error, say). That total silence is why "wind particles
    // don't render on Android" shipped with no diagnostic trail at all.
    const map = fakeMap();
    let addLayerCalls = 0;
    (map as unknown as { addLayer: (l: { id: string }) => void }).addLayer = (l) => {
      addLayerCalls++;
      throw new Error("simulated onAdd failure (e.g. shader compile)");
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const overlay = new WindFlowOverlay(map, {});

    overlay.setEnabled(true); // placeLayer() runs, addLayer throws

    expect(addLayerCalls).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("addLayer failed");

    errorSpy.mockRestore();
    overlay.destroy();
  });

  it("latches a windGpu capability failure as permanent instead of retrying it forever", () => {
    // A `windGpu:`-prefixed throw is the layer's own onAdd rejecting this GPU (a
    // shader that would not compile/link, or a missing capability). Retrying it
    // on every idle beat re-throws forever and buries the one message that says
    // WHY nothing renders — so it is reported once and not retried (#yuryrknp).
    const map = fakeMap();
    let addLayerCalls = 0;
    (map as unknown as { addLayer: (l: { id: string }) => void }).addLayer = () => {
      addLayerCalls++;
      throw new Error("windGpu: FATAL: MAX_VERTEX_TEXTURE_IMAGE_UNITS is 0 …");
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const overlay = new WindFlowOverlay(map, {});

    overlay.setEnabled(true);
    overlay.setEnabled(false);
    overlay.setEnabled(true); // a second enable must NOT re-attempt the add

    expect(addLayerCalls).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("could not be created on this device");

    errorSpy.mockRestore();
    overlay.destroy();
  });
});

// A map stub that actually tracks layer ORDER (bottom → top, an array — unlike
// `fakeMap()`'s unordered Set above), plus `getLayersOrder()` — the real
// MapLibre method that includes custom layers, unlike `getStyle().layers`
// (`Style._serializeByIds` explicitly skips them: "this check will skip all
// custom layers"). `weatherBeforeId`/`slotWrong` used to read `getStyle().layers`
// only, so they could never find the wind-flow layer itself in the list —
// `slotWrong` always got `indexOf === -1` and always answered "no move
// needed", so `placeLayer`'s reposition branch was dead past the initial add.
function orderedFakeMap(initial: string[]) {
  let order = [...initial];
  // Which ids were added as `type: "custom"` — mirrors real MapLibre's
  // `Style._serializeByIds`/`_serializedAllLayers`, which builds `getStyle().layers`
  // by skipping exactly these ("this check will skip all custom layers", its own
  // comment). `getLayersOrder()` (below) is the one MapLibre method that does NOT
  // skip them. Tracking this for real (not just omitting `getStyle` altogether)
  // keeps the fake faithful to both code paths `mapLayerIds()` can take.
  const customIds = new Set<string>();
  const handlers = new Map<string, Set<() => void>>();
  return {
    _order: () => order,
    on(event: string, cb: () => void) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(cb);
    },
    off(event: string, cb: () => void) {
      handlers.get(event)?.delete(cb);
    },
    fire(event: string) {
      for (const cb of handlers.get(event) ?? []) cb();
    },
    isStyleLoaded: () => true,
    getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
    getLayersOrder: () => [...order],
    getStyle: () => ({ layers: order.filter((id) => !customIds.has(id)).map((id) => ({ id })) }),
    addLayer: (l: { id: string; type?: string }, before?: string) => {
      if (l.type === "custom") customIds.add(l.id);
      const idx = before ? order.indexOf(before) : -1;
      order.splice(idx < 0 ? order.length : idx, 0, l.id);
    },
    removeLayer: (id: string) => {
      order = order.filter((x) => x !== id);
      customIds.delete(id);
    },
    moveLayer: (id: string, before?: string) => {
      order = order.filter((x) => x !== id);
      const idx = before ? order.indexOf(before) : -1;
      order.splice(idx < 0 ? order.length : idx, 0, id);
    },
    getBounds: () => ({
      getWest: () => 10,
      getSouth: () => 55,
      getEast: () => 11,
      getNorth: () => 55.5,
    }),
    triggerRepaint() {},
  } as unknown as MLMap;
}

describe("WindFlowOverlay z-order — particles must stay ABOVE the wash", () => {
  it("re-corrects on idle after the wash is removed+re-added above it (the real applyWeatherRaster sequence)", () => {
    // Starting stack, bottom → top: base chart, the wash, openseamap, a fixed
    // safety overlay. Matches `applyWeatherRaster`'s own insert (`beforeId:
    // 'openseamap'`).
    const map = orderedFakeMap(["base", "weather-raster-0", "openseamap", "ais-targets"]);
    const overlay = new WindFlowOverlay(map, {});
    const flowId = overlay.layerId;

    overlay.setEnabled(true); // adds the layer via placeLayer(), directly above the wash
    expect(map._order().indexOf(flowId)).toBeGreaterThan(map._order().indexOf("weather-raster-0"));

    // A forecast/model/palette change: `applyWeatherRaster` removes the wash and
    // re-adds it fresh, always at `beforeId: 'openseamap'` — with no notion of
    // where the particles currently sit. That lands the wash ABOVE them.
    map.removeLayer("weather-raster-0");
    map.addLayer({ id: "weather-raster-0" }, "openseamap");
    expect(map._order().indexOf(flowId)).toBeLessThan(map._order().indexOf("weather-raster-0"));

    // `idle` is the guaranteed catch-all beat (see `onIdle`) — it must notice
    // and correct the slot.
    map.fire("idle");
    expect(map._order().indexOf(flowId)).toBeGreaterThan(map._order().indexOf("weather-raster-0"));

    overlay.destroy();
  });
});

describe("tileIndex — lng/lat → slippy tile index", () => {
  it("is the single tile at zoom 0", () => {
    expect(tileIndex(-170, 80, 0)).toEqual({ x: 0, y: 0 });
    expect(tileIndex(170, -80, 0)).toEqual({ x: 0, y: 0 });
  });

  it("splits the globe into four quadrants at zoom 1 (NW/SE corners)", () => {
    expect(tileIndex(-90, 45, 1)).toEqual({ x: 0, y: 0 }); // NW
    expect(tileIndex(90, -45, 1)).toEqual({ x: 1, y: 1 }); // SE
  });

  it("clamps into [0, 2^z − 1] even at the mercator latitude limit", () => {
    const { x, y } = tileIndex(179.9, -89.9, 4);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(15);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(15);
  });
});

describe("tileWindSampler — nearest-texel lookup over a decoded tile mosaic", () => {
  const ZOOM = 2;
  // Both points fall in the same tile at zoom 2 (pinned below via tileIndex):
  // 60°N sits near that tile's NORTH edge, 20°N near its SOUTH edge.
  const LNG = -45;
  const NORTH_LAT = 60;
  const SOUTH_LAT = 20;

  it("both sample points land in tile (1,1) — the fixture this suite assumes", () => {
    expect(tileIndex(LNG, NORTH_LAT, ZOOM)).toEqual({ x: 1, y: 1 });
    expect(tileIndex(LNG, SOUTH_LAT, ZOOM)).toEqual({ x: 1, y: 1 });
  });

  it("row 0 = SOUTH — the documented, non-standard tile wire convention (the easy sign flip to get backwards silently)", () => {
    // Row 0 (the tile PNG's first scanline) carries the SOUTH-edge value per the
    // backend contract (see windGpu.ts's tileWindSampler doc); a canvas decode
    // gives normal top-down pixel order, so the sampler inverts the row index —
    // this pins that inversion against a regression.
    const enc = (v: number) => Math.round(encodeSignedUnit(v, WIND_ENCODE_MAX) * 255);
    const size = 2;
    const data = new Uint8Array(size * size * 4);
    // Row 0 (bytes 0..7): the SOUTH marker (u=10, v=-10).
    for (let x = 0; x < size; x++) {
      const k = x * 4;
      data[k] = enc(10);
      data[k + 1] = enc(-10);
      data[k + 3] = 255;
    }
    // Row 1 (last size*4 bytes): the NORTH marker (u=-10, v=10).
    for (let x = 0; x < size; x++) {
      const k = (size + x) * 4;
      data[k] = enc(-10);
      data[k + 1] = enc(10);
      data[k + 3] = 255;
    }
    const mosaic = new Map<string, WindTile>([["1,1", { size, data }]]);
    const sample = tileWindSampler(mosaic, ZOOM);

    const atSouth = sample(LNG, SOUTH_LAT)!;
    expect(atSouth.u).toBeCloseTo(10, 0);
    expect(atSouth.v).toBeCloseTo(-10, 0);

    const atNorth = sample(LNG, NORTH_LAT)!;
    expect(atNorth.u).toBeCloseTo(-10, 0);
    expect(atNorth.v).toBeCloseTo(10, 0);
  });

  it("returns null for a tile that was never fetched (missing from the mosaic)", () => {
    const sample = tileWindSampler(new Map(), ZOOM);
    expect(sample(LNG, NORTH_LAT)).toBeNull();
  });

  it("returns null for a no-data hole (alpha < 128)", () => {
    const mosaic = new Map<string, WindTile>([
      ["1,1", { size: 1, data: new Uint8Array([0, 0, 0, 0]) }],
    ]);
    const sample = tileWindSampler(mosaic, ZOOM);
    expect(sample(LNG, NORTH_LAT)).toBeNull();
  });
});

describe("viewportParticleBounds — wind-resample bounds = viewport ∩ grid", () => {
  const grid: [number, number, number, number] = [10, 54, 13, 57];

  it("returns the viewport unchanged when it sits fully inside the grid", () => {
    const vp: [number, number, number, number] = [11, 55, 12, 56];
    expect(viewportParticleBounds(vp, grid)).toEqual([11, 55, 12, 56]);
  });

  it("clamps to the grid on a partial overlap (viewport spills past two edges)", () => {
    // Viewport runs off the grid to the west and south.
    const vp: [number, number, number, number] = [8, 52, 12, 56];
    expect(viewportParticleBounds(vp, grid)).toEqual([10, 54, 12, 56]);
  });

  it("returns the whole grid when the viewport contains it (zoomed out)", () => {
    const vp: [number, number, number, number] = [0, 40, 30, 70];
    expect(viewportParticleBounds(vp, grid)).toEqual(grid);
  });

  it("returns null when the viewport is entirely off the grid (disjoint)", () => {
    const vp: [number, number, number, number] = [20, 54, 25, 57]; // east of the grid
    expect(viewportParticleBounds(vp, grid)).toBeNull();
  });

  it("returns null for a degenerate (edge-touching) overlap, not a zero-area bbox", () => {
    const vp: [number, number, number, number] = [13, 54, 16, 57]; // shares only the E edge
    expect(viewportParticleBounds(vp, grid)).toBeNull();
  });
});

describe("overscanViewport — pad the viewport before intersecting the grid", () => {
  it("pads each side by frac of the viewport's own span", () => {
    // span 4 lng, 2 lat; frac 0.25 → pad 1 lng, 0.5 lat per side.
    const vp: [number, number, number, number] = [10, 54, 14, 56];
    expect(overscanViewport(vp, 0.25)).toEqual([9, 53.5, 15, 56.5]);
  });

  it("is a no-op at frac 0", () => {
    const vp: [number, number, number, number] = [10, 54, 14, 56];
    expect(overscanViewport(vp, 0)).toEqual(vp);
  });

  it("still clamps to the grid once intersected (padded spill is bounded by data)", () => {
    const grid: [number, number, number, number] = [10, 54, 13, 57];
    const vp: [number, number, number, number] = [11, 55, 12, 56];
    // Padded viewport = [10.75, 54.75, 12.25, 56.25], inside the grid ⇒ unchanged.
    expect(viewportParticleBounds(overscanViewport(vp, 0.25), grid)).toEqual([
      10.75, 54.75, 12.25, 56.25,
    ]);
    // A viewport hugging the west edge: padding spills past the grid, gets clamped.
    const vpEdge: [number, number, number, number] = [10.2, 55, 11.2, 56];
    expect(viewportParticleBounds(overscanViewport(vpEdge, 0.25), grid)).toEqual([
      10, 54.75, 11.45, 56.25,
    ]);
  });
});

// `windVectorFrom`/`geoWindSampler` (the FROM-bearing → eastward/northward
// vector conversion over a client-decoded Lambert grid) were deleted along
// with the whole client-side `.om` decode (Phase 4) — the backend now derives
// the same vector field server-side and serves it pre-encoded in the wind
// tiles `tileWindSampler` (tested above) reads directly.

describe("particleStateSize — count → square state-texture side", () => {
  it("is ceil(sqrt(count)) so side² covers the count", () => {
    expect(particleStateSize(600)).toBe(25); // 25² = 625 ≥ 600
    expect(particleStateSize(625)).toBe(25);
    expect(particleStateSize(626)).toBe(26);
    expect(particleStateSize(1)).toBe(1);
  });
});

describe("encodeFloatMerc/decodeFloatMerc — the FLOAT_STATE cell+frac position split", () => {
  it("round-trips through float32 storage far more precisely than raw [0,1] storage", () => {
    const x = 0.6234567891234;
    const y = 0.3123456789123;
    const { fracX, fracY, cell } = encodeFloatMerc(x, y);
    // Simulate the RGBA32F texture: every channel quantised to float32.
    const stored = new Float32Array([fracX, fracY, cell]);
    const { x: bx, y: by } = decodeFloatMerc(stored[0]!, stored[1]!, stored[2]!);
    // The naive whole-world float32 scheme (store x/y directly) only holds ~1.2e-7
    // absolute precision — coarser than a screen pixel past zoom ≈ 15. The cell+frac
    // split should clear that by orders of magnitude.
    expect(Math.abs(bx - x)).toBeLessThan(1e-9);
    expect(Math.abs(by - y)).toBeLessThan(1e-9);
  });

  it("keeps the combined cell index an exact integer (no float32 rounding)", () => {
    const { cell } = encodeFloatMerc(0.999999, 0.000001);
    expect(Number.isInteger(cell)).toBe(true);
    expect(new Float32Array([cell])[0]).toBe(cell); // exact in float32
  });
});

describe("u/v encode ↔ decode round-trip", () => {
  it("round-trips values across the range within 8-bit resolution", () => {
    const max = WIND_ENCODE_MAX;
    for (const v of [-40, -13.7, 0, 6, 21.3, 40]) {
      // Simulate the 8-bit texture quantisation the GPU stores.
      const byte = Math.round(encodeSignedUnit(v, max) * 255);
      const back = decodeSignedUnit(byte / 255, max);
      expect(back).toBeCloseTo(v, 0); // within ~1 unit of 8-bit precision
    }
  });

  it("maps 0 to mid-scale and saturates out-of-range instead of wrapping", () => {
    expect(encodeSignedUnit(0, 40)).toBeCloseTo(0.5, 6);
    expect(encodeSignedUnit(1000, 40)).toBe(1); // clamped, not wrapped
    expect(encodeSignedUnit(-1000, 40)).toBe(0);
  });
});

describe("capWindVector — the shader's speed cap, as a pure reference", () => {
  it("passes a sub-cap vector through unchanged", () => {
    const { u, v } = capWindVector(3, 0, FLOW_SPEED_CAP);
    expect(u).toBeCloseTo(3, 6);
    expect(v).toBeCloseTo(0, 6);
  });

  it("caps magnitude while preserving direction", () => {
    // A 3-4-5 vector at 5× the cap: magnitude caps to FLOW_SPEED_CAP, 3:4 kept.
    const k = FLOW_SPEED_CAP;
    const { u, v } = capWindVector(3 * k, 4 * k, FLOW_SPEED_CAP);
    expect(Math.hypot(u, v)).toBeCloseTo(FLOW_SPEED_CAP, 6);
    expect(u / v).toBeCloseTo(3 / 4, 6);
  });

  it("leaves a dead-calm vector at zero (no divide-by-zero)", () => {
    expect(capWindVector(0, 0, FLOW_SPEED_CAP)).toEqual({ u: 0, v: 0 });
  });
});

describe("lngLatToMercator — absolute web-mercator position math", () => {
  it("maps the antimeridian/equator origin to (0, 0.5)", () => {
    const p = lngLatToMercator(-180, 0);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0.5, 6);
  });

  it("maps lng 0 to x = 0.5 and puts north above south (smaller y)", () => {
    expect(lngLatToMercator(0, 0).x).toBeCloseTo(0.5, 6);
    const north = lngLatToMercator(10, 60).y;
    const south = lngLatToMercator(10, 50).y;
    expect(north).toBeLessThan(south); // y grows southward
  });

  it("agrees with the known web-mercator y for 55°N", () => {
    // y = (1 − asinh(tan(lat))/π)/2; at 55° ≈ 0.31630.
    expect(lngLatToMercator(0, 55).y).toBeCloseTo(0.31630, 4);
  });

  it("clamps beyond the mercator latitude limit instead of blowing up", () => {
    expect(Number.isFinite(lngLatToMercator(0, 89.9).y)).toBe(true);
    expect(Number.isFinite(lngLatToMercator(0, -89.9).y)).toBe(true);
  });
});

describe("resampleWindToEquirect — geo sampler → equirectangular RGBA texture", () => {
  const bounds: [number, number, number, number] = [10, 54, 13, 57]; // a Danish-ish bbox
  const uniformWesterly: GeoWindSampler = () => ({ u: 6, v: 0 });

  it("encodes a uniform westerly so every texel decodes back to it, with data mask", () => {
    const tex = resampleWindToEquirect(uniformWesterly, bounds, 8, 8);
    expect(tex.cols).toBe(8);
    expect(tex.rows).toBe(8);
    expect(tex.data.length).toBe(8 * 8 * 4);
    // Sample a few texels: RG decodes to u≈6, v≈0; A = 255 (has data).
    for (const k of [0, 40, 8 * 8 * 4 - 4]) {
      const u = decodeSignedUnit(tex.data[k] / 255, tex.encodeMax);
      const v = decodeSignedUnit(tex.data[k + 1] / 255, tex.encodeMax);
      expect(u).toBeCloseTo(6, 0);
      expect(v).toBeCloseTo(0, 0);
      expect(tex.data[k + 3]).toBe(255);
    }
  });

  it("marks off-grid nodes as no-data holes (alpha 0)", () => {
    // A sampler with data only in the southern half of the bbox.
    const half: GeoWindSampler = (_lng, lat) => (lat < 55.5 ? { u: 3, v: 0 } : null);
    const tex = resampleWindToEquirect(half, bounds, 4, 4);
    // Row 0 = minLat (south) has data; the top row (north) is a hole.
    const bottom = 3; // alpha of texel (0,0)
    const topRowStart = 3 * 4 * 4; // row j=3
    expect(tex.data[bottom]).toBe(255);
    expect(tex.data[topRowStart + 3]).toBe(0);
    // The hole's RG are zeroed, not stale.
    expect(tex.data[topRowStart]).toBe(0);
    expect(tex.data[topRowStart + 1]).toBe(0);
  });

  it("orders rows south → north (row 0 at minLat)", () => {
    // v grows with latitude (×10 so it spans a decodable fraction of ±40 m/s).
    const grad: GeoWindSampler = (_lng, lat) => ({ u: 0, v: (lat - 54) * 10 });
    const tex = resampleWindToEquirect(grad, bounds, 2, 4);
    const vAt = (row: number) => decodeSignedUnit(tex.data[row * 2 * 4 + 1] / 255, tex.encodeMax);
    expect(vAt(0)).toBeLessThan(1); // minLat → v≈0
    expect(vAt(3)).toBeGreaterThan(29); // maxLat (span 54→57) → v≈30
    expect(vAt(0)).toBeLessThan(vAt(3));
  });
});

// ── Capability diagnostics (#yuryrknp) ──────────────────────────────────────
//
// The GL path itself has no headless coverage (bun has no WebGL context), so
// what is pinned here is the PURE verdict logic the probe feeds: which
// mobile-shaped capability sets are fatal, which are merely degraded, and the
// screen-texture clamp that keeps a high-DPR drawing buffer from taking the
// whole layer down.

/** A capability set matching a healthy desktop/modern-Android WebGL2 stack. */
function goodCaps(over: Partial<WindGpuCaps> = {}): WindGpuCaps {
  return {
    webgl2: true,
    vendor: "Test",
    renderer: "Test GPU",
    maxTextureSize: 8192,
    maxVertexTextureUnits: 16,
    pointSizeRange: [1, 255],
    colorBufferFloat: true,
    fragmentHighFloatPrecision: 23,
    drawingBuffer: [1080, 2400],
    floatState: true,
    problems: [],
    ...over,
  };
}

describe("capProblems", () => {
  it("reports nothing on a healthy WebGL2 stack", () => {
    expect(capProblems(goodCaps())).toEqual([]);
  });

  it("calls zero vertex texture units FATAL — the technique cannot work at all", () => {
    const problems = capProblems(goodCaps({ maxVertexTextureUnits: 0 }));
    expect(problems.some((p) => p.startsWith("FATAL:"))).toBe(true);
    expect(problems[0]).toContain("MAX_VERTEX_TEXTURE_IMAGE_UNITS");
  });

  it("flags a drawing buffer larger than MAX_TEXTURE_SIZE (high-DPR phone)", () => {
    const problems = capProblems(goodCaps({ maxTextureSize: 2048, drawingBuffer: [1080, 2400] }));
    expect(problems.some((p) => p.includes("MAX_TEXTURE_SIZE"))).toBe(true);
  });

  it("treats a missing float path as degraded, not fatal", () => {
    for (const caps of [
      goodCaps({ webgl2: false, colorBufferFloat: false }),
      goodCaps({ colorBufferFloat: false }),
    ]) {
      const problems = capProblems(caps);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.some((p) => p.startsWith("FATAL:"))).toBe(false);
      expect(problems.some((p) => p.startsWith("degraded:"))).toBe(true);
    }
  });

  it("flags a fragment stage without highp", () => {
    const problems = capProblems(goodCaps({ fragmentHighFloatPrecision: 0 }));
    expect(problems.some((p) => p.includes("highp"))).toBe(true);
  });
});

describe("clampScreenSize", () => {
  it("passes a buffer that fits through unchanged", () => {
    expect(clampScreenSize(1080, 2400, 8192)).toEqual([1080, 2400]);
  });

  it("clamps each axis to MAX_TEXTURE_SIZE", () => {
    expect(clampScreenSize(1080, 2400, 2048)).toEqual([1080, 2048]);
    expect(clampScreenSize(4000, 4000, 2048)).toEqual([2048, 2048]);
  });

  it("never returns a zero dimension, and tolerates an unknown max", () => {
    expect(clampScreenSize(0, 0, 4096)).toEqual([1, 1]);
    expect(clampScreenSize(1080, 2400, 0)).toEqual([1080, 2400]);
  });
});

describe("WindFlowOverlay — a silent pause is reported (#yuryrknp)", () => {
  it("warns when the flow is enabled but reduced-motion has paused it", () => {
    // The single most likely way a phone shows no particles with a clean
    // console and a perfectly healthy GPU: Android sets
    // prefers-reduced-motion from Battery Saver and from "Remove animations",
    // the overlay pauses correctly, and nothing says so.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const overlay = new WindFlowOverlay(fakeMap(), {
      reducedMotion: () => true,
      fetchTileFn: async () => uniformTile(6, 0),
    });
    overlay.setEnabled(true);
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain("PAUSED");
    expect(msg).toContain("prefers-reduced-motion=true");
    warnSpy.mockRestore();
    overlay.destroy();
  });

  it("says nothing when the flow is enabled and running", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const overlay = new WindFlowOverlay(fakeMap(), {
      reducedMotion: () => false,
      fetchTileFn: async () => uniformTile(6, 0),
    });
    overlay.setEnabled(true);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("PAUSED");
    warnSpy.mockRestore();
    overlay.destroy();
  });
});

describe("precisionDefs", () => {
  it("follows the fragment stage's highp verdict", () => {
    expect(precisionDefs(23)).toBe("#define VPREC highp\n");
    expect(precisionDefs(0)).toBe("#define VPREC mediump\n");
  });
});
