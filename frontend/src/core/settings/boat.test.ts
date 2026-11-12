/**
 * The BOAT scope adapter (B4) — a `scope: "boat"` setting routes its read/write
 * to the ONE `ServerConfigController`, and the round trip the boat depends on is
 * preserved: a write issues a merge-`PATCH /config` with only the changed field,
 * the panel refills from the response (server truth), and a refusal is addressed
 * by scope and surfaced — never a silent no-op.
 *
 * The fetch double is a small model of the backend's ConfigStore + /config
 * router (mivnav/config/store.py), holding nav state, deep-merging patches and
 * echoing the merged whole back — so "only the changed field was sent" and "what
 * is on screen is what the server stored" are proved against a real merge, not a
 * stub of what the client happened to send.
 *
 * NB: needs `--conditions=browser` (see the `test` script). Bare `bun test`
 * resolves solid-js's `node` (SSR) export, whose createEffect never runs, so
 * every reactive assertion here would pass vacuously.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createServerConfig, type ConfigPatch, type ServerConfigController } from "../serverConfig";
import { createSettingsRegistry, isSettingEnabled, type Setting } from "./registry";
import { BOAT_SETTINGS, NAV_SECTION, type BoatCtx } from "./boat";

const byId = (id: string): Setting<BoatCtx> => {
  const s = BOAT_SETTINGS.find((x) => x.id === id);
  if (!s) throw new Error(`no boat setting ${id}`);
  return s;
};

/** A boat write returns the controller's promise, typed `void` for the renderer
 * (which discards it); a test awaits the round trip. */
const commit = (s: Setting<BoatCtx>, ctx: BoatCtx, v: boolean | number | string) =>
  s.write!(ctx, v) as unknown as Promise<boolean>;

interface StoredNav {
  course_sync: boolean;
  course_match_tolerance_m: number;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** mivnav.config.store.deep_merge */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch))
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/** A model of the backend's ConfigStore + /config router, over fetch — only the
 * nav slice the boat settings touch, plus the meta the controller expects. */
function fakeBackend(nav: StoredNav = { course_sync: true, course_match_tolerance_m: 10 }) {
  let stored: StoredNav = { ...nav };
  const patches: ConfigPatch[] = [];
  let refuse: { status: number; detail: string } | null = null;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const payload = () => ({
    config: {
      version: 1,
      nav: stored,
      // the boat settings read only `nav`; the rest is here so the shape the
      // controller stores is a plausible whole, not a nav-only fragment.
      ocharts: {},
      data_root: "/data",
      signalk: { enabled: false, host: "localhost", port: 3000, tls: false, extra_paths: [] },
      credentials: { ocharts: { user: "", password: null } },
    },
    meta: {
      path: "/config/mivnav/config.json",
      credentials_path: "/config/mivnav/credentials.json",
      profiles_path: "/config/mivnav/profiles.json",
      ocharts_password_set: false,
      signalk_token_set: false,
      signalk_url: "ws://localhost:3000/signalk/v1/stream?subscribe=none",
      boot_id: "boot-fixed", // this suite never restarts the fake backend
    },
  });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" || String(url).endsWith("/reload")) return json(payload());
    const patch = JSON.parse(String(init?.body)) as ConfigPatch;
    patches.push(patch);
    if (refuse) return json({ detail: refuse.detail }, refuse.status);
    stored = deepMerge(stored, patch.nav) as StoredNav;
    return json(payload());
  }) as typeof fetch;

  return {
    get stored() {
      return stored;
    },
    patches,
    refuseWith: (status: number, detail: string) => (refuse = { status, detail }),
  };
}

/** Drives the boat controller in a real reactive root, as the panel does. */
function withBoat<T>(fn: (cfg: ServerConfigController, ctx: BoatCtx) => Promise<T>) {
  return createRoot(async (dispose) => {
    const cfg = createServerConfig();
    const ctx: BoatCtx = { cfg, signalkStatus: "off" };
    try {
      await cfg.refresh();
      return await fn(cfg, ctx);
    } finally {
      dispose();
    }
  });
}

