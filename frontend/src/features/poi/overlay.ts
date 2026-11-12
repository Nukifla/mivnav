// The POI overlay: OSM points of interest as a top-most VECTOR layer, served
// from the boat's pre-baked POI PMTiles, drawn above the chart but below
// every safety overlay (`z` is `Z.poi` — see layers/overlay.ts). See
// docs/architecture/poi-overlay-design.md for the union-source and
// disabledSets/max_zoom/dedup rationale (#xnlxroux, #wuvqsnxy, #snyzntrn).

import type { Accessor } from "solid-js";
import type { ExpressionSpecification, Map as MLMap } from "maplibre-gl";
import type { SymbolLayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { ChartSet } from "../../core/catalog";
import { catalogBounds } from "../../core/initialView";
import type { Overlay, OverlayCtx } from "../../core/layers/overlay";
import { Z } from "../../core/layers/overlay";
import { tileUrl } from "../../core/chartProtocol";
import { type Palette } from "../../core/style/colors";
import { ensurePoiImages, poiIconExpr } from "./icons";
import { extraPoiQueryLayers, poiSources } from "./sources";
import { addLayer } from "../../core/layers/addLayer";

/** The MVT vector layer id inside every POI set (Protomaps-style OSM extract). */
export const POI_SOURCE_LAYER = "pois";

/** The one union source + its one marker layer (#xnlxroux). See
 * docs/architecture/poi-overlay-design.md. */
export const POI_ALL_SOURCE_ID = "poi-all";
export const POI_MARKER_LAYER_ID = "poi-marker";

/** The baked union overlay's layer ids, bottom → top (its `layerIds`, the
 * re-hoist list). */
export const POI_LAYER_IDS: readonly string[] = [POI_MARKER_LAYER_ID];

/** Every layer the POI info provider answers taps on: the baked union's,
 * plus any a plugin draws with the same marker spec (`registerPoiQueryLayers`). */
export function poiQueryLayerIds(): readonly string[] {
  return [POI_MARKER_LAYER_ID, ...extraPoiQueryLayers()];
}

export const POI_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

export interface PoiOverlayDeps {
  /** Every known set, REGARDLESS of `disabledSets` — a disabled set still
   * needs to reach the union request for whichever other sets are enabled. */
  sets: Accessor<ChartSet[]>;
  /** Called with the live map on `ensure`, so the sibling info provider
   * (built before the map exists) can query it. */
  onMap?: (map: MLMap) => void;
  /** Set ids the mariner turned off — no UI wired to it yet. */
  disabledSets?: Accessor<readonly string[]>;
}

/** Kinds an older POI archive still carries that no bake produces any more,
 * hidden here WITHOUT a re-bake. Settlements (pre task nvpxzxxq): the
 * basemap now labels these, so filter them out rather than draw a
 * meaningless fallback-ring dot under the same label. `tide_station`: a
 * retired plugin-source kind (a name + position, no tide data); the next bake
 * of such a set drops them for good. Removable once no such archive can still
 * be in service. */
const LEGACY_PLACE_KINDS = ["city", "town", "village", "tide_station"] as const;

/** The zoom the POI archives top out at (`DEFAULT_POI_MAX_ZOOM`, backend
 * poi/config.py) — "zoomed all the way in to the harbour"; beyond it tiles
 * overzoom and `["zoom"]` in a filter keeps reading the overscaled z. */
export const POI_HARBOUR_ZOOM = 14;

/** One "harbour-only" match: features from source `src` whose `prop` is one
 * of `values`. `src` is the tile's own `src` property — a plugin source's
 * features carry its id, OpenStreetMap ones carry no `src` at all ("osm"). */
export interface HarbourOnlyMatch {
  src: string;
  prop: "kind" | "kind_detail";
  values: readonly string[];
}

/** POI types that only matter once zoomed right in to the harbour: drawn
 * from `POI_HARBOUR_ZOOM` only, whichever source they come from — ONE rule
 * per thing (a harbour office), so a merged source+OSM pair (merge.py's
 * "office" family) and an unmerged OSM harbourmaster behave alike.
 *
 * - OSM `harbourmaster` (by `kind` — `office=harbour_master` /
 *   `amenity=harbourmaster`; rank was 10).
 * - whatever each plugin source declares (`PoiSourcePlugin.harbourOnly`).
 *
 * The bakes rank these at min_zoom 14 themselves (tags.py), so on a fresh
 * archive this is a no-op; it is what hides them in archives baked BEFORE
 * that, WITHOUT a re-bake. */
export function harbourOnly(): readonly HarbourOnlyMatch[] {
  return [
    ...poiSources().flatMap((s) => (s.harbourOnly ?? []).map((m) => ({ src: s.id, ...m }))),
    { src: "osm", prop: "kind", values: ["harbourmaster"] },
  ];
}

function harbourOnlyClause(m: HarbourOnlyMatch): ExpressionSpecification {
  const src: ExpressionSpecification =
    m.src === "osm" ? ["!", ["has", "src"]] : ["==", ["get", "src"], m.src];
  return ["all", src, ["in", ["get", m.prop], ["literal", [...m.values]]]];
}

/** Base filter for `poiFilter` to AND the disabled-set clause onto (a
 * function: plugin sources register before the map, after this module loads). */
export const markerKinds = (): ExpressionSpecification => [
  "all",
  ["!", ["in", ["get", "kind"], ["literal", [...LEGACY_PLACE_KINDS]]]],
  // MapLibre 5 allows ["zoom"] in a filter (the tile's integer z), so the
  // band edge must be an integer — it is.
  [
    "!",
    ["all", ["any", ...harbourOnly().map(harbourOnlyClause)], ["<", ["zoom"], POI_HARBOUR_ZOOM]],
  ],
];

function poiFilter(
  base: ExpressionSpecification,
  disabledSets: readonly string[],
): ExpressionSpecification {
  if (disabledSets.length === 0) return base;
  const notDisabled: ExpressionSpecification = [
    "!",
    ["in", ["get", "set"], ["literal", [...disabledSets]]],
  ];
  return ["all", base, notDisabled];
}

/** Union's minzoom/maxzoom — max, not min (see poi-overlay-design.md).
 * Callers only call this with a non-empty `sets`. */
function poiUnionZoom(sets: readonly ChartSet[]): { min: number; max: number } {
  return {
    min: Math.min(...sets.map((s) => s.min_zoom)),
    max: Math.max(...sets.map((s) => s.max_zoom)),
  };
}

/** Install (idempotently) the union source and marker layer. Safe to call
 * repeatedly — every add is guarded on presence, so a style reload is
 * recovered on the very next `ensure`/`update` beat. */
function installUnion(
  map: MLMap,
  sets: readonly ChartSet[],
  disabledSets: readonly string[],
  palette: Palette,
): void {
  if (!map.getSource(POI_ALL_SOURCE_ID)) {
    const { min, max } = poiUnionZoom(sets);
    map.addSource(POI_ALL_SOURCE_ID, {
      type: "vector",
      // Same shape as a per-set source; tileUrl handles absolute vs dev chart://.
      tiles: [tileUrl("/api/poi/tiles/all/{z}/{x}/{y}")],
      minzoom: min,
      maxzoom: max,
      bounds: catalogBounds([...sets]) as [number, number, number, number] | undefined,
      attribution: POI_ATTRIBUTION,
    });
  }
  // Register every palette's icons up front (signalkShips idiom), so a
  // palette switch swaps `icon-image` rather than rebuilding images.
  ensurePoiImages(map);
  if (!map.getLayer(POI_MARKER_LAYER_ID)) {
    addLayer(
      map,
      poiMarkerLayer(POI_MARKER_LAYER_ID, POI_ALL_SOURCE_ID, poiFilter(markerKinds(), disabledSets), palette),
    );
  }
}

/** THE POI marker layer spec — the baked union's and any plugin layer's are
 * both built here, so the two sources can never drift in look or filter. */
export function poiMarkerLayer(
  id: string,
  source: string,
  filter: ExpressionSpecification,
  palette: Palette,
): SymbolLayerSpecification {
  return {
    id,
    type: "symbol",
    source,
    "source-layer": POI_SOURCE_LAYER,
    filter,
    layout: {
      "icon-image": poiIconExpr(palette),
      // Never drop an icon in a crowd, like AIS/aids/route markers. Density
      // is managed by min_zoom (rank), not collision-thinning, which
      // silently hid marinas next to a neighbour. sort-key still orders
      // draw so the more prominent kind stacks on top when they overlap.
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-sort-key": ["get", "min_zoom"],
    },
  };
}

/** Tear down the union's layers + source. Layers first — MapLibre refuses
 * to remove a source still referenced by a layer. */
function removeUnion(map: MLMap): void {
  for (const id of POI_LAYER_IDS) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(POI_ALL_SOURCE_ID)) map.removeSource(POI_ALL_SOURCE_ID);
}

