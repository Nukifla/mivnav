// S-52 → MapLibre style generator (Phase 3 skin of the earth; Phase 5 in ./aidsHazards.ts).
// Pure function, re-run per settings change and applied via `setStyle(style,{diff:true})` so a change diffs to setPaintProperty calls, never a tile refetch.
// See docs/architecture/chart-style-generator.md for design rules and layer order.

import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";
import type { ChartSet, VectorLayer } from "../catalog";
import { tileUrl } from "../chartProtocol";
import { catalogBounds } from "../initialView";
import { aidsHazardsAreaLayers, aidsHazardsSymbolLayers } from "./aidsHazards";
import { bridgesLineLayers, bridgesSymbolLayers } from "./bridges";
import { cablesPipelinesLineLayers, cablesPipelinesSymbolLayers } from "./cablesPipelines";
import {
  trafficRoutesAreaLayers,
  trafficRoutesLineLayers,
  trafficRoutesSymbolLayers,
} from "./trafficRoutes";
import { waterwaysLineLayers } from "./waterways";
import { industrialAreaLayers, industrialSymbolLayers } from "./industrial";
import { lndmrkAreaLayers, lndmrkSymbolLayers } from "./lndmrk";
import { sbdareLineLayers, sbdareSymbolLayers } from "./sbdare";
import { seaareSymbolLayers } from "./seaare";
import { stationsLineLayers, stationsSymbolLayers } from "./stations";
import { debugLayers } from "./debugLayers";
import { AREA_HIT_SUFFIX, areaHitFilter, type DrawnLayer } from "./areaHit";
import { basemapColors, haloPaint, paletteColors, themeFonts, type Palette } from "./colors";
import { THEME_BY_ID } from "./themes";
import { overrideField } from "./themes/override";
import {
  LAND_WASH_OPACITY,
  line,
  lowacc,
  matchIn,
  point,
  poly,
  PRIO,
  scaminVisible,
  soundingText,
  TEXT_FONT,
  type AddLayer,
  type ChartLayer,
  type Prio,
  type PrioritizedLayer,
  type ScaminBias,
} from "./expr";
import { scaminFadeOpacity } from "./sectorGate";
import { NODATA_PATTERN_ID } from "./nodataPattern";
import {
  ENC_GROUP_META,
  groupForLayer,
  type EncGroupState,
  type EncGroupsState,
} from "./encGroups";
import { DEFAULT_SETTINGS, normalizedContours, type ChartSettings } from "./settings";

export interface StyleOptions {
  /** Add hue-hashed debug layers for MVT layers the generator does not
   * style yet (the Phase 1 debug view, now catalog-driven). */
  debug?: boolean;
  /** Introspection hook: `add()` records every source-layer it's called with
   * into this, before the `present` gate — the ground truth
   * `styledSourceLayers()` and the cross-language test build on. */
  styled?: Set<string>;
  /** ENC tile URL epoch (`?e=<n>`): bump when serving-detail config changes
   * tile geometry so caches miss and the backend re-cuts. See
   * docs/architecture/chart-style-options.md. */
  chartEpoch?: number;
  /** Boat-wide SCAMIN bias (serverConfig `chart_detail*`). See
   * docs/architecture/chart-style-options.md. */
  chartDetail?: ScaminBias | number;
  /** Set ids the mariner turned off (#snyzntrn). See
   * docs/architecture/chart-style-options.md for why "ocharts"-kind sets
   * filter client-side instead of being omitted like "pmtiles" ones. */
  disabledSets?: string[];
  /** The "osm-world" source's live zoom range, off `/osm_world/catalog`;
   * unset falls back to `FALLBACK_OSM_WORLD_MIN_ZOOM`/`MAX_ZOOM`. */
  osmWorldMinZoom?: number;
  osmWorldMaxZoom?: number;
  /** Which o-charts union the `chart-all` source draws: `all` (the default),
   * or `free` — the unlicensed sets only, for a screen that is not a
   * registered o-charts device (core/ochartsDevice.ts). A different URL, not
   * a per-cookie answer, so URL-keyed tile caches can't mix the two. */
  ochartsUnion?: "all" | "free";
}

/** Static fallback for {@link StyleOptions.osmWorldMinZoom}/`MaxZoom`, used
 * until a caller's own `/osm_world/catalog` fetch resolves. NOT re-derived
 * from backend config at build time — keep in sync by hand. */
export const FALLBACK_OSM_WORLD_MIN_ZOOM = 0;
export const FALLBACK_OSM_WORLD_MAX_ZOOM = 8;

/** Source-layers the generator *deliberately* draws nothing for, kept out of
 * `styledSourceLayers()` so the debug view doesn't hue-hash them back on:
 * LNDRGN's fill pattern is deferred (LANDA covers it meanwhile); `_nodata`
 * draws nothing per the PRIO.NODATA band below. */
export const ADVERTISED_AS_NOTHING: ReadonlySet<string> = new Set(["_nodata", "LNDRGN"]);

/** MVT layers the generator styles; everything else is debug-only. Derived
 * from the actual `add()` call sites so a styled class can't silently fall
 * out of the debug exclusion set. Lazily memoized: module consts it reads
 * are still in their TDZ at module-init. */
let _styledLayers: ReadonlySet<string> | undefined;
function styledLayers(): ReadonlySet<string> {
  return (_styledLayers ??= new Set([...styledSourceLayers(), ...ADVERTISED_AS_NOTHING]));
}

/** Self-hosted glyphs: the boat's offline Pi can't reach MapLibre's demotiles
 * glyph server. Noto Sans Medium (OFL) PBF fontstack under
 * `frontend/public/fonts/`, root-relative to survive the reverse proxy. */
