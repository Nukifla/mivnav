import { describe, expect, test } from "bun:test";
import { createRoot, createSignal, type Accessor } from "solid-js";
import type {
  Collision,
  CollisionNotice,
  CollisionThreat,
  SignalKState,
  SignalKStatus,
  Vessel,
} from "../signalk";
import { createCoreFeature, createGpsStatus, type CoreDeps } from "./core";
import { DEFAULT_COLLISION_SETTINGS, type CollisionSettings } from "../collisionSettings";

/** The boat's collision settings with `patch` applied, as `CoreDeps.collision`. */
const boat = (patch: Partial<CollisionSettings>) => (): CollisionSettings => ({
  ...DEFAULT_COLLISION_SETTINGS,
  mode: "tell",
  ...patch,
});
/** The loud path most `ais.cpa` tests describe (the default is `show`). */
const TELL = boat({});
import { computeCpa, knotsFromMs, type RiskThresholds } from "../cpa";
import { formatCpaNm, formatSpeedKn, formatTcpa, padDeg } from "../format";
import { createRegistry, readInstrument, urgencyOf, alerts, type Instrument, type ReadCtx } from "./registry";
import { fitsRoom } from "./bands";

// `0`/`1` rather than importing registry.ts's `DESK`/`HELM` numeric constants
// under these same names — these are `ReadCtx` FIXTURES, not the scale
// endpoints themselves, and the two would collide.
const DESK: ReadCtx = { density: 0, band: "rail" };
const HELM: ReadCtx = { density: 1, band: "rail" };

const KN_TO_MS = 1 / 1.943844;

/** The server's alarm defaults (`mivnav.collision.config.CollisionConfig`). */
const SERVER_THRESHOLDS: RiskThresholds = { redCpaNm: 0.8, redTcpaMin: 15, yellowCpaNm: 1, yellowTcpaMin: 30 };
const RANK = { red: 3, yellow: 2, green: 1, unknown: 0 } as const;

/** A stand-in for the server's assessment (`mivnav.collision.assess`, which
 * has its own tests): the worst computable target, so these tests can keep
 * describing geometry. The tile itself never computes — see the
 * "reads the server's threat" test, which overrides this outright. */
function serverStandIn(self: Vessel | null, targets: readonly Vessel[]): Collision | null {
  if (!self) return null;
  const kn = (ms?: number) => (ms === undefined ? undefined : knotsFromMs(ms));
  let best: CollisionThreat | null = null;
  for (const t of targets) {
    const r = computeCpa(
      { lat: self.lat, lng: self.lng, cogDeg: self.cogDeg, sogKn: kn(self.sogMs) },
      { lat: t.lat, lng: t.lng, cogDeg: t.cogDeg, sogKn: kn(t.sogMs) },
      { thresholds: SERVER_THRESHOLDS },
    );
    if (r.kind !== "computed") continue;
    const threat: CollisionThreat = { id: t.name ?? "?", name: t.name, ...r };
    if (!best || RANK[threat.risk] > RANK[best.risk]) best = threat;
  }
  return best ? { threat: best } : null;
}

/** A SignalK stub. Signals, so the reactive paths are the real ones.
 * `collision` follows `serverStandIn` until `setCollision` overrides it. */
function fakeSignalK(initial?: { self?: Vessel | null; targets?: Vessel[] }) {
  const [self, setSelf] = createSignal<Vessel | null>(initial?.self ?? null);
  const [targets, setTargets] = createSignal<Vessel[]>(initial?.targets ?? []);
  const [status] = createSignal<SignalKStatus>("connected");
  const [override, setCollision] = createSignal<Collision | null | undefined>(undefined);
  const [collisionNotices, setNotices] = createSignal<Record<string, CollisionNotice>>({});
  const collision = (): Collision | null => {
    const o = override();
    return o !== undefined ? o : serverStandIn(self(), targets());
  };
  return {
    state: {
      self, targets, status, autopilot: () => null, collision, collisionNotices,
    } satisfies Partial<SignalKState> as SignalKState,
    setSelf,
    setTargets,
    setCollision,
    setNotices,
  };
}