describe("boat scope adapter — read reads the config slice, write PATCHes it", () => {
  test("(a) a write sends only the changed field and refills from the response", async () => {
    const backend = fakeBackend();
    await withBoat(async (cfg, ctx) => {
      const sync = byId("nav.course_sync");
      expect(sync.read!(ctx)).toBe(true); // read reflects the fetched config

      const ok = await commit(sync, ctx, false);
      expect(ok).toBe(true);
      // merge-PATCH: only the field that changed, nothing else
      expect(backend.patches).toEqual([{ nav: { course_sync: false } }]);
      // refilled from the RESPONSE — what the server stored, not what we hoped
      expect(cfg.config()!.nav.course_sync).toBe(false);
      expect(sync.read!(ctx)).toBe(false);
      // addressed feedback: the nav section, and a success line
      expect(cfg.scope()).toBe("nav");
      expect(cfg.status()).toBe("Saved.");
      expect(cfg.error()).toBe("");
    });
  });

  test("(b) a refused write surfaces (addressed, in words), not a silent no-op", async () => {
    const backend = fakeBackend();
    await withBoat(async (cfg, ctx) => {
      backend.refuseWith(
        422,
        "1 validation error for Config\nnav.course_match_tolerance_m\n  Input should be greater than 0 [type=greater_than, input_value=0, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/greater_than",
      );
      const tolerance = byId("nav.course_match_tolerance_m");

      const ok = await commit(tolerance, ctx, 100);
      expect(ok).toBe(false);
      // the reason, readable, addressed to the nav section — not nothing
      expect(cfg.error()).toBe("Not saved: nav.course_match_tolerance_m: Input should be greater than 0");
      expect(cfg.status()).toBe("");
      expect(cfg.scope()).toBe("nav");
      // the boat's truth is untouched, and that is what the control shows
      expect(backend.stored.course_match_tolerance_m).toBe(10);
      expect(cfg.config()!.nav.course_match_tolerance_m).toBe(10);
      expect(tolerance.read!(ctx)).toBe(10);
    });
  });

  test("(d) both nav fields round-trip through the controller", async () => {
    const backend = fakeBackend();
    await withBoat(async (cfg, ctx) => {
      const sync = byId("nav.course_sync");
      const tolerance = byId("nav.course_match_tolerance_m");

      await commit(sync, ctx, false);
      await commit(sync, ctx, true);
      await commit(tolerance, ctx, 20);

      expect(cfg.config()!.nav).toEqual({ course_sync: true, course_match_tolerance_m: 20 });
      expect(sync.read!(ctx)).toBe(true);
      expect(tolerance.read!(ctx)).toBe(20);
      // the boat actually holds it, and each patch was a slice
      expect(backend.stored).toEqual({ course_sync: true, course_match_tolerance_m: 20 });
      expect(backend.patches).toEqual([
        { nav: { course_sync: false } },
        { nav: { course_sync: true } },
        { nav: { course_match_tolerance_m: 20 } },
      ]);
    });
  });
});

describe("the generated nav section", () => {
  test("registers with its two settings + feedback, no mis-wiring", () => {
    const reg = createSettingsRegistry(BOAT_SETTINGS, [NAV_SECTION]);
    expect(reg.settingsFor("nav").map((s) => s.id)).toEqual([
      "nav.course_sync",
      "nav.course_match_tolerance_m",
      "nav.feedback",
    ]);
    expect(reg.byId("nav.course_sync")!.scope).toBe("server");
  });

  test("the match tolerance is a commit-on-blur field, not a slider", () => {
    expect(byId("nav.course_match_tolerance_m").control).toMatchObject({ kind: "number", as: "field" });
    expect(byId("nav.course_sync").control).toMatchObject({ kind: "toggle" });
  });

  test("the match tolerance is greyed while course-sync is off, or a write is busy", () => {
    const reg = createSettingsRegistry(BOAT_SETTINGS, [NAV_SECTION]);
    const tolerance = byId("nav.course_match_tolerance_m");
    const ctx = (course_sync: boolean, busy: boolean): BoatCtx =>
      ({ cfg: { config: () => ({ nav: { course_sync } }), busy: () => busy } }) as unknown as BoatCtx;
    expect(isSettingEnabled(reg, tolerance, ctx(true, false))).toBe(true);
    expect(isSettingEnabled(reg, tolerance, ctx(false, false))).toBe(false); // course-sync off
    expect(isSettingEnabled(reg, tolerance, ctx(true, true))).toBe(false); // a write in flight
    // the toggle itself is never busy-disabled (as the hand-authored one was not)
    expect(isSettingEnabled(reg, byId("nav.course_sync"), ctx(true, true))).toBe(true);
  });

  test("both generated boat writes document their boat-wide blast radius", () => {
    expect(byId("nav.course_sync").writeSideEffect).toMatch(/Boat-wide/);
    expect(byId("nav.course_match_tolerance_m").writeSideEffect).toMatch(/Boat-wide/);
  });
});
