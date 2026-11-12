/**
 * Band resolution: what this device shows, where, in what order.
 *
 * Pure — no DOM, no map, no media query. The rail is a rendering of this and
 * nothing more, which is why the behaviour lives here.
 *
 * NB: needs `--conditions=browser` (the `test` script).
 */

import { describe, expect, test } from "bun:test";
import {
  available,
  bandCapacity,
  bandList,
  bandLive,
  bandOf,
  BAND_IDS,
  BANDS,
  boardTab,
  collisions,
  configurable,
  isBandId,
  isEnabled,
  onScreen,
  targetCards,
  hiddenNow,
  targetRoom,
} from "./bands";
import { createRegistry, defineFeature, DESK, HELM, type Instrument, type Registry } from "./registry";
import type { ChromeConfig } from "./config";

function inst(over: Partial<Instrument> & { id: string; short: string }): Instrument {
  return { label: over.id, maxUrgency: "none", read: () => ({ value: "1.0" }), ...over };
}

/** A route that is being followed, or not — the thing band.top's presence hangs on. */
let following = true;
const whenRoute = () => following;

const core = defineFeature({
  id: "core",
  instruments: [
    inst({ id: "cursor.brg", short: "BRG", band: "rail", desktopOnly: true }),
    inst({ id: "nav.sog", short: "SOG", band: "rail", bands: ["rail", "top"] }),
    inst({ id: "depth.belowKeel", short: "DBK", band: "rail", maxUrgency: "alarm", urgency: () => "alarm" }),
  ],
});
const routes = defineFeature({
  id: "routes",
  instruments: [
    inst({ id: "route.xte", short: "XTE", band: "top", maxUrgency: "notice", when: whenRoute }),
    inst({ id: "route.dtw", short: "DTW", band: "top", when: whenRoute }),
  ],
});

const reg: Registry = createRegistry([core, routes]);

function cfg(over: Partial<ChromeConfig> = {}): ChromeConfig {
  return {
    density: HELM,
    pointerCoarse: false,
    enabled: {},
    bands: {
      rail: { order: ["cursor.brg", "nav.sog", "depth.belowKeel"] },
      top: { order: ["route.xte", "route.dtw"] },
    },
    dashboard: { tabs: [], widgets: {} },
    ...over,
  };
}

describe("BANDS — the band graph is closed", () => {
  test("there are two bands, and reserved chrome is not among them", () => {
    expect([...BAND_IDS]).toEqual(["rail", "top"]);
    expect(Object.keys(BANDS)).toEqual(["rail", "top"]);
    expect(isBandId("alarm-band")).toBe(false);
    expect(isBandId("autopilot")).toBe(false);
    expect(isBandId("rail")).toBe(true);
  });

  test("the rail is beside the chart on the abundant axis, and is never conditional", () => {
    // `rooms` is the rail's second presentation, not a second band: the board
    // IS the rail widened, so it is a room of `rail` rather than a `BandId` of
    // its own. That is what keeps the band graph closed (invariant #1) while
    // still letting a widget be told a 78px strip from a 200px card.
    expect(BANDS.rail).toEqual({
      id: "rail",
      axis: "y",
      overChart: false,
      conditional: false,
      rooms: ["strip", "board"],
    });
  });

  test("band.top is the one exception: over the chart, and it can go dark", () => {
    // Strip only: band.top is a transparent line over the chart, so there is
    // no widened form of it to be a board.
    expect(BANDS.top).toEqual({
      id: "top",
      axis: "x",
      overChart: true,
      conditional: true,
      rooms: ["strip"],
    });
  });

  test("the table is frozen — a band is not added at runtime", () => {
    expect(Object.isFrozen(BANDS)).toBe(true);
  });
});

describe("isEnabled — absent means ON", () => {
  test("a widget the config has never mentioned is on", () => {
    expect(isEnabled(cfg(), "nav.sog")).toBe(true);
  });

  test("only an explicit false turns it off", () => {
    expect(isEnabled(cfg({ enabled: { "nav.sog": false } }), "nav.sog")).toBe(false);
    expect(isEnabled(cfg({ enabled: { "nav.sog": true } }), "nav.sog")).toBe(true);
  });
});

describe("bandOf", () => {
  test("finds where the config seated it", () => {
    expect(bandOf(cfg(), "nav.sog")).toBe("rail");
    expect(bandOf(cfg(), "route.xte")).toBe("top");
    expect(bandOf(cfg(), "nope")).toBeNull();
  });
});

