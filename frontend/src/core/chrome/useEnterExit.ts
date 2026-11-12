// Enter/exit stage machine (D5) — extracted from ~80 lines duplicated across
// 4 surfaces, each with its own fallback-timer constant. Owns mount/animate/
// unmount timing only; a surface's own state threads through the callbacks.

import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { prefersReducedMotion } from "../media";
import { CLOSE_FALLBACK_MS } from "../style/motion";

export type EnterExitStage = "pre" | "open" | "closing";

export interface EnterExitOptions {
  /** The controlled source of truth. `true` mounts + animates in; `false`
   *  animates out then unmounts. */
  open: Accessor<boolean>;
  /** Runs just before the flip to `open` — after mount and the double-rAF,
   *  and also in the reduced-motion path. Where a sheet sets its resting
   *  detent so the opening transition targets the right offset. */
  onEnter?: () => void;
  /** Runs when the exit completes (real `transitionend` or the fallback) —
   *  reset surface state (a sheet's resting offset back to 0). */
  onFinishClose?: () => void;
  /** Only a `transitionend` for THIS CSS property finishes the close. Omit
   *  for a surface whose exit animates several properties with no single
   *  one to key off (the palette's opacity+scale). */
  closeProperty?: string;
  /** Fallback timeout (ms) guarding a missing `transitionend`. Defaults to
   *  the shared {@link CLOSE_FALLBACK_MS} token. */
  fallbackMs?: number;
  /** Reduced-motion signal. Injectable for tests; defaults to the app's. */
  reduced?: Accessor<boolean>;
  /** requestAnimationFrame. Injectable for tests (the headless harness has no
   *  rAF); defaults to the real one. */
  raf?: (cb: () => void) => void;
}

export interface EnterExit {
  /** Whether the surface should be in the tree at all (drives `<Show>` / Kobalte
   *  `open`). Stays `true` through the exit animation. */
  rendered: Accessor<boolean>;
  /** The animation phase — the surface reads this to pick its transform/opacity. */
  stage: Accessor<EnterExitStage>;
  /** Begin the exit animation NOW, idempotently — for a drag-dismiss that
   *  must paint the closing frame synchronously, not wait a tick for the
   *  `open`-prop round-trip. */
  beginClose: () => void;
  /** Wire onto the animating element's `onTransitionEnd`. */
  handleTransitionEnd: (e: {
    target: EventTarget | null;
    currentTarget: EventTarget | null;
    propertyName: string;
  }) => void;
}

export function createEnterExit(opts: EnterExitOptions): EnterExit {
  const reduce = opts.reduced ?? prefersReducedMotion;
  const raf = opts.raf ?? ((cb: () => void) => requestAnimationFrame(cb));
  const fallbackMs = opts.fallbackMs ?? CLOSE_FALLBACK_MS;

  const initiallyOpen = untrack(opts.open);
  const [rendered, setRendered] = createSignal(initiallyOpen);
  const [stage, setStage] = createSignal<EnterExitStage>(initiallyOpen ? "open" : "pre");
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const finishClose = (): void => {
    clearTimeout(closeTimer);
    closeTimer = undefined;
    setRendered(false);
    setStage("pre");
    opts.onFinishClose?.();
  };

  // Synchronous, idempotent: a drag-dismiss never paints a frame back at the
  // resting offset before the slide begins.
  const beginClose = (): void => {
    if (stage() === "closing") return;
    setStage("closing");
    if (reduce()) {
      finishClose();
      return;
    }
    closeTimer = setTimeout(finishClose, fallbackMs);
  };

  const enter = (): void => {
    clearTimeout(closeTimer);
    closeTimer = undefined;
    if (reduce()) {
      opts.onEnter?.();
      setStage("open");
      return;
    }
    setStage("pre");
    // Double rAF: a single one can coalesce with the mount frame, skipping
    // the transition entirely.
    raf(() =>
      raf(() => {
        opts.onEnter?.();
        setStage((s) => (s === "pre" ? "open" : s));
      }),
    );
  };

  createEffect(() => {
    const open = opts.open();
    untrack(() => {
      if (open) {
        setRendered(true);
        enter();
      } else if (rendered()) {
        beginClose();
      }
    });
  });
  onCleanup(() => clearTimeout(closeTimer));

  const handleTransitionEnd: EnterExit["handleTransitionEnd"] = (e) => {
    if (e.target !== e.currentTarget) return;
    if (opts.closeProperty && e.propertyName !== opts.closeProperty) return;
    if (stage() === "closing") finishClose();
  };

  return { rendered, stage, beginClose, handleTransitionEnd };
}
