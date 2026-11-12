// Own ship + AIS targets: canvas symbols and MapLibre wiring. Decision logic
// (day-shapes, risk colours, predictor length, CPA) lives in aisSymbols.ts.
// See docs/architecture/signalk-canvas-layers.md for why these layers live
// outside the generated style and are rebuilt via ensure() every style load.

import type { ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { Feature, FeatureCollection, Position } from "geojson";
import { invalidateScenePush, scheduleScenePush, type ScenePayload } from "./scenePush";
import { settledSelf } from "./ownDeadband";
import { padDeg } from "../format";
import type { Risk } from "../cpa";
import type { Autopilot, Vessel } from "../signalk";
import { haloPaint, PALETTES, s52ColourToRgb, type Palette } from "../style/colors";
import { TEXT_FONT } from "../style/expr";
import {
  AIS_COLORS,
  apTargetIcon,
  bodyPoints,
  bodyShape,
  buildAisScene,
  type AisSettings,
  DAY_SHAPES,
  dayShapePrims,
  hasFix,
  headingStickIcon,
  HULL_BODIES,
  HULL_PX,
  hullIcon,
  KIND,
  leafPoints,
  ownShipIcon,
  riskColor,
  shapeIcon,
  SHAPE_PX,
  stationColor,
  STATION_PX,
  STATION_SYMBOLS,
  stationGlyph,
  stationIcon,
  symbolColors,
  vesselColors,
  type DayShape,
  type HullBody,
  type ShapePrim,
  type StationSymbol,
  type SymbolColors,
  type TargetVessel,
} from "./aisSymbols";
import { addLayer } from "./addLayer";

const OWN_SOURCE = "signalk-own";
const TARGET_SOURCE = "signalk-targets";
/** Own source, separate from the ~73-feature `TARGET_SOURCE`: the CPA figure
 * redraws on every own-ship (GPS-rate) fix while targets move at AIS rate, so
 * splitting them avoids reparsing all targets on every GPS tick. */
const CPA_SOURCE = "signalk-cpa-source";
export const OWN_SHIP_LAYER_ID = "signalk-own-ship";
export const TARGETS_LAYER_ID = "signalk-targets";
const TARGET_GHOST_LAYER_ID = "signalk-target-ghost";
const TARGET_BUDDY_RING_LAYER_ID = "signalk-target-buddy-ring";
const TARGET_SHAPE_LAYER_ID = "signalk-target-shape";
const TARGET_STATION_LAYER_ID = "signalk-target-station";
const AP_TARGET_LAYER_ID = "signalk-ap-target";

/** All SignalK layer ids, bottom to top — MapView re-hoists in this order, so
 * this order IS the stacking: own ship must never be lost behind a target. */
export const SIGNALK_LAYER_IDS = [
  "signalk-target-predictor",
  "signalk-own-predictor",
  "signalk-cpa",
  "signalk-cpa-points",
  "signalk-target-heading",
  // Under the own-ship heading stick/body: the line emanates past the icon,
  // and the boat must never be lost behind it.
  AP_TARGET_LAYER_ID,
  "signalk-own-heading",
  // Under the solid target hull it belongs to — a faded hint, not a second target.
  TARGET_GHOST_LAYER_ID,
  TARGET_BUDDY_RING_LAYER_ID,
  TARGETS_LAYER_ID,
  TARGET_SHAPE_LAYER_ID,
  TARGET_STATION_LAYER_ID,
  OWN_SHIP_LAYER_ID,
] as const;

/** Heading stick length, pixels not metres — see
 * docs/architecture/signalk-canvas-layers.md. */
const HEADING_STICK_PX = 26;
// Hull/day-shape/station box sizes live in aisSymbols.ts, shared with the
// info-panel icon so both renderings compose at the identical ratio.

/** Canvas supersampling; MapLibre is told via `{ pixelRatio: RATIO }`. */
const RATIO = 2;

/** Opacity of a dead-reckoned ghost hull. */
const GHOST_OPACITY = 0.4;

/**
 * An S-52 token at `alpha`, as a Canvas-2D colour string — halos are
 * deliberately translucent so a symbol reads as a glow, not a sticker.
 * Goes through `colors.ts`'s `s52ColourToRgb`, not a local regex: an earlier
 * regex matched only `rgb(r, g, b)` and passed anything else through
 * unchanged, which since the theme files became `#rrggbb` would silently
 * make every halo fully opaque with no error and no failing test.
 */
function alpha(token: string, a: number): string {
  const c = s52ColourToRgb(token);
  if (!c) return token; // assertion, not a real fallback — every caller passes a table value
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

/** Halo alphas for the two halos stroked by hand (canvas only — MapLibre's own
 * `text-halo-color`/`circle-stroke-color` take the token opaque; those are
 * feathered by width/blur/geometry instead). */
const HALO_A = {
  stick: 0.85,
  shape: 0.9,
} as const;

function canvas(w: number, h: number): CanvasRenderingContext2D {
  const el = document.createElement("canvas");
  el.width = w * RATIO;
  el.height = h * RATIO;
  // `willReadFrequently`: every icon is read back with getImageData (~600 at
  // boot: all palettes × risks × hulls) — keep the canvas CPU-side so each
  // read isn't a GPU readback.
  const ctx = el.getContext("2d", { willReadFrequently: true })!;
  ctx.scale(RATIO, RATIO);
  return ctx;
}

const imageData = (ctx: CanvasRenderingContext2D): ImageData =>
  ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);

/** Boat-shaped own-ship icon (bow up — rotated by heading at render time). */
function ownShipImage(C: SymbolColors, fill: string): ImageData {
  const w = 18;
  const h = 40;
  const ctx = canvas(w, h);
  ctx.beginPath();
  ctx.moveTo(w / 2, 1); // bow
  ctx.quadraticCurveTo(w - 1, h * 0.4, w - 1, h * 0.75);
  ctx.lineTo(w - 1, h - 1);
  ctx.lineTo(1, h - 1);
  ctx.lineTo(1, h * 0.75);
  ctx.quadraticCurveTo(1, h * 0.4, w / 2, 1);
  ctx.closePath();
  // Own ship's red is not a risk colour (see AIS_COLORS); the caller passes
  // the palette's `vesselColors().own` — the same red, dimmed on a night
  // theme that asks for it — or its grey for the link-lost variant.
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.ui;
  ctx.stroke();
  return imageData(ctx);
}

/** Trace the sailing LEAF outline (see `leafPoints` in aisSymbols.ts, pure and
 * tested) onto the current path as four cubic Béziers. */
function traceLeaf(ctx: CanvasRenderingContext2D, s: number): void {
  const { bow, segments } = leafPoints(s);
  ctx.moveTo(bow[0], bow[1]);
  for (const [c1, c2, end] of segments) {
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], end[0], end[1]);
  }
  ctx.closePath();
}

