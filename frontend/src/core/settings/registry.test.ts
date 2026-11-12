/**
 * The CORE settings registry (C3) — the feature-agnostic framework, proved
 * without a DOM (the codebase's idiom: descriptor + reactive-logic assertions,
 * not rendered markup — an on-screen eyeball of the generated panel is a
 * Phase-3 item). Four things the chunk MUST prove are asserted directly here on
 * synthetic descriptors, and again on the real device declarations in
 * `device.test.tsx`:
 *
 *  - `defineSetting`/`defineSettingsSection` enforce the invariants that make
 *    generation safe (a generated control has a total coercer, a read/write
 *    binding, and a coerce-stable default);
 *  - `createSettingsRegistry` indexes + dedups and refuses a mis-wired setting;
 *  - the master/sub `dependsOn` cascade disables the sub when the master is off
 *    (single AND multi-master);
 *  - a declared `coerce` falls a malformed stored value back to the default.
 */

import { describe, expect, test } from "bun:test";
import { coerceBoolean, coerceFiniteNumber } from "../persist";
import Waves from "lucide-solid/icons/waves-horizontal";
import {
  createSettingsRegistry,
  defineSetting,
  defineSettingsSection,
  isSettingEnabled,
  type Setting,
} from "./registry";

interface Ctx {
  values: Record<string, boolean | number | string>;
}
const ctx = (values: Ctx["values"] = {}): Ctx => ({ values });

const toggle = (id: string, def = false, extra: Partial<Setting<Ctx>> = {}): Setting<Ctx> =>
  defineSetting<Ctx>({
    id,
    scope: "device",
    control: { kind: "toggle" },
    label: id,
    group: "g",
    order: 0,
    default: def,
    coerce: (raw) => coerceBoolean(raw, def),
    read: (c) => (c.values[id] as boolean) ?? def,
    write: (c, v) => (c.values[id] = v),
    ...extra,
  });

const section = () => defineSettingsSection<Ctx>({ id: "g", title: "G", icon: Waves, group: "device", order: 0 });

describe("defineSetting — validates and freezes", () => {
  test("a generated control needs coerce + read + write + default", () => {
    const base = { scope: "device", control: { kind: "toggle" }, label: "x", group: "g", order: 0 } as const;
    expect(() => defineSetting<Ctx>({ id: "a", ...base })).toThrow(/coerce/);
    expect(() =>
      defineSetting<Ctx>({ id: "a", ...base, coerce: (r) => coerceBoolean(r, false), default: false }),
    ).toThrow(/read\/write/);
    expect(() =>
      defineSetting<Ctx>({ id: "a", ...base, coerce: (r) => coerceBoolean(r, false), read: () => false, write: () => {} }),
    ).toThrow(/default/);
  });

  test("a default that is not a fixpoint of coerce is refused", () => {
    expect(() =>
      defineSetting<Ctx>({
        id: "a",
        scope: "device",
        control: { kind: "number", min: 0, max: 10, step: 1 },
        label: "x",
        group: "g",
        order: 0,
        default: 5,
        coerce: () => 6, // always returns 6 — 5 is not stable
        read: () => 5,
        write: () => {},
      }),
    ).toThrow(/coerce-stable/);
  });

  test("a number control with min > max, or a non-positive step, is refused", () => {
    const n = (min: number, max: number, step: number) =>
      defineSetting<Ctx>({
        id: "a",
        scope: "device",
        control: { kind: "number", min, max, step },
        label: "x",
        group: "g",
        order: 0,
        default: min,
        coerce: (r) => coerceFiniteNumber(r, min),
        read: () => min,
        write: () => {},
      });
    expect(() => n(10, 0, 1)).toThrow(/min .* max/);
    expect(() => n(0, 10, 0)).toThrow(/step/);
  });

  test("an enum default outside its options is refused", () => {
    expect(() =>
      defineSetting<Ctx>({
        id: "a",
        scope: "device",
        control: { kind: "enum", options: ["x", "y"] },
        label: "x",
        group: "g",
        order: 0,
        default: "z",
        coerce: () => "z",
        read: () => "z",
        write: () => {},
      }),
    ).toThrow(/option/);
  });

  test("a custom control needs neither coerce nor read/write (the escape hatch)", () => {
    expect(() =>
      defineSetting<Ctx>({
        id: "note",
        scope: "device",
        control: { kind: "custom", component: () => null },
        label: "note",
        group: "g",
        order: 0,
      }),
    ).not.toThrow();
  });

  test("the returned descriptor is frozen", () => {
    const s = toggle("a");
    expect(Object.isFrozen(s)).toBe(true);
  });
});

describe("defineSettingsSection", () => {
  test("a generated (non-render) section needs an icon", () => {
    expect(() =>
      defineSettingsSection<Ctx>({ id: "g", title: "G", group: "device", order: 0 }),
    ).toThrow(/icon/);
  });
  test("a render-only section needs no icon", () => {
    expect(() =>
      defineSettingsSection<Ctx>({ id: "g", title: "G", group: "device", order: 0, render: () => null }),
    ).not.toThrow();
  });
});

