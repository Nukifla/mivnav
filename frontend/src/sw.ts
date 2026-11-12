// The app's Service Worker (vite-plugin-pwa `injectManifest` — vite.config.ts).
// Precaches the shell, owns the tile fetch, caches ATON icons; `/api/*` stays
// unintercepted. See docs/architecture/service-worker.md.

/// <reference lib="webworker" />

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";
import {
  buildHash,
  iconCacheName,
  isIconRequest,
  isTileRequest,
  resolveIcon,
  resolveTile,
  staleCacheNames,
  TILE_CACHE_NAME,
} from "./core/tileCache";

// `self.__WB_MANIFEST` is ambient-typed by workbox-precaching's own global
// augmentation; no local override needed.
declare const self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();

// `workbox-build`'s `injectManifest` step text-substitutes the asset list in
// at this EXACT call site and requires `self.__WB_MANIFEST` appear exactly
// once in the source (a second reference makes `bun run build` fail).
const manifest = self.__WB_MANIFEST;
precacheAndRoute(manifest);
cleanupOutdatedCaches();

// Derived from THIS build's own asset manifest rather than a hand-maintained
// version string (jt nvwptvtv: a hand-bumped "v1" never actually got bumped).
// Changes every deploy; `activate` below deletes the previous deploy's cache.
const ICON_CACHE_NAME = iconCacheName(
  buildHash(manifest.map((e) => (typeof e === "string" ? e : `${e.url}:${e.revision}`))),
);

// TILE_CACHE_NAME never changes on a deploy (tile bytes track the BACKEND;
// see chartProtocol.ts's `chartEpoch`), so the only stale entry swept here
// is a previous deploy's icon cache.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(staleCacheNames(names, [TILE_CACHE_NAME, ICON_CACHE_NAME]).map((n) => caches.delete(n)))),
  );
});

// Tile route: chart/POI tile URLs. A network failure must not surface as a
// Service-Worker-flavoured rejection — see docs/architecture/service-worker.md.
registerRoute(
  ({ url, request }) => request.method === "GET" && isTileRequest(url),
  async ({ request }) => {
    try {
      return await resolveTile(request, await caches.open(TILE_CACHE_NAME));
    } catch {
      return fetch(request);
    }
  },
);

// Icon route: `/api/icons/<key>.svg` — on-demand ATON symbols (jt qkmvmwps).
// Second deliberate exception to "never intercept `/api/*`" — see
// docs/architecture/service-worker.md for why this one is safe.
registerRoute(
  ({ url, request }) => request.method === "GET" && isIconRequest(url),
  async ({ request }) => {
    try {
      return await resolveIcon(request, await caches.open(ICON_CACHE_NAME));
    } catch {
      return fetch(request);
    }
  },
);

// Every OTHER request — NOT REGISTERED, on purpose: a stale read of
// real-time data is a safety hazard on the water. See
// docs/architecture/service-worker.md.

// Offline navigations fall back to the SPA shell, except /api/* (data, not
// a page).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api\//] }),
);

// `chartProtocol.ts` posts this after a catalog/config change — belt and
// braces alongside the URL-busting `chartEpoch` param, since a URL-keyed
// cache can't see a change that keeps the same URL.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "clear-tile-cache") {
    event.waitUntil(caches.delete(TILE_CACHE_NAME));
  }
});
