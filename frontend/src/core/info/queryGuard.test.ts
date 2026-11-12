/**
 * The foreign-source query guard (./queryGuard.ts): the one property every
 * hit-testing provider now leans on — it receives ONLY the features in its
 * declared scope, whatever the underlying `queryRenderedFeatures` returns.
 *
 * The doubles here deliberately IGNORE the `{ layers }` hint and return the
 * whole scene on every call, which is the worst case: it proves the guarantee
 * is the guard's own post-filter and not the map's cooperation. (The real map
 * honours the hint; a `queryRenderedFeatures`-only test double does not, and
 * neither must be able to leak a foreign feature.)
 */

import { describe, expect, test } from "bun:test";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { scopedQuery, type QueryableMap } from "./queryGuard";

/** A rendered feature, reduced to the two fields the guard reads: its style
 * layer id and its source. */
function feat(layerId: string, source: string): MapGeoJSONFeature {
  return { source, layer: { id: layerId }, properties: { id: layerId } } as unknown as MapGeoJSONFeature;
}

/** A map whose `queryRenderedFeatures` returns `scene` verbatim — ignoring the
 * geometry AND the `{ layers }` option — so the guard's filter is the only thing
 * standing between a caller and a foreign feature. No `getLayer`: the guard then
 * cannot pre-filter and must rely wholly on the post-filter. */
function mapOver(scene: MapGeoJSONFeature[]): QueryableMap {
  return { queryRenderedFeatures: () => scene };
}

describe("scope by source prefix (the chart)", () => {
  // One tap over the whole stack: a chart object, an OSM raster, a SignalK
  // vessel overlay, and this seam's own highlight drawn out of the chart source.
  const scene = [
    feat("DEPARE-fill", "chart-US5OAKIQ"),
    feat("osm-raster", "openseamap"),
    feat("signalk-ships", "signalk-targets"),
    feat("info-highlight-line", "chart-US5OAKIQ"),
  ];

  test("only chart-source features survive — rasters and overlays never reach the caller", () => {
    const hits = scopedQuery(mapOver(scene), { sourcePrefixes: ["chart-"] })([]);
    expect(hits.map((f) => f.source)).toEqual(["chart-US5OAKIQ", "chart-US5OAKIQ"]);
  });

  test("an excluded layer prefix is dropped even when its source is in scope", () => {
    // The highlight is source `chart-*` yet must not be a hit.
    const hits = scopedQuery(mapOver(scene), {
      sourcePrefixes: ["chart-"],
      excludeLayerPrefixes: ["info-highlight"],
    })([]);
    expect(hits.map((f) => f.layer.id)).toEqual(["DEPARE-fill"]);
  });
});

describe("scope by layer id (a mode / an overlay)", () => {
  // THE LEAK CASE: the map returns features from a foreign source's layers that
  // overlap the same point. A layer-id scope must still see only its own.
  const scene = [
    feat("route-line", "route"),
    feat("measure-line", "measure"), // a different overlay, same tap
    feat("DEPARE-fill", "chart-US5OAKIQ"), // and a chart feature under it
  ];

  test("a caller receives only its declared layers, not another source's overlapping ones", () => {
    const hits = scopedQuery(mapOver(scene), { layerIds: ["route-line"] })([]);
    expect(hits.map((f) => f.layer.id)).toEqual(["route-line"]);
  });

  test("the { layers } hint is passed to a map that honours it, filtered to present", () => {
    const seen: (string[] | undefined)[] = [];
    const map: QueryableMap = {
      // Records what it was asked for; returns the matching subset, like the real map.
      queryRenderedFeatures: (_g, opts) => {
        seen.push(opts?.layers);
        return scene.filter((f) => opts?.layers?.includes(f.layer.id));
      },
      getLayer: (id) => (id === "route-line" ? {} : undefined), // measure-line absent this build
    };
    const hits = scopedQuery(map, { layerIds: ["route-line", "measure-line"] })([]);
    // Absent layers are pruned before the query so MapLibre never throws on one.
    expect(seen).toEqual([["route-line"]]);
    expect(hits.map((f) => f.layer.id)).toEqual(["route-line"]);
  });

  test("nothing of ours on the map means no query at all", () => {
    let called = false;
    const map: QueryableMap = {
      queryRenderedFeatures: () => {
        called = true;
        return scene;
      },
      getLayer: () => undefined, // none of the declared layers exist
    };
    expect(scopedQuery(map, { layerIds: ["route-line"] })([])).toEqual([]);
    expect(called).toBe(false);
  });
});
