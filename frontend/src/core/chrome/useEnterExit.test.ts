/**
 * The extracted enter/exit stage machine (D5). The double-rAF and the real
 * `transitionend` are DOM behaviour driven in a browser, but the state
 * transitions and the fallback timer are reachable here by injecting `raf` and
 * `reduced`: a manual rAF queue lets a test step the enter frame-by-frame, and a
 * small `fallbackMs` with a real `await` proves the safety-net unmount fires when
 * `transitionend` never arrives.
 *
 * `open` is a signal read inside `createEnterExit`'s `createEffect`, and Solid
 * runs user effects DEFERRED (not synchronously on the setter), so `setOpen`
 * here awaits a tick to let the bridge effect run before we assert.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createEnterExit, type EnterExit } from "./useEnterExit";

/** A manual requestAnimationFrame: callbacks queue, `flush(n)` runs n frames. */
function fakeRaf() {
  let q: (() => void)[] = [];
  const raf = (cb: () => void) => {
    q.push(cb);
  };
  const flush = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      const batch = q;
      q = [];
      for (const cb of batch) cb();
    }
  };
  return { raf, flush };
}

/** Let Solid's deferred effect queue drain. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(
  body: (ctx: {
    ee: EnterExit;
    setOpen: (v: boolean) => Promise<void>;
    flush: (n: number) => void;
    enters: () => number;
    finishes: () => number;
  }) => Promise<void>,
  opts?: { reduced?: boolean; fallbackMs?: number },
) {
  return createRoot(async (dispose) => {
    const [open, setOpenSignal] = createSignal(false);
    const { raf, flush } = fakeRaf();
    let enters = 0;
    let finishes = 0;
    const ee = createEnterExit({
      open,
      onEnter: () => enters++,
      onFinishClose: () => finishes++,
      closeProperty: "transform",
      reduced: () => opts?.reduced ?? false,
      raf: opts?.reduced ? undefined : raf,
      fallbackMs: opts?.fallbackMs,
    });
    const setOpen = async (v: boolean): Promise<void> => {
      setOpenSignal(v);
      await tick();
    };
    await tick(); // let the initial effect settle
    try {
      await body({ ee, setOpen, flush, enters: () => enters, finishes: () => finishes });
    } finally {
      dispose();
    }
  });
}

describe("createEnterExit", () => {
  test("starts unmounted when open is false", () =>
    harness(async ({ ee }) => {
      expect(ee.rendered()).toBe(false);
      expect(ee.stage()).toBe("pre");
    }));

  test("open → mounts, holds at `pre`, then flips to `open` after the double rAF", () =>
    harness(async ({ ee, setOpen, flush, enters }) => {
      await setOpen(true);
      // Mounted immediately (so it is in the tree to animate), but still `pre`
      // (off-screen) until two frames pass — a single rAF would skip the anim.
      expect(ee.rendered()).toBe(true);
      expect(ee.stage()).toBe("pre");
      flush(1);
      expect(ee.stage()).toBe("pre");
      flush(1);
      expect(ee.stage()).toBe("open");
      // onEnter (measure + set resting detent) ran exactly once, at the flip.
      expect(enters()).toBe(1);
    }));

  test("close → `closing`, still rendered, then transitionend finishes it", () =>
    harness(async ({ ee, setOpen, flush, finishes }) => {
      await setOpen(true);
      flush(2);
      await setOpen(false);
      expect(ee.stage()).toBe("closing");
      expect(ee.rendered()).toBe(true); // exit animation still playing
      expect(finishes()).toBe(0);
      const el = {} as EventTarget;
      ee.handleTransitionEnd({ target: el, currentTarget: el, propertyName: "transform" });
      expect(ee.rendered()).toBe(false);
      expect(ee.stage()).toBe("pre");
      expect(finishes()).toBe(1);
    }));

  test("a transitionend that is bubbled or of the wrong property is ignored", () =>
    harness(async ({ ee, setOpen, flush }) => {
      await setOpen(true);
      flush(2);
      await setOpen(false);
      const el = {} as EventTarget;
      const other = {} as EventTarget;
      // Bubbled from a child — target !== currentTarget.
      ee.handleTransitionEnd({ target: other, currentTarget: el, propertyName: "transform" });
      expect(ee.rendered()).toBe(true);
      // Right element, wrong property (an opacity fade on a child control).
      ee.handleTransitionEnd({ target: el, currentTarget: el, propertyName: "opacity" });
      expect(ee.rendered()).toBe(true);
    }));

  test("the fallback timer forces the unmount when transitionend never arrives", () =>
    harness(
      async ({ ee, setOpen, flush, finishes }) => {
        await setOpen(true);
        flush(2);
        await setOpen(false);
        expect(ee.rendered()).toBe(true);
        // No transitionend fires; the fallback must still tear it down.
        await new Promise((r) => setTimeout(r, 25));
        expect(ee.rendered()).toBe(false);
        expect(finishes()).toBe(1);
      },
      { fallbackMs: 10 },
    ));

  test("reduced motion skips the frames: enter is instant, close is instant", () =>
    harness(
      async ({ ee, setOpen, enters, finishes }) => {
        await setOpen(true);
        // No rAF needed — straight to open, onEnter already ran.
        expect(ee.stage()).toBe("open");
        expect(ee.rendered()).toBe(true);
        expect(enters()).toBe(1);
        await setOpen(false);
        // No transitionend needed — finished synchronously.
        expect(ee.rendered()).toBe(false);
        expect(finishes()).toBe(1);
      },
      { reduced: true },
    ));

  test("beginClose starts the exit synchronously (drag-dismiss), idempotently", () =>
    harness(async ({ ee, setOpen, flush }) => {
      await setOpen(true);
      flush(2);
      ee.beginClose();
      expect(ee.stage()).toBe("closing");
      // A second call is a no-op — no double teardown.
      ee.beginClose();
      expect(ee.stage()).toBe("closing");
      expect(ee.rendered()).toBe(true);
    }));

  test("reopening mid-close cancels the exit and re-enters", () =>
    harness(async ({ ee, setOpen, flush }) => {
      await setOpen(true);
      flush(2);
      await setOpen(false);
      expect(ee.stage()).toBe("closing");
      await setOpen(true); // changed my mind
      expect(ee.rendered()).toBe(true);
      flush(2);
      expect(ee.stage()).toBe("open");
    }));
});
