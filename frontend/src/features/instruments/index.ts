// Depth & wind: the boat's own sensors as instruments, and the shallow-water
// alarm's face. The data was already on the wire (`Vessel.depth*`, `aws/awa/
// tws/twa`); the alarm is the SERVER's (`mivnav.shallow`), so a screen, the
// MFD and KIP agree and it keeps watching with every screen closed.
//
// This revisits docs/architecture/core-instruments-omissions.md §1 ("no
// data — do not ship a fake"): the data now exists, and the honest-absence
// rule still holds — every tile here is `when`-gated on its sensor having
// ever reported, so a boat with no sounder shows no DPT tile, never a "—"
// that looks like a guard. The doc's other point (compare against
// `safetyContour`) is NOT followed: that is a per-device chart setting,
// while the alarm is boat-wide on the server, so its threshold is the boat's
// draft + margin (or a set depth) — Settings → Alarms.

import { defineFeature, type AppFeature } from "../../core/chrome/feature";
import type { Instrument, Reading } from "../../core/chrome/registry";
import { defineWidget } from "../../core/chrome/widget";
import { padDeg, formatSpeedKn } from "../../core/format";
import type { SignalKState } from "../../core/signalk";
import { acknowledgeShallow, SHALLOW_MUTE_S, silenceShallow } from "../../core/shallow";
import {
  formatDepth,
  formatWindAngle,
  MS_TO_KN,
  primaryDepth,
  shallowAlertText,
  shallowUrgency,
  staleOf,
} from "./model";
import { windRoseCell } from "./rose";
import { SHALLOW_SECTION, SHALLOW_SETTINGS } from "./settings";

export interface InstrumentsDeps {
  signalk: SignalKState;
  /** Server-side ACK/MUTE of the shallow alarm. Injected by tests. */
  ackShallow?: (ids: string[]) => Promise<boolean>;
  silenceShallow?: (ids: string[]) => Promise<boolean>;
}

const NO_DATA: Reading = { value: "—", state: "null" };

export function createInstruments(deps: InstrumentsDeps): AppFeature {
  const { signalk } = deps;
  const ack = deps.ackShallow ?? acknowledgeShallow;
  const mute = deps.silenceShallow ?? silenceShallow;
  const self = () => signalk.self();
  const notice = () => signalk.shallowNotice();

  const depth: Instrument = {
    id: "env.depth",
    short: "DPT",
    label: "Depth",
    band: "rail",
    // Alarm-grade: the rail is the unconditional band, as invariant #3 needs.
    maxUrgency: "alarm",
    when: () => primaryDepth(self()) !== null,
    staleAge: () => primaryDepth(self())?.staleAge ?? null,
    urgency: () => shallowUrgency(signalk.shallow(), signalk.shallowSettings(), !!notice()?.acknowledged),
    read: (ctx) => {
      const d = primaryDepth(self());
      if (!d) return NO_DATA;
      if (ctx.room !== "board") return { value: formatDepth(d.metres), unit: "m", sub: d.short };
      // The board says which depth it is in words, the keel clearance when
      // that is not already the lead, and what the alarm is set to.
      const parts = [d.words];
      const keel = self()?.depthBelowKeelM;
      if (d.field !== "depthBelowKeelM" && keel !== undefined) parts.push(`keel ${formatDepth(keel)}`);
      const sh = signalk.shallow();
      if (sh && signalk.shallowSettings().mode !== "off") parts.push(`alarm <${formatDepth(sh.thresholdM)}`);
      return { value: formatDepth(d.metres), unit: "m", sub: parts.join(" · ") };
    },
    alertText: () => shallowAlertText(signalk.shallow()),
    onAck: () => {
      const n = notice();
      if (n?.id && !n.acknowledged && n.canAcknowledge !== false) void ack([n.id]);
    },
    onMute: () => {
      const n = notice();
      if (n?.id && !n.acknowledged && !n.silenced && n.canSilence !== false) void mute([n.id]);
    },
    muteS: SHALLOW_MUTE_S,
    alertSilenced: () => !!notice()?.silenced,
    alertSound: () => {
      const s = signalk.shallowSettings();
      if (s.mode !== "tell" || !s.sound || !signalk.shallow()?.active) return false;
      const n = notice();
      return !n?.acknowledged && !n?.silenced;
    },
  };

  const apparent: Instrument = {
    id: "wind.app",
    short: "AW",
    label: "Apparent wind",
    band: "rail",
    maxUrgency: "none",
    when: () => self()?.awsMs !== undefined || self()?.awaDeg !== undefined,
    staleAge: () => staleOf(self(), ["awsMs", "awaDeg"]),
    read: (ctx) => {
      const s = self();
      if (s?.awsMs === undefined) return NO_DATA;
      return {
        value: formatSpeedKn(s.awsMs * MS_TO_KN, ctx),
        unit: "kn",
        sub: s.awaDeg === undefined ? undefined : `AWA ${formatWindAngle(s.awaDeg)}`,
      };
    },
  };

  const trueWind: Instrument = {
    id: "wind.true",
    short: "TW",
    label: "True wind",
    band: "rail",
    maxUrgency: "none",
    when: () => self()?.twsMs !== undefined || self()?.twaDeg !== undefined,
    // Its own stamps: the true pair is often plugin-derived and dies on its
    // own while the vane keeps reporting (signalk-model.md, "Wind quartet").
    staleAge: () => staleOf(self(), ["twsMs", "twaDeg"]),
    read: (ctx) => {
      const s = self();
      if (s?.twsMs === undefined) return NO_DATA;
      const twa = s.twaDeg;
      let sub = twa === undefined ? undefined : `TWA ${formatWindAngle(twa)}`;
      // TWD = heading + TWA; only where there is room for it.
      if (twa !== undefined && s.headingDeg !== undefined && ctx.room === "board")
        sub = `${sub} · TWD ${padDeg((s.headingDeg + twa + 360) % 360)}°`;
      return { value: formatSpeedKn(s.twsMs * MS_TO_KN, ctx), unit: "kn", sub };
    },
  };

  // The graphic: a static widget with its own cell (the autopilot's pattern),
  // board-only by construction — it is never a registry instrument, so it
  // cannot land on the rail strip.
  const rose = defineWidget({
    id: "wind.rose",
    kind: "static",
    label: "Wind rose",
    maxUrgency: "none",
    spec: [],
    deletable: false,
    build: (id) => ({ id, short: "WIND", label: "Wind", maxUrgency: "none", read: () => ({ value: "" }) }),
    render: windRoseCell(signalk),
  });

  return defineFeature({
    id: "instruments",
    instruments: [depth, apparent, trueWind],
    widgets: [rose],
    dashboard: [
      { id: "env", label: "Depth & wind", instruments: ["env.depth", "wind.rose", "wind.app", "wind.true"] },
    ],
    settings: { settings: SHALLOW_SETTINGS, sections: [SHALLOW_SECTION] },
  });
}
