/**
 * Regression: chart tiles were refetched and re-decoded after every settings
 * change.
 *
 * Measured against the real app in Chromium: a z12→z10→z12→z10 round trip
 * refetched 0 of 12 o-charts tiles, but one Soundings toggle emptied the
 * source's tile cache (12 → 0) and the identical zoom-out then refetched
 * 12 of 12. The cause is MapLibre's own: `Style._updateLayer` schedules a
 * source reload for any layout/filter/data-driven-paint change — i.e. every
 * chart layer on every settings change — and `TileManager.reload()` opens by
 * unloading the whole out-of-view cache. See tileCache.ts / sw.ts.
 *
 * So the invariant under test is the one the fix restores: a tile is fetched
 * over the network at most once, however many times it's requested, until its
 * (data or negative) entry actually expires or is cleared.
 *
 * `resolveTile` is driven directly against a fake `CacheLike` — a real
 * `ServiceWorkerGlobalScope`/Cache Storage isn't available under `bun test`.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  clearAllClientState,
  buildHash,
  EMPTY_TILE_TTL_MS,
  iconCacheName,
  isIconRequest,
  isTileRequest,
  resolveIcon,
  resolveTile,
  staleCacheNames,
  type CacheLike,
} from "./tileCache";

const URL_A = "https://mivnav.example/api/tiles/set/12/2200/1300";

/** A plain Map-backed `CacheLike` double — `match` hands out a `.clone()`,
 * matching real Cache Storage's "always a fresh Response" contract. */
function createFakeCache(): CacheLike {
  const store = new Map<string, Response>();
  return {
    async match(request) {
      return store.get(request.url)?.clone();
    },
    async put(request, response) {
      store.set(request.url, response);
    },
    async delete(request) {
      return store.delete(request.url);
    },
  };
}

/** A fetch double that counts calls and hands back distinct tile bytes. */
function fakeFetch(body: (url: string) => { status: number; bytes?: Uint8Array }) {
  return mock(async (request: Request) => {
    const { status, bytes } = body(request.url);
    return new Response(status === 404 || status === 204 ? null : (bytes ?? new Uint8Array(0)), {
      status,
    });
  });
}

const tile = (byte: number, len = 8) => new Uint8Array(len).fill(byte);
const req = (url: string = URL_A) => new Request(url);

