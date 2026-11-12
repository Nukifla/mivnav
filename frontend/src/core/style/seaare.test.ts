/**
 * SEAARE — the chart's named bay/sound/channel/river labels.
 *
 * Nothing drew this class at all before jt kysxzvxq, on the stated grounds
 * that the names never reached the tiles. They do: `mvt_golden.rs`'s
 * `golden_seaare_keeps_its_name_and_gets_one_label_point` pins OBJNAM
 * surviving the tiler, so this is purely a style layer.
 *
 * What these pin:
 *  (a) the layer exists in the generated style for EVERY theme, and reads
 *      `coalesce(NOBJNM, OBJNAM)` like the reference's `label-sea`;
 *  (b) it takes the theme's italic role where the theme has one (paper2) and
 *      falls back to upright TEXT_FONT where it does not (day) — the label is
 *      the chart feature, the italic is only its styling;
 *  (c) it draws on Point geometry only — the genuine Point primitive and
 *      chartcore's synthetic label point — never the polygon, which MapLibre
 *      would label once per clipped tile;
 *  (d) the colour is the S-52 CHBLK token, not the reference's frozen `#333`.
 */

import { describe, expect, test } from "bun:test";
import type { ChartSet } from "../catalog";
import { PALETTES, paletteColors, themeFonts } from "./colors";
import { TEXT_FONT } from "./expr";
import { DEFAULT_SETTINGS } from "./settings";

(globalThis as { location?: unknown }).location = { origin: "http://localhost" };
const { buildStyle } = await import("./chartStyle");

const set: ChartSet = {
  id: "dk",
  name: "Denmark",
  bounds: [8, 54, 13, 58],
  min_zoom: 0,
  max_zoom: 16,
  sequence: 1,
  tiles: "/tiles/dk/{z}/{x}/{y}.pbf",
  vector_layers: [{ id: "SEAARE", minzoom: 0, maxzoom: 16, fields: {} }],
};

const nameLayer = (palette: (typeof PALETTES)[number]) => {
  const l = buildStyle([set], { ...DEFAULT_SETTINGS, palette }).layers.find(
    (x) => x.id === "chart-dk-seaare-name",
  );
  if (!l) throw new Error(`no chart-dk-seaare-name layer for ${palette}`);
  return l as Extract<typeof l, { type: "symbol" }>;
};

describe("SEAARE names", () => {
  test("(a) every theme gets the layer, reading coalesce(NOBJNM, OBJNAM)", () => {
    for (const palette of PALETTES) {
      expect(nameLayer(palette).layout!["text-field"]).toEqual([
        "coalesce",
        ["get", "NOBJNM"],
        ["get", "OBJNAM"],
      ]);
    }
  });

  test("(b) italic where the theme has one, upright where it does not", () => {
    const paper2Italic = themeFonts("paper2").italic;
    expect(paper2Italic).toBeDefined();
    expect(nameLayer("paper2").layout!["text-font"]).toEqual(paper2Italic!);

    expect(themeFonts("day").italic).toBeUndefined();
    expect(nameLayer("day").layout!["text-font"]).toEqual(TEXT_FONT);
  });

  test("(c) Point geometry only — never the tile-clipped polygon", () => {
    const filter = nameLayer("day").filter as unknown[];
    expect(JSON.stringify(filter)).toContain(JSON.stringify(["==", ["geometry-type"], "Point"]));
    expect(JSON.stringify(filter)).toContain("NOBJNM");
  });

  test("(d) the colour is the S-52 CHBLK token, not a hardcoded hex", () => {
    for (const palette of PALETTES) {
      expect(nameLayer(palette).paint!["text-color"]).toBe(paletteColors(palette).CHBLK);
    }
  });
});
