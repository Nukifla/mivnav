// Notices to Mariners overlay (efs.md §2.3): one GeoJSON source fed with the
// prepared snapshot (`./time.ts`'s `prepareNotices` — time state stamped on
// every feature, toggles applied).
//
// AREAS and LINES are portrayed with the CHART'S OWN styles (user: "just
// use the same outlines the chart already uses for shooting areas and the
// rest"): the restricted-group boundary paint from core/style/aidsHazards.ts
// (`restrictedBoundaryPaint` — the S-52 LC/LS degraded to a bcol/bwid dash),
// with the S-57 class each family stands in for choosing the colour token:
//   firing exercise / firing area (fe, fa) → MIPARE, `bcol` CHMGD;
//   every other notice (NW, NM T/P/permanent) → CTNARE, `bcol` TRFCD;
//   a cable line → CBLSUB's `cable` line pattern (core/style/cablesPipelines.ts);
//   any other line → the boundary of its family's area class.
// Same palette tokens as the chart, so day/dusk/night behave identically.
// No interior fill, no band — EXCEPT a firing area in use today, which keeps
// its red hatch under the MIPARE line (user: "the firing now can get the
// fill"). Time state is opacity only (upcoming dimmed; the chart dash is
// never re-dashed); smaller areas draw over larger ones (`ar`, ./shape.ts).
// The boundary is drawn from `edge` features (./time.ts `boundaryEdges`),
// each edge ONCE however many areas share it: two offset dashes on one edge
// read as a solid line, which the chart's own MIPARE never is.
//
// Then class icons from z10 (sub badge composited into the image) — nothing
// below it: no stand-in dots when zoomed out (user: "when i zoom out the
// icons disappear but are replaced by dots, im guessing they should just
// disappear"); the outlines carry the zoomed-out view — with the
// shortId label as the SAME symbol's optional text from z11, and the
// numbered vertex labels from z13. Warnings' icons never drop; the rest
// declutter, firing first (`symbol-sort-key`) — and a dropped icon takes its
// label with it, so no orphan "NM-656" floats where no icon is.
//
// HIGHLIGHT: the notice open on the info panel is redrawn on its own source
// (`notices-hl`) — present even with the overlay off, so a notice opened
// from the list/search still shows where it is — in the chart's OWN
// selection look (core/info/highlight.ts `highlightLayerSpecs`: magenta wash
// over the whole area, white halo, magenta edge), so a selected notice area
// reads exactly like a tapped depth area (user: "when clicked mark the whole
// area like when clicking on a depth area").
//
// TAP TARGETS: an invisible fill (`notices-area-hit`, opacity 0) makes a tap
// anywhere INSIDE an area answer with its notice too (user: "when clicking
// in the middle of a area the notice for mariners should also show up"); the
// provider ranks such an interior hit in the chart's background-AREA tier
// (with DEPARE), so it joins depth/weather instead of heading them.
// An invisible circle per icon position (`notices-point-hit`) does the same
// for POINTS: a symbol that lost its collision is not rendered, so
// `queryRenderedFeatures` never returns it — and notices do share a position
// (a warning and the NM for the same unlit light, a correction and the notice
// it corrects, an exercise and its firing area: 17 notices had no icon of
// their own at any zoom, measured 2026-10-04). The circle is always there, so
// a tap answers with EVERY notice at that point, drawn or not.
//
// INERT when off: no source, no layer (and `./client.ts` stops polling).
// Colours come from the theme's `notices` block; a palette switch is a paint
// swap (`applyNoticesPaint`), never a style reload.

import type { FeatureCollection } from "geojson";
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LayerSpecification,
  Map as MLMap,
} from "maplibre-gl";
import { untrack, type Accessor } from "solid-js";
import {
  FILL_OPACITY,
  highlightFillPaint,
  highlightLayerSpecs,
  highlightMagenta,
} from "../../core/info/highlight";
import { addLayer } from "../../core/layers/addLayer";
import { Z, type Overlay } from "../../core/layers/overlay";
import { noticesColors, paletteColors, type Palette } from "../../core/style/colors";
import { TEXT_FONT } from "../../core/style/expr";
import { restrictedBoundaryPaint } from "../../core/style/aidsHazards";
import { CABLE_PATTERN_ASSET, linePatternImage, PATTERN_BAND_PX } from "../../core/style/cablesPipelines";
import { BADGE_PX, ensureNoticeIcons, ensureNoticeImages, noticeHatch, noticeIconExpr } from "./icons";

