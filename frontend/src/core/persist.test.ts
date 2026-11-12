/**
 * `deviceSetting`, the typed per-device store hook, and the field-by-field
 * robustness that is its whole reason to exist.
 *
 * A stored blob outlives the client that wrote it — an older release, another
 * device, a hand edit over ssh — so every device key must survive malformed,
 * partial and old-version JSON and still hand a consumer a VALID value, never a
 * crash and never an `undefined` where a `windUnit` was promised. These feed each
 * of the five real device keys their worst input, through the actual coercer each
 * uses in App.tsx / initialView.ts, and assert it lands somewhere sane.
 *
 * NB: needs `--conditions=browser` (see the `test` script) — bare `bun test`
 * resolves solid-js's SSR build, whose createEffect never runs, so the
 * write-back assertions would pass vacuously.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  coerceBoolean,
  coerceFiniteNumber,
  coerceStringArray,
  deviceSetting,
  hasStored,
  type DeviceSettingOptions,
} from "./persist";
import { settingsFromProfile } from "./profiles";
import { DEFAULT_SETTINGS } from "./style/settings";
import { bootChrome, seedDefaults } from "./chrome/boot";
import { BAND_IDS } from "./chrome/bands";
import { type ChromeConfig } from "./chrome/config";
import {
  createRegistry,
  defineFeature,
  DEFAULT_DENSITY,
  type Instrument,
  type Registry,
} from "./chrome/registry";
import { DEFAULT_ZOOM } from "./initialView";

/** bun has no localStorage (initialView.test.ts explains why one is installed
 * per test and torn down: bun shares one globalThis across the whole run). */
class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** Construct the store, read its value once, dispose. The load/coerce path runs
 * synchronously in the constructor, so the value is available immediately. */
function load<T>(key: string, opts: DeviceSettingOptions<T>): T {
  let value!: T;
  const dispose = createRoot((d) => {
    const [get] = deviceSetting(key, opts);
    value = get();
    return d;
  });
  dispose();
  return value;
}

/** Solid queues its effects; a microtask flush lets the write-back run before
 * we inspect storage. */
const flush = () => new Promise((r) => setTimeout(r, 0));

// -- the hook itself ---------------------------------------------------------

describe("deviceSetting — load path", () => {
  test("nothing stored takes the coerced default", () => {
    expect(load("x", { coerce: (r) => coerceFiniteNumber(r, 42) })).toBe(42);
  });

  test("corrupt JSON is indistinguishable from nothing stored", () => {
    storage.setItem("mivnav.x", "{not json");
    expect(load("x", { coerce: (r) => coerceFiniteNumber(r, 42) })).toBe(42);
  });

  test("a coercer that throws on the stored value degrades to coerce(undefined)", () => {
    storage.setItem("mivnav.x", '"boom"');
    const value = load<number>("x", {
      coerce: (raw) => {
        if (raw === "boom") throw new Error("hostile blob");
        return 7; // the undefined path
      },
    });
    expect(value).toBe(7);
  });
});

describe("deviceSetting — write-back", () => {
  test("persists the coerced value, and the version sidecar when version > 0", async () => {
    // The write-back is an effect (a microtask); the root must stay alive across
    // the flush, so dispose only after.
    const dispose = createRoot((d) => {
      deviceSetting("wb", { coerce: (r) => coerceFiniteNumber(r, 3), version: 2 });
      return d;
    });
    await flush();
    expect(storage.getItem("mivnav.wb")).toBe("3");
    expect(storage.getItem("mivnav.wb.v")).toBe("2");
    expect(hasStored("wb")).toBe(true);
    dispose();
  });

  test("no version sidecar for an unversioned store", async () => {
    const dispose = createRoot((d) => {
      deviceSetting("wb", { coerce: (r) => coerceFiniteNumber(r, 3) });
      return d;
    });
    await flush();
    expect(storage.getItem("mivnav.wb")).toBe("3");
    expect(storage.getItem("mivnav.wb.v")).toBeNull();
    dispose();
  });
});

