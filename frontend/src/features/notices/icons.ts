// Notice map icons (efs.md §2.4): one glyph per subject class `cls`, drawn
// inside a round badge whose RING and glyph take the family colour (NW
// red-orange, T/P magenta, permanent violet, firing red, quiet firing area
// grey), plus a small sub-type badge (`sub`: missing / established / unlit …)
// at the top-right — the sub changes the badge, never the colour.
//
// Same pipeline as `features/poi/icons.ts`: Lucide `iconNode`s rebuilt as a
// Path2D and stroked onto a canvas at `RATIO` 2, registered as palette-named
// images so a palette switch is an `icon-image` expression swap. UNLIKE POI,
// images are registered per palette ON DEMAND (`ensureNoticeImages(map,
// palette)` from the overlay's ensure AND paint), not for all palettes up
// front: classes × colours × palettes is ~2300 images here (POI is ~500),
// ~18 MB of sprite for 15 palettes nobody is looking at. One palette is 144
// small images, drawn in a few ms on the switch.
//
// GLYPH SOURCE: path data inlined from Lucide (`lucide-solid` 1.24, ISC,
// https://lucide.dev) — lightbulb, arrow-down-to-line, construction, radar,
// shovel, cable, fish, crosshair (circle shrunk to fit the badge),
// shield-alert, waves-horizontal, radio-off; buoy, beacon, wreck, bridge and
// drifting are composed here from Lucide-style strokes (Lucide has no buoy).
// The bridge glyph is POI's composed `bridge` (`features/poi/icons.ts`).

import type { ExpressionSpecification, Map as MLMap } from "maplibre-gl";
import { noticesColors, type NoticesColors, type Palette } from "../../core/style/colors";
import type { Prim } from "../poi/icons";
import type { NoticeColourKey } from "./time";
import { NOTICE_CLASSES, type NoticeClass, type NoticeSubclass } from "./types";

export type { Prim };

/** cls → glyph, in the 24×24 Lucide viewBox. Usable as inline SVG for a panel
 * row via `poiGlyphIcon(NOTICE_GLYPHS[cls])` (`features/poi/PoiGlyphIcon.tsx`). */