export const NOTICES_OVERLAY_ID = "notices";
export const NOTICES_SOURCE_ID = "notices";

/** Paints nothing (opacity 0): the areas' interiors as a TAP TARGET only. */
export const NOTICES_AREA_HIT_LAYER_ID = "notices-area-hit";
/** Paints nothing (opacity 0): every icon position as a TAP TARGET, whether
 * or not its icon survived the collision. */
export const NOTICES_POINT_HIT_LAYER_ID = "notices-point-hit";
export const NOTICES_HATCH_LAYER_ID = "notices-hatch";
export const NOTICES_OUTLINE_LAYER_ID = "notices-outline";
export const NOTICES_LINE_LAYER_ID = "notices-line";
export const NOTICES_CABLE_LAYER_ID = "notices-cable";
export const NOTICES_ICON_LAYER_ID = "notices-icon";
export const NOTICES_WARNING_ICON_LAYER_ID = "notices-icon-nw";
export const NOTICES_VERTEX_LABEL_LAYER_ID = "notices-vertex-label";

/** Bottom to top. */
export const NOTICES_LAYER_IDS = [
  NOTICES_AREA_HIT_LAYER_ID,
  NOTICES_HATCH_LAYER_ID,
  NOTICES_OUTLINE_LAYER_ID,
  NOTICES_LINE_LAYER_ID,
  NOTICES_CABLE_LAYER_ID,
  NOTICES_POINT_HIT_LAYER_ID,
  // Vertex labels BELOW the icons: symbols are placed top layer first, so
  // the icons claim their space and the (optional) labels yield to them.
  NOTICES_VERTEX_LABEL_LAYER_ID,
  NOTICES_ICON_LAYER_ID,
  NOTICES_WARNING_ICON_LAYER_ID,
] as const;

export const NOTICES_HIGHLIGHT_SOURCE_ID = "notices-hl";
export const NOTICES_HIGHLIGHT_FILL_LAYER_ID = "notices-hl-fill";
export const NOTICES_HIGHLIGHT_GLOW_LAYER_ID = "notices-hl-glow";
export const NOTICES_HIGHLIGHT_LINE_LAYER_ID = "notices-hl-line";
export const NOTICES_HIGHLIGHT_POINT_LAYER_ID = "notices-hl-point";

/** The selected-notice highlight, bottom to top — above the overlay's own
 * layers (same `Z.notices` band), so it outlines over the band and icons. */
export const NOTICES_HIGHLIGHT_LAYER_IDS = [
  NOTICES_HIGHLIGHT_FILL_LAYER_ID,
  NOTICES_HIGHLIGHT_GLOW_LAYER_ID,
  NOTICES_HIGHLIGHT_LINE_LAYER_ID,
  NOTICES_HIGHLIGHT_POINT_LAYER_ID,
] as const;

/** The layers a tap should hit (the info provider): icons, lines, the
 * boundary — and the interior, through the invisible `notices-area-hit`
 * fill. Each feature carries `msg` (the notice uuid) and `role`, which the
 * provider turns into a rank: icon/line/boundary hits keep the notice's own
 * priority (hazard/regulated), an interior hit (`role: "area"`) sits in the
 * chart's background-area tier — so a survey area covering half the
 * Kattegat shows up on a tap inside it WITHOUT heading depth and weather
 * (user, earlier: "when i click on one i should still have the ability to
 * switch to other poi near it like i normally can eg weather or depth").
 * `notices-point-hit` answers for an icon the collision dropped — same
 * role, so same rank as a drawn one. The firing-today hatch is paint, not a
 * target (the hit fill covers it). */
