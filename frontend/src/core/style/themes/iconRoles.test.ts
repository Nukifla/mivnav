/**
 * The role vocabulary is a CONTRACT WITH RUST, not a frontend table.
 *
 * chartcore bakes `#fe00XX` sentinels into every roles-mode render off
 * `icons/roles.rs`, which is itself pinned against
 * `chartcore/assets/s52-icons/icon-roles.json` by its own test. This file is
 * generated from that same JSON — so the check that matters is that it has not
 * drifted, plus that the substitution does what the sentinel scheme promises.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMITTED_ICON_ROLES,
  ICON_ROLES,
  ICON_SENTINEL_PREFIX,
  iconRoleSentinel,
  substituteIconRoles,
  type IconRoleColors,
} from "./iconRoles";

const json = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "..", "..", "..", "..", "chartcore", "assets", "s52-icons", "icon-roles.json"),
    "utf8",
  ),
) as {
  sentinel_prefix: string;
  roles: Record<string, { index: string; day: string }>;
  $emission: { never_emitted: string[] };
};

describe("the generated table matches icon-roles.json", () => {
  test("same roles, same order, same indices and day values", () => {
    expect(ICON_ROLES.map((r) => r.role)).toEqual(Object.keys(json.roles));
    for (const r of ICON_ROLES) {
      expect(r.index, r.role).toBe(json.roles[r.role].index);
      expect(r.day, r.role).toBe(json.roles[r.role].day);
    }
    expect(ICON_SENTINEL_PREFIX).toBe(json.sentinel_prefix);
  });

  test("`emitted` matches the JSON's own measured $emission block", () => {
    const never = new Set(json.$emission.never_emitted);
    for (const r of ICON_ROLES) expect(r.emitted, r.role).toBe(!never.has(r.role));
    expect(EMITTED_ICON_ROLES.length).toBe(ICON_ROLES.length - never.size);
  });

  test("every sentinel is 7 chars in the reserved block, and unique", () => {
    const seen = new Set<string>();
    for (const r of ICON_ROLES) {
      const s = iconRoleSentinel(r.index);
      expect(s).toMatch(/^#fe00[0-9a-f]{2}$/);
      expect(seen.has(s), r.role).toBe(false);
      seen.add(s);
    }
  });
});

describe("substituteIconRoles", () => {
  const ink = iconRoleSentinel(ICON_ROLES.find((r) => r.role === "ink")!.index);
  const red = iconRoleSentinel(ICON_ROLES.find((r) => r.role === "obj-red")!.index);

  test("replaces every occurrence of a role's sentinel", () => {
    const svg = `<path fill="${red}"/><path stroke="${ink}"/><path fill="${red}"/>`;
    const out = substituteIconRoles(svg, { ink: "#111111", "obj-red": "#aa0000" });
    expect(out).toBe('<path fill="#aa0000"/><path stroke="#111111"/><path fill="#aa0000"/>');
  });

  test("roles that share a DAY hex stay separable", () => {
    // `lit-white`/`lit-yellow` are both #fab20b on day, `obj-magenta` and
    // `warn-magenta` both #ec008c — a faithful upstream quirk. Substituting on
    // the day VALUE instead of the sentinel would collapse them, which is
    // exactly what a paper theme wants to avoid.
    const magenta = iconRoleSentinel(ICON_ROLES.find((r) => r.role === "obj-magenta")!.index);
    const warn = iconRoleSentinel(ICON_ROLES.find((r) => r.role === "warn-magenta")!.index);
    const out = substituteIconRoles(`${magenta}|${warn}`, {
      "obj-magenta": "#111111",
      "warn-magenta": "#222222",
    });
    expect(out).toBe("#111111|#222222");
  });

  test("a role with no entry in the theme is left alone, not defaulted", () => {
    expect(substituteIconRoles(ink, {})).toBe(ink);
  });

  test("the never-emitted roles cost nothing and change nothing", () => {
    const never = ICON_ROLES.filter((r) => !r.emitted);
    expect(never.length).toBeGreaterThan(0);
    const colors = Object.fromEntries(never.map((r) => [r.role, "#123456"])) as Partial<IconRoleColors>;
    expect(substituteIconRoles(`<path fill="${red}"/>`, colors)).toBe(`<path fill="${red}"/>`);
  });

  test("case-insensitive — the lowercase notation usvg emits is not a guarantee", () => {
    expect(substituteIconRoles(ink.toUpperCase(), { ink: "#111111" })).toBe("#111111");
  });
});
