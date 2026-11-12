// The RouteIQ device access-request flow, client side — obtaining the
// signalk-routeiq plugin's own write token.
//
// `signalkAccess.ts`'s exact twin, pointed at the routing feature's own
// endpoints (backend/mivnav/features/routing/routes.py) instead of
// /api/signalk's: RouteIQ is a plugin on the SAME SignalK box, but its own
// access-request grant is a SEPARATE credential (RouteIQCredentials, not
// SignalKCredentials) — independently revocable in the SignalK admin, its
// own client id. The handshake mechanics (POST to start, GET to poll,
// PENDING -> COMPLETED) are identical, which is why this reuses
// `createSignalKAccess`'s own state machine (signalkAccess.ts) rather than
// duplicating it — only the two fetch functions below differ.

import type { AccessRequestPoll, AccessRequestStarted } from "./signalkAccess";

const BASE = "/api/routing/routeiq/access-request";

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  return body && typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
}

/** POST /api/routing/routeiq/access-request — initiate. Rejects with the
 * backend's own message (409 SignalK not configured, 502 the box did not
 * answer). */
export async function startRouteIQAccessRequest(): Promise<AccessRequestStarted> {
  const res = await fetch(BASE, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AccessRequestStarted;
}

/** GET /api/routing/routeiq/access-request/{id} — poll once. On approval
 * the backend has already stored the token; this only reports it. */
export async function pollRouteIQAccessRequest(requestId: string): Promise<AccessRequestPoll> {
  const res = await fetch(`${BASE}/${encodeURIComponent(requestId)}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AccessRequestPoll;
}
