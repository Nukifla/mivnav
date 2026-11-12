// POI map icons — one glyph per POI `kind` (plus any a plugin POI source adds),
// and one per plugin source place type (`PoiSourcePlugin.types`, keyed by
// `kind_detail`), drawn onto canvas and
// registered as palette-named images (signalkShips.ts pattern); all
// palettes registered UP FRONT so a palette switch is an expression swap.
//
// GLYPH SOURCE: path data inlined from Lucide (`lucide-solid`, ISC,
// https://lucide.dev) as 24x24 `iconNode`s rebuilt via `glyphPath` — ISC
// inlining into this GPL-2.0-only repo is fine; provenance to diff against upstream.

import type { ExpressionSpecification, Map as MLMap } from "maplibre-gl";
import { overlayColors, poiColors, PALETTES, type Palette, type PoiColors } from "../../core/style/colors";
import { poiSource, poiSources } from "./sources";

/** All OpenStreetMap POI kinds: the backend's `POI_CATEGORIES` order (see
 * `backend/mivnav/features/poi/tags.py`); a plugin source adds its own
 * (`PoiSourcePlugin.kinds`). Kept in sync by hand with that table; `icons.test.ts`'s fixture pins the
 * list so a drift is caught. */
export const POI_KINDS = [
  // marine
  "marina",
  "harbour",
  "anchorage",
  "harbourmaster",
  "fuel",
  "slipway",
  // land
  "chandlery",
  "boat_dealer",
  "supermarket",
  "convenience",
  "bakery",
  "hardware",
  "laundry",
  "pharmacy",
  "hospital",
  "post_office",
  "bank",
  "atm",
  "restaurant",
  "cafe",
  "pub",
  "toilets",
] as const;
export type PoiKind = (typeof POI_KINDS)[number];

/** The image id used when a feature's `kind` is not one we have a glyph for —
 * a plain ring, so an unexpected tile value still shows a marker rather than a
 * missing-image blank. Registered per palette like every kind. */
export const POI_DEFAULT_KIND = "_default";

// A Lucide `iconNode` primitive. `glyphPath` turns a list of these into one
// Path2D; `PoiGlyphIcon` (./PoiGlyphIcon.tsx) turns the same list into inline
// SVG, so the map marker and the info-at-point icon are the identical shape.
export type Prim =
  | readonly ["path", string]
  | readonly ["circle", number, number, number]
  | readonly ["line", number, number, number, number]
  | readonly ["rect", number, number, number, number];