export const GLYPHS_URL = "/fonts/{fontstack}/{range}.pbf";

/** Alpha of LNDARE when `showOsmOnLand` is on — deliberately neither 1 nor 0
 * (LNDARE is DISPLAYBASE, must stay legible with no basemap) and a constant,
 * not a slider. See docs/architecture/land-wash-and-nodata-pattern.md.
 * LNDMRK's and SILTNK/PRDARE's opaque `AC(CHBRN)` fills wash too, and further
 * (expr.ts's LAND_FEATURE_WASH_OPACITY), while their boundaries stay opaque. */
export { LAND_WASH_OPACITY } from "./expr";

/** The S-52 "area of no chart data" pattern, AP(NODATA03), tiled over UNSARE,
 * drawn at runtime by ./nodataPattern.ts rather than off a sprite sheet. See
 * docs/architecture/land-wash-and-nodata-pattern.md. */
const NODATA_PATTERN = NODATA_PATTERN_ID;

/** Group-1 fills never carry `scamin` (resolved at chartcore build time), so
 * folding the fade in would just churn paint on every zoom for no visible
 * change. See docs/architecture/scamin-fade-and-enc-groups.md. */
const NO_FADE_FILL: ReadonlySet<string> = new Set([
  "UNSARE",
  "DEPARE",
  "DRGARE",
  "LNDARE",
  "SLCONS",
]);

/** Folds the uniform SCAMIN fade into a layer's opacity so a decluttered
 * feature fades instead of popping. See
 * docs/architecture/scamin-fade-and-enc-groups.md. */
function withScaminFade(
  layer: ChartLayer,
  sourceLayer: string,
  chartDetail: ScaminBias | number,
  exempt?: ExpressionSpecification,
): ChartLayer {
  const type = layer.type;
  if (type !== "symbol" && type !== "line" && type !== "fill") return layer;
  if (type === "fill" && NO_FADE_FILL.has(sourceLayer)) return layer;
  const paint: Record<string, unknown> = {
    ...((layer as { paint?: Record<string, unknown> }).paint ?? {}),
  };
  const fold = (key: string) => {
    const base = paint[key] as ExpressionSpecification | number | undefined;
    paint[key] = scaminFadeOpacity(chartDetail, base, exempt);
  };
  if (type === "fill") fold("fill-opacity");
  else if (type === "line") fold("line-opacity");
  else {
    const layout = (layer as { layout?: Record<string, unknown> }).layout ?? {};
    if ("icon-image" in layout) fold("icon-opacity");
    if ("text-field" in layout) fold("text-opacity");
  }
  return { ...layer, paint } as ChartLayer;
}

/** The opacity paint keys a layer of each kind actually carries, so a
 * group's opacity multiplies into exactly what the layer draws. */
function opacityKeys(layer: ChartLayer): string[] {
  switch (layer.type) {
    case "fill":
      return ["fill-opacity"];
    case "line":
      return ["line-opacity"];
    case "circle":
      return ["circle-opacity", "circle-stroke-opacity"];
    case "symbol": {
      const layout = (layer as { layout?: Record<string, unknown> }).layout ?? {};
      const keys: string[] = [];
      if ("icon-image" in layout) keys.push("icon-opacity");
      if ("text-field" in layout) keys.push("text-opacity");
      return keys;
    }
    default:
      return [];
  }
}

/** Folds an ENC GROUP's visibility + opacity into a chart layer and stamps
 * it with the group id ({@link ENC_GROUP_META}). Opacity-1-and-visible diffs
 * to nothing. See docs/architecture/scamin-fade-and-enc-groups.md. */
function applyEncGroup(
  layer: ChartLayer,
  prio: Prio,
  groups: EncGroupsState | undefined,
): ChartLayer {
  const group = groupForLayer(prio, layer.id);
  const meta = group ? { [ENC_GROUP_META]: group } : {};
  const tagged = { ...layer, metadata: { ...(layer as { metadata?: object }).metadata, ...meta } };
  const state: EncGroupState | undefined = group ? groups?.[group] : undefined;
  if (!state || (state.visible && state.opacity === 1)) return tagged as ChartLayer;

  const paint: Record<string, unknown> = {
    ...((tagged as { paint?: Record<string, unknown> }).paint ?? {}),
  };
  if (state.opacity !== 1) {
    for (const key of opacityKeys(layer)) {
      const base = paint[key] as ExpressionSpecification | number | undefined;
      paint[key] =
        base === undefined ? state.opacity : (["*", state.opacity, base] as ExpressionSpecification);
    }
  }
  const layout = { ...((tagged as { layout?: Record<string, unknown> }).layout ?? {}) };
  if (!state.visible) layout.visibility = "none";
  return { ...tagged, paint, layout } as ChartLayer;
}

// ---- per-class expression builders ----------------------------------------

/** S-52 SEABED01 as a fill-color expression (S52CondRules.cpp). Branches
 * are ordered deepest-first, matching SEABED01's "last match wins". */
function seabed01(settings: ChartSettings): DataDrivenPropertyValueSpecification<string> {
  const C = paletteColors(settings.palette);
  const { shallow, safety, deep } = normalizedContours(settings);
  const atLeast = (limit: number): ExpressionSpecification => [
    "all",
    [">=", ["get", "drval1"], limit],
    [">", ["get", "drval2"], limit],
  ];
  return [
    "case",
    ["!", ["has", "drval1"]], C.DEPMD,
    atLeast(deep), C.DEPDW,
    atLeast(safety), C.DEPMD,
    atLeast(shallow), C.DEPMS,
    atLeast(0), C.DEPVS,
    C.DEPIT,
  ];
}

