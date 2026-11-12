// S-52 colour tokens (DAY_BRIGHT/DUSK/NIGHT) plus the one colour that's
// ours (CANVAS). Design rationale, NIGHT-column warning, theme rebuild-in-
// place invariant: docs/architecture/theme-colors.md — read before editing.

import { parseColor, type Color } from "@kobalte/core/colors";
import type { S52Colors } from "./s52Tables.generated";
import { THEME_BY_ID, THEMES } from "./themes";
import type {
  BasemapColors,
  IconRoleColors,
  NoticesColors,
  OverlayColors,
  PoiColors,
  RouteOverlayColors,
  TextHalo,
  ThemeFonts,
} from "./themes";
import { onThemesChanged, trackThemes } from "./themes/source";
import { overrideField } from "./themes/override";

/** Which colour table the chart/chrome draw from ("theme" to the mariner).
 * A HAND-WRITTEN UNION: deriving it (`THEMES[number]["id"]`) would collapse
 * to `string`, losing typo-checking. See docs/architecture/theme-colors.md. */
export type Palette =
  | "day"
  | "dusk"
  | "night"
  | "whiteback"
  | "blackback"
  | "slick"
  | "paper"
  | "paper2"
  | "graphite"
  | "graphite2"
  | "sunset"
  | "vintage"
  | "modern-paper-2"
  | "modern-paper-2-night-dim"
  | "modern-paper-2-night-red"
  | "modern-paper-2-moonlight";

/** Every palette, in switch order — the backend's `/themes` order: the
 * day/dusk/night ROLES first (an id here is not a role; see
 * docs/architecture/theme-colors.md), then the rest. REBUILT IN PLACE. */
export const PALETTES: readonly Palette[] = [];

/** One palette's colour table: the S-52 tokens, plus our CANVAS. */
export type S52Table = S52Colors & {
  /** The empty canvas under everything, before any tile has painted. Not an
   * S-52 colour — see each theme JSON's own `canvas` field for why it exists
   * and why every theme needs its own. */
  CANVAS: string;
};

/** The colour tables, one per palette — each theme's `s52` plus its own
 * `canvas`. */
export const S52_PALETTES: Record<Palette, S52Table> = {} as Record<Palette, S52Table>;

/** The DAY_BRIGHT table, under its original name — kept as an alias because
 * `info/highlightFill.test.ts` reasons in CIEDE2000 over day shades
 * specifically. CONTENTS refilled on theme change, not a re-pointed reference. */
export const S52_COLORS: S52Table = {} as S52Table;

/** The colour table for a palette, with the theme editor's session-only
 * overrides merged in (`themes/override.ts`): CANVAS plus any touched S-52
 * tokens, spread OVER the theme's table so untouched tokens keep their value. */
export function paletteColors(palette: Palette): S52Table {
  trackThemes();
  const base = S52_PALETTES[palette] ?? S52_PALETTES.day;
  const canvas = overrideField(palette, "canvas");
  const s52 = overrideField(palette, "s52");
  if (canvas === undefined && s52 === undefined) return base;
  return {
    ...base,
    // UNPARSEABLE ENTRIES DROPPED, not passed through: the editor's free-text
    // fields are invalid mid-keystroke, and `s52ColourToHex` throws on those.
    // Guarded HERE so it holds for every writer, not just today's one UI.
    ...(s52 ? Object.fromEntries(Object.entries(s52).filter(([, v]) => isColourValue(v))) : {}),
    ...(canvas !== undefined ? { CANVAS: canvas } : {}),
  };
}

/** Does this text parse as a colour `s52ColourToHex` can read? `#rrggbbaa`
 * covers alpha-bearing theme values (8-digit hex); `rgb()`/`rgba()` stay
 * accepted for free-text editor fields and pre-sweep hand-written themes. */
export function isColourValue(v: string): boolean {
  const s = v.trim();
  return (
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ||
    /^rgba?\(\d+,\s*\d+,\s*\d+(,\s*[\d.]+)?\)$/.test(s)
  );
}

/** A theme colour value as a Kobalte `Color` for the picker — `undefined`,
 * never a throw, for text that's not (yet) a colour. `isColourValue` gates
 * it rather than try/catch alone: Kobalte accepts notations a theme mustn't. */
export function parseThemeColour(value: string): Color | undefined {
  if (!isColourValue(value)) return undefined;
  try {
    return parseColor(value.trim());
  } catch {
    return undefined;
  }
}

