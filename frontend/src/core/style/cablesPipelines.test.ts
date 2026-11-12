import { describe, expect, test } from "bun:test";
import { createPropertyExpression } from "@maplibre/maplibre-gl-style-spec";
import { cablesPipelinesLineLayers, PATTERN_BAND_PX } from "./cablesPipelines";
import { paletteColors, s52ColourToHex } from "./colors";
import type { AddLayer, ChartLayer } from "./expr";
import { DEFAULT_SETTINGS } from "./settings";

// nsplrzus: CBLSUB/PIPSOL's `LC(...)` rows now draw the vendored
// cable.svg/pipeline.svg line-pattern tiles instead of a plain dash —
// CBLOHD/PIPOHD (never an LC row) and CBLSUB's own CATCBL=6 power-line row
// (also never an LC row, despite the class) are unaffected.

function layersFor(sourceLayer: string): ChartLayer[] {
  const layers: ChartLayer[] = [];
  const add: AddLayer = (_prio, sl, l) => {
    if (sl === sourceLayer) layers.push(l);
  };
  cablesPipelinesLineLayers(add, "chart", DEFAULT_SETTINGS);
  return layers;
}

const patternSpec = {
  type: "string",
  "property-type": "data-driven",
  expression: { interpolated: false, parameters: ["zoom", "feature"] },
} as const;

function evalPattern(expr: unknown, props: Record<string, unknown>): string {
  const r = createPropertyExpression(expr as never, patternSpec as never);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  return r.value.evaluate({ zoom: 12 } as never, { properties: props } as never) as unknown as string;
}

const C = paletteColors(DEFAULT_SETTINGS.palette);
const chgrdHex = s52ColourToHex(C.CHGRD);
const chmgdHex = s52ColourToHex(C.CHMGD);

describe("CBLSUB: pattern where lc is baked, plain dash where it isn't", () => {
  test("emits exactly two layers: line-pattern and line-dash", () => {
    const layers = layersFor("CBLSUB");
    expect(layers.map((l) => l.id)).toEqual(["chart-cblsub-line-pattern", "chart-cblsub-line-dash"]);
  });

  test("the pattern layer filters on has(lc) and requests cable,<CHMGD hex>", () => {
    const [pattern] = layersFor("CBLSUB");
    expect(pattern.filter).toEqual(["all", ["==", ["geometry-type"], "LineString"], ["has", "lc"]]);
    expect(evalPattern(pattern.paint!["line-pattern"], { bcol: "CHMGD" })).toBe(`cable,${chmgdHex}`);
  });

  test("the dash layer filters on !has(lc) (the CATCBL=6 power-line row) and keeps the old dasharray", () => {
    const [, dash] = layersFor("CBLSUB");
    expect(dash.filter).toEqual([
      "all",
      ["==", ["geometry-type"], "LineString"],
      ["!", ["has", "lc"]],
    ]);
    expect(dash.paint!["line-dasharray"]).toEqual([3, 1]);
    expect(dash.paint!["line-pattern"]).toBeUndefined();
  });
});

describe("PIPSOL: pattern colour follows bcol exactly like line-color already does", () => {
  test("emits a pattern layer (lc is unconditional for PIPSOL) plus the always-unreachable dash layer", () => {
    const layers = layersFor("PIPSOL");
    expect(layers.map((l) => l.id)).toEqual(["chart-pipsol-line-pattern", "chart-pipsol-line-dash"]);
  });

  test("CHGRD (benign product) resolves to pipeline,<CHGRD hex>; anything else to CHMGD's", () => {
    const [pattern] = layersFor("PIPSOL");
    expect(evalPattern(pattern.paint!["line-pattern"], { bcol: "CHGRD" })).toBe(`pipeline,${chgrdHex}`);
    expect(evalPattern(pattern.paint!["line-pattern"], { bcol: "CHMGD" })).toBe(`pipeline,${chmgdHex}`);
  });
});

// qsmmskwp: `line-width` on a line-pattern layer is the pattern's band HEIGHT
// (MapLibre scales the image so its height matches the line width), not a pen
// width. It used to be `bwid` — S-52's `SW1`, i.e. 1 — which squeezed the
// whole 14.645x4 strip into a 3.7px repeat. Both pattern classes are pinned
// together here so a future edit can't fix one and orphan the other.
describe("pattern band height is the pattern's own scale knob, never bwid", () => {
  test.each(["CBLSUB", "PIPSOL"] as const)("%s's pattern layer sizes the band, not the pen", (cls) => {
    const [pattern] = layersFor(cls);
    expect(pattern.paint!["line-width"]).toBe(PATTERN_BAND_PX);
    expect(PATTERN_BAND_PX).toBeGreaterThan(1);
  });

  test.each(["CBLSUB", "PIPSOL", "CBLOHD", "PIPOHD"] as const)(
    "%s's plain-dash/plain layer still takes its width from bwid",
    (cls) => {
      const layers = layersFor(cls);
      const plain = layers.find((l) => l.paint!["line-pattern"] === undefined)!;
      expect(plain.paint!["line-width"]).toEqual(["coalesce", ["get", "bwid"], 1]);
    },
  );
});

describe("CBLOHD/PIPOHD: never an LC row, so unaffected — single plain layer, no line-pattern", () => {
  test.each(["CBLOHD", "PIPOHD"] as const)("%s emits exactly one layer with no line-pattern key", (cls) => {
    const layers = layersFor(cls);
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBe(`chart-${cls.toLowerCase()}-line`);
    expect(layers[0].paint).not.toHaveProperty("line-pattern");
    expect(layers[0].filter).toEqual(["==", ["geometry-type"], "LineString"]);
  });
});
