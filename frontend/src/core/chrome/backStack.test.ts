/**
 * The back-stack bookkeeping — the pure LIFO that mirrors the app's open layers
 * onto history entries, and the wiring's swallow logic that tells our own unwind
 * echoes apart from a user Back.
 *
 * DOM-free by construction (this harness has no browser and no History API): the
 * decision core is a plain structure and the wiring takes an injected fake
 * history, exactly the split ../gesture.ts uses. The real `popstate`/`pushState`
 * plumbing (startBackStack, the window singleton) is driven in a browser, not
 * here.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { bindBackDismiss, createBackStackCore, createBackStack, type HistoryLike } from "./backStack";

describe("createBackStackCore — the pure LIFO", () => {
  test("pop peels most-recent-first and returns the dismisser", () => {
    const core = createBackStackCore();
    const log: string[] = [];
    core.push(() => log.push("a"));
    core.push(() => log.push("b"));
    expect(core.depth()).toBe(2);

    core.pop()?.();
    core.pop()?.();
    expect(log).toEqual(["b", "a"]); // LIFO
    expect(core.depth()).toBe(0);
  });

  test("pop on an empty stack returns undefined (real navigation)", () => {
    const core = createBackStackCore();
    expect(core.pop()).toBeUndefined();
  });

  test("the entry is removed BEFORE its dismisser runs (depth reflects it)", () => {
    const core = createBackStackCore();
    let depthDuringDismiss = -1;
    core.push(() => {
      depthDuringDismiss = core.depth();
    });
    core.pop()?.();
    expect(depthDuringDismiss).toBe(0);
  });

  test("remove of the top entry succeeds and shrinks the stack", () => {
    const core = createBackStackCore();
    core.push(() => {});
    const top = core.push(() => {});
    expect(core.remove(top)).toBe(true);
    expect(core.depth()).toBe(1);
  });

  test("remove of a NON-top entry removes exactly it, leaving the rest ordered", () => {
    const core = createBackStackCore();
    const log: string[] = [];
    const a = core.push(() => log.push("a"));
    core.push(() => log.push("b"));
    core.push(() => log.push("c"));
    expect(core.remove(a)).toBe(true); // middle/bottom removed
    expect(core.depth()).toBe(2);
    // The survivors still peel top-first (c before b); a is gone.
    core.pop()?.();
    core.pop()?.();
    expect(log).toEqual(["c", "b"]);
  });

  test("remove of an already-gone id is a no-op returning false", () => {
    const core = createBackStackCore();
    const id = core.push(() => {});
    core.pop(); // gone via a Back
    expect(core.remove(id)).toBe(false);
    expect(core.depth()).toBe(0);
  });
});

/** A fake history that records pushState and lets the test fire the popstate a
 * real `history.back()` would (async in a browser) by calling `handlePopState`. */
function fakeHistory() {
  const calls: string[] = [];
  const h: HistoryLike = {
    pushState: () => calls.push("push"),
    back: () => calls.push("back"),
  };
  return { h, calls };
}

describe("createBackStack — history mirroring & swallow", () => {
  test("register pushes an entry; a real Back pops the top and dismisses it", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    let dismissed = false;
    bs.register(() => (dismissed = true));
    expect(calls).toEqual(["push"]);
    expect(bs.depth()).toBe(1);

    bs.handlePopState(); // the browser fired popstate for a user Back
    expect(dismissed).toBe(true);
    expect(bs.depth()).toBe(0);
  });

  test("a programmatic close unwinds one entry and swallows its echo popstate", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    let dismissed = false;
    const handle = bs.register(() => (dismissed = true));

    handle.close(); // the surface's own X shut it
    expect(calls).toEqual(["push", "back"]); // we consumed one entry ourselves
    expect(bs.depth()).toBe(0);

    // The history.back() we called echoes back as a popstate — it must be
    // swallowed, NOT read as a user Back (no dismiss, no underflow).
    bs.handlePopState();
    expect(dismissed).toBe(false);
    expect(bs.depth()).toBe(0);
  });

  test("closing a layer already peeled by Back does not touch history again", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    const handle = bs.register(() => {});

    bs.handlePopState(); // Back peeled it
    expect(bs.depth()).toBe(0);

    handle.close(); // the dismiss's isOpen→false cleanup lands here
    expect(calls).toEqual(["push"]); // no extra back()
  });

  test("close is idempotent", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    const handle = bs.register(() => {});
    handle.close();
    handle.close();
    expect(calls).toEqual(["push", "back"]); // second close is a no-op
  });

  test("multiple layers: Back peels most-recent-first", () => {
    const { h } = fakeHistory();
    const bs = createBackStack(h);
    const log: string[] = [];
    bs.register(() => log.push("first"));
    bs.register(() => log.push("second"));
    expect(bs.depth()).toBe(2);

    bs.handlePopState();
    bs.handlePopState();
    expect(log).toEqual(["second", "first"]);
  });

  test("a Back with nothing registered is a no-op (the browser navigates)", () => {
    const { h } = fakeHistory();
    const bs = createBackStack(h);
    expect(() => bs.handlePopState()).not.toThrow();
    expect(bs.depth()).toBe(0);
  });

  test("closing a non-top layer stays consistent (count, not identity)", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    const log: string[] = [];
    const bottom = bs.register(() => log.push("bottom"));
    bs.register(() => log.push("top"));

    bottom.close(); // close the one that is NOT on top
    expect(calls).toEqual(["push", "push", "back"]);
    bs.handlePopState(); // swallow the echo
    expect(bs.depth()).toBe(1);
    expect(log).toEqual([]); // programmatic close never dismisses

    bs.handlePopState(); // a real Back now peels the remaining (top) layer
    expect(log).toEqual(["top"]);
  });
});