export const NOTICE_GLYPHS: Record<NoticeClass, readonly Prim[]> = {
  // lightbulb — the sub badge says unlit / unreliable / changed
  light: [
    ["path", "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"],
    ["path", "M9 18h6"],
    ["path", "M10 22h4"],
  ],
  // composed: a can buoy on the water with a ball topmark
  buoy: [
    ["path", "M8 17 9.5 9h5l1.5 8"],
    ["path", "M12 9V6"],
    ["circle", 12, 4, 2],
    ["path", "M2 20q2.5 2 5 0t5 0 5 0 5 0"],
  ],
  // composed: a beacon pole on its base with a cone topmark
  beacon: [
    ["path", "M12 21V8"],
    ["path", "m8 8 4-6 4 6z"],
    ["path", "M8 21h8"],
    ["path", "M10 17h4"],
  ],
  // composed: the S-52 wreck stroke — a hull line crossed by three masts
  wreck: [
    ["path", "M3 12h18"],
    ["path", "M8 8v8"],
    ["path", "M12 6v12"],
    ["path", "M16 8v8"],
  ],
  // arrow-down-to-line
  depth: [
    ["path", "M12 17V3"],
    ["path", "m6 11 6 6 6-6"],
    ["path", "M19 21H5"],
  ],
  // construction
  works: [
    ["rect", 2, 6, 20, 8],
    ["path", "M17 14v7"],
    ["path", "M7 14v7"],
    ["path", "M17 3v3"],
    ["path", "M7 3v3"],
    ["path", "M10 14 2.3 6.3"],
    ["path", "m14 6 7.7 7.7"],
    ["path", "m8 6 8 8"],
  ],
  // radar
  survey: [
    ["path", "M19.07 4.93A10 10 0 0 0 6.99 3.34"],
    ["path", "M4 6h.01"],
    ["path", "M2.29 9.62A10 10 0 1 0 21.31 8.35"],
    ["path", "M16.24 7.76A6 6 0 1 0 8.23 16.67"],
    ["path", "M12 18h.01"],
    ["path", "M17.99 11.66A6 6 0 0 1 15.77 16.67"],
    ["circle", 12, 12, 2],
    ["path", "m13.41 10.59 5.66-5.66"],
  ],
  // shovel
  dredging: [
    ["path", "M21.56 4.56a1.5 1.5 0 0 1 0 2.122l-.47.47a3 3 0 0 1-4.212-.03 3 3 0 0 1 0-4.243l.44-.44a1.5 1.5 0 0 1 2.121 0z"],
    ["path", "M3 22a1 1 0 0 1-1-1v-3.586a1 1 0 0 1 .293-.707l3.355-3.355a1.205 1.205 0 0 1 1.704 0l3.296 3.296a1.205 1.205 0 0 1 0 1.704l-3.355 3.355a1 1 0 0 1-.707.293z"],
    ["path", "m9 15 7.879-7.878"],
  ],
  // cable
  cable: [
    ["path", "M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z"],
    ["path", "M17 21v-2"],
    ["path", "M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10"],
    ["path", "M21 21v-2"],
    ["path", "M3 5V3"],
    ["path", "M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z"],
    ["path", "M7 5V3"],
  ],
  // composed (POI's bridge): deck on two piers over an arch, water beneath
  bridge: [
    ["path", "M2 5h20"],
    ["path", "M4 5v11"],
    ["path", "M20 5v11"],
    ["path", "M4 16a8 8 0 0 1 16 0"],
    ["path", "M2 20q2.5 2 5 0t5 0 5 0 5 0"],
  ],
  // fish
  farm: [
    ["path", "M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"],
    ["path", "M18 12v.5"],
    ["path", "M16 17.93a9.77 9.77 0 0 1 0-11.86"],
    ["path", "M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33"],
    ["path", "M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4"],
    ["path", "m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98"],
  ],
  // crosshair — Lucide's r=10 ring shrunk to 7 so it doesn't sit on the badge ring
  firing: [
    ["circle", 12, 12, 7],
    ["line", 22, 12, 17, 12],
    ["line", 7, 12, 2, 12],
    ["line", 12, 7, 12, 2],
    ["line", 12, 22, 12, 17],
  ],
  // shield-alert
  exercise: [
    ["path", "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"],
    ["path", "M12 8v4"],
    ["path", "M12 16h.01"],
  ],
  // composed: waves-horizontal's two lower waves under a drifting triangle
  drifting: [
    ["path", "m12 3 5 8H7z"],
    ["path", "M2 15q2.5 2 5 0t5 0 5 0 5 0"],
    ["path", "M2 20q2.5 2 5 0t5 0 5 0 5 0"],
  ],
  // radio-off
  radionav: [
    ["path", "M13.414 13.414a2 2 0 1 1-2.828-2.828"],
    ["path", "M16.247 7.761a6 6 0 0 1 1.744 4.572"],
    ["path", "M19.075 4.933a10 10 0 0 1 2.234 10.72"],
    ["path", "m2 2 20 20"],
    ["path", "M4.925 19.067a10 10 0 0 1 0-14.134"],
    ["path", "M7.753 16.239a6 6 0 0 1 0-8.478"],
  ],
  // info's "i", without its circle (the badge is the circle)
  general: [
    ["path", "M12 18v-7"],
    ["path", "M12 6h.01"],
  ],
  // circle-alert's "!", without its circle
  other: [
    ["path", "M12 6v7"],
    ["path", "M12 18h.01"],
  ],
};

/** The glyph for a feature's `cls`, falling back to `other` for a class the
 * backend adds before this table learns it. */
export function noticeGlyphFor(cls: unknown): readonly Prim[] {
  return typeof cls === "string" && Object.hasOwn(NOTICE_GLYPHS, cls)
    ? NOTICE_GLYPHS[cls as NoticeClass]
    : NOTICE_GLYPHS.other;
}

/** The sub-type badges: 14 subclasses collapse onto 8 marks — the badge has
 * to read at 12 px, so it says "gone / new / dark / moved …", not which of
 * two near-synonyms the editor picked. */
export const NOTICE_SUB_MARKS = {
  missing: [
    ["path", "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"],
    ["path", "M12 17h.01"],
  ],
  plus: [
    ["path", "M5 12h14"],
    ["path", "M12 5v14"],
  ],
  cross: [
    ["path", "M18 6 6 18"],
    ["path", "m6 6 12 12"],
  ],
  bang: [
    ["path", "M12 5v8"],
    ["path", "M12 18h.01"],
  ],
  arrow: [
    ["path", "M5 12h14"],
    ["path", "m12 5 7 7-7 7"],
  ],
  delta: [["path", "M12 5 19 18H5z"]],
  down: [
    ["path", "M12 5v14"],
    ["path", "m19 12-7 7-7-7"],
  ],
  check: [["path", "M20 6 9 17l-5-5"]],
} as const satisfies Record<string, readonly Prim[]>;
export type NoticeSubMark = keyof typeof NOTICE_SUB_MARKS;

