// The autopilot COMMAND client — the write half of the pilot surface.
// signalk.ts is the READ half; kept separate so nothing on the display side
// can accidentally issue a command. The HTTP response code is the safety
// contract (200 ok vs 502 unreachable vs 503 unavailable vs 400/404
// refused) — see docs/architecture/autopilot-command-client.md.

import { createEffect, createSignal, getOwner, onCleanup, type Accessor } from "solid-js";
import type { components } from "../api.generated";
import type { SignalKStatus } from "./signalk";

/** The five command bodies this client PUTs, straight off the OpenAPI schema
 * (`mivnav.api.autopilot`) rather than the previous untyped `Record<string,
 * unknown>` — `StateBody`/`ModeBody` are both `{value: string}` and
 * `TargetBody`/`AdjustBody`/`DodgeBody` are all `{degrees: number}`, so the
 * union collapses to those two shapes, but naming the real schemas keeps
 * this typed against the backend contract rather than a hand-guessed one. */
type AutopilotBody =
  | components["schemas"]["StateBody"]
  | components["schemas"]["ModeBody"]
  | components["schemas"]["TargetBody"]
  | components["schemas"]["AdjustBody"]
  | components["schemas"]["DodgeBody"];

export type Direction = "port" | "starboard";

/** The device's own vocabulary, from `GET /autopilot`.options — passed through
 * untouched (it is the pilot's, not ours). A UI draws its controls from this. */
export interface ApOptions {
  states?: { name: string; engaged?: boolean }[];
  modes?: string[];
  actions?: { id: string; name: string; available?: boolean }[];
}

/** `GET /autopilot` — the once-per-session capability call. The state fields
 * are a convenience; a UI watches the stream for those and reads `options`
 * from here (the stream cannot carry it). */
export interface ApInfo {
  pilot?: string;
  state?: string;
  mode?: string;
  engaged?: boolean;
  targetDeg?: number;
  options?: ApOptions;
}

/** The four honest ends of a command, kept DISTINCT on purpose — see the file
 * header. `message` on the failures is shown to the helmsman verbatim. */
export type ApOutcome =
  | { status: "ok" }
  | { status: "unreachable"; message: string } // 502 — did not happen
  | { status: "unavailable"; message: string } // 503 — server cannot command
  | { status: "refused"; message: string } // 400/404 — pilot said no, its words
  | { status: "error"; message: string }; // network / unexpected

export type ApInfoResult =
  | { status: "ok"; info: ApInfo }
  | Exclude<ApOutcome, { status: "ok" }>;

/** Honest defaults, used only when the backend sent no `detail`. Each one is
 * still true about *whose* problem it is; none pretends success. */
const DEFAULTS: Record<Exclude<ApOutcome["status"], "ok">, string> = {
  unreachable: "The pilot did not answer — the command DID NOT happen.",
  unavailable: "This server cannot command the pilot (SignalK off, or no token).",
  refused: "The pilot refused the command.",
  error: "Could not reach the server.",
};

/**
 * Map an HTTP status onto the outcome kind. Pure and exported so the mapping —
 * the actual safety contract — is unit-tested directly, not through a socket.
 */
export function classifyStatus(httpStatus: number): ApOutcome["status"] {
  if (httpStatus >= 200 && httpStatus < 300) return "ok";
  if (httpStatus === 502) return "unreachable";
  if (httpStatus === 503) return "unavailable";
  if (httpStatus === 400 || httpStatus === 404) return "refused";
  return "error";
}

/** FastAPI puts the human message in `{detail}`; pull it if it is a string. */
async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") return detail;
    }
  } catch {
    /* non-JSON body — fall back to the default message */
  }
  return undefined;
}

async function outcomeFor(res: Response): Promise<ApOutcome> {
  const kind = classifyStatus(res.status);
  if (kind === "ok") return { status: "ok" };
  return { status: kind, message: (await readDetail(res)) ?? DEFAULTS[kind] };
}

