// The foreign-source query guard: turns "what did the mariner point at?" into
// a `queryRenderedFeatures` scoped to a caller's OWN features, so a provider
// can never match another source's layers. See
// docs/architecture/info-query-guard.md for why this is core infra rather
// than a per-provider check, and why the post-filter (not the `{layers}`
// hint) is the actual guarantee.

import type { MapGeoJSONFeature, PointLike } from "maplibre-gl";

/** A geometry `queryRenderedFeatures` accepts — a point, or a bounding box. */
export type QueryGeometry = PointLike | [PointLike, PointLike];

/**
 * The minimal map surface the guard needs. `getLayer` is optional so the guard
 * runs against a `queryRenderedFeatures`-only double (chartProvider.test.ts,
 * queryGuard.test.ts) — when it is absent the guard skips the present-layer
 * pre-filter and leans wholly on the post-filter, which is the real guarantee.
 */
export interface QueryableMap {
  queryRenderedFeatures(
    geometry?: QueryGeometry,
    options?: { layers?: string[] },
  ): MapGeoJSONFeature[];
  getLayer?(id: string): unknown;
}

/**
 * A hit-testing caller's declaration of which rendered features are ITS OWN.
 * A feature is in scope when it matches at least one positive rule (`layerIds`
 * or `sourcePrefixes`) and no `excludeLayerPrefixes`. The two positive rules
 * are a union: declaring both would widen scope, never narrow it.
 */
export interface QueryScope {
  /** Exact style-layer ids this caller owns. Prefer this: it is what MapLibre
   *  can also pre-filter on. */
  layerIds?: readonly string[];
  /**
   * Source-id prefixes this caller owns. The chart is served by `chart-${setId}`
   * sources whose STYLE-layer ids are generated (../style/chartStyle.ts), so it
   * declares its scope by source instead of an enumerable `layerIds` list.
   */
  sourcePrefixes?: readonly string[];
  /**
   * Layer-id prefixes to EXCLUDE even when otherwise in scope. The info
   * highlight (./highlight.ts) draws the selected object out of the chart
   * source itself, matching `sourcePrefixes: ["chart-"]`, yet must never be a
   * hit — a rendering of the answer must not become an input to it.
   */
  excludeLayerPrefixes?: readonly string[];
}

const startsWithAny = (s: string | undefined, prefixes: readonly string[]): boolean =>
  s !== undefined && prefixes.some((p) => s.startsWith(p));

/** Whether a single feature belongs to `scope`: a positive rule and no exclusion. */
function inScope(feature: MapGeoJSONFeature, scope: QueryScope): boolean {
  const layerId = feature.layer?.id;
  if (scope.excludeLayerPrefixes && startsWithAny(layerId, scope.excludeLayerPrefixes)) {
    return false;
  }
  if (scope.layerIds && layerId !== undefined && scope.layerIds.includes(layerId)) return true;
  if (scope.sourcePrefixes && startsWithAny(feature.source, scope.sourcePrefixes)) return true;
  return false;
}

/**
 * Build a `queryRenderedFeatures` locked to `scope`: it returns only the
 * features in scope, whatever the underlying query hands back.
 *
 * Explicit `layerIds` are passed to MapLibre as the `{ layers }` hint, but
 * only the ones the current style actually has — querying an absent layer id
 * throws. Source-prefix scopes (the chart) have no enumerable id list and
 * query unscoped, relying on the post-filter.
 */
export function scopedQuery(
  map: QueryableMap,
  scope: QueryScope,
): (geometry?: QueryGeometry) => MapGeoJSONFeature[] {
  return (geometry) => {
    let options: { layers?: string[] } | undefined;
    if (scope.layerIds) {
      const present = map.getLayer
        ? scope.layerIds.filter((id) => map.getLayer!(id))
        : [...scope.layerIds];
      if (present.length === 0) return [];
      options = { layers: present };
    }
    return map.queryRenderedFeatures(geometry, options).filter((f) => inScope(f, scope));
  };
}
