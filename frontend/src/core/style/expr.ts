// Shared building blocks of the style generator: add-layer plumbing type and
// settings-independent expressions used by several per-class modules
// (chartStyle.ts, aidsHazards.ts).

import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";

/** A style layer without its source wiring — the per-chart-set generator
 * fills in source/source-layer. Omit must distribute over the
 * LayerSpecification union, or the type collapses to the properties common
 * to all layer kinds (losing filter, layout variants, …). */
export type ChartLayer = LayerSpecification extends infer L
  ? L extends LayerSpecification
    ? Omit<L, "source" | "source-layer">
    : never
  : never;

/**
 * S-52 draw-order bands, bottom to top (chartStyle.ts `buildStyle` sorts on
 * these). Values are ORDINALS, not S-52 DPRI numbers — symbols are hoisted
 * above all lines/fills regardless of DPRI. See
 * docs/architecture/style-draw-order-bands.md.
 */
export const PRIO = {
  NODATA: 0,
  GROUP1: 1,
  /** SY(LNDARE01) */
  LAND_POINT: 2,
  HAZARD_FILL: 3,
  TSS_FILL: 4,
  INDUSTRIAL_FILL: 5,
  LNDMRK_FILL: 6,
  RESTRICTED_BOUNDARY: 7,
  INDUSTRIAL_BOUNDARY: 8,
  LNDMRK_BOUNDARY: 9,
  HAZARD_LINE: 10,
  CABLE_PIPELINE_LINE: 11,
  TSS_LINE: 12,
  WATERWAY_LINE: 13,
  SBDARE_LINE: 14,
  STATION_LINE: 15,
  CONTOUR: 16,
  SOUNDING: 17,
  COASTLINE: 18,
  LAND_LINE: 19,
  SYM_SEAARE: 20,
  SYM_RESTRICTED: 21,
  SYM_INDUSTRIAL: 22,
  SYM_LNDMRK: 23,
  SYM_SBDARE: 24,
  SYM_HAZARD: 25,
  SYM_CABLE_PIPELINE: 26,
  SYM_STATIONS: 27,
  SYM_TOPMAR: 28,
  SYM_DAYMAR: 29,
  SYM_ATON: 30,
  /** Topmost charted content. */
  SYM_LIGHTS: 31,
  /** Not chart rendering — the debug view for unstyled MVT layers, above
   * everything so it's visible over whatever it's diagnosing. */
  DEBUG: 32,
} as const;

export type Prio = (typeof PRIO)[keyof typeof PRIO];

/** A style layer tagged with the draw-order band it belongs to. `buildStyle`
 * sorts on `prio`; nothing else may depend on emission order. */
export interface PrioritizedLayer {
  prio: Prio;
  layer: LayerSpecification;
}

/** Emit `layer` in draw-order band `prio`, bound to MVT source-layer
 * `sourceLayer`. The generator ANDs the SCAMIN gate (`scaminVisible`) into
 * every layer's filter; `scaminExempt` is an extra bypass condition — for
 * S-52 conditional procedures promoting a feature to DISPLAYBASE per *user
 * setting*, which tiles can't bake. */
export type AddLayer = (
  prio: Prio,
  sourceLayer: string,
  layer: ChartLayer,
  scaminExempt?: ExpressionSpecification,
) => void;

/** Must name a self-hosted fontstack under `public/fonts/` (GLYPHS_URL in
 * chartStyle.ts) — the boat runs offline, so committed PBFs are required.
 * `Noto Sans Medium` (OFL) is the closest prebuilt weight to the outgoing
 * `Open Sans Semibold`. */
export const TEXT_FONT = ["Noto Sans Medium"];

/** Alpha of the chart's land-area fills when `showOsmOnLand` is on. Lives
 * here (not in chartStyle.ts) so the land-area modules chartStyle imports —
 * lndmrk.ts, industrial.ts — can share it without an import cycle; the full
 * safety argument for the number is on chartStyle.ts's re-export. */
export const LAND_WASH_OPACITY = 0.35;

/** The lighter wash for the "special structure" land-area fills —
 * LNDMRK's and SILTNK/PRDARE's `AC(CHBRN)` — under `showOsmOnLand`. Lighter
 * than LAND_WASH_OPACITY because they sit ON land that is already washed:
 * at 0.35 a cemetery or harbour yard still read as a dominant brown block
 * over the basemap's own green (user: "let these special structures be a
 * bit more see-through"). Their boundary stays opaque, so the chart still
 * draws the extent; the fill only has to say "something is here". */
export const LAND_FEATURE_WASH_OPACITY = 0.15;

export const poly: ExpressionSpecification = ["==", ["geometry-type"], "Polygon"];
export const line: ExpressionSpecification = ["==", ["geometry-type"], "LineString"];
export const point: ExpressionSpecification = ["==", ["geometry-type"], "Point"];

/** Whole-feature low positional accuracy: derived `quapos` in [2, 10)
 * (QUALIN01/QUAPNT01 — absence means accurate). */
export const lowacc: ExpressionSpecification = [
  "all",
  ["has", "quapos"],
  [">=", ["get", "quapos"], 2],
  ["<", ["get", "quapos"], 10],
];

/** Map scale denominator at zoom z for a **256 px** tile — the OSM/OGC
 * convention chartcore's *cell* zoom assignment uses. NOT the scale
 * anything is drawn at; see {@link RENDER_SCALE_DENOM_Z0} and
 * docs/architecture/scamin-render-gate.md. */
export const SCALE_DENOM_Z0 = 559_082_264;

