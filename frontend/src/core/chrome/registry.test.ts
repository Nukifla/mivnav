/**
 * The kernel's rules. Every invariant that `defineFeature` and `urgencyOf`
 * enforce is asserted here, with no DOM and no map — which is the point of
 * keeping chrome/ pure (IMPLEMENTATION §6).
 *
 * NB: needs `--conditions=browser` (the `test` script). Bare `bun test`
 * resolves solid-js's `node` export, whose createEffect never runs.
 *
 * NB: chrome/ must never import maplibre-gl for a value — MapView.test.ts mocks
 * it for the whole run, and mock.module leaks across files.
 */

import { describe, expect, test } from "bun:test";
import {
  alerts,
  createRegistry,
  DESK,
  defineFeature,
  HELM,
  homeOf,
  homesOf,
  isStale,
  readInstrument,
  readingValueClasses,
  RESERVED,
  urgencyOf,
  type Instrument,
  type InstrumentView,
  type ReadCtx,
  type Urgency,
} from "./registry";

const ctx: ReadCtx = { density: DESK, band: "rail" };

/** A minimal instrument. Override whatever the test is actually about. */
function inst(over: Partial<Instrument> & { id: string }): Instrument {
  return {
    short: over.id.slice(0, 3).toUpperCase(),
    label: over.id,
    maxUrgency: "none",
    read: () => ({ value: "1.0", unit: "kn" }),
    ...over,
  };
}

describe("RESERVED", () => {
  test("is the alarm band alone, and is frozen", () => {
    // The autopilot USED to be reserved and is not any more — it is a normal
    // feature now (features/autopilot). The alarm band is the one thing left.
    expect([...RESERVED]).toEqual(["alarm-band"]);
    expect(Object.isFrozen(RESERVED)).toBe(true);
  });
});

describe("defineFeature — invariant #1: reserved chrome is not registrable", () => {
  for (const id of ["alarm-band"]) {
    test(`an instrument may not be "${id}"`, () => {
      expect(() => defineFeature({ id: "f", instruments: [inst({ id })] })).toThrow(
        /reserved chrome is not registrable/,
      );
    });

    test(`a feature may not be "${id}"`, () => {
      expect(() => defineFeature({ id })).toThrow(/reserved chrome is not registrable/);
    });

    test(`"${id}" is not a band name — there is no string that seats a widget there`, () => {
      expect(() =>
        // @ts-expect-error — BandId has no name for reserved chrome. That is the invariant:
        // the type rejects it at compile time, and the kernel rejects it at run time too,
        // because a JS caller or a config from disk is not type-checked.
        defineFeature({ id: "f", instruments: [inst({ id: "w", band: id })] }),
      ).toThrow(/reserved chrome is not a band/);
    });
  }

  test("a plain widget on a real band is fine", () => {
    expect(() => defineFeature({ id: "f", instruments: [inst({ id: "nav.sog" })] })).not.toThrow();
  });

  test("the autopilot is registrable now — a feature, an instrument, and a page", () => {
    // It used to be reserved; unreserving it means all three of these are legal.
    expect(() =>
      defineFeature({
        id: "autopilot",
        instruments: [inst({ id: "ap.status" })],
        dashboard: [{ id: "pilot", label: "Pilot", instruments: ["ap.status"] }],
      }),
    ).not.toThrow();
  });
});

describe("defineFeature — bands must exist", () => {
  test("an unknown band is refused", () => {
    expect(() =>
      // @ts-expect-error — the band set is closed; this is the runtime half of that.
      defineFeature({ id: "f", instruments: [inst({ id: "w", band: "sidebar" })] }),
    ).toThrow(/no such band/);
  });

  test("a default band the instrument is not allowed in is refused", () => {
    expect(() =>
      defineFeature({ id: "f", instruments: [inst({ id: "w", band: "top", bands: ["rail"] })] }),
    ).toThrow(/which it is not allowed in/);
  });
});

