// Pins the geometry of the chart-object icons, the part that had visual bugs:
//
//   - the composite aid icon detached and mis-scaled its topmark (it fitted
//     each symbol into the box independently, then guessed offsets);
//   - a single symbol with lots of pivot-centring padding (a "Caution area")
//     shrank to a speck (it fitted the raw canvas, not the mark); and
//   - a light's flare pointed nowhere, because the only path that honoured
//     `rotateDeg` was the one that never ran.
//
// All three are one rule: stack every layer's whole document CENTRED on one
// shared canvas at its native size, rotate a layer about that shared pivot, and
// crop the result to the union of the layers' INK boxes. These assertions run
// on the DOM-free core (`svgCompositeMarkup`, `alphaBounds`, `inkFromAlpha`,
// and `iconStackMarkup` with an injected loader), so they hold headless — the
// only thing needing a browser is the ink measurement itself, which is a
// rasterise-and-scan of exactly the `alphaBounds` covered here.

import { describe, expect, test } from "bun:test";
import {
  alphaBounds,
  iconStackMarkup,
  inkFromAlpha,
  svgCompositeMarkup,
  type IconArtwork,
} from "./ChartSpriteIcon";

/** A w×h RGBA raster. `fill(x,y)` returns [r,g,b,a] for each pixel; default is
 * an opaque solid so callers only override where a mark or transparency lives. */
function raster(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number] = () => [10, 20, 30, 255],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

/** Opaque only inside the given rectangle, transparent elsewhere. */
const markAt = (w: number, h: number, b: { x: number; y: number; width: number; height: number }) =>
  raster(w, h, (x, y) =>
    x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
      ? [200, 100, 50, 255]
      : [0, 0, 0, 0],
  );

describe("alphaBounds — the ink of a pivot-padded canvas", () => {
  test("returns the tight box of the non-transparent mark, not the whole canvas", () => {
    // The Caution-area shrink: a tiny mark on a big pivot-centred canvas. The
    // crop must be the 4×3 mark, never the 16×16 canvas that shrinks it.
    const r = markAt(16, 16, { x: 6, y: 5, width: 4, height: 3 });
    expect(alphaBounds(r)).toEqual({ x: 6, y: 5, width: 4, height: 3 });
  });

  test("returns undefined for a fully transparent raster", () => {
    expect(alphaBounds(raster(8, 8, () => [0, 0, 0, 0]))).toBeUndefined();
  });
});

