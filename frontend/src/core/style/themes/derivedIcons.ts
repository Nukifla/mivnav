// Six icon roles are NOT authored — they ARE the theme's own S-52 token,
// computed at theme-install time and winning unconditionally over any
// authored value. See docs/architecture/derived-icon-roles.md for why.

import type { S52Colors } from "../s52Tables.generated";
import { ICON_ROLES, type IconRole, type IconRoleColors } from "./iconRoles";
import type { AuthoredThemeDef, ThemeDef } from "./types";

/** Role → the S-52 token it IS (not resembles); `lit-white`→LITYW and
 * `warn-magenta`→CHMGD mirror upstream quirks sharing one hex. `obj-*` is
 * excluded — it varies independently of light color. */
export const DERIVED_ICON_ROLES = {
  "lit-red": "LITRD",
  "lit-green": "LITGN",
  "lit-yellow": "LITYW",
  "lit-white": "LITYW",
  "obj-magenta": "CHMGD",
  "warn-magenta": "CHMGD",
} as const satisfies Partial<Record<IconRole, keyof S52Colors>>;

/** The six roles no theme authors. */
export type DerivedIconRole = keyof typeof DERIVED_ICON_ROLES;

export const DERIVED_ICON_ROLE_NAMES = Object.keys(DERIVED_ICON_ROLES) as readonly DerivedIconRole[];

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/;

/** Duplicates `colors.ts`'s `s52ColourToHex` rather than importing it — that
 * module imports this one, so importing back would cycle. */
export function s52TokenToIconHex(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  const hex = HEX.exec(s);
  if (hex) {
    const h = hex[1].toLowerCase();
    return "#" + (h.length === 3 ? h.replace(/./g, (c) => c + c) : h);
  }
  const m = RGB.exec(s);
  if (!m) return undefined;
  const byte = (n: string) => Math.min(255, Number(n)).toString(16).padStart(2, "0");
  return `#${byte(m[1])}${byte(m[2])}${byte(m[3])}`;
}

/**
 * The six derived roles for one S-52 table. A missing/unparseable token
 * yields no entry, so the caller keeps whatever it had rather than a broken
 * paint value.
 */
export function derivedIconRoles(s52: Partial<S52Colors> | undefined): Partial<IconRoleColors> {
  const out: Partial<IconRoleColors> = {};
  if (!s52) return out;
  for (const role of DERIVED_ICON_ROLE_NAMES) {
    const hex = s52TokenToIconHex(s52[DERIVED_ICON_ROLES[role]]);
    if (hex !== undefined) out[role] = hex;
  }
  return out;
}

/** The one place a theme set enters the app (`./source.ts`) — every
 * downstream consumer sees the merged value already. */
export function resolveTheme(theme: AuthoredThemeDef): ThemeDef {
  const icons = { ...ARTWORK_FLOOR, ...theme.icons, ...derivedIconRoles(theme.s52) } as IconRoleColors;
  return { ...theme, icons };
}

/** Fallback hex for the six derived roles when a hand-edited theme's S-52
 * table is missing/malformed (`isUsable` doesn't require completeness).
 * Unreachable for the shipped twelve — pinned by `derivedIcons.test.ts`. */
const ARTWORK_FLOOR: Partial<IconRoleColors> = Object.fromEntries(
  ICON_ROLES.filter((r) => (DERIVED_ICON_ROLE_NAMES as readonly string[]).includes(r.role)).map((r) => [r.role, r.day]),
);
