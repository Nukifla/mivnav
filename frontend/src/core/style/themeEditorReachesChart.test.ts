/**
 * The theme editor must reach the CHART, not just the overlays.
 *
 * User report, 2026-07-28: *"The TSSLPT, TSEZNE and various area separating
 * lines (PRCARE, ISTZNE, CTNARE etc) all render with an un-themed magenta"* —
 * and, asked which theme: *"paper — and changing colors in the theme editor
 * doesn't apply to it either."*
 *
 * That second half had a precise cause. Every one of those lines and fills is
 * painted from an S-52 token (`CHMGD` for the restricted-group boundaries,
 * `TRFCF` for the traffic-separation fill), and `ThemeOverridePatch` had no
 * `s52` field at all — an explicit v1 scope decision, on the reasoning that
 * the table was "presentation-library data, not this app's own choice". It is
 * this app's own choice: the twelve theme JSONs carry twelve different S-52
 * tables. So the editor offered controls for the route overlay, the POI pins
 * and the basemap, and none whatsoever for the colours the chart itself is
 * drawn in.
 *
 * `colors.test.ts` pins the merge (`paletteColors` sees the patch). What THIS
 * file pins is the part that actually failed the mariner: that the patch
 * survives all the way through a real `buildStyle` into the paint of the
 * specific layers named in the report. A merge that works while the style
 * builder reads some other table would satisfy the first test and still leave
 * the map unchanged.
 */
(globalThis as any).location ??= { origin: "http://example.invalid" };

import { afterEach, describe, expect, test } from "bun:test";
import { buildStyle } from "./chartStyle";
import { DEFAULT_SETTINGS } from "./settings";
import { clearThemeOverride, setThemeOverrideField } from "./themes/override";

/** The classes the user named, plus RESARE — they all ride the same
 * `RESTRICTED_BOUNDARY` loop, so one of them passing and another failing
 * would mean the loop had grown a special case. */
const CLASSES = ["TSSLPT", "TSEZNE", "PRCARE", "ISTZNE", "CTNARE", "RESARE"];

const SET = {
  id: "dk",
  name: "dk",
  bounds: [8, 54, 13, 58],
  min_zoom: 0,
  max_zoom: 16,
  sequence: 1,
  tiles: "/tiles/dk/{z}/{x}/{y}.pbf",
  vector_layers: CLASSES.map((id) => ({ id, minzoom: 0, maxzoom: 16, fields: {} })),
} as never;

/** Every boundary/fill layer's colour property, as built for `paper` — the
 * theme the report was made against. */
function chartColours(): Record<string, string> {
  const style = buildStyle([SET], { ...DEFAULT_SETTINGS, palette: "paper" } as never);
  const out: Record<string, string> = {};
  for (const layer of style.layers) {
    const paint = (layer as { paint?: Record<string, unknown> }).paint;
    if (!paint) continue;
    if (!layer.id.endsWith("-bdy") && !layer.id.endsWith("-fill")) continue;
    const colour = paint["line-color"] ?? paint["fill-color"];
    if (colour !== undefined) out[layer.id] = JSON.stringify(colour);
  }
  return out;
}

afterEach(() => clearThemeOverride("paper"));

describe("an S-52 edit in the theme editor repaints the chart", () => {
  test("every restricted-group boundary and the separation-zone fill follow it", () => {
    const before = chartColours();
    // Deliberately NOT another magenta: greens and blues cannot be confused
    // with the theme's own value if the assertion ever has to be debugged by
    // eye, and they make a stray untouched layer obvious.
    setThemeOverrideField("paper", "s52", { CHMGD: "rgb(0, 128, 0)", TRFCF: "rgb(0, 0, 128)" });
    const after = chartColours();

    expect(Object.keys(before).length).toBeGreaterThan(0);
    for (const id of Object.keys(before)) {
      expect(after[id], `${id} ignored the S-52 override`).not.toBe(before[id]);
    }
  });

  test("TSEZNE's fill takes TRFCF specifically, not whatever changed first", () => {
    setThemeOverrideField("paper", "s52", { TRFCF: "rgb(0, 0, 128)" });
    expect(chartColours()["chart-dk-tsezne-fill"]).toBe(JSON.stringify("rgb(0, 0, 128)"));
  });

  test("an untouched token keeps the theme's own value", () => {
    // Guards the guard: if the patch REPLACED the table rather than being
    // spread over it, every token would move and the test above would pass
    // for the wrong reason.
    const before = chartColours();
    setThemeOverrideField("paper", "s52", { CHMGD: "rgb(0, 128, 0)" });
    const after = chartColours()["chart-dk-tsezne-fill"];
    expect(after).toBe(before["chart-dk-tsezne-fill"]);
  });

  test("a half-typed colour is ignored rather than crashing the style build", () => {
    // The editor's colour rows are free text and are invalid mid-keystroke.
    // These tokens are re-parsed by `s52ColourToHex` to build chartcore's
    // `,RRGGBB` icon-override address, which throws — so without the filter
    // in `paletteColors` this would take the whole map down on the way to a
    // valid value.
    setThemeOverrideField("paper", "s52", { CHMGD: "#c5" });
    expect(() => chartColours()).not.toThrow();
  });
});
