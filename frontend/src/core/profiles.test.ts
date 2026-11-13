/**
 * Profiles: the client, the blob coercion, and the controller's rules.
 *
 * The fetch double below is a *model of the real backend*
 * (mivnav/config/profiles.py), not a stub of whatever the client happens to
 * send: it parses the URL, refuses the names the backend refuses, stores the
 * blob verbatim and lists newest-first. Anything the client gets wrong about
 * the wire — the path, the method, the body shape, the 204 on delete — fails
 * here rather than on the boat.
 *
 * NB: needs `--conditions=browser` (see the `test` script). Bare `bun test`
 * resolves solid-js's `node` export — the SSR build, whose createEffect
 * never runs, so every reactive assertion here would pass vacuously.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  adoptDefaultProfile,
  createLayouts,
  createProfiles,
  layoutNameError,
  layoutNameFromProfile,
  listLayouts,
  listProfiles,
  profileNameError,
  saveLayout,
  saveProfile,
  setDefaultProfile,
  settingsFromProfile,
  type Layout,
  type Profile,
} from "./profiles";
import { DEFAULT_SETTINGS, normalizedContours, type ChartSettings } from "./style/settings";
import { registerPluginSettings } from "./pluginSettings";

/** Every field non-default, so a round trip that drops or defaults one is
 * visible — including shallowDepth/deepDepth, which have no UI and would
 * otherwise be exactly the fields a round trip could quietly lose. */
const NIGHT: ChartSettings = {
  palette: "night",
  safetyContour: 5,
  safetyDepth: 3,
  shallowDepth: 1.5,
  deepDepth: 15,
  atonIconScale: 1.5, // non-default (default is 1)
  ownShipScale: 1.8, // non-default (default is 1)
  showText: false,
  showAtonText: false,
  showLights: false,
  showLightDescriptions: false,
  showOsmBase: false, // non-default (default is true)
  showOpenSeaMap: true,
  showPois: true,
  pluginLayers: { "some-plugin-layer": false }, // non-default (default is {})
  showOsmOnLand: false,
  showSatellite: true, // non-default (default is false)
  satelliteSource: "eox-sentinel2-cloudless", // non-default (default is "")
  satelliteOpacity: 0.8, // non-default (default is 0.75)
  showTrack: true, // non-default (default is false)
  trackHours: 12, // non-default (default is 6)
  showNotices: false, // non-default (default is true)
  noticesWarnings: false, // non-default (default is true)
  noticesTemporary: false, // non-default (default is true)
  noticesPreliminary: false, // non-default (default is true)
  noticesPermanent: false, // non-default (default is true)
  noticesFiring: false, // non-default (default is true)
  noticesShowEnded: true, // non-default (default is false)
  // non-default plugin settings (default is {}): a slice no plugin here
  // registered, which must round-trip verbatim.
  pluginSettings: { absent_plugin: { level: 3 } },
  // non-default ENC groups (default is all shown / opaque) and a non-default
  // stack order (default is []) — every group object differs from its default.
  encGroups: {
    fills: { visible: false, opacity: 0.5 },
    lines: { visible: true, opacity: 0.7 },
    soundings: { visible: false, opacity: 1 },
    aids: { visible: true, opacity: 0.3 },
  },
  layerOrder: ["enc:aids", "openseamap", "enc:fills", "enc:lines", "enc:soundings"],
  showAisTargets: false, // non-default (default is true)
  predictorMinutes: 60,
  showHeadingLine: false,
  showAisGhost: false, // non-default (default is now true)
  showAisRisk: false,
  windUnit: "kn", // non-default (default is "ms")
  keepScreenOn: false, // non-default (default is true)
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Stored {
  settings: unknown;
  updated: number;
}

/** A model of the backend's ProfileStore, over fetch. */
function fakeBackend(seed: Record<string, unknown> = {}) {
  const store = new Map<string, Stored>();
  let clock = 1_700_000_000;
  let defaultName: string | null = null;
  for (const [name, settings] of Object.entries(seed)) store.set(name, { settings, updated: ++clock });
  const calls: string[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const entry = (name: string): Profile => ({
    name,
    updated: store.get(name)!.updated,
    settings: store.get(name)!.settings,
  });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url)); // as Starlette decodes a path param
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const tail = path.replace("/api/config/profiles", "").replace(/^\//, "");
    // The default pointer is a two-segment sub-resource: /{name}/default. It
    // never collides with a profile named "default" (which is a one-segment
    // /{name}) — the mock distinguishes them the same way the router does.
    if (tail.endsWith("/default")) {
      const name = tail.slice(0, -"/default".length);
      if (method === "PUT") {
        if (!store.has(name)) return json({ detail: `unknown profile '${name}'` }, 404);
        defaultName = name;
        return json({ default: name });
      }
      if (method === "DELETE") {
        if (defaultName === name) defaultName = null; // scoped, idempotent
        return new Response(null, { status: 204 });
      }
    }
    const name = tail;
    if (!name) {
      return json({
        profiles: [...store.keys()].sort((a, b) => store.get(b)!.updated - store.get(a)!.updated).map(entry),
        default: defaultName,
      });
    }
    if (method === "PUT") {
      // Verified against the running backend: a percent-encoded slash does
      // not match /config/profiles/{name} at all, so it is a bare 404 "Not
      // Found" — not the store's own 422. That is exactly why the client
      // refuses the name itself: this response has no usable message in it.
      if (name.includes("/") || name.includes("\\")) return json({ detail: "Not Found" }, 404);
      if (!name.trim()) return json({ detail: "profile name must not be empty" }, 422);
      store.set(name.trim(), { settings: JSON.parse(String(init?.body)), updated: ++clock });
      return json(entry(name.trim()));
    }
    if (method === "DELETE") {
      if (!store.delete(name)) return json({ detail: `unknown profile '${name}'` }, 404);
      if (defaultName === name) defaultName = null; // backend clears a dangling default
      return new Response(null, { status: 204 });
    }
    if (!store.has(name)) return json({ detail: `unknown profile '${name}'` }, 404);
    return json(entry(name));
  }) as typeof fetch;

  return { store, calls, currentDefault: () => defaultName };
}

