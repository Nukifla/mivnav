// Wind at a single point, from Open-Meteo's free JSON forecast API — a
// DIFFERENT endpoint from the map tiles (weather/overlays.ts): the tiles are
// a coarse raster, this returns the model's true 10m wind at an exact lat/lon.

import { pointUrl } from "./sources";

/** The point-forecast endpoint — proxied through the boat's server (same origin,
 * `mivnav.weather.proxy`), so a device with no internet of its own still reads
 * through the Pi. Not Open-Meteo directly; the upstream lives in backend config. */
export const POINT_FORECAST_URL = `${typeof location !== "undefined" ? location.origin : ""}/api/weather/forecast`;

// The GRID point-sample lives on the id-addressed route now — see
// `sources.ts`'s `pointUrl` (`GET /weather/sources/{id}/point`), which is the
// one place a weather request URL is built.

/** Wind-speed display unit — see ChartSettings.windUnit. */
export type WindUnit = "ms" | "kn";

const MS_TO_KN = 1.94384;

/** Format a wind speed (stored in m/s) in the chosen unit. */
export function formatWindSpeed(ms: number, unit: WindUnit): string {
  if (!Number.isFinite(ms)) return "—";
  return unit === "kn" ? `${Math.round(ms * MS_TO_KN)} kn` : `${Math.round(ms)} m/s`;
}

export interface WindAtPoint {
  /** Wind speed, metres per second (the base unit; formatted on display). */
  speedMs: number;
  /** Wind gusts, metres per second. */
  gustMs: number;
  /** Direction the wind blows FROM, degrees true (meteorological convention). */
  dirDeg: number;
  /** 16-point compass of `dirDeg` (e.g. "WSW"). */
  cardinal: string;
  /** The forecast valid time actually returned, as a unix-seconds timestamp. */
  validUnix: number;
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** 16-point compass name for a bearing in degrees. */
export function cardinal(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS[i];
}

/** The forecast URL for a point. Hourly (not `current`) so any forecast offset
 * can be indexed from the same response; unixtime for arithmetic, not parsing. */
export function pointForecastUrl(lat: number, lng: number): string {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    wind_speed_unit: "ms",
    timeformat: "unixtime",
    forecast_days: "8",
  });
  return `${POINT_FORECAST_URL}?${q.toString()}`;
}

interface HourlyResponse {
  hourly?: {
    time?: number[];
    wind_speed_10m?: number[];
    wind_direction_10m?: number[];
    wind_gusts_10m?: number[];
  };
}

/**
 * Pick the wind at the hour nearest `targetUnix` from a forecast response.
 * Pure and exported for tests — the fetch is the only impure part.
 */
export function windFromForecast(body: HourlyResponse, targetUnix: number): WindAtPoint {
  const h = body.hourly;
  const times = h?.time;
  if (!times || times.length === 0) throw new Error("forecast: no hourly times");
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < times.length; i++) {
    const gap = Math.abs(times[i] - targetUnix);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  const dirDeg = h?.wind_direction_10m?.[best] ?? 0;
  return {
    speedMs: h?.wind_speed_10m?.[best] ?? NaN,
    gustMs: h?.wind_gusts_10m?.[best] ?? NaN,
    dirDeg,
    cardinal: cardinal(dirDeg),
    validUnix: times[best],
  };
}

/** Fetch the wind at `(lat, lng)` for a forecast offset of `hours` from now.
 * Throws on a network/HTTP error or an empty forecast — the caller surfaces
 * that as a readout error, which offline is the honest state. */
export async function fetchWindAtPoint(
  lat: number,
  lng: number,
  hours: number,
  signal?: AbortSignal,
): Promise<WindAtPoint> {
  const res = await fetch(pointForecastUrl(lat, lng), { signal });
  if (!res.ok) throw new Error(`forecast: HTTP ${res.status}`);
  const body = (await res.json()) as HourlyResponse;
  const targetUnix = Math.floor(Date.now() / 1000) + hours * 3600;
  return windFromForecast(body, targetUnix);
}

// ── The richer point readout (the weather MODE's cursor readout) ────────────
// Every scalar the field picker offers EXCEPT waves (a separate marine API),
// so waves fall back to the wind headline. One request, indexed like above.

export interface PointWeather extends WindAtPoint {
  pressureHpa: number;
  tempC: number;
  visibilityM: number;
}

const READOUT_VARS =
  "wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,temperature_2m,visibility";

/** The readout forecast URL: wind plus the scalars the field picker can select. */
export function pointWeatherUrl(lat: number, lng: number): string {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: READOUT_VARS,
    wind_speed_unit: "ms",
    timeformat: "unixtime",
    forecast_days: "8",
  });
  return `${POINT_FORECAST_URL}?${q.toString()}`;
}

