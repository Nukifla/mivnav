// Weather overlay SETTINGS vocabulary — core config, not feature behaviour;
// features/weather/sources.ts owns the live source registry and request
// URLs. `model` is an OPAQUE weather-source id (#qmnwrupv), parsed nowhere.

/** No selection yet. Deliberately no static seed id — hardcoding a
 * `grib:`-shaped guess here once shipped a bug that rendered nothing. `""`
 * means "ask the registry". */
export const DEFAULT_WEATHER_MODEL = "";

/** Shape guard only — `""` is legal (unselected). Whether the id names a
 * source THIS boat offers is a live question only the registry can answer. */
export function isWeatherModel(value: unknown): value is string {
  return typeof value === "string";
}

// Raster fields: a field id IS the canonical variable name backend routes
// take (`sources/base.py`'s `VARIABLES`) — which upstream name backs a field
// is entirely inside that source.

export interface WeatherField {
  id: string;
  label: string;
}

/** Named because several call sites special-case wind (flow particles,
 * readout headline). */
export const WIND_FIELD_ID = "wind";

/** Mirrors `mivnav.features.weather.sources.base.VARIABLES`. A source states
 * which it serves (`SourceInfo.variables`); the sheet offers that subset. */
export const WEATHER_FIELDS: readonly WeatherField[] = [
  { id: WIND_FIELD_ID, label: "Wind" },
  { id: "gusts", label: "Gusts" },
  { id: "pressure", label: "Pressure" },
  { id: "temperature", label: "Temp" },
  { id: "waves", label: "Waves" },
];

/** "off" is the resting state — no raster field. */
export type WeatherFieldId = (typeof WEATHER_FIELDS)[number]["id"] | "off";

export const FIELD_BY_ID = new Map(WEATHER_FIELDS.map((f) => [f.id, f]));

/** Is `id` a real field id or "off" (guards a stale/hand-edited profile). */
export function isWeatherField(id: unknown): id is WeatherFieldId {
  return id === "off" || (typeof id === "string" && FIELD_BY_ID.has(id));
}

export interface WeatherSettings {
  /** Selected weather SOURCE's opaque id from `GET /weather/sources`, or `""`.
   * Named `model` for historical reasons (avoids a settings migration). */
  model: string;
  /** Raster field wash, or "off". A source that does not list this variable
   * cannot draw it, and the picker does not offer it. */
  field: WeatherFieldId;
  /** Wind flow particles from the selected source's `wind` variable, or
   * nothing if it lacks wind — no substitute model (#qmnwrupv removed the
   * ICON fallback that silently drew another dataset's wind). */
  arrows: boolean;
  /** Forecast offset from now, hours. `validTimeFor` turns it into one
   * explicit instant the wash, particles and readout all share. */
  hours: number;
  /** Keep the overlay drawn after the weather mode is closed, vs. a
   * transient look that vanishes when you leave the mode. */
  keepVisible: boolean;
  /** Overlay opacity, 0–1 — the wash and the arrows. */
  opacity: number;
}

/** Default overlay opacity — fully opaque wash and arrows. */
export const WEATHER_DEFAULT_OPACITY = 1;

export const DEFAULT_WEATHER: WeatherSettings = {
  model: DEFAULT_WEATHER_MODEL,
  field: "off",
  arrows: false,
  hours: 0,
  keepVisible: false,
  opacity: WEATHER_DEFAULT_OPACITY,
};

/** Largest forecast offset, one week — but no single source serves it all.
 * The ruler shades beyond the SELECTED source's coverage rather than
 * clamping, since the point readout covers more. */
export const WEATHER_MAX_HOURS = 168;
/** Forecast-time step, hours. */
export const WEATHER_HOUR_STEP = 3;
