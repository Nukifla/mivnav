// Weather source for the info-at-point seam (info/attach.tsx): a tap
// volunteers a low-priority "Wind" hit (weather/point.ts) with `context`
// priority so it never displaces a charted object or vessel.

import { createSignal } from "solid-js";
import type { Accessor, Component } from "solid-js";
import type { ChartSettings } from "../../core/style/settings";
import type { WeatherSettings } from "../../core/weatherSettings";
import type {
  InfoDetail,
  InfoHit,
  InfoIconProps,
  InfoPoint,
  InfoProvider,
  InfoQuery,
  InfoRow,
  InfoSection,
} from "../../core/info/types";
import { formatPosition } from "../../core/info/pointProvider";
import { WEATHER_FIELDS } from "../../core/weatherSettings";
import {
  fieldVariable,
  sourceServes,
  validTimeFor,
  weatherEnabled,
  WIND_VARIABLE,
  type WeatherSourceInfo,
} from "./sources";
import {
  cardinal,
  fetchGridPoint,
  fetchWindAtPoint,
  formatFieldValue,
  formatWindSpeed,
  type SampledPoint,
  type WindAtPoint,
} from "./point";
import { createWindVaneIcon } from "./WindInfoIcon";

/** Human labels for the displayed fields, for a non-wind field's headline row. */
const FIELD_LABEL = new Map(WEATHER_FIELDS.map((f) => [f.id, f.label]));

export const WEATHER_INFO_PROVIDER_ID = "weather";

/** Gusts at or above this (m/s) are read out with emphasis — ~near-gale (≈22 kn),
 * the point a small sailing boat starts making decisions about it. */
const GUST_EMPHASIS_MS = 11;