describe("defineFeature — invariant #3: nothing alarm-grade in a conditional band", () => {
  test("alarm-grade in band.top throws — band.top can go dark", () => {
    expect(() =>
      defineFeature({ id: "f", instruments: [inst({ id: "w", band: "top", maxUrgency: "alarm" })] }),
    ).toThrow(/may not live in a conditional band/);
  });

  test("alarm-grade merely ALLOWED in band.top throws too — a home is a home", () => {
    expect(() =>
      defineFeature({
        id: "f",
        instruments: [inst({ id: "w", band: "rail", bands: ["rail", "top"], maxUrgency: "alarm" })],
      }),
    ).toThrow(/may not live in a conditional band/);
  });

  test("alarm-grade in band.rail is fine — the rail is always there", () => {
    expect(() =>
      defineFeature({
        id: "f",
        instruments: [inst({ id: "depth.belowKeel", band: "rail", maxUrgency: "alarm" })],
      }),
    ).not.toThrow();
  });

  test("notice-grade in band.top is fine — losing it with the route is acceptable", () => {
    expect(() =>
      defineFeature({ id: "f", instruments: [inst({ id: "route.xte", band: "top", maxUrgency: "notice" })] }),
    ).not.toThrow();
  });
});

describe("defineFeature — hygiene", () => {
  test("a duplicate instrument id within one feature throws", () => {
    expect(() =>
      defineFeature({ id: "f", instruments: [inst({ id: "nav.sog" }), inst({ id: "nav.sog" })] }),
    ).toThrow(/duplicate instrument id/);
  });

  test("the returned feature is frozen — a registered feature is not edited afterwards", () => {
    const f = defineFeature({ id: "core", instruments: [inst({ id: "nav.sog" })] });
    expect(Object.isFrozen(f)).toBe(true);
  });
});

describe("homesOf / homeOf", () => {
  test("bands defaults to the single declared band", () => {
    expect(homesOf(inst({ id: "w", band: "top" }))).toEqual(["top"]);
  });

  test("with no band at all, home is the rail", () => {
    expect(homesOf(inst({ id: "w" }))).toEqual(["rail"]);
    expect(homeOf(inst({ id: "w" }))).toBe("rail");
  });

  test("band is the default home; bands is the allowed set", () => {
    const i = inst({ id: "w", band: "top", bands: ["top", "rail"] });
    expect(homeOf(i)).toBe("top");
    expect(homesOf(i)).toEqual(["top", "rail"]);
  });
});

describe("createRegistry", () => {
  const core = defineFeature({
    id: "core",
    instruments: [inst({ id: "nav.sog" }), inst({ id: "depth.belowKeel", maxUrgency: "alarm" })],
  });
  const routes = defineFeature({
    id: "routes",
    instruments: [inst({ id: "route.xte", band: "top", maxUrgency: "notice" })],
    modes: [{ id: "route.edit", label: "Route editor" }],
  });

  test("flattens instruments in feature order — that order IS the default rail order", () => {
    const reg = createRegistry([core, routes]);
    expect(reg.instruments.map((i) => i.id)).toEqual(["nav.sog", "depth.belowKeel", "route.xte"]);
  });

  test("byId finds registered instruments and nothing else", () => {
    const reg = createRegistry([core, routes]);
    expect(reg.byId("nav.sog")?.label).toBe("nav.sog");
    expect(reg.byId("nope")).toBeUndefined();
  });

  test("collects modes by id", () => {
    const reg = createRegistry([core, routes]);
    expect(reg.modes.get("route.edit")?.label).toBe("Route editor");
    expect(reg.modes.size).toBe(1);
  });

  test("a build without the routes feature simply has none of it", () => {
    const reg = createRegistry([core]);
    expect(reg.byId("route.xte")).toBeUndefined();
    expect(reg.modes.size).toBe(0);
  });

  test("two features claiming one instrument id is a merge accident, not a shadow", () => {
    const other = defineFeature({ id: "other", instruments: [inst({ id: "nav.sog" })] });
    expect(() => createRegistry([core, other])).toThrow(/duplicate instrument id across features/);
  });

  test("a duplicate feature id throws", () => {
    expect(() => createRegistry([core, core])).toThrow(/duplicate feature id/);
  });

  test("a duplicate mode id throws", () => {
    const other = defineFeature({ id: "other", modes: [{ id: "route.edit", label: "Clash" }] });
    expect(() => createRegistry([routes, other])).toThrow(/duplicate mode id/);
  });
});

