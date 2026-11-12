// The JS half of the palette switch: mirrors `ChartSettings.palette` onto
// `:root[data-palette]` so CSS (which can't read a Solid signal) can theme
// the chrome. See docs/architecture/chrome-tokens.md for the full mechanism.

import { createEffect } from "solid-js";
import { rememberSplashColors } from "../splash";
import { PALETTES, type Palette } from "./colors";

/**
 * `day` removes the attribute rather than setting it, since an unattributed
 * root already resolves to the `@theme static` block (docs/architecture/chrome-tokens.md).
 */
export function applyPalette(palette: () => Palette): void {
  createEffect(() => {
    const root = document.documentElement;
    if (palette() === "day") delete root.dataset.palette;
    else root.dataset.palette = palette();
    // Next boot's splash paints in this palette (core/splash.ts).
    rememberSplashColors();
  });
}

/**
 * Inverse of `applyPalette`; scaffolding for one caller (sector-lights).
 * Prefer `settings.palette` for anything new.
 */
export function currentPalette(): Palette {
  const attr = document.documentElement.dataset.palette;
  return (PALETTES as readonly string[]).includes(attr ?? "") ? (attr as Palette) : "day";
}
