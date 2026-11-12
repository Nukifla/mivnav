// Display-unit conversion for raw SignalK values. SignalK always reports SI
// (`meta.units`: "m/s", "rad", "K", "Pa", "ratio", ...); this maps that SI
// unit to a QUANTITY and the display units a sailor actually wants (kn, °,
// °C, hPa, %), each with a converter and a decimals hint. Pure and DOM-free.
//
// A display unit is identified by its `id` (what a widget spec stores). Free
// text typed before this existed (`"knots"`, `"kts"`, `"%"`) resolves through
// `aliases`, matched case-insensitively and ONLY within the path's quantity —
// so "C" on a K path is °C and on a C (coulomb) path is coulombs.

export interface DisplayUnit {
  /** Stable id, stored in the widget spec. */
  id: string;
  /** Picker label. */
  label: string;
  /** Unit text shown next to the value on the card ("" for none). */
  symbol: string;
  /** Extra spellings that resolve to this unit (case-insensitive). */
  aliases?: readonly string[];
  /** SI value → display value. */
  from: (si: number) => number;
  /** Display value → SI value (inverse of `from`). */
  to: (v: number) => number;
  /** Default decimals for this unit (a spec's `decimals` overrides). */
  decimals: number;
  /** Custom formatter (e.g. h:mm); ignores decimals. */
  format?: (si: number) => string;
}

export interface Quantity {
  id: string;
  label: string;
  /** The canonical SI unit (`meta.units`) this quantity is reported in. */
  si: string;
  units: readonly DisplayUnit[];
  /** Id of the unit used when the spec chooses none. */
  defaultUnit: string;
}

const scale = (
  id: string,
  label: string,
  symbol: string,
  factor: number,
  decimals: number,
  aliases: readonly string[] = [],
): DisplayUnit => ({
  id,
  label,
  symbol,
  aliases,
  from: (si) => si * factor,
  to: (v) => v / factor,
  decimals,
});

const native = (id: string, label: string, symbol: string, decimals: number, aliases: readonly string[] = []) =>
  scale(id, `${label} (native)`, symbol, 1, decimals, aliases);

const M_PER_NM = 1852;
const M3_PER_USGAL = 0.003785411784;
const M3_PER_IMPGAL = 0.00454609;
const DEG_PER_RAD = 180 / Math.PI;

