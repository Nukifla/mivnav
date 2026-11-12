/**
 * SIX ICON ROLES ARE THE THEME'S OWN S-52 TOKEN — the invariant, pinned.
 *
 * This is the whole point of task otwvprzk. Eleven of the twelve themes
 * already collapsed these two answers into one value; `day` did not, and its
 * icon red/green/yellow/magenta sat a visible deltaE 13–18 away from the
 * LITRD/LITGN/LITYW/CHMGD the chart around them was drawn in. The user's call:
 * merge, S-52 side wins. So the six stopped being authored at all.
 *
 * Three checks, because "the values happen to agree today" is what was true
 * before and it drifted anyway:
 *
 *   1. Every RESOLVED theme's six roles equal its own S-52 token. Resolved,
 *      not `BUNDLED_THEMES` — the bundle is the JSON, which no longer carries
 *      these keys, so a test over it would pass vacuously.
 *   2. No theme JSON on disk authors one. The authoring side is where the
 *      drift would come back (a hand-retuned palette on the boat, a pasted
 *      theme-editor export).
 *   3. Every resolved theme still answers all 35 roles. A role a substitution
 *      cannot answer keeps its raw `#fe00XX` sentinel — a broken icon, not a
 *      graceful fallback.
 */
import { describe, expect, test } from "bun:test";
import { readThemeJson } from "../../../../tools/themes/build-theme-bundle";
import { ICON_ROLES } from "./iconRoles";
import {
  DERIVED_ICON_ROLES,
  DERIVED_ICON_ROLE_NAMES,
  derivedIconRoles,
  resolveTheme,
  s52TokenToIconHex,
} from "./derivedIcons";
import { themeList } from "./source";

describe("every theme's derived icon roles ARE its S-52 tokens", () => {
  for (const theme of themeList()) {
    for (const role of DERIVED_ICON_ROLE_NAMES) {
      const token = DERIVED_ICON_ROLES[role];
      test(`${theme.id}: icons.${role} === s52.${token}`, () => {
        expect(theme.icons[role]).toBe(s52TokenToIconHex(theme.s52[token])!);
      });
    }
  }

  test("day is no longer the holdout it was", () => {
    // The measurement that opened the task, inverted into a guard: these are
    // the presentation-library hexes day used to carry, and they are NOT
    // day's tuned display palette.
    const day = themeList().find((t) => t.id === "day")!;
    expect(day.icons["lit-red"]).not.toBe("#ed1c24");
    expect(day.icons["lit-green"]).not.toBe("#00a650");
    expect(day.icons["lit-yellow"]).not.toBe("#fab20b");
    expect(day.icons["obj-magenta"]).not.toBe("#ec008c");
  });

  test("the two role pairs that share a token resolve to one value", () => {
    // `lit-white`/`lit-yellow` both LITYW, `obj-magenta`/`warn-magenta` both
    // CHMGD — one value until a theme splits them, which needs a second token
    // to split on, not a second hand-authored hex.
    for (const t of themeList()) {
      expect(t.icons["lit-white"], t.id).toBe(t.icons["lit-yellow"]);
      expect(t.icons["obj-magenta"], t.id).toBe(t.icons["warn-magenta"]);
    }
  });
});

describe("the six are not authored anywhere", () => {
  const json = readThemeJson();

  test("no theme JSON spells one out", () => {
    for (const t of json) {
      const icons = t.icons as Record<string, string>;
      for (const role of DERIVED_ICON_ROLE_NAMES) expect(role in icons, `${t.id as string}.${role}`).toBe(false);
    }
  });

  test("each theme JSON authors exactly the other 29 roles", () => {
    const authored = ICON_ROLES.map((r) => r.role).filter(
      (r) => !(DERIVED_ICON_ROLE_NAMES as readonly string[]).includes(r),
    );
    expect(authored.length).toBe(29);
    for (const t of json) expect(Object.keys(t.icons as object).sort(), t.id as string).toEqual([...authored].sort());
  });
});

describe("a resolved theme answers every role", () => {
  const all = ICON_ROLES.map((r) => r.role);
  for (const theme of themeList()) {
    test(`${theme.id}: all 35 roles present, none a sentinel`, () => {
      expect(Object.keys(theme.icons).sort()).toEqual([...all].sort());
      for (const role of all) expect(theme.icons[role], role).toMatch(/^#[0-9a-f]{6}$|^rgba?\(/i);
    });
  }
});

describe("a theme whose S-52 table cannot answer still resolves", () => {
  // The one way a derived role can go missing now that no file authors it: a
  // hand-edited ~/.config/mivnav/themes/*.json with a mistyped token. That
  // passes `source.ts`'s `isUsable` (which checks `s52` is there, not that it
  // is complete), so the floor has to be in `resolveTheme`.
  test("a mistyped token falls back to the artwork hex, never to a raw sentinel", () => {
    const day = themeList().find((t) => t.id === "day")!;
    // As AUTHORED — the six absent, which is what a theme file carries.
    const icons = Object.fromEntries(
      Object.entries(day.icons).filter(([role]) => !(DERIVED_ICON_ROLE_NAMES as readonly string[]).includes(role)),
    );
    const broken = resolveTheme({ ...day, icons, s52: { ...day.s52, LITRD: "#c5", CHMGD: "" } } as never);
    expect(Object.keys(broken.icons).length).toBe(35);
    for (const [role, hex] of Object.entries(broken.icons)) expect(hex, role).not.toContain("#fe00");
    expect(broken.icons["lit-red"]).toBe(ICON_ROLES.find((r) => r.role === "lit-red")!.day);
    expect(broken.icons["obj-magenta"]).toBe(ICON_ROLES.find((r) => r.role === "obj-magenta")!.day);
    // The tokens that DID parse still win over the floor.
    expect(broken.icons["lit-green"]).toBe(day.icons["lit-green"]);
  });
});

describe("s52TokenToIconHex", () => {
  test("the S-52 table's own rgb() notation becomes a hex triple", () => {
    expect(s52TokenToIconHex("rgb(241, 84, 105)")).toBe("#f15469");
    expect(s52TokenToIconHex("rgb(7,7,7)")).toBe("#070707");
  });

  test("a hand-typed hex (the theme editor's free-text S-52 rows) passes through, normalised", () => {
    expect(s52TokenToIconHex("#C545C3")).toBe("#c545c3");
    expect(s52TokenToIconHex("#abc")).toBe("#aabbcc");
  });

  test("an unparseable value yields NO entry rather than a broken paint value", () => {
    // Mid-keystroke in the theme editor. The role then keeps the value it had,
    // which is the same one `paletteColors` is giving the chart.
    expect(s52TokenToIconHex("#c5")).toBeUndefined();
    expect(s52TokenToIconHex(undefined)).toBeUndefined();
    expect(Object.keys(derivedIconRoles({ LITRD: "#c5" } as never))).toEqual([]);
  });
});
