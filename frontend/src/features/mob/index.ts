// Man overboard. One button on every screen (./MobControl.tsx, reserved
// chrome in the map pane) and the O key, both behind the same arm-then-
// confirm guard (model.ts `ARM_MS`). Raising stores the mark on the server
// (`/api/mob`), which raises `notifications.mob` on SignalK so the MFD sounds
// too; every screen then shows the mark, bearing / range / time since, and
// can steer to it through SignalK's course. Only an explicit Clear ends it.
//
// Contributes: the `mob.alarm` instrument (rail tile + the alarm strip, ACK
// = acknowledge on SignalK), the chart overlay, and palette/key commands.
// Self-contained on purpose — not a general marks system.

import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import { defineCommand } from "../../core/chrome/command";
import type { Instrument, Urgency } from "../../core/chrome/registry";
import type { GeoPoint } from "../../core/chrome/geo";
import type { MobMark, MobNotice, SignalKState } from "../../core/signalk";
import { createMobClient, type MobClient } from "./client";
import {
  ARM_MS,
  createArmGuard,
  markPoint,
  mobAlertText,
  mobFix,
  mobReading,
  mobSounds,
  mobUp,
  type MobFix,
} from "./model";
import { createMobOverlay, type MobScene } from "./overlay";

/** After a press, this screen's own answer outranks the stream this long —
 * the beat before the server's snapshot carries it. */
const LOCAL_GRACE_MS = 3_000;
/** A raise the server never got is retried this often, until it sticks. */
const RAISE_RETRY_MS = 3_000;
/** With SignalK off there is no stream: the mark is polled instead. */
const POLL_MS = 5_000;

export interface MobDeps {
  signalk: SignalKState;
  /** Injected by tests. */
  client?: MobClient;
  now?: () => number;
}

export interface MobModel {
  /** The mark, as this screen knows it (`null` = no MOB of ours). */
  mark: Accessor<MobMark | null>;
  /** `notifications.mob` on SignalK, ours or anyone's. */
  notice: Accessor<MobNotice | null>;
  /** Boat → mark, when both are known. */
  fix: Accessor<MobFix | null>;
  /** Wall clock, ticking once a second — what time-since reads. */
  now: Accessor<number>;
  /** Armed and waiting for the confirming press. */
  armed: Accessor<boolean>;
  /** The guarded press — the button and the O key. */
  press: () => void;
  disarm: () => void;
  /** Raise now, no guard: the palette entry (a deliberate pick already). */
  raise: () => Promise<void>;
  /** Steer to the mark through SignalK's course. */
  navigate: () => Promise<void>;
  /** End the MOB. The UI asks twice before calling this. */
  clear: () => Promise<void>;
  /** One line of feedback (a failed steer/clear), or null. */
  feedback: Accessor<string | null>;
  /** Raised on this screen but not yet stored on the server. */
  unsent: Accessor<boolean>;
}

export interface MobFeature {
  feature: AppFeature;
  model: MobModel;
}

interface Local {
  mark: MobMark | null;
  at: number;
  /** Not yet on the server — outranks the stream until it is. */
  pending?: boolean;
}