/**
 * An AIS target body (dart or one of the three type-bodies), filled with the
 * risk colour and outlined in the foreground token. Body never carries risk —
 * colour does (OpenCPN ais.cpp:1039). Two passes (fill every subpath, then
 * stroke every subpath) so one multi-part body's outline never paints over
 * the part stacked in front of it.
 */
function hullImage(body: HullBody, fill: string, C: SymbolColors, rotorDeg = 0, hollow = false): ImageData {
  const s = HULL_PX;
  const ctx = canvas(s, s);
  ctx.lineJoin = "round"; // clean nicks, not frayed spikes, at the notch/reflex vertices
  // `rotorDeg` spins the heli's blades; every other body ignores it.
  const subpaths: [number, number][][] =
    body === "leaf" ? [] : bodyPoints(body, s, rotorDeg);
  const trace = () => {
    ctx.beginPath();
    if (body === "leaf") {
      traceLeaf(ctx, s);
    } else {
      for (const sp of subpaths) {
        const [nose, ...rest] = sp;
        ctx.moveTo(nose[0], nose[1]);
        for (const [x, y] of rest) ctx.lineTo(x, y);
        ctx.closePath();
      }
    }
  };
  // Hollow (a buddy gone quiet): a wash of the colour and its own outline, so
  // an old position can't be mistaken for a boat that is there now.
  ctx.fillStyle = fill;
  ctx.globalAlpha = hollow ? 0.2 : 1;
  trace();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = hollow ? 2 : 1.5;
  ctx.strokeStyle = hollow ? fill : C.ui;
  trace();
  ctx.stroke();
  return imageData(ctx);
}

