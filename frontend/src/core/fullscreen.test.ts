/**
 * The on-map fullscreen button's show/hide policy across launch contexts. Run
 * with `bun run test` — nothing here is reactive, but the rule is the rule.
 *
 * The button is a manual toggle, so it only earns its place where a manual
 * toggle both works and is wanted:
 *  - iOS Safari/PWA: no Fullscreen API → hidden (it draws edge-to-edge anyway).
 *  - Android installed PWA (manifest `display: fullscreen`, never entered via
 *    our own `requestFullscreen()`) → hidden, the toggle would be redundant.
 *  - Android browser tab / desktop, windowed → shown.
 *  - Entered fullscreen via this very button (Chrome also flips `display-mode:
 *    fullscreen` while `requestFullscreen()` is active) → still shown, so
 *    there's a way to exit.
 */

import { describe, expect, test } from "bun:test";
import { fullscreenButtonVisible } from "./fullscreen";

describe("fullscreenButtonVisible", () => {
  test("iOS (no API) → hidden, regardless of display mode", () => {
    expect(fullscreenButtonVisible(false, false, false)).toBe(false);
    expect(fullscreenButtonVisible(false, true, false)).toBe(false);
  });

  test("Android installed PWA (manifest fullscreen, not our own toggle) → hidden", () => {
    expect(fullscreenButtonVisible(true, true, false)).toBe(false);
  });

  test("Android browser tab / desktop (API present, windowed) → shown", () => {
    expect(fullscreenButtonVisible(true, false, false)).toBe(true);
  });

  test("entered fullscreen via our own button (display-mode flips too) → still shown", () => {
    expect(fullscreenButtonVisible(true, true, true)).toBe(true);
  });
});
