// AP(NODATA03) fill pattern, built at runtime instead of cropped from the old
// sprite sheet, so the palette-neutral icon loader stays authoritative.
// see docs/architecture/land-wash-and-nodata-pattern.md

import { s52ColourToHex } from "./colors";

/** Also the name `chartStyle.ts` writes into `fill-pattern`; unchanged from
 * the old sheet's entry so the two stay diffable. */
export const NODATA_PATTERN_ID = "NODATA03";

/** chartsymbols.xml units (0.01mm) -> pixels, ochartsng's own factor. */
const PX_PER_UNIT = 32 / 810;
const CELL_W = 602;
const CELL_H = 396;
const MIN_DIST = 100;
/** The one HPGL stroke, origin-relative and already in pixels. */
const TICK = {
  x0: (2342 - 2342) * PX_PER_UNIT,
  y0: (1041 - 645) * PX_PER_UNIT,
  x1: (2542 - 2342) * PX_PER_UNIT,
  y1: (1040 - 645) * PX_PER_UNIT,
  width: 2, // `SW2` — literal pixels, not scaled
};

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Draw one tileable NODATA03 cell pair, inked in `colour` (an S-52 palette
 * value; pass the active palette's `CHGRD`). */
export function nodataPatternImage(colour: string): RgbaImage {
  const hex = s52ColourToHex(colour);
  const rgb: [number, number, number] = [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
  const width = Math.round((CELL_W + MIN_DIST) * PX_PER_UNIT);
  const rowH = Math.round((CELL_H + MIN_DIST) * PX_PER_UNIT);
  const height = rowH * 2; // staggered: the period is two rows
  const data = new Uint8Array(width * height * 4);

  const plot = (x: number, y: number) => {
    // Modulo in both axes: this image IS the pattern's period, so ink that
    // runs off an edge belongs on the opposite one.
    const px = ((x % width) + width) % width;
    const py = ((y % height) + height) % height;
    const i = (py * width + px) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  };

  for (let row = 0; row < 2; row++) {
    const ox = row === 1 ? Math.floor(width / 2) : 0;
    const oy = row * rowH;
    // Square-brush thick line, matching the reference's `drawThickLine`.
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(TICK.x1 - TICK.x0), Math.abs(TICK.y1 - TICK.y0))),
    );
    const lo = -Math.floor(TICK.width / 2);
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(TICK.x0 + ((TICK.x1 - TICK.x0) * i) / steps);
      const y = Math.round(TICK.y0 + ((TICK.y1 - TICK.y0) * i) / steps);
      for (let dy = lo; dy < lo + TICK.width; dy++) {
        for (let dx = lo; dx < lo + TICK.width; dx++) plot(x + ox + dx, y + oy + dy);
      }
    }
  }
  return { width, height, data };
}

export interface PatternImageTarget {
  hasImage(id: string): boolean;
  addImage(id: string, image: unknown, options?: { pixelRatio?: number }): void;
  updateImage(id: string, image: unknown): void;
}

/** Called from `style.load` (not `styleimagemissing`) so the image exists
 * before the UNSARE fill needs it; `hasImage` split avoids `addImage`
 * throwing on a duplicate id after a diffing `setStyle`. */
export function ensureNodataPattern(map: PatternImageTarget, colour: string): void {
  const image = nodataPatternImage(colour);
  if (map.hasImage(NODATA_PATTERN_ID)) map.updateImage(NODATA_PATTERN_ID, image);
  // pixelRatio 1: tiles at a constant screen size; doubling would halve it.
  else map.addImage(NODATA_PATTERN_ID, image, { pixelRatio: 1 });
}
