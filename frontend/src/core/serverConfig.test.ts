/**
 * The server config client, and the two rules it exists to keep: a stored
 * password is never wiped by accident and never comes back out.
 *
 * The fetch double below is a *model of the real backend* (mivnav/config/
 * store.py + mivnav/api/config.py), not a stub of whatever the client
 * happens to send: it holds the password in the clear, deep-merges patches,
 * honours `password: null` as "leave unchanged", redacts on the way out and
 * reports `meta.ocharts_password_set` from what it actually has. So the trap
 * this UI has to avoid is a real trap in here — a client that blanked the
 * password would blank it in this store, visibly, rather than pass.
 *
 * NB: needs `--conditions=browser` (see the `test` script). Bare `bun test`
 * resolves solid-js's `node` export — the SSR build, whose createEffect
 * never runs, so every reactive assertion here would pass vacuously.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { chartEpoch } from "./chartProtocol";
import {
  createOchartsLogin,
  createServerConfig,
  readableDetail,
  seedChartDetail,
  type ConfigPatch,
  type OchartsLoginController,
  type ServerConfigController,
} from "./serverConfig";

/** The only string in this file that is a secret. If it appears anywhere a
 * client can reach, the backend's whole redaction contract is broken. */
const PASSWORD = "hunter2-correct-horse";

interface StoredConfig {
  version: number;
  ocharts: Record<string, unknown>;
  data_root: string;
  signalk: { enabled: boolean; host: string; port: number; tls: boolean };
  credentials: { ocharts: { user: string; password: string } };
}

const seed = (): StoredConfig => ({
  version: 1,
  ocharts: {
    daemon_dir: "/cache/oexserverd",
    work_dir: "/run/mivnav-oex",
    s52_path: null,
    cell_budget_bytes: 536870912,
    tile_budget_bytes: 67108864,
    rescan_interval_s: 5.0,
  },
  data_root: "/data",
  signalk: { enabled: true, host: "localhost", port: 3000, tls: false },
  credentials: { ocharts: { user: "skipper@example.com", password: PASSWORD } },
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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A model of the backend's ConfigStore + /config router, over fetch. */
function fakeBackend(overrides: Partial<StoredConfig> = {}) {
  let stored: StoredConfig = { ...seed(), ...overrides };
  /** Every PATCH body the client sent, as JSON. */
  const patches: ConfigPatch[] = [];
  let refuse: { status: number; detail: string } | null = null;
  // Minted once per fakeBackend() — i.e. once per simulated backend
  // process — the same way Runtime.__init__ mints it once per real process.
  // Tests simulate a restart by calling a NEW fakeBackend() (a fresh
  // instance, a fresh boot_id) and pointing globalThis.fetch at it — never
  // by mutating this one, since the real backend cannot change its own
  // boot_id without restarting either.
  const bootId = `boot-${Math.random().toString(36).slice(2)}`;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** mivnav.config.model.redacted + the router's `meta`. */
  const payload = () => ({
    config: {
      ...stored,
      // The password goes in and never comes out. Null, not the mask,
      // because null is what a PATCH reads as "unchanged".
      credentials: { ocharts: { user: stored.credentials.ocharts.user, password: null } },
    },
    meta: {
      path: "/config/mivnav/config.json",
      credentials_path: "/config/mivnav/credentials.json",
      profiles_path: "/config/mivnav/profiles.json",
      // Whether a password exists, never which.
      ocharts_password_set: !!stored.credentials.ocharts.password,
      signalk_token_set: false,
      signalk_url: `ws${stored.signalk.tls ? "s" : ""}://${stored.signalk.host}:${stored.signalk.port}/signalk/v1/stream?subscribe=none`,
      boot_id: bootId,
    },
  });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    if (path === "/api/config/reload") return json(payload());
    if (method === "GET") return json(payload());

    const patch = JSON.parse(String(init?.body)) as ConfigPatch;
    patches.push(patch);
    if (refuse) return json({ detail: refuse.detail }, refuse.status);

    // mivnav.config.store._drop_null_password — narrowly scoped: only the
    // password's null means "unchanged". s52_path's null is a real value.
    const creds = patch.credentials?.ocharts;
    const applied =
      creds && "password" in creds && creds.password === null
        ? { ...patch, credentials: { ocharts: { user: creds.user } } }
        : patch;
    const merged = deepMerge(stored, applied) as StoredConfig;
    // The merged *whole* is validated, so a patch cannot produce a config
    // the file format would reject (SignalKConfig.port: ge=1, le=65535).
    if (!Number.isInteger(merged.signalk.port) || merged.signalk.port < 1)
      return json(
        {
          // pydantic's own words, as the router passes them through — the
          // exact string the running backend returns for this patch.
          detail:
            "1 validation error for Config\nsignalk.port\n  Input should be greater than or equal to 1 [type=greater_than_equal, input_value=0, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/greater_than_equal",
        },
        422,
      );
    stored = merged;
    return json(payload());
  }) as typeof fetch;

  return {
    /** The truth, including the secret — what the boat actually has. */
    get stored() {
      return stored;
    },
    bootId,
    patches,
    /** Make the next writes fail, as a 422 or a 409 would. */
    refuseWith: (status: number, detail: string) => (refuse = { status, detail }),
    accept: () => (refuse = null),
  };
}

