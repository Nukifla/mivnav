// The track's live tail: own-ship positions from the SignalK stream, drawn on
// the end of the recent line between polls, so the track follows the boat
// instead of trailing it by a poll period plus the history plugin's lag. Pure:
// no signals, no clock — `index.ts` feeds it. See docs/architecture/track-client.md.

import type { Track, TrackCoordinate } from "./client";

/** One live position. `t` is the BROWSER clock (ms) at which it arrived — only
 * ever compared with other browser-clock times, never a GPS or server one. */
export interface LivePoint {
  t: number;
  c: TrackCoordinate;
}

/** The backend's `MAX_SPEED_MS` and `GLITCH_MIN_M` (geometry.py): a hop
 * faster than any sailing boat, beyond metre jitter, is a bad fix. */
const MAX_SPEED_MS = (30 * 1852) / 3600;
const GLITCH_MIN_M = 50;

/** The backend's `GAP_M`: a join this short is drawn whatever the time. */
const JOIN_M = 100;

/** Bounds the tail if the poll stops trimming it (backend down): two hours
 * of 1 Hz under way. Oldest dropped first. */
export const MAX_LIVE = 7200;

const EARTH_M = 6_371_008.8;

/** Equirectangular, like the backend's `distance_m`. */
export function distanceM(a: TrackCoordinate, b: TrackCoordinate): number {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * EARTH_M;
}

/** `tail` with `p` on the end — or `tail` itself (same array) when `p` is
 * the same fix again or a glitch. */
export function appendLive(tail: readonly LivePoint[], p: LivePoint): readonly LivePoint[] {
  const prev = tail[tail.length - 1];
  if (prev) {
    const d = distanceM(prev.c, p.c);
    // Every new fix, however close: the line ends where the boat is, and a
    // boat at rest drawing over itself is fine (user: "i do not care about
    // lots of lines in the same spot"). Only a repeat of the same fix is skipped.
    if (d === 0) return tail;
    if (d > GLITCH_MIN_M && d > MAX_SPEED_MS * Math.max((p.t - prev.t) / 1000, 1)) return tail;
  }
  const next = [...tail, p];
  return next.length > MAX_LIVE ? next.slice(next.length - MAX_LIVE) : next;
}

/** Browser-clock time up to which the history in `track` reaches, given that
 * it arrived at `receivedMs`: the server says how far its newest fix (`last`)
 * trails its own now (`to`), and that lag is all that crosses clocks. `null`
 * when the answer holds no fix to measure from. */
export function coveredUntil(track: Pick<Track, "to" | "last">, receivedMs: number): number | null {
  if (!track.to || !track.last) return null;
  const lag = Date.parse(track.to) - Date.parse(track.last);
  return Number.isFinite(lag) ? receivedMs - Math.max(0, lag) : null;
}

/** Only the points newer than what the history already holds. */
export function trimLive(tail: readonly LivePoint[], fromMs: number | null): readonly LivePoint[] {
  if (fromMs === null) return tail;
  const k = tail.findIndex((p) => p.t > fromMs);
  return k === 0 ? tail : k < 0 ? [] : tail.slice(k);
}

/** `recent` with the tail drawn on: continuing the newest line when the hop
 * from its last fix is one the boat could have made in the time between, as
 * a line of its own otherwise (the same rule the backend breaks lines by). */
export function withLiveTail(
  recent: readonly (readonly TrackCoordinate[])[],
  tail: readonly LivePoint[],
  coveredUntilMs: number | null,
): TrackCoordinate[][] {
  const lines = recent.map((line) => [...line]);
  if (tail.length === 0) return lines;
  const live = tail.map((p) => p.c);
  const last = lines[lines.length - 1];
  const end = last?.[last.length - 1];
  if (end && coveredUntilMs !== null) {
    const d = distanceM(end, live[0]!);
    const dt = Math.max((tail[0]!.t - coveredUntilMs) / 1000, 1);
    if (d <= JOIN_M || d <= MAX_SPEED_MS * dt) {
      last!.push(...live);
      return lines;
    }
  }
  lines.push(live);
  return lines;
}
