// Named visual-settings profiles — client for the backend's /config/profiles.
// *Live* settings stay client-local (persist.ts, a 60fps paint update). A
// profile load is a one-shot copy, not a sticky "current profile" — that would need live writes to shared server state (no undo) or dirty-tracking.

import { batch, createSignal, type Accessor } from "solid-js";
import { PALETTES, type Palette } from "./style/colors";
import { coerceEncGroups } from "./style/encGroups";
import { DEFAULT_SETTINGS, normalizedContours, type ChartSettings } from "./style/settings";
import {
  DEFAULT_WEATHER,
  isWeatherField,
  isWeatherModel,
  WEATHER_HOUR_STEP,
  WEATHER_MAX_HOURS,
  type WeatherFieldId,
  type WeatherSettings,
} from "./weatherSettings";

/** A profile as the backend returns it. `settings` is `unknown` on purpose:
 * the backend stores the blob verbatim and never looks inside it, so on the
 * way back in it is untrusted input — another device's older (or newer)
 * client wrote it, or a hand edit did. `settingsFromProfile` is the only
 * way to turn it into `ChartSettings`. */
export interface Profile {
  name: string;
  /** Unix seconds, last save. */
  updated: number;
  settings: unknown;
}

const BASE = "/api/config/profiles";

/** Mirrors mivnav.config.profiles.MAX_NAME_LENGTH. */
export const MAX_NAME_LENGTH = 64;

/** Validated here too, not just on the backend: a `/` cannot round-trip
 * through `/config/profiles/{name}` (a path segment boundary), so refusing
 * it a keystroke early beats a 422 after the round trip. */
export function profileNameError(name: string, noun: string = "profile"): string | null {
  const trimmed = name.trim();
  if (!trimmed) return `Name the ${noun} first.`;
  if (trimmed.length > MAX_NAME_LENGTH) return `At most ${MAX_NAME_LENGTH} characters.`;
  if (trimmed.includes("/") || trimmed.includes("\\"))
    return `A ${noun} name cannot contain / or \\.`;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return `A ${noun} name cannot contain control characters.`;
  return null;
}

/** `profileNameError` at "layout" — the picker/save-as inputs in
 * `DashboardEditor.tsx`'s Layouts bar use this instead. */
export const layoutNameError = (name: string): string | null => profileNameError(name, "layout");

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      body && typeof (body as { detail?: unknown }).detail === "string"
        ? (body as { detail: string }).detail
        : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body as T;
}

/** The list response: every profile (newest-saved first, blobs included) and
 * the name of the boat-wide default, or `null`. */
export interface ProfileList {
  profiles: Profile[];
  /** The boat-wide default's name; a brand-new device adopts it once. */
  default: string | null;
}

/** Every profile, newest-saved first, plus the boat-wide default's name. The
 * backend sends the blobs with the list, so loading one — or adopting the
 * default — is not a second round trip. */
export async function listProfiles(): Promise<ProfileList> {
  const body = await request<Partial<ProfileList>>(BASE);
  return { profiles: body.profiles ?? [], default: body.default ?? null };
}

/** Anoint `name` as the boat-wide default (replacing any previous one). */
export async function setDefaultProfile(name: string): Promise<void> {
  await request<{ default: string }>(`${BASE}/${encodeURIComponent(name.trim())}/default`, {
    method: "PUT",
  });
}

/** Clear the boat-wide default if `name` is the one currently set. */
export async function clearDefaultProfile(name: string): Promise<void> {
  await request<null>(`${BASE}/${encodeURIComponent(name.trim())}/default`, { method: "DELETE" });
}

/** Create or replace `name`. `layoutName` is stored as one extra FLAT key
 * alongside the ChartSettings fields, not nested, so an older client's
 * profile (no `layoutName` at all) round-trips unchanged. */
