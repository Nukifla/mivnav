import type { Component } from "solid-js";
// `.../icons/waves` alias is omitted from lucide-solid's esm build (only the
// vite `solid` condition has it) and breaks under `bun test`. Same icon,
// imported directly under its real name instead.
import Waves from "lucide-solid/icons/waves-horizontal";
import Bookmark from "lucide-solid/icons/bookmark";
import Eye from "lucide-solid/icons/eye";
import FlaskConical from "lucide-solid/icons/flask-conical";
import Gauge from "lucide-solid/icons/gauge";
import Map from "lucide-solid/icons/map";
import PaletteIcon from "lucide-solid/icons/palette";
import Ship from "lucide-solid/icons/ship";
import Type from "lucide-solid/icons/type";
import AisSection from "./AisSection";
import ChartSetsSection from "./ChartSetsSection";
import ChromeSection from "../chrome/ChromeSection";
import ProfilesSection from "./ProfilesSection";
import ThemeEditorSection from "./ThemeEditorSection";
import { coerceBoolean, coerceFiniteNumber } from "../persist";
import { wakeLockSupported } from "../wakeLock";
import { PALETTE_LABELS, PALETTES, type Palette } from "../style/colors";
import { DEFAULT_SETTINGS, type ChartSettings } from "../style/settings";
import type { DeviceCtx, SettingsCtx } from "./ctx";
import {
  defineSetting,
  defineSettingsCategory,
  defineSettingsSection,
  type DependsOn,
  type Setting,
  type SettingsCategory,
  type SettingsRegistry,
  type SettingsSection,
} from "./registry";

// The DEVICE settings declaration — the `chrome/widgets.ts` twin. Full
// structure, the layer-options-vs-settings split (task woqknwzy/xpstmort)
// and category ordering rationale: docs/architecture/device-settings.md.

// `DeviceCtx`/`SettingsCtx` (./ctx.ts) span both device and boat halves so
// one registry can hold both. Re-exported here — where readers look for it.
export type { DeviceCtx, SettingsCtx };

const DEPTH = "depth";
const DISPLAY = "display";
const TEXT = "text";
export const DIAGNOSTICS = "diagnostics";
/** The "Appearance" CATEGORY (task xpstmort) — Depth/Display/Text & Lights/
 * Display density all answer "how does this screen draw": one pane, four
 * subsections rendered flat and always open, never a collapsed accordion. */
export const APPEARANCE = "appearance";
/** The "Data on this chart" CATEGORY — two sections (Chart sets here, and the
 * satellite feature's own source-picker section) answer the one question. */
export const CHART_DATA = "chart-data";

// Keys of ChartSettings that are a plain boolean/number, so a helper can
// bind read/write typed rather than stringly. The `as` casts live here, once.
type BoolField = { [K in keyof ChartSettings]: ChartSettings[K] extends boolean ? K : never }[keyof ChartSettings];
type NumField = { [K in keyof ChartSettings]: ChartSettings[K] extends number ? K : never }[keyof ChartSettings];

/** A boolean ChartSettings field as a generated toggle. */
function chartToggle(
  field: BoolField,
  opts: { label: string; help?: string; group: string; order: number; dependsOn?: DependsOn },
): Setting<SettingsCtx> {
  return defineSetting<SettingsCtx>({
    id: field,
    scope: "device",
    control: { kind: "toggle" },
    label: opts.label,
    help: opts.help,
    group: opts.group,
    order: opts.order,
    dependsOn: opts.dependsOn,
    default: DEFAULT_SETTINGS[field],
    coerce: (raw) => coerceBoolean(raw, DEFAULT_SETTINGS[field]),
    read: (c) => c.settings[field],
    write: (c, v) => c.onSettings({ [field]: v } as Partial<ChartSettings>),
  });
}

