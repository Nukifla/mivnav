/**
 * Man overboard: the accidental-tap guard, what the screen shows, the alarm
 * it puts in the strip (and whether it sounds), and the raise / clear /
 * server-unreachable paths. DOM-free — the button itself is not mounted.
 * NB: needs `--conditions=browser` (the `test` script).
 */

import { createRoot, createSignal } from "solid-js";
import { describe, expect, test } from "bun:test";
import { createMob } from "./index";
import type { MobClient } from "./client";
import {
  ARM_MS,
  createArmGuard,
  elapsedS,
  formatElapsed,
  mobAlertText,
  mobFix,
  mobReading,
  mobSounds,
} from "./model";
import { mobFeatures } from "./overlay";
import { alerts, createRegistry } from "../../core/chrome/registry";
import type { MobMark, MobNotice, SignalKState, SignalKStatus, Vessel } from "../../core/signalk";

const AT = "2026-11-06T14:32:05+00:00";
const T0 = Date.parse(AT);
const MARK: MobMark = { id: "m1", at: AT, lat: 55.9, lng: 12.6 };
/** 0.1 nm due north of the mark: the mark bears 180°. */
const BOAT = { lng: 12.6, lat: 55.9 + 0.1 / 60 };
const NOTICE: MobNotice = { state: "emergency", id: "n1", sound: true, acknowledged: false, ours: true };

describe("the guard", () => {
  test("first press arms, a second within the window fires", () => {
    const g = createArmGuard(5000);
    expect(g.press(0)).toBe("armed");
    expect(g.armedUntil(100)).toBe(5000);
    expect(g.press(4999)).toBe("fire");
    expect(g.armedUntil(5000)).toBeNull();
  });

  test("a lapsed arm re-arms instead of firing", () => {
    const g = createArmGuard(5000);
    g.press(0);
    expect(g.press(5000)).toBe("armed");
    expect(g.press(6000)).toBe("fire");
  });

  test("disarm forgets the first press", () => {
    const g = createArmGuard(5000);
    g.press(0);
    g.disarm();
    expect(g.press(10)).toBe("armed");
  });
});

describe("the numbers", () => {
  test("stopwatch", () => {
    expect(formatElapsed(42)).toBe("0:42");
    expect(formatElapsed(725)).toBe("12:05");
    expect(formatElapsed(3725)).toBe("1:02:05");
    expect(formatElapsed(Number.NaN)).toBe("–:––");
    expect(elapsedS(AT, T0 + 61_000)).toBe(61);
    expect(elapsedS(AT, T0 - 5_000)).toBe(0); // clock skew never goes negative
  });

  test("bearing and range from the boat to the mark", () => {
    const fix = mobFix(BOAT, MARK)!;
    expect(fix.rangeNm).toBeCloseTo(0.1, 3);
    expect(Math.round(fix.bearingDeg)).toBe(180);
    expect(mobFix(null, MARK)).toBeNull();
    expect(mobFix(BOAT, { id: "x", at: AT })).toBeNull();
  });

  test("the rail tile and the strip", () => {
    expect(mobReading(MARK, BOAT, T0 + 192_000)).toEqual({ value: "190", unit: "m", sub: "180° 3:12" });
    expect(mobReading(MARK, null, T0)).toEqual({ value: "0:00", sub: "no fix" });
    expect(mobAlertText(MARK, null, BOAT, T0 + 192_000)).toEqual([
      "MAN OVERBOARD",
      "190 m · 180°T · 3:12 ago",
    ]);
    // Someone else's MOB (an MFD's key): SignalK's own words.
    expect(mobAlertText(null, { ...NOTICE, ours: false, message: "MOB!" }, BOAT, T0)).toEqual([
      "MAN OVERBOARD",
      "MOB!",
    ]);
  });

  test("sounds here until SignalK has it, then as SignalK says", () => {
    expect(mobSounds(MARK, null)).toBe(true); // SignalK down: this screen must sound
    expect(mobSounds(MARK, NOTICE)).toBe(true);
    expect(mobSounds(MARK, { ...NOTICE, acknowledged: true })).toBe(false);
    expect(mobSounds(MARK, { ...NOTICE, silenced: true })).toBe(false);
    expect(mobSounds(null, null)).toBe(false);
  });

  test("the chart: mark, label and the line back", () => {
    const fc = mobFeatures({ mark: { lng: 12.6, lat: 55.9 }, boat: BOAT, label: "14:32" });
    expect(fc.features.map((f) => f.properties?.kind)).toEqual(["line", "mark"]);
    expect(fc.features[1]!.properties?.label).toBe("MOB\n14:32");
    expect(mobFeatures({ mark: null, boat: BOAT, label: "" }).features).toEqual([]);
  });
});

// -- the feature --------------------------------------------------------------

function fakeSignalK(init: { status?: SignalKStatus; self?: Vessel | null } = {}) {
  const [status, setStatus] = createSignal<SignalKStatus>(init.status ?? "connected");
  const [self, setSelf] = createSignal<Vessel | null>(init.self ?? null);
  const [mob, setMob] = createSignal<MobMark | null>(null);
  const [mobNotice, setMobNotice] = createSignal<MobNotice | null>(null);
  const sk = { self, status, mob, mobNotice, targets: () => [], vessels: () => [] } as unknown as SignalKState;
  return { sk, setStatus, setSelf, setMob, setMobNotice };
}

