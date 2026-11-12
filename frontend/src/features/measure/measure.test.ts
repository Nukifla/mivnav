/**
 * Measure — the touch answer to the cursor readout (README #6).
 *
 * The whole tool, asserted with no DOM and no map: taps go in as lng/lat, the
 * model comes out, and `layers/measure.ts` is a rendering of the model. That is
 * the same split `info/state.ts` makes and for the same reason — there is no DOM
 * under `bun test`.
 *
 * NB: needs `--conditions=browser` (`bun run test`). Bare `bun test` resolves
 * solid-js's SSR build, where createEffect never runs and the memos here would
 * be asserted vacuously.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { SignalKState, Vessel } from "../../core/signalk";
import { createMeasure } from "./index";
import { measureCommands } from "./commands";
import { createModeState } from "../../core/chrome/modes";
import { createRegistry, DESK, HELM, type Feature } from "../../core/chrome/registry";
import type { ModeClick } from "../../core/chrome/modes";
import type { CommandDeps } from "../../core/chrome/commands";

const at = (lng: number, lat: number): ModeClick => ({
  point: { x: 0, y: 0 },
  lngLat: { lng, lat },
  radius: 8,
  pick: () => [],
});

const BOAT: Vessel = { lng: 12.6, lat: 55.9, sogMs: 3 };

function fakeSignalK(initial: Vessel | null = BOAT): {
  state: SignalKState;
  setSelf: (v: Vessel | null) => void;
} {
  const [self, setSelf] = createSignal<Vessel | null>(initial);
  return {
    state: { self, targets: () => [], status: () => "connected", autopilot: () => null },
    setSelf: (v) => setSelf(v),
  };
}

/** The tool as the app assembles it: a feature in a registry behind the seam. */
function harness(initial: Vessel | null = BOAT) {
  return createRoot((dispose) => {
    const sk = fakeSignalK(initial);
    const measure = createMeasure(sk.state);
    const modes = createModeState(createRegistry([measure.feature.core]));
    return { ...measure.model, feature: measure.feature.core, modes, sk, dispose };
  });
}

const modeOf = (feature: Feature) => feature.modes![0]!;

const boatToggle = (h: ReturnType<typeof harness>) =>
  modeOf(h.feature).pill!({ density: DESK }).actions!.find((a) => a.id === "boat")!;

const pillClear = (h: ReturnType<typeof harness>) =>
  modeOf(h.feature).pill!({ density: DESK }).actions!.find((a) => a.id === "clear")!;

/** Two-tap mode is now opt-OUT: the tool starts from the boat, so the plain
 * point→point path is one toggle away. Every "two taps" assertion runs after it. */
const offBoat = (h: ReturnType<typeof harness>) => boatToggle(h).run();

describe("the feature", () => {
  test("contributes exactly one mode, and no instruments", () => {
    createRoot((dispose) => {
      const { feature } = createMeasure(fakeSignalK().state);
      expect(feature.core.modes?.map((m) => m.id)).toEqual(["measure"]);
      // The readout is `cursor.*`'s job. Measure is a tool, not a tile — the
      // answer it gives is on the chart.
      expect(feature.core.instruments ?? []).toHaveLength(0);
      dispose();
    });
  });
});

describe("two taps", () => {
  test("first tap sets A and there is no leg yet", () => {
    const h = harness();
    h.modes.enter("measure");
    offBoat(h);
    expect(h.modes.handleClick(at(12.6, 55.9))).toBe(true);
    expect(h.a()).toEqual({ lng: 12.6, lat: 55.9 });
    expect(h.b()).toBeNull();
    // Nothing to measure between: a leg needs two ends, so the label has
    // nothing to say and does not say it.
    expect(h.leg()).toBeNull();
    h.dispose();
  });

  test("second tap completes the leg, with a bearing and a range", () => {
    const h = harness();
    h.modes.enter("measure");
    offBoat(h);
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0)); // due north, 6 nm
    const leg = h.leg()!;
    expect(leg.brgDeg).toBeCloseTo(0, 3);
    expect(leg.rangeNm).toBeCloseTo(6, 2);
    h.dispose();
  });

  /** Two taps in, two taps out: a finished measurement is finished. */
  test("a third tap starts a new measurement rather than dragging the old one", () => {
    const h = harness();
    h.modes.enter("measure");
    offBoat(h);
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    h.modes.handleClick(at(13.0, 55.5));
    expect(h.a()).toEqual({ lng: 13.0, lat: 55.5 });
    expect(h.b()).toBeNull();
    expect(h.leg()).toBeNull();
    h.dispose();
  });

  test("every tap is consumed: a mode whose purpose is pointing owns the click", () => {
    const h = harness();
    h.modes.enter("measure");
    for (const c of [at(12.6, 55.9), at(12.7, 55.9), at(12.8, 55.9)]) {
      expect(h.modes.handleClick(c)).toBe(true);
    }
    h.dispose();
  });
});

