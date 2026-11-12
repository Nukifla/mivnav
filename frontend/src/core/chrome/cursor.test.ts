/**
 * The cursor readout: bearing and range from the boat to the pointer.
 *
 * The interesting assertions are the two absences — no fix and no hover — and
 * `desktopOnly`, which is the widget's own statement that it needs a pointer and
 * is the reason Measure exists.
 *
 * NB: `bun run test`, not bare `bun test`.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { SignalKState, Vessel } from "../signalk";
import { bandList } from "./bands";
import { DEFAULT_CHROME } from "./config";
import { adoptDefaults } from "./config";
import { createCursor } from "./cursor";
import { createRegistry, DESK, type Instrument } from "./registry";

const BOAT: Vessel = { lng: 12.6, lat: 55.9 };

function harness(initial: Vessel | null = BOAT) {
  return createRoot((dispose) => {
    const [self, setSelf] = createSignal<Vessel | null>(initial);
    const sk: SignalKState = { self, targets: () => [], status: () => "connected", autopilot: () => null };
    const cursor = createCursor(sk);
    const byId = (id: string): Instrument =>
      cursor.feature.core.instruments!.find((i) => i.id === id)!;
    const read = (id: string) => byId(id).read({ density: DESK, band: "rail" });
    return { ...cursor, byId, read, setSelf, dispose };
  });
}

describe("the readout", () => {
  test("bearing and range from the boat to the pointer", () => {
    const h = harness();
    h.model.set({ lng: 12.6, lat: 56.0 }); // due north, 6 nm
    expect(h.read("cursor.brg")).toMatchObject({ value: "000", unit: "°T", sub: "fr. ship" });
    expect(h.read("cursor.rng")).toMatchObject({ value: "6.00", unit: "nm", sub: "fr. ship" });
    h.dispose();
  });

  test("under a nautical mile it reads metres, like the rest of the tree", () => {
    const h = harness();
    h.model.set({ lng: 12.6, lat: 55.905 });
    expect(h.read("cursor.rng").unit).toBe("m");
    h.dispose();
  });

  /** Nothing hovered is a state, not an error — and it must not be the last
   * bearing you happened to have, which would be a number pointing nowhere. */
  test("no hover: no number, and it says why", () => {
    const h = harness();
    expect(h.read("cursor.brg")).toMatchObject({ state: "null", sub: "hover" });
    expect(h.read("cursor.rng")).toMatchObject({ state: "null", sub: "hover" });
    h.dispose();
  });

  test("leaving the chart drops the reading rather than staling it", () => {
    const h = harness();
    h.model.set({ lng: 12.6, lat: 56.0 });
    expect(h.read("cursor.brg").state).toBeUndefined();
    h.model.set(null);
    expect(h.read("cursor.brg").state).toBe("null");
    h.dispose();
  });

  /** A boat with no fix has no bearing to anything. Offline is normal here. */
  test("no fix: nothing to measure from", () => {
    const h = harness(null);
    h.model.set({ lng: 12.6, lat: 56.0 });
    expect(h.read("cursor.brg").state).toBe("null");
    expect(h.read("cursor.rng").state).toBe("null");
    h.dispose();
  });

  test("neither may alarm — a pointer is not a hazard", () => {
    const h = harness();
    for (const id of ["cursor.brg", "cursor.rng"]) expect(h.byId(id).maxUrgency).toBe("none");
    h.dispose();
  });
});

/**
 * The load-bearing property, and the whole argument for Measure: `desktopOnly`
 * is filtered by POINTER (`ChromeConfig.pointerCoarse`, #DENS-SLIDER — a
 * device fact separate from the size slider), so a coarse-pointer tablet —
 * wide, coarse, gloved — drops the readout for exactly the reason a phone
 * does. The kernel already does this (`bands.configurable`); this asserts the
 * widget declares itself correctly and that the two halves meet.
 */
describe("desktopOnly", () => {
  const seatedAt = (pointerCoarse: boolean) =>
    createRoot((dispose) => {
      const sk: SignalKState = { self: () => BOAT, targets: () => [], status: () => "connected", autopilot: () => null };
      const reg = createRegistry([createCursor(sk).feature.core]);
      const cfg = adoptDefaults({ ...DEFAULT_CHROME, pointerCoarse }, reg);
      const ids = bandList(reg, cfg, "rail").map((i) => i.id);
      dispose();
      return ids;
    });

  test("both instruments declare it", () => {
    const h = harness();
    for (const id of ["cursor.brg", "cursor.rng"]) expect(h.byId(id).desktopOnly).toBe(true);
    h.dispose();
  });

  test("a fine pointer (mouse) seats them on the rail", () => {
    expect(seatedAt(false)).toEqual(["cursor.brg", "cursor.rng"]);
  });

  test("a coarse pointer drops them entirely — gloves do not hover", () => {
    expect(seatedAt(true)).toEqual([]);
  });
});
