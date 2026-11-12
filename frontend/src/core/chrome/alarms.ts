// Pure/DOM-free so "which alarms are shown" is assertable without a browser.
// The strip is RESERVED CHROME (invariant #1, enforced in registry.ts) — it
// has no band name, so nothing can `defineFeature` its way into it.

import type { Alert } from "./registry";

/** Alerts not yet acknowledged. `alerts(reg)` ignores chrome config entirely —
 * a depth alarm fires whether or not its tile is on the rail (a tile toggles a
 * READOUT, never a guard); only acknowledgement may silence this. */
export const visibleAlerts = (all: readonly Alert[], acked: ReadonlySet<string>): Alert[] =>
  all.filter((a) => !acked.has(a.id));

/**
 * Drop acks whose alarm stopped firing (REARMING). Why ack is a set, not a
 * bool: a boolean would stay set across a sail-out-and-back, silently hiding
 * the second, distinct instance of the same danger.
 */
export function rearm(all: readonly Alert[], acked: ReadonlySet<string>): Set<string> {
  const firing = new Set(all.map((a) => a.id));
  return new Set([...acked].filter((id) => firing.has(id)));
}

/** The shown alerts that may make noise: not silenced at the source (SignalK,
 * by anyone) and not muted on this screen. A MUTE quiets an alarm, it does
 * not hide it — so this filters the SOUND, never `visibleAlerts`. */
export const audibleAlerts = (shown: readonly Alert[], muted: ReadonlySet<string>): Alert[] =>
  shown.filter((a) => !a.silenced && !muted.has(a.id));
