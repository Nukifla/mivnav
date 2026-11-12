// Ruler time model — pure, so the day-boundary maths is testable off the DOM.
// Display window is calendar days [startOfDay(now), now+MAX_HOURS]; the
// selectable horizon is [now, now+MAX_HOURS] — before "now" is context only.
// See docs/architecture/weather-ruler.md.

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** A calendar day the window touches: its label, its span as track fractions, and
 * the fraction to centre the label on. */
export interface RulerDay {
  /** Abbreviated weekday, e.g. "Sat". */
  weekday: string;
  /** Zero-padded DD-MM, e.g. "18-07". */
  date: string;
  /** Left edge of the day's segment, 0–1 (clamped to the window). */
  startFrac: number;
  /** Right edge, 0–1. */
  endFrac: number;
  /** Where to centre the label: midpoint of the visible segment. */
  centerFrac: number;
}

export interface RulerModel {
  /** Display-window start — local midnight today, unix ms. */
  startMs: number;
  /** Display-window end — now + maxHours, unix ms. */
  endMs: number;
  /** "Now" (offset 0) as unix ms — the accent marker's time. */
  nowMs: number;
  /** Maximum selectable offset, hours (the served horizon). */
  maxHours: number;
  /** "Now" as a track fraction (where the accent marker and the selectable
   * region begin). */
  nowFrac: number;
  /** The calendar days the window touches, in order. N of them. */
  days: RulerDay[];
  /** Vertical day-boundary lines as fractions: the window start (0), every local
   * midnight inside it, and the window end (1) — N+1 for N days. */
  daylines: number[];
}

/** Local midnight at or before `ms`. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Abbreviated weekday (e.g. "Sat") — short so a week of day columns fits. */
function weekdayName(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short" });
}

/** DD-MM for a day, zero-padded, locale-independent (the mockup's "18-07"). */
function dateLabel(ms: number): string {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}`;
}

/** Build the ruler model for a display window [startOfDay(now), now+maxHours].
 * Daylines are the window edges plus every midnight strictly inside it; day
 * cells are the segments between them (clipped to the window). */
export function rulerModel(nowMs: number, maxHours: number): RulerModel {
  const startMs = startOfDay(nowMs);
  const endMs = nowMs + maxHours * MS_PER_HOUR;
  const span = endMs - startMs;
  const frac = (ms: number) => (span <= 0 ? 0 : (ms - startMs) / span);

  const midnights: number[] = [];
  for (let m = startMs + MS_PER_DAY; m < endMs; m += MS_PER_DAY) midnights.push(m);

  const daylines = [0, ...midnights.map(frac), 1];

  const bounds = [startMs, ...midnights, endMs];
  const days: RulerDay[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    const sf = frac(a);
    const ef = frac(b);
    days.push({
      weekday: weekdayName(a),
      date: dateLabel(a),
      startFrac: sf,
      endFrac: ef,
      centerFrac: (sf + ef) / 2,
    });
  }

  return { startMs, endMs, nowMs, maxHours, nowFrac: frac(nowMs), days, daylines };
}

/** Track fraction (0–1) for a forecast offset in hours. */
export function offsetToFrac(m: RulerModel, hours: number): number {
  const span = m.endMs - m.startMs;
  if (span <= 0) return 0;
  const ms = m.nowMs + hours * MS_PER_HOUR;
  return Math.min(1, Math.max(0, (ms - m.startMs) / span));
}

/**
 * Track fraction → offset, snapped to `step`, clamped to [0, maxHours]. A tap
 * left of "now" resolves to 0 — `current_time_0H` is rejected by the host.
 */
export function fracToOffset(m: RulerModel, frac: number, step: number): number {
  const span = m.endMs - m.startMs;
  const ms = m.startMs + Math.min(1, Math.max(0, frac)) * span;
  const rawHours = (ms - m.nowMs) / MS_PER_HOUR;
  const snapped = Math.round(rawHours / step) * step;
  return Math.min(m.maxHours, Math.max(0, snapped));
}

/** Offset one day earlier/later, snapped and clamped — the ‹ / › nav buttons. */
export function pageHours(hours: number, dir: -1 | 1, maxHours: number, step: number): number {
  const next = hours + dir * 24;
  const snapped = Math.round(next / step) * step;
  return Math.min(maxHours, Math.max(0, snapped));
}

/** Wall-clock label for the selected offset — the nowpill text ("17:00"). */
export function clockLabel(nowMs: number, hours: number): string {
  const at = new Date(nowMs + hours * MS_PER_HOUR);
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
