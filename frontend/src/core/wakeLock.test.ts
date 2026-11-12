import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createScreenWakeLock, wakeLockSupported, type WakeLockEnv, type WakeLockSentinelLike } from "./wakeLock";

/** A fake browser: visibility flag + a wake-lock API whose sentinels the
 * test can inspect and the "UA" can release. */
function fakeEnv(opts: { reject?: boolean } = {}) {
  let visible = true;
  const listeners = new Set<() => void>();
  const sentinels: { released: boolean; uaRelease: () => void }[] = [];
  let requests = 0;
  const env: WakeLockEnv = {
    wakeLock: {
      request: () => {
        requests++;
        if (opts.reject) return Promise.reject(new Error("NotAllowedError"));
        const cbs: (() => void)[] = [];
        const rec = {
          released: false,
          uaRelease: () => {
            rec.released = true;
            cbs.forEach((cb) => cb());
          },
        };
        sentinels.push(rec);
        const s: WakeLockSentinelLike = {
          release: async () => {
            rec.released = true;
          },
          addEventListener: (_t, cb) => cbs.push(cb),
        };
        return Promise.resolve(s);
      },
    },
    isVisible: () => visible,
    onVisibilityChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const setVisible = (v: boolean) => {
    visible = v;
    listeners.forEach((cb) => cb());
  };
  return { env, sentinels, setVisible, requests: () => requests, listeners };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createScreenWakeLock", () => {
  test("acquires when enabled and visible", async () => {
    const f = fakeEnv();
    const lock = createRoot(() => createScreenWakeLock(() => true, f.env));
    await tick();
    expect(lock.held()).toBe(true);
    expect(f.requests()).toBe(1);
  });

  test("hidden tab: the UA releases it, and it is re-acquired when visible again", async () => {
    const f = fakeEnv();
    const lock = createRoot(() => createScreenWakeLock(() => true, f.env));
    await tick();
    // Browser behaviour on hide: release first, then visibilitychange.
    f.sentinels[0].uaRelease();
    f.setVisible(false);
    expect(lock.held()).toBe(false);
    await tick();
    expect(f.requests()).toBe(1); // no request while hidden
    f.setVisible(true);
    await tick();
    expect(lock.held()).toBe(true);
    expect(f.requests()).toBe(2);
  });

  test("toggling the setting off releases; on re-acquires", async () => {
    const f = fakeEnv();
    const [on, setOn] = createSignal(true);
    const lock = createRoot(() => createScreenWakeLock(on, f.env));
    await tick();
    setOn(false);
    expect(lock.held()).toBe(false);
    expect(f.sentinels[0].released).toBe(true);
    setOn(true);
    await tick();
    expect(lock.held()).toBe(true);
    expect(f.requests()).toBe(2);
  });

  test("disabled by default setting: never requests", async () => {
    const f = fakeEnv();
    createRoot(() => createScreenWakeLock(() => false, f.env));
    await tick();
    expect(f.requests()).toBe(0);
  });

  test("a grant arriving after the tab hid is released, not kept", async () => {
    const f = fakeEnv();
    const lock = createRoot(() => createScreenWakeLock(() => true, f.env));
    f.setVisible(false); // before the request resolves
    await tick();
    expect(lock.held()).toBe(false);
    expect(f.sentinels[0].released).toBe(true);
  });

  test("a rejected request is swallowed", async () => {
    const f = fakeEnv({ reject: true });
    const lock = createRoot(() => createScreenWakeLock(() => true, f.env));
    await tick();
    expect(lock.held()).toBe(false);
  });

  test("unsupported (no navigator.wakeLock, e.g. plain http): silent no-op", () => {
    const env: WakeLockEnv = { isVisible: () => true, onVisibilityChange: () => () => {} };
    expect(wakeLockSupported(env)).toBe(false);
    const lock = createRoot(() => createScreenWakeLock(() => true, env));
    expect(lock.held()).toBe(false);
  });

  test("dispose releases the lock and unsubscribes", async () => {
    const f = fakeEnv();
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      createScreenWakeLock(() => true, f.env);
    });
    await tick();
    dispose();
    expect(f.sentinels[0].released).toBe(true);
    expect(f.listeners.size).toBe(0);
  });
});