export async function saveProfile(
  name: string,
  settings: ChartSettings,
  layoutName?: string | null,
): Promise<Profile> {
  const body: Record<string, unknown> = { ...settings };
  if (layoutName) body.layoutName = layoutName;
  return request<Profile>(`${BASE}/${encodeURIComponent(name.trim())}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The layout this profile references, or `null`. Does NOT check the name
 * still names a real layout — the caller (`ProfilesSection.tsx`) resolves
 * that against `listLayouts` and treats an unmatched name as dangling. */
export function layoutNameFromProfile(blob: unknown): string | null {
  const raw =
    blob !== null && typeof blob === "object" && !Array.isArray(blob)
      ? (blob as Record<string, unknown>)
      : {};
  return typeof raw.layoutName === "string" && raw.layoutName.trim() ? raw.layoutName : null;
}

export async function deleteProfile(name: string): Promise<void> {
  await request<null>(`${BASE}/${encodeURIComponent(name.trim())}`, { method: "DELETE" });
}

function pickNumber(raw: Record<string, unknown>, key: keyof ChartSettings, fallback: number) {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pickBoolean(raw: Record<string, unknown>, key: keyof ChartSettings, fallback: boolean) {
  const value = raw[key];
  return typeof value === "boolean" ? value : fallback;
}

/** The weather block, coerced field by field: every key validated against the
 * current model/field vocabulary, an unknown one falling back to the default
 * rather than keying an absent model. */
function weatherFromProfile(blob: unknown): WeatherSettings {
  const raw =
    blob !== null && typeof blob === "object" && !Array.isArray(blob)
      ? (blob as Record<string, unknown>)
      : {};
  const field: WeatherFieldId = isWeatherField(raw.field) ? raw.field : DEFAULT_WEATHER.field;
  const hours =
    typeof raw.hours === "number" && Number.isFinite(raw.hours)
      ? Math.max(0, Math.min(WEATHER_MAX_HOURS, Math.round(raw.hours / WEATHER_HOUR_STEP) * WEATHER_HOUR_STEP))
      : DEFAULT_WEATHER.hours;
  const opacity =
    typeof raw.opacity === "number" && Number.isFinite(raw.opacity)
      ? Math.max(0, Math.min(1, raw.opacity))
      : DEFAULT_WEATHER.opacity;
  return {
    model: isWeatherModel(raw.model) ? raw.model : DEFAULT_WEATHER.model,
    field,
    arrows: typeof raw.arrows === "boolean" ? raw.arrows : DEFAULT_WEATHER.arrows,
    hours,
    keepVisible:
      typeof raw.keepVisible === "boolean" ? raw.keepVisible : DEFAULT_WEATHER.keepVisible,
    opacity,
  };
}

/** `{layer id: visible}`, non-boolean entries dropped. */
function coercePluginLayers(raw: unknown): Record<string, boolean> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "boolean") out[id] = v;
  }
  return out;
}

/** An opaque stored blob, coerced into usable settings. A missing/wrong-typed
 * field falls back to `DEFAULT_SETTINGS` — NOT live settings — and
 * `normalizedContours` runs here so a bad contour order never reaches the renderer. */
export function settingsFromProfile(blob: unknown): ChartSettings {
  const raw =
    blob !== null && typeof blob === "object" && !Array.isArray(blob)
      ? (blob as Record<string, unknown>)
      : {};
  const palette = raw.palette;
  const merged: ChartSettings = {
    // Validated: an unknown palette would key `S52_PALETTES` to undefined.
    palette: PALETTES.includes(palette as Palette)
      ? (palette as Palette)
      : DEFAULT_SETTINGS.palette,
    safetyContour: pickNumber(raw, "safetyContour", DEFAULT_SETTINGS.safetyContour),
    safetyDepth: pickNumber(raw, "safetyDepth", DEFAULT_SETTINGS.safetyDepth),
    shallowDepth: pickNumber(raw, "shallowDepth", DEFAULT_SETTINGS.shallowDepth),
    deepDepth: pickNumber(raw, "deepDepth", DEFAULT_SETTINGS.deepDepth),
    atonIconScale: pickNumber(raw, "atonIconScale", DEFAULT_SETTINGS.atonIconScale),
    ownShipScale: pickNumber(raw, "ownShipScale", DEFAULT_SETTINGS.ownShipScale),
    showText: pickBoolean(raw, "showText", DEFAULT_SETTINGS.showText),
    showAtonText: pickBoolean(raw, "showAtonText", DEFAULT_SETTINGS.showAtonText),
    showLights: pickBoolean(raw, "showLights", DEFAULT_SETTINGS.showLights),
    showLightDescriptions: pickBoolean(
      raw,
      "showLightDescriptions",
      DEFAULT_SETTINGS.showLightDescriptions,
    ),
    showOsmBase: pickBoolean(raw, "showOsmBase", DEFAULT_SETTINGS.showOsmBase),
    showOpenSeaMap: pickBoolean(raw, "showOpenSeaMap", DEFAULT_SETTINGS.showOpenSeaMap),
    showPois: pickBoolean(raw, "showPois", DEFAULT_SETTINGS.showPois),
    pluginLayers: coercePluginLayers(raw.pluginLayers),
    showOsmOnLand: pickBoolean(raw, "showOsmOnLand", DEFAULT_SETTINGS.showOsmOnLand),
    showSatellite: pickBoolean(raw, "showSatellite", DEFAULT_SETTINGS.showSatellite),
    satelliteSource:
      typeof raw.satelliteSource === "string"
        ? raw.satelliteSource
        : DEFAULT_SETTINGS.satelliteSource,
    satelliteOpacity: pickNumber(raw, "satelliteOpacity", DEFAULT_SETTINGS.satelliteOpacity),
    showTrack: pickBoolean(raw, "showTrack", DEFAULT_SETTINGS.showTrack),
    trackHours: pickNumber(raw, "trackHours", DEFAULT_SETTINGS.trackHours),
    showNotices: pickBoolean(raw, "showNotices", DEFAULT_SETTINGS.showNotices),
    noticesWarnings: pickBoolean(raw, "noticesWarnings", DEFAULT_SETTINGS.noticesWarnings),
    noticesTemporary: pickBoolean(raw, "noticesTemporary", DEFAULT_SETTINGS.noticesTemporary),
    noticesPreliminary: pickBoolean(raw, "noticesPreliminary", DEFAULT_SETTINGS.noticesPreliminary),
    noticesPermanent: pickBoolean(raw, "noticesPermanent", DEFAULT_SETTINGS.noticesPermanent),
    noticesFiring: pickBoolean(raw, "noticesFiring", DEFAULT_SETTINGS.noticesFiring),
    noticesShowEnded: pickBoolean(raw, "noticesShowEnded", DEFAULT_SETTINGS.noticesShowEnded),
    weather: weatherFromProfile(raw.weather),
    // `layerOrder`'s members are validated to strings; a bad entry is dropped,
    // the surviving ids still order their layers.
    encGroups: coerceEncGroups(raw.encGroups),
    layerOrder: Array.isArray(raw.layerOrder)
      ? raw.layerOrder.filter((x): x is string => typeof x === "string")
      : DEFAULT_SETTINGS.layerOrder,
    showAisTargets: pickBoolean(raw, "showAisTargets", DEFAULT_SETTINGS.showAisTargets),
    predictorMinutes: pickNumber(raw, "predictorMinutes", DEFAULT_SETTINGS.predictorMinutes),
    showHeadingLine: pickBoolean(raw, "showHeadingLine", DEFAULT_SETTINGS.showHeadingLine),
    showAisGhost: pickBoolean(raw, "showAisGhost", DEFAULT_SETTINGS.showAisGhost),
    showAisRisk: pickBoolean(raw, "showAisRisk", DEFAULT_SETTINGS.showAisRisk),
    // An old profile's cpaMode/cpaDangerNm/…/alarmSound are ignored: the
    // collision settings are the boat's now (core/collisionSettings.ts).
    windUnit: raw.windUnit === "ms" || raw.windUnit === "kn" ? raw.windUnit : DEFAULT_SETTINGS.windUnit,
    keepScreenOn: pickBoolean(raw, "keepScreenOn", DEFAULT_SETTINGS.keepScreenOn),
  };
  const contours = normalizedContours(merged);
  return {
    ...merged,
    shallowDepth: contours.shallow,
    safetyContour: contours.safety,
    deepDepth: contours.deep,
  };
}

/** First-boot adoption of the boat-wide default. Adopts **once**, only when
 * there's no local choice yet, so a *later* boat-default change never reaches
 * back and stomps a device that already sailed with its own settings. */
export async function adoptDefaultProfile(opts: {
  hasLocalChoice: boolean;
  apply: (settings: ChartSettings) => void;
}): Promise<void> {
  if (opts.hasLocalChoice) return;
  let list: ProfileList;
  try {
    list = await listProfiles();
  } catch {
    return; // server off at boot: nothing to adopt, no local choice recorded
  }
  if (!list.default) return;
  const profile = list.profiles.find((p) => p.name === list.default);
  if (profile) opts.apply(settingsFromProfile(profile.settings));
}

/** The boot prefetch's adopted default, until App takes it. */
let bootDefault: ChartSettings | undefined;

/** Boot: run the first-boot adoption BEFORE first render (index.tsx's gate),
 * so App applies the boat default before MapView builds the map. Adopting
 * after mount re-styled every layer (paint, filter, layout) through maplibre's
 * per-layer-validated diff — seconds of blocked main thread on a fresh
 * device. Same rule as `adoptDefaultProfile`: only with no local choice. */
export async function prefetchDefaultProfile(hasLocalChoice: boolean): Promise<void> {
  await adoptDefaultProfile({
    hasLocalChoice,
    apply: (settings) => {
      bootDefault = settings;
    },
  });
}

/** The prefetched default (once), or undefined if none was adopted at boot. */
export function takeBootDefaultProfile(): ChartSettings | undefined {
  const settings = bootDefault;
  bootDefault = undefined;
  return settings;
}

/** Headless profiles state — every rule the UI obeys, none of the markup, so
 * it's tested without a DOM. ProfilesSection renders it. */
export interface ProfilesController {
  profiles: Accessor<Profile[]>;
  defaultName: Accessor<string>;
  loading: Accessor<boolean>;
  busy: Accessor<boolean>;
  offline: Accessor<string>;
  error: Accessor<string>;
  status: Accessor<string>;
  refresh: () => Promise<void>;
  save: (name: string, settings: ChartSettings, layoutName?: string | null) => Promise<void>;
  load: (profile: Profile) => void;
  remove: (profile: Profile) => Promise<void>;
  setDefault: (profile: Profile) => Promise<void>;
  clearDefault: (profile: Profile) => Promise<void>;
}

export function createProfiles(onLoad: (settings: ChartSettings) => void): ProfilesController {
  const [profiles, setProfiles] = createSignal<Profile[]>([]);
  const [defaultName, setDefaultName] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [offline, setOffline] = createSignal("");
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const refresh = async () => {
    setLoading(true);
    try {
      const fetched = await listProfiles();
      batch(() => {
        setProfiles(fetched.profiles);
        setDefaultName(fetched.default ?? "");
        setOffline("");
      });
    } catch (e) {
      // Resolves, never rejects: a settings panel must not be able to break the chart.
      setOffline(message(e));
    } finally {
      setLoading(false);
    }
  };

  const act = async (fn: () => Promise<void>) => {
    batch(() => {
      setBusy(true);
      setError("");
      setStatus("");
    });
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (name: string, settings: ChartSettings, layoutName?: string | null) =>
    act(async () => {
      const problem = profileNameError(name);
      if (problem) throw new Error(problem);
      const saved = await saveProfile(name, settings, layoutName);
      batch(() => {
        setProfiles((prev) => [saved, ...prev.filter((p) => p.name !== saved.name)]);
        setOffline("");
        setStatus(`Saved ${saved.name}.`);
      });
    });

  const remove = (profile: Profile) =>
    act(async () => {
      await deleteProfile(profile.name);
      batch(() => {
        setProfiles((prev) => prev.filter((p) => p.name !== profile.name));
        // Mirror the backend clearing a default that pointed at this profile.
        if (defaultName() === profile.name) setDefaultName("");
        setStatus(`Deleted ${profile.name}.`);
      });
    });

  const setDefault = (profile: Profile) =>
    act(async () => {
      await setDefaultProfile(profile.name);
      batch(() => {
        setDefaultName(profile.name);
        setStatus(`${profile.name} is now the default for new devices.`);
      });
    });

  const clearDefault = (profile: Profile) =>
    act(async () => {
      await clearDefaultProfile(profile.name);
      batch(() => {
        setDefaultName("");
        setStatus(`Cleared the default.`);
      });
    });

  const load = (profile: Profile) => {
    onLoad(settingsFromProfile(profile.settings));
    batch(() => {
      setError("");
      setStatus(`Loaded ${profile.name}.`);
    });
  };

  void refresh();

  return {
    profiles,
    defaultName,
    loading,
    busy,
    offline,
    error,
    status,
    refresh,
    save,
    load,
    remove,
    setDefault,
    clearDefault,
  };
}

// Named LAYOUTS — a profile's structural twin, same `NamedBlobStore` backend
// at the "layout" kind, but its blob is a `LayoutArrangement` (chrome/
// config.ts). Kept in this file since a Profile can reference one by name.

/** A layout as the backend returns it. `arrangement` is `unknown` on
 * purpose, exactly like `Profile.settings` — untrusted until it is run
 * through `applyArrangement` (chrome/config.ts). */
export interface Layout {
  name: string;
  /** Unix seconds, last save. */
  updated: number;
  arrangement: unknown;
}

const LAYOUTS_BASE = "/api/config/layouts";

/** Every layout, newest-saved first — blobs included, the same reasoning as
 * `listProfiles`: a dozen fields each, so a second round trip per layout
 * would cost more than sending them all. */
export async function listLayouts(): Promise<Layout[]> {
  const body = await request<{ layouts?: Layout[] }>(LAYOUTS_BASE);
  return body.layouts ?? [];
}

/** Create or replace `name`'s stored arrangement. Idempotent by name. */
export async function saveLayout(name: string, arrangement: unknown): Promise<Layout> {
  return request<Layout>(`${LAYOUTS_BASE}/${encodeURIComponent(name.trim())}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(arrangement),
  });
}