describe("urgencyOf — invariant #2: maxUrgency is GRANTED, not claimed", () => {
  test("route.xte asks for alarm every tick and is granted notice, forever", () => {
    const xte = inst({ id: "route.xte", band: "top", maxUrgency: "notice", urgency: () => "alarm" });
    // not once, not on a good tick — every time.
    for (let tick = 0; tick < 5; tick++) expect(urgencyOf(xte)).toBe("notice");
  });

  test("a request below the ceiling passes through untouched — the clamp is a ceiling, not a level", () => {
    const i = inst({ id: "w", maxUrgency: "alarm", urgency: () => "notice" });
    expect(urgencyOf(i)).toBe("notice");
  });

  test("a granted alarm is an alarm — depth reaches it", () => {
    const depth = inst({ id: "depth.belowKeel", maxUrgency: "alarm", urgency: () => "alarm" });
    expect(urgencyOf(depth)).toBe("alarm");
  });

  test("a feature granted none cannot even reach notice by asking", () => {
    const i = inst({ id: "w", maxUrgency: "none", urgency: () => "alarm" });
    expect(urgencyOf(i)).toBe("none");
  });

  test("an instrument that never asks is never urgent", () => {
    expect(urgencyOf(inst({ id: "w", maxUrgency: "alarm" }))).toBe("none");
  });

  test("the clamp holds for every request against every grant", () => {
    const rank: Record<Urgency, number> = { none: 0, notice: 1, alarm: 2 };
    const all: Urgency[] = ["none", "notice", "alarm"];
    for (const grant of all) {
      for (const want of all) {
        const got = urgencyOf(inst({ id: "w", maxUrgency: grant, urgency: () => want }));
        expect(rank[got]).toBeLessThanOrEqual(rank[grant]); // never above the grant
        expect(rank[got]).toBeLessThanOrEqual(rank[want]); // and never above the request
        expect(got).toBe(rank[want] > rank[grant] ? grant : want);
      }
    }
  });
});

describe("urgencyOf — invariant #6: stale data cannot alarm", () => {
  test("a dead sensor is silent, not screaming — even granted alarm, even asking for it", () => {
    const depth = inst({
      id: "depth.belowKeel",
      maxUrgency: "alarm",
      urgency: () => "alarm",
      staleAge: () => 18,
    });
    expect(urgencyOf(depth)).toBe("none");
  });

  test("the same instrument alarms again the moment its data is fresh", () => {
    let age: number | null = 18;
    const depth = inst({
      id: "depth.belowKeel",
      maxUrgency: "alarm",
      urgency: () => "alarm",
      staleAge: () => age,
    });
    expect(urgencyOf(depth)).toBe("none");
    age = null;
    expect(urgencyOf(depth)).toBe("alarm");
  });

  test("isStale is about the sample, not the value — age 0 is fresh news, null is no news", () => {
    expect(isStale(inst({ id: "w", staleAge: () => 0 }))).toBe(true);
    expect(isStale(inst({ id: "w", staleAge: () => null }))).toBe(false);
    expect(isStale(inst({ id: "w" }))).toBe(false);
  });
});

describe("readInstrument — invariant #7: the kernel says how tight it is", () => {
  test("hands the widget the space, and returns what it decided to show", () => {
    const i = inst({
      id: "route.dtw",
      band: "top",
      read: (c) => ({ value: "1.2", unit: "nm", sub: c.density >= 0.5 ? "to wpt" : "to Rock Point" }),
    });
    expect(readInstrument(i, { density: DESK, band: "top" }).reading.sub).toBe("to Rock Point");
    expect(readInstrument(i, { density: HELM, band: "top" }).reading.sub).toBe("to wpt");
  });

  test("the widget drops detail; the kernel never rewrites the reading", () => {
    const view = readInstrument(inst({ id: "nav.sog" }), ctx);
    expect(view.reading).toEqual({ value: "1.0", unit: "kn" });
  });

  test("resolves the clamped urgency, not the request", () => {
    const xte = inst({ id: "route.xte", band: "top", maxUrgency: "notice", urgency: () => "alarm" });
    expect(readInstrument(xte, { density: DESK, band: "top" }).urgency).toBe("notice");
  });

  test("reports staleness and its age, so the shell can make it LOOK stale", () => {
    const view = readInstrument(inst({ id: "nav.sog", staleAge: () => 18 }), ctx);
    expect(view.stale).toBe(true);
    expect(view.staleSeconds).toBe(18);
    expect(view.urgency).toBe("none");
  });

  test("fresh data carries no age", () => {
    const view = readInstrument(inst({ id: "nav.sog" }), ctx);
    expect(view.stale).toBe(false);
    expect(view.staleSeconds).toBeNull();
  });
});

