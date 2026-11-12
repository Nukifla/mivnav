// The wind/field colour legend's DATA — pure, testable without the DOM. See
// docs/architecture/weather-legend.md for why `SCALE_KEY`/`dark` must mirror
// the wash exactly, or the legend silently advertises the wrong colours.

import { getColorScale } from "@openmeteo/weather-map-layer";
import type { RenderableColorScale } from "@openmeteo/weather-map-layer";
import { WIND_FIELD_ID, type WeatherSettings } from "../../core/weatherSettings";
import { fieldVariable } from "./sources";
import type { WindUnit } from "./point";

const MS_TO_KN = 1.94384;

/** Canonical variable → the colour table's own (upstream) key. Mirrors the
 * backend's `colorscale.CANONICAL_SCALE_KEY` exactly — see
 * docs/architecture/weather-legend.md for why it must be listed in full. */
const SCALE_KEY: Readonly<Record<string, string>> = {
  wind: "wind_speed_10m",
  gusts: "wind_gusts_10m",
  pressure: "pressure_msl",
  temperature: "temperature_2m",
  waves: "wave_height",
};

/** The colour-table key for the wash's RASTER field, or null when the field is
 * "off". Keyed off the same `fieldVariable` the tile URL is built from, so the
 * legend and the wash can never disagree. */
export function legendVariable(w: WeatherSettings): string | null {
  const variable = fieldVariable(w);
  if (!variable) return null;
  return SCALE_KEY[variable] ?? variable;
}

/** Is this field measured in wind speed — i.e. does the app-wide `windUnit`
 * (m/s ⇄ kn) apply to its legend? Wind and gusts; nothing else. */
export function isWindSpeedField(fieldId: string): boolean {
  return fieldId === WIND_FIELD_ID || fieldId === "gusts";
}

/** A labelled tick on the vertical ramp: its value's position (0 = bottom of the
 * scale, 1 = top) and the number to print. */
export interface LegendStop {
  frac: number;
  label: string;
}

export interface LegendModel {
  /** The unit shown in the pill at the top (already converted for windUnit). */
  unit: string;
  /** `rgba(...)` colour stops bottom→top, as CSS-ready strings with their track
   * fraction — feeds a `linear-gradient(to top, …)`. */
  gradient: { frac: number; css: string }[];
  /** The numeric labels to float on the ramp, bottom→top. */
  stops: LegendStop[];
  /** Discrete colour blocks, bottom→top, AT THE RENDERED WASH OPACITY (alpha
   * × wash opacity) so each looks exactly like the wash paints that band. */
  bands: { label: string; css: string }[];
}

function rgba(c: readonly [number, number, number, number]): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`;
}

/** The value domain [min,max] of a resolved scale (breakpoint or rgba). */
function scaleDomain(scale: RenderableColorScale): [number, number] {
  if (scale.type === "rgba") return [scale.min, scale.max];
  const bp = scale.breakpoints;
  return [bp[0], bp[bp.length - 1]];
}

/** Pick ~`count` evenly-spaced label values across [min,max], rounded sensibly. */
function labelValues(min: number, max: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(min + ((max - min) * i) / (count - 1));
  }
  return out;
}

function fmt(v: number): string {
  // Whole numbers plain; otherwise one decimal (waves 0.5 m, etc.).
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Subsample `values` down to at most `max`, evenly spaced and ALWAYS keeping the
 * first and last (the scale's extremes). Fewer than `max` pass through unchanged.
 * Keeps the compact ramp's key readable when a breakpoint scale has ~22 bands. */
function thin<T>(values: T[], max: number): T[] {
  if (values.length <= max || max < 2) return values;
  const last = values.length - 1;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(values[Math.round((last * i) / (max - 1))]);
  }
  return out;
}

/** Build the legend for the current weather state, or null when no field is
 * on. `dark` selects the same scale the wash paints; values convert to
 * knots when the field is wind-like and the app unit is knots. */
export function legendModel(
  w: WeatherSettings,
  unit: WindUnit,
  dark: boolean,
  labelCount = 5,
  maxStops = 7,
  maxBands = 7,
): LegendModel | null {
  const variable = legendVariable(w);
  if (!variable) return null;
  const scale = getColorScale(variable, dark);
  const [min, max] = scaleDomain(scale);
  const span = max - min || 1;

  // The colour ramp, bottom→top, positioned by real value fraction so the ramp's
  // colour at height f matches the wash's colour for that value.
  const gradient: { frac: number; css: string }[] = [];
  if (scale.type === "breakpoint") {
    for (let i = 0; i < scale.breakpoints.length; i++) {
      gradient.push({
        frac: (scale.breakpoints[i] - min) / span,
        css: rgba(scale.colors[i]),
      });
    }
  } else {
    for (let i = 0; i < scale.colors.length; i++) {
      gradient.push({
        frac: i / (scale.colors.length - 1),
        css: rgba(scale.colors[i]),
      });
    }
  }

  const windLike = isWindSpeedField(w.field) && unit === "kn";
  const conv = (v: number) => (windLike ? v * MS_TO_KN : v);
  const unitLabel = windLike ? "kn" : scale.unit;

  // Breakpoint scale: label the band boundaries, thinned to `maxStops` so a
  // ~22-band key still fits. Continuous scale: ~labelCount evenly spaced.
  const stopValues =
    scale.type === "breakpoint"
      ? thin([...scale.breakpoints], maxStops)
      : labelValues(min, max, labelCount);
  const stops: LegendStop[] = stopValues
    .map((v) => ({ frac: (v - min) / span, label: fmt(Math.round(conv(v) * 10) / 10) }))
    .reverse();

  // THINNED to `maxBands` like the stops, else a ~22-band scale outgrows a
  // short helm screen. Continuous scales are already few and left unthinned.
  const op = w.opacity;
  const block = (c: readonly [number, number, number, number], v: number) => ({
    label: fmt(Math.round(conv(v) * 10) / 10),
    css: `rgba(${c[0]},${c[1]},${c[2]},${(c[3] * op).toFixed(3)})`,
  });
  const bands =
    scale.type === "breakpoint"
      ? thin(scale.breakpoints.map((v, i) => block(scale.colors[i], v)), maxBands)
      : scale.colors.map((c, i) => block(c, min + (span * i) / (scale.colors.length - 1)));

  return { unit: unitLabel, gradient, stops, bands };
}