describe("the live rubber-band (README #6)", () => {
  /** (a) The default. Entering the mode measures from the boat with no tap: the
   * fastest "how far is that?" is zero taps, just aim. */
  test("from the boat by default — the anchor is the boat before any input", () => {
    const h = harness();
    h.modes.enter("measure");
    expect(h.fromBoat()).toBe(true);
    expect(h.a()).toEqual({ lng: 12.6, lat: 55.9 }); // the boat
    // Nothing aimed at yet, so no far end and no leg — the ring is the boat's.
    expect(h.b()).toBeNull();
    expect(h.leg()).toBeNull();
    h.dispose();
  });

  /** (b) The far end follows the pointer, and range/bearing recompute on every
   * move — no tap in between. This is the whole feature: a live instrument, not
   * a two-tap form. */
  test("the far end follows the pointer and the leg recomputes continuously", () => {
    const h = harness();
    h.modes.enter("measure");

    h.hover({ lng: 12.6, lat: 56.0 }); // due north, 6 nm from the boat
    expect(h.b()).toEqual({ lng: 12.6, lat: 56.0 });
    expect(h.leg()!.rangeNm).toBeCloseTo(6, 2);

    h.hover({ lng: 12.6, lat: 55.95 }); // pointer moves — half the range, live
    expect(h.b()).toEqual({ lng: 12.6, lat: 55.95 });
    expect(h.leg()!.rangeNm).toBeCloseTo(3, 2);

    // And it never needed a tap: the far end is the live pointer, not a placed
    // point, so Clear has nothing to clear.
    expect(boatToggle(h)).toBeDefined();
    expect(pillClear(h).disabled).toBe(true);
    h.dispose();
  });

  /** The guard: a pointer with no anchor draws nothing. Before the first tap in
   * two-tap mode there is no `a`, so a stray hover must not paint a lone ring
   * chasing the cursor over open water. */
  test("no anchor, no rubber-band: a hover before the first tap draws nothing", () => {
    const h = harness();
    h.modes.enter("measure");
    offBoat(h); // now a two-tap measurement — no anchor until the first tap
    expect(h.a()).toBeNull();
    h.hover({ lng: 12.6, lat: 56.0 });
    expect(h.b()).toBeNull();
    expect(h.leg()).toBeNull();
    h.dispose();
  });

  /** (c) A tap LOCKS the far end where the pointer is; moving the pointer then
   * leaves it put. That is the click-to-place path, reconciled with live-follow. */
  test("a tap locks the far end, and the pointer then moves without it", () => {
    const h = harness();
    h.modes.enter("measure");

    h.hover({ lng: 12.6, lat: 56.0 }); // aiming — the far end is live here
    expect(h.b()).toEqual({ lng: 12.6, lat: 56.0 });

    h.modes.handleClick(at(12.6, 56.0)); // lock it
    h.hover({ lng: 13.0, lat: 55.0 }); // pointer wanders off
    expect(h.b()).toEqual({ lng: 12.6, lat: 56.0 }); // stays locked
    expect(h.leg()!.rangeNm).toBeCloseTo(6, 2);
    // Now there IS something to clear.
    expect(pillClear(h).disabled).toBe(false);
    h.dispose();
  });

  /** Locking reads the POINTER, not the tap's own coordinate — the touch
   * crosshair marks the far end, and a tap means "lock the crosshair" wherever
   * the finger landed. `hovered` is the crosshair (the map centre) on a phone. */
  test("the lock is placed at the pointer, not at the tap coordinate", () => {
    const h = harness();
    h.modes.enter("measure");
    h.hover({ lng: 12.6, lat: 56.0 }); // the crosshair is here
    h.modes.handleClick(at(9.9, 50.0)); // finger landed elsewhere
    expect(h.b()).toEqual({ lng: 12.6, lat: 56.0 }); // locked at the crosshair
    h.dispose();
  });

  /** Clear un-locks: with the boat still the anchor, the far end goes straight
   * back to the live pointer rather than to a blank chart. */
  test("Clear sends the far end live again", () => {
    const h = harness();
    h.modes.enter("measure");
    h.hover({ lng: 12.6, lat: 56.0 });
    h.modes.handleClick(at(12.6, 56.0)); // lock
    h.hover({ lng: 13.0, lat: 55.0 }); // and the pointer moves on, ignored
    pillClear(h).run();
    expect(h.b()).toEqual({ lng: 13.0, lat: 55.0 }); // live again, at the pointer
    h.dispose();
  });
});

