// The `/api/marks` wire. Throws the backend's `detail`, so a panel can show it.

import { fetchJsonDefault, type FetchJson } from "../../core/settings/apiFetch";
import type { Mark, MarkBody, MarkList } from "./model";

const BASE = "/api/marks";

export interface MarksApi {
  list: () => Promise<MarkList>;
  /** `existing`: an edit, refused (404) if the mark was deleted meanwhile —
   * never re-created. */
  save: (id: string, body: MarkBody, existing?: boolean) => Promise<Mark>;
  remove: (id: string) => Promise<void>;
}

export function createMarksApi(fetchJson: FetchJson = fetchJsonDefault): MarksApi {
  return {
    list: () => fetchJson<MarkList>(BASE),
    save: (id, body, existing) =>
      fetchJson<Mark>(`${BASE}/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(existing ? { "If-Match": "*" } : {}) },
        body: JSON.stringify(body),
      }),
    // 204 has no body: fetchJsonDefault's `.json()` failure is swallowed to null.
    remove: (id) => fetchJson<void>(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };
}
