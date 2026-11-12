// The C2 guarantee, as a test: the info panel and the chart derive their
// vessels from the ONE shared `SignalKState.vessels` memo, so the panel
// provably describes the vessels the chart draws.
//
// Before C2 there were two parallel derivations of the vessel set: the AIS
// overlay read `signalk.self()`/`signalk.targets()` RAW and built its scene
// from them, while the info provider read a `vesselsFromSignalK` memo built
// separately in `info/attach.tsx`. Two derivations of the same thing can drift
// — a target the panel describes differently from the one on the chart. This
// test pins the fix: both consumers now read `state.vessels`, and this asserts
// they see the identical records and place every vessel at the same position.
//
// Needs `--conditions=browser` for the same reason `signalk.test.ts` does — the
// reactive memo is vacuous under solid's SSR build.

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createSignalK, type SignalKState } from "../signalk";
import { buildAisScene, KIND } from "../layers/aisSymbols";
import { DEFAULT_SETTINGS } from "../style/settings";
import { DEFAULT_COLLISION_SETTINGS } from "../collisionSettings";
import { ownAndTargets, OWN_SHIP_ID } from "./vessel";
import {
  createVesselInfoProvider,
  vesselInfoHit,
  DEFAULT_CPA_THRESHOLDS,
} from "./vesselProvider";

// A stand-in for the backend's socket — the same seam `signalk.test.ts` drives.
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
  deliver(snapshot: unknown) {
    this.onmessage?.({ data: JSON.stringify(snapshot) });
  }
}

function harness(): { state: SignalKState; socket: FakeSocket; dispose: () => void } {
  const sockets: FakeSocket[] = [];
  let state!: SignalKState;
  const dispose = createRoot((dispose) => {
    state = createSignalK({
      url: "ws://boat/api/signalk/stream",
      open: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    return dispose;
  });
  return { state, socket: sockets[0], dispose };
}

const BOAT = { lng: 12.6, lat: 55.9, headingDeg: 90 };
// A named Class-A-ish target (normal MMSI → a real vessel, not a station) and a
// bare positional target (no mmsi → identity is its position, see `vesselId`).
const TARGET_A = { lng: 12.7, lat: 56.0, mmsi: "265123456", name: "Kraka" };
const TARGET_B = { lng: 12.8, lat: 56.1 };

/** A trivial, invertible projection so the provider can hit-test without a map. */
const project = (p: { lng: number; lat: number }) => ({ x: p.lng * 100, y: p.lat * 100 });

/** Every drawn vessel symbol's coordinate, from a built scene. */
const vesselCoords = (scene: ReturnType<typeof buildAisScene>): [number, number][] =>
  [...scene.own.features, ...scene.targets.features]
    .filter((f) => f.properties?.kind === KIND.vessel && f.geometry.type === "Point")
    .map((f) => (f.geometry as { coordinates: [number, number] }).coordinates)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe("panel and chart derive vessels from the one shared memo (C2)", () => {
  test("both consumers read the SAME memo — identical array reference", () => {
    const { state, socket, dispose } = harness();
    socket.deliver({ status: "connected", self: BOAT, targets: [TARGET_A, TARGET_B] });

    // The overlay (layers/overlay.ts) partitions `state.vessels()`; the provider
    // (info/attach.tsx) is built over the `state.vessels` accessor. Both invoke
    // the one memo, which caches, so they get the very same array back.
    const overlaySees = state.vessels();
    const providerSees = state.vessels();
    expect(providerSees).toBe(overlaySees);

    // And `ownAndTargets` (the overlay's partition) hands back the SAME element
    // objects — no re-derivation, no copy that could drift.
    const { self, targets } = ownAndTargets(overlaySees);
    expect(self).toBe(overlaySees[0]);
    expect(targets[0]).toBe(overlaySees[1]);
    expect(targets[1]).toBe(overlaySees[2]);

    dispose();
  });

  test("the shared list is own-first with stable identities", () => {
    const { state, socket, dispose } = harness();
    socket.deliver({ status: "connected", self: BOAT, targets: [TARGET_A, TARGET_B] });

    const vessels = state.vessels();
    expect(vessels.map((v) => v.id)).toEqual([
      OWN_SHIP_ID,
      "mmsi:265123456",
      `at:${TARGET_B.lat.toFixed(5)},${TARGET_B.lng.toFixed(5)}`,
    ]);
    expect(vessels[0].self).toBe(true);
    expect(vessels.slice(1).every((v) => !v.self)).toBe(true);

    dispose();
  });

  test("panel (locate) and chart (scene) place every vessel identically", () => {
    const { state, socket, dispose } = harness();
    socket.deliver({ status: "connected", self: BOAT, targets: [TARGET_A, TARGET_B] });

    const provider = createVesselInfoProvider({
      vessels: state.vessels,
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project,
    });

    // The overlay renders the scene built from the same list.
    const { self, targets } = ownAndTargets(state.vessels());
    const drawn = vesselCoords(buildAisScene(self, targets, { ...DEFAULT_SETTINGS, collision: DEFAULT_COLLISION_SETTINGS }));

    // For every vessel in the ONE list, the panel resolves its position (the
    // record it would describe) to exactly where the chart drew its symbol.
    for (const v of state.vessels()) {
      const at = provider.locate(vesselInfoHit(v.id));
      expect(at).toEqual({ lng: v.lng, lat: v.lat });
      expect(drawn).toContainEqual([v.lng, v.lat]);
    }

    // Same count both ways: the chart draws neither more nor fewer vessels than
    // the panel knows about.
    expect(drawn).toHaveLength(state.vessels().length);

    dispose();
  });

  test("a moving target stays agreed across a delta", () => {
    const { state, socket, dispose } = harness();
    socket.deliver({ status: "connected", self: BOAT, targets: [TARGET_A] });

    const provider = createVesselInfoProvider({
      vessels: state.vessels,
      thresholds: () => DEFAULT_CPA_THRESHOLDS,
      project,
    });

    const moved = { ...TARGET_A, lng: 12.75, lat: 56.05 };
    socket.deliver({ status: "connected", self: BOAT, targets: [moved] });

    // The memo recomputed; both sides see the new position.
    const { self, targets } = ownAndTargets(state.vessels());
    const drawn = vesselCoords(buildAisScene(self, targets, { ...DEFAULT_SETTINGS, collision: DEFAULT_COLLISION_SETTINGS }));
    const at = provider.locate(vesselInfoHit("mmsi:265123456"));
    expect(at).toEqual({ lng: moved.lng, lat: moved.lat });
    expect(drawn).toContainEqual([moved.lng, moved.lat]);

    dispose();
  });
});