export interface FullHourly {
  hourly?: HourlyResponse["hourly"] & {
    pressure_msl?: number[];
    temperature_2m?: number[];
    visibility?: number[];
  };
}

/** Pick every readout variable at the hour nearest `targetUnix`. */
export function weatherFromForecast(body: FullHourly, targetUnix: number): PointWeather {
  const wind = windFromForecast(body, targetUnix);
  const h = body.hourly;
  const i = (h?.time ?? []).indexOf(wind.validUnix);
  return {
    ...wind,
    pressureHpa: h?.pressure_msl?.[i] ?? NaN,
    tempC: h?.temperature_2m?.[i] ?? NaN,
    visibilityM: h?.visibility?.[i] ?? NaN,
  };
}

// ── The grid point-sample (Phase 4: server-side, replaces weather/sampler.ts) ─

export interface SampledPoint {
  /** The field's value at (lat, lon) in the grid's NATIVE unit — identical to
   * what the point-forecast API returns for the same fields. */
  value: number;
  /** Wind/wave FROM bearing, degrees true, in [0, 360) — only for fields
   * with a direction component (wind, waves); `undefined` otherwise. */
  direction?: number;
}

/**
 * Sample the field the wash/particle tiles render from, via `GET
 * /weather/sources/{id}/point` — same `sourceId`/`variable`/`timeIso` as the
 * tile routes, so the readout can never come from different data than the pixels.
 */
export async function fetchGridPoint(
  sourceId: string,
  variable: string,
  timeIso: string,
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<SampledPoint | null> {
  const res = await fetch(pointUrl(sourceId, variable, timeIso, lat, lon), { signal });
  if (!res.ok) throw new Error(`weather point: HTTP ${res.status}`);
  const body = (await res.json()) as { value?: unknown; direction?: unknown };
  if (typeof body.value !== "number") return null;
  return typeof body.direction === "number"
    ? { value: body.value, direction: body.direction }
    : { value: body.value };
}

/** Format a single sampled GRID value (`fetchGridPoint`) in its native unit.
 * Mirrors `readoutFor` but, unlike the API path, CAN render WAVES (metres). */
export function formatFieldValue(field: string, value: number, unit: WindUnit): string {
  if (!Number.isFinite(value)) return "—";
  switch (field) {
    case "wind":
    case "gusts":
      return formatWindSpeed(value, unit);
    case "pressure":
      return `${Math.round(value)} hPa`;
    case "temperature":
      return `${Math.round(value)}°C`;
    case "visibility":
      return `${(value / 1000).toFixed(1)} km`;
    case "waves":
      return `${value.toFixed(1)} m`;
    default:
      return "—";
  }
}

/** The one line to show for a field: the selected field's value first, wind as
 * secondary. Waves have no point value here, so they read as wind. */
export function readoutFor(
  pw: PointWeather,
  field: string,
  unit: WindUnit,
): { headline: string; sub: string } {
  const spd = formatWindSpeed(pw.speedMs, unit);
  const wind = spd === "—" ? "—" : `${spd} ${pw.cardinal}`;
  const gust = Number.isFinite(pw.gustMs) ? `gust ${formatWindSpeed(pw.gustMs, unit)}` : "";
  switch (field) {
    case "pressure":
      return { headline: Number.isFinite(pw.pressureHpa) ? `${Math.round(pw.pressureHpa)} hPa` : "—", sub: wind };
    case "temperature":
      return { headline: Number.isFinite(pw.tempC) ? `${Math.round(pw.tempC)}°C` : "—", sub: wind };
    case "visibility":
      return {
        headline: Number.isFinite(pw.visibilityM) ? `${(pw.visibilityM / 1000).toFixed(1)} km` : "—",
        sub: wind,
      };
    case "gusts":
      return { headline: gust || "—", sub: wind };
    default: // wind, waves, off
      return { headline: wind, sub: gust };
  }
}

/** Fetch the full point readout for a forecast offset of `hours`. */
export async function fetchPointWeather(
  lat: number,
  lng: number,
  hours: number,
  signal?: AbortSignal,
): Promise<PointWeather> {
  const res = await fetch(pointWeatherUrl(lat, lng), { signal });
  if (!res.ok) throw new Error(`forecast: HTTP ${res.status}`);
  const body = (await res.json()) as FullHourly;
  const targetUnix = Math.floor(Date.now() / 1000) + hours * 3600;
  return weatherFromForecast(body, targetUnix);
}

/** Fetch the whole forecast SERIES for a point — spans the full week
 * (`forecast_days=8`), so ONE fetch covers every scrub offset; the caller
 * re-indexes locally instead of refetching per step (avoids flicker). */
export async function fetchPointForecast(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<FullHourly> {
  const res = await fetch(pointWeatherUrl(lat, lng), { signal });
  if (!res.ok) throw new Error(`forecast: HTTP ${res.status}`);
  return (await res.json()) as FullHourly;
}
