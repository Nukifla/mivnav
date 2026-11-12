/**
 * The device's chrome config, and the one thing about it that will bite:
 * `storedSignal` merges objects but takes arrays as-is, so a stored band order
 * is frozen at the version that wrote it. `adoptDefaults` is what unfreezes it.
 *
 * NB: needs `--conditions=browser` (the `test` script).
 */

import { describe, expect, test } from "bun:test";
import {
  addSkWidget,
  addTab,
  addWidgetToTab,
  addWidgetToTarget,
  adoptDefaults,
  applyArrangement,
  arrangementFromChrome,
  DEFAULT_CHROME,
  hasTarget,
  isBandTarget,
  isRailTarget,
  isSkWidgetId,
  mintSkWidgetId,
  mintTabId,
  mintWidgetToTarget,
  moveBand,
  moveTab,
  moveWidgetInTab,
  moveWidgetInTarget,
  moveWidgetToTab,
  moveWidgetToTarget,
  normalize,
  owningTab,
  RAIL_TARGET,
  TOP_TARGET,
  removeSkWidget,
  removeTab,
  removeWidget,
  removeWidgetFromTab,
  removeWidgetFromTarget,
  renameTab,
  updateSkWidget,
  setDensity,
  setEnabled,
  SK_WIDGET_PREFIX,
  swapOrder,
  targetOrder,
  type ChromeConfig,
} from "./config";
import {
  createRegistry,
  defineFeature,
  DEFAULT_DENSITY,
  DESK,
  HELM,
  type Instrument,
  type Registry,
} from "./registry";
import { bandList } from "./bands";

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
  defineFeature({
    id: "core",
    instruments: [inst({ id: "nav.sog" }), inst({ id: "depth.belowKeel", maxUrgency: "alarm" })],
  }),
]);

/** The next release adds a widget to core, and a whole new feature. */
const v2: Registry = createRegistry([
  defineFeature({
    id: "core",
    instruments: [
      inst({ id: "nav.sog" }),
      inst({ id: "depth.belowKeel", maxUrgency: "alarm" }),
      inst({ id: "env.tide" }),
    ],
  }),
  defineFeature({
    id: "routes",
    instruments: [inst({ id: "route.xte", band: "top", maxUrgency: "notice" })],
  }),
]);

/**
 * A build whose features contribute board tabs (`reg.pages` non-empty). The page
 * lists cog before sog, but the rail order is sog before cog — so a tab seeded
 * from this proves the seed follows the RAIL, which is what the old rail-coupled
 * board rendered.
 */
const withPages: Registry = createRegistry([
  defineFeature({
    id: "core",
    instruments: [inst({ id: "nav.sog" }), inst({ id: "nav.cog" }), inst({ id: "env.tide" })],
    dashboard: [{ id: "nav", label: "Nav", instruments: ["nav.cog", "nav.sog"] }],
  }),
]);

describe("DEFAULT_CHROME", () => {
  // #DENS-SLIDER: the default is DEFAULT_DENSITY — the old Helm size, now the
  // midpoint of the extended scale — on every device, not just a
  // coarse-pointer one. `pointerCoarse` keeps the old desk (mouse) meaning;
  // `boot.ts`'s `seedDefaults` overrides both from the real pointer on first run.
  test("starts at DEFAULT_DENSITY, a fine pointer, with nothing turned off", () => {
    expect(DEFAULT_CHROME.density).toBe(DEFAULT_DENSITY);
    expect(DEFAULT_CHROME.pointerCoarse).toBe(false);
    expect(DEFAULT_CHROME.enabled).toEqual({});
  });

  test("has an entry for every band and seeds no order — adoptDefaults fills it from the registry", () => {
    // The default order is the order the features declare their instruments in,
    // stated once rather than duplicated here and left to drift.
    expect(DEFAULT_CHROME.bands).toEqual({ rail: { order: [] }, top: { order: [] } });
  });

  test("seeds no board tabs — adoptDefaults fills them from reg.pages", () => {
    expect(DEFAULT_CHROME.dashboard).toEqual({ tabs: [], widgets: {} });
  });
});

describe("adoptDefaults — a fresh device", () => {
  test("seats every widget in its home band, in feature order, on", () => {
    const cfg = adoptDefaults(DEFAULT_CHROME, v2);
    expect(cfg.bands.rail.order).toEqual(["nav.sog", "depth.belowKeel", "env.tide"]);
    expect(cfg.bands.top.order).toEqual(["route.xte"]);
    expect(cfg.enabled).toEqual({}); // on: adding a feature must never silently hide it
    expect(bandList(v2, cfg, "rail")).toHaveLength(3);
  });

  test("is idempotent — every boot runs it, and the second one changes nothing", () => {
    const once = adoptDefaults(DEFAULT_CHROME, v2);
    expect(adoptDefaults(once, v2)).toEqual(once);
  });

  test("never mutates the config it is given", () => {
    const before = structuredClone(DEFAULT_CHROME);
    adoptDefaults(DEFAULT_CHROME, v2);
    expect(DEFAULT_CHROME).toEqual(before);
  });

  test("returns fresh arrays, so a Solid setter sees a new value", () => {
    const cfg = adoptDefaults(DEFAULT_CHROME, v2);
    expect(cfg.bands.rail.order).not.toBe(DEFAULT_CHROME.bands.rail.order);
  });
});

