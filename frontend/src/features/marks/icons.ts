// The mark glyphs, baked into map images per palette: Lucide outlines (ISC),
// stroked over a halo the way the anchor glyph is (features/anchor/overlay.ts).
// Strokes only, no filled disc — a mark must not hide the sounding under it.

import type { Map as MLMap } from "maplibre-gl";
import { overlayColors, routeOverlayColors, type Palette } from "../../core/style/colors";
import { MARK_ICONS, markIconId, type MarkIcon } from "./model";

const RATIO = 2;
const ICON_PX = 22;
const PAD = 2;

type Shape = { paths: readonly string[]; circles?: readonly [number, number, number][] };

/** Lucide map-pin, anchor, triangle-alert, fish, star, flag. */
export const MARK_GLYPHS: Record<MarkIcon, Shape> = {
  pin: {
    paths: [
      "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0",
    ],
    circles: [[12, 10, 3]],
  },
  anchor: {
    paths: ["M12 6v16", "m19 13 2-1a9 9 0 0 1-18 0l2 1", "M9 11h6"],
    circles: [[12, 4, 2]],
  },
  danger: {
    paths: [
      "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
      "M12 9v4",
      "M12 17h.01",
    ],
  },
  fish: {
    paths: [
      "M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z",
      "M18 12v.5",
      "M16 17.93a9.77 9.77 0 0 1 0-11.86",
      "M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33",
      "M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4",
      "m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98",
    ],
  },
  star: {
    paths: [
      "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
    ],
  },
  flag: {
    paths: [
      "M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528",
    ],
  },
};

/** The mark colour: the route's (mariner's own planning), so a mark reads as
 * yours and not as charted. */
export const markColor = (palette: Palette): string => routeOverlayColors(palette).route;

function glyph(shape: Shape, color: string, halo: string): ImageData {
  const el = document.createElement("canvas");
  el.width = ICON_PX * RATIO;
  el.height = ICON_PX * RATIO;
  const ctx = el.getContext("2d")!;
  ctx.scale(RATIO, RATIO);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const k = (ICON_PX - PAD * 2) / 24;
  ctx.translate(PAD, PAD);
  ctx.scale(k, k);
  const p = new Path2D();
  for (const d of shape.paths) p.addPath(new Path2D(d));
  for (const [cx, cy, r] of shape.circles ?? []) {
    p.moveTo(cx + r, cy);
    p.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.strokeStyle = halo;
  ctx.lineWidth = 4.6 / k;
  ctx.stroke(p);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4 / k;
  ctx.stroke(p);
  return ctx.getImageData(0, 0, el.width, el.height);
}

/** Register every mark glyph for `palette`. Idempotent; no-op without a canvas. */
export function ensureMarkIcons(map: MLMap, palette: Palette): void {
  if (typeof document === "undefined" || typeof map.addImage !== "function") return;
  const color = markColor(palette);
  const halo = overlayColors(palette).markerHalo;
  for (const icon of MARK_ICONS) {
    const id = markIconId(icon, palette);
    if (!map.hasImage(id)) map.addImage(id, glyph(MARK_GLYPHS[icon], color, halo), { pixelRatio: RATIO });
  }
}
