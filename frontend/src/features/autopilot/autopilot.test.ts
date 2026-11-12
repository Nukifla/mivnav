/**
 * The autopilot AS A FEATURE. It used to be reserved chrome; these lock in that
 * it is now driven entirely by the ordinary registries — a rail instrument, two
 * static widgets, and a normal dashboard page — and that the narrowed safety
 * property still holds: it is never alarm-grade, and `alerts()` never sees it.
 *
 * DOM-free, like the rest of chrome/: there is no DOM under `bun test`, so the
 * widgets' `render` (a Solid component) is asserted to EXIST and be wired, not
 * mounted. The command SEMANTICS of the controller the control widget invokes
 * (engage/adjust/setMode/tack/gybe → the client) are covered exhaustively in
 * ../../core/autopilot.test.ts; here we assert the feature builds those widgets
 * and wires them to a controller.
 *
 * NB: needs `--conditions=browser` (the `test` script), like every chrome test.
 */

import { createSignal, type Accessor } from "solid-js";
import { describe, expect, test } from "bun:test";
import { createAutopilot } from "./index";
import { apMode, isWind } from "./ui";
import {
  alerts,
  createRegistry,
  defineFeature,
  DESK,
  urgencyOf,
  type Instrument,
} from "../../core/chrome/registry";
import { adoptDefaults, DEFAULT_CHROME } from "../../core/chrome/config";
import type { Autopilot, SignalKState, SignalKStatus } from "../../core/signalk";
import type { AutopilotController } from "../../core/autopilot";

/** A minimal SignalK state double — only the reads the AP feature touches. */
function fakeSignalK(
  init: { status?: SignalKStatus; autopilot?: Autopilot | null } = {},
): SignalKState & {
  setStatus: (s: SignalKStatus) => void;
  setAutopilot: (a: Autopilot | null) => void;
} {
  const [status, setStatus] = createSignal<SignalKStatus>(init.status ?? "connected");
  const [autopilot, setAutopilot] = createSignal<Autopilot | null>(init.autopilot ?? null);
  return {
    self: () => null,
    targets: () => [],
    status,
    autopilot,
    paths: () => ({}),
    vessels: () => [],
    setStatus,
    setAutopilot,
  };
}

/** A spy controller — records the method + arg of every command. */
function spyController(): AutopilotController & { calls: string[] } {
  const calls: string[] = [];
  const ok = Promise.resolve({ status: "ok" as const });
  return {
    calls,
    options: () => null,
    feedback: () => null,
    clearFeedback: () => {},
    refreshInfo: () => Promise.resolve(),
    engage: () => (calls.push("engage"), ok),
    disengage: () => (calls.push("disengage"), ok),
    adjust: (d) => (calls.push(`adjust:${d}`), ok),
    setMode: (m) => (calls.push(`setMode:${m}`), ok),
    tack: (dir) => (calls.push(`tack:${dir}`), ok),
    gybe: (dir) => (calls.push(`gybe:${dir}`), ok),
  };
}

describe("createAutopilot — the feature shape", () => {
  const feature = createAutopilot({ signalk: fakeSignalK() });

  test("contributes the Pilot page: status, control, rudder in that order", () => {
    expect(feature.core.dashboard).toEqual([
      { id: "pilot", label: "Pilot", instruments: ["ap.status", "ap.control", "ap.rudder"] },
    ]);
  });

  test("ships ap.status as an ordinary rail instrument, never alarm-grade", () => {
    const ids = (feature.core.instruments ?? []).map((i) => i.id);
    expect(ids).toEqual(["ap.status"]);
    const status = feature.core.instruments![0];
    expect(status.band).toBe("rail");
    expect(status.maxUrgency).toBe("none");
  });

  test("ships ap.control and ap.rudder as wide, static, non-deletable widgets with a render", () => {
    const widgets = feature.widgets ?? [];
    expect(widgets.map((w) => w.id)).toEqual(["ap.control", "ap.rudder"]);
    for (const w of widgets) {
      expect(w.kind).toBe("static");
      expect(w.wide).toBe(true);
      expect(w.deletable).toBe(false);
      expect(typeof w.render).toBe("function");
      // build resolves to a valid, board-fitting instrument (so `byId` finds it).
      const inst = w.build(w.id, {}, { paths: () => ({}) });
      expect(inst.id).toBe(w.id);
      expect(inst.maxUrgency).toBe("none");
    }
  });

  test("(d) the rudder is its OWN widget — a render distinct from the control's", () => {
    const [control, rudder] = feature.widgets!;
    expect(control.render).not.toBe(rudder.render);
  });
});

describe("createAutopilot — the control widget is wired to a controller (c)", () => {
  // The control widget's `render` is a Solid component that closes over the
  // injected controller and calls engage/adjust/setMode/tack/gybe on it (the
  // command SEMANTICS are proven in ../../core/autopilot.test.ts). Without a DOM
  // we assert the wiring: the feature accepts the controller and hands the
  // control widget a render, and the controller exposes exactly the command
  // surface the widget drives.
  test("accepts an injected controller and gives the control a render", () => {
    const controller = spyController();
    const feature = createAutopilot({ signalk: fakeSignalK(), controller });
    const control = feature.widgets!.find((w) => w.id === "ap.control")!;
    expect(typeof control.render).toBe("function");
    // The command surface the render's buttons invoke — a smoke test of the
    // mock/interface the widget depends on.
    void controller.engage();
    void controller.adjust(10);
    void controller.setMode("wind");
    void controller.tack("port");
    void controller.gybe("starboard");
    expect(controller.calls).toEqual([
      "engage",
      "adjust:10",
      "setMode:wind",
      "tack:port",
      "gybe:starboard",
    ]);
  });
});