/** Is this DEPCNT-layer feature the safety contour (DEPCNT02)? See
 * docs/architecture/scamin-fade-and-enc-groups.md for the two feature
 * shapes this must handle. */
function isSafetyContour(settings: ChartSettings): ExpressionSpecification {
  const safety = settings.safetyContour;
  return [
    "any",
    [
      "all",
      ["has", "VALDCO"],
      [">=", ["get", "VALDCO"], safety],
      ["any", ["!", ["has", "valdco_prev"]], ["<", ["get", "valdco_prev"], safety]],
    ],
    [
      "all",
      ["!", ["has", "VALDCO"]],
      ["has", "drval1"],
      [
        "any",
        ["all", ["<=", ["get", "drval1"], safety], [">=", ["get", "drval2"], safety]],
        [
          "all",
          [">=", ["get", "drval1"], safety],
          ["any", ["!", ["has", "valdco_prev"]], ["<", ["get", "valdco_prev"], safety]],
        ],
      ],
    ],
  ];
}

/** Style layers for one chart set, tagged with its draw-order band. Returns
 * bands rather than a bottom-to-top array because `buildStyle` sorts across
 * sets; emission order here is kept nondecreasing in `prio` regardless, so a
 * single-set style's sort is the identity. */
export function chartSetLayers(
  set: ChartSet,
  settings: ChartSettings,
  opts: StyleOptions = {},
): PrioritizedLayer[] {
  const source = `chart-${set.id}`;
  const C = paletteColors(settings.palette);
  const present = new Set(set.vector_layers.map((v) => v.id));
  const layers: PrioritizedLayer[] = [];
  // SCAMIN gate is a filter, not a paint case (decluttering must free label
  // space), always applied. See docs/architecture/scamin-fade-and-enc-groups.md.
  const chartDetail = opts.chartDetail ?? 1;
  const gateExpr = scaminVisible(chartDetail);
  // disabledSets only matters for the chart-all union source; see
  // docs/architecture/scamin-fade-and-enc-groups.md.
  const disabled = opts.disabledSets;
  const setFilter: ExpressionSpecification | undefined =
    set.kind === "ocharts" && disabled && disabled.length > 0
      ? ["!", ["in", ["get", "set"], ["literal", disabled]]]
      : undefined;
  // What each class is drawn with, for the interior tap targets derived at
  // the end (./areaHit.ts).
  const drawnBy = new Map<string, DrawnLayer[]>();
  const add: AddLayer = (prio, sourceLayer, layer, scaminExempt) => {
    opts.styled?.add(sourceLayer);
    if (!present.has(sourceLayer)) return;
    const gate: ExpressionSpecification = scaminExempt
      ? ["any", scaminExempt, gateExpr]
      : gateExpr;
    // ChartLayer spans filter-less kinds (background, raster) too, though no
    // chart layer is one.
    const own = "filter" in layer ? (layer.filter as ExpressionSpecification | undefined) : undefined;
    const clauses: ExpressionSpecification[] = [
      gate,
      ...(own ? [own] : []),
      ...(setFilter ? [setFilter] : []),
    ];
    const filter: ExpressionSpecification =
      clauses.length > 1 ? ["all", ...clauses] : clauses[0];
    const grouped = applyEncGroup(layer, prio, settings.encGroups);
    const drawn = drawnBy.get(sourceLayer) ?? [];
    drawnBy.set(sourceLayer, drawn);
    drawn.push({
      type: layer.type,
      filter: own,
      visible: (grouped as { layout?: { visibility?: string } }).layout?.visibility !== "none",
      scaminExempt,
    });
    // Order load-bearing: withScaminFade must run AFTER applyEncGroup and
    // fold its already-multiplied opacity in, never wrap a built zoom
    // expression — see docs/architecture/scamin-fade-and-enc-groups.md.
    const faded = withScaminFade(grouped, sourceLayer, chartDetail, scaminExempt);
    layers.push({
      prio,
      layer: {
        ...faded,
        ...(filter ? { filter } : {}),
        source,
        "source-layer": sourceLayer,
      } as LayerSpecification,
    });
  };

  // -- PRIO.NODATA: no-data and unsurveyed ----------------------------------
  // `_nodata` (M_COVR CATCOV=2, "no ENC coverage") is deliberately NOT
  // painted, per USER 2026-07-17 override; UNSARE ("charted, unsurveyed") is
  // a different S-52 statement and keeps full opaque treatment. See
  // docs/architecture/nodata-not-painted.md.
  add(PRIO.NODATA, "UNSARE", {
    id: `${source}-unsare`,
    type: "fill",
    paint: { "fill-color": C.NODTA },
  });
  add(PRIO.NODATA, "UNSARE", {
    id: `${source}-unsare-pattern`,
    type: "fill",
    // The style's ONE fill pattern, and removing it is what let `sprite:` go
    // entirely (jt sustkllt) — see docs/architecture/land-wash-and-nodata-pattern.md.
    paint: { "fill-pattern": NODATA_PATTERN },
  });
  add(PRIO.NODATA, "UNSARE", {
    id: `${source}-unsare-edge`,
    type: "line",
    paint: { "line-color": C.CHGRD, "line-width": 2 },
  });

  // -- PRIO.GROUP1: group-1 fills (skin of the earth) -----------------------
  const ramp = seabed01(settings);
  // Fill layers render only polygon geometry, so no geometry filter is
  // needed despite LNDARE/DEPARE sharing source-layers with line/point primitives.
  add(PRIO.GROUP1, "DEPARE", {
    id: `${source}-depare`,
    type: "fill",
    paint: { "fill-color": ramp },
  });
  add(PRIO.GROUP1, "DRGARE", {
    id: `${source}-drgare`,
    type: "fill",
    paint: { "fill-color": ramp },
  });
  // DEPARE01 gives dredged areas a dashed CHGRF boundary (the AP(DRGARE01)
  // dredge pattern is deferred with the sprite builder)
  add(PRIO.GROUP1, "DRGARE", {
    id: `${source}-drgare-edge`,
    type: "line",
    paint: { "line-color": C.CHGRF, "line-width": 1, "line-dasharray": [4, 4] },
  });
  // The one layer `showOsmOnLand` touches: LANDA opaque→wash. Alpha is
  // written out in both states so the setStyle diff stays one setPaintProperty.
  add(PRIO.GROUP1, "LNDARE", {
    id: `${source}-lndare`,
    type: "fill",
    paint: {
      "fill-color": C.LANDA,
      "fill-opacity": settings.showOsmOnLand ? LAND_WASH_OPACITY : 1,
    },
  });

  // -- PRIO.LAND_POINT: land as a point — SY(LNDARE01) sprite deferred, circle
  // fallback. Stays opaque under showOsmOnLand: a 3px islet symbol has no
  // OSM detail worth revealing. Unlike land areas these carry `scamin`
  // (derive::land_point_scamin), so the shared gate hides them zoomed out.
  add(PRIO.LAND_POINT, "LNDARE", {
    id: `${source}-lndare-point`,
    type: "circle",
    filter: point,
    paint: {
      "circle-radius": 3,
      "circle-color": C.LANDA,
      "circle-stroke-color": C.CSTLN,
      "circle-stroke-width": 1,
    },
  });

  // -- PRIO.HAZARD_FILL … PRIO.HAZARD_LINE: hazard/restricted-area fills,
  // boundaries and line hazards (specs-12.md §3.0). Traffic-routes group
  // rides the same loops except TSEZNE (PRIO.TSS_FILL), which has no derived
  // attributes and gets its own call.
  aidsHazardsAreaLayers(add, source, settings);
  bridgesLineLayers(add, source, settings);
  trafficRoutesAreaLayers(add, source, settings);

  // -- PRIO.INDUSTRIAL_FILL / BOUNDARY: SILTNK/PRDARE -----------------------
  industrialAreaLayers(add, source, settings);

  // -- PRIO.LNDMRK_FILL / BOUNDARY: LNDMRK's Area/Line rows ------------------
  lndmrkAreaLayers(add, source, settings);

  // -- PRIO.CABLE_PIPELINE_LINE: submarine cables/pipelines ------------------
  cablesPipelinesLineLayers(add, source, settings);

  // -- PRIO.TSS_LINE: TSSBND -------------------------------------------------
  trafficRoutesLineLayers(add, source, settings);

  // -- PRIO.WATERWAY_LINE: MARCUL/FERYRT --------------------------------------
  waterwaysLineLayers(add, source, settings);

  // -- PRIO.SBDARE_LINE: SBDARE's Area/Line boundary -------------------------
  sbdareLineLayers(add, source, settings);

  // -- PRIO.STATION_LINE: RDOCAL's Line-geometry boundary --------------------
  stationsLineLayers(add, source, settings);

  // -- PRIO.CONTOUR: depth contours (DEPCNT02) -------------------------------
  // One layer, solid/dashed picked by a data-driven `line-dasharray` on the
  // `lowacc` fact — see docs/architecture/dasharray-data-driven.md (#stkqsrtl).
  // No labels: the reference emits none either.
  const safe = isSafetyContour(settings);
  const contourWidth = contourWidthFor(settings.palette);
  const contourPaint = {
    "line-color": ["case", safe, C.DEPSC, C.DEPCN] as DataDrivenPropertyValueSpecification<string>,
    "line-width": [
      "case",
      safe,
      contourWidth.safety,
      contourWidth.other,
    ] as DataDrivenPropertyValueSpecification<number>,
    "line-dasharray": [
      "case",
      lowacc,
      ["literal", [3, 1]],
      ["literal", [1, 0]],
    ] as DataDrivenPropertyValueSpecification<number[]>,
  };
  // DEPCNT02 moves the safety contour to DISPLAYBASE (SCAMIN may never hide
  // it, S52CondRules.cpp:1342); since that depends on the mariner's setting
  // it can't be a tile fact, so `safe` is passed as the SCAMIN exemption here.
  add(PRIO.CONTOUR, "DEPCNT", { id: `${source}-depcnt`, type: "line", paint: contourPaint }, safe);

  // -- PRIO.SOUNDING: soundings ---------------------------------------------
  // Text-only, exact parity with the reference (it has no digit sprites).
  add(PRIO.SOUNDING, "SOUNDG", {
    id: `${source}-soundg`,
    type: "symbol",
    filter: ["<=", ["abs", ["get", "DEPTH"]], 40000], // 99999 no-depth sentinel: omit
    layout: {
      "text-field": soundingText(["get", "DEPTH"]),
      "text-size": 12,
      "text-font": TEXT_FONT,
      "text-allow-overlap": true, // the reference never declutters soundings
      "text-ignore-placement": true,
      "text-padding": 0,
    },
    paint: {
      // Emphasis compares against safetyDepth (S-52 SNDFRM02), NOT
      // safetyContour; drying heights (negative DEPTH) are always shallower
      // than any safety depth → SNDG2.
      "text-color": [
        "case",
        [">=", ["get", "DEPTH"], settings.safetyDepth],
        C.SNDG1,
        C.SNDG2,
      ],
    },
  });

  // -- PRIO.COASTLINE: coastline (CATCOA/QUAPOS01 → QUALIN01) ---------------
  const coalneDashed: ExpressionSpecification = [
    "any",
    matchIn("CATCOA", [6, 7, 8, 10]),
    lowacc,
  ];
  add(PRIO.COASTLINE, "COALNE", {
    id: `${source}-coalne-glow`,
    type: "line",
    filter: ["all", ["!", coalneDashed], ["==", ["get", "CONRAD"], 1]],
    paint: { "line-color": C.CHMGF, "line-width": 3 },
  });
  add(PRIO.COASTLINE, "COALNE", {
    id: `${source}-coalne`,
    type: "line",
    paint: {
      "line-color": C.CSTLN,
      "line-width": 1,
      "line-dasharray": [
        "case",
        coalneDashed,
        ["literal", [3, 1]],
        ["literal", [1, 0]],
      ] as DataDrivenPropertyValueSpecification<number[]>,
    },
  });

  // -- PRIO.COASTLINE: shoreline constructions (SLCONS03) -------------------
  const constr = matchIn("CONDTN", [1, 2]); // under construction / ruined
  const wharf = matchIn("CATSLC", [6, 15, 16]); // wharf/quay: heavy stroke
  const wlDash = matchIn("WATLEV", [3, 4]); // covers/dries: dashed
  // encodes the CS branch precedence: lowacc > constr > wharf > watlev
  const slconsDashed: ExpressionSpecification = [
    "any",
    lowacc,
    constr,
    ["all", ["!", wharf], wlDash],
  ];
  // AP(CROSSX01) crosshatch deferred — faint CHBRN tint placeholder; the
  // boundary line carries the information.
  add(PRIO.COASTLINE, "SLCONS", {
    id: `${source}-slcons-fill`,
    type: "fill",
    filter: poly,
    paint: { "fill-color": C.CHBRN, "fill-opacity": 0.15 },
  });
  add(PRIO.COASTLINE, "SLCONS", {
    id: `${source}-slcons`,
    type: "line",
    paint: {
      // LC(LOWACC01)'s colour ref is DEPSC, unlike coastline's CSTLN LOWACC21.
      "line-color": [
        "case",
        slconsDashed,
        ["case", lowacc, C.DEPSC, C.CSTLN],
        C.CSTLN,
      ] as DataDrivenPropertyValueSpecification<string>,
      "line-width": [
        "case",
        slconsDashed,
        ["case", ["any", lowacc, constr], 1, 2],
        ["case", wharf, 4, 2],
      ] as DataDrivenPropertyValueSpecification<number>,
      "line-dasharray": [
        "case",
        slconsDashed,
        ["literal", [3, 1]],
        ["literal", [1, 0]],
      ] as DataDrivenPropertyValueSpecification<number[]>,
    },
  });

  // -- PRIO.LAND_LINE: construction points and land lines -------------------
  // SLCONS points: SY(MORFAC03) deferred → CHBLK circle.
  add(PRIO.LAND_LINE, "SLCONS", {
    id: `${source}-slcons-point`,
    type: "circle",
    filter: point,
    paint: { "circle-radius": 3, "circle-color": C.CHBLK },
  });
  // land as a line: QUALIN01 non-COALNE branch. `filter: line` is a
  // geometry-type split (LNDARE shares its source-layer with fill/point).
  add(PRIO.LAND_LINE, "LNDARE", {
    id: `${source}-lndare-line`,
    type: "line",
    filter: line,
    paint: {
      "line-color": C.CSTLN,
      "line-width": 1,
      "line-dasharray": [
        "case",
        lowacc,
        ["literal", [3, 1]],
        ["literal", [1, 0]],
      ] as DataDrivenPropertyValueSpecification<number[]>,
    },
  });

  // -- Phase 5 symbols and text: hoisted above every line/fill layer
  // (specs-12.md §3.0 — restricted syms → hazards → cable/pipeline markers →
  // topmarks → daymarks → buoys/beacons → lights topmost)
  seaareSymbolLayers(add, source, settings);
  aidsHazardsSymbolLayers(add, source, settings);
  bridgesSymbolLayers(add, source, settings);
  industrialSymbolLayers(add, source, settings);
  lndmrkSymbolLayers(add, source, settings);
  sbdareSymbolLayers(add, source, settings);
  stationsSymbolLayers(add, source, settings);
  cablesPipelinesSymbolLayers(add, source, settings);
  trafficRoutesSymbolLayers(add, source, settings);

  // -- Interior tap targets: one invisible fill per class whose areas are
  // drawn but not filled (boundary-only RESARE/MIPARE/…, symbol-only
  // TSSLPT/SEAARE/…), so a tap anywhere inside answers. Derived from the
  // layers just emitted, never a class list — see ./areaHit.ts. Unshifted to
  // the bottom of the stack (paints nothing; bottom-most means a query
  // returns the area's drawn layers first) and deliberately NOT in
  // an ENC group: its visibility is already the union of the layers it stands
  // in for, whichever groups those are in.
  const hitLayers: PrioritizedLayer[] = [];
  for (const [sourceLayer, drawn] of drawnBy) {
    const hit = areaHitFilter(sourceLayer, drawn, gateExpr);
    if (!hit) continue;
    hitLayers.push({
      prio: PRIO.NODATA,
      layer: {
        id: `${source}-${sourceLayer.toLowerCase()}${AREA_HIT_SUFFIX}`,
        type: "fill",
        source,
        "source-layer": sourceLayer,
        filter: setFilter ? ["all", hit, setFilter] : hit,
        // Constant 0, not folded into the SCAMIN fade: MapLibre skips the
        // draw call for a constant-zero fill, and still hit-tests it.
        paint: { "fill-opacity": 0 },
      } as LayerSpecification,
    });
  }
  layers.unshift(...hitLayers);

  if (opts.debug) {
    const styled = styledLayers();
    const rest = set.vector_layers.map((v) => v.id).filter((id) => !styled.has(id));
    layers.push(
      ...debugLayers(source, rest, settings.palette).map((layer) => ({ prio: PRIO.DEBUG, layer })),
    );
  }
  return layers;
}