/**
 * A non-vessel station symbol (AtoN diamond-`+`, base-station antenna, SART
 * circle-`X`): a body in the station's FIXED colour (`STATION_COLORS`, never
 * risk), outlined/haloed in the palette tokens. Three passes so nothing
 * paints over its own halo — see the numbered steps below.
 */
function stationImage(symbol: StationSymbol, C: SymbolColors, fill: string): ImageData {
  const s = STATION_PX;
  const ctx = canvas(s, s);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const { polygon, disc, fgMarks, fixedMarks } = stationGlyph(symbol, s);

  // 1. Filled body, outlined in the foreground.
  if (polygon || disc) {
    ctx.beginPath();
    if (polygon) {
      ctx.moveTo(polygon[0][0], polygon[0][1]);
      for (const [x, y] of polygon.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
    } else if (disc) {
      ctx.arc(disc.cx, disc.cy, disc.r, 0, Math.PI * 2);
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = C.ui;
    ctx.stroke();
  }

  const strokeSegs = (segs: [[number, number], [number, number]][]) => {
    for (const [[x0, y0], [x1, y1]] of segs) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  };

  // 2. The antenna IS the body — fixed colour, halo first, like the heading stick.
  if (fixedMarks.length) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = alpha(C.uiHalo, HALO_A.stick);
    strokeSegs(fixedMarks);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = fill;
    strokeSegs(fixedMarks);
  }

  // 3. Foreground marks over the body (`+`, `X`) — halo first, then ui token.
  if (fgMarks.length) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = alpha(C.uiHalo, HALO_A.shape);
    strokeSegs(fgMarks);
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = C.ui;
    strokeSegs(fgMarks);
  }
  return imageData(ctx);
}

/** Fixed-length stick from the vessel along its true heading. Drawn bottom-up:
 * the layer anchors it at the icon's bottom edge, which is the vessel. */
function headingStickImage(C: SymbolColors): ImageData {
  const w = 5;
  const h = HEADING_STICK_PX;
  const ctx = canvas(w, h);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(w / 2, h - 1);
  ctx.lineTo(w / 2, 1.5);
  // Halo first, then the stick: it crosses the hull's own outline and would
  // vanish there without one. The pair inverts with the palette so it
  // survives whichever way round chart and hull sit.
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = alpha(C.uiHalo, HALO_A.stick);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.ui;
  ctx.stroke();
  return imageData(ctx);
}

/**
 * The autopilot's committed target line — fixed-pixel like the heading stick
 * and for the same reason, but told apart by PATTERN (long dashes + end bar)
 * rather than hue, because `--color-ap` shares a night green with safe AIS
 * targets. `color` is the resolved `--color-ap` token (the one own-ship glyph
 * coloured by CSS, not an S-52 table value).
 */
