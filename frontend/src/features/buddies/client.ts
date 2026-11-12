// The `/api/buddies` wire. Throws the backend's `detail`, so the form can show it.

import { fetchJsonDefault, type FetchJson } from "../../core/settings/apiFetch";
import type { Buddy, BuddyList } from "./model";

const BASE = "/api/buddies";
const JSON_HEADERS = { "Content-Type": "application/json" };

export interface BuddiesApi {
  list: () => Promise<BuddyList>;
  add: (mmsi: string, nickname?: string) => Promise<Buddy>;
  edit: (id: string, nickname?: string, note?: string) => Promise<Buddy>;
  remove: (id: string) => Promise<void>;
}

export function createBuddiesApi(fetchJson: FetchJson = fetchJsonDefault): BuddiesApi {
  return {
    list: () => fetchJson<BuddyList>(BASE),
    add: (mmsi, nickname) =>
      fetchJson<Buddy>(BASE, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ mmsi, nickname }),
      }),
    edit: (id, nickname, note) =>
      fetchJson<Buddy>(`${BASE}/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ nickname, note }),
      }),
    remove: (id) => fetchJson<void>(`${BASE}/${id}`, { method: "DELETE" }),
  };
}
