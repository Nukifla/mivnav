// The GNSS-lost and connection alarms, on this screen. Three losses, each
// raised only after `gnssSettings.delay_s` (default 5 s) of CONTINUOUS loss,
// so a brief dropout never alarms:
//
// - GNSS lost: decided on the SERVER (`mivnav.gnss`) — it also raises it on
//   SignalK, so it works with every screen closed. Shown here from the
//   snapshot's `fixLost`, already debounced there.
// - SignalK lost: the server's link to the boat's SignalK box, as the server
//   reports it (`status`). Nothing can raise it ON SignalK, so screens only.
// - Server unreachable: this screen's link to the mivnav server
//   (`linkDownSince`: socket closed or a liveness ping unanswered). Only a
//   browser can see it, and with the server gone nothing reaches SignalK —
//   this alarm is this screen's alone.
//
// Only the outermost loss alarms: with the server gone, SignalK's and the
// fix's state are unknown, not lost; with SignalK gone, so is the fix.
// None has a `staleAge`: the kernel forces a stale instrument quiet
// (invariant #6), and these ARE the staleness alarms.

import { createMemo, untrack, type Accessor } from "solid-js";
import { createClock } from "./chrome/core";
import { defineFeature, type AppFeature } from "./chrome/feature";
import type { Instrument, Urgency } from "./chrome/registry";
import type { SignalKState, SignalKStatus } from "./signalk";
import type { GnssSettings } from "./gnssSettings";

export type LinkLoss = "server" | "signalk" | "gnss";

export interface LinkInputs {
  now: number;
  /** `SignalKState.linkDownSince`. */
  serverDownSince: number | null;
  status: SignalKStatus;
  /** Since when (ms) the server has reported SignalK not connected while
   * this screen heard it; null while connected/off. */
  signalkDownSince: number | null;
  fixLost: boolean;
  settings: GnssSettings;
}

/** The ONE loss to alarm on right now, or null. Pure. */
export function activeLoss(i: LinkInputs): LinkLoss | null {
  if (i.settings.mode === "off") return null;
  const delayMs = i.settings.delay_s * 1000;
  if (i.serverDownSince !== null) {
    return i.settings.connection && i.now - i.serverDownSince >= delayMs ? "server" : null;
  }
  if (i.status === "off") return null;
  if (i.status !== "connected") {
    const since = i.signalkDownSince;
    return i.settings.connection && since !== null && i.now - since >= delayMs ? "signalk" : null;
  }
  return i.fixLost ? "gnss" : null;
}

const TEXT: Record<LinkLoss, { short: string; label: string; title: string; detail: (s: number) => string }> = {
  gnss: {
    short: "GPS",
    label: "GNSS position",
    title: "⚠ GNSS POSITION LOST",
    detail: (s) => `No position from the GPS for ${s} s — the boat on the chart is last-known.`,
  },
  signalk: {
    short: "SK",
    label: "SignalK link",
    title: "⚠ SIGNALK UNREACHABLE",
    detail: (s) => `The server has heard nothing from SignalK for ${s} s — no position, AIS or alarms from the boat.`,
  },
  server: {
    short: "SRV",
    label: "mivnav server link",
    title: "⚠ MIVNAV SERVER UNREACHABLE",
    detail: (s) =>
      `No contact with the mivnav server for ${s} s — every reading here is last-known. Raised on this screen only; it cannot reach SignalK.`,
  },
};

export interface LinkAlarmDeps {
  signalk: SignalKState;
  /** Injected by tests. Defaults to a 1 Hz `createClock`. */
  now?: Accessor<number>;
}

export function createLinkAlarmsFeature(deps: LinkAlarmDeps): AppFeature {
  const { signalk } = deps;
  const now = deps.now ?? createClock();

  // SignalK down, counted only while this screen hears the server — the
  // stream reports "connecting" for both a lost box and a lost server.
  // A memo, not an effect: it keeps its own previous value, so the moment
  // the loss began survives every re-read.
  const skDownSince = createMemo<number | null>((prev) => {
    const status = signalk.status();
    if (signalk.linkDownSince() !== null || status === "connected" || status === "off") return null;
    return prev ?? untrack(now);
  }, null);

  const loss = (): LinkLoss | null =>
    activeLoss({
      now: now(),
      serverDownSince: signalk.linkDownSince(),
      status: signalk.status(),
      signalkDownSince: skDownSince(),
      fixLost: signalk.fixLost(),
      settings: signalk.gnssSettings(),
    });

  /** Whole seconds the loss has lasted. The fix's comes from the server
   * (`fixAge`, ≥ 10 s), floored at the delay that raised it. */
  const seconds = (kind: LinkLoss): number => {
    const delay = signalk.gnssSettings().delay_s;
    const since = kind === "server" ? signalk.linkDownSince() : kind === "signalk" ? skDownSince() : null;
    if (since === null) return Math.round(Math.max(delay, signalk.fixAge() ?? 0));
    return Math.max(Math.round(delay), Math.round((now() - since) / 1000));
  };

  const instrument = (kind: LinkLoss): Instrument => {
    const t = TEXT[kind];
    return {
      id: `link.${kind}`,
      short: t.short,
      label: t.label,
      band: "rail",
      maxUrgency: "alarm",
      // A tile only while lost — the rail does not carry three "OK"s.
      when: () => loss() === kind,
      urgency: (): Urgency => {
        if (loss() !== kind) return "none";
        return signalk.gnssSettings().mode === "tell" ? "alarm" : "notice";
      },
      read: () => ({ value: "LOST", sub: `${seconds(kind)} s` }),
      alertText: () => [t.title, t.detail(seconds(kind))] as const,
      alertSound: () => {
        const s = signalk.gnssSettings();
        return s.mode === "tell" && s.sound && loss() === kind;
      },
    };
  };

  return defineFeature({
    id: "link-alarms",
    instruments: [instrument("gnss"), instrument("signalk"), instrument("server")],
  });
}