const AP_LINE_PX = 60;
function apTargetLineImage(color: string, halo: string): ImageData {
  const w = 7;
  const h = AP_LINE_PX;
  const ctx = canvas(w, h);
  ctx.lineCap = "butt";
  const dash: [number, number] = [9, 5]; // long dashes up the line, then a bar across the end
  const line = new Path2D();
  line.moveTo(w / 2, h - 1);
  line.lineTo(w / 2, 4);
  const bar = new Path2D();
  bar.moveTo(w / 2 - 3, 4);
  bar.lineTo(w / 2 + 3, 4);
  // Halo pass (solid, wider), then the coloured dashed line on top.
  ctx.setLineDash([]);
  ctx.strokeStyle = alpha(halo, HALO_A.stick);
  ctx.lineWidth = 3.6;
  ctx.stroke(line);
  ctx.lineWidth = 4.2;
  ctx.stroke(bar);
  ctx.strokeStyle = color;
  ctx.setLineDash(dash);
  ctx.lineWidth = 1.8;
  ctx.stroke(line);
  ctx.setLineDash([]);
  ctx.lineWidth = 2.4;
  ctx.stroke(bar);
  return imageData(ctx);
}

/** A day-shape primitive (`dayShapePrims`, aisSymbols.ts) as a `Path2D` — the
 * seam where shared geometry becomes canvas pixels. `path` is a verbatim SVG
 * `d` string, which `Path2D` parses directly. */
function primToPath2D(prim: ShapePrim): Path2D {
  const p = new Path2D();
  if ("circle" in prim) {
    const [cx, cy, r] = prim.circle;
    p.arc(cx, cy, r, 0, Math.PI * 2);
  } else if ("rect" in prim) {
    const [x, y, w, h] = prim.rect;
    p.rect(x, y, w, h);
  } else if ("poly" in prim) {
    const [first, ...rest] = prim.poly;
    p.moveTo(first[0], first[1]);
    for (const [x, y] of rest) p.lineTo(x, y);
    p.closePath();
  } else {
    return new Path2D(prim.path);
  }
  return p;
}