const OWN: Vessel = { lat: 55.7, lng: 12.6, cogDeg: 45, sogMs: 6 * KN_TO_MS };
/** Own ship running due north — the geometry a head-on collision needs. */
const OWN_N: Vessel = { lat: 55.7, lng: 12.6, cogDeg: 0, sogMs: 6 * KN_TO_MS };

// `createCoreFeature` now returns an app-layer `AppFeature` (C-CURSOR/CORE); the
// pure kernel feature these tests read (`.instruments`, and what `createRegistry`
// consumes) is its `.core`, so unwrap it here once.
function core(deps: Partial<CoreDeps> & { signalk: SignalKState }) {
  return createCoreFeature({ now: () => 0, ...deps }).core;
}

const byId = (f: ReturnType<typeof core>, id: string): Instrument =>
  f.instruments!.find((i) => i.id === id)!;

// ── formatting: what read(ctx) sheds, and why ─────────────────────────────

describe("formatSpeedKn — the tenth goes above 10 kn at helm", () => {
  test("keeps the tenth under 10 kn: three glyphs fit and a tenth is a trim decision", () => {
    expect(formatSpeedKn(8.44, HELM)).toBe("8.4");
    expect(formatSpeedKn(8.44, DESK)).toBe("8.4");
  });

  test("sheds the tenth at helm from 10 kn up: '12.3' is four glyphs and does not fit", () => {
    expect(formatSpeedKn(12.34, HELM)).toBe("12");
    expect(formatSpeedKn(12.34, DESK)).toBe("12.3");
  });

  test("every helm speed is at most three glyphs — the rail's whole budget", () => {
    for (const kn of [0, 0.4, 5.55, 9.99, 10, 12.3, 47.6, 99.4]) {
      expect(formatSpeedKn(kn, HELM).length).toBeLessThanOrEqual(3);
    }
  });
});

describe("padDeg", () => {
  test("always three glyphs: nothing to shed, so density does not enter into it", () => {
    expect(padDeg(7)).toBe("007");
    expect(padDeg(47.4)).toBe("047");
    expect(padDeg(359.6)).toBe("000"); // 360 is not a course
    expect(padDeg(0)).toBe("000");
  });
});

describe("formatCpaNm", () => {
  test("sheds the hundredth at helm — 0.01 nm is 18 m, inside the AIS noise", () => {
    expect(formatCpaNm(0.18, DESK)).toBe("0.18");
    expect(formatCpaNm(0.18, HELM)).toBe("0.2");
  });

  test("both densities give up the decimal past 10 nm: nobody reads that precisely", () => {
    expect(formatCpaNm(12.4, DESK)).toBe("12");
    expect(formatCpaNm(12.4, HELM)).toBe("12");
  });

  test("every helm CPA is at most three glyphs", () => {
    for (const nm of [0, 0.18, 0.94, 1.62, 9.99, 12.4, 40]) {
      expect(formatCpaNm(nm, HELM).length).toBeLessThanOrEqual(3);
    }
  });
});

describe("formatTcpa", () => {
  test("M:SS", () => {
    expect(formatTcpa(4.2)).toBe("4:12");
    expect(formatTcpa(0)).toBe("0:00");
    expect(formatTcpa(11.5)).toBe("11:30");
  });

  test("rolls to hours rather than showing a four-digit minute count", () => {
    expect(formatTcpa(75)).toBe("1h15");
  });

  test("a negative TCPA is in the past, and says so rather than showing a minus", () => {
    expect(formatTcpa(-3)).toBe("past");
  });

  test("59.6s rounds into the next minute, not to ':60'", () => {
    expect(formatTcpa(4.999)).toBe("4:00");
  });
});

// ── the instruments ───────────────────────────────────────────────────────