/** kind → Lucide glyph, chosen for recognizability at a glance. */
export const POI_GLYPHS: Record<PoiKind, readonly Prim[]> = {
  // --- marine ---
  marina: [
    ["path", "M10 2v15"],
    ["path", "M7 22a4 4 0 0 1-4-4 1 1 0 0 1 1-1h16a1 1 0 0 1 1 1 4 4 0 0 1-4 4z"],
    ["path", "M9.159 2.46a1 1 0 0 1 1.521-.193l9.977 8.98A1 1 0 0 1 20 13H4a1 1 0 0 1-.824-1.567z"],
  ],
  harbour: [
    ["path", "M12 10.189V14"],
    ["path", "M12 2v3"],
    ["path", "M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6"],
    ["path", "M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76"],
    ["path", "M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"],
  ],
  anchorage: [
    ["path", "M12 6v16"],
    ["path", "m19 13 2-1a9 9 0 0 1-18 0l2 1"],
    ["path", "M9 11h6"],
    ["circle", 12, 4, 2],
  ],
  harbourmaster: [
    ["path", "M10 18v-7"],
    ["path", "M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z"],
    ["path", "M14 18v-7"],
    ["path", "M18 18v-7"],
    ["path", "M3 22h18"],
    ["path", "M6 18v-7"],
  ],
  fuel: [
    ["path", "M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5"],
    ["path", "M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16"],
    ["path", "M2 21h13"],
    ["path", "M3 9h11"],
  ],
  slipway: [
    ["path", "M19 5a2 2 0 0 0-2 2v11"],
    ["path", "M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"],
    ["path", "M7 13h10"],
    ["path", "M7 9h10"],
    ["path", "M9 5a2 2 0 0 0-2 2v11"],
  ],
  // --- land ---
  chandlery: [
    ["circle", 12, 12, 10],
    ["path", "m4.93 4.93 4.24 4.24"],
    ["path", "m14.83 9.17 4.24-4.24"],
    ["path", "m14.83 14.83 4.24 4.24"],
    ["path", "m9.17 14.83-4.24 4.24"],
    ["circle", 12, 12, 4],
  ],
  boat_dealer: [
    ["circle", 12, 12, 8],
    ["path", "M12 2v7.5"],
    ["path", "m19 5-5.23 5.23"],
    ["path", "M22 12h-7.5"],
    ["path", "m19 19-5.23-5.23"],
    ["path", "M12 14.5V22"],
    ["path", "M10.23 13.77 5 19"],
    ["path", "M9.5 12H2"],
    ["path", "M10.23 10.23 5 5"],
    ["circle", 12, 12, 2.5],
  ],
  supermarket: [
    ["circle", 8, 21, 1],
    ["circle", 19, 21, 1],
    ["path", "M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"],
  ],
  convenience: [
    ["path", "M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"],
    ["path", "M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244"],
    ["path", "M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"],
  ],
  bakery: [
    ["path", "M10.2 18H4.774a1.5 1.5 0 0 1-1.352-.97 11 11 0 0 1 .132-6.487"],
    ["path", "M18 10.2V4.774a1.5 1.5 0 0 0-.97-1.352 11 11 0 0 0-6.486.132"],
    ["path", "M18 5a4 3 0 0 1 4 3 2 2 0 0 1-2 2 10 10 0 0 0-5.139 1.42"],
    ["path", "M5 18a3 4 0 0 0 3 4 2 2 0 0 0 2-2 10 10 0 0 1 1.42-5.14"],
    ["path", "M8.709 2.554a10 10 0 0 0-6.155 6.155 1.5 1.5 0 0 0 .676 1.626l9.807 5.42a2 2 0 0 0 2.718-2.718l-5.42-9.807a1.5 1.5 0 0 0-1.626-.676"],
  ],
  hardware: [
    ["path", "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"],
  ],
  laundry: [
    ["path", "M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"],
  ],
  pharmacy: [
    ["path", "m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"],
    ["path", "m8.5 8.5 7 7"],
  ],
  hospital: [
    ["path", "M4 9a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h4a1 1 0 0 1 1 1v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a1 1 0 0 1 1-1h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-4a1 1 0 0 1-1-1V4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4a1 1 0 0 1-1 1z"],
  ],
  post_office: [
    ["path", "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"],
    ["rect", 2, 4, 20, 16],
  ],
  bank: [
    ["rect", 2, 6, 20, 12],
    ["circle", 12, 12, 2],
    ["path", "M6 12h.01M18 12h.01"],
  ],
  atm: [
    ["rect", 2, 5, 20, 14],
    ["line", 2, 10, 22, 10],
  ],
  restaurant: [
    ["path", "M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"],
    ["path", "M7 2v20"],
    ["path", "M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"],
  ],
  cafe: [
    ["path", "M10 2v2"],
    ["path", "M14 2v2"],
    ["path", "M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"],
    ["path", "M6 2v2"],
  ],
  pub: [
    ["path", "M17 11h1a3 3 0 0 1 0 6h-1"],
    ["path", "M9 12v6"],
    ["path", "M13 12v6"],
    ["path", "M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"],
    ["path", "M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"],
  ],
  toilets: [
    ["path", "M7 12h13a1 1 0 0 1 1 1 5 5 0 0 1-5 5h-.598a.5.5 0 0 0-.424.765l1.544 2.47a.5.5 0 0 1-.424.765H5.402a.5.5 0 0 1-.424-.765L7 18"],
    ["path", "M8 18a5 5 0 0 1-5-5V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8"],
  ],
};