export const NOTICES_QUERY_LAYER_IDS: readonly string[] = [
  NOTICES_WARNING_ICON_LAYER_ID,
  NOTICES_ICON_LAYER_ID,
  NOTICES_POINT_HIT_LAYER_ID,
  NOTICES_CABLE_LAYER_ID,
  NOTICES_LINE_LAYER_ID,
  NOTICES_OUTLINE_LAYER_ID,
  NOTICES_AREA_HIT_LAYER_ID,
];

/** Zoom bands (efs.md §2.3). Integers: MapLibre's `["zoom"]` in a filter is
 * the tile's integer z (CLAUDE.md), and these are layer min/maxzooms anyway. */
export const NOTICES_ZOOM = {
  /** Icons from here; no point marker at all below it. */
  icons: 10,
  /** shortId labels next to the icon (the icon symbol's own text). */
  label: 11,
  /** "3) grøn stage Q.G" vertex labels. */
  vertex: 13,
} as const;

/** Time-state styling (efs.md §2.2): active full, upcoming half, ended faint
 * (ended only reaches the map with "Show ended" on). */
export const NOTICES_STYLE = {
  hatchOpacity: { a: 0.55, u: 0.35, e: 0.2 },
  /** Over the chart's own boundary/line paint: the only time-state cue a
   * chart-styled line takes (its dash is the chart's, never re-dashed). */
  lineOpacity: { a: 1, u: 0.55, e: 0.35 },
  iconOpacity: { a: 1, u: 0.6, e: 0.4 },
} as const;

/** The S-52 boundary colour token (`bcol`) of the S-57 class a notice family
 * stands in for, as chartcore bakes it (chartcore/src/derive/restricted.rs):
 * MIPARE → CHMGD for firing exercises/areas, CTNARE → TRFCD for the rest. */
export const NOTICE_BCOL: ExpressionSpecification = ["match", ["get", "fam"], ["fe", "fa"], "CHMGD", "TRFCD"];

/** A cable line's `bcol`: CBLSUB bakes CHMGD (chartcore/src/derive/cables.rs). */
const CABLE_BCOL = "CHMGD";

/** Icon placement priority (`symbol-sort-key`, lower wins a collision):
 * firing first, then the temporary/preliminary NMs, permanent, quiet ranges.
 * Warnings sit on their own always-placed layer above. */
export const ICON_PRIORITY: Record<string, number> = {
  warning: 0,
  firing: 1,
  temporary: 2,
  preliminary: 3,
  permanent: 4,
  inactive: 5,
};

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const get = (k: string): ExpressionSpecification => ["get", k];
const isRole = (...roles: string[]): ExpressionSpecification =>
  roles.length === 1 ? ["==", get("role"), roles[0]!] : ["in", get("role"), ["literal", roles]];

/** A value per time state `st`. */
function byState(v: { a: number; u: number; e: number }): ExpressionSpecification {
  return ["match", get("st"), "u", v.u, "e", v.e, v.a];
}

const IS_WARNING: ExpressionSpecification = ["==", get("fc"), "warning"];

export const FILTERS = {
  /** Every area's interior — the invisible tap target. */
  area: isRole("area"),
  /** Firing today: an exercise's own area, or a permanent area in use. */
  hatch: ["all", isRole("area"), ["==", get("ft"), true]] as ExpressionSpecification,
  /** The areas' boundaries, each shared edge once (`boundaryEdges`, ./time.ts). */
  outline: isRole("edge"),
  /** Lines other than cables: the family's area boundary. */
  line: ["all", isRole("line"), ["!=", get("cls"), "cable"], ["!", ["to-boolean", get("dup")]]] as ExpressionSpecification,
  /** Cables: the chart's CBLSUB pattern. */
  cable: ["all", isRole("line"), ["==", get("cls"), "cable"], ["!", ["to-boolean", get("dup")]]] as ExpressionSpecification,
  /** Every icon position, placed or not — the invisible tap target. */
  pointHit: isRole("point", "anchor"),
  /** Icons that may yield to a higher-priority icon. */
  icon: ["all", isRole("point", "anchor"), ["!", IS_WARNING]] as ExpressionSpecification,
  /** Warnings' icons — never dropped. */
  warningIcon: ["all", isRole("point", "anchor"), IS_WARNING] as ExpressionSpecification,
  vertex: ["all", isRole("point", "vertex"), ["has", "vtx"]] as ExpressionSpecification,
} as const;

