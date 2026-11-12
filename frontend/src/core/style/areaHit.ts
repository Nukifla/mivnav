// Interior tap targets for drawn chart AREAS (user: "if a area is drawn then
// clicking anywhere in that area should show it in the list, maybe not first
// but it should be there").
//
// `queryRenderedFeatures` answers per style layer, so an area the style draws
// only as a boundary line (RESARE, MIPARE, …) or only as a centred symbol on
// its derived label point (TSSLPT, SEAARE, …) answered a tap on that line or
// symbol and nowhere else — its interior paints nothing, so there was nothing
// to hit. The tile DOES carry the polygon (measured on the DK set); only the
// style had no layer over its inside.
//
// The fix is one invisible `fill` per such class (`fill-opacity: 0` — MapLibre
// hit-tests geometry, not alpha, and skips the draw call for a constant 0;
// `visibility: "none"` would drop it from queries). It is DERIVED from the
// layers the generator emitted for the class, not from a hand-kept class
// list, so a new outline-only class gets its interior for free and a hidden /
// SCAMIN-gated / undrawn area stays un-hittable:
//
//   hit(polygon) = any over the class's VISIBLE layers of
//                  "would this layer draw this polygon, or its label point?"
//
// See docs/architecture/chart-info-provider.md ("Area interiors").

import type { ExpressionSpecification as Expr } from "maplibre-gl";
import { poly } from "./expr";

/** Style-layer id suffix of an area's invisible interior tap target. The info
 * provider (../info/chartProvider.ts) reads it to tell "tapped inside" from
 * "tapped the boundary / symbol" — the two rank differently. */
export const AREA_HIT_SUFFIX = "-area-hit";

/** Is this style layer an area's invisible interior tap target? */
export function isAreaHitLayerId(layerId: string | undefined): boolean {
  return layerId !== undefined && layerId.endsWith(AREA_HIT_SUFFIX);
}

/**
 * Classes whose AREA features get a derived label point from chartcore
 * (`mvt/mod.rs` `wants_label_point`) — the Point their centred symbol / name
 * draws on. For these a `Point`-filtered symbol layer IS a drawing of the
 * polygon, so it counts toward "is this area drawn". Mirror of the Rust
 * match, pinned class-for-class by areaHit.test.ts; the per-class condition
 * (has `sym`, has `txt`, …) is NOT mirrored — it falls out of the symbol
 * layers' own filters, which read the same attributes off the polygon.
 */
export const AREA_LABEL_POINT_CLASSES: ReadonlySet<string> = new Set([
  "WRECKS", "OBSTRN",
  "RESARE", "ACHARE", "CTNARE", "MIPARE", "DMPGRD", "CBLARE", "PIPARE", "TSSCRS",
  "TSSRON", "TSSLPT", "ISTZNE", "PRCARE", "FAIRWY", "MARCUL", "CTSARE", "FERYRT",
  "PRDARE", "PILBOP",
  "SBDARE",
  "LNDMRK",
  "SEAARE",
]);

/**
 * Source-layers that can never carry a polygon, so deriving a tap target for
 * them would only add a layer that matches nothing: the S-57 object catalogue
 * allows these classes Point or Line primitives only, and `DEPCNT`/`ATON` are
 * chartcore's own line-only / point-only routing layers (`mvt/mod.rs`
 * `layer_name`). Purely a pruning list, and safe in the direction that
 * matters: a class MISSING here costs one empty style layer, never a dead
 * interior. Only add a class whose areas cannot exist. (Checked against the
 * real DK + DE sets, 105 tiles z8–z14: none of these had a Polygon feature.)
 */
export const NEVER_AREA_SOURCE_LAYERS: ReadonlySet<string> = new Set([
  "DEPCNT", "ATON",
  "SOUNDG", "COALNE", "UWTROC", "TOPMAR", "DAYMAR", "LIGHTS", "LITVES", "LITFLT",
]);

/** One emitted style layer, as far as "does it draw a polygon?" needs it. */
export interface DrawnLayer {
  type: string;
  /** The layer's OWN filter — before the SCAMIN gate / set filter are ANDed in. */
  filter?: Expr;
  /** `layout.visibility` after the ENC-group fold: a hidden layer draws (and
   * queries) nothing, so it cannot make an area "drawn". */
  visible: boolean;
  /** The layer's SCAMIN exemption, when it has one (see `AddLayer`). */
  scaminExempt?: Expr;
}

/** A filter with its geometry-type terms resolved: always / never / depends
 * on the feature's attributes. */
export type Folded = boolean | Expr;

const UNKNOWN = Symbol("geometry-type in an unsupported position");

function isGeometryType(e: unknown): boolean {
  return Array.isArray(e) && e.length === 1 && e[0] === "geometry-type";
}

function mentionsGeometryType(e: unknown): boolean {
  return Array.isArray(e) && (isGeometryType(e) || e.some(mentionsGeometryType));
}

