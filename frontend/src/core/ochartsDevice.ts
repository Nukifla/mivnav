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

import { createSignal, type Accessor } from "solid-js";
import type { components } from "../api.generated";
import type { ChartSet } from "./catalog";
import { clearChartTileCache } from "./chartProtocol";

export type DeviceStatus = components["schemas"]["DeviceStatus"];
export type DeviceInfo = components["schemas"]["DeviceOut"];

const API = "/api/ocharts";

/** How often a screen re-asks whether it may still show o-charts — how long
 * a screen removed by another keeps drawing them, at most (while online). */
export const POLL_MS = 60_000;

/** localStorage key for "Don't show again" on the registration prompt. */
export const HIDE_PROMPT_KEY = "mivnav.ochartsDevicePrompt.hidden";

/** Which o-charts union source the style draws. */
export type OchartsUnion = "all" | "free";

/** `/tiles/free` while a licensed set is installed and this screen may not
 * show it; `/tiles/all` otherwise — including before the first answer, so a
 * registered screen never flashes its charts away on boot. */
export function unionFor(status: DeviceStatus | undefined): OchartsUnion {
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
  /** Start polling (once); returns the stop function. */
  start: () => () => void;
}

export interface OchartsDeviceDeps {
  fetch?: typeof fetch;
  /** Drops cached o-charts tiles when this screen loses its slot. */
  clearTiles?: () => void;
}

export function createOchartsDevice(deps: OchartsDeviceDeps = {}): OchartsDevice {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const clearTiles = deps.clearTiles ?? clearChartTileCache;
  const [status, setStatus] = createSignal<DeviceStatus | undefined>(undefined);
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
    try {
      apply(await json<DeviceStatus>(doFetch, `${API}/devices/me`));
    } catch {
      // Server unreachable: keep the last answer, the next poll retries.
    }
  };

  const send = (url: string, method: string, body?: unknown) =>
    json<unknown>(doFetch, url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let started = false;
  return {
    status,
    union: () => unionFor(status()),
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
    start: () => {
      if (started) return () => {};
      started = true;
      void refresh();
      const timer = setInterval(() => void refresh(), POLL_MS);
      const onVisible = () => {
        if (document.visibilityState === "visible") void refresh();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        started = false;
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
  };
}

/** The app's one instance: the shell starts it, the prompt and the Settings
 * section read it. */
export const ochartsDevice = createOchartsDevice();