export const SUB_MARK: Record<NoticeSubclass, NoticeSubMark> = {
  missing: "missing",
  "off-station": "arrow",
  moved: "arrow",
  established: "plus",
  lit: "plus",
  withdrawn: "cross",
  unlit: "cross",
  unreliable: "bang",
  damaged: "bang",
  changed: "delta",
  replaced: "delta",
  reduced: "down",
  normal: "check",
  completed: "check",
};

/** The badge mark for a `sub`, or null (no badge) for none / unknown. */
export function subMarkFor(sub: unknown): NoticeSubMark | null {
  return typeof sub === "string" && Object.hasOwn(SUB_MARK, sub) ? SUB_MARK[sub as NoticeSubclass] : null;
}

/** Ring/glyph colour keys an icon can carry — `time.ts`'s `colourKey` range. */
export const NOTICE_COLOUR_KEYS = [
  "warning",
  "firing",
  "temporary",
  "preliminary",
  "permanent",
  "inactive",
] as const satisfies readonly NoticeColourKey[];

/** The map icon: class glyph in a family-coloured badge, with the sub-type
 * badge (`mark`, or `none`) composited at its top-right — ONE image, so the
 * badge is placed or dropped with its icon and the symbol's text slot is free
 * for the shortId label. */
export const noticeIcon = (cls: string, fc: string, mark: string, palette: Palette): string =>
  `notice-${cls}-${fc}-${mark}-${palette}`;
export const noticeHatch = (palette: Palette): string => `notice-hatch-${palette}`;

/** Canvas supersampling — MapLibre is told via `{ pixelRatio: RATIO }`. */
export const RATIO = 2;
/** Main badge, CSS px. */
export const BADGE_PX = 22;
/** Sub-type badge, CSS px. */
export const SUB_PX = 12;
/** Sub badge centre offset from the main badge's centre, CSS px (right, up). */
export const SUB_OFFSET_PX = 8;
/** A badged icon's canvas: big enough to hold the sub badge, centred on the
 * main badge so the symbol anchor stays the notice position. */
export const BADGED_PX = 2 * (SUB_OFFSET_PX + SUB_PX / 2);
/** Hatch tile, CSS px — the diagonal spacing of the firing-area hatch. */
export const HATCH_PX = 8;
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

/** Lucide primitives → one Path2D (mirrors `features/poi/icons.ts`'s). */
export function glyphPath(prims: readonly Prim[]): Path2D {
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

/** A round badge centred at (cx, cy) on `ctx`: `fill` disc, `ring`
 * outline, the glyph stroked in `ink` inside a `glyphPx` box. Shared by the
 * main icon and the sub badge. */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  px: number,
  glyphPx: number,
  prims: readonly Prim[],
  fill: string,
  ring: string,
  ink: string,
  ringPx: number,
  inkPx: number,
): void {
  ctx.save();
  const r = px / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r - ringPx / 2 - 0.25, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = ringPx;
  ctx.strokeStyle = ring;
  ctx.stroke();
  const k = glyphPx / VIEWBOX;
  ctx.translate(cx - glyphPx / 2, cy - glyphPx / 2);
  ctx.scale(k, k);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ink;
  ctx.lineWidth = inkPx / k;
  ctx.stroke(glyphPath(prims));
  ctx.restore();
}

/** One map icon: the class badge, plus the sub badge when `sub` is given. */
function iconImage(cls: NoticeClass, sub: readonly Prim[] | null, c: NoticesColors, ink: string): ImageData {
  const px = sub ? BADGED_PX : BADGE_PX;
  const ctx = canvas(px, px);
  const m = px / 2;
  drawBadge(ctx, m, m, BADGE_PX, 13, NOTICE_GLYPHS[cls], c.badge, ink, ink, 2, 1.6);
  if (sub) drawBadge(ctx, m + SUB_OFFSET_PX, m - SUB_OFFSET_PX, SUB_PX, 8, sub, ink, c.badge, c.badge, 1, 1.6);
  return imageData(ctx);
}

/** The firing-area hatch: 45° stripes in the firing colour on transparent,
 * tiled by `fill-pattern`. Opaque stripes, thin: the fill layer's own
 * `fill-opacity` sets how loud it is (lower on dark palettes is the theme's
 * dimmer firing colour, not a second knob). */
