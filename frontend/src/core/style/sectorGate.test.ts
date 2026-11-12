import { describe, expect, test } from "bun:test";
import { createPropertyExpression, featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { ChartSet } from "../catalog";
import {
  DEFAULT_SCAMIN_ANCHOR,
  NEUTRAL_SCAMIN_BIAS,
  RENDER_SCALE_DENOM_Z0,
  scaminVisible,
  type ScaminBias,
} from "./expr";
import {
  ARC_RADIUS_REF,
  fadeOpacity,
  fadeOpacityExpr,
  lightHasOwnSymbol,
  lightsOverlayOpacity,
  lightsOverlayVisible,
  RADIUS_MAX,
  RADIUS_MIN,
  radiusForRange,
  RANGE_MAX_NM,
  RANGE_MIN_NM,
  scaminFadeOpacity,
  sectorOverlayBeforeId,
  sectorQueries,
} from "./sectorGate";
import type { ExpressionSpecification } from "maplibre-gl";
import { DEFAULT_SETTINGS } from "./settings";

// chartStyle reads `location.origin` for the tile URLs
(globalThis as { location?: unknown }).location = { origin: "http://localhost" };
const { buildStyle } = await import("./chartStyle");

const withLights: ChartSet = {
  id: "dk",
  name: "Denmark",
  bounds: [8, 54, 13, 58],
  min_zoom: 0,
  max_zoom: 16,
  sequence: 1,
  tiles: "/tiles/dk/{z}/{x}/{y}.pbf",
  vector_layers: [
    { id: "DEPARE", minzoom: 0, maxzoom: 16, fields: {} },
    { id: "LIGHTS", minzoom: 0, maxzoom: 16, fields: {} },
  ],
};
const noLights: ChartSet = {
  ...withLights,
  id: "nolights",
  vector_layers: [{ id: "DEPARE", minzoom: 0, maxzoom: 16, fields: {} }],
};

const queries = (sets: ChartSet[], settings = DEFAULT_SETTINGS) =>
  sectorQueries(buildStyle(sets, settings));

describe("sector-arc source queries", () => {
  test("one per chart set that carries lights, bound to LIGHTS", () => {
    expect(queries([withLights])).toEqual([
      { source: "chart-dk", sourceLayer: "LIGHTS", filter: expect.anything() },
    ]);
  });

  test("a chart set without lights is not queried", () => {
    // querySourceFeatures on an absent source-layer merely returns nothing,
    // but asking walks every loaded tile of that set for no reason
    expect(queries([noLights])).toEqual([]);
  });

  test("every chart set is queried separately", () => {
    expect(queries([withLights, { ...withLights, id: "no" }]).map((q) => q.source)).toEqual([
      "chart-dk",
      "chart-no",
    ]);
  });

  /** Invisible, but tappable: `visibility: "none"` would hide the marker layer
   * from queryRenderedFeatures too, and a sectored light with no adjunct symbol
   * and descriptions off would then have no queryable layer anywhere — its arcs
   * are a custom layer, which queries never see. */
  test("the marker layer is invisible by opacity, not by visibility", () => {
    const marker = buildStyle([withLights], DEFAULT_SETTINGS).layers.find(
      (l) => l.id === "chart-dk-lights-sector",
    )!;
    expect(marker.layout).toEqual({ visibility: "visible" });
    expect("paint" in marker && marker.paint).toEqual({ "circle-radius": 8, "circle-opacity": 0 });
  });

  test("lights off takes the marker layer's tap target with them", () => {
    const off = { ...DEFAULT_SETTINGS, showLights: false };
    const marker = buildStyle([withLights], off).layers.find(
      (l) => l.id === "chart-dk-lights-sector",
    )!;
    expect(marker.layout).toEqual({ visibility: "none" });
  });
});

/**
 * The uniform scamin fade — the ONE rule that used to be a bespoke VALNMR
 * table. A sector arc and the all-round major-light ring are drawn at a
 * constant 20 mm (75.59 px) whatever the scale, so they don't shrink at
 * overview and popping them at a tile boundary is jarring; they fade out over
 * the last band before SCAMIN drops them. The backend bakes the range into the
 * feature's own `scamin` (= SCAMIN_PER_NM · VALNMR), so the fade keys on that
 * one tag like every other gated feature — no VALNMR, no buckets.
 *
 * The fade is SNAPPED to the integer zoom `Zc = ⌈log2(RENDER_SCALE_DENOM_Z0/(scamin·B))⌉`
 * where the tile AND the `scaminVisible` filter drop the feature (both key off
 * the tile's integer zoom): 0 at/below `Zc`, 1 at/above `Zc + FADE_BAND_ZOOMS`,
 * linear between. Snapping the opacity-0 edge onto that integer is what lets the
 * fade FINISH before the feature leaves the data, instead of popping mid-fade
 * when `⌊mapZoom⌋` crosses the integer (the cut-short-fade bug). `FADE_BAND_ZOOMS`
 * is half a zoom (trimmed from the old full-zoom band).
 */
describe("fadeOpacity — the uniform scamin fade", () => {
  // The integer zoom where the tile/filter drop the feature — the fade's 0 edge.
  const zcOf = (scamin: number, B = 1) => Math.ceil(Math.log2(RENDER_SCALE_DENOM_Z0 / (scamin * B)));

  test("gone at/below Zc, full at/above Zc + FADE_BAND_ZOOMS (snapped)", () => {
    const scamin = 300_000; // a 10 nm light: SCAMIN_PER_NM(30000)·10
    const zc = zcOf(scamin); // 10
    expect(fadeOpacity(zc, scamin)).toBe(0); // exactly at the drop boundary
    expect(fadeOpacity(zc - 0.01, scamin)).toBe(0); // and below it
    expect(fadeOpacity(zc + 0.5, scamin)).toBe(1); // fully shown half a zoom in
    expect(fadeOpacity(zc + 3, scamin)).toBe(1);
    // and part-way through inside the half-zoom band
    expect(fadeOpacity(zc + 0.25, scamin)).toBeCloseTo(0.5, 6);
  });

  test("reaches 0 exactly at the integer zoom the tile drops it (pop-free)", () => {
    // The bug: the fade's 0-edge sat at the fractional `scamin·B`, so at the
    // integer `Zc` where `⌊mapZoom⌋` drops the feature the opacity was still
    // nonzero and popped. Snapped, opacity is already 0 at (and below) `Zc`.
    for (const scamin of [45_000, 120_000, 300_000, 900_000]) {
      for (const B of [1, 2, 0.5]) {
        const zc = zcOf(scamin, B);
        // the feature is present in tiles only for integer z >= zc; below it the
        // opacity must be 0 so its disappearance from the data is invisible
        for (let z = zc; z >= zc - 4; z--) expect(fadeOpacity(z, scamin, B)).toBe(0);
        // just above the boundary the fade has begun (not still fully opaque)
        expect(fadeOpacity(zc + 0.25, scamin, B)).toBeGreaterThan(0);
        expect(fadeOpacity(zc + 0.25, scamin, B)).toBeLessThan(1);
      }
    }
  });

  test("a feature with no/invalid scamin never fades (not SCAMIN-gated)", () => {
    for (let z = 0; z <= 20; z += 2) {
      expect(fadeOpacity(z, 0)).toBe(1);
      expect(fadeOpacity(z, Number.NaN)).toBe(1);
      expect(fadeOpacity(z, -5)).toBe(1);
    }
  });

  test("a long-range light (large scamin) lingers where a short-range one is gone", () => {
    const z = 10.3; // an overview, inside the 20 nm light's band, past the 5 nm one
    expect(fadeOpacity(z, 600_000)).toBeGreaterThan(0); // 20 nm light lingers
    expect(fadeOpacity(z, 150_000)).toBe(0); // 5 nm light decluttered
  });

  test("larger scamin is never less visible at a given zoom", () => {
    for (let z = 6; z <= 16; z += 0.5) {
      expect(fadeOpacity(z, 600_000)).toBeGreaterThanOrEqual(fadeOpacity(z, 150_000));
    }
  });

  test("fades across the band rather than popping, monotone in zoom", () => {
    const scamin = 300_000;
    const a = fadeOpacity(zcOf(scamin) + 0.25, scamin); // inside the band
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    for (let z = 9; z < 13; z += 0.05) {
      expect(fadeOpacity(z + 0.05, scamin)).toBeGreaterThanOrEqual(fadeOpacity(z, scamin));
    }
  });

  test("the fade band is FADE_BAND_ZOOMS wide and snapped to integers", () => {
    for (const scamin of [120_000, 270_000, 300_000, 900_000]) {
      const zc = zcOf(scamin);
      expect(Number.isInteger(zc)).toBe(true);
      expect(fadeOpacity(zc, scamin)).toBe(0); // 0-edge on the integer
      expect(fadeOpacity(zc + 0.5, scamin)).toBe(1); // full half a zoom later
    }
  });

  test("chart_detail B shifts the band: B·scamin === fadeOpacity(·, scamin·B)", () => {
    const scamin = 300_000;
    for (let z = 8; z <= 14; z += 0.25) {
      // B=2 keeps the arc a whole band longer — the same curve as a light with
      // twice the scamin at B=1 (more detail: features linger to coarser zoom)
      expect(fadeOpacity(z, scamin, 2)).toBeCloseTo(fadeOpacity(z, scamin * 2, 1), 10);
      // B=0.5 declutters a band sooner
      expect(fadeOpacity(z, scamin, 0.5)).toBeCloseTo(fadeOpacity(z, scamin / 2, 1), 10);
    }
    // at an overview a bigger B keeps the arc where the default has faded out
    expect(fadeOpacity(10, scamin, 4)).toBeGreaterThan(fadeOpacity(10, scamin, 1));
  });
});

/**
 * `fadeOpacityExpr` is the same fade curve as `fadeOpacity`, expressed as a
 * MapLibre paint expression for a JSON layer that cannot use the custom arc
 * layer's per-frame callback. (The all-round range ring used to be exactly
 * that JSON layer; it now draws through the custom layer's own `fadeOpacity`
 * instead, slsynkln — this stays as the general paint-expression form for
 * whichever JSON layer needs it next.) It is a zoom `interpolate` whose
 * per-stop OUTPUT is a per-feature `scamin` function — the only shape
 * MapLibre allows (zoom may only be a top-level interpolate input; the stop
 * inputs must be constant) — so it fades per-feature AND continuously.
 */
describe("fadeOpacityExpr — the JSON ring/paint form", () => {
  const propSpec = {
    type: "number",
    "property-type": "data-driven",
    expression: { interpolated: true, parameters: ["zoom", "feature"] },
  } as const;
  const evalExpr = (chartDetail: number, zoom: number, scamin?: number): number => {
    const r = createPropertyExpression(fadeOpacityExpr(chartDetail), propSpec as never);
    if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
    return r.value.evaluate(
      { zoom } as never,
      { properties: scamin === undefined ? {} : { scamin } } as never,
    ) as number;
  };

  test("it is a valid zoom-and-feature paint expression", () => {
    const r = createPropertyExpression(fadeOpacityExpr(1), propSpec as never);
    expect(r.result).toBe("success");
    // a top-level zoom interpolate, as MapLibre requires
    const expr = fadeOpacityExpr(1);
    expect(expr[0]).toBe("interpolate");
    expect(expr[2]).toEqual(["zoom"]);
  });

  test("matches fadeOpacity exactly at every integer zoom", () => {
    for (const scamin of [120_000, 300_000, 900_000, 45_000]) {
      for (const B of [1, 2, 0.5]) {
        for (let z = 0; z <= 20; z++) {
          expect(evalExpr(B, z, scamin)).toBeCloseTo(fadeOpacity(z, scamin, B), 10);
        }
      }
    }
  });

  test("a feature with no scamin reads full opacity (never fades)", () => {
    for (let z = 0; z <= 20; z += 4) expect(evalExpr(1, z, undefined)).toBe(1);
  });

  test("tracks fadeOpacity between integer zooms exactly", () => {
    // The snapped fade is piecewise-linear with both corners (Zc and Zc+D) ON the
    // half-zoom sample grid, so linear interpolation between samples reproduces it
    // with no error at all — not just within a bucketing tolerance.
    const scamin = 300_000;
    for (let z = 8; z <= 14; z += 0.1) {
      expect(evalExpr(1, z, scamin)).toBeCloseTo(fadeOpacity(z, scamin, 1), 9);
    }
  });

  test("B lifts the whole ring fade toward overview (more detail lingers)", () => {
    const z = 10;
    const scamin = 300_000;
    expect(evalExpr(4, z, scamin)).toBeGreaterThan(evalExpr(1, z, scamin));
  });
});

/**
 * `scaminFadeOpacity` is the general form every SCAMIN-gated chart layer uses so
 * a decluttered feature FADES instead of popping (chartStyle.ts). It folds the
 * layer's own per-feature opacity `base` into the fade and honours the layer's
 * SCAMIN exemption — `fadeOpacityExpr` is this with neither, byte-identical to
 * before. The composition has to keep the `["zoom"]` interpolate top-level
 * (MapLibre forbids it nested in a `*`), so `base` is multiplied INTO each stop.
 */
describe("scaminFadeOpacity — base + exemption folded into the fade", () => {
  const propSpec = {
    type: "number",
    "property-type": "data-driven",
    expression: { interpolated: true, parameters: ["zoom", "feature"] },
  } as const;
  const evalAt = (expr: ExpressionSpecification, zoom: number, props: Record<string, unknown>) => {
    const r = createPropertyExpression(expr, propSpec as never);
    if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
    return r.value.evaluate({ zoom } as never, { properties: props } as never) as number;
  };

  test("no base, no exempt is exactly fadeOpacityExpr", () => {
    expect(scaminFadeOpacity(1)).toEqual(fadeOpacityExpr(1));
    expect(scaminFadeOpacity(2)).toEqual(fadeOpacityExpr(2));
  });

  test("a constant base multiplies through — un-gated stays at base, gated fades from base", () => {
    const wash = scaminFadeOpacity(1, 0.35);
    // no scamin → the fade term saturates to 1, so opacity is exactly the base
    for (let z = 6; z <= 16; z += 2) expect(evalAt(wash, z, {})).toBeCloseTo(0.35, 6);
    // a gated feature fades base→0 across its band (scamin=300000 → Zc=10)
    expect(evalAt(wash, 14, { scamin: 300_000 })).toBeCloseTo(0.35, 6); // above Zc+D: full base
    expect(evalAt(wash, 9, { scamin: 300_000 })).toBeCloseTo(0, 6); // at/below Zc: gone
    const mid = evalAt(wash, 10.25, { scamin: 300_000 }); // inside the half-zoom band
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.35);
  });

  test("a feature-dependent base (a danger/visibility case) fades where the case is on", () => {
    // base = the aidsHazards pattern `["case", <has fill>, 1, 0]`
    const base: ExpressionSpecification = ["case", ["has", "fill"], 1, 0];
    const expr = scaminFadeOpacity(1, base);
    expect(evalAt(expr, 14, { fill: "depit", scamin: 300_000 })).toBeCloseTo(1, 6); // shown, not yet faded
    expect(evalAt(expr, 9, { fill: "depit", scamin: 300_000 })).toBeCloseTo(0, 6); // faded out
    expect(evalAt(expr, 14, { scamin: 300_000 })).toBeCloseTo(0, 6); // no fill → base 0 regardless
  });

  test("an exempt feature never fades — it keeps its base opacity at every scale", () => {
    // exemption = the DISPLAYBASE promotion predicate (safety contour / danger)
    const exempt: ExpressionSpecification = ["==", ["get", "safe"], true];
    const expr = scaminFadeOpacity(1, undefined, exempt);
    // exempt: opacity 1 even at an overview where the scamin band would be gone
    expect(evalAt(expr, 10, { safe: true, scamin: 300_000 })).toBeCloseTo(1, 6);
    // not exempt: the same feature fades on the scamin band as usual
    expect(evalAt(expr, 10, { safe: false, scamin: 300_000 })).toBeCloseTo(0, 6);
    expect(evalAt(expr, 14, { safe: false, scamin: 300_000 })).toBeCloseTo(1, 6);
  });
});

