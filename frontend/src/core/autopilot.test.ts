/**
 * The autopilot COMMAND client — the write half that steers the boat.
 *
 * Two things are load-bearing and tested directly here, without a socket or a
 * clock:
 *
 *  1. The status→outcome mapping IS the safety contract. 200 "it happened",
 *     502 "it did NOT happen", 503 "cannot command", 400/404 "the pilot said
 *     no, verbatim" must never collapse into one another. A helmsman's
 *     disengage depends on the difference.
 *
 *  2. Hold-to-engage fires only after an unbroken 600 ms and abort sends
 *     NOTHING. The timing is injected so the decision — fire vs abort — is
 *     asserted deterministically.
 *
 * NB: needs `--conditions=browser` like the other Solid tests (see the `test`
 * script); the signals below are vacuous under the SSR build.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  classifyStatus,
  createAutopilotClient,
  createAutopilotController,
  createHoldToFire,
  type ApOutcome,
  type AutopilotClient,
} from "./autopilot";

/** A fetch double: records each call and replies from a queue of `[status,
 * body]`. `body` may be an object (JSON), a thrown marker for a non-JSON body,
 * or "network" to make fetch itself reject. */
type Reply = { status: number; body?: unknown; network?: boolean };
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected fetch to ${url}`);
    if (reply.network) return Promise.reject(new Error("network"));
    const res = {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      json: () =>
        reply.body === undefined
          ? Promise.reject(new Error("no body"))
          : Promise.resolve(reply.body),
    } as unknown as Response;
    return Promise.resolve(res);
  };
  return { fetch, calls };
}

describe("classifyStatus — the safety contract", () => {
  test("each code maps to its own distinct kind", () => {
    expect(classifyStatus(200)).toBe("ok");
    expect(classifyStatus(204)).toBe("ok");
    expect(classifyStatus(502)).toBe("unreachable");
    expect(classifyStatus(503)).toBe("unavailable");
    expect(classifyStatus(400)).toBe("refused");
    expect(classifyStatus(404)).toBe("refused");
    // Anything else — 422 our own validation, 500 — is an honest "error", never
    // softened into success.
    expect(classifyStatus(422)).toBe("error");
    expect(classifyStatus(500)).toBe("error");
  });
});

describe("createAutopilotClient — outcomes", () => {
  test("200 is ok — the device COMPLETED", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { state: "COMPLETED" } }]);
    const out = await createAutopilotClient({ fetch }).disengage();
    expect(out.status).toBe("ok");
  });

  test("502 is unreachable and says it did NOT happen", async () => {
    const { fetch } = fakeFetch([{ status: 502, body: { detail: "box did not answer" } }]);
    const out = await createAutopilotClient({ fetch }).engage();
    expect(out.status).toBe("unreachable");
    expect((out as Extract<ApOutcome, { status: "unreachable" }>).message).toBe(
      "box did not answer",
    );
  });

  test("503 is unavailable (server cannot command)", async () => {
    const { fetch } = fakeFetch([{ status: 503, body: { detail: "SignalK disabled" } }]);
    const out = await createAutopilotClient({ fetch }).engage();
    expect(out.status).toBe("unavailable");
    expect((out as Extract<ApOutcome, { status: "unavailable" }>).message).toBe("SignalK disabled");
  });

  test("400/404 is refused, message passed through VERBATIM", async () => {
    const { fetch: f400 } = fakeFetch([{ status: 400, body: { detail: "not in a wind mode" } }]);
    const refused = await createAutopilotClient({ fetch: f400 }).tack("port");
    expect(refused.status).toBe("refused");
    expect((refused as Extract<ApOutcome, { status: "refused" }>).message).toBe(
      "not in a wind mode",
    );

    const { fetch: f404 } = fakeFetch([{ status: 404, body: { detail: "no such pilot" } }]);
    expect((await createAutopilotClient({ fetch: f404 }).engage()).status).toBe("refused");
  });

  test("a missing detail falls back to an honest default, still not 'ok'", async () => {
    const { fetch } = fakeFetch([{ status: 502 }]); // no body → json() rejects
    const out = await createAutopilotClient({ fetch }).disengage();
    expect(out.status).toBe("unreachable");
    expect((out as Extract<ApOutcome, { status: "unreachable" }>).message).toContain(
      "DID NOT happen",
    );
  });

  test("a network failure is an error — the command certainly did not happen", async () => {
    const { fetch } = fakeFetch([{ status: 0, network: true }]);
    const out = await createAutopilotClient({ fetch }).disengage();
    expect(out.status).toBe("error");
  });
});

describe("createAutopilotClient — wire shapes", () => {
  test("methods, paths and bodies match the backend routes", async () => {
    const replies: Reply[] = Array.from({ length: 8 }, () => ({ status: 200, body: {} }));
    const { fetch, calls } = fakeFetch(replies);
    const c = createAutopilotClient({ fetch });
    await c.engage();
    await c.disengage();
    await c.setMode("wind");
    await c.setTarget(120);
    await c.adjustTarget(-10);
    await c.tack("starboard");
    await c.gybe("port");
    await c.dodge(5);
    expect(calls).toEqual([
      { url: "/api/autopilot/engage", method: "POST", body: undefined },
      { url: "/api/autopilot/disengage", method: "POST", body: undefined },
      { url: "/api/autopilot/mode", method: "PUT", body: { value: "wind" } },
      { url: "/api/autopilot/target", method: "PUT", body: { degrees: 120 } },
      { url: "/api/autopilot/target/adjust", method: "PUT", body: { degrees: -10 } },
      { url: "/api/autopilot/tack/starboard", method: "POST", body: undefined },
      { url: "/api/autopilot/gybe/port", method: "POST", body: undefined },
      { url: "/api/autopilot/dodge", method: "PUT", body: { degrees: 5 } },
    ]);
  });

  test("info returns options for the mode picker on 200, and the failure kind otherwise", async () => {
    const opts = { modes: ["compass", "wind"], states: [], actions: [] };
    const { fetch: ok } = fakeFetch([{ status: 200, body: { pilot: "pypilot", options: opts } }]);
    const got = await createAutopilotClient({ fetch: ok }).info();
    expect(got.status).toBe("ok");
    if (got.status === "ok") expect(got.info.options?.modes).toEqual(["compass", "wind"]);

    const { fetch: off } = fakeFetch([{ status: 503, body: { detail: "off" } }]);
    expect((await createAutopilotClient({ fetch: off }).info()).status).toBe("unavailable");
  });
});

describe("createAutopilotController — ±° accumulate an ABSOLUTE target", () => {
  // A client that records both the ABSOLUTE `setTarget` PUTs (what we now send)
  // and any RELATIVE `adjustTarget` PUTs (the superseded path — should stay
  // empty). The helmsman's bug: deliberate consecutive relative adjusts RACE on
  // the pilot side and are lost, so four "+1" taps move the target ~1°. Sending
  // the full absolute target each time makes last-write-wins converge, so the
  // assertions are about the LAST `setTarget` carrying the fully-accumulated
  // value — and about accumulating from `intended`, not the laggy confirmed one.
  const ok: ApOutcome = { status: "ok" };
  function recordingClient() {
    const setTargetCalls: number[] = [];
    const adjustCalls: number[] = [];
    const client: AutopilotClient = {
      info: () => Promise.resolve({ status: "ok", info: {} }),
      engage: () => Promise.resolve(ok),
      disengage: () => Promise.resolve(ok),
      setState: () => Promise.resolve(ok),
      setMode: () => Promise.resolve(ok),
      setTarget: (degrees: number) => {
        setTargetCalls.push(degrees);
        return Promise.resolve(ok);
      },
      adjustTarget: (degrees: number) => {
        adjustCalls.push(degrees);
        return Promise.resolve(ok);
      },
      tack: () => Promise.resolve(ok),
      gybe: () => Promise.resolve(ok),
      startDodge: () => Promise.resolve(ok),
      stopDodge: () => Promise.resolve(ok),
      dodge: () => Promise.resolve(ok),
    };
    return { client, setTargetCalls, adjustCalls };
  }

  // A hand-driven debounce timer: `setTimer` stashes the callback, `fire`
  // elapses the window on demand — so "within the window" vs "well separated"
  // is exact, not a real-clock race.
  function timerHarness() {
    let scheduled: (() => void) | null = null;
    let cleared = 0;
    return {
      setTimer: (cb: () => void) => {
        scheduled = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        cleared++;
        scheduled = null;
      },
      fire: () => {
        const s = scheduled;
        scheduled = null;
        s?.();
      },
      pending: () => scheduled !== null,
      cleared: () => cleared,
    };
  }

  test("THE BUG: four +1 presses spaced beyond the window accumulate to base+4", async () =>
    await createRoot(async (dispose) => {
      const { client, setTargetCalls, adjustCalls } = recordingClient();
      const t = timerHarness();
      // The confirmed target LAGS at 130 the whole time — the device has not
      // echoed any of our presses back yet (exactly the racing/laggy world the
      // bug lives in).
      const [confirmed] = createSignal<number | undefined>(130);
      const ctrl = createAutopilotController({
        client,
        target: confirmed,
        sendDebounceMs: 100,
        setTimer: t.setTimer,
        clearTimer: t.clearTimer,
      });
      // Each press is well separated: the window elapses between taps.
      for (let i = 0; i < 4; i++) {
        const p = ctrl.adjust(1);
        t.fire();
        await p;
      }
      // Absolute values, accumulating: 131, 132, 133, 134. The LAST carries the
      // fully-accumulated target — base+4 — which is the whole point.
      expect(setTargetCalls).toEqual([131, 132, 133, 134]);
      expect(setTargetCalls.at(-1)).toBe(134); // base+4, NOT base+1
      // The superseded relative path is never used.
      expect(adjustCalls).toEqual([]);
      dispose();
    }));

  test("presses accumulate from `intended`, not the laggy confirmed value", async () =>
    await createRoot(async (dispose) => {
      const { client, setTargetCalls } = recordingClient();
      const t = timerHarness();
      // Frozen confirmed: if `adjust` re-read this each time it would send
      // 131 on every press. Accumulating from `intended` gives 131,132,133.
      const [confirmed] = createSignal<number | undefined>(130);
      const ctrl = createAutopilotController({
        client,
        target: confirmed,
        sendDebounceMs: 100,
        setTimer: t.setTimer,
        clearTimer: t.clearTimer,
      });
      for (let i = 0; i < 3; i++) {
        const p = ctrl.adjust(1);
        t.fire();
        await p;
      }
      expect(setTargetCalls).toEqual([131, 132, 133]); // NOT [131,131,131]
      dispose();
    }));

  test("compass targets wrap into [0,360): 359 + 2 → 1", async () =>
    await createRoot(async (dispose) => {
      const { client, setTargetCalls } = recordingClient();
      const t = timerHarness();
      const [confirmed] = createSignal<number | undefined>(359);
      const ctrl = createAutopilotController({
        client,
        target: confirmed,
        sendDebounceMs: 100,
        setTimer: t.setTimer,
        clearTimer: t.clearTimer,
      });
      const p = ctrl.adjust(2);
      t.fire();
      await p;
      expect(setTargetCalls).toEqual([1]);
      dispose();
    }));

  test("after the confirmed target catches up, the next press re-bases on it", async () =>
    await createRoot(async (dispose) => {
      const { client, setTargetCalls } = recordingClient();
      const t = timerHarness();
      const [confirmed, setConfirmed] = createSignal<number | undefined>(130);
      const ctrl = createAutopilotController({
        client,
        target: confirmed,
        sendDebounceMs: 100,
        setTimer: t.setTimer,
        clearTimer: t.clearTimer,
      });
      // Press once → intended 131, sent.
      const p1 = ctrl.adjust(1);
      t.fire();
      await p1;
      // The device echoes 131 → reconcile clears `intended`. Then the target is
      // changed EXTERNALLY to 200 (another helm / a mode change).
      setConfirmed(131); // catches up → intended cleared
      setConfirmed(200); // external change
      // The next press must re-base on 200 (→ 201), NOT on the stale 131 (→ 132).
      const p2 = ctrl.adjust(1);
      t.fire();
      await p2;
      expect(setTargetCalls).toEqual([131, 201]);
      dispose();
    }));

  test("a wind-mode target wraps signed in [-180,180)", async () =>
    await createRoot(async (dispose) => {
      const { client, setTargetCalls } = recordingClient();
      const t = timerHarness();
      // Wind angle 178° starboard, nudged +5: 183 wraps to -177, not 183 (which
      // would exceed the signed wind domain).
      const [confirmed] = createSignal<number | undefined>(178);
      const ctrl = createAutopilotController({
        client,
        target: confirmed,
        wind: () => true,
        sendDebounceMs: 100,
        setTimer: t.setTimer,
        clearTimer: t.clearTimer,
      });
      const p = ctrl.adjust(5);
      t.fire();
      await p;
      expect(setTargetCalls).toEqual([-177]);
      dispose();
    }));

  test("a burst inside one window coalesces to ONE setTarget of the sum", async () =>
    await createRoot(async (dispose) => {
      const { client, setTargetCalls } = recordingClient();
      const t = timerHarness();
      const [confirmed] = createSignal<number | undefined>(130);
      const ctrl = createAutopilotController({
        client,
        target: confirmed,
        sendDebounceMs: 100,
        setTimer: t.setTimer,
        clearTimer: t.clearTimer,
      });
      void ctrl.adjust(1);
      const p = ctrl.adjust(10); // second press inside the same window
      // Nothing sent yet; the pending feedback already reflects the accumulated
      // absolute target it is HEADING to.
      expect(setTargetCalls.length).toBe(0);
      expect(ctrl.feedback()).toEqual({ label: "→ 141°", kind: "pending" });
      t.fire();
      await p;
      expect(setTargetCalls).toEqual([141]); // one PUT, the full absolute value
      dispose();
    }));

  test("teardown cancels a pending window — nothing escapes, no timer leaks", async () =>
    await createRoot(async (dispose) => {
      const { client, setTargetCalls } = recordingClient();
      const t = timerHarness();
      const [confirmed] = createSignal<number | undefined>(130);
      const ctrl = createAutopilotController({
        client,
        target: confirmed,
        sendDebounceMs: 100,
        setTimer: t.setTimer,
        clearTimer: t.clearTimer,
      });
      void ctrl.adjust(1);
      dispose(); // surface torn down mid-window
      expect(t.pending()).toBe(false); // the debounce timer was cleared
      expect(t.cleared()).toBeGreaterThanOrEqual(1);
      await Promise.resolve();
      expect(setTargetCalls).toEqual([]);
      dispose();
    }));
});

describe("createHoldToFire — deliberate 600 ms, release aborts", () => {
  // A controllable timer: `start` schedules a callback we invoke by hand, so
  // "held the full duration" and "released early" are exact, not timing-raced.
  function harness() {
    let scheduled: (() => void) | null = null;
    let cleared = 0;
    const fired: number[] = [];
    let now = 0;
    const hold = createHoldToFire({
      onFire: () => fired.push(now),
      durationMs: 600,
      now: () => now,
      setTimer: (cb) => {
        scheduled = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        cleared++;
        scheduled = null;
      },
      raf: () => 0, // no visual frame loop in the test
      cancelRaf: () => {},
    });
    return {
      hold,
      fired,
      fireTimer: () => scheduled?.(),
      cleared: () => cleared,
      setNow: (t: number) => (now = t),
    };
  }

  test("holding the full duration fires exactly once", () =>
    createRoot((dispose) => {
      const h = harness();
      h.hold.start();
      expect(h.hold.holding()).toBe(true);
      expect(h.hold.progress()).toBe(0);
      h.setNow(600);
      h.fireTimer(); // the 600 ms timer elapses
      expect(h.fired.length).toBe(1);
      expect(h.hold.progress()).toBe(1);
      expect(h.hold.holding()).toBe(false);
      dispose();
    }));

  test("releasing before the timer aborts and sends NOTHING", () =>
    createRoot((dispose) => {
      const h = harness();
      h.hold.start();
      h.hold.cancel(); // released early
      expect(h.fired.length).toBe(0);
      expect(h.cleared()).toBe(1); // the pending fire was cancelled
      expect(h.hold.progress()).toBe(0);
      expect(h.hold.holding()).toBe(false);
      dispose();
    }));

  test("a cancel after firing is inert", () =>
    createRoot((dispose) => {
      const h = harness();
      h.hold.start();
      h.setNow(600);
      h.fireTimer();
      h.hold.cancel();
      expect(h.fired.length).toBe(1); // still exactly one
      dispose();
    }));
});
