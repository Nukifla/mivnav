// THE THEME BARREL. `THEMES`/`THEME_BY_ID` are REBUILT IN PLACE — ~60 modules
// hold the imported binding, so object identities must survive (see
// docs/architecture/theme-runtime-source.md). Chrome CSS is NOT here: it rides `GET /api/themes.css`.

import type { Palette } from "../colors";
import { onThemesChanged, themeList } from "./source";
import type { ThemeDef } from "./types";

export type {
  BasemapColors,
  BasemapTint,
  ContourWidth,
  NoticesColors,
  OverlayColors,
  PoiColors,
  RasterDim,
  RouteOverlayColors,
  TextHalo,
  ThemeDef,
  VesselColors,
  ThemeFonts,
} from "./types";

export {
  EMITTED_ICON_ROLES,
  ICON_ROLES,
  ICON_SENTINEL_PREFIX,
  iconRoleSentinel,
  substituteIconRoles,
  type IconRole,
  type IconRoleColors,
  type IconRoleDef,
} from "./iconRoles";

export {
  loadThemes,
  onThemesChanged,
  resetThemes,
  setThemes,
  themeList,
  THEMES_URL,
  trackThemes,
} from "./source";

// The session-only theme-editor override (task mnsyyonx) — see override.ts's
// own header for why this lives here rather than as a new field on ThemeDef.
export {
  clearThemeOverride,
  getThemeOverride,
  overrideField,
  setThemeOverrideField,
  type ThemeOverridePatch,
} from "./override";

/** Settings-dropdown order (backend pre-orders). Day/dusk/night ROLES first,
 * matching Rail's hardcoded 3-way (`chrome/Launcher.tsx` `PALETTE_MODES`) —
 * those are `paper2`/`graphite2`/`night` ids, not `day`/`dusk` (task uqolozkr). */
export const THEMES: readonly ThemeDef[] = [];

/** Index by id — every derived map in ../colors.ts is one line with this. */
export const THEME_BY_ID: Readonly<Record<Palette, ThemeDef>> = {} as Record<Palette, ThemeDef>;

function rebuild(): void {
  const list = themeList();
  const themes = THEMES as ThemeDef[];
  themes.length = 0;
  themes.push(...list);
  const byId = THEME_BY_ID as Record<string, ThemeDef>;
  for (const key of Object.keys(byId)) delete byId[key];
  for (const t of list) byId[t.id] = t;
}

rebuild();
onThemesChanged(rebuild);