describe("deviceSetting — versioned migrate", () => {
  interface Counted {
    count: number;
  }
  const opts: DeviceSettingOptions<Counted> = {
    version: 1,
    // v0 (legacy, unversioned) stored a bare number; v1 wraps it.
    migrate: (raw, from) => (from < 1 && typeof raw === "number" ? { count: raw } : raw),
    coerce: (raw) =>
      raw !== null && typeof raw === "object" && typeof (raw as Counted).count === "number"
        ? { count: (raw as Counted).count }
        : { count: 0 },
  };

  test("an old unversioned payload is migrated before coercion", () => {
    storage.setItem("mivnav.m", "7"); // no sidecar: from = 0
    expect(load("m", opts)).toEqual({ count: 7 });
  });

  test("migrate is skipped once the stored version is current", () => {
    storage.setItem("mivnav.m", '{"count":3}');
    storage.setItem("mivnav.m.v", "1");
    const value = load("m", {
      ...opts,
      migrate: () => {
        throw new Error("must not run at the current version");
      },
    });
    expect(value).toEqual({ count: 3 });
  });

  test("a throwing migration degrades to the default, it does not brick", () => {
    storage.setItem("mivnav.m", "9"); // from = 0 → migrate runs
    const value = load("m", {
      ...opts,
      migrate: () => {
        throw new Error("bad migration");
      },
    });
    expect(value).toEqual({ count: 0 });
  });
});

// -- each real device key against its worst input ----------------------------

describe("device key coercion: settings", () => {
  test("a partial blob fills missing fields from the defaults", () => {
    storage.setItem("mivnav.settings", JSON.stringify({ safetyContour: 9 }));
    const s = load("settings", { coerce: settingsFromProfile });
    expect(s.safetyContour).toBe(9);
    expect(s.windUnit).toBe(DEFAULT_SETTINGS.windUnit); // a field the blob never had
    expect(s.palette).toBe(DEFAULT_SETTINGS.palette);
  });

  test("a hand-edited wrong-typed field cannot poison the rest", () => {
    storage.setItem(
      "mivnav.settings",
      JSON.stringify({ windUnit: "LOUD", showText: "yes", safetyContour: 4 }),
    );
    const s = load("settings", { coerce: settingsFromProfile });
    expect(s.windUnit).toBe(DEFAULT_SETTINGS.windUnit); // unknown enum → default
    expect(s.showText).toBe(DEFAULT_SETTINGS.showText); // string → default
    expect(s.safetyContour).toBe(4); // the good field survives
  });

  test("outright garbage is the full defaults, not a crash", () => {
    storage.setItem("mivnav.settings", '"not an object"');
    expect(load("settings", { coerce: settingsFromProfile })).toEqual(DEFAULT_SETTINGS);
  });
});

