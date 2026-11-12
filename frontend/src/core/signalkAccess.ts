// The SignalK access-request flow, client side. The backend owns the token
// secret end to end; this controller only learns whether access was
// granted. See docs/architecture/signalk-access-request.md.

import { createSignal, onCleanup, type Accessor } from "solid-js";

const BASE = "/api/signalk/access-request";

/** The backend's answer to "start a request": a PENDING state and the id to
 * poll. */
export interface AccessRequestStarted {
  state: string;
  requestId: string;
}

/** The backend's answer to a poll. `approved` is only present once
 * `state === "COMPLETED"`. */
export interface AccessRequestPoll {
  state: string;
  approved?: boolean;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  return body && typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
}

/** POST /api/signalk/access-request — initiate. Rejects with the backend's
 * own message (409 SignalK not configured, 502 the box did not answer). */
export async function startAccessRequest(): Promise<AccessRequestStarted> {
  const res = await fetch(BASE, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AccessRequestStarted;
}

/** GET /api/signalk/access-request/{id} — poll once. On approval the backend
 * has already stored the token; this only reports it. */
export async function pollAccessRequest(requestId: string): Promise<AccessRequestPoll> {
  const res = await fetch(`${BASE}/${encodeURIComponent(requestId)}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AccessRequestPoll;
}

/** Where the flow is right now. `pending` is the interesting one — the
 * button has been pressed and we are waiting on a human at the SignalK admin. */
export type AccessPhase = "idle" | "pending" | "granted" | "denied" | "error";

export interface AccessController {
  phase: Accessor<AccessPhase>;
  /** A human-readable line for the current phase (instructions while pending,
   * the reason on error). */
  message: Accessor<string>;
  /** The request has been sent and we are polling. Disables the button. */
  busy: Accessor<boolean>;
  /** Begin (or restart) the handshake. Never rejects. */
  start: () => Promise<void>;
}

export interface AccessOptions {
  /** Seams the test drives; default to the real fetch wrappers. */
  request?: () => Promise<AccessRequestStarted>;
  poll?: (requestId: string) => Promise<AccessRequestPoll>;
  /** Sleep between polls. Injected so a test need not wait real seconds. */
  wait?: (ms: number) => Promise<void>;
  /** Called once when access is granted — the section refreshes the config so
   * `meta.signalk_token_set` flips to true. */
  onGranted?: () => void;
  /** Poll cadence and how long to keep trying before giving up. */
  intervalMs?: number;
  timeoutMs?: number;
  /** The message shown on `granted` — defaults to the autopilot's own wording
   * (this controller's first caller), since most existing call sites rely on
   * the default. A caller granting a DIFFERENT capability (RouteIQ's own
   * access, say — `routeiqAccess.ts`) must override this: the default text
   * names the autopilot specifically and would misdescribe what was actually
   * granted. */
  grantedMessage?: string;
}

const APPROVE_HINT =
  "Approve this request in the SignalK admin: Security → Access Requests.";

const DEFAULT_GRANTED_MESSAGE = "Write access granted. The autopilot can now be commanded.";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The access-request handshake as a small state machine, testable without a
 * DOM. One request at a time (`start` while pending is ignored); a
 * `generation` counter fences a stale poll loop after unmount. */
export function createSignalKAccess(options: AccessOptions = {}): AccessController {
  const request = options.request ?? startAccessRequest;
  const poll = options.poll ?? pollAccessRequest;
  const wait = options.wait ?? sleep;
  const intervalMs = options.intervalMs ?? 2500;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const grantedMessage = options.grantedMessage ?? DEFAULT_GRANTED_MESSAGE;

  const [phase, setPhase] = createSignal<AccessPhase>("idle");
  const [message, setMessage] = createSignal("");

  let generation = 0;
  onCleanup(() => {
    generation++;
  });

  const busy = () => phase() === "pending";

  const start = async () => {
    if (phase() === "pending") return;
    const gen = ++generation;
    setPhase("pending");
    setMessage(APPROVE_HINT);
    let started: AccessRequestStarted;
    try {
      started = await request();
    } catch (e) {
      if (gen !== generation) return;
      setPhase("error");
      setMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    const deadline = Date.now() + timeoutMs;
    // Loop until a human acts, the box goes away, or we give up waiting.
    for (;;) {
      if (gen !== generation) return;
      let result: AccessRequestPoll;
      try {
        result = await poll(started.requestId);
      } catch (e) {
        if (gen !== generation) return;
        setPhase("error");
        setMessage(e instanceof Error ? e.message : String(e));
        return;
      }
      if (gen !== generation) return;
      if (result.state === "COMPLETED") {
        if (result.approved) {
          setPhase("granted");
          setMessage(grantedMessage);
          options.onGranted?.();
        } else {
          setPhase("denied");
          setMessage("The request was denied in the SignalK admin. Nothing was stored.");
        }
        return;
      }
      if (Date.now() >= deadline) {
        setPhase("error");
        setMessage(
          "Timed out waiting for approval. Approve the request in the SignalK admin, then try again.",
        );
        return;
      }
      await wait(intervalMs);
    }
  };

  return { phase, message, busy, start };
}
