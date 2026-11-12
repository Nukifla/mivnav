// GENERATED from chartcore/assets/s52-icons/icon-roles.json — do not
// hand-edit, iconRoles.test.ts fails on drift. Sentinel hexes `#fe00XX`
// chartcore paints are swapped for the theme's colors before rasterising.

/** One role's sentinel index, as written in `icon-roles.json`. */
export interface IconRoleDef {
  role: IconRole;
  /** Two lowercase hex digits — the tail of the `#fe00XX` sentinel. */
  index: string;
  /** Artwork hex chartcore replaced with the sentinel. NOT necessarily what
   * the `day` THEME renders: 6 roles in `./derivedIcons.ts` differ. */
  day: string;
  /** Whether chartcore actually emits this sentinel — 11 of 35 never do (4
   * `art-grey-*` Inkscape-metadata roles, 7 `lit-*` roles unreachable via an
   * upstream parity bug). Kept for stable indices; a UI must not offer these. */
  emitted: boolean;
}

/** Every role name, exactly as `icon-roles.json` spells it. */
export type IconRole =
  | "obj-white"
  | "obj-black"
  | "obj-red"
  | "obj-green"
  | "obj-blue"
  | "obj-yellow"
  | "obj-grey"
  | "obj-brown"
  | "obj-amber"
  | "obj-violet"
  | "obj-orange"
  | "obj-magenta"
  | "obj-pink"
  | "lit-generic"
  | "lit-white"
  | "lit-red"
  | "lit-green"
  | "lit-blue"
  | "lit-yellow"
  | "lit-orange"
  | "lit-amber"
  | "ink"
  | "paper"
  | "art-ink"
  | "art-black"
  | "art-grey-dark"
  | "art-grey-mid"
  | "art-grey-light"
  | "art-grey-pale"
  | "warn-magenta"
  | "art-green"
  | "art-green-deep"
  | "art-blue-pale"
  | "art-violet"
  | "art-stroke";

/** A theme's `icons` block: one hex per role. */
export type IconRoleColors = Record<IconRole, string>;

/** The sentinel block chartcore reserves — no real artwork hex collides. */
export const ICON_SENTINEL_PREFIX = "#fe00";

export const ICON_ROLES: readonly IconRoleDef[] = [
  { role: "obj-white", index: "00", day: "#ffffff", emitted: true },
  { role: "obj-black", index: "01", day: "#000000", emitted: true },
  { role: "obj-red", index: "02", day: "#ed1c24", emitted: true },
  { role: "obj-green", index: "03", day: "#00a650", emitted: true },
  { role: "obj-blue", index: "04", day: "#10508c", emitted: true },
  { role: "obj-yellow", index: "05", day: "#fab20b", emitted: true },
  { role: "obj-grey", index: "06", day: "#808080", emitted: true },
  { role: "obj-brown", index: "07", day: "#a52a2a", emitted: true },
  { role: "obj-amber", index: "08", day: "#ffbf00", emitted: true },
  { role: "obj-violet", index: "09", day: "#ee82ee", emitted: true },
  { role: "obj-orange", index: "0a", day: "#f7a837", emitted: true },
  { role: "obj-magenta", index: "0b", day: "#ec008c", emitted: true },
  { role: "obj-pink", index: "0c", day: "#ffc0cb", emitted: true },
  { role: "lit-generic", index: "0d", day: "#800080", emitted: true },
  { role: "lit-white", index: "0e", day: "#fab20b", emitted: false },
  { role: "lit-red", index: "0f", day: "#ed1c24", emitted: false },
  { role: "lit-green", index: "10", day: "#00a650", emitted: false },
  { role: "lit-blue", index: "11", day: "#10508c", emitted: false },
  { role: "lit-yellow", index: "12", day: "#fab20b", emitted: false },
  { role: "lit-orange", index: "13", day: "#fa870b", emitted: false },
  { role: "lit-amber", index: "14", day: "#ffbf00", emitted: false },
  { role: "ink", index: "15", day: "#000000", emitted: true },
  { role: "paper", index: "16", day: "#ffffff", emitted: true },
  { role: "art-ink", index: "17", day: "#231f20", emitted: true },
  { role: "art-black", index: "18", day: "#1a1a1a", emitted: true },
  { role: "art-grey-dark", index: "19", day: "#505050", emitted: false },
  { role: "art-grey-mid", index: "1a", day: "#666666", emitted: false },
  { role: "art-grey-light", index: "1b", day: "#d1d1d1", emitted: false },
  { role: "art-grey-pale", index: "1c", day: "#eeeeee", emitted: false },
  { role: "warn-magenta", index: "1d", day: "#ec008c", emitted: true },
  { role: "art-green", index: "1e", day: "#2ea948", emitted: true },
  { role: "art-green-deep", index: "1f", day: "#2e8e20", emitted: true },
  { role: "art-blue-pale", index: "20", day: "#afcce3", emitted: true },
  { role: "art-violet", index: "21", day: "#de44e8", emitted: true },
  { role: "art-stroke", index: "22", day: "#333333", emitted: true },
];

/** The roles a UI may offer a control for — the ones chartcore actually
 * emits. A control for any other role would silently render nothing. */
export const EMITTED_ICON_ROLES: readonly IconRoleDef[] = ICON_ROLES.filter((r) => r.emitted);

/** `#fe00XX` for one role. */
export function iconRoleSentinel(index: string): string {
  return ICON_SENTINEL_PREFIX + index;
}

/**
 * Replace each role sentinel with the theme's hex via the role table (not a
 * `#fe00..` scan), so a missing/unauthored role just keeps its sentinel. NOT
 * keyed on artwork hex — several roles share one (e.g. `lit-white`/
 * `lit-yellow`) and matching on it would collapse them.
 */
export function substituteIconRoles(svg: string, colors: Partial<IconRoleColors>): string {
  let out = svg;
  for (const { role, index } of ICON_ROLES) {
    const hex = colors[role];
    if (!hex) continue;
    out = out.replace(new RegExp(iconRoleSentinel(index), "gi"), hex);
  }
  return out;
}