describe("device key coercion: chrome", () => {
  const inst = (id: string): Instrument => ({
    id,
    short: id.slice(0, 3).toUpperCase(),
    label: id,
    maxUrgency: "none",
    read: () => ({ value: "1" }),
  });
  const reg: Registry = createRegistry([
    defineFeature({ id: "core", instruments: [inst("nav.sog"), inst("nav.cog")] }),
  ]);
  // The coercer App.tsx uses: seed the first-run density, shallow-merge a stored
  // object, then bootChrome (normalize + adoptDefaults).
  const chromeOpts: DeviceSettingOptions<ChromeConfig> = {
    coerce: (raw) =>
      bootChrome(
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? ({ ...seedDefaults(false), ...(raw as object) } as ChromeConfig)
          : seedDefaults(false),
        reg,
      ),
  };

  test("nothing stored: a well-formed config with every widget seated", () => {
    const c = load("chrome", chromeOpts);
    // #DENS-SLIDER: the default is DEFAULT_DENSITY on every device now, not
    // just a coarse-pointer one — `seedDefaults(false)` no longer varies size
    // by the pointer guess, only `pointerCoarse`.
    expect(c.density).toBe(DEFAULT_DENSITY);
    for (const b of BAND_IDS) expect(Array.isArray(c.bands[b].order)).toBe(true);
    // adoptDefaults seats the registry's instruments on first boot.
    expect(c.bands.rail.order).toEqual(["nav.sog", "nav.cog"]);
  });

  test("a structurally-wrong stored config is repaired, not trusted", () => {
    // A hand edit: bad density, a garbled bands, junk dashboard.
    storage.setItem(
      "mivnav.chrome",
      JSON.stringify({ density: "HUGE", bands: "nope", dashboard: 5, enabled: null }),
    );
    const c = load("chrome", chromeOpts);
    expect(c.density).toBe(DEFAULT_DENSITY); // unknown (a non-number) → DEFAULT_DENSITY
    expect(c.enabled).toEqual({});
    for (const b of BAND_IDS) expect(Array.isArray(c.bands[b].order)).toBe(true);
    expect(c.bands.rail.order).toContain("nav.sog"); // still seated
  });

  test("outright garbage falls back to the seeded, booted default", () => {
    storage.setItem("mivnav.chrome", "[1,2,3]"); // an array is not a config
    const c = load("chrome", chromeOpts);
    expect(c.density).toBe(DEFAULT_DENSITY);
    expect(c.bands.rail.order).toEqual(["nav.sog", "nav.cog"]);
  });
});

describe("device key coercion: disabledSets", () => {
  test("a mixed array keeps only its string members", () => {
    storage.setItem("mivnav.disabledSets", JSON.stringify(["a", 3, null, "b", {}]));
    expect(load("disabledSets", { coerce: coerceStringArray })).toEqual(["a", "b"]);
  });

  test("a non-array is the empty list", () => {
    storage.setItem("mivnav.disabledSets", '{"a":true}');
    expect(load("disabledSets", { coerce: coerceStringArray })).toEqual([]);
  });
});

describe("device key coercion: zoom", () => {
  const zoomOpts: DeviceSettingOptions<number> = {
    coerce: (raw) => coerceFiniteNumber(raw, DEFAULT_ZOOM),
  };

  test("null (the classic corrupt zoom) falls back to the default", () => {
    storage.setItem("mivnav.zoom", "null");
    expect(load("zoom", zoomOpts)).toBe(DEFAULT_ZOOM);
  });

  test("a stringified number is not a number", () => {
    storage.setItem("mivnav.zoom", '"12"');
    expect(load("zoom", zoomOpts)).toBe(DEFAULT_ZOOM);
  });

  test("a real stored zoom is kept", () => {
    storage.setItem("mivnav.zoom", "14.5");
    expect(load("zoom", zoomOpts)).toBe(14.5);
  });
});

describe("device key coercion: debugLayers (now persisted)", () => {
  const boolOpts: DeviceSettingOptions<boolean> = {
    coerce: (raw) => coerceBoolean(raw, false),
  };

  test("a stored true survives a reload — the point of persisting it", () => {
    storage.setItem("mivnav.debugLayers", "true");
    expect(load("debugLayers", boolOpts)).toBe(true);
  });

  test("a non-boolean falls back to off", () => {
    storage.setItem("mivnav.debugLayers", '"on"');
    expect(load("debugLayers", boolOpts)).toBe(false);
  });

  test("a fresh device is off, and writes that back", async () => {
    let value!: boolean;
    const dispose = createRoot((d) => {
      const [get] = deviceSetting("debugLayers", boolOpts);
      value = get();
      return d;
    });
    expect(value).toBe(false);
    await flush();
    expect(storage.getItem("mivnav.debugLayers")).toBe("false");
    dispose();
  });
});