/** Seconds → "h:mm" (truncating to whole minutes, sign kept). */
export function formatHMM(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const totalMin = Math.floor(Math.abs(seconds) / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${sign}${h}:${String(m).padStart(2, "0")}`;
}

export const QUANTITIES: readonly Quantity[] = [
  {
    id: "speed",
    label: "Speed",
    si: "m/s",
    defaultUnit: "kn",
    units: [
      scale("kn", "knots", "kn", 3600 / M_PER_NM, 1, ["kt", "kts", "knot", "knots"]),
      scale("km/h", "km/h", "km/h", 3.6, 1, ["kmh", "kph", "kmph"]),
      scale("mph", "mph", "mph", 3600 / 1609.344, 1),
      native("m/s", "m/s", "m/s", 1, ["mps"]),
    ],
  },
  {
    id: "angle",
    label: "Angle",
    si: "rad",
    defaultUnit: "deg",
    units: [
      scale("deg", "degrees", "°", DEG_PER_RAD, 0, ["°", "degree", "degrees"]),
      native("rad", "radians", "rad", 3, ["radian", "radians"]),
    ],
  },
  {
    id: "angularVelocity",
    label: "Rate of turn",
    si: "rad/s",
    defaultUnit: "deg/min",
    units: [
      scale("deg/min", "°/min", "°/min", DEG_PER_RAD * 60, 0, ["°/min"]),
      scale("deg/s", "°/s", "°/s", DEG_PER_RAD, 1, ["°/s"]),
      native("rad/s", "rad/s", "rad/s", 3),
    ],
  },
  {
    id: "temperature",
    label: "Temperature",
    si: "K",
    defaultUnit: "degC",
    units: [
      {
        id: "degC",
        label: "°C",
        symbol: "°C",
        aliases: ["°c", "c", "degc", "celsius"],
        from: (k) => k - 273.15,
        to: (c) => c + 273.15,
        decimals: 1,
      },
      {
        id: "degF",
        label: "°F",
        symbol: "°F",
        aliases: ["°f", "f", "degf", "fahrenheit"],
        from: (k) => (k * 9) / 5 - 459.67,
        to: (f) => ((f + 459.67) * 5) / 9,
        decimals: 1,
      },
      native("K", "kelvin", "K", 1, ["kelvin"]),
    ],
  },
  {
    id: "pressure",
    label: "Pressure",
    si: "Pa",
    defaultUnit: "hPa",
    units: [
      scale("hPa", "hPa", "hPa", 1 / 100, 0),
      scale("mbar", "mbar", "mbar", 1 / 100, 0, ["mb", "millibar"]),
      scale("bar", "bar", "bar", 1 / 1e5, 2),
      scale("inHg", "inHg", "inHg", 1 / 3386.389, 2),
      scale("psi", "psi", "psi", 1 / 6894.757, 1),
      native("Pa", "Pa", "Pa", 0, ["pascal"]),
    ],
  },
  {
    id: "ratio",
    label: "Ratio",
    si: "ratio",
    defaultUnit: "%",
    units: [
      scale("%", "percent", "%", 100, 0, ["percent", "pct"]),
      native("ratio", "0–1", "", 2, ["0-1", "0–1", "raw"]),
    ],
  },
  {
    id: "length",
    label: "Length",
    si: "m",
    defaultUnit: "m",
    units: [
      native("m", "metres", "m", 1, ["meter", "meters", "metre", "metres"]),
      scale("km", "km", "km", 1 / 1000, 2),
      scale("NM", "nautical miles", "NM", 1 / M_PER_NM, 2, ["nm", "nmi"]),
      scale("ft", "feet", "ft", 1 / 0.3048, 1, ["feet", "foot"]),
      scale("fathom", "fathoms", "fm", 1 / 1.8288, 1, ["fathoms", "fm", "ftm"]),
    ],
  },
  {
    id: "volume",
    label: "Volume",
    si: "m3",
    defaultUnit: "L",
    units: [
      scale("L", "litres", "L", 1000, 0, ["l", "liter", "liters", "litre", "litres"]),
      scale("usgal", "US gallons", "gal", 1 / M3_PER_USGAL, 1, ["gal", "us gal", "gallon", "gallons"]),
      scale("impgal", "imperial gallons", "imp gal", 1 / M3_PER_IMPGAL, 1, ["imp gal"]),
      native("m3", "m³", "m³", 3, ["m³"]),
    ],
  },
  {
    id: "flow",
    label: "Flow",
    si: "m3/s",
    defaultUnit: "L/h",
    units: [
      scale("L/h", "L/h", "L/h", 3.6e6, 1, ["lph", "l/hr"]),
      scale("L/min", "L/min", "L/min", 6e4, 1, ["lpm"]),
      scale("usgal/h", "US gal/h", "gal/h", 3600 / M3_PER_USGAL, 1, ["gph", "gal/h"]),
      native("m3/s", "m³/s", "m³/s", 6, ["m³/s"]),
    ],
  },
  {
    id: "time",
    label: "Time",
    si: "s",
    defaultUnit: "s",
    units: [
      native("s", "seconds", "s", 0, ["sec", "secs", "seconds"]),
      scale("min", "minutes", "min", 1 / 60, 0, ["mins", "minutes"]),
      scale("h", "hours", "h", 1 / 3600, 1, ["hr", "hrs", "hour", "hours"]),
      {
        id: "h:mm",
        label: "h:mm",
        symbol: "h",
        aliases: ["hh:mm"],
        from: (s) => s / 3600,
        to: (h) => h * 3600,
        decimals: 0,
        format: formatHMM,
      },
    ],
  },
  {
    id: "frequency",
    label: "Frequency",
    si: "Hz",
    defaultUnit: "rpm",
    units: [
      scale("rpm", "rpm", "rpm", 60, 0, ["r/min"]),
      native("Hz", "Hz", "Hz", 1),
    ],
  },
  {
    id: "charge",
    label: "Charge",
    si: "C",
    defaultUnit: "Ah",
    units: [scale("Ah", "amp-hours", "Ah", 1 / 3600, 1), native("C", "coulombs", "C", 0, ["coulomb", "coulombs"])],
  },
  {
    id: "energy",
    label: "Energy",
    si: "J",
    defaultUnit: "Wh",
    units: [
      scale("Wh", "Wh", "Wh", 1 / 3600, 0),
      scale("kWh", "kWh", "kWh", 1 / 3.6e6, 2),
      native("J", "joules", "J", 0, ["joule", "joules"]),
    ],
  },
  {
    id: "power",
    label: "Power",
    si: "W",
    defaultUnit: "W",
    units: [native("W", "watts", "W", 0, ["watt", "watts"]), scale("kW", "kW", "kW", 1 / 1000, 2)],
  },
  { id: "voltage", label: "Voltage", si: "V", defaultUnit: "V", units: [native("V", "volts", "V", 1)] },
  { id: "current", label: "Current", si: "A", defaultUnit: "A", units: [native("A", "amps", "A", 1)] },
];

/** Non-canonical `meta.units` some servers send, as (quantity, factor-to-SI). */
const SI_ALIASES: Record<string, { si: string; factor: number }> = {
  deg: { si: "rad", factor: 1 / DEG_PER_RAD },
  "deg/s": { si: "rad/s", factor: 1 / DEG_PER_RAD },
  "m³": { si: "m3", factor: 1 },
  "m³/s": { si: "m3/s", factor: 1 },
};

const BY_SI = new Map(QUANTITIES.map((q) => [q.si, q]));

/**
 * The quantity a SignalK `meta.units` string reports, plus the factor that
 * turns its raw value into the quantity's canonical SI (1 except for e.g.
 * "deg"). `undefined` for an unknown/missing unit.
 */
export function quantityFor(siUnits: string | undefined): { quantity: Quantity; factor: number } | undefined {
  if (!siUnits) return undefined;
  const s = siUnits.trim();
  const q = BY_SI.get(s);
  if (q) return { quantity: q, factor: 1 };
  const alias = SI_ALIASES[s];
  if (alias) {
    const aq = BY_SI.get(alias.si);
    if (aq) return { quantity: aq, factor: alias.factor };
  }
  return undefined;
}

/** Find a display unit of `q` by id or alias (case-insensitive). */
export function findUnit(q: Quantity, text: string): DisplayUnit | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  const exact = q.units.find((u) => u.id === t);
  if (exact) return exact;
  const lc = t.toLowerCase();
  return q.units.find(
    (u) =>
      u.id.toLowerCase() === lc ||
      (u.symbol !== "" && u.symbol.toLowerCase() === lc) ||
      (u.aliases ?? []).some((a) => a.toLowerCase() === lc),
  );
}

/**
 * The display unit a spec's `unit` text selects for a path reporting
 * `siUnits`. Blank → the quantity's default. Text that names no unit of the
 * quantity → `undefined` (the caller shows the raw value with that text as a
 * plain label, as before units existed). Unknown quantity → `undefined`.
 */
export function resolveUnit(
  siUnits: string | undefined,
  chosen: string | undefined,
): { unit: DisplayUnit; factor: number; quantity: Quantity } | undefined {
  const qf = quantityFor(siUnits);
  if (!qf) return undefined;
  const text = (chosen ?? "").trim();
  const unit =
    text === ""
      ? qf.quantity.units.find((u) => u.id === qf.quantity.defaultUnit)
      : findUnit(qf.quantity, text);
  return unit ? { unit, factor: qf.factor, quantity: qf.quantity } : undefined;
}

/**
 * Convert and format one raw SignalK number. Returns `undefined` when the
 * unit does not resolve (caller falls back to raw + label).
 */
export function convertValue(
  raw: number,
  siUnits: string | undefined,
  chosen: string | undefined,
  decimals?: number,
): { value: string; unit: string } | undefined {
  const r = resolveUnit(siUnits, chosen);
  if (!r) return undefined;
  const si = raw * r.factor;
  if (r.unit.format) return { value: r.unit.format(si), unit: r.unit.symbol };
  return { value: r.unit.from(si).toFixed(decimals ?? r.unit.decimals), unit: r.unit.symbol };
}
