import { describe, expect, test } from "bun:test";
import { createPropertyExpression } from "@maplibre/maplibre-gl-style-spec";
import { PALETTES, paletteColors, s52ColourToHex } from "./colors";
import { trafficRoutesSymbolLayers } from "./trafficRoutes";
import type { AddLayer, ChartLayer } from "./expr";
import { DEFAULT_SETTINGS, type ChartSettings } from "./settings";

// yxnrrtwk: TSSLPT's `sym` is either the vendored, chartcore-served
// `TSS-arrow` (the ORIENT branch — real magenta warning artwork with no
// theme awareness of its own) or `caution` (the no-ORIENT fallback, an
// ordinary chartsymbols.xml sprite-sheet token, already palette-baked by
// build-sprites.ts). Only the former needs the colour-override suffix; this
// pins that the icon-image expression tells the two apart correctly instead
// of either suffixing everything (breaking `caution`'s own icon lookup) or
// suffixing nothing (the bug this task fixes).

function tsslptSymLayer(settings: ChartSettings = DEFAULT_SETTINGS): ChartLayer {
  let layer: ChartLayer | undefined;
  const add: AddLayer = (_prio, sourceLayer, l) => {
    if (sourceLayer === "TSSLPT" && l.id.endsWith("-tsslpt-sym")) layer = l;
  };
  trafficRoutesSymbolLayers(add, "chart", settings);
  if (!layer) throw new Error("chart-tsslpt-sym layer not emitted");
  return layer;
}

const iconSpec = {
  type: "string",
  "property-type": "data-driven",
  expression: { interpolated: false, parameters: ["zoom", "feature"] },
} as const;

function evalIcon(expr: unknown, props: Record<string, unknown>): string {
  const r = createPropertyExpression(expr as never, iconSpec as never);
  if (r.result === "error") throw new Error(r.value.map((e) => e.message).join("; "));
  return r.value.evaluate({ zoom: 12 } as never, { properties: props } as never) as unknown as string;
}

describe("TSSLPT icon-image: TSS-arrow gets the day palette's own CHMGD hex", () => {
  test("sym=TSS-arrow resolves to the literal name plus the current palette's own CHMGD hex", () => {
    const layer = tsslptSymLayer();
    const id = evalIcon(layer.layout!["icon-image"], { sym: "TSS-arrow" });
    const expectedHex = s52ColourToHex(paletteColors(DEFAULT_SETTINGS.palette).CHMGD);
    expect(id).toBe(`TSS-arrow,${expectedHex}`);
  });

  test("any other sym (the no-ORIENT `caution` fallback) is unaffected — no suffix, no chartcore address", () => {
    const layer = tsslptSymLayer();
    const id = evalIcon(layer.layout!["icon-image"], { sym: "caution" });
    // The raw sym value, unwrapped: symbol ids are palette-neutral, so there
    // is no prefix, and this branch is not routed through the colour-override
    // address form at all — it takes the theme's icon ROLE table instead.
    expect(id).toBe("caution");
  });

  test.each(PALETTES)("every palette (%s) gets its OWN CHMGD hex, not just day", (palette) => {
    // This address form carries its own RESOLVED colour, which chartcore
    // applies before any role substitution (measured), so it stays the right
    // way to ask for the palette's own CHMGD on a per-style-build basis —
    // distinct from the theme's `warn-magenta` icon role, which is separately
    // tunable and would be the wrong value here.
    const layer = tsslptSymLayer({ ...DEFAULT_SETTINGS, palette });
    const id = evalIcon(layer.layout!["icon-image"], { sym: "TSS-arrow" });
    expect(id).toBe(`TSS-arrow,${s52ColourToHex(paletteColors(palette).CHMGD)}`);
    // Never the dusk_/dark_ prefix scheme's id shape for this icon, on any
    // palette — this address form's id must never start with a palette
    // prefix, or atonIcons.ts's isAtonIconCandidate would reject it exactly
    // like an ATON key and the icon would silently stop rendering.
    expect(id.startsWith("dusk_")).toBe(false);
    expect(id.startsWith("dark_")).toBe(false);
  });
});