export function createMob(deps: MobDeps): MobFeature {
  const { signalk } = deps;
  const client = deps.client ?? createMobClient();
  const clock = deps.now ?? (() => Date.now());

  const [now, setNow] = createSignal(clock());
  const tick = setInterval(() => setNow(clock()), 1000);
  onCleanup(() => clearInterval(tick));

  const [local, setLocal] = createSignal<Local | null>(null);
  const [polled, setPolled] = createSignal<MobMark | null>(null);
  const [feedback, setFeedback] = createSignal<string | null>(null);

  // SignalK off: no stream carries the mark, so ask for it.
  createEffect(() => {
    if (signalk.status() !== "off") return;
    const poll = () =>
      void client.get().then((m) => {
        if (m !== undefined) setPolled(m);
      });
    poll();
    const id = setInterval(poll, POLL_MS);
    onCleanup(() => clearInterval(id));
  });

  const mark = createMemo<MobMark | null>(
    () => {
      const l = local();
      if (l && (l.pending || now() - l.at < LOCAL_GRACE_MS)) return l.mark;
      return signalk.status() === "off" ? polled() : signalk.mob();
    },
    null,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  const notice = () => signalk.mobNotice();
  const boat = (): GeoPoint | null => {
    const s = signalk.self();
    return s ? { lng: s.lng, lat: s.lat } : null;
  };
  const fix = createMemo(() => mobFix(boat(), mark()));

  // -- raising ----------------------------------------------------------------
  let retry: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(retry));
  const raise = async (): Promise<void> => {
    clearTimeout(retry);
    const at = boat() ?? undefined;
    const stored = await client.raise(at);
    if (stored) {
      setLocal({ mark: stored, at: clock() });
      return;
    }
    // The server did not take it (down, wifi gone). THIS screen alarms and
    // marks anyway — the crew must not wait on a network — and keeps trying.
    const prior = local();
    const mine: MobMark = prior?.pending && prior.mark
      ? prior.mark
      : { id: "unsent", at: new Date(clock()).toISOString(), ...(at ?? {}) };
    setLocal({ mark: mine, at: clock(), pending: true });
    retry = setTimeout(() => void resend(mine), RAISE_RETRY_MS);
  };
  const resend = async (mine: MobMark): Promise<void> => {
    const l = local();
    if (!l?.pending) return; // cleared meanwhile
    const at = mine.lat != null && mine.lng != null ? { lat: mine.lat, lng: mine.lng } : undefined;
    const stored = await client.raise(at);
    if (stored) setLocal({ mark: stored, at: clock() });
    else retry = setTimeout(() => void resend(mine), RAISE_RETRY_MS);
  };

  // -- the guard --------------------------------------------------------------
  const guard = createArmGuard(ARM_MS);
  const [armedUntil, setArmedUntil] = createSignal<number | null>(null);
  const armed = () => {
    const u = armedUntil();
    return u !== null && now() < u;
  };
  let disarmTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(disarmTimer));
  const disarm = () => {
    guard.disarm();
    clearTimeout(disarmTimer);
    setArmedUntil(null);
  };
  const press = () => {
    const t = clock();
    if (guard.press(t) === "fire") {
      disarm();
      void raise();
      return;
    }
    setArmedUntil(t + ARM_MS);
    setNow(t);
    clearTimeout(disarmTimer);
    disarmTimer = setTimeout(disarm, ARM_MS);
  };

  // -- after -------------------------------------------------------------------
  const navigate = async () => {
    setFeedback(null);
    const out = await client.navigate();
    setFeedback(out.ok ? "Steering to MOB" : out.message);
  };
  const clear = async () => {
    setFeedback(null);
    clearTimeout(retry);
    const l = local();
    if (l?.pending) {
      setLocal({ mark: null, at: clock() });
      return; // never reached the server: nothing there to clear
    }
    if (await client.clear()) setLocal({ mark: null, at: clock() });
    else setFeedback("Could not reach the mivnav server — the MOB is still up.");
  };
  const unsent = () => !!local()?.pending;

  const instrument: Instrument = {
    id: "mob.alarm",
    short: "MOB",
    label: "Man overboard",
    band: "rail",
    maxUrgency: "alarm",
    when: () => mobUp(mark(), notice()),
    urgency: (): Urgency => (mobUp(mark(), notice()) ? "alarm" : "none"),
    read: () => mobReading(mark(), boat(), now()),
    alertText: () => mobAlertText(mark(), notice(), boat(), now()),
    // ACK quiets it on SignalK — every display and the MFD. The MOB stays up.
    onAck: () => {
      const n = notice();
      if (n?.id && !n.acknowledged && n.canAcknowledge !== false) void client.ack(n.id);
    },
    alertCritical: true,
    alertSound: () => mobSounds(mark(), notice()),
  };

  const scene = createMemo<MobScene>(() => {
    const m = mark();
    const at = m ? new Date(m.at) : null;
    const label = at && !Number.isNaN(at.getTime())
      ? `${`${at.getHours()}`.padStart(2, "0")}:${`${at.getMinutes()}`.padStart(2, "0")}`
      : "";
    return { mark: markPoint(m), boat: boat(), label };
  });

  const feature = defineFeature({
    id: "mob",
    instruments: [instrument],
    overlay: createMobOverlay(scene),
    commands: () => {
      const active = !!mark();
      return [
        // The key: guarded exactly like the button — O arms, O again raises.
        defineCommand({
          id: "mob-key",
          label: "Man overboard (press O twice)",
          group: "Safety",
          keybinding: { key: "o" },
          palette: false,
          run: (ctx) => {
            press();
            ctx.close();
          },
        }),
        ...(active
          ? [
              defineCommand({
                id: "mob-navigate",
                label: "Steer to MOB",
                group: "Safety",
                hint: "Set SignalK's course to the man-overboard mark",
                keywords: ["mob", "overboard", "navigate", "goto", "course"],
                run: (ctx) => {
                  void navigate();
                  ctx.close();
                },
              }),
              defineCommand({
                id: "mob-clear",
                label: "Clear MOB — person recovered",
                group: "Safety",
                hint: "End the man-overboard alarm on every display",
                keywords: ["mob", "overboard", "cancel", "recovered"],
                run: (ctx) => {
                  void clear();
                  ctx.close();
                },
              }),
            ]
          : [
              defineCommand({
                id: "mob-raise",
                label: "Man overboard — raise MOB",
                group: "Safety",
                hint: "Mark the position now and sound the alarm everywhere",
                keywords: ["mob", "overboard", "man", "person", "pob", "alarm"],
                run: (ctx) => {
                  void raise();
                  ctx.close();
                },
              }),
            ]),
      ];
    },
  });

  return {
    feature,
    model: {
      mark,
      notice,
      fix,
      now,
      armed,
      press,
      disarm,
      raise,
      navigate,
      clear,
      feedback,
      unsent,
    },
  };
}
