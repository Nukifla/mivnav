import { createSignal, onCleanup } from "solid-js";

/**
 * Browser Fullscreen as a small signal + toggle for the on-map fullscreen
 * button. See docs/architecture/fullscreen-button.md for the iOS/Android
 * platform quirks `fullscreenButtonVisible` works around.
 */
export interface Fullscreen {
  /** Live: is the document currently fullscreen? Tracks `fullscreenchange`, so it
   * follows an Esc / OS-driven exit too, not just our own toggle. */
  isFullscreen: () => boolean;
  /** Enter fullscreen (a no-op when the API is unavailable or already in it).
   * Must be called inside a user gesture — the browser rejects a programmatic
   * request otherwise; the rejected promise is swallowed rather than thrown. */
  enter: () => void;
  /** Exit fullscreen (a no-op when not in it). */
  exit: () => void;
  /** Enter fullscreen if not in it, else exit. */
  toggle: () => void;
  /** Live: should the manual toggle button be shown? See
   * `fullscreenButtonVisible` — false when the API is absent (iOS) or the app is
   * already forced fullscreen by the PWA manifest (Android installed PWA). */
  buttonVisible: () => boolean;
}

/** Pure visibility predicate for the on-map fullscreen button, unit-testable
 * without a DOM. See docs/architecture/fullscreen-button.md for why each of
 * the three inputs matters. */
export function fullscreenButtonVisible(
  apiAvailable: boolean,
  displayModeFullscreen: boolean,
  isFullscreenElement: boolean,
): boolean {
  return apiAvailable && (isFullscreenElement || !displayModeFullscreen);
}

/**
 * Must be called under a reactive owner — the `fullscreenchange` and matchMedia
 * `change` listeners are torn down via `onCleanup`. Degrades to a no-op set of
 * accessors when there is no DOM (e.g. under `bun test`).
 */
export function createFullscreen(): Fullscreen {
  const doc = typeof document === "undefined" ? undefined : document;
  const apiAvailable =
    !!doc && typeof doc.documentElement.requestFullscreen === "function";

  const [isFullscreen, setFullscreen] = createSignal(!!doc?.fullscreenElement);
  if (doc) {
    const onChange = () => setFullscreen(!!doc.fullscreenElement);
    doc.addEventListener("fullscreenchange", onChange);
    onCleanup(() => doc.removeEventListener("fullscreenchange", onChange));
  }

  // `display-mode: fullscreen` means the PWA manifest already runs us
  // edge-to-edge (Android installed PWA). Reactive so the button appears/hides if
  // the mode changes at runtime (install / launch context switch).
  const mq =
    typeof window === "undefined"
      ? undefined
      : window.matchMedia("(display-mode: fullscreen)");
  const [displayFullscreen, setDisplayFullscreen] = createSignal(!!mq?.matches);
  if (mq) {
    const onMq = () => setDisplayFullscreen(mq.matches);
    mq.addEventListener("change", onMq);
    onCleanup(() => mq.removeEventListener("change", onMq));
  }

  // Read the live `fullscreenElement`, not `isFullscreen()`: the signal only
  // catches up on the event, which has not fired yet at the moment of the tap.
  const enter = (): void => {
    if (!doc || doc.fullscreenElement) return;
    void doc.documentElement.requestFullscreen?.()?.catch(() => {});
  };
  const exit = (): void => {
    if (!doc || !doc.fullscreenElement) return;
    void doc.exitFullscreen?.()?.catch(() => {});
  };
  const toggle = (): void => {
    if (doc?.fullscreenElement) exit();
    else enter();
  };

  return {
    isFullscreen,
    enter,
    exit,
    toggle,
    buttonVisible: () =>
      fullscreenButtonVisible(apiAvailable, displayFullscreen(), isFullscreen()),
  };
}
