// Plugins' own per-device settings (src/plugins.ts): each plugin's slice
// lives under `ChartSettings.pluginSettings[key]`, an opaque map to the core.
// A plugin registers how to coerce its slice; the profile coercer
// (profiles.ts `settingsFromProfile`) runs every registered one and keeps a
// slice nobody registered VERBATIM — so a switched-off or removed plugin's
// settings survive being saved by this device and come back with the plugin.
//
// Its own module (not plugins.ts) so the profile coercer can import it
// without pulling in every feature the plugin host knows about.

import type { ChartSettings } from "./style/settings";

export interface PluginSettingsSpec<T> {
  /** Key under `pluginSettings` — the plugin id, by convention. */
  key: string;
  defaults: T;
  /** An untrusted stored value (absent: `undefined`) → a valid slice. */
  coerce: (raw: unknown) => T;
  /** The top-level settings key this slice was stored under before it moved
   * to a plugin; read (once) when the slice itself is absent. */
  legacyKey?: string;
}

const specs = new Map<string, PluginSettingsSpec<unknown>>();

/** Returns the un-registration (for a test: bun shares one module registry
 * across test files, so a registration must not outlive its test). */
export function registerPluginSettings<T>(spec: PluginSettingsSpec<T>): () => void {
  specs.set(spec.key, spec as PluginSettingsSpec<unknown>);
  return () => {
    if (specs.get(spec.key) === spec) specs.delete(spec.key);
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** `raw` is a whole stored settings blob (its `pluginSettings` plus any
 * legacy top-level keys). */
export function coercePluginSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(raw.pluginSettings) ? { ...raw.pluginSettings } : {};
  for (const spec of specs.values()) {
    const stored = spec.key in out ? out[spec.key] : spec.legacyKey ? raw[spec.legacyKey] : undefined;
    out[spec.key] = spec.coerce(stored);
  }
  return out;
}

/** A plugin's slice of live settings. Settings that came through the
 * coercer already hold a valid slice; anything else (the bare defaults)
 * falls back to the plugin's own defaults. */
export function pluginSlice<T>(settings: ChartSettings, spec: PluginSettingsSpec<T>): T {
  const value = settings.pluginSettings[spec.key];
  return value === undefined ? spec.defaults : (value as T);
}

/** `settings` with the plugin's slice patched. */
export function withPluginSlice<T>(
  settings: ChartSettings,
  spec: PluginSettingsSpec<T>,
  patch: Partial<T>,
): ChartSettings {
  return {
    ...settings,
    pluginSettings: { ...settings.pluginSettings, [spec.key]: { ...pluginSlice(settings, spec), ...patch } },
  };
}
