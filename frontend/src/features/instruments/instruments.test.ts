import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { alerts, createRegistry, readInstrument, urgencyOf, type Instrument } from "../../core/chrome/registry";
import type { SignalKState, Vessel } from "../../core/signalk";
import { DEFAULT_SHALLOW_SETTINGS, type Shallow, type ShallowNotice, type ShallowSettings } from "../../core/shallow";
import { createInstruments } from ".";
import { formatWindAngle, primaryDepth, shallowAlertText, shallowUrgency } from "./model";

const BOAT: Vessel = { lat: 55, lng: 12 };
const SHALLOW: Shallow = { depthM: 2.1, source: "surface", thresholdM: 3.1, active: true };

function fake(self: Vessel) {
  const [s, setSelf] = createSignal<Vessel | null>(self);
  const [shallow, setShallow] = createSignal<Shallow | null>(null);
  const [notice, setNotice] = createSignal<ShallowNotice | null>(null);
  const [settings, setSettings] = createSignal<ShallowSettings>(DEFAULT_SHALLOW_SETTINGS);
  const state = {
    self: s,
    status: () => "connected",
    shallow,
    shallowNotice: notice,
    shallowSettings: settings,
  } as unknown as SignalKState;
  return { state, setSelf, setShallow, setNotice, setSettings };
}

function setup(self: Vessel) {
  return createRoot((dispose) => {
    const sk = fake(self);
    const acked: string[][] = [];
    const muted: string[][] = [];
    const feature = createInstruments({
      signalk: sk.state,
      ackShallow: async (ids) => (acked.push(ids), true),
      silenceShallow: async (ids) => (muted.push(ids), true),
    });
    const by = (id: string): Instrument => feature.core.instruments!.find((i) => i.id === id)!;
    return { ...sk, feature, by, acked, muted, dispose };
  });
}

const strip = { density: 0.5, band: "rail", room: "strip" } as const;
const board = { density: 0.5, band: "rail", room: "board" } as const;

describe("which depth the tile leads with", () => {
  test("surface, then transducer, then keel — and says which", () => {
    expect(primaryDepth({ ...BOAT, depthBelowSurfaceM: 5, depthBelowTransducerM: 4.5 })?.short).toBe("DBS");
    expect(primaryDepth({ ...BOAT, depthBelowTransducerM: 4.5, depthBelowKeelM: 2.5 })?.short).toBe("DBT");
    expect(primaryDepth({ ...BOAT, depthBelowKeelM: 2.5 })?.words).toBe("under keel");
    expect(primaryDepth(BOAT)).toBeNull();
  });

  test("a live reading beats a stale better one; all stale still shows (struck through)", () => {
    const v = { ...BOAT, depthBelowSurfaceM: 5, depthBelowTransducerM: 4.5, stale: { depthBelowSurfaceM: 20 } };
    expect(primaryDepth(v)?.short).toBe("DBT");
    const dead = { ...BOAT, depthBelowSurfaceM: 5, stale: { depthBelowSurfaceM: 20 } };
    expect(primaryDepth(dead)?.staleAge).toBe(20);
  });
});

