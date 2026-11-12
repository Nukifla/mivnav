// GET /api/search — one query surface across baked ingest sources (POI,
// osm_world place names, ...) PLUS live AIS targets merged in from SignalK.
// Rows are distinguished by source/category; see backend/mivnav/api/search.py.

/** One row from the shared index. `category`/`title`/`text`/`lat`/`lon` are
 * nullable — not every source has all of them (a nav warning may carry no
 * point, only an area). See backend/mivnav/search/index.py. */
export interface SearchResult {
  id: string;
  source: string;
  region: string;
  category: string | null;
  title: string | null;
  text: string | null;
  lat: number | null;
  lon: number | null;
  data: Record<string, unknown>;
  updated_at: number;
}

const SEARCH_URL = "/api/search";
const RESULT_LIMIT = 20;

/** Query the shared index; empty query short-circuits to no results. `near`,
 * if given, sorts nearest-first server-side before truncating to `limit` —
 * a client-side re-sort of the already-truncated page can't do this. */
export async function search(
  query: string,
  signal?: AbortSignal,
  near?: { lng: number; lat: number },
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const params: Record<string, string> = { q, limit: String(RESULT_LIMIT) };
  if (near) {
    params.lat = String(near.lat);
    params.lon = String(near.lng);
  }
  const url = `${SEARCH_URL}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
  const body = (await res.json()) as { results: SearchResult[] };
  return body.results;
}

/** How close a charted record must be to a picked point to name it — beyond
 * this, "nearest" is more misleading than useful (a mid-channel tap 4nm from
 * a harbour should read as its coordinates, not borrow the harbour's name). */
const NEAREST_PLACE_MAX_M = 1500;
/** The bbox half-width (degrees) around a picked point: wide enough that a
 * harbour/marina's own labelled point is still inside it, tight enough that
 * the backend's candidate cap (`_NEAR_CANDIDATE_MAX` = 200, `search.py`)
 * can't fill up with far-away rows before the real nearest one is sorted in. */
const NEAREST_PLACE_BBOX_DEG = 0.03;

/** Planar approximation, degrees→metres, scaled by latitude — exact enough
 * for a "is this close enough to name" threshold check; not a navigation
 * distance (`chrome/geo.ts`'s `rangeNm` is that, and `core/search` doesn't
 * depend on `core/chrome`). */
function approxDistanceM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * Math.cos(lat0);
  const dy = b.lat - a.lat;
  return Math.hypot(dx, dy) * 111_320;
}

/**
 * "What's charted here?" for a bare map tap — a real reverse-geocode built
 * from the SAME shared index `search()` queries, not a separate lookup: an
 * empty query (`SearchIndex.search`'s own doc — a falsy `query` skips the
 * FTS filter entirely) inside a small bbox around the point, sorted
 * nearest-first, returns whatever POI is actually charted near where a
 * mariner tapped. `null` when nothing is close enough to honestly name, or
 * the request fails — the caller's own coordinate-label fallback covers
 * both, so this never blocks or throws into map-tap latency.
 */
export async function nearestPlace(
  point: { lng: number; lat: number },
  // Same narrow shape `core/routing.ts`'s `PlanFetch` uses (not `typeof
  // fetch` — its extra overloads make a plain `(url, init) => Promise<Response>`
  // test double, or `routing.ts`'s own `fetchImpl`, fail to typecheck against it).
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<{ title: string; distanceM: number } | null> {
  const pad = NEAREST_PLACE_BBOX_DEG;
  const params = new URLSearchParams({
    bbox: `${point.lng - pad},${point.lat - pad},${point.lng + pad},${point.lat + pad}`,
    lat: String(point.lat),
    lon: String(point.lng),
    limit: "1",
  });
  try {
    const res = await fetchImpl(`${SEARCH_URL}?${params}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { results: SearchResult[] };
    const r = body.results[0];
    if (!r || r.lat == null || r.lon == null || !r.title) return null;
    const distanceM = approxDistanceM(point, { lng: r.lon, lat: r.lat });
    return distanceM <= NEAREST_PLACE_MAX_M ? { title: r.title, distanceM } : null;
  } catch {
    return null;
  }
}
