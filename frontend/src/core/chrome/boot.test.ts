/**
 * The boot path, and the one bug in it that ships silently.
 *
 * `chrome/config.test.ts` already proves `adoptDefaults` seats a new widget.
 * This file proves the thing App.tsx actually does — including a faithful
 * re-enactment of `storedSignal`'s shallow merge, because the merge is where
 * the damage happens and no test that starts from a well-formed config can see
 * it.
 *
 * NB: needs `--conditions=browser` (the `test` script).
 */

import { describe, expect, test } from "bun:test";
import { bootChrome, seedDefaults } from "./boot";
import { DEFAULT_CHROME, type ChromeConfig } from "./config";
import { bandList, bandOf } from "./bands";
import {
  createRegistry,
  defineFeature,
  DEFAULT_DENSITY,
  type Instrument,
  type Registry,
} from "./registry";

function inst(over: Partial<Instrument> & { id: string }): Instrument {
  return {
    short: over.id.slice(0, 3).toUpperCase(),
    label: over.id,
    maxUrgency: "none",
    read: () => ({ value: "1.0" }),
    ...over,
  };
}

const v1: Registry = createRegistry([
  defineFeature({ id: "core", instruments: [inst({ id: "nav.sog" }), inst({ id: "nav.cog" })] }),
]);

/** The next release adds a widget to core and a whole new feature. */
const v2: Registry = createRegistry([
  defineFeature({
    id: "core",
    instruments: [inst({ id: "nav.sog" }), inst({ id: "nav.cog" }), inst({ id: "dbk" })],
  }),
  defineFeature({
    id: "routes",
    instruments: [inst({ id: "route.xte", band: "top", maxUrgency: "notice" })],
  }),
]);

/**
 * `persist.ts` storedSignal(), exactly — the load half. Copied rather than
 * imported because importing it would need a `localStorage` this runner has
 * not got, and the point of the test is this expression, not that module's
 * plumbing.
 */
const asStored = (parsed: unknown): ChromeConfig =>
  ({ ...DEFAULT_CHROME, ...(parsed as object) }) as ChromeConfig;

describe("seedDefaults", () => {
  // #DENS-SLIDER: the pointer guess now seeds ONLY `pointerCoarse` — a coarse
  // pointer opens the bidding on GLOVES, not on SIZE. Every device, coarse or
  // not, starts at `DEFAULT_CHROME.density` (`DEFAULT_DENSITY`): a mouse user
  // gets the bigger default too, which is the whole ask this split makes possible.
  test("a coarse pointer opens the bidding on pointerCoarse, not on size", () => {
    expect(seedDefaults(true).pointerCoarse).toBe(true);
    expect(seedDefaults(false).pointerCoarse).toBe(false);
    expect(seedDefaults(true).density).toBe(DEFAULT_DENSITY);
    expect(seedDefaults(false).density).toBe(DEFAULT_DENSITY);
  });

  test("seeds nothing else — band order is still adoptDefaults' job", () => {
    expect(seedDefaults(true).bands.rail.order).toEqual([]);
    expect(seedDefaults(true).enabled).toEqual({});
  });
});

