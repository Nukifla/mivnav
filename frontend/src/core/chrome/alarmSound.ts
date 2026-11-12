// The opt-in audible + haptic collision cue, extra nudge for a helm not
// looking at the screen. Everything here is best-effort and must NEVER
// throw — the visual alarm (`AlarmStrip.tsx`) must survive a dead speaker.

/** `unackedAlarms` = alarm-urgency alerts the reserved strip is currently
 * showing. The siren follows the strip exactly: starts when a red appears,
 * stops the moment it's ACKed or clears. `soundRequested` = how many of
 * those ask to sound THEMSELVES (a SignalK notification whose method says
 * `sound` — the anchor alarm); they sound even with the device opt-in off. */
export function shouldSound(opts: {
  enabled: boolean;
  unackedAlarms: number;
  soundRequested?: number;
}): boolean {
  return (opts.enabled && opts.unackedAlarms > 0) || (opts.soundRequested ?? 0) > 0;
}

/** The tone + haptic mechanics, isolated so the controller is testable. */
export interface SirenSink {
  /** One audible pulse and one haptic buzz — the harsh siren sweep when
   * `critical` (MOB, collision, anchor), else the plain beep. MUST NOT throw. */
  pulse(critical?: boolean): void;
  /** Silence any tail and drop resources. MUST NOT throw. */
  stop(): void;
}

/** Injected timers, so a test can fire the repeat by hand instead of waiting. */
export interface SirenTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clear: (id: ReturnType<typeof setInterval>) => void;
}

const REAL_TIMERS: SirenTimers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (id) => clearInterval(id),
};

/** How often the tone re-pulses while an alarm is up. Insistent, not a machine-gun. */
export const SIREN_INTERVAL_MS = 1_500;
/** The critical siren's repeat: its pulse is a ~0.7 s double sweep, so this
 * leaves almost no gap — a continuous yelp, like a real siren. */
export const CRITICAL_INTERVAL_MS = 800;

export interface Siren {
  /** Turn the siren on or off, and pick the plain beep or the critical
   * siren. Idempotent — calling it with the values it already has does
   * nothing, so the caller can drive it straight from a reactive effect.
   * Switching sound while active re-pulses at once in the new one. */
  set(active: boolean, critical?: boolean): void;
  /** Tear down — stop the tone and clear the timer. For `onCleanup`. */
  dispose(): void;
}

/**
 * A siren that pulses `sink` immediately when it goes active and then every
 * `intervalMs` until it goes inactive. The immediate first pulse matters: an
 * alarm must be heard the instant it fires, not one interval later.
 */
export function createSiren(
  sink: SirenSink,
  opts: { intervalMs?: number; criticalIntervalMs?: number; timers?: SirenTimers } = {},
): Siren {
  const intervalMs = opts.intervalMs ?? SIREN_INTERVAL_MS;
  const criticalIntervalMs = opts.criticalIntervalMs ?? CRITICAL_INTERVAL_MS;
  const timers = opts.timers ?? REAL_TIMERS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let mode = false; // critical?

  const stop = () => {
    if (timer !== undefined) {
      timers.clear(timer);
      timer = undefined;
    }
    sink.stop();
  };

  return {
    set(active, critical = false) {
      if (active) {
        if (timer !== undefined) {
          if (critical === mode) return; // already sounding this way
          timers.clear(timer); // switch sound: restart in the new one
          timer = undefined;
        }
        mode = critical;
        sink.pulse(critical); // heard now, not one interval from now
        timer = timers.set(() => sink.pulse(critical), critical ? criticalIntervalMs : intervalMs);
      } else {
        // Idempotent when already silent: without this guard a cold,
        // never-sounding siren fires a phantom vibrate burst on page load
        // (#RT-HAPTIC) from a reactive effect's `set(false)`.
        if (timer === undefined) return;
        stop();
      }
    },
    dispose: stop,
  };
}

/** The real browser sink. WebAudio starts SUSPENDED until a user gesture, so
 * a one-time capture listener on first pointer/key/touch primes it; a
 * gesture-less beep is skipped, but vibration still fires. */
export function createBrowserSink(): SirenSink {
  type Ctor = typeof AudioContext;
  const getCtor = (): Ctor | undefined => {
    if (typeof window === "undefined") return undefined;
    const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    return w.AudioContext ?? w.webkitAudioContext;
  };

  let ctx: AudioContext | undefined;
  const ensureCtx = (): AudioContext | undefined => {
    if (ctx) return ctx;
    const Ctor = getCtor();
    if (!Ctor) return undefined;
    try {
      ctx = new Ctor();
    } catch {
      ctx = undefined;
    }
    return ctx;
  };

  // Prime on the first user gesture — the WebAudio unlock. `once`, and capture
  // so it fires even if something stops propagation. Guarded for non-DOM envs.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const unlock = () => {
      const c = ensureCtx();
      void c?.resume?.().catch(() => {});
    };
    for (const ev of ["pointerdown", "keydown", "touchstart"] as const) {
      try {
        window.addEventListener(ev, unlock, { once: true, capture: true });
      } catch {
        /* addEventListener options unsupported — non-fatal */
      }
    }
  }

  const beep = () => {
    const c = ensureCtx();
    if (!c) return;
    try {
      // Resume best-effort — no-op if already running, and if it stays suspended
      // (no gesture yet) the scheduled tone is inaudible rather than an error.
      void c.resume?.().catch(() => {});
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "square";
      osc.frequency.value = 880; // a plain, cutting A5 — an alarm, not a chime
      const t = c.currentTime;
      // A short envelope so repeated pulses read as a beep-beep, not a drone.
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.26);
    } catch {
      /* audio unavailable — the visual alarm still stands */
    }
  };

  // The critical siren: a loud sawtooth swept up 650 → 1700 Hz twice (a
  // "yelp"), the sound of an emergency vehicle rather than an appliance.
  // Rough and rising on purpose — hard to sleep through, impossible to
  // mistake for the depth beep.
  const yelp = () => {
    const c = ensureCtx();
    if (!c) return;
    try {
      void c.resume?.().catch(() => {});
      const t = c.currentTime;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
      gain.gain.setValueAtTime(0.5, t + 0.68);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.72);
      gain.connect(c.destination);
      // Two detuned sawtooths beat against each other — harsher than one.
      for (const detune of [0, 18]) {
        const osc = c.createOscillator();
        osc.type = "sawtooth";
        osc.detune.value = detune;
        for (const start of [0, 0.36]) {
          osc.frequency.setValueAtTime(650, t + start);
          osc.frequency.exponentialRampToValueAtTime(1700, t + start + 0.34);
        }
        osc.connect(gain);
        osc.start(t);
        osc.stop(t + 0.73);
      }
    } catch {
      /* audio unavailable — the visual alarm still stands */
    }
  };

  const buzz = (critical: boolean) => {
    try {
      const nav =
        typeof navigator !== "undefined"
          ? (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean })
          : undefined;
      nav?.vibrate?.(critical ? [700] : [200, 100, 200]);
    } catch {
      /* vibration unsupported — non-fatal */
    }
  };

  return {
    pulse(critical = false) {
      if (critical) yelp();
      else beep();
      buzz(critical);
    },
    stop() {
      try {
        const nav =
          typeof navigator !== "undefined"
            ? (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean })
            : undefined;
        nav?.vibrate?.(0); // cancel any in-flight pattern
      } catch {
        /* non-fatal */
      }
      // The oscillators are one-shot (`osc.stop`), so there is no tone to kill;
      // the AudioContext is left alive so the next alarm reuses the primed one.
    },
  };
}