export type AutopilotFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AutopilotClient {
  info(): Promise<ApInfoResult>;
  engage(): Promise<ApOutcome>;
  disengage(): Promise<ApOutcome>;
  setState(value: string): Promise<ApOutcome>;
  setMode(value: string): Promise<ApOutcome>;
  setTarget(degrees: number): Promise<ApOutcome>;
  adjustTarget(degrees: number): Promise<ApOutcome>;
  tack(dir: Direction): Promise<ApOutcome>;
  gybe(dir: Direction): Promise<ApOutcome>;
  startDodge(): Promise<ApOutcome>;
  stopDodge(): Promise<ApOutcome>;
  dodge(degrees: number): Promise<ApOutcome>;
}

/**
 * A thin wrapper over `/api/autopilot`. Same-origin by construction (the
 * backend and the page are one host; vite proxies /api in dev), so there is
 * nothing to configure. `fetch` is injected as the seam a test drives.
 */
export function createAutopilotClient(
  opts: { fetch?: AutopilotFetch; base?: string } = {},
): AutopilotClient {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.base ?? "/api/autopilot";

  const run = async (method: string, path: string, body?: AutopilotBody): Promise<ApOutcome> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        ...(body !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
    } catch {
      // Never reached the server at all — the command certainly did not happen.
      return { status: "error", message: DEFAULTS.error };
    }
    return outcomeFor(res);
  };

  const info = async (): Promise<ApInfoResult> => {
    let res: Response;
    try {
      res = await doFetch(base, { method: "GET" });
    } catch {
      return { status: "error", message: DEFAULTS.error };
    }
    const kind = classifyStatus(res.status);
    if (kind !== "ok") {
      return { status: kind, message: (await readDetail(res)) ?? DEFAULTS[kind] };
    }
    let parsed: ApInfo = {};
    try {
      parsed = (await res.json()) as ApInfo;
    } catch {
      /* empty body — an info with no options, which the caller tolerates */
    }
    return { status: "ok", info: parsed };
  };

  return {
    info,
    engage: () => run("POST", "/engage"),
    disengage: () => run("POST", "/disengage"),
    setState: (value) => run("PUT", "/state", { value }),
    setMode: (value) => run("PUT", "/mode", { value }),
    setTarget: (degrees) => run("PUT", "/target", { degrees }),
    adjustTarget: (degrees) => run("PUT", "/target/adjust", { degrees }),
    tack: (dir) => run("POST", `/tack/${dir}`),
    gybe: (dir) => run("POST", `/gybe/${dir}`),
    startDodge: () => run("POST", "/dodge"),
    stopDodge: () => run("DELETE", "/dodge"),
    dodge: (degrees) => run("PUT", "/dodge", { degrees }),
  };
}

// Hold-to-engage: deliberate friction on the ONE path that takes the boat
// away from you (600ms hold, release-before-fire sends nothing). See
// docs/architecture/autopilot-command-client.md.

export interface HoldToFire {
  /** 0…1, drives the fill. */
  progress: Accessor<number>;
  holding: Accessor<boolean>;
  /** Press: begin the hold. */
  start: () => void;
  /** Release: abort if not yet fired — sends nothing. */
  cancel: () => void;
  /** Tear down any pending timer/frame. */
  dispose: () => void;
}

export function createHoldToFire(opts: {
  onFire: () => void;
  durationMs?: number;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  raf?: (cb: () => void) => number;
  cancelRaf?: (id: number) => void;
}): HoldToFire {
  const duration = opts.durationMs ?? 600;
  const now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));
  const raf =
    opts.raf ?? (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : undefined);
  const cancelRaf =
    opts.cancelRaf ?? (typeof cancelAnimationFrame !== "undefined" ? cancelAnimationFrame : undefined);

  const [progress, setProgress] = createSignal(0);
  const [holding, setHolding] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  let t0 = 0;

  const stopFrame = () => {
    if (frame !== null && cancelRaf) cancelRaf(frame);
    frame = null;
  };
  const tick = () => {
    const p = Math.min(1, (now() - t0) / duration);
    setProgress(p);
    if (p < 1 && raf) frame = raf(tick);
  };
  const reset = () => {
    stopFrame();
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    setProgress(0);
    setHolding(false);
  };

  const start = () => {
    if (holding()) return;
    setHolding(true);
    t0 = now();
    setProgress(0);
    // Single timer fires at `duration` of unbroken hold; the rAF loop is only
    // the visual fill and isn't required for the fire itself.
    timer = setTimer(() => {
      timer = null;
      stopFrame();
      setProgress(1);
      setHolding(false);
      opts.onFire();
    }, duration);
    if (raf) frame = raf(tick);
  };
  const cancel = () => {
    if (!holding()) return;
    reset();
  };

  return { progress, holding, start, cancel, dispose: reset };
}

