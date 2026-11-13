// The chrome registry: what a feature may contribute, and the rules the
// kernel enforces rather than trusting an author to remember. Pure and
// DOM-free — the kernel never learns what a knot or a metre is, only how
// urgent something claims to be, and how urgent it is ALLOWED to be.
// See docs/architecture/chrome-registry.md.

import { BANDS, type BandId, type Room } from "./bands";
// Type-only import: erases at runtime, breaking the cycle with ./modes.ts
// (which needs `Registry`/`Mode` from here) — same trick as ./bands.ts.
import type { ModeClick, ModePillCtx, ModePillView } from "./modes";

export type Urgency = "none" | "notice" | "alarm";

/**
 * Continuous UI scale, `0..1`. `0` is the old "desk" baseline; `1` is bigger
 * than the old "helm" size, which now sits at the midpoint `0.5`
 * (`DEFAULT_DENSITY`). Still the SETTING invariant #10 talks about — only its
 * shape changed. Pointer capability lives separately in `ChromeConfig.pointerCoarse`.
 */
export type Density = number;

/** The old "desk" endpoint — smallest/most-precise. */
export const DESK: Density = 0;
/** The top of the slider's range — bigger than the old "helm" size, which now
 * sits at `DEFAULT_DENSITY`, the midpoint. */
export const HELM: Density = 1;
/** The old "helm" pixel size, and the new DEFAULT (`config.ts` `DEFAULT_CHROME`)
 * — the midpoint of the `[DESK, HELM]` range, per `lerpDensity`'s doc. */
export const DEFAULT_DENSITY: Density = 0.5;

/** Answers the once-binary formatting/room decisions (a dropped decimal, a
 * dropped sub-line) that have no continuous equivalent — see `core/format.ts`,
 * `chrome/core.ts`, `features/route`, `features/measure`. */
export const isHelmish = (density: Density): boolean => density >= DEFAULT_DENSITY;

/** Clamp a slider read (or a stored value) into the valid `[DESK, HELM]` range. */
export const clampDensity = (n: number): Density =>
  Number.isFinite(n) ? Math.min(HELM, Math.max(DESK, n)) : HELM;

/**
 * Interpolate a size table's two old `{desk, helm}` endpoints at the current
 * scale. `density * 2` reparametrizes the old `[0,1]` lerp onto the new
 * `[0, DEFAULT_DENSITY]` half of the extended range.
 */
export const lerpDensity = (desk: number, helm: number, density: Density): number =>
  desk + (helm - desk) * (density * 2);

const RANK: Record<Urgency, number> = { none: 0, notice: 1, alarm: 2 };

/**
 * RESERVED CHROME: the one thing the chart may never lose. Not in the band
 * graph at all, which makes invariant #1 enforceable by construction: no
 * widget CAN cover the alarm band, because it is not a band a feature can
 * seat a widget on. See docs/architecture/chrome-registry.md.
 */
export const RESERVED = Object.freeze(["alarm-band"] as const);

const isReserved = (id: string): boolean => (RESERVED as readonly string[]).includes(id);

/**
 * The space a widget is being rendered into. `density` is a SETTING
 * (invariant #10, not a breakpoint), `band` is WHERE, `room` is HOW MUCH —
 * the widget decides what to drop for it (invariant #7).
 */
export interface ReadCtx {
  density: Density;
  band: BandId;
  room: Room;
}

/** What a widget renders to. Data, never markup — the shell is the sole renderer. */
export interface Reading {
  value: string;
  unit?: string;
  sub?: string;
  /** `null` = no data to show (a cursor readout with nothing hovered), not an error. */
  state?: "ok" | "null";
}