/** A numeric ChartSettings field as a generated slider (or, `as: "field"`, a typed input). */
function chartSlider(
  field: NumField,
  opts: {
    label: string;
    group: string;
    order: number;
    min: number;
    max: number;
    step: number;
    format?: (v: number) => string;
    as?: "slider" | "field";
  },
): Setting<SettingsCtx> {
  return defineSetting<SettingsCtx>({
    id: field,
    scope: "device",
    control: { kind: "number", min: opts.min, max: opts.max, step: opts.step, format: opts.format, as: opts.as },
    label: opts.label,
    group: opts.group,
    order: opts.order,
    default: DEFAULT_SETTINGS[field],
    coerce: (raw) => coerceFiniteNumber(raw, DEFAULT_SETTINGS[field]),
    read: (c) => c.settings[field],
    write: (c, v) => c.onSettings({ [field]: v } as Partial<ChartSettings>),
  });
}

const metres = (v: number) => `${v} m`;

// ODbL attribution note — display-only custom control. Not a setting: the
// on-chart badge is hidden on the boat deployment, so the credit rides
// here, at the foot of Display (the pane that draws the basemap it's for).
const AttributionNote: Component = () => (
  <p class="mt-1 text-[11px] leading-snug text-fg-3">
    Basemap data © OpenStreetMap contributors and © OpenSeaMap contributors, under
    the Open Database License (ODbL). Forecast data © Open-Meteo (CC BY 4.0).
  </p>
);

// Depth-shading trust note — the safety contour/depth sliders LOOK like a
// shallow-water alarm, and the app ships none. `Slider` has no `help` line
// (unlike `Toggle`), so this rides the same `custom` escape hatch instead.
const DepthNote: Component = () => (
  <p class="mt-1 text-[11px] leading-snug text-fg-3">
    Adjusts the chart's depth shading only — there is no depth alarm.
  </p>
);

// Each mounts an existing bespoke section UNCHANGED, wiring props from ctx —
// this is only where they slot into the registry's ordering.
const renderAis: Component<{ ctx: SettingsCtx }> = (props) => (
  <AisSection settings={props.ctx.settings} onSettings={props.ctx.onSettings} />
);
const renderChartSets: Component<{ ctx: SettingsCtx }> = (props) => (
  <ChartSetsSection
    sets={props.ctx.sets}
    disabledSets={props.ctx.disabledSets}
    onToggleSet={props.ctx.onToggleSet}
    catalogError={props.ctx.catalogError}
    onRetryCatalog={props.ctx.onRetryCatalog}
  />
);
const renderChrome: Component<{ ctx: SettingsCtx }> = (props) => (
  <ChromeSection chrome={props.ctx.chrome} onChrome={props.ctx.onChrome} />
);
const renderProfiles: Component<{ ctx: SettingsCtx }> = (props) => (
  <ProfilesSection
    settings={props.ctx.settings}
    onSettings={props.ctx.onSettings}
    applyLayout={props.ctx.applyLayout}
  />
);
// Theme editor only needs WHICH theme is showing — it reads/writes its own
// session-only override signal directly, not `ChartSettings`.
const renderThemeEditor: Component<{ ctx: SettingsCtx }> = (props) => (
  <ThemeEditorSection palette={props.ctx.settings.palette} />
);

// One entry per rail row, declared explicitly so the device tab's
// navigation is visible in one place. PROFILES IS FIRST (task xpstmort) —
// a saved snapshot, not one config slice. See docs/architecture/device-settings.md.
export const DEVICE_CATEGORIES: readonly SettingsCategory[] = [
  defineSettingsCategory({ id: "profiles", title: "Profiles", icon: Bookmark, group: "device", order: 5,
    blurb: "Save this screen's look under a name — optionally with a dashboard layout — and switch back to it in one tap." }),
  defineSettingsCategory({ id: APPEARANCE, title: "Appearance", icon: Eye, group: "device", order: 10,
    blurb: "Depth shading, theme, symbol sizes, labels and control size — how this screen draws." }),
  defineSettingsCategory({ id: CHART_DATA, title: "Data on this chart", icon: Map, group: "device", order: 20,
    blurb: "Which charts and data this screen draws. Turn whole layers on and off in the Layers panel." }),
  // Display only — the collision alarm itself is boat-wide (Server settings → Alarms).
  defineSettingsCategory({ id: "ais", title: "Vessels", icon: Ship, group: "device", order: 30,
    blurb: "How other vessels draw on this screen." }),
  // The theme editor (task mnsyyonx) lives here too: a session-only tool for
  // writing theme files, not a setting anyone needs at sea.
  defineSettingsCategory({ id: DIAGNOSTICS, title: "Developer", icon: FlaskConical, group: "device", order: 90,
    blurb: "Debug overlays and tools for working on mivnav. Leave these off at sea." }),
];