describe("the core feature", () => {
  test("builds, and registers exactly the instruments that have a data source", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK();
      const reg = createRegistry([core({ signalk: state })]);
      expect(reg.instruments.map((i) => i.id)).toEqual(["nav.sog", "nav.cog", "nav.pos", "ais.cpa"]);
      dispose();
    }));

  /**
   * ⚠️ Load-bearing. Depth and wind are in the plan for this chunk and are
   * deliberately absent, because `environment.*` is not subscribed, not parsed,
   * not on the wire and not typed — see the header of `core.ts`. A depth tile is
   * a GUARD in a mariner's eyes; shipping one with nothing behind it buys that
   * belief with nothing. If a later chunk lands the backend, DELETE this test in
   * the same change that adds the instrument — do not "fix" it by faking data.
   */
  test("ships no instrument that has no data source: no depth, no wind, no autopilot", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK();
      const reg = createRegistry([core({ signalk: state })]);
      const ids = reg.instruments.map((i) => i.id);
      expect(ids).not.toContain("depth.belowKeel");
      expect(ids).not.toContain("wind.apparent");
      expect(ids).not.toContain("wind.true");
      expect(ids).not.toContain("autopilot");
      // nav.pos is NOT in this list any more: it has data AND, now, a surface
      // (the board). It ships board-only — see its own describe block below.
      dispose();
    }));

  test("no two tiles on the rail share a label — 'BRG' meaning two things is a misread", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK();
      const reg = createRegistry([core({ signalk: state })]);
      const shorts = reg.instruments.map((i) => i.short);
      expect(new Set(shorts).size).toBe(shorts.length);
      dispose();
    }));

  test("with no fix, every instrument reads null — and null is a state, not an error", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK();
      const f = core({ signalk: state });
      for (const inst of f.instruments!) {
        const r = inst.read(DESK);
        expect(r.state).toBe("null");
        expect(r.value).toBe("—");
      }
      dispose();
    }));

  test("nothing alarms on an empty sea", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK();
      const reg = createRegistry([core({ signalk: state })]);
      expect(alerts(reg)).toEqual([]);
      for (const i of reg.instruments) expect(urgencyOf(i)).toBe("none");
      dispose();
    }));
});

describe("nav.sog / nav.cog", () => {
  test("read live SignalK, in the units their names promise", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: { ...OWN, sogMs: 6.4 * KN_TO_MS, cogDeg: 47 } });
      const f = core({ signalk: state });
      expect(byId(f, "nav.sog").read(DESK)).toMatchObject({ value: "6.4", unit: "kn", sub: "COG 047°" });
      expect(byId(f, "nav.cog").read(DESK)).toMatchObject({ value: "047", unit: "°T" });
      dispose();
    }));

  test("cog sheds the heading sub-line at helm; sog keeps its cog sub-line", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: { ...OWN, cogDeg: 47, headingDeg: 48 } });
      const f = core({ signalk: state });
      expect(byId(f, "nav.cog").read(DESK).sub).toBe("HDG 048°");
      expect(byId(f, "nav.cog").read(HELM).sub).toBeUndefined();
      expect(byId(f, "nav.sog").read(HELM).sub).toBe("COG 047°");
      dispose();
    }));

  test("an absent heading is absent, not zero: the difference matters to a boat", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: { ...OWN, cogDeg: 47, headingDeg: undefined } });
      const f = core({ signalk: state });
      expect(byId(f, "nav.cog").read(DESK).sub).toBeUndefined();
      dispose();
    }));

  test("neither may ever alarm: the grant is `none`, so there is nothing to ask for", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: OWN });
      const f = core({ signalk: state });
      for (const id of ["nav.sog", "nav.cog"]) {
        expect(byId(f, id).maxUrgency).toBe("none");
        expect(urgencyOf(byId(f, id))).toBe("none");
      }
      dispose();
    }));
});

