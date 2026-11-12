// Chart catalog client — GET /api/catalog. Retries with backoff rather than
// failing once silently: a blank map is otherwise indistinguishable from "no
// charts installed". See docs/architecture/chart-catalog-client.md.

import { batch, createSignal, onCleanup, type Accessor } from "solid-js";
import { BAD_ANSWER } from "./splash";

/** TileJSON-style vector layer descriptor, from the PMTiles metadata. */
export interface VectorLayer {
  /** MVT layer name: an S-57 object class acronym, or `_nodata`. */
  id: string;
  minzoom: number;
  maxzoom: number;
  fields: Record<string, string>;
}

/** Which serving path a set is behind (#snyzntrn). Optional/absent on older
 * fixtures, treated as `"pmtiles"`. See docs/architecture/chart-catalog-client.md. */
export type ChartSetKind = "pmtiles" | "ocharts";

export interface ChartSet {
  id: string;
  name: string;
  /** [west, south, east, north] in degrees. */
  bounds: [number, number, number, number];
  min_zoom: number;
  max_zoom: number;
  sequence: number;
  /** Origin-relative tile URL template, without the /api prefix. */
  tiles: string;
  /** Every MVT layer present in the set — the style generator's input. */
  vector_layers: VectorLayer[];
  /** See {@link ChartSetKind}. */
  kind?: ChartSetKind;
  /** An o-charts set of encrypted cells: drawn only on a registered device
   * (core/ochartsDevice.ts). Absent on PMTiles sets and older servers. */
  licensed?: boolean;
}

/** How long one attempt waits, doubling per retry up to the cap. On the wrong
 * network packets to the boat are dropped, not refused: `fetch` neither answers
 * nor rejects for a minute or more, so without this a hang reports nothing at
 * all. Short enough to say so quickly; growing, so a Pi that really does need
 * longer gets it instead of being cut off at the same point on every attempt. */
export const ATTEMPT_TIMEOUT_MS = 6_000;
export const ATTEMPT_TIMEOUT_MAX_MS = 30_000;

export const attemptTimeout = (attempt: number): number =>
  Math.min(ATTEMPT_TIMEOUT_MAX_MS, ATTEMPT_TIMEOUT_MS * 2 ** attempt);

export async function fetchCatalog(timeoutMs = ATTEMPT_TIMEOUT_MS): Promise<ChartSet[]> {
  try {
    const res = await fetch("/api/catalog", { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
    const body = (await res.json()) as { sets: ChartSet[] };
    return body.sets;
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`catalog: no answer in ${timeoutMs / 1000} s`);
    }
    // Only the message survives into `error` — keep the "answered with
    // something that isn't JSON" reading (splash.ts `describeFetchError`).
    if (e instanceof SyntaxError) throw new Error(`catalog: ${BAD_ANSWER}`);
    throw e;
  }
}

/** The boot prefetch's answer, until `createCatalog` adopts it. */
let prefetched: ChartSet[] | undefined;
/** Its failure, likewise: adopted as the starting `error`, so the first
 * retry runs as a retry — not as a fresh "loading" that reads as if the
 * failure the boot splash just reported had gone away. */
let prefetchError = "";
/** The prefetch while it's still out. A hung server outlasts the theme gate,
 * so `createCatalog` can start before it settles; it adopts this rather than
 * asking again, or the verdict would arrive a gate's length late. */
let prefetchInFlight: Promise<ChartSet[]> | undefined;

/**
 * Boot: fetch the catalog BEFORE first render (index.tsx runs it alongside the
 * theme gate), so MapView constructs the map with its charts already in the
 * style rather than diffing them in after `load` — which froze the main
 * thread ~3 s (see MapView's onMount). A failure is swallowed: `createCatalog`'s
 * own loop then fetches, retries and reports as it always has. Resolves to
 * that swallowed error (undefined on success) so the boot splash can say
 * what went wrong while the gate is still up.
 */
