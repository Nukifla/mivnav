// Live boat data, from the backend's SignalK proxy. The browser no longer
// speaks to SignalK directly — the boat's server holds the one upstream
// connection and every device subscribes to that, so this is a client of
// *our* backend. The wire is a whole normalized snapshot, sent only when
// something changed; delta/staleness rules are settled server-side, leaving
// nothing here but a socket and a few signals. See docs/architecture/signalk-client.md.

import { batch, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { markBuddy, vesselsFromSignalK, type AisVessel } from "./info/vessel";
import type { CrossingAspect, CrossingSide, Risk } from "./cpa";
import { DEFAULT_COLLISION_SETTINGS, type CollisionSettings } from "./collisionSettings";
import { DEFAULT_GNSS_SETTINGS, type GnssSettings } from "./gnssSettings";
import { DEFAULT_SHALLOW_SETTINGS, type Shallow, type ShallowNotice, type ShallowSettings } from "./shallow";

export interface Vessel {
  lng: number;
  lat: number;
  /** True heading, degrees. */
  headingDeg?: number;
  /** Course over ground, degrees true. */
  cogDeg?: number;
  /** Speed over ground, m/s. */
  sogMs?: number;
  /** Depth below the transducer, metres — the RAW echo, the only depth every
   * install has. NOT the water under the keel, NOT a charted sounding — it
   * OVERSTATES by the transducer's own depth. See
   * docs/architecture/signalk-client.md before comparing to `safetyContour`. */
  depthBelowTransducerM?: number;
  /** Depth below the surface, metres — same echo with the boat's configured
   * transducer offset added by its own SignalK server, so this is the one
   * comparable to a charted sounding. Absent when no offset is configured;
   * the backend never synthesizes it from `depthBelowTransducerM`. */
  depthBelowSurfaceM?: number;
  /** Water under the KEEL, metres — a clearance, not a depth, as the boat's
   * own SignalK computes it from its configured offsets. Absent unless set up. */
  depthBelowKeelM?: number;
  /** Apparent wind speed, m/s — SignalK `environment.wind.speedApparent`. */
  awsMs?: number;
  /** Apparent wind angle, degrees, −180…+180, NEGATIVE TO PORT (SignalK's sign). */
  awaDeg?: number;
  /** True wind speed, m/s, through the WATER — pairs with `twaDeg`. Often
   * plugin-derived from the apparent pair, so it can go stale while `awsMs`
   * stays live — see `stale`. */
  twsMs?: number;
  /** True wind angle, degrees, −180…+180, negative to port. Through the water. */
  twaDeg?: number;
  /**
   * ⚠️ HOW OLD THE GUARDED SENSORS ARE. `{wireField: ageSeconds}`, only the
   * fields stale RIGHT NOW. Computed by the backend against its own clock —
   * do NOT recompute here or use `Date.parse` (no shared clock at sea; a
   * fast tablet's clock would silently DISARM the depth guard, invariant
   * #6). Meaningful ONLY while `status() === "connected"`. See
   * docs/architecture/signalk-client.md.
   */
  stale?: Record<string, number>;
  name?: string;
  /** The station's MMSI, as a STRING because the leading digits carry the
   * grammar (a coast station's `00…`, an AtoN's `99…`; see `mmsi.ts`), used by
   * the MMSI-kind detection in `layers/aisSymbols.ts`. Absent on a
   * position-only report, an ordinary AIS state. */
  mmsi?: string;
  /** The fix's own timestamp, ISO 8601 (SignalK `navigation.datetime`). Use
   * as a CHANGE DETECTOR, never a clock — comparing to `Date.now()` compares
   * the GPS's clock to the browser's (no NTP at sea). `chrome/core.ts`'s
   * `fixAge` is the one consumer. Absent on plenty of vessels. */
  positionAtIso?: string;
  /** Navigational status, kept as SignalK's raw string rather than an enum —
   * it's an open vocabulary in practice, and `layers/aisSymbols.ts` is better
   * placed to be generous than a transport type is to be strict. Orthogonal
   * to `shipTypeId` (a fishing vessel can be at anchor); where they disagree,
   * this one wins. */
  navStatus?: string;
  /**
   * Static ship type — the ITU-R M.1371 code behind SignalK's
   * `design.aisShipType` (`{id, name}`; this is the `id`). 30 fishing,
   * 36 sailing, 40-49 high-speed craft, 70-79 cargo, 80-89 tanker.
   * Class B position reports carry no navigational status at all, so for
   * most yachts this is the only thing that will ever say "sailing".
   */
  shipTypeId?: number;
  /** Where this target's position has come from in the last 10 minutes:
   * our own receiver, the internet (the aiscast plugin), or both. */
  origin?: VesselOrigin;
}

export type VesselOrigin = "local" | "online" | "both";

export interface BuddyMark {
  /** The name the buddy list knows, for a target whose own hasn't arrived. */
  aisName?: string;
  nickname?: string;
  note?: string;
}

/**
 * The boat's autopilot, folded server-side from `steering.*` deltas. Read-only
 * here — a DISPLAY surface, not where commands go (see `core/autopilot.ts`).
 *
 * ⚠️ OMIT-WHEN-ABSENT, NEVER DEFAULTED: every field stays `undefined` until
 * the pilot has said so — `engaged` absent is UNKNOWN, not `false`.
 *
 * ⚠️ NO TTL: the only liveness signal is `status`; when it's not
 * `"connected"` this must render UNKNOWN/link-lost, never a live engaged
 * pilot — enforced by consumers. See docs/architecture/signalk-client.md.
 */
export interface Autopilot {
  /** The pilot's own state vocabulary ("enabled"/"auto"/"standby"/"wind"…). Never remapped. */
  state?: string;
  /** The pilot's own mode ("compass"/"gps"/"nav"/"wind"…). */
  mode?: string;
  /** Is it actually steering. Absent = unknown; do not read absence as `false`. */
  engaged?: boolean;
  /**
   * The commanded target, DEGREES. Not necessarily a heading: its meaning
   * depends on `mode` (a compass bearing in compass/gps/nav, a wind angle in
   * wind). See the backend module docstring.
   */
  targetDeg?: number;
  /** Where the rudder actually is, degrees. Negative to port. */
  rudderAngleDeg?: number;
  /** Which provider the server routes `_default` to — how a UI names what it steers. */
  defaultPilot?: string;
  /** Actions live right now (as opposed to the static capability list). */
  availableActions?: string[];
}

/**
 * The boat's active steering target, folded server-side from the v2 Course
 * API's delta mirror. Makes the yellow steering cue trustworthy: it's the
 * SAME object `mivnav.features.route.client` writes to, so it reads back
 * "what SignalK reports as active" — set by mivnav, another cockpit screen,
 * or pypilot — rather than mivnav's own local active-leg state.
 *
 * ⚠️ OMIT-WHEN-ABSENT, like `Autopilot`. `nextLat`/`nextLng` are required to
 * draw; `prevLat`/`prevLng` are preferred as the line's start when present,
 * with `signalk.self()` as fallback (`route/index.ts`'s `targetLine`). See
 * docs/architecture/signalk-client.md.
 */
export interface Course {
  /** The active course's destination waypoint, degrees. Absent until heard. */
  nextLat?: number;
  nextLng?: number;
  /** The active course's origin (the leg's `previousPoint`), degrees. */
  prevLat?: number;
  prevLng?: number;
}

/**
 * The anchor watch as SignalK's anchoralarm plugin reports it — the plugin is
 * the watcher, mivnav only shows and commands it (anchor.md). Folded
 * server-side from the PLUGIN'S OWN updates only (`mivnav.signalk.anchor`:
 * the N2K emitter writes a stale echo of the alarm onto the same path).
 *
 * `null` from `SignalKState.anchor` = the plugin has never spoken (not
 * installed / SignalK off). Present without `lat`/`lng` = anchor up.
 * OMIT-WHEN-ABSENT, like `Course`.
 */
export interface Anchor {
  lat?: number;
  lng?: number;
  /** The watch circle, metres from the anchor to the GPS antenna. */
  maxRadiusM?: number;
  /** How far the antenna is from the anchor now, metres. */
  currentRadiusM?: number;
  /** Bearing from the boat to the anchor, degrees true. */
  bearingTrueDeg?: number;
  rodeLengthM?: number;
  /** The plugin's margin added by "set radius from here". */
  fudgeM?: number;
  /** The plugin's `notifications.navigation.anchor`, reduced. */
  alarm?: AnchorAlarm;
}

export interface AnchorAlarm {
  /** SignalK ALARM_STATE: normal | alert | warn | alarm | emergency. */
  state: string;
  message?: string;
  /** Notifications-API id — what a server-side ACK names. */
  id?: string;
  /** Does SignalK want this to make noise NOW. The server drops it on ACK
   * (an acknowledged emergency stays visible, goes quiet everywhere). */
  sound: boolean;
  acknowledged?: boolean;
  canAcknowledge?: boolean;
}

/**
 * The server's collision assessment (`mivnav.collision.assess`), recomputed
 * on every snapshot from the same vessels this client sees — THE alarm's
 * source: the server also raises it on SignalK, so a screen, the MFD and KIP
 * agree (docs/architecture/cpa-backend.md). The chart's per-target colouring
 * runs `cpa.ts` locally with the same boat-wide thresholds (`collisionSettings`).
 *
 * `null` from `SignalKState.collision` = no own fix, or nothing computable.
 */
export interface Collision {
  /** The ONE target the CPA tile is about: the worst computable — green
   * included, so the tile shows the closest pass even when it is safe. */
  threat: CollisionThreat;
  /** Every red/yellow target, by id — what is raised on SignalK. */
  alarms?: CollisionThreat[];
}

export interface CollisionThreat {
  id: string;
  name?: string;
  mmsi?: string;
  risk: Risk;
  cpaNm: number;
  /** Minutes; negative = closest approach already passed (green). */
  tcpaMin: number;
  rangeNm: number;
  aspect: CrossingAspect;
  side: CrossingSide;
}

/**
 * One of OUR collision notifications as SignalK holds it right now — the
 * echo of what `mivnav.collision.publisher` raised, with the
 * Notifications-API `id` the server added (`mivnav.collision.notices`).
 * Same shape and meaning as `AnchorAlarm`, plus SignalK's silence: muted
 * by anyone (a screen's MUTE, KIP, the MFD), re-armed by the publisher
 * after `COLLISION_MUTE_S`. Present only while active.
 */
export type CollisionNotice = AnchorAlarm & { silenced?: boolean; canSilence?: boolean };

/**
 * The active man-overboard mark, as this server stores it
 * (`mivnav.features.mob`) — the truth every screen shows. Present only while
 * a MOB is up; no `lat`/`lng` = raised with no fix at all.
 */
export interface MobMark {
  id: string;
  /** When the button went down, ISO 8601 UTC. */
  at: string;
  lat?: number;
  lng?: number;
  source?: string;
}

/**
 * `notifications.mob` as SignalK holds it right now — ours (`ours: true`,
 * the echo of the server's raise) or anyone's (an MFD's MOB key). Same
 * fields as `AnchorAlarm`. Present only while active.
 */
export type MobNotice = AnchorAlarm & {
  ours: boolean;
  silenced?: boolean;
  lat?: number;
  lng?: number;
};

/** How long a collision MUTE lasts — the backend's `publisher.MUTE_S`, which
 * is what actually re-arms it on SignalK; this copy only times this screen's
 * own immediate silence before the server's echo lands. */
export const COLLISION_MUTE_S = 120;

/** Acknowledge the collision alarm on the SignalK SERVER (backend
 * `POST /signalk/collision/ack`), so every display and the MFD go quiet. Takes
 * the ids the user saw. Resolves `false` on any failure, never rejects — the
 * local ack has already hidden the strip on this screen. */
export function acknowledgeCollision(ids: string[]): Promise<boolean> {
  return collisionAction("ack", ids);
}

/** Silence the collision alarm on the SignalK SERVER for `COLLISION_MUTE_S`
 * (backend `POST /signalk/collision/silence`): the sound stops on every
 * display, the alarm stays up. Same contract as `acknowledgeCollision`. */
export function silenceCollision(ids: string[]): Promise<boolean> {
  return collisionAction("silence", ids);
}

async function collisionAction(action: "ack" | "silence", ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  try {
    const res = await fetch(`/api/signalk/collision/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One user-chosen SignalK path, passed through RAW for a dashboard widget —
 * beyond the curated set (a battery voltage, a tank level). `value` is
 * whatever the bus reported, NOT converted to plotter units; `units` is
 * SignalK's own meta string when sent; `age` (seconds) is present ONLY when
 * stale, bucketed like `Vessel.stale` — see docs/architecture/signalk-client.md.
 */
export interface PathValue {
  value: unknown;
  units?: string;
  age?: number;
}

/**
 * One enumerable SignalK path, for the dashboard's add-widget combo box
 * (`GET /api/signalk/paths`). The backend flattens the boat's SignalK REST
 * tree to these — every leaf that carries a value, with its `meta.units` when
 * the box published one. Distinct from the LIVE `paths` snapshot above, which
 * only carries the already-subscribed user paths.
 */
export interface SkPath {
  path: string;
  units?: string;
}

/**
 * Enumerate the boat's SignalK paths for the widget picker. Resolves to `[]`
 * — never rejects — when SignalK is off, unreachable, or the request fails:
 * the picker still works (freeform typing), it just has nothing to suggest.
 */
export async function fetchSignalKPaths(): Promise<SkPath[]> {
  try {
    const res = await fetch("/api/signalk/paths");
    if (!res.ok) return [];
    const body = (await res.json()) as { paths?: SkPath[] };
    return Array.isArray(body.paths) ? body.paths : [];
  } catch {
    return [];
  }
}

// One enumeration per page load, shared by every unit picker and SK widget.
// An empty result (SignalK off/unreachable) is not cached, so a later call
// retries once the box is up.
let pathsOnce: Promise<SkPath[]> | undefined;
export function enumerateSignalKPaths(): Promise<SkPath[]> {
  pathsOnce ??= fetchSignalKPaths().then((list) => {
    if (list.length === 0) pathsOnce = undefined;
    else setListedUnits(Object.fromEntries(list.flatMap((p) => (p.units ? [[p.path, p.units]] : []))));
    return list;
  });
  return pathsOnce;
}
const [listedUnits, setListedUnits] = createSignal<Record<string, string>>({});

/**
 * A path's `meta.units` from the path LIST, reactively (undefined until it
 * loads). The live `paths` snapshot only has units when SignalK sent the
 * path's meta delta after the backend subscribed to it — meta goes out about
 * once, at connect, so a widget added later typically never gets one and
 * would show its raw SI value (a 0–1 ratio as "0.5 %").
 */
export function listedUnitsFor(path: string): string | undefined {
  void enumerateSignalKPaths();
  return listedUnits()[path];
}

/** The backend's view of the boat's SignalK box: absent, dialling, live. */
export type SignalKStatus = "off" | "connecting" | "connected";

export interface SignalKState {
  /** Own vessel, once a position has arrived. */
  self: Accessor<Vessel | null>;
  /** AIS targets: every other vessel with a known position. */
  targets: Accessor<Vessel[]>;
  status: Accessor<SignalKStatus>;
  /** `null` until any `steering.*` path has arrived — see `Autopilot`. */
  autopilot: Accessor<Autopilot | null>;
  /** `null` until any `navigation.course*` path has arrived — see `Course`,
   * the TRUTH the yellow steering cue renders from. */
  course: Accessor<Course | null>;
  /** Raw values of the user-chosen dashboard paths, keyed by path. `{}` when
   * none is configured/reported yet. See `PathValue`. */
  paths: Accessor<Record<string, PathValue>>;
  /** `null` until the anchoralarm plugin has spoken — see `Anchor`. */
  anchor: Accessor<Anchor | null>;
  /** The server's collision assessment — see `Collision`. */
  collision: Accessor<Collision | null>;
  /** Our collision notifications on SignalK, by target id — `{}` while none
   * is active (or nothing is published). See `CollisionNotice`. */
  collisionNotices: Accessor<Record<string, CollisionNotice>>;
  /** The boat's collision settings (thresholds, off/show/tell, sound) as the
   * server runs them — `DEFAULT_COLLISION_SETTINGS` until a snapshot says. */
  collisionSettings: Accessor<CollisionSettings>;
  /** The server says the own ship has sent no position for the boat's
   * `gnssSettings.delay_s` while SignalK is connected (`mivnav.gnss`) —
   * the GNSS-lost alarm, already debounced on the server. */
  fixLost: Accessor<boolean>;
  /** The server's own-fix age (bucketed, ≥ 10 s), absent while fresh. */
  fixAge: Accessor<number | null>;
  /** The boat's GNSS/connection alarm settings — the last ones heard. */
  gnssSettings: Accessor<GnssSettings>;
  /** Since when (`Date.now()` ms) this screen has NOT been hearing the
   * mivnav server — socket closed, or a liveness ping unanswered; `null`
   * while it is. The server-unreachable alarm's input; it can only be
   * detected here, and can only be raised here. */
  linkDownSince: Accessor<number | null>;
  /** The server's shallow-water assessment (`mivnav.shallow`) — see `Shallow`. */
  shallow: Accessor<Shallow | null>;
  /** Our shallow-water notification on SignalK, or null while none is active. */
  shallowNotice: Accessor<ShallowNotice | null>;
  /** The boat's shallow-alarm settings as the server runs them. */
  shallowSettings: Accessor<ShallowSettings>;
  /** The active MOB mark — `null` while none is up. See `MobMark`. */
  mob: Accessor<MobMark | null>;
  /** `notifications.mob` on SignalK — `null` while none is active. */
  mobNotice: Accessor<MobNotice | null>;
  /**
   * The ONE derived vessel list — own ship first, then every AIS target
   * (`vesselsFromSignalK`). Derived once here as a memo over `self`/`targets`
   * so the chart overlay and the info panel read the SAME list rather than
   * each re-deriving it — which is what let the panel and the chart disagree
   * (bug C2). See docs/architecture/signalk-client.md.
   */
  vessels: Accessor<AisVessel[]>;
  /** Which MMSIs are buddies, with what the skipper wrote about each: stamps
   * `AisVessel.buddy` and friends. Owned by the buddies feature, set here so
   * every reader of `vessels` agrees without knowing it. */
  setBuddies: (buddies: ReadonlyMap<string, BuddyMark>) => void;
}

interface Snapshot {
  status: SignalKStatus;
  self: Vessel | null;
  targets: Vessel[];
  autopilot?: Autopilot | null;
  course?: Course | null;
  paths?: Record<string, PathValue>;
  anchor?: Anchor;
  collision?: Collision;
  collisionNotices?: Record<string, CollisionNotice>;
  collisionSettings?: CollisionSettings;
  fixLost?: boolean;
  fixAge?: number;
  gnssSettings?: GnssSettings;
  shallow?: Shallow;
  shallowNotice?: ShallowNotice;
  shallowSettings?: ShallowSettings;
  mob?: MobMark;
  mobNotice?: MobNotice;
}

// Shorter than the old SignalK backoff: this reconnects to our own backend
// on the same host, so a failure is a restart or wifi dropout, both
// resolving in seconds.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;
/** How often an open socket is probed ("ping" → the backend's "pong"). The
 * boat publishes only on change, so an idle boat says nothing for minutes —
 * and a half-open socket (wifi gone) fires no `close` for as long. */
export const PING_INTERVAL_MS = 2_000;
/** An unanswered ping older than this is a dead link: dropped and re-dialled. */
export const PING_DEAD_MS = 10_000;

/**
 * The proxy's stream URL for a page served from `origin`.
 *
 * Same-origin by construction — vite proxies /api to the backend in dev,
 * and in production they are one host — so there is nothing to configure
 * and no CORS to arrange.
 */
export function streamUrl(origin: string): string {
  const url = new URL("/api/signalk/stream", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export interface SignalKOptions {
  /** Defaults to the backend's stream on this page's origin. */
  url?: string;
  /** Socket factory — the seam a test drives. */
  open?: (url: string) => WebSocket;
  /** Clock and probe timer — seams a test drives. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function createSignalK(options: SignalKOptions = {}): SignalKState {
  const url = options.url ?? streamUrl(location.origin);
  const open = options.open ?? ((u: string) => new WebSocket(u));

  const [self, setSelf] = createSignal<Vessel | null>(null);
  const [targets, setTargets] = createSignal<Vessel[]>([]);
  // Null, not `{}`: nothing heard is not a disengaged pilot. See `Autopilot`.
  const [autopilot, setAutopilot] = createSignal<Autopilot | null>(null);
  // Null until any course path has arrived — see `Course`.
  const [course, setCourse] = createSignal<Course | null>(null);
  // `{}`, not null: an empty map IS the answer ("no extra paths reporting"),
  // unlike the autopilot where null distinguishes "no pilot on the bus".
  const [paths, setPaths] = createSignal<Record<string, PathValue>>({});
  // Compared by value: the whole snapshot re-sends at up to 5 Hz whenever
  // ANY vessel moves, and the anchor overlay should rebuild only when the
  // anchor itself changed.
  const [anchor, setAnchor] = createSignal<Anchor | null>(null, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  const [collision, setCollision] = createSignal<Collision | null>(null);
  // By value, like `anchor`: re-sent at 5 Hz, changes only on raise/ack/clear.
  const [collisionNotices, setCollisionNotices] = createSignal<Record<string, CollisionNotice>>(
    {},
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  // By value: re-sent with every snapshot, changes only on a settings edit.
  const [collisionSettings, setCollisionSettings] = createSignal<CollisionSettings>(
    DEFAULT_COLLISION_SETTINGS,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  // By value, like the collision trio: re-sent at 5 Hz.
  const byValue = { equals: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) };
  const [shallow, setShallow] = createSignal<Shallow | null>(null, byValue);
  const [shallowNotice, setShallowNotice] = createSignal<ShallowNotice | null>(null, byValue);
  const [shallowSettings, setShallowSettings] = createSignal<ShallowSettings>(
    DEFAULT_SHALLOW_SETTINGS,
    byValue,
  );
  // By value: re-sent with every snapshot, changes only on raise/ack/clear.
  const [mob, setMob] = createSignal<MobMark | null>(null, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  const [mobNotice, setMobNotice] = createSignal<MobNotice | null>(null, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  // Not "off": off is a fact about the boat, and until the backend has
  // said so we do not have one.
  const [status, setStatus] = createSignal<SignalKStatus>("connecting");
  const [fixLost, setFixLost] = createSignal(false);
  const [fixAge, setFixAge] = createSignal<number | null>(null);
  const [gnssSettings, setGnssSettings] = createSignal<GnssSettings>(DEFAULT_GNSS_SETTINGS, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  const clock = options.now ?? (() => Date.now());
  // Down from the start: until the first socket opens, this screen has not
  // heard the server.
  const [linkDownSince, setLinkDownSince] = createSignal<number | null>(clock());
  const markDown = (at: number) => setLinkDownSince((prev) => prev ?? at);

  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let generation = 0; // invalidates handlers of torn-down sockets

  const apply = (raw: string) => {
    let snapshot: Snapshot;
    try {
      snapshot = JSON.parse(raw) as Snapshot;
    } catch {
      return;
    }
    // One batch: status, own ship and targets always move together, and a
    // half-applied snapshot would be a frame of a boat that never existed.
    batch(() => {
      setStatus(snapshot.status ?? "connecting");
      setSelf(snapshot.self ?? null);
      setTargets(snapshot.targets ?? []);
      // Straight through, never coerced: the backend already omits every
      // field it hasn't heard; `?? null` only defaults the whole key missing.
      setAutopilot(snapshot.autopilot ?? null);
      setCourse(snapshot.course ?? null);
      setPaths(snapshot.paths ?? {});
      setAnchor(snapshot.anchor ?? null);
      setCollision(snapshot.collision ?? null);
      setCollisionNotices(snapshot.collisionNotices ?? {});
      setMob(snapshot.mob ?? null);
      setMobNotice(snapshot.mobNotice ?? null);
      // Kept, not defaulted, when a snapshot lacks it: the settings did not
      // change just because one frame left them out.
      if (snapshot.collisionSettings) {
        setCollisionSettings({ ...DEFAULT_COLLISION_SETTINGS, ...snapshot.collisionSettings });
      }
      setFixLost(snapshot.fixLost === true);
      setFixAge(snapshot.fixAge ?? null);
      // Kept like `collisionSettings`: a screen cut off from the server
      // still alarms by the last settings it heard.
      if (snapshot.gnssSettings) setGnssSettings({ ...DEFAULT_GNSS_SETTINGS, ...snapshot.gnssSettings });
      setShallow(snapshot.shallow ?? null);
      setShallowNotice(snapshot.shallowNotice ?? null);
      if (snapshot.shallowSettings) {
        setShallowSettings({ ...DEFAULT_SHALLOW_SETTINGS, ...snapshot.shallowSettings });
      }
    });
  };

  const teardown = () => {
    generation++;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (ws) {
      const old = ws;
      ws = null;
      try {
        old.close();
      } catch {
        /* already dead */
      }
    }
  };

  const scheduleRetry = (gen: number) => {
    if (gen !== generation) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** retries);
    retries++;
    retryTimer = setTimeout(() => {
      if (gen === generation) connect();
    }, delay);
  };

  const connect = () => {
    const gen = generation;
    let socket: WebSocket;
    try {
      socket = open(url);
    } catch {
      scheduleRetry(gen);
      return;
    }
    ws = socket;
    awaitingSince = null;
    socket.onopen = () => {
      if (gen !== generation) return;
      retries = 0;
      setLinkDownSince(null);
    };
    socket.onmessage = (e) => {
      if (gen !== generation) return;
      // Anything at all is the server answering — a snapshot or a pong.
      awaitingSince = null;
      setLinkDownSince(null);
      if (typeof e.data === "string" && e.data !== "pong") apply(e.data);
    };
    socket.onclose = () => {
      if (gen !== generation) return;
      ws = null;
      markDown(clock());
      // The backend is gone, so the boat's SignalK status is unknown — not
      // "off", which would claim there is no SignalK box.
      setStatus("connecting");
      scheduleRetry(gen);
    };
    // onclose follows onerror; all retry logic lives there
    socket.onerror = () => {};
  };

  // When each vessel was last RECEIVED, keyed by stable id, persisted across
  // snapshots (a closure, not memo state): the whole snapshot re-sends
  // whenever ANY vessel changes, so blindly stamping `Date.now()` would reset
  // every target's age each time one of them moved. Local browser time on
  // both ends, never the fix's own `positionAtIso` — same reasoning as `createFixAge`.
  const receiveTimes = new Map<string, { sig: string; at: number }>();
  const stampReceiveTimes = (list: AisVessel[]): AisVessel[] => {
    const nowMs = Date.now();
    const seen = new Set<string>();
    const out = list.map((v) => {
      seen.add(v.id);
      const sig = JSON.stringify(v);
      const prev = receiveTimes.get(v.id);
      const at = prev && prev.sig === sig ? prev.at : nowMs;
      if (!prev || prev.sig !== sig) receiveTimes.set(v.id, { sig, at });
      return { ...v, receivedAtMs: at };
    });
    for (const id of receiveTimes.keys()) if (!seen.has(id)) receiveTimes.delete(id);
    return out;
  };

  // The single derivation of the vessel set (see `SignalKState.vessels`): a
  // memo so every reader gets the SAME array reference until the next
  // change, rather than each rebuilding the target list several times a second.
  const [buddies, setBuddies] = createSignal<ReadonlyMap<string, BuddyMark>>(new Map());
  const vessels = createMemo(() => {
    const known = buddies();
    return stampReceiveTimes(vesselsFromSignalK(self(), targets())).map((v) => {
      const mark = !v.self && v.mmsi !== undefined ? known.get(v.mmsi) : undefined;
      return mark ? markBuddy(v, mark) : v;
    });
  });

  // -- liveness: the server-unreachable alarm's input ----------------------
  // A ping is outstanding from `awaitingSince` until anything arrives. Down
  // counts from the FIRST unanswered ping, so a dead server alarms on the
  // same delay as a closed socket.
  let awaitingSince: number | null = null;
  let lastProbe = clock();
  const probe = () => {
    const now = clock();
    // A frozen/background tab's timers stall; its first tick back must not
    // read the stall as a dead server. Start the probe over instead.
    const resumed = now - lastProbe > 3 * PING_INTERVAL_MS;
    lastProbe = now;
    const socket = ws;
    if (!socket || socket.readyState !== 1 /* OPEN */) return;
    if (resumed) awaitingSince = null;
    if (awaitingSince === null) {
      awaitingSince = now;
      try {
        socket.send("ping");
      } catch {
        /* onclose follows */
      }
      return;
    }
    if (now - awaitingSince >= PING_INTERVAL_MS) markDown(awaitingSince);
    if (now - awaitingSince >= PING_DEAD_MS) {
      // Half-open: no close is coming. Drop it and dial again.
      teardown();
      connect();
    }
  };
  const setTimer = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = options.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const probeTimer = setTimer(probe, PING_INTERVAL_MS);

  connect();
  onCleanup(() => {
    clearTimer(probeTimer);
    teardown();
  });

  return {
    self,
    targets,
    status,
    autopilot,
    course,
    paths,
    anchor,
    collision,
    collisionNotices,
    collisionSettings,
    fixLost,
    fixAge,
    gnssSettings,
    linkDownSince,
    shallow,
    shallowNotice,
    shallowSettings,
    mob,
    mobNotice,
    vessels,
    setBuddies,
  };
}
