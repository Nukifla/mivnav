// Notices client: the backend's Niord snapshot (efs.md §6), polled while the
// overlay is on. The status endpoint is tiny and polled; the ~200 KB map
// GeoJSON is fetched only when
// the snapshot `version` moves. INERT when off: no status poll, no clock.
//
// Also the shared STORE for the rest of the feature — the info provider and
// the list panel (tasks 5/6) read `status`/`data` from here and fetch details
// with `fetchNoticeDetail`/`fetchNoticesList` below, so nothing polls twice.

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { NoticeDetail, NoticesList, NoticesMap, NoticesStatus } from "./types";

export const NOTICES_API = "/api/notices";

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T | undefined> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** `GET /notices/status`; `undefined` on any failure (backend down, route
 * not there yet) — the caller keeps polling at the slow rate. */
export const fetchNoticesStatus = (fetchImpl: typeof fetch = fetch): Promise<NoticesStatus | undefined> =>
  getJson<NoticesStatus>(`${NOTICES_API}/status`, fetchImpl);

/** `GET /notices/map.geojson`. `version` rides as a cache-buster so a Service
 * Worker or HTTP cache can never hand back the previous snapshot. */
export const fetchNoticesMap = (
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NoticesMap | undefined> =>
  getJson<NoticesMap>(`${NOTICES_API}/map.geojson?v=${encodeURIComponent(version)}`, fetchImpl);

/** `GET /notices/list` — for the list panel (task 6). */
export const fetchNoticesList = (fetchImpl: typeof fetch = fetch): Promise<NoticesList | undefined> =>
  getJson<NoticesList>(`${NOTICES_API}/list`, fetchImpl);

/** `GET /notices/{id}` (uuid or shortId) — for the info panel (task 5). */
export const fetchNoticeDetail = (id: string, fetchImpl: typeof fetch = fetch): Promise<NoticeDetail | undefined> =>
  getJson<NoticeDetail>(`${NOTICES_API}/${encodeURIComponent(id)}`, fetchImpl);

/** `POST /notices/refresh` — force a pull; answers with the status object. */
export async function postNoticesRefresh(fetchImpl: typeof fetch = fetch): Promise<NoticesStatus | undefined> {
  try {
    const res = await fetchImpl(`${NOTICES_API}/refresh`, { method: "POST" });
    return res.ok ? ((await res.json()) as NoticesStatus) : undefined;
  } catch {
    return undefined;
  }
}

/** How soon to ask again: fast while the backend pulls (so notices appear
 * seconds after they land), a little slower before the first pull is kicked,
 * slow once settled — a snapshot only moves every `refresh_s` (30 min). */
export function nextPollMs(state: NoticesStatus["state"] | undefined): number {
  switch (state) {
    case "loading":
      return 2_000;
    case "idle":
      return 10_000;
    default:
      return 60_000;
  }
}

/** The time-state clock's period: notices start and end on the minute. */
export const CLOCK_MS = 60_000;

export interface NoticesClientDeps {
  /** Whether the overlay is on — gates polling AND the clock. */
  enabled: Accessor<boolean>;
  /** Status seam (tests). Defaults to {@link fetchNoticesStatus}. */
  fetchStatus?: () => Promise<NoticesStatus | undefined>;
  /** Map seam (tests). Defaults to {@link fetchNoticesMap}. */
  fetchMap?: (version: string) => Promise<NoticesMap | undefined>;
  /** Timer seam (tests): schedule `fn` in `ms`, return a canceller. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Clock seam (tests). */
  now?: () => number;
}

export interface NoticesClient {
  /** Last status heard; `undefined` while off or before the first answer. */
  status: Accessor<NoticesStatus | undefined>;
  /** The map FeatureCollection of the newest snapshot fetched, or null. Kept
   * across an off/on cycle (re-enabling paints at once; the poll then
   * replaces it if the version moved). */
  data: Accessor<NoticesMap | null>;
  /** The snapshot version `data` came from. */
  version: Accessor<string | null>;
  /** The time-state clock: ticks on each minute boundary while enabled. */
  now: Accessor<number>;
  /** Poll now (e.g. after `postNoticesRefresh`). No-op while off. */
  poll: () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/** Must be created under a reactive owner (the feature factory, from App). */
export function createNoticesClient(deps: NoticesClientDeps): NoticesClient {
  const fetchStatus = deps.fetchStatus ?? (() => fetchNoticesStatus());
  const fetchMap = deps.fetchMap ?? ((v: string) => fetchNoticesMap(v));
  const schedule = deps.schedule ?? defaultSchedule;
  const clock = deps.now ?? Date.now;

  const [status, setStatus] = createSignal<NoticesStatus>();
  const [data, setData] = createSignal<NoticesMap | null>(null);
  const [version, setVersion] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(clock());

  // Bumped on every on/off edge, so an answer or timer from a previous cycle
  // can never schedule into (or write over) the current one.
  let generation = 0;
  let cancelPoll: (() => void) | undefined;
  let cancelTick: (() => void) | undefined;
  /** The version a map fetch is in flight for — one at a time. */
  let fetching: string | null = null;

  const loadMap = (v: string, gen: number) => {
    if (fetching === v) return;
    fetching = v;
    void fetchMap(v).then((fc) => {
      if (fetching === v) fetching = null;
      if (gen !== generation || !fc) return; // failed: the next poll retries
      setData(fc);
      setVersion(v);
    });
  };

  /** A status request is in flight — `poll()` from outside must not start a
   * second loop beside the scheduled one. */
  let inflight = false;

  const poll = () => {
    const gen = generation;
    if (!deps.enabled() || inflight) return;
    cancelPoll?.();
    cancelPoll = undefined;
    inflight = true;
    void fetchStatus().then((st) => {
      if (gen !== generation) return;
      inflight = false;
      if (st) {
        setStatus(st);
        if (st.version && st.version !== version()) loadMap(st.version, gen);
      }
      cancelPoll = schedule(poll, nextPollMs(st?.state));
    });
  };

  const tick = () => {
    const t = clock();
    setNow(t);
    // Land on the next minute boundary rather than drifting off it.
    cancelTick = schedule(tick, CLOCK_MS - (t % CLOCK_MS) || CLOCK_MS);
  };

  const stop = () => {
    cancelPoll?.();
    cancelTick?.();
    cancelPoll = cancelTick = undefined;
  };

  createEffect(() => {
    const on = deps.enabled();
    generation++;
    inflight = false;
    stop();
    if (!on) {
      setStatus(undefined);
      return;
    }
    tick();
    poll();
  });
  onCleanup(() => {
    generation++;
    stop();
  });

  return { status, data, version, now, poll };
}