describe("from boat", () => {
  /** The reading tracks the live boat, so the range closes as you sail rather
   * than freezing at wherever the boat was when you started. */
  test("the anchor tracks the boat live, so the range closes as you sail", () => {
    const h = harness();
    h.modes.enter("measure");
    h.modes.handleClick(at(12.6, 56.0)); // lock a far end 6 nm north
    expect(h.leg()!.rangeNm).toBeCloseTo(6, 2);

    h.sk.setSelf({ ...BOAT, lat: 55.95 });
    expect(h.a()).toEqual({ lng: 12.6, lat: 55.95 });
    expect(h.leg()!.rangeNm).toBeCloseTo(3, 2);
    h.dispose();
  });

  test("with no fix there is no boat to measure from, and the toggle says so", () => {
    const h = harness(null);
    h.modes.enter("measure");
    expect(boatToggle(h).disabled).toBe(true);
    h.dispose();
  });

  test("turning it off clears the leg and hands the anchor to the taps", () => {
    const h = harness();
    h.modes.enter("measure");
    h.modes.handleClick(at(13.0, 55.0)); // locked far end from the boat
    expect(h.leg()).not.toBeNull();
    offBoat(h);
    expect(h.fromBoat()).toBe(false);
    // No anchor now until the first tap, and the locked end is gone.
    expect(h.a()).toBeNull();
    expect(h.b()).toBeNull();
    h.dispose();
  });
});

describe("seeded from a point", () => {
  /** The pressed-point "Measure" action: App enters the mode, then seeds `A`.
   * The seed IS the from-end, and the next tap is the to-end. */
  test("the seed becomes A, and the next tap yields the point→point leg", () => {
    const h = harness();
    h.modes.enter("measure");
    h.seed({ lng: 12.6, lat: 55.9 });
    expect(h.a()).toEqual({ lng: 12.6, lat: 55.9 });
    expect(h.b()).toBeNull();
    expect(h.leg()).toBeNull();

    // The next chart tap is B — the SAME tap-to-measure path, just pre-anchored.
    h.modes.handleClick(at(12.6, 56.0)); // due north, 6 nm
    const leg = h.leg()!;
    expect(leg.from).toEqual({ lng: 12.6, lat: 55.9 });
    expect(leg.brgDeg).toBeCloseTo(0, 3);
    expect(leg.rangeNm).toBeCloseTo(6, 2);
    h.dispose();
  });

  /** A seeded point is the from-end the user chose: measuring from the boat
   * would derive A from the boat and ignore the point they pressed. */
  test("seeding turns From boat OFF so the point is honoured", () => {
    const h = harness();
    h.modes.enter("measure");
    expect(h.fromBoat()).toBe(true); // on by default
    h.seed({ lng: 13.0, lat: 55.5 });
    expect(h.fromBoat()).toBe(false);
    expect(h.a()).toEqual({ lng: 13.0, lat: 55.5 });
    h.dispose();
  });

  /** Re-seeding (pressing Measure on a second point) starts a fresh measurement
   * rather than dragging the old one's end. */
  test("re-seeding drops any prior B", () => {
    const h = harness();
    h.modes.enter("measure");
    h.seed({ lng: 12.6, lat: 55.9 });
    h.modes.handleClick(at(12.6, 56.0));
    expect(h.leg()).not.toBeNull();
    h.seed({ lng: 10.0, lat: 50.0 });
    expect(h.a()).toEqual({ lng: 10.0, lat: 50.0 });
    expect(h.b()).toBeNull();
    expect(h.leg()).toBeNull();
    h.dispose();
  });

  /**
   * A seeded point is a FIXED anchor, exactly as *From boat* pins the boat end:
   * once a leg is measured, the next tap moves the OTHER end — it does not pick
   * the anchor up and drop it where you tapped. Regression: `seed` used to
   * behave like a plain first tap, so after a completed leg the next tap reset
   * `A`, silently abandoning the point the user pressed "Measure" on.
   */
  test("a seeded point stays pinned: after a leg, the next tap moves B, not A", () => {
    const h = harness();
    h.modes.enter("measure");
    h.seed({ lng: 12.6, lat: 55.9 });
    h.modes.handleClick(at(12.6, 56.0)); // first B — the leg is complete
    expect(h.leg()).not.toBeNull();

    // Tap again: only B follows the finger; the pinned A does not move.
    h.modes.handleClick(at(13.0, 55.5));
    expect(h.a()).toEqual({ lng: 12.6, lat: 55.9 }); // still the seeded point
    expect(h.b()).toEqual({ lng: 13.0, lat: 55.5 });
    expect(h.leg()!.from).toEqual({ lng: 12.6, lat: 55.9 });
    h.dispose();
  });

  /** Clearing a pinned measurement unpins it — Clear is the clean slate, and a
   * pin the user did not re-seed is not part of the next measurement. */
  test("Clear unpins the seeded anchor", () => {
    const h = harness();
    h.modes.enter("measure");
    h.seed({ lng: 12.6, lat: 55.9 });
    modeOf(h.feature).pill!({ density: DESK }).actions!.find((a) => a.id === "clear")!.run();
    expect(h.a()).toBeNull();
    h.modes.handleClick(at(13.0, 55.5)); // now a plain first tap, not a B
    expect(h.a()).toEqual({ lng: 13.0, lat: 55.5 });
    expect(h.b()).toBeNull();
    h.dispose();
  });
});

