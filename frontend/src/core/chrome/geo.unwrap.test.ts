import { describe, expect, test } from "bun:test";
import { unwrappedLine } from "./geo";

describe("unwrappedLine", () => {
  test("a leg over the antimeridian goes the short way", () => {
    expect(unwrappedLine([{ lon: 179, lat: 0 }, { lon: -179, lat: 1 }, { lon: -178, lat: 2 }])).toEqual([
      [179, 0],
      [181, 1],
      [182, 2],
    ]);
    expect(unwrappedLine([{ lon: -179, lat: 0 }, { lon: 179, lat: 0 }])).toEqual([
      [-179, 0],
      [-181, 0],
    ]);
  });
  test("ordinary routes are untouched", () => {
    const pts = [{ lon: 10.5, lat: 56 }, { lon: 12, lat: 55 }];
    expect(unwrappedLine(pts)).toEqual([[10.5, 56], [12, 55]]);
  });
});