/** An instrument as the kernel sees it, plus whatever the shell needs to draw it. */
export interface Instrument {
  id: string;
  /** The cell label. Must be unique among the cells on screen TOGETHER — see bands.collisions. */
  short: string;
  label: string;
  /** Its default home; where `adoptDefaults` seats it the first time. Defaults to `rail`. */
  band?: BandId;
  /** Every band it is ALLOWED in. Defaults to `[band]`. The config picks from these. */
  bands?: readonly BandId[];
  /**
   * The ceiling this instrument's feature was GRANTED, not what it asks for
   * (invariant #2, see `urgencyOf`).
   */
  maxUrgency: Urgency;
  /** Needs a pointer. Filtered out when `pointerCoarse`: gloves do not hover. */
  desktopOnly?: boolean;
  /**
   * The room this reading needs in order to be TRUE (defaults to `strip`);
   * the kernel drops it where that space doesn't exist. `nav.pos` needs
   * `board` because `55°42` (±1' = 1.8km) is not a position.
   */
  needsRoom?: Room;
  /** Conditional presence — `() => !!activeRoute()`. Absent, not disabled. */
  when?: () => boolean;
  /**
   * Age of the sample in seconds if the data is STALE, else null. The kernel
   * forces a stale instrument to `none` (invariant #6) rather than let it alarm.
   */
  staleAge?: () => number | null;
  /** What it REQUESTS this tick. The kernel clamps it. Absent = never urgent. */
  urgency?: () => Urgency;
  read: (ctx: ReadCtx) => Reading;
  /** `[title, detail]` for the reserved alarm band. Only reached at `alarm`. */
  alertText?: () => readonly [string, string];
  /** Side effect of the strip's ACK, beyond this device's own ack — the
   * anchor alarm acknowledges on the SignalK server so every display goes
   * quiet (anchor.md Q5). Fire-and-forget; the local ack applies regardless. */
  onAck?: () => void;
  /** Present = the strip offers MUTE beside ACK: silence for `muteS` seconds,
   * alarm still shown. Side effect like `onAck` (the collision alarm silences
   * on the SignalK server); the strip silences this device at once regardless. */
  onMute?: () => void;
  /** How long `onMute` silences, in seconds — the button's label and the
   * strip's local timer. */
  muteS?: number;
  /** Silenced at the source (SignalK, by anyone): no sound from this alarm,
   * whatever else asks it to. Still shown. */
  alertSilenced?: () => boolean;
  /** This alarm itself asks to SOUND, independent of the strip's generic
   * `alarmSound` opt-in. The anchor alarm: its SignalK notification's
   * `method` includes `sound`. The collision alarm: the boat's `sound`. */
  alertSound?: () => boolean;
  /** A life-or-boat alarm (MOB, collision, anchor drag): when it sounds it
   * uses the harsh siren, not the plain beep (`alarmSound.ts`). Depth and
   * the link/GNSS alarms stay on the beep. */
  alertCritical?: boolean;
}

/**
 * A chart mode: takes over what a chart click means — without one, a click is
 * a probe ("what is here?"). A mode owns its own state (closes over it, like
 * an instrument), so the kernel never learns what a bearing is.
 */
export interface Mode {
  id: string;
  label: string;
  /** Owns the whole chrome while active: the shell suppresses non-reserved
   * helm widgets so only the map, the mode's own surface, and reserved chrome
   * (the alarm band) remain. Reserved chrome is never suppressed. */
  solo?: boolean;
  /** Brings its own PHONE bottom bar, which takes the Rail's widget-strip
   * slot while the mode is active (Rail.tsx) — the route editor's
   * `RouteBar`. A solo mode without one keeps the strip. */
  ownsBottomBar?: boolean;
  /** Registered but not enumerated into either tool stack's button row
   * (`modeList()` in MapView.tsx) — for a mode reachable only from a specific
   * settings/menu affordance, where a stray button would have no obvious "why am I here".
   * May be an accessor, for a mode whose button is switched on by a setting
   * (the route-test probe, a developer-only tool) — read via {@link isModeHidden}. */
  hidden?: boolean | (() => boolean);
  enter?: () => void;
  leave?: () => void;
  /**
   * The click, before `info/` probes it. Return **true** to consume it; false
   * or undefined lets it fall through to "what is here?" (invariant #9).
   */
  onClick?: (click: ModeClick) => boolean | void;
  /** Veto on leaving, consulted BEFORE `leave` runs. Return `false` to keep
   * the mode open (e.g. arming a "Discard route?" confirm rather than
   * silently dropping a draft) — the mode must eventually let a leave
   * through itself. */
  requestLeave?: () => boolean;
  /** What to do next, in one line, floating over the pill. Reactive. */
  hint?: () => string;
  /** The pill's status and options — NOT a panel (see ./modes.ts header,
   * README §7). */
  pill?: (ctx: ModePillCtx) => ModePillView;
}

/**
 * A dashboard page: one tab on the board (`chrome/Dashboard.tsx`). DATA,
 * never markup. Two features may share a page id (a shared tab like "nav");
 * `createRegistry` merges their instrument lists, first label winning. A page
 * id may not be reserved chrome (invariant #1).
 */
