/**
 * `applySatelliteSource` — the reconcile: inert-when-off (the mandatory
 * requirement — no source added when the feature is off, so MapLibre requests
 * ZERO tiles), the online/offline add path with the correct over-chart
 * `beforeId` (above the chart + seamarks band, below any existing overlay), the
 * in-place opacity nudge, and the tear-down/re-add on a source swap. Against a
 * recording map double modelled on the weather-overlay FakeMap, extended with
 * `getStyle` so the insertion position can be asserted.
 */

import { describe, expect, test } from "bun:test";
import type { Map as MLMap } from "maplibre-gl";
import { applySatelliteSource, type SatelliteState } from "./overlay";
import type { ResolvedSatellite } from "./sources";
import type { Palette } from "../../core/style/colors";

interface StyleLayer {
  id: string;
  source?: string;
}

class FakeMap {
  layers: Set<string>;
  sources: Set<string>;
  styleLayers: StyleLayer[];
  ops: string[] = [];
  addSourceCalls: { id: string; spec: Record<string, unknown> }[] = [];
  addLayerCalls: { layer: { id: string; type: string; paint: Record<string, unknown> }; beforeId: string | undefined }[] = [];
  setPaintCalls: { layerId: string; prop: string; value: unknown }[] = [];

  constructor(opts: { layers?: string[]; sources?: string[]; styleLayers?: StyleLayer[] } = {}) {
    this.layers = new Set(opts.layers ?? []);
    this.sources = new Set(opts.sources ?? []);
    this.styleLayers = opts.styleLayers ?? [];
  }
  getStyle() {
    return { layers: this.styleLayers };
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
  addLayer(layer: { id: string; type: string; paint: Record<string, unknown> }, beforeId?: string) {
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
const DAY: Palette = "day";

const online = (over: Partial<ResolvedSatellite> = {}): ResolvedSatellite => ({
  key: "online:esri",
  tiles: "https://example.test/esri/{z}/{y}/{x}",
  attribution: "Esri",
  minzoom: 0,
  maxzoom: 19,
  ...over,
});

const offline = (over: Partial<ResolvedSatellite> = {}): ResolvedSatellite => ({
  key: "offline:oresund:7",
  tiles: "/api/satellite/tiles/oresund/{z}/{x}/{y}",
  attribution: "EOX",
  minzoom: 5,
  maxzoom: 14,
  bounds: [12, 55, 13, 56],
  ...over,
});

// A style with the osm basemap, a chart layer, and the seamarks on top — the
// production shape. The satellite must land just before the first chart layer.
const withChart = () => ({
  styleLayers: [
    { id: "background" },
    { id: "world-earth", source: "osm-world" },
    { id: "chart-US5-depare", source: "chart-US5" },
    { id: "chart-US5-soundg", source: "chart-US5" },
    { id: "openseamap", source: "openseamap" },
  ],
  layers: ["background", "world-earth", "chart-US5-depare", "chart-US5-soundg", "openseamap"],
});

describe("applySatelliteSource — inert when off", () => {
  test("resolved null adds NOTHING — no source, so MapLibre requests zero tiles", () => {
    const map = new FakeMap(withChart());
    const state: SatelliteState = { key: "" };
    applySatelliteSource(asMap(map), null, 1, DAY, state);
    expect(map.addSourceCalls).toHaveLength(0);
    expect(map.addLayerCalls).toHaveLength(0);
    expect(map.getSource("satellite")).toBeUndefined();
  });

  test("resolved null tears down a source that was on (a toggle-off)", () => {
    const map = new FakeMap({ ...withChart(), layers: ["satellite"], sources: ["satellite"] });
    map.layers.add("satellite");
    map.sources.add("satellite");
    const state: SatelliteState = { key: "online:esri" };
    applySatelliteSource(asMap(map), null, 1, DAY, state);
    const li = map.ops.indexOf("removeLayer:satellite");
    const si = map.ops.indexOf("removeSource:satellite");
    expect(li).toBeGreaterThanOrEqual(0);
    expect(si).toBeGreaterThan(li); // layer before source
    expect(state.key).toBe("");
  });
});

describe("applySatelliteSource — the add path", () => {
  test("adds an online source ABOVE the chart + seamarks band", () => {
    const map = new FakeMap(withChart());
    const state: SatelliteState = { key: "" };
    applySatelliteSource(asMap(map), online(), 0.9, DAY, state);

    expect(map.addSourceCalls).toHaveLength(1);
    expect(map.addSourceCalls[0].spec.type).toBe("raster");
    expect(map.addSourceCalls[0].spec.tiles).toEqual(["https://example.test/esri/{z}/{y}/{x}"]);
    // A global online source carries no bounds.
    expect(map.addSourceCalls[0].spec.bounds).toBeUndefined();

    expect(map.addLayerCalls).toHaveLength(1);
    const add = map.addLayerCalls[0];
    expect(add.layer.id).toBe("satellite");
    expect(add.layer.type).toBe("raster");
    expect(add.layer.paint["raster-opacity"]).toBe(0.9);
    // Over the chart: openseamap is the topmost chart-style layer and nothing is
    // above it here, so the imagery appends to the top (undefined) — directly
    // above the chart/seamarks band. See insertBeforeId.
    expect(add.beforeId).toBeUndefined();
    expect(state.key).toBe("online:esri");
  });

  test("inserts BELOW an existing overlay that sits above the seamarks", () => {
    // A style with an overlay layer (a POI marker) already above openseamap: the
    // imagery must land above the chart/seamarks band but below that overlay.
    const withOverlay = new FakeMap({
      styleLayers: [
        { id: "world-earth", source: "osm-world" },
        { id: "chart-US5-depare", source: "chart-US5" },
        { id: "openseamap", source: "openseamap" },
        { id: "poi-marker-dk", source: "poi-dk" },
      ],
      layers: ["world-earth", "chart-US5-depare", "openseamap", "poi-marker-dk"],
    });
    applySatelliteSource(asMap(withOverlay), online(), 1, DAY, { key: "" });
    expect(withOverlay.addLayerCalls[0].beforeId).toBe("poi-marker-dk");
  });

  test("adds a baked offline source with its coverage bounds", () => {
    const map = new FakeMap(withChart());
    const state: SatelliteState = { key: "" };
    applySatelliteSource(asMap(map), offline(), 1, DAY, state);
    expect(map.addSourceCalls[0].spec.tiles).toEqual(["/api/satellite/tiles/oresund/{z}/{x}/{y}"]);
    expect(map.addSourceCalls[0].spec.bounds).toEqual([12, 55, 13, 56]);
    expect(state.key).toBe("offline:oresund:7");
  });

  test("appends to the top when the seamarks are the topmost layer, or the style is bare", () => {
    // openseamap topmost, nothing above it → append to top (just above seamarks).
    const osmOnly = new FakeMap({
      styleLayers: [{ id: "world-earth", source: "osm-world" }, { id: "openseamap", source: "openseamap" }],
      layers: ["world-earth", "openseamap"],
    });
    applySatelliteSource(asMap(osmOnly), online(), 1, DAY, { key: "" });
    expect(osmOnly.addLayerCalls[0].beforeId).toBeUndefined();

    // No chart layer at all → append to the top.
    const bare = new FakeMap({ styleLayers: [{ id: "world-earth", source: "osm-world" }], layers: ["world-earth"] });
    applySatelliteSource(asMap(bare), online(), 1, DAY, { key: "" });
    expect(bare.addLayerCalls[0].beforeId).toBeUndefined();
  });
});

describe("applySatelliteSource — updates and swaps", () => {
  test("an opacity change on the same source is setPaintProperty, never a re-add", () => {
    const map = new FakeMap({ ...withChart(), layers: ["satellite"], sources: ["satellite"] });
    map.layers.add("satellite");
    map.sources.add("satellite");
    const state: SatelliteState = { key: "online:esri" };
    applySatelliteSource(asMap(map), online({ key: "online:esri" }), 0.4, DAY, state);
    expect(map.setPaintCalls).toEqual([
      { layerId: "satellite", prop: "raster-opacity", value: 0.4 },
    ]);
    expect(map.addSourceCalls).toHaveLength(0);
    expect(map.addLayerCalls).toHaveLength(0);
  });

  test("a source swap tears the old down (layer before source) and re-adds", () => {
    const map = new FakeMap({ ...withChart(), layers: ["satellite"], sources: ["satellite"] });
    map.layers.add("satellite");
    map.sources.add("satellite");
    const state: SatelliteState = { key: "online:esri" };
    applySatelliteSource(asMap(map), offline(), 1, DAY, state);

    const rl = map.ops.indexOf("removeLayer:satellite");
    const rs = map.ops.indexOf("removeSource:satellite");
    const as = map.ops.indexOf("addSource:satellite");
    expect(rl).toBeGreaterThanOrEqual(0);
    expect(rs).toBeGreaterThan(rl);
    expect(as).toBeGreaterThan(rs);
    expect(state.key).toBe("offline:oresund:7");
  });

  test("after a style.load wipe (source gone, key unchanged) the layer is re-added", () => {
    // The source was removed by setStyle; state.key still equals the desired key.
    const map = new FakeMap(withChart()); // no satellite source present
    const state: SatelliteState = { key: "online:esri" };
    applySatelliteSource(asMap(map), online({ key: "online:esri" }), 1, DAY, state);
    expect(map.addSourceCalls).toHaveLength(1);
    expect(map.addLayerCalls).toHaveLength(1);
  });
});