describe("nav.pos — position, board-only, finally has a surface", () => {
  test("reads own-ship lat/lng as chart DDM: latitude on the value line, longitude on the sub", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: { ...OWN, lat: 55.70575, lng: 12.6101 } });
      const f = core({ signalk: state });
      const r = byId(f, "nav.pos").read(DESK);
      // Three decimal minutes, hemisphere letter, longitude padded to three
      // degree digits — the chart convention (matches info/pointProvider.ts).
      expect(r.value).toBe("55°42.345′N");
      expect(r.sub).toBe("012°36.606′E");
      expect(r.unit).toBeUndefined();
      dispose();
    }));

  test("both hemispheres: a southern, western fix reads S and W", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: { ...OWN, lat: -33.9, lng: -18.4 } });
      const f = core({ signalk: state });
      const r = byId(f, "nav.pos").read(DESK);
      expect(r.value).toBe("33°54.000′S");
      expect(r.sub).toBe("018°24.000′W");
      dispose();
    }));

  test("no fix reads the em dash — a null STATE, not an error", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK();
      const f = core({ signalk: state });
      const r = byId(f, "nav.pos").read(DESK);
      expect(r.state).toBe("null");
      expect(r.value).toBe("—");
      dispose();
    }));

  test("board-only: it declares needsRoom `board`, so bandList drops it from the strip", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: OWN });
      const f = core({ signalk: state });
      const pos = byId(f, "nav.pos");
      expect(pos.needsRoom).toBe("board");
      // Every band it is allowed in must actually offer that room, or
      // `defineFeature` would have thrown at import — its home `rail` has it.
      expect(fitsRoom(pos, "board")).toBe(true);
      expect(fitsRoom(pos, "strip")).toBe(false);
      dispose();
    }));

  test("never alarm-grade, and struck through on a dead fix like every GPS reading", () =>
    createRoot((dispose) => {
      const [now, setNow] = createSignal(0);
      const { state } = fakeSignalK({ self: { ...OWN, positionAtIso: "2026-07-17T12:00:00Z" } });
      const f = core({ signalk: state, now });
      const pos = byId(f, "nav.pos");
      expect(pos.maxUrgency).toBe("none");
      expect(urgencyOf(pos)).toBe("none");
      expect(pos.staleAge!()).toBeNull();
      setNow(30_000); // the GPS goes quiet: the same fixAge that strikes SOG/COG through
      expect(pos.staleAge!()).toBeCloseTo(30, 1);
      dispose();
    }));
});

