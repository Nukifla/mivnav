// Commanding the MOB over `/api/mob` (backend `mivnav.features.mob`). The
// live state rides the SignalK stream (`signalk.mob()`); these answers only
// bridge the beat before it lands, and a server with SignalK off (no stream
// to ride — `get` is polled then).

import type { components } from "../../api.generated";
import type { MobMark } from "../../core/signalk";

type RaiseBody = components["schemas"]["MobRaiseBody"];
type AckBody = components["schemas"]["MobAckBody"];

export type MobFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type MobOutcome = { ok: true } | { ok: false; message: string };

export interface MobClient {
  /** Raise at `at` (what this screen shows), else the server's own fix.
   * Resolves the stored mark — the FIRST one if a MOB was already up. */
  raise(at?: { lat: number; lng: number }): Promise<MobMark | null>;
  clear(): Promise<boolean>;
  navigate(): Promise<MobOutcome>;
  ack(id: string): Promise<MobOutcome>;
  get(): Promise<MobMark | null | undefined>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function message(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    /* not JSON */
  }
  return fallback;
}

export function createMobClient(fetchImpl: MobFetch = (i, init) => fetch(i, init)): MobClient {
  const call = async (method: string, path: string, body?: unknown): Promise<Response | null> => {
    try {
      return await fetchImpl(`/api/mob${path}`, {
        method,
        headers: body === undefined ? undefined : JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return null;
    }
  };
  const outcome = async (res: Response | null, fallback: string): Promise<MobOutcome> => {
    if (!res) return { ok: false, message: "Could not reach the mivnav server." };
    return res.ok ? { ok: true } : { ok: false, message: await message(res, fallback) };
  };
  return {
    async raise(at) {
      const body: RaiseBody = at ? { lat: at.lat, lng: at.lng } : {};
      const res = await call("POST", "", body);
      if (!res?.ok) return null;
      return ((await res.json()) as { active: MobMark }).active;
    },
    async clear() {
      const res = await call("DELETE", "");
      return !!res?.ok;
    },
    async navigate() {
      return outcome(await call("POST", "/navigate"), "SignalK did not take the course.");
    },
    async ack(id) {
      const body: AckBody = { id };
      return outcome(await call("POST", "/ack", body), "SignalK refused the acknowledgement.");
    },
    async get() {
      const res = await call("GET", "");
      if (!res?.ok) return undefined;
      return ((await res.json()) as { active: MobMark | null }).active;
    },
  };
}
