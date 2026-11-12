// The boot splash (index.html's #boot-splash): painted by the HTML itself on
// the first frame, taken down here once the chart is actually ready to
// navigate by — the catalog has arrived and MapLibre has drawn every visible
// tile (MapView's `onReady`). Before this the app opened onto a blank or
// half-drawn map that read as broken rather than loading.

import { createSignal } from "solid-js";

/** Hard cap on a boot that is merely slow: a stuck tile must never trap the
 * crew behind the splash, so past this the app shows as-is and keeps filling
 * in. A FAULT is exempt — dismissing one is exactly the blank, silent map this
 * file exists to prevent — and "Open anyway" is its way out instead. */
export const SPLASH_MAX_MS = 20_000;
const FADE_MS = 300;

let dismissed = false;
// The same fact as a signal, for UI that must wait for the splash to go
// (the o-charts registration prompt). `splashShowing` stays a plain read.
const [splashGone, setSplashGone] = createSignal(false);
/** Reactive: true once the splash has been dismissed. */
export { splashGone };
let faulted = false;

const el = (id: string) => (typeof document === "undefined" ? null : document.getElementById(id));

/** Replace the lines under the spinner: `text` says what boot is doing,
 * `detail` (optional, smaller) why it's taking a while — a server it can't
 * reach, a retry countdown, failing tiles. No-op once dismissed or headless. */
export function setSplashStatus(text: string, detail = ""): void {
  if (dismissed || faulted) return;
  writeStatus(text, detail);
}

function writeStatus(text: string, detail: string): void {
  // Callers report per render frame; only a CHANGE touches the DOM, so the
  // aria-live region announces each new state once, not 60 times a second.
  const status = el("boot-splash-status");
  if (status && status.textContent !== text) status.textContent = text;
  const sub = el("boot-splash-detail");
  if (sub && sub.textContent !== detail) {
    sub.textContent = detail;
    sub.hidden = detail === "";
  }
}

/** Boot has failed, not slowed: stop the progress bar, say what's wrong and
 * offer the way out. Holds past the cap until a dismissal: the map got ready
 * after all, or the crew chose "Open anyway". Call again freely: a countdown in `detail` re-renders, only changes touch the DOM.
 * `retry` is what "Try again" does; the crew's next look at the splash is its
 * feedback, so it needs no state of its own. */
export function setSplashFault(text: string, detail: string, retry: () => void): void {
  if (dismissed) return;
  faulted = true;
  writeStatus(text, detail);
  el("boot-splash")?.classList.add("boot-splash-fault");
  const again = el("boot-splash-retry");
  if (again) again.onclick = retry;
  const open = el("boot-splash-open");
  if (open) open.onclick = dismissSplash;
}

/** Whether the splash is still up — lets a ticker (a retry countdown) stop. */
export const splashShowing = (): boolean => !dismissed;

/** fetchCatalog's words for a 200 that wasn't JSON: not a thing an unreachable
 * server does. */
export const BAD_ANSWER = "not a JSON answer";

/** A failed boot fetch, in the crew's words. Takes the thrown value or just
 * its message (catalog.ts keeps only the string). Anything carrying an HTTP
 * status DID reach a server, which then failed; `fetch` itself rejects with a
 * TypeError when nothing answered at all, worded per-browser ("Failed to
 * fetch", "Load failed", "NetworkError…") — so with no status, unreachable
 * is the reading (a timed-out attempt included). A SyntaxError is a server that
 * answered with non-JSON. */
export function describeFetchError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (e instanceof SyntaxError || text.includes(BAD_ANSWER)) return "Server sent a bad answer";
  const status = /HTTP (\d{3})/.exec(text)?.[1];
  if (!status) return "Can't reach the server";
  // vite's dev proxy (and any reverse proxy) answers a dead backend itself.
  if (status === "502" || status === "504") return `Server not responding (HTTP ${status})`;
  if (status === "503") return "Server busy (HTTP 503)";
  return `Server error (HTTP ${status})`;
}

/** What to check, given `describeFetchError`'s reading — the question a boot
 * failure leaves is "is it me or the boat?". `online` is `navigator.onLine`,
 * which is only trustworthy when false. */
export function faultHint(e: unknown, online = true): string {
  const what = describeFetchError(e);
  if (what === "Can't reach the server") {
    return online
      ? "Are you on the boat's network? If so, check the server is running."
      : "This device has no network connection.";
  }
  if (what === "Server sent a bad answer") {
    return "Something else answered — you may be on the wrong network, or behind a login page.";
  }
  if (what.startsWith("Server busy")) return "It's up, but overloaded or still starting.";
  return "It's up, but failing — check the server's logs.";
}

/** Tiles seen for one source so far this boot. */
export interface TileTally {
  loaded: number;
  failed: number;
  /** HTTP status of the latest failure, when it had one. */
  status?: number;
}

