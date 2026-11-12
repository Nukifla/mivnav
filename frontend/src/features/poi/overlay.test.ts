/**
 * The POI overlay (#xnlxroux): `ensure`/`update` install ONE vector source (an
 * absolute "/api/…/tiles/all/…" URL, with ODbL attribution) + ONE marker
 * layer, regardless of how many POI sets the catalog carries — every set
 * composites into the union tile server-side (#wuvqsnxy). Installed only while
 * `showPois` is on and at least one set is not fully disabled — off (or
 * every set disabled) makes the desired state empty, so `reconcile` removes
 * the source+layers and adds nothing (no `/poi/tiles/all` fetch). A disabled
 * set stays IN the request (its POIs still have to reach the union for
 * whichever sets ARE enabled) and is excluded by a `["get","set"]` layer
 * filter instead. Driven against a Map-shaped double — no WebGL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { Map as MLMap } from "maplibre-gl";
import type { ChartSet } from "../../core/catalog";
import type { OverlayCtx } from "../../core/layers/overlay";
import { Z } from "../../core/layers/overlay";
import { DEFAULT_SETTINGS, type ChartSettings } from "../../core/style/settings";
import {
  applyPoiPaint,
  createPoiOverlay,
  POI_ALL_SOURCE_ID,
  harbourOnly,
  POI_ATTRIBUTION,
  POI_HARBOUR_ZOOM,
  POI_LAYER_IDS,
  POI_MARKER_LAYER_ID,
  POI_SOURCE_LAYER,
} from "./overlay";
import { registerPoiSource, resetPoiSources } from "./sources";

const setFixture = (id: string, overrides: Partial<ChartSet> = {}): ChartSet => ({
  id,
  name: id,
  bounds: [-122.29, 37.77, -122.26, 37.8],
  min_zoom: 6,
  max_zoom: 14,
  sequence: 1,
  tiles: `/poi/tiles/${id}/{z}/{x}/{y}`,
  vector_layers: [],
  ...overrides,
});

const DENMARK = setFixture("denmark");
const UK = setFixture("uk");

function fakeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const layout = new Map<string, Record<string, unknown>>();
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, s: Record<string, unknown>) => sources.set(id, s),
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => layers.get(id),
    addLayer: (spec: Record<string, unknown>) => layers.set(spec.id as string, spec),
    removeLayer: (id: string) => {
      layers.delete(id);
      layout.delete(id);
    },
    setLayoutProperty: (id: string, k: string, v: unknown) => {
      const m = layout.get(id) ?? {};
      m[k] = v;
      layout.set(id, m);
    },
    setPaintProperty: () => {},
    setFilter: (id: string, filter: unknown) => {
      const l = layers.get(id);
      if (l) l.filter = filter;
    },
  };
  return { map: map as unknown as MLMap, sources, layers, layout };
}

const ctxWith = (settings: ChartSettings): OverlayCtx =>
  ({ settings: () => settings }) as unknown as OverlayCtx;

// `showPois` defaults OFF (the overlay is inert when disabled — no source), so
// every install test drives it explicitly ON.
const POIS_ON: ChartSettings = { ...DEFAULT_SETTINGS, showPois: true };
const ctxOn = (): OverlayCtx => ctxWith(POIS_ON);

describe("ensure", () => {
  test("installs the union vector source with ODbL attribution", () => {
    const f = fakeMap();
    createPoiOverlay({ sets: () => [DENMARK] }).ensure(f.map, ctxOn());
    const src = f.sources.get(POI_ALL_SOURCE_ID)!;
    expect(src.type).toBe("vector");
    expect(src.tiles).toEqual([`${location.origin}/api/poi/tiles/all/{z}/{x}/{y}`]);
    expect(src.attribution).toBe(POI_ATTRIBUTION);
    expect(src.minzoom).toBe(6);
    expect(src.maxzoom).toBe(14);
  });

  test("union minzoom/maxzoom is min/max over every contributing set", () => {
    const f = fakeMap();
    const lowCeiling = setFixture("lowceiling", { min_zoom: 8, max_zoom: 11 });
    createPoiOverlay({ sets: () => [DENMARK, lowCeiling] }).ensure(f.map, ctxOn());
    const src = f.sources.get(POI_ALL_SOURCE_ID)!;
    // min_zoom: the LOWEST floor (never suppress a set's own zoom range).
    expect(src.minzoom).toBe(6);
    // max_zoom: the HIGHEST ceiling (#xnlxroux open question 1 — matches the
    // highest-detail set; lowCeiling's own features vanish above ITS OWN 11,
    // not the union's 14, an accepted narrow gap — see overlay.ts's header).
    expect(src.maxzoom).toBe(14);
  });

  test("bounds is the bbox union of every set", () => {
    const f = fakeMap();
    const other = setFixture("other", { bounds: [10, 50, 12, 52] });
    createPoiOverlay({ sets: () => [DENMARK, other] }).ensure(f.map, ctxOn());
    expect(f.sources.get(POI_ALL_SOURCE_ID)!.bounds).toEqual([-122.29, 37.77, 12, 52]);
  });

  test("adds ONE marker layer on the pois source-layer, regardless of set count", () => {
    const f = fakeMap();
    createPoiOverlay({ sets: () => [DENMARK, UK] }).ensure(f.map, ctxOn());
    const marker = f.layers.get(POI_MARKER_LAYER_ID)!;
    expect(marker.type).toBe("symbol");
    expect(marker.source).toBe(POI_ALL_SOURCE_ID);
    expect(marker["source-layer"]).toBe(POI_SOURCE_LAYER);
    const mlayout = marker.layout as Record<string, unknown>;
    const iconImage = mlayout["icon-image"] as unknown[];
    // No plugin source: by kind (icons.test.ts has the full shape).
    expect(iconImage.slice(0, 2)).toEqual(["match", ["get", "kind"]]);
    expect(mlayout["icon-allow-overlap"]).toBe(true);
    expect(mlayout["icon-ignore-placement"]).toBe(true);
    expect(mlayout["symbol-sort-key"]).toEqual(["get", "min_zoom"]);
    // Two sets, ONE source, ONE layer — the whole point of the union.
    expect(f.sources.size).toBe(1);
    expect(f.layers.size).toBe(1);
  });

  test("no layer draws text: this overlay is icon-only since nvpxzxxq", () => {
    // The settlement labels it used to draw moved to the basemap's own
    // `world-places` layer, together with the ingest that baked them.
    const f = fakeMap();
    createPoiOverlay({ sets: () => [DENMARK, UK] }).ensure(f.map, ctxOn());
    for (const layer of f.layers.values()) {
      expect((layer.layout as Record<string, unknown>)["text-field"]).toBeUndefined();
    }
  });

  test("is idempotent and hands the map to the provider via onMap", () => {
    const f = fakeMap();
    let handed: MLMap | undefined;
    const o = createPoiOverlay({ sets: () => [DENMARK], onMap: (m) => (handed = m) });
    o.ensure(f.map, ctxOn());
    o.ensure(f.map, ctxOn());
    expect(handed).toBe(f.map);
    expect(f.sources.size).toBe(1);
    expect(f.layers.size).toBe(1);
  });

  test("installs nothing while the catalog is still empty", () => {
    const f = fakeMap();
    createPoiOverlay({ sets: () => [] }).ensure(f.map, ctxOn());
    expect(f.sources.size).toBe(0);
    expect(f.layers.size).toBe(0);
  });
});

describe("reconcile", () => {
  test("a set appearing after the first ensure rebuilds the source (fresh bounds/zoom)", () => {
    const f = fakeMap();
    let sets: ChartSet[] = [DENMARK];
    const o = createPoiOverlay({ sets: () => sets });
    o.ensure(f.map, ctxOn());
    expect(f.sources.get(POI_ALL_SOURCE_ID)!.maxzoom).toBe(14);

    const wide = setFixture("wide", { max_zoom: 19 });
    sets = [DENMARK, wide];
    o.update(f.map, ctxOn());
    // The union's own maxzoom now reflects the newly-arrived, higher-ceiling set.
    expect(f.sources.get(POI_ALL_SOURCE_ID)!.maxzoom).toBe(19);
    expect(f.sources.size).toBe(1);
    expect(f.layers.size).toBe(1);
  });

  test("every set disabled tears the union down entirely, not filtered to empty", () => {
    const f = fakeMap();
    const o = createPoiOverlay({
      sets: () => [DENMARK, UK],
      disabledSets: () => [DENMARK.id, UK.id],
    });
    o.ensure(f.map, ctxOn());
    // A layer filter hides features, it does not stop the tile FETCH — with
    // nothing left for the union to draw, there is no point paying the Pi to
    // cut and gzip an always-empty /tiles/all (CLAUDE.md: tiles cost Pi CPU).
    expect(f.sources.size).toBe(0);
    expect(f.layers.size).toBe(0);
  });

  test("partial disabling still installs the source — the disabled set's POIs must still reach the union", () => {
    const f = fakeMap();
    const o = createPoiOverlay({
      sets: () => [DENMARK, UK],
      disabledSets: () => [DENMARK.id],
    });
    o.ensure(f.map, ctxOn());
    expect(f.sources.size).toBe(1);
    expect(f.layers.size).toBe(1);
  });

  test("recovers after a style reload wipes the source/layers (unchanged set list)", () => {
    const f = fakeMap();
    const o = createPoiOverlay({ sets: () => [DENMARK] });
    o.ensure(f.map, ctxOn());
    expect(f.sources.size).toBe(1);
    expect(f.layers.size).toBe(1);

    // Simulate a palette switch's setStyle(diff): the imperative overlay
    // source/layers are wiped, but nothing about `sets`/`disabledSets`
    // changed, so the overlay's own `signature` bookkeeping is unchanged too.
    f.sources.clear();
    f.layers.clear();

    o.ensure(f.map, ctxOn());
    expect(f.sources.size).toBe(1);
    expect(f.layers.size).toBe(1);
  });
});

describe("harbour-only types, a plugin source's and OSM's alike — hidden below the archives' max zoom, no re-bake", () => {
  // A plugin source declaring its harbour office type harbour-only.
  beforeAll(() =>
    registerPoiSource({
      id: "fake",
      label: "Fake",
      harbourOnly: [{ prop: "kind_detail", values: ["marina_office"] }],
    }),
  );
  afterAll(resetPoiSources);
  const at = (zoom: number, filter: unknown, props: Record<string, unknown>) =>
    featureFilter(filter as never).filter({ zoom } as never, { properties: props } as never);
  const marker = () => {
    const f = fakeMap();
    createPoiOverlay({ sets: () => [DENMARK] }).ensure(f.map, ctxOn());
    return f.layers.get(POI_MARKER_LAYER_ID)!.filter;
  };
  // An archive baked before the source ranked it: kind marina, min_zoom 7.
  const office = { set: "denmark", src: "fake", kind: "marina", kind_detail: "marina_office", min_zoom: 7 };
  // An OSM archive baked before tags.py ranked it 14: min_zoom 10, and no
  // `src` property at all (only plugin-source features carry one).
  const harbourmaster = { set: "denmark", kind: "harbourmaster", kind_detail: "harbour_master", min_zoom: 10 };

  test("the harbour zoom is an integer (MapLibre filters see the tile's integer z)", () => {
    expect(Number.isInteger(POI_HARBOUR_ZOOM)).toBe(true);
    expect(POI_HARBOUR_ZOOM).toBe(14);
    expect(harbourOnly()).toContainEqual({ src: "fake", prop: "kind_detail", values: ["marina_office"] });
    expect(harbourOnly()).toContainEqual({ src: "osm", prop: "kind", values: ["harbourmaster"] });
  });

  test("the source's marina office is hidden below z14 and shown from z14 (overzoom included)", () => {
    const m = marker();
    for (const z of [7, 10, 12, 13]) expect(at(z, m, office), `z${z}`).toBe(false);
    for (const z of [14, 15, 18]) expect(at(z, m, office), `z${z}`).toBe(true);
  });

  test("an OSM harbourmaster follows the same rule (either OSM tagging)", () => {
    const m = marker();
    for (const detail of ["harbour_master", "harbourmaster"]) {
      const f = { ...harbourmaster, kind_detail: detail };
      for (const z of [10, 12, 13]) expect(at(z, m, f), `${detail} z${z}`).toBe(false);
      for (const z of [14, 15, 18]) expect(at(z, m, f), `${detail} z${z}`).toBe(true);
    }
  });

  test("the marina itself, and look-alikes from the OTHER source, are untouched", () => {
    const m = marker();
    expect(at(7, m, { ...office, kind_detail: "marina" })).toBe(true);
    // an OSM feature with the source type's kind_detail: the rule is per source
    const { src: _src, ...osm } = office;
    expect(at(7, m, osm)).toBe(true);
    // a source feature with the OSM kind (still per source)
    expect(at(10, m, { ...harbourmaster, src: "fake" })).toBe(true);
    // other OSM marine kinds keep their own rank
    for (const kind of ["marina", "harbour", "fuel", "anchorage"]) {
      expect(at(10, m, { set: "denmark", kind }), kind).toBe(true);
    }
  });

  test("the clause survives the disabled-set AND (still hides the office when a set is off)", () => {
    const f = fakeMap();
    createPoiOverlay({ sets: () => [DENMARK, UK], disabledSets: () => [UK.id] }).ensure(f.map, ctxOn());
    const m = f.layers.get(POI_MARKER_LAYER_ID)!.filter;
    expect(at(12, m, office)).toBe(false);
    expect(at(14, m, office)).toBe(true);
    expect(at(12, m, harbourmaster)).toBe(false);
    expect(at(14, m, harbourmaster)).toBe(true);
    expect(at(14, m, { ...office, set: "uk" })).toBe(false);
  });
});

describe("disabledSets — filter, not omission", () => {
  const passes = (filter: unknown, props: Record<string, unknown>) =>
    featureFilter(filter as never).filter({ zoom: 10 } as never, { properties: props } as never);

  test("a settlement from a pre-nvpxzxxq archive draws no marker", () => {
    // The ingest stopped baking city/town/village features, but an archive
    // already on disk still has them until its region is re-baked — and they
    // have no glyph, so unfiltered they would draw the fallback ring under
    // the basemap's own label for the same town.
    const f = fakeMap();
    createPoiOverlay({ sets: () => [DENMARK] }).ensure(f.map, ctxOn());
    const marker = f.layers.get(POI_MARKER_LAYER_ID)!.filter;
    for (const kind of ["city", "town", "village"]) {
      expect(passes(marker, { set: "denmark", kind })).toBe(false);
    }
    for (const kind of ["marina", "fuel", "supermarket"]) {
      expect(passes(marker, { set: "denmark", kind })).toBe(true);
    }
  });

  test("a retired tide station from an older archive draws no marker, no re-bake", () => {
    // Tide stations are no longer baked by any source (name + position only,
    // no tide data), but a set baked before that holds them until its next bake.
    const f = fakeMap();
    createPoiOverlay({ sets: () => [DENMARK] }).ensure(f.map, ctxOn());
    const marker = f.layers.get(POI_MARKER_LAYER_ID)!.filter;
    const tide = { set: "denmark", src: "fake", kind: "tide_station", kind_detail: "tide_station", ref: "tide:7" };
    for (const zoom of [11, 14, 18]) {
      expect(featureFilter(marker as never).filter({ zoom } as never, { properties: tide } as never)).toBe(false);
    }
    expect(passes(marker, { set: "denmark", src: "fake", kind: "marina", kind_detail: "marina" })).toBe(true);
  });

  test("no disabledSets: every set's tag passes, byte-identical to before the option existed", () => {
    const f = fakeMap();
    createPoiOverlay({ sets: () => [DENMARK, UK] }).ensure(f.map, ctxOn());
    const marker = f.layers.get(POI_MARKER_LAYER_ID)!.filter;
    expect(passes(marker, { set: "denmark", kind: "marina" })).toBe(true);
    expect(passes(marker, { set: "uk", kind: "marina" })).toBe(true);
  });

  test("a disabled set's features are filtered out; the enabled set's still show", () => {
    const f = fakeMap();
    const o = createPoiOverlay({
      sets: () => [DENMARK, UK],
      disabledSets: () => [DENMARK.id],
    });
    o.ensure(f.map, ctxOn());
    const marker = f.layers.get(POI_MARKER_LAYER_ID)!.filter;
    expect(passes(marker, { set: "denmark", kind: "marina" })).toBe(false);
    expect(passes(marker, { set: "uk", kind: "marina" })).toBe(true);
  });

  test("toggling disabledSets updates the live filter without a reinstall (no bounds/zoom churn)", () => {
    const f = fakeMap();
    let disabled: string[] = [];
    const o = createPoiOverlay({ sets: () => [DENMARK, UK], disabledSets: () => disabled });
    o.ensure(f.map, ctxOn());
    const marker = () => f.layers.get(POI_MARKER_LAYER_ID)!.filter;
    expect(passes(marker(), { set: "denmark", kind: "marina" })).toBe(true);

    disabled = [DENMARK.id];
    o.update(f.map, ctxOn());
    expect(passes(marker(), { set: "denmark", kind: "marina" })).toBe(false);
    // The set list itself never changed, so no reinstall — same maxzoom.
    expect(f.sources.get(POI_ALL_SOURCE_ID)!.maxzoom).toBe(14);

    disabled = [];
    o.update(f.map, ctxOn());
    expect(passes(marker(), { set: "denmark", kind: "marina" })).toBe(true);
  });
});

describe("layerIds", () => {
  test("is the union's one fixed layer id, regardless of set count", () => {
    const o = createPoiOverlay({ sets: () => [DENMARK, UK] });
    expect([...o.layerIds]).toEqual([POI_MARKER_LAYER_ID]);
    expect([...o.layerIds]).toEqual(POI_LAYER_IDS);
    // Fixed even with an empty catalog — the hoist guards on `getLayer`.
    expect([...createPoiOverlay({ sets: () => [] }).layerIds]).toEqual(POI_LAYER_IDS);
  });
});

describe("showPois — inert when off", () => {
  test("adds NO source or layer while showPois is off", () => {
    const f = fakeMap();
    const o = createPoiOverlay({ sets: () => [DENMARK, UK] });
    o.ensure(f.map, ctxWith(DEFAULT_SETTINGS));
    expect(f.sources.size).toBe(0);
    expect(f.layers.size).toBe(0);
    o.update(f.map, ctxWith(DEFAULT_SETTINGS));
    expect(f.sources.size).toBe(0);
  });

  test("turning showPois off REMOVES the union source + layers", () => {
    const f = fakeMap();
    const o = createPoiOverlay({ sets: () => [DENMARK, UK] });
    o.update(f.map, ctxOn());
    expect(f.sources.size).toBe(1);
    expect(f.layers.size).toBe(1);

    o.update(f.map, ctxWith({ ...DEFAULT_SETTINGS, showPois: false }));
    expect(f.sources.size).toBe(0);
    expect(f.layers.size).toBe(0);

    // Re-enabling re-installs (re-fetches), like the satellite underlay.
    o.update(f.map, ctxOn());
    expect(f.sources.size).toBe(1);
    expect(f.layers.size).toBe(1);
  });
});

describe("paint", () => {
  test("applyPoiPaint recolours the union's layers, guarded on presence", () => {
    const f = fakeMap();
    // No layers installed yet — must be a no-op, not a throw.
    expect(() => applyPoiPaint(f.map, DEFAULT_SETTINGS.palette)).not.toThrow();
    createPoiOverlay({ sets: () => [DENMARK] }).ensure(f.map, ctxOn());
    applyPoiPaint(f.map, "night");
    const mlayout = f.layout.get(POI_MARKER_LAYER_ID)!;
    expect(mlayout["icon-image"]).toBeDefined();
  });
});

describe("z-stacking", () => {
  test("sits above the chart but below every hoisted safety overlay", () => {
    const o = createPoiOverlay({ sets: () => [DENMARK] });
    expect(o.z).toBe(Z.poi);
    expect(o.z).toBeGreaterThan(0); // hoisted above the chart
    expect(o.z).toBeLessThan(Z.route); // below the lowest HOISTED safety overlay
    expect(o.z).toBeLessThan(Z.ais); // never over own-ship
  });

  // The sector arcs used to be the anchor of that assertion ("an informational
  // layer must never sit over a light sector"). USER DECISION 2026-07-29
  // overrode it: the arcs follow the "Aids & lights" ENC group's stack position,
  // which is in the CHART band below POI, so POI now draws over them. That is
  // the ordering the user asked for, not a regression — sector-lights left the
  // hoist entirely (negative `z`) and route is the lowest fixed overlay now.
  test("POI is above the sector arcs now — they ride the chart band, not the hoist", () => {
    expect(Z.sectorLights).toBeLessThan(0);
    expect(Z.poi).toBeGreaterThan(Z.sectorLights);
  });
});
