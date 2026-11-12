import { describe, expect, test } from "bun:test";
import {
  boundsContain,
  formatDeg,
  graticuleLabels,
  graticuleLines,
  gridStep,
  gridValues,
  padBounds,
} from "./graticule";

describe("gridStep", () => {
  test("picks a coarse step for a wide view and a fine one for a narrow view", () => {
    expect(gridStep(90)).toBe(30); // whole ocean → 30°
    expect(gridStep(3)).toBe(0.5); // ~3° span → 30′ lines (6 across)
    expect(gridStep(0.3)).toBe(5 / 60); // ~18′ span → 5′ lines
  });

  test("keeps the line count at or under the target", () => {
    for (const span of [90, 40, 8, 3, 0.5, 0.05]) {
      expect(span / gridStep(span)).toBeLessThanOrEqual(8 + 1e-9);
    }
  });
});

describe("formatDeg", () => {
  test("whole-degree grid shows no minutes", () => {
    expect(formatDeg(56, "lat", 1)).toBe("56° N");
    expect(formatDeg(-3, "lon", 1)).toBe("3° W");
  });

  test("arc-minute grid shows minutes, hemisphere by sign", () => {
    expect(formatDeg(56.5, "lat", 30 / 60)).toBe("56°30′ N");
    expect(formatDeg(11.25, "lon", 15 / 60)).toBe("11°15′ E");
    expect(formatDeg(-11.25, "lon", 15 / 60)).toBe("11°15′ W");
  });

  test("arc-second grid shows seconds", () => {
    expect(formatDeg(56 + 30 / 60 + 15 / 3600, "lat", 15 / 3600)).toBe("56°30′15″ N");
  });
});

describe("gridValues", () => {
  const bounds = { west: 10, east: 12, south: 54, north: 56 };

  test("snaps to multiples of the step, inclusive of both edges", () => {
    expect(gridValues(bounds, 1).lons).toEqual([10, 11, 12]);
    expect(gridValues(bounds, 1).lats).toEqual([54, 55, 56]);
  });

  test("clamps latitude to the mercator-safe range", () => {
    const { lats } = gridValues({ west: 0, east: 10, south: -90, north: 90 }, 30);
    for (const lat of lats) {
      expect(lat).toBeGreaterThanOrEqual(-85);
      expect(lat).toBeLessThanOrEqual(85);
    }
  });
});

describe("graticuleLines", () => {
  const bounds = { west: 10, east: 12, south: 54, north: 56 };

  test("one MultiLineString per orientation, not one feature per line", () => {
    const g = graticuleLines(gridValues(bounds, 1));
    expect(g.features).toHaveLength(2);
    expect(g.features.map((f) => f.properties.kind)).toEqual(["meridian", "parallel"]);
    expect(g.features.every((f) => f.geometry.type === "MultiLineString")).toBe(true);
    expect(g.features[0]!.geometry.coordinates).toHaveLength(3); // lon 10, 11, 12
  });

  // THE POINT OF THE WHOLE SPLIT: nothing in the line geometry depends on the
  // view, so panning inside the envelope cannot invalidate it.
  test("lines run the full extent, never clipped to the bounds they came from", () => {
    const g = graticuleLines(gridValues(bounds, 1));
    const [meridians, parallels] = g.features;
    for (const seg of meridians!.geometry.coordinates) {
      expect(seg.map(([, lat]) => lat)).toEqual([-85, 85]);
    }
    for (const seg of parallels!.geometry.coordinates) {
      expect(seg.map(([lon]) => lon)).toEqual([-180, 180]);
    }
  });

  test("emits no empty feature when an orientation has no lines", () => {
    const g = graticuleLines({ lons: [], lats: [55] });
    expect(g.features.map((f) => f.properties.kind)).toEqual(["parallel"]);
  });
});

describe("graticuleLabels", () => {
  const bounds = { west: 10, east: 12, south: 54, north: 56 };

  test("a label per line, at the view's north edge / west edge", () => {
    const g = graticuleLabels(bounds, 1);
    expect(g.features).toHaveLength(6);
    expect(g.features.every((f) => typeof f.properties.label === "string")).toBe(true);
    const meridian = g.features.find((f) => f.properties.kind === "meridian")!;
    expect(meridian.geometry.coordinates[1]).toBe(56); // north edge
    const parallel = g.features.find((f) => f.properties.kind === "parallel")!;
    expect(parallel.geometry.coordinates[0]).toBe(10); // west edge
  });
});

describe("padBounds / boundsContain", () => {
  const bounds = { west: 10, east: 12, south: 54, north: 56 };

  test("a pad of 1 gives a whole view-span of slack in every direction", () => {
    expect(padBounds(bounds, 1)).toEqual({ west: 8, east: 14, south: 52, north: 58 });
  });

  test("the envelope contains the view it was built for, and near pans of it", () => {
    const envelope = padBounds(bounds, 1);
    expect(boundsContain(envelope, bounds)).toBe(true);
    // a pan of half a view span stays inside → no rebuild
    expect(boundsContain(envelope, { west: 11, east: 13, south: 55, north: 57 })).toBe(true);
    // a pan of a full span and a bit escapes → rebuild
    expect(boundsContain(envelope, { west: 12.5, east: 14.5, south: 54, north: 56 })).toBe(false);
  });

  test("a pole-saturated envelope still contains a view that runs past the limit", () => {
    const polar = { west: 0, east: 10, south: 80, north: 90 };
    expect(boundsContain(padBounds(polar, 1), polar)).toBe(true);
  });
});
