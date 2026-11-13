// This screen's o-charts device registration (backend:
// mivnav/features/ocharts/devices.py). At most five registered devices are
// served licensed (encrypted) chart sets; any other screen still gets every
// free chart and everything else — it draws `/tiles/free` instead of
// `/tiles/all` and leaves the licensed sets out of its style.
//
// The device's identity is an HttpOnly cookie the server sets, so nothing
// here stores it. What lives here: polling the status, the once-per-launch
// prompt (and its "don't show again"), and dropping cached o-charts tiles
// when this screen loses its slot.
//
// Also the o-charts licence's "no o-charts without a live connection" rule
// (docs/ocharts-licence-compliance-plan.md, W2): once this screen has lost
// the server for longer than DISCONNECT_GRACE_MS it draws `/tiles/free`, as
// an unregistered screen does. Licensed tiles are `no-store`, so MapLibre's
// RAM cache is their only copy; switching the union changes the `chart-all`
// source URL, and MapLibre's setStyle diff then removes that source and its
// tiles. The Service Worker's tile cache is deliberately NOT cleared here: it
// holds no licensed tiles (core/tileCache.ts refuses `no-store`, and never
// sees `/tiles/all`), only the free tiles this screen can still draw offline.

import { createSignal, untrack, type Accessor } from "solid-js";
import type { components } from "../api.generated";
import type { ChartSet } from "./catalog";
import { clearChartTileCache } from "./chartProtocol";

export type DeviceStatus = components["schemas"]["DeviceStatus"];
export type DeviceInfo = components["schemas"]["DeviceOut"];

const API = "/api/ocharts";

/** How often a screen re-asks whether it may still show o-charts — how long
 * a screen removed by another keeps drawing them, at most (while online). */
export const POLL_MS = 60_000;

/** How often the status is asked while the server looks lost, so that a
 * reconnect brings the o-charts back within seconds, not a minute. */
export const FAST_POLL_MS = 3_000;

/** How long the server may be lost before this screen stops showing o-charts
 * (decided 2026-11-13): long enough that a Wi-Fi blip does not blank the chart. */
export const DISCONNECT_GRACE_MS = 20_000;

/** A status poll that has not answered by now counts as failed — a hung
 * request must not stall the polling (and the grace clock) behind it. */
const POLL_TIMEOUT_MS = 10_000;

/** The controller's clock tick: evaluates the grace period and drives the polls. */
const TICK_MS = 1_000;

/** Answers that mean "the backend is not there" even though something (the
 * dev proxy, the Pi's reverse proxy) did answer. Anything else is contact. */
const BACKEND_DOWN = new Set([502, 503, 504]);

/** Is the server reachable, as far as the o-charts rule is concerned? False
 * once the backend websocket (`linkDownSince`, core/signalk.ts) has been down,
 * or the status poll has been failing (`pollFailedSince`), for longer than
 * the grace period. Pure. */
export function serverReachableAt(
  now: number,
  linkDownSince: number | null,
  pollFailedSince: number | null,
  graceMs: number = DISCONNECT_GRACE_MS,
): boolean {
  const lost = (since: number | null) => since !== null && now - since > graceMs;
  return !lost(linkDownSince) && !lost(pollFailedSince);
}

/** localStorage key for "Don't show again" on the registration prompt. */
export const HIDE_PROMPT_KEY = "mivnav.ochartsDevicePrompt.hidden";

/** Which o-charts union source the style draws. */
export type OchartsUnion = "all" | "free";

/** `/tiles/free` while a licensed set is installed and this screen may not
 * show it, or while the server is unreachable (see `serverReachableAt`);
 * `/tiles/all` otherwise — including before the first answer, so a
 * registered screen never flashes its charts away on boot. */
export function unionFor(status: DeviceStatus | undefined, reachable = true): OchartsUnion {
  if (!reachable) return "free";
  return status !== undefined && status.gate && !status.allowed ? "free" : "all";
}

/** The catalog this screen draws: without the licensed sets on `free`, so
 * their bounds/zooms don't shape a union source that cannot show them. */
export function drawableSets(sets: ChartSet[], union: OchartsUnion): ChartSet[] {
  return union === "free" ? sets.filter((s) => !s.licensed) : sets;
}

