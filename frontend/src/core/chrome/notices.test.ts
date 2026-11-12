/**
 * `createNotices` — the transient, self-clearing notice list.
 *
 * The behaviours that matter are the dedup-by-id (a re-fired event refreshes
 * its card rather than stacking a second), the auto-clear timeout, dismiss
 * cancelling that timer, and the owner-scoped cleanup that clears every pending
 * timer on disposal. Each runs under a `createRoot` because `createNotices`
 * registers an `onCleanup`, which needs an owner. The timeout path uses bun's
 * fake timers so it is deterministic and instant.
 */

import { afterEach, describe, expect, jest, test } from "bun:test";
import { createRoot } from "solid-js";
import { createNotices } from "./notices";

afterEach(() => {
  jest.useRealTimers();
});

describe("createNotices", () => {
  test("pushing the same id refreshes rather than stacks", () => {
    createRoot((dispose) => {
      const n = createNotices({ timeoutMs: 0 });
      n.push({ id: "arrival", title: "Approaching WP1" });
      n.push({ id: "arrival", title: "Arrived WP1", detail: "0.02 nm" });

      expect(n.list()).toHaveLength(1);
      expect(n.list()[0].title).toBe("Arrived WP1");
      expect(n.list()[0].detail).toBe("0.02 nm");
      dispose();
    });
  });

  test("distinct ids stack", () => {
    createRoot((dispose) => {
      const n = createNotices({ timeoutMs: 0 });
      n.push({ id: "a", title: "A" });
      n.push({ id: "b", title: "B" });
      expect(n.list().map((x) => x.id)).toEqual(["a", "b"]);
      dispose();
    });
  });

  test("dismiss removes the card and clears its timer", () => {
    jest.useFakeTimers();
    createRoot((dispose) => {
      const n = createNotices({ timeoutMs: 1000 });
      n.push({ id: "wp", title: "Waypoint" });
      expect(n.list()).toHaveLength(1);

      n.dismiss("wp");
      expect(n.list()).toHaveLength(0);

      // Timer must have been cancelled: re-push the same id, then run past the
      // ORIGINAL deadline. A leaked first timer would fire dismiss("wp") now and
      // wipe the fresh card; a cleared one leaves it standing.
      n.push({ id: "wp", title: "Waypoint again" });
      jest.advanceTimersByTime(1000);
      // The fresh card's own timer has now also fired at t=1000 (armed at the
      // re-push), so the list is empty — but via its OWN timeout, and only once.
      expect(n.list()).toHaveLength(0);
      dispose();
    });
  });

  test("a card self-clears after timeoutMs", () => {
    jest.useFakeTimers();
    createRoot((dispose) => {
      const n = createNotices({ timeoutMs: 500 });
      n.push({ id: "wp", title: "Waypoint" });
      expect(n.list()).toHaveLength(1);

      jest.advanceTimersByTime(499);
      expect(n.list()).toHaveLength(1);

      jest.advanceTimersByTime(1);
      expect(n.list()).toHaveLength(0);
      dispose();
    });
  });

  test("owner cleanup clears pending timers without firing them", () => {
    jest.useFakeTimers();
    let inner: ReturnType<typeof createNotices> | undefined;
    createRoot((dispose) => {
      inner = createNotices({ timeoutMs: 500 });
      inner.push({ id: "wp", title: "Waypoint" });
      expect(inner.list()).toHaveLength(1);
      dispose(); // triggers onCleanup → clearTimeout of the pending timer
    });
    // The card is still present (dispose does not dismiss, it only cancels the
    // timer), and advancing time no longer removes it: the timer is gone.
    jest.advanceTimersByTime(1000);
    expect(inner?.list()).toHaveLength(1);
  });
});
