// Man overboard — the pure half: the accidental-tap guard, the numbers the
// screen shows (bearing / range / time since) and the alarm's wording.
// DOM-free so `bun test` covers every rule here.

import type { MobMark, MobNotice } from "../../core/signalk";
import { bearingDeg, rangeNm, type GeoPoint } from "../../core/chrome/geo";
import { formatRange, padDeg } from "../../core/format";

/**
 * The guard against an accidental MOB: the first press ARMS, a second press
 * within this window RAISES. Two taps (or O, O) cost well under a second
 * when meant; a sleeve brushing the button, a child, a fender bumping the
 * screen arm it at most — and it disarms by itself. Chosen over a long-press
 * because a hold is easy to misjudge with wet hands on a pitching boat, and
 * mobile browsers turn a long-press into text selection or a context menu.
 */
export const ARM_MS = 5_000;

export interface ArmGuard {
  /** One press at `nowMs`: `"armed"` (first, or the window lapsed) or `"fire"`. */
  press(nowMs: number): "armed" | "fire";
  /** When the armed state lapses, or `null` while not armed. */
  armedUntil(nowMs: number): number | null;
  disarm(): void;
}

export function createArmGuard(windowMs: number = ARM_MS): ArmGuard {
  let until: number | null = null;
  return {
    press(nowMs) {
      if (until !== null && nowMs < until) {
        until = null;
        return "fire";
      }
      until = nowMs + windowMs;
      return "armed";
    },
    armedUntil(nowMs) {
      return until !== null && nowMs < until ? until : null;
    },
    disarm() {
      until = null;
    },
  };
}

/** Where the mark is, if it has a position. */
export function markPoint(mark: MobMark | null | undefined): GeoPoint | null {
  return mark && mark.lat != null && mark.lng != null ? { lng: mark.lng, lat: mark.lat } : null;
}

/** Seconds since the button went down (never negative: browser and server
 * clocks may disagree by a little). `NaN` for an unparseable time. */
export function elapsedS(atIso: string, nowMs: number): number {
  const t = Date.parse(atIso);
  return Number.isFinite(t) ? Math.max(0, (nowMs - t) / 1000) : Number.NaN;
}

/** `0:42`, `12:05`, `1:02:05` — a stopwatch, because that is what it is. */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–:––";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = `${s % 60}`.padStart(2, "0");
  return h > 0 ? `${h}:${`${m}`.padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export interface MobFix {
  /** Nautical miles from the boat to the mark. */
  rangeNm: number;
  /** Degrees true, boat → mark. */
  bearingDeg: number;
}

/** Boat → mark, or `null` with either end unknown. */
export function mobFix(boat: GeoPoint | null, mark: MobMark | null | undefined): MobFix | null {
  const at = markPoint(mark);
  if (!boat || !at) return null;
  return { rangeNm: rangeNm(boat, at), bearingDeg: bearingDeg(boat, at) };
}

/** The rail tile: range big, bearing and the stopwatch under it. */
export function mobReading(
  mark: MobMark | null,
  boat: GeoPoint | null,
  nowMs: number,
): { value: string; unit?: string; sub?: string } {
  if (!mark) return { value: "—" };
  const clock = formatElapsed(elapsedS(mark.at, nowMs));
  const fix = mobFix(boat, mark);
  if (!fix) return { value: clock, sub: markPoint(mark) ? "no fix" : "no position" };
  const r = formatRange(fix.rangeNm);
  return { value: r.value, unit: r.unit, sub: `${padDeg(fix.bearingDeg)}° ${clock}` };
}

/** `[title, detail]` for the alarm strip. A MOB raised elsewhere (an MFD's
 * key) has no mark here; SignalK's own words then. */
export function mobAlertText(
  mark: MobMark | null,
  notice: MobNotice | null,
  boat: GeoPoint | null,
  nowMs: number,
): readonly [string, string] {
  if (!mark) return ["MAN OVERBOARD", notice?.message ?? "Raised on SignalK by another display"];
  const clock = formatElapsed(elapsedS(mark.at, nowMs));
  const fix = mobFix(boat, mark);
  if (!fix) return ["MAN OVERBOARD", `${clock} ago — ${markPoint(mark) ? "no own fix" : "no position marked"}`];
  const r = formatRange(fix.rangeNm);
  return ["MAN OVERBOARD", `${r.value} ${r.unit} · ${padDeg(fix.bearingDeg)}°T · ${clock} ago`];
}

/** Is there a MOB to alarm about: ours, or anyone's on SignalK. */
export const mobUp = (mark: MobMark | null, notice: MobNotice | null): boolean => !!mark || !!notice;

/**
 * Should THIS screen sound. Yes while SignalK has not taken the alarm over
 * (no echo: SignalK down, off, or not yet caught up — the crew must hear
 * it regardless), else as SignalK says: an ACK anywhere quiets every screen.
 */
export function mobSounds(mark: MobMark | null, notice: MobNotice | null): boolean {
  if (notice) return notice.sound && !notice.acknowledged && !notice.silenced;
  return !!mark;
}