describe("ais.cpa", () => {
  /**
   * A real collision course, not a ship that merely happens to be near: OWN_N
   * runs due north at 6 kn, NORDIC EMERALD runs due south at 12 kn from 1.8 nm
   * dead ahead, offset just enough east that they miss by ~0.07 nm — close
   * enough to be red, far enough that the crossing aspect is still meaningful
   * (`cpa.ts` reports "unknown" below a 1e-9 nm CPA, where direction is dust).
   */
  const RED: Vessel = {
    name: "NORDIC EMERALD",
    lat: OWN_N.lat + 0.03,
    lng: OWN_N.lng + 0.002,
    cogDeg: 180,
    sogMs: 12 * KN_TO_MS,
  };

  test("reads the worst threat, and sheds the hundredth and the aspect at helm", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: OWN_N, targets: [RED] });
      const f = core({ signalk: state, collision: TELL });
      const desk = byId(f, "ais.cpa").read(DESK);
      const helm = byId(f, "ais.cpa").read(HELM);
      expect(desk.unit).toBe("nm");
      expect(desk.value).toMatch(/^\d\.\d\d$/);
      expect(helm.value).toMatch(/^\d\.\d$/);
      // desk carries "M:SS aspect"; helm carries "M:SS" alone.
      expect(desk.sub!.split(" ").length).toBe(2);
      expect(helm.sub!.split(" ").length).toBe(1);
      dispose();
    }));

  /**
   * Invariant #2 from the requesting side. The grant is `alarm` and the request
   * never exceeds it, so `urgencyOf` passes it through — that is what a
   * well-behaved feature looks like. The clamp's own test (a widget asking for
   * more than it is granted) is `registry.test.ts`'s.
   */
  test("is granted `alarm`, and asks for exactly what classifyRisk decided", () =>
    createRoot((dispose) => {
      const { state, setTargets } = fakeSignalK({ self: OWN_N, targets: [RED] });
      const f = core({ signalk: state, collision: TELL });
      const cpa = byId(f, "ais.cpa");
      expect(cpa.maxUrgency).toBe("alarm");
      expect(urgencyOf(cpa)).toBe("alarm");

      // The same collision, pushed out to a 0.9 nm miss: inside the yellow
      // 1.0 nm, outside the red 0.8 nm.
      setTargets([{ ...RED, lng: OWN_N.lng + 0.027 }]);
      expect(urgencyOf(cpa)).toBe("notice");

      setTargets([]);
      expect(urgencyOf(cpa)).toBe("none");
      expect(cpa.read(DESK).state).toBe("null");
      dispose();
    }));

  test("a red target fires the reserved alarm strip, and names the ship", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: OWN_N, targets: [RED] });
      const reg = createRegistry([core({ signalk: state, collision: TELL })]);
      const fired = alerts(reg);
      expect(fired).toHaveLength(1);
      expect(fired[0].id).toBe("ais.cpa");
      expect(fired[0].title).toContain("NORDIC EMERALD");
      expect(fired[0].detail).toMatch(/CPA \d\.\d\d nm · TCPA /);
      dispose();
    }));

  describe("the boat's mode gates the alarm, not the geometry", () => {
    // The same red collision at three loudness settings. Only the mode moves —
    // the geometry that makes it red is identical, which is the whole point: the
    // mariner is silencing the alarm, not pretending the ship is not there.
    test("tell fires the strip; show and off silence it", () =>
      createRoot((dispose) => {
        const { state } = fakeSignalK({ self: OWN_N, targets: [RED] });

        const tell = createRegistry([core({ signalk: state, collision: boat({ mode: "tell" }) })]);
        expect(alerts(tell)).toHaveLength(1);

        const show = createRegistry([core({ signalk: state, collision: boat({ mode: "show" }) })]);
        expect(alerts(show)).toHaveLength(0);

        const off = createRegistry([core({ signalk: state, collision: boat({ mode: "off" }) })]);
        expect(alerts(off)).toHaveLength(0);
        dispose();
      }));

    test("silenced, a red is a `notice`, not `none` — the tile stays elevated", () =>
      createRoot((dispose) => {
        const { state } = fakeSignalK({ self: OWN_N, targets: [RED] });
        for (const mode of ["show", "off"] as const) {
          const f = core({ signalk: state, collision: boat({ mode }) });
          expect(urgencyOf(byId(f, "ais.cpa"))).toBe("notice");
        }
        dispose();
      }));

    test("absent collision settings are the defaults: show — drawn, silent", () =>
      createRoot((dispose) => {
        const { state } = fakeSignalK({ self: OWN_N, targets: [RED] });
        const f = core({ signalk: state });
        expect(alerts(createRegistry([f]))).toHaveLength(0);
        expect(urgencyOf(byId(f, "ais.cpa"))).toBe("notice");
        dispose();
      }));
  });

  /**
   * The alarm is the SERVER's (`mivnav.collision`): one assessment on the boat,
   * raised on SignalK, the same on every screen, with boat-wide thresholds. The
   * tile must render that verdict and never second-guess it with geometry of
   * its own — two screens disagreeing about a collision is the failure mode.
   */
  test("reads the server's threat, not its own geometry", () =>
    createRoot((dispose) => {
      const { state, setCollision } = fakeSignalK({ self: OWN_N, targets: [RED] });
      const reg = createRegistry([core({ signalk: state, collision: TELL })]);
      const cpa = reg.byId("ais.cpa")!;
      expect(urgencyOf(cpa)).toBe("alarm");

      // The server says nothing alarms (its thresholds are tighter, say):
      // the red geometry on this screen does not override it.
      const quiet: CollisionThreat = {
        id: "x", name: "NORDIC EMERALD", risk: "yellow", cpaNm: 0.07, tcpaMin: 6,
        rangeNm: 1.8, aspect: "ahead", side: "port",
      };
      setCollision({ threat: quiet });
      expect(urgencyOf(cpa)).toBe("notice");
      expect(alerts(reg)).toHaveLength(0);

      // And no assessment at all (no own fix on the server) is no threat.
      setCollision(null);
      expect(urgencyOf(cpa)).toBe("none");
      expect(cpa.read(DESK).state).toBe("null");
      dispose();
    }));

  /**
   * The alarm is on SignalK too (our own notification, echoed back as
   * `collisionNotices`), and SignalK is what makes it LOUD and what makes an
   * ACK count everywhere — exactly the anchor alarm's contract.
   */
  describe("SignalK's copy of the alarm", () => {
    const raised = (over: Partial<CollisionNotice> = {}): CollisionNotice => ({
      state: "alarm", id: "n-1", sound: true, acknowledged: false, canAcknowledge: true, ...over,
    });

    test("with the boat's sound on, an unACKed red sounds — on SignalK or not", () =>
      createRoot((dispose) => {
        const { state, setNotices } = fakeSignalK({ self: OWN_N, targets: [RED] });
        const reg = createRegistry([core({ signalk: state, collision: TELL })]);
        // Nothing on SignalK (publish off, no write access): sounds anyway.
        expect(alerts(reg)[0].sound).toBe(true);
        setNotices({ "NORDIC EMERALD": raised() });
        expect(alerts(reg)[0].sound).toBe(true);
        dispose();
      }));

    test("with the boat's sound off, screens only show it — even when SignalK sounds", () =>
      createRoot((dispose) => {
        const { state, setNotices } = fakeSignalK({ self: OWN_N, targets: [RED] });
        const reg = createRegistry([core({ signalk: state, collision: boat({ sound: false }) })]);
        setNotices({ "NORDIC EMERALD": raised() });
        expect(alerts(reg)).toHaveLength(1);
        expect(alerts(reg)[0].sound).toBeUndefined();
        dispose();
      }));

    test("acknowledged ANYWHERE (the MFD, another screen) goes quiet here too", () =>
      createRoot((dispose) => {
        const { state, setNotices } = fakeSignalK({ self: OWN_N, targets: [RED] });
        const reg = createRegistry([core({ signalk: state, collision: TELL })]);
        setNotices({ "NORDIC EMERALD": raised({ acknowledged: true, sound: false }) });
        // Seen: still elevated on the tile, gone from the strip, silent.
        expect(urgencyOf(reg.byId("ais.cpa")!)).toBe("notice");
        expect(alerts(reg)).toHaveLength(0);
        dispose();
      }));

    test("the strip's ACK acknowledges every unACKed notification on the server", () =>
      createRoot((dispose) => {
        const sent: string[][] = [];
        const { state, setNotices } = fakeSignalK({ self: OWN_N, targets: [RED] });
        setNotices({
          "NORDIC EMERALD": raised(),
          other: raised({ id: "n-2" }),
          done: raised({ id: "n-3", acknowledged: true }),
          fixed: raised({ id: "n-4", canAcknowledge: false }),
        });
        const reg = createRegistry([
          core({ signalk: state, collision: TELL, ackCollision: async (ids) => (sent.push(ids), true) }),
        ]);
        alerts(reg)[0].ack!();
        expect(sent).toEqual([["n-1", "n-2"]]);
        dispose();
      }));

    test("the strip's MUTE silences every unsilenced notification on the server, for two minutes", () =>
      createRoot((dispose) => {
        const sent: string[][] = [];
        const { state, setNotices } = fakeSignalK({ self: OWN_N, targets: [RED] });
        setNotices({
          "NORDIC EMERALD": raised(),
          other: raised({ id: "n-2", silenced: true }),
          done: raised({ id: "n-3", acknowledged: true }),
          fixed: raised({ id: "n-4", canSilence: false }),
        });
        const reg = createRegistry([
          core({ signalk: state, collision: TELL, silenceCollision: async (ids) => (sent.push(ids), true) }),
        ]);
        const [alert] = alerts(reg);
        expect(alert.mute!.seconds).toBe(120);
        alert.mute!.run();
        expect(sent).toEqual([["n-1"]]);
        dispose();
      }));

    test("silenced ANYWHERE stays on the strip, quiet", () =>
      createRoot((dispose) => {
        const { state, setNotices } = fakeSignalK({ self: OWN_N, targets: [RED] });
        const reg = createRegistry([core({ signalk: state, collision: TELL })]);
        setNotices({ "NORDIC EMERALD": raised({ silenced: true, sound: false }) });
        expect(urgencyOf(reg.byId("ais.cpa")!)).toBe("alarm");
        const [alert] = alerts(reg);
        expect(alert.silenced).toBe(true);
        expect(alert.sound).toBeUndefined();
        dispose();
      }));
  });

  test("an unnamed target still alarms — a ship that did not say its name is still a ship", () =>
    createRoot((dispose) => {
      const { state } = fakeSignalK({ self: OWN_N, targets: [{ ...RED, name: undefined }] });
      const reg = createRegistry([core({ signalk: state, collision: TELL })]);
      expect(alerts(reg)[0].title).toContain("unnamed target");
      dispose();
    }));

  /**
   * ⚠️ A dead GPS must not produce a confident collision alarm.
   *
   * A CPA is computed from BOTH vessels, and our half comes off the same fix as
   * SOG and COG. When that fix dies the targets keep reporting, so the number
   * stays plausible while going quietly wrong — a red alarm computed from a
   * track the boat stopped following a minute ago. This is invariant #6 at its
   * sharpest: the alarm-grade instrument is the one that most needs disarming
   * when its inputs die.
   */
  test("cannot alarm on a dead GPS, however red the geometry was", () =>
    createRoot((dispose) => {
      const [now, setNow] = createSignal(0);
      const { state } = fakeSignalK({
        self: { ...OWN_N, positionAtIso: "2026-07-17T12:00:00Z" },
        targets: [RED],
      });
      const reg = createRegistry([core({ signalk: state, collision: TELL, now })]);
      const cpa = reg.byId("ais.cpa")!;

      // Live fix: a real red alarm, firing the reserved strip.
      expect(urgencyOf(cpa)).toBe("alarm");
      expect(alerts(reg)).toHaveLength(1);

      // The fix dies. The target is still there, still closing, still red by
      // geometry — but the geometry is now built on a position we do not have.
      setNow(40_000);
      expect(urgencyOf(cpa)).toBe("none");
      expect(alerts(reg)).toEqual([]);

      const view = readInstrument(cpa, DESK);
      expect(view.stale).toBe(true);
      expect(view.staleSeconds).toBeCloseTo(40, 1);
      dispose();
    }));
});

