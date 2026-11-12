// Per-frame coalescing + dedup + a target-rate throttle for the SignalK push.
// Without these, ~73 targets put 73% of scripting time under
// `socket.onmessage` (measured). See docs/architecture/scene-push-throttle.md.
//
// Lives apart from the canvas/DOM-touching `signalkShips.ts` so it is
// unit-testable directly (bun shares one module registry per run).

import type { Map as MLMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";

/** Minimum interval between two pushes of the big ~73-target source, in ms.
 * ~2.5 Hz: AIS targets move slowly, and it's > the 300ms MapLibre symbol
 * fade so a fade always finishes before the next push. */
export const AIS_TARGET_THROTTLE_MS = 400;

/** How a frame is scheduled. Injected in tests for a deterministic frame. */
export type FrameScheduler = (cb: () => void) => void;

/** requestAnimationFrame where there is one (the browser), a macrotask where
 * there is not. */
export const defaultScheduler: FrameScheduler = (cb) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(cb);
  else setTimeout(cb, 0);
};

/** A monotonic-ish millisecond clock. Injected in tests to control the throttle
 * without real time. */
export type Clock = () => number;

/** performance.now where there is one, Date.now otherwise. */
export const defaultClock: Clock = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/** Schedules `cb` to run after `ms`. Injected in tests to fire the trailing
 * target flush deterministically. */
export type TimerScheduler = (cb: () => void, ms: number) => void;

/** setTimeout, the only production timer we need. */
export const defaultTimer: TimerScheduler = (cb, ms) => {
  setTimeout(cb, ms);
};

/** The sliver of `GeoJSONSource` a push needs. */
export interface DataSource {
  setData(data: FeatureCollection): void;
}

/** What one frame draws, built ONCE per frame from the latest state: the two
 * sources (absent while a style reload is mid-flight) and the collections to
 * put in them, plus an optional side effect (the SAR rotor start/stop). */
export interface ScenePayload {
  own: DataSource | undefined;
  tgt: DataSource | undefined;
  /** The small CPA-figure source, deduped INDEPENDENTLY of `tgt`: it changes
   * at own-ship (GPS) rate while `tgt` changes only at AIS rate, so a busy
   * own-ship fix can re-push just this handful and skip the ~73-feature `tgt`
   * reparse entirely. Optional so unit doubles can omit it. */
  cpa?: DataSource | undefined;
  ownData: FeatureCollection;
  tgtData: FeatureCollection;
  cpaData?: FeatureCollection;
  after?: () => void;
}

interface PushState {
  /** A frame is already scheduled; the next call only replaces `produce`. */
  scheduled: boolean;
  /** The latest producer to run; the last write wins. Kept (not nulled) after a
   * flush so the trailing target timer can re-run it for the freshest snapshot. */
  produce: (() => ScenePayload) | null;
  /** The last GeoJSON actually pushed, for the dedup skip. `undefined` after an
   * `invalidateScenePush` (a style reload emptied the source) forces a refill. */
  lastOwn?: string;
  lastTgt?: string;
  lastCpa?: string;
  /** Clock time of the last target `setData`; the throttle measures from here. */
  tgtFlushAt: number;
  /** A trailing target flush is already scheduled — don't stack another. */
  tgtTrailing: boolean;
  clock: Clock;
  timer: TimerScheduler;
}

const states = new WeakMap<MLMap, PushState>();

/** Forget the last-pushed GeoJSON so the next flush refills the sources even
 * when unchanged — called when a style reload re-creates the sources EMPTY,
 * else a stale "already pushed this" leaves the chart bare until something
 * next moves. Also resets the target throttle so the refill isn't deferred. */
export function invalidateScenePush(map: MLMap): void {
  const s = states.get(map);
  if (s) {
    s.lastOwn = undefined;
    s.lastTgt = undefined;
    s.lastCpa = undefined;
    s.tgtFlushAt = Number.NEGATIVE_INFINITY; // refill on the next push, undeferred
  }
}

/** Run the latest producer and push each source that changed. Own and CPA push
 * every call (tiny, must stay live); the big target source is rate limited to
 * one push per `AIS_TARGET_THROTTLE_MS`, with a single trailing timer armed to
 * flush the LATEST snapshot at the window boundary if one lands inside it. */
function flush(s: PushState): void {
  const p = s.produce;
  if (!p) return;
  const payload = p();
  if (!payload.own || !payload.tgt) return; // sources gone (mid style reload)

  const ownJson = JSON.stringify(payload.ownData);
  if (ownJson !== s.lastOwn) {
    payload.own.setData(payload.ownData);
    s.lastOwn = ownJson;
  }

  // Deduped on its own key: on an own-ship-only move this is the ONLY source
  // that changes, so the big `tgt` source below skips.
  if (payload.cpa && payload.cpaData) {
    const cpaJson = JSON.stringify(payload.cpaData);
    if (cpaJson !== s.lastCpa) {
      payload.cpa.setData(payload.cpaData);
      s.lastCpa = cpaJson;
    }
  }

  const tgtJson = JSON.stringify(payload.tgtData);
  if (tgtJson !== s.lastTgt) {
    const now = s.clock();
    if (now - s.tgtFlushAt >= AIS_TARGET_THROTTLE_MS) {
      // Leading edge: enough time has passed, push now.
      payload.tgt.setData(payload.tgtData);
      s.lastTgt = tgtJson;
      s.tgtFlushAt = now;
    } else if (!s.tgtTrailing) {
      // Inside the window: arm ONE trailing flush at the boundary, re-running
      // the latest producer for whatever the freshest snapshot is by then.
      s.tgtTrailing = true;
      const wait = AIS_TARGET_THROTTLE_MS - (now - s.tgtFlushAt);
      s.timer(() => {
        s.tgtTrailing = false;
        flush(s);
      }, wait);
    }
  }

  payload.after?.();
}

/** Queue a scene push, coalesced to at most one build + push per frame,
 * deduped against the last-drawn collections, target source throttled per
 * `AIS_TARGET_THROTTLE_MS`. `produce` runs at most once per frame, on the
 * LATEST call's closure, so a superseded delta is never built.
 *
 * `scheduler`/`clock`/`timer` are injectable so tests can drive frames and
 * timing deterministically. */
export function scheduleScenePush(
  map: MLMap,
  produce: () => ScenePayload,
  scheduler: FrameScheduler = defaultScheduler,
  clock: Clock = defaultClock,
  timer: TimerScheduler = defaultTimer,
): void {
  let s = states.get(map);
  if (!s) {
    // -Infinity so the very first target push is always past the window.
    s = {
      scheduled: false,
      produce: null,
      tgtFlushAt: Number.NEGATIVE_INFINITY,
      tgtTrailing: false,
      clock,
      timer,
    };
    states.set(map, s);
  } else {
    // Production always passes the same defaults; tests re-inject theirs.
    s.clock = clock;
    s.timer = timer;
  }
  s.produce = produce;
  if (s.scheduled) return;
  s.scheduled = true;
  const state = s;
  scheduler(() => {
    state.scheduled = false;
    flush(state);
  });
}
