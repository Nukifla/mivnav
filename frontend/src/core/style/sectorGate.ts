// Contract between the generated style and the sector-arc custom layer
// (../../features/sector-lights/overlay.ts): the marker layer carries the
// SCAMIN filter; the overlay reads it back via querySourceFeatures so arcs
// and symbols never disagree about which lights exist.
// See docs/architecture/sector-lights-gate.md.

import type { ExpressionSpecification, FilterSpecification, StyleSpecification } from "maplibre-gl";
import type { ScaminBias } from "./expr";
import { effectiveScamin, RENDER_SCALE_DENOM_Z0, toScaminBias } from "./expr";

/** Id suffix of a chart set's sector-arc marker layer (`chart-<set>` + this). */
export const SECTOR_GATE_SUFFIX = "-lights-sector";

/** MVT source-layer the marker layer — and so the arc query — binds to. */
export const SECTOR_GATE_SOURCE_LAYER = "LIGHTS";

// S-52 draws sector arcs at a flat 75.59px; task tpkonpry instead derives a
// constant-screen-size radius per light from VALNMR (log-scaled). See
// docs/architecture/sector-lights-gate.md.
/** Domain clamp (nm), matching chartcore's own VALNMR clamp for the scamin
 * range gate (`derive/lights.rs::gate_by_range`). */
export const RANGE_MIN_NM = 4;
export const RANGE_MAX_NM = 30;
const RANGE_LOG_SPAN = Math.log(RANGE_MAX_NM / RANGE_MIN_NM);
/** Screen radius (px) at RANGE_MIN_NM / RANGE_MAX_NM, chosen so the old flat
 * `ARC_RADIUS_REF` falls near the middle of the span. */
export const RADIUS_MIN = 50;
export const RADIUS_MAX = 115;
/** The reference's flat arc radius (S52CondRules.cpp:1122) — fallback when a
 * feature carries no usable `lit_range`. */
export const ARC_RADIUS_REF = 75.59;

/**
 * Screen-px arc radius for a light's nominal range (raw VALNMR, nm — off the
 * arc feature's `lit_range` tile attribute). Log-scaled and clamped to
 * `[RANGE_MIN_NM, RANGE_MAX_NM]`; falls back to `ARC_RADIUS_REF` when
 * `valnmr` is absent or not a finite number.
 */
export function radiusForRange(valnmr: unknown): number {
  if (typeof valnmr !== "number" || !Number.isFinite(valnmr)) return ARC_RADIUS_REF;
  const v = Math.min(RANGE_MAX_NM, Math.max(RANGE_MIN_NM, valnmr));
  const t = Math.log(v / RANGE_MIN_NM) / RANGE_LOG_SPAN;
  return RADIUS_MIN + (RADIUS_MAX - RADIUS_MIN) * t;
}

// The fade's zero must land on the INTEGER zoom where the tile/filter
// actually drop the feature, or it pops mid-fade. See
// docs/architecture/sector-lights-gate.md.
const FADE_BAND_ZOOMS = 0.5;

// Sample grid for the JSON fade; spacing must match FADE_BAND_ZOOMS so a stop
// lands on each corner and `interpolate` reproduces the snapped curve exactly.
const FADE_Z_MIN = 4;
const FADE_Z_MAX = 19;
const FADE_Z_STEP = FADE_BAND_ZOOMS;

/**
 * Opacity of a constant-screen-size annotation at a *fractional* map zoom, for
 * a feature whose minimum-display scale is `scamin`, under chart-detail bias
 * `chartDetail`. Snapped to the integer zoom `Zc` where the tile/filter drop
 * the feature: 0 at/below `Zc`, 1 at/above `Zc + FADE_BAND_ZOOMS`, linear
 * between. No/invalid `scamin` never fades (opacity 1).
 *
 * Read every frame by the custom arc layer, including the non-sectored
 * VALNMR range ring, so the two annotations' fades can't drift apart.
 * {@link fadeOpacityExpr} is the paint-expression form of the same curve.
 */