/**
 * The snap — the cut-short-fade fix — pinned on the JSON paint expression the way
 * the map actually evaluates it. The tile AND the `scaminVisible` filter drop a
 * feature at the integer zoom `Zc = ⌈log2(RENDER_SCALE_DENOM_Z0/(scamin·B))⌉`; the fade's
 * opacity-0 edge is snapped ONTO that integer so it finishes before the feature
 * leaves the data. This pins that the expression is 0 at every integer zoom the
 * feature is absent (`z ≤ Zc`), i.e. cannot pop, and reaches full a fixed
 * `FADE_BAND_ZOOMS` later.
 */
describe("scaminFadeOpacity — snapped to the integer drop boundary (pop-free)", () => {
  const propSpec = {
    type: "number",
    "property-type": "data-driven",
    expression: { interpolated: true, parameters: ["zoom", "feature"] },
  } as const;
  const evalAt = (expr: ExpressionSpecification, zoom: number, props: Record<string, unknown>) => {
    const r = createPropertyExpression(expr, propSpec as never);
    if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
    return r.value.evaluate({ zoom } as never, { properties: props } as never) as number;
  };
  const zcOf = (scamin: number, B = 1) => Math.ceil(Math.log2(RENDER_SCALE_DENOM_Z0 / (scamin * B)));

  test("opacity is 0 at every integer zoom the feature is absent from tiles", () => {
    // The tile/filter keep the feature only at integer z >= Zc; the snapped fade
    // must be 0 at and below Zc so its disappearance below Zc is invisible (the
    // pop the old fractional-edge band produced right here).
    for (const scamin of [45_000, 120_000, 300_000, 900_000]) {
      for (const B of [1, 2, 0.5]) {
        const expr = scaminFadeOpacity(B);
        const zc = zcOf(scamin, B);
        for (let z = 4; z <= zc; z++) expect(evalAt(expr, z, { scamin })).toBe(0);
        // and full opacity a fixed half-zoom above the boundary
        expect(evalAt(expr, zc + 0.5, { scamin })).toBeCloseTo(1, 9);
      }
    }
  });

  test("a no-scamin feature stays opacity 1 across the whole sampled range", () => {
    const expr = scaminFadeOpacity(1);
    for (let z = 4; z <= 19; z += 0.5) expect(evalAt(expr, z, {})).toBe(1);
  });
});

