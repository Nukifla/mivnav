/**
 * THE PARSERS THAT FAIL SILENTLY, pinned against the theme notation.
 *
 * Task zrtxyypv rewrote every theme value from `rgb()`/`rgba()` to
 * `#rrggbb`/`#rrggbbaa`. Two consumers read those strings through their own
 * `rgb()`-only regex and, on a non-match, produced something plausible rather
 * than an error:
 *
 *   - `features/sector-lights/overlay.ts`'s `rgba()` fell through to opaque
 *     BLACK, so every sector arc, ring, leg and outline would have gone black
 *     — on the boat, at night, with `just check` green.
 *   - `core/layers/signalkShips.ts`'s `alpha()` returned the token UNCHANGED,
 *     dropping the halo alpha, so every hand-stroked AIS/own-ship halo would
 *     have gone opaque.
 *
 * Both now take their notation from `colors.ts`'s `s52ColourToRgb`, and that
 * is what this file tests. It tests the shared function rather than the two
 * call sites because `MapView.test.ts` `mock.module`s BOTH of those modules
 * and bun leaks a module mock across every file in the run — importing either
 * here would test a stub, or explode, depending on file order.
 *
 * The point is the NUMBERS: both notations of the same colour must give the
 * same channels, so a future format change cannot pass by rendering wrong
 * quietly.
 */
import { describe, expect, test } from "bun:test";
import { formatThemeColour, isColourValue, parseThemeColour, s52ColourToHex, s52ColourToRgb } from "./colors";
import { BUNDLED_THEMES } from "./themes/bundled.generated";

describe("s52ColourToRgb", () => {
  test("hex and rgb() give the same channels", () => {
    expect(s52ColourToRgb("#f15469")).toEqual([241, 84, 105]);
    expect(s52ColourToRgb("rgb(241, 84, 105)")).toEqual([241, 84, 105]);
  });

  test("alpha is dropped, not honoured — both consumers apply their own", () => {
    // The sector layer premultiplies downstream (`tint`), and the ship halos
    // pass a float alpha of their own. An alpha arriving through the colour
    // string would be wrong in both.
    expect(s52ColourToRgb("#f1546980")).toEqual([241, 84, 105]);
    expect(s52ColourToRgb("rgba(241, 84, 105, 0.5)")).toEqual([241, 84, 105]);
  });

  test("undefined — not black, not a throw — for a value it cannot read", () => {
    // `undefined` so each caller picks its own degradation: the WebGL layer
    // falls back to black rather than dying mid-render, the canvas halo keeps
    // the token. A throw would take a render frame with it.
    expect(s52ColourToRgb("chartreuse")).toBeUndefined();
    expect(s52ColourToRgb("#fffff")).toBeUndefined();
  });

  test("no bundled theme's S-52 table is unreadable", () => {
    // The regression this file exists for, stated directly: a token that does
    // not parse is a black sector arc and an opaque ship halo in that theme.
    for (const t of BUNDLED_THEMES) {
      for (const [token, value] of Object.entries(t.s52)) {
        expect(s52ColourToRgb(value), `${t.id}.${token} = ${value}`).toBeDefined();
      }
    }
  });
});

describe("the shared parser accepts what a theme can hold", () => {
  test("8-digit hex parses, with the alpha dropped for chartcore's address form", () => {
    expect(s52ColourToHex("#ffffffe6")).toBe("ffffff");
    expect(s52ColourToHex("#0f172a2e")).toBe("0f172a");
    // Short forms still expand, alpha nibble included.
    expect(s52ColourToHex("#abc")).toBe("aabbcc");
    expect(s52ColourToHex("#abcd")).toBe("aabbcc");
  });

  test("isColourValue accepts 8-digit hex — the theme editor paints swatches with it", () => {
    // `ThemeEditorSection` runs EVERY editable row through this to decide
    // swatch vs dashed empty box, and the halo rows are 8-digit now.
    for (const v of ["#ffffffe6", "#0f172a2e", "#abcd", "rgba(255,255,255,0.9)"]) {
      expect(isColourValue(v), v).toBe(true);
    }
    for (const v of ["#fffff", "#", "chartreuse", ""]) expect(isColourValue(v), v).toBe(false);
  });
});