describe("adoptDefaults — THE TRAP: storedSignal merges objects but takes arrays as-is", () => {
  /** Exactly what persist.ts does with a stored object: `{ ...initial, ...parsed }`. */
  const asStoredSignalWouldLoad = (stored: ChromeConfig): ChromeConfig => ({
    ...DEFAULT_CHROME,
    ...structuredClone(stored),
  });

  /** A config written by the v1 release, on a device that has been in use. */
  const storedByV1 = (): ChromeConfig => {
    const cfg = adoptDefaults(DEFAULT_CHROME, v1);
    cfg.bands.rail.order = ["depth.belowKeel", "nav.sog"]; // the user reordered it
    cfg.enabled["nav.sog"] = false; // and turned one off
    return cfg;
  };

  test("without adoptDefaults, a widget added in v2 NEVER appears for an existing user", () => {
    // No error, no empty slot — the feature simply does not exist for anyone who
    // ran v1. This is the bug the whole function is here to prevent, and it is
    // invisible on a fresh device, which is where it would be tested by hand.
    const loaded = asStoredSignalWouldLoad(storedByV1());
    expect(loaded.bands.rail.order).not.toContain("env.tide");
    expect(bandList(v2, loaded, "rail").map((i) => i.id)).not.toContain("env.tide");
    expect(bandList(v2, loaded, "top")).toEqual([]); // the entire routes feature is missing
  });

  test("with adoptDefaults, the new widget appears — at the end, on", () => {
    const cfg = adoptDefaults(asStoredSignalWouldLoad(storedByV1()), v2);
    expect(cfg.bands.rail.order).toEqual(["depth.belowKeel", "nav.sog", "env.tide"]);
    expect(cfg.bands.top.order).toEqual(["route.xte"]);
    expect(bandList(v2, cfg, "top").map((i) => i.id)).toEqual(["route.xte"]);
  });

  test("and what the user already set is untouched — placement is added, never reordered", () => {
    const cfg = adoptDefaults(asStoredSignalWouldLoad(storedByV1()), v2);
    expect(cfg.bands.rail.order.slice(0, 2)).toEqual(["depth.belowKeel", "nav.sog"]);
    expect(cfg.enabled["nav.sog"]).toBe(false); // still off; adopting is not resetting
    expect(cfg.density).toBe(DEFAULT_DENSITY);
  });

  test("a widget the user moved to another band is not re-seated in its home", () => {
    const moved = adoptDefaults(DEFAULT_CHROME, v2);
    moved.bands.rail.order = ["nav.sog", "depth.belowKeel", "env.tide", "route.xte"];
    moved.bands.top.order = [];
    const cfg = adoptDefaults(moved, v2);
    expect(cfg.bands.top.order).toEqual([]);
    expect(cfg.bands.rail.order.filter((id) => id === "route.xte")).toHaveLength(1);
  });

  test("a widget the user turned OFF is still 'seen' — it is not re-added on every boot", () => {
    const cfg = adoptDefaults(DEFAULT_CHROME, v2);
    cfg.enabled["env.tide"] = false;
    const next = adoptDefaults(cfg, v2);
    expect(next.bands.rail.order.filter((id) => id === "env.tide")).toHaveLength(1);
    expect(next.enabled["env.tide"]).toBe(false);
  });

  test("downgrading keeps the id: a feature this build lacks is left alone, not pruned", () => {
    // Pruning would lose the user's placement the moment a feature is absent for
    // one boot. bands.configurable skips an unknown id harmlessly.
    const cfg = adoptDefaults(adoptDefaults(DEFAULT_CHROME, v2), v1);
    expect(cfg.bands.top.order).toEqual(["route.xte"]);
    expect(cfg.bands.rail.order).toContain("env.tide");
    expect(bandList(v1, cfg, "top")).toEqual([]); // absent from the screen, present in the config
  });

  test("upgrade, downgrade, upgrade — the order survives the round trip", () => {
    const v2cfg = adoptDefaults(DEFAULT_CHROME, v2);
    expect(adoptDefaults(adoptDefaults(v2cfg, v1), v2)).toEqual(v2cfg);
  });
});

describe("adoptDefaults — seeds the board's tabs from reg.pages (the DE-A decoupling)", () => {
  test("one tab per registry page, its order READ OFF the rail — identical to the old board", () => {
    // rail seeds to [nav.sog, nav.cog, env.tide]; the page's members are cog+sog,
    // so the tab's order is the RAIL order intersected with them: sog, then cog —
    // exactly what boardPage rendered before the tab had its own order.
    const cfg = adoptDefaults(DEFAULT_CHROME, withPages);
    expect(cfg.dashboard.tabs).toEqual([{ id: "nav", label: "Nav", order: ["nav.sog", "nav.cog"] }]);
  });

  test("a build with no pages seeds no tabs", () => {
    expect(adoptDefaults(DEFAULT_CHROME, v2).dashboard.tabs).toEqual([]);
  });

  test("is idempotent — a second boot neither duplicates nor re-seeds the tab", () => {
    const once = adoptDefaults(DEFAULT_CHROME, withPages);
    expect(adoptDefaults(once, withPages)).toEqual(once);
  });

  test("a page already present as a tab is left ALONE — a user's tab edit survives adopting", () => {
    // A later chunk lets the user reorder a tab; adopting must not reset it, the
    // same discipline as band order (invariant #4).
    const edited: ChromeConfig = {
      ...adoptDefaults(DEFAULT_CHROME, withPages),
      dashboard: { tabs: [{ id: "nav", label: "Nav", order: ["nav.cog"] }], widgets: {} },
    };
    expect(adoptDefaults(edited, withPages).dashboard.tabs).toEqual([
      { id: "nav", label: "Nav", order: ["nav.cog"] },
    ]);
  });

  test("returns fresh tab arrays, so a Solid setter sees a new value", () => {
    const seeded = adoptDefaults(DEFAULT_CHROME, withPages);
    const again = adoptDefaults(seeded, withPages);
    expect(again.dashboard.tabs).not.toBe(seeded.dashboard.tabs);
    expect(again.dashboard.tabs[0].order).not.toBe(seeded.dashboard.tabs[0].order);
  });

  test("never mutates the config it is given", () => {
    const before = structuredClone(DEFAULT_CHROME);
    adoptDefaults(DEFAULT_CHROME, withPages);
    expect(DEFAULT_CHROME).toEqual(before);
  });
});

describe("owningTab — the click→open-tab resolver (b)", () => {
  const cfg = (): ChromeConfig => ({
    ...DEFAULT_CHROME,
    dashboard: {
      tabs: [
        { id: "nav", label: "Nav", order: ["nav.sog", "nav.cog"] },
        { id: "pilot", label: "Pilot", order: ["ap.status", "ap.control", "ap.rudder"] },
      ],
      widgets: {},
    },
  });

  test("maps an instrument id to the tab whose order contains it", () => {
    expect(owningTab(cfg(), "nav.cog")?.id).toBe("nav");
    // ap.status resolves to Pilot — this is what lands a rail-tile tap there.
    expect(owningTab(cfg(), "ap.status")?.id).toBe("pilot");
    expect(owningTab(cfg(), "ap.control")?.id).toBe("pilot");
  });

  test("an instrument on no tab resolves to undefined (App then just opens the board)", () => {
    expect(owningTab(cfg(), "route.xte")).toBeUndefined();
  });

  test("the FIRST tab that contains it wins", () => {
    const twice: ChromeConfig = {
      ...DEFAULT_CHROME,
      dashboard: {
        tabs: [
          { id: "a", label: "A", order: ["x"] },
          { id: "b", label: "B", order: ["x"] },
        ],
        widgets: {},
      },
    };
    expect(owningTab(twice, "x")?.id).toBe("a");
  });
});