/** Open the full-screen prompt on its own? Once per launch, never after
 * "Don't show again", and only when there is something to register for. */
/** The EULAs still to accept, by id — the KEYS the prompt lists its frames
 * by. Each 60 s poll is a new status object; keyed by these strings the
 * frames survive it (keyed by object, every iframe reloaded and lost the
 * reader's scroll). */
export function pendingEulaIds(status: DeviceStatus | undefined): string[] {
  return (status?.eulas ?? []).filter((e) => !e.accepted).map((e) => e.id);
}

export function shouldPrompt(
  status: DeviceStatus | undefined,
  shownThisLaunch: boolean,
  hidden: boolean,
): boolean {
  return status !== undefined && status.gate && !status.allowed && !shownThisLaunch && !hidden;
}

/** A starting name for this screen, from what the browser says it is —
 * "iPad · Safari". Editable in the prompt; just enough to tell five apart.
 * `touch` disambiguates iPadOS, whose Safari claims to be a Mac. `standalone`
 * (an installed home-screen app) is named apart because on iOS it keeps its
 * own storage and so counts as a separate device from Safari. */
export function defaultDeviceName(ua: string, touch = false, standalone = false): string {
  let os = "Browser";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) os = "iPad";
  else if (/iPhone/.test(ua)) os = "iPhone";
  else if (/Android/.test(ua)) os = /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  else if (/CrOS/.test(ua)) os = "Chromebook";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "Mac";
  else if (/Linux/.test(ua)) os = "Linux";

  let browser = "";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = "Firefox";
  else if (/Chrome\/|CriOS\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";

  const name = browser ? `${os} · ${browser}` : os;
  return standalone ? `${name} app` : name;
}

/** "In use now" / "Last used 5 min ago" / "… 3 days ago", from the
 * server-computed age (`seen_ago_s`) — never the browser's clock against a
 * server timestamp. */
