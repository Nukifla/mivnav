// The core feature: the instruments the boat always has. A FACTORY over the
// accessors it reads, not a module singleton, so it can't leak between tests.
// Depth and wind (and the shallow alarm) live in features/instruments, now
// that the data exists — see docs/architecture/core-instruments-omissions.md.

import { createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { acknowledgeCollision, COLLISION_MUTE_S, silenceCollision, type SignalKState } from "../signalk";
import { DEFAULT_COLLISION_SETTINGS, type CollisionSettings } from "../collisionSettings";
import { formatCpaNm, formatSpeedKn, formatTcpa, padDeg } from "../format";
import { formatAxis } from "../coordinate";
import { isHelmish, type Reading, type Urgency } from "./registry";
// The APP-LAYER `defineFeature` (not the kernel one in ./registry): returns
// the same `AppFeature` shape every other feature does, so App can list it
// without hand-wrapping (C-CURSOR/CORE).
import { defineFeature, type AppFeature } from "./feature";

const MS_TO_KN = 1.943844;

/** A GPS reports at 1 Hz; 10s of silence is generous enough to survive a
 * coalesced snapshot or wifi hiccup, tight enough that a dead GPS is called
 * dead while it still matters. */
export const FIX_STALE_AFTER_S = 10;

// Density-aware readouts live in `../format.ts`: the rail buys about three
// glyphs at helm, so a widget must shed a character itself or clip — the
// whole reason `read` takes a ctx (invariant #7).

/** Ticks so staleness — the one reading that changes when nothing changes —
 * can be re-rendered; without it a dead sensor's tile shows its last good
 * number forever (invariant #6). 1 Hz: age is rendered in whole seconds. */
export function createClock(intervalMs = 1_000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), intervalMs);
  onCleanup(() => clearInterval(timer));
  return now;
}

export interface CoreDeps {
  signalk: SignalKState;
  /** Injected by tests. Defaults to a 1 Hz `createClock`. */
  now?: Accessor<number>;
  /** The boat's collision settings (`signalk.collisionSettings`) — `ais.cpa`
   * fires the alarm only in `tell`, and sounds it here only with `sound` on.
   * Absent → `DEFAULT_COLLISION_SETTINGS` (show: drawn, silent). */
  collision?: Accessor<CollisionSettings>;
  /** Server-side ACK of the collision alarm. Injected by tests; defaults to
   * `acknowledgeCollision` (POST /api/signalk/collision/ack). */
  ackCollision?: (ids: string[]) => Promise<boolean>;
  /** Server-side MUTE, likewise; defaults to `silenceCollision`. */
  silenceCollision?: (ids: string[]) => Promise<boolean>;
}

/** Seconds since a NEW fix arrived, or null if fresh. Uses the CLIENT'S OWN
 * CLOCK, never the GPS's (no NTP at sea). See
 * docs/architecture/gps-fix-staleness.md for the null-means-"cannot tell" contract. */
export function createFixAge(signalk: SignalKState, now: Accessor<number>): () => number | null {
  const fixAt = createMemo<{ iso: string | undefined; at: number }>(
    (prev) => {
      const iso = signalk.self()?.positionAtIso;
      if (prev && prev.iso === iso) return prev;
      return { iso, at: untrack(now) };
    },
    { iso: undefined, at: 0 },
  );
  return (): number | null => {
    if (fixAt().iso === undefined) return null;
    const age = (now() - fixAt().at) / 1000;
    return age > FIX_STALE_AFTER_S ? age : null;
  };
}

/** Honest GPS state for the rail's status dot (mockup ~line 766): a GPS fix
 * and the SignalK link fail independently, so this is its own signal, never
 * "cannot tell" rendered as good. See docs/architecture/gps-fix-staleness.md. */
export type GpsFix = "unknown" | "acquiring" | "stale" | "fix";

export function createGpsStatus(deps: CoreDeps): Accessor<GpsFix> {
  const { signalk } = deps;
  const now = deps.now ?? createClock();
  const fixAge = createFixAge(signalk, now);
  return (): GpsFix => {
    if (signalk.status() !== "connected") return "unknown";
    const self = signalk.self();
    if (!self) return "acquiring";
    if (self.positionAtIso === undefined) return "unknown";
    return fixAge() !== null ? "stale" : "fix";
  };
}

