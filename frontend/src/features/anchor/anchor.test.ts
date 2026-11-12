/**
 * The anchor watch as a feature (anchor.md). The plugin decides whether the
 * boat is dragging; these lock in how its verdict reaches the chrome — the
 * alarm band, the universal ACK, the sound, the chart — and that nothing
 * here second-guesses it.
 *
 * DOM-free: the control card's `render` is asserted wired, not mounted.
 * NB: needs `--conditions=browser` (the `test` script).
 */

import { createRoot, createSignal } from "solid-js";
import { describe, expect, test } from "bun:test";
import { createAnchor } from "./index";
import {
  anchorAlertText,
  anchorPhase,
  anchorReading,
  anchorUrgency,
  armRadiusFromHere,
  circleRing,
  clampRadius,
} from "./model";
import { anchorFeatures, watchTone } from "./overlay";
import { createAnchorController, type AnchorController, type TrackFix } from "./client";
import { alerts, createRegistry, urgencyOf } from "../../core/chrome/registry";
import { shouldSound } from "../../core/chrome/alarmSound";
import type { Anchor, AnchorAlarm, SignalKState, SignalKStatus, Vessel } from "../../core/signalk";

const DOWN: Anchor = { lat: 55.9, lng: 12.6, maxRadiusM: 40, currentRadiusM: 12.4, bearingTrueDeg: 213.4 };
/** Marked, no radius: what drop() leaves — no `maxRadius`, no `currentRadius`
 * (the plugin does not watch, so it does not measure). */
const DROPPING: Anchor = { lat: 55.9, lng: 12.6 };
const BOAT_12M_N = { lng: 12.6, lat: 55.9 + 12.4 / 111_320 };
const EMERGENCY: AnchorAlarm = {
  state: "emergency",
  message: "Anchor Alarm - Emergency",
  id: "9d6e9d73-e919-40c3-8802-58351d896e8b",
  sound: true,
  acknowledged: false,
  canAcknowledge: true,
};

function fakeSignalK(init: { anchor?: Anchor | null; status?: SignalKStatus; self?: Vessel | null } = {}) {
  const [anchor, setAnchor] = createSignal<Anchor | null>(init.anchor ?? null);
  const [status, setStatus] = createSignal<SignalKStatus>(init.status ?? "connected");
  const [self, setSelf] = createSignal<Vessel | null>(init.self ?? null);
  const sk: SignalKState = {
    self,
    targets: () => [],
    status,
    autopilot: () => null,
    course: () => null,
    paths: () => ({}),
    anchor,
    vessels: () => [],
  };
  return { sk, setAnchor, setStatus, setSelf };
}

function spyController(track: TrackFix[] = []): AnchorController & { calls: string[] } {
  const calls: string[] = [];
  const ok = (call: string) => {
    calls.push(call);
    return Promise.resolve({ status: "ok" as const });
  };
  return {
    calls,
    drop: (r) => ok(`drop ${r}`),
    radiusFromHere: () => ok("fromHere"),
    setRadius: (r) => ok(`radius ${r}`),
    move: (lat, lng, r) => ok(`move ${lat} ${lng} ${r}`),
    raise: () => ok("raise"),
    ack: (id) => ok(`ack ${id}`),
    track: () => Promise.resolve(track),
    feedback: () => null,
  };
}

/** Build the feature inside a root, with a no-op track poll. */
function build(init: Parameters<typeof fakeSignalK>[0] = {}, track: TrackFix[] = []) {
  const fake = fakeSignalK(init);
  const controller = spyController(track);
  let dispose = () => {};
  const anchor = createRoot((d) => {
    dispose = d;
    return createAnchor({
      signalk: fake.sk,
      controller,
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    });
  });
  const reg = createRegistry([anchor.feature.core]);
  const watch = reg.byId("anchor.watch")!;
  return { ...fake, controller, anchor, reg, watch, dispose };
}

