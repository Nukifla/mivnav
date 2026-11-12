/**
 * The session-only theme-override signal (task mnsyyonx) — pure logic, no
 * DOM, so it runs under plain `bun test` (no `--conditions=browser` needed).
 * Covers the three things every `colors.ts`/`chartStyle.ts` consumer relies
 * on: a field only applies to the palette it targets, switching palettes
 * starts fresh, and clearing only clears the palette it was asked to.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { clearThemeOverride, getThemeOverride, overrideField, setThemeOverrideField } from "./override";

// The signal is a module-level singleton (deliberately — see override.ts's
// header, it must be reachable from any file without prop-drilling), so
// tests reset it explicitly rather than each getting a fresh instance.
beforeEach(() => {
  clearThemeOverride("day");
  clearThemeOverride("night");
});

describe("theme override", () => {
  test("starts empty", () => {
    expect(getThemeOverride()).toBeNull();
    expect(overrideField("day", "overlay")).toBeUndefined();
  });

  test("a field set for one palette is visible only under that palette", () => {
    setThemeOverrideField("day", "overlay", { accent: "#ff0000", halo: "#fff", markerHalo: "#fff" });
    expect(overrideField("day", "overlay")).toEqual({ accent: "#ff0000", halo: "#fff", markerHalo: "#fff" });
    expect(overrideField("night", "overlay")).toBeUndefined();
  });

  test("setting a second field keeps the first (same palette)", () => {
    setThemeOverrideField("day", "canvas", "#123456");
    setThemeOverrideField("day", "overlay", { accent: "#ff0000", halo: "#fff", markerHalo: "#fff" });
    expect(overrideField("day", "canvas")).toBe("#123456");
    expect(overrideField("day", "overlay")).toBeDefined();
  });

  test("switching the target palette starts a fresh patch, dropping the old one", () => {
    setThemeOverrideField("day", "canvas", "#123456");
    setThemeOverrideField("night", "canvas", "#000000");
    expect(overrideField("day", "canvas")).toBeUndefined();
    expect(overrideField("night", "canvas")).toBe("#000000");
  });

  test("clearThemeOverride only clears the palette it names", () => {
    setThemeOverrideField("day", "canvas", "#123456");
    clearThemeOverride("night"); // different palette — no-op
    expect(overrideField("day", "canvas")).toBe("#123456");
    clearThemeOverride("day");
    expect(overrideField("day", "canvas")).toBeUndefined();
    expect(getThemeOverride()).toBeNull();
  });
});