/** Smaller areas over larger ones: `ar` is −area (`./shape.ts`), and a
 * higher sort key draws later. Features without one (an unshaped snapshot)
 * draw first. */
const AREA_SORT: ExpressionSpecification = ["coalesce", get("ar"), -1e9];

const ICON_SORT = ["match", get("fc"), ...Object.entries(ICON_PRIORITY).flat(), 9] as unknown as ExpressionSpecification;

/** Icon + its shortId label as ONE symbol: the label is optional (it may
 * yield to a neighbour) but can never outlive its icon. */
function iconLayer(id: string, filter: ExpressionSpecification, palette: Palette, alwaysPlace: boolean): LayerSpecification {
  const c = noticesColors(palette);
  return {
    id,
    type: "symbol",
    source: NOTICES_SOURCE_ID,
    filter,
    minzoom: NOTICES_ZOOM.icons,
    layout: {
      "icon-image": noticeIconExpr(palette),
      // A warning is never dropped in a crowd — placement may hide chart
      // text under it, never the notice itself. The rest yield, firing first.
      "icon-allow-overlap": alwaysPlace,
      "icon-ignore-placement": false,
      "icon-optional": false,
      "symbol-sort-key": ICON_SORT,
      "text-field": ["step", ["zoom"], "", NOTICES_ZOOM.label, ["coalesce", get("lbl"), ""]],
      "text-font": TEXT_FONT,
      "text-size": 11,
      // Beside the icon, whichever side is free; clears the sub badge.
      "text-variable-anchor": ["left", "right", "bottom", "top"],
      "text-radial-offset": 1.3,
      "text-justify": "auto",
      "text-optional": true,
      "text-allow-overlap": false,
    },
    paint: {
      "icon-opacity": byState(NOTICES_STYLE.iconOpacity),
      "text-color": c.label,
      "text-halo-color": c.halo,
      "text-halo-width": 1.4,
      "text-opacity": byState(NOTICES_STYLE.iconOpacity),
    },
  } as LayerSpecification;
}

/** The chart boundary paint (core/style/aidsHazards.ts) for a notice
 * area/line, its time state as opacity on top. */
function boundaryPaint(palette: Palette): Record<string, unknown> {
  return {
    ...restrictedBoundaryPaint(paletteColors(palette), NOTICE_BCOL),
    "line-opacity": byState(NOTICES_STYLE.lineOpacity),
  };
}

/** The chart's CBLSUB cable pattern (core/style/cablesPipelines.ts). */
function cablePaint(palette: Palette): Record<string, unknown> {
  const C = paletteColors(palette);
  return {
    // Shows only until the lazily-loaded pattern lands (as on the chart).
    "line-color": C.CHMGD,
    "line-width": PATTERN_BAND_PX,
    "line-pattern": linePatternImage(CABLE_PATTERN_ASSET, C, ["literal", CABLE_BCOL]),
    "line-opacity": byState(NOTICES_STYLE.lineOpacity),
  };
}