/** Every kind with a glyph: the OpenStreetMap kinds, then each plugin
 * source's own (first registration wins a shared name). */
export function allPoiGlyphs(): ReadonlyMap<string, readonly Prim[]> {
  const out = new Map<string, readonly Prim[]>(POI_KINDS.map((k) => [k, POI_GLYPHS[k]]));
  for (const source of poiSources()) {
    for (const [kind, glyph] of Object.entries(source.kinds ?? {})) {
      if (!out.has(kind)) out.set(kind, glyph);
    }
  }
  return out;
}

/** The glyph for one POI feature's props: a plugin source point's per-type
 * glyph when its `kind_detail` is a known type of that source, else its
 * kind's, else `undefined` (the caller's default). The ONE resolution rule
 * shared by the map (`poiIconExpr`, same order) and the info panel's icon. */
export function poiGlyphFor(props: {
  kind?: unknown;
  kind_detail?: unknown;
  src?: unknown;
}): readonly Prim[] | undefined {
  const detail = props.kind_detail;
  const types = poiSource(props.src)?.types;
  if (types && typeof detail === "string" && Object.hasOwn(types, detail)) {
    return types[detail].glyph;
  }
  const kind = props.kind;
  return typeof kind === "string" ? allPoiGlyphs().get(kind) : undefined;
}

/** The fallback glyph (a plain ring) for `POI_DEFAULT_KIND`. */
const DEFAULT_GLYPH: readonly Prim[] = [["circle", 12, 12, 7]];

/** Canvas supersampling; MapLibre is told via `{ pixelRatio: RATIO }`. Mirrors
 * signalkShips.ts's `RATIO`. */
export const RATIO = 2;
/** Glyph box, CSS px. */
const POI_PX = 20;
/** Padding inside the box so the halo does not clip at the edge. */
const PAD = 2;
/** The Lucide viewBox the glyph coordinates live in. */
const VIEWBOX = 24;

function canvas(w: number, h: number): CanvasRenderingContext2D {
  const el = document.createElement("canvas");
  el.width = w * RATIO;
  el.height = h * RATIO;
  const ctx = el.getContext("2d")!;
  ctx.scale(RATIO, RATIO);
  return ctx;
}

const imageData = (ctx: CanvasRenderingContext2D): ImageData =>
  ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);

/** Rebuild a Lucide `iconNode` as one Path2D (all primitives appended). */
function glyphPath(prims: readonly Prim[]): Path2D {
  const p = new Path2D();
  for (const prim of prims) {
    switch (prim[0]) {
      case "path":
        p.addPath(new Path2D(prim[1]));
        break;
      case "circle": {
        const [, cx, cy, r] = prim;
        p.moveTo(cx + r, cy);
        p.arc(cx, cy, r, 0, Math.PI * 2);
        break;
      }
      case "line": {
        const [, x1, y1, x2, y2] = prim;
        p.moveTo(x1, y1);
        p.lineTo(x2, y2);
        break;
      }
      case "rect": {
        const [, x, y, w, h] = prim;
        p.rect(x, y, w, h);
        break;
      }
    }
  }
  return p;
}

/** Draw one POI glyph: halo pass then glyph, same idiom as signalkShips' day
 * shapes. Stroke widths are divided by the coordinate scale so they land at a
 * constant CSS-px weight. */
function poiIconImage(prims: readonly Prim[], color: string, halo: string): ImageData {
  const ctx = canvas(POI_PX, POI_PX);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const k = (POI_PX - PAD * 2) / VIEWBOX;
  ctx.translate(PAD, PAD);
  ctx.scale(k, k);
  const p = glyphPath(prims);
  ctx.strokeStyle = halo;
  ctx.lineWidth = 3.6 / k;
  ctx.stroke(p);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.9 / k;
  ctx.stroke(p);
  return imageData(ctx);
}

/** Image id for a kind's icon in a palette — palette-named, so a palette switch
 * is a swap of which image the layer references, not a rebuild (signalkShips'
 * `stationIcon`/`shapeIcon` idiom). */