describe("normalize — a config that came back structurally wrong", () => {
  test("a hand-edited storage missing a band gets one, rather than crashing the rail", () => {
    const wrong = { density: "desk", enabled: {}, bands: { rail: { order: ["nav.sog"] } } };
    const cfg = normalize(wrong as unknown as ChromeConfig);
    expect(cfg.bands.top).toEqual({ order: [] });
    expect(cfg.bands.rail.order).toEqual(["nav.sog"]);
  });

  test("a band this build no longer has is dropped", () => {
    const wrong = { ...DEFAULT_CHROME, bands: { ...DEFAULT_CHROME.bands, sidebar: { order: ["x"] } } };
    expect(Object.keys(normalize(wrong as unknown as ChromeConfig).bands)).toEqual(["rail", "top"]);
  });

  // #DENS-SLIDER MIGRATION (see `normalize`'s doc for the full reasoning): a
  // stored NUMBER is clamped and kept; anything else — a typo, AND the legacy
  // `"desk"`/`"helm"` strings — becomes `DEFAULT_DENSITY`, the new default. A
  // `"desk"` string was never a considered choice, only `boot.ts`'s first-run
  // GUESS written back on the next tick, indistinguishable from a deliberate
  // pick — so it is treated as a guess and discarded, landing every
  // pre-slider device (including the mouse desktop this whole feature is
  // for) on the bigger default. A device that was genuinely `"helm"` reads
  // as `DEFAULT_DENSITY` too, so it is pixel-identical to before.
  test("a nonsense density falls back to DEFAULT_DENSITY, not DESK", () => {
    expect(normalize({ ...DEFAULT_CHROME, density: "tablet" as never }).density).toBe(
      DEFAULT_DENSITY,
    );
  });

  test("a legacy desk/helm string is migrated to DEFAULT_DENSITY — a guess, not a preference", () => {
    expect(normalize({ ...DEFAULT_CHROME, density: "desk" as never }).density).toBe(
      DEFAULT_DENSITY,
    );
    expect(normalize({ ...DEFAULT_CHROME, density: "helm" as never }).density).toBe(
      DEFAULT_DENSITY,
    );
  });

  test("a stored number is clamped into [DESK, HELM], not discarded", () => {
    expect(normalize({ ...DEFAULT_CHROME, density: 0.3 }).density).toBe(0.3);
    expect(normalize({ ...DEFAULT_CHROME, density: 5 }).density).toBe(HELM);
    expect(normalize({ ...DEFAULT_CHROME, density: -2 }).density).toBe(DESK);
    expect(normalize({ ...DEFAULT_CHROME, density: Number.NaN }).density).toBe(HELM);
  });

  // `pointerCoarse` is a BRAND NEW field: no legacy blob ever wrote it, so a
  // config that skipped `App.tsx`'s shallow-merge-then-normalize (the ordinary
  // "adding a field" path) still needs a total fallback here.
  test("pointerCoarse defaults to false — a mouse — when absent or the wrong type", () => {
    expect(normalize({ ...DEFAULT_CHROME, pointerCoarse: undefined as never }).pointerCoarse).toBe(
      false,
    );
    expect(normalize({ ...DEFAULT_CHROME, pointerCoarse: "yes" as never }).pointerCoarse).toBe(false);
    expect(normalize({ ...DEFAULT_CHROME, pointerCoarse: true }).pointerCoarse).toBe(true);
  });

  test("a missing enabled map becomes empty — everything on", () => {
    const cfg = normalize({ ...DEFAULT_CHROME, enabled: null as never });
    expect(cfg.enabled).toEqual({});
  });

  test("a missing dashboard becomes the empty default — adoptDefaults then re-seeds it", () => {
    const wrong = { density: "desk", enabled: {}, bands: { rail: { order: [] }, top: { order: [] } } };
    expect(normalize(wrong as unknown as ChromeConfig).dashboard).toEqual({ tabs: [], widgets: {} });
    expect(adoptDefaults(normalize(wrong as unknown as ChromeConfig), withPages).dashboard.tabs).toEqual(
      [{ id: "nav", label: "Nav", order: ["nav.sog", "nav.cog"] }],
    );
  });

  test("a normalized config is ready for adoptDefaults", () => {
    const cfg = adoptDefaults(normalize({ bands: {} } as unknown as ChromeConfig), v2);
    expect(cfg.bands.rail.order).toEqual(["nav.sog", "depth.belowKeel", "env.tide"]);
    expect(cfg.bands.top.order).toEqual(["route.xte"]);
  });
});

describe("the config editor's writers — pure, and the component's only mutation", () => {
  const seed = () => adoptDefaults(DEFAULT_CHROME, v2);

  test("setEnabled records only OFF, sparsely — on deletes the key", () => {
    const off = setEnabled(seed(), "nav.sog", false);
    expect(off.enabled).toEqual({ "nav.sog": false });
    // Back on removes the row rather than writing `true`, so the blob never
    // grows a line per untouched widget.
    expect(setEnabled(off, "nav.sog", true).enabled).toEqual({});
  });

  test("setEnabled does not mutate its input", () => {
    const before = seed();
    setEnabled(before, "nav.sog", false);
    expect(before.enabled).toEqual({});
  });

  test("setDensity swaps the density and touches nothing else", () => {
    const cfg = setDensity(seed(), DESK);
    expect(cfg.density).toBe(DESK);
    expect(cfg.bands).toEqual(seed().bands);
  });

  test("setDensity clamps into [DESK, HELM] — a slider event cannot smuggle out of range", () => {
    expect(setDensity(seed(), 5).density).toBe(HELM);
    expect(setDensity(seed(), -1).density).toBe(DESK);
  });

  test("swapOrder exchanges two ids within a band", () => {
    const cfg = swapOrder(seed(), "rail", "nav.sog", "env.tide");
    expect(cfg.bands.rail.order).toEqual(["env.tide", "depth.belowKeel", "nav.sog"]);
  });

  test("swapOrder is a no-op when an id is not in the band, and never mutates", () => {
    const before = seed();
    const same = swapOrder(before, "rail", "nav.sog", "route.xte"); // route.xte is in top
    expect(same.bands.rail.order).toEqual(before.bands.rail.order);
    swapOrder(before, "rail", "nav.sog", "env.tide");
    expect(before.bands.rail.order).toEqual(["nav.sog", "depth.belowKeel", "env.tide"]);
  });

  test("moveBand appends to the target and removes from the source, keeping enablement", () => {
    const cfg = moveBand(setEnabled(seed(), "nav.sog", false), "nav.sog", "top");
    expect(cfg.bands.rail.order).toEqual(["depth.belowKeel", "env.tide"]);
    expect(cfg.bands.top.order).toEqual(["route.xte", "nav.sog"]);
    expect(cfg.enabled).toEqual({ "nav.sog": false });
  });

  test("moveBand repairs a config that listed a widget in two bands", () => {
    const doubled: ChromeConfig = {
      ...seed(),
      bands: { rail: { order: ["nav.sog"] }, top: { order: ["nav.sog"] } },
    };
    const cfg = moveBand(doubled, "nav.sog", "top");
    expect(cfg.bands.rail.order).toEqual([]);
    expect(cfg.bands.top.order).toEqual(["nav.sog"]);
  });
});