export function createCoreFeature(deps: CoreDeps): AppFeature {
  const { signalk } = deps;
  const now = deps.now ?? createClock();
  const collision = deps.collision ?? ((): CollisionSettings => DEFAULT_COLLISION_SETTINGS);
  const fixAge = createFixAge(signalk, now);

  // The SERVER's assessment (`mivnav.collision`): computed once on the boat,
  // published to SignalK, the same on every screen. Thresholds are boat-wide
  // config, not this device's. See docs/architecture/cpa-backend.md.
  const threat = () => signalk.collision()?.threat ?? null;
  const ackCollision = deps.ackCollision ?? acknowledgeCollision;
  const muteCollision = deps.silenceCollision ?? silenceCollision;
  // SignalK's copy of the alarm (our own notifications, echoed back): what
  // makes an ACK on ANY display — the MFD, KIP, another screen — quiet this
  // one too, and what tells this one to sound. Absent when nothing reached
  // SignalK (publish off, no write access): then the alarm is ours alone.
  const notices = () => Object.values(signalk.collisionNotices() ?? {});
  const threatNotice = () => {
    const t = threat();
    return t ? signalk.collisionNotices()[t.id] : undefined;
  };

  const NO_DATA: Reading = { value: "—", state: "null" };

  return defineFeature({
    id: "core",
    instruments: [
      {
        id: "nav.sog",
        short: "SOG",
        label: "Speed over ground",
        band: "rail",
        bands: ["rail", "top"],
        // maxUrgency is the ceiling `urgencyOf` clamps to; "boat is moving" is
        // never alarm-worthy.
        maxUrgency: "none",
        staleAge: fixAge,
        read: (ctx) => {
          const sog = signalk.self()?.sogMs;
          if (sog === undefined) return NO_DATA;
          const cog = signalk.self()?.cogDeg;
          return {
            value: formatSpeedKn(sog * MS_TO_KN, ctx),
            unit: "kn",
            sub: cog === undefined ? undefined : `COG ${padDeg(cog)}°`,
          };
        },
      },
      {
        id: "nav.cog",
        short: "COG",
        label: "Course over ground",
        band: "rail",
        bands: ["rail", "top"],
        maxUrgency: "none",
        staleAge: fixAge,
        read: (ctx) => {
          const cog = signalk.self()?.cogDeg;
          if (cog === undefined) return NO_DATA;
          const hdg = signalk.self()?.headingDeg;
          return {
            value: padDeg(cog),
            unit: "°T",
            // Heading is first to go at helm: HDG/COG differing by two
            // degrees is a desk curiosity, not a helm decision.
            sub: hdg === undefined || isHelmish(ctx.density) ? undefined : `HDG ${padDeg(hdg)}°`,
          };
        },
      },
      {
        // BOARD-ONLY (`needsRoom: "board"` below): the rail has no room for a
        // position that isn't scenery. See docs/architecture/core-instruments-omissions.md §2.
        id: "nav.pos",
        short: "POS",
        label: "Position",
        band: "rail",
        needsRoom: "board",
        maxUrgency: "none",
        staleAge: fixAge,
        read: () => {
          const self = signalk.self();
          if (!self) return NO_DATA;
          return {
            value: formatAxis(self.lat, "lat", 3),
            sub: formatAxis(self.lng, "lon", 3),
          };
        },
      },
      {
        // The only alarm-grade instrument this build has. See
        // docs/architecture/cpa-risk-ranking.md for the urgency clamp and why
        // `staleAge` covers the OWN-SHIP half too (safety-critical, not obvious).
        id: "ais.cpa",
        short: "CPA",
        label: "Closest point of approach",
        band: "rail",
        maxUrgency: "alarm",
        staleAge: fixAge,
        urgency: (): Urgency => {
          const t = threat();
          if (!t) return "none";
          const risk = t.risk;
          // Acknowledged on the server (by anyone): seen, stays elevated, quiet.
          // An escalation clears `acknowledged` server-side and re-arms it.
          if (risk === "red" && threatNotice()?.acknowledged) return "notice";
          if (risk === "red") return collision().mode === "tell" ? "alarm" : "notice";
          return risk === "yellow" ? "notice" : "none";
        },
        read: (ctx) => {
          const t = threat();
          if (!t) return NO_DATA;
          const { cpaNm, tcpaMin, aspect } = t;
          return {
            value: formatCpaNm(cpaNm, ctx),
            unit: "nm",
            // Aspect is dropped at helm/unknown: "4:12 ahead" is too wide.
            sub:
              isHelmish(ctx.density) || aspect === "unknown"
                ? formatTcpa(tcpaMin)
                : `${formatTcpa(tcpaMin)} ${aspect}`,
          };
        },
        // The strip's ACK acknowledges on SignalK, every alarming target the
        // user could see — one tap is "I have seen the collision risk", and a
        // second red on the MFD should not keep sounding after it. The local
        // ack still hides the strip here at once.
        onAck: () => {
          const ids = notices()
            .filter((n) => n.id && !n.acknowledged && n.canAcknowledge !== false)
            .map((n) => n.id!);
          void ackCollision(ids);
        },
        // MUTE: silenced on SignalK for every display, re-armed by the server
        // after two minutes (publisher.MUTE_S) — same every-target scope as ACK.
        onMute: () => {
          const ids = notices()
            .filter((n) => n.id && !n.acknowledged && !n.silenced && n.canSilence !== false)
            .map((n) => n.id!);
          void muteCollision(ids);
        },
        muteS: COLLISION_MUTE_S,
        alertSilenced: () => !!threatNotice()?.silenced,
        // The boat's `sound` decides, for every mivnav screen alike — whether
        // or not the alarm reached SignalK (whose own notification sounds on
        // the MFD/KIP regardless). An ACK from any display quiets it.
        alertCritical: true,
        alertSound: () => {
          const c = collision();
          if (c.mode !== "tell" || !c.sound || threat()?.risk !== "red") return false;
          const n = threatNotice();
          return !n?.acknowledged && !n?.silenced;
        },
        alertText: () => {
          const t = threat();
          if (!t) return ["⚠ COLLISION RISK", ""] as const;
          const who = t.name ?? "unnamed target";
          const aspect = t.aspect === "unknown" ? "" : ` · crossing ${t.aspect}`;
          return [
            `⚠ COLLISION RISK — ${who}`,
            `CPA ${t.cpaNm.toFixed(2)} nm · TCPA ${formatTcpa(t.tcpaMin)}${aspect}`,
          ] as const;
        },
      },
    ],
    // The board's "Nav" tab (mockup ~line 803). Depth & wind are their own
    // tab, from features/instruments.
    dashboard: [{ id: "nav", label: "Nav", instruments: ["nav.sog", "nav.cog", "nav.pos", "ais.cpa"] }],
  });
}