function layerSpecs(palette: Palette): LayerSpecification[] {
  const c = noticesColors(palette);
  const text = {
    "text-color": c.label,
    "text-halo-color": c.halo,
    "text-halo-width": 1.4,
    "text-opacity": byState(NOTICES_STYLE.iconOpacity),
  };
  return [
    {
      // A TAP TARGET, not paint: queryRenderedFeatures returns a fill's
      // feature for any point inside it whatever its opacity, so this makes
      // an interior tap find the notice (ranked area-tier, ./provider.ts).
      id: NOTICES_AREA_HIT_LAYER_ID,
      type: "fill",
      source: NOTICES_SOURCE_ID,
      filter: FILTERS.area,
      paint: { "fill-color": "rgba(0,0,0,0)", "fill-opacity": 0 },
    },
    {
      // Firing today: the one fill a notice keeps, under the MIPARE line.
      id: NOTICES_HATCH_LAYER_ID,
      type: "fill",
      source: NOTICES_SOURCE_ID,
      filter: FILTERS.hatch,
      layout: { "fill-sort-key": AREA_SORT },
      paint: { "fill-pattern": noticeHatch(palette), "fill-opacity": byState(NOTICES_STYLE.hatchOpacity) },
    },
    {
      id: NOTICES_OUTLINE_LAYER_ID,
      type: "line",
      source: NOTICES_SOURCE_ID,
      filter: FILTERS.outline,
      layout: { "line-sort-key": AREA_SORT },
      paint: boundaryPaint(palette),
    },
    {
      id: NOTICES_LINE_LAYER_ID,
      type: "line",
      source: NOTICES_SOURCE_ID,
      filter: FILTERS.line,
      paint: boundaryPaint(palette),
    },
    {
      id: NOTICES_CABLE_LAYER_ID,
      type: "line",
      source: NOTICES_SOURCE_ID,
      filter: FILTERS.cable,
      paint: cablePaint(palette),
    },
    {
      // A TAP TARGET, not paint: a circle answers queryRenderedFeatures
      // whatever its opacity, and unlike a symbol it is never dropped by a
      // collision. The badge's footprint, from the zoom icons appear at.
      id: NOTICES_POINT_HIT_LAYER_ID,
      type: "circle",
      source: NOTICES_SOURCE_ID,
      filter: FILTERS.pointHit,
      minzoom: NOTICES_ZOOM.icons,
      paint: { "circle-radius": BADGE_PX / 2, "circle-color": "rgba(0,0,0,0)", "circle-opacity": 0 },
    },
    {
      id: NOTICES_VERTEX_LABEL_LAYER_ID,
      type: "symbol",
      source: NOTICES_SOURCE_ID,
      filter: FILTERS.vertex,
      minzoom: NOTICES_ZOOM.vertex,
      layout: {
        "text-field": get("vtx"),
        "text-font": TEXT_FONT,
        "text-size": 10,
        "text-anchor": "top",
        "text-offset": [0, 1.2],
        "text-max-width": 14,
        "text-optional": true,
      },
      paint: text,
    },
    iconLayer(NOTICES_ICON_LAYER_ID, FILTERS.icon, palette, false),
    iconLayer(NOTICES_WARNING_ICON_LAYER_ID, FILTERS.warningIcon, palette, true),
  ] as LayerSpecification[];
}

const IS_POINT: ExpressionSpecification = ["==", ["geometry-type"], "Point"];

/** The selected notice in the chart's own selection look
 * (core/info/highlight.ts `highlightLayerSpecs` — the wash, halo and magenta
 * edge a tapped DEPARE gets): the wash fills its areas (the core gates the
 * fill on Polygon), the halo + edge trace its areas and lines. Edges are
 * skipped — the polygon's own outline is that line already. A point notice
 * gets the same magenta as a ring with the halo under it (the chart marks a
 * point object with its magenta marker; the ring says which icon). */
function highlightSpecs(palette: Palette): LayerSpecification[] {
  const magenta = highlightMagenta(palette);
  return [
    ...highlightLayerSpecs(
      [NOTICES_HIGHLIGHT_FILL_LAYER_ID, NOTICES_HIGHLIGHT_GLOW_LAYER_ID, NOTICES_HIGHLIGHT_LINE_LAYER_ID],
      { source: NOTICES_HIGHLIGHT_SOURCE_ID, filter: ["all", ["!", IS_POINT], ["!=", get("role"), "edge"]] },
      palette,
    ),
    {
      id: NOTICES_HIGHLIGHT_POINT_LAYER_ID,
      type: "circle",
      source: NOTICES_HIGHLIGHT_SOURCE_ID,
      filter: ["all", IS_POINT, isRole("point", "anchor")],
      paint: {
        "circle-radius": 15,
        "circle-color": magenta,
        "circle-opacity": FILL_OPACITY,
        "circle-stroke-color": magenta,
        "circle-stroke-width": 3,
        "circle-blur": 0,
      },
    },
  ] as LayerSpecification[];
}

/** Where a layer added at RUNTIME (the toggle turned on, no re-hoist follows)
 * goes: just above the chart/imagery/POI band, i.e. directly under whatever
 * overlay sits above it — the track by default, never above route/AIS/own-
 * ship. On a style load the generic hoist (`ensureOverlays`) re-seats it by
 * `Z.notices` anyway; this only keeps the between-loads stack right. */
