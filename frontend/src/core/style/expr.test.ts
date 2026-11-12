/**
 * `soundingText` — the traditional paper-chart sounding format: metres plus a
 * Unicode subscript decimetre digit, no decimal point. Evaluated as a real
 * MapLibre expression (not just tree-shape asserted), same pattern as
 * sectorGate.test.ts, so a mistake in the `match`/`concat` shape fails here
 * rather than on the chart.
 */
import { describe, expect, test } from "bun:test";
import { createPropertyExpression, featureFilter } from "@maplibre/maplibre-gl-style-spec";
import {
  DEFAULT_SCAMIN_ANCHOR,
  effectiveScamin,
  NEUTRAL_SCAMIN_BIAS,
  RENDER_SCALE_DENOM_Z0,
  SCALE_DENOM_Z0,
  scaminVisible,
  soundingText,
  type ScaminBias,
} from "./expr";

const propSpec = {
  type: "string",
  "property-type": "data-driven",
  expression: { interpolated: false, parameters: ["zoom", "feature"] },
} as const;

function evalText(depth: number): string {
  const expr = soundingText(["get", "DEPTH"]);
  const r = createPropertyExpression(expr, propSpec as never);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  return r.value.evaluate({ zoom: 10 } as never, { properties: { DEPTH: depth } } as never) as string;
}

describe("soundingText", () => {
  test("metres plus a Unicode subscript digit, no decimal point", () => {
    expect(evalText(5.3)).toBe("5₃");
    expect(evalText(14.4)).toBe("14₄");
    expect(evalText(0.9)).toBe("0₉");
  });

  test("every nonzero subscript digit 1-9 maps to its own Unicode codepoint", () => {
    // d=0 is covered by "a whole-metre depth has no fraction" below: a zero
    // fraction falls through to metres-only, by design.
    const digits = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
    for (let d = 1; d <= 9; d++) {
      expect(evalText(1 + d / 10)).toBe(`1${digits[d]}`);
    }
  });

  test("a whole-metre depth has no fraction", () => {
    expect(evalText(5)).toBe("5");
  });

  test("metres-only at and beyond the 31 m threshold", () => {
    expect(evalText(30.9)).toBe("30₉");
    expect(evalText(31.4)).toBe("31");
  });

  test("rounds rather than truncates (5.96 -> 6, not 5.9)", () => {
    expect(evalText(5.96)).toBe("6");
  });

  test("drying heights (negative depth) use the magnitude", () => {
    expect(evalText(-2.5)).toBe("2₅");
  });
});

/**
 * `scaminVisible` — BEHAVIOUR at named zooms, not the shape of the expression
 * (#kyxkoonq). The SCAMIN values are the real distribution measured on the
 * US5OAKIQ fixture with `ogrinfo` (94x 17999, 85x 21999, 75x 29999, 24x 44999)
 * plus the two synthetic defaults chartcore's derive pass invents
 * (DEFAULT_POINT_SCAMIN 45000, DEFAULT_AREA_SYMBOL_SCAMIN 350000).
 *
 * These numbers must equal chartcore's `scamin_turn_on_zooms_on_real_chart_values`
 * exactly: the server DROPS a hidden feature off the tile, so if the two gates
 * ever disagree the mariner gets a seam — either a feature the client would show
 * that is not on the wire, or one on the wire the client refuses to draw.
 *
 * Every case used to turn on one zoom later, because the gate compared against
 * the 256 px pyramid denominator while MapLibre draws vector tiles at 512 CSS
 * px. The bulk of that cell only lit at z15.
 */
