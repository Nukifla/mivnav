// SignalK-path widgets: pure, DOM-free helpers plus the generic instrument for a
// user's per-device spec. SAFETY INVARIANT #1: maxUrgency is always "none" here,
// by construction — never add a spec field that can raise it.

import type { Accessor } from "solid-js";
import type { PathValue } from "../signalk";
import type { SkWidgetSpec } from "./config";
import type { Instrument, Reading } from "./registry";
import { convertValue } from "../units";

const DEFAULT_DECIMALS = 1;

/**
 * A readable label derived from a SignalK path, when the spec gives none.
 * Takes the last two meaningful segments, splits camelCase, capitalises —
 * `→ "House voltage"`. Only ever a default: `spec.label` wins if set.
 */
export function readablePath(path: string): string {
  const segments = path.split(".").filter((s) => s && !/^\d+$/.test(s));
  const tail = segments.slice(-2);
  const words = tail
    .flatMap((s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/))
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return path;
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** A short cell label: the last non-numeric segment, upper-cased, clipped. */
export function shortPath(path: string): string {
  const last = path.split(".").filter((s) => s && !/^\d+$/.test(s)).pop() ?? path;
  return last.slice(0, 6).toUpperCase();
}

/** Format a raw SignalK value; must tolerate number, string, or object without
 * throwing, since the backend passes user paths through untyped. */
export function formatSkValue(value: unknown, decimals: number): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(decimals);
  if (typeof value === "string") {
    const n = Number(value);
    return value.trim() !== "" && Number.isFinite(n) ? n.toFixed(decimals) : value;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const NO_DATA: Reading = { value: "—", state: "null" };

/** Build the generic `Instrument` for one user SK-widget spec. */
export function skInstrument(
  id: string,
  spec: SkWidgetSpec,
  paths: Accessor<Record<string, PathValue>>,
  /** Fallback for the path's `meta.units` when the live snapshot lacks it. */
  unitsFor: (path: string) => string | undefined = () => undefined,
): Instrument {
  const label = spec.label && spec.label.trim() !== "" ? spec.label : readablePath(spec.path);
  return {
    id,
    short: shortPath(spec.path),
    label,
    // Board tab only, never a band — so never dropped by `fitsRoom` on the board.
    band: "rail",
    // INVARIANT #1 (see header): never a spec field, always hard-coded "none".
    maxUrgency: "none",
    staleAge: () => paths()[spec.path]?.age ?? null,
    read: () => {
      const p = paths()[spec.path];
      if (!p || p.value === null || p.value === undefined) return NO_DATA;
      // Convert SI → the chosen display unit when the path's quantity is
      // known and `spec.unit` names one of its units (or is blank → the
      // quantity's default). Otherwise `spec.unit` is just a label on the raw
      // value — what every spec meant before units existed.
      const n =
        typeof p.value === "number"
          ? p.value
          : typeof p.value === "string" && p.value.trim() !== ""
            ? Number(p.value)
            : NaN;
      if (Number.isFinite(n)) {
        const c = convertValue(n, p.units ?? unitsFor(spec.path), spec.unit, spec.decimals);
        if (c) return c;
      }
      const decimals = spec.decimals ?? DEFAULT_DECIMALS;
      const unit = spec.unit && spec.unit.trim() !== "" ? spec.unit : (p.units ?? unitsFor(spec.path));
      return { value: formatSkValue(p.value, decimals), unit };
    },
  };
}