/** Half {@link SCALE_DENOM_Z0} — MapLibre renders 512px tiles, not 256px
 * (#kyxkoonq). Mirrors chartcore's own constant bit-for-bit. */
export const RENDER_SCALE_DENOM_Z0 = SCALE_DENOM_Z0 / 2;

/**
 * S-52 SCAMIN (S57Object.cpp:659), biased by boat-wide `B` — same rule
 * backend's `drop_scamin_hidden` hard-drops by, needed here only for the
 * overzoom case the server can't cover. See docs/architecture/scamin-render-gate.md.
 */
export function scaminVisible(chartDetail: ScaminBias | number = 1): ExpressionSpecification {
  return [
    "any",
    ["!", ["has", "scamin"]],
    ["<=", ["/", RENDER_SCALE_DENOM_Z0, ["^", 2, ["zoom"]]], scaminLimit(chartDetail)],
  ];
}

/**
 * The boat-wide SCAMIN bias, in the two independent parts the backend keeps it
 * in (`ocharts.chart_detail` / `chart_detail_spread` / `chart_detail_anchor`).
 * Mirrors chartcore's `mvt::ScaminBias` — see {@link effectiveScamin}.
 */
export interface ScaminBias {
  /** `B`: uniform multiplier on every gate. A pure OFFSET in turn-on zoom. */
  detail: number;
  /** `k`: power-law exponent about `anchor`. Changes the turn-on SPACING. */
  spread: number;
  /** `A`: the scale the spread pivots about; inert at `spread === 1`. */
  anchor: number;
}

/** Default anchor `A`: 1:350 000, the coarse end of the IHO Coastal band.
 * Mirrors chartcore's `DEFAULT_SCAMIN_ANCHOR` / the backend's
 * `DEFAULT_CHART_DETAIL_ANCHOR`. */
export const DEFAULT_SCAMIN_ANCHOR = 350_000;

/** The neutral bias: today's behaviour, and a no-op on every gate. */
export const NEUTRAL_SCAMIN_BIAS: ScaminBias = {
  detail: 1,
  spread: 1,
  anchor: DEFAULT_SCAMIN_ANCHOR,
};

/** Accept either the full bias or a bare `chartDetail` number (`B` alone),
 * so call sites that only ever cared about `B` didn't have to change. */
export function toScaminBias(bias: ScaminBias | number = 1): ScaminBias {
  return typeof bias === "number" ? { ...NEUTRAL_SCAMIN_BIAS, detail: bias } : bias;
}

/** `A·(scamin/A)^k·B`. Mirrors chartcore's `ScaminBias::effective`
 * bit-for-bit — drift reopens server/client seam #kyxkoonq. See
 * docs/architecture/scamin-render-gate.md and #qqlzrkkn. */
export function effectiveScamin(scamin: number, bias: ScaminBias): number {
  if (bias.spread === 1) return scamin * bias.detail;
  return bias.anchor * Math.pow(scamin / bias.anchor, bias.spread) * bias.detail;
}

/** {@link effectiveScamin} as an expression over `["get","scamin"]` — the
 * limit half of {@link scaminVisible}. The neutral bias emits the bare
 * `["get","scamin"]`, so the default style stays byte-identical to before
 * either knob existed. */
export function scaminLimit(bias: ScaminBias | number = 1): ExpressionSpecification {
  const { detail, spread, anchor } = toScaminBias(bias);
  const warped: ExpressionSpecification =
    spread === 1 ? ["get", "scamin"] : ["*", anchor, ["^", ["/", ["get", "scamin"], anchor], spread]];
  return detail === 1 ? warped : ["*", warped, detail];
}

/** `attr` present and in `codes` (the has-guard keeps `match` from
 * evaluation errors on absent attributes). */
export function matchIn(attr: string, codes: number[]): ExpressionSpecification {
  return ["all", ["has", attr], ["match", ["get", attr], codes, true, false]];
}

/** Unicode subscript digits U+2080-U+2089, indexed by value. Verified present
 * in the committed offline glyph range `public/fonts/Noto Sans Medium/
 * 8192-8447.pbf` — no new font asset needed. */
const SUBSCRIPT_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"] as const;

/** `fract` (a 0-9 expression) → its Unicode subscript-digit string, via
 * `match` — the expression language has no digit-to-codepoint arithmetic. */
function subscriptDigit(fract: ExpressionSpecification): ExpressionSpecification {
  const cases = SUBSCRIPT_DIGITS.flatMap((s, i) => [i, s]);
  return ["match", fract, ...cases, ""] as unknown as ExpressionSpecification;
}

/**
 * Metric sounding text: metres plus one decimetre digit below 31 m, nonzero
 * only (RenderHelper.cpp:32-56 threshold). `v10 = round(v*10)` avoids the
 * reference's float-truncation bug (5.96 must render 6, not 5.9). Subscript
 * digit, not a font-size drop — `text-field` has no per-character size.
 */
export function soundingText(depth: ExpressionSpecification): ExpressionSpecification {
  const v: ExpressionSpecification = ["abs", depth]; // drying heights → magnitude
  const v10: ExpressionSpecification = ["round", ["*", v, 10]];
  const int_: ExpressionSpecification = ["floor", ["/", v10, 10]];
  const fract: ExpressionSpecification = ["%", v10, 10];
  const showFract: ExpressionSpecification = ["all", ["<", v, 31], ["!=", fract, 0]];
  const withFract: ExpressionSpecification = [
    "concat",
    ["to-string", int_],
    subscriptDigit(fract),
  ];
  return ["case", showFract, withFract, ["to-string", int_]];
}