export const DEVICE_SECTIONS: readonly SettingsSection<SettingsCtx>[] = [
  // Appearance's four subsections, in reading order — all render "headed".
  defineSettingsSection<SettingsCtx>({ id: DEPTH, title: "Depth", icon: Waves, group: "device", category: APPEARANCE, order: 10 }),
  defineSettingsSection<SettingsCtx>({ id: DISPLAY, title: "Display", icon: Eye, group: "device", category: APPEARANCE, order: 20 }),
  defineSettingsSection<SettingsCtx>({ id: TEXT, title: "Text & Lights", icon: Type, group: "device", category: APPEARANCE, order: 30 }),
  defineSettingsSection<SettingsCtx>({ id: "chrome", title: "Display density", icon: Gauge, group: "device", category: APPEARANCE, order: 40, render: renderChrome }),
  defineSettingsSection<SettingsCtx>({ id: "ais", title: "Vessels", icon: Ship, group: "device", category: "ais", order: 50, render: renderAis }),
  defineSettingsSection<SettingsCtx>({ id: "sets", title: "Chart sets", icon: Map, group: "device", category: CHART_DATA, order: 60, render: renderChartSets }),
  defineSettingsSection<SettingsCtx>({ id: "profiles", title: "Profiles", icon: Bookmark, group: "device", category: "profiles", order: 80, render: renderProfiles }),
  defineSettingsSection<SettingsCtx>({ id: DIAGNOSTICS, title: "Diagnostics", icon: FlaskConical, group: "device", category: DIAGNOSTICS, order: 90 }),
  defineSettingsSection<SettingsCtx>({ id: "theme-editor", title: "Theme editor", icon: PaletteIcon, group: "device", category: DIAGNOSTICS, order: 95, render: renderThemeEditor }),
];

