// The GNSS-lost and connection alarms' settings, as the boat's server runs
// them (`mivnav.gnss.config.GnssConfig`). Boat-wide like the collision
// alarm's: every snapshot carries them (`gnssSettings`), so every screen
// raises the same alarms after the same delay. Edited under Server settings
// → GNSS & connection alarm (`settings/gnss.tsx`).

import type { CpaMode } from "./collisionSettings";

/** off / show / tell — the collision alarm's vocabulary. */
export type AlarmMode = CpaMode;

export interface GnssSettings {
  /** For the GNSS-lost alarm, and the connection alarms when `connection`. */
  mode: AlarmMode;
  /** mivnav screens sound and vibrate for an unacknowledged alarm (`tell`). */
  sound: boolean;
  /** Also raise GNSS-lost as a SignalK notification. */
  publish: boolean;
  /** Alarm on screens when this screen loses the mivnav server, or the
   * server loses SignalK. */
  connection: boolean;
  /** Seconds of continuous loss before any of these alarms. */
  delay_s: number;
}

/** Exactly `GnssConfig`'s defaults — used until the first snapshot, and
 * kept (the last one heard) while the server is unreachable. */
export const DEFAULT_GNSS_SETTINGS: GnssSettings = {
  mode: "tell",
  sound: true,
  publish: true,
  connection: true,
  delay_s: 5,
};
