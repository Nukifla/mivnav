// Wire types of the backend's mivport routes: the detail route
// (`GET /api/poi/mivport/details/{set}/{ref}`) and the editing routes under
// `/api/mivport` (docs/architecture/mivport-editing.md). Hand-mirrored: the
// host's generated `api.generated.ts` describes the core API only. Absent fields are
// omitted, never null — but every reader still treats a value as untrusted
// (wrong type, empty string) since the bytes come from user-edited data.

/** One mivport review of a place. */
export interface MivportReview {
  id: string;
  user: string;
  /** 1–5. */
  stars: number;
  body?: string;
  /** `YYYY-MM-DD`, the reviewer's own date. */
  visited_on?: string;
  /** ISO time. */
  created_at?: string;
  /** Written on this boat and not uploaded yet (or failed): the boat's own
   * copy, merged in by the backend's local overlay. */
  local?: MivportLocalState;
}

/** One place photo. `url`/`thumb_url` are relative to the API root when the
 * bake kept the photo on the boat; absolute http(s) when `remote` (only loads
 * while online). */
export interface MivportPhoto {
  id: string;
  url: string;
  thumb_url: string;
  caption?: string;
  /** Who to credit, e.g. "© Anna (CC BY-SA 4.0)". */
  attribution: string;
  license_url?: string;
  taken_at?: string;
  remote?: boolean;
  /** The uploader, when known (own photos can be deleted). */
  user?: string;
  /** Added on this boat, not uploaded yet (or failed). */
  local?: MivportLocalState;
}

/** One place's detail record. */
export interface MivportPlaceDetail {
  /** The mivport place id (uuid, or `osm:n123` / `osm:w123` / `osm:r123`). */
  ref: string;
  /** The mivport kind (`GET /v1/kinds`), not the host's POI kind. */
  kind: string;
  name?: string;
  /** `core`: mivport has its own data for it; `osm`: OpenStreetMap only. */
  source: "core" | "osm";
  /** mivport's own attributes (mivport internal/edit/attrs.go keys). */
  attrs?: Record<string, unknown>;
  /** ISO time each stale-able attr was set (diesel_price, petrol_price). */
  attrs_set_at?: Record<string, string>;
  /** OSM tags read into the same attr keys (mivport `OSMAttrs`). */
  osm_attrs?: Record<string, unknown>;
  /** The raw OSM tags. */
  osm_tags?: Record<string, string>;
  osm?: { type: "node" | "way" | "relation"; id: number };
  updated_at?: string;
  reviews?: MivportReview[];
  photos?: MivportPhoto[];
  /** The data attribution to show with it. */
  attribution: string;
  /** The place in the mivport web client, when the boat knows where that is. */
  web_url?: string;
  /** Epoch seconds of the bake. */
  fetched_at: number;
  /** The stored revision (the `base_rev` of a modify). Absent for a place
   * that exists only on this boat so far, and for an OSM-only place. */
  rev?: number;
  /** This place was changed on the boat: `pending` until uploaded,
   * `synced` once mivport took it (until a newer bake replaces it),
   * `failed` when mivport refused it. Absent = the baked record as-is. */
  local?: MivportLocalState;
  /** The place is deleted (locally, pending upload, or in mivport). */
  deleted?: boolean;
  /** Who created the place in mivport (contributors may delete only their
   * own places). Absent when the boat doesn't know. */
  created_by?: string;
  /** Where the place is (stored with the bake; an edit's starting pin). */
  lat?: number;
  lon?: number;
}

// ---------------------------------------------------------------------------
// Editing (docs/architecture/mivport-editing.md). The backend's `/mivport/*`
// routes — every write answers at once and is queued in the boat's outbox.

/** The state of a locally changed place or item. */
export type MivportLocalState = "pending" | "synced" | "failed";

/** A position as mivport writes it. */
export interface MivportGeom {
  lat: number;
  lon: number;
}

/** The boat-wide mivport account (`GET /mivport/account`). */
export interface MivportAccount {
  /** The mivport server it talks to. */
  server: string;
  logged_in: boolean;
  username?: string | null;
  /** `contributor` < `trusted` < `moderator` < `admin`. */
  role?: string | null;
  /** mivport answered on the last attempt. */
  online: boolean;
  /** A device login waiting for approval on a phone. */
  device?: { user_code: string; verification_url: string; expires_at: number } | null;
  outbox: { pending: number; failed: number };
  /** Epoch seconds of the last sync that reached mivport. */
  last_sync?: number | null;
  last_error?: string | null;
}