export const DEVICE_SETTINGS: readonly Setting<SettingsCtx>[] = [
  // Depth — the three blue shading bands as "levels", shallowest first (user,
  // 2026-09-27: these replace the old Safety contour / Safety depth pair).
  // Typed number fields, not sliders (user, 2026-09-27: "just have a number
  // input field to write the depth") — so the range is wide, not slider-sized.
  // The field ignores `format`, hence the unit in the label.
  // Each value is the band's DEEP edge: level 1 is 0..shallowDepth (DEPVS),
  // level 2 shallowDepth..safetyContour (DEPMS), level 3
  // safetyContour..deepDepth (DEPMD), white (DEPDW) beyond. The safety-contour
  // line is level 2's deep edge. Entering one past another is harmless:
  // `normalizedContours` keeps the ramp ordered.
  chartSlider("shallowDepth", { label: "Level 1 (shallowest) up to (m)", group: DEPTH, order: 10, min: 0, max: 100, step: 0.1, format: metres, as: "field" }),
  {
    ...chartSlider("safetyContour", { label: "Level 2 up to — safety contour (m)", group: DEPTH, order: 20, min: 0, max: 100, step: 0.1, format: metres, as: "field" }),
    // Safety depth (sounding emphasis) no longer has its own slider: it
    // follows the safety contour, so the bold soundings and the contour line
    // always mark the same depth.
    write: (c, v) => c.onSettings({ safetyContour: v as number, safetyDepth: v as number }),
  },
  chartSlider("deepDepth", { label: "Level 3 up to (m)", group: DEPTH, order: 30, min: 0, max: 100, step: 0.1, format: metres, as: "field" }),
  // Sounding VISIBILITY is the "Soundings" ENC layer group in the Layers
  // panel (`enc:soundings`), the SOLE control for it — `showSoundings` was
  // excised entirely (no settings toggle, no command-palette toggle).
  defineSetting<SettingsCtx>({
    id: "depthNote",
    scope: "device",
    control: { kind: "custom", component: DepthNote },
    label: "Depth note",
    group: DEPTH,
    order: 40,
  }),

  // Full theme list; the mariner-in-the-dark 3-way (day/dusk/night only,
  // `chrome/Launcher.tsx` PALETTE_MODES) is a separate Rail control — this
  // is the desk reach, and the only place newer themes are chosen from.
  defineSetting<SettingsCtx>({
    id: "palette",
    scope: "device",
    control: { kind: "enum", options: PALETTES, as: "select", labels: PALETTE_LABELS },
    label: "Theme",
    group: DISPLAY,
    order: 10,
    default: DEFAULT_SETTINGS.palette,
    coerce: (raw) => (typeof raw === "string" && (PALETTES as readonly string[]).includes(raw) ? raw : DEFAULT_SETTINGS.palette),
    read: (c) => c.settings.palette,
    write: (c, v) => c.onSettings({ palette: v as Palette }),
  }),
  // Icon size for buoys/beacons/topmarks/daymarks/lights (aidsHazards.ts'
  // `atonIconScale`) — MapLibre's `icon-size` default is 1, so the slider's
  // own default reproduces the pre-setting style exactly.
  chartSlider("atonIconScale", {
    label: "Chart symbol size",
    group: DISPLAY,
    order: 40,
    min: 0.5,
    max: 2.5,
    step: 0.1,
    format: (v) => `${v.toFixed(1)}×`,
  }),
  // Own ship only (`ownFeatures` in aisSymbols.ts) — AIS targets keep their
  // size, so the boat can be made to stand out among them.
  chartSlider("ownShipScale", {
    label: "Boat icon size",
    group: DISPLAY,
    order: 45,
    min: 0.5,
    max: 2.5,
    step: 0.1,
    format: (v) => `${v.toFixed(1)}×`,
  }),
  // Screen Wake Lock (core/wakeLock.ts). The browser only offers it over
  // HTTPS, so the help says so — on the stock http:// install it's inert.
  chartToggle("keepScreenOn", {
    label: "Keep screen on",
    help: wakeLockSupported()
      ? "Stop this screen dimming or locking while the chart is open."
      : "Stop this screen dimming or locking while the chart is open. Not available here: browsers only allow it over https:// (e.g. tailscale serve).",
    group: DISPLAY,
    order: 47,
  }),
  defineSetting<SettingsCtx>({
    id: "attribution",
    scope: "device",
    control: { kind: "custom", component: AttributionNote },
    label: "Attribution",
    group: DISPLAY,
    order: 50,
  }),

  // Text & Lights — both sub-toggles are ANDed with their master in the style
  // code (aidsHazards.ts); the cascade indents and disables them to say so.
  chartToggle("showText", { label: "Text labels", group: TEXT, order: 10 }),
  chartToggle("showAtonText", { label: "Buoy & beacon names", group: TEXT, order: 20, dependsOn: { setting: "showText" } }),
  chartToggle("showLights", { label: "Lights", group: TEXT, order: 30 }),
  chartToggle("showLightDescriptions", {
    label: "Light descriptions",
    group: TEXT,
    order: 40,
    // Two masters: descriptions need text ON and lights ON, matching the former
    // `disabled={!showText || !showLights}`.
    dependsOn: { setting: ["showText", "showLights"] },
  }),

  defineSetting<SettingsCtx>({
    id: "debugLayers",
    scope: "device",
    control: { kind: "toggle" },
    label: "Debug layers",
    help: "Draw chart data the style doesn't handle yet, in hashed colours.",
    group: DIAGNOSTICS,
    order: 10,
    default: false,
    coerce: (raw) => coerceBoolean(raw, false),
    read: (c) => c.debugLayers,
    write: (c, v) => c.onDebugLayers(v as boolean),
  }),
  defineSetting<SettingsCtx>({
    id: "debugTiles",
    scope: "device",
    control: { kind: "toggle" },
    label: "Tile boundaries",
    help: "Draw the tile grid with each tile's z/x/y — for chart seams and missing tiles.",
    group: DIAGNOSTICS,
    order: 20,
    default: false,
    coerce: (raw) => coerceBoolean(raw, false),
    read: (c) => c.debugTiles,
    write: (c, v) => c.onDebugTiles(v as boolean),
  }),
  defineSetting<SettingsCtx>({
    id: "debugCells",
    scope: "device",
    control: { kind: "toggle" },
    label: "Cell coverage",
    help: "Outline each o-charts cell with its name, zoom band and scale — shows which cell draws where.",
    group: DIAGNOSTICS,
    order: 30,
    default: false,
    coerce: (raw) => coerceBoolean(raw, false),
    read: (c) => c.debugCells,
    write: (c, v) => c.onDebugCells(v as boolean),
  }),
  defineSetting<SettingsCtx>({
    id: "fpsDebug",
    scope: "device",
    control: { kind: "toggle" },
    label: "FPS counter",
    help: "Show a floating frame-rate readout.",
    group: DIAGNOSTICS,
    order: 40,
    default: false,
    coerce: (raw) => coerceBoolean(raw, false),
    read: (c) => c.fpsDebug,
    write: (c, v) => c.onFpsDebug(v as boolean),
  }),
];