/**
 * #kmouwrko: DEPCNT's synthetic `native_scamin` — NOT a mirrored/opposite
 * curve (an earlier attempt built one and the user's review corrected it):
 * DEPCNT declutters "the same way as the others" by falling back to a
 * cell-derived scale-denominator value through the SAME `[Zc, Zc+D]` band as
 * a real `scamin` — fades away zooming OUT below the cell's own native
 * resolution, same as every other SCAMIN-gated feature, no separate mechanism.
 */
describe("scaminFadeOpacity — DEPCNT's synthetic scamin (native_scamin)", () => {
  const propSpec = {
    type: "number",
    "property-type": "data-driven",
    expression: { interpolated: true, parameters: ["zoom", "feature"] },
  } as const;
  const evalAt = (expr: ExpressionSpecification, zoom: number, props: Record<string, unknown>) => {
    const r = createPropertyExpression(expr, propSpec as never);
    if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
    return r.value.evaluate({ zoom } as never, { properties: props } as never) as number;
  };

  test("native_scamin drives the exact same curve a literal scamin of the same value would", () => {
    const expr = scaminFadeOpacity(1);
    for (let z = 4; z <= 19; z += 0.5) {
      expect(evalAt(expr, z, { native_scamin: 300_000 })).toBeCloseTo(
        evalAt(expr, z, { scamin: 300_000 }),
        9,
      );
    }
  });

  test("a charted scamin wins over native_scamin when both are present", () => {
    const expr = scaminFadeOpacity(1);
    // scamin (Zc=10) says "still gone" at z9.5; native_scamin alone (a much
    // smaller value, Zc way below 4) would already read fully opaque there.
    const props = { scamin: 300_000, native_scamin: 1000 };
    expect(evalAt(expr, 9.5, props)).toBeCloseTo(0, 6);
  });

  test("a feature with neither scamin nor native_scamin never fades", () => {
    const expr = scaminFadeOpacity(1);
    for (let z = 4; z <= 19; z += 1) expect(evalAt(expr, z, {})).toBe(1);
  });

  test("an exempt feature (the promoted safety contour) never fades on native_scamin either", () => {
    const exempt: ExpressionSpecification = ["==", ["get", "safe"], true];
    const expr = scaminFadeOpacity(1, undefined, exempt);
    const props = { native_scamin: 300_000, safe: true };
    expect(evalAt(expr, 4, props)).toBeCloseTo(1, 6); // well below Zc, still exempt
  });
});