describe("createSettingsRegistry — indexes, dedups, refuses mis-wiring", () => {
  test("a duplicate setting id throws", () => {
    expect(() => createSettingsRegistry<Ctx>([toggle("a"), toggle("a")], [section()])).toThrow(/duplicate setting/);
  });

  test("a duplicate section id throws", () => {
    expect(() => createSettingsRegistry<Ctx>([], [section(), section()])).toThrow(/duplicate section/);
  });

  test("a setting targeting an unknown section throws", () => {
    expect(() => createSettingsRegistry<Ctx>([toggle("a", false, { group: "nope" })], [section()])).toThrow(
      /unknown section/,
    );
  });

  test("a setting targeting a render-only section throws", () => {
    const rendered = defineSettingsSection<Ctx>({ id: "g", title: "G", group: "device", order: 0, render: () => null });
    expect(() => createSettingsRegistry<Ctx>([toggle("a")], [rendered])).toThrow(/render-only/);
  });

  test("a dependsOn on a setting that does not exist throws", () => {
    expect(() =>
      createSettingsRegistry<Ctx>([toggle("a", false, { dependsOn: { setting: "ghost" } })], [section()]),
    ).toThrow(/dependsOn unknown/);
  });

  test("orderedSections and settingsFor sort by order", () => {
    const s2 = defineSettingsSection<Ctx>({ id: "g2", title: "G2", icon: Waves, group: "device", order: 5 });
    const reg = createSettingsRegistry<Ctx>(
      [toggle("b", false, { order: 20 }), toggle("a", false, { order: 10 })],
      [s2, section()],
    );
    // ascending order: section() is order 0, s2 is order 5 — 0 sorts first.
    expect(reg.orderedSections.map((s) => s.id)).toEqual(["g", "g2"]);
    expect(reg.settingsFor("g").map((s) => s.id)).toEqual(["a", "b"]);
    expect(reg.byId("a")?.id).toBe("a");
    expect(reg.sectionById("g2")?.title).toBe("G2");
  });
});

describe("isSettingEnabled — the master/sub cascade", () => {
  test("a sub is disabled when its single master is off, enabled when on", () => {
    const master = toggle("m", true);
    const sub = toggle("s", true, { dependsOn: { setting: "m" } });
    const reg = createSettingsRegistry<Ctx>([master, sub], [section()]);
    expect(isSettingEnabled(reg, sub, ctx({ m: false }))).toBe(false);
    expect(isSettingEnabled(reg, sub, ctx({ m: true }))).toBe(true);
  });

  test("a sub with TWO masters needs both on (Lights + Text → descriptions)", () => {
    const a = toggle("a", true);
    const b = toggle("b", true);
    const sub = toggle("s", true, { dependsOn: { setting: ["a", "b"] } });
    const reg = createSettingsRegistry<Ctx>([a, b, sub], [section()]);
    expect(isSettingEnabled(reg, sub, ctx({ a: true, b: false }))).toBe(false);
    expect(isSettingEnabled(reg, sub, ctx({ a: false, b: true }))).toBe(false);
    expect(isSettingEnabled(reg, sub, ctx({ a: true, b: true }))).toBe(true);
  });

  test("a setting with no dependsOn is always enabled", () => {
    const s = toggle("s");
    const reg = createSettingsRegistry<Ctx>([s], [section()]);
    expect(isSettingEnabled(reg, s, ctx())).toBe(true);
  });

  test("a custom enabledWhen predicate is honoured", () => {
    const master = defineSetting<Ctx>({
      id: "mode",
      scope: "device",
      control: { kind: "enum", options: ["off", "on"] },
      label: "mode",
      group: "g",
      order: 0,
      default: "off",
      coerce: () => "off",
      read: (c) => (c.values.mode as string) ?? "off",
      write: () => {},
    });
    const sub = toggle("s", true, { dependsOn: { setting: "mode", enabledWhen: (v) => v === "on" } });
    const reg = createSettingsRegistry<Ctx>([master, sub], [section()]);
    expect(isSettingEnabled(reg, sub, ctx({ mode: "off" }))).toBe(false);
    expect(isSettingEnabled(reg, sub, ctx({ mode: "on" }))).toBe(true);
  });
});

describe("coerce — a malformed stored value falls back to the default", () => {
  test("a toggle's declared coerce is total", () => {
    const s = toggle("a", true);
    expect(s.coerce!("not a boolean")).toBe(true);
    expect(s.coerce!(undefined)).toBe(true);
    expect(s.coerce!(false)).toBe(false);
  });

  test("a number's declared coerce rejects NaN/null/strings", () => {
    const s = defineSetting<Ctx>({
      id: "n",
      scope: "device",
      control: { kind: "number", min: 0, max: 20, step: 0.5 },
      label: "n",
      group: "g",
      order: 0,
      default: 6,
      coerce: (raw) => coerceFiniteNumber(raw, 6),
      read: () => 6,
      write: () => {},
    });
    expect(s.coerce!(null)).toBe(6);
    expect(s.coerce!("12")).toBe(6);
    expect(s.coerce!(Number.NaN)).toBe(6);
    expect(s.coerce!(9.5)).toBe(9.5);
  });
});