/**
 * THE THEME EDITOR'S PICKER (task llouxtpw), pinned at the same seam and for
 * the same reason: `ui/ColorPicker.tsx` seeds a Kobalte `Color` from a theme
 * string and writes one back, and if that pair is not lossless then OPENING
 * the picker on a halo and touching one channel flattens its alpha — a silent
 * failure of exactly the kind the top of this file records.
 *
 * Tested here, on `colors.ts`, rather than through the component: the
 * component is a Kobalte composition with no logic of its own beyond these two
 * calls, and this file is already the mock-leak-free place to test them.
 */
describe("parseThemeColour / formatThemeColour round-trip", () => {
  test("every colour in every bundled theme survives byte-identically", () => {
    // The whole corpus, not a spot check: 12 themes × ~100 values, including
    // the 76 alpha-bearing ones. A picker opened and closed without a drag
    // must give back the file's own string.
    const strings = (node: unknown): string[] => {
      if (typeof node === "string") return [node];
      if (Array.isArray(node)) return node.flatMap(strings);
      if (node && typeof node === "object") return Object.values(node).flatMap(strings);
      return [];
    };
    let checked = 0;
    let withAlpha = 0;
    for (const t of BUNDLED_THEMES) {
      for (const value of strings(t)) {
        if (!isColourValue(value)) continue; // id/label/spritePrefix/fonts
        const parsed = parseThemeColour(value);
        expect(parsed, value).toBeDefined();
        expect(formatThemeColour(parsed!), value).toBe(value);
        checked++;
        if (value.length === 9) withAlpha++;
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(withAlpha).toBe(76);
  });

  test("the alpha BYTE decides the notation, not the float", () => {
    // `#rrggbb` when the byte is `ff`, `#rrggbbaa` otherwise — so the export
    // stays paste-ready into a theme JSON and never grows a pointless `ff`.
    expect(formatThemeColour(parseThemeColour("#c545c3")!)).toBe("#c545c3");
    expect(formatThemeColour(parseThemeColour("#c545c3ff")!)).toBe("#c545c3");
    expect(formatThemeColour(parseThemeColour("#c545c300")!)).toBe("#c545c300");
    // The sweep's own rounding, restated from this side: 0.9 -> e6, 0.18 -> 2e.
    expect(formatThemeColour(parseThemeColour("rgba(255, 255, 255, 0.9)")!)).toBe("#ffffffe6");
    expect(formatThemeColour(parseThemeColour("rgba(15, 23, 42, 0.18)")!)).toBe("#0f172a2e");
    // A float that rounds to `ff` emits SIX digits, not `#rrggbbff`.
    expect(formatThemeColour(parseThemeColour("rgba(197, 69, 195, 0.999)")!)).toBe("#c545c3");
  });

  test("uppercase in, lowercase out — the theme files are lowercase", () => {
    expect(formatThemeColour(parseThemeColour("#C545C3")!)).toBe("#c545c3");
    expect(formatThemeColour(parseThemeColour("#FFFFFFE6")!)).toBe("#ffffffe6");
  });

  test("a half-typed value is undefined, never a throw", () => {
    // The picker's trigger is not rendered in this state, but `parseColor`
    // throws and this is called from an event handler — a throw there would
    // take the settings panel down mid-keystroke.
    for (const v of ["#c5", "", "chartreuse", "hsl(0, 100%, 50%)"]) {
      expect(parseThemeColour(v), v).toBeUndefined();
    }
  });

  test("an HSB round-trip keeps the hue through black", () => {
    // Why the picker holds the Color object rather than re-deriving it from
    // the committed string: hex cannot say "black, but still red underneath".
    const red = parseThemeColour("#ff0000")!.toFormat("hsb");
    const black = red.withChannelValue("brightness", 0);
    expect(formatThemeColour(black)).toBe("#000000");
    expect(formatThemeColour(black.withChannelValue("brightness", 100))).toBe("#ff0000");
  });
});