describe("the gate the style hands the arcs", () => {
  /** The bug this exists for: the custom layer renders outside the style, so
   * it drew arcs for lights the style had already dropped. At overview scale
   * the backend merges underscaled harbour cells into the tile, and arcs are
   * constant screen size — dozens stacked into an unreadable rosette. The
   * gate has to be the style's, not a zoom rule invented in the layer.
   *
   * rkmzlpxy widened this from sectored-only (`lit_arc`) to every light, so
   * the marker layer (and so this query) must see every light — including
   * ones the overlay itself now skips (`lightHasOwnSymbol`, slsynkln) —
   * since it also serves as the info panel's tap target (aidsHazards.ts):
   * only the SCAMIN gate and the point-geometry guard remain. */
  test("every light, and only within SCAMIN", () => {
    expect(queries([withLights])[0].filter).toEqual([
      "all",
      scaminVisible(),
      ["==", ["geometry-type"], "Point"],
    ]);
  });

  /** Arcs/dots and their light's other symbols (description text, sym_extra
   * adjunct) must never disagree about SCAMIN: one is an annotation of the
   * other. Both gates come out of the same `add`. */
  test("it is the same gate the light's other symbols get", () => {
    const style = buildStyle([withLights], DEFAULT_SETTINGS);
    const extra = style.layers.find((l) => l.id === "chart-dk-lights-extra")!;
    const extraGate = (extra as { filter: unknown[] }).filter[1];
    const markerFilter = sectorQueries(style)[0].filter as unknown[];
    expect(markerFilter[1]).toEqual(extraGate);
  });
});

