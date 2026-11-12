// The Android/gesture Back button, made to peel one dismissible layer at a
// time instead of leaving the app. See docs/architecture/back-stack.md for
// the design (the core/wiring split and the entry-count invariant).
//
// The Escape key peels the SAME stack (`dismissTopBackLayer`, driven by
// ./escape.ts from App's one keydown listener): a surface that opted into
// Back is thereby closable by Escape too, topmost first, with no listener of
// its own.

import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js";

/** Per-layer options. */
export interface BackLayerOptions {
  /** May the Escape key peel this layer? Default true. `false` = Back-only:
   * the layer has its own Escape path with its own guards (the active chart
   * mode's `exit-mode` command, suppressed while typing), and while it is the
   * TOP layer an Escape press peels nothing rather than reaching under it. */
  escape?: boolean;
}

export interface BackStackCore {
  /** Push a dismissible layer; returns its opaque id. */
  push(dismiss: () => void, opts?: BackLayerOptions): number;
  /** The TOP layer, left in place (undefined if empty) — what an Escape press
   * is about. Unlike {@link pop} nothing is removed: the dismisser closes the
   * surface, and the surface's own close path unwinds the layer. */
  peek(): { dismiss: () => void; escape: boolean } | undefined;
  /** Peel the TOP layer for a real Back and return its dismisser (undefined
   * if empty), removed BEFORE the dismisser runs. */
  pop(): (() => void) | undefined;
  /** Programmatic close of layer `id`: true if it was removed (consume one
   * history entry), false if already gone (a no-op). */
  remove(id: number): boolean;
  /** Registered layers — equal to the history entries we pushed. */
  depth(): number;
}

export function createBackStackCore(): BackStackCore {
  let seq = 0;
  const stack: { id: number; dismiss: () => void; escape: boolean }[] = [];
  return {
    push(dismiss, opts) {
      const id = ++seq;
      stack.push({ id, dismiss, escape: opts?.escape ?? true });
      return id;
    },
    peek: () => stack[stack.length - 1],
    pop() {
      return stack.pop()?.dismiss;
    },
    remove(id) {
      const i = stack.findIndex((e) => e.id === id);
      if (i < 0) return false;
      stack.splice(i, 1);
      return true;
    },
    depth: () => stack.length,
  };
}

/** A registered layer's handle: unwinds the matching history entry on a
 * programmatic close (X/Escape/tap-outside) WITHOUT invoking the dismisser.
 * Idempotent. */
export interface BackLayerHandle {
  close(): void;
}

/** The slice of `window.history` this needs — injectable so the wiring is
 * testable with a fake. */
export interface HistoryLike {
  pushState(data: unknown, unused: string): void;
  back(): void;
}

export interface BackStack {
  register(dismiss: () => void, opts?: BackLayerOptions): BackLayerHandle;
  /** An Escape press: dismiss the TOP layer, and only it. True if a dismisser
   * ran. The layer is NOT removed here — closing the surface runs its
   * programmatic-close path (`handle.close()`), which unwinds the history
   * entry exactly as its X button does; a dismisser that declines to close
   * therefore leaves the books balanced. */
  dismissTop(): boolean;
  /** Feed a `popstate` in. Tells our own unwind echoes apart from a user Back. */
  handlePopState(): void;
  depth(): number;
}

/** Stashed on our history entries — not load-bearing (the count is the
 * truth), just makes our entries recognisable in devtools. */
const MARKER = "__mivnavBack";

