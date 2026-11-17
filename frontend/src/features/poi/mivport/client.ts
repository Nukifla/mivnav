// The boat's mivport write side (docs/architecture/mivport-editing.md): the
// account, the registry, the outbox and the local overlay, all under the
// app's `/api`. Screens never talk to mivport itself — the boat server holds
// the token and uploads the queued writes. Throws the backend's `detail`, so
// a panel can show it.

import { fetchJsonDefault, type FetchJson } from "../../../core/settings/apiFetch";
import type {
  MivportAccount,
  MivportDeviceStart,
  MivportEditRequest,
  MivportEditResult,
  MivportHistory,
  MivportItemResult,
  MivportLocalLayer,
  MivportOutbox,
  MivportPhotoResult,
  MivportRegistry,
  MivportRemovalRequest,
  MivportReviewBody,
} from "./types";

const BASE = "/api/mivport";

/** The two JPEGs (photo.ts) and what goes with them. */
export interface MivportPhotoUpload {
  view: Blob;
  thumb: Blob;
  caption?: string;
  /** RFC 3339. */
  taken_at?: string;
  lat?: number;
  lon?: number;
}

export interface MivportApi {
  account: () => Promise<MivportAccount>;
  login: (username: string, password: string) => Promise<MivportAccount>;
  register: (username: string, password: string, email?: string) => Promise<MivportAccount>;
  deviceLogin: () => Promise<MivportDeviceStart>;
  logout: () => Promise<MivportAccount>;
  registry: () => Promise<MivportRegistry>;
  edit: (req: MivportEditRequest) => Promise<MivportEditResult>;
  review: (placeId: string, body: MivportReviewBody) => Promise<MivportItemResult>;
  deleteReview: (reviewId: string) => Promise<MivportItemResult>;
  uploadPhoto: (placeId: string, photo: MivportPhotoUpload) => Promise<MivportPhotoResult>;
  deletePhoto: (photoId: string) => Promise<MivportItemResult>;
  requestRemoval: (req: MivportRemovalRequest) => Promise<MivportItemResult>;
  outbox: () => Promise<MivportOutbox>;
  discard: (itemId: string) => Promise<void>;
  sync: () => Promise<MivportAccount>;
  local: () => Promise<MivportLocalLayer>;
  history: (placeId: string) => Promise<MivportHistory>;
}

const enc = encodeURIComponent;

const json = (method: string, body?: unknown): RequestInit =>
  body === undefined
    ? { method }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };

/** The multipart body of a photo upload. */
export function photoForm(photo: MivportPhotoUpload): FormData {
  const fd = new FormData();
  fd.append("view", photo.view, "view.jpg");
  fd.append("thumb", photo.thumb, "thumb.jpg");
  if (photo.caption?.trim()) fd.append("caption", photo.caption.trim());
  if (photo.taken_at) fd.append("taken_at", photo.taken_at);
  if (photo.lat !== undefined && photo.lon !== undefined) {
    fd.append("lat", String(photo.lat));
    fd.append("lon", String(photo.lon));
  }
  return fd;
}

export function createMivportApi(fetchJson: FetchJson = fetchJsonDefault): MivportApi {
  return {
    account: () => fetchJson(`${BASE}/account`),
    login: (username, password) => fetchJson(`${BASE}/account/login`, json("POST", { username, password })),
    register: (username, password, email) =>
      fetchJson(
        `${BASE}/account/register`,
        json("POST", email?.trim() ? { username, password, email: email.trim() } : { username, password }),
      ),
    deviceLogin: () => fetchJson(`${BASE}/account/device`, json("POST")),
    logout: () => fetchJson(`${BASE}/account/logout`, json("POST")),
    registry: () => fetchJson(`${BASE}/registry`),
    edit: (req) => fetchJson(`${BASE}/edits`, json("POST", req)),
    review: (placeId, body) => fetchJson(`${BASE}/places/${enc(placeId)}/review`, json("PUT", body)),
    deleteReview: (id) => fetchJson(`${BASE}/reviews/${enc(id)}`, json("DELETE")),
    uploadPhoto: (placeId, photo) =>
      fetchJson(`${BASE}/places/${enc(placeId)}/photos`, { method: "POST", body: photoForm(photo) }),
    deletePhoto: (id) => fetchJson(`${BASE}/photos/${enc(id)}`, json("DELETE")),
    requestRemoval: (req) => fetchJson(`${BASE}/removal-requests`, json("POST", req)),
    outbox: () => fetchJson(`${BASE}/outbox`),
    discard: (id) => fetchJson(`${BASE}/outbox/${enc(id)}`, json("DELETE")),
    sync: () => fetchJson(`${BASE}/sync`, json("POST")),
    local: () => fetchJson(`/api/poi/mivport/local`),
    history: (placeId) => fetchJson(`${BASE}/places/${enc(placeId)}/history`),
  };
}