export interface DashboardPage {
  id: string;
  label: string;
  /** Instrument ids to show as cards on this page. The config still orders and enables them. */
  instruments?: readonly string[];
}

export interface Feature {
  id: string;
  instruments?: readonly Instrument[];
  modes?: readonly Mode[];
  /** Dashboard pages this feature contributes — the board's tabs. Additive; see DashboardPage. */
  dashboard?: readonly DashboardPage[];
}

/** Every band an instrument is allowed in. Its `band` is only the default. */
export const homesOf = (i: Instrument): readonly BandId[] => i.bands ?? [i.band ?? "rail"];

/** Where `adoptDefaults` seats it the first time it is ever seen. */
export const homeOf = (i: Instrument): BandId => i.band ?? i.bands?.[0] ?? "rail";

/**
 * Validate a feature and freeze it. Throws rather than trusting review:
 * reserved chrome isn't registrable/a band (#1); a band must exist; nothing
 * alarm-grade may live in a band that can go dark (#3); an instrument must be
 * able to render SOMEWHERE. Called at import time, so a violation is a
 * module-load crash in dev, not a fog surprise.
 */
export function defineFeature(f: Feature): Feature {
  if (isReserved(f.id)) throw new Error(`reserved chrome is not registrable: "${f.id}"`);

  for (const i of f.instruments ?? []) {
    if (isReserved(i.id)) throw new Error(`reserved chrome is not registrable: "${i.id}"`);
    if (i.band && isReserved(i.band)) throw new Error(`reserved chrome is not a band: "${i.band}"`);

    for (const b of homesOf(i)) {
      if (isReserved(b)) throw new Error(`reserved chrome is not a band: "${b}"`);
      if (!BANDS[b]) throw new Error(`no such band: "${b}" (instrument "${i.id}")`);
    }
    if (i.band && !homesOf(i).includes(i.band))
      throw new Error(`instrument "${i.id}" defaults to band "${i.band}", which it is not allowed in`);

    if (i.maxUrgency === "alarm" && homesOf(i).some((b) => BANDS[b].conditional))
      throw new Error(`alarm-grade instrument "${i.id}" may not live in a conditional band`);

    const room: Room = i.needsRoom ?? "strip";
    if (!homesOf(i).some((b) => BANDS[b].rooms.includes(room)))
      throw new Error(`instrument "${i.id}" needs the "${room}" room, which no band it may live in has`);
  }

  const dupe = firstDuplicate((f.instruments ?? []).map((i) => i.id));
  if (dupe) throw new Error(`duplicate instrument id: "${dupe}"`);

  // A dashboard page is a tab, not a widget — but its id must still not be
  // reserved chrome, or a page would be a back door to the alarm band.
  for (const p of f.dashboard ?? [])
    if (isReserved(p.id)) throw new Error(`reserved chrome is not a dashboard page: "${p.id}"`);
  const pageDupe = firstDuplicate((f.dashboard ?? []).map((p) => p.id));
  if (pageDupe) throw new Error(`duplicate dashboard page id: "${pageDupe}"`);

  return Object.freeze({ ...f });
}

