// The tile-cache logic behind the Service Worker's tile fetch handler
// (src/sw.ts) — moved off the main thread because the old MapLibre-protocol
// version cost an extra postMessage round trip per tile, measured as a real
// contributor to a reported zoom-time frame drop.
//
// Pure and framework-free: takes a `CacheLike` so it's unit-testable with an
// in-memory double. No manual LRU/byte budget — Cache Storage is disk-backed
// with browser-managed quota/eviction, much higher headroom than the old
// 64MiB RAM budget it replaced.

/** v2 (o-charts licence, plan W2): v1 may hold licensed o-charts tiles from
 * before the server sent `no-store`; the rename makes `sw.ts`'s `activate`
 * sweep (`staleCacheNames`) delete it on every tablet. */
export const TILE_CACHE_NAME = "mivnav-tiles-v2";

/** Shared prefix for every Cache Storage entry this app owns, so `sw.ts`'s
 * `activate` sweep (`staleCacheNames` below) can tell "ours, but stale" apart
 * from workbox's own precache cache, which `cleanupOutdatedCaches()` already
 * manages itself. */
export const CACHE_NAME_PREFIX = "mivnav-";

/** Which of `existingNames` (real Cache Storage keys, from `caches.keys()`)
 * are ours (`CACHE_NAME_PREFIX`-prefixed) but not among `currentNames` — i.e.
 * left over from a previous deploy and safe to delete. Pure so it is
 * unit-testable without a real `CacheStorage`; `sw.ts`'s `activate` handler
 * does only the `caches.keys()`/`caches.delete()` wiring around it. */
export function staleCacheNames(existingNames: readonly string[], currentNames: readonly string[]): string[] {
  return existingNames.filter((name) => name.startsWith(CACHE_NAME_PREFIX) && !currentNames.includes(name));
}

/** A small, synchronous string hash (FNV-1a, 32-bit) — deliberately NOT
 * `crypto.subtle`, which is undefined outside a secure context and the
 * boat's own LAN origin is plain HTTP. Not security-sensitive, just a
 * stable "did the deployed build change" identity for `iconCacheName`. */
export function buildHash(parts: readonly string[]): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV prime
    }
    hash ^= 0x1f; // separator between parts
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** How long a negative (empty) tile response is trusted before it is
 * re-fetched. Long enough that panning over open water does not re-hit the
 * backend for the same `_nodata` gap; short enough that a re-ingested or
 * momentarily-not-ready tile stops being a hole within seconds of the
 * backend's ~5s rescan. */
export const EMPTY_TILE_TTL_MS = 30_000;

/** Marks a cached Response as a synthesized empty tile, carrying its absolute
 * expiry (epoch ms) — read back on the next hit to decide whether it is
 * still trusted or must be treated as a miss (self-heal). */
const EMPTY_EXPIRES_HEADER = "x-mivnav-empty-expires";

/** The sliver of the Cache Storage `Cache` interface this needs — a real
 * `caches.open(...)` result satisfies it directly; tests hand in a plain
 * Map-backed double instead. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

/**
 * Resolve one tile request: a still-fresh cache hit is served straight from
 * the cache; otherwise the tile is fetched, and the backend's bare 404 (an
 * unknown set, an out-of-range tile, or a `_nodata` gap) is turned into a
 * synthesized empty 200 so MapLibre never sees a tile error for ordinary
 * "no data here" coverage. A transient error (503, a dropped link) is passed
 * through UNCACHED so the next request is a real retry. Real tile data is
 * cached durably (no expiry header) — unless its `Cache-Control` says
 * `no-store`: licensed o-charts content, which must never reach the disk
 * (Cache Storage is disk-backed). It is served, just not stored.
 */
