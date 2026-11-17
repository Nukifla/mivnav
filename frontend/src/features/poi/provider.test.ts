/**
 * The POI info provider (#xnlxroux): it answers taps from its OWN layers only
 * (via the C5 `scopedQuery` guard, scoped to the union's two FIXED layer ids —
 * no longer a function of the catalog), collapses a POI's duplicate hits
 * (repeated across adjacent tiles' buffered edges) to one, and maps
 * `{name, kind, kind_detail}` to a detail record. Driven against a
 * `queryRenderedFeatures`-shaped double, like chartProvider.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MapGeoJSONFeature } from "maplibre-gl";
import type { QueryableMap } from "../../core/info/queryGuard";
import type { InfoQuery } from "../../core/info/types";
import { POI_MARKER_LAYER_ID } from "./overlay";
import { registerPoiQueryLayers, registerPoiSource, resetPoiSources } from "./sources";
import { createPoiProvider, mergedOsmProps, POI_PROVIDER_ID, poiSubtitle } from "./provider";
import { rankHits } from "../../core/info/rank";
import type { InfoDetail, InfoHit } from "../../core/info/types";

const QUERY: InfoQuery = { point: { x: 100, y: 100 }, lngLat: { lng: -122.28, lat: 37.79 }, radius: 8 };

function feat(
  layerId: string,
  props: Record<string, unknown>,
  id: number | undefined,
  source = "poi-all",
): MapGeoJSONFeature {
  return { source, properties: props, layer: { id: layerId }, id } as unknown as MapGeoJSONFeature;
}

// The double records the `{ layers }` hint the guard hands it, so a test can
// assert the query is scoped to the union's one layer.
const mapOver = (features: MapGeoJSONFeature[], seenLayers: string[][] = []): QueryableMap => ({
  queryRenderedFeatures: (_geom, options) => {
    if (options?.layers) seenLayers.push(options.layers);
    return features;
  },
});

const providerOver = (features: MapGeoJSONFeature[]) =>
  createPoiProvider({ map: () => mapOver(features) });

describe("queryAt", () => {
  test("returns a hit for a POI feature", () => {
    const p = providerOver([
      feat(POI_MARKER_LAYER_ID, { name: "Oakland Marina", kind: "marina", set: "denmark" }, 1),
    ]);
    const hits = p.queryAt(QUERY);
    expect(hits.length).toBe(1);
    expect(hits[0].providerId).toBe(POI_PROVIDER_ID);
    expect(hits[0].title).toBe("Oakland Marina");
    expect(hits[0].subtitle).toBe("Marina");
    expect(hits[0].priority).toBe("regulated");
    expect(hits[0].precision).toBe("point");
  });

  test("collapses one POI's duplicate hits (tile-boundary buffer) into a single hit", () => {
    const p = providerOver([
      feat(POI_MARKER_LAYER_ID, { name: "Fuel Dock", kind: "fuel", set: "denmark" }, 7),
      feat(POI_MARKER_LAYER_ID, { name: "Fuel Dock", kind: "fuel", set: "denmark" }, 7),
    ]);
    expect(p.queryAt(QUERY).length).toBe(1);
  });

  test("scopes the query to the fixed POI layers (the union, plus any plugin layer), no matter the catalog", () => {
    const seenLayers: string[][] = [];
    const p = createPoiProvider({ map: () => mapOver([], seenLayers) });
    p.queryAt(QUERY);
    expect(seenLayers[0]).toEqual([POI_MARKER_LAYER_ID]);
    registerPoiQueryLayers(["plugin-live"]);
    p.queryAt(QUERY);
    expect(seenLayers[1]).toEqual([POI_MARKER_LAYER_ID, "plugin-live"]);
    resetPoiSources();
  });

  test("a tap on a feature tagged with a DIFFERENT set's provenance resolves the same way", () => {
    const p = providerOver([feat(POI_MARKER_LAYER_ID, { name: "Cowes", kind: "marina", set: "uk" }, 3)]);
    const hits = p.queryAt(QUERY);
    expect(hits.length).toBe(1);
    expect(hits[0].title).toBe("Cowes");
  });

  test("two DIFFERENT nameless POIs from DIFFERENT sets both resolve (properties.set keeps the dedup fallback set-scoped)", () => {
    // Neither carries `name` or an MVT `id` (#wuvqsnxy: POI bakes never
    // thread one through) — before the union, each set's OWN marker layer id
    // disambiguated them for free; under the union's single shared layer id,
    // the dedup fallback must fold in `properties.set` instead, or one of
    // these would silently vanish from the tap list (#xnlxroux open question
    // 2's one genuinely new, narrow finding).
    const p = providerOver([
      feat(POI_MARKER_LAYER_ID, { kind: "toilets", set: "denmark" }, undefined),
      feat(POI_MARKER_LAYER_ID, { kind: "toilets", set: "uk" }, undefined),
    ]);
    expect(p.queryAt(QUERY).length).toBe(2);
  });

  test("two nameless POIs from the SAME set still collapse to one — unchanged from before the union", () => {
    const p = providerOver([
      feat(POI_MARKER_LAYER_ID, { kind: "toilets", set: "denmark" }, undefined),
      feat(POI_MARKER_LAYER_ID, { kind: "toilets", set: "denmark" }, undefined),
    ]);
    expect(p.queryAt(QUERY).length).toBe(1);
  });

  test("receives ONLY its own features — a foreign hit is guarded out", () => {
    // A chart object under the same tap: the guard's post-filter drops it
    // because its layer id is not one of the union's POI layers.
    const p = providerOver([
      feat(POI_MARKER_LAYER_ID, { name: "Marina", kind: "marina", set: "denmark" }, 1),
      feat("DEPARE-fill", { DRVAL1: 5 }, 2, "chart-US5OAKIQ"),
    ]);
    const hits = p.queryAt(QUERY);
    expect(hits.length).toBe(1);
    expect(hits[0].title).toBe("Marina");
  });

  test("answers nothing before the map exists", () => {
    const p = createPoiProvider({ map: () => undefined });
    expect(p.queryAt(QUERY)).toEqual([]);
  });
});

describe("icon", () => {
  const hitWith = (kind?: string): InfoHit => ({
    providerId: POI_PROVIDER_ID,
    id: "1",
    priority: "regulated",
    precision: "point",
    title: "x",
    payload: kind ? { kind } : {},
  });

  test("a known kind gets its own glyph, distinct per kind", () => {
    const p = providerOver([]);
    const marina = p.icon?.(hitWith("marina"));
    const fuel = p.icon?.(hitWith("fuel"));
    expect(typeof marina).toBe("function");
    expect(typeof fuel).toBe("function");
    // A fresh component is built per kind from that kind's glyph geometry, so
    // two kinds never share one icon (the map/info single source of truth).
    expect(marina).not.toBe(fuel);
  });

  test("a place-name, an unknown kind, or a missing kind declines to the anchor fallback", () => {
    const p = providerOver([]);
    // place kinds carry no glyph; an unexpected tile value likewise; and no kind
    // at all. All three fall through to `defaultIcon` (the anchor).
    expect(p.icon?.(hitWith("city"))).toBeUndefined();
    expect(p.icon?.(hitWith("does_not_exist"))).toBeUndefined();
    expect(p.icon?.(hitWith(undefined))).toBeUndefined();
  });
});

describe("detail", () => {
  test("maps name/kind to a record with NO rows — the kind lives in the subtitle only", () => {
    const p = providerOver([]);
    const detail = p.detail({
      providerId: POI_PROVIDER_ID,
      id: "1",
      priority: "regulated",
      precision: "point",
      title: "Oakland Marina",
      payload: { name: "Oakland Marina", kind: "marina", kind_detail: "yacht_harbour" },
    });
    // detail is synchronous for POIs (no async lookup)
    if (detail instanceof Promise) throw new Error("POI detail must be synchronous");
    expect(detail.title).toBe("Oakland Marina");
    // OSM: kind_detail is a raw tag value, never folded into the subtitle.
    expect(detail.subtitle).toBe("Marina");
    // No "Point of interest" section at all (Type/Detail/Source rows dropped),
    // so the panel renders no empty heading.
    expect(detail.sections).toEqual([]);
  });
});

describe("poiSubtitle (name, then what it is)", () => {
  test("OSM: the kind; kind_detail only where it is a real refinement", () => {
    // Raw tag values ('yes', tag-spelling synonyms) never show.
    expect(poiSubtitle("harbour", "yes", undefined)).toBe("Harbour");
    expect(poiSubtitle("fuel", "fuel_station", undefined)).toBe("Fuel");
    expect(poiSubtitle("harbourmaster", "harbour_master", undefined)).toBe("Harbourmaster");
    expect(poiSubtitle("boat_dealer", "boat", undefined)).toBe("Boat dealer");
    expect(poiSubtitle("hardware", "doityourself", undefined)).toBe("Hardware");
    expect(poiSubtitle("hospital", "hospital", undefined)).toBe("Hospital");
    // …but a clinic is not a hospital, and a bar is not a pub.
    expect(poiSubtitle("hospital", "clinic", undefined)).toBe("Clinic");
    expect(poiSubtitle("pub", "bar", undefined)).toBe("Bar");
  });

  test("missing pieces", () => {
    expect(poiSubtitle(undefined, "marina", undefined)).toBeUndefined();
    expect(poiSubtitle("fuel", undefined, undefined)).toBe("Fuel");
  });
});

describe("a plugin POI source", () => {
  beforeAll(() =>
    registerPoiSource({
      id: "fake",
      label: "Fake",
      types: { shower: { label: "Shower block", glyph: [["circle", 12, 12, 4]] } },
      hitId: (props) => (typeof props.ref === "string" ? props.ref : undefined),
      detail: (props) => ({ links: [{ label: "Open on fake", href: `https://fake/${String(props.ref)}` }] }),
      actions: (props) => {
        actionReads++;
        return props.ref === "7"
          ? { actions: [{ label: "Edit", run: () => {} }], footerActions: [{ label: "Delete", run: () => {} }] }
          : {};
      },
    }),
  );
  let actionReads = 0;
  afterAll(resetPoiSources);

  const osm = JSON.stringify([{ name: "Aarhus Lystbådehavn", kind: "marina", set: "osm-dk" }]);
  const marina = (extra: Record<string, unknown> = {}) =>
    feat(POI_MARKER_LAYER_ID, { name: "Århus Marina", kind: "marina", src: "fake", ref: "42", set: "f-dk", osm, ...extra }, undefined);

  test("its type labels the subtitle; an unknown type is humanized; OSM never reads it", () => {
    expect(poiSubtitle("other", "shower", "fake")).toBe("Shower block");
    expect(poiSubtitle("other", "sail_loft", "fake")).toBe("Sail loft");
    expect(poiSubtitle("community", "event", "fake")).toBe("Community");
    expect(poiSubtitle("toilets", "shower", undefined)).toBe("Toilets");
  });

  test("its hit id keys a place across copies; merged OSM points follow as their own hits", () => {
    const hits = providerOver([marina(), marina(), marina({ set: "f-live" })]).queryAt(QUERY);
    expect(hits.map((h) => h.id)).toEqual(["fake:42", "Aarhus Lystbådehavn"]);
    const ranked = rankHits(providerOver([marina(), feat(POI_MARKER_LAYER_ID, { name: "X", kind: "fuel" }, 9)]).queryAt(QUERY));
    expect(ranked.map((h) => h.id)).toEqual(["fake:42", "Aarhus Lystbådehavn", "9"]);
  });

  test("a nameless point is titled by its type; the detail carries the source's links", () => {
    const p = providerOver([feat(POI_MARKER_LAYER_ID, { kind: "other", kind_detail: "shower", src: "fake", ref: "7", set: "dk" }, 9)]);
    const [hit] = p.queryAt(QUERY);
    expect(hit.title).toBe("Shower block");
    const d = p.detail(hit) as InfoDetail;
    expect(d.subtitle).toBe("Shower block");
    expect(d.links).toEqual([{ label: "Open on fake", href: "https://fake/7" }]);
    expect(typeof p.icon?.(hit)).toBe("function");
  });

  test("the source's actions: under the header and the record; read in `watch` so live state re-resolves", () => {
    const p = providerOver([feat(POI_MARKER_LAYER_ID, { kind: "other", src: "fake", ref: "7", set: "dk" }, 9)]);
    const [hit] = p.queryAt(QUERY);
    const d = p.detail(hit) as InfoDetail;
    expect(d.actions?.map((a) => a.label)).toEqual(["Edit"]);
    expect(d.footerActions?.map((a) => a.label)).toEqual(["Delete"]);
    const before = actionReads;
    p.watch?.(hit);
    expect(actionReads).toBe(before + 1);
    // None offered: the keys stay absent.
    const other = p.detail({ ...hit, payload: { kind: "other", src: "fake", ref: "8" } }) as InfoDetail;
    expect(other.actions).toBeUndefined();
    expect(other.footerActions).toBeUndefined();
  });

  test("a malformed or absent osm prop adds nothing and never throws", () => {
    for (const bad of ["", "not json", "{}", "[1, null]"]) {
      expect(providerOver([marina({ osm: bad })]).queryAt(QUERY).map((h) => h.id)).toEqual(["fake:42"]);
    }
    expect(mergedOsmProps({})).toEqual([]);
  });
});

describe("detail — an OpenStreetMap hit", () => {
  const hit = (payload: Record<string, unknown>): InfoHit => ({
    providerId: POI_PROVIDER_ID,
    id: "1",
    priority: "regulated",
    precision: "point",
    title: "x",
    payload,
  });
  const resolve = (p: ReturnType<typeof createPoiProvider>, h: InfoHit) => {
    const d = p.detail(h);
    if (d instanceof Promise) throw new Error("POI detail must be synchronous");
    return d;
  };

  test("no notes or links, no rows, the kind as subtitle", () => {
    const p = providerOver([]);
    const d = resolve(p, hit({ kind: "fuel", kind_detail: "fuel_station", ref: "12", set: "dk" }));
    expect(d.sections).toEqual([]);
    expect(d.subtitle).toBe("Fuel");
    expect(d.notes).toBeUndefined();
    expect(d.links).toBeUndefined();
  });
});