describe("the board editor's writers — the dashboard's tab layout, pure and total", () => {
  /** Two tabs, so moving between them and removing one both have somewhere to go. */
  const board = (): ChromeConfig => ({
    ...DEFAULT_CHROME,
    dashboard: {
      tabs: [
        { id: "nav", label: "Nav", order: ["nav.sog", "nav.cog", "env.tide"] },
        { id: "wind", label: "Wind", order: ["wind.aws", "wind.awa"] },
      ],
      widgets: {},
    },
  });

  describe("moveWidgetInTab — the per-card up/down", () => {
    test("swaps two ids within the tab, leaving other tabs alone", () => {
      const cfg = moveWidgetInTab(board(), "nav", "nav.sog", "nav.cog");
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.cog", "nav.sog", "env.tide"]);
      expect(cfg.dashboard.tabs[1].order).toEqual(["wind.aws", "wind.awa"]);
    });

    test("swaps VISIBLE neighbours even when they are not adjacent in the raw order", () => {
      // sog and tide bracket cog; the editor draws them as neighbours when cog is
      // hidden, and passing those two ids swaps past the hidden middle honestly.
      const cfg = moveWidgetInTab(board(), "nav", "nav.sog", "env.tide");
      expect(cfg.dashboard.tabs[0].order).toEqual(["env.tide", "nav.cog", "nav.sog"]);
    });

    test("is a no-op when the tab is gone or an id is not on it, and never mutates", () => {
      const before = board();
      expect(moveWidgetInTab(before, "ghost", "a", "b")).toBe(before);
      expect(moveWidgetInTab(before, "nav", "nav.sog", "wind.aws").dashboard.tabs[0].order).toEqual([
        "nav.sog",
        "nav.cog",
        "env.tide",
      ]);
      expect(before.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog", "env.tide"]);
    });
  });

  describe("moveWidgetToTab — send a card to another tab", () => {
    test("removes from the source and appends to the target", () => {
      const cfg = moveWidgetToTab(board(), "nav.cog", "wind");
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "env.tide"]);
      expect(cfg.dashboard.tabs[1].order).toEqual(["wind.aws", "wind.awa", "nav.cog"]);
    });

    test("moving the only widget out empties its tab without deleting the tab", () => {
      const one: ChromeConfig = {
        ...DEFAULT_CHROME,
        dashboard: { tabs: [{ id: "a", label: "A", order: ["x"] }, { id: "b", label: "B", order: [] }], widgets: {} },
      };
      const cfg = moveWidgetToTab(one, "x", "b");
      expect(cfg.dashboard.tabs[0]).toEqual({ id: "a", label: "A", order: [] });
      expect(cfg.dashboard.tabs[1].order).toEqual(["x"]);
    });

    test("repairs a widget listed on two tabs — removed everywhere, then seated once", () => {
      const doubled: ChromeConfig = {
        ...DEFAULT_CHROME,
        dashboard: {
          tabs: [{ id: "a", label: "A", order: ["x"] }, { id: "b", label: "B", order: ["x"] }],
          widgets: {},
        },
      };
      const cfg = moveWidgetToTab(doubled, "x", "b");
      expect(cfg.dashboard.tabs[0].order).toEqual([]);
      expect(cfg.dashboard.tabs[1].order).toEqual(["x"]);
    });

    test("is a no-op when the target tab does not exist, and never mutates", () => {
      const before = board();
      expect(moveWidgetToTab(before, "nav.sog", "ghost")).toBe(before);
      moveWidgetToTab(before, "nav.cog", "wind");
      expect(before.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog", "env.tide"]);
    });
  });

  describe("mintTabId / addTab", () => {
    test("mints the first free tab-N, skipping ids already taken", () => {
      expect(mintTabId(board())).toBe("tab-1");
      const withTab1: ChromeConfig = {
        ...DEFAULT_CHROME,
        dashboard: { tabs: [{ id: "tab-1", label: "Tab 1", order: [] }], widgets: {} },
      };
      expect(mintTabId(withTab1)).toBe("tab-2");
    });

    test("appends an empty tab with a minted id and a default label", () => {
      const cfg = addTab(board());
      expect(cfg.dashboard.tabs).toHaveLength(3);
      expect(cfg.dashboard.tabs[2]).toEqual({ id: "tab-1", label: "Tab 3", order: [] });
    });

    test("honours an explicit label", () => {
      expect(addTab(board(), "Sails").dashboard.tabs[2].label).toBe("Sails");
    });

    test("never mutates its input", () => {
      const before = board();
      addTab(before);
      expect(before.dashboard.tabs).toHaveLength(2);
    });
  });

  describe("renameTab", () => {
    test("changes the label and touches nothing else", () => {
      const cfg = renameTab(board(), "nav", "Navigation");
      expect(cfg.dashboard.tabs[0]).toEqual({
        id: "nav",
        label: "Navigation",
        order: ["nav.sog", "nav.cog", "env.tide"],
      });
      expect(cfg.dashboard.tabs[1]).toEqual(board().dashboard.tabs[1]);
    });

    test("is a no-op when the tab is gone", () => {
      const before = board();
      expect(renameTab(before, "ghost", "X")).toBe(before);
    });
  });

  describe("removeTab — guarded so the board is never left empty", () => {
    test("drops the tab; its widgets are not touched elsewhere", () => {
      const cfg = removeTab(board(), "wind");
      expect(cfg.dashboard.tabs.map((t) => t.id)).toEqual(["nav"]);
    });

    test("refuses to remove the LAST tab — a board needs one tab to arrange", () => {
      const one: ChromeConfig = {
        ...DEFAULT_CHROME,
        dashboard: { tabs: [{ id: "nav", label: "Nav", order: ["nav.sog"] }], widgets: {} },
      };
      expect(removeTab(one, "nav")).toBe(one);
    });

    test("is a no-op when the tab is not there, and never mutates", () => {
      const before = board();
      expect(removeTab(before, "ghost")).toBe(before);
      removeTab(before, "wind");
      expect(before.dashboard.tabs).toHaveLength(2);
    });

    test("removing a tab this fixture does not have ('pilot') is a plain no-op", () => {
      // The Pilot tab is an ordinary config tab now (the autopilot is a normal
      // feature); it just is not in THIS fixture, so removing it changes nothing.
      const before = board();
      expect(removeTab(before, "pilot").dashboard.tabs.map((t) => t.id)).toEqual(["nav", "wind"]);
    });
  });

  describe("moveTab — reorder the config tabs among themselves", () => {
    const three = (): ChromeConfig => ({
      ...DEFAULT_CHROME,
      dashboard: {
        tabs: [
          { id: "a", label: "A", order: [] },
          { id: "b", label: "B", order: [] },
          { id: "c", label: "C", order: [] },
        ],
        widgets: {},
      },
    });

    test("swaps a tab back one place (dir 1) with its neighbour", () => {
      expect(moveTab(three(), "a", 1).dashboard.tabs.map((t) => t.id)).toEqual(["b", "a", "c"]);
    });

    test("swaps a tab forward one place (dir -1) with its neighbour", () => {
      expect(moveTab(three(), "c", -1).dashboard.tabs.map((t) => t.id)).toEqual(["a", "c", "b"]);
    });

    test("is a no-op at the front end (cannot move the first tab forward)", () => {
      const before = three();
      expect(moveTab(before, "a", -1)).toBe(before);
    });

    test("is a no-op at the back end (cannot move the last tab back)", () => {
      const before = three();
      expect(moveTab(before, "c", 1)).toBe(before);
    });

    test("is a no-op on a tab that is not there, and never mutates", () => {
      const before = three();
      expect(moveTab(before, "ghost", 1)).toBe(before);
      moveTab(before, "a", 1);
      expect(before.dashboard.tabs.map((t) => t.id)).toEqual(["a", "b", "c"]);
    });

    test("'pilot' is not a config tab, so it can never be a target — reorder ignores it", () => {
      const before = three();
      expect(moveTab(before, "pilot", -1)).toBe(before);
    });
  });

  describe("removeWidgetFromTab — take a registry instrument off ONE tab", () => {
    test("drops the id from the named tab only, leaving other tabs and enablement alone", () => {
      const cfg = removeWidgetFromTab(board(), "nav", "nav.cog");
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "env.tide"]);
      expect(cfg.dashboard.tabs[1].order).toEqual(["wind.aws", "wind.awa"]);
      expect(cfg.enabled).toEqual({}); // still on in the rail / elsewhere
    });

    test("removes the last widget, leaving an empty tab (not a deleted one)", () => {
      const one: ChromeConfig = {
        ...DEFAULT_CHROME,
        dashboard: { tabs: [{ id: "a", label: "A", order: ["x"] }], widgets: {} },
      };
      const cfg = removeWidgetFromTab(one, "a", "x");
      expect(cfg.dashboard.tabs[0]).toEqual({ id: "a", label: "A", order: [] });
    });

    test("drops only from the named tab when the id is listed on two", () => {
      const cfg = removeWidgetFromTab(addWidgetToTab(board(), "wind", "nav.cog"), "nav", "nav.cog");
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "env.tide"]);
      expect(cfg.dashboard.tabs[1].order).toEqual(["wind.aws", "wind.awa", "nav.cog"]);
    });

    test("is a no-op when the tab is gone or the id is not on it, and never mutates", () => {
      const before = board();
      expect(removeWidgetFromTab(before, "ghost", "nav.sog")).toBe(before);
      expect(removeWidgetFromTab(before, "nav", "wind.aws")).toBe(before);
      removeWidgetFromTab(before, "nav", "nav.sog");
      expect(before.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog", "env.tide"]);
    });
  });

  describe("updateSkWidget — edit a user SignalK-path widget's spec", () => {
    const seed = () => addSkWidget(board(), "nav", { path: "electrical.batteries.house.voltage" });

    test("merges the patch into the stored spec", () => {
      const { cfg, id } = seed();
      const next = updateSkWidget(cfg, id, { label: "House V", decimals: 2 });
      expect(next.dashboard.widgets[id].spec).toEqual({
        path: "electrical.batteries.house.voltage",
        label: "House V",
        decimals: 2,
      });
    });

    test("changing the path rewrites it in place (the widget now reads the new path)", () => {
      const { cfg, id } = seed();
      const next = updateSkWidget(cfg, id, { path: "propulsion.0.temperature" });
      expect(next.dashboard.widgets[id].spec.path).toBe("propulsion.0.temperature");
    });

    test("clearing an override (undefined or '') removes it so the default is derived again", () => {
      const withLabel = addSkWidget(board(), "nav", { path: "x", label: "Old", unit: "V" });
      const cleared = updateSkWidget(withLabel.cfg, withLabel.id, { label: "", unit: undefined });
      expect(cleared.dashboard.widgets[withLabel.id].spec).toEqual({ path: "x" });
    });

    test("decimals: 0 is a real value and survives (not treated as cleared)", () => {
      const { cfg, id } = seed();
      const next = updateSkWidget(cfg, id, { decimals: 0 });
      expect(next.dashboard.widgets[id].spec.decimals).toBe(0);
    });

    test("is a no-op on an id that is not a stored SK widget, and never mutates", () => {
      const { cfg } = seed();
      expect(updateSkWidget(cfg, "sk:99", { label: "nope" })).toBe(cfg);
      expect(updateSkWidget(cfg, "nav.sog", { label: "nope" })).toBe(cfg);
    });
  });

  describe("addWidgetToTab — DE-C's picker places any instrument onto a tab", () => {
    test("appends the id to the target tab, leaving other tabs and enablement alone", () => {
      const cfg = addWidgetToTab(board(), "wind", "env.tide");
      expect(cfg.dashboard.tabs[1].order).toEqual(["wind.aws", "wind.awa", "env.tide"]);
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog", "env.tide"]);
      expect(cfg.enabled).toEqual({});
    });

    test("re-adding an id already on the tab is a no-op on order — never a duplicate", () => {
      const cfg = addWidgetToTab(board(), "nav", "nav.sog");
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog", "env.tide"]);
    });

    test("enables a previously-hidden widget (clears the sparse off key) as it places it", () => {
      const hidden: ChromeConfig = { ...board(), enabled: { "wind.aws": false } };
      const cfg = addWidgetToTab(hidden, "nav", "wind.aws");
      expect(cfg.enabled).toEqual({});
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog", "env.tide", "wind.aws"]);
    });

    test("re-enables an already-placed but hidden widget without duplicating it", () => {
      const hidden: ChromeConfig = { ...board(), enabled: { "nav.cog": false } };
      const cfg = addWidgetToTab(hidden, "nav", "nav.cog");
      expect(cfg.enabled).toEqual({});
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog", "env.tide"]);
    });

    test("is a no-op when the target tab does not exist, and never mutates", () => {
      const before = board();
      expect(addWidgetToTab(before, "ghost", "nav.sog")).toBe(before);
      addWidgetToTab(before, "wind", "env.tide");
      expect(before.dashboard.tabs[1].order).toEqual(["wind.aws", "wind.awa"]);
    });
  });

  describe("addSkWidget / removeSkWidget — DE-E's user SignalK-path widgets", () => {
    test("mints a distinctly-prefixed id, stores the spec, seats it on the tab, enables it", () => {
      const { cfg, id } = addSkWidget(board(), "nav", { path: "electrical.batteries.house.voltage" });
      expect(isSkWidgetId(id)).toBe(true);
      expect(id.startsWith(SK_WIDGET_PREFIX)).toBe(true);
      expect(cfg.dashboard.widgets[id].spec).toEqual({ path: "electrical.batteries.house.voltage" });
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog", "env.tide", id]);
      expect(id in cfg.enabled).toBe(false); // sparse: absent means ON
    });

    test("the minted id cannot collide with a registry instrument id (the prefix)", () => {
      const { id } = addSkWidget(board(), "nav", { path: "x" });
      // registry ids are dotted names like nav.sog; the sk: prefix keeps them apart.
      expect(id).not.toContain("nav.sog");
      expect(id).toMatch(/^sk:\d+$/);
    });

    test("consecutive adds mint distinct ids", () => {
      const first = addSkWidget(board(), "nav", { path: "a" });
      const second = addSkWidget(first.cfg, "nav", { path: "b" });
      expect(second.id).not.toBe(first.id);
      expect(mintSkWidgetId(second.cfg)).not.toBe(first.id);
      expect(mintSkWidgetId(second.cfg)).not.toBe(second.id);
    });

    test("carries label/unit/decimals overrides through verbatim", () => {
      const spec = { path: "propulsion.0.revolutions", label: "Engine RPM", unit: "rpm", decimals: 0 };
      const { cfg, id } = addSkWidget(board(), "nav", spec);
      expect(cfg.dashboard.widgets[id].spec).toEqual(spec);
    });

    test("is a no-op-shaped return when the target tab is gone (no orphan spec)", () => {
      const before = board();
      const { cfg, id } = addSkWidget(before, "ghost", { path: "a" });
      expect(cfg).toBe(before);
      expect(id in cfg.dashboard.widgets).toBe(false);
    });

    test("removeSkWidget drops the spec and takes the id off every tab", () => {
      const seed = addSkWidget(board(), "nav", { path: "a" });
      // also list it on a second tab, to prove it is removed everywhere
      const onTwo = moveWidgetToTab(seed.cfg, seed.id, "wind");
      const withNav = addWidgetToTab(onTwo, "nav", seed.id);
      const cfg = removeSkWidget(withNav, seed.id);
      expect(seed.id in cfg.dashboard.widgets).toBe(false);
      expect(cfg.dashboard.tabs[0].order).not.toContain(seed.id);
      expect(cfg.dashboard.tabs[1].order).not.toContain(seed.id);
    });

    test("removeSkWidget is a no-op on an id that is not a stored SK widget", () => {
      const before = board();
      expect(removeSkWidget(before, "sk:99")).toBe(before);
      expect(removeSkWidget(before, "nav.sog")).toBe(before); // a registry id is never one
    });

    test("normalize MIGRATES legacy skWidgets onto the widgets store, dropping malformed ones", () => {
      // A config written before the store was generalized carries `skWidgets`.
      // normalize lifts each well-formed entry onto `{kind:"sk", spec}` — so a
      // user's existing SignalK dashboard survives — and drops the pathless ones.
      const raw = {
        ...DEFAULT_CHROME,
        dashboard: {
          tabs: [],
          skWidgets: {
            "sk:1": { path: "electrical.voltage", unit: "V" },
            "sk:2": { path: "" }, // malformed — no path
            "sk:3": {} as never, // malformed — no path key
          },
        },
      } as unknown as ChromeConfig;
      const cfg = normalize(raw);
      expect(Object.keys(cfg.dashboard.widgets)).toEqual(["sk:1"]);
      expect(cfg.dashboard.widgets["sk:1"]).toEqual({
        kind: "sk",
        spec: { path: "electrical.voltage", unit: "V" },
      });
    });
  });
});