function spyClient(opts: { down?: boolean } = {}) {
  const calls: string[] = [];
  const state = { down: !!opts.down };
  const client: MobClient = {
    raise: (at) => {
      calls.push(`raise ${at ? `${at.lat},${at.lng}` : "-"}`);
      return Promise.resolve(state.down ? null : { ...MARK, ...(at ?? {}) });
    },
    clear: () => {
      calls.push("clear");
      return Promise.resolve(!state.down);
    },
    navigate: () => {
      calls.push("navigate");
      return Promise.resolve({ ok: true });
    },
    ack: (id) => {
      calls.push(`ack ${id}`);
      return Promise.resolve({ ok: true });
    },
    get: () => Promise.resolve(null),
  };
  return { client, calls, state };
}

function build(init: Parameters<typeof fakeSignalK>[0] = {}, clientOpts: { down?: boolean } = {}) {
  const fake = fakeSignalK({ self: { id: "urn:self", ...BOAT } as Vessel, ...init });
  const spy = spyClient(clientOpts);
  const clock = { t: T0 };
  let dispose = () => {};
  const mob = createRoot((d) => {
    dispose = d;
    return createMob({ signalk: fake.sk, client: spy.client, now: () => clock.t });
  });
  return { mob, fake, spy, clock, dispose };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the feature", () => {
  test("one press only arms; the second raises at the boat's position", async () => {
    const { mob, spy, clock, dispose } = build();
    mob.model.press();
    expect(mob.model.armed()).toBe(true);
    expect(spy.calls).toEqual([]);
    clock.t += ARM_MS - 1000;
    mob.model.press();
    await flush();
    expect(spy.calls).toEqual([`raise ${BOAT.lat},${BOAT.lng}`]);
    expect(mob.model.armed()).toBe(false);
    expect(mob.model.mark()?.id).toBe("m1");
    dispose();
  });

  test("the O key is bound and runs the same guard", () => {
    const { mob, spy, dispose } = build();
    const cmds = mob.feature.commands!({} as never);
    const key = cmds.find((c) => c.id === "mob-key")!;
    expect(key.keybinding).toEqual({ key: "o" });
    expect(key.palette).toBe(false);
    key.run({ close: () => {}, prompt: () => {} });
    expect(mob.model.armed()).toBe(true);
    expect(spy.calls).toEqual([]);
    dispose();
  });

  test("an active MOB alarms in the strip; ACK acknowledges on SignalK", () => {
    const { mob, fake, spy, dispose } = build();
    const reg = createRegistry([mob.feature.core]);
    expect(alerts(reg)).toEqual([]);
    fake.setMob(MARK);
    fake.setMobNotice(NOTICE);
    const [alert] = alerts(reg);
    expect(alert!.title).toBe("MAN OVERBOARD");
    expect(alert!.sound).toBe(true);
    alert!.ack!();
    expect(spy.calls).toEqual(["ack n1"]);
    dispose();
  });

  test("a MOB raised elsewhere on SignalK alarms here too", () => {
    const { mob, fake, dispose } = build();
    const reg = createRegistry([mob.feature.core]);
    fake.setMobNotice({ ...NOTICE, ours: false, message: "MOB from the MFD" });
    expect(alerts(reg).map((a) => a.detail)).toEqual(["MOB from the MFD"]);
    dispose();
  });

  test("with the server unreachable the screen still marks and alarms, and keeps trying", async () => {
    const { mob, spy, clock, dispose } = build({}, { down: true });
    await mob.model.raise();
    expect(mob.model.unsent()).toBe(true);
    expect(mob.model.mark()?.lat).toBeCloseTo(BOAT.lat, 6);
    clock.t += 60_000; // pending outlasts the grace window
    expect(mob.model.mark()).not.toBeNull();
    // Cleared before it ever reached the server: nothing to clear there.
    await mob.model.clear();
    expect(mob.model.mark()).toBeNull();
    expect(spy.calls.filter((c) => c === "clear")).toEqual([]);
    dispose();
  });

  test("clear asks the server, and only then drops the mark", async () => {
    const { mob, fake, spy, clock, dispose } = build();
    fake.setMob(MARK);
    expect(mob.model.mark()?.id).toBe("m1");
    spy.state.down = true;
    await mob.model.clear();
    expect(mob.model.mark()?.id).toBe("m1");
    expect(mob.model.feedback()).toContain("still up");
    spy.state.down = false;
    await mob.model.clear();
    expect(mob.model.mark()).toBeNull();
    fake.setMob(null);
    clock.t += 10_000;
    expect(mob.model.mark()).toBeNull();
    dispose();
  });

  test("palette: raise while none is up; steer and clear while one is", () => {
    const { mob, fake, dispose } = build();
    const ids = () => mob.feature.commands!({} as never).map((c) => c.id);
    expect(ids()).toEqual(["mob-key", "mob-raise"]);
    fake.setMob(MARK);
    expect(ids()).toEqual(["mob-key", "mob-navigate", "mob-clear"]);
    dispose();
  });
});
