/**
 * The GNSS-lost and connection alarms: which loss alarms when (`activeLoss`),
 * the stream's liveness probe that feeds the server-unreachable one, and the
 * feature's instruments reaching the alarm strip.
 *
 * Sockets and clocks are injected — no mock.module (it leaks across files).
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { activeLoss, createLinkAlarmsFeature, type LinkInputs } from "./linkAlarms";
import { createSignalK, PING_DEAD_MS, PING_INTERVAL_MS, type SignalKState } from "./signalk";
import { DEFAULT_GNSS_SETTINGS } from "./gnssSettings";
import { alerts, createRegistry, urgencyOf } from "./chrome/registry";

const base: LinkInputs = {
  now: 100_000,
  serverDownSince: null,
  status: "connected",
  signalkDownSince: null,
  fixLost: false,
  settings: DEFAULT_GNSS_SETTINGS,
};

describe("activeLoss", () => {
  test("nothing lost, nothing alarms", () => {
    expect(activeLoss(base)).toBeNull();
  });

  test("GNSS lost is the server's call, already debounced", () => {
    expect(activeLoss({ ...base, fixLost: true })).toBe("gnss");
  });

  test("the server link alarms only after the delay", () => {
    expect(activeLoss({ ...base, serverDownSince: base.now - 4_999 })).toBeNull();
    expect(activeLoss({ ...base, serverDownSince: base.now - 5_000 })).toBe("server");
  });

  test("with the server gone, SignalK and the fix are unknown, not lost", () => {
    const i = { ...base, serverDownSince: base.now - 1_000, status: "connecting" as const, fixLost: true };
    expect(activeLoss(i)).toBeNull();
  });

  test("SignalK lost alarms after the delay; the fix is then not its own alarm", () => {
    const i = { ...base, status: "connecting" as const, fixLost: true };
    expect(activeLoss({ ...i, signalkDownSince: base.now - 4_000 })).toBeNull();
    expect(activeLoss({ ...i, signalkDownSince: base.now - 5_000 })).toBe("signalk");
  });

  test("SignalK switched off is not a loss", () => {
    expect(activeLoss({ ...base, status: "off", signalkDownSince: 0 })).toBeNull();
  });

  test("the delay is the boat's setting", () => {
    const settings = { ...DEFAULT_GNSS_SETTINGS, delay_s: 20 };
    expect(activeLoss({ ...base, settings, serverDownSince: base.now - 10_000 })).toBeNull();
    expect(activeLoss({ ...base, settings, serverDownSince: base.now - 20_000 })).toBe("server");
  });

  test("off raises nothing; connection off keeps only the GNSS alarm", () => {
    const off = { ...DEFAULT_GNSS_SETTINGS, mode: "off" as const };
    expect(activeLoss({ ...base, settings: off, fixLost: true })).toBeNull();
    const noLinks = { ...DEFAULT_GNSS_SETTINGS, connection: false };
    expect(activeLoss({ ...base, settings: noLinks, serverDownSince: 0 })).toBeNull();
    expect(activeLoss({ ...base, settings: noLinks, fixLost: true })).toBe("gnss");
  });
});

// -- the liveness probe -------------------------------------------------------

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  reply(data: string) {
    this.onmessage?.({ data });
  }
}

function probed() {
  let t = 1_000_000;
  let tick: () => void = () => {};
  const sockets: FakeSocket[] = [];
  let state!: SignalKState;
  const dispose = createRoot((dispose) => {
    state = createSignalK({
      url: "ws://boat/api/signalk/stream",
      open: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      now: () => t,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {},
    });
    return dispose;
  });
  const advance = (ms: number) => {
    t += ms;
    tick();
  };
  return { state, sockets, advance, now: () => t, dispose };
}

describe("the server liveness probe", () => {
  test("down until the socket opens, up once it does", () => {
    const { state, sockets, dispose } = probed();
    expect(state.linkDownSince()).not.toBeNull();
    sockets[0].open();
    expect(state.linkDownSince()).toBeNull();
    dispose();
  });

  test("pings an idle server and stays up while it answers", () => {
    const { state, sockets, advance, dispose } = probed();
    sockets[0].open();
    advance(PING_INTERVAL_MS);
    expect(sockets[0].sent).toEqual(["ping"]);
    sockets[0].reply("pong");
    advance(PING_INTERVAL_MS);
    expect(sockets[0].sent).toEqual(["ping", "ping"]);
    expect(state.linkDownSince()).toBeNull();
    // A pong is not a snapshot: it changes no boat state.
    expect(state.status()).toBe("connecting");
    dispose();
  });

  test("an unanswered ping is a down link from when it was sent, then a re-dial", () => {
    const { state, sockets, advance, now, dispose } = probed();
    sockets[0].open();
    advance(PING_INTERVAL_MS);
    const sentAt = now();
    advance(PING_INTERVAL_MS);
    expect(state.linkDownSince()).toBe(sentAt);
    while (now() - sentAt < PING_DEAD_MS) advance(PING_INTERVAL_MS);
    expect(sockets[0].closed).toBe(true);
    expect(sockets.length).toBe(2);
    expect(state.linkDownSince()).toBe(sentAt); // still down until it answers
    sockets[1].open();
    expect(state.linkDownSince()).toBeNull();
    dispose();
  });

  test("a closed socket is down from the close", () => {
    const { state, sockets, now, dispose } = probed();
    sockets[0].open();
    sockets[0].onclose?.();
    expect(state.linkDownSince()).toBe(now());
    dispose();
  });

  test("a tab waking from a stall does not read the stall as a dead server", () => {
    const { state, sockets, advance, dispose } = probed();
    sockets[0].open();
    advance(PING_INTERVAL_MS); // ping out, then the tab freezes
    advance(10 * 60_000);
    expect(state.linkDownSince()).toBeNull();
    expect(sockets[0].closed).toBe(false);
    dispose();
  });

  test("the snapshot's GNSS keys reach the state", () => {
    const { state, sockets, dispose } = probed();
    sockets[0].open();
    sockets[0].reply(
      JSON.stringify({
        status: "connected",
        self: null,
        targets: [],
        fixLost: true,
        fixAge: 10,
        gnssSettings: { ...DEFAULT_GNSS_SETTINGS, delay_s: 8 },
      }),
    );
    expect(state.fixLost()).toBe(true);
    expect(state.fixAge()).toBe(10);
    expect(state.gnssSettings().delay_s).toBe(8);
    sockets[0].reply(JSON.stringify({ status: "connected", self: null, targets: [] }));
    expect(state.fixLost()).toBe(false);
    expect(state.gnssSettings().delay_s).toBe(8); // kept, not defaulted
    dispose();
  });
});

// -- the feature ----------------------------------------------------------------

describe("createLinkAlarmsFeature", () => {
  function fake() {
    const [status, setStatus] = createSignal<"off" | "connecting" | "connected">("connected");
    const [down, setDown] = createSignal<number | null>(null);
    const [fixLost, setFixLost] = createSignal(false);
    const [settings, setSettings] = createSignal(DEFAULT_GNSS_SETTINGS);
    const [now, setNow] = createSignal(1_000_000);
    const signalk = {
      status,
      linkDownSince: down,
      fixLost,
      fixAge: () => null,
      gnssSettings: settings,
    } as unknown as SignalKState;
    return { signalk, setStatus, setDown, setFixLost, setSettings, now, setNow };
  }

  test("GNSS lost raises the strip with sound in tell, a quiet tile in show", () => {
    createRoot((dispose) => {
      const f = fake();
      const reg = createRegistry([createLinkAlarmsFeature({ signalk: f.signalk, now: f.now }).core]);
      expect(alerts(reg)).toEqual([]);
      f.setFixLost(true);
      const [a] = alerts(reg);
      expect(a.id).toBe("link.gnss");
      expect(a.title).toContain("GNSS POSITION LOST");
      expect(a.sound).toBe(true);
      f.setSettings({ ...DEFAULT_GNSS_SETTINGS, mode: "show" });
      expect(alerts(reg)).toEqual([]);
      expect(urgencyOf(reg.byId("link.gnss")!)).toBe("notice");
      expect(reg.byId("link.gnss")!.when!()).toBe(true);
      f.setFixLost(false);
      expect(reg.byId("link.gnss")!.when!()).toBe(false);
      dispose();
    });
  });

  test("SignalK lost is counted from when this screen saw it go", () => {
    createRoot((dispose) => {
      const f = fake();
      const reg = createRegistry([createLinkAlarmsFeature({ signalk: f.signalk, now: f.now }).core]);
      f.setStatus("connecting");
      f.setNow(f.now() + 4_000);
      expect(alerts(reg)).toEqual([]);
      f.setNow(f.now() + 1_000);
      expect(alerts(reg).map((a) => a.id)).toEqual(["link.signalk"]);
      f.setStatus("connected");
      expect(alerts(reg)).toEqual([]);
      dispose();
    });
  });

  test("server unreachable says it cannot reach SignalK", () => {
    createRoot((dispose) => {
      const f = fake();
      const reg = createRegistry([createLinkAlarmsFeature({ signalk: f.signalk, now: f.now }).core]);
      f.setDown(f.now());
      f.setStatus("connecting");
      f.setNow(f.now() + 6_000);
      const [a] = alerts(reg);
      expect(a.id).toBe("link.server");
      expect(a.detail).toContain("6 s");
      expect(a.detail).toContain("cannot reach SignalK");
      dispose();
    });
  });
});