/** Drives the controllers in a real reactive root, as the panel does. */
function withConfig<T>(
  fn: (cfg: ServerConfigController, login: OchartsLoginController) => Promise<T>,
) {
  return createRoot(async (dispose) => {
    const cfg = createServerConfig();
    const login = createOchartsLogin(cfg);
    try {
      await cfg.refresh();
      return await fn(cfg, login);
    } finally {
      dispose();
    }
  });
}

/** Everything the panel can render, as one string: the components read the
 * config, the meta and the two login accessors and nothing else, so a
 * secret absent from all of them has no path into the DOM. */
const onScreen = (cfg: ServerConfigController, login: OchartsLoginController) =>
  JSON.stringify([cfg.config(), cfg.meta(), login.user(), login.password(), cfg.status()]);

describe("readableDetail", () => {
  // Captured verbatim from the running backend (pydantic 2.13) — an invented
  // fixture would only prove this function parses what it was written for.
  const PORT =
    "1 validation error for Config\nsignalk.port\n  Input should be greater than or equal to 1 [type=greater_than_equal, input_value=0, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/greater_than_equal";
  const EXTRA =
    "1 validation error for Config\nsignalk.nonsense\n  Extra inputs are not permitted [type=extra_forbidden, input_value=1, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/extra_forbidden";
  const TWO =
    "2 validation errors for Config\nsignalk.host\n  Input should be a valid string [type=string_type, input_value=123, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/string_type\nsignalk.port\n  Input should be greater than or equal to 1 [type=greater_than_equal, input_value=0, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.13/v/greater_than_equal";

  test("keeps the sentence and the field, drops the debugger output", () => {
    expect(readableDetail(PORT)).toBe("signalk.port: Input should be greater than or equal to 1");
    expect(readableDetail(EXTRA)).toBe("signalk.nonsense: Extra inputs are not permitted");
  });

  test("a patch can break two fields at once, and both are named", () => {
    expect(readableDetail(TWO)).toBe(
      "signalk.host: Input should be a valid string; " +
        "signalk.port: Input should be greater than or equal to 1",
    );
  });

  test("anything that is not pydantic is the server's own words, untouched", () => {
    for (const detail of [
      "a chart install is running; chart configuration cannot change until it finishes",
      "no o-charts credentials configured (set credentials.ocharts.user/password via PATCH /config)",
      "HTTP 500",
      "",
    ]) {
      expect(readableDetail(detail)).toBe(detail);
    }
  });
});

