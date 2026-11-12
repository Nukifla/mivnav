// Pure readout-parts builder, shared identically by the mobile sheet and
// desktop bar. Value/unit are split because the unit is a separate clickable
// label that toggles the app-wide wind unit.

import { cardinal, formatWindSpeed, type PointWeather, type SampledPoint, type WindUnit } from "./point";

const MS_TO_KN = 1.94384;

/** A run of the sub line, bolded or not (mockup bolds the cardinal and gusts). */
export interface SubPart {
  text: string;
  strong?: boolean;
}

export interface ReadoutParts {
  value: string;
  unit: string;
  /** Whether tapping the unit toggles the wind unit — wind & gusts only. */
  unitToggles: boolean;
  dirDeg: number | null;
  sub: SubPart[];
}

/** Split a `formatWindSpeed` result ("12 m/s" / "18 kn" / "—") into number+unit. */
function speedParts(ms: number, unit: WindUnit): { value: string; unit: string } {
  const s = formatWindSpeed(ms, unit);
  if (s === "—") return { value: "—", unit: unit === "kn" ? "kn" : "m/s" };
  const sp = s.lastIndexOf(" ");
  return { value: s.slice(0, sp), unit: s.slice(sp + 1) };
}

/** The wind sub line shared by most fields: "from **SW** · gusts **N** u". */
function windSub(pw: PointWeather, unit: WindUnit): SubPart[] {
  const parts: SubPart[] = [];
  if (Number.isFinite(pw.speedMs)) {
    parts.push({ text: "from " }, { text: cardinal(pw.dirDeg), strong: true });
  }
  if (Number.isFinite(pw.gustMs)) {
    const g = speedParts(pw.gustMs, unit);
    if (parts.length) parts.push({ text: " · " });
    parts.push({ text: "gusts " }, { text: g.value, strong: true }, { text: ` ${g.unit}` });
  }
  return parts;
}

/** A speed summary used as the SUB line when the headline is a non-wind field. */
function windSummary(pw: PointWeather, unit: WindUnit): SubPart[] {
  if (!Number.isFinite(pw.speedMs)) return [{ text: "—" }];
  const s = speedParts(pw.speedMs, unit);
  return [
    { text: "wind " },
    { text: s.value, strong: true },
    { text: ` ${s.unit} ` },
    { text: cardinal(pw.dirDeg), strong: true },
  ];
}

/** The point-forecast API has every scalar except waves, so wave height comes
 * from `sampled` (`fetchGridPoint`, point.ts) — always labelled in metres,
 * never a silent wind m/s (the bug this fixes), even with no grid loaded. */
export function readoutParts(
  pw: PointWeather,
  field: string,
  unit: WindUnit,
  sampled?: SampledPoint | null,
): ReadoutParts {
  const dirDeg = Number.isFinite(pw.dirDeg) ? pw.dirDeg : null;
  switch (field) {
    case "waves": {
      const v = sampled && Number.isFinite(sampled.value) ? sampled.value : NaN;
      return {
        value: Number.isFinite(v) ? v.toFixed(1) : "—",
        unit: "m",
        unitToggles: false,
        dirDeg: sampled?.direction ?? dirDeg,
        sub: windSummary(pw, unit),
      };
    }
    case "gusts": {
      const g = speedParts(pw.gustMs, unit);
      return { value: g.value, unit: g.unit, unitToggles: true, dirDeg, sub: windSummary(pw, unit) };
    }
    case "pressure":
      return {
        value: Number.isFinite(pw.pressureHpa) ? String(Math.round(pw.pressureHpa)) : "—",
        unit: "hPa",
        unitToggles: false,
        dirDeg,
        sub: windSummary(pw, unit),
      };
    case "temperature":
      return {
        value: Number.isFinite(pw.tempC) ? String(Math.round(pw.tempC)) : "—",
        unit: "°C",
        unitToggles: false,
        dirDeg,
        sub: windSummary(pw, unit),
      };
    case "visibility":
      return {
        value: Number.isFinite(pw.visibilityM) ? (pw.visibilityM / 1000).toFixed(1) : "—",
        unit: "km",
        unitToggles: false,
        dirDeg,
        sub: windSummary(pw, unit),
      };
    default: {
      // wind, off — wind headline, gusts sub.
      const s = speedParts(pw.speedMs, unit);
      return { value: s.value, unit: s.unit, unitToggles: true, dirDeg, sub: windSub(pw, unit) };
    }
  }
}

export { MS_TO_KN };
