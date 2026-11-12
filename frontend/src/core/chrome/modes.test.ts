/**
 * The chart-mode seam (invariant #9): a click means "what is here?" until a mode
 * says otherwise.
 *
 * Every assertion here runs with no DOM and no map, which is the point: there is
 * no DOM under `bun test`, so behaviour that lives in a component is behaviour
 * that is not tested. The seam is therefore a pure state machine handed plain
 * numbers, and `ModePill.tsx` is a rendering of it and nothing else.
 *
 * NB: needs `--conditions=browser` (`bun run test`). Bare `bun test` resolves
 * solid-js's SSR build, where createEffect never runs.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createModeState, tapRadius, type ModeClick } from "./modes";
import { createRegistry, defineFeature, type Mode } from "./registry";

const CLICK: ModeClick = {
  point: { x: 10, y: 20 },
  lngLat: { lng: 12.6, lat: 55.9 },
  radius: 8,
  pick: () => [],
};

/** A mode that records everything the kernel does to it. */
function spy(id: string, over: Partial<Mode> = {}) {
  const log: string[] = [];
  const clicks: ModeClick[] = [];
  const mode: Mode = {
    id,
    label: id,
    enter: () => log.push("enter"),
    leave: () => log.push("leave"),
    onClick: (c) => {
      clicks.push(c);
      return true;
    },
    ...over,
  };
  return { mode, log, clicks };
}

const regOf = (...modes: Mode[]) => createRegistry([defineFeature({ id: "f", modes })]);

/** createModeState uses createMemo, so it needs an owner. */
const run = <T,>(fn: () => T): T => createRoot((dispose) => {
  const out = fn();
  dispose();
  return out;
});

describe("the seam", () => {
  test("no mode: a click is not consumed, so the caller probes", () => {
    run(() => {
      const s = createModeState(regOf(spy("measure").mode));
      expect(s.active()).toBeNull();
      expect(s.handleClick(CLICK)).toBe(false);
    });
  });

  test("a mode consumes the click, and gets it verbatim", () => {
    run(() => {
      const m = spy("measure");
      const s = createModeState(regOf(m.mode));
      s.enter("measure");
      expect(s.handleClick(CLICK)).toBe(true);
      expect(m.clicks).toEqual([CLICK]);
    });
  });

  /**
   * The half that is easy to get wrong: consuming is a CHOICE, not a
   * consequence of being in a mode. Being in a mode must not have to mean the
   * chart stops answering questions.
   */
  test("a mode that declines lets the click through to the probe", () => {
    run(() => {
      const s = createModeState(regOf(spy("passive", { onClick: () => false }).mode));
      s.enter("passive");
      expect(s.handleClick(CLICK)).toBe(false);
    });
  });

  test("a mode with no onClick at all declines", () => {
    run(() => {
      const s = createModeState(regOf(spy("inert", { onClick: undefined }).mode));
      s.enter("inert");
      expect(s.handleClick(CLICK)).toBe(false);
    });
  });

  test("void from onClick is not truthy: only `true` consumes", () => {
    run(() => {
      const s = createModeState(regOf(spy("sloppy", { onClick: () => undefined }).mode));
      s.enter("sloppy");
      expect(s.handleClick(CLICK)).toBe(false);
    });
  });

  test("leaving hands the chart back", () => {
    run(() => {
      const s = createModeState(regOf(spy("measure").mode));
      s.enter("measure");
      s.leave();
      expect(s.handleClick(CLICK)).toBe(false);
    });
  });
});

describe("the lifecycle", () => {
  test("enter and leave reach the mode", () => {
    run(() => {
      const m = spy("measure");
      const s = createModeState(regOf(m.mode));
      s.enter("measure");
      expect(s.active()).toBe("measure");
      expect(s.current()).toBe(m.mode);
      s.leave();
      expect(s.active()).toBeNull();
      expect(s.current()).toBeNull();
      expect(m.log).toEqual(["enter", "leave"]);
    });
  });

  test("entering the mode already active does nothing at all", () => {
    run(() => {
      const m = spy("measure");
      const s = createModeState(regOf(m.mode));
      s.enter("measure");
      s.enter("measure");
      // Not enter/leave/enter: re-entering would silently reset the state of a
      // measurement you are halfway through taking.
      expect(m.log).toEqual(["enter"]);
    });
  });

  test("exactly one mode at a time, and switching is leave-then-enter", () => {
    run(() => {
      const a = spy("a");
      const b = spy("b");
      const s = createModeState(regOf(a.mode, b.mode));
      s.enter("a");
      s.enter("b");
      expect(s.active()).toBe("b");
      expect(a.log).toEqual(["enter", "leave"]);
      expect(b.log).toEqual(["enter"]);
      // a is gone: its click handler must not still be in the way
      s.handleClick(CLICK);
      expect(a.clicks).toHaveLength(0);
      expect(b.clicks).toHaveLength(1);
    });
  });

  test("`leave` runs while the mode is still current, so it knows who it is", () => {
    run(() => {
      let sawActive: string | null = "not-run";
      const s = createModeState(
        regOf({
          id: "m",
          label: "m",
          leave: () => {
            sawActive = s.active();
          },
        }),
      );
      s.enter("m");
      s.leave();
      expect(sawActive).toBe("m");
    });
  });

  test("toggle is what the launcher entry needs: on, then off", () => {
    run(() => {
      const m = spy("measure");
      const s = createModeState(regOf(m.mode));
      s.toggle("measure");
      expect(s.active()).toBe("measure");
      s.toggle("measure");
      expect(s.active()).toBeNull();
      expect(m.log).toEqual(["enter", "leave"]);
    });
  });

  test("toggling a different mode switches rather than closing", () => {
    run(() => {
      const s = createModeState(regOf(spy("a").mode, spy("b").mode));
      s.toggle("a");
      s.toggle("b");
      expect(s.active()).toBe("b");
    });
  });

  /**
   * A stale localStorage or a build without the feature. `bands.configurable`
   * already skips an unknown instrument id harmlessly; an unknown mode id gets
   * the same treatment, and for the same reason — a config outliving a feature
   * is normal, not an error.
   */
  test("an unknown mode id is a no-op, not a throw", () => {
    run(() => {
      const s = createModeState(regOf(spy("measure").mode));
      s.enter("nope");
      expect(s.active()).toBeNull();
      s.toggle("nope");
      expect(s.active()).toBeNull();
    });
  });

  test("leaving when nothing is active is a no-op", () => {
    run(() => {
      const s = createModeState(regOf(spy("measure").mode));
      s.leave();
      expect(s.active()).toBeNull();
    });
  });

  test("a mode with no enter/leave is fine", () => {
    run(() => {
      const s = createModeState(regOf({ id: "bare", label: "Bare" }));
      s.enter("bare");
      expect(s.active()).toBe("bare");
      s.leave();
      expect(s.active()).toBeNull();
    });
  });
});

/**
 * The surviving *intent* of the mockup's dead `getScreenCTM()` hit-testing: the
 * tap target is sized in screen pixels and grows for a gloved hand. POINTER,
 * not a media query and — since #DENS-SLIDER — not the size slider either: a
 * helm tablet is wide and coarse (invariant #10), and `tapRadius` now takes
 * `pointerCoarse` directly rather than `density`.
 */
describe("tapRadius", () => {
  test("a fine pointer keeps info/attach.tsx's long-standing 8px", () => {
    expect(tapRadius(false)).toBe(8);
  });

  test("a coarse pointer is bigger — that is the whole rule", () => {
    expect(tapRadius(true)).toBeGreaterThan(tapRadius(false));
  });
});