describe("the o-charts password", () => {
  test("editing the username does not wipe the stored password", async () => {
    const backend = fakeBackend();
    await withConfig(async (cfg, login) => {
      // the mariner fixes a typo in the username and saves; the password box
      // is empty, because it always is — nothing ever filled it
      login.setUser("skipper@boat.example");
      expect(login.password()).toBe("");
      await login.save();

      expect(cfg.error()).toBe("");
      // the trap: an empty box must not be sent as ""
      expect(backend.patches).toEqual([
        { credentials: { ocharts: { user: "skipper@boat.example", password: null } } },
      ]);
      // and the boat still knows its password
      expect(backend.stored.credentials.ocharts).toEqual({
        user: "skipper@boat.example",
        password: PASSWORD,
      });
      expect(cfg.meta()!.ocharts_password_set).toBe(true);
    });
  });

  test("a username edit is dirty the instant it is typed, not once it blurs", async () => {
    // Regression: Save is disabled until `dirty`, so if `dirty` only became
    // true on blur, the disabled button would swallow the very tap meant to
    // blur the field — type a username, press Save, watch nothing happen.
    // The field commits live (ServerSettings `Field.live`); this is the half
    // of that contract which lives here.
    fakeBackend();
    await withConfig(async (_cfg, login) => {
      expect(login.dirty()).toBe(false);
      login.setUser("skipper@boat.example");
      expect(login.dirty()).toBe(true);

      // and typing the username back to what the boat has is not a change
      login.setUser("skipper@example.com");
      expect(login.dirty()).toBe(false);
      // whitespace is not an edit either — save() trims before it sends
      login.setUser("  skipper@example.com  ");
      expect(login.dirty()).toBe(false);
    });
  });

  test("a typed password replaces the stored one, then leaves the client", async () => {
    const backend = fakeBackend();
    await withConfig(async (cfg, login) => {
      login.setPassword("new-secret");
      await login.save();

      expect(backend.patches).toEqual([
        { credentials: { ocharts: { user: "skipper@example.com", password: "new-secret" } } },
      ]);
      expect(backend.stored.credentials.ocharts.password).toBe("new-secret");
      // the draft is dropped the moment it lands: a secret must not linger
      // in a panel someone walks away from
      expect(login.password()).toBe("");
      expect(login.dirty()).toBe(false);
      expect(onScreen(cfg, login)).not.toContain("new-secret");
    });
  });

  test("the stored password is never rendered back from a GET", async () => {
    const backend = fakeBackend();
    await withConfig(async (cfg, login) => {
      expect(backend.stored.credentials.ocharts.password).toBe(PASSWORD); // guard the guard
      // the wire says null, so the client has nothing to put in the box
      expect(cfg.config()!.credentials.ocharts.password).toBeNull();
      expect(login.password()).toBe("");
      // it is known to exist, which is all the UI ever needed
      expect(login.stored()).toBe(true);
      expect(onScreen(cfg, login)).not.toContain(PASSWORD);

      // and it stays gone across a save and a refetch
      login.setUser("someone@else.example");
      await login.save();
      await cfg.refresh();
      expect(onScreen(cfg, login)).not.toContain(PASSWORD);
    });
  });

  test("with no password stored, the UI knows it and says nothing else", async () => {
    fakeBackend({ credentials: { ocharts: { user: "", password: "" } } });
    await withConfig(async (cfg, login) => {
      expect(login.stored()).toBe(false);
      expect(cfg.meta()!.ocharts_password_set).toBe(false);
      expect(login.user()).toBe("");
    });
  });

  test("forgetting the password is explicit, and is the only thing that clears it", async () => {
    const backend = fakeBackend();
    await withConfig(async (cfg, login) => {
      await login.forget();
      expect(backend.patches).toEqual([{ credentials: { ocharts: { password: "" } } }]);
      expect(backend.stored.credentials.ocharts.password).toBe("");
      expect(backend.stored.credentials.ocharts.user).toBe("skipper@example.com"); // untouched
      expect(cfg.meta()!.ocharts_password_set).toBe(false);
      expect(login.stored()).toBe(false);
    });
  });

  test("a refused save keeps the draft and never reports success", async () => {
    const backend = fakeBackend();
    await withConfig(async (cfg, login) => {
      backend.refuseWith(502, "o-charts.org rejected the login");
      login.setUser("typo@example.com");
      login.setPassword("wrong");
      await login.save();

      expect(cfg.error()).toBe("Not saved: o-charts.org rejected the login");
      expect(cfg.status()).toBe("");
      // the drafts survive: the mariner retries, they do not retype
      expect(login.user()).toBe("typo@example.com");
      expect(login.password()).toBe("wrong");
      expect(backend.stored.credentials.ocharts.password).toBe(PASSWORD);
    });
  });
});