describe("configurable — what the config editor lists", () => {
  test("the band's order, resolved", () => {
    expect(configurable(reg, cfg(), "rail").map((i) => i.id)).toEqual([
      "cursor.brg",
      "nav.sog",
      "depth.belowKeel",
    ]);
  });

  test("an id from a feature this build lacks is skipped, not an error", () => {
    const c = cfg();
    c.bands.rail.order = ["nav.sog", "poi.nearest", "depth.belowKeel"];
    expect(configurable(reg, c, "rail").map((i) => i.id)).toEqual(["nav.sog", "depth.belowKeel"]);
  });

  test("lists a dark band's widgets anyway — you configure the route row before you are on a route", () => {
    following = false;
    expect(configurable(reg, cfg(), "top").map((i) => i.id)).toEqual(["route.xte", "route.dtw"]);
    following = true;
  });
});

describe("available — invariant #10: density is a setting, not a breakpoint", () => {
  test("a desk has a pointer, so the cursor readout is there", () => {
    expect(available(reg, cfg(), "rail").map((i) => i.id)).toContain("cursor.brg");
  });

  test("pointerCoarse drops desktopOnly — gloves do not hover, on a phone or a wide tablet — whatever the size slider says", () => {
    const list = available(reg, cfg({ pointerCoarse: true }), "rail").map((i) => i.id);
    expect(list).not.toContain("cursor.brg");
    expect(list).toEqual(["nav.sog", "depth.belowKeel"]);
  });

  test("the size slider alone does NOT drop desktopOnly — #DENS-SLIDER split it from pointerCoarse", () => {
    const list = available(reg, cfg({ density: DESK, pointerCoarse: false }), "rail").map((i) => i.id);
    expect(list).toContain("cursor.brg");
  });

  test("a widget whose feature is absent is absent — conditional presence, not disablement", () => {
    following = false;
    expect(available(reg, cfg(), "top")).toEqual([]);
    following = true;
    expect(available(reg, cfg(), "top").map((i) => i.id)).toEqual(["route.xte", "route.dtw"]);
  });

  test("keeps what you turned off — that is bandList's business", () => {
    const c = cfg({ enabled: { "nav.sog": false } });
    expect(available(reg, c, "rail").map((i) => i.id)).toContain("nav.sog");
  });
});

describe("bandList — the resolved list; there is no solve()", () => {
  test("available, minus what you turned off, in the order YOU put it in", () => {
    const c = cfg({ enabled: { "cursor.brg": false } });
    expect(bandList(reg, c, "rail").map((i) => i.id)).toEqual(["nav.sog", "depth.belowKeel"]);
  });

  test("invariant #4: the order is the config's, not the code's", () => {
    const c = cfg();
    c.bands.rail.order = ["depth.belowKeel", "nav.sog", "cursor.brg"];
    expect(bandList(reg, c, "rail").map((i) => i.id)).toEqual([
      "depth.belowKeel",
      "nav.sog",
      "cursor.brg",
    ]);
  });

  test("invariant #4: an alarming widget does NOT move — it recolours in place", () => {
    // depth is at alarm here (urgency: () => "alarm", granted alarm). Muscle
    // memory in fog at night beats a helpful re-rank.
    const before = bandList(reg, cfg(), "rail").map((i) => i.id);
    expect(before).toEqual(["cursor.brg", "nav.sog", "depth.belowKeel"]);
    expect(before.indexOf("depth.belowKeel")).toBe(2); // last, and it stays last
  });

  test("invariant #5: overflow is told, not solved — nothing is dropped to fit", () => {
    const many = defineFeature({
      id: "many",
      instruments: Array.from({ length: 30 }, (_, n) =>
        inst({ id: `w${n}`, short: `W${n}`, band: "rail" }),
      ),
    });
    const r = createRegistry([many]);
    const c = cfg();
    c.bands.rail.order = r.instruments.map((i) => i.id);
    // 30 widgets will not fit any rail. The kernel returns all 30; the rail
    // scrolls and the config editor says so. No silent demotion.
    expect(bandList(r, c, "rail")).toHaveLength(30);
  });

  test("an empty band resolves to an empty list, not a throw", () => {
    expect(bandList(reg, cfg({ bands: { rail: { order: [] }, top: { order: [] } } }), "rail")).toEqual([]);
  });
});

describe("bandLive — a band that can go dark", () => {
  test("the rail is always live: it is beside the chart and it is where the alarm-grade lives", () => {
    expect(bandLive(reg, cfg(), "rail")).toBe(true);
    expect(bandLive(reg, cfg({ bands: { rail: { order: [] }, top: { order: [] } } }), "rail")).toBe(true);
  });

  test("band.top is live while a route is followed, and dark the moment it is not", () => {
    following = true;
    expect(bandLive(reg, cfg(), "top")).toBe(true);
    following = false;
    expect(bandLive(reg, cfg(), "top")).toBe(false);
    following = true;
  });

  test("a conditional band with nothing to show is dark — no transparent strip of nothing", () => {
    const c = cfg();
    c.bands.top.order = [];
    expect(bandLive(reg, c, "top")).toBe(false);
  });
});