// The controller: one object the rail tile's disengage and the board card's
// full control set share, owning device `options` and last-command
// `feedback`. See docs/architecture/autopilot-command-client.md.

/** Feedback kinds mirror the outcome, plus "pending" for a command in flight. */
export type ApFeedbackKind = "pending" | ApOutcome["status"];

export interface ApFeedback {
  /** What was pressed — "Disengage", "Engage", "+10°", "Tack port", "Mode wind". */
  label: string;
  kind: ApFeedbackKind;
  message?: string;
}

export interface AutopilotController {
  options: Accessor<ApOptions | null>;
  feedback: Accessor<ApFeedback | null>;
  clearFeedback: () => void;
  refreshInfo: () => Promise<void>;
  engage: () => Promise<ApOutcome>;
  disengage: () => Promise<ApOutcome>;
  adjust: (degrees: number) => Promise<ApOutcome>;
  setMode: (mode: string) => Promise<ApOutcome>;
  tack: (dir: Direction) => Promise<ApOutcome>;
  gybe: (dir: Direction) => Promise<ApOutcome>;
}

export function createAutopilotController(
  opts: {
    client?: AutopilotClient;
    status?: Accessor<SignalKStatus>;
    /**
     * The current CONFIRMED target from the SignalK autopilot snapshot
     * (`autopilot().targetDeg`). It is the base a first press accumulates
     * from, and the value the local `intended` target reconciles against once
     * the device echoes back. Absent → the adjust path has nothing to base an
     * absolute PUT on (the UI only enables adjust while engaged, where a
     * target exists).
     */
    target?: Accessor<number | undefined>;
    /**
     * Whether the pilot is in a WIND mode. Then `targetDeg` and the ±° adjust
     * mean a signed WIND ANGLE, not a compass bearing, so it wraps in a
     * different domain — see `wrap` below.
     */
    wind?: Accessor<boolean>;
    /**
     * Debounce for the absolute-target send: coalesces a burst of presses into
     * one PUT. Correctness does NOT depend on it — every send carries the full
     * accumulated absolute target, so last-write-wins converges no matter how
     * the sends are spaced or how they race server-side.
     */
    sendDebounceMs?: number;
    setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  } = {},
): AutopilotController {
  const client = opts.client ?? createAutopilotClient();
  const [options, setOptions] = createSignal<ApOptions | null>(null);
  const [feedback, setFeedback] = createSignal<ApFeedback | null>(null);
  const sendDebounceMs = opts.sendDebounceMs ?? 100;
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));

  const refreshInfo = async () => {
    const r = await client.info();
    // A read succeeds with no token (the boat allows anonymous reads), so this
    // populates the mode picker even before commands are configured. On a 503
    // (SignalK off) we simply have no options and the picker stays hidden.
    if (r.status === "ok" && r.info.options) setOptions(r.info.options);
  };

  if (opts.status) {
    createEffect(() => {
      const connected = opts.status!() === "connected";
      // Fetch the capability once the link is up, and again if it drops and
      // returns before we ever got options. Cheap and idempotent.
      if (connected && !options()) void refreshInfo();
      // A dropped link makes the last command's result stale — the surface
      // goes UNKNOWN and its controls inert, so a lingering "Pilot refused"
      // under a NO LINK card would be a lie about a command that can no longer
      // be retried. Clear it.
      if (!connected) setFeedback(null);
    });
  } else {
    void refreshInfo();
  }

  const command = async (label: string, exec: () => Promise<ApOutcome>): Promise<ApOutcome> => {
    setFeedback({ label, kind: "pending" });
    let outcome: ApOutcome;
    try {
      outcome = await exec();
    } catch {
      outcome = { status: "error", message: DEFAULTS.error };
    }
    setFeedback({
      label,
      kind: outcome.status,
      message: "message" in outcome ? outcome.message : undefined,
    });
    return outcome;
  };

  // Absolute-target adjust, not relative: `/target/adjust` PUTs race on the
  // pilot side, so consecutive taps can be LOST. We accumulate an ABSOLUTE
  // `intended` target locally instead. See docs/architecture/autopilot-command-client.md.

  const isWindNow = () => !!opts.wind?.();
  // Compass wraps in [0,360); wind is signed, [-180,180) — pypilot's own
  // convention, only its domain (not sign) knowable from here.
  const wrap = (deg: number): number =>
    isWindNow() ? ((((deg + 180) % 360) + 360) % 360) - 180 : (((deg % 360) + 360) % 360);
  // Shortest angular distance — tells us the confirmed target caught up to `intended`.
  const angDist = (a: number, b: number): number =>
    Math.abs(((((a - b) % 360) + 540) % 360) - 180);
  const RECONCILE_DEG = 0.5;

  const fmtTarget = (deg: number): string =>
    isWindNow()
      ? `${Math.round(deg) > 0 ? "+" : ""}${Math.round(deg)}°`
      : `${((Math.round(deg) % 360) + 360) % 360}°`;
  const targetLabel = (deg: number) => `→ ${fmtTarget(deg)}`;

  // The locally-accumulated absolute target, or null when we hold no override
  // and the confirmed target is the truth.
  let intended: number | null = null;

  // RECONCILE: once the confirmed target catches up to `intended`, drop the
  // local override so the NEXT press re-bases on the real current target (and
  // an externally-changed target is picked up). Also drop a STALE override if
  // the target vanishes — the AP disengaged, or targetDeg went null.
  if (opts.target) {
    createEffect(() => {
      const confirmed = opts.target!();
      if (intended === null) return;
      if (confirmed === undefined || !Number.isFinite(confirmed)) {
        intended = null;
        return;
      }
      if (angDist(confirmed, intended) <= RECONCILE_DEG) intended = null;
    });
  }

  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let sendResolve: ((o: ApOutcome) => void) | null = null;
  let sendPromise: Promise<ApOutcome> | null = null;

  const flushSend = () => {
    sendTimer = null;
    const value = intended;
    const resolve = sendResolve;
    sendResolve = null;
    sendPromise = null;
    if (value === null) {
      resolve?.({ status: "ok" });
      return;
    }
    void command(targetLabel(value), () => client.setTarget(value)).then((o) => resolve?.(o));
  };

  const adjust = (degrees: number): Promise<ApOutcome> => {
    const base = intended ?? opts.target?.();
    if (base === undefined || !Number.isFinite(base)) {
      // No known target to accumulate from — an absolute PUT is impossible.
      // (The UI enables adjust only while engaged, where a target exists; this
      // is the honest fallback if it is somehow pressed without one.)
      const out: ApOutcome = { status: "error", message: "No target to adjust." };
      setFeedback({ label: "Adjust", kind: out.status, message: out.message });
      return Promise.resolve(out);
    }
    intended = wrap(base + degrees);
    // Immediate optimistic feedback on where the target is HEADING (the fully
    // accumulated intended), never the single press.
    setFeedback({ label: targetLabel(intended), kind: "pending" });
    if (sendTimer !== null) clearTimer(sendTimer);
    sendTimer = setTimer(flushSend, sendDebounceMs);
    if (!sendPromise) {
      sendPromise = new Promise<ApOutcome>((res) => {
        sendResolve = res;
      });
    }
    return sendPromise;
  };

  // Don't leak the debounce timer if the surface tears down mid-window.
  if (getOwner()) onCleanup(() => sendTimer !== null && clearTimer(sendTimer));

  return {
    options,
    feedback,
    clearFeedback: () => setFeedback(null),
    refreshInfo,
    engage: () => command("Engage", client.engage),
    disengage: () => command("Disengage", client.disengage),
    adjust,
    setMode: (mode) => command(`Mode ${mode}`, () => client.setMode(mode)),
    tack: (dir) => command(`Tack ${dir}`, () => client.tack(dir)),
    gybe: (dir) => command(`Gybe ${dir}`, () => client.gybe(dir)),
  };
}
