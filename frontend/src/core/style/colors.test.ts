/**
 * The palette tables, judged by the claims made about them.
 *
 * A test asserting `NIGHT.DEPDW === "rgb(7, 7, 7)"` would have no teeth: it
 * restates a generated number. What the tables must actually *do* is
 *
 *   - stay parallel (one key set, three columns — the switch picks a column,
 *     so a column with a hole in it is a hole in the chart);
 *   - keep day byte-identical to what shipped before palettes existed;
 *   - have no white slab anywhere in night, which is the design's own rule
 *     and the one that is easy to break by accident;
 *   - keep CANVAS — the one colour here that is ours — a non-statement in
 *     every palette, and within that palette's light budget.
 *
 * Measured in CIEDE2000 and relative luminance rather than by eye, because
 * "is this a white slab" and "do these two read as different" are exactly the
 * questions those two numbers answer. Change a value and these fail with a
 * reason.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  OVERLAY_COLORS,
  PALETTES,
  POI_COLORS,
  S52_COLORS,
  S52_PALETTES,
  ICON_COLORS,
  haloPaint,
  overlayColors,
  paletteColors,
  poiColors,
  s52ColourToHex,
  s52ColourToRgb,
} from "./colors";
import { S52_TABLES } from "./s52Tables.generated";
import { EMITTED_ICON_ROLES } from "./themes/iconRoles";
import { S52_EDITOR_FIELDS } from "./themes/s52Fields";
import { clearThemeOverride, setThemeOverrideField } from "./themes/override";
import { resetThemes, setThemes } from "./themes/source";
import { THEMES } from "./themes";

type RGB = [number, number, number];

/** Channels of any theme value. Delegates to the production parser rather than
 *  carrying a private regex: the tables were `rgb(...)` and have been
 *  `#rrggbb` since task zrtxyypv, and every measurement below is about LIGHT,
 *  not about notation. Still throws on an unreadable value — that is what the
 *  "every value parses" test asserts. */
function parse(css: string): RGB {
  const rgb = s52ColourToRgb(css);
  if (!rgb) throw new Error(`unparsed colour: ${css}`);
  return rgb;
}

