import { describe, expect, test } from "bun:test";
import { formatFactor, scaleBadge, trueScaleDenom } from "./scaleBadge";
import { RENDER_SCALE_DENOM_Z0 } from "../style/expr";

const harbour = [{ scale: 12_000 }, { scale: 90_000 }];

describe("trueScaleDenom", () => {
  test("equator matches the render convention, 60°N is half", () => {
    expect(trueScaleDenom(10, 0)).toBeCloseTo(RENDER_SCALE_DENOM_Z0 / 1024);
    expect(trueScaleDenom(10, 60)).toBeCloseTo(RENDER_SCALE_DENOM_Z0 / 2048);
  });
});

describe("formatFactor", () => {
  test("one decimal below 10, dropped when whole", () => {
    expect(formatFactor(2.43)).toBe("2.4");
    expect(formatFactor(2.98)).toBe("3");
    expect(formatFactor(12.4)).toBe("12");
  });
});

describe("scaleBadge", () => {
  test("no chart here, no badge", () => {
    expect(scaleBadge([], 18, 0)).toBeNull();
  });

  test("overscale is against the FINEST chart, latitude-true", () => {
    // z17 at the equator: display 1:2133 vs 1:12000 → ×5.6.
    const b = scaleBadge(harbour, 17, 0);
    expect(b?.kind).toBe("overscale");
    expect(b?.text).toBe("Overscale ×5.6");
    // Same zoom at 60°N: the picture is twice as large again.
    expect(scaleBadge(harbour, 17, 60)?.text).toBe("Overscale ×11");
  });

  test("just under ×4 says nothing", () => {
    const z = Math.log2((3.9 * RENDER_SCALE_DENOM_Z0) / 12_000);
    expect(scaleBadge(harbour, z, 0)).toBeNull();
    const z4 = Math.log2((4 * RENDER_SCALE_DENOM_Z0) / 12_000);
    expect(scaleBadge(harbour, z4 + 1e-9, 0)?.kind).toBe("overscale");
  });

  test("zoomed out over a harbour chart: nothing (no detail hint)", () => {
    expect(scaleBadge(harbour, 13.9, 0)).toBeNull();
  });

  test("ignores a zero scale", () => {
    expect(scaleBadge([{ scale: 0 }], 18, 0)).toBeNull();
  });
});