/** The source-layers the generator styles — ground truth from an empty probe
 * set (`add()` is unconditional, so `styled` fires before `present` drops
 * anything). Pinned against the backend by `chartStyle.vectorLayers.test.ts`. */
export function styledSourceLayers(settings: ChartSettings = DEFAULT_SETTINGS): Set<string> {
  const styled = new Set<string>();
  const probe: ChartSet = {
    id: "_probe",
    name: "probe",
    bounds: [0, 0, 0, 0],
    min_zoom: 0,
    max_zoom: 16,
    sequence: 0,
    tiles: "",
    vector_layers: [],
  };
  chartSetLayers(probe, settings, { styled });
  return styled;
}

/** The reference's own depth-contour widths (RenderHelper.cpp's DEPCNT02) —
 * every theme without its own `contourWidth` draws exactly this, unchanged. */
const DEFAULT_CONTOUR_WIDTH = { safety: 2, other: 1 };

/** The theme's own `contourWidth` (falling back to the reference default), merged
 * with the theme editor's session-only `contourWidth` override the way
 * `rasterPaint`/`basemapTintPaint` merge theirs. */
function contourWidthFor(palette: Palette): { safety: number; other: number } {
  const base = THEME_BY_ID[palette]?.contourWidth ?? DEFAULT_CONTOUR_WIDTH;
  const patch = overrideField(palette, "contourWidth");
  return {
    safety: patch?.safety ?? base.safety,
    other: patch?.other ?? base.other,
  };
}