const srgb = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance — "how much light does this throw at the eye". */
function luminance(css: string): number {
  const [r, g, b] = parse(css).map(srgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function lab([r, g, b]: RGB): [number, number, number] {
  const [R, G, B] = [srgb(r), srgb(g), srgb(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE — plenty for "are these two obviously different colours". */
function dE(a: string, b: string): number {
  const [l1, a1, b1] = lab(parse(a));
  const [l2, a2, b2] = lab(parse(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

describe("the tables are parallel", () => {
  test("every palette has every token, and no palette has an extra", () => {
    const day = Object.keys(S52_PALETTES.day).sort();
    for (const p of PALETTES) {
      expect(Object.keys(S52_PALETTES[p]).sort()).toEqual(day);
    }
  });

  test("every value is a parseable colour, in the ONE notation the themes use", () => {
    // Two claims, deliberately together: the value can be read at all, and it
    // is written the way every other theme value is (task zrtxyypv). The
    // notation half is pinned exhaustively over the whole theme in
    // `themes/index.test.ts`; this is the S-52 table's own copy of it, where
    // a stray `rgb(...)` would come from — the tables were transcribed out of
    // ochartsng's chartsymbols.xml in that notation.
    for (const p of PALETTES) {
      for (const [token, css] of Object.entries(S52_PALETTES[p])) {
        expect(() => parse(css), `${p}.${token}`).not.toThrow();
        expect(css, `${p}.${token}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test("every palette carries a full icon role table", () => {
    // A missing role is not a missing colour: `substituteIconRoles` leaves
    // that role's `#fe00XX` SENTINEL in the document, so the symbol rasterises
    // with a reserved near-magenta in place of its ink.
    for (const p of PALETTES) {
      for (const role of EMITTED_ICON_ROLES) {
        expect(ICON_COLORS[p][role.role], `${p}.${role.role}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  test("paletteColors falls back to day rather than returning undefined", () => {
    // The palette arrives from localStorage and from an opaque profile blob,
    // so "night2" is a thing that can actually reach this function; a
    // undefined table would throw on every colour lookup in the style.
    expect(paletteColors("bogus" as never)).toBe(S52_PALETTES.day);
  });

  test("S52_COLORS is still the day table (its consumers are day-only)", () => {
    // `toEqual`, not `toBe`: both are objects whose CONTENTS are refilled in
    // place when a live theme set lands (`themes/source.ts`), so they are
    // deliberately two distinct objects carrying the same values rather than
    // one shared reference that a rebuild could silently re-point.
    expect(S52_COLORS).toEqual(S52_PALETTES.day);
  });
});

describe("day is untouched", () => {
  // The generator replaced a hand-written table. This is the guard that the
  // transcription was faithful: these are the values that shipped before
  // palettes existed, spot-checked across the ramp, the lines and the lights.
  // The values are the SAME NUMBERS as before task zrtxyypv rewrote the
  // notation — rgb(163, 180, 183) is #a3b4b7 — which is the whole claim that
  // sweep had to make good on. Asserted as the channel triple rather than as
  // the string, so a future notation change fails on a colour and not on a
  // format.
  test.each([
    ["NODTA", [163, 180, 183]],
    ["DEPDW", [212, 234, 238]],
    ["DEPMD", [186, 213, 225]],
    ["DEPMS", [152, 197, 242]],
    ["DEPVS", [115, 182, 239]],
    ["DEPIT", [131, 178, 149]],
    ["LANDA", [201, 185, 122]],
    ["CHBLK", [7, 7, 7]],
    ["CSTLN", [82, 90, 92]],
    ["LITYW", [244, 218, 72]],
    ["CHMGD", [197, 69, 195]],
  ] as const)("day.%s", (token, expected) => {
    expect(parse(S52_PALETTES.day[token as keyof typeof S52_PALETTES.day])).toEqual([...expected]);
  });

  test("CANVAS is unchanged and is not generated (it is not an S-52 colour)", () => {
    expect(parse(S52_PALETTES.day.CANVAS)).toEqual([232, 230, 226]);
    expect(S52_TABLES.day).not.toHaveProperty("CANVAS");
  });
});

describe("no white slab", () => {
  /**
   * The brightest thing upstream itself puts in each table, measured rather
   * than asserted: day 0.79 (DEPDW, a light blue), dusk 0.074 and night 0.028
   * (both SNDG2, a grey sounding). The thresholds below are those numbers with
   * headroom — an order of magnitude below day, which is what makes them catch
   * the failure that matters: a day value surviving into a dark table.
   */
  test.each([
    ["dusk", 0.1],
    ["night", 0.05],
  ] as const)("%s throws no more light than the palette allows", (palette, ceiling) => {
    for (const [token, css] of Object.entries(S52_PALETTES[palette])) {
      expect(luminance(css), `${palette}.${token} = ${css}`).toBeLessThan(ceiling);
    }
  });

  test("day is bright, so the test above is actually measuring something", () => {
    // Guards the guard: if luminance() were broken and returned ~0, every
    // assertion above would pass vacuously.
    expect(luminance(S52_PALETTES.day.DEPDW)).toBeGreaterThan(0.5);
  });

  /**
   * S-52 night is a contrast *inversion*, not a dimming filter, and this is
   * the test that says so — it exists because the obvious assertion ("night
   * is darker than day, token for token") is false, and finding out why is
   * the whole insight.
   *
   * The GROUND tokens — the fills a chart is mostly made of — go nearly black.
   * The INK tokens go the other way: CHBLK is rgb(7,7,7) by day and
   * rgb(31,34,35) at night, *lighter*, because by day ink is black on a pale
   * sea and at night it has to stay visible on a sea that is now blacker than
   * the ink was. Uniformly scaling the day table toward black — which is what
   * a reasonable person would write if these tables were ever "simplified" —
   * would take the ink to zero and hand back a black rectangle.
   */
  const GROUND = ["DEPDW", "DEPMD", "DEPMS", "DEPVS", "DEPIT", "LANDA", "NODTA"] as const;
  const INK = ["CHBLK", "SNDG2"] as const;

  test.each(GROUND)("night's %s (a fill) is darker than day's", (token) => {
    expect(luminance(S52_PALETTES.night[token])).toBeLessThan(
      luminance(S52_PALETTES.day[token]),
    );
  });

  test.each(INK)("night's %s (ink) is LIGHTER than day's — the ground went black", (token) => {
    expect(luminance(S52_PALETTES.night[token])).toBeGreaterThan(
      luminance(S52_PALETTES.day[token]),
    );
  });

  test("night keeps ink above its ground, which is what makes the chart readable", () => {
    // The inversion is only worth anything if it lands the right way round.
    expect(luminance(S52_PALETTES.night.CHBLK)).toBeGreaterThan(
      luminance(S52_PALETTES.night.DEPDW),
    );
  });
});

describe("CANVAS says 'not painted yet' in every palette", () => {
  // It is the one colour in these tables we chose rather than transcribed, and
  // the only one that shows on every pan while tiles are in flight — so it is
  // the one that has to be argued for. Two claims, both testable.

  test.each(PALETTES)("%s: CANVAS is not mistakable for a chart statement", (palette) => {
    const t = S52_PALETTES[palette];
    // NODTA is "the producer declares no coverage" and LANDA is land. CANVAS
    // must not be read as either: those are claims about the world, and "the
    // tile hasn't arrived" is not.
    expect(dE(t.CANVAS, t.NODTA), `${palette}: CANVAS vs NODTA`).toBeGreaterThan(10);
    expect(dE(t.CANVAS, t.LANDA), `${palette}: CANVAS vs LANDA`).toBeGreaterThan(10);
  });

  test.each(["dusk", "night"] as const)(
    "%s: CANVAS stays inside the palette's own light budget",
    (palette) => {
      // Grounded rather than a magic threshold: whatever S-52 itself is
      // willing to put on screen in this palette is the ceiling, and the
      // colour that flashes on every pan has no business being brighter than
      // the brightest thing the specification allows.
      const brightest = Math.max(...Object.values(S52_TABLES[palette]).map(luminance));
      expect(luminance(S52_PALETTES[palette].CANVAS)).toBeLessThanOrEqual(brightest);
    },
  );
});

describe("overlay/POI colours dim with the palette", () => {
  // The crosshair, measure and POI overlays cannot read a CSS var (WebGL paint /
  // SVG stroke), so they carry per-palette tables the way ROUTE_OVERLAY_COLORS
  // does. The claims that matter: day is byte-identical to what shipped, and the
  // halos/fills go dark at dusk/night so they do not dazzle the near-black chart.

  // `luminance` (module scope) reads these directly now: since task zrtxyypv
  // every theme value is `#rrggbb`/`#rrggbbaa` and `parse` handles both. This
  // used to be a second, notation-sniffing copy because these tokens were the
  // rgba() ones. Alpha is still ignored, deliberately: a semi-transparent
  // white still throws white light, and "did this go dark" is the question.
  const lum = luminance;

  test("overlayColors falls back to day for an unknown palette", () => {
    expect(overlayColors("night2" as never)).toBe(OVERLAY_COLORS.day);
  });

  test("poiColors falls back to day for an unknown palette", () => {
    expect(poiColors("night2" as never)).toBe(POI_COLORS.day);
  });

  test("the day column is the shipped values, verbatim", () => {
    expect(OVERLAY_COLORS.day).toEqual({
      accent: "#0284c7",
      // `#ffffffe6` is `rgba(255,255,255,0.9)` written the way every other
      // theme value is (zrtxyypv); 0xe6/255 = 0.90196 is the 8-bit rounding.
      halo: "#ffffffe6",
      markerHalo: "#ffffff",
    });
    expect(POI_COLORS.day).toEqual({
      marina: "#0284c7",
      fuel: "#ea580c",
      harbourmaster: "#7c3aed",
      other: "#0d9488",
      label: "#0f172a",
    });
  });

  test.each(["dusk", "night"] as const)(
    "%s: the crosshair/measure halos are darker than day's bright white",
    (palette) => {
      expect(lum(OVERLAY_COLORS[palette].markerHalo)).toBeLessThan(lum(OVERLAY_COLORS.day.markerHalo));
      expect(lum(OVERLAY_COLORS[palette].halo)).toBeLessThan(lum(OVERLAY_COLORS.day.halo));
    },
  );

  test("night's marker halo is genuinely dark, not merely below white", () => {
    // The whole point is a dark-adapted eye: the near-black chart's halo must be
    // near-black too, not a mid grey that still glares.
    expect(lum(OVERLAY_COLORS.night.markerHalo)).toBeLessThan(0.02);
  });

  const FILLS = ["marina", "fuel", "harbourmaster", "other"] as const;
  test.each(FILLS)("night's POI %s fill is darker than day's", (kind) => {
    expect(lum(POI_COLORS.night[kind])).toBeLessThan(lum(POI_COLORS.day[kind]));
  });

  test("the POI label flips from dark ink (day) to light (night)", () => {
    // Day text is dark on a white halo; at night the halo goes dark, so the text
    // has to go light to stay legible — the inverse S-52 makes for CHBLK.
    expect(lum(POI_COLORS.day.label)).toBeLessThan(lum(POI_COLORS.night.label));
  });
});

describe("s52ColourToHex: the chartcore icon colour-override address form", () => {
  // yxnrrtwk: TSS-arrow's fixed vendored magenta never matched any theme's
  // CHMGD, because chartcore's icon endpoint had no way to hear a theme's
  // opinion at all. This is the conversion that lets the frontend ask for
  // its OWN resolved hex (`TSS-arrow,<hex>`, chartcore/src/icons/mod.rs's
  // `resolve_literal`) instead of chartcore keeping a second, driftable copy
  // of a 12-palette table.
  test("every palette's CHMGD converts to a lowercase 6-digit hex, no #", () => {
    for (const p of PALETTES) {
      const hex = s52ColourToHex(paletteColors(p).CHMGD);
      expect(hex).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  test("day's CHMGD is the specific value the chartcore-side test pins", () => {
    // chartcore/src/icons/mod.rs's own tests use "c545c3" as a stand-in
    // real-looking override; this is what makes that value real rather than
    // an arbitrary probe.
    expect(s52ColourToHex(S52_PALETTES.day.CHMGD)).toBe("c545c3");
  });

  test("rounds no channel — matches a hand conversion", () => {
    expect(s52ColourToHex("rgb(0, 0, 0)")).toBe("000000");
    expect(s52ColourToHex("rgb(255, 255, 255)")).toBe("ffffff");
    expect(s52ColourToHex("rgb(1, 2, 3)")).toBe("010203");
  });

  // The accepted input set WIDENED when the theme editor gained the S-52
  // table: its colour rows are free text, so a hand-typed `#rrggbb` is now a
  // legitimate value in this table and not just the generator's `rgb(...)`.
  test("accepts the hand-typed hex forms the theme editor can produce", () => {
    expect(s52ColourToHex("#ffffff")).toBe("ffffff");
    expect(s52ColourToHex("#C545C3")).toBe("c545c3");
    expect(s52ColourToHex("  #010203  ")).toBe("010203");
    // 3-digit shorthand expands per channel, not by zero-padding.
    expect(s52ColourToHex("#abc")).toBe("aabbcc");
  });

  test("accepts rgba() but DROPS the alpha — the override address has no alpha channel", () => {
    // chartcore's `,RRGGBB` form is six hex digits; there is nowhere for a
    // fourth channel to go, so honouring it silently is not an option and
    // refusing the value outright would reject a shape the halo/canvas
    // fields already use.
    expect(s52ColourToHex("rgba(1, 2, 3, 0.5)")).toBe("010203");
  });

  test("still throws on anything it cannot read", () => {
    // The guard's original purpose survives the widening: a future change to
    // the generated table's format fails loudly here rather than sending
    // chartcore an override it quietly ignores.
    for (const bad of ["red", "", "#ff", "#fffff", "rgb(1 2 3)", "hsl(0, 0%, 0%)"]) {
      expect(() => s52ColourToHex(bad)).toThrow();
    }
  });
});

describe("the theme editor can reach the S-52 table", () => {
  // The user-reported defect this covers: "the TSSLPT, TSEZNE and various
  // area separating lines all render with an un-themed magenta ... and
  // changing colors in the theme editor doesn't apply to it either". Those
  // lines and fills are painted from CHMGD/CHMGF/TRFCD/TRFCF, and the editor
  // had NO control for the S-52 table at all — `ThemeOverridePatch` simply
  // had no `s52` field, by an explicit v1 scope decision. So no amount of
  // editing could move them. These pin that the patch now reaches
  // `paletteColors`, which is what every chart layer builds its paint from.
  beforeEach(() => {
    for (const p of PALETTES) clearThemeOverride(p);
  });

  test("an S-52 override reaches paletteColors", () => {
    expect(paletteColors("paper").CHMGD).toBe(S52_PALETTES.paper.CHMGD);
    setThemeOverrideField("paper", "s52", { CHMGD: "rgb(10, 20, 30)" });
    expect(paletteColors("paper").CHMGD).toBe("rgb(10, 20, 30)");
  });

  test("the patch is sparse — an untouched token keeps the theme's own value", () => {
    setThemeOverrideField("paper", "s52", { CHMGD: "#112233" });
    expect(paletteColors("paper").CHMGD).toBe("#112233");
    expect(paletteColors("paper").TRFCD).toBe(S52_PALETTES.paper.TRFCD);
    expect(paletteColors("paper").LANDA).toBe(S52_PALETTES.paper.LANDA);
  });

  test("it applies only to the palette it targets", () => {
    setThemeOverrideField("paper", "s52", { CHMGD: "#112233" });
    expect(paletteColors("day").CHMGD).toBe(S52_PALETTES.day.CHMGD);
  });

  test("an unparseable value is DROPPED, not passed through to a style build", () => {
    // `s52ColourToHex` throws on a value it cannot read, and the editor's
    // fields are free text — so a half-typed `#c5` would otherwise take the
    // whole style build down mid-keystroke.
    setThemeOverrideField("paper", "s52", { CHMGD: "#c5" });
    expect(paletteColors("paper").CHMGD).toBe(S52_PALETTES.paper.CHMGD);
    expect(() => s52ColourToHex(paletteColors("paper").CHMGD)).not.toThrow();
  });

  test("every token the editor offers is a real key of the table", () => {
    // The editor's field list is hand-ordered (magenta family first), so it
    // can drift from `S52Colors` in a way the compiler won't catch once a
    // token is renamed in the generator.
    for (const f of S52_EDITOR_FIELDS) {
      expect(S52_PALETTES.day).toHaveProperty(f.key);
    }
  });
});

describe("haloPaint: ONE text glow per theme, or none at all", () => {
  // The whole point of `ThemeDef.textHalo` (paper2 port): before it, ~15
  // layer builders each hardcoded their own `text-halo-width`, so the
  // ink-on-paper themes could not turn the glow off and the working themes
  // could not tune it in one place.

  test("a theme with `textHalo` yields all three paint keys", () => {
    const glow = haloPaint("day");
    expect(glow["text-halo-width"]).toBe(1.2);
    expect(glow["text-halo-color"]).toBe("#ffffffe6");
    // Absent `blur` normalises to a crisp 0 rather than leaving the key off:
    // the imperative callers (`poi`/`measure` overlays) `setPaintProperty`
    // this on a palette switch and would otherwise carry a stale blur over.
    expect(glow["text-halo-blur"]).toBe(0);
  });

  test("the ink-on-paper family yields NO KEYS, not a zero width", () => {
    // Load-bearing: these get spread into a layer's `paint`, and `{}` spreads
    // to nothing at all. A `width: 0` would still be a halo the style carries.
    for (const p of ["paper", "paper2", "graphite", "graphite2"] as const) {
      expect(haloPaint(p)).toEqual({});
      // …and the `color` override argument does not resurrect one: `textHalo`
      // alone decides WHETHER there is a glow.
      expect(haloPaint(p, "#ffffff")).toEqual({});
    }
  });

  test("blackback's halo is DARK — its ink is light, unlike its overlay.halo", () => {
    // The one theme whose `textHalo` is not seeded from its own
    // `overlay.halo`: that field is white, but blackback's CHBLK is a LIGHT
    // grey on a near-black canvas, so a white halo would wash the text out.
    const glow = haloPaint("blackback");
    expect(glow["text-halo-color"]).not.toBe(OVERLAY_COLORS.blackback.halo);
    // Measured, not merely "not that string": check it is genuinely dark.
    // (`parse` drops the alpha byte of the `#rrggbbaa` this is, which is right
    // here — a translucent white would still be white light.)
    expect(luminance(glow["text-halo-color"] as string)).toBeLessThan(0.05);
  });

  test("the `color` override replaces only the colour, never the width", () => {
    const glow = haloPaint("night", "#123456");
    expect(glow["text-halo-color"]).toBe("#123456");
    expect(glow["text-halo-width"]).toBe(1.2);
  });

  test("it tracks the LIVE theme set, not a module-load snapshot", () => {
    // The silent-failure mode this port had to avoid: `THEMES` is an array
    // REBUILT IN PLACE when `/api/themes` lands, so a table built once with
    // `Object.fromEntries(THEMES…)` at module load would capture the empty
    // pre-fetch array and hand back `{}` for every theme forever — i.e. no
    // glow anywhere, with every "paper2 has none" assertion still passing.
    expect(haloPaint("day")["text-halo-width"]).toBe(1.2);
    setThemes(THEMES.map((t) => (t.id === "day" ? { ...t, textHalo: { color: "#abcdef", width: 3, blur: 2 } } : t)));
    expect(haloPaint("day")).toEqual({
      "text-halo-color": "#abcdef",
      "text-halo-width": 3,
      "text-halo-blur": 2,
    });
    resetThemes();
    expect(haloPaint("day")["text-halo-width"]).toBe(1.2);
  });
});
