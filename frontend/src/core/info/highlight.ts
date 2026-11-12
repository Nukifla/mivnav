// The selected chart object, picked out on the chart. ./marker.ts answers
// "which of the five?" with a point; this draws the object's own geometry so
// a depth area reads as a shape, not a dot. It is a **style layer over the
// chart source** (not traced from queryRenderedFeatures, which is cut at
// tile edges) selected by filter, re-installed on 'style.load' the way
// ../MapView.tsx's `ensureOverlays` re-adds its own overlays.
// See docs/architecture/info-highlight.md; read the `untrack` note on
// `install` before touching this.

import { createEffect, on, onCleanup, untrack, type Accessor } from "solid-js";
import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";
import { chartHitPayload, INFO_HIGHLIGHT_LAYER_PREFIX, type ChartHitPayload } from "./chartProvider";
import type { InfoState } from "./state";
import { MARKER_HALO, markerMagenta, type Palette } from "../style/colors";

/** The area wash — and **only** areas: gated on `geometry-type == Polygon`
 * (`AREA_ONLY`). Load-bearing: a `fill` layer earcut-triangulates a
 * `LineString`'s vertices into a filled blob (once turned an SLCONS marina
 * into a magenta blob over the whole basin). See docs/architecture/info-highlight.md. */
export const HIGHLIGHT_FILL_LAYER_ID = `${INFO_HIGHLIGHT_LAYER_PREFIX}-fill`;
/** Under the magenta, and wider: the halo. */
export const HIGHLIGHT_GLOW_LAYER_ID = `${INFO_HIGHLIGHT_LAYER_PREFIX}-glow`;
export const HIGHLIGHT_LINE_LAYER_ID = `${INFO_HIGHLIGHT_LAYER_PREFIX}-line`;
/** Bottom-up: all are removed together, and added in this order. */
export const HIGHLIGHT_LAYER_IDS = [
  HIGHLIGHT_FILL_LAYER_ID,
  HIGHLIGHT_GLOW_LAYER_ID,
  HIGHLIGHT_LINE_LAYER_ID,
] as const;

/**
 * The highlight's one hue: S-52's own "the chart is pointing at something"
 * magenta (`CHMGD`), matching ./InfoMarker.tsx. For the wash this is a safety
 * call, not a taste call — see `FILL_OPACITY` and docs/architecture/info-highlight.md.
 */
export const highlightMagenta = markerMagenta;

/**
 * How strongly the wash tints the area under it. A SAFETY tuning: the panel
 * is often *about* the shade the wash covers, so this value is measured in
 * CIEDE2000 for band discrimination, no impersonation of another band, and
 * visibility. Re-measured 2026-07-28 (task uqosnyyv) — full sweep tables in
 * docs/architecture/info-highlight.md.
 */
export const FILL_OPACITY = 0.16;

/** The wash-only predicate: ANDed onto the fill layer's filter alone (see
 * `HIGHLIGHT_FILL_LAYER_ID`) so a line-primitive object is never earcut-
 * filled into a blob. `geometry-type` normalises the Multi* variants. */
const AREA_ONLY: ExpressionSpecification = ["==", ["geometry-type"], "Polygon"];

/** Where a highlight's three layers draw from — a chart tile source (with
 * its `sourceLayer`), or any other source that wants the SAME selection
 * look (a feature's GeoJSON — the notices overlay's selected notice). */
export interface HighlightSource {
  source: string;
  /** Vector-tile sources only; omitted for GeoJSON. */
  sourceLayer?: string;
  filter: FilterSpecification;
}

/** The three layer ids, bottom-up (fill, glow, line). */
export type HighlightLayerIds = readonly [fill: string, glow: string, line: string];

/** The selection look — wash + halo + magenta edge — for any source. ONE
 * definition, so a feature's selection (e.g. a notice area) reads exactly
 * like a tapped chart depth area; `highlightLayers` is this for the chart. */