function hatchImage(color: string): ImageData {
  const ctx = canvas(HATCH_PX, HATCH_PX);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "square";
  ctx.beginPath();
  // One diagonal plus the two corner stubs, so the tile repeats seamlessly.
  ctx.moveTo(0, HATCH_PX);
  ctx.lineTo(HATCH_PX, 0);
  ctx.moveTo(-1, 1);
  ctx.lineTo(1, -1);
  ctx.moveTo(HATCH_PX - 1, HATCH_PX + 1);
  ctx.lineTo(HATCH_PX + 1, HATCH_PX - 1);
  ctx.stroke();
  return imageData(ctx);
}

const CLASS_SET = new Set<string>(NOTICE_CLASSES);
const COLOUR_SET = new Set<string>(NOTICE_COLOUR_KEYS);

/** The icon a feature's props resolve to — the same rule `noticeIconExpr`
 * evaluates on the map (unknown class → `other`, unknown colour →
 * `temporary`, no/unknown sub → `none`). */
export function noticeIconParts(props: { cls?: unknown; fc?: unknown; sub?: unknown }): {
  cls: NoticeClass;
  fc: NoticeColourKey;
  mark: NoticeSubMark | "none";
} {
  const cls = typeof props.cls === "string" && CLASS_SET.has(props.cls) ? (props.cls as NoticeClass) : "other";
  const fc = typeof props.fc === "string" && COLOUR_SET.has(props.fc) ? (props.fc as NoticeColourKey) : "temporary";
  return { cls, fc, mark: subMarkFor(props.sub) ?? "none" };
}

export function noticeIconIdFor(props: { cls?: unknown; fc?: unknown; sub?: unknown }, palette: Palette): string {
  const { cls, fc, mark } = noticeIconParts(props);
  return noticeIcon(cls, fc, mark, palette);
}

/** No-op where there is no canvas (tests, SSR). */
const canDraw = (map: MLMap): boolean => typeof document !== "undefined" && typeof map.addImage === "function";

/** Register one palette's hatch. Idempotent (`hasImage`). */
export function ensureNoticeImages(map: MLMap, palette: Palette): void {
  if (!canDraw(map)) return;
  if (!map.hasImage(noticeHatch(palette))) {
    map.addImage(noticeHatch(palette), hatchImage(noticesColors(palette).firing), { pixelRatio: RATIO });
  }
}

/**
 * Register the icons THESE features use, for one palette — before the data
 * that names them reaches the source (the overlay calls this right before
 * `setData`, and on a palette switch). classes × colours × marks × palettes
 * is far too many to draw up front, and `styleimagemissing` belongs to the
 * chart's ATON loader (`core/style/atonIcons.ts`), which claims every id.
 * Idempotent (`hasImage`): a minute's re-derive draws nothing new unless a
 * firing area turned red.
 */
export function ensureNoticeIcons(
  map: MLMap,
  palette: Palette,
  features: readonly { properties?: { role?: unknown; cls?: unknown; fc?: unknown; sub?: unknown } | null }[],
): void {
  if (!canDraw(map)) return;
  const c: NoticesColors = noticesColors(palette);
  for (const f of features) {
    const p = f.properties;
    if (!p || (p.role !== "point" && p.role !== "anchor")) continue;
    const { cls, fc, mark } = noticeIconParts(p);
    const id = noticeIcon(cls, fc, mark, palette);
    if (map.hasImage(id)) continue;
    map.addImage(id, iconImage(cls, mark === "none" ? null : NOTICE_SUB_MARKS[mark], c, c[fc]), { pixelRatio: RATIO });
  }
}

/** `icon-image` for the icon layers: `notice-<cls>-<fc>-<mark>-<palette>`,
 * the same resolution as `noticeIconParts`, so no feature names an image
 * `ensureNoticeIcons` did not register. */
export function noticeIconExpr(palette: Palette): ExpressionSpecification {
  const marks: string[] = [];
  for (const [sub, mark] of Object.entries(SUB_MARK)) marks.push(sub, mark);
  return [
    "concat",
    "notice-",
    ["match", ["get", "cls"], [...NOTICE_CLASSES], ["get", "cls"], "other"],
    "-",
    ["match", ["get", "fc"], [...NOTICE_COLOUR_KEYS], ["get", "fc"], "temporary"],
    "-",
    ["match", ["coalesce", ["get", "sub"], ""], ...marks, "none"],
    `-${palette}`,
  ] as unknown as ExpressionSpecification;
}
