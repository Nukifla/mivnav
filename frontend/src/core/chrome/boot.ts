// Everything App.tsx does to this device's chrome config between "it came back
// from localStorage" and "the rail may read it": one step that is silently
// catastrophic if dropped, and one deliberately non-reactive DOM read.

import { adoptDefaults, DEFAULT_CHROME, normalize, type ChromeConfig } from "./config";
import type { Registry } from "./registry";

/**
 * `adoptDefaults` is not optional: `storedSignal` merges only ONE level
 * (persist.ts:26-28), so a stored config replaces `ChromeConfig.bands`
 * wholesale — without this a widget added later silently never appears.
 */
export const bootChrome = (cfg: ChromeConfig, reg: Registry): ChromeConfig =>
  adoptDefaults(normalize(cfg), reg);

/**
 * FIRST-RUN default only; pointer is never consulted again (invariant #10,
 * see docs/architecture/chrome-registry.md). `density` always starts at
 * `DEFAULT_CHROME.density` regardless — only `pointerCoarse` follows the guess.
 */
export const seedDefaults = (coarse: boolean): ChromeConfig => ({
  ...DEFAULT_CHROME,
  pointerCoarse: coarse,
});

/** Read ONCE at boot, non-reactively — not a `media.ts` live signal, on
 * purpose (see `seedDefaults`). Guarded like `media.ts`'s `query()` since
 * this module is imported by a test with no `window`. */
export const coarsePointer = (): boolean =>
  typeof window !== "undefined" &&
  !!window.matchMedia &&
  window.matchMedia("(pointer: coarse)").matches;
