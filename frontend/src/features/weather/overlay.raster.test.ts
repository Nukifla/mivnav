/**
 * `applyWeatherRaster` — the wash's Phase 2 reconcile: inert-when-null (no
 * source added when there is nothing resolved yet — same contract as
 * `applySatelliteSource`'s inert-when-off), the add path with the below-
 * seamarks `beforeId`, the in-place opacity nudge on an unchanged key, and
 * the tear-down/re-add on a key change (forecast/model/palette). Modelled
 * directly on `features/satellite/overlay.test.ts`'s FakeMap, since this
 * reconcile mirrors `applySatelliteSource` exactly (see the module header in
 * `overlay.ts`).
 */

import { describe, expect, test } from "bun:test";
import type { Map as MLMap } from "maplibre-gl";
import { applyWeatherRaster, WEATHER_LAYER_IDS, type WeatherRasterState } from "./overlay";
import { WEATHER_WASH_LAYER_ID, type ResolvedWeatherRaster } from "./sources";

interface AddLayer {
  layer: { id: string; type: string; paint: Record<string, unknown> };
  beforeId: string | undefined;
}

class FakeMap {
  layers: Set<string>;
  sources: Set<string>;
  ops: string[] = [];
  addSourceCalls: { id: string; spec: Record<string, unknown> }[] = [];
  addLayerCalls: AddLayer[] = [];
  setPaintCalls: { layerId: string; prop: string; value: unknown }[] = [];

  constructor(opts: { layers?: string[]; sources?: string[] } = {}) {
    this.layers = new Set(opts.layers ?? []);
    this.sources = new Set(opts.sources ?? []);
  }
  getLayer(id: string) {
    return this.layers.has(id) ? { id } : undefined;
  }
  getSource(id: string) {
    return this.sources.has(id) ? { id } : undefined;
  }
  addSource(id: string, spec: Record<string, unknown>) {
    this.sources.add(id);
    this.addSourceCalls.push({ id, spec });
    this.ops.push(`addSource:${id}`);
    return this;
  }
  addLayer(layer: AddLayer["layer"], beforeId?: string) {
    this.layers.add(layer.id);
    this.addLayerCalls.push({ layer, beforeId });
    this.ops.push(`addLayer:${layer.id}`);
    return this;
  }
  setPaintProperty(layerId: string, prop: string, value: unknown) {
    this.setPaintCalls.push({ layerId, prop, value });
    this.ops.push(`setPaint:${layerId}`);
    return this;
  }
  removeLayer(id: string) {
    this.layers.delete(id);
    this.ops.push(`removeLayer:${id}`);
    return this;
  }
  removeSource(id: string) {
    this.sources.delete(id);
    this.ops.push(`removeSource:${id}`);
    return this;
  }
}

const asMap = (m: FakeMap) => m as unknown as MLMap;

const resolved = (over: Partial<ResolvedWeatherRaster> = {}): ResolvedWeatherRaster => ({
  key: "gfs/2026/07/24/1200Z/2026-07-24T1200.om|wind_gusts_10m|false",
  tiles: "https://h/api/weather/tiles/wash/{z}/{x}/{y}.png?path=x&variable=wind_gusts_10m&dark=false",
  attribution: "Open-Meteo",
  ...over,
});

describe("applyWeatherRaster — inert when null", () => {
  test("null adds NOTHING — no source, so MapLibre requests zero tiles", () => {
    const map = new FakeMap({ layers: ["openseamap"] });
    const state: WeatherRasterState = { key: "" };
    applyWeatherRaster(asMap(map), null, 1, state);
    expect(map.addSourceCalls).toHaveLength(0);
    expect(map.addLayerCalls).toHaveLength(0);
  });

  test("null tears down a wash that was on (a toggle-off, or the om-path resolve still in flight)", () => {
    const map = new FakeMap({
      layers: ["openseamap", WEATHER_WASH_LAYER_ID],
      sources: [WEATHER_WASH_LAYER_ID],
    });
    const state: WeatherRasterState = { key: resolved().key };
    applyWeatherRaster(asMap(map), null, 1, state);
    const li = map.ops.indexOf(`removeLayer:${WEATHER_WASH_LAYER_ID}`);
    const si = map.ops.indexOf(`removeSource:${WEATHER_WASH_LAYER_ID}`);
    expect(li).toBeGreaterThanOrEqual(0);
    expect(si).toBeGreaterThan(li); // layer before source
    expect(state.key).toBe("");
  });
});

