// The shallow-water alarm as the boat's server runs it (`mivnav.shallow`):
// its boat-wide settings (`ShallowConfig`), the per-snapshot assessment
// (`shallow`), and our own SignalK notification's echo (`shallowNotice`).
// Same shape of thing as the collision alarm (`collisionSettings.ts`,
// `signalk.ts`'s `Collision`) — server-side, so every screen, the MFD and
// KIP agree, and it keeps watching with every screen closed.

/** off / show / tell, exactly as the collision alarm (`CpaMode`). */
export type ShallowMode = "off" | "show" | "tell";

export interface ShallowSettings {
  mode: ShallowMode;
  /** mivnav screens sound and vibrate for an unacknowledged alarm (tell only). */
  sound: boolean;
  /** Also raise it as a SignalK notification. */
  publish: boolean;
  /** Alarm under this depth below the surface (m). */
  depth_m: number;
  /** The alarm clears only this far (m) deeper than the threshold. */
  hysteresis_m: number;
}

/** Exactly `ShallowConfig`'s defaults — what a screen uses until a snapshot says. */
export const DEFAULT_SHALLOW_SETTINGS: ShallowSettings = {
  mode: "tell",
  sound: true,
  publish: true,
  depth_m: 3,
  hysteresis_m: 0.5,
};

/** Which sounder path the server compared (`mivnav.shallow.watch.reading`). */
export type DepthSource = "surface" | "transducer" | "keel";

/**
 * The server's shallow-water assessment. Absent (null) = no own ship or no
 * LIVE sounder reading — a stale depth is no depth, and never holds an alarm.
 * `depthM` is median-filtered over a few seconds, in surface terms.
 */
export interface Shallow {
  depthM: number;
  source: DepthSource;
  thresholdM: number;
  /** Debounced on the server: raised after the depth stayed under the
   * threshold, cleared only past the hysteresis. */
  active: boolean;
}

/** Our shallow notification as SignalK holds it — the same reduced echo as a
 * `CollisionNotice` (`mivnav.collision.notices.reduce_echo`). */
export interface ShallowNotice {
  state: string;
  /** Notifications-API id — what a server-side ACK names. */
  id?: string;
  sound: boolean;
  acknowledged?: boolean;
  canAcknowledge?: boolean;
  silenced?: boolean;
  canSilence?: boolean;
}

/** How long a MUTE lasts — the backend's (shared) `publisher.MUTE_S`. */
export const SHALLOW_MUTE_S = 120;

async function shallowAction(action: "ack" | "silence", ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  try {
    const res = await fetch(`/api/signalk/shallow/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Acknowledge on the SignalK SERVER (`POST /signalk/shallow/ack`): every
 * display goes quiet. Resolves `false` on failure, never rejects. */
export const acknowledgeShallow = (ids: string[]): Promise<boolean> => shallowAction("ack", ids);

/** Silence on the SignalK SERVER for `SHALLOW_MUTE_S`; the alarm stays up. */
export const silenceShallow = (ids: string[]): Promise<boolean> => shallowAction("silence", ids);