/** Drives a controller in a real reactive root, as the panel does. */
function withController<T>(fn: (state: ReturnType<typeof createProfiles>, loaded: () => ChartSettings[]) => Promise<T>) {
  return createRoot(async (dispose) => {
    const loaded: ChartSettings[] = [];
    const state = createProfiles((s) => loaded.push(s));
    try {
      return await fn(state, () => loaded);
    } finally {
      dispose();
    }
  });
}

interface StoredLayout {
  arrangement: unknown;
  updated: number;
}

/**
 * A model of the backend's layout routes (mivnav.api.config's `/config/
 * layouts`) over fetch — `fakeBackend`'s twin, minus the `/default`
 * sub-resource (a layout has none, see mivnav.api.config's docstring) and
 * with the entry's blob under `arrangement`, not `settings` (NamedBlobStore's
 * `entry_key` for the "layout" kind — see mivnav.config.profiles).
 */
function fakeLayoutsBackend(seed: Record<string, unknown> = {}) {
  const store = new Map<string, StoredLayout>();
  let clock = 1_700_000_000;
  for (const [name, arrangement] of Object.entries(seed)) store.set(name, { arrangement, updated: ++clock });
  const calls: string[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const entry = (name: string): Layout => ({
    name,
    updated: store.get(name)!.updated,
    arrangement: store.get(name)!.arrangement,
  });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const name = path.replace("/api/config/layouts", "").replace(/^\//, "");
    if (!name) return json({ layouts: [...store.keys()].sort((a, b) => store.get(b)!.updated - store.get(a)!.updated).map(entry) });
    if (method === "PUT") {
      if (name.includes("/") || name.includes("\\")) return json({ detail: "Not Found" }, 404);
      if (!name.trim()) return json({ detail: "layout name must not be empty" }, 422);
      store.set(name.trim(), { arrangement: JSON.parse(String(init?.body)), updated: ++clock });
      return json(entry(name.trim()));
    }
    if (method === "DELETE") {
      if (!store.delete(name)) return json({ detail: `unknown layout '${name}'` }, 404);
      return new Response(null, { status: 204 });
    }
    if (!store.has(name)) return json({ detail: `unknown layout '${name}'` }, 404);
    return json(entry(name));
  }) as typeof fetch;

  return { store, calls };
}