function firstDuplicate(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

export interface Registry {
  features: readonly Feature[];
  /** Flattened, in feature order. That order is the DEFAULT rail order — see adoptDefaults. */
  instruments: readonly Instrument[];
  modes: ReadonlyMap<string, Mode>;
  /**
   * The board's tabs, in feature order. Pages with the same id across features
   * are merged into one tab (instrument lists concatenated, first label wins).
   */
  pages: readonly DashboardPage[];
  byId: (id: string) => Instrument | undefined;
}

/**
 * Assemble the features this build has, prop-drilled from App.tsx. Collisions
 * are caught here rather than at first render — two features both claiming
 * `nav.sog` is a merge accident, not a silent shadow.
 */
export function createRegistry(features: readonly Feature[]): Registry {
  const featureDupe = firstDuplicate(features.map((f) => f.id));
  if (featureDupe) throw new Error(`duplicate feature id: "${featureDupe}"`);

  const instruments = features.flatMap((f) => [...(f.instruments ?? [])]);
  const dupe = firstDuplicate(instruments.map((i) => i.id));
  if (dupe) throw new Error(`duplicate instrument id across features: "${dupe}"`);

  const modeDupe = firstDuplicate(features.flatMap((f) => (f.modes ?? []).map((m) => m.id)));
  if (modeDupe) throw new Error(`duplicate mode id: "${modeDupe}"`);

  const pageMap = new Map<string, { id: string; label: string; instruments: string[] }>();
  for (const f of features)
    for (const p of f.dashboard ?? []) {
      const existing = pageMap.get(p.id);
      if (existing) existing.instruments.push(...(p.instruments ?? []));
      else pageMap.set(p.id, { id: p.id, label: p.label, instruments: [...(p.instruments ?? [])] });
    }

  const index = new Map(instruments.map((i) => [i.id, i]));
  return {
    features,
    instruments,
    modes: new Map(features.flatMap((f) => (f.modes ?? []).map((m) => [m.id, m] as const))),
    pages: [...pageMap.values()],
    byId: (id) => index.get(id),
  };
}

/**
 * THE CLAMP. `maxUrgency` is GRANTED, not claimed (invariant #2): the kernel
 * lowers a widget's requested urgency to its feature's ceiling — `route.xte`
 * asks for `alarm` every tick and is granted `notice`, forever. A stale
 * instrument is forced to `none` first (invariant #6).
 */
export function urgencyOf(inst: Instrument): Urgency {
  if (isStale(inst)) return "none";
  const want = inst.urgency?.() ?? "none";
  return RANK[want] > RANK[inst.maxUrgency] ? inst.maxUrgency : want;
}

export const isStale = (inst: Instrument): boolean => (inst.staleAge?.() ?? null) !== null;

/** Everything the shell needs to draw one cell, resolved in one call. */
export interface InstrumentView {
  reading: Reading;
  urgency: Urgency;
  stale: boolean;
  /** Seconds since the last sample, when stale. The shell shows it beside the strike-through. */
  staleSeconds: number | null;
}

/**
 * Read one instrument against the space it is given. The kernel decides
 * urgency and staleness; the widget decides what to drop at `helm` density
 * (invariant #6: stale cannot alarm, AND stale is reported so it can LOOK stale).
 */
export function readInstrument(inst: Instrument, ctx: ReadCtx): InstrumentView {
  const staleSeconds = inst.staleAge?.() ?? null;
  return {
    reading: inst.read(ctx),
    urgency: urgencyOf(inst),
    stale: staleSeconds !== null,
    staleSeconds,
  };
}

/**
 * How a reading's VALUE is coloured. A live value wears its urgency
 * (`notice`/`alarm`), a plain reading wears `fg`, and a stale or absent one
 * drops to `fg-3` and strikes through — a dead sensor must LOOK dead (invariant #6).
 */
export function readingValueClasses(view: InstrumentView): Record<string, boolean> {
  return {
    "text-fg": view.urgency === "none" && !view.stale && view.reading.state !== "null",
    "text-notice": view.urgency === "notice" && !view.stale,
    "text-alarm": view.urgency === "alarm" && !view.stale,
    "text-fg-3": view.stale || view.reading.state === "null",
    "line-through decoration-2 opacity-80": view.stale,
  };
}

export interface Alert {
  id: string;
  title: string;
  detail: string;
  /** See `Instrument.onAck`. */
  ack?: () => void;
  /** See `Instrument.onMute` / `Instrument.muteS`. */
  mute?: { run: () => void; seconds: number };
  /** See `Instrument.alertSilenced`. */
  silenced?: boolean;
  /** See `Instrument.alertSound`. */
  sound?: boolean;
  /** See `Instrument.alertCritical`. */
  critical?: boolean;
}

/**
 * What the reserved alarm band shows. Scans every instrument, ignoring bands
 * and enablement entirely: a depth alarm fires whether or not you kept the
 * DBK tile on your rail — turning off a tile turns off a READOUT, never a guard.
 */
export function alerts(reg: Registry): Alert[] {
  return reg.instruments
    .filter((i) => urgencyOf(i) === "alarm" && i.alertText)
    .map((i) => {
      const [title, detail] = i.alertText!();
      const alert: Alert = { id: i.id, title, detail };
      if (i.onAck) alert.ack = i.onAck;
      if (i.onMute && i.muteS) alert.mute = { run: i.onMute, seconds: i.muteS };
      if (i.alertSilenced?.()) alert.silenced = true;
      if (i.alertSound?.()) alert.sound = true;
      if (i.alertCritical) alert.critical = true;
      return alert;
    });
}

/** Is `mode` kept out of the tool stacks' button rows right now? */
export const isModeHidden = (mode: Pick<Mode, "hidden">): boolean =>
  typeof mode.hidden === "function" ? mode.hidden() : !!mode.hidden;