export function seenText(agoS: number): string {
  if (agoS < 120) return "In use now";
  const min = Math.floor(agoS / 60);
  if (min < 60) return `Last used ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `Last used ${h} h ago`;
  return `Last used ${Math.floor(h / 24)} days ago`;
}

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_PROMPT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(HIDE_PROMPT_KEY, "1");
    else localStorage.removeItem(HIDE_PROMPT_KEY);
  } catch {
    // private mode etc.: the prompt simply shows again next launch
  }
}

async function json<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body as T;
}

export interface OchartsDevice {
  /** The last answer; undefined until the first arrives. */
  status: Accessor<DeviceStatus | undefined>;
  union: Accessor<OchartsUnion>;
  /** False once the server has been lost for longer than the grace period;
   * the union is then `free` (see `serverReachableAt`). */
  serverReachable: Accessor<boolean>;
  /** The registration screen is up. */
  promptOpen: Accessor<boolean>;
  /** Show it (Settings' "Register this device"). */
  openPrompt: () => void;
  closePrompt: () => void;
  /** Close, and never open on its own again on this screen. */
  hidePromptForever: () => void;
  /** Undo `hidePromptForever` (Settings). */
  promptHidden: Accessor<boolean>;
  setPromptHidden: (hidden: boolean) => void;
  refresh: () => Promise<void>;
  list: () => Promise<DeviceInfo[]>;
  register: (name: string, accept: string[]) => Promise<void>;
  accept: (ids: string[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  /** Start polling (once); returns the stop function. `linkDownSince` is the
   * backend websocket's `SignalKState.linkDownSince`, the faster of the two
   * signs that the server is gone. */
  start: (linkDownSince?: Accessor<number | null>) => () => void;
}

export interface OchartsDeviceDeps {
  fetch?: typeof fetch;
  /** Drops cached o-charts tiles when this screen loses its slot. */
  clearTiles?: () => void;
  /** Clock and tick timer — seams a test drives. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function createOchartsDevice(deps: OchartsDeviceDeps = {}): OchartsDevice {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const clearTiles = deps.clearTiles ?? clearChartTileCache;
  const clock = deps.now ?? (() => Date.now());
  const setTimer = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const [status, setStatus] = createSignal<DeviceStatus | undefined>(undefined);
  const [serverReachable, setServerReachable] = createSignal(true);
  let linkDownSince: Accessor<number | null> = () => null;
  let pollFailedSince: number | null = null;
  let lastPollAt = -Infinity;
  let polling = false;

  // Lost the server past the grace period: stop drawing o-charts (the union
  // flips to `free`, see the header). Back on contact.
  const evaluate = () => {
    setServerReachable(serverReachableAt(clock(), untrack(linkDownSince), pollFailedSince));
  };
  const [promptOpen, setPromptOpen] = createSignal(false);
  const [promptHidden, setHiddenSignal] = createSignal(readHidden());
  let shownThisLaunch = false;

  const apply = (next: DeviceStatus) => {
    const prev = status();
    // Lost the right to show o-charts while running, or found out at boot
    // that another screen removed this one: drop the tiles already cached
    // here. Offline, nothing can be done until it next reaches the boat.
    const lost = prev !== undefined && unionFor(prev) === "all" && unionFor(next) === "free";
    if (lost || next.removed) clearTiles();
    setStatus(next);
    if (shouldPrompt(next, shownThisLaunch, promptHidden())) {
      shownThisLaunch = true;
      setPromptOpen(true);
    }
  };

  const refresh = async () => {
    lastPollAt = clock();
    polling = true;
    try {
      const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(POLL_TIMEOUT_MS) : undefined;
      const res = await doFetch(`${API}/devices/me`, { signal });
      if (BACKEND_DOWN.has(res.status)) throw new Error(`HTTP ${res.status}`);
      pollFailedSince = null;
      const body = (await res.json().catch(() => null)) as DeviceStatus | null;
      if (res.ok && body) apply(body);
    } catch {
      // Server unreachable: keep the last answer, the next poll retries —
      // and past the grace period, stop showing o-charts (`evaluate`).
      pollFailedSince ??= clock();
    } finally {
      polling = false;
    }
    evaluate();
  };

  // Every second: is the server still there, and is a poll due? Every 60 s
  // normally, every few seconds while the server looks lost.
  const tick = () => {
    const degraded = untrack(linkDownSince) !== null || pollFailedSince !== null || !untrack(serverReachable);
    if (!polling && clock() - lastPollAt >= (degraded ? FAST_POLL_MS : POLL_MS)) void refresh();
    evaluate();
  };

  const send = (url: string, method: string, body?: unknown) =>
    json<unknown>(doFetch, url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let started = false;
  return {
    status,
    union: () => unionFor(status(), serverReachable()),
    serverReachable,
    promptOpen,
    openPrompt: () => {
      shownThisLaunch = true;
      setPromptOpen(true);
    },
    closePrompt: () => setPromptOpen(false),
    hidePromptForever: () => {
      writeHidden(true);
      setHiddenSignal(true);
      setPromptOpen(false);
    },
    promptHidden,
    setPromptHidden: (hidden) => {
      writeHidden(hidden);
      setHiddenSignal(hidden);
    },
    refresh,
    list: () => json<DeviceInfo[]>(doFetch, `${API}/devices`),
    register: async (name, accept) => {
      apply((await send(`${API}/devices`, "POST", { name, accept })) as DeviceStatus);
    },
    accept: async (ids) => {
      apply((await send(`${API}/devices/me/accept`, "POST", { accept: ids })) as DeviceStatus);
    },
    remove: async (id) => {
      await send(`${API}/devices/${encodeURIComponent(id)}`, "DELETE");
      await refresh();
    },
    rename: async (id, name) => {
      await send(`${API}/devices/${encodeURIComponent(id)}`, "PATCH", { name });
      await refresh();
    },
    start: (link) => {
      if (started) return () => {};
      started = true;
      if (link) linkDownSince = link;
      void refresh();
      const timer = setTimer(tick, TICK_MS);
      const onVisible = () => {
        if (document.visibilityState === "visible") void refresh();
      };
      const doc = typeof document === "undefined" ? undefined : document;
      doc?.addEventListener("visibilitychange", onVisible);
      return () => {
        started = false;
        clearTimer(timer);
        doc?.removeEventListener("visibilitychange", onVisible);
      };
    },
  };
}

/** The app's one instance: the shell starts it, the prompt and the Settings
 * section read it. */
export const ochartsDevice = createOchartsDevice();
