// The DATASET-DECLARE form's vocabulary: Open-Meteo's domain catalog, the
// GRIB product catalog, what each domain can draw, and how far it currently
// reaches. Scoped to DatasetParams.tsx — nothing in the weather MODE may
// import it (would re-introduce the id-parsing #qmnwrupv removed). See
// docs/architecture/weather-dataset-catalog.md for why this table still
// exists post-deletion and the field-table curation caveat.

import { domainOptions, domainGroups } from "@openmeteo/weather-map-layer";
import { FIELD_BY_ID, type WeatherFieldId } from "../../core/weatherSettings";
import { WEATHER_HOST } from "./sources";

// ── Models (the full Open-Meteo domain list) ─────────────────────────────────

export interface WeatherModel {
  /** Open-Meteo capture domain id, e.g. "dwd_icon", "dmi_harmonie_arome_europe". */
  value: string;
  label: string;
  /** Group id (e.g. "dmi", "ncep") for optgroup display. */
  group: string;
  groupLabel: string;
  /** The domain's temporal STEP, straight from `domainOptions.time_interval`
   * ("hourly", "3_hourly", "15_minute", "daily", …). Static library metadata,
   * unlike the forecast LENGTH — see `stepLabel` / `horizonHoursFromManifest`. */
  timeInterval: string;
}

const GROUP_LABEL = new Map(domainGroups.map((g) => [g.value, g.label]));

/** Every Open-Meteo model, grouped for the declare form's picker. The group is
 * the longest domain-group id that prefixes the model id (so
 * "dmi_harmonie_arome_europe" → "dmi", "ncep_gfs025" → "ncep"). */
export const WEATHER_MODELS: readonly WeatherModel[] = domainOptions.map((d) => {
  const group =
    domainGroups
      .map((g) => g.value)
      .filter((gv) => d.value === gv || d.value.startsWith(`${gv}_`))
      .sort((a, b) => b.length - a.length)[0] ?? d.value.split("_")[0];
  return {
    value: d.value,
    label: d.label ?? d.value,
    group,
    groupLabel: GROUP_LABEL.get(group) ?? group,
    timeInterval: d.time_interval ?? "",
  };
});

// GRIB products (direct-DWD offline bake, jt mzyvvmux): hand-typed, mirrors
// the backend's gribfetch.py PRODUCTS by hand — a mismatch 422s at save time
// (WeatherDatasetParams's domains validator), not silently. See
// docs/architecture/weather-dataset-catalog.md.
export interface WeatherGribProduct {
  value: string;
  label: string;
}

export const WEATHER_GRIB_PRODUCTS: readonly WeatherGribProduct[] = [
  { value: "dwd_icon_eu", label: "DWD ICON-EU (~7 km, Europe, to +120 h)" },
  { value: "dwd_icon_d2", label: "DWD ICON-D2 (~2.2 km, central Europe, to +48 h)" },
];

// ── What a domain would offer if you baked it ────────────────────────────────

/** What kind of forecast a domain's `.om` files carry — which decides which of
 * `WEATHER_FIELDS` it could serve. */
export type WeatherModelKind =
  /** Surface atmospheric NWP: 10m wind, gusts, MSL pressure, 2m temperature. */
  | "atmospheric"
  /** Surface atmospheric, but no gust product (the AI emulators, CMA GRAPES). */
  | "atmospheric-basic"
  /** Wave model — significant wave height and friends, no atmosphere. */
  | "wave"
  /** Ocean state (surface currents, SST) — nothing this app draws. */
  | "ocean"
  /** Atmospheric composition (CAMS air quality / greenhouse gases). */
  | "composition"
  /** Pressure-level fields only, no surface layer. */
  | "upper-air"
  /** Monthly/weekly long-range aggregates, not an hourly forecast. */
  | "long-range";

/** Only the NON-atmospheric exceptions; anything absent is `"atmospheric"`.
 * Kept identical to the backend's `openmeteo._KIND`. */
const MODEL_KIND: ReadonlyMap<string, WeatherModelKind> = new Map([
  // Wave models.
  ["dwd_gwam", "wave"],
  ["dwd_ewam", "wave"],
  ["ncep_gfswave025", "wave"],
  ["ncep_gfswave016", "wave"],
  ["ecmwf_wam025", "wave"],
  ["ecmwf_wam", "wave"],
  ["meteofrance_wave", "wave"],
  // Ocean state.
  ["meteofrance_currents", "ocean"],
  ["meteofrance_sea_surface_temperature", "ocean"],
  // Atmospheric composition.
  ["cams_global", "composition"],
  ["cams_global_greenhouse_gases", "composition"],
  // Pressure levels only.
  ["jma_msm_upper_level", "upper-air"],
  // Long-range aggregates — a monthly mean is not a forecast hour.
  ["ecmwf_seas5_monthly", "long-range"],
  ["ecmwf_ec46_ensemble_mean", "long-range"],
  ["ecmwf_ec46_weekly", "long-range"],
  // AI emulators: the core surface fields, but no gust product.
  ["ecmwf_aifs025_single", "atmospheric-basic"],
  ["ecmwf_aifs025_ensemble", "atmospheric-basic"],
  ["ncep_gfs_graphcast025", "atmospheric-basic"],
  ["ncep_aigfs025", "atmospheric-basic"],
  ["cma_grapes_global", "atmospheric-basic"],
] as const);