export function insertBeforeId(map: MLMap): string | undefined {
  const layers = map.getStyle?.()?.layers ?? [];
  let top = -1;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!;
    const src = (l as { source?: unknown }).source;
    const below =
      l.type === "background" ||
      (typeof src === "string" && (src.startsWith("chart-") || src === "openseamap" || src === "osm-world")) ||
      l.id === "satellite" ||
      l.id.startsWith("poi-") ||
      l.id.startsWith("notices-");
    if (below) top = i;
  }
  return top >= 0 ? layers[top + 1]?.id : undefined;
}

/** Idempotent: (re-)create the source, this palette's images and every layer
 * that is missing, in stack order. */
export function ensureNoticesLayers(map: MLMap, palette: Palette): void {
  if (!map.getSource(NOTICES_SOURCE_ID)) {
    map.addSource(NOTICES_SOURCE_ID, { type: "geojson", data: EMPTY });
  }
  ensureNoticeImages(map, palette);
  for (const spec of layerSpecs(palette)) {
    if (map.getLayer(spec.id)) continue;
    // Above our own previous layer if present, so a partial re-add keeps
    // the bottom→top order; else at the band top.
    addLayer(map, spec, insertBeforeId(map));
  }
}

/** Install the highlight source and layers (idempotent). Independent of the
 * overlay's own on/off: a notice opened from the list with the overlay off
 * is still shown. */
export function ensureHighlightLayers(map: MLMap, palette: Palette): void {
  if (!map.getSource(NOTICES_HIGHLIGHT_SOURCE_ID)) {
    map.addSource(NOTICES_HIGHLIGHT_SOURCE_ID, { type: "geojson", data: EMPTY });
  }
  for (const spec of highlightSpecs(palette)) {
    if (map.getLayer(spec.id)) continue;
    addLayer(map, spec, insertBeforeId(map));
  }
}

export function removeHighlightLayers(map: MLMap): void {
  for (const id of [...NOTICES_HIGHLIGHT_LAYER_IDS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(NOTICES_HIGHLIGHT_SOURCE_ID)) map.removeSource(NOTICES_HIGHLIGHT_SOURCE_ID);
}

/** Off: layers first, then the source. */
export function removeNoticesLayers(map: MLMap): void {
  for (const id of [...NOTICES_LAYER_IDS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(NOTICES_SOURCE_ID)) map.removeSource(NOTICES_SOURCE_ID);
}

/** Recolour for a palette — paint/layout swaps only, guarded per layer. The
 * palette's images are registered first so the swapped `icon-image` never
 * names a missing one. */
export function applyNoticesPaint(map: MLMap, palette: Palette, features?: FeatureCollection): void {
  if (!map.getSource(NOTICES_SOURCE_ID)) return;
  ensureNoticeImages(map, palette);
  if (features) ensureNoticeIcons(map, palette, features.features);
  const c = noticesColors(palette);
  const paint = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  };
  const layout = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, prop, value);
  };
  paint(NOTICES_HATCH_LAYER_ID, "fill-pattern", noticeHatch(palette));
  const bdy = boundaryPaint(palette);
  for (const id of [NOTICES_OUTLINE_LAYER_ID, NOTICES_LINE_LAYER_ID]) paint(id, "line-color", bdy["line-color"]);
  const cable = cablePaint(palette);
  paint(NOTICES_CABLE_LAYER_ID, "line-color", cable["line-color"]);
  paint(NOTICES_CABLE_LAYER_ID, "line-pattern", cable["line-pattern"]);
  for (const id of [NOTICES_ICON_LAYER_ID, NOTICES_WARNING_ICON_LAYER_ID]) layout(id, "icon-image", noticeIconExpr(palette));
  for (const id of [NOTICES_ICON_LAYER_ID, NOTICES_WARNING_ICON_LAYER_ID, NOTICES_VERTEX_LABEL_LAYER_ID]) {
    paint(id, "text-color", c.label);
    paint(id, "text-halo-color", c.halo);
  }
}