describe("alerts — the reserved alarm band is driven BY the registry, not IN it", () => {
  const alerting = (id: string, over: Partial<Instrument> = {}) =>
    inst({
      id,
      maxUrgency: "alarm",
      urgency: () => "alarm",
      alertText: () => ["⚠ SHALLOW WATER", "DPT 3.1 m · below safety contour 6.0 m"],
      ...over,
    });

  test("an alarm-grade instrument at alarm raises one", () => {
    const reg = createRegistry([defineFeature({ id: "core", instruments: [alerting("depth.belowKeel")] })]);
    expect(alerts(reg)).toEqual([
      { id: "depth.belowKeel", title: "⚠ SHALLOW WATER", detail: "DPT 3.1 m · below safety contour 6.0 m" },
    ]);
  });

  test("a clamped request never reaches the alarm band — route.xte cannot alarm the boat", () => {
    const xte = alerting("route.xte", { band: "top", maxUrgency: "notice" });
    const reg = createRegistry([defineFeature({ id: "routes", instruments: [xte] })]);
    expect(alerts(reg)).toEqual([]);
  });

  test("a stale sensor raises nothing", () => {
    const reg = createRegistry([
      defineFeature({ id: "core", instruments: [alerting("depth.belowKeel", { staleAge: () => 30 })] }),
    ]);
    expect(alerts(reg)).toEqual([]);
  });

  test("a quiet instrument raises nothing", () => {
    const reg = createRegistry([
      defineFeature({ id: "core", instruments: [alerting("depth.belowKeel", { urgency: () => "none" })] }),
    ]);
    expect(alerts(reg)).toEqual([]);
  });

  test("alarming without alertText raises nothing — the band has nothing to say", () => {
    const reg = createRegistry([
      defineFeature({
        id: "core",
        instruments: [inst({ id: "ais.cpa", maxUrgency: "alarm", urgency: () => "alarm" })],
      }),
    ]);
    expect(alerts(reg)).toEqual([]);
  });

  test("scans the whole registry: an alarm fires whether or not you kept the tile", () => {
    // No config is consulted at all. Turning off a tile turns off a READOUT,
    // never a guard — the alarm band is reserved chrome.
    const reg = createRegistry([
      defineFeature({ id: "core", instruments: [alerting("depth.belowKeel"), alerting("ais.cpa")] }),
    ]);
    expect(alerts(reg).map((a) => a.id)).toEqual(["depth.belowKeel", "ais.cpa"]);
  });
});

describe("readingValueClasses (shared rail-tile/dashboard-card colour rule)", () => {
  const view = (over: Partial<InstrumentView>): InstrumentView => ({
    reading: { value: "1.0", unit: "kn" },
    urgency: "none",
    stale: false,
    staleSeconds: null,
    ...over,
  });
  const on = (v: InstrumentView): string[] =>
    Object.entries(readingValueClasses(v))
      .filter(([, yes]) => yes)
      .map(([cls]) => cls);

  test("a plain live reading wears fg", () => {
    expect(on(view({}))).toEqual(["text-fg"]);
  });

  test("urgency colours the value, but only while fresh", () => {
    expect(on(view({ urgency: "notice" }))).toEqual(["text-notice"]);
    expect(on(view({ urgency: "alarm" }))).toEqual(["text-alarm"]);
  });

  test("stale drops to fg-3 and strikes through — and never alarms in colour", () => {
    const cls = on(view({ urgency: "alarm", stale: true, staleSeconds: 9 }));
    expect(cls).toContain("text-fg-3");
    expect(cls).toContain("line-through decoration-2 opacity-80");
    expect(cls).not.toContain("text-alarm");
  });

  test("a null reading is dead-coloured too", () => {
    expect(on(view({ reading: { value: "—", state: "null" } }))).toEqual(["text-fg-3"]);
  });
});