describe("a refused write", () => {
  test("surfaces rather than silently doing nothing", async () => {
    const backend = fakeBackend();
    await withConfig(async (cfg) => {
      // 0 is out of the port range; the backend validates the merged whole
      const ok = await cfg.patch({ signalk: { port: 0 } }, { scope: "signalk" });

      expect(ok).toBe(false);
      // the reason, in words, with no pydantic.dev link in the cockpit
      expect(cfg.error()).toBe(
        "Not saved: signalk.port: Input should be greater than or equal to 1",
      );
      expect(cfg.status()).toBe("");
      expect(cfg.scope()).toBe("signalk");
      expect(backend.stored.signalk.port).toBe(3000);
      expect(cfg.config()!.signalk.port).toBe(3000); // shows the boat's truth
    });
  });

  test("a 409 while a chart install runs reads as a refusal, not a crash", async () => {
    const backend = fakeBackend();
    await withConfig(async (cfg) => {
      backend.refuseWith(409, "a chart install is running; chart configuration cannot change");
      const ok = await cfg.patch({ ocharts: { cell_budget_bytes: 1024 } }, { scope: "advanced" });

      expect(ok).toBe(false);
      expect(cfg.error()).toMatch(/a chart install is running/);
      expect(cfg.busy()).toBe(false); // the panel is usable again
      expect(cfg.offline()).toBe(""); // the server answered: this is not offline
    });
  });

  test("feedback is addressed, so one section's failure is not another's", async () => {
    fakeBackend();
    await withConfig(async (cfg, login) => {
      await cfg.patch({ signalk: { port: 0 } }, { scope: "signalk" });
      expect(cfg.scope()).toBe("signalk");

      // the o-charts section renders feedback only when the scope is its own
      await login.save();
      expect(cfg.scope()).toBe("ocharts");
      expect(cfg.error()).toBe("");
      expect(cfg.status()).toBe("Saved the o-charts username.");
    });
  });
});

describe("an unreachable server", () => {
  test("is a notice, not a failure: nothing rejects and nothing pretends", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    await withConfig(async (cfg, login) => {
      expect(cfg.offline()).toMatch(/Failed to fetch/);
      expect(cfg.config()).toBeNull(); // the panel shows its offline notice
      expect(cfg.loading()).toBe(false);
      expect(login.stored()).toBe(false);
      expect(login.user()).toBe("");

      // and a write while offline reports, rather than throws
      expect(await cfg.patch({ signalk: { enabled: false } })).toBe(false);
      expect(cfg.error()).toMatch(/Not saved: .*Failed to fetch/);
      expect(cfg.busy()).toBe(false);
    });
  });

  test("the notice clears once the boat answers again", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    await withConfig(async (cfg) => {
      expect(cfg.offline()).not.toBe("");
      fakeBackend();
      await cfg.refresh();
      expect(cfg.offline()).toBe("");
      expect(cfg.config()!.signalk.host).toBe("localhost");
    });
  });
});