export function fadeOpacity(
  zoom: number,
  scamin: number,
  chartDetail: ScaminBias | number = 1,
): number {
  if (!Number.isFinite(scamin) || scamin <= 0) return 1;
  const u =
    Math.log2(effectiveScamin(scamin, toScaminBias(chartDetail))) -
    Math.log2(RENDER_SCALE_DENOM_Z0);
  return Math.max(0, Math.min(1, (zoom + Math.floor(u)) / FADE_BAND_ZOOMS));
}

/**
 * The uniform scamin fade as a MapLibre paint expression, for a JSON layer
 * that can't use the custom layer's per-frame callback ({@link fadeOpacity}).
 * No current caller; kept as `scaminFadeOpacity`'s no-base/no-exempt case.
 */
export function fadeOpacityExpr(chartDetail: ScaminBias | number = 1): ExpressionSpecification {
  return scaminFadeOpacity(chartDetail);
}

/**
 * The uniform scamin fade, with a per-feature `base` opacity folded in and an
 * optional SCAMIN `exempt` predicate. `base` must be folded INTO each zoom
 * stop's output rather than multiplied around the whole curve — MapLibre only
 * allows `["zoom"]` as the direct input of a top-level interpolate/step.
 */
export function scaminFadeOpacity(
  chartDetail: ScaminBias | number = 1,
  base?: ExpressionSpecification | number,
  exempt?: ExpressionSpecification,
): ExpressionSpecification {
  const { detail, spread, anchor } = toScaminBias(chartDetail);
  // Charted `scamin` wins; DEPCNT/line-DEPARE fall back to the synthetic
  // `native_scamin`; anything else reads a huge default and never fades.
  const scamin: ExpressionSpecification = [
    "number",
    ["get", "scamin"],
    ["get", "native_scamin"],
    1e12,
  ];
  const log2Scamin: ExpressionSpecification =
    spread === 1
      ? ["log2", scamin]
      : [
          "+",
          Math.log2(anchor),
          ["*", spread, ["-", ["log2", scamin], Math.log2(anchor)]],
        ];
  const bias = Math.log2(detail) - Math.log2(RENDER_SCALE_DENOM_Z0);
  // -Zc, the integer zoom the tile/filter drop the feature at.
  const negZc: ExpressionSpecification = ["floor", ["+", bias, log2Scamin]];
  const fadeAt = (z: number): ExpressionSpecification => [
    "max",
    0,
    ["min", 1, ["*", 1 / FADE_BAND_ZOOMS, ["+", z, negZc]]],
  ];
  const faded = (z: number): ExpressionSpecification =>
    base === undefined ? fadeAt(z) : ["*", base, fadeAt(z)];
  const stopOutput = (z: number): ExpressionSpecification =>
    exempt === undefined ? faded(z) : ["case", exempt, base ?? 1, faded(z)];
  const stops: (number | ExpressionSpecification)[] = [];
  const steps = Math.round((FADE_Z_MAX - FADE_Z_MIN) / FADE_Z_STEP);
  for (let i = 0; i <= steps; i++) {
    const z = FADE_Z_MIN + i * FADE_Z_STEP;
    stops.push(z, stopOutput(z));
  }
  return ["interpolate", ["linear"], ["zoom"], ...stops] as ExpressionSpecification;
}

// SECTR1/SECTR2 are bearings *from seaward*; S-52 draws the arc *toward* the
// sector, so each is flipped by 180 and swept clockwise from sectr1 to
// sectr2. Shared with ../info/chartProvider.ts's `lightSegments`.

/** One LIGHTS object's drawn sector, in compass degrees after the
 * seaward-to-toward flip and 0/360 wrap: `a2 > a1` (possibly `a2 > 360` for a
 * sector that wraps through north). `hasSector` is `false` — `a1=0, a2=360`,
 * the degenerate full circle — for a light with no charted SECTR1/SECTR2. */
export interface SectorAngles {
  a1: number;
  a2: number;
  hasSector: boolean;
}

/**
 * Does this LIGHTS feature draw its own S-52 icon (aidsHazards.ts
 * `-lights-sym`) rather than the sector-lights overlay? `sym` and a real
 * charted sector are mutually exclusive at ingest, so this one check tells
 * the two populations apart.
 */
export function lightHasOwnSymbol(props: Record<string, unknown>): boolean {
  return typeof props.sym === "string" && props.sym.length > 0;
}