/**
 * The chart-detail bias B multiplies scamin everywhere the client compares
 * scale to scamin — the overzoom gate included — so the render-time gate agrees
 * with the server's own `scale_denom(z) <= scamin·B` hard-drop boundary.
 */
describe("scaminVisible — the B-biased overzoom gate", () => {
  test("B === 1 is the bare scamin comparison (style stays byte-identical)", () => {
    expect(scaminVisible(1)).toEqual([
      "any",
      ["!", ["has", "scamin"]],
      ["<=", ["/", RENDER_SCALE_DENOM_Z0, ["^", 2, ["zoom"]]], ["get", "scamin"]],
    ]);
    expect(scaminVisible()).toEqual(scaminVisible(1));
  });

  test("B !== 1 multiplies scamin by B", () => {
    expect(scaminVisible(2)).toEqual([
      "any",
      ["!", ["has", "scamin"]],
      ["<=", ["/", RENDER_SCALE_DENOM_Z0, ["^", 2, ["zoom"]]], ["*", ["get", "scamin"], 2]],
    ]);
  });

  test("the built style threads chartDetail into every layer's gate", () => {
    const style = buildStyle([withLights], DEFAULT_SETTINGS, { chartDetail: 2 });
    const extra = style.layers.find((l) => l.id === "chart-dk-lights-extra") as { filter: unknown[] };
    expect(extra.filter[1]).toEqual(scaminVisible(2));
  });
});