/** Drives a `LayoutsController` in a real reactive root, `withController`'s twin. */
function withLayoutsController<T>(fn: (state: ReturnType<typeof createLayouts>) => Promise<T>) {
  return createRoot(async (dispose) => {
    const state = createLayouts();
    try {
      return await fn(state);
    } finally {
      dispose();
    }
  });
}

describe("settingsFromProfile", () => {
  test("a saved blob round-trips every field, the invisible ones included", () => {
    // exactly what saveProfile puts on the wire, back through JSON
    const blob = JSON.parse(JSON.stringify(NIGHT)) as unknown;
    expect(settingsFromProfile(blob)).toEqual(NIGHT);
    // guard the guard: the fixture must not be the defaults
    for (const key of Object.keys(NIGHT) as (keyof ChartSettings)[]) {
      expect(NIGHT[key]).not.toEqual(DEFAULT_SETTINGS[key]);
    }
  });

  test("a profile violating shallow <= safety <= deep is normalized on load", () => {
    const loaded = settingsFromProfile({ ...NIGHT, shallowDepth: 9, safetyContour: 5, deepDepth: 2 });
    expect(loaded.shallowDepth).toBe(5);
    expect(loaded.safetyContour).toBe(5);
    expect(loaded.deepDepth).toBe(5);
    // `loaded` is already ordered by settingsFromProfile, so normalizedContours
    // is a no-op here — this only confirms it's idempotent on ordered input. The
    // clamp's own min/max branches are exercised in the describe block below.
    expect(normalizedContours(loaded)).toEqual({ shallow: 5, safety: 5, deep: 5 });
  });

  test("a field added since the profile was saved takes its default, not the live value", () => {
    const { showOpenSeaMap: _dropped, ...older } = NIGHT;
    const loaded = settingsFromProfile(older);
    expect(loaded.showOpenSeaMap).toBe(DEFAULT_SETTINGS.showOpenSeaMap);
    expect(loaded.windUnit).toBe("kn"); // the rest survives
  });

  test("a hand-edited blob cannot poison the other fields", () => {
    const loaded = settingsFromProfile({
      ...NIGHT,
      safetyContour: "shallow-ish",
      showLights: "yes",
      windUnit: "furlongs",
      // An unknown palette is the one bad value here that would not merely
      // look wrong: it keys S52_PALETTES to undefined, and every colour
      // lookup in the style generator would throw on the next render.
      palette: "infrared",
      // A profile saved before the collision settings became the boat's:
      // its cpaMode is ignored, never read back into device settings.
      cpaMode: "loud",
      extraKeyFromANewerClient: 1,
    });
    expect(loaded.safetyContour).toBe(DEFAULT_SETTINGS.safetyContour);
    expect(loaded.showLights).toBe(DEFAULT_SETTINGS.showLights);
    expect(loaded.windUnit).toBe(DEFAULT_SETTINGS.windUnit);
    expect(loaded.palette).toBe(DEFAULT_SETTINGS.palette);
    expect("cpaMode" in loaded).toBe(false);
    expect(loaded.safetyDepth).toBe(NIGHT.safetyDepth);
    expect(Object.keys(loaded).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  test("a registered plugin slice is coerced; a legacy top-level key is read", () => {
    const unregister = registerPluginSettings({
      key: "demo",
      defaults: { n: 1 },
      coerce: (raw) => ({ n: typeof (raw as { n?: unknown })?.n === "number" ? (raw as { n: number }).n : 1 }),
      legacyKey: "oldDemo",
    });
    try {
      expect(settingsFromProfile({}).pluginSettings.demo).toEqual({ n: 1 });
      expect(settingsFromProfile({ pluginSettings: { demo: { n: "x" } } }).pluginSettings.demo).toEqual({ n: 1 });
      // Before it was a plugin's, the slice lived at the top level.
      const legacy = settingsFromProfile({ oldDemo: { n: 7 } });
      expect(legacy.pluginSettings.demo).toEqual({ n: 7 });
      expect("oldDemo" in legacy).toBe(false);
      // The plugin's own block wins over a stale legacy one.
      expect(settingsFromProfile({ oldDemo: { n: 7 }, pluginSettings: { demo: { n: 2 } } }).pluginSettings.demo).toEqual({ n: 2 });
    } finally {
      unregister();
    }
  });

  test("garbage in place of an object is the defaults, not a crash", () => {
    for (const blob of [null, undefined, 42, "night", ["night"]]) {
      expect(settingsFromProfile(blob)).toEqual(DEFAULT_SETTINGS);
    }
  });
});

// The render-time clamp itself, on genuinely out-of-order input — the live
// safety-contour drag path clamps every frame, independently of the load-time
// normalization in settingsFromProfile (which pre-orders the stored numbers, so
// the assertion up in "settingsFromProfile" only proves idempotence). Here the
// min/max each actually bite.
describe("normalizedContours", () => {
  const withDepths = (shallowDepth: number, safetyContour: number, deepDepth: number): ChartSettings => ({
    ...DEFAULT_SETTINGS,
    shallowDepth,
    safetyContour,
    deepDepth,
  });

  test("shallow > safety: the min clamps shallow down to safety", () => {
    expect(normalizedContours(withDepths(10, 5, 20))).toEqual({ shallow: 5, safety: 5, deep: 20 });
  });

  test("deep < safety: the max clamps deep up to safety", () => {
    expect(normalizedContours(withDepths(1, 5, 2))).toEqual({ shallow: 1, safety: 5, deep: 5 });
  });

  test("already ordered (shallow <= safety <= deep): passes through untouched", () => {
    expect(normalizedContours(withDepths(1, 5, 20))).toEqual({ shallow: 1, safety: 5, deep: 20 });
  });
});

describe("profileNameError", () => {
  test("refuses what the backend refuses", () => {
    expect(profileNameError("Night")).toBeNull();
    expect(profileNameError("Night / Skagerrak")).toMatch(/cannot contain/);
    expect(profileNameError("back\\slash")).toMatch(/cannot contain/);
    expect(profileNameError("   ")).toMatch(/Name the profile/);
    expect(profileNameError("x".repeat(65))).toMatch(/64 characters/);
    expect(profileNameError("be\u0007ll")).toMatch(/control characters/);
  });
});

describe("layoutNameError — profileNameError's twin, at the layout noun", () => {
  test("same rules, layout-flavoured wording", () => {
    expect(layoutNameError("Passage")).toBeNull();
    expect(layoutNameError("Passage / Skagerrak")).toMatch(/cannot contain/);
    expect(layoutNameError("   ")).toMatch(/Name the layout/);
    expect(layoutNameError("x".repeat(65))).toMatch(/64 characters/);
  });
});

describe("layoutNameFromProfile — the reference a profile carries (task vqnxwuro)", () => {
  test("absent (an older profile, or one never given a layout) is null", () => {
    expect(layoutNameFromProfile(NIGHT)).toBeNull();
  });

  test("a stored layoutName round-trips", () => {
    expect(layoutNameFromProfile({ ...NIGHT, layoutName: "Passage" })).toBe("Passage");
  });

  test("a blank or wrong-typed value is treated as absent, not trusted raw", () => {
    expect(layoutNameFromProfile({ ...NIGHT, layoutName: "" })).toBeNull();
    expect(layoutNameFromProfile({ ...NIGHT, layoutName: "   " })).toBeNull();
    expect(layoutNameFromProfile({ ...NIGHT, layoutName: 42 })).toBeNull();
  });

  test("garbage in place of an object is null, not a crash", () => {
    for (const blob of [null, undefined, 42, "night", ["night"]]) {
      expect(layoutNameFromProfile(blob)).toBeNull();
    }
  });
});

describe("the wire", () => {
  test("save then list round-trips the settings verbatim", async () => {
    const backend = fakeBackend();
    await saveProfile("Night", NIGHT);
    const listed = await listProfiles();
    expect(listed.profiles.map((p) => p.name)).toEqual(["Night"]);
    expect(listed.default).toBeNull();
    expect(settingsFromProfile(listed.profiles[0].settings)).toEqual(NIGHT);
    expect(backend.calls).toEqual(["PUT /api/config/profiles/Night", "GET /api/config/profiles"]);
  });

  test("a name with a space is a path segment, not a query", async () => {
    fakeBackend();
    await saveProfile("  Coastal cruising  ", NIGHT);
    expect((await listProfiles()).profiles.map((p) => p.name)).toEqual(["Coastal cruising"]);
  });

  test("a layoutName rides as one extra flat key, coerced back out by layoutNameFromProfile", async () => {
    fakeBackend();
    await saveProfile("Night", NIGHT, "Passage");
    const listed = await listProfiles();
    // still a valid ChartSettings round trip — the extra key is ignored, not merged in
    expect(settingsFromProfile(listed.profiles[0].settings)).toEqual(NIGHT);
    expect(layoutNameFromProfile(listed.profiles[0].settings)).toBe("Passage");
  });

  test("omitting layoutName (or passing null/empty) never writes the key at all", async () => {
    fakeBackend();
    await saveProfile("Night", NIGHT);
    await saveProfile("Day", NIGHT, null);
    await saveProfile("Dusk", NIGHT, "");
    const listed = await listProfiles();
    for (const p of listed.profiles) {
      expect((p.settings as Record<string, unknown>).layoutName).toBeUndefined();
      expect(layoutNameFromProfile(p.settings)).toBeNull();
    }
  });
});

describe("createProfiles", () => {
  test("lists what the server has, newest first", async () => {
    fakeBackend({ Day: { showText: true }, Night: NIGHT });
    await withController(async (state) => {
      await state.refresh();
      expect(state.profiles().map((p) => p.name)).toEqual(["Night", "Day"]);
      expect(state.offline()).toBe("");
    });
  });

  test("save then load round-trips through the server into the settings", async () => {
    fakeBackend();
    await withController(async (state, loaded) => {
      await state.save("Night", NIGHT);
      expect(state.status()).toBe("Saved Night.");
      expect(state.error()).toBe("");
      await state.refresh();
      state.load(state.profiles()[0]);
      expect(loaded()).toEqual([NIGHT]);
      expect(state.status()).toBe("Loaded Night.");
    });
  });

  test("load is a one-shot copy: a later save of tweaked settings does not touch the loaded profile", async () => {
    const backend = fakeBackend({ Night: NIGHT });
    await withController(async (state, loaded) => {
      await state.refresh();
      state.load(state.profiles()[0]);
      // the mariner nudges the contour, then saves it as something else
      await state.save("Pilotage", { ...loaded()[0], safetyContour: 8 });
      expect(backend.store.get("Night")!.settings).toEqual(NIGHT);
      expect(backend.store.get("Pilotage")!.settings).toMatchObject({ safetyContour: 8 });
    });
  });

  test("saving an existing name replaces it, in the list too", async () => {
    fakeBackend({ Night: NIGHT });
    await withController(async (state) => {
      await state.refresh();
      await state.save("Night", { ...NIGHT, safetyContour: 2 });
      expect(state.profiles().map((p) => p.name)).toEqual(["Night"]);
      expect(settingsFromProfile(state.profiles()[0].settings).safetyContour).toBe(2);
    });
  });

  test("a name with a slash is refused before the round trip, with a reason", async () => {
    const backend = fakeBackend();
    await withController(async (state) => {
      await state.save("Night / Skagerrak", NIGHT);
      expect(state.error()).toMatch(/cannot contain/);
      expect(state.status()).toBe("");
      expect(state.profiles()).toEqual([]);
      expect(backend.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
    });
  });

  test("a name the backend refuses anyway surfaces the backend's own words", async () => {
    fakeBackend();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "at most 100 profiles" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await withController(async (state) => {
      await state.save("Night", NIGHT);
      expect(state.error()).toBe("at most 100 profiles");
    });
  });

  test("delete removes it here and there", async () => {
    const backend = fakeBackend({ Night: NIGHT });
    await withController(async (state) => {
      await state.refresh();
      await state.remove(state.profiles()[0]);
      expect(state.profiles()).toEqual([]);
      expect(backend.store.has("Night")).toBe(false);
      expect(state.error()).toBe("");
    });
  });

  test("an unreachable server is a notice, not a failure: nothing rejects, settings are untouched", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    await withController(async (state, loaded) => {
      await state.refresh();
      expect(state.offline()).toMatch(/Failed to fetch/);
      expect(state.profiles()).toEqual([]);
      expect(state.loading()).toBe(false);
      expect(loaded()).toEqual([]); // the live settings were never written to

      // and a save while offline reports, rather than throws
      await state.save("Night", NIGHT);
      expect(state.error()).toMatch(/Failed to fetch/);
    });
  });

  test("the offline notice clears once the server answers again", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    await withController(async (state) => {
      await state.refresh();
      expect(state.offline()).not.toBe("");
      fakeBackend({ Night: NIGHT });
      await state.refresh();
      expect(state.offline()).toBe("");
      expect(state.profiles().map((p) => p.name)).toEqual(["Night"]);
    });
  });

  test("set default, replace it, then clear it — tracked here and on the server", async () => {
    const backend = fakeBackend({ Night: NIGHT, Day: { showText: true } });
    await withController(async (state) => {
      await state.refresh();
      expect(state.defaultName()).toBe("");

      await state.setDefault(state.profiles().find((p) => p.name === "Night")!);
      expect(state.defaultName()).toBe("Night");
      expect(backend.currentDefault()).toBe("Night");
      expect(state.status()).toMatch(/Night is now the default/);

      // replacing just points it elsewhere
      await state.setDefault(state.profiles().find((p) => p.name === "Day")!);
      expect(state.defaultName()).toBe("Day");
      expect(backend.currentDefault()).toBe("Day");

      await state.clearDefault(state.profiles().find((p) => p.name === "Day")!);
      expect(state.defaultName()).toBe("");
      expect(backend.currentDefault()).toBeNull();
    });
  });

  test("deleting the default profile clears the default here and there", async () => {
    const backend = fakeBackend({ Night: NIGHT });
    await withController(async (state) => {
      await state.refresh();
      await state.setDefault(state.profiles()[0]);
      expect(state.defaultName()).toBe("Night");
      await state.remove(state.profiles()[0]);
      expect(state.profiles()).toEqual([]);
      expect(state.defaultName()).toBe("");
      expect(backend.currentDefault()).toBeNull();
    });
  });
});

describe("adoptDefaultProfile", () => {
  test("a fresh device adopts the boat-wide default once", async () => {
    fakeBackend({ Night: NIGHT });
    await setDefaultProfile("Night");
    const applied: ChartSettings[] = [];
    await adoptDefaultProfile({ hasLocalChoice: false, apply: (s) => applied.push(s) });
    expect(applied).toEqual([NIGHT]);
  });

  test("a device that has already chosen never adopts — a later default cannot stomp it", async () => {
    fakeBackend({ Night: NIGHT });
    await setDefaultProfile("Night");
    const applied: ChartSettings[] = [];
    await adoptDefaultProfile({ hasLocalChoice: true, apply: (s) => applied.push(s) });
    expect(applied).toEqual([]);
  });

  test("no default set: a fresh device adopts nothing and stays on its own settings", async () => {
    fakeBackend({ Night: NIGHT });
    const applied: ChartSettings[] = [];
    await adoptDefaultProfile({ hasLocalChoice: false, apply: (s) => applied.push(s) });
    expect(applied).toEqual([]);
  });

  test("server unreachable at boot: adoption resolves and applies nothing", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const applied: ChartSettings[] = [];
    await adoptDefaultProfile({ hasLocalChoice: false, apply: (s) => applied.push(s) });
    expect(applied).toEqual([]);
  });

  test("the adopted blob is coerced through settingsFromProfile, not trusted raw", async () => {
    // a hand-edited default with a bad field must not poison the fresh device
    fakeBackend({ Bad: { ...NIGHT, palette: "infrared", showLights: "yes" } });
    await setDefaultProfile("Bad");
    const applied: ChartSettings[] = [];
    await adoptDefaultProfile({ hasLocalChoice: false, apply: (s) => applied.push(s) });
    expect(applied[0].palette).toBe(DEFAULT_SETTINGS.palette);
    expect(applied[0].showLights).toBe(DEFAULT_SETTINGS.showLights);
  });
});

const ARRANGEMENT = { enabled: {}, bands: { rail: { order: ["nav.sog"] } }, dashboard: { tabs: [], widgets: {} } };

describe("layouts — the wire", () => {
  test("save then list round-trips the arrangement verbatim, under 'arrangement' not 'settings'", async () => {
    const backend = fakeLayoutsBackend();
    await saveLayout("Passage", ARRANGEMENT);
    const listed = await listLayouts();
    expect(listed.map((l) => l.name)).toEqual(["Passage"]);
    expect(listed[0].arrangement).toEqual(ARRANGEMENT);
    expect(backend.calls).toEqual(["PUT /api/config/layouts/Passage", "GET /api/config/layouts"]);
  });
});

describe("createLayouts", () => {
  test("lists what the server has, newest first", async () => {
    fakeLayoutsBackend({ Harbour: { enabled: {} }, Passage: ARRANGEMENT });
    await withLayoutsController(async (state) => {
      await state.refresh();
      expect(state.layouts().map((l) => l.name)).toEqual(["Passage", "Harbour"]);
      expect(state.offline()).toBe("");
    });
  });

  test("save adds it to the list, newest first", async () => {
    fakeLayoutsBackend();
    await withLayoutsController(async (state) => {
      await state.save("Passage", ARRANGEMENT);
      expect(state.status()).toBe("Saved Passage.");
      await state.refresh();
      expect(state.layouts().map((l) => l.name)).toEqual(["Passage"]);
    });
  });

  test("saving an existing name replaces it, in the list too", async () => {
    fakeLayoutsBackend({ Passage: ARRANGEMENT });
    await withLayoutsController(async (state) => {
      await state.refresh();
      await state.save("Passage", { ...ARRANGEMENT, enabled: { x: false } });
      expect(state.layouts().map((l) => l.name)).toEqual(["Passage"]);
      expect(state.layouts()[0].arrangement).toEqual({ ...ARRANGEMENT, enabled: { x: false } });
    });
  });

  test("a name with a slash is refused before the round trip, with a reason", async () => {
    const backend = fakeLayoutsBackend();
    await withLayoutsController(async (state) => {
      await state.save("Passage / Skagerrak", ARRANGEMENT);
      expect(state.error()).toMatch(/cannot contain/);
      expect(state.layouts()).toEqual([]);
      expect(backend.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
    });
  });

  test("duplicate copies the arrangement under a new name, leaving the original untouched", async () => {
    const backend = fakeLayoutsBackend({ Passage: ARRANGEMENT });
    await withLayoutsController(async (state) => {
      await state.refresh();
      await state.duplicate(state.layouts()[0], "Passage copy");
      expect(state.layouts().map((l) => l.name).sort()).toEqual(["Passage", "Passage copy"]);
      expect(backend.store.get("Passage")!.arrangement).toEqual(ARRANGEMENT);
      expect(backend.store.get("Passage copy")!.arrangement).toEqual(ARRANGEMENT);
    });
  });

  test("rename saves under the new name then deletes the old one", async () => {
    const backend = fakeLayoutsBackend({ Passage: ARRANGEMENT });
    await withLayoutsController(async (state) => {
      await state.refresh();
      await state.rename(state.layouts()[0], "Coastal");
      expect(state.layouts().map((l) => l.name)).toEqual(["Coastal"]);
      expect(backend.store.has("Passage")).toBe(false);
      expect(backend.store.get("Coastal")!.arrangement).toEqual(ARRANGEMENT);
    });
  });

  test("rename to the same name is a no-op", async () => {
    const backend = fakeLayoutsBackend({ Passage: ARRANGEMENT });
    await withLayoutsController(async (state) => {
      await state.refresh();
      await state.rename(state.layouts()[0], "  Passage  ");
      expect(backend.calls.filter((c) => c.startsWith("PUT") || c.startsWith("DELETE"))).toEqual([]);
    });
  });

  test("delete removes it here and there", async () => {
    const backend = fakeLayoutsBackend({ Passage: ARRANGEMENT });
    await withLayoutsController(async (state) => {
      await state.refresh();
      await state.remove(state.layouts()[0]);
      expect(state.layouts()).toEqual([]);
      expect(backend.store.has("Passage")).toBe(false);
      expect(state.error()).toBe("");
    });
  });

  test("an unreachable server is a notice, not a failure", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    await withLayoutsController(async (state) => {
      await state.refresh();
      expect(state.offline()).toMatch(/Failed to fetch/);
      expect(state.layouts()).toEqual([]);
      expect(state.loading()).toBe(false);
    });
  });
});
