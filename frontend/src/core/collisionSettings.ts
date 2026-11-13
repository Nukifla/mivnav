// The collision settings the boat's server runs its alarm with
// (`mivnav.collision.config.CollisionConfig`). Boat-wide, not per device:
// the server sends them in every SignalK snapshot (`collisionSettings`), so
// every screen colours targets, draws the CPA line and sounds with the same
// numbers — and sees an edit made on another screen at once. Edited under
// Settings → Alarms (`settings/collision.tsx`).

import { createEffect, createSignal, on } from "solid-js";
import type { RiskThresholds } from "./cpa";

/** How loud the collision alarm is, for the whole boat: `off` draws no CPA
 * line and raises nothing; `show` draws the line and raises a silent
 * notification; `tell` raises the sounding alarm. Risk *colour* is the
 * separate per-device `showAisRisk`. */
export type CpaMode = "off" | "show" | "tell";

export interface CollisionSettings {
  /** off / show / tell — see `CpaMode`. */
  mode: CpaMode;
  /** mivnav screens sound and vibrate for an unacknowledged alarm (`tell`
   * only), whether or not it reached SignalK. */
  sound: boolean;
  /** Also raise it as a SignalK notification. */
  publish: boolean;
  /** Red (alarm): closer than this, nm … */
  danger_nm: number;
  /** … within this many minutes. */
  horizon_min: number;
  /** Yellow (warning): closer than this, nm … */
  warning_nm: number;
  /** … within this many minutes. */
  warning_horizon_min: number;
  /** At/below this SOG (kn) a vessel is at rest: its COG is GPS noise. */
  at_rest_kn: number;
}

/** Exactly `CollisionConfig`'s defaults — what a screen uses until the first
 * snapshot says otherwise (and in tests). */
export const DEFAULT_COLLISION_SETTINGS: CollisionSettings = {
  mode: "show",
  sound: true,
  publish: false,
  danger_nm: 0.8,
  horizon_min: 15,
  warning_nm: 1,
  warning_horizon_min: 30,
  at_rest_kn: 0.2,
};

/** The boat's two tiers as the engine's four numbers — the same ones the
 * server alarms with, so red on the chart means "the alarm fires". */
export function riskThresholds(c: CollisionSettings): RiskThresholds {
  return {
    redCpaNm: c.danger_nm,
    redTcpaMin: c.horizon_min,
    yellowCpaNm: c.warning_nm,
    yellowTcpaMin: c.warning_horizon_min,
  };
}

/** The boat's off/show/tell, read live and set for the whole boat (a PATCH of
 * the server config) — what the rail's segment and the palette commands
 * drive. The new mode shows at once on this screen; the next snapshot
 * confirms it (and is how every other screen hears of it). A failed write
 * drops the pending pick, so the control never shows what the boat lacks. */
export function createCpaModeControl(
  current: () => CpaMode,
  patch: (mode: CpaMode) => Promise<unknown>,
): { mode: () => CpaMode; setMode: (mode: CpaMode) => void } {
  const [pending, setPending] = createSignal<CpaMode | null>(null);
  // Whatever the boat says next wins — including another screen's edit.
  createEffect(on(current, () => setPending(null), { defer: true }));
  return {
    mode: () => pending() ?? current(),
    setMode: (mode) => {
      setPending(mode);
      patch(mode).catch(() => setPending(null));
    },
  };
}