/**
 * The SPREAD `k` must reach the FADE too, not just the filter (#qqlzrkkn).
 *
 * The fade's whole job is to finish exactly where the hard gate drops the
 * feature (the cut-short-fade fix above). Warping only the filter would move
 * that boundary and leave the fade completing at the un-warped zoom — i.e.
 * reintroduce the very pop the snap exists to remove — so this pins the two
 * together under a non-neutral `k` rather than pinning either alone.
 */
describe("the spread k reaches the fade as well as the filter", () => {
  const propSpec = {
    type: "number",
    "property-type": "data-driven",
    expression: { interpolated: true, parameters: ["zoom", "feature"] },
  } as const;
  const evalAt = (expr: ExpressionSpecification, zoom: number, props: Record<string, unknown>) => {
    const r = createPropertyExpression(expr, propSpec as never);
    if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
    return r.value.evaluate({ zoom } as never, { properties: props } as never) as number;
  };
  const shows = (scamin: number, zoom: number, bias: ScaminBias) =>
    featureFilter(scaminVisible(bias)).filter(
      { zoom } as never,
      { type: 1, properties: { scamin } } as never,
      undefined as never,
    );
  const half: ScaminBias = { detail: 1, spread: 0.5, anchor: DEFAULT_SCAMIN_ANCHOR };

  test("k = 1 leaves the fade expression byte-identical", () => {
    expect(scaminFadeOpacity(NEUTRAL_SCAMIN_BIAS)).toEqual(scaminFadeOpacity(1));
    expect(scaminFadeOpacity({ ...NEUTRAL_SCAMIN_BIAS, detail: 2 })).toEqual(scaminFadeOpacity(2));
  });

  test("the paint expression still matches the scalar fadeOpacity under a spread", () => {
    for (const scamin of [11_999, 45_000, 89_999, 350_000]) {
      for (let z = 4; z <= 19; z++) {
        expect(evalAt(scaminFadeOpacity(half), z, { scamin })).toBeCloseTo(
          fadeOpacity(z, scamin, half),
          10,
        );
      }
    }
  });

  test("the fade is still 0 wherever the warped filter hides the feature", () => {
    for (const scamin of [11_999, 21_999, 45_000, 89_999, 350_000]) {
      for (let z = 5; z <= 18; z++) {
        if (!shows(scamin, z, half)) {
          expect(evalAt(scaminFadeOpacity(half), z, { scamin })).toBeCloseTo(0, 6);
        }
      }
    }
  });
});

/**
 * tpkonpry: the sector arc used to draw at a flat ARC_RADIUS (75.59 px,
 * 20 mm) regardless of the light's own range. `radiusForRange` replaces that
 * with a log-scaled mapping off VALNMR (chartcore's `lit_range` attribute on
 * the arc feature) — still a constant SCREEN size per light (no zoom-scaling,
 * per the module comment's DECIDED note), just no longer the SAME size for
 * every light.
 */
