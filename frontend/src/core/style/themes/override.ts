// SESSION-ONLY theme override — the live-preview half of the theme editor
// (settings/ThemeEditorSection.tsx). See docs/architecture/theme-editor.md's
// `override.ts` section for how the patch merges live into the real map.

import { createSignal } from "solid-js";
import type { Palette } from "../colors";
import type { IconRoleColors } from "./iconRoles";
import type { S52Colors } from "../s52Tables.generated";
import type { BasemapColors, BasemapTint, ContourWidth, NoticesColors, OverlayColors, PoiColors, RasterDim, RouteOverlayColors } from "./types";

/** A one-level-deep patch over the editable slice of a `ThemeDef` — each
 * nested key REPLACES the whole sub-object it targets (the editor always
 * writes a complete `overlay`/`poi`/… object, seeded from the theme's own
 * current values), so this stays a plain merge, never a recursive one. */
export interface ThemeOverridePatch {
  canvas?: string;
  routeOverlay?: RouteOverlayColors;
  overlay?: OverlayColors;
  poi?: PoiColors;
  notices?: NoticesColors;
  basemap?: BasemapColors;
  rasterDim?: RasterDim;
  basemapTint?: BasemapTint;
  contourWidth?: ContourWidth;
  /** The icon role table (`./iconRoles.ts`). `Partial`, unlike the groups
   * above: the editor only offers the roles chartcore actually emits, so
   * `colors.ts`'s `iconRoleColors` spreads this OVER the theme's own table
   * rather than replacing it. */
  icons?: Partial<IconRoleColors>;
  /** S-52 chart colour table (`ThemeDef.s52`). `Partial` like `icons`, so the
   * JSON export stays a real diff instead of all 27 tokens restated. */
  s52?: Partial<S52Colors>;
}

interface ThemeOverrideState {
  palette: Palette;
  patch: ThemeOverridePatch;
}

const [themeOverride, setThemeOverrideSignal] = createSignal<ThemeOverrideState | null>(null);

/** Raw override state, for the editor UI and tests. Reading it (directly or
 * via the `overrideXxx` helpers) inside a Solid computation tracks it. */
export function getThemeOverride(): ThemeOverrideState | null {
  return themeOverride();
}

/** Replace one field of the override patch for `palette`. Switching `palette`
 * starts a fresh patch rather than carrying the old theme's edits onto the new one. */
export function setThemeOverrideField<K extends keyof ThemeOverridePatch>(
  palette: Palette,
  field: K,
  value: ThemeOverridePatch[K],
): void {
  setThemeOverrideSignal((prev) => {
    const patch = prev && prev.palette === palette ? { ...prev.patch } : {};
    patch[field] = value;
    return { palette, patch };
  });
}

/** Drop the whole override for `palette` (the editor's "Reset" button). A
 * no-op if the current override belongs to a different palette. */
export function clearThemeOverride(palette: Palette): void {
  setThemeOverrideSignal((prev) => (prev && prev.palette === palette ? null : prev));
}

/** One field of the current override, or `undefined` — the shape every
 * `colors.ts`/`chartStyle.ts` accessor merges on top of the theme's own value. */
export function overrideField<K extends keyof ThemeOverridePatch>(
  palette: Palette,
  field: K,
): ThemeOverridePatch[K] | undefined {
  const o = themeOverride();
  return o && o.palette === palette ? o.patch[field] : undefined;
}