describe("the pill — only what the chart cannot say", () => {
  const pill = (h: ReturnType<typeof harness>) => modeOf(h.feature).pill!({ density: DESK });

  /**
   * §7 / README #5. The range and the bearing are ON the chart, at the line's
   * midpoint. A pill repeating them is the 258px panel in miniature — the
   * status line is for the one fact that has nowhere else to be.
   */
  test("the status is the time to run it, not the range or the bearing", () => {
    const h = harness();
    h.modes.enter("measure");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0)); // 6 nm at 3 m/s ≈ 5.83 kn ≈ 62 min → 1h 02
    const status = pill(h).status!;
    expect(status).toContain("at 5.8 kn");
    expect(status).toMatch(/^1h 02 at /);
    expect(status).not.toContain("nm");
    expect(status).not.toContain("°");
    h.dispose();
  });

  test("nothing measured, nothing to say", () => {
    const h = harness();
    h.modes.enter("measure");
    expect(pill(h).status).toBeUndefined();
    h.dispose();
  });

  /**
   * README #7 — a widget renders against the space it is given, and the WIDGET
   * decides what to drop. Found by rendering it: at helm the buttons grow to
   * clear 44px for a gloved hand, and on a 390px phone the shell was left
   * ellipsising `4h 12 at 6.2 kn` into `4h …`, which still reads as a number.
   */
  test("helm drops the speed rather than letting the shell truncate it", () => {
    const h = harness();
    h.modes.enter("measure");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    const status = modeOf(h.feature).pill!({ density: HELM }).status!;
    expect(status).toBe("1h 02");
    expect(status).not.toContain("kn");
    h.dispose();
  });

  /** At the dock the answer is not 999h; it is visibly absurd, which is honest. */
  test("a stopped boat does not print Infinity", () => {
    const h = harness({ lng: 12.6, lat: 55.9, sogMs: 0 });
    h.modes.enter("measure");
    h.modes.handleClick(at(12.6, 55.9));
    h.modes.handleClick(at(12.6, 56.0));
    expect(pill(h).status).toContain("at 0.0 kn");
    expect(pill(h).status).not.toContain("Infinity");
    expect(pill(h).status).not.toContain("NaN");
    h.dispose();
  });

  test("the pill is too poor to be a panel: a status and two buttons", () => {
    const h = harness();
    h.modes.enter("measure");
    expect(pill(h).actions!.map((a) => a.id)).toEqual(["boat", "clear"]);
    h.dispose();
  });

  test("Clear is dead until a far end is LOCKED", () => {
    const h = harness();
    h.modes.enter("measure");
    offBoat(h); // two-tap, so a tap places a stored end rather than the boat anchor
    const clear = () => pill(h).actions!.find((a) => a.id === "clear")!;
    expect(clear().disabled).toBe(true);
    h.modes.handleClick(at(12.6, 55.9));
    expect(clear().disabled).toBe(false);
    clear().run();
    expect(h.a()).toBeNull();
    expect(clear().disabled).toBe(true);
    h.dispose();
  });

  /** `a` is the boat with *From boat* on (the default), and a boat is not
   * something you cleared — nor is the LIVE far end, until a tap locks it. */
  test("Clear stays dead under From boat until a point is locked", () => {
    const h = harness();
    h.modes.enter("measure");
    expect(pill(h).actions!.find((a) => a.id === "clear")!.disabled).toBe(true);
    // Merely aiming does not arm Clear — the far end is live, not placed.
    h.hover({ lng: 12.6, lat: 56.0 });
    expect(pill(h).actions!.find((a) => a.id === "clear")!.disabled).toBe(true);
    h.modes.handleClick(at(12.6, 56.0)); // now locked
    expect(pill(h).actions!.find((a) => a.id === "clear")!.disabled).toBe(false);
    h.dispose();
  });
});

