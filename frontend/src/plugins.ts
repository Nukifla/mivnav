// Out-of-tree plugins: optional add-ons kept under `<repo>/plugins/<name>/`
// (gitignored — each plugin is its own project; see backend `mivnav.plugins`
// for the backend half). A plugin's frontend half is
// `plugins/<name>/frontend/index.ts`, whose default export is a
// `MivnavPlugin`. `loadPlugins` (index.tsx) registers every one present
// before the app renders; with none present the app is exactly the core.
//
// Plugin code imports the host by relative path
// (`../../../frontend/src/...`) and resolves npm packages through
// `plugins/node_modules` (a symlink to `frontend/node_modules`,
// `just plugins-link`), so both share ONE solid-js/maplibre instance.

import type { AppFeature } from "./core/chrome/feature";
import { registerPoiQueryLayers, registerPoiSource, type PoiSourcePlugin } from "./features/poi/sources";

export interface MivnavPlugin {
  id: string;
  /** Extra POI dataset sources (see features/poi/sources.ts). */
  poiSources?: readonly PoiSourcePlugin[];
  /** Map layers (drawn with the POI marker spec) the POI info provider
   * should answer taps on. */
  poiQueryLayerIds?: readonly string[];
  /** Whole app features (an overlay, its Layers-panel row, …). Built once,
   * at app start, and registered right after the built-in POI feature. */
  features?: () => readonly AppFeature[];
  /** Overlay ids that join the reorderable layer band (MapView). */
  bandOverlayIds?: readonly string[];
}

const registered: MivnavPlugin[] = [];

export function registerPlugin(plugin: MivnavPlugin): void {
  if (registered.some((p) => p.id === plugin.id)) return;
  registered.push(plugin);
  for (const source of plugin.poiSources ?? []) registerPoiSource(source);
  registerPoiQueryLayers(plugin.poiQueryLayerIds ?? []);
}

export function plugins(): readonly MivnavPlugin[] {
  return registered;
}

export function pluginFeatures(): AppFeature[] {
  return registered.flatMap((p) => [...(p.features?.() ?? [])]);
}

export function pluginBandOverlayIds(): string[] {
  return registered.flatMap((p) => [...(p.bandOverlayIds ?? [])]);
}

/** `{path: module}` as `import.meta.glob(..., { eager: true })` returns it. */
export function loadPlugins(modules: Record<string, unknown>): void {
  for (const [path, mod] of Object.entries(modules)) {
    const plugin = (mod as { default?: MivnavPlugin }).default;
    if (plugin && typeof plugin.id === "string") {
      registerPlugin(plugin);
    } else {
      console.warn(`plugin ${path}: no default-exported MivnavPlugin, skipped`);
    }
  }
}