/** Paint for a raster layer under the current palette. Uses
 * brightness/saturation, not opacity — opacity would wash the raster into a
 * grey mush. Must NOT be called for the weather wash. See
 * docs/architecture/raster-dim-and-tint.md. */
export function rasterPaint(palette: Palette): { "raster-brightness-max"?: number; "raster-saturation"?: number } {
  const base = THEME_BY_ID[palette]?.rasterDim;
  const patch = overrideField(palette, "rasterDim");
  if (!base && !patch) return {};
  return {
    "raster-brightness-max": patch?.brightness ?? base?.brightness ?? 1,
    "raster-saturation": patch?.saturation ?? base?.saturation ?? 1,
  };
}

/** Paint for the OSM base layer / satellite overlay's colour tint — `{}` for
 * every theme with no `basemapTint`. Never call for the weather raster wash.
 * `contrast` is MapLibre's `raster-contrast`, clamped `[-1,1]`, NOT a CSS
 * `filter: contrast()` multiplier. See docs/architecture/raster-dim-and-tint.md. */
export function basemapTintPaint(
  palette: Palette,
): { "raster-hue-rotate"?: number; "raster-contrast"?: number } {
  const base = THEME_BY_ID[palette]?.basemapTint;
  const patch = overrideField(palette, "basemapTint");
  if (!base && !patch) return {};
  return {
    "raster-hue-rotate": patch?.hueRotate ?? base?.hueRotate ?? 0,
    "raster-contrast": patch?.contrast ?? base?.contrast ?? 0,
  };
}

