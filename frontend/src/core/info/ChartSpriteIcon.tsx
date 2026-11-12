// A chart object's own S-52 symbol(s), rendered from the SAME source
// (`/api/icons/<key>.svg?roles=1`) the map draws them from, as real vector
// geometry. Geometric invariants: see docs/architecture/chart-sprite-icon.md.

import { createResource, Show, type Component } from "solid-js";
import type { InfoIconProps } from "./types";
import { atonIconUrl, sizeSvg, svgViewBoxSize } from "../style/atonIcons";
import { substituteIconRoles, type IconRoleColors } from "../style/themes/iconRoles";

/** A symbol's tight ink box in its own canvas coordinates — the canvas being
 * the icon's `viewBox` mapped to `0..width`/`0..height`, which is the space
 * `svgCompositeMarkup` places and crops in. */
export interface SvgIconInk {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A raw RGBA raster — tightly packed, 4 bytes/pixel, row-major. The common
 * subset of an `ImageData` and anything else that shape, so `alphaBounds` runs
 * without touching the DOM (and stays unit testable headless). */
interface Raster {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Tight bounding box of non-transparent (alpha > 0) pixels, or `undefined`
 * when every pixel is transparent — this is "the symbol", not the
 * pivot-centring padding around it. */
export function alphaBounds(raster: Raster): SvgIconInk | undefined {
  const { width, height, data } = raster;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Samples per canvas unit when measuring ink: far finer than the ~15-23px the
 * panel ever draws at, so error is invisible; the px cap keeps a tall
 * pivot-padded canvas (`TSS-arrow` is 108 units) from allocating a huge bitmap. */
const INK_SAMPLE_SCALE = 8;
const INK_SAMPLE_MAX_PX = 512;

/** A pixel-space alpha box back in canvas units — the inverse of the sampling
 * above, per axis (the two scales differ by a rounding pixel). Kept separate
 * from the canvas work so the conversion itself is testable headless. */
export function inkFromAlpha(raster: Raster, sx: number, sy: number): SvgIconInk | undefined {
  const b = alphaBounds(raster);
  if (!b) return undefined;
  return { x: b.x / sx, y: b.y / sy, width: b.width / sx, height: b.height / sy };
}

/** Ink box, measured by rasterising once into a throwaway canvas. `undefined`
 * with no canvas/2D context or unreadable pixels — caller falls back to the
 * full canvas rather than showing nothing. */
async function measureInk(
  svg: string,
  box: { width: number; height: number },
): Promise<SvgIconInk | undefined> {
  if (typeof document === "undefined" || typeof Image === "undefined") return undefined;
  const scale = Math.min(INK_SAMPLE_SCALE, INK_SAMPLE_MAX_PX / Math.max(box.width, box.height));
  const width = Math.max(1, Math.round(box.width * scale));
  const height = Math.max(1, Math.round(box.height * scale));
  const url = URL.createObjectURL(
    // Pixel box goes INTO the document: an <img>'s width/height doesn't
    // reliably scale an SVG with no intrinsic size (atonIcons.ts's decoder
    // settled the same way).
    new Blob([sizeSvg(svg, width, height)], { type: "image/svg+xml" }),
  );
  try {
    const img = new Image(width, height);
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg decode failed"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0, width, height);
    return inkFromAlpha(ctx.getImageData(0, 0, width, height), width / box.width, height / box.height);
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One symbol's artwork: the palette-neutral document exactly as chartcore
 * served it, plus its measured ink box in that document's canvas units. */
export interface IconArtwork {
  svg: string;
  ink: SvgIconInk;
}

/** One fetch + measurement per key per session — module-scoped so panel
 * remounts reuse in-flight/completed work. `undefined` (no artwork: 404,
 * network failure, unreadable viewBox) is cached too, so a miss doesn't retry. */
const artworkCache = new Map<string, Promise<IconArtwork | undefined>>();

export function iconArtwork(key: string): Promise<IconArtwork | undefined> {
  let pending = artworkCache.get(key);
  if (!pending) {
    pending = loadIconArtwork(key);
    artworkCache.set(key, pending);
  }
  return pending;
}

async function loadIconArtwork(key: string): Promise<IconArtwork | undefined> {
  const res = await fetch(atonIconUrl(key)).catch(() => undefined);
  if (!res?.ok) return undefined;
  const svg = await res.text();
  const box = svgViewBoxSize(svg);
  if (!box) return undefined;
  // No measurement means no crop, not no icon: the full pivot-centred canvas
  // is still the right drawing, only padded.
  const ink = (await measureInk(svg, box)) ?? { x: 0, y: 0, width: box.width, height: box.height };
  return { svg, ink };
}

/** One symbol of a chart icon, by its role in the stack. `role` is identity
 * only (`aidLayerRole` in ./chartProvider.ts) — placement is geometry.
 * `rotateDeg` set only for `light`/LIGHTS `base` (`lightRotateDeg`, same file). */
export interface AidLayerSprite {
  spriteId: string;
  role: "base" | "topmark" | "daymark" | "light";
  rotateDeg?: number;
}

/** Rewrites an SVG document's root x/y/width/height, placing the whole
 * document (viewBox/pivot untouched) inside an outer `<svg>` — nested `<svg>`
 * establishes its own viewport there per spec, so no transform is needed. */
function positionSvg(svg: string, x: number, y: number, width: number, height: number): string {
  const open = svg.indexOf(">");
  if (open < 0) return svg;
  const head = svg
    .slice(0, open)
    .replace(/\swidth="[^"]*"/, "")
    .replace(/\sheight="[^"]*"/, "")
    .replace(/\sx="[^"]*"/, "")
    .replace(/\sy="[^"]*"/, "");
  return `${head} x="${x}" y="${y}" width="${width}" height="${height}"${svg.slice(open)}`;
}

/** One layer ready for stacking: its document (own viewBox, pivot at the
 * exact centre) and its ink box in that SAME space. */
export interface SvgLayer {
  svg: string;
  ink: SvgIconInk;
  rotateDeg?: number;
}

/** Stack several layers pivot-centred on one shared canvas (see
 * docs/architecture/chart-sprite-icon.md#2). `undefined` if any layer has no
 * readable `viewBox`; `rotateDeg` rotates about that layer's own baked pivot. */
export function svgCompositeMarkup(layers: SvgLayer[]): string | undefined {
  const boxed = layers.map((l) => {
    const box = svgViewBoxSize(l.svg);
    return box && { svg: l.svg, ink: l.ink, rotateDeg: l.rotateDeg, canvasW: box.width, canvasH: box.height };
  });
  if (boxed.some((b) => !b)) return undefined;
  const placed = boxed as {
    svg: string;
    ink: SvgIconInk;
    rotateDeg?: number;
    canvasW: number;
    canvasH: number;
  }[];
  const unionW = Math.max(...placed.map((p) => p.canvasW));
  const unionH = Math.max(...placed.map((p) => p.canvasH));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const children = placed.map((p) => {
    const ox = (unionW - p.canvasW) / 2;
    const oy = (unionH - p.canvasH) / 2;
    const cx = ox + p.canvasW / 2;
    const cy = oy + p.canvasH / 2;
    // Rotate the ink corners the same way the layer is about to be, so the
    // union bbox doesn't under-report once the layer is visually tilted.
    const corners = [
      [p.ink.x, p.ink.y],
      [p.ink.x + p.ink.width, p.ink.y],
      [p.ink.x, p.ink.y + p.ink.height],
      [p.ink.x + p.ink.width, p.ink.y + p.ink.height],
    ];
    const rad = ((p.rotateDeg ?? 0) * Math.PI) / 180;
    const [sin, cos] = [Math.sin(rad), Math.cos(rad)];
    for (const [ix, iy] of corners) {
      // Clockwise, to match icon-rotate's own convention (aidsHazards.ts).
      const px = ox + ix;
      const py = oy + iy;
      const rx = cx + (px - cx) * cos - (py - cy) * sin;
      const ry = cy + (px - cx) * sin + (py - cy) * cos;
      minX = Math.min(minX, rx);
      minY = Math.min(minY, ry);
      maxX = Math.max(maxX, rx);
      maxY = Math.max(maxY, ry);
    }
    const positioned = positionSvg(p.svg, ox, oy, p.canvasW, p.canvasH);
    return p.rotateDeg
      ? `<g transform="rotate(${p.rotateDeg} ${cx} ${cy})">${positioned}</g>`
      : positioned;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" ` +
    `width="100%" height="100%">${children.join("")}</svg>`
  );
}

/** The whole icon as one inline SVG, stacked and cropped to the union ink. A
 * layer that fails to load simply drops out (a missing topmark must not blank
 * the buoy under it); `undefined` only when NONE loaded. `load` injected for tests. */
export async function iconStackMarkup(
  layers: AidLayerSprite[],
  colors: Partial<IconRoleColors>,
  load: (key: string) => Promise<IconArtwork | undefined> = iconArtwork,
): Promise<string | undefined> {
  const artwork = await Promise.all(layers.map((l) => load(l.spriteId)));
  const drawable = layers
    .map((layer, i) => ({ layer, art: artwork[i] }))
    .filter((l): l is { layer: AidLayerSprite; art: IconArtwork } => !!l.art);
  if (drawable.length === 0) return undefined;
  return svgCompositeMarkup(
    drawable.map(({ layer, art }) => ({
      svg: substituteIconRoles(art.svg, colors),
      ink: art.ink,
      rotateDeg: layer.rotateDeg,
    })),
  );
}

/** The chart provider's per-hit icon: the S-52 symbol, or a composite aid's
 * stacked topmark/light/daymark. FACTORY like ./SectorLightGlyph.tsx's.
 * `inline-block` so `props.class`'s width/height take effect. */
export function createChartIconStack(
  layers: AidLayerSprite[],
  colors: Partial<IconRoleColors>,
): Component<InfoIconProps> {
  return (props) => {
    const [markup] = createResource(() => iconStackMarkup(layers, colors));
    return (
      <Show when={markup()} keyed>
        {(html) => <span class={props.class} style={{ display: "inline-block" }} innerHTML={html} />}
      </Show>
    );
  };
}
