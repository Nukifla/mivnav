// Anchor watch, the pure half: what the plugin's state MEANS for the chrome
// (phase, urgency, the alarm band's words) and the watch circle's geometry.
// DOM-free so `bun test` covers it. The plugin is the watcher (anchor.md);
// nothing here decides whether the boat is dragging — SignalK's notification
// does, so mivnav and the MFD can never disagree.

import type { Anchor, SignalKStatus } from "../../core/signalk";
import type { Urgency } from "../../core/chrome/registry";
import type { GeoPoint } from "../../core/chrome/geo";

/** anchor.md Q6 — the alarm radius offered when there is no fix to measure
 * "from here" against. */
export const DEFAULT_RADIUS_M = 40;
/** The radius steppers' increment. */
export const RADIUS_STEP_M = 5;
/** Mirror the backend's `RADIUS_MIN_M`/`RADIUS_MAX_M` so a stepper can't ask
 * for a 422. */
export const RADIUS_MIN_M = 5;
export const RADIUS_MAX_M = 1000;
/** Mirrors the backend's `FROM_HERE_MARGIN_M`: swing room on top of the
 * distance measured when the alarm is armed. */
export const FROM_HERE_MARGIN_M = 10;

/** `none` = no plugin heard (not installed, SignalK off); `up` = raised;
 * `dropping` = marked with no radius — the rode still going out, no alarm
 * (Freeboard's "let out rode"; the plugin does not watch without a radius);
 * `down` = anchored and watched. Read from the plugin, so every display and
 * a reload agree. */
export type AnchorPhase = "none" | "up" | "dropping" | "down";

export function anchorPhase(a: Anchor | null): AnchorPhase {
  if (!a) return "none";
  if (a.lat === undefined || a.lng === undefined) return "up";
  return a.maxRadiusM === undefined ? "dropping" : "down";
}

/** Anchored at all — dropping or watched. */
export const isAnchored = (a: Anchor | null): boolean => {
  const p = anchorPhase(a);
  return p === "down" || p === "dropping";
};

const M_PER_DEG = 111_320;
/** Equirectangular metres — exact enough at swing-circle distances. */
export function metres(a: GeoPoint, b: GeoPoint): number {
  const dy = (a.lat - b.lat) * M_PER_DEG;
  const dx = (a.lng - b.lng) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Boat→anchor, m: the plugin's `currentRadius` while it watches, else our
 * own from the fix — unarmed, the plugin does not measure. */
export function fromAnchorM(a: Anchor | null, boat: GeoPoint | null): number | undefined {
  if (a?.currentRadiusM !== undefined) return a.currentRadiusM;
  const at = anchorPoint(a);
  return at && boat ? metres(boat, at) : undefined;
}

/** The radius arming would use: the distance to the anchor now + the
 * margin (+ the plugin's fudge, as the backend's "from here" adds it). */
export function armRadiusFromHere(a: Anchor | null, boat: GeoPoint | null): number | undefined {
  const cur = fromAnchorM(a, boat);
  if (cur === undefined) return undefined;
  return clampRadius(Math.ceil(cur + FROM_HERE_MARGIN_M + Math.max(0, a?.fudgeM ?? 0)));
}

export const anchorPoint = (a: Anchor | null): GeoPoint | null =>
  a && a.lat !== undefined && a.lng !== undefined ? { lng: a.lng, lat: a.lat } : null;

const ALARMING = new Set(["alarm", "emergency"]);
const WARNING = new Set(["warn", "alert"]);

/** Is the plugin alarming right now (whether or not anyone has ACKed it)? */
export const isAlarming = (a: Anchor | null): boolean => !!a?.alarm && ALARMING.has(a.alarm.state);

/**
 * The urgency the plugin's notification asks for. An ACKed alarm drops to
 * `notice`: SignalK keeps it visible but quiet everywhere (Q5), so every
 * device's alarm band clears together instead of each wanting its own ACK.
 * A state change re-arms it server-side and it comes back as `alarm`.
 */
export function anchorUrgency(a: Anchor | null): Urgency {
  const alarm = a?.alarm;
  if (!alarm) return "none";
  if (ALARMING.has(alarm.state)) return alarm.acknowledged ? "notice" : "alarm";
  return WARNING.has(alarm.state) ? "notice" : "none";
}

/** The plugin's default drag message is just "Anchor Alarm - Emergency"; its
 * others ("No position received", "The anchoring process has not been
 * completed") say something, so they are kept. */
const GENERIC = /^anchor alarm\b/i;

export function anchorAlertText(a: Anchor | null): readonly [string, string] {
  const msg = a?.alarm?.message;
  const title =
    !msg || GENERIC.test(msg) ? "⚓ ANCHOR DRAGGING" : `⚓ ANCHOR ALARM — ${msg}`;
  const parts: string[] = [];
  if (a?.currentRadiusM !== undefined) parts.push(`${Math.round(a.currentRadiusM)} m from anchor`);
  if (a?.maxRadiusM !== undefined) parts.push(`watch ${Math.round(a.maxRadiusM)} m`);
  if (a?.bearingTrueDeg !== undefined) parts.push(`anchor bears ${Math.round(a.bearingTrueDeg) % 360}°`);
  return [title, parts.join(" · ")] as const;
}

/** The rail tile: `31/40` m, or `—` while there is nothing to measure yet. */
export function anchorReading(a: Anchor | null): { value: string; unit?: string; sub?: string } {
  const phase = anchorPhase(a);
  if (phase === "dropping") return { value: "SET", sub: "no alarm" };
  if (phase !== "down") return { value: "—" };
  const cur = a?.currentRadiusM;
  const max = a?.maxRadiusM;
  return {
    value: `${cur === undefined ? "–" : Math.round(cur)}/${max === undefined ? "–" : Math.round(max)}`,
    unit: "m",
    sub: a?.bearingTrueDeg !== undefined ? `${Math.round(a.bearingTrueDeg) % 360}°` : undefined,
  };
}

export const clampRadius = (m: number): number =>
  Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, Math.round(m)));

/** The link gate: a dropped SignalK/mivnav link means every number above is
 * last-known. The plugin and the MFD still watch; this screen cannot. */
export const anchorLive = (status: SignalKStatus): boolean => status === "connected";

const M_PER_DEG_LAT = 111_320;

/**
 * The watch circle as a closed ring, `[lng, lat][]`. A true metric circle on
 * the local tangent plane (good to centimetres at these radii), drawn as a
 * polygon so it scales with the chart instead of a pixel-radius `circle`.
 */
export function circleRing(c: GeoPoint, radiusM: number, steps = 72): [number, number][] {
  const cosLat = Math.cos((c.lat * Math.PI) / 180);
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const north = radiusM * Math.cos(t);
    const east = radiusM * Math.sin(t);
    ring.push([c.lng + east / (M_PER_DEG_LAT * Math.max(cosLat, 1e-6)), c.lat + north / M_PER_DEG_LAT]);
  }
  return ring;
}
