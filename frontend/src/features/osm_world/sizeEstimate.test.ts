import { describe, expect, test } from "bun:test";
import { estimateOsmWorldExtractBytes, estimateOsmWorldRegionBytes } from "./sizeEstimate";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

describe("estimateOsmWorldExtractBytes", () => {
  test("reproduces the measured anchor points", () => {
    // The exact numbers backend mivnav.features.osm_world.config's own
    // comment measured (pmtiles extract --dry-run against a real build).
    expect(estimateOsmWorldExtractBytes(6)).toBeCloseTo(45 * MB, -3);
    expect(estimateOsmWorldExtractBytes(8)).toBeCloseTo(550 * MB, -3);
    expect(estimateOsmWorldExtractBytes(10)).toBeCloseTo(3.7 * GB, -3);
    expect(estimateOsmWorldExtractBytes(12)).toBeCloseTo(17 * GB, -3);
  });

  test("interpolates monotonically between anchors", () => {
    const z7 = estimateOsmWorldExtractBytes(7);
    expect(z7).toBeGreaterThan(estimateOsmWorldExtractBytes(6));
    expect(z7).toBeLessThan(estimateOsmWorldExtractBytes(8));
  });

  test("extrapolates below/above the table without inverting", () => {
    expect(estimateOsmWorldExtractBytes(0)).toBeLessThan(estimateOsmWorldExtractBytes(6));
    expect(estimateOsmWorldExtractBytes(15)).toBeGreaterThan(estimateOsmWorldExtractBytes(12));
  });

  test("is monotonically increasing across the whole 0-15 range", () => {
    let prev = -Infinity;
    for (let z = 0; z <= 15; z++) {
      const b = estimateOsmWorldExtractBytes(z);
      expect(b).toBeGreaterThan(prev);
      prev = b;
    }
  });
});

describe("estimateOsmWorldRegionBytes (task unqqplrl)", () => {
  const DENMARK = [{ min_lon: 8.0, min_lat: 54.5, max_lon: 13.0, max_lat: 57.8 }];

  test("reproduces the measured Denmark anchors it is built from", () => {
    // The reference box IS the measurement, so it must come back at 1:1 —
    // this is what pins the anchors against `pmtiles extract --dry-run`
    // runs against a real 2026-07-28 build.
    expect(estimateOsmWorldRegionBytes(10, DENMARK)!).toBeCloseTo(22 * 1024 * 1024, -4);
    expect(estimateOsmWorldRegionBytes(12, DENMARK)!).toBeCloseTo(92 * 1024 * 1024, -4);
    expect(estimateOsmWorldRegionBytes(14, DENMARK)!).toBeCloseTo(356 * 1024 * 1024, -4);
  });

  test("a region is orders of magnitude cheaper than the world at the same zoom", () => {
    // The whole reason a region-scoped bake defaults to z12 while the world
    // defaults to z8.
    expect(estimateOsmWorldRegionBytes(12, DENMARK)!).toBeLessThan(
      estimateOsmWorldExtractBytes(12) / 100,
    );
  });

  test("scales with the region's own Mercator area", () => {
    const half = [{ min_lon: 8.0, min_lat: 54.5, max_lon: 10.5, max_lat: 57.8 }];
    const ratio = estimateOsmWorldRegionBytes(12, half)! / estimateOsmWorldRegionBytes(12, DENMARK)!;
    expect(ratio).toBeCloseTo(0.5, 2);
  });

  test("sums several boxes", () => {
    const two = [...DENMARK, { min_lon: 20.0, min_lat: 54.5, max_lon: 25.0, max_lat: 57.8 }];
    expect(estimateOsmWorldRegionBytes(12, two)!).toBeCloseTo(
      2 * estimateOsmWorldRegionBytes(12, DENMARK)!,
      -4,
    );
  });

  test("a country region (no boxes on the wire) reports no estimate at all", () => {
    // Rather than inventing one — the backend resolves the boundary, the
    // client has nothing to size it from.
    expect(estimateOsmWorldRegionBytes(12, [])).toBeNull();
  });
});