function shapeImage(shape: Exclude<DayShape, "none">, C: SymbolColors): ImageData {
  const s = SHAPE_PX;
  const ctx = canvas(s, s);
  const paths = dayShapePrims(shape, s).map(primToPath2D);
  // Halo pass for every path, then the glyph pass — so one ball's halo never
  // paints over the ball above it.
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = alpha(C.uiHalo, HALO_A.shape);
  for (const p of paths) ctx.stroke(p);
  ctx.fillStyle = C.ui;
  for (const p of paths) ctx.fill(p);
  return imageData(ctx);
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** Every layer is filtered by `kind`, never by geometry type — so a CPA
 * end-point can never be mistaken for a vessel. */
const isKind = (kind: string): ExpressionSpecification => ["==", ["get", "kind"], kind];

/** Idempotent: (re-)create images, sources and layers after any style
 * application. Takes no settings — see docs/architecture/signalk-canvas-layers.md. */
export function ensureSignalkLayers(map: MLMap): void {
  const image = (id: string, data: () => ImageData) => {
    if (!map.hasImage(id)) map.addImage(id, data(), { pixelRatio: RATIO });
  };

  // All three palettes' symbols are registered up front (this function cannot
  // know which is current — see the doc above); the scene names the icon it
  // wants per feature, so a palette switch stays a `setData`, never a rebuild.
  const risks: Risk[] = ["green", "yellow", "red", "unknown"];
  for (const palette of PALETTES) {
    const C = symbolColors(palette);
    const V = vesselColors(palette);
    image(ownShipIcon(palette), () => ownShipImage(C, V.own));
    image(ownShipIcon(palette, true), () => ownShipImage(C, V.unknown));
    image(headingStickIcon(palette), () => headingStickImage(C));
    for (const body of HULL_BODIES) {
      for (const risk of risks) {
        image(hullIcon(risk, palette, body), () => hullImage(body, riskColor(palette, risk), C));
      }
      image(hullIcon("off", palette, body), () => hullImage(body, riskColor(palette, "off"), C));
      image(hullIcon("buddy", palette, body), () => hullImage(body, riskColor(palette, "buddy"), C));
      image(hullIcon("buddy-old", palette, body), () =>
        hullImage(body, riskColor(palette, "buddy-old"), C, 0, true),
      );
    }
    for (const shape of DAY_SHAPES) image(shapeIcon(shape, palette), () => shapeImage(shape, C));
    for (const symbol of STATION_SYMBOLS) image(stationIcon(symbol, palette), () => stationImage(symbol, C, stationColor(palette, symbol)));
  }

  for (const id of [OWN_SOURCE, TARGET_SOURCE, CPA_SOURCE]) {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });
  }
  // A style reload re-creates the sources EMPTY, but scenePush's dedup cache
  // still remembers the last-pushed GeoJSON and would skip the refill as
  // "unchanged" — leaving vessels off the chart until something moves. So
  // forget it here, forcing the next push to refill regardless.
  invalidateScenePush(map);

  const layer = (spec: Parameters<MLMap["addLayer"]>[0]) => {
    if (!map.getLayer(spec.id)) addLayer(map, spec);
  };

  // COG/SOG predictor — dashed (a forecast, not a fact), coloured by risk.
  const predictor = (id: string, source: string) =>
    layer({
      id,
      type: "line",
      source,
      filter: isKind(KIND.predictor),
      paint: {
        "line-color": ["get", "color"],
        "line-width": 1.5,
        "line-dasharray": [2, 2],
      },
    });
  predictor("signalk-target-predictor", TARGET_SOURCE);
  predictor("signalk-own-predictor", OWN_SOURCE);

  // The CPA gap at closest approach — heavier than a predictor, the one line
  // meant to say "look at me". Same figure OpenCPN draws (ais.cpp:1073-1140).
  layer({
    id: "signalk-cpa",
    type: "line",
    source: CPA_SOURCE,
    filter: isKind(KIND.cpa),
    paint: {
      "line-color": AIS_COLORS.red,
      "line-width": 2,
      "line-dasharray": [4, 2],
    },
  });
  layer({
    id: "signalk-cpa-points",
    type: "circle",
    source: CPA_SOURCE,
    filter: isKind(KIND.cpaPoint),
    paint: {
      "circle-radius": 3,
      "circle-color": AIS_COLORS.red, // stays red in every palette; only the ring tracks the chart
      "circle-stroke-width": 1,
      "circle-stroke-color": ["get", "haloColor"],
    },
  });

  // `has heading` is the gate: the builder omits the property when there is
  // no heading to show, or when the setting is off.
  const headingStick = (id: string, source: string) =>
    layer({
      id,
      type: "symbol",
      source,
      filter: ["all", isKind(KIND.vessel), ["has", "heading"]],
      layout: {
        "icon-image": ["get", "stick"],
        // Own ship's `ownShipScale`; targets carry no `size` and stay at 1.
        "icon-size": ["coalesce", ["get", "size"], 1],
        "icon-anchor": "bottom",
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  headingStick("signalk-target-heading", TARGET_SOURCE);
  headingStick("signalk-own-heading", OWN_SOURCE);

  // A translucent copy of the SAME hull icon the target draws (`targetFeatures`
  // picks body/colour/palette), made secondary purely via `icon-opacity` — no
  // redraw, no label/day-shape/stick. A position hint, not a second target.
  layer({
    id: TARGET_GHOST_LAYER_ID,
    type: "symbol",
    source: TARGET_SOURCE,
    filter: isKind(KIND.ghost),
    layout: {
      "icon-image": ["get", "icon"],
      "icon-rotate": ["get", "rotation"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
    paint: { "icon-opacity": GHOST_OPACITY },
  });

  // Only on a buddy showing a risk colour (`targetFeatures`): the hull says
  // "danger", this says whose boat it is.
  layer({
    id: TARGET_BUDDY_RING_LAYER_ID,
    type: "circle",
    source: TARGET_SOURCE,
    filter: ["all", isKind(KIND.vessel), ["has", "buddyRing"]],
    paint: {
      "circle-radius": 16,
      "circle-opacity": 0,
      "circle-stroke-width": 2.5,
      "circle-stroke-color": ["get", "buddyRing"],
    },
  });

  layer({
    id: TARGETS_LAYER_ID,
    type: "symbol",
    source: TARGET_SOURCE,
    filter: isKind(KIND.vessel),
    layout: {
      "icon-image": ["get", "icon"],
      "icon-rotate": ["get", "rotation"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "text-field": ["coalesce", ["get", "name"], ""],
      "text-font": TEXT_FONT,
      "text-size": 12,
      "text-anchor": "top",
      "text-offset": [0, 1.2],
      "text-optional": true,
    },
    paint: {
      // textColor/haloColor are data-driven (from `symbolColors(settings.palette)`)
      // because they were once CHBLK (day table) over hard-coded white: on a
      // night chart every target's name was black text in a white glare.
      "text-color": ["get", "textColor"],
      "text-halo-color": ["get", "haloColor"],
      "text-halo-width": ["coalesce", ["get", "haloWidth"], 0],
      "text-halo-blur": ["coalesce", ["get", "haloBlur"], 0],
    },
  });

  // Viewport-aligned, never rotated: the glyph pictures a shape hanging from a
  // stay, and gravity doesn't care which way the boat is heading.
  layer({
    id: TARGET_SHAPE_LAYER_ID,
    type: "symbol",
    source: TARGET_SOURCE,
    filter: ["all", isKind(KIND.vessel), ["has", "shape"]],
    layout: {
      "icon-image": ["get", "shape"],
      "icon-rotation-alignment": "viewport",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });

  // Viewport-aligned (a fixed marker has no heading), filtered to its own
  // `kind` to keep it out of the vessel layer's risk colouring and CPA figure.
  layer({
    id: TARGET_STATION_LAYER_ID,
    type: "symbol",
    source: TARGET_SOURCE,
    filter: isKind(KIND.station),
    layout: {
      "icon-image": ["get", "icon"],
      "icon-rotation-alignment": "viewport",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "text-field": ["coalesce", ["get", "name"], ""],
      "text-font": TEXT_FONT,
      "text-size": 12,
      "text-anchor": "top",
      "text-offset": [0, 1.2],
      "text-optional": true,
    },
    paint: {
      "text-color": ["get", "textColor"],
      "text-halo-color": ["get", "haloColor"],
      "text-halo-width": ["coalesce", ["get", "haloWidth"], 0],
      "text-halo-blur": ["coalesce", ["get", "haloBlur"], 0],
    },
  });

  layer({
    id: OWN_SHIP_LAYER_ID,
    type: "symbol",
    source: OWN_SOURCE,
    filter: isKind(KIND.vessel),
    layout: {
      "icon-image": ["get", "icon"],
      "icon-size": ["coalesce", ["get", "size"], 1],
      "icon-rotate": ["get", "rotation"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });

  // AP target line + its `AP NNN°` label: icon map-aligned/rotated to the
  // bearing, label viewport-aligned (upright) and offset to the line's end
  // via per-feature `labelOffset`. Image built lazily — see `ensureApImage`.
  layer({
    id: AP_TARGET_LAYER_ID,
    type: "symbol",
    source: OWN_SOURCE,
    filter: isKind(KIND.apTarget),
    layout: {
      "icon-image": ["get", "apIcon"],
      "icon-anchor": "bottom",
      "icon-rotate": ["get", "heading"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "text-field": ["get", "label"],
      "text-font": TEXT_FONT,
      "text-size": 11,
      "text-rotation-alignment": "viewport",
      "text-anchor": "center",
      "text-offset": ["get", "labelOffset"],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": ["get", "color"],
      "text-halo-color": ["get", "haloColor"],
      "text-halo-width": ["coalesce", ["get", "haloWidth"], 0],
      "text-halo-blur": ["coalesce", ["get", "haloBlur"], 0],
    },
  });
}

/** Read the current palette's `--color-ap` design token off the DOM — the one
 * own-ship glyph coloured by CSS rather than an S-52 table value, so chart and
 * chrome (the AP rail tile/board card) never disagree about the pilot colour.
 * `applyPalette` has already reflected the palette onto `:root` by the time
 * the SignalK effect runs, so this resolves correctly. */
function apColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--color-ap").trim();
}

/** Build the AP line icon for `palette` if not already registered — keyed by
 * palette so a switch rebuilds it, cached by `hasImage` after the first draw. */
function ensureApImage(map: MLMap, palette: Palette): string {
  const id = apTargetIcon(palette);
  if (!map.hasImage(id)) {
    const image = apTargetLineImage(apColor(), symbolColors(palette).uiHalo);
    map.addImage(id, image, { pixelRatio: RATIO });
  }
  return id;
}

/**
 * The own-ship AP target feature. ⚠️ Caller-gated: `updateSignalkData` passes
 * `ap = null` unless `status === "connected"`, so a frozen snapshot never
 * paints a green target line; `engaged` absent is not `true` either.
 */
function apFeature(self: Vessel, palette: Palette, apIcon: string, targetDeg: number): Feature {
  const pos: Position = [self.lng, self.lat];
  // Label offset in ems, screen space (y down): dx = sin θ, dy = −cos θ,
  // scaled to the line length plus a small margin.
  const r = (AP_LINE_PX + 10) / 11;
  const rad = (targetDeg * Math.PI) / 180;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: pos },
    properties: {
      kind: KIND.apTarget,
      apIcon,
      heading: targetDeg,
      label: `AP ${padDeg(targetDeg)}°`,
      labelOffset: [Math.sin(rad) * r, -Math.cos(rad) * r],
      color: apColor(),
      haloColor: symbolColors(palette).uiHalo,
      haloWidth: haloPaint(palette)["text-halo-width"] ?? 0,
      haloBlur: haloPaint(palette)["text-halo-blur"] ?? 0,
    },
  };
}

// ---- the SAR helicopter's spinning rotor ----------------------------------
//
// A still rotor reads as a wreck, not an asset on task, so while a SAR heli is
// on the chart a `requestAnimationFrame` loop re-rasters its icons in place
// via `map.updateImage` (stable icon ids, no `setData`/layer churn). Gated
// hard on presence — started/stopped as the last one arrives/leaves — since
// it drives a continuous repaint; only the active palette's five images are
// redrawn per frame.

/** Rotor angular speed, degrees/ms (~1.5 rev/s) — fast enough to read as
 * "running" without strobing at the display refresh rate. */
const ROTOR_DEG_PER_MS = 0.55;

/** All five risk states a hull icon is built for. */
const HULL_RISKS: readonly (Risk | "off")[] = ["green", "yellow", "red", "unknown", "off"];

interface RotorAnim {
  raf: number;
  /** Timestamp of the previous frame, for a framerate-independent advance. */
  last: number;
  /** Current rotor angle, degrees. */
  deg: number;
  /** The palette whose sar-heli icons are on screen and being spun. */
  palette: Palette;
}

let rotor: RotorAnim | null = null;

/** Re-raster the active palette's sar-heli icons with the rotor at `deg`. */
function drawRotorFrame(map: MLMap, palette: Palette, deg: number): void {
  const C = symbolColors(palette);
  for (const risk of HULL_RISKS) {
    const id = hullIcon(risk, palette, "sar-heli");
    // A style reload may drop the images; the next ensureSignalkLayers rebuilds them.
    if (!map.hasImage(id)) continue;
    const fill = riskColor(palette, risk);
    map.updateImage(id, hullImage("sar-heli", fill, C, deg));
  }
}

function stopRotor(): void {
  if (rotor === null) return;
  cancelAnimationFrame(rotor.raf);
  rotor = null;
}

/** Ensure the rotor is spinning for `palette`. Idempotent: a second call while
 * running only retargets the palette. No-op without `requestAnimationFrame`
 * (headless unit tests). */
function startRotor(map: MLMap, palette: Palette): void {
  if (typeof requestAnimationFrame !== "function") return;
  if (rotor !== null) {
    rotor.palette = palette;
    return;
  }
  const state: RotorAnim = { raf: 0, last: 0, deg: 0, palette };
  rotor = state;
  const step = (ts: number): void => {
    if (rotor !== state) return; // stopped (or replaced) since the last frame
    const dt = state.last === 0 ? 16 : Math.min(ts - state.last, 100);
    state.last = ts;
    state.deg = (state.deg + dt * ROTOR_DEG_PER_MS) % 360;
    try {
      drawRotorFrame(map, state.palette, state.deg);
    } catch {
      // The map was torn down mid-flight (no teardown hook reaches this file);
      // give up rather than throw into rAF forever.
      stopRotor();
      return;
    }
    map.triggerRepaint();
    state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}

// ── The scene push: coalesced + deduped (see `scenePush.ts`) ─────────────────

/** Build the payload one frame's worth of deltas collapses to. Run at most
 * once per frame by the coalescer, on the LATEST delta's closure — never run
 * for a delta a later one supersedes. */
function buildScenePayload(
  map: MLMap,
  rawSelf: Vessel | null,
  targets: TargetVessel[],
  settings: AisSettings,
  ap: Autopilot | null,
  ownStale: boolean,
): ScenePayload {
  const own = map.getSource(OWN_SOURCE) as GeoJSONSource | undefined;
  const tgt = map.getSource(TARGET_SOURCE) as GeoJSONSource | undefined;
  const cpa = map.getSource(CPA_SOURCE) as GeoJSONSource | undefined;
  const self = settledSelf(map, rawSelf);
  // The ghost's clock, QUANTIZED to whole seconds: an un-quantized Date.now()
  // would shift every ghost by millimetres on every GPS-rate own-ship fix,
  // defeating scenePush's dedup and re-pushing all ~73 target features per tick.
  const nowMs = Math.floor(Date.now() / 1000) * 1000;
  const scene = buildAisScene(self, targets, settings, nowMs, ownStale);

  // Appended here, not in buildAisScene, because it needs the DOM (--color-ap)
  // and the map (its lazily-built icon). ⚠️ Caller gates `ap` to non-null only
  // while connected; `engaged === true` is explicit, absent is not `true`.
  if (
    self &&
    hasFix(self) &&
    ap?.engaged === true &&
    ap.targetDeg !== undefined &&
    Number.isFinite(ap.targetDeg)
  ) {
    const icon = ensureApImage(map, settings.palette);
    scene.own.features.push(apFeature(self, settings.palette, icon, ap.targetDeg));
  }

  // Same `bodyShape` decision the scene made for the icon, so the rotor
  // animation can never disagree with the symbol about who's a helicopter.
  const anySar = targets.some((t) => hasFix(t) && bodyShape(t) === "sar-heli");
  return {
    own,
    tgt,
    cpa,
    ownData: scene.own,
    tgtData: scene.targets,
    cpaData: scene.cpa,
    after: () => {
      if (anySar) startRotor(map, settings.palette);
      else stopRotor();
    },
  };
}

/**
 * Push the current SignalK state into the (ensured) sources — COALESCED to at
 * most one build + push per frame, DEDUPED so an unchanged scene pushes
 * nothing (see `scenePush.ts`).
 *
 * `settings` carries the boat's collision settings (`AisSettings.collision`)
 * — required, so the safety-relevant thresholds are never defaulted here.
 */
export function updateSignalkData(
  map: MLMap,
  self: Vessel | null,
  targets: TargetVessel[],
  settings: AisSettings,
  ap: Autopilot | null = null,
  ownStale = false,
): void {
  scheduleScenePush(map, () => buildScenePayload(map, self, targets, settings, ap, ownStale));
}