describe("dismissTop — the Escape key's half of the same stack", () => {
  test("dismisses the TOPMOST layer only, one per press", () => {
    const { h } = fakeHistory();
    const bs = createBackStack(h);
    const log: string[] = [];
    // Real surfaces unwind their own layer when their dismisser closes them;
    // mirror that so repeated presses peel downwards.
    const a = bs.register(() => (log.push("a"), a.close()));
    const b = bs.register(() => (log.push("b"), b.close()));

    expect(bs.dismissTop()).toBe(true);
    expect(log).toEqual(["b"]); // not "a" as well
    expect(bs.depth()).toBe(1);

    expect(bs.dismissTop()).toBe(true);
    expect(log).toEqual(["b", "a"]);
    expect(bs.depth()).toBe(0);
  });

  test("nothing open: reports false and does nothing", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    expect(bs.dismissTop()).toBe(false);
    expect(calls).toEqual([]);
  });

  test("does not remove the layer itself — the surface's close path unwinds it, like its X", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    let dismissed = 0;
    const handle = bs.register(() => dismissed++);

    bs.dismissTop();
    expect(dismissed).toBe(1);
    // A dismisser that declined to close leaves layer and history untouched.
    expect(bs.depth()).toBe(1);
    expect(calls).toEqual(["push"]);

    handle.close(); // the surface closing (isOpen → false)
    expect(calls).toEqual(["push", "back"]);
    bs.handlePopState(); // our own echo, swallowed — not a second dismissal
    expect(dismissed).toBe(1);
    expect(bs.depth()).toBe(0);
  });

  test("an unregistered layer is never dismissed; the one beneath becomes the top", () => {
    const { h } = fakeHistory();
    const bs = createBackStack(h);
    const log: string[] = [];
    bs.register(() => log.push("under"));
    const top = bs.register(() => log.push("top"));
    top.close();

    expect(bs.dismissTop()).toBe(true);
    expect(log).toEqual(["under"]);
  });

  test("a Back-only layer (escape: false) on top is not dismissed, and nothing under it is either", () => {
    const { h } = fakeHistory();
    const bs = createBackStack(h);
    const log: string[] = [];
    bs.register(() => log.push("window"));
    bs.register(() => log.push("mode"), { escape: false });

    expect(bs.dismissTop()).toBe(false);
    expect(log).toEqual([]);

    // ...while a real Back still peels it.
    bs.handlePopState();
    expect(log).toEqual(["mode"]);
    // With the mode gone the window is the top and Escape reaches it.
    expect(bs.dismissTop()).toBe(true);
    expect(log).toEqual(["mode", "window"]);
  });

  test("a window opened ABOVE a Back-only layer is still dismissed", () => {
    const { h } = fakeHistory();
    const bs = createBackStack(h);
    const log: string[] = [];
    bs.register(() => log.push("mode"), { escape: false });
    bs.register(() => log.push("window"));
    expect(bs.dismissTop()).toBe(true);
    expect(log).toEqual(["window"]);
  });
});

describe("bindBackDismiss — the reactive registration", () => {
  test("registers while open, unwinds on close, and on disposal (unmount)", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    const [open, setOpen] = createSignal(false);
    const dispose = createRoot((d) => {
      bindBackDismiss(bs, open, () => setOpen(false));
      return d;
    });
    expect(bs.depth()).toBe(0);

    setOpen(true);
    expect(bs.depth()).toBe(1);

    expect(bs.dismissTop()).toBe(true); // Escape
    expect(open()).toBe(false);
    expect(bs.depth()).toBe(0);
    expect(calls).toEqual(["push", "back"]);

    setOpen(true);
    expect(bs.depth()).toBe(1);
    dispose(); // the surface unmounts while open
    expect(bs.depth()).toBe(0);
    expect(bs.dismissTop()).toBe(false);
  });

  test("an accessor re-run with the open state unchanged does no history ops", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    // The leg table's shape: open = target && route, where route is a new
    // object per 5 s poll / draft edit.
    const [route, setRoute] = createSignal<{ v: number } | null>({ v: 0 });
    const dispose = createRoot((d) => {
      bindBackDismiss(bs, () => route() !== null, () => {});
      return d;
    });
    expect(calls).toEqual(["push"]);
    for (let i = 1; i <= 5; i++) setRoute({ v: i });
    expect(calls).toEqual(["push"]);
    expect(bs.depth()).toBe(1);
    dispose();
  });
});

describe("never back() and pushState in one tick", () => {
  test("a layer registered while our unwind is in flight pushes after the echo", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    const a = bs.register(() => {});
    a.close();
    bs.register(() => {}); // same tick as the back()
    expect(calls).toEqual(["push", "back"]);
    expect(bs.depth()).toBe(1);
    bs.handlePopState(); // the echo lands
    expect(calls).toEqual(["push", "back", "push"]);
    bs.handlePopState(); // now a real Back peels the new layer
    expect(bs.depth()).toBe(0);
  });

  test("a deferred layer closed before the echo never touches history", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    const a = bs.register(() => {});
    a.close();
    const b = bs.register(() => {});
    b.close();
    bs.handlePopState();
    expect(calls).toEqual(["push", "back"]);
    expect(bs.depth()).toBe(0);
  });

  test("open → closed → open in one batch re-registers without a same-tick push", () => {
    const { h, calls } = fakeHistory();
    const bs = createBackStack(h);
    const [open, setOpen] = createSignal(true);
    const dispose = createRoot((d) => {
      bindBackDismiss(bs, open, () => setOpen(false));
      return d;
    });
    setOpen(false);
    setOpen(true);
    expect(calls).toEqual(["push", "back"]);
    bs.handlePopState();
    expect(calls).toEqual(["push", "back", "push"]);
    dispose();
  });
});
