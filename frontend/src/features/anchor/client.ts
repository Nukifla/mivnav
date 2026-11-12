// Commanding the anchor watch over `/api/anchor` (backend
// `mivnav.features.anchor`), plus the one feedback line the controls show.
// State is never read from here — it rides the SignalK stream
// (`signalk.anchor()`); a command's success shows up there a beat later.

import { createSignal, type Accessor } from "solid-js";
import type { components } from "../../api.generated";

type DropBody = components["schemas"]["DropBody"];
type RadiusBody = components["schemas"]["RadiusBody"];
type MoveBody = components["schemas"]["MoveBody"];
type AckBody = components["schemas"]["AckBody"];

export type AnchorFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Kept distinct like the autopilot's: 502 "did not happen" must not read
 * like 409 "the plugin said no". `message` is shown verbatim. */
export type AnchorOutcome =
  | { status: "ok" }
  | { status: "unreachable"; message: string } // 502
  | { status: "unavailable"; message: string } // 503 — our config: SignalK/plugin/token
  | { status: "refused"; message: string } // 409/4xx — the plugin's own words
  | { status: "error"; message: string };

export type AnchorFeedback = { label: string } & (
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: Exclude<AnchorOutcome["status"], "ok">; message: string }
);

/** `[lng, lat, timeMs]`, oldest first — the plugin's minute-by-minute track. */
export type TrackFix = [number, number, number];

export interface AnchorController {
  /** No radius = mark the anchor, alarm off until {@link setRadius} arms it. */
  drop(radiusM?: number): Promise<AnchorOutcome>;
  radiusFromHere(): Promise<AnchorOutcome>;
  setRadius(radiusM: number): Promise<AnchorOutcome>;
  /** `radiusM: null` keeps it unarmed. */
  move(lat: number, lng: number, radiusM: number | null): Promise<AnchorOutcome>;
  raise(): Promise<AnchorOutcome>;
  /** Server-side ACK — quiet on every display (anchor.md Q5). */
  ack(id: string): Promise<AnchorOutcome>;
  track(): Promise<TrackFix[]>;
  feedback: Accessor<AnchorFeedback | null>;
}

const DEFAULTS = {
  unreachable: "The SignalK server did not answer — the command did not happen.",
  unavailable: "Cannot command the anchor alarm from this server.",
  refused: "The anchor alarm refused.",
  error: "Could not reach the mivnav server.",
} as const;

function classify(status: number): AnchorOutcome["status"] {
  if (status >= 200 && status < 300) return "ok";
  if (status === 502) return "unreachable";
  if (status === 503) return "unavailable";
  if (status >= 400 && status < 500) return "refused";
  return "error";
}

async function detail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : undefined;
  } catch {
    return undefined;
  }
}

export function createAnchorController(
  opts: { fetch?: AnchorFetch; base?: string; clearAfterMs?: number } = {},
): AnchorController {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.base ?? "/api/anchor";
  const clearAfterMs = opts.clearAfterMs ?? 4_000;
  const [feedback, setFeedback] = createSignal<AnchorFeedback | null>(null);
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  const send = async (
    label: string,
    method: string,
    path: string,
    body?: DropBody | RadiusBody | MoveBody | AckBody,
  ): Promise<AnchorOutcome> => {
    clearTimeout(clearTimer);
    setFeedback({ label, kind: "pending" });
    let outcome: AnchorOutcome;
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const kind = classify(res.status);
      outcome = kind === "ok" ? { status: "ok" } : { status: kind, message: (await detail(res)) ?? DEFAULTS[kind] };
    } catch {
      outcome = { status: "error", message: DEFAULTS.error };
    }
    setFeedback(
      outcome.status === "ok" ? { label, kind: "ok" } : { label, kind: outcome.status, message: outcome.message },
    );
    // A success fades; a failure stays until the next command — "did my
    // raise take?" must not be answered by a line that vanished.
    if (outcome.status === "ok") clearTimer = setTimeout(() => setFeedback(null), clearAfterMs);
    return outcome;
  };

  return {
    drop: (radiusM) => send("Drop anchor", "POST", "/drop", radiusM === undefined ? {} : { radiusM }),
    radiusFromHere: () => send("Set radius from here", "POST", "/radius", {}),
    setRadius: (radiusM) => send(`Alarm at ${radiusM} m`, "POST", "/radius", { radiusM }),
    move: (lat, lng, radiusM) => send("Move anchor", "PUT", "/position", { lat, lng, radiusM }),
    raise: () => send("Raise anchor", "POST", "/raise"),
    ack: (id) => send("Acknowledge", "POST", "/ack", { id }),
    track: async () => {
      try {
        const res = await doFetch(`${base}/track`, { method: "GET" });
        if (!res.ok) return [];
        const body = (await res.json()) as { fixes?: unknown };
        return Array.isArray(body.fixes) ? (body.fixes as TrackFix[]) : [];
      } catch {
        return [];
      }
    },
    feedback,
  };
}