describe("generic TARGET writers — the rail and the tabs are one editor", () => {
  /** A config with BOTH a populated rail band and dashboard tabs, so a widget can
   * be moved between the rail (a target) and a tab (a target). nav.sog lives on
   * the rail AND the Nav tab, exactly as `adoptDefaults` seeds it. */
  const seed = (): ChromeConfig => ({
    ...DEFAULT_CHROME,
    bands: { rail: { order: ["nav.sog", "nav.cog", "depth.belowKeel"] }, top: { order: [] } },
    dashboard: {
      tabs: [
        { id: "nav", label: "Nav", order: ["nav.sog", "nav.cog"] },
        { id: "wind", label: "Wind", order: ["wind.aws"] },
      ],
      widgets: {},
    },
  });

  test("RAIL_TARGET / isRailTarget name the rail and nothing else", () => {
    expect(RAIL_TARGET).toBe("rail");
    expect(isRailTarget("rail")).toBe(true);
    expect(isRailTarget("nav")).toBe(false);
  });

  test("targetOrder reads the rail band or a tab's order; a missing tab is empty", () => {
    expect(targetOrder(seed(), RAIL_TARGET)).toEqual(["nav.sog", "nav.cog", "depth.belowKeel"]);
    expect(targetOrder(seed(), "wind")).toEqual(["wind.aws"]);
    expect(targetOrder(seed(), "ghost")).toEqual([]);
  });

  test("hasTarget — the rail always exists; a tab must be listed", () => {
    expect(hasTarget(seed(), RAIL_TARGET)).toBe(true);
    expect(hasTarget(seed(), "nav")).toBe(true);
    expect(hasTarget(seed(), "ghost")).toBe(false);
  });

  describe("moveWidgetInTarget — reorder within one target", () => {
    test("on the rail it swaps the band order (delegates to swapOrder)", () => {
      const cfg = moveWidgetInTarget(seed(), RAIL_TARGET, "nav.sog", "depth.belowKeel");
      expect(cfg.bands.rail.order).toEqual(["depth.belowKeel", "nav.cog", "nav.sog"]);
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog"]); // tabs untouched
    });

    test("on a tab it swaps that tab's order (delegates to moveWidgetInTab)", () => {
      const cfg = moveWidgetInTarget(seed(), "nav", "nav.sog", "nav.cog");
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.cog", "nav.sog"]);
      expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog", "depth.belowKeel"]); // rail untouched
    });
  });

  describe("removeWidgetFromTarget — take a widget off ONE target", () => {
    test("off the rail drops it from the band order only", () => {
      const cfg = removeWidgetFromTarget(seed(), RAIL_TARGET, "nav.sog");
      expect(cfg.bands.rail.order).toEqual(["nav.cog", "depth.belowKeel"]);
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "nav.cog"]); // still on the tab
    });

    test("off a tab drops it from that tab only (delegates to removeWidgetFromTab)", () => {
      const cfg = removeWidgetFromTarget(seed(), "nav", "nav.sog");
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.cog"]);
      expect(cfg.bands.rail.order).toContain("nav.sog"); // still on the rail
    });

    test("is a no-op when the target does not hold it, and never mutates", () => {
      const before = seed();
      expect(removeWidgetFromTarget(before, RAIL_TARGET, "wind.aws")).toBe(before);
      removeWidgetFromTarget(before, RAIL_TARGET, "nav.sog");
      expect(before.bands.rail.order).toEqual(["nav.sog", "nav.cog", "depth.belowKeel"]);
    });
  });

  describe("addWidgetToTarget — place an existing id + enable it", () => {
    test("onto the rail appends (deduped) and clears the sparse off key", () => {
      const hidden: ChromeConfig = { ...seed(), enabled: { "env.tide": false } };
      const cfg = addWidgetToTarget(hidden, RAIL_TARGET, "env.tide");
      expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog", "depth.belowKeel", "env.tide"]);
      expect(cfg.enabled).toEqual({});
    });

    test("re-adding an id already on the rail is a no-op on order — never a duplicate", () => {
      const cfg = addWidgetToTarget(seed(), RAIL_TARGET, "nav.sog");
      expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog", "depth.belowKeel"]);
    });

    test("onto a tab delegates to addWidgetToTab", () => {
      const cfg = addWidgetToTarget(seed(), "wind", "env.tide");
      expect(cfg.dashboard.tabs[1].order).toEqual(["wind.aws", "env.tide"]);
    });
  });

  describe("moveWidgetToTarget — origin-aware move between targets", () => {
    test("rail → tab: removed from the rail, appended to the tab", () => {
      const cfg = moveWidgetToTarget(seed(), "depth.belowKeel", RAIL_TARGET, "wind");
      expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog"]);
      expect(cfg.dashboard.tabs[1].order).toEqual(["wind.aws", "depth.belowKeel"]);
    });

    test("tab → rail: removed from the tab, appended to the rail", () => {
      const cfg = moveWidgetToTarget(seed(), "wind.aws", "wind", RAIL_TARGET);
      expect(cfg.dashboard.tabs[1].order).toEqual([]);
      expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog", "depth.belowKeel", "wind.aws"]);
    });

    test("tab → tab NEVER disturbs the rail (origin-aware, not remove-from-all)", () => {
      const cfg = moveWidgetToTarget(seed(), "nav.sog", "nav", "wind");
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.cog"]);
      expect(cfg.dashboard.tabs[1].order).toEqual(["wind.aws", "nav.sog"]);
      expect(cfg.bands.rail.order).toContain("nav.sog"); // still on the rail — the point
    });

    test("moving to a target it is already on de-dupes (bubbles to the end)", () => {
      // nav.sog is on the rail AND the Nav tab; moving it rail→nav must not dup it.
      const cfg = moveWidgetToTarget(seed(), "nav.sog", RAIL_TARGET, "nav");
      expect(cfg.bands.rail.order).toEqual(["nav.cog", "depth.belowKeel"]);
      expect(cfg.dashboard.tabs[0].order).toEqual(["nav.cog", "nav.sog"]);
    });

    test("is a no-op when the destination is a tab that is gone", () => {
      const before = seed();
      expect(moveWidgetToTarget(before, "nav.sog", "nav", "ghost")).toBe(before);
    });
  });

  describe("mintWidgetToTarget — mint a parameterized instance onto a target", () => {
    test("onto the rail stores {kind,spec}, appends the minted id, enables it", () => {
      const { cfg, id } = mintWidgetToTarget(seed(), RAIL_TARGET, "sk", SK_WIDGET_PREFIX, { path: "x" });
      expect(isSkWidgetId(id)).toBe(true);
      expect(cfg.dashboard.widgets[id]).toEqual({ kind: "sk", spec: { path: "x" } });
      expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog", "depth.belowKeel", id]);
      expect(id in cfg.enabled).toBe(false);
    });

    test("onto a tab delegates to addWidget (seats it on the tab, not the rail)", () => {
      const { cfg, id } = mintWidgetToTarget(seed(), "wind", "sk", SK_WIDGET_PREFIX, { path: "y" });
      expect(cfg.dashboard.tabs[1].order).toEqual(["wind.aws", id]);
      expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog", "depth.belowKeel"]);
    });
  });

  test("removeWidget now strips the id from band orders too (no rail orphan)", () => {
    // A parameterized widget minted onto the rail must be fully removable — its id
    // was left orphaned on bands.rail.order before removeWidget learned to strip it.
    const { cfg, id } = mintWidgetToTarget(seed(), RAIL_TARGET, "sk", SK_WIDGET_PREFIX, { path: "z" });
    const gone = removeWidget(cfg, id);
    expect(id in gone.dashboard.widgets).toBe(false);
    expect(gone.bands.rail.order).not.toContain(id);
  });
});