export function createBackStack(history: HistoryLike): BackStack {
  const core = createBackStackCore();
  // history.back() WE call fires a popstate we must not read as a user Back.
  // A counter, not a boolean: two programmatic closes in one tick queue two
  // echoes to swallow.
  let pendingUnwind = 0;
  // Layers registered while one of OUR back()s is still in flight: their
  // pushState waits for the echo. history.back() is async, and a pushState
  // issued before it lands makes the traversal eat a DIFFERENT entry — Chrome
  // then loses one real entry per back()+pushState cycle, until Back leaves
  // the app (a re-registering surface drained the whole history to
  // about:blank that way). Never both in one tick.
  const deferred = new Set<number>();

  const flushDeferred = (): void => {
    for (const _ of deferred) history.pushState({ [MARKER]: true }, "");
    deferred.clear();
  };

  const register = (dismiss: () => void, opts?: BackLayerOptions): BackLayerHandle => {
    const id = core.push(dismiss, opts);
    if (pendingUnwind > 0) deferred.add(id);
    else history.pushState({ [MARKER]: true }, "");
    let closed = false;
    return {
      close() {
        if (closed) return;
        closed = true;
        // Only consume a history entry if WE still hold this layer; a real
        // Back may already have popped it via this same cleanup path.
        if (core.remove(id)) {
          // Never pushed (still waiting on an echo): nothing to unwind.
          if (deferred.delete(id)) return;
          pendingUnwind++;
          history.back();
        }
      },
    };
  };

  const handlePopState = (): void => {
    if (pendingUnwind > 0) {
      pendingUnwind--;
      if (pendingUnwind === 0) flushDeferred();
      return;
    }
    core.pop()?.();
  };

  const dismissTop = (): boolean => {
    const top = core.peek();
    if (!top || !top.escape) return false;
    top.dismiss();
    return true;
  };

  return { register, dismissTop, handlePopState, depth: core.depth };
}

const NO_DOM = typeof window === "undefined" || typeof history === "undefined";

/** The one back-stack for the running app — a deliberate exception to the
 * no-module-singleton rule (see docs/architecture/back-stack.md); with no
 * DOM it's an inert stub. */
const singleton: BackStack = NO_DOM
  ? { register: () => ({ close() {} }), dismissTop: () => false, handlePopState() {}, depth: () => 0 }
  : createBackStack(window.history);

/** Mount the ONE `popstate` listener. Call once, at the top level (App).
 * Returns a cleanup. No-DOM → a no-op. */
export function startBackStack(): () => void {
  if (NO_DOM) return () => {};
  const onPop = (): void => singleton.handlePopState();
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}

/** Register a dismissible layer directly (for a non-reactive caller). Most
 * surfaces want {@link useBackDismiss} instead. */
export function registerBackLayer(dismiss: () => void, opts?: BackLayerOptions): BackLayerHandle {
  return singleton.register(dismiss, opts);
}

/** Escape's half of the running app's stack: close the topmost open layer.
 * True if one was dismissed. See {@link BackStack.dismissTop}. */
export function dismissTopBackLayer(): boolean {
  return singleton.dismissTop();
}

/** {@link useBackDismiss} against an explicit stack — the seam its test drives
 * with a fake history (the singleton is an inert stub with no DOM). */
export function bindBackDismiss(
  stack: Pick<BackStack, "register">,
  isOpen: Accessor<boolean>,
  onDismiss: () => void,
  opts?: BackLayerOptions,
): void {
  // A boolean memo, so the registration follows the open STATE only: an
  // accessor that also reads, say, a route object re-runs on every poll, and
  // each re-run would close + re-register (one back() + one pushState).
  const open = createMemo(() => !!isOpen());
  createEffect(() => {
    if (!open()) return;
    const handle = stack.register(onDismiss, opts);
    onCleanup(() => handle.close());
  });
}

/** Opt a surface into hardware/gesture Back AND the Escape key: while
 * `isOpen()`, a Back press — or an Escape press while this is the topmost
 * layer — calls `onDismiss` instead of leaving the app. `onDismiss` fires
 * ONLY on those — a programmatic close must stay idempotent on its own.
 * `{ escape: false }` keeps the layer Back-only. */
export function useBackDismiss(
  isOpen: Accessor<boolean>,
  onDismiss: () => void,
  opts?: BackLayerOptions,
): void {
  bindBackDismiss(singleton, isOpen, onDismiss, opts);
}