/** `POST /mivport/account/device`. */
export interface MivportDeviceStart {
  user_code: string;
  /** Absolute: open it on a phone and approve the code. */
  verification_url: string;
  /** Seconds. */
  expires_in: number;
}

/** One mivport kind (`/v1/kinds`). */
export interface MivportKind {
  name: string;
  /** harbour, anchoring, service, facility, shore, other. */
  group: string;
  label: string;
}

/** An attribute's type (`/v1/attrs`). `currency` is an ISO 4217 code;
 * `photo` the id of one of the place's photos (not edited in the form). */
export type MivportAttrType =
  | "string"
  | "int"
  | "number"
  | "bool"
  | "enum"
  | "enum_list"
  | "wind_grade"
  | "currency"
  | "photo";

/** One attribute a place can have (`/v1/attrs`). `kinds` empty = any kind. */
export interface MivportAttr {
  key: string;
  type: MivportAttrType | string;
  max_len?: number;
  min?: number;
  max?: number;
  values?: string[];
  kinds?: string[];
  /** A wind_grade's directions. */
  sectors?: string[];
}

/** `GET /mivport/registry` — mivport's kinds and attrs, cached on the boat. */
export interface MivportRegistry {
  kinds: MivportKind[];
  attrs: MivportAttr[];
  fetched_at: number;
}

/** mivport's `set` of an edit: `attrs` is a patch (`null` removes a key). */
export interface MivportSet {
  kind?: string;
  name?: string | null;
  geom?: MivportGeom;
  attrs?: Record<string, unknown>;
}

export type MivportEditOp = "create" | "modify" | "delete" | "restore";

/** `POST /mivport/edits`. A modify of an `osm:…` place becomes a create. */
export interface MivportEditRequest {
  op: MivportEditOp;
  place_id?: string;
  base_rev?: number;
  set?: MivportSet;
}

export interface MivportEditResult {
  place_id: string;
  item_id: string;
}

export interface MivportItemResult {
  item_id: string;
}

export interface MivportPhotoResult {
  item_id: string;
  /** A local id until the photo is uploaded. */
  photo_id: string;
}

/** `PUT /mivport/places/{id}/review`. */
export interface MivportReviewBody {
  stars: number;
  body?: string;
  /** `YYYY-MM-DD`. */
  visited_on?: string;
}

/** What a removal request can be about. */
export type MivportRemovalTarget = "place" | "review" | "photo";

/** `POST /mivport/removal-requests`. */
export interface MivportRemovalRequest {
  target_type: MivportRemovalTarget;
  target_id: string;
  reason: string;
}

export type MivportOutboxState = "pending" | "sending" | "failed" | "done";

/** One queued write (`GET /mivport/outbox`). */
export interface MivportOutboxItem {
  id: string;
  /** What it is: an edit, a review, a photo, a removal request … */
  kind: string;
  place_id?: string | null;
  /** One line for the list. */
  summary: string;
  state: MivportOutboxState;
  /** Epoch seconds (or an ISO time). */
  created_at: number | string;
  error?: string | null;
  /** Fields mivport resolved against a newer change: `won` = ours kept. */
  conflicts?: { field: string; won: boolean }[] | null;
}

export interface MivportOutbox {
  items: MivportOutboxItem[];
}

/** One locally changed place as a map feature (`GET /poi/mivport/local`). */
export interface MivportLocalFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    kind?: string;
    kind_detail?: string;
    name?: string;
    min_zoom?: number;
    src: "mivport";
    ref: string;
    /** The baked set it came from, when it did ("local" otherwise). */
    set?: string;
    local: MivportLocalState;
    deleted?: boolean;
  };
}

/** `GET /poi/mivport/local`: the boat's own changes, and the refs the baked
 * layers must not draw. */
export interface MivportLocalLayer {
  features: MivportLocalFeature[];
  hide: string[];
}

/** One revision of a place (`GET /mivport/places/{id}/history`, mivport's
 * history as-is). */
export interface MivportRevision {
  rev: number;
  status?: string;
  kind?: string;
  name?: string;
  changed?: string[];
  made_at?: string;
  reverts_rev?: number;
  changeset?: { user?: string; client?: string; comment?: string };
}

export interface MivportHistory {
  revisions: MivportRevision[];
}