// Not a module-const registry (C4): App.tsx builds it from these plus other
// features' contributions via `createSettingsRegistry` — a singleton
// couldn't gather other features' settings or escape import-order.

// The Layers quick-panel: curated subset of display/overlay LAYERS for the
// rail's one-tap Layers button. GENERATED, and FIXED IN ORDER — on-chart
// z-order is safety-critical (`layers/overlay.ts` `Z`).

/** Chart-detail toggles that live ONLY in the quick panel, no deep-Settings
 * twin — declared directly since they're not in `DEVICE_SETTINGS`.
 * Persistence: docs/architecture/device-settings.md. */
export const CHART_DETAIL_ONLY_LAYERS: readonly Setting<SettingsCtx>[] = [
  chartToggle("showOsmOnLand", {
    label: "OpenStreetMap on land",
    help: "Roads and towns show through the chart's land. Needs internet; without it land just draws plain.",
    group: "layers", // inert — never enters a SettingsRegistry, see VESSEL_LAYERS
    order: 10,
  }),
  defineSetting<SettingsCtx>({
    id: "showGrid",
    scope: "device",
    control: { kind: "toggle" },
    label: "Lat/long grid",
    help: "Overlay a latitude/longitude graticule with edge labels; the spacing adapts to the zoom.",
    group: "layers",
    order: 20,
    default: false,
    coerce: (raw) => coerceBoolean(raw, false),
    read: (c) => c.showGrid,
    write: (c, v) => c.onShowGrid(v as boolean),
  }),
];

/** Vessels-group layers the quick panel exposes that are NOT generated
 * settings — bespoke in `AisSection.tsx`, ride the same fields, defined HERE
 * so they don't double that UI. See docs/architecture/device-settings.md. */
export const VESSEL_LAYERS: readonly Setting<SettingsCtx>[] = [
  // Other vessels only; own ship (`ownShipOverlay`) is a separate always-on
  // overlay. Not in AisSection's deep settings — would double this control.
  chartToggle("showAisTargets", { label: "AIS targets", group: "vessels", order: 5 }),
  chartToggle("showAisRisk", { label: "Collision colouring", group: "vessels", order: 10 }),
  chartToggle("showHeadingLine", { label: "Heading line", group: "vessels", order: 20 }),
  chartToggle("showAisGhost", { label: "Ghost targets", group: "vessels", order: 30 }),
];

/** One group of layer toggles in the quick panel — a heading and its switches. */
export interface LayerGroup {
  title: string;
  settings: readonly Setting<SettingsCtx>[];
}

/** The curated Layers quick-panel content, grouped — CHART-DETAIL half only
 * (the real map OVERLAYS live in the generic OVERLAY REGISTRY instead). Ids
 * are LOOKED UP in the registry, so a missing feature just drops that toggle. */
export function layerQuickPanel(reg: SettingsRegistry<SettingsCtx>): LayerGroup[] {
  const pick = (ids: readonly string[]): Setting<SettingsCtx>[] =>
    ids.map((id) => reg.byId(id)).filter((s): s is Setting<SettingsCtx> => s != null);
  return [
    {
      title: "Chart detail",
      // Sounding VISIBILITY is NOT here: it's the "Soundings" ENC layer
      // group in Map-layers (toggle + opacity) — this would double it.
      settings: [
        ...pick(["showText", "showAtonText", "showLights", "showLightDescriptions"]),
        ...CHART_DETAIL_ONLY_LAYERS,
      ],
    },
    { title: "Vessels", settings: VESSEL_LAYERS },
  ];
}