export async function resolveTile(
  request: Request,
  cache: CacheLike,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Response> {
  const hit = await cache.match(request);
  if (hit) {
    const expiresAt = hit.headers.get(EMPTY_EXPIRES_HEADER);
    if (expiresAt === null || now() < Number(expiresAt)) return hit;
    await cache.delete(request); // stale empty — self-heal, fall through to a real fetch
  }

  const res = await fetchImpl(request);
  if (res.status === 404 || res.status === 204) {
    const empty = new Response(new ArrayBuffer(0), {
      status: 200,
      headers: { [EMPTY_EXPIRES_HEADER]: String(now() + EMPTY_TILE_TTL_MS) },
    });
    await cache.put(request, empty.clone());
    return empty;
  }
  if (!res.ok) return res; // transient — never cached, so the retry is a real retry
  if (isNoStore(res)) return res;
  await cache.put(request, res.clone());
  return res;
}

/** Does this response forbid being stored (`Cache-Control: no-store`)? */
function isNoStore(res: Response): boolean {
  const cc = res.headers.get("Cache-Control") ?? "";
  return cc.split(",").some((d) => d.trim().toLowerCase() === "no-store");
}

/** Is this request shaped like a chart/POI tile — the route match `sw.ts`
 * uses. A plugin's live POI layer (`/api/poi/live/…`) is excluded (never cached). The weather plugin's routes (`/api/weather/…`) are EXCLUDED, load-bearing not tidiness: a synthesized 0-byte
 * 200 from `resolveTile` isn't a decodable raster PNG and broke the wash.
 * `/api/satellite/tiles/...` carries the same latent hazard, left alone.
 * The o-charts union `/api/tiles/all/…` is excluded too: it is licensed
 * content, `no-store` on the server, and `resolveTile` already refuses to
 * store it — this is belt and braces. (Only that exact route: the OSM/POI
 * `…/osm_world/tiles/all/…` unions are free and stay cached.) See
 * docs/architecture/tile-cache.md. */
export function isTileRequest(url: URL): boolean {
  if (url.pathname.startsWith("/api/weather/")) return false;
  if (url.pathname.startsWith("/api/tiles/all/")) return false;
  // A live POI layer is online-only by design ("no caching"): its tiles must
  // never land in the disk-backed Cache Storage.
  if (url.pathname.startsWith("/api/poi/live/")) return false;
  return /\.(pmtiles|mvt|pbf)$/.test(url.pathname) || url.pathname.includes("/tiles/");
}

// On-demand ATON symbol icons (task qkmvmwps) — `/api/icons/<key>.svg`, see
// core/style/atonIcons.ts. Used to be part of the precached sprite sheet;
// now something has to stop the same handful of symbol keys costing the Pi
// a full chartcore render every redraw. See docs/architecture/tile-cache.md
// for the full reasoning behind revalidate-not-always-fetch.

/** Separate from `TILE_CACHE_NAME`: an icon is derived from chartcore's own
 * code/artwork, not chart data, so `clear-tile-cache` (catalog changes) has
 * no reason to evict it. DERIVED from the build's asset manifest rather than
 * hand-bumped (task oquuwswk). NOT the freshness mechanism — `resolveIcon`'s
 * conditional revalidation is (task uuzlmxzm). See docs/architecture/tile-cache.md. */
export function iconCacheName(buildId: string): string {
  return `mivnav-icons-${buildId}`;
}

/** Is this request one of those on-demand symbol icons? Narrow on purpose:
 * `/api/*` is otherwise NEVER intercepted (see `sw.ts` — real-time nav data
 * must not be served from a cache). An icon is pure derived content with a
 * content-hash ETag, safe to store and revalidate. */
export function isIconRequest(url: URL): boolean {
  return url.pathname.startsWith("/api/icons/");
}

/** Build the conditional form of `request` — same URL, same everything, plus
 * `If-None-Match` from the cached entry's ETag.
 *
 * The header list is COPIED (`new Headers(request.headers)`) rather than
 * passed as a bare object: `new Request(req, { headers })` REPLACES the
 * header list wholesale, so building it from scratch would silently drop
 * whatever the caller sent.
 */
function conditionalRequest(request: Request, etag: string): Request {
  const headers = new Headers(request.headers);
  headers.set("If-None-Match", etag);
  return new Request(request, { headers });
}

/**
 * Resolve one icon request: serve the stored bytes, but only after the
 * backend confirms they're still current — a conditional GET with the cached
 * entry's ETag. Fixes task uuzlmxzm: cache-first with no revalidation made a
 * chartcore-only deploy invisible on the boat forever.
 *
 * 304 serves the cached bytes; 200 overwrites and serves the new ones; 404
 * purges the cache and passes through UNCACHED (not `resolveTile`'s
 * synthesized empty 200 — an icon 404 needs `atonIcons.ts`'s real "no such
 * symbol" answer); 5xx/thrown fetch KEEPS and serves the cached entry, since
 * a Pi mid-restart must not blank symbols already on screen. See
 * docs/architecture/tile-cache.md.
 */
export async function resolveIcon(
  request: Request,
  cache: CacheLike,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const hit = await cache.match(request);
  // A cached NON-ok answer is a legacy artifact (404s haven't been cached
  // since jt nvwptvtv) — a stale answer, never something worth revalidating.
  if (hit && !hit.ok) await cache.delete(request);
  const cached = hit?.ok ? hit : undefined;
  const etag = cached?.headers.get("ETag");

  let res: Response;
  try {
    res = await fetchImpl(etag ? conditionalRequest(request, etag) : request);
  } catch (err) {
    if (cached) return cached;
    throw err;
  }

  if (cached && res.status === 304) return cached;
  if (res.ok) {
    await cache.put(request, res.clone());
    return res;
  }
  if (res.status === 404) {
    if (cached) await cache.delete(request);
    return res;
  }
  return cached ?? res;
}

// Manual "hard reset" (Launcher.tsx's overflow-menu escape hatch) — a blunt
// tool for stale-update symptoms, not a fix for what causes them. Runs on
// the MAIN thread: Cache Storage is a single per-origin store shared by both
// contexts, so clearing it here reaches the exact same entries `sw.ts` would see.

/** The sliver of main-thread browser APIs a hard reset needs, injectable for
 * testing. `caches`/`serviceWorker` are optional: both are secure-context-only
 * APIs and the boat's LAN deployment is plain HTTP, so neither exists
 * there at all. `storage` is not optional — `localStorage.clear()` has no
 * such gate. */
export interface ClientResetDeps {
  caches?: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> };
  serviceWorker?: { getRegistrations(): Promise<readonly { unregister(): Promise<boolean> }[]> };
  storage: Pick<Storage, "clear">;
}

/**
 * Delete EVERY Cache Storage entry (enumerated via `keys()`, so it also
 * catches workbox's own precache), unregister EVERY Service Worker
 * registration, and clear every device setting in localStorage. Reloading is
 * the CALLER's job (Launcher.tsx). Storage is cleared FIRST and
 * unconditionally — the one step with no secure-context gate, so it must not
 * be skipped just because `caches`/`serviceWorker` are unavailable.
 */
export async function clearAllClientState(deps: ClientResetDeps): Promise<void> {
  deps.storage.clear();

  if (deps.caches) {
    const cacheStorage = deps.caches;
    const cacheNames = await cacheStorage.keys();
    await Promise.all(cacheNames.map((name) => cacheStorage.delete(name)));
  }

  if (deps.serviceWorker) {
    const registrations = await deps.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
}
