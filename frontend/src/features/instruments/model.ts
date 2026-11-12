// Pure reads behind the depth and wind instruments — DOM-free so the
// "which depth is this" and "what does the alarm say" rules are testable.

import type { Vessel } from "../../core/signalk";
import type { Shallow, ShallowSettings } from "../../core/shallow";
import type { Urgency } from "../../core/chrome/registry";

export const MS_TO_KN = 1.943844;

/** One sounder path as the tile shows it. */
export interface DepthReading {
  /** The wire field — also the key into `Vessel.stale`. */
  field: "depthBelowSurfaceM" | "depthBelowTransducerM" | "depthBelowKeelM";
  /** NMEA's three-letter name: Depth Below Surface / Transducer / Keel. */
  short: "DBS" | "DBT" | "DBK";
  /** What it is, in words — the board says it outright. */
  words: string;
  metres: number;
  /** Seconds since the last sample, when stale (the server's clock). */
  staleAge: number | null;
}

const DEPTHS = [
  { field: "depthBelowSurfaceM", short: "DBS", words: "below surface" },
  { field: "depthBelowTransducerM", short: "DBT", words: "below transducer" },
  { field: "depthBelowKeelM", short: "DBK", words: "under keel" },
] as const;

/**
 * The depth the tile leads with: the same preference as the server's alarm
 * (`mivnav.shallow.watch`) — surface, then the raw transducer echo, then the
 * keel clearance — taking the first LIVE one, else the first one at all (so
 * a dead sounder still shows, struck through, rather than vanishing).
 */
export function primaryDepth(self: Vessel | null | undefined): DepthReading | null {
  if (!self) return null;
  const all = DEPTHS.flatMap((d) => {
    const metres = self[d.field];
    if (metres === undefined || !Number.isFinite(metres)) return [];
    return [{ ...d, metres, staleAge: self.stale?.[d.field] ?? null }];
  });
  return all.find((d) => d.staleAge === null) ?? all[0] ?? null;
}

/** Metres, one decimal in the water a keel cares about, whole metres past 100. */
export const formatDepth = (m: number): string => (m >= 100 ? m.toFixed(0) : m.toFixed(1));

/** A wind angle in SignalK's sign (−180…180, negative to port) as `34°P` /
 * `120°S` / `0°` — the convention the autopilot's rudder readout uses. */
export function formatWindAngle(deg: number): string {
  const r = Math.round(deg);
  return `${Math.abs(r)}°${r === 0 || Math.abs(r) === 180 ? "" : r < 0 ? "P" : "S"}`;
}

/** The oldest stale age among some guarded fields, or null if all are fresh. */
export function staleOf(self: Vessel | null | undefined, fields: readonly string[]): number | null {
  const ages = fields.map((f) => self?.stale?.[f]).filter((a): a is number => a !== undefined);
  return ages.length ? Math.max(...ages) : null;
}

/** How urgent the depth tile asks to be — the SERVER's debounced verdict,
 * shaped by the boat's off/show/tell. Acknowledged (by anyone) stays
 * elevated but quiet; the kernel still clamps and forces stale to `none`. */
export function shallowUrgency(
  shallow: Shallow | null,
  settings: ShallowSettings,
  acknowledged: boolean,
): Urgency {
  if (!shallow?.active || settings.mode === "off") return "none";
  if (acknowledged || settings.mode === "show") return "notice";
  return "alarm";
}

export function shallowAlertText(shallow: Shallow | null): readonly [string, string] {
  if (!shallow) return ["⚠ SHALLOW WATER", ""] as const;
  const where = DEPTHS.find((d) => d.short === SOURCE_SHORT[shallow.source])?.words ?? "";
  return [
    `⚠ SHALLOW WATER — ${formatDepth(shallow.depthM)} m`,
    `${where} · alarm under ${formatDepth(shallow.thresholdM)} m`,
  ] as const;
}

const SOURCE_SHORT: Record<Shallow["source"], DepthReading["short"]> = {
  surface: "DBS",
  transducer: "DBT",
  // The server's keel source is keel + draft, i.e. surface terms.
  keel: "DBS",
};