export function highlightLayerSpecs(
  ids: HighlightLayerIds,
  target: HighlightSource,
  palette: Palette,
): LayerSpecification[] {
  const magenta = highlightMagenta(palette);
  const common = {
    source: target.source,
    ...(target.sourceLayer !== undefined ? { "source-layer": target.sourceLayer } : {}),
    filter: target.filter,
  } as const;
  const lineLayout = { "line-cap": "round", "line-join": "round" } as const;
  return [
    {
      ...common,
      id: ids[0],
      filter: ["all", AREA_ONLY, target.filter as ExpressionSpecification],
      type: "fill",
      paint: highlightFillPaint(palette),
    },
    {
      ...common,
      id: ids[1],
      type: "line",
      layout: lineLayout,
      paint: {
        "line-color": MARKER_HALO,
        "line-width": 10,
        "line-blur": 6,
        "line-opacity": 0.7,
      },
    },
    {
      ...common,
      id: ids[2],
      type: "line",
      layout: lineLayout,
      paint: {
        "line-color": magenta,
        "line-width": 4,
        "line-blur": 2.5,
        "line-opacity": 0.95,
      },
    },
  ] as LayerSpecification[];
}

/** The wash's paint — also what a palette swap re-applies. */
export function highlightFillPaint(palette: Palette) {
  return {
    "fill-color": highlightMagenta(palette),
    "fill-opacity": FILL_OPACITY,
    // No `fill-outline-color`: a 1px hairline here is the charted-limit
    // lookalike this module exists to avoid; the soft glow layer is the edge.
    "fill-outline-color": "rgba(0,0,0,0)",
  } as const;
}

/** The three layers for `target`, drawn in `palette`'s magenta. Exported for
 * the tests that pin the colour to the palette; the app reaches it through
 * `createInfoHighlight`. */
export function highlightLayers(target: HighlightTarget, palette: Palette): LayerSpecification[] {
  return highlightLayerSpecs(HIGHLIGHT_LAYER_IDS, target, palette);
}

/** Everything the layers need, or nothing when the hit has no chart geometry
 * to point at. */
export interface HighlightTarget {
  source: string;
  sourceLayer: string;
  filter: FilterSpecification;
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Below this many non-`scamin` attribute terms, the id-less OR-branch below
 * isn't built: too generic on their own (a plain DEPARE's two depth values)
 * to trust as an identity — would match every object of the class map-wide,
 * not just this one's cross-cell siblings. */
const MIN_ATTRS_FOR_CROSS_CELL_MATCH = 3;

/**
 * Which features are *this* object, as a MapLibre filter.
 *
 * `["id"]` is chartcore's namespaced MVT id (`(cell_namespace << 32) | rcid`),
 * unique within a tile merging several cells and stable across every tile an
 * object spans — but it CANNOT bridge a *cell* seam (backlog lnzwzyww), since
 * two adjoining S-57 cells capture their own copy under unrelated ids.
 *
 * So once attributes are rich enough (`MIN_ATTRS_FOR_CROSS_CELL_MATCH`), the
 * filter also matches on attributes alone, ORed with the id-anchored form —
 * reusing the identity chartcore's own cross-cell matcher trusts
 * (`mvt::merge`'s `mvt_signature`: every tag except `scamin`, which SevenCs
 * bakes differently per cell for the same real-world object). See
 * docs/architecture/info-highlight.md for the full reasoning.
 *
 * A missing attribute is not asserted absent, so a feature carrying a
 * superset with these attributes equal would also match.
 */
export function highlightFilter(payload: ChartHitPayload): FilterSpecification | undefined {
  const idTerm: ExpressionSpecification | undefined =
    payload.rcid !== undefined ? ["==", ["id"], payload.rcid] : undefined;
  const attrTerms: ExpressionSpecification[] = [];
  for (const [key, value] of Object.entries(payload.props)) {
    // Cell-local gate value, not part of the object's identity — excluded
    // from every branch (see doc above).
    if (key === "scamin") continue;
    if (isPrimitive(value)) attrTerms.push(["==", ["get", key], value]);
  }

  const terms: ExpressionSpecification[] = [];
  if (idTerm) terms.push(idTerm);
  terms.push(...attrTerms);
  // No terms is no predicate, and a filter matching everything would paint a
  // magenta halo around every object of the class.
  if (terms.length === 0) return undefined;

  const idAnchored: FilterSpecification = ["all", ...terms];
  if (idTerm && attrTerms.length >= MIN_ATTRS_FOR_CROSS_CELL_MATCH) {
    return ["any", idAnchored, ["all", ...attrTerms]];
  }
  return idAnchored;
}

