/**
 * An open panel must not lie (#52).
 *
 * The defect: `InfoPanel` resolved the record once, when the panel opened, and
 * `detail` is one-shot by the seam's design — so an AIS panel was frozen at the
 * instant of the tap. It kept saying "Range 2.1 nm, we pass ahead" while the
 * two boats moved, and a stale CPA that looks live is worse than no CPA. This
 * is the test that says it is fixed, so it is driven through the *real* vessel
 * provider against a *real* SignalK-shaped tick rather than a stub that
 * re-resolves on demand — a stub would only prove that `createResource` can be
 * made to refetch.
 *
 * The other half of the fix is what does *not* happen: a chart object's detail
 * is derived from the tap's own payload and cannot change, so it declares no
 * revision and is resolved exactly once, however hard the vessels tick.
 *
 * NB: needs `--conditions=browser` (the `test` script). Bare `bun test`
 * resolves solid-js's `node` export, whose createEffect never runs, so the
 * resource would never load and every assertion here would be undefined.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createHitDetail } from "./detail";
import type { InfoDetail, InfoHit, InfoPoint, InfoProvider } from "./types";
import { OWN_SHIP_ID, type AisVessel } from "./vessel";
import { createVesselInfoProvider, DEFAULT_CPA_THRESHOLDS, vesselInfoHit } from "./vesselProvider";

const OWN_LAT = 55.9;
const OWN_LNG = 12.6;
const KN_10_MS = (10 * 1852) / 3600;

const project = (p: InfoPoint) => ({ x: p.lng * 1000, y: p.lat * 1000 });

/** Solid's effects (and so the resource's load) flush synchronously on a
 * write; the fetch itself is a promise, so a lookup lands a microtask later. */
const settled = () => new Promise((r) => setTimeout(r, 0));

function row(detail: InfoDetail | undefined, label: string): string | undefined {
  return detail?.sections.flatMap((s) => s.rows).find((r) => r.label === label)?.value;
}

/** Own ship, stopped, at the origin of the little world below. */
function self(): AisVessel {
  return { id: OWN_SHIP_ID, self: true, lat: OWN_LAT, lng: OWN_LNG, sogMs: 0 };
}

/** A target due east, closing from the east at 10 kn on a westerly course —
 * i.e. straight at us. `atLng` is how far east it has got. */
function target(atLng: number): AisVessel {
  return { id: "mmsi:1", lat: OWN_LAT, lng: atLng, cogDeg: 270, sogMs: KN_10_MS, name: "Nordkap" };
}

/** The panel's detail over a live vessel list, driven outside the root so that
 * each write flushes on its own (see ./marker.test.ts). */
function harness(providers: readonly InfoProvider[], hit: InfoHit) {
  const [current, setCurrent] = createSignal<InfoHit | undefined>(hit);
  const [detail, dispose] = createRoot((dispose) => {
    return [createHitDetail(providers, current), dispose] as const;
  });
  return { detail, setCurrent, dispose };
}

function vesselHarness() {
  const [vessels, setVessels] = createSignal<AisVessel[]>([self(), target(12.7)]);
  const provider = createVesselInfoProvider({
    vessels,
    thresholds: () => DEFAULT_CPA_THRESHOLDS,
    project,
  });
  // The non-map entry point, so this is also the target-list/alarm path.
  return { ...harness([provider], vesselInfoHit("mmsi:1")), setVessels, provider };
}

describe("createHitDetail — the panel is a claim about now", () => {
  test("an open panel's range and CPA follow the target as it closes", async () => {
    const { detail, setVessels, dispose } = vesselHarness();
    await settled();

    const rangeAtTap = row(detail(), "Range");
    const cpaAtTap = row(detail(), "CPA");
    expect(rangeAtTap).toBeDefined();
    expect(detail()?.title).toBe("Nordkap");

    // A SignalK tick: the target has run half the distance in.
    setVessels([self(), target(12.65)]);
    await settled();

    expect(row(detail(), "Range")).toBeDefined();
    expect(row(detail(), "Range")).not.toBe(rangeAtTap);
    // Guard against a vacuous pass: it must have got *closer*, not merely
    // different, or this would pass on any re-render at all.
    expect(parseFloat(row(detail(), "Range")!)).toBeLessThan(parseFloat(rangeAtTap!));
    expect(cpaAtTap).toBeDefined();
    dispose();
  });

  test("own ship moving re-answers the CPA, even with the target sitting still", async () => {
    // The reason `revision` reads the whole live list rather than one vessel.
    const moored: AisVessel = { id: "mmsi:2", lat: OWN_LAT + 0.05, lng: OWN_LNG, sogMs: 0, cogDeg: 0 };
    const [vessels, setVessels] = createSignal<AisVessel[]>([self(), moored]);
    const provider = createVesselInfoProvider({
      vessels,
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project,
    });
    const { detail, dispose } = harness([provider], vesselInfoHit("mmsi:2"));
    await settled();
    const before = row(detail(), "Range");
    expect(before).toBeDefined();

    // We get underway towards it. The target has not sent a thing.
    setVessels([{ ...self(), lat: OWN_LAT + 0.02, cogDeg: 0, sogMs: KN_10_MS }, moored]);
    await settled();

    expect(row(detail(), "Range")).not.toBe(before);
    expect(row(detail(), "Collision risk")).toBeDefined();
    dispose();
  });

  test("a target that stops being received says so, rather than holding its last CPA", async () => {
    const { detail, setVessels, dispose } = vesselHarness();
    await settled();
    expect(row(detail(), "Range")).toBeDefined();

    setVessels([self()]); // expired
    await settled();

    expect(row(detail(), "Vessel")).toBe("no longer being received");
    expect(row(detail(), "Range")).toBeUndefined();
    dispose();
  });

  test("a re-resolve never blanks the panel — the sheet refreshes, it does not flash", async () => {
    const { detail, setVessels, dispose } = vesselHarness();
    await settled();
    expect(detail()).toBeDefined();

    setVessels([self(), target(12.65)]);
    // Synchronously after the tick, mid-refetch: the last record is still on
    // screen. A "Loading…" flash every second would be its own defect.
    expect(detail()).toBeDefined();
    await settled();
    expect(detail()).toBeDefined();
    dispose();
  });

  test("selecting another hit resolves that one", async () => {
    const { detail, setCurrent, dispose } = vesselHarness();
    await settled();
    expect(detail()?.title).toBe("Nordkap");

    setCurrent(vesselInfoHit(OWN_SHIP_ID));
    await settled();
    expect(detail()?.title).toBe("Own ship");
    dispose();
  });
});

