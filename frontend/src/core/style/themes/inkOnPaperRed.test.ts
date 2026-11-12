/**
 * The INK-ON-PAPER themes carry NO S-52 electronic magenta.
 *
 * User report, 2026-07-29: *"in the paper and paper2 theme, the magenta should
 * all be replaced with the red color already used for some line drawing"*. The
 * red is `paper2`'s own `TRFCD`, `rgb(196, 40, 40)` — the photographed
 * traffic-separation ink the theme was built from (commit mxwlqqtwmxky), and
 * the token that actually paints line work: TSSBND dashes
 * (`trafficRoutes.ts`), RDOCAL boundaries (`stations.ts`), the LUP-direct
 * dashes in `aidsHazards.ts`. Not `LITRD`, which is a *light* colour.
 *
 * WHAT THIS PINS, and why each half is here rather than trusted:
 *
 *  1. The tokens. `CHMGD`/`CHMGF`/`TRFCF` in both themes must read red, and
 *     no traffic/restricted token in either theme may sit in the magenta hue
 *     band again. Asserted on HUE over the exact token list that moved, not
 *     over the whole theme: `obj-violet`, `art-violet`, `obj-pink`,
 *     `lit-generic`, `chrome.route` and `poi.harbourmaster` are separately
 *     named colours that deliberately stay where they are, and a blanket
 *     sweep would have to allowlist them back one by one.
 *
 *  2. The ICONS, both paths, because "a token moved" does not by itself mean
 *     the artwork followed:
 *       (a) the ROLE SENTINEL path — chartcore serves palette-neutral SVGs
 *           carrying `#fe00XX`, and `substituteIconRoles` swaps in the
 *           theme's `icons` block. `warn-magenta` (IHO chart furniture: TSS
 *           arrows, restricted hatch, the cable/pipeline patterns) and
 *           `obj-magenta` (an S-57 COLOUR=12 buoy) are the two roles whose
 *           day hex is `#ec008c`; both must substitute to the red.
 *       (b) the LITERAL COLOUR OVERRIDE path — `trafficRoutes.ts` and
 *           `cablesPipelines.ts` address chartcore icons as
 *           `<name>,RRGGBB` built from `s52ColourToHex(C.CHMGD)`, and that
 *           override WINS over role substitution. Checked through a real
 *           `buildStyle`, so a change that reached the token but not the
 *           icon key still fails here.
 *
 * The exemption this comment used to record is GONE. The seven traced-HPGL
 * symbols (TSSRON51, TSSCRS51, ITZARE51, LIGHTS81, QUESMRK1, RACNSP01,
 * RCLDEF01) baked `rgb(197,69,195)`/`rgb(211,166,233)` — S-52's CHMGD and
 * CHMGF — and were short-circuited out of role substitution entirely, so they
 * stayed magenta under every theme. chartcore task xytoltso recoloured all of
 * them onto `warn-magenta`, which is one of the two roles (2a) already
 * asserts, so they now move with the rest.
 */
(globalThis as any).location ??= { origin: "http://example.invalid" };

import { describe, expect, test } from "bun:test";
import { iconRoleColors, paletteColors, s52ColourToHex, type Palette } from "../colors";
import { buildStyle } from "../chartStyle";
import { DEFAULT_SETTINGS } from "../settings";
import { iconRoleSentinel, substituteIconRoles, ICON_ROLES } from "./iconRoles";

/** The two themes the report is about. */
const INK_ON_PAPER: Palette[] = ["paper", "paper2"];

/** The red both themes now spend on chart magenta — paper2's own TRFCD. */
const RED_HEX = "c42828";

/** S-52 tokens that must read RED. */
const MOVED_TOKENS = ["CHMGD", "CHMGF", "TRFCF"] as const;
/** Tokens that must merely never be magenta again — the moved three plus
 * TRFCD, whose paper (amber caution) and paper2 (the red itself) values are
 * both deliberate and different. */
const NO_MAGENTA_TOKENS = [...MOVED_TOKENS, "TRFCD"] as const;
/** Icon roles that must read RED — the two whose day hex is `#ec008c`. */
const MOVED_ROLES = ["warn-magenta", "obj-magenta"] as const;

/** `rgb(r, g, b)` or `#rrggbb` -> HSV hue in degrees, and saturation. */
function hsv(colour: string): { hue: number; sat: number } {
  const hex = s52ColourToHex(colour);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { hue, sat: max === 0 ? 0 : d / max };
}