describe("inkFromAlpha — sampled pixels back to canvas units", () => {
  test("divides the pixel box by the per-axis sampling scale", () => {
    // A 20×20-unit canvas sampled at 8 px/unit: a mark at pixel (16,24) sized
    // 8×16 is a mark at unit (2,3) sized 1×2.
    const r = markAt(160, 160, { x: 16, y: 24, width: 8, height: 16 });
    expect(inkFromAlpha(r, 8, 8)).toEqual({ x: 2, y: 3, width: 1, height: 2 });
  });

  test("the two axes scale independently (the rounding pixel)", () => {
    const r = markAt(10, 20, { x: 2, y: 4, width: 4, height: 8 });
    expect(inkFromAlpha(r, 2, 4)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });

  test("undefined when nothing was painted, so the caller keeps the full canvas", () => {
    expect(inkFromAlpha(raster(4, 4, () => [0, 0, 0, 0]), 2, 2)).toBeUndefined();
  });
});

describe("svgCompositeMarkup — one shared pivot-centred canvas", () => {
  const doc = (w: number, h: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><g/></svg>`;

  test("the union is the max canvas size across layers, and a layer is NOT upscaled", () => {
    const markup = svgCompositeMarkup([
      { svg: doc(8, 8), ink: { x: 0, y: 0, width: 8, height: 8 } },
      { svg: doc(4, 4), ink: { x: 0, y: 0, width: 4, height: 4 } },
    ])!;
    // Each child nested <svg> is pivot-centred: the 4x4 layer sits at (2,2) at
    // its own native size, which is what makes a topmark sit above its buoy.
    expect(markup).toContain('width="8" height="8"');
    expect(markup).toContain('x="2" y="2" width="4" height="4"');
  });

  test("the outer viewBox crops to the UNION of the layers' own ink boxes", () => {
    // Base's ink spans its whole 8x8 canvas; the 4x4 topmark is centred at
    // (2,2) with its own ink offset (1,0) — so its ink sits at (3,2), inside
    // the base's, and the union is the base's own box.
    const markup = svgCompositeMarkup([
      { svg: doc(8, 8), ink: { x: 0, y: 0, width: 8, height: 8 } },
      { svg: doc(4, 4), ink: { x: 1, y: 0, width: 2, height: 1 } },
    ])!;
    expect(markup).toContain('viewBox="0 0 8 8"');
  });

  test("the crop is the ink, not the padded canvas (the Caution-area shrink, in vector)", () => {
    const markup = svgCompositeMarkup([
      { svg: doc(20, 20), ink: { x: 8, y: 9, width: 4, height: 4 } },
    ])!;
    expect(markup).toContain('viewBox="8 9 4 4"');
  });

  test("undefined when any layer's document has no readable viewBox", () => {
    expect(
      svgCompositeMarkup([
        { svg: doc(8, 8), ink: { x: 0, y: 0, width: 8, height: 8 } },
        { svg: "<svg/>", ink: { x: 0, y: 0, width: 4, height: 4 } },
      ]),
    ).toBeUndefined();
  });

  // A LIGHTS layer's own `rotateDeg` (chartProvider.ts `lightRotateDeg`) — the
  // info panel rotating its flare to match the map's own `icon-rotate`.
  function parseViewBox(svg: string): [number, number, number, number] {
    const m = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/);
    if (!m) throw new Error("no viewBox in markup");
    return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  }

  test("a rotated layer wraps in a <g transform=\"rotate(...)\"> around its OWN placed centre, not the union's", () => {
    // 4x4 layer centred in the 8x8 union sits at (2,2), so its own centre —
    // and the pivot chartcore bakes there — is (2+2, 2+2) = (4,4).
    const markup = svgCompositeMarkup([
      { svg: doc(8, 8), ink: { x: 0, y: 0, width: 8, height: 8 } },
      { svg: doc(4, 4), ink: { x: 0, y: 0, width: 4, height: 4 }, rotateDeg: 90 },
    ])!;
    expect(markup).toContain('<g transform="rotate(90 4 4)">');
  });

  test("the union viewBox grows to fit the ROTATED ink corners, not the unrotated bbox", () => {
    // A tall 2-wide strip through an 8x8 canvas, rotated 90deg about the
    // canvas centre (4,4): its footprint becomes an 8-wide, 2-tall band.
    const markup = svgCompositeMarkup([
      { svg: doc(8, 8), ink: { x: 3, y: 0, width: 2, height: 8 }, rotateDeg: 90 },
    ])!;
    const [x, y, w, h] = parseViewBox(markup);
    expect(w).toBeCloseTo(8, 5);
    expect(h).toBeCloseTo(2, 5);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(3, 5);
  });

  test("no rotateDeg: unrotated", () => {
    const markup = svgCompositeMarkup([{ svg: doc(8, 8), ink: { x: 0, y: 0, width: 8, height: 8 } }])!;
    expect(markup).not.toContain("<g transform=");
  });
});

describe("iconStackMarkup — fetched artwork, themed, stacked", () => {
  const art = (w: number, h: number, fill: string): IconArtwork => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path fill="${fill}"/></svg>`,
    ink: { x: 0, y: 0, width: w, height: h },
  });
  const library: Record<string, IconArtwork> = {
    // `#fe0002` is the `obj-red` sentinel (themes/iconRoles.ts) — the
    // palette-neutral render every `?roles=1` document is made of.
    "BOYSHP/4/1/3,1": art(11, 24, "#fe0002"),
    "light/red": art(6, 28, "#fe0002"),
  };
  const load = async (key: string) => library[key];

  test("substitutes the theme's role colours — a sentinel must never reach the DOM", async () => {
    const markup = (await iconStackMarkup(
      [{ spriteId: "BOYSHP/4/1/3,1", role: "base" }],
      { "obj-red": "#d40000" },
      load,
    ))!;
    expect(markup).toContain("#d40000");
    expect(markup).not.toContain("#fe0002");
  });

  test("a lit buoy stacks both documents on one canvas, the flare rotated", async () => {
    const markup = (await iconStackMarkup(
      [
        { spriteId: "BOYSHP/4/1/3,1", role: "base" },
        { spriteId: "light/red", role: "light", rotateDeg: 135 },
      ],
      {},
      load,
    ))!;
    // Union canvas = max per axis (11x28); the 24-tall buoy is centred in it.
    expect(markup).toContain('x="0" y="2" width="11" height="24"');
    expect(markup).toContain('x="2.5" y="0" width="6" height="28"');
    expect(markup).toContain('<g transform="rotate(135 5.5 14)">');
  });

  test("a layer whose artwork is missing drops out; the rest still draws", async () => {
    const markup = (await iconStackMarkup(
      [
        { spriteId: "BOYSHP/4/1/3,1", role: "base" },
        { spriteId: "nope", role: "topmark" },
      ],
      {},
      load,
    ))!;
    expect(markup).toContain('width="11" height="24"');
  });

  test("no layer loaded at all: undefined, so the panel falls back to its chip", async () => {
    expect(await iconStackMarkup([{ spriteId: "nope", role: "base" }], {}, load)).toBeUndefined();
  });
});