describe("the hint", () => {
  const hint = (h: ReturnType<typeof harness>) => modeOf(h.feature).hint!();

  test("two-tap, it says what to do next at every step", () => {
    const h = harness();
    h.modes.enter("measure");
    offBoat(h);
    expect(hint(h)).toBe("Tap the first point");
    h.modes.handleClick(at(12.6, 55.9));
    expect(hint(h)).toBe("Aim the second point · tap to lock");
    h.modes.handleClick(at(12.6, 56.0));
    expect(hint(h)).toBe("Tap again to start a new measurement");
    h.dispose();
  });

  test("from boat (the default), it is aim-and-lock and it says so", () => {
    const h = harness();
    h.modes.enter("measure");
    expect(hint(h)).toBe("Aim to measure from the boat · tap to lock");
    h.dispose();
  });

  test("from a pinned point, it says from here, then how to move on", () => {
    const h = harness();
    h.modes.enter("measure");
    h.seed({ lng: 12.6, lat: 55.9 });
    expect(hint(h)).toBe("Aim to measure from here · tap to lock");
    h.modes.handleClick(at(12.6, 56.0)); // lock a far end
    expect(hint(h)).toBe("Tap to measure elsewhere · Clear to go live");
    h.dispose();
  });
});

describe("leaving", () => {
  /** Nothing MEASURED survives a mode you left: a line from ten minutes ago
   * measures somewhere you no longer are. The from-boat anchor is not stored
   * state — it is the live boat — so it is not what "survives" means here; the
   * placed far end and the leg are, and they go. */
  test("drops the measurement", () => {
    const h = harness();
    h.modes.enter("measure");
    h.modes.handleClick(at(12.6, 56.0)); // lock a far end from the boat
    expect(h.leg()).not.toBeNull();
    h.modes.leave();
    expect(h.b()).toBeNull();
    expect(h.leg()).toBeNull();
    h.dispose();
  });

  test("and the chart answers questions again", () => {
    const h = harness();
    h.modes.enter("measure");
    h.modes.leave();
    expect(h.modes.handleClick(at(12.6, 55.9))).toBe(false);
    expect(h.b()).toBeNull();
    expect(h.leg()).toBeNull();
    h.dispose();
  });

  test("re-entering starts clean", () => {
    const h = harness();
    h.modes.enter("measure");
    h.modes.handleClick(at(12.6, 56.0));
    h.modes.leave();
    h.modes.enter("measure");
    expect(h.b()).toBeNull();
    expect(h.leg()).toBeNull();
    h.dispose();
  });
});

// The `M` launcher command belongs to this feature (`measureCommands`), fanned
// into the palette by the composition root via `featureCommands`. These
// assertions moved here from chrome/commands.test.ts so the chrome test — which
// is core — no longer imports a feature.
describe("the M launcher command", () => {
  /** A minimal CommandDeps: `measureCommands` only reads/writes the mode. */
  function launcherDeps() {
    let mode: string | null = null;
    const deps = {
      activeMode: () => mode,
      toggleMode: (id: string) => (mode = mode === id ? null : id),
    } as unknown as CommandDeps;
    return { deps, mode: () => mode };
  }

  function run(cmds: ReturnType<typeof measureCommands>, id: string) {
    const cmd = cmds.find((c) => c.id === id);
    if (!cmd) throw new Error(`no command ${id}`);
    cmd.run({ close: () => {}, prompt: () => {} });
  }

  test("mode-measure toggles the mode and labels itself by active state", () => {
    const h = launcherDeps();
    run(measureCommands(h.deps), "mode-measure");
    expect(h.mode()).toBe("measure");
    expect(measureCommands(h.deps).find((c) => c.id === "mode-measure")!.label).toBe(
      "Stop measuring",
    );
  });

  test("measure carries a first-class M keybinding (the accelerator source)", () => {
    const cmd = measureCommands(launcherDeps().deps).find((c) => c.id === "mode-measure")!;
    expect(cmd.keybinding).toEqual({ key: "m" });
  });
});
