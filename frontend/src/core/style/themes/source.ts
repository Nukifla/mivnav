// Themes come from `GET /api/themes` (backend JSON files), with
// `./bundled.generated.ts` as fallback, not cache. Two change-notification
// mechanisms for two consumer kinds — see docs/architecture/theme-runtime-source.md.

import { createSignal } from "solid-js";
import { BUNDLED_THEMES } from "./bundled.generated";
import { resolveTheme } from "./derivedIcons";
import type { AuthoredThemeDef, ThemeDef } from "./types";

/** The bundle resolved — icon roles filled in from each theme's own S-52
 * table (`./derivedIcons.ts`). The one seam where JSON-on-disk becomes a
 * `ThemeDef`; both the bundled fallback and `/api/themes` go through it. */
const RESOLVED_BUNDLE: readonly ThemeDef[] = BUNDLED_THEMES.map(resolveTheme);

let current: readonly ThemeDef[] = RESOLVED_BUNDLE;

const listeners = new Set<() => void>();
const [version, setVersion] = createSignal(0);

/** The theme set as it stands, non-reactively. */
export function themeList(): readonly ThemeDef[] {
  return current;
}

/** Read the theme-set version inside a reactive computation, so it re-runs
 * when the set is replaced. Returns nothing useful on purpose — the value is
 * a tick counter, not data. */
export function trackThemes(): void {
  version();
}

/** Register a plain (non-reactive) callback, run after every replacement.
 * Returns an unsubscribe, which nothing in the app uses — the one subscriber
 * lives as long as the module graph — but tests do. */
export function onThemesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Keys a theme must carry. Optional knobs (rasterDim, basemapTint, etc.)
 * are deliberately excluded: absent is itself a real value —
 * `chartStyle.ts`'s `rasterPaint` must diff to no keys for a bright theme. */
const REQUIRED = ["id", "label", "canvas", "s52", "icons", "routeOverlay", "overlay", "poi", "basemap", "chrome"] as const;

function isUsable(t: unknown): t is AuthoredThemeDef {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return false;
  return REQUIRED.every((k) => o[k] !== undefined && o[k] !== null);
}

/** Replace the theme set, all-or-nothing: an invalid/empty payload is
 * rejected and the previous set stays — a partial merge (theme half JSON,
 * half bundle) would be worse. Returns whether it took. */
export function setThemes(payload: unknown): boolean {
  if (!Array.isArray(payload) || payload.length === 0) return false;
  if (!payload.every(isUsable)) return false;
  current = payload.map(resolveTheme);
  for (const cb of listeners) cb();
  setVersion((v) => v + 1);
  return true;
}

/** Put the bundled set back — for tests, so one that installs a theme set
 * cannot leak it into the next file in the same bun process. */
export function resetThemes(): void {
  current = RESOLVED_BUNDLE;
  for (const cb of listeners) cb();
  setVersion((v) => v + 1);
}

export const THEMES_URL = "/api/themes";

/** Fetch and install the live theme set. Never throws — an unreachable or
 * misbehaving backend leaves the bundled themes in place and the app
 * usable. Returns whether the live set was installed. */
export async function loadThemes(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(THEMES_URL);
    if (!res.ok) return false;
    return setThemes(await res.json());
  } catch {
    return false;
  }
}