describe("radiusForRange — VALNMR-scaled arc radius", () => {
  test("clamps to [RADIUS_MIN, RADIUS_MAX] at the domain edges", () => {
    expect(radiusForRange(RANGE_MIN_NM)).toBeCloseTo(RADIUS_MIN, 6);
    expect(radiusForRange(RANGE_MAX_NM)).toBeCloseTo(RADIUS_MAX, 6);
  });

  test("out-of-domain VALNMR is clamped to the same edges (no server-side clamp anymore)", () => {
    expect(radiusForRange(0)).toBeCloseTo(RADIUS_MIN, 6);
    expect(radiusForRange(1)).toBeCloseTo(RADIUS_MIN, 6);
    expect(radiusForRange(50)).toBeCloseTo(RADIUS_MAX, 6);
    expect(radiusForRange(1000)).toBeCloseTo(RADIUS_MAX, 6);
  });

  test("monotonically increasing across the domain — a longer-range light never draws smaller", () => {
    let prev = radiusForRange(RANGE_MIN_NM);
    for (let v = RANGE_MIN_NM + 1; v <= RANGE_MAX_NM; v++) {
      const r = radiusForRange(v);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  test("log-scaled, not linear: an equal-width nm step covers more px near RANGE_MIN_NM than near RANGE_MAX_NM", () => {
    const lowStep = radiusForRange(10) - radiusForRange(4); // 6 nm, low end
    const highStep = radiusForRange(30) - radiusForRange(24); // 6 nm, high end
    expect(lowStep).toBeGreaterThan(highStep);
  });

  test("falls back to the reference's flat ARC_RADIUS_REF when VALNMR is missing or invalid", () => {
    for (const bad of [undefined, null, "22", Number.NaN]) {
      expect(radiusForRange(bad)).toBe(ARC_RADIUS_REF);
    }
  });

  test("the reference's old flat radius falls within the new range (no jump for a typical light)", () => {
    expect(ARC_RADIUS_REF).toBeGreaterThan(RADIUS_MIN);
    expect(ARC_RADIUS_REF).toBeLessThan(RADIUS_MAX);
  });
});

describe("lightHasOwnSymbol — the split between the style's own icon and the overlay", () => {
  test("a baked sym (flare/QUESMRK1) draws its own icon, not the overlay", () => {
    expect(lightHasOwnSymbol({ sym: "LIGHTS11" })).toBe(true);
    expect(lightHasOwnSymbol({ sym: "QUESMRK1", SECTR1: 10, SECTR2: 20 })).toBe(true);
  });

  test("no sym (a real sector, or the sym-less ring-only major light) is the overlay's", () => {
    expect(lightHasOwnSymbol({})).toBe(false);
    expect(lightHasOwnSymbol({ SECTR1: 10, SECTR2: 20 })).toBe(false);
    expect(lightHasOwnSymbol({ sym: "" })).toBe(false); // empty string, not a real value
    expect(lightHasOwnSymbol({ sym: 42 })).toBe(false); // wrong type, never baked but guarded anyway
  });
});

describe("the lights overlay follows the 'Aids & lights' ENC group, not just showLights", () => {
  // The group's own docs (./encGroups.ts) count "LIGHTS (incl. the sector-arc
  // gate + all-round ring)" as aids, but `applyEncGroup`'s visibility/opacity
  // only reach layers in the generated style — and the overlay is a custom
  // WebGL layer reading `querySourceFeatures` off the SOURCE, so it never saw
  // them. Turning the group off left sectors and range rings drawing over an
  // otherwise-empty chart (wxpkzqqq).
  const settings = (showLights: boolean, visible: boolean, opacity = 1) => ({
    ...DEFAULT_SETTINGS,
    showLights,
    encGroups: { ...DEFAULT_SETTINGS.encGroups, aids: { visible, opacity } },
  });

  test("defaults draw it — both controls start on", () => {
    expect(lightsOverlayVisible(DEFAULT_SETTINGS)).toBe(true);
    expect(lightsOverlayOpacity(DEFAULT_SETTINGS)).toBe(1);
  });

  test("either control alone takes the annotation away", () => {
    expect(lightsOverlayVisible(settings(true, true))).toBe(true);
    expect(lightsOverlayVisible(settings(false, true))).toBe(false);
    expect(lightsOverlayVisible(settings(true, false))).toBe(false);
    expect(lightsOverlayVisible(settings(false, false))).toBe(false);
  });

  test("the group's opacity is the overlay's dimming multiplier", () => {
    expect(lightsOverlayOpacity(settings(true, true, 0.4))).toBe(0.4);
    expect(lightsOverlayVisible(settings(true, true, 0.4))).toBe(true);
  });

  test("opacity 0 counts as OFF, so the overlay stops re-querying rather than drawing at alpha 0", () => {
    expect(lightsOverlayVisible(settings(true, true, 0))).toBe(false);
  });

  test("an out-of-range or missing opacity falls back to fully drawn, never to invisible", () => {
    const bad = (o: unknown) =>
      lightsOverlayOpacity({ encGroups: { aids: { opacity: o as number } } });
    for (const o of [undefined, null, "0.5", NaN, -1, 2]) expect(bad(o)).toBe(1);
  });
});

describe("sectorOverlayBeforeId — the overlay follows the group's STACK POSITION too", () => {
  // wxpkzqqq wired visibility and opacity and left the arcs pinned on top,
  // reasoning that following the order would let POI and satellite draw over a
  // light sector. USER DECISION 2026-07-29 overrode that: the arcs follow the
  // aids group's place in the stack, wherever the Layers panel puts it.
  const AIDS = ["chart-dk-aton", "chart-dk-lights", "chart-dk-lights-sym"];
  // What MapView passes: the overlay's OWN layer ids, nothing else.
  const SELF = ["sector-lights"];

  test("seats the overlay directly above the group's topmost layer", () => {
    const style = ["chart-dk-depare", ...AIDS, "openseamap", "sector-lights"];
    expect(sectorOverlayBeforeId(style, AIDS, SELF)).toBe("openseamap");
  });

  test("the group's own order inside the block does not matter — only its top", () => {
    const style = ["chart-dk-depare", "chart-dk-lights", "chart-dk-aton", "openseamap"];
    expect(sectorOverlayBeforeId(style, AIDS, SELF)).toBe("openseamap");
  });

  // IDEMPOTENCE — the property the whole seating pass rests on, since it re-runs
  // after every style application and every panel drag. Once seated, the layer
  // directly above the aids block IS the overlay; without the self-skip the
  // answer would be `moveLayer(x, x)`, which is not a position.
  test("re-seating an already-seated layer gives the same answer, not itself", () => {
    const fresh = ["chart-dk-depare", ...AIDS, "openseamap"];
    const seated = ["chart-dk-depare", ...AIDS, "sector-lights", "openseamap"];
    expect(sectorOverlayBeforeId(fresh, AIDS, SELF)).toBe("openseamap");
    expect(sectorOverlayBeforeId(seated, AIDS, SELF)).toBe("openseamap");
  });

  // The weather wash is NOT skipped, deliberately — see the function's own doc
  // comment. It opts out of the safety hoist and inserts itself
  // `beforeId:"openseamap"`, i.e. directly above the chart block, so it is a
  // legitimate neighbour: the Layers panel lists "Weather" above "Aids & lights",
  // the wash already covers every aid symbol the arcs annotate, and a
  // forecast-hour change re-adds the wash WITHOUT a re-seat — so preferring
  // `openseamap` here would put the arcs above the wash until the first slider
  // move and below it after. Under it, consistently, is the stable answer.
  test("the weather wash is a legitimate neighbour: the arcs ride under it, stably", () => {
    const style = ["chart-dk-depare", ...AIDS, "weather-wash", "wind-flow", "openseamap"];
    expect(sectorOverlayBeforeId(style, AIDS, SELF)).toBe("weather-wash");
    // ...and the answer does not change once the layer has been seated there.
    const seated = ["chart-dk-depare", ...AIDS, "sector-lights", "weather-wash", "openseamap"];
    expect(sectorOverlayBeforeId(seated, AIDS, SELF)).toBe("weather-wash");
  });

  test("no chart set loaded (no aids layers) leaves it topmost — it draws nothing then", () => {
    expect(sectorOverlayBeforeId(["osm-land", "openseamap"], [], SELF)).toBeUndefined();
  });

  test("the group at the very top of the live stack also means topmost", () => {
    expect(sectorOverlayBeforeId(["chart-dk-depare", ...AIDS], AIDS, SELF)).toBeUndefined();
    // Already seated on top: still topmost, not a self-move.
    const seated = ["chart-dk-depare", ...AIDS, "sector-lights"];
    expect(sectorOverlayBeforeId(seated, AIDS, SELF)).toBeUndefined();
  });

  test("a panel drag that sinks the group sinks the arcs with it", () => {
    // "Aids & lights" dragged below the soundings/depths blocks: the answer
    // tracks the group's new neighbours rather than staying at the top.
    const style = [...AIDS, "chart-dk-soundg", "chart-dk-depcnt", "openseamap"];
    expect(sectorOverlayBeforeId(style, AIDS, SELF)).toBe("chart-dk-soundg");
  });
});