/** Filter swap, not a reinstall, so toggling a set on/off costs no refetch. */
function refreshPoiFilters(map: MLMap, disabledSets: readonly string[]): void {
  if (map.getLayer(POI_MARKER_LAYER_ID)) {
    map.setFilter(POI_MARKER_LAYER_ID, poiFilter(markerKinds(), disabledSets));
  }
}

/** Runs install/refresh UNCONDITIONALLY every beat — a style reload wipes
 * imperative layers between beats, unlike this function's `signature`, which
 * changes (forcing teardown+rebuild) only when the set LIST changes. */
function reconcile(
  map: MLMap,
  sets: readonly ChartSet[],
  disabledSets: readonly string[],
  palette: Palette,
  signature: string | undefined,
): string | undefined {
  const allDisabled = sets.length > 0 && sets.every((s) => disabledSets.includes(s.id));
  if (sets.length === 0 || allDisabled) {
    removeUnion(map);
    return undefined;
  }
  const nextSignature = [...sets]
    .map((s) => s.id)
    .sort()
    .join(",");
  if (signature !== nextSignature) removeUnion(map); // stale bounds/zoom — force a fresh install
  installUnion(map, sets, disabledSets, palette);
  refreshPoiFilters(map, disabledSets);
  return nextSignature;
}

