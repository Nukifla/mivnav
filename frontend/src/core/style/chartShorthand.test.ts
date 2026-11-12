/**
 * CHART SHORTHAND — soundings, the WRECKS "Wk" adjunct and SBDARE's NATSUR
 * letters — draws in plain type with NO glow, and SBDARE alone takes the
 * theme's italic.
 *
 * What these pin:
 *  (a) SBDARE's letters take the theme's italic role where the theme has one
 *      (paper2) and fall back to upright TEXT_FONT where it does not (day) —
 *      seabed nature is conventionally italic on a paper chart;
 *  (b) none of the shorthand layers carry ANY `text-halo-*` paint key, on a
 *      palette that DOES define a halo. Asserting this on paper2 would be
 *      vacuous: `haloPaint` returns no keys at all for the ink-on-paper
 *      family, so every layer would pass before the change too.
 *  (c) the control — the LIGHTS `litdsn` description, deliberately NOT part
 *      of this change (the user named soundings, SBDARE and "Wk" only) —
 *      still has its halo on those same palettes. This is the half that
 *      stops a future `haloPaint` sweep silently re-gilding the shorthand:
 *      without it, deleting `haloPaint` altogether would pass (b).
 */

import { describe, expect, test } from "bun:test";
import type { ChartSet } from "../catalog";
import { haloPaint, themeFonts } from "./colors";
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
  vector_layers: ["SOUNDG", "SBDARE", "WRECKS", "OBSTRN", "UWTROC", "LIGHTS"].map((id) => ({
    id,
    minzoom: 0,
    maxzoom: 16,
    fields: {},
  })),
};

const layer = (palette: "day" | "night" | "paper2", id: string) => {
  const l = buildStyle([set], { ...DEFAULT_SETTINGS, palette }).layers.find((x) => x.id === id);
  if (!l) throw new Error(`no ${id} layer for ${palette}`);
  return l as Extract<typeof l, { type: "symbol" }>;
};

const haloKeys = (palette: "day" | "night" | "paper2", id: string) =>
  Object.keys(layer(palette, id).paint ?? {}).filter((k) => k.startsWith("text-halo"));

/** The palettes whose `textHalo` is actually defined — the only ones on which
 * an absence assertion discriminates. */
const GLOWING = ["day", "night"] as const;

const SHORTHAND = [
  "chart-dk-soundg", // SOUNDG DEPTH
  "chart-dk-wrecks-snd", // hazard VALSOU
  "chart-dk-obstrn-snd",
  "chart-dk-uwtroc-snd",
  "chart-dk-wrecks-sym", // the "Wk" adjunct
  "chart-dk-sbdare-pt-txt",
  "chart-dk-sbdare-line-txt",
];

describe("chart shorthand", () => {
  test("(a) SBDARE takes the theme's italic, upright where there is none", () => {
    const paper2Italic = themeFonts("paper2").italic;
    expect(paper2Italic).toBeDefined();
    for (const id of ["chart-dk-sbdare-pt-txt", "chart-dk-sbdare-line-txt"]) {
      expect(layer("paper2", id).layout!["text-font"]).toEqual(paper2Italic!);
    }

    expect(themeFonts("day").italic).toBeUndefined();
    for (const id of ["chart-dk-sbdare-pt-txt", "chart-dk-sbdare-line-txt"]) {
      expect(layer("day", id).layout!["text-font"]).toEqual(TEXT_FONT);
    }
  });

  test("(b) no shorthand layer carries a text-halo-* key, on a glowing palette", () => {
    for (const palette of GLOWING) {
      expect(Object.keys(haloPaint(palette)).length).toBeGreaterThan(0); // discriminating
      for (const id of SHORTHAND) expect([id, ...haloKeys(palette, id)]).toEqual([id]);
    }
  });

  test("(c) control: the LIGHTS litdsn description keeps its halo", () => {
    for (const palette of GLOWING) {
      expect(haloKeys(palette, "chart-dk-lights-text").sort()).toEqual([
        "text-halo-blur",
        "text-halo-color",
        "text-halo-width",
      ]);
    }
  });

  test("shorthand stays plain upright type apart from SBDARE's italic", () => {
    for (const id of ["chart-dk-soundg", "chart-dk-wrecks-snd", "chart-dk-wrecks-sym"]) {
      expect(layer("paper2", id).layout!["text-font"]).toEqual(TEXT_FONT);
    }
  });
});