describe("what the plugin's state means", () => {
  test("no plugin heard, anchor up, anchor down", () => {
    expect(anchorPhase(null)).toBe("none");
    expect(anchorPhase({ fudgeM: 0 })).toBe("up");
    expect(anchorPhase(DOWN)).toBe("down");
    expect(anchorPhase(DROPPING)).toBe("dropping");
  });

  test("arming from here: distance + 10 m (+ the plugin's fudge), rounded up", () => {
    // Unarmed: measured from our own fix.
    expect(armRadiusFromHere(DROPPING, BOAT_12M_N)).toBe(23);
    expect(armRadiusFromHere({ ...DROPPING, fudgeM: 8 }, BOAT_12M_N)).toBe(31);
    expect(armRadiusFromHere(DROPPING, null)).toBeUndefined();
    // Watched: the plugin's own measurement wins.
    expect(armRadiusFromHere(DOWN, null)).toBe(23);
  });

  test("while dropping: no watch circle, but the rode and the glyph", () => {
    const kinds = (a: Anchor) =>
      anchorFeatures({ anchor: a, boat: { lng: 12.6001, lat: 55.9001 }, track: [] }).features.map(
        (f) => f.properties?.kind,
      );
    expect(kinds(DROPPING)).toEqual(["rode", "anchor"]);
    expect(kinds(DOWN)).toEqual(["circle", "rode", "anchor"]);
  });

  test("urgency follows the notification, and an ACK drops it to notice everywhere", () => {
    expect(anchorUrgency({ ...DOWN, alarm: { state: "normal", sound: true } })).toBe("none");
    expect(anchorUrgency({ ...DOWN, alarm: { state: "warn", sound: true } })).toBe("notice");
    expect(anchorUrgency({ ...DOWN, alarm: EMERGENCY })).toBe("alarm");
    expect(anchorUrgency({ ...DOWN, alarm: { ...EMERGENCY, state: "alarm" } })).toBe("alarm");
    expect(anchorUrgency({ ...DOWN, alarm: { ...EMERGENCY, acknowledged: true, sound: false } })).toBe(
      "notice",
    );
  });

  test("the plugin's generic message reads as dragging; its specific ones are kept", () => {
    expect(anchorAlertText({ ...DOWN, alarm: EMERGENCY })).toEqual([
      "⚓ ANCHOR DRAGGING",
      "12 m from anchor · watch 40 m · anchor bears 213°",
    ]);
    expect(anchorAlertText({ ...DOWN, alarm: { ...EMERGENCY, message: "No position received" } })[0]).toBe(
      "⚓ ANCHOR ALARM — No position received",
    );
  });

  test("the rail reading", () => {
    expect(anchorReading(DOWN)).toEqual({ value: "12/40", unit: "m", sub: "213°" });
    expect(anchorReading({})).toEqual({ value: "—" });
    expect(anchorReading(DROPPING)).toEqual({ value: "SET", sub: "no alarm" });
  });

  test("radius clamp mirrors the backend's bounds", () => {
    expect(clampRadius(2)).toBe(5);
    expect(clampRadius(42.4)).toBe(42);
    expect(clampRadius(5000)).toBe(1000);
  });

  test("the watch circle is a closed ring at the radius, in metres", () => {
    const ring = circleRing({ lng: 12.6, lat: 55.9 }, 40);
    expect(ring[0]).toEqual(ring[ring.length - 1]!);
    const cos = Math.cos((55.9 * Math.PI) / 180);
    for (const [lng, lat] of ring) {
      const d = Math.hypot((lng - 12.6) * 111_320 * cos, (lat - 55.9) * 111_320);
      expect(d).toBeCloseTo(40, 6);
    }
  });
});