export async function prefetchCatalog(): Promise<unknown> {
  const attempt = fetchCatalog();
  prefetchInFlight = attempt;
  // Not adopted while out: createCatalog is awaiting `attempt` itself.
  const unclaimed = () => prefetchInFlight === attempt;
  try {
    const sets = await attempt;
    if (unclaimed()) {
      prefetched = sets;
      prefetchError = "";
    }
    return undefined;
  } catch (e) {
    // createCatalog retries and surfaces the error.
    if (unclaimed()) prefetchError = message(e);
    return e ?? new Error("catalog failed");
  } finally {
    if (unclaimed()) prefetchInFlight = undefined;
  }
}

// Same shape as signalk.ts's reconnect: our own backend on this host fails
// for seconds, not minutes — fast enough a warm-up is invisible, capped so
// a fixed server isn't waited on long.
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

export interface CatalogController {
  /** The last catalog that arrived. Empty until one does. */
  sets: Accessor<ChartSet[]>;
  /** Non-empty when the last attempt failed — the whole difference between
   * "the charts failed to load" and "there are no charts here" (both are
   * `sets() === []`). Retries continue while set: "not arrived yet". */
  error: Accessor<string>;
  /** An attempt is in flight (the first one, or a retry). */
  loading: Accessor<boolean>;
  /** When the next retry fires (epoch ms) while one is scheduled after a
   * failure — the boot splash's countdown. Undefined otherwise. */
  nextRetryAt: Accessor<number | undefined>;
  /** Fetch now: the mariner's Retry, and what a finished install calls.
   * Replaces the running loop rather than starting a second one. */
  refresh: () => void;
}

export interface CatalogOptions {
  /** The fetcher — the seam a test drives. Given this attempt's timeout. */
  fetch?: (timeoutMs: number) => Promise<ChartSet[]>;
  /** The clock the backoff sleeps on. Injected so tests assert the
   * schedule instead of waiting out 30 real seconds. */
  delay?: (ms: number) => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createCatalog(options: CatalogOptions = {}): CatalogController {
  const load = options.fetch ?? fetchCatalog;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Adopt the boot prefetch (real fetcher only — a test's injected fetch
  // never sees module state), once: it is milliseconds old.
  const initial = options.fetch ? undefined : prefetched;
  const initialError = options.fetch ? "" : prefetchError;
  let adopted = options.fetch ? undefined : prefetchInFlight;
  prefetched = undefined;
  prefetchError = "";
  prefetchInFlight = undefined;

  const [sets, setSets] = createSignal<ChartSet[]>(initial ?? []);
  const [error, setError] = createSignal(initialError);
  const [loading, setLoading] = createSignal(initial === undefined);
  const [nextRetryAt, setNextRetryAt] = createSignal<number | undefined>(undefined);

  // Invalidates a superseded loop's writes (as signalk.ts's reconnect does):
  // `refresh`/cleanup bump it, every await in `run` checks it.
  let generation = 0;

  const run = async () => {
    const gen = ++generation;
    for (let attempt = 0; ; attempt++) {
      batch(() => {
        setLoading(true);
        setNextRetryAt(undefined);
      });
      try {
        const next = await (adopted ?? load(attemptTimeout(attempt)));
        adopted = undefined;
        if (gen !== generation) return;
        batch(() => {
          setSets(next);
          setError("");
          setLoading(false);
        });
        return;
      } catch (e) {
        adopted = undefined;
        if (gen !== generation) return;
        // `sets` is deliberately left alone: a catalog we already have is
        // stale, not wrong, and blanking the plotter because a *refresh*
        // failed would be this file's own bug, inverted.
        batch(() => {
          setError(message(e));
          setLoading(false);
        });
      }
      const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt);
      setNextRetryAt(Date.now() + wait);
      await delay(wait);
      if (gen !== generation) return;
    }
  };

  if (initial === undefined) void run();
  // A closed tab must stop asking the boat's server for a catalog.
  onCleanup(() => generation++);

  return { sets, error, loading, nextRetryAt, refresh: () => void run() };
}