describe("collisions — two cells that read the same are a misread at night", () => {
  test("no collision among distinct labels", () => {
    expect(collisions([inst({ id: "a", short: "SOG" }), inst({ id: "b", short: "COG" })])).toEqual([]);
  });

  test("catches the TTG/TTG bug: time-to-waypoint and time-to-destination both labelled TTG", () => {
    expect(
      collisions([
        inst({ id: "route.ttw", short: "TTG" }),
        inst({ id: "route.ttg", short: "TTG" }),
      ]),
    ).toEqual(["TTG"]);
  });

  test("TTG vs TTD is the fix, and it passes", () => {
    expect(
      collisions([inst({ id: "route.ttw", short: "TTG" }), inst({ id: "route.ttg", short: "TTD" })]),
    ).toEqual([]);
  });

  test("catches the BRG bug: cursor bearing and bearing-to-waypoint both labelled BRG", () => {
    expect(
      collisions([inst({ id: "cursor.brg", short: "BRG" }), inst({ id: "route.brg", short: "BRG" })]),
    ).toEqual(["BRG"]);
  });

  test("BRG vs BTW is the fix — the standard pairing, and it passes", () => {
    expect(
      collisions([inst({ id: "cursor.brg", short: "BRG" }), inst({ id: "route.brg", short: "BTW" })]),
    ).toEqual([]);
  });

  test("reports each colliding label once, however many collide", () => {
    expect(
      collisions([
        inst({ id: "a", short: "TTG" }),
        inst({ id: "b", short: "TTG" }),
        inst({ id: "c", short: "TTG" }),
        inst({ id: "d", short: "BRG" }),
        inst({ id: "e", short: "BRG" }),
      ]),
    ).toEqual(["TTG", "BRG"]);
  });
});

describe("onScreen — the labels that are up at the same time", () => {
  test("is the union of the live bands", () => {
    following = true;
    expect(onScreen(reg, cfg()).map((i) => i.id)).toEqual([
      "cursor.brg",
      "nav.sog",
      "depth.belowKeel",
      "route.xte",
      "route.dtw",
    ]);
  });

  test("drops a dark band entirely", () => {
    following = false;
    expect(onScreen(reg, cfg()).map((i) => i.id)).toEqual(["cursor.brg", "nav.sog", "depth.belowKeel"]);
    following = true;
  });

  test("no two on-screen labels collide — the test that caught two design bugs", () => {
    // The one worth keeping. A collision is only a collision if both cells are
    // up TOGETHER, so it is asserted over the resolved on-screen set, at both
    // pointer kinds (the axis that actually changes which widgets are on
    // screen — #DENS-SLIDER split visibility off the size slider), with and
    // without a route.
    for (const pointerCoarse of [false, true]) {
      for (const route of [true, false]) {
        following = route;
        expect(collisions(onScreen(reg, cfg({ pointerCoarse })))).toEqual([]);
      }
    }
    following = true;
  });
});

describe("boardTab — the tab carries its OWN order; the config still enables + filters", () => {
  const tab = (order: string[]) => ({ id: "nav", label: "Nav", order });

  test("shows the tab's widgets in the TAB's order — decoupled from the rail band", () => {
    // The rail orders sog before depth; the tab says depth before sog, and the
    // tab wins now — that decoupling is the whole point of this slice. (Before,
    // boardPage read the order off the rail, so the rail's order would win.)
    expect(boardTab(reg, cfg(), tab(["depth.belowKeel", "nav.sog"])).map((i) => i.id)).toEqual([
      "depth.belowKeel",
      "nav.sog",
    ]);
  });

  test("a widget not on the tab is excluded — membership is the tab's order", () => {
    expect(boardTab(reg, cfg(), tab(["nav.sog"])).map((i) => i.id)).not.toContain("cursor.brg");
  });

  test("a widget turned off in the config is off on the board too", () => {
    const off = cfg({ enabled: { "nav.sog": false } });
    expect(boardTab(reg, off, tab(["depth.belowKeel", "nav.sog"])).map((i) => i.id)).toEqual([
      "depth.belowKeel",
    ]);
  });

  test("an id this build has no instrument for is skipped, not an error", () => {
    expect(boardTab(reg, cfg(), tab(["nav.sog", "route.gone"])).map((i) => i.id)).toEqual([
      "nav.sog",
    ]);
  });

  test("a desktopOnly widget drops when pointerCoarse, exactly as on the strip", () => {
    const t = tab(["cursor.brg", "nav.sog"]);
    expect(boardTab(reg, cfg({ pointerCoarse: true }), t).map((i) => i.id)).toEqual(["nav.sog"]);
    expect(boardTab(reg, cfg(), t).map((i) => i.id)).toEqual(["cursor.brg", "nav.sog"]);
  });

  test("a tab with no members is empty", () => {
    expect(boardTab(reg, cfg(), tab([]))).toEqual([]);
  });
});

