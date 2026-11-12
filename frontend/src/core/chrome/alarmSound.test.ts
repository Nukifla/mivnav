import { describe, expect, test } from "bun:test";
import {
  createSiren,
  shouldSound,
  type SirenSink,
  type SirenTimers,
} from "./alarmSound";

// ── the decision: when is the siren allowed to sound ──────────────────────
//
// The rule the whole opt-in cue turns on: only while the per-device setting is
// on AND the reserved alarm strip is showing at least one unacked alarm. Notices
// never reach here — the caller drives `unackedAlarms` off the alarm strip's own
// list, not the notice strip's — so a quiet arrival notice can never make a
// sound, which is the deliberate silence NoticeStrip exists to keep.

describe("shouldSound", () => {
  test("silent unless the setting is on", () => {
    expect(shouldSound({ enabled: false, unackedAlarms: 3 })).toBe(false);
  });

  test("silent when nothing is firing, even with the setting on", () => {
    expect(shouldSound({ enabled: true, unackedAlarms: 0 })).toBe(false);
  });

  test("sounds only when both hold: setting on AND an unacked alarm is up", () => {
    expect(shouldSound({ enabled: true, unackedAlarms: 1 })).toBe(true);
    expect(shouldSound({ enabled: true, unackedAlarms: 5 })).toBe(true);
  });

  test("off-by-setting beats any number of alarms — the opt-in default is quiet", () => {
    expect(shouldSound({ enabled: false, unackedAlarms: 0 })).toBe(false);
    expect(shouldSound({ enabled: false, unackedAlarms: 99 })).toBe(false);
  });
});

// ── the controller: start/repeat/stop, mocked away from WebAudio ──────────
//
// A fake sink counts pulses and a hand-driven timer stands in for setInterval,
// so the tone/vibrate mechanics and the browser's gesture-gated AudioContext
// never enter into it — exactly the isolation the util exists to give.

function fakeSink() {
  let pulses = 0;
  let stops = 0;
  const sink: SirenSink = {
    pulse: () => {
      pulses++;
    },
    stop: () => {
      stops++;
    },
  };
  return { sink, pulses: () => pulses, stops: () => stops };
}

/** A manual interval: `tick()` fires the registered callback; records clears. */
function fakeTimers() {
  let cb: (() => void) | undefined;
  let id = 0;
  let cleared = 0;
  const timers: SirenTimers = {
    set: (fn) => {
      cb = fn;
      return ++id as unknown as ReturnType<typeof setInterval>;
    },
    clear: () => {
      cb = undefined;
      cleared++;
    },
  };
  return { timers, tick: () => cb?.(), armed: () => cb !== undefined, cleared: () => cleared };
}

describe("createSiren", () => {
  test("going active pulses immediately — heard now, not one interval later", () => {
    const { sink, pulses } = fakeSink();
    const { timers } = fakeTimers();
    const siren = createSiren(sink, { timers });
    siren.set(true);
    expect(pulses()).toBe(1);
  });

  test("repeats on each interval tick while active", () => {
    const { sink, pulses } = fakeSink();
    const { timers, tick } = fakeTimers();
    const siren = createSiren(sink, { timers });
    siren.set(true);
    tick();
    tick();
    expect(pulses()).toBe(3); // 1 immediate + 2 ticks
  });

  test("set(true) is idempotent: it does not double-pulse or re-arm", () => {
    const { sink, pulses } = fakeSink();
    const { timers } = fakeTimers();
    const siren = createSiren(sink, { timers });
    siren.set(true);
    siren.set(true);
    expect(pulses()).toBe(1);
  });

  test("going inactive stops the tone and disarms the timer — the ACK/clear path", () => {
    const { sink, pulses, stops } = fakeSink();
    const { timers, tick, armed } = fakeTimers();
    const siren = createSiren(sink, { timers });
    siren.set(true);
    siren.set(false);
    expect(stops()).toBe(1);
    expect(armed()).toBe(false);
    tick(); // no callback armed anymore
    expect(pulses()).toBe(1); // the immediate pulse only; the repeat was cancelled
  });

  test("critical uses the siren sound and its own pace; switching re-pulses at once", () => {
    const kinds: boolean[] = [];
    const sink: SirenSink = { pulse: (c) => void kinds.push(!!c), stop: () => {} };
    const intervals: number[] = [];
    const { timers, tick } = fakeTimers();
    const siren = createSiren(sink, {
      timers: { set: (fn, ms) => (intervals.push(ms), timers.set(fn, ms)), clear: timers.clear },
      intervalMs: 1500,
      criticalIntervalMs: 800,
    });
    siren.set(true, false);
    siren.set(true, false); // same sound: idempotent
    siren.set(true, true); // a critical alarm joins: switch now
    tick();
    siren.set(true, true);
    expect(kinds).toEqual([false, true, true]);
    expect(intervals).toEqual([1500, 800]);
  });

  test("dispose stops a running siren", () => {
    const { sink, stops } = fakeSink();
    const { timers, armed } = fakeTimers();
    const siren = createSiren(sink, { timers });
    siren.set(true);
    siren.dispose();
    expect(armed()).toBe(false);
    expect(stops()).toBe(1);
  });

  // Regression (#RT-HAPTIC): the AlarmStrip siren effect re-runs many times as
  // signals settle on LOAD, each computing `shouldSound(...) === false` and calling
  // `set(false)`. `set(false)` must be idempotent from cold — a never-active siren
  // must NOT touch the sink, or every recompute fires `sink.stop()` → a phantom
  // `navigator.vibrate(0)` (a burst of ~20 buzzes on every page load, no user
  // gesture). Only a real active→inactive transition may stop the sink.
  test("set(false) from cold never touches the sink — no phantom vibrate burst on load", () => {
    const { sink, stops } = fakeSink();
    const { timers } = fakeTimers();
    const siren = createSiren(sink, { timers });
    for (let i = 0; i < 20; i++) siren.set(false); // 20 reactive recomputes, all inactive
    expect(stops()).toBe(0); // never sounded → never stopped → no vibrate(0) burst
  });

  test("set(false) is idempotent AFTER a stop too — one stop per active spell", () => {
    const { sink, stops } = fakeSink();
    const { timers } = fakeTimers();
    const siren = createSiren(sink, { timers });
    siren.set(true);
    siren.set(false); // the one real stop
    siren.set(false); // already silent — must not re-stop
    siren.set(false);
    expect(stops()).toBe(1);
  });

  test("re-arms after a clear: set(false) then set(true) pulses and restarts", () => {
    const { sink, pulses } = fakeSink();
    const { timers, tick } = fakeTimers();
    const siren = createSiren(sink, { timers });
    siren.set(true); // pulse 1
    siren.set(false);
    siren.set(true); // pulse 2 (immediate again)
    tick(); // pulse 3
    expect(pulses()).toBe(3);
  });
});
