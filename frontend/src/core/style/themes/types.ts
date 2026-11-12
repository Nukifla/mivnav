// The shape ONE theme fills in. Lives on the wire now
// (`backend/mivnav/features/themes/data/*.json`, `GET /api/themes`), not as
// hand-authored TS modules. See docs/architecture/theme-def.md.

import type { S52Colors } from "../s52Tables.generated";
import type { Palette } from "../colors";
import type { IconRoleColors } from "./iconRoles";
import type { DerivedIconRole } from "./derivedIcons";

export interface RouteOverlayColors {
  route: string;
  accent: string;
  halo: string;
  target: string;
}

export interface OverlayColors {
  accent: string;
  halo: string;
  markerHalo: string;
}

export interface PoiColors {
  marina: string;
  fuel: string;
  harbourmaster: string;
  other: string;
  label: string;
}

/** Notices to Mariners overlay (`features/notices`) — Danish EfS/NW from
 * Niord. One colour per message FAMILY: urgency is carried by hue, time
 * state (active/upcoming/ended) by line style and opacity, so it stays
 * legible in every palette. OPTIONAL on the wire so a user theme that
 * predates the feature still loads — `colors.ts`'s `noticesColors` falls
 * back to day's block; every bundled theme sets it. */
export interface NoticesColors {
  /** NW — coastal + local navigational warnings: red/orange, "safety-relevant now". */
  warning: string;
  /** Firing exercise / a firing area that is firing today — red, hatched. */
  firing: string;
  /** NM Temporary (T) — magenta, the S-52 mariner/annotation colour (CHMGD's
   * role) and the classic T&P notice colour. */
  temporary: string;
  /** NM Preliminary (P) — magenta like T, drawn dashed (not happened yet). */
  preliminary: string;
  /** NM Permanent — a chart correction: violet, "your chart differs here". */
  permanent: string;
  /** A permanent firing area that is NOT firing today — thin grey context. */
  inactive: string;
  /** Fill of the round class-icon badge (the glyph and ring take the family colour). */
  badge: string;
  /** shortId / vertex-label text. */
  label: string;
  /** Halo behind that text and around the icon badge. */
  halo: string;
}

/** OSM/satellite raster dimming — `chartStyle.ts` `rasterPaint`. Absent (not
 * `{}`) is a real, load-bearing choice for a theme whose canvas is bright:
 * day/whiteback/slick must diff to no raster-paint keys at all. */
export interface RasterDim {
  brightness: number;
  saturation: number;
}

/** OSM/satellite colour FILTER — `chartStyle.ts` `basemapTintPaint`, never the
 * weather raster wash. `contrast` is MapLibre's `raster-contrast`, clamped to
 * `[-1, 1]` — see the regression test in chartStyle.test.ts. */
export interface BasemapTint {
  hueRotate: number;
  contrast: number;
}

/** Per-layer paint for the vector OSM basemap (`chartStyle.ts`'s `world-*`
 * layers). REQUIRED (unlike `basemapTint`/`rasterDim`): a vector layer has no
 * "untouched" state to opt into. */
export interface BasemapColors {
  /** `world-roads`' `line-color` for motorway/trunk/primary ways (keyed on
   * Protomaps' `kind_detail`). */
  roadMajor: string;
  /** `world-roads`' `line-color` for every other road class. */
  roadMinor: string;
  /** `world-places`' `text-color`. */
  place: string;
  /** `world-places`' `text-halo-color` — the contrast a place label needs
   * against whatever chart ink sits under it, same role as `overlay.halo`. */
  placeHalo: string;
  /** `world-earth`'s `fill-color` — land, at world context zoom. No matching
   * `water` fill: that would be indistinguishable from the unpainted
   * background ("no-coverage is unpainted"), so `land` alone tells them apart. */
  land: string;
  /** `world-boundaries`' `line-color` — country/region administrative
   * lines, deliberately understated: dashed and hairline, so a human line
   * never reads as a physical one (a shore, a contour) at world zoom. */
  boundary: string;
  /** `world-green`'s `fill-color` — parks, woods and forest from Protomaps'
   * `landuse`/`landcover` layers. OPTIONAL, unlike the fields above: absent
   * hides the layer, so every theme that predates it renders byte-for-byte as
   * before. The `modern-paper-2` family sets it, after a consumer chart app's green-on-grey land. */
  green?: string;
  /** When set, `world-roads` becomes a real road rendering instead of a
   * hairline: `roadMajor`/`roadMinor` fill a zoom-widening line and
   * `world-roads-casing` draws this colour as its outline underneath (the
   * white-road-with-grey-edge look). Absent keeps the 0.75 px hairline and
   * hides the casing layer. */
  roadCasing?: string;
}

/** AIS target and own-ship fill colours — `core/layers/aisSymbols.ts`'s
 * `vesselColors`. OPTIONAL: absent keeps `AIS_COLORS`, the fixed
 * palette-independent risk ladder every theme had before this field (see that
 * constant's own comment for why it deliberately ignores S-52's night
 * values). A night theme sets it to the SAME HUES, dimmed — the risk ladder
 * must still read green/yellow/red/grey at a glance, it just must not be the
 * brightest thing on a dark-adapted screen (user, 2026-09-27: targets and own
 * boat "way too bright and not night theme at all"). */
export interface VesselColors {
  green: string;
  yellow: string;
  red: string;
  unknown: string;
  own: string;
  /** A buddy's hull: not a risk colour and not own ship's red, so it reads
   * as "ours" at a glance. A night theme dims it like the rest. */
  buddy: string;
}

/** Depth-contour `line-width` in px — `chartStyle.ts`'s `contourPaint`.
 * Absent means the reference's own 2 (safety) / 1 (other); paper/graphite
 * thins both further for a "minimal ink" look (2026-07-25 user ask). */