describe("applyWeatherRaster — the add path", () => {
  test("adds the wash below the seamarks, at the given opacity", () => {
    const map = new FakeMap({ layers: ["openseamap"] });
    const state: WeatherRasterState = { key: "" };
    applyWeatherRaster(asMap(map), resolved(), 0.7, state);

    expect(map.addSourceCalls).toHaveLength(1);
    expect(map.addSourceCalls[0].id).toBe(WEATHER_WASH_LAYER_ID);
    expect(map.addSourceCalls[0].spec.type).toBe("raster");
    expect(map.addSourceCalls[0].spec.tiles).toEqual([resolved().tiles]);

    expect(map.addLayerCalls).toHaveLength(1);
    const add = map.addLayerCalls[0];
    expect(add.layer.id).toBe(WEATHER_WASH_LAYER_ID);
    expect(add.layer.type).toBe("raster");
    expect(add.layer.paint["raster-opacity"]).toBe(0.7);
    expect(add.layer.paint["raster-resampling"]).toBe("linear");
    expect(add.beforeId).toBe("openseamap");
    expect(state.key).toBe(resolved().key);
  });

  test("falls back to append (beforeId undefined) when the style has no openseamap layer", () => {
    const map = new FakeMap(); // bare map: no openseamap
    applyWeatherRaster(asMap(map), resolved(), 1, { key: "" });
    expect(map.addLayerCalls).toHaveLength(1);
    expect(map.addLayerCalls[0].beforeId).toBeUndefined();
  });

  // USER DECISION (2026-07-27): "don't dim the weather wash." Unlike
  // satellite/openseamap (which still call chartStyle.ts's `rasterPaint` for
  // a night-glare dim), the wash's colour IS the data — dimming it would
  // desaturate the very field it's showing. `applyWeatherRaster` no longer
  // takes a palette at all, so there is no dimming to apply regardless of
  // theme.
  test("never dims the wash — no raster-brightness-max/-saturation in its paint", () => {
    const map = new FakeMap({ layers: ["openseamap"] });
    applyWeatherRaster(asMap(map), resolved(), 1, { key: "" });
    const paint = map.addLayerCalls[0].layer.paint;
    expect(paint["raster-brightness-max"]).toBeUndefined();
    expect(paint["raster-saturation"]).toBeUndefined();
  });
});

describe("applyWeatherRaster — updates and swaps", () => {
  test("an opacity change on the SAME key is setPaintProperty, never a re-add", () => {
    const map = new FakeMap({
      layers: ["openseamap", WEATHER_WASH_LAYER_ID],
      sources: [WEATHER_WASH_LAYER_ID],
    });
    const state: WeatherRasterState = { key: resolved().key };
    applyWeatherRaster(asMap(map), resolved(), 0.3, state);
    expect(map.setPaintCalls).toEqual([
      { layerId: WEATHER_WASH_LAYER_ID, prop: "raster-opacity", value: 0.3 },
    ]);
    expect(map.addSourceCalls).toHaveLength(0);
    expect(map.addLayerCalls).toHaveLength(0);
  });

  test("a key change (forecast/model/palette) tears the old down (layer before source) and re-adds", () => {
    const map = new FakeMap({
      layers: ["openseamap", WEATHER_WASH_LAYER_ID],
      sources: [WEATHER_WASH_LAYER_ID],
    });
    const state: WeatherRasterState = { key: "old-key" };
    applyWeatherRaster(asMap(map), resolved({ key: "new-key" }), 1, state);

    const rl = map.ops.indexOf(`removeLayer:${WEATHER_WASH_LAYER_ID}`);
    const rs = map.ops.indexOf(`removeSource:${WEATHER_WASH_LAYER_ID}`);
    const as = map.ops.indexOf(`addSource:${WEATHER_WASH_LAYER_ID}`);
    expect(rl).toBeGreaterThanOrEqual(0);
    expect(rs).toBeGreaterThan(rl);
    expect(as).toBeGreaterThan(rs);
    expect(state.key).toBe("new-key");
  });

  test("after a style.load wipe (source gone, key unchanged) the layer is re-added", () => {
    const map = new FakeMap({ layers: ["openseamap"] }); // no wash source present
    const state: WeatherRasterState = { key: resolved().key };
    applyWeatherRaster(asMap(map), resolved(), 1, state);
    expect(map.addSourceCalls).toHaveLength(1);
    expect(map.addLayerCalls).toHaveLength(1);
  });
});

describe("WEATHER_LAYER_IDS", () => {
  test("is just the wash's single slot now (Phase 4 removed the arrows double buffer)", () => {
    expect(WEATHER_LAYER_IDS).toEqual([WEATHER_WASH_LAYER_ID]);
  });
});