// ── invariant #6: stale data looks stale, and cannot alarm ────────────────

describe("staleness — a dead sensor is silent, not screaming", () => {
  /** Drives the clock and the fix timestamp the way a real GPS would. */
  function withClock() {
    const [now, setNow] = createSignal(0);
    const { state, setSelf } = fakeSignalK({ self: { ...OWN, positionAtIso: "2026-07-17T12:00:00Z" } });
    const f = core({ signalk: state, now });
    return { f, now, setNow, setSelf };
  }

  test("a fresh fix is not stale", () =>
    createRoot((dispose) => {
      const { f, setNow } = withClock();
      setNow(5_000);
      expect(byId(f, "nav.sog").staleAge!()).toBeNull();
      dispose();
    }));

  test("a GPS that stops reporting goes stale, with a real age", () =>
    createRoot((dispose) => {
      const { f, setNow } = withClock();
      setNow(30_000);
      // Every GPS-derived instrument: SOG and COG come off the same fix.
      expect(byId(f, "nav.sog").staleAge!()).toBeCloseTo(30, 1);
      expect(byId(f, "nav.cog").staleAge!()).toBeCloseTo(30, 1);
      dispose();
    }));

  test("a new fix clears the staleness", () =>
    createRoot((dispose) => {
      const { f, setNow, setSelf } = withClock();
      setNow(30_000);
      expect(byId(f, "nav.sog").staleAge!()).not.toBeNull();
      setSelf({ ...OWN, positionAtIso: "2026-07-17T12:00:30Z" });
      expect(byId(f, "nav.sog").staleAge!()).toBeNull();
      dispose();
    }));

  /**
   * Measured by the CLIENT'S clock against itself, never against the GPS's. A
   * tablet whose clock is an hour off must not strike a live fix through — and
   * per invariant #6 a stale instrument cannot alarm, so a wrong clock striking
   * everything through would silently DISARM the guards.
   */
  test("a browser clock that disagrees with the GPS by an hour changes nothing", () =>
    createRoot((dispose) => {
      const [now, setNow] = createSignal(Date.now() + 3_600_000);
      const { state } = fakeSignalK({ self: { ...OWN, positionAtIso: new Date().toISOString() } });
      const f = core({ signalk: state, now });
      expect(byId(f, "nav.sog").staleAge!()).toBeNull();
      setNow((n) => n + 30_000);
      expect(byId(f, "nav.sog").staleAge!()).toBeCloseTo(30, 1);
      dispose();
    }));

  /**
   * A boat at anchor has a genuinely constant position. Calling a working sensor
   * dead because its reading is steady is the same bug as calling a dead one
   * live — which is why the change detector is the fix's own TIMESTAMP and not
   * its value.
   */
  test("a boat at anchor is not a dead GPS", () =>
    createRoot((dispose) => {
      const [now, setNow] = createSignal(0);
      const anchored: Vessel = { ...OWN, sogMs: 0, positionAtIso: "2026-07-17T12:00:00Z" };
      const { state, setSelf } = fakeSignalK({ self: anchored });
      const f = core({ signalk: state, now });
      for (let t = 1; t <= 10; t++) {
        setNow(t * 5_000);
        // Same position, new fix timestamp: exactly what a GPS at anchor sends.
        setSelf({ ...anchored, positionAtIso: `2026-07-17T12:00:${String(t * 5).padStart(2, "0")}Z` });
        expect(byId(f, "nav.sog").staleAge!()).toBeNull();
      }
      dispose();
    }));

  /**
   * Plenty of SignalK installs never emit `navigation.datetime`. "We cannot
   * tell" must read as null — not as a claim of freshness dressed up as one,
   * and not as a permanent strike-through either.
   */
  test("a boat with no fix timestamp is never stale: we cannot tell, and say so", () =>
    createRoot((dispose) => {
      const [now, setNow] = createSignal(0);
      const { state } = fakeSignalK({ self: { ...OWN, positionAtIso: undefined } });
      const f = core({ signalk: state, now });
      setNow(10_000_000);
      expect(byId(f, "nav.sog").staleAge!()).toBeNull();
      dispose();
    }));

  test("the kernel forces a stale instrument to `none`, whatever it asked for", () =>
    createRoot((dispose) => {
      const { f, setNow } = withClock();
      setNow(60_000);
      for (const id of ["nav.sog", "nav.cog"]) {
        const view = readInstrument(byId(f, id), DESK);
        expect(view.stale).toBe(true);
        expect(view.urgency).toBe("none");
        expect(view.staleSeconds).toBeCloseTo(60, 1);
      }
      dispose();
    }));
});