/** Recolour union layers for the palette — needs no style reload, mirrors
 * applyMeasurePaint/applyRoutePaint. */
export function applyPoiPaint(
  map: MLMap,
  palette: Palette,
  layerId: string = POI_MARKER_LAYER_ID,
): void {
  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, "icon-image", poiIconExpr(palette));
  }
}

/** The POI overlay — one `Overlay` for App's feature list, rendering every
 * known set through the one union source (see the header, #xnlxroux). */
export function createPoiOverlay(deps: PoiOverlayDeps): Overlay {
  let signature: string | undefined;
  const disabledSets = deps.disabledSets ?? ((): readonly string[] => []);
  // NONE while showPois is off, so a disabled overlay adds no source and
  // requests no tiles. Reading all three subscribes `update` to each.
  const desiredSets = (ctx: OverlayCtx): ChartSet[] =>
    ctx.settings().showPois ? deps.sets() : [];
  return {
    id: "poi",
    layerIds: POI_LAYER_IDS,
    z: Z.poi,
    ensure(map: MLMap, ctx: OverlayCtx) {
      deps.onMap?.(map);
      signature = reconcile(map, desiredSets(ctx), disabledSets(), ctx.settings().palette, signature);
    },
    update(map: MLMap, ctx: OverlayCtx) {
      signature = reconcile(map, desiredSets(ctx), disabledSets(), ctx.settings().palette, signature);
    },
    paint(map: MLMap, ctx: OverlayCtx) {
      applyPoiPaint(map, ctx.settings().palette);
    },
  };
}
