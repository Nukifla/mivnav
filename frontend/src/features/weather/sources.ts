// Weather source registry, client side: what this boat can show, and the
// URLs to ask for it. Ids are OPAQUE — never parse one (see #qmnwrupv,
// docs/architecture/weather-source-registry.md).

import {
  WEATHER_HOUR_STEP,
  WIND_FIELD_ID,
  type WeatherSettings,
} from "../../core/weatherSettings";
import { THEME_BY_ID, type Palette } from "../../core/style/colors";

/** Canonical variable the wind-flow particles sample, regardless of which
 * field the wash draws. */
export const WIND_VARIABLE = WIND_FIELD_ID;

/** The boat's own server, not Open-Meteo directly — a lazy, range-caching
 * mirror, so a forecast is fetched once and shared/offline across the boat.
 * Empty `location` (tests/SSR) leaves a root-relative `/api/weather`. */
export const WEATHER_HOST = `${typeof location !== "undefined" ? location.origin : ""}/api/weather`;

/** CC BY 4.0, attribution-only — shown in Settings › Overlays, not on-map. */
export const WEATHER_ATTRIBUTION =
  "&copy; <a href='https://open-meteo.com/'>Open-Meteo</a> (CC BY 4.0)";

/** The wash's single MapLibre source+layer id. String kept unchanged from the
 * historical two-slot double buffer, but no longer paired — reconciled
 * satellite-style (`overlay.ts`'s `applyWeatherRaster`). */
export const WEATHER_WASH_LAYER_ID = "weather-raster-0";

/** Valid times a source can answer for, split by what answering COSTS
 * (mirrors backend `Coverage`, unix-ms). `local` needs no network; `remote`
 * needs the link — why the ruler keeps both marks. */
export interface SourceCoverage {
  /** Ascending unix-ms valid times answerable offline. */
  local: readonly number[];
  /** Ascending unix-ms valid times that need the link. */
  remote: readonly number[];
  /** The run this coverage came from, unix-ms, or null. */
  referenceMs: number | null;
}

export interface WeatherSourceInfo {
  /** OPAQUE. Never parsed, split, prefixed or pattern-matched. */
  id: string;
  label: string;
  /** Human-readable state ("Offline · GRIB"). Deliberately NOT
   * machine-readable — a parseable kind is what a client branches on. */
  badge: string;
  /** True when answering may need the link — the offline/metered gate. */
  requiresNetwork: boolean;
  /** Canonical variable ids this source serves (`wind`, `gusts`, …). The field
   * picker offers exactly these and nothing else. */
  variables: readonly string[];
  coverage: SourceCoverage;
  /** Geographic extent in degrees, or null for global / not yet known. */
  region: { west: number; south: number; east: number; north: number } | null;
}

export const EMPTY_SOURCES: readonly WeatherSourceInfo[] = [];

/** Parse an ISO instant list into ascending unix-ms, dropping unparseable
 * entries rather than failing the whole source. */
function timesFromWire(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const t of raw) {
    const ms = Date.parse(String(t));
    if (Number.isFinite(ms)) out.push(ms);
  }
  return out.sort((a, b) => a - b);
}

function coverageFromWire(raw: unknown): SourceCoverage {
  const c = (raw ?? {}) as Record<string, unknown>;
  const refMs = Date.parse(String(c.reference_time ?? ""));
  return {
    local: timesFromWire(c.local),
    remote: timesFromWire(c.remote),
    referenceMs: Number.isFinite(refMs) ? refMs : null,
  };
}

/** Parse `GET /weather/sources` into a source list, dropping any row with no
 * string `id` (a hand-edited response, a future field shape) rather than
 * failing the whole list. */