function foldInner(expr: unknown, geometry: string): Folded {
  if (typeof expr === "boolean") return expr;
  if (!Array.isArray(expr)) return expr as Expr;
  const op = expr[0];
  if ((op === "==" || op === "!=") && expr.length === 3) {
    const [, a, b] = expr;
    const other = isGeometryType(a) ? b : isGeometryType(b) ? a : undefined;
    if (other !== undefined && typeof other === "string") {
      return (other === geometry) === (op === "==");
    }
  }
  if (op === "all" || op === "any") {
    const absorbing = op === "any";
    const rest: Expr[] = [];
    for (const child of expr.slice(1)) {
      const f = foldInner(child, geometry);
      if (f === absorbing) return absorbing;
      if (typeof f !== "boolean") rest.push(f);
    }
    if (rest.length === 0) return !absorbing;
    return rest.length === 1 ? rest[0] : ([op, ...rest] as Expr);
  }
  if (op === "!" && expr.length === 2) {
    const f = foldInner(expr[1], geometry);
    return typeof f === "boolean" ? !f : (["!", f] as Expr);
  }
  // A geometry-type term this fold cannot resolve (inside a `match`, say): no
  // safe answer, so the whole layer is treated as drawing nothing. No chart
  // layer does this today — areaHit.test.ts pins that, so adding one is a red
  // test rather than a silently un-hittable area.
  if (mentionsGeometryType(expr)) throw UNKNOWN;
  return expr as Expr;
}

/**
 * `filter` as it evaluates for a feature of `geometry` ("Polygon" / "Point" /
 * "LineString"): every `["==", ["geometry-type"], T]` term replaced by its
 * answer and the `all`/`any`/`!` around it simplified. `false` when the
 * filter uses geometry-type in a way this cannot resolve.
 */
export function foldGeometryType(filter: Expr | undefined, geometry: string): Folded {
  if (filter === undefined) return true;
  try {
    return foldInner(filter, geometry);
  } catch (e) {
    if (e === UNKNOWN) return false;
    throw e;
  }
}

/** Does a filter use geometry-type somewhere `foldGeometryType` gives up on? */
export function hasUnfoldableGeometryType(filter: Expr | undefined): boolean {
  if (filter === undefined) return false;
  try {
    foldInner(filter, "Polygon");
    return false;
  } catch (e) {
    if (e === UNKNOWN) return true;
    throw e;
  }
}

function anyOf(terms: Folded[]): Folded {
  return foldInner(["any", ...terms], "Polygon");
}

/**
 * Would `layer` draw a POLYGON feature of class `sourceLayer` — its fill, its
 * ring as a line, a symbol placed on it, or (label-point classes) the symbol
 * on the Point chartcore derives from it?
 */
export function drawsPolygon(sourceLayer: string, layer: DrawnLayer): Folded {
  switch (layer.type) {
    case "fill":
    case "line":
      return foldGeometryType(layer.filter, "Polygon");
    case "symbol":
    case "circle":
      // A symbol layer with no geometry clause places on the polygon itself;
      // a `point`-filtered one draws the area only through its label point.
      return anyOf([
        foldGeometryType(layer.filter, "Polygon"),
        AREA_LABEL_POINT_CLASSES.has(sourceLayer)
          ? foldGeometryType(layer.filter, "Point")
          : false,
      ]);
    default:
      return false;
  }
}

/** Does a visible `fill` already cover EVERY polygon of the class? Then the
 * interior is hittable through real paint and needs no stand-in. */
export function hasFullFill(layers: readonly DrawnLayer[]): boolean {
  return layers.some(
    (l) => l.visible && l.type === "fill" && foldGeometryType(l.filter, "Polygon") === true,
  );
}

/**
 * The filter of a class's interior tap target, WITHOUT the set filter (the
 * caller ANDs that): which polygons some visible layer draws, each under that
 * layer's own SCAMIN gate — so an area decluttered away, hidden by a toggle,
 * or never drawn (an M_NSYS with no symbol) is not a hit. `undefined` when no
 * hit layer is needed: the class has no polygons at all, nothing draws them,
 * or a real fill already answers for all of them.
 *
 * `gate` is the generator's SCAMIN gate; a layer's `scaminExempt` widens it
 * for that layer's term exactly as `add()` widens the layer's own filter.
 */
export function areaHitFilter(
  sourceLayer: string,
  layers: readonly DrawnLayer[],
  gate: Expr,
): Expr | undefined {
  if (NEVER_AREA_SOURCE_LAYERS.has(sourceLayer)) return undefined;
  if (hasFullFill(layers)) return undefined;
  // Group the per-layer answers by SCAMIN exemption: almost every class has
  // none, and then the gate factors out to one clause.
  const byExempt = new Map<string, { exempt?: Expr; terms: Folded[] }>();
  for (const layer of layers) {
    if (!layer.visible) continue;
    const drawn = drawsPolygon(sourceLayer, layer);
    if (drawn === false) continue;
    const key = layer.scaminExempt ? JSON.stringify(layer.scaminExempt) : "";
    let group = byExempt.get(key);
    if (!group) byExempt.set(key, (group = { exempt: layer.scaminExempt, terms: [] }));
    group.terms.push(drawn);
  }
  if (byExempt.size === 0) return undefined;
  const clauses: Expr[] = [];
  for (const { exempt, terms } of byExempt.values()) {
    const drawn = anyOf(terms);
    const gated: Expr = exempt ? ["any", exempt, gate] : gate;
    clauses.push(drawn === true ? gated : (["all", gated, drawn as Expr] as Expr));
  }
  const drawnAndGated: Expr = clauses.length === 1 ? clauses[0] : (["any", ...clauses] as Expr);
  return ["all", poly, drawnAndGated];
}
