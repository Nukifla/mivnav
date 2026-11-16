// Wire types of the backend's mivport detail route
// (`GET /api/poi/mivport/details/{set}/{ref}`). Hand-mirrored: the host's
// generated `api.generated.ts` describes the core API only. Absent fields are
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
}