describe("scaminVisible — turn-on zooms on real chart values", () => {
  // A real MapLibre FILTER, the way the map evaluates it: `["zoom"]` inside a
  // filter is legal (and is the tile's integer overscaledZ), but it is illegal
  // in a paint property, so `createPropertyExpression` is the wrong door here.
  const shows = (props: Record<string, unknown>, zoom: number, B = 1) =>
    featureFilter(scaminVisible(B)).filter(
      { zoom } as never,
      { type: 1, properties: props } as never,
      undefined as never,
    );

  // [scamin, last zoom HIDDEN, first zoom SHOWN]
  const cases: [number, number, number][] = [
    [17_999, 13, 14],
    [21_999, 13, 14],
    [29_999, 13, 14],
    [44_999, 12, 13],
    [45_000, 12, 13],
    [350_000, 9, 10],
  ];

  test.each(cases)("scamin %i: hidden at z%i, visible at z%i", (scamin, hidden, shown) => {
    expect(shows({ scamin }, hidden)).toBe(false);
    expect(shows({ scamin }, shown)).toBe(true);
  });

  test("a feature with no scamin shows at every zoom", () => {
    for (let z = 0; z <= 18; z++) expect(shows({}, z)).toBe(true);
  });

  test("chart_detail is still the lever for showing even earlier", () => {
    // B = 2 buys exactly one more zoom on every value — the residual knob for a
    // phone viewport, which no device-independent shift can reach.
    for (const [scamin, hidden] of cases) {
      expect(shows({ scamin }, hidden)).toBe(false);
      expect(shows({ scamin }, hidden, 2)).toBe(true);
    }
  });

  test("the render denominator is exactly half the pyramid one (a uniform shift)", () => {
    // Mirrors chartcore's RENDER_SCALE_DENOM_Z0; a uniform one-zoom offset
    // preserves the cartographer's relative SCAMIN ordering, which a non-linear
    // warp would not.
    expect(RENDER_SCALE_DENOM_Z0).toBe(279_541_132);
    expect(RENDER_SCALE_DENOM_Z0 * 2).toBe(SCALE_DENOM_Z0);
  });
});

/**
 * The turn-on SPREAD `k` (#qqlzrkkn), as BEHAVIOUR at named zooms.
 *
 * These numbers must equal chartcore's
 * `spread_compresses_the_turn_on_range_toward_the_anchor` exactly, for the same
 * reason the block above must match its sibling: the server DROPS by this rule,
 * so any disagreement is a seam. The left column is the real fnc-de
 * CBLSUB/WRECKS distribution the "submarine cables arrive too late" report is
 * about.
 */
describe("scaminVisible — the turn-on spread k", () => {
  const shows = (scamin: number, zoom: number, bias: ScaminBias | number = 1) =>
    featureFilter(scaminVisible(bias)).filter(
      { zoom } as never,
      { type: 1, properties: { scamin } } as never,
      undefined as never,
    );
  const half: ScaminBias = { detail: 1, spread: 0.5, anchor: DEFAULT_SCAMIN_ANCHOR };

  // [scamin, first zoom shown at k = 1, first zoom shown at k = 0.5]
  const cases: [number, number, number][] = [
    [350_000, 10, 10], // the anchor itself: unmoved
    [89_999, 12, 11], // fnc-de CBLSUB median
    [45_000, 13, 12], // DEFAULT_POINT_SCAMIN (DE WRECKS, 2423 of 2430)
    [21_999, 14, 12],
    [11_999, 15, 13], // fnc-de CBLSUB tail
  ];

  test.each(cases)("scamin %i turns on at z%i, and at z%i under k=0.5", (scamin, plain, k) => {
    expect(shows(scamin, plain - 1)).toBe(false);
    expect(shows(scamin, plain)).toBe(true);
    expect(shows(scamin, k - 1, half)).toBe(false);
    expect(shows(scamin, k, half)).toBe(true);
  });

  test("k = 1 is exactly the un-spread expression, and a bare number is B alone", () => {
    expect(scaminVisible(NEUTRAL_SCAMIN_BIAS)).toEqual(scaminVisible(1));
    expect(scaminVisible({ ...NEUTRAL_SCAMIN_BIAS, detail: 2 })).toEqual(scaminVisible(2));
  });

  test("effectiveScamin mirrors chartcore, exactly at the neutral spread", () => {
    // The `spread === 1` short-circuit is load-bearing: `A·(S/A)^1` would not
    // round-trip these bit-for-bit through `Math.pow`, and the tiles would stop
    // being byte-identical at the default.
    for (const s of [1, 17_999, 21_999, 29_999, 44_999, 89_999, 350_000, 999_999]) {
      expect(effectiveScamin(s, NEUTRAL_SCAMIN_BIAS)).toBe(s);
      expect(effectiveScamin(s, { ...NEUTRAL_SCAMIN_BIAS, detail: 1.7 })).toBe(s * 1.7);
    }
  });

  test("the spread is monotonic, so it never reorders two features", () => {
    for (const spread of [0.1, 0.25, 0.5, 0.9, 1, 1.5, 2]) {
      let prev = 0;
      for (const s of [999, 11_999, 21_999, 45_000, 89_999, 350_000, 1_500_000]) {
        const e = effectiveScamin(s, { ...NEUTRAL_SCAMIN_BIAS, spread });
        expect(e).toBeGreaterThan(prev);
        prev = e;
      }
    }
  });
});