export interface ContourWidth {
  safety: number;
  other: number;
}

/**
 * Per-theme `text-font` stacks — `expr.ts`'s `TEXT_FONT` is every theme's
 * default. ALWAYS end a custom stack with `"Noto Sans Medium"`: a
 * display/script face is Latin-only and a non-Latin name (Höllviken) turns to tofu.
 */
export interface ThemeFonts {
  /** Upright serif — LAND-side names: basemap place labels above the
   * village tier, LNDMRK's named-tower adjunct. Falls back to `TEXT_FONT`. */
  upright?: string[];
  /** Italic variant of `upright` — CHART LOCATION NAMES (SEAARE's named
   * bays/sounds, the ATON OBJNAM label), following the cartographic
   * convention of italic-for-water vs upright-for-land. */
  italic?: string[];
  /** Forces EVERY text layer the chart style builds (`chartStyle.ts`'s
   * `buildStyle` — chart, basemap and the shorthand excluded above: litdsn,
   * soundings, "Wk") onto this one stack, overriding both roles above and
   * `TEXT_FONT`. A deliberate break from the printed-chart convention for a
   * theme that wants one lettering throughout (`modern-paper-2` and its night variants, the user's
   * "all text should be the hand/cursive font from the day theme"). The
   * imperatively-added overlays (own ship, AIS, measure, POI, route) are not
   * in `buildStyle` and keep `TEXT_FONT`. Absent changes nothing. */
  all?: string[];
}

/** A uniform `text-halo-*` glow — `colors.ts`'s `haloPaint()` is the one place
 * that reads this. ABSENT MEANS NO GLOW: `paper*`/`graphite*` omit it
 * deliberately, matching their flat-ink reference photo. */
export interface TextHalo {
  color: string;
  width: number;
  /** `text-halo-blur`, px. Absent/0 keeps a crisp edge. */
  blur?: number;
}

export interface ThemeDef {
  id: Palette;
  /** Display name for the Settings theme dropdown (`settings/device.tsx`). */
  label: string;
  /** The 25 S-52 colour tokens — either a slice of the generated
   * `S52_TABLES` (day/dusk/night/whiteback/blackback) or, for a theme with
   * no upstream table (`slick`), hand-authored in that theme's own file. */
  s52: S52Colors;
  /** The empty canvas under everything before a tile paints — not an S-52
   * colour, ours to pick; distinct from this table's own NODTA/LANDA
   * (colors.test.ts enforces both). */
  canvas: string;
  /** Where this theme sits in the Settings dropdown. The backend serves
   * `/themes` as an ARRAY in this order, but the field is carried so a theme
   * arriving out of band still knows its place. */
  order: number;
  /** Whether this palette's chrome is dark. Drives `color-scheme: dark` and
   * the MapLibre-furniture overrides in `GET /api/themes.css` — the frontend
   * itself only reads it for documentation and tests. */
  dark: boolean;
  /** The 18 Tailwind `--color-*` chrome tokens. Present so ONE object is the
   * whole theme, but NOT read by any frontend code: applied as CSS instead
   * (`/api/themes.css`, plus index.css's `@theme static` for day). */
  chrome: Readonly<Record<string, string>>;
  /** Role → hex for icon recolouring (`./iconRoles.ts`). chartcore serves one
   * palette-neutral SVG per symbol carrying `#fe00XX` sentinels; ALL 35 roles
   * always. Six are NOT authored in the JSON — see {@link AuthoredThemeDef}. */
  icons: IconRoleColors;
  routeOverlay: RouteOverlayColors;
  overlay: OverlayColors;
  poi: PoiColors;
  /** See {@link NoticesColors} — optional so an older user theme still loads. */
  notices?: NoticesColors;
  /** See {@link BasemapColors}'s own docstring for why this is required. */
  basemap: BasemapColors;
  rasterDim?: RasterDim;
  basemapTint?: BasemapTint;
  contourWidth?: ContourWidth;
  /** Whether the sector-light overlay draws its OUTLW annulus
   * (`features/sector-lights/overlay.ts`). Absent/true matches the reference;
   * `false` (paper) drops the ring rather than just retoning it. */
  sectorOutline?: boolean;
  /** Scales the sector-light arc's colour ring relative to the
   * S52CondRules.cpp reference half-widths. A theme with `sectorOutline: false`
   * widens this instead, since it has no OUTLW ring for contrast. */
  sectorArcScale?: number;
  /** See {@link ThemeFonts}'s own docstring. */
  fonts?: ThemeFonts;
  /** See {@link TextHalo}'s own docstring. */
  textHalo?: TextHalo;
  /** See {@link VesselColors}'s own docstring. */
  vessels?: VesselColors;
  /** When true, `world-places` renders three settlement ranks (city/town/
   * village) in distinct typographic registers, mimicking a printed chart's
   * hierarchy. Absent/false keeps the uniform style. */
  placeLabelTiers?: boolean;
}

/** A theme's `icons` block AS AUTHORED — 29 of the 35 roles. The six
 * `DERIVED_ICON_ROLES` (./derivedIcons.ts) are absent on purpose: authoring
 * them separately once let day drift a visible deltaE 13–18 from its own palette. */
export type AuthoredIconRoleColors = Omit<IconRoleColors, DerivedIconRole>;

/** A theme AS IT LIVES ON DISK / on the wire. Identical to {@link ThemeDef}
 * but for the six unauthored icon roles; `./derivedIcons.ts`'s `resolveTheme`
 * turns one into the other, and `./source.ts` is the only caller. */
export interface AuthoredThemeDef extends Omit<ThemeDef, "icons"> {
  icons: AuthoredIconRoleColors;
}
