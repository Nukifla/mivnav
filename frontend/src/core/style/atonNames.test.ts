/**
 * ATON OBJNAM labels take a theme's ITALIC — the chart-location-name role.
 *
 * The user's ask (mnoomzyp) was to spend paper2/graphite2's `fonts.italic` on
 * "non-basemap location names — named waters, names of beacons etc". SEAARE's
 * water names already had it (seaare.ts, kysxzvxq); this is the beacon/buoy
 * half.
 *
 * These pin BOTH halves of the line, because a test that only checks the
 * layers that changed cannot fail when someone later italicises the rest:
 *
 *  (a) every ATON-family layer — the shared "ATON" MVT layer plus the four
 *      classes that keep their own acronym as source-layer (LITVES/LITFLT/
 *      MORFAC/M_NSYS, which have historically been the ones to silently not
 *      render, yxrmtltk) — takes the theme's italic where one exists (paper2)
 *      and stays upright TEXT_FONT where it does not (day);
 *  (b) the deliberate-upright decisions stay upright EVEN UNDER paper2:
 *      `litdsn` light characteristics (aidsHazards.ts's own comment) and
 *      RDOCAL's channel number — chart shorthand is not a name. (SBDARE was
 *      here too until ptryromp; see SHORTHAND_LAYERS' own note.)
 *  (c) LNDMRK's named-tower label stays on `upright`, not italic: a landmark
 *      is a LAND feature, and italic-for-water/upright-for-land is the whole
 *      point of having two roles. Pinned as `!== italic` AND `=== upright` so
 *      it can't drift into either the italic role or the plain sans.
 */

import { describe, expect, test } from "bun:test";
import type { ChartSet } from "../catalog";
import { PALETTES, themeFonts } from "./colors";
import { TEXT_FONT } from "./expr";
import { DEFAULT_SETTINGS } from "./settings";

(globalThis as { location?: unknown }).location = { origin: "http://localhost" };
const { buildStyle } = await import("./chartStyle");

const LAYERS = ["ATON", "LITVES", "LITFLT", "MORFAC", "M_NSYS", "LNDMRK", "LIGHTS", "SBDARE", "RDOCAL"];

const set: ChartSet = {
  id: "dk",
  name: "Denmark",
  bounds: [8, 54, 13, 58],
  min_zoom: 0,
  max_zoom: 16,
  sequence: 1,
  tiles: "/tiles/dk/{z}/{x}/{y}.pbf",
  vector_layers: LAYERS.map((id) => ({ id, minzoom: 0, maxzoom: 16, fields: {} })),
};

const font = (palette: (typeof PALETTES)[number], id: string) => {
  const l = buildStyle([set], { ...DEFAULT_SETTINGS, palette }).layers.find((x) => x.id === id);
  if (!l) throw new Error(`no ${id} layer for ${palette}`);
  const f = (l as { layout?: Record<string, unknown> }).layout?.["text-font"];
  if (!f) throw new Error(`${id} has no text-font for ${palette}`);
  return f;
};

/** The ATON-family label layers, all emitted by the one `withText` loop. */
const NAME_LAYERS = [
  "chart-dk-aton",
  "chart-dk-litves",
  "chart-dk-litflt",
  "chart-dk-morfac",
  "chart-dk-m_nsys",
];

/** Deliberately upright: shorthand, not a name.
 *
 * SBDARE's NATSUR letters were on this list and are NOT any more — a later
 * user decision (ptryromp, 2026-07-29) puts seabed nature in the theme's
 * italic, paper-chart convention for what the bottom is made of. It keeps
 * the shorthand treatment in every other respect (no glow); `chartShorthand
 * .test.ts` pins both halves of that split. */
const SHORTHAND_LAYERS = [
  "chart-dk-lights-text", // litdsn, e.g. "Fl(2)G.6s"
  "chart-dk-rdocal-pt-channel", // COMCHA number
];

describe("ATON names take the theme italic", () => {
  test("(a) italic where the theme has one, upright where it does not", () => {
    const italic = themeFonts("paper2").italic;
    expect(italic).toBeDefined();
    expect(themeFonts("day").italic).toBeUndefined();

    for (const id of NAME_LAYERS) {
      expect(font("paper2", id)).toEqual(italic!);
      expect(font("day", id)).toEqual(TEXT_FONT);
    }
  });

  test("(a) every theme emits every ATON name layer with some text-font", () => {
    for (const palette of PALETTES) {
      for (const id of NAME_LAYERS) expect(font(palette, id)).toBeDefined();
    }
  });

  test("(b) chart shorthand stays upright TEXT_FONT, even under paper2", () => {
    for (const id of SHORTHAND_LAYERS) {
      expect(font("paper2", id)).toEqual(TEXT_FONT);
      expect(font("day", id)).toEqual(TEXT_FONT);
    }
  });

  test("(c) LNDMRK's name takes `upright`, never the italic — it is a land feature", () => {
    const fonts = themeFonts("paper2");
    expect(font("paper2", "chart-dk-lndmrk-txt")).toEqual(fonts.upright!);
    expect(font("paper2", "chart-dk-lndmrk-txt")).not.toEqual(fonts.italic!);
    expect(font("day", "chart-dk-lndmrk-txt")).toEqual(TEXT_FONT);
  });
});
