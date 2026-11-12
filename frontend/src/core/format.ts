// The one home for number→string formatting — a plotter that shows the same
// range two ways on two surfaces is worse than one that shows nothing.
// Geometry (haversine/bearing) stays in `chrome/geo.ts`.

import { isHelmish, type ReadCtx } from "./chrome/registry";

const METRES_PER_NM = 1852;

/** Range in mariner units: nm to 2dp, or metres under 1 nm rounded to the
 * nearest 10 — a GPS-derived range printed to the metre implies a precision
 * neither AIS nor the chart plotter has. */
export function formatRange(nm: number): { value: string; unit: string } {
  return nm >= 1
    ? { value: nm.toFixed(2), unit: "nm" }
    : { value: `${Math.round((nm * METRES_PER_NM) / 10) * 10}`, unit: "m" };
}

/** `formatRange` as one string — `"2.50 nm"`, `"930 m"` — for callers that
 * don't need the value and unit split (a slider label, a settings row). */
export function formatRangeStr(nm: number): string {
  const r = formatRange(nm);
  return `${r.value} ${r.unit}`;
}

/** Three digits, as a bearing is always written and read. */
export const padDeg = (deg: number): string => `${Math.round(deg) % 360}`.padStart(3, "0");

/**
 * Time-to-go, humanised. `"– –"` when it is not a number: at rest the division
 * is by zero and the answer is not 999 h, it is that there isn't one.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "– –";
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${`${m}`.padStart(2, "0")}`;
}

/** Only for a LOCAL receive age (both ends `Date.now()`) — never a boat/GPS
 * timestamp (`positionAtIso`): no NTP at sea, so clock skew makes it wrong.
 * See `chrome/core.ts`'s `createFixAge`. */
export function formatAgo(ageSeconds: number): string {
  const s = Math.max(0, Math.floor(ageSeconds));
  if (s < 60) return `${s} s ago`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h} h ago` : `${h} h ${rem} min ago`;
}

/** Wall-clock ETA, pairs with `formatDuration` ("how long" vs "at what
 * time"). `nowMs` is injectable so it's unit-testable without mocking the
 * clock. */
export function formatClock(seconds: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "– –:– –";
  const d = new Date(nowMs + seconds * 1000);
  return `${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;
}

/**
 * Speed, sheds the tenth above 10 kn at `helm` density (fits 2 glyphs where
 * 3 don't). Checked on the ROUNDED text, not the raw value — 9.99 kn rounds
 * to "10.0", which is exactly the four-glyph overflow this guards against.
 */
export const formatSpeedKn = (kn: number, ctx: ReadCtx): string => {
  const tenth = kn.toFixed(1);
  return isHelmish(ctx.density) && Number.parseFloat(tenth) >= 10 ? kn.toFixed(0) : tenth;
};

/**
 * CPA distance, sheds the hundredth at `helm` (18 m — inside the AIS position
 * noise `cpa.ts` documents) and the decimal above 10 nm entirely (a CPA that
 * large is green by definition and not read precisely). Threshold checked on
 * ROUNDED text, same reason as `formatSpeedKn`.
 */
export const formatCpaNm = (nm: number, ctx: ReadCtx): string => {
  const rounded = nm.toFixed(isHelmish(ctx.density) ? 1 : 2);
  return Number.parseFloat(rounded) >= 10 ? nm.toFixed(0) : rounded;
};

/** Minutes to a `M:SS`. Negative TCPA is receding and is never shown — see `mivnav.collision.assess`. */
export const formatTcpa = (min: number): string => {
  if (min < 0) return "past";
  if (min >= 60) return `${Math.floor(min / 60)}h${String(Math.floor(min % 60)).padStart(2, "0")}`;
  return `${Math.floor(min)}:${String(Math.round((min % 1) * 60) % 60).padStart(2, "0")}`;
};

/** A boat's name with the skipper's nickname for it: "SEABIRD (bird)". The AIS
 * name leads because it is what is on the radio. */
export function withNickname(name: string | undefined, nickname: string | undefined): string | undefined {
  if (name && nickname) return `${name} (${nickname})`;
  return name ?? nickname;
}