/**
 * Is the lights overlay (sector arcs + the non-sectored VALNMR range ring)
 * drawn at all, and how far dimmed?
 *
 * The overlay reads lights via querySourceFeatures and never looks at the
 * "Aids & lights" ENC group's own visibility/opacity, so those are checked
 * explicitly here (bug wxpkzqqq: an off group used to leave arcs drawing over
 * an otherwise-empty chart).
 */
export function lightsOverlayVisible(settings: {
  showLights: boolean;
  encGroups: { aids: { visible: boolean; opacity: number } };
}): boolean {
  return (
    settings.showLights && settings.encGroups.aids.visible && lightsOverlayOpacity(settings) > 0
  );
}

/** The "Aids & lights" group's opacity, as a plain multiplier the overlay
 * applies to its own per-light scamin fade. 1 (or a group state that predates
 * the field) leaves the annotation exactly as it drew before. */
export function lightsOverlayOpacity(settings: {
  encGroups: { aids: { opacity: number } };
}): number {
  const o = settings.encGroups.aids.opacity;
  return typeof o === "number" && o >= 0 && o <= 1 ? o : 1;
}

/**
 * Where the lights overlay's custom layer belongs in the live stack: the
 * `beforeId` that seats it above the "Aids & lights" group's own layers, so
 * the arcs/rings move with the group when the Layers panel reorders it.
 *
 * USER DECISION 2026-07-29 (overriding bug wxpkzqqq): the overlay follows the
 * group's stack position rather than a fixed "always above weather" rule —
 * the wash already covers what the arcs annotate, and a fixed rule can't
 * survive a forecast-hour wash re-add (bypasses setStyle, no re-seat).
 */
export function sectorOverlayBeforeId(
  styleLayerIds: readonly string[],
  aidsLayerIds: readonly string[],
  excludeIds: readonly string[],
): string | undefined {
  const aids = new Set(aidsLayerIds);
  const owned = new Set(excludeIds);
  let last = -1;
  for (let i = 0; i < styleLayerIds.length; i++) if (aids.has(styleLayerIds[i]!)) last = i;
  if (last < 0) return undefined;
  for (let i = last + 1; i < styleLayerIds.length; i++) {
    const id = styleLayerIds[i]!;
    if (!owned.has(id)) return id;
  }
  return undefined;
}

/** SECTR1/SECTR2 (raw tile properties) -> the sector they draw. See
 * `SectorAngles`. */
export function sectorAngles(props: Record<string, unknown>): SectorAngles {
  const s1 = props.SECTR1;
  const s2 = props.SECTR2;
  if (typeof s1 !== "number" || typeof s2 !== "number") {
    return { a1: 0, a2: 360, hasSector: false };
  }
  const b2 = s2 <= s1 ? s2 + 360 : s2;
  const a1 = s1 > 180 ? s1 - 180 : s1 + 180;
  let a2 = b2 > 180 ? b2 - 180 : b2 + 180;
  if (a2 <= a1) a2 += 360;
  return { a1, a2, hasSector: true };
}

/** One `querySourceFeatures` call: a chart source and the filter its marker
 * layer resolved for sectored lights. */
export interface SectorQuery {
  source: string;
  sourceLayer: string;
  filter: FilterSpecification;
}

/**
 * The sector-arc queries a built style asks for — one per chart set whose
 * tiles carry lights (`add` drops the marker layer for a set without a
 * LIGHTS source-layer, so a set with no lights is never walked).
 */
export function sectorQueries(style: StyleSpecification): SectorQuery[] {
  const out: SectorQuery[] = [];
  for (const layer of style.layers) {
    if (!layer.id.endsWith(SECTOR_GATE_SUFFIX)) continue;
    if (!("source" in layer) || !layer.source) continue;
    const filter = "filter" in layer ? layer.filter : undefined;
    // A marker layer without a filter is a generator bug; drawing every
    // sectored light in the tiles is the failure this exists to prevent.
    if (!filter) continue;
    out.push({
      source: layer.source,
      sourceLayer: ("source-layer" in layer && layer["source-layer"]) || SECTOR_GATE_SOURCE_LAYER,
      filter,
    });
  }
  return out;
}
