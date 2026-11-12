// The area sort key: smaller areas above larger ones.
//
// NB: run with `--conditions=browser` (`bun run test`).

import { describe, expect, test } from "bun:test";
import type { Position } from "geojson";
import MAP from "./fixtures/map.json";
import { polygonArea, shapeNotices, signedArea } from "./shape";
import type { NoticesMap } from "./types";

const SQUARE: Position[] = [
  [10, 56],
  [10.5, 56],
  [10.5, 56.3],
  [10, 56.3],
  [10, 56],
];
const HOLE: Position[] = [
  [10.2, 56.1],
  [10.3, 56.1],
  [10.3, 56.2],
  [10.2, 56.2],
  [10.2, 56.1],
];
const rev = (r: Position[]) => [...r].reverse();

describe("area sort key", () => {
  test("signed area: CCW positive, CW negative", () => {
    expect(signedArea(SQUARE)).toBeGreaterThan(0);
    expect(signedArea(rev(SQUARE))).toBeLessThan(0);
  });

  test("null passes through", () => {
    expect(shapeNotices(null)).toBeNull();
  });

  test("every area in the snapshot gets a negative key; nothing else gets one", () => {
    const shaped = shapeNotices(MAP as unknown as NoticesMap)!;
    let areas = 0;
    for (const f of shaped.features) {
      const isArea = f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon";
      if (isArea) {
        areas++;
        expect(f.properties.ar).toBeLessThan(0);
      } else expect(f.properties.ar).toBeUndefined();
    }
    expect(areas).toBeGreaterThan(0);
  });

  test("a smaller area keys higher (draws above) a larger one; holes count against", () => {
    const big = polygonArea([SQUARE]);
    const small = polygonArea([HOLE]);
    expect(-small).toBeGreaterThan(-big);
    expect(polygonArea([SQUARE, HOLE])).toBeCloseTo(big - small);
    expect(polygonArea([rev(SQUARE), HOLE])).toBeCloseTo(big - small);
  });
});