/** The layers to draw for the selected hit, or `undefined` for anything that is
 * not a chart object with findable geometry. */
export function highlightTarget(hit: Parameters<typeof chartHitPayload>[0]): HighlightTarget | undefined {
  const payload = chartHitPayload(hit);
  if (!payload) return undefined;
  const filter = highlightFilter(payload);
  if (!filter) return undefined;
  return { source: payload.source, sourceLayer: payload.sourceLayer, filter };
}

/** What the highlight needs from the map, and nothing more — so the whole
 * install/remove/reinstall rule is drivable against a double with no WebGL,
 * the same bargain ./marker.ts and ../MapView.tsx `wireMap` strike. */
export interface HighlightMap {
  getLayer(id: string): unknown;
  getSource(id: string): unknown;
  addLayer(layer: LayerSpecification): void;
  removeLayer(id: string): void;
  /** `boolean | void` to match MapLibre's own signature. Only the `void` —
   * no style object at all, where every call above throws — is a reason to
   * keep hands off; `false` is NOT (see `styleReachable`). */
  isStyleLoaded(): boolean | void;
  on(type: "style.load", listener: () => void): void;
  off(type: "style.load", listener: () => void): void;
}

export interface InfoHighlightOptions {
  state: InfoState;
  map: HighlightMap;
  /**
   * The active theme, read live. Required rather than defaulting to `"day"`:
   * a default is exactly how the hardcoded magenta survived a whole theming
   * pass, so the compiler asks every call site instead.
   */
  palette: Accessor<Palette>;
}

/**
 * Keep the chart's highlight equal to the panel's selection.
 *
 * Must be called under a reactive owner; removes its layers with it.
 *
 * One function, three triggers, because they are one rule: the selection
 * changed, the style was rebuilt under us, or the panel closed — `close()`
 * empties the hits and the layers come off, the clear is the general case.
 */
export function createInfoHighlight(opts: InfoHighlightOptions): void {
  const { state, map } = opts;

  /**
   * Can the layers be touched at all? Only "is there a style object" — NOT
   * `isStyleLoaded()`'s truthiness, which was the flaky-highlight bug: it is
   * also false while any source has tiles in flight and for the frame after
   * any layer change (ours included), so gating on it skipped the removal
   * AND the add with nothing to retry. See docs/architecture/info-highlight.md.
   */
  const styleReachable = () => map.isStyleLoaded() !== undefined;

  const removeInstalled = () => {
    for (const id of HIGHLIGHT_LAYER_IDS) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
  };

  /**
   * Remove whatever is installed, install what the selection asks for.
   *
   * `untrack` is load-bearing, not defensive: MapLibre fires 'style.load'
   * synchronously from inside `setStyle(diff)`, so on a settings change this
   * runs inside MapView's style effect's tracking scope. See
   * docs/architecture/info-highlight.md.
   */
  const install = () =>
    untrack(() => {
      if (!styleReachable()) return;
      removeInstalled();
      const target = highlightTarget(state.current());
      if (!target) return;
      // A hit held across a chart set being disabled: its source is gone and
      // `addLayer` would throw. Also the answer while a replaced style's JSON
      // is still loading (no sources yet) — its 'style.load' retries.
      if (!map.getSource(target.source)) return;
      // No `beforeId`: lands on top, above the boat/AIS layers that
      // ../MapView.tsx hoists on 'style.load' before this runs.
      for (const layer of highlightLayers(target, opts.palette())) map.addLayer(layer);
    });

  // Theme is a dependency here, not a read inside `install` (where `untrack`
  // would swallow it) — `on`'s dependency function runs in the effect's own
  // scope, so this doesn't reintroduce the trap the `untrack` exists for.
  createEffect(on(() => [state.current(), opts.palette()] as const, install));

  map.on("style.load", install);
  onCleanup(() => {
    map.off("style.load", install);
    // `map.remove()` deletes the style, and may run before this owner goes.
    if (styleReachable()) removeInstalled();
  });
}
