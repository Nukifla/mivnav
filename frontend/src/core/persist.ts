// localStorage-backed signals for this device's preferences. Per-device,
// deliberately: facts about the *boat* (SignalK location, installed charts)
// belong to the always-on server instead, via serverConfig.ts.

import { createEffect, createSignal, type Accessor, type Setter } from "solid-js";

const PREFIX = "mivnav.";

/** Whether a value was ever persisted for `key`. Read once at boot, before
 * `deviceSetting` writes its default back, to tell a fresh device apart
 * from a returning one. */
export function hasStored(key: string): boolean {
  try {
    return localStorage.getItem(PREFIX + key) !== null;
  } catch {
    return false;
  }
}

export interface DeviceSettingOptions<T> {
  /** Turn stored JSON (or `undefined`, if missing/corrupt/migrate threw) into
   * a valid `T`, field by field. MUST be total — not wrapped in a `try` on
   * the happy path, so a throw here takes the app down with it. */
  coerce: (raw: unknown) => T;
  /** Bump ONLY for a structural change `coerce` can't express alone (a
   * renamed/relocated field) — adding a field is already handled by `coerce`.
   * Defaults to 0 (unversioned); the sidecar is written only when > 0. */
  version?: number;
  /** Reshape a payload from an older `version` before `coerce` sees it. A
   * throw is swallowed and falls back to `coerce(undefined)` — a migration
   * bug degrades to defaults, it doesn't brick the plotter. */
  migrate?: (raw: unknown, from: number) => unknown;
}

/**
 * A `createSignal` whose value is loaded from localStorage, coerced into a
 * valid `T`, and written back on every change. Signature matches
 * `createSignal<T>` on purpose so consumers keep working untouched.
 */
export function deviceSetting<T>(
  key: string,
  { coerce, version = 0, migrate }: DeviceSettingOptions<T>,
): [Accessor<T>, Setter<T>] {
  const storageKey = PREFIX + key;
  const versionKey = `${storageKey}.v`;

  let initial: T;
  try {
    const text = localStorage.getItem(storageKey);
    let raw: unknown = undefined;
    if (text !== null) {
      raw = JSON.parse(text) as unknown;
      if (migrate) {
        const from = Number(localStorage.getItem(versionKey)) || 0;
        if (from < version) raw = migrate(raw, from);
      }
    }
    initial = coerce(raw);
  } catch {
    // Corrupt blob falls back to the same defaults path a fresh device takes.
    initial = coerce(undefined);
  }

  const [get, set] = createSignal<T>(initial);
  createEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(get()));
      if (version > 0) localStorage.setItem(versionKey, String(version));
    } catch {
      // storage full or unavailable: the in-memory value still works
    }
  });
  return [get, set];
}

// Small, total field-coercers shared by the simple device keys, tested
// directly (persist.test.ts). Complex keys bring their own: `settings` reuses
// `settingsFromProfile` (profiles.ts), `chrome` reuses `bootChrome` (chrome/boot.ts).

export function coerceBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** A stored FINITE number, or `fallback` — `null`/`NaN`/`"12"` all fall back.
 * `Number.isFinite` is the floor of trust: a `jumpTo({ zoom: null })` is a
 * black screen, so a non-number on the way in becomes the default, not a crash. */
export function coerceFiniteNumber(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/** A stored array narrowed to its string members; anything else is `[]`. One
 * bad entry is dropped, not fatal — the surviving ids still disable their sets. */
export function coerceStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}