describe("the depth tile", () => {
  test("is absent until a sounder has spoken — no tile that looks like a guard", () => {
    const t = setup(BOAT);
    expect(t.by("env.depth").when!()).toBe(false);
    t.setSelf({ ...BOAT, depthBelowTransducerM: 7.25 });
    expect(t.by("env.depth").when!()).toBe(true);
    expect(t.by("env.depth").read(strip)).toEqual({ value: "7.3", unit: "m", sub: "DBT" });
    t.dispose();
  });

  test("the board names the depth, the keel clearance and the alarm line", () => {
    const t = setup({ ...BOAT, depthBelowSurfaceM: 4.2, depthBelowKeelM: 2.0 });
    t.setShallow({ ...SHALLOW, active: false });
    expect(t.by("env.depth").read(board).sub).toBe("below surface · keel 2.0 · alarm <3.1");
    t.dispose();
  });

  test("alarms from the SERVER's verdict, through the alarm band, with ACK/MUTE on SignalK", () => {
    const t = setup({ ...BOAT, depthBelowSurfaceM: 2.0 });
    const reg = createRegistry([t.feature.core]);
    expect(alerts(reg)).toEqual([]);
    t.setShallow(SHALLOW);
    t.setNotice({ state: "alarm", id: "n-1", sound: true, acknowledged: false, canAcknowledge: true });
    const [a] = alerts(reg);
    expect(a.id).toBe("env.depth");
    expect(a.title).toBe("⚠ SHALLOW WATER — 2.1 m");
    expect(a.sound).toBe(true);
    a.mute!.run();
    a.ack!();
    expect(t.muted).toEqual([["n-1"]]);
    expect(t.acked).toEqual([["n-1"]]);
    t.dispose();
  });

  test("a stale sounder never alarms, whatever the server last said", () => {
    const t = setup({ ...BOAT, depthBelowSurfaceM: 2.0, stale: { depthBelowSurfaceM: 10 } });
    t.setShallow(SHALLOW);
    expect(urgencyOf(t.by("env.depth"))).toBe("none");
    t.dispose();
  });

  test("off / show / acknowledged", () => {
    expect(shallowUrgency(SHALLOW, { ...DEFAULT_SHALLOW_SETTINGS, mode: "off" }, false)).toBe("none");
    expect(shallowUrgency(SHALLOW, { ...DEFAULT_SHALLOW_SETTINGS, mode: "show" }, false)).toBe("notice");
    expect(shallowUrgency(SHALLOW, DEFAULT_SHALLOW_SETTINGS, true)).toBe("notice");
    expect(shallowUrgency(SHALLOW, DEFAULT_SHALLOW_SETTINGS, false)).toBe("alarm");
    expect(shallowUrgency({ ...SHALLOW, active: false }, DEFAULT_SHALLOW_SETTINGS, false)).toBe("none");
  });

  test("says the threshold", () => {
    expect(shallowAlertText(SHALLOW)[1]).toBe("below surface · alarm under 3.1 m");
  });
});

describe("wind", () => {
  test("angles read port/starboard, SignalK's sign", () => {
    expect(formatWindAngle(-34.4)).toBe("34°P");
    expect(formatWindAngle(120)).toBe("120°S");
    expect(formatWindAngle(0)).toBe("0°");
    expect(formatWindAngle(-180)).toBe("180°");
  });

  test("apparent and true are separate tiles that go stale separately", () => {
    const t = setup({ ...BOAT, awsMs: 5, awaDeg: -40, twsMs: 4, twaDeg: -55, headingDeg: 90, stale: { twsMs: 30 } });
    expect(t.by("wind.app").read(strip)).toEqual({ value: "9.7", unit: "kn", sub: "AWA 40°P" });
    expect(readInstrument(t.by("wind.app"), strip).stale).toBe(false);
    expect(readInstrument(t.by("wind.true"), strip).stale).toBe(true);
    expect(t.by("wind.true").read(board).sub).toBe("TWA 55°P · TWD 035°");
    t.dispose();
  });

  test("no vane, no tiles", () => {
    const t = setup(BOAT);
    expect(t.by("wind.app").when!()).toBe(false);
    expect(t.by("wind.true").when!()).toBe(false);
    t.dispose();
  });

  test("the rose is a board widget, never a rail instrument", () => {
    const t = setup(BOAT);
    expect(t.feature.widgets?.map((w) => w.id)).toEqual(["wind.rose"]);
    expect(t.feature.core.instruments!.some((i) => i.id === "wind.rose")).toBe(false);
    expect(t.feature.core.dashboard![0].instruments).toContain("wind.rose");
    t.dispose();
  });
});
