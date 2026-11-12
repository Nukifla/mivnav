/**
 * THE THEME SET, and the two agreements it has to keep.
 *
 * This test used to parse `index.css` and assert that each theme's
 * `overlay.accent`/`routeOverlay.route` equalled its `--color-accent`/
 * `--color-route` in a hand-written `:root[data-palette="…"]` block. Its
 * premise — both sides static, in this repo, side by side — is gone: the
 * themes are JSON in the Python backend, the per-palette chrome CSS is
 * generated from that same JSON by `GET /api/themes.css`, and `index.css`
 * keeps only day's `@theme static` declaration block.
 *
 * What replaces it is two checks with real premises:
 *
 *   1. THE BUNDLE DOES NOT DRIFT. `bundled.generated.ts` is the offline /
 *      first-paint fallback, baked from `backend/mivnav/features/themes/
 *      data/*.json` by `tools/themes/build-theme-bundle.ts`. Editing a theme
 *      JSON without re-running that script leaves the app shipping stale
 *      colours until the backend answers — invisible on a dev box, where it
 *      always does.
 *   2. THE TWO HALVES OF A THEME STILL AGREE. `overlay.accent` and
 *      `routeOverlay.route` exist as data ONLY because a MapLibre paint
 *      property and an SVG stroke cannot resolve a CSS var; `chrome.accent`
 *      and `chrome.route` are the same colours for the chrome. One theme, two
 *      representations, and nothing but this test stops them diverging — the
 *      exact invariant the old CSS-parsing version was defending, checked at
 *      its new seam.
 *
 * Day's chrome is checked against `index.css` as well, because that is the
 * one palette whose tokens genuinely live there (Tailwind's `@theme static`
 * needs the names at build time, so day's VALUES are the declaration site and
 * the backend deliberately emits no day block).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readThemeJson } from "../../../../tools/themes/build-theme-bundle";
import { s52ColourToHex } from "../colors";
import { BUNDLED_THEMES } from "./bundled.generated";
import { THEMES } from "./index";
import { resetThemes, setThemes, themeList } from "./source";

// The dropdown order. The first three are the day/dusk/night ROLES, which are
// `paper2`/`graphite2`/`night` since uqolozkr — the ids never moved, only the
// roles and the labels did, so `day`/`dusk` are still here, now offered as
// "S52-Day"/"S52-Dusk" behind the three quick-switch palettes.
const EXPECTED_IDS = [
  "paper2",
  "graphite2",
  "night",
  "day",
  "dusk",
  "whiteback",
  "blackback",
  "slick",
  "paper",
  "graphite",
  "sunset",
  "vintage",
  "modern-paper-2",
  "modern-paper-2-night-dim",
  "modern-paper-2-night-red",
  "modern-paper-2-moonlight",
];

describe("the bundled fallback matches the backend's theme JSON", () => {
  const json = readThemeJson();

  test("same themes, same order", () => {
    expect(BUNDLED_THEMES.map((t) => t.id)).toEqual(json.map((t) => t.id as string));
    // Order is a contract, not an accident: it is the order the Settings
    // dropdown offers palettes in, the day/dusk/night roles first for the
    // Rail's hardcoded 3-way (`chrome/Launcher.tsx` `PALETTE_MODES`).
    expect(BUNDLED_THEMES.map((t) => t.id)).toEqual(EXPECTED_IDS);
  });

  test("byte-for-byte the same values — re-run `bun run themes` after editing a theme", () => {
    // Deep-equal over the parsed objects, not the file text: this must fail on
    // a changed COLOUR and not on a reformat.
    expect(JSON.parse(JSON.stringify(BUNDLED_THEMES))).toEqual(json);
  });

  test("an absent optional knob stays ABSENT, not defaulted", () => {
    // Load-bearing: `chartStyle.ts`'s `rasterPaint` must produce NO keys at
    // all for a bright theme, so day/whiteback/slick diff to exactly the style
    // that shipped before palettes existed. A generator that filled these in
    // with neutral values would break that silently.
    const day = BUNDLED_THEMES.find((t) => t.id === "day")!;
    expect(day.rasterDim).toBeUndefined();
    expect(day.basemapTint).toBeUndefined();
    expect(day.contourWidth).toBeUndefined();
    expect(day.fonts).toBeUndefined();
  });
});

describe("every colour in every theme is written the same way", () => {
  // The durable guard for task zrtxyypv, on the frontend side of the same
  // data. The themes carried three notations (`#rrggbb`, `rgb()`, `rgba()`)
  // purely as a fossil of where each value came from; they are all hex now,
  // 8 digits where the value has alpha. Backend twin:
  // `test_every_colour_in_every_theme_is_written_the_same_way`.
  //
  // This side matters on its own because `bundled.generated.ts` is what the
  // app paints from before the backend answers, and because the parsers that
  // read these strings live here — `colors.ts`'s `s52ColourToHex` and, through
  // it, `sector-lights/overlay.ts` and `signalkShips.ts`, both of which used
  // to accept `rgb()` ONLY and fail silently (black arcs, opaque halos) on
  // anything else.
  const COLOUR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/;
  /** The only strings a theme holds that are not colours. */
  const NON_COLOUR = new Set(["id", "label", "spritePrefix", "fonts.upright[]", "fonts.italic[]", "fonts.all[]"]);

  function strings(node: unknown, path = ""): [string, string][] {
    if (typeof node === "string") return [[path, node]];
    if (Array.isArray(node)) return node.flatMap((v) => strings(v, `${path}[]`));
    if (node && typeof node === "object") {
      return Object.entries(node).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
    }
    return [];
  }

  const colourValues = (t: unknown) => strings(t).filter(([path]) => !NON_COLOUR.has(path));

  for (const t of BUNDLED_THEMES) {
    test(`${t.id}`, () => {
      const values = colourValues(t);
      expect(values.length).toBeGreaterThan(0);
      for (const [path, value] of values) expect(value, `${t.id}.${path}`).toMatch(COLOUR);
    });
  }

  test("every one of them parses, and the alpha-bearing ones kept their alpha", () => {
    // Not just "matches a regex": the notation has to be one the code that
    // reads it can actually read. `s52ColourToHex` is the shared parser and it
    // throws rather than degrading, so this is the round-trip check.
    let withAlpha = 0;
    for (const t of BUNDLED_THEMES) {
      for (const [path, value] of colourValues(t)) {
        expect(s52ColourToHex(value), `${t.id}.${path}`).toBe(value.slice(1, 7));
        if (value.length === 9) withAlpha++;
      }
    }
    // The five alpha-bearing paths (chrome.shadow, the two overlay halos,
    // basemap.placeHalo, textHalo.color) across the themes that declare them.
    // 8-bit alpha quantizes — 0.9 became 0xe6/255 = 0.90196 — so what is
    // pinned is that the alpha is still THERE, not that it is bit-exact.
    expect(withAlpha).toBe(76);
  });
});

