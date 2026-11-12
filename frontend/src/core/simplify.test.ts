import { describe, expect, test } from "bun:test";
import { pathLengthM, simplifyPath, simplifyTrack, trackToleranceM, type LatLon } from "./simplify";

// ~111 m per 0.001° of latitude; at 55°N ~64 m per 0.001° of longitude.
const P = (lat: number, lon: number): LatLon => ({ lat, lon });

describe("simplifyPath", () => {
  test("keeps endpoints; drops points within tolerance of a straight run", () => {
    const line = Array.from({ length: 50 }, (_, i) => P(55 + i * 0.001, 10 + (i % 2) * 0.00005)); // ±3 m wiggle
    const out = simplifyPath(line, 20);
    expect(out).toEqual([line[0]!, line[49]!]);
  });

  test("keeps a corner beyond tolerance", () => {
    const pts = [P(55, 10), P(55.005, 10), P(55.01, 10), P(55.01, 10.01), P(55.01, 10.02)];
    const out = simplifyPath(pts, 20);
    expect(out).toEqual([pts[0]!, pts[2]!, pts[4]!]);
  });

  test("keeps the turning point of an out-and-back (segment, not line, distance)", () => {
    const pts = [P(55, 10), P(55.01, 10), P(55.02, 10), P(55.01, 10), P(55, 10.0001)];
    const out = simplifyPath(pts, 20);
    expect(out).toContain(pts[2]!);
  });

  test("0–2 points pass through", () => {
    expect(simplifyPath([], 20)).toEqual([]);
    expect(simplifyPath([P(1, 1)], 20)).toEqual([P(1, 1)]);
    expect(simplifyPath([P(1, 1), P(2, 2)], 20)).toHaveLength(2);
  });

  test("handles an antimeridian crossing as a short line", () => {
    const pts = [P(0, 179.999), P(0.00001, 180), P(0, -179.999)];
    expect(simplifyPath(pts, 20)).toHaveLength(2);
    expect(pathLengthM(pts)).toBeLessThan(300);
  });

  test("100k points does not overflow the stack", () => {
    const pts = Array.from({ length: 100_000 }, (_, i) => P(55 + Math.sin(i / 50) * 0.01, 10 + i * 0.00001));
    const out = simplifyPath(pts, 25);
    expect(out.length).toBeGreaterThan(2);
    expect(out.length).toBeLessThan(pts.length);
  });
});

describe("trackToleranceM", () => {
  test("clamped between 20 and 50 m, 1/500 of the length between", () => {
    expect(trackToleranceM(0)).toBe(20);
    expect(trackToleranceM(15_000)).toBe(30);
    expect(trackToleranceM(1_000_000)).toBe(50);
  });
});

describe("simplifyTrack", () => {
  test("respects the point budget by raising the tolerance", () => {
    // A zigzag of 2000 legs, 200 m amplitude — every corner matters at 50 m.
    const pts = Array.from({ length: 2001 }, (_, i) => P(55 + (i % 2) * 0.0018, 10 + i * 0.001));
    const { points, toleranceM } = simplifyTrack(pts, 200);
    expect(points.length).toBeLessThanOrEqual(200);
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(toleranceM).toBeGreaterThan(50);
    expect(points[0]).toBe(pts[0]);
    expect(points.at(-1)).toBe(pts.at(-1));
  });

  test("drops consecutive duplicate fixes (a boat at rest)", () => {
    const pts = [P(55, 10), P(55, 10), P(55, 10), P(55.01, 10), P(55.01, 10)];
    expect(simplifyTrack(pts).points).toEqual([P(55, 10), P(55.01, 10)]);
  });

  test("a stationary track collapses to one point", () => {
    expect(simplifyTrack([P(55, 10), P(55, 10)]).points).toHaveLength(1);
  });
});
