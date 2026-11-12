// The notices overlay against a fake map: idempotent install, inert when
// off (no source, no layer), a palette switch that is a paint/layout swap
// (no layer add/remove), a runtime toggle-on that lands in its z slot rather
// than on top of the stack, and layer filters that pick the right features.
//
// NB: run with `--conditions=browser` (`bun run test`).

import { describe, expect, test } from "bun:test";
import { createPropertyExpression, featureFilter, v8, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { Map as MLMap } from "maplibre-gl";
import { createRoot, createSignal } from "solid-js";
import type { FeatureCollection } from "geojson";
import { Z, type OverlayCtx } from "../../core/layers/overlay";
import { highlightLayers, highlightMagenta } from "../../core/info/highlight";
import { featureOverlayControls } from "../../core/chrome/feature";
import { noticesColors, paletteColors } from "../../core/style/colors";
import { restrictedBoundaryPaint } from "../../core/style/aidsHazards";
import { linePatternImage, PATTERN_BAND_PX } from "../../core/style/cablesPipelines";
import { DEFAULT_SETTINGS, type ChartSettings } from "../../core/style/settings";
import MAP from "./fixtures/map.json";
import { noticeHatch, noticeIconExpr, noticeIconParts } from "./icons";
import { createNoticesToMariners } from "./index";
import {
  applyNoticesPaint,
  FILTERS,
  NOTICE_BCOL,
  NOTICES_CABLE_LAYER_ID,
  NOTICES_LINE_LAYER_ID,
  NOTICES_HIGHLIGHT_FILL_LAYER_ID,
  NOTICES_HIGHLIGHT_LAYER_IDS,
  NOTICES_HIGHLIGHT_SOURCE_ID,
  NOTICES_WARNING_ICON_LAYER_ID,
  createNoticesOverlay,
  ensureNoticesLayers,
  insertBeforeId,
  NOTICES_AREA_HIT_LAYER_ID,
  NOTICES_POINT_HIT_LAYER_ID,
  NOTICES_HATCH_LAYER_ID,
  NOTICES_ICON_LAYER_ID,
  NOTICES_LAYER_IDS,
  NOTICES_OUTLINE_LAYER_ID,
  NOTICES_QUERY_LAYER_IDS,
  NOTICES_SOURCE_ID,
  NOTICES_ZOOM,
} from "./overlay";
import { shapeNotices } from "./shape";
import { noticesFilterOf, prepareNotices } from "./time";
import type { NoticesMap } from "./types";

type Spec = { id: string; type: string; filter?: unknown; paint?: Record<string, unknown>; layout?: Record<string, unknown>; minzoom?: number; maxzoom?: number };

function fakeMap(initial: Spec[] = []) {
  const sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  const order: Spec[] = [...initial];
  const calls = { addLayer: 0, removeLayer: 0, addSource: 0, setData: [] as unknown[], paint: [] as [string, string, unknown][], layout: [] as [string, string, unknown][] };
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, s: { data: unknown }) => {
      calls.addSource++;
      const src = { data: s.data, setData: (d: unknown) => calls.setData.push((src.data = d)) };
      sources.set(id, src);
    },
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => order.find((l) => l.id === id),
    addLayer: (spec: Spec, before?: string) => {
      calls.addLayer++;
      const i = before ? order.findIndex((l) => l.id === before) : -1;
      if (i >= 0) order.splice(i, 0, spec);
      else order.push(spec);
    },
    removeLayer: (id: string) => {
      calls.removeLayer++;
      order.splice(order.findIndex((l) => l.id === id), 1);
    },
    moveLayer: (id: string, before?: string) => {
      const [l] = order.splice(order.findIndex((x) => x.id === id), 1);
      const i = before ? order.findIndex((x) => x.id === before) : -1;
      if (i >= 0) order.splice(i, 0, l!);
      else order.push(l!);
    },
    getStyle: () => ({ layers: order }),
    setPaintProperty: (id: string, prop: string, v: unknown) => calls.paint.push([id, prop, v]),
    setLayoutProperty: (id: string, prop: string, v: unknown) => calls.layout.push([id, prop, v]),
    // no `addImage`: ensureNoticeImages is a no-op without a canvas map
  };
  return { map: map as unknown as MLMap, order, sources, calls };
}