describe("targetCards — the editor's cards for a TARGET (the rail, or a tab)", () => {
  test("the rail target resolves bands.rail.order as board cards", () => {
    // Same widgets the strip shows, resolved as cards — this is what lets the
    // board editor render the rail as just another target.
    expect(targetCards(reg, cfg(), "rail").map((i) => i.id)).toEqual([
      "cursor.brg",
      "nav.sog",
      "depth.belowKeel",
    ]);
  });

  test("a tab target resolves that tab's order", () => {
    const c = cfg({
      dashboard: { tabs: [{ id: "nav", label: "Nav", order: ["nav.sog", "depth.belowKeel"] }], widgets: {} },
    });
    expect(targetCards(reg, c, "nav").map((i) => i.id)).toEqual(["nav.sog", "depth.belowKeel"]);
  });

  test("the rail target drops a desktopOnly widget when pointerCoarse, exactly like the strip", () => {
    expect(targetCards(reg, cfg({ pointerCoarse: true }), "rail").map((i) => i.id)).toEqual([
      "nav.sog",
      "depth.belowKeel",
    ]);
  });

  test("an unknown target is empty, not a throw", () => {
    expect(targetCards(reg, cfg(), "ghost")).toEqual([]);
  });

  test("a BAND target ignores when()/liveness — the top band is editable off-route", () => {
    // The editor must show the top band's CONFIGURED widgets even when no route is
    // followed, so a route row can be arranged before you are on a passage.
    const prev = following;
    following = false;
    try {
      expect(targetCards(reg, cfg(), "top").map((i) => i.id)).toEqual(["route.xte", "route.dtw"]);
      // The physical strip (bandList) still gates on when — nothing off-route.
      expect(bandList(reg, cfg(), "top").map((i) => i.id)).toEqual([]);
    } finally {
      following = prev;
    }
  });
});

describe("targetRoom — the room the editor renders a target's cards at", () => {
  test("the rail widens into board; the top band is strip-only; a tab is board", () => {
    expect(targetRoom("rail")).toBe("board");
    expect(targetRoom("top")).toBe("strip");
    expect(targetRoom("nav")).toBe("board"); // a dashboard tab
  });
});

describe("bandCapacity — the config editor's overflow estimate, NOT an allocator", () => {
  const tall = { width: 1280, height: 900, compact: false };

  test("the vertical rail fits more small (desk) tiles than big (helm) ones", () => {
    const desk = bandCapacity("rail", DESK, tall);
    const helm = bandCapacity("rail", HELM, tall);
    expect(desk).toBeGreaterThan(helm);
    // (900 - 140 foot) / 44 ≈ 17 desk; / 108 (the extended HELM cell, past the
    // scale's old-helm midpoint) ≈ 7 helm.
    expect(desk).toBe(17);
    expect(helm).toBe(7);
  });

  test("intermediate scales interpolate between the two endpoints", () => {
    const mid = bandCapacity("rail", 0.5, tall);
    expect(mid).toBeGreaterThanOrEqual(bandCapacity("rail", HELM, tall));
    expect(mid).toBeLessThanOrEqual(bandCapacity("rail", DESK, tall));
  });

  test("a phone lays the rail out along the width instead — packs by tile width", () => {
    const phone = { width: 380, height: 780, compact: true };
    // 380 / 56 ≈ 6 desk cells across the bottom bar.
    expect(bandCapacity("rail", DESK, phone)).toBe(6);
  });

  test("the top band always packs across the width, over the chart", () => {
    expect(bandCapacity("top", DESK, tall)).toBe(Math.floor(1280 / 56));
  });

  test("never negative on a tiny viewport", () => {
    expect(bandCapacity("rail", HELM, { width: 100, height: 80, compact: false })).toBe(0);
  });

  test("a TAB target also ignores when() — conditional widgets stay editable (#BOARD-PHONE)", () => {
    // The Route tab's readings with no route followed were invisible in edit
    // mode: unremovable, unreorderable, and adding one looked like a no-op.
    const prev = following;
    following = false;
    try {
      const c = cfg({
        dashboard: { tabs: [{ id: "route", label: "Route", order: ["nav.sog", "route.xte"] }], widgets: {} },
      });
      expect(targetCards(reg, c, "route").map((i) => i.id)).toEqual(["nav.sog", "route.xte"]);
      expect(targetCards(reg, c, "route").filter(hiddenNow).map((i) => i.id)).toEqual(["route.xte"]);
      // The read-only board still hides it.
      expect(boardTab(reg, c, c.dashboard.tabs[0]!).map((i) => i.id)).toEqual(["nav.sog"]);
    } finally {
      following = prev;
    }
  });
});