/** What kind of forecast `domain` carries. An id this catalog has never heard
 * of is assumed to be a surface atmospheric model (see the section note). */
export function modelKind(domain: string): WeatherModelKind {
  return MODEL_KIND.get(domain) ?? "atmospheric";
}

const FIELDS_BY_KIND: Readonly<Record<WeatherModelKind, readonly WeatherFieldId[]>> = {
  atmospheric: ["wind", "gusts", "pressure", "temperature"],
  "atmospheric-basic": ["wind", "pressure", "temperature"],
  wave: ["waves"],
  ocean: [],
  composition: [],
  "upper-air": [],
  "long-range": [],
};

/** Which of `WEATHER_FIELDS` a baked `domain` could draw. EMPTY is a real,
 * meaningful answer — an ocean/air-quality/long-range domain is a perfectly
 * valid Open-Meteo product that this app has no wash for, and a sailor deserves
 * to know that BEFORE baking it, not after. */
export function modelFields(domain: string): readonly WeatherFieldId[] {
  return FIELDS_BY_KIND[modelKind(domain)];
}

/** `modelFields` as display labels, or `null` when the domain carries
 * nothing this app renders — caller owns the copy for that case. */
export function modelFieldsLabel(domain: string): string | null {
  const ids = modelFields(domain);
  if (ids.length === 0) return null;
  return ids.map((id) => FIELD_BY_ID.get(id)?.label ?? id).join(", ");
}

/** A domain's temporal step in plain words. Unlike the forecast LENGTH, this
 * genuinely is static library metadata. Empty string for an unrecognised value. */
export function stepLabel(timeInterval: string): string {
  if (!timeInterval) return "";
  if (timeInterval === "15_minute") return "15-min";
  if (timeInterval === "hourly") return "hourly";
  if (timeInterval.startsWith("weekly")) return "weekly";
  if (timeInterval === "daily" || timeInterval === "monthly") return timeInterval;
  const m = /^(\d+)_hourly$/.exec(timeInterval);
  return m ? `${m[1]}-hourly` : "";
}

// How far a domain currently reaches: NOT static, horizons move run to run,
// so the declare form fetches the live `latest.json` manifest lazily for the
// SELECTED domain. See docs/architecture/weather-dataset-catalog.md.

/** The subset of a capture manifest (`latest.json`) this module reads. */
export interface ModelManifest {
  reference_time?: string;
  /** ISO-8601 forecast times the latest run serves, ascending (e.g.
   * "2026-07-21T05:00Z"). The last is the model's horizon. */
  valid_times?: string[];
}

/** The model's horizon as an ABSOLUTE unix-ms instant (its last valid time), or
 * `null` when the manifest carries no usable times. */
export function lastValidMs(manifest: ModelManifest): number | null {
  const vt = manifest.valid_times;
  if (!vt || vt.length === 0) return null;
  const ms = Date.parse(vt[vt.length - 1]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The forecast horizon a domain currently serves, in hours from `nowMs`,
 * derived from its manifest's last valid time. `null` when the manifest carries
 * no usable times (so the caller says nothing rather than guessing).
 */
export function horizonHoursFromManifest(
  manifest: ModelManifest,
  nowMs: number,
): number | null {
  const lastMs = lastValidMs(manifest);
  return lastMs === null ? null : Math.max(0, (lastMs - nowMs) / 3_600_000);
}

/** A domain's capture-manifest URL on the boat's proxy. */
export function manifestUrl(domain: string): string {
  return `${WEATHER_HOST}/data_spatial/${domain}/latest.json`;
}

/**
 * Fetch a domain's capture manifest. Throws on a network/HTTP error — offline,
 * the declare form simply shows no horizon line, which is honest (a bake needs
 * the network anyway). Pure parsing lives in `lastValidMs` /
 * `horizonHoursFromManifest`, tested without the network.
 */
export async function fetchModelManifest(
  domain: string,
  signal?: AbortSignal,
): Promise<ModelManifest> {
  const res = await fetch(manifestUrl(domain), { signal });
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  return (await res.json()) as ModelManifest;
}
