/**
 * The local layer and the hide filter: a place changed on the boat is drawn
 * once, from the local GeoJSON layer, and the baked POI layers leave its ref
 * (and the OSM refs it now stands for) out — evaluated with MapLibre's own
 * filter engine. The mivport source exposes the bound editing state's
 * hidden refs and actions to the host, and nothing while unbound.
 */

import { describe, expect, test } from "bun:test";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { ExpressionSpecification } from "maplibre-gl";
import { markerKinds, poiFilter, hiddenRefsClause } from "../overlay";
import { mivportPoiSource, detailSet } from "./index";
import { localCollection, localLayerFilter, pinCollection } from "./localLayer";
import type { MivportSourceHooks } from "./hooks";
import type { MivportLocalFeature } from "./types";

const passes = (filter: ExpressionSpecification, props: Record<string, unknown>, zoom = 12) =>
  featureFilter(filter).filter({ zoom } as never, { type: 1, properties: props } as never, undefined as never);

describe("hiddenRefsClause", () => {
  test("nothing hidden: no clause, and the base filter is untouched", () => {
    expect(hiddenRefsClause([])).toBeUndefined();
    expect(hiddenRefsClause([{ src: "mivport", refs: [] }])).toBeUndefined();
    const base = markerKinds();
    expect(poiFilter(base, [], [])).toBe(base);
  });

  test("drops exactly that source's hidden refs", () => {
    const f = poiFilter(markerKinds(), [], [{ src: "mivport", refs: ["u1", "osm:n7"] }]);
    expect(passes(f, { src: "mivport", ref: "u1", kind: "marina" })).toBe(false);
    expect(passes(f, { src: "mivport", ref: "osm:n7", kind: "marina" })).toBe(false);
    expect(passes(f, { src: "mivport", ref: "u2", kind: "marina" })).toBe(true);
    // Another source's point with the same ref, and an OSM point (no src/ref).
    expect(passes(f, { src: "other", ref: "u1", kind: "marina" })).toBe(true);
    expect(passes(f, { kind: "marina", name: "Havn" })).toBe(true);
  });

  test("combines with the disabled sets and with several sources", () => {
    const f = poiFilter(
      markerKinds(),
      ["dk"],
      [
        { src: "mivport", refs: ["u1"] },
        { src: "other", refs: ["x"] },
      ],
    );
    expect(passes(f, { src: "mivport", ref: "u2", kind: "marina", set: "dk" })).toBe(false);
    expect(passes(f, { src: "other", ref: "x", kind: "marina", set: "se" })).toBe(false);
    expect(passes(f, { src: "mivport", ref: "u2", kind: "marina", set: "se" })).toBe(true);
  });
});

describe("the local layer", () => {
  const feat = (ref: string, extra: Partial<MivportLocalFeature["properties"]> = {}): MivportLocalFeature => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [12, 55] },
    properties: { src: "mivport", ref, kind: "marina", min_zoom: 9, local: "pending", ...extra },
  });

  test("draws the changed places, not the deleted ones", () => {
    const fc = localCollection([feat("u1"), feat("u2", { deleted: true })]);
    expect(fc.features.map((f) => f.properties?.ref)).toEqual(["u1"]);
  });

  test("honours each place's min_zoom (a GeoJSON source has no tiles to leave it out of)", () => {
    const f = localLayerFilter();
    expect(passes(f, { kind: "marina", min_zoom: 9 }, 8)).toBe(false);
    expect(passes(f, { kind: "marina", min_zoom: 9 }, 9)).toBe(true);
    expect(passes(f, { kind: "marina" }, 3)).toBe(true);
  });

  test("the pin: one point, or nothing", () => {
    expect(pinCollection(undefined).features).toEqual([]);
    expect(pinCollection({ lat: 55, lon: 12 }).features[0].geometry).toEqual({ type: "Point", coordinates: [12, 55] });
  });
});

describe("the mivport source's editing hooks", () => {
  const hooks = (o: Partial<MivportSourceHooks> = {}): MivportSourceHooks => ({
    actions: () => ({ actions: [{ label: "Edit", run: () => {} }] }),
    hiddenRefs: () => ["u1"],
    loadDetail: () => Promise.reject(new Error("unused")),
    cachedDetail: () => undefined,
    ...o,
  });

  test("bound: the source hands out the hidden refs and the actions", () => {
    const src = mivportPoiSource(undefined, () => hooks());
    expect(src.hiddenRefs?.()).toEqual(["u1"]);
    expect(src.actions?.({ ref: "u1" }).actions?.map((a) => a.label)).toEqual(["Edit"]);
  });

  test("unbound (read-only): nothing hidden, no actions", () => {
    const src = mivportPoiSource(undefined, () => undefined);
    expect(src.hiddenRefs?.()).toEqual([]);
    expect(src.actions?.({ ref: "u1" })).toEqual({});
  });

  test("a local-layer point reads its detail from the 'local' set; a baked one from its set", () => {
    expect(detailSet({ ref: "u1", local: "pending" })).toBe("local");
    expect(detailSet({ ref: "u1", set: "dk-mivport" })).toBe("dk-mivport");
    expect(detailSet({ ref: "u1" })).toBeUndefined();
  });

  test("with editing bound, the details note loads through it and follows its remembered copy", async () => {
    const first = { ref: "u1", kind: "marina", source: "core" as const, attribution: "", fetched_at: 1 };
    let cached: typeof first | undefined;
    const src = mivportPoiSource(
      () => Promise.reject(new Error("the read-only loader must not be used")),
      () =>
        hooks({
          loadDetail: async () => {
            cached = first;
            return first;
          },
          cachedDetail: () => cached,
        }),
    );
    const note = src.detail?.({ ref: "u1", local: "pending" }).notes?.[0];
    expect(note).toBeDefined();
    const body = await note!.load();
    expect(typeof body).toBe("function");
  });
});