describe("the chart", () => {
  test("nothing is drawn while the anchor is up", () => {
    expect(anchorFeatures({ anchor: {}, boat: { lng: 12.6, lat: 55.9 }, track: [] }).features).toEqual([]);
  });

  test("anchored: track segments fading old→new, circle, rode, anchor", () => {
    const track: TrackFix[] = [
      [12.6, 55.9001, 1],
      [12.6001, 55.9001, 2],
      [12.6002, 55.9001, 3],
    ];
    const fc = anchorFeatures({ anchor: DOWN, boat: { lng: 12.6002, lat: 55.9001 }, track });
    const kinds = fc.features.map((f) => f.properties!.kind);
    expect(kinds).toEqual(["track", "track", "circle", "rode", "anchor"]);
    expect(fc.features.slice(0, 2).map((f) => f.properties!.f)).toEqual([0, 1]);
  });

  test("an ACKed alarm is quiet in the chrome but still red on the chart", () => {
    expect(watchTone({ ...DOWN, alarm: { ...EMERGENCY, acknowledged: true, sound: false } })).toBe("alarm");
    expect(watchTone({ ...DOWN, alarm: { state: "warn", sound: true } })).toBe("warn");
    expect(watchTone(DOWN)).toBe("ok");
  });
});

describe("the alarm band", () => {
  test("an unACKed emergency is in the band, asks to sound, and ACKs on the server", () => {
    const t = build({ anchor: { ...DOWN, alarm: EMERGENCY } });
    const [alert] = alerts(t.reg);
    expect(alert!.title).toBe("⚓ ANCHOR DRAGGING");
    expect(alert!.sound).toBe(true);
    alert!.ack!();
    expect(t.controller.calls).toEqual([`ack ${EMERGENCY.id}`]);
    t.dispose();
  });

  test("it sounds with the collision-alarm opt-in OFF — SignalK's method decides", () => {
    expect(shouldSound({ enabled: false, unackedAlarms: 1, soundRequested: 1 })).toBe(true);
    expect(shouldSound({ enabled: false, unackedAlarms: 1, soundRequested: 0 })).toBe(false);
  });

  test("once acknowledged ANYWHERE it leaves every device's band", () => {
    const t = build({ anchor: { ...DOWN, alarm: { ...EMERGENCY, acknowledged: true, sound: false } } });
    expect(alerts(t.reg)).toEqual([]);
    expect(urgencyOf(t.watch)).toBe("notice");
    t.dispose();
  });

  test("a dead link can't alarm (invariant #6) — the plugin and MFD still do", () => {
    const t = build({ anchor: { ...DOWN, alarm: EMERGENCY } });
    t.setStatus("connecting");
    expect(urgencyOf(t.watch)).toBe("none");
    expect(alerts(t.reg)).toEqual([]);
    t.dispose();
  });

  test("the readout is present only while anchored or alarming", () => {
    const t = build({ anchor: {} });
    expect(t.watch.when!()).toBe(false);
    t.setAnchor(DROPPING);
    expect(t.watch.when!()).toBe(true);
    t.setAnchor(DOWN);
    expect(t.watch.when!()).toBe(true);
    t.dispose();
  });
});