describe("bootChrome", () => {
  test("a first run seats every widget in its declared home, in feature order", () => {
    const cfg = bootChrome(seedDefaults(false), v2);
    expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog", "dbk"]);
    expect(cfg.bands.top.order).toEqual(["route.xte"]);
  });

  test("THE TRAP: an upgrade over storedSignal's merge still sees the new widget", () => {
    // What v1 wrote to localStorage, then what persist.ts hands back on v2.
    const written = JSON.stringify(bootChrome(seedDefaults(true), v1));
    const loaded = asStored(JSON.parse(written));

    // The merge has already done its damage: `bands` came back wholesale from
    // the v1 payload, so DEFAULT_CHROME's `bands` contributed nothing at all.
    // Without bootChrome, `dbk` is simply not on this user's rail, forever.
    expect(bandList(v2, loaded, "rail").map((i) => i.id)).toEqual(["nav.sog", "nav.cog"]);

    const cfg = bootChrome(loaded, v2);
    expect(bandList(v2, cfg, "rail").map((i) => i.id)).toEqual(["nav.sog", "nav.cog", "dbk"]);
    expect(bandOf(cfg, "route.xte")).toBe("top");
  });

  test("the upgrade keeps what the user set: density, order and enablement", () => {
    const v1cfg = bootChrome(seedDefaults(true), v1);
    const moved: ChromeConfig = {
      ...v1cfg,
      enabled: { "nav.cog": false },
      bands: { ...v1cfg.bands, rail: { order: ["nav.cog", "nav.sog"] } },
    };
    const cfg = bootChrome(asStored(JSON.parse(JSON.stringify(moved))), v2);

    expect(cfg.density).toBe(DEFAULT_DENSITY);
    // Reordered by hand, and the newcomer went to the END rather than
    // rearranging anything (invariant #4: nothing re-ranks the user's rail).
    expect(cfg.bands.rail.order).toEqual(["nav.cog", "nav.sog", "dbk"]);
    expect(cfg.enabled["nav.cog"]).toBe(false);
    expect(bandList(v2, cfg, "rail").map((i) => i.id)).toEqual(["nav.sog", "dbk"]);
  });

  test("is idempotent — every boot runs it, and the second must not duplicate", () => {
    const once = bootChrome(seedDefaults(false), v2);
    expect(bootChrome(once, v2)).toEqual(once);
  });

  test("survives a config that was hand-edited into nonsense", () => {
    const junk = { density: "gloves", bands: { rail: {} } } as unknown as ChromeConfig;
    const cfg = bootChrome(junk, v2);
    // #DENS-SLIDER: anything that isn't a stored NUMBER — including a
    // hand-edited string — falls back to `DEFAULT_DENSITY`, the new default,
    // not `DESK`. See `config.ts` `normalize`'s doc for why "unknown" and
    // "legacy desk" get the same fallback.
    expect(cfg.density).toBe(DEFAULT_DENSITY);
    expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog", "dbk"]);
  });

  test("a downgrade keeps the placement of a widget this build lacks", () => {
    // v2's user opens v1: `dbk` is unknown here, so it is skipped, not pruned —
    // and it is still there when they upgrade back.
    const v2cfg = bootChrome(seedDefaults(false), v2);
    const back = bootChrome(v2cfg, v1);
    expect(back.bands.rail.order).toContain("dbk");
    expect(bandList(v1, back, "rail").map((i) => i.id)).toEqual(["nav.sog", "nav.cog"]);
  });
});

describe("bootChrome — migrating a config from before the dashboard slice existed", () => {
  /** A build with a board tab. The page's members are cog+sog. */
  const withPage: Registry = createRegistry([
    defineFeature({
      id: "core",
      instruments: [inst({ id: "nav.sog" }), inst({ id: "nav.cog" })],
      dashboard: [{ id: "nav", label: "Nav", instruments: ["nav.sog", "nav.cog"] }],
    }),
  ]);

  test("THE MIGRATION TRAP: a stored config with NO dashboard key gets its tabs SEEDED, not left blank", () => {
    // What an OLDER release wrote to localStorage: no `dashboard` at all, and a
    // rail the user had reordered. Re-enact persist.ts's shallow merge over it.
    const oldStored = {
      density: "helm",
      enabled: {},
      bands: { rail: { order: ["nav.cog", "nav.sog"] }, top: { order: [] } },
    };
    const loaded = asStored(JSON.parse(JSON.stringify(oldStored)));

    // The merge DID fill the missing top-level `dashboard` from DEFAULT_CHROME —
    // but as the EMPTY default, so without adoptDefaults the board has no tabs and
    // the whole dashboard is blank for everyone who ran the previous version.
    expect(loaded.dashboard.tabs).toEqual([]);

    const cfg = bootChrome(loaded, withPage);
    // Seeded — and the order follows the user's migrated RAIL, so the board is
    // exactly what the old rail-coupled board would have shown.
    expect(cfg.dashboard.tabs).toEqual([{ id: "nav", label: "Nav", order: ["nav.cog", "nav.sog"] }]);
  });

  test("is idempotent — the second boot after migrating changes nothing", () => {
    const oldStored = { density: "desk", enabled: {}, bands: { rail: { order: [] }, top: { order: [] } } };
    const once = bootChrome(asStored(JSON.parse(JSON.stringify(oldStored))), withPage);
    expect(bootChrome(once, withPage)).toEqual(once);
  });
});