describe("resolveTile", () => {
  test("a second request for the same tile never reaches the network", async () => {
    const fetchMock = fakeFetch(() => ({ status: 200, bytes: tile(7) }));
    const cache = createFakeCache();

    const first = await resolveTile(req(), cache, fetchMock);
    const second = await resolveTile(req(), cache, fetchMock);

    expect(fetchMock.mock.calls.length).toBe(1);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(tile(7));
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(tile(7));
  });

  test("an empty tile is cached too — the _nodata gaps are the common case", async () => {
    const fetchMock = fakeFetch(() => ({ status: 404 }));
    const cache = createFakeCache();

    const first = await resolveTile(req(), cache, fetchMock);
    const second = await resolveTile(req(), cache, fetchMock);

    expect(fetchMock.mock.calls.length).toBe(1);
    expect(first.status).toBe(200); // synthesized — MapLibre never sees the 404
    expect((await first.arrayBuffer()).byteLength).toBe(0);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  test("a defensive 204 is treated the same as a 404", async () => {
    const fetchMock = fakeFetch(() => ({ status: 204 }));
    const cache = createFakeCache();

    const res = await resolveTile(req(), cache, fetchMock);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test("a stale empty self-heals after its TTL — a transient hole is not permanent", async () => {
    // The reported bug: a tile that is momentarily not-ready (or not yet
    // ingested) 404s, the empty is cached URL-keyed with no expiry, and it
    // stays a tile-shaped hole on that device forever — even after the backend
    // re-ingests the tile with data at a new sequence. The TTL must let it heal.
    let hasData = false;
    const fetchMock = fakeFetch(() => (hasData ? { status: 200, bytes: tile(9) } : { status: 404 }));
    let now = 1_000;
    const cache = createFakeCache();

    const first = await resolveTile(req(), cache, fetchMock, () => now);
    expect((await first.arrayBuffer()).byteLength).toBe(0);

    // Within the TTL the empty is trusted — the open-water optimization holds,
    // the backend is not re-hit on every pan.
    const cached = await resolveTile(req(), cache, fetchMock, () => now);
    expect((await cached.arrayBuffer()).byteLength).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(1);

    // The tile is re-ingested with data; once the TTL elapses the stale empty
    // is a miss, the tile is re-fetched, and the hole is gone.
    hasData = true;
    now += EMPTY_TILE_TTL_MS;
    const healed = await resolveTile(req(), cache, fetchMock, () => now);
    expect(new Uint8Array(await healed.arrayBuffer())).toEqual(tile(9));
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test("a data tile stays durable — the TTL is only for empties", async () => {
    const fetchMock = fakeFetch(() => ({ status: 200, bytes: tile(5) }));
    let now = 0;
    const cache = createFakeCache();

    await resolveTile(req(), cache, fetchMock, () => now);
    now += EMPTY_TILE_TTL_MS * 100; // long past any empty's lifetime
    const second = await resolveTile(req(), cache, fetchMock, () => now);

    expect(fetchMock.mock.calls.length).toBe(1); // still served from cache
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(tile(5));
  });

  test("an error is not cached, so the retry is a real retry", async () => {
    let status = 503;
    const fetchMock = fakeFetch(() => ({ status, bytes: tile(1) }));
    const cache = createFakeCache();

    const failed = await resolveTile(req(), cache, fetchMock);
    expect(failed.status).toBe(503);
    expect(failed.ok).toBe(false);

    status = 200;
    const ok = await resolveTile(req(), cache, fetchMock);

    expect(fetchMock.mock.calls.length).toBe(2);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(tile(1));
  });

  test("clearing the cache (a fresh CacheLike, as `clear-tile-cache` does via caches.delete) forces a real refetch", async () => {
    const fetchMock = fakeFetch(() => ({ status: 200, bytes: tile(4) }));
    let cache = createFakeCache();

    await resolveTile(req(), cache, fetchMock);
    cache = createFakeCache(); // stand-in for `caches.delete(TILE_CACHE_NAME)`
    await resolveTile(req(), cache, fetchMock);

    expect(fetchMock.mock.calls.length).toBe(2);
  });
});

describe("isTileRequest", () => {
  test("matches /tiles/ paths and pmtiles/mvt/pbf extensions", () => {
    expect(isTileRequest(new URL("https://x/api/tiles/set/1/2/3"))).toBe(true);
    expect(isTileRequest(new URL("https://x/api/poi/tiles/set/1/2/3"))).toBe(true);
    expect(isTileRequest(new URL("https://x/some/thing.pmtiles"))).toBe(true);
    expect(isTileRequest(new URL("https://x/some/thing.mvt"))).toBe(true);
    expect(isTileRequest(new URL("https://x/glyph.pbf"))).toBe(true);
  });

  test("never matches a live POI layer, which must not be cached (online-only)", () => {
    expect(isTileRequest(new URL("https://x/api/poi/live/some-source/tiles/9/1/2?v=5"))).toBe(false);
  });

  test("does not match ordinary API calls", () => {
    expect(isTileRequest(new URL("https://x/api/catalog"))).toBe(false);
    expect(isTileRequest(new URL("https://x/api/config"))).toBe(false);
  });

  test("never matches weather, whose raster tiles a 0-byte 200 would break", () => {
    // The bare `/tiles/` substring matched these, so the wash went through
    // `resolveTile` and its 404-to-empty-200 synthesis handed MapLibre's image
    // decoder an undecodable 0-byte body — `DOMException: The operation was
    // aborted` out of `_loadTile`, and no wash on the chart. sw.ts's own
    // docstring always said weather is not intercepted; now it is true.
    const wash =
      "https://x/api/weather/tiles/wash/5/16/10.png" +
      "?path=grib%3Awx%2Fdwd_icon_eu%2F2026-07-29T09%3A00Z&variable=wind_u_component_10m&dark=false";
    expect(isTileRequest(new URL(wash))).toBe(false);
    expect(isTileRequest(new URL("https://x/api/weather/tiles/wind/5/16/10.png"))).toBe(false);
    expect(isTileRequest(new URL("https://x/api/weather/data_spatial/dwd/x.om"))).toBe(false);
  });

  test("still matches the chart/POI tiles the cache exists for", () => {
    expect(isTileRequest(new URL("https://x/api/osm_world/tiles/all/5/16/10"))).toBe(true);
    expect(isTileRequest(new URL("https://x/api/poi/tiles/all/5/16/10"))).toBe(true);
    expect(isTileRequest(new URL("https://x/api/satellite/tiles/s2/5/16/10"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// On-demand ATON symbol icons (qkmvmwps). Two invariants, and they pull in
// opposite directions:
//
//  - FRESH: a chartcore-only deploy changes an icon's bytes without touching
//    the frontend bundle, so nothing about the cache NAME can notice. Every
//    request revalidates conditionally against the backend's content-hash
//    ETag (jt uuzlmxzm — before this, the SW served pre-deploy artwork
//    forever).
//  - ROBUST: once a region has been drawn, every symbol it used must still be
//    answerable when the Pi is unreachable — this is what replaced "the
//    sprite sheet is a precached shell asset". So a failed revalidation
//    serves the cached bytes rather than nothing.
// ---------------------------------------------------------------------------

const ICON_URL = "https://mivnav.example/api/icons/BOYSHP/4/1/3,1.svg";

/** A fetch double shaped like `backend/mivnav/api/charts.py`'s icon route:
 * a content-derived strong ETag, and a 304 for a matching `If-None-Match`.
 * `serve` is read per call so a test can redeploy chartcore mid-test. */
function iconServer(serve: () => { bytes: Uint8Array; etag: string }) {
  return mock(async (request: Request) => {
    const { bytes, etag } = serve();
    if (request.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(bytes, { status: 200, headers: { ETag: etag } });
  });
}

describe("resolveIcon", () => {
  test("a 304 means the cached bytes are current — they are served, unfetched", async () => {
    const cache = createFakeCache();
    const server = iconServer(() => ({ bytes: tile(3), etag: '"aaa"' }));

    expect(new Uint8Array(await (await resolveIcon(req(ICON_URL), cache, server)).arrayBuffer())).toEqual(tile(3));
    const second = await resolveIcon(req(ICON_URL), cache, server);

    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(tile(3));
    expect(server.mock.calls.length).toBe(2); // revalidated, not blindly trusted
    expect(server.mock.calls[1]![0].headers.get("If-None-Match")).toBe('"aaa"');
  });

  test("new artwork from a chartcore-only deploy lands on the very next request", async () => {
    // The reported bug (jt uuzlmxzm): cache-first with no revalidation, keyed
    // off the FRONTEND build manifest. A backend-only deploy leaves that key
    // identical, so the pre-deploy SVG was served forever with nothing able to
    // evict it. The ETag is content-derived, so it moves when the bytes do.
    const cache = createFakeCache();
    let artwork = { bytes: tile(3), etag: '"old"' };
    const server = iconServer(() => artwork);
    await resolveIcon(req(ICON_URL), cache, server);

    artwork = { bytes: tile(9), etag: '"new"' };
    const afterDeploy = await resolveIcon(req(ICON_URL), cache, server);
    expect(new Uint8Array(await afterDeploy.arrayBuffer())).toEqual(tile(9));

    // ...and the new bytes replaced the old ones in the cache, rather than
    // the old entry surviving to be revalidated (and 200'd) again.
    const next = await resolveIcon(req(ICON_URL), cache, server);
    expect(new Uint8Array(await next.arrayBuffer())).toEqual(tile(9));
    expect(server.mock.calls[2]![0].headers.get("If-None-Match")).toBe('"new"');
  });

  test("a cached entry with no ETag is refetched unconditionally", async () => {
    // Written by a build from before revalidation landed. A conditional
    // request needs a validator; without one, just ask for the bytes.
    const cache = createFakeCache();
    await cache.put(req(ICON_URL), new Response(tile(3), { status: 200 }));
    const server = iconServer(() => ({ bytes: tile(5), etag: '"e"' }));

    const res = await resolveIcon(req(ICON_URL), cache, server);

    expect(server.mock.calls[0]![0].headers.has("If-None-Match")).toBe(false);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(tile(5));
  });

  test("a visited region's symbols survive the network going away", async () => {
    const cache = createFakeCache();
    const online = iconServer(() => ({ bytes: tile(3), etag: '"a"' }));
    await resolveIcon(req(ICON_URL), cache, online);

    const offline = mock(async () => {
      throw new Error("offline");
    });
    const res = await resolveIcon(req(ICON_URL), cache, offline as unknown as typeof fetch);

    // Revalidation is ATTEMPTED — that is the point — but its failure must
    // not blank out a symbol on a chart the user is already looking at.
    expect(offline.mock.calls.length).toBe(1);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(tile(3));
  });

  test("a 5xx mid-revalidation serves the cached icon and keeps the entry", async () => {
    const cache = createFakeCache();
    const good = iconServer(() => ({ bytes: tile(3), etag: '"a"' }));
    await resolveIcon(req(ICON_URL), cache, good);

    const restarting = fakeFetch(() => ({ status: 503 }));
    expect((await resolveIcon(req(ICON_URL), cache, restarting)).status).toBe(200);
    // The Pi comes back: the entry is still there to revalidate against.
    const back = await resolveIcon(req(ICON_URL), cache, good);
    expect(good.mock.calls[1]![0].headers.get("If-None-Match")).toBe('"a"');
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(tile(3));
  });

  test("a transient failure with nothing cached is NOT cached, so the next request is a real retry", async () => {
    const cache = createFakeCache();
    let status = 503;
    const fetchMock = fakeFetch(() => ({ status, bytes: tile(1) }));
    expect((await resolveIcon(req(ICON_URL), cache, fetchMock)).status).toBe(503);
    status = 200;
    expect((await resolveIcon(req(ICON_URL), cache, fetchMock)).status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test("a 404 is NOT cached — a stale negative must not outlive a deploy (jt nvwptvtv)", async () => {
    // Regression: a 404 cached during an earlier iteration of the icon
    // pipeline used to be trusted forever, since ICON_CACHE_NAME never bumps
    // and nothing purges it. `atonIcons.ts`'s own in-memory `unavailable` Set
    // already dedupes repeat requests for a genuinely-missing key within a
    // page session, so the SW cache does not need to remember a 404 too.
    const cache = createFakeCache();
    const fetchMock = fakeFetch(() => ({ status: 404 }));
    expect((await resolveIcon(req(ICON_URL), cache, fetchMock)).status).toBe(404);
    expect((await resolveIcon(req(ICON_URL), cache, fetchMock)).status).toBe(404);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test("a key whose artwork was REMOVED purges the cached entry and 404s", async () => {
    // Unlike a 5xx, a 404 is a definite answer: chartcore no longer draws this
    // key. Holding on to the old SVG would put artwork on the chart that the
    // backend has retired.
    const cache = createFakeCache();
    const server = iconServer(() => ({ bytes: tile(3), etag: '"a"' }));
    await resolveIcon(req(ICON_URL), cache, server);

    const gone = fakeFetch(() => ({ status: 404 }));
    expect((await resolveIcon(req(ICON_URL), cache, gone)).status).toBe(404);
    expect(await cache.match(req(ICON_URL))).toBeUndefined();
  });

  test("a legacy cached 404 self-heals on the very next request", async () => {
    // Simulates the reported bug's actual state: an old build cached a 404
    // under the (never-bumped) ICON_CACHE_NAME before this fix shipped. The
    // fixed resolveIcon must not trust it — purge and re-fetch.
    const cache = createFakeCache();
    await cache.put(req(ICON_URL), new Response(null, { status: 404 }));
    const fetchMock = fakeFetch(() => ({ status: 200, bytes: tile(6) }));

    const res = await resolveIcon(req(ICON_URL), cache, fetchMock);

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(tile(6));
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});

describe("isIconRequest", () => {
  test("matches only the icon endpoint, never the real-time API", () => {
    expect(isIconRequest(new URL(ICON_URL))).toBe(true);
    expect(isIconRequest(new URL("https://x/api/icons/pilpnt.svg"))).toBe(true);
    // The rule sw.ts guards: every other /api/* path stays uncached.
    expect(isIconRequest(new URL("https://x/api/catalog"))).toBe(false);
    expect(isIconRequest(new URL("https://x/api/config"))).toBe(false);
    expect(isIconRequest(new URL("https://x/api/routes"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearAllClientState (jt zyrrxnno) — Launcher.tsx's manual "hard reset"
// escape hatch. Real `caches`/`navigator.serviceWorker` aren't available
// under `bun test` (see the file header), so this drives the function
// against plain fakes, injected via `ClientResetDeps` exactly like
// `resolveTile`/`resolveIcon` take a `CacheLike` above.
// ---------------------------------------------------------------------------

describe("clearAllClientState", () => {
  test("deletes every Cache Storage entry, not just the tile/icon ones sw.ts names", async () => {
    // Standing in for the full real set: TILE_CACHE_NAME, ICON_CACHE_NAME,
    // AND workbox's own precache — `caches.keys()` finds all three without
    // this function having to hardcode any of their names.
    const names = ["mivnav-tiles-v1", "mivnav-icons-v1", "workbox-precache-v2-https://x/"];
    const deleted: string[] = [];
    const caches = {
      keys: async () => names,
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    };

    await clearAllClientState({ caches, storage: { clear: () => {} } });

    expect(deleted.sort()).toEqual([...names].sort());
  });

  test("unregisters every Service Worker registration", async () => {
    const unregistered: string[] = [];
    const registrations = ["a", "b"].map((id) => ({
      unregister: async () => {
        unregistered.push(id);
        return true;
      },
    }));
    const serviceWorker = { getRegistrations: async () => registrations };

    await clearAllClientState({ serviceWorker, storage: { clear: () => {} } });

    expect(unregistered.sort()).toEqual(["a", "b"]);
  });

  test("clears the injected storage", async () => {
    const clear = mock(() => {});
    await clearAllClientState({ storage: { clear } });
    expect(clear.mock.calls.length).toBe(1);
  });

  test("clears storage even when neither caches nor serviceWorker is available (the boat's plain-HTTP deployment has neither)", async () => {
    const clear = mock(() => {});
    await expect(clearAllClientState({ storage: { clear } })).resolves.toBeUndefined();
    expect(clear.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cache-name derivation and eviction (jt oquuwswk). Investigating whether the
// Service Worker was the right tool surfaced a real, separate bug alongside
// nvwptvtv's "don't cache 404s" fix: ICON_CACHE_NAME was a hand-bumped
// version string that never actually got bumped, and even if it had, nothing
// deleted the orphaned old-named cache. `buildHash`/`iconCacheName` fix the
// first half (the name now changes on its own, every deploy); `staleCacheNames`
// fixes the second (sw.ts's `activate` handler uses it to delete what the
// name change orphans).
// ---------------------------------------------------------------------------

describe("buildHash", () => {
  test("is deterministic", () => {
    expect(buildHash(["a.js:abc", "b.css:def"])).toBe(buildHash(["a.js:abc", "b.css:def"]));
  });

  test("changes when any manifest entry changes — the whole point: every deploy gets a new icon cache", () => {
    const before = buildHash(["a.js:abc", "b.css:def"]);
    const afterContentChange = buildHash(["a.js:abc", "b.css:XYZ"]);
    const afterEntryAdded = buildHash(["a.js:abc", "b.css:def", "c.js:ghi"]);
    expect(afterContentChange).not.toBe(before);
    expect(afterEntryAdded).not.toBe(before);
  });

  test("does not collide across a naive join of differently-split parts", () => {
    // Guards the separator: without one, ["ab", "c"] and ["a", "bc"] would
    // hash identically under plain concatenation.
    expect(buildHash(["ab", "c"])).not.toBe(buildHash(["a", "bc"]));
  });
});

describe("iconCacheName", () => {
  test("is namespaced under the shared mivnav- prefix `staleCacheNames` sweeps", () => {
    expect(iconCacheName("deadbeef")).toBe("mivnav-icons-deadbeef");
  });
});

describe("staleCacheNames", () => {
  test("the exact bug this fixes: a previous deploy's icon cache, now unreferenced, is flagged for deletion", () => {
    const existing = ["mivnav-tiles-v1", "mivnav-icons-oldbuild", "mivnav-icons-newbuild"];
    const current = ["mivnav-tiles-v1", "mivnav-icons-newbuild"];
    expect(staleCacheNames(existing, current)).toEqual(["mivnav-icons-oldbuild"]);
  });

  test("never touches a cache outside the mivnav- prefix — workbox's own precache cache must survive", () => {
    const existing = ["workbox-precache-v2-https://mivnav.example/", "mivnav-icons-oldbuild"];
    const current = ["mivnav-icons-newbuild"];
    expect(staleCacheNames(existing, current)).toEqual(["mivnav-icons-oldbuild"]);
  });

  test("nothing to delete once every existing name is current", () => {
    const names = ["mivnav-tiles-v1", "mivnav-icons-newbuild"];
    expect(staleCacheNames(names, names)).toEqual([]);
  });
});