describe("feature wiring", () => {
  test("an anchor mode button, and no dashboard tab", () => {
    const t = build();
    const mode = t.reg.modes.get("anchor");
    expect(mode).toBeDefined();
    expect(mode!.hidden).toBeUndefined();
    expect(t.reg.pages.some((p) => p.id === "anchor")).toBe(false);
    expect(t.anchor.control.placeOnChart).toBe(t.anchor.placeOnChart);
    t.dispose();
  });

  test("place-on-chart moves the anchor to the tap, then returns to the sheet", () => {
    const t = build({ anchor: DOWN });
    const calls: string[] = [];
    t.anchor.bindMode({
      enter: (id) => calls.push(`enter ${id}`),
      leave: () => calls.push("leave"),
    });
    const mode = t.reg.modes.get("anchor-place")!;
    // Unarmed (entered some other way): the tap only leaves, sends nothing.
    expect(mode.onClick!({ lngLat: { lng: 12.61, lat: 55.91 } } as never)).toBe(true);
    expect(t.controller.calls).toEqual([]);
    expect(calls).toEqual(["leave"]);
    // The sheet's button: the place mode enters, the tap moves the anchor and
    // re-opens the anchor sheet.
    t.anchor.placeOnChart(35);
    expect(calls).toEqual(["leave", "enter anchor-place"]);
    mode.onClick!({ lngLat: { lng: 12.61, lat: 55.91 } } as never);
    expect(t.controller.calls).toEqual(["move 55.91 12.61 35"]);
    expect(calls).toEqual(["leave", "enter anchor-place", "enter anchor"]);
    mode.leave!();
    mode.onClick!({ lngLat: { lng: 12.62, lat: 55.92 } } as never);
    expect(t.controller.calls).toHaveLength(1); // leaving disarms
    // While the rode is going out, placing keeps it unarmed.
    t.anchor.placeOnChart(null);
    mode.onClick!({ lngLat: { lng: 12.63, lat: 55.93 } } as never);
    expect(t.controller.calls).toEqual(["move 55.91 12.61 35", "move 55.93 12.63 null"]);
    t.dispose();
  });

  test("the palette offers Drop only while the anchor is up and the link live", () => {
    const deps = { activeMode: () => null } as never;
    const up = build({ anchor: {} });
    expect(up.anchor.feature.commands!(deps).map((c) => c.id)).toEqual(["anchor-open", "anchor-drop"]);
    up.dispose();
    const down = build({ anchor: DOWN });
    expect(down.anchor.feature.commands!(deps).map((c) => c.id)).toEqual(["anchor-open"]);
    down.dispose();
  });

  test("the swing track: the plugin's fixes, then the live tail past them", async () => {
    const t = build({ anchor: DOWN }, [[12.6, 55.9001, 1000]]);
    await Promise.resolve();
    await Promise.resolve();
    t.setSelf({ lng: 12.6003, lat: 55.9001 });
    t.setSelf({ lng: 12.60031, lat: 55.9001 }); // < 2 m: jitter, not a swing
    const track = t.anchor.scene().track;
    expect(track.length).toBe(2);
    expect(track[0]).toEqual([12.6, 55.9001, 1000]);
    expect(track[1]!.slice(0, 2)).toEqual([12.6003, 55.9001]);
    t.dispose();
  });
});

describe("the client", () => {
  const respond = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  test("each verb hits its route with its body", async () => {
    const seen: [string, string | undefined, string | undefined][] = [];
    const c = createAnchorController({
      fetch: (url, init) => {
        seen.push([url, init?.method, init?.body as string | undefined]);
        return respond(200, { ok: true });
      },
    });
    await c.drop();
    await c.drop(40);
    await c.radiusFromHere();
    await c.setRadius(55);
    await c.move(55.9, 12.6, 30);
    await c.move(55.9, 12.6, null);
    await c.raise();
    await c.ack("abc-1");
    expect(seen).toEqual([
      ["/api/anchor/drop", "POST", "{}"],
      ["/api/anchor/drop", "POST", '{"radiusM":40}'],
      ["/api/anchor/radius", "POST", "{}"],
      ["/api/anchor/radius", "POST", '{"radiusM":55}'],
      ["/api/anchor/position", "PUT", '{"lat":55.9,"lng":12.6,"radiusM":30}'],
      ["/api/anchor/position", "PUT", '{"lat":55.9,"lng":12.6,"radiusM":null}'],
      ["/api/anchor/raise", "POST", "{}"],
      ["/api/anchor/ack", "POST", '{"id":"abc-1"}'],
    ]);
  });

  test("502 and 409 are different facts, in the plugin's own words", async () => {
    let next: [number, unknown] = [502, { detail: "box did not answer" }];
    const c = createAnchorController({ fetch: () => respond(...next) });
    expect(await c.raise()).toEqual({ status: "unreachable", message: "box did not answer" });
    expect(c.feedback()).toMatchObject({ kind: "unreachable", label: "Raise anchor" });
    next = [409, { detail: "the anchor has not been dropped" }];
    expect(await c.radiusFromHere()).toEqual({
      status: "refused",
      message: "the anchor has not been dropped",
    });
  });

  test("a failed track read is an empty track, never a throw", async () => {
    const c = createAnchorController({ fetch: () => Promise.reject(new Error("offline")) });
    expect(await c.track()).toEqual([]);
  });
});
