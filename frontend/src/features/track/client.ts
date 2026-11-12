// Ship-track client: the boat's past track from `/api/track`, polled while the
// overlay is on. A 501 means this box has no history provider (permanent) and
// latches off polling. See docs/architecture/track-client.md.

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

/** `[lon, lat]` — GeoJSON axis order, exactly as the backend sends it, so a
 * response drops straight into a LineString with no per-point rewrite of a
 * list that can run to thousands of entries. */
export type TrackCoordinate = [number, number];

export interface Track {
  /** Separate lines: the server ends one wherever the record has a hole, so
   * nothing is drawn across water the boat was not seen in. */
  lines: TrackCoordinate[][];
  /** The last 24 h (the server's `RECENT_HOURS`), drawn prominently; `lines`
   * is everything older, drawn subdued. The two meet at a shared fix. */
  recent: TrackCoordinate[][];
  /** The server's own account of the range it answered with — a history
   * plugin is free to clamp the window to what it actually holds. */
  from: string | null;
  to: string | null;
  /** When the newest fix drawn was taken (history's clock). `to - last` is
   * how far history trails now — what `./live` trims its tail by. */
  last: string | null;
  /** False while the server is still fetching past days (a long window on
   * a fresh box fills in over several requests): ask again soon. */
  complete: boolean;
}

/** The `trackHours` value meaning "everything the history plugin holds".
 * A number, not `Infinity`, because settings round-trip through JSON. */
export const TRACK_ALL = 0;

/** Thrown for a 501: this boat keeps no history. Its own class because the
 * caller reacts to it differently from every other failure — it stops. */
export class TrackUnsupported extends Error {}

const EMPTY: Track = { lines: [], recent: [], from: null, to: null, last: null, complete: true };

/** How often to re-ask while the overlay is on. Matches the backend's own
 * `POLL_INTERVAL_S`, which is what its `/providers` descriptor reports as
 * this source's staleness clock. */
export const POLL_MS = 60_000;

/** How soon to ask again while the server is still filling in past days. */
export const FILL_MS = 1_000;

export async function fetchTrack(hours: number): Promise<Track> {
  const query = hours === TRACK_ALL ? "all=true" : `hours=${encodeURIComponent(hours)}`;
  const res = await fetch(`/api/track?${query}`);
  if (res.status === 501) throw new TrackUnsupported("this boat keeps no position history");
  if (!res.ok) throw new Error(`track fetch failed: ${res.status}`);
  const body = (await res.json()) as Partial<Track>;
  return {
    lines: Array.isArray(body.lines) ? (body.lines as TrackCoordinate[][]) : [],
    recent: Array.isArray(body.recent) ? (body.recent as TrackCoordinate[][]) : [],
    from: typeof body.from === "string" ? body.from : null,
    to: typeof body.to === "string" ? body.to : null,
    last: typeof body.last === "string" ? body.last : null,
    complete: body.complete !== false,
  };
}

export interface TrackClientOptions {
  /** Test seam; the app uses the real `/api/track` fetch. */
  fetch?: (hours: number) => Promise<Track>;
  /** Poll period override, for tests that must not wait a minute. */
  pollMs?: number;
}

export interface TrackClientDeps extends TrackClientOptions {
  /** Whether the overlay is on — gates the first fetch and the poll. */
  enabled: Accessor<boolean>;
  /** How far back to ask for. A change refetches immediately. */
  hours: Accessor<number>;
}

export interface TrackClient {
  track: Accessor<Track>;
  /** False once the server has said 501. Drives the Layers row's `enabled`,
   * so the control greys out instead of lying about a track that cannot
   * exist on this boat. */
  supported: Accessor<boolean>;
  refetch: () => void;
}

/** The live track: fetched when the overlay turns on or the window changes,
 * then re-polled while it stays on — soon (`FILL_MS`) while the answer is
 * still incomplete, every `pollMs` once it is whole. */
export function createTrackClient(deps: TrackClientDeps): TrackClient {
  const load = deps.fetch ?? fetchTrack;
  const period = deps.pollMs ?? POLL_MS;
  const [track, setTrack] = createSignal<Track>(EMPTY);
  const [supported, setSupported] = createSignal(true);
  let live = true;
  onCleanup(() => {
    live = false;
  });

  // Bumped by every effect run, so a response or timer from a previous window
  // (or a previous on/off cycle) cannot schedule into the current one.
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    if (!deps.enabled() || !supported()) return;
    const gen = generation;
    clearTimeout(timer);
    void load(deps.hours())
      .then((next) => {
        if (!live || gen !== generation) return;
        setTrack(next);
        timer = setTimeout(run, next.complete ? period : Math.min(FILL_MS, period));
      })
      .catch((e: unknown) => {
        if (!live || gen !== generation) return;
        if (e instanceof TrackUnsupported) setSupported(false);
        // Otherwise the box may come back: keep asking at the floor rate.
        else timer = setTimeout(run, period);
      });
  };

  createEffect(() => {
    // Tracked: both gates. Turning the overlay off drops the poll; a new
    // window refetches at once rather than after a poll period of the old one.
    const on = deps.enabled() && supported();
    deps.hours();
    generation++;
    clearTimeout(timer);
    if (!on) {
      // Off means off: drop what was drawn so re-enabling never flashes a
      // track from an hour ago before the fresh one lands.
      setTrack(EMPTY);
      return;
    }
    run();
  });
  onCleanup(() => clearTimeout(timer));

  return { track, supported, refetch: run };
}