// ── the GPS dot: a fix and the SignalK LINK fail independently ─────────────
//
// The one rule the mockup's single dot could not express and this signal exists
// for: never render "cannot tell" as good. A live link with a dead GPS must read
// red, and a frozen snapshot behind a dropped link must not read green.

describe("createGpsStatus", () => {
  /** A stub whose status AND self are both settable, unlike `fakeSignalK`. */
  function gpsStub(init: { self?: Vessel | null; status?: SignalKStatus }) {
    const [self, setSelf] = createSignal<Vessel | null>(init.self ?? null);
    const [status, setStatus] = createSignal<SignalKStatus>(init.status ?? "connected");
    const [targets] = createSignal<Vessel[]>([]);
    return { state: { self, targets, status, autopilot: () => null } satisfies SignalKState, setSelf, setStatus };
  }
  const FIXED: Vessel = { ...OWN, positionAtIso: "2026-07-17T12:00:00Z" };

  test("a current fix behind a live link is green", () =>
    createRoot((dispose) => {
      const { state } = gpsStub({ self: FIXED });
      expect(createGpsStatus({ signalk: state, now: () => 0 })()).toBe("fix");
      dispose();
    }));

  test("the link dropping is 'cannot tell', never green — even with a good fix", () =>
    createRoot((dispose) => {
      const { state, setStatus } = gpsStub({ self: FIXED });
      const gps = createGpsStatus({ signalk: state, now: () => 0 });
      expect(gps()).toBe("fix");
      setStatus("connecting");
      expect(gps()).toBe("unknown");
      dispose();
    }));

  test("connected but no position yet is 'acquiring', not green", () =>
    createRoot((dispose) => {
      const { state } = gpsStub({ self: null });
      expect(createGpsStatus({ signalk: state, now: () => 0 })()).toBe("acquiring");
      dispose();
    }));

  test("a position with no fix timestamp is 'unknown' — its age is unknowable", () =>
    createRoot((dispose) => {
      const { state } = gpsStub({ self: { ...OWN, positionAtIso: undefined } });
      expect(createGpsStatus({ signalk: state, now: () => 0 })()).toBe("unknown");
      dispose();
    }));

  test("a fix that aged out is 'stale' — a dead GPS behind a live link", () =>
    createRoot((dispose) => {
      const [now, setNow] = createSignal(0);
      const { state } = gpsStub({ self: FIXED });
      const gps = createGpsStatus({ signalk: state, now });
      expect(gps()).toBe("fix");
      setNow(11_000);
      expect(gps()).toBe("stale");
      dispose();
    }));
});