export function sourcesFromWire(body: unknown): WeatherSourceInfo[] {
  const rows = (body as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(rows)) return [];
  const out: WeatherSourceInfo[] = [];
  for (const raw of rows as Record<string, unknown>[]) {
    if (!raw || typeof raw.id !== "string" || raw.id.length === 0) continue;
    out.push({
      id: raw.id,
      label: typeof raw.label === "string" && raw.label.length > 0 ? raw.label : raw.id,
      badge: typeof raw.badge === "string" ? raw.badge : "",
      requiresNetwork: raw.requires_network === true,
      variables: Array.isArray(raw.variables)
        ? raw.variables.filter((v): v is string => typeof v === "string")
        : [],
      coverage: coverageFromWire(raw.coverage),
      region:
        raw.region && typeof raw.region === "object"
          ? (raw.region as WeatherSourceInfo["region"])
          : null,
    });
  }
  return out;
}

/** Throws on a network/HTTP error; callers treat a throw as `EMPTY_SOURCES` —
 * an unreachable own-backend must still let weather mode open, with an empty
 * (not stale) picker. */
export async function fetchWeatherSources(
  signal?: AbortSignal,
): Promise<WeatherSourceInfo[]> {
  const res = await fetch(`${WEATHER_HOST}/sources`, { signal });
  if (!res.ok) throw new Error(`weather sources: HTTP ${res.status}`);
  return sourcesFromWire(await res.json());
}

/** The source `id` names, or `null` when this boat does not offer it. `null`
 * for a set-but-unavailable selection is the point: the UI says so instead of
 * quietly rendering a different source's numbers. */
export function sourceById(
  sources: readonly WeatherSourceInfo[],
  id: string,
): WeatherSourceInfo | null {
  return sources.find((s) => s.id === id) ?? null;
}

/** Steps `dir` (+1/-1) away from `current` in `sources`, wrapping. Empty list
 * is a no-op; unknown `current` resolves to index 0. */
export function stepSource(
  sources: readonly WeatherSourceInfo[],
  current: string,
  dir: 1 | -1,
): string {
  const n = sources.length;
  if (n === 0) return current;
  const i = Math.max(
    0,
    sources.findIndex((s) => s.id === current),
  );
  return sources[(i + dir + n) % n].id;
}

/** Does `source` serve `variable`? The picker's whole gate — a source states
 * its variables, so this is a lookup, never an inference from the id. */
export function sourceServes(
  source: WeatherSourceInfo | null,
  variable: string,
): boolean {
  return !!source && source.variables.includes(variable);
}

const HOUR_MS = 3_600_000;

/** Span `times` covers as forecast-offset hours from `nowMs`, or `null` if
 * nothing is still ahead. `fromHours` clamped at 0: past hours aren't
 * selectable, so reporting them would shade past what the scrubber reaches. */
export function coverageWindow(
  times: readonly number[],
  nowMs: number,
): { fromHours: number; toHours: number } | null {
  if (times.length === 0) return null;
  const toHours = (times[times.length - 1] - nowMs) / HOUR_MS;
  if (toHours <= 0) return null;
  return { fromHours: Math.max(0, (times[0] - nowMs) / HOUR_MS), toHours };
}

/**
 * The exact UTC instant to request for a scrub position of `hours`, or
 * `null` when this source cannot answer. Snaps to the nearest declared
 * coverage time within `WEATHER_HOUR_STEP` hours. See
 * docs/architecture/weather-source-registry.md.
 */
export function validTimeFor(
  source: WeatherSourceInfo | null,
  hours: number,
  nowMs: number,
): string | null {
  if (!source) return null;
  const targetMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS + hours * HOUR_MS;
  const declared = [...source.coverage.local, ...source.coverage.remote];
  if (declared.length === 0) return new Date(targetMs).toISOString();
  let best = declared[0];
  for (const t of declared) {
    if (Math.abs(t - targetMs) < Math.abs(best - targetMs)) best = t;
  }
  return Math.abs(best - targetMs) <= WEATHER_HOUR_STEP * HOUR_MS
    ? new Date(best).toISOString()
    : null;
}

/** Reads the theme's own `dark` flag rather than a hardcoded id list — same
 * flag backend `css.py` uses, so a custom theme in `~/.config/mivnav/themes/`
 * gets it right too. */