/** The synthetic `ChartSet` for the `chart-all` union source (#snyzntrn), one
 * source/call for every subscribed o-charts set. See
 * docs/architecture/ocharts-union-tile.md. */
function ochartsUnionSet(ochartsSets: ChartSet[], union: "all" | "free" = "all"): ChartSet {
  const layers = new Map<string, VectorLayer>();
  for (const s of ochartsSets) {
    for (const vl of s.vector_layers) if (!layers.has(vl.id)) layers.set(vl.id, vl);
  }
  return {
    id: "all",
    name: "All o-charts sets",
    bounds: (catalogBounds(ochartsSets) as [number, number, number, number] | undefined) ?? [
      0, 0, 0, 0,
    ],
    min_zoom: Math.min(...ochartsSets.map((s) => s.min_zoom)),
    max_zoom: Math.max(...ochartsSets.map((s) => s.max_zoom)),
    sequence: 0,
    tiles: `/tiles/${union}/{z}/{x}/{y}`,
    vector_layers: [...layers.values()],
    kind: "ocharts",
  };
}

/** Register `set`'s vector source (`chart-<id>`), epoch-suffixed (see
 * `StyleOptions.chartEpoch`). Shared by the per-pmtiles-set path and the
 * `chart-all` union source, whose `set` is just synthetic ({@link ochartsUnionSet}). */
function addChartSource(
  style: StyleSpecification,
  set: ChartSet,
  bumpEpoch: boolean,
  chartEpoch: number | undefined,
): void {
  const epochSuffix = bumpEpoch ? `${set.tiles.includes("?") ? "&" : "?"}e=${chartEpoch}` : "";
  style.sources[`chart-${set.id}`] = {
    type: "vector",
    tiles: [tileUrl(`/api${set.tiles}${epochSuffix}`)],
    minzoom: set.min_zoom,
    maxzoom: set.max_zoom, // past this MapLibre overzooms the max_zoom tiles (default)
    bounds: set.bounds,
  };
}