/** The inverse: a picker's `Color` back as `#rrggbb`/`#rrggbbaa`, lowercase —
 * paste-ready into theme JSON. THE 8-BIT ALPHA BYTE DECIDES, not the float
 * (`alpha === 1` misses 0.999->`ff`); pinned in `themeColourParsers.test.ts`. */
export function formatThemeColour(color: Color): string {
  const hexa = color.toString("hexa").toLowerCase();
  return hexa.endsWith("ff") ? hexa.slice(0, 7) : hexa;
}

/** Any theme colour as a bare lowercase `rrggbb` triple — the address form
 * chartcore's `icons::resolve` wants (`TSS-arrow,c545c3`; `resolve_literal`
 * in mod.rs). ALPHA IS DROPPED. See docs/architecture/theme-colors.md. */
export function s52ColourToHex(rgb: string): string {
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(rgb.trim());
  if (hex) {
    const h = hex[1].toLowerCase();
    // Short forms expand a nibble per channel; the alpha nibble/byte is then
    // sliced off, so #rgba and #rrggbbaa reduce to their opaque triple.
    const full = h.length <= 4 ? h.replace(/./g, (c) => c + c) : h;
    return full.slice(0, 6);
  }
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/.exec(rgb.trim());
  if (!m) throw new Error(`s52ColourToHex: not a "#rrggbb"/"#rrggbbaa" or "rgb(r, g, b)" value: ${rgb}`);
  const [, r, g, b] = m;
  const byte = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `${byte(r)}${byte(g)}${byte(b)}`;
}

/** Same value as three 0-255 channels, `undefined` if not a colour — for
 * callers that paint every frame. Mockable-module-free by design; see
 * docs/architecture/theme-colors.md. */
