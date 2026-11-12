// The ONE fetch/parse/throw helper for boat-side list/CRUD settings sections
// (qrorqztt: consolidated four copy-pasted copies). Keep in sync with
// `mivnav`'s FastAPI error shape (`{"detail": "..."}`).

/** The JSON fetch seam every settings section takes as an optional dependency,
 * so a test can stub the network without touching `global.fetch`. */
export type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

/** Parses the body as JSON regardless of status, and turns a non-2xx into a
 * thrown `Error` carrying the backend's `detail`, else `HTTP <status>`. */
export const fetchJsonDefault: FetchJson = async <T>(
  url: string,
  init?: RequestInit,
): Promise<T> => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body as T;
};