describe("a theme's chart half and chrome half describe the same theme", () => {
  for (const t of BUNDLED_THEMES) {
    test(`${t.id}: chrome.accent === overlay.accent`, () => {
      expect(t.chrome.accent).toBe(t.overlay.accent);
    });
    test(`${t.id}: chrome.route === routeOverlay.route`, () => {
      expect(t.chrome.route).toBe(t.routeOverlay.route);
    });
  }
});

describe("day's chrome is index.css's @theme static block", () => {
  // The one palette the backend deliberately emits no CSS for: Tailwind only
  // generates utilities from tokens that exist as real CSS at build time, so
  // day's values ARE that declaration site — and are therefore also the
  // first-paint and backend-unreachable fallback.
  const css = readFileSync(join(import.meta.dir, "..", "..", "..", "index.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const open = css.indexOf("{", css.search(/@theme static\s*\{/));
  const body = css.slice(open + 1, css.indexOf("}", open));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  const day = BUNDLED_THEMES.find((t) => t.id === "day")!;

  test("every chrome token day.json declares is in the block, with the same value", () => {
    for (const [token, value] of Object.entries(day.chrome)) {
      expect(vars[token], `--color-${token}`).toBe(value);
    }
  });

  test("the per-palette blocks are NOT in index.css any more", () => {
    // They are served by `GET /api/themes.css`. A copy left behind here would
    // win or lose the cascade by file order rather than by intent, and would
    // silently ignore a retuned theme on the boat.
    expect(css).not.toContain(':root[data-palette="night"]');
    expect(css).not.toContain("maplibregl-ctrl-icon");
  });
});

describe("the live set replaces the bundle wholesale", () => {
  test("THEMES and its derived maps are rebuilt in place", () => {
    const fake = BUNDLED_THEMES.map((t) => (t.id === "night" ? { ...t, canvas: "rgb(1, 2, 3)" } : t));
    try {
      expect(setThemes(fake)).toBe(true);
      expect(THEMES.find((t) => t.id === "night")!.canvas).toBe("rgb(1, 2, 3)");
      // RESOLVED copies of the payload, not the payload's own objects:
      // `source.ts` fills in the six derived icon roles on the way in
      // (`derivedIcons.ts`), so this is same set, same order, not same
      // identity.
      expect(themeList().map((t) => t.id)).toEqual(fake.map((t) => t.id));
      expect(themeList()[0]).not.toBe(fake[0]);
    } finally {
      resetThemes();
    }
    expect(THEMES.find((t) => t.id === "night")!.canvas).not.toBe("rgb(1, 2, 3)");
  });

  test("a payload that is not a usable theme array is refused outright", () => {
    // All-or-nothing on purpose: a theme half from JSON and half from the
    // bundle is a palette nobody authored.
    for (const bad of [null, [], {}, [{ id: "x" }], [{ ...BUNDLED_THEMES[0], s52: undefined }]]) {
      expect(setThemes(bad)).toBe(false);
    }
    expect(THEMES.length).toBe(EXPECTED_IDS.length);
  });
});