/** The OSM basemap's layer ids, bottom to top — exported so callers don't
 * hand-copy the literals. See docs/architecture/osm-world-basemap.md. */
export const OSM_WORLD_LAYER_IDS = [
  "world-earth",
  "world-green",
  "world-boundaries",
  "world-roads-casing",
  "world-roads",
  "world-places",
] as const;

/** The complete map style: the vector OSM basemap + every chart set. See
 * docs/architecture/osm-world-basemap.md for how the basemap replaced the
 * old raster OSM layer. */
export function buildStyle(
  sets: ChartSet[],
  settings: ChartSettings,
  opts: StyleOptions = {},
): StyleSpecification {
  const C = paletteColors(settings.palette);
  const BC = basemapColors(settings.palette);
  const placeFont = themeFonts(settings.palette).upright ?? TEXT_FONT;
  const villagePlaceFont = themeFonts(settings.palette).italic ?? TEXT_FONT;
  // ThemeDef.placeLabelTiers — see docs/architecture/osm-world-basemap.md.
  const placeTiered = THEME_BY_ID[settings.palette]?.placeLabelTiers === true;
  const osmVisibility = settings.showOsmBase ? "visible" : "none";
  // The two optional basemap knobs (`BasemapColors.green`/`roadCasing`). Their
  // layers are ALWAYS emitted and only hidden when the theme lacks the field,
  // so a theme switch stays a paint/layout diff rather than an add/remove.
  const greenVisibility = settings.showOsmBase && BC.green ? "visible" : "none";
  const casedRoads = BC.roadCasing !== undefined;
  const casingVisibility = settings.showOsmBase && casedRoads ? "visible" : "none";
  // Road fill width by zoom, in three tiers keyed on Protomaps' coarse road
  // `kind` (highway/major_road/minor_road/path/…) — only for a cased theme;
  // an uncased one keeps the hairline. The casing is the same plus 1.5 px.
  const roadWidth = (extra: number): ExpressionSpecification => {
    const tier = (major: number, minor: number, other: number): ExpressionSpecification => [
      "match",
      ["get", "kind"],
      ["highway", "major_road"],
      major + extra,
      "minor_road",
      minor + extra,
      other + (extra > 0 ? extra / 2 : 0),
    ];
    return ["interpolate", ["exponential", 1.6], ["zoom"], 8, tier(0.8, 0.3, 0.2), 12, tier(2.5, 1, 0.4), 16, tier(10, 6, 1.5)];
  };
  const style: StyleSpecification = {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      // The OSM basemap (task suxmwpst, `mivnav.features.osm_world`) —
      // See docs/architecture/osm-world-basemap.md.
      "osm-world": {
        type: "vector",
        tiles: [tileUrl("/api/osm_world/tiles/all/{z}/{x}/{y}")],
        // Reflects whatever was actually BAKED (jt xqoyqxou); do NOT
        // re-hardcode a number here — see StyleOptions.osmWorldMinZoom.
        minzoom: opts.osmWorldMinZoom ?? FALLBACK_OSM_WORLD_MIN_ZOOM,
        maxzoom: opts.osmWorldMaxZoom ?? FALLBACK_OSM_WORLD_MAX_ZOOM,
        attribution: "&copy; OpenStreetMap contributors",
      },
    },
    layers: [
      // Not-loaded-yet is an absence of information, not a claim about the
      // world: CANVAS here (not NODTA) so a mariner never sees a meaningful
      // grey flash on every pan while tiles are in flight.
      { id: "background", type: "background", paint: { "background-color": C.CANVAS } },
      // Basemap bottom to top: earth, boundaries, roads, places (a fill
      // after labels would bury them). No `world-water` layer — see
      // BasemapColors' `land` docstring for why only land needs a fill here.
      {
        id: "world-earth",
        type: "fill",
        source: "osm-world",
        "source-layer": "earth",
        paint: { "fill-color": BC.land },
        layout: { visibility: osmVisibility },
      },
      // Parks/woods (`BasemapColors.green`). Protomaps puts the high-zoom
      // polygons in `landuse` and a coarse low-zoom forest cover in
      // `landcover`; this reads `landuse` only, which is what carries the
      // town-scale green the coastal view needs. No `nature_reserve`: marine
      // reserves (Kullaberg, Skälderviken) extend far offshore and, with no
      // water layer above, painted the sea green; on land they're also
      // tagged forest/wood/meadow, so nothing is lost.
      {
        id: "world-green",
        type: "fill",
        source: "osm-world",
        "source-layer": "landuse",
        filter: [
          "in",
          ["get", "kind"],
          [
            "literal",
            [
              "park",
              "forest",
              "wood",
              "grass",
              "garden",
              "golf_course",
              "recreation_ground",
              "cemetery",
              "meadow",
              "village_green",
              "playground",
            ],
          ],
        ],
        paint: { "fill-color": BC.green ?? BC.land },
        layout: { visibility: greenVisibility },
      },
      {
        id: "world-boundaries",
        type: "line",
        source: "osm-world",
        "source-layer": "boundaries",
        // Deliberately understated, undifferentiated by admin level — a
        // marine chart plotter has no use for a busy administrative map.
        paint: {
          "line-color": BC.boundary,
          "line-width": 0.75,
          "line-dasharray": [2, 2],
        },
        layout: { visibility: osmVisibility },
      },
      {
        id: "world-roads-casing",
        type: "line",
        source: "osm-world",
        "source-layer": "roads",
        paint: {
          "line-color": BC.roadCasing ?? BC.roadMinor,
          "line-width": roadWidth(1.5),
        },
        layout: { visibility: casingVisibility, "line-cap": "round", "line-join": "round" },
      },
      {
        id: "world-roads",
        type: "line",
        source: "osm-world",
        "source-layer": "roads",
        paint: {
          // Two tiers only, keyed on Protomaps' `kind_detail` road-class vocabulary.
          "line-color": [
            "match",
            ["get", "kind_detail"],
            ["motorway", "trunk", "primary"],
            BC.roadMajor,
            BC.roadMinor,
          ],
          "line-width": casedRoads ? roadWidth(0) : 0.75,
        },
        layout: casedRoads
          ? { visibility: osmVisibility, "line-cap": "round", "line-join": "round" }
          : { visibility: osmVisibility },
      },
      {
        id: "world-places",
        type: "symbol",
        source: "osm-world",
        "source-layer": "places",
        filter: ["has", "name"], // no name tag: nothing worth labelling
        layout: {
          "text-field": ["get", "name"],
          // ThemeDef.placeLabelTiers — see docs/architecture/osm-world-basemap.md.
          "text-font": placeTiered
            ? ["match", ["get", "kind_detail"], "village", ["literal", villagePlaceFont], ["literal", placeFont]]
            : placeFont,
          "text-transform": placeTiered
            ? ["match", ["get", "kind_detail"], "city", "uppercase", "town", "uppercase", "none"]
            : "none",
          // town's "small caps": uppercase at reduced size (MapLibre has no
          // per-letter cap-height swap).
          "text-size": placeTiered
            ? ["match", ["get", "kind_detail"], "city", 13, "town", 10, "village", 10, 11]
            : 11,
          "text-letter-spacing": placeTiered
            ? ["match", ["get", "kind_detail"], "city", 0.06, "town", 0.05, 0]
            : 0,
          // Lower min_zoom (bigger settlement) sorts first, same declutter
          // convention as features/poi/overlay.ts.
          "symbol-sort-key": ["get", "min_zoom"],
          visibility: osmVisibility,
        },
        paint: {
          "text-color": BC.place,
          ...haloPaint(settings.palette, BC.placeHalo),
        },
      },
    ],
  };
  const chart: PrioritizedLayer[] = [];
  // Only the ENC vector sources fold in the epoch — never the osm-world
  // basemap or the openseamap raster, whose tiles are not affected by o-charts serving
  // config.
  const bumpEpoch = opts.chartEpoch !== undefined && opts.chartEpoch > 0;
  // `"ocharts"`-kind sets fold into ONE `chart-all` source/layer-set
  // (#snyzntrn) instead of one per set; disabling filters its layers by the
  // tile's `set` tag rather than omitting the set. See
  // docs/architecture/chart-style-options.md.
  const disabledSets = opts.disabledSets ?? [];
  let unionAdded = false;
  for (const set of sets) {
    if (set.kind === "ocharts") {
      if (unionAdded) continue; // already folded every ocharts set in below
      unionAdded = true;
      const ochartsSets = sets.filter((s) => s.kind === "ocharts");
      // Skip entirely if every subscribed set is disabled — see
      // docs/architecture/chart-style-options.md (tiles cost Pi CPU, not bandwidth).
      if (ochartsSets.every((s) => disabledSets.includes(s.id))) continue;
      const unionSet = ochartsUnionSet(ochartsSets, opts.ochartsUnion);
      addChartSource(style, unionSet, bumpEpoch, opts.chartEpoch);
      chart.push(...chartSetLayers(unionSet, settings, opts));
      continue;
    }
    addChartSource(style, set, bumpEpoch, opts.chartEpoch);
    chart.push(...chartSetLayers(set, settings, opts));
  }
  // Sorted TOGETHER across sets (stable sort, load-bearingly so) — see
  // docs/architecture/layer-sort-and-weather-order.md.
  chart.sort((a, b) => a.prio - b.prio);
  style.layers.push(...chart.map((p) => p.layer));
  // The weather overlay is NOT added here — see
  // docs/architecture/layer-sort-and-weather-order.md.
  // OpenSeaMap seamark overlay, topmost. Source always declared; toggle is a
  // layout visibility change (no tile fetch, single setLayoutProperty diff).
  style.sources.openseamap = {
    type: "raster",
    tiles: ["https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"],
    tileSize: 256,
    maxzoom: 18,
    attribution: "&copy; <a href='https://www.openseamap.org/'>OpenSeaMap</a> contributors",
  };
  style.layers.push({
    id: "openseamap",
    type: "raster",
    source: "openseamap",
    layout: { visibility: settings.showOpenSeaMap ? "visible" : "none" },
    // Same dimming as satellite: seamark symbols drawn for a day chart would
    // otherwise be the brightest marks on a near-black night screen.
    paint: rasterPaint(settings.palette),
  });
  // `ThemeFonts.all`: one lettering for every text layer, applied last so it
  // wins over each layer's own role-based choice (and over the shorthand
  // layers that otherwise always keep TEXT_FONT). A post-pass rather than a
  // change at ~30 call sites, and it cannot miss a layer added later.
  const allFont = themeFonts(settings.palette).all;
  if (allFont) {
    for (const layer of style.layers) {
      if (layer.type === "symbol" && layer.layout?.["text-font"] !== undefined) {
        layer.layout["text-font"] = allFont;
      }
    }
  }
  return style;
}