describe("createHitDetail — a provider that declares no revision", () => {
  /** Counts its lookups. Stands in for chartProvider, whose detail is a pure
   * function of the payload the tap handed it. */
  function countingProvider(): { provider: InfoProvider; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      provider: {
        id: "chart",
        label: "Chart",
        queryAt: () => [],
        detail: () => {
          calls++;
          return { sections: [{ rows: [{ label: "Depth", value: "5.2 m" }] }] };
        },
      },
    };
  }

  const chartHit: InfoHit = {
    providerId: "chart",
    id: "sounding",
    priority: "depth",
    precision: "point",
    title: "Sounding",
  };

  test("is resolved once and stays resolved", async () => {
    const { provider, calls } = countingProvider();
    const [tick, setTick] = createSignal(0);
    const { detail, dispose } = harness([provider], chartHit);
    await settled();
    expect(row(detail(), "Depth")).toBe("5.2 m");
    expect(calls()).toBe(1);

    // The world ticks on around it — a chart object cannot hear it, and paying
    // to re-derive a static record on every SignalK delta is the waste that
    // makes a reactive `detail` at the seam the wrong shape.
    for (let i = 0; i < 5; i++) setTick(i + 1);
    await settled();
    expect(tick()).toBe(5);
    expect(calls()).toBe(1);
    dispose();
  });

  test("a hit with no provider left is told so, not thrown at", async () => {
    const { detail, dispose } = harness([], chartHit);
    await settled();
    expect(row(detail(), "Source")).toBe("unavailable (chart)");
    dispose();
  });

  test("no hit, no lookup", async () => {
    const { provider, calls } = countingProvider();
    const [current] = createSignal<InfoHit | undefined>(undefined);
    const [detail, dispose] = createRoot((dispose) => {
      return [createHitDetail([provider], current), dispose] as const;
    });
    await settled();
    expect(detail()).toBeUndefined();
    expect(calls()).toBe(0);
    dispose();
  });
});

describe("createHitDetail — a record belongs to its hit", () => {
  // The desktop panel keeps ONE HitSlide and swaps its hit in place (tap B
  // with A still open). A record still resolving for B must not leave A's on
  // screen under B's title — that was the "title changes, details stay" bug.
  function deferredProvider() {
    const pending = new Map<string, (d: InfoDetail) => void>();
    const provider: InfoProvider = {
      id: "poi",
      label: "POI",
      queryAt: () => [],
      detail: (hit) => new Promise<InfoDetail>((resolve) => pending.set(hit.id, resolve)),
    };
    const land = (id: string) => pending.get(id)?.({ title: `record ${id}`, sections: [] });
    return { provider, land };
  }
  const poiHit = (id: string): InfoHit => ({
    providerId: "poi",
    id,
    priority: "regulated",
    precision: "point",
    title: `hit ${id}`,
  });

  test("swapping A → B in place shows nothing of A while B resolves, then B's record", async () => {
    const { provider, land } = deferredProvider();
    const { detail, setCurrent, dispose } = harness([provider], poiHit("A"));
    land("A");
    await settled();
    expect(detail()?.title).toBe("record A");

    setCurrent(poiHit("B"));
    await settled();
    expect(detail()).toBeUndefined(); // B still resolving: not A's record
    land("B");
    await settled();
    expect(detail()?.title).toBe("record B");

    setCurrent(poiHit("A"));
    await settled();
    expect(detail()).toBeUndefined(); // and back: never B's under A
    land("A");
    await settled();
    expect(detail()?.title).toBe("record A");
    dispose();
  });

  test("a fresh hit OBJECT for the same subject keeps its record (a repeat tap does not blank)", async () => {
    const { provider, land } = deferredProvider();
    const { detail, setCurrent, dispose } = harness([provider], poiHit("A"));
    land("A");
    await settled();
    setCurrent(poiHit("A"));
    expect(detail()?.title).toBe("record A");
    dispose();
  });
});