describe("generic TARGET writers — the TOP (route) band is a target too", () => {
  /** A config with both bands populated and a tab, so a widget can move between
   * the rail, the top band and a tab — all targets. */
  const seed = (): ChromeConfig => ({
    ...DEFAULT_CHROME,
    bands: {
      rail: { order: ["nav.sog", "nav.cog"] },
      top: { order: ["route.xte", "route.dtw"] },
    },
    dashboard: { tabs: [{ id: "nav", label: "Nav", order: ["nav.sog"] }], widgets: {} },
  });

  test("isBandTarget is true for BOTH bands and false for a tab", () => {
    expect(TOP_TARGET).toBe("top");
    expect(isBandTarget(RAIL_TARGET)).toBe(true);
    expect(isBandTarget(TOP_TARGET)).toBe(true);
    expect(isBandTarget("nav")).toBe(false);
    // isRailTarget stays narrow — the rail and nothing else.
    expect(isRailTarget(TOP_TARGET)).toBe(false);
  });

  test("targetOrder / hasTarget resolve the top band", () => {
    expect(targetOrder(seed(), TOP_TARGET)).toEqual(["route.xte", "route.dtw"]);
    expect(hasTarget(seed(), TOP_TARGET)).toBe(true);
  });

  test("moveWidgetInTarget reorders the top band's order (delegates to swapOrder)", () => {
    const cfg = moveWidgetInTarget(seed(), TOP_TARGET, "route.xte", "route.dtw");
    expect(cfg.bands.top.order).toEqual(["route.dtw", "route.xte"]);
    expect(cfg.bands.rail.order).toEqual(["nav.sog", "nav.cog"]); // rail untouched
  });

  test("removeWidgetFromTarget drops it from the top band only", () => {
    const cfg = removeWidgetFromTarget(seed(), TOP_TARGET, "route.xte");
    expect(cfg.bands.top.order).toEqual(["route.dtw"]);
  });

  test("addWidgetToTarget appends onto the top band and enables it", () => {
    const hidden: ChromeConfig = { ...seed(), enabled: { "nav.sog": false } };
    const cfg = addWidgetToTarget(hidden, TOP_TARGET, "nav.sog");
    expect(cfg.bands.top.order).toEqual(["route.xte", "route.dtw", "nav.sog"]);
    expect(cfg.enabled).toEqual({}); // sparse off-key cleared
  });

  test("moveWidgetToTarget moves a rail widget onto the top band (origin-aware)", () => {
    const cfg = moveWidgetToTarget(seed(), "nav.cog", RAIL_TARGET, TOP_TARGET);
    expect(cfg.bands.rail.order).toEqual(["nav.sog"]);
    expect(cfg.bands.top.order).toEqual(["route.xte", "route.dtw", "nav.cog"]);
  });

  test("moveWidgetToTarget moves a top widget onto a tab (top → tab)", () => {
    const cfg = moveWidgetToTarget(seed(), "route.xte", TOP_TARGET, "nav");
    expect(cfg.bands.top.order).toEqual(["route.dtw"]);
    expect(cfg.dashboard.tabs[0].order).toEqual(["nav.sog", "route.xte"]);
  });

  test("mintWidgetToTarget mints a parameterized instance onto the top band", () => {
    const { cfg, id } = mintWidgetToTarget(seed(), TOP_TARGET, "sk", SK_WIDGET_PREFIX, { path: "t" });
    expect(cfg.dashboard.widgets[id]).toEqual({ kind: "sk", spec: { path: "t" } });
    expect(cfg.bands.top.order).toEqual(["route.xte", "route.dtw", id]);
    // removeWidget strips it from the top band too (no orphan).
    expect(removeWidget(cfg, id).bands.top.order).not.toContain(id);
  });
});