/** Recolour the highlight for a palette (no-op when not installed): the
 * same magenta the chart's own selection takes in this palette. */
export function applyHighlightPaint(map: MLMap, palette: Palette): void {
  if (!map.getSource(NOTICES_HIGHLIGHT_SOURCE_ID)) return;
  const magenta = highlightMagenta(palette);
  const paint = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  };
  paint(NOTICES_HIGHLIGHT_FILL_LAYER_ID, "fill-color", highlightFillPaint(palette)["fill-color"]);
  paint(NOTICES_HIGHLIGHT_LINE_LAYER_ID, "line-color", magenta);
  paint(NOTICES_HIGHLIGHT_POINT_LAYER_ID, "circle-color", magenta);
  paint(NOTICES_HIGHLIGHT_POINT_LAYER_ID, "circle-stroke-color", magenta);
}

export function updateNoticesData(map: MLMap, data: FeatureCollection): void {
  const source = map.getSource(NOTICES_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(data);
}

/** The slice of the feature the overlay reads. */
export interface NoticesOverlayModel {
  /** `showNotices` — off removes everything. */
  enabled: Accessor<boolean>;
  /** The prepared collection (`prepareNotices`), re-derived each minute and
   * on any toggle change. */
  features: Accessor<FeatureCollection>;
  /** Called with the live map on `ensure` — the info provider (task 5) is
   * built before the map exists and queries it through this. */
  onMap?: (map: MLMap) => void;
  /** The selected notice's features (prepared: `fc` set), or null for no
   * selection. Drawn whether or not the overlay is on. */
  highlight?: Accessor<FeatureCollection | null>;
}

export function createNoticesOverlay(model: NoticesOverlayModel): Overlay {
  /** Highlight upkeep: installed only while there is something to show, so
   * an idle, off overlay stays inert (no source, no layer). */
  const syncHighlight = (map: MLMap, palette: () => Palette) => {
    const hl = model.highlight?.() ?? null;
    if (!hl || hl.features.length === 0) {
      removeHighlightLayers(map);
      return;
    }
    if (!map.getSource(NOTICES_HIGHLIGHT_SOURCE_ID)) ensureHighlightLayers(map, untrack(palette));
    (map.getSource(NOTICES_HIGHLIGHT_SOURCE_ID) as GeoJSONSource | undefined)?.setData(hl);
  };
  return {
    id: NOTICES_OVERLAY_ID,
    layerIds: [...NOTICES_LAYER_IDS, ...NOTICES_HIGHLIGHT_LAYER_IDS],
    z: Z.notices,
    ensure(map, ctx) {
      model.onMap?.(map);
      if (model.enabled()) ensureNoticesLayers(map, ctx.settings().palette);
      else removeNoticesLayers(map);
      // A style reload dropped the highlight source; `update` refills it.
      removeHighlightLayers(map);
    },
    update(map, ctx) {
      syncHighlight(map, () => ctx.settings().palette);
      if (!model.enabled()) {
        removeNoticesLayers(map);
        return;
      }
      // Runtime toggle-on: ensure is not re-run, so install here. Palette
      // untracked — `paint` owns recolouring, and this effect must not re-run
      // (re-`setData`) on every unrelated settings write.
      if (!map.getSource(NOTICES_SOURCE_ID)) {
        ensureNoticesLayers(map, untrack(() => ctx.settings().palette));
        // Keep the highlight above the freshly added overlay layers.
        for (const id of NOTICES_HIGHLIGHT_LAYER_IDS) if (map.getLayer(id)) map.moveLayer(id, insertBeforeId(map));
      }
      const data = model.features();
      // The icons this data names, drawn before the source sees it.
      ensureNoticeIcons(map, untrack(() => ctx.settings().palette), data.features);
      updateNoticesData(map, data);
    },
    paint(map, ctx) {
      // Tracks enabled too, so a toggle-on (which installs with the palette
      // of that moment) is recoloured if the palette moved meanwhile.
      model.enabled();
      model.highlight?.();
      const palette = ctx.settings().palette;
      applyNoticesPaint(map, palette, untrack(model.features));
      applyHighlightPaint(map, palette);
    },
  };
}
