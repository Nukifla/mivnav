/**
 * The host's POI info provider with the mivport source registered: mivport
 * points are titled by their mivport type, one place from two sets is one
 * hit (keyed by the place id), its detail is ONE inline note that loads the
 * baked record lazily, the harbour office is harbour-only, and a non-mivport
 * hit gets none of it. Driven against a `queryRenderedFeatures`-shaped
 * double.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MapGeoJSONFeature } from "maplibre-gl";
import type { QueryableMap } from "../../../core/info/queryGuard";
import type { InfoHit, InfoQuery } from "../../../core/info/types";
import { harbourOnly, POI_MARKER_LAYER_ID } from "../overlay";
import { createPoiProvider, POI_PROVIDER_ID, poiSubtitle } from "../provider";
import type { MivportPlaceDetail } from "./detail";
import { mivportDetailNote } from "./index";
import { loaders, registerMivport, unregisterMivport } from "./testing";

beforeAll(registerMivport);
afterAll(unregisterMivport);

const QUERY: InfoQuery = { point: { x: 100, y: 100 }, lngLat: { lng: 14.69, lat: 55.1 }, radius: 8 };

function feat(props: Record<string, unknown>, id?: number): MapGeoJSONFeature {
  return { source: "poi-all", properties: props, layer: { id: POI_MARKER_LAYER_ID }, id } as unknown as MapGeoJSONFeature;
}

const mapOver = (features: MapGeoJSONFeature[]): QueryableMap => ({ queryRenderedFeatures: () => features });
const providerOver = (features: MapGeoJSONFeature[]) => createPoiProvider({ map: () => mapOver(features) });

const point = (extra: Record<string, unknown> = {}) => ({
  name: "Rønne Lystbådehavn",
  kind: "marina",
  kind_detail: "marina",
  min_zoom: 9,
  src: "mivport",
  ref: "osm:w42",
  set: "dk-mivport",
  ...extra,
});

const hit = (payload: Record<string, unknown>): InfoHit => ({
  providerId: POI_PROVIDER_ID,
  id: "1",
  priority: "regulated",
  precision: "point",
  title: "x",
  payload,
});

const resolve = (h: InfoHit) => {
  const d = providerOver([]).detail(h);
  if (d instanceof Promise) throw new Error("POI detail must be synchronous");
  return d;
};

const DETAIL: MivportPlaceDetail = {
  ref: "osm:w42",
  kind: "marina",
  source: "core",
  attribution: "© OpenStreetMap contributors (ODbL); © mivport contributors (ODbL)",
  fetched_at: 1,
};

describe("queryAt", () => {
  test("a mivport point: its name, mivport's label for its type as subtitle", () => {
    const hits = providerOver([feat(point({ kind: "harbourmaster", kind_detail: "harbour_office", name: "Havnekontor" }))]).queryAt(QUERY);
    expect(hits.length).toBe(1);
    expect(hits[0].title).toBe("Havnekontor");
    expect(hits[0].subtitle).toBe("Harbour office");
    expect(hits[0].id).toBe("mivport:osm:w42");
  });

  test("a nameless point is titled by its type, not its grouped kind", () => {
    const hits = providerOver([feat(point({ name: undefined, kind: "pump_out", kind_detail: "pump_out" }))]).queryAt(QUERY);
    expect(hits[0].title).toBe("Pump-out");
  });

  test("the same place from two sets / tiles is ONE hit (keyed by the place id)", () => {
    const hits = providerOver([feat(point()), feat(point({ set: "se-mivport" })), feat(point())]).queryAt(QUERY);
    expect(hits.map((h) => h.id)).toEqual(["mivport:osm:w42"]);
  });

  test("two places stay two", () => {
    const hits = providerOver([feat(point()), feat(point({ ref: "8d1c0f0e-0000-4000-8000-000000000001" }))]).queryAt(QUERY);
    expect(hits.length).toBe(2);
  });
});

describe("poiSubtitle", () => {
  test("mivport types in mivport's wording; a kind added later is humanized", () => {
    expect(poiSubtitle("harbourmaster", "harbour_office", "mivport")).toBe("Harbour office");
    expect(poiSubtitle("boat_dealer", "boat_shop", "mivport")).toBe("Boat shop");
    expect(poiSubtitle("club", "club", "mivport")).toBe("Sailing club");
    expect(poiSubtitle("other", "other", "mivport")).toBe("Other");
    expect(poiSubtitle("other", "lpg_refill", "mivport")).toBe("Lpg refill");
  });
});

describe("icon", () => {
  test("every mivport point gets a glyph — `other` and the mivport-only kinds too", () => {
    const p = providerOver([]);
    for (const [kind, detail] of [["other", "other"], ["boat_hoist", "boat_hoist"], ["harbourmaster", "harbour_office"]]) {
      expect(typeof p.icon?.(hit({ src: "mivport", kind, kind_detail: detail })), detail).toBe("function");
    }
  });
});

describe("harbour only", () => {
  test("a mivport harbour office is drawn from the harbour zoom only", () => {
    expect(harbourOnly()).toContainEqual({ src: "mivport", prop: "kind_detail", values: ["harbour_office"] });
  });
});

describe("detail — the mivport note", () => {
  test("one INLINE note, no rows; detail() alone fetches nothing; load reads set + ref", async () => {
    const calls: [string, string][] = [];
    loaders.detail = (set, ref) => {
      calls.push([set, ref]);
      return Promise.resolve(DETAIL);
    };
    const d = resolve(hit(point()));
    expect(d.sections).toEqual([]);
    expect(d.notes?.length).toBe(1);
    expect(d.notes![0].display).toBe("inline");
    expect(d.notes![0].label).toBe("mivport details");
    expect(calls).toEqual([]);
    const body = await d.notes![0].load();
    expect(typeof body).toBe("function"); // a structured (component) body
    expect(calls).toEqual([["dk-mivport", "osm:w42"]]);
  });

  test("a load failure propagates the loader's mariner-readable message", async () => {
    loaders.detail = () => Promise.reject(new Error("No details downloaded for this place yet."));
    const d = resolve(hit(point()));
    await expect(d.notes![0].load()).rejects.toThrow("No details downloaded for this place yet.");
  });

  test("no note without a ref or a set, or for an OSM point", () => {
    expect(resolve(hit(point({ ref: undefined }))).notes).toBeUndefined();
    expect(resolve(hit(point({ set: undefined }))).notes).toBeUndefined();
    expect(resolve(hit({ kind: "marina", set: "dk", ref: "osm:w42" })).notes).toBeUndefined();
    expect(resolve({ providerId: POI_PROVIDER_ID, id: "1", priority: "regulated", precision: "point", title: "x" }).notes).toBeUndefined();
  });

  test("no record-level link: the mivport link comes with the loaded record (web_url)", () => {
    expect(resolve(hit(point())).links).toBeUndefined();
  });

  test("mivportDetailNote uses its loader once per load", async () => {
    let n = 0;
    const note = mivportDetailNote("s", "r", () => {
      n++;
      return Promise.resolve(DETAIL);
    });
    await note.load();
    expect(n).toBe(1);
  });
});
