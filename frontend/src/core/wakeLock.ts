import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

/**
 * Screen Wake Lock: keep this screen from dimming/locking while the chart is
 * shown (`keepScreenOn`, default on). The browser drops the lock whenever the
 * tab hides, so it is re-requested on `visibilitychange`.
 *
 * Degrades SILENTLY to nothing where `navigator.wakeLock` is absent — which
 * includes every non-secure context: the API exists only over HTTPS (or on
 * `localhost`). The stock boat install serves plain `http://<pi>:8230/`, so
 * there it does nothing; behind an HTTPS reverse proxy (deploy/README.md) or
 * `tailscale serve` it works. A failed request (battery saver, permissions
 * policy) is swallowed too — this is a convenience, never an error.
 */

/** The bits of `WakeLockSentinel` we use. */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", cb: () => void): void;
}

/** The browser, injectable so the policy is testable without a DOM. */
export interface WakeLockEnv {
  /** `navigator.wakeLock`, or undefined where unsupported / not a secure context. */
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
  isVisible(): boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibilityChange(cb: () => void): () => void;
}

export function browserWakeLockEnv(): WakeLockEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const doc = typeof document === "undefined" ? undefined : document;
  return {
    wakeLock: (nav as { wakeLock?: WakeLockEnv["wakeLock"] } | undefined)?.wakeLock,
    isVisible: () => doc?.visibilityState === "visible",
    onVisibilityChange: (cb) => {
      if (!doc) return () => {};
      doc.addEventListener("visibilitychange", cb);
      return () => doc.removeEventListener("visibilitychange", cb);
    },
  };
}

/** Is a screen wake lock possible in this browser/context at all? */
export function wakeLockSupported(env: WakeLockEnv = browserWakeLockEnv()): boolean {
  return env.wakeLock != null;
}

/**
 * Hold a screen wake lock while `enabled()` and the page is visible. Must run
 * under a reactive owner (released on cleanup). `held` is live, for tests and
 * any future indicator.
 */
export function createScreenWakeLock(
  enabled: Accessor<boolean>,
  env: WakeLockEnv = browserWakeLockEnv(),
): { held: Accessor<boolean> } {
  const [held, setHeld] = createSignal(false);
  const api = env.wakeLock;
  if (!api) return { held };

  let sentinel: WakeLockSentinelLike | undefined;
  let pending = false;
  let disposed = false;

  const want = () => !disposed && enabled() && env.isVisible();

  const drop = () => {
    const s = sentinel;
    sentinel = undefined;
    setHeld(false);
    if (s) void s.release().catch(() => {});
  };

  const sync = () => {
    if (!want()) {
      drop();
      return;
    }
    if (sentinel || pending) return;
    pending = true;
    api.request("screen").then(
      (s) => {
        pending = false;
        if (!want()) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
        setHeld(true);
        // The UA releases it on hide (and may at will, e.g. low battery).
        s.addEventListener("release", () => {
          if (sentinel !== s) return;
          sentinel = undefined;
          setHeld(false);
        });
        // Visibility may have flipped while the request was in flight.
        sync();
      },
      () => {
        pending = false;
      },
    );
  };

  createEffect(() => {
    enabled();
    sync();
  });
  const off = env.onVisibilityChange(sync);
  onCleanup(() => {
    disposed = true;
    off();
    drop();
  });
  return { held };
}
