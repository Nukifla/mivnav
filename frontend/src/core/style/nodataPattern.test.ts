/**
 * The AP(NODATA03) fill pattern, once it stopped coming off the sprite sheet
 * (jt task sustkllt).
 *
 * The claim under test is NOT "some ticks get drawn" — it is that this tile is
 * the same tile the presentation library specifies, at the same density and
 * the same on-screen size, because getting that wrong is invisible in review
 * and obvious on a chart: too dense reads as a solid wash over unsurveyed
 * water, too sparse reads as nothing.
 */

import { describe, expect, test } from "bun:test";
import { S52_PALETTES, s52ColourToRgb } from "./colors";
import { ensureNodataPattern, NODATA_PATTERN_ID, nodataPatternImage, type PatternImageTarget } from "./nodataPattern";

const DAY = S52_PALETTES.day.CHGRD;

/** Every pixel with any alpha, as `col,row`. */
function ink(img: { width: number; height: number; data: Uint8Array }): Set<string> {
  const cells = new Set<string>();
  for (let row = 0; row < img.height; row++) {
    for (let col = 0; col < img.width; col++) {
      if (img.data[(row * img.width + col) * 4 + 3] > 0) cells.add(`${col},${row}`);
    }
  }
  return cells;
}

describe("nodataPatternImage", () => {
  test("the declared geometry, not a recomputed tight box", () => {
    // (602 + 100) x (396 + 100) 0.01mm units at 32/810 px per unit, doubled in
    // y because `filltype S`'s staggered lattice has a period of TWO rows and
    // MapLibre can only tile a rectangle. ochartsng instead fits a tight box
    // to the strokes and packs the ticks ~2.5x denser; it can, because it lays
    // the pattern over an opaque fill. Here the sparseness is the feature.
    const img = nodataPatternImage(DAY);
    expect(img.width).toBe(28);
    expect(img.height).toBe(40);
    expect(img.data.length).toBe(28 * 40 * 4);
  });

  test("two staggered ticks, sparse enough to read the chart through", () => {
    const cells = ink(nodataPatternImage(DAY));
    const coverage = cells.size / (28 * 40);
    // Fully transparent would be a broken build; anything approaching a solid
    // fill would be the wash the user explicitly rejected, dressed as a
    // pattern.
    expect(coverage).toBeGreaterThan(0.01);
    expect(coverage).toBeLessThan(0.1);

    const cols = (fromRow: number, toRow: number) =>
      [...cells]
        .map((c) => c.split(",").map(Number))
        .filter(([, row]) => row >= fromRow && row < toRow)
        .map(([col]) => col)
        .sort((a, b) => a - b);
    const top = cols(0, 20);
    const bottom = cols(20, 40);
    expect(top.length).toBeGreaterThan(0);
    expect(bottom.length).toBeGreaterThan(0);
    // Half a cell apart (DrawingContext.cpp:1363) — aligned rows would be a
    // different pattern, and a visibly stripier one.
    expect(top).not.toEqual(bottom);
  });

  test("wraps at the edges, so the tiling is seamless", () => {
    // The tick sits on the bottom edge of its declared box and runs one pixel
    // off the left of the cell; that pixel has to appear on the right, or the
    // tile shows a seam every 28 px.
    const cells = ink(nodataPatternImage(DAY));
    expect([...cells].some((c) => c.startsWith("27,"))).toBe(true);
  });

  test("the ink is the palette's CHGRD, not a baked day grey", () => {
    // What the sheet could not do: it carried three fixed crops and the style
    // stopped naming the prefixed ones, so the pattern was stuck at day.
    for (const palette of ["day", "night"] as const) {
      const colour = S52_PALETTES[palette].CHGRD;
      // Channels via the production parser — the tables are `#rrggbb` since
      // task zrtxyypv, and `nodataPatternImage` reads them the same way.
      const [r, g, b] = s52ColourToRgb(colour)!;
      const img = nodataPatternImage(colour);
      const i = [...ink(img)].map((c) => c.split(",").map(Number))[0];
      const at = (i[1] * img.width + i[0]) * 4;
      expect([img.data[at], img.data[at + 1], img.data[at + 2], img.data[at + 3]]).toEqual([r, g, b, 255]);
    }
  });
});

describe("ensureNodataPattern", () => {
  function fakeMap() {
    const images = new Map<string, unknown>();
    const updates: string[] = [];
    const map: PatternImageTarget & { images: typeof images; updates: typeof updates } = {
      hasImage: (id) => images.has(id),
      addImage: (id, image, options) => {
        if (images.has(id)) throw new Error(`duplicate image ${id}`); // as MapLibre does
        images.set(id, { image, options });
      },
      updateImage: (id, image) => {
        if (!images.has(id)) throw new Error(`no such image ${id}`); // as MapLibre does
        updates.push(id);
        images.set(id, { image, options: { pixelRatio: 1 } });
      },
      images,
      updates,
    };
    return map;
  }

  test("registers once at pixelRatio 1, then re-inks in place", () => {
    // MapView calls this from every `style.load`, and a diffing setStyle keeps
    // the images it already holds — so the second call must not throw the way
    // a bare `addImage` would.
    const map = fakeMap();
    ensureNodataPattern(map, DAY);
    expect((map.images.get(NODATA_PATTERN_ID) as { options: unknown }).options).toEqual({ pixelRatio: 1 });

    ensureNodataPattern(map, S52_PALETTES.night.CHGRD);
    expect(map.updates).toEqual([NODATA_PATTERN_ID]);
    expect(map.images.size).toBe(1);
  });
});