/** The forecast valid time as a short local wall-clock, e.g. "Sat 14:00". */
function formatValid(unix: number): string {
  const d = new Date(unix * 1000);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

/** One-line WIND summary. Speed/direction prefer the grid sample (immediate,
 * offline); gusts always come from the API (grid carries none). `undefined`
 * means caller falls back to the displayed field's value. */
function windSummaryLine(
  speedMs: number,
  gustMs: number | undefined,
  dirDeg: number | undefined,
  unit: "ms" | "kn",
): string | undefined {
  const spd = formatWindSpeed(speedMs, unit);
  if (spd === "—") return undefined;
  const parts = [spd];
  if (gustMs !== undefined && Number.isFinite(gustMs)) {
    const g = formatWindSpeed(gustMs, unit);
    parts.push(`gusts ${g.slice(0, g.lastIndexOf(" "))}`);
  }
  if (dirDeg !== undefined && Number.isFinite(dirDeg)) parts.push(`from ${cardinal(dirDeg)}`);
  return parts.join(" · ");
}

/** Grid-sample seam: samples the server-rendered field at (lat, lon). Defaults
 *  to `fetchGridPoint`; a test injects a fake so the provider is testable
 *  without a network. */
type SampleFn = (
  sourceId: string,
  variable: string,
  time: string,
  lat: number,
  lon: number,
) => Promise<SampledPoint | null>;

/** Sample `variable` from the SELECTED source at `at`, or `null` when there's
 *  nothing to sample (no field/source selected, source doesn't serve it, or
 *  can't answer for this forecast time) — falls through to the point API. */
async function sampleField(
  variable: string | null,
  source: WeatherSourceInfo | null,
  w: WeatherSettings,
  at: InfoPoint,
  sample: SampleFn,
): Promise<SampledPoint | null> {
  if (!variable || !sourceServes(source, variable)) return null;
  const time = validTimeFor(source, w.hours, Date.now());
  return time ? sample(source!.id, variable, time, at.lat, at.lng) : null;
}

/** FROM-bearing for the icon's vane: grid sample first (agrees with what's on
 * the map), then the forecast API; `undefined` leaves the vane north-up. */
async function resolveWindDir(
  at: InfoPoint,
  w: WeatherSettings,
  source: WeatherSourceInfo | null,
  sample: SampleFn,
): Promise<number | undefined> {
  const windSample = await sampleField(WIND_VARIABLE, source, w, at, sample);
  if (windSample?.direction !== undefined && Number.isFinite(windSample.direction)) {
    return windSample.direction;
  }
  const wind = await fetchWindAtPoint(at.lat, at.lng, w.hours).catch(() => null);
  return wind?.dirDeg;
}

/** Whether the grid sample alone (finite speed AND direction) can drive the
 * readout without awaiting the point-forecast API for the headline. Pure,
 * exported for the test. */
export function gridWindSufficient(sample: SampledPoint | null): boolean {
  return (
    !!sample &&
    Number.isFinite(sample.value) &&
    sample.direction !== undefined &&
    Number.isFinite(sample.direction)
  );
}

/** Cache key for the point-forecast extras — a tapped point at a forecast offset. */
function extrasKey(at: InfoPoint, hours: number): string {
  return `${at.lat.toFixed(4)},${at.lng.toFixed(4)},${hours}`;
}

/** Reads `settings` live: gates on any weather layer being on, resolves
 * detail against the current forecast offset, formats wind in the current
 * unit (Speed/Gusts rows are tap-to-swap via `toggleWindUnit`). */
export function createWeatherInfoProvider(deps: {
  settings: Accessor<ChartSettings>;
  toggleWindUnit: () => void;
  /** Selected weather source, or `null` if none/not offered by this boat.
   *  Read live so a source switch under an open panel re-resolves. */
  selectedSource: Accessor<WeatherSourceInfo | null>;
  /** Grid sampler seam (tests). Defaults to `fetchGridPoint`, wrapped so a
   *  network/HTTP failure reads as "no sample" rather than throwing. */
  sample?: SampleFn;
}): InfoProvider {
  const sample =
    deps.sample ??
    ((sourceId, variable, time, lat, lon) =>
      fetchGridPoint(sourceId, variable, time, lat, lon).catch(() => null));

  // Point-forecast EXTRAS (gusts, valid-time) the wash grid doesn't carry,
  // fetched non-blocking and cached per (point, offset); bumping `extrasBump`
  // re-resolves the open panel. A failed fetch caches `null` so it's never retried.
  const extras = new Map<string, WindAtPoint | null>();
  const inflight = new Set<string>();
  const [extrasBump, setExtrasBump] = createSignal(0);
  const ensureExtras = (at: InfoPoint, hours: number): void => {
    const key = extrasKey(at, hours);
    if (extras.has(key) || inflight.has(key)) return;
    inflight.add(key);
    setExtrasBump((n) => n + 1); // a fetch is now in flight — the vane starts spinning on this edge
    void fetchWindAtPoint(at.lat, at.lng, hours)
      .then((w) => extras.set(key, w))
      .catch(() => extras.set(key, null))
      .finally(() => {
        inflight.delete(key);
        setExtrasBump((n) => n + 1); // re-resolve the open panel with the extras; the vane stops spinning
      });
  };

  // True from the moment ensureExtras kicks off the fetch until it settles;
  // reactive on extrasBump so the vane spins for exactly the fetch's lifetime.
  const extrasPending = (at: InfoPoint, hours: number): boolean => {
    extrasBump(); // subscribe: re-read on each fetch edge
    return inflight.has(extrasKey(at, hours));
  };

  return {
    id: WEATHER_INFO_PROVIDER_ID,
    label: "Weather",
    // Volunteers only when the mariner has weather on — otherwise every tap
    // would grow a wind row nobody asked for.
    queryAt: (q: InfoQuery): InfoHit[] => {
      const w = deps.settings().weather;
      if (!weatherEnabled(w)) return [];
      return [
        {
          providerId: WEATHER_INFO_PROVIDER_ID,
          id: "wind",
          priority: "context",
          precision: "point",
          title: "Wind",
          // No subtitle: the only honest sync value would be the forecast time,
          // not the wind glance — that comes from the resolved detail instead.
          lngLat: q.lngLat,
        },
      ];
    },
    // HYBRID readout: headline samples the same server-rendered field the wash
    // draws (only source that can answer for waves); forecast API is the
    // fallback headline plus gusts/valid — its failure no longer blanks the panel.
    detail: async (hit: InfoHit): Promise<InfoDetail> => {
      const at = hit.lngLat;
      if (!at) return { sections: [{ rows: [{ label: "Wind", value: "—" }] }] };

      const w = deps.settings().weather;
      const unit = deps.settings().windUnit;
      const field = w.field;
      const source = deps.selectedSource();
      const displayed = fieldVariable(w);

      // Displayed field and wind resolve CONCURRENTLY when different variables;
      // when the field IS wind, reuse the one sample rather than querying twice.
      const [fieldSample, windSampleSeparate] = await Promise.all([
        sampleField(displayed, source, w, at, sample),
        field === WIND_VARIABLE
          ? Promise.resolve(null)
          : sampleField(WIND_VARIABLE, source, w, at, sample),
      ]);
      const windSample = field === WIND_VARIABLE ? fieldSample : windSampleSeparate;

      // Grid speed+dir sufficient → render now, fetch extras non-blocking.
      // Otherwise the API is the headline and must be awaited.
      const gridDrove = gridWindSufficient(windSample);
      let wind: WindAtPoint | null;
      if (gridDrove) {
        ensureExtras(at, w.hours); // non-blocking; may already be cached
        wind = extras.get(extrasKey(at, w.hours)) ?? null;
      } else {
        wind = await fetchWindAtPoint(at.lat, at.lng, w.hours).catch(() => null);
      }

      // Headline: displayed field's grid value (with direction for wind/waves),
      // else the API wind.
      let headline: string | undefined;
      if (fieldSample && field !== "off") {
        const value = formatFieldValue(field, fieldSample.value, unit);
        if (value !== "—") {
          const dir = fieldSample.direction !== undefined ? cardinal(fieldSample.direction) : undefined;
          headline = dir ? `${value} ${dir}` : value;
        }
      }
      if (headline === undefined && wind) {
        const spd = formatWindSpeed(wind.speedMs, unit);
        if (spd !== "—") headline = `${spd} ${wind.cardinal}`;
      }

      // Wind section: speed/direction from the wind grid when on-map (matches the
      // wash/arrows), gusts/valid from the API.
      const windSpeedMs = windSample ? windSample.value : wind?.speedMs ?? NaN;
      const windDirDeg = windSample?.direction ?? wind?.dirDeg;
      // Gusts/Valid rows hold a FIXED place from first paint (read "—" until the
      // non-blocking forecast lands) so the panel never grows/shifts in place.
      // `showExtras` is the single gate so both rows appear/disappear together.
      const showExtras = gridDrove || wind !== null;
      const windRows: InfoRow[] = [
        { label: "Speed", value: formatWindSpeed(windSpeedMs, unit), onClick: deps.toggleWindUnit },
      ];
      if (showExtras) {
        windRows.push({
          label: "Gusts",
          value: wind ? formatWindSpeed(wind.gustMs, unit) : "—",
          emphasis: !!wind && Number.isFinite(wind.gustMs) && wind.gustMs >= GUST_EMPHASIS_MS,
          onClick: wind ? deps.toggleWindUnit : undefined,
        });
      }
      if (windDirDeg !== undefined) {
        windRows.push({ label: "Direction", value: `${Math.round(windDirDeg)}° ${cardinal(windDirDeg)}` });
      }
      if (showExtras) {
        windRows.push({ label: "Valid", value: wind ? formatValid(wind.validUnix) : "—" });
      }

      const sections: InfoSection[] = [];
      // A non-wind displayed field gets its own headline row above the wind.
      if (fieldSample && field !== "off" && field !== "wind") {
        sections.push({
          rows: [
            { label: FIELD_LABEL.get(field) ?? "Value", value: formatFieldValue(field, fieldSample.value, unit) },
          ],
        });
      }
      sections.push({ label: "Wind", rows: windRows });
      sections.push({ rows: [{ label: "Position", value: formatPosition(at) }] });

      // The summary is WIND (speed · gusts · from DIR), immediate from the grid
      // when present; only if no wind is known at all does it fall back to the
      // displayed field's value.
      const subtitle = windSummaryLine(windSpeedMs, wind?.gustMs, windDirDeg, unit) ?? headline;
      return { subtitle, sections };
    },
    // Vane turned to the resolved FROM-bearing; declines only when `lngLat` is
    // absent (a hand-built weather hit), in which case the panel shows its chip.
    icon: (hit: InfoHit): Component<InfoIconProps> | undefined => {
      const at = hit.lngLat;
      if (!at) return undefined;
      // Spins while either the bearing resolve or the non-blocking extras fetch
      // is still in flight.
      return createWindVaneIcon(
        () => resolveWindDir(at, deps.settings().weather, deps.selectedSource(), sample),
        () => extrasPending(at, deps.settings().weather.hours),
      );
    },
    // Re-resolve when anything the readout reads moves under an open panel.
    watch: () => {
      deps.settings().weather.hours;
      deps.settings().weather.field;
      deps.settings().weather.model;
      deps.settings().weather.arrows;
      deps.settings().windUnit;
      // Re-resolve when the non-blocking point-forecast extras land, so a readout
      // rendered immediately from the grid gains its gusts/valid rows.
      extrasBump();
    },
  };
}