describe("the rest of the document", () => {
  test("a patch is a slice, so two sections cannot revert each other", async () => {
    const backend = fakeBackend();
    await withConfig(async (cfg) => {
      await cfg.patch({ signalk: { host: "boat.local" } }, { scope: "signalk" });
      await cfg.patch({ data_root: "/mnt/charts" }, { scope: "advanced" });

      // neither wrote the other's key
      expect(backend.patches).toEqual([
        { signalk: { host: "boat.local" } },
        { data_root: "/mnt/charts" },
      ]);
      expect(backend.stored.signalk.host).toBe("boat.local");
      expect(backend.stored.data_root).toBe("/mnt/charts");
      expect(backend.stored.credentials.ocharts.password).toBe(PASSWORD); // untouched throughout
    });
  });

  test("the panel shows what the server stored, from the response", async () => {
    fakeBackend();
    await withConfig(async (cfg) => {
      await cfg.patch({ signalk: { tls: true, port: 3443 } }, { scope: "signalk" });
      expect(cfg.config()!.signalk.tls).toBe(true);
      // the server's own derivation of the URL, not ours
      expect(cfg.meta()!.signalk_url).toBe(
        "wss://localhost:3443/signalk/v1/stream?subscribe=none",
      );
      expect(cfg.status()).toBe("Saved.");
    });
  });

  test("a blank S-52 path is auto-detect, not 'unchanged' — the password's null is unique", async () => {
    const backend = fakeBackend({
      ocharts: { ...seed().ocharts, s52_path: "/opt/s57data" },
    });
    await withConfig(async (cfg) => {
      await cfg.patch({ ocharts: { s52_path: null } }, { scope: "advanced" });
      expect(backend.stored.ocharts.s52_path).toBeNull();
      expect(cfg.config()!.ocharts.s52_path).toBeNull();
    });
  });

  test("reload picks up a hand-edited file without a restart", async () => {
    fakeBackend();
    await withConfig(async (cfg) => {
      expect(await cfg.reload({ scope: "advanced" })).toBe(true);
      expect(cfg.status()).toBe("Reloaded from the file.");
      expect(cfg.config()!.data_root).toBe("/data");
    });
  });
});

describe("restart detection (meta.boot_id)", () => {
  // Both chartEpoch (chartProtocol.ts) and the `lastBootId` it is compared
  // against (serverConfig.ts, module scope — deliberately NOT scoped to one
  // ServerConfigController, since the settings panel that would own one is
  // lazily mounted and a restart must be caught even if it never opens) are
  // process-wide state, shared with every OTHER test file bun loads into the
  // same run (CLAUDE.md's one-module-registry-per-run gotcha). So nothing
  // here may assume "this is the very first fetch ever" — only that a KNOWN
  // backend's boot_id, once primed, does or does not recur. Each test primes
  // its own baseline first, then asserts the DELTA from there.

  test("two sessions against the SAME backend (no restart) never bump the epoch", async () => {
    fakeBackend(); // one simulated backend process -> one fixed boot_id
    await withConfig(async () => {}); // primes lastBootId to this backend's id
    const before = chartEpoch();
    await withConfig(async () => {}); // a second, later session; same backend
    expect(chartEpoch()).toBe(before);
  });

  test("a session against a DIFFERENT backend (a restart) bumps the epoch exactly once", async () => {
    fakeBackend();
    await withConfig(async () => {}); // primes lastBootId to backend #1's id
    const before = chartEpoch();
    // the backend restarts: a fresh fakeBackend() mints a fresh boot_id, the
    // same way a real restart mints Runtime.boot_id anew
    fakeBackend();
    await withConfig(async () => {});
    expect(chartEpoch()).toBe(before + 1);
  });

  test("seedChartDetail (no Settings panel involved) also catches the restart", async () => {
    // The whole point of module-scoping `lastBootId`: seedChartDetail runs
    // unconditionally at app boot and on a periodic re-poll (App.tsx) — a
    // mariner who never opens Settings across a deploy must still get a
    // fresh chart-tile cache.
    fakeBackend();
    await seedChartDetail();
    const before = chartEpoch();
    fakeBackend(); // restart
    await seedChartDetail();
    expect(chartEpoch()).toBe(before + 1);
  });
});