export function isDarkPalette(palette: Palette): boolean {
  return THEME_BY_ID[palette]?.dark === true;
}

/** Is any weather layer on — the gate for the tap-to-read point provider, and
 * for fetching the source list at all. The weather MODE is the control surface;
 * "on" is just a field or the wind-flow particles being selected. */
export function weatherEnabled(w: WeatherSettings): boolean {
  return w.field !== "off" || w.arrows;
}

/** The variable the wash draws, or `null` when the field is "off". A field id
 * IS a canonical variable now; kept named since several call sites ask. */
export function fieldVariable(w: WeatherSettings): string | null {
  return w.field === "off" ? null : w.field;
}

/** `GET /weather/sources/{id}/wash/{variable}/{z}/{x}/{y}.png` — the colourized
 * raster wash, as a MapLibre `{z}/{x}/{y}` template. */
export function washTilesUrl(
  sourceId: string,
  variable: string,
  timeIso: string,
  dark: boolean,
): string {
  return (
    `${WEATHER_HOST}/sources/${encodeURIComponent(sourceId)}/wash/` +
    `${encodeURIComponent(variable)}/{z}/{x}/{y}.png` +
    `?time=${encodeURIComponent(timeIso)}&dark=${dark}`
  );
}

/** `GET /weather/sources/{id}/field/{variable}/{z}/{x}/{y}.png` — the RGBA
 * vector texture the particle sim samples. `field`, not `wind`: waves carry a
 * direction too, so a wave particle layer needs no second route. */
export function fieldTileUrl(
  sourceId: string,
  variable: string,
  timeIso: string,
  z: number,
  x: number,
  y: number,
): string {
  return (
    `${WEATHER_HOST}/sources/${encodeURIComponent(sourceId)}/field/` +
    `${encodeURIComponent(variable)}/${z}/${x}/${y}.png` +
    `?time=${encodeURIComponent(timeIso)}`
  );
}

/** `GET /weather/sources/{id}/point` — the same field the tiles are rendered
 * from, sampled at one position. */
export function pointUrl(
  sourceId: string,
  variable: string,
  timeIso: string,
  lat: number,
  lon: number,
): string {
  const q = new URLSearchParams({
    variable,
    time: timeIso,
    lat: String(lat),
    lon: String(lon),
  });
  return `${WEATHER_HOST}/sources/${encodeURIComponent(sourceId)}/point?${q.toString()}`;
}

export interface ResolvedWeatherRaster {
  /** Swap-detection identity for the overlay reconcile (`overlay.ts`'s
   * `applyWeatherRaster`) — a raster source's `tiles` can't update in place.
   * Includes the resolved time, or a scrub wouldn't repaint. */
  key: string;
  /** The `{z}/{x}/{y}` tile-URL template for MapLibre's raster `tiles`. */
  tiles: string;
  attribution: string;
  minzoom?: number;
  maxzoom?: number;
}

/** Mirrors backend `WeatherConfig.render_max_zoom`'s default — baked into
 * `maxzoom` so MapLibre overzooms the last real tile instead of requesting
 * (and 404ing on) finer ones. */
const WASH_RENDER_MAX_ZOOM = 10;

/** The wash's raster tile source, or `null` when there's nothing to draw —
 * every gate is a "render nothing", none a substitution. `dark` is baked into
 * the URL/key since a palette flip changes what the SERVER renders — must refetch. */
export function resolveWeatherRaster(
  w: WeatherSettings,
  source: WeatherSourceInfo | null,
  dark: boolean,
  nowMs: number,
): ResolvedWeatherRaster | null {
  const variable = fieldVariable(w);
  if (!variable || !source || !sourceServes(source, variable)) return null;
  const time = validTimeFor(source, w.hours, nowMs);
  if (!time) return null;
  return {
    key: `${source.id}|${variable}|${time}|${dark}`,
    tiles: washTilesUrl(source.id, variable, time, dark),
    attribution: WEATHER_ATTRIBUTION,
    maxzoom: WASH_RENDER_MAX_ZOOM,
  };
}