/** The layers a plotter is useless without. Both come off the boat's own
 * server; seamarks, satellite and weather come from the internet, which the
 * boat often doesn't have, so those failing is no fault of boot's. */
const ESSENTIAL = ["charts", "basemap"];

function essentialTally(tally: Record<string, TileTally>): Record<string, TileTally> {
  const out: Record<string, TileTally> = {};
  for (const [id, t] of Object.entries(tally)) {
    const label = sourceLabel(id);
    if (!ESSENTIAL.includes(label)) continue;
    const sum = (out[label] ??= { loaded: 0, failed: 0 });
    sum.loaded += t.loaded;
    sum.failed += t.failed;
    sum.status = t.status ?? sum.status;
  }
  return out;
}

/** Why a map whose tiles have all settled is nonetheless not worth showing, or
 * undefined. MapLibre calls an errored tile "done", so "every source loaded" is
 * also what total failure looks like. Charts all failing is a fault even over
 * a good basemap, since a basemap is what makes missing charts look fine; a dead
 * basemap under working charts isn't. A failed tile among good ones isn't
 * either: that's a gap, and the chart it's in is still worth having. */
export function tileFault(tally: Record<string, TileTally>): { text: string; detail: string } | undefined {
  const { charts, basemap } = essentialTally(tally);
  const dead = [charts, basemap].filter((t) => t && t.failed > 0 && t.loaded === 0);
  const chartsDead = charts !== undefined && dead.includes(charts);
  if (!chartsDead && (dead.length === 0 || (charts?.loaded ?? 0) > 0)) return undefined;
  const names = [chartsDead && "charts", basemap && dead.includes(basemap) && "basemap"].filter(Boolean);
  const failed = dead.reduce((n, t) => n + t!.failed, 0);
  const status = dead.find((t) => t!.status)?.status;
  return {
    text: `Can't load the ${names.join(" or ")}`,
    detail: status
      ? `${failed} tile${failed === 1 ? "" : "s"} failed (HTTP ${status}). The server is up but didn't deliver them.`
      : `${failed} tile${failed === 1 ? "" : "s"} failed. Lost contact with the server.`,
  };
}

/** Essential tiles are wanted and none has arrived, after long enough to say so. */
export function tilesStalled(tally: Record<string, TileTally>, pendingSourceIds: string[]): boolean {
  const wanted = pendingSourceIds.some((id) => ESSENTIAL.includes(sourceLabel(id)));
  return wanted && Object.values(essentialTally(tally)).every((t) => t.loaded === 0);
}

/** Human name of a map source still loading, for "Drawing charts, basemap…".
 * Ids from core/style/chartStyle.ts and the feature overlays. */
export function sourceLabel(id: string): string {
  if (id.startsWith("chart-")) return "charts";
  if (id === "osm-world") return "basemap";
  if (id === "openseamap") return "seamarks";
  if (id.startsWith("poi")) return "places";
  if (id.includes("satellite")) return "satellite";
  if (id.includes("weather")) return "weather";
  return id;
}

/** "Drawing charts, basemap…" for the tiled sources not yet in, deduped
 * (many chart sets read as one "charts"). */
export function drawingStatus(pendingSourceIds: string[]): string {
  const labels = [...new Set(pendingSourceIds.map(sourceLabel))];
  return labels.length ? `Drawing ${labels.join(", ")}…` : "Drawing chart…";
}

/** Fade the splash out and remove it. Idempotent. */
export function dismissSplash(): void {
  if (dismissed) return;
  dismissed = true;
  setSplashGone(true);
  const splash = el("boot-splash");
  if (!splash) return;
  splash.classList.add("boot-splash-done");
  setTimeout(() => splash.remove(), FADE_MS);
}

/** The chrome tokens the splash is painted with (index.html's `--splash-*`). */
const SPLASH_TOKENS = ["chrome", "chrome-2", "fg", "fg-2", "line", "line-2", "accent", "shadow", "notice"] as const;
const SPLASH_COLORS_KEY = "mivnav.splashColors";

/** Cache the CURRENT palette's resolved chrome tokens so the next boot's
 * splash (painted before any CSS or JS loads) matches it. Call after the
 * palette has been applied to `:root`. */
export function rememberSplashColors(): void {
  if (typeof document === "undefined") return;
  try {
    const css = getComputedStyle(document.documentElement);
    const colors: Record<string, string> = {};
    for (const t of SPLASH_TOKENS) {
      const v = css.getPropertyValue(`--color-${t}`).trim();
      if (v) colors[t] = v;
    }
    const scheme = css.colorScheme.trim();
    if (scheme && scheme !== "normal") colors.scheme = scheme;
    localStorage.setItem(SPLASH_COLORS_KEY, JSON.stringify(colors));
  } catch {
    // Storage blocked/full: next boot just falls back to day colours.
  }
}

if (typeof window !== "undefined") {
  setTimeout(() => {
    if (!faulted) dismissSplash();
  }, SPLASH_MAX_MS);
}