export function s52ColourToRgb(value: string): [number, number, number] | undefined {
  let hex: string;
  try {
    hex = s52ColourToHex(value);
  } catch {
    return undefined;
  }
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

// Overlay/marker/canvas literals: surfaces that CANNOT read a CSS variable
// (WebGL paint, Canvas-2D, SVG) — hex lives here, enforced by
// style/theming.gate.test.ts. See docs/architecture/theme-colors.md.

/** S-52's "chart annotating itself" magenta — marker ring, highlight wash,
 * go-to pin. **The theme's own CHMGD, not a literal** (replaces hardcoded
 * `#c800c8`, task uqosnyyv). Rejected rivals: docs/architecture/theme-colors.md. */
export function markerMagenta(palette: Palette): string {
  return paletteColors(palette).CHMGD;
}

/** White halo behind the magenta marker/highlight glow — the DAY value; the
 * on-chart crosshair/marker halos adapt via `OVERLAY_COLORS[palette].markerHalo`
 * instead. Still used bare for the delete × cross (sits on an opaque badge). */
export const MARKER_HALO = "#ffffff";

/** DEBUG cell-coverage overlay: bright cyan, distinct from the chart's own
 * magenta and maplibre's red tile grid. Diagnostic only. */
export const DEBUG_CELL = "#00d5ff";
export const DEBUG_CELL_HALO = "#000000";

/** The "this stretch is a guess, not a real route" warning: any leg of a
 *  plan `chartcore.shortest_path` couldn't actually verify (start/end
 *  itself inside charted danger, unreachable at all, or a leg anywhere in
 *  the middle the exact per-leg re-check flagged —
 *  `PlanResponse.approximate_legs`) draws dashed in this colour instead
 *  of the ordinary route line. Bare, not per-palette,
 *  same reasoning as `DEBUG_CELL` above: a route-planning warning must
 *  read unambiguously on day or night alike, the same instinct that keeps
 *  every AIS/anchor `alarm` chrome token in the same saturated-red family
 *  across every bundled theme — a fixed, distinct hue costs nothing a
 *  themed one would have bought here. */
export const ROUTE_WARNING = "#ff8a00";
export const ROUTE_WARNING_HALO = "#000000";
/** The anchor watch while it alarms (features/anchor/overlay.ts) — the
 *  `--color-alarm` value, which WebGL paint cannot read as a var. Bare, not
 *  per-palette, for the same reason as `ROUTE_WARNING`: a dragging anchor
 *  must read as the same red as the alarm band on day or night alike. */
export const ANCHOR_ALARM = "#dc2626";
/** The stroke/glyph that reads against a solid `ROUTE_WARNING` badge fill
 *  (routeTest's "check manually" marker) — bare white, same "fixed, not
 *  per-palette" reasoning as `ROUTE_WARNING` itself: a badge sitting on
 *  its own opaque colour spends no dark-adaptation budget the way
 *  `MARKER_HALO`'s themed variants (drawn directly over the chart) must. */
export const ROUTE_WARNING_CONTRAST = "#ffffff";

/** DEBUG routing overlay ("Test a route", `features/routeTest`,
 *  #owqqcdqe 2026-08-10): the exact hazard geometry and search box a
 *  plan actually used, so "why did it put a point there" is a visual
 *  question, not a guess. Bare, not per-palette, same reasoning as
 *  `DEBUG_CELL`/`ROUTE_WARNING` above — a diagnostic layer needs a fixed,
 *  unambiguous read on day or night alike, not a themed one. Three
 *  distinct hues, none reused from an existing layer, so all three can be
 *  on screen together without one reading as another: hazard geometry
 *  (a saturated red, distinct from `ROUTE_WARNING`'s orange and every
 *  alarm-red chrome token — this is charted danger, not a route problem),
 *  the search box (`DEBUG_CELL`'s own cyan family, reused outright: same
 *  role, "here is the box a search actually looked in", as the cell-
 *  coverage overlay's own boundary), and a macro waypoint (violet — the
 *  one thing here that ISN'T hazard or box, so it earns its own hue). */
export const DEBUG_HAZARD_FILL = "#ff3355";
export const DEBUG_HAZARD_LINE = "#ff3355";
export const DEBUG_BBOX_LINE = DEBUG_CELL;
export const DEBUG_MACRO_WAYPOINT = "#a855f7";
export const DEBUG_MACRO_WAYPOINT_HALO = "#000000";

/** The route-test overlay's `"mivnav"` fine-search-failure layer
 *  (`find_artifact_route_debug`, backend). Two parts, both diagnostic, so
 *  both are fixed hues — never themed, same reasoning as the `DEBUG_*`
 *  tokens above.
 *
 *  `CONSTRAINT_CLASS_COLORS` — one hue per constraint class the rejected
 *  leg was built against, chosen only to be told apart at a glance: the
 *  hard block red, the charted-depth family greens, `coverage` blue, the
 *  soft tiers amber/orange, the rest spread across the wheel. Any class
 *  not listed falls back to `CONSTRAINT_CLASS_FALLBACK` grey.
 *
 *  `FIELD_CELL_RGBA` — the search grid raster, `[r, g, b, a]` per
 *  `DebugField.codes` value. Open water is fully transparent so the grid
 *  reads as "what was in the way", not a wash; `unknown-blocked` (the
 *  usual reason a leg is rejected — outside `M_COVR` with no charted
 *  depth) is the most opaque. `FIELD_START_RGB` / `FIELD_GOAL_RGB` mark
 *  the snapped endpoints opaque. */
export const CONSTRAINT_CLASS_COLORS: Record<string, string> = {
  hard: "#e02424",
  charted_depth: "#16a34a",
  coverage: "#2563eb",
  depth_avoid: "#f97316",
  depth_soft: "#facc15",
  unsurveyed: "#a855f7",
  caution: "#eab308",
  cable: "#db2777",
  tss: "#0891b2",
  preferred: "#22c55e",
  survey: "#8b5cf6",
  atba: "#dc2626",
  check_manually: "#f59e0b",
};
export const CONSTRAINT_CLASS_FALLBACK = "#9ca3af";
export const FIELD_CELL_RGBA: Record<number, [number, number, number, number]> = {
  0: [0, 0, 0, 0],
  1: [224, 36, 36, 150],
  2: [249, 115, 22, 165],
  3: [13, 148, 136, 120],
  4: [250, 204, 21, 90],
};
export const FIELD_START_RGB: [number, number, number] = [56, 189, 248];
export const FIELD_GOAL_RGB: [number, number, number] = [217, 70, 239];
// Same two colours as hex, for the RAW query-point markers drawn on the
// GeoJSON debug source (`overlay.ts`'s `legEndpoint` features) — plotted
// regardless of whether the search actually snapped that end (a
// `goal_blocked` leg has no `goalCell` to mark inside the raster at all,
// so this is the only on-map indicator of where that leg's goal really
// was).
export const FIELD_START_HEX = "#38bdf8";
export const FIELD_GOAL_HEX = "#d946ef";
export const FIELD_ENDPOINT_STROKE = "#ffffff";

/** Lat/long graticule: a translucent grey (not a token) so it sits visually
 * *under* the chart's own linework — a reference lattice, not chart data. */
export const GRID_LINE = "rgba(70,70,70,0.55)";
export const GRID_LABEL = "rgba(40,40,40,0.9)";
export const GRID_HALO = "rgba(255,255,255,0.85)";

/** Wind-flow canvas trail fade colour, painted at low alpha under
 * `destination-in` — only alpha matters, hue is irrelevant. */
export const CANVAS_FADE_MASK = "#000";

/** Dark readout-badge backdrop + light text, deliberately always dark so a
 * glanced value stays legible over any palette (--color-on-scrim in CSS). */
export const SCRIM_BG = "rgba(0,0,0,0.75)";
export const SCRIM_FG = "#ffffff";

export type { BasemapColors, NoticesColors, OverlayColors, PoiColors, RouteOverlayColors, ThemeFonts } from "./themes";

/** The route overlay's colours per palette — a WebGL paint property can't
 * resolve a CSS var, so these MIRROR --color-route/--color-accent that
 * index.css sets; `themes/index.test.ts` asserts every theme's block agrees. */
export const ROUTE_OVERLAY_COLORS: Record<Palette, RouteOverlayColors> = {} as Record<Palette, RouteOverlayColors>;

/** The route overlay colours for a palette, merging the theme editor's
 * session-only override the way `overlayColors`/`poiColors` do. */
export function routeOverlayColors(palette: Palette): RouteOverlayColors {
  trackThemes();
  const base = ROUTE_OVERLAY_COLORS[palette] ?? ROUTE_OVERLAY_COLORS.day;
  return overrideField(palette, "routeOverlay") ?? base;
}

/** The crosshair / measure overlay colours per palette — an SVG stroke and
 * WebGL paint property can't resolve a CSS var, so hex lives here. `halo` is
 * the measure line's halo; `markerHalo` is the crosshair rings' opaque one. */
export const OVERLAY_COLORS: Record<Palette, OverlayColors> = {} as Record<Palette, OverlayColors>;

/** The overlay colours for a palette, falling back to day for an unknown value
 *  (the palette can arrive from an opaque profile blob — see `paletteColors`). */
export function overlayColors(palette: Palette): OverlayColors {
  trackThemes();
  const base = OVERLAY_COLORS[palette] ?? OVERLAY_COLORS.day;
  return overrideField(palette, "overlay") ?? base;
}

/** The OSM POI overlay colours per palette (features/poi/overlay.ts): marker
 * fill by `kind`, fallback `other`, name `label`. `label` paints nothing
 * today (names moved to the basemap, task nvpxzxxq) but stays as a theme field. */
export const POI_COLORS: Record<Palette, PoiColors> = {} as Record<Palette, PoiColors>;

/** The POI colours for a palette, day-fallback like `overlayColors`. */
export function poiColors(palette: Palette): PoiColors {
  trackThemes();
  const base = POI_COLORS[palette] ?? POI_COLORS.day;
  return overrideField(palette, "poi") ?? base;
}

/** The Notices to Mariners overlay colours per palette (`features/notices`).
 * Only themes that declare a `notices` block appear here — the field is
 * optional on the wire so a user theme predating it still loads. */
export const NOTICES_COLORS: Partial<Record<Palette, NoticesColors>> = {};

/** Last-resort notices colours, used only if even day lacks the block (a live
 * theme set that dropped it everywhere). Every bundled theme carries its
 * own; this just keeps the overlay from painting `undefined`. */
const NOTICES_FALLBACK: NoticesColors = {
  warning: "#e0561b",
  firing: "#d4202a",
  temporary: "#c026d3",
  preliminary: "#c026d3",
  permanent: "#6d4fc2",
  inactive: "#7d898c",
  badge: "#ffffff",
  label: "#1f2937",
  halo: "#ffffff",
};

/** The notices colours for a palette: the theme's own block, else day's, else
 * the fallback above; the theme editor's session override spreads OVER it (a
 * user theme without the block seeds the editor with a partial object). */
export function noticesColors(palette: Palette): NoticesColors {
  trackThemes();
  const base = NOTICES_COLORS[palette] ?? NOTICES_COLORS.day ?? NOTICES_FALLBACK;
  const patch = overrideField(palette, "notices");
  return patch ? { ...base, ...patch } : base;
}

/** The vector OSM basemap's per-layer colours (`chartStyle.ts`'s `world-*`
 * layers) — replaces the old raster-era `basemapTint` filter now that the
 * basemap is real vector geometry (task usvzsqzu). */
export const BASEMAP_COLORS: Record<Palette, BasemapColors> = {} as Record<Palette, BasemapColors>;

/** The basemap colours for a palette, day-fallback like `poiColors`. */
export function basemapColors(palette: Palette): BasemapColors {
  trackThemes();
  const base = BASEMAP_COLORS[palette] ?? BASEMAP_COLORS.day;
  return overrideField(palette, "basemap") ?? base;
}

/** Per-theme `text-font` stacks — `Partial` since most themes have none;
 * `themeFonts` below is what every consumer actually calls. */
export const THEME_FONTS: Partial<Record<Palette, ThemeFonts>> = {};

/** A palette's font stacks, `{}` (not day's) when it has none — makes
 * `upright ?? TEXT_FONT` the correct fallback everywhere, instead of day's
 * empty choice bleeding into unrelated palettes. */
export function themeFonts(palette: Palette): ThemeFonts {
  trackThemes();
  return THEME_FONTS[palette] ?? {};
}

/** Per-theme text glow — `Partial` like `THEME_FONTS`: the ink-on-paper
 * family (paper/paper2/graphite/graphite2) deliberately has none, a real
 * choice not a default to fill in. */
export const THEME_TEXT_HALO: Partial<Record<Palette, TextHalo>> = {};

/** The `text-halo-*` paint fragment for a palette. `{}` (no keys, not zero
 * width) when the theme has none. CHART SHORTHAND (soundings, "Wk", NATSUR)
 * never spreads this in any theme — pinned by `chartShorthand.test.ts`. */
export function haloPaint(
  palette: Palette,
  color?: string,
): Partial<{ "text-halo-color": string; "text-halo-width": number; "text-halo-blur": number }> {
  trackThemes();
  const halo = THEME_TEXT_HALO[palette];
  if (!halo) return {};
  return {
    "text-halo-color": color ?? halo.color,
    "text-halo-width": halo.width,
    "text-halo-blur": halo.blur ?? 0,
  };
}

/** ROLE -> HEX for icon recolouring (`atonIcons.ts` substitutes it into
 * every symbol SVG before rasterising). Palette-neutral ids + client-side
 * colour fixed the old dusk/night regression of a missing prefixed atlas id. */
export function iconRoleColors(palette: Palette): IconRoleColors {
  trackThemes();
  const base = ICON_COLORS[palette] ?? ICON_COLORS.day;
  const patch = overrideField(palette, "icons");
  return patch ? { ...base, ...patch } : base;
}

/** Each theme's `icons` block, keyed by palette. */
export const ICON_COLORS: Record<Palette, IconRoleColors> = {} as Record<Palette, IconRoleColors>;

/** Display names for the Settings theme dropdown. Lives here (not
 * settings/device.tsx) so it's rebuilt in place — a snapshot taken before
 * `/api/themes` landed would otherwise show the fallback labels forever. */
export const PALETTE_LABELS: Readonly<Record<Palette, string>> = {} as Record<Palette, string>;

/** Refill every map above from the current theme set, IN PLACE — see this
 * file's header and `themes/source.ts` for why identity has to survive. */
function rebuildPaletteMaps(): void {
  const refill = <T>(map: Record<string, T>, value: (t: (typeof THEMES)[number]) => T | undefined): void => {
    for (const key of Object.keys(map)) delete map[key];
    for (const t of THEMES) {
      const v = value(t);
      if (v !== undefined) map[t.id] = v;
    }
  };
  const palettes = PALETTES as Palette[];
  palettes.length = 0;
  palettes.push(...(THEMES.map((t) => t.id) as Palette[]));
  refill(S52_PALETTES, (t) => ({ ...t.s52, CANVAS: t.canvas }));
  refill(ROUTE_OVERLAY_COLORS, (t) => t.routeOverlay);
  refill(OVERLAY_COLORS, (t) => t.overlay);
  refill(POI_COLORS, (t) => t.poi);
  refill(NOTICES_COLORS as Record<string, NoticesColors>, (t) => t.notices);
  refill(BASEMAP_COLORS, (t) => t.basemap);
  refill(ICON_COLORS, (t) => t.icons);
  refill(PALETTE_LABELS as Record<string, string>, (t) => t.label);
  refill(THEME_FONTS as Record<string, ThemeFonts>, (t) => t.fonts);
  refill(THEME_TEXT_HALO as Record<string, TextHalo>, (t) => t.textHalo);
  const day = S52_PALETTES.day;
  for (const key of Object.keys(S52_COLORS)) delete (S52_COLORS as unknown as Record<string, string>)[key];
  if (day) Object.assign(S52_COLORS, day);
}

rebuildPaletteMaps();
onThemesChanged(rebuildPaletteMaps);

export { THEME_BY_ID, THEMES };