describe("arrangementFromChrome / applyArrangement — the Layout (task vqnxwuro) bridge", () => {
  const seed = () => adoptDefaults(DEFAULT_CHROME, v2);

  test("arrangementFromChrome captures enabled/bands/dashboard only, not density/pointerCoarse", () => {
    const cfg = setDensity(seed(), DESK);
    const arr = arrangementFromChrome(cfg);
    expect(arr).toEqual({ enabled: cfg.enabled, bands: cfg.bands, dashboard: cfg.dashboard });
    expect(Object.keys(arr).sort()).toEqual(["bands", "dashboard", "enabled"]);
  });

  test("applyArrangement replaces the arrangement wholesale, leaving density/pointerCoarse untouched", () => {
    const saved = arrangementFromChrome(swapOrder(seed(), "rail", "nav.sog", "env.tide"));
    // A DIFFERENT device: bigger density, a coarse pointer, and a widget this
    // device seated that the saved layout never mentions.
    const device: ChromeConfig = {
      ...seed(),
      density: HELM,
      pointerCoarse: true,
      bands: { rail: { order: ["nav.sog"] }, top: { order: [] } },
    };
    const next = applyArrangement(device, saved, v2);
    expect(next.density).toBe(HELM); // device characteristic, untouched
    expect(next.pointerCoarse).toBe(true); // device characteristic, untouched
    expect(next.bands.rail.order).toEqual(["env.tide", "depth.belowKeel", "nav.sog"]); // replaced wholesale
  });

  test("a layout from an older build seats a widget it never mentions — the same tolerance a stored ChromeConfig gets on boot", () => {
    const v1Cfg = adoptDefaults(DEFAULT_CHROME, v1); // no env.tide, no route.xte
    const saved = arrangementFromChrome(v1Cfg);
    const next = applyArrangement(seed(), saved, v2); // v2 registry: knows env.tide + route.xte
    expect(next.bands.rail.order).toContain("env.tide");
    expect(next.bands.top.order).toContain("route.xte");
  });

  test("a garbage/missing blob repairs to the empty default rather than crashing the board", () => {
    for (const blob of [null, undefined, 42, "layout", ["layout"]]) {
      const next = applyArrangement(seed(), blob, v2);
      expect(next.bands.rail.order.length).toBeGreaterThan(0); // adoptDefaults re-seeds it
      expect(next.dashboard.tabs).toEqual([]);
    }
  });

  test("applyArrangement does not mutate its input", () => {
    const before = seed();
    const saved = arrangementFromChrome(swapOrder(seed(), "rail", "nav.sog", "env.tide"));
    applyArrangement(before, saved, v2);
    expect(before.bands.rail.order).toEqual(["nav.sog", "depth.belowKeel", "env.tide"]);
  });
});