export async function deleteLayout(name: string): Promise<void> {
  await request<null>(`${LAYOUTS_BASE}/${encodeURIComponent(name.trim())}`, { method: "DELETE" });
}

/** Headless layouts state — `createProfiles`'s twin. */
export interface LayoutsController {
  layouts: Accessor<Layout[]>;
  loading: Accessor<boolean>;
  busy: Accessor<boolean>;
  offline: Accessor<string>;
  error: Accessor<string>;
  status: Accessor<string>;
  refresh: () => Promise<void>;
  save: (name: string, arrangement: unknown) => Promise<void>;
  duplicate: (layout: Layout, newName: string) => Promise<void>;
  /** Save under the new name then delete the old — the backend has no
   * rename verb (`NamedBlobStore` addresses by current name only). Not
   * atomic: a crash mid-way leaves BOTH names present, the safer failure
   * mode for user-named data with no undo. */
  rename: (layout: Layout, newName: string) => Promise<void>;
  remove: (layout: Layout) => Promise<void>;
}

export function createLayouts(): LayoutsController {
  const [layouts, setLayouts] = createSignal<Layout[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [offline, setOffline] = createSignal("");
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const refresh = async () => {
    setLoading(true);
    try {
      const fetched = await listLayouts();
      batch(() => {
        setLayouts(fetched);
        setOffline("");
      });
    } catch (e) {
      setOffline(message(e));
    } finally {
      setLoading(false);
    }
  };

  const act = async (fn: () => Promise<void>) => {
    batch(() => {
      setBusy(true);
      setError("");
      setStatus("");
    });
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (name: string, arrangement: unknown) =>
    act(async () => {
      const problem = layoutNameError(name);
      if (problem) throw new Error(problem);
      const saved = await saveLayout(name, arrangement);
      batch(() => {
        setLayouts((prev) => [saved, ...prev.filter((l) => l.name !== saved.name)]);
        setOffline("");
        setStatus(`Saved ${saved.name}.`);
      });
    });

  const duplicate = (layout: Layout, newName: string) =>
    act(async () => {
      const problem = layoutNameError(newName);
      if (problem) throw new Error(problem);
      const saved = await saveLayout(newName, layout.arrangement);
      batch(() => {
        setLayouts((prev) => [saved, ...prev.filter((l) => l.name !== saved.name)]);
        setStatus(`Duplicated ${layout.name} as ${saved.name}.`);
      });
    });

  const rename = (layout: Layout, newName: string) =>
    act(async () => {
      const problem = layoutNameError(newName);
      if (problem) throw new Error(problem);
      const trimmed = newName.trim();
      if (trimmed === layout.name) return; // already this name: nothing to do
      const saved = await saveLayout(trimmed, layout.arrangement);
      await deleteLayout(layout.name);
      batch(() => {
        setLayouts((prev) => [
          saved,
          ...prev.filter((l) => l.name !== layout.name && l.name !== saved.name),
        ]);
        setStatus(`Renamed ${layout.name} to ${saved.name}.`);
      });
    });

  const remove = (layout: Layout) =>
    act(async () => {
      await deleteLayout(layout.name);
      batch(() => {
        setLayouts((prev) => prev.filter((l) => l.name !== layout.name));
        setStatus(`Deleted ${layout.name}.`);
      });
    });

  void refresh();

  return { layouts, loading, busy, offline, error, status, refresh, save, duplicate, rename, remove };
}