/** Is this a magenta/violet, i.e. the thing the report is about? A saturated
 * hue in [260, 350) — wide enough to catch every value these themes used to
 * carry (CHMGD 305, CHMGF 305/306, the `#b43caa` roles 305) and any retune
 * that drifts back toward one. */
function isMagenta(colour: string): boolean {
  const { hue, sat } = hsv(colour);
  return sat > 0.12 && hue >= 260 && hue < 350;
}

/** Is this a red? Within 20 degrees of pure red, and actually saturated. */
function isRed(colour: string): boolean {
  const { hue, sat } = hsv(colour);
  return sat > 0.2 && (hue <= 20 || hue >= 340);
}

describe("paper/paper2 spend no S-52 magenta", () => {
  test("the moved S-52 tokens read the traffic-separation red", () => {
    for (const palette of INK_ON_PAPER) {
      const C = paletteColors(palette);
      for (const token of MOVED_TOKENS) {
        expect(isRed(C[token]), `${palette}.${token} = ${C[token]}`).toBe(true);
      }
      // CHMGD is the line/boundary ink itself, so it is the red exactly;
      // CHMGF/TRFCF are FILLS and stay the theme's own pale tint of it (the
      // old pale magenta, hue rotated to red with S/V untouched) — they must
      // not collapse onto CHMGD, which is also what keeps
      // `themeEditorReachesChart.test.ts`'s "an untouched token keeps the
      // theme's own value" discriminating.
      expect(s52ColourToHex(C.CHMGD)).toBe(RED_HEX);
      expect(C.CHMGF).not.toBe(C.CHMGD);
      expect(C.TRFCF).not.toBe(C.CHMGD);
    }
  });

  test("no restricted/traffic token in either theme sits in the magenta band", () => {
    for (const palette of INK_ON_PAPER) {
      const C = paletteColors(palette);
      for (const token of NO_MAGENTA_TOKENS) {
        expect(isMagenta(C[token]), `${palette}.${token} = ${C[token]}`).toBe(false);
      }
    }
  });

  test("every other theme keeps its magenta — this is a two-theme change", () => {
    // Guards the guard: a global retune would satisfy everything above while
    // silently repainting the ten themes nobody asked about.
    expect(isMagenta(paletteColors("day").CHMGD)).toBe(true);
    expect(isMagenta(paletteColors("night").CHMGD)).toBe(true);
    expect(isMagenta(paletteColors("graphite").CHMGD)).toBe(true);
  });
});

describe("the artwork follows the tokens, not just the lines and fills", () => {
  test("the two `#ec008c` icon roles substitute to red, and nothing magenta survives", () => {
    for (const palette of INK_ON_PAPER) {
      const colors = iconRoleColors(palette);
      for (const role of MOVED_ROLES) {
        expect(colors[role], `${palette} icons.${role}`).toBe(`#${RED_HEX}`);
      }
      // The real substitution, over a document carrying BOTH sentinels the
      // way a roles-mode render does.
      const sentinels = ICON_ROLES.filter((r) => (MOVED_ROLES as readonly string[]).includes(r.role));
      expect(sentinels.length).toBe(MOVED_ROLES.length);
      const svg = sentinels.map((r) => `<path fill="${iconRoleSentinel(r.index)}"/>`).join("");
      const painted = substituteIconRoles(svg, colors);
      expect(painted).not.toContain("#fe00");
      for (const m of painted.matchAll(/#[0-9a-f]{6}/gi)) {
        expect(isMagenta(m[0]), `substituted ${m[0]} on ${palette}`).toBe(false);
        expect(isRed(m[0]), `substituted ${m[0]} on ${palette}`).toBe(true);
      }
    }
  });

  test("the `,RRGGBB` icon overrides address the red, not the old magenta", () => {
    // The other icon path: chartcore recolours a literal icon to a hex the
    // style build supplies, and that override beats role substitution.
    const CLASSES = ["TSSLPT", "CBLSUB"];
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

    for (const palette of INK_ON_PAPER) {
      const style = buildStyle([SET], { ...DEFAULT_SETTINGS, palette } as never);
      const keys = JSON.stringify(style.layers);
      expect(keys, `${palette} TSS arrow`).toContain(`TSS-arrow,${RED_HEX}`);
      expect(keys, `${palette} cable pattern`).toContain(`cable,${RED_HEX}`);
      // The vendored day magenta must not survive anywhere in the addresses.
      expect(keys).not.toContain(",ec008c");
      expect(keys).not.toContain(",b43caa");
    }
  });
});