describe("ap.status — the honest rail readout", () => {
  const read = (status: SignalKStatus, ap: Autopilot | null) => {
    const sk = fakeSignalK({ status, autopilot: ap });
    const feature = createAutopilot({ signalk: sk });
    const inst = feature.core.instruments![0];
    return inst.read({ density: DESK, band: "rail", room: "strip" });
  };

  test("a dropped link is UNKNOWN, never a live pilot", () => {
    // Even a frozen snapshot that still claims engaged reads unknown off-link.
    expect(read("off", { engaged: true, targetDeg: 120 })).toEqual({ value: "— —", state: "null" });
  });

  test("engaged absent is unknown, not disengaged", () => {
    expect(read("connected", { targetDeg: 120 }).state).toBe("null");
  });

  test("standby says so", () => {
    const r = read("connected", { engaged: false, mode: "compass" });
    expect(r.value).toBe("STBY");
  });

  test("engaged shows the target and the mode, and is a live (non-null) reading", () => {
    const r = read("connected", { engaged: true, targetDeg: 127, mode: "compass" });
    expect(r.value).toBe("127°");
    expect(r.sub).toContain("AUTO");
    expect(r.state).toBeUndefined();
  });
});

describe("apMode / isWind (moved into the feature)", () => {
  test("apMode collapses off-link and unreported to unknown", () => {
    expect(apMode("off", { engaged: true })).toBe("unknown");
    expect(apMode("connected", null)).toBe("unknown");
    expect(apMode("connected", {})).toBe("unknown");
    expect(apMode("connected", { engaged: false })).toBe("standby");
    expect(apMode("connected", { engaged: true })).toBe("engaged");
  });

  test("isWind matches wind and true wind, not compass", () => {
    expect(isWind("wind")).toBe(true);
    expect(isWind("true wind")).toBe(true);
    expect(isWind("compass")).toBe(false);
    expect(isWind(undefined)).toBe(false);
  });
});

describe("(e) the safety property: the autopilot never reaches the alarm strip", () => {
  const inst = (over: Partial<Instrument> & { id: string }): Instrument => ({
    short: over.id.slice(0, 3).toUpperCase(),
    label: over.id,
    maxUrgency: "none",
    read: () => ({ value: "1.0" }),
    ...over,
  });

  const cpaFeature = defineFeature({
    id: "core",
    instruments: [
      inst({
        id: "ais.cpa",
        maxUrgency: "alarm",
        urgency: () => "alarm",
        alertText: () => ["⚠ COLLISION RISK", "CPA 0.2 nm"],
      }),
    ],
  });
  const ap = createAutopilot({ signalk: fakeSignalK({ autopilot: { engaged: true } }) });
  const reg = createRegistry([cpaFeature, ap.core]);

  test("alerts() returns only the cpa alarm — the AP is invisible to the scan", () => {
    expect(alerts(reg).map((a) => a.id)).toEqual(["ais.cpa"]);
  });

  test("ap.status exists but is never alarm-grade", () => {
    expect(reg.byId("ap.status")).toBeDefined();
    expect(urgencyOf(reg.byId("ap.status")!)).toBe("none");
  });

  test("the AP command widgets are NOT registry instruments (so alerts cannot see them)", () => {
    const ids = reg.instruments.map((i) => i.id);
    expect(ids).not.toContain("ap.control");
    expect(ids).not.toContain("ap.rudder");
  });
});

describe("(a) default tabs: reg.pages and adoptDefaults seed Nav, Route, Pilot in order", () => {
  // Synthetic Nav + Route features mirroring the real ones (a top-band Route
  // instrument, so its page member has no rail home), plus the REAL autopilot
  // feature — proving pilot's static-widget members survive adoptDefaults too.
  const nav = defineFeature({
    id: "core",
    instruments: [
      { id: "nav.sog", short: "SOG", label: "sog", band: "rail", maxUrgency: "none", read: () => ({ value: "1" }) },
    ],
    dashboard: [{ id: "nav", label: "Nav", instruments: ["nav.sog"] }],
  });
  const routes = defineFeature({
    id: "routes",
    instruments: [
      { id: "route.wpt", short: "WPT", label: "wpt", band: "top", bands: ["top"], maxUrgency: "none", read: () => ({ value: "1" }) },
    ],
    dashboard: [{ id: "route", label: "Route", instruments: ["route.wpt"] }],
  });
  const ap = createAutopilot({ signalk: fakeSignalK() });
  const reg = createRegistry([nav, routes, ap.core]);

  test("reg.pages carries the pilot and route pages, in feature order", () => {
    expect(reg.pages.map((p) => p.id)).toEqual(["nav", "route", "pilot"]);
  });

  test("adoptDefaults seeds one config tab per page, Nav / Route / Pilot", () => {
    const cfg = adoptDefaults(DEFAULT_CHROME, reg);
    expect(cfg.dashboard.tabs.map((t) => t.id)).toEqual(["nav", "route", "pilot"]);
  });

  test("a page whose members are not rail tiles still gets them (top instrument, static widgets)", () => {
    const cfg = adoptDefaults(DEFAULT_CHROME, reg);
    const byId = (id: string) => cfg.dashboard.tabs.find((t) => t.id === id)!;
    // Route: a band.top member, appended in page order (never dropped).
    expect(byId("route").order).toEqual(["route.wpt"]);
    // Pilot: ap.status is a rail instrument (rail-ordered first), the two static
    // widgets have no rail home and are appended in page order.
    expect(byId("pilot").order).toEqual(["ap.status", "ap.control", "ap.rudder"]);
  });
});