export const poiIcon = (kind: string, palette: Palette): string => `poi-${kind}-${palette}`;

/** Image id for a plugin source's type icon in a palette. Its own
 * `poi-<src>-` namespace part, so a type can never collide with a kind id. */
export const poiTypeIcon = (src: string, detail: string, palette: Palette): string =>
  `poi-type-${src}-${detail}-${palette}`;

/** The glyph accent for a kind: marina/fuel/harbourmaster keep their
 * `poiColors` hue as a category accent; every other kind uses `other`, since
 * the glyph SHAPE now carries identity. Palette-aware — fills dim with the chart. */
function glyphColor(kind: string, c: PoiColors): string {
  switch (kind) {
    case "marina":
      return c.marina;
    case "fuel":
      return c.fuel;
    case "harbourmaster":
      return c.harbourmaster;
    default:
      return c.other;
  }
}

/** Every image id `ensurePoiImages` registers for a palette (all kinds, all
 * plugin source types, the default). The single source of truth shared with
 * `poiIconExpr` and the test. */
export function poiImageIds(palette: Palette): string[] {
  return [
    ...[...allPoiGlyphs().keys()].map((k) => poiIcon(k, palette)),
    ...poiSources().flatMap((s) =>
      Object.keys(s.types ?? {}).map((d) => poiTypeIcon(s.id, d, palette)),
    ),
    poiIcon(POI_DEFAULT_KIND, palette),
  ];
}

/** Register every kind's and source type's icon for EVERY palette, up front
 * (signalkShips idiom) since `icon-image` names the palette per render. A
 * no-op where map/canvas is unavailable; `hasImage` makes it idempotent
 * across reloads. */
export function ensurePoiImages(map: MLMap): void {
  if (typeof document === "undefined" || typeof map.addImage !== "function") return;
  const add = (id: string, data: () => ImageData) => {
    if (!map.hasImage(id)) map.addImage(id, data(), { pixelRatio: RATIO });
  };
  for (const palette of PALETTES) {
    const c = poiColors(palette);
    const halo = overlayColors(palette).halo;
    for (const [kind, glyph] of allPoiGlyphs()) {
      add(poiIcon(kind, palette), () => poiIconImage(glyph, glyphColor(kind, c), halo));
    }
    for (const source of poiSources()) {
      for (const [detail, t] of Object.entries(source.types ?? {})) {
        add(poiTypeIcon(source.id, detail, palette), () =>
          poiIconImage(t.glyph, glyphColor(t.accent ?? "other", c), halo),
        );
      }
    }
    add(poiIcon(POI_DEFAULT_KIND, palette), () => poiIconImage(DEFAULT_GLYPH, c.other, halo));
  }
}

/** `icon-image` for the marker layer — `poiGlyphFor`'s rule as an expression:
 * a plugin source's point (`src == <id>`) whose `kind_detail` is a known type
 * of that source draws that type's icon; anything else (OSM, a type the
 * source added later) draws its `kind`'s icon, falling back to the default so
 * no feature ever references a missing image. */
export function poiIconExpr(palette: Palette): ExpressionSpecification {
  const kindCases: (string | ExpressionSpecification)[] = [];
  for (const kind of allPoiGlyphs().keys()) kindCases.push(kind, poiIcon(kind, palette));
  const byKind = ["match", ["get", "kind"], ...kindCases, poiIcon(POI_DEFAULT_KIND, palette)];
  const bySource: unknown[] = [];
  for (const source of poiSources()) {
    const types = Object.keys(source.types ?? {});
    if (!types.length) continue;
    const cases: string[] = [];
    for (const detail of types) cases.push(detail, poiTypeIcon(source.id, detail, palette));
    bySource.push(["==", ["get", "src"], source.id], ["match", ["get", "kind_detail"], ...cases, byKind]);
  }
  if (!bySource.length) return byKind as unknown as ExpressionSpecification;
  return ["case", ...bySource, byKind] as unknown as ExpressionSpecification;
}