const ctxWith = (patch: Partial<ChartSettings> = {}): OverlayCtx =>
  ({ settings: () => ({ ...DEFAULT_SETTINGS, ...patch }) }) as unknown as OverlayCtx;

const NOW = 1791028800000;
const PREPARED = prepareNotices(MAP as unknown as NoticesMap, noticesFilterOf(DEFAULT_SETTINGS), NOW);

describe("install", () => {
  test("ensure is idempotent: one source, each layer once, bottom → top", () => {
    const f = fakeMap();
    ensureNoticesLayers(f.map, "day");
    ensureNoticesLayers(f.map, "day");
    expect(f.calls.addSource).toBe(1);
    expect(f.calls.addLayer).toBe(NOTICES_LAYER_IDS.length);
    expect(f.order.map((l) => l.id)).toEqual([...NOTICES_LAYER_IDS]);
  });

  test("every layer is a valid MapLibre layer", () => {
    const f = fakeMap();
    ensureNoticesLayers(f.map, "night");
    const errors = validateStyleMin({
      version: 8,
      glyphs: "https://example.invalid/{fontstack}/{range}.pbf",
      sources: { [NOTICES_SOURCE_ID]: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers: f.order as never,
    });
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test("zoom bands: no point marker below z10, icons from z10, ids z11, vertex labels z13", () => {
    const f = fakeMap();
    ensureNoticesLayers(f.map, "day");
    const byId = (id: string) => f.order.find((l) => l.id === id)!;
    // User: "when i zoom out the icons disappear but are replaced by dots,
    // im guessing they should just disappear" — nothing draws a point
    // feature below the icon zoom (the outlines carry the zoomed-out view).
    for (const l of f.order) {
      if (l.type === "circle" || l.type === "symbol") expect(l.minzoom ?? 0).toBeGreaterThanOrEqual(NOTICES_ZOOM.icons);
    }
    // The one circle layer is the invisible tap target, never a dot.
    const circles = f.order.filter((l) => l.type === "circle");
    expect(circles.map((l) => l.id)).toEqual([NOTICES_POINT_HIT_LAYER_ID]);
    expect(circles[0]!.paint!["circle-opacity"]).toBe(0);
    expect(byId("notices-icon").minzoom).toBe(10);
    // The shortId label is the icon symbol's own text, from z11.
    const label = evalProp(byId("notices-icon"), "layout", "text-field", { lbl: "NM-842" }, 10.9);
    expect(String(label)).toBe("");
    expect(String(evalProp(byId("notices-icon"), "layout", "text-field", { lbl: "NM-842" }, 11))).toBe("NM-842");
    expect(byId("notices-vertex-label").minzoom).toBe(13);
  });
});

describe("inert when off", () => {
  test("off: ensure and update add no source and no layer", () => {
    const f = fakeMap();
    const ov = createNoticesOverlay({ enabled: () => false, features: () => PREPARED });
    ov.ensure(f.map, ctxWith());
    ov.update(f.map, ctxWith());
    expect(f.calls.addSource).toBe(0);
    expect(f.calls.addLayer).toBe(0);
    expect(f.calls.setData).toEqual([]);
  });

  test("turning off removes every layer and the source; on again re-installs and feeds", () => {
    const f = fakeMap();
    const [on, setOn] = createSignal(true);
    const ov = createNoticesOverlay({ enabled: on, features: () => PREPARED });
    ov.ensure(f.map, ctxWith());
    ov.update(f.map, ctxWith());
    expect(f.calls.setData.at(-1)).toBe(PREPARED);
    setOn(false);
    ov.update(f.map, ctxWith());
    expect(f.order).toEqual([]);
    expect(f.sources.has(NOTICES_SOURCE_ID)).toBe(false);
    setOn(true);
    ov.update(f.map, ctxWith());
    expect(f.order.map((l) => l.id)).toEqual([...NOTICES_LAYER_IDS]);
    expect(f.calls.setData.at(-1)).toBe(PREPARED);
  });

  test("a runtime toggle-on lands above the chart/POI band and BELOW the overlays above it", () => {
    // The default stack between loads: chart, POI marker, then the hoisted
    // track/route/AIS/own-ship. No re-hoist follows a toggle, so the add itself
    // must not put the notices over the route or the boat.
    const f = fakeMap([
      { id: "background", type: "background" },
      { id: "chart-dk-depare", type: "fill", ...({ source: "chart-dk" } as object) },
      { id: "poi-marker", type: "symbol" },
      { id: "track-casing", type: "line" },
      { id: "route-line", type: "line" },
      { id: "signalk-own-ship", type: "symbol" },
    ]);
    expect(insertBeforeId(f.map)).toBe("track-casing");
    const ov = createNoticesOverlay({ enabled: () => true, features: () => PREPARED });
    ov.update(f.map, ctxWith());
    const ids = f.order.map((l) => l.id);
    const first = NOTICES_LAYER_IDS[0];
    expect(ids.indexOf(first)).toBeGreaterThan(ids.indexOf("poi-marker"));
    expect(ids.indexOf("notices-vertex-label")).toBeLessThan(ids.indexOf("track-casing"));
    expect(ids.slice(ids.indexOf(first), ids.indexOf(first) + NOTICES_LAYER_IDS.length)).toEqual([
      ...NOTICES_LAYER_IDS,
    ]);
    expect(ids.at(-1)).toBe("signalk-own-ship");
  });
});

describe("palette", () => {
  test("a palette switch is a paint/layout swap — no layer added or removed", () => {
    const f = fakeMap();
    ensureNoticesLayers(f.map, "day");
    const before = { add: f.calls.addLayer, remove: f.calls.removeLayer };
    applyNoticesPaint(f.map, "night");
    expect(f.calls.addLayer).toBe(before.add);
    expect(f.calls.removeLayer).toBe(before.remove);
    const night = noticesColors("night");
    expect(f.calls.paint).toContainEqual([NOTICES_HATCH_LAYER_ID, "fill-pattern", noticeHatch("night")]);
    expect(f.calls.layout).toContainEqual([NOTICES_ICON_LAYER_ID, "icon-image", noticeIconExpr("night")]);
    // The chart-styled lines follow the CHART palette, exactly as the chart does.
    const chartNight = restrictedBoundaryPaint(paletteColors("night"), NOTICE_BCOL);
    expect(f.calls.paint).toContainEqual([NOTICES_OUTLINE_LAYER_ID, "line-color", chartNight["line-color"]]);
    expect(f.calls.paint).toContainEqual([NOTICES_CABLE_LAYER_ID, "line-pattern", linePatternImage("cable", paletteColors("night"), ["literal", "CHMGD"])]);
  });

  test("night is dim: no notices colour is brighter than day's", () => {
    // A dark-adapted eye: every family colour at night must be darker than day's.
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1, 7), 16);
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    const day = noticesColors("day");
    const night = noticesColors("night");
    for (const k of ["warning", "firing", "temporary", "preliminary", "permanent"] as const) {
      expect(lum(night[k])).toBeLessThan(lum(day[k]));
      expect(lum(night[k])).toBeLessThan(80);
    }
  });

  test("paint on a map without the overlay is a no-op", () => {
    const f = fakeMap();
    expect(() => applyNoticesPaint(f.map, "dusk")).not.toThrow();
    expect(f.calls.paint).toEqual([]);
  });
});

describe("layer filters pick the right features", () => {
  const f = fakeMap();
  ensureNoticesLayers(f.map, "day");
  const pick = (layerId: string, fc: FeatureCollection = PREPARED, zoom = 12) => {
    const filter = featureFilter(f.order.find((l) => l.id === layerId)!.filter as never);
    return fc.features
      .filter((x) => filter.filter({ zoom } as never, { properties: x.properties, type: 1 } as never))
      .map((x) => `${x.properties!.msg}:${x.properties!.role}`);
  };

  test("hatch: exactly the areas firing today", () => {
    expect(pick(NOTICES_HATCH_LAYER_ID)).toEqual(["a5b6-fe-1:area", "e9fa-fa-32:area"]);
  });

  test("outline: the boundary edges, the quiet firing area's included; never the polygons", () => {
    expect(pick(NOTICES_OUTLINE_LAYER_ID)).toContain("c7d8-fa-18:edge");
    expect(pick(NOTICES_OUTLINE_LAYER_ID).every((x) => x.endsWith(":edge"))).toBe(true);
  });

  test("icons: points and anchors, never vertices", () => {
    const icons = pick(NOTICES_ICON_LAYER_ID);
    expect(icons.every((x) => x.endsWith(":point") || x.endsWith(":anchor"))).toBe(true);
    expect(icons).toContain("4f50-nm-900:anchor");
    expect(icons).toContain("0a0b-gl-1:point"); // Greenland renders
  });

  test("sub badges only where a known `sub` is set", () => {
    const badged = PREPARED.features
      .filter((x) => x.properties.role === "point" || x.properties.role === "anchor")
      .filter((x) => noticeIconParts(x.properties).mark !== "none")
      .map((x) => `${x.properties!.msg}:${x.properties!.role}`);
    expect(badged).toEqual(["0b1c-nw-372:point", "6172-nm-500:point", "0a0b-gl-1:point"]);
  });

  test("vertex labels: numbered vertices and labelled points", () => {
    expect(pick("notices-vertex-label")).toEqual([
      "0b1c-nw-372:point",
      "2d3e-nm-842:vertex",
      "2d3e-nm-842:vertex",
      "a5b6-fe-1:point",
    ]);
  });

  test("lines: cables on the cable layer, every other line on the boundary layer", () => {
    const lines = PREPARED.features.filter((x) => x.properties.role === "line" && !x.properties.dup);
    const cables = lines.filter((x) => x.properties.cls === "cable").map((x) => `${x.properties.msg}:line`);
    expect(cables.length).toBeGreaterThan(0);
    expect(pick(NOTICES_CABLE_LAYER_ID)).toEqual(cables);
    expect(pick(NOTICES_LINE_LAYER_ID).length).toBe(lines.length - cables.length);
  });
});

describe("the feature", () => {
  test("sits between POI and the track, in the reorderable band", () => {
    const ov = createNoticesOverlay({ enabled: () => true, features: () => PREPARED });
    expect(ov.z).toBe(Z.notices);
    expect(Z.notices).toBeGreaterThan(Z.poi);
    expect(Z.notices).toBeLessThan(Z.track);
    expect(Z.notices).toBeLessThan(Z.route);
    expect(ov.layerIds).toEqual([...NOTICES_LAYER_IDS, ...NOTICES_HIGHLIGHT_LAYER_IDS]);
  });

  test("one Layers-panel row drives showNotices; toggles drive the prepared data", () => {
    createRoot((dispose) => {
      const [settings, setSettings] = createSignal<ChartSettings>({ ...DEFAULT_SETTINGS });
      const nm = createNoticesToMariners({
        settings,
        fetchStatus: async () => undefined,
        schedule: () => () => {},
      });
      const rows = featureOverlayControls([nm.feature], {
        settings,
        setSettings: (p) => setSettings((s) => ({ ...s, ...p })),
        activeMode: () => null,
      });
      expect(rows.map((r) => r.id)).toEqual(["notices"]);
      expect(rows[0]!.visible()).toBe(true);
      rows[0]!.setVisible(false);
      expect(settings().showNotices).toBe(false);
      dispose();
    });
  });
});

/** Evaluate a paint/layout property of a built layer for one feature. */
function evalProp(
  layer: Spec,
  group: "paint" | "layout",
  prop: string,
  props: Record<string, unknown>,
  zoom: number,
): unknown {
  const value = (layer[group] as Record<string, unknown>)[prop];
  const spec = (v8 as never as Record<string, Record<string, unknown>>)[`${group}_${layer.type}`]![prop];
  const r = createPropertyExpression(value, spec as never);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  return r.value.evaluate({ zoom } as never, { properties: props } as never);
}

describe("area portrayal: the chart's own boundary, no wash", () => {
  const f = fakeMap();
  ensureNoticesLayers(f.map, "day");
  const layer = (id: string) => f.order.find((l) => l.id === id)!;
  const C = paletteColors("day");

  test("no band, no wash: the only VISIBLE fill is the firing-today hatch", () => {
    expect(NOTICES_LAYER_IDS as readonly string[]).not.toContain("notices-band");
    const fills = f.order.filter((l) => l.type === "fill").map((l) => l.id);
    expect(fills).toEqual([NOTICES_AREA_HIT_LAYER_ID, NOTICES_HATCH_LAYER_ID]);
    // The hit layer paints nothing.
    expect(layer(NOTICES_AREA_HIT_LAYER_ID).paint!["fill-opacity"]).toBe(0);
  });

  test("the interior is a tap target through the invisible hit fill (areas only), the hatch is not", () => {
    // User: "when clicking in the middle of a area the notice for mariners
    // should also show up" — the provider ranks that hit area-tier.
    expect(NOTICES_QUERY_LAYER_IDS).toContain(NOTICES_AREA_HIT_LAYER_ID);
    expect(NOTICES_QUERY_LAYER_IDS).toContain(NOTICES_OUTLINE_LAYER_ID);
    expect(NOTICES_QUERY_LAYER_IDS).not.toContain(NOTICES_HATCH_LAYER_ID);
    const fills = NOTICES_QUERY_LAYER_IDS.filter((id) => layer(id).type === "fill");
    expect(fills).toEqual([NOTICES_AREA_HIT_LAYER_ID]);
    const flt = featureFilter(layer(NOTICES_AREA_HIT_LAYER_ID).filter as never);
    const hit = PREPARED.features.filter((x) => flt.filter({ zoom: 12 } as never, { properties: x.properties, type: 3 } as never));
    expect(hit.length).toBeGreaterThan(0);
    expect(hit).toEqual(PREPARED.features.filter((x) => x.properties.role === "area"));
  });

  test("every icon position is a tap target, placed or not: an invisible circle under the icons", () => {
    // Notices share positions (a warning and the NM for the same light), and
    // a symbol that lost its collision is not returned by a rendered query.
    const hit = layer(NOTICES_POINT_HIT_LAYER_ID);
    expect(hit.type).toBe("circle");
    expect(hit.paint!["circle-opacity"]).toBe(0);
    expect(hit.minzoom).toBe(layer(NOTICES_ICON_LAYER_ID).minzoom);
    expect(NOTICES_QUERY_LAYER_IDS).toContain(NOTICES_POINT_HIT_LAYER_ID);
    // Exactly the features the two icon layers take between them.
    const take = (id: string) => {
      const flt = featureFilter(layer(id).filter as never);
      return PREPARED.features.filter((x) => flt.filter({ zoom: 12 } as never, { properties: x.properties, type: 1 } as never));
    };
    const icons = [...take(NOTICES_ICON_LAYER_ID), ...take(NOTICES_WARNING_ICON_LAYER_ID)];
    expect(icons.length).toBeGreaterThan(0);
    expect(new Set(take(NOTICES_POINT_HIT_LAYER_ID))).toEqual(new Set(icons));
    // Under the symbols, so the stack reads hit targets → labels → icons.
    const ids = f.order.map((l) => l.id);
    expect(ids.indexOf(NOTICES_POINT_HIT_LAYER_ID)).toBeLessThan(ids.indexOf(NOTICES_ICON_LAYER_ID));
  });

  test("firing areas wear the chart's MIPARE boundary (CHMGD), everything else CTNARE's (TRFCD)", () => {
    for (const id of [NOTICES_OUTLINE_LAYER_ID, NOTICES_LINE_LAYER_ID]) {
      const color = (fam: string) => evalProp(layer(id), "paint", "line-color", { fam }, 11);
      const chart = (bcol: string) => evalProp({ id: "x", type: "line", paint: restrictedBoundaryPaint(C) }, "paint", "line-color", { bcol }, 11);
      expect(color("fe")).toEqual(chart("CHMGD"));
      expect(color("fa")).toEqual(chart("CHMGD"));
      for (const fam of ["nw", "nm-t", "nm-p", "nm-perm"]) expect(color(fam)).toEqual(chart("TRFCD"));
      // The chart's own width and dash, untouched.
      expect(evalProp(layer(id), "paint", "line-width", {}, 11)).toBe(2);
      expect(layer(id).paint!["line-dasharray"]).toEqual(restrictedBoundaryPaint(C)["line-dasharray"]);
    }
  });

  test("time state is opacity only: upcoming dimmed, active full", () => {
    const op = (st: string) => evalProp(layer(NOTICES_OUTLINE_LAYER_ID), "paint", "line-opacity", { st }, 11) as number;
    expect(op("a")).toBe(1);
    expect(op("u")).toBeLessThan(1);
    expect(op("e")).toBeLessThan(op("u"));
  });

  test("a cable is the chart's CBLSUB pattern", () => {
    const cable = layer(NOTICES_CABLE_LAYER_ID);
    expect(cable.paint!["line-width"]).toBe(PATTERN_BAND_PX);
    expect(evalProp(cable, "paint", "line-pattern", {}, 11)).toEqual(
      evalProp({ id: "x", type: "line", paint: { "line-pattern": linePatternImage("cable", C) } }, "paint", "line-pattern", { bcol: "CHMGD" }, 11),
    );
  });

  test("firing today keeps its hatch fill (user: \"the firing now can get the fill\")", () => {
    expect(layer(NOTICES_HATCH_LAYER_ID).paint!["fill-pattern"]).toBe(noticeHatch("day"));
  });

  test("smaller areas sort above larger ones (line/fill sort key = −area)", () => {
    const shaped = prepareNotices(shapeNotices(MAP as unknown as NoticesMap), noticesFilterOf(DEFAULT_SETTINGS), NOW);
    const areas = shaped.features.filter((x) => x.properties.role === "area");
    expect(areas.length).toBeGreaterThan(1);
    for (const id of [NOTICES_OUTLINE_LAYER_ID]) {
      const key = (p: Record<string, unknown>) => evalProp(layer(id), "layout", "line-sort-key", p, 12) as number;
      const byKey = [...areas].sort((a, b) => key(a.properties) - key(b.properties));
      // Ascending key = drawn bottom → top = largest → smallest.
      const sizes = byKey.map((x) => -(x.properties.ar ?? 0));
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    }
  });
});

describe("icon density", () => {
  const f = fakeMap();
  ensureNoticesLayers(f.map, "day");
  const layer = (id: string) => f.order.find((l) => l.id === id)!;

  test("warnings never drop; everything else yields, firing first", () => {
    expect(layer(NOTICES_WARNING_ICON_LAYER_ID).layout!["icon-allow-overlap"]).toBe(true);
    expect(layer(NOTICES_ICON_LAYER_ID).layout!["icon-allow-overlap"]).toBe(false);
    const key = (fc: string) => evalProp(layer(NOTICES_ICON_LAYER_ID), "layout", "symbol-sort-key", { fc }, 12) as number;
    expect(key("firing")).toBeLessThan(key("temporary"));
    expect(key("temporary")).toBeLessThan(key("permanent"));
    expect(key("permanent")).toBeLessThan(key("inactive"));
    // Placed above the yielding icons, so a warning is placed first.
    const ids = f.order.map((l) => l.id);
    expect(ids.indexOf(NOTICES_WARNING_ICON_LAYER_ID)).toBeGreaterThan(ids.indexOf(NOTICES_ICON_LAYER_ID));
  });

  test("the warning and non-warning icon layers split the markers exactly", () => {
    const pick = (id: string) => {
      const flt = featureFilter(layer(id).filter as never);
      return PREPARED.features.filter((x) => flt.filter({ zoom: 12 } as never, { properties: x.properties, type: 1 } as never));
    };
    const nw = pick(NOTICES_WARNING_ICON_LAYER_ID);
    const rest = pick(NOTICES_ICON_LAYER_ID);
    expect(nw.length).toBeGreaterThan(0);
    expect(nw.every((x) => x.properties.fc === "warning")).toBe(true);
    expect(rest.some((x) => x.properties.fc === "warning")).toBe(false);
    const markers = PREPARED.features.filter((x) => x.properties.role === "point" || x.properties.role === "anchor");
    expect(nw.length + rest.length).toBe(markers.length);
  });

  test("badge and label ride on the icon symbol: no separate sub/label layer to orphan", () => {
    const icon = layer(NOTICES_ICON_LAYER_ID);
    // The label may yield; the icon may not yield to its own label.
    expect(icon.layout!["text-optional"]).toBe(true);
    expect(icon.layout!["icon-optional"]).toBe(false);
    expect(f.order.some((l) => l.id === "notices-sub" || l.id === "notices-label")).toBe(false);
    // Vertex labels sit BELOW the icons (placed after them, so they yield).
    const ids = f.order.map((l) => l.id);
    expect(ids.indexOf("notices-vertex-label")).toBeLessThan(ids.indexOf(NOTICES_ICON_LAYER_ID));
  });
});

describe("selected-notice highlight", () => {
  const selected: FeatureCollection = {
    type: "FeatureCollection",
    features: PREPARED.features.filter((x) => x.properties.msg === "2d3e-nm-842"),
  };

  test("no selection: nothing installed even with the overlay off", () => {
    const f = fakeMap();
    const ov = createNoticesOverlay({ enabled: () => false, features: () => PREPARED, highlight: () => null });
    ov.ensure(f.map, ctxWith());
    ov.update(f.map, ctxWith());
    expect(f.calls.addSource).toBe(0);
    expect(f.order).toEqual([]);
  });

  test("a selection with the overlay OFF still draws the highlight; clearing removes it", () => {
    const f = fakeMap();
    const [hl, setHl] = createSignal<FeatureCollection | null>(selected);
    const ov = createNoticesOverlay({ enabled: () => false, features: () => PREPARED, highlight: hl });
    ov.ensure(f.map, ctxWith());
    ov.update(f.map, ctxWith());
    expect(f.order.map((l) => l.id)).toEqual([...NOTICES_HIGHLIGHT_LAYER_IDS]);
    expect(f.sources.get(NOTICES_HIGHLIGHT_SOURCE_ID)!.data).toBe(selected);
    expect(f.sources.has(NOTICES_SOURCE_ID)).toBe(false);
    setHl(null);
    ov.update(f.map, ctxWith());
    expect(f.order).toEqual([]);
    expect(f.sources.has(NOTICES_HIGHLIGHT_SOURCE_ID)).toBe(false);
  });

  test("toggling the overlay on under a live highlight keeps the highlight on top", () => {
    const f = fakeMap([
      { id: "background", type: "background" },
      { id: "track-casing", type: "line" },
    ]);
    const [on, setOn] = createSignal(false);
    const ov = createNoticesOverlay({ enabled: on, features: () => PREPARED, highlight: () => selected });
    ov.ensure(f.map, ctxWith());
    ov.update(f.map, ctxWith());
    setOn(true);
    ov.update(f.map, ctxWith());
    expect(f.order.map((l) => l.id)).toEqual([
      "background",
      ...NOTICES_LAYER_IDS,
      ...NOTICES_HIGHLIGHT_LAYER_IDS,
      "track-casing",
    ]);
  });

  test("the chart's own selection look: the same wash, halo and edge a tapped depth area gets", () => {
    // User: "when clicked mark the whole area like when clicking on a depth area".
    const f = fakeMap();
    const ov = createNoticesOverlay({ enabled: () => false, features: () => PREPARED, highlight: () => selected });
    ov.ensure(f.map, ctxWith());
    ov.update(f.map, ctxWith());
    const chart = highlightLayers({ source: "chart-x", sourceLayer: "DEPARE", filter: ["==", ["id"], 1] }, DEFAULT_SETTINGS.palette);
    const mine = f.order.filter((l) => l.type !== "circle");
    expect(mine.map((l) => l.type)).toEqual(chart.map((l) => l.type));
    mine.forEach((l, i) => expect(l.paint).toEqual((chart[i] as Spec).paint));
    // GeoJSON source: no `source-layer`.
    for (const l of mine) expect("source-layer" in l).toBe(false);
    // The wash fills the selected notice's polygons only, never a line/point.
    const fill = featureFilter(mine[0]!.filter as never);
    const types = { Point: 1, LineString: 2, Polygon: 3 } as Record<string, number>;
    const washed = selected.features.filter((x) =>
      fill.filter({ zoom: 12 } as never, { properties: x.properties, type: types[x.geometry.type] ?? 3 } as never),
    );
    expect(washed.length).toBeGreaterThan(0);
    expect(washed.every((x) => x.properties!.role === "area")).toBe(true);
  });

  test("a palette switch recolours the highlight to that palette's chart magenta", () => {
    const f = fakeMap();
    const ov = createNoticesOverlay({ enabled: () => false, features: () => PREPARED, highlight: () => selected });
    ov.ensure(f.map, ctxWith());
    ov.update(f.map, ctxWith());
    ov.paint(f.map, ctxWith({ palette: "night" }));
    expect(f.calls.paint).toContainEqual([NOTICES_HIGHLIGHT_FILL_LAYER_ID, "fill-color", highlightMagenta("night")]);
    expect(f.calls.paint).toContainEqual(["notices-hl-line", "line-color", highlightMagenta("night")]);
  });

  test("with the overlay on, the highlight sits above every overlay layer", () => {
    const f = fakeMap();
    const ov = createNoticesOverlay({ enabled: () => true, features: () => PREPARED, highlight: () => selected });
    ov.ensure(f.map, ctxWith());
    ov.update(f.map, ctxWith());
    expect(f.order.map((l) => l.id)).toEqual([...NOTICES_LAYER_IDS, ...NOTICES_HIGHLIGHT_LAYER_IDS]);
  });
});
