/**
 * The access-request controller's state machine: pending → poll → granted /
 * denied / timeout. Driven directly (no DOM), with injected request/poll/wait
 * seams so the flow is deterministic and instant — the same way serverConfig
 * is tested.
 *
 * The one property that matters most: the token never appears here. The
 * backend stores it and this controller only ever learns *whether* access was
 * granted, so these tests assert on the phase, never on a secret.
 *
 * NB: needs `--conditions=browser` (see the `test` script) so solid-js's
 * reactive build runs; bare `bun test` would resolve the SSR build and pass
 * vacuously.
 */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createSignalKAccess,
  type AccessRequestPoll,
  type AccessRequestStarted,
} from "./signalkAccess";

/** A scripted backend: `start` hands back a request id, and each `poll`
 * returns the next queued result. `wait` resolves instantly so the loop does
 * not sleep. */
function scripted(polls: AccessRequestPoll[], opts: { onStart?: () => void } = {}) {
  let i = 0;
  const requested: string[] = [];
  let granted = 0;
  const controller = createSignalKAccess({
    request: async (): Promise<AccessRequestStarted> => {
      opts.onStart?.();
      return { state: "PENDING", requestId: "req-1" };
    },
    poll: async (id: string): Promise<AccessRequestPoll> => {
      requested.push(id);
      return polls[Math.min(i++, polls.length - 1)];
    },
    wait: async () => {},
    onGranted: () => granted++,
    intervalMs: 0,
  });
  return {
    controller,
    requested,
    get granted() {
      return granted;
    },
  };
}

const run = <T>(fn: (dispose: () => void) => Promise<T>) =>
  createRoot((dispose) => fn(dispose).finally(dispose));

describe("createSignalKAccess", () => {
  test("polls until approved, then reports granted and fires onGranted", async () => {
    await run(async () => {
      const s = scripted([
        { state: "PENDING" },
        { state: "PENDING" },
        { state: "COMPLETED", approved: true },
      ]);
      await s.controller.start();
      expect(s.controller.phase()).toBe("granted");
      expect(s.granted).toBe(1);
      // It kept polling the same request id across the pending replies.
      expect(s.requested).toEqual(["req-1", "req-1", "req-1"]);
      expect(s.controller.busy()).toBe(false);
    });
  });

  test("a denied request ends in denied and never fires onGranted", async () => {
    await run(async () => {
      const s = scripted([{ state: "PENDING" }, { state: "COMPLETED", approved: false }]);
      await s.controller.start();
      expect(s.controller.phase()).toBe("denied");
      expect(s.granted).toBe(0);
    });
  });

  test("the granted message carries no token — the controller never sees one", async () => {
    await run(async () => {
      // Even if a poll leaked a token field, the type forbids reading it and
      // the controller must not surface it. Assert the message is clean.
      const s = scripted([{ state: "COMPLETED", approved: true }]);
      await s.controller.start();
      expect(s.controller.message().toLowerCase()).toContain("granted");
      expect(s.controller.message()).not.toContain("eyJ"); // no JWT prefix
    });
  });

  test("a failed initiate surfaces the backend's message as an error", async () => {
    await run(async () => {
      const controller = createSignalKAccess({
        request: async () => {
          throw new Error("SignalK is not configured on this server");
        },
        wait: async () => {},
      });
      await controller.start();
      expect(controller.phase()).toBe("error");
      expect(controller.message()).toContain("not configured");
    });
  });

  test("a poll failure (box went away) ends in error", async () => {
    await run(async () => {
      const controller = createSignalKAccess({
        request: async () => ({ state: "PENDING", requestId: "req-1" }),
        poll: async () => {
          throw new Error("the SignalK server did not answer");
        },
        wait: async () => {},
      });
      await controller.start();
      expect(controller.phase()).toBe("error");
      expect(controller.message()).toContain("did not answer");
    });
  });

  test("gives up with a timeout message if approval never comes", async () => {
    await run(async () => {
      const controller = createSignalKAccess({
        request: async () => ({ state: "PENDING", requestId: "req-1" }),
        poll: async () => ({ state: "PENDING" }),
        wait: async () => {},
        intervalMs: 0,
        timeoutMs: -1, // already past the deadline after the first poll
      });
      await controller.start();
      expect(controller.phase()).toBe("error");
      expect(controller.message().toLowerCase()).toContain("timed out");
    });
  });

  test("start is idempotent while a request is already pending", async () => {
    await run(async () => {
      let requests = 0;
      let release: (r: AccessRequestPoll) => void = () => {};
      const controller = createSignalKAccess({
        request: async () => {
          requests++;
          return { state: "PENDING", requestId: "req-1" };
        },
        // Block the first poll so the controller stays pending across the
        // second start() call.
        poll: () => new Promise<AccessRequestPoll>((r) => (release = r)),
        wait: async () => {},
      });
      const first = controller.start();
      // Second call while pending: must not launch another request.
      await controller.start();
      expect(requests).toBe(1);
      release({ state: "COMPLETED", approved: true });
      await first;
      expect(controller.phase()).toBe("granted");
    });
  });
});
