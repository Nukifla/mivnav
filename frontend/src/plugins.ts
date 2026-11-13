// Out-of-tree plugins: optional add-ons kept under `<repo>/plugins/<name>/`
// (gitignored — each plugin is its own project; see backend `mivnav.plugins`
// for the backend half). A plugin's frontend half is
// `plugins/<name>/frontend/index.ts`, whose default export is a
// `MivnavPlugin`. index.tsx registers every one present — except those
// switched off in Settings → Plugins (`GET /plugins`) — before the app
// renders; with none present the app is exactly the core.
//
// Plugin code imports the host by relative path
// (`../../../frontend/src/...`) and resolves npm packages through
// `plugins/node_modules` (a symlink to `frontend/node_modules`,
// `just plugins-link`), so both share ONE solid-js/maplibre instance.

import type { LucideIcon } from "lucide-solid";
import type { Map as MLMap } from "maplibre-gl";
import type { Accessor, Component, JSX } from "solid-js";
import type { AppFeature } from "./core/chrome/feature";
import type { Notice } from "./core/chrome/notices";
import type { Density } from "./core/chrome/registry";
import type { RoutesClient } from "./core/routes";
import type { SearchResult } from "./core/search/client";
import type { SignalKState } from "./core/signalk";
import { registerModeIcon } from "./core/chrome/modeIcons";
import { registerPluginSettings, type PluginSettingsSpec } from "./core/pluginSettings";
import type { ChartSettings } from "./core/style/settings";
import { registerPoiQueryLayers, registerPoiSource, type PoiSourcePlugin } from "./features/poi/sources";
import type { RoutesModel } from "./features/route";

/** A search-overlay pick a plugin asks for (`PluginHost.openSearch`). */
export interface SearchPick {
  /** Rows shown ahead of the real results (a "Choose on map"). Reactive. */
  pinned?: Accessor<SearchResult[]>;
  /** The picked row — instead of the overlay's ordinary go-to/info select.
   * Not called when the overlay is closed without a pick. */
  onSelect: (result: SearchResult) => void;
}

/** What the app hands a plugin's `setup`. */
export interface PluginHost {
  settings: Accessor<ChartSettings>;
  setSettings: (fn: (s: ChartSettings) => ChartSettings) => void;
  /** Swap the global wind unit (m/s ⇄ kn) — what tapping a wind value does. */
  toggleWindUnit: () => void;
  /** The chart-mode state (core/chrome/modes.ts). Usable once the app is
   * built — call these from handlers/effects, not during `setup` itself. */
  modes: {
    active: Accessor<string | null>;
    enter: (id: string) => void;
    leave: () => void;
  };
  /** The live SignalK state (own ship, course). */
  signalk: SignalKState;
  /** Push a transient notice to the app's notice strip. */
  notify: (notice: Notice) => void;
  /** The routes feature: its model (following, the go-here save, the
   * overlay's edit session), the route store's client, and the saved-routes
   * list (`openList`, usable once the app is built). */
  routes: {
    model: RoutesModel;
    client: RoutesClient;
    openList: () => void;
  };
  /** The chrome's display density (a setting, not a breakpoint). */
  density: Accessor<Density>;
  /** Open the search overlay for a pick (usable once the app is built). */
  openSearch: (pick: SearchPick) => void;
}

/** What a plugin's map wiring gives back to MapView. */
export interface PluginMapAttachment {
  /** Extra live map layer ids that move with one of the plugin's band
   * overlays in a Layers-panel reorder (a custom layer the overlay itself
   * does not list). */
  bandLayerIds?: (overlayId: string) => readonly string[];
  /** Drawn over the map (a marker, a badge) — MapView's own layer. */
  view?: () => JSX.Element;
}

/** One plugin, set up against the running app. */
export interface PluginInstance {
  /** Whole app features (an overlay, a mode, an info provider, …). */
  features?: readonly AppFeature[];
  /** Map-coupled wiring (custom layers, map events), run once the map
   * exists, inside MapView's reactive owner — effects are cleaned up with it. */
  attachMap?: (map: MLMap) => PluginMapAttachment | void;
  /** Chrome rendered with the app's own (a mode's bottom sheet). */
  Chrome?: Component;
  /** Chrome rendered OUTSIDE the map pane, as a column sibling just before
   * the Rail: a mode's phone bottom bar taking the Rail's slot (see
   * `Mode.ownsBottomBar`), or a desktop drawer. */
  RailChrome?: Component;
}

export interface MivnavPlugin {
  id: string;
  /** Extra POI dataset sources (see features/poi/sources.ts). */
  poiSources?: readonly PoiSourcePlugin[];
  /** Map layers (drawn with the POI marker spec) the POI info provider
   * should answer taps on. */
  poiQueryLayerIds?: readonly string[];
  /** Whole app features that need nothing from the app. Built once, at app
   * start, and registered right after the built-in POI feature. */
  features?: () => readonly AppFeature[];
  /** Everything else, set up once against the app (`PluginHost`). */
  setup?: (host: PluginHost) => PluginInstance;
  /** The plugin's per-device settings slices (core/pluginSettings.ts). */
  settings?: readonly PluginSettingsSpec<unknown>[];
  /** Icons for the chart modes its features register, by mode id. */
  modeIcons?: Readonly<Record<string, LucideIcon>>;
  /** Overlay ids that join the reorderable layer band (MapView). */
  bandOverlayIds?: readonly string[];
}

const registered: MivnavPlugin[] = [];

export function registerPlugin(plugin: MivnavPlugin): void {
  if (registered.some((p) => p.id === plugin.id)) return;
  registered.push(plugin);
  for (const source of plugin.poiSources ?? []) registerPoiSource(source);
  registerPoiQueryLayers(plugin.poiQueryLayerIds ?? []);
  for (const spec of plugin.settings ?? []) registerPluginSettings(spec);
  for (const [id, icon] of Object.entries(plugin.modeIcons ?? {})) registerModeIcon(id, icon);
}

export function plugins(): readonly MivnavPlugin[] {
  return registered;
}

/** Every plugin's `setup`, run once (App). */
export function setupPlugins(host: PluginHost): PluginInstance[] {
  return registered.flatMap((p) => (p.setup ? [p.setup(host)] : []));
}

export function pluginFeatures(instances: readonly PluginInstance[] = []): AppFeature[] {
  return [
    ...registered.flatMap((p) => [...(p.features?.() ?? [])]),
    ...instances.flatMap((i) => [...(i.features ?? [])]),
  ];
}

export function pluginBandOverlayIds(): string[] {
  return registered.flatMap((p) => [...(p.bandOverlayIds ?? [])]);
}

/** `{path: module}` as `import.meta.glob(..., { eager: true })` returns it.
 * A plugin whose id is in `disabled` is skipped. */
export function loadPlugins(
  modules: Record<string, unknown>,
  disabled: ReadonlySet<string> = new Set(),
): void {
  for (const [path, mod] of Object.entries(modules)) {
    const plugin = (mod as { default?: MivnavPlugin }).default;
    if (plugin && typeof plugin.id === "string") {
      if (!disabled.has(plugin.id)) registerPlugin(plugin);
    } else {
      console.warn(`plugin ${path}: no default-exported MivnavPlugin, skipped`);
    }
  }
}
